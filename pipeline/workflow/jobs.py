"""Durable CLI jobs. Never resubmit a persisted job whose result is uncertain."""
import hashlib,json,subprocess,time
from pathlib import Path
from urllib.request import urlretrieve

def call(*args,payload=None):
 p=subprocess.run(['gd-cli',*args],input=json.dumps(payload,ensure_ascii=False) if payload else None,text=True,capture_output=True)
 if p.returncode: raise RuntimeError(p.stderr or p.stdout)
 return json.loads(p.stdout)

def run(directory,tool,request,timeout=900):
 directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
 request_file=directory/'request.json';job=directory/'job.json';result_file=directory/'result.json'
 if request_file.exists() and json.loads(request_file.read_text())!={'tool':tool,'input':request}:
  raise ValueError(f'Changed request, use new directory: {directory}')
 request_file.write_text(json.dumps({'tool':tool,'input':request},ensure_ascii=False,indent=2))
 if result_file.exists(): return json.loads(result_file.read_text())
 if not job.exists():
  marker=directory/'submission-started'
  if marker.exists(): raise RuntimeError(f'Uncertain submission: recover task ID using gd-cli task list; {directory}')
  marker.write_text(str(time.time()))
  submitted=call('tool','call',tool,'--input','-','--async',payload=request)
  job.write_text(json.dumps(submitted,ensure_ascii=False,indent=2))
 task_id=json.loads(job.read_text())['taskId'];deadline=time.monotonic()+timeout
 print(f'{directory.name}: task {task_id}',flush=True)
 while time.monotonic()<deadline:
  result=call('task','get',task_id,'--json')
  (directory/'last-status.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
  if result.get('state')=='completed':
   result_file.write_text(json.dumps(result,ensure_ascii=False,indent=2));return result
  if result.get('state') in ('failed','cancelled','unknown'):
   raise RuntimeError(f'{task_id}: {result.get("state")}; inspect status, do not blindly resubmit')
  time.sleep(5)
 raise TimeoutError(f'Continue same task {task_id} in {directory}')

def download_resources(directory,result):
 directory=Path(directory);manifest=[]
 for i,c in enumerate(result.get('result',result).get('content',[])):
  url=c.get('uri') or c.get('url') or c.get('resource',{}).get('uri')
  if not url or not url.startswith(('http://','https://')):continue
  mime=c.get('mimeType','')
  suffix={"application/json":".json","image/png":".png","image/jpeg":".jpg"}.get(mime,'.data')
  dest=directory/f'resource-{i}{suffix}'
  if not dest.exists():
   temp=dest.with_suffix('.partial');urlretrieve(url,temp);temp.replace(dest)
  manifest.append({'name':c.get('name'),'uri':url,'mimeType':mime,'file':str(dest.resolve()),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
 (directory/'resources.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
 return manifest
