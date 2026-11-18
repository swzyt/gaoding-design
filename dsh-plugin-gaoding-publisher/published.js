/**
 * 已投稿作品：通过已登录浏览器读取稿定发布管理接口。
 * 只读；令牌只留在页面上下文里，不写入磁盘。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const marker = 'GAODING_PUBLISHED:';
const cache = new Map();
const cacheTtl = 60 * 1000;

export function egoBinary(executable) {
  if (executable) return executable;
  if (process.env.EGO_BROWSER_BIN) return process.env.EGO_BROWSER_BIN;
  const local = join(homedir(), '.local/bin/ego-browser');
  return existsSync(local) ? local : 'ego-browser';
}

function runNode(script, { executable, spawnProcess = spawn, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('读取发布管理超时')); }, timeout);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.on('error', error => finish(error));
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 4e6) child.kill(); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 4e6) child.kill(); });
    child.on('close', code => {
      if (code !== 0) return finish(Error('读取发布管理失败：' + (stderr.trim().slice(-400) || 'exit ' + code)));
      const line = (stdout + '\n' + stderr).split('\n').find(row => row.startsWith(marker));
      if (!line) return finish(Error('浏览器没有返回发布数据'));
      try { finish(null, JSON.parse(line.slice(marker.length))); } catch (error) { finish(error); }
    });
    child.stdin.end(script);
  });
}

const pageScript = (pageSize, pageNo, allPages) => `
const PAGE_SIZE = ${pageSize};
const PAGE_NO = ${pageNo};
const ALL_PAGES = ${allPages ? 'true' : 'false'};
const list = async (token, page, size) => {
  const r = await fetch('/api/gaoding-art/v1/users/me/contents?page_num=' + page + '&page_size=' + size + '&query_scene=my_publish&type=0%2C2', { headers: { accept: 'application/json', authorization: 'Bearer ' + token } });
  if (!r.ok) throw Error('发布列表 HTTP ' + r.status);
  return r.json();
};
const versions = async (token, ids) => {
  const r = await fetch('/api/gaoding-art/v1/contents/versions/latest', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ content_ids: ids })
  });
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : [];
};
const token = (() => { try { return JSON.parse(localStorage.getItem('token') || '{}'); } catch { return {}; } })();
const bearer = token.access_token || token.token;
if (!bearer) throw Error('当前浏览器没有稿定登录态');
const pageSize = PAGE_SIZE;
const maxPages = ALL_PAGES ? Math.min(50, Math.ceil(2000 / pageSize)) : 1;
const pages = [];
for (let page = ALL_PAGES ? 1 : PAGE_NO; page < (ALL_PAGES ? maxPages + 1 : PAGE_NO + 1); page++) {
  const chunk = await list(bearer, page, pageSize);
  const rows = Array.isArray(chunk) ? chunk : (chunk?.data ?? chunk?.list ?? []);
  pages.push({ page, count: rows.length, rows });
  // 不满一页说明到底了
  if (rows.length < pageSize) break;
}
const rows = pages.flatMap(entry => entry.rows);
const ids = rows.map(row => String(row.id));
// 话题版本信息按 50 个一批查，避免一次请求过大
const versionRows = [];
for (let i = 0; i < ids.length; i += 50) versionRows.push(...await versions(bearer, ids.slice(i, i + 50)));
const byId = new Map(versionRows.map(row => [String(row.content_id ?? row.id), row]));
const pick = rows.map(row => {
  const version = byId.get(String(row.id));
  const current = version?.version ?? version;
  return {
    id: String(row.id),
    title: row.title ?? '',
    description: row.description ?? '',
    type: row.type ?? null,
    publishType: row.ugc_publish_type ?? null,
    preview: row.preview?.url ?? null,
    width: row.preview?.width ?? null,
    height: row.preview?.height ?? null,
    auditStatus: row.audit_status ?? null,
    publishStatus: row.publish_status ?? null,
    declarationStatus: row.material_declaration_status ?? null,
    crcStatus: row.audit_crc_status ?? null,
    cqcStatus: row.audit_cqc_status ?? null,
    quality: row.content_quality_level ?? null,
    publishedAt: row.published_at ?? null,
    rejectReason: row.reject_reason ?? null,
    clicks: row.click_uv_total ?? null,
    downloads: row.download_uv_total ?? null,
    downloadUv: row.download_uv ?? null,
    editorUses: row.editor_use_uv ?? null,
    topics: (current?.topics ?? []).map(topic => ({ name: topic.name, kind: Number(topic.applicable_publish_type) === 2 ? 'material' : 'template', type: topic.topic_type_name ?? null })),
    versionNo: current?.version_no ?? null,
    versionStatus: current?.status_name ?? null
  };
});
const lastPage = pages.length ? pages[pages.length - 1].page : PAGE_NO;
return {
  fetchedAt: new Date().toISOString(),
  count: pick.length,
  rows: pick,
  page: ALL_PAGES ? 1 : PAGE_NO,
  pageSize,
  pages: pages.map(entry => ({ page: entry.page, count: entry.count })),
  hasMore: !ALL_PAGES && pages.length > 0 && pages[pages.length - 1].count === pageSize,
  lastPage
};
`;

/**
 * 读取已投稿作品：
 *   - 默认读第 1 页（pageSize 条），带 hasMore 供面板「加载更多」；
 *   - all=true 时在同一个浏览器会话里翻完所有页（最多 2000 条），一次给全量。
 * 60 秒内复用缓存，避免反复开浏览器。
 */
export async function listPublished({ space, page = 1, pageSize = 50, all = false, executable, spawnProcess, force = false } = {}) {
  const size = Math.min(200, Math.max(1, Math.floor(Number(pageSize) || 50)));
  const pageNo = Math.max(1, Math.floor(Number(page) || 1));
  const key = all ? 'published:all' : 'published:' + pageNo + ':' + size;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < cacheTtl) return hit.value;
  const script = `
const task=await taskSpace(${Number.isInteger(space) ? space : JSON.stringify('稿定投稿-' + randomUUID())});
const pages=await task.pages();
const blank=pages.length===1&&(await task.page(pages[0].label).url())==='about:blank';
const p=blank?task.page(pages[0].label):await task.newPage();
try{
 await p.goto('https://www.gaoding.com/my/publish',{waitUntil:'domcontentloaded'});
 await p.waitForTimeout(2500);
 const out=await p.evaluate(async () => {
${pageScript(size, pageNo, all)}
 });
 console.log(${JSON.stringify(marker)}+JSON.stringify({space:task.spaceId,...out}));
}finally{if(!blank)await p.close();}
`;
  const value = await runNode(script, { executable, spawnProcess });
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 审核状态判定（2026-11-17 用发布管理接口 + 列表徽标实测对齐）：
 *   material_declaration_status=WAITING_MATERIALS（素材） → 待声明
 *   publish_status=QUALITY_REJECTED 或 audit_cqc_status=2   → 审核不通过
 *   audit_cqc_status=0                                      → 审核中
 *   audit_cqc_status=1（publish_status=PUBLISHED）           → 已通过
 * 注意：audit_status 单独看会误判——审核中与已通过的 audit_status 都可能是 1，
 * 旧代码按 1/2/3 判断重来不准。
 */
export function auditState(row) {
  const declaration = row.declarationStatus ?? row.material_declaration_status ?? null;
  const publishType = Number(row.publishType ?? row.ugc_publish_type ?? 0);
  const publishStatus = String(row.publishStatus ?? row.publish_status ?? '').toUpperCase();
  // 声明刚提交时平台状态会短暂停留在 WAITING_MATERIALS，随后才变 PUBLISHED：
  // 两种字段都要认，否则会出现「已声明却显示待声明」。
  if (publishType === 2 && (declaration === 'WAITING_MATERIALS' || publishStatus === 'WAITING_MATERIALS')) {
    return { key: 'declaration', text: '待声明', tone: 'danger' };
  }
  const cqc = row.cqcStatus ?? row.audit_cqc_status ?? null;
  const crc = row.crcStatus ?? row.audit_crc_status ?? null;
  // audit_crc_status（版权审核）实测全量都是 2，不能拿来判拒绝，只看 cqc 与 publish_status。
  if (publishStatus === 'QUALITY_REJECTED' || publishStatus === 'REJECTED' || cqc === 2) return { key: 'rejected', text: '审核不通过', tone: 'danger' };
  if (cqc === 0 || crc === 0) return { key: 'reviewing', text: '审核中', tone: 'warning' };
  if (cqc === 1) return { key: 'passed', text: '已通过', tone: 'success' };
  return { key: 'unknown', text: '未知', tone: 'info' };
}

/** 统计汇总：按状态/类型/话题聚合，供面板筛选与概览。 */
export function summarize(rows = []) {
  const summary = { total: rows.length, clicks: 0, downloads: 0, editorUses: 0, byStatus: {}, byKind: { template: 0, material: 0 }, topics: {} };
  for (const row of rows) {
    summary.clicks += Number(row.clicks ?? 0);
    summary.downloads += Number(row.downloads ?? 0);
    summary.editorUses += Number(row.editorUses ?? 0);
    const status = auditState(row).text;
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    const kind = row.publishType === 2 ? 'material' : 'template';
    summary.byKind[kind]++;
    for (const topic of row.topics ?? []) summary.topics[topic.name] = (summary.topics[topic.name] ?? 0) + 1;
  }
  return summary;
}
