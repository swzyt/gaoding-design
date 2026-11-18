"""Meaningful offline provenance tests; fixtures are not production evidence."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import agent_assets as assets
import receipts
import shape_evidence


class AssetHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        image = Image.new('RGBA', (4, 4), (255, 0, 0, 255))
        image.putpixel((0, 0), (0, 0, 0, 0))
        image.save(self.root / 'person.png')
        (self.root / 'tool-response.json').write_text('{"fixture": true}')
        self.plan = {'assets': [{'id': 'person', 'source': 'person.png', 'require_alpha': True}]}
        request = assets.prepare(self.root, self.plan)
        self.response = dict(schema_version=1, token=request['token'], plan_sha256=request['plan_sha256'], assets=[
            dict(id='person', path='person.png', sha256=assets.digest(self.root / 'person.png'), origin='ai',
                 tool='fixture.generate', provider='test', model='fixture-model', task_id='fixture-1',
                 input={'prompt': 'offline fixture'}, status='completed', evidence=[
                     dict(path='tool-response.json', sha256=assets.digest(self.root / 'tool-response.json'), kind='tool-response')])])
        self.recipe = {'layers': [dict(id='subject', type='image', source='person.png', require_alpha=True, copyright_category='original_ai')]}
        self.save()

    def save(self):
        assets.atomic_json(self.root / 'external-assets.json', self.response)

    def test_exact_request_resumes_without_token_change(self):
        first = assets.prepare(self.root)
        self.assertEqual(first, assets.prepare(self.root, self.plan))
        self.assertTrue(assets.validate(self.root, self.recipe)['validated'])
        with self.assertRaises(ValueError):
            assets.prepare(self.root, {'assets': []})
        self.assertEqual(first, assets.prepare(self.root))

    def test_changed_asset_and_evidence_fail(self):
        for target in ('person.png', 'tool-response.json'):
            with self.subTest(target=target):
                path = self.root / target
                original = path.read_bytes()
                path.write_bytes(original + b'changed')
                with self.assertRaisesRegex(ValueError, 'Hash mismatch'):
                    assets.validate(self.root, self.recipe)
                path.write_bytes(original)

    def test_paths_symlinks_and_absolute_paths_rejected(self):
        with tempfile.TemporaryDirectory() as external:
            outside = Path(external) / 'asset.png'
            outside.write_bytes((self.root / 'person.png').read_bytes())
            (self.root / 'link.png').symlink_to(outside)
            for value in ('../asset.png', str(outside), 'link.png'):
                self.response['assets'][0]['path'] = value
                self.save()
                with self.assertRaises(ValueError):
                    assets.validate(self.root, self.recipe)

    def test_control_directory_symlink_and_conflicting_responses_fail(self):
        with tempfile.TemporaryDirectory() as external, tempfile.TemporaryDirectory() as concept:
            root = Path(concept)
            (root / 'agent-assets').symlink_to(external, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                assets.prepare(root, {'assets': []})
            self.assertFalse((Path(external) / 'request.json').exists())
        conflicting = copy.deepcopy(self.response)
        conflicting['token'] = 'different'
        assets.atomic_json(self.root / 'agent-assets/response.json', conflicting)
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            assets.validate(self.root, self.recipe)

    def test_uncertain_tasks_stale_token_and_missing_metadata_fail(self):
        original = copy.deepcopy(self.response)
        for field, value in (('status', 'running'), ('task_id', None), ('input', {}), ('evidence', []), ('provider', '')):
            with self.subTest(field=field):
                self.response = copy.deepcopy(original)
                self.response['assets'][0][field] = value
                self.save()
                with self.assertRaises(ValueError):
                    assets.validate(self.root, self.recipe)
        self.response = copy.deepcopy(original)
        self.response['token'] = 'stale'
        self.save()
        with self.assertRaises(ValueError):
            assets.validate(self.root, self.recipe)

    def test_alpha_and_category_and_unrecorded_source_fail(self):
        Image.new('RGB', (4, 4), 'red').save(self.root / 'person.png')
        self.response['assets'][0]['sha256'] = assets.digest(self.root / 'person.png')
        self.save()
        with self.assertRaisesRegex(ValueError, 'transparent'):
            assets.validate(self.root, self.recipe)
        self.plan['assets'][0]['require_alpha'] = False
        recipe = copy.deepcopy(self.recipe)
        recipe['layers'][0]['require_alpha'] = False
        recipe['layers'][0]['copyright_category'] = 'original'
        # Remove alpha requirement from frozen plan without weakening its binding.
        request = assets.load(self.root / 'agent-assets/request.json')
        assets.atomic_json(self.root / 'asset-plan.json', self.plan)
        request.update(plan=self.plan, plan_sha256=assets.digest(self.root / 'asset-plan.json'))
        assets.atomic_json(self.root / 'agent-assets/request.json', request)
        self.response['plan_sha256'] = request['plan_sha256']
        self.save()
        with self.assertRaisesRegex(ValueError, 'copyright'):
            assets.validate(self.root, recipe)
        recipe['layers'][0]['copyright_category'] = 'original_ai'
        Image.new('RGB', (2, 2)).save(self.root / 'other.png')
        recipe['layers'][0]['source'] = 'other.png'
        with self.assertRaisesRegex(ValueError, 'no provenance'):
            assets.validate(self.root, recipe)

    def test_local_programmatic_source_requires_no_fake_ai_task(self):
        row = self.response['assets'][0]
        row.update(origin='programmatic', tool='Pillow', provider='local', model='Pillow fixture version', task_id=None)
        row['evidence'][0]['kind'] = 'execution-log'
        self.recipe['layers'][0]['copyright_category'] = 'original'
        self.save()
        self.assertTrue(assets.validate(self.root, self.recipe)['validated'])

    def test_real_dsh_invocation_id_without_provider_task_is_supported(self):
        self.response['assets'][0].update(task_id=None, invocation_id='dsh-tool-call-fixture-17')
        self.save()
        self.assertTrue(assets.validate(self.root, self.recipe)['validated'])

    def test_empty_plan_still_requires_bound_empty_response(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            recipe = {'layers': [{'id': 'text', 'type': 'text', 'text': 'native'}]}
            request = assets.prepare(root, {'assets': []})
            with self.assertRaisesRegex(ValueError, 'Missing external asset provenance'):
                assets.validate(root, recipe)
            response = dict(schema_version=1, token=request['token'], plan_sha256=request['plan_sha256'], assets=[])
            assets.atomic_json(root / 'agent-assets/response.json', response)
            self.assertEqual(assets.validate(root, recipe)['assets'], [])
            response['token'] = 'stale'
            assets.atomic_json(root / 'agent-assets/response.json', response)
            with self.assertRaisesRegex(ValueError, 'Stale'):
                assets.validate(root, recipe)

    def test_prepare_does_not_restart_orphaned_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'agent-assets').mkdir()
            (root / 'agent-assets/submission-started').write_text('uncertain')
            with self.assertRaisesRegex(RuntimeError, 'recover'):
                assets.prepare(root, self.plan)
            self.assertFalse((root / 'agent-assets/request.json').exists())

    def test_receipts_never_call_external_tool_and_label_index(self):
        with patch('subprocess.run', side_effect=AssertionError('must not call CLI')):
            report = receipts.generate(self.root, self.recipe)
        self.assertIn('not a tool screenshot', report['notice'])
        self.assertTrue((self.root / 'release/receipts.png').is_file())


class LegacyAndNativeTests(unittest.TestCase):
    def test_native_shapes_text_need_no_fake_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            recipe = {'layers': [{'type': 'text', 'text': 'hello'}, {'type': 'shape', 'id': 'box', 'name': 'Box', 'copyright_category': 'original'}]}
            assets.atomic_json(root / 'release-recipe.json', recipe)
            (root / 'release/assets').mkdir(parents=True)
            Image.new('RGB', (2, 2), 'red').save(root / 'release/assets/box.png')
            self.assertEqual(receipts.generate(root)['assets'], [])
            self.assertEqual(shape_evidence.generate(root)['assets'][0]['sha256'], assets.digest(root / 'release/assets/box.png'))

    def test_legacy_completed_receipts_preserved_and_unknown_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job = root / 'master-job'
            job.mkdir()
            Image.new('RGB', (2, 2), 'red').save(job / 'resource.png')
            assets.atomic_json(root / 'master.task', {'taskId': 'old-1'})
            assets.atomic_json(job / 'job.json', {'taskId': 'old-1'})
            assets.atomic_json(job / 'request.json', {'tool': 'image.generate', 'input': {'prompt': 'saved original'}})
            assets.atomic_json(job / 'result.json', {'taskId': 'old-1', 'state': 'completed', 'result': {'usage': {'model': 'saved-model'}}})
            assets.atomic_json(job / 'resources.json', [{'file': str(job / 'resource.png'), 'sha256': assets.digest(job / 'resource.png')}])
            previous = (job / 'result.json').read_bytes()
            with patch('subprocess.run', side_effect=AssertionError('must not call CLI')):
                self.assertTrue(receipts.collect(root)['legacy'])
            self.assertEqual(previous, (job / 'result.json').read_bytes())
            assets.atomic_json(job / 'result.json', {'taskId': 'old-1', 'state': 'running'})
            with self.assertRaisesRegex(ValueError, 'completed'):
                receipts.collect(root)


if __name__ == '__main__':
    unittest.main()
