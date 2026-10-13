"""Actual Work, factory packages and persistent concept clocks across missions."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry import work_concepts


def current(results):
    return next(result['concept'] for result in reversed(results) if 'concept' in result)


def change(results):
    concept = current(results)
    return {'concept_id': concept['id'], 'expected_revision': concept['revision']}


class WorkConceptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = CommitService(Path(self.temp.name) / 'journal'); self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        self.request = self.request_for('Develop a continuing concept with evidence; do not deploy.')

    @staticmethod
    def request_for(goal):
        return {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'work',
                'goal': goal, 'root': None, 'provider': 'ollama', 'model': 'fixture',
                'messages': [{'role': 'user', 'content': goal}]}

    def sequence(self, actions, request=None):
        def model(messages, catalog):
            names = {item['name'] for item in catalog}
            self.assertTrue(set(work_concepts.INPUTS) <= names)
            results = [json.loads(message['content']) for message in messages if message['role'] == 'tool']
            if len(results) == len(actions):
                return {'content': 'Recorded the actual concept stage and evidence. No deployment claim.'}
            name, args = actions[len(results)]
            return {'content': '', 'tool_calls': [{'function': {'name': name, 'arguments': args(results) if callable(args) else args}}]}
        mission = self.manager.run_work(request or self.request, model)
        self.assertEqual(mission['status'], 'completed')
        for step in mission['steps']:
            self.assertTrue(step['succeeded'], step)
        return mission

    def genesis(self):
        actions = [('create_concept', {'name': 'Quoted construction inspection', 'thesis_statement': 'Check quoted cost arithmetic with exact source evidence.', 'domain_tags': ['construction']})]
        for requirement in ('name', 'thesis_statement', 'domain_tags'):
            actions.append(('add_concept_evidence', lambda r, requirement=requirement: {**change(r), 'requirement': requirement, 'source': {'kind': 'concept_intent'}}))
        actions.append(('advance_concept', lambda r: {**change(r), 'to_stage': 'inception', 'evidence_ids': [item['id'] for item in current(r)['evidence']]}))
        return self.sequence(actions)

    def test_work_commits_named_intent_and_genesis_gate_with_separate_clock(self):
        work = self.genesis()
        concept = work['steps'][-1]['result']['concept']
        self.assertEqual(concept['stage'], 'inception')
        self.assertNotEqual(concept['id'], work['id'])
        self.assertEqual(self.store.get_concept(concept['id'])['stage'], 'inception')
        self.assertEqual(len(concept['evidence']), 3)
        self.assertEqual(concept['versions'], [])
        self.assertEqual(work['artifacts'], [])
        with CommitService(self.store.root) as reader:
            self.assertEqual(reader.get_concept(concept['id'])['history_hash'], concept['history_hash'])
        replay = self.manager.run_work(self.request, lambda *_: self.fail('Completed mission must not replay'))
        self.assertEqual(replay['id'], work['id'])
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_later_work_binds_real_package_execution_and_denies_unsupported_maturity(self):
        seed_work = self.genesis()
        identity = seed_work['steps'][-1]['result']['concept']['id']
        request = self.request_for('Continue the existing concept through real local build evidence.')
        actions = [('inspect_concept', {'concept_id': identity})]
        for requirement in ('charter', 'success_criteria', 'constraint_set'):
            actions.append(('create_artifact', {'name': f'{requirement}.json', 'media_type': 'application/json',
                'content': json.dumps({'schema': 'yur.concept-plan.v1', 'concept_id': identity, 'requirement': requirement,
                                       'content': 'Inspect quoted rows without claiming approval.' if requirement == 'charter' else ['Check exact quoted rows', 'Do not claim quote approval']})}))
            actions.append(('add_concept_evidence', lambda r, requirement=requirement: {**change(r), 'requirement': requirement,
                'source': {'kind': 'work_artifact', 'mission_id': self.store.get_work_by_request(request['request_id'])['id'], 'artifact_id': r[-1]['artifact_id']}}))
        actions.append(('advance_concept', lambda r: {**change(r), 'to_stage': 'development', 'evidence_ids': [item['id'] for item in current(r)['evidence'] if item['requirement'] in {'charter', 'success_criteria', 'constraint_set'}]}))
        actions.append(('build_specialist', {'name': 'Concept quoted-row inspector', 'description': 'Bind a real executable version.', 'capabilities': ['construction.opc.inspect']}))
        actions.append(('bind_concept_version', lambda r: {**change(r), 'build_mission_id': r[-1]['mission_id'], 'parent_version_id': None}))
        actions.append(('run_built_specialist', lambda r: {'mission_id': current(r)['versions'][-1]['build_mission_id'], 'capability_id': 'construction.opc.inspect', 'input': {'text': '1 | FORM | 3 | EA | 19.95 | 60.00'}}))
        for requirement in ('artifact', 'build_log', 'instrumentation'):
            actions.append(('add_concept_evidence', lambda r, requirement=requirement: {**change(r), 'requirement': requirement,
                'source': {'kind': 'specialist_execution' if requirement == 'instrumentation' else 'specialist_build', 'version_id': current(r)['versions'][-1]['id'],
                           **({'run_id': next(item['run_id'] for item in r if item.get('tool') == 'run_built_specialist')} if requirement == 'instrumentation' else {})}}))
        actions.append(('advance_concept', lambda r: {**change(r), 'to_stage': 'stabilization', 'evidence_ids': [item['id'] for item in current(r)['evidence'] if item['requirement'] in {'artifact', 'build_log', 'instrumentation'}]}))
        actions.append(('advance_concept', lambda r: {**change(r), 'to_stage': 'maturation', 'evidence_ids': []}))
        work = self.sequence(actions, request)
        actual = work['steps'][-1]['result']
        self.assertEqual(actual['status'], 'denied')
        self.assertTrue(actual['committed'])  # The denial receipt, not advancement.
        self.assertFalse(actual['decision']['allowed'])
        self.assertEqual(actual['concept']['stage'], 'stabilization')
        self.assertTrue(actual['decision']['missing'])
        self.assertEqual(actual['concept']['id'], identity)
        self.assertEqual(len(actual['concept']['versions']), 1)
        self.assertEqual(len(actual['concept']['evidence']), 9)
        version = actual['concept']['versions'][0]
        artifact = self.store.get_artifact(version['build_mission_id'])
        self.assertEqual(version['artifact_sha256'], artifact['digest'])
        self.assertTrue(self.store.verify_integrity()['passed'])

    def recover_after_interruption(self, error_type=RuntimeError, after_store=False):
        original = work_concepts._record
        create = self.store.create_concept
        interrupted = False
        def crash(manager, parent, kind, change):
            nonlocal interrupted
            if kind == work_concepts.RESULT and not interrupted:
                interrupted = True
                raise error_type('Injected process loss after concept commit')
            return original(manager, parent, kind, change)
        def store_ack(*args, **kwargs):
            nonlocal interrupted
            result = create(*args, **kwargs)
            if not interrupted:
                interrupted = True
                raise error_type('Injected lost store acknowledgment after commit')
            return result
        actions = [('create_concept', {'name': 'Retained identity', 'thesis_statement': 'Preserve identity over interrupted work.', 'domain_tags': ['reliability']})]
        target, method, callback = (self.store, 'create_concept', store_ack) if after_store else (work_concepts, '_record', crash)
        with patch.object(target, method, side_effect=callback), self.assertRaisesRegex(RuntimeError, 'Injected|acknowledgment'):
            self.sequence(actions)
        failed = self.store.get_work_by_request(self.request['request_id'])
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(failed['steps'], [])
        self.assertFalse(any(message['role'] == 'tool' for message in failed['messages']))
        before = self.store.list_concepts()
        self.assertEqual(before['total'], 1)
        concept_id = before['concepts'][0]['id']
        revision = self.store.get_concept(concept_id)['revision']
        calls = []
        def model(messages, _catalog):
            calls.append(messages)
            outputs = [json.loads(message['content']) for message in messages if message['role'] == 'tool']
            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0]['concept']['id'], concept_id)
            return {'content': 'Recovered the original concept commit.'}
        result = self.manager.run_work(self.request, model)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.store.list_concepts()['total'], 1)
        self.assertEqual(self.store.get_concept(concept_id)['revision'], revision)
        events = self.store.work_events(result['id'])
        self.assertEqual(sum(event['event_type'] == work_concepts.ACCEPTED for event in events), 1)
        self.assertEqual(sum(event['event_type'] == work_concepts.RESULT for event in events), 1)

    def test_interrupted_parent_result_replays_same_committed_concept_before_model(self):
        self.recover_after_interruption()

    def test_value_error_after_commit_is_not_reported_as_rejected(self):
        self.recover_after_interruption(ValueError)

    def test_os_error_after_commit_is_not_reported_as_rejected(self):
        self.recover_after_interruption(OSError)

    def test_lost_store_acknowledgment_value_error_resolves_actual_commit(self):
        self.recover_after_interruption(ValueError, after_store=True)

    def test_lost_store_acknowledgment_os_error_resolves_actual_commit(self):
        self.recover_after_interruption(OSError, after_store=True)

    def test_model_cannot_supply_authority_or_invent_committed_evidence(self):
        calls = iter([
            {'name': 'create_concept', 'arguments': {'name': 'Invalid', 'thesis_statement': 'No injected permission.', 'domain_tags': ['test'], 'authority': {'issuer': 'local-user'}}},
            {'name': 'create_concept', 'arguments': {'name': 'Valid', 'thesis_statement': 'Require actual evidence.', 'domain_tags': ['test']}},
        ])
        counter = 0
        def model(messages, _catalog):
            nonlocal counter
            counter += 1
            if counter <= 2:
                return {'content': '', 'tool_calls': [{'function': next(calls)}]}
            outputs = [json.loads(message['content']) for message in messages if message['role'] == 'tool']
            if counter == 3:
                concept = outputs[-1]['concept']
                return {'content': '', 'tool_calls': [{'function': {'name': 'add_concept_evidence', 'arguments': {
                    'concept_id': concept['id'], 'expected_revision': concept['revision'], 'requirement': 'charter',
                    'source': {'kind': 'work_artifact', 'mission_id': '0' * 32, 'artifact_id': '1' * 32}}}}]}
            return {'content': 'Invalid authority and missing evidence were rejected.'}
        mission = self.manager.run_work(self.request, model)
        self.assertEqual([step['succeeded'] for step in mission['steps']], [False, True, False])
        self.assertEqual(self.store.list_concepts()['total'], 1)
        self.assertEqual(self.store.get_concept(mission['steps'][1]['result']['concept']['id'])['evidence'], [])

    def test_read_listing_does_not_create_or_advance_a_concept(self):
        mission = self.sequence([('list_concepts', {'limit': 20})])
        self.assertFalse(mission['steps'][0]['result']['committed'])
        self.assertEqual(mission['steps'][0]['result']['concepts'], [])
        self.assertEqual(self.store.list_concepts()['total'], 0)

    def test_requirement_value_is_rejected_before_acceptance_then_exact_key_succeeds(self):
        def model(messages, _catalog):
            outputs = [json.loads(message['content']) for message in messages if message['role'] == 'tool']
            if not outputs:
                return {'tool_calls': [{'function': {'name': 'create_concept', 'arguments': {
                    'name': 'Quoted inspection', 'thesis_statement': 'Retain exact source evidence.', 'domain_tags': ['construction']}}}]}
            concept = outputs[0]['concept']
            if len(outputs) < 3:
                return {'tool_calls': [{'function': {'name': 'add_concept_evidence', 'arguments': {
                    'concept_id': concept['id'], 'expected_revision': concept['revision'],
                    'requirement': concept['name'] if len(outputs) == 1 else 'name',
                    'source': {'kind': 'concept_intent'}}}}]}
            return {'content': 'One actual name evidence reference was recorded.'}
        mission = self.manager.run_work(self.request, model)
        self.assertEqual([step['succeeded'] for step in mission['steps']], [True, False, True])
        actual = self.store.get_concept(mission['steps'][0]['result']['concept']['id'])
        self.assertEqual([item['requirement'] for item in actual['evidence']], ['name'])
        self.assertEqual(actual['revision'], 2)
        self.assertEqual(sum(event['event_type'] == work_concepts.ACCEPTED
                             for event in self.store.work_events(mission['id'])), 2)


if __name__ == '__main__':
    unittest.main()
