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
  const [x, y, w, h] = L.box;
  const st = {
    font: { name: L.font || 'PingFangSC-Regular' },
    fontSize: L.size || 40,
    fillColor: c(L.color || [0, 0, 0]),
  };
  if (L.stroke) { st.strokeColor = c(L.stroke[0]); st.outlineWidth = L.stroke[1]; st.fillFlag = true; st.strokeFlag = true; }
  return {
    name: L.name,
    top: y, left: x, right: x + w, bottom: y + h,
    text: { text: L.text, transform: [1, 0, 0, 1, x, y], style: st },
  };
});

const imageResources = spec.canvas.dpi ? {
  resolutionInfo: {
    horizontalResolution: spec.canvas.dpi, horizontalResolutionUnit: 'PPI', widthUnit: 'Centimeters',
    verticalResolution: spec.canvas.dpi, verticalResolutionUnit: 'PPI', heightUnit: 'Centimeters'
  }
} : undefined;
fs.writeFileSync(out, writePsdBuffer({ width: W, height: H, children, imageResources }));
console.log('wrote', out, 'layers:', children.length);
