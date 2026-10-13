"""Failure metadata contracts only: all process calls are mocked; no WSL boot."""
from copy import deepcopy
import errno
import hashlib
import json
import os
import subprocess
import unittest
from unittest.mock import patch

from foundry import execution_cell as cell


CANARY = 'sk-' + 'DiagnosticSecretCanary' * 2


def completed(stdout=b'', stderr=b'', returncode=0):
    return subprocess.CompletedProcess(['never-executed'], returncode, stdout, stderr)


class ExecutionDiagnosticTests(unittest.TestCase):
    def check_safe(self, error, phase, outcome):
        self.assertEqual(error.code, 'unavailable')
        value = error.diagnostics
        self.assertEqual(value['schema'], 'yur.execution-diagnostic.v1')
        self.assertEqual((value['phase'], value['outcome']), (phase, outcome))
        encoded = json.dumps(value, sort_keys=True)
        self.assertNotIn(CANARY, encoded)
        self.assertLessEqual(len(encoded.encode()), 4096)
        self.assertFalse({'cmd', 'argv', 'environment', 'stdout', 'stderr', 'filename', 'cause', 'message'} & value.keys())
        return value

    def test_status_timeout_retains_only_typed_cause_and_exact_query(self):
        cause = subprocess.TimeoutExpired([CANARY], 8, output=CANARY.encode(), stderr=CANARY.encode())
        with patch.object(cell.subprocess, 'run', side_effect=cause) as run:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell._running()
        value = self.check_safe(caught.exception, 'wsl_status', 'timeout')
        self.assertEqual(value, {'schema': 'yur.execution-diagnostic.v1', 'phase': 'wsl_status',
                                 'outcome': 'timeout', 'timeout_seconds': 8})
        self.assertEqual(str(caught.exception), 'Cannot verify already-running WSL distributions')
        self.assertIs(caught.exception.__cause__, cause)
        run.assert_called_once_with([cell.WSL, '--list', '--verbose'], capture_output=True,
                                    timeout=8, env=cell._environment(), creationflags=cell._NO_WINDOW)

    def test_status_os_error_keeps_numbers_not_filename_or_message(self):
        cause = PermissionError(errno.EACCES, CANARY, CANARY)
        cause.winerror = 5
        with patch.object(cell.subprocess, 'run', side_effect=cause) as run:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell._running()
        value = self.check_safe(caught.exception, 'wsl_status', 'os_error')
        self.assertEqual((value['errno'], value['winerror']), (errno.EACCES, 5))
        self.assertNotIn('timeout_seconds', value)
        run.assert_called_once()

    def test_nonzero_exit_hashes_but_never_includes_streams(self):
        stdout, stderr = b'not a status table ' + CANARY.encode(), CANARY.encode()
        with patch.object(cell.subprocess, 'run', return_value=completed(stdout, stderr, 5)) as run:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell._running()
        value = self.check_safe(caught.exception, 'wsl_status', 'nonzero_exit')
        self.assertEqual(value['returncode'], 5)
        for channel, data in [('stdout', stdout), ('stderr', stderr)]:
            self.assertEqual(value[channel + '_bytes'], len(data))
            self.assertEqual(value[channel + '_sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(str(caught.exception), 'WSL distribution status is unavailable')
        run.assert_called_once()

    def test_oversized_status_has_its_own_observed_outcome(self):
        for channel in ['stdout', 'stderr']:
            streams = {'stdout': b'', 'stderr': b'', channel: b'x' * 65537}
            with self.subTest(channel=channel), patch.object(cell.subprocess, 'run', return_value=completed(**streams)):
                with self.assertRaises(cell.ExecutionCellError) as caught:
                    cell._running()
            value = self.check_safe(caught.exception, 'wsl_status', 'output_limit')
            self.assertEqual(value[channel + '_bytes'], 65537)
            self.assertEqual(value['returncode'], 0)

    def test_success_preserves_exact_existing_parser_without_retry(self):
        text = 'NAME STATE VERSION\r\n * Ubuntu-24.04 Running 2\r\n Ubuntu Stopped 2\r\n Legacy Running 1\r\n'
        with patch.object(cell.subprocess, 'run', return_value=completed(text.encode('utf-16-le'))) as run:
            self.assertEqual(cell._running(), {'Ubuntu-24.04'})
        run.assert_called_once()

    def test_selection_metadata_is_bounded_and_cannot_boot(self):
        names = {f'Ubuntu-fixture-{index:02d}' for index in range(35)} | {CANARY, 'invalid\nlabel'}
        with patch.dict(os.environ, {'YUR_EXECUTION_DISTRO': 'Ubuntu-24.04'}, clear=True), \
                patch.object(cell, '_running', return_value=names), patch.object(cell, '_runtime_for') as runtime:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell.resolve_runtime()
        value = self.check_safe(caught.exception, 'runtime_selection', 'selected_not_running')
        self.assertEqual(value['selected_distro'], 'Ubuntu-24.04')
        self.assertEqual(len(value['running_distros']), 32)
        self.assertEqual(value['running_distros'], sorted(value['running_distros']))
        self.assertTrue(value['running_distros_truncated'])
        runtime.assert_not_called()

    def test_invalid_or_credential_shaped_selection_never_enters_metadata(self):
        for selected, outcome in [('bad\n' + CANARY, 'invalid_selection'), (CANARY, 'selected_not_running')]:
            with self.subTest(selected=selected), patch.dict(os.environ, {'YUR_EXECUTION_DISTRO': selected}, clear=True), \
                    patch.object(cell, '_running', return_value=set()), patch.object(cell, '_runtime_for') as runtime:
                with self.assertRaises(cell.ExecutionCellError) as caught:
                    cell.resolve_runtime()
            value = self.check_safe(caught.exception, 'runtime_selection', outcome)
            self.assertNotIn('selected_distro', value)
            runtime.assert_not_called()

    def test_ambiguous_default_has_no_fallback_or_policy_change(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(cell, '_running', return_value={'Ubuntu', 'Ubuntu-24.04'}), \
                patch.object(cell, '_runtime_for', side_effect=lambda name: {'distro': name}) as runtime:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell.resolve_runtime()
        value = self.check_safe(caught.exception, 'runtime_selection', 'ambiguous_selection')
        self.assertEqual(value['running_distros'], ['Ubuntu', 'Ubuntu-24.04'])
        self.assertEqual(runtime.call_count, 2)

    def test_runtime_recheck_stops_before_metadata_subprocess(self):
        with patch.object(cell, '_running', return_value=set()), patch.object(cell.subprocess, 'run') as run:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell._runtime_for('Ubuntu-24.04')
        self.check_safe(caught.exception, 'runtime_selection', 'selected_not_running')
        run.assert_not_called()

    def test_metadata_query_timeout_keeps_original_deadline_and_no_retry(self):
        cause = subprocess.TimeoutExpired([CANARY], 8, output=CANARY.encode())
        with patch.object(cell, '_running', return_value={'Ubuntu-24.04'}), \
                patch.object(cell.subprocess, 'run', side_effect=cause) as run:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell._runtime_for('Ubuntu-24.04')
        value = self.check_safe(caught.exception, 'runtime_verification', 'timeout')
        self.assertEqual(value['timeout_seconds'], 8)
        self.assertEqual(value['selected_distro'], 'Ubuntu-24.04')
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs, {'capture_output': True, 'timeout': 8,
                                              'env': cell._environment(), 'creationflags': cell._NO_WINDOW})

    def test_prelaunch_disappearance_has_metadata_and_never_starts_guardian(self):
        with patch.object(cell, 'validate_snapshot', return_value={}), \
                patch.object(cell, 'resolve_runtime', return_value={'distro': 'Ubuntu-24.04'}), \
                patch.object(cell, '_running', return_value=set()) as running, \
                patch.object(cell.subprocess, 'Popen') as launch:
            with self.assertRaises(cell.ExecutionCellError) as caught:
                cell.run_snapshot({})
        value = self.check_safe(caught.exception, 'runtime_selection', 'selected_not_running')
        self.assertEqual(value['selected_distro'], 'Ubuntu-24.04')
        self.assertEqual(value['running_distros'], [])
        self.assertEqual(str(caught.exception), 'Execution resource stopped before launch')
        running.assert_called_once()
        launch.assert_not_called()

    def test_metadata_response_failures_do_not_log_guest_code_or_output(self):
        for response, outcome, message in [
            (completed(CANARY.encode(), CANARY.encode(), 1), 'nonzero_exit', 'Execution runtime differs'),
            (completed(b'x' * 16385), 'output_limit', 'Execution runtime differs'),
            (completed(CANARY.encode()), 'malformed_response', 'Malformed runtime verification'),
            (completed(b'{}'), 'fingerprint_mismatch', 'Runtime verification does not match'),
        ]:
            with self.subTest(outcome=outcome), patch.object(cell, '_running', return_value={'Ubuntu-24.04'}), \
                    patch.object(cell.subprocess, 'run', return_value=response) as run:
                with self.assertRaises(cell.ExecutionCellError) as caught:
                    cell._runtime_for('Ubuntu-24.04')
            self.check_safe(caught.exception, 'runtime_verification', outcome)
            self.assertTrue(str(caught.exception).startswith(message))
            run.assert_called_once()

    def test_error_metadata_is_detached_and_invalid_envelopes_are_omitted(self):
        good = {'schema': 'yur.execution-diagnostic.v1', 'phase': 'runtime_selection',
                'outcome': 'selected_not_running', 'running_distros': ['Ubuntu'], 'running_distros_truncated': False}
        error = cell.ExecutionCellError('unavailable', 'original message', diagnostics=good)
        good['running_distros'].clear()
        self.assertEqual(error.diagnostics['running_distros'], ['Ubuntu'])
        for key, value in [('argv', CANARY), ('phase', []), ('outcome', 'invented-cause'),
                           ('timeout_seconds', float('nan')), ('returncode', True),
                           ('stdout_sha256', 'NOT_A_HASH'), ('selected_distro', CANARY),
                           ('running_distros', ['Ubuntu'] * 33)]:
            bad = {**deepcopy(error.diagnostics), key: value}
            with self.subTest(key=key):
                rejected = cell.ExecutionCellError('unavailable', 'original message', diagnostics=bad)
                self.assertIsNone(rejected.diagnostics)
                self.assertEqual(str(rejected), 'original message')
        self.assertIsNone(cell.ExecutionCellError('invalid', 'ordinary validation error').diagnostics)


if __name__ == '__main__':
    unittest.main()
