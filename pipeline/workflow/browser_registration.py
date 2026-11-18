# -*- coding: utf-8 -*-
"""Resumable browser/Agent DAM handoff without GD CLI or guessed account IDs."""
import hashlib
import json
from pathlib import Path
from PIL import Image
from agent_assets import atomic_json, safe_path


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(recipe_path, repository_id=None):
    recipe_path = Path(recipe_path).resolve()
    recipe = load(recipe_path)
    root = recipe_path.parent
    out = root / recipe.get('output', 'release')
    if out.resolve().parent != root:
        raise ValueError('Registration output must be a direct concept subdirectory')
    rows = []
    for layer in recipe['layers']:
        if layer['type'] == 'text':
            continue
        category = layer.get('copyright_category')
        if category not in ('original', 'original_ai', 'non_original'):
            raise ValueError('Explicit supported image category required: ' + layer['name'])
        asset = safe_path(out, 'assets/' + layer['id'] + '.png')
        title = recipe['title'].split(' ')[0] + '-' + layer['name'] + '-' + sha(asset)[:10]
        rows.append({'id': layer['id'], 'layer': layer['name'], 'title': title,
                     'source': str(asset.relative_to(out)), 'sha256': sha(asset), 'category': category})
    payload = {'schema': 1, 'recipe_sha256': sha(recipe_path), 'repository_id': str(repository_id) if repository_id is not None else None, 'assets': rows}
    payload['token'] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    directory = out / 'registered-assets'
    directory.mkdir(exist_ok=True)
    file = directory / 'request.json'
    if file.exists() and load(file) != payload:
        raise ValueError('Final registration inputs changed; reconcile previous uploads before a new revision')
    atomic_json(file, payload)
    return payload


def validate(recipe_path, repository_id=None):
    recipe_path = Path(recipe_path).resolve()
    recipe = load(recipe_path)
    out = recipe_path.parent / recipe.get('output', 'release')
    request = prepare(recipe_path, repository_id)
    response = load(out / 'registered-assets/response.json')
    if response.get('token') != request['token']:
        raise ValueError('Stale browser registration response')
    received = response.get('assets')
    if not isinstance(received, list) or len(received) != len(request['assets']):
        raise ValueError('Browser registration must cover every final image exactly once')
    by_id = {row['id']: row for row in received}
    if len(by_id) != len(received) or set(by_id) != {row['id'] for row in request['assets']}:
        raise ValueError('Duplicate or missing registered image IDs')
    seen_assets = set(); results = []
    for expected in request['assets']:
        row = by_id[expected['id']]
        for key in ('sha256', 'title', 'layer', 'category'):
            if row.get(key) != expected[key]:
                raise ValueError('Browser upload differs from frozen final asset: ' + expected['id'])
        asset_id, repo = row.get('asset_id'), row.get('repository_id')
        if not isinstance(asset_id, str) or not asset_id.strip() or asset_id in seen_assets:
            raise ValueError('Actual unique DAM asset ID required')
        if not isinstance(repo, str) or not repo.strip() or (request['repository_id'] and repo != request['repository_id']):
            raise ValueError('Actual current repository ID required, never use a historical fallback')
        if row.get('state') != 'verified' or not isinstance(row.get('url'), str) or not row['url'].startswith('https://'):
            raise ValueError('Reopened browser upload verification and URL required')
        evidence = row.get('evidence', {})
        image = safe_path(out, evidence.get('path'))
        if evidence.get('sha256') != sha(image):
            raise ValueError('Changed browser registration screenshot')
        with Image.open(image) as screenshot:
            screenshot.verify()
        seen_assets.add(asset_id)
        results.append(dict(expected, **{'source': str((out / expected['source']).resolve()),
                                       'asset_id': asset_id, 'repository_id': repo, 'url': row['url'],
                                       'evidence': evidence, 'method': 'browser', 'verified': True}))
    target = out / 'registered-assets.json'
    if target.exists() and load(target) != results:
        raise ValueError('Existing registration differs; inspect bindings before replacing receipts')
    atomic_json(target, results)
    return results
