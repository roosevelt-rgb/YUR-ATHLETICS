"""Generate and reuse contained workers under the existing Work manager.

The source contract is frozen before two independent candidate requests. Workers
receive inputs, never expected outputs. Only the host validator decides whether
finite acceptance cases passed; CommitService retains each boundary. Generated
Python is data here and is never imported into the Desktop process.
"""
from copy import deepcopy
import ast
import hashlib
import json
import re

from . import generated_contracts as contracts
from . import generated_worker as worker
from .specialists import validate_schema
from .work_store import MAX_WORK_STEPS, now
from .work_tools import _root, _relative, _read

PREFIX = 'work.generated.'
ACCEPTED = PREFIX + 'accepted'
CANDIDATE = PREFIX + 'candidate.committed'
SNAPSHOT = PREFIX + 'snapshot.committed'
CELL = PREFIX + 'cell.committed'
EVALUATED = PREFIX + 'evaluation.committed'
PUBLISHED = PREFIX + 'published'
RESULT = PREFIX + 'result.committed'
STRATEGIES = ('direct', 'decomposed')
QUALIFICATION = 'Exact outcomes passed for the supplied finite acceptance cases; broader domain correctness and commercial readiness are unverified.'
SHA = {'type': 'string', 'minLength': 64, 'maxLength': 64}
MID = {'type': 'string', 'minLength': 32, 'maxLength': 32}


def _object(fields, required=None):
    return {'type': 'object', 'additionalProperties': False, 'properties': fields,
            'required': list(fields) if required is None else required}


INPUTS = {
    'forge_python_specialist': _object({'contract_path': {'type': 'string', 'minLength': 1, 'maxLength': 240}, 'expected_sha256': SHA}),
    'list_python_specialists': _object({'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20},
                                      'cursor': {'type': ['string', 'null'], 'minLength': 34, 'maxLength': 36}}, []),
    'run_python_specialist': _object({'source_work_id': MID, 'build_step_index': {'type': 'integer', 'minimum': 0, 'maximum': MAX_WORK_STEPS - 1},
                                     'artifact_sha256': SHA, 'input': {'type': 'object', 'additionalProperties': True}}),
}
SUBMIT = {'name': 'submit_python_candidate',
          'description': 'Return one self-contained Python source implementing synchronous run(payload) -> JSON. This submits source for independent evaluation; it does not execute or approve it.',
          'input_schema': _object({'source': {'type': 'string', 'minLength': 1, 'maxLength': 24576}})}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate JSON fields are not admitted')
        value[key] = item
    return value


def _json(text):
    def invalid(_value):
        raise ValueError('Nonfinite JSON is not admitted')
    return json.loads(text, object_pairs_hook=_unique, parse_constant=invalid)


def validate_arguments(name, arguments):
    """Validate the fixed tool envelope separately from its selected JSON input."""
    if name not in INPUTS or type(arguments) is not dict:
        raise ValueError('Expected a known generated-worker operation and argument object')
    envelope = arguments
    if name == 'run_python_specialist' and 'input' in arguments:
        if type(arguments['input']) is not dict:
            raise ValueError('Generated-worker input must be an object')
        # The common schema validator treats an empty child schema as closed.
        # Validate only the envelope here; the published contract owns all
        # nested field meanings. JSON budgets still apply before any lookup.
        contracts._checked_json(arguments['input'], contracts.MAX_INPUT_BYTES,
                                max_depth=contracts.MAX_SCHEMA_DEPTH)
        envelope = {**arguments, 'input': {}}
    validate_schema(envelope, INPUTS[name])
    if name == 'run_python_specialist':
        if (not re.fullmatch('[0-9a-f]{32}', arguments['source_work_id'])
                or not re.fullmatch('[0-9a-f]{64}', arguments['artifact_sha256'])):
            raise ValueError('Select exact generated-worker source and artifact identifiers')


def _validate_retained_input(change, arguments):
    """Keep historical result replay bound to the exact previously accepted input."""
    validate_arguments('run_python_specialist', change['arguments'])
    artifact = change['artifact']
    if (digest(artifact) != arguments['artifact_sha256']
            or not contracts.outputs_equal(arguments['input'], change['input'])
            or canonical(arguments) != canonical(change['arguments'])):
        raise ValueError('Saved-worker input differs from its accepted immutable contract')


def catalog(mode='code'):
    descriptions = {
        'forge_python_specialist': 'In Code mode, create NEW executable Python behavior from an existing operator-supplied JSON acceptance contract in the selected folder. Read its SHA first. Freeze the contract, generate two isolated candidates without exposing expected cases, evaluate them in the existing restricted cell, then publish only a passing worker. Requires an already-running admitted WSL environment. No host import, packages, network or export; a finite test pass is not domain certification.',
        'list_python_specialists': 'Discover committed generated Python specialists with verified source, contract, validation and publication hashes. These workers execute only in Code-mode restricted cells; they are separate from trusted built-in packs.',
        'run_python_specialist': 'In Code mode, run one exact previously published generated Python specialist on fresh JSON input in the existing restricted cell. Source and original acceptance evidence are reverified. Output-schema validation is not proof of correctness on unseen input.',
    }
    return [{'name': name, 'description': descriptions[name], 'input_schema': deepcopy(schema),
             'output_schema': {'type': 'object', 'additionalProperties': True},
             'permissions': ['read'] if name == 'list_python_specialists' else ['read', 'compute', 'commit-artifact'],
             'runtime': {'resource': 'python-serial-cell', 'network': False, 'host_import': False},
             'limits': {'candidates': 2, 'cases_per_candidate': 8, 'source_bytes': 24576},
             'rollback': {'behavior': 'scratch discarded; immutable source, validation and publication receipts retained'}}
            for name, schema in INPUTS.items() if mode == 'code' or name == 'list_python_specialists']


def _current(manager, parent, name):
    if getattr(manager.store, '_lock_file', None) is None:
        raise RuntimeError('Generated specialists require the existing exclusive Work worker lock')
    current = manager.store.get_work(parent['id'])
    if (current['status'] != 'running' or current['steps'] != parent['steps']
            or current['request'] != parent['request'] or current['authority'] != parent['authority']
            or not {'read', 'compute', 'commit-artifact'} <= set(current['authority']['actions'])
            or (name != 'list_python_specialists' and current['request']['mode'] != 'code')):
        raise ValueError('Generated execution requires the current Code mission and its existing authority')
    return current


def _events(manager, parent):
    return [event for event in manager.store.work_events(parent['id'])
            if event['event_type'].startswith(PREFIX) and event['data']['change'].get('step_index') == len(parent['steps'])]


def _find(events, kind, **identity):
    found = [event for event in events if event['event_type'] == kind
             and all(event['data']['change'].get(key) == value for key, value in identity.items())]
    if len(found) > 1:
        raise ValueError('Duplicate generated-worker boundary records')
    return found[0] if found else None


def check_step_binding(manager, parent, name, arguments):
    for event in _events(manager, parent):
        change = event['data']['change']
        if change['tool'] != name or change['input_hash'] != digest(arguments):
            raise ValueError('This Work step is already bound to another generated-worker request')


def pending_call(manager, parent):
    accepted = _find(_events(manager, parent), ACCEPTED)
    if accepted is None:
        return None
    change = accepted['data']['change']
    validate_arguments(change['tool'], change['arguments'])
    if digest(change['arguments']) != change['input_hash']:
        raise ValueError('Retained generated-worker arguments changed')
    if change['tool'] == 'run_python_specialist':
        _validate_retained_input(change, change['arguments'])
    return {'function': {'name': change['tool'], 'arguments': deepcopy(change['arguments'])}}


def _record(manager, parent, kind, binding, **data):
    current = _current(manager, parent, binding['tool'])
    document = {key: deepcopy(value) for key, value in current.items() if key not in {'revision', 'receipt'}}
    document['updated_at'] = now()
    change = {**binding, **data}
    try:
        committed = manager.store.commit_work_checkpoint(document, current['revision'], kind, change)
    except (ValueError, OSError, TypeError, KeyError) as error:
        # A postcommit acknowledgment loss must fail the mission, not become a
        # falsely rejected tool and allow a different operation at this index.
        try:
            retained = [event for event in _events(manager, parent) if event['event_type'] == kind and event['data']['change'] == change]
        except Exception as resolution_error:
            raise RuntimeError('Generated-worker acknowledgment is uncertain; resume this retained Work request') from resolution_error
        if retained:
            raise RuntimeError('Generated-worker checkpoint committed but acknowledgment was interrupted; resume this Work request') from error
        raise
    return next(event for event in manager.store.work_events(parent['id']) if event['revision'] == committed['revision'])


def _contract(parent, args):
    relative = _relative(args['contract_path'])
    if not relative.endswith('.json') or not re.fullmatch('[0-9a-f]{64}', args['expected_sha256']):
        raise ValueError('Select a JSON source contract and its exact SHA-256')
    if any(item.get('proposal', {}).get('path', '').casefold() == relative.casefold() for item in parent['artifacts']):
        raise ValueError('This mission cannot generate its own acceptance contract through an edit proposal')
    text, source = _read(_root(parent['request']['root']), relative, 65536)
    if source['sha256'] != args['expected_sha256']:
        raise ValueError('Acceptance contract changed; reacquire its current source hash')
    contract = contracts.validate_contract(_json(text))
    for item in parent['artifacts']:
        proposal = item.get('proposal', {})
        content = proposal.get('content')
        if not isinstance(content, str) or len(content.encode('utf-8')) > 65536:
            continue
        try:
            copied = _json(content)
        except (ValueError, RecursionError):
            continue
        if canonical(copied) == canonical(contract):
            raise ValueError('A same-mission model artifact cannot supply its own acceptance contract, including reformatted copies')
    return contract, source


def _candidate(model_adapter, contract, strategy):
    # Fresh contexts are deliberately independent of the calling conversation,
    # its inspected files, previous candidate, and all acceptance-case values.
    prompt = ('Implement the supplied JSON input/output contract as one Python file with synchronous run(payload). '
              'Use only Python standard library. No network, filesystem persistence, processes or threads. '
              'Do not return tests, acceptance claims, markdown fences or a fixed sample answer. '
              'Submit exactly one submit_python_candidate tool call. '
              + ('Use a direct compact algorithm.' if strategy == 'direct' else 'Use small explicit helper functions and defensive decomposition.'))
    response = model_adapter([{'role': 'system', 'content': prompt},
                              {'role': 'user', 'content': canonical(contracts.public_contract(contract)).decode()}], [deepcopy(SUBMIT)])
    if not isinstance(response, dict) or not isinstance(response.get('tool_calls'), list) or len(response['tool_calls']) != 1:
        raise ValueError('Candidate generation requires one source submission')
    call = response['tool_calls'][0]
    function = call.get('function', {}) if isinstance(call, dict) else {}
    args = function.get('arguments')
    if isinstance(args, str):
        args = _json(args)
    if function.get('name') != SUBMIT['name']:
        raise ValueError('Candidate generation requested an unadmitted operation')
    validate_schema(args, SUBMIT['input_schema'])
    source = args['source']
    # Preparing an inert snapshot validates source without importing it.
    worker.prepare_worker_snapshot(source, contract['cases'][0]['input'])
    return {'source': source, 'source_sha256': hashlib.sha256(source.encode()).hexdigest(),
            'structural_sha256': hashlib.sha256(ast.dump(ast.parse(source), include_attributes=False).encode()).hexdigest()}


def _cell(manager, parent, binding, snapshot, key, runner, on_event):
    events = _events(manager, parent)
    saved = _find(events, SNAPSHOT, cell_key=key)
    if saved is None:
        saved = _record(manager, parent, SNAPSHOT, binding, cell_key=key, snapshot=snapshot)
    elif saved['data']['change']['snapshot'] != snapshot:
        raise ValueError('Retained generated-worker snapshot changed')
    finished = _find(events, CELL, cell_key=key)
    if finished is None:
        _current(manager, parent, binding['tool'])
        execution = runner(deepcopy(snapshot), on_event=on_event)
        # The cell adapter returns trusted outer process evidence, but its guest
        # output is still untrusted and must be independently checked below.
        from .execution_cell import _validate_result
        execution = _validate_result(execution, snapshot)
        finished = _record(manager, parent, CELL, binding, cell_key=key, snapshot_id=snapshot['id'],
                           snapshot_receipt=saved['hash'], execution=execution)
    if finished['data']['change']['snapshot_id'] != snapshot['id'] or finished['data']['change']['snapshot_receipt'] != saved['hash']:
        raise ValueError('Generated execution is not bound to the retained snapshot')
    return finished, deepcopy(finished['data']['change']['execution'])


def _metadata(artifact):
    return {**{key: deepcopy(artifact[key]) for key in ('name', 'description', 'input_schema', 'output_schema', 'source_sha256', 'contract_sha256', 'driver_sha256')},
            'sha256': digest(artifact)}


def _finish(manager, parent, binding, accepted, result):
    result.update(schema='yur.work-generated-specialist-result.v1', tool=binding['tool'], committed=True,
                  provenance={'parent_work_id': parent['id'], 'step_index': binding['step_index'], 'input_hash': binding['input_hash'],
                              'accepted_receipt': accepted['hash']})
    saved = _record(manager, parent, RESULT, binding, result=result)
    result['provenance']['result_receipt'] = saved['hash']
    return result


def _forge(manager, parent, binding, accepted, model_adapter, runner, on_event):
    contract = contracts.validate_contract(accepted['data']['change']['contract'])
    if contracts.contract_digest(contract) != accepted['data']['change']['contract_sha256']:
        raise ValueError('Retained acceptance contract changed')
    results, candidates = [], []
    for strategy in STRATEGIES:
        event = _find(_events(manager, parent), CANDIDATE, strategy=strategy)
        if event is None:
            _current(manager, parent, binding['tool'])
            on_event({'text': f'Generating {strategy} candidate from the frozen public contract'})
            try:
                candidate = _candidate(model_adapter, contract, strategy)
                if any(item.get('structural_sha256') == candidate['structural_sha256'] for item in candidates):
                    raise ValueError('Candidate duplicates the earlier Python syntax tree')
                candidate.update(error='')
            except (ValueError, OSError, TypeError, KeyError, SyntaxError) as error:
                candidate = {'source': None, 'source_sha256': None, 'structural_sha256': None, 'error': str(error)[:500]}
            event = _record(manager, parent, CANDIDATE, binding, strategy=strategy, candidate=candidate)
        candidate = deepcopy(event['data']['change']['candidate'])
        candidates.append(candidate)
        passed = 0
        if candidate['source'] is not None:
            if hashlib.sha256(candidate['source'].encode()).hexdigest() != candidate['source_sha256']:
                raise ValueError('Retained candidate source changed')
            for index, case in enumerate(contract['cases']):
                key = f'{strategy}:{index}'
                snapshot = worker.prepare_worker_snapshot(candidate['source'], case['input'])
                cell_event, execution = _cell(manager, parent, binding, snapshot, key, runner, on_event)
                evaluated = _find(_events(manager, parent), EVALUATED, cell_key=key)
                try:
                    output = worker.validate_worker_execution(snapshot, execution)
                    contracts.validate_output(contract, output)
                    success = contracts.outputs_equal(output, case['expected'])
                    error = '' if success else 'Actual output differs from the independent expected value'
                except (ValueError, TypeError, KeyError) as failure:
                    success, error = False, str(failure)[:500]
                evaluation = {'cell_key': key, 'case_id': case['id'], 'cell_receipt': cell_event['hash'],
                              'passed': success, 'error': error, 'contract_sha256': contracts.contract_digest(contract)}
                if evaluated is None:
                    evaluated = _record(manager, parent, EVALUATED, binding, **evaluation)
                elif evaluated['data']['change'] != {**binding, **evaluation}:
                    raise ValueError('Retained acceptance decision differs from its actual source, input and execution')
                passed += int(evaluated['data']['change']['passed'])
        results.append({'strategy': strategy, 'status': 'passed' if passed == len(contract['cases']) else 'rejected',
                        'passed': passed == len(contract['cases']), 'cases_passed': passed, 'cases_total': len(contract['cases']),
                        'source_sha256': candidate['source_sha256'], 'structural_sha256': candidate['structural_sha256'], 'error': candidate['error']})
    eligible = [index for index, result in enumerate(results) if result['passed']]
    selected = min(eligible, key=lambda index: (len(candidates[index]['source'].encode()), candidates[index]['source_sha256'])) if eligible else None
    validation = {'cases_total': len(contract['cases']), 'candidates': results,
                  'selected_strategy': STRATEGIES[selected] if selected is not None else None, 'qualification': QUALIFICATION,
                  'selection_reason': 'Among candidates passing every case, select the smaller UTF-8 source; SHA-256 breaks ties. This is a packaging tradeoff, not a general quality ranking.'}
    if selected is None:
        validation['qualification'] = 'No candidate passed every supplied finite acceptance case; no specialist was published.'
        return _finish(manager, parent, binding, accepted, {'status': 'rejected', 'artifact': None, 'validation': validation})
    artifact = {'schema': 'yur.contained-python-specialist.v1', **contracts.public_contract(contract),
                'source': candidates[selected]['source'], 'source_sha256': candidates[selected]['source_sha256'],
                'contract_sha256': contracts.contract_digest(contract), 'driver_sha256': worker.DRIVER_SHA256,
                'validation': validation}
    published = _find(_events(manager, parent), PUBLISHED)
    if published is None:
        published = _record(manager, parent, PUBLISHED, binding, artifact=artifact, artifact_sha256=digest(artifact),
                            accepted_receipt=accepted['hash'])
    elif published['data']['change']['artifact'] != artifact:
        raise ValueError('Published worker differs from its retained validation')
    return _finish(manager, parent, binding, accepted, {'status': 'published', 'artifact': _metadata(artifact), 'validation': validation})


def _resolve(manager, source_work_id, step_index, expected_hash=None):
    if not isinstance(source_work_id, str) or not re.fullmatch('[0-9a-f]{32}', source_work_id) or type(step_index) is not int or not 0 <= step_index < MAX_WORK_STEPS:
        raise ValueError('Select an exact generated-worker build identity')
    source = manager.store.get_work(source_work_id)
    events = [event for event in manager.store.work_events(source_work_id)
              if event['event_type'].startswith(PREFIX) and event['data']['change'].get('step_index') == step_index]
    accepted, published = _find(events, ACCEPTED), _find(events, PUBLISHED)
    if not accepted or not published or source['request']['mode'] != 'code':
        raise ValueError('Generated-worker publication was not found')
    change = accepted['data']['change']
    if change['tool'] != 'forge_python_specialist' or digest(change['arguments']) != change['input_hash']:
        raise ValueError('Publication lacks its original forge authority')
    contract = contracts.validate_contract(change['contract'])
    artifact = deepcopy(published['data']['change']['artifact'])
    value = digest(artifact)
    if (value != published['data']['change']['artifact_sha256'] or expected_hash not in {None, value}
            or published['data']['change']['accepted_receipt'] != accepted['hash']
            or contracts.contract_digest(contract) != artifact['contract_sha256']
            or artifact['driver_sha256'] != worker.DRIVER_SHA256
            or hashlib.sha256(artifact['source'].encode()).hexdigest() != artifact['source_sha256']
            or any(artifact[key] != item for key, item in contracts.public_contract(contract).items())):
        raise ValueError('Generated-worker source, contract, driver or publication digest changed')
    strategy = artifact['validation']['selected_strategy']
    candidate = _find(events, CANDIDATE, strategy=strategy)
    if strategy not in STRATEGIES or not candidate or candidate['data']['change']['candidate']['source'] != artifact['source']:
        raise ValueError('Publication is not bound to its selected candidate')
    for index, case in enumerate(contract['cases']):
        key = f'{strategy}:{index}'
        snap, cell, evaluation = _find(events, SNAPSHOT, cell_key=key), _find(events, CELL, cell_key=key), _find(events, EVALUATED, cell_key=key)
        if not snap or not cell or not evaluation or not evaluation['data']['change']['passed']:
            raise ValueError('Publication lacks every independently validated case')
        snapshot = worker.prepare_worker_snapshot(artifact['source'], case['input'])
        if (snap['data']['change']['snapshot'] != snapshot or cell['data']['change']['snapshot_id'] != snapshot['id']
                or cell['data']['change']['snapshot_receipt'] != snap['hash']
                or evaluation['data']['change']['cell_receipt'] != cell['hash']
                or evaluation['data']['change']['contract_sha256'] != artifact['contract_sha256']):
            raise ValueError('Publication validation receipts do not match the frozen source and input')
        output = worker.validate_worker_execution(snapshot, cell['data']['change']['execution'])
        contracts.validate_output(contract, output)
        if not contracts.outputs_equal(output, case['expected']):
            raise ValueError('Published worker did not pass its independent expected output')
    return artifact, contract, published


def _list(manager, parent, arguments):
    records = manager.store.list_work()
    cursor = arguments.get('cursor')
    publications = []
    for record in records:
        publications.extend((record['id'], event['data']['change']['step_index'])
                            for event in manager.store.work_events(record['id']) if event['event_type'] == PUBLISHED)
    if cursor is not None:
        matches = [index for index, (identity, step) in enumerate(publications) if f'{identity}:{step}' == cursor]
        if not matches:
            raise ValueError('Discovery cursor is outside the current bounded Work publications')
        publications = publications[matches[0] + 1:]
    entries, excluded, scanned, last = [], 0, 0, None
    for identity, index in publications:
        if len(entries) >= arguments.get('limit', 10):
            break
        try:
            artifact, _contract_value, published = _resolve(manager, identity, index)
            metadata = _metadata(artifact)
            entry = {'source_work_id': identity, 'build_step_index': index,
                     'artifact_sha256': metadata.pop('sha256'), **metadata,
                     'validation': artifact['validation'], 'published_receipt': published['hash']}
            if len(canonical([*entries, entry])) > 120 * 1024:
                if entries:
                    break
                raise ValueError('Generated-worker catalog entry exceeds its 120 KiB data budget')
            entries.append(entry)
        except (ValueError, TypeError, KeyError):
            excluded += 1
        scanned += 1; last = f'{identity}:{index}'
    return {'schema': 'yur.work-generated-specialist-result.v1', 'tool': 'list_python_specialists', 'status': 'discovered',
            'committed': False, 'entries': entries, 'scanned': scanned, 'excluded': excluded,
            'next_cursor': last if scanned < len(publications) else None, 'coverage_limited': len(records) == 200,
            'provenance': {'parent_work_id': parent['id'], 'step_index': len(parent['steps']), 'input_hash': digest(arguments),
                           'reason': 'Verified retained generated-worker publications in the bounded local Work history'}}


def list_generated_specialists(manager, arguments):
    """Read-only Desktop library projection, without a new mission or authority."""
    validate_schema(arguments, INPUTS['list_python_specialists'])
    page = _list(manager, {'id': None, 'steps': []}, arguments)
    return {key: page[key] for key in ('entries', 'scanned', 'excluded', 'next_cursor', 'coverage_limited')}


def _execute(manager, parent, name, arguments, *, model_adapter=None, runner=None, on_event=lambda event: None):
    validate_arguments(name, arguments)
    parent = _current(manager, parent, name)
    check_step_binding(manager, parent, name, arguments)
    if name == 'list_python_specialists':
        return _list(manager, parent, arguments)
    binding = {'step_index': len(parent['steps']), 'tool': name, 'input_hash': digest(arguments)}
    events = _events(manager, parent)
    accepted = _find(events, ACCEPTED)
    if accepted and name == 'run_python_specialist':
        _validate_retained_input(accepted['data']['change'], arguments)
    finished = _find(events, RESULT)
    if finished:
        result = deepcopy(finished['data']['change']['result'])
        result['provenance']['result_receipt'] = finished['hash']
        return result
    if accepted is None:
        if name == 'forge_python_specialist':
            contract, source = _contract(parent, arguments)
            data = {'contract': contract, 'source': source, 'contract_sha256': contracts.contract_digest(contract)}
        else:
            artifact, contract, published = _resolve(manager, arguments['source_work_id'], arguments['build_step_index'], arguments['artifact_sha256'])
            payload = contracts.validate_input(contract, arguments['input'])
            data = {'artifact': artifact, 'input': payload, 'published_receipt': published['hash']}
        accepted = _record(manager, parent, ACCEPTED, binding, arguments=deepcopy(arguments), **data)
    if runner is None:
        from .execution_cell import run_snapshot
        runner = run_snapshot
    if name == 'forge_python_specialist':
        if model_adapter is None:
            raise ValueError('Generation requires the mission-selected model adapter')
        return _forge(manager, parent, binding, accepted, model_adapter, runner, on_event)
    artifact, contract, published = _resolve(manager, arguments['source_work_id'], arguments['build_step_index'], arguments['artifact_sha256'])
    contracts.validate_input(contract, arguments['input'])
    retained = accepted['data']['change']
    if retained['artifact'] != artifact or retained['published_receipt'] != published['hash'] or retained['input'] != arguments['input']:
        raise ValueError('Saved-worker execution differs from its accepted selection')
    snapshot = worker.prepare_worker_snapshot(artifact['source'], retained['input'])
    cell_event, execution = _cell(manager, parent, binding, snapshot, 'fresh-input', runner, on_event)
    try:
        output = worker.validate_worker_execution(snapshot, execution)
        contracts.validate_output(contract, output)
        status, error = 'recorded', ''
    except (ValueError, TypeError, KeyError) as failure:
        output, status, error = None, 'rejected', str(failure)[:500]
    result = {'status': status, 'artifact': _metadata(artifact), 'output': output, 'error': error, 'execution': execution,
              'selection': {'source_work_id': arguments['source_work_id'], 'build_step_index': arguments['build_step_index'],
                            'artifact_sha256': arguments['artifact_sha256'], 'published_receipt': published['hash'],
                            'reason': 'Exact retained worker selected and independently reverified before fresh contained execution'},
              'execution_receipt': cell_event['hash'],
              'qualification': 'Actual contained output checked against its schema; correctness on this new input is not established by the original finite acceptance cases.'}
    return _finish(manager, parent, binding, accepted, result)


def execute(manager, parent, name, arguments, *, model_adapter=None, runner=None, on_event=lambda event: None):
    current = manager.store.get_work(parent['id'])
    if current['revision'] != parent['revision']:
        raise ValueError('Generated-worker request requires the current Work revision')
    try:
        return _execute(manager, parent, name, arguments, model_adapter=model_adapter, runner=runner, on_event=on_event)
    except (ValueError, OSError, TypeError, KeyError) as error:
        # Once accepted, any unhandled failure must preserve this exact pending
        # operation instead of recording a rejection at the next Work step.
        try:
            accepted = _find(_events(manager, parent), ACCEPTED)
        except Exception as resolution_error:
            raise RuntimeError('Generated-worker state is uncertain; inspect and resume this Work request') from resolution_error
        if accepted:
            raise RuntimeError(f'Generated-worker operation is retained for recovery: {str(error)[:500]}') from error
        raise
