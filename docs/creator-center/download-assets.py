"""Archive public source illustrations; never use reference images as production assets."""
import concurrent.futures, hashlib, json, time, urllib.request, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'assets'
ASSETS.mkdir(exist_ok=True)
rows = {}
for source in sorted((ROOT / 'sources').glob('*.json')):
    doc = json.loads(source.read_text())
    for im in doc.get('images', []):
        url = im['src']
        if not url.startswith(('https://', 'http://')):
            continue
        key = hashlib.sha256(url.encode()).hexdigest()[:20]
        row = rows.setdefault(key, {'url': url, 'file': f'assets/{key}.image', 'references': []})
        row['references'].append({'document': source.stem, 'index': im['index'], 'width': im['width'], 'height': im['height'], 'alt': im.get('alt', '')})

def download(item):
    key, row = item
    dest = ROOT / row['file']
    try:
        if not dest.exists():
            req = urllib.request.Request(row['url'], headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=30) as response:
                data = response.read()
            dest.write_bytes(data)
        data = dest.read_bytes()
        if data.startswith(b'\x89PNG'): ext = '.png'
        elif data.startswith(b'\xff\xd8'): ext = '.jpg'
        elif data.startswith(b'GIF8'): ext = '.gif'
        elif data[:4] == b'RIFF': ext = '.webp'
        else: ext = '.bin'
        final = ASSETS / (key + ext)
        # Confirm both resolved paths remain in the intended asset directory before rename.
        assert dest.resolve().parent == ASSETS.resolve() and final.resolve().parent == ASSETS.resolve()
        if dest != final: dest.rename(final)
        row.update(file=str(final.relative_to(ROOT)), bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), status='saved')
    except Exception as exc:
        row.update(status='error', error=str(exc))
    return key, row

# Reuse previously saved files, preserving their actual extension.
index_path = ROOT / 'sources/assets-index.json'
if index_path.exists():
    previous = json.loads(index_path.read_text()).get('assets', {})
    for key, row in rows.items():
        old = previous.get(key, {})
        if old.get('status') == 'saved' and (ROOT / old.get('file', '')).is_file():
            row.update({k: old[k] for k in ('file', 'bytes', 'sha256', 'status')})

CRITICAL = {'fr75o0cutbee4r54', 'nq8p150hfxrzpoi5', 'vi488gxah9fk7ogt', 'qmceqpf95b6g00gc', 'wrh7rgy4svyxi8kt', 'hdgid4mgbhriygn5', 'td9amgo07k6gs6la', 'mwc8r0w7bvge6gkg', 'pe9gd43wqf0n19f0'}
def ensure(item):
    key, row = item
    if row.get('status') == 'saved': return key, row
    if '--rules-only' in sys.argv and not any(ref['document'] in CRITICAL for ref in row['references']):
        row.update(status='referenced', file=None)
        return key, row
    return download(item)
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    results = dict(pool.map(ensure, rows.items()))
manifest = {'collectedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'assets': results}
index_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'assets':len(results), 'saved':sum(r['status']=='saved' for r in results.values()), 'errors':sum(r['status']=='error' for r in results.values()), 'bytes':sum(r.get('bytes',0) for r in results.values())}))
