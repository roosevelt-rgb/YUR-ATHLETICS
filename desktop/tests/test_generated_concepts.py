"""Generated Concept lineage uses real commits and explicit synthetic cells.

No model/network/WSL calls or host candidate execution. Synthetic process records
verify authority/history contracts, not actual execution-environment acceptance.
"""
from contextlib import closing, ExitStack
from copy import deepcopy
import hashlib
import json
import sqlite3
import unittest
from unittest.mock import patch
import uuid

import test_work_generated as fixtures
from foundry import execution_cell, generated_worker, work_generated
from foundry import generated_evidence, generated_evidence_v1, generated_evidence_v2
from foundry import work_concepts
from foundry.commit_service import CommitService, SCHEMA_VERSION
from foundry.concept_store import CONCEPT_AUTHORITY, ConceptConflictError, _digest
from foundry.orchestration import OrchestrationManager, local_authority


def operation():
    return str(uuid.uuid4())


class GeneratedConceptTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.GeneratedWorkTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store = self.fixture.store
        self.addCleanup(lambda: self.store.close())

    def create(self, name='Retained generated doubling'):
        return self.store.create_concept({'name': name, 'domain_tags': ['arithmetic'],
            'thesis_statement': 'Retain one contained integer worker and its independent evidence.'},
            CONCEPT_AUTHORITY, operation())

    def add(self, concept, requirement, source):
        return self.store.submit_concept_evidence(concept['id'], concept['revision'],
            {'requirement': requirement, 'source': source}, operation(), CONCEPT_AUTHORITY)

    def move(self, concept, stage, requirements):
        ids = [item['id'] for item in concept['evidence'] if item['requirement'] in requirements]
        return self.store.transition_concept(concept['id'], concept['revision'], stage, ids, operation(), CONCEPT_AUTHORITY)

    def development(self):
        concept = self.create()
        for requirement in ('name', 'domain_tags', 'thesis_statement'):
            concept = self.add(concept, requirement, {'kind': 'concept_intent'})
        moved = self.move(concept, 'inception', {'name', 'domain_tags', 'thesis_statement'})
        self.assertTrue(moved['decision']['allowed'])
        concept = moved['concept']
        calls = [{'function': {'name': 'create_artifact', 'arguments': {'name': requirement + '.json',
            'media_type': 'application/json', 'content': json.dumps({'schema': 'yur.concept-plan.v1',
                'concept_id': concept['id'], 'requirement': requirement, 'content': content})}}}
            for requirement, content in [('charter', 'Bounded integer doubling.'),
                ('success_criteria', ['Pass the operator cases and retain exact output receipts.']),
                ('constraint_set', ['No network, host imports or commercial-readiness claims.'])]]
        responses = iter([{'content': '', 'tool_calls': calls}, {'content': 'Plans retained.'}])
        plans = OrchestrationManager(self.store).run_work(self.fixture.request_for('work'), lambda *_: next(responses))
        self.assertEqual(plans['status'], 'completed')
        for step in plans['steps']:
            self.assertTrue(step['succeeded'])
            requirement = json.loads(step['arguments']['content'])['requirement']
            concept = self.add(concept, requirement, {'kind': 'work_artifact', 'mission_id': plans['id'], 'artifact_id': step['id']})
        moved = self.move(concept, 'development', {'charter', 'success_criteria', 'constraint_set'})
        self.assertTrue(moved['decision']['allowed'])
        return moved['concept']

    def publish(self, name=None):
        if name is not None:
            self.fixture.next_parent()
            contract = fixtures.contract()
            contract['name'] = name
            self.fixture.path.write_text(json.dumps(contract), encoding='utf-8')
            self.fixture.args['expected_sha256'] = hashlib.sha256(self.fixture.path.read_bytes()).hexdigest()
        result = self.fixture.build()
        self.assertEqual(result['status'], 'published')
        return {'source_work_id': self.fixture.parent['id'], 'build_step_index': 0,
                'artifact_sha256': result['artifact']['sha256']}

    def run_saved(self, publication):
        self.fixture.next_parent()
        result = self.fixture.invoke('run_python_specialist', {**publication, 'input': {'value': 12}})
        self.assertEqual(result['status'], 'recorded')
        self.assertEqual(result['output'], {'doubled': 24})
        return {'execution_work_id': self.fixture.parent['id'], 'execution_step_index': 0}, result

    def bind(self, concept, publication, parent=None, key=None):
        return self.store.bind_generated_concept_version(concept['id'], concept['revision'],
            publication['source_work_id'], publication['build_step_index'], publication['artifact_sha256'],
            parent, key or operation(), CONCEPT_AUTHORITY)

    def test_generated_build_run_evidence_gate_and_unmeasured_maturation(self):
        concept = self.development()
        publication = self.publish()
        concept = self.bind(concept, publication)
        version = concept['versions'][0]
        self.assertEqual(version['kind'], 'generated_python')
        self.assertNotIn('build_mission_id', version)
        self.assertEqual(version['evidence_verifier'], 'yur.generated-evidence.v2')
        for requirement in ('artifact', 'build_log'):
            concept = self.add(concept, requirement, {'kind': 'generated_build', 'version_id': version['id']})
        source, run = self.run_saved(publication)
        concept = self.add(concept, 'instrumentation', {'kind': 'generated_execution', 'version_id': version['id'], **source})
        self.assertEqual(concept['evidence'][-1]['receipt_hash'], run['provenance']['result_receipt'])
        moved = self.move(concept, 'stabilization', {'artifact', 'build_log', 'instrumentation'})
        self.assertTrue(moved['decision']['allowed'], moved)
        denied = self.move(moved['concept'], 'maturation', {'artifact', 'build_log', 'instrumentation'})
        self.assertFalse(denied['decision']['allowed'])
        self.assertEqual(denied['concept']['stage'], 'stabilization')
        self.assertEqual({gap['requirement'] for gap in denied['decision']['missing']},
                         {'eval_report', 'known_failure_modes', 'stability_score'})
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_historical_reopen_ignores_current_admission_pins_contracts_and_source_file(self):
        concept = self.development()
        publication = self.publish()
        concept = self.bind(concept, publication)
        version = concept['versions'][0]
        for requirement in ('artifact', 'build_log'):
            concept = self.add(concept, requirement, {'kind': 'generated_build', 'version_id': version['id']})
        source, _ = self.run_saved(publication)
        concept = self.add(concept, 'instrumentation', {'kind': 'generated_execution', 'version_id': version['id'], **source})
        moved = self.move(concept, 'stabilization', {'artifact', 'build_log', 'instrumentation'})
        self.assertTrue(moved['decision']['allowed'])
        concept = moved['concept']
        before = self.store.verify_integrity()
        root = self.store.root
        self.store.close()
        self.fixture.path.unlink()
        with ExitStack() as guards:
            current = guards.enter_context(patch.object(work_generated, '_resolve', side_effect=ValueError('current admission unavailable')))
            guards.enter_context(patch.object(generated_worker, 'DRIVER_SHA256', 'f' * 64))
            guards.enter_context(patch.object(execution_cell, 'RUNTIME_PINS', {}))
            guards.enter_context(patch.object(work_generated.contracts, 'validate_contract', side_effect=ValueError('new contract policy')))
            guards.enter_context(patch.object(execution_cell, 'resolve_runtime', side_effect=AssertionError('no runtime query')))
            self.store = CommitService(root)
            self.assertEqual(self.store.get_concept(concept['id']), concept)
            self.assertEqual(self.store.verify_integrity(), before)
            current.assert_not_called()
            other = self.create('New binding must still check current admission')
            with self.assertRaisesRegex(ValueError, 'current admission'):
                self.bind(other, publication)
            current.assert_called_once()
            self.assertEqual(self.store.get_concept(other['id']), other)

    def test_binding_cas_exact_replay_and_atomic_commit_failure(self):
        publication = self.publish()
        concept = self.create()
        key = operation()
        bound = self.bind(concept, publication, key=key)
        with patch.object(work_generated, '_resolve', side_effect=AssertionError('replay must not read current admission')):
            self.assertEqual(self.bind(concept, publication, key=key), bound)
        with self.assertRaises(ConceptConflictError):
            self.bind(concept, publication)
        with self.assertRaisesRegex(ValueError, 'different arguments'):
            self.bind(bound, publication, key=key)
        other = self.create('Atomic binding')
        with patch.object(self.store, '_concept_append', side_effect=OSError('synthetic transaction failure')):
            with self.assertRaises(OSError):
                self.bind(other, publication)
        self.assertEqual(self.store.get_concept(other['id']), other)

    def test_current_publications_at_steps20_and127_bind_and_reopen(self):
        for step in (20, 127):
            with self.subTest(step=step):
                self.fixture.next_parent()
                self.fixture.update(steps=[{'synthetic_completed_step': index} for index in range(step)])
                built = self.fixture.build()
                publication = {'source_work_id': self.fixture.parent['id'], 'build_step_index': step,
                               'artifact_sha256': built['artifact']['sha256']}
                concept = self.bind(self.create('Current bounded publication ' + str(step)), publication)
                version = concept['versions'][0]
                self.assertEqual((version['evidence_verifier'], version['build_step_index']),
                                 (generated_evidence_v2.VERIFIER, step))
                with patch.object(work_generated, '_resolve', side_effect=AssertionError('No current admission on projection')):
                    self.assertEqual(self.store.get_concept(concept['id']), concept)
                with self.assertRaisesRegex(ValueError, 'Pinned'):
                    self.store._concept_version_facts({**version, 'evidence_verifier': generated_evidence_v1.VERIFIER})

    def test_mixed_publication_and_execution_keep_independent_recorded_versions(self):
        retained = []
        for publication_reader, execution_reader in ((generated_evidence_v1, generated_evidence_v2),
                                                       (generated_evidence_v2, generated_evidence_v1),
                                                       (generated_evidence_v1, generated_evidence_v1)):
            with self.subTest(publication=publication_reader.VERIFIER, execution=execution_reader.VERIFIER):
                self.fixture.authority = deepcopy(publication_reader._AUTHORITY)
                self.fixture.next_parent()
                publication = self.publish()
                before = deepcopy(self.store.get_work(publication['source_work_id']))
                seed, key = self.create('Explicit historical compatibility'), operation()
                concept = self.bind(seed, publication, key=key)
                version = concept['versions'][0]
                self.assertEqual(version['evidence_verifier'], publication_reader.VERIFIER)
                with patch.object(work_generated, '_resolve', side_effect=AssertionError('No re-admission on replay')):
                    self.assertEqual(self.bind(seed, publication, key=key), concept)
                self.fixture.authority = deepcopy(execution_reader._AUTHORITY)
                source, run = self.run_saved(publication)
                concept = self.add(concept, 'instrumentation',
                                   {'kind': 'generated_execution', 'version_id': version['id'], **source})
                observed = self.store._concept_source_facts(concept, 'instrumentation', concept['evidence'][-1]['source'])
                self.assertEqual(observed['facts']['evidence_verifier'], publication_reader.VERIFIER)
                if publication_reader is generated_evidence_v1 and execution_reader is generated_evidence_v1:
                    self.assertNotIn('execution_verifier', observed['facts'])
                else:
                    self.assertEqual(observed['facts']['execution_verifier'], execution_reader.VERIFIER)
                self.assertEqual(observed['receipt_hash'], run['provenance']['result_receipt'])
                self.assertEqual(self.store.get_work(publication['source_work_id']), before)
                with patch.object(work_generated, '_resolve', side_effect=AssertionError('Historical projection is read-only')):
                    self.assertEqual(self.store.get_concept(concept['id']), concept)
                retained.append(concept)
        root = self.store.root
        self.store.close()
        with patch.object(work_generated, '_resolve', side_effect=AssertionError('Reopening retained versions cannot require current admission')):
            self.store = CommitService(root)
            self.addCleanup(self.store.close)
            for concept in retained:
                self.assertEqual(self.store.get_concept(concept['id']), concept)

    def test_router_rejects_pinned_mismatch_and_unrecognized_authority_without_fallback(self):
        publication = self.publish()
        with patch.object(generated_evidence_v2, 'resolve_publication', side_effect=AssertionError('No reader fallback')):
            with self.assertRaisesRegex(ValueError, 'Pinned'):
                generated_evidence.resolve_publication(self.store, publication['source_work_id'], 0,
                    publication['artifact_sha256'], verifier=generated_evidence_v1.VERIFIER)
        from foundry.work_desktop import AUTHORITY as franklin_authority
        parent = self.store.submit_work(self.fixture.request_for(), deepcopy(franklin_authority))
        with patch.object(generated_evidence_v1, 'resolve_publication', side_effect=AssertionError('No widening')), \
             patch.object(generated_evidence_v2, 'resolve_publication', side_effect=AssertionError('No widening')):
            with self.assertRaisesRegex(ValueError, 'exact supported committed authority'):
                generated_evidence.resolve_publication(self.store, parent['id'], 0)

    def test_actual_work_tool_binds_generated_version_and_uses_its_source_kind(self):
        publication, concept = self.publish(), self.create()
        request = self.fixture.request_for()
        def model(messages, _catalog):
            outputs = [json.loads(item['content']) for item in messages if item['role'] == 'tool']
            if not outputs:
                name, args = 'bind_generated_concept_version', {'concept_id': concept['id'],
                    'expected_revision': concept['revision'], **publication, 'parent_version_id': None}
            elif len(outputs) == 1:
                current = outputs[-1]['concept']
                name, args = 'add_concept_evidence', {'concept_id': current['id'], 'expected_revision': current['revision'],
                    'requirement': 'artifact', 'source': {'kind': 'generated_build', 'version_id': current['versions'][0]['id']}}
            else:
                return {'content': 'The generated version and source-bound artifact evidence were retained.'}
            return {'content': '', 'tool_calls': [{'function': {'name': name, 'arguments': args}}]}
        mission = OrchestrationManager(self.store).run_work(request, model)
        self.assertEqual(mission['status'], 'completed')
        self.assertEqual([step['succeeded'] for step in mission['steps']], [True, True])
        current = self.store.get_concept(concept['id'])
        self.assertEqual((len(current['versions']), len(current['evidence']), current['stage']), (1, 1, 'genesis'))
        self.assertEqual(current['versions'][0]['kind'], 'generated_python')
        authority = self.store._concept_last(concept['id'])['data']['change']['authority']
        self.assertEqual(authority['work_mission_id'], mission['id'])
        self.assertEqual(authority['work_request_id'], request['request_id'])
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_generated_binding_ack_loss_resumes_exact_commit_without_current_readmission(self):
        publication, concept = self.publish(), self.create()
        request = self.fixture.request_for()
        args = {'concept_id': concept['id'], 'expected_revision': concept['revision'], **publication, 'parent_version_id': None}
        original = self.store.bind_generated_concept_version
        def lost_ack(*values, **options):
            original(*values, **options)
            raise OSError('Injected generated binding acknowledgment loss')
        def adapter(messages, _catalog):
            # An early binding rejection must fail this test immediately instead
            # of repeating the same call until the full Work budget is consumed.
            self.assertFalse(any(item['role'] == 'tool' for item in messages), 'Binding failed before the injected lost acknowledgment')
            return {'content': '', 'tool_calls': [{'function': {'name': 'bind_generated_concept_version', 'arguments': args}}]}
        with patch.object(self.store, 'bind_generated_concept_version', side_effect=lost_ack):
            with self.assertRaises(RuntimeError):
                OrchestrationManager(self.store).run_work(request, adapter)
        failed = self.store.get_work_by_request(request['request_id'])
        self.assertEqual((failed['status'], failed['steps']), ('failed', []))
        retained = self.store.get_concept(concept['id'])
        self.assertEqual((retained['revision'], len(retained['versions'])), (2, 1))
        calls = []
        def finish(messages, _catalog):
            calls.append(messages)
            outputs = [json.loads(item['content']) for item in messages if item['role'] == 'tool']
            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0]['concept']['versions'], retained['versions'])
            return {'content': 'Recovered the original generated version.'}
        with patch.object(work_generated, '_resolve', side_effect=AssertionError('No new admission on recovery')):
            complete = OrchestrationManager(self.store).run_work(request, finish)
        self.assertEqual(complete['status'], 'completed')
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.store.get_concept(concept['id']), retained)
        events = self.store.work_events(complete['id'])
        self.assertEqual(sum(event['event_type'] == work_concepts.ACCEPTED for event in events), 1)
        self.assertEqual(sum(event['event_type'] == work_concepts.RESULT for event in events), 1)

    def test_parentage_duplicate_identity_and_artifact_digest(self):
        first = self.publish()
        concept = self.bind(self.create(), first)
        original = deepcopy(concept['versions'][0])
        second = self.publish('Distinct generated artifact')
        with self.assertRaisesRegex(ValueError, 'parent'):
            self.bind(concept, second)
        bound = self.bind(concept, second, original['id'])
        self.assertEqual(bound['versions'][0], original)
        self.assertEqual((bound['versions'][1]['ordinal'], bound['versions'][1]['parent_version_id']), (2, original['id']))
        self.assertEqual(bound['stage'], 'genesis')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.bind(bound, first, original['id'])
        with self.assertRaises(ValueError):
            self.bind(self.create('Foreign parent'), first, original['id'])
        for altered in ({**second, 'artifact_sha256': 'f' * 64}, {**second, 'build_step_index': True},
                        {**second, 'build_step_index': 20}, {**second, 'source_work_id': uuid.uuid4().hex}):
            with self.subTest(altered=altered), self.assertRaises((ValueError, KeyError)):
                self.bind(bound, altered, original['id'])

    def test_legacy_version_shape_and_cross_kind_references_remain_separate(self):
        manager = OrchestrationManager(self.store)
        build = manager.submit({'name': 'Legacy retained worker', 'description': 'A bounded text worker',
                                'capabilities': ['text.analyze']}, operation(), local_authority())
        manager.process(mission_id=build['id'])
        concept = self.create()
        concept = self.store.bind_concept_version(concept['id'], concept['revision'], build['id'], None, operation(), CONCEPT_AUTHORITY)
        legacy = deepcopy(concept['versions'][0])
        legacy_events = self.store.concept_events(concept['id'])
        self.assertNotIn('kind', legacy)
        publication = self.publish()
        concept = self.bind(concept, publication, legacy['id'])
        generated = concept['versions'][1]
        self.assertEqual(concept['versions'][0], legacy)
        self.assertEqual(self.store.concept_events(concept['id'])['events'][:2], legacy_events['events'])
        for source in ({'kind': 'specialist_build', 'version_id': generated['id']},
                       {'kind': 'generated_build', 'version_id': legacy['id']}):
            with self.assertRaisesRegex(ValueError, 'source kind'):
                self.add(concept, 'artifact', source)
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_execution_cannot_be_forge_case_or_another_publication(self):
        publication = self.publish()
        concept = self.bind(self.create(), publication)
        version = concept['versions'][0]
        with self.assertRaises(ValueError):
            self.add(concept, 'instrumentation', {'kind': 'generated_execution', 'version_id': version['id'],
                'execution_work_id': publication['source_work_id'], 'execution_step_index': 0})
        other = self.publish('Different publication')
        source, _ = self.run_saved(other)
        with self.assertRaises(ValueError):
            self.add(concept, 'instrumentation', {'kind': 'generated_execution', 'version_id': version['id'], **source})
        for requirement in ('stability_score', 'eval_report', 'known_failure_modes'):
            with self.assertRaises(ValueError):
                self.add(concept, requirement, {'kind': 'generated_build', 'version_id': version['id']})
        self.assertEqual(self.store.get_concept(concept['id']), concept)

    def test_schema6_marker_migration_keeps_all_rows_and_receipt_bytes(self):
        concept = self.create()
        concept = self.add(concept, 'name', {'kind': 'concept_intent'})
        manager = OrchestrationManager(self.store)
        build = manager.submit({'name': 'Schema6 legacy version', 'description': 'Retain original version bytes',
                                'capabilities': ['text.analyze']}, operation(), local_authority())
        manager.process(mission_id=build['id'])
        concept = self.store.bind_concept_version(concept['id'], concept['revision'], build['id'], None, operation(), CONCEPT_AUTHORITY)
        self.assertNotIn('kind', concept['versions'][0])
        path, root = self.store.path, self.store.root
        self.store.close()
        with closing(sqlite3.connect(path)) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute('DROP TABLE runtime_setup_events')
            raw.execute('DROP TABLE runtime_setups')
            raw.execute('PRAGMA user_version=6')
            tables = [row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            before = {table: raw.execute('SELECT * FROM ' + table + ' ORDER BY rowid').fetchall() for table in tables}
        self.store = CommitService(root)
        self.assertEqual(self.store.get_concept(concept['id']), concept)
        with closing(sqlite3.connect(path)) as raw:
            self.assertEqual(raw.execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)
            after = {table: raw.execute('SELECT * FROM ' + table + ' ORDER BY rowid').fetchall() for table in tables}
        self.assertEqual(before, after)

    def test_schema6_corruption_rolls_back_marker_and_preserves_corrupt_rows(self):
        self.create()
        path, root = self.store.path, self.store.root
        self.store.close()
        with closing(sqlite3.connect(path)) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute('DROP TABLE runtime_setup_events')
            raw.execute('DROP TABLE runtime_setups')
            raw.execute('PRAGMA user_version=6')
            raw.execute("UPDATE concept_events SET data='{}'")
            before = raw.execute('SELECT * FROM concept_events').fetchall()
        with self.assertRaises(RuntimeError):
            CommitService(root)
        with closing(sqlite3.connect(path)) as raw:
            self.assertEqual(raw.execute('PRAGMA user_version').fetchone()[0], 6)
            self.assertEqual(raw.execute('SELECT * FROM concept_events').fetchall(), before)

    def test_rehashed_version_identity_still_requires_exact_historical_evidence(self):
        concept = self.bind(self.create(), self.publish())
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.row_factory = sqlite3.Row
            event = dict(raw.execute('SELECT * FROM concept_events ORDER BY id DESC LIMIT 1').fetchone())
            event['data'] = json.loads(event['data'])
            for version in (event['data']['change']['version'], event['data']['document']['versions'][0]):
                version['runtime_sha256'] = 'f' * 64
            event['state_digest'] = _digest(event['data']['document'])
            event.pop('hash')
            changed_hash = _digest(event)
            raw.execute('UPDATE concept_events SET data=?,state_digest=?,hash=? WHERE id=?',
                        (json.dumps(event['data']), event['state_digest'], changed_hash, event['id']))
            raw.execute('UPDATE concept_documents SET document=? WHERE id=?',
                        (json.dumps(event['data']['document']), concept['id']))
        with self.assertRaisesRegex(RuntimeError, 'version source mismatch'):
            self.store.get_concept(concept['id'])


if __name__ == '__main__':
    unittest.main()
