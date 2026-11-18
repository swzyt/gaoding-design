"""Live rules + ordered sample contents form the cache key; damaged caches miss."""
import hashlib,json,shutil,subprocess,tempfile,time,ssl
from http.client import HTTPException
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen
from urllib.error import URLError
from urllib.parse import urlsplit
from PIL import Image,ImageOps,ImageDraw
VERSION=1

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def fingerprint(live,sources):
 return digest({'version':VERSION,'url':live['url'],'title':live['title'],'rules':' '.join(live['rules'].split()),'rules_images':live.get('rules_images',[]),'samples':[{'rank':s['rank'],'src':s['src'],'link':s.get('link'),'alt':s.get('alt'),'sha256':s['sha256']} for s in sources]})
def fetch_image(url,destination):
 """Fetch fresh bytes only; bounded network fallback preserves the exact source URL."""
 destination=Path(destination);deadline=time.monotonic()+15
 try:
  with urlopen(url,timeout=10) as response,destination.open('wb') as stream:
   while True:
    if time.monotonic()>deadline:raise TimeoutError('urllib download exceeded 15-second budget')
    chunk=response.read(65536)
    if not chunk:break
    stream.write(chunk)
  return 'urllib'
 except (URLError,TimeoutError,ConnectionError,HTTPException,ssl.SSLError) as first:
  # curl must not accidentally validate a partial urllib response or an older image.
  destination.write_bytes(b'')
  try:
   subprocess.run(['curl','-L','--connect-timeout','8','--max-time','20','--fail','--silent','--show-error','--output',str(destination),'--',url],check=True,capture_output=True,text=True,timeout=23)
   return f'curl fallback after {type(first).__name__}: {first}'
  except (OSError,subprocess.SubprocessError) as second:
   detail=(getattr(second,'stderr',None) or str(second))
   if isinstance(detail,bytes):detail=detail.decode(errors='replace')
   raise RuntimeError(f'Download failed for {url}; urllib: {type(first).__name__}: {first}; curl: {type(second).__name__}: {detail[:2000]}') from second

def download(directory,workers=4):
 root=Path(directory);live=json.loads((root/'live.json').read_text());(root/'images').mkdir(exist_ok=True)
 def one(pair):
  i,row=pair;dest=root/'images'/('%02d.png'%(i+1))
  with tempfile.NamedTemporaryFile(dir=dest.parent,prefix=dest.stem+'-',suffix='.partial',delete=False) as stream:tmp=Path(stream.name)
  route='network download'
  try:
   # Fetch again on every fresh run, detecting replaced bytes at unchanged URLs.
   route=fetch_image(row['src'],tmp)
   with Image.open(tmp) as im:im.load();im.convert('RGB').save(dest)
   return dict(row,file=str(dest.resolve()),sha256=sha(dest))
  except Exception as error:raise RuntimeError(f'Research image {i+1} from {row["src"]} failed ({route}): {error}') from error
  finally:
   if tmp.parent.resolve()==dest.parent.resolve() and tmp.name.startswith(dest.stem+'-') and tmp.exists():tmp.unlink()
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
