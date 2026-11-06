"""Bounded DAG executor: independent nodes overlap, failures block dependents."""
import json,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,wait,FIRST_COMPLETED

def execute(nodes,worker,workers=3):
 by_id={n['id']:n for n in nodes}
 if len(by_id)!=len(nodes):raise ValueError('Duplicate task ID')
 if any(dep not in by_id for n in nodes for dep in n.get('depends',[])):raise ValueError('Unknown dependency')
 # Validate the whole graph before any paid work.
 seen=set()
 while len(seen)<len(nodes):
  ready={k for k,n in by_id.items() if k not in seen and set(n.get('depends',[]))<=seen}
  if not ready:raise ValueError('Cyclic dependency')
  seen.update(ready)
 pending=dict(by_id);done={};running={};errors={}
 with ThreadPoolExecutor(max_workers=max(1,workers)) as ex:
  while pending or running:
   for key,n in list(pending.items()):
    if len(running)>=workers:break
    if set(n.get('depends',[]))<=set(done):running[ex.submit(worker,n)]=key;del pending[key]
   if not running:break
   finished,_=wait(running,return_when=FIRST_COMPLETED)
   for future in finished:
    key=running.pop(future)
    try:done[key]=future.result()
    except Exception as e:errors[key]=str(e)
   if errors:
    # In-flight independent jobs finish and retain receipts; never cancel an accepted service job.
    for future,key in list(running.items()):
     try:done[key]=future.result()
     except Exception as e:errors[key]=str(e)
    running.clear();break
 if errors:raise RuntimeError(json.dumps({'failed':errors,'blocked':list(pending)},ensure_ascii=False))
 return done
