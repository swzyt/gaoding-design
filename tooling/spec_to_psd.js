#!/usr/bin/env node
/**
 * spec -> PSD 生成器（稿定「导入文件」可解析：图层名保留、文字可编辑、位置准确）
 * 用法: node spec_to_psd.js spec.json out.psd
 * spec: { canvas:{w,h}, layers:[
 *   {name, type:"image", box:[x,y], png:"path.png"}                  // 每个元素独立 PNG
 *   {name, type:"text", box:[x,y,w,h], text, font, size, color:[r,g,b], stroke?:[[r,g,b],width]}
 * ]}
 * 关键: 文字层必须写 layer 的 top/left/right/bottom，稿定才认位置（transform 会失效）。
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { writePsdBuffer } = require('ag-psd');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3];
const W = spec.canvas.w, H = spec.canvas.h;
const c = (a) => ({ r: a[0], g: a[1], b: a[2] });

const children = spec.layers.map((L, idx) => {
  if (L.type === 'image') {
    const png = PNG.sync.read(fs.readFileSync(path.resolve(path.dirname(process.argv[2]), L.png)));
    const data = new Uint8Array(png.data);
    return {
      name: L.name,
      top: L.box[1], left: L.box[0], right: L.box[0] + png.width, bottom: L.box[1] + png.height,
      imageData: { width: png.width, height: png.height, data },
    };
  }
  if (L.type !== 'text') throw new Error(`Unsupported layer type: ${L.type}`);
  const [x, y, w, h] = L.box;
  const size = L.size ?? 40;
  const align = L.align ?? 'left';
  const ratio = L.line_height ?? 1.25;
  const spacing = L.letter_spacing ?? 0;
  if (!['left', 'center', 'right'].includes(align)) throw new Error(`${L.name}: unsupported align`);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(spacing)) throw new Error(`${L.name}: invalid text metrics`);
  if ((L.rotation ?? 0) !== 0) throw new Error(`${L.name}: rotation is unsupported by the native editor importer`);
  for (const key of ['font_weight', 'font_style', 'weight', 'bold', 'italic', 'fauxBold', 'fauxItalic', 'text_effects', 'effects', 'warp', 'styleRuns', 'tracking', 'leading', 'shadow', 'gradient', 'opacity', 'vertical', 'text_transform', 'underline', 'strikethrough']) {
    if (key in L) throw new Error(`${L.name}: unsupported text field ${key}; select a real font face`);
  }
  const color = L.color ?? [0, 0, 0];
  if (!Array.isArray(color) || ![3, 4].includes(color.length) || color.some(v => !Number.isInteger(v) || v < 0 || v > 255) || (color.length === 4 && color[3] !== 255)) throw new Error(`${L.name}: text color must be opaque RGB bytes`);
  if (typeof L.text !== 'string' || !L.text || /[\r\t]/.test(L.text)) throw new Error(`${L.name}: text must be nonempty LF-delimited lines without tabs/CR`);
  if (spacing && /[\p{M}\p{Cf}\u0590-\u08ff\u0900-\u0dff\u{10000}-\u{10ffff}]/u.test(L.text)) throw new Error(`${L.name}: letter_spacing requires simple Latin/CJK text`);
  // Match Python round() for half-pixel legacy baseline steps (ties to even).
  const rawLeading = size * ratio;
  const floorLeading = Math.floor(rawLeading);
  const leading = rawLeading - floorLeading === 0.5 ? floorLeading + (floorLeading % 2) : Math.round(rawLeading);
  if (leading < 1 || (L.leading_px !== undefined && L.leading_px !== leading)) throw new Error(`${L.name}: inconsistent leading_px`);
  const st = {
    font: { name: L.font || 'PingFangSC-Regular' },
    fontSize: size,
    fillColor: c(L.color || [0, 0, 0]),
    autoLeading: false, leading,
    tracking: spacing * 1000 / size,
  };
  if (spacing) { st.autoKerning = false; st.kerning = 0; st.ligatures = false; }
  if (L.stroke) {
    if (!Array.isArray(L.stroke) || L.stroke.length !== 2 || !Array.isArray(L.stroke[0]) || L.stroke[0].length !== 3 || L.stroke[0].some(v => !Number.isInteger(v) || v < 0 || v > 255) || !Number.isInteger(L.stroke[1]) || L.stroke[1] < 0) throw new Error(`${L.name}: invalid stroke`);
    st.strokeColor = c(L.stroke[0]); st.outlineWidth = L.stroke[1]; st.fillFlag = true; st.strokeFlag = L.stroke[1] > 0; st.fillFirst = false;
  }
  // Box text keeps paragraph justification relative to the requested box.
  // A raster cache is part of this same editable text layer, never an extra image layer.
  const inset = L.stroke ? L.stroke[1] : 0;
  const layer = {
    name: L.name,
    top: y, left: x, right: x + w, bottom: y + h,
    text: { text: L.text, transform: [1, 0, 0, 1, x, y], style: st,
      paragraphStyle: { justification: align }, shapeType: 'box', boxBounds: [inset, inset, w-inset, h-inset] },
  };
  if (L.text_cache) {
    const png = PNG.sync.read(fs.readFileSync(path.resolve(path.dirname(process.argv[2]), L.text_cache)));
    const [cx, cy] = L.text_cache_origin;
    // Include natural side bearings (legacy recipes allow four pixels), never clip ink.
    const left = Math.min(x, cx), top = Math.min(y, cy);
    const right = Math.max(x + w, cx + png.width), bottom = Math.max(y + h, cy + png.height);
    if (left < x - 4 || right > x + w + 4 || top < y || bottom > y + h) throw new Error(`${L.name}: text cache exceeds box`);
    const width = right - left, height = bottom - top;
    const data = new Uint8Array(width * height * 4);
    for (let py = 0; py < png.height; py++) for (let px = 0; px < png.width; px++) {
      const dx = cx - left + px, dy = cy - top + py;
      data.set(png.data.subarray((py * png.width + px) * 4, (py * png.width + px + 1) * 4), (dy * width + dx) * 4);
    }
    Object.assign(layer, {left, top, right, bottom, imageData: { width, height, data }});
  }
  return layer;
});

const imageResources = spec.canvas.dpi ? {
  resolutionInfo: {
    horizontalResolution: spec.canvas.dpi, horizontalResolutionUnit: 'PPI', widthUnit: 'Centimeters',
    verticalResolution: spec.canvas.dpi, verticalResolutionUnit: 'PPI', heightUnit: 'Centimeters'
  }
} : undefined;
fs.writeFileSync(out, writePsdBuffer({ width: W, height: H, children, imageResources }));
console.log('wrote', out, 'layers:', children.length);
