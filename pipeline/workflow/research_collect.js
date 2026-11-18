const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
async function save(file,data){await fs.writeFile(file,JSON.stringify(data,null,2));}
const isHub=url=>/^https:\/\/(www\.)?gaoding\.com\/topics\/[^/?#]+(?:[/?#]|$)/.test(url||'');
const topicName=value=>String(value||'').replace(/[#＃\s\u200b]/g,'').toLowerCase();
function rulesUrl(value){const url=new URL(value);if(url.protocol!=='https:'||!(url.hostname==='yuque.com'||url.hostname.endsWith('.yuque.com')))throw Error('Rules URL must be a Yuque document');url.hash='';url.search='';return url.href.replace(/\/$/,'');}
async function topicPage(page){return page.evaluate(()=>({rows:[...document.querySelectorAll('a[href*="/topics/"]')].map(a=>({name:(a.getAttribute('aria-label')||a.innerText).trim().split('\n')[0],url:a.href})),more:[...document.querySelectorAll('button')].findIndex(b=>/加载更多|更多话题|查看更多/.test(b.innerText.replace(/\s/g,''))&&!b.disabled)}));}
async function exploreTarget(page,name){
 await page.goto('https://www.gaoding.com/explore/topics');
 await page.waitForFunction(()=>document.querySelector('a[href*="/topics/"]'));
 for(let round=0;round<100;round++){
  const before=await topicPage(page),matches=before.rows.filter(t=>topicName(t.name)===topicName(name));
  const urls=[...new Set(matches.map(t=>t.url))];
  if(urls.length>1)throw Error('Topic ambiguous in live catalog: '+name);
  if(urls.length===1)return urls[0];
  if(before.more<0)throw Error('Topic missing in live catalog; Agent must resolve hub: '+name);
  // Long lists can leave the observed control below the viewport; do not rely on auto-scroll.
  await page.evaluate(index=>{const button=document.querySelectorAll('button')[index];if(!button||button.disabled||!/加载更多|更多话题|查看更多/.test(button.innerText.replace(/\s/g,'')))throw Error('Topic pagination control changed');button.scrollIntoView({block:'center',behavior:'instant'});},before.more);
  let clickError;try{await page.click('button >> nth='+before.more);}catch(error){clickError=error;}
  const changed=state=>state.rows.length>before.rows.length||state.rows.some(t=>topicName(t.name)===topicName(name));
  // A click can succeed before scrolling/receipt times out. Inspect its effect before any further action.
  let after=await topicPage(page);
  if(!changed(after)){
   try{await page.waitForFunction(({count,name})=>document.querySelectorAll('a[href*="/topics/"]').length>count||[...document.querySelectorAll('a[href*="/topics/"]')].some(a=>(a.getAttribute('aria-label')||a.innerText).trim().split('\n')[0].replace(/[#＃\s\u200b]/g,'').toLowerCase()===name),{count:before.rows.length,name:topicName(name)},{timeout:15000});}catch(error){throw Error('Topic pagination made no verified progress: '+name+'; '+(clickError||error).message);}
   after=await topicPage(page);
   if(!changed(after))throw Error('Topic pagination made no verified progress: '+name);
  }
 }
 throw Error('Topic pagination exceeded 100 pages; inspect live catalog');
}
async function resolveTarget(page,target){
 if(typeof target==='string')target={name:target};
 let hub=target.hub;
 if(!hub&&target.rules_url){
  await page.goto(rulesUrl(target.rules_url));
  await page.waitForFunction(()=>document.querySelector('.ne-viewer-body')?.innerText.length>100);
  const links=await page.evaluate(()=>[...document.querySelectorAll('.ne-viewer-body a[href]')].map(a=>({name:a.innerText.trim().replace(/^#/,''),url:a.href})).filter(a=>/^https:\/\/(www\.)?gaoding\.com\/topics\//.test(a.url)));
  const exact=links.filter(a=>topicName(a.name)===topicName(target.name)),urls=[...new Set((exact.length?exact:links).map(a=>a.url))];
  if(urls.length>1)throw Error('Topic rules do not identify one unambiguous samples hub: '+target.name+'; Agent must resolve and supply hub');
  hub=urls[0];
 }
 if(!hub)hub=await exploreTarget(page,target.name);
 if(!isHub(hub))throw Error('Sample hub must be a Gaoding topic details URL');
 return {...target,url:hub,hub};
}
async function collect(page,directory,names){
 if(!Array.isArray(names)||!names.length)throw Error('Nonempty topic targets required');
 await fs.mkdir(directory,{recursive:true});
 const selectionFile=path.join(directory,'selection.json');let selected;
 try{selected=JSON.parse(await fs.readFile(selectionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;
  const pool=[];for(const target of names)pool.push(await resolveTarget(page,target));
  const index=crypto.randomInt(pool.length);selected={at:new Date().toISOString(),method:names.length===1?'explicit topic':'crypto.randomInt uniform; no redraw',pool,index,topic:pool[index]};
  await save(selectionFile,selected);
 }
 const requested=names.find(t=>typeof t==='string'?t===selected.topic.name:t.name===selected.topic.name&&(!t.key||!selected.topic.key||t.key===selected.topic.key));
 if(!requested)throw Error('Saved topic conflicts with requested topic; use the original selection');
 if(typeof requested==='object'&&((requested.hub&&requested.hub!==selected.topic.url)||(requested.rules_url&&requested.rules_url!==selected.topic.rules_url)))throw Error('Saved topic URLs conflict with requested target');
 if(!isHub(selected.topic.url))throw Error('Saved topic has no valid Gaoding sample hub');
 await page.goto(selected.topic.url);
 await page.waitForFunction(()=>document.querySelectorAll('a[href^="/posts/"] img').length>=7&&[1,2,3].every(n=>[...document.querySelectorAll('button[aria-label]')].some(b=>b.getAttribute('aria-label').replace(/\s/g,'').toUpperCase()===`TOP${n}`&&b.querySelector('img'))));
 const live=await page.evaluate(()=>{
  const rows=[1,2,3].map(n=>{const im=[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label').replace(/\s/g,'').toUpperCase()===`TOP${n}`)?.querySelector('img');if(!im)throw Error('Missing ranked sample');return{rank:`TOP${n}`,src:im.currentSrc||im.src,alt:im.alt};});
  const anchors=[...document.querySelectorAll('a[href^="/posts/"]')].filter(a=>a.querySelector('img')).slice(0,7);
  rows.push(...anchors.map((a,i)=>({rank:`列表${i+1}`,src:a.querySelector('img').src,alt:a.querySelector('img').alt,link:a.href})));
  return{title:document.querySelector('h1,h2')?.textContent?.trim()||document.title.split('-')[0],url:location.href,rules_links:[...document.querySelectorAll('a[href*="yuque.com"]')].map(a=>a.href),samples:rows};
 });
 if(live.samples.length!==10)throw Error('10 samples required');
 const frozen=selected.topic.rules_url?rulesUrl(selected.topic.rules_url):null;
 const observed=[...new Set((live.rules_links||[]).map(rulesUrl))];
 if(frozen&&observed.some(url=>url!==frozen))throw Error('Live topic rules conflict with frozen rules URL');
 if(!frozen&&observed.length!==1)throw Error('Topic must identify one rules URL or provide a frozen rules_url');
 live.rules_url=frozen||observed[0];
 await page.screenshot({path:path.join(directory,'topic-page.png')});
 await page.goto(live.rules_url);
 await page.waitForFunction(()=>document.querySelector('.ne-viewer-body')?.innerText.length>100);
 live.rules=await page.evaluate(()=>document.querySelector('.ne-viewer-body').innerText);
 // Trigger each lazy image, then wait for its actual decoded resource before recording sources.
 for(let index=0;index<1000;index++){
  const count=await page.evaluate(()=>document.querySelectorAll('.ne-viewer-body img').length);
  if(index>=count)break;
  await page.evaluate(i=>document.querySelectorAll('.ne-viewer-body img')[i]?.scrollIntoView({block:'center'}),index);
  await page.waitForFunction(i=>{const image=document.querySelectorAll('.ne-viewer-body img')[i];return image&&/^https?:\/\//.test(image.currentSrc||image.src)&&image.complete&&image.naturalWidth>0;},index,{timeout:20000});
  if(index===999)throw Error('Rules image count exceeded safety limit');
 }
 live.rules_images=await page.evaluate(()=>[...document.querySelectorAll('.ne-viewer-body img')].map(x=>({src:x.currentSrc||x.src,alt:x.alt,width:x.naturalWidth,height:x.naturalHeight})));
 live.checked_at=new Date().toISOString();await save(path.join(directory,'live.json'),live);
 await fs.writeFile(path.join(directory,'rules.txt'),live.rules);
 return {topic:selected.topic,samples:live.samples.length};
}
module.exports={collect,resolveTarget};
