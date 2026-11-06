/**
 * 稿定自动化发布流水线（ego-browser）
 * 用法（在 ego-browser nodejs 里）：
 *   const flow = require('<此目录>/publish_flow.js');
 *   await flow.run({ space: 6, topicKey: 'birthday', psd: '/abs/path/birthday.psd',
 *                    title: '韩系拼贴风 生日海报 小红书封面',
 *                    desc: '……（不含话题标签）',
 *                    topic: '偶像生日应援局',
 *                    fonts: [['文案-主标题','思源黑体 Heavy'], ...],
 *                    evidence: ['/abs/tl.png','/abs/dt.png','/abs/cd.png'] });
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run(opts) {
  const T = await taskSpace(opts.space);
  const log = (...a) => console.log('[flow]', ...a);
  const page = opts.page || T.page("p1");
  await page.goto('https://www.gaoding.com/editor/design?mode=create&category_id=912&type=poster&width=1242&height=1656&unit=px&dpi=72', { timeout: 60000 });
  for (let i = 0; i < 30; i++) {
    const ready = await page.evaluate(() => [...document.querySelectorAll('*')].some(e => e.children.length === 0 && (e.innerText || '').trim() === '文件'));
    if (ready) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);
  const names = await importPsd(page, log, opts.psd, opts.expectedLayers || []);
  if (opts.expectedLayers && opts.expectedLayers.some(name => !names.includes(name))) {
    throw new Error("Missing imported layers: " + opts.expectedLayers.filter(name => !names.includes(name)).join(", "));
  }
  await applyFonts(page, log, opts.fonts || []);
  if (!(await publish(page, log, opts))) throw new Error("Publication not confirmed");
  if (opts.prepareOnly) return;
  if (opts.evidence?.length) {
    const inline = await page.evaluate(() =>
      [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].some(
        frame => frame.contentDocument?.querySelector('.ugc-copyright-section')));
    if (!inline) await openCopyrightFromManagement(page, opts.desc);
    if (!(await copyright(page, log, opts.evidence))) {
      throw new Error('Published, but copyright submission was not confirmed');
    }
  }
  const shot = await page.screenshot({ path: opts.outPreview || '/tmp/publish_final.png' });
  log('done', shot);
}

async function clickText(page, text, filter) {
  return page.evaluate(({text, filter}) => {
    const els = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() === text);
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (filter && !filter(r)) continue;
      e.click(); return true;
    }
    return false;
  }, {text, filter: filter ? filter.toString() : null});
}

async function importPsd(page, log, psd, expected = [], importAction = '替换当前画板') {
  await page.click('text="文件"');
  await page.waitForSelector('text="导入文件"',{state:'visible',timeout:15000});
  await page.click('text="导入文件"');
  await page.waitForSelector('text="上传文件"',{state:'visible',timeout:15000});
  const cp=page.waitForFileChooser({timeout:15000});
  await page.click('text="上传文件"');const ch=await cp;await ch.setFiles(psd);
  await page.waitForFunction(() => [...document.querySelectorAll('*')].some(e =>
    e.children.length === 0 && (e.innerText || '').trim() === '替换当前画板'
  ), undefined, { timeout: 65000 });
  const rep = await page.evaluate(importAction => {
    const el = [...document.querySelectorAll('*')].find(e =>
      e.children.length === 0 && (e.innerText || '').trim() === importAction);
    const box = el.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, importAction);
  await page.mouse.click(rep.x, rep.y);
  const panel = 'button[aria-label="打开本地图层管理"]';
  if (await page.evaluate(selector => !!document.querySelector(selector), panel)) {
    await page.click(panel);
  }
  await page.waitForSelector('.layer-item__item__element-name', { timeout: 40000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.layer-item__item__element-name')]
    .some(e => e.innerText.trim() !== '画板'), undefined, { timeout: 40000 });
  await page.evaluate(() => {
    for(const arrow of document.querySelectorAll('.layer-item__item__expand-box [aria-label="arrow-right-triangle"]'))arrow.parentElement.click();
  });
  await page.waitForFunction(expected => {
    for(const arrow of document.querySelectorAll('.layer-item__item__expand-box [aria-label="arrow-right-triangle"]'))arrow.parentElement.click();
    const names = [...document.querySelectorAll('.layer-item__item__element-name')].map(e => e.innerText.trim());
    return expected.length ? expected.every(name => names.includes(name)) : names.length > 1;
  }, expected, { timeout: 40000 });
  const names = await page.evaluate(() => [...document.querySelectorAll('.layer-item__item__element-name')].map(e=>e.innerText.trim()));
  log('imported layers:', names.length, names);
  return names;
}

async function selectLayer(page, name) {
  const r = await page.evaluate((n) => {
    const e = [...document.querySelectorAll('.layer-item__item__element-name')].find(x => (x.innerText || '').trim() === n);
    if (!e) return null; const b = e.getBoundingClientRect();
    return {x: b.x + b.width/2, y: b.y + b.height/2};
  }, name);
  if (!r) return false;
  await page.mouse.click(r.x, r.y); await page.waitForTimeout(700);
  return true;
}

async function applyFonts(page, log, fonts) {
  for (const [layer, fontName] of fonts) {
    if (!(await selectLayer(page, layer))) { log('layer missing', layer); continue; }
    let opened = false;
    for (const [x, y] of [[1360, 175], [1400, 175], [1320, 175], [1476, 130]]) {
      await page.mouse.click(x, y); await page.waitForTimeout(900);
      opened = await page.evaluate(() => !!document.querySelector('input[placeholder="搜索字体"]'));
      if (opened) break;
    }
    if (!opened) { log('font panel not opened for', layer); continue; }
    const si = await page.evaluate(() => { const el = document.querySelector('input[placeholder="搜索字体"]'); const b = el.getBoundingClientRect(); el.focus(); return {x: b.x+b.width/2, y: b.y+b.height/2}; });
    await page.mouse.click(si.x, si.y); await page.waitForTimeout(150);
    const base = fontName.split(' ')[0];
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(base); await page.waitForTimeout(1200);
    // poll options
    let opts = [];
    for (let i = 0; i < 15; i++) {
      opts = await page.evaluate(() => [...document.querySelectorAll('.dbu-font-panel__list__item__text')].map(e => {
        const b = e.getBoundingClientRect(); return {t: (e.innerText || '').trim(), x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2)};
      }));
      if (opts.length) break;
      await page.waitForTimeout(250);
    }
    const weight = fontName.replace(base, '').trim();
    const alt = weight === '特粗' ? ['特粗','Heavy','粗体'] : weight === 'Heavy' ? ['Heavy','特粗'] : [weight].filter(Boolean);
    let pick = opts.find(o => o.t === fontName) || opts.find(o => o.t === base + ' ' + weight);
    if (!pick) for (const w of alt) { pick = opts.find(o => o.t.includes(w)); if (pick) break; }
    if (!pick) pick = opts[0];
    if (!pick) { log('no options for', fontName); continue; }
    await page.mouse.click(pick.x, pick.y); await page.waitForTimeout(1200);
    await page.evaluate(() => { const b = document.querySelector('.dui-panel-title-block__back-icon__button'); if (b) b.click(); });
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    log('font ok', layer, '->', pick.t);
  }
}

async function publishForm(page, log, opts) {
  const visible=await page.evaluate(()=>{const e=document.querySelector('.dub-publish-scope-panel');return e&&e.getBoundingClientRect().width>0});
  if(!visible)await page.click('.dub-publish-button');
  await page.waitForFunction(()=>document.querySelector('.dub-publish-scope-panel')?.getBoundingClientRect().width>0||[...document.querySelectorAll('iframe')].some(f=>f.contentDocument?.querySelector('.ugc-copyright-section')||f.contentDocument?.querySelector('[contenteditable="true"]')),undefined,{timeout:30000});
  if(await page.evaluate(()=>document.querySelector('.dub-publish-scope-panel')?.getBoundingClientRect().width>0)){
    const count=await page.evaluate(()=>{const panel=document.querySelector('.dub-publish-scope-panel');const all=[...panel.querySelectorAll('button')].find(b=>b.innerText.includes('全部画板'));if(!all)throw Error('Missing all-page scope');all.click();return Number(all.querySelector('.dub-publish-scope-panel__option-count')?.innerText)});
    if(opts.expectedPages&&count!==opts.expectedPages)throw Error('Unexpected publish page count '+count);
    await page.waitForFunction(()=>[...document.querySelectorAll('.dub-publish-scope-panel__option')].some(e=>e.innerText.includes('全部画板')&&e.getAttribute('aria-pressed')==='true'));
    if(opts.onScope)await opts.onScope({mode:'all',count});
    await page.click('.dub-publish-scope-panel__submit');
  }
  return true;
}

async function inIframe(page, fn, ...args) {
  return page.evaluate(fn, ...args);
}

async function publish(page, log, opts) {
  // rename
  const fi = await page.evaluate(() => { const el = document.querySelector('input[placeholder="请输入文件名"]'); if (!el) return null; const b = el.getBoundingClientRect(); return {x: b.x+b.width/2, y: b.y+b.height/2}; });
  if (fi) {
    await page.mouse.click(fi.x, fi.y); await page.waitForTimeout(300);
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(opts.title); await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
  }
  if (!(await publishForm(page, log, opts))) return;
  await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.contentDocument?.querySelector('.ugc-copyright-section')||f.contentDocument?.querySelector('[contenteditable="true"]')),undefined,{timeout:30000});
  const needsDeclaration=await page.evaluate(()=>[...document.querySelectorAll('iframe')].some(f=>f.contentDocument?.querySelector('.ugc-copyright-section')));
  if(needsDeclaration){
    if(!opts.prepareCopyright)throw Error('Classify registered materials and attach evidence before continuing');
    await opts.prepareCopyright();
  }
  // wait for dialog content, then click topic title (adds topicsIds chip)
  let t = null;
  for (let i = 0; i < 20; i++) {
    t = await page.evaluate((name) => {
      const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
      const doc = ifr && ifr.contentDocument; if (!doc || !doc.body) return null;
      if (!doc.body.innerText.includes('活动话题')) return null;
      const leaf = [...doc.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() === name)[0];
      if (!leaf) return null; const b = leaf.getBoundingClientRect();
      return {x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2)};
    }, opts.topic);
    if (t) break;
    await page.waitForTimeout(400);
  }
  if (t) { await page.mouse.click(t.x, t.y); await page.waitForTimeout(2200); } else log('topic not found', opts.topic);
  if (!t) throw new Error('Topic is unavailable: ' + opts.topic);
  // Match the activity card by title. The first activity can be a different topic.
  const activity = await page.evaluate((topic) => {
    const frame = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = frame?.contentDocument;
    const titles = [...doc.querySelectorAll('*')].filter(e =>
      !e.children.length && e.innerText?.trim() === topic && !e.closest('[contenteditable]'));
    for (const title of titles) {
      const card = title.closest('[role="button"], button');
      if (!card) continue;
      if (card.innerText.includes('已参与活动')) return true;
      if (card.innerText.includes('参与活动')) {
        card.click();
        return true;
      }
    }
    return false;
  }, opts.topic);
  if (!activity) throw new Error('Activity is unavailable: ' + opts.topic);
  // description append
  await page.evaluate((desc) => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr && ifr.contentDocument; if (!doc) return;
    const ce = doc.querySelector('[contenteditable="true"]'); if (!ce) return;
    ce.focus(); const sel = ifr.contentWindow.getSelection(); const range = doc.createRange();
    range.selectNodeContents(ce); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
    doc.execCommand('insertText', false, ' ' + desc);
  }, opts.desc);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const frame = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const toggle = frame?.contentDocument?.querySelector('[role="switch"][aria-label="含AI生成内容"]');
    if (toggle?.getAttribute('aria-checked') === 'false') toggle.click();
  });
  const valid = await page.evaluate((topic) => {
    const frame = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = frame?.contentDocument;
    const chips = [...doc.querySelectorAll('[contenteditable="true"] [data-topic-id]')];
    const title = [...doc.querySelectorAll('[role="button"], button')].find(e =>
      e.innerText.includes(topic) && e.innerText.includes('已参与活动'));
    return chips.length === 1 && chips[0].textContent.startsWith(topic) && !!title &&
      doc.querySelector('[aria-label="含AI生成内容"]')?.getAttribute('aria-checked') === 'true';
  }, opts.topic);
  if (!valid) throw new Error('Check the topic chip, activity selection and AI disclosure before publishing');
  if (opts.prepareOnly) return true;
  await page.evaluate(() => {
    const frame = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const button = [...frame.contentDocument.querySelectorAll('button')].find(e => e.innerText.trim() === '发布');
    if (!button || button.disabled) throw new Error('Publish button is unavailable');
    button.click();
  });
  await page.waitForTimeout(8000);
  const ok = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr && ifr.contentDocument; return !!(doc && doc.body.innerText.includes('发布成功'));
  });
  log('published:', ok);
  if (!ok) return;
  // copyright
  const b = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr && ifr.contentDocument; if (!doc) return null;
    const btn = [...doc.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '去完善');
    if (!btn) return null; const r = btn.getBoundingClientRect();
    return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)};
  });
  if (b) { await page.mouse.click(b.x, b.y); await page.waitForTimeout(5000); }
  return true;
}

async function openCopyrightFromManagement(page, description) {
  await page.goto('https://www.gaoding.com/my/publish');
  await page.waitForFunction(desc => [...document.images].some(img => img.alt === desc),
    description, { timeout: 30000 });
  await page.evaluate(desc => {
    const matches = [...document.images].filter(img => img.alt === desc);
    if (matches.length !== 1) throw new Error('Published work is not uniquely identified');
    const card = matches[0].parentElement.parentElement;
    const more = card.querySelector('button[aria-label="更多"]');
    if (!more) throw new Error('Publication menu is unavailable');
    more.click();
  }, description);
  await page.waitForSelector('[role="menuitem"]');
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find(e => e.innerText.trim() === '版权认证');
    if (!item) throw new Error('Copyright entry is unavailable');
    item.click();
  });
  await page.waitForSelector('.ugc-copyright-section');
}

async function copyright(page, log, evidence) {
  const has = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr?.contentDocument || document; return !!(doc && doc.querySelector('.ugc-copyright-section'));
  });
  if (!has) { log('copyright dialog not open'); return; }
  // classify all uncategorized -> original_ai
  for (let i = 0; i < 30; i++) {
    const n = await page.evaluate(() => {
      const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
      const doc = ifr?.contentDocument || document; if (!doc) return 0;
      return doc.querySelectorAll('.ugc-copyright-section-uncategorized .ugc-copyright-thumb').length;
    });
    if (n === 0) break;
    await page.evaluate(() => {
      const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
      const doc = ifr?.contentDocument || document, w = ifr?.contentWindow || window;
      const from = doc.querySelector('.ugc-copyright-section-uncategorized');
      const to = doc.querySelector('.ugc-copyright-section-original_ai');
      const th = from && from.querySelector('.ugc-copyright-thumb');
      const zone = to && to.querySelector('.ugc-copyright-grid-content');
      if (!th || !zone) return;
      const dt = new w.DataTransfer();
      const fire = (el, t) => el.dispatchEvent(new w.DragEvent(t, {bubbles: true, cancelable: true, dataTransfer: dt}));
      fire(th, 'dragstart'); fire(zone, 'dragenter'); fire(zone, 'dragover'); fire(zone, 'drop'); fire(th, 'dragend');
    });
    await page.waitForTimeout(700);
  }
  // evidence upload
  const b = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr?.contentDocument || document; if (!doc) return null;
    const sec = doc.querySelector('.ugc-copyright-section-original_ai');
    const el = sec && [...sec.querySelectorAll('*')].find(e => e.children.length === 0 && (e.innerText || '').trim().includes('声明材料'));
    if (!el) return null; const r = el.getBoundingClientRect();
    return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)};
  });
  if (b && evidence.length) {
    const cp = page.waitForFileChooser({ timeout: 12000 });
    await page.mouse.click(b.x, b.y); const ch = await cp; await ch.setFiles(evidence);
    await page.waitForTimeout(6000);
  }
  // checkbox + submit
  const cb = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr?.contentDocument || document; if (!doc) return null;
    const c = doc.querySelector('input[type=checkbox]'); if (!c) return null;
    const r = c.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), checked: c.checked};
  });
  if (cb && !cb.checked) { await page.mouse.click(cb.x, cb.y); await page.waitForTimeout(700); }
  const sb = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr?.contentDocument || document; if (!doc) return null;
    const btn = [...doc.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '声明并发布');
    if (!btn) return null; const r = btn.getBoundingClientRect();
    return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)};
  });
  if (sb) { await page.mouse.click(sb.x, sb.y); await page.waitForTimeout(9000); }
  const closed = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr?.contentDocument || document;
    return !doc.querySelector('.ugc-copyright-section');
  });
  log('copyright dialog closed after clicking submit:', !!sb && closed);
  return !!sb && closed;
}

module.exports = { run, applyFonts, importPsd, publish, publishForm, copyright };
