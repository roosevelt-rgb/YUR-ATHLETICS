"""Franklin execution contracts and receipt ordering; no model or native launch."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from foundry.commit_service import CommitService
from foundry.franklin_cli import compile_request, handle, validate_rpc
from foundry.orchestration import OrchestrationManager
from foundry.work_desktop import ACTIONS, AUTHORITY, HOST_AUTHORITY, catalog, execute, validate_arguments
from foundry.work_store import now


SESSION = 'native:rc6.session-01'
MEDIA_REQUEST = {'preset': 'flux-klein-image-v1', 'prompt': 'A planted courtyard'}
WORKFORCE_REQUEST = {'code': 'hatch_quantity', 'expected_sha256': 'a' * 64,
                     'input': {'plans_text': 'Bounded synthetic plan text', 'specs_text': ''}}
FORGE_REQUEST = {'agent_type': 'Estimator', 'capabilities': ['Read assigned quantities'], 'industry': 'Construction',
                 'name': '', 'description': 'Bounded candidate\nSynthetic acceptance fixture', 'team': False, 'provider': 'ollama', 'model': ''}


def desktop(action, payload=None):
    return {'action': action, 'payload': {} if payload is None else payload}


def tool(name, arguments):
    return {'content': '', 'tool_calls': [{'function': {'name': name, 'arguments': arguments}}]}


class FranklinExecutionContractTests(unittest.TestCase):
    def test_admitted_coding_and_media_shapes(self):
        allowed = [
            desktop('desktop_capabilities'), desktop('coding_catalog'),
            desktop('coding_start', {'runtime_key': 'rc6', 'workspace': 'D:/Selected Project', 'model': 'fixture-model'}),
            desktop('coding_start', {'runtime_key': 'construction-v1', 'workspace': 'D:/Selected Project', 'model': 'openai:fixture'}),
            desktop('coding_submit', {'session_id': SESSION, 'text': 'Build the bounded component.\nRun the assigned checks.', 'role': 'Implementation worker'}),
            desktop('coding_submit', {'session_id': SESSION, 'text': 'x' * 64000}),
            desktop('coding_status', {'session_id': SESSION}), desktop('coding_cancel', {'session_id': SESSION}),
            desktop('coding_wait', {'session_id': SESSION}), desktop('coding_wait', {'session_id': SESSION, 'timeout_ms': 25000}),
            desktop('media_submit', MEDIA_REQUEST), desktop('media_cancel', {'job_id': 'a' * 32}),
            desktop('media_resume', {'job_id': 'b' * 32}), desktop('media_import'),
            desktop('media_export', {'asset_id': 'c' * 64}),
        ]
        for arguments in allowed:
            with self.subTest(arguments=arguments['action']):
                self.assertEqual(validate_arguments(arguments)['action'], arguments['action'])
        submitted = validate_arguments(desktop('media_submit', MEDIA_REQUEST))['payload']
        self.assertEqual(submitted, validate_arguments(desktop('media_draft', MEDIA_REQUEST))['payload'])
        self.assertEqual(submitted['width'], 1024)
        self.assertNotIn('request_id', submitted)
        video = validate_arguments(desktop('media_submit', {'preset': 'wan22-video-v1', 'prompt': 'Moving water', 'input_asset_id': 'd' * 64}))
        self.assertEqual(video['payload']['frames'], 49)

    def test_execution_rejects_payload_authority_and_identity_injection(self):
        start = {'runtime_key': 'rc6', 'workspace': 'D:/Selected', 'model': 'fixture'}
        submit = {'session_id': SESSION, 'text': 'Build the assigned module.'}
        denied = [
            desktop('desktop_capabilities', {'root': 'D:/Other'}),
            desktop('coding_catalog', {'endpoint': 'https://example.com'}),
            desktop('coding_start', {**start, 'runtime_key': 'construction-master'}),
            desktop('coding_start', {**start, 'runtime_key': []}),
            desktop('coding_start', {**start, 'workspace': ''}),
            desktop('coding_start', {**start, 'workspace': 'a' * 4097}),
            desktop('coding_start', {**start, 'workspace': 'D:/Project\nOther'}),
            desktop('coding_start', {**start, 'model': 'not a catalog id'}),
            desktop('coding_start', {**start, 'model': 'a' * 201}),
            desktop('coding_start', {**start, 'permissions': ['*']}),
            desktop('coding_submit', {**submit, 'approve': True}),
            desktop('coding_submit', {**submit, 'authority': AUTHORITY}),
            desktop('coding_submit', {**submit, 'session_id': '../different-session'}),
            desktop('coding_submit', {**submit, 'session_id': 'a' * 201}),
            desktop('coding_submit', {**submit, 'text': ' ' * 10}),
            desktop('coding_submit', {**submit, 'text': 'x' * 64001}),
            desktop('coding_submit', {**submit, 'text': '\x00'}),
            desktop('coding_submit', {**submit, 'text': '\U0001f600' * 20000}),
            desktop('coding_submit', {**submit, 'role': 'x' * 101}),
            desktop('coding_submit', {**submit, 'role': 'worker\npermissions: all'}),
            desktop('coding_status', {'session_id': SESSION, 'text': 'unexpected'}),
            desktop('coding_wait', {'session_id': SESSION, 'timeout_ms': True}),
            desktop('coding_wait', {'session_id': SESSION, 'timeout_ms': 0}),
            desktop('coding_wait', {'session_id': SESSION, 'timeout_ms': 25001}),
            desktop('coding_approve', {'session_id': SESSION}),
            desktop('media_submit', {**MEDIA_REQUEST, 'request_id': str(uuid.uuid4())}),
            desktop('media_submit', {**MEDIA_REQUEST, 'endpoint': 'https://example.com'}),
            desktop('media_submit', {**MEDIA_REQUEST, 'preset': []}),
            desktop('media_submit', {'preset': 'wan22-video-v1', 'prompt': 'Missing image'}),
            desktop('media_cancel', {'job_id': '../job'}),
            desktop('media_resume', {'job_id': 'A' * 32}),
            desktop('media_import', {'path': 'D:/private.png'}),
            desktop('media_export', {'asset_id': 'c' * 64, 'path': 'D:/export.png'}),
            desktop('media_export', {'asset_id': 'c' * 32}),
        ]
        for arguments in denied:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                validate_arguments(arguments)

    def test_catalog_and_host_envelope_agree_and_native_approvals_are_not_tools(self):
        registered = catalog()[0]
        self.assertEqual(registered['input_schema']['properties']['action']['enum'], list(ACTIONS))
        self.assertEqual(HOST_AUTHORITY['actions'], list(ACTIONS))
        self.assertEqual(HOST_AUTHORITY['scope'], 'desktop-mission-execution-v1')
        self.assertEqual(AUTHORITY['scope'], 'franklin-desktop-work')
        self.assertEqual(registered['limits']['coding_argument_bytes'], 64 * 1024)
        self.assertFalse(any('approv' in name for name in ACTIONS))

    def test_workforce_and_marketplace_use_exact_existing_surface_contracts(self):
        allowed = [desktop('workforce_run', WORKFORCE_REQUEST),
                   desktop('workforce_result', {'mission_id': 'b' * 32, 'run_id': 'c' * 32}),
                   desktop('marketplace_inventory'), desktop('marketplace_packs'),
                   desktop('marketplace_pack', {'pack_id': 'pack:fixture-v1.0'}), desktop('marketplace_forge', FORGE_REQUEST)]
        for arguments in allowed:
            with self.subTest(action=arguments['action']):
                self.assertEqual(validate_arguments(arguments), arguments)
        denied = [desktop('workforce_run', {**WORKFORCE_REQUEST, 'code': 'unbound_profile'}),
                  desktop('workforce_run', {**WORKFORCE_REQUEST, 'expected_sha256': 'stale'}),
                  desktop('workforce_run', {**WORKFORCE_REQUEST, 'request_id': str(uuid.uuid4())}),
                  desktop('workforce_run', {**WORKFORCE_REQUEST, 'input': {'plans_text': 'Missing required field'}}),
                  desktop('workforce_run', {**WORKFORCE_REQUEST, 'input': {'plans_text': '', 'specs_text': ' '}}),
                  desktop('workforce_run', {**WORKFORCE_REQUEST, 'input': {'plans_text': 'x' * 30001, 'specs_text': ''}}),
                  desktop('workforce_run', {**WORKFORCE_REQUEST, 'input': {'plans_text': '\u7a3f' * 22000, 'specs_text': ''}}),
                  desktop('workforce_run', {**WORKFORCE_REQUEST, 'input': {'plans_text': 'text', 'specs_text': '\x00'}}),
                  desktop('workforce_result', {'mission_id': 'b' * 32, 'run_id': '../run'}),
                  desktop('marketplace_pack', {'pack_id': '../pack'}),
                  desktop('marketplace_inventory', {'directory': 'D:/private'}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'permissions': ['*']}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'agent_type': ' '}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'industry': 'x' * 81}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'capabilities': 'not an array'}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'capabilities': ['bounded'] * 33}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'capabilities': [' ']}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'capabilities': ['a\nrole']}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'model': 'model\nother'}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'description': '\x00'}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'team': 1}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'provider': 'unconfigured'}),
                  desktop('marketplace_forge', {**FORGE_REQUEST, 'capabilities': ['\u7a3f' * 200] * 32}),
                  desktop('marketplace_deploy', {'pack_id': 'fixture'}), desktop('workflow_execute')]
        for arguments in denied:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                validate_arguments(arguments)


class FranklinExecutionReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'journal'
        self.store = CommitService(self.root)
        self.store.franklin_configure({'model': 'ollama:fixture-model'})
        self.environment = {'schema': 'yur.franklin.environment.v1', 'authority': deepcopy(HOST_AUTHORITY)}

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def request(self, text='Build and verify the requested project.'):
        return {'command': 'send', 'text': text, 'request_id': str(uuid.uuid4()), 'environment': deepcopy(self.environment)}

    def running(self):
        request = self.request()
        accepted = self.store.franklin_accept(request['request_id'], request['text'], request['environment'])
        mission = self.store.submit_work(compile_request(accepted['request']), AUTHORITY)
        self.store.franklin_bind(request['request_id'], mission['id'])
        revision = mission.pop('revision')
        mission.update(status='running', updated_at=now())
        return self.store.commit_work(mission, revision, 'work.started'), request

    def test_concrete_plan_and_native_result_are_committed_before_continuation(self):
        plan = {'deliverables': ['bounded module'], 'roles': [{'name': 'Builder', 'owns': ['module.py']}],
                'acceptance': ['assigned checks pass'], 'unverified': ['public deployment']}
        calls = [tool('create_artifact', {'name': 'mission-plan.json', 'media_type': 'application/json', 'content': json.dumps(plan)}),
                 tool('desktop_action', desktop('desktop_capabilities')),
                 tool('desktop_action', desktop('coding_catalog')),
                 tool('desktop_action', desktop('coding_start', {'runtime_key': 'rc6', 'workspace': 'D:/Selected', 'model': 'fixture-model'})),
                 tool('desktop_action', desktop('coding_submit', {'session_id': SESSION, 'text': 'Implement module.py and report the assigned checks.', 'role': 'Builder'})),
                 tool('desktop_action', desktop('coding_wait', {'session_id': SESSION, 'timeout_ms': 25000})),
                 {'content': 'The native worker reports that the assigned checks passed. Public deployment remains unverified.'}]
        turns = iter(calls)
        observed = []

        def host(action, payload, metadata):
            with CommitService(self.root) as reader:
                receipt, _ = reader._franklin_get('action', metadata['action_id'])
                self.assertEqual(receipt['status'], 'pending')
                self.assertEqual(receipt['payload'], payload)
            observed.append(metadata['action_id'])
            return {'binding': 'fixture', 'session_id': SESSION, 'status': 'completed', 'checks': 'passed', 'deployed': False}

        def adapter(messages, tools):
            if observed:
                self.assertEqual(self.store._franklin_get('action', observed[-1])[0]['status'], 'completed')
            return next(turns)

        request = self.request()
        result = handle(request, store=self.store, model_adapter=adapter, execute_desktop=host)
        self.assertEqual(result['requests'][-1]['status'], 'completed')
        work = self.store.get_work_by_request(request['request_id'])
        self.assertIsNone(work['request']['root'])
        self.assertEqual(work['request']['mode'], 'work')
        self.assertEqual(len(work['artifacts']), 1)
        self.assertEqual(work['artifacts'][0]['status'], 'committed')
        self.assertEqual(len(observed), 5)
        self.assertTrue(all(step['succeeded'] for step in work['steps']))
        self.assertTrue(self.store.verify_integrity()['ok'])

    def test_coding_completed_replay_does_not_resubmit_or_change_payload(self):
        mission, _ = self.running()
        args = desktop('coding_submit', {'session_id': SESSION, 'text': 'Build only the owned module.', 'role': 'Builder'})
        observed = []

        def host(action, payload, metadata):
            observed.append((action, deepcopy(payload)))
            payload['text'] = 'host copy changed'
            return {'submitted': True, 'session_id': SESSION}

        first = execute(OrchestrationManager(self.store), mission, args, host)
        replay = execute(OrchestrationManager(self.store), mission, args, lambda *a: self.fail('native request was submitted twice'))
        self.assertEqual(first['status'], 'completed')
        self.assertTrue(replay['replayed'])
        self.assertEqual(len(observed), 1)
        self.assertEqual(args['payload']['text'], 'Build only the owned module.')
        with self.assertRaisesRegex(ValueError, 'another intent'):
            execute(OrchestrationManager(self.store), mission, desktop('coding_submit', {'session_id': SESSION, 'text': 'Changed'}), host)
        self.assertTrue(self.store.verify_integrity()['ok'])

    def test_uncertain_media_mutation_is_not_retried_at_a_later_model_step(self):
        turns = iter([tool('desktop_action', desktop('media_submit', MEDIA_REQUEST)),
                      tool('desktop_action', desktop('media_submit', MEDIA_REQUEST)),
                      {'content': 'Media submission is uncertain; inspect its receipt.'}])
        observed = []

        def host(*args):
            observed.append(args)
            raise RuntimeError('PRIVATE provider response')

        request = self.request('Generate the requested image.')
        result = handle(request, store=self.store, model_adapter=lambda *a: next(turns), execute_desktop=host)
        work = self.store.get_work_by_request(request['request_id'])
        self.assertEqual(len(observed), 1)
        self.assertEqual(work['steps'][0]['result']['status'], 'uncertain')
        self.assertFalse(work['steps'][1]['succeeded'])
        self.assertNotIn('PRIVATE provider response', json.dumps(result))
        self.assertTrue(self.store.verify_integrity()['ok'])

    def test_failed_native_action_has_no_automatic_replay(self):
        mission, _ = self.running()
        arguments = desktop('coding_submit', {'session_id': SESSION, 'text': 'Build the bounded module.'})
        first = execute(OrchestrationManager(self.store), mission, arguments, lambda *a: {'status': 'rejected', 'error': 'Human declined confirmation'})
        self.assertEqual(first['status'], 'failed')
        with self.assertRaisesRegex(ValueError, 'will not be repeated'):
            execute(OrchestrationManager(self.store), mission, arguments, lambda *a: self.fail('rejected action repeated'))

    def test_compile_guidance_and_caller_data_cannot_expand_native_authority(self):
        request = self.request()
        accepted = self.store.franklin_accept(request['request_id'], request['text'], request['environment'])['request']
        compiled = compile_request(accepted)
        self.assertIsNone(compiled['root'])
        self.assertEqual(compiled['mode'], 'work')
        instruction = compiled['messages'][0]['content']
        for phrase in ('create_artifact', 'coding_start', 'coding_submit', 'coding_wait', 'media_submit',
                       'human decisions', '128-step budget', 'public deployment', 'uncertain mutation'):
            self.assertIn(phrase, instruction)
        for field, value in [('root', 'D:/Other'), ('permissions', ['*']), ('authority', AUTHORITY)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_rpc({**request, field: value})
        modified = deepcopy(request)
        modified['environment']['authority']['actions'].append('native_approve')
        with self.assertRaises(ValueError):
            validate_rpc(modified)


if __name__ == '__main__':
    unittest.main()
