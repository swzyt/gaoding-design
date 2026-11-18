/**
 * 分层素材交接：让 DSH 出图插件（或任何 Agent 侧出图能力）为模板提供真实图像层。
 *
 * 为什么走文件交接而不是直接调用：DSH 的出图是 Agent 工具，宿主插件拿不到；
 * 插件负责生成"要什么图"的精确请求，Agent 按请求出图并回执，插件校验后渲染。
 *
 * 目录约定（都在运行目录内）：
 *   generated-assets/request.json   插件写出：素材清单、尺寸、是否要透明底
 *   generated/<asset-id>.png        Agent 写入：真实图片文件
 *   generated-assets/response.json Agent 回执：每个素材的路径、哈希、尺寸、是否有 alpha
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const schema = 1;
const MIN_SIDE = 512;
const MAX_ASSETS = 8;

export function assetsDir(runDir) { return join(runDir, 'generated-assets'); }
export function requestPath(runDir) { return join(assetsDir(runDir), 'request.json'); }
export function responsePath(runDir) { return join(assetsDir(runDir), 'response.json'); }
export function generatedFile(runDir, id) { return join(runDir, 'generated', id + '.png'); }

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 素材稿的素材计划：只要一张图，尺寸等于画布；贴纸类素材要求透明底。
 */
export function buildMaterialPlan({ unit, canvas }) {
  const prompt = String(unit?.prompt?.prompt ?? '').trim();
  if (!prompt) return [];
  const size = materialSizeOf(unit, canvas);
  return [{
    id: 'material',
    role: 'subject',
    require_alpha: unit?.material?.alpha === true || unit?.prompt?.alpha === true,
    prompt,
    width: size.w,
    height: size.h
  }];
}

function materialSizeOf(unit, canvas) {
  const match = /(\d{3,5})\s*[×x]\s*(\d{3,5})/.exec(String(unit?.prompt?.prompt ?? ''));
  if (match) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w >= 200 && h >= 200) return { w, h };
  }
  return { w: canvas?.w ?? 2048, h: canvas?.h ?? 2048 };
}

/** 从单元 prompt 里推导素材计划：id、出图 prompt、是否需要透明底、目标尺寸。 */
export function buildAssetPlan({ unit, canvas, kind = 'template' }) {
  if (kind === 'material') return buildMaterialPlan({ unit, canvas });
  const declared = Array.isArray(unit?.prompt?.assets) ? unit.prompt.assets : [];
  const layers = Array.isArray(unit?.prompt?.layers) ? unit.prompt.layers : [];
  const alphaIds = new Set(layers.filter(row => row?.require_alpha === true).map(row => String(row.id)));
  const roleById = new Map(layers.map(row => [String(row.id), String(row.role ?? '')]));
  const assets = [];
  for (const row of declared.slice(0, MAX_ASSETS)) {
    const id = String(row?.id ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '-');
    const prompt = String(row?.prompt ?? '').trim();
    if (!id || !prompt) continue;
    if (assets.some(item => item.id === id)) continue;
    const role = roleById.get(id) ?? '';
    const isBackground = role === 'background' || /背景/.test(prompt.slice(0, 12));
    assets.push({
      id,
      role: role || (isBackground ? 'background' : 'subject'),
      require_alpha: alphaIds.has(id) || row?.require_alpha === true || !isBackground && role !== 'background',
      prompt,
      width: isBackground ? canvas.w : Math.round(canvas.w * 0.8),
      height: isBackground ? canvas.h : Math.round(canvas.h * 0.8)
    });
  }
  return assets;
}

/**
 * 写出素材请求。token 绑定提示词内容：素材计划变了，旧回执自然失效。
 */
export function writeAssetRequest({ runDir, unit, canvas, job, kind = 'template' }) {
  const assets = buildAssetPlan({ unit, canvas, kind });
  if (!assets.length) return null;
  mkdirSync(assetsDir(runDir), { recursive: true });
  mkdirSync(join(runDir, 'generated'), { recursive: true });
  const token = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16);
  const value = {
    schema,
    kind,
    token,
    unitId: unit?.id ?? null,
    topic: unit?.prompt?.topic ?? job?.topic?.name ?? null,
    title: unit?.prompt?.title ?? '',
    canvas,
    assets: assets.map(row => ({
      id: row.id,
      role: row.role,
      require_alpha: row.require_alpha,
      width: row.width,
      height: row.height,
      prompt: row.prompt,
      target: 'generated/' + row.id + '.png'
    })),
    instructions: [
      '用可用的出图能力（如 DSH 出图插件）按 assets 逐张生成，写到 target 指定的相对路径。',
      'require_alpha 的素材必须保存为带透明通道的 PNG；背景类素材铺满画布，不需要透明。',
      '生成后写 response.json：{ schema, token, provider, model, assets:[{id,path,sha256,width,height,hasAlpha}] }。',
      'path 是运行目录内的相对路径；sha256 是文件真实哈希。不要改提示词后再声称完成。'
    ],
    createdAt: new Date().toISOString()
  };
  writeFileSync(requestPath(runDir), JSON.stringify(value, null, 2) + '\n');
  return value;
}

/**
 * 校验回执：文件存在、路径不越界、哈希一致、透明底要求满足、尺寸够大。
 * 返回 { ok, assets, problems }：有问题就如实列出，不猜、不放行。
 */
export function readAssetResponse({ runDir, request }) {
  const expected = request ?? readJson(requestPath(runDir));
  if (!expected?.assets?.length) return { ok: false, assets: [], problems: ['没有素材请求'] };
  const response = readJson(responsePath(runDir));
  if (!response) return { ok: false, assets: [], problems: ['还没有素材回执（generated-assets/response.json）'] };
  if (response.token && expected.token && response.token !== expected.token) {
    return { ok: false, assets: [], problems: ['素材回执与当前提示词不一致（token 不符），请重新出图'] };
  }
  const byId = new Map((Array.isArray(response.assets) ? response.assets : []).map(row => [String(row?.id ?? ''), row]));
  const problems = [];
  const assets = [];
  for (const want of expected.assets) {
    const got = byId.get(want.id);
    if (!got) { problems.push('缺少素材：' + want.id); continue; }
    const rel = String(got.path ?? '').trim();
    if (!rel || isAbsolute(rel)) { problems.push(want.id + '：path 必须是运行目录内的相对路径'); continue; }
    const abs = resolve(runDir, rel);
    const inside = !relative(resolve(runDir), abs).startsWith('..');
    if (!inside) { problems.push(want.id + '：path 越出运行目录'); continue; }
    if (!existsSync(abs)) { problems.push(want.id + '：文件不存在 ' + rel); continue; }
    const actual = sha256(abs);
    if (got.sha256 && actual !== String(got.sha256)) { problems.push(want.id + '：文件哈希与回执不符'); continue; }
    const info = pngInfo(abs);
    if (!info) { problems.push(want.id + '：不是有效 PNG'); continue; }
    if (info.w < MIN_SIDE || info.h < MIN_SIDE) { problems.push(want.id + '：尺寸过小 ' + info.w + '×' + info.h); continue; }
    const hasAlpha = info.colorType === 6 || info.colorType === 4;
    if (want.require_alpha && !hasAlpha) { problems.push(want.id + '：需要透明底，但图片没有 alpha 通道'); continue; }
    assets.push({
      id: want.id, role: want.role, require_alpha: want.require_alpha,
      source: rel, file: abs, width: info.w, height: info.h, hasAlpha, sha256: actual
    });
  }
  return { ok: problems.length === 0, assets, problems, provider: response.provider ?? null, model: response.model ?? null };
}

/** 读 PNG 头：宽高与颜色类型，不依赖图像库。 */
export function pngInfo(file) {
  try {
    const buffer = readFileSync(file);
    if (buffer.length < 26 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
    return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20), colorType: buffer.readUInt8(25) };
  } catch { return null; }
}

/** 读 PNG 真实 alpha 范围（min,max）：用于判断是否真的是透明底素材。 */
export function pngAlphaRange(file, python) {
  return new Promise(resolve => {
    const script = [
      'import sys, json',
      'from PIL import Image',
      'im = Image.open(sys.argv[1]).convert("RGBA")',
      'a = im.getchannel("A")',
      'print(json.dumps({"min": min(a.getdata()), "max": max(a.getdata())}))'
    ].join('\n');
    execFile(python, ['-c', script, file], { timeout: 20000 }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
  });
}

/** 单元素材状态：没请求、等回执、已就绪。 */
export function assetState({ runDir, unit, canvas, job }) {
  const request = readJson(requestPath(runDir));
  if (!request) {
    const plan = buildAssetPlan({ unit, canvas });
    return plan.length ? { state: 'missing', requested: plan.length } : { state: 'none', requested: 0 };
  }
  const checked = readAssetResponse({ runDir, request });
  return {
    state: checked.ok ? 'ready' : 'waiting',
    requested: request.assets.length,
    ready: checked.assets.length,
    problems: checked.problems,
    token: request.token
  };
}

export { schema as assetSchema };
