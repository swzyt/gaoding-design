# -*- coding: utf-8 -*-
"""Offline native flow tests: no external uploads, image models or platform approvals."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from agent_assets import prepare as prepare_assets
from browser_registration import prepare as prepare_registration, validate as validate_registration
from native_design import prepare, render_variants, select
from orchestrator import Controller
from provenance_bundle import attach
from zipfile import ZipFile


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False))


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


class NativeTests(unittest.TestCase):
    def fixture(self, root):
        research = root / 'research'; research.mkdir()
        sources = []
        for i in range(10):
            file = research / (str(i) + '.png'); Image.new('RGB', (10, 10), (i, 20, 30)).save(file)
            sources.append({'src': 'https://example.invalid/fixture/' + str(i), 'file': str(file.resolve()) if i == 0 else file.name, 'sha256': digest(file)})
        write(research / 'sources.json', sources)
        (research / 'analysis.md').write_text('Offline test fixtures; not real platform research.')
        write(research / 'research-review.json', {'passed': True, 'samples': list(range(10))})
        concept = {'id': 'fixture', 'concept': 'offline', 'reading_path': 'title then date', 'zones': ['title', 'body'],
                   'copy': ['Editable'], 'layers': ['background', 'title'], 'palette': ['white', 'black'], 'typography': 'explicit fonts',
                   'separation_contract': {'schema_version': 1, 'objects': []},
                   'asset_plan': {'assets': []}, 'layout_variants': [
                       {'id': 'left', 'recipe': 'left.json', 'rationale': 'left reading alignment'},
                       {'id': 'right', 'recipe': 'right.json', 'rationale': 'right reading alignment'}]}
        brief = {'research': {'sources': 'sources.json', 'analysis': 'analysis.md'}, 'concepts': [concept]}
        write(research / 'creative-brief.json', brief)
        info = prepare(research / 'creative-brief.json', root / 'build'); directory = Path(info['concept'])
        req = info['asset_request']
        write(directory / 'external-assets.json', {'schema_version': 1, 'token': req['token'], 'plan_sha256': req['plan_sha256'], 'assets': []})
        recipe = {'canvas': {'w': 400, 'h': 300}, 'title': 'Offline fixture', 'description': 'Not a publication', 'topic': 'fixture',
                  'layers': [{'id': 'bg', 'name': 'background', 'type': 'shape', 'box': [0, 0, 400, 300], 'color': [255, 255, 255, 255], 'copyright_category': 'original'},
                             {'id': 'title', 'name': 'title', 'type': 'text', 'box': [20, 20, 360, 100], 'text': 'Editable', 'size': 36, 'color': [20, 20, 20],
                              'font': 'ArialUnicodeMS', 'preview_font': 'Arial Unicode.ttf', 'gd_font': 'fixture font'}]}
        write(directory / 'left.json', recipe)
        other = copy.deepcopy(recipe); other['layers'][1]['align'] = 'right'; write(directory / 'right.json', other)
        return directory, recipe

    def test_real_native_preview_selection_without_any_cli(self):
        with tempfile.TemporaryDirectory() as d:
            root, recipe = self.fixture(Path(d))
            with patch('subprocess.run', side_effect=AssertionError('Preview must not launch any CLI')):
                records = render_variants(root)
                self.assertEqual(len(records), 2)
                chosen = Path(select(root, 'right'))
            self.assertTrue((root / 'master.jpg').is_file())
            self.assertEqual(json.loads(chosen.read_text())['layers'][1]['align'], 'right')
            self.assertFalse((root / 'release').exists())
            with self.assertRaises(ValueError): select(root, 'invented')
            (root / records[0]['preview']).write_bytes(b'changed')
            with self.assertRaises(ValueError): select(root, 'left')

    def test_controller_native_path_reaches_real_layout_selection_without_cli(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); concept, _ = self.fixture(root)
            write(root / 'research/live.json', {'fixture': True})
            controller = Controller(root, 7, None, False, 1, 'tour')
            def gate(name, *args):
                return {'selected_id': 'left', 'checks': ['offline test gate'], 'passed': True}
            with patch.object(controller, 'collect', return_value={'key': 'fixture-key'}), patch.object(controller, 'gate', side_effect=gate), patch('orchestrator.store'), patch.object(controller, 'finish_design', return_value='offline-finished') as finish, patch('subprocess.run', side_effect=AssertionError('Native preflight must never call any CLI')):
                self.assertEqual(controller.run(), 'offline-finished')
                finish.assert_called_once_with(concept)
            self.assertEqual(controller.state['stages']['native_selection']['state'], 'done')
            self.assertFalse('masters' in controller.state['stages'])

    def test_duplicate_layouts_and_changed_plan_cannot_pass(self):
        with tempfile.TemporaryDirectory() as d:
            root, recipe = self.fixture(Path(d))
            write(root / 'right.json', recipe)
            with self.assertRaises(ValueError): render_variants(root)
            with self.assertRaises(ValueError): prepare_assets(root, {'assets': [{'id': 'unexpected'}]})

    def test_multiboard_layouts_render_separately_and_seal_every_page(self):
        with tempfile.TemporaryDirectory() as d:
            root, recipe = self.fixture(Path(d))
            recipe['pages'] = [{'id': 'front', 'canvas': recipe['canvas']}, {'id': 'back', 'canvas': recipe['canvas']}]
            layers = []
            for board in recipe['pages']:
                for original in recipe['layers']:
                    layer = copy.deepcopy(original); layer.update(id=board['id']+'-'+layer['id'], name=board['id']+'-'+layer['name'], page=board['id']); layers.append(layer)
            recipe['layers'] = layers;write(root/'left.json', recipe)
            other=copy.deepcopy(recipe);other['layers'][1]['align']='right';write(root/'right.json',other)
            records=render_variants(root)
            self.assertEqual([board['page'] for board in records[0]['previews']],['front','back'])
            selected=records[0];(root/selected['previews'][1]['path']).write_bytes(b'changed back preview')
            with self.assertRaisesRegex(ValueError,'Page preview changed'):select(root,'left')

    def test_native_mode_defaults_and_old_run_restore_are_explicit(self):
        with tempfile.TemporaryDirectory() as d:
            current = Controller(Path(d)/'native', 7, None, False, 1, 'tour')
            self.assertEqual((current.mode, current.registration), ('native', 'agent'))
            with self.assertRaises(ValueError): Controller(Path(d)/'native', 7, None, False, 1, 'tour', 'gd-cli')
            old = Path(d)/'old';old.mkdir()
            write(old/'run.json', {'space':7,'repository_id':'repo','requested_topic':'演唱会宣传出圈','stages':{},'status':'attention'})
            recovered = Controller(old,7,'repo',False,1,'tour')
            self.assertEqual((recovered.mode,recovered.registration),('gd-cli','gd-cli'))
            target=Path(d)/'topic.json';write(target,{'key':'new-id','name':'new live topic','rules_url':'https://gdce.yuque.com/a/b/c'})
            dynamic=Controller(Path(d)/'dynamic',7,None,False,1,'new-id',topic_json=target)
            self.assertEqual(dynamic.topic_targets[0]['name'],'new live topic')
            with self.assertRaises(ValueError): Controller(Path(d)/'dynamic',7,None,False,1,'tour')

    def test_browser_registration_requires_actual_matching_ids_and_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'release/assets').mkdir(parents=True)
            Image.new('RGBA',(10,10),'red').save(root/'release/assets/subject.png')
            recipe=root/'release-recipe.json';write(recipe,{'title':'Fixture','layers':[{'id':'subject','name':'subject','type':'image','copyright_category':'original'}]})
            request=prepare_registration(recipe)
            Image.new('RGB',(100,100),'white').save(root/'release/library.png')
            row=dict(request['assets'][0],asset_id='actual-fixture-id',repository_id='fixture-library',state='verified',url='https://example.invalid/library',evidence={'path':'library.png','sha256':digest(root/'release/library.png')})
            write(root/'release/registered-assets/response.json',{'token':request['token'],'assets':[row]})
            result=validate_registration(recipe)
            self.assertEqual(result[0]['asset_id'],'actual-fixture-id')
            (root/'release/assets/subject.png').write_bytes(b'changed')
            with self.assertRaises(ValueError): validate_registration(recipe)

    def test_bundle_carries_original_referenced_records(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'evidence').mkdir();(root/'assets').mkdir()
            (root/'evidence/tool.json').write_text('{"actual":"fixture"}')
            Image.new('RGB',(4,4),'red').save(root/'assets/a.png')
            write(root/'external-assets.json',{'assets':[{'path':'assets/a.png','evidence':[{'path':'evidence/tool.json'}]}]})
            archive=root/'materials.zip'
            with ZipFile(archive,'w'):pass
            attach(root,archive)
            with ZipFile(archive) as z:
                self.assertEqual(z.read('provenance/original-records/evidence/tool.json'),b'{"actual":"fixture"}')

    def test_bundle_retains_real_creation_sources_and_rejects_changed_code(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'draw.py').write_text('print("actual fixture execution")')
            write(root/'creation-process.json',{'files':[{'path':'draw.py','sha256':digest(root/'draw.py')}]})
            archive=root/'materials.zip'
            with ZipFile(archive,'w'):pass
            attach(root,archive)
            with ZipFile(archive) as bundle:
                self.assertEqual(bundle.read('provenance/original-records/draw.py'),b'print("actual fixture execution")')
            (root/'draw.py').write_text('changed after evidence capture')
            with self.assertRaisesRegex(ValueError,'Creation process source changed'):attach(root,archive)


if __name__ == '__main__': unittest.main()
