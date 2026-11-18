"""Local CLI contract tests; no ego-browser or production browser is started."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ENTRY = Path(__file__).resolve().with_name('run.py')


class BrowserSequenceCLI(unittest.TestCase):
    def invoke(self, args):
        stubs = {}
        for module, names in {'jobs': ['run', 'download_resources'], 'localize': ['localize'],
                              'assemble': ['build'], 'register_assets': ['register']}.items():
            stubs[module] = types.SimpleNamespace(**{name: lambda *a: None for name in names})
        with patch.dict(sys.modules, stubs), patch.object(sys, 'argv', [str(ENTRY), *args]), \
                patch('shutil.which', return_value=sys.executable), patch('subprocess.run') as command:
            runpy.run_path(str(ENTRY), run_name='__main__')
            return command

    def test_batch_one_runtime_and_safe_absolute_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            recipe = Path(directory) / 'quote\" tick` dollar$(no) newline\n.json'
            page = 'p1\"; throw Error("injection"); //'
            log = Path(directory) / 'steps.jsonl'
            command = self.invoke(['browser-batch', 'prepare,bind,audit', str(recipe),
                                   '--space', '17', '--page', page, '--log', str(log), '--attempt-id', 'test-attempt'])
            command.assert_called_once()
            args, kwargs = command.call_args
            self.assertEqual(args[0], [sys.executable, 'nodejs'])
            self.assertTrue(kwargs['check'])
            self.assertNotIn('shell', kwargs)
            script = kwargs['input']
            self.assertEqual(script.count('taskSpace('), 1)
            self.assertEqual(script.count('.page('), 1)
            self.assertEqual(script.count('runSequence('), 1)
            self.assertIn(json.dumps(str(recipe.resolve())), script)
            self.assertIn(json.dumps(page), script)
            self.assertIn(json.dumps(str(ENTRY.with_name('browser_sequence.js'))), script)
            self.assertIn(json.dumps(str(log.resolve())), script)

    def test_publication_requires_gate_argument(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            self.invoke(['browser-batch', 'form,submit,declare,verify', 'recipe.json', '--space', '17'])
        self.assertEqual(error.exception.code, 2)

    def test_legacy_single_phases_unchanged(self):
        methods = {'prepare':'prepare', 'bind':'bind', 'audit':'audit', 'form':'prepareForm',
                   'update':'prepareUpdate', 'submit':'submit', 'declare':'completeDeclaration', 'verify':'verify'}
        for phase, method in methods.items():
            with self.subTest(phase=phase):
                command = self.invoke(['browser', phase, 'recipe.json', '--space', '17'])
                command.assert_called_once()
                script = command.call_args.kwargs['input']
                self.assertIn('m.default.' + method + '(p,', script)
                self.assertNotIn('runSequence', script)
        with tempfile.TemporaryDirectory() as directory:
            recipe = Path(directory) / 'recipe.json'
            recipe.write_text('{"output":"release"}')
            command = self.invoke(['browser','register-assets',str(recipe),'--space','17'])
            self.assertIn('m.default.register(p,', command.call_args.kwargs['input'])
            self.assertIn(str(recipe.parent / 'release/registered-assets/request.json'), command.call_args.kwargs['input'])


if __name__ == '__main__':
    unittest.main()
