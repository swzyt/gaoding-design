const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {register, lookup, observe, cleanURL, safeFile, repository, assertTitle, FILE_INPUT} = require('./dam_browser.js');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const json = (file, value) => fs.writeFile(file, JSON.stringify(value));

class MockPage {
  constructor(rows = []) {
    this.repo = '123'; this.rows = rows; this.pendingEvents = []; this.uploads = 0; this.keyword = '';
    this.calls = {goto:0, search:0, fetch:0, screenshot:0}; this.activeDownloads = 0; this.maxDownloads = 0; this.nextAssetId = 900;
    this.keyboard = {press: async key => {if (key === 'Enter') {this.calls.search++;this.capture(this.keyword);}}};
  }
  async url() { return 'https://www.gaoding.com/dam/my/' + this.repo; }
  capture(keyword = '') {
    this.responseRows = this.rows.filter(row => keyword ? row.title.includes(keyword) : !this.firstPageIds || this.firstPageIds.includes(row.id));
    this.pendingEvents = [
      {method:'Network.requestWillBeSent', params:{request:{url:'https://www.gaoding.com/api/dam/asset/v2/search/simple', postData:JSON.stringify({repository_ids:[this.repo],keyword})}}},
      {method:'Network.responseReceived', params:{requestId:'fixture',response:{url:'https://www.gaoding.com/api/dam/asset/v2/search/simple',status:200}}}
    ];
  }
  async cdp(method) { if (method === 'Network.getResponseBody') return {body:JSON.stringify({data:this.responseRows,finish:true})}; }
  async goto() { this.calls.goto++;this.capture(); }
  async events() { const rows=this.pendingEvents;this.pendingEvents=[];return rows; }
  async waitForSelector() {}
  async waitForLoadState() {}
  async click() {}
  async fill(selector, value) { this.keyword=value; }
  async waitForFunction() {}
  async evaluate(fn, arg) {
    if (!arg) return 1;
    if (arg.ids) return arg.ids.filter(id => this.rows.some(row => row.id === id) && (!this.visibleIds || this.visibleIds.includes(id)));
    return this.rows.some(row => row.id === arg.id);
  }
  async screenshot({path:file}) { this.calls.screenshot++;await fs.writeFile(file,png); }
  async fetch(url, options) {
    assert.ok(options.saveAs, 'must never replay authenticated APIs');this.calls.fetch++;this.activeDownloads++;
    this.maxDownloads = Math.max(this.maxDownloads,this.activeDownloads);
    try {await new Promise(resolve=>setImmediate(resolve));await fs.writeFile(options.saveAs,png);return {ok:true};}
    finally {this.activeDownloads--;}
  }
  async setInputFiles(selector, files) {
    assert.equal(selector,FILE_INPUT);this.uploads++;
    this.rows.push({id:String(++this.nextAssetId),repository_id:this.repo,title:path.basename(files[0],'.png'),origin_info:{url:'https://cdn.example/asset.png?auth_key=transient'}});
  }
}
async function fixture(t) {
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dam-helper-test-')));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'release'),registered=path.join(root,'registered-assets');
  await fs.mkdir(path.join(root,'assets'),{recursive:true});await fs.mkdir(registered);
  await fs.writeFile(path.join(root,'assets/a.png'),png);
  const request={schema:1,token:'frozen-final-fixture',repository_id:'123',assets:[{id:'a',source:'assets/a.png',title:'Test-shape-'+hash(png).slice(0,10),layer:'shape',category:'original',sha256:hash(png)}]};
  const requestPath=path.join(registered,'request.json');await json(requestPath,request);
  return {root,registered,request,requestPath};
}

async function manyFixture(t) {
  const f=await fixture(t),first=f.request.assets[0];
  for (const id of ['b','c','d','e']) {
    await fs.writeFile(path.join(f.root,'assets',id+'.png'),png);
    f.request.assets.push({...first,id,source:'assets/'+id+'.png',title:'Test-shape-'+id+'-'+hash(png).slice(0,10),layer:'shape-'+id});
  }
  await json(f.requestPath,f.request);return f;
}
function resetCalls(p) {p.calls={goto:0,search:0,fetch:0,screenshot:0};p.maxDownloads=0;p.uploads=0;}

// Counts below are algorithmic regression assertions, not production timings.
test('five serial new uploads use one lookup each and preserve per-asset evidence', async t=>{
  const f=await manyFixture(t),p=new MockPage();const response=await register(p,f.requestPath);
  assert.equal(p.uploads,5);assert.equal(p.calls.goto,6);assert.equal(p.calls.search,5);
  assert.equal(p.calls.fetch,5);assert.equal(p.maxDownloads,1);assert.equal(p.calls.screenshot,5);
  assert.equal(new Set(response.assets.map(row=>row.evidence.path)).size,5);
});

test('five saved visible IDs need one reopen, zero searches, five downloads capped at three', async t=>{
  const f=await manyFixture(t),p=new MockPage();const response=await register(p,f.requestPath);resetCalls(p);
  const again=await register(p,f.requestPath);
  assert.deepEqual(again,response);assert.equal(p.uploads,0);assert.equal(p.calls.goto,1);assert.equal(p.calls.search,0);
  assert.equal(p.calls.fetch,5);assert.ok(p.maxDownloads>=2);assert.ok(p.maxDownloads<=3);assert.equal(p.calls.screenshot,0);
});

test('saved first-page absence and virtualized rows fall back to UI lookup without upload', async t=>{
  const f=await manyFixture(t),p=new MockPage();const response=await register(p,f.requestPath);resetCalls(p);
  p.firstPageIds=p.rows.slice(0,4).map(row=>row.id);p.visibleIds=p.rows.slice(0,3).map(row=>row.id);
  assert.deepEqual(await register(p,f.requestPath),response);
  assert.equal(p.uploads,0);assert.equal(p.calls.goto,1);assert.equal(p.calls.search,2);assert.equal(p.calls.fetch,5);
  assert.equal(p.calls.screenshot,0);
});

test('partial recovery rechecks three saved assets, resolves one pending ID, uploads only untouched fifth', async t=>{
  const f=await manyFixture(t),p=new MockPage();await register(p,f.requestPath);resetCalls(p);
  const stateFile=path.join(f.registered,'browser-upload-state.json');
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));state.assets=state.assets.slice(0,3);state.pending='d';
  await json(stateFile,state);p.rows=p.rows.slice(0,4);
  const originalFetch=p.fetch.bind(p);
  p.fetch=async (...args)=>{
    if (p.activeDownloads) assert.equal(JSON.parse(await fs.readFile(stateFile,'utf8')).pending,'d');
    return originalFetch(...args);
  };
  const response=await register(p,f.requestPath);
  assert.equal(p.uploads,1);assert.equal(p.calls.goto,2);assert.equal(p.calls.search,2);assert.equal(p.calls.fetch,5);
  assert.equal(p.calls.screenshot,2);assert.equal(response.assets.length,5);assert.equal(new Set(response.assets.map(row=>row.asset_id)).size,5);
  assert.equal(JSON.parse(await fs.readFile(stateFile,'utf8')).pending,undefined);
});

test('a title match with a changed saved asset ID cannot replace its original receipt', async t=>{
  const f=await fixture(t),p=new MockPage();await register(p,f.requestPath);resetCalls(p);
  p.rows[0].id='changed-server-id';
  await assert.rejects(register(p,f.requestPath),/Saved DAM asset no longer matches/);
  assert.equal(p.uploads,0);assert.equal(p.calls.fetch,0);
});

test('parallel saved-asset hash failure drains downloads and keeps state, response and pending', async t=>{
  const f=await manyFixture(t),p=new MockPage();await register(p,f.requestPath);resetCalls(p);
  const stateFile=path.join(f.registered,'browser-upload-state.json'),responseFile=path.join(f.registered,'response.json');
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));state.pending='e';await json(stateFile,state);
  const previousState=await fs.readFile(stateFile,'utf8'),previousResponse=await fs.readFile(responseFile,'utf8');
  const fetch=p.fetch.bind(p);p.fetch=async (url,options)=>{
    const result=await fetch(url,options);if(path.basename(options.saveAs)==='a-download.png')await fs.writeFile(options.saveAs,'bad original');return result;
  };
  await assert.rejects(register(p,f.requestPath),/original bytes differ/);
  assert.equal(p.uploads,0);assert.equal(p.activeDownloads,0);assert.ok(p.maxDownloads<=3);
  assert.equal(await fs.readFile(stateFile,'utf8'),previousState);assert.equal(await fs.readFile(responseFile,'utf8'),previousResponse);
  await assert.rejects(fs.access(path.join(f.registered,'browser-upload.lock')));
});

test('changed saved screenshot fails before batch downloads or upload', async t=>{
  const f=await manyFixture(t),p=new MockPage();const response=await register(p,f.requestPath);resetCalls(p);
  await fs.writeFile(path.join(f.root,response.assets[4].evidence.path),'tampered screenshot');
  await assert.rejects(register(p,f.requestPath),/evidence changed/);
  assert.equal(p.uploads,0);assert.equal(p.calls.fetch,0);
});

test('reject unsafe titles, paths and mixed repositories', async t=>{
  for(const title of ['../escape','a/b','a\\b','x\u0000z'])assert.throws(()=>assertTitle(title));
  assert.throws(()=>repository({repository_ids:['123']},[{repository_id:'456'}]),/Ambiguous/);
  assert.equal(cleanURL('https://cdn.example/a.png?auth_key=secret#x'),'https://cdn.example/a.png');
  const f=await fixture(t);await assert.rejects(safeFile(f.root,'../outside.png'));
  await fs.symlink(path.join(f.registered,'request.json'),path.join(f.root,'assets/link.json'));
  assert.ok(await safeFile(f.root,'assets/link.json'));
});

test('observes real response contract and searches through UI, no API replay', async()=>{
  const p=new MockPage([{id:'99',repository_id:'123',title:'Exact'}]);
  const o=await observe(p);assert.equal(o.repository_id,'123');assert.equal((await lookup(p,o,'Exact')).id,'99');
  p.rows.push({id:'100',repository_id:'123',title:'Exact'});await assert.rejects(lookup(p,o,'Exact'),/Duplicate/);
});

test('one upload, original bytes verified, restart preserves existing evidence', async t=>{
  const f=await fixture(t),p=new MockPage();
  const result=await register(p,f.requestPath);assert.equal(p.uploads,1);assert.equal(result.assets[0].state,'verified');
  assert.equal(result.assets[0].url,'https://cdn.example/asset.png');
  const again=await register(p,f.requestPath);assert.equal(p.uploads,1);assert.deepEqual(again,result);
  const saved=JSON.parse(await fs.readFile(path.join(f.registered,'browser-upload-state.json'),'utf8'));
  assert.equal(saved.pending,undefined);
});

test('uncertain prior upload never resubmits and stale token fails', async t=>{
  const f=await fixture(t),p=new MockPage();
  await json(path.join(f.registered,'browser-upload-state.json'),{token:f.request.token,repository_id:'123',pending:'a',assets:[]});
  await assert.rejects(register(p,f.requestPath),/Uncertain upload/);assert.equal(p.uploads,0);
  await json(path.join(f.registered,'browser-upload-state.json'),{token:'stale',assets:[]});
  await assert.rejects(register(p,f.requestPath),/changed/);assert.equal(p.uploads,0);
});

test('pending confirmed upload recovers without resend; original hash mismatch fails', async t=>{
  const f=await fixture(t),p=new MockPage([{id:'42',repository_id:'123',title:f.request.assets[0].title,origin_info:{url:'https://cdn.example/a.png'}}]);
  await json(path.join(f.registered,'browser-upload-state.json'),{token:f.request.token,repository_id:'123',pending:'a',assets:[]});
  assert.equal((await register(p,f.requestPath)).assets[0].asset_id,'42');assert.equal(p.uploads,0);
  p.fetch=async (url,{saveAs})=>{await fs.writeFile(saveAs,'changed server bytes');return {ok:true};};
  await assert.rejects(register(p,f.requestPath),/original bytes differ/);assert.equal(p.uploads,0);
});

test('optional repository binds actual library before upload without modifying request', async t=>{
  const f=await fixture(t),p=new MockPage();f.request.repository_id=null;await json(f.requestPath,f.request);
  const originalRequest=await fs.readFile(f.requestPath,'utf8');
  const upload=p.setInputFiles.bind(p);
  p.setInputFiles=async (...args)=>{
    const saved=JSON.parse(await fs.readFile(path.join(f.registered,'browser-upload-state.json'),'utf8'));
    assert.equal(saved.repository_id,'123');assert.equal(saved.pending,'a');
    return upload(...args);
  };
  const response=await register(p,f.requestPath);
  assert.equal(response.assets[0].repository_id,'123');assert.equal(p.uploads,1);
  assert.equal(await fs.readFile(f.requestPath,'utf8'),originalRequest);
  assert.equal((await register(p,f.requestPath)).assets[0].asset_id,response.assets[0].asset_id);assert.equal(p.uploads,1);
});

test('persisted optional library binding refuses changed current library before upload', async t=>{
  const f=await fixture(t),p=new MockPage();f.request.repository_id=null;await json(f.requestPath,f.request);
  const state={token:f.request.token,repository_id:'123',assets:[]};
  await json(path.join(f.registered,'browser-upload-state.json'),state);p.repo='456';
  await assert.rejects(register(p,f.requestPath),/differs from persisted upload binding/);assert.equal(p.uploads,0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.registered,'browser-upload-state.json'),'utf8')),state);
});

test('explicit library mismatch and unbound prior uploads refuse guessing', async t=>{
  const f=await fixture(t),p=new MockPage();p.repo='456';
  await assert.rejects(register(p,f.requestPath),/Explicit request repository/);assert.equal(p.uploads,0);
  for (const previous of [{pending:'a',assets:[]},{assets:[{id:'a',repository_id:'123',asset_id:'42'}]}]) {
    await json(path.join(f.registered,'browser-upload-state.json'),{token:f.request.token,...previous});
    await assert.rejects(register(p,f.requestPath),/Unknown repository binding/);assert.equal(p.uploads,0);
  }
});

test('orphaned prior response fails without uploading', async t=>{
  const f=await fixture(t),p=new MockPage();
  await json(path.join(f.registered,'response.json'),{token:f.request.token,assets:[]});
  await assert.rejects(register(p,f.requestPath),/Orphaned/);assert.equal(p.uploads,0);
});

test('changed final file and concurrent lock fail before upload', async t=>{
  const f=await fixture(t),p=new MockPage();
  await fs.writeFile(path.join(f.root,'assets/a.png'),'changed');
  await assert.rejects(register(p,f.requestPath),/Changed\/non-PNG/);assert.equal(p.uploads,0);
  await fs.writeFile(path.join(f.registered,'browser-upload.lock'),'uncertain');
  await assert.rejects(register(p,f.requestPath),/already running or uncertain/);assert.equal(p.uploads,0);
});
