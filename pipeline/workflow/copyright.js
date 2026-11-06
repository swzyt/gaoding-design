const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=async(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2));
async function inspect(page){return page.evaluate(()=>{
 const d=[document,...[...document.querySelectorAll('iframe')].map(f=>f.contentDocument).filter(Boolean)].find(d=>d.querySelector('.ugc-copyright-section'));
 if(!d)return null;
 return Object.fromEntries(['uncategorized','original','original_ai','gaoding','non_original'].map(c=>[c,{images:[...d.querySelectorAll('.ugc-copyright-section-'+c+' .ugc-copyright-thumb img')].map(e=>e.src.split('?')[0]),evidence:[...d.querySelectorAll('.ugc-copyright-section-'+c+' .ugc-copyright-evidence-thumb img')].map(e=>e.src.split('?')[0])}]));
});}
async function resolve(page,out,rows){
 const candidates=await page.evaluate(()=>{const d=[document,...[...document.querySelectorAll('iframe')].map(f=>f.contentDocument).filter(Boolean)].find(d=>d.querySelector('.ugc-copyright-section'));if(!d)throw Error('Missing copyright panel');return [...d.querySelectorAll('.ugc-copyright-thumb')].map(e=>({url:e.querySelector('img').src.split('?')[0],candidate_id:e.querySelector('[data-candidate-id]')?.getAttribute('data-candidate-id')}));});
 const resolved=[];
 for(let i=0;i<candidates.length;i+=3){
  resolved.push(...await Promise.all(candidates.slice(i,i+3).map(async c=>{
   const direct=rows.find(r=>c.url.includes('/'+r.asset_id+'/'));if(direct)return {...c,sha256:direct.sha256,id:direct.id,method:'DAM asset ID'};
   const response=await fetch(c.url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Cannot verify published asset '+response.status);
   const sha256=crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
   const matches=rows.filter(r=>r.sha256===sha256);if(matches.length!==1)throw Error('Published content hash must uniquely match registered PNG: '+c.url);
   return {...c,sha256,id:matches[0].id,method:'exact PNG SHA256 after CMS URL rewrite'};
  })));
 }
 if(resolved.length!==rows.length||new Set(resolved.map(x=>x.id)).size!==rows.length)throw Error('Published candidate identity/count mismatch');
 await write(path.join(out,'copyright-url-map.json'),resolved);
 return rows.map(row=>({...row,verified_url:resolved.find(x=>x.id===row.id).url,candidate_id:resolved.find(x=>x.id===row.id).candidate_id}));
}
function validate(state,rows){
 if(!state)throw Error('Copyright panel missing; registration/binding is incomplete');
 if(state.uncategorized.images.length)throw Error('Uncategorized materials remain');
 for(const row of rows)if(!state[row.category].images.some(url=>url.includes('/'+row.asset_id+'/')||url===row.verified_url))throw Error('Missing or misclassified asset '+row.id);
 for(const category of new Set(rows.map(r=>r.category)))if(!state[category].evidence.length)throw Error('Missing evidence for '+category);
 const actual=Object.values(state).reduce((n,s)=>n+s.images.length,0);if(actual!==rows.length)throw Error('Unexpected copyright candidate count '+actual+'/'+rows.length);
 return true;
}
async function prepare(page,recipePath){
 const recipe=await read(recipePath),out=path.join(path.dirname(recipePath),recipe.output||'release'),rows=await resolve(page,out,await read(path.join(out,'registered-assets.json')));
 const before=await inspect(page);if(!before)throw Error('Open the copyright panel first');
 const actual=Object.values(before).reduce((n,s)=>n+s.images.length,0);if(actual!==rows.length)throw Error('Incomplete copyright extraction '+actual+'/'+rows.length);
 for(const row of rows){
  await page.evaluate(row=>{
   const f=document.querySelector('.ugc-copyright-section')?null:[...document.querySelectorAll('iframe')].find(f=>f.contentDocument?.querySelector('.ugc-copyright-section')),d=f?.contentDocument||document,w=f?.contentWindow||window;
   const th=[...d.querySelectorAll('.ugc-copyright-thumb')].find(e=>e.querySelector('img').src.includes('/'+row.asset_id+'/')||e.querySelector('img').src.split('?')[0]===row.verified_url);
   if(!th)throw Error('Missing asset '+row.asset_id);if(th.closest('.ugc-copyright-section-'+row.category))return;
   const zone=d.querySelector('.ugc-copyright-section-'+row.category+' .ugc-copyright-grid-content'),dt=new w.DataTransfer();
   for(const [e,t] of [[th,'dragstart'],[zone,'dragenter'],[zone,'dragover'],[zone,'drop'],[th,'dragend']])e.dispatchEvent(new w.DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}));
  },row);
 }
 for(const c of new Set(rows.map(r=>r.category))){
  const current=await inspect(page);if(current[c].evidence.length)continue;
  await page.setInputFiles('.ugc-copyright-section-'+c+' input[type="file"]',[path.join(out,c==='original_ai'?'receipts.png':'shape-evidence.png')]);
  await page.waitForFunction(c=>{const d=[document,...[...document.querySelectorAll('iframe')].map(f=>f.contentDocument).filter(Boolean)].find(d=>d.querySelector('.ugc-copyright-section'));return !!d?.querySelector('.ugc-copyright-section-'+c+' .ugc-copyright-evidence-thumb img')},c,{timeout:30000});
 }
 const state=await inspect(page);validate(state,rows);await write(path.join(out,'copyright-prepared.json'),state);await page.screenshot({path:path.join(out,'copyright-prepared-v2.png')});return state;
}
async function submit(page,recipePath){
 const recipe=await read(recipePath),out=path.join(path.dirname(recipePath),recipe.output||'release'),rows=await resolve(page,out,await read(path.join(out,'registered-assets.json')));
 validate(await inspect(page),rows);
 const file=path.join(out,'copyright-submission-v2.json');const old=await read(file).catch(()=>null);
 if(old?.stage==='submission-started')throw Error('Uncertain declaration submission; reopen to verify before repeating');
 const management=await page.evaluate(()=>!!document.querySelector('.ugc-copyright-section')&&location.pathname==='/my/publish');
 await write(file,{stage:'submission-started',expected:rows.length,at:new Date().toISOString(),management});
 await page.evaluate(()=>{
  const d=[document,...[...document.querySelectorAll('iframe')].map(f=>f.contentDocument).filter(Boolean)].find(d=>d.querySelector('.ugc-copyright-section'));
  const cb=d.querySelector('input[type="checkbox"]');if(!cb.checked)cb.click();
  const b=[...d.querySelectorAll('button')].find(e=>e.innerText.trim()==='声明并发布');if(!b||b.disabled)throw Error('Declaration submit unavailable');b.click();
 });
 if(management)await page.waitForFunction(()=>!document.querySelector('.ugc-copyright-section'),undefined,{timeout:45000});
 else await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.contentDocument?.querySelector('[contenteditable="true"]')||f.contentDocument?.body?.innerText.includes('发布成功')),undefined,{timeout:45000});
 await write(file,{stage:'submitted-needs-reopen',expected:rows.length,at:new Date().toISOString()});
 return {stage:'submitted-needs-reopen'};
}
async function verify(page,recipePath){
 const recipe=await read(recipePath),out=path.join(path.dirname(recipePath),recipe.output||'release'),rows=await resolve(page,out,await read(path.join(out,'registered-assets.json')));
 const panel=await inspect(page);validate(panel,rows);
 const result={state:'verified',verifiedAt:new Date().toISOString(),expected:rows.length,uncategorized:0,original:panel.original.images.length,original_ai:panel.original_ai.images.length,originalEvidence:panel.original.evidence,aiEvidence:panel.original_ai.evidence,assets:rows.map(r=>({id:r.id,asset_id:r.asset_id,category:r.category,published_url:r.verified_url,content_sha256:r.sha256,candidate_id:r.candidate_id})),reopened:true};
 await page.screenshot({path:path.join(out,'copyright-verified-v2.png')});await write(path.join(out,'copyright-verification.json'),result);return result;
}
module.exports={inspect,resolve,validate,prepare,submit,verify};

// Live entry verified 2026-11-06: 我的 → 发布 → 卡片右下角「…」，菜单第四项是「版权认证」（不是「版权说明」）；
// 点开即「版权声明」弹窗，含 未分类/稿定/原创/原创AI/非原创 五个 .ugc-copyright-section-* 分区。
// 发布成功弹窗的「去完善」也可直达；编辑器右上角的「版权说明」只是一段说明文案。
async function openPanel(page,{listUrl='https://www.gaoding.com/my/publish',description}={}){
 if(!(await page.url()).startsWith(listUrl))await page.goto(listUrl,{timeout:60000});
 await page.waitForFunction(desc=>[...document.images].some(i=>i.alt===desc),description,{timeout:60000});
 if(await inspect(page))return true;
 await page.evaluate(desc=>{
  const card=[...document.images].find(i=>i.alt===desc).parentElement.parentElement;
  const trigger=card.querySelector('button[aria-label="更多"]')||card.querySelector('.gda-dropdown-trigger');
  if(!trigger)throw Error('Publication card has no 更多 trigger');
  trigger.click();
 },description);
 await page.waitForFunction(()=>[...document.querySelectorAll('.gda-dropdown-menu-item')].some(e=>e.innerText.trim()==='版权认证'),undefined,{timeout:15000});
 await page.evaluate(()=>[...document.querySelectorAll('.gda-dropdown-menu-item')].find(e=>e.innerText.trim()==='版权认证').click());
 await page.waitForFunction(()=>[document,...[...document.querySelectorAll('iframe')].map(f=>f.contentDocument).filter(Boolean)].some(d=>d.querySelector('.ugc-copyright-section')),undefined,{timeout:30000});
 return true;
}
module.exports.openPanel=openPanel;
