"""Durable operator corrections under the existing Work commit authority.

Corrections are event data until a worker checkpoint appends them to context.
No model, provider, filesystem, background worker or independent state store.
"""
from copy import deepcopy
import hashlib
import re
import uuid

from .repository_context import SECRET_CONTENT
from .work_store import digest, now, valid_document

QUEUED = "work.steering.queued"
CONSUMED = "work.steering.consumed"
MAX_CORRECTIONS = 8
MAX_TEXT_CHARS = 8000
MAX_TOTAL_BYTES = 32 * 1024
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]")


def _uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Steering identifiers must be canonical UUIDs")


def _mission_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ValueError("Steering requires the exact Work mission identifier")


def _text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT_CHARS or _CONTROL.search(value):
        raise ValueError("A correction requires 1..8000 characters of plain text")
    if SECRET_CONTENT.search(value):
        raise ValueError("Potential secret content is not admitted in a correction")
    return value.encode("utf-8")


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _document(mission):
    return {key: deepcopy(value) for key, value in mission.items() if key not in {"revision", "receipt"}}


def _receipt(event):
    return {"hash": event["hash"], "revision": event["revision"]}


def _only_changes(previous, current, allowed):
    return previous is not None and all(previous[key] == current[key] for key in previous if key not in allowed)


def validate_history_event(event, previous, ledger):
    """Validate steering semantics in addition to the existing event hash chain.

    Called both before commit and during integrity verification. ledger is local
    to the verification pass, never authoritative persisted state.
    """
    kind, document = event["event_type"], event["data"]["document"]
    change = event["data"]["change"]
    if kind == QUEUED:
        expected = {"issuer", "conversation_id", "correction_id", "text", "text_sha256"}
        if not isinstance(change, dict) or set(change) != expected or change["issuer"] != "local-user":
            raise ValueError("Invalid queued correction provenance")
        _uuid(change["correction_id"])
        _uuid(change["conversation_id"])
        raw = _text(change["text"])
        if (previous is None or previous["status"] not in {"queued", "running"}
                or not _only_changes(previous, document, {"updated_at"})
                or change["conversation_id"] != document["conversation_id"]
                or change["text_sha256"] != _sha(change["text"]) or change["correction_id"] in ledger):
            raise ValueError("Queued correction changed mission state or duplicated its identity")
        if len(ledger) >= MAX_CORRECTIONS or sum(len(value["text"].encode("utf-8")) for value in ledger.values()) + len(raw) > MAX_TOTAL_BYTES:
            raise ValueError("Corrections exceed the eight-item or 32 KiB total budget")
        ledger[change["correction_id"]] = {"correction_id": change["correction_id"], "text": change["text"],
            "status": "queued", "queued_receipt": _receipt(event), "consumed_receipt": None}
    elif kind == CONSUMED:
        expected = {"issuer", "correction_ids", "corrections_sha256", "message_start", "message_count"}
        pending = [item for item in ledger.values() if item["status"] == "queued"]
        identifiers = [item["correction_id"] for item in pending]
        identity = [{"correction_id": item["correction_id"], "text_sha256": _sha(item["text"])} for item in pending]
        if (not isinstance(change, dict) or set(change) != expected or change["issuer"] != "work-checkpoint"
                or previous is None or previous["status"] != "running" or not identifiers
                or change["correction_ids"] != identifiers or change["corrections_sha256"] != digest(identity)
                or type(change["message_start"]) is not int or change["message_start"] != len(previous["messages"])
                or type(change["message_count"]) is not int or change["message_count"] != len(identifiers)
                or not _only_changes(previous, document, {"updated_at", "messages"})
                or document["messages"] != [*previous["messages"], *({"role": "user", "content": item["text"]} for item in pending)]
                or len(document["messages"]) > 118):
            raise ValueError("Consumed correction provenance or context differs from its queue")
        for identifier in identifiers:
            ledger[identifier] = {**ledger[identifier], "status": "consumed", "consumed_receipt": _receipt(event)}
    elif kind.startswith("work.steering."):
        raise ValueError("Unknown steering event type")
    elif document["status"] == "completed" and any(item["status"] == "queued" for item in ledger.values()):
        raise ValueError("Pending corrections must be consumed before completing Work")
    pending = [item for item in ledger.values() if item["status"] == "queued"]
    if pending and document["status"] in {"queued", "running"}:
        _context_budget(document, pending)


def ledger_from_events(events):
    ledger, previous = {}, None
    for event in events:
        validate_history_event(event, previous, ledger)
        previous = event["data"]["document"]
    return ledger


def _projection(mission, ledger):
    return [{**deepcopy(item), "status": "not_consumed" if item["status"] == "queued" and mission["status"] in {"completed", "failed", "cancelled"} else item["status"]}
            for item in ledger.values()]


def _context_budget(document, pending):
    projected = _document(document)
    projected["messages"].extend({"role": "user", "content": item["text"]} for item in pending)
    if len(projected["messages"]) > 118:
        raise ValueError("Corrections must leave two context slots for a tool response")
    valid_document(projected)


def _locked(store):
    if getattr(store, "_lock_file", None) is None:
        raise RuntimeError("Consuming corrections and worker checkpoints require the existing worker lock")


def _state(store, mission):
    return ledger_from_events(store.work_events(mission["id"]))


def state(store, mission_id):
    _mission_id(mission_id)
    with store._read_transaction():
        mission = store.get_work(mission_id)
        return _projection(mission, _state(store, mission))


def queue(store, mission_id, conversation_id, correction_id, text):
    _mission_id(mission_id)
    _uuid(conversation_id)
    _uuid(correction_id)
    _text(text)
    with store._transaction():
        mission = store.get_work(mission_id)
        if mission["conversation_id"] != conversation_id:
            raise ValueError("Correction conversation does not match this Work mission")
        ledger = _state(store, mission)
        if correction_id in ledger:
            if ledger[correction_id]["text"] != text:
                raise ValueError("Correction identifier already belongs to different text")
        else:
            if mission["status"] not in {"queued", "running"}:
                raise ValueError("Only queued or running Work accepts a new correction")
            pending = [item for item in ledger.values() if item["status"] == "queued"]
            _context_budget(mission, [*pending, {"text": text}])
            document = _document(mission)
            document["updated_at"] = now()
            mission = store._commit_work_locked(document, mission["revision"], QUEUED,
                {"issuer": "local-user", "conversation_id": conversation_id, "correction_id": correction_id, "text": text, "text_sha256": _sha(text)})
            ledger = _state(store, mission)
        correction = next(item for item in _projection(mission, ledger) if item["correction_id"] == correction_id)
        return {"mission_id": mission_id, "conversation_id": conversation_id, "request_id": mission["request_id"],
                "correction": correction, "revision": mission["revision"]}


def consume(store, mission_id):
    _locked(store)
    _mission_id(mission_id)
    with store._transaction():
        mission = store.get_work(mission_id)
        if mission["status"] != "running":
            raise ValueError("Corrections can only be consumed by running Work")
        ledger = _state(store, mission)
        pending = [item for item in ledger.values() if item["status"] == "queued"]
        if not pending:
            return {"mission": mission, "corrections": []}
        _context_budget(mission, pending)
        document = _document(mission)
        document["messages"].extend({"role": "user", "content": item["text"]} for item in pending)
        document["updated_at"] = now()
        identity = [{"correction_id": item["correction_id"], "text_sha256": _sha(item["text"])} for item in pending]
        mission = store._commit_work_locked(document, mission["revision"], CONSUMED,
            {"issuer": "work-checkpoint", "correction_ids": [item["correction_id"] for item in pending],
             "corrections_sha256": digest(identity), "message_start": len(mission["messages"]), "message_count": len(pending)})
        consumed = _state(store, mission)
        return {"mission": mission, "corrections": [deepcopy(consumed[item["correction_id"]]) for item in pending]}


def _current_for_revision(store, mission_id, expected_revision):
    if type(expected_revision) is not int or expected_revision < 1:
        raise ValueError("Expected Work revision must be a positive integer")
    current = store.get_work(mission_id)
    if current["revision"] == expected_revision:
        return current
    events = store.work_events(mission_id)
    base = next((event["data"]["document"] for event in events if event["revision"] == expected_revision), None)
    intervening = [event for event in events if event["revision"] > expected_revision]
    if (base is None or not 1 <= len(intervening) <= MAX_CORRECTIONS
            or any(event["event_type"] != QUEUED for event in intervening)
            or not _only_changes(base, _document(current), {"updated_at"})):
        raise ValueError("Work changed beyond queued corrections; reload its current revision")
    return current


def checkpoint(store, document, expected_revision, event_type, change=None):
    _locked(store)
    checked = valid_document(document)
    if not isinstance(event_type, str):
        raise ValueError("Worker checkpoint requires a typed event name")
    if event_type.startswith("work.steering."):
        raise ValueError("Steering events must use their dedicated queue or consume operation")
    with store._transaction():
        current = _current_for_revision(store, checked["id"], expected_revision)
        if current["status"] in {"completed", "cancelled", "awaiting_approval"}:
            raise ValueError("A worker checkpoint cannot change concluded or paused Work")
        if checked["status"] in {"queued", "running"}:
            pending = [item for item in _state(store, current).values() if item["status"] == "queued"]
            if pending:
                _context_budget(checked, pending)
        checked["updated_at"] = now()
        return store._commit_work_locked(checked, current["revision"], event_type, change)


def complete(store, mission_id, expected_revision, answer):
    _locked(store)
    _mission_id(mission_id)
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 100000:
        raise ValueError("Completing Work requires a bounded nonempty answer")
    with store._transaction():
        current = _current_for_revision(store, mission_id, expected_revision)
        if current["status"] != "running":
            raise ValueError("Only running Work can complete at a correction checkpoint")
        if any(item["status"] == "queued" for item in _state(store, current).values()):
            return {"mission": current, "interrupted": True}
        document = _document(current)
        document.update(status="completed", answer=answer, updated_at=now())
        mission = store._commit_work_locked(document, current["revision"], "work.completed",
            {"tool_steps": len(document["steps"]), "artifact_count": len(document["artifacts"])})
        return {"mission": mission, "interrupted": False}
