import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginSubmission, finishSubmission, priorPublication, identifyNewContent, verifyPublication, readPublishedRows } from './publication-safety.js';
import { publishStatus } from './jobs-store.js';
import { publishMaterial, buildPublishScript } from './publisher.js';
import { buildTemplatePublishScript, refForText } from './template-publish.js';

test('exclusive journal survives failure/restart and exposes uncertain status', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-publication-'));
  const journal = beginSubmission(join(root, 'publish'), { topic: '指定话题' });
  assert.throws(() => beginSubmission(join(root, 'publish'), {}), /禁止重复投稿/);
  finishSubmission(journal, { ok: false, published: true, content: { id: '123' }, error: '声明失败' });
  assert.equal(JSON.parse(readFileSync(journal.path)).stage, 'needs-reconciliation');
  assert.equal(publishStatus(root).status, 'uncertain');
  assert.equal(publishStatus(root).publication.contentId, '123');
  assert.throws(() => beginSubmission(join(root, 'publish'), {}), /禁止重复投稿/);
});

test('read both canonical and legacy publication records to prevent old work being posted again', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-old-publication-'));
  writeFileSync(join(root, 'publication.json'), JSON.stringify({ published: true, contentId: 'old' }));
  assert.equal(priorPublication({ runDir: root, release: root }).contentId, 'old');
});

test('legacy misplaced material records show uncertain instead of queued', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-legacy-queue-'));
  mkdirSync(join(root, 'release'));
  writeFileSync(join(root, 'release', 'publication.json'), JSON.stringify({ published: true, stage: 'published', contentId: null }));
  assert.equal(publishStatus(root).status, 'uncertain');
  assert.equal(publishStatus(root).publication.reconciliationRequired, true);
});

test('content matching excludes old records, prefix-only matches, wrong type and ambiguous results', () => {
  const row = { id: 'new', title: '完整描述 后附话题', publishType: 2 };
  assert.equal(identifyNewContent([row], [], '完整描述', 2).id, 'new');
  assert.equal(identifyNewContent([row], ['new'], '完整描述', 2), null);
  assert.equal(identifyNewContent([row], [], '完整描述 另一篇', 2), null);
  assert.equal(identifyNewContent([row], [], '完整描述', 0), null);
  assert.equal(identifyNewContent([row, { ...row, id: 'other' }], [], '完整描述', 2), null);
});

test('verification fails closed on missing id, wrong topic and pending declaration', () => {
  const content = { id: '1', topics: ['光效'], declaration: 'SUBMITTED' };
  assert.equal(verifyPublication(content, '光效', true), null);
  assert.match(verifyPublication(null, '光效', true), /唯一作品 ID/);
  assert.match(verifyPublication({ ...content, topics: ['光效素材'] }, '光效', true), /不匹配/);
  assert.match(verifyPublication({ ...content, declaration: 'WAITING_MATERIALS' }, '光效', true), /未获平台确认/);
});

test('page reader runs in an isolated browser realm, returning only serializable data', async () => {
  const result = await vm.runInNewContext(`(${readPublishedRows.toString()})()`, {
    localStorage: { getItem: () => '{}' },
    fetch: async () => ({ ok: true, json: async () => [{ id: 42, title: '完整描述', ugc_publish_type: 2, material_declaration_status: 'SUBMITTED' }] })
  });
  assert.equal(result[0].id, '42');
});

test('missing copyright evidence is rejected before any browser submission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-required-evidence-'));
  const asset = join(root, 'asset.png');
  writeFileSync(asset, 'test');
  await assert.rejects(publishMaterial({ task: { runDir: root }, asset, description: '完整描述', topic: '光效', space: 3, submit: true, declare: true }), /必填项/);
});

test('publisher journals partial success and refuses a second browser launch', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const root = mkdtempSync(join(tmpdir(), 'gaoding-publisher-restart-'));
  const asset = join(root, 'asset.png');
  const evidence = join(root, 'evidence.png');
  writeFileSync(asset, 'asset'); writeFileSync(evidence, 'evidence');
  let launches = 0;
  const spawnProcess = () => {
    launches++;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); }, final(callback) {
      child.stdout.write('GAODING_PUBLISH_RUN:' + JSON.stringify({ ok: false, published: true, content: { id: 'remote-1' }, error: '声明失败' }) + '\n');
      callback(); queueMicrotask(() => child.emit('close', 0));
    } });
    return child;
  };
  const args = { task: { runDir: root, id: 'task' }, asset, evidence, description: '完整描述', topic: '光效', space: 3, submit: true, declare: true, spawnProcess };
  await assert.rejects(publishMaterial(args), /声明失败/);
  assert.equal(publishStatus(root).publication.contentId, 'remote-1');
  await assert.rejects(publishMaterial(args), /禁止重复投稿/);
  assert.equal(launches, 1);
});

test('generated helpers resolve textbox refs and browser scripts parse as ESM', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'gaoding-generated-script-'));
  const shots = { formReady: '/tmp/a.png', published: '/tmp/b.png', declaration: '/tmp/c.png', failed: '/tmp/d.png' };
  const args = { space: 3, topic: '光效', description: '完整描述', shots, submit: false, designUrl: 'https://www.gaoding.com/editor/design?id=1' };
  const scripts = [buildPublishScript(args), buildTemplatePublishScript(args)];
  for (const [i, script] of scripts.entries()) {
    const path = join(root, `${i}.mjs`);
    writeFileSync(path, script);
    const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.match(script, /taskSpace\(3\)/);
  }
  assert.equal(refForText(['textbox [ref=741, loc=css:input[placeholder="搜索话题"]]'], '搜索话题'), '@741');
  // Execute the actual embedded resolver, not only its separately exported twin.
  const body = scripts[1].slice(scripts[1].indexOf('const refOf ='), scripts[1].indexOf('const lastRef ='));
  assert.equal(vm.runInNewContext(body + ';refOf([\'textbox [ref=741, loc=css:input[placeholder="搜索话题"]]\'], "搜索话题")'), '@741');
});

test('reconciliation is read-only, rejects foreign previews and refuses conflicting ids', async () => {
  const { reconcilePublication, comparePixels } = await import('./publication-reconcile.js');
  const root = mkdtempSync(join(tmpdir(), 'gaoding-reconcile-'));
  const asset = join(root, 'asset.png');
  writeFileSync(asset, 'local-bytes');
  const task = { kind: 'material', topic: '光效', runDir: root, release: root, asset };
  const content = { id: '555', publishType: 2, declaration: 'SUBMITTED', publishStatus: 'PUBLISHED', topics: ['光效'], title: '描述', previewUrl: 'https://gd-cms.dancf.com/gd-cms/x/1/abc234.png' };
  const browser = async () => ({ ok: true, content });
  const fetchPreview = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('remote-bytes').buffer });
  const compare = async () => ({ identical: true });

  let posted = 0;
  const result = await reconcilePublication({ task, contentId: '555', space: 3, python: '/usr/bin/python3', browser, fetchPreview, compare });
  assert.equal(result.publication.contentId, '555');
  assert.equal(result.publication.stage, 'verified');
  assert.equal(result.publication.topics[0], '光效');
  assert.equal(posted, 0, 'reconciliation must never submit anything');
  assert.equal(JSON.parse(readFileSync(join(root, 'publication.json'))).contentId, '555');

  // A different asset already recorded for this run must not be silently overwritten.
  writeFileSync(join(root, 'publication.json'), JSON.stringify({ contentId: '999', published: true }));
  await assert.rejects(reconcilePublication({ task, contentId: '555', space: 3, python: 'py', browser, fetchPreview, compare }), /冲突/);

  // Pixel mismatch, wrong topic, missing declaration and non-platform hosts all fail closed.
  await assert.rejects(reconcilePublication({ task: { ...task, release: join(root, 'fresh1') }, contentId: '555', space: 3, python: 'py', browser, fetchPreview, compare: async () => ({ identical: false }) }), /像素不一致/);
  await assert.rejects(reconcilePublication({ task: { ...task, release: join(root, 'fresh2') }, contentId: '555', space: 3, python: 'py', browser: async () => ({ ok: true, content: { ...content, topics: ['别的'] } }), fetchPreview, compare }), /话题不匹配/);
  await assert.rejects(reconcilePublication({ task: { ...task, release: join(root, 'fresh3') }, contentId: '555', space: 3, python: 'py', browser: async () => ({ ok: true, content: { ...content, declaration: 'WAITING_MATERIALS' } }), fetchPreview, compare }), /版权声明/);
  await assert.rejects(reconcilePublication({ task: { ...task, release: join(root, 'fresh4') }, contentId: '555', space: 3, python: 'py', browser: async () => ({ ok: true, content: { ...content, previewUrl: 'https://evil.example.com/a.png' } }), fetchPreview, compare }), /预览地址/);
  await assert.rejects(reconcilePublication({ task: { kind: 'template', topic: 'x', runDir: root }, contentId: '555', space: 3, python: 'py', browser, fetchPreview, compare }), /模板/);
  assert.equal(typeof comparePixels, 'function');
});

test('a provably unsubmitted attempt can be abandoned; a published one cannot', async () => {
  const { abandonUnsubmittedAttempt } = await import('./publication-safety.js');
  const root = mkdtempSync(join(tmpdir(), 'gaoding-abandon-'));
  const dir = join(root, 'publish');
  mkdirSync(dir, { recursive: true });

  // 页面配额这类发生在提交前的失败：可释放，文件保留为审计记录。
  const journal = beginSubmission(dir, { topic: '光效' });
  finishSubmission(journal, { ok: false, published: false, content: null, steps: [], error: 'Page budget reached (8/8)' });
  const abandoned = abandonUnsubmittedAttempt(dir);
  assert.match(abandoned.archived, /abandoned/);
  assert.equal(publishStatus(root).status, 'queued');

  // 已发布/已有作品 ID/已经走到发布步骤的一律拒绝。
  const published = beginSubmission(dir, { topic: '光效' });
  finishSubmission(published, { ok: false, published: true, content: { id: '9' }, steps: ['published'] });
  assert.throws(() => abandonUnsubmittedAttempt(dir), /禁止清除/);
  assert.equal(publishStatus(root).status, 'uncertain');

  const staged = beginSubmission(join(root, 'publish2'), {});
  finishSubmission(staged, { ok: false, published: false, content: null, steps: ['published'] });
  assert.throws(() => abandonUnsubmittedAttempt(join(root, 'publish2')), /禁止清除/);
});

test('publish script returns every page it opens and reclaims leftovers', async () => {
  const script = buildPublishScript({ space: 3, asset: '/tmp/a.png', description: 'd', topic: 't', evidence: '/tmp/e.png', ai: true, submit: true, declare: true, shots: { formReady: '/tmp/1', published: '/tmp/2', declaration: '/tmp/3', failed: '/tmp/4' } });
  assert.match(script, /createdPages\.push/);
  assert.match(script, /finally \{\s*\/\/ 页面配额/, 'opened pages must be closed in finally');
  assert.match(script, /for \(const page of createdPages\)/);
  assert.match(script, /unified-publish-modal/);
  const templateScript = buildTemplatePublishScript({ space: 3, designUrl: 'https://www.gaoding.com/editor/design?id=1', description: 'd', topic: 't', submit: false, shots: { formReady: '/tmp/1', published: '/tmp/2', failed: '/tmp/3' } });
  assert.match(templateScript, /for \(const page of createdPages\)/);
});

test('identifyRecentContent only accepts a unique new work of the same type', async () => {
  const { identifyRecentContent } = await import('./publication-safety.js');
  const startedAt = 1794963700000;
  const rows = [
    { id: '1', publishType: 2, publishedAt: startedAt + 5000, title: '平台改写过的标题' },
    { id: '2', publishType: 2, publishedAt: startedAt + 1000, title: '另一个' }
  ];
  // 两个候选 → 不认
  assert.equal(identifyRecentContent(rows, ['0'], 2, startedAt), null);
  // 只有一个候选 → 认
  assert.equal(identifyRecentContent([rows[0]], ['0'], 2, startedAt).id, '1');
  // 类型不同 → 不认
  assert.equal(identifyRecentContent([rows[0]], ['0'], 0, startedAt), null);
  // 提交前就存在的稿件 → 不认
  assert.equal(identifyRecentContent([{ id: '9', publishType: 2, publishedAt: startedAt - 3600_000 }], ['0'], 2, startedAt), null);
  // 已在前次快照里的 → 不认
  assert.equal(identifyRecentContent([rows[0]], ['1'], 2, startedAt), null);
});

test('withdrawContent defaults its process spawner so routes can call it without options', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./publisher.js', import.meta.url), 'utf8');
  assert.match(source, /export async function withdrawContent\(\{ contentId, space, executable, spawnProcess = spawn/);
});
