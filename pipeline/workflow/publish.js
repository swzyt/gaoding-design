const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const flow = require('../publish_flow.js');
const fonts = require('./fonts.js');
const copyrightFlow = require('./copyright.js');
const read = async p => JSON.parse(await fs.readFile(p,'utf8'));
const write = async (p,v) => fs.writeFile(p,JSON.stringify(v,null,2));
const exists = async p => fs.access(p).then(()=>true,()=>false);
async function config(recipePath) {
 const recipe=await read(recipePath),root=path.dirname(recipePath),out=path.join(root,recipe.output||'release');
 return {recipe,root,out,spec:await read(path.join(out,'spec.json'))};
}
async function prepare(page,recipePath) {
 const {recipe,out,spec}=await config(recipePath), statePath=path.join(out,'editor-state.json');
 let state=await exists(statePath)?await read(statePath):{};
 if(state.url){
  if(state.stage!=='created'&&!new URL(state.url).searchParams.has('id'))throw Error('Saved editor URL lacks a permanent ID; recover the existing tab URL before resuming.');
  if((await page.url())!==state.url)await page.goto(state.url,{timeout:60000});
 }
 else {
  await page.goto(`https://www.gaoding.com/editor/design?mode=create&category_id=912&type=poster&width=${spec.canvas.w}&height=${spec.canvas.h}&unit=px&dpi=${spec.canvas.dpi||72}`,{timeout:60000});
  await page.waitForFunction(()=>!!document.querySelector('input[placeholder="请输入文件名"]'),undefined,{timeout:60000});
  state={stage:'created',url:await page.url()};await write(statePath,state);
 }
 const boards=spec.pages||[{id:'main',psd:'template.psd',layers:spec.layers.map(x=>x.name)}];
 if(!state.importedPages)state.importedPages=state.stage==='created'?[]:(spec.pages?[]:['main']);
 if(state.stage==='import-started')throw Error('Uncertain import. Inspect current layers and recover pendingPage before continuing.');
 for(let i=0;i<boards.length;i++){
  const board=boards[i];if(state.importedPages.includes(board.id))continue;
  state.stage='import-started';state.pendingPage=board.id;await write(statePath,state);
  const names=await flow.importPsd(page,console.log,path.join(out,board.psd),board.layers,i===0?'替换当前画板':'添加为新画板');
  await page.waitForFunction(()=>new URL(location.href).searchParams.has('id'),undefined,{timeout:30000});
  state.importedPages.push(board.id);delete state.pendingPage;state.stage='imported';state.url=await page.url();state.importedLayers=names;await write(statePath,state);
 }
 await page.waitForFunction(()=>!!document.querySelector('input[placeholder="请输入文件名"]'),undefined,{timeout:60000});
 if(await page.evaluate(()=>!!document.querySelector('button[aria-label="打开本地图层管理"]')))await page.click('button[aria-label="打开本地图层管理"]');
 await page.waitForFunction(()=>!!document.querySelector('.layer-item__item__element-name'),undefined,{timeout:30000});
 await page.evaluate(()=>{for(const e of document.querySelectorAll('.layer-item__item__expand-box [aria-label="arrow-right-triangle"]'))e.parentElement.click();});
 await page.waitForFunction(names=>names.every(n=>[...document.querySelectorAll('.layer-item__item__element-name')].some(e=>e.innerText.trim()===n)),(spec.pages?spec.layers.filter(l=>l.page===spec.pages[0].id):spec.layers).map(x=>x.name),{timeout:60000});
 const verification=path.join(out,'font-verification.json');
 const applied=await exists(verification)?await read(verification):[];
 const remaining=recipe.layers.filter(x=>x.type==='text'&&!applied.some(y=>y.layer===x.name));
 await fonts.apply(page,remaining.map(x=>[x.name,x.gd_font]),async current=>write(verification,[...applied,...current]));
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!!document.querySelector('[aria-label="cloud-save-success"]'),undefined,{timeout:30000});
 await page.screenshot({path:path.join(out,'editor-ready.png')});
 state={...state,stage:'ready-for-visual-review',url:await page.url()};await write(statePath,state);
 return state;
}
async function prepareForm(page,recipePath) {
 const {recipe,out,spec}=await config(recipePath);
 await require('./layer_audit.js').requireAudit(out,recipePath);
 await requireBindings(out,spec);
 const review=await read(path.join(out,'visual-review.json'));
 const hash=crypto.createHash('sha256').update(await fs.readFile(path.join(out,'spec.json'))).digest('hex');
 if(!review.passed||review.spec_sha256!==hash)throw Error('Current spec needs an agent visual review of the actual editor');
 const verified=await read(path.join(out,'font-verification.json'));
 if(!spec.layers.filter(x=>x.type==='text').every(x=>verified.some(y=>y.layer===x.name)))throw Error('Missing verified fonts');
 const state=await read(path.join(out,'editor-state.json'));
 if((await page.url())!==state.url)await page.goto(state.url,{timeout:60000});
 const publication=path.join(out,'publication.json');
 if(await exists(publication)){
  const old=await read(publication);if(old.published||old.stage==='submission-started')throw Error('Existing publication/submission. Verify it instead of submitting again.');
 }
 await flow.publish(page,console.log,{title:recipe.title,topic:recipe.topic,desc:recipe.description,prepareOnly:true,expectedPages:spec.pages?.length||1,onScope:scope=>write(path.join(out,'publication-scope.json'),scope),prepareCopyright:async()=>{await copyrightFlow.prepare(page,recipePath);await copyrightFlow.submit(page,recipePath);}});
 await page.screenshot({path:path.join(out,'publication-form.png')});
 await write(publication,{stage:'form-ready',title:recipe.title,desc:recipe.description,topic:recipe.topic,designUrl:await page.url(),published:false});
 return read(publication);
}
async function submit(page,recipePath) {
 const {out}=await config(recipePath),file=path.join(out,'publication.json');
 await require('./layer_audit.js').requireAudit(out,recipePath);
 const state=await read(file);
 // The success receipt is durable before optional copyright UI work. Resume skips the click.
 if(state.published===true && ['published','verified'].includes(state.stage))return state;
 if(state.stage!=='form-ready')throw Error('Refusing duplicate or unprepared submission: '+state.stage);
 await page.evaluate(()=>{
  const frame=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop(),doc=frame?.contentDocument;
  const button=doc&&[...doc.querySelectorAll('button')].find(e=>e.innerText.trim()==='发布');
  if(!button||button.disabled)throw Error('Publish button is unavailable');
 });
 state.stage='submission-started';state.submissionStartedAt=new Date().toISOString();await write(file,state);
 await page.evaluate(()=>{
  const frame=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
  [...frame.contentDocument.querySelectorAll('button')].find(e=>e.innerText.trim()==='发布').click();
 });
 await page.waitForFunction(()=>[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].some(f=>f.contentDocument?.body?.innerText.includes('发布成功')),undefined,{timeout:45000});
 state.stage='published';state.published=true;state.publishedAt=new Date().toISOString();await write(file,state);
 await page.screenshot({path:path.join(out,'publication-success.png')});
 const open=await page.evaluate(()=>{
  const frame=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].pop();
  const btn=[...frame.contentDocument.querySelectorAll('button')].find(e=>e.innerText.trim()==='去完善');
  if(btn){btn.click();return true;}return false;
 });
 if(open){
  await page.waitForFunction(()=>[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].some(f=>f.contentDocument?.querySelector('.ugc-copyright-section')),undefined,{timeout:20000});
  await copyrightFlow.prepare(page,recipePath);await copyrightFlow.submit(page,recipePath);state.copyrightSubmitted=true;await write(file,state);
 }
 return state;
}
module.exports={prepare,prepareForm,submit};

async function verify(page,recipePath,options={}) {
 const {recipe,out}=await config(recipePath),file=path.join(out,'publication.json');
 const state=await read(file);
 await page.goto('https://www.gaoding.com/my/publish',{timeout:60000});
 await page.waitForFunction(desc=>[...document.images].some(i=>i.alt===desc),recipe.description,{timeout:30000});
 await page.waitForFunction(desc=>{const i=[...document.images].find(i=>i.alt===desc);return i&&/审核不通过|审核通过|审核中|草稿/.test(i.parentElement.parentElement.innerText)},recipe.description,{timeout:30000});
 const card=await page.evaluate(desc=>{
  const matches=[...document.images].filter(i=>i.alt===desc);
  if(matches.length!==1)throw Error('Expected one publication card, found '+matches.length);
  const card=matches[0].parentElement.parentElement;
  const status=card.innerText.match(/审核不通过|审核通过|审核中|草稿/)?.[0];
  if(!status)throw Error('Unknown publication status');
  return {status};
 },recipe.description);
 state.managementStatus=card.status;state.verifiedAt=new Date().toISOString();
 await page.screenshot({path:path.join(out,'publication-verified.png')});
 await write(file,state);
 // Inspect the actual response triggered by the visible copyright entry, without replaying authentication.
 await page.cdp('Network.enable');await page.events();
 await page.evaluate(desc=>[...document.images].find(i=>i.alt===desc).parentElement.parentElement.querySelector('button[aria-label="更多"]').click(),recipe.description);
 await page.waitForFunction(()=>{const e=document.querySelector('[data-action="open-copyright-declaration"]');return e&&getComputedStyle(e.closest('.gda-dropdown')).opacity==='1'},undefined,{timeout:5000});
 await page.click('[data-action="open-copyright-declaration"]');
 let versions,content;
 for(let i=0;i<40&&!versions?.length&&!content;i++){
  for(const event of await page.events()){
   if(event.method==='Network.responseReceived'&&/\/contents\/\d+\/versions(?:\?|$)/.test(event.params.response.url)){
    const body=await page.cdp('Network.getResponseBody',{requestId:event.params.requestId});
    const parsed=JSON.parse(body.body);if(Array.isArray(parsed))versions=parsed;
   }
   if(event.method==='Network.responseReceived'&&/\/gaoding-art\/v1\/contents\/\d+(?:\?|$)/.test(event.params.response.url)){
    const body=await page.cdp('Network.getResponseBody',{requestId:event.params.requestId});
    const parsed=JSON.parse(body.body);if(parsed.id)content=parsed;
   }
  }
  if(!versions?.length&&!content)await new Promise(r=>setTimeout(r,250));
 }
 if(!versions?.length&&!content)throw Error('Missing publication metadata');
 const latest=versions?.[0]||{content_id:content.id,version_no:null,status_name:card.status,payload:content},payload=latest.payload||{};
 const topics=latest.topics||payload.ugc_topics||[];
 state.topicVerified=topics.some(t=>t.name===recipe.topic);
 if(!state.topicVerified||payload.user_marked_aigc!==true)throw Error('Published topic or AI disclosure is missing');
 state.contentId=latest.content_id;state.contentVersion=latest.version_no;state.versionStatus=latest.status_name;
 state.publishedUrl='https://www.gaoding.com/editor/design?id='+latest.content_id+'&mode=ugc_version_update';
 try {
  await page.waitForFunction(()=>[document,...[...document.querySelectorAll('iframe')].map(f=>f.contentDocument).filter(Boolean)].some(d=>d.querySelector('.ugc-copyright-section')),undefined,{timeout:15000});
 }catch(error){
  state.stage='material-registration-failed';state.copyright={state:'missing-panel',verified:false};await write(file,state);
  throw Error('Copyright candidates/panel are missing. Register and bind every PNG; empty materials is a failure, never completion.');
 }
 await write(file,state);
 if(options.openOnly)return state;
 const copyright=await copyrightFlow.verify(page,recipePath);
 state.copyright=copyright;
 if(card.status==='草稿')state.stage='draft-needs-submit';
 else if(card.status==='审核不通过')state.stage='rejected-needs-review';
 else {state.stage='verified';state.published=true;}
 await write(path.join(out,'copyright-verification.json'),copyright);await write(file,state);
 return state;
}
module.exports.verify=verify;

async function requireBindings(out,spec){
 const registered=await read(path.join(out,'registered-assets.json')),bound=await read(path.join(out,'bound-assets.json'));
 const review=await read(path.join(out,'material-review.json'));
 const sha=crypto.createHash('sha256').update(await fs.readFile(path.join(out,'bound-assets.json'))).digest('hex');
 if(!review.passed||review.bindings_sha256!==sha)throw Error('Review the actual canvas after material binding');
 for(const row of registered){
  const actual=crypto.createHash('sha256').update(await fs.readFile(path.join(out,'assets',row.id+'.png'))).digest('hex');
  if(actual!==row.sha256)throw Error('Registered asset changed after upload: '+row.id);
 }
 if(bound.pending||spec.layers.filter(l=>l.type==='image').length!==registered.length||!registered.every(r=>bound.layers.some(b=>b.asset_id===r.asset_id&&b.sha256===r.sha256)))throw Error('Register and bind all image layers first');
}
async function prepareUpdate(page,recipePath){
 const {recipe,out,spec}=await config(recipePath);await requireBindings(out,spec);
 const file=path.join(out,'publication.json'),old=await read(file),bound=await read(path.join(out,'bound-assets.json'));
 if(old.stage==='submission-started')throw Error('Uncertain submission; verify before updating');
 if(new URL(bound.url).searchParams.get('id')!==String(old.contentId))throw Error('Repair must target the existing published content ID');
 if(await page.url()!==bound.url)await page.goto(bound.url,{timeout:60000});
 const inForm=await page.evaluate(desc=>[...document.querySelectorAll('iframe')].some(f=>f.contentDocument?.querySelector('[contenteditable="true"]')?.textContent.includes(desc)),recipe.description);
 if(!inForm){
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='发布修改'),undefined,{timeout:30000});
  await page.click('text="发布修改"');
  await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.contentDocument?.querySelector('.ugc-copyright-section')||f.contentDocument?.querySelector('[contenteditable="true"]')),undefined,{timeout:30000});
  if(await copyrightFlow.inspect(page)){await copyrightFlow.prepare(page,recipePath);await copyrightFlow.submit(page,recipePath);}
 }
 await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.contentDocument?.querySelector('[contenteditable="true"]')),undefined,{timeout:30000});
 const valid=await page.evaluate(topic=>{const d=[...document.querySelectorAll('iframe')].pop().contentDocument;return d.querySelector('[data-topic-id]')?.textContent===topic&&d.querySelector('[aria-label="含AI生成内容"]')?.getAttribute('aria-checked')==='true'},recipe.topic);
 if(!valid)throw Error('Update form lost topic or AI disclosure');
 const history=path.join(out,'publication-before-material-fix.json');if(!await exists(history))await write(history,old);
 await page.screenshot({path:path.join(out,'publication-form-v2.png')});
 const state={...old,stage:'form-ready',materialRepair:true,designUrl:await page.url()};await write(file,state);return state;
}
module.exports.prepareUpdate=prepareUpdate;

async function completeDeclaration(page,recipePath){
 const {out}=await config(recipePath);
 await verify(page,recipePath,{openOnly:true});
 const rows=await copyrightFlow.resolve(page,out,await read(path.join(out,'registered-assets.json')));
 let valid=false;try{copyrightFlow.validate(await copyrightFlow.inspect(page),rows);valid=true;}catch(error){}
 if(valid)return {stage:'already-declared',expected:rows.length};
 await copyrightFlow.prepare(page,recipePath);
 return copyrightFlow.submit(page,recipePath);
}
module.exports.completeDeclaration=completeDeclaration;
