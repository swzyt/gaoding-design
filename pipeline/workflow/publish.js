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
async function acknowledgeTenantNotice(page) {
 const target=await page.evaluate(()=>{
  const visible=[...document.querySelectorAll('[role="dialog"], dialog')].filter(d=>{const r=d.getBoundingClientRect();return r.width>0&&r.height>0;});
  if(!visible.length)return null;
  if(visible.length!==1)throw Error('Unknown editor dialogs; inspect before continuing');
  const dialog=visible[0];
  const expected='租户获取提醒当前租户信息获取出错，已自动进入最近一次登录的租户「:」。切换租户我知道了';
  if(dialog.innerText.replace(/\s+/g,'')!==expected)throw Error('Unknown editor dialog; inspect before continuing: '+dialog.innerText);
  const buttons=[...dialog.querySelectorAll('button')];
  const acknowledge=buttons.filter(b=>b.innerText.trim()==='我知道了');
  if(acknowledge.length!==1||!buttons.some(b=>b.innerText.trim()==='切换租户'))throw Error('Tenant notice has unexpected actions');
  const r=acknowledge[0].getBoundingClientRect();
  if(!r.width||!r.height||acknowledge[0].disabled)throw Error('Tenant notice acknowledgement is unavailable');
  return {x:r.x+r.width/2,y:r.y+r.height/2};
 });
 if(!target)return false;
 // Acknowledge only this observed informational notice, never switch tenants.
 await page.mouse.click(target.x,target.y);
 await page.waitForFunction(()=>![...document.querySelectorAll('[role="dialog"], dialog')].some(d=>{const r=d.getBoundingClientRect();return r.width>0&&r.height>0;}),undefined,{timeout:15000});
 return true;
}
async function prepareLayers(page,names) {
 await page.waitForFunction(()=>!!document.querySelector('input[placeholder="请输入文件名"]'),undefined,{timeout:60000});
 await acknowledgeTenantNotice(page);
 if(await page.evaluate(()=>!!document.querySelector('.dui-panel-title-block__back-icon__button')))await page.click('.dui-panel-title-block__back-icon__button');
 if(await page.evaluate(()=>!!document.querySelector('button[aria-label="打开本地图层管理"]')))await page.click('button[aria-label="打开本地图层管理"]');
 await page.waitForFunction(()=>!!document.querySelector('.layer-item__item__element-name'),undefined,{timeout:30000});
 await page.evaluate(()=>{for(const e of document.querySelectorAll('.layer-item__item__expand-box [aria-label="arrow-right-triangle"]'))e.parentElement.click();});
 await page.waitForFunction(names=>names.every(n=>[...document.querySelectorAll('.layer-item__item__element-name')].some(e=>e.innerText.trim()===n)),names,{timeout:60000});
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
 const visibleNames=(spec.pages?spec.layers.filter(l=>l.page===spec.pages[0].id):spec.layers).map(x=>x.name);
 await prepareLayers(page,visibleNames);
 const verification=path.join(out,'font-verification.json');
 const rows=recipe.layers.filter(x=>x.type==='text').map(x=>[x.name,x.gd_font]);
 // A JSON receipt is not proof of current editor state. Every resume checks
 // every requested face, even when a previous checkpoint claimed success.
 await write(verification,[]);
 state={...state,stage:'fonts-applying'};await write(statePath,state);
 await fonts.apply(page,rows,async current=>write(verification,current));
 await page.keyboard.press('Escape');
 state={...state,stage:'fonts-awaiting-save'};await write(statePath,state);
 await page.waitForFunction(()=>!!document.querySelector('[aria-label="cloud-save-success"]'),undefined,{timeout:60000});
 // Reopen the permanent work only after actual save, then inspect checked
 // options and toolbar previews without repairing them during verification.
 await page.goto(state.url,{timeout:60000});
 await prepareLayers(page,visibleNames);
 state={...state,stage:'fonts-verifying-persistence'};await write(statePath,state);
 await write(verification,[]);
 await fonts.apply(page,rows,async current=>write(verification,current),{verifyOnly:true,persistenceVerified:true});
 await page.keyboard.press('Escape');
 await page.screenshot({path:path.join(out,'editor-ready.png')});
 state={...state,stage:'ready-for-visual-review',url:await page.url()};await write(statePath,state);
 return state;
}
async function prepareForm(page,recipePath) {
 const {recipe,out,spec}=await config(recipePath),formPolicy=flow.publicationPolicy(recipe);
 await require('./layer_audit.js').requireAudit(out,recipePath);
 await requireBindings(out,spec);
 const review=await read(path.join(out,'visual-review.json'));
 const hash=crypto.createHash('sha256').update(await fs.readFile(path.join(out,'spec.json'))).digest('hex');
 if(!review.passed||review.spec_sha256!==hash)throw Error('Current spec needs an agent visual review of the actual editor');
 const verified=await read(path.join(out,'font-verification.json'));
 if(!spec.layers.filter(x=>x.type==='text').every(x=>{const row=recipe.layers.find(r=>r.name===x.name&&r.type==='text');return row&&verified.some(y=>y.layer===x.name&&fonts.verifiedRecord(y,row.gd_font));}))throw Error('Missing fonts verified in the editor after save and reopen');
 const state=await read(path.join(out,'editor-state.json'));
 if(state.stage!=='ready-for-visual-review')throw Error('Editor preparation/save/reopen verification is incomplete: '+state.stage);
 if((await page.url())!==state.url)await page.goto(state.url,{timeout:60000});
 const publication=path.join(out,'publication.json');
 if(await exists(publication)){
  const old=await read(publication);if(old.published||old.stage==='submission-started')throw Error('Existing publication/submission. Verify it instead of submitting again.');
 }
 await flow.publish(page,console.log,{recipe,title:recipe.title,topic:recipe.topic,desc:recipe.description,prepareOnly:true,expectedPages:spec.pages?.length||1,onScope:scope=>write(path.join(out,'publication-scope.json'),scope),prepareCopyright:async()=>{await copyrightFlow.prepare(page,recipePath);await copyrightFlow.submit(page,recipePath);}});
 await page.screenshot({path:path.join(out,'publication-form.png')});
 await write(publication,{stage:'form-ready',title:recipe.title,desc:recipe.description,topic:recipe.topic,formPolicy,designUrl:await page.url(),published:false});
 return read(publication);
}
async function submit(page,recipePath) {
 const {recipe,out}=await config(recipePath),file=path.join(out,'publication.json');
 await require('./layer_audit.js').requireAudit(out,recipePath);
 const state=await read(file);
 // The success receipt is durable before optional copyright UI work. Resume skips the click.
 if(state.published===true && ['published','verified'].includes(state.stage))return state;
 if(state.stage!=='form-ready')throw Error('Refusing duplicate or unprepared submission: '+state.stage);
 if(state.formPolicy&&JSON.stringify(state.formPolicy)!==JSON.stringify(flow.publicationPolicy(recipe)))throw Error('Publication provenance/topic kind changed; prepare and review the form again');
 await flow.requirePublicationForm(page,recipe.topic,flow.publicationPolicy(recipe));
 const point=await page.evaluate(()=>{
  const frames=[...document.querySelectorAll('iframe[id^="buy-buy-application-modal"]')].filter(f=>{const r=f.getBoundingClientRect();return r.width>0&&r.height>0&&f.contentDocument?.querySelector('[contenteditable="true"]');});
  if(frames.length!==1)throw Error('Expected one visible form before submission');
  const frame=frames[0],buttons=[...frame.contentDocument.querySelectorAll('button')].filter(e=>e.innerText.trim()==='发布');
  if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute('aria-disabled')==='true')throw Error('Publish button is unavailable or ambiguous');
  const r=buttons[0].getBoundingClientRect(),f=frame.getBoundingClientRect();
  if(!r.width||!r.height)throw Error('Publish button is hidden');
  return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};
 });
 state.stage='submission-started';state.submissionStartedAt=new Date().toISOString();await write(file,state);
 await page.mouse.click(point.x,point.y); // One native input only; never retry an uncertain submission.
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

function publishedMetadataDiagnostics(recipe,latest) {
 const payload=latest.payload||{};
 const topics=Array.isArray(latest.topics)&&latest.topics.length?latest.topics:(payload.ugc_topics||latest.topics||[]);
 const formPolicy=flow.publicationPolicy(recipe);
 const rawPresent=Object.prototype.hasOwnProperty.call(payload,'user_marked_aigc');
 const labelPresent=Object.prototype.hasOwnProperty.call(payload,'aigc_label');
 const raw=payload.user_marked_aigc;
 // Observed CMS representation of an unmarked non-AI publication. Do not
 // coerce null/missing values generally, and never rewrite the raw response.
 const observedNonAI=formPolicy.containsAI===false&&rawPresent&&raw===null&&labelPresent&&payload.aigc_label===0;
 const effective=rawPresent&&typeof raw==='boolean'?raw:observedNonAI?false:null;
 const basis=rawPresent&&typeof raw==='boolean'?'explicit-boolean':observedNonAI?'observed-null-with-aigc-label-zero':'unrecognized-or-missing-disclosure';
 return {topicVerified:Array.isArray(topics)&&topics.some(t=>t.name===recipe.topic),
  aiDisclosureVerified:effective===formPolicy.containsAI,formPolicy,
  aiDisclosure:{expected:formPolicy.containsAI,raw_present:rawPresent,raw:rawPresent?raw:null,
   aigc_label_present:labelPresent,aigc_label_raw:labelPresent?payload.aigc_label:null,effective,basis}};
}
function validatePublishedMetadata(recipe,latest) {
 const diagnostics=publishedMetadataDiagnostics(recipe,latest);
 if(!diagnostics.topicVerified||!diagnostics.aiDisclosureVerified)throw Error('Published topic or AI disclosure does not match the recipe provenance');
 return diagnostics;
}
function observedPublicationUrl(value) {
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string')throw Error('Invalid observed publication content_url');
 let url;try{url=new URL(value);}catch(error){throw Error('Invalid observed publication content_url');}
 if(url.protocol!=='https:'||url.username||url.password)throw Error('Untrusted observed publication content_url host');
 // The observed CMS content_url is a JSON data resource, not a user-facing
 // publication page. Retain it as evidence only; never navigate to or link it.
 if(url.host==='gd-cms.dancf.com'&&/^\/gd-cms\/[A-Za-z0-9_-]+\/\d+\/[A-Za-z0-9_-]+\.json$/.test(url.pathname)&&!url.search&&!url.hash)return null;
 if(!['www.gaoding.com','gaoding.com'].includes(url.host))throw Error('Untrusted observed publication content_url host or resource path');
 return value;
}
module.exports.validatePublishedMetadata=validatePublishedMetadata;

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
 state.managementStatus=card.status;state.managementObservedAt=new Date().toISOString();
 state.managementUrl='https://www.gaoding.com/my/publish';
 if(state.stage==='verified'&&state.verifiedAt)state.previousVerifiedAt=state.verifiedAt;
 delete state.verifiedAt;
 await page.screenshot({path:path.join(out,'publication-verified.png')});
 await write(file,state);
 // Open the real copyright entry (发布列表卡片右下角「…」→「版权认证」), then inspect the responses it triggers.
 await page.cdp('Network.enable');await page.events();
 await copyrightFlow.openPanel(page,{description:recipe.description});
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
 const latest=versions?.[0]||{content_id:content.id,version_no:null,status_name:card.status,payload:content};
 const payload=latest.payload||{},observedAt=new Date().toISOString(),source=versions?.length?'versions':'content';
 if(latest.content_id===undefined||latest.content_id===null)throw Error('Publication metadata lacks the observed CMS content ID');
 const priorCMS=[state.contentId,state.metadataObserved?.content_id].filter(id=>id!==undefined&&id!==null);
 if(priorCMS.some(id=>String(id)!==String(latest.content_id))){
  const evidenceFile='publication-metadata-conflict-'+crypto.randomUUID()+'.json';
  const error='Observed CMS content ID differs from the persisted publication identity; inspect before continuing';
  await write(path.join(out,evidenceFile),{observedAt,source,versions:versions??null,content:content??null,latest,designUrl:state.designUrl||null,persistedContentIds:priorCMS});
  state.metadataConflict={expected_content_id:state.contentId??state.metadataObserved?.content_id,observed_content_id:latest.content_id,designUrl:state.designUrl||null,observedAt,evidenceFile};
  state.topicVerified=false;state.aiDisclosureVerified=false;
  state.stage='metadata-verification-failed';state.metadataVerification={passed:false,pending:false,observedAt,error};
  // Keep canonical contentId, metadataObserved and its evidence untouched so
  // recovery still targets the already-published work, never a new CMS item.
  await write(file,state);throw Error(error);
 }
 // Preserve the real CMS/editor identity and raw response before any policy
 // assertion can fail. CMS IDs are not editor design IDs or guessed URLs.
 state.contentId=latest.content_id;state.contentVersion=latest.version_no;state.versionStatus=latest.status_name;
 state.metadataObserved={content_id:latest.content_id,designUrl:state.designUrl||null,source,observedAt,evidenceFile:'publication-metadata.json',
  user_marked_aigc_present:Object.prototype.hasOwnProperty.call(payload,'user_marked_aigc'),
  user_marked_aigc_raw:Object.prototype.hasOwnProperty.call(payload,'user_marked_aigc')?payload.user_marked_aigc:null,
  aigc_label_present:Object.prototype.hasOwnProperty.call(payload,'aigc_label'),aigc_label_raw:Object.prototype.hasOwnProperty.call(payload,'aigc_label')?payload.aigc_label:null,
  ugc_topics:payload.ugc_topics||null,topics:payload.topics||latest.topics||null,content_url_raw:payload.content_url??null};
 state.topicVerified=false;state.aiDisclosureVerified=false;
 state.metadataVerification={passed:false,pending:true,observedAt};
 if(state.stage==='verified')state.stage='published-metadata-observed';
 delete state.publishedUrl;delete state.publishedUrlSource;
 await write(path.join(out,'publication-metadata.json'),{observedAt,source,versions:versions??null,content:content??null,latest});
 await write(file,state);
 try {
  Object.assign(state,publishedMetadataDiagnostics(recipe,latest));
  await write(file,state); // Diagnostics, including raw null/effective value, survive rejection.
  const publishedUrl=observedPublicationUrl(payload.content_url);
  state.metadataObserved.content_url_kind=publishedUrl?'page':payload.content_url?'cms-data-json':'missing';
  state.metadataObserved.content_url_navigation_allowed=!!publishedUrl;
  Object.assign(state,validatePublishedMetadata(recipe,latest));
  if(publishedUrl){state.publishedUrl=publishedUrl;state.publishedUrlSource='payload.content_url';}
  state.metadataVerification={passed:true,pending:false,observedAt};
  if(state.published===true)state.stage='published';
 }catch(error){
  state.stage='metadata-verification-failed';state.metadataVerification={passed:false,pending:false,observedAt,error:error.message};
  await write(file,state);throw error;
 }
 await write(file,state);
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
 else {state.stage='verified';state.published=true;state.verifiedAt=new Date().toISOString();}
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
 const formPolicy=flow.publicationPolicy(recipe);
 await flow.requirePublicationForm(page,recipe.topic,formPolicy);
 const history=path.join(out,'publication-before-material-fix.json');if(!await exists(history))await write(history,old);
 await page.screenshot({path:path.join(out,'publication-form-v2.png')});
 const state={...old,stage:'form-ready',formPolicy,materialRepair:true,designUrl:await page.url()};await write(file,state);return state;
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
