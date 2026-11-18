# -*- coding: utf-8 -*-
"""Native-first design: compare real editable layouts, never generate/split an image here."""
import hashlib
import json
import re
import shutil
from pathlib import Path

from agent_assets import prepare as prepare_assets, validate as validate_assets, safe_path, atomic_json
from separation_contract import check as check_separation, validate_contract, contract_hash, frozen_contract


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(brief_path, build_root):
    brief_path = Path(brief_path).resolve()
    brief = load(brief_path)
    research = brief_path.parent
    sources = load(safe_path(research, brief['research']['sources']))
    analysis = safe_path(research, brief['research']['analysis'])
    review = load(research / 'research-review.json')
    if len(sources) != 10 or not analysis.read_text().strip() or review.get('passed') is not True or len(review.get('samples', [])) != 10:
        raise ValueError('Ten inspected samples, written analysis and explicit research review are required')
    evidence = {str(brief_path): sha(brief_path), str(analysis): sha(analysis),
                str(research / 'sources.json'): sha(research / 'sources.json'),
                str(research / 'research-review.json'): sha(research / 'research-review.json')}
    for row in sources:
        if not row.get('src'):
            raise ValueError('Research sample source URL is required')
        source = Path(row['file'])
        if source.is_absolute():
            try:
                source = source.resolve().relative_to(research)
            except ValueError as exc:
                raise ValueError('Research image must belong to this run') from exc
        path = safe_path(research, str(source))
        if row.get('sha256') and row['sha256'] != sha(path):
            raise ValueError('Research image content changed')
        evidence[str(path)] = sha(path)
    concepts = brief.get('concepts', [])
    if len(concepts) != 1:
        raise ValueError('Choose one creative direction before native layout comparison')
    concept = concepts[0]
    if not re.fullmatch(r'[a-z0-9_-]+', concept.get('id', '')):
        raise ValueError('Unsafe concept ID')
    for field in ('concept', 'reading_path', 'zones', 'copy', 'layers', 'palette', 'typography'):
        if not concept.get(field):
            raise ValueError('Missing Agent-authored design field: ' + field)
    variants = concept.get('layout_variants', [])
    if not 2 <= len(variants) <= 4:
        raise ValueError('Compare two to four genuinely different native layouts')
    ids, files = set(), set()
    for variant in variants:
        if not re.fullmatch(r'[a-z0-9_-]+', variant.get('id', '')) or variant['id'] in ids:
            raise ValueError('Unique safe layout IDs are required')
        filename = variant.get('recipe', '')
        if not re.fullmatch(r'[a-z0-9_-]+\.json', filename) or filename in files or filename == 'release-recipe.json':
            raise ValueError('Layout recipes must have unique JSON filenames at the concept root')
        if not variant.get('rationale'):
            raise ValueError('Each layout needs its own design rationale')
        ids.add(variant['id']); files.add(filename)
    root = Path(build_root).resolve() / concept['id']
    root.mkdir(parents=True, exist_ok=True)
    snapshot = {'brief': brief, 'research_sha256': evidence}
    saved = root / 'native-input.json'
    contract = concept.get('separation_contract')
    legacy = saved.exists() and 'separation_contract' not in load(saved)['brief']['concepts'][0]
    if not legacy:
        validate_contract(contract)
        if not contract['objects'] and concept.get('asset_plan', {}).get('assets'):
            raise ValueError('Empty separation contract cannot request external image assets')
        snapshot['separation_contract'] = contract
        snapshot['brief_path'] = str(brief_path)
    if saved.exists():
        if load(saved) != snapshot:
            raise ValueError('Design input changed; preserve the existing concept and review a new revision')
        frozen_contract(root)
    else:
        atomic_json(saved, snapshot)
        atomic_json(root / 'separation-contract.json', {
            'schema_version': 1, 'contract': contract, 'contract_sha256': contract_hash(contract),
            'native_input_sha256': sha(saved)})
    plan = concept.get('asset_plan', {'assets': []})
    request = prepare_assets(root, plan)
    return {'concept': str(root), 'variants': variants, 'asset_request': request,
            'separation_status': 'legacy-unverified' if legacy else 'contract-frozen'}


def render_variants(concept):
    from assemble import preview
    root = Path(concept).resolve()
    frozen_contract(root)
    config = load(root / 'native-input.json')['brief']['concepts'][0]
    records = []
    signatures = set()
    for variant in config['layout_variants']:
        recipe_path = safe_path(root, variant['recipe'])
        recipe = load(recipe_path)
        if recipe.get('output', 'release') != 'release':
            raise ValueError('Native final output must use release/')
        if not recipe.get('layers') or not any(row.get('type') == 'text' for row in recipe['layers']):
            raise ValueError('A reusable native layout requires independently editable text')
        for row in recipe['layers']:
            if row.get('type') == 'text' and (not row.get('font') or not row.get('gd_font') or not row.get('preview_font')):
                raise ValueError('Use explicit PSD, preview and available Gaoding fonts: ' + str(row.get('name')))
        validate_assets(root, recipe)
        separation = check_separation(root, recipe)
        # Ignore packaging metadata when detecting duplicate candidate layouts.
        signature = json.dumps({'canvas': recipe.get('canvas'), 'layers': recipe['layers']}, sort_keys=True, ensure_ascii=False)
        if signature in signatures:
            raise ValueError('Identical layout candidates do not count as a design comparison')
        signatures.add(signature)
        previews = []
        pages = recipe.get('pages') or [{'id': 'main', 'canvas': recipe['canvas']}]
        page_ids = [page.get('id') for page in pages]
        if len(set(page_ids)) != len(page_ids) or any(not isinstance(key, str) or not re.fullmatch(r'[a-z0-9_-]+', key) for key in page_ids):
            raise ValueError('Unique safe page IDs are required')
        if recipe.get('pages') and (any(row.get('page') not in page_ids for row in recipe['layers']) or any(not any(row.get('page') == key for row in recipe['layers']) for key in page_ids)):
            raise ValueError('Every page and layer must have an explicit valid page assignment')
        for page in pages:
            dest = root / 'layout-previews' / variant['id'] / (page['id'] + '.jpg')
            dest.parent.mkdir(parents=True, exist_ok=True)
            if recipe.get('pages'):
                draft = dict(recipe, canvas=page['canvas'], layers=[row for row in recipe['layers'] if row.get('page') == page['id']])
                draft.pop('pages', None)
                page_recipe = root / ('native-preview-' + variant['id'] + '-' + page['id'] + '.json')
                atomic_json(page_recipe, draft)
                preview(page_recipe, dest)
            else:
                preview(recipe_path, dest)
            previews.append({'page': page['id'], 'path': str(dest.relative_to(root)), 'sha256': sha(dest)})
        records.append({'id': variant['id'], 'recipe': variant['recipe'], 'recipe_sha256': sha(recipe_path),
                        'preview': previews[0]['path'], 'preview_sha256': previews[0]['sha256'],
                        'previews': previews, 'rationale': variant['rationale'], 'separation_check': separation,
                        'native_input_sha256': sha(root / 'native-input.json')})
    atomic_json(root / 'layout-comparison.json', {'variants': records})
    return records


def select(concept, selected_id):
    root = Path(concept).resolve()
    records = load(root / 'layout-comparison.json')['variants']
    matches = [row for row in records if row['id'] == selected_id]
    if len(matches) != 1:
        raise ValueError('Select exactly one rendered layout by selected_id')
    selected = matches[0]
    recipe_file = safe_path(root, selected['recipe'])
    image = safe_path(root, selected['preview'])
    if sha(recipe_file) != selected['recipe_sha256'] or sha(image) != selected['preview_sha256']:
        raise ValueError('Layout changed after comparison; render and visually review again')
    for board in selected.get('previews', []):
        if sha(safe_path(root, board['path'])) != board['sha256']:
            raise ValueError('Page preview changed after comparison')
    recipe = load(recipe_file)
    validate_assets(root, recipe)
    separation = check_separation(root, recipe)
    if selected.get('native_input_sha256') and selected['native_input_sha256'] != sha(root / 'native-input.json'):
        raise ValueError('Frozen native input changed after comparison')
    if selected.get('separation_check') and selected['separation_check'] != separation:
        raise ValueError('Separation/image content changed after comparison')
    contract = frozen_contract(root)
    if contract is not None:
        recipe['separation_contract'] = contract
        recipe['separation_contract_sha256'] = contract_hash(contract)
        recipe['separation_check'] = separation
    recipe.update(output='release', reference_master='master.jpg')
    destination = root / 'release-recipe.json'
    if destination.exists() and load(destination) != recipe:
        raise ValueError('Existing final recipe differs; preserve the reviewed revision')
    atomic_json(destination, recipe)
    shutil.copyfile(image, root / 'master.jpg')
    atomic_json(root / 'native-selection.json', dict(selected, mode='native', separation_check=separation, note='Locally rendered composition, not an AI-generated master'))
    return str(destination)
