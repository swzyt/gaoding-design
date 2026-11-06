const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
async function save(file,data){await fs.writeFile(file,JSON.stringify(data,null,2));}
async function collect(page,directory,names){
 await fs.mkdir(directory,{recursive:true});
 const selectionFile=path.join(directory,'selection.json');let selected;
 try{selected=JSON.parse(await fs.readFile(selectionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;
  await page.goto('https://www.gaoding.com/explore/topics');
  await page.waitForFunction(()=>document.querySelector('a[href*="/topics/"]'));
  const all=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/topics/"]')].map(a=>({name:a.innerText.trim().split('\n')[0],url:a.href})));
  const pool=all.filter(t=>names.includes(t.name));
  if(pool.length!==names.length)throw Error('Configured topic pool not fully available; inspect live catalog');
  const index=crypto.randomInt(pool.length);selected={at:new Date().toISOString(),method:names.length===1?'explicit topic':'crypto.randomInt uniform; no redraw',pool,index,topic:pool[index]};
  await save(selectionFile,selected);
 }
 if(!names.includes(selected.topic.name))throw Error('Saved topic conflicts with requested topic; use the original selection');
 await page.goto(selected.topic.url);
 await page.waitForFunction(()=>document.querySelector('a[href*="yuque.com"]')&&document.querySelectorAll('a[href^="/posts/"] img').length>=7);
 const live=await page.evaluate(()=>{
  const rows=[1,2,3].map(n=>{const im=document.querySelector(`button[aria-label="TOP${n}"] img`);if(!im)throw Error('Missing ranked sample');return{rank:`TOP${n}`,src:im.src,alt:im.alt};});
  const anchors=[...document.querySelectorAll('a[href^="/posts/"]')].filter(a=>a.querySelector('img')).slice(0,7);
  rows.push(...anchors.map((a,i)=>({rank:`列表${i+1}`,src:a.querySelector('img').src,alt:a.querySelector('img').alt,link:a.href})));
  return{title:document.querySelector('h1,h2')?.textContent?.trim()||document.title.split('-')[0],url:location.href,rules_url:document.querySelector('a[href*="yuque.com"]').href,samples:rows};
 });
 if(live.samples.length!==10)throw Error('10 samples required');
 await page.screenshot({path:path.join(directory,'topic-page.png')});
 await page.goto(live.rules_url);
 await page.waitForFunction(()=>document.querySelector('.ne-viewer-body')?.innerText.length>100);
 live.rules=await page.evaluate(()=>document.querySelector('.ne-viewer-body').innerText);
 live.rules_images=await page.evaluate(()=>[...document.querySelectorAll('.ne-viewer-body img')].map(x=>({src:x.src,alt:x.alt})).filter(x=>x.src));
 live.checked_at=new Date().toISOString();await save(path.join(directory,'live.json'),live);
 await fs.writeFile(path.join(directory,'rules.txt'),live.rules);
 return {topic:selected.topic,samples:live.samples.length};
}
module.exports={collect};
