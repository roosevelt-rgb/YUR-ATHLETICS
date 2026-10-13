"""Pure gate checks with synthetic trusted-resolver records, no runtime claims."""
from copy import deepcopy
import unittest
import uuid

from foundry.concept_policy import validate_transition
from foundry import work_concepts


class GeneratedConceptPolicyTests(unittest.TestCase):
    def setUp(self):
        self.concept = {'id': str(uuid.uuid4()), 'stage': 'development', 'parent_id': None,
                        'lineage': [], 'revision': 5, 'history_hash': 'f' * 64}
        common = {'source_kind': 'generated_python', 'source_work_id': 'a' * 32, 'build_step_index': 2,
                  'artifact_digest': '1' * 64, 'source_sha256': '2' * 64, 'contract_sha256': '3' * 64,
                  'driver_sha256': '4' * 64, 'runtime_digest': '5' * 64, 'acceptance_cohort_sha256': '6' * 64,
                  'evidence_verifier': 'yur.generated-evidence.v1'}
        self.records = {}
        for requirement in ('artifact', 'build_log', 'instrumentation'):
            build = requirement != 'instrumentation'
            facts = {**common, **({'validation_receipt_hash': '7' * 64, 'artifact_receipt_hash': '8' * 64} if build else {
                'execution_work_id': 'b' * 32, 'execution_step_index': 0, 'capability_id': 'python.run',
                'input_hash': '9' * 64, 'output_hash': 'a' * 64, 'accepted_receipt_hash': 'b' * 64,
                'snapshot_receipt_hash': 'c' * 64, 'execution_receipt_hash': 'd' * 64, 'result_receipt_hash': 'e' * 64})}
            receipt = facts['artifact_receipt_hash' if requirement == 'artifact' else 'validation_receipt_hash'] if build else facts['result_receipt_hash']
            self.records[requirement] = {'concept_id': self.concept['id'], 'requirement': requirement,
                'artifact_id': str(uuid.uuid4()), 'artifact_sha256': common['artifact_digest'], 'receipt_hash': receipt,
                'evidence_type': 'validated-build' if build else 'execution-receipt', 'facts': facts}

    def decide(self, records=None, target='stabilization'):
        records = records or self.records
        references = [{key: value for key, value in record.items() if key in {'requirement', 'artifact_id', 'artifact_sha256', 'receipt_hash'}} for record in records.values()]
        return validate_transition(self.concept, {'transition_id': str(uuid.uuid4()), 'to_stage': target, 'evidence': references},
                                   resolve_evidence=lambda reference: records[reference['requirement']])

    def test_one_exact_publication_cohort_and_fresh_execution_can_enter_stabilization(self):
        original = deepcopy(self.records)
        result = self.decide()
        self.assertTrue(result['allowed'], result)
        self.assertEqual(result['to_stage'], 'stabilization')
        self.assertEqual(self.records, original)
        self.assertFalse(self.decide(target='maturation')['allowed'])

    def test_cross_publication_or_runtime_or_cohort_cannot_be_combined(self):
        for field, value in [('source_work_id', 'c' * 32), ('build_step_index', 3), ('source_sha256', 'a' * 64),
                             ('contract_sha256', 'b' * 64), ('driver_sha256', 'c' * 64), ('runtime_digest', 'd' * 64),
                             ('acceptance_cohort_sha256', 'e' * 64)]:
            records = deepcopy(self.records); records['instrumentation']['facts'][field] = value
            with self.subTest(field=field):
                self.assertFalse(self.decide(records)['allowed'])

    def test_current_and_mixed_readers_use_their_own_step_bounds(self):
        for publication_verifier, publication_step, execution_verifier, execution_step in (
                ('yur.generated-evidence.v2', 127, 'yur.generated-evidence.v2', 127),
                ('yur.generated-evidence.v1', 19, 'yur.generated-evidence.v2', 127),
                ('yur.generated-evidence.v2', 127, 'yur.generated-evidence.v1', 19)):
            records = deepcopy(self.records)
            for record in records.values():
                record['facts'].update(evidence_verifier=publication_verifier, build_step_index=publication_step)
            facts = records['instrumentation']['facts']
            facts.update(execution_verifier=execution_verifier, execution_step_index=execution_step)
            self.assertTrue(self.decide(records)['allowed'])
            facts['execution_step_index'] = 20 if execution_verifier.endswith('.v1') else 128
            self.assertFalse(self.decide(records)['allowed'])
        records = deepcopy(self.records)
        for record in records.values():
            record['facts']['build_step_index'] = 20
        self.assertFalse(self.decide(records)['allowed'])

    def test_forge_case_or_reused_validation_receipt_cannot_be_instrumentation(self):
        cases = [{'execution_work_id': 'a' * 32, 'execution_step_index': 2},
                 {'result_receipt_hash': '7' * 64}, {'execution_receipt_hash': 'b' * 64},
                 {'capability_id': 'anything'}, {'execution_step_index': True}, {'input_hash': 'invalid'},
                 {'evidence_verifier': 'future'}, {'unverified_passed': True}]
        for changes in cases:
            records = deepcopy(self.records); record = records['instrumentation']; record['facts'].update(changes)
            if 'result_receipt_hash' in changes:
                record['receipt_hash'] = changes['result_receipt_hash']
            with self.subTest(changes=changes):
                self.assertFalse(self.decide(records)['allowed'])

    def test_wrong_receipt_anchor_or_missing_build_requirement_remains_denied(self):
        records = deepcopy(self.records); records['build_log']['receipt_hash'] = '8' * 64
        self.assertFalse(self.decide(records)['allowed'])
        del records['build_log']
        self.assertFalse(self.decide(records)['allowed'])

    def test_work_version_union_rejects_mixed_or_incomplete_shapes(self):
        base = {'id': str(uuid.uuid4()), 'ordinal': 1, 'parent_version_id': None, 'created_at': 'now',
                'artifact_sha256': 'a' * 64, 'runtime_sha256': 'b' * 64,
                'validation_receipt_hash': 'c' * 64, 'artifact_receipt_hash': 'd' * 64}
        legacy = {**base, 'build_mission_id': 'e' * 32}
        generated = {**base, 'kind': 'generated_python', 'source_work_id': 'e' * 32, 'build_step_index': 0,
                     'source_sha256': 'f' * 64, 'contract_sha256': '1' * 64, 'driver_sha256': '2' * 64,
                     'acceptance_cohort_sha256': '3' * 64, 'evidence_verifier': 'yur.generated-evidence.v1'}
        work_concepts._validate_versions({'versions': [legacy, generated]})
        work_concepts._validate_versions({'versions': [{**generated, 'evidence_verifier': 'yur.generated-evidence.v2', 'build_step_index': 127}]})
        bad = [{**generated, 'build_mission_id': 'e' * 32}, {**legacy, 'kind': 'generated_python'},
               {**generated, 'build_step_index': 20}, {**generated, 'evidence_verifier': 'future'},
               {key: value for key, value in generated.items() if key != 'contract_sha256'}]
        for version in bad:
            with self.assertRaises(ValueError):
                work_concepts._validate_versions({'versions': [version]})


if __name__ == '__main__':
    unittest.main()
