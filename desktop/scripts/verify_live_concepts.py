"""Opt-in real local-model proof of retained Concepts across independent Work.

Uses the production model adapter, manager, tools, policy and CommitService.
Prompts specify the operator's intended workflow; no model response is replaced
or manufactured. All operational state is an isolated temporary test journal.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
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


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def fingerprint():
    paths = [*sorted((ROOT / 'foundry').glob('*.py')), Path(__file__).resolve()]
    return {path.relative_to(ROOT).as_posix(): digest(path.read_bytes()) for path in paths}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate field in actual model-created JSON plan')
        value[key] = item
    return value


def local_endpoint(value):
    endpoint = normalize_endpoint(value)
    host = urlsplit(endpoint).hostname
    # This opt-in proof never calls a remote service or a cloud-backed model.
    require(ipaddress.ip_address(host).is_loopback, 'Proof endpoint must be a literal loopback address')
    return endpoint


def successful(mission, name):
    return [step for step in mission['steps'] if step['tool'] == name and step['succeeded']]


def verify_work(store, mission, allowed_tools, require_first_pass=False):
    require(mission['status'] == 'completed', 'The real model did not finish Work')
    require(1 <= len(mission['steps']) <= mission['authority']['max_steps'], 'Work exceeded its finite step budget')
    require(all(step['tool'] in allowed_tools for step in mission['steps']),
            'The model selected an operation outside this proof')
    if require_first_pass:
        require(all(step['succeeded'] for step in mission['steps']), 'The model needed a rejected-tool recovery')
    events = store.work_events(mission['id'])
    indexed = {event['hash']: event for event in events}
    for step in mission['steps']:
        completions = [event for event in events if event['event_type'] == 'work.tool.completed'
                       and event['data']['change'].get('step_id') == step['id']]
        require(len(completions) == 1, 'Tool step lacks its exact committed completion event')
        if not step['succeeded']:
            require(step['result'].get('status') == 'rejected' and step['result'].get('committed') is False,
                    'A failed tool was not retained as a rejection')
            continue
        if step['tool'] in {'create_concept', 'add_concept_evidence', 'advance_concept'}:
            provenance = step['result']['provenance']
            require(provenance['parent_work_id'] == mission['id'], 'Concept result lost its parent Work identity')
            require(provenance['input_hash'] == digest(canonical(step['arguments'])), 'Concept tool input hash differs')
            accepted, result = indexed[provenance['accepted_receipt']], indexed[provenance['result_receipt']]
            require(accepted['event_type'] == 'work.concept.accepted' and result['event_type'] == 'work.concept.result.committed',
                    'Concept result is not bound to accepted and committed source events')
            require(accepted['id'] < result['id'] < completions[0]['id'], 'Concept/tool receipt ordering differs')
    return [{key: event[key] for key in ('id', 'mission_id', 'revision', 'event_type', 'hash', 'previous_hash', 'created_at')} for event in events]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, choices=['qwen3.5:9b'])
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--require-first-pass', action='store_true',
                        help='Additionally fail on any rejected tool call, even if the model recovers to the exact outcome')
    args = parser.parse_args()
    endpoint = local_endpoint(args.endpoint)
    require(args.receipt.is_absolute() and args.receipt.parent.is_dir(), 'Choose an existing absolute proof directory')
    require(not args.receipt.exists(), 'Use a new proof receipt path; existing evidence is never overwritten')
    record = {'schema': 'yur.live-concepts-proof.v1', 'passed': False, 'fixture_model': False,
              'model_decision_fixtures': False, 'model': args.model, 'endpoint': endpoint,
              'source_before': fingerprint(), 'started_at': datetime.now(timezone.utc).isoformat(),
              'require_first_pass': args.require_first_pass,
              'missions': [], 'progress': [], 'model_calls': [], 'work_events': []}
    try:
        with tempfile.TemporaryDirectory(prefix='yur-live-concepts-') as temporary:
            with CommitService(Path(temporary) / 'journal') as store:
                manager = OrchestrationManager(store)
                real_adapter = create_model_adapter('ollama', args.model, endpoint=endpoint)
                nonce = uuid.uuid4().hex[:12]
                name = f'Continuing quoted inspection {nonce}'
                thesis = f'Retain quoted construction evidence across missions without inventing costs. Proof {nonce}.'
                tags = ['construction', 'quoted-evidence']
                plans = {
                    'charter': f'Inspect quoted construction information with traceable source references. Proof {nonce}.',
                    'success_criteria': ['Retain exact source references for every checked quote.', 'Report missing evidence instead of asserting readiness.'],
                    'constraint_set': ['Do not invent costs or quantities.', 'Do not deploy, export, bill or claim maturity.'],
                }
                record['fixture'] = {'name': name, 'thesis_statement': thesis, 'domain_tags': tags, 'plans': plans}

                def run(goal):
                    # The second mission receives a new conversation and no first
                    # transcript/IDs. Its model must discover retained state.
                    request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()),
                               'mode': 'work', 'goal': goal, 'root': None, 'provider': 'ollama',
                               'model': args.model, 'messages': [{'role': 'user', 'content': goal}]}

                    def adapter(messages, tools):
                        started = time.monotonic()
                        call = {'request_id': request['request_id']}
                        try:
                            output = real_adapter(messages, tools)
                            call.update(succeeded=True, output=deepcopy(output))
                            return output
                        except Exception as error:
                            call.update(succeeded=False, error=f'{type(error).__name__}: {error}')
                            if hasattr(error, 'diagnostics'):
                                call['diagnostics'] = error.diagnostics
                            raise
                        finally:
                            call['duration_ms'] = round((time.monotonic() - started) * 1000)
                            record['model_calls'].append(call)

                    def progress(event):
                        value = {**event, 'request_id': request['request_id'], 'conversation_id': request['conversation_id']}
                        record['progress'].append(value)
                        print(json.dumps(value), flush=True)

                    try:
                        mission = manager.run_work(request, adapter, progress)
                    except Exception:
                        retained = store.get_work_by_request(request['request_id'])
                        if retained:
                            record['missions'].append(retained)
                        raise
                    record['missions'].append(mission)
                    return mission

                first = run('Create exactly one retained concept using create_concept, with these exact seed values: '
                            + json.dumps({'name': name, 'thesis_statement': thesis, 'domain_tags': tags})
                            + '. Then add three Genesis evidence references using add_concept_evidence, requirements '
                            'name, thesis_statement and domain_tags, each with source {"kind":"concept_intent"}. '
                            'Use the actual returned concept ID and newest returned revision for every mutation. '
                            'Call advance_concept to inception with precisely those three returned evidence IDs. '
                            'Finish only after the actual allowed decision; report the concept ID and Inception stage. '
                            'Do not create documents, build packages, export, execute files, deploy, or claim readiness.')
                record['work_events'].append(verify_work(store, first, {'create_concept', 'add_concept_evidence', 'advance_concept', 'list_concepts', 'inspect_concept'}, args.require_first_pass))
                created = successful(first, 'create_concept')
                require(len(created) == 1, 'Expected exactly one model-created retained concept')
                concept_id = created[0]['result']['concept']['id']
                require(str(uuid.UUID(concept_id)) == concept_id, 'Concept ID must be its canonical UUID')
                first_concept = store.get_concept(concept_id)
                require(first_concept['stage'] == 'inception', 'Genesis evidence did not actually pass the Inception gate')
                require(first_concept['name'] == name and first_concept['thesis_statement'] == thesis and first_concept['domain_tags'] == tags,
                        'Created concept differs from the operator seed')
                require(len(first_concept['evidence']) == 3 and {item['requirement'] for item in first_concept['evidence']} == {'name', 'thesis_statement', 'domain_tags'}, 'Genesis evidence set differs')
                require(all(item['source'] == {'kind': 'concept_intent'} for item in first_concept['evidence']), 'Genesis facts did not come from the actual seed event')
                require(not first['artifacts'] and not first_concept['versions'], 'Genesis invented artifacts or package versions')
                first_history = store.concept_events(concept_id, limit=20)['events']
                record['concept_after_first'] = deepcopy(first_concept)

                second = run(f'Discover the retained concept named "{name}" using list_concepts, then inspect_concept '
                             'with the actual discovered ID. Do not create another concept. Continue its Inception plan. '
                             'For each of these three requirement/content pairs, use create_artifact to commit exactly '
                             'one JSON document named <requirement>.json with media_type application/json and content '
                             'encoding this exact object: {"schema":"yur.concept-plan.v1","concept_id":the actual '
                             'discovered ID,"requirement":the requirement,"content":the specified content}. Pairs: '
                             + json.dumps(plans) + '. After each document is returned, call add_concept_evidence with '
                             'the matching requirement and source {"kind":"work_artifact","mission_id":the actual '
                             'provenance.parent_work_id returned by this mission\'s list/inspect tools,"artifact_id":the '
                             'actual returned document artifact_id}. Always use the latest concept revision. '
                             'Advance to development using only the three new charter/success_criteria/constraint_set '
                             'evidence IDs. Then deliberately call advance_concept to stabilization with evidence_ids [] '
                             'to record the missing actual artifact/build_log/instrumentation evidence. After that denial, '
                             'use its returned current revision and deliberately request maturation with evidence_ids [] '
                             'to record the forbidden stage skip. Both requests must retain Development. Finish by reporting '
                             'the actual allowed Development transition, actual denied requests and their missing/error '
                             'reasons. Do not build packages, fabricate stability, export, apply files, deploy, bill or claim maturity.')
                record['work_events'].append(verify_work(store, second, {'list_concepts', 'inspect_concept', 'create_artifact', 'add_concept_evidence', 'advance_concept'}, args.require_first_pass))
                require(first['id'] != second['id'] and first['conversation_id'] != second['conversation_id'], 'Second Work did not start independently')
                listings = successful(second, 'list_concepts')
                require(any(any(item['id'] == concept_id for item in step['result']['concepts']) for step in listings), 'Later model did not discover the retained identity')
                require(any(step['arguments']['concept_id'] == concept_id for step in successful(second, 'inspect_concept')), 'Later model did not inspect the discovered concept')
                artifacts = second['artifacts']
                require(len(artifacts) == 3 and len(successful(second, 'create_artifact')) == 3, 'Expected exactly three actual plan documents')
                by_requirement = {}
                for artifact in artifacts:
                    proposal = artifact['proposal']
                    require(artifact['status'] == 'committed' and proposal['kind'] == 'artifact' and proposal['media_type'] == 'application/json', 'Plan was not a committed JSON artifact')
                    raw = proposal['content'].encode('utf-8')
                    require(proposal['sha256'] == digest(raw) and proposal['bytes'] == len(raw), 'Plan bytes/hash do not match the committed content')
                    plan = json.loads(proposal['content'], object_pairs_hook=unique)
                    requirement = plan['requirement']
                    require(requirement in plans and requirement not in by_requirement, 'Unexpected/duplicate plan requirement')
                    require(plan == {'schema': 'yur.concept-plan.v1', 'concept_id': concept_id, 'requirement': requirement, 'content': plans[requirement]}, 'Model-created plan differs from its exact contract/content')
                    require(proposal['name'] == requirement + '.json', 'Plan artifact name differs')
                    by_requirement[requirement] = artifact
                final = store.get_concept(concept_id)
                require(final['stage'] == 'development' and not final['versions'], 'Denied gate changed stage or invented versions')
                require(final['evidence'][:3] == first_concept['evidence'] and len(final['evidence']) == 6, 'Earlier evidence was replaced or extra evidence was invented')
                events = store.work_events(second['id'])
                for evidence in final['evidence'][3:]:
                    artifact = by_requirement[evidence['requirement']]
                    expected = {'kind': 'work_artifact', 'mission_id': second['id'], 'artifact_id': artifact['id']}
                    require(evidence['source'] == expected and evidence['artifact_id'] == artifact['id'], 'Plan evidence points to a different mission/artifact')
                    require(evidence['artifact_sha256'] == artifact['proposal']['sha256'], 'Plan evidence does not bind actual content')
                    receipt = next(event for event in events if event['hash'] == evidence['receipt_hash'])
                    require(receipt['event_type'] == 'work.tool.completed' and receipt['data']['change']['step_id'] == artifact['id'], 'Plan evidence lacks its exact completion receipt')
                transitions = successful(second, 'advance_concept')
                require(len(transitions) == 3, 'Expected Development promotion and two deliberate denials')
                actual = {step['arguments']['to_stage']: step['result'] for step in transitions}
                require(set(actual) == {'development', 'stabilization', 'maturation'}, 'Unexpected stage transition requests')
                require(actual['development']['decision']['allowed'], 'The documented Inception plan did not pass')
                for target in ('stabilization', 'maturation'):
                    result = actual[target]
                    require(result['status'] == 'denied' and result['decision']['allowed'] is False and result['concept']['stage'] == 'development', 'A deliberate gate denial was not retained')
                require({item['requirement'] for item in actual['stabilization']['decision']['missing']} == {'artifact', 'build_log', 'instrumentation'}, 'Missing build/execution evidence was not reported')
                require(bool(actual['maturation']['decision']['errors']), 'The forbidden stage skip has no actual policy error')
                history = store.concept_events(concept_id, limit=20)['events']
                require(history[:len(first_history)] == first_history, 'Earlier lifecycle receipts were changed')
                require(history[-1]['hash'] == final['history_hash'], 'Final Concept history does not match its receipt')
                require(store.list_concepts()['total'] == 1 and not store.list_missions(), 'Proof created an extra concept or package')
                integrity = store.verify_integrity()
                require(integrity['passed'], 'CommitService integrity failed')
                record.update(concept_id=concept_id, concept_after_second=final, concept_events=history,
                              actual_gate_results=actual, actual_documents=artifacts, integrity=integrity,
                              no_package_build=True, no_delivery_or_export=True)
                record['source_after'] = fingerprint()
                require(record['source_before'] == record['source_after'], 'Source changed during validation')
                record.update(passed=True, scope='Actual local-model Concept creation, rediscovery, committed plan evidence and denied gates across two Work missions; no deployment, maturity or market certification')
    except Exception as error:
        record.update(error=f'{type(error).__name__}: {error}', source_after=fingerprint())
    record['rejected_tool_steps'] = [{'mission_id': mission['id'], 'step_id': step['id'],
                                     'tool': step['tool'], 'error': step['result'].get('error')}
                                    for mission in record['missions'] for step in mission['steps'] if not step['succeeded']]
    record['first_pass_clean'] = record['passed'] and not record['rejected_tool_steps']
    record['completed_at'] = datetime.now(timezone.utc).isoformat()
    # This is explicitly requested test evidence, separate from product state.
    with args.receipt.open('x', encoding='utf-8') as output:
        json.dump(record, output, indent=2, ensure_ascii=False, allow_nan=False)
    print(json.dumps({'passed': record['passed'], 'receipt': str(args.receipt), 'error': record.get('error')}), flush=True)
    return 0 if record['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
