"""Exact128 historical reconstruction, using temporary journals and synthetic cells.

No provider, WSL, host candidate execution or physical-runtime attestation.
Historical20 fixtures are issued explicitly under their recorded authority;
neither reader nor committed historical authority is patched or rewritten.
"""
import ast
from copy import deepcopy
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

from foundry import generated_evidence_v1 as v1
from foundry import generated_evidence_v2 as v2
from foundry import execution_cell, generated_contracts, generated_worker, work_generated
from foundry.commit_service import CommitService
import test_generated_evidence_v1 as historical_tests
import test_work_generated as fixtures


class GeneratedEvidenceV2Tests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.GeneratedWorkTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.built = self.fixture.build()
        self.source_id = self.fixture.parent['id']
        self.facts = v2.resolve_publication(self.fixture.store, self.source_id, 0,
                                            self.built['artifact']['sha256'])

    def next_parent(self, authority=None, step=0):
        self.fixture.parent = self.fixture.store.submit_work(
            self.fixture.request_for(), deepcopy(authority or v2._AUTHORITY))
        self.fixture.update(status='running',
                            steps=[{'synthetic_completed_step': index} for index in range(step)])

    def run_saved(self, facts=None, authority=None, step=0):
        facts = facts or self.facts
        self.next_parent(authority, step)
        result = self.fixture.invoke('run_python_specialist', args={
            **{key: facts[key] for key in ('source_work_id', 'build_step_index', 'artifact_sha256')},
            'input': {'value': 17}})
        return self.fixture.parent['id'], result

    def rewrite(self, mutation):
        # Rehash only this test's synthetic128 journal, including all references.
        # This exercises semantic rejection independently of simple hash damage.
        historical_tests.HistoricalGeneratedEvidenceTests.rewrite(self, mutation)

    def test_exact128_publication_and_execution_preserve_all_receipt_links(self):
        run_id, result = self.run_saved()
        store = self.fixture.store
        changes = store._db.total_changes
        observed = v2.resolve_execution(store, self.facts, run_id, 0)
        self.assertEqual(store._db.total_changes, changes)
        self.assertEqual(self.facts['verifier'], v2.VERIFIER)
        self.assertEqual(observed['verifier'], v2.VERIFIER)
        self.assertEqual(observed['execution_verifier'], v2.VERIFIER)
        self.assertEqual(observed['output_hash'], v1._digest({'doubled': 34}))
        self.assertEqual(observed['result_receipt_hash'], result['provenance']['result_receipt'])
        self.assertEqual(observed['execution_receipt_hash'], result['execution_receipt'])
        cohort = self.facts['validation_cohort']
        self.assertEqual(self.facts['validation_cohort_sha256'], v1._digest(cohort))
        self.assertEqual(self.facts['validation_receipt_hash'], cohort[-1]['evaluation_receipt_hash'])
        self.assertEqual(len(cohort), 3)

    def test_publications_and_executions_at_steps20_and127(self):
        for step in (20, 127):
            with self.subTest(step=step):
                self.next_parent(step=step)
                built = self.fixture.build()
                facts = v2.resolve_publication(self.fixture.store, self.fixture.parent['id'],
                                                 step, built['artifact']['sha256'])
                self.assertEqual(facts['build_step_index'], step)
                # Use step0 publication to isolate reader bounds from admission bounds.
                run_id, _ = self.run_saved(step=step)
                observed = v2.resolve_execution(self.fixture.store, self.facts, run_id, step)
                self.assertEqual(observed['execution_step_index'], step)

    def test_step128_negative_boolean_and_bad_identity_reject(self):
        for identity, step in ((self.source_id, 128), (self.source_id, -1),
                               (self.source_id, True), ('../state', 0)):
            with self.subTest(identity=identity, step=step), self.assertRaises(ValueError):
                v2.resolve_publication(self.fixture.store, identity, step)
        run_id, _ = self.run_saved()
        with self.assertRaises(ValueError):
            v2.resolve_execution(self.fixture.store, self.facts, run_id, 128)

    def test_sealed_v1_still_rejects_current128_and_remains_byte_identical(self):
        self.assertEqual(hashlib.sha256(Path(v1.__file__).read_bytes()).hexdigest(),
                         'a50cfa20c3509760a64d0f1808225351b47f96e01b29287f3d011488db94af73')
        self.assertEqual(v1._AUTHORITY['max_steps'], 20)
        with self.assertRaises(ValueError):
            v1.resolve_publication(self.fixture.store, self.source_id, 0)
        self.assertEqual(v2.SOURCE_PROVENANCE['generated_evidence_v1.py'],
                         hashlib.sha256(Path(v1.__file__).read_text(encoding='utf-8').encode()).hexdigest())

    def test_old_publication_new_execution_preserves_each_recorded_verifier(self):
        self.next_parent(v1._AUTHORITY)
        built = self.fixture.build()
        old_id = self.fixture.parent['id']
        old_facts = v1.resolve_publication(self.fixture.store, old_id, 0, built['artifact']['sha256'])
        with self.assertRaises(ValueError):
            v2.resolve_publication(self.fixture.store, old_id, 0)
        run_id, _ = self.run_saved(old_facts)
        observed = v2.resolve_execution(self.fixture.store, old_facts, run_id, 0)
        self.assertEqual(observed['verifier'], v1.VERIFIER)
        self.assertEqual(observed['execution_verifier'], v2.VERIFIER)
        self.assertEqual(old_facts, v1.resolve_publication(self.fixture.store, old_id, 0))
        self.assertEqual(self.fixture.store.get_work(old_id)['authority'], v1._AUTHORITY)
        self.assertEqual(self.fixture.store.get_work(run_id)['authority'], v2._AUTHORITY)

    def test_new_publication_old_execution_requires_explicit_exact_history_reader(self):
        run_id, _ = self.run_saved(authority=v1._AUTHORITY)
        with self.assertRaises(ValueError):
            v2.resolve_execution(self.fixture.store, self.facts, run_id, 0)
        observed = v2._resolve_execution(self.fixture.store, self.facts, run_id, 0, v1.VERIFIER)
        self.assertEqual(observed['verifier'], v2.VERIFIER)
        self.assertEqual(observed['execution_verifier'], v1.VERIFIER)
        with self.assertRaises(ValueError):
            v2._resolve_execution(self.fixture.store, self.facts, run_id, 0, 'yur.generated-evidence.v3')

    def test_unknown_or_mismatched_publication_verifier_rejects(self):
        run_id, _ = self.run_saved()
        for verifier in (v1.VERIFIER, 'yur.generated-evidence.v3', None):
            with self.subTest(verifier=verifier), self.assertRaises(ValueError):
                v2.resolve_execution(self.fixture.store, {**self.facts, 'verifier': verifier}, run_id, 0)

    def test_reopen_deleted_source_and_current_runtime_changes_do_not_reinterpret_history(self):
        run_id, _ = self.run_saved()
        expected = v2.resolve_execution(self.fixture.store, self.facts, run_id, 0)
        self.fixture.path.unlink()
        state = self.fixture.store.path.parent
        self.fixture.store.close()
        with CommitService(state) as store, \
             patch.object(generated_worker, 'DRIVER_SHA256', '0' * 64), \
             patch.object(execution_cell, 'run_snapshot', side_effect=AssertionError('No cell execution')), \
             patch.object(execution_cell, '_guardian_program', side_effect=AssertionError('No WSL/runtime query')), \
             patch.object(generated_worker, 'validate_worker_execution', side_effect=AssertionError('No current admission')), \
             patch.object(generated_contracts, 'validate_contract', side_effect=AssertionError('No current contract readmission')), \
             patch.object(work_generated, '_resolve', side_effect=AssertionError('No current publication admission')):
            self.assertEqual(v2.resolve_publication(store, self.source_id, 0), self.facts)
            self.assertEqual(v2.resolve_execution(store, self.facts, run_id, 0), expected)

    def test_read_transaction_verifies_once_and_nested_reads_share_snapshot(self):
        store = self.fixture.store
        with patch.object(store, '_verify_or_raise', wraps=store._verify_or_raise) as verify:
            self.assertEqual(v2.resolve_publication(store, self.source_id, 0), self.facts)
            self.assertEqual(verify.call_count, 1)
        self.assertFalse(store._db.in_transaction)
        with patch.object(store, '_verify_or_raise', wraps=store._verify_or_raise) as verify:
            with store._read_transaction():
                self.assertEqual(v2.resolve_publication(store, self.source_id, 0), self.facts)
                self.assertTrue(store._db.in_transaction)
            self.assertEqual(verify.call_count, 1)
        self.assertFalse(store._db.in_transaction)

    def test_malformed_and_widened_authority_are_not_selected(self):
        def mutate(event):
            event['data']['document']['authority']['max_steps'] = 129
        self.rewrite(mutate)
        with self.assertRaises((RuntimeError, ValueError)):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_extra_authority_action_rejects(self):
        def mutate(event):
            event['data']['document']['authority']['actions'].append('network')
        self.rewrite(mutate)
        with self.assertRaises((RuntimeError, ValueError)):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_event_hash_and_full_journal_corruption_reject(self):
        self.fixture.store._db.execute('UPDATE work_events SET hash=? WHERE id=1', ('0' * 64,))
        with self.assertRaises(RuntimeError):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_projection_hash_corruption_rejects(self):
        self.fixture.store._db.execute('UPDATE work_events SET state_digest=? WHERE event_type=?',
                                      ('0' * 64, work_generated.PUBLISHED))
        with self.assertRaises(RuntimeError):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_candidate_source_does_not_replace_structural_identity(self):
        def mutate(event):
            if event['event_type'] == work_generated.CANDIDATE:
                candidate = event['data']['change']['candidate']
                candidate['source'] += '\n# tampered\n'
                candidate['source_sha256'] = hashlib.sha256(candidate['source'].encode()).hexdigest()
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_candidate_cohort_label_rejects(self):
        def mutate(event):
            if event['event_type'] == work_generated.EVALUATED:
                event['data']['change']['case_id'] = 'foreign-case'
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_snapshot_and_cell_link_rejects(self):
        def mutate(event):
            if event['event_type'] == work_generated.CELL:
                event['data']['change']['snapshot_receipt'] = 'f' * 64
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_runtime_identity_rejects(self):
        def mutate(event):
            if event['event_type'] == work_generated.CELL:
                event['data']['change']['execution']['runtime']['guardian_sha256'] = 'f' * 64
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_published_artifact_rejects(self):
        def mutate(event):
            if event['event_type'] == work_generated.PUBLISHED:
                fields = event['data']['change']
                fields['artifact']['name'] = 'Unrelated generated worker'
                fields['artifact_sha256'] = v1._digest(fields['artifact'])
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            v2.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_run_result_cannot_replace_recorded_cell_output(self):
        run_id, _ = self.run_saved()
        def mutate(event):
            if event['mission_id'] == run_id and event['event_type'] == work_generated.RESULT:
                event['data']['change']['result']['output']['doubled'] = 35
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            v2.resolve_execution(self.fixture.store, self.facts, run_id, 0)

    def test_new_reader_imports_only_stdlib_and_frozen_v1_no_dynamic_code(self):
        tree = ast.parse(Path(v2.__file__).read_text(encoding='utf-8'))
        imports = [node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
        self.assertEqual(imports, ['copy', None, 'generated_evidence_v1'])
        for node in ast.walk(tree):
            self.assertFalse(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                             and node.func.id in {'eval', 'exec', 'compile', '__import__'})


if __name__ == '__main__':
    unittest.main()
