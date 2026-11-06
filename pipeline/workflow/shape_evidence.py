# -*- coding: utf-8 -*-
import json,hashlib,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
root=Path(sys.argv[1]).resolve();recipe=json.loads((root/'release-recipe.json').read_text());out=root/'release'
shapes=[x for x in recipe['layers'] if x['type']=='shape'];im=Image.new('RGB',(1600,300+250*len(shapes)), '#faf8f2');d=ImageDraw.Draw(im)
f=lambda n:ImageFont.truetype('/System/Library/Fonts/Supplemental/Songti.ttc',n)
d.text((60,40),'独立几何素材制作记录',font=f(44),fill='#232323');d.text((60,110),'来源：本项目排版配方与 Pillow 绘制；非 AI 图像生成',font=f(28),fill='#333333')
d.text((60,160),'对应作品：'+recipe['title'],font=f(27),fill='#333333')
for i,row in enumerate(shapes):
 y=240+i*250;source=out/'assets'/(row['id']+'.png');asset=Image.open(source).convert('RGBA');asset.thumbnail((240,150));im.paste(asset,(60,y),asset)
 d.text((340,y),row['name'],font=f(28),fill='#232323');d.text((340,y+45),'ID: '+row['id']+'  /  box: '+str(row['box']),font=f(24),fill='#333333')
 d.text((340,y+85),'color: '+str(row['color'])+'  blur: '+str(row.get('blur',0)),font=f(24),fill='#333333')
 sha=hashlib.sha256(source.read_bytes()).hexdigest();d.text((340,y+125),'SHA256: '+sha[:40],font=f(22),fill='#333333');d.text((340,y+158),sha[40:],font=f(22),fill='#333333')
d.text((60,im.height-50),'完整配方与源代码随素材包提供，可重复生成并校验哈希。',font=f(24),fill='#555555');im.save(out/'shape-evidence.png')
