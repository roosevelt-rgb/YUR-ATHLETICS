"""Runtime preparation persistence on CommitService; no process execution or timers."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json

from . import runtime_setup_contract as contract

ZERO = '0' * 64


class RuntimeSetupConflictError(ValueError):
    """An operator setup identity, revision or active lease conflicts."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def _receipt(event):
    return {key: event[key] for key in ('id', 'operation_id', 'revision', 'event_type', 'created_at', 'previous_hash', 'hash')}


class RuntimeSetupCommitMixin:
    """Only the existing CommitService mixes in this separate operational clock."""

    def _initialize_runtime_setup_schema(self):
        self._db.execute('''CREATE TABLE runtime_setups (
            operation_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL,
            document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
            active_lease INTEGER UNIQUE CHECK(active_lease IS NULL OR active_lease=1))''')
        self._db.execute('''CREATE TABLE runtime_setup_events (
            id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES runtime_setups(operation_id),
            revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL,
            created_at TEXT NOT NULL, state_digest TEXT NOT NULL,
            previous_hash TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(operation_id,revision))''')
        self._db.execute('CREATE INDEX runtime_setup_events_operation ON runtime_setup_events(operation_id,id)')

    def _runtime_setup_required(self, operation_id):
        row = self._db.execute('SELECT * FROM runtime_setups WHERE operation_id=?', (operation_id,)).fetchone()
        return None if row is None else {**json.loads(row['document']), 'revision': row['revision']}

    def _runtime_setup_append(self, document, revision):
        last = self._db.execute('SELECT id,hash FROM runtime_setup_events ORDER BY id DESC LIMIT 1').fetchone()
        event = {'id': last['id'] + 1 if last else 1, 'operation_id': document['operation_id'],
                 'revision': revision, 'event_type': 'runtime.setup.' + document['state'],
                 'data': {'document': document}, 'created_at': document['updated_at'],
                 'state_digest': contract.digest({'document': document, 'revision': revision}),
                 'previous_hash': last['hash'] if last else ZERO}
        event['hash'] = contract.digest(event)
        self._db.execute('INSERT INTO runtime_setup_events VALUES (?,?,?,?,?,?,?,?,?)',
            tuple(contract.canonical(event[key]).decode() if key == 'data' else event[key]
                  for key in ('id', 'operation_id', 'revision', 'event_type', 'data', 'created_at',
                              'state_digest', 'previous_hash', 'hash')))
        return _receipt(event)

    def _runtime_setup_last_receipt(self, operation_id):
        row = self._db.execute('SELECT * FROM runtime_setup_events WHERE operation_id=? ORDER BY revision DESC LIMIT 1', (operation_id,)).fetchone()
        return _receipt(dict(row))

    def accept_runtime_setup(self, operation_id, resource_id, distro, check, authority, owner_session_id):
        contract.validate_uuid(operation_id); contract.validate_uuid(owner_session_id)
        contract.validate_authority(authority, operation_id, resource_id)
        check = contract.validate_check(check)
        if resource_id != contract.resource_id_for(distro): raise ValueError('Runtime resource selection changed')
        identity = {'operation_id': operation_id, 'resource_id': resource_id, 'distro': distro,
                    'check': check, 'authority': authority, 'owner_session_id': owner_session_id}
        with self._transaction():
            existing = self._runtime_setup_required(operation_id)
            if existing is not None:
                if any(contract.canonical(existing[key]) != contract.canonical(value) for key, value in identity.items()):
                    raise RuntimeSetupConflictError('Runtime setup operation already belongs to another immutable request')
                return {'setup': existing, 'receipt': self._runtime_setup_last_receipt(operation_id), 'replayed': True}
            if self._db.execute('SELECT 1 FROM runtime_setups WHERE active_lease=1').fetchone():
                raise RuntimeSetupConflictError('Another runtime setup holds the active lease; inspect or release it first')
            if self._db.execute('SELECT count(*) FROM runtime_setups').fetchone()[0] >= contract.MAX_SETUPS:
                raise ValueError('Runtime setup history reached its bounded record limit')
            stamp = _now()
            document = contract.validate_setup({'schema': contract.SCHEMA, **deepcopy(identity), 'state': 'accepted',
                'created_at': stamp, 'updated_at': stamp,
                'expires_at': (contract.timestamp(stamp) + timedelta(seconds=contract.MAX_HOLD_SECONDS)).isoformat(),
                'evidence': contract.empty_evidence()})
            self._db.execute('INSERT INTO runtime_setups VALUES (?,?,?,?,1)',
                             (operation_id, resource_id, contract.canonical(document).decode(), 1))
            receipt = self._runtime_setup_append(document, 1)
            return {'setup': {**document, 'revision': 1}, 'receipt': receipt, 'replayed': False}

    def transition_runtime_setup(self, operation_id, expected_revision, state, evidence, *, owner_session_id):
        contract.validate_uuid(operation_id); contract.validate_uuid(owner_session_id)
        if type(expected_revision) is not int or not 1 <= expected_revision < contract.MAX_EVENTS:
            raise ValueError('Runtime setup revision exceeds its bound')
        if state not in contract.STATES: raise ValueError('Unknown runtime setup state')
        evidence = contract.validate_evidence(evidence)
        with self._transaction():
            current = self._runtime_setup_required(operation_id)
            if current is None: raise ValueError('Runtime setup operation not found')
            if current['owner_session_id'] != owner_session_id:
                raise RuntimeSetupConflictError('Runtime setup is owned by another private session')
            if current['revision'] != expected_revision:
                if (current['revision'] == expected_revision + 1 and current['state'] == state
                        and contract.canonical(current['evidence']) == contract.canonical(evidence)):
                    return {'setup': current, 'receipt': self._runtime_setup_last_receipt(operation_id), 'replayed': True}
                raise RuntimeSetupConflictError('Runtime setup revision changed; inspect the same operation')
            previous = {key: value for key, value in current.items() if key != 'revision'}
            document = contract.validate_transition(previous, {**deepcopy(previous), 'state': state,
                                                               'updated_at': _now(), 'evidence': evidence})
            revision = current['revision'] + 1
            self._db.execute('UPDATE runtime_setups SET document=?,revision=?,active_lease=? WHERE operation_id=? AND revision=?',
                (contract.canonical(document).decode(), revision, 1 if state in contract.ACTIVE_STATES else None,
                 operation_id, current['revision']))
            receipt = self._runtime_setup_append(document, revision)
            return {'setup': {**document, 'revision': revision}, 'receipt': receipt, 'replayed': False}

    def get_runtime_setup(self, operation_id):
        contract.validate_uuid(operation_id)
        with self._read_transaction(): return self._runtime_setup_required(operation_id)

    def active_runtime_setup(self, resource_id=None):
        if resource_id is not None: contract.validate_hash(resource_id)
        with self._read_transaction():
            row = self._db.execute('SELECT operation_id,resource_id FROM runtime_setups WHERE active_lease=1').fetchone()
            if row is None or (resource_id is not None and row['resource_id'] != resource_id): return None
            return self._runtime_setup_required(row['operation_id'])

    def runtime_setup_events(self, operation_id, limit=50, before_id=None):
        contract.validate_uuid(operation_id)
        if type(limit) is not int or not 1 <= limit <= 50 or (before_id is not None and (type(before_id) is not int or before_id < 1)):
            raise ValueError('Runtime setup history requires bounded pagination')
        with self._read_transaction():
            rows = self._db.execute('SELECT * FROM runtime_setup_events WHERE operation_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?',
                                    (operation_id, before_id, before_id, limit + 1)).fetchall()
            events = []
            for row in rows[:limit]:
                event = dict(row); document = json.loads(event['data'])['document']
                events.append({**_receipt(event), 'state': document['state'], 'evidence': document['evidence']})
            return {'events': events, 'next_cursor': events[-1]['id'] if len(rows) > limit else None}

    def _verify_runtime_setups(self):
        previous_hash, count, latest = ZERO, 0, {}
        active = None
        for row in self._db.execute('SELECT * FROM runtime_setup_events ORDER BY id'):
            event = dict(row); event['data'] = json.loads(event['data']); stored = event.pop('hash'); count += 1
            if (event['id'] != count or event['previous_hash'] != previous_hash or contract.digest(event) != stored
                    or type(event['data']) is not dict or set(event['data']) != {'document'}):
                raise ValueError('Runtime setup event chain mismatch')
            document = contract.validate_setup(event['data']['document']); identity = document['operation_id']
            if (event['operation_id'] != identity or event['event_type'] != 'runtime.setup.' + document['state']
                    or event['created_at'] != document['updated_at'] or type(event['revision']) is not int
                    or not 1 <= event['revision'] <= contract.MAX_EVENTS
                    or event['state_digest'] != contract.digest({'document': document, 'revision': event['revision']})):
                raise ValueError('Runtime setup event identity mismatch')
            prior = latest.get(identity)
            if prior is None:
                if event['revision'] != 1 or document['state'] != 'accepted' or document['created_at'] != document['updated_at']:
                    raise ValueError('Runtime setup history must begin with operator acceptance')
                if active is not None: raise ValueError('Runtime setup history contains overlapping active leases')
                active = identity
            else:
                if event['revision'] != prior[1] + 1: raise ValueError('Runtime setup revision gap')
                contract.validate_transition(prior[0], document)
                if active != identity: raise ValueError('Runtime setup transition lacks its active lease')
            if document['state'] not in contract.ACTIVE_STATES: active = None
            latest[identity] = (document, event['revision']); previous_hash = stored
        rows = list(self._db.execute('SELECT * FROM runtime_setups'))
        if len(rows) > contract.MAX_SETUPS or {row['operation_id'] for row in rows} != set(latest):
            raise ValueError('Runtime setup state/event coverage mismatch')
        for row in rows:
            document, revision = latest[row['operation_id']]
            if (row['resource_id'] != document['resource_id'] or row['revision'] != revision
                    or row['document'] != contract.canonical(document).decode()
                    or row['active_lease'] != (1 if document['state'] in contract.ACTIVE_STATES else None)):
                raise ValueError('Runtime setup projection mismatch')
        return {'runtime_setups': len(rows), 'runtime_setup_events': count, 'runtime_setup_head_hash': previous_hash}
