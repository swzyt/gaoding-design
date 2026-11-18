import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { summarize, listPublished } from './published.js';

test('summary aggregates status, kind, topic and totals', () => {
  // 审核状态由 cqcStatus / publishStatus 决定（与平台列表一致）
  const rows = [
    { cqcStatus: 0, crcStatus: 2, publishType: 0, clicks: 20, downloads: 17, editorUses: 3, topics: [{ name: '小红书大字封面', kind: 'template' }] },
    { cqcStatus: 1, crcStatus: 2, publishStatus: 'PUBLISHED', publishType: 2, clicks: 5, downloads: 1, editorUses: 0, topics: [{ name: '特效系列光效素材', kind: 'material' }] },
    { cqcStatus: 2, crcStatus: 2, publishStatus: 'QUALITY_REJECTED', publishType: 0, clicks: 0, downloads: 0, editorUses: 0, topics: [] }
  ];
  const summary = summarize(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.clicks, 25);
  assert.equal(summary.downloads, 18);
  assert.equal(summary.editorUses, 3);
  assert.equal(summary.byStatus['审核中'], 1);
  assert.equal(summary.byStatus['已通过'], 1);
  assert.equal(summary.byStatus['审核不通过'], 1);
  assert.equal(summary.byKind.template, 2);
  assert.equal(summary.byKind.material, 1);
  assert.equal(summary.topics['小红书大字封面'], 1);
});

function fakeSpawn(payload) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', 'GAODING_PUBLISHED:' + JSON.stringify(payload) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
}

test('published rows come from the browser bridge and are cached', async () => {
  let calls = 0;
  const spawnProcess = (binary, args) => { calls++; return fakeSpawn({ fetchedAt: '2026-11-17T12:00:00.000Z', count: 1, rows: [{ id: '1', title: '作品', publishType: 0, auditStatus: 2 }] })(binary, args); };
  const first = await listPublished({ space: 3, spawnProcess, force: true });
  assert.equal(first.rows.length, 1);
  const second = await listPublished({ space: 3, spawnProcess });
  assert.equal(second.rows[0].title, '作品');
  assert.equal(calls, 1, 'a second read reuses the short-lived cache');
});

test('a missing login surfaces as an error instead of empty data', async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => { child.stderr.emit('data', 'Error: 当前浏览器没有稿定登录态\n'); child.emit('close', 1); });
    return child;
  };
  await assert.rejects(() => listPublished({ space: 3, spawnProcess, force: true }), /登录态|读取发布管理失败/);
});

test('audit state follows the live platform fields, not audit_status alone', async () => {
  const { auditState } = await import('./published.js');
  // 审核中：cqc=0
  assert.equal(auditState({ publishType: 0, cqcStatus: 0, crcStatus: 2, publishStatus: null }).text, '审核中');
  // 已通过：cqc=1 + PUBLISHED（audit_status 同样是 1，所以旧代码会误判）
  assert.equal(auditState({ publishType: 0, cqcStatus: 1, crcStatus: 2, publishStatus: 'PUBLISHED' }).text, '已通过');
  // 审核不通过：QUALITY_REJECTED / cqc=2
  assert.equal(auditState({ publishType: 2, cqcStatus: 2, crcStatus: 2, publishStatus: 'QUALITY_REJECTED' }).text, '审核不通过');
  // 素材待声明优先
  assert.equal(auditState({ publishType: 2, cqcStatus: 1, crcStatus: 2, publishStatus: 'PUBLISHED', declarationStatus: 'WAITING_MATERIALS' }).text, '待声明');
  // crc=2 是正常值，不能被当成拒绝
  assert.notEqual(auditState({ publishType: 0, cqcStatus: 1, crcStatus: 2, publishStatus: 'PUBLISHED' }).text, '审核不通过');
});

test('transient WAITING_MATERIALS on the content is still 待声明', async () => {
  const { auditState } = await import('./published.js');
  assert.equal(auditState({ publishType: 2, cqcStatus: 1, publishStatus: 'WAITING_MATERIALS', declarationStatus: null }).text, '待声明');
  // 声明传播完成后是已通过
  assert.equal(auditState({ publishType: 2, cqcStatus: 1, publishStatus: 'PUBLISHED', declarationStatus: 'SUBMITTED' }).text, '已通过');
});

test('pagination metadata is returned so the panel can load every page', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./published.js', import.meta.url), 'utf8');
  // 桥接脚本必须按页拉取并在不满一页时停止
  assert.match(source, /const pageSize = PAGE_SIZE;/);
  assert.match(source, /page < \(ALL_PAGES \? maxPages \+ 1 : PAGE_NO \+ 1\)/);
  assert.match(source, /rows\.length < pageSize\) break;/);
  assert.match(source, /hasMore: !ALL_PAGES && pages\.length > 0/);
  // 版本信息按 50 一批查，翻页也不会请求过大
  assert.match(source, /i \+= 50/);
});
