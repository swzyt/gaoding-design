import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPromptRequest, parseModelPrompt, collectStream, generateUnitPrompt } from './prompt-writer.js';

function fakeJob(overrides = {}) {
  return {
    id: 'job-1', kind: 'template', note: '清爽',
    topic: { key: 'topic-a', name: '小红书人像封面' },
    units: [{ id: 'unit-1', index: 1, directory: '/tmp/unit-1', brief: { direction: '教育培训：课程讲解', canvas: ['1242×1656'], forbidden: ['严禁 Logo'], materials: ['封面 1242*1656'], quantity: 2 } }],
    ...overrides
  };
}

test('the request carries the direction, canvas, prohibitions and spec text', () => {
  const request = buildPromptRequest({ job: fakeJob(), unit: fakeJob().units[0], spec: { text: '规范正文'.repeat(400), directions: ['职场服务：就业指南'] } });
  assert.match(request.user, /教育培训：课程讲解/);
  assert.match(request.user, /1242×1656/);
  assert.match(request.user, /严禁 Logo/);
  assert.match(request.user, /清爽/);
  assert.match(request.user, /模板话题/);
  assert.ok(request.user.length < 3000, 'spec text must be truncated');
  assert.match(request.system, /只输出 JSON/);
});

test('material jobs ask for a single asset instead of layers', () => {
  const job = fakeJob({ kind: 'material' });
  const request = buildPromptRequest({ job, unit: job.units[0] });
  assert.match(request.user, /素材话题/);
  assert.match(request.system, /素材话题只描述单张素材/);
});

test('model output parses JSON, fenced JSON, or falls back to raw text', () => {
  const parsed = parseModelPrompt('{"title":"标题","prompt":"完整提示词","negative":"不要二维码","layers":[{"id":"bg","role":"background"}],"assets":[]}');
  assert.equal(parsed.prompt, '完整提示词');
  assert.deepEqual(parsed.layers, [{ id: 'bg', role: 'background' }]);
  const fenced = parseModelPrompt('```json\n{"prompt":"围栏里的提示词"}\n```');
  assert.equal(fenced.prompt, '围栏里的提示词');
  const raw = parseModelPrompt('这是一段没有任何 JSON 的提示词');
  assert.equal(raw.prompt, '这是一段没有任何 JSON 的提示词');
  assert.throws(() => parseModelPrompt('   '), /没有返回内容/);
});

test('stream collection surfaces model errors instead of returning partial text', async () => {
  async function* ok() {
    yield { type: 'text-delta', index: 0, text: '你' };
    yield { type: 'text-delta', index: 0, text: '好' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  assert.equal(await collectStream(ok()), '你好');
  async function* failed() {
    yield { type: 'text-delta', index: 0, text: '半截' };
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '额度不足', code: 'quota' } } };
  }
  await assert.rejects(() => collectStream(failed()), /额度不足/);
});

test('a generated prompt is written as an unconfirmed record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-prompt-'));
  try {
    const job = fakeJob();
    const unit = { ...job.units[0], directory: root };
    const llm = {
      stream() {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '{"title":"测试","prompt":"生成的完整提示词","layers":[{"id":"bg","role":"background","require_alpha":false}]}' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      }
    };
    const result = await generateUnitPrompt({ job, unit, spec: { text: '规范' }, llm, selection: { provider: 'deepseek-account', model: 'deepseek-flash' } });
    assert.equal(result.record.prompt, '生成的完整提示词');
    assert.equal(result.record.confirmed, false);
    assert.equal(result.record.source, 'model');
    assert.deepEqual(result.record.layers, [{ id: 'bg', role: 'background', require_alpha: false }]);
    const saved = JSON.parse(readFileSync(join(root, 'prompt.json'), 'utf8'));
    assert.equal(saved.prompt, '生成的完整提示词', 'the record must be persisted next to the unit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing model or LLM service fails loudly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-prompt-err-'));
  try {
    const job = fakeJob();
    const unit = { ...job.units[0], directory: root };
    await assert.rejects(() => generateUnitPrompt({ job, unit, llm: null, selection: {} }), /没有可用的 LLM/);
    await assert.rejects(() => generateUnitPrompt({ job, unit, llm: { stream() {} }, selection: {} }), /没有可用的默认模型/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
