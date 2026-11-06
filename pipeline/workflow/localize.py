"""Download actual native template resources and retain their layer geometry."""
import argparse, hashlib, json
from pathlib import Path
from urllib.request import urlretrieve
from urllib.parse import urlparse


def leaves(elements, parent=(0, 0)):
    for element in elements:
        x = parent[0] + element.get('left', 0)
        y = parent[1] + element.get('top', 0)
        if element.get('elements'):
            yield from leaves(element['elements'], (x, y))
        else:
            yield dict(element, left=x, top=y)


def localize(source, out):
    source, out = Path(source), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    template = json.loads(source.read_text())
    pages = template.get('pages') or template.get('layouts')
    if not pages:
        raise ValueError('Unknown native template page structure; inspect before conversion')
    catalog = []
    for page_index, page in enumerate(pages):
        for index, layer in enumerate(leaves(page.get('elements', []))):
            item = {'page': page_index, 'index': index, 'native': layer}
            url = layer.get('url') or layer.get('imageUrl')
            if url:
                extension = Path(urlparse(url).path).suffix or '.data'
                filename = f'p{page_index}-{index:02d}{extension}'
                dest = out / filename
                if not dest.exists():
                    temp = dest.with_suffix('.partial')
                    urlretrieve(url, temp)
                    temp.replace(dest)
                item['file'] = filename
                item['sha256'] = hashlib.sha256(dest.read_bytes()).hexdigest()
            catalog.append(item)
    (out / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2))
    (out / 'native-template.json').write_text(json.dumps(template, ensure_ascii=False, indent=2))
    return catalog


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = localize(args.source, args.output)
    print(json.dumps([{'index': row['index'], 'type': row['native']['type'], 'name': row['native'].get('title'), 'file': row.get('file')} for row in result], ensure_ascii=False))
