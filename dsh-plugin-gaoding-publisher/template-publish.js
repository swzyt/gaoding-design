/**
 * 模板投稿：编辑器内发布。
 * 模板发布弹窗（scene=editor）必须与编辑器通信，不能独立打开，
 * 所以在编辑器页面里用无障碍快照的 ref 操作 iframe 内部。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beginSubmission, priorPublication as readPriorPublication, readPublishedRows, identifyNewContent, verifyPublication } from './publication-safety.js';

import { preflightTemplateDeclaration, completeTemplateDeclaration } from './template-declaration.js';

const marker = 'GAODING_TEMPLATE_PUBLISH:';

export function egoBinary(executable) {
  if (executable) return executable;
  if (process.env.EGO_BROWSER_BIN) return process.env.EGO_BROWSER_BIN;
  const local = join(homedir(), '.local/bin/ego-browser');
  return existsSync(local) ? local : 'ego-browser';
}

/** 从快照文本里找出包含目标文本、且最近祖先带 ref 的可点击节点。 */
export function refForText(lines, needle, back = 8) {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(needle)) continue;
    for (let j = i; j >= Math.max(0, i - back); j--) {
      const match = /\b(?:button|textfield|textbox|switch|anchor|checkbox)\b[^\[]*\[ref=(\d+)/.exec(lines[j]);
      if (match) return '@' + match[1];
    }
  }
  return null;
}

/** 最后一个匹配文本的按钮 ref（用于「发布」这种标题与按钮同名的场景）。 */
export function lastRefForText(lines, needle, back = 8) {
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(needle)) continue;
    for (let j = i; j >= Math.max(0, i - back); j--) {
      const match = /\bbutton\b[^\[]*\[ref=(\d+)/.exec(lines[j]);
      if (match) { found = '@' + match[1]; break; }
    }
  }
  return found;
}

export function buildTemplatePublishScript({ designUrl, description, topic, ai = false, submit, shots = {}, space, journal, publicationPath, plan, evidence }) {
  const json = value => JSON.stringify(value);
  const declarationCode = (submit === true && plan && evidence) ? `
    // 模板的版权声明只能在「发布成功 → 去完善」这一个会话里完成：
    // 发布管理列表的「版权认证」对模板会取不到内容版本而直接失败（实测）。
    const plan = ${json(plan ?? null)};
    const evidenceFile = ${json(evidence ?? null)};
    if (!plan || !plan.candidates) throw Error('缺少声明计划，不能提交模板版权声明');
    if (!evidenceFile) throw Error('缺少声明材料，不能提交模板版权声明');
    if (!fs.existsSync(evidenceFile)) throw Error('声明材料不存在：' + evidenceFile);
    // 关键：发布成功弹窗只在当前页面存活，绝不能先跳转再回来（会永久失去声明入口）。
    let goRef = null;
    for (let attempt = 0; attempt < 12 && !goRef; attempt++) {
      goRef = refOf(await snap(), 'text "去完善"', 8);
      if (!goRef) await p.waitForTimeout(2500);
    }
    if (!goRef) throw Error('发布成功弹窗已关闭，无法打开版权声明；作品 ' + content.id + ' 需人工完善声明');
    await p.click(goRef, { label: 'open declaration' });
    let panelReady = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      await p.waitForTimeout(1500);
      panelReady = await p.evaluate(() => Boolean(document.querySelector('iframe')?.contentDocument?.querySelector('.ugc-copyright-section')));
      if (panelReady) break;
    }
    if (!panelReady) throw Error('版权声明面板没有出现');
    steps.push('declaration-opened');
    await p.screenshot({ path: ${json(shots.declarationOpened ?? shots.formReady)} });

    const counts = () => p.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument;
      const n = cls => d.querySelectorAll('.ugc-copyright-section-' + cls + ' .ugc-copyright-thumb').length;
      return { uncategorized: n('uncategorized'), gaoding: n('gaoding_licensed'), original: n('original'), original_ai: n('original_ai'), risk: n('risk') };
    });
    const before = await counts();
    const total = before.uncategorized + before.gaoding + before.original + before.original_ai + before.risk;
    steps.push('declaration-candidates:' + total);
    if (total !== plan.candidates) throw Error('版权候选数不符：面板 ' + total + ' 个 / 应有 ' + plan.candidates + ' 个');
    if (before.uncategorized !== plan.candidates) throw Error('声明面板初始不是全部未分类，可能已声明过，停止以免覆盖：' + JSON.stringify(before));

    // 批量工具栏只在「选中至少一个候选」后出现，所以先点第一张卡的勾选按钮。
    await p.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument;
      const check = d.querySelector('button.ugc-copyright-card-check') || d.querySelector('.ugc-copyright-thumb');
      if (check) check.click();
    });
    let toolbar = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await p.waitForTimeout(800);
      toolbar = await p.evaluate(() => {
        const d = document.querySelector('iframe').contentDocument;
        return [...d.querySelectorAll('button')].some(x => x.innerText.trim() === '移动至');
      });
      if (toolbar) break;
    }
    if (!toolbar) throw Error('声明面板没有出现批量工具栏（选中候选后应出现「移动至」）');
    // 按来源分组归类：AI 图 → 原创 AI 素材，程序图形 → 原创素材。
    // 候选按图片内容去重，所以用「候选预览图哈希」与图层哈希对齐，不靠顺序猜。
    const planGroups = Array.isArray(plan.categories) && plan.categories.length
      ? plan.categories
      : [{ category: plan.category, label: plan.categoryLabel, sha256: [] }];
    const declaredCounts = {};
    let pickedAny = false;
    for (const group of planGroups) {
      // 只有一个分类时直接全选：所有候选都归这一类，不需要逐张比对。
      if (planGroups.length === 1) {
        const selectedAll = await p.evaluate(() => {
          const d = document.querySelector('iframe').contentDocument;
          const all = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === '全选');
          if (all) { all.click(); return 'bulk'; }
          const checks = [...d.querySelectorAll('button.ugc-copyright-card-check')];
          checks.forEach(c => { if (c.getAttribute('aria-pressed') !== 'true') c.click(); });
          return checks.length ? 'each:' + checks.length : 'none';
        });
        steps.push('declaration-select:' + selectedAll);
        if (selectedAll !== 'none') pickedAny = true;
      }
      let selected = 0;
      if (planGroups.length > 1) {
      // 每组开始前清空选择，避免上一组残留
      await p.evaluate(() => { const d = document.querySelector('iframe').contentDocument; const b = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === '取消选择'); if (b) b.click(); });
      await p.waitForTimeout(600);
      const fingerprints = group.perceptual ?? [];
      if (!fingerprints.length) throw Error('声明计划缺少图层指纹：' + group.category);
      // 平台按内容去重：同一张图被多个图层复用时只出现一个候选，所以按「指纹去重后的数量」核对。
      const expected = new Set(fingerprints.map(row => row.hash + '|' + JSON.stringify(row.rgb) + '|' + Number(row.aspect).toFixed(2))).size;
      selected = await p.evaluate(async list => {
        const d = document.querySelector('iframe').contentDocument;
        const thumbs = [...d.querySelectorAll('.ugc-copyright-section-uncategorized .ugc-copyright-thumb')];
        if (!thumbs.length) return 0;
        // 预览图在别的域名：直接 drawImage 会污染 canvas（读像素报安全错误），
        // 所以先 fetch 成 blob，再用 createImageBitmap 解码后画。
        const fingerprint = async src => {
          try {
            const response = await fetch(src, { mode: 'cors' });
            if (!response.ok) return null;
            const bitmap = await createImageBitmap(await response.blob());
            const canvas = document.createElement('canvas');
            canvas.width = 16; canvas.height = 16;
            const ctx = canvas.getContext('2d');
            // 透明区域统一垫白底，保证与宿主侧 Pillow 算法一致
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 16, 16);
            ctx.drawImage(bitmap, 0, 0, 16, 16);
            const data = ctx.getImageData(0, 0, 16, 16).data;
            const gray = [];
            let ink = 0, r = 0, g = 0, b = 0;
            for (let i = 0; i < data.length; i += 4) {
              const alpha = data[i + 3];
              if (alpha > 8) { ink++; r += data[i]; g += data[i + 1]; b += data[i + 2]; }
              gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            }
            const cover = ink / 256;
            const avg = gray.reduce((x, y) => x + y, 0) / gray.length;
            const bits = gray.map(v => (v > avg ? '1' : '0')).join('').padEnd(256, '0');
            const count = cover || 1;
            return {
              hash: bits.match(/.{4}/g).map(group => parseInt(group, 2).toString(16)).join(''),
              rgb: [Math.round(r / count), Math.round(g / count), Math.round(b / count)],
              cover: cover / 256,
              aspect: bitmap.width / Math.max(1, bitmap.height)
            };
          } catch { return null; }
        };
        const distance = (a, b) => {
          if (!a || !b || a.length !== b.length) return 256;
          let count = 0;
          for (let i = 0; i < a.length; i++) {
            let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
            while (x) { count += x & 1; x >>= 1; }
          }
          return count;
        };
        // 相似度打分：哈希为主，颜色/形状为辅；用贪心分配，一张候选只归一个期望图层。
        const score = (want, got) => {
          const hashPart = 1 - Math.min(1, distance(want.hash, got.hash) / 128);
          const colorPart = 1 - Math.min(1, (Math.abs(want.rgb[0] - got.rgb[0]) + Math.abs(want.rgb[1] - got.rgb[1]) + Math.abs(want.rgb[2] - got.rgb[2])) / 300);
          const aspectPart = want.aspect && got.aspect ? 1 - Math.min(1, Math.abs(want.aspect - got.aspect) / Math.max(want.aspect, got.aspect)) : 0;
          const coverPart = Number.isFinite(want.cover) && Number.isFinite(got.cover) ? 1 - Math.min(1, Math.abs(want.cover - got.cover) / 0.5) : 0;
          return hashPart * 0.45 + colorPart * 0.25 + aspectPart * 0.2 + coverPart * 0.1;
        };
        const pool = [];
        for (const thumb of thumbs) {
          const img = thumb.querySelector('img');
          const check = thumb.querySelector('button.ugc-copyright-card-check');
          if (!check || !img || !img.src) continue;
          const got = await fingerprint(img.src);
          if (got) pool.push({ thumb, check, got });
        }
        const used = new Set();
        let hits = 0;
        for (const want of list) {
          let bestIndex = -1, bestScore = -1;
          pool.forEach((entry, index) => {
            if (used.has(index)) return;
            const value = score(want, entry.got);
            if (value > bestScore) { bestScore = value; bestIndex = index; }
          });
          if (bestIndex < 0 || bestScore < 0.6) continue;
          used.add(bestIndex);
          const entry = pool[bestIndex];
          if (entry.check.getAttribute('aria-pressed') !== 'true') entry.check.click();
          hits++;
        }
        return hits;
      }, fingerprints);
      if (selected !== expected) throw Error('「' + group.label + '」候选匹配不完整：' + selected + '/' + expected + '（指纹对不上，已中止以免错声明）');
      pickedAny = true;
      await p.waitForTimeout(800);
      await p.waitForTimeout(1800);
      declaredCounts[group.category] = selected;
      steps.push('declaration-group:' + group.category + ':' + selected);
      }
    }
    // 不管一个还是多个分类，选完候选都要点「移动至」把候选归到目标分区
    const targetLabel = planGroups[0].label;
    await p.evaluate(() => { const d = document.querySelector('iframe').contentDocument; const b = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === '移动至'); if (b) b.click(); });
    let movedLabel = null;
    for (let attempt = 0; attempt < 14 && !movedLabel; attempt++) {
      await p.waitForTimeout(700);
      movedLabel = await p.evaluate(label => {
        const d = document.querySelector('iframe').contentDocument;
        const btn = [...d.querySelectorAll('.ugc-copyright-move-menu button, button, [role=menuitem], li')].find(b => (b.textContent || '').trim() === label);
        if (!btn) return null;
        btn.click();
        return label;
      }, targetLabel);
    }
    if (!movedLabel) throw Error('声明面板里找不到分类：' + targetLabel);
    steps.push('declaration-moved-to:' + movedLabel);
    await p.waitForTimeout(2000);
    if (!pickedAny) throw Error('没有可归类的候选');
    const after = await counts();
    steps.push('declaration-moved:' + JSON.stringify(after));
    if (after.uncategorized !== 0) throw Error('仍有未分类素材：' + after.uncategorized);
    const placed = (after.original ?? 0) + (after.original_ai ?? 0);
    if (placed !== plan.candidates) throw Error('归类数量不符：' + placed + '/' + plan.candidates);

    // 上传真实声明材料：一张说明图覆盖全部图层，按类别分别挂到对应分区
    for (const group of planGroups) {
      const marked = await p.evaluate(category => {
        const d = document.querySelector('iframe').contentDocument;
        const input = d.querySelector('.ugc-copyright-section-' + category + ' input[type=file]');
        if (!input) return false;
        input.setAttribute('data-agent-evidence', category);
        return true;
      }, group.category);
      if (!marked) throw Error('找不到声明材料上传框：' + group.label);
      await p.setInputFiles('css:[data-agent-evidence="' + group.category + '"]', evidenceFile);
      await p.waitForTimeout(5000);
      const uploaded = await p.evaluate(category => {
        const d = document.querySelector('iframe').contentDocument;
        return d.querySelectorAll('.ugc-copyright-section-' + category + ' .ugc-copyright-evidence-thumb img').length;
      }, group.category);
      if (!uploaded) throw Error('声明材料没有上传成功：' + group.label);
      steps.push('declaration-evidence:' + group.category + ':' + uploaded);
    }
    await p.screenshot({ path: ${json(shots.declarationReady ?? shots.published)} });

    // 勾选知悉并提交
    const submitted = await p.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument;
      const box = d.querySelector('input[type=checkbox]');
      if (box && !box.checked) box.click();
      const btn = [...d.querySelectorAll('button')].find(b => b.innerText.trim() === '声明并发布');
      if (!btn) return 'missing';
      if (btn.disabled) return 'disabled';
      btn.click();
      return 'clicked';
    });
    if (submitted !== 'clicked') throw Error('版权声明提交按钮不可用：' + submitted);
    // 保存成功以面板消失或出现保存成功提示为准，不以超时当成功。
    let saved = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await p.waitForTimeout(1500);
      saved = await p.evaluate(() => {
        const d = document.querySelector('iframe')?.contentDocument;
        const text = d?.body?.innerText ?? '';
        if (/版权声明已保存|声明已保存|提交成功/.test(text)) return true;
        return !d?.querySelector('.ugc-copyright-section');
      });
      if (saved) break;
    }
    await p.screenshot({ path: ${json(shots.declarationDone ?? shots.published)} });
    if (!saved) throw Error('版权声明提交后没有保存确认（作品 ' + content.id + ' 已发布，需按原 ID 补声明）');
    steps.push('declaration-saved');
    console.log(${json(marker)} + JSON.stringify({ ok: true, dryRun: false, steps, content, declarationSubmitted: true, screenshots: [${json(shots.formReady)}, ${json(shots.published)}, ${json(shots.declarationDone ?? shots.published)}] }));
  }
` : `\n    // 演练或缺少声明计划时不生成声明步骤\n  }\n`;
  return `
const space = await taskSpace(${json(space)});
let p;
const steps = [];
const createdPages = [];
const fs = await import('node:fs');
const journal = ${json(journal ?? null)};
const persist = (path, value) => { const temp = path + '.browser.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\\n'); fs.renameSync(temp, path); };
const saveResult = result => { if (journal) persist(journal.path, { ...journal.value, stage: 'needs-reconciliation', result, updatedAt: new Date().toISOString() }); };
let content = null;
const readRows = ${readPublishedRows.toString()};
const identify = ${identifyNewContent.toString()};
const verifyResult = ${verifyPublication.toString()};
const snap = async () => String(await p.snapshot({ scope: 'full_page' })).split('\\n');
// 元素句柄会因弹窗重渲染失效（not connected / timed out）：失败就重新快照再取一次。
const clickStable = async (needle, label, back = 8, attempts = 5) => {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const ref = refOf(await snap(), needle, back);
      if (!ref) { await p.waitForTimeout(800); continue; }
      await p.click(ref, { label });
      return true;
    } catch (error) {
      lastError = error;
      if (!/not connected|timed out|not attached/i.test(String(error && error.message ? error.message : error))) throw error;
      await p.waitForTimeout(900);
    }
  }
  if (lastError) throw lastError;
  return false;
};

const refOf = (lines, needle, back) => {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(needle)) continue;
    for (let j = i; j >= Math.max(0, i - (back || 8)); j--) {
      const m = /\\b(?:button|textfield|textbox|switch|anchor|checkbox)\\b[^\\[]*\\[ref=(\\d+)/.exec(lines[j]);
      if (m) return '@' + m[1];
    }
  }
  return null;
};
const lastRef = (lines, needle, back) => {
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(needle)) continue;
    for (let j = i; j >= Math.max(0, i - (back || 8)); j--) {
      const m = /\\bbutton\\b[^\\[]*\\[ref=(\\d+)/.exec(lines[j]);
      if (m) { found = '@' + m[1]; break; }
    }
  }
  return found;
};
try {
  p = await space.newPage();
  createdPages.push(p);
  const verify = await space.newPage();
  createdPages.push(verify);
  await verify.goto('https://www.gaoding.com/my/publish');
  const beforeIds = (await verify.evaluate(readRows)).map(row => row.id);
  await p.goto(${json(designUrl)}, { waitUntil: 'domcontentloaded' });
  // 编辑器加载、字体确认弹窗、保存提示都可能随时出现：轮询到「有发布按钮且无确认弹窗」为止。
  // 编辑器是重前端 SPA：刚导入完或网络抖动时可能先渲染空白页，给它一次整页重载的机会。
  let publishButton = null;
  for (let round = 0; round < 3 && !publishButton; round++) {
    if (round > 0) {
      steps.push('editor-reload:' + round);
      await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await p.waitForTimeout(4000);
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      await p.waitForTimeout(1500);
      const lines = await snap();
      const confirmRef = refOf(lines, 'text "确认"', 6);
      if (confirmRef) {
        await p.click(confirmRef, { label: 'confirm fonts' }).catch(() => {});
        if (!steps.includes('fonts-confirmed')) steps.push('fonts-confirmed');
        await p.waitForTimeout(1200);
        continue;
      }
      const candidate = refOf(lines, 'text "发布"', 6);
      if (candidate) { publishButton = candidate; break; }
    }
  }
  if (!publishButton) throw Error('编辑器里找不到发布按钮（已重载 3 次）');
  await p.click(publishButton, { label: 'open publish' });
  await p.waitForTimeout(6000);
  let opened = (await snap()).some(line => /textfield "描述"/.test(line));
  // 弹窗偶尔被上一次的遮罩吞掉点击：最多再点三回发布，每次多等一会。
  for (let round = 0; round < 3 && !opened; round++) {
    await p.waitForTimeout(4000);
    for (let attempt = 0; attempt < 6 && !opened; attempt++) {
      if ((await snap()).some(line => /textfield "描述"/.test(line))) { opened = true; break; }
      await p.waitForTimeout(1500);
    }
    if (opened) break;
    const retryButton = refOf(await snap(), 'text "发布"', 6);
    if (retryButton) await p.click(retryButton, { label: 'reopen publish' }).catch(() => {});
    await p.waitForTimeout(3000);
    opened = (await snap()).some(line => /textfield "描述"/.test(line));
  }
  if (!opened) throw Error('发布弹窗没有出现描述输入框（已重开 3 次）');
  steps.push('modal-opened');

  const focused = await clickStable('textfield "描述"', 'focus description');
  if (!focused) throw Error('发布弹窗里找不到描述输入框');
  await p.keyboard.type(${json(description)});
  await p.waitForTimeout(700);
  steps.push('description-filled');

  if (${json(topic)}) {
    const lines = await snap();
    const attachedTopics = () => p.evaluate(() => {
      const doc = [...document.querySelectorAll('iframe')].find(f => f.src.includes('unified-publish-modal'))?.contentDocument;
      if (!doc) throw Error('无法读取编辑器同源发布表单');
      return [...doc.querySelectorAll('[contenteditable=true] [data-topic-id]')].map(e => ({ id: e.getAttribute('data-topic-id'), name: [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() }));
    });
    const already = (await attachedTopics()).some(t => t.name === ${json(topic)});
    if (!already) {
      const more = refOf(lines, 'text "更多"', 6);
      if (!more) throw Error('找不到更多话题入口');
      await p.click(more, { label: 'more topics' });
      await p.waitForTimeout(1500);
      const search = refOf(await snap(), '搜索话题', 6);
      if (!search) throw Error('找不到话题搜索框');
      try { await p.fill(search, ${json(topic)}); }
      catch (error) { await p.click(search, { label: 'focus topic search' }); await p.keyboard.type(${json(topic)}); }
      await p.waitForTimeout(2200);
      const picked = await p.evaluate((name) => {
        const doc = [...document.querySelectorAll('iframe')].find(f => f.src.includes('unified-publish-modal'))?.contentDocument;
        const hits = [...(doc?.querySelectorAll('button[data-topic-candidate-id]') || [])].filter(b => [...b.querySelectorAll('span')].some(s => s.textContent.trim() === name));
        if (hits.length !== 1) return null;
        hits[0].click();
        return hits[0].getAttribute('data-topic-candidate-id');
      }, ${json(topic)});
      if (!picked) throw Error('话题搜索没有唯一精确匹配：' + ${json(topic)});
      steps.push('topic-selected:' + picked);
      await p.waitForTimeout(1500);
    } else { steps.push('topic-already-present'); }
    const chips = await attachedTopics();
    const verified = chips.length === 1 && chips[0].name === ${json(topic)};
    if (!verified) throw Error('话题没有挂上：' + ${json(topic)});
    steps.push('topic-verified');
  }

  if (${ai === true}) {
    const sw = refOf(await snap(), 'switch "含AI生成内容"', 4);
    if (sw) { await p.click(sw, { label: 'mark ai' }); await p.waitForTimeout(600); steps.push('ai-declared'); }
  }

  await p.screenshot({ path: ${json(shots.formReady)} });
  if (${submit !== true}) {
    console.log(${json(marker)} + JSON.stringify({ ok: true, dryRun: true, steps, screenshots: [${json(shots.formReady)}] }));
  } else {
    const submitRef = lastRef(await snap(), 'text "发布"', 8);
    if (!submitRef) throw Error('找不到发布提交按钮');
    if (!journal) throw Error('缺少持久提交日志');
    saveResult({ ok: false, submissionStarted: true, steps: [...steps, 'submission-started'] });
    await p.click(submitRef, { label: 'publish template' });
    // 大稿发布较慢，固定等 9 秒经常还没出成功弹窗；改成轮询到「发布成功 / 去完善」出现为止。
    let done = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      await p.waitForTimeout(2500);
      done = (await snap()).some(line => line.includes('发布成功'));
      if (done) break;
    }
    await p.screenshot({ path: ${json(shots.published)} });
    steps.push(done ? 'published' : 'publish-unknown');
    content = identify(await verify.evaluate(readRows), beforeIds, ${json(description)}, 0);
    if (!content) throw Error('未取得本次模板投稿唯一 ID，禁止自动重发');
    saveResult({ ok: false, published: true, content, steps });
    persist(${json(publicationPath)}, { kind: 'template', published: true, stage: 'pending-declaration', contentId: content.id, content, designUrl: ${json(designUrl)}, description: ${json(description)}, topic: ${json(topic)}, space: ${json(space)} });
    await verify.goto('https://gd.huaban.com/my/publish/' + content.id);
    await verify.waitForFunction(() => !!document.querySelector('a[href*="/topics/"]'), undefined, { timeout: 10000 });
    content.topics = await verify.evaluate(() => [...document.querySelectorAll('a[href*="/topics/"]')].map(a => a.textContent.trim()));
    const verificationError = verifyResult(content, ${json(topic)}, false);
    if (verificationError) throw Error(verificationError);

${declarationCode}} catch (error) {
  saveResult({ ok: false, content, error: String(error.message || error), steps });
  try { await p.screenshot({ path: ${json(shots.failed)} }); } catch (e) {}
  console.log(${json(marker)} + JSON.stringify({ ok: false, content, error: String(error && error.message ? error.message : error), steps, screenshots: [${json(shots.failed)}] }));
} finally {
  for (const page of createdPages) { try { await page.close(); } catch (error) {} }
}
`;
}

function runNode(script, { executable, spawnProcess = spawn, timeout = 240000, logPath } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false, child, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { writeFileSync(logPath, JSON.stringify({ stdout, stderr, error: error?.message }, null, 2) + '\n'); }
      catch (logError) { error ||= logError; }
      error ? reject(error) : resolve(value);
    };
    try {
      child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(() => { child.kill(); finish(Error('模板发布自动化超时；保留日志，禁止重复投稿')); }, timeout);
      child.on('error', error => finish(error));
      const collect = key => data => {
        if (key === 'stdout') stdout += data; else stderr += data;
        if (stdout.length + stderr.length > 8e6) { child.kill(); finish(Error('模板发布日志超过限制')); }
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.stdin.on('error', error => finish(error));
      child.on('close', code => {
        const line = (stdout + '\n' + stderr).split('\n').filter(row => row.startsWith(marker)).pop();
        if (line) { try { return finish(null, JSON.parse(line.slice(marker.length))); } catch {} }
        finish(Error(code !== 0 ? '模板发布失败：' + (stderr.trim().slice(-400) || 'exit ' + code) : '浏览器没有返回模板发布结果'));
      });
      child.stdin.end(script);
    } catch (error) { finish(error); }
  });
}

function readJson(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
function persist(path, value) {
  const temp = path + '.host.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
}

/** Submit once; any later attempt can only complete declaration for the original ID. */
export async function publishTemplate({ designUrl, description, topic, ai = false, submit = false, declare = false,
  evidenceDir, runDir, executable, spawnProcess, space, timeout, plan: providedPlan,
  priorPublication, preflightDeclaration = preflightTemplateDeclaration, completeDeclaration = completeTemplateDeclaration }) {
  if (!designUrl || !/^https:\/\/(?:www\.)?gaoding\.com\/editor\/design(?:[/?#]|$)/.test(designUrl)) throw Error('需要有效的编辑器作品地址');
  if (!description) throw Error('缺少作品描述');
  if (submit && !declare) throw Error('模板投稿必须完成版权声明');
  if (!Number.isSafeInteger(space) || space < 1) throw Error('需要复用当前任务的浏览器空间 ID');
  if (submit && !runDir) throw Error('模板投稿需要 runDir 以保存持久提交记录和声明证据');
  // 调用方算好的计划必须原样使用：里面带着感知哈希，重算会丢掉，声明分类就会失败。
  const plan = submit ? (providedPlan ?? await preflightDeclaration({ runDir })) : null;
  const dir = evidenceDir ?? join(runDir ?? process.cwd(), 'publish');
  mkdirSync(dir, { recursive: true });
  // Submission identity must not change when the screenshot destination changes.
  const journalDir = join(runDir ?? dir, 'publish');
  const journalPath = join(journalDir, 'submission-attempt.json');
  const publicationPath = join(runDir ?? dir, 'publication.json');
  const previous = submit ? (priorPublication ?? readPriorPublication({ runDir })) : null;
  let journalValue = submit ? readJson(journalPath) : null;
  let content = previous?.contentId ? { ...previous.content, id: String(previous.contentId) } : journalValue?.result?.content;
  if (previous?.contentId && journalValue?.result?.content?.id && String(previous.contentId) !== String(journalValue.result.content.id)) throw Error('发布记录 ID 冲突，必须先对账');
  if (submit && !content?.id && (previous || journalValue)) throw Error('已有不确定提交记录，必须先对账，禁止重复投稿');
  const shots = {
    formReady: join(dir, 'template-form.png'),
    published: join(dir, 'template-published.png'),
    failed: join(dir, 'template-failed.png'),
    declarationOpened: join(dir, 'declaration-opened.png'),
    declarationReady: join(dir, 'declaration-ready.png'),
    declarationDone: join(dir, 'declaration-done.png')
  };
  const evidence = plan?.evidence?.file ?? null;
  let value = null;
  const savePending = () => persist(publicationPath, { ...previous, kind: 'template', published: true, stage: 'pending-declaration', contentId: String(content.id), content, designUrl, description, topic, space });
  const saveJournal = result => {
    const disk = readJson(journalPath);
    if (disk) persist(journalPath, { ...disk, stage: result.ok ? 'verified' : 'needs-reconciliation', result, updatedAt: new Date().toISOString() });
  };
  try {
    if (!content?.id) {
      const journal = submit ? beginSubmission(journalDir, { kind: 'template', designUrl, description, topic, space }) : null;
      const script = buildTemplatePublishScript({ designUrl, description, topic, ai, submit, shots, space, journal, publicationPath, plan, evidence });
      value = await runNode(script, { executable, spawnProcess, timeout, logPath: join(dir, 'template-process-' + Date.now() + '.json') });
      persist(join(dir, 'template-attempt-' + Date.now() + '.json'), value);
      content = value.content ?? readJson(journalPath)?.result?.content;
      if (submit && content?.id) { saveJournal({ ...value, ok: false, content }); savePending(); }
      if (!value.ok) throw Error(value.error || '模板发布未完成');
      if (!submit) return value;
      if (!content?.id || value.dryRun) throw Error('未取得本次模板投稿唯一 ID，禁止自动重发');
    }
    savePending();
    // 声明已在发布会话内提交；这里用平台接口真实回读，条数覆盖全部候选才算完成。
    const declaration = await completeDeclaration({ runDir, space, contentId: content.id, content, plan, executable, spawnProcess });
    if (declaration?.verified !== true || declaration.reopened !== true || declaration.submitted !== true || String(declaration.contentId) !== String(content.id)) throw Error('版权声明未完成真实重开核验');
    const result = { ...value, ok: true, dryRun: false, content, declaration };
    // 终态记录必须自带话题与作品 ID，否则「是否投完」的判断会一直不成立。
    persist(publicationPath, {
      ...readJson(publicationPath), stage: 'verified', published: true, contentId: String(content.id),
      topic, topics: content.topics ?? [topic], declarationStatus: 'SUBMITTED', declaration
    });
    saveJournal(result);
    return result;
  } catch (error) {
    const disk = readJson(journalPath);
    content ||= disk?.result?.content;
    if (content?.id) savePending();
    if (submit) saveJournal({ ...disk?.result, ok: false, content, error: error.message });
    throw error;
  }
}
