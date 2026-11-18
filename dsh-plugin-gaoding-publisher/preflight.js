/**
 * 进入插件页面时的环境自检。
 *
 * 目标：把「为什么点了没反应」变成开面板就能看到的清单——
 * 依赖组件、浏览器登录、出图能力、运行时环境逐项检查，给出可执行的修复建议。
 *
 * 原则：
 * - 检查本身只读，不改环境、不安装任何东西、不触发付费动作；
 * - 「阻塞项」才禁用创作/投稿，可选组件的缺失只做提示；
 * - 结论来自真实探测（进程能否起、文件是否存在、凭据能否解析），不靠版本号猜。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** 从插件自身位置解析同级安装的插件包：profile 的 node_modules 里有就能找到。 */
function defaultResolvePackage(name) {
  try {
    const require = createRequire(import.meta.url);
    const file = require.resolve(name + '/package.json');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

const CACHE_MS = 30000;

function runIn(execFileImpl, command, args, timeout = 8000) {
  return new Promise(resolve => {
    execFileImpl(command, args, { timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
    });
  });
}

function pythonBinary(runtimeHome, env = process.env) {
  if (env.GAODING_PYTHON) return env.GAODING_PYTHON;
  return join(runtimeHome, '.venv/bin/python');
}

/**
 * @param {object} options
 * @param {string} options.dataRoot 数据目录
 * @param {string} options.runtimeHome 运行时依赖目录
 * @param {string} options.version 插件版本
 * @param {Function} [options.resolveCredential] 读取订阅凭据
 * @param {Function} [options.execFileImpl] 便于测试注入
 * @param {Function} [options.exists] 便于测试注入
 */
export function createPreflight({ dataRoot, runtimeHome, version, resolveCredential, resolvePackage = defaultResolvePackage, execFileImpl = execFile, exists = existsSync, env = process.env }) {
  let cached = null;

  async function collect() {
    const checks = [];

    // 1. 数据目录可写
    try {
      const probeDir = join(dataRoot, '.preflight');
      mkdirSync(probeDir, { recursive: true });
      const file = join(probeDir, 'probe.txt');
      writeFileSync(file, String(Date.now()));
      readFileSync(file, 'utf8');
      rmSync(file, { force: true });
      checks.push({ id: 'data-dir', label: '数据目录可写', status: 'ok', detail: dataRoot });
    } catch (error) {
      checks.push({
        id: 'data-dir', label: '数据目录可写', status: 'fail', blocking: true,
        detail: String(error?.message ?? error),
        fix: '检查目录权限，或用 GAODING_DATA_DIR 指到可写位置后重启 DSH。'
      });
    }

    // 2. Python 运行时（渲染、证据、抠图都依赖它）
    const python = pythonBinary(runtimeHome, env);
    if (!exists(python)) {
      checks.push({
        id: 'python', label: 'Python 运行时', status: 'fail', blocking: true,
        detail: '找不到 ' + python,
        fix: '重新安装本插件（会重建 .venv），或设置 GAODING_PYTHON 指向可用解释器。'
      });
    } else {
      const probe = await runIn(execFileImpl, python, ['-c', 'import PIL, sys; print("pillow", PIL.__version__); print(sys.version.split()[0])'], 15000);
      checks.push(probe.ok
        ? { id: 'python', label: 'Python 运行时', status: 'ok', detail: probe.stdout.replace(/\n/g, ' · ') }
        : { id: 'python', label: 'Python 运行时', status: 'fail', blocking: true, detail: 'Pillow 不可用：' + (probe.stderr || '未知原因').slice(0, 120), fix: '重新安装插件依赖，或 pip install Pillow。' });
    }

    // 3. ego-browser（浏览器自动化载体）
    const ego = env.EGO_BROWSER_BIN || join(env.HOME ?? '', '.local/bin/ego-browser');
    if (exists(ego)) {
      const probe = await runIn(execFileImpl, 'which', [ego], 5000);
      checks.push({ id: 'ego-browser', label: 'ego-browser 浏览器工具', status: 'ok', detail: probe.ok ? ego : ego + '（路径存在）' });
    } else {
      const which = await runIn(execFileImpl, 'which', ['ego-browser'], 5000);
      checks.push(which.ok
        ? { id: 'ego-browser', label: 'ego-browser 浏览器工具', status: 'ok', detail: which.stdout }
        : { id: 'ego-browser', label: 'ego-browser 浏览器工具', status: 'fail', blocking: true, detail: '未安装或不在 PATH', fix: '安装 ego-browser，或安装后在 PATH 里可用；也可以用 EGO_BROWSER_BIN 指定。' });
    }

    // 4. 浏览器登录态（只是记录级检查，深度探测走 /session/probe）
    const sessionFile = join(dataRoot, 'catalog/session.json');
    if (exists(sessionFile)) {
      let session = null;
      try { session = JSON.parse(readFileSync(sessionFile, 'utf8')); } catch {}
      checks.push({
        id: 'browser-login', label: '稿定浏览器登录态', status: session?.space ? 'ok' : 'warn',
        detail: session?.space ? '复用 TaskSpace ' + session.space : '会话文件存在但没有可用空间',
        fix: '在「话题与规范」页点「检查登录」，必要时打开登录页扫码。'
      });
    } else {
      checks.push({
        id: 'browser-login', label: '稿定浏览器登录态', status: 'warn',
        detail: '还没有登录记录',
        fix: '在「话题与规范」页点「检查登录」完成一次登录。'
      });
    }

    // 5. DSH 图像插件（dsh-image-gen）是否安装：出图界面和订阅登录都靠它
    const imageGen = resolvePackage('dsh-image-gen');
    checks.push(imageGen
      ? { id: 'image-plugin', label: 'DSH 图像插件（dsh-image-gen）', status: 'ok', detail: '已安装 v' + (imageGen.version ?? '?') }
      : {
        id: 'image-plugin', label: 'DSH 图像插件（dsh-image-gen）', status: 'warn',
        detail: '未安装',
        fix: '在 Plugin Manager 安装 dsh-image-gen（用于订阅登录与出图）；不装就只能用 GD CLI（稿豆）。'
      });

    // 6. 出图能力：决定「全自动」能不能真的自动
    if (!resolveCredential) {
      checks.push({ id: 'image-gen', label: '出图能力（0 稿豆）', status: 'warn', detail: '未注入凭据服务', fix: '重启 DSH 或重新安装插件。' });
    } else {
      const keys = ['CODEX_OAUTH_1', 'CHATGPT_OAUTH_1', 'OPENAI_OAUTH_1'];
      let found = null;
      for (const key of keys) {
        const value = await resolveCredential(key).catch(() => null);
        if (value && String(value).trim()) { found = key; break; }
      }
      checks.push(found
        ? { id: 'image-gen', label: '出图能力（0 稿豆）', status: 'ok', detail: '订阅凭据 ' + found + ' 可用' }
        : {
          id: 'image-gen', label: '出图能力（0 稿豆）', status: 'warn',
          detail: '没有可用的 ChatGPT 订阅凭据',
          fix: '在 DSH 图像插件里登录订阅账号；或把创作后端改成「本机 GD CLI」（消耗稿豆）。全自动会停在等待素材。'
        });
    }

    // 7. GD CLI（可选后端）：不同安装方式的可执行名不一样，逐个试。
    let gd = { ok: false, stdout: '' };
    for (const name of ['gd', 'gaoding', 'gaoding-cli']) {
      gd = await runIn(execFileImpl, 'which', [name], 5000);
      if (gd.ok) break;
    }
    checks.push(gd.ok
      ? { id: 'gd-cli', label: 'GD CLI（可选后端）', status: 'ok', detail: gd.stdout }
      : { id: 'gd-cli', label: 'GD CLI（可选后端）', status: 'info', detail: '未安装；不影响默认路径', fix: '需要稿豆出图时再安装。' });

    // 8. 插件版本（提醒刷新页面）
    checks.push({ id: 'plugin', label: '插件版本', status: 'ok', detail: version });

    const blocking = checks.filter(check => check.blocking && check.status === 'fail');
    const warnings = checks.filter(check => check.status === 'warn');
    return {
      ok: blocking.length === 0,
      version,
      checkedAt: new Date().toISOString(),
      checks,
      blocking: blocking.map(check => ({ id: check.id, label: check.label, detail: check.detail, fix: check.fix })),
      warnings: warnings.map(check => ({ id: check.id, label: check.label, detail: check.detail, fix: check.fix }))
    };
  }

  return {
    async run({ refresh = false } = {}) {
      if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
      const value = await collect();
      cached = { at: Date.now(), value };
      return value;
    }
  };
}
