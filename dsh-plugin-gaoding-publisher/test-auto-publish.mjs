import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeAutoPipeline, publicationComplete } from './auto-publish.js';
import { createPublishTask, listPublishTasks } from './jobs-store.js';

function harness({ count = 2, kind = 'template', ready = false } = {}) {
  const calls = [], tasks = [], files = new Map(), created = new Set();
  const job = { id: 'job', kind, units: Array.from({ length: count }, (_, i) => ({ id: 'u' + i, directory: '/runs/u' + i, promptState: 'missing' })) };
  if (ready) job.units.forEach(u => created.add(u.directory));
  const publication = () => ({ published: true, contentId: '123', topics: ['话题'], declaration: { verified: true, reopened: true } });
  const deps = {
    dataRoot: '/data', pipelines: new Map(), publishRuns: new Map(),
    listJobs: () => [structuredClone(job)], listPublishTasks: () => tasks,
    readJson: path => files.get(path), writeJson: (path, value) => files.set(path, value),
    instructionFor: () => 'Agent handoff',
    checkRun: directory => ({ ok: created.has(directory), checks: [{ ok: created.has(directory), label: '产物' }], summary: { release: join(directory, 'release'), recipe: join(directory, 'recipe.json'), topic: '话题', kind } }),
    generateJobPrompts: async value => { calls.push(['prompt', value.units.map(u => u.id)]); return { running: false }; },
    confirmPrompts: (value, opts) => { assert.deepEqual(opts, { by: 'auto-policy' }); calls.push(['confirm']); job.units.forEach(u => { if (value.units.some(v => v.id === u.id)) u.promptState = 'confirmed'; }); },
    runCreation: async value => { calls.push(['create', value.units.map(u => u.id)]); value.units.forEach(u => created.add(u.directory)); return { total: value.units.length, done: value.units.length, failed: [], running: false }; },
    createPublishTask: args => { assert.equal(args.dataRoot, '/data'); assert.ok(args.summary.release); calls.push(['task', args.runDir]); const task = { id: 'p' + tasks.length, runDir: args.runDir, ...args.summary, status: 'queued' }; tasks.push(task); return { task, reused: false }; },
    runPublish: async (id, options) => { assert.equal(typeof id, 'string'); assert.deepEqual(options, { submit: true }); calls.push(['publish', id]); const task = tasks.find(t => t.id === id); task.publication = publication(); task.status = 'published'; return { running: false, step: 'published', result: { ok: true } }; }
  };
  const run = (opts = {}) => executeAutoPipeline('job', opts, deps);
  return { deps, calls, tasks, files, created, job, publication, run };
}

test('all creation finishes before serial publication; task/result contracts and repeat are idempotent', async () => {
  const h = harness();
  assert.equal((await h.run()).stage, 'done');
  assert.deepEqual(h.calls.map(c => c[0]), ['prompt', 'confirm', 'create', 'task', 'publish', 'task', 'publish']);
  assert.equal(h.files.size, 2);
  const before = h.calls.length;
  const second = await h.run();
  assert.equal(second.stage, 'done');
  assert.equal(h.calls.length, before);
  assert.equal(second.steps.filter(s => s.startsWith('published-skipped:')).length, 2);
});

test('partial creation never publishes the units that were not created', async () => {
  // 总数对不上 / 整体报错：仍视为失败，不允许投任何单元。
  for (const creation of [{ total: 1, done: 1 }, { total: 2, done: 2, error: 'error' }]) {
    const h = harness(); h.deps.runCreation = async () => creation;
    assert.equal((await h.run()).stage, 'failed');
    assert.equal(h.tasks.length, 0);
  }
  // 个别单元失败：投已完成的，失败原因如实上报，阶段是 done-partial。
  const partial = harness();
  partial.deps.runCreation = async job => { partial.created.add(job.units[1].directory); return { total: 2, done: 1, failed: [{ unit: 'u0', error: '内容审核', code: 'CONTENT_AUDIT' }] }; };
  const result = await partial.run();
  assert.equal(result.stage, 'done-partial');
  assert.equal(partial.tasks.length, 1);
  assert.match(result.error, /u0/);
});

test('preflights every material unit before submitting anything', async () => {
  const h = harness({ kind: 'material' });
  h.deps.runCreation = async job => { h.created.add(job.units[0].directory); return { total: 2, done: 2, failed: [] }; };
  // 第二个单元检查不通过：整批在提交前就停下，一个任务都不建。
  const single = h.deps.checkRun;
  h.deps.checkRun = directory => (directory.endsWith('u1') ? { ok: false, published: false, checks: [{ ok: false, label: '素材缺失' }], summary: null } : single(directory));
  const result = await h.run();
  assert.equal(result.stage, 'failed');
  assert.match(result.error, /投稿前检查未通过/);
  assert.equal(h.tasks.length, 0);
});

test('Agent backend hands off without prompt confirmation, creation, or CLI fallback', async () => {
  const h = harness();
  const result = await h.run({ backend: 'agent' });
  assert.equal(result.stage, 'waiting-agent'); assert.equal(result.instruction, 'Agent handoff');
  assert.equal(result.running, false); assert.deepEqual(h.calls, []);
});

test('existing template resumes the same task even when a not-published preflight would fail', async () => {
  const h = harness({ count: 1 });
  h.tasks.push({ id: 'original', runDir: '/runs/./u0', topic: '话题', kind: 'template', status: 'uncertain', publication: { published: true, contentId: '123' } });
  assert.equal((await h.run()).stage, 'done');
  assert.deepEqual(h.calls, [['publish', 'original']]);
});

test('material uncertainty stops for reconciliation without resubmission', async () => {
  const h = harness({ count: 1, kind: 'material' });
  h.tasks.push({ id: 'original', runDir: '/runs/u0', topic: '话题', kind: 'material', status: 'uncertain' });
  assert.match((await h.run()).error, /禁止重复提交/); assert.deepEqual(h.calls, []);
});

test('no-error false results, unfinished results, and missing persisted verification are failures', async () => {
  for (const response of [undefined, { step: 'failed', result: { ok: false } }, { step: 'published', result: { ok: false } }, { running: true, step: 'published', result: { ok: true } }, { step: 'published', result: { ok: true } }]) {
    const h = harness({ count: 1, ready: true }); h.deps.runPublish = async () => response;
    const result = await h.run();
    // 单单元失败不再让整批崩掉：阶段为 done-partial，且失败原因如实带出。
    assert.equal(result.stage, 'done-partial');
    assert.equal(result.failures.length, 1);
    assert.ok(result.error);
  }
});

test('template completion requires verified and reopened declarations plus exact topic and content ID', () => {
  const h = harness();
  const task = { kind: 'template', topic: '话题', publication: h.publication() };
  assert.equal(publicationComplete(task), true);
  for (const declaration of [{ submitted: true }, { verified: true }, { reopened: true }]) assert.equal(publicationComplete({ ...task, publication: { ...task.publication, declaration } }), false);
  for (const patch of [{ contentId: null }, { topics: ['其他话题'] }, { published: false }]) assert.equal(publicationComplete({ ...task, publication: { ...task.publication, ...patch } }), false);
});

test('in-flight pipeline and publication guards prevent duplicate calls', async () => {
  const h = harness({ count: 1 });
  let release;
  h.deps.generateJobPrompts = () => new Promise(resolve => { release = resolve; });
  const first = h.run();
  const duplicate = await h.run(); assert.equal(duplicate.running, true);
  release({ running: false }); assert.equal((await first).stage, 'done');
  assert.equal(h.calls.filter(c => c[0] === 'publish').length, 1);
  const other = harness({ count: 1, ready: true });
  other.tasks.push({ id: 'p', runDir: '/runs/u0', topic: '话题', kind: 'template', status: 'queued' });
  other.deps.publishRuns.set('p', { running: true });
  assert.match((await other.run()).error, /仍在运行/); assert.deepEqual(other.calls, []);
});

test('real jobs store accepts orchestration arguments and returns the task used by runPublish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-auto-test-'));
  try {
    const h = harness({ count: 1, ready: true });
    h.deps.dataRoot = root; h.deps.createPublishTask = createPublishTask;
    h.deps.listPublishTasks = listPublishTasks;
    let invoked;
    h.deps.runPublish = async id => { invoked = id; return { error: 'fixture stops before external work' }; };
    const result = await h.run();
    const [task] = listPublishTasks(root);
    assert.equal(invoked, task.id); assert.equal(task.runDir, '/runs/u0');
    assert.match(result.error, /fixture stops/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '/gaoding-auto-test-'));
    rmSync(root, { recursive: true });
  }
});

test('an already published run is skipped instead of failing the batch', async () => {
  const { executeAutoPipeline } = await import('./auto-publish.js');
  const unit = { id: 'u1', directory: '/runs/one' };
  const job = { id: 'job', kind: 'material', units: [unit] };
  const pipelines = new Map();
  const publishedCheck = {
    ok: false, published: true, status: 'published',
    checks: [{ id: 'not_published', label: '已投稿（不会重复提交）', ok: false, detail: '作品 ID 1' }],
    summary: { kind: 'material', release: '/runs/one' }
  };
  const state = await executeAutoPipeline('job', { backend: 'gd-cli' }, {
    pipelines, dataRoot: '/data',
    listJobs: () => [job],
    listPublishTasks: () => [],
    checkRun: () => publishedCheck,
    createPublishTask: () => { throw Error('不应为已投稿运行创建任务'); },
    generateJobPrompts: async () => { throw Error('不应生成 prompt'); },
    confirmPrompts: () => {},
    runCreation: async () => { throw Error('不应重新创作'); },
    runPublish: async () => { throw Error('不应重复投稿'); },
    readJson: () => null,
    writeJson: () => {}
  });
  assert.equal(state.stage, 'done');
  assert.equal(state.error, null);
  assert.ok(state.steps.includes('published-unmanaged:u1'));
});

test('a published work without a submitted declaration is not complete', async () => {
  const { publicationComplete } = await import('./auto-publish.js');
  const base = { topic: 't', publication: { published: true, contentId: '1', topics: ['t'], declarationStatus: 'WAITING_MATERIALS' } };
  assert.equal(publicationComplete({ kind: 'material', ...base }), false);
  assert.equal(publicationComplete({ kind: 'material', ...base, publication: { ...base.publication, declarationStatus: 'SUBMITTED' } }), true);
  const template = { kind: 'template', topic: 't', publication: { published: true, contentId: '1', topics: ['t'] } };
  assert.equal(publicationComplete(template), false);
  assert.equal(publicationComplete({ ...template, publication: { ...template.publication, declaration: { verified: true, reopened: true } } }), true);
});

test('one failed unit does not stop the others, and failures are reported', async () => {
  const { executeAutoPipeline } = await import('./auto-publish.js');
  const units = [{ id: 'u1', directory: '/runs/a' }, { id: 'u2', directory: '/runs/b' }];
  const job = { id: 'job', kind: 'material', units };
  const created = [];
  const published = [];
  const state = await executeAutoPipeline('job', { backend: 'gd-cli' }, {
    pipelines: new Map(), dataRoot: '/data',
    listJobs: () => [job],
    listPublishTasks: () => created,
    checkRun: () => ({ ok: true, published: false, summary: { kind: 'material', release: '/runs/a' }, checks: [] }),
    createPublishTask: ({ runDir }) => {
      const task = { id: 'task-' + runDir.slice(-1), runDir, kind: 'material', status: 'queued', topic: 't' };
      created.push(task);
      return { task, reused: false };
    },
    generateJobPrompts: async () => ({ running: false, error: null }),
    confirmPrompts: () => {},
    runCreation: async () => ({ running: false, done: 2, total: 2, failed: [] }),
    runPublish: async id => {
      if (id === 'task-a') return { running: false, step: 'published', error: '浏览器超时', result: { ok: false } };
      const task = created.find(row => row.id === id);
      task.status = 'published';
      task.publication = { published: true, contentId: '9', topics: ['t'], declarationStatus: 'SUBMITTED' };
      published.push(id);
      return { running: false, step: 'published', result: { ok: true } };
    },
    readJson: () => null,
    writeJson: () => {}
  });
  assert.equal(state.stage, 'done-partial');
  assert.deepEqual(published, ['task-b']);
  assert.equal(state.failures.length, 1);
  assert.match(state.error, /u1/);
});

test('a recorded creation failure is retried automatically, an interrupted run resumes', async () => {
  const { executeAutoPipeline } = await import('./auto-publish.js');
  const mark = failed => ({ failed: failed === true ? true : undefined, startedAt: 'x' });
  const build = attempted => {
    const writes = [];
    const deps = {
      pipelines: new Map(), dataRoot: '/data',
      listJobs: () => [{ id: 'job', kind: 'material', units: [{ id: 'u1', directory: '/runs/a' }] }],
      listPublishTasks: () => [],
      checkRun: () => ({ ok: false, published: false, checks: [{ ok: false, label: '缺少素材' }], summary: null }),
      createPublishTask: () => ({ task: { id: 't', kind: 'material', status: 'queued' } }),
      generateJobPrompts: async () => ({ running: false, error: null }),
      confirmPrompts: () => {},
      runCreation: async () => ({ running: false, done: 1, total: 1, failed: [] }),
      runPublish: async () => ({ running: false, step: 'published', result: { ok: true } }),
      readJson: file => (file.endsWith('auto-creation.json') ? attempted : null),
      writeJson: (file, value) => writes.push([file, value])
    };
    return { deps, writes };
  };
  const failed = build(mark(true));
  const result = await executeAutoPipeline('job', { backend: 'gd-cli' }, failed.deps);
  assert.ok(result.steps.includes('recreate:u1'));
  assert.ok(!String(result.error ?? '').includes('禁止重新生成'));

  const unknown = build(mark(false));
  const resumed = await executeAutoPipeline('job', { backend: 'gd-cli' }, unknown.deps);
  assert.ok(resumed.steps.some(step => String(step).startsWith('resume:')), '中断后应续跑而不是拒绝');
});

test('content-audit rejection is reported as a prompt problem, not a code failure', async () => {
  const { executeAutoPipeline } = await import('./auto-publish.js');
  const h = harness();
  h.deps.runCreation = async () => ({ total: 2, done: 2, failed: [{ unit: 'u0', error: 'gd-cli 退出码 1：这次内容未通过审核', code: 'CONTENT_AUDIT' }] });
  const result = await h.run();
  assert.equal(result.stage, 'done-partial');
  assert.match(result.error, /内容审核/);
  assert.match(result.error, /改 prompt/);
});

test('missing generated assets become a waiting state, not a failure', async () => {
  const { executeAutoPipeline } = await import('./auto-publish.js');
  const h = harness({ kind: 'template' });
  h.deps.runCreation = async () => ({
    total: 2, done: 0, failed: [
      { unit: 'u0', error: '等待出图素材：还没有素材回执', code: 'ASSETS_WAITING', request: ['bg', 'mascot'] }
    ]
  });
  const result = await h.run();
  assert.equal(result.stage, 'waiting-assets');
  assert.equal(result.error, null);
  assert.equal(result.waitingAssets.length, 1);
  assert.deepEqual(result.waitingAssets[0].request, ['bg', 'mascot']);
  assert.equal(h.tasks.length, 0, '素材没出之前不能建投稿任务');
});

test('image-gen backend is accepted by the auto pipeline', async () => {
  const { executeAutoPipeline } = await import('./auto-publish.js');
  const h = harness({ kind: 'material' });
  const result = await executeAutoPipeline('job', { backend: 'image-gen' }, h.deps);
  assert.notEqual(result.stage, 'failed');
  assert.ok(!String(result.error ?? '').includes('不支持的创作后端'));
});
