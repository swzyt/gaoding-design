# -*- coding: utf-8 -*-
"""Durable end-to-end controller. Agent writes evidence gates; deterministic stages auto-advance."""
import argparse,contextlib,fcntl,hashlib,json,os,subprocess,sys,time,threading,shutil,tempfile,stat,uuid
from datetime import datetime,timezone
from urllib.parse import urlparse,parse_qs
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
def inspect_browser_spaces():
 """Obtain fresh ownership facts without claiming a space or touching any page."""
 script="console.log('GAODING_SPACE_INVENTORY:'+JSON.stringify((await listTaskSpaces()).map(s=>({id:s.id,ownership:s.ownership}))));"
 result=subprocess.run([EGO,'nodejs'],input=script,text=True,capture_output=True,check=True,timeout=30)
 lines=(result.stdout+'\n'+result.stderr).splitlines()
 rows=[line[len('GAODING_SPACE_INVENTORY:'):] for line in lines if line.startswith('GAODING_SPACE_INVENTORY:')]
 if len(rows)!=1:raise RuntimeError('Browser returned no unambiguous live TaskSpace inventory')
 spaces=json.loads(rows[0])
 if not isinstance(spaces,list) or any(not isinstance(s,dict) or type(s.get('id')) is not int or s['id']<0 or s.get('ownership') not in ('agent','user') for s in spaces):raise ValueError('Invalid live TaskSpace inventory')
 if len({s['id'] for s in spaces})!=len(spaces):raise ValueError('Duplicate TaskSpace IDs in browser inventory')
 return {'checked_at':datetime.now(timezone.utc).isoformat(),'spaces':spaces}

def process_alive(pid):
 if type(pid) is not int or pid<=0:raise ValueError('Invalid recorded workflow PID')
 try:os.kill(pid,0)
 except ProcessLookupError:return False
 except PermissionError:return True
 return True

def positive_id(value,role):
 if isinstance(value,bool) or not isinstance(value,(str,int)) or not str(value).isdigit() or int(value)<=0:raise ValueError('Invalid '+role+' ID')
 return str(value)

def design_id_from_url(url):
 parsed=urlparse(url) if isinstance(url,str) else None
 ids=parse_qs(parsed.query).get('id',[]) if parsed else []
 if not parsed or parsed.scheme!='https' or parsed.netloc not in ('www.gaoding.com','gaoding.com') or parsed.path!='/editor/design' or len(ids)!=1:raise ValueError('Recovery requires the existing permanent Gaoding editor URL with one design ID')
 return positive_id(ids[0],'permanent design')

def publication_cms_identity(out,editor,design_id):
 """Require observed CMS metadata linked to the original design; the two IDs have different roles."""
 file=out/'publication.json'
 if not file.exists():return None
 publication=read(file)
 if publication.get('designUrl') and design_id_from_url(publication['designUrl'])!=design_id:raise ValueError('Saved publication URL conflicts with permanent editor URL')
 observed=publication.get('metadataObserved')
 has_cms=publication.get('contentId') is not None or observed is not None
 if not has_cms:
  if publication.get('published') is True:raise ValueError('Published work has an unknown CMS/design mapping')
  return None
 cms_id=positive_id(publication.get('contentId'),'CMS content')
 if not isinstance(observed,dict) or positive_id(observed.get('content_id'),'observed CMS content')!=cms_id:raise ValueError('Unknown or conflicting CMS publication mapping')
 if not publication.get('designUrl') or not observed.get('designUrl') or design_id_from_url(observed['designUrl'])!=design_id:raise ValueError('Unknown or conflicting CMS/design mapping')
 if observed.get('evidenceFile')!='publication-metadata.json':raise ValueError('CMS mapping requires its original publication metadata evidence')
 evidence_file=out/'publication-metadata.json'
 if evidence_file.resolve().parent!=out.resolve():raise ValueError('CMS metadata evidence escapes the release directory')
 evidence=read(evidence_file);source=observed.get('source')
 if source not in ('content','versions') or evidence.get('source')!=source or not observed.get('observedAt') or evidence.get('observedAt')!=observed['observedAt']:raise ValueError('CMS publication observation does not match its metadata evidence')
 latest=evidence.get('latest')
 if not isinstance(latest,dict) or positive_id(latest.get('content_id'),'metadata CMS content')!=cms_id:raise ValueError('CMS content ID conflicts with observed metadata evidence')
 if source=='content':raw_id=(evidence.get('content') or {}).get('id')
 else:
  versions=evidence.get('versions');raw_id=versions[0].get('content_id') if isinstance(versions,list) and versions and isinstance(versions[0],dict) else None
 if positive_id(raw_id,'source CMS content')!=cms_id:raise ValueError('CMS content ID conflicts with original response')
 if editor.get('contentId') is not None and positive_id(editor['contentId'],'editor CMS content')!=cms_id:raise ValueError('Editor CMS content ID conflicts with publication metadata')
 return cms_id

def recovery_editor(root,state):
 """Locate the existing concept and permanent work, never create or import a new one."""
 concepts=[]
 for stage in ('native_creative','creative'):
  value=state.get('stages',{}).get(stage,{}).get('result')
  if isinstance(value,str):
   concept=Path(value).resolve()
   if not concept.is_relative_to(root):raise ValueError('Saved concept is outside this run directory')
   if concept not in concepts:concepts.append(concept)
 if len(concepts)!=1:raise ValueError('Recovery requires one existing concept from the original creative stage')
 concept=concepts[0];recipe=concept/'release-recipe.json'
 out=(concept/(read(recipe).get('output','release') if recipe.exists() else 'release')).resolve()
 if not out.is_relative_to(concept):raise ValueError('Saved release directory escapes its concept')
 editor_file=out/'editor-state.json';editor=read(editor_file)
 url=editor.get('url');design_id=design_id_from_url(url)
 if editor.get('designId') is not None and positive_id(editor['designId'],'saved design')!=design_id:raise ValueError('Saved design ID conflicts with permanent editor URL')
 cms_id=publication_cms_identity(out,editor,design_id)
 # content_id is retained only as a tagged legacy design-ID alias; it never denotes the CMS ID here.
 return {'url':url,'design_id':design_id,'cms_content_id':cms_id,'content_id':design_id,'content_id_role':'design_id','editor_state':str(editor_file),'editor_state_sha256':hashlib.sha256(editor_file.read_bytes()).hexdigest()}

def recover_space(directory,previous_space,space,user_authorized=False):
 """Recover a disappeared browser space after explicit authorization; preserve every stage."""
 if user_authorized is not True:raise ValueError('Space recovery requires explicit --user-authorized')
 if type(previous_space) is not int or type(space) is not int or min(previous_space,space)<0 or previous_space==space:raise ValueError('Previous and replacement space IDs must be distinct nonnegative integers')
 root=Path(directory).resolve();file=root/'run.json'
 if not file.is_file():raise ValueError('Recovery requires an existing run.json')
 with locked(root/'.run.lock'),locked(DATA/'.editor.lock'):
  # These are exclusive-create markers, unlike the persistent advisory .run.lock file.
  markers=[root/'.plugin-launch.lock',root/'run.json.tmp',root/'space-recovery-history.json.tmp']
  markers.extend(p for p in root.rglob('*.lock') if p.resolve() not in ((root/'.run.lock').resolve(),(DATA/'.editor.lock').resolve()))
  if any(p.exists() for p in markers):raise RuntimeError('Uncertain writer/launch lock exists; reconcile it before space recovery')
  before=file.read_bytes();state=json.loads(before)
  if state.get('space')!=previous_space:raise ValueError('Previous space does not match the saved run')
  receipt_file=root/'.plugin-process.json';receipt=read(receipt_file) if receipt_file.exists() else None
  if receipt is not None and not isinstance(receipt,dict):raise ValueError('Invalid workflow process receipt')
  pids=[receipt[k] for k in ('pid','childPid') if receipt and receipt.get(k) is not None]
  if any(process_alive(pid) for pid in pids) or (state.get('controller_pid') is not None and process_alive(state['controller_pid'])):raise RuntimeError('Workflow process is still active; stop it before space recovery')
  exited=bool(receipt and (pids or receipt.get('finishedAt')))
  if receipt and not exited:raise RuntimeError('Workflow launch state is uncertain; verify process exit before recovery')
  if state.get('status')=='running' and not exited:raise RuntimeError('Running state requires durable evidence that the workflow process exited')
  editor=recovery_editor(root,state)
  inventory=inspect_browser_spaces()
  spaces=inventory['spaces']
  if any(s['id']==previous_space for s in spaces):raise ValueError('Previous TaskSpace still exists; recovery must reuse it')
  replacement=[s for s in spaces if s['id']==space]
  if len(replacement)!=1 or replacement[0].get('ownership')!='agent':raise ValueError('Replacement TaskSpace must exist and be Agent-owned')
  history_file=root/'space-recovery-history.json';history=read(history_file) if history_file.exists() else []
  if not isinstance(history,list) or any(not isinstance(row,dict) or row.get('status')!='applied' for row in history):raise ValueError('Uncertain recovery history; inspect it before another recovery')
  if history:catalog_goal_spaces(root,state)
  updated=dict(state,space=space)
  after=json.dumps(updated,ensure_ascii=False,indent=2).encode()
  record={'status':'prepared','at':datetime.now(timezone.utc).isoformat(),'user_authorized':True,'previous_space':previous_space,'space':space,**editor,'browser_verification':inventory,'before_run_sha256':hashlib.sha256(before).hexdigest(),'after_run_sha256':hashlib.sha256(after).hexdigest()}
  if file.read_bytes()!=before:raise RuntimeError('Run changed during recovery; no recovery was applied')
  # Persist intent first. A crash leaves explicit evidence, never an unrecorded space change.
  write(history_file,[*history,record])
  write(file,updated)
  record['status']='applied';write(history_file,[*history,record])
  return {'directory':str(root),'space':space,'previous_space':previous_space,'design_id':editor['design_id'],'cms_content_id':editor['cms_content_id'],'content_id':editor['content_id'],'content_id_role':'design_id','url':editor['url'],'history':str(history_file),'resume_instructions':'Resume with the original workflow arguments, changing only --space to '+str(space)+'. Do not edit the original subscription or repeat completed stages.'}

def validate_recovery_identity(record,editor):
 """Old records used content_id for the design ID; keep their bytes and validate that role explicitly."""
 design_id=record.get('design_id',record.get('content_id'))
 if positive_id(design_id,'recovery design')!=editor['design_id']:raise ValueError('Recovery history does not belong to this goal and work')
 if record.get('content_id_role') not in (None,'design_id'):raise ValueError('Unknown recovery content ID role')
 if record.get('content_id') is not None and positive_id(record['content_id'],'legacy recovery design')!=editor['design_id']:raise ValueError('Recovery history legacy design ID conflicts')
 if Path(record.get('editor_state','')).resolve()!=Path(editor['editor_state']).resolve():raise ValueError('Recovery history does not belong to this goal and work')
 if design_id_from_url(record.get('url'))!=editor['design_id']:raise ValueError('Recovery history identifies a different work')
 if record.get('cms_content_id') is not None and positive_id(record['cms_content_id'],'recovery CMS content')!=editor.get('cms_content_id'):raise ValueError('Original CMS content ID changed or its mapping is unknown')

def catalog_goal_spaces(root,state):
 """Only the current space and its authorized, same-work recovery ancestors belong to this goal."""
 space=state.get('space')
 if type(space) is not int or space<0:raise ValueError('Completed goal has no valid browser space')
 allowed={space};history_file=root/'space-recovery-history.json'
 if not history_file.exists():return allowed
 history=read(history_file)
 if not isinstance(history,list):raise ValueError('Invalid space recovery history')
 editor=None;cursor=space
 for record in reversed(history):
  if not isinstance(record,dict) or record.get('status')!='applied' or record.get('user_authorized') is not True or record.get('space')!=cursor:continue
  old=record.get('previous_space')
  if type(old) is not int or old<0 or old in allowed:raise ValueError('Invalid authorized recovery chain')
  if editor is None:editor=recovery_editor(root,state)
  validate_recovery_identity(record,editor)
  allowed.add(old);cursor=old
 return allowed

def cleanup_catalog_space(root,state):
 """Release this completed goal's cache binding; warnings must never undo a verified publication."""
 root=Path(root).resolve()
 if state.get('status')!='complete' or any(state.get('stages',{}).get(name,{}).get('state')!='done' for name in ('reopen_verify','package')):return {'status':'skipped','reason':'goal verification and package are not complete'}
 report={'at':datetime.now(timezone.utc).isoformat(),'space':state.get('space')}
 try:
  if type(state.get('space')) is not int or state['space']<0:raise ValueError('Completed goal has no valid browser space')
  data=Path(DATA).resolve();directory=data/'catalog';file=directory/'topics.json'
  if directory.is_symlink() or file.is_symlink() or directory.resolve()!=directory:raise ValueError('Catalog cleanup refuses a symlink or escaped data path')
  if not file.exists():report.update(status='not-present')
  else:
   lock=directory/'.space-cleanup.lock'
   if lock.is_symlink():raise ValueError('Catalog cleanup lock is a symlink')
   with locked(lock):
    before=file.read_bytes();catalog=json.loads(before)
    if not isinstance(catalog,dict):raise ValueError('Invalid topic catalog object')
    bound=catalog.get('space')
    if 'space' not in catalog:report.update(status='already-unbound')
    elif type(bound) is not int or (bound!=state['space'] and bound not in catalog_goal_spaces(root,state)):report.update(status='different-goal',catalog_space=bound)
    else:
     updated=dict(catalog);del updated['space']
     temp_path=None
     try:
      with tempfile.NamedTemporaryFile(mode='w',encoding='utf8',dir=directory,prefix='.topics-cleanup-',suffix='.tmp',delete=False) as temp:
       temp_path=Path(temp.name);os.chmod(temp_path,stat.S_IMODE(file.stat().st_mode));json.dump(updated,temp,ensure_ascii=False,indent=2);temp.flush();os.fsync(temp.fileno())
      if file.is_symlink() or file.read_bytes()!=before:raise RuntimeError('Catalog changed during cleanup; leaving the new goal binding untouched')
      temp_path.replace(file);report.update(status='cleared',catalog_space=bound)
     finally:
      if temp_path is not None and temp_path.parent==directory and temp_path.name.startswith('.topics-cleanup-') and temp_path.exists():temp_path.unlink()
 except Exception as error:
  report.update(status='warning',error=str(error));print('CATALOG_SPACE_CLEANUP_WARNING '+str(error),file=sys.stderr,flush=True)
 try:write(root/'catalog-space-cleanup.json',report)
 except Exception as error:print('CATALOG_SPACE_CLEANUP_WARNING cannot persist diagnostic: '+str(error),file=sys.stderr,flush=True)
 return report

class AgentGatePending(RuntimeError):
 """A durable handoff is pending; this is a pause, not a failed machine operation."""

def complete_empty_native_handoff(concept):
 """Skip only an explicit empty handoff; never replace an uncertain/existing response."""
 from agent_assets import safe_path
 root=Path(concept).resolve();safe_path(root,'agent-assets/request.json')
 lock=root/'agent-assets/prepare.lock'
 try:fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 except FileExistsError as error:raise RuntimeError('Uncertain handoff preparation; inspect prepare.lock') from error
 try:
  os.close(fd)
  if (root/'agent-assets/submission-started').exists():raise RuntimeError('Uncertain asset submission; recover it before empty handoff completion')
  return _complete_empty_native_handoff_locked(root)
 finally:lock.unlink()

def _complete_empty_native_handoff_locked(root):
 from agent_assets import safe_path,atomic_json,validate
 plan=read(safe_path(root,'asset-plan.json'));request=read(safe_path(root,'agent-assets/request.json'))
 planned=plan.get('assets') if isinstance(plan,dict) else None
 if not isinstance(planned,list) or any(not isinstance(row,dict) for row in planned):raise ValueError('Invalid frozen native asset plan')
 if planned:return False
 if request.get('schema_version')!=1 or not isinstance(request.get('token'),str) or not request['token'] or request.get('plan')!=plan or request.get('plan_sha256')!=sha(root/'asset-plan.json'):raise ValueError('Stale or mismatched empty asset request')
 snapshot=read(safe_path(root,'native-input.json'));concepts=snapshot.get('brief',{}).get('concepts',[])
 if len(concepts)!=1 or concepts[0].get('asset_plan',{'assets':[]})!=plan:raise ValueError('Empty asset plan differs from frozen native design input')
 variants=concepts[0].get('layout_variants',[])
 if not isinstance(variants,list) or not 2<=len(variants)<=4:raise ValueError('Empty handoff still requires two to four frozen layout variants')
 recipes=[];names=set()
 for variant in variants:
  filename=variant.get('recipe') if isinstance(variant,dict) else None
  if not isinstance(filename,str) or Path(filename).name!=filename or not filename.endswith('.json') or filename=='release-recipe.json' or filename in names:raise ValueError('Invalid frozen layout recipe path')
  names.add(filename);candidate=root/filename
  if not candidate.exists():return False
  recipe=read(safe_path(root,filename));layers=recipe.get('layers')
  if not isinstance(layers,list) or not layers or any(not isinstance(row,dict) or row.get('type') not in ('shape','text') for row in layers) or not any(row.get('type')=='text' for row in layers):return False
  recipes.append(recipe)
 responses=[root/'external-assets.json',root/'agent-assets/response.json']
 if not any(file.exists() for file in responses):
  destination=responses[1]
  if not destination.resolve().is_relative_to(root):raise ValueError('Unsafe empty asset response path')
  atomic_json(destination,{'schema_version':1,'token':request['token'],'plan_sha256':request['plan_sha256'],'assets':[],'origin':'native-shapes-and-text','generated_by':'validated-empty-native-plan'})
 for recipe in recipes:validate(root,recipe)
 return True

class Controller:
 def __init__(self,root,space,repository,watch,workers,topic=None,mode=None,registration=None,topic_json=None):
  self.root=Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True);self.file=self.root/'run.json';self.watch=watch;self.workers=workers;self.mutex=threading.Lock()
  existing=read(self.file) if self.file.exists() else None
  mode=mode or ((existing or {}).get('mode','gd-cli') if existing else 'native')
  registration=registration or ((existing or {}).get('registration','gd-cli') if existing else ('agent' if mode=='native' else 'gd-cli'))
  if mode not in ('native','gd-cli') or registration not in ('agent','gd-cli'):raise ValueError('Unknown design or registration mode')
  if registration=='gd-cli' and not repository:raise ValueError('Actual repository ID required for CLI registration')
  repo=str(repository) if repository is not None else None
  self.state=existing or {'started_at':time.time(),'space':space,'repository_id':repo,'stages':{},'status':'running','timing_includes_agent_wait':True,'mode':mode,'registration':registration}
  if self.state['space']!=space or self.state['repository_id']!=repo:raise ValueError('Resume must use original space and repository')
  if existing and (self.state.get('mode','gd-cli')!=mode or self.state.get('registration','gd-cli')!=registration):raise ValueError('Resume must preserve design and registration modes')
  topics=read(ROOT/'topics.json');target=read(topic_json) if topic_json else None
  if target is not None:
   if not isinstance(target,dict) or not target.get('name') or not (target.get('key') or target.get('hub') or target.get('rules_url')):raise ValueError('Dynamic topic needs a name and stable key or live URL')
   if topic is not None and topic not in (target.get('key'),target['name']):raise ValueError('Topic key differs from frozen snapshot')
   selected=target['name']
  else:
   selected=topics.get(topic,{}).get('topic',topic)
   if selected is not None and selected not in [t['topic'] for t in topics.values()]:raise ValueError('Unknown topic: '+str(topic))
  if existing and (self.state.get('requested_topic')!=selected or self.state.get('topic_snapshot')!=target):raise ValueError('Resume must use original topic selection and snapshot')
  self.mode=mode;self.registration=registration
  self.state.update(mode=mode,registration=registration,requested_topic=selected)
  if target is not None:self.state['topic_snapshot']=target
  self.topic_names=[selected] if selected else [t['topic'] for t in topics.values()]
  self.topic_targets=[target] if target else self.topic_names
  self.save();self.research=self.root/'research';self.cache=DATA/'research-cache'
  self.session_id=uuid.uuid4().hex;self._span_local=threading.local();self._active_attempt_id=None
  self.event('controller_resume' if existing else 'controller_start',previous_status=(existing or {}).get('status'))
 def save(self):write(self.file,self.state)
 def event(self,kind,**data):
  with self.mutex:
   record=dict(at=time.time(),event=kind,session_id=getattr(self,'session_id',None));record.update(data)
   with open(self.root/'events.jsonl','a') as f:f.write(json.dumps(record,ensure_ascii=False)+'\n')
 @contextlib.contextmanager
 def span(self,category,name):
  stack=getattr(self._span_local,'stack',[]);span_id=uuid.uuid4().hex;start=time.perf_counter()
  self.event('span_start',span_id=span_id,category=category,name=name,parent_id=stack[-1] if stack else None,stage=self.state.get('current'),attempt_id=self._active_attempt_id)
  self._span_local.stack=[*stack,span_id]
  try:
   yield
  except BaseException:
   self.event('span_end',span_id=span_id,outcome='error',measured_seconds=time.perf_counter()-start);raise
  else:self.event('span_end',span_id=span_id,outcome='complete',measured_seconds=time.perf_counter()-start)
  finally:self._span_local.stack=stack
 def local(self,name,fn):
  with self.span('local',name):return fn()
 def stage(self,name,fn):
  previous=self.state['stages'].get(name,{})
  if previous.get('state')=='done':return previous.get('result')
  start=time.time();monotonic=time.perf_counter();attempt_id=uuid.uuid4().hex;old_active=self._active_attempt_id;self._active_attempt_id=attempt_id
  attempts=self.state.setdefault('stage_attempts',[])
  for old in attempts:
   if old.get('stage')==name and old.get('result')=='running':old['result']='interrupted'
  attempt={'attempt_id':attempt_id,'stage':name,'started_at':start,'result':'running'};attempts.append(attempt)
  self.state['status']='running';self.state['current']=name;self.state['stages'][name]={'state':'running','started_at':start,'attempt_id':attempt_id};self.save();self.event('stage_start',stage=name,attempt_id=attempt_id)
  try:
   try:result=fn()
   except Exception as error:
    pending=isinstance(error,AgentGatePending);kind='stage_pause' if pending else 'stage_error'
    attempt.update(result=kind,ended_at=time.time(),measured_seconds=time.perf_counter()-monotonic)
    self.state['stages'][name].update(state='waiting_agent' if pending else 'attention',error=str(error));self.state['status']='waiting_agent' if pending else 'attention';self.save();self.event(kind,stage=name,attempt_id=attempt_id,error=str(error));raise
   attempt.update(result='stage_done',ended_at=time.time(),measured_seconds=time.perf_counter()-monotonic)
   self.state['stages'][name].update(state='done',ended_at=attempt['ended_at'],seconds=attempt['ended_at']-start,result=result);self.save();self.event('stage_done',stage=name,attempt_id=attempt_id);return result
  finally:self._active_attempt_id=old_active
 def cmd(self,args):
  with self.span('command',str(args[0])):subprocess.run([sys.executable,str(ROOT/'workflow/run.py'),*map(str,args)],check=True)
  return True
 def browser(self,phase,recipe):
  with self.span('browser',phase):
   with locked(DATA/'.editor.lock'):return self.cmd(['browser',phase,recipe,'--space',self.state['space']])
 def browser_batch(self,sequence,recipe):
  recipe=Path(recipe).resolve()
  # run.py performs source/build/provenance preflight before opening the browser.
  logfile=self.root/'browser-sequence.jsonl'
  self.state['browser_sequence_logs']=[str(logfile)];self.save()
  args=['browser-batch',sequence,recipe,'--space',self.state['space'],'--log',logfile,
        '--attempt-id',self._active_attempt_id or uuid.uuid4().hex]
  if sequence.startswith('form,'):args.extend(['--final-review-gate',self.root/'gates/04-final'])
  with self.span('browser',sequence):
   with locked(DATA/'.editor.lock'):return self.cmd(args)
 def browser_group(self,name,sequence,legacy,recipe):
  # Existing independently checkpointed runs retain their original recovery path.
  # A batch has one durable stage; its journal never fabricates completed stages.
  if name in self.state['stages'] or not any(stage in self.state['stages'] for stage,_ in legacy):
   return self.stage(name,lambda:self.browser_batch(sequence,recipe))
  for stage,phase in legacy:self.stage(stage,lambda phase=phase:self.browser(phase,recipe))
 def gate(self,name,inputs,instructions):
  gate=self.root/'gates'/name;gate.mkdir(parents=True,exist_ok=True)
  expected={str(Path(p).resolve()):sha(p) for p in inputs};token=digest(expected)
  request={'name':name,'input_sha256':expected,'token':token,'instructions':instructions,'response_fields':{'passed':True,'token':token,'checks':['specific observed findings']}}
  old=gate/'request.json'
  if old.exists() and read(old)!=request and (gate/'response.json').exists():raise ValueError('Gate inputs changed; archive obsolete response and review again: '+name)
  response_file=gate/'response.json';requires_agent=not response_file.exists()
  self.event('gate_request',name=name,token=token,requires_agent=requires_agent)
  waits=self.state.setdefault('gate_waits',{});pending=None
  for wait_id,row in waits.items():
   if row.get('name')==name and row.get('status')=='pending':
    if row.get('token')==token:pending=(wait_id,row)
    else:
     row.update(status='invalidated',ended_at=time.time(),end_basis='request-invalidated')
     self.event('gate_wait_end',wait_id=wait_id,name=name,started_at=row['started_at'],ended_at=row['ended_at'],end_basis=row['end_basis'])
  if pending:
   self.event('gate_wait_resume',wait_id=pending[0],name=name,started_at=pending[1]['started_at'])
  elif requires_agent:
   wait_id=uuid.uuid4().hex;row={'name':name,'token':token,'started_at':time.time(),'status':'pending'};waits[wait_id]=row;pending=(wait_id,row)
   self.event('gate_wait_start',wait_id=wait_id,name=name,started_at=row['started_at'])
  write(old,request);self.state['status']='waiting_agent';self.state['gate']=str(gate);self.save();print('AGENT_GATE '+str(gate),flush=True)
  while not response_file.exists():
   if not self.watch:
    self.event('gate_wait_pending',wait_id=pending[0],name=name)
    raise AgentGatePending('Waiting for Agent gate: '+str(gate))
   time.sleep(2)
  if pending:
   wait_id,row=pending;row.update(status='response-observed',ended_at=max(row['started_at'],min(time.time(),response_file.stat().st_mtime)),end_basis='response-file-mtime-observed')
   self.save();self.event('gate_wait_end',wait_id=wait_id,name=name,started_at=row['started_at'],ended_at=row['ended_at'],end_basis=row['end_basis'])
  with self.span('local','gate-validation:'+name):
   response=read(response_file)
   if response.get('passed') is not True or response.get('token')!=token or not response.get('checks'):raise ValueError('Gate failed or stale: '+name)
   if any(sha(p)!=value for p,value in expected.items()):raise ValueError('Gate input changed during review')
  self.state['status']='running';self.state.pop('gate',None);self.save();return response
 def collect(self):
  if self.mode=='native' and not self.state.get('requested_topic'):raise ValueError('Select from the live catalog first; random native selection must freeze an explicitly authorized live topic snapshot')
  self.research.mkdir(exist_ok=True)
  script=f"const p=(await taskSpace({self.state['space']})).page('p1'); const m=await import({json.dumps(str(ROOT/'workflow/research_collect.js'))});console.log(await m.default.collect(p,{json.dumps(str(self.research))},{json.dumps(self.topic_targets,ensure_ascii=False)}));"
  with self.span('browser','research-collect'):
   with locked(DATA/'.editor.lock'):subprocess.run([EGO,'nodejs'],input=script,text=True,check=True)
  with self.span('local','research-download-cache'):
   key=download(self.research,self.workers);hit=lookup(self.cache,key,self.research);write(self.research/'cache-status.json',{'key':key,'hit':hit,'verified_live':True});return {'key':key,'hit':hit,'topic':read(self.research/'selection.json')['topic']}
 def job(self,node):
  start=time.time();self.event('job_start',job=node['id']);directory=Path(node['directory'])
  with self.span('provider',node['id']):result=run(directory,node['tool'],node['input']);resources=download_resources(directory,result)
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
   cleanup_catalog_space(self.root,self.state)
   self.report();print(json.dumps({'status':'complete','elapsed_seconds':self.state['elapsed_seconds'],'directory':str(self.root)},ensure_ascii=False));return
  if self.mode=='native':return self.run_native()
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
  return self.finish_design(concept)
 def run_native(self):
  import native_design
  from agent_assets import validate as validate_assets
  research=self.stage('research_collect',self.collect)
  def creative():
   self.gate('01-creative',[self.research/'live.json',self.research/'sources.json'],
    'Read all ten samples and current rules. Write analysis.md, research-review.json (passed:true,samples:ten individual analyses), creative-brief.json. ONE original concept with id,concept,reading_path,zones,copy,layers,palette,typography; explicitly freeze separation_contract:{schema_version:1,objects:[{id,layer_id,role,require_alpha,coverage?}]} from the requested independent objects, never substitute a whole scene for separate objects. Foreground requires require_alpha:true; background requires coverage:{box:[x,y,w,h],page?:id}. Each recipe layer echoes role and require_alpha, and every foreground object must be an audit subject. Explicit objects:[] is only for native text/shapes without external images. This structural contract is not visual approval; layout_variants has 2-4 items {id,recipe:root-level JSON filename,rationale}; asset_plan:{assets:[{id,source,require_alpha?}]} lists only external images. Write complete original prompts in that plan where needed. Plan real editable typography and independent full backgrounds/objects; no whole-image title baking. Compare native layout/color alternatives without paid full-poster generation. For an explicitly empty asset plan (pure native text/shapes), write all variant recipes under this run build/<concept-id>/ during this creative handoff so the controller can validate the empty asset response without a second preparation handoff; this never approves their appearance and 03-layout still requires actual visual comparison. Never attach research samples as production inputs. See native_design.py schema.')
   store(self.cache,research['key'],self.research)
   return self.local('native-design-prepare',lambda:native_design.prepare(self.research/'creative-brief.json',self.root/'build'))['concept']
  concept=Path(self.stage('native_creative',creative))
  def assets():
   if self.local('empty-native-handoff-validation',lambda:complete_empty_native_handoff(concept)):
    self.event('empty_asset_handoff_automated',handoff_id=sha(concept/'agent-assets/request.json'),name='02-assets',assets=0,gate_calls_avoided=1)
    for wait_id,row in self.state.get('gate_waits',{}).items():
     if row.get('name')=='02-assets' and row.get('status')=='pending':
      row.update(status='completed-automatically',ended_at=time.time(),end_basis='validated-empty-native-plan')
      self.event('gate_wait_end',wait_id=wait_id,name='02-assets',started_at=row['started_at'],ended_at=row['ended_at'],end_basis=row['end_basis'])
    if self.state.get('gate')==str(self.root/'gates/02-assets'):self.state.pop('gate')
    self.save();return self.local('asset-provenance-validation',lambda:validate_assets(concept))
   self.gate('02-assets',[concept/'native-input.json',concept/'agent-assets/request.json'],
    'Fulfil the frozen asset plan with authorized DSH image plugins/local tools, or existing original assets. No gd-cli and no automatic paid fallback. Resume existing provider tasks when uncertain; preserve real task_id or invocation_id. Write external-assets.json with schema_version:1 echoing the asset request token/plan_sha256; retain exact inputs, models, hashes and original evidence. Even an empty plan needs an empty matching response. Write every layout_variants recipe at the concept root with independent native text, explicit font/preview_font/gd_font, category per image/shape, valid canvas and semantic layer_audit pairs. Do not claim aesthetic approval here; no provider available means record the concrete missing capability, never invent assets or receipts.')
   return self.local('asset-provenance-validation',lambda:validate_assets(concept))
  self.stage('native_assets',assets)
  records=self.stage('native_layouts',lambda:self.local('native-render-variants',lambda:native_design.render_variants(concept)))
  inputs=[concept/'layout-comparison.json',concept/'native-input.json']
  for row in records:inputs.extend([concept/row['recipe'],*[concept/board['path'] for board in row.get('previews',[{'path':row['preview']}])]])
  def selection():
   response=self.gate('03-layout',inputs,
    'Open every actual native preview at thumbnail and full size. Compare hierarchy, alignment, spacing, line breaks, font pairing, palette, readability, subject edges, complete background, real use and originality. Reject weak drafts; do not approve by file/layer count. Respond selected_id matching exactly one rendered variant and concrete observations. Chosen layout becomes the composition master; it is a local render, not an AI-generated image.')
   return self.local('native-select-layout',lambda:native_design.select(concept,response.get('selected_id')))
  self.stage('native_selection',selection)
  return self.finish_design(concept)
 def finish_design(self,concept):
  concept=Path(concept);recipe=concept/'release-recipe.json';out=concept/'release'
  def build_checked():
   if (concept/'native-input.json').exists():
    from separation_contract import check
    self.local('separation-preflight',lambda:check(concept,recipe))
   return self.cmd(['build',recipe])
  self.stage('build',build_checked)
  def prep():
   # Registration, provenance generation and editor import/fonts have no mutual dependency.
   nodes=[{'id':'register'},{'id':'receipts'},{'id':'editor'}]
   return execute(nodes,lambda n:self.cmd(['register',recipe,'--repository-id',self.state['repository_id']]) if n['id']=='register' else self.cmd(['receipts',concept]) if n['id']=='receipts' else self.browser('prepare',recipe),self.workers)
  if self.registration=='agent':
   from browser_registration import prepare as registration_request,validate as registration_validate
   def register_browser():
    registration_request(recipe,self.state['repository_id'])
    self.gate('05-register',[out/'registered-assets/request.json',recipe],
     'Use the existing browser TaskSpace and inspect its actual Page labels. Confirm the current actual DAM library in a dedicated DAM Page; never assume p2 and never navigate over the editor. Prefer one deterministic helper invocation with args '+json.dumps(['browser','register-assets',str(recipe),'--space',str(self.state['space']),'--page','<actual dedicated DAM Page label>'],ensure_ascii=False)+'. Replace the page placeholder with the actual existing/new Page label within this same TaskSpace. The helper queries existing hash titles, resumes uncertain uploads without blind repeats, uploads exact final PNGs, verifies downloaded SHA256 and writes registered-assets/response.json. Do not hand-calculate hashes or rewrite its response. No gd-cli. Then inspect the real saved/reopened DAM screenshots and library assets and complete this Agent gate with concrete observations; a generated response is not visual approval. Missing/uncertain assets must be diagnosed, not invented. The program validates exact IDs, paths, hashes and evidence.')
    return registration_validate(recipe,self.state['repository_id'])
   self.stage('browser_registration',register_browser)
   self.stage('provenance',lambda:self.cmd(['receipts',concept]))
   self.browser_group('editor_batch','prepare,bind,audit',
    [('editor_prepare','prepare'),('bind_assets','bind'),('layer_audit','audit')],recipe)
  else:
   self.stage('parallel_prepare',prep)
   self.stage('bind_assets',lambda:self.browser('bind',recipe))
   self.stage('layer_audit',lambda:self.browser('audit',recipe))
  def final_review():
   from publication_preflight import validate as preflight
   self.local('final-separation-preflight',lambda:preflight(recipe))
   from review_packet import build_packet
   manifest=out/'review-packet/manifest.json';summary=out/'review-packet/agent-summary.md'
   # Keep the exact packet used by an already-written response; input changes still invalidate its gate.
   if not manifest.exists() or not summary.exists() or not (self.root/'gates/04-final/response.json').exists():self.local('review-packet',lambda:build_packet(recipe))
   # Generated indexes/drafts are advisory and may be refreshed after the Agent supplies missing evidence.
   inputs=[out/'layer-audit/audit.json',*sorted((out/'layer-audit').glob('*.png')),out/'spec.json',out/'bound-assets.json',out/'editor-materials-bound.png',out/'registered-assets.json',recipe]+sorted(out.glob('editor-bound-*.png'))
   self.gate('04-final',inputs,'Read release/review-packet/agent-summary.md first, then open index.html and grouped must_view evidence. Use the linked manifest.json only when detailed diagnostics are needed; do not read thousands of JSON lines just to find the checklist. Missing evidence is listed as an issue for Agent completion, not a passed check; the passed:false draft reviews are only templates and never approval. View every layer-audit hide screenshot and restored-after-reload.png, judge actual separation and absence of embedded duplicate subjects/backgrounds. View editor screenshot and compare mother. Check all image layers, alpha edges, native editable copy, spelling, dimensions, spacing, font replacement, no unintended crop. Write release/visual-review.json (passed,spec_sha256) and material-review.json (passed,bindings_sha256) with screenshot and specific checks. Verify real provenance of every asset. Write concept/copyright-evidence.json as {categories:{original/original_ai:[{path:concept-relative real screenshot or original photo,sha256,layers:[covered layer IDs]}]}}. Every image needs original relevant evidence; receipts.png and shape-evidence.png are generated indexes and cannot be used as platform proof. AI screenshots must show the actual tool, full prompt, model and result; preserve source references where used. Add evidence_sha256 of this exact manifest to material-review.json. Copyright count must later equal image count; this gate cannot bypass it.')
   for name,key,path in [('visual-review','spec_sha256',out/'spec.json'),('material-review','bindings_sha256',out/'bound-assets.json')]:
    review=read(out/(name+'.json'))
    if review.get('passed') is not True or review.get(key)!=sha(path):raise ValueError('Stale visual/material review')
   if read(out/'material-review.json').get('evidence_sha256')!=sha(concept/'copyright-evidence.json'):raise ValueError('Stale or missing real copyright evidence review')
   return True
  self.stage('final_review',final_review)
  self.browser_group('publication_batch','form,submit,declare,verify',
   [('copyright_and_form','form'),('submit','submit'),('complete_declaration','declare'),('reopen_verify','verify')],recipe)
  def package():
   with self.span('command','package-delivery'):subprocess.run([sys.executable,str(ROOT/'workflow/package_delivery.py'),str(self.root/'delivery'),'--concept',str(concept),'--research',str(self.research)],check=True)
   return str(self.root/'delivery')
  self.stage('package',package)
  self.state.update(status='complete',completed_at=time.time(),elapsed_seconds=time.time()-self.state['started_at']);self.save();cleanup_catalog_space(self.root,self.state);self.report();print(json.dumps(self.state,ensure_ascii=False,indent=2),flush=True)
 def report(self):
  from timing import build_report
  events=[];malformed=0
  if (self.root/'events.jsonl').exists():
   for line in (self.root/'events.jsonl').read_text().splitlines():
    try:events.append(json.loads(line))
    except json.JSONDecodeError:malformed+=1
  report=build_report(self.state,events)
  from browser_metrics import report as browser_report
  report['browser_steps']=browser_report(self.state.get('browser_sequence_logs',[]))
  if malformed:report['warnings'].append(str(malformed)+' malformed event lines could not be attributed')
  write(self.root/'timing-report.json',report)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);p.add_argument('--space',type=int,required=True);p.add_argument('--repository-id');p.add_argument('--watch',action='store_true');p.add_argument('--workers',type=int,default=3);p.add_argument('--topic');p.add_argument('--topic-json',type=Path);p.add_argument('--mode',choices=['native','gd-cli']);p.add_argument('--registration',choices=['agent','gd-cli']);a=p.parse_args()
 if not 1<=a.workers<=6:p.error('workers must be 1..6')
 with locked(a.directory/'.run.lock'):
  controller=Controller(a.directory,a.space,a.repository_id,a.watch,a.workers,a.topic,a.mode,a.registration,a.topic_json)
  try:controller.run()
  finally:controller.event('controller_stop',status=controller.state.get('status'));controller.report()
if __name__=='__main__':main()
