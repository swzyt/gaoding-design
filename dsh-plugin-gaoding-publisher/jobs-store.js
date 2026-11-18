/**
 * 创作任务与结果索引。
 * 任务由界面创建并冻结话题快照；执行由 Agent 通过 gaoding_jobs / gaoding_workflow 承接。
 * 状态一律从真实 run.json 派生，不在这里伪造进度。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const maxQuantity = 20;
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const runStatuses = new Set(['running', 'waiting_agent', 'attention', 'complete']);

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

export function jobsFile(dataRoot) { return join(dataRoot, 'jobs.json'); }
export function runsRoot(dataRoot) { return join(dataRoot, 'runs'); }

export function readStore(dataRoot) {
  const value = readJson(jobsFile(dataRoot), { schema: 1, jobs: [] });
  if (!value || !Array.isArray(value.jobs)) return { schema: 1, jobs: [] };
  return value;
}
function writeStore(dataRoot, store) { writeJson(jobsFile(dataRoot), store); }

/** 单个任务单元的真实状态：有 run.json 就以它为准，否则排队。 */
function unitStatus(unit, run) {
  if (!run) return unit.startedAt ? 'starting' : 'queued';
  const status = String(run.status ?? '');
  if (status === 'complete') return 'complete';
  if (status === 'waiting_agent') return 'waiting_agent';
  if (status === 'attention') return 'attention';
  if (status === 'running') return 'running';
  return status || 'running';
}

const statusRank = { queued: 0, starting: 1, running: 2, waiting_agent: 3, attention: 4, complete: 5 };

function aggregate(units) {
  if (!units.length) return 'queued';
  if (units.some(unit => unit.status === 'attention')) return 'attention';
  if (units.every(unit => unit.status === 'complete')) return 'complete';
  if (units.some(unit => unit.status === 'waiting_agent')) return 'waiting_agent';
  if (units.some(unit => unit.status === 'running' || unit.status === 'starting')) return 'running';
  return 'queued';
}

/** 读取任务并在读取时刷新状态；不写回，避免轮询产生无意义写入。 */
export function listJobs(dataRoot) {
  const store = readStore(dataRoot);
  const jobs = store.jobs.map(job => {
    const units = (job.units ?? []).map(unit => {
      const runFile = join(unit.directory, 'run.json');
      const run = readJson(runFile, null);
      const status = unitStatus(unit, run);
      return {
        ...unit,
        status,
        current: run?.current ?? null,
        elapsedSeconds: run?.elapsed_seconds ?? null,
        stages: run ? Object.fromEntries(Object.entries(run.stages ?? {}).map(([name, stage]) => [name, stage.state])) : null,
        runStatus: run?.status ?? null,
        promptState: (() => {
          const record = readJson(join(unit.directory, 'prompt.json'), null);
          if (!record) return 'missing';
          return record.confirmed === true ? 'confirmed' : 'written';
        })()
      };
    });
    return { ...job, units, status: aggregate(units), updatedAt: job.updatedAt ?? job.createdAt };
  });
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function assertKey(value, role) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw Error('Invalid ' + role);
  return value;
}

/**
 * 创建任务：每个话题按 quantity 生成独立单元（独立目录、独立快照），互不影响。
 * 话题必须来自当前实时目录，避免用历史列表造任务。
 */
/**
 * 从话题规范生成单个单元的创作要求：画布、方向、禁区、必备物料、用户备注。
 * 只做确定性抽取与轮转分配，不拼写图片 prompt——那一步留给 Agent。
 */
export function briefFor({ topic, spec, index, quantity, note }) {
  const directions = Array.isArray(spec?.directions) ? spec.directions : [];
  const canvas = Array.isArray(spec?.canvas) ? spec.canvas : [];
  const rotation = directions.length ? directions[(index - 1) % directions.length] : null;
  return {
    topic: topic.name,
    index,
    quantity,
    canvas: canvas.length ? canvas.map(row => row.label) : [],
    direction: rotation,
    directions: directions.slice(0, 6),
    forbidden: Array.isArray(spec?.forbidden) ? spec.forbidden.slice(0, 4) : [],
    materials: Array.isArray(spec?.materials) ? spec.materials.slice(0, 4) : [],
    note: String(note ?? ''),
    source: spec ? { fetchedAt: spec.fetchedAt ?? null, url: spec.url ?? null } : null
  };
}

export function createJobs({ dataRoot, topics, quantity = 1, note = '', catalogTopics = [], specs = {}, mode = 'manual', backend = 'gd-cli', now = new Date() }) {
  if (!['manual', 'auto'].includes(mode)) throw Error('模式只能是 manual 或 auto');
  // 出图后端要跟着任务走：否则重试时会退回 gd-cli，白花稿豆。
  if (!['gd-cli', 'image-gen', 'agent'].includes(backend)) throw Error('不支持的出图后端：' + backend);
  if (!Array.isArray(topics) || !topics.length) throw Error('至少选择一个话题');
  const count = Number(quantity);
  if (!Number.isInteger(count) || count < 1 || count > maxQuantity) throw Error('创作数量必须是 1 到 ' + maxQuantity + ' 的整数');
  const chosen = topics.map(key => {
    const topic = catalogTopics.find(row => row.key === key);
    if (!topic) throw Error('话题不在当前实时目录中：' + key);
    if (!topic.rules_url) throw Error('该话题没有规范链接，无法创建任务：' + (topic.name ?? key));
    return topic;
  });
  const batchId = 'job-' + new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 6);
  const dirs = [];
  const jobs = chosen.map(topic => {
    const units = Array.from({ length: count }, (_, index) => {
      const unitId = batchId + '-' + topic.key.slice(-6) + '-' + (index + 1);
      const directory = join(dataRoot, 'runs', unitId);
      mkdirSync(directory, { recursive: true });
      const topicFile = join(directory, 'topic.json');
      const brief = briefFor({ topic, spec: specs[topic.key] ?? null, index: index + 1, quantity: count, note });
      writeJson(topicFile, {
        ...topic,
        catalogSource: 'https://creator.huaban.com/inspiration',
        snapshotAt: new Date(now).toISOString(),
        requestedQuantity: count,
        note: String(note ?? '').slice(0, 500),
        brief
      });
      dirs.push(directory);
      return {
        id: unitId,
        index: index + 1,
        kind: topic.publishKind === 'material' ? 'material' : 'template',
        directory,
        topicFile,
        brief,
        args: ['auto', directory, '--topic', topic.key, '--topic-json', topicFile, '--mode', 'native', '--registration', 'agent'],
        startedAt: null
      };
    });
    return {
      id: batchId + '-' + topic.key.slice(-6),
      batchId,
      mode,
      createdAt: new Date(now).toISOString(),
      topic: { key: topic.key, name: topic.name, rules_url: topic.rules_url, type: topic.type ?? null },
      kind: topic.publishKind === 'material' ? 'material' : 'template',
      quantity: count,
      backend,
      note: String(note ?? '').slice(0, 500),
      status: 'queued',
      units
    };
  });
  const store = readStore(dataRoot);
  store.jobs = [...jobs, ...store.jobs].slice(0, 200);
  writeStore(dataRoot, store);
  return { batchId, jobs, directories: dirs };
}

export function removeJob(dataRoot, id) {
  assertKey(id, 'job id');
  const store = readStore(dataRoot);
  const job = store.jobs.find(row => row.id === id);
  if (!job) throw Error('任务不存在');
  if (job.units.some(unit => ['running', 'starting', 'waiting_agent', 'attention'].includes(unitStatus(unit, readJson(join(unit.directory, 'run.json'), null))))) {
    throw Error('任务仍在进行中，不能删除');
  }
  store.jobs = store.jobs.filter(row => row.id !== id);
  writeStore(dataRoot, store);
  // 只清理本任务创建且从未真正开始过的空目录，已有 run.json 的历史一律保留。
  const cleaned = [];
  for (const unit of job.units) {
    const name = unit.directory.split('/').pop() ?? '';
    if (!name.startsWith(job.id) || !existsSync(unit.directory)) continue;
    if (existsSync(join(unit.directory, 'run.json')) || existsSync(join(unit.directory, 'material.json'))) continue;
    rmSync(unit.directory, { recursive: true, force: true });
    cleaned.push(unit.directory);
  }
  return { removed: id, cleaned };
}

export function promptFileOf(unit) { return join(unit.directory, 'prompt.json'); }

export function readPromptOf(unit) {
  const value = readJson(promptFileOf(unit), null);
  return value && typeof value === 'object' ? value : null;
}

/** Agent 写入的单元 prompt；用户编辑会作废旧确认。 */
export function writePrompt(unit, payload, { by = 'agent', now = new Date() } = {}) {
  const prompt = String(payload?.prompt ?? '').trim();
  if (!prompt) throw Error('prompt 不能为空');
  if (prompt.length > 8000) throw Error('prompt 过长（上限 8000 字）');
  const previous = readPromptOf(unit);
  const record = {
    schema: 1,
    unitId: unit.id ?? null,
    topic: payload.topic ?? previous?.topic ?? null,
    direction: payload.direction ?? previous?.direction ?? unit.brief?.direction ?? null,
    title: String(payload.title ?? previous?.title ?? '').slice(0, 200),
    prompt,
    negative: String(payload.negative ?? previous?.negative ?? '').slice(0, 2000),
    layers: Array.isArray(payload.layers) ? payload.layers.slice(0, 30).map(row => ({ id: String(row?.id ?? '').slice(0, 60), role: row?.role ?? null, require_alpha: row?.require_alpha === true })).filter(row => row.id) : (previous?.layers ?? []),
    assets: Array.isArray(payload.assets) ? payload.assets.slice(0, 20).map(row => ({ id: String(row?.id ?? '').slice(0, 60), prompt: String(row?.prompt ?? '').slice(0, 4000) })).filter(row => row.id && row.prompt) : (previous?.assets ?? []),
    writtenAt: previous?.writtenAt ?? new Date(now).toISOString(),
    editedAt: by === 'user' ? new Date(now).toISOString() : (previous?.editedAt ?? null),
    source: by,
    revision: (previous?.revision ?? 0) + 1,
    confirmed: false,
    confirmedAt: null
  };
  writeJson(promptFileOf(unit), record);
  return record;
}

/** 用户确认，或在自动模式下由策略确认；auto 会记录来源，便于事后追溯。 */
export function confirmPrompts(job, { now = new Date(), by = 'user' } = {}) {
  const units = Array.isArray(job?.units) ? job.units : [];
  if (!units.length) throw Error('任务没有单元');
  const missing = units.filter(unit => !readPromptOf(unit));
  if (missing.length) throw Error('还有 ' + missing.length + ' 个单元没有 prompt，不能确认');
  const at = new Date(now).toISOString();
  return units.map(unit => {
    const record = readPromptOf(unit);
    const confirmed = { ...record, confirmed: true, confirmedAt: record.confirmedAt ?? at, confirmedBy: record.confirmedBy ?? by };
    writeJson(promptFileOf(unit), confirmed);
    return confirmed;
  });
}

/** 交给 Agent 执行的固定指令；不拼接创意内容，只描述任务与真实参数。 */
export function instructionFor(job) {
  const prompts = (job.units ?? []).map(unit => readPromptOf(unit));
  const written = prompts.filter(Boolean).length;
  if (written < prompts.length) {
    const lines = ['请为稿定创作任务 ' + job.id + '（话题：' + job.topic.name + '）的 ' + prompts.length + ' 个单元写创作 prompt，这一轮不生成图片。'];
    (job.units ?? []).forEach((unit, index) => {
      const brief = unit.brief ?? {};
      const parts = ['单元' + unit.index + '：方向「' + (brief.direction ?? '自定') + '」'];
      if (brief.canvas?.length) parts.push('画布 ' + brief.canvas.join('/'));
      if (brief.forbidden?.length) parts.push('禁止：' + brief.forbidden[0]);
      lines.push('- ' + parts.join('；') + ' → 调用 gaoding_prompts action=write unitId=' + JSON.stringify(unit.id));
    });
    if (job.kind === 'material') lines.push('这是素材话题：产出单张素材图，不需要文字层与模板分层；prompt 要说明素材类型、构图、色彩、透明区域与可叠加性。写完等用户在面板确认；不要提前生成图片，也不要自己确认。');
    else lines.push('prompt 要包含画面主体、构图、材质、色彩、文字层级与分层计划（哪些元素独立成层、哪些需要透明）。写完等用户在面板确认；不要提前生成图片，也不要自己确认。');
    return lines.join('\n');
  }
  if (prompts.some(record => record.confirmed !== true)) {
    return ['任务 ' + job.id + ' 的 ' + prompts.length + ' 个单元 prompt 已写完，正在等用户在面板确认。', '不要出图、不要自己确认；用户确认后你会收到包含执行参数的指令。'].join('\n');
  }
  const lines = ['请执行稿定创作任务 ' + job.id + '（话题：' + job.topic.name + '，共 ' + job.units.length + ' 个单元）。'];
  lines.push('每个单元的 prompt 已由用户确认并冻结在 prompt.json，创作与出图必须按它执行，不得擅自改方向：');
  for (const unit of job.units) lines.push('- 单元' + unit.index + '：' + promptFileOf(unit));
  if (job.note) lines.push('用户要求：' + job.note);
  if (job.kind === 'material') lines.push('这是素材话题：每个单元产出一张素材 PNG（尺寸按 prompt.json 与规范），贴纸类必须有透明背景，不需要原生文字层。产出后写 <单元目录>/material.json 记录 canvas、asset、sha256、alpha。');
  else lines.push('单元之间方向不同，避免同质化；分层必须满足每个对象单独成层、主体有透明区。');
  lines.push('按顺序对每个单元调用 gaoding_workflow：');
  for (const unit of job.units) lines.push('- ' + JSON.stringify(['auto', unit.directory, '--topic', job.topic.key, '--topic-json', unit.topicFile, '--mode', 'native', '--registration', 'agent', '--watch']));
  lines.push('走 native 路线：研究、创作、分层、登记、导入与验收都按 WORKFLOW 执行；gate 需要你实看证据后回答。完成后回报每个单元的作品链接、审核状态与材料路径。');
  return lines.join('\n');
}

function imageOf(directory) {
  const candidates = [];
  const build = join(directory, 'build');
  if (existsSync(build)) {
    for (const concept of readdirSync(build)) {
      for (const name of ['master.jpg', 'preview.jpg', 'editorial-preview.jpg', 'focus-preview.jpg']) {
        const file = join(build, concept, name);
        if (existsSync(file)) candidates.push(file);
      }
      const previews = join(build, concept, 'layout-previews');
      if (existsSync(previews)) {
        const first = readdirSync(previews).find(name => /\.(jpg|jpeg|png)$/i.test(name));
        if (first) candidates.push(join(previews, first));
      }
      const release = join(build, concept, 'release');
      for (const name of ['preview.jpg', 'preview-small.jpg', 'editor-ready.png']) {
        const file = join(release, name);
        if (existsSync(file)) candidates.push(file);
      }
    }
  }
  return candidates[0] ?? null;
}

/** 结果列表：直接扫描 runs 目录，任何来源的运行都能列出来。 */
export function listRuns(dataRoot) {
  const root = runsRoot(dataRoot);
  if (!existsSync(root)) return [];
  const rows = [];
  for (const name of readdirSync(root)) {
    const directory = join(root, name);
    let stats;
    try { stats = statSync(directory); } catch { continue; }
    if (!stats.isDirectory()) continue;
    const run = readJson(join(directory, 'run.json'), null);
    const material = run ? null : readJson(join(directory, 'material.json'), null);
    const creation = run || material ? null : readJson(join(directory, 'creation.json'), null);
    if (!run && !material && !creation) continue;
    if (creation) {
      rows.push({
        directory, name, kind: 'template', topic: creation.topic ?? null,
        status: creation.status ?? 'complete', current: creation.layers ? creation.layers + ' 层' : null,
        createdAt: creation.createdAt ?? null,
        stagesDone: 1, startedAt: creation.createdAt ?? null, completedAt: null, elapsedSeconds: null,
        preview: creation.previewLocal ?? creation.preview ?? null, hasRelease: true
      });
      continue;
    }
    if (material) {
      rows.push({
        directory,
        name,
        kind: 'material',
        topic: material.topic ?? null,
        status: material.status ?? 'complete',
        current: material.canvas ? material.canvas.w + '×' + material.canvas.h : null,
        stagesDone: 1,
        startedAt: material.createdAt ? new Date(material.createdAt).toISOString() : null,
        completedAt: null,
        elapsedSeconds: null,
        preview: existsSync(join(directory, material.asset ?? 'asset.png')) ? join(directory, material.asset ?? 'asset.png') : null,
        hasRelease: false
      });
      continue;
    }
    const stages = run.stages ?? {};
    const done = Object.entries(stages).filter(([, stage]) => stage?.state === 'done').map(([stage]) => stage);
    rows.push({
      directory,
      name,
      topic: run.requested_topic ?? run.topic_snapshot?.name ?? null,
      status: run.status ?? null,
      current: run.current ?? null,
      stagesDone: done.length,
      startedAt: run.started_at ? new Date(run.started_at * 1000).toISOString() : null,
      completedAt: run.completed_at ? new Date(run.completed_at * 1000).toISOString() : null,
      elapsedSeconds: run.elapsed_seconds ?? null,
      preview: imageOf(directory),
      hasRelease: existsSync(join(directory, 'release'))
    });
  }
  // 把投稿状态叠到结果行上：创作完成不等于投稿完成，面板要能看出「已创作待投稿」。
  const tasks = listPublishTasks(dataRoot);
  for (const row of rows) {
    const task = tasks.find(item => resolve(item.runDir) === resolve(row.directory));
    row.created = Boolean(row.kind === 'material' || row.status === 'complete');
    row.publishTaskId = task?.id ?? null;
    row.publishState = task ? task.status : null;
    row.contentId = task?.publication?.contentId ?? null;
    row.declarationStatus = task?.publication?.declarationStatus ?? null;
    row.stage = !row.created ? 'creating'
      : !task ? 'created'                                   // 创作完成，还没投稿
        : task.status === 'published' ? 'published'
          : task.status === 'submitting' ? 'publishing'
            : task.status === 'uncertain' ? 'uncertain' : 'ready';
  }
  return rows.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
}

export const publishStatusText = {
  queued: '待投稿', submitting: '投稿中', uncertain: '结果不确定（需核对）', published: '已投稿', cancelled: '已取消'
}

export function publishFile(dataRoot) { return join(dataRoot, 'publish-jobs.json'); }

function readPublishStore(dataRoot) {
  const value = readJson(publishFile(dataRoot), { schema: 1, tasks: [] });
  return value && Array.isArray(value.tasks) ? value : { schema: 1, tasks: [] };
}
function writePublishStore(dataRoot, store) { writeJson(publishFile(dataRoot), store); }

/** 投稿状态只看 publication.json 的真实阶段，不从任务表推断。 */
export function markPublishCancelled(dataRoot, id) {
  const store = readPublishStore(dataRoot);
  const task = store.tasks.find(row => row.id === id);
  if (!task) throw Error('投稿任务不存在');
  const current = publishStatus(task.release);
  if (current.status !== 'queued') throw Error('该任务已经开始投稿，不能取消；请等它结束');
  task.cancelledAt = new Date().toISOString();
  writePublishStore(dataRoot, store);
  return { cancelled: id };
}

export function publishStatus(releaseDir) {
  // 插件模板稿把 publication.json 写在运行目录根上，任务记的 release 是 release/，
  // 所以两处都要看，否则已投稿的模板会一直显示「待投稿」。
  const directories = [releaseDir, resolve(releaseDir, '..')];
  let publication = null;
  for (const directory of directories) {
    publication = readJson(join(directory, 'publication.json'), null);
    if (publication) break;
  }
  if (!publication) {
    // 0.19.0–0.19.2 的素材发布记录误写到了 release 子目录，不能重新显示待投稿。
    const legacy = readJson(join(releaseDir, 'release', 'publication.json'), null);
    if (legacy?.published || legacy?.submissionStartedAt || legacy?.stage === 'submission-started') {
      return { status: 'uncertain', publication: { ...legacy, reconciliationRequired: true } };
    }
    const attempt = readJson(join(releaseDir, 'publish', 'submission-attempt.json'), null);
    if (attempt) return { status: 'uncertain', publication: { stage: attempt.stage, attemptId: attempt.attemptId, contentId: attempt.result?.content?.id ?? null, error: attempt.result?.error ?? null } };
    return { status: 'queued', publication: null };
  }
  if (publication.published === true) return { status: 'published', publication };
  if (publication.stage === 'submission-started' || (publication.submissionStartedAt && !publication.published)) {
    return { status: 'uncertain', publication };
  }
  if (publication.stage) return { status: 'submitting', publication };
  return { status: 'queued', publication };
}

export function listPublishTasks(dataRoot) {
  return readPublishStore(dataRoot).tasks.map(task => {
    const current = publishStatus(task.release);
    const status = task.cancelledAt && current.status === 'queued' ? 'cancelled' : current.status;
    return { ...task, ...current, status };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 只有通过投稿前检查的运行才能创建投稿任务。 */
export function createPublishTask({ dataRoot, runDir, summary, now = new Date() }) {
  const material = summary?.kind === 'material';
  if (!summary?.release) throw Error('运行缺少发布目录');
  if (!material && !summary?.recipe) throw Error('模板运行缺少发布配方');
  const store = readPublishStore(dataRoot);
  const existing = store.tasks.find(task => resolve(task.runDir) === resolve(runDir));
  if (existing) {
    const current = publishStatus(existing.release);
    if (current.status !== 'queued') throw Error('该运行已经创建过投稿任务（' + (publishStatusText[current.status] || current.status) + '）');
    return { task: { ...existing, ...current }, reused: true };
  }
  const task = {
    id: 'pub-' + new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 6),
    createdAt: new Date(now).toISOString(),
    runDir: resolve(runDir),
    concept: summary.concept,
    release: summary.release,
    recipe: summary.recipe,
    topic: summary.topic ?? null,
    canvas: summary.canvas ?? null,
    kind: material ? 'material' : 'template',
    images: summary.images ?? 0,
    texts: summary.texts ?? 0,
    canvas: summary.canvas ?? null,
    asset: summary.asset ?? null,
    instruction: material
      ? materialPublishInstruction({ runDir: resolve(runDir), asset: summary.asset, topic: summary.topic ?? '', canvas: summary.canvas })
      : summary.plugin
        ? pluginTemplateInstruction({ runDir: resolve(runDir), recipe: summary.recipe, topic: summary.topic ?? '', images: summary.images ?? 0, texts: summary.texts ?? 0 })
        : publishInstruction({ runDir: resolve(runDir), recipe: summary.recipe, topic: summary.topic ?? '', images: summary.images ?? 0 })
  };
  store.tasks = [task, ...store.tasks].slice(0, 100);
  writePublishStore(dataRoot, store);
  return { task: { ...task, ...publishStatus(task.release) }, reused: false };
}

export function removePublishTask(dataRoot, id) {
  assertKey(id, 'publish task id');
  const store = readPublishStore(dataRoot);
  const task = store.tasks.find(row => row.id === id);
  if (!task) throw Error('投稿任务不存在');
  const current = publishStatus(task.release);
  if (!['queued', 'cancelled'].includes(current.status)) throw Error('该任务已经开始投稿，不能删除；请到发布管理核对真实状态');
  store.tasks = store.tasks.filter(row => row.id !== id);
  writePublishStore(dataRoot, store);
  return { removed: id };
}

/** 素材投稿指令：发布弹窗 → 本地上传 → 发布为素材 → 话题 → 原创声明。 */
export function materialPublishInstruction({ runDir, asset, topic, canvas }) {
  return [
    '请把素材投稿到稿定：' + (topic || ''),
    '素材文件：' + (asset || join(runDir, 'asset.png')),
    canvas ? '画布：' + canvas.w + '×' + canvas.h : '',
    '1. 打开创作者中心右上角「发布」，弹出「发布作品」；',
    '2. 点「本地上传」选择上面的素材文件（png/jpg/jpeg/psd/ai）；',
    '3. 发布类型选「素材」（可被独立使用的设计元素/文件），不要选「模板」；',
    '4. 补标题与描述，选择素材话题「' + (topic || '') + '」；',
    '5. 原创声明：按实际来源上传创作过程截图或原文件，图片分类必须与真实来源一致；',
    '6. 提交后到「我的-发布」核对真实状态；不确定先查，禁止重复提交。',
    '注意：发布需要 gaoding.com 的 SSO 登录态，创作者中心登录不等于编辑器登录。'
  ].filter(Boolean).join('\n');
}

/** 投稿指令：固定按层的版权声明要求，不在这里替代 Agent 的实际操作。 */
/** 插件自建模板稿：先导入编辑器，再在编辑器里发布；平台对模板不强制逐层版权声明。 */
export function pluginTemplateInstruction({ runDir, recipe, topic, images, texts }) {
  return [
    '请把已完成的模板稿投稿到稿定：' + (topic || ''),
    '运行目录：' + runDir,
    '发布配方：' + recipe,
    '1. 本稿由插件本地生成（' + images + ' 个程序原创图片层 + ' + texts + ' 个原生文字层），未接入仓库原生工作流；',
    '2. 发布前会先把 PSD 导入编辑器取得设计地址（browser prepare），再在编辑器内「发布」；',
    '3. 话题必须精确挂到「' + (topic || '') + '」，文字必须保持可编辑原生文字；',
    '4. 平台对模板不强制逐层版权声明，可在发布后按需完善；',
    '5. 提交后到「我的-发布」核对真实状态，不确定先查，禁止重复提交。'
  ].join('\n');
}

export function publishInstruction({ runDir, recipe, topic, images }) {
  const gate = join(runDir, 'gates', '04-final');
  return [
    '请把已完成的稿子投稿到稿定：' + (topic || ''),
    '运行目录：' + runDir,
    '发布配方：' + recipe,
    '1. 复用同一 ego-browser TaskSpace，先查真实编辑器页标签，不要覆盖编辑器页；',
    '2. 运行：browser-batch form,submit,declare,verify ' + JSON.stringify(recipe) + ' --space <实际空间ID> --page <实际编辑器页> --final-review-gate ' + JSON.stringify(gate),
    '3. 版权按元素层级声明：本稿 ' + images + ' 个图片层，候选数量必须等于图片层数，逐层核对 original / original_ai 分类后上传真实证明；',
    '4. 提交前用真实页面确认话题、活动与 AI 标记；结果不确定时先查发布管理，禁止重复提交。'
  ].join('\n');
}
