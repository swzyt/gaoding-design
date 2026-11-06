// Durable visibility audit: only unpublished drafts; never submit a dirty audit.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
const write=async(p,v)=>{await fs.writeFile(p+'.tmp',JSON.stringify(v,null,2));await fs.rename(p+'.tmp',p);};
async function transaction(adapter,journal,save,plan){
 // A durable journal survives process termination, which JavaScript finally cannot.
 if(journal.status==='complete')return journal;
 async function restore(){
  journal.status='restoring';await save(journal);const failures=[];
  for(const [name,opacity] of Object.entries(journal.originals)){
   try{await adapter.set(name,opacity);}catch(e){failures.push(name+': '+e.message);}
  }
  if(failures.length)throw Error('Restore failed: '+failures.join('; '));
  await adapter.reload();
  for(const [name,opacity] of Object.entries(journal.originals))if(await adapter.get(name)!==opacity)throw Error('Reload mismatch: '+name);
  await adapter.capture('restored-after-reload.png');
  journal.restoredAfterReload=true;journal.status='restored';await save(journal);
 }
 if(journal.originals&&Object.keys(journal.originals).length&&journal.status!=='new'){
  await restore(); // Recovery never repeats a partially completed test silently.
  journal.status='recovered-needs-review';await save(journal);return journal;
 }
 journal.originals={};
 for(const name of plan.names){const value=await adapter.get(name);if(!(value>0&&value<=100))throw Error('Layer not visible before audit: '+name);journal.originals[name]=value;}
 journal.status='prepared';await save(journal);
 let failure;
 try{
  journal.status='testing';await save(journal);journal.evidence=[];
  for(let i=0;i<plan.pairs.length;i++){
   const pair=plan.pairs[i];
   for(const role of ['subject','background']){
    const name=pair[role],file=`pair-${i+1}-${role}-hidden.png`;
    // Pending is durable BEFORE every mutation.
    journal.pending=name;await save(journal);
    await adapter.set(name,0);await adapter.capture(file);
    await adapter.set(name,journal.originals[name]);
    journal.evidence.push({pair:i+1,role,hidden:name,file});delete journal.pending;await save(journal);
   }
  }
 }catch(e){failure=e;}
 finally{
  try{await restore();}catch(e){journal.status='restore-failed';journal.error=e.message;await save(journal);throw e;}
 }
 if(failure){journal.status='test-failed-restored';journal.error=failure.message;await save(journal);throw failure;}
 journal.status='complete';delete journal.pending;await save(journal);return journal;
}
const input='input[role="spinbutton"][aria-valuemax="100"]';
async function panel(page,names){
 await page.waitForFunction(()=>!!document.querySelector('input[placeholder="请输入文件名"]'),undefined,{timeout:60000});
 if(await page.evaluate(()=>!!document.querySelector('button[aria-label="打开本地图层管理"]')))await page.click('button[aria-label="打开本地图层管理"]');
 await page.evaluate(()=>{for(const e of document.querySelectorAll('.layer-item__item__expand-box [aria-label="arrow-right-triangle"]'))e.parentElement.click();});
 await page.waitForFunction(names=>names.every(n=>[...document.querySelectorAll('.layer-item__item__element-name')].some(e=>e.innerText.trim()===n)),names,{timeout:30000});
}
async function select(page,name){
 await page.evaluate(name=>{const found=[...document.querySelectorAll('.layer-item__item__element-name')].filter(e=>e.innerText.trim()===name);if(found.length!==1)throw Error('Layer name not unique: '+name);found[0].click();},name);
 await page.waitForFunction(name=>document.querySelector('.layer-item__item--active .layer-item__item__element-name')?.innerText.trim()===name,name);
 await page.waitForSelector(input,{timeout:15000});
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
}
async function audit(page,recipePath){
 const recipe=await read(recipePath),out=path.join(path.dirname(recipePath),recipe.output||'release'),dir=path.join(out,'layer-audit');await fs.mkdir(dir,{recursive:true});
 const plan=recipe.layer_audit;if(!plan?.pairs?.length)throw Error('Recipe requires semantic layer_audit.pairs');
 const names=recipe.layers.filter(x=>x.type!=='text').map(x=>x.name);
 for(const pair of plan.pairs)if(pair.subject===pair.background||![pair.subject,pair.background].every(n=>names.includes(n)))throw Error('Invalid layer pair');
 const url=await page.url();if(new URL(url).searchParams.get('mode')==='ugc_version_update')throw Error('Audit must not mutate published update editor');
 const pub=await read(path.join(out,'publication.json')).catch(()=>null);if(pub&&(pub.published||pub.stage==='submission-started'))throw Error('Audit requires unpublished draft');
 const fingerprint={spec:await hash(path.join(out,'spec.json')),bindings:await hash(path.join(out,'bound-assets.json')),recipe:await hash(recipePath)};
 const file=path.join(dir,'audit.json');let journal=await read(file).catch(()=>({status:'new',url,fingerprint,createdAt:new Date().toISOString()}));
 if(journal.url!==url||JSON.stringify(journal.fingerprint)!==JSON.stringify(fingerprint))throw Error('Audit input changed; inspect/recover previous journal before new audit');
 await panel(page,names);
 const adapter={
  get:async name=>{await select(page,name);return page.evaluate(s=>Number(document.querySelector(s).getAttribute('aria-valuenow')),input);},
  set:async(name,value)=>{await select(page,name);await page.fill(input,String(value));await page.keyboard.press('Tab');await page.waitForFunction(({s,value})=>Number(document.querySelector(s)?.getAttribute('aria-valuenow'))===value,{s:input,value});},
  capture:async name=>{await page.keyboard.press('Escape');await page.screenshot({path:path.join(dir,name)});},
  reload:async()=>{await page.waitForFunction(()=>!!document.querySelector('[aria-label="cloud-save-success"]'),undefined,{timeout:30000});await page.reload({timeout:60000});await panel(page,names);}
 };
 const result=await transaction(adapter,journal,v=>write(file,v),{names,pairs:plan.pairs});
 if(result.status!=='complete')throw Error('State recovered; review audit evidence before retry: '+file);
 return result;
}
async function requireAudit(out,recipePath){
 const recipe=await read(recipePath);if(!recipe.layer_audit)throw Error('Missing required layer audit plan');
 const a=await read(path.join(out,'layer-audit/audit.json'));
 if(a.status!=='complete'||!a.restoredAfterReload||a.pending)throw Error('Layer audit incomplete or recovery required');
 for(const [key,file] of Object.entries({spec:path.join(out,'spec.json'),bindings:path.join(out,'bound-assets.json'),recipe:recipePath}))if(a.fingerprint[key]!==await hash(file))throw Error('Stale layer audit: '+key);
 return a;
}
module.exports={audit,transaction,requireAudit};
