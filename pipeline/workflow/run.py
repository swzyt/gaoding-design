#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Entry point for the research-driven, resumable Gaoding workflow."""
import argparse,json,os,shutil,subprocess,sys
from pathlib import Path
from jobs import run,download_resources
from localize import localize
from assemble import build
from register_assets import register
ROOT=Path(__file__).resolve().parents[1]

def ego():
 p=shutil.which('ego-browser') or str(Path.home()/'.local/bin/ego-browser')
 if not Path(p).exists():raise RuntimeError('ego-browser is not installed')
 return p

def main():
 p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='cmd',required=True)
 sub.add_parser('doctor')
 auto=sub.add_parser('auto');auto.add_argument('directory',type=Path);auto.add_argument('--space',type=int,required=True);auto.add_argument('--repository-id',required=True);auto.add_argument('--watch',action='store_true');auto.add_argument('--workers',type=int,default=3);auto.add_argument('--topic',help='Exact topic key or name; omit for random selection')
 s=sub.add_parser('status');s.add_argument('concept',type=Path)
 j=sub.add_parser('job');j.add_argument('request',type=Path);j.add_argument('output',type=Path)
 l=sub.add_parser('localize');l.add_argument('template',type=Path);l.add_argument('output',type=Path)
 b=sub.add_parser('build');b.add_argument('recipe',type=Path)
 u=sub.add_parser('register');u.add_argument('recipe',type=Path);u.add_argument('--repository-id',required=True)
 r=sub.add_parser('receipts');r.add_argument('concept',type=Path)
 m=sub.add_parser('masters');m.add_argument('brief',type=Path);m.add_argument('output',type=Path);m.add_argument('--check',action='store_true')
 browser=sub.add_parser('browser');browser.add_argument('phase',choices=['prepare','bind','audit','form','update','submit','declare','verify']);browser.add_argument('recipe',type=Path);browser.add_argument('--space',type=int,required=True);browser.add_argument('--page',default='p1')
 a=p.parse_args()
 if a.cmd=='auto':
  command=[sys.executable,str(ROOT/'workflow/orchestrator.py'),str(a.directory.resolve()),'--space',str(a.space),'--repository-id',a.repository_id,'--workers',str(a.workers)]
  if a.watch:command.append('--watch')
  if a.topic:command.extend(['--topic',a.topic])
  subprocess.run(command,check=True)
 elif a.cmd=='doctor':
  for command in ['gd-cli','node','npm']:
   if not shutil.which(command):raise RuntimeError('Missing '+command)
  print('ego-browser:',ego());print('Python:',sys.executable)
  subprocess.run(['gd-cli','--version'],check=True)
  subprocess.run(['node',str(ROOT/'fixes/test-reference-wire.mjs')],check=True)
  env=dict(os.environ,NODE_PATH=os.environ.get('NODE_PATH',str(ROOT/'workflow/node_modules')))
  subprocess.run(['node','-e',"require('ag-psd');require('pngjs');console.log('PSD dependencies ready')"],env=env,check=True)
 elif a.cmd=='status':
  root=a.concept.resolve();data={'concept':str(root),'jobs':[]}
  if (root/'run.json').exists():data['run']=json.loads((root/'run.json').read_text())
  for file in sorted(root.glob('*-job/job.json')):
   directory=file.parent;latest=directory/'last-status.json';j=json.loads((latest if latest.exists() else file).read_text())
   data['jobs'].append({'job':directory.name,'taskId':j['taskId'],'state':j.get('state')})
  for name in ['editor-state','visual-review','publication']:
   file=root/'release'/f'{name}.json'
   if file.exists():data[name]=json.loads(file.read_text())
  print(json.dumps(data,ensure_ascii=False,indent=2))
 elif a.cmd=='job':
  request=json.loads(a.request.read_text());result=run(a.output,request['tool'],request['input']);print(json.dumps(download_resources(a.output,result),ensure_ascii=False))
 elif a.cmd=='localize':print(json.dumps(localize(a.template,a.output),ensure_ascii=False))
 elif a.cmd=='build':build(a.recipe)
 elif a.cmd=='register':register(a.recipe,a.repository_id)
 elif a.cmd=='receipts':
  subprocess.run([sys.executable,str(ROOT/'workflow/receipts.py'),str(a.concept.resolve())],check=True)
  subprocess.run([sys.executable,str(ROOT/'workflow/shape_evidence.py'),str(a.concept.resolve())],check=True)
 elif a.cmd=='masters':
  cmd=[sys.executable,str(ROOT/'generate_masters.py'),str(a.brief.resolve()),str(a.output.resolve())]
  if a.check:cmd.append('--check')
  subprocess.run(cmd,check=True)
 elif a.cmd=='browser':
  method={'prepare':'prepare','bind':'bind','audit':'audit','form':'prepareForm','update':'prepareUpdate','submit':'submit','declare':'completeDeclaration','verify':'verify'}[a.phase]
  module=ROOT/('workflow/layer_audit.js' if a.phase=='audit' else 'workflow/bind_assets.js' if a.phase=='bind' else 'workflow/publish.js')
  # JSON is embedded only into JavaScript over stdin, never into a shell command.
  script=f"const p=(await taskSpace({a.space})).page({json.dumps(a.page)});\nconst m=await import({json.dumps(str(module))});\nconsole.log(await m.default.{method}(p,{json.dumps(str(a.recipe.resolve()))}));\n"
  subprocess.run([ego(),'nodejs'],input=script,text=True,check=True)

if __name__=='__main__':main()
