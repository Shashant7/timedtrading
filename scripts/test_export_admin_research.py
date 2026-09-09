"""Credential and destination boundaries for the read-only research exporter."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('admin_export', Path(__file__).with_name('export-admin-research.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ResearchExportTest(unittest.TestCase):
    def test_secret_is_stdin_only_and_destination_is_fixed(self):
        secret = 'unit-test-credential'
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=b'{"ok":true,"trades":[]}\n200')) as run:
            url, _, result = module.read_api('/timed/debug/trades', {}, secret)
        args, kwargs = run.call_args
        self.assertNotIn(secret, ' '.join(args[0]))
        self.assertNotIn('TIMED_API_KEY', kwargs['env'])
        self.assertEqual(kwargs['input'], ('X-API-Key: ' + secret + '\n').encode())
        self.assertNotIn('-L', args[0])
        self.assertEqual(url, module.ORIGIN + '/timed/debug/trades')
        self.assertEqual(result['trades'], [])

    def test_rejects_non_allowlisted_routes_without_network(self):
        with patch.object(module.subprocess, 'run') as run:
            for route in ['https://example.com', '//example.com', '/timed/admin/model-config/apply']:
                with self.assertRaises(ValueError):
                    module.read_api(route, {}, 'unit-test-credential')
            run.assert_not_called()

    def test_rejects_header_injection_without_network(self):
        with patch.object(module.subprocess, 'run') as run:
            for value in ['', 'test\nAnother-Header: value', 'test\rvalue', 'test\x00value']:
                with self.assertRaises(ValueError):
                    module.read_api('/timed/debug/trades', {}, value)
            run.assert_not_called()

    def test_redirects_and_auth_failures_do_not_return_response_bodies(self):
        for status in [b'302', b'401', b'403']:
            with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(
                    returncode=0, stdout=b'private error body\n' + status)):
                with self.assertRaisesRegex(RuntimeError, '^HTTP ' + status.decode() + '$'):
                    module.read_api('/timed/debug/trades', {}, 'unit-test-credential')

    def test_reflected_secret_cannot_be_written_as_research_data(self):
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=b'{"ok":true,"echo":"unit-test-credential"}\n200')):
            with self.assertRaisesRegex(RuntimeError, 'Response reflected'):
                module.read_api('/timed/debug/trades', {}, 'unit-test-credential')

    def test_run_ids_are_encoded_and_never_become_filesystem_paths(self):
        reads = module.requests_for(['../../run/id?a=1', '../../run/id?a=1'])
        self.assertEqual(len(reads), 9)
        for name, route, params in reads:
            self.assertNotIn('/', name)
            self.assertIn(route, module.ALLOWED_PATHS)
        self.assertEqual(reads[-1][2]['run_id'], '../../run/id?a=1')


if __name__ == '__main__':
    unittest.main()
