"""Work bindings for persistent concepts; the existing manager owns execution.

Models select bounded operations. CommitService derives authority from the real
parent, resolves evidence, validates gates, and commits concept state separately
from mission state. Accepted operations survive interrupted parent checkpoints.
"""
from copy import deepcopy
import hashlib
import json
import uuid

from .repository_context import SECRET_CONTENT
from .specialists import validate_schema
from .work_store import MAX_WORK_STEPS, now

ACCEPTED = 'work.concept.accepted'
RESULT = 'work.concept.result.committed'
STAGES = ['genesis', 'inception', 'development', 'stabilization', 'maturation', 'monetization', 'regeneration', 'evolution']
UUID = {'type': 'string', 'minLength': 36, 'maxLength': 36}
MID = {'type': 'string', 'minLength': 32, 'maxLength': 32}
REVISION = {'type': 'integer', 'minimum': 1, 'maximum': 100000}


def _object(properties, required=None):
    return {'type': 'object', 'additionalProperties': False, 'properties': properties,
            'required': list(properties) if required is None else required}


SOURCE = _object({'kind': {'type': 'string', 'enum': ['concept_intent', 'work_artifact', 'specialist_build', 'specialist_execution', 'generated_build', 'generated_execution']},
                  'mission_id': MID, 'artifact_id': MID, 'version_id': UUID, 'run_id': MID,
                  'execution_work_id': MID, 'execution_step_index': {'type': 'integer', 'minimum': 0, 'maximum': MAX_WORK_STEPS - 1}}, ['kind'])
INPUTS = {
    'create_concept': _object({'name': {'type': 'string', 'minLength': 1, 'maxLength': 160},
                              'thesis_statement': {'type': 'string', 'minLength': 1, 'maxLength': 8000},
                              'domain_tags': {'type': 'array', 'minItems': 1, 'maxItems': 8,
                                              'items': {'type': 'string', 'minLength': 1, 'maxLength': 40}}}),
    'inspect_concept': _object({'concept_id': UUID}),
    'list_concepts': _object({'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20},
                             'cursor': {'type': ['string', 'null'], 'minLength': 36, 'maxLength': 36}}, []),
    'bind_concept_version': _object({'concept_id': UUID, 'expected_revision': REVISION, 'build_mission_id': MID,
                                    'parent_version_id': {'type': ['string', 'null'], 'minLength': 36, 'maxLength': 36}}),
    'bind_generated_concept_version': _object({'concept_id': UUID, 'expected_revision': REVISION,
                                              'source_work_id': MID, 'build_step_index': {'type': 'integer', 'minimum': 0, 'maximum': MAX_WORK_STEPS - 1},
                                              'artifact_sha256': {'type': 'string', 'minLength': 64, 'maxLength': 64},
                                              'parent_version_id': {'type': ['string', 'null'], 'minLength': 36, 'maxLength': 36}}),
    'add_concept_evidence': _object({'concept_id': UUID, 'expected_revision': REVISION,
                                   'requirement': {'type': 'string', 'enum': ['name', 'thesis_statement', 'domain_tags',
                                                                           'charter', 'success_criteria', 'constraint_set',
                                                                           'artifact', 'build_log', 'instrumentation'],
                                                   'description': 'The exact requirement key, never its field value or evidence content.'}, 'source': SOURCE}),
    'advance_concept': _object({'concept_id': UUID, 'expected_revision': REVISION,
                               'to_stage': {'type': 'string', 'enum': STAGES},
                               'evidence_ids': {'type': 'array', 'maxItems': 12, 'items': UUID}}),
}
MUTATIONS = frozenset(INPUTS) - {'inspect_concept', 'list_concepts'}
SHA = {'type': 'string', 'minLength': 64, 'maxLength': 64}
TEXT = {'type': 'string', 'maxLength': 2000}
NULL_UUID = {'type': ['string', 'null'], 'minLength': 36, 'maxLength': 36}
RECEIPT = _object({'id': {'type': 'integer', 'minimum': 1}, 'concept_id': UUID, 'revision': REVISION,
                   'event_type': TEXT, 'hash': SHA, 'previous_hash': SHA, 'created_at': TEXT})
LEGACY_VERSION = _object({'id': UUID, 'ordinal': {'type': 'integer', 'minimum': 1, 'maximum': 16}, 'build_mission_id': MID,
                   'parent_version_id': NULL_UUID, 'artifact_sha256': SHA, 'runtime_sha256': SHA,
                   'validation_receipt_hash': SHA, 'artifact_receipt_hash': SHA, 'created_at': TEXT})
GENERATED_VERSION = _object({**{key: value for key, value in LEGACY_VERSION['properties'].items() if key != 'build_mission_id'},
                            'kind': {'type': 'string', 'enum': ['generated_python']}, 'source_work_id': MID,
                            'build_step_index': {'type': 'integer', 'minimum': 0, 'maximum': MAX_WORK_STEPS - 1},
                            'source_sha256': SHA, 'contract_sha256': SHA, 'driver_sha256': SHA, 'acceptance_cohort_sha256': SHA,
                            'evidence_verifier': {'type': 'string', 'enum': ['yur.generated-evidence.v1', 'yur.generated-evidence.v2']}})
# Keep the shipped specialist runtime's schema validator unchanged. The local
# result validator below enforces exactly one version shape on every result.
VERSION = {**_object({**LEGACY_VERSION['properties'], **GENERATED_VERSION['properties']},
                    sorted(set(LEGACY_VERSION['required']) & set(GENERATED_VERSION['required']))),
           'oneOf': [LEGACY_VERSION, GENERATED_VERSION]}
EVIDENCE = _object({'id': UUID, 'requirement': TEXT, 'source': SOURCE,
                    'artifact_id': {'type': 'string', 'minLength': 32, 'maxLength': 36},
                    'artifact_sha256': SHA, 'receipt_hash': SHA, 'created_at': TEXT})
CONCEPT = _object({'id': UUID, 'name': {'type': 'string', 'maxLength': 160}, 'stage': {'type': 'string', 'enum': STAGES},
                   'parent_id': NULL_UUID, 'lineage': {'type': 'array', 'maxItems': 64, 'items': UUID},
                   'domain_tags': {'type': 'array', 'maxItems': 8, 'items': {'type': 'string', 'maxLength': 40}},
                   'revision': REVISION, 'history_hash': SHA, 'created_at': TEXT, 'updated_at': TEXT, 'receipt': RECEIPT,
                   'version_count': {'type': 'integer', 'minimum': 0, 'maximum': 16},
                   'evidence_count': {'type': 'integer', 'minimum': 0, 'maximum': 32},
                   'versions': {'type': 'array', 'maxItems': 16, 'items': VERSION},
                   'evidence': {'type': 'array', 'maxItems': 32, 'items': EVIDENCE}},
                  ['id', 'name', 'stage', 'parent_id', 'domain_tags', 'revision', 'created_at', 'updated_at', 'version_count', 'evidence_count', 'versions', 'evidence'])
DECISION = _object({'allowed': {'type': 'boolean'}, 'from_stage': {'type': 'string', 'enum': STAGES},
                    'to_stage': {'type': 'string', 'enum': STAGES},
                    'missing': {'type': 'array', 'maxItems': 12, 'items': _object({'requirement': TEXT, 'reason': TEXT})},
                    'errors': {'type': 'array', 'maxItems': 12, 'items': TEXT},
                    'requirements': {'type': 'array', 'maxItems': 12, 'items': TEXT},
                    'evidence': {'type': 'array', 'maxItems': 12, 'items': _object({
                        'requirement': TEXT, 'artifact_id': {'type': 'string', 'minLength': 32, 'maxLength': 36},
                        'artifact_sha256': SHA, 'receipt_hash': SHA, 'evidence_type': TEXT, 'qualification': TEXT})},
                    'identity': _object({'id': UUID, 'parent_id': NULL_UUID, 'lineage': {'type': 'array', 'maxItems': 64, 'items': UUID}}),
                    'expected_revision': REVISION, 'history_hash': SHA})
PROVENANCE = _object({'parent_work_id': MID, 'step_index': {'type': 'integer', 'minimum': 0, 'maximum': MAX_WORK_STEPS - 1},
                      'tool': {'type': 'string', 'enum': list(INPUTS)}, 'input_hash': SHA, 'operation_id': UUID,
                      'accepted_receipt': SHA, 'result_receipt': SHA}, ['parent_work_id', 'step_index', 'tool', 'input_hash'])


def result_schema(name):
    properties = {'schema': {'type': 'string', 'enum': ['yur.work-concept-result.v1']},
                  'tool': {'type': 'string', 'enum': [name]}, 'status': {'type': 'string', 'enum': ['completed', 'denied']},
                  'committed': {'type': 'boolean', 'enum': [name in MUTATIONS]}, 'provenance': PROVENANCE}
    if name == 'list_concepts':
        properties.update(concepts={'type': 'array', 'maxItems': 20, 'items': CONCEPT}, next_cursor=NULL_UUID,
                          total={'type': 'integer', 'minimum': 0, 'maximum': 100})
    else:
        properties['concept'] = CONCEPT
    if name == 'advance_concept':
        properties['decision'] = DECISION
    return _object(properties)


DESCRIPTIONS = {
    'create_concept': 'Retain a named concept in Genesis with its thesis and domain tags. Its identity and eight-stage lifecycle persist across Work missions. This commits an intent, not a deployed or successful product.',
    'inspect_concept': 'Read the current concept revision, stage, immutable package versions, evidence references and retained lineage. Refresh before a change; mission completion does not advance its stage.',
    'list_concepts': 'Discover up to 20 retained local concepts and their current stages, separately from conversations and missions. Use the returned cursor for the next bounded page.',
    'bind_concept_version': 'Bind an actual independently validated specialist build to this concept as an immutable version. Supply its real build_mission_id and the prior version ID for a successor version, or null for the first. This does not advance the concept or replace its earlier package.',
    'bind_generated_concept_version': 'Bind an exact saved generated Python publication to this continuing concept. Use its source_work_id, build_step_index and artifact_sha256 from list_python_specialists; parent_version_id is null for the first version or an earlier version of this concept. Retain source, contract, runtime and independently checked acceptance-cohort evidence. This commits an immutable version and does not advance the stage or prove unseen-input correctness.',
    'add_concept_evidence': 'Attach evidence resolved by CommitService. Genesis requirements name, thesis_statement and domain_tags use source {kind:"concept_intent"}. Inception requirements use a committed JSON Work artifact with {schema:"yur.concept-plan.v1",concept_id,requirement,content}; charter content is nonempty text, success_criteria and constraint_set content are nonempty text lists. Source is {kind:"work_artifact",mission_id,artifact_id}. Development artifact and build_log use {kind:"specialist_build",version_id} for built-in packages or {kind:"generated_build",version_id} for generated Python versions. Instrumentation uses {kind:"specialist_execution",version_id,run_id} or {kind:"generated_execution",version_id,execution_work_id,execution_step_index} for an actual later run_python_specialist result. These must refer to actual records. Acceptance cases alone are not fresh execution instrumentation. Plans are not outcome proof.',
    'advance_concept': 'Request a stage transition using exact retained evidence IDs and the current revision. Genesis exit needs name/thesis_statement/domain_tags; Inception exit needs charter/success_criteria/constraint_set; Development exit needs artifact/build_log/instrumentation for one actual package. A denied gate retains its reasons and does not advance. Independent stability, deployment, billing, health and successor evidence are not yet admitted; never substitute model assertions or fixture counts.',
}


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def _hash(value):
    return hashlib.sha256(_encoded(value)).hexdigest()


def catalog():
    return [{'name': name, 'description': DESCRIPTIONS[name], 'input_schema': deepcopy(schema),
             'output_schema': deepcopy(result_schema(name)),
             'permissions': ['compute', 'commit-artifact'] if name in MUTATIONS else ['read'],
             'runtime': {'resource': 'local-concept-records', 'authority': 'OrchestrationManager / CommitService', 'network': False},
             'limits': {'input_bytes': 16384, 'result_bytes': 48 * 1024},
             'rollback': {'behavior': 'Immutable prior versions, evidence and stage receipts retained; no deployment or filesystem export'}}
            for name, schema in INPUTS.items()]


def _current(manager, supplied):
    if getattr(manager.store, '_lock_file', None) is None:
        raise RuntimeError('Concept tools require the existing exclusive Work worker lock')
    current = manager.store.get_work(supplied['id'])
    if (current['status'] != 'running' or current['revision'] != supplied['revision'] or current['steps'] != supplied['steps']
            or len(current['steps']) >= current['authority']['max_steps'] or not {'read', 'compute', 'commit-artifact'} <= set(current['authority']['actions'])):
        raise ValueError('Concept operations require the current running Work and its bounded authority')
    return current


def _events(manager, parent):
    return [event for event in manager.store.work_events(parent['id'])
            if event['event_type'] in {ACCEPTED, RESULT} and event['data']['change'].get('step_index') == len(parent['steps'])]


def check_step_binding(manager, parent, name, arguments):
    for event in _events(manager, parent):
        binding = event['data']['change']
        if binding['tool'] != name or binding['input_hash'] != _hash(arguments):
            raise ValueError('This Work step is already bound to a different concept operation')


def pending_call(manager, parent):
    accepted = next((event for event in _events(manager, parent) if event['event_type'] == ACCEPTED), None)
    if accepted is None:
        return None
    binding = accepted['data']['change']
    validate_schema(binding['arguments'], INPUTS[binding['tool']])
    if binding['input_hash'] != _hash(binding['arguments']):
        raise ValueError('Committed concept operation input differs')
    return {'function': {'name': binding['tool'], 'arguments': deepcopy(binding['arguments'])}}


def _record(manager, parent, event_type, change):
    current = manager.store.get_work(parent['id'])
    if current['status'] != 'running' or current['steps'] != parent['steps']:
        raise ValueError('Work changed during its concept operation')
    document = {key: deepcopy(value) for key, value in current.items() if key not in {'revision', 'receipt'}}
    document['updated_at'] = now()
    committed = manager.store.commit_work_checkpoint(document, current['revision'], event_type, change)
    return next(event for event in manager.store.work_events(parent['id']) if event['revision'] == committed['revision'])


def public_concept(concept):
    """Bounded context of identities and evidence; never copy large plan bodies."""
    fields = ('id', 'name', 'stage', 'parent_id', 'lineage', 'domain_tags', 'revision', 'history_hash', 'created_at', 'updated_at', 'receipt', 'version_count', 'evidence_count')
    value = {key: deepcopy(concept[key]) for key in fields if key in concept}
    value['versions'] = deepcopy(concept.get('versions', []))
    value['evidence'] = [{key: deepcopy(item[key]) for key in ('id', 'requirement', 'source', 'artifact_id', 'artifact_sha256', 'receipt_hash', 'created_at') if key in item}
                         for item in concept.get('evidence', [])]
    value.setdefault('version_count', len(value['versions']))
    value.setdefault('evidence_count', len(value['evidence']))
    validate_schema(value, CONCEPT, 'concept')
    _validate_versions(value)
    if len(_encoded(value)) > 48 * 1024:
        raise ValueError('Concept summary exceeds its 48 KiB result budget')
    return value


def _validate_versions(concept):
    for version in concept.get('versions', []):
        schema = GENERATED_VERSION if version.get('kind') == 'generated_python' else LEGACY_VERSION
        validate_schema(version, schema, 'concept.version')
        if (schema is GENERATED_VERSION and version['evidence_verifier'] == 'yur.generated-evidence.v1'
                and version['build_step_index'] >= 20):
            raise ValueError('Historical v1 generated versions retain their original step bound')


def _validate_result(result, name, path):
    validate_schema(result, result_schema(name), path)
    for concept in result.get('concepts', []) if name == 'list_concepts' else [result['concept']]:
        _validate_versions(concept)


def _mutate(store, name, a, authority, operation_id):
    """A deterministic rejection is safe only when no operation was committed."""
    try:
        if name == 'create_concept':
            return {'concept': store.create_concept(a, authority, operation_id)}
        if name == 'bind_concept_version':
            return {'concept': store.bind_concept_version(a['concept_id'], a['expected_revision'], a['build_mission_id'], a['parent_version_id'], operation_id, authority)}
        if name == 'bind_generated_concept_version':
            return {'concept': store.bind_generated_concept_version(a['concept_id'], a['expected_revision'], a['source_work_id'], a['build_step_index'], a['artifact_sha256'], a['parent_version_id'], operation_id, authority)}
        if name == 'add_concept_evidence':
            return {'concept': store.submit_concept_evidence(a['concept_id'], a['expected_revision'], {'requirement': a['requirement'], 'source': a['source']}, operation_id, authority)}
        return store.transition_concept(a['concept_id'], a['expected_revision'], a['to_stage'], a['evidence_ids'], operation_id, authority)
    except (ValueError, OSError, TypeError, KeyError) as error:
        try:
            committed = store.get_concept_operation(operation_id, authority)
        except Exception as resolution_error:
            raise RuntimeError('Concept acknowledgment is uncertain; resume this Work request to resolve its retained operation.') from resolution_error
        if committed is not None:
            raise RuntimeError('Concept was committed but its acknowledgment was interrupted; resume this Work request to recover the same operation.') from error
        raise


def execute(manager, supplied, name, arguments):
    if name not in INPUTS:
        raise ValueError('Unknown concept tool')
    validate_schema(arguments, INPUTS[name])
    raw = _encoded(arguments)
    if len(raw) > 16384 or SECRET_CONTENT.search(raw.decode()):
        raise ValueError('Concept input exceeds its budget or contains credential material')
    parent = _current(manager, supplied)
    check_step_binding(manager, parent, name, arguments)
    binding = {'step_index': len(parent['steps']), 'tool': name, 'input_hash': _hash(arguments)}
    provenance = {'parent_work_id': parent['id'], **binding}
    if name == 'inspect_concept':
        payload = {'concept': public_concept(manager.store.get_concept(arguments['concept_id']))}
    elif name == 'list_concepts':
        page = manager.store.list_concepts(arguments.get('limit', 20), arguments.get('cursor'))
        payload = {**page, 'concepts': [public_concept(item) for item in page['concepts']]}
    else:
        events = _events(manager, parent)
        completed = next((event for event in events if event['event_type'] == RESULT), None)
        if completed:
            try:
                result = deepcopy(completed['data']['change']['result'])
                result['provenance']['result_receipt'] = completed['hash']
                _validate_result(result, name, 'recovered')
                return result
            except (ValueError, OSError, TypeError, KeyError) as error:
                raise RuntimeError('Committed concept acknowledgment could not be restored; its operation remains retained.') from error
        accepted = next((event for event in events if event['event_type'] == ACCEPTED), None)
        operation_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"yur:concept:{parent['id']}:{binding['step_index']}:{name}"))
        if accepted is None:
            accepted = _record(manager, parent, ACCEPTED, {**binding, 'operation_id': operation_id, 'arguments': deepcopy(arguments)})
        authority = manager.store.concept_authority_for_work(parent['id'])
        committed = _mutate(manager.store, name, arguments, authority, operation_id)
        try:
            payload = {'concept': public_concept(committed['concept'])}
            if name == 'advance_concept':
                payload['decision'] = committed['decision']
        except (ValueError, OSError, TypeError, KeyError) as error:
            raise RuntimeError('Concept was committed but its acknowledgment is incomplete; resume the retained operation.') from error
        provenance.update(operation_id=operation_id, accepted_receipt=accepted['hash'])
    result = {'schema': 'yur.work-concept-result.v1', 'tool': name,
              'status': 'denied' if payload.get('decision', {}).get('allowed') is False else 'completed',
              'committed': name in MUTATIONS, **payload, 'provenance': provenance}
    try:
        _validate_result(result, name, 'result')
        if len(_encoded(result)) > 48 * 1024 - 128:
            raise ValueError('Concept result exceeds its 48 KiB context budget')
        if name in MUTATIONS:
            committed = _record(manager, parent, RESULT, {**binding, 'result': result})
            result['provenance']['result_receipt'] = committed['hash']
    except (ValueError, OSError, TypeError, KeyError) as error:
        if name in MUTATIONS:
            raise RuntimeError('Concept was committed but the Work acknowledgment was interrupted; resume to recover the same operation.') from error
        raise
    return result
