/**
 * 话题创作规范库：语雀规范页是公开可读的，无需登录即可抓取。
 * 本模块只做确定性的抓取、正文解析、缓存与索引；不含任何账号或浏览器操作。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const specSchemaVersion = 1;
export const specSource = 'https://gdce.yuque.com';
export const specFreshMs = 7 * 24 * 60 * 60 * 1000;
export const loginRequiredMessage = '该规范需要登录后查看';
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/** 语雀链接 → {host, bookPath, slug}；非语雀或结构不符返回 null。 */
export function yuqueTarget(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'yuque.com' || parsed.hostname.endsWith('.yuque.com'))) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return null;
    const slug = parts[parts.length - 1];
    if (!/^[A-Za-z0-9]{6,40}$/.test(slug)) return null;
    return { host: parsed.hostname, bookPath: parts.slice(0, 2).join('/'), slug };
  } catch { return null; }
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** 去掉标签，按块级元素切行；返回去空行后的纯文本行。 */
export function htmlToLines(html) {
  const cleaned = String(html ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|tr|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(cleaned)
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean);
}

function sentencesOf(lines) {
  const out = [];
  for (const line of lines) {
    for (const piece of line.split(/[。；;]/)) {
      const text = piece.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function unique(values, limit) {
  const seen = new Set(), out = [];
  for (const value of values) {
    const text = String(value).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text); out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

const forbiddenPattern = /严禁|禁止|不得|不可|不允许|不能出现|请勿/;
const materialPattern = /物料|尺寸|像素|分辨率|必须|需包含|至少|画布|比例/;
const directionPattern = /^([^：:]{2,10})[：:]\s*(.+)$/;
// 这些键是规则说明而不是创作方向，混进方向列表会误导选题。
const directionBlockExact = /^(活动时间|时间|日期|说明|补充说明|补充|备注|要求|类型|分类|模板|素材|标签|链接|入口|附件|下载|提交|审核|发布|注意|注意事项)$/;
const directionBlockPrefix = /^(获奖|奖励|奖金|评选|截止|参与|公布|结算|发放|投稿)/;
const dateLike = /^\d{4}\s*[.\-/年]/;

function imagesOf(html) {
  const out = [], seen = new Set();
  const push = src => {
    let value = String(src ?? '').trim();
    if (value.startsWith('//')) value = 'https:' + value;
    if (!/^https:\/\//.test(value) || seen.has(value)) return;
    seen.add(value); out.push(value);
  };
  // 语雀正文把图片写成 <card name="image" value="data:%7B...%7D">
  for (const match of String(html ?? '').matchAll(/<card[^>]*>/gi)) {
    const tag = match[0];
    if (!/name=["']image["']/i.test(tag)) continue;
    const attr = /\bvalue=["']([^"']+)["']/i.exec(tag);
    if (!attr) continue;
    let raw = attr[1].startsWith('data:') ? attr[1].slice(5) : attr[1];
    try { raw = decodeURIComponent(raw); } catch {}
    let src = null;
    try { src = JSON.parse(raw)?.src; } catch { const fallback = /"src"\s*:\s*"([^"]+)"/.exec(raw); src = fallback?.[1]; }
    push(src);
    if (out.length >= 8) return out;
  }
  for (const match of String(html ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    push(decodeEntities(match[1]));
    if (out.length >= 8) return out;
  }
  return out;
}

/** 从规范正文 HTML 抽出版式与合规字段；纯函数，便于测试。 */
export function parseSpecContent(html, meta = {}) {
  const lines = htmlToLines(html);
  const text = lines.join('\n');
  const sentences = sentencesOf(lines);
  const canvas = [];
  const seenCanvas = new Set();
  for (const match of text.matchAll(/(\d{3,4})\s*[*×xX]\s*(\d{3,4})\s*(?:px|像素)?/g)) {
    const width = Number(match[1]), height = Number(match[2]);
    // 素材话题常见正方形贴纸（如 2000×2000），模板话题里的正方形多半是样例尺寸噪声。
    if (!(width >= 300 && height >= 300)) continue;
    if (width === height && meta.allowSquare !== true) continue;
    const label = width + '×' + height;
    if (seenCanvas.has(label)) continue;
    seenCanvas.add(label); canvas.push({ width, height, label });
    if (canvas.length >= 6) break;
  }
  const forbidden = unique(sentences.filter(s => forbiddenPattern.test(s) && s.length <= 120), 10);
  const materials = unique(sentences.filter(s => materialPattern.test(s) && !forbidden.includes(s) && s.length <= 160), 10);
  const directions = unique(sentences
    .map(s => directionPattern.exec(s))
    .filter(Boolean)
    .filter(m => !forbiddenPattern.test(m[0]) && !materialPattern.test(m[1]))
    .filter(m => !directionBlockExact.test(m[1].trim()) && !directionBlockPrefix.test(m[1].trim()) && !dateLike.test(m[2].trim()))
    .map(m => m[1].trim() + '：' + m[2].trim()), 12);
  const images = imagesOf(html);
  const lines2 = lines.join('\n').split('\n');
  const excerpt = lines2.slice(0, 3).join(' ').slice(0, 300);
  return {
    title: String(meta.title ?? '').trim(),
    canvas, forbidden, materials, directions, images, excerpt, text,
    contentSha256: createHash('sha256').update(text).digest('hex'),
    wordCount: text.replace(/\s/g, '').length
  };
}

function specKey(key) {
  if (typeof key !== 'string' || !keyPattern.test(key)) throw Error('Invalid topic key');
  return key;
}

export function specsRoot(dataRoot) { return join(dataRoot, 'catalog', 'specs'); }
export function specFile(dataRoot, key) { return join(specsRoot(dataRoot), specKey(key) + '.json'); }
export function indexFile(dataRoot) { return join(specsRoot(dataRoot), 'index.json'); }
export function booksFile(dataRoot) { return join(specsRoot(dataRoot), 'books.json'); }
export function failuresFile(dataRoot) { return join(specsRoot(dataRoot), 'failures.json'); }

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

export function readSpec(dataRoot, key) { return readJson(specFile(dataRoot, key), null); }
export function writeSpec(dataRoot, spec) { writeJson(specFile(dataRoot, spec.key), spec); }
export function readIndex(dataRoot) {
  const value = readJson(indexFile(dataRoot), []);
  return Array.isArray(value) ? value : [];
}
export function writeIndex(dataRoot, rows) { writeJson(indexFile(dataRoot), rows); }
export function readBooks(dataRoot) {
  const value = readJson(booksFile(dataRoot), {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
export function writeBooks(dataRoot, books) { writeJson(booksFile(dataRoot), books); }
export function readFailures(dataRoot) {
  const value = readJson(failuresFile(dataRoot), []);
  return Array.isArray(value) ? value : [];
}
export function writeFailures(dataRoot, rows) { writeJson(failuresFile(dataRoot), rows); }

export function specIsFresh(spec, now = Date.now()) {
  const age = now - Date.parse(spec?.fetchedAt ?? '');
  return Number.isFinite(age) && age >= -60000 && age <= specFreshMs;
}

/** 索引行：列表页只需这些字段，不必打开每份规范。 */
export function summaryOf(spec) {
  return {
    key: spec.key, name: spec.name, title: spec.title, url: spec.url,
    canvas: (spec.canvas ?? []).map(row => row.label),
    forbiddenCount: (spec.forbidden ?? []).length,
    directionCount: (spec.directions ?? []).length,
    wordCount: spec.wordCount ?? 0,
    fetchedAt: spec.fetchedAt, contentSha256: spec.contentSha256
  };
}

async function fetchText(fetcher, url, accept) {
  const response = await fetcher(url, {
    headers: { accept, 'user-agent': userAgent },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 401 || response.status === 403) throw Error(loginRequiredMessage);
  if (!response.ok) throw Error('HTTP ' + response.status);
  return response;
}

async function resolveBookId(target, fetcher, books) {
  const cacheKey = target.host + '/' + target.bookPath;
  if (books[cacheKey]) return books[cacheKey];
  const page = await fetchText(fetcher, 'https://' + target.host + '/' + target.bookPath + '/' + target.slug, 'text/html');
  const html = await page.text();
  // 语雀把页面数据写成 URL 编码的字符串，所以 book_id 可能以 %22book_id%22%3A 形式出现。
  let match = /"book_id":(\d+)/.exec(html) ?? /%22book_id%22%3A(\d+)/.exec(html);
  if (!match) {
    try { match = /"book_id":(\d+)/.exec(decodeURIComponent(html)); } catch {}
  }
  if (!match) {
    if (/登录|Unauthorized|force_redirect_login/i.test(html)) throw Error(loginRequiredMessage);
    throw Error('规范页未提供知识库 ID');
  }
  books[cacheKey] = match[1];
  return match[1];
}

/** 抓取并解析一个话题的规范；失败抛出具体原因，不返回半成品。 */
export async function fetchSpec(topic, options = {}) {
  const { fetcher = globalThis.fetch, books = {}, now = new Date() } = options;
  const target = yuqueTarget(topic?.rules_url);
  if (!target) throw Error('该话题没有可解析的规范链接');
  if (typeof fetcher !== 'function') throw Error('当前运行环境没有网络能力');
  const bookId = await resolveBookId(target, fetcher, books);
  const api = 'https://' + target.host + '/api/docs/' + target.slug + '?book_id=' + bookId;
  let payload;
  try {
    const response = await fetchText(fetcher, api, 'application/json');
    payload = await response.json();
  } catch (error) {
    // 知识库 ID 变动时清掉缓存，重试一次。
    delete books[target.host + '/' + target.bookPath];
    const retryBook = await resolveBookId(target, fetcher, books);
    const retry = await fetchText(fetcher, 'https://' + target.host + '/api/docs/' + target.slug + '?book_id=' + retryBook, 'application/json');
    payload = await retry.json();
  }
  const doc = payload?.data;
  if (!doc || typeof doc.content !== 'string' || !doc.content.trim()) throw Error('规范正文为空');
  const parsed = parseSpecContent(doc.content, { title: doc.title ?? topic.name, allowSquare: topic.publishKind === 'material' });
  return {
    schema: specSchemaVersion,
    key: specKey(topic.key),
    name: topic.name ?? '',
    publishKind: topic.publishKind === 'material' ? 'material' : 'template',
    url: topic.rules_url,
    host: target.host,
    bookId,
    slug: target.slug,
    title: parsed.title || topic.name || '',
    updatedAt: doc.content_updated_at ?? doc.updated_at ?? null,
    canvas: parsed.canvas,
    forbidden: parsed.forbidden,
    materials: parsed.materials,
    directions: parsed.directions,
    images: parsed.images,
    excerpt: parsed.excerpt,
    text: parsed.text,
    wordCount: parsed.wordCount,
    contentSha256: parsed.contentSha256,
    fetchedAt: now.toISOString(),
    source: specSource
  };
}

/**
 * 批量刷新：按并发抓取，逐条落盘并更新索引。
 * 单题失败只记录错误，不影响其它题目。
 */
export async function refreshSpecs(options) {
  const {
    topics = [], dataRoot, fetcher = globalThis.fetch, concurrency = 4,
    force = false, now = new Date(), onProgress = () => {}, signal
  } = options;
  if (!dataRoot) throw Error('refreshSpecs requires dataRoot');
  const books = readBooks(dataRoot);
  const rows = readIndex(dataRoot);
  const rowMap = new Map(rows.map(row => [row.key, row]));
  const targets = topics.filter(topic => topic?.key && topic?.rules_url);
  const result = { ok: [], failed: [], skipped: [] };
  let cursor = 0;
  const progress = { total: targets.length, done: 0, ok: 0, failed: 0, skipped: 0 };
  onProgress(progress);
  async function worker() {
    while (cursor < targets.length) {
      if (signal?.aborted) return;
      const topic = targets[cursor++];
      const existing = readSpec(dataRoot, topic.key);
      if (!force && existing && specIsFresh(existing, now.getTime())) {
        result.skipped.push(topic.key); progress.skipped++; progress.done++;
        onProgress(progress); continue;
      }
      try {
        const spec = await fetchSpec(topic, { fetcher, books, now });
        writeSpec(dataRoot, spec);
        rowMap.set(spec.key, summaryOf(spec));
        result.ok.push(spec.key); progress.ok++;
      } catch (error) {
        result.failed.push({ key: topic.key, name: topic.name, error: String(error?.message ?? error) });
        progress.failed++;
      }
      progress.done++;
      onProgress(progress);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length || 1)) }, worker));
  } finally {
    writeBooks(dataRoot, books);
    writeIndex(dataRoot, [...rowMap.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')));
    // 失败原因要能跨进程看到，否则界面只能显示"待抓取"。
    const failures = new Map(readFailures(dataRoot).map(row => [row.key, row]));
    for (const key of [...result.ok, ...result.skipped]) failures.delete(key);
    for (const row of result.failed) failures.set(row.key, { ...row, at: now.toISOString() });
    writeFailures(dataRoot, [...failures.values()]);
  }
  return result;
}
