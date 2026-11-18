'use strict';
// Fixed sequences only. Journals measure work; they never authorize or skip it.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const SEQUENCES = Object.freeze({
  'prepare,bind,audit': Object.freeze(['prepare', 'bind', 'audit']),
  'form,submit,declare,verify': Object.freeze(['form', 'submit', 'declare', 'verify']),
});
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error(name + ' must be an absolute path');
  return path.normalize(value);
}
async function requireFinalReview(recipePath, out, gatePath) {
  const gate = absolute(gatePath, 'finalReviewGate');
  const request = await read(path.join(gate, 'request.json'));
  const response = await read(path.join(gate, 'response.json'));
  if (request.name !== '04-final' || typeof request.token !== 'string' || !request.token ||
      response.passed !== true || response.token !== request.token ||
      !Array.isArray(response.checks) || !response.checks.length ||
      !response.checks.every(check => typeof check === 'string' && check.trim())) {
    throw Error('Completed Agent final review is required');
  }
  const inputs = request.input_sha256;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw Error('Missing final review inputs');
  for (const file of [recipePath, path.join(out, 'spec.json'), path.join(out, 'bound-assets.json'),
    path.join(out, 'layer-audit/audit.json'), path.join(out, 'registered-assets.json'), path.join(out, 'editor-materials-bound.png')]) {
    if (!Object.hasOwn(inputs, file)) throw Error('Final review does not cover this recipe and its evidence');
  }
  for (const [file, expected] of Object.entries(inputs)) {
    absolute(file, 'review input');
    if (!/^[a-f0-9]{64}$/.test(expected) || await hash(file) !== expected) throw Error('Final review inputs changed');
  }
  for (const [name, key, file] of [
    ['visual-review', 'spec_sha256', path.join(out, 'spec.json')],
    ['material-review', 'bindings_sha256', path.join(out, 'bound-assets.json')],
  ]) {
    const review = await read(path.join(out, name + '.json'));
    if (review.passed !== true || review[key] !== await hash(file)) throw Error('Current final review files required');
  }
  const material = await read(path.join(out, 'material-review.json'));
  if (material.evidence_sha256 !== await hash(path.join(path.dirname(recipePath), 'copyright-evidence.json'))) {
    throw Error('Copyright evidence changed since final review');
  }
}
function handlers() {
  const publish = require('./publish.js');
  return {prepare: publish.prepare, bind: require('./bind_assets.js').bind,
    audit: require('./layer_audit.js').audit, form: publish.prepareForm,
    submit: publish.submit, declare: publish.completeDeclaration, verify: publish.verify};
}
// deps is a local-test seam; the CLI never accepts modules, functions or arbitrary steps.
async function runSequence(page, recipePath, options = {}, deps = {}) {
  if (!Object.hasOwn(SEQUENCES, options.sequence)) throw Error('Unsupported browser sequence');
  const steps = SEQUENCES[options.sequence];
  recipePath = absolute(recipePath, 'recipe');
  const recipe = await read(recipePath);
  const out = path.resolve(path.dirname(recipePath), recipe.output || 'release');
  const logPath = absolute(options.logPath || path.join(out, 'browser-sequence.jsonl'), 'logPath');
  const attemptId = options.attemptId || crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) throw Error('Invalid attempt ID');
  await fs.mkdir(path.dirname(logPath), {recursive: true});
  const emit = async record => fs.appendFile(logPath, JSON.stringify({schema_version: 1,
    attempt_id: attemptId, sequence: options.sequence, ...record}) + '\n', {mode: 0o600});
  const calls = deps.handlers || handlers();
  const summary = {attempt_id: attemptId, sequence: options.sequence, log_path: logPath, steps: []};
  for (const step of steps) {
    const startedAt = new Date().toISOString(), start = performance.now();
    await emit({step, event: 'step_start', at: startedAt, started_at: startedAt, elapsed_ms: 0});
    try {
      // Validate on every publication step, including re-entry; no boolean bypass.
      if (steps[0] === 'form') await requireFinalReview(recipePath, out, options.finalReviewGate);
      let recovery;
      if (step === 'form') {
        let publication;
        try { publication = await read(path.join(out, 'publication.json')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (publication?.published === true && ['published', 'verified'].includes(publication.stage)) {
          if (publication.title !== recipe.title || publication.topic !== recipe.topic || publication.desc !== recipe.description) {
            throw Error('Published receipt does not match this recipe; inspect the existing work');
          }
          // Actual submission receipt, not this journal, authorizes skipping form creation.
          // submit() then uses its existing no-click branch; declaration/verification still run.
          recovery = 'published-receipt:form-not-reopened';
        }
      }
      if (!recovery) await calls[step](page, recipePath);
      const result = {step, event: 'step_success', ...(recovery ? {recovery} : {}), at: new Date().toISOString(),
        started_at: startedAt, elapsed_ms: Math.max(0, performance.now() - start)};
      await emit(result);
      summary.steps.push(result);
    } catch (error) {
      // Error text/stack can contain browser URLs, secrets or whole recipes.
      // Keep only a fixed diagnostic; the original exception still reaches the caller.
      await emit({step, event: 'step_failure', at: new Date().toISOString(), started_at: startedAt,
        elapsed_ms: Math.max(0, performance.now() - start), error_code: 'BROWSER_STEP_FAILED'});
      throw error;
    }
  }
  return summary;
}
module.exports = {SEQUENCES, runSequence, requireFinalReview};
