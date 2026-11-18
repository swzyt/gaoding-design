"""Local-only registration category tests; all external CLI calls are mocked."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from register_assets import register


class RegisterNonOriginalTests(unittest.TestCase):
    def test_supported_categories_preserve_hash_and_receipt_on_resume(self):
        for category in ('non_original', 'original', 'original_ai'):
            with self.subTest(category=category), tempfile.TemporaryDirectory(prefix='gd-registration-') as tmp:
                root = Path(tmp)
                out = root / 'release'
                (out / 'assets').mkdir(parents=True)
                image = out / 'assets/photo.png'
                image.write_bytes(b'exact final PNG fixture')
                recipe = root / 'recipe.json'
                recipe.write_text(json.dumps({'title': 'Photo design', 'layers': [
                    {'id': 'photo', 'name': 'Photo', 'type': 'image', 'copyright_category': category},
                    {'id': 'title', 'name': 'Title', 'type': 'text'},
                ]}))
                with patch('register_assets.subprocess.check_output', return_value=b'{"repositories":[{"repository_id":"42"}]}'), patch(
                    'register_assets.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '{"asset_id":"99"}')
                ) as upload:
                    rows = register(recipe, '42')
                    self.assertEqual(rows[0]['category'], category)
                    self.assertEqual(rows[0]['sha256'], hashlib.sha256(image.read_bytes()).hexdigest())
                    self.assertEqual(register(recipe, '42'), rows)
                    self.assertEqual(upload.call_count, 1)
                    image.write_bytes(b'changed photo')
                    with self.assertRaisesRegex(ValueError, 'Asset changed'):
                        register(recipe, '42')
                    self.assertEqual(upload.call_count, 1)

    def test_browser_request_preserves_non_original_and_freezes_hash(self):
        from browser_registration import prepare
        with tempfile.TemporaryDirectory(prefix='gd-browser-category-') as tmp:
            root = Path(tmp)
            (root / 'release/assets').mkdir(parents=True)
            image = root / 'release/assets/photo.png'
            image.write_bytes(b'final photo fixture')
            recipe = root / 'recipe.json'
            recipe.write_text(json.dumps({'title': 'Photo', 'layers': [
                {'id': 'photo', 'name': 'Photo', 'type': 'image', 'copyright_category': 'non_original'}]}))
            request = prepare(recipe)
            self.assertEqual(request['assets'][0]['category'], 'non_original')
            self.assertEqual(request['assets'][0]['sha256'], hashlib.sha256(image.read_bytes()).hexdigest())
            self.assertEqual(prepare(recipe), request)
            image.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'inputs changed'):
                prepare(recipe)

    def test_unknown_category_is_rejected_before_upload(self):
        with tempfile.TemporaryDirectory(prefix='gd-registration-') as tmp:
            root = Path(tmp)
            (root / 'release').mkdir()
            recipe = root / 'recipe.json'
            recipe.write_text(json.dumps({'layers': [{'name': 'Photo', 'type': 'image', 'copyright_category': 'stock'}]}))
            with patch('register_assets.subprocess.check_output', return_value=b'{"repositories":[{"repository_id":"42"}]}'), patch('register_assets.subprocess.run') as upload:
                with self.assertRaisesRegex(ValueError, 'explicit supported copyright_category'):
                    register(recipe, '42')
                upload.assert_not_called()


if __name__ == '__main__':
    unittest.main()
