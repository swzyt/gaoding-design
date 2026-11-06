const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const copyright=require('./copyright.js');
(async()=>{const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gd-copyright-'));const originalFetch=global.fetch;try{
 const bytes=Buffer.from('registered immutable image');const sha=crypto.createHash('sha256').update(bytes).digest('hex');const rows=[{id:'image',asset_id:'1234',sha256:sha,category:'original_ai'}];const candidate={url:'https://cdn.example/rewritten.png',candidate_id:'element:uuid:url'};const page={evaluate:async()=>[candidate]};global.fetch=async()=>({ok:true,arrayBuffer:async()=>bytes});
 const mapped=await copyright.resolve(page,tmp,rows);assert.equal(mapped[0].verified_url,candidate.url);assert.equal(mapped[0].asset_id,'1234');
 const panel={uncategorized:{images:[],evidence:[]},original:{images:[],evidence:[]},original_ai:{images:[candidate.url],evidence:['proof.png']},gaoding:{images:[],evidence:[]},non_original:{images:[],evidence:[]}};assert.equal(copyright.validate(panel,mapped),true);assert.throws(()=>copyright.validate(panel,rows),/Missing or misclassified/);
 global.fetch=async()=>({ok:true,arrayBuffer:async()=>Buffer.from('different image')});await assert.rejects(()=>copyright.resolve(page,tmp,rows),/hash must uniquely match/);
 global.fetch=originalFetch;console.log('Copyright CMS rewrite identity and wrong-content rejection passed');
 }finally{global.fetch=originalFetch;await fs.rm(tmp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
