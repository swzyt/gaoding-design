'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {runSequence} = require('./browser_sequence.js');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-sequence-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const recipe = path.join(root, 'recipe.json'), out = path.join(root, 'release');
  await fs.mkdir(path.join(out, 'layer-audit'), {recursive:true});
  await fs.writeFile(recipe, JSON.stringify({title:'fixture',topic:'winter',description:'fixture description',layers:[], layer_audit:{pairs:[]}}));
  const logPath = path.join(out, 'browser-sequence.jsonl');
  return {root, recipe, out, logPath, rows:async () => (await fs.readFile(logPath,'utf8')).trim().split('\n').map(JSON.parse)};
}
async function approved(f) {
  const write = async (file, value) => fs.writeFile(file, JSON.stringify(value));
  await write(path.join(f.out, 'spec.json'), {layers:[]});
  await write(path.join(f.out, 'bound-assets.json'), {layers:[]});
  await write(path.join(f.out, 'registered-assets.json'), []);
  await fs.writeFile(path.join(f.out, 'editor-materials-bound.png'), 'fixture');
  const hash = async file => sha(await fs.readFile(file));
  const fingerprint = {recipe:await hash(f.recipe), spec:await hash(path.join(f.out,'spec.json')), bindings:await hash(path.join(f.out,'bound-assets.json'))};
  await write(path.join(f.out, 'layer-audit/audit.json'), {status:'complete', restoredAfterReload:true, fingerprint});
  await write(path.join(f.root, 'copyright-evidence.json'), {categories:{}});
  await write(path.join(f.out, 'visual-review.json'), {passed:true, spec_sha256:fingerprint.spec});
  await write(path.join(f.out, 'material-review.json'), {passed:true, bindings_sha256:fingerprint.bindings, evidence_sha256:await hash(path.join(f.root,'copyright-evidence.json'))});
  const gate = path.join(f.root, 'gates/04-final');
  await fs.mkdir(gate, {recursive:true});
  const inputs = {};
  for (const file of [f.recipe, ...['spec.json','bound-assets.json','registered-assets.json','editor-materials-bound.png','layer-audit/audit.json'].map(name=>path.join(f.out,name))]) inputs[file] = await hash(file);
  await write(path.join(gate, 'request.json'), {name:'04-final', token:'test-token', input_sha256:inputs});
  await write(path.join(gate, 'response.json'), {passed:true, token:'test-token', checks:['Actual fixture review']});
  return gate;
}
test('serial same-page execution, timings, and rerun never skips from journal', async t => {
  const f = await fixture(t), page = {}, order = []; let active = 0;
  const handlers = Object.fromEntries(['prepare','bind','audit'].map(step=>[step, async (p,r) => {
    assert.equal(p,page); assert.equal(r,f.recipe); assert.equal(active++,0); order.push(step);
    await new Promise(resolve=>setImmediate(resolve)); active--;
  }]));
  const first = await runSequence(page,f.recipe,{sequence:'prepare,bind,audit'},{handlers});
  const second = await runSequence(page,f.recipe,{sequence:'prepare,bind,audit'},{handlers});
  assert.notEqual(first.attempt_id,second.attempt_id);
  assert.deepEqual(order,['prepare','bind','audit','prepare','bind','audit']);
  const rows = await f.rows(); assert.equal(rows.length,12);
  for (let i=0;i<rows.length;i+=2) {
    assert.equal(rows[i].event,'step_start'); assert.equal(rows[i+1].event,'step_success');
    assert.ok(Number.isFinite(rows[i+1].elapsed_ms) && rows[i+1].elapsed_ms>=0);
    assert.ok(Date.parse(rows[i].at)<=Date.parse(rows[i+1].at));
    assert.equal(rows[i].attempt_id,rows[i+1].attempt_id);
  }
});
test('failure is durable, redacted and stops later steps without retries', async t => {
  const f = await fixture(t), calls = [];
  const handlers = {prepare:async()=>calls.push('prepare'), bind:async()=>{calls.push('bind');throw Error('secret=DO_NOT_LOG');}, audit:async()=>calls.push('audit')};
  await assert.rejects(runSequence({},f.recipe,{sequence:'prepare,bind,audit'},{handlers}), /DO_NOT_LOG/);
  assert.deepEqual(calls,['prepare','bind']);
  const rows = await f.rows(); assert.equal(rows.at(-1).event,'step_failure');
  assert.ok(!JSON.stringify(rows).includes('DO_NOT_LOG'));
});
test('only fixed sequences and absolute paths accepted', async t => {
  const f = await fixture(t);
  for (const sequence of ['prepare,submit','toString','form','prepare,bind,audit,form,submit,declare,verify']) {
    await assert.rejects(runSequence({},f.recipe,{sequence}), /Unsupported/);
  }
  await assert.rejects(runSequence({},'relative.json',{sequence:'prepare,bind,audit'}), /absolute/);
});
test('publication requires matching current final review before any handler', async t => {
  const f = await fixture(t); let calls = 0;
  const handlers = Object.fromEntries(['form','submit','declare','verify'].map(step=>[step,async()=>calls++]));
  await assert.rejects(runSequence({},f.recipe,{sequence:'form,submit,declare,verify'},{handlers}), /absolute/);
  assert.equal(calls,0);
  const finalReviewGate = await approved(f);
  await runSequence({},f.recipe,{sequence:'form,submit,declare,verify',finalReviewGate},{handlers});
  assert.equal(calls,4);
  await fs.appendFile(f.recipe,' ');
  await assert.rejects(runSequence({},f.recipe,{sequence:'form,submit,declare,verify',finalReviewGate},{handlers}), /changed/);
  assert.equal(calls,4);
});
test('published receipt resumes failed declaration without reopening form or clicking submit', async t => {
  const f = await fixture(t), finalReviewGate = await approved(f);
  await fs.writeFile(path.join(f.out,'publication.json'),JSON.stringify({stage:'published',published:true,title:'fixture',topic:'winter',desc:'fixture description'}));
  let declarations = 0, verified = 0;
  const handlers = {form:async()=>{throw Error('must not reopen published form');}, submit:require('./publish.js').submit,
    declare:async()=>{if (++declarations === 1) throw Error('declaration unavailable');}, verify:async()=>verified++};
  const options = {sequence:'form,submit,declare,verify',finalReviewGate};
  await assert.rejects(runSequence({},f.recipe,options,{handlers}), /declaration unavailable/);
  await runSequence({},f.recipe,options,{handlers});
  assert.equal(declarations,2); assert.equal(verified,1);
  assert.equal((await f.rows()).filter(row=>row.recovery==='published-receipt:form-not-reopened').length,2);
  const state = JSON.parse(await fs.readFile(path.join(f.out,'publication.json')));
  state.title='different work'; await fs.writeFile(path.join(f.out,'publication.json'),JSON.stringify(state));
  await assert.rejects(runSequence({},f.recipe,options,{handlers}), /does not match/);
  assert.equal(declarations,2);
});
test('real submit refuses uncertain submission on every batch attempt without browser input', async t => {
  const f = await fixture(t), finalReviewGate = await approved(f);
  await fs.writeFile(path.join(f.out,'publication.json'),JSON.stringify({stage:'submission-started',published:false}));
  let later = 0;
  const handlers = {form:async()=>{}, submit:require('./publish.js').submit, declare:async()=>later++, verify:async()=>later++};
  // No page API exists: any attempted browser interaction would fail the assertion.
  for (let i=0;i<2;i++) await assert.rejects(runSequence({},f.recipe,{sequence:'form,submit,declare,verify',finalReviewGate},{handlers}), /Refusing duplicate or unprepared submission: submission-started/);
  assert.equal(later,0);
  const rows = await f.rows(); assert.equal(rows.filter(r=>r.step==='submit'&&r.event==='step_failure').length,2);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.out,'publication.json'))).stage,'submission-started');
});
