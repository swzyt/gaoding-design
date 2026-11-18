import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreflight } from './preflight.js';

function fakeExec({ python = true, ego = true, gd = false } = {}) {
  return (command, args, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const full = command + ' ' + args.join(' ');
    if (full.startsWith('which ego-browser')) return done(ego ? null : Error('not found'), ego ? '/usr/local/bin/ego-browser\n' : '', '');
    if (full.startsWith('which gd')) return done(gd ? null : Error('not found'), gd ? '/usr/local/bin/gd\n' : '', '');
    if (command === 'which') return done(null, '/usr/local/bin/x\n', '');
    if (args.includes('-c') && String(args[1]).includes('PIL')) {
      return done(python ? null : Error('no pillow'), python ? 'pillow 10.0.0\n3.12.0\n' : '', python ? '' : 'ModuleNotFoundError: PIL');
    }
    return done(null, '', '');
  };
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'preflight-test-'));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a fully configured environment reports ok with no blocking items', async () => {
  const { root, cleanup } = workspace();
  try {
    const preflight = createPreflight({
      dataRoot: join(root, 'data'),
      runtimeHome: join(root, 'runtime'),
      version: '9.9.9',
      resolveCredential: async key => (key === 'CODEX_OAUTH_1' ? '{"accessToken":"x"}' : null),
      execFileImpl: fakeExec(),
      exists: () => true
    });
    const result = await preflight.run();
    assert.equal(result.ok, true);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.version, '9.9.9');
    assert.ok(result.checks.some(check => check.id === 'python' && check.status === 'ok'));
    assert.ok(result.checks.some(check => check.id === 'image-gen' && check.status === 'ok'));
  } finally { cleanup(); }
});

test('missing image credentials are a warning that explains the fallback', async () => {
  const { root, cleanup } = workspace();
  try {
    const preflight = createPreflight({
      dataRoot: join(root, 'data'), runtimeHome: join(root, 'runtime'), version: '1',
      resolveCredential: async () => null, execFileImpl: fakeExec(), exists: () => true
    });
    const result = await preflight.run();
    assert.equal(result.ok, true, '出图凭据缺失不阻塞其它功能');
    const warning = result.warnings.find(row => row.id === 'image-gen');
    assert.ok(warning, '要提示出图不可用');
    assert.match(warning.fix, /GD CLI|登录/);
  } finally { cleanup(); }
});

test('a broken python runtime blocks creation and says how to fix it', async () => {
  const { root, cleanup } = workspace();
  try {
    const preflight = createPreflight({
      dataRoot: join(root, 'data'), runtimeHome: join(root, 'runtime'), version: '1',
      resolveCredential: async () => '{}', execFileImpl: fakeExec({ python: false }), exists: () => true
    });
    const result = await preflight.run();
    assert.equal(result.ok, false);
    assert.ok(result.blocking.some(row => row.id === 'python' && /Pillow/.test(row.detail)));
    assert.ok(result.blocking[0].fix, '阻塞项必须给修复建议');
  } finally { cleanup(); }
});

test('missing ego-browser blocks the panel and points at installation', async () => {
  const { root, cleanup } = workspace();
  try {
    const preflight = createPreflight({
      dataRoot: join(root, 'data'), runtimeHome: join(root, 'runtime'), version: '1',
      resolveCredential: async () => '{}',
      execFileImpl: fakeExec({ ego: false }),
      exists: path => !String(path).includes('ego-browser')
    });
    const result = await preflight.run();
    assert.ok(result.blocking.some(row => row.id === 'ego-browser'));
  } finally { cleanup(); }
});

test('results are cached briefly so entering the page does not re-probe every render', async () => {
  const { root, cleanup } = workspace();
  try {
    let probes = 0;
    const preflight = createPreflight({
      dataRoot: join(root, 'data'), runtimeHome: join(root, 'runtime'), version: '1',
      resolveCredential: async () => { probes++; return '{}'; },
      execFileImpl: fakeExec(), exists: () => true
    });
    await preflight.run();
    const first = probes;
    await preflight.run();
    assert.equal(probes, first, '短时间内复用缓存');
    await preflight.run({ refresh: true });
    assert.equal(probes, first + 1, 'refresh 强制重新探测');
  } finally { cleanup(); }
});
