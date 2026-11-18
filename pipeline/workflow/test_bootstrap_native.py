"""Offline bootstrap regressions; PATH contains only local stubs and shell utilities."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / 'pipeline/workflow/bootstrap.sh'
STUB = '''#!{python}
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps([name, *sys.argv[1:]]) + '\\n')
if os.environ.get('STUB_FAIL') == name:
    print('stub failure: ' + name, file=sys.stderr)
    sys.exit(37)
if name == 'python3' and sys.argv[1:3] == ['-m', 'venv']:
    target = pathlib.Path(sys.argv[3]) / 'bin/python'
    target.parent.mkdir(parents=True)
    target.write_text(pathlib.Path(sys.argv[0]).read_text())
    target.chmod(0o755)
'''


class BootstrapNativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.runtime = self.base / 'dependencies'
        self.log = self.base / 'calls.jsonl'
        # Never inherit host PATH, HOME fallback tools, or runtime directories.
        self.env = {
            'PATH': str(self.bin), 'HOME': str(self.base / 'home'),
            'GAODING_RUNTIME_HOME': str(self.runtime), 'STUB_LOG': str(self.log),
        }
        for name in ('bash', 'dirname', 'mkdir', 'cp'):
            target = shutil.which(name)
            self.assertIsNotNone(target, name)
            (self.bin / name).symlink_to(target)
        for name in ('node', 'npm', 'python3', 'ego-browser'):
            self.stub(name)

    def stub(self, name):
        target = self.bin / name
        target.write_text(STUB.format(python=sys.executable))
        target.chmod(0o755)

    def launch(self, *args, wrapper=False, fail=None):
        env = dict(self.env)
        if fail:
            env['STUB_FAIL'] = fail
        command = [str(self.bin / 'bash')]
        command += [str(ROOT / 'workflow.sh'), 'bootstrap'] if wrapper else [str(BOOTSTRAP)]
        return subprocess.run(command + list(args), env=env, text=True,
                              capture_output=True, timeout=15)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def assert_native_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual([call[0] for call in calls], ['python3', 'python', 'npm'])
        self.assertEqual(calls[0][1:], ['-m', 'venv', str(self.runtime / '.venv')])
        self.assertEqual(calls[1][1:], ['-m', 'pip', 'install', 'Pillow==11.3.0'])
        self.assertEqual(calls[2][1:], ['ci', '--prefix', str(self.runtime / 'workflow'), '--ignore-scripts'])

    def test_default_without_gd_cli(self):
        self.assertIsNone(shutil.which('gd-cli', path=str(self.bin)))
        self.assert_native_success(self.launch())

    def test_wrapper_default_without_gd_cli(self):
        self.assert_native_success(self.launch(wrapper=True))

    def test_default_does_not_execute_available_gd_cli(self):
        self.stub('gd-cli')
        self.assert_native_success(self.launch(fail='gd-cli'))

    def test_explicit_legacy_checks_compatibility(self):
        self.stub('gd-cli')
        result = self.launch('--legacy-cli', wrapper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-2:], [
            ['gd-cli', '--version'],
            ['node', str(ROOT / 'pipeline/fixes/test-reference-wire.mjs')],
        ])

    def test_legacy_missing_cli_fails_before_install(self):
        result = self.launch('--legacy-cli')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Required command not found: gd-cli', result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.runtime.exists())

    def test_unknown_argument_fails_before_install(self):
        for wrapper in (False, True):
            with self.subTest(wrapper=wrapper):
                result = self.launch('--unknown', wrapper=wrapper)
                self.assertEqual(result.returncode, 2)
                self.assertIn('Unknown bootstrap argument: --unknown', result.stderr)
                self.assertIn('Usage: bootstrap [--legacy-cli]', result.stderr)
                self.assertEqual(self.calls(), [])
                self.assertFalse(self.runtime.exists())

    def test_missing_native_dependency_is_clear(self):
        # Construct a separate PATH rather than consulting any globally installed CLI.
        isolated = self.base / 'missing-node'
        isolated.mkdir()
        for name in ('bash', 'dirname'):
            (isolated / name).symlink_to(self.bin / name)
        self.env['PATH'] = str(isolated)
        result = self.launch()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Required command not found: node', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_venv_error_propagates(self):
        result = self.launch(fail='python3')
        self.assertEqual(result.returncode, 37)
        self.assertIn('stub failure: python3', result.stderr)
        self.assertEqual([call[0] for call in self.calls()], ['python3'])

    def test_pip_error_propagates(self):
        result = self.launch(fail='python')
        self.assertEqual(result.returncode, 37)
        self.assertIn('stub failure: python', result.stderr)
        self.assertEqual([call[0] for call in self.calls()], ['python3', 'python'])

    def test_npm_error_propagates(self):
        result = self.launch(fail='npm')
        self.assertEqual(result.returncode, 37)
        self.assertIn('stub failure: npm', result.stderr)

    def test_legacy_version_error_propagates(self):
        self.stub('gd-cli')
        result = self.launch('--legacy-cli', fail='gd-cli')
        self.assertEqual(result.returncode, 37)
        self.assertIn('stub failure: gd-cli', result.stderr)
        self.assertNotIn('node', [call[0] for call in self.calls()])

    def test_legacy_reference_error_propagates(self):
        self.stub('gd-cli')
        result = self.launch('--legacy-cli', fail='node')
        self.assertEqual(result.returncode, 37)
        self.assertIn('stub failure: node', result.stderr)


if __name__ == '__main__':
    unittest.main()
