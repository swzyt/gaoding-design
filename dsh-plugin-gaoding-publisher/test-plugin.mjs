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
test('self-discovery and selected topics are exact; no account fallback',async()=>{
 const info=await get('gaoding_topics').execute();assert.equal(info.topics.length,5);assert.ok(existsSync(info.workflowGuide));assert.ok(info.guide.includes('版权'));assert.equal(info.dataRoot,join(tmp,'data'));
 const selected=await get('gaoding_subscribe').execute({topics:['tour','tour','concert'],space:17,repositoryId:'test-repository'});
 assert.equal(selected.job.jobs.length,2);
 assert.deepEqual(selected.job.jobs[0].args.slice(2,4),['--topic','tour']);assert.ok(selected.job.jobs[1].args.includes('concert'));
 await assert.rejects(()=>get('gaoding_subscribe').execute({topics:['tour','unknown'],space:17,repositoryId:'r'}));
 await assert.rejects(()=>get('gaoding_subscribe').execute({topics:['tour'],space:17}));
 const again=await get('gaoding_subscribe').execute({topics:['tour'],space:17,repositoryId:'r'});assert.notEqual(again.job.id,selected.job.id);
});
test('host registration owns disposers',()=>{
 const registered=[];const disposers=[];apply({effect(fn){disposers.push(fn());},tools:{register(tool){registered.push(tool.name);return ()=>registered.pop();}}});
 assert.equal(registered.length,3);disposers.reverse().forEach(fn=>fn());assert.equal(registered.length,0);
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
printf '{"status":"waiting_agent","gate":"%s/gates/review"}' "$r" > "$r/run.json"
printf '{"token":"test-token","instructions":"Inspect test evidence"}' > "$r/gates/review/request.json"
for (( i=0; i<200; i++ )); do
 if [[ -f "$r/gates/review/response.json" ]]; then printf '{"status":"complete"}' > "$r/run.json"; exit 0; fi
 sleep 0.05
done
exit 2
`);
 const saved=process.env.GAODING_WORKSPACE;process.env.GAODING_WORKSPACE=fake;
 const host=await import('./runtime-host.js?gate-test');
 if(saved===undefined)delete process.env.GAODING_WORKSPACE;else process.env.GAODING_WORKSPACE=saved;
 const args=['auto',run,'--watch'];const first=host.launch(args);assert.ok(first.started);
 let s;const until=Date.now()+8000;
 try{
  do{s=host.status(run);if(s.gate)break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<until);
  assert.equal(s.run.status,'waiting_agent');assert.equal(s.gate.token,'test-token');assert.ok(s.running);
  const again=host.launch(args);assert.equal(again.process.id,s.process.id);assert.ok(again.running);
 }finally{writeFileSync(join(run,'gates/review/response.json'),'{"passed":true}');}
 do{s=host.status(run);if(s.process.finishedAt)break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<until);
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
test('header button opens the topic panel through a document.body portal',async()=>{
 const hooks=[];let cursor=0;let rerender=()=>{};
 const React={
  Fragment:Symbol('react.fragment'),
  useState(initial){
   const index=cursor++;
   if(!(index in hooks))hooks[index]=typeof initial==='function'?initial():initial;
   return [hooks[index],(next)=>{hooks[index]=typeof next==='function'?next(hooks[index]):next;rerender();}];
  },
  createElement(type,props,...children){return {type,props:{...(props??{}),children:children.flat()}};}
 };
 const portals=[];
 const ReactDOM={createPortal(node,container){const portal={node,container};portals.push(portal);return portal;}};
 const document={body:{tag:'body'}};
 let registration;
 global.window={__ModuleLoader__:{load(value){registration=value;}}};
 global.document=document;
 await import('./client.js?portal-test');
 assert.equal(registration.id,'dsh-plugin-gaoding-publisher');
 const exported=registration.factory((spec)=>{
  if(spec==='react')return React;
  if(spec==='react-dom')return ReactDOM;
  throw Error('unexpected require '+spec);
 });
 const registered=[];let injected;
 const ctx={effect(fn){fn();},slots:{inject(key,cb){injected=key;cb();},register(spec,component){registered.push({spec,component});return ()=>{};}}};
 exported.apply(ctx);
 assert.equal(injected,'conversation.session.header.actions');
 assert.equal(registered.length,1);
 const {spec,component}=registered[0];
 assert.equal(spec.name,'conversation.session.header.actions');
 const render=()=>{cursor=0;return component({});};
 let tree=render();
 assert.equal(tree.type,React.Fragment);
 const button=tree.props.children[0];
 assert.deepEqual(button.props.children,['投稿']);
 assert.equal(tree.props.children[1],null,'panel stays closed until the button is clicked');
 rerender=()=>{tree=render();};
 button.props.onClick();
 assert.equal(portals.length,1,'overlay must mount through react-dom createPortal');
 assert.equal(portals[0].container,document.body,'overlay must mount in document.body, above the app layers');
 const overlay=tree.props.children[1];
 assert.equal(overlay.container,document.body);
 assert.ok(JSON.stringify(overlay.node).includes('选择要投稿的话题'),'overlay must contain the topic checklist');
 delete global.window;delete global.document;
});

test('client panel uses only theme tokens that exist in DSH',()=>{
 const source=readFileSync(new URL('./client.js',import.meta.url),'utf8');
 const tokens=[...new Set(source.match(/--dsw-alias-[a-z0-9-]+/g)??[])];
 const known=new Set([
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l2',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary'
 ]);
 assert.deepEqual(tokens.filter((token)=>!known.has(token)),[],'client.js references a theme token this DSH version does not define');
});
