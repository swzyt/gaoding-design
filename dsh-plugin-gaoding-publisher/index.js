import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pluginRoot, workspace, dataRoot, runtimeHome, workflow, readJson, writeJson, launch, status } from './runtime-host.js';
import { loadCatalog, catalogIsFresh } from './topic-catalog.js';
import { readIndex, readSpec, readFailures, refreshSpecs } from './spec-catalog.js';
import { probeSession, openLogin } from './browser-session.js';
import { listJobs, createJobs, removeJob, instructionFor, listRuns, maxQuantity, runsRoot, listPublishTasks, createPublishTask, removePublishTask, publishStatus, markPublishCancelled, readPromptOf, writePrompt, confirmPrompts, promptFileOf } from './jobs-store.js';
import { checkRun } from './publish-check.js';
import { ensureSpace } from './browser-space.js';
import { layerFingerprint, preflightTemplateDeclaration, readDeclarationRecords, writeDeclarationPlan } from './template-declaration.js';
import { createImageClient, fillAssetRequest } from './image-client.js';
import { createPreflight } from './preflight.js';
import { generateUnitPrompt } from './prompt-writer.js';
import { creatorStatus, createMaterialUnit, buildImageInput, defaultModel } from './creator.js';
import { listPublished, summarize } from './published.js';
import { createTemplateUnit } from './template-recipe.js';
import { publishMaterial, withdrawContent } from './publisher.js';
import { reconcilePublication } from './publication-reconcile.js';
import { abandonUnsubmittedAttempt, priorPublication } from './publication-safety.js';
import { publishTemplate } from './template-publish.js';
import { executeAutoPipeline } from './auto-publish.js';
import { createQueue, readQueue, requestStop, runQueue, summarizeQueue } from './publish-queue.js';
import { assetState } from './asset-handoff.js';
import { ensureEditorImport } from './editor-import.js';
import { execFile } from 'node:child_process';

export const name = 'dsh-plugin-gaoding-publisher';
export const inject = ['tools'];
const catalogFile = join(dataRoot, 'catalog', 'topics.json');
const sessionFile = join(dataRoot, 'catalog', 'session.json');

async function catalog(options = {}) {
  // dropSpace: 记录的空间已消失时，读缓存也要忘掉旧空间绑定，否则浏览器路径会一直指向它。
  const read = () => {
    const value = readJson(catalogFile);
    if (!options.dropSpace || !value || value.space === undefined) return value;
    const { space, ...rest } = value;
    return rest;
  };
  return loadCatalog({ read, write: value => writeJson(catalogFile, value), ...options });
}

function withRuns(value) {
  const runs = existsSync(join(dataRoot, 'runs')) ? readdirSync(join(dataRoot, 'runs')).map(d => readJson(join(dataRoot, 'runs', d, 'run.json'))).filter(Boolean) : [];
  const topics = value.topics.map(t => ({ ...t, completedRuns: runs.filter(r => (r.requested_topic === t.name || r.stages?.research_collect?.result?.topic?.name === t.name) && r.status === 'complete').length }));
  return { ...value, topics };
}

// 宿主 LLM 与默认模型：面板点一下就能生成 prompt，不必经过对话 Agent。
let llmService = null;
let modelSelection = null;
const generations = new Map();

function selectionNow() {
  try { return modelSelection?.currentSelection?.() ?? null; } catch { return null; }
}

/** 后台为任务的每个单元生成 prompt；单题失败只记录，不中断其余单元。 */
async function generateJobPrompts(job, { force = false } = {}) {
  if (generations.get(job.id)?.running) return generations.get(job.id);
  const state = { running: true, total: job.units.length, done: 0, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  generations.set(job.id, state);
  try {
    const spec = readSpec(dataRoot, job.topic?.key);
    const selection = selectionNow();
    for (const unit of job.units) {
      if (!force && readPromptOf(unit)) { state.done++; continue; }
      await generateUnitPrompt({ job, unit, spec, llm: llmService, selection });
      state.done++;
    }
  } catch (error) { state.error = String(error?.message ?? error); }
  finally { state.running = false; state.finishedAt = new Date().toISOString(); }
  return state;
}

// 自动模式：prompt → 自动确认 → 创作，一条链跑完；发布步骤另行处理。
const pipelines = new Map();

async function runAutoPipeline(jobId, { model = defaultModel, backend = 'gd-cli', recreate = false } = {}) {
  return executeAutoPipeline(jobId, { model, backend, recreate }, {
    pipelines, dataRoot, listJobs, listPublishTasks, checkRun, createPublishTask,
    generateJobPrompts, confirmPrompts, runCreation, runPublish, publishRuns,
    readJson, writeJson, instructionFor
  });
}

// 创作执行：只有用户确认后才调用（消耗稿豆），进度供面板轮询。
const creations = new Map();
let imageClient = null;
let preflight = null;

function withPrompts(job) {
  return { ...job, units: job.units.map(unit => ({ ...unit, prompt: readPromptOf(unit) })) };
}

async function runCreation(rawJob, { model = defaultModel, backend = 'gd-cli' } = {}) {
  const job = withPrompts(rawJob);
  const units = job.units.filter(unit => unit.promptState === 'confirmed');
  const template = job.kind !== 'material';
  const state = { running: true, total: units.length, done: 0, failed: [], error: null, startedAt: new Date().toISOString(), finishedAt: null, model, kind: job.kind };
  creations.set(job.id, state);
  try {
    for (const unit of units) {
      let attempt = 0;
      while (attempt < 2) {
        attempt++;
        try {
          if (template) await createTemplateUnit({ unit, llm: llmService, selection: selectionNow(), job });
          else await createMaterialUnit({ unit, model, backend, python: join(runtimeHome, '.venv/bin/python') });
          state.done++;
          break;
        } catch (error) {
          // 平台明确要求「不要重复提交相同请求」：内容审核被拒不重试，
          // 只把原因和改法如实报出来（负向词含敏感分类是最常见的诱因）。
          if (error?.code === 'ASSETS_WAITING') {
            // 插件自己出图：复用 DSH 图像插件的订阅凭据，全自动不再等人。
            if (backend === 'image-gen' && imageClient && !state.selfGenerated?.includes(unit.id)) {
              const request = readJson(join(unit.directory, 'generated-assets', 'request.json'));
              if (request?.assets?.length) {
                state.step = 'generating-assets:' + unit.id;
                state.assetProgress = { unit: unit.id, total: request.assets.length, done: 0 };
                try {
                  const filled = await fillAssetRequest({
                    client: imageClient,
                    runDir: unit.directory,
                    request,
                    python: join(runtimeHome, '.venv/bin/python'),
                    onProgress: progress => { state.assetProgress = { unit: unit.id, ...progress }; }
                  });
                  state.selfGenerated = [...(state.selfGenerated ?? []), unit.id];
                  state.steps = [...(state.steps ?? []), 'assets-generated:' + unit.id + ':' + (filled.assets?.length ?? 0)];
                  attempt = 0;
                  continue;
                } catch (generateError) {
                  // 凭据缺失/请求失败：退回交接模式，让 Agent 出图，错误如实记录。
                  state.selfGenerationError = String(generateError?.message ?? generateError);
                }
              }
            }
            state.failed.push({
              unit: unit.id,
              error: String(error?.message ?? error),
              code: error.code,
              request: error.request?.assets?.map(row => row.id) ?? null,
              problems: error.problems ?? null
            });
            break;
          }
          if (error?.code === 'CONTENT_AUDIT') {
            state.failed.push({
              unit: unit.id,
              error: String(error?.message ?? error) + '（内容审核拒绝：请调整正文或去掉负向词里的敏感分类，不要原样重发）',
              code: error.code
            });
            break;
          }
          // 网络/限流类失败：短退避后重试一次。
          if (error?.code === 'TRANSIENT' && attempt < 2) {
            state.retried = (state.retried ?? 0) + 1;
            await new Promise(resolve => setTimeout(resolve, 20000));
            continue;
          }
          state.failed.push({
            unit: unit.id,
            error: String(error?.message ?? error),
            code: error?.code ?? null,
            request: error?.code === 'ASSETS_WAITING' ? error.request?.assets?.map(row => row.id) ?? null : null,
            problems: error?.problems ?? null
          });
          break;
        }
      }
    }
    if (state.failed.length && !state.done) state.error = state.failed[0].error;
  } finally { state.running = false; state.finishedAt = new Date().toISOString(); }
  return state;
}

// 规范抓取是单飞后台任务：同一时刻只允许一批，进度供面板轮询。
let specJob = null;
function jobView() { return specJob ? { ...specJob } : null; }
function startSpecRefresh(topics, force) {
  specJob = { running: true, total: topics.length, done: 0, ok: 0, failed: 0, skipped: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null, failures: [] };
  const job = specJob;
  refreshSpecs({
    topics, dataRoot, force, concurrency: 4,
    onProgress: progress => Object.assign(job, progress)
  }).then(result => {
    job.running = false; job.finishedAt = new Date().toISOString(); job.failures = result.failed;
  }).catch(error => {
    job.running = false; job.finishedAt = new Date().toISOString(); job.error = String(error?.message ?? error);
  });
  return jobView();
}

async function jsonBody(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 1_000_000) throw Error('请求体过大');
  }
  return data ? JSON.parse(data) : {};
}

function send(response, code, value) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

const output = { schema: { type: 'object' }, render(_a, v) { return [{ type: 'text', text: JSON.stringify(v, null, 2) }]; } };

export const tools = [{
  name: 'gaoding_topics',
  description: '列出稿定话题和规范摘要，返回本插件的完整 Agent 指引、运行路径与依赖状态。制作/投稿前先读返回的 guide 和 workflowGuide；用户已选题或授权随机选择时不要重复询问。',
  parameters: { type: 'object', properties: { space: { type: 'number', description: '复用当前目标的实际 TaskSpace ID；返回的 space 必须供后续制作复用' }, refresh: { type: 'boolean', description: '强制重新请求目录' }, snapshot: { type: 'object', description: '当前登录浏览器实际读取的目录快照；source=https://creator.huaban.com/inspiration，checkedAt=ISO 时间，complete=是否完整，payload=目录 API JSON（或 topics 数组）', properties: { source: { type: 'string' }, checkedAt: { type: 'string' }, complete: { type: 'boolean' }, payload: { type: 'object' }, topics: { type: 'array', items: { type: 'object' } } }, required: ['source', 'checkedAt', 'complete'] } }, additionalProperties: false }, output,
  async execute(args = {}) { return { ...withRuns(await catalog(args)), catalogFile, workspace, dataRoot, runtimeHome, workflow, workflowGuide: join(workspace, 'pipeline/workflow/WORKFLOW.md'), guide: readFileSync(join(pluginRoot, 'skill/SKILL.md'), 'utf8'), dependenciesInstalled: existsSync(join(runtimeHome, '.venv/bin/python')) }; }
}, {
  name: 'gaoding_subscribe',
  description: '记录当前实时目录中选中的话题，冻结每题快照；默认原生分层与浏览器素材登记，不调用GD CLI。space复用目录返回空间；repositoryId仅在已查到真实ID时提供。登记不代表投稿，随后执行返回的工作流参数。',
  parameters: { type: 'object', additionalProperties: false, required: ['topics', 'space'], properties: { topics: { type: 'array', items: { type: 'string' }, description: 'gaoding_topics 返回的 key 数组' }, space: { type: 'number', description: '本次 ego-browser TaskSpace ID' }, repositoryId: { type: 'string', description: '当前用户实际 DAM 资源库 ID' } } }, output,
  async execute(args) {
    if (!Number.isInteger(args.space) || args.space < 0) throw Error('Actual TaskSpace required');
    const current = await catalog({ space: args.space });
    if (current.status === 'unavailable' || !catalogIsFresh(current)) throw Error('Live topic catalog unavailable; refresh gaoding_topics in the current browser');
    const all = current.selectableTopics; const keys = [...new Set(args.topics || [])];
    if (!keys.length || keys.some(k => !all.some(t => t.key === k))) throw Error('Unknown, inactive or empty topic selection');
    if (args.repositoryId !== undefined && !args.repositoryId.trim()) throw Error('DAM repository ID must be nonempty when supplied');
    const id = 'sub-' + randomUUID();
    const jobs = keys.map(key => {
      const topic = all.find(t => t.key === key), directory = join(dataRoot, 'runs', id + '-' + key);
      const topicFile = join(dataRoot, 'subscriptions', id, key + '.json');
      writeJson(topicFile, { ...topic, catalogSource: current.source, catalogCheckedAt: current.checkedAt });
      return { topic: key, topicFile, directory, args: ['auto', directory, '--topic', key, '--topic-json', topicFile, '--space', String(args.space), '--mode', 'native', '--registration', 'agent', ...(args.repositoryId ? ['--repository-id', args.repositoryId] : []), '--watch'] };
    });
    const job = { id, createdAt: new Date().toISOString(), topics: keys, space: args.space, repositoryId: args.repositoryId ?? null, status: 'queued', jobs };
    const file = join(dataRoot, 'subscriptions', id + '.json'); writeJson(file, job);
    return { job, file, instructions: '串行启动 jobs；gaoding_workflow 立即返回，用 ["status",directory] 查询。等 gate 时 Agent 读证据、看图并写真实验收结果。不要手改 run.json 跳阶段。' };
  }
}, {
  name: 'gaoding_workflow',
  description: '执行打包的稿定工作流。除 status 外命令均后台启动并立即返回 directory；用 ["status",directory] 查询进程、run.json、待处理 gate 和日志。首次 ["bootstrap"]，完成后 ["doctor"]；auto 使用订阅返回的 args。不要将启动成功当作生产完成。',
  parameters: { type: 'object', additionalProperties: false, required: ['args'], properties: { args: { type: 'array', items: { type: 'string' }, description: 'workflow.sh 参数；status 的第二项为运行目录或返回的操作目录' } } }, output,
  async execute({ args }) {
    if (!Array.isArray(args) || !args.length || args.some(x => typeof x !== 'string')) throw Error('args must be a nonempty string array');
    if (args[0] === 'status') { if (args.length !== 2) throw Error('status requires one directory'); return status(args[1]); }
    const allowed = ['bootstrap', 'doctor', 'auto', 'recover-space', 'job', 'localize', 'build', 'preview', 'review-packet', 'register', 'receipts', 'masters', 'browser', '--help'];
    if (!allowed.includes(args[0])) throw Error('Unsupported workflow command');
    return launch(args);
  }
}, {
  name: 'gaoding_jobs',
  description: '读取面板里排队中的创作任务和待投稿任务。action=list 返回创作任务（话题、数量、每个单元的精确参数与执行指令）；action=publish 返回待投稿任务（含 run 目录、配方与按层版权声明要求）。执行仍走 gaoding_workflow 与 browser-batch，不在这里伪造进度。',
  parameters: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['list', 'publish'], description: 'list 读创作任务；publish 读待投稿任务' } } }, output,
  async execute(args = {}) {
    if (args.action === 'publish') {
      const tasks = listPublishTasks(dataRoot).filter(task => task.status !== 'published');
      return { tasks: tasks.map(task => ({ id: task.id, topic: task.topic, status: task.status, runDir: task.runDir, recipe: task.recipe, images: task.images, instruction: task.instruction })) };
    }
    const jobs = listJobs(dataRoot).filter(job => job.status !== 'complete');
    return { jobs: jobs.map(job => ({ id: job.id, topic: job.topic, quantity: job.quantity, status: job.status, note: job.note, instruction: instructionFor(job), units: job.units.map(unit => ({ id: unit.id, directory: unit.directory, args: unit.args, status: unit.status })) })) };
  }
}, {
  name: 'gaoding_prompts',
  description: '创作 prompt 交接：action=list 读取等待写 prompt 或等待用户确认的任务；action=write 把某个单元的完整创作 prompt 写入运行目录（不生成图片）。确认动作只有用户能在面板完成，Agent 不得自行确认。',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['list', 'write'], description: 'list 读待写/待确认任务；write 写入单元 prompt' },
    unitId: { type: 'string', description: 'write 必填：单元 ID，来自 list 或 gaoding_jobs' },
    prompt: { type: 'string', description: 'write 必填：完整图片 prompt（主体、构图、材质、色彩、文字层级）' },
    negative: { type: 'string', description: '可选：禁止出现的元素' },
    title: { type: 'string', description: '可选：作品标题' },
    direction: { type: 'string', description: '可选：本单元方向，默认取冻结的创作要求' },
    layers: { type: 'array', items: { type: 'object' }, description: '可选：分层计划 [{id,role,require_alpha}]' },
    assets: { type: 'array', items: { type: 'object' }, description: '可选：分层素材 prompt [{id,prompt}]' }
  } }, output,
  async execute(args = {}) {
    if (args.action === 'write') {
      const unitId = String(args.unitId ?? '');
      const found = findUnit(unitId);
      if (!found) throw Error('找不到单元：' + unitId);
      const record = writePrompt(found.unit, args, { by: 'agent' });
      return { unitId, path: promptFileOf(found.unit), prompt: record.prompt, revision: record.revision, next: '等用户在面板确认后再执行 gaoding_workflow' };
    }
    const jobs = listJobs(dataRoot).map(job => {
      const units = job.units.map(unit => ({ id: unit.id, index: unit.index, direction: unit.brief?.direction ?? null, promptState: unit.promptState, path: promptFileOf(unit) }));
      const pending = units.some(unit => unit.promptState !== 'confirmed');
      return pending ? { id: job.id, topic: job.topic, units, awaiting: units.every(unit => unit.promptState === 'written') ? 'user-confirmation' : 'agent-prompts' } : null;
    }).filter(Boolean);
    return { jobs };
  }
}];

function findUnit(unitId) {
  if (!unitId) return null;
  for (const job of listJobs(dataRoot)) {
    const unit = job.units.find(row => row.id === unitId);
    if (unit) return { job, unit };
  }
  return null;
}

async function topicsHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  const url = new URL(request.url, 'http://localhost');
  const refresh = url.searchParams.get('refresh') === '1';
  const record = readJson(sessionFile);
  try {
    let value = await catalog({ refresh, space: record?.space });
    // 记录的空间可能已消失：清掉绑定，用一个新空间重取一次。
    if (value.status === 'unavailable' && record?.space !== undefined) value = await catalog({ refresh: true, dropSpace: true });
    if (Number.isInteger(value.space)) writeJson(sessionFile, { ...(record ?? {}), space: value.space });
    send(response, 200, withRuns(value));
  } catch (error) { send(response, 500, { status: 'unavailable', topics: [], error: error.message }); }
}

function specsHandler(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  const key = url.searchParams.get('key');
  try {
    if (key) {
      const spec = readSpec(dataRoot, key);
      if (!spec) return send(response, 404, { error: '该话题还没有抓取规范' });
      return send(response, 200, spec);
    }
    const index = readIndex(dataRoot);
    const catalogValue = readJson(catalogFile);
    const topics = Array.isArray(catalogValue?.topics) ? catalogValue.topics : [];
    const withRules = topics.filter(topic => topic.rules_url);
    const have = new Set(index.map(row => row.key));
    return send(response, 200, {
      status: 'ok',
      index,
      failures: readFailures(dataRoot),
      count: index.length,
      covered: withRules.filter(topic => have.has(topic.key)).length,
      expected: withRules.length,
      missing: withRules.filter(topic => !have.has(topic.key)).map(topic => topic.key),
      job: jobView()
    });
  } catch (error) { return send(response, 500, { error: String(error?.message ?? error) }); }
}

function refreshHandler(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  if (specJob?.running) return send(response, 409, { error: '规范抓取正在进行中', job: jobView() });
  const catalogValue = readJson(catalogFile);
  const key = url.searchParams.get('key');
  const topics = (Array.isArray(catalogValue?.topics) ? catalogValue.topics : [])
    .filter(topic => topic.rules_url && (!key || topic.key === key));
  if (!topics.length) return send(response, 409, { error: key ? '这个话题没有可抓取的规范链接' : '还没有可用的实时话题目录，请先刷新话题' });
  const force = url.searchParams.get('force') === '1';
  return send(response, 202, { started: true, job: startSpecRefresh(topics, force) });
}

function sessionHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  const record = readJson(sessionFile);
  if (!record) return send(response, 200, { loggedIn: null, checkedAt: null, space: null, hint: '尚未检查登录状态' });
  return send(response, 200, record);
}

async function probeHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  let value;
  try {
    // 空间可能因为浏览器重启失效：统一走解析，必要时自动重建后再探测登录态。
    const space = await currentSpace({ force: true });
    value = await probeSession({ space });
  } catch (error) { return send(response, 503, { error: String(error?.message ?? error) }); }
  writeJson(sessionFile, { ...(readJson(sessionFile) ?? {}), ...value });
  return send(response, 200, { ...value, spaceResolved: true });
}

async function loginHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  const previous = readJson(sessionFile);
  try {
    const value = await openLogin({ space: previous?.space });
    writeJson(sessionFile, { ...(previous ?? {}), ...value, checkedAt: new Date().toISOString() });
    return send(response, 200, value);
  } catch (error) { return send(response, 503, { error: String(error?.message ?? error) }); }
}

/** 单元素材交接状态（只读）：没请求 / 等回执 / 已就绪。 */
function assetStateOf(unit) {
  try {
    const prompt = readPromptOf(unit);
    if (!prompt?.assets?.length) return null;
    const brief = unit.brief ?? {};
    const match = /^(\d{3,5})\s*[×x]\s*(\d{3,5})$/.exec(String(brief.canvas?.[0] ?? '').replace(/\s/g, ''));
    const canvas = match ? { w: Number(match[1]), h: Number(match[2]) } : { w: 1242, h: 1656 };
    return assetState({ runDir: unit.directory, unit: { ...unit, prompt }, canvas });
  } catch { return null; }
}

/** 给声明计划的每个图层补 aHash（按 layer-manifest 里的文件路径算）。 */
async function attachPerceptualHashes({ plan, runDir }) {
  const manifest = readJson(join(runDir, 'release', 'layer-manifest.json'));
  if (!Array.isArray(manifest) || !Array.isArray(plan?.categories)) return;
  const python = join(runtimeHome, '.venv/bin/python');
  const byName = new Map(manifest.map(row => [row.name, row]));
  for (const group of plan.categories) {
    group.perceptual = [];
    for (const name of group.layerNames ?? []) {
      const row = byName.get(name);
      if (!row?.file) continue;
      const fingerprint = await layerFingerprint(join(runDir, 'release', row.file), python);
      if (fingerprint) group.perceptual.push({ name, ...fingerprint });
    }
  }
}


/**
 * 单元的真实进度：不能只看 run.json —— 投稿是另一条记录，
 * 已发布 / 待投稿 / 等素材 必须在任务列表里如实反映，否则面板会一直显示「排队中」。
 */
function unitProgressOf(unit, publishTasks) {
  const creation = creations.get(unit.jobId);
  const task = (publishTasks ?? []).find(row => row.runDir && resolve(row.runDir) === resolve(unit.directory));
  const publication = task?.publication ?? null;
  const contentId = publication?.contentId ?? null;
  const created = existsSync(join(unit.directory, 'creation.json')) || existsSync(join(unit.directory, 'run.json'));
  const material = existsSync(join(unit.directory, 'material.json'));
  const assets = assetStateOf(unit);
  let stage = 'queued';
  if (contentId) stage = 'published';
  else if (task?.status === 'submitting') stage = 'publishing';
  else if (created || material) stage = 'created';
  else if (creation?.running) stage = 'creating';
  else if (assets && assets.requested > 0 && assets.ready < assets.requested) stage = 'waiting-assets';
  else if (creation?.failed?.some(row => row.unit === unit.id && row.code === 'ASSETS_WAITING')) stage = 'waiting-assets';
  else if (creation?.failed?.some(row => row.unit === unit.id)) stage = 'failed';
  else if (unit.promptState === 'confirmed') stage = 'ready-to-create';
  else if (unit.promptState === 'written') stage = 'prompt-ready';
  return {
    stage,
    contentId,
    declarationStatus: publication?.declarationStatus ?? null,
    taskId: task?.id ?? null,
    taskStatus: task?.status ?? null,
    assets: assets ? { state: assets.state, ready: assets.ready, requested: assets.requested } : null,
    failure: creation?.failed?.find(row => row.unit === unit.id) ?? null
  };
}

/** 整个任务的进度汇总：全投完就是已完成，不再受中间链路状态影响。 */
function jobProgressOf(units) {
  const total = units.length || 1;
  const published = units.filter(unit => unit.progress?.stage === 'published').length;
  const waitingAssets = units.filter(unit => unit.progress?.stage === 'waiting-assets').length;
  const actionable = units.filter(unit => unit.progress?.stage === 'failed').length;
  const stage = published === units.length && units.length ? 'published-all'
    : published > 0 ? 'published-partial'
      : units.some(unit => unit.progress?.stage === 'publishing') ? 'publishing'
        : units.some(unit => unit.progress?.stage === 'created') ? 'ready-to-publish'
          : waitingAssets ? 'waiting-assets'
            : actionable ? 'needs-attention'
            : units.every(unit => unit.progress?.stage === 'queued') ? 'queued' : 'in-progress';
  return { stage, published, total, actionable };
}

async function jobsHandler(request, response) {
  try {
    if (request.method === 'GET') {
      const publishTasks = listPublishTasks(dataRoot);
      const jobs = listJobs(dataRoot).map(job => {
        const units = job.units.map(unit => {
          const withPrompt = { ...unit, prompt: readPromptOf(unit) };
          const progress = unitProgressOf(withPrompt, publishTasks);
          return { ...withPrompt, progress, assets: progress.assets ?? assetStateOf(withPrompt) };
        });
        return {
          ...job,
          status: jobProgressOf(units).stage === 'published-all' ? 'complete' : job.status,
          backend: job.backend ?? 'gd-cli',
          units,
          progress: jobProgressOf(units),
          instruction: instructionFor(job),
          generation: generations.get(job.id) ?? null,
          creation: creations.get(job.id) ?? null,
          pipeline: pipelines.get(job.id) ?? null
        };
      });
      return send(response, 200, { jobs, maxQuantity });
    }
    if (request.method !== 'POST') return send(response, 405, { error: 'GET or POST required' });
    const body = await jsonBody(request);
    const catalogValue = readJson(catalogFile);
    const topics = Array.isArray(catalogValue?.topics) ? catalogValue.topics : [];
    if (!topics.length) return send(response, 409, { error: '还没有实时话题目录，请先刷新话题' });
    const specs = {};
    for (const key of Array.isArray(body.topics) ? body.topics : []) {
      const spec = readSpec(dataRoot, String(key));
      if (spec) specs[key] = spec;
    }
    const mode = body.mode === 'auto' ? 'auto' : 'manual';
    const created = createJobs({ dataRoot, topics: body.topics, quantity: body.quantity ?? 1, note: body.note ?? '', catalogTopics: topics, specs, mode, backend: body.backend ?? 'gd-cli' });
    for (const job of created.jobs) {
      if (mode === 'auto') runAutoPipeline(job.id, { backend: job.backend ?? body.backend ?? 'gd-cli' }).catch(() => {});
      else if (body.autoPrompt !== false) generateJobPrompts(job).catch(() => {});
    }
    return send(response, 201, {
      ...created,
      jobs: created.jobs.map(job => ({ ...job, instruction: instructionFor(job) }))
    });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function removeJobHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    return send(response, 200, removeJob(dataRoot, body.id));
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

function resultsHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  try { return send(response, 200, { runs: listRuns(dataRoot) }); }
  catch (error) { return send(response, 500, { error: String(error?.message ?? error) }); }
}

function previewHandler(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const target = url.searchParams.get('path');
  const root = runsRoot(dataRoot);
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  try {
    if (!target || !target.startsWith(root + '/')) return send(response, 400, { error: '只允许读取运行目录内的图片' });
    if (!/\.(jpg|jpeg|png|webp)$/i.test(target)) return send(response, 400, { error: '不是图片文件' });
    const stats = statSync(target);
    if (!stats.isFile() || stats.size > 20_000_000) return send(response, 400, { error: '图片不可读或过大' });
    const type = /\.png$/i.test(target) ? 'image/png' : /\.webp$/i.test(target) ? 'image/webp' : 'image/jpeg';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=300' });
    response.end(readFileSync(target));
  } catch (error) { send(response, 404, { error: String(error?.message ?? error) }); }
}

function runDirOf(value) {
  const root = runsRoot(dataRoot);
  if (typeof value !== 'string' || !value.startsWith(root + '/')) throw Error('只允许读取运行目录内的结果');
  return value;
}

async function promptsHandler(request, response) {
  try {
    if (request.method === 'GET') {
      const jobId = new URL(request.url, 'http://localhost').searchParams.get('job');
      const jobs = listJobs(dataRoot);
      if (!jobId) {
        return send(response, 200, {
          jobs: jobs.map(row => ({
            id: row.id, topic: row.topic, status: row.status,
            units: row.units.map(unit => ({ id: unit.id, index: unit.index, direction: unit.brief?.direction ?? null, promptState: unit.promptState, prompt: readPromptOf(unit), path: promptFileOf(unit) }))
          }))
        });
      }
      const job = jobs.find(row => row.id === jobId);
      if (!job) return send(response, 404, { error: '任务不存在' });
      return send(response, 200, {
        job: { id: job.id, topic: job.topic, status: job.status },
        units: job.units.map(unit => ({ id: unit.id, index: unit.index, direction: unit.brief?.direction ?? null, promptState: unit.promptState, prompt: readPromptOf(unit), path: promptFileOf(unit) })),
        instruction: instructionFor(job)
      });
    }
    if (request.method !== 'POST') return send(response, 405, { error: 'GET or POST required' });
    const body = await jsonBody(request);
    const found = findUnit(String(body.unitId ?? ''));
    if (!found) return send(response, 404, { error: '找不到单元' });
    const record = writePrompt(found.unit, body, { by: 'user' });
    return send(response, 200, { unitId: found.unit.id, prompt: record, promptState: record.confirmed ? 'confirmed' : 'written', instruction: instructionFor(found.job) });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

function createStatusHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  creatorStatus().then(value => send(response, 200, value)).catch(error => send(response, 500, { error: String(error?.message ?? error) }));
}

function createPreviewHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  try {
    const jobId = new URL(request.url, 'http://localhost').searchParams.get('job');
    const job = withPrompts(listJobs(dataRoot).find(row => row.id === jobId));
    if (!job.id) return send(response, 404, { error: '任务不存在' });
    const units = job.units.map(unit => ({
      id: unit.id, index: unit.index, promptState: unit.promptState,
      input: unit.promptState === 'confirmed' ? buildImageInput({ unit }) : null
    }));
    return send(response, 200, { jobId: job.id, kind: job.kind, model: job.kind === 'material' ? defaultModel : null, free: job.kind !== 'material', units });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function createRunHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const job = listJobs(dataRoot).find(row => row.id === body.jobId);
    if (!job) return send(response, 404, { error: '任务不存在' });
    if (body.confirm !== true) return send(response, 400, { error: '需要明确确认后再调用（会消耗稿豆）' });
    const backend = ['agent', 'image-gen'].includes(body.backend) ? body.backend : 'gd-cli';
    if (backend === 'agent') return send(response, 200, { mode: 'agent', instruction: instructionFor(job) });
    const pending = job.units.filter(unit => unit.promptState !== 'confirmed');
    if (pending.length) return send(response, 409, { error: '还有 ' + pending.length + ' 个单元的 prompt 没有确认' });
    if (creations.get(job.id)?.running) return send(response, 409, { error: '创作进行中', creation: creations.get(job.id) });
    runCreation(job, { model: body.model || defaultModel, backend }).catch(() => {});
    return send(response, 202, { started: true, creation: creations.get(job.id) });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

function pluginVersion() {
  try { return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version ?? 'unknown'; } catch { return 'unknown'; }
}

function healthHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  const version = pluginVersion();
  return send(response, 200, {
    version,
    features: ['topic-kind-filter', 'create-backend-choice', 'results-topic-filter', 'published-works', 'template-create', 'material-create'],
    startedAt: new Date().toISOString()
  });
}

/** 浏览器重启后 session.json 里的空间会失效：每次用之前先解析，必要时自动重建。 */
let spaceCache = { at: 0, value: null, created: false };
async function currentSpace({ force = false } = {}) {
  if (!force && spaceCache.value && Date.now() - spaceCache.at < 30_000) return spaceCache.value;
  const resolved = await ensureSpace({ sessionFile });
  spaceCache = { at: Date.now(), value: resolved.space, created: resolved.created };
  return resolved.space;
}

const publishRuns = new Map();
const runtimeStateFile = join(dataRoot, 'runtime', 'publish-runs.json');

/** 把内存里的投稿/自动链路状态落盘，重启后能看出哪些被打断。 */
function persistRuntimeState() {
  try {
    mkdirSync(dirname(runtimeStateFile), { recursive: true });
    const snapshot = {
      savedAt: new Date().toISOString(),
      publish: [...publishRuns.entries()].map(([id, state]) => ({ id, ...state })),
      pipelines: [...pipelines.entries()].map(([id, state]) => ({ id, ...state })),
      creation: [...creations.entries()].map(([id, state]) => ({ id, ...state }))
    };
    writeJson(runtimeStateFile, snapshot);
  } catch {}
}

/** 启动时读取上次状态：标记为运行中的，说明进程被打断，状态如实降级。 */
function restoreRuntimeState() {
  const saved = readJson(runtimeStateFile);
  if (!saved) return;
  for (const row of saved.publish ?? []) {
    if (!row.running) continue;
    publishRuns.set(row.id, { ...row, running: false, step: 'interrupted', error: '进程中断：重启前仍在投稿，请到发布管理核对真实状态' });
  }
  for (const row of saved.creation ?? []) {
    if (!row.running) continue;
    creations.set(row.id, { ...row, running: false, interrupted: true, step: 'interrupted', error: '进程中断：重启前仍在创作，已完成的部分会复用' });
  }
  for (const row of saved.pipelines ?? []) {
    if (!row.running) continue;
    pipelines.set(row.id, { ...row, running: false, stage: 'interrupted', error: '进程中断：重启前仍在自动执行' });
  }
}


// 同一个空间同时只跑一个投稿：并发会互相抢页面配额，也会互相干扰表单。
const spaceQueues = new Map();
function queueOnSpace(key, work) {
  const previous = spaceQueues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  spaceQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

/** 生成 AI 生成证据图；Python 用运行时的 Pillow，失败如实返回。 */
function generateAiEvidence(runDir, topic) {
  return new Promise((resolve, reject) => {
    const python = join(runtimeHome, '.venv/bin/python');
    const script = join(pluginRoot, 'ai-evidence.py');
    if (!existsSync(python)) return reject(Error('缺少运行时 Python，无法生成证据图'));
    execFile(python, [script, runDir, '--topic', topic ?? '', '--output', join(runDir, 'publish', 'ai-evidence.png')], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) return reject(Error('生成 AI 证据图失败：' + (stderr || error.message).slice(-300)));
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch (parseError) { reject(parseError); }
    });
  });
}

/** 生成「程序原创素材说明」证据图；模板版权声明必须用它作为声明材料。 */
function generateOriginalEvidence(runDir, topic) {
  return new Promise((resolve, reject) => {
    const python = join(runtimeHome, '.venv/bin/python');
    const script = join(pluginRoot, 'original-evidence.py');
    if (!existsSync(python)) return reject(Error('缺少运行时 Python，无法生成原创证据图'));
    execFile(python, [script, runDir, '--topic', topic ?? '', '--output', join(runDir, 'publish', 'original-evidence.png')], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) return reject(Error('生成原创证据图失败：' + (stderr || error.message).slice(-300)));
      let value;
      try { value = JSON.parse(stdout.trim().split('\n').pop()); } catch (parseError) { return reject(parseError); }
      if (value?.error) return reject(Error('生成原创证据图失败：' + value.error));
      if (!value?.image || !existsSync(value.image)) return reject(Error('原创证据图没有落盘'));
      resolve(value);
    });
  });
}

/** 插件自建模板稿的投稿：导入编辑器 → 编辑器内发布 → 重新打开核验话题。 */
async function runTemplatePublish(task, state, { submit, forceReimport = false }) {
  const space = await currentSpace();
  if (!Number.isSafeInteger(space) || space < 1) throw Error('需要先完成浏览器登录（缺少空间 ID）');
  state.step = 'evidence';
  const evidence = await generateOriginalEvidence(task.runDir, task.topic);
  state.evidence = evidence;
  // 声明计划必须在发布前冻结：图片层数、去重候选数与真实证据三者对齐才允许提交。
  const plan = preflightTemplateDeclaration({ runDir: task.runDir });
  // 平台会重编码预览图，字节哈希对不上：给每层补一个感知哈希，页面按它匹配候选。
  await attachPerceptualHashes({ plan, runDir: task.runDir });
  writeDeclarationPlan(task.runDir, plan);
  state.plan = { candidates: plan.candidates, imageCount: plan.imageCount, evidence: plan.evidence.sha256 };
  state.step = 'editor-import';
  const designUrl = await ensureEditorImport({ task, space, forceReimport });
  state.designUrl = designUrl;
  state.step = 'publishing';
  const creation = readJson(join(task.runDir, 'creation.json'));
  const result = await publishTemplate({
    designUrl,
    description: creation?.description ?? task.topic,
    topic: task.topic,
    // AI 生成的稿件必须打开平台「含AI生成内容」并声明为原创 AI 素材。
    ai: plan.category === 'original_ai',
    submit,
    declare: submit,
    plan: submit ? plan : null,
    runDir: task.runDir,
    space
  });
  state.steps = result.steps ?? [];
  state.result = result;
  state.content = result.content ?? null;
  if (!submit || !result.ok) return;
  const content = result.content;
  if (!content?.id || !content.topics?.includes(task.topic)) throw Error('模板发布后核验不完整：必须取得作品 ID 和准确话题');
  if (result.declaration?.verified !== true || result.declaration?.reopened !== true || result.declaration?.submitted !== true) {
    throw Error('模板版权声明没有完成平台回读核验，投稿流程不算完成');
  }
  state.step = 'published';
}

async function runPublish(taskId, { submit = false, forceReimport = false } = {}) {
  const state = { running: true, taskId, step: 'prepare', steps: [], error: null, result: null, forceReimport, startedAt: new Date().toISOString(), finishedAt: null };
  publishRuns.set(taskId, state);
  const space = await currentSpace().catch(() => 'none');
  return queueOnSpace('space:' + space, async () => {
  state.step = 'queued';
  try {
    const task = listPublishTasks(dataRoot).find(row => row.id === taskId);
    if (!task) throw Error('投稿任务不存在');
    if (task.kind !== 'material') {
      const templateState = { ...state };
      try {
        await runTemplatePublish(task, templateState, { submit, forceReimport: state.forceReimport === true });
      } finally {
        Object.assign(state, templateState);
      }
      return state;
    }
    const material = readJson(join(task.runDir, 'material.json'));
    if (!material) throw Error('该任务没有素材文件，无法自动投稿');
    const asset = join(task.runDir, material.asset ?? 'asset.png');
    state.step = 'evidence';
    const evidence = await generateAiEvidence(task.runDir, task.topic);
    state.evidence = evidence;
    state.step = 'publishing';
    const evidencePath = evidence?.image ?? join(task.runDir, 'publish', 'ai-evidence.png');
    // 浏览器偶发超时/面板未渲染属于可重试失败：只要没有真的发出去，就自动重试，不必人工再点。
    const space = await currentSpace();
    const attemptOnce = () => publishMaterial({
      task, asset,
      description: (material.description || material.title || task.topic || ''),
      topic: task.topic ?? null,
      evidence: existsSync(evidencePath) ? evidencePath : null,
      ai: typeof material.model === 'string' && !!material.model,
      submit,
      declare: submit,
      evidenceDir: join(task.runDir, 'publish'),
      space
    });
    let result;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await attemptOnce();
        break;
      } catch (error) {
        const publishedAlready = error?.result?.published === true || Boolean(error?.result?.content?.id);
        const retriable = !publishedAlready && Boolean(priorPublication(task)) === false;
        if (!retriable || attempt === 2) throw error;
        state.steps.push('retry:' + attempt + ':' + String(error?.message ?? error).slice(0, 80));
        state.step = 'retrying';
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    state.steps = result.steps ?? [];
    state.result = result;
    state.content = result.content ?? null;
    if (submit && (!result.content?.id || !result.content.topics?.includes(task.topic) || !result.declared)) {
      // 作品已发出但声明没完成：记录 work 与待声明状态，便于自动/人工按原 ID 补声明，绝不重投。
      const pending = result.published || result.content?.id;
      if (pending) {
        const release = task.release || task.runDir;
        mkdirSync(release, { recursive: true });
        writeJson(join(release, 'publication.json'), {
          stage: 'published-pending-declaration',
          published: true,
          publishedAt: new Date().toISOString(),
          kind: task.kind,
          topic: task.topic ?? null,
          contentId: result.content?.id ?? null,
          topics: result.content?.topics ?? [],
          declarationStatus: result.content?.declaration ?? 'WAITING_MATERIALS',
          declarationPending: true,
          evidence: result.screenshots ?? []
        });
      }
      throw Error('发布后核验不完整：必须取得作品 ID、准确话题及版权声明结果');
    }
    if (submit && result.ok) {
      const release = task.release || task.runDir;
      mkdirSync(release, { recursive: true });
      writeJson(join(release, 'publication.json'), {
        stage: 'published',
        published: true,
        publishedAt: new Date().toISOString(),
        title: material.title ?? null,
        topic: task.topic ?? null,
        contentId: result.content?.id ?? null,
        topics: result.content?.topics ?? [],
        managementStatus: result.content.publishStatus ?? null,
        declarationStatus: result.content.declaration,
        evidence: result.screenshots ?? []
      });
    }
    state.step = result.ok ? (submit ? 'published' : 'dry-run') : 'failed';
  } catch (error) {
    state.error = String(error?.message ?? error);
    state.result = error.result ?? state.result;
    state.steps = error.result?.steps ?? state.steps;
    state.step = error.result?.published ? 'needs-reconciliation' : 'failed';
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    persistRuntimeState();
  }
  return state;
  });
}

async function evidenceHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  try {
    const url = new URL(request.url, 'http://localhost');
    const taskId = url.searchParams.get('task');
    const task = listPublishTasks(dataRoot).find(row => row.id === taskId);
    if (!task) return send(response, 404, { error: '投稿任务不存在' });
    const value = await generateAiEvidence(task.runDir, task.topic);
    return send(response, 200, value);
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function publishRunHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const task = listPublishTasks(dataRoot).find(row => row.id === body.taskId);
    if (!task) return send(response, 404, { error: '投稿任务不存在' });
    if (publishRuns.get(task.id)?.running) return send(response, 200, { alreadyRunning: true, run: publishRuns.get(task.id) });
    runPublish(task.id, { submit: body.submit === true }).catch(() => {});
    return send(response, 202, { started: true, run: publishRuns.get(task.id) });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

/** 历史投稿对账：只读平台事实，不发布、不声明；像素一致才把原 contentId 记回任务。 */

/**
 * 对账「不确定提交」：平台若真没有新作品，就归档这条记录允许重投；
 * 若确实发出去了，把作品 ID 记下来（模板仍需补声明，交给撤销重发通道）。
 */
async function publishResolveUncertainHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const task = listPublishTasks(dataRoot).find(row => row.id === body.taskId);
    if (!task) return send(response, 404, { error: '投稿任务不存在' });
    const attemptFile = join(task.runDir, 'publish', 'submission-attempt.json');
    if (!existsSync(attemptFile)) return send(response, 409, { error: '没有待对账的提交记录' });
    const attempt = readJson(attemptFile) ?? {};
    if (attempt.result?.content?.id) return send(response, 200, { resolved: 'recorded', contentId: attempt.result.content.id });
    const space = await currentSpace();
    const startedAt = Date.parse(attempt.startedAt ?? '') || 0;
    const rows = (await listPublished({ space, force: true, all: false })).rows ?? [];
    const expectedTitle = String(attempt.fingerprint?.description ?? '').slice(0, 16);
    const candidate = rows.find(row => {
      const at = Number(row.publishedAt ?? 0);
      if (startedAt && at && at < startedAt - 120000) return false;
      const kindMatch = task.kind === 'template' ? row.publishType !== 2 : row.publishType === 2;
      if (!kindMatch) return false;
      const topicMatch = task.topic ? (row.topics ?? []).some(topic => topic.name === task.topic) : true;
      const titleMatch = expectedTitle ? String(row.title ?? '').includes(expectedTitle.slice(0, 8)) : false;
      return topicMatch || titleMatch;
    });
    if (!candidate) {
      const archive = attemptFile.replace('.json', '.no-submission-' + Date.now() + '.json');
      renameSync(attemptFile, archive);
      return send(response, 200, { resolved: 'not-submitted', archived: archive, note: '平台没有新作品，已归档记录，可以重新投稿' });
    }
    const publication = {
      schema: 1, stage: 'uncertain-adopted', published: true, kind: task.kind,
      contentId: String(candidate.id), topic: task.topic, topics: [task.topic],
      title: candidate.title ?? null, publishedAt: candidate.publishedAt ?? null,
      declarationStatus: task.kind === 'template' ? 'PENDING_REPUBLISH' : 'PENDING',
      adoptedFrom: 'reconcile', reconciledAt: new Date().toISOString()
    };
    writeJson(join(task.runDir, 'publication.json'), publication);
    return send(response, 200, { resolved: 'published', publication });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function publishReconcileHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const task = listPublishTasks(dataRoot).find(row => row.id === body.taskId);
    if (!task) return send(response, 404, { error: '投稿任务不存在' });
    const result = await reconcilePublication({
      task, contentId: String(body.contentId ?? ''), topic: task.topic,
      space: await currentSpace(),
      python: join(runtimeHome, '.venv/bin/python')
    });
    return send(response, 200, { reconciled: true, publication: result.publication, evidence: result.evidencePath });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

/** 只有日志自证「没进入发布步骤」时才允许清除记录，让失败任务可以安全重试。 */

/**
 * 模板补声明：先确认平台确实没有声明记录，再撤销旧作品并按新流程重发（声明在发布会话内完成）。
 * 只允许「已发布但没有声明记录」的模板任务；素材有发布管理的声明入口，不走这条路。
 */
async function publishRepublishHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const task = listPublishTasks(dataRoot).find(row => row.id === body.taskId);
    if (!task) return send(response, 404, { error: '投稿任务不存在' });
    if (task.kind !== 'template') return send(response, 409, { error: '只有模板需要撤销重发，素材请用发布管理里的声明入口' });
    const prior = priorPublication(task);
    const contentId = prior?.contentId ?? task.publication?.contentId;
    if (!contentId) return send(response, 409, { error: '该任务没有已发布作品，直接点开始投稿即可' });
    const space = await currentSpace();
    const force = body.force === true;
    const records = await readDeclarationRecords({ contentId, space });
    // 已有声明记录时默认不重发（避免白撤一件已合规的作品）；
    // 只有调用方明确 force=true（稿件改过、确实要替换）才继续。
    if (records.length && !force) {
      return send(response, 409, { error: '平台已有 ' + records.length + ' 条声明记录；如需替换成新版稿件请显式传 force=true' });
    }
    const withdrawn = await withdrawContent({ contentId, space });
    const dir = join(task.release ?? task.runDir);
    mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    for (const name of ['publication.json', 'publish/submission-attempt.json']) {
      const file = join(task.runDir, name);
      if (existsSync(file)) renameSync(file, file + '.superseded-' + stamp);
    }
    runPublish(task.id, { submit: true, forceReimport: true }).catch(() => {});
    return send(response, 202, {
      republishing: true, taskId: task.id, withdrawn: withdrawn.contentId,
      replacedDeclarationRecords: records.length, forced: force, steps: withdrawn.steps
    });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function publishAbandonHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const task = listPublishTasks(dataRoot).find(row => row.id === body.taskId);
    if (!task) return send(response, 404, { error: '投稿任务不存在' });
    const result = abandonUnsubmittedAttempt(join(task.runDir, 'publish'));
    if (!result) return send(response, 409, { error: '该任务没有可释放的提交记录' });
    return send(response, 200, { abandoned: true, taskId: task.id, ...result });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function publishedHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  try {
    const url = new URL(request.url, 'http://localhost');
    // 空间可能因为浏览器重启而失效：先解析/重建，不要直接把 task space not found 抛给用户。
    let space = null;
    let spaceNotice = null;
    try { space = await currentSpace({ force: url.searchParams.get('refresh') === '1' }); }
    catch (error) { spaceNotice = '浏览器空间不可用：' + String(error?.message ?? error); }
    if (!space) return send(response, 503, { error: spaceNotice ?? '浏览器空间不可用' });
    // 分页：page/pageSize 取单页；all=1 一次取全量（面板「加载全部」用）。
    const force = url.searchParams.get('refresh') === '1';
    const all = url.searchParams.get('all') === '1';
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 50);
    const value = await listPublished({ space, page, pageSize, all, force });
    const rows = Array.isArray(value.rows) ? value.rows : [];
    return send(response, 200, {
      fetchedAt: value.fetchedAt,
      rows,
      page: value.page ?? page,
      pageSize: value.pageSize ?? pageSize,
      hasMore: value.hasMore === true,
      pages: value.pages ?? null,
      summary: summarize(rows)
    });
  } catch (error) { return send(response, 502, { error: String(error?.message ?? error) }); }
}

async function promptsGenerateHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const job = listJobs(dataRoot).find(row => row.id === body.jobId);
    if (!job) return send(response, 404, { error: '任务不存在' });
    // 已经在生成时保持幂等：返回当前进度，不作为失败。
    if (generations.get(job.id)?.running) return send(response, 200, { alreadyRunning: true, generation: generations.get(job.id) });
    const state = await generateJobPrompts(job, { force: body.force === true });
    const latest = listJobs(dataRoot).find(row => row.id === job.id);
    return send(response, 200, { generation: state, units: latest.units.map(unit => ({ id: unit.id, promptState: unit.promptState, prompt: readPromptOf(unit) })) });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function promptsConfirmHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const job = listJobs(dataRoot).find(row => row.id === body.jobId);
    if (!job) return send(response, 404, { error: '任务不存在' });
    const records = confirmPrompts(job);
    return send(response, 200, { jobId: job.id, confirmed: records.length, instruction: instructionFor(job) });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

function publishCheckHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  try {
    const target = runDirOf(new URL(request.url, 'http://localhost').searchParams.get('dir'));
    return send(response, 200, checkRun(target));
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}


/** 全自动链路失败后的重试入口：已完成单元跳过，只补未完成与未投稿的部分。 */
async function pipelineRetryHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const job = listJobs(dataRoot).find(row => row.id === body.jobId);
    if (!job) return send(response, 404, { error: '任务不存在' });
    const current = pipelines.get(job.id);
    if (current?.running) return send(response, 200, { alreadyRunning: true, pipeline: current });
    const backend = body.backend ?? job.backend ?? 'gd-cli';
    runAutoPipeline(job.id, { backend, recreate: body.recreate === true }).catch(() => {});
    return send(response, 202, { started: true, pipeline: pipelines.get(job.id) });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function publishHandler(request, response) {
  try {
    if (request.method === 'GET') return send(response, 200, { tasks: listPublishTasks(dataRoot).map(task => {
      const run = publishRuns.get(task.id) ?? null;
      // 正在跑的任务，文件里的提交日志还没写完，不能显示成「结果不确定」。
      const status = run?.running && task.status !== 'published' ? 'submitting' : task.status;
      return { ...task, status, run };
    }) });
    if (request.method !== 'POST') return send(response, 405, { error: 'GET or POST required' });
    const body = await jsonBody(request);
    const target = runDirOf(body.dir);
    const check = checkRun(target);
    if (!check.ok) return send(response, 409, { error: '投稿前检查未通过，不能创建投稿任务', check });
    const created = createPublishTask({ dataRoot, runDir: target, summary: check.summary });
    return send(response, 201, { ...created, check });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}


/** 批量投稿：串行排队执行（同一浏览器空间本来就只能串行），返回每条的启动结果。 */

/** 发布队列：启动（可指定任务，默认取全部待投稿）/ 查询 / 停止。 */

/** 自检：确认插件能否用自己的凭据出图（不写任务目录，只验证链路）。 */

/** 进入页面时的环境自检：依赖组件、登录态、出图能力逐项检查。 */
async function preflightHandler(request, response) {
  if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
  try {
    if (!preflight) return send(response, 503, { error: '自检未就绪（缺少 credentials 服务）' });
    const url = new URL(request.url ?? '/', 'http://localhost');
    return send(response, 200, await preflight.run({ refresh: url.searchParams.get('refresh') === '1' }));
  } catch (error) { return send(response, 500, { error: String(error?.message ?? error) }); }
}

async function imageTestHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    if (!imageClient) return send(response, 409, { error: '出图客户端未就绪（缺少 credentials 服务）' });
    const prompt = String(body.prompt ?? '纯白背景正中央一只奶油色小羊贴纸，扁平插画风，透明背景，无文字');
    const started = Date.now();
    const image = await imageClient.generate({ prompt, width: 1024, height: 1536 });
    const dir = join(runtimeHome, 'image-test');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'probe-' + Date.now() + '.png');
    writeFileSync(file, image.buffer);
    return send(response, 200, {
      ok: true, provider: 'chatgpt-sub', model: 'gpt-image-2.6-flare',
      bytes: image.buffer.length, file, elapsedMs: Date.now() - started
    });
  } catch (error) {
    return send(response, 502, { ok: false, code: error?.code ?? null, error: String(error?.message ?? error) });
  }
}

async function publishQueueHandler(request, response) {
  try {
    if (request.method === 'GET') {
      const queue = readQueue(dataRoot);
      return send(response, 200, { queue: summarizeQueue(queue) });
    }
    if (request.method !== 'POST') return send(response, 405, { error: 'GET or POST required' });
    const body = await jsonBody(request);
    if (body.action === 'stop') {
      const queue = requestStop(dataRoot);
      return send(response, 200, { stopped: true, queue: summarizeQueue(queue) });
    }
    const tasks = listPublishTasks(dataRoot);
    const requested = Array.isArray(body.taskIds) ? body.taskIds.map(String) : null;
    const targets = tasks
      .filter(task => (requested ? requested.includes(task.id) : task.status === 'queued'))
      .filter(task => task.status === 'queued');
    if (!targets.length) return send(response, 409, { error: '没有可执行的任务（只接受待投稿状态）' });
    const existing = readQueue(dataRoot);
    if (existing?.running) return send(response, 200, { alreadyRunning: true, queue: summarizeQueue(existing) });
    // 续跑：同一次队列里 pending 的任务继续，已完成的不重复执行
    const items = existing
      ? [...existing.items.filter(row => row.state !== 'done'), ...targets.map(task => ({ taskId: task.id }))]
      : targets.map(task => ({ taskId: task.id }));
    const deduped = [];
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.taskId)) continue;
      seen.add(item.taskId);
      const task = tasks.find(row => row.id === item.taskId);
      deduped.push({ taskId: item.taskId, topic: task?.topic ?? item.topic ?? null, kind: task?.kind ?? item.kind ?? null });
    }
    createQueue({ dataRoot, items: deduped, submit: body.submit !== false });
    runQueue({
      dataRoot,
      runOne: async item => {
        const state = await runPublish(item.taskId, { submit: body.submit !== false });
        const task = listPublishTasks(dataRoot).find(row => row.id === item.taskId);
        const contentId = task?.publication?.contentId ?? state?.content?.id ?? null;
        if (state?.error) return { ok: false, error: state.error, contentId };
        return { ok: task?.status === 'published', contentId, error: task?.status === 'published' ? null : '投稿未完成：' + (state?.step ?? '未知') };
      }
    }).catch(() => {});
    return send(response, 202, { started: true, queue: summarizeQueue(readQueue(dataRoot)) });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function publishBatchHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const ids = Array.isArray(body.taskIds) ? body.taskIds.map(String).slice(0, 50) : [];
    if (!ids.length) return send(response, 400, { error: '没有选择任务' });
    const tasks = listPublishTasks(dataRoot);
    const started = [];
    const skipped = [];
    for (const id of ids) {
      const task = tasks.find(row => row.id === id);
      if (!task) { skipped.push({ id, reason: '任务不存在' }); continue; }
      if (task.status === 'published') { skipped.push({ id, reason: '已投稿' }); continue; }
      if (task.status === 'cancelled') { skipped.push({ id, reason: '已取消' }); continue; }
      if (publishRuns.get(id)?.running) { skipped.push({ id, reason: '正在执行' }); continue; }
      runPublish(id, { submit: body.submit !== false }).catch(() => {});
      started.push(id);
    }
    return send(response, 202, { started, skipped });
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

/** 取消尚未开始的任务（已开始的只能等它跑完，避免半截投稿）。 */
async function publishCancelHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    const result = markPublishCancelled(dataRoot, String(body.taskId));
    return send(response, 200, result);
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

async function publishRemoveHandler(request, response) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
  try {
    const body = await jsonBody(request);
    return send(response, 200, removePublishTask(dataRoot, body.id));
  } catch (error) { return send(response, 400, { error: String(error?.message ?? error) }); }
}

export function apply(ctx) {
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool));
  ctx.inject(['llm'], host => { llmService = host.llm ?? null });
  ctx.inject(['agentDefaultModel'], host => { modelSelection = host.agentDefaultModel ?? null });
  ctx.inject(['credentials'], host => {
    const resolveCredential = async key => (await host.credentials.resolve(key))?.value ?? null;
    // 复用 DSH 图像插件已登录的订阅凭据：插件自己出图，全自动不再依赖 Agent。
    imageClient = createImageClient({
      resolveCredential,
      saveCredential: async (key, value) => { await host.credentials.set(key, value); }
    });
    preflight = createPreflight({
      dataRoot, runtimeHome, version: pluginVersion(), resolveCredential
    });
  });
  ctx.inject(['webServer'], host => host.effect(() => {
    restoreRuntimeState();
    const disposers = [
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/topics', handler: topicsHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/specs', handler: specsHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/specs/refresh', handler: refreshHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/session', handler: sessionHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/session/probe', handler: probeHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/session/login', handler: loginHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/jobs', handler: jobsHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/jobs/remove', handler: removeJobHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/pipeline/run', handler: pipelineRetryHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/results', handler: resultsHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/preview', handler: previewHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/prompts', handler: promptsHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/prompts/confirm', handler: promptsConfirmHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/prompts/generate', handler: promptsGenerateHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/create/status', handler: createStatusHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/create/preview', handler: createPreviewHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/create', handler: createRunHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/published', handler: publishedHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/health', handler: healthHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/check', handler: publishCheckHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish', handler: publishHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/remove', handler: publishRemoveHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/batch', handler: publishBatchHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/queue', handler: publishQueueHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/cancel', handler: publishCancelHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/run', handler: publishRunHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/reconcile', handler: publishReconcileHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/resolve-uncertain', handler: publishResolveUncertainHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/abandon', handler: publishAbandonHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/publish/republish', handler: publishRepublishHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/evidence/ai', handler: evidenceHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/image/test', handler: imageTestHandler }),
      host.webServer.register({ kind: 'exact', path: '/gaoding-publisher/preflight', handler: preflightHandler })
    ];
    return () => { for (const dispose of disposers) { try { dispose?.(); } catch {} } };
  }));
}
