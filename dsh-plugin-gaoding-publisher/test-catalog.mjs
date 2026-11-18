import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {normalizeCatalog, snapshotCatalog, catalogSource, loadCatalog, catalogIsFresh, selectableTopic, collectFromBrowser} from './topic-catalog.js';
const fixture={total:3,topics:[{id:'a',name:'话题A',topic_link:'https://gdce.yuque.com/team/book/rules',status:'已上架',type:'热门话题'},{id:'b',name:'话题B',topic_link:'https://www.gaoding.com/topics/example',status:'已上架'},{id:'c',name:'待补充入口',topic_link:null,status:'已上架'}]};
test('catalog keeps every named topic including rules-only and no-link entries',()=>{
 const c=normalizeCatalog(fixture);assert.equal(c.status,'complete');assert.equal(c.topics.length,3);
 assert.equal(c.topics[0].hub,null);assert.equal(c.topics[0].rules_url,fixture.topics[0].topic_link);assert.equal(c.topics[2].researchStatus,'needs-research');
 assert.equal(normalizeCatalog({...fixture,topics:[...fixture.topics].reverse()}).topics[2].key,c.topics[0].key);
 assert.equal(JSON.stringify(c).includes('creator_id'),false);
});
test('invalid rows and pagination cannot claim completeness',()=>{
 assert.equal(normalizeCatalog({topics:[{}]}).status,'partial');
 assert.equal(normalizeCatalog({topics:[],total:2}).status,'partial');
 assert.equal(normalizeCatalog({topics:[]}).status,'complete');
 assert.throws(()=>normalizeCatalog({message:'Please login'}),/no topics/);
 assert.throws(()=>snapshotCatalog({source:'https://evil.example',complete:true,checkedAt:new Date().toISOString(),topics:[]}),/requires/);
 assert.equal(snapshotCatalog({source:catalogSource,complete:false,checkedAt:new Date().toISOString(),topics:[]}).status,'partial');
});
test('freshness and availability never turn stale cache into live selectable data',async()=>{
 const cached={...normalizeCatalog(fixture),checkedAt:'2020-01-01T00:00:00Z'};
 assert.equal(catalogIsFresh(cached),false);
 const unavailable=await loadCatalog({read:()=>cached,write:()=>assert.fail(),fetcher:async()=>({ok:false,status:401}),browser:async()=>{throw Error('Browser unavailable');}});
 assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.stale,true);assert.deepEqual(unavailable.selectableTopics,[]);
 const live=await loadCatalog({read:()=>null,write:c=>assert.equal(c.status,'complete'),fetcher:async()=>({ok:false,status:401}),browser:async()=>({...normalizeCatalog(fixture),space:17})});
 assert.equal(live.space,17);assert.equal(live.selectableTopics.length,3);
});
test('topic kind separates material topics from templates',()=>{
 const c=normalizeCatalog({topics:[{id:'m',name:'素材题',topic_link:'https://gdce.yuque.com/t/b/mat12345',applicable_publish_type:2},{id:'t',name:'模板题',topic_link:'https://gdce.yuque.com/t/b/tpl12345',applicable_publish_type:0}]});
 assert.deepEqual(c.topics.map(t=>t.publishKind),['material','template']);
});

test('offline, future and expired topics are not selectable',()=>{
 const t=normalizeCatalog(fixture).topics[0];
 assert.equal(selectableTopic({...t,status:'已下架'}),false);
 assert.equal(selectableTopic({...t,onlineAt:Date.now()+600000}),false);
 assert.equal(selectableTopic({...t,offlineAt:Date.now()-1}),false);
});
test('DSH route reads shared catalog and subscription persists exact native target',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gaoding-catalog-'));
 process.env.GAODING_DATA_DIR=root;
 const {tools,apply}=await import('./index.js');
 try {
  const topicTool=tools.find(t=>t.name==='gaoding_topics');
  const c=await topicTool.execute({snapshot:{source:catalogSource,checkedAt:new Date().toISOString(),complete:true,payload:fixture}});
  const sub=await tools.find(t=>t.name==='gaoding_subscribe').execute({topics:[c.topics[0].key],space:17});
  const job=sub.job.jobs[0];assert.equal(job.args[job.args.indexOf('--mode')+1],'native');assert.equal(job.args.includes('--repository-id'),false);
  assert.deepEqual(JSON.parse(readFileSync(job.topicFile)).rules_url,fixture.topics[0].topic_link);
  assert.equal(job.args[job.args.indexOf('--topic-json')+1],job.topicFile);
  await assert.rejects(()=>tools.find(t=>t.name==='gaoding_subscribe').execute({topics:['../escape'],space:17}),/Unknown/);
  const routes=new Map();let disposed=0;
  apply({tools:{register:()=>()=>{}},effect:fn=>fn(),inject:(_deps,fn)=>fn({effect:fn=>{const dispose=fn();assert.equal(typeof dispose,'function');dispose();},webServer:{register:r=>{routes.set(r.path,r);return()=>{disposed++;};}}})});
  const route=routes.get('/gaoding-publisher/topics');
  assert.equal(route.kind,'exact');assert.ok(routes.has('/gaoding-publisher/specs'));assert.ok(routes.has('/gaoding-publisher/session'));assert.ok(routes.has('/gaoding-publisher/jobs'));assert.ok(routes.has('/gaoding-publisher/results'));assert.ok(routes.has('/gaoding-publisher/publish'));assert.ok(routes.has('/gaoding-publisher/prompts'));assert.equal(disposed,routes.size);
  let code,body;
  await route.handler({method:'GET',url:'/gaoding-publisher/topics'},{writeHead:c=>{code=c;},end:b=>{body=JSON.parse(b);}});
  assert.equal(code,200);assert.equal(body.topics.length,3);
  await route.handler({method:'POST'},{writeHead:c=>{code=c;},end:()=>{}});assert.equal(code,405);
 }finally{assert.ok(root.startsWith(join(tmpdir(),'gaoding-catalog-')));rmSync(root,{recursive:true,force:true});}
});
test('browser refresh is single flight and handles CLI stderr without starting a real browser',async()=>{
 let count=0,child;
 const spawnProcess=()=>{count++;child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};return child;};
 const first=collectFromBrowser({space:17,spawnProcess});
 const second=collectFromBrowser({space:17,spawnProcess});
 await assert.rejects(()=>collectFromBrowser({space:18,spawnProcess}),/Another target/);
 assert.equal(count,1);
 child.stderr.emit('data','GAODING_CATALOG:'+JSON.stringify({source:catalogSource,checkedAt:new Date().toISOString(),complete:true,payload:fixture,space:17})+'\n');child.emit('close',0);
 assert.equal((await first).topics.length,3);assert.equal((await second).space,17);
});
const require=createRequire(import.meta.url);
const {resolveTarget,collect}=require('../pipeline/workflow/research_collect.js');
test('research resolves rules to sample hub and refuses ambiguous hubs',async()=>{
 const pages=[];
 const page={goto:async u=>pages.push(u),waitForFunction:async()=>{},evaluate:async()=>[{name:'A',url:'https://www.gaoding.com/topics/a'}]};
 const target=await resolveTarget(page,{key:'a',name:'A',rules_url:'https://gdce.yuque.com/team/book/rules'});
 assert.equal(target.url,'https://www.gaoding.com/topics/a');assert.equal(pages.length,1);
 page.evaluate=async()=>[{name:'one',url:'https://www.gaoding.com/topics/a'},{name:'two',url:'https://www.gaoding.com/topics/b'}];
 await assert.rejects(()=>resolveTarget(page,{name:'A',rules_url:'https://gdce.yuque.com/team/book/rules'}),/unambiguous/);
 await assert.rejects(()=>resolveTarget(page,{name:'A',hub:'https://example.com/topics/a'}),/Gaoding/);
});

function mockResearchPage({clickTimeout=false,noProgress=false,conflict=false,ariaOnly=false,topicLabel='＃ 小红书 大字封面 '}={}){
 const hub='https://www.gaoding.com/topics/oRXqBCRuit6GmWiW',rules='https://gdce.yuque.com/gksiz6/drcay5/nw57rwx4u7g7touo';
 const state={url:'',clicks:0,page:1,visits:[],waits:[],scrolled:0,paginationScrolls:0};
 const ruleImage={src:'data:image/gif;base64,placeholder',currentSrc:'',alt:'完整规范图',complete:false,naturalWidth:0,naturalHeight:0,scrollIntoView(){state.scrolled++;this.src='https://images.example/rules.png';this.currentSrc=this.src;this.complete=true;this.naturalWidth=800;this.naturalHeight=1200;}};
 const image=i=>({src:'https://images.example/'+i+'.png',currentSrc:'',alt:'样例'+i,naturalWidth:800});
 const anchor=(name,url,img)=>({innerText:ariaOnly?'':name,href:url,getAttribute:key=>key==='aria-label'&&ariaOnly?name:null,querySelector:s=>s==='img'?img:null});
 const buttons=[1,2,3].map(i=>({getAttribute:()=>` TOP ${i} `,querySelector:()=>image('TOP'+i)}));
 const document={
  title:'话题详情 - 稿定',
  querySelectorAll(selector){
   if(selector==='.ne-viewer-body a[href]')return [];
   if(selector==='.ne-viewer-body img')return [ruleImage];
   if(selector==='a[href*="/topics/"]')return state.page===1?[anchor('其他话题','https://www.gaoding.com/topics/other')]:[anchor('其他话题','https://www.gaoding.com/topics/other'),anchor(topicLabel,hub)];
   if(selector==='button')return state.page===1?[{innerText:' 加载 更多 ',disabled:false,scrollIntoView(){state.paginationScrolls++;}}]:[];
   if(selector==='button[aria-label]')return buttons;
   if(selector==='a[href^="/posts/"] img')return Array.from({length:7},(_,i)=>image(i));
   if(selector==='a[href^="/posts/"]')return Array.from({length:7},(_,i)=>anchor('列表'+i,'https://www.gaoding.com/posts/'+i,image(i)));
   if(selector==='a[href*="yuque.com"]')return conflict?[anchor('规范','https://gdce.yuque.com/team/book/changed')]:[];
   throw Error('Unexpected selector '+selector);
  },
  querySelector(selector){
   if(selector==='.ne-viewer-body')return {innerText:'本轮实际规范正文'.repeat(30)};
   if(selector==='h1,h2')return {textContent:'小红书大字封面'};
   return this.querySelectorAll(selector)[0]||null;
  }
 };
 const invoke=(fn,arg)=>runInNewContext('('+fn.toString()+')',{document,location:{href:state.url}})(arg);
 const page={
  async goto(url){state.url=url;state.visits.push(url);},
  async evaluate(fn,arg){return invoke(fn,arg);},
  async waitForFunction(fn,arg){state.waits.push(fn.toString());if(!invoke(fn,arg))throw Error('mock wait timeout');},
  async click(){if(state.paginationScrolls<=state.clicks)throw Error('element is not visible in the viewport');state.clicks++;if(!noProgress)state.page=2;if(clickTimeout)throw Error('scroll receipt timeout after click');},
  async screenshot(){}
 };
 return {page,state,hub,rules};
}
test('rules without hub fall back to live explore and find exact normalized name on page two',async()=>{
 const {page,state,hub,rules}=mockResearchPage();
 const resolved=await resolveTarget(page,{key:'topic-50',name:'#小红书大字封面',rules_url:rules});
 assert.equal(resolved.hub,hub);assert.equal(resolved.rules_url,rules);assert.equal(state.clicks,1);
 assert.deepEqual(state.visits,[rules,'https://www.gaoding.com/explore/topics']);
});
test('offscreen pagination is scrolled before click and RISO aria labels match lowercase catalog',async()=>{
 const {page,state,hub}=mockResearchPage({ariaOnly:true,topicLabel:'# 复古RISO印刷风'});
 assert.equal((await resolveTarget(page,{name:'复古riso印刷风'})).hub,hub);
 assert.equal(state.paginationScrolls,1);assert.equal(state.clicks,1);
});
test('a successful pagination click with a timeout is reconciled without clicking again',async()=>{
 const {page,state,hub}=mockResearchPage({clickTimeout:true});
 assert.equal((await resolveTarget(page,{name:'小红书大字封面'})).hub,hub);assert.equal(state.clicks,1);
 const stalled=mockResearchPage({clickTimeout:true,noProgress:true});
 await assert.rejects(()=>resolveTarget(stalled.page,{name:'小红书大字封面'}),/no verified progress/);assert.equal(stalled.state.clicks,1);
});
test('collector uses frozen rules without a hub rules anchor, normalizes TOP labels and loads lazy rule images',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gaoding-research-'));
 try{
  const {page,state,hub,rules}=mockResearchPage();
  const result=await collect(page,root,[{key:'topic-50',name:'小红书大字封面',hub,rules_url:rules}]);
  assert.equal(result.samples,10);assert.equal(result.topic.key,'topic-50');
  const live=JSON.parse(readFileSync(join(root,'live.json')));
  assert.equal(live.rules_url,rules);assert.deepEqual(live.rules_links,[]);assert.equal(live.samples[0].rank,'TOP1');assert.equal(live.samples.length,10);
  assert.equal(live.rules_images[0].src,'https://images.example/rules.png');assert.equal(live.rules_images[0].width,800);assert.equal(state.scrolled,1);
  assert.deepEqual(state.visits,[hub,rules]);
 }finally{assert.ok(root.startsWith(join(tmpdir(),'gaoding-research-')));rmSync(root,{recursive:true,force:true});}
});
test('collector rejects observed rules conflicts before using an unrelated rules document',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gaoding-research-'));
 try{const {page,state,hub,rules}=mockResearchPage({conflict:true});await assert.rejects(()=>collect(page,root,[{name:'小红书大字封面',hub,rules_url:rules}]),/rules conflict/);assert.deepEqual(state.visits,[hub]);}
 finally{assert.ok(root.startsWith(join(tmpdir(),'gaoding-research-')));rmSync(root,{recursive:true,force:true});}
});
