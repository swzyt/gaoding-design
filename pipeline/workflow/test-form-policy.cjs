const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const flow = require('../publish_flow');
const fonts = require('./fonts');
const {prepare,submit,verify,validatePublishedMetadata} = require('./publish');
const copyrightFlow = require('./copyright');

const original = {topic_kind:'topic', layers:[
  {type:'shape',name:'Panel',copyright_category:'original'},
  {type:'text',name:'Title',gd_font:'思源黑体 特粗'},
]};

function fontEditor({nativeClickApplies=true,previewUpdates=true,cloudSaved=true,losesFontOnReopen=false,reopenDialog=null,dismissRemoves=true}={}) {
  const events=[];
  const medium='https://st0.dancf.com/csc/157/fonts/227/medium.svg';
  const regular='https://st0.dancf.com/csc/157/fonts/229/regular.svg';
  let selected='206607',preview=regular,panel=false,pending=null,dialogState=null,pendingDismiss=false;
  const notice={
    get innerText(){return dialogState==='known'?'租户获取提醒\n当前租户信息获取出错，已自动进入最近一次登录的租户「:」。\n切换租户\n我知道了':'租户获取提醒\n未知租户操作要求\n切换租户\n我知道了';},
    getBoundingClientRect(){return {x:0,y:0,width:500,height:400};},
    querySelectorAll(){return [
      {innerText:'切换租户',getBoundingClientRect(){return {x:10,y:300,width:80,height:30};}},
      {innerText:'我知道了',getBoundingClientRect(){return {x:200,y:300,width:80,height:30};}},
    ];},
  };
  const labels=['常规','粗体','极细','特粗','纤细','中等','中细'];
  const options=labels.map((weight,index)=>{
    const id=weight==='中等'?'206606':weight==='常规'?'206607':String(300000+index);
    const image=weight==='中等'?medium:weight==='常规'?regular:'https://example.test/font/'+id+'.svg';
    return {innerText:'思源黑体 '+weight,
      getAttribute(name){return name==='data-font-id'?id:name==='data-bg-img'?image:null;},
      closest(){return {classList:{contains(name){return name==='checked'&&selected===id;}}};},
      click(){throw Error('DOM click must not be used to apply fonts');},
    };
  });
  const document={
    querySelector(selector){
      if(selector==='.dui-panel-title-block__back-icon__button')return panel?{}:null;
      if(selector==='.dui-text-edit-name-v2 img')return {getAttribute:()=>preview};
      if(selector==='input[placeholder="请输入文件名"]'||selector==='.layer-item__item__element-name')return {};
      if(selector==='[aria-label="cloud-save-success"]')return cloudSaved?{}:null;
      const id=selector.match(/data-font-id="(\d+)"/)?.[1];
      return options.find(option=>option.getAttribute('data-font-id')===id)||null;
    },
    querySelectorAll(selector){
      if(selector==='[role="dialog"], dialog')return dialogState?[notice]:[];
      if(selector==='.dbu-font-panel__list__item__text')return options;
      if(selector==='.layer-item__item__element-name')return [{innerText:'Title'}];
      return [];
    },
  };
  const evaluate=(fn,arg)=>vm.runInNewContext(`(${fn.toString()})`,{document})(arg);
  const url='https://www.gaoding.com/editor/design?id=38523285990143122';
  const page={
    async evaluate(fn,arg){return evaluate(fn,arg);},
    async waitForFunction(fn,arg){
      if(fn.toString().includes('cloud-save-success'))events.push(['cloud-save',cloudSaved]);
      if(pendingDismiss&&fn.toString().includes('[role="dialog"]')){if(dismissRemoves)dialogState=null;pendingDismiss=false;events.push(['dialog-removal-wait',!dialogState]);}
      if(pending&&fn.toString().includes("classList.contains('checked')")){
        selected=pending;pending=null;
        if(previewUpdates)preview=options.find(o=>o.getAttribute('data-font-id')===selected).getAttribute('data-bg-img');
      }
      if(!evaluate(fn,arg))throw Error('Observed-state wait timed out');
    },
    async waitForSelector(){},async fill(){},
    async click(selector){
      if(dialogState)throw Error('Dialog intercepts native clicks');
      events.push(['click',selector]);
      if(selector==='.dui-text-edit-name-v2')panel=true;
      else if(selector==='.dui-panel-title-block__back-icon__button')panel=false;
      else if(selector.includes('[data-font-id=')){
        if(nativeClickApplies)pending=selector.match(/data-font-id="(\d+)"/)[1];
      }
    },
    mouse:{async click(x,y){events.push(['mouse.click',x,y]);assert.deepEqual([x,y],[240,315],'only acknowledge may be clicked');pendingDismiss=true;}},
    async goto(target){events.push(['goto',target]);panel=false;dialogState=reopenDialog;if(losesFontOnReopen){selected='206607';preview=regular;}},
    async url(){return url;},async screenshot(){},keyboard:{async press(){}},
  };
  return {page,events,medium,url};
}

function publicationEditor({candidateId='dynamic-763',chipNames=[],duplicateCandidates=false,unknownCandidate=false,ai=true,aiClickApplies=true,selectionApplies=true,frameCount=1,initialSearch=false,filename=null,duplicateNodeResults=false,hiddenCandidate=false,fuzzyCandidates=0,submitShowsSuccess=true,submitDisabled=false,onSubmit=()=>{}}={}){
  const topic='小红书大字封面',events=[];let search=initialSearch,typed=initialSearch?'#'+topic:'',description='',pendingAI=null,published=false;
  const rect=(x,y,width,height)=>({x,y,width,height});
  const chips=chipNames.map(text=>({textContent:text,getAttribute(name){return name==='data-topic-id'?candidateId:name==='contenteditable'?'false':null;}}));
  const ce={get textContent(){return chips.map(c=>c.textContent).join('')+typed+description;},querySelectorAll(){return chips;},focus(){search=false;doc.activeElement=ce;}};
  const topicButton={innerText:'话题',getBoundingClientRect:()=>rect(10,20,80,30),click(){throw Error('Use native topic input');}};
  const activity={innerText:'其它活动 参与活动',click(){throw Error('Ordinary topics must never join an activity');}};
  const toggle={innerText:'含AI生成内容',getAttribute:()=>String(ai),getBoundingClientRect:()=>rect(10,200,40,20),click(){throw Error('Use native switch input');}};
  const publishButton={innerText:'发布',disabled:submitDisabled,getAttribute:()=>null,getBoundingClientRect:()=>rect(10,300,80,30),click(){throw Error('Final submission must use native input');}};
  const titleSpan={textContent:unknownCandidate?'其它话题':topic,children:[]};
  // Actual shape: wrapper span(svg + leaf title span), followed by work-count span.
  // Wrapper and leaf both have the same textContent, but belong to one button.
  const spans=[{textContent:titleSpan.textContent,children:[{tagName:'svg'},titleSpan]},titleSpan,{textContent:'1422作品',children:[]}];
  const candidate={getAttribute:()=>candidateId,querySelectorAll:()=>spans,getBoundingClientRect:()=>rect(10,100,352,40),click(){throw Error('Use native candidate input');}};
  const fuzzy=Array.from({length:fuzzyCandidates},(_,i)=>({
    ...candidate,getAttribute:()=>String(37788208493223031n+BigInt(i)),
    querySelectorAll:()=>[{textContent:i===0?'小红书自媒体博主大字封面':i===1?'小红书大字报封面':'相关但不同的话题'+i,children:[]}],
  }));
  const candidates=()=>{
    if(!search||typed.length<=1)return [];
    return [candidate,...(duplicateCandidates?[{...candidate,getAttribute:()=>candidateId+'-second'}]:[]),
      ...(duplicateNodeResults?[candidate]:[]),...(hiddenCandidate?[{...candidate,getBoundingClientRect:()=>rect(0,0,0,0)}]:[]),...fuzzy];
  };
  const doc={activeElement:null,body:{get innerText(){return published?'发布成功':'尚未发布';}},
    querySelector(selector){if(selector.startsWith('[contenteditable="true"]'))return ce;if(selector.includes('含AI生成内容'))return toggle;return null;},
    querySelectorAll(selector){
      if(selector==='button[data-topic-candidate-id]')return candidates();
      if(selector==='[contenteditable="true"] [data-topic-id]')return chips;
      if(selector==='button[aria-label="含AI生成内容"][role="switch"]')return [toggle];
      if(selector==='button'||selector==='[role="button"], button')return [topicButton,activity,toggle,publishButton];
      return [];
    },createRange:()=>({selectNodeContents(){},collapse(){}}),
  };
  const frame={contentDocument:doc,getBoundingClientRect:()=>rect(30,40,800,700),contentWindow:{getSelection:()=>({removeAllRanges(){},addRange(){}})}};
  const document={querySelector:selector=>selector==='input[placeholder="请输入文件名"]'&&filename!==null?{value:filename,getBoundingClientRect:()=>rect(500,0,200,30)}:null,querySelectorAll:()=>Array.from({length:frameCount},()=>frame)};
  const evaluate=(fn,arg)=>vm.runInNewContext(`(${fn.toString()})`,{document})(arg);
  const page={
    async evaluate(fn,arg){return evaluate(fn,arg);},
    async waitForFunction(fn,arg){if(pendingAI!==null&&fn.toString().includes('String(expected)')){ai=pendingAI;pendingAI=null;}if(!evaluate(fn,arg))throw Error('Observed form state timed out');},
    async click(selector){if(frameCount)throw Error('Existing iframe blocks header; must reuse the form');assert.equal(selector,'.dub-publish-button');events.push(['open-form']);},
    mouse:{async click(x,y){
      events.push(['mouse.click',x,y]);
      if(x===80&&y===75){search=true;typed='#';doc.activeElement=ce;}
      else if(x===216&&y===160){if(selectionApplies){chips.push({textContent:topic,getAttribute(name){return name==='data-topic-id'?candidateId:name==='contenteditable'?'false':null;}});search=false;typed='';}}
      else if(x===60&&y===250){if(aiClickApplies)pendingAI=!ai;}
      else if(x===80&&y===355){await onSubmit();published=submitShowsSuccess;}
      else throw Error('Unexpected native form click '+x+','+y);
    }},
    keyboard:{async type(text){events.push(['type',text]);if(search)typed+=text;else description+=text;}},
    async screenshot(){},
  };
  return {page,events,topic,policy:flow.publicationPolicy({...original,topic:'小红书大字封面'})};
}

test('ordinary program art is not AI and does not enroll in activities', () => {
  assert.deepEqual(flow.publicationPolicy(original), {topicKind:'topic',containsAI:false,categories:['original']});
  assert.equal(flow.publicationPolicy({layers:[{type:'text'}]}).containsAI,false);
  assert.equal(flow.publicationPolicy({layers:original.layers}).topicKind,'activity');
  assert.equal(flow.publicationPolicy({...original,layers:[...original.layers,{type:'image',copyright_category:'original_ai'}]}).containsAI,true);
});

test('unknown material provenance fails; legacy callers must state AI disclosure explicitly', () => {
  for (const value of [
    {layers:[{type:'image',name:'Unknown'}]},
    {layers:[{type:'shape',copyright_category:'stock'}]},
    {layers:[{type:'vector',copyright_category:'original'}]},
    {...original,topic_kind:'other'},
    {evidence:['proof.png']},
    {containsAI:'false'},
  ]) assert.throws(() => flow.publicationPolicy(value));
  assert.deepEqual(flow.publicationPolicy({containsAI:true}), {topicKind:'activity',containsAI:true,categories:null});
  assert.deepEqual(flow.publicationPolicy({containsAI:false,topic_kind:'topic'}), {topicKind:'topic',containsAI:false,categories:null});
  // A legacy override cannot hide a real AI material or an unknown category.
  assert.equal(flow.publicationPolicy({...original,containsAI:true}).containsAI,false);
  assert.throws(() => flow.publicationPolicy({containsAI:false,layers:[{type:'image'}]}));
});

test('legacy copyright cannot silently classify unknown or mixed provenance as AI',async()=>{
  const page=new Proxy({},{get(){throw Error('Must reject provenance before browser interaction');}});
  await assert.rejects(()=>flow.copyright(page,()=>{},[]),/explicit material source category/);
  await assert.rejects(()=>flow.run({containsAI:false,evidence:['proof.png']}),/one explicit source category/);
  await assert.rejects(()=>flow.run({recipe:{layers:[{type:'shape',copyright_category:'original'},{type:'image',copyright_category:'original_ai'}]},evidence:['proof.png']}),/mixed materials/);
});

test('publication metadata must preserve false AI disclosure and the selected topic', () => {
  const recipe = {...original,topic:'小红书大字封面'};
  const published = {payload:{ugc_topics:[{id:'actual-topic-id',name:recipe.topic}],user_marked_aigc:false}};
  assert.equal(validatePublishedMetadata(recipe,published).aiDisclosureVerified,true);
  assert.throws(() => validatePublishedMetadata(recipe,{payload:{...published.payload,user_marked_aigc:true}}),/provenance/);
  assert.throws(() => validatePublishedMetadata(recipe,{payload:{ugc_topics:published.payload.ugc_topics}}),/provenance/);
  assert.throws(() => validatePublishedMetadata(recipe,{payload:{user_marked_aigc:false,ugc_topics:[{name:'其它话题'}]}}),/provenance/);
  const aiRecipe = {...recipe,layers:[{type:'image',copyright_category:'original_ai'}]};
  assert.equal(validatePublishedMetadata(aiRecipe,{payload:{...published.payload,user_marked_aigc:true}}).aiDisclosureVerified,true);
  assert.throws(() => validatePublishedMetadata(aiRecipe,published),/provenance/);
});

test('only the observed own null plus numeric zero label represents effective non-AI',()=>{
  const recipe={...original,topic:'小红书大字封面'};
  const payload={id:202307918,topics:[],ugc_topics:[{id:'50',name:recipe.topic,activity_ids:[]}],user_marked_aigc:null,aigc_label:0};
  const result=validatePublishedMetadata(recipe,{topics:[],payload});
  assert.equal(result.aiDisclosure.raw_present,true);assert.equal(result.aiDisclosure.raw,null);
  assert.equal(result.aiDisclosure.effective,false);assert.equal(result.aiDisclosure.basis,'observed-null-with-aigc-label-zero');
  assert.equal(payload.user_marked_aigc,null,'the raw API value must not be rewritten');
  for(const bad of [
    {...payload,aigc_label:1},{...payload,aigc_label:'0'},
    Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='user_marked_aigc')),
    Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='aigc_label')),
    Object.assign(Object.create({user_marked_aigc:null}),{ugc_topics:payload.ugc_topics,aigc_label:0}),
  ])assert.throws(()=>validatePublishedMetadata(recipe,{payload:bad}),/provenance/);
  assert.throws(()=>validatePublishedMetadata({...recipe,layers:[{type:'image',copyright_category:'original_ai'}]},{payload}),/provenance/);
});

test('font candidates preserve family and weight; unavailable fonts never select the first option', async () => {
  assert(fonts.matches('思源黑体 Heavy','思源黑体 特粗'));
  assert(!fonts.matches('思源黑体 Heavy','思源黑体 粗体'));
  assert(!fonts.matches('思源黑体 Heavy','其它黑体 Heavy'));
  assert.throws(() => fonts.candidatesFor(undefined),/explicit gd_font/);
  const clicks = [];
  const options = [{innerText:'其它黑体 Heavy',click(){clicks.push('wrong font');}}];
  const document = {querySelector:()=>null, querySelectorAll:()=>options};
  const evaluate = (fn,arg) => vm.runInNewContext(`(${fn.toString()})`,{document})(arg);
  const page = {
    async evaluate(fn,arg){return evaluate(fn,arg);},
    async click(value){clicks.push(value);},
    async fill(){}, async waitForSelector(){},
    async waitForFunction(fn,arg){if(!evaluate(fn,arg))throw Error('No matching font');},
  };
  await assert.rejects(() => fonts.apply(page,[['Title','思源黑体 Heavy']]),/No matching font/);
  await assert.rejects(() => flow.applyFonts(page,()=>{},[['Title','思源黑体 Heavy']]),/No matching font/);
  assert(!clicks.includes('wrong font'));
  const untouched = new Proxy({},{get(){throw Error('Must validate font request before UI mutation');}});
  await assert.rejects(() => fonts.apply(untouched,[['Title',undefined]]),/explicit gd_font/);
});

test('observed Source Han weights select Medium as 中等 without changing family or weight', async () => {
  const {page,events,medium}=fontEditor();
  const applied = await fonts.apply(page,[['Title','思源黑体 Medium']]);
  assert.equal(applied[0].font,'思源黑体 中等');
  assert.equal(applied[0].font_id,'206606');
  assert.equal(applied[0].font_preview_url,medium);
  assert.equal(applied[0].checked_verified,true);
  assert.equal(applied[0].preview_verified,true);
  assert.equal(applied[0].persistence_verified,false);
  assert.deepEqual(events.filter(e=>e[1].includes('[data-font-id=')),[
    ['click','.dbu-font-panel__list__item__text[data-font-id="206606"]'],
  ]);
  assert(fonts.matches('思源黑体 中等','思源黑体 Medium'));
  assert(fonts.matches('思源黑体 Regular','思源黑体 常规'));
  assert(fonts.matches('思源黑体 常规','思源黑体 Regular'));
  assert(fonts.matches('思源黑体 Bold','思源黑体 粗体'));
  assert(fonts.matches('思源黑体 ExtraLight','思源黑体 极细'));
  assert(fonts.matches('思源黑体 Light','思源黑体 纤细'));
  assert(fonts.matches('思源黑体 Normal','思源黑体 中细'));
  assert(!fonts.matches('思源黑体 Medium','思源黑体 常规'));
  assert(!fonts.matches('思源黑体 Medium','思源黑体 粗体'));
  assert(!fonts.matches('思源黑体 Medium','思源宋体 中等'));
  assert(!fonts.matches('思源黑体 Thin','思源黑体 极细'));
});

test('font checkpoints require checked state and matching toolbar preview, never an attempted click', async () => {
  for(const options of [{nativeClickApplies:false},{previewUpdates:false}]){
    const {page}=fontEditor(options);const checkpoints=[];
    await assert.rejects(()=>fonts.apply(page,[['Title','思源黑体 Medium']],rows=>checkpoints.push(rows)),/wait timed out/);
    assert.equal(checkpoints.length,0);
  }
  const {page,events}=fontEditor();
  await assert.rejects(()=>fonts.apply(page,[['Title','思源黑体 Medium']],()=>{throw Error('False verification');},{verifyOnly:true,persistenceVerified:true}),/Saved font does not match/);
  assert.equal(events.filter(e=>e[1].includes('[data-font-id=')).length,0);
  await fonts.apply(page,[['Title','思源黑体 Medium']]);
  const verified=await fonts.apply(page,[['Title','思源黑体 Medium']],()=>{},{verifyOnly:true,persistenceVerified:true});
  assert(fonts.verifiedRecord(verified[0],'思源黑体 Medium'));
  assert.equal(events.filter(e=>e[1].includes('[data-font-id=')).length,1,'a live checked face needs no second click');
  assert(!fonts.verifiedRecord({layer:'Title',font:'思源黑体 Medium'},'思源黑体 Medium'),'old JSON is not verified evidence');
});

async function withImportedWork(callback){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'font-resume-'));
  assert.equal(path.dirname(root),os.tmpdir());
  try{
    const out=path.join(root,'release');await fs.mkdir(out);
    const recipe={canvas:{w:400,h:300},layers:[{id:'title',name:'Title',type:'text',gd_font:'思源黑体 Medium'}]};
    const recipePath=path.join(root,'recipe.json');await fs.writeFile(recipePath,JSON.stringify(recipe));
    await fs.writeFile(path.join(out,'spec.json'),JSON.stringify({canvas:recipe.canvas,layers:recipe.layers}));
    const {url}=fontEditor();
    await fs.writeFile(path.join(out,'editor-state.json'),JSON.stringify({stage:'ready-for-visual-review',url,importedPages:['main']}));
    await fs.writeFile(path.join(out,'font-verification.json'),JSON.stringify(Array.from({length:13},()=>({layer:'Title',font:'思源黑体 Medium'}))));
    await callback({recipePath,out});
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

test('prepare rechecks stale receipts and verifies the saved font after reopening without reimporting', async()=>{
  await withImportedWork(async({recipePath,out})=>{
    const {page,events}=fontEditor();
    const state=await prepare(page,recipePath);
    assert.equal(state.stage,'ready-for-visual-review');
    assert.deepEqual(state.importedPages,['main']);
    const receipt=JSON.parse(await fs.readFile(path.join(out,'font-verification.json'),'utf8'));
    assert.equal(receipt.length,1);
    assert(fonts.verifiedRecord(receipt[0],'思源黑体 Medium'));
    assert.equal(events.filter(e=>e[0]==='click'&&e[1].includes('[data-font-id=')).length,1);
    assert.equal(events.filter(e=>e[0]==='goto').length,1);
    assert(events.findIndex(e=>e[0]==='cloud-save')<events.findIndex(e=>e[0]==='goto'));
  });
});

test('save timeout or font loss on reopen never creates persisted font success',async()=>{
  for(const options of [{cloudSaved:false},{losesFontOnReopen:true}]){
    await withImportedWork(async({recipePath,out})=>{
      const {page,events}=fontEditor(options);
      await assert.rejects(()=>prepare(page,recipePath),/wait timed out|Saved font does not match/);
      const receipt=JSON.parse(await fs.readFile(path.join(out,'font-verification.json'),'utf8'));
      assert(!receipt.some(row=>row.persistence_verified===true));
      const state=JSON.parse(await fs.readFile(path.join(out,'editor-state.json'),'utf8'));
      assert.notEqual(state.stage,'ready-for-visual-review');
      assert.equal(events.filter(e=>e[0]==='click'&&e[1].includes('[data-font-id=')).length,1,'persistence verification must not silently repair a lost font');
      if(options.cloudSaved===false)assert(!events.some(e=>e[0]==='goto'));
    });
  }
});

test('reopen acknowledges only the observed tenant notice, waits for removal, then verifies fonts',async()=>{
  await withImportedWork(async({recipePath,out})=>{
    const {page,events}=fontEditor({reopenDialog:'known'});
    const state=await prepare(page,recipePath);
    assert.equal(state.stage,'ready-for-visual-review');
    assert.deepEqual(events.filter(e=>e[0]==='mouse.click'),[['mouse.click',240,315]]);
    assert(events.some(e=>e[0]==='dialog-removal-wait'&&e[1]===true));
    const receipt=JSON.parse(await fs.readFile(path.join(out,'font-verification.json'),'utf8'));
    assert.equal(receipt.length,1);
    assert(fonts.verifiedRecord(receipt[0],'思源黑体 Medium'));
  });
});

test('unknown or uncleared dialogs fail closed; acknowledgement never substitutes for font verification',async()=>{
  for(const options of [{reopenDialog:'unknown'},{reopenDialog:'known',dismissRemoves:false},{reopenDialog:'known',losesFontOnReopen:true}]){
    await withImportedWork(async({recipePath,out})=>{
      const {page,events}=fontEditor(options);
      await assert.rejects(()=>prepare(page,recipePath),/Unknown editor dialog|wait timed out|Saved font does not match/);
      if(options.reopenDialog==='unknown')assert(!events.some(e=>e[0]==='mouse.click'));
      const receipt=JSON.parse(await fs.readFile(path.join(out,'font-verification.json'),'utf8'));
      assert(!receipt.some(row=>row.persistence_verified===true));
      const state=JSON.parse(await fs.readFile(path.join(out,'editor-state.json'),'utf8'));
      assert.notEqual(state.stage,'ready-for-visual-review');
    });
  }
});

test('ordinary form uses native search and a dynamic candidate ID, without activity enrollment or submission',async()=>{
  const {page,events,topic,policy}=publicationEditor();
  const result=await flow.publish(page,()=>{},{recipe:{...original,topic},topic,title:'本地原创',desc:'原创程序图形',prepareOnly:true});
  assert.equal(result,true);
  const state=await flow.requirePublicationForm(page,topic,policy);
  assert.equal(state.chips[0].id,'dynamic-763');
  assert.equal(state.ai,'false');
  assert.equal(state.activity,false);
  assert.deepEqual(events.filter(e=>e[0]==='mouse.click'),[
    ['mouse.click',80,75],['mouse.click',216,160],['mouse.click',60,250],
  ],'native coordinates must include iframe offsets');
  assert(events.some(e=>e[0]==='type'&&e[1]===topic));
  assert(state.description.includes('原创程序图形'));
  const count=events.length;
  assert.equal(await flow.chooseOrdinaryTopic(page,topic),'dynamic-763');
  await flow.setAIDisclosure(page,false);
  assert.equal(events.length,count,'existing exact chip and false AI state need no mutation');
});

test('eighteen visible fuzzy buttons with one exact nested title are a valid unique match',async()=>{
  const {page,events,topic}=publicationEditor({fuzzyCandidates:17});
  assert.equal(await flow.chooseOrdinaryTopic(page,topic),'dynamic-763');
  assert.deepEqual(events.filter(e=>e[0]==='mouse.click'),[['mouse.click',80,75],['mouse.click',216,160]]);
});

test('retry reuses an open form and its exact pending candidate without touching the header or query',async()=>{
  const {page,events,topic,policy}=publicationEditor({initialSearch:true,filename:'本地原创',fuzzyCandidates:17,ai:false});
  const opts={recipe:{...original,topic},topic,title:'本地原创',desc:'原创程序图形',prepareOnly:true};
  assert.equal(await flow.publish(page,()=>{},opts),true);
  await flow.requirePublicationForm(page,topic,policy);
  assert.deepEqual(events.filter(e=>e[0]==='mouse.click'),[['mouse.click',216,160]]);
  assert(!events.some(e=>e[0]==='open-form'));
  assert(!events.some(e=>e[0]==='type'&&e[1]===topic),'search token/query must not be inserted again');
  const count=events.length;
  assert.equal(await flow.publish(page,()=>{},opts),true);
  assert.equal(events.length,count,'completed form, filename and description are idempotent too');
});

test('candidate nodes are deduplicated but two distinct exact-title buttons remain ambiguous',async()=>{
  const sameNode=publicationEditor({initialSearch:true,duplicateNodeResults:true,hiddenCandidate:true});
  assert.equal(await flow.chooseOrdinaryTopic(sameNode.page,sameNode.topic),'dynamic-763');
  const twoButtons=publicationEditor({initialSearch:true,duplicateCandidates:true});
  await assert.rejects(()=>flow.chooseOrdinaryTopic(twoButtons.page,twoButtons.topic),/Ambiguous/);
  assert(!twoButtons.events.some(e=>e[0]==='mouse.click'));
  const wrongTitle=publicationEditor({initialSearch:true,filename:'另一个作品'});
  await assert.rejects(()=>flow.publish(wrongTitle.page,()=>{},{recipe:original,topic:wrongTitle.topic,title:'本地原创',desc:'描述',prepareOnly:true}),/different filename/);
  assert.equal(wrongTitle.events.length,0);
});

test('unknown or multiple topic candidates and mismatched chips fail without activity clicks',async()=>{
  for(const options of [{duplicateCandidates:true},{unknownCandidate:true},{selectionApplies:false},{chipNames:['其它话题']},{chipNames:['小红书大字封面','小红书大字封面']},{frameCount:2}]){
    const {page,topic}=publicationEditor(options);
    await assert.rejects(()=>flow.chooseOrdinaryTopic(page,topic),/Ambiguous|timed out|Existing topic chip|visible publication form/);
  }
});

test('AI disclosure changes in both directions and requires the observed asynchronous result',async()=>{
  for(const target of [true,false]){
    const {page,events,topic}=publicationEditor({ai:!target,chipNames:['小红书大字封面']});
    await flow.setAIDisclosure(page,target);
    await flow.requirePublicationForm(page,topic,{topicKind:'topic',containsAI:target});
    assert.equal(events.filter(e=>e[0]==='mouse.click').length,1);
  }
  const {page,topic}=publicationEditor({ai:true,aiClickApplies:false,chipNames:['小红书大字封面']});
  await assert.rejects(()=>flow.setAIDisclosure(page,false),/timed out/);
  await assert.rejects(()=>flow.requirePublicationForm(page,topic,{topicKind:'topic',containsAI:false}),/recipe policy/);
  const activity=publicationEditor({ai:true,chipNames:['小红书大字封面']});
  await assert.rejects(()=>flow.requirePublicationForm(activity.page,activity.topic,{topicKind:'activity',containsAI:true}),/recipe policy/,'legacy activity policy must still require actual enrollment');
});

async function withSubmitReady(callback){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-submit-'));
  assert.equal(path.dirname(root),os.tmpdir());
  try{
    const out=path.join(root,'release');await fs.mkdir(path.join(out,'layer-audit'),{recursive:true});
    const recipe={...original,topic:'小红书大字封面',layers:[...original.layers,{type:'shape',name:'Background',copyright_category:'original'}],layer_audit:{pairs:[{subject:'Panel',background:'Background'}]}};
    const recipePath=path.join(root,'recipe.json'),file=path.join(out,'publication.json');
    const values={recipe:JSON.stringify(recipe),spec:JSON.stringify({canvas:{w:400,h:300},layers:recipe.layers}),bindings:'{}'};
    for(const [key,target] of Object.entries({recipe:recipePath,spec:path.join(out,'spec.json'),bindings:path.join(out,'bound-assets.json')}))await fs.writeFile(target,values[key]);
    await fs.writeFile(path.join(out,'layer-audit/audit.json'),JSON.stringify({status:'complete',restoredAfterReload:true,fingerprint:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,crypto.createHash('sha256').update(value).digest('hex')]))}));
    await fs.writeFile(file,JSON.stringify({stage:'form-ready',published:false,formPolicy:flow.publicationPolicy(recipe)}));
    await callback({recipePath,file});
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

async function withObservedMetadata(overrides,callback){
  await withSubmitReady(async({recipePath,file})=>{
    const out=path.dirname(file),designUrl='https://www.gaoding.com/editor/design?id=38523285990143122';
    const content={id:202307918,ugc_topics:[{id:'50',name:'小红书大字封面',activity_ids:[]}],topics:[],user_marked_aigc:null,aigc_label:0,content_url:'https://www.gaoding.com/design/fixture-content',...overrides};
    await fs.writeFile(file,JSON.stringify({stage:'published',published:true,designUrl,publishedUrl:'https://www.gaoding.com/editor/design?id=202307918&mode=ugc_version_update'}));
    let reads=0;
    const page={
      async goto(url){assert.equal(url,'https://www.gaoding.com/my/publish');},
      async waitForFunction(){},async evaluate(){return {status:'审核中'};},async screenshot(){},
      async events(){return reads++===0?[]:[
        {method:'Network.responseReceived',params:{requestId:'versions',response:{url:'https://www.gaoding.com/api/gaoding-art/v1/contents/'+content.id+'/versions'}}},
        {method:'Network.responseReceived',params:{requestId:'content',response:{url:'https://www.gaoding.com/api/gaoding-art/v1/contents/'+content.id}}},
      ];},
      async cdp(method,params={}){if(method==='Network.enable')return {};assert.equal(method,'Network.getResponseBody');return {body:JSON.stringify(params.requestId==='versions'?[]:content)};},
    };
    const originalOpen=copyrightFlow.openPanel;copyrightFlow.openPanel=async()=>{};
    try{await callback({recipePath,file,out,page,designUrl,content});}finally{copyrightFlow.openPanel=originalOpen;}
  });
}

test('content fallback preserves raw null, CMS/editor identities and the actual observed URL',async()=>{
  await withObservedMetadata({},async({recipePath,file,out,page,designUrl,content})=>{
    const state=await verify(page,recipePath,{openOnly:true});
    assert.equal(state.contentId,202307918);assert.equal(state.designUrl,designUrl);
    assert.equal(state.published,true);assert.notEqual(state.stage,'verified');assert.equal(state.verifiedAt,undefined);
    assert.equal(state.metadataObserved.content_id,202307918);assert.equal(state.metadataObserved.designUrl,designUrl);
    assert.equal(state.metadataObserved.user_marked_aigc_raw,null);assert.equal(state.aiDisclosure.effective,false);
    assert.equal(state.metadataVerification.passed,true);assert.equal(state.publishedUrl,content.content_url);
    assert.equal(state.publishedUrlSource,'payload.content_url');
    const evidence=JSON.parse(await fs.readFile(path.join(out,'publication-metadata.json'),'utf8'));
    assert.deepEqual(evidence.versions,[]);assert.equal(evidence.source,'content');
    assert.equal(evidence.content.user_marked_aigc,null);assert.equal(evidence.latest.content_id,202307918);
    assert.equal(evidence.latest.payload.aigc_label,0);
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).publishedUrl,content.content_url);
  });
});

test('policy rejection still durably records CMS identity and raw diagnostics without marking verified or resubmitting',async()=>{
  await withObservedMetadata({aigc_label:1},async({recipePath,file,out,page,designUrl})=>{
    await assert.rejects(()=>verify(page,recipePath,{openOnly:true}),/provenance/);
    const state=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(state.contentId,202307918);assert.equal(state.designUrl,designUrl);
    assert.equal(state.published,true);assert.equal(state.stage,'metadata-verification-failed');assert.equal(state.verifiedAt,undefined);
    assert.equal(state.metadataObserved.content_id,202307918);assert.equal(state.metadataVerification.passed,false);
    assert.equal(state.aiDisclosure.raw,null);assert.equal(state.aiDisclosure.aigc_label_raw,1);assert.equal(state.aiDisclosure.effective,null);
    assert.equal(state.publishedUrl,undefined);
    const evidence=JSON.parse(await fs.readFile(path.join(out,'publication-metadata.json'),'utf8'));
    assert.equal(evidence.content.user_marked_aigc,null);assert.equal(evidence.content.aigc_label,1);
    const untouched=new Proxy({},{get(){throw Error('Already published policy failure must not trigger browser submission');}});
    await assert.rejects(()=>submit(untouched,recipePath),/Refusing duplicate/);
  });
});

test('a later CMS ID conflict preserves the published identity and canonical recovery evidence',async()=>{
  await withObservedMetadata({},async({recipePath,file,out,page,content,designUrl})=>{
    const first=await verify(page,recipePath,{openOnly:true});
    const canonical=await fs.readFile(path.join(out,'publication-metadata.json'),'utf8');
    const observed=JSON.parse(JSON.stringify(first.metadataObserved));
    content.id=202307919;
    await assert.rejects(()=>verify(page,recipePath,{openOnly:true}),/CMS content ID differs/);
    const state=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(state.contentId,202307918);assert.equal(state.designUrl,designUrl);assert.equal(state.published,true);
    assert.equal(state.stage,'metadata-verification-failed');assert.equal(state.metadataVerification.passed,false);
    assert.deepEqual(state.metadataObserved,observed);
    assert.equal(await fs.readFile(path.join(out,'publication-metadata.json'),'utf8'),canonical);
    assert.equal(state.metadataConflict.expected_content_id,202307918);assert.equal(state.metadataConflict.observed_content_id,202307919);
    const conflict=JSON.parse(await fs.readFile(path.join(out,state.metadataConflict.evidenceFile),'utf8'));
    assert.equal(conflict.content.id,202307919);assert.equal(conflict.latest.content_id,202307919);
    assert.deepEqual(conflict.persistedContentIds,[202307918,202307918]);
    const untouched=new Proxy({},{get(){throw Error('Identity conflict must not trigger another submission');}});
    await assert.rejects(()=>submit(untouched,recipePath),/Refusing duplicate/);
  });
});

test('the observed dancf CMS JSON URL remains data evidence and does not block copyright verification',async()=>{
  const content_url='https://gd-cms.dancf.com/gd-cms/xi19e5/0/cd72c809-7eeb-4ae9-bb47-3710f95677b3217000.json';
  await withObservedMetadata({content_url},async({recipePath,page,out,designUrl})=>{
    const originalVerify=copyrightFlow.verify;let copyrightChecks=0;
    copyrightFlow.verify=async()=>{copyrightChecks++;return {verified:true};};
    try{
      const state=await verify(page,recipePath);
      assert.equal(copyrightChecks,1,'resource classification must continue into the copyright verifier');
      assert.equal(state.metadataVerification.passed,true);
      assert.equal(state.publishedUrl,undefined);assert.equal(state.publishedUrlSource,undefined);
      assert.equal(state.designUrl,designUrl);assert.equal(state.managementUrl,'https://www.gaoding.com/my/publish');
      assert.equal(state.metadataObserved.content_url_raw,content_url);
      assert.equal(state.metadataObserved.content_url_kind,'cms-data-json');
      assert.equal(state.metadataObserved.content_url_navigation_allowed,false);
      const evidence=JSON.parse(await fs.readFile(path.join(out,'publication-metadata.json'),'utf8'));
      assert.equal(evidence.content.content_url,content_url);
    }finally{copyrightFlow.verify=originalVerify;}
  });
});

test('published links require an observed allowed HTTPS host and never derive from the CMS ID',async()=>{
  for(const content_url of ['https://www.gaoding.com.evil.test/design','https://www.gaoding.com@evil.test/design','http://www.gaoding.com/design','https://www.gaoding.com:444/design','https://gd-cms.dancf.com/gd-cms/xi19e5/0/not-a-json.html','https://gd-cms.dancf.com.evil.test/gd-cms/xi19e5/0/data.json','http://gd-cms.dancf.com/gd-cms/xi19e5/0/data.json']){
    await withObservedMetadata({content_url},async({recipePath,file,page})=>{
      await assert.rejects(()=>verify(page,recipePath,{openOnly:true}),/content_url/);
      const state=JSON.parse(await fs.readFile(file,'utf8'));
      assert.equal(state.contentId,202307918);assert.equal(state.published,true);assert.equal(state.publishedUrl,undefined);
      assert.equal(state.metadataObserved.content_url_raw,content_url);
    });
  }
  await withObservedMetadata({content_url:undefined},async({recipePath,page})=>{
    const state=await verify(page,recipePath,{openOnly:true});
    assert.equal(state.publishedUrl,undefined);assert.equal(state.publishedUrlSource,undefined);
  });
});

test('final submit persists submission-started before one native iframe-offset click',async()=>{
  await withSubmitReady(async({recipePath,file})=>{
    let clicks=0;
    const {page,events}=publicationEditor({chipNames:['小红书大字封面'],ai:false,onSubmit:async()=>{
      const pending=JSON.parse(await fs.readFile(file,'utf8'));
      assert.equal(pending.stage,'submission-started');assert(pending.submissionStartedAt);assert.equal(pending.published,false);clicks++;
    }});
    const state=await submit(page,recipePath);
    assert.equal(state.stage,'published');assert.equal(state.published,true);assert.equal(clicks,1);
    assert.deepEqual(events.filter(e=>e[0]==='mouse.click'),[['mouse.click',80,355]]);
    const untouched=new Proxy({},{get(){throw Error('Already published must not interact with browser');}});
    assert.deepEqual(await submit(untouched,recipePath),state);
  });
});

test('native submit timeout remains uncertain and disabled buttons never mark submission-started',async()=>{
  await withSubmitReady(async({recipePath,file})=>{
    const {page,events}=publicationEditor({chipNames:['小红书大字封面'],ai:false,submitShowsSuccess:false});
    await assert.rejects(()=>submit(page,recipePath),/timed out/);
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).stage,'submission-started');
    await assert.rejects(()=>submit(page,recipePath),/Refusing duplicate/);
    assert.equal(events.filter(e=>e[0]==='mouse.click').length,1);
  });
  await withSubmitReady(async({recipePath,file})=>{
    const {page,events}=publicationEditor({chipNames:['小红书大字封面'],ai:false,submitDisabled:true});
    await assert.rejects(()=>submit(page,recipePath),/unavailable/);
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).stage,'form-ready');
    assert.equal(events.length,0);
  });
});

test('policy changes cannot submit a previously prepared form; uncertain submission remains blocked', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'form-policy-'));
  assert.equal(path.dirname(root),os.tmpdir()); // Verify exact cleanup target before deletion.
  try {
    const out = path.join(root,'release');
    await fs.mkdir(path.join(out,'layer-audit'),{recursive:true});
    const recipe = {...original,layer_audit:{pairs:[{subject:'Panel',background:'Background'}]}};
    const values = {recipe:JSON.stringify(recipe),spec:'{}',bindings:'{}'};
    const recipePath = path.join(root,'recipe.json');
    for (const [key,file] of Object.entries({recipe:recipePath,spec:path.join(out,'spec.json'),bindings:path.join(out,'bound-assets.json')})) await fs.writeFile(file,values[key]);
    const fingerprint = Object.fromEntries(Object.entries(values).map(([key,value])=>[key,crypto.createHash('sha256').update(value).digest('hex')]));
    await fs.writeFile(path.join(out,'layer-audit/audit.json'),JSON.stringify({status:'complete',restoredAfterReload:true,fingerprint}));
    const publication = path.join(out,'publication.json');
    const page = new Proxy({},{get(){throw Error('Must reject before touching browser');}});
    await fs.writeFile(publication,JSON.stringify({stage:'form-ready',formPolicy:{topicKind:'topic',containsAI:true,categories:['original_ai']}}));
    await assert.rejects(() => submit(page,recipePath),/provenance\/topic kind changed/);
    await fs.writeFile(publication,JSON.stringify({stage:'submission-started',published:false}));
    await assert.rejects(() => submit(page,recipePath),/Refusing duplicate/);
    const published = {stage:'published',published:true,publishedAt:'preserved'};
    await fs.writeFile(publication,JSON.stringify(published));
    assert.deepEqual(await submit(page,recipePath),published);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});
