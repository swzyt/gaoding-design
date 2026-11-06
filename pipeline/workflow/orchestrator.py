# -*- coding: utf-8 -*-
"""Durable end-to-end controller. Agent writes evidence gates; deterministic stages auto-advance."""
import argparse,contextlib,fcntl,hashlib,json,os,subprocess,sys,time,threading,shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from jobs import run,download_resources
from localize import localize
from research_cache import download,lookup,store,sha,digest
from parallel import execute
ROOT=Path(__file__).resolve().parents[1]
EGO=shutil.which('ego-browser') or str(Path.home()/'.local/bin/ego-browser')
DATA=Path(os.environ.get('GAODING_DATA_DIR',ROOT)).expanduser().resolve()
def read(p):return json.loads(Path(p).read_text())
def write(p,v):
 p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(v,ensure_ascii=False,indent=2));tmp.replace(p)
@contextlib.contextmanager
def locked(path):
 Path(path).parent.mkdir(parents=True,exist_ok=True)
 with open(path,'a') as file:
  try:fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise RuntimeError('Already running / editor busy: '+str(path))
  yield
class Controller:
 def __init__(self,root,space,repository,watch,workers,topic=None):
  self.root=Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True);self.file=self.root/'run.json';self.watch=watch;self.workers=workers;self.mutex=threading.Lock()
  self.state=read(self.file) if self.file.exists() else {'started_at':time.time(),'space':space,'repository_id':str(repository),'stages':{},'status':'running','timing_includes_agent_wait':True}
  if self.state['space']!=space or self.state['repository_id']!=str(repository):raise ValueError('Resume must use original space and repository')
  topics=read(ROOT/'topics.json');selected=topics.get(topic,{}).get('topic',topic)
  if selected is not None and selected not in [t['topic'] for t in topics.values()]:raise ValueError('Unknown topic: '+str(topic))
  if self.file.exists() and self.state.get('requested_topic')!=selected:raise ValueError('Resume must use original topic selection')
  self.state['requested_topic']=selected;self.topic_names=[selected] if selected else [t['topic'] for t in topics.values()]
  self.save();self.research=self.root/'research';self.cache=DATA/'research-cache'
 def save(self):write(self.file,self.state)
 def event(self,kind,**data):
  with self.mutex:
   with open(self.root/'events.jsonl','a') as f:f.write(json.dumps(dict(at=time.time(),event=kind,**data),ensure_ascii=False)+'\n')
 def stage(self,name,fn):
  previous=self.state['stages'].get(name,{})
  if previous.get('state')=='done':return previous.get('result')
  start=time.time();self.state['status']='running';self.state['current']=name;self.state['stages'][name]={'state':'running','started_at':start};self.save();self.event('stage_start',stage=name)
  try:result=fn()
  except Exception as e:
   self.state['stages'][name].update(state='attention',error=str(e));self.state['status']='attention';self.save();self.event('stage_error',stage=name,error=str(e));raise
  self.state['stages'][name].update(state='done',ended_at=time.time(),seconds=time.time()-start,result=result);self.save();self.event('stage_done',stage=name);return result
 def cmd(self,args):
  subprocess.run([sys.executable,str(ROOT/'workflow/run.py'),*map(str,args)],check=True);return True
 def browser(self,phase,recipe):
  with locked(DATA/'.editor.lock'):return self.cmd(['browser',phase,recipe,'--space',self.state['space']])
 def gate(self,name,inputs,instructions):
  gate=self.root/'gates'/name;gate.mkdir(parents=True,exist_ok=True)
  expected={str(Path(p).resolve()):sha(p) for p in inputs};token=digest(expected)
  request={'name':name,'input_sha256':expected,'token':token,'instructions':instructions,'response_fields':{'passed':True,'token':token,'checks':['specific observed findings']}}
  old=gate/'request.json'
  if old.exists() and read(old)!=request and (gate/'response.json').exists():raise ValueError('Gate inputs changed; archive obsolete response and review again: '+name)
  write(old,request);self.state['status']='waiting_agent';self.state['gate']=str(gate);self.save();print('AGENT_GATE '+str(gate),flush=True)
  while not (gate/'response.json').exists():
   if not self.watch:raise RuntimeError('Waiting for Agent gate: '+str(gate))
   time.sleep(2)
  response=read(gate/'response.json')
  if response.get('passed') is not True or response.get('token')!=token or not response.get('checks'):raise ValueError('Gate failed or stale: '+name)
  if any(sha(p)!=value for p,value in expected.items()):raise ValueError('Gate input changed during review')
  self.state['status']='running';self.state.pop('gate',None);self.save();return response
 def collect(self):
  self.research.mkdir(exist_ok=True)
  script=f"const p=(await taskSpace({self.state['space']})).page('p1'); const m=await import({json.dumps(str(ROOT/'workflow/research_collect.js'))});console.log(await m.default.collect(p,{json.dumps(str(self.research))},{json.dumps(self.topic_names,ensure_ascii=False)}));"
  with locked(DATA/'.editor.lock'):subprocess.run([EGO,'nodejs'],input=script,text=True,check=True)
  key=download(self.research,self.workers);hit=lookup(self.cache,key,self.research);write(self.research/'cache-status.json',{'key':key,'hit':hit,'verified_live':True});return {'key':key,'hit':hit,'topic':read(self.research/'selection.json')['topic']}
 def job(self,node):
  start=time.time();self.event('job_start',job=node['id']);directory=Path(node['directory']);result=run(directory,node['tool'],node['input']);resources=download_resources(directory,result)
  if node.get('localize'):
   source=next((r['file'] for r in resources if r['mimeType']=='application/json'),None)
   if not source:raise ValueError('Missing native JSON')
   localize(source,node['localize'])
  self.event('job_done',job=node['id'],seconds=time.time()-start,taskId=result.get('taskId'));return resources
 def batch(self,nodes):
  paths=[str(Path(n['directory']).resolve()) for n in nodes]
  if len(paths)!=len(set(paths)):raise ValueError('Each parallel task must have its own durable directory')
  return execute(nodes,self.job,self.workers)
 def run(self):
  if self.state.get('status')=='complete':
   self.report();print(json.dumps({'status':'complete','elapsed_seconds':self.state['elapsed_seconds'],'directory':str(self.root)},ensure_ascii=False));return
  research=self.stage('research_collect',self.collect)
  def creative():
   self.gate('01-creative',[self.research/'live.json',self.research/'sources.json'],
    'Inspect all ten images and complete rules. If cache miss write analysis.md and research-review.json (passed:true, samples:ten individual analyses). Write research/creative-brief.json with ONE original concept, complete unmodified master_prompt and layer plan. Existing generate_masters.py schema applies. Cache hit reuses verified research only, never old prompt. Review rules and image evidence before accepting.')
   store(self.cache,research['key'],self.research)
   self.cmd(['masters',self.research/'creative-brief.json',self.root/'build','--check'])
   brief=read(self.research/'creative-brief.json');assert len(brief['concepts'])==1
   return str(self.root/'build'/brief['concepts'][0]['id'])
  concept=Path(self.stage('creative',creative));recipe=concept/'release-recipe.json';out=concept/'release'
  self.stage('master',lambda:self.cmd(['masters',self.research/'creative-brief.json',self.root/'build']))
  self.stage('master_review',lambda:self.gate('02-master',[concept/'master.jpg',self.research/'creative-brief.json'],'View actual master. Assess composition, anatomy, correct copy, depth, material quality and feasibility of separate objects. Fail rather than accept a weak master.'))
  def split():
   nodes=[{'id':name,'directory':str(concept/(name+'-job')),'tool':'image.layers','input':dict(model=model,image=(concept/'master.jpg').as_uri(),host_application='codex',**extra),'localize':str(concept/name)} for name,model,extra in [('layout','image-layers-layout',{}),('objects','image-layers-smart',{'maxLayers':12})]]
   return self.batch(nodes)
  self.stage('parallel_split',split)
  # Repair batches are Agent-authored, optional, and also run through the same durable queue.
  iteration=1
  while True:
   def materials():return self.gate('03-materials-%02d'%iteration,[concept/'master.jpg',concept/'objects/catalog.json',concept/'layout/catalog.json'],
    'Inspect each actual split asset at useful resolution; native text and all main objects must be independent. Write release-recipe.json matching mother composition. If targeted repairs needed, response.action="repair" and response.jobs=[{id,directory,tool,input,localize?}]; no blind full regeneration. Otherwise action="build". Required layer_audit.pairs=[{subject:semantic name,background:semantic name}] must cover each main subject/background or independently editable major object. Exact source classification original_ai/original required per image/shape. All copy native editable text.')
   answer=self.stage('materials_%02d'%iteration,materials)
   if answer.get('action')=='repair':self.stage('repair_%02d'%iteration,lambda:self.batch(answer['jobs']));iteration+=1;continue
   if answer.get('action')!='build' or not recipe.exists():raise ValueError('Missing approved recipe')
   break
  self.stage('build',lambda:self.cmd(['build',recipe]))
  def prep():
   # Registration, provenance generation and editor import/fonts have no mutual dependency.
   nodes=[{'id':'register'},{'id':'receipts'},{'id':'editor'}]
   return execute(nodes,lambda n:self.cmd(['register',recipe,'--repository-id',self.state['repository_id']]) if n['id']=='register' else self.cmd(['receipts',concept]) if n['id']=='receipts' else self.browser('prepare',recipe),self.workers)
  self.stage('parallel_prepare',prep)
  self.stage('bind_assets',lambda:self.browser('bind',recipe))
  self.stage('layer_audit',lambda:self.browser('audit',recipe))
  def final_review():
   inputs=[out/'layer-audit/audit.json',*sorted((out/'layer-audit').glob('*.png')),out/'spec.json',out/'bound-assets.json',out/'editor-materials-bound.png',out/'registered-assets.json',recipe]+sorted(out.glob('editor-bound-*.png'))
   self.gate('04-final',inputs,'View every layer-audit hide screenshot and restored-after-reload.png, judge actual separation and absence of embedded duplicate subjects/backgrounds. View editor screenshot and compare mother. Check all image layers, alpha edges, native editable copy, spelling, dimensions, spacing, font replacement, no unintended crop. Write release/visual-review.json (passed,spec_sha256) and material-review.json (passed,bindings_sha256) with screenshot and specific checks. Verify real provenance of every asset. Copyright count must later equal image count; this gate cannot bypass it.')
   for name,key,path in [('visual-review','spec_sha256',out/'spec.json'),('material-review','bindings_sha256',out/'bound-assets.json')]:
    review=read(out/(name+'.json'))
    if review.get('passed') is not True or review.get(key)!=sha(path):raise ValueError('Stale visual/material review')
   return True
  self.stage('final_review',final_review)
  self.stage('copyright_and_form',lambda:self.browser('form',recipe))
  self.stage('submit',lambda:self.browser('submit',recipe))
  self.stage('complete_declaration',lambda:self.browser('declare',recipe))
  self.stage('reopen_verify',lambda:self.browser('verify',recipe))
  def package():
   subprocess.run([sys.executable,str(ROOT/'workflow/package_delivery.py'),str(self.root/'delivery'),'--concept',str(concept),'--research',str(self.research)],check=True)
   return str(self.root/'delivery')
  self.stage('package',package)
  self.state.update(status='complete',completed_at=time.time(),elapsed_seconds=time.time()-self.state['started_at']);self.save();self.report();print(json.dumps(self.state,ensure_ascii=False,indent=2),flush=True)
 def report(self):
  events=[json.loads(x) for x in (self.root/'events.jsonl').read_text().splitlines()] if (self.root/'events.jsonl').exists() else [];jobs=[e for e in events if e['event']=='job_done']
  active={};attempts=[]
  for e in events:
   if e['event']=='stage_start':active[e['stage']]=e['at']
   elif e['event'] in ('stage_done','stage_error') and e['stage'] in active:attempts.append({'stage':e['stage'],'result':e['event'],'seconds':e['at']-active.pop(e['stage'])})
  report={'stage_attempts':attempts,'wall_seconds':self.state.get('elapsed_seconds',time.time()-self.state['started_at']),'includes_agent_wait':True,'stages':{k:sum(a['seconds'] for a in attempts if a['stage']==k) for k in self.state['stages']},'jobs':jobs,'cache':self.state['stages'].get('research_collect',{}).get('result'),'note':'Single measured run, not a controlled full-workflow A/B test; development excluded; repairs and review included.'}
  write(self.root/'timing-report.json',report)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);p.add_argument('--space',type=int,required=True);p.add_argument('--repository-id',required=True);p.add_argument('--watch',action='store_true');p.add_argument('--workers',type=int,default=3);p.add_argument('--topic');a=p.parse_args()
 if not 1<=a.workers<=6:p.error('workers must be 1..6')
 with locked(a.directory/'.run.lock'):
  controller=Controller(a.directory,a.space,a.repository_id,a.watch,a.workers,a.topic)
  try:controller.run()
  finally:controller.report()
if __name__=='__main__':main()
