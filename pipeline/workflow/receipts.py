"""Local provenance index, NOT a screenshot or platform copyright certificate.

Never queries gd-cli, never infers completion from master.task or a file's name.
Legacy CLI jobs can be recovered from persisted completed result + resources
and the original input. Unknown submissions remain errors, not new submissions.
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

try:
    from . import agent_assets
except ImportError:
    import agent_assets


def _legacy(root, recipe):
    records = []
    master_task = root / 'master.task'
    master_id = agent_assets.load(master_task).get('taskId') if master_task.exists() else None
    known_master = False
    for directory in sorted(root.glob('*-job')):
        if not directory.is_dir():
            continue
        result_file = directory / 'result.json'
        if not result_file.exists():
            if any((directory / name).exists() for name in ('job.json', 'submission-started', 'request.json')):
                raise ValueError(f'Uncertain legacy task: {directory.name}; recover saved result, do not resubmit')
            continue
        result = agent_assets.load(result_file)
        task_id = result.get('taskId')
        if result.get('state') != 'completed' or not task_id:
            raise ValueError(f'{directory.name}: no confirmed completed task receipt')
        job_file = directory / 'job.json'
        if job_file.exists() and agent_assets.load(job_file).get('taskId') != task_id:
            raise ValueError(f'{directory.name}: task ID mismatch')
        request_file = directory / 'request.json'
        request = agent_assets.load(request_file)
        if not request.get('tool') or not isinstance(request.get('input'), dict) or not request['input']:
            raise ValueError(f'{directory.name}: missing original tool input')
        resources = agent_assets.load(directory / 'resources.json')
        checked = []
        for item in resources:
            # Historical resource manifests used absolute paths; only accept ones
            # that resolve inside this concept. Preserve originals without edits.
            raw = Path(item['file'])
            path = raw.resolve() if raw.is_absolute() else (directory / raw).resolve()
            if not path.is_relative_to(root) or not path.is_file() or agent_assets.digest(path) != item.get('sha256'):
                raise ValueError(f'{directory.name}: missing/changed/unsafe legacy resource')
            checked.append(dict(path=str(path.relative_to(root)), sha256=item['sha256'], uri=item.get('uri')))
        if not checked:
            raise ValueError(f'{directory.name}: no preserved resources')
        records.append(dict(id=directory.name, origin='ai', tool=request['tool'], input=request['input'],
                            task_id=task_id, status=result['state'],
                            provider='gd-cli (persisted receipt)',
                            model=result.get('result', {}).get('usage', {}).get('model'),
                            resources=checked, evidence=[dict(path=str(result_file.relative_to(root)),
                            sha256=agent_assets.digest(result_file), kind='tool-response')]))
        if task_id == master_id:
            known_master = True
    if master_id and not known_master:
        raise ValueError('master.task has no matching completed local result; recover original task, do not resubmit')
    if not records:
        raise ValueError('Missing true asset provenance')
    # A legacy recipe may use a copied master/resource. Bind by bytes, never names.
    hashes = {r['sha256'] for record in records for r in record['resources']}
    for layer in (recipe or {}).get('layers', []):
        if layer.get('type') != 'image':
            continue
        for field in ('source', 'alpha_source'):
            if layer.get(field) and agent_assets.digest(agent_assets.safe_path(root, layer[field])) not in hashes:
                raise ValueError(f'{layer.get("id")}: unrecorded legacy image; add true external provenance')
        if layer.get('copyright_category') != 'original_ai':
            raise ValueError('Legacy AI resource must be classified original_ai')
        alpha = layer.get('alpha_source', layer['source'])
        agent_assets._image(agent_assets.safe_path(root, alpha), layer.get('require_alpha', False))
    return dict(schema_version=1, validated=True, legacy=True, assets=records)


def collect(concept, recipe=None):
    root = Path(concept).resolve()
    if recipe is None and (root / 'release-recipe.json').exists():
        recipe = agent_assets.load(root / 'release-recipe.json')
    elif isinstance(recipe, (str, Path)):
        path = Path(recipe)
        recipe = agent_assets.load(path if path.is_absolute() else agent_assets.safe_path(root, str(path)))
    if any((root / p).exists() for p in ('external-assets.json', 'agent-assets/request.json', 'asset-plan.json', 'agent-assets/response.json')):
        return agent_assets.validate(root, recipe)
    if recipe is not None and not any(row.get('type') == 'image' for row in recipe.get('layers', [])):
        return agent_assets.validate(root, recipe)
    return _legacy(root, recipe)


def generate(concept, recipe=None):
    root = Path(concept).resolve()
    report = collect(root, recipe)
    report['notice'] = 'Local provenance index only; not a tool screenshot, authenticity certification or platform-required proof. Original evidence must be retained and supplied separately.'
    out = agent_assets._control_path(root, 'release')
    out.mkdir(exist_ok=True)
    agent_assets.atomic_json(out / 'task-provenance.json', report)
    # Deliberately plain index: no tool logos, invented UI, or fake task proof.
    rows = [f"{row['id']} | {row.get('tool')} | {row.get('status')} | {row.get('task_id') or row.get('invocation_id') or 'local execution'}" for row in report['assets']]
    rows = ['PROVENANCE INDEX - NOT A TOOL SCREENSHOT',
            'Original evidence is referenced in task-provenance.json.',
            'This generated index does not replace platform-required evidence.', '', *rows]
    if not report['assets']:
        rows.append('Native recipe shapes/text only. No AI tasks claimed.')
    font = ImageFont.load_default()
    image = Image.new('RGB', (1400, max(200, 45 + 30 * len(rows))), 'white')
    draw = ImageDraw.Draw(image)
    for i, row in enumerate(rows):
        draw.text((20, 20 + i * 30), row.encode('ascii', 'backslashreplace').decode('ascii'), font=font, fill='black')
    image.save(out / 'receipts.png')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('concept', type=Path)
    args = parser.parse_args()
    generate(args.concept)


if __name__ == '__main__':
    main()
