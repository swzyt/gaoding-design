/**
 * 把插件的模板 PSD 导入稿定编辑器，取得设计地址。
 * 复用仓库 prepare 阶段；该阶段可能在后续等待上超时，但只要写出版本一致的设计地址就算成功。
 */
import { spawn } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, workflow, environment } from './runtime-host.js';

export function designUrlOf(state) {
  const url = state?.url ?? '';
  return /^https:\/\/(www\.)?gaoding\.com\/editor\/design\?.*\bid=\d+/.test(url) ? url : null;
}

export function editorStateFile(task) {
  return join(task.release ?? join(task.runDir, 'release'), 'editor-state.json');
}

/**
 * @param {object} options
 * @param {object} options.task 投稿任务（含 runDir / release）
 * @param {number} options.space 当前浏览器空间 ID
 * @param {Function} [options.spawnImpl] 便于测试注入
 * @param {Function} [options.readJsonImpl] 便于测试注入
 * @param {number} [options.timeout] 导入超时（毫秒）
 */
export function ensureEditorImport({ task, space, spawnImpl = spawn, readJsonImpl = readJson, timeout = 420000, binary = workflow, env = environment, forceReimport = false }) {
  const stateFile = editorStateFile(task);
  const existing = forceReimport ? null : designUrlOf(readJsonImpl(stateFile));
  if (existing) return Promise.resolve(existing);
  // 强制重导入时先把旧状态归档：平台对同一个设计不再给「去完善」声明入口，
  // 撤销重发必须换一个新设计，否则声明无法完成。
  if (forceReimport && existsSync(stateFile)) {
    renameSync(stateFile, stateFile + '.superseded-' + Date.now());
  }
  const recipe = join(task.runDir, 'release-recipe.json');
  if (!existsSync(recipe)) return Promise.reject(Error('缺少发布配方，无法导入编辑器'));
  return new Promise((resolve, reject) => {
    // 必须带上插件的运行时环境：否则工作流会去安装目录找 .venv 并报 Dependencies missing。
    const args = [binary, 'browser', 'prepare', recipe, '--space', String(space), '--page', 'p1'];
    const child = spawnImpl('bash', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = data => { output += String(data); if (output.length > 200000) output = output.slice(-100000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      const after = designUrlOf(readJsonImpl(stateFile));
      if (after) return resolve(after);
      reject(Error('PSD 导入编辑器失败：' + (output.trim().slice(-400) || '工作流没有写出设计地址')));
    });
  });
}
