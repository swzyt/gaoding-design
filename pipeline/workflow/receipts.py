# -*- coding: utf-8 -*-
import argparse,json,subprocess
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
p=argparse.ArgumentParser();p.add_argument('concept',type=Path);root=p.parse_args().concept.resolve()
records=[]
master=json.loads((root/'master.task').read_text())['taskId']
r=json.loads(subprocess.check_output(['gd-cli','task','get',master,'--json']))
if r['state']!='completed':raise RuntimeError('master not complete')
records.append(('母稿生成',master,r['result'].get('usage',{}).get('model','')))
for f in sorted(root.glob('*-job/result.json')):
 r=json.loads(f.read_text())
 records.append((f.parent.name,r['taskId'],r['result'].get('usage',{}).get('model','')))
font='/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
im=Image.new('RGB',(1700,220+110*len(records)),'#faf8f2');d=ImageDraw.Draw(im)
d.text((45,40),'素材来源与任务记录 / '+root.name,font=ImageFont.truetype(font,38),fill='#242538')
for i,(label,task,model) in enumerate(records):
 y=125+i*110;d.text((45,y),label+'  |  '+model+'  | completed',font=ImageFont.truetype(font,27),fill='#242538');d.text((45,y+43),task,font=ImageFont.truetype(font,25),fill='#585862')
d.text((45,im.height-65),'来源：稿定 CLI 任务回执。图形与文字由本项目独立排版。',font=ImageFont.truetype(font,25),fill='#585862')
im.save(root/'release/receipts.png')
(root/'release/task-provenance.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
