"""Immutable reconstruction of generated evidence under the exact 128-step envelope.

This revision changes only recorded Work authority and step bounds. Contract,
source, snapshot, cell, cohort and result semantics remain those of the sealed
v1 reader. It is historical interpretation, never current runtime admission.
Public readers enter the existing CommitService verified read transaction; they
never reacquire source files, query WSL, call providers or execute candidate code.
Local journal hashes prove consistency, not independent host authenticity.

The small authority-bound reader sections below are adapted from v1; unrelated
pure validation remains imported from that immutable revision. Never rewrite
old 20-step evidence, mutate v1 globals or follow current runtime constants.
"""
from copy import deepcopy
import ast
import hashlib
import re

from . import generated_evidence_v1 as v1
from .generated_evidence_v1 import (
    _canonical, _digest, _same, _keys, _sha, _find, _before, _cell, _output,
    _metadata, _result, _c_validate_contract, _c_contract_digest, _c_public_contract,
    _c_validate_input, _c_validate_output, _c_outputs_equal, _w_source, _ast_dump_v1,
    _PREFIX, _KINDS, _QUALIFICATION, _SELECTION, _RUNTIME_IDENTITY, V1_DRIVER_SHA256,
)

VERIFIER = 'yur.generated-evidence.v2'
_AUTHORITY = {'issuer': 'local-user', 'scope': 'work-proposals',
              'actions': ['read', 'compute', 'propose', 'commit-artifact'], 'max_steps': 128}
SOURCE_PROVENANCE = {'generated_evidence_v1.py': 'a50cfa20c3509760a64d0f1808225351b47f96e01b29287f3d011488db94af73'}


def _identity(mission, step):
    if type(mission) is not str or re.fullmatch('[0-9a-f]{32}', mission) is None or type(step) is not int or not 0 <= step < 128:
        raise ValueError('Select an exact Work identity and step index')


def _history(store, mission_id, step_index, tool):
    _identity(mission_id, step_index)
    work = store.get_work(mission_id)
    _same(work['authority'], _AUTHORITY)
    if work['request']['mode'] != 'code':
        raise ValueError('Generated evidence requires actual Code-origin Work')
    events = [event for event in store.work_events(mission_id) if event['event_type'].startswith(_PREFIX)
              and event['data']['change'].get('step_index') == step_index]
    if not 1 <= len(events) <= 56:
        raise ValueError('Historical generated boundary count exceeds the frozen generated limit')
    accepted = _find(events, 'accepted')
    change = accepted['data']['change']
    arguments = change['arguments']
    binding = {'step_index': step_index, 'tool': tool, 'input_hash': _digest(arguments)}
    for event in events:
        _keys(event, ('id', 'mission_id', 'revision', 'event_type', 'data', 'created_at', 'state_digest', 'previous_hash', 'hash'))
        if (event['event_type'][len(_PREFIX):] not in _KINDS or event['mission_id'] != mission_id
                or type(event['id']) is not int or event['id'] < 1 or len(_canonical(event)) > 2 * 1024 * 1024):
            raise ValueError('Invalid historical Work event identity or size')
        _sha(event['previous_hash'])
        _same(_digest({key: value for key, value in event.items() if key != 'hash'}), event['hash'])
        document, fields = event['data']['document'], event['data']['change']
        _same(_digest(document), event['state_digest'])
        _same(document['request'], work['request'])
        _same(document['authority'], _AUTHORITY)
        if document['id'] != mission_id or document['status'] != 'running' or len(document['steps']) != step_index:
            raise ValueError('Generated boundary is not from its exact running Work step')
        if any(type(fields.get(key)) is not type(value) or fields[key] != value for key, value in binding.items()):
            raise ValueError('Generated boundary differs from the accepted operation')
        if event is not accepted:
            _before(accepted, event)
    return work, events, accepted, binding


def _publication(store, source_work_id, build_step_index, expected_sha256):
    if expected_sha256 is not None:
        _sha(expected_sha256)
    work, events, accepted, binding = _history(store, source_work_id, build_step_index, 'forge_python_specialist')
    fields = accepted['data']['change']
    _keys(fields, (*binding, 'arguments', 'contract', 'source', 'contract_sha256'))
    args, source = fields['arguments'], fields['source']
    _keys(args, ('contract_path', 'expected_sha256'))
    _keys(source, ('path', 'sha256', 'bytes'))
    _sha(args['expected_sha256'])
    path = args['contract_path']
    if (type(path) is not str or not 1 <= len(path) <= 240 or not path.endswith('.json')
            or any(c in path for c in '\\:\x00') or any(part in ('', '.', '..') for part in path.split('/'))
            or source['path'] != path or source['sha256'] != args['expected_sha256']
            or type(source['bytes']) is not int or not 1 <= source['bytes'] <= 65536):
        raise ValueError('Historical contract source reference differs')
    contract = _c_validate_contract(fields['contract'])
    contract_sha = _c_contract_digest(contract)
    _same(contract_sha, fields['contract_sha256'])
    published = _find(events, 'published')
    summaries, candidates, cohorts = [], [], []
    prior = accepted
    for strategy in ('direct', 'decomposed'):
        candidate_event = _find(events, 'candidate.committed', strategy=strategy)
        candidate_fields = candidate_event['data']['change']
        _keys(candidate_fields, (*binding, 'strategy', 'candidate'))
        candidate = candidate_fields['candidate']
        _keys(candidate, ('source', 'source_sha256', 'structural_sha256', 'error'))
        if type(candidate['error']) is not str or len(candidate['error']) > 500:
            raise ValueError('Invalid candidate rejection description')
        _before(prior, candidate_event, published)
        prior = candidate_event
        passed, cohort = 0, []
        if candidate['source'] is None:
            if candidate['source_sha256'] is not None or candidate['structural_sha256'] is not None or not candidate['error']:
                raise ValueError('Rejected candidate lacks its bounded rejection')
        else:
            raw = _w_source(candidate['source'])
            structural = hashlib.sha256(_ast_dump_v1(ast.parse(candidate['source'], feature_version=(3, 12))).encode()).hexdigest()
            if (candidate['source_sha256'] != hashlib.sha256(raw).hexdigest() or candidate['structural_sha256'] != structural
                    or candidate['error'] or any(item['structural_sha256'] == structural for item in candidates)):
                raise ValueError('Candidate source or structural diversity differs')
            for index, case in enumerate(contract['cases']):
                key = f'{strategy}:{index}'
                snap, cell, snapshot, execution = _cell(events, binding, candidate['source'], case['input'], key, prior)
                evaluation = _find(events, 'evaluation.committed', cell_key=key)
                _before(cell, evaluation, published)
                output = None
                try:
                    output = _output(snapshot, execution)
                    _c_validate_output(contract, output)
                    success = _c_outputs_equal(output, case['expected'])
                    error = '' if success else 'Actual output differs from the independent expected value'
                except (ValueError, TypeError, KeyError) as failure:
                    success, error = False, str(failure)[:500]
                _same(evaluation['data']['change'], {**binding, 'cell_key': key, 'case_id': case['id'],
                    'cell_receipt': cell['hash'], 'passed': success, 'error': error, 'contract_sha256': contract_sha})
                passed += int(success)
                cohort.append({'case_id': case['id'], 'input_hash': _digest(case['input']),
                    'expected_hash': _digest(case['expected']), 'output_hash': _digest(output),
                    'snapshot_id': snapshot['id'], 'snapshot_receipt_hash': snap['hash'],
                    'cell_receipt_hash': cell['hash'], 'evaluation_receipt_hash': evaluation['hash']})
                prior = evaluation
        candidates.append(candidate)
        cohorts.append(cohort)
        summaries.append({'strategy': strategy, 'status': 'passed' if passed == len(contract['cases']) else 'rejected',
            'passed': passed == len(contract['cases']), 'cases_passed': passed, 'cases_total': len(contract['cases']),
            'source_sha256': candidate['source_sha256'], 'structural_sha256': candidate['structural_sha256'], 'error': candidate['error']})
    eligible = [i for i, entry in enumerate(summaries) if entry['passed']]
    if not eligible:
        raise ValueError('Historical publication has no passing candidate')
    selected = min(eligible, key=lambda i: (len(candidates[i]['source'].encode()), candidates[i]['source_sha256']))
    validation = {'cases_total': len(contract['cases']), 'candidates': summaries, 'selected_strategy': ('direct', 'decomposed')[selected],
                  'qualification': _QUALIFICATION, 'selection_reason': _SELECTION}
    artifact = {'schema': 'yur.contained-python-specialist.v1', **_c_public_contract(contract),
                'source': candidates[selected]['source'], 'source_sha256': candidates[selected]['source_sha256'],
                'contract_sha256': contract_sha, 'driver_sha256': V1_DRIVER_SHA256, 'validation': validation}
    artifact_sha = _digest(artifact)
    if expected_sha256 is not None:
        _same(expected_sha256, artifact_sha)
    _same(published['data']['change'], {**binding, 'artifact': artifact, 'artifact_sha256': artifact_sha, 'accepted_receipt': accepted['hash']})
    result = _result(events, binding, accepted, source_work_id,
        {'status': 'published', 'artifact': _metadata(artifact), 'validation': validation}, required=False)
    if result:
        _before(published, result)
    expected_count = 1 + 2 + sum(len(items) * 3 for items in cohorts) + 1 + bool(result)
    if len(events) != expected_count:
        raise ValueError('Unexpected generated events outside the verified cohort')
    cohort = cohorts[selected]
    facts = {'schema': 'yur.generated-publication-evidence.v1', 'verifier': VERIFIER,
        'source_work_id': source_work_id, 'build_step_index': build_step_index, 'artifact_sha256': artifact_sha,
        'name': artifact['name'], 'source_sha256': artifact['source_sha256'], 'contract_sha256': contract_sha,
        'source_file_sha256': source['sha256'], 'driver_sha256': V1_DRIVER_SHA256,
        'runtime_sha256': _digest(_RUNTIME_IDENTITY), 'accepted_receipt_hash': accepted['hash'],
        'publication_receipt_hash': published['hash'], 'validation_receipt_hash': cohort[-1]['evaluation_receipt_hash'],
        'validation_anchor': 'final_selected_case_evaluation', 'validation_cohort_sha256': _digest(cohort),
        'validation_cohort': cohort, 'cases_total': len(cohort), 'qualification': _QUALIFICATION}
    if len(_canonical(facts)) > 16384:
        raise ValueError('Historical publication facts exceed their bounded contract')
    return facts, artifact, contract, published


def resolve_publication(store, source_work_id, build_step_index, expected_sha256=None):
    """Reconstruct immutable facts in the existing verified read transaction.

    This verifies recorded evidence, including synthetic test fixtures if present;
    it does not independently attest that a local journal is an authentic host.
    No source files or current runtime resources are read. Original source-file
    SHA is the accepted acquisition reference; only canonical contract bytes are
    retained and rehashed, so original whitespace bytes cannot be reconstructed.
    """
    with store._read_transaction():
        facts, _, _, _ = _publication(store, source_work_id, build_step_index, expected_sha256)
        return deepcopy(facts)


def _resolve_execution(store, publication_facts, execution_work_id, execution_step_index, execution_verifier):
    """Verify a subsequent run against freshly reconstructed publication facts.

    Requires the actual committed run result, not just a cell or a forge case.
    Output is schema-checked; unseen-input semantic correctness is not inferred.
    """
    with store._read_transaction():
        if type(publication_facts) is not dict or len(_canonical(publication_facts)) > 16384:
            raise ValueError('Select bounded historical publication facts')
        publication_verifier = publication_facts.get('verifier')
        if publication_verifier == v1.VERIFIER:
            publication_reader = v1._publication
        elif publication_verifier == VERIFIER:
            publication_reader = _publication
        else:
            raise ValueError('Unknown immutable publication verifier')
        if execution_verifier == v1.VERIFIER:
            history_reader = v1._history
        elif execution_verifier == VERIFIER:
            history_reader = _history
        else:
            raise ValueError('Unknown immutable execution verifier')
        facts, artifact, contract, published = publication_reader(store, publication_facts['source_work_id'],
            publication_facts['build_step_index'], publication_facts['artifact_sha256'])
        _same(publication_facts, facts)
        work, events, accepted, binding = history_reader(store, execution_work_id, execution_step_index, 'run_python_specialist')
        fields = accepted['data']['change']
        _keys(fields, (*binding, 'arguments', 'artifact', 'input', 'published_receipt'))
        args = fields['arguments']
        _keys(args, ('source_work_id', 'build_step_index', 'artifact_sha256', 'input'))
        _same({key: args[key] for key in ('source_work_id', 'build_step_index', 'artifact_sha256')},
              {key: facts[key] for key in ('source_work_id', 'build_step_index', 'artifact_sha256')})
        payload = _c_validate_input(contract, args['input'])
        _same(fields['input'], payload)
        _same(fields['artifact'], artifact)
        _same(fields['published_receipt'], published['hash'])
        _before(published, accepted)
        snap, cell, snapshot, execution = _cell(events, binding, artifact['source'], payload, 'fresh-input', accepted)
        output = _c_validate_output(contract, _output(snapshot, execution))
        selection = {'source_work_id': facts['source_work_id'], 'build_step_index': facts['build_step_index'],
            'artifact_sha256': facts['artifact_sha256'], 'published_receipt': published['hash'],
            'reason': 'Exact retained worker selected and independently reverified before fresh contained execution'}
        result = _result(events, binding, accepted, execution_work_id, {'status': 'recorded', 'artifact': _metadata(artifact),
            'output': output, 'error': '', 'execution': execution, 'selection': selection, 'execution_receipt': cell['hash'],
            'qualification': 'Actual contained output checked against its schema; correctness on this new input is not established by the original finite acceptance cases.'}, required=True)
        _before(cell, result)
        if len(events) != 4:
            raise ValueError('Unexpected generated run boundaries')
        return {**{key: facts[key] for key in ('verifier', 'source_work_id', 'build_step_index', 'artifact_sha256',
            'source_sha256', 'contract_sha256', 'driver_sha256', 'runtime_sha256', 'publication_receipt_hash', 'validation_cohort_sha256')},
            'schema': 'yur.generated-execution-evidence.v1', 'execution_work_id': execution_work_id,
            'execution_verifier': execution_verifier,
            'execution_step_index': execution_step_index, 'capability_id': 'python.run', 'input_hash': _digest(payload),
            'output_hash': _digest(output), 'accepted_receipt_hash': accepted['hash'], 'snapshot_id': snapshot['id'],
            'snapshot_receipt_hash': snap['hash'], 'execution_receipt_hash': cell['hash'], 'result_receipt_hash': result['hash'],
            'qualification': 'Recorded contained output validated against its schema; correctness on unseen input is unverified.'}


def resolve_execution(store, publication_facts, execution_work_id, execution_step_index):
    """Verify an exact128 execution against its independently pinned publication.

    A historical v1 publication remains v1. The execution_verifier separately
    records this reader's exact128 interpretation of the later Work envelope.
    """
    return _resolve_execution(store, publication_facts, execution_work_id,
                              execution_step_index, VERIFIER)

