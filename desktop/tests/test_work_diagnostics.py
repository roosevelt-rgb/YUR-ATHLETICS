"""Failure evidence stays useful after reopen without copying raw exception data."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from foundry.commit_service import CommitService
from foundry.execution_cell import ExecutionCellError
from foundry.orchestration import OrchestrationManager
from foundry.work_cli import _event_summaries
from foundry.work_diagnostics import failure_change, safe_diagnostic
from foundry.work_provider import EmptyWorkResponse


def runtime_error(diagnostic):
    error = ExecutionCellError('unavailable', 'Cannot verify already-running WSL distributions')
    error.diagnostics = diagnostic
    return error


class WorkDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.diagnostic = {'schema': 'yur.execution-diagnostic.v1', 'phase': 'wsl_status',
                           'outcome': 'timeout', 'timeout_seconds': 8}

    def test_committed_failure_survives_reopen_and_resume_without_raw_cause(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'journal'
            request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()),
                       'mode': 'code', 'goal': 'Check runtime failure evidence.', 'root': temporary,
                       'provider': 'ollama', 'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Check.'}]}
            error = runtime_error(deepcopy(self.diagnostic))
            error.__cause__ = OSError('PRIVATE-COMMAND-AND-STREAM-CANARY')
            with CommitService(root) as store:
                manager = OrchestrationManager(store)
                def adapter(*_):
                    raise RuntimeError('Operation retained for recovery') from error
                with self.assertRaisesRegex(RuntimeError, 'retained'):
                    manager.run_work(request, adapter)
                mission_id = store.list_work()[0]['id']
                self.assertEqual(store.get_work(mission_id)['status'], 'failed')
                event = store.work_events(mission_id)[-1]
                self.assertEqual(event['event_type'], 'work.failed')
                self.assertEqual(event['data']['change'], {'error_type': 'RuntimeError', 'diagnostics': self.diagnostic})
                self.assertNotIn('PRIVATE-', json.dumps(store.work_events(mission_id)))
                self.assertEqual(_event_summaries([event])[0]['change']['diagnostics'], self.diagnostic)
                receipt = event['hash']
                error.diagnostics['outcome'] = 'os_error'
            with CommitService(root) as store:
                self.assertEqual(store.work_events(mission_id)[-1]['hash'], receipt)
                self.assertEqual(store.work_events(mission_id)[-1]['data']['change']['diagnostics'], self.diagnostic)
                result = OrchestrationManager(store).run_work(request, lambda *_: {'content': 'Continued the retained mission.'})
                self.assertEqual((result['id'], result['status']), (mission_id, 'completed'))
                self.assertEqual([e for e in store.work_events(mission_id) if e['hash'] == receipt][0]['data']['change']['diagnostics'], self.diagnostic)
                store.verify_integrity()

    def test_only_known_exception_types_and_explicit_bounded_causes_are_used(self):
        arbitrary = RuntimeError('Arbitrary error')
        arbitrary.diagnostics = self.diagnostic
        self.assertEqual(failure_change(arbitrary), {'error_type': 'RuntimeError'})
        arbitrary.__context__ = runtime_error(self.diagnostic)
        self.assertNotIn('diagnostics', failure_change(arbitrary))
        arbitrary.__cause__ = runtime_error(self.diagnostic)
        retained = failure_change(arbitrary)
        self.assertEqual(retained['diagnostics'], self.diagnostic)
        retained['diagnostics']['phase'] = 'runtime_selection'
        self.assertEqual(arbitrary.__cause__.diagnostics, self.diagnostic)
        arbitrary.__cause__ = arbitrary
        self.assertNotIn('diagnostics', failure_change(arbitrary))
        chain = runtime_error(self.diagnostic)
        for _ in range(8):
            wrapper = RuntimeError('wrapper'); wrapper.__cause__ = chain; chain = wrapper
        self.assertNotIn('diagnostics', failure_change(chain))

    def test_malformed_or_unknown_diagnostics_are_not_committed(self):
        invalid = [None, [], {'schema': 'future'}, {**self.diagnostic, 'stdout': 'PRIVATE'},
                   {**self.diagnostic, 'phase': []}, {**self.diagnostic, 'outcome': {}},
                   {**self.diagnostic, 'timeout_seconds': True}, {**self.diagnostic, 'timeout_seconds': float('nan')},
                   {**self.diagnostic, 'timeout_seconds': 10**1000}, {**self.diagnostic, 'errno': False},
                   {**self.diagnostic, 'stdout_bytes': -1}, {**self.diagnostic, 'stdout_sha256': 'BAD'},
                   {**self.diagnostic, 'selected_distro': 'PRIVATE\nVALUE'},
                   {**self.diagnostic, 'running_distros': ['B', 'A']},
                   {**self.diagnostic, 'running_distros': ['A'] * 33},
                   {**self.diagnostic, 'running_distros_truncated': 1}]
        for value in invalid:
            with self.subTest(value=str(value)[:100]):
                self.assertIsNone(safe_diagnostic(value))
                self.assertEqual(failure_change(runtime_error(value)), {'error_type': 'ExecutionCellError'})

    def test_selection_and_os_evidence_preserve_exact_bounded_facts(self):
        for extra in ({'outcome': 'os_error', 'errno': 13, 'winerror': 5},
                      {'phase': 'runtime_selection', 'outcome': 'selected_not_running', 'selected_distro': 'Ubuntu-24.04',
                       'running_distros': ['Debian'], 'running_distros_truncated': False},
                      {'outcome': 'nonzero_exit', 'returncode': -1, 'stdout_bytes': 0, 'stderr_bytes': 51,
                       'stdout_sha256': 'a' * 64, 'stderr_sha256': 'b' * 64}):
            value = {**self.diagnostic, **extra}
            self.assertEqual(failure_change(runtime_error(value))['diagnostics'], value)

    def test_provider_metadata_retained_without_answer_or_thinking(self):
        error = EmptyWorkResponse({'message': {'content': '', 'thinking': 'PRIVATE-THINKING', 'tool_calls': []},
                                   'done_reason': 'stop', 'eval_count': 164, 'prompt_eval_count': 7934})
        change = failure_change(error)
        self.assertEqual(change['diagnostics']['thinking_chars'], 16)
        self.assertEqual(change['diagnostics']['eval_count'], 164)
        self.assertNotIn('PRIVATE', json.dumps(change))
        self.assertIsNone(safe_diagnostic({**error.diagnostics, 'done_reason': []}))
        error.diagnostics['thinking'] = 'PRIVATE'
        self.assertNotIn('diagnostics', failure_change(error))


if __name__ == '__main__':
    unittest.main()
