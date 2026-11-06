# -*- coding: utf-8 -*-
"""Register the exact final PNGs in DAM, retaining resumable upload receipts."""
import argparse,hashlib,json,subprocess
from pathlib import Path

def register(recipe_path,repository_id):
 root=Path(recipe_path).resolve().parent;recipe=json.loads(Path(recipe_path).read_text());out=root/recipe.get('output','release');dest=out/'registered-assets';dest.mkdir(exist_ok=True)
 repos=json.loads(subprocess.check_output(['gd-cli','dam','repository','list','--json']))['repositories']
 if str(repository_id) not in [str(r['repository_id']) for r in repos]:raise ValueError('Repository unavailable')
 rows=[]
 for layer in recipe['layers']:
  if layer['type']=='text':continue
  if layer.get('copyright_category') not in ('original','original_ai'):raise ValueError('Assign an evidence-backed copyright_category before registration: '+layer['name'])
  asset=out/'assets'/(layer['id']+'.png');sha=hashlib.sha256(asset.read_bytes()).hexdigest();receipt=dest/(layer['id']+'.json');marker=dest/(layer['id']+'.upload-started.json')
  title=recipe['title'].split(' ')[0]+'-'+layer['name']+'-v2'
  request={'source':str(asset),'sha256':sha,'repository_id':str(repository_id),'folder_id':'0','title':title}
  if marker.exists() and json.loads(marker.read_text())!=request:raise ValueError('Asset changed; use a new registration revision')
  if not receipt.exists():
   if marker.exists():raise RuntimeError('Uncertain upload; find existing asset before retrying: '+str(marker))
   marker.write_text(json.dumps(request,ensure_ascii=False,indent=2))
   result=subprocess.run(['gd-cli','dam','upload',str(asset),'--repository-id',str(repository_id),'--folder-id','0','--title',title,'--json'],capture_output=True,text=True,check=True)
   uploaded=json.loads(result.stdout);receipt.write_text(json.dumps(uploaded,ensure_ascii=False,indent=2))
  else:uploaded=json.loads(receipt.read_text())
  if not uploaded.get('asset_id'):raise RuntimeError('Missing upload ID')
  if not marker.exists():marker.write_text(json.dumps(request,ensure_ascii=False,indent=2))
  rows.append(dict(request,id=layer['id'],layer=layer['name'],category=layer['copyright_category'],**uploaded))
  (out/'registered-assets.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print(layer['id'],uploaded['asset_id'],flush=True)
 return rows

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('recipe');p.add_argument('--repository-id',required=True);a=p.parse_args();register(a.recipe,a.repository_id)
