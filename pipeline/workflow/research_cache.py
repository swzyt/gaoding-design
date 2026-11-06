"""Live rules + ordered sample contents form the cache key; damaged caches miss."""
import hashlib,json,shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlretrieve
from urllib.parse import urlsplit
from PIL import Image,ImageOps,ImageDraw
VERSION=1

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def fingerprint(live,sources):
 return digest({'version':VERSION,'url':live['url'],'title':live['title'],'rules':' '.join(live['rules'].split()),'rules_images':live.get('rules_images',[]),'samples':[{'rank':s['rank'],'src':s['src'],'link':s.get('link'),'alt':s.get('alt'),'sha256':s['sha256']} for s in sources]})
def download(directory,workers=4):
 root=Path(directory);live=json.loads((root/'live.json').read_text());(root/'images').mkdir(exist_ok=True)
 def one(pair):
  i,row=pair;dest=root/'images'/('%02d.png'%(i+1));tmp=dest.with_suffix('.partial')
  # Fetch again on every fresh run, detecting replaced bytes at unchanged URLs.
  urlretrieve(row['src'],tmp)
  with Image.open(tmp) as im:im.convert('RGB').save(dest)
  tmp.unlink();return dict(row,file=str(dest.resolve()),sha256=sha(dest))
 with ThreadPoolExecutor(max_workers=workers) as ex:sources=list(ex.map(one,enumerate(live['samples'])))
 (root/'sources.json').write_text(json.dumps(sources,ensure_ascii=False,indent=2))
 sheet=Image.new('RGB',(1500,1300),'#e5e5e5');d=ImageDraw.Draw(sheet)
 for i,row in enumerate(sources):
  im=Image.open(row['file']);im.thumbnail((290,610));x=(i%5)*300+(300-im.width)//2;y=(i//5)*650+25;sheet.paste(im,(x,y));d.text(((i%5)*300+12,(i//5)*650+5),'%02d %s'%(i+1,row['rank']),fill='black')
 sheet.save(root/'contact-sheet.jpg');return fingerprint(live,sources)
def lookup(cache,key,root):
 entry=Path(cache)/key
 try:
  seal=json.loads((entry/'seal.json').read_text())
  if any(sha(entry/name)!=value for name,value in seal.items()):return False
  review=json.loads((entry/'research-review.json').read_text())
  if review.get('passed') is not True or len(review.get('samples',[]))!=10:return False
  for name in seal:shutil.copyfile(entry/name,Path(root)/name)
  return True
 except (OSError,ValueError,KeyError):return False

def store(cache,key,root):
 root=Path(root);entry=Path(cache)/key;entry.mkdir(parents=True,exist_ok=True)
 review=json.loads((root/'research-review.json').read_text())
 if review.get('passed') is not True or len(review.get('samples',[]))!=10:raise ValueError('Research review must cover all ten samples')
 seal={}
 for name in ['analysis.md','research-review.json']:
  p=root/name
  if not p.read_text().strip():raise ValueError('Empty analysis')
  shutil.copyfile(p,entry/name);seal[name]=sha(entry/name)
 (entry/'seal.json').write_text(json.dumps(seal))
