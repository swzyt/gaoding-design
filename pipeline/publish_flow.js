/**
 * 稿定自动化发布流水线（ego-browser）
 * 用法（在 ego-browser nodejs 里）：
 *   const flow = require('<此目录>/publish_flow.js');
 *   await flow.run({ space: 6, topicKey: 'birthday', psd: '/abs/path/birthday.psd',
 *                    title: '韩系拼贴风 生日海报 小红书封面',
 *                    desc: '……（不含话题标签）',
 *                    topic: '偶像生日应援局', containsAI: true, copyrightCategory: 'original_ai',
 *                    fonts: [['文案-主标题','思源黑体 Heavy'], ...],
 *                    evidence: ['/abs/tl.png','/abs/dt.png','/abs/cd.png'] });
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Ordinary long-running topics do not imply activity enrollment. Missing kind
// retains the legacy activity route; provenance is explicit on every material.
function publicationPolicy(recipe) {
  const topicKind = recipe.topic_kind ?? 'activity';
  if (!['topic', 'activity'].includes(topicKind)) throw Error('topic_kind must be topic or activity');
  if (!Array.isArray(recipe.layers)) {
    if (typeof recipe.containsAI !== 'boolean') throw Error('Publication policy requires recipe.layers provenance or explicit containsAI for legacy callers');
    return {topicKind, containsAI: recipe.containsAI, categories: null};
  }
  const categories = new Set();
  for (const layer of recipe.layers) {
    if (layer.type === 'text') continue;
    if (!['image', 'shape'].includes(layer.type)) throw Error('Unsupported material type: ' + layer.type);
    if (!['original', 'original_ai', 'non_original', 'gaoding'].includes(layer.copyright_category)) throw Error('Missing/unsupported material provenance: ' + (layer.name || layer.id));
    categories.add(layer.copyright_category);
  }
  return {topicKind, containsAI: categories.has('original_ai'), categories: [...categories].sort()};
}

async function run(opts) {
  const policy = publicationPolicy(opts.recipe || opts); // Fail ambiguous disclosure before navigating/importing.
  const copyrightCategory = policy.categories?.length === 1 ? policy.categories[0] : opts.copyrightCategory;
  if (opts.evidence?.length) {
    if (!['original','original_ai'].includes(copyrightCategory) || (policy.categories && policy.categories.length !== 1) || (copyrightCategory === 'original_ai') !== policy.containsAI) throw Error('Legacy copyright needs one explicit source category; use the workflow for mixed materials');
  }
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
    if (!(await copyright(page, log, opts.evidence, copyrightCategory))) {
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
  return require('./workflow/fonts.js').apply(page, fonts, rows => {
    for (const row of rows.slice(-1)) log('font ok', row.layer, '->', row.font);
  });
}

async function openPublicationDialog(page) {
  return page.evaluate(()=>{
    const frames=[...new Set(document.querySelectorAll('iframe[id^="buy-buy-application-modal"]'))].filter(f=>{const r=f.getBoundingClientRect();return r.width>0&&r.height>0;});
    if(!frames.length)return null;
    if(frames.length!==1)throw Error('Ambiguous visible publication dialogs');
    const doc=frames[0].contentDocument;
    if(doc?.querySelector('[contenteditable="true"]')&&doc.querySelector('button[aria-label="含AI生成内容"][role="switch"]'))return 'form';
    if(doc?.querySelector('.ugc-copyright-section'))return 'copyright';
    throw Error('Unknown visible publication dialog; inspect before retrying');
  });
}
async function publishForm(page, log, opts) {
  if(await openPublicationDialog(page))return true;
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

// Read the observed iframe form; return viewport coordinates for native input.
// No DOM click() is used here: it did not reliably trigger the editor's handlers.
async function formAction(page,action,values={}) {
  return page.evaluate(({action,values})=>{
    const frames=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].filter(f=>{
      const r=f.getBoundingClientRect();return r.width>0&&r.height>0&&f.contentDocument?.querySelector('[contenteditable="true"]');
    });
    if(frames.length!==1)throw Error('Expected one visible publication form, found '+frames.length);
    const frame=frames[0],doc=frame.contentDocument,ce=doc.querySelector('[contenteditable="true"]');
    const point=el=>{if(!el||el.disabled)throw Error('Publication control is unavailable');const r=el.getBoundingClientRect(),f=frame.getBoundingClientRect();if(!r.width||!r.height)throw Error('Publication control is hidden');return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};};
    if(action==='state'){
      const chips=[...ce.querySelectorAll('[data-topic-id]')].map(el=>({id:el.getAttribute('data-topic-id'),text:el.textContent.trim(),editable:el.getAttribute('contenteditable')}));
      const toggle=doc.querySelector('button[aria-label="含AI生成内容"][role="switch"]');
      return {chips,description:ce.textContent,ai:toggle?.getAttribute('aria-checked'),activity:[...doc.querySelectorAll('[role="button"], button')].some(el=>el.innerText.includes(values.topic)&&el.innerText.includes('已参与活动'))};
    }
    if(action==='topic-button'){
      const buttons=[...doc.querySelectorAll('button')].filter(el=>el.innerText.trim()==='话题');
      if(buttons.length!==1)throw Error('Expected one ordinary topic button, found '+buttons.length);
      return point(buttons[0]);
    }
    if(action==='candidate'||action==='candidate-status'){
      // Count distinct visible buttons, never the wrapper/title spans they contain.
      const candidates=[...new Set(doc.querySelectorAll('button[data-topic-candidate-id]'))].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
      const exact=candidates.filter(el=>[...el.querySelectorAll('span')].some(span=>span.children.length===0&&span.textContent.trim()===values.topic));
      if(action==='candidate-status')return {count:candidates.length,exact:exact.length};
      if(exact.length!==1)throw Error('Expected one exact topic candidate, found '+exact.length+' among '+candidates.length);
      const id=exact[0].getAttribute('data-topic-candidate-id');
      if(!id?.trim())throw Error('Topic candidate lacks a real ID');
      return {...point(exact[0]),id};
    }
    if(action==='switch'){
      const switches=[...doc.querySelectorAll('button[aria-label="含AI生成内容"][role="switch"]')];
      if(switches.length!==1||!['true','false'].includes(switches[0].getAttribute('aria-checked')))throw Error('AI disclosure switch is missing or ambiguous');
      return {...point(switches[0]),checked:switches[0].getAttribute('aria-checked')};
    }
    if(action==='description-end'){
      ce.focus();const selection=frame.contentWindow.getSelection(),range=doc.createRange();
      range.selectNodeContents(ce);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
      return true;
    }
    throw Error('Unknown publication form action: '+action);
  },{action,values});
}

async function chooseOrdinaryTopic(page,topic) {
  if(typeof topic!=='string'||!topic.trim())throw Error('Ordinary publication requires an exact topic name');
  const state=await formAction(page,'state',{topic});
  if(state.chips.length){
    if(state.chips.length!==1||state.chips[0].text!==topic||!state.chips[0].id||state.chips[0].editable!=='false')throw Error('Existing topic chip does not match the requested topic');
    return state.chips[0].id;
  }
  const pending=await formAction(page,'candidate-status',{topic});
  if(pending.count&&pending.exact!==1)throw Error('Ambiguous or unknown existing topic search candidates');
  if(!pending.count&&!state.description.includes('#'+topic)){
    if(state.description.includes('#'))throw Error('Unknown existing topic search text; inspect before retrying');
    const button=await formAction(page,'topic-button');await page.mouse.click(button.x,button.y);
    await page.waitForFunction(()=>{
      const frame=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].filter(f=>f.getBoundingClientRect().width>0&&f.contentDocument?.querySelector('[contenteditable="true"]')).pop();
      const doc=frame?.contentDocument,ce=doc?.querySelector('[contenteditable="true"][role="textbox"][aria-label="描述"]');
      return ce&&doc.activeElement===ce&&ce.textContent.includes('#');
    },undefined,{timeout:15000});
    await page.keyboard.type(topic);
  }
  if(!pending.count)await page.waitForFunction(topic=>{
    const frame=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].filter(f=>f.getBoundingClientRect().width>0&&f.contentDocument?.querySelector('[contenteditable="true"]')).pop();
    const candidates=[...new Set(frame?.contentDocument?.querySelectorAll('button[data-topic-candidate-id]')||[])].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
    const exact=candidates.filter(el=>[...el.querySelectorAll('span')].some(span=>span.children.length===0&&span.textContent.trim()===topic));
    if(exact.length>1)throw Error('Ambiguous exact topic search candidates');
    return exact.length===1;
  },topic,{timeout:15000});
  const candidate=await formAction(page,'candidate',{topic});await page.mouse.click(candidate.x,candidate.y);
  await page.waitForFunction(({topic,id})=>{
    const frame=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].filter(f=>f.getBoundingClientRect().width>0&&f.contentDocument?.querySelector('[contenteditable="true"]')).pop();
    const chips=[...(frame?.contentDocument?.querySelectorAll('[contenteditable="true"] [data-topic-id]')||[])];
    return chips.length===1&&chips[0].getAttribute('data-topic-id')===id&&chips[0].getAttribute('contenteditable')==='false'&&chips[0].textContent.trim()===topic;
  },{topic,id:candidate.id},{timeout:15000});
  return candidate.id;
}

async function setAIDisclosure(page,containsAI) {
  if(typeof containsAI!=='boolean')throw Error('AI disclosure must be an explicit boolean');
  const target=await formAction(page,'switch');
  if(target.checked!==String(containsAI))await page.mouse.click(target.x,target.y);
  await page.waitForFunction(expected=>{
    const frames=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].filter(f=>f.getBoundingClientRect().width>0&&f.contentDocument?.querySelector('[contenteditable="true"]'));
    if(frames.length!==1)return false;
    return frames[0].contentDocument.querySelector('button[aria-label="含AI生成内容"][role="switch"]')?.getAttribute('aria-checked')===String(expected);
  },containsAI,{timeout:15000});
}

async function requirePublicationForm(page,topic,policy) {
  const state=await formAction(page,'state',{topic});
  if(state.chips.length!==1||!state.chips[0].id||state.chips[0].text!==topic||state.ai!==String(policy.containsAI)||(policy.topicKind==='topic'&&state.chips[0].editable!=='false')||(policy.topicKind==='activity'&&!state.activity))throw Error('Publication form topic/activity/AI disclosure does not match the recipe policy');
  return state;
}

async function publish(page, log, opts) {
  const policy = publicationPolicy(opts.recipe || opts);
  // An existing iframe blocks the editor header. Resume it rather than
  // clicking through its backdrop or inserting another topic search token.
  const openDialog=await openPublicationDialog(page);
  const fi = await page.evaluate(() => { const el = document.querySelector('input[placeholder="请输入文件名"]'); if (!el) return null; const b = el.getBoundingClientRect(); return {value:el.value,x: b.x+b.width/2, y: b.y+b.height/2}; });
  if(openDialog&&fi&&fi.value!==opts.title)throw Error('Existing publication dialog has a different filename; inspect before retrying');
  if (fi && fi.value!==opts.title && !openDialog) {
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
  if (policy.topicKind === 'topic') {
    await chooseOrdinaryTopic(page,opts.topic);
  } else {
  // Legacy activity route remains separate from ordinary topic selection.
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
  }
  if (typeof opts.desc !== 'string') throw Error('Publication description must be a string');
  if (opts.desc && !(await formAction(page,'state',{topic:opts.topic})).description.includes(opts.desc)) {
    await formAction(page,'description-end');
    await page.keyboard.type(' ' + opts.desc);
    await page.waitForFunction(desc=>[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].some(f=>f.contentDocument?.querySelector('[contenteditable="true"]')?.textContent.includes(desc)),opts.desc,{timeout:15000});
  }
  await setAIDisclosure(page,policy.containsAI);
  await requirePublicationForm(page,opts.topic,policy);
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

async function copyright(page, log, evidence, category) {
  if (!['original','original_ai'].includes(category)) throw Error('Legacy copyright requires an explicit material source category');
  const has = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr?.contentDocument || document; return !!(doc && doc.querySelector('.ugc-copyright-section'));
  });
  if (!has) { log('copyright dialog not open'); return; }
  // This legacy helper handles one proven source category only. Mixed-source
  // works use workflow/copyright.js, which resolves candidates individually.
  for (let i = 0; i < 30; i++) {
    const n = await page.evaluate(() => {
      const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
      const doc = ifr?.contentDocument || document; if (!doc) return 0;
      return doc.querySelectorAll('.ugc-copyright-section-uncategorized .ugc-copyright-thumb').length;
    });
    if (n === 0) break;
    await page.evaluate(category => {
      const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
      const doc = ifr?.contentDocument || document, w = ifr?.contentWindow || window;
      const from = doc.querySelector('.ugc-copyright-section-uncategorized');
      const to = doc.querySelector('.ugc-copyright-section-'+category);
      const th = from && from.querySelector('.ugc-copyright-thumb');
      const zone = to && to.querySelector('.ugc-copyright-grid-content');
      if (!th || !zone) return;
      const dt = new w.DataTransfer();
      const fire = (el, t) => el.dispatchEvent(new w.DragEvent(t, {bubbles: true, cancelable: true, dataTransfer: dt}));
      fire(th, 'dragstart'); fire(zone, 'dragenter'); fire(zone, 'dragover'); fire(zone, 'drop'); fire(th, 'dragend');
    }, category);
    await page.waitForTimeout(700);
  }
  // evidence upload
  const b = await page.evaluate(category => {
    const ifr = [...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
    const doc = ifr?.contentDocument || document; if (!doc) return null;
    const sec = doc.querySelector('.ugc-copyright-section-'+category);
    const el = sec && [...sec.querySelectorAll('*')].find(e => e.children.length === 0 && (e.innerText || '').trim().includes('声明材料'));
    if (!el) return null; const r = el.getBoundingClientRect();
    return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)};
  }, category);
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

module.exports = { run, applyFonts, importPsd, publish, publishForm, copyright, publicationPolicy, chooseOrdinaryTopic, setAIDisclosure, requirePublicationForm };
