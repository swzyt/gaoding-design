/**
 * 插件自己出图：直接复用 DSH 图像插件已登录的 ChatGPT 订阅凭据。
 *
 * 为什么要这一步：DSH 的 `generate_image` 是 Agent 工具，插件进程调不到它；
 * 但凭据是存在 Host credentials 里的（`CHATGPT_OAUTH_1`），协议也固定，
 * 所以插件可以自己发请求，让「全自动」真正不需要人（或 Agent）介入，也不消耗稿豆。
 *
 * 失败一律返回明确原因，调用方回落到「等待 Agent 出图」的交接模式。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const IMAGE_URL = 'https://chatgpt.com/backend-api/codex/images/generations';
const MODEL = 'gpt-image-2.6-flare';
/** DSH 图像插件按「供应商名」存订阅凭据；chatgpt-sub 的底层供应商是 codex。 */
export const CREDENTIAL_KEYS = ['CODEX_OAUTH_1', 'CHATGPT_OAUTH_1', 'OPENAI_OAUTH_1'];
export const CREDENTIAL_KEY = CREDENTIAL_KEYS[0];

/** 请求尺寸只接受平台认可的档位：按目标宽高比选最接近的一档。 */
export function sizeFor(width, height) {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.2) return '1536x1024';
  if (ratio < 0.83) return '1024x1536';
  return '1024x1024';
}

/** 把目标画布写进 prompt：订阅通道会按提示里的比例出图。 */
export function promptWithCanvas(prompt, width, height) {
  const text = String(prompt ?? '').trim();
  if (!text) return text;
  if (/\d{3,5}\s*[×x]\s*\d{3,5}/.test(text)) return text;
  return text + '\n画布 ' + width + '×' + height + ' 像素，竖版构图。';
}

function parseBlob(raw) {
  const value = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) throw Error('订阅凭据格式不对');
  return {
    accessToken: String(value.accessToken ?? ''),
    refreshToken: String(value.refreshToken ?? ''),
    expiresAt: Number(value.expiresAt) || 0,
    accountId: String(value.accountId ?? ''),
    label: String(value.label ?? ''),
    email: String(value.email ?? '')
  };
}

/**
 * @param {object} options
 * @param {Function} options.resolveCredential 由 Host 注入：读取 CHATGPT_OAUTH_1
 * @param {Function} [options.saveCredential] 刷新后的凭据写回
 * @param {Function} [options.fetchImpl]
 */
export function createImageClient({ resolveCredential, saveCredential, fetchImpl = fetch } = {}) {
  let cache = null;

  async function loadBlob() {
    // 每轮都读一次：用户在别处重新登录后能立刻生效。
    let key = null;
    let raw = null;
    for (const candidate of CREDENTIAL_KEYS) {
      const value = await resolveCredential(candidate).catch(() => null);
      if (value && String(value).trim()) { key = candidate; raw = value; break; }
    }
    if (!raw) {
      const error = Error('没有可用的 ChatGPT 订阅凭据（' + CREDENTIAL_KEYS.join(' / ') + ' 均未配置）');
      error.code = 'IMAGE_CREDENTIAL_MISSING';
      throw error;
    }
    cache = parseBlob(String(raw));
    cache.key = key;
    return cache;
  }

  async function refresh(blob) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: blob.refreshToken
    });
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = Error('订阅凭据刷新失败：HTTP ' + response.status);
      error.code = 'IMAGE_CREDENTIAL_EXPIRED';
      throw error;
    }
    const next = {
      ...blob,
      accessToken: String(payload.access_token ?? ''),
      refreshToken: String(payload.refresh_token ?? blob.refreshToken),
      expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000
    };
    if (!next.accessToken) throw Error('订阅凭据刷新后没有 access_token');
    if (saveCredential) await saveCredential(blob.key ?? CREDENTIAL_KEY, JSON.stringify(next)).catch(() => {});
    cache = next;
    return next;
  }

  async function ensureFresh() {
    const blob = cache ?? await loadBlob();
    if (blob.expiresAt && blob.expiresAt - Date.now() < 120000) return refresh(blob);
    return blob;
  }

  /** 生成一张图，返回 { buffer, width, height }（PNG 字节）。 */
  async function generate({ prompt, width, height, timeout = 240000 }) {
    const blob = await ensureFresh();
    const size = sizeFor(width, height);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(IMAGE_URL, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + blob.accessToken,
          'chatgpt-account-id': blob.accountId,
          originator: 'codex_cli_rs',
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ prompt: promptWithCanvas(prompt, width, height), model: MODEL, size }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = JSON.stringify(payload).slice(0, 160);
        const error = Error('出图请求失败：HTTP ' + response.status + ' ' + detail);
        error.code = response.status === 401 || response.status === 403 ? 'IMAGE_CREDENTIAL_EXPIRED' : 'IMAGE_REQUEST_FAILED';
        throw error;
      }
      const row = (Array.isArray(payload.data) ? payload.data : []).find(item => typeof item?.b64_json === 'string');
      if (!row) throw Error('出图响应里没有图片数据');
      return { buffer: Buffer.from(row.b64_json, 'base64'), width, height, revisedPrompt: row.revised_prompt ?? null };
    } finally {
      clearTimeout(timer);
    }
  }

  return { generate };
}

/** 用 Pillow 把图缩放并（按需）把白底抠成透明，返回真实尺寸与 alpha 信息。 */
export function normalizeAsset({ python, input, output, width, height, requireAlpha }) {
  return new Promise((resolve, reject) => {
    const script = [
      'import sys, json',
      'from PIL import Image, ImageDraw',
      'src, dst, w, h, need_alpha = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5] == "1"',
      'im = Image.open(src).convert("RGBA")',
      'if (im.width, im.height) != (w, h):',
      '    im = im.resize((w, h), Image.Resampling.LANCZOS)',
      'matted = False',
      'if need_alpha:',
      '    corners = [im.getpixel(p) for p in [(0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1)]]',
      '    if all(c[0] > 236 and c[1] > 236 and c[2] > 236 for c in corners) and min(im.getchannel("A").getdata()) > 20:',
      '        rgb = im.convert("RGB")',
      '        for corner in [(0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1)]:',
      '            try: ImageDraw.floodfill(rgb, corner, (255, 0, 255), thresh=26)',
      '            except Exception: pass',
      '        px = rgb.load(); alpha = im.getchannel("A"); ap = alpha.load()',
      '        for y in range(im.height):',
      '            for x in range(im.width):',
      '                if px[x, y] == (255, 0, 255): ap[x, y] = 0',
      '        im.putalpha(alpha); matted = True',
      'im.save(dst)',
      'a = im.getchannel("A"); mn = min(a.getdata())',
      'print(json.dumps({"matted": matted, "width": im.width, "height": im.height, "hasAlpha": mn < 255, "minAlpha": mn}))'
    ].join('\n');
    execFile(python, ['-c', script, input, output, String(width), String(height), requireAlpha ? '1' : '0'], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) return reject(Error('素材后处理失败：' + String(stderr || error.message).slice(0, 200)));
      try { resolve(JSON.parse(stdout.trim())); } catch (parseError) { reject(parseError); }
    });
  });
}

/**
 * 把一次素材请求全部生成并写回执，供创作流程直接继续。
 * 任何一张失败都会抛出，由调用方回落到人工/Agent 交接。
 */
export async function fillAssetRequest({ client, runDir, request, python, onProgress }) {
  const dir = join(runDir, 'generated');
  mkdirSync(dir, { recursive: true });
  const assets = [];
  const writeResponse = () => {
    writeFileSync(join(runDir, 'generated-assets', 'response.json'), JSON.stringify({
      schema: 1, token: request.token, provider: 'chatgpt-sub', model: MODEL, generatedBy: 'plugin', assets
    }, null, 2) + '\n');
  };
  for (const want of request.assets ?? []) {
    onProgress?.({ generating: want.id, total: request.assets.length, done: assets.length });
    // 已经生成过且尺寸正确的素材直接复用：插件重装/中断后继续跑不该再花一次额度。
    const existing = join(dir, want.id + '.png');
    const reused = existingAsset(existing, want);
    if (reused) {
      assets.push(reused);
      writeResponse();
      continue;
    }
    const image = await client.generate({ prompt: want.prompt, width: want.width, height: want.height });
    const raw = join(dir, want.id + '.raw.png');
    writeFileSync(raw, image.buffer);
    const target = join(dir, want.id + '.png');
    const info = await normalizeAsset({ python, input: raw, output: target, width: want.width, height: want.height, requireAlpha: want.require_alpha === true });
    const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
    assets.push({
      id: want.id,
      path: 'generated/' + want.id + '.png',
      sha256,
      width: info.width,
      height: info.height,
      hasAlpha: info.hasAlpha,
      reused: false
    });
    // 每张落地就写回执：进程被杀也不丢已完成的素材。
    writeResponse();
  }
  writeResponse();
  return { schema: 1, token: request.token, provider: 'chatgpt-sub', model: MODEL, generatedBy: 'plugin', assets };
}

/** 复用已存在的素材文件：尺寸对得上才算数。 */
function existingAsset(file, want) {
  try {
    if (!existsSync(file)) return null;
    const info = pngSize(file);
    if (!info) return null;
    if (Math.abs(info.w - want.width) > 2 || Math.abs(info.h - want.height) > 2) return null;
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    return { id: want.id, path: 'generated/' + want.id + '.png', sha256, width: info.w, height: info.h, hasAlpha: info.colorType === 6 || info.colorType === 4, reused: true };
  } catch { return null; }
}

/** 读 PNG 头部尺寸，避免为校验拉起 Python。 */
function pngSize(file) {
  try {
    const buffer = readFileSync(file);
    if (buffer.length < 24 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
    return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20), colorType: buffer[25] };
  } catch { return null; }
}
