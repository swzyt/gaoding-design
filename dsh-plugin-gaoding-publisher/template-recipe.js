/**
 * 模板创作：模型写分层配方 → 本地 workflow build 渲染成 PSD/PNG。
 * 模板的文字必须是原生可编辑文字层，所以这里不生整图，只做排版与本地渲染。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workflow, environment } from './runtime-host.js';
import { buildAssetPlan, readAssetResponse, requestPath as assetRequestPath, writeAssetRequest } from './asset-handoff.js';
import { readFileSync as readFileSyncRaw } from 'node:fs';
const readJson = file => { try { return JSON.parse(readFileSyncRaw(file, 'utf8')); } catch { return null; } };

const fontDefaults = {
  font: 'STHeitiSC-Medium',
  preview_font: '/System/Library/Fonts/STHeiti Medium.ttc',
  font_index: 1,
  gd_font: '思源黑体 Medium'
};

const system = [
  '你是稿定模板排版器，输出严格 JSON，不要 Markdown、不要解释。',
  '输出结构：{"title":"作品标题","description":"60字内作品描述","layers":[{...}],"layer_audit":{"pairs":[{"subject":"主体层名","background":"背景层名"}]}}',
  '图层规则：',
  '1. 第一个图层必须是铺满画布的 background（type:"shape"，box:[0,0,画布宽,画布高]，color:[r,g,b]）；',
  '2. 装饰与信息容器用 type:"shape"，各自独立图层，禁止文字烘焙进形状；有生成素材时用 type:"image" 并写 source:"generated/素材id.png"；',
  '2.1 每个 image/shape 图层必须写 role：background|container|decoration|subject；decoration 不得与文字框相交（文字会被盖住），信息卡用 container；',
  '2.2 图像层素材由出图后端生成，source 只能是 generated/ 下的相对路径；需要透明边的写 require_alpha:true；',
  '3. 所有文字用 type:"text"，每行/每块独立图层，字段：id,name,text,box,size,color,align,line_height,letter_spacing；',
  `4. 文字层必须带 font:"${fontDefaults.font}", preview_font:"${fontDefaults.preview_font}", font_index:${fontDefaults.font_index}, gd_font:"${fontDefaults.gd_font}"；`,
  '5. 文字只用中英文与常用标点，禁止 emoji 和特殊符号（预览字体会显示成方块）；',
  '6. box 为 [x,y,w,h]，必须落在画布内，文字框要给足宽度避免溢出；',
  '7. 颜色用 [r,g,b] 整数 0-255；排版要有清晰层级与留白。',
  '8. 画布安全边距 ≥ 60px：任何文字框都必须完整落在 [60,60,画布宽-60,画布高-60] 内；',
  '9. 主体图（subject）面积不得超过画布的 35%，放在四角或留白处，禁止与任何文字框相交；',
  '10. 背景图必须铺满画布（box 与画布等宽高）；容器（container）可以有 1–2 个，用于承托文字；',
  '11. 装饰只用素材图（type:"image"）；不要用纯色 shape 当装饰——程序会把纯色装饰层丢掉；',
  '12. 图层总数（含文字）不超过 16 个。',
  '13. 字号只用 4 档以内，主标题至少是正文的 1.6 倍；文字与底色对比度：大字号 ≥3:1，小字号 ≥4.5:1。'
].join('\n');

export function buildRecipeRequest({ job, unit, generated = [] }) {
  const brief = unit.brief ?? {};
  const prompt = String(unit.prompt?.prompt ?? '').trim();
  const lines = [
    '话题：' + (job.topic?.name ?? ''),
    '画布：' + (brief.canvas?.[0] ?? '1242×1656') + ' px',
    '创作要求：' + prompt,
    job.note ? '用户要求：' + job.note : null,
    generated.length
      ? '可用图像素材（必须用 type:"image" 图层摆放，source 原样填写，禁止改成 shape 或重画）：\n' +
        generated.map(row => '- ' + row.id + ' → source:"' + row.source + '"（' + row.width + '×' + row.height + '，' +
          (row.require_alpha ? '透明底' : '不透明') + (row.role ? '，建议 ' + row.role : '') + '）').join('\n')
      : null,
    generated.length
      ? '摆放要求：背景素材铺满画布并与画布同尺寸；主体素材按合理比例放在留白处，禁止压住文字；信息卡先放、文字后放。'
      : null,
    '请输出可直接渲染的 recipe JSON。'
  ].filter(Boolean);
  return { system, user: lines.join('\n\n') };
}

/** 图层角色：显式声明优先，铺满画布的按背景算，其余默认容器（容器允许被文字压，不算遮挡）。 */
export function roleOf(layer, box, canvas) {
  const explicit = String(layer?.role ?? '');
  if (['background', 'container', 'decoration', 'subject'].includes(explicit)) return explicit;
  const area = (box[2] * box[3]) / (canvas.w * canvas.h);
  return area >= 0.9 ? 'background' : 'container';
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

/** 去掉注释与尾逗号等常见 JSON 瑕疵，尽量不因为一个逗号丢掉整份配方。 */
export function cleanJson(text) {
  return String(text ?? '')
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/,'')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

/** 解析并规整模型输出：补齐字体、修正越界、保证有背景与文字层。 */
export function normalizeRecipe(text, { canvas }) {
  const raw = cleanJson(text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw Error('模型没有返回配方 JSON：' + raw.slice(0, 120));
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const layersIn = Array.isArray(parsed.layers) ? parsed.layers : [];
  if (!layersIn.length) throw Error('配方没有图层');
  const layers = [];
  const used = new Set();
  layersIn.slice(0, 40).forEach((layer, index) => {
    const type = layer?.type === 'text' ? 'text' : (layer?.type === 'image' ? 'image' : 'shape');
    const id = String(layer?.id ?? (type === 'text' ? 'text-' : 'shape-') + (index + 1)).replace(/[^A-Za-z0-9_-]/g, '-');
    if (used.has(id)) return;
    used.add(id);
    // 图层必须完整落在画布内：先定宽高，再把 x/y 收进剩余空间，避免右下越界。
    const box = Array.isArray(layer?.box) && layer.box.length === 4
      ? (() => {
          const width = clamp(layer.box[2], 10, canvas.w);
          const height = clamp(layer.box[3], 10, canvas.h);
          return [clamp(layer.box[0], 0, canvas.w - width), clamp(layer.box[1], 0, canvas.h - height), width, height];
        })()
      : [0, 0, canvas.w, canvas.h];
    if (type === 'text') {
      // 去掉 emoji 与非常用符号，避免预览字体缺字显示成方块。
      const text = String(layer?.text ?? '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
      if (!text) return;
      // 文字框收进安全边距：宽高先限幅，再把起点推进来，避免贴边或出界。
      const margin = 60;
      const maxW = Math.max(10, canvas.w - margin * 2);
      const maxH = Math.max(10, canvas.h - margin * 2);
      const textW = Math.min(box[2], maxW);
      const textH = Math.min(box[3], maxH);
      const textBox = [
        clamp(box[0], margin, canvas.w - margin - textW),
        clamp(box[1], margin, canvas.h - margin - textH),
        textW,
        textH
      ];
      layers.push({
        id, name: String(layer?.name ?? '文案-' + (layers.length + 1)).slice(0, 40), type: 'text', text,
        box: textBox, size: clamp(layer?.size ?? 40, 24, 200),
        color: Array.isArray(layer?.color) ? layer.color.map(v => clamp(v, 0, 255)) : [24, 24, 28],
        ...fontDefaults,
        align: ['left', 'center', 'right'].includes(layer?.align) ? layer.align : 'left',
        line_height: Number(layer?.line_height) > 0 ? Number(layer.line_height) : 1.25,
        letter_spacing: Number.isFinite(Number(layer?.letter_spacing)) ? Number(layer.letter_spacing) : 0
      });
    } else if (type === 'image') {
      // 真实图像层：素材由出图后端（gd-cli 或 DSH 出图插件）生成，路径必须落在单元目录内。
      const source = String(layer?.source ?? '').trim();
      if (!source || source.startsWith('/') || source.includes('..')) return;
      layers.push({
        id, name: String(layer?.name ?? '图像-' + (layers.length + 1)).slice(0, 40), type: 'image',
        source, box,
        role: roleOf(layer, box, canvas),
        require_alpha: layer?.require_alpha === true,
        // generated/ 下的图像由图像模型产出，来源就是 AI 生成，声明必须按 original_ai 走。
        copyright_category: layer?.copyright_category === 'original'
          ? 'original'
          : (String(source).startsWith('generated/') ? 'original_ai' : 'original')
      });
    } else {
      const role = roleOf(layer, box, canvas);
      // 纯色小块当装饰最容易变成「像渲染错误」的色块：丢掉，装饰交给素材图。
      if (role === 'decoration') return;
      layers.push({
        id, name: String(layer?.name ?? '形状-' + (layers.length + 1)).slice(0, 40), type: 'shape', shape: layer?.shape === 'ellipse' ? 'ellipse' : 'rectangle',
        box, color: Array.isArray(layer?.color) ? layer.color.map(v => clamp(v, 0, 255)) : [240, 240, 244],
        role,
        copyright_category: 'original'
      });
    }
  });
  const background = { id: 'background', name: '背景-完整底色', type: 'shape', role: 'background', box: [0, 0, canvas.w, canvas.h], color: [246, 244, 239], copyright_category: 'original' };
  const rest = layers.filter(layer => layer.id !== 'background');
  // 已经有铺满画布的背景层（图像或形状）时，不再叠加一块纯色底，避免多余满版层把画面压白。
  const primary = rest.find(layer => layer.role === 'background');
  const hasBackground = Boolean(primary);
  // 模型给的纯色背景直接顶替默认底色，图层 ID 统一叫 background，下游规则保持一致。
  if (primary && primary.type === 'shape') { primary.id = 'background'; }
  // 文字层必须压在最上层，否则装饰会盖住标题（历史真实故障）。
  const ordered = [
    ...(hasBackground ? [] : [background]),
    ...rest.filter(layer => layer.type !== 'text'),
    ...rest.filter(layer => layer.type === 'text')
  ];
  if (!ordered.some(layer => layer.type === 'text')) throw Error('配方没有原生文字层');
  const collisions = decorationCollisions(ordered);
  if (collisions.length) {
    throw Error('主体/装饰压到文字：' + collisions.slice(0, 3).map(row => row.decoration + ' × ' + row.text).join('、'));
  }
  const layout = layoutProblems(ordered, canvas);
  if (layout.length) throw Error('版式不合格：' + layout.slice(0, 3).join('；'));
  const subjects = ordered.filter(layer => layer.type === 'shape' && layer.id !== 'background').slice(0, 3).map(layer => layer.name);
  return {
    canvas: { ...canvas, dpi: 72 },
    topic: null,
    title: String(parsed.title ?? '').slice(0, 80) || '未命名模板',
    description: String(parsed.description ?? '').slice(0, 200),
    output: 'release',
    layers: ordered,
    layer_audit: { pairs: subjects.map((name, index) => ({ subject: name, background: index % 2 === 0 ? background.name : (subjects[index - 1] ?? background.name) })) }
  };
}

/** 除容器外，任何图层压到文字都算遮挡；容器允许，因为文字就写在它上面。 */
export function decorationCollisions(layers) {
  const texts = layers.filter(layer => layer.type === 'text');
  const decorations = layers.filter(layer => layer.type !== 'text' && layer.role !== 'container' && layer.role !== 'background');
  const hit = [];
  for (const decoration of decorations) {
    for (const text of texts) {
      const [ax, ay, aw, ah] = decoration.box;
      const [bx, by, bw, bh] = text.box;
      if (ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by) hit.push({ decoration: decoration.name, text: text.name });
    }
  }
  return hit;
}

/** 相对亮度与对比度（WCAG）：文字压在什么颜色上决定可读性。 */
export function relativeLuminance(rgb) {
  const channel = value => {
    const v = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a, b) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

/** 文字实际压在哪个纯色层上（从最上层往下找第一个覆盖文字中心的层）。 */
export function backdropOf(text, layers) {
  const [x, y, w, h] = text.box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer.type === 'text' || !layer.box) continue;
    const [lx, ly, lw, lh] = layer.box;
    if (cx < lx || cx > lx + lw || cy < ly || cy > ly + lh) continue;
    if (layer.type === 'shape' && Array.isArray(layer.color)) return { color: layer.color, name: layer.name };
    if (layer.type === 'image') return { color: null, name: layer.name };
  }
  return { color: [255, 255, 255], name: '画布' };
}

/** 版式硬性规则：安全边距、背景铺满、主体比例、装饰面积、图层数量、字号层级、文字对比度。 */
export function layoutProblems(layers, canvas) {
  const problems = [];
  const margin = 60;
  const texts = layers.filter(layer => layer.type === 'text');
  for (const text of texts) {
    const [x, y, w, h] = text.box;
    if (x < margin || y < margin || x + w > canvas.w - margin || y + h > canvas.h - margin) {
      problems.push('文字「' + text.name + '」超出安全边距');
    }
  }
  const area = layer => (layer.box[2] * layer.box[3]) / (canvas.w * canvas.h);
  for (const layer of layers.filter(row => row.type !== 'text')) {
    if (layer.role === 'background') {
      const [x, y, w, h] = layer.box;
      if (Math.abs(x) > 2 || Math.abs(y) > 2 || Math.abs(w - canvas.w) > canvas.w * 0.02 || Math.abs(h - canvas.h) > canvas.h * 0.02) {
        problems.push('背景层「' + layer.name + '」没有铺满画布');
      }
      continue;
    }
    if (layer.role === 'subject' && area(layer) > 0.35) problems.push('主体「' + layer.name + '」面积超过画布 35%');
    // 纯色装饰层已在归一化时丢弃；图像装饰允许较大（如角落弧形），但不能铺满整张画布。
    if (layer.role === 'decoration' && layer.type === 'image' && area(layer) > 0.45) {
      problems.push('装饰图「' + layer.name + '」面积超过画布 45%');
    }
  }
  if (layers.length > 16) problems.push('图层数 ' + layers.length + ' 超过 16');

  // 字号层级：太小看不清，层级太多画面就散了。
  const sizes = [...new Set(texts.map(text => Number(text.size) || 0))].filter(Boolean).sort((a, b) => a - b);
  for (const text of texts) {
    if ((Number(text.size) || 0) > 0 && (Number(text.size) || 0) < 24) problems.push('文字「' + text.name + '」字号小于 24');
  }
  if (sizes.length > 4) problems.push('字号层级过多（' + sizes.length + ' 种），最多 4 种');
  if (sizes.length >= 2 && sizes[sizes.length - 1] < sizes[0] * 1.6) {
    problems.push('主标题与正文字号差距不足 1.6 倍，层级不清晰');
  }

  // 对比度：文字压在纯色层上时必须够清楚（大字号 3:1，小字号 4.5:1）。
  for (const text of texts) {
    if (!Array.isArray(text.color)) continue;
    const backdrop = backdropOf(text, layers);
    if (!backdrop.color) continue;
    const ratio = contrastRatio(text.color, backdrop.color);
    const need = (Number(text.size) || 0) >= 32 ? 3 : 4.5;
    if (ratio < need) problems.push('文字「' + text.name + '」对比度 ' + ratio.toFixed(1) + ':1 低于 ' + need + ':1');
  }
  return problems;
}

function runBuild(recipeFile, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [workflow, 'build', recipeFile], { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('本地渲染超时')); }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Error('本地渲染失败：' + (stderr.trim().split('\n').slice(-3).join(' ').slice(-400) || 'exit ' + code)));
    });
  });
}

/** 生成一个模板单元：模型出配方 → 本地渲染 → 记录 creation.json。 */
export async function createTemplateUnit({ unit, llm, selection, build = runBuild, job }) {
  const directory = unit.directory;
  mkdirSync(directory, { recursive: true });
  const brief = unit.brief ?? {};
  const match = /^(\d{3,5})\s*[×x]\s*(\d{3,5})$/.exec(String(brief.canvas?.[0] ?? '').replace(/\s/g, ''));
  const canvas = match ? { w: Number(match[1]), h: Number(match[2]) } : { w: 1242, h: 1656 };
  if (!llm || typeof llm.stream !== 'function') throw Error('当前宿主没有可用的 LLM 服务');
  if (!selection?.provider || !selection?.model) throw Error('没有可用的默认模型');

  // 有分层素材计划时先走交接：没出图就明确停下等素材，不偷偷退回纯色块。
  const plan = buildAssetPlan({ unit, canvas });
  let generated = [];
  if (plan.length) {
    const request = readJson(assetRequestPath(directory)) ?? writeAssetRequest({ runDir: directory, unit, canvas, job });
    const checked = readAssetResponse({ runDir: directory, request });
    if (!checked.ok) {
      const waiting = Error('等待出图素材：' + checked.problems.slice(0, 3).join('；'));
      waiting.code = 'ASSETS_WAITING';
      waiting.request = request;
      waiting.problems = checked.problems;
      throw waiting;
    }
    generated = checked.assets;
  }
  const { system: sys, user } = buildRecipeRequest({ job: { topic: { name: brief.topic } }, unit, generated });
  const generatedById = new Map(generated.map(row => [row.id, row]));

  const ask = async (messages, systemText) => {
    let text = '';
    const seen = new Map();
    for await (const chunk of llm.stream({ provider: selection.provider, model: selection.model, system: systemText, messages, maxTokens: 8000, temperature: 0.5 })) {
      const type = chunk?.type ?? 'unknown';
      seen.set(type, (seen.get(type) ?? 0) + 1);
      if (type === 'text-delta') text += chunk.text ?? '';
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') throw Error(chunk.reason.failure?.message ?? 'model error');
    }
    if (!text.trim()) throw Error('模型没有返回内容（chunks: ' + JSON.stringify([...seen]) + '）');
    return text;
  };

  const first = await ask([{ role: 'user', content: [{ type: 'text', text: user }] }], sys);
  writeFileSync(join(directory, 'recipe-attempt-1.txt'), first);
  let recipe;
  try {
    recipe = normalizeRecipe(first, { canvas });
  } catch (error) {
    // 一次性修复：把有瑕疵的输出交回模型，只要求它补成合法 JSON。
    const repaired = await ask([{ role: 'user', content: [{ type: 'text', text: '下面的 JSON 有语法错误，请只输出修正后的完整 JSON，不要解释、不要省略字段：\n' + first.slice(0, 12000) }] }], sys);
    writeFileSync(join(directory, 'recipe-attempt-2.txt'), repaired);
    recipe = normalizeRecipe(repaired, { canvas });
  }
  recipe.topic = brief.topic ?? null;
  // 图像层引用的素材必须真实存在于运行目录，否则渲染出来是空图层。
  const missingImages = recipe.layers
    .filter(layer => layer.type === 'image')
    .filter(layer => !existsSync(join(directory, layer.source)));
  if (missingImages.length) throw Error('图像层素材缺失：' + missingImages.map(layer => layer.source).join('、'));
  const recipeFile = join(directory, 'release-recipe.json');
  writeFileSync(recipeFile, JSON.stringify(recipe, null, 2) + '\n');
  const result = await build(recipeFile);
  const preview = join(directory, 'release', 'preview.jpg');
  const marker = {
    schema: 1, kind: 'template', topic: brief.topic ?? null,
    canvas: recipe.canvas, title: recipe.title, description: recipe.description,
    recipe: recipeFile, preview: existsSync(preview) ? preview : null,
    layers: recipe.layers.length, texts: recipe.layers.filter(layer => layer.type === 'text').length,
    createdAt: new Date().toISOString(), status: 'complete'
  };
  writeFileSync(join(directory, 'creation.json'), JSON.stringify(marker, null, 2) + '\n');
  if (marker.preview) { try { copyFileSync(preview, join(directory, 'preview.jpg')); marker.previewLocal = join(directory, 'preview.jpg'); writeFileSync(join(directory, 'creation.json'), JSON.stringify({ ...marker, previewLocal: join(directory, 'preview.jpg') }, null, 2) + '\n'); } catch {} }
  return { marker, stdout: result.stdout };
}
