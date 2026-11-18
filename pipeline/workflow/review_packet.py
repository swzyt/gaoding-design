"""Collect existing local review evidence; never approve, generate art, or submit.

build_packet(recipe_path) -> JSON-serializable summary of output/review-packet. Missing/stale evidence
is reported in the manifest. Unsafe paths are rejected before writing anything.
Copyright references use the same categories/path/sha256/layers schema as the
publication workflow. Reference validation cannot establish visual quality or
prove authorship: an Agent must still open every image and make that judgement.
"""
import hashlib
import html
import json
import os
from pathlib import Path
from urllib.parse import quote

from PIL import Image

IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp'}
GENERATED_INDEXES = {'receipts.png', 'shape-evidence.png'}


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _inside(root, path):
    target = Path(path).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f'Unsafe path outside concept: {path}')
    return target


def _reference(root, value, base=None):
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ValueError(f'Expected concept-relative reference: {value!r}')
    return _inside(root, (base or root) / value)


def _summary(value, depth=0):
    if depth >= 4:
        return f'[{len(value)} items]' if isinstance(value, (dict, list)) else value
    if isinstance(value, dict):
        result = {k: _summary(v, depth + 1) for k, v in list(value.items())[:30]}
        if len(value) > 30:
            result['_omitted_keys'] = len(value) - 30
        return result
    if isinstance(value, list):
        result = [_summary(v, depth + 1) for v in value[:20]]
        if len(value) > 20:
            result.append({'omitted_items': len(value) - 20})
        return result
    return value[:1000] + '…' if isinstance(value, str) and len(value) > 1000 else value


class _Packet:
    def __init__(self, root, directory):
        self.root, self.directory = root, directory
        self.files, self.data, self.issues = {}, {}, []

    def issue(self, code, path, message, **details):
        self.issues.append(dict(code=code, path=str(path), message=message, **details))

    def add(self, path, role, required=False, expected=None):
        path = _inside(self.root, path)
        relative = path.relative_to(self.root).as_posix()
        if relative not in self.files:
            row = dict(path=relative, roles=[], status='missing')
            self.files[relative] = row
            if path.is_file():
                row.update(status='present', sha256=_sha(path), bytes=path.stat().st_size,
                           href=quote(os.path.relpath(path, self.directory).replace(os.sep, '/'), safe='/'))
                if path.suffix.lower() in IMAGE_SUFFIXES:
                    try:
                        with Image.open(path) as image:
                            image.verify()
                        with Image.open(path) as image:
                            row['dimensions'] = list(image.size)
                            row['alpha_range'] = list(image.getchannel('A').getextrema()) if 'A' in image.getbands() else [255, 255]
                        row['image'] = True
                    except (OSError, ValueError, SyntaxError, RuntimeError) as error:
                        row['status'] = 'invalid_image'
                        self.issue('invalid_image', relative, str(error))
                elif path.suffix.lower() == '.json':
                    try:
                        self.data[relative] = json.loads(path.read_text(encoding='utf-8'))
                        row['summary'] = _summary(self.data[relative])
                    except (OSError, ValueError) as error:
                        row['status'] = 'invalid_json'
                        self.issue('invalid_json', relative, str(error))
            elif path.exists():
                row['status'] = 'not_a_file'
                self.issue('not_a_file', relative, 'Expected a regular file')
        row = self.files[relative]
        if role not in row['roles']:
            row['roles'].append(role)
        if required and row['status'] == 'missing' and not row.get('required'):
            self.issue('missing_file', relative, f'Missing {role}')
        row['required'] = row.get('required', False) or required
        if expected is not None and expected != row.get('sha256'):
            self.issue('stale_hash', relative, 'Declared SHA256 does not match the existing file', expected=expected, actual=row.get('sha256'))
        return row

    def load(self, path):
        return self.data.get(_inside(self.root, path).relative_to(self.root).as_posix())

    def object(self, path):
        value = self.load(path)
        if value is not None and not isinstance(value, dict):
            self.issue('invalid_json_shape', Path(path).relative_to(self.root), 'Expected a JSON object')
        return value if isinstance(value, dict) else {}

    def records(self, value, path):
        if value is None:
            return []
        if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
            self.issue('invalid_json_shape', str(path), 'Expected a list of objects')
        return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []

    def reference(self, row, role, base=None):
        if not isinstance(row, dict) or not isinstance(row.get('path'), str) or not row['path']:
            self.issue('invalid_reference', role, 'Expected a nonempty path and explicit SHA256')
            return None
        target = _reference(self.root, row['path'], base)
        if not isinstance(row.get('sha256'), str) or len(row['sha256']) != 64:
            self.issue('missing_reference_hash', row['path'], 'Expected an explicit SHA256 for the original reference')
        return self.add(target, role, required=True, expected=row.get('sha256'))


def _copyright(packet, root, layers):
    file = root / 'copyright-evidence.json'
    record = packet.add(file, 'copyright_evidence_manifest', required=True)
    expected = {r['id']: r.get('copyright_category') for r in layers if r['type'] != 'text'}
    result = dict(status='missing', expected_layers=expected, entries=[], uncovered_layers=list(expected))
    if record['status'] == 'missing':
        return result
    result['manifest_sha256'] = record.get('sha256')
    manifest = packet.load(file)
    categories = manifest.get('categories') if isinstance(manifest, dict) else None
    if not isinstance(categories, dict):
        packet.issue('invalid_evidence_manifest', 'copyright-evidence.json', 'Expected categories object')
        result['status'] = 'invalid'
        return result
    covered = set()
    start_issues = len(packet.issues)
    for category, entries in categories.items():
        if category not in ('original', 'original_ai') or not isinstance(entries, list):
            packet.issue('invalid_evidence_category', 'copyright-evidence.json', 'Only original/original_ai lists are supported', category=category)
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                packet.issue('invalid_evidence_entry', 'copyright-evidence.json', 'Expected an evidence object')
                continue
            if not isinstance(entry.get('path'), str) or not entry['path']:
                packet.issue('invalid_evidence_entry', 'copyright-evidence.json', 'Evidence entry needs a nonempty path')
                continue
            target = _reference(root, entry['path'])
            row = packet.add(target, 'claimed_copyright_evidence', required=True, expected=entry.get('sha256'))
            ids = entry.get('layers')
            valid = row['status'] == 'present' and row.get('image') is True
            if target.name.lower() in GENERATED_INDEXES or Path(entry['path']).name.lower() in GENERATED_INDEXES:
                packet.issue('generated_index_not_proof', row['path'], 'receipts.png/shape-evidence.png are indexes, not original proof')
                valid = False
            if not isinstance(entry.get('sha256'), str) or entry['sha256'] != row.get('sha256'):
                if entry.get('sha256') is None:
                    packet.issue('missing_evidence_hash', row['path'], 'An explicit current evidence SHA256 is required')
                valid = False
            if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or expected.get(i) != category for i in ids):
                packet.issue('evidence_layer_mismatch', row['path'], 'Evidence must name actual image/shape IDs of this category', category=category, layers=ids)
                valid = False
            if target.suffix.lower() not in IMAGE_SUFFIXES:
                packet.issue('evidence_not_image', row['path'], 'Platform evidence must be a real PNG/JPEG/WebP image')
                valid = False
            if valid:
                covered.update(ids)
            result['entries'].append(dict(path=row['path'], category=category, layers=ids,
                                          actual_sha256=row.get('sha256'), declared_sha256=entry.get('sha256'),
                                          reference_status='valid_needs_visual_review' if valid else 'invalid'))
    for layer_id, category in expected.items():
        if category not in ('original', 'original_ai'):
            packet.issue('unknown_material_origin', 'copyright-evidence.json', 'Material category is not declared', layer=layer_id)
    result['uncovered_layers'] = sorted(set(expected) - covered)
    if result['uncovered_layers']:
        packet.issue('missing_evidence_coverage', 'copyright-evidence.json', 'Image layers lack valid referenced original evidence', layers=result['uncovered_layers'])
    result['status'] = 'references_valid_needs_visual_review' if len(packet.issues) == start_issues and all(e['reference_status'] == 'valid_needs_visual_review' for e in result['entries']) else 'invalid'
    return result


def _html(manifest):
    esc = lambda value: html.escape(str(value), quote=True)
    items = ''.join(f'<li><strong>{esc(r["code"])}</strong>: {esc(r["path"])} — {esc(r["message"])}</li>' for r in manifest['issues'])
    gallery = []
    records = []
    for row in manifest['files']:
        name = esc(row['path'])
        link = f'<a href="{esc(row["href"])}">{name}</a>' if row.get('href') else name
        caption = f'{link} · {esc(", ".join(row["roles"]))} · {esc(row["status"])}'
        if row.get('image'):
            gallery.append(f'<figure><a href="{esc(row["href"])}"><img loading="lazy" src="{esc(row["href"])}" alt="{name}"></a><figcaption>{caption}<br>SHA256 {esc(row["sha256"])}</figcaption></figure>')
        summary = f'<pre>{esc(json.dumps(row["summary"], ensure_ascii=False, indent=2))}</pre>' if 'summary' in row else ''
        records.append(f'<details><summary>{caption}</summary><p>SHA256 {esc(row.get("sha256", "missing"))}</p>{summary}</details>')
    actions = ''.join(f'<li>{esc(action)}</li>' for action in manifest['reviewer_actions'])
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' file:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
            '<title>待人工验收材料</title><style>body{font:16px/1.6 system-ui;margin:2rem;max-width:1200px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem}figure{margin:1rem 0;padding:1rem;border:1px solid #aaa}img{max-width:100%;max-height:800px}figcaption,summary{overflow-wrap:anywhere}li{margin:.4rem 0}</style>'
            f'<h1>{esc(manifest["title"])} — 待人工验收</h1><p>本页只索引实际文件。没有自动通过；草稿 passed=false。原图链接不复制、不修改素材。请实际打开并检查下列图片与证据。</p>'
            f'<h2>必须完成的观察</h2><ol>{actions}</ol><h2>缺项与失效引用（{len(manifest["issues"])}）</h2><ul>{items}</ul>'
            f'<h2>实际图片</h2>{"".join(gallery)}<h2>文件、哈希与 JSON 摘要</h2>{"".join(records)}</html>')


def _agent_summary(manifest, detail_hashes):
    def text(value):
        value = html.escape(str(value), quote=True)
        for char in ('\\', '[', ']', '`', '*', '_'):
            value = value.replace(char, '\\' + char)
        return value
    lines = ['# 待人工验收清单', '', '草稿均 passed:false；本清单不代表视觉、版权或平台审核通过。',
             '', '[完整文件与 JSON 摘要](manifest.json) · [实际原图索引](index.html)', '', '## 当前输入 SHA256', '']
    lines.extend(f'- {key}: `{value}`' for key, value in {**manifest['hashes'], **detail_hashes}.items())
    evidence = manifest['copyright_evidence']
    lines += ['', '## 缺项与引用检查', '', f'- 版权证明引用状态: {text(evidence["status"])}；仍须实看证据内容。',
              f'- 无有效证明覆盖的层: {text(", ".join(evidence["uncovered_layers"]) or "无（不代表内容充分）")}']
    lines.extend(f'- {text(row["code"])} · {text(row["path"])} · {text(row["message"])}' for row in manifest['issues'])
    if not manifest['issues']:
        lines.append('- 自动引用检查未发现缺项；仍未作人工视觉/来源判断。')
    groups = {name: [] for name in ('构图参考与预览', '编辑器与字体截图', '隐藏与刷新恢复', '独立素材及原始来源', '原始证明与登记截图')}
    files = {row['path']: row for row in manifest['files']}
    for row in manifest['must_view']:
        roles = row['roles']
        group = '编辑器与字体截图'
        if any(r in ('composition_reference', 'composite_preview') for r in roles):
            group = '构图参考与预览'
        elif any(r.startswith('hidden:') or r == 'restored_after_reload' for r in roles):
            group = '隐藏与刷新恢复'
        elif any(r.startswith(('final_layer:', 'recipe_source:')) for r in roles):
            group = '独立素材及原始来源'
        elif any(r in ('claimed_copyright_evidence', 'original_tool_record', 'registration_screenshot') for r in roles):
            group = '原始证明与登记截图'
        groups[group].append(f'- [ ] [{text(row["path"])}]({files[row["path"]]["href"]})')
    for name, rows in groups.items():
        if rows:
            lines += ['', '## ' + name, ''] + rows
    lines += ['', '## 完成人工观察后', ''] + ['- ' + text(action) for action in manifest['reviewer_actions']]
    lines += ['', '只编辑正式 review 文件完成独立判断；本目录草稿不被当作正式 review 或 gate response。', '']
    return '\n'.join(lines)


def build_packet(recipe_path):
    """Write a read-only review index and false drafts, returning a JSON summary.

    Missing inputs/hash failures are manifest issues, never an approval. Unsafe
    paths and invalid base recipes raise ValueError without overwriting outputs.
    """
    requested_path = Path(recipe_path).absolute()
    root = requested_path.parent.resolve()
    recipe_path = _inside(root, requested_path)
    recipe = json.loads(recipe_path.read_text(encoding='utf-8'))
    if not isinstance(recipe, dict) or not isinstance(recipe.get('output', 'release'), str) or not recipe.get('output', 'release'):
        raise ValueError('Recipe must be an object with a safe output path')
    layers = recipe.get('layers')
    if not isinstance(layers, list) or any(not isinstance(r, dict) or not isinstance(r.get('id'), str) or not r['id'] or not isinstance(r.get('name'), str) or r.get('type') not in ('text', 'image', 'shape') for r in layers):
        raise ValueError('Recipe needs named text/image/shape layers with explicit IDs')
    if len({r['id'] for r in layers}) != len(layers):
        raise ValueError('Recipe layer IDs must be unique')
    out = _inside(root, root / recipe.get('output', 'release'))
    directory = _inside(root, out / 'review-packet')
    if (out / 'review-packet').is_symlink():
        raise ValueError('Review packet output must not be a symlink')
    for name in ('index.html', 'manifest.json', 'agent-summary.md', 'visual-review.draft.json', 'material-review.draft.json'):
        if (directory / name).is_symlink():
            raise ValueError('Review packet output file must not be a symlink')
    packet = _Packet(root, directory)
    packet.add(recipe_path, 'recipe', required=True)
    packet.add(_reference(root, recipe.get('reference_master', 'master.jpg')), 'composition_reference', required=True)
    required = ['spec.json', 'bound-assets.json', 'registered-assets.json', 'font-verification.json',
                'editor-state.json', 'editor-ready.png', 'editor-materials-bound.png']
    optional = ['layer-manifest.json', 'task-provenance.json', 'shape-provenance.json', 'visual-review.json', 'material-review.json',
                'publication.json', 'copyright-verification.json', 'publication-metadata.json', 'registered-assets/request.json', 'registered-assets/response.json']
    for name in required + optional:
        packet.add(out / name, 'review_input', required=name in required)
    packet.add(out / 'preview.jpg', 'composite_preview', required=True)
    for layer in layers:
        if layer['type'] != 'text':
            packet.add(_reference(root, 'assets/' + layer['id'] + '.png', out), 'final_layer:' + layer['id'], required=True)
        if layer['type'] == 'image' and layer.get('source'):
            packet.add(_reference(root, layer['source']), 'recipe_source:' + layer['id'], required=True)
    for page in recipe.get('pages', []):
        packet.add(_reference(root, 'editor-bound-' + page['id'] + '.png', out), 'page_editor:' + page['id'], required=True)
    pairs = recipe.get('layer_audit', {}).get('pairs', [])
    if any(r['type'] != 'text' for r in layers) and not pairs:
        packet.issue('missing_audit_plan', str(recipe_path.relative_to(root)), 'No semantic hide/restore pairs declared')
    audit_file = out / 'layer-audit/audit.json'
    packet.add(audit_file, 'visibility_audit', required=bool(pairs))
    for i, pair in enumerate(pairs, 1):
        for role in ('subject', 'background'):
            packet.add(out / f'layer-audit/pair-{i}-{role}-hidden.png', f'hidden:{pair.get(role)}', required=True)
    packet.add(out / 'layer-audit/restored-after-reload.png', 'restored_after_reload', required=bool(pairs))
    for pattern in ('editor*.png', 'font*.png', 'publication*.png', 'copyright*.png', '*preview.jpg', 'layer-audit/*.png'):
        for path in sorted(out.glob(pattern)):
            packet.add(path, 'actual_review_screenshot')
    for name in ('creation-process.json', 'external-assets.json', 'agent-assets/response.json', 'native-selection.json', 'layout-comparison.json'):
        packet.add(root / name, 'original_provenance_record')
    process = packet.object(root / 'creation-process.json')
    for row in packet.records(process.get('files'), 'creation-process.json'):
        packet.reference(row, 'original_creation_record')
    for name in ('external-assets.json', 'agent-assets/response.json'):
        source = packet.object(root / name)
        for asset in packet.records(source.get('assets'), name):
            packet.reference(asset, 'original_external_asset')
            for row in packet.records(asset.get('evidence'), name):
                packet.reference(row, 'original_tool_record')
    registered = packet.records(packet.load(out / 'registered-assets.json'), 'registered-assets.json')
    for row in registered:
        if not isinstance(row.get('id'), str) or not row['id']:
            packet.issue('invalid_registration_row', 'registered-assets.json', 'Registration record lacks an actual layer ID')
            continue
        packet.add(_reference(root, 'assets/' + row['id'] + '.png', out), 'registered_final_asset', required=True, expected=row.get('sha256'))
        if row.get('evidence'):
            packet.reference(row['evidence'], 'registration_screenshot', base=out)
    response = packet.object(out / 'registered-assets/response.json')
    for row in packet.records(response.get('assets'), 'registered-assets/response.json'):
        if isinstance(row, dict) and row.get('evidence'):
            packet.reference(row['evidence'], 'registration_screenshot', base=out)
    bindings = packet.object(out / 'bound-assets.json')
    bound_rows = packet.records(bindings.get('layers'), 'bound-assets.json')
    image_ids = {r['id'] for r in layers if r['type'] != 'text'}
    if len(registered) != len(image_ids) or len(bound_rows) != len(image_ids) or {r.get('id') for r in registered} != image_ids or {r.get('id') for r in bound_rows} != image_ids or bindings.get('pending'):
        packet.issue('registration_binding_incomplete', str((out / 'bound-assets.json').relative_to(root)), 'Registration/binding must cover every actual image layer without pending changes')
    for row in bound_rows:
        matches = [r for r in registered if r.get('id') == row.get('id') and r.get('asset_id') == row.get('asset_id') and r.get('sha256') == row.get('sha256')]
        if len(matches) != 1:
            packet.issue('binding_mismatch', str((out / 'bound-assets.json').relative_to(root)), 'Bound asset identity/hash does not match registration', layer=row.get('id'))
    fonts = packet.records(packet.load(out / 'font-verification.json'), 'font-verification.json')
    for layer in (r for r in layers if r['type'] == 'text'):
        if not any(r.get('layer') == layer['name'] and r.get('requested') == layer.get('gd_font') and r.get('persistence_verified') is True and r.get('preview_verified') is True and r.get('checked_verified') is True and r.get('font_id') for r in fonts):
            packet.issue('missing_persistent_font_check', str((out / 'font-verification.json').relative_to(root)), 'Read actual editor font selection after save/reopen; a name-only receipt is insufficient', layer=layer['id'])
    hashes = {'recipe_sha256': _sha(recipe_path)}
    for field, path in [('spec_sha256', out / 'spec.json'), ('bindings_sha256', out / 'bound-assets.json'), ('evidence_sha256', root / 'copyright-evidence.json')]:
        target = _inside(root, path)
        if target.is_file():
            hashes[field] = _sha(target)
    audit = packet.object(audit_file)
    if pairs and (audit.get('status') != 'complete' or not audit.get('restoredAfterReload') or audit.get('pending')):
        packet.issue('audit_incomplete', str(audit_file.relative_to(root)), 'Hide/restore audit must complete and survive reload')
    fingerprint = audit.get('fingerprint') if isinstance(audit.get('fingerprint'), dict) else {}
    for key, field in [('recipe', 'recipe_sha256'), ('spec', 'spec_sha256'), ('bindings', 'bindings_sha256')]:
        if pairs and fingerprint.get(key) != hashes.get(field):
            packet.issue('stale_audit', str(audit_file.relative_to(root)), 'Audit fingerprint differs from current input', input=key)
    for name, fields in [('visual-review.json', ('spec_sha256',)), ('material-review.json', ('bindings_sha256', 'evidence_sha256'))]:
        review = packet.load(out / name)
        if isinstance(review, dict):
            for field in fields:
                if field in hashes and review.get(field) != hashes[field]:
                    packet.issue('stale_review', str((out / name).relative_to(root)), 'Existing review references different current bytes', field=field)
    copyright = _copyright(packet, root, layers)
    actions = ['实际打开构图参考、预览及各画板编辑器图，检查阅读顺序、字号、对齐、留白、裁切与文案；不凭本索引自动通过。',
               '逐层查看每张最终 PNG，确认完整独立背景/主体、透明边缘和素材来源；核对真实 DAM 登记与绑定后的画布。',
               '逐项查看字体回执及编辑器实际字形，确认保存重开后的字体族与字重、原生文字可编辑。',
               '逐对实看主体/背景隐藏图及 restored-after-reload.png，确认独立性、无烘焙副本、恢复后无丢失。',
               '打开每份原始版权证明，人工核对实际工具/原图/完整输入与结果、分类及覆盖；哈希相符不等于证据内容充分。',
               '补齐所有缺项后，由 Agent 独立填写正式 visual-review.json / material-review.json；本程序只写 passed:false 草稿，不写 gate response。']
    files = sorted(packet.files.values(), key=lambda r: r['path'])
    manifest = dict(schema_version=1, title=recipe.get('title', '审查材料'), status='needs_agent_review',
                    recipe=recipe_path.relative_to(root).as_posix(), hashes=hashes, issues=packet.issues,
                    must_view=[dict(path=r['path'], sha256=r['sha256'], roles=r['roles']) for r in files if r.get('image')],
                    files=files, copyright_evidence=copyright, reviewer_actions=actions,
                    drafts=['visual-review.draft.json', 'material-review.draft.json'])
    visual = dict(passed=False, status='draft_needs_actual_visual_review', checks=[], must_view=manifest['must_view'])
    material = dict(passed=False, status='draft_needs_actual_material_review', checks=[], uncovered_layers=copyright['uncovered_layers'])
    if 'spec_sha256' in hashes:
        visual['spec_sha256'] = hashes['spec_sha256']
    for field in ('bindings_sha256', 'evidence_sha256'):
        if field in hashes:
            material[field] = hashes[field]
    directory.mkdir(parents=True, exist_ok=True)
    for name, value in [('manifest.json', manifest), ('visual-review.draft.json', visual), ('material-review.draft.json', material)]:
        (directory / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    (directory / 'index.html').write_text(_html(manifest), encoding='utf-8')
    detail_hashes = {'manifest_sha256': _sha(directory / 'manifest.json'), 'index_sha256': _sha(directory / 'index.html')}
    (directory / 'agent-summary.md').write_text(_agent_summary(manifest, detail_hashes), encoding='utf-8')
    return dict(directory=str(directory), manifest=str(directory / 'manifest.json'),
                index=str(directory / 'index.html'), summary=str(directory / 'agent-summary.md'), status='needs_agent_review',
                issue_count=len(packet.issues), must_view_count=len(manifest['must_view']),
                drafts=[str(directory / name) for name in manifest['drafts']])
