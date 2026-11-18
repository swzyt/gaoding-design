// Run through ego-browser nodejs after prefixing this script with actual configuration:
// globalThis.CREATOR_KNOWLEDGE_ROOT = "/absolute/output";
// globalThis.CREATOR_TASK_SPACE = actualTaskSpaceId;
// Read-only collection; no generation or publishing. Never reuse a finished TaskSpace.
const fs = await import('node:fs/promises');
const crypto = await import('node:crypto');
const root = globalThis.CREATOR_KNOWLEDGE_ROOT;
const spaceId = globalThis.CREATOR_TASK_SPACE;
if(typeof root!=='string'||!root.startsWith('/')||!Number.isInteger(spaceId))throw Error('Provide actual absolute CREATOR_KNOWLEDGE_ROOT and active CREATOR_TASK_SPACE');
const base = 'https://gdce.yuque.com/gksiz6/bp2afo';
const task = await taskSpace(spaceId);
const page = task.page('p1');
await fs.mkdir(root + '/sources', { recursive: true });
let catalog;
try { catalog = JSON.parse(await fs.readFile(root + '/catalog.json', 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  catalog = { source: base, collectedAt: new Date().toISOString(), expectedDocumentCount: 70, documents: [] };
  const seed = await page.evaluate(() => ({
    text: document.body.innerText,
    links: [...document.querySelectorAll('a[href]')].map(a => ({ title: a.innerText.trim(), url: a.href }))
  }));
  await fs.writeFile(root + '/sources/home.txt', seed.text);
  catalog.documents.push({ id: 'home', url: base, title: '稿定设计 | 创作者中心', status: 'pending' });
  for (const link of seed.links) add(link);
}
function add(link) {
  const url = link.url.split('#')[0].split('?')[0].replace(/\/$/, '');
  if (!url.startsWith(base + '/') || !/^https:\/\/gdce\.yuque\.com\/gksiz6\/bp2afo\/[a-zA-Z0-9_-]+$/.test(url)) return;
  if (catalog.documents.some(d => d.url === url)) return;
  catalog.documents.push({ id: url.split('/').pop(), url, title: link.title.split('\n').filter(Boolean).join(' ').trim(), status: 'pending' });
}
async function persist() { await fs.writeFile(root + '/catalog.json', JSON.stringify(catalog, null, 2) + '\n'); }
let processed = 0;
while (processed < 10) {
  const entry = catalog.documents.find(d => d.status === 'pending');
  if (!entry) break;
  try {
    await page.goto(entry.url, { timeout: 25000 });
    await page.waitForFunction(() => !!document.querySelector('.ne-viewer-body') || document.body.innerText.includes('无权') || document.body.innerText.includes('不存在'), undefined, { timeout: 15000 });
    const record = await page.evaluate(() => {
      const body = document.querySelector('.ne-viewer-body');
      const heading = document.querySelector('h1')?.innerText || '';
      const scope = body || document.body;
      return {
        title: document.title.replace(/\s*·\s*稿定创作者中心\s*$/, '') || heading,
        url: location.href,
        hasDocumentBody: !!body,
        text: scope.innerText,
        html: scope.innerHTML,
        tables: [...scope.querySelectorAll('table')].map(t => [...t.rows].map(r => [...r.cells].map(c => c.innerText.trim()))),
        images: [...scope.querySelectorAll('img')].map((im, index) => ({ index, src: im.currentSrc || im.src, alt: im.alt, width: im.naturalWidth, height: im.naturalHeight })),
        bodyLinks: [...scope.querySelectorAll('a[href]')].map(a => ({ title: a.innerText.trim(), url: a.href })),
        allLinks: [...document.querySelectorAll('a[href]')].map(a => ({ title: a.innerText.trim(), url: a.href }))
      };
    });
    if (!record.hasDocumentBody && entry.id !== 'home') throw new Error('Document body unavailable: ' + record.text.slice(0, 250));
    record.collectedAt = new Date().toISOString();
    record.sha256 = crypto.createHash('sha256').update(record.text).digest('hex');
    await fs.writeFile(root + '/sources/' + entry.id + '.json', JSON.stringify(record, null, 2) + '\n');
    await fs.writeFile(root + '/sources/' + entry.id + '.txt', record.text + '\n');
    entry.status = 'collected'; entry.title = record.title; entry.characters = record.text.length; entry.imageCount = record.images.length; entry.sha256 = record.sha256; entry.collectedAt = record.collectedAt;
    for (const link of record.allLinks) add(link);
    console.log(JSON.stringify({ id: entry.id, title: entry.title, chars: entry.characters, images: entry.imageCount }));
  } catch (e) { entry.status = 'error'; entry.error = String(e); console.log(JSON.stringify({ id: entry.id, error: entry.error })); }
  processed++; await persist();
}
console.log(JSON.stringify({ discovered: catalog.documents.length, collected: catalog.documents.filter(d => d.status === 'collected').length, pending: catalog.documents.filter(d => d.status === 'pending').length, errors: catalog.documents.filter(d => d.status === 'error').length }));
