const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const flow=require('../publish_flow'),copyright=require('./copyright');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const categories=['uncategorized','original','original_ai','gaoding','non_original'];
const panel=()=>Object.fromEntries(categories.map(c=>[c,{images:[],evidence:[]}]));
async function fixture(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gd-non-original-'));
 try{await fs.mkdir(path.join(dir,'release'));await fn(dir);}
 finally{assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('gd-non-original-'));await fs.rm(dir,{recursive:true,force:true});}
}

test('third-party photography retains non_original and accurate mixed AI disclosure',()=>{
 const photo={type:'image',copyright_category:'non_original'};
 for(const layers of [[photo],[photo,{type:'shape',copyright_category:'original'},{type:'text'}]]){
  const policy=flow.publicationPolicy({layers,containsAI:true});
  assert.equal(policy.containsAI,false);assert(policy.categories.includes('non_original'));
 }
 assert.equal(flow.publicationPolicy({containsAI:false,layers:[photo,{type:'image',copyright_category:'original_ai'}]}).containsAI,true);
 assert.throws(()=>flow.publicationPolicy({layers:[{...photo,copyright_category:'stock'}]}),/unsupported/);
});

test('non_original and gaoding need no original proof but retain classification and count checks',()=>{
 for(const category of ['non_original','gaoding']){
  const state=panel(),row={id:'photo',asset_id:'123',category};
  state[category].images=['https://example.test/123/photo.png'];
  assert.equal(copyright.validate(state,[row]),true);
  assert.throws(()=>copyright.validate(state,[{...row,category:'original'}]),/misclassified/);
  state[category].images.push('https://example.test/extra.png');
  assert.throws(()=>copyright.validate(state,[row]),/candidate count/);
  state[category].images.pop();state.uncategorized.images.push('unknown');
  assert.throws(()=>copyright.validate(state,[row]),/Uncategorized/);
 }
 for(const category of ['original','original_ai']){
  const state=panel();state[category].images=['https://example.test/123/photo.png'];
  assert.throws(()=>copyright.validate(state,[{id:'photo',asset_id:'123',category}]),/Missing evidence/);
 }
 assert.throws(()=>copyright.validate(panel(),[{category:'stock'}]),/Unsupported/);
});

test('third-party-only evidence lookup does not require or upload an original manifest',async()=>{
 assert.deepEqual(await copyright.evidenceFiles('/not-read/recipe.json',[{category:'non_original'},{category:'gaoding'}]),{});
 await assert.rejects(()=>copyright.evidenceFiles('/not-read/recipe.json',[{category:'stock'}]),/Unsupported/);
});

test('mixed materials retain reviewed hash and complete original/original_ai layer coverage',async()=>fixture(async dir=>{
 const recipePath=path.join(dir,'recipe.json'),image=Buffer.from('actual-test-evidence');
 await fs.writeFile(recipePath,'{}');await fs.writeFile(path.join(dir,'proof.png'),image);
 for(const category of ['original','original_ai']){
  const rows=[{id:'photo',category:'non_original'},{id:'art',category}];
  const entry={path:'proof.png',sha256:hash(image),layers:['art']};
  async function save(entries,reviewHash){
   const raw=JSON.stringify({categories:{[category]:entries}});
   await fs.writeFile(path.join(dir,'copyright-evidence.json'),raw);
   await fs.writeFile(path.join(dir,'release/material-review.json'),JSON.stringify({evidence_sha256:reviewHash||hash(raw)}));
  }
  await save([entry]);assert.deepEqual(await copyright.evidenceFiles(recipePath,rows),{[category]:[await fs.realpath(path.join(dir,'proof.png'))]});
  await save([]);await assert.rejects(()=>copyright.evidenceFiles(recipePath,rows),/Missing original evidence/);
  await save([{...entry,layers:[]}]);await assert.rejects(()=>copyright.evidenceFiles(recipePath,rows),/lack real copyright evidence/);
  await save([{...entry,layers:['photo']}]);await assert.rejects(()=>copyright.evidenceFiles(recipePath,rows),/actual layers/);
  await save([{...entry,sha256:'wrong'}]);await assert.rejects(()=>copyright.evidenceFiles(recipePath,rows),/screenshot changed/);
  await save([entry],'stale');await assert.rejects(()=>copyright.evidenceFiles(recipePath,rows),/current Agent material review/);
 }
}));

test('non_original rewritten candidates require exact hash, unique identity and full count',async()=>fixture(async dir=>{
 const bytes=Buffer.from('registered third-party photograph'),row={id:'photo',asset_id:'123',category:'non_original',sha256:hash(bytes)};
 const candidate={url:'https://example.test/rewritten.png',candidate_id:'candidate-photo'};
 const oldFetch=global.fetch;
 try{
  global.fetch=async()=>({ok:true,arrayBuffer:async()=>bytes});
  const resolved=await copyright.resolve({evaluate:async()=>[candidate]},dir,[row]);
  assert.equal(resolved[0].category,'non_original');assert.equal(resolved[0].sha256,hash(bytes));
  await assert.rejects(()=>copyright.resolve({evaluate:async()=>[]},dir,[row]),/identity\/count mismatch/);
  await assert.rejects(()=>copyright.resolve({evaluate:async()=>[candidate,candidate]},dir,[row]),/identity\/count mismatch/);
  global.fetch=async()=>({ok:true,arrayBuffer:async()=>Buffer.from('wrong photo')});
  await assert.rejects(()=>copyright.resolve({evaluate:async()=>[candidate]},dir,[row]),/hash must uniquely match/);
 }finally{global.fetch=oldFetch;}
}));

test('prepare classifies third-party materials without attempting any original-proof upload',async()=>fixture(async dir=>{
 const recipePath=path.join(dir,'recipe.json'),state=panel();
 const rows=[{id:'photo',asset_id:'123',category:'non_original',sha256:hash('photo')},{id:'stock',asset_id:'456',category:'gaoding',sha256:hash('stock')}];
 const candidates=rows.map(r=>({url:`https://example.test/${r.asset_id}/image.png`,candidate_id:r.id}));
 state.uncategorized.images=candidates.map(c=>c.url);
 await fs.writeFile(recipePath,'{}');await fs.writeFile(path.join(dir,'release/registered-assets.json'),JSON.stringify(rows));
 const page={
  async evaluate(fn,arg){
   if(arg){const url=candidates.find(c=>c.candidate_id===arg.id).url;state.uncategorized.images=state.uncategorized.images.filter(x=>x!==url);state[arg.category].images.push(url);return;}
   if(fn.toString().includes('candidate_id:'))return candidates;
   return state;
  },
  async setInputFiles(){throw Error('Third-party photo must never be uploaded as original proof');},
  async waitForFunction(){throw Error('No evidence upload wait expected');},async screenshot(){},
 };
 const result=await copyright.prepare(page,recipePath);
 assert.equal(result.non_original.images.length,1);assert.equal(result.gaoding.images.length,1);assert.equal(result.uncategorized.images.length,0);
}));
