/**
 * 发布队列：把待投稿任务按顺序跑完，失败逐条记录，不阻塞其余任务。
 *
 * 为什么要队列而不是直接并发：同一个 ego-browser TaskSpace 只能串行操作，
 * 并发只会互相抢页面配额和表单。所以队列固定串行，但状态持久化，
 * 插件重启后能看出跑到哪、哪些失败、能否续跑。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function queueFile(dataRoot) { return join(dataRoot, 'runtime', 'publish-queue.json'); }

export function readQueue(dataRoot) {
  const file = queueFile(dataRoot);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeQueue(dataRoot, value) {
  const file = queueFile(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  // 原子替换：进程被杀也不会留下半个文件
  renameSync(temp, file);
  return value;
}

/**
 * 新建队列。items 只接受还没投过的任务；已发布/已取消的由调用方先过滤。
 */
export function createQueue({ dataRoot, items, submit = true, now = new Date() }) {
  const queue = {
    schema: 1,
    running: false,
    stopRequested: false,
    submit: submit !== false,
    startedAt: null,
    finishedAt: null,
    createdAt: now.toISOString(),
    items: items.map(({ taskId, topic, kind }) => ({
      taskId, topic: topic ?? null, kind: kind ?? null,
      state: 'pending', attempts: 0, error: null, contentId: null, finishedAt: null
    }))
  };
  writeQueue(dataRoot, queue);
  return queue;
}

/**
 * 逐个执行队列。runOne(item) 返回 { ok, contentId?, error? }。
 * 单个任务失败不中断队列（真实投稿失败原因常常是稿件本身的问题）。
 */
export async function runQueue({ dataRoot, runOne, onEvent }) {
  const queue = readQueue(dataRoot);
  if (!queue) throw Error('还没有发布队列');
  if (queue.running) return { alreadyRunning: true, queue };
  queue.running = true;
  queue.stopRequested = false;
  queue.startedAt = queue.startedAt ?? new Date().toISOString();
  queue.finishedAt = null;
  writeQueue(dataRoot, queue);
  onEvent?.({ type: 'start', queue });

  for (const item of queue.items) {
    if (item.state !== 'pending') continue;
    const current = readQueue(dataRoot);
    if (current?.stopRequested || queue.stopRequested) {
      queue.stopRequested = true;
      break;
    }
    item.state = 'running';
    item.attempts += 1;
    writeQueue(dataRoot, queue);
    onEvent?.({ type: 'item-start', item });
    try {
      const result = await runOne(item);
      item.state = result?.ok ? 'done' : 'failed';
      item.contentId = result?.contentId ?? null;
      item.error = result?.ok ? null : String(result?.error ?? '未返回结果');
    } catch (error) {
      item.state = 'failed';
      item.error = String(error?.message ?? error);
    }
    item.finishedAt = new Date().toISOString();
    // 停止请求可能在本件执行期间写盘：落盘前先合并，别用内存里的旧值把它盖掉。
    const disk = readQueue(dataRoot);
    if (disk?.stopRequested) queue.stopRequested = true;
    writeQueue(dataRoot, queue);
    onEvent?.({ type: 'item-end', item });
  }

  queue.running = false;
  queue.finishedAt = new Date().toISOString();
  const pending = queue.items.filter(row => row.state === 'pending').length;
  queue.finishedCleanly = pending === 0;
  writeQueue(dataRoot, queue);
  onEvent?.({ type: 'finish', queue });
  return { queue };
}

/** 请求停止：当前这一件跑完就停，剩下的保留 pending 便于续跑。 */
export function requestStop(dataRoot) {
  const queue = readQueue(dataRoot);
  if (!queue) throw Error('还没有发布队列');
  queue.stopRequested = true;
  writeQueue(dataRoot, queue);
  return queue;
}

/** 汇总：done / failed / pending 计数，面板直接显示。 */
export function summarizeQueue(queue) {
  if (!queue) return null;
  const count = state => queue.items.filter(row => row.state === state).length;
  return {
    total: queue.items.length,
    done: count('done'),
    failed: count('failed'),
    pending: count('pending'),
    running: queue.running,
    stopRequested: queue.stopRequested,
    startedAt: queue.startedAt,
    finishedAt: queue.finishedAt,
    failures: queue.items.filter(row => row.state === 'failed').map(row => ({ taskId: row.taskId, topic: row.topic, error: row.error }))
  };
}
