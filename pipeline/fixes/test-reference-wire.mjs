import assert from 'node:assert/strict';
import {accessSync,constants,readFileSync,realpathSync} from 'node:fs';
import {join,dirname,delimiter} from 'node:path';
import {pathToFileURL} from 'node:url';
const executable=(process.env.PATH||'').split(delimiter).map(dir=>join(dir,'gd-cli')).find(file=>{
 try{accessSync(file,constants.X_OK);return true;}catch{return false;}
});
if(!executable)throw Error('gd-cli is not available on PATH');
let cliRoot=dirname(realpathSync(executable));
while(true){
 let pkg;try{pkg=JSON.parse(readFileSync(join(cliRoot,'package.json'),'utf8'));}catch{}
 if(pkg?.name==='@gaoding/cli')break;
 const parent=dirname(cliRoot);if(parent===cliRoot)throw Error('Cannot locate the package owning '+executable);cliRoot=parent;
}
const {createToolApiAdapter}=await import(pathToFileURL(join(cliRoot,'dist/src/features/tool/tool-api-adapter.js')).href);
const urls=['https://example.test/upload-a.png','https://example.test/upload-b.png'];
for (const wire of ['[]', [], 'invalid']) {
 let sent;
 const adapter=createToolApiAdapter({
  contentIdFactory:()=> '123',
  telemetry:{stage:(_name,fn)=>fn(),annotate:()=>{}},
  transport:{postJson:async req=>{
   if(req.path.endsWith('tool-intent')) return {name:'model',arguments:JSON.stringify({image_urls:wire,prompt:'derived'})};
   sent=req.body.params.arguments;
   return {result:{isError:false},task_id:'test'};
  }}
 });
 await adapter.submit({invocation:{kind:'intent',model:'model',prompt:[],parameters:{},optionalMediaParameters:['image_urls'],explicitArguments:{image_urls:urls,prompt:'original'}},access:{},signal:new AbortController().signal});
 assert.deepEqual(sent.image_urls,wire==='[]'?JSON.stringify(urls):urls);
 assert.equal(sent.prompt,'original');
}
console.log('Reference wire-type regression checks passed');
