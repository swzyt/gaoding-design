"""Synthetic local fixtures only: no browser, provider, model, or production data."""
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import unquote

from PIL import Image
from review_packet import build_packet


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


def image(path, color='white'):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new('RGBA', (24, 30), color).convert('RGB' if path.suffix == '.jpg' else 'RGBA').save(path)


class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.tags = []; self.links = []

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        for key, value in attrs:
            if key.startswith('on'):
                raise AssertionError('Unescaped HTML event attribute')
            if key in ('src', 'href'):
                self.links.append(value)


class ReviewPacketTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.out = self.root / 'release'
        self.recipe = self.root / 'release-recipe.json'
        self.value = {'title': 'Fixture', 'canvas': {'w': 100, 'h': 120}, 'layers': [
            {'id': 'bg', 'name': 'Background', 'type': 'shape', 'copyright_category': 'original'},
            {'id': 'person', 'name': 'Subject', 'type': 'image', 'source': 'sources/person.png', 'copyright_category': 'original_ai'},
            {'id': 'title', 'name': 'Title', 'type': 'text', 'gd_font': '思源黑体 Medium'},
        ], 'layer_audit': {'pairs': [{'subject': 'Subject', 'background': 'Background'}]}}
        save(self.recipe, self.value)

    def fixture(self):
        for relative in ['master.jpg', 'sources/person.png', 'proofs/program.png', 'proofs/tool.png',
                         'release/assets/bg.png', 'release/assets/person.png', 'release/editor-ready.png',
                         'release/editor-materials-bound.png', 'release/preview.jpg',
                         'release/layer-audit/pair-1-subject-hidden.png', 'release/layer-audit/pair-1-background-hidden.png',
                         'release/layer-audit/restored-after-reload.png', 'release/registered-assets/bg-verified.png']:
            image(self.root / relative)
        save(self.out / 'spec.json', {'canvas': self.value['canvas'], 'layers': self.value['layers']})
        registered = [{'id': key, 'layer': name, 'asset_id': 'actual-fixture-' + key, 'sha256': sha(self.out / f'assets/{key}.png')}
                      for key, name in [('bg', 'Background'), ('person', 'Subject')]]
        registered[0]['evidence'] = {'path': 'registered-assets/bg-verified.png', 'sha256': sha(self.out / 'registered-assets/bg-verified.png')}
        save(self.out / 'registered-assets.json', registered)
        save(self.out / 'bound-assets.json', {'layers': [{k: v for k, v in row.items() if k != 'evidence'} for row in registered]})
        save(self.out / 'font-verification.json', [{'layer': 'Title', 'requested': '思源黑体 Medium', 'font': '思源黑体 中等', 'font_id': '206606',
                                                  'checked_verified': True, 'preview_verified': True, 'persistence_verified': True}])
        save(self.out / 'editor-state.json', {'stage': 'ready-for-visual-review'})
        self.evidence = {'categories': {'original': [{'path': 'proofs/program.png', 'sha256': sha(self.root / 'proofs/program.png'), 'layers': ['bg']}],
                                        'original_ai': [{'path': 'proofs/tool.png', 'sha256': sha(self.root / 'proofs/tool.png'), 'layers': ['person']}]}}
        save(self.root / 'copyright-evidence.json', self.evidence)
        self.audit()

    def audit(self):
        save(self.out / 'layer-audit/audit.json', {'status': 'complete', 'restoredAfterReload': True,
                                                 'fingerprint': {'recipe': sha(self.recipe), 'spec': sha(self.out / 'spec.json'), 'bindings': sha(self.out / 'bound-assets.json')}})

    def packet(self):
        result = build_packet(self.recipe)
        json.dumps(result)  # CLI return values must not contain Path objects.
        self.assertEqual(result['status'], 'needs_agent_review')
        manifest = json.loads(Path(result['manifest']).read_text())
        return result, manifest

    def test_complete_references_false_drafts_actual_links_and_no_formal_changes(self):
        self.fixture()
        save(self.out / 'visual-review.json', {'passed': True, 'spec_sha256': sha(self.out / 'spec.json')})
        save(self.out / 'material-review.json', {'passed': True, 'bindings_sha256': sha(self.out / 'bound-assets.json'), 'evidence_sha256': sha(self.root / 'copyright-evidence.json')})
        save(self.root / 'gate/response.json', {'passed': False, 'token': 'untouched'})
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result, manifest = self.packet()
        self.assertEqual(manifest['issues'], [])
        self.assertEqual(manifest['copyright_evidence']['status'], 'references_valid_needs_visual_review')
        self.assertEqual(manifest['copyright_evidence']['uncovered_layers'], [])
        required = {'master.jpg', 'release/editor-ready.png', 'release/editor-materials-bound.png', 'release/assets/bg.png',
                    'release/assets/person.png', 'release/layer-audit/restored-after-reload.png',
                    'release/layer-audit/pair-1-subject-hidden.png', 'proofs/program.png', 'proofs/tool.png'}
        self.assertTrue(required <= {r['path'] for r in manifest['must_view']})
        for file in result['drafts']:
            self.assertFalse(json.loads(Path(file).read_text())['passed'])
        visual, material = [json.loads(Path(file).read_text()) for file in result['drafts']]
        self.assertEqual(visual['spec_sha256'], sha(self.out / 'spec.json'))
        self.assertEqual(material['bindings_sha256'], sha(self.out / 'bound-assets.json'))
        self.assertEqual(material['evidence_sha256'], sha(self.root / 'copyright-evidence.json'))
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content, str(path))
        summary = Path(result['summary']).read_text()
        self.assertLessEqual(len(summary.splitlines()), 150)
        self.assertIn('manifest_sha256: `' + sha(Path(result['manifest'])) + '`', summary)
        self.assertIn('index_sha256: `' + sha(Path(result['index'])) + '`', summary)
        self.assertNotIn('summary', summary)
        for row in manifest['must_view']:
            self.assertIn(row['path'], summary)
        self.assertEqual(list(Path(result['directory']).glob('*.png')), [], 'index must reference originals, never fabricate images')

    def test_missing_evidence_and_images_still_produce_manifest_with_no_invented_hashes(self):
        result, manifest = self.packet()
        self.assertEqual(manifest['copyright_evidence']['status'], 'missing')
        self.assertEqual(set(manifest['copyright_evidence']['uncovered_layers']), {'bg', 'person'})
        self.assertIn('missing_file', {i['code'] for i in manifest['issues']})
        self.assertEqual(manifest['must_view'], [])
        self.assertNotIn('spec_sha256', manifest['hashes'])
        for file in result['drafts']:
            value = json.loads(Path(file).read_text())
            self.assertFalse(value['passed'])
            self.assertNotIn('spec_sha256', value)
            self.assertNotIn('evidence_sha256', value)
        self.assertFalse((self.out / 'visual-review.json').exists())
        self.assertFalse((self.out / 'material-review.json').exists())

    def test_stale_evidence_asset_and_audit_hashes_are_actionable_not_coverage(self):
        self.fixture()
        image(self.root / 'proofs/tool.png', 'red')
        image(self.out / 'assets/bg.png', 'blue')
        save(self.out / 'spec.json', {'changed': True})
        save(self.out / 'visual-review.json', {'passed': True, 'spec_sha256': 'old'})
        _, manifest = self.packet()
        self.assertTrue({'stale_hash', 'stale_audit', 'stale_review'} <= {i['code'] for i in manifest['issues']})
        self.assertIn('person', manifest['copyright_evidence']['uncovered_layers'])
        self.assertEqual(manifest['copyright_evidence']['status'], 'invalid')

    def test_generated_indexes_including_renamed_symlinks_are_not_original_proof(self):
        self.fixture()
        for name in ('receipts.png', 'shape-evidence.png'):
            with self.subTest(name=name):
                image(self.root / name)
                self.evidence['categories']['original'][0].update(path=name, sha256=sha(self.root / name))
                save(self.root / 'copyright-evidence.json', self.evidence)
                _, manifest = self.packet()
                self.assertIn('generated_index_not_proof', {i['code'] for i in manifest['issues']})
                self.assertIn('bg', manifest['copyright_evidence']['uncovered_layers'])
        alias = self.root / 'innocent-proof.png'
        alias.symlink_to(self.root / 'receipts.png')
        self.evidence['categories']['original'][0].update(path=alias.name, sha256=sha(alias))
        save(self.root / 'copyright-evidence.json', self.evidence)
        _, manifest = self.packet()
        self.assertIn('generated_index_not_proof', {i['code'] for i in manifest['issues']})

    def test_wrong_category_unknown_layer_and_missing_hash_cannot_cover_layers(self):
        self.fixture()
        self.evidence['categories']['original'][0]['layers'] = ['person', 'does-not-exist']
        del self.evidence['categories']['original_ai'][0]['sha256']
        save(self.root / 'copyright-evidence.json', self.evidence)
        _, manifest = self.packet()
        self.assertEqual(set(manifest['copyright_evidence']['uncovered_layers']), {'bg', 'person'})
        self.assertTrue({'evidence_layer_mismatch', 'missing_evidence_hash'} <= {i['code'] for i in manifest['issues']})

    def test_escape_paths_and_external_symlinks_are_rejected_before_packet_writes(self):
        self.fixture()
        with tempfile.TemporaryDirectory() as d:
            outside = Path(d); image(outside / 'proof.png')
            bad = self.root / 'escape.png'; bad.symlink_to(outside / 'proof.png')
            for path in ('../outside.png', str(outside / 'proof.png'), 'escape.png'):
                with self.subTest(path=path):
                    self.evidence['categories']['original'][0]['path'] = path
                    save(self.root / 'copyright-evidence.json', self.evidence)
                    with self.assertRaises(ValueError):
                        build_packet(self.recipe)
                    self.assertFalse((self.out / 'review-packet').exists())
            self.value['output'] = str(outside)
            save(self.recipe, self.value)
            with self.assertRaises(ValueError):
                build_packet(self.recipe)
            self.assertFalse((outside / 'review-packet').exists())

    def test_output_symlink_cannot_overwrite_official_review(self):
        self.fixture()
        folder = self.out / 'review-packet'; folder.mkdir()
        official = self.out / 'visual-review.json'; save(official, {'sentinel': 'must remain'})
        (folder / 'manifest.json').symlink_to(official)
        before = official.read_bytes()
        with self.assertRaises(ValueError):
            build_packet(self.recipe)
        self.assertEqual(official.read_bytes(), before)
        self.assertFalse((folder / 'index.html').exists())

    def test_html_escaping_and_original_image_links_for_hostile_names(self):
        self.fixture()
        name = 'proofs/proof \'\" <img src=x onerror=alert(1)>.png'
        image(self.root / name)
        self.value['title'] = '</h1><script>alert("fixture")</script>'
        save(self.recipe, self.value); self.audit()
        self.evidence['categories']['original'][0].update(path=name, sha256=sha(self.root / name))
        save(self.root / 'copyright-evidence.json', self.evidence)
        result, manifest = self.packet()
        page = Path(result['index']).read_text()
        self.assertNotIn('<script>', page)
        self.assertIn('&lt;script&gt;', page)
        parser = Links(); parser.feed(page)
        self.assertNotIn('script', parser.tags)
        for href in parser.links:
            target = (Path(result['directory']) / unquote(href)).resolve()
            self.assertTrue(target.is_relative_to(self.root))
            self.assertTrue(target.is_file())
        self.assertIn(name, {r['path'] for r in manifest['must_view']})

    def test_corrupt_screenshot_and_malformed_metadata_are_reported_without_approval(self):
        self.fixture()
        (self.out / 'editor-ready.png').write_bytes(b'not a real screenshot')
        save(self.out / 'bound-assets.json', {'layers': 'invalid'})
        save(self.out / 'font-verification.json', {'not': 'font records'})
        save(self.root / 'copyright-evidence.json', {'categories': {'original': [{}]}})
        result, manifest = self.packet()
        self.assertTrue({'invalid_image', 'invalid_json_shape', 'invalid_evidence_entry'} <= {r['code'] for r in manifest['issues']})
        self.assertFalse(json.loads(Path(result['drafts'][0]).read_text())['passed'])
        self.assertEqual(manifest['copyright_evidence']['status'], 'invalid')

    def test_summary_hashes_track_new_detail_bytes_and_output_directory_cannot_escape(self):
        self.fixture()
        result, _ = self.packet()
        old_detail = sha(Path(result['manifest']))
        self.value['title'] = 'Changed fixture'
        save(self.recipe, self.value)
        result, _ = self.packet()
        summary = Path(result['summary']).read_text()
        self.assertNotEqual(old_detail, sha(Path(result['manifest'])))
        self.assertIn(sha(Path(result['manifest'])), summary)
        self.assertIn(sha(Path(result['index'])), summary)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            self.value['output'] = 'escaped-output'
            (self.root / 'escaped-output').symlink_to(out, target_is_directory=True)
            save(self.recipe, self.value)
            with self.assertRaises(ValueError):
                build_packet(self.recipe)
            self.assertEqual(list(out.iterdir()), [])

    def test_original_tool_records_and_registration_screenshots_are_indexed_not_assumed_proof(self):
        self.fixture()
        source = self.root / 'source.py'; source.write_text('# Fixture source, not a platform screenshot\n')
        save(self.root / 'creation-process.json', {'files': [{'path': 'source.py', 'sha256': sha(source)}]})
        save(self.root / 'external-assets.json', {'assets': [{'path': 'sources/person.png', 'sha256': sha(self.root / 'sources/person.png'),
                                                            'evidence': [{'path': 'proofs/tool.png', 'sha256': sha(self.root / 'proofs/tool.png')}]}]})
        result, manifest = self.packet()
        by_path = {r['path']: r for r in manifest['files']}
        self.assertIn('original_creation_record', by_path['source.py']['roles'])
        self.assertIn('original_tool_record', by_path['proofs/tool.png']['roles'])
        self.assertIn('registration_screenshot', by_path['release/registered-assets/bg-verified.png']['roles'])
        self.assertEqual(manifest['status'], 'needs_agent_review')
        self.assertFalse(json.loads(Path(result['drafts'][1]).read_text())['passed'])


if __name__ == '__main__':
    unittest.main()
