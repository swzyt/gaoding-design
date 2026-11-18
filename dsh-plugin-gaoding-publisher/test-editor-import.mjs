import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEditorImport, designUrlOf, editorStateFile } from './editor-import.js';

const DESIGN = 'https://www.gaoding.com/editor/design?mode=user&type=poster&width=1242&height=1656&unit=px&dpi=72&id=38651026882684001';

function fakeChild(onData) {
  const child = new EventEmitter();
  child.stdout = { on: (event, cb) => { if (event === 'data') onData(cb); } };
  child.stderr = { on: () => {} };
  child.kill = () => {};
  return child;
}

test('design urls are only accepted when they carry a real design id', () => {
  assert.equal(designUrlOf({ url: DESIGN }), DESIGN);
  assert.equal(designUrlOf({ url: 'https://www.gaoding.com/editor/design?type=poster' }), null);
  assert.equal(designUrlOf({ url: 'https://example.com/editor/design?id=1' }), null);
  assert.equal(designUrlOf(null), null);
});

test('an existing editor state short-circuits the import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-editor-'));
  const state = join(root, 'release', 'editor-state.json');
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(state, JSON.stringify({ url: DESIGN }));
  let spawned = 0;
  const url = await ensureEditorImport({ task: { runDir: root }, space: 3, spawnImpl: () => { spawned++; } , readJsonImpl: file => JSON.parse(readFileSync(file, 'utf8')) });
  assert.equal(url, DESIGN);
  assert.equal(spawned, 0);
});

test('the prepare step runs with the plugin runtime environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-editor-env-'));
  writeFileSync(join(root, 'release-recipe.json'), '{}');
  mkdirSync(join(root, 'release'), { recursive: true });
  const state = join(root, 'release', 'editor-state.json');
  let seen = null;
  const url = await ensureEditorImport({
    task: { runDir: root }, space: 3,
    env: { GAODING_RUNTIME_HOME: '/runtime/home' },
    // 工作流只写 editor-state.json，不 exit 0（prepare 常在后续等待超时）
    spawnImpl: (cmd, args, options) => {
      seen = { cmd, args, options };
      const child = fakeChild(cb => cb('imported layers: 41'));
      setImmediate(() => {
        writeFileSync(state, JSON.stringify({ stage: 'fonts-applying', url: DESIGN }));
        child.emit('close', 1);
      });
      return child;
    },
    readJsonImpl: file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
  });
  assert.equal(url, DESIGN, 'timeout after import must not be treated as failure');
  assert.equal(seen.cmd, 'bash');
  assert.deepEqual(seen.args.slice(1, 3), ['browser', 'prepare']);
  assert.equal(seen.options.env.GAODING_RUNTIME_HOME, '/runtime/home', 'runtime env must reach workflow.sh');
  assert.equal(seen.options.env.PATH, process.env.PATH);
});

test('the import reports the workflow output when no design url appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-editor-fail-'));
  writeFileSync(join(root, 'release-recipe.json'), '{}');
  await assert.rejects(ensureEditorImport({
    task: { runDir: root }, space: 3,
    spawnImpl: () => {
      const child = fakeChild(cb => cb('Dependencies missing. Run this workflow.sh with bootstrap'));
      setImmediate(() => child.emit('close', 1));
      return child;
    },
    readJsonImpl: () => null
  }), /Dependencies missing/);
});

test('a missing recipe is rejected before starting the browser', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-editor-norecipe-'));
  await assert.rejects(ensureEditorImport({ task: { runDir: root }, space: 3, spawnImpl: () => { throw Error('should not spawn'); }, readJsonImpl: () => null }), /缺少发布配方/);
});

test('forceReimport archives the old design so a fresh one is created', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const runDir = mkdtempSync(join(tmpdir(), 'reimport-'));
  const release = join(runDir, 'release');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'editor-state.json'), JSON.stringify({ url: 'https://www.gaoding.com/editor/design?mode=user&id=111' }));
  writeFileSync(join(runDir, 'release-recipe.json'), JSON.stringify({ layers: [] }));
  const task = { runDir, release };
  // 不强制：直接复用旧设计
  const reused = await ensureEditorImport({ task, space: 1 });
  assert.match(reused, /id=111/);
  // 强制：旧状态被归档，随后会重新导入（这里用 spawn 失败证明它确实尝试重新导入）
  let spawned = 0;
  const spawnImpl = () => {
    spawned++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit('close', 1), 10);
    return child;
  };
  await assert.rejects(() => ensureEditorImport({ task, space: 1, forceReimport: true, spawnImpl, timeout: 2000 }));
  assert.equal(spawned, 1, '强制重导入必须真的再跑一次导入');
  const archived = readdirSync(release).filter(name => name.startsWith('editor-state.json.superseded-'));
  assert.equal(archived.length, 1, '旧设计状态要归档留痕');
});
