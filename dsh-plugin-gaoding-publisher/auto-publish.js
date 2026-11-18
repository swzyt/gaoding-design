import { resolve, join } from 'node:path';

/** A completed publication is stronger than a successful request or a submitted declaration. */
const DECLARED = ['SUBMITTED', 'APPROVED', 'PASSED'];

export function publicationComplete(task) {
  const p = task?.publication;
  if (!(p?.published === true && p.contentId && task.topic && p.topics?.includes(task.topic))) return false;
  // 声明没完成就不算投完：素材看平台状态，模板看真实回读核验。
  return task.kind === 'material'
    ? DECLARED.includes(p.declarationStatus)
    : p.declaration?.verified === true && p.declaration?.reopened === true;
}

/** Dependencies are injected so orchestration tests never invoke a browser, LLM or paid generator. */
export async function executeAutoPipeline(jobId, { model, backend = 'gd-cli', recreate = false }, deps) {
  const { pipelines, dataRoot, listJobs, listPublishTasks, checkRun, createPublishTask,
    generateJobPrompts, confirmPrompts, runCreation, runPublish, readJson, writeJson } = deps;
  if (pipelines.get(jobId)?.running) return pipelines.get(jobId);
  const state = { running: true, stage: 'prompt', steps: [], error: null, failures: [], startedAt: new Date().toISOString(), finishedAt: null };
  const failures = state.failures;
  pipelines.set(jobId, state);
  const fresh = () => {
    const job = listJobs(dataRoot).find(row => row.id === jobId);
    if (!job || !job.units?.length) throw Error('任务不存在或没有创作单元');
    return job;
  };
  const taskOf = unit => listPublishTasks(dataRoot).find(row => resolve(row.runDir) === resolve(unit.directory));
  // 已投稿是终态，不是失败：单看检查结果会把「不重复提交」误当成错误，所以先判 published。
  const preflight = unit => {
    const check = checkRun(unit.directory);
    if (check.published) return check;
    if (!check.ok) throw Error('投稿前检查未通过：' + unit.id + ' → ' + (check.checks ?? []).filter(c => !c.ok).map(c => c.label).join('、'));
    return check;
  };
  try {
    let job = fresh();
    // runCreation currently only implements the CLI material backend. Never silently downgrade Agent work.
    if (backend === 'agent') {
      state.stage = 'waiting-agent';
      state.instruction = deps.instructionFor(job);
      return state;
    }
    // image-gen 走素材交接（由 Agent 出图），与 gd-cli 一样属于可执行后端。
    if (!['gd-cli', 'image-gen'].includes(backend)) throw Error('不支持的创作后端：' + backend);
    const pending = job.units.filter(unit => {
      const seen = checkRun(unit.directory);
      if (taskOf(unit) || seen.ok || seen.published) return false;
      const attempted = readJson(join(unit.directory, 'auto-creation.json'));
      const artifact = readJson(join(unit.directory, job.kind === 'material' ? 'material.json' : 'creation.json'));
      if (artifact) {
        // 模板在本地渲染，重做不花钱；素材是付费生成，绝不能自动重做。
        if (recreate && job.kind !== 'material') {
          const reason = (checkRun(unit.directory).checks ?? []).filter(c => !c.ok).map(c => c.label).join('、');
          writeJson(join(unit.directory, 'creation.replaced-' + Date.now() + '.json'), artifact);
          state.steps.push('recreate-artifact:' + unit.id + (reason ? ':' + reason : ''));
          return true;
        }
        // 已创作但还没投出去的单元：不重新生成，交给后面的发布阶段处理。
        return false;
      }
      if (attempted) {
        // 中断（没有明确失败）也允许继续：素材已落地会复用，不会重复消耗额度。
        const knownFailure = attempted.failed === true;
        if (!knownFailure && !recreate) {
          state.steps.push('resume:' + unit.id);
          writeJson(join(unit.directory, 'auto-creation.resume-' + Date.now() + '.json'), attempted);
          return true;
        }
        writeJson(join(unit.directory, 'auto-creation.abandoned-' + Date.now() + '.json'), attempted);
        state.steps.push('recreate:' + unit.id);
        return true;
      }
      return true;
    });
    if (pending.length) {
      const pendingIds = new Set(pending.map(unit => unit.id));
      const subset = () => ({ ...fresh(), units: fresh().units.filter(unit => pendingIds.has(unit.id)) });
      const generation = await generateJobPrompts(subset());
      if (generation?.running || generation?.error) throw Error('prompt 生成未完成：' + (generation.error ?? '仍在运行'));
      state.steps.push('prompt-written');
      state.stage = 'confirm';
      confirmPrompts(subset(), { by: 'auto-policy' });
      state.steps.push('prompt-confirmed:auto-policy');
      const toCreate = subset();
      if (toCreate.units.length !== pending.length || toCreate.units.some(unit => unit.promptState !== 'confirmed')) throw Error('创作前 prompt 没有全部确认');
      state.stage = 'create';
      // Persist before the possibly paid operation; interrupted/failed attempts require recovery, never a blind retry.
      for (const unit of toCreate.units) writeJson(join(unit.directory, 'auto-creation.json'), { startedAt: new Date().toISOString(), backend });
      const creation = await runCreation(toCreate, { model, backend });
      for (const failure of creation?.failed ?? []) {
        const unit = toCreate.units.find(row => row.id === failure.unit);
        if (unit) writeJson(join(unit.directory, 'auto-creation.json'), { ...readJson(join(unit.directory, 'auto-creation.json')), failed: true, error: failure.error, failedAt: new Date().toISOString() });
      }
      const waitingUnits = [];
      for (const failure of creation?.failed ?? []) {
        if (failure.code === 'ASSETS_WAITING') {
          waitingUnits.push({ unit: failure.unit, request: failure.request ?? null, error: failure.error });
          state.steps.push('assets-waiting:' + failure.unit);
          continue;
        }
        const reason = failure.code === 'CONTENT_AUDIT' ? '生成被内容审核拒绝（需改 prompt）' : failure.error;
        failures.push({ unit: failure.unit, error: reason });
        state.steps.push('create-failed:' + failure.unit);
      }
      if (waitingUnits.length) {
        // 素材还没出：停在「等待出图」，交回 Agent 生成后重跑，不算失败。
        state.stage = 'waiting-assets';
        state.waitingAssets = waitingUnits;
        state.error = null;
        return state;
      }
      if (!creation || creation.running || creation.error) throw Error('创作没有全部完成：' + (creation?.done ?? 0) + '/' + pending.length + (creation?.error ? ' → ' + creation.error : ''));
      // 没有逐单元失败记录、但数量对不上：说明创作阶段本身出错，不能继续。
      if (!creation.failed?.length && (creation.total !== pending.length || creation.done !== pending.length)) {
        throw Error('创作没有全部完成：' + creation.done + '/' + pending.length);
      }
    }
    job = fresh();
    // Check all unpublished units before the first submission, not halfway through the batch.
    for (const unit of job.units) {
      const task = taskOf(unit);
      const check = checkRun(unit.directory);
      if (check.published) continue;
      // 模板稿的检查需要先有声明证据，由 runTemplatePublish 内部完成，这里只检查素材稿。
      if (job.kind === 'material' && (!task || task.status === 'queued')) preflight(unit);
    }
    state.steps.push('created:' + job.units.length + '/' + job.units.length);
    state.stage = 'publish';
    for (const unit of job.units) {
      let task = taskOf(unit);
      if (publicationComplete(task)) {
        state.steps.push('published-skipped:' + unit.id + ':' + task.publication.contentId);
        continue;
      }
      const seen = checkRun(unit.directory);
      const artifact = readJson(join(unit.directory, job.kind === 'material' ? 'material.json' : 'creation.json'));
      // 创作没成功的单元没有产物：跳过发布，失败原因已在创作阶段记录。
      if (!task && !artifact && !seen.ok && !seen.published) {
        state.steps.push('skipped-no-artifact:' + unit.id);
        continue;
      }
      if (!task && checkRun(unit.directory).published) {
        // 作品已在平台发布但没有投稿任务记录：不重复投稿，留下待对账标记。
        state.steps.push('published-unmanaged:' + unit.id);
        continue;
      }
      if (!task) {
        const check = preflight(unit);
        // Exact store contract: one object in, { task, reused } out.
        task = createPublishTask({ dataRoot, runDir: unit.directory, summary: check.summary }).task;
      }
      if (!task?.id) throw Error('投稿任务创建失败：' + unit.id);
      if (task.kind === 'material' && task.status !== 'queued') throw Error('既有素材投稿需要对账，禁止重复提交：' + unit.id);
      if (deps.publishRuns?.get(task.id)?.running) throw Error('既有投稿仍在运行：' + unit.id);
      // Existing templates resume their original task/content through the publisher's persisted checkpoint.
      let run;
      try {
        run = await runPublish(task.id, { submit: true });
      } catch (error) {
        failures.push({ unit: unit.id, error: String(error?.message ?? error) });
        state.steps.push('unit-failed:' + unit.id);
        continue;
      }
      if (!run || run.running || run.error || run.step !== 'published' || run.result?.ok !== true) {
        const reason = run?.error ?? run?.step ?? '缺少发布结果';
        failures.push({ unit: unit.id, error: String(reason) });
        state.steps.push('unit-failed:' + unit.id);
        continue;
      }
      task = taskOf(unit);
      if (!publicationComplete(task)) {
        failures.push({ unit: unit.id, error: '投稿后持久核验未完成（模板须重开版权声明核验）' });
        state.steps.push('unit-unverified:' + unit.id);
        continue;
      }
      state.steps.push('published:' + unit.id + ':' + task.publication.contentId);
    }
    // 部分失败要如实上报，但已完成的单元不因为个别失败而回滚。
    state.stage = failures.length ? 'done-partial' : 'done';
    if (failures.length) state.error = failures.map(row => row.unit + ' → ' + row.error).join('；').slice(0, 400);
  } catch (error) {
    // 素材未就绪由上面提前 return 处理；其余异常才算真正失败。
    state.error = String(error?.message ?? error);
    state.stage = 'failed';
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
  return state;
}
