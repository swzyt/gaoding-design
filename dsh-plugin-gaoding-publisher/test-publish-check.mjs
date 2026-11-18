import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync  , existsSync} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRun, locate, checkMaterialRun, pngSize } from './publish-check.js';
import { createPublishTask, listPublishTasks, removePublishTask, listRuns as listRunsOf } from './jobs-store.js';

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function put(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** 构造一次“完全就绪”的运行，再按用例逐项破坏。 */
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-publish-'));
  const runDir = join(root, 'runs', 'run-1');
  const concept = join(runDir, 'build', 'concept');
  const release = join(concept, 'release');
  mkdirSync(release, { recursive: true });
  put(join(runDir, 'run.json'), { requested_topic: '测试话题', status: 'complete', stages: { native_creative: { state: 'done', result: concept } } });

  const recipe = {
    canvas: { w: 1242, h: 1656, dpi: 72 },
    output: 'release',
    layers: [
      { id: 'background', name: '背景-完整底色', type: options.rasterType ?? 'image', box: [0, 0, 1242, 1656], copyright_category: 'original' },
      { id: 'disc', name: '装饰-橘色圆', type: options.rasterType ?? 'image', box: [100, 100, 200, 200], copyright_category: 'original', ...(options.requireAlphaDisc ? { require_alpha: true, role: 'foreground' } : {}) },
      { id: 'title', name: '文案-主标题', type: 'text', text: '测试', box: [80, 300, 600, 120] }
    ],
    layer_audit: { pairs: [{ subject: '装饰-橘色圆', background: '背景-完整底色' }] }
  };
  put(join(concept, 'release-recipe.json'), recipe);
  put(join(release, 'recipe.json'), recipe);
  put(join(release, 'spec.json'), { canvas: recipe.canvas, layers: recipe.layers });
  put(join(release, 'bound-assets.json'), { assets: [] });
  put(join(release, 'layer-manifest.json'), [
    { name: '背景-完整底色', type: 'image', file: 'assets/background.png', alpha_range: [255, 255], sha256: 'a' },
    { name: '装饰-橘色圆', type: 'image', file: 'assets/disc.png', alpha_range: options.discAlpha ?? [0, 255], sha256: 'b' }
  ]);
  const evidenceFile = join(concept, 'evidence', 'shapes.png');
  put(evidenceFile, 'png-bytes');
  put(join(concept, 'copyright-evidence.json'), {
    categories: { original: [{ path: 'evidence/shapes.png', sha256: options.evidenceSha ?? sha(evidenceFile), layers: ['background', 'disc'] }] }
  });
  put(join(release, 'layer-audit', 'audit.json'), { status: 'complete', originals: { '装饰-橘色圆': 100, '背景-完整底色': 100 } });
  put(join(release, 'layer-audit', 'pair-1-subject-hidden.png'), 'shot');
  put(join(release, 'layer-audit', 'pair-1-background-hidden.png'), 'shot');
  put(join(release, 'layer-audit', 'restored-after-reload.png'), 'shot');
  put(join(runDir, 'gates', '04-final', 'request.json'), { token: 'tok-1' });
  put(join(runDir, 'gates', '04-final', 'response.json'), { passed: true, token: 'tok-1', checks: ['已看图'] });
  put(join(release, 'visual-review.json'), { passed: true, spec_sha256: sha(join(release, 'spec.json')) });
  put(join(release, 'material-review.json'), { passed: true, bindings_sha256: sha(join(release, 'bound-assets.json')) });
  return { root, runDir, concept, release, recipe };
}

function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

test('a complete run passes every publish check and exposes per-layer copyright', () => {
  const f = fixture();
  try {
    const report = checkRun(f.runDir);
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok)));
    assert.equal(report.checks.length, 14);
    const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
    assert.equal(byId.image_count.ok, true);
    assert.equal(byId.alpha.ok, true);
    assert.equal(byId.audit.ok, true);
    assert.equal(report.summary.images, 2);
    assert.equal(report.summary.texts, 1);
    const disc = report.layers.find(layer => layer.id === 'disc');
    assert.equal(disc.category, 'original');
    assert.equal(disc.alphaOk, true);
    assert.equal(disc.audited, true);
    const background = report.layers.find(layer => layer.id === 'background');
    assert.equal(background.background, true);
    assert.equal(locate(f.runDir).release, f.release);
  } finally { cleanup(f.root); }
});

test('program-drawn shape layers count as image layers and full-bleed backgrounds need no alpha', () => {
  const f = fixture({ rasterType: 'shape' });
  try {
    const report = checkRun(f.runDir);
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok)));
    assert.equal(report.summary.images, 2, 'shape layers are raster layers too');
    const background = report.layers.find(layer => layer.id === 'background');
    assert.equal(background.background, true);
    assert.equal(background.alphaOk, null, 'a full-bleed background is not required to have transparency');
    const disc = report.layers.find(layer => layer.id === 'disc');
    assert.equal(disc.alphaOk, true);
  } finally { cleanup(f.root); }
});

test('missing evidence coverage and unseparated layers fail the gate', () => {
  const f = fixture({ discAlpha: [255, 255], requireAlphaDisc: true });
  try {
    put(join(f.concept, 'copyright-evidence.json'), { categories: { original: [{ path: 'evidence/shapes.png', sha256: sha(join(f.concept, 'evidence', 'shapes.png')), layers: ['background'] }] } });
    const report = checkRun(f.runDir);
    assert.equal(report.ok, false);
    const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
    assert.equal(byId.image_count.ok, false, 'a picture layer without evidence must fail');
    assert.equal(byId.evidence_coverage.ok, false);
    assert.match(byId.image_count.detail, /未覆盖：disc/);
    assert.equal(byId.alpha.ok, false, 'a foreground layer without transparent pixels must fail');
    assert.equal(report.layers.find(layer => layer.id === 'disc').alphaOk, false);
  } finally { cleanup(f.root); }
});

test('separation contracts must map every object to its own layer', () => {
  const f = fixture({ requireAlphaDisc: true });
  try {
    put(join(f.concept, 'separation-contract.json'), { schema_version: 1, objects: [{ id: 'cup-a', layer_id: 'disc', role: 'foreground', require_alpha: true }] });
    let report = checkRun(f.runDir);
    assert.equal(report.checks.find(check => check.id === 'contract').ok, true);

    put(join(f.concept, 'separation-contract.json'), { schema_version: 1, objects: [{ id: 'cup-a', layer_id: 'disc' }, { id: 'cup-b', layer_id: 'disc' }] });
    report = checkRun(f.runDir);
    assert.equal(report.checks.find(check => check.id === 'contract').ok, false, 'two objects cannot share one layer');
    assert.match(report.checks.find(check => check.id === 'contract').detail, /共用图层/);

    put(join(f.concept, 'separation-contract.json'), { schema_version: 1, objects: [{ id: 'cup-a', layer_id: 'missing' }] });
    report = checkRun(f.runDir);
    assert.equal(report.checks.find(check => check.id === 'contract').ok, false);
    assert.match(report.checks.find(check => check.id === 'contract').detail, /不存在/);
  } finally { cleanup(f.root); }
});

test('tampered evidence files and stale reviews are rejected', () => {
  const f = fixture();
  try {
    put(join(f.concept, 'evidence', 'shapes.png'), 'changed-bytes');
    put(join(f.release, 'spec.json'), { canvas: { w: 1242, h: 1656 }, layers: [] });
    const report = checkRun(f.runDir);
    const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
    assert.equal(byId.evidence_files.ok, false);
    assert.match(byId.evidence_files.detail, /哈希不符/);
    assert.equal(byId.reviews.ok, false, 'a review whose file hash no longer matches is stale');
  } finally { cleanup(f.root); }
});

test('missing hide-audit evidence and a published run block publishing', () => {
  const f = fixture();
  try {
    rmSync(join(f.release, 'layer-audit', 'pair-1-subject-hidden.png'));
    put(join(f.release, 'publication.json'), { published: true, stage: 'verified' });
    const report = checkRun(f.runDir);
    const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
    assert.equal(byId.audit.ok, false);
    assert.equal(byId.not_published.ok, false);
    assert.equal(report.ok, false);
  } finally { cleanup(f.root); }
});

test('publish tasks require a passing run and track real submission stages', () => {
  const f = fixture();
  try {
    const report = checkRun(f.runDir);
    const dataRoot = f.root;
    const created = createPublishTask({ dataRoot, runDir: f.runDir, summary: report.summary, now: new Date('2026-11-17T12:00:00.000Z') });
    assert.equal(created.reused, false);
    assert.equal(created.task.status, 'queued');
    assert.ok(created.task.instruction.includes(f.runDir));
    assert.ok(created.task.instruction.includes('2 个图片层'), 'the instruction restates the layer count for copyright');

    const again = createPublishTask({ dataRoot, runDir: f.runDir, summary: report.summary });
    assert.equal(again.reused, true, 'one run cannot produce two publish tasks');

    put(join(f.release, 'publication.json'), { stage: 'submission-started', submissionStartedAt: '2026-11-17T12:01:00.000Z' });
    assert.equal(listPublishTasks(dataRoot)[0].status, 'uncertain');
    assert.throws(() => removePublishTask(dataRoot, created.task.id), /已经开始投稿/);

    put(join(f.release, 'publication.json'), { stage: 'verified', published: true });
    assert.equal(listPublishTasks(dataRoot)[0].status, 'published');
    assert.throws(() => createPublishTask({ dataRoot, runDir: f.runDir, summary: report.summary }), /已经创建过投稿任务/);
  } finally { cleanup(f.root); }
});

test('publish task creation refuses incomplete summaries and unsafe ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-publish-store-'));
  try {
    assert.throws(() => createPublishTask({ dataRoot: root, runDir: join(root, 'runs', 'x'), summary: {} }), /缺少发布目录/);
    assert.throws(() => removePublishTask(root, '../escape'), /Invalid publish task id/);
  } finally { cleanup(root); }
});

/** 构造一个只有文件头合法的 PNG：足以校验尺寸与 alpha 通道类型。 */
function craftPng(w, h, colorType = 6) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(colorType, 25);
  return head;
}

test('material runs are checked on size, transparency and hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-material-'));
  try {
    const asset = join(root, 'asset.png');
    mkdirSync(root, { recursive: true });
    writeFileSync(asset, craftPng(2000, 2000, 6));
    assert.deepEqual(pngSize(asset), { w: 2000, h: 2000, colorType: 6 });
    put(join(root, 'material.json'), {
      schema: 1, topic: '特效系列光效素材', canvas: { w: 2000, h: 2000 }, asset: 'asset.png',
      sha256: sha(asset), alpha: true, alpha_range: [0, 255], createdAt: '2026-11-17T12:00:00.000Z'
    });
    let report = checkRun(root);
    assert.equal(report.kind, 'material');
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok)));
    assert.equal(report.summary.canvas.w, 2000);

    // 尺寸不符
    writeFileSync(asset, craftPng(1620, 2880, 6));
    put(join(root, 'material.json'), { schema: 1, topic: 'x', canvas: { w: 2000, h: 2000 }, asset: 'asset.png', sha256: sha(asset), alpha: true, alpha_range: [0, 255] });
    report = checkRun(root);
    assert.equal(report.checks.find(check => check.id === 'asset_size').ok, false);

    // 记录过哈希后文件被改
    const recorded = sha(asset);
    writeFileSync(asset, craftPng(1620, 2880, 6));
    put(join(root, 'material.json'), { schema: 1, topic: 'x', canvas: { w: 1620, h: 2880 }, asset: 'asset.png', sha256: recorded, alpha: false });
    writeFileSync(asset, Buffer.concat([craftPng(1620, 2880, 6), Buffer.from('extra')]));
    report = checkRun(root);
    assert.equal(report.checks.find(check => check.id === 'asset_sha').ok, false);

    // 贴纸缺 alpha 通道
    writeFileSync(asset, craftPng(2000, 2000, 2));
    put(join(root, 'material.json'), { schema: 1, topic: 'x', canvas: { w: 2000, h: 2000 }, asset: 'asset.png', sha256: sha(asset), alpha: true, alpha_range: [0, 255] });
    report = checkRun(root);
    assert.equal(report.checks.find(check => check.id === 'asset_alpha').ok, false);
    assert.match(report.checks.find(check => check.id === 'asset_alpha').detail, /alpha 通道/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('material runs appear in the result list without a run.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-material-list-'));
  try {
    const unit = join(root, 'runs', 'mat-1');
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(unit, 'asset.png'), craftPng(1620, 2880, 6));
    put(join(unit, 'material.json'), { schema: 1, topic: '美妆个护上新背景', canvas: { w: 1620, h: 2880 }, asset: 'asset.png', sha256: sha(join(unit, 'asset.png')), alpha: false, createdAt: '2026-11-17T12:00:00.000Z' });
    const runs = listRunsOf(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].kind, 'material');
    assert.equal(runs[0].topic, '美妆个护上新背景');
    assert.ok(runs[0].preview.endsWith('asset.png'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('material runs can create a publish task without a template recipe', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-material-pub-'));
  try {
    const unit = join(root, 'runs', 'mat-pub');
    mkdirSync(unit, { recursive: true });
    const asset = join(unit, 'asset.png');
    writeFileSync(asset, craftPng(2000, 2000, 6));
    put(join(unit, 'material.json'), { schema: 1, topic: '特效系列光效素材', canvas: { w: 2000, h: 2000 }, asset: 'asset.png', sha256: sha(asset), alpha: true, alpha_range: [0, 255] });
    const report = checkRun(unit);
    assert.equal(report.ok, true);
    const created = createPublishTask({ dataRoot: root, runDir: unit, summary: report.summary });
    assert.equal(created.task.kind, 'material');
    assert.match(created.task.instruction, /发布为「素材」|发布类型选「素材」/);
    assert.match(created.task.instruction, /SSO 登录态/);
    assert.match(created.task.instruction, /本地上传/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 插件自建模板稿：没有 run.json，也不能用原生工作流的门禁去卡它。
test('plugin-created template runs are checked by their real artifacts', async () => {
  const { checkRun } = await import('./publish-check.js');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'gaoding-plugin-template-'));
  const release = join(root, 'release');
  mkdirSync(join(release, 'assets'), { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  writeFileSync(join(release, 'assets', 'background.png'), png);
  writeFileSync(join(release, 'template.psd'), 'psd');
  writeFileSync(join(release, 'preview.jpg'), 'jpg');
  const sha = createHash('sha256').update(png).digest('hex');
  writeFileSync(join(release, 'layer-manifest.json'), JSON.stringify([
    { name: '背景', type: 'shape', file: 'assets/background.png', alpha_range: [255, 255], sha256: sha },
    { name: '主标题', type: 'editable_text', text: '标题' }
  ]));
  writeFileSync(join(root, 'creation.json'), JSON.stringify({ kind: 'template', status: 'complete', topic: '小红书备忘录', title: '职场就业备忘录', description: '描述', canvas: { w: 100, h: 100 } }));
  const recipe = {
    canvas: { w: 100, h: 100 }, topic: '小红书备忘录', title: '标题', description: '描述',
    layers: [
      { id: 'bg', name: '背景', type: 'shape', box: [0, 0, 100, 100], color: [255, 255, 255], copyright_category: 'original' },
      { id: 't1', name: '主标题', type: 'text', text: '标题', box: [10, 10, 80, 20], font: 'STHeitiSC-Medium', gd_font: '思源黑体 Medium' }
    ]
  };
  writeFileSync(join(root, 'release-recipe.json'), JSON.stringify(recipe));

  const pass = checkRun(root);
  assert.equal(pass.ok, true, JSON.stringify(pass.checks.filter(c => !c.ok)));
  assert.equal(pass.kind, 'template');
  assert.equal(pass.summary.plugin, true);
  assert.equal(pass.summary.recipe, join(root, 'release-recipe.json'));
  assert.ok(pass.summary.description);

  // 越界图层
  writeFileSync(join(root, 'release-recipe.json'), JSON.stringify({ ...recipe, layers: [recipe.layers[0], { ...recipe.layers[1], box: [90, 10, 80, 20] }] }));
  assert.equal(checkRun(root).ok, false);

  // 来源可声明的图片层（AI 生成）允许投稿
  writeFileSync(join(release, 'assets', 'ai.png'), png);
  const aiRecipe = { ...recipe, layers: [recipe.layers[0], { ...recipe.layers[1], type: 'image', source: 'assets/ai.png', copyright_category: 'original_ai' }] };
  writeFileSync(join(root, 'release-recipe.json'), JSON.stringify(aiRecipe));
  writeFileSync(join(release, 'layer-manifest.json'), JSON.stringify([
    { name: '背景', type: 'shape', file: 'assets/background.png', alpha_range: [255, 255], sha256: sha },
    { name: '主标题', type: 'image', file: 'assets/ai.png', alpha_range: [0, 255], sha256: sha }
  ]));
  const aiRun = checkRun(root);
  assert.ok(aiRun.checks.some(check => check.id === 'sources' && check.ok === true), JSON.stringify(aiRun.checks));

  // 来源不明（外部素材）的图片层必须被拦截
  writeFileSync(join(root, 'release-recipe.json'), JSON.stringify({ ...recipe, layers: [recipe.layers[0], { ...recipe.layers[1], type: 'image', source: 'assets/ai.png', copyright_category: 'risk' }] }));
  const external = checkRun(root);
  assert.equal(external.ok, false);
  assert.ok(external.checks.some(check => check.id === 'sources' && check.ok === false));

  // 清单文件哈希被改动
  writeFileSync(join(root, 'release-recipe.json'), JSON.stringify(recipe));
  writeFileSync(join(release, 'assets', 'background.png'), Buffer.from('deadbeef', 'hex'));
  assert.equal(checkRun(root).ok, false);
});

test('plugin template publish task carries its own instruction, not the native gate one', async () => {
  const { createPublishTask, listPublishTasks } = await import('./jobs-store.js');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataRoot = mkdtempSync(join(tmpdir(), 'gaoding-plugin-task-'));
  const runDir = join(dataRoot, 'runs', 'run-1');
  mkdirSync(join(runDir, 'release'), { recursive: true });
  writeFileSync(join(runDir, 'release-recipe.json'), '{}');
  const { task, reused } = createPublishTask({
    dataRoot, runDir,
    summary: { topic: '小红书备忘录', kind: 'template', plugin: true, canvas: { w: 100, h: 100 }, images: 2, texts: 3, concept: runDir, release: join(runDir, 'release'), recipe: join(runDir, 'release-recipe.json') }
  });
  assert.equal(reused, false);
  assert.equal(task.kind, 'template');
  assert.match(task.instruction, /导入编辑器|编辑器内/);
  assert.ok(!/browser-batch/.test(task.instruction), '插件模板稿不应要求原生门禁命令');
  assert.equal(listPublishTasks(dataRoot).length, 1);
});

test('a published material run reports published status instead of a failed check', async () => {
  const { mkdtempSync, writeFileSync, copyFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'check-published-'));
  const dataRoot = process.env.DSH_GAODING_DATA || join(homedir(), '.local/share/dsh-gaoding-publisher');
  const run = join(dataRoot, 'runs/job-20261117131049-47c70f-99fc07-3');
  if (!existsSync(run)) return;
  for (const name of ['material.json', 'publication.json', 'asset.png']) copyFileSync(join(run, name), join(dir, name));
  writeFileSync(join(dir, 'marker'), '');
  const { checkRun } = await import('./publish-check.js');
  const result = checkRun(dir);
  assert.equal(result.published, true);
  assert.equal(result.status, 'published');
  const row = result.checks.find(check => check.id === 'not_published');
  assert.match(row.label, /已投稿/);
  assert.match(row.detail, /202456591/);
});
