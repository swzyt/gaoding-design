# -*- coding: utf-8 -*-
"""Rebuild and package only submissions with reopened copyright verification."""
import argparse,hashlib,json,shutil
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from assemble import build
ROOT=Path(__file__).resolve().parents[1]

def package(output,concepts,research):
 output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True);results=[];files=[]
 for concept in concepts:
  concept=Path(concept).resolve();r=concept/'release';state=json.loads((r/'publication.json').read_text());copyright=state.get('copyright',{})
  if state['stage']!='verified' or copyright.get('state')!='verified' or not copyright.get('reopened'):raise ValueError('Submission/copyright not fully verified: '+str(concept))
  layers=json.loads((r/'spec.json').read_text())['layers'];review=json.loads((r/'visual-review.json').read_text())
  if review['spec_sha256']!=hashlib.sha256((r/'spec.json').read_bytes()).hexdigest():raise ValueError('Spec changed since review')
  build(concept/'release-recipe.json')
  if review['spec_sha256']!=hashlib.sha256((r/'spec.json').read_bytes()).hexdigest():raise ValueError('Rebuild changed reviewed spec')
  results.append(dict(state,imageLayers=sum(x['type']=='image' for x in layers),textLayers=sum(x['type']=='text' for x in layers)))
  dest=output/(concept.name+'-materials.zip');shutil.copyfile(r/'materials.zip',dest);files.append(dest)
 result=output/'results.json';result.write_text(json.dumps(results,ensure_ascii=False,indent=2));files.append(result)
 readme=output/'README.md';readme.write_text('''# 修正版交付

已修复PSD导入图片未关联版权候选的问题：最终PNG登记到DAM，并通过编辑器替换绑定回原图层。新稿按授权投稿；修复旧稿时保留原作品ID，避免重复投稿。

每份素材包含各画板PSD、独立PNG、配方、母稿、预览、登记回执、图片与文字图层清单、真实生成记录、原创几何制作证明、版权面板截图和投稿记录。分类和证明材料已从发布管理重新打开核验，详情见results.json。

PSD保留版式，但单独再次导入PSD仍需执行素材登记与绑定。必须完成版权声明才能称为完整投稿；无候选、缺面板、少素材或缺证明材料均判失败。

运行入口为包内 workflow.sh，先运行 bootstrap；步骤见 pipeline/workflow/WORKFLOW.md。Agent负责话题研究、创意和实际画布复核，脚本负责状态记录及重复执行。版权审核结论以平台最终结果为准。
''');files.append(readme)
 archive=output/'gaoding-workflow-and-materials.zip'
 with ZipFile(archive,'w',ZIP_DEFLATED) as z:
  for f in files:z.write(f,f.name)
  for f in (ROOT/'workflow').iterdir():
   if f.is_file() and f.suffix in ('.py','.js','.json','.sh','.md') and not f.name.startswith('test'):z.write(f,'pipeline/workflow/'+f.name)
  for name in ['generate_masters.py','publish_flow.js','render_psd.sh','topics.json']:z.write(ROOT/name,'pipeline/'+name)
  for f in (ROOT/'fixes').iterdir():
   if f.is_file():z.write(f,'pipeline/fixes/'+f.name)
  z.write(ROOT.parent/'workflow.sh','workflow.sh')
  z.write(ROOT.parent/'tooling/spec_to_psd.js','tooling/spec_to_psd.js')
  for f in Path(research).rglob('*'):
   if f.is_file():z.write(f,'pipeline/research/'+Path(research).name+'/'+str(f.relative_to(research)))
  z.write(ROOT/'workflow/WORKFLOW.md','workflow/WORKFLOW.md')
 print(json.dumps({'archive':str(archive),'works':[(r['contentId'],r['copyright']['expected']) for r in results]},ensure_ascii=False))

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--concept',action='append',type=Path,required=True);p.add_argument('--research',type=Path,required=True);a=p.parse_args();package(a.output,a.concept,a.research.resolve())
