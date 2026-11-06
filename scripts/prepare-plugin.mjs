// Build a self-contained runtime from the one authoritative source tree.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest=join(root,'dsh-plugin-gaoding-publisher/runtime');
const files=['workflow.sh','pipeline/topics.json','pipeline/generate_masters.py','pipeline/publish_flow.js','pipeline/render_psd.sh','pipeline/fixes/test-reference-wire.mjs','pipeline/fixes/gd-cli-2.1.0-reference-array.patch','pipeline/fixes/README.md','tooling/spec_to_psd.js'];
for(const f of ['run.py','orchestrator.py','parallel.py','jobs.py','research_collect.js','research_cache.py','localize.py','assemble.py','register_assets.py','publish.js','copyright.js','bind_assets.js','fonts.js','layer_audit.js','receipts.py','shape_evidence.py','package_delivery.py','bootstrap.sh','package.json','package-lock.json','WORKFLOW.md']) files.push('pipeline/workflow/'+f);
rmSync(dest,{recursive:true,force:true});mkdirSync(dest,{recursive:true});
writeFileSync(join(dest,'package.json'),JSON.stringify({private:true,type:'commonjs'})+'\n');
const hashes={'package.json':createHash('sha256').update(readFileSync(join(dest,'package.json'))).digest('hex')};
for(const file of files.sort()){
 const target=join(dest,file);mkdirSync(dirname(target),{recursive:true});cpSync(join(root,file),target);
 hashes[file]=createHash('sha256').update(readFileSync(target)).digest('hex');
}
writeFileSync(join(dest,'manifest.json'),JSON.stringify({schema:1,files:hashes},null,2)+'\n');
console.log(`Prepared ${files.length} runtime files (no task data or installed dependencies).`);
