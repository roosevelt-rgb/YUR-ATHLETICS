"""Read-only desktop views of the existing CommitService concept projection.

No concept authority, lifecycle loop, or persistence is owned by this ingress.
History contains compact decisions and receipts, never repeated documents.
"""
from __future__ import annotations

import json
import uuid

MAX_RECENT_EVENTS = 20
MAX_RESPONSE_BYTES = 256 * 1024
FIELDS = {"concept_list": {"command", "limit", "cursor"},
          "concept_inspect": {"command", "concept_id"}}
_DECISION = ("allowed", "from_stage", "to_stage", "missing", "errors", "requirements")


def _uuid(value):
    if not isinstance(value, str):
        raise ValueError("Concept identifiers must be canonical UUIDs")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError("Noncanonical UUID")
    except ValueError as exc:
        raise ValueError("Concept identifiers must be canonical UUIDs") from exc


def validate(request):
    if (not isinstance(request, dict) or not isinstance(request.get("command"), str)
            or request["command"] not in FIELDS or set(request) != FIELDS[request["command"]]):
        raise ValueError("Concept discovery accepts exact read-only commands only")
    if request["command"] == "concept_list":
        if type(request["limit"]) is not int or not 1 <= request["limit"] <= 20:
            raise ValueError("Concept list limit must be 1..20")
        if request["cursor"] is not None:
            _uuid(request["cursor"])
    else:
        _uuid(request["concept_id"])
    return request


def handle(store, request):
    """Accept an existing store, or None for an unused desktop state root."""
    validate(request)
    if store is None:
        if request["command"] == "concept_list" and request["cursor"] is None:
            return {"concepts": [], "next_cursor": None, "total": 0}
        raise ValueError("Concept cursor not found" if request["command"] == "concept_list" else "Concept not found")
    # Nested store reads share this verified SQLite snapshot. A concurrent Work
    # transition cannot pair a new receipt tail with an older concept document.
    with store._read_transaction():
        if request["command"] == "concept_list":
            result = store.list_concepts(request["limit"], request["cursor"])
        else:
            concept = store.get_concept(request["concept_id"])
            omitted = max(0, concept["revision"] - MAX_RECENT_EVENTS)
            page = store.concept_events(concept["id"], after_revision=omitted, limit=MAX_RECENT_EVENTS)
            events = [{**event, "decision": None if event["decision"] is None else
                       {key: event["decision"][key] for key in _DECISION}} for event in page["events"]]
            if (not events or page["next_revision"] is not None
                    or events[-1]["revision"] != concept["revision"]
                    or events[-1]["hash"] != concept["history_hash"]):
                raise ValueError("Concept receipt history does not match its snapshot")
            result = {"concept": concept, "events": events,
                      "history": {"from_revision": omitted + 1, "through_revision": concept["revision"],
                                  "omitted_before": omitted}}
    if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise ValueError("Concept view exceeds its 256 KiB response budget")
    return result
