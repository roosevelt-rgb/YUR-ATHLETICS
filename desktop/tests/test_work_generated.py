"""Manager/commit/recovery checks with explicit synthetic cell/model adapters.

These tests do not execute candidate code on the host or claim native runtime
acceptance. Separate opt-in cell/native tests cover real process execution.
"""
import ast
import base64
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from foundry import execution_cell, generated_contracts, generated_worker, work_generated
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_engine import AUTHORITY
from foundry.work_store import now
from foundry.work_cli import _event_summaries, handle, validate_rpc


def contract():
    return {'schema': 'yur.python-specialist-contract.v1', 'name': 'Independent integer doubling',
            'description': 'Return doubled as exactly twice the input value.',
            'input_schema': {'type': 'object', 'properties': {'value': {'type': 'integer', 'minimum': -100, 'maximum': 100}}, 'required': ['value'], 'additionalProperties': False},
            'output_schema': {'type': 'object', 'properties': {'doubled': {'type': 'integer', 'minimum': -200, 'maximum': 200}}, 'required': ['doubled'], 'additionalProperties': False},
            'cases': [{'id': 'negative', 'input': {'value': -7}, 'expected': {'doubled': -14}},
                      {'id': 'zero', 'input': {'value': 0}, 'expected': {'doubled': 0}},
                      {'id': 'positive', 'input': {'value': 19}, 'expected': {'doubled': 38}}]}


def cell_result(snapshot, output, *, raw=None, status='completed', exit_code=0):
    if raw is None:
        payload = base64.b64encode(work_generated.canonical(output)).decode('ascii')
        raw = work_generated.canonical({'schema': generated_worker.ENVELOPE_SCHEMA, 'payload': payload}).decode() + '\n'
    streams = {'stdout': raw, 'stderr': 'Synthetic outer-cell result for authority tests\n'}
    return {'schema': 'yur.execution-cell-result.v1', 'snapshot_id': snapshot['id'], 'profile': snapshot['profile'],
            'status': status, 'exit_code': exit_code, **streams,
            **{key + '_bytes': len(value.encode()) for key, value in streams.items()},
            **{key + '_sha256': hashlib.sha256(value.encode()).hexdigest() for key, value in streams.items()},
            'duration_ms': 1, 'scratch': 'discarded', 'limits': deepcopy(execution_cell.CELL_LIMITS),
            'runtime': {'architecture': 'x86_64', 'python': '3.12.3', 'libseccomp': '2.5.5',
                        'artifacts': {name: {'sha256': value} for name, value in execution_cell.RUNTIME_PINS.items()},
                        'bpf_sha256': execution_cell.BPF_SHA256,
                        'guardian_sha256': hashlib.sha256(execution_cell._guardian_program().encode()).hexdigest()}}


def snapshot_input(snapshot):
    source = next(item['content'] for item in snapshot['files'] if item['path'] == generated_worker.INPUT_FILE)
    return json.loads(ast.literal_eval(ast.parse(source).body[0].value))


class GeneratedWorkTests(unittest.TestCase):
    authority = AUTHORITY

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'project'; self.root.mkdir()
        self.path = self.root / 'contract.json'; self.path.write_text(json.dumps(contract()), encoding='utf-8')
        self.args = {'contract_path': 'contract.json', 'expected_sha256': hashlib.sha256(self.path.read_bytes()).hexdigest()}
        self.store = CommitService(Path(self.temp.name) / 'state'); self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        self.request = self.request_for()
        self.parent = self.store.submit_work(self.request, self.authority)
        self.update(status='running')
        self.model_calls, self.snapshots = [], []

    def request_for(self, mode='code'):
        return {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': mode,
                'goal': 'Generate the selected operator contract', 'root': str(self.root), 'provider': 'ollama', 'model': 'fixture',
                'messages': [{'role': 'user', 'content': 'Private conversation text must not enter candidate contexts'}]}

    def update(self, **changes):
        document = {key: deepcopy(value) for key, value in self.parent.items() if key not in {'revision', 'receipt'}}
        document.update(changes, updated_at=now())
        self.parent = self.store.commit_work(document, self.parent['revision'], 'work.test.setup')

    def refresh(self):
        self.parent = self.store.get_work(self.parent['id'])

    def model(self, messages, catalog):
        self.model_calls.append(deepcopy(messages))
        self.assertEqual([item['name'] for item in catalog], ['submit_python_candidate'])
        self.assertEqual(len(messages), 2)
        self.assertNotIn('cases', json.loads(messages[1]['content']))
        self.assertNotIn('Private conversation', str(messages))
        if len(self.model_calls) % 2:
            source = "def run(payload):\n    return {'doubled': payload['value'] * 2}\n"
        else:
            source = "def twice(value):\n    return value + value\ndef run(payload):\n    return {'doubled': twice(payload['value'])}\n"
        return {'content': '', 'tool_calls': [{'function': {'name': 'submit_python_candidate', 'arguments': {'source': source}}}]}

    def runner(self, snapshot, **_kwargs):
        self.snapshots.append(deepcopy(snapshot))
        self.assertTrue(any(event['event_type'] == work_generated.SNAPSHOT and event['data']['change']['snapshot'] == snapshot
                            for event in self.store.work_events(self.parent['id'])))
        value = snapshot_input(snapshot)['value']
        return cell_result(snapshot, {'doubled': value * 2})

    def invoke(self, name='forge_python_specialist', args=None, **kwargs):
        with self.store.acquire_worker():
            return work_generated.execute(self.manager, self.parent, name, args if args is not None else self.args,
                model_adapter=kwargs.get('model', self.model), runner=kwargs.get('runner', self.runner))

    def build(self):
        result = self.invoke(); self.refresh(); return result

    def next_parent(self):
        self.parent = self.store.submit_work(self.request_for(), self.authority); self.update(status='running')

    def quantity_build(self):
        raw = (Path(__file__).resolve().parents[1] / 'examples' / 'quantity-rollup.specialist.json').read_bytes()
        self.path.write_bytes(raw)
        self.args['expected_sha256'] = hashlib.sha256(raw).hexdigest()
        cases = json.loads(raw)['cases']
        calls = []
        sources = ["def run(payload):\n    return {'groups': [], 'input_count': 0}\n",
                   "def empty():\n    return []\ndef run(payload):\n    return {'groups': empty(), 'input_count': 0}\n"]
        def model(_messages, _catalog):
            source = sources[len(calls)]; calls.append(source)
            return {'content': '', 'tool_calls': [{'function': {'name': 'submit_python_candidate', 'arguments': {'source': source}}}]}
        def runner(snapshot, **_kwargs):
            # Explicit synthetic outcome receipts, not host candidate execution.
            payload = snapshot_input(snapshot)
            expected = next(case['expected'] for case in cases if case['input'] == payload)
            return cell_result(snapshot, expected)
        built = self.invoke(model=model, runner=runner); self.refresh()
        args = {'source_work_id': self.parent['id'], 'build_step_index': 0,
                'artifact_sha256': built['artifact']['sha256'], 'input': {'lines': [
                    {'code': '26', 'quantity': 7, 'unit': 'EA'}, {'code': '03', 'quantity': 12, 'unit': 'SF'},
                    {'code': '03', 'quantity': 9, 'unit': 'LF'}, {'code': '26', 'quantity': 5, 'unit': 'EA'},
                    {'code': '03', 'quantity': 8, 'unit': 'SF'}, {'code': '01', 'quantity': 0, 'unit': 'EA'}]}}
        expected = {'groups': [{'code': '01', 'quantity': 0, 'unit': 'EA'},
                               {'code': '03', 'quantity': 9, 'unit': 'LF'},
                               {'code': '03', 'quantity': 20, 'unit': 'SF'},
                               {'code': '26', 'quantity': 12, 'unit': 'EA'}], 'input_count': 6}
        self.next_parent()
        return args, expected

    def test_nested_quantity_input_reaches_exact_published_contract_and_cell(self):
        args, expected = self.quantity_build(); original = deepcopy(args); cells = []
        authority = deepcopy(self.parent['authority'])
        def runner(snapshot, **_kwargs):
            self.assertEqual(snapshot_input(snapshot), original['input']); cells.append(snapshot['id'])
            return cell_result(snapshot, expected)
        result = self.invoke('run_python_specialist', args, runner=runner)
        self.assertEqual(result['status'], 'recorded'); self.assertEqual(result['output'], expected)
        self.assertEqual(len(cells), 1); self.assertEqual(args, original)
        self.refresh(); self.assertEqual(self.parent['authority'], authority)
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_nested_unknown_fields_and_types_reject_before_acceptance_or_cell(self):
        args, _expected = self.quantity_build()
        invalid = [dict(args['input']['lines'][0], extra=True),
                   dict(args['input']['lines'][0], quantity=True),
                   dict(args['input']['lines'][0], quantity='7'),
                   dict(args['input']['lines'][0], code=None)]
        for line in invalid:
            with self.subTest(line=line), self.assertRaises(ValueError):
                self.invoke('run_python_specialist', {**args, 'input': {'lines': [line]}},
                            runner=lambda *_a, **_k: self.fail('Invalid input cannot enter a cell'))
        self.assertFalse(any(event['event_type'].startswith(work_generated.PREFIX)
                             for event in self.store.work_events(self.parent['id'])))

    def test_nested_argument_envelope_keeps_strict_identifiers_and_json_budgets(self):
        base = {'source_work_id': 'a'*32, 'build_step_index': 0, 'artifact_sha256': 'b'*64,
                'input': {'nested': [{'zero': 0, 'null': None, 'boolean': False, 'text': 'ok', 'number': 1.5}]}}
        work_generated.validate_arguments('run_python_specialist', base)
        deep = {}; at = deep
        for _ in range(10): at['child'] = {}; at = at['child']
        cyclic = {}; cyclic['self'] = cyclic
        invalid = [{**base, 'authority': AUTHORITY}, {**base, 'source_work_id': 'G'*32},
                   {**base, 'artifact_sha256': 'G'*64}, {**base, 'build_step_index': True},
                   {**base, 'input': []}, {**base, 'input': {'value': float('nan')}},
                   {**base, 'input': {'value': 'sk-' + 'Q'*48}},
                   {**base, 'input': {'value': ('not', 'json')}}, {**base, 'input': deep},
                   {**base, 'input': cyclic}, {**base, 'input': {'a': 'x'*8000, 'b': 'x'*8000, 'c': 'x'*400}}]
        for arguments in invalid:
            with self.assertRaises(ValueError): work_generated.validate_arguments('run_python_specialist', arguments)
        missing = dict(base); del missing['input']
        with self.assertRaises(ValueError): work_generated.validate_arguments('run_python_specialist', missing)

    def test_nested_zero_null_and_scalar_values_still_use_exact_schema(self):
        schema = {'type': 'object', 'properties': {'values': {'type': 'object', 'properties': {
            'zero': {'type': 'integer', 'minimum': 0, 'maximum': 0}, 'none': {'type': 'null'},
            'flag': {'type': 'boolean'}, 'text': {'type': 'string', 'maxLength': 4},
            'array': {'type': 'array', 'items': {'type': 'null'}, 'maxItems': 2}},
            'required': ['zero', 'none', 'flag', 'text', 'array'], 'additionalProperties': False}},
            'required': ['values'], 'additionalProperties': False}
        c = contract(); c['input_schema'] = schema
        payload = {'values': {'zero': 0, 'none': None, 'flag': False, 'text': '', 'array': [None]}}
        c['cases'] = [{'id': f'case-{index}',
                       'input': {'values': {**payload['values'], 'text': str(index)}},
                       'expected': {'doubled': 0}} for index in range(3)]
        args = {'source_work_id': 'a'*32, 'build_step_index': 0, 'artifact_sha256': 'b'*64, 'input': payload}
        work_generated.validate_arguments('run_python_specialist', args)
        self.assertEqual(generated_contracts.validate_input(c, payload), payload)
        for field, value in [('zero', False), ('none', 0), ('flag', 0), ('array', [False])]:
            changed = deepcopy(payload); changed['values'][field] = value
            with self.assertRaises(ValueError): generated_contracts.validate_input(c, changed)

    def test_maximum_payload_nodes_are_not_recounted_in_accepted_and_result_envelopes(self):
        schema = {'type': 'object', 'properties': {'rows': {'type': 'array', 'maxItems': 128,
                  'items': {'type': 'array', 'maxItems': 128,
                            'items': {'type': 'number', 'minimum': 0, 'maximum': 2}}}},
                  'required': ['rows'], 'additionalProperties': False}
        c = contract(); c['input_schema'] = schema
        c['cases'] = [{'id': f'nodes-{n}', 'input': {'rows': [[n]]}, 'expected': {'doubled': 0}} for n in range(3)]
        self.path.write_text(json.dumps(c), encoding='utf-8')
        self.args['expected_sha256'] = hashlib.sha256(self.path.read_bytes()).hexdigest()
        def runner(snapshot, **_kwargs):
            return cell_result(snapshot, {'doubled': 0})
        built = self.invoke(runner=runner); self.refresh(); source_id = self.parent['id']; self.next_parent()
        # Three root/key/array nodes, 47 inner arrays and 5,950 numbers = 6,000.
        payload = {'rows': [[0]*128 for _ in range(46)] + [[0]*62]}
        generated_contracts.validate_input(c, payload)
        args = {'source_work_id': source_id, 'build_step_index': 0,
                'artifact_sha256': built['artifact']['sha256'], 'input': payload}
        with self.assertRaisesRegex(ValueError, 'node budget'):
            generated_contracts.outputs_equal(args, args)
        original = self.store.commit_work_checkpoint
        def interrupted(document, revision, kind, change=None):
            result = original(document, revision, kind, change)
            if kind == work_generated.ACCEPTED: raise OSError('Lost maximum-node acceptance acknowledgment')
            return result
        with patch.object(self.store, 'commit_work_checkpoint', side_effect=interrupted):
            with self.assertRaises(RuntimeError): self.invoke('run_python_specialist', args, runner=runner)
        self.refresh()
        self.assertEqual(work_generated.pending_call(self.manager, self.parent)['function']['arguments'], args)
        result = self.invoke('run_python_specialist', args, runner=runner); self.refresh()
        self.assertEqual(result['output'], {'doubled': 0})
        replay = self.invoke('run_python_specialist', args, runner=lambda *_a, **_k: self.fail('No committed result rerun'))
        self.assertEqual(replay, result)
        changed = deepcopy(args); changed['input']['rows'][0][0] = 0.0
        with self.assertRaises(RuntimeError): self.invoke('run_python_specialist', changed, runner=runner)

    def test_nested_accepted_cell_and_result_recover_after_reopen_without_reexecution(self):
        for boundary in (work_generated.ACCEPTED, work_generated.CELL, work_generated.RESULT):
            with self.subTest(boundary=boundary):
                args, expected = self.quantity_build(); cells = []; original = self.store.commit_work_checkpoint
                def runner(snapshot, **_kwargs):
                    cells.append(snapshot['id']); return cell_result(snapshot, expected)
                def interrupted(document, revision, kind, change=None):
                    result = original(document, revision, kind, change)
                    if kind == boundary: raise OSError('Synthetic lost nested execution acknowledgment')
                    return result
                with patch.object(self.store, 'commit_work_checkpoint', side_effect=interrupted):
                    with self.assertRaises(RuntimeError): self.invoke('run_python_specialist', args, runner=runner)
                identity = self.parent['id']; authority = deepcopy(self.parent['authority']); self.store.close()
                self.store = CommitService(Path(self.temp.name) / 'state'); self.addCleanup(self.store.close)
                self.manager = OrchestrationManager(self.store); self.parent = self.store.get_work(identity)
                self.path.unlink()
                self.assertEqual(work_generated.pending_call(self.manager, self.parent)['function']['arguments'], args)
                with patch.object(work_generated, '_resolve', wraps=work_generated._resolve) as resolution, \
                     patch.object(generated_contracts, 'validate_input', wraps=generated_contracts.validate_input) as input_check:
                    result = self.invoke('run_python_specialist', args, model=lambda *_: self.fail('No model replay'),
                        runner=runner if boundary == work_generated.ACCEPTED else lambda *_a, **_k: self.fail('No cell replay'))
                    if boundary == work_generated.RESULT:
                        resolution.assert_not_called(); input_check.assert_not_called()
                    else:
                        self.assertTrue(resolution.called); self.assertTrue(input_check.called)
                self.assertEqual(result['output'], expected); self.assertEqual(len(cells), 1)
                self.refresh(); self.assertEqual(self.parent['authority'], authority)
                with patch.object(work_generated, '_resolve', side_effect=AssertionError('No completed-result readmission')), \
                     patch.object(generated_contracts, 'validate_input', side_effect=AssertionError('No completed-result contract revalidation')):
                    replay = self.invoke('run_python_specialist', args, runner=lambda *_a, **_k: self.fail('No replay'))
                self.assertEqual(replay, result)
                events = self.store.work_events(identity)
                self.assertEqual(sum(e['event_type'] == work_generated.CELL for e in events), 1)
                self.assertEqual(sum(e['event_type'] == work_generated.RESULT for e in events), 1)
                self.assertTrue(self.store.verify_integrity()['passed'])
                self.next_parent()

    def test_freezes_contract_before_blind_generation_and_publishes_after_external_cases(self):
        def model(messages, catalog):
            self.assertTrue(any(event['event_type'] == work_generated.ACCEPTED for event in self.store.work_events(self.parent['id'])))
            return self.model(messages, catalog)
        result = self.invoke(model=model)
        self.assertEqual(result['status'], 'published'); self.assertEqual(len(self.model_calls), 2); self.assertEqual(len(self.snapshots), 6)
        self.assertTrue(all(item['passed'] for item in result['validation']['candidates']))
        self.assertEqual(result['validation']['selected_strategy'], 'direct')
        events = self.store.work_events(self.parent['id'])
        publication = next(event for event in events if event['event_type'] == work_generated.PUBLISHED)
        self.assertTrue(all(event['id'] < publication['id'] for event in events if event['event_type'] == work_generated.EVALUATED))
        self.assertEqual(result['provenance']['result_receipt'], events[-1]['hash'])
        self.assertTrue(self.store.verify_integrity()['passed'])
        self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_wrong_outputs_never_publish_even_with_successful_process(self):
        result = self.invoke(runner=lambda snapshot, **kwargs: cell_result(snapshot, {'doubled': 123}))
        self.assertEqual(result['status'], 'rejected'); self.assertIsNone(result['artifact'])
        self.assertIn('No candidate passed', result['validation']['qualification'])
        self.assertFalse(any(event['event_type'] == work_generated.PUBLISHED for event in self.store.work_events(self.parent['id'])))

    def test_worker_printed_pass_and_stdout_pollution_cannot_self_certify(self):
        for raw in ('PASSED\n', '{"passed":true}\n', 'extra\n' + cell_result(generated_worker.prepare_worker_snapshot('def run(x):\n return x\n', {}), {})['stdout']):
            with self.subTest(raw=raw[:30]):
                self.next_parent()
                result = self.invoke(runner=lambda snapshot, **kwargs: cell_result(snapshot, {}, raw=raw))
                self.assertEqual(result['status'], 'rejected')

    def test_duplicate_candidates_are_rejected_without_changing_first_candidate(self):
        def same(messages, catalog):
            return {'tool_calls': [{'function': {'name': 'submit_python_candidate', 'arguments': {'source': "def run(x):\n return {'doubled': x['value']*2}\n"}}}]}
        result = self.invoke(model=same)
        self.assertEqual(result['status'], 'published'); self.assertEqual(len(self.snapshots), 3)
        self.assertFalse(result['validation']['candidates'][1]['passed'])
        self.assertIn('duplicates', result['validation']['candidates'][1]['error'])

    def test_changed_or_self_proposed_contract_rejected_before_models_or_acceptance(self):
        for args in ({**self.args, 'expected_sha256': '0'*64}, {**self.args, 'contract_path': '../contract.json'}):
            with self.assertRaises(ValueError): self.invoke(args=args)
        self.update(artifacts=[{'id': uuid.uuid4().hex, 'proposal': {'path': 'contract.json', 'kind': 'edit'}, 'status': 'proposed'}])
        with self.assertRaisesRegex(ValueError, 'own acceptance'): self.invoke()
        self.assertFalse(self.model_calls)
        self.assertFalse(any(event['event_type'] == work_generated.ACCEPTED for event in self.store.work_events(self.parent['id'])))

    def test_replay_returns_exact_result_without_models_cells_or_source_acquisition(self):
        first = self.build(); self.path.write_text('changed source', encoding='utf-8')
        with patch.object(work_generated, '_contract', side_effect=AssertionError('No reacquisition')):
            second = self.invoke(model=lambda *_: self.fail('No model replay'), runner=lambda *_args, **_kwargs: self.fail('No cell replay'))
        self.assertEqual(first, second)

    def test_exported_or_reformatted_same_mission_artifact_cannot_supply_oracle(self):
        from foundry.work_tools import execute_tool
        original = self.path.read_text(encoding='utf-8')
        artifact = execute_tool('create_artifact', {'name': 'contract.json', 'media_type': 'application/json',
                                                   'content': json.dumps(json.loads(original), separators=(',', ':'))}, self.root)['proposal']
        self.update(artifacts=[{'id': uuid.uuid4().hex, 'proposal': artifact, 'status': 'committed'}])
        with self.assertRaisesRegex(ValueError, 'same-mission model artifact'):
            self.invoke()
        self.assertFalse(self.model_calls)

    def test_cell_acknowledgment_loss_resumes_committed_result_without_rerunning_that_cell(self):
        original = self.store.commit_work_checkpoint
        lost = [False]
        def interrupted(document, revision, kind, change=None):
            result = original(document, revision, kind, change)
            if kind == work_generated.CELL and not lost[0]:
                lost[0] = True; raise OSError('Lost one committed acknowledgment')
            return result
        with patch.object(self.store, 'commit_work_checkpoint', side_effect=interrupted):
            with self.assertRaises(RuntimeError): self.invoke()
        self.refresh(); self.path.write_text('source changed after acceptance', encoding='utf-8')
        # Actually close/reopen persistence after the lost acknowledgment.
        identity = self.parent['id']; self.store.close()
        self.store = CommitService(Path(self.temp.name) / 'state'); self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store); self.parent = self.store.get_work(identity)
        self.assertEqual(work_generated.pending_call(self.manager, self.parent)['function']['arguments'], self.args)
        result = self.invoke()
        self.assertEqual(result['status'], 'published'); self.assertEqual(len(self.snapshots), 6); self.assertEqual(len(self.model_calls), 2)

    def test_publication_acknowledgment_loss_recovers_without_new_candidates_or_cells(self):
        original = self.store.commit_work_checkpoint
        def interrupted(document, revision, kind, change=None):
            result = original(document, revision, kind, change)
            if kind == work_generated.PUBLISHED: raise ValueError('Lost publication acknowledgment')
            return result
        with patch.object(self.store, 'commit_work_checkpoint', side_effect=interrupted):
            with self.assertRaises(RuntimeError): self.invoke()
        self.refresh()
        result = self.invoke(model=lambda *_: self.fail('No model'), runner=lambda *_args, **_kwargs: self.fail('No execution'))
        self.assertEqual(result['status'], 'published')
        self.assertEqual(sum(event['event_type'] == work_generated.PUBLISHED for event in self.store.work_events(self.parent['id'])), 1)

    def test_saved_discovery_and_new_input_execute_the_same_retained_code(self):
        built = self.build(); source_id = self.parent['id']; self.next_parent()
        page = self.invoke('list_python_specialists', {'limit': 1})
        self.assertEqual(len(page['entries']), 1); entry = page['entries'][0]
        self.assertEqual(entry['artifact_sha256'], built['artifact']['sha256'])
        result = self.invoke('run_python_specialist', {'source_work_id': source_id, 'build_step_index': 0,
                    'artifact_sha256': entry['artifact_sha256'], 'input': {'value': 23}})
        self.assertEqual(result['output'], {'doubled': 46}); self.assertEqual(result['status'], 'recorded')
        self.assertEqual(len(self.model_calls), 2); self.assertEqual(len(self.snapshots), 7)
        self.assertEqual(result['selection']['published_receipt'], entry['published_receipt'])

    def test_unseen_output_schema_failure_is_retained_without_claiming_success(self):
        built = self.build(); source_id = self.parent['id']; self.next_parent()
        result = self.invoke('run_python_specialist', {'source_work_id': source_id, 'build_step_index': 0,
                    'artifact_sha256': built['artifact']['sha256'], 'input': {'value': 3}},
                    runner=lambda snapshot, **kwargs: cell_result(snapshot, {'wrong': True}))
        self.assertEqual(result['status'], 'rejected'); self.assertIsNone(result['output']); self.assertTrue(result['committed'])
        self.assertEqual(result['execution']['exit_code'], 0)

    def test_changed_driver_or_published_digest_is_not_reused(self):
        built = self.build(); source_id = self.parent['id']; self.next_parent()
        args = {'source_work_id': source_id, 'build_step_index': 0, 'artifact_sha256': '0'*64, 'input': {'value': 2}}
        with self.assertRaises(ValueError): self.invoke('run_python_specialist', args)
        args['artifact_sha256'] = built['artifact']['sha256']
        with patch.object(generated_worker, 'DRIVER_SHA256', '0'*64):
            with self.assertRaises(ValueError): self.invoke('run_python_specialist', args)
        self.assertEqual(len(self.snapshots), 6)

    def test_false_retained_evaluation_is_rederived_before_publication(self):
        original = self.store.commit_work_checkpoint
        lost = [False]
        def interrupted(document, revision, kind, change=None):
            result = original(document, revision, kind, change)
            if kind == work_generated.EVALUATED and not lost[0]:
                lost[0] = True; raise OSError('Lost evaluation acknowledgment')
            return result
        with patch.object(self.store, 'commit_work_checkpoint', side_effect=interrupted):
            with self.assertRaises(RuntimeError): self.invoke(runner=lambda snap, **kw: cell_result(snap, {'doubled': 123}))
        self.refresh()
        events = self.store.work_events
        def changed(identity):
            copied = events(identity)
            for event in copied:
                if event['event_type'] == work_generated.EVALUATED:
                    event['data']['change']['passed'] = True; event['data']['change']['error'] = ''
            return copied
        with patch.object(self.store, 'work_events', side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, 'Retained acceptance decision'):
                self.invoke()
        self.assertFalse(any(event['event_type'] == work_generated.PUBLISHED for event in events(self.parent['id'])))

    def test_empty_readonly_rpc_never_creates_state_and_rejects_authority(self):
        root = Path(self.temp.name) / 'absent-library'
        request = {'command': 'list_generated_specialists', 'limit': 20, 'cursor': None}
        with patch('foundry.work_cli.state_root', return_value=root):
            self.assertEqual(handle(request), {'entries': [], 'scanned': 0, 'excluded': 0, 'next_cursor': None, 'coverage_limited': False})
        self.assertFalse(root.exists())
        for step in (0, 19, 20, 99, 100, 127):
            validate_rpc({**request, 'cursor': 'a'*32 + ':' + str(step)})
        for changed in ({**request, 'authority': {}}, {**request, 'limit': True}, {**request, 'cursor': 'a'*32 + ':128'}):
            with self.assertRaises(ValueError): validate_rpc(changed)

    def test_discovery_cursor_preserves_multiple_builds_in_same_parent_and_byte_budget(self):
        identity = self.parent['id']
        artifact = {'name': 'Sized schema', 'description': 'Synthetic large metadata for pagination test',
                    'input_schema': {'text': 'x'*65000}, 'output_schema': {}, 'source_sha256': 'a'*64,
                    'contract_sha256': 'b'*64, 'driver_sha256': 'c'*64, 'validation': {}}
        events = [{'event_type': work_generated.PUBLISHED, 'data': {'change': {'step_index': index}}} for index in (20, 100, 127)]
        with patch.object(self.store, 'list_work', return_value=[{'id': identity}]), patch.object(self.store, 'work_events', return_value=events), \
             patch.object(work_generated, '_resolve', return_value=(artifact, {}, {'hash': 'd'*64})):
            first = work_generated.list_generated_specialists(self.manager, {'limit': 20})
            self.assertEqual(len(first['entries']), 1); self.assertEqual(first['next_cursor'], identity + ':20')
            second = work_generated.list_generated_specialists(self.manager, {'limit': 20, 'cursor': first['next_cursor']})
            self.assertEqual(second['entries'][0]['build_step_index'], 100); self.assertEqual(second['next_cursor'], identity + ':100')
            third = work_generated.list_generated_specialists(self.manager, {'limit': 20, 'cursor': second['next_cursor']})
            self.assertEqual(third['entries'][0]['build_step_index'], 127); self.assertIsNone(third['next_cursor'])
            self.assertLess(len(work_generated.canonical(first)), 128*1024)

    def test_event_summaries_do_not_expose_cases_source_or_raw_output(self):
        self.build()
        summaries = _event_summaries(self.store.work_events(self.parent['id']))
        for event in summaries:
            if event['event_type'].startswith(work_generated.PREFIX):
                self.assertFalse({'contract', 'candidate', 'source', 'snapshot', 'execution', 'artifact', 'result'} & set(event['change']))
        publication = next(event for event in summaries if event['event_type'] == work_generated.PUBLISHED)
        self.assertEqual(len(publication['change']['artifact_sha256']), 64)

    def test_work_mode_cannot_generate_or_run_cells_and_catalog_is_honest(self):
        self.assertEqual([item['name'] for item in work_generated.catalog('work')], ['list_python_specialists'])
        self.parent = self.store.submit_work(self.request_for('work'), AUTHORITY); self.update(status='running')
        with self.assertRaises(ValueError): self.invoke()
        self.assertFalse(self.model_calls)

    def test_actual_manager_continuation_and_reload_preserve_saved_operation(self):
        self.next_parent(); request = self.parent['request']
        # Start a fresh queued request through the actual manager, not setup state.
        request = self.request_for()
        count = [0]
        def model(messages, catalog):
            if catalog[0]['name'] == 'submit_python_candidate': return self.model(messages, catalog)
            count[0] += 1
            if count[0] == 1: return {'tool_calls': [{'function': {'name': 'forge_python_specialist', 'arguments': self.args}}], 'content': ''}
            return {'content': 'Actual finite acceptance completed.', 'tool_calls': []}
        def runner(snapshot, **kwargs):
            return cell_result(snapshot, {'doubled': snapshot_input(snapshot)['value'] * 2})
        with patch.object(execution_cell, 'run_snapshot', side_effect=runner):
            result = self.manager.run_work(request, model)
        self.assertEqual(result['status'], 'completed'); self.assertEqual(result['steps'][0]['result']['status'], 'published')
        restored = self.manager.run_work(request, lambda *_: self.fail('Completed Work must not call a model'))
        self.assertEqual({key: value for key, value in result.items() if key != 'receipt'}, restored)


if __name__ == '__main__':
    unittest.main()
