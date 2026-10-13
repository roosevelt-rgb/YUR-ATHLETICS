"""Historical reconstruction with real CommitService and synthetic cell receipts.

No model endpoint, worker code, WSL or process execution is used. The supplied
cell fixture is explicitly synthetic; these tests prove binding/reconstruction,
not physical runtime attestation. Native execution has separate opt-in tests.
"""
import ast
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from foundry import generated_evidence_v1 as evidence
from foundry import execution_cell, generated_contracts, generated_worker, work_generated
from foundry.commit_service import CommitService
import test_work_generated as fixtures

cell_result = fixtures.cell_result


class HistoricalGeneratedEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.GeneratedWorkTests()
        # These are historical records. Never borrow the current issuer's bound.
        self.fixture.authority = deepcopy(evidence._AUTHORITY)
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.built = self.fixture.build()
        self.source_id = self.fixture.parent['id']
        self.facts = evidence.resolve_publication(self.fixture.store, self.source_id, 0, self.built['artifact']['sha256'])

    def run_saved(self, value=17, **kwargs):
        self.fixture.next_parent()
        args = {'source_work_id': self.source_id, 'build_step_index': 0,
                'artifact_sha256': self.built['artifact']['sha256'], 'input': {'value': value}}
        result = self.fixture.invoke('run_python_specialist', args=args, **kwargs)
        return self.fixture.parent['id'], result

    def rewrite(self, mutation):
        """Rehash the actual fixture journal after an adversarial semantic change.

        Propagate event-hash references and projection hashes, so the historical
        resolver must reject semantics rather than merely a broken hash chain.
        """
        store = self.fixture.store
        events = [dict(row) for row in store._db.execute('SELECT * FROM work_events ORDER BY id')]
        replacements, previous, latest = {}, '0' * 64, {}
        def replace(value):
            if type(value) is str:
                return replacements.get(value, value)
            if type(value) is list:
                return [replace(item) for item in value]
            if type(value) is dict:
                return {key: replace(item) for key, item in value.items()}
            return value
        for event in events:
            old = event.pop('hash')
            event['data'] = json.loads(event['data'])
            mutation(event)
            event['data'] = replace(event['data'])
            event['previous_hash'] = previous
            event['state_digest'] = evidence._digest(event['data']['document'])
            new_hash = evidence._digest(event)
            replacements[old] = new_hash
            previous = new_hash
            store._db.execute('UPDATE work_events SET data=?,state_digest=?,previous_hash=?,hash=? WHERE id=?',
                (evidence._canonical(event['data']).decode(), event['state_digest'], event['previous_hash'], new_hash, event['id']))
            latest[event['mission_id']] = (event['data']['document'], event['revision'])
        for identity, (document, revision) in latest.items():
            store._db.execute('UPDATE work_missions SET document=?,revision=? WHERE id=?',
                              (evidence._canonical(document).decode(), revision, identity))

    def test_actual_publication_and_cross_mission_run_return_only_bounded_facts(self):
        run_id, result = self.run_saved()
        store = self.fixture.store
        changes = store._db.total_changes
        facts = evidence.resolve_publication(store, self.source_id, 0)
        execution = evidence.resolve_execution(store, facts, run_id, 0)
        self.assertEqual(store._db.total_changes, changes)
        self.assertEqual(facts['cases_total'], 3)
        self.assertEqual(facts['validation_receipt_hash'], facts['validation_cohort'][-1]['evaluation_receipt_hash'])
        self.assertEqual(facts['validation_cohort_sha256'], evidence._digest(facts['validation_cohort']))
        self.assertEqual(execution['output_hash'], evidence._digest({'doubled': 34}))
        self.assertEqual(execution['execution_receipt_hash'], result['execution_receipt'])
        self.assertEqual(execution['result_receipt_hash'], result['provenance']['result_receipt'])
        self.assertNotEqual(facts['publication_receipt_hash'], execution['execution_receipt_hash'])
        self.assertLess(len(evidence._canonical(facts)), 16384)
        serialized = evidence._canonical({'publication': facts, 'run': execution}).decode()
        for forbidden in ('def run(', 'Synthetic outer-cell', '"expected":', '"source":', '"output":', '"authority":'):
            self.assertNotIn(forbidden, serialized)

    def test_current_runtime_and_contract_changes_do_not_reinterpret_history(self):
        run_id, _ = self.run_saved()
        expected = evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0)
        with patch.object(generated_worker, 'DRIVER_SHA256', '0' * 64), \
             patch.object(generated_worker, 'DRIVER_SOURCE', 'changed current driver'), \
             patch.object(execution_cell, 'RUNTIME_PINS', {}), \
             patch.object(execution_cell, 'BPF_SHA256', '1' * 64), \
             patch.object(execution_cell, '_guardian_program', side_effect=AssertionError('No current guardian query')), \
             patch.object(execution_cell, 'run_snapshot', side_effect=AssertionError('No execution')), \
             patch.object(generated_worker, 'validate_worker_execution', side_effect=AssertionError('No current verifier')), \
             patch.object(generated_contracts, 'validate_contract', side_effect=AssertionError('No current contract semantics')):
            self.assertEqual(evidence.resolve_publication(self.fixture.store, self.source_id, 0), self.facts)
            self.assertEqual(evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0), expected)

    def test_close_reopen_with_deleted_source_requires_no_reacquisition(self):
        run_id, _ = self.run_saved()
        self.fixture.path.unlink()
        state = self.fixture.store.path.parent
        self.fixture.store.close()
        with CommitService(state) as reopened:
            self.assertEqual(evidence.resolve_publication(reopened, self.source_id, 0), self.facts)
            self.assertEqual(evidence.resolve_execution(reopened, self.facts, run_id, 0)['output_hash'], evidence._digest({'doubled': 34}))

    def test_fake_publication_facts_and_foreign_build_are_not_accepted_for_execution(self):
        run_id, _ = self.run_saved()
        for key, value in (('source_work_id', run_id), ('build_step_index', 1), ('artifact_sha256', 'f' * 64),
                           ('validation_cohort_sha256', 'f' * 64), ('runtime_sha256', 'f' * 64)):
            with self.subTest(key=key), self.assertRaises((ValueError, RuntimeError)):
                evidence.resolve_execution(self.fixture.store, {**self.facts, key: value}, run_id, 0)
        self.fixture.next_parent()
        second = self.fixture.build()
        other_facts = evidence.resolve_publication(self.fixture.store, self.fixture.parent['id'], 0, second['artifact']['sha256'])
        self.assertEqual(other_facts['artifact_sha256'], self.facts['artifact_sha256'])
        with self.assertRaises(ValueError):
            evidence.resolve_execution(self.fixture.store, other_facts, run_id, 0)

    def test_forge_cells_are_not_fresh_run_instrumentation(self):
        with self.assertRaises(ValueError):
            evidence.resolve_execution(self.fixture.store, self.facts, self.source_id, 0)

    def test_rejected_unseen_output_cannot_become_instrumentation(self):
        run_id, result = self.run_saved(runner=lambda snapshot, **kwargs: cell_result(snapshot, {'wrong': 34}))
        self.assertEqual(result['status'], 'rejected')
        with self.assertRaises(ValueError):
            evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0)

    def test_plain_event_tamper_fails_existing_commitservice_verification(self):
        self.fixture.store._db.execute("UPDATE work_events SET hash=? WHERE event_type=?", ('0' * 64, work_generated.PUBLISHED))
        with self.assertRaises(RuntimeError):
            evidence.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_candidate_change_fails_semantic_reconstruction(self):
        def mutate(event):
            if event['event_type'] == work_generated.CANDIDATE and event['data']['change']['strategy'] == 'direct':
                candidate = event['data']['change']['candidate']
                candidate['source'] += '# changed historical source\n'
                candidate['source_sha256'] = hashlib.sha256(candidate['source'].encode()).hexdigest()
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            evidence.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_case_input_change_cannot_reuse_previous_cell(self):
        def mutate(event):
            if event['event_type'] == work_generated.ACCEPTED:
                fields = event['data']['change']
                fields['contract']['cases'][0]['input']['value'] = -6
                fields['contract_sha256'] = evidence._digest(fields['contract'])
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            evidence.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_case_expected_change_cannot_self_approve(self):
        def mutate(event):
            if event['event_type'] == work_generated.ACCEPTED:
                fields = event['data']['change']
                fields['contract']['cases'][0]['expected']['doubled'] = -13
                fields['contract_sha256'] = evidence._digest(fields['contract'])
        self.rewrite(mutate)
        with self.assertRaises(ValueError):
            evidence.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_case_label_and_claimed_decision_tamper_are_detected(self):
        def mutate(event):
            if event['event_type'] == work_generated.EVALUATED:
                event['data']['change']['case_id'] = 'forged-case'
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            evidence.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_pinned_runtime_tamper_is_not_current_admission(self):
        def mutate(event):
            if event['event_type'] == work_generated.CELL:
                event['data']['change']['execution']['runtime']['guardian_sha256'] = 'f' * 64
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            evidence.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_rehashed_run_result_output_cannot_replace_actual_cell(self):
        run_id, _ = self.run_saved()
        def mutate(event):
            if event['mission_id'] == run_id and event['event_type'] == work_generated.RESULT:
                event['data']['change']['result']['output']['doubled'] = 35
        self.rewrite(mutate)
        with self.assertRaises(ValueError):
            evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0)

    def test_rejected_duplicate_candidate_keeps_valid_cohort_available(self):
        self.fixture.next_parent()
        def same(messages, catalog):
            return {'tool_calls': [{'function': {'name': 'submit_python_candidate', 'arguments':
                {'source': "def run(x):\n return {'doubled': x['value'] * 2}\n"}}}]}
        built = self.fixture.invoke(model=same)
        facts = evidence.resolve_publication(self.fixture.store, self.fixture.parent['id'], 0, built['artifact']['sha256'])
        self.assertEqual(facts['cases_total'], 3)

    def test_publication_survives_lost_ack_without_claiming_missing_result(self):
        self.fixture.next_parent()
        original = self.fixture.store.commit_work_checkpoint
        def interrupted(document, revision, kind, change=None):
            value = original(document, revision, kind, change)
            if kind == work_generated.PUBLISHED:
                raise OSError('Synthetic lost publication acknowledgment')
            return value
        with patch.object(self.fixture.store, 'commit_work_checkpoint', side_effect=interrupted):
            with self.assertRaises(RuntimeError):
                self.fixture.invoke()
        events = self.fixture.store.work_events(self.fixture.parent['id'])
        self.assertFalse(any(event['event_type'] == work_generated.RESULT for event in events))
        count = len(events)
        facts = evidence.resolve_publication(self.fixture.store, self.fixture.parent['id'], 0)
        self.assertEqual(facts['cases_total'], 3)
        self.assertEqual(len(self.fixture.store.work_events(self.fixture.parent['id'])), count)

    def test_cell_without_committed_run_result_does_not_prove_instrumentation(self):
        original = self.fixture.store.commit_work_checkpoint
        def interrupted(document, revision, kind, change=None):
            if kind == work_generated.RESULT:
                raise OSError('Synthetic interruption before run result commit')
            return original(document, revision, kind, change)
        with patch.object(self.fixture.store, 'commit_work_checkpoint', side_effect=interrupted):
            with self.assertRaises(RuntimeError):
                self.run_saved()
        events = self.fixture.store.work_events(self.fixture.parent['id'])
        self.assertTrue(any(event['event_type'] == work_generated.CELL for event in events))
        self.assertFalse(any(event['event_type'] == work_generated.RESULT for event in events))
        with self.assertRaises(ValueError):
            evidence.resolve_execution(self.fixture.store, self.facts, self.fixture.parent['id'], 0)

    def test_rehashed_output_bytes_cannot_reuse_claimed_case_success(self):
        def mutate(event):
            if event['event_type'] == work_generated.CELL and event['data']['change']['cell_key'] == 'direct:0':
                change = event['data']['change']
                old = change['execution']
                change['execution'] = cell_result({'id': old['snapshot_id'], 'profile': old['profile']}, {'doubled': -13})
        self.rewrite(mutate)
        self.assertTrue(self.fixture.store.verify_integrity()['passed'])
        with self.assertRaises(ValueError):
            evidence.resolve_publication(self.fixture.store, self.source_id, 0)

    def test_worker_source_remains_inert_even_with_top_level_exception(self):
        self.fixture.next_parent()
        original = self.fixture.model
        def inert(messages, catalog):
            response = original(messages, catalog)
            arguments = response['tool_calls'][0]['function']['arguments']
            arguments['source'] = "raise RuntimeError('This source must never run on the host')\n" + arguments['source']
            return response
        built = self.fixture.invoke(model=inert)
        facts = evidence.resolve_publication(self.fixture.store, self.fixture.parent['id'], 0, built['artifact']['sha256'])
        self.assertEqual(facts['cases_total'], 3)
        # Synthetic cells are deliberately capable of describing impossible guest
        # outcomes. Historical reconstruction does not manufacture host attestation.

    def test_frozen_ast_formatter_matches_publisher_and_ignores_future_dump(self):
        samples = [
            "def run(payload):\n return {'doubled': payload['value'] * 2}\n",
            "def run(payload):\n values = [x * 2 for x in payload['items'] if x]\n return {'values': values}\n",
            "def run(payload):\n match payload:\n  case {'value': value}: return {'value': value}\n return {}\n",
            "def run(payload):\n try: return dict(value=payload.get('value', None))\n except (KeyError, TypeError): return {}\n",
            "def run(payload):\n def helper(value=0, *, factor=2): return value * factor\n return {'value': helper(payload['value'])}\n",
            "def run(payload):\n return {'value': f'{payload!r}', 'items': [], 'nil': None, 'flag': True}\n",
            "type Pair[T] = tuple[T, T]\ndef run(payload):\n return payload\n",
        ]
        for source in samples:
            tree = ast.parse(source, feature_version=(3, 12))
            self.assertEqual(evidence._ast_dump_v1(tree), ast.dump(tree, include_attributes=False))
        run_id, _ = self.run_saved()
        expected = evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0)
        with patch.object(ast, 'dump', side_effect=AssertionError('Future dump must not reinterpret historical hashes')):
            self.assertEqual(evidence.resolve_publication(self.fixture.store, self.source_id, 0), self.facts)
            self.assertEqual(evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0), expected)

    def test_bounds_and_current_module_imports_are_explicit(self):
        for identity, step in ((self.source_id, True), ('../state', 0), (self.source_id, 20)):
            with self.assertRaises(ValueError):
                evidence.resolve_publication(self.fixture.store, identity, step)
        source = Path(evidence.__file__).read_text(encoding='utf-8')
        tree = ast.parse(source)
        imports = [node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
        self.assertEqual(imports, ['copy'])
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                             and node.func.id in {'eval', 'exec', 'compile', '__import__'} for node in ast.walk(tree)))
        self.assertIn('generated_contracts.py', evidence.SOURCE_PROVENANCE)
        self.assertEqual(evidence.VERIFIER, 'yur.generated-evidence.v1')


class NestedQuantityHistoricalEvidenceTests(unittest.TestCase):
    """Real journal, real quantity contract, explicitly synthetic cell outcomes."""

    def setUp(self):
        self.fixture = fixtures.GeneratedWorkTests()
        self.fixture.authority = deepcopy(evidence._AUTHORITY)
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        path = Path(__file__).resolve().parents[1] / 'examples' / 'quantity-rollup.specialist.json'
        contract = json.loads(path.read_text(encoding='utf-8'))
        self.fixture.path.write_text(json.dumps(contract, ensure_ascii=False), encoding='utf-8')
        self.fixture.args['expected_sha256'] = hashlib.sha256(self.fixture.path.read_bytes()).hexdigest()
        self.payload = {'lines': [
            {'code': '03', 'unit': 'SF', 'quantity': 12},
            {'code': '03', 'unit': 'SF', 'quantity': 8},
            {'code': '03', 'unit': 'LF', 'quantity': 4},
            {'code': '01', 'unit': 'EA', 'quantity': 0},
        ]}
        self.expected = {'groups': [
            {'code': '01', 'unit': 'EA', 'quantity': 0},
            {'code': '03', 'unit': 'LF', 'quantity': 4},
            {'code': '03', 'unit': 'SF', 'quantity': 20},
        ], 'input_count': 4}
        # Static, independently authored fixture outcomes. Candidate source stays
        # inert: these synthetic cells do not evaluate either implementation.
        self.outcomes = {evidence._canonical(case['input']): case['expected'] for case in contract['cases']}
        self.outcomes[evidence._canonical(self.payload)] = self.expected
        self.sources = [
            "def run(payload):\n    totals = {}\n    for line in payload['lines']:\n        key = (line['code'], line['unit'])\n        totals[key] = totals.get(key, 0) + line['quantity']\n    return {'groups': [{'code': k[0], 'unit': k[1], 'quantity': totals[k]} for k in sorted(totals)], 'input_count': len(payload['lines'])}\n",
            "def aggregate(lines):\n    totals = {}\n    for row in lines:\n        key = (row['code'], row['unit'])\n        totals[key] = totals.get(key, 0) + row['quantity']\n    return [{'code': code, 'unit': unit, 'quantity': quantity} for (code, unit), quantity in sorted(totals.items())]\ndef run(payload):\n    return {'groups': aggregate(payload['lines']), 'input_count': len(payload['lines'])}\n",
        ]
        self.model_calls, self.snapshots = [], []
        self.built = self.fixture.invoke(model=self.model, runner=self.runner)
        self.fixture.refresh()
        self.source_id = self.fixture.parent['id']
        self.facts = evidence.resolve_publication(self.fixture.store, self.source_id, 0, self.built['artifact']['sha256'])

    def model(self, messages, catalog):
        self.assertEqual([tool['name'] for tool in catalog], ['submit_python_candidate'])
        self.assertNotIn('cases', json.loads(messages[1]['content']))
        self.model_calls.append(deepcopy(messages))
        return {'content': '', 'tool_calls': [{'function': {'name': 'submit_python_candidate',
            'arguments': {'source': self.sources[len(self.model_calls) - 1]}}}]}

    def runner(self, snapshot, **_kwargs):
        self.snapshots.append(deepcopy(snapshot))
        payload = fixtures.snapshot_input(snapshot)
        return cell_result(snapshot, deepcopy(self.outcomes[evidence._canonical(payload)]))

    def arguments(self):
        return {'source_work_id': self.source_id, 'build_step_index': 0,
                'artifact_sha256': self.built['artifact']['sha256'], 'input': deepcopy(self.payload)}

    def never_run(self, *_args, **_kwargs):
        self.fail('Retained execution must not regenerate or execute a cell')

    def test_nested_quantity_history_and_result_replay_survive_reopen(self):
        self.fixture.next_parent()
        args = self.arguments()
        result = self.fixture.invoke('run_python_specialist', args, runner=self.runner)
        self.assertEqual(result['status'], 'recorded')
        self.assertEqual(result['output'], self.expected)
        self.fixture.refresh()
        run_id = self.fixture.parent['id']
        self.assertEqual(work_generated.pending_call(self.fixture.manager, self.fixture.parent)['function']['arguments'], args)
        facts = evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0)
        self.assertEqual(facts['input_hash'], evidence._digest(self.payload))
        self.assertEqual(facts['output_hash'], evidence._digest(self.expected))
        self.assertEqual(facts['result_receipt_hash'], result['provenance']['result_receipt'])
        before = self.fixture.store.work_events(run_id)
        self.fixture.path.unlink()
        state_root = self.fixture.store.path.parent
        self.fixture.store.close()
        self.fixture.store = CommitService(state_root)
        self.addCleanup(self.fixture.store.close)
        self.fixture.manager = fixtures.OrchestrationManager(self.fixture.store)
        self.fixture.refresh()
        with patch.object(work_generated, '_resolve', side_effect=AssertionError('No current resolution for completed replay')):
            replay = self.fixture.invoke('run_python_specialist', args, model=self.never_run, runner=self.never_run)
        self.assertEqual(replay, result)
        self.assertEqual(self.fixture.store.work_events(run_id), before)
        with patch.object(generated_contracts, 'validate_input', side_effect=AssertionError('Frozen contract required')), \
             patch.object(generated_contracts, 'validate_output', side_effect=AssertionError('Frozen contract required')), \
             patch.object(generated_worker, 'validate_worker_execution', side_effect=AssertionError('Frozen cell verifier required')):
            self.assertEqual(evidence.resolve_execution(self.fixture.store, self.facts, run_id, 0), facts)
        self.assertEqual(len(self.model_calls), 2)
        self.assertEqual(len(self.snapshots), 11)  # Two candidates x five cases, one fresh run.

    def test_nested_quantity_cell_acknowledgment_recovers_exact_input_without_rerun(self):
        for error in (ValueError, OSError):
            with self.subTest(error=error.__name__):
                self.fixture.next_parent()
                args = self.arguments()
                original = self.fixture.store.commit_work_checkpoint
                cells_before = len(self.snapshots)

                def interrupted(document, revision, kind, change=None):
                    committed = original(document, revision, kind, change)
                    if kind == work_generated.CELL:
                        raise error('Synthetic lost acknowledgment after actual cell receipt commit')
                    return committed

                with patch.object(self.fixture.store, 'commit_work_checkpoint', side_effect=interrupted), self.assertRaises(RuntimeError):
                    self.fixture.invoke('run_python_specialist', args, runner=self.runner)
                self.fixture.refresh()
                pending = work_generated.pending_call(self.fixture.manager, self.fixture.parent)
                self.assertEqual(pending['function']['arguments'], args)
                result = self.fixture.invoke('run_python_specialist', pending['function']['arguments'], runner=self.never_run)
                self.assertEqual(result['output'], self.expected)
                self.assertEqual(len(self.snapshots), cells_before + 1)
                events = [event for event in self.fixture.store.work_events(self.fixture.parent['id'])
                          if event['event_type'].startswith(work_generated.PREFIX)]
                self.assertEqual([event['event_type'] for event in events],
                                 [work_generated.ACCEPTED, work_generated.SNAPSHOT, work_generated.CELL, work_generated.RESULT])
                facts = evidence.resolve_execution(self.fixture.store, self.facts, self.fixture.parent['id'], 0)
                self.assertEqual(facts['input_hash'], evidence._digest(self.payload))
                self.assertEqual(facts['output_hash'], evidence._digest(self.expected))


if __name__ == '__main__':
    unittest.main()
