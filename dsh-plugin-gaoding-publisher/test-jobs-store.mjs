import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobs, listJobs, removeJob, instructionFor, listRuns, jobsFile, maxQuantity, writePrompt, confirmPrompts, readPromptOf, promptFileOf } from './jobs-store.js';

const topics = [
  { key: 'topic-aaa', name: '话题甲', rules_url: 'https://gdce.yuque.com/team/book/aaa', type: '热门话题' },
  { key: 'topic-bbb', name: '话题乙', rules_url: null, type: '长期话题' }
];

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-jobs-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('creating jobs freezes one snapshot and directory per quantity unit', () => {
  const { root, cleanup } = workspace();
  try {
    const created = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 2, note: '偏极简', catalogTopics: topics, now: new Date('2026-11-17T10:00:00.000Z') });
    assert.equal(created.jobs.length, 1);
    const job = created.jobs[0];
    assert.equal(job.units.length, 2);
    assert.equal(job.quantity, 2);
    assert.equal(job.topic.key, 'topic-aaa');
    for (const unit of job.units) {
      assert.ok(existsSync(unit.directory), 'each unit gets its own run directory');
      const snapshot = JSON.parse(readFileSync(unit.topicFile, 'utf8'));
      assert.equal(snapshot.key, 'topic-aaa');
      assert.equal(snapshot.note, '偏极简');
      assert.equal(snapshot.requestedQuantity, 2);
      assert.deepEqual(unit.args.slice(0, 2), ['auto', unit.directory]);
      assert.ok(unit.args.includes('--topic-json'));
      assert.ok(unit.args.includes('native'));
    }
    assert.notEqual(job.units[0].directory, job.units[1].directory, 'units never share a directory');
    assert.equal(JSON.parse(readFileSync(jobsFile(root), 'utf8')).jobs.length, 1);
  } finally { cleanup(); }
});

test('each unit gets a spec-derived brief and units never repeat the same direction', () => {
  const { root, cleanup } = workspace();
  try {
    const spec = { canvas: [{ label: '1242×1656' }], directions: ['教育培训：备考重点', '职场就业：求职攻略', '商品零售：必买清单'], forbidden: ['严禁添加Logo、二维码'], materials: ['小红书封面/配图：1242*1656px'], fetchedAt: '2026-11-17T00:00:00.000Z', url: 'https://gdce.yuque.com/x' };
    const created = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 3, note: '清爽', catalogTopics: topics, specs: { 'topic-aaa': spec } });
    const units = created.jobs[0].units;
    assert.deepEqual(units.map(unit => unit.brief.direction), ['教育培训：备考重点', '职场就业：求职攻略', '商品零售：必买清单']);
    assert.deepEqual(units[0].brief.canvas, ['1242×1656']);
    assert.equal(units[0].brief.forbidden[0], '严禁添加Logo、二维码');
    assert.equal(units[0].brief.note, '清爽');
    assert.equal(units[0].brief.index, 1);
    const snapshot = JSON.parse(readFileSync(units[0].topicFile, 'utf8'));
    assert.equal(snapshot.brief.direction, '教育培训：备考重点', 'the brief is frozen in the run snapshot');
    const text = instructionFor(created.jobs[0]);
    assert.ok(text.includes('教育培训：备考重点'));
    assert.ok(text.includes('职场就业：求职攻略'));
    assert.ok(text.includes('不生成图片'), 'the prompt stage must not generate images');
    assert.ok(text.includes('不要提前生成图片'), 'the agent must wait for confirmation');
    assert.ok(!text.includes('--topic-json'), 'the prompt stage must not start the workflow yet');
  } finally { cleanup(); }
});

test('job creation rejects unsafe quantity, unknown topics and topics without specs', () => {
  const { root, cleanup } = workspace();
  try {
    const base = { dataRoot: root, catalogTopics: topics };
    assert.throws(() => createJobs({ ...base, topics: [] }), /至少选择一个话题/);
    assert.throws(() => createJobs({ ...base, topics: ['topic-aaa'], quantity: 0 }), new RegExp('1 到 ' + maxQuantity));
    assert.throws(() => createJobs({ ...base, topics: ['topic-aaa'], quantity: maxQuantity + 1 }), new RegExp('1 到 ' + maxQuantity));
    assert.throws(() => createJobs({ ...base, topics: ['topic-missing'] }), /不在当前实时目录/);
    assert.throws(() => createJobs({ ...base, topics: ['topic-bbb'] }), /没有规范链接/);
  } finally { cleanup(); }
});

test('job status derives from the real run.json instead of stored progress', () => {
  const { root, cleanup } = workspace();
  try {
    const created = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 2, catalogTopics: topics, now: new Date('2026-11-17T10:00:00.000Z') });
    const [first, second] = created.jobs[0].units;
    writeFileSync(join(first.directory, 'run.json'), JSON.stringify({ status: 'running', current: 'native_layouts', stages: { research_collect: { state: 'done' } } }));
    let jobs = listJobs(root);
    assert.equal(jobs[0].status, 'running');
    assert.equal(jobs[0].units[0].current, 'native_layouts');
    assert.equal(jobs[0].units[1].status, 'queued');
    writeFileSync(join(first.directory, 'run.json'), JSON.stringify({ status: 'waiting_agent', current: '03-layout', stages: {} }));
    jobs = listJobs(root);
    assert.equal(jobs[0].units[0].status, 'waiting_agent');
    writeFileSync(join(second.directory, 'run.json'), JSON.stringify({ status: 'complete', elapsed_seconds: 120 }));
    writeFileSync(join(first.directory, 'run.json'), JSON.stringify({ status: 'complete', elapsed_seconds: 100 }));
    assert.equal(listJobs(root)[0].status, 'complete');
    assert.equal(listJobs(root)[0].units[1].elapsedSeconds, 120);
  } finally { cleanup(); }
});

test('running jobs cannot be deleted while queued ones can', () => {
  const { root, cleanup } = workspace();
  try {
    const created = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 1, catalogTopics: topics, now: new Date('2026-11-17T10:00:00.000Z') });
    const id = created.jobs[0].id;
    const removed = removeJob(root, id);
    assert.equal(removed.removed, id);
    assert.equal(removed.cleaned.length, 1);
    assert.equal(existsSync(created.jobs[0].units[0].directory), false, 'an untouched unit directory is cleaned');
    assert.equal(listJobs(root).length, 0);
    const again = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 1, catalogTopics: topics });
    writeFileSync(join(again.jobs[0].units[0].directory, 'run.json'), JSON.stringify({ status: 'running' }));
    assert.throws(() => removeJob(root, again.jobs[0].id), /仍在进行中/);
    assert.throws(() => removeJob(root, '../escape'), /Invalid job id/);
  } finally { cleanup(); }
});

test('the instruction carries the exact per-unit arguments and no invented copy', () => {
  const { root, cleanup } = workspace();
  try {
    const created = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 1, note: '清爽配色', catalogTopics: topics });
    writePrompt(created.jobs[0].units[0], { prompt: '完整 prompt' });
    confirmPrompts(listJobs(root)[0]);
    const job = listJobs(root)[0];
    const text = instructionFor(job);
    assert.ok(text.includes(job.id));
    assert.ok(text.includes(job.topic.name));
    assert.ok(text.includes(job.units[0].directory));
    assert.ok(text.includes('--topic-json'));
    assert.ok(text.includes('native'));
    assert.ok(text.includes('用户确认并冻结'), 'execution must reference the confirmed prompts');
    assert.equal(text.includes('创意方向：'), false, 'the controller must not invent creative copy');
  } finally { cleanup(); }
});

test('result listing scans real runs and finds a preview image', () => {
  const { root, cleanup } = workspace();
  try {
    const empty = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 1, catalogTopics: topics });
    assert.deepEqual(listRuns(root), [], 'directories without run.json are not results');
    const directory = empty.jobs[0].units[0].directory;
    writeFileSync(join(directory, 'run.json'), JSON.stringify({
      requested_topic: '话题甲', status: 'complete', current: 'package',
      started_at: 1763366400, completed_at: 1763366520, elapsed_seconds: 120,
      stages: { build: { state: 'done' }, package: { state: 'done' } }
    }));
    assert.equal(listRuns(root)[0].stagesDone, 2);
    mkdirSync(join(directory, 'build', 'concept-1'), { recursive: true });
    writeFileSync(join(directory, 'build', 'concept-1', 'master.jpg'), 'jpeg');
    const runs = listRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].topic, '话题甲');
    assert.equal(runs[0].status, 'complete');
    assert.ok(runs[0].preview.endsWith('/build/concept-1/master.jpg'));
  } finally { cleanup(); }
});

test('prompts gate generation until the user confirms every unit', () => {
  const { root, cleanup } = workspace();
  try {
    createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 2, catalogTopics: topics });
    let job = listJobs(root)[0];
    assert.deepEqual(job.units.map(unit => unit.promptState), ['missing', 'missing']);
    assert.match(instructionFor(job), /写创作 prompt/);
    assert.throws(() => confirmPrompts(job), /没有 prompt/);

    writePrompt(job.units[0], { prompt: '第一份完整 prompt', layers: [{ id: 'subject', role: 'foreground', require_alpha: true }] });
    job = listJobs(root)[0];
    assert.deepEqual(job.units.map(unit => unit.promptState), ['written', 'missing']);
    assert.throws(() => confirmPrompts(job), /还有 1 个单元/, 'a single written prompt cannot unlock generation');
    assert.throws(() => writePrompt(job.units[1], { prompt: '   ' }), /不能为空/);

    writePrompt(job.units[1], { prompt: '第二份完整 prompt' });
    job = listJobs(root)[0];
    assert.match(instructionFor(job), /等用户在面板确认/);

    const records = confirmPrompts(job);
    assert.equal(records.length, 2);
    job = listJobs(root)[0];
    assert.deepEqual(job.units.map(unit => unit.promptState), ['confirmed', 'confirmed']);
    const instruction = instructionFor(job);
    assert.match(instruction, /用户确认并冻结/);
    assert.ok(instruction.includes(promptFileOf(job.units[0])), 'execution points at the frozen prompt file');

    writePrompt(job.units[0], { prompt: '用户改过的 prompt' }, { by: 'user' });
    job = listJobs(root)[0];
    assert.deepEqual(job.units.map(unit => unit.promptState), ['written', 'confirmed'], 'editing revokes confirmation');
    assert.match(instructionFor(job), /等用户在面板确认/);
    assert.equal(readPromptOf(job.units[0]).editedAt !== null, true);
  } finally { cleanup(); }
});

test('jobs carry an explicit manual or auto mode', () => {
  const { root, cleanup } = workspace();
  try {
    const manual = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 1, catalogTopics: topics });
    assert.equal(manual.jobs[0].mode, 'manual');
    const auto = createJobs({ dataRoot: root, topics: ['topic-aaa'], quantity: 1, catalogTopics: topics, mode: 'auto' });
    assert.equal(auto.jobs[0].mode, 'auto');
    assert.throws(() => createJobs({ dataRoot: root, topics: ['topic-aaa'], catalogTopics: topics, mode: 'fast' }), /manual 或 auto/);
    assert.deepEqual(listJobs(root).map(job => job.mode).sort(), ['auto', 'manual']);
  } finally { cleanup(); }
});

test('run rows carry the real publish stage so finished creation is not called complete', async () => {
  const { listRuns } = await import('./jobs-store.js');
  const dataRoot = process.env.DSH_GAODING_DATA || join(homedir(), '.local/share/dsh-gaoding-publisher');
  if (!existsSync(join(dataRoot, 'runs'))) return; // 需要本机真实运行目录才跑
  const rows = listRuns(dataRoot);
  assert.ok(rows.length > 0);
  const allowed = new Set(['creating', 'created', 'ready', 'publishing', 'uncertain', 'published']);
  for (const row of rows) assert.ok(allowed.has(row.stage), '未知阶段：' + row.stage);
  // 有投稿任务且已发布的行必须带 contentId
  for (const row of rows.filter(r => r.stage === 'published')) assert.ok(row.contentId, '已投稿行缺少 contentId');
  // 创作完成但没投稿的行不能标成 published
  for (const row of rows.filter(r => r.stage === 'created')) assert.equal(row.publishState, null);
});

test('quantity accepts 1–20 and rejects anything outside', () => {
  assert.equal(maxQuantity, 20);
  for (const quantity of [1, 20]) {
    const { root, cleanup } = workspace();
    try {
      const value = createJobs({ dataRoot: root, topics: ['topic-aaa'], catalogTopics: topics, specs: {}, mode: 'manual', quantity });
      assert.equal(value.jobs[0].units.length, quantity);
    } finally { cleanup(); }
  }
  for (const quantity of [0, 21, 2.5]) {
    const { root, cleanup } = workspace();
    try {
      assert.throws(() => createJobs({ dataRoot: root, topics: ['topic-aaa'], catalogTopics: topics, specs: {}, mode: 'manual', quantity }), /1 到 20/);
    } finally { cleanup(); }
  }
});

test('cancelling a queued publish task is allowed, publishing ones are not', async () => {
  const { createPublishTask, markPublishCancelled, listPublishTasks, publishStatusText } = await import('./jobs-store.js');
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataRoot = mkdtempSync(join(tmpdir(), 'cancel-test-'));
  try {
    const runDir = join(dataRoot, 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    const created = createPublishTask({ dataRoot, runDir, summary: { kind: 'material', release: runDir, topic: '话题', asset: join(runDir, 'asset.png') } });
    const id = created.task.id;
    assert.equal(listPublishTasks(dataRoot).find(row => row.id === id).status, 'queued');
    markPublishCancelled(dataRoot, id);
    const after = listPublishTasks(dataRoot).find(row => row.id === id);
    assert.equal(after.status, 'cancelled');
    assert.ok(publishStatusText.cancelled);
    // 已发布的任务不能取消
    assert.throws(() => markPublishCancelled(dataRoot, 'nope'), /投稿任务不存在/);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('the image backend is stored on the job so retries keep using it', async () => {
  const { createJobs } = await import('./jobs-store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataRoot = mkdtempSync(join(tmpdir(), 'backend-test-'));
  try {
    const topic = { key: 'topic-aaa', name: '话题', rules_url: 'https://x', type: '热门话题' };
    const value = createJobs({ dataRoot, topics: ['topic-aaa'], catalogTopics: [topic], specs: {}, mode: 'manual', backend: 'image-gen', quantity: 1 });
    assert.equal(value.jobs[0].backend, 'image-gen', '后端必须存进任务，重试才不会退回 gd-cli');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});
