"""Local regression checks; no browser/provider or production mutations."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from orchestrator import Controller, read, write
from browser_metrics import report
from publication_preflight import validate


class BrowserOptimizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.controller = Controller(self.root, 7, None, False, 1, 'tour')
        self.legacy = [('editor_prepare', 'prepare'), ('bind_assets', 'bind'), ('layer_audit', 'audit')]

    def test_new_group_uses_one_batch_and_completed_group_does_not_repeat(self):
        self.controller.browser_batch = Mock(return_value=True)
        self.controller.browser = Mock(side_effect=AssertionError('legacy call'))
        for _ in range(2):
            self.controller.browser_group('editor_batch', 'prepare,bind,audit', self.legacy, self.root / 'recipe.json')
        self.assertEqual(self.controller.browser_batch.call_count, 1)
        self.assertEqual(self.controller.state['stages']['editor_batch']['state'], 'done')

    def test_partial_legacy_group_keeps_its_completed_stage_and_recovery_path(self):
        self.controller.stage('editor_prepare', lambda: True)
        self.controller.browser_batch = Mock(side_effect=AssertionError('must not switch modes'))
        self.controller.browser = Mock(return_value=True)
        self.controller.browser_group('editor_batch', 'prepare,bind,audit', self.legacy, self.root / 'recipe.json')
        self.assertEqual([call.args[0] for call in self.controller.browser.call_args_list], ['bind', 'audit'])

    def test_failed_batch_stays_incomplete_and_retries_as_one_new_attempt(self):
        self.controller.browser_batch = Mock(side_effect=[RuntimeError('failed'), True])
        with self.assertRaises(RuntimeError):
            self.controller.browser_group('editor_batch', 'prepare,bind,audit', self.legacy, self.root / 'recipe.json')
        self.assertNotIn('bind_assets', self.controller.state['stages'])
        self.controller.browser_group('editor_batch', 'prepare,bind,audit', self.legacy, self.root / 'recipe.json')
        self.assertEqual(self.controller.browser_batch.call_count, 2)
        self.assertEqual(len(self.controller.state['stage_attempts']), 2)

    def test_batch_command_is_single_process_and_includes_gate_and_attempt(self):
        with patch('orchestrator.DATA', self.root), patch('orchestrator.subprocess.run') as invoke:
            self.controller.stage('publication_batch', lambda: self.controller.browser_batch('form,submit,declare,verify', self.root / 'recipe.json'))
        self.assertEqual(invoke.call_count, 1)
        command = invoke.call_args.args[0]
        self.assertIn('browser-batch', command)
        self.assertIn('--final-review-gate', command)
        self.assertIn(self.controller.state['stage_attempts'][0]['attempt_id'], command)
        self.controller.report()
        self.assertIn('browser_steps', read(self.root / 'timing-report.json'))

    def test_timing_reports_failures_retries_and_unknown_interrupted_duration(self):
        log = self.root / 'browser-sequence.jsonl'
        def event(kind, attempt, **kw):
            return dict(event=kind, attempt_id=attempt, sequence='prepare,bind,audit', step='bind', at='2026-01-01T00:00:00Z', **kw)
        events = [event('step_start', 'a'), event('step_failure', 'a', elapsed_ms=200),
                  event('step_start', 'b'), event('step_success', 'b', elapsed_ms=100), event('step_start', 'c')]
        log.write_text('\n'.join(map(json.dumps, events)) + '\ntruncated\n')
        result = report([log, log])
        self.assertEqual(result['by_step']['bind'], dict(attempts=3, completed=1, failed=1, incomplete=1, observed_ms=300))
        self.assertIsNone(result['steps'][-1]['elapsed_ms'])
        self.assertEqual(len(result['warnings']), 1)

    def test_preflight_requires_each_object_to_have_individual_hide_audit(self):
        recipe = self.root / 'release-recipe.json'
        write(self.root / 'native-input.json', {})
        write(recipe, {'layers': [{'id': 'cup-a', 'name': 'left cup'}, {'id': 'cup-b', 'name': 'right cup'}],
                       'layer_audit': {'pairs': [{'subject': 'left cup', 'background': 'background'}]}})
        source = {'status': 'structurally-verified', 'objects': [{'layer_id': 'cup-a', 'role': 'foreground'}, {'layer_id': 'cup-b', 'role': 'foreground'}]}
        with patch('publication_preflight.check', return_value=source), patch('publication_preflight.validate_assets'):
            with self.assertRaisesRegex(ValueError, 'right cup'):
                validate(recipe)
            data = read(recipe)
            data['layer_audit']['pairs'].append({'subject': 'right cup', 'background': 'background'})
            write(recipe, data)
            self.assertFalse(validate(recipe)['visual_verified'])

    def test_legacy_without_native_snapshot_is_not_claimed_verified(self):
        self.assertEqual(validate(self.root / 'recipe.json'), {'status': 'legacy-unverified', 'visual_verified': False})


if __name__ == '__main__':
    unittest.main()
