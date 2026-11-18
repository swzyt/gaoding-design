/**
 * 浏览器空间解析：浏览器重启或空间被关掉后，session.json 里记的空间 ID 会失效。
 * 以前所有接口直接读 session.json 的 space，失效后统一报
 * 「task space not found: 3」，看起来像插件坏了。
 *
 * 这里在每次要用空间前先解析一次：
 *   1. 记录的空间还在 → 直接用；
 *   2. 不在了 → 找同一浏览器里已有的 Agent 空间复用；
 *   3. 都没有 → 新建一个并写回 session.json。
 * 登录态在浏览器 profile 里，重建空间不需要重新登录（仍需真实核验一次）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const marker = 'GAODING_SPACES:';

export function egoBinary(executable) {
  if (executable) return executable;
  if (process.env.EGO_BROWSER_BIN) return process.env.EGO_BROWSER_BIN;
  const local = join(homedir(), '.local/bin/ego-browser');
  return existsSync(local) ? local : 'ego-browser';
}

function runNode(script, { executable, spawnProcess = spawn, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(Error('浏览器空间探测超时')); }, timeout);
    child.on('error', error => finish(error));
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => {
      const line = (stdout + '\n' + stderr).split('\n').filter(row => row.startsWith(marker)).pop();
      if (!line) return finish(Error('浏览器空间探测失败：' + (stderr.trim().slice(-300) || 'exit ' + code)));
      try { finish(null, JSON.parse(line.slice(marker.length))); } catch (error) { finish(error); }
    });
    child.stdin.end(script);
  });
}

/** 列出当前浏览器里的全部空间（只读）。 */
export async function listSpaces({ executable, spawnProcess } = {}) {
  const script = `
const spaces = await listTaskSpaces();
console.log(${JSON.stringify(marker)} + JSON.stringify(spaces.map(row => ({ id: row.id, name: row.name, ownership: row.ownership }))));
`;
  const value = await runNode(script, { executable, spawnProcess });
  return Array.isArray(value) ? value : [];
}

/** 新建（或复用同名）空间并返回它的 ID。 */
export async function createSpace(name, { executable, spawnProcess } = {}) {
  const script = `
const space = await taskSpace(${JSON.stringify(name)});
console.log(${JSON.stringify(marker)} + JSON.stringify({ id: space.spaceId, name: space.name }));
`;
  const value = await runNode(script, { executable, spawnProcess });
  if (!Number.isSafeInteger(value?.id)) throw Error('新建浏览器空间失败');
  return value.id;
}

/**
 * 解析可用的空间 ID，并在 session.json 里记录。
 * 返回 { space, reused, created, previous }，供面板提示「空间已重建」。
 */
export async function ensureSpace({ sessionFile, name = '稿定投稿', executable, spawnProcess } = {}) {
  const record = (() => {
    try { return JSON.parse(readFileSync(sessionFile, 'utf8')); } catch { return null; }
  })();
  const previous = Number.isInteger(record?.space) ? record.space : null;
  let spaces = [];
  let probeError = null;
  try { spaces = await listSpaces({ executable, spawnProcess }); }
  catch (error) { probeError = error; }
  if (previous && spaces.some(row => row.id === previous && row.ownership === 'agent')) {
    return { space: previous, reused: true, created: false, previous, spaces };
  }
  const existing = spaces.find(row => row.ownership === 'agent' && String(row.name ?? '').startsWith(name));
  if (existing) {
    writeSession(sessionFile, record, existing.id);
    return { space: existing.id, reused: true, created: false, previous, spaces };
  }
  if (probeError) throw probeError;
  const space = await createSpace(name + '-' + new Date().toISOString().slice(0, 10), { executable, spawnProcess });
  writeSession(sessionFile, record, space);
  return { space, reused: false, created: true, previous, spaces };
}

function writeSession(sessionFile, record, space) {
  const value = { ...(record ?? {}), space, spaceResolvedAt: new Date().toISOString() };
  writeFileSync(sessionFile, JSON.stringify(value, null, 2) + '\n');
}
