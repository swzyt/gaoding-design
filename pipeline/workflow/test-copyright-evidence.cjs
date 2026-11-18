const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {evidenceFiles}=require('./copyright.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('copyright requires reviewed original evidence with complete layer coverage',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'copyright-evidence-'));
 try{
  await fs.mkdir(path.join(dir,'release'));await fs.mkdir(path.join(dir,'evidence'));
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZxkAAAAASUVORK5CYII=','base64');
  await fs.writeFile(path.join(dir,'evidence/tool.png'),image);
  await fs.writeFile(path.join(dir,'release-recipe.json'),JSON.stringify({output:'release'}));
  const rows=[{id:'person',category:'original_ai'}],entry={path:'evidence/tool.png',sha256:hash(image),layers:['person']};
  async function save(record){const raw=JSON.stringify(record);await fs.writeFile(path.join(dir,'copyright-evidence.json'),raw);await fs.writeFile(path.join(dir,'release/material-review.json'),JSON.stringify({evidence_sha256:hash(raw)}));}
  await save({categories:{original_ai:[entry]}});
  assert.deepEqual(await evidenceFiles(path.join(dir,'release-recipe.json'),rows),{original_ai:[await fs.realpath(path.join(dir,'evidence/tool.png'))]});
  await save({categories:{original_ai:[{...entry,layers:[]}]}});
  await assert.rejects(()=>evidenceFiles(path.join(dir,'release-recipe.json'),rows),/lack real/);
  await fs.writeFile(path.join(dir,'release/receipts.png'),image);
  await save({categories:{original_ai:[{...entry,path:'release/receipts.png'}]}});
  await assert.rejects(()=>evidenceFiles(path.join(dir,'release-recipe.json'),rows),/generated provenance/);
  await save({categories:{original_ai:[entry]}});
  await fs.writeFile(path.join(dir,'evidence/tool.png'),Buffer.from('changed'));
  await assert.rejects(()=>evidenceFiles(path.join(dir,'release-recipe.json'),rows),/changed/);
 }finally{
  // This exact temporary directory was created by this test and contains only its fixtures.
  assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'copyright-evidence-')));await fs.rm(dir,{recursive:true,force:true});
 }
});
