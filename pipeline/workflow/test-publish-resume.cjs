const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {submit}=require('./publish');
test('observed publication resumes without browser clicks; unknown submission stays blocked',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'publication resume '));
 try{
  const out=path.join(dir,'release');await fs.mkdir(path.join(out,'layer-audit'),{recursive:true});
  const recipe=path.join(dir,'recipe.json');const values={spec:'{}',bindings:'{}',recipe:JSON.stringify({layer_audit:{pairs:[{subject:'person',background:'stage'}]}})};
  for(const [key,file] of Object.entries({spec:path.join(out,'spec.json'),bindings:path.join(out,'bound-assets.json'),recipe}))await fs.writeFile(file,values[key]);
  await fs.writeFile(path.join(out,'layer-audit/audit.json'),JSON.stringify({status:'complete',restoredAfterReload:true,fingerprint:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,crypto.createHash('sha256').update(v).digest('hex')]))}));
  const page=new Proxy({},{get(){throw Error('Must not interact with browser');}});
  const state={stage:'published',published:true,publishedAt:'preserve'};
  await fs.writeFile(path.join(out,'publication.json'),JSON.stringify(state));assert.deepEqual(await submit(page,recipe),state);
  await fs.writeFile(path.join(out,'publication.json'),JSON.stringify({stage:'submission-started',published:false}));await assert.rejects(()=>submit(page,recipe),/Refusing duplicate/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
