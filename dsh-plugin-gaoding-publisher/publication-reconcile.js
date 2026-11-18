import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runNode } from './publisher.js';
import { readPublishedRows, verifyPublication } from './publication-safety.js';
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function buildReconcileScript({ space, contentId, screenshot }) {
  return `
const task = await taskSpace(${JSON.stringify(space)});
const page = await task.newPage();
try {
  await page.goto('https://www.gaoding.com/my/publish');
  const rows = await page.evaluate(${readPublishedRows.toString()});
  const content = rows.find(row => row.id === ${JSON.stringify(contentId)});
  if (!content) throw Error('原作品 ID 未在当前账号发布列表找到');
  await page.goto('https://gd.huaban.com/my/publish/' + content.id);
  await page.waitForFunction(() => !!document.querySelector('a[href*="/topics/"]'), undefined, { timeout: 15000 });
  content.topics = await page.evaluate(() => [...document.querySelectorAll('a[href*="/topics/"]')].map(a => a.textContent.trim()));
  await page.screenshot({ path: ${JSON.stringify(screenshot)} });
  console.log('GAODING_PUBLISH_RUN:' + JSON.stringify({ok:true, content}));
} catch (error) {
  console.log('GAODING_PUBLISH_RUN:' + JSON.stringify({ok:false, error:error.message}));
} finally { await page.close(); }
`;
}

export async function comparePixels({ python, localPath, remotePath }) {
  const script = `from PIL import Image
import hashlib,json,sys
images=[]
for path in sys.argv[1:]:
 im=Image.open(path).convert('RGBA')
 images.append({'size':im.size,'sha256':hashlib.sha256(im.tobytes()).hexdigest()})
print(json.dumps({'local':images[0],'remote':images[1],'identical':images[0]==images[1]}))`;
  const { stdout } = await exec(python, ['-c', script, localPath, remotePath], { timeout: 30000 });
  return JSON.parse(stdout);
}

/** Read-only platform reconciliation, followed by local verified state; never posts or declares anything. */
export async function reconcilePublication({ task, contentId, space, python, browser = runNode, fetchPreview = fetch, compare = comparePixels }) {
  if (!/^\d+$/.test(String(contentId))) throw Error('需要原作品的数字 ID');
  contentId = String(contentId);
  if (task.kind !== 'material') throw Error('模板需完成逐层版权核验，不能套用素材对账');
  if (!Number.isSafeInteger(space) || space < 1) throw Error('需要当前浏览器空间 ID');
  if (!task.topic) throw Error('任务缺少冻结话题');
  const localPath = task.asset || join(task.runDir, 'asset.png');
  const localSha = sha(readFileSync(localPath));
  const target = join(task.release || task.runDir, 'publication.json');
  const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null;
  if (previous?.contentId && String(previous.contentId) !== contentId) throw Error('作品 ID 与已有发布记录冲突，禁止覆盖');
  const directory = join(task.runDir, 'publish', 'reconciliation-' + randomUUID());
  mkdirSync(directory, { recursive: true });
  const screenshot = join(directory, 'detail.png');
  const result = await browser(buildReconcileScript({ space, contentId, screenshot }));
  if (!result.ok) throw Error(result.error || '平台读取失败');
  const content = result.content;
  if (content?.id !== contentId || content.publishType !== 2) throw Error('作品 ID 或投稿类型不匹配');
  const error = verifyPublication(content, task.topic, true);
  if (error) throw Error(error);
  const previewUrl = new URL(content.previewUrl);
  if (previewUrl.protocol !== 'https:' || !/(^|\.)dancf\.com$/.test(previewUrl.hostname)) throw Error('平台预览地址不受支持');
  const response = await fetchPreview(previewUrl.href, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('原作品预览读取失败：' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  const remotePath = join(directory, 'platform-preview.png');
  writeFileSync(remotePath, bytes, { flag: 'wx' });
  const pixels = await compare({ python, localPath, remotePath });
  if (!pixels.identical) throw Error('平台图像与本地素材像素不一致，不能关联');
  // Re-read before committing: neither the source asset nor an existing id may change during reconciliation.
  if (sha(readFileSync(localPath)) !== localSha) throw Error('对账期间本地素材发生变化');
  const current = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null;
  if (current?.contentId && String(current.contentId) !== contentId) throw Error('对账期间作品 ID 发生冲突');
  const checkedAt = new Date().toISOString();
  const evidence = { checkedAt, content, source: { localSha256: localSha, remoteSha256: sha(bytes), pixels }, screenshot, remotePath, previous };
  const evidencePath = join(directory, 'verification.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  const publication = {
    schema: 1, stage: 'verified', published: true, contentId, topic: task.topic, title: content.title,
    topics: content.topics, managementStatus: content.publishStatus, declarationStatus: content.declaration,
    verifiedAt: checkedAt, reconciled: true, assetSha256: localSha,
    evidence: [screenshot, evidencePath, remotePath]
  };
  mkdirSync(dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(publication, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, target);
  return { publication, evidencePath };
}
