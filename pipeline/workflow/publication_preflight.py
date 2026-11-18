"""Fail before browser work when a new native design is structurally unfinished."""
import json
from pathlib import Path
from agent_assets import validate as validate_assets
from separation_contract import check


def validate(recipe_path):
    recipe_path = Path(recipe_path).resolve()
    root = recipe_path.parent
    if not (root / 'native-input.json').exists():
        return {'status': 'legacy-unverified', 'visual_verified': False}
    source = check(root, recipe_path)
    if source['status'] == 'legacy-unverified':
        return source
    recipe = json.loads(recipe_path.read_text(encoding='utf-8'))
    validate_assets(root, recipe)
    built = check(root, root / recipe.get('output', 'release') / 'spec.json')
    if source['status'] == 'structurally-verified':
        layers = {row['id']: row for row in recipe['layers']}
        subjects = {pair.get('subject') for pair in recipe.get('layer_audit', {}).get('pairs', [])}
        required = {layers[obj['layer_id']]['name'] for obj in source['objects'] if obj['role'] != 'background'}
        missing = required - subjects
        if missing:
            raise ValueError('Independent objects missing individual hide-audit subjects: ' + ', '.join(sorted(missing)))
    return {'status': source['status'], 'source': source, 'built': built, 'visual_verified': False}
