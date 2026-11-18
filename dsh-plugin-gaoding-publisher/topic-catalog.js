import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const catalogSource = 'https://creator.huaban.com/inspiration';
export const catalogEndpoint = 'https://creator.huaban.com/api/create/creator-center/inspiration/topics';
export const maxCatalogAge = 30 * 60 * 1000;
const text = (...values) => String(values.find(v => v !== undefined && v !== null && v !== '') ?? '').trim();
export function topicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['www.gaoding.com', 'gaoding.com'].includes(url.hostname)) return null;
    if (!/^\/topics\/[^/]+\/?$/.test(url.pathname)) return null;
    url.hash = ''; url.search = '';
    return url.href;
  } catch { return null; }
}
export function normalizeCatalog(payload, { checkedAt = new Date().toISOString(), complete = true } = {}) {
  if (payload?.err || payload?.error) throw Error('Catalog API returned an error');
  const data = payload?.data ?? payload;
  const rows = Array.isArray(data) ? data : data?.topics ?? data?.content;
  if (!Array.isArray(rows)) throw Error('Catalog response has no topics array');
  if (!Number.isFinite(Date.parse(checkedAt)) || Date.parse(checkedAt) > Date.now() + 60000) throw Error('Invalid catalog observation time');
  const topics = [], seen = new Map(); let rejected = 0;
  for (const row of rows) {
    const name = text(row?.name, row?.title), link = text(row?.topic_link, row?.topicLink, row?.url);
    const hub = topicUrl(text(row?.hub)) || topicUrl(link);
    let rules_url = null;
    try { const url = new URL(row?.rules_url || link); if (url.protocol === 'https:' && (url.hostname === 'yuque.com' || url.hostname.endsWith('.yuque.com'))) rules_url = url.href; } catch {}
    const id = text(row?.id, row?.topic_id);
    if (!name || (!id && !hub && !rules_url)) { rejected++; continue; }
    const identity = id || hub || rules_url;
    const key = 'topic-' + createHash('sha256').update(identity).digest('hex').slice(0, 20);
    const signature = JSON.stringify([name, hub, rules_url, Number(row?.applicable_publish_type) === 2]);
    if (seen.has(key)) { if (seen.get(key) !== signature) rejected++; continue; }
    seen.set(key, signature);
    const publishKind = Number(row?.applicable_publish_type) === 2 ? 'material' : 'template';
    topics.push({key, id: id || null, name, hub, rules_url, publishKind, researchStatus: hub ? 'ready' : rules_url ? 'resolve-hub-from-rules' : 'needs-research', specs: text(row.specs, row.description), type: text(row.topic_type_name, row.topicTypeName, row.type), status: text(row.status), onlineAt: row.online_at ?? row.onlineAt ?? null, offlineAt: row.offline_at ?? row.offlineAt ?? null, validStatus: row.valid_status ?? row.validStatus ?? null, specsNote: '目录信息仅用于选题；以本次详情页和完整规范为准'});
  }
  const total = Number(data?.total ?? payload?.total);
  const truncated = Number.isFinite(total) && total > rows.length;
  return {source: catalogSource, endpoint: catalogEndpoint, checkedAt, status: complete && !rejected && !truncated ? 'complete' : 'partial', topics, received: rows.length, rejected, ...(truncated ? {error: '目录响应存在尚未读取的分页'} : {}), ...(rejected ? {error: `${rejected} 条目录缺少名称、有效详情链接或存在冲突`} : {})};
}
export function catalogIsFresh(catalog, now = Date.now()) {
  const age = now - Date.parse(catalog?.checkedAt);
  return Number.isFinite(age) && age >= -60000 && age <= maxCatalogAge;
}
export function selectableTopic(topic, now = Date.now()) {
  if (topic.validStatus !== null && Number(topic.validStatus) === 0) return false;
  if (/下架|结束|offline|expired/i.test(topic.status)) return false;
  const date = value => value == null || value === '' ? NaN : typeof value === 'number' || /^\d+$/.test(value) ? (Number(value) < 1e12 ? Number(value) * 1000 : Number(value)) : Date.parse(value);
  const online = date(topic.onlineAt), offline = date(topic.offlineAt);
  return !(online > now || offline <= now);
}
export async function fetchCatalog(fetcher = globalThis.fetch) {
  const response = await fetcher(catalogEndpoint, {headers: {accept: 'application/json'}, signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw Error(`目录接口 HTTP ${response.status}；请由 Agent 使用当前已登录浏览器读取创作灵感目录并通过 gaoding_topics 导入本次快照`);
  return normalizeCatalog(await response.json());
}
export function snapshotCatalog(snapshot) {
  if (snapshot?.source !== catalogSource || typeof snapshot.complete !== 'boolean' || !snapshot.checkedAt) throw Error('Browser snapshot requires source, checkedAt and explicit complete');
  const catalog = normalizeCatalog(snapshot.payload ?? {topics: snapshot.topics}, {checkedAt: snapshot.checkedAt, complete: snapshot.complete});
  if (!catalogIsFresh(catalog)) throw Error('Browser catalog snapshot is stale; read the current page again');
  return catalog;
}
let browserFlight, browserFlightSpace;
export async function collectFromBrowser({space, executable, spawnProcess = spawn} = {}) {
  if (space !== undefined && (!Number.isInteger(space) || space < 0)) throw Error('Invalid browser TaskSpace ID');
  if (browserFlight) { if(space !== browserFlightSpace) throw Error('Another target is refreshing its catalog; retry after it finishes'); return browserFlight; }
  browserFlightSpace = space;
  const cli = executable || process.env.EGO_BROWSER_BIN || (existsSync(join(homedir(), '.local/bin/ego-browser')) ? join(homedir(), '.local/bin/ego-browser') : 'ego-browser');
  const script = `const task=await taskSpace(${space === undefined ? JSON.stringify('稿定投稿-' + randomUUID()) : space});
const pages=await task.pages();
const fresh=pages.length===1 && (await task.page(pages[0].label).url())==='about:blank';
const p=fresh?task.page(pages[0].label):await task.newPage();
try {
 await p.cdp('Network.enable');
 await p.goto(${JSON.stringify(catalogSource)});
 await p.waitForFunction(()=>performance.getEntriesByType('resource').some(r=>r.name.includes('/inspiration/topics')&&r.responseEnd>0),undefined,{timeout:25000});
 const ev=await p.events();
 const r=ev.filter(e=>e.method==='Network.responseReceived'&&e.params.response.url.includes('/inspiration/topics')).at(-1);
 if(!r||r.params.response.status!==200)throw Error('目录加载失败，请检查创作中心登录状态');
 const out=await p.cdp('Network.getResponseBody',{requestId:r.params.requestId});
 const payload=JSON.parse(out.base64Encoded?Buffer.from(out.body,'base64').toString():out.body);
 console.log('GAODING_CATALOG:'+JSON.stringify({space:task.spaceId,source:${JSON.stringify(catalogSource)},checkedAt:new Date().toISOString(),complete:true,payload}));
}finally{if(!fresh)await p.close();}`;
  browserFlight = new Promise((resolve, reject) => {
    const child = spawnProcess(cli, ['nodejs', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = ''; const timer = setTimeout(() => {child.kill(); reject(Error('Browser catalog refresh timed out'));}, 60000);
    child.stdout.on('data', data => {stdout += data; if (stdout.length > 4e6) child.kill();});
    child.stderr.on('data', data => {stderr += data; if (stderr.length > 4e6) child.kill();});
    child.on('error', error => {clearTimeout(timer); reject(error);});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Error('Browser catalog refresh failed: ' + (stderr.slice(-2000) || 'exit ' + code)));
      try { const row = (stdout + '\n' + stderr).split('\n').find(line => line.startsWith('GAODING_CATALOG:')); if (!row) throw Error('Browser returned no catalog'); const snapshot = JSON.parse(row.slice('GAODING_CATALOG:'.length)); resolve({...snapshotCatalog(snapshot), space: snapshot.space}); } catch(error) {reject(error);}
    });
  }).finally(() => {browserFlight = undefined;});
  return browserFlight;
}
export async function loadCatalog({read, write, snapshot, space, refresh = false, fetcher, browser = collectFromBrowser} = {}) {
  if (space !== undefined && (!Number.isInteger(space) || space < 0)) throw Error('Invalid browser TaskSpace ID');
  if (snapshot) { const catalog = {...snapshotCatalog(snapshot), ...(space !== undefined ? {space} : {})}; write(catalog); return {...catalog, stale: false, selectableTopics: catalog.topics.filter(t => selectableTopic(t))}; }
  const cached = read();
  if (!refresh && cached && catalogIsFresh(cached)) { const current = {...cached, ...(space !== undefined ? {space} : {})}; if(space !== undefined)write(current); return {...current, stale: false, selectableTopics: current.topics.filter(t => selectableTopic(t))}; }
  try { const catalog = {...await fetchCatalog(fetcher), ...(space !== undefined || cached?.space !== undefined ? {space: space ?? cached.space} : {})}; write(catalog); return {...catalog, stale: false, selectableTopics: catalog.topics.filter(t => selectableTopic(t))}; }
  catch (error) {
    try { const catalog = await browser({space: space ?? cached?.space}); write(catalog); return {...catalog, stale: false, selectableTopics: catalog.topics.filter(t => selectableTopic(t))}; }
    catch (browserError) { return {...(cached || {source: catalogSource, topics: [], checkedAt: null}), status: 'unavailable', stale: !!cached, selectableTopics: [], error: `${error.message}；${browserError.message}`}; }
  }
}
