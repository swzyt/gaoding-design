/**
 * 面板内的使用教程：把仓库里的 USAGE.md 渲染成可读页面。
 *
 * 只实现教程用得到的子集（标题、段落、列表、表格、代码块、行内样式、链接），
 * 不引第三方依赖，也不允许原始 HTML——文档是我们自己写的，转义后渲染即可。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内：代码、粗体、链接。先转义再替换，避免注入。 */
export function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
    const safe = /^(https?:|\.|\/|#)/.test(href) ? href : '#';
    return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + label + '</a>';
  });
  return out;
}

/** 极简 Markdown → HTML。 */
export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let index = 0;
  let inCode = false;
  let codeLines = [];
  let listType = null;

  const closeList = () => {
    if (listType) { html.push('</' + listType + '>'); listType = null; }
  };

  while (index < lines.length) {
    const line = lines[index];

    if (/^```/.test(line)) {
      if (inCode) {
        html.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      index += 1;
      continue;
    }
    if (inCode) { codeLines.push(line); index += 1; continue; }

    if (!line.trim()) { closeList(); index += 1; continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      index += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) { closeList(); html.push('<hr>'); index += 1; continue; }

    if (/^>\s?/.test(line)) {
      closeList();
      html.push('<blockquote>' + renderInline(line.replace(/^>\s?/, '')) + '</blockquote>');
      index += 1;
      continue;
    }

    // 表格：| a | b | 后跟 | --- | --- |
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?$/.test(lines[index + 1] ?? '')) {
      closeList();
      const cells = row => row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const head = cells(line);
      index += 2;
      const body = [];
      while (index < lines.length && /^\|/.test(lines[index])) { body.push(cells(lines[index])); index += 1; }
      html.push('<table><thead><tr>' + head.map(cell => '<th>' + renderInline(cell) + '</th>').join('') + '</tr></thead><tbody>' +
        body.map(row => '<tr>' + row.map(cell => '<td>' + renderInline(cell) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (ordered || bullet) {
      const type = ordered ? 'ol' : 'ul';
      if (listType !== type) { closeList(); html.push('<' + type + '>'); listType = type; }
      html.push('<li>' + renderInline((ordered ?? bullet)[1]) + '</li>');
      index += 1;
      continue;
    }

    closeList();
    html.push('<p>' + renderInline(line) + '</p>');
    index += 1;
  }

  closeList();
  if (inCode && codeLines.length) html.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
  return html.join('\n');
}

/** 教程正文：优先包内 USAGE.md，其次仓库 docs/USAGE.md。 */
export function readUsage(pluginRoot) {
  const candidates = [join(pluginRoot, 'USAGE.md'), join(pluginRoot, '../docs/USAGE.md')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try { return { file, text: readFileSync(file, 'utf8') }; } catch {}
  }
  return null;
}

/** 完整页面：自带样式，独立窗口打开。 */
export function renderUsagePage({ title, markdown, version }) {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>稿定投稿 · 使用教程</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: Canvas; color: CanvasText;
    font: 15px/1.75 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 24px 80px; }
  .meta { display: flex; gap: 12px; align-items: baseline; padding-bottom: 16px; margin-bottom: 8px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
  .meta strong { font-size: 15px; }
  .meta span { font-size: 12px; opacity: .62; }
  h1 { font-size: 26px; margin: 26px 0 10px; }
  h2 { font-size: 20px; margin: 28px 0 8px; padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  h3 { font-size: 16px; margin: 20px 0 6px; }
  h4 { font-size: 14px; margin: 16px 0 4px; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  code { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: color-mix(in srgb, CanvasText 8%, transparent); padding: 1px 5px; border-radius: 4px; }
  pre { background: color-mix(in srgb, CanvasText 6%, transparent); padding: 12px 14px;
    border-radius: 8px; overflow: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13.5px; }
  th, td { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: color-mix(in srgb, CanvasText 6%, transparent); }
  blockquote { margin: 10px 0; padding: 6px 14px; border-left: 3px solid color-mix(in srgb, CanvasText 25%, transparent); opacity: .85; }
  a { color: #2f6fed; }
  hr { border: none; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); margin: 20px 0; }
</style></head>
<body><main>
<div class="meta"><strong>${escapeHtml(title)}</strong><span>插件 v${escapeHtml(version ?? '?')}</span>
<span>来源：USAGE.md（与仓库、安装包同一份）</span></div>
${body}
</main></body></html>`;
}
