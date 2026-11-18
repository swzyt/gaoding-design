"""Read-only structural separation checks, never visual/semantic certification.

Contract v1: objects [{id, layer_id, role, require_alpha, coverage?}]. Background
coverage is an explicit {box: [x,y,w,h], page?: id}, not an assumed full canvas.
Foreground requires alpha. Distinct objects require distinct layer IDs, but may
reuse image bytes. check(concept, recipe=None) is the browser/final-review hook.
A successful result still requires human subject identity and baked-copy review.
"""
import hashlib
import json
import math
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw
from agent_assets import safe_path

LIMITATION = 'Structure/files/alpha/mapping only; subject identity, complete visual background and absence of baked-in copies require visual review.'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def contract_hash(contract):
    return hashlib.sha256(json.dumps(contract, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def validate_contract(contract):
    if not isinstance(contract, dict) or contract.get('schema_version') != 1 or not isinstance(contract.get('objects'), list):
        raise ValueError('Explicit separation_contract schema_version:1 and objects list required')
    ids, layers = set(), set()
    for obj in contract['objects']:
        if not isinstance(obj, dict):
            raise ValueError('Separation objects must be mappings')
        for field in ('id', 'layer_id', 'role'):
            if not isinstance(obj.get(field), str) or not obj[field].strip():
                raise ValueError('Separation object requires ' + field)
        if obj['id'] in ids or obj['layer_id'] in layers:
            raise ValueError('Distinct objects require unique object IDs and independent layer IDs')
        ids.add(obj['id']); layers.add(obj['layer_id'])
        if not isinstance(obj.get('require_alpha'), bool):
            raise ValueError('Each object must explicitly declare require_alpha')
        if obj['role'] == 'foreground' and not obj['require_alpha']:
            raise ValueError('Foreground requires require_alpha:true')
        coverage = obj.get('coverage')
        if obj['role'] == 'background' and coverage is None:
            raise ValueError('Background requires explicit coverage box')
        if coverage is not None:
            box = coverage.get('box') if isinstance(coverage, dict) else None
            if not isinstance(box, list) or len(box) != 4 or any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in box) or min(box[2:]) <= 0:
                raise ValueError('Coverage requires a finite positive-size box')
    return contract


def frozen_contract(concept):
    """Verify frozen bytes against a separate seal and original brief evidence."""
    root = Path(concept).resolve()
    snapshot = load(root / 'native-input.json')
    config = snapshot['brief']['concepts'][0]
    contract = config.get('separation_contract')
    if snapshot.get('brief_path') and load(snapshot['brief_path']) != snapshot['brief']:
        raise ValueError('Frozen native input differs from original design brief')
    seal_path = root / 'separation-contract.json'
    if contract is None:
        if seal_path.exists() or 'separation_contract' in snapshot:
            raise ValueError('Frozen separation contract was removed')
        return None
    validate_contract(contract)
    seal = load(seal_path)
    if (snapshot.get('separation_contract') != contract or seal.get('contract') != contract
            or seal.get('contract_sha256') != contract_hash(contract)
            or seal.get('native_input_sha256') != digest(root / 'native-input.json')):
        raise ValueError('Frozen separation contract or native input changed')
    for filename, expected in snapshot['research_sha256'].items():
        if digest(filename) != expected:
            raise ValueError('Frozen research/design evidence changed')
    return contract


def check_recipe(root, recipe, contract, *, exported=False):
    """Check recipe/spec and return hashes; exported permits rasterized native shapes."""
    validate_contract(contract)
    layers = recipe.get('layers', [])
    by_id = {}
    for layer in layers:
        key = layer.get('id')
        if not isinstance(key, str) or not key or key in by_id:
            raise ValueError('Contract recipes require unique explicit layer IDs')
        by_id[key] = layer
    if not contract['objects'] and any(row.get('type') == 'image' and not (exported and row.get('native_type') == 'shape' and row.get('sha256')) for row in layers):
        raise ValueError('Empty object contract is only valid for native text/shape designs')
    records = []
    for obj in contract['objects']:
        row = by_id.get(obj['layer_id'])
        if row is None:
            raise ValueError('Missing required object layer: ' + obj['id'])
        if row.get('role') != obj['role'] or row.get('require_alpha') is not obj['require_alpha']:
            raise ValueError('Object role/require_alpha mismatch: ' + obj['id'])
        if row.get('type') not in ('image', 'shape'):
            raise ValueError('Object must map to an independent image/shape layer')
        coverage = obj.get('coverage')
        if coverage and (row.get('box') != coverage['box'] or ('page' in coverage and row.get('page') != coverage['page'])):
            raise ValueError('Background/object extent differs from declared coverage')
        records.append({'object_id': obj['id'], 'layer_id': row['id'], 'role': obj['role']})
    images = []
    for row in layers:
        if row.get('type') != 'image':
            continue
        path = safe_path(root, row.get('source', row.get('png')))
        actual = digest(path)
        if row.get('sha256') and row['sha256'] != actual:
            raise ValueError('Image content SHA mismatch: ' + row['id'])
        with Image.open(path) as source:
            im = source.convert('RGBA')
        if row.get('crop'):
            im = im.crop(tuple(row['crop']))
        if len(row.get('box', [])) == 4:
            im = im.resize(tuple(map(round, row['box'][2:])), Image.Resampling.LANCZOS)
        alpha_hash = None
        if row.get('alpha_source'):
            alpha_path = safe_path(root, row['alpha_source']); alpha_hash = digest(alpha_path)
            with Image.open(alpha_path) as source:
                im.putalpha(source.convert('RGBA').getchannel('A').resize(im.size, Image.Resampling.LANCZOS))
        if row.get('clip_circle'):
            x,y = row['box'][:2]; cx,cy,diameter = row['clip_circle']
            mask = Image.new('L', im.size)
            ImageDraw.Draw(mask).ellipse((cx-x,cy-y,cx-x+diameter,cy-y+diameter), fill=255)
            im.putalpha(ImageChops.multiply(im.getchannel('A'), mask))
        extrema = im.getchannel('A').getextrema()
        # Near-opaque noise (e.g. alpha 254 everywhere) is not a cut-out.
        # Require at least one effectively transparent pixel (<=16/255) and
        # some visible content; this is structural evidence, not edge quality.
        if row.get('require_alpha') and (extrema[0] > 16 or extrema[1] <= 16):
            raise ValueError('Expected visible pixels and effective transparent area: ' + row['id'])
        images.append({'layer_id': row['id'], 'sha256': actual, 'alpha_sha256': alpha_hash, 'alpha_range': list(extrema)})
    return {'status': 'structurally-verified', 'structurally_verified': True, 'visual_verified': False,
            'contract_sha256': contract_hash(contract), 'objects': records, 'images': images, 'limitations': LIMITATION}


def check(concept, recipe=None):
    root = Path(concept).resolve()
    contract = frozen_contract(root)
    if contract is None:
        return {'status': 'legacy-unverified', 'structurally_verified': False, 'visual_verified': False, 'limitations': LIMITATION}
    if recipe is None:
        recipe = root / 'release-recipe.json'
    recipe_root = root
    if isinstance(recipe, (str, Path)):
        path = Path(recipe)
        path = path if path.is_absolute() else safe_path(root, str(path))
        path = path.resolve()
        if not path.is_relative_to(root):
            raise ValueError('Recipe/spec must belong to this concept')
        recipe_root = path.parent
        recipe = load(path)
    if (recipe.get('separation_contract', contract) != contract
            or recipe.get('separation_contract_sha256', contract_hash(contract)) != contract_hash(contract)):
        raise ValueError('Recipe separation contract differs from frozen input')
    result = check_recipe(recipe_root, recipe, contract, exported=recipe_root != root)
    if recipe.get('separation_check') and recipe['separation_check'].get('images') != result['images']:
        raise ValueError('Image content changed since native selection')
    return result
