"""Franklin conversation receipts, owned by the existing CommitService.

Nova's bounded department memory/request replay contract is adapted here. Work
missions remain in their existing lane; this module owns neither a worker nor a
second database. See docs/franklin-nova-reuse.md for donor provenance.
"""
from __future__ import annotations

from copy import deepcopy
import re
import uuid

from .repository_context import SECRET_CONTENT
from .work_store import ZERO, digest, encoded, now

# The source detector's unanchored URI scheme expression is quadratic on long
# prose tokens. Bound only that scheme prefix; retain its credential detectors.
_SECRET = re.compile(SECRET_CONTENT.pattern.replace('[a-z]+://', r'\b[a-z]{1,32}://'), SECRET_CONTENT.flags)

SCHEMA = "yur.franklin.snapshot.v1"
ACTIVE = {"accepted", "running"}
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
DEFAULT_PREFERENCES = {"model": "", "open": False, "draft": ""}
MAX_REQUESTS = 10000  # Never silently evict replay identities.
MAX_ENVIRONMENT = 32768
MAX_RESULT = 144 * 1024
MAX_SNAPSHOT_BYTES = 768 * 1024
MAX_SNAPSHOT_HISTORY_BYTES = 512 * 1024
CONVERSATION_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "yur:desktop:franklin:conversation:v1"))


def safe(value, maximum):
    raw = encoded(value)
    if len(raw.encode("utf-8")) > maximum or _SECRET.search(raw):
        raise ValueError("Franklin data exceeds its budget or contains credential-like content")
    return deepcopy(value)


def request_id(value):
    if type(value) is not str or str(uuid.UUID(value)) != value:
        raise ValueError("Franklin requires a canonical request UUID")
    return value


def preferences(value):
    if type(value) is not dict or set(value) != set(DEFAULT_PREFERENCES):
        raise ValueError("Invalid Franklin preferences")
    if (type(value['open']) is not bool or type(value['draft']) is not str
            or len(value['draft']) > 32000 or type(value['model']) is not str
            or not re.fullmatch(r'[^\s\x00-\x1f]{0,256}', value['model'])):
        raise ValueError("Franklin preferences exceed their typed bounds")
    return safe(value, 160 * 1024)


def _valid(kind, doc):
    if type(doc) is not dict:
        raise ValueError("Invalid Franklin document")
    if kind == 'preferences':
        return preferences(doc)
    if kind == 'request':
        fields = {'id', 'mission_id', 'status', 'text', 'input_sha256', 'model',
                  'environment', 'context', 'context_sha256', 'summary', 'created_at', 'updated_at'}
        if set(doc) != fields or doc['status'] not in ACTIVE | TERMINAL:
            raise ValueError("Invalid Franklin request document")
        request_id(doc['id'])
        if doc['mission_id'] is not None and not re.fullmatch(r'[0-9a-f]{32}', doc['mission_id']):
            raise ValueError("Invalid Franklin mission binding")
        if type(doc['text']) is not str or not 1 <= len(doc['text'].strip()) <= 32000:
            raise ValueError("Franklin needs a bounded user message")
        if doc['input_sha256'] != digest({'text': doc['text']}):
            raise ValueError("Franklin input digest mismatch")
        preferences({**DEFAULT_PREFERENCES, 'model': doc['model']})
        if type(doc['environment']) is not dict:
            raise ValueError("Franklin environment must be host observations")
        safe(doc['environment'], MAX_ENVIRONMENT)
        if (type(doc['context']) is not list or len(doc['context']) > 12
                or doc['context_sha256'] != digest(doc['context'])):
            raise ValueError("Invalid recalled Franklin context")
        for message in doc['context']:
            if (type(message) is not dict or set(message) != {'role', 'content'}
                    or message['role'] not in {'user', 'assistant'} or type(message['content']) is not str):
                raise ValueError("Invalid recalled Franklin message")
        safe(doc['context'], 64 * 1024)
        if type(doc['summary']) is not str or len(doc['summary']) > 32000:
            raise ValueError("Franklin final summary exceeds its budget")
    elif kind == 'action':
        fields = {'id', 'mission_id', 'request_id', 'action', 'payload', 'status',
                  'result', 'created_at', 'updated_at'}
        if set(doc) != fields or doc['status'] not in {'pending', 'completed', 'failed', 'uncertain'}:
            raise ValueError("Invalid Franklin action receipt")
        if not re.fullmatch(r'[0-9a-f]{32}', doc['id']) or not re.fullmatch(r'[0-9a-f]{32}', doc['mission_id']):
            raise ValueError("Invalid Franklin action identity")
        request_id(doc['request_id'])
        from .work_desktop import validate_arguments
        validate_arguments({'action': doc['action'], 'payload': doc['payload']})
        if doc['status'] == 'pending' and doc['result'] is not None:
            raise ValueError("Pending host actions cannot claim a result")
        if doc['status'] != 'pending' and type(doc['result']) is not dict:
            raise ValueError("Finished host actions require a result")
        safe(doc['result'], MAX_RESULT)
    else:
        raise ValueError("Unsupported Franklin document kind")
    from datetime import datetime
    for field in ('created_at', 'updated_at'):
        if type(doc[field]) is not str or datetime.fromisoformat(doc[field]).tzinfo is None:
            raise ValueError("Franklin timestamps require a timezone")
    if doc['updated_at'] < doc['created_at']:
        raise ValueError("Franklin timestamps run backwards")
    return safe(doc, 320 * 1024)


def _transition(kind, old, new):
    if kind == 'request':
        if old is None:
            if new['status'] != 'accepted' or new['mission_id'] is not None or new['summary']:
                raise ValueError("Franklin requests must begin with acceptance")
        else:
            immutable = {'id', 'text', 'input_sha256', 'model', 'environment', 'context', 'context_sha256', 'created_at'}
            if any(old[key] != new[key] for key in immutable):
                raise ValueError("Franklin request identity or compiled context changed")
            if old['mission_id'] is not None and old['mission_id'] != new['mission_id']:
                raise ValueError("Franklin mission binding changed")
            if old['status'] in TERMINAL and new['status'] != old['status']:
                raise ValueError("Franklin terminal requests cannot restart")
            if old['status'] == 'running' and new['status'] == 'accepted':
                raise ValueError("Franklin request cannot move backwards")
    elif kind == 'action':
        if old is None:
            if new['status'] != 'pending':
                raise ValueError("Host action must begin with an intent receipt")
        else:
            if old['status'] != 'pending' or new['status'] == 'pending':
                raise ValueError("Host actions cannot repeat or change committed results")
            if any(old[key] != new[key] for key in ('id', 'mission_id', 'request_id', 'action', 'payload', 'created_at')):
                raise ValueError("Host action identity changed")


class FranklinCommitMixin:
    def _initialize_franklin_schema(self):
        self._db.execute("""CREATE TABLE IF NOT EXISTS franklin_documents (
            kind TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0), PRIMARY KEY(kind,id))""")
        self._db.execute("""CREATE TABLE IF NOT EXISTS franklin_events (
            id INTEGER PRIMARY KEY, kind TEXT NOT NULL, document_id TEXT NOT NULL,
            revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL,
            created_at TEXT NOT NULL, state_digest TEXT NOT NULL,
            previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
            UNIQUE(kind,document_id,revision))""")

    def _franklin_get(self, kind, identity):
        import json
        row = self._db.execute('SELECT * FROM franklin_documents WHERE kind=? AND id=?', (kind, identity)).fetchone()
        return (json.loads(row['document']), row['revision']) if row else (None, 0)

    def _franklin_commit(self, kind, identity, document, expected_revision, event_type):
        if not self._db.in_transaction:
            raise RuntimeError("Franklin writes require a CommitService transaction")
        document = _valid(kind, document)
        old, revision = self._franklin_get(kind, identity)
        if type(expected_revision) is not int or revision != expected_revision:
            raise ValueError("Franklin revision changed; reload its state")
        _transition(kind, old, document)
        revision += 1
        self._db.execute('INSERT INTO franklin_documents VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET document=excluded.document,revision=excluded.revision',
                         (kind, identity, encoded(document), revision))
        last = self._db.execute('SELECT id,hash FROM franklin_events ORDER BY id DESC LIMIT 1').fetchone()
        event = {'id': last['id'] + 1 if last else 1, 'kind': kind, 'document_id': identity,
                 'revision': revision, 'event_type': event_type, 'data': {'document': document},
                 'created_at': now(), 'state_digest': digest(document), 'previous_hash': last['hash'] if last else ZERO}
        event['hash'] = digest(event)
        self._db.execute('INSERT INTO franklin_events VALUES (?,?,?,?,?,?,?,?,?,?)',
                         tuple(encoded(event[key]) if key == 'data' else event[key] for key in
                               ('id', 'kind', 'document_id', 'revision', 'event_type', 'data', 'created_at', 'state_digest', 'previous_hash', 'hash')))
        return {key: value for key, value in event.items() if key != 'data'}

    def _franklin_requests(self, limit=100):
        import json
        return [json.loads(row['document']) for row in self._db.execute(
            "SELECT document FROM franklin_documents WHERE kind='request' ORDER BY rowid DESC LIMIT ?", (limit,))][::-1]

    @staticmethod
    def _franklin_messages(requests):
        messages = []
        for item in requests:
            messages.append({'id': item['id'] + ':user', 'request_id': item['id'], 'role': 'user',
                             'content': item['text'], 'created_at': item['created_at']})
            if item['summary']:
                messages.append({'id': item['id'] + ':assistant', 'request_id': item['id'], 'role': 'assistant',
                                 'content': item['summary'], 'created_at': item['updated_at']})
        return messages

    def franklin_snapshot(self):
        import json
        with self._read_transaction():
            prefs, revision = self._franklin_get('preferences', 'default')
            requests = self._franklin_requests()
            events = []
            for row in self._db.execute('SELECT * FROM franklin_events ORDER BY id DESC LIMIT 50'):
                receipt = dict(row); document = json.loads(receipt.pop('data'))['document']
                kind = receipt['kind']
                summary = ('Assistant preferences saved' if kind == 'preferences' else
                           'Desktop ' + document['action'].replace('_', ' ') + ': ' + document['status'] if kind == 'action' else
                           'Assistant request ' + document['status'])
                events.insert(0, {'id': receipt['id'], 'type': receipt['event_type'], 'summary': summary,
                                  'request_id': document.get('request_id', document.get('id')),
                                  'status': document.get('status', 'committed'), 'receipt': receipt})
            messages, size = [], 0
            for message in reversed(self._franklin_messages(requests)[-200:]):
                size += len(encoded(message).encode('utf-8'))
                if size > MAX_SNAPSHOT_HISTORY_BYTES:
                    break
                messages.insert(0, message)
            last = requests[-1] if requests else None
            context = {'summary': ('The latest accepted task included bounded conversation recall and host observations.' if last else
                                   'The next task will compile recent conversation and the current Desktop observations.'),
                       'sections': [] if last is None else [
                           {'label': 'Recalled messages', 'value': len(last['context'])},
                           {'label': 'Context SHA-256', 'value': last['context_sha256']},
                           {'label': 'Selected model', 'value': last['model']},
                           {'label': 'Environment', 'value': last['environment'].get('schema', 'host observations')}]}
            snapshot = {'schema': SCHEMA, 'revision': revision, 'preferences': prefs or deepcopy(DEFAULT_PREFERENCES),
                    'conversation_id': CONVERSATION_ID, 'messages': messages,
                    'requests': [{key: item[key] for key in ('id', 'mission_id', 'status', 'input_sha256', 'context_sha256', 'created_at', 'updated_at')} for item in requests],
                    'active_request': next(({'request_id': item['id'], 'mission_id': item['mission_id'], 'status': item['status']} for item in reversed(requests) if item['status'] in ACTIVE), None),
                    'context': context,
                    'permissions': {'summary': 'Desktop missions use connected tools, human confirmation for consequential operations, and the existing runtime validation and Commit Service boundaries. Capability discovery distinguishes connected adapters from missing services.',
                                    'actions': ['Discover connected capabilities', 'Submit and follow IntelliFlow build tasks', 'Request image and video generation', 'Inspect and operate admitted workforce capabilities', 'Observe and navigate Desktop', 'Read visible browser text', 'Create mission plans and deliverables']},
                    'events': events}
            # Reserve room for preferences and receipt metadata in the host's
            # 1 MiB NDJSON frame. Match the emitter's spaced JSON serialization.
            visible_count = len(self._franklin_messages(requests)[-200:])
            snapshot['history_truncated'] = len(messages) < visible_count
            while len(json.dumps(snapshot, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_SNAPSHOT_BYTES:
                if not messages:
                    raise ValueError('Franklin snapshot metadata exceeds its output budget')
                messages.pop(0)
                snapshot['history_truncated'] = True
            return snapshot

    def franklin_configure(self, patch, expected_revision=None):
        if type(patch) is not dict or not patch or set(patch) - set(DEFAULT_PREFERENCES):
            raise ValueError("Configure accepts a model/open/draft patch only")
        with self._transaction():
            current, revision = self._franklin_get('preferences', 'default')
            document = preferences({**(current or DEFAULT_PREFERENCES), **patch})
            self._franklin_commit('preferences', 'default', document, revision if expected_revision is None else expected_revision, 'franklin.preferences.committed')
        return self.franklin_snapshot()

    def franklin_accept(self, identity, text, environment):
        request_id(identity)
        if type(text) is not str or not 1 <= len(text.strip()) <= 32000 or type(environment) is not dict:
            raise ValueError("Franklin send requires bounded text and host observations")
        environment = safe(environment, MAX_ENVIRONMENT)
        with self._transaction():
            existing, _ = self._franklin_get('request', identity)
            if existing is not None:
                if existing['input_sha256'] != digest({'text': text}):
                    raise ValueError("Franklin request ID already belongs to different input")
                return {'created': False, 'request': existing}
            if self._db.execute("SELECT COUNT(*) FROM franklin_documents WHERE kind='request'").fetchone()[0] >= MAX_REQUESTS:
                raise ValueError("Franklin request retention capacity requires operator archival")
            # Only one admitted turn can own this conversation at a time.
            if self._db.execute("SELECT 1 FROM franklin_documents WHERE kind='request' AND json_extract(document,'$.status') IN ('accepted','running') LIMIT 1").fetchone():
                raise ValueError("Franklin already has an active request")
            prefs, _ = self._franklin_get('preferences', 'default')
            recalled = self._franklin_messages(self._franklin_requests(12))[-12:]
            context, remaining = [], 12000
            for message in reversed(recalled):
                if remaining <= 0:
                    break
                content = message['content'][-min(4000, remaining):]
                context.insert(0, {'role': message['role'], 'content': content})
                remaining -= len(content)
            document = {'id': identity, 'mission_id': None, 'status': 'accepted', 'text': text,
                        'input_sha256': digest({'text': text}), 'model': (prefs or DEFAULT_PREFERENCES)['model'],
                        'environment': environment, 'context': context, 'context_sha256': digest(context),
                        'summary': '', 'created_at': now(), 'updated_at': now()}
            self._franklin_commit('request', identity, document, 0, 'franklin.request.accepted')
            return {'created': True, 'request': document}

    def franklin_get_request(self, identity):
        request_id(identity)
        with self._read_transaction():
            document, _ = self._franklin_get('request', identity)
            if document is None:
                raise ValueError("Franklin request not found")
            return document

    def _franklin_cancel_work(self, document):
        mission = self.get_work_by_request(document['id'])
        if mission is not None and mission['status'] not in {'completed', 'cancelled'}:
            revision = mission.pop('revision'); mission.pop('receipt', None)
            mission.update(status='cancelled', updated_at=now())
            self._commit_work_locked(mission, revision, 'work.cancelled', {'issuer': 'local-user', 'source': 'franklin'})
        return mission

    def franklin_bind(self, identity, mission_id):
        with self._transaction():
            document, revision = self._franklin_get('request', identity)
            mission = self.get_work(mission_id)
            if document is None or mission['request_id'] != identity:
                raise ValueError("Franklin mission does not match its accepted request")
            if document['mission_id'] not in {None, mission_id}:
                raise ValueError("Franklin request is already bound")
            if document['status'] in {'cancelled', 'interrupted', 'failed'}:
                self._franklin_cancel_work(document)
            if document['mission_id'] is None or document['status'] == 'accepted':
                document = {**document, 'mission_id': mission_id, 'updated_at': now(),
                            'status': 'running' if document['status'] in ACTIVE else document['status']}
                self._franklin_commit('request', identity, document, revision, 'franklin.request.bound')
            return document

    def franklin_finish(self, identity, status, summary=''):
        if status not in TERMINAL or type(summary) is not str:
            raise ValueError("Invalid Franklin final state")
        with self._transaction():
            document, revision = self._franklin_get('request', identity)
            if document is None:
                raise ValueError("Franklin request not found")
            if document['status'] in TERMINAL:
                return document
            document = {**document, 'status': status, 'summary': summary[:32000], 'updated_at': now()}
            self._franklin_commit('request', identity, document, revision, 'franklin.request.' + status)
            return document

    def franklin_cancel(self, identity):
        request_id(identity)
        with self._transaction():
            document, revision = self._franklin_get('request', identity)
            if document is None:
                raise ValueError("Franklin request not found")
            if document['status'] not in TERMINAL:
                mission = self._franklin_cancel_work(document)
                completed = mission is not None and mission['status'] == 'completed'
                document = {**document, 'status': 'completed' if completed else 'cancelled',
                            'summary': mission['answer'][:32000] if completed else 'This request was cancelled.', 'updated_at': now()}
                self._franklin_commit('request', identity, document, revision, 'franklin.request.' + document['status'])
        return self.franklin_snapshot()

    def franklin_recover(self):
        # The canonical worker lock prevents recovery from interrupting live work.
        with self.acquire_worker():
            with self._transaction():
                for document in self._franklin_requests(MAX_REQUESTS):
                    if document['status'] not in ACTIVE:
                        continue
                    _, revision = self._franklin_get('request', document['id'])
                    mission = self._franklin_cancel_work(document)
                    complete = mission is not None and mission['status'] == 'completed'
                    document.update(status='completed' if complete else 'interrupted', updated_at=now(),
                                    summary=mission['answer'][:32000] if complete else 'This request was interrupted. Inspect its receipts before starting another request.')
                    self._franklin_commit('request', document['id'], document, revision, 'franklin.request.recovered')
                import json
                for row in self._db.execute("SELECT * FROM franklin_documents WHERE kind='action' AND json_extract(document,'$.status')='pending'").fetchall():
                    action = json.loads(row['document'])
                    action.update(status='uncertain', result={'status': 'uncertain', 'error': 'Host outcome was not committed; this action will not be repeated.'}, updated_at=now())
                    self._franklin_commit('action', action['id'], action, row['revision'], 'franklin.action.uncertain')
        return self.franklin_snapshot()

    def franklin_action_begin(self, mission_id, identity, action_id, action, payload):
        from .work_desktop import AUTHORITY, HOST_AUTHORITY
        with self._transaction():
            request, _ = self._franklin_get('request', identity)
            mission = self.get_work(mission_id)
            if (request is None or request['mission_id'] != mission_id or request['status'] != 'running'
                    or mission['status'] != 'running' or mission['request_id'] != identity
                    or mission['authority'] != AUTHORITY or request['environment'].get('authority') != HOST_AUTHORITY):
                raise ValueError("Desktop action lacks its bound operator authority")
            old, _ = self._franklin_get('action', action_id)
            if old is not None:
                if any(old[key] != value for key, value in {'mission_id': mission_id, 'request_id': identity, 'action': action, 'payload': payload}.items()):
                    raise ValueError("Desktop action identity already belongs to another intent")
                return {'created': False, 'action': old}
            import json
            for row in self._db.execute("SELECT document FROM franklin_documents WHERE kind='action' AND json_extract(document,'$.mission_id')=? AND json_extract(document,'$.status') IN ('pending','failed','uncertain')", (mission_id,)):
                prior = json.loads(row['document'])
                if prior['action'] == action and prior['payload'] == payload:
                    raise ValueError("An earlier matching Desktop action failed or has an uncertain outcome; it cannot repeat")
            count = self._db.execute("SELECT COUNT(*) FROM franklin_documents WHERE kind='action' AND json_extract(document,'$.mission_id')=?", (mission_id,)).fetchone()[0]
            if count >= 20:
                raise ValueError("Desktop action budget exhausted")
            document = {'id': action_id, 'mission_id': mission_id, 'request_id': identity, 'action': action, 'payload': payload,
                        'status': 'pending', 'result': None, 'created_at': now(), 'updated_at': now()}
            receipt = self._franklin_commit('action', action_id, document, 0, 'franklin.action.accepted')
            return {'created': True, 'action': document, 'receipt': receipt}

    def franklin_action_finish(self, action_id, result):
        result = safe(result, MAX_RESULT)
        if type(result) is not dict:
            raise ValueError("Desktop result must be an object")
        with self._transaction():
            document, revision = self._franklin_get('action', action_id)
            if document is None or document['status'] != 'pending':
                raise ValueError("Desktop action is no longer pending")
            status = 'uncertain' if result.get('status') == 'uncertain' else 'failed' if result.get('error') or result.get('status') in {'failed', 'rejected'} else 'completed'
            document = {**document, 'result': result, 'status': status, 'updated_at': now()}
            receipt = self._franklin_commit('action', action_id, document, revision, 'franklin.action.' + status)
            return {'action': document, 'receipt': receipt}

    def _verify_franklin(self):
        import json
        if not self._db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='franklin_documents'").fetchone():
            return {}
        latest, previous, count = {}, ZERO, 0
        for row in self._db.execute('SELECT * FROM franklin_events ORDER BY id'):
            event = dict(row); event['data'] = json.loads(event['data'])
            stored = event.pop('hash'); count += 1
            document = _valid(event['kind'], event['data']['document'])
            identity = (event['kind'], event['document_id']); prior = latest.get(identity)
            if (event['id'] != count or event['previous_hash'] != previous or digest(event) != stored
                    or event['state_digest'] != digest(document) or not event['event_type'].startswith('franklin.')
                    or event['revision'] != (prior[0] + 1 if prior else 1)
                    or (event['kind'] != 'preferences' and document['id'] != event['document_id'])):
                raise ValueError("Franklin receipt chain mismatch")
            _transition(event['kind'], prior[1] if prior else None, document)
            latest[identity] = (event['revision'], document); previous = stored
        rows = self._db.execute('SELECT * FROM franklin_documents').fetchall()
        if set(latest) != {(row['kind'], row['id']) for row in rows}:
            raise ValueError("Franklin receipt coverage mismatch")
        for row in rows:
            if latest[(row['kind'], row['id'])] != (row['revision'], json.loads(row['document'])):
                raise ValueError("Franklin state differs from its committed receipt")
        return {'franklin_documents': len(rows), 'franklin_events': count, 'franklin_head_hash': previous}
