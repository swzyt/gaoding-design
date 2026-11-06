// Offline workflow checks plus explicit dependency bootstrap; no generation, browser or publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const archive=resolve(process.argv[2]||'');assert.ok(archive.endsWith('.tgz'),'Pass the packed tgz');
const temp=realpathSync(mkdtempSync(join(tmpdir(),'gaoding installed package ')));
try{
 const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
 assert.ok(entries.every(f=>!/(^|\/)(node_modules|\.venv|archive|build|research-cache|\.env)(\/|$)/.test(f)));
 assert.ok(entries.every(f=>!(/(?:\.png|\.jpg|\.zip|\.psd|\.task|\.log)$/.test(f))));
 execFileSync('tar',['-xzf',archive,'-C',temp]);
 const pkg=join(temp,'package');const runtime=join(pkg,'runtime');
 const manifest=JSON.parse(readFileSync(join(runtime,'manifest.json'),'utf8'));
 for(const [file,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(join(runtime,file))).digest('hex'),hash,file);
 for(const file of entries.filter(f=>/\.(?:js|mjs|py|sh|md|json)$/.test(f)&&!f.endsWith('package-lock.json'))){
  const content=readFileSync(join(temp,file),'utf8');assert.ok(!content.includes('/Users/suwei/'),file+' contains machine path');assert.ok(!content.includes('151281445'),file+' contains account ID');
 }
 process.env.GAODING_DATA_DIR=join(temp,'user data');delete process.env.GAODING_WORKSPACE;delete process.env.GAODING_RUNTIME_HOME;
 const host=await import(pathToFileURL(join(pkg,'runtime-host.js')).href);assert.equal(host.workspace,runtime);
 const plugin=await import(pathToFileURL(join(pkg,'index.js')).href);
 const info=await plugin.tools[0].execute();assert.ok(info.workflowGuide.startsWith(runtime));assert.equal(info.topics.length,5);
 // Resolve all CommonJS modules through the packed package's own scope.
 for(const file of ['publish.js','copyright.js','layer_audit.js','bind_assets.js'])await import(pathToFileURL(join(runtime,'pipeline/workflow',file)).href);
 const env=host.environment;
 for(const cmd of ['bootstrap','doctor','--help']){
  execFileSync('/bin/bash',[host.workflow,cmd],{env,cwd:temp,timeout:120000,stdio:'pipe'});
 }
 const launched=await plugin.tools.find(t=>t.name==='gaoding_workflow').execute({args:['doctor']});
 let state;const end=Date.now()+30000;
 do{state=host.status(launched.directory);if(state.process?.finishedAt)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);
 assert.equal(state.process.exitCode,0,state.log);
 assert.ok(!existsSync(join(runtime,'pipeline/.venv')));assert.ok(!existsSync(join(runtime,'pipeline/workflow/node_modules')));
 const result={package:archive,files:entries.length,runtimeFiles:Object.keys(manifest.files).length,checks:['packed hashes','no historical media or machine paths','isolated runtime discovery','CommonJS module imports','fresh writable dependency bootstrap','doctor and CLI help','background command completion','read-only package directory respected'],passed:true};
 console.log(JSON.stringify(result,null,2));
 writeFileSync(archive+'.verification.json',JSON.stringify(result,null,2)+'\n');
}finally{rmSync(temp,{recursive:true,force:true});}
