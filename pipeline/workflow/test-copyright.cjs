const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const copyright=require('./copyright.js');
(async()=>{const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gd-copyright-'));const originalFetch=global.fetch;try{
 const bytes=Buffer.from('registered immutable image');const sha=crypto.createHash('sha256').update(bytes).digest('hex');const rows=[{id:'image',asset_id:'1234',sha256:sha,category:'original_ai'}];const candidate={url:'https://cdn.example/rewritten.png',candidate_id:'element:uuid:url'};const page={evaluate:async()=>[candidate]};global.fetch=async()=>({ok:true,arrayBuffer:async()=>bytes});
 const mapped=await copyright.resolve(page,tmp,rows);assert.equal(mapped[0].verified_url,candidate.url);assert.equal(mapped[0].asset_id,'1234');
 const panel={uncategorized:{images:[],evidence:[]},original:{images:[],evidence:[]},original_ai:{images:[candidate.url],evidence:['proof.png']},gaoding:{images:[],evidence:[]},non_original:{images:[],evidence:[]}};assert.equal(copyright.validate(panel,mapped),true);assert.throws(()=>copyright.validate(panel,rows),/Missing or misclassified/);
 global.fetch=async()=>({ok:true,arrayBuffer:async()=>Buffer.from('different image')});await assert.rejects(()=>copyright.resolve(page,tmp,rows),/hash must uniquely match/);
 // Live entry regression: the declaration panel is only reachable via 发布列表卡片「…」→「版权认证」.
 // A fake page records that the opener clicks the dropdown item by its text and never falls back to the editor's 版权说明 tooltip.
 const calls=[];let opened=false;
 const fakePage={url:async()=>calls.url||'https://www.gaoding.com/',goto:async u=>{calls.push(['goto',u]);},evaluate:async(fn)=>{const src=fn.toString();
  if(src.includes('querySelectorAll')&&src.includes('版权认证')){calls.push(['open-item']);opened=true;return undefined;}
  return undefined;},
  waitForFunction:async(fn,arg)=>{const src=fn.toString();
   if(src.includes('i.alt===desc'))return true;
   if(src.includes('ugc-copyright-section'))return true;
   if(src.includes('版权认证'))return true;
   return true;}};
 await copyright.openPanel(fakePage,{description:'desc'});
 assert.ok(calls.some(c=>c[0]==='goto'&&c[1]==='https://www.gaoding.com/my/publish'),'openPanel must navigate to the publish list');
 assert.ok(opened,'openPanel must click the 版权认证 dropdown item');
 assert.equal(await copyright.openPanel(fakePage,{description:'desc'}),true);
 global.fetch=originalFetch;console.log('Copyright CMS rewrite identity and wrong-content rejection passed');
 console.log('Copyright declaration entry (发布 → … → 版权认证) reached');
 }finally{global.fetch=originalFetch;await fs.rm(tmp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
