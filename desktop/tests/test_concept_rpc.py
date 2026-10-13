"""Read-only Concept ingress against isolated, real CommitService journals."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.concept_store import CONCEPT_AUTHORITY
from foundry.concept_rpc import handle, validate
from foundry.work_cli import handle as work_handle, validate_rpc


def uid():
    return str(uuid.uuid4())


class ConceptRpcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'unused-journal'
        self.environment = patch.dict(os.environ, {'YUR_DESKTOP_HOME': str(self.root)})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    @staticmethod
    def create(store, name='Quoted inspection'):
        return store.create_concept({'name': name, 'domain_tags': ['construction'],
                                    'thesis_statement': 'Preserve exact quoted source evidence.'}, CONCEPT_AUTHORITY, uid())

    def test_strict_read_only_commands_validate_before_any_state_access(self):
        good = {'command': 'concept_list', 'limit': 20, 'cursor': None}
        self.assertEqual(validate_rpc(good), good)
        self.assertEqual(validate_rpc({'command': 'concept_inspect', 'concept_id': uid()})['command'], 'concept_inspect')
        for request in (None, [], {'command': 'concept_create'}, {**good, 'authority': CONCEPT_AUTHORITY},
                        {**good, 'limit': True}, {**good, 'limit': 0}, {**good, 'limit': 21},
                        {**good, 'cursor': 'a' * 32}, {**good, 'cursor': uid().upper()},
                        {'command': 'concept_inspect', 'concept_id': 'a' * 32},
                        {'command': 'concept_inspect', 'concept_id': uid(), 'root': str(self.root)}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                validate(request)
        self.assertFalse(self.root.exists())

    def test_empty_discovery_and_unknown_inspection_never_create_journal(self):
        for existing_directory in (False, True):
            if existing_directory:
                self.root.mkdir()
            with patch('foundry.work_cli.CommitService', side_effect=AssertionError('Read created state')):
                self.assertEqual(work_handle({'command': 'concept_list', 'limit': 20, 'cursor': None}),
                                 {'concepts': [], 'next_cursor': None, 'total': 0})
                for request in ({'command': 'concept_list', 'limit': 20, 'cursor': uid()},
                                {'command': 'concept_inspect', 'concept_id': uid()}):
                    with self.assertRaisesRegex(ValueError, 'not found'):
                        work_handle(request)
            self.assertEqual(list(self.root.iterdir()) if self.root.exists() else [], [])

    def test_paginated_discovery_uses_small_summaries_and_does_not_change_state(self):
        with CommitService(self.root) as store:
            concepts = [self.create(store, f'Concept {index}') for index in range(3)]
            before = {item['id']: store.get_concept(item['id']) for item in concepts}
            with patch('foundry.work_cli.OrchestrationManager', side_effect=AssertionError('Read instantiated orchestration')):
                page = work_handle({'command': 'concept_list', 'limit': 2, 'cursor': None})
            second = handle(store, {'command': 'concept_list', 'limit': 2, 'cursor': page['next_cursor']})
            self.assertEqual(page['total'], 3)
            self.assertEqual([item['id'] for item in page['concepts'] + second['concepts']], sorted(before))
            self.assertIsNone(second['next_cursor'])
            for summary in page['concepts']:
                self.assertNotIn('thesis_statement', summary)
                self.assertNotIn('evidence', summary)
                self.assertEqual(summary['revision'], 1)
            self.assertEqual(before, {item['id']: store.get_concept(item['id']) for item in concepts})

    def test_latest_receipts_have_exact_identity_and_compact_denied_gate(self):
        with CommitService(self.root) as store:
            concept = self.create(store)
            other = self.create(store, 'Independent concept clock')
            result = store.transition_concept(concept['id'], concept['revision'], 'inception', [], uid(), CONCEPT_AUTHORITY)
            concept = result['concept']
            expected = deepcopy(concept)
            record = handle(store, {'command': 'concept_inspect', 'concept_id': concept['id']})
            self.assertEqual(record['concept'], expected)
            self.assertEqual([event['id'] for event in record['events']], [1, 3])
            self.assertEqual(record['history'], {'from_revision': 1, 'through_revision': 2, 'omitted_before': 0})
            decision = record['events'][-1]['decision']
            self.assertFalse(decision['allowed'])
            self.assertEqual({gap['requirement'] for gap in decision['missing']}, {'name', 'domain_tags', 'thesis_statement'})
            self.assertEqual(set(decision), {'allowed', 'from_stage', 'to_stage', 'missing', 'errors', 'requirements'})
            self.assertNotIn('document', json.dumps(record['events']))
            self.assertEqual(store.get_concept(other['id'])['revision'], 1)
            self.assertEqual(store.get_concept(concept['id']), expected)

    def test_history_tail_is_explicitly_bounded_and_root_snapshot_is_not_duplicated(self):
        with CommitService(self.root) as store:
            concept = self.create(store)
            for _ in range(22):
                concept = store.transition_concept(concept['id'], concept['revision'], 'inception', [], uid(), CONCEPT_AUTHORITY)['concept']
            record = handle(store, {'command': 'concept_inspect', 'concept_id': concept['id']})
            self.assertEqual(len(record['events']), 20)
            self.assertEqual(record['history'], {'from_revision': 4, 'through_revision': 23, 'omitted_before': 3})
            self.assertEqual(record['events'][-1]['hash'], record['concept']['history_hash'])
            self.assertNotIn('thesis_statement', record['events'][0])
            self.assertTrue(store.verify_integrity()['passed'])

    def test_cli_envelope_uses_real_read_only_ingress_and_unknown_id_fails(self):
        with CommitService(self.root) as store:
            concept = self.create(store)
        for identifier, expected_code in ((concept['id'], 0), (uid(), 1)):
            completed = subprocess.run([sys.executable, '-B', '-m', 'foundry.work_cli'],
                                       input=json.dumps({'command': 'concept_inspect', 'concept_id': identifier}),
                                       cwd=Path(__file__).resolve().parents[1], text=True, encoding='utf-8',
                                       capture_output=True, timeout=10, check=False)
            self.assertEqual(completed.returncode, expected_code, completed.stderr)
            records = [json.loads(line) for line in completed.stdout.splitlines()]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]['type'], 'result')
            self.assertEqual(records[0]['ok'], expected_code == 0)
            if expected_code == 0:
                self.assertEqual(records[0]['result']['concept']['id'], identifier)
            else:
                self.assertEqual(records[0]['error']['code'], 'INVALID_REQUEST')


if __name__ == '__main__':
    unittest.main()
