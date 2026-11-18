import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeFor, promptWithCanvas } from './image-client.js';

test('size picks a supported ratio bucket', () => {
  assert.equal(sizeFor(1242, 1656), '1024x1536');
  assert.equal(sizeFor(2048, 2048), '1024x1024');
  assert.equal(sizeFor(2000, 1200), '1536x1024');
});

test('canvas hint is added only when the prompt has no size', () => {
  assert.match(promptWithCanvas('一只小羊', 1242, 1656), /画布 1242×1656/);
  assert.equal(promptWithCanvas('2000×2000 正方形贴纸', 2000, 2000), '2000×2000 正方形贴纸');
  assert.equal(promptWithCanvas('', 100, 100), '');
});

test('semi transparent edges do not count as a cutout', async () => {
  const { readFileSync } = await import('node:fs');
  const creator = readFileSync(new URL('./creator.js', import.meta.url), 'utf8');
  // min alpha 还在 200+ 的图不能记成「有透明底」，否则平台会当成白底贴纸
  assert.match(creator, /alphaRange\.min > 16 && alphaRange\.min < 255/);
  assert.match(creator, /const hasTransparentPixels = alphaRange \? alphaRange\.min <= 16 : false;/);
});

test('already generated assets are reused instead of spending quota again', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fillAssetRequest } = await import('./image-client.js');
  const runDir = mkdtempSync(join(tmpdir(), 'assets-resume-'));
  mkdirSync(join(runDir, 'generated'), { recursive: true });
  mkdirSync(join(runDir, 'generated-assets'), { recursive: true });
  // 伪造一张合法的 4x4 PNG 头，尺寸与请求一致
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1000, 16); png.writeUInt32BE(1000, 20); png[24] = 8; png[25] = 6;
  writeFileSync(join(runDir, 'generated', 'bg.png'), png);
  let calls = 0;
  const client = { generate: async () => { calls++; throw Error('不该再调用'); } };
  const request = { token: 't', assets: [{ id: 'bg', prompt: 'x', width: 1000, height: 1000, require_alpha: false }] };
  const result = await fillAssetRequest({ client, runDir, request });
  assert.equal(calls, 0, '已有素材必须复用，不能再出一次图');
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].reused, true);
  const saved = JSON.parse(readFileSync(join(runDir, 'generated-assets', 'response.json'), 'utf8'));
  assert.equal(saved.assets[0].id, 'bg');
});
