"""Opt-in local-model proof of generated behavior and fresh-context saved reuse.

This script never imports candidate source, substitutes model decisions, retries a
mission, starts WSL, or exports artifacts. Its acceptance oracle is the existing
operator example plus the independently written fresh expectation below.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_provider import create_model_adapter, normalize_endpoint
from foundry import generated_contracts, generated_worker, work_generated

EXAMPLE = ROOT / 'examples' / 'quantity-rollup.specialist.json'
CONTRACT_PATH = 'quantity-rollup.specialist.json'
FRESH_INPUT = {'lines': [
    {'code': '26', 'unit': 'EA', 'quantity': 7},
    {'code': '03', 'unit': 'SF', 'quantity': 12},
    {'code': '03', 'unit': 'LF', 'quantity': 9},
    {'code': '26', 'unit': 'EA', 'quantity': 5},
    {'code': '03', 'unit': 'SF', 'quantity': 8},
    {'code': '01', 'unit': 'EA', 'quantity': 0},
]}
# Literal expectations are not calculated by the candidate or sent to a model.
FRESH_EXPECTED = {'groups': [
    {'code': '01', 'unit': 'EA', 'quantity': 0},
    {'code': '03', 'unit': 'LF', 'quantity': 9},
    {'code': '03', 'unit': 'SF', 'quantity': 20},
    {'code': '26', 'unit': 'EA', 'quantity': 12},
], 'input_count': 6}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def fingerprint():
    paths = [*sorted((ROOT / 'foundry').glob('*.py')), Path(__file__).resolve(), EXAMPLE]
    return {path.relative_to(ROOT).as_posix(): sha(path.read_bytes()) for path in paths}


def matching(events, event_type):
    return [event for event in events if event['event_type'] == event_type]


def one(events, event_type, **fields):
    selected = [event for event in matching(events, event_type)
                if all(event['data']['change'].get(key) == value for key, value in fields.items())]
    require(len(selected) == 1, f'Expected one {event_type} checkpoint for {fields}')
    return selected[0]


def step_results(mission, tool):
    return [(index, step) for index, step in enumerate(mission['steps'])
            if step['tool'] == tool and step['succeeded']]


def validate_cells(events, contract):
    """Recheck committed process outputs without executing any source again."""
    snapshots = {event['hash']: event for event in matching(events, work_generated.SNAPSHOT)}
    cells = {event['hash']: event for event in matching(events, work_generated.CELL)}
    candidates = {event['data']['change']['strategy']: event['data']['change']['candidate']
                  for event in matching(events, work_generated.CANDIDATE)}
    for cell in cells.values():
        change = cell['data']['change']
        snapshot_event = snapshots.get(change['snapshot_receipt'])
        require(snapshot_event is not None, 'Cell lost its committed input snapshot')
        require(snapshot_event['id'] < cell['id'], 'Execution preceded its committed snapshot')
        require(change['snapshot_id'] == snapshot_event['data']['change']['snapshot']['id'],
                'Cell snapshot identity mismatch')
    evaluations = []
    for event in matching(events, work_generated.EVALUATED):
        change = event['data']['change']
        cell = cells.get(change['cell_receipt'])
        require(cell is not None and cell['id'] < event['id'], 'Evaluation lacks prior execution')
        require(change['contract_sha256'] == generated_contracts.contract_digest(contract),
                'Evaluation changed its acceptance contract')
        case = next(case for case in contract['cases'] if case['id'] == change['case_id'])
        snapshot = snapshots[cell['data']['change']['snapshot_receipt']]['data']['change']['snapshot']
        strategy = change['cell_key'].split(':', 1)[0]
        require(snapshot == generated_worker.prepare_worker_snapshot(candidates[strategy]['source'], case['input']),
                'Acceptance execution changed candidate source or case input')
        try:
            actual = generated_worker.validate_worker_execution(snapshot, cell['data']['change']['execution'])
            generated_contracts.validate_output(contract, actual)
            passed = generated_contracts.outputs_equal(actual, case['expected'])
            validation_error = None
        except (ValueError, TypeError, KeyError) as error:
            actual, passed, validation_error = None, False, f'{type(error).__name__}: {error}'[:1000]
        require(change['passed'] is passed, 'Stored acceptance decision differs from actual output')
        evaluations.append({'case_id': case['id'], 'cell_key': change['cell_key'],
                            'expected': case['expected'], 'actual': actual, 'passed': passed,
                            'error': validation_error, 'evaluation_receipt': event['hash'],
                            'cell_receipt': cell['hash'], 'snapshot_id': snapshot['id']})
    return evaluations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, choices=['qwen3.5:9b'])
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    endpoint = normalize_endpoint(args.endpoint)
    require(ipaddress.ip_address(urlsplit(endpoint).hostname).is_loopback,
            'This proof permits only an explicit literal-loopback model endpoint')
    require(args.receipt.is_absolute() and args.receipt.parent.is_dir(),
            'Choose a new receipt in an existing absolute proof directory')
    require(not args.receipt.exists(), 'An existing receipt must never be overwritten')
    record = {'schema': 'yur.live-generated-specialist-proof.v1', 'passed': False,
              'fixture_model': False, 'candidate_source_fixture': False,
              'mission_retries_by_script': 0, 'runtime_started_by_script': False,
              'model': args.model, 'endpoint': endpoint, 'source_before': fingerprint(),
              'started_at': datetime.now(timezone.utc).isoformat(), 'model_calls': [],
              'missions': [], 'work_events': {}, 'progress': [], 'requests': [],
              'fresh_input': FRESH_INPUT, 'fresh_expected': FRESH_EXPECTED,
              'scope': 'Two actual local-model Code missions, finite independent acceptance, '
                       'and saved contained-source reuse on one fresh input; no deployment, '
                       'general domain correctness, or market-readiness claim.'}
    try:
        contract_bytes = EXAMPLE.read_bytes()
        contract = generated_contracts.validate_contract(json.loads(contract_bytes))
        public = generated_contracts.public_contract(contract)
        generated_contracts.validate_input(contract, FRESH_INPUT)
        generated_contracts.validate_output(contract, FRESH_EXPECTED)
        require(all(not generated_contracts.outputs_equal(FRESH_INPUT, case['input'])
                    for case in contract['cases']), 'Reuse input must be new')
        record['contract'] = {'path': CONTRACT_PATH, 'source_sha256': sha(contract_bytes),
                              'contract_sha256': generated_contracts.contract_digest(contract),
                              'document': contract}
        with tempfile.TemporaryDirectory(prefix='yur-live-generated-') as temporary:
            project = Path(temporary) / 'project'
            project.mkdir()
            (project / CONTRACT_PATH).write_bytes(contract_bytes)
            with CommitService(Path(temporary) / 'journal') as store:
                manager = OrchestrationManager(store)
                real_adapter = create_model_adapter('ollama', args.model, endpoint=endpoint,
                                                    timeout_seconds=120)

                def run(goal, allowed):
                    request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()),
                               'mode': 'code', 'goal': goal, 'root': str(project),
                               'provider': 'ollama', 'model': args.model,
                               'messages': [{'role': 'user', 'content': goal}]}
                    record['requests'].append(request)

                    def adapter(messages, tools):
                        started = time.monotonic()
                        candidate = [tool['name'] for tool in tools] == ['submit_python_candidate']
                        call = {'request_id': request['request_id'], 'candidate_generation': candidate,
                                'input_message_count': len(messages), 'input_sha256': sha(canonical(messages))}
                        try:
                            if candidate:
                                require(len(messages) == 2 and messages[0]['role'] == 'system'
                                        and messages[1]['role'] == 'user', 'Candidate context is not independent')
                                require(messages[1]['content'] == canonical(public).decode(),
                                        'Candidate received content outside the public contract')
                                call['public_contract_sha256'] = sha(canonical(public))
                                call['strategy'] = ('direct' if 'direct compact algorithm' in messages[0]['content']
                                                    else 'decomposed' if 'defensive decomposition' in messages[0]['content']
                                                    else 'unknown')
                                require(call['strategy'] != 'unknown', 'Unrecognized candidate strategy')
                            output = real_adapter(messages, tools)
                            names = [item['function']['name'] for item in output['tool_calls']]
                            call.update(provider_succeeded=True, succeeded=True,
                                        content_chars=len(output['content']), tool_names=names)
                            # Observe real decisions; stop unrelated mutation requests before
                            # the manager executes them. Never substitute or repair model output.
                            require(all(name in ({'submit_python_candidate'} if candidate else allowed)
                                        for name in names), 'Model requested work outside this proof scope')
                            return output
                        except Exception as error:
                            call.update(succeeded=False, error=f'{type(error).__name__}: {error}'[:2000])
                            diagnostic = getattr(error, 'diagnostics', {})
                            safe_keys = {'schema', 'provider', 'outcome', 'done_reason', 'content_chars',
                                         'thinking_chars', 'tool_call_count', 'eval_count', 'prompt_eval_count'}
                            if isinstance(diagnostic, dict):
                                call['diagnostics'] = {key: value for key, value in diagnostic.items()
                                                       if key in safe_keys and type(value) in {str, int, bool}}
                            raise
                        finally:
                            call['duration_ms'] = round((time.monotonic() - started) * 1000)
                            record['model_calls'].append(call)
                            print(json.dumps({'model_call': call}), flush=True)

                    def progress(event):
                        record['progress'].append(event)
                        print(json.dumps(event), flush=True)

                    mission = manager.run_work(request, adapter, progress)
                    require(mission['status'] == 'completed' and bool(mission['answer'].strip()),
                            'Mission must finish with a nonempty actual model answer')
                    require(len(mission['steps']) <= mission['authority']['max_steps'], 'Work exceeded its existing step budget')
                    return mission

                try:
                    first = run(
                        f'Read {CONTRACT_PATH} and its current SHA-256 using read_file. '
                        'Create and publish a new executable Python specialist for this operator-supplied '
                        'acceptance contract with forge_python_specialist, using its exact path and observed hash. '
                        'Use the existing two independent candidate strategies and contained validation. '
                        'Do not write source or acceptance cases yourself, edit files, export, deploy, or create '
                        'other artifacts. Finish by reporting the actual publication and finite validation result; '
                        'if validation rejects the candidates, say so.',
                        {'read_file', 'list_files', 'search_files', 'forge_python_specialist'})
                    first_events = store.work_events(first['id'])
                    builds = [(index, step) for index, step in step_results(first, 'forge_python_specialist')
                              if step['result'].get('status') == 'published']
                    require(len(builds) == 1, 'Expected one actually published generated specialist')
                    build_index, build = builds[0]
                    reads = [(index, step) for index, step in step_results(first, 'read_file')
                             if step['arguments'].get('path') == CONTRACT_PATH]
                    require(any(index < build_index and step['result']['sha256'] == sha(contract_bytes)
                                for index, step in reads), 'Model did not read the current contract hash before forging')
                    require(build['arguments'] == {'contract_path': CONTRACT_PATH, 'expected_sha256': sha(contract_bytes)},
                            'Forge used a different source contract')
                    require(len(matching(first_events, work_generated.ACCEPTED)) == 1,
                            'Unexpected additional accepted generation operation')
                    published = one(first_events, work_generated.PUBLISHED)
                    artifact = published['data']['change']['artifact']
                    artifact_sha = published['data']['change']['artifact_sha256']
                    require(sha(canonical(artifact)) == artifact_sha == build['result']['artifact']['sha256'],
                            'Publication artifact digest mismatch')
                    require(sha(artifact['source'].encode()) == artifact['source_sha256'],
                            'Selected executable source hash mismatch')
                    require(artifact['driver_sha256'] == generated_worker.DRIVER_SHA256,
                            'Publication uses a different trusted driver')
                    record['publication'] = {'source_work_id': first['id'], 'build_step_index': build_index,
                                             'artifact_sha256': artifact_sha, 'published_receipt': published['hash'],
                                             'artifact': artifact}
                    candidates = matching(first_events, work_generated.CANDIDATE)
                    require([event['data']['change']['strategy'] for event in candidates] == ['direct', 'decomposed'],
                            'Expected two independently requested and committed candidates')
                    calls = [call for call in record['model_calls'] if call['candidate_generation']]
                    require([call.get('strategy') for call in calls] == ['direct', 'decomposed'],
                            'Candidate generation was absent, duplicated, or retried')
                    record['independent_evaluations'] = validate_cells(first_events, contract)
                    selected = artifact['validation']['selected_strategy']
                    accepted_cases = [item for item in record['independent_evaluations']
                                      if item['cell_key'].startswith(selected + ':')]
                    require(len(accepted_cases) == len(contract['cases']) and all(item['passed'] for item in accepted_cases),
                            'Selected source did not pass every actual independent case')

                    second_goal = (
                        f'Find the saved generated Python specialist named {json.dumps(contract["name"])} '
                        'with list_python_specialists. Reuse that exact discovered publication with '
                        f'run_python_specialist on this fresh input: {canonical(FRESH_INPUT).decode()}. '
                        'Do not build another specialist, edit files, export, or create artifacts. '
                        'Report the actual returned groups and input_count, and explain that finite original '
                        'acceptance does not prove all possible inputs correct.')
                    require(first['id'] not in second_goal and artifact_sha not in second_goal,
                            'Second prompt must discover its publication without injected identifiers')
                    second = run(second_goal, {'list_python_specialists', 'run_python_specialist'})
                    require(first['conversation_id'] != second['conversation_id'],
                            'The reuse mission must start in a fresh conversation')
                    reuse_steps = step_results(second, 'run_python_specialist')
                    require(len(reuse_steps) == 1, 'Expected one actual saved-source execution')
                    run_index, reuse_step = reuse_steps[0]
                    result = reuse_step['result']
                    require(result['status'] == 'recorded' and result['committed'], 'Fresh run was rejected')
                    require(reuse_step['arguments'] == {'source_work_id': first['id'], 'build_step_index': build_index,
                                                       'artifact_sha256': artifact_sha, 'input': FRESH_INPUT},
                            'Fresh run changed the discovered publication or input')
                    discoveries = [step['result'] for index, step in step_results(second, 'list_python_specialists')
                                   if index < run_index]
                    require(any(any(entry['source_work_id'] == first['id'] and entry['artifact_sha256'] == artifact_sha
                                        and entry['published_receipt'] == published['hash'] for entry in page['entries'])
                                for page in discoveries), 'Fresh mission did not discover the existing publication')
                    require(generated_contracts.outputs_equal(result['output'], FRESH_EXPECTED),
                            'Actual fresh output differs from the independent literal expectation')
                    second_events = store.work_events(second['id'])
                    fresh_cell = one(second_events, work_generated.CELL, cell_key='fresh-input')
                    fresh_snapshot = one(second_events, work_generated.SNAPSHOT, cell_key='fresh-input')
                    require(fresh_cell['hash'] == result['execution_receipt']
                            and fresh_cell['data']['change']['execution'] == result['execution'],
                            'Run result lacks the exact committed process receipt')
                    decoded = generated_worker.validate_worker_execution(
                        fresh_snapshot['data']['change']['snapshot'], result['execution'])
                    require(generated_contracts.outputs_equal(decoded, FRESH_EXPECTED),
                            'Actual process output differs from the fresh expected result')
                    require(len(matching(second_events, work_generated.CELL)) == 1
                            and not matching(second_events, work_generated.CANDIDATE)
                            and not matching(second_events, work_generated.PUBLISHED),
                            'Reuse regenerated source or performed additional executions')
                    record['fresh_actual'] = decoded
                    record['fresh_execution'] = result
                    require(all(not mission['artifacts'] for mission in (first, second)),
                            'Unexpected edit or exportable artifact')
                    require(not store.list_missions(), 'Generated proof started an unrelated specialist-pack mission')
                    record['passed'] = True
                finally:
                    # Keep actual terminal or interrupted work, source, and receipts
                    # before the isolated journal and its temp root are disposed.
                    record['missions'] = [mission for request in record['requests']
                                          if (mission := store.get_work_by_request(request['request_id'])) is not None]
                    record['work_events'] = {mission['id']: store.work_events(mission['id']) for mission in record['missions']}
                    record['retained_publications'] = [
                        {'mission_id': mission['id'], 'receipt': event['hash'], **event['data']['change']}
                        for mission in record['missions']
                        for event in matching(record['work_events'][mission['id']], work_generated.PUBLISHED)]
                    record['candidate_attempts'] = [
                        {'mission_id': mission['id'], 'receipt': event['hash'], **event['data']['change']}
                        for mission in record['missions']
                        for event in matching(record['work_events'][mission['id']], work_generated.CANDIDATE)]
                    record['integrity'] = store.verify_integrity()
                    record['source_project_unchanged'] = (
                        sorted(path.relative_to(project).as_posix() for path in project.rglob('*')) == [CONTRACT_PATH]
                        and (project / CONTRACT_PATH).read_bytes() == contract_bytes)
                    record['rejected_tool_steps'] = [
                        {'mission_id': mission['id'], 'index': index, 'tool': step['tool'], 'result': step['result']}
                        for mission in record['missions'] for index, step in enumerate(mission['steps'])
                        if not step['succeeded'] or step['result'].get('status') == 'rejected']
                    record['recovered_precondition_calls'] = bool(record['rejected_tool_steps']) and record['passed']
                    record['resumed_requests'] = [mission['id'] for mission in record['missions']
                                                  if any(event['event_type'] == 'work.started'
                                                         and event['data']['change'].get('resumed')
                                                         for event in record['work_events'][mission['id']])]
                    require(record['integrity']['passed'], 'Isolated CommitService integrity failed')
                    require(record['source_project_unchanged'], 'The selected source folder changed during proof')
                    require(not record['resumed_requests'], 'This proof must not silently resume or retry work')
    except Exception as error:
        record.update(passed=False, error=f'{type(error).__name__}: {error}'[:4000])
    record['source_after'] = fingerprint()
    record['source_changed'] = sorted(set(record['source_before']) | set(record['source_after']))
    record['source_changed'] = [path for path in record['source_changed']
                                if record['source_before'].get(path) != record['source_after'].get(path)]
    if record['source_changed']:
        record.update(passed=False, error='Source changed during validation; this receipt is not current proof')
    record['completed_at'] = datetime.now(timezone.utc).isoformat()
    with args.receipt.open('x', encoding='utf-8') as output:
        json.dump(record, output, indent=2, ensure_ascii=False, allow_nan=False)
    print(json.dumps({'passed': record['passed'], 'receipt': str(args.receipt), 'error': record.get('error')}), flush=True)
    return 0 if record['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
