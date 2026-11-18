import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipe, buildRecipeRequest } from './template-recipe.js';

const canvas = { w: 1242, h: 1656 };

test('model recipes are normalized into a renderable layered template', () => {
  const output = JSON.stringify({
    title: '测试模板',
    description: '说明',
    layers: [
      { id: 'bg', type: 'shape', name: '背景', box: [0, 0, 1242, 1656], color: [250, 248, 244] },
      { id: 'title', type: 'text', name: '主标题', text: '你好世界', box: [80, 200, 1000, 200], size: 96, color: [20, 20, 30], align: 'center' },
      { id: 'bad', type: 'text', name: '越界', text: '越界框', box: [1200, 1600, 500, 500], size: 3 }
    ]
  });
  const recipe = normalizeRecipe(output, { canvas });
  assert.equal(recipe.canvas.w, 1242);
  assert.equal(recipe.layers[0].id, 'background', 'a full-canvas background is always first');
  assert.deepEqual(recipe.layers[0].box, [0, 0, 1242, 1656]);
  const title = recipe.layers.find(layer => layer.id === 'title');
  assert.equal(title.type, 'text');
  assert.equal(title.font, 'STHeitiSC-Medium');
  assert.equal(title.preview_font, '/System/Library/Fonts/STHeiti Medium.ttc');
  assert.equal(title.gd_font, '思源黑体 Medium');
  assert.ok(title.box[0] + title.box[2] <= 1242, 'boxes are clamped into the canvas');
  const clamped = recipe.layers.find(layer => layer.id === 'bad');
  assert.ok(clamped.size >= 12, 'font size is clamped to a legible minimum');
  // 只有纯底色 + 文字时没有「主体层」，审计对为空是正确的；有主体层才必须成对。
  assert.equal(recipe.layer_audit.pairs.length, 0);
});

test('recipes without text layers or JSON are rejected', () => {
  assert.throws(() => normalizeRecipe('这不是 JSON', { canvas }), /没有返回配方 JSON/);
  assert.throws(() => normalizeRecipe(JSON.stringify({ layers: [{ id: 'bg', type: 'shape' }] }), { canvas }), /没有原生文字层/);
  assert.throws(() => normalizeRecipe(JSON.stringify({ layers: [] }), { canvas }), /没有图层/);
});

test('the recipe request carries the confirmed prompt and canvas', () => {
  const job = { topic: { name: '小红书大字封面' }, note: '清爽' };
  const unit = { brief: { topic: '小红书大字封面', canvas: ['1242×1656'] }, prompt: { prompt: '米白背景，深墨大字' } };
  const request = buildRecipeRequest({ job, unit });
  assert.match(request.user, /米白背景，深墨大字/);
  assert.match(request.user, /1242×1656/);
  assert.match(request.system, /原生可编辑|type:"text"/);
});

test('every layer box stays fully inside the canvas', async () => {
  const { normalizeRecipe } = await import('./template-recipe.js');
  const recipe = normalizeRecipe(JSON.stringify({
    layers: [
      { id: 'background', name: '底色', type: 'shape', box: [0, 0, 1242, 1656], color: [246, 244, 239] },
      { id: 'l5', name: '越界块', type: 'shape', box: [1000, 1400, 320, 320], color: [200, 100, 50] },
      { id: 'l6', name: '贴边块', type: 'shape', box: [-40, -30, 300, 200], color: [10, 20, 30] },
      { id: 't1', name: '标题', type: 'text', box: [1180, 1600, 400, 120], text: '标题', size: 48 }
    ]
  }), { canvas: { w: 1242, h: 1656 } });
  for (const layer of recipe.layers) {
    const [x, y, w, h] = layer.box;
    assert.ok(x >= 0 && y >= 0, layer.id + ' 起点越界');
    assert.ok(x + w <= 1242 + 0.01 && y + h <= 1656 + 0.01, layer.id + ' 终点越界: ' + JSON.stringify(layer.box));
  }
});

test('image layers are accepted, text stays on top and decorations may not cover text', async () => {
  const { normalizeRecipe, decorationCollisions } = await import('./template-recipe.js');
  const base = {
    title: '图像层模板', description: '测试',
    layers: [
      { id: 'bg', name: '背景', type: 'image', source: 'generated/bg.png', role: 'background', box: [0, 0, 1242, 1656] },
      { id: 'card', name: '卡片', type: 'image', source: 'generated/card.png', role: 'container', require_alpha: true, box: [100, 400, 900, 900] },
      { id: 'sheep', name: '吉祥物', type: 'image', source: 'generated/sheep.png', role: 'subject', require_alpha: true, box: [700, 1000, 400, 520] },
      { id: 't1', name: '标题', type: 'text', box: [120, 150, 900, 120], text: '羊年新春', size: 96 },
      { id: 't2', name: '正文', type: 'text', box: [150, 520, 700, 60], text: '全部可编辑', size: 36 }
    ]
  };
  const recipe = normalizeRecipe(JSON.stringify(base), { canvas: { w: 1242, h: 1656 } });
  const types = recipe.layers.map(layer => layer.type);
  assert.ok(types.includes('image'), '图像层应保留');
  // 文字必须全部排在最后
  const firstText = recipe.layers.findIndex(layer => layer.type === 'text');
  assert.ok(recipe.layers.slice(firstText).every(layer => layer.type === 'text'), '文字层必须在最上层');
  assert.equal(decorationCollisions(recipe.layers).length, 0);

  // 纯色装饰块会被直接丢弃（避免像渲染错误的色块）
  const withDecoration = JSON.parse(JSON.stringify(base));
  withDecoration.layers.push({ id: 'line', name: '装饰线', type: 'shape', role: 'decoration', box: [120, 160, 900, 40], color: [0, 0, 0] });
  const cleaned = normalizeRecipe(JSON.stringify(withDecoration), { canvas: { w: 1242, h: 1656 } });
  assert.ok(!cleaned.layers.some(layer => layer.id === 'line'), '纯色装饰层应被丢弃');

  // 图像装饰压文字 → 仍然拒绝（图像装饰是允许的，但不得盖字）
  const badImage = JSON.parse(JSON.stringify(base));
  badImage.layers.push({ id: 'deco', name: '贴纸', type: 'image', source: 'generated/deco.png', role: 'decoration', box: [120, 160, 300, 300] });
  assert.throws(() => normalizeRecipe(JSON.stringify(badImage), { canvas: { w: 1242, h: 1656 } }), /压到文字/);
});

test('image layer sources must stay inside the run directory', async () => {
  const { normalizeRecipe } = await import('./template-recipe.js');
  const recipe = normalizeRecipe(JSON.stringify({
    layers: [
      { id: 'bg', name: '背景', type: 'shape', box: [0, 0, 1242, 1656], color: [250, 250, 250] },
      { id: 'evil', name: '越权', type: 'image', source: '../outside.png', box: [0, 0, 100, 100] },
      { id: 'abs', name: '绝对路径', type: 'image', source: '/tmp/x.png', box: [0, 0, 100, 100] },
      { id: 't1', name: '标题', type: 'text', box: [100, 100, 800, 100], text: '标题', size: 60 }
    ]
  }), { canvas: { w: 1242, h: 1656 } });
  const images = recipe.layers.filter(layer => layer.type === 'image');
  assert.equal(images.length, 0, '越权路径的图像层必须被丢弃');
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAssetRequest, readAssetResponse, assetState, buildAssetPlan } from './asset-handoff.js';

function pngWithAlpha(file, w = 1024, h = 1024, colorType = 6) {
  // 最小合法 PNG 头：签名 + IHDR（不需要真实像素，只验证解析与哈希）
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(colorType, 17);
  const body = Buffer.concat([signature, ihdr]);
  writeFileSync(file, body);
  return createHash('sha256').update(body).digest('hex');
}

test('asset handoff writes a request, validates the agent response, and blocks bad files', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'asset-handoff-'));
  const unit = {
    id: 'u1', directory: runDir,
    prompt: {
      topic: '羊年新春活动有好戏', title: '羔羊贺岁',
      layers: [{ id: 'bg-paper', role: 'background' }, { id: 'mascot', role: 'subject', require_alpha: true }],
      assets: [
        { id: 'bg-paper', prompt: '奶油米白纸张纹理背景' },
        { id: 'mascot', prompt: '3D 黏土小羊吉祥物，透明背景' }
      ]
    }
  };
  const canvas = { w: 1242, h: 1656 };
  const plan = buildAssetPlan({ unit, canvas });
  assert.equal(plan.length, 2);
  assert.equal(plan.find(row => row.id === 'bg-paper').require_alpha, false, '背景不需要透明');
  assert.equal(plan.find(row => row.id === 'mascot').require_alpha, true, '主体需要透明');

  const request = writeAssetRequest({ runDir, unit, canvas });
  assert.equal(request.assets.length, 2);
  assert.equal(assetState({ runDir, unit, canvas }).state, 'waiting', '没有回执时是等待状态');

  // Agent 回执：一张透明底主体 + 一张背景
  mkdirSync(join(runDir, 'generated'), { recursive: true });
  const bgSha = pngWithAlpha(join(runDir, 'generated', 'bg-paper.png'), 1242, 1656, 2);
  const mascotSha = pngWithAlpha(join(runDir, 'generated', 'mascot.png'), 1024, 1024, 6);
  writeFileSync(join(runDir, 'generated-assets', 'response.json'), JSON.stringify({
    schema: 1, token: request.token, provider: 'chatgpt-sub', model: 'gpt-image-2.6-flare',
    assets: [
      { id: 'bg-paper', path: 'generated/bg-paper.png', sha256: bgSha, width: 1242, height: 1656, hasAlpha: false },
      { id: 'mascot', path: 'generated/mascot.png', sha256: mascotSha, width: 1024, height: 1024, hasAlpha: true }
    ]
  }));
  const checked = readAssetResponse({ runDir, request });
  assert.equal(checked.ok, true, checked.problems.join('；'));
  assert.equal(checked.assets.length, 2);
  assert.equal(assetState({ runDir, unit, canvas }).state, 'ready');

  // 回执被篡改（哈希不符）→ 拒绝
  const bad = JSON.parse(readFileSync(join(runDir, 'generated-assets', 'response.json'), 'utf8'));
  bad.assets[0].sha256 = 'deadbeef';
  writeFileSync(join(runDir, 'generated-assets', 'response.json'), JSON.stringify(bad));
  assert.match(readAssetResponse({ runDir, request }).problems.join(), /哈希与回执不符/);

  // 主体缺 alpha → 拒绝
  const noAlpha = pngWithAlpha(join(runDir, 'generated', 'mascot.png'), 1024, 1024, 2);
  bad.assets[0].sha256 = bgSha;
  bad.assets[1] = { id: 'mascot', path: 'generated/mascot.png', sha256: noAlpha };
  writeFileSync(join(runDir, 'generated-assets', 'response.json'), JSON.stringify(bad));
  assert.match(readAssetResponse({ runDir, request }).problems.join(), /没有 alpha 通道/);

  // 越界路径 → 拒绝
  writeFileSync(join(runDir, 'generated-assets', 'response.json'), JSON.stringify({
    ...bad, assets: [{ id: 'bg-paper', path: '../escape.png', sha256: bgSha }, bad.assets[1]]
  }));
  assert.match(readAssetResponse({ runDir, request }).problems.join(), /越出运行目录|不存在/);
});

test('layout gates reject oversized subjects, full-canvas decorations and unsafe text', async () => {
  const { normalizeRecipe, layoutProblems } = await import('./template-recipe.js');
  const canvas = { w: 1242, h: 1656 };
  // 主体铺满画布 → 拒绝
  assert.throws(() => normalizeRecipe(JSON.stringify({
    layers: [
      { id: 'bg', type: 'image', source: 'generated/bg.png', role: 'background', box: [0, 0, 1242, 1656] },
      { id: 'hero', type: 'image', source: 'generated/hero.png', role: 'subject', require_alpha: true, box: [0, 0, 1242, 1656] },
      { id: 't1', name: '标题', type: 'text', box: [100, 100, 900, 120], text: '标题', size: 80 }
    ]
  }), { canvas }), /面积超过画布 35%|压到文字/);

  // 背景没铺满 → 拒绝
  assert.throws(() => normalizeRecipe(JSON.stringify({
    layers: [
      { id: 'bg', type: 'image', source: 'generated/bg.png', role: 'background', box: [0, 0, 600, 600] },
      { id: 't1', name: '标题', type: 'text', box: [100, 100, 900, 120], text: '标题', size: 80 }
    ]
  }), { canvas }), /没有铺满画布/);

  // 直接调用检查函数：装饰过大
  const problems = layoutProblems([
    { type: 'image', role: 'decoration', name: '超大装饰图', box: [0, 0, 1242, 1656] },
    { type: 'text', name: '标题', box: [100, 100, 800, 100] }
  ], canvas);
  // 纯色装饰不参与渲染（归一化时丢弃）；图像装饰只拦「铺满画布」这种极端情况
  assert.ok(problems.some(row => row.includes('装饰图「超大装饰图」面积超过画布 45%')));
});

test('contrast, type scale and size floors are enforced', async () => {
  const { layoutProblems, contrastRatio } = await import('./template-recipe.js');
  const canvas = { w: 1242, h: 1656 };
  assert.ok(contrastRatio([0, 0, 0], [255, 255, 255]) > 20);
  const base = [
    { type: 'shape', role: 'background', name: '底色', box: [0, 0, 1242, 1656], color: [250, 248, 244] }
  ];
  // 浅灰大字压浅底 → 对比度不足
  const lowContrast = [...base, { type: 'text', name: '标题', box: [100, 100, 900, 120], size: 96, color: [200, 198, 194] }];
  assert.ok(layoutProblems(lowContrast, canvas).some(row => row.includes('对比度')));

  // 字号太小
  const tiny = [...base, { type: 'text', name: '注释', box: [100, 1400, 400, 40], size: 14, color: [20, 20, 20] }];
  assert.ok(layoutProblems(tiny, canvas).some(row => row.includes('字号小于 24')));

  // 主次层级不足：标题与正文几乎同号
  const flat = [...base,
    { type: 'text', name: '标题', box: [100, 100, 900, 120], size: 60, color: [20, 20, 20] },
    { type: 'text', name: '正文', box: [100, 300, 900, 80], size: 50, color: [40, 40, 40] }];
  assert.ok(layoutProblems(flat, canvas).some(row => row.includes('层级不清晰')));

  // 层级清晰、对比够的稿子应当没有问题
  const good = [...base,
    { type: 'text', name: '标题', box: [100, 100, 900, 160], size: 96, color: [25, 30, 40] },
    { type: 'text', name: '正文', box: [100, 320, 900, 80], size: 36, color: [60, 66, 76] }];
  assert.deepEqual(layoutProblems(good, canvas), []);
});
