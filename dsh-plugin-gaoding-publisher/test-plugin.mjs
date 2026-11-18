import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp=mkdtempSync(join(tmpdir(),'gaoding plugin test '));
process.env.GAODING_DATA_DIR=join(tmp,'data');
const {tools,apply}=await import('./index.js');
const {launch,status}=await import('./runtime-host.js');
const get=name=>tools.find(t=>t.name===name);
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
test('self-discovery and dynamic selections persist exact topic snapshots without account fallback',async()=>{
 const snapshot={source:'https://creator.huaban.com/inspiration',checkedAt:new Date().toISOString(),complete:true,payload:{total:2,topics:[{id:'new-137',name:'全新话题',topic_link:'https://gdce.yuque.com/team/book/new'},{id:'new-138',name:'另一新话题',topic_link:'https://www.gaoding.com/topics/new'}]}};
 const info=await get('gaoding_topics').execute({snapshot,space:17});assert.equal(info.topics.length,2);assert.equal(info.space,17);assert.ok(existsSync(info.workflowGuide));assert.ok(info.guide.includes('版权'));assert.equal(info.dataRoot,join(tmp,'data'));
 const [first,second]=info.topics.map(t=>t.key);
 const selected=await get('gaoding_subscribe').execute({topics:[first,first,second],space:17,repositoryId:'test-repository'});
 assert.equal(selected.job.jobs.length,2);
 assert.deepEqual(selected.job.jobs[0].args.slice(2,4),['--topic',first]);assert.ok(selected.job.jobs[1].args.includes(second));
 const target=JSON.parse(readFileSync(selected.job.jobs[0].topicFile));assert.equal(target.name,'全新话题');assert.equal(target.hub,null);assert.equal(target.rules_url,'https://gdce.yuque.com/team/book/new');assert.equal(target.key,first);
 await assert.rejects(()=>get('gaoding_subscribe').execute({topics:[first,'unknown'],space:17,repositoryId:'r'}));
 const noRepository=await get('gaoding_subscribe').execute({topics:[first],space:17});assert.equal(noRepository.job.jobs[0].args.includes('--repository-id'),false);assert.ok(noRepository.job.jobs[0].args.includes('native'));assert.equal(noRepository.job.repositoryId,null);assert.deepEqual(JSON.parse(JSON.stringify(noRepository)),noRepository,'Tool output must be lossless JSON when optional repository is omitted');
 const again=await get('gaoding_subscribe').execute({topics:[first],space:17,repositoryId:'r'});assert.notEqual(again.job.id,selected.job.id);
});
test('host registration owns disposers',()=>{
 const registered=[];const disposers=[];const routes=[];let disposed=0;
 const ctx={effect(fn){disposers.push(fn());},tools:{register(tool){registered.push(tool.name);return ()=>registered.pop();}},webServer:{register(value){routes.push(value);return()=>{disposed++;};}},inject(_deps,fn){fn(ctx);}};
 apply(ctx);
 assert.deepEqual(routes.map(route=>route.path),['/gaoding-publisher/topics','/gaoding-publisher/specs','/gaoding-publisher/specs/refresh','/gaoding-publisher/session','/gaoding-publisher/session/probe','/gaoding-publisher/session/login','/gaoding-publisher/jobs','/gaoding-publisher/jobs/remove','/gaoding-publisher/pipeline/run','/gaoding-publisher/results','/gaoding-publisher/preview','/gaoding-publisher/prompts','/gaoding-publisher/prompts/confirm','/gaoding-publisher/prompts/generate','/gaoding-publisher/create/status','/gaoding-publisher/create/preview','/gaoding-publisher/create','/gaoding-publisher/published','/gaoding-publisher/health','/gaoding-publisher/publish/check','/gaoding-publisher/publish','/gaoding-publisher/publish/remove','/gaoding-publisher/publish/batch','/gaoding-publisher/publish/queue','/gaoding-publisher/publish/cancel','/gaoding-publisher/publish/run','/gaoding-publisher/publish/reconcile','/gaoding-publisher/publish/resolve-uncertain','/gaoding-publisher/publish/abandon','/gaoding-publisher/publish/republish','/gaoding-publisher/evidence/ai','/gaoding-publisher/image/test','/gaoding-publisher/preflight','/gaoding-publisher/docs/USAGE']);
 assert.ok(routes.every(route=>route.kind==='exact'&&typeof route.handler==='function'));
 assert.equal(registered.length,5);disposers.reverse().forEach(fn=>fn());assert.equal(registered.length,0);assert.equal(disposed,routes.length);
});
test('background command returns before gates and rejects uncertain duplicate',async()=>{
 // CLI help cannot generate or publish anything. It also tests paths with spaces.
 const launched=launch(['--help']);assert.ok(launched.started);
 const deadline=Date.now()+10000;let s;
 do {s=status(launched.directory);if(s.process?.finishedAt)break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<deadline);
 assert.ok(s.process.finishedAt); // Missing test dependencies is a reported child failure, not a stuck tool call.
 assert.ok(s.log.length>0);assert.ok(Number.isInteger(s.process.exitCode));
 const root=join(tmp,'uncertain run');mkdirSync(root);
 writeFileSync(join(root,'.plugin-process.json'),JSON.stringify({status:'launching',args:['auto',root]}));
 assert.throws(()=>launch(['auto',root]),/uncertain/);
 assert.ok(!existsSync(join(root,'.plugin-launch.lock')));
});
test('a live Agent gate can be answered while the background auto is running',async()=>{
 const fake=join(tmp,'fake runtime');mkdirSync(fake);const run=join(tmp,'gate run');
 writeFileSync(join(fake,'workflow.sh'),`#!/bin/bash
set -e
r="$2"
mkdir -p "$r/gates/review"
printf '{"status":"waiting_agent","gate":"%s/gates/review"}' "$r" > "$r/run.json.tmp" && mv "$r/run.json.tmp" "$r/run.json"
printf '{"token":"test-token","instructions":"Inspect test evidence"}' > "$r/gates/review/request.json"
for (( i=0; i<200; i++ )); do
 if [[ -f "$r/gates/review/response.json" ]]; then printf '{"status":"complete"}' > "$r/run.json.tmp" && mv "$r/run.json.tmp" "$r/run.json"; exit 0; fi
 sleep 0.05
done
exit 2
`);
 const saved=process.env.GAODING_WORKSPACE;process.env.GAODING_WORKSPACE=fake;
 const host=await import('./runtime-host.js?gate-test');
 if(saved===undefined)delete process.env.GAODING_WORKSPACE;else process.env.GAODING_WORKSPACE=saved;
 const args=['auto',run,'--watch'];const first=host.launch(args);assert.ok(first.started);
 let s;const until=Date.now()+8000;
 // 假工作流用 shell 写 run.json；极短窗口内可能读到半截文件，测试自身重试即可，生产读取仍保持严格。
 const safeStatus=()=>{try{return host.status(run);}catch(error){if(/JSON/.test(String(error)))return null;throw error;}};
 try{
  do{s=safeStatus();if(s?.gate)break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<until);
  assert.equal(s.run.status,'waiting_agent');assert.equal(s.gate.token,'test-token');assert.ok(s.running);
  const again=host.launch(args);assert.equal(again.process.id,s.process.id);assert.ok(again.running);
 }finally{writeFileSync(join(run,'gates/review/response.json'),'{"passed":true}');}
 do{s=safeStatus();if(s?.process?.finishedAt)break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<until);
 assert.equal(s.process.exitCode,0);assert.equal(s.run.status,'complete');assert.equal(s.running,false);
});
test('tool schemas are raw JSON Schema the host registry accepts',()=>{
 const scalarTypes=new Set(['string','number','integer','boolean','null']);
 const supported=new Set(['object','array',...scalarTypes]);
 const walk=(node,path)=>{
  if(node===null||typeof node!=='object')return;
  if(Array.isArray(node)){node.forEach((value,index)=>walk(value,`${path}[${index}]`));return;}
  if(Object.hasOwn(node,'type'))assert.ok(supported.has(node.type),`${path}.type "${String(node.type)}" is outside the supported JSON Schema subset`);
  if(Object.hasOwn(node,'required'))assert.ok(Array.isArray(node.required)&&node.required.every(key=>typeof key==='string'),`${path}.required must be a string array`);
  if(Object.hasOwn(node,'items'))assert.equal(node.type,'array',`${path}.items requires type "array"`);
  for(const [key,value] of Object.entries(node))walk(value,`${path}.${key}`);
 };
 for(const tool of tools){
  assert.equal(tool.parameters.type,'object',`${tool.name} parameters must be object-rooted`);
  assert.ok(tool.parameters.properties&&typeof tool.parameters.properties==='object',`${tool.name} parameters need a properties object`);
  assert.equal(tool.output.schema.type,'object',`${tool.name} output must be object-rooted`);
  walk(tool.parameters,`${tool.name}.parameters`);
  walk(tool.output.schema,`${tool.name}.output.schema`);
 }
});
test('sidebar entry registers the console panel and its main view',async()=>{
 const hooks=[];let cursor=0;let rerender=()=>{};
 const React={
  Fragment:Symbol('react.fragment'),
  useState(initial){
   const index=cursor++;
   if(!(index in hooks))hooks[index]=typeof initial==='function'?initial():initial;
   return [hooks[index],(next)=>{hooks[index]=typeof next==='function'?next(hooks[index]):next;rerender();}];
  },
  useRef(initial){const index=cursor++;if(!(index in hooks))hooks[index]={current:initial};return hooks[index];},
  useMemo(factory){cursor++;return factory();},
  useEffect(){},
  createElement(type,props,...children){return {type,props:{...(props??{}),children:children.flat()}};}
 };
 const document={body:{tag:'body'},baseURI:'http://localhost/nested/'};
 let registration;
 global.window={__ModuleLoader__:{load(value){registration=value;}}};
 global.document=document;
 await import('./client.js?panel-test');
 assert.equal(registration.id,'dsh-plugin-gaoding-publisher');
 const exported=registration.factory((spec)=>{
  if(spec==='react')return React;
  if(spec==='react-dom')return {createPortal(){}};
  throw Error('unexpected require '+spec);
 });
 const registered=[],injections=[];
 const ctx={effect(fn){fn();},slots:{inject(key,cb){injections.push(key);cb();},register(spec,component){registered.push({spec,component});return ()=>{};}}};
 exported.apply(ctx);
 assert.deepEqual(injections,['sidebar.panellist','main'],'the console belongs in the sidebar nav and the main column');
 const entry=registered.find(row=>row.spec.name==='sidebar.panellist');
 const page=registered.find(row=>row.spec.name==='main');
 assert.ok(entry&&page,'both the sidebar entry and the main panel must register');
 assert.equal(entry.spec.id,'gaoding-publisher');
 assert.equal(typeof entry.spec.order,'number');
 assert.equal(entry.spec.label(),'稿定投稿');
 assert.equal(page.spec.key,'gaoding-publisher','the sidebar id must address the main panel key');
 const icon=entry.component({size:18,active:false});
 assert.equal(icon.type,'svg');
 assert.equal(icon.props.width,18);
 const text=JSON.stringify(page.component({}));
 assert.ok(text.includes('稿定投稿控制台'),'main panel must render the console');
 assert.ok(text.includes('话题与规范'));
 assert.ok(text.includes('结果与投稿'));
 delete global.window;delete global.document;
});

test('the console exposes every requested tab, filter and backend choice', async () => {
 // 每个组件独立持有 hook 槽位，避免把函数组件当纯函数展开时互相污染。
 const stores=new Map();
 let current=null;
 const storeFor=fn=>{if(!stores.has(fn))stores.set(fn,{hooks:[],cursor:0});return stores.get(fn)};
 const invoke=(fn,props)=>{const prev=current;current=storeFor(fn);try{return fn(props)}finally{current=prev}};
 const React={
  Fragment:Symbol('react.fragment'),
  useState(initial){const st=current;const i=st.cursor++;if(!(i in st.hooks))st.hooks[i]=typeof initial==='function'?initial():initial;return [st.hooks[i],n=>{st.hooks[i]=typeof n==='function'?n(st.hooks[i]):n;rerender();}]},
  useRef(initial){const st=current;const i=st.cursor++;if(!(i in st.hooks))st.hooks[i]={current:initial};return st.hooks[i]},
  useMemo(f){current.cursor++;return f()},
  useEffect(){current.cursor++;},
  createElement(type,props,...children){return {type,props:{...(props??{}),children:children.flat()}};}
 };
 const document={body:{tag:'body'},baseURI:'http://localhost/nested/'};
 let registration;
 global.window={__ModuleLoader__:{load(v){registration=v}}};
 global.document=document;
 await import('./client.js?console-coverage');
 const exported=registration.factory(s => s==='react'?React:s==='react-dom'?{createPortal(){}}:null);
 const registered=[];
 exported.apply({effect:fn=>fn(),slots:{inject(k,cb){cb()},register(spec,component){registered.push({spec,component});return ()=>{}}}});
 const page=registered.find(row=>row.spec.name==='main').component;
 const nodes=r=>{
  if(!r||typeof r!=='object')return [];
  if(typeof r.type==='function')return nodes(invoke(r.type,{...r.props}));
  return [r,...(r.props?.children||[]).flatMap(nodes)];
 };
 const remount=()=>{for(const st of stores.values())st.cursor=0;};
 let tree;
 const render=()=>{remount();tree=invoke(page,{})};
 const rerender=()=>render();
 render();
 const texts=()=>JSON.stringify(nodes(tree));
 const buttons=()=>nodes(tree).filter(n=>n.type==='button');
 const click=label=>{
  const button=buttons().find(n=>String(n.props?.children?.[0])===label);
  assert.ok(button,'missing button: '+label);
  button.props.onClick();
 };
 for(const tab of ['话题与规范','创作','结果与投稿','已投稿'])assert.ok(texts().includes(tab),'missing tab '+tab);
 assert.ok(buttons().some(n=>String(n.props?.children?.[0])==='素材'),'missing 素材 filter button');
 assert.ok(buttons().some(n=>String(n.props?.children?.[0])==='模板'),'missing 模板 filter button');
 click('结果与投稿');
 assert.ok(texts().includes('按话题筛选'),'missing results topic filter');
 click('创作');
 assert.ok(texts().includes('执行模式'),'missing mode label');
 assert.ok(texts().includes('全自动'),'missing auto mode option');
 assert.ok(texts().includes('手动确认'),'missing manual mode option');
 assert.ok(texts().includes('出图后端'),'missing backend label');
 assert.ok(texts().includes('本机 GD CLI')&&texts().includes('交给 Agent'),'missing backend choices');
 click('已投稿');
 assert.ok(texts().includes('已投稿作品'),'published tab does not render');
 delete global.window;delete global.document;
});

test('client panel uses only theme tokens that exist in DSH',()=>{
 const source=readFileSync(new URL('./client.js',import.meta.url),'utf8');
 const tokens=[...new Set(source.match(/--dsw-alias-[a-z0-9-]+/g)??[])];
 // 来自 Client Theme Provider 的 listTokens 实际返回值，不要凭空添加。
 const known=new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill'
 ]);
 assert.deepEqual(tokens.filter((token)=>!known.has(token)),[],'client.js references a theme token this DSH version does not define');
});

test('auto mode delegates the whole creation-and-publish chain to the orchestrator', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function runAutoPipeline');
  const end = source.indexOf('// 创作执行：只有用户确认后才调用');
  const body = source.slice(start, end);
  assert.match(body, /executeAutoPipeline/);
  // 编排器必须拿到真实依赖，而不是空壳
  for (const dependency of ['checkRun', 'createPublishTask', 'runCreation', 'runPublish', 'listPublishTasks']) {
    assert.match(body, new RegExp(dependency));
  }
  assert.ok(!/ready-to-publish/.test(body), 'auto mode must not stop before publishing');
});

test('template runs require a frozen declaration plan and platform read-back verification', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function runTemplatePublish');
  const body = source.slice(start, start + 4000);
  assert.match(body, /preflightTemplateDeclaration\(\{ runDir: task\.runDir/);
  assert.match(body, /writeDeclarationPlan/);
  assert.match(body, /declare: submit/);
  assert.match(body, /result\.declaration\?\.verified !== true/);
  assert.match(body, /declare: false|declare: submit/);
});

test('republish requires an explicit force flag when the work is already declared', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /const force = body\.force === true;/);
  assert.match(source, /records\.length && !force/);
  assert.match(source, /force=true/);
});

test('job progress reflects real publish state instead of the stale creation queue', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /function unitProgressOf/, '必须有单元真实进度推导');
  assert.match(source, /function jobProgressOf/, '必须有任务级汇总');
  assert.match(source, /stage = 'published'/, '已投稿必须优先于其它状态');
  assert.match(source, /jobProgressOf\(units\)\.stage === 'published-all' \? 'complete'/, '全部投完时任务状态应为已完成');
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  assert.match(client, /unitStageText/, '面板要用真实单元状态文案');
  assert.match(client, /jobProgressText/, '面板要用任务级汇总文案');
});

test('prompt blocks start collapsed so the task list stays readable', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  assert.match(client, /const \[openPrompt, setOpenPrompt\] = React\.useState\(\{\}\)/, '默认全部收起');
  assert.match(client, /expanded \? '收起' : '查看 \/ 编辑'/, '要能展开/收起');
  assert.match(client, /WebkitLineClamp: 2/, '收起时只显示两行摘要');
  // 收起状态不能直接渲染完整 textarea
  assert.match(client, /expanded\s*\?\s*h\('textarea'/, 'textarea 只在展开时渲染');
});

test('waiting for assets is shown as a waiting state, and failures are deduped', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  assert.match(client, /waiting-assets': '等待出图素材'/, '任务级要有等待素材文案');
  assert.match(client, /待出图：/, '要列出待出图的素材 ID');
  assert.match(client, /new Set\(job\.creation\.failed/, '失败原因要按内容去重');
  const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(index, /waitingAssets \? 'waiting-assets'/, '等素材不应算「需要处理」');
});

test('the panel opens the bundled tutorial inside the plugin panel', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  assert.match(client, /使用教程/, '面板要有教程入口');
  assert.match(client, /api\.usageDoc\(/, '通过接口取教程内容');
  assert.match(client, /dangerouslySetInnerHTML/, '在弹层里渲染，不依赖新窗口');
});

test('the panel checks dependencies on entry and disables actions when blocked', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  assert.match(client, /runPreflight\(false\)/, '进入页面就要跑自检');
  assert.match(client, /环境自检通过/, '正常时给出通过提示');
  assert.match(client, /创作\/投稿已禁用/, '缺失必需依赖时要明确禁用');
  assert.match(client, /envBlocked/, '阻塞时按钮要跟着禁用');
  const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(index, /createPreflight\(/, '自检实现要接进 Host');
  assert.match(index, /'\/gaoding-publisher\/preflight'/, '要暴露自检路由');
});

test('the plugin can generate assets itself through the subscription credentials', async () => {
  const { readFileSync } = await import('node:fs');
  const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(index, /ctx\.inject\(\['credentials'\]/, '必须注入 credentials 才能复用订阅凭据');
  assert.match(index, /imageClient = createImageClient\(/, '要构造插件自己的出图客户端');
  assert.match(index, /fillAssetRequest\(/, '等素材时先尝试插件自己出图');
  assert.match(index, /selfGenerationError/, '自己出图失败要记录原因并回落交接');
  const client = readFileSync(new URL('./image-client.js', import.meta.url), 'utf8');
  assert.match(client, /CHATGPT_OAUTH_1/, '凭据键必须与 DSH 图像插件一致');
  assert.match(client, /codex\/images\/generations/, '请求地址必须是订阅出图接口');
});
