import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildImageInput, resultUri, creatorStatus, defaultModel, gdCliBinary } from './creator.js';

function fakeSpawn(stdout, { code = 0, stderr = '' } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { end: () => {} };
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
}

const unit = {
  id: 'unit-1', index: 1,
  brief: { canvas: ['2000×2000'], topic: '特效系列光效素材' },
  prompt: { prompt: '辉光光环素材，透明背景', negative: '不要文字' }
};

test('image input carries the confirmed prompt, canvas and default model', () => {
  const input = buildImageInput({ unit });
  assert.equal(input.model, defaultModel);
  assert.equal(input.width, '2000');
  assert.equal(input.height, '2000');
  assert.match(input.prompt, /辉光光环素材/);
  assert.match(input.prompt, /避免出现：不要文字/);
});

test('image input refuses units without a confirmed prompt or canvas', () => {
  assert.throws(() => buildImageInput({ unit: { ...unit, prompt: null } }), /还没有确认的 prompt/);
  assert.throws(() => buildImageInput({ unit: { ...unit, brief: { canvas: [] } } }), /缺少可用的画布尺寸/);
});

test('result parsing finds the generated media uri', () => {
  const stdout = JSON.stringify({ content: [{ type: 'resource_link', resource_link: { uri: 'https://cdn.example.com/a.png' } }], usage: { cost: 2 } });
  assert.equal(resultUri(stdout).uri, 'https://cdn.example.com/a.png');
  assert.equal(resultUri(JSON.stringify({ content: [] })).uri, null);
});

test('creator status reports login, balance and priced models', async () => {
  const spawnProcess = (binary, args) => {
    const list = args[0];
    if (list === 'auth') return fakeSpawn('已登录\n账号: 123 (123)\n', {})(binary, args);
    if (list === 'credits') return fakeSpawn('概览余额：384 稿豆\n')(binary, args);
    if (list === 'model') return fakeSpawn(JSON.stringify({ models: [{ model: 'Seedream-5-0-flash', title: 'Flash', cost: { unit: 'gaodou', minimum: 2, maximum: 2 } }, { model: 'x', cost: { unit: 'usd' } }] }))(binary, args);
    return fakeSpawn('')(binary, args);
  };
  const status = await creatorStatus({ executable: '/fake/gd-cli', spawnProcess });
  assert.equal(status.available, true);
  assert.equal(status.authed, true);
  assert.equal(status.account, '123');
  assert.equal(status.credits, 384);
  assert.deepEqual(status.models.map(m => m.model), ['Seedream-5-0-flash'], 'only gaodou-priced models are listed');
});

test('creator status reports a missing CLI instead of pretending', async () => {
  const status = await creatorStatus({ executable: '/definitely/missing/gd-cli', spawnProcess: () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end: () => {} }; setImmediate(() => child.emit('error', Error('spawn missing ENOENT'))); return child; } });
  assert.equal(status.available, false);
  assert.match(status.error, /ENOENT|missing/);
});

test('the binary resolves to an explicit path when provided', () => {
  assert.equal(gdCliBinary('/tmp/gd-cli'), '/tmp/gd-cli');
});

test('audit-sensitive words are stripped from negative prompts before sending', async () => {
  const { sanitizeNegative, buildImageInput } = await import('./creator.js');
  const cleaned = sanitizeNegative('Logo、宗教符号、国旗、暴力元素、血腥画面、噪点、模糊低清');
  assert.deepEqual(cleaned.removed, ['宗教符号', '国旗', '暴力元素', '血腥画面']);
  assert.match(cleaned.negative, /Logo/);
  assert.ok(!/国旗|宗教|暴力|血腥/.test(cleaned.negative));
  const input = buildImageInput({
    unit: {
      brief: { canvas: ['2000×2000'] },
      prompt: { prompt: '羊年艺术字贴纸', negative: '国旗、噪点' }
    }
  });
  assert.ok(!/国旗/.test(input.prompt));
  assert.deepEqual(input.negativeRemoved, ['国旗']);
});
