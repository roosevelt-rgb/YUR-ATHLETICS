"""Franklin restart/authority acceptance using fake models and temporary state."""
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.franklin_cli import compile_request, create_host_executor, handle, validate_rpc
from foundry.franklin_store import MAX_ENVIRONMENT, MAX_SNAPSHOT_BYTES
from foundry.orchestration import OrchestrationManager
from foundry.work_desktop import AUTHORITY, HOST_AUTHORITY, execute, validate_arguments
from foundry.work_store import digest, now


class FranklinTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'journal'
        self.store = CommitService(self.root)
        self.store.franklin_configure({'model': 'ollama:fixture-model', 'open': True, 'draft': 'retained draft'})
        self.environment = {'schema': 'yur.franklin.environment.v1', 'navigation': {'active_view': 'conversation'},
                            'authority': deepcopy(HOST_AUTHORITY)}

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def request(self, text='Remember that the project color is amber.', identity=None):
        return {'command': 'send', 'text': text, 'request_id': identity or str(uuid.uuid4()), 'environment': deepcopy(self.environment)}

    def send(self, request=None, adapter=None, host=None):
        return handle(request or self.request(), store=self.store,
                      model_adapter=adapter or (lambda messages, tools: {'content': 'The project color is amber.'}),
                      execute_desktop=host or (lambda action, payload, metadata: {'active_view': 'media'}))

    def running(self, request=None):
        request = request or self.request()
        admission = self.store.franklin_accept(request['request_id'], request['text'], request['environment'])
        mission = self.store.submit_work(compile_request(admission['request']), AUTHORITY)
        self.store.franklin_bind(request['request_id'], mission['id'])
        revision = mission.pop('revision')
        mission.update(status='running', updated_at=now())
        return self.store.commit_work(mission, revision, 'work.started'), request

    @staticmethod
    def tool(action='open_view', payload=None):
        return {'content': '', 'tool_calls': [{'function': {'name': 'desktop_action', 'arguments': {
            'action': action, 'payload': {'view': 'media'} if payload is None else payload}}}]}

    def test_catalog_and_media_draft_contract_rejects_untyped_mutation_and_root_injection(self):
        allowed = [('media_catalog', {}), ('media_list', {'limit': 20}), ('media_inspect', {'job_id': 'a' * 32}),
                   ('media_status', {}), ('workforce_catalog', {'query': 'quantity'}),
                   ('workforce_profile', {'code': 'hatch_quantity', 'expected_sha256': 'a' * 64}), ('model_catalog', {}),
                   ('desktop_capabilities', {}), ('coding_catalog', {})]
        for action, payload in allowed:
            self.assertEqual(validate_arguments({'action': action, 'payload': payload})['action'], action)
        denied = [('media_submit', {}), ('media_cancel', {}), ('media_catalog', {'endpoint': 'https://example.com'}),
                  ('media_list', {'limit': True}), ('media_list', {'limit': 51}), ('workforce_catalog', {'root': 'C:/private'}),
                  ('workforce_profile', {'code': 'hatch_quantity', 'expected_sha256': 'bad'}), ('model_catalog', {'model': 'other'}),
                  ('media_draft', {'preset': 'flux-klein-image-v1', 'prompt': 'Garden', 'request_id': str(uuid.uuid4())}),
                  ('media_draft', {'preset': 'wan22-video-v1', 'prompt': 'Garden'})]
        for action, payload in denied:
            with self.subTest(action=action, payload=payload), self.assertRaises(ValueError):
                validate_arguments({'action': action, 'payload': payload})

    def test_media_draft_is_committed_before_host_and_completed_replay_never_reprepares(self):
        calls = []
        mission, request = self.running()
        args = {'action': 'media_draft', 'payload': {'preset': 'flux-klein-image-v1', 'prompt': 'A pool garden'}}

        def host(action, payload, metadata):
            with CommitService(self.root) as reader:
                current = reader.franklin_snapshot()
                self.assertEqual(current['requests'][-1]['id'], request['request_id'])
            self.assertEqual(payload['width'], 1024)
            self.assertNotIn('request_id', payload)
            calls.append(metadata)
            return {'prepared': True, 'submitted': False, 'requires_operator_review': True}

        first = execute(OrchestrationManager(self.store), mission, args, host)
        self.assertEqual(first['status'], 'completed')
        replay = execute(OrchestrationManager(self.store), mission, args, lambda *a: self.fail('draft repeated'))
        self.assertTrue(replay['replayed'])
        self.assertFalse(replay['result']['submitted'])
        self.assertEqual(len(calls), 1)
        self.assertTrue(self.store.verify_integrity()['ok'])

    def test_tool_loop_observes_catalog_receipt_before_continuing(self):
        turns = iter([self.tool('model_catalog', {}), {'content': 'The configured fixture model is available.'}])
        calls = []
        result = self.send(adapter=lambda *a: next(turns), host=lambda action, payload, metadata:
                           calls.append((action, payload, metadata)) or {'models': [{'id': 'ollama:fixture-model', 'label': 'Fixture'}]})
        self.assertEqual(result['requests'][-1]['status'], 'completed')
        self.assertEqual(calls[0][0], 'model_catalog')
        self.assertRegex(calls[0][2]['action_id'], r'^[a-f0-9]{32}$')
        self.assertTrue(self.store.verify_integrity()['ok'])

    def test_restart_replay_retains_preferences_and_never_calls_model(self):
        request = self.request()
        result = self.send(request)
        self.assertEqual(result['requests'][-1]['status'], 'completed')
        self.assertEqual(result['messages'][-1]['content'], 'The project color is amber.')
        self.store.close(); self.store = CommitService(self.root)
        with patch('foundry.franklin_cli.model_adapter_for', side_effect=AssertionError('replay called provider')):
            result = handle(request, store=self.store, execute_desktop=lambda *args: self.fail('replay called host'))
        self.assertEqual(result['preferences'], {'model': 'ollama:fixture-model', 'open': True, 'draft': 'retained draft'})
        self.assertEqual(len(self.store.list_work()), 1)
        self.assertEqual(len(result['messages']), 2)
        self.assertTrue(self.store.verify_integrity()['ok'])
        self.store.franklin_configure({'model': ''})
        with patch.dict('os.environ', {}, clear=True):
            self.send(request, lambda *args: self.fail('replay depends on current model configuration'))

    def test_recalled_context_reaches_actual_model_and_has_receipt_digest(self):
        self.send()
        captured = []
        def adapter(messages, catalog):
            captured.extend(messages)
            self.assertIn('desktop_action', [item['name'] for item in catalog])
            return {'content': 'Continuing the amber project.'}
        request = self.request('What color did we choose?')
        self.send(request, adapter)
        self.assertTrue(any('The project color is amber.' == message['content'] for message in captured))
        self.assertEqual(captured[-1]['content'], request['text'])
        accepted = self.store.franklin_get_request(request['request_id'])
        self.assertEqual(accepted['context_sha256'], digest(accepted['context']))
        self.assertEqual(len(accepted['context']), 2)
        self.assertIsNone(self.store.get_work_by_request(request['request_id'])['request']['root'])

    def test_changed_text_same_request_is_rejected_and_environment_does_not_rerun(self):
        request = self.request(); self.send(request)
        changed = {**request, 'text': 'A different instruction'}
        with self.assertRaisesRegex(ValueError, 'different input'):
            self.send(changed)
        request['environment']['navigation'] = {'active_view': 'browser'}
        self.send(request, lambda *args: self.fail('snapshot changes cannot replay inference'))

    def test_patch_cas_unknown_fields_and_tamper_detection(self):
        before = self.store.franklin_snapshot()
        self.store.franklin_configure({'open': False}, expected_revision=before['revision'])
        self.assertEqual(self.store.franklin_snapshot()['preferences']['draft'], 'retained draft')
        with self.assertRaisesRegex(ValueError, 'revision'):
            self.store.franklin_configure({'draft': 'stale'}, expected_revision=before['revision'])
        with self.assertRaises(ValueError):
            self.store.franklin_configure({'endpoint': 'https://untrusted.example'})
        self.store._db.execute("UPDATE franklin_documents SET document=replace(document,'retained draft','altered draft') WHERE kind='preferences'")
        with self.assertRaisesRegex(RuntimeError, 'Franklin'):
            self.store.verify_integrity()

    def test_cancel_before_submission_cancels_later_bound_mission(self):
        request = self.request()
        admission = self.store.franklin_accept(request['request_id'], request['text'], request['environment'])
        self.store.franklin_cancel(request['request_id'])
        mission = self.store.submit_work(compile_request(admission['request']), AUTHORITY)
        self.store.franklin_bind(request['request_id'], mission['id'])
        self.assertEqual(self.store.get_work(mission['id'])['status'], 'cancelled')
        self.assertEqual(self.store.franklin_get_request(request['request_id'])['status'], 'cancelled')

    def test_cancel_during_model_call_cannot_commit_answer(self):
        request = self.request()
        def adapter(messages, tools):
            with CommitService(self.root) as other:
                other.franklin_cancel(request['request_id'])
            return {'content': 'This late answer must not win.'}
        result = self.send(request, adapter)
        self.assertEqual(result['requests'][-1]['status'], 'cancelled')
        self.assertNotIn('This late answer must not win.', [message['content'] for message in result['messages']])
        self.assertEqual(self.store.get_work_by_request(request['request_id'])['status'], 'cancelled')

    def test_host_intent_precedes_callback_and_result_precedes_next_model(self):
        calls = []
        def host(action, payload, metadata):
            with CommitService(self.root) as reader:
                doc, _ = reader._franklin_get('action', metadata['action_id'])
                self.assertEqual(doc['status'], 'pending')
                self.assertEqual(doc['payload'], {'view': 'media'})
            calls.append(metadata)
            return {'active_view': 'media'}
        turn = iter([self.tool(), {'content': 'Opened the media view.'}])
        result = self.send(adapter=lambda *args: next(turn), host=host)
        self.assertEqual(result['requests'][-1]['status'], 'completed')
        self.assertEqual(len(calls), 1)
        action, _ = self.store._franklin_get('action', calls[0]['action_id'])
        self.assertEqual(action['status'], 'completed')
        work = self.store.get_work(calls[0]['mission_id'])
        self.assertEqual(work['steps'][0]['result']['receipt']['event_type'], 'franklin.action.completed')
        self.assertTrue(any(event['summary'] == 'Desktop open view: completed' for event in result['events']))

    def test_uncertain_host_result_is_retained_and_matching_action_cannot_repeat(self):
        calls = []
        def host(*args):
            calls.append(args)
            raise RuntimeError('A PRIVATE RESPONSE BODY that must not escape')
        turn = iter([self.tool(), self.tool(), {'content': 'The host outcome is uncertain.'}])
        result = self.send(adapter=lambda *args: next(turn), host=host)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('PRIVATE RESPONSE', json.dumps(result))
        work = self.store.get_work_by_request(result['requests'][-1]['id'])
        self.assertEqual(work['steps'][0]['result']['status'], 'uncertain')
        self.assertFalse(work['steps'][1]['succeeded'])

    def test_recovery_marks_unanswered_action_uncertain_and_never_reissues(self):
        mission, request = self.running()
        action_id = digest({'mission_id': mission['id'], 'step_index': 0, 'tool': 'desktop_action'})[:32]
        self.store.franklin_action_begin(mission['id'], request['request_id'], action_id, 'open_view', {'view': 'media'})
        self.store.close(); self.store = CommitService(self.root)
        result = self.store.franklin_recover()
        self.assertEqual(result['requests'][-1]['status'], 'interrupted')
        self.assertEqual(self.store._franklin_get('action', action_id)[0]['status'], 'uncertain')
        self.assertEqual(self.store.get_work(mission['id'])['status'], 'cancelled')
        self.send(request, lambda *args: self.fail('interrupted replay invoked model'), lambda *args: self.fail('interrupted replay invoked host'))

    def test_recovery_preserves_completed_mission_without_duplicate_answer(self):
        mission, request = self.running()
        with self.store.acquire_worker():
            self.store.complete_work_unsteered(mission['id'], mission['revision'], 'Committed before crash.')
        result = self.store.franklin_recover()
        self.assertEqual(result['requests'][-1]['status'], 'completed')
        self.assertEqual(result['messages'][-1]['content'], 'Committed before crash.')
        self.store.franklin_recover()
        self.assertEqual(len(self.store.franklin_snapshot()['messages']), 2)

    def test_authority_and_payload_limits_reject_unbound_actions(self):
        for arguments in [
            {'action': 'execute_script', 'payload': {}},
            {'action': 'open_view', 'payload': {'view': 'admin', 'script': 'attack'}},
            {'action': 'browser_read', 'payload': {'url': 'https://example.com'}},
            {'action': 'browser_navigate', 'payload': {'url': 'file:///private'}},
            {'action': 'browser_navigate', 'payload': {'url': 'http://192.168.1.1/'}},
        ]:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                validate_arguments(arguments)
        request = self.request(); request['environment']['authority']['actions'].append('execute_script')
        with self.assertRaises(ValueError):
            validate_rpc(request)
        request = self.request(); request['environment']['data'] = 'x' * MAX_ENVIRONMENT
        with self.assertRaises(ValueError):
            validate_rpc(request)
        mission, _ = self.running()
        mission['authority'] = {**mission['authority'], 'scope': 'work-proposals'}
        with self.assertRaises(ValueError):
            execute(OrchestrationManager(self.store), mission, {'action': 'snapshot', 'payload': {}}, lambda *args: self.fail('unauthorized'))

    def test_protocol_requires_matching_bounded_host_reply(self):
        metadata = {'action_id': 'a' * 32, 'mission_id': 'b' * 32, 'request_id': str(uuid.uuid4())}
        frames = []
        stream = io.BytesIO((json.dumps({'type': 'host_result', 'id': metadata['action_id'], 'result': {'ok': True}}) + '\n').encode())
        result = create_host_executor(stream, frames.append)('snapshot', {}, metadata)
        self.assertEqual(result, {'ok': True})
        self.assertEqual(frames[0]['type'], 'host_action')
        wrong = io.BytesIO(b'{"type":"host_result","id":"wrong","result":{}}\n')
        with self.assertRaises(ValueError):
            create_host_executor(wrong, frames.append)('snapshot', {}, metadata)

    def test_model_provider_failure_is_publicly_bounded(self):
        result = self.send(adapter=lambda *args: (_ for _ in ()).throw(RuntimeError('PRIVATE HTTP body')))
        self.assertEqual(result['requests'][-1]['status'], 'failed')
        self.assertNotIn('PRIVATE HTTP', json.dumps(result))

    def test_only_one_active_request_and_recall_stays_bounded(self):
        for index in range(9):
            request = self.request(str(index) + 'x' * 3000)
            self.store.franklin_accept(request['request_id'], request['text'], request['environment'])
            self.store.franklin_finish(request['request_id'], 'completed', 'y' * 3000)
        request = self.request('Continue')
        accepted = self.store.franklin_accept(request['request_id'], request['text'], request['environment'])['request']
        self.assertLessEqual(len(accepted['context']), 12)
        self.assertLessEqual(sum(len(item['content']) for item in accepted['context']), 12000)
        with self.assertRaisesRegex(ValueError, 'active request'):
            self.store.franklin_accept(str(uuid.uuid4()), 'Concurrent turn', self.environment)

    def test_snapshot_reserves_frame_space_and_keeps_replay_records(self):
        # Exercise the projection directly so this boundary check does not grow
        # a large journal just to reproduce a response-size condition.
        template = self.store.franklin_accept(str(uuid.uuid4()), 'Initial', self.environment)['request']
        requests = [{**template, 'id': str(uuid.uuid4()), 'status': 'completed',
                     'text': 'user text ' * 3000, 'summary': 'final text ' * 3000} for _ in range(100)]
        self.store.franklin_configure({'draft': '稿' * 32000})
        with patch.object(self.store, '_franklin_requests', return_value=requests):
            snapshot = self.store.franklin_snapshot()
        raw = json.dumps({'type': 'result', 'response': {'ok': True, 'result': snapshot}}, ensure_ascii=False).encode('utf-8')
        self.assertLess(len(raw), 1024 * 1024)
        self.assertLessEqual(len(json.dumps(snapshot, ensure_ascii=False).encode()), MAX_SNAPSHOT_BYTES)
        self.assertTrue(snapshot['history_truncated'])
        self.assertEqual(len(snapshot['requests']), 100)
        self.assertEqual(snapshot['messages'][-1]['request_id'], requests[-1]['id'])
        self.assertEqual(self.store.franklin_get_request(template['id'])['text'], 'Initial')

    def test_recovery_cannot_cancel_a_live_worker_or_repeat_a_pending_action(self):
        mission, request = self.running()
        with self.store.acquire_worker():
            with CommitService(self.root) as other:
                with self.assertRaisesRegex(RuntimeError, 'exclusive worker lock'):
                    other.franklin_recover()
            self.assertEqual(self.store.get_work(mission['id'])['status'], 'running')
            self.assertEqual(self.store.franklin_get_request(request['request_id'])['status'], 'running')
        self.assertEqual(self.store.franklin_recover()['requests'][-1]['status'], 'interrupted')

    def test_bare_trusted_endpoint_model_fallback_selects_openai_adapter(self):
        self.store.franklin_configure({'model': ''})
        request = self.request()
        observed = []
        def factory(work_request):
            observed.append(work_request)
            return lambda *args: {'content': 'Endpoint fixture only.'}
        with patch.dict('os.environ', {'YUR_FRANKLIN_OPENAI_URL': 'https://fixture.example/v1', 'YUR_FRANKLIN_MODEL': 'fixture-model'}, clear=True), patch('foundry.franklin_cli.model_adapter_for', side_effect=factory):
            result = handle(request, store=self.store, execute_desktop=lambda *args: {})
        self.assertEqual(observed[0]['provider'], 'openai-compatible')
        self.assertEqual(observed[0]['model'], 'fixture-model')
        self.assertEqual(result['preferences']['model'], 'openai:fixture-model')
        self.assertEqual(result['requests'][-1]['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
