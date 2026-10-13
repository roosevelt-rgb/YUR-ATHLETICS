"""Pure, bounded operator runtime-preparation records; no process or state access."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import re
import uuid

from .repository_context import SECRET_CONTENT
from .work_diagnostics import safe_diagnostic

SCHEMA = 'yur.execution-runtime-setup.v1'
MAX_HOLD_SECONDS = 900
MAX_CHECK_SECONDS = 120
MAX_SETUPS = 200
MAX_EVENTS = 16
MAX_RECORD_BYTES = 16 * 1024
STATES = {'accepted', 'starting', 'ready', 'releasing', 'released', 'failed', 'uncertain', 'expired'}
ACTIVE_STATES = {'accepted', 'starting', 'ready', 'releasing', 'uncertain'}
TRANSITIONS = {
    'accepted': {'starting', 'releasing', 'failed', 'uncertain'},
    'starting': {'ready', 'releasing', 'failed', 'uncertain'},
    'ready': {'releasing', 'released', 'failed', 'uncertain', 'expired'},
    'releasing': {'released', 'failed', 'uncertain', 'expired'},
    'uncertain': {'releasing', 'released', 'failed', 'expired'},
    'released': set(), 'failed': set(), 'expired': set(),
}
RELEASE_REASONS = {'operator', 'owner_eof', 'deadline', 'verification_failed', 'process_exit', 'protocol_error', 'shutdown'}
CHECK_FIELDS = {'checked_at', 'expires_at', 'token_sha256', 'observation_sha256', 'state', 'configuration_source'}
EVIDENCE_FIELDS = {'started_by_this_setup', 'runtime', 'owned_process_exit_confirmed', 'release_reason', 'error'}
SETUP_FIELDS = {'schema', 'operation_id', 'resource_id', 'distro', 'owner_session_id', 'state',
                'created_at', 'updated_at', 'expires_at', 'check', 'authority', 'evidence'}
_HASH = re.compile(r'^[0-9a-f]{64}$')
_DISTRO = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def safe(value, maximum=MAX_RECORD_BYTES):
    try:
        raw = canonical(value)
        if len(raw) > maximum or SECRET_CONTENT.search(raw.decode()):
            raise ValueError('Runtime setup exceeds its byte budget or contains credential-like data')
        return json.loads(raw)
    except (TypeError, UnicodeError, RecursionError) as error:
        raise ValueError('Runtime setup requires bounded finite UTF-8 JSON') from error


def validate_uuid(value):
    if type(value) is not str:
        raise ValueError('Runtime setup identifiers require canonical UUIDs')
    try:
        if str(uuid.UUID(value)) != value: raise ValueError('Noncanonical UUID')
    except (ValueError, AttributeError) as error:
        raise ValueError('Runtime setup identifiers require canonical UUIDs') from error


def validate_hash(value):
    if type(value) is not str or not _HASH.fullmatch(value):
        raise ValueError('Runtime setup evidence requires exact SHA-256 hashes')


def validate_distro(value):
    if type(value) is not str or not _DISTRO.fullmatch(value) or SECRET_CONTENT.search(value):
        raise ValueError('Select a bounded local distribution name')
    return value


def resource_id_for(distro):
    return digest({'kind': 'wsl2', 'distro': validate_distro(distro)})


def timestamp(value):
    if type(value) is not str or len(value) > 64 or 'T' not in value:
        raise ValueError('Runtime setup timestamps require bounded ISO text')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None: raise ValueError('Runtime setup timestamps require a timezone')
    return parsed.astimezone(timezone.utc)


def mint_authority(operation_id, resource_id):
    validate_uuid(operation_id); validate_hash(resource_id)
    return {'issuer': 'local-user', 'scope': 'execution-runtime-prepare',
            'actions': ['start-reviewed-runtime', 'hold-reviewed-runtime', 'release-owned-hold'],
            'operation_id': operation_id, 'resource_id': resource_id}


def validate_authority(authority, operation_id, resource_id):
    if authority != mint_authority(operation_id, resource_id):
        raise ValueError('Runtime preparation requires exact operator-bound authority')


def validate_check(check):
    if type(check) is not dict or set(check) != CHECK_FIELDS:
        raise ValueError('Runtime check evidence has missing or unsupported fields')
    checked, expires = timestamp(check['checked_at']), timestamp(check['expires_at'])
    if not 0 < (expires - checked).total_seconds() <= MAX_CHECK_SECONDS:
        raise ValueError('Runtime check token lifetime exceeds its bound')
    validate_hash(check['token_sha256']); validate_hash(check['observation_sha256'])
    if check['state'] not in {'running', 'stopped'} or check['configuration_source'] not in {'environment', 'settings', 'operator', 'auto'}:
        raise ValueError('Only a known installed runtime selection can be prepared')
    return safe(check)


def _runtime(runtime):
    fields = {'distro', 'architecture', 'python', 'libseccomp', 'kernel', 'artifacts'}
    if type(runtime) is not dict or set(runtime) not in (fields, fields - {'kernel'}):
        raise ValueError('Runtime evidence requires exact verification metadata')
    validate_distro(runtime['distro'])
    for key in ('architecture', 'python', 'libseccomp', 'kernel'):
        if key in runtime and (type(runtime[key]) is not str or not 1 <= len(runtime[key]) <= 160
                              or any(ord(c) < 32 or ord(c) == 127 for c in runtime[key])):
            raise ValueError('Runtime version metadata must be bounded text')
    artifacts = runtime['artifacts']
    if type(artifacts) is not dict or not 1 <= len(artifacts) <= 8:
        raise ValueError('Runtime evidence requires bounded toolchain artifacts')
    for name, artifact in artifacts.items():
        if (type(name) is not str or not re.fullmatch(r'/usr/[A-Za-z0-9_./+-]+', name) or len(name) > 240
                or '..' in name.split('/') or type(artifact) is not dict or set(artifact) != {'path', 'sha256', 'bytes'}):
            raise ValueError('Invalid runtime artifact metadata')
        path = artifact['path']
        if type(path) is not str or not re.fullmatch(r'/usr/[A-Za-z0-9_./+-]+', path) or len(path) > 240 or '..' in path.split('/'):
            raise ValueError('Invalid resolved runtime artifact metadata')
        validate_hash(artifact['sha256'])
        if type(artifact['bytes']) is not int or not 0 <= artifact['bytes'] <= 16 * 1024 * 1024:
            raise ValueError('Invalid runtime artifact byte count')


def validate_evidence(evidence):
    if type(evidence) is not dict or set(evidence) != EVIDENCE_FIELDS:
        raise ValueError('Runtime setup evidence has missing or unsupported fields')
    if evidence['started_by_this_setup'] is not None and type(evidence['started_by_this_setup']) is not bool:
        raise ValueError('Runtime start observation must be explicit or unknown')
    if type(evidence['owned_process_exit_confirmed']) is not bool:
        raise ValueError('Owned process exit confirmation must be explicit')
    if evidence['release_reason'] is not None and evidence['release_reason'] not in RELEASE_REASONS:
        raise ValueError('Invalid bounded runtime release reason')
    if evidence['runtime'] is not None: _runtime(evidence['runtime'])
    error = evidence['error']
    if error is not None:
        if type(error) is not dict or set(error) != {'code', 'message', 'diagnostics'}:
            raise ValueError('Runtime failure requires fixed safe diagnostic fields')
        if type(error['code']) is not str or not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', error['code']):
            raise ValueError('Invalid runtime failure code')
        if type(error['message']) is not str or len(error['message']) > 500:
            raise ValueError('Runtime failure message exceeds its bound')
        diagnostics = error['diagnostics']
        if diagnostics is not None:
            if (type(diagnostics) is not dict or diagnostics.get('schema') != 'yur.execution-diagnostic.v1'
                    or safe_diagnostic(diagnostics) is None):
                raise ValueError('Unsupported or malformed runtime diagnostics')
    return safe(evidence)


def empty_evidence():
    return {'started_by_this_setup': None, 'runtime': None, 'owned_process_exit_confirmed': False,
            'release_reason': None, 'error': None}


def validate_setup(document):
    if type(document) is not dict or set(document) != SETUP_FIELDS or document['schema'] != SCHEMA:
        raise ValueError('Invalid runtime setup document')
    validate_uuid(document['operation_id']); validate_uuid(document['owner_session_id'])
    if document['resource_id'] != resource_id_for(document['distro']):
        raise ValueError('Runtime setup resource identity mismatch')
    validate_authority(document['authority'], document['operation_id'], document['resource_id'])
    validate_check(document['check']); evidence = validate_evidence(document['evidence'])
    created, updated, expires = (timestamp(document[key]) for key in ('created_at', 'updated_at', 'expires_at'))
    if updated < created or (expires - created).total_seconds() != MAX_HOLD_SECONDS:
        raise ValueError('Runtime setup lifetime changed')
    if not timestamp(document['check']['checked_at']) <= created <= timestamp(document['check']['expires_at']):
        raise ValueError('Runtime preparation requires a fresh immutable check')
    state = document['state']
    if state not in STATES: raise ValueError('Invalid runtime setup state')
    if evidence['runtime'] is not None and evidence['runtime']['distro'] != document['distro']:
        raise ValueError('Runtime verification belongs to another distribution')
    if state == 'accepted' and evidence != empty_evidence():
        raise ValueError('Accepted setup cannot claim execution evidence')
    if state == 'ready' and (evidence['runtime'] is None or evidence['started_by_this_setup'] is None
                             or evidence['owned_process_exit_confirmed'] or updated >= expires or evidence['error'] is not None):
        raise ValueError('Ready requires current verified runtime and an owned live hold')
    if state in {'released', 'expired'} and (not evidence['owned_process_exit_confirmed'] or evidence['release_reason'] is None):
        raise ValueError('Release requires confirmed owned-process exit; expiry alone is insufficient')
    if state == 'expired' and (updated < expires or evidence['release_reason'] != 'deadline'):
        raise ValueError('Expired setup requires its elapsed deadline and confirmed owned exit')
    if state in {'failed', 'uncertain'} and evidence['error'] is None:
        raise ValueError('Failed or uncertain setup requires retained failure evidence')
    return safe(document)


def validate_transition(previous, current):
    validate_setup(previous); validate_setup(current)
    immutable = SETUP_FIELDS - {'state', 'updated_at', 'evidence'}
    if any(canonical(previous[key]) != canonical(current[key]) for key in immutable):
        raise ValueError('Runtime setup identity, selection, owner, deadline and authority are immutable')
    if current['state'] not in TRANSITIONS[previous['state']]:
        raise ValueError('Invalid runtime setup transition')
    if timestamp(current['updated_at']) < timestamp(previous['updated_at']):
        raise ValueError('Runtime setup clock moved backwards')
    old, new = previous['evidence'], current['evidence']
    for key in ('started_by_this_setup', 'runtime'):
        if old[key] is not None and canonical(old[key]) != canonical(new[key]):
            raise ValueError('Retained runtime verification cannot be replaced')
    if old['owned_process_exit_confirmed'] and not new['owned_process_exit_confirmed']:
        raise ValueError('Confirmed owned-process exit cannot be revoked')
    if current['state'] == 'failed' and not new['owned_process_exit_confirmed']:
        if previous['state'] != 'accepted' or new['started_by_this_setup'] is not None or new['runtime'] is not None:
            raise ValueError('A possibly running holder must remain uncertain until its exit is confirmed')
    return deepcopy(current)
