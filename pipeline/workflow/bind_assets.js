const fs=require('node:fs/promises'),path=require('node:path');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=async(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2));
async function bind(page,recipePath){
 const recipe=await read(recipePath),out=path.join(path.dirname(recipePath),recipe.output||'release'),manifest=await read(path.join(out,'registered-assets.json'));
 const file=path.join(out,'bound-assets.json');let state=await read(file).catch(()=>({url:null,layers:[]}));
 if(state.url&&state.url!==await page.url())throw Error('Open the saved binding URL first: '+state.url);
 state.url=await page.url();
 if(state.pending)throw Error('Uncertain binding for '+state.pending+'; inspect the layer before resuming');
 if(await page.evaluate(()=>!!document.querySelector('button[aria-label="打开本地图层管理"]')))await page.click('button[aria-label="打开本地图层管理"]');
 await page.evaluate(()=>{for(const e of document.querySelectorAll('.layer-item__item__expand-box [aria-label="arrow-right-triangle"]'))e.parentElement.click();});
 for(const row of manifest){
  if(state.layers.some(x=>x.id===row.id&&x.asset_id===row.asset_id))continue;
  await page.click('text='+JSON.stringify(row.layer));
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='替换图片'),undefined,{timeout:15000});
  await page.click('text="替换图片"');
  await page.waitForFunction(()=>{const e=document.querySelector('input[placeholder="在「我的空间」内搜索"]');return e&&e.getBoundingClientRect().width>0},undefined,{timeout:15000});
  await page.fill('input[placeholder="在「我的空间」内搜索"]',row.title);await page.keyboard.press('Enter');
  await page.waitForFunction(id=>{const e=document.querySelector('[data-id="'+id+'"]');return e&&e.getBoundingClientRect().width>0},row.asset_id,{timeout:20000});
  state.pending=row.id;await write(file,state);
  await page.evaluate(id=>document.querySelector('[data-id="'+id+'"]').closest('.gd-dam-components__asset-card__asset-card').querySelector('.gd-dam-components__asset-card__asset-card-view').click(),row.asset_id);
  await page.waitForFunction(()=>!!document.querySelector('[aria-label="check-small"]'),undefined,{timeout:20000});
  await page.evaluate(()=>document.querySelector('[aria-label="check-small"]').closest('button').click());
  await page.waitForFunction(()=>!document.querySelector('[aria-label="check-small"]'),undefined,{timeout:10000});
  await page.waitForFunction(()=>!!document.querySelector('[aria-label="cloud-save-success"]'),undefined,{timeout:30000});
  state.layers.push({id:row.id,layer:row.layer,asset_id:row.asset_id,sha256:row.sha256,boundAt:new Date().toISOString()});delete state.pending;await write(file,state);console.log('bound',row.layer,row.asset_id);
 }
 for(const board of recipe.pages||[]){const layer=recipe.layers.find(r=>r.page===board.id);await page.click('text='+JSON.stringify(layer.name));await page.keyboard.press('Escape');await page.screenshot({path:path.join(out,'editor-bound-'+board.id+'.png')});}
 await page.keyboard.press('Escape');await page.screenshot({path:path.join(out,'editor-materials-bound.png')});return state;
}
module.exports={bind};
