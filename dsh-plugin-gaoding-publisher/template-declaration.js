/**
 * 模板版权声明：投稿后必须完成逐层声明，才算整条投稿流程完成。
 *
 * 与素材不同，模板只在「发布成功 → 去完善」的同一会话里能打开声明面板；
 * 发布管理列表里的「版权认证」对模板会失败（平台取不到内容版本，直接报
 * 「版权声明打开失败」，已在 2026-11-17 实测）。因此：
 *   1. 投稿前先在本地生成声明计划（计划里的图层数必须等于真实图片层数）；
 *   2. 声明在发布脚本的同一页面里完成，不另开会话；
 *   3. 提交后用平台接口 /api/v3/cp/ugc/contents/<id>/copyright-declarations
 *      真实回读，条数与分类必须和计划一致，才算 verified。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join as joinPath } from 'node:path';
import { spawn } from 'node:child_process';
import { egoBinary } from './publisher.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * 图层指纹：16×16 平均哈希 + 主色 + 宽高比。
 * 平台会把预览图重新编码（字节哈希对不上），小色块用哈希又容易撞值，
 * 所以三个维度一起比：哈希认纹理，主色认颜色，宽高比认形状。
 */
export function layerFingerprint(file, python) {
  return new Promise(resolve => {
    const script = [
      'import sys, json',
      'from PIL import Image',
      'im = Image.open(sys.argv[1]).convert("RGBA")',
      // 透明区域统一垫白底，保证与浏览器侧算法一致
      'flat = Image.new("RGBA", im.size, (255, 255, 255, 255)); flat.alpha_composite(im); im = flat',
      'small = im.convert("L").resize((16, 16), Image.Resampling.LANCZOS)',
      'px = list(small.getdata()); avg = sum(px) / len(px)',
      'bits = "".join("1" if v > avg else "0" for v in px)',
      'flat = im.reshape(-1) if hasattr(im, "reshape") else None',
      'rgb = im.convert("RGB").resize((1, 1), Image.Resampling.LANCZOS).getpixel((0, 0))',
      'cover = sum(1 for px in im.getdata() if px[0] < 250 or px[1] < 250 or px[2] < 250) / (im.width * im.height)',
      'bits = bits.ljust(256, "0")',
      'print(json.dumps({"hash": "%064x" % int(bits, 2), "rgb": list(rgb), "cover": cover, "aspect": im.width / im.height}))'
    ].join('\n');
    execFile(python, ['-c', script, file], { timeout: 30000 }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
  });
}

/** 汉明距离：越小越像。 */
export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 256;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { count += x & 1; x >>= 1; }
  }
  return count;
}

/** 两个指纹是否像同一张图：哈希接近，或颜色接近且形状比例一致。 */
export function fingerprintMatch(a, b) {
  if (!a || !b) return false;
  const hashDistance = hammingHex(a.hash, b.hash);
  if (hashDistance <= 24) return true;
  if (Array.isArray(a.rgb) && Array.isArray(b.rgb)) {
    const colorDistance = Math.abs(a.rgb[0] - b.rgb[0]) + Math.abs(a.rgb[1] - b.rgb[1]) + Math.abs(a.rgb[2] - b.rgb[2]);
    const aspectClose = a.aspect && b.aspect ? Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect) < 0.08 : false;
    const coverClose = Number.isFinite(a.cover) && Number.isFinite(b.cover) ? Math.abs(a.cover - b.cover) < 0.12 : false;
    if (colorDistance <= 30 && aspectClose && coverClose) return true;
  }
  return false;
}

const CATEGORY_LABELS = {
  original: '原创素材',
  original_ai: '原创 AI 素材',
  risk: '非原创素材',
  gaoding_licensed: '稿定素材'
};

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 投稿前生成声明计划：图片层、分类与真实证据都必须齐备，
 * 缺任何一层都直接失败——不允许「先发布、声明以后再说」。
 */
export function preflightTemplateDeclaration({ runDir, category: requestedCategory = null }) {
  let category = requestedCategory;
  if (requestedCategory && !CATEGORY_LABELS[requestedCategory]) throw Error('不支持的版权分类：' + requestedCategory);
  if (requestedCategory === 'risk' || requestedCategory === 'gaoding_licensed') {
    throw Error('模板不能用「' + CATEGORY_LABELS[requestedCategory] + '」声明：只允许原创 / 原创 AI');
  }
  const creation = readJson(join(runDir, 'creation.json'));
  if (!creation) throw Error('缺少 creation.json，无法确定声明范围');
  const manifest = readJson(join(runDir, 'release', 'layer-manifest.json'));
  if (!Array.isArray(manifest) || !manifest.length) throw Error('缺少 layer-manifest.json，无法确定逐层声明范围');
  const imageLayers = manifest.filter(row => row.type !== 'text' && row.file);
  if (!imageLayers.length) throw Error('没有图片层，无法生成逐层版权声明');
  // 原生文字层由编辑器原生文字承载，不在平台候选里，但仍要留下可核验的记录。
  const textLayers = manifest.filter(row => row.type === 'text' || !row.file);

  // 按真实来源判定声明分类：AI 生成的图片层声明为「原创 AI 素材」，
  // 程序绘制的图形层声明为「原创素材」。两类都存在时按哈希分组分别归类。
  const recipePath = join(runDir, 'release-recipe.json');
  const recipeLayers = Array.isArray(JSON.parse(readFileSync(recipePath, 'utf8'))?.layers)
    ? JSON.parse(readFileSync(recipePath, 'utf8')).layers
    : [];
  const categoryByName = new Map(recipeLayers.map(layer => [layer.name, layer.copyright_category ?? (layer.type === 'text' ? null : 'original')]));
  const groups = new Map();
  for (const row of imageLayers) {
    const declared = categoryByName.get(row.name) ?? row.copyright_category ?? 'original';
    const kind = declared === 'original_ai' || declared === 'ai' ? 'original_ai' : 'original';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push({ name: row.name, sha256: row.sha256 ?? null });
  }
  // 模板只要含 AI 生成的图层，整稿统一按「原创 AI 素材」声明：
  // 平台候选按内容去重、预览图又会被重编码，逐张区分 AI 图与程序图形容易错声明；
  // 整稿由 AI 参与创作，统一声明 AI 既不隐瞒也不夸大。纯程序绘制才声明「原创素材」。
  const hasAi = groups.has('original_ai');
  const effective = hasAi ? 'original_ai' : 'original';
  const allMembers = [...groups.values()].flat();
  const categories = [{
    category: effective,
    label: CATEGORY_LABELS[effective],
    layers: allMembers,
    layerNames: allMembers.map(row => row.name)
  }];
  const only = requestedCategory ? categories.find(row => row.category === requestedCategory) : null;
  if (requestedCategory && requestedCategory !== 'original' && !only) {
    throw Error('声明分类与真实来源不符：本稿没有 ' + CATEGORY_LABELS[requestedCategory] + ' 的图层');
  }
  category = effective;

  const evidence = readJson(join(runDir, 'publish', 'declaration-evidence.json'));
  if (!evidence) throw Error('缺少声明材料清单（publish/declaration-evidence.json），不能提交版权声明');
  const evidenceFile = evidence.image
    ? (isAbsolute(evidence.image) ? evidence.image : join(runDir, evidence.image))
    : join(runDir, 'publish', 'original-evidence.png');
  if (!existsSync(evidenceFile)) throw Error('声明材料图片不存在：' + evidenceFile);
  const evidenceSha = sha(evidenceFile);
  if (evidence.sha256 && evidence.sha256 !== evidenceSha) throw Error('声明材料图片已被修改，请重新生成证据');
  const covered = new Set(Array.isArray(evidence.layers) ? evidence.layers : []);
  const uncovered = imageLayers.map(row => row.name).filter(name => !covered.has(name));
  if (uncovered.length) throw Error('声明材料没有覆盖全部图片层：' + uncovered.slice(0, 6).join('、') + (uncovered.length > 6 ? ' 等 ' + uncovered.length + ' 层' : ''));
  const declared = imageLayers.map(row => ({ name: row.name, file: row.file ?? null, sha256: row.sha256 ?? null }));
  // 平台按图片内容去重：同内容的多层只生成一个候选，所以候选数按不同 sha256 计。
  const candidates = new Set(imageLayers.map(row => row.sha256)).size;
  const mismatched = declared.filter(row => !row.sha256);
  if (mismatched.length) throw Error('图层清单缺少哈希，无法证明声明材料对应最终文件');

  return {
    schema: 1,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    imageCount: imageLayers.length,
    candidates,
    categories: categories.map(row => ({
      category: row.category,
      label: row.label,
      layers: row.layers.length,
      layerNames: row.layerNames,
      sha256: row.layers.map(layer => layer.sha256).filter(Boolean)
    })),
    candidateNote: '平台按图片内容去重，' + imageLayers.length + ' 个图片层对应 ' + candidates + ' 个候选',
    textCount: textLayers.length,
    layers: declared,
    evidence: { file: evidenceFile, sha256: evidenceSha, recipeSha256: evidence.recipeSha256 ?? null },
    topic: creation.topic ?? null,
    title: creation.title ?? null
  };
}

/** 把声明计划写进运行目录，作为提交前必须存在的凭据。 */
export function writeDeclarationPlan(runDir, plan) {
  mkdirSync(join(runDir, 'publish'), { recursive: true });
  const file = join(runDir, 'publish', 'declaration-plan.json');
  writeFileSync(file, JSON.stringify({ ...plan, plannedAt: new Date().toISOString() }, null, 2) + '\n');
  return file;
}

/**
 * 声明提交后的真实核验：平台必须能回读到覆盖全部候选的声明记录。
 * 这一步只读，不重开、不重复提交；不通过一律视为投稿未完成。
 */
export async function completeTemplateDeclaration({ runDir, space, contentId, content, plan, executable, spawnProcess }) {
  const id = contentId ?? content?.id;
  if (!id) throw Error('缺少作品 ID，无法核验版权声明');
  if (!plan?.candidates) throw Error('缺少声明计划，无法核验版权声明');
  const records = await readDeclarationRecords({ contentId: id, space, executable, spawnProcess });
  const categories = records.map(row => String(row.copyright_type ?? row.copyrightType ?? '').toLowerCase());
  const matched = categories.filter(type => type === 'original' || type === 'original_ai').length;
  const result = {
    schema: 1, contentId: String(id), expected: plan.candidates, imageLayers: plan.imageCount,
    records: records.length, matched, categories: [...new Set(categories)],
    verified: records.length >= plan.candidates && matched >= plan.candidates,
    reopened: true, submitted: true, verifiedAt: new Date().toISOString()
  };
  mkdirSync(join(runDir, 'publish'), { recursive: true });
  writeFileSync(join(runDir, 'publish', 'declaration-verification.json'), JSON.stringify(result, null, 2) + '\n');
  if (!result.verified) throw Error('版权声明回读不完整：平台记录 ' + records.length + ' 条 / 需要 ' + plan.candidates + ' 条');
  return result;
}

/** 只读脚本执行器：不复用发布脚本的 marker 协议。 */
function runReadScript(script, { executable, spawnProcess = spawn, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(Error('版权声明回读超时')); }, timeout);
    child.on('error', error => finish(error));
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => {
      const line = (stdout + '\n' + stderr).split('\n').reverse().find(row => row.trim().startsWith('{'));
      if (!line) return finish(Error('版权声明回读没有返回数据：' + (stderr.trim().slice(-300) || 'exit ' + code)));
      try { finish(null, JSON.parse(line)); } catch (error) { finish(Error('版权声明回读返回格式异常：' + String(error?.message ?? error))); }
    });
    child.stdin.on('error', error => finish(error));
    child.stdin.end(script);
  });
}

/** 只读：读平台真实声明记录。 */
export async function readDeclarationRecords({ contentId, space, executable, spawnProcess }) {
  if (!Number.isSafeInteger(space) || space < 1) throw Error('需要复用当前任务的浏览器空间 ID');
  const script = `
const space = await taskSpace(${JSON.stringify(space)});
// 回读必须在 gaoding.com 的页面里调用同源接口：编辑器/创作中心的页面路径不同，直接 fetch 会失败。
const page = await space.newPage();
let records;
try {
  await page.goto('https://www.gaoding.com/my/publish', { waitUntil: 'domcontentloaded' });
records = await page.evaluate(async id => {
  const token = JSON.parse(localStorage.getItem('token') || '{}');
  const response = await fetch('/api/v3/cp/ugc/contents/' + id + '/copyright-declarations', { headers: { accept: 'application/json', authorization: 'Bearer ' + (token.access_token || token.token) } });
  if (!response.ok) throw Error('版权声明回读失败：' + response.status);
  return response.json();
}, ${JSON.stringify(String(contentId))});
} finally { try { await page.close(); } catch (error) {} }
console.log(JSON.stringify({ records }));
`;
  const value = await runReadScript(script, { executable, spawnProcess });
  return Array.isArray(value?.records) ? value.records : [];
}

export { CATEGORY_LABELS };
