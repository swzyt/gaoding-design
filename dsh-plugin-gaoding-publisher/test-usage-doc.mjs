import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { renderInline, renderMarkdown, readUsage, renderUsagePage } from './usage-doc.js';

test('inline formatting renders code, bold and safe links', () => {
  assert.match(renderInline('用 `npm pack` 打包'), /<code>npm pack<\/code>/);
  assert.match(renderInline('**重要**'), /<strong>重要<\/strong>/);
  const link = renderInline('[教程](./README.md)');
  assert.match(link, /<a href="\.\/README\.md"/);
  assert.doesNotMatch(renderInline('[x](javascript:alert(1))'), /javascript:/, '不安全链接要被丢弃');
});

test('raw HTML in markdown is escaped, never executed', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('headings, lists, tables and code fences render', () => {
  const html = renderMarkdown(['# 标题', '', '- 一', '- 二', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '```', 'echo hi', '```'].join('\n'));
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul>\s*<li>一<\/li>/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code>echo hi<\/code><\/pre>/);
});

test('the packaged tutorial exists and renders to a full page', () => {
  const doc = readUsage(new URL('.', import.meta.url).pathname);
  assert.ok(doc, 'USAGE.md 必须随包存在');
  const page = renderUsagePage({ title: '使用教程', markdown: doc.text, version: '1.2.3' });
  assert.match(page, /<!doctype html>/);
  assert.match(page, /使用教程/);
  assert.ok(page.length > 3000, '页面要有实际内容');
});

test('docs/USAGE.md and the packaged copy stay identical', () => {
  const packaged = new URL('./USAGE.md', import.meta.url).pathname;
  const repoDoc = new URL('../docs/USAGE.md', import.meta.url).pathname;
  if (!existsSync(repoDoc)) return; // 独立安装场景下没有仓库 docs 目录
  assert.equal(readFileSync(packaged, 'utf8'), readFileSync(repoDoc, 'utf8'), '两处教程必须一致，改一处要同步另一处');
});
