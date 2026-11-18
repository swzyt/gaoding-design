import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { refForText, lastRefForText, buildTemplatePublishScript, publishTemplate } from './template-publish.js';

const snapshot = ['button [ref=1]', 'text "发布"', 'textfield "描述" [ref=2]', 'button [ref=3]', 'text "发布"'];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const base = { designUrl: 'https://www.gaoding.com/editor/design?id=1', description: 'description', topic: 'topic', space: 3, submit: true, declare: true };
function fixture(t) {
  const runDir = mkdtempSync(join(tmpdir(), 'template-publish-test-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  return { ...base, runDir, preflightDeclaration: async () => ({ evidence: 'validated' }), completeDeclaration: async ({ content }) => ({ verified: true, reopened: true, submitted: true, contentId: content.id }) };
}
function mockSpawn(result, inspect = () => {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.end = script => queueMicrotask(() => {
      inspect(script);
      if (result === null) return;
      child.stdout.emit('data', 'GAODING_TEMPLATE_PUBLISH:' + JSON.stringify(result) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
}
const neverSpawn = () => { throw Error('browser must not launch'); };

test('refs resolve by role and nearest matching text', () => {
  assert.equal(refForText(snapshot, 'textfield "描述"'), '@2');
  assert.equal(lastRefForText(snapshot, 'text "发布"'), '@3');
  assert.equal(refForText(snapshot, 'missing'), null);
});

test('script owns dedicated pages, journals before submit and retains ID before verification', () => {
  const script = buildTemplatePublishScript({ ...base, shots: {}, journal: { path: '/tmp/journal', value: {} }, publicationPath: '/tmp/publication' });
  // 声明步骤只在真实提交且有计划时生成；演练脚本里不能出现声明与固定页。
  assert.doesNotMatch(script, /space\.page\('p1'\)|ugc-copyright|声明并发布/);
  assert.match(script, /p = await space.newPage\(\)/);
  assert.match(script, /finally \{[\s\S]*page.close\(\)/);
  assert.ok(script.indexOf("saveResult({ ok: false, submissionStarted: true") < script.indexOf("label: 'publish template'"));
  assert.ok(script.indexOf('published: true, content, steps') < script.indexOf("await verify.goto('https://gd.huaban.com/my/publish/'"));
  assert.match(script, /taskSpace\(3\)/);
  assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)('taskSpace', script));
});

test('dry run bypasses declaration preflight and creates no submission journal', async t => {
  const options = fixture(t);
  const result = await publishTemplate({ ...options, submit: false, preflightDeclaration: () => { throw Error('must not preflight'); }, spawnProcess: mockSpawn({ ok: true, dryRun: true }) });
  assert.equal(result.dryRun, true);
  assert.equal(existsSync(join(options.runDir, 'publish/submission-attempt.json')), false);
});

test('evidence failure prevents any browser or submission journal', async t => {
  const options = fixture(t);
  await assert.rejects(publishTemplate({ ...options, preflightDeclaration: () => { throw Error('missing authentic evidence'); }, spawnProcess: neverSpawn }), /authentic evidence/);
  assert.equal(existsSync(join(options.runDir, 'publish/submission-attempt.json')), false);
});

test('first publication persists pending ID before declaration and completes only with strict verification', async t => {
  const options = fixture(t);
  const result = await publishTemplate({ ...options, spawnProcess: mockSpawn({ ok: true, content: { id: '42' } }, () => {
    assert.equal(read(join(options.runDir, 'publish/submission-attempt.json')).stage, 'submission-started');
  }), completeDeclaration: async args => {
    assert.equal(args.space, 3);
    assert.equal(read(join(options.runDir, 'publication.json')).contentId, '42');
    assert.equal(read(join(options.runDir, 'publication.json')).stage, 'pending-declaration');
    return { verified: true, reopened: true, submitted: true, contentId: '42' };
  } });
  assert.equal(result.ok, true);
  assert.equal(read(join(options.runDir, 'publish/submission-attempt.json')).stage, 'verified');
});

test('declaration failure retains ID and retry restores it without publishing', async t => {
  const options = fixture(t);
  await assert.rejects(publishTemplate({ ...options, spawnProcess: mockSpawn({ ok: true, content: { id: '42' } }), completeDeclaration: async () => { throw Error('evidence rejected'); } }), /evidence rejected/);
  assert.equal(read(join(options.runDir, 'publication.json')).contentId, '42');
  const result = await publishTemplate({ ...options, spawnProcess: neverSpawn });
  assert.equal(result.content.id, '42');
  assert.equal(result.declaration.verified, true);
});

test('legacy published template cannot return success without reopened declaration proof', async t => {
  const options = fixture(t);
  writeFileSync(join(options.runDir, 'publication.json'), JSON.stringify({ kind: 'template', published: true, contentId: '42' }));
  for (const declaration of [{ submitted: true }, { verified: true, reopened: true, submitted: true, contentId: '43' }]) {
    await assert.rejects(publishTemplate({ ...options, spawnProcess: neverSpawn, completeDeclaration: async () => declaration }), /重开核验/);
  }
});

test('failure without ID leaves needs-reconciliation and blocks retry even with a new evidenceDir', async t => {
  const options = fixture(t);
  await assert.rejects(publishTemplate({ ...options, spawnProcess: mockSpawn({ ok: false, error: 'interrupted' }) }), /interrupted/);
  assert.equal(read(join(options.runDir, 'publish/submission-attempt.json')).stage, 'needs-reconciliation');
  await assert.rejects(publishTemplate({ ...options, evidenceDir: join(options.runDir, 'other-shots'), spawnProcess: neverSpawn }), /先对账/);
});

test('timeout keeps process logs and journal and cannot resubmit', async t => {
  const options = fixture(t);
  await assert.rejects(publishTemplate({ ...options, timeout: 5, spawnProcess: mockSpawn(null) }), /超时/);
  const journal = read(join(options.runDir, 'publish/submission-attempt.json'));
  assert.equal(journal.stage, 'needs-reconciliation');
  assert.match(journal.result.error, /超时/);
  await assert.rejects(publishTemplate({ ...options, spawnProcess: neverSpawn }), /先对账/);
});

test('browser-persisted ID survives missing process result and resumes without submission', async t => {
  const options = fixture(t);
  await assert.rejects(publishTemplate({ ...options, timeout: 5, spawnProcess: mockSpawn(null, () => {
    const path = join(options.runDir, 'publish/submission-attempt.json');
    writeFileSync(path, JSON.stringify({ ...read(path), result: { content: { id: '42' }, published: true } }));
  }) }), /超时/);
  assert.equal(read(join(options.runDir, 'publication.json')).contentId, '42');
  assert.equal((await publishTemplate({ ...options, spawnProcess: neverSpawn })).content.id, '42');
});

test('uncertain prior publication and conflicting IDs require reconciliation', async t => {
  const options = fixture(t);
  await assert.rejects(publishTemplate({ ...options, priorPublication: { published: true }, spawnProcess: neverSpawn }), /先对账/);
  mkdirSync(join(options.runDir, 'publish'), { recursive: true });
  writeFileSync(join(options.runDir, 'publish/submission-attempt.json'), JSON.stringify({ result: { content: { id: '43' } } }));
  await assert.rejects(publishTemplate({ ...options, priorPublication: { contentId: '42' }, spawnProcess: neverSpawn }), /ID 冲突/);
});

test('invalid URL and missing declaration fail before browser', async () => {
  await assert.rejects(publishTemplate({ ...base, designUrl: 'https://example.com/editor/design' }), /编辑器作品地址/);
  await assert.rejects(publishTemplate({ ...base, declare: false }), /必须完成版权声明/);
});

test('submit script performs the real per-layer declaration and refuses a mismatched candidate count', () => {
  const script = buildTemplatePublishScript({
    ...base, submit: true, journal: { path: '/tmp/journal', value: {} }, publicationPath: '/tmp/publication',
    plan: { candidates: 23, category: 'original', categoryLabel: '原创素材', imageCount: 27 }, evidence: '/tmp/evidence.png'
  });
  assert.match(script, /去完善/);
  assert.match(script, /ugc-copyright-section/);
  assert.match(script, /声明并发布/);
  assert.match(script, /版权候选数不符/);
  assert.match(script, /声明材料没有上传成功/);
  assert.match(script, /版权声明提交后没有保存确认/);
  assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)('taskSpace', script));
});

test('declaration plan rejects missing evidence before any browser work', async () => {
  const { preflightTemplateDeclaration } = await import('./template-declaration.js');
  assert.throws(() => preflightTemplateDeclaration({ runDir: '/tmp/does-not-exist-run' }), /creation\.json/);
});

test('declaration read-back maps platform enum case and requires full coverage', async () => {
  const { completeTemplateDeclaration } = await import('./template-declaration.js');
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const runDir = mkdtempSync(join(tmpdir(), 'decl-verify-'));
  mkdirSync(join(runDir, 'publish'), { recursive: true });
  const plan = { candidates: 2, imageCount: 3, category: 'original' };
  const ok = await completeTemplateDeclaration({
    runDir, contentId: '1', plan, space: 3,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { end() { child.stdout.emit('data', JSON.stringify({ records: [{ copyright_type: 'ORIGINAL' }, { copyright_type: 'ORIGINAL' }] })); child.emit('close', 0); }, on() {} };
      child.kill = () => {};
      return child;
    }
  });
  assert.equal(ok.verified, true);
  assert.equal(ok.matched, 2);
  await assert.rejects(() => completeTemplateDeclaration({
    runDir, contentId: '1', plan, space: 3,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { end() { child.stdout.emit('data', JSON.stringify({ records: [{ copyright_type: 'ORIGINAL' }] })); child.emit('close', 0); }, on() {} };
      child.kill = () => {};
      return child;
    }
  }), /回读不完整/);
});

test('declaration category follows the real layer source', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { preflightTemplateDeclaration } = await import('./template-declaration.js');
  const dataRoot = process.env.DSH_GAODING_DATA || join(homedir(), '.local/share/dsh-gaoding-publisher');
  const source = join(dataRoot, 'runs/job-20261117131158-31fccc-30faac-2');
  if (!existsSync(source)) return;
  const make = category => {
    const runDir = mkdtempSync(join(tmpdir(), 'decl-source-'));
    mkdirSync(join(runDir, 'release'), { recursive: true });
    mkdirSync(join(runDir, 'publish'), { recursive: true });
    copyFileSync(join(source, 'creation.json'), join(runDir, 'creation.json'));
    copyFileSync(join(source, 'release', 'layer-manifest.json'), join(runDir, 'release', 'layer-manifest.json'));
    const recipe = JSON.parse(readFileSync(join(source, 'release-recipe.json'), 'utf8'));
    for (const layer of recipe.layers) if (layer.type !== 'text') layer.copyright_category = category;
    writeFileSync(join(runDir, 'release-recipe.json'), JSON.stringify(recipe));
    const evidence = JSON.parse(readFileSync(join(source, 'publish', 'declaration-evidence.json'), 'utf8'));
    writeFileSync(join(runDir, 'publish', 'declaration-evidence.json'), JSON.stringify(evidence));
    return runDir;
  };
  assert.equal(preflightTemplateDeclaration({ runDir: make('original') }).category, 'original');
  const aiRun = make('original_ai');
  const aiPlan = preflightTemplateDeclaration({ runDir: aiRun });
  assert.equal(aiPlan.category, 'original_ai');
  assert.equal(aiPlan.categoryLabel, '原创 AI 素材');
  // 声称 AI 但实际是程序原创 → 必须拒绝
  assert.throws(() => preflightTemplateDeclaration({ runDir: make('original'), category: 'original_ai' }), /声明分类与真实来源不符/);
});

test('material publish script adapts to both declaration panels and verifies via platform API', async () => {
  const { buildPublishScript } = await import('./publisher.js');
  const script = buildPublishScript({
    asset: '/tmp/asset.png', description: 'd', topic: 't', evidence: '/tmp/evidence.png',
    ai: true, submit: true, declare: true, space: 3,
    shots: { formReady: '/tmp/1', published: '/tmp/2', declaration: '/tmp/3', failed: '/tmp/4' }
  });
  // 素材面板没有分类区，模板面板才有：两种都要能走通
  assert.match(script, /declaration-panel:/);
  assert.match(script, /'sections'/);
  assert.match(script, /'simple'/);
  // 声明必须用平台接口核验，而不是「点了按钮就算成功」
  assert.match(script, /materials\/' \+ id \+ '\/declaration/);
  assert.match(script, /declaration-verified:/);
  assert.match(script, /declaration-retry/);
  // 声明失败必须带上「已发布」标记，交给上层按原 ID 恢复
  assert.match(script, /declarationPending: true/);
  assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)('taskSpace', script));
});

test('publish run records a pending-declaration state instead of pretending success', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /published-pending-declaration/);
  assert.match(source, /declarationPending: true/);
});

test('material script backfills the platform declaration status into the content record', async () => {
  const { buildPublishScript } = await import('./publisher.js');
  const script = buildPublishScript({
    asset: '/tmp/asset.png', description: 'd', topic: 't', evidence: '/tmp/e.png', ai: true, submit: true, declare: true, space: 3,
    shots: { formReady: '/tmp/1', published: '/tmp/2', declaration: '/tmp/3', failed: '/tmp/4' }
  });
  assert.match(script, /content\.declaration = declarationState\.material_declaration_status/);
});

test('final publication record carries topic and content id so completion can be judged', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./template-publish.js', import.meta.url), 'utf8');
  assert.match(source, /stage: 'verified', published: true, contentId: String\(content\.id\)/);
  assert.match(source, /topics: content\.topics \?\? \[topic\]/);
  assert.match(source, /declarationStatus: 'SUBMITTED'/);
});

test('mixed sources declare each group into its own section using perceptual hashes', () => {
  const script = buildTemplatePublishScript({
    ...base, submit: true, journal: { path: '/tmp/journal', value: {} }, publicationPath: '/tmp/publication',
    plan: {
      candidates: 6, category: 'mixed', categoryLabel: '混合', imageCount: 6,
      categories: [
        { category: 'original', label: '原创素材', perceptual: [{ name: 'a', hash: 'f0'.repeat(32), rgb: [10, 20, 30], cover: 1, aspect: 0.75 }] },
        { category: 'original_ai', label: '原创 AI 素材', perceptual: [{ name: 'b', hash: '0f'.repeat(32), rgb: [200, 150, 90], cover: 0.6, aspect: 0.75 }] }
      ]
    },
    evidence: '/tmp/evidence.png'
  });
  // 用候选预览图的感知哈希对齐图层，而不是按顺序猜
  assert.match(script, /createElement\('canvas'\)/);
  assert.match(script, /declaration-group:/);
  // 匹配不完整要中止，避免把 AI 图错声明成原创素材
  assert.match(script, /候选匹配不完整/);
  // 两类各上传一次证据
  assert.match(script, /data-agent-evidence/);
  assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)('taskSpace', script));
});

test('a template with any AI layer declares the whole work as AI-generated material', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { preflightTemplateDeclaration } = await import('./template-declaration.js');
  const runDir = mkdtempSync(join(tmpdir(), 'decl-mixed-'));
  mkdirSync(join(runDir, 'release'), { recursive: true });
  mkdirSync(join(runDir, 'publish'), { recursive: true });
  const rows = [
    { name: 'AI背景', type: 'image', file: 'assets/ai-bg.png', sha256: 'a'.repeat(64) },
    { name: '程序卡片', type: 'shape', file: 'assets/card.png', sha256: 'c'.repeat(64) },
    { name: '标题', type: 'editable_text', text: '标题' }
  ];
  writeFileSync(join(runDir, 'release', 'layer-manifest.json'), JSON.stringify(rows));
  writeFileSync(join(runDir, 'release-recipe.json'), JSON.stringify({
    canvas: { w: 1242, h: 1656 }, layers: [
      { id: 'bg', name: 'AI背景', type: 'image', copyright_category: 'original_ai' },
      { id: 'card', name: '程序卡片', type: 'shape', copyright_category: 'original' },
      { id: 't1', name: '标题', type: 'text' }
    ]
  }));
  writeFileSync(join(runDir, 'creation.json'), JSON.stringify({ topic: '话题', title: '标题' }));
  const evidence = join(runDir, 'publish', 'original-evidence.png');
  writeFileSync(evidence, 'fake-png');
  writeFileSync(join(runDir, 'publish', 'declaration-evidence.json'), JSON.stringify({
    schema: 1, image: evidence, sha256: createHash('sha256').update('fake-png').digest('hex'),
    layers: rows.filter(row => row.type !== 'editable_text').map(row => row.name), layerCount: 2, candidates: 2
  }));
  const plan = preflightTemplateDeclaration({ runDir });
  // 含 AI 图层 → 整稿统一按原创 AI 素材声明，避免逐张区分导致错声明
  assert.equal(plan.category, 'original_ai');
  assert.equal(plan.categories.length, 1);
  assert.equal(plan.categories[0].layerNames.length, 2);

  // 纯程序绘制的稿子仍然声明原创素材
  writeFileSync(join(runDir, 'release-recipe.json'), JSON.stringify({
    canvas: { w: 1242, h: 1656 }, layers: [
      { id: 'bg', name: 'AI背景', type: 'shape', copyright_category: 'original' },
      { id: 'card', name: '程序卡片', type: 'shape', copyright_category: 'original' },
      { id: 't1', name: '标题', type: 'text' }
    ]
  }));
  const purePlan = preflightTemplateDeclaration({ runDir });
  assert.equal(purePlan.category, 'original');
});

test('candidate matching uses perceptual hashes because the platform re-encodes previews', async () => {
  const { layerFingerprint, fingerprintMatch } = await import('./template-declaration.js');
  const dataRoot = process.env.DSH_GAODING_DATA || join(homedir(), '.local/share/dsh-gaoding-publisher');
  const python = process.env.DSH_GAODING_PYTHON || join(dataRoot, 'dependencies/.venv/bin/python');
  const first = join(dataRoot, 'runs/job-20261118013220-231a85-819571-1/release/assets/bg-paper.png');
  const second = join(dataRoot, 'runs/job-20261118013220-231a85-819571-1/release/assets/mascot-sheep.png');
  if (!existsSync(first) || !existsSync(second)) return; // 需要有真实产物才跑
  const a = await layerFingerprint(first, python);
  const b = await layerFingerprint(second, python);
  assert.ok(a && b);
  assert.equal(fingerprintMatch(a, a), true, '同一张图必须匹配');
  assert.equal(fingerprintMatch(a, b), false, '不同图必须能区分开');
  const script = buildTemplatePublishScript({
    ...base, submit: true, journal: { path: '/tmp/journal', value: {} }, publicationPath: '/tmp/publication',
    plan: { candidates: 2, category: 'mixed', categoryLabel: '混合', categories: [{ category: 'original_ai', label: '原创 AI 素材', perceptual: [{ name: 'x', ...a }] }] },
    evidence: '/tmp/evidence.png'
  });
  assert.match(script, /createElement\('canvas'\)/);
  assert.match(script, /图层指纹/);
});

test('a plan supplied by the caller is used verbatim so fingerprints survive', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./template-publish.js', import.meta.url), 'utf8');
  assert.match(source, /plan: providedPlan/);
  assert.match(source, /providedPlan \?\? await preflightDeclaration/);
});

test('publish clicks are retried when the dialog re-renders and drops the element handle', async () => {
  const script = buildTemplatePublishScript({
    ...base, submit: true, journal: { path: '/tmp/journal', value: {} }, publicationPath: '/tmp/publication',
    plan: { candidates: 1, category: 'original_ai', categoryLabel: '原创 AI 素材', categories: [{ category: 'original_ai', label: '原创 AI 素材', layerNames: ['a'], perceptual: [] }] },
    evidence: '/tmp/evidence.png'
  });
  assert.match(script, /const clickStable = async/, '必须有可重试点击，元素句柄失效时重新快照');
  assert.match(script, /not connected\|timed out\|not attached/);
  assert.match(script, /clickStable\('textfield "描述"'/);
});

test('the publish dialog is reopened when the overlay swallows the first click', async () => {
  const script = buildTemplatePublishScript({
    ...base, submit: true, journal: { path: '/tmp/journal', value: {} }, publicationPath: '/tmp/publication',
    plan: { candidates: 1, category: 'original_ai', categoryLabel: '原创 AI 素材', categories: [{ category: 'original_ai', label: '原创 AI 素材', layerNames: ['a'], perceptual: [] }] },
    evidence: '/tmp/evidence.png'
  });
  assert.match(script, /reopen publish/, '弹窗没出现时要重新点发布');
  assert.match(script, /已重开 3 次/);
});
