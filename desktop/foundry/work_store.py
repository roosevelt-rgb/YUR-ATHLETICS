"""Work-mission persistence owned by CommitService, separate from conversation state."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import uuid

ZERO = "0" * 64
MAX_DOCUMENT_BYTES = 1024 * 1024
# Work is deliberately bounded, but the original twenty-step envelope was a
# short interaction budget rather than a viable repository-mission budget.
# Keep the old value readable for historical receipts while issuing new work
# with a larger finite authority.
HISTORICAL_MAX_WORK_STEPS = 20
MAX_WORK_STEPS = 128
MAX_WORK_ARTIFACTS = 128
MAX_WORK_MESSAGES = 384
# Historical committed Franklin envelope, before host-confirmed execution was
# admitted. Read it exactly as recorded; never expand a receipt's permissions to
# match the current contract. Desktop execution still requires today's authority.
LEGACY_FRANKLIN_AUTHORITY = {
    "issuer": "local-user", "scope": "franklin-desktop-work",
    "actions": ["read", "compute", "propose", "commit-artifact", "desktop.navigate", "browser.read"],
    "max_steps": HISTORICAL_MAX_WORK_STEPS,
}
STATUSES = {"queued", "running", "awaiting_approval", "completed", "failed", "cancelled"}
TRANSITIONS = {
    "queued": {"running", "cancelled"},
    "running": {"running", "awaiting_approval", "completed", "failed", "cancelled"},
    "awaiting_approval": {"running", "cancelled"},
    "failed": {"running", "cancelled"},
    "completed": set(), "cancelled": set(),
}


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def valid_document(document):
    required = {"id", "request_id", "conversation_id", "request", "status", "created_at", "updated_at", "steps", "artifacts", "messages", "answer", "error", "authority"}
    if not isinstance(document, dict) or set(document) != required:
        raise ValueError("Invalid work mission document")
    for key in ("request_id", "conversation_id"):
        if str(uuid.UUID(document[key])) != document[key]:
            raise ValueError("Work identifiers must be canonical UUIDs")
    if uuid.UUID(document["id"]).hex != document["id"] or document["status"] not in STATUSES:
        raise ValueError("Invalid work mission identifier or status")
    if not isinstance(document["request"], dict) or not isinstance(document["authority"], dict):
        raise ValueError("Work requires a request and authority envelope")
    if any(document["request"].get(key) != document[key] for key in ("request_id", "conversation_id")):
        raise ValueError("Work request identity mismatch")
    if 'browser_source' in document['request']:
        from .work_browser import validate_source
        validate_source(document['request']['browser_source'])
    for key in ("created_at", "updated_at"):
        if not isinstance(document[key], str) or datetime.fromisoformat(document[key]).tzinfo is None:
            raise ValueError("Work timestamps must be timezone aware")
    if datetime.fromisoformat(document["updated_at"]) < datetime.fromisoformat(document["created_at"]):
        raise ValueError("Work timestamps cannot run backwards")
    from .work_desktop import AUTHORITY as FRANKLIN_AUTHORITY
    standard_authority = {"issuer": "local-user", "scope": "work-proposals", "actions": ["read", "compute", "propose", "commit-artifact"], "max_steps": MAX_WORK_STEPS}
    historical_authority = {"issuer": "local-user", "scope": "work-proposals", "actions": ["read", "compute", "propose", "commit-artifact"], "max_steps": HISTORICAL_MAX_WORK_STEPS}
    if document["authority"] not in (standard_authority, historical_authority, LEGACY_FRANKLIN_AUTHORITY, FRANKLIN_AUTHORITY):
        raise ValueError("Invalid bounded work authority")
    step_limit = document["authority"]["max_steps"]
    for key in ("steps", "artifacts", "messages"):
        if not isinstance(document[key], list):
            raise ValueError("Work collections must be lists")
    if (len(document["steps"]) > step_limit or len(document["artifacts"]) > MAX_WORK_ARTIFACTS
            or len(document["messages"]) > MAX_WORK_MESSAGES):
        raise ValueError("Work exceeded its explicit step/context budget")
    if not isinstance(document["answer"], str) or len(document["answer"]) > 100000 or not isinstance(document["error"], str) or len(document["error"]) > 2000:
        raise ValueError("Work response exceeds limits")
    value = encoded(document)
    if len(value.encode()) > MAX_DOCUMENT_BYTES:
        raise ValueError("Work mission exceeds its 1 MiB state budget")
    return json.loads(value)


class WorkCommitMixin:
    """Methods invoked only on the existing CommitService instance."""

    def _initialize_work_schema(self):
        self._db.execute("""CREATE TABLE work_missions (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
            document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0))""")
        self._db.execute("""CREATE TABLE work_events (
            id INTEGER PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES work_missions(id),
            revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL,
            created_at TEXT NOT NULL, state_digest TEXT NOT NULL,
            previous_hash TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(mission_id, revision))""")

    def _work_append(self, document, revision, event_type, change):
        last = self._db.execute("SELECT id, hash FROM work_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {"id": last["id"] + 1 if last else 1, "mission_id": document["id"],
                 "revision": revision, "event_type": event_type,
                 "data": {"document": document, "change": change}, "created_at": now(),
                 "state_digest": digest(document), "previous_hash": last["hash"] if last else ZERO}
        event["hash"] = digest(event)
        self._db.execute("INSERT INTO work_events VALUES (?,?,?,?,?,?,?,?,?)",
                         (event["id"], event["mission_id"], revision, event_type, encoded(event["data"]),
                          event["created_at"], event["state_digest"], event["previous_hash"], event["hash"]))
        return event

    def submit_work(self, request, authority):
        document = {"id": uuid.uuid4().hex, "request_id": request["request_id"],
                    "conversation_id": request["conversation_id"], "request": request,
                    "status": "queued", "created_at": now(), "updated_at": now(),
                    "steps": [], "artifacts": [], "messages": request["messages"],
                    "answer": "", "error": "", "authority": authority}
        document = valid_document(document)
        with self._transaction():
            existing = self._db.execute("SELECT * FROM work_missions WHERE request_id=?", (request["request_id"],)).fetchone()
            if existing:
                original = json.loads(existing["document"])
                if original["request"] != request or original["authority"] != authority:
                    raise ValueError("Work request ID already belongs to different input")
                return {**original, "revision": existing["revision"]}
            self._db.execute("INSERT INTO work_missions VALUES (?,?,?,1)",
                             (document["id"], document["request_id"], encoded(document)))
            self._work_append(document, 1, "work.submitted", {})
        return {**document, "revision": 1}

    def get_work(self, mission_id):
        with self._read_transaction():
            row = self._db.execute("SELECT * FROM work_missions WHERE id=?", (mission_id,)).fetchone()
            if not row:
                raise ValueError("Work mission not found")
            return {**json.loads(row["document"]), "revision": row["revision"]}

    def list_work(self, conversation_id=None):
        with self._read_transaction():
            rows = self._db.execute("SELECT * FROM work_missions WHERE (? IS NULL OR json_extract(document,'$.conversation_id')=?) ORDER BY rowid DESC LIMIT 200", (conversation_id, conversation_id))
            return [{**json.loads(row["document"]), "revision": row["revision"]} for row in rows]

    def get_work_by_request(self, request_id):
        if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id:
            raise ValueError('Work lookup requires a canonical request identifier')
        with self._read_transaction():
            row = self._db.execute('SELECT * FROM work_missions WHERE request_id=?', (request_id,)).fetchone()
            return {**json.loads(row['document']), 'revision': row['revision']} if row else None

    def commit_work(self, document, expected_revision, event_type, change=None):
        with self._transaction():
            return self._commit_work_locked(document, expected_revision, event_type, change)

    def _commit_work_locked(self, document, expected_revision, event_type, change=None):
        """Existing writer, reused by atomic correction operations in this store."""
        if not self._db.in_transaction:
            raise RuntimeError("Work mutation requires the CommitService transaction")
        checked = valid_document(document)
        if not isinstance(event_type, str) or not event_type.startswith("work.") or len(event_type) > 128:
            raise ValueError("Invalid work event type")
        if type(expected_revision) is not int or expected_revision < 1:
            raise ValueError("Expected work revision must be a positive integer")
        old = self.get_work(checked["id"])
        if old["revision"] != expected_revision:
            raise ValueError("Work mission changed; reload its current revision")
        for key in ("request_id", "conversation_id", "request", "authority", "created_at"):
            if old[key] != checked[key]:
                raise ValueError("Immutable work identity or authority changed")
        from .work_steering import QUEUED, ledger_from_events, validate_history_event
        delivery = event_type.startswith('work.artifact.') and checked['status'] == old['status'] and old['status'] in {'completed', 'failed', 'cancelled'}
        steering = event_type == QUEUED and checked['status'] == old['status'] == 'queued'
        if checked["status"] not in TRANSITIONS[old["status"]] and not delivery and not steering:
            raise ValueError(f"Illegal work transition {old['status']} -> {checked['status']}")
        if delivery and any(old[key] != checked[key] for key in ('steps', 'messages', 'answer', 'error')):
            raise ValueError('Artifact delivery cannot alter completed execution')
        revision = expected_revision + 1
        validate_history_event({"event_type": event_type, "data": {"document": checked, "change": change or {}}, "revision": revision, "hash": ZERO},
                               {key: value for key, value in old.items() if key not in {'revision', 'receipt'}},
                               ledger_from_events(self.work_events(checked['id'])))
        self._db.execute("UPDATE work_missions SET document=?,revision=? WHERE id=?", (encoded(checked), revision, checked["id"]))
        event = self._work_append(checked, revision, event_type, change or {})
        return {**checked, "revision": revision, "receipt": {key: value for key, value in event.items() if key != "data"}}

    def queue_work_steering(self, mission_id, conversation_id, correction_id, text):
        from .work_steering import queue
        return queue(self, mission_id, conversation_id, correction_id, text)

    def consume_work_steering(self, mission_id):
        from .work_steering import consume
        return consume(self, mission_id)

    def work_steering_state(self, mission_id):
        from .work_steering import state
        return state(self, mission_id)

    def commit_work_checkpoint(self, document, expected_revision, event_type, change=None):
        from .work_steering import checkpoint
        return checkpoint(self, document, expected_revision, event_type, change)

    def complete_work_unsteered(self, mission_id, expected_revision, answer):
        from .work_steering import complete
        return complete(self, mission_id, expected_revision, answer)

    def work_events(self, mission_id):
        with self._read_transaction():
            return [{**dict(row), "data": json.loads(row["data"])} for row in self._db.execute("SELECT * FROM work_events WHERE mission_id=? ORDER BY id", (mission_id,))]

    def _verify_work(self):
        from .work_steering import QUEUED, validate_history_event
        steering_ledgers = {}
        latest, previous, count = {}, ZERO, 0
        for row in self._db.execute("SELECT * FROM work_events ORDER BY id"):
            event = dict(row); event["data"] = json.loads(event["data"])
            stored = event.pop("hash"); count += 1
            document = valid_document(event["data"]["document"])
            prior = latest.get(event["mission_id"])
            if (event["id"] != count or event["previous_hash"] != previous or digest(event) != stored
                    or document["id"] != event["mission_id"] or digest(document) != event["state_digest"]
                    or event["revision"] != (prior[0] + 1 if prior else 1)):
                raise ValueError("Work event chain or state mismatch")
            if prior:
                delivery = event['event_type'].startswith('work.artifact.') and document['status'] == prior[1]['status'] and document['status'] in {'completed', 'failed', 'cancelled'}
                steering = event['event_type'] == QUEUED and document['status'] == prior[1]['status'] == 'queued'
                if (document["status"] not in TRANSITIONS[prior[1]["status"]] and not delivery and not steering) or any(document[key] != prior[1][key] for key in ("request_id", "conversation_id", "request", "authority", "created_at")):
                    raise ValueError("Work history changed immutable identity or lifecycle")
            elif document["status"] != "queued" or event["event_type"] != "work.submitted":
                raise ValueError("Work history must begin with submission")
            validate_history_event({**event, 'hash': stored}, prior[1] if prior else None, steering_ledgers.setdefault(event['mission_id'], {}))
            latest[event["mission_id"]] = (event["revision"], document)
            previous = stored
        rows = self._db.execute("SELECT * FROM work_missions").fetchall()
        if {row["id"] for row in rows} != set(latest):
            raise ValueError("Work mission/event coverage mismatch")
        for row in rows:
            if latest[row["id"]] != (row["revision"], json.loads(row["document"])) or row["request_id"] != latest[row["id"]][1]["request_id"]:
                raise ValueError("Work mission state mismatch")
        return {"work_missions": len(rows), "work_events": count, "work_head_hash": previous}
