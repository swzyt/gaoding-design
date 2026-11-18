'use strict';
/** Browser-only DAM upload handoff. Never runs GD CLI or handles account tokens.
 * register(page, requestPath) is an explicit upload operation, to be called only
 * for Lead's frozen FINAL registration request. Observe/lookup are read-only.
 * Selector/API grounding: observed /dam/my UI, 2026-11-06; runtime asserts it.
 * Generated receipts are not uploaded as proof. Only final request PNGs enter DAM.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const SEARCH = '/api/dam/asset/v2/search/simple';
const FILE_INPUT = '.gd-dam-components__drop-upload__drop-upload input[type=file]';
const NAME = '.gd-dam-components__asset-info__asset-name[data-id]';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function write(file, data) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data, null, 2), {flag: 'wx'});
  await fs.rename(temp, file);
}
function cleanURL(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw Error('Expected HTTPS DAM asset URL');
  // Signed CDN query strings are transient and must not enter durable receipts.
  return url.origin + url.pathname;
}
async function safeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw Error('Expected release-relative file');
  const absolute = await fs.realpath(path.resolve(root, relative));
  const base = await fs.realpath(root);
  if (absolute === base || !absolute.startsWith(base + path.sep) || !(await fs.stat(absolute)).isFile()) throw Error('Unsafe asset path');
  return absolute;
}
function repository(query, rows) {
  const ids = new Set([...(query.repository_ids || []).map(String), ...rows.map(row => String(row.repository_id))]);
  if (ids.size !== 1 || [...ids].some(id => !/^\d+$/.test(id))) throw Error('Ambiguous or missing current repository ID');
  return [...ids][0];
}
async function observe(page) {
  const url = new URL(await page.url());
  if (url.origin !== 'https://www.gaoding.com' || !/^\/dam\/my(?:\/\d+)?$/.test(url.pathname)) throw Error('Dedicated current DAM /dam/my page required');
  await page.cdp('Network.enable');
  // Reloading the auto-expanded /dam/my/<id> route rendered an empty pane in
  // live testing. Reopen the observed public entry, which resolves current repo.
  await page.goto('https://www.gaoding.com/dam/my');
  await page.waitForSelector(FILE_INPUT, {state: 'attached', timeout: 20000});
  await page.waitForSelector(NAME, {state: 'attached', timeout: 20000});
  const events = await page.events();
  const requests = events.filter(event => event.method === 'Network.requestWillBeSent' && new URL(event.params.request.url).pathname === SEARCH);
  const responses = events.filter(event => event.method === 'Network.responseReceived' && new URL(event.params.response.url).pathname === SEARCH);
  const request = requests.at(-1), response = responses.at(-1);
  if (!request || !response || response.params.response.status !== 200) throw Error('Current DAM list request/response not observed; retry read-only observation');
  const query = JSON.parse(request.params.request.postData);
  const receipt = await page.cdp('Network.getResponseBody', {requestId: response.params.requestId});
  const body = JSON.parse(receipt.body);
  if (!Array.isArray(body.data)) throw Error('Unexpected DAM response schema');
  return {repository_id: repository(query, body.data), query, rows: body.data};
}
async function lookup(page, observed, title) {
  // Use the site's actual UI to supply its own authentication. Direct page.fetch
  // replays return 401; never inspect/copy auth headers or internal access tokens.
  await page.cdp('Network.enable');
  await page.events();
  const started = await page.evaluate(() => performance.now());
  const keyword = /-([a-f0-9]{10})$/.exec(title)?.[1] || title;
  await page.click('form input.search-input-v1__input >> nth=0');
  await page.fill('form input.search-input-v1__input >> nth=0', keyword);
  await page.keyboard.press('Enter');
  await page.waitForFunction(({started, endpoint}) => performance.getEntriesByType('resource').some(entry => entry.startTime >= started && new URL(entry.name).pathname === endpoint),
    {started, endpoint: SEARCH}, {timeout: 20000});
  const events = await page.events();
  const request = events.filter(event => event.method === 'Network.requestWillBeSent' && new URL(event.params.request.url).pathname === SEARCH).at(-1);
  const response = events.filter(event => event.method === 'Network.responseReceived' && new URL(event.params.response.url).pathname === SEARCH).at(-1);
  if (!request || !response || response.params.response.status !== 200) throw Error('UI lookup response not observed; preserve pending upload');
  const query = JSON.parse(request.params.request.postData);
  if (query.keyword !== keyword) throw Error('DAM UI search did not use expected title/hash');
  const receipt = await page.cdp('Network.getResponseBody', {requestId: response.params.requestId});
  const body = JSON.parse(receipt.body);
  if (!Array.isArray(body.data) || repository(query, body.data) !== observed.repository_id) throw Error('Unexpected UI lookup response/repository');
  if (body.total > body.data.length && keyword !== title) throw Error('Hash search results incomplete; inspect DAM before upload/recovery');
  const exact = body.data.filter(row => row.title === title);
  if (exact.length > 1) throw Error('Duplicate DAM title; reconcile uploads before retry');
  if (exact.some(row => String(row.repository_id) !== observed.repository_id)) throw Error('DAM repository changed');
  return exact[0] || null;
}
function assertBinding(request, state, observed) {
  if (!/^\d+$/.test(state.repository_id || '') || state.repository_id !== observed.repository_id) throw Error('Current DAM repository differs from persisted upload binding');
  if (request.repository_id != null && String(request.repository_id) !== observed.repository_id) throw Error('Explicit request repository differs from current DAM repository');
  if (state.assets.some(asset => asset.repository_id !== state.repository_id)) throw Error('Saved asset repository differs from upload binding');
}
function assertTitle(value) {
  if (typeof value !== 'string' || !value || /[\\/\x00-\x1f]/.test(value) || value === '.' || value === '..' || Buffer.byteLength(value) > 220) throw Error('Unsafe/overlong upload title');
}
function assertAsset(observed, expected, row) {
  if (!row?.id || String(row.repository_id) !== observed.repository_id || row.title !== expected.title) throw Error('DAM asset identity mismatch');
  if (!row.origin_info?.url) throw Error('DAM original URL missing; preserve pending upload');
}
async function checkSaved(expected, saved, root) {
  if (saved.state !== 'verified' || ['id', 'layer', 'title', 'source', 'sha256', 'category'].some(key => saved[key] !== expected[key]) || !saved.evidence
      || sha(await fs.readFile(await safeFile(root, saved.evidence.path))) !== saved.evidence.sha256) throw Error('Saved upload evidence changed');
}
async function downloadOriginal(page, expected, row, directory) {
  const download = path.join(directory, expected.id + '-download.png');
  const response = await page.fetch(row.origin_info.url, {saveAs: download, timeout: 20000});
  if (!response.ok || sha(await fs.readFile(download)) !== expected.sha256) throw Error('DAM original bytes differ; inspect actual asset, do not reupload');
}
async function boundedDownloads(items, work) {
  let next = 0, failure;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (error) { failure ||= error; }
    }
  };
  // Pure original-file reads only; all page writes and screenshots stay serial.
  // Drain in-flight reads even after failure before releasing the upload lock.
  await Promise.all(Array.from({length: Math.min(3, items.length)}, worker));
  if (failure) throw failure;
}
async function recoverVisible(page, observed, request, state, root, directory) {
  const items = [];
  for (const expected of request.assets) {
    const saved = state.assets.find(asset => asset.id === expected.id);
    if (!saved || state.pending === expected.id) continue;
    const matching = observed.rows.filter(row => String(row.id) === saved.asset_id);
    if (!matching.length) continue; // First-page absence is NOT proof of deletion.
    if (matching.length !== 1) throw Error('Duplicate saved DAM asset ID in current list');
    assertAsset(observed, expected, matching[0]);
    await checkSaved(expected, saved, root);
    items.push({expected, row: matching[0]});
  }
  if (!items.length) return new Set();
  const ids = items.map(item => String(item.row.id));
  const visible = await page.evaluate(({selector, ids}) => {
    const found = new Set([...document.querySelectorAll(selector)].map(node => node.dataset.id));
    return ids.filter(id => found.has(id));
  }, {selector: NAME, ids});
  // Virtualized/non-visible rows must use the normal per-item UI lookup path.
  const visibleIds = new Set(visible);
  const candidates = items.filter(item => visibleIds.has(String(item.row.id)));
  await boundedDownloads(candidates, item => downloadOriginal(page, item.expected, item.row, directory));
  return new Set(candidates.map(item => item.expected.id));
}
async function verify(page, observed, expected, row, root, directory, saved) {
  assertAsset(observed, expected, row);
  if (saved) await checkSaved(expected, saved, root);
  await downloadOriginal(page, expected, row, directory);
  const visible = await page.evaluate(({selector, id}) => [...document.querySelectorAll(selector)].some(node => node.dataset.id === id), {selector: NAME, id: String(row.id)});
  if (!visible) throw Error('Uploaded asset not visible in reopened DAM list; inspect/scroll before recovery');
  if (saved) return saved;
  const shot = path.join(directory, expected.id + '-verified.png');
  await page.keyboard.press('Escape'); // Close real search suggestions, no DOM edits.
  await page.screenshot({path: shot});
  return {...expected, asset_id: String(row.id), repository_id: observed.repository_id, state: 'verified',
    url: cleanURL(row.origin_info.url), evidence: {path: path.relative(root, shot), sha256: sha(await fs.readFile(shot))},
    verification: {method: 'reloaded-list-and-original-bytes', downloaded_sha256: expected.sha256}};
}
async function registerUnlocked(page, requestPath) {
  requestPath = path.resolve(requestPath);
  const directory = path.dirname(requestPath), root = path.dirname(directory);
  if (path.basename(requestPath) !== 'request.json' || path.basename(directory) !== 'registered-assets') throw Error('Expected frozen registered-assets/request.json');
  const request = await read(requestPath);
  if (request.schema !== 1 || !request.token || !Array.isArray(request.assets)) throw Error('Invalid frozen registration request');
  const ids = new Set(), titles = new Set();
  for (const row of request.assets) {
    if (!/^[a-zA-Z0-9_-]+$/.test(row.id) || ids.has(row.id) || titles.has(row.title)) throw Error('Unsafe or duplicate registration IDs/titles');
    ids.add(row.id); titles.add(row.title); assertTitle(row.title);
    if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !row.title.endsWith('-' + row.sha256.slice(0,10))) throw Error('Frozen upload title must end in final file hash prefix');
    const source = await safeFile(root, row.source);
    const bytes = await fs.readFile(source);
    if (sha(bytes) !== row.sha256 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Changed/non-PNG final asset: ' + row.id);
  }
  const stateFile = path.join(directory, 'browser-upload-state.json');
  let state;
  try { state = await read(stateFile); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await fs.access(path.join(directory, 'response.json')); throw Error('Orphaned registration response; recover previous state before uploading'); }
    catch (orphan) { if (orphan.code !== 'ENOENT') throw orphan; }
    state = {token: request.token, assets: []};
  }
  if (state.token !== request.token) throw Error('Upload request changed; reconcile prior uploads before proceeding');
  if (!Array.isArray(state.assets)) throw Error('Invalid saved browser upload assets');
  if (!state.repository_id && (state.assets.length || state.pending)) throw Error('Unknown repository binding for prior assets/pending upload; inspect original DAM state before recovery');
  let observed = await observe(page);
  if (!state.repository_id) {
    if (request.repository_id != null && String(request.repository_id) !== observed.repository_id) throw Error('Explicit request repository differs from current DAM repository');
    state.repository_id = observed.repository_id;
    await write(stateFile, state); // Freeze observed account library BEFORE upload.
  }
  assertBinding(request, state, observed);
  // One fresh library response can validate many previously saved asset IDs.
  // No title-only cache and no inference of absence from a paginated first page.
  const recovered = await recoverVisible(page, observed, request, state, root, directory);
  const stage = path.join(directory, 'upload-inputs');
  await fs.mkdir(stage, {recursive: true});
  if ((await fs.realpath(stage)) !== stage || (await fs.realpath(directory)) !== directory) throw Error('Unsafe upload state directory');
  for (const expected of request.assets) {
    if (recovered.has(expected.id)) continue;
    const saved = state.assets.find(asset => asset.id === expected.id);
    if (state.pending && state.pending !== expected.id && !saved) throw Error('Recover pending asset first: ' + state.pending);
    let row = await lookup(page, observed, expected.title);
    if (saved && (!row || saved.asset_id !== String(row.id))) throw Error('Saved DAM asset no longer matches current library');
    if (!row) {
      if (state.pending || saved) throw Error('Uncertain upload: inspect DAM and recover asset ID, never blindly reupload ' + expected.id);
      const input = path.join(stage, expected.title + '.png');
      await fs.writeFile(input, await fs.readFile(await safeFile(root, expected.source)), {flag: 'wx'}).catch(async error => {
        if (error.code !== 'EEXIST' || sha(await fs.readFile(input)) !== expected.sha256) throw error;
      });
      if (sha(await fs.readFile(input)) !== expected.sha256) throw Error('Staged upload differs from frozen final asset');
      state.pending = expected.id;
      await write(stateFile, state); // Crash after this point must NEVER resubmit.
      await page.setInputFiles(FILE_INPUT, [input]);
      await page.waitForFunction(({selector, title}) => [...document.querySelectorAll(selector)].some(node => node.textContent.trim() === title),
        {selector: NAME, title: expected.title}, {timeout: 60000});
      observed = await observe(page);
      assertBinding(request, state, observed);
      // Preflight UI search proved this title absent before this exact upload.
      // A unique positive row in the freshly reopened list already identifies it;
      // repeating the same global search adds no independent evidence.
      const matching = observed.rows.filter(asset => asset.title === expected.title);
      if (matching.length > 1) throw Error('Duplicate uploaded title; inspect DAM before recovery');
      row = matching[0] || await lookup(page, observed, expected.title);
      if (!row) throw Error('Upload not confirmed under exact requested title; preserve pending state');
    }
    // Existing/recovered rows came from a fresh authenticated UI lookup after
    // observe() reopened the library. A second goto + lookup is redundant.
    const result = await verify(page, observed, expected, row, root, directory, saved);
    state.assets = [...state.assets.filter(asset => asset.id !== expected.id), result];
    if (state.pending === expected.id) delete state.pending;
    await write(stateFile, state);
  }
  const response = {token: request.token, repository_id: observed.repository_id,
    assets: request.assets.map(expected => state.assets.find(row => row.id === expected.id))};
  await write(path.join(directory, 'response.json'), response);
  return response;
}
async function register(page, requestPath) {
  requestPath = path.resolve(requestPath);
  const directory = path.dirname(requestPath);
  if ((await fs.realpath(directory)) !== directory) throw Error('Unsafe registration directory');
  const lock = path.join(directory, 'browser-upload.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw Error('Upload helper already running or uncertain lock; inspect before recovery');
    throw error;
  }
  try { return await registerUnlocked(page, requestPath); }
  finally { await handle.close(); await fs.unlink(lock); }
}
module.exports = {observe, lookup, register, cleanURL, safeFile, repository, assertTitle, FILE_INPUT};
