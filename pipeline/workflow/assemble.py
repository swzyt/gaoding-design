# -*- coding: utf-8 -*-
"""Build a reviewed, data-driven layer recipe into portable PSD, PNG assets and ZIP."""
import argparse,hashlib,json,shutil,subprocess
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from PIL import Image,ImageDraw,ImageFont,ImageFilter,ImageChops
from text_style import render_text,normalize_style
ROOT=Path(__file__).resolve().parents[1]
FONT_DIR=Path('/System/Library/Fonts/Supplemental')

def separation_metadata(recipe):
 return {key:recipe[key] for key in ('separation_contract','separation_contract_sha256') if key in recipe}

def layer_metadata(row, asset_path=None):
 result={key:row[key] for key in ('id','role','require_alpha','page','coverage','native_type') if key in row}
 if row.get('type')=='shape':result['native_type']='shape'
 if asset_path is not None:result['sha256']=hashlib.sha256(asset_path.read_bytes()).hexdigest()
 return result

def portable_layer(row,out):
 if row['type']=='text':return row
 return dict(layer_metadata(row,out/f"assets/{row['id']}.png"),name=row['name'],type='image',source=f"assets/{row['id']}.png",box=row['box'],copyright_category=row.get('copyright_category'))

def preview(recipe_path, destination=None):
 """Render a draft locally without master, PSD, packaging or production calls."""
 return build_one(recipe_path, preview_only=True, destination=destination)

def build_one(recipe_path, preview_only=False, destination=None):
 recipe_path=Path(recipe_path).resolve();root=recipe_path.parent
 recipe=json.loads(recipe_path.read_text());out=root/recipe.get('output','release')
 if preview_only and recipe.get('pages'):raise ValueError('preview expects a single-page recipe; select one page and its layers first')
 if not preview_only:
  out.mkdir(parents=True,exist_ok=True);(out/'assets').mkdir(exist_ok=True)
 W,H=recipe['canvas']['w'],recipe['canvas']['h'];canvas=Image.new('RGBA',(W,H))
 spec={'canvas':recipe['canvas'],'layers':[],**separation_metadata(recipe)};names=set();stats=[]
 for row in recipe['layers']:
  name=row['name'];key=row['id']
  if name in names:raise ValueError(f'duplicate layer {name}')
  names.add(name);typ=row['type'];x,y,w,h=map(round,row['box'])
  if typ=='text':
   normalize_style(row)
   size=int(row['size']);font_path=FONT_DIR/row.get('preview_font','Songti.ttc')
   font=ImageFont.truetype(str(font_path),size,index=row.get('font_index',6 if font_path.name=='Songti.ttc' else 0))
   style,line_h,cached,origin=render_text(canvas,row,font,[x,y,w,h])
   text_spec={'name':name,'type':'text','text':row['text'],'box':[x,y,w,h],'size':size,'color':row['color'],'font':row.get('font','SongtiSC-Regular'),**style,'leading_px':line_h}
   if not preview_only:
    (out/'text-cache').mkdir(exist_ok=True);cached.save(out/f'text-cache/{key}.png')
    text_spec.update(text_cache=f'text-cache/{key}.png',text_cache_origin=origin)
   if 'separation_contract' in recipe:text_spec.update(layer_metadata(row))
   spec['layers'].append(text_spec)
   stats.append({'name':name,'type':'editable_text','text':row['text']})
   continue
  if typ=='image':
   source=root/row['source'];im=Image.open(source).convert('RGBA')
   if row.get('crop'):im=im.crop(tuple(row['crop']))
   im=im.resize((w,h),Image.Resampling.LANCZOS)
   if row.get('alpha_source'):
    alpha=Image.open(root/row['alpha_source']).convert('RGBA').getchannel('A').resize((w,h),Image.Resampling.LANCZOS);im.putalpha(alpha)
   if row.get('require_alpha') and im.getchannel('A').getextrema()[0]==255:raise ValueError(f'{name}: no transparent pixels')
  elif typ=='shape':
   im=Image.new('RGBA',(w,h));d=ImageDraw.Draw(im)
   if row.get('ellipse'):d.ellipse(tuple(row.get('ellipse_box',[0,0,w-1,h-1])),fill=tuple(row['color']))
   elif row.get('polygon'):d.polygon([tuple(p) for p in row['polygon']],fill=tuple(row['color']))
   else:d.rectangle((0,0,w,h),fill=tuple(row['color']))
   if row.get('blur'):im=im.filter(ImageFilter.GaussianBlur(row['blur']))
  else:raise ValueError(typ)
  if row.get('clip_circle'):
   cx,cy,diameter=row['clip_circle'];mask=Image.new('L',(w,h));ImageDraw.Draw(mask).ellipse((cx-x,cy-y,cx-x+diameter,cy-y+diameter),fill=255);im.putalpha(ImageChops.multiply(im.getchannel('A'),mask))
  if preview_only:
   canvas.alpha_composite(im,(x,y));continue
  asset_path=out/f'assets/{key}.png';im.save(asset_path)
  canvas.alpha_composite(im,(x,y))
  spec['layers'].append({'name':name,'type':'image','box':[x,y,w,h] if 'separation_contract' in recipe else [x,y], 'png':f'assets/{key}.png',**(layer_metadata(row,asset_path) if 'separation_contract' in recipe else {})})
  stats.append({'name':name,'type':typ,'file':f'assets/{key}.png','alpha_range':im.getchannel('A').getextrema(),'sha256':hashlib.sha256(asset_path.read_bytes()).hexdigest()})
 if preview_only:
  target=Path(destination) if destination is not None else root/'preview.jpg'
  target.parent.mkdir(parents=True,exist_ok=True)
  (canvas if target.suffix.lower()=='.png' else canvas.convert('RGB')).save(target)
  return target
 canvas.convert('RGB').save(out/'preview.jpg',quality=95)
 small=canvas.copy();small.thumbnail((720,1280));small.convert('RGB').save(out/'preview-small.jpg',quality=93)
 (out/'spec.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2))
 (out/'layer-manifest.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2))
 portable=dict(recipe,output='rebuilt',reference_master='reference/master.jpg')
 portable.pop('separation_check',None)
 portable['layers']=[]
 for row in recipe['layers']:
  if row['type']=='text':portable['layers'].append(row)
  else:portable['layers'].append(portable_layer(row,out))
 (out/'recipe.json').write_text(json.dumps(portable,ensure_ascii=False,indent=2))
 (out/'reference').mkdir(exist_ok=True)
 # 纯本地原生模板没有 AI 母稿，reference 可以为空，不应阻断构建。
 reference=root/recipe.get('reference_master','master.jpg')
 if reference.exists():shutil.copyfile(reference,out/'reference/master.jpg')
 subprocess.run(['bash',str(ROOT/'render_psd.sh'),str(out/'spec.json'),str(out/'template.psd')],check=True)
 with ZipFile(out/'materials.zip','w',ZIP_DEFLATED) as z:
  for p in [out/'spec.json',out/'layer-manifest.json',out/'recipe.json',out/'preview.jpg',out/'template.psd',*sorted((out/'assets').glob('*.png')),*sorted((out/'text-cache').glob('*.png'))]:z.write(p,p.relative_to(out))
  if (out/'reference/master.jpg').exists():z.write(out/'reference/master.jpg','reference/master.jpg')
  for name in ['receipts.png','task-provenance.json','visual-review.json','font-verification.json','editor-state.json','publication.json','publication-metadata.json','metadata-schema-observed.json','publication-form.png','publication-success.png','copyright-prepared-v2.png','copyright-verification.json','registered-assets.json','bound-assets.json','material-review.json','shape-evidence.png','copyright-verified-v2.png','editor-materials-bound.png']:
   p=out/name
   if p.exists():z.write(p,'evidence/'+name)
  for p in sorted((out/'layer-audit').glob('*')):
   if p.is_file():z.write(p,'evidence/layer-audit/'+p.name)
  for p in sorted((out/'registered-assets').glob('*.json')):z.write(p,'registration/'+p.name)
  for p in sorted(root.glob('*-job/request.json')):z.write(p,'provenance/'+p.parent.name+'/request.json')
  for p in sorted(root.glob('*-job/result.json')):z.write(p,'provenance/'+p.parent.name+'/result.json')
 print(json.dumps({'output':str(out),'image_layers':sum(l['type']=='image' for l in spec['layers']),'text_layers':sum(l['type']=='text' for l in spec['layers'])}))
 return out

def build(recipe_path):
 recipe_path=Path(recipe_path).resolve();root=recipe_path.parent;recipe=json.loads(recipe_path.read_text())
 if not recipe.get('pages'):return build_one(recipe_path)
 out=root/recipe.get('output','release');out.mkdir(parents=True,exist_ok=True);(out/'assets').mkdir(exist_ok=True)
 ids=[r['id'] for r in recipe['layers']];names=[r['name'] for r in recipe['layers']]
 if len(ids)!=len(set(ids)) or len(names)!=len(set(names)):raise ValueError('Multi-page layer IDs/names must be globally unique')
 pages=[];layers=[];stats=[]
 page_ids=[p['id'] for p in recipe['pages']]
 if len(page_ids)!=len(set(page_ids)) or any(r.get('page') not in page_ids for r in recipe['layers']):raise ValueError('Invalid page assignment')
 for page in recipe['pages']:
  subset={k:v for k,v in recipe.items() if k!='pages'};subset.update(canvas=page['canvas'],output=str(out/'pages'/page['id']),layers=[r for r in recipe['layers'] if r['page']==page['id']])
  child=root/('page-'+page['id']+'-recipe.json');child.write_text(json.dumps(subset,ensure_ascii=False,indent=2));built=build_one(child)
  spec=json.loads((built/'spec.json').read_text());layers.extend(dict(r,page=page['id']) for r in spec['layers']);stats.extend(json.loads((built/'layer-manifest.json').read_text()))
  # Cache paths in the aggregate spec stay relative to its own directory.
  for layer in layers:
   if layer.get('page')==page['id'] and layer.get('text_cache'):layer['text_cache']='pages/'+page['id']+'/'+layer['text_cache']
  for f in (built/'assets').glob('*.png'):shutil.copyfile(f,out/'assets'/f.name)
  pages.append(dict(page,psd='pages/'+page['id']+'/template.psd',layers=[r['name'] for r in spec['layers']]))
  for name in ['preview.jpg','preview-small.jpg']:shutil.copyfile(built/name,out/(page['id']+'-'+name))
 spec={'canvas':recipe['pages'][0]['canvas'],'pages':pages,'layers':layers,**separation_metadata(recipe)}
 (out/'spec.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2));(out/'layer-manifest.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2))
 last=out/'pages'/recipe['pages'][-1]['id']
 for name in ['preview.jpg','preview-small.jpg']:shutil.copyfile(last/name,out/name)
 portable=dict(recipe,output='rebuilt',reference_master='reference/master.jpg');portable.pop('separation_check',None);portable['layers']=[portable_layer(r,out) for r in recipe['layers']]
 (out/'recipe.json').write_text(json.dumps(portable,ensure_ascii=False,indent=2));(out/'reference').mkdir(exist_ok=True);shutil.copyfile(root/recipe.get('reference_master','master.jpg'),out/'reference/master.jpg')
 with ZipFile(out/'materials.zip','w',ZIP_DEFLATED) as z:
  for f in out.rglob('*'):
   if f.is_file() and f.suffix!='.zip':
    if f.parent.name=='assets' and f.stem not in ids:continue
    z.write(f,f.relative_to(out))
  for f in root.glob('*-job/request.json'):z.write(f,'provenance/'+f.parent.name+'/request.json')
  for f in root.glob('*-job/result.json'):z.write(f,'provenance/'+f.parent.name+'/result.json')
 print(json.dumps({'output':str(out),'pages':len(pages),'image_layers':sum(l['type']=='image' for l in layers),'text_layers':sum(l['type']=='text' for l in layers)}));return out

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('recipe',type=Path)
 build(parser.parse_args().recipe)
