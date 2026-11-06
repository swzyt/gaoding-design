const assert=require('node:assert/strict');const {transaction}=require('./layer_audit');
const plan={names:['subject','background','light'],pairs:[{subject:'subject',background:'background'}]};
async function run(failAt){let calls=0,once=false,state={subject:100,background:85,light:40},snapshots=[],saved;
 const op=()=>{if(++calls===failAt&&!once){once=true;throw Error('injected');}};
 const adapter={get:async n=>{op();return state[n];},set:async(n,v)=>{op();state[n]=v;},capture:async n=>{op();snapshots.push(n);},reload:async()=>{op();}};
 let journal={status:'new'};try{await transaction(adapter,journal,async j=>{saved=structuredClone(j);},plan);}catch{}
 if(saved?.status==='restore-failed')await transaction(adapter,saved,async j=>{},plan);
 assert.deepEqual(state,{subject:100,background:85,light:40});return {journal,snapshots};}
(async()=>{for(let i=1;i<=20;i++)await run(i);const ok=await run(-1);assert.equal(ok.journal.status,'complete');assert.equal(ok.journal.restoredAfterReload,true);
 let state={subject:0,background:85,light:40},sets=0;
 const journal={status:'testing',originals:{subject:100,background:85,light:40},pending:'subject'};
 await transaction({set:async(n,v)=>{sets++;state[n]=v},get:async n=>state[n],reload:async()=>{},capture:async()=>{}},journal,async()=>{},plan);
 assert.equal(journal.status,'recovered-needs-review');assert.equal(state.subject,100);assert.equal(sets,3);
 console.log('Passed: 20 failure injection points, non-100 original opacity, successful reload, interrupted-process recovery.');})();
(async()=>{const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');const {requireAudit}=require('./layer_audit');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'layer-audit-guard-'));
try{await fs.mkdir(path.join(dir,'layer-audit'));const recipe=path.join(dir,'recipe.json');const values={spec:'{}',bindings:'{}',recipe:JSON.stringify({layer_audit:plan})};const paths={spec:path.join(dir,'spec.json'),bindings:path.join(dir,'bound-assets.json'),recipe};for(const key of Object.keys(paths))await fs.writeFile(paths[key],values[key]);const journal={status:'complete',restoredAfterReload:true,fingerprint:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,crypto.createHash('sha256').update(v).digest('hex')]))};const save=()=>fs.writeFile(path.join(dir,'layer-audit/audit.json'),JSON.stringify(journal));await save();await requireAudit(dir,recipe);journal.pending='subject';await save();await assert.rejects(()=>requireAudit(dir,recipe));delete journal.pending;journal.restoredAfterReload=false;await save();await assert.rejects(()=>requireAudit(dir,recipe));journal.restoredAfterReload=true;await save();await fs.writeFile(paths.spec,'changed');await assert.rejects(()=>requireAudit(dir,recipe));console.log('Passed: submit guards reject pending, unverified restoration and stale spec.');}finally{await fs.rm(dir,{recursive:true,force:true});}})();
