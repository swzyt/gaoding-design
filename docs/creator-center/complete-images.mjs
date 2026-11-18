// Read-only follow-up for Yuque's lazy image rendering; run through ego-browser nodejs.
const fs=await import('node:fs/promises');
const root=globalThis.CREATOR_KNOWLEDGE_ROOT;
const spaceId=globalThis.CREATOR_TASK_SPACE;
if(typeof root!=='string'||!root.startsWith('/')||!Number.isInteger(spaceId))throw Error('Provide actual absolute CREATOR_KNOWLEDGE_ROOT and active CREATOR_TASK_SPACE');
const task=await taskSpace(spaceId);const page=task.page('p1');
const catalog=JSON.parse(await fs.readFile(root+'/catalog.json','utf8'));
let count=0;
for(const entry of catalog.documents){
 const file=root+'/sources/'+entry.id+'.json';const doc=JSON.parse(await fs.readFile(file,'utf8'));
 if(doc.images.every(im=>!!im.src)&&doc.metadata)continue;
 if(await page.url()!==entry.url){
  try{await page.goto(entry.url,{timeout:25000});}
  catch(error){if(await page.url()!==entry.url)throw error;}
 }
 await page.waitForFunction(()=>!!document.querySelector('.ne-viewer-body'),undefined,{timeout:15000});
 await page.evaluate(async()=>{
  const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  for(const im of document.querySelectorAll('.ne-viewer-body img')){
   if(im.src)continue;
   im.scrollIntoView({block:'center'});
   for(let n=0;n<12&&!im.src;n++)await frames();
  }
 });
 const update=await page.evaluate(()=>({
  title:window.appData?.doc?.title||document.title,
  metadata:{content_updated_at:window.appData?.doc?.content_updated_at,updated_at:window.appData?.doc?.updated_at,published_at:window.appData?.doc?.published_at},
  images:[...document.querySelectorAll('.ne-viewer-body img')].map((im,index)=>({index,src:im.currentSrc||im.src,alt:im.alt,width:im.naturalWidth||Number(im.getAttribute('width'))||0,height:im.naturalHeight||Number(im.getAttribute('height'))||0})),
  html:document.querySelector('.ne-viewer-body').innerHTML,
  toc:(window.appData?.book?.toc||[]).map(row=>({type:row.type,title:row.title,url:row.url,parent_uuid:row.parent_uuid,uuid:row.uuid,level:row.level,visible:row.visible}))
 }));
 doc.title=update.title;doc.metadata=update.metadata;doc.images=update.images;doc.html=update.html;doc.imageSourcesCheckedAt=new Date().toISOString();
 await fs.writeFile(file,JSON.stringify(doc,null,2)+'\n');
 entry.title=update.title;entry.imageCount=update.images.length;entry.missingImageSources=update.images.filter(im=>!im.src).length;
 await fs.writeFile(root+'/catalog.json',JSON.stringify(catalog,null,2)+'\n');
 await fs.writeFile(root+'/sources/toc.json',JSON.stringify({at:new Date().toISOString(),entries:update.toc},null,2)+'\n');
 console.log(JSON.stringify({id:entry.id,images:update.images.length,missing:entry.missingImageSources}));
 if(++count>=12)break;
}
console.log('Completed batch: '+count);
