/**
 * 素材投稿自动化（可生产路径）：
 * 1. 从创作者中心点「发布」拿到弹窗 iframe 地址；
 * 2. 把该地址作为独立页面打开，用 DOM 精确操作（不再受 iframe 叠层影响）；
 * 3. 上传素材 → 填描述 → 搜索并精确选择话题 → 勾选 AI → 发布；
 * 4. 发布完成后进入版权声明，上传 AI 证据图并提交。
 * 全程只做真实 UI 操作，结果以页面文案与发布管理接口为准。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beginSubmission, finishSubmission, priorPublication, readPublishedRows, identifyNewContent, identifyRecentContent, verifyPublication } from './publication-safety.js';

const marker = 'GAODING_PUBLISH_RUN:';

export function egoBinary(executable) {
  if (executable) return executable;
  if (process.env.EGO_BROWSER_BIN) return process.env.EGO_BROWSER_BIN;
  const local = join(homedir(), '.local/bin/ego-browser');
  return existsSync(local) ? local : 'ego-browser';
}

export function runNode(script, { executable, spawnProcess = spawn, timeout = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('投稿自动化超时')); }, timeout);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.on('error', error => finish(error));
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 4e6) child.kill(); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 4e6) child.kill(); });
    child.on('close', code => {
      const line = (stdout + '\n' + stderr).split('\n').filter(row => row.startsWith(marker)).pop();
      if (line) { try { return finish(null, JSON.parse(line.slice(marker.length))); } catch {} }
      if (code !== 0) return finish(Error('投稿自动化失败：' + (stderr.trim().slice(-400) || 'exit ' + code)));
      finish(Error('浏览器没有返回投稿结果'));
    });
    child.stdin.end(script);
  });
}

/** 生成在 ego-browser 里执行的脚本。 */
export function buildPublishScript({ asset, description, topic, evidence, ai = true, submit, declare, shots, space }) {
  const json = value => JSON.stringify(value);
  return `
const space = await taskSpace(${json(space)});
const main = space.page('p1');
const steps = [];
const createdPages = [];
let content = null;
let published = false;
const readRows = ${readPublishedRows.toString()};
const identify = ${identifyNewContent.toString()};
const identifyRecent = ${identifyRecentContent.toString()};
const verifyResult = ${verifyPublication.toString()};
const fail = async (message) => { throw Error(message); };
try {
  // 空间页面配额有限：先回收上一轮遗留的投稿页（只动本插件自己会打开的页面）。
  const existingPages = await space.pages();
  if (existingPages.length >= 6) {
    for (const page of existingPages) {
      if (page.label === 'p1' || page.openedBy !== 'agent') continue;
      let url = '';
      try { url = await page.url(); } catch (error) { continue; }
      if (!/unified-publish-modal|gd\\.huaban\\.com\\/my\\/publish/.test(url)) continue;
      try { await page.close(); steps.push('reclaimed-page:' + page.label); } catch (error) {}
    }
  }
  const verify = await space.newPage();
  createdPages.push(verify);
  await verify.goto('https://www.gaoding.com/my/publish', { waitUntil: 'domcontentloaded' });
  const beforeIds = (await verify.evaluate(readRows)).map(row => row.id);
  await main.goto('https://creator.huaban.com/inspiration', { waitUntil: 'domcontentloaded' });
  await main.waitForTimeout(2500);
  await main.click('css:button.nsp-sider-publish', { label: 'open publish dialog' });
  await main.waitForTimeout(2500);
  const modalUrl = await main.evaluate(() => [...document.querySelectorAll('iframe')].map(f => f.src)[0] || null);
  if (!modalUrl) await fail('没有拿到发布弹窗地址');
  steps.push('dialog-opened');
  const modal = await space.newPage();
  createdPages.push(modal);
  await modal.goto(modalUrl, { waitUntil: 'domcontentloaded' });
  await modal.waitForTimeout(3000);

  const chooserPromise = modal.waitForFileChooser({ timeout: 15000 });
  await modal.click('text=本地上传', { label: 'upload asset' });
  const chooser = await chooserPromise;
  await chooser.setFiles(${json(asset)});
  await modal.waitForTimeout(9000);
  steps.push('asset-uploaded');

  const hasEditor = await modal.evaluate(() => !!document.querySelector('[contenteditable=true]'));
  if (!hasEditor) await fail('找不到描述输入框');
  await modal.click('[contenteditable=true]');
  await modal.keyboard.type(${json(description)});
  await modal.waitForTimeout(600);
  steps.push('description-filled');

  if (${json(topic)}) {
    // 只有 data-topic-id 的内联 token 才算真正挂上话题，纯文本包含不算。
    const chipCheck = (name) => {
      const chips = [...document.querySelectorAll('[contenteditable=true] span[data-topic-id]')];
      return chips.length === 1 && [...chips[0].childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() === name;
    };
    if (!(await modal.evaluate(chipCheck, ${json(topic)}))) {
      await modal.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '更多')?.click());
      await modal.waitForTimeout(1200);
      await modal.fill('css:input[placeholder="搜索话题"]', ${json(topic)});
      await modal.waitForTimeout(2000);
      const picked = await modal.evaluate((name) => {
        const hits = [...document.querySelectorAll('button[data-topic-candidate-id]')].filter(b => [...b.querySelectorAll('span')].some(s => s.textContent.trim() === name));
        if (hits.length !== 1) return null;
        const btn = hits[0];
        btn.click();
        return btn.getAttribute('data-topic-candidate-id');
      }, ${json(topic)});
      if (!picked) await fail('话题搜索没有匹配：' + ${json(topic)});
      steps.push('topic-selected:' + picked);
      await modal.waitForTimeout(1500);
    } else { steps.push('topic-already-attached'); }
    if (!(await modal.evaluate(chipCheck, ${json(topic)}))) await fail('话题没有真正挂上（缺少 data-topic-id chip）：' + ${json(topic)});
    steps.push('topic-verified');
  }

  if (${ai === true}) {
    await modal.evaluate(() => {
      const sw = document.querySelector('button[aria-label="含AI生成内容"]');
      if (sw && sw.getAttribute('aria-checked') !== 'true') sw.click();
    });
    await modal.waitForTimeout(700);
    const checked = await modal.evaluate(() => document.querySelector('button[aria-label="含AI生成内容"]')?.getAttribute('aria-checked') === 'true');
    if (!checked) await fail('AI 声明开关没有打开');
    steps.push('ai-declared');
  }

  await modal.screenshot({ path: ${json(shots.formReady)} });
  if (${submit !== true}) {
    console.log(${json(marker)} + JSON.stringify({ ok: true, dryRun: true, steps, screenshots: [${json(shots.formReady)}] }));
  } else {
    const publishStartedAt = Date.now();
    await modal.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '发布素材')?.click());
    await modal.waitForTimeout(8000);
    published = (await modal.evaluate(() => document.body.innerText)).includes('发布完成');
    if (!published) await fail('没有出现「发布完成」，可能提交失败');
    steps.push('published');
    await modal.screenshot({ path: ${json(shots.published)} });
    // 标题匹配可能因为平台改写标题而失败：再用「本次提交后新出现的同类型稿件」兜底，
    // 只有唯一候选才认，认不准就如实停下，绝不猜。
    for (let attempt = 0; attempt < 10; attempt++) {
      const rows = await verify.evaluate(readRows);
      content = identify(rows, beforeIds, ${json(description)}, 2)
        ?? identifyRecent(rows, beforeIds, 2, publishStartedAt);
      if (content) break;
      await verify.waitForTimeout(2000);
    }
    const contentId = content?.id ?? null;
    if (!contentId) await fail('发布后没有识别到作品 ID，无法核验版权声明');

    let declared = null;
    let declarationCategory = null;
    if (${declare === true} && ${json(evidence)}) {
      await modal.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '去完善')?.click());
      await modal.waitForTimeout(3500);
      const hasForm = (await modal.evaluate(() => document.body.innerText)).includes('版权声明');
      if (!hasForm) await fail('没有进入版权声明页面');
      // 素材的声明面板只有一个「素材」区（没有原创/AI 分类）：AI 属性由发布时的
      // 「含AI生成内容」开关承载。模板式面板才有分类区，两者都要支持。
      const panelKind = async () => modal.evaluate(() => {
        const d = document.querySelector('.ugc-copyright-section') ? document : [...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean).find(x => x?.querySelector('.ugc-copyright-section'));
        if (d) return 'sections';
        const simple = [...document.querySelectorAll('input[type=file]')].length > 0 || [...document.querySelectorAll('iframe')].some(f => f.contentDocument?.querySelector('input[type=file]'));
        return simple ? 'simple' : null;
      });
      let kind = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        kind = await panelKind();
        if (kind) break;
        await modal.waitForTimeout(1000);
      }
      if (!kind) throw Object.assign(Error('版权声明面板没有渲染出来'), { result: { published: true, content, declarationPending: true, steps } });
      steps.push('declaration-panel:' + kind);

      const markInput = async () => modal.evaluate(() => {
        const pick = root => root?.querySelector('.ugc-copyright-section-original_ai input[type=file]') || root?.querySelector('.ugc-copyright-section-original input[type=file]') || root?.querySelector('input[type=file]');
        let input = pick(document);
        if (!input) {
          for (const frame of document.querySelectorAll('iframe')) { input = pick(frame.contentDocument); if (input) break; }
        }
        if (!input) return null;
        input.setAttribute('data-agent-evidence', '1');
        return true;
      });

      if (kind === 'sections') {
        const counts = async () => modal.evaluate(() => {
          const d = document.querySelector('.ugc-copyright-section') ? document : [...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean).find(x => x?.querySelector('.ugc-copyright-section'));
          if (!d) return null;
          const n = cls => d.querySelectorAll('.ugc-copyright-section-' + cls + ' .ugc-copyright-thumb').length;
          return { uncategorized: n('uncategorized'), original: n('original'), original_ai: n('original_ai'), risk: n('risk'), gaoding: n('gaoding_licensed') };
        });
        const before = await counts();
        steps.push('declaration-candidates:' + JSON.stringify(before));
        if (before && before.uncategorized > 0) {
          const categoryLabel = ${ai === true} ? '原创 AI 素材' : '原创素材';
          const category = ${ai === true} ? 'original_ai' : 'original';
          await modal.evaluate(() => {
            const d = document.querySelector('.ugc-copyright-section') ? document : [...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean).find(x => x?.querySelector('.ugc-copyright-section'));
            (d.querySelector('button.ugc-copyright-card-check') || d.querySelector('.ugc-copyright-thumb'))?.click();
          });
          let toolbar = false;
          for (let attempt = 0; attempt < 12; attempt++) {
            await modal.waitForTimeout(700);
            toolbar = await modal.evaluate(() => {
              const d = document.querySelector('.ugc-copyright-section') ? document : [...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean).find(x => x?.querySelector('.ugc-copyright-section'));
              return !!d && [...d.querySelectorAll('button')].some(x => x.innerText.trim() === '移动至');
            });
            if (toolbar) break;
          }
          if (toolbar) {
            await modal.evaluate(() => {
              const d = document.querySelector('.ugc-copyright-section') ? document : [...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean).find(x => x?.querySelector('.ugc-copyright-section'));
              const all = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === '全选');
              if (all) all.click();
              else [...d.querySelectorAll('button.ugc-copyright-card-check')].forEach(c => { if (c.getAttribute('aria-pressed') !== 'true') c.click(); });
            });
            await modal.waitForTimeout(900);
            await modal.evaluate(() => {
              const d = document.querySelector('.ugc-copyright-section') ? document : [...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean).find(x => x?.querySelector('.ugc-copyright-section'));
              [...d.querySelectorAll('button')].find(x => x.innerText.trim() === '移动至')?.click();
            });
            let moved = false;
            for (let attempt = 0; attempt < 12 && !moved; attempt++) {
              await modal.waitForTimeout(700);
              moved = await modal.evaluate(label => {
                const d = document.querySelector('.ugc-copyright-section') ? document : [...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean).find(x => x?.querySelector('.ugc-copyright-section'));
                const btn = [...d.querySelectorAll('.ugc-copyright-move-menu button, button, [role=menuitem], li')].find(b => (b.textContent || '').trim() === label);
                if (!btn) return false;
                btn.click();
                return true;
              }, categoryLabel);
            }
            if (moved) { steps.push('declaration-classified:' + category); await modal.waitForTimeout(1500); }
          }
        }
      }

      if (!(await markInput())) throw Object.assign(Error('找不到声明材料上传框'), { result: { published: true, content, declarationPending: true, steps } });
      await modal.setInputFiles('css:[data-agent-evidence="1"]', ${json(evidence)});
      await modal.waitForTimeout(6000);
      await modal.evaluate(() => { const box = document.querySelector('input[type=checkbox]'); if (box && !box.checked) box.click(); });
      await modal.waitForTimeout(600);
      await modal.screenshot({ path: ${json(shots.declaration)} });
      await modal.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '声明并发布')?.click());
      await modal.waitForTimeout(8000);
      steps.push('declaration-submitted');
      declared = true;
      // 提交后用平台接口核验声明真的保存了；面板还开着，失败可以原地重试一次。
      const readDeclaration = async contentId => modal.evaluate(async id => {
        const token = JSON.parse(localStorage.getItem('token') || '{}');
        const headers = { accept: 'application/json', authorization: 'Bearer ' + (token.access_token || token.token) };
        const response = await fetch('/api/gaoding-art/v1/users/me/materials/' + id + '/declaration', { headers });
        if (!response.ok) return null;
        return response.json();
      }, contentId);
      let declarationState = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        await modal.waitForTimeout(1500);
        declarationState = await readDeclaration(contentId);
        if (declarationState && ['SUBMITTED', 'APPROVED', 'PASSED'].includes(declarationState.material_declaration_status)) break;
      }
      if (!declarationState || !['SUBMITTED', 'APPROVED', 'PASSED'].includes(declarationState.material_declaration_status)) {
        steps.push('declaration-retry');
        if (await markInput()) {
          await modal.setInputFiles('css:[data-agent-evidence="1"]', ${json(evidence)});
          await modal.waitForTimeout(5000);
          await modal.evaluate(() => { const box = document.querySelector('input[type=checkbox]'); if (box && !box.checked) box.click(); });
          await modal.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '声明并发布')?.click());
          for (let attempt = 0; attempt < 10; attempt++) {
            await modal.waitForTimeout(1500);
            declarationState = await readDeclaration(contentId);
            if (declarationState && ['SUBMITTED', 'APPROVED', 'PASSED'].includes(declarationState.material_declaration_status)) break;
          }
        }
        if (!declarationState || !['SUBMITTED', 'APPROVED', 'PASSED'].includes(declarationState.material_declaration_status)) {
          // 作品已经发出去了：声明没完成要如实标记，交给上层按原作品 ID 恢复，绝不重投。
          throw Object.assign(Error('版权声明没有提交成功（平台状态 ' + (declarationState?.material_declaration_status ?? '未知') + '）'), { result: { published: true, content, declarationPending: true, steps } });
        }
      }
      // 列表快照是在声明之前读的，这里用平台真实状态回填，后续核验才有依据。
      if (content) content.declaration = declarationState.material_declaration_status;
      steps.push('declaration-verified:' + declarationState.material_declaration_status);
    }
    // Browser callbacks return data; navigation remains in the Node controller.
    if (content) {
      await verify.goto('https://gd.huaban.com/my/publish/' + content.id, { waitUntil: 'domcontentloaded' });
      await verify.waitForFunction(() => !!document.querySelector('a[href*="/topics/"]'), undefined, { timeout: 10000 });
      content.topics = await verify.evaluate(() => [...document.querySelectorAll('a[href*="/topics/"]')].map(a => a.textContent.trim()));
    }
    const verificationError = verifyResult(content, ${json(topic)}, ${declare === true});
    if (verificationError) throw Error(verificationError);
    declared = ${declare === true} ? true : null;
    steps.push('topic-confirmed-on-detail', 'publication-verified');
    console.log(${json(marker)} + JSON.stringify({ ok: true, dryRun: false, steps, declared, declarationCategory, content, screenshots: [${json(shots.formReady)}, ${json(shots.published)}, ${json(shots.declaration)}] }));
  }
} catch (error) {
  try { await space.page('p1').screenshot({ path: ${json(shots.failed)} }); } catch (e) {}
  console.log(${json(marker)} + JSON.stringify({ ok: false, published, content, error: String(error && error.message ? error.message : error), steps, screenshots: [${json(shots.failed)}] }));
} finally {
  // 页面配额是空间的硬限制：本脚本打开的页面必须全部归还，否则下次运行会开不出页面。
  for (const page of createdPages) { try { await page.close(); } catch (error) {} }
}
`;
}

/** 执行素材投稿；返回每一步的真实结果与截图。 */
export async function publishMaterial({ task, asset, description, topic, evidence, ai = true, submit = false, declare = false, evidenceDir, executable, spawnProcess, space }) {
  if (!asset || !existsSync(asset)) throw Error('素材文件不存在：' + String(asset));
  if (!description) throw Error('缺少作品描述');
  if (!topic) throw Error('缺少任务话题');
  if (!Number.isSafeInteger(space) || space < 1) throw Error('需要复用当前任务的浏览器空间 ID');
  if (submit && (!declare || !evidence || !existsSync(evidence))) throw Error('版权声明及本稿证据图为投稿必填项');
  if (submit && priorPublication(task)) throw Error('该稿已有发布或不确定记录，禁止重复投稿；应恢复原作品');
  const dir = evidenceDir ?? join(task.runDir ?? process.cwd(), 'publish');
  mkdirSync(dir, { recursive: true });
  const shots = {
    formReady: join(dir, 'form-ready.png'),
    published: join(dir, 'published.png'),
    declaration: join(dir, 'declaration.png'),
    failed: join(dir, 'failed.png')
  };
  const script = buildPublishScript({ asset, description, topic, evidence, ai, submit, declare, shots, space });
  const journal = submit ? beginSubmission(dir, {
    taskId: task.id, asset, description, topic,
    assetSha256: createHash('sha256').update(readFileSync(asset)).digest('hex'),
    evidenceSha256: createHash('sha256').update(readFileSync(evidence)).digest('hex')
  }) : null;
  let value;
  try { value = await runNode(script, { executable, spawnProcess }); }
  catch (error) {
    if (journal) finishSubmission(journal, { ok: false, error: error.message });
    throw error;
  }
  if (journal) finishSubmission(journal, value);
  writeFileSync(join(dir, 'attempt-' + Date.now() + '.json'), JSON.stringify(value, null, 2) + '\n');
  if (!value.ok) { const error = Error(value.error || '投稿未完成'); error.result = value; throw error; }
  return value;
}

/**
 * 撤销一件已发布作品（模板补声明的唯一可行路径）。
 * 只读校验 → 点撤销 → 确认 → 用发布管理接口确认真的消失，任何一步不确定都如实失败。
 */
export async function withdrawContent({ contentId, space, executable, spawnProcess = spawn, timeout = 180000 }) {
  if (!contentId) throw Error('缺少作品 ID');
  if (!Number.isSafeInteger(space) || space < 1) throw Error('需要复用当前任务的浏览器空间 ID');
  const script = `
const space = await taskSpace(${JSON.stringify(space)});
const p = space.page('p1');
const steps = [];
const id = ${JSON.stringify(String(contentId))};
try {
  await p.goto('https://gd.huaban.com/my/publish/' + id, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(6000);
  const body = await p.evaluate(() => document.body.innerText || '');
  if (/审核不通过|审核中|已发布|审核通过/.test(body) === false && !body.trim()) throw Error('详情页没有内容');
  const clicked = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '撤销发布');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw Error('详情页没有「撤销发布」按钮，无法撤销');
  steps.push('unpublish-clicked');
  await p.waitForTimeout(2500);
  const confirmed = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '确定');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!confirmed) throw Error('撤销确认弹窗没有出现');
  steps.push('unpublish-confirmed');
  await p.waitForTimeout(5000);
  // 用发布管理接口确认作品真的不存在了
  await p.goto('https://www.gaoding.com/my/publish', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const stillThere = await p.evaluate(async contentId => {
    const token = JSON.parse(localStorage.getItem('token') || '{}');
    const headers = { accept: 'application/json', authorization: 'Bearer ' + (token.access_token || token.token) };
    for (let page = 1; page <= 3; page++) {
      const response = await fetch('/api/gaoding-art/v1/users/me/contents?page_num=' + page + '&page_size=50&query_scene=my_publish&type=0%2C2', { headers });
      if (!response.ok) throw Error('发布管理读取失败：' + response.status);
      const rows = await response.json();
      if (!Array.isArray(rows) || !rows.length) break;
      if (rows.some(row => String(row.id) === String(contentId))) return true;
      if (rows.length < 50) break;
    }
    return false;
  }, id);
  if (stillThere) throw Error('撤销后作品仍在发布管理里，停止操作');
  steps.push('absent-verified');
  console.log('GAODING_WITHDRAW:' + JSON.stringify({ ok: true, contentId: id, steps }));
} catch (error) {
  console.log('GAODING_WITHDRAW:' + JSON.stringify({ ok: false, contentId: id, steps, error: String(error && error.message ? error.message : error) }));
}
`;
  const stdout = await new Promise((resolve, reject) => {
    const child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('撤销作品超时')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('close', () => {
      clearTimeout(timer);
      const line = (out + '\n' + err).split('\n').filter(row => row.startsWith('GAODING_WITHDRAW:')).pop();
      if (!line) return reject(Error('浏览器没有返回撤销结果'));
      try { resolve(JSON.parse(line.slice('GAODING_WITHDRAW:'.length))); } catch (error) { reject(error); }
    });
    child.stdin.end(script);
  });
  if (!stdout.ok) throw Error('撤销作品失败：' + (stdout.error ?? '未知原因'));
  return stdout;
}
