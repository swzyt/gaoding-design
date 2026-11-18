"""Offline structural-contract regression tests; no browser or production work."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from agent_assets import atomic_json
from native_design import prepare, render_variants, select
from separation_contract import check, check_recipe, validate_contract, contract_hash, digest
from assemble import build
import test_native_design


class SeparationTests(unittest.TestCase):
    def fixture(self, root):
        image = Image.new('RGBA', (20, 20), (0, 0, 0, 0))
        image.paste((255, 0, 0, 255), (4, 4, 16, 16)); image.save(root / 'cup.png')
        objects = [{'id': name, 'layer_id': name, 'role': 'foreground', 'require_alpha': True} for name in ('cup-left', 'cup-right')]
        contract = {'schema_version': 1, 'objects': objects}
        recipe = {'canvas': {'w': 100, 'h': 100}, 'layers': [dict(id=o['layer_id'], name=o['id'], type='image', source='cup.png', box=[i*30, 0, 20, 20], role=o['role'], require_alpha=True) for i,o in enumerate(objects)]}
        return recipe, contract

    def test_two_cups_reuse_one_material_in_independent_layers(self):
        with tempfile.TemporaryDirectory() as d:
            recipe, contract = self.fixture(Path(d))
            result = check_recipe(d, recipe, contract)
            self.assertTrue(result['structurally_verified'])
            self.assertFalse(result['visual_verified'])
            self.assertEqual(result['images'][0]['sha256'], result['images'][1]['sha256'])

    def test_missing_object_shared_layer_and_missing_alpha(self):
        with tempfile.TemporaryDirectory() as d:
            recipe, contract = self.fixture(Path(d))
            broken = copy.deepcopy(contract); broken['objects'][1]['layer_id'] = 'cup-left'
            with self.assertRaisesRegex(ValueError, 'independent'): validate_contract(broken)
            broken = copy.deepcopy(recipe); broken['layers'].pop()
            with self.assertRaisesRegex(ValueError, 'Missing required'): check_recipe(d, broken, contract)
            broken = copy.deepcopy(recipe); broken['layers'][0].pop('require_alpha')
            with self.assertRaisesRegex(ValueError, 'require_alpha'): check_recipe(d, broken, contract)
            broken = copy.deepcopy(contract); broken['objects'][0]['require_alpha'] = False
            with self.assertRaisesRegex(ValueError, 'Foreground'): validate_contract(broken)

    def test_opaque_invisible_and_crop_removing_transparency_fail(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); recipe, contract = self.fixture(root)
            recipe['layers'][0]['crop'] = [5, 5, 15, 15]
            with self.assertRaisesRegex(ValueError, 'transparent area'): check_recipe(root, recipe, contract)
            recipe['layers'][0].pop('crop')
            for color in ((255, 0, 0, 255), (0, 0, 0, 0), (255, 0, 0, 254)):
                Image.new('RGBA', (20, 20), color).save(root/'cup.png')
                with self.assertRaisesRegex(ValueError, 'transparent area'): check_recipe(root, recipe, contract)

    def test_background_coverage_is_declared_not_assumed_full_canvas(self):
        with tempfile.TemporaryDirectory() as d:
            contract = {'schema_version': 1, 'objects': [{'id': 'panel', 'layer_id': 'panel', 'role': 'background', 'require_alpha': False, 'coverage': {'box': [10, 10, 40, 30]}}]}
            recipe = {'canvas': {'w':100, 'h':100}, 'layers':[{'id':'panel', 'type':'shape', 'role':'background', 'require_alpha':False, 'box':[10,10,40,30]}]}
            self.assertTrue(check_recipe(d, recipe, contract)['structurally_verified'])
            recipe['layers'][0]['box'] = [0,0,100,100]
            with self.assertRaisesRegex(ValueError, 'coverage'): check_recipe(d, recipe, contract)
            contract['objects'][0].pop('coverage')
            with self.assertRaisesRegex(ValueError, 'coverage'): validate_contract(contract)

    def test_empty_contract_only_explicit_native_shapes_and_text(self):
        with tempfile.TemporaryDirectory() as d:
            recipe, _ = self.fixture(Path(d)); empty = {'schema_version':1, 'objects':[]}
            with self.assertRaisesRegex(ValueError, 'Empty'): check_recipe(d, recipe, empty)
            self.assertTrue(check_recipe(d, {'layers':[{'id':'text','type':'text'}]}, empty)['structurally_verified'])
            with self.assertRaises(ValueError): validate_contract(None)

    def test_new_prepare_requires_contract_and_legacy_restore_is_unverified(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); concept, _ = test_native_design.NativeTests().fixture(root)
            brief_path = root/'research/creative-brief.json'; brief=json.loads(brief_path.read_text())
            brief['concepts'][0].pop('separation_contract'); atomic_json(brief_path, brief)
            with self.assertRaisesRegex(ValueError, 'Explicit separation_contract'): prepare(brief_path, root/'new-build')
            snapshot=json.loads((concept/'native-input.json').read_text())
            snapshot.pop('separation_contract'); snapshot.pop('brief_path'); snapshot['brief']=brief
            snapshot['research_sha256'][str(brief_path.resolve())]=digest(brief_path)
            atomic_json(concept/'native-input.json', snapshot)
            # Explicitly construct a pre-contract frozen run, not a new prepare bypass.
            (concept/'separation-contract.json').unlink()
            result=prepare(brief_path, root/'build')
            self.assertEqual(result['separation_status'], 'legacy-unverified')
            self.assertFalse(check(concept)['structurally_verified'])
            records=render_variants(concept); select(concept,'left')
            self.assertEqual(records[0]['separation_check']['status'], 'legacy-unverified')

    def test_input_and_contract_tampering_block_render_and_select(self):
        for target in ('native-input.json', 'separation-contract.json'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as d:
                root, _ = test_native_design.NativeTests().fixture(Path(d)); render_variants(root)
                data=json.loads((root/target).read_text()); data['tampered']=True
                if target=='separation-contract.json': data['contract']['objects']=[{'id':'x'}]
                atomic_json(root/target,data)
                with self.assertRaises(ValueError): render_variants(root)
                with self.assertRaises(ValueError): select(root,'left')

    def test_build_preserves_contract_roles_alpha_and_content_hash(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); recipe, contract=self.fixture(root)
            recipe.update(separation_contract=contract,separation_contract_sha256=contract_hash(contract))
            for row in recipe['layers']: row['copyright_category']='original'
            atomic_json(root/'recipe.json',recipe); Image.new('RGB',(100,100)).save(root/'master.jpg')
            def fake_psd(args, **kwargs): Path(args[-1]).write_bytes(b'offline psd fixture')
            with patch('assemble.subprocess.run',side_effect=fake_psd): out=build(root/'recipe.json')
            for file in ('spec.json','recipe.json'):
                saved=json.loads((out/file).read_text())
                self.assertEqual(saved['separation_contract'],contract)
                self.assertTrue(check_recipe(out,saved,contract)['structurally_verified'])
                self.assertEqual(saved['layers'][0]['sha256'],digest(out/'assets/cup-left.png'))
            Image.new('RGBA',(20,20),'blue').save(out/'assets/cup-left.png')
            with self.assertRaisesRegex(ValueError,'SHA mismatch'): check_recipe(out,saved,contract)

    def test_multi_page_export_keeps_object_mapping_and_declared_page(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); recipe,contract=self.fixture(root)
            recipe['pages']=[{'id':p,'canvas':recipe['canvas']} for p in ('front','back')]
            for row,page in zip(recipe['layers'],recipe['pages']):
                row.update(page=page['id'],copyright_category='original')
            recipe.update(separation_contract=contract,separation_contract_sha256=contract_hash(contract))
            atomic_json(root/'recipe.json',recipe); Image.new('RGB',(100,100)).save(root/'master.jpg')
            def fake_psd(args, **kwargs): Path(args[-1]).write_bytes(b'offline psd fixture')
            with patch('assemble.subprocess.run',side_effect=fake_psd): out=build(root/'recipe.json')
            for name in ('spec.json','recipe.json'):
                exported=json.loads((out/name).read_text())
                self.assertEqual([r['page'] for r in exported['layers']],['front','back'])
                self.assertTrue(check_recipe(out,exported,contract)['structurally_verified'])

    def test_empty_contract_exported_shapes_remain_checkable(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); empty={'schema_version':1,'objects':[]}
            recipe={'canvas':{'w':30,'h':30},'separation_contract':empty,'layers':[{'id':'bg','name':'bg','type':'shape','box':[0,0,30,30],'color':[255,255,255,255]}]}
            atomic_json(root/'recipe.json',recipe); Image.new('RGB',(30,30)).save(root/'master.jpg')
            def fake_psd(args, **kwargs): Path(args[-1]).write_bytes(b'offline psd fixture')
            with patch('assemble.subprocess.run',side_effect=fake_psd): out=build(root/'recipe.json')
            for name in ('spec.json','recipe.json'):
                self.assertTrue(check_recipe(out,json.loads((out/name).read_text()),empty,exported=True)['structurally_verified'])

    def test_legacy_spec_retains_two_coordinate_image_box(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); recipe,_=self.fixture(root)
            atomic_json(root/'recipe.json',recipe); Image.new('RGB',(100,100)).save(root/'master.jpg')
            def fake_psd(args, **kwargs): Path(args[-1]).write_bytes(b'offline psd fixture')
            with patch('assemble.subprocess.run',side_effect=fake_psd): out=build(root/'recipe.json')
            spec=json.loads((out/'spec.json').read_text())
            self.assertNotIn('separation_contract',spec)
            self.assertEqual(spec['layers'][0], {'name':'cup-left','type':'image','box':[0,0],'png':'assets/cup-left.png'})
            # Adding contract metadata to legacy specs would invalidate already-reviewed
            # spec hashes when package_delivery rebuilds an existing submission.


if __name__ == '__main__': unittest.main()
