import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSpace, listSpaces } from './browser-space.js';

const marker = 'GAODING_SPACES:';

/** 假的 ego-browser 进程：按脚本内容返回预先准备的数据。 */
function fakeSpawn(responses) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      on() {},
      end(script) {
        const scripted = String(script);
        const reply = scripted.includes('listTaskSpaces()') ? responses.spaces : responses.create;
        child.stdout.emit('data', marker + JSON.stringify(reply) + '\n');
        child.emit('close', 0);
      }
    };
    return child;
  };
}

function session() {
  const dir = mkdtempSync(join(tmpdir(), 'space-test-'));
  const file = join(dir, 'session.json');
  writeFileSync(file, JSON.stringify({ space: 3, checkedAt: '2026-01-01T00:00:00.000Z' }) + '\n');
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a stale space id falls back to an existing agent space and rewrites the session', async () => {
  const { file, cleanup } = session();
  try {
    const spawnProcess = fakeSpawn({
      spaces: [{ id: 0, name: '', ownership: 'user' }, { id: 7, name: '稿定投稿-abc', ownership: 'agent' }],
      create: { id: 9 }
    });
    const resolved = await ensureSpace({ sessionFile: file, spawnProcess });
    assert.equal(resolved.space, 7);
    assert.equal(resolved.created, false);
    assert.equal(resolved.previous, 3);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).space, 7);
  } finally { cleanup(); }
});

test('a live space is reused without creating a new one', async () => {
  const { file, cleanup } = session();
  try {
    const spawnProcess = fakeSpawn({ spaces: [{ id: 3, name: '稿定投稿-x', ownership: 'agent' }], create: { id: 9 } });
    const resolved = await ensureSpace({ sessionFile: file, spawnProcess });
    assert.equal(resolved.space, 3);
    assert.equal(resolved.created, false);
  } finally { cleanup(); }
});

test('with no agent space left a new one is created and persisted', async () => {
  const { file, cleanup } = session();
  try {
    const spawnProcess = fakeSpawn({ spaces: [{ id: 0, name: '', ownership: 'user' }], create: { id: 11 } });
    const resolved = await ensureSpace({ sessionFile: file, spawnProcess });
    assert.equal(resolved.space, 11);
    assert.equal(resolved.created, true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.space, 11);
    assert.ok(saved.spaceResolvedAt);
    // 原有字段不能被冲掉
    assert.equal(saved.checkedAt, '2026-01-01T00:00:00.000Z');
  } finally { cleanup(); }
});

test('a user-owned space with the same name is never adopted', async () => {
  const { file, cleanup } = session();
  try {
    const spawnProcess = fakeSpawn({ spaces: [{ id: 5, name: '稿定投稿-y', ownership: 'user' }], create: { id: 12 } });
    const resolved = await ensureSpace({ sessionFile: file, spawnProcess });
    assert.equal(resolved.space, 12);
    assert.equal(resolved.created, true);
  } finally { cleanup(); }
});

test('listSpaces returns the raw space inventory', async () => {
  const spawnProcess = fakeSpawn({ spaces: [{ id: 1, name: 'a', ownership: 'agent' }], create: { id: 2 } });
  const rows = await listSpaces({ spawnProcess });
  assert.deepEqual(rows, [{ id: 1, name: 'a', ownership: 'agent' }]);
});
