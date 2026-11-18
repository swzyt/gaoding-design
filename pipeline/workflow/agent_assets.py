"""Durable, tool-neutral Agent asset handoff; this module never submits jobs.

prepare(concept, plan=None) freezes asset-plan.json into agent-assets/request.json.
The Agent writes external-assets.json (or agent-assets/response.json), echoing token
and plan_sha256, with assets containing id, path, sha256, origin (ai/programmatic),
tool, provider, model, task_id, input, status and evidence [{path,sha256,kind}].
Use task_id only for an actual provider task. If the tool returns no server task,
record its real DSH invocation_id instead. Never invent a UUID as a task ID.
AI records require an actual screenshot or saved tool response; local originals
require source-code/execution-log. These files attest recorded provenance, not
visual quality, authorship or platform acceptance. Never manufacture screenshots.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets

from PIL import Image


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def safe_path(root, value):
    """Only regular files within this concept, including resolved symlink checks."""
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ValueError(f'Expected concept-relative path: {value!r}')
    root = Path(root).resolve()
    target = (root / value).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError(f'Missing or unsafe asset/evidence: {value}')
    return target


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + secrets.token_hex(6) + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def _control_path(root, relative):
    path = Path(root) / relative
    if not path.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError(f'Unsafe handoff control path: {relative}')
    return path


def prepare(concept, plan=None):
    root = Path(concept).resolve()
    root.mkdir(parents=True, exist_ok=True)
    plan_file = _control_path(root, 'asset-plan.json')
    directory = _control_path(root, 'agent-assets')
    directory.mkdir(exist_ok=True)
    # Exclusive lock prevents two native controllers from minting different tokens.
    lock = directory / 'prepare.lock'
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise RuntimeError('Uncertain handoff preparation; inspect prepare.lock, do not resubmit') from exc
    try:
        os.close(fd)
        if plan is not None:
            if not isinstance(plan, dict):
                raise ValueError('plan must be an object')
            if plan_file.exists() and load(plan_file) != plan:
                raise ValueError('Plan changed: preserve existing handoff; use a new concept directory')
            if not plan_file.exists():
                atomic_json(plan_file, plan)
        plan = load(plan_file)
        planned_assets = plan.get('assets')
        if not isinstance(planned_assets, list) or any(not isinstance(item, dict) for item in planned_assets):
            raise ValueError('asset-plan.assets must be a list of objects')
        ids = [item.get('id') for item in planned_assets]
        if any(not isinstance(key, str) or not key.strip() for key in ids) or len(set(ids)) != len(ids):
            raise ValueError('Plan asset IDs must be nonempty and unique')
        path = _control_path(root, 'agent-assets/request.json')
        if path.exists():
            request = load(path)
            if request.get('plan_sha256') != digest(plan_file) or request.get('plan') != plan:
                raise ValueError('Plan changed: recover existing handoff; do not resubmit')
            return request
        if (root / 'external-assets.json').exists() or (directory / 'response.json').exists() or (directory / 'submission-started').exists():
            raise RuntimeError('Orphaned response/submission: recover original request, do not resubmit')
        request = dict(schema_version=1, token=secrets.token_hex(24), plan_sha256=digest(plan_file), plan=plan,
                       instructions='Use authorized tools only. Preserve exact inputs, IDs, original evidence and hashes. Resume uncertain tasks; never blindly resubmit.')
        atomic_json(path, request)
        return request
    finally:
        lock.unlink()


def _checked_file(root, row):
    path = safe_path(root, row.get('path'))
    if row.get('sha256') != digest(path):
        raise ValueError(f'Hash mismatch: {row.get("path")}')
    return path


def _image(path, require_alpha=False):
    with Image.open(path) as im:
        im.load()
        extrema = im.convert('RGBA').getchannel('A').getextrema()
        if require_alpha and (extrema[0] == 255 or extrema[1] == 0):
            raise ValueError(f'Expected visible subject and transparent pixels: {path.name}')
        return {'width': im.width, 'height': im.height, 'alpha_range': list(extrema)}


def validate(concept, recipe=None):
    """Read-only validation. Raises on missing/changed/uncertain provenance.

    recipe may be a dict or a concept-relative/absolute recipe file. With a pure
    shape/text recipe no external manifest is required. No state is marked done.
    """
    root = Path(concept).resolve()
    if recipe is None and (root / 'release-recipe.json').exists():
        recipe = load(root / 'release-recipe.json')
    elif isinstance(recipe, (str, Path)):
        recipe_path = Path(recipe)
        recipe = load(recipe_path if recipe_path.is_absolute() else safe_path(root, str(recipe_path)))
    images = [r for r in (recipe or {}).get('layers', []) if r.get('type') == 'image']
    candidates = [p for p in (_control_path(root, 'external-assets.json'), _control_path(root, 'agent-assets/response.json')) if p.exists()]
    if not candidates:
        if recipe is not None and not images and not (root / 'asset-plan.json').exists():
            return dict(schema_version=1, validated=True, assets=[], origin='native-shapes-and-text')
        raise ValueError('Missing external asset provenance; preserve existing tasks and recover receipts')
    response = load(candidates[0])
    if any(load(path) != response for path in candidates[1:]):
        raise ValueError('Conflicting external asset responses')
    request = load(_control_path(root, 'agent-assets/request.json'))
    _control_path(root, 'asset-plan.json')
    if (response.get('schema_version') != 1 or response.get('token') != request.get('token')
            or not request.get('token') or response.get('plan_sha256') != request.get('plan_sha256')
            or digest(root / 'asset-plan.json') != request.get('plan_sha256')
            or load(root / 'asset-plan.json') != request.get('plan')):
        raise ValueError('Stale or mismatched asset request/response')
    records = response.get('assets')
    if not isinstance(records, list):
        raise ValueError('response.assets must be a list')
    by_id, by_path = {}, {}
    for row in records:
        key = row.get('id')
        if not isinstance(key, str) or not key or key in by_id:
            raise ValueError('Asset IDs must be unique')
        origin = row.get('origin')
        if origin not in ('ai', 'programmatic') or row.get('status') != 'completed':
            raise ValueError(f'{key}: missing origin or task not completed; recover, never resubmit')
        for field in ('tool', 'provider', 'model'):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError(f'{key}: missing {field} (use actual local library/version for local work)')
        if not isinstance(row.get('input'), dict) or not row['input']:
            raise ValueError(f'{key}: exact tool input required')
        if origin == 'ai' and not any(isinstance(row.get(field), str) and row[field].strip() for field in ('task_id', 'invocation_id')):
            raise ValueError(f'{key}: actual provider task_id or real DSH invocation_id required')
        path = _checked_file(root, row)
        if str(path) in by_path:
            raise ValueError('Duplicate asset path')
        _image(path, row.get('require_alpha', False))
        evidence = row.get('evidence')
        if not isinstance(evidence, list) or not evidence:
            raise ValueError(f'{key}: real evidence required')
        kinds = set()
        for item in evidence:
            evidence_path = _checked_file(root, item)
            if evidence_path == path:
                raise ValueError('Asset cannot serve as its own provenance evidence')
            kinds.add(item.get('kind'))
            if item.get('kind') == 'screenshot':
                _image(evidence_path)
        required = {'screenshot', 'tool-response'} if origin == 'ai' else {'source-code', 'execution-log'}
        if not kinds.intersection(required):
            raise ValueError(f'{key}: missing original tool/source evidence')
        by_id[key], by_path[str(path)] = row, row
    planned = request['plan']['assets']
    if {r['id'] for r in planned} != set(by_id):
        raise ValueError('Response must cover exactly the frozen plan asset IDs')
    for item in planned:
        row = by_id[item['id']]
        if item.get('source') and safe_path(root, item['source']) != safe_path(root, row['path']):
            raise ValueError('Planned source changed')
        if item.get('require_alpha'):
            _image(safe_path(root, row['path']), True)
    for layer in images:
        source = safe_path(root, layer['source'])
        if str(source) not in by_path:
            raise ValueError(f'{layer.get("id")}: image source has no provenance')
        row = by_path[str(source)]
        expected = 'original_ai' if row['origin'] == 'ai' else 'original'
        if layer.get('copyright_category') != expected:
            raise ValueError(f'{layer.get("id")}: copyright category must be {expected}')
        alpha = safe_path(root, layer['alpha_source']) if layer.get('alpha_source') else source
        if str(alpha) not in by_path:
            raise ValueError('Alpha source has no provenance')
        _image(alpha, layer.get('require_alpha', False))
    return dict(response, validated=True, manifest=str(candidates[0].relative_to(root)))
