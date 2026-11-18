# -*- coding: utf-8 -*-
"""Include original tool records and referenced evidence, not only generated indexes."""
import json
import hashlib
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from agent_assets import safe_path


def attach(concept, archive):
    root = Path(concept).resolve()
    paths = set()
    controls = ['creation-process.json', 'native-input.json', 'asset-plan.json', 'external-assets.json', 'native-selection.json',
                'layout-comparison.json', 'copyright-evidence.json', 'agent-assets/request.json',
                'agent-assets/response.json', 'release/task-provenance.json', 'release/shape-provenance.json',
                'release/registered-assets/request.json', 'release/registered-assets/response.json',
                'release/material-review.json', 'release/visual-review.json']
    for name in controls:
        if (root / name).is_file():
            paths.add(safe_path(root, name))
    process = root / 'creation-process.json'
    if process.exists():
        for record in json.loads(process.read_text()).get('files', []):
            file = safe_path(root, record['path'])
            if hashlib.sha256(file.read_bytes()).hexdigest() != record.get('sha256'):
                raise ValueError('Creation process source changed: ' + record['path'])
            paths.add(file)
    for name in ['external-assets.json', 'agent-assets/response.json']:
        if not (root / name).exists():
            continue
        manifest = json.loads((root / name).read_text())
        for row in manifest.get('assets', []):
            paths.add(safe_path(root, row['path']))
            for evidence in row.get('evidence', []):
                paths.add(safe_path(root, evidence['path']))
    file = root / 'copyright-evidence.json'
    if file.exists():
        for group in json.loads(file.read_text()).get('categories', {}).values():
            for row in group:
                paths.add(safe_path(root, row['path']))
    for name in ['release/registered-assets/response.json']:
        if not (root / name).exists():
            continue
        for row in json.loads((root / name).read_text()).get('assets', []):
            if row.get('evidence'):
                paths.add(safe_path(root / 'release', row['evidence']['path']))
    with ZipFile(archive, 'a', ZIP_DEFLATED) as bundle:
        existing = set(bundle.namelist())
        for file in sorted(paths):
            name = 'provenance/original-records/' + str(file.relative_to(root))
            if name not in existing:
                bundle.write(file, name)
    return len(paths)
