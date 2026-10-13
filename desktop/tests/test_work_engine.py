"""Outcome acceptance for typed work under the existing OM and CommitService."""
import copy
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_engine import AUTHORITY, validate_request
from foundry.work_provider import EmptyWorkResponse
from foundry.work_store import now


class WorkEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name) / 'project'; self.folder.mkdir()
        self.source = self.folder / 'report.txt'; self.source.write_text('Measured quantity: 24', encoding='utf-8')
        self.store = CommitService(Path(self.temp.name) / 'journal')
        self.manager = OrchestrationManager(self.store)
        self.request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()),
                        'mode': 'work', 'goal': 'Read the report and create a summary.', 'root': str(self.folder),
                        'provider': 'ollama', 'model': 'test-model', 'messages': [{'role': 'user', 'content': 'Read and summarize.'}]}

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    @staticmethod
    def call(name, arguments):
        return {'content': '', 'tool_calls': [{'function': {'name': name, 'arguments': arguments}}]}

    def test_reads_source_commits_deliverable_and_replays_without_model_execution(self):
        seen = []
        def adapter(messages, tools):
            seen.append(messages)
            self.assertIn('create_artifact', [tool['name'] for tool in tools])
            if len(seen) == 1:
                return self.call('read_file', {'path': 'report.txt'})
            if len(seen) == 2:
                self.assertIn('Measured quantity: 24', messages[-1]['content'])
                return self.call('create_artifact', {'name': 'summary.md', 'media_type': 'text/markdown', 'content': '# Result\nMeasured quantity: 24'})
            self.assertEqual(json.loads(messages[-1]['content'])['artifact_status'], 'committed')
            return {'content': 'Created summary.md from the source quantity of 24.'}
        events = []
        mission = self.manager.run_work(self.request, adapter, events.append)
        self.assertEqual(mission['status'], 'completed')
        self.assertEqual(len(mission['steps']), 2)
        self.assertEqual(mission['artifacts'][0]['status'], 'committed')
        self.assertEqual(self.source.read_text(), 'Measured quantity: 24')
        self.assertFalse((self.folder / 'summary.md').exists())
        self.assertEqual(self.store.list_conversations(), [])
        count = self.store.verify_integrity()['work_events']
        replay_events = []
        replay = self.manager.run_work(self.request, lambda *_: self.fail('Replayed completed model'), replay_events.append)
        self.assertEqual(replay['id'], mission['id'])
        self.assertFalse(any(event['type'] == 'model' for event in replay_events))
        self.assertEqual(self.store.verify_integrity()['work_events'], count)
        changed = {**self.request, 'goal': 'Different goal'}
        with self.assertRaisesRegex(ValueError, 'different input'):
            self.manager.run_work(changed, adapter)
        self.assertTrue(any(event.get('name') == 'read_file' for event in events))
        model_events = [event for event in events if event['type'] == 'model']
        self.assertEqual([(event['call_id'], event['status']) for event in model_events],
                         [(1, 'running'), (1, 'completed'), (2, 'running'), (2, 'completed'), (3, 'running'), (3, 'completed')])
        for event in model_events:
            self.assertEqual(set(event), {'type', 'mission_id', 'call_id', 'status', 'text'})
            self.assertEqual(event['mission_id'], mission['id'])
        self.assertNotIn('Measured quantity', json.dumps(model_events))

    def test_repository_mission_can_use_more_than_the_historical_twenty_steps(self):
        calls = []

        def adapter(_messages, _tools):
            calls.append(True)
            if len(calls) <= 40:
                return self.call('read_file', {'path': 'report.txt'})
            return {'content': f'Read the source {len(calls) - 1} times and retained the bounded result.'}

        mission = self.manager.run_work({**self.request, 'request_id': str(uuid.uuid4())}, adapter)
        self.assertEqual(mission['status'], 'completed')
        self.assertEqual(len(mission['steps']), 40)
        self.assertEqual(mission['authority']['max_steps'], 128)

    def test_model_lifecycle_brackets_actual_adapter_under_existing_lock(self):
        events = []
        def adapter(messages, _tools):
            self.assertIsNotNone(self.store._lock_file)
            self.assertEqual(events[-1]['type'], 'model')
            self.assertEqual(events[-1]['status'], 'running')
            self.assertEqual(events[-1]['call_id'], 1)
            self.assertEqual(self.store.get_work(events[-1]['mission_id'])['status'], 'running')
            self.assertEqual(self.store.work_events(events[-1]['mission_id'])[-1]['event_type'], 'work.started')
            return {'content': 'PUBLIC_ANSWER_NOT_TELEMETRY', 'thinking': 'PRIVATE_REASONING_NOT_TELEMETRY'}
        result = self.manager.run_work(self.request, adapter, events.append)
        model_events = [event for event in events if event['type'] == 'model']
        self.assertEqual([event['text'] for event in model_events], ['Waiting for model response', 'Model response received'])
        self.assertEqual(result['answer'], 'PUBLIC_ANSWER_NOT_TELEMETRY')
        self.assertNotIn('NOT_TELEMETRY', json.dumps(model_events))
        self.assertEqual([event['event_type'] for event in self.store.work_events(result['id'])],
                         ['work.submitted', 'work.started', 'work.completed'])

    def test_model_discovers_repository_tools_only_when_a_repository_is_selected(self):
        repository_tools = {'list_files', 'read_file', 'search_files', 'propose_edit'}
        for root in (None, str(self.folder)):
            with self.subTest(root=root):
                observed = []
                def adapter(_messages, catalog):
                    names = {entry['name'] for entry in catalog}
                    observed.append(names)
                    self.assertIn('create_artifact', names)
                    self.assertEqual(names & repository_tools, repository_tools if root else set())
                    return {'content': 'Observed the capabilities of this selected environment.'}
                result = self.manager.run_work({**self.request, 'request_id': str(uuid.uuid4()), 'root': root}, adapter)
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(len(observed), 1)
                self.assertEqual(result['steps'], [])
        self.assertEqual(self.source.read_text(), 'Measured quantity: 24')

    def test_model_observer_failure_cannot_change_real_tool_or_commit_outcomes(self):
        events = []
        def observer(event):
            events.append(event)
            if event['type'] == 'model':
                raise RuntimeError('Disconnected observer')
        responses = iter([self.call('create_artifact', {'name': 'kept.txt', 'media_type': 'text/plain', 'content': 'Retain actual output'}),
                          {'content': 'Actual output retained.'}])
        result = self.manager.run_work(self.request, lambda *_: next(responses), observer)
        self.assertEqual((result['status'], len(result['steps']), len(result['artifacts'])), ('completed', 1, 1))
        self.assertEqual(result['authority'], AUTHORITY)
        self.assertEqual([event['status'] for event in events if event['type'] == 'model'], ['running', 'completed'] * 2)
        self.assertEqual([event['event_type'] for event in self.store.work_events(result['id'])],
                         ['work.submitted', 'work.started', 'work.tool.completed', 'work.completed'])
        self.store.verify_integrity()

    def test_provider_and_empty_response_failures_emit_no_private_data_and_preserve_exception(self):
        private = 'PRIVATE_RESPONSE_OR_ERROR_DETAIL'
        failures = [OSError(private), EmptyWorkResponse({'done': True, 'done_reason': 'stop',
                    'message': {'content': '', 'thinking': private, 'tool_calls': []}})]
        for failure in failures:
            with self.subTest(error=type(failure).__name__):
                request = {**self.request, 'request_id': str(uuid.uuid4())}; events = []; calls = []
                def adapter(*_):
                    calls.append(True)
                    raise failure
                def observer(event):
                    events.append(event)
                    if event['type'] == 'model': raise RuntimeError('Observer cannot replace failure')
                with self.assertRaises(type(failure)) as caught:
                    self.manager.run_work(request, adapter, observer)
                self.assertIs(caught.exception, failure)
                model_events = [event for event in events if event['type'] == 'model']
                self.assertEqual([(event['call_id'], event['status']) for event in model_events], [(1, 'running'), (1, 'failed')])
                self.assertEqual(model_events[-1]['text'], 'Model request failed')
                self.assertNotIn(private, json.dumps(model_events)); self.assertEqual(len(calls), 1)
                mission = self.store.get_work_by_request(request['request_id'])
                self.assertEqual((mission['status'], mission['steps']), ('failed', []))
                self.assertEqual(self.store.work_events(mission['id'])[-1]['event_type'], 'work.failed')
                self.store.verify_integrity()

    def test_generated_candidate_calls_have_unique_ids_and_parent_step_without_source_or_inputs(self):
        # Real generated-tool continuation; deliberately invalid candidate source
        # is rejected before any execution cell can be invoked.
        contract = {'schema': 'yur.python-specialist-contract.v1', 'name': 'Telemetry fixture', 'description': 'Copy the integer value.',
                    'input_schema': {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'], 'additionalProperties': False},
                    'output_schema': {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'], 'additionalProperties': False},
                    'cases': [{'id': 'one', 'input': {'value': 1}, 'expected': {'value': 1}},
                              {'id': 'zero', 'input': {'value': 0}, 'expected': {'value': 0}},
                              {'id': 'negative', 'input': {'value': -1}, 'expected': {'value': -1}}]}
        target = self.folder / 'contract.json'; target.write_text(json.dumps(contract), encoding='utf-8')
        arguments = {'contract_path': 'contract.json', 'expected_sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
        events = []; outer_calls = []; candidate_calls = []
        def adapter(messages, catalog):
            self.assertIsNotNone(self.store._lock_file)
            if catalog[0]['name'] == 'submit_python_candidate':
                candidate_calls.append(messages)
                return self.call('submit_python_candidate', {'source': 'def run(: # PRIVATE_CANDIDATE_SOURCE'})
            outer_calls.append(messages)
            if len(outer_calls) == 1: return self.call('forge_python_specialist', arguments)
            return {'content': 'Both invalid candidates were rejected without execution.'}
        result = self.manager.run_work({**self.request, 'mode': 'code'}, adapter, events.append)
        self.assertEqual((len(outer_calls), len(candidate_calls)), (2, 2))
        self.assertEqual(result['steps'][0]['result']['status'], 'rejected')
        models = [event for event in events if event['type'] == 'model']
        self.assertEqual([(event['call_id'], event['status']) for event in models],
                         [(call_id, status) for call_id in range(1, 5) for status in ('running', 'completed')])
        for event in models:
            if event['call_id'] in (2, 3): self.assertEqual(event['step_id'], result['steps'][0]['id'])
            else: self.assertNotIn('step_id', event)
        self.assertNotIn('PRIVATE_CANDIDATE_SOURCE', json.dumps(models))
        self.assertNotIn('contract.json', json.dumps(models))
        self.assertFalse(any(event['event_type'] == 'work.generated.snapshot.committed' for event in self.store.work_events(result['id'])))
        self.store.verify_integrity()

    def test_edit_is_a_reviewable_proposal_and_cannot_write_source(self):
        sha = hashlib.sha256(self.source.read_bytes()).hexdigest()
        responses = iter([self.call('propose_edit', {'path': 'report.txt', 'content': 'Reviewed quantity: 24', 'expected_sha256': sha}), {'content': 'Edit proposed for review.'}])
        mission = self.manager.run_work(self.request, lambda *_: next(responses))
        artifact = mission['artifacts'][0]
        self.assertEqual(artifact['status'], 'proposed')
        self.assertIn('-Measured quantity: 24', artifact['proposal']['diff'])
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), sha)

    def test_denied_tool_path_is_recorded_without_reading_parent(self):
        responses = iter([self.call('read_file', {'path': '../outside.txt'}), self.call('shell', {'command': 'anything'}), {'content': 'Both actions were rejected.'}])
        mission = self.manager.run_work(self.request, lambda *_: next(responses))
        self.assertFalse(any(step['succeeded'] for step in mission['steps']))
        self.assertEqual(len(mission['steps']), 2)
        self.assertEqual(mission['artifacts'], [])

    def test_provider_failure_resume_preserves_completed_work(self):
        called = 0
        def failing(messages, tools):
            nonlocal called
            called += 1
            if called == 1: return self.call('read_file', {'path': 'report.txt'})
            raise OSError('Provider offline')
        with self.assertRaisesRegex(OSError, 'offline'):
            self.manager.run_work(self.request, failing)
        failed = self.store.list_work()[0]
        self.assertEqual((failed['status'], len(failed['steps'])), ('failed', 1))
        def resume(messages, tools):
            self.assertIn('Measured quantity: 24', messages[-1]['content'])
            return {'content': 'Recovered the committed read.'}
        result = self.manager.run_work(self.request, resume)
        self.assertEqual((result['status'], len(result['steps'])), ('completed', 1))

    def test_cancellation_before_acceptance_is_durable_and_prevents_execution(self):
        cancelled = self.manager.cancel_work_request(self.request)
        self.assertEqual(cancelled['status'], 'cancelled')
        result = self.manager.run_work(self.request, lambda *_: self.fail('Cancelled mission executed'))
        self.assertEqual(result['status'], 'cancelled')

    def test_cancel_during_provider_call_discards_response(self):
        def adapter(*_):
            self.manager.cancel_work(self.store.list_work()[0]['id'])
            return self.call('create_artifact', {'name': 'cancelled.md', 'media_type': 'text/markdown', 'content': 'Never commit this'})
        result = self.manager.run_work(self.request, adapter)
        self.assertEqual((result['status'], result['artifacts']), ('cancelled', []))

    def test_revision_authority_tamper_and_reopen_fail_closed(self):
        submitted = self.store.submit_work(validate_request(self.request), AUTHORITY)
        document = {key: value for key, value in submitted.items() if key != 'revision'}
        document.update(status='running', updated_at=now())
        self.store.commit_work(document, 1, 'work.started')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.store.commit_work(document, 1, 'work.started')
        altered = copy.deepcopy(document); altered['authority']['actions'].append('shell')
        with self.assertRaisesRegex(ValueError, 'authority'):
            self.store.commit_work(altered, 2, 'work.started')
        path, root = self.store.path, self.store.root
        self.store.close(); self.store = CommitService(root)
        self.assertEqual(self.store.get_work(submitted['id'])['revision'], 2)
        with closing(sqlite3.connect(path)) as raw, raw:
            raw.execute("UPDATE work_missions SET revision=99")
        with self.assertRaisesRegex(RuntimeError, 'state mismatch'):
            self.store.verify_integrity()

    def test_forged_authority_and_extra_request_keys_are_rejected_before_state(self):
        for request in ({**self.request, 'authority': AUTHORITY}, {**self.request, 'root': '..'}, {**self.request, 'mode': 'shell'}, {**self.request, 'provider': 'shell'}):
            with self.assertRaises((ValueError, OSError)):
                self.manager.run_work(request, lambda *_: self.fail('Invalid request reached provider'))
        self.assertEqual(self.store.list_work(), [])

    def test_historical_franklin_receipts_reopen_without_rewriting_authority_or_events(self):
        from foundry.work_store import LEGACY_FRANKLIN_AUTHORITY
        submitted = self.store.submit_work(validate_request(self.request), copy.deepcopy(LEGACY_FRANKLIN_AUTHORITY))
        document = {key: value for key, value in submitted.items() if key != 'revision'}
        for revision, status in ((1, 'running'), (2, 'completed')):
            document.update(status=status, updated_at=now())
            self.store.commit_work(document, revision, 'work.started' if status == 'running' else 'work.completed')
        before = [tuple(row) for row in self.store._db.execute('SELECT * FROM work_events ORDER BY id')]
        root = self.store.root
        self.store.close(); self.store = CommitService(root)
        self.assertEqual(self.store.verify_integrity()['work_events'], 3)
        self.assertEqual(self.store.get_work(submitted['id'])['authority'], LEGACY_FRANKLIN_AUTHORITY)
        self.assertEqual([tuple(row) for row in self.store._db.execute('SELECT * FROM work_events ORDER BY id')], before)
        self.assertNotIn('desktop.execute.confirmed', self.store.get_work(submitted['id'])['authority']['actions'])

    def test_historical_franklin_authority_cannot_upgrade_or_dispatch_current_host_actions(self):
        from foundry import work_desktop
        from foundry.work_store import LEGACY_FRANKLIN_AUTHORITY
        submitted = self.store.submit_work(validate_request(self.request), copy.deepcopy(LEGACY_FRANKLIN_AUTHORITY))
        document = {key: value for key, value in submitted.items() if key != 'revision'}
        document.update(status='running', updated_at=now(), authority=copy.deepcopy(work_desktop.AUTHORITY))
        with self.assertRaisesRegex(ValueError, 'Immutable work identity or authority'):
            self.store.commit_work(document, 1, 'work.started')
        with self.assertRaisesRegex(ValueError, 'explicit Franklin authority'):
            work_desktop.execute(self.manager, submitted, {'action': 'desktop_capabilities', 'payload': {}},
                                 lambda *_: self.fail('Historical authority dispatched a host action'))
        self.assertEqual(self.store.verify_integrity()['work_events'], 1)

    def test_current_franklin_creation_and_exact_legacy_shape_remain_bounded(self):
        from foundry import work_desktop
        from foundry.work_store import LEGACY_FRANKLIN_AUTHORITY
        mission = self.manager.run_work(self.request, lambda *_: {'content': 'Completed without a host action.'},
                                        execute_desktop=lambda *_: self.fail('Unexpected host action'))
        self.assertEqual(mission['authority'], work_desktop.AUTHORITY)
        invalid = [dict(LEGACY_FRANKLIN_AUTHORITY, scope='other'), dict(LEGACY_FRANKLIN_AUTHORITY, max_steps=21),
                   dict(LEGACY_FRANKLIN_AUTHORITY, actions=LEGACY_FRANKLIN_AUTHORITY['actions'][:-1]),
                   dict(LEGACY_FRANKLIN_AUTHORITY, actions=LEGACY_FRANKLIN_AUTHORITY['actions'] + ['shell']),
                   dict(LEGACY_FRANKLIN_AUTHORITY, extra=True)]
        for authority in invalid:
            with self.subTest(authority=authority), self.assertRaisesRegex(ValueError, 'authority'):
                self.store.submit_work({**validate_request(self.request), 'request_id': str(uuid.uuid4())}, authority)
        self.assertEqual(len(self.store.list_work()), 1)


if __name__ == '__main__':
    unittest.main()
