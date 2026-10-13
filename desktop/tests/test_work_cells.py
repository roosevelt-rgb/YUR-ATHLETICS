"""Snapshot/result authority and replay checks, independent of a WSL install."""
import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_engine import AUTHORITY
from foundry.work_store import now
from foundry.work_tools import execute_tool
from foundry import work_cells, work_engine
from foundry.work_cli import _event_summaries


def outcome(snapshot, text='Actual check output', exit_code=0):
    return {'schema': 'yur.execution-cell-result.v1', 'snapshot_id': snapshot['id'], 'profile': snapshot['profile'],
            'status': 'completed' if exit_code == 0 else 'failed', 'exit_code': exit_code,
            'stdout': text, 'stderr': '', 'stdout_bytes': len(text.encode()), 'stderr_bytes': 0,
            'stdout_sha256': hashlib.sha256(text.encode()).hexdigest(), 'stderr_sha256': hashlib.sha256(b'').hexdigest(),
            'duration_ms': 2, 'runtime': {'test_adapter': True}, 'limits': {}, 'scratch': 'discarded'}


class WorkCellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'; self.root.mkdir()
        self.source = self.root / 'test_example.py'; self.source.write_text('value = 317\n', encoding='utf-8')
        self.store = CommitService(Path(self.temp.name) / 'state'); self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'code', 'goal': 'Check selected Python',
                   'root': str(self.root), 'provider': 'ollama', 'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Check selected Python'}]}
        self.parent = self.store.submit_work(request, AUTHORITY)
        self.update(status='running')
        self.args = {'files': ['test_example.py'], 'profile': 'python-compile-serial', 'test_directory': '.', 'proposal_ids': []}

    def update(self, **changes):
        document = {key: copy.deepcopy(value) for key, value in self.parent.items() if key not in {'revision', 'receipt'}}
        document.update(changes, updated_at=now())
        self.parent = self.store.commit_work(document, self.parent['revision'], 'work.test.setup', {})

    def invoke(self, runner, args=None):
        with self.store.acquire_worker():
            return work_cells.execute(self.manager, self.parent, args or self.args, runner=runner)

    def refresh(self):
        self.parent = self.store.get_work(self.parent['id'])

    def test_snapshot_precedes_execution_and_real_failed_exit_is_retained(self):
        def runner(snapshot, **_kwargs):
            records = self.store.work_events(self.parent['id'])
            self.assertEqual(records[-1]['event_type'], work_cells.SNAPSHOT)
            self.assertEqual(records[-1]['data']['change']['snapshot'], snapshot)
            self.assertEqual(snapshot['files'][0]['content'], self.source.read_bytes().decode('utf-8'))
            self.assertEqual(snapshot['files'][0]['sha256'], hashlib.sha256(self.source.read_bytes()).hexdigest())
            self.assertNotIn(str(self.root), str(snapshot))
            return outcome(snapshot, 'One selected assertion failed', 1)
        result = self.invoke(runner)
        self.assertTrue(result['committed']); self.assertEqual(result['execution']['exit_code'], 1)
        self.assertEqual(result['execution']['status'], 'failed')
        self.assertEqual(self.store.work_events(self.parent['id'])[-1]['hash'], result['provenance']['result_receipt'])
        self.assertEqual(self.source.read_text(), 'value = 317\n')
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_interrupted_parent_recovers_exact_result_without_execution_or_fresh_source(self):
        first = self.invoke(lambda snapshot, **kwargs: outcome(snapshot))
        self.source.write_text('value = 999\n', encoding='utf-8'); self.refresh()
        def forbidden(*_args, **_kwargs):
            self.fail('A committed cell result must not execute again')
        self.assertEqual(self.invoke(forbidden), first)
        self.assertEqual(self.source.read_text(), 'value = 999\n')

    def test_snapshot_binds_pending_input_and_rejects_cancelled_or_stale_parent(self):
        def interrupted(*_args, **_kwargs):
            raise RuntimeError('Simulated process interruption')
        with self.assertRaisesRegex(RuntimeError, 'interruption'):
            self.invoke(interrupted)
        with self.assertRaisesRegex(ValueError, 'current Code-mode'):
            self.invoke(interrupted)
        self.refresh()
        with self.assertRaisesRegex(ValueError, 'different execution snapshot'):
            self.invoke(interrupted, {**self.args, 'profile': 'python-unittest-serial'})
        with self.assertRaisesRegex(ValueError, 'different execution snapshot'):
            work_cells.check_step_binding(self.manager, self.parent, 'read_file', {'path': 'test_example.py'})
        self.manager.cancel_work(self.parent['id']); self.refresh()
        with self.assertRaisesRegex(ValueError, 'current Code-mode'):
            self.invoke(interrupted)

    def test_staged_edit_is_tested_without_changing_source(self):
        proposal = execute_tool('propose_edit', {'path': 'test_example.py', 'content': 'value = 318\n', 'expected_sha256': hashlib.sha256(self.source.read_bytes()).hexdigest()}, self.root)['proposal']
        identity = uuid.uuid4().hex
        self.update(artifacts=[{'id': identity, 'proposal': proposal, 'status': 'proposed'}])
        args = {**self.args, 'proposal_ids': [identity]}
        def runner(snapshot, **_kwargs):
            self.assertEqual(snapshot['files'][0]['content'], 'value = 318\n')
            self.assertEqual(self.source.read_text(), 'value = 317\n')
            return outcome(snapshot)
        result = self.invoke(runner, args)
        self.assertTrue(result['snapshot']['sources'][0]['overlay'])
        self.assertEqual(self.source.read_text(), 'value = 317\n')

    def test_stale_overlay_is_rejected_before_snapshot(self):
        proposal = execute_tool('propose_edit', {'path': 'test_example.py', 'content': 'value = 318\n', 'expected_sha256': hashlib.sha256(self.source.read_bytes()).hexdigest()}, self.root)['proposal']
        identity = uuid.uuid4().hex
        self.update(artifacts=[{'id': identity, 'proposal': proposal, 'status': 'proposed'}])
        self.source.write_text('value = 999\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.invoke(lambda *_args, **_kwargs: self.fail('Stale overlay executed'), {**self.args, 'proposal_ids': [identity]})
        self.assertFalse(any(event['event_type'] == work_cells.SNAPSHOT for event in self.store.work_events(self.parent['id'])))

    def test_credential_like_source_is_rejected_before_snapshot(self):
        self.source.write_text('API_KEY = "sk-' + 'a' * 48 + '"\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Credential-like'):
            self.invoke(lambda *_args, **_kwargs: self.fail('Credential source executed'))
        self.assertFalse(any(event['event_type'] == work_cells.SNAPSHOT for event in self.store.work_events(self.parent['id'])))

    def test_path_escape_and_forged_worker_receipt_are_rejected(self):
        for args in [{**self.args, 'files': ['../outside.py']}, {**self.args, 'files': ['test_example.py', 'TEST_EXAMPLE.py']}, {**self.args, 'proposal_ids': [uuid.uuid4().hex]}]:
            with self.assertRaises(ValueError):
                self.invoke(lambda snapshot, **kwargs: outcome(snapshot), args)
        def forged(snapshot, **_kwargs):
            return {**outcome(snapshot), 'snapshot_id': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'mismatched snapshot'):
            self.invoke(forged)
        self.assertFalse(any(event['event_type'] == work_cells.RESULT for event in self.store.work_events(self.parent['id'])))

    def test_engine_resumes_committed_cell_without_asking_model_or_executing_again(self):
        request = self.parent['request']
        tool_call = {'function': {'name': work_cells.TOOL, 'arguments': self.args}}
        original_commit = work_engine._commit
        def interrupted_commit(manager, mission, status, event_type, *args, **kwargs):
            if event_type == 'work.tool.completed':
                raise RuntimeError('Interrupted after the cell result committed')
            return original_commit(manager, mission, status, event_type, *args, **kwargs)
        with patch('foundry.execution_cell.run_snapshot', side_effect=lambda snapshot, **kwargs: outcome(snapshot, 'Checked exact snapshot', 1)) as runner:
            with patch('foundry.work_engine._commit', side_effect=interrupted_commit):
                with self.assertRaisesRegex(RuntimeError, 'Interrupted'):
                    self.manager.run_work(request, lambda *_: {'content': '', 'tool_calls': [tool_call]})
            self.assertEqual(runner.call_count, 1)
            self.source.write_text('invalid changed source', encoding='utf-8')
            calls = []
            def resumed(messages, tools):
                calls.append(messages)
                self.assertIn(work_cells.TOOL, [item['name'] for item in tools])
                self.assertIn('Checked exact snapshot', messages[-1]['content'])
                return {'content': 'The recorded check exited with status 1.'}
            finished = self.manager.run_work(request, resumed)
            self.assertEqual(runner.call_count, 1)
        self.assertEqual((len(calls), len(finished['steps']), finished['status']), (1, 1, 'completed'))
        self.assertEqual(finished['steps'][0]['result']['execution']['exit_code'], 1)
        events = self.store.work_events(finished['id'])
        self.assertEqual(sum(event['event_type'] == work_cells.RESULT for event in events), 1)
        before = copy.deepcopy(events)
        summaries = _event_summaries(events)
        snap = next(item for item in summaries if item['event_type'] == work_cells.SNAPSHOT)
        receipt = next(item for item in summaries if item['event_type'] == work_cells.RESULT)
        self.assertNotIn('content', snap['change']['snapshot']['files'][0])
        self.assertNotIn('stdout', receipt['change']['result']['execution'])
        self.assertEqual(events, before, 'Summary projection must not alter authoritative evidence')
        self.assertEqual(snap['hash'], finished['steps'][0]['result']['provenance']['snapshot_receipt'])
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_work_mode_cannot_advertise_or_execute_python_checks(self):
        request = {**self.parent['request'], 'request_id': str(uuid.uuid4()), 'mode': 'work'}
        called = []
        def adapter(messages, tools):
            self.assertNotIn(work_cells.TOOL, [item['name'] for item in tools])
            called.append(1)
            if len(called) == 1:
                return {'content': '', 'tool_calls': [{'function': {'name': work_cells.TOOL, 'arguments': self.args}}]}
            self.assertIn('rejected', messages[-1]['content'])
            return {'content': 'Select Code mode to run Python checks.'}
        with patch('foundry.execution_cell.run_snapshot', side_effect=AssertionError('Work mode invoked a cell')):
            finished = self.manager.run_work(request, adapter)
        self.assertFalse(finished['steps'][0]['succeeded'])
        self.assertFalse(any(event['event_type'] == work_cells.SNAPSHOT for event in self.store.work_events(finished['id'])))


if __name__ == '__main__':
    unittest.main()
