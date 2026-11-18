import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueue, readQueue, requestStop, runQueue, summarizeQueue, writeQueue } from './publish-queue.js';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'queue-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('queue runs items serially and records per-item outcome', async () => {
  const { root, cleanup } = workspace();
  try {
    createQueue({ dataRoot: root, items: [{ taskId: 'a' }, { taskId: 'b' }, { taskId: 'c' }] });
    const seen = [];
    const { queue } = await runQueue({
      dataRoot: root,
      runOne: async item => { seen.push(item.taskId); return item.taskId === 'b' ? { ok: false, error: '失败原因' } : { ok: true, contentId: 'id-' + item.taskId }; }
    });
    assert.deepEqual(seen, ['a', 'b', 'c'], '串行执行且失败不中断');
    const summary = summarizeQueue(queue);
    assert.equal(summary.done, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.failures[0].taskId, 'b');
    assert.equal(readQueue(root).finishedCleanly, true);
  } finally { cleanup(); }
});

test('a throwing runner marks the item failed without killing the queue', async () => {
  const { root, cleanup } = workspace();
  try {
    createQueue({ dataRoot: root, items: [{ taskId: 'a' }, { taskId: 'b' }] });
    const { queue } = await runQueue({
      dataRoot: root,
      runOne: async item => { if (item.taskId === 'a') throw Error('浏览器超时'); return { ok: true, contentId: 'x' }; }
    });
    assert.equal(summarizeQueue(queue).failed, 1);
    assert.match(summarizeQueue(queue).failures[0].error, /浏览器超时/);
    assert.equal(summarizeQueue(queue).done, 1);
  } finally { cleanup(); }
});

test('stop request leaves the remaining items pending for resume', async () => {
  const { root, cleanup } = workspace();
  try {
    createQueue({ dataRoot: root, items: [{ taskId: 'a' }, { taskId: 'b' }, { taskId: 'c' }] });
    const { queue } = await runQueue({
      dataRoot: root,
      runOne: async item => {
        if (item.taskId === 'a') requestStop(root);
        return { ok: true, contentId: 'id-' + item.taskId };
      }
    });
    assert.equal(summarizeQueue(queue).done, 1);
    assert.equal(summarizeQueue(queue).pending, 2, '停止后剩下的任务保持 pending');
    assert.equal(queue.stopRequested, true);
  } finally { cleanup(); }
});

test('running twice does not double-execute', async () => {
  const { root, cleanup } = workspace();
  try {
    createQueue({ dataRoot: root, items: [{ taskId: 'a' }] });
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = runQueue({ dataRoot: root, runOne: async () => { calls++; await gate; return { ok: true }; } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await runQueue({ dataRoot: root, runOne: async () => { calls++; return { ok: true }; } });
    assert.equal(second.alreadyRunning, true);
    release();
    await first;
    assert.equal(calls, 1);
  } finally { cleanup(); }
});

test('queue survives a restart as plain JSON', async () => {
  const { root, cleanup } = workspace();
  try {
    createQueue({ dataRoot: root, items: [{ taskId: 'a' }] });
    const stored = readQueue(root);
    assert.equal(stored.items[0].state, 'pending');
    writeQueue(root, { ...stored, items: [{ ...stored.items[0], state: 'running' }] });
    const reloaded = readQueue(root);
    assert.equal(reloaded.items[0].state, 'running', '重启后能看出上次跑到哪');
    assert.ok(reloaded.updatedAt);
  } finally { cleanup(); }
});
