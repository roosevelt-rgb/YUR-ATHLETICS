"""Durable recurring Work intent, persisted only by the existing CommitService.

This module has no timer, worker loop, process, provider, or filesystem reader.
The desktop dispatches claimed requests through its existing OrchestrationManager.
Claims retain one request identity until actual terminal Work is reconciled.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import uuid

from .repository_context import SECRET_CONTENT

SCHEDULE_AUTHORITY = {"issuer": "local-user", "scope": "work-schedules", "actions": ["commit"]}
MAX_SCHEDULES = 100
MAX_DOCUMENT_BYTES = 48 * 1024
MAX_HISTORY = 512
MAX_LIST_BYTES = 3 * 1024 * 1024
MAX_HISTORY_PAGE_BYTES = 1024 * 1024
ZERO = "0" * 64
_MID = re.compile(r"^[0-9a-f]{32}$")
_FIELDS = {"id", "conversation_id", "name", "goal", "root", "provider", "model", "mode", "interval_seconds", "max_runs",
           "enabled", "created_at", "updated_at", "next_run_at", "runs_completed", "active_request_id", "last_mission_id", "last_error"}
_RUNTIME = {"runs_completed", "active_request_id", "last_mission_id", "last_error"}
_TERMINAL = {"completed", "failed", "cancelled"}


class ScheduleConflictError(ValueError):
    """The schedule changed after the caller read it."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_encoded(value).encode("utf-8")).hexdigest()


def _uuid(value):
    if not isinstance(value, str):
        raise ValueError("Schedule identifiers must be canonical UUID strings")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError("Noncanonical UUID")
    except (ValueError, AttributeError) as exc:
        raise ValueError("Schedule identifiers must be canonical UUID strings") from exc


def _time(value):
    if not isinstance(value, str) or len(value) > 64 or "T" not in value:
        raise ValueError("Schedule timestamps must be timezone-aware ISO strings")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Timezone missing")
        return parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise ValueError("Schedule timestamps must be timezone-aware ISO strings") from exc


def _clock(value=None):
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("Schedule clock requires a timezone")
        return value.astimezone(timezone.utc)
    return _time(value)


def _text(value, field, maximum, nonempty=False):
    if (not isinstance(value, str) or len(value) > maximum or "\0" in value
            or (nonempty and not value.strip())):
        raise ValueError(f"Invalid bounded schedule {field}")


def validate_schedule(document):
    if not isinstance(document, dict) or set(document) != _FIELDS:
        raise ValueError("Schedule document contains missing or unsupported fields")
    for key in ("id", "conversation_id"):
        _uuid(document[key])
    for key, maximum, nonempty in (("name", 160, True), ("goal", 32000, True), ("model", 256, True), ("last_error", 2000, False)):
        _text(document[key], key, maximum, nonempty)
    if document["root"] is not None:
        # A selected path is configuration. OM models existence, reparse points,
        # filesystem authority and source boundaries freshly at every dispatch.
        _text(document["root"], "root", 4096, True)
    if document["provider"] != "ollama" or document["mode"] not in {"work", "code"}:
        raise ValueError("Recurring Work requires an admitted provider and work/code mode")
    for key, minimum, maximum in (("interval_seconds", 60, 86400), ("max_runs", 1, 100), ("runs_completed", 0, 100)):
        if type(document[key]) is not int or not minimum <= document[key] <= maximum:
            raise ValueError(f"Schedule {key} is outside its bounds")
    if type(document["enabled"]) is not bool or document["runs_completed"] > document["max_runs"]:
        raise ValueError("Invalid schedule enable state or run budget")
    if document["enabled"] and document["runs_completed"] >= document["max_runs"]:
        raise ValueError("A schedule with an exhausted run budget cannot be enabled")
    created, updated, due = (_time(document[key]) for key in ("created_at", "updated_at", "next_run_at"))
    if updated < created or due < created:
        raise ValueError("Schedule clocks cannot precede creation")
    if document["active_request_id"] is not None:
        _uuid(document["active_request_id"])
        if document["runs_completed"] >= document["max_runs"]:
            raise ValueError("An exhausted schedule cannot hold an active request")
    if document["last_mission_id"] is not None and (not isinstance(document["last_mission_id"], str) or not _MID.fullmatch(document["last_mission_id"])):
        raise ValueError("Schedule last mission must be an exact Work identifier")
    if document["runs_completed"] == 0 and document["last_mission_id"] is not None:
        raise ValueError("An uncompleted schedule cannot claim a last mission")
    if document["runs_completed"] > 0 and document["last_mission_id"] is None:
        raise ValueError("Completed runs require a real Work mission link")
    try:
        encoded = _encoded(document)
        if len(encoded.encode("utf-8")) > MAX_DOCUMENT_BYTES:
            raise ValueError("Schedule exceeds its 48 KiB document budget")
        if SECRET_CONTENT.search(encoded):
            raise ValueError("Schedule must not contain credentials")
        return json.loads(encoded)
    except (TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError("Schedule requires bounded UTF-8 JSON") from exc


def _request(document):
    return {"request_id": document["active_request_id"], "conversation_id": document["conversation_id"],
            "mode": document["mode"], "goal": document["goal"], "root": document["root"],
            "provider": document["provider"], "model": document["model"],
            "messages": [{"role": "user", "content": document["goal"]}]}


def _initial(document):
    if any(document[key] != expected for key, expected in
           (("runs_completed", 0), ("active_request_id", None), ("last_mission_id", None), ("last_error", ""))):
        raise ValueError("New schedules cannot supply runtime counters or mission identities")


def _saved(old, new):
    if any(old[key] != new[key] for key in ("id", "conversation_id", "created_at")):
        raise ValueError("Schedule identity and creation time are immutable")
    if _time(new["updated_at"]) < _time(old["updated_at"]):
        raise ValueError("Schedule update time cannot move backwards")
    if any(old[key] != new[key] for key in _RUNTIME):
        raise ValueError("Schedule runtime fields cannot be edited")
    if old["active_request_id"] is not None:
        if new["enabled"] or any(old[key] != new[key] for key in _FIELDS - {"enabled", "updated_at"}):
            raise ValueError("An active schedule can only be disabled until its run is reconciled")


def _error(value):
    return SECRET_CONTENT.sub("[redacted]", str(value))[:2000].replace("\0", "")


class ScheduleCommitMixin:
    """Schedule records share CommitService transactions and independent provenance."""

    def _initialize_schedule_schema(self):
        self._db.execute("""CREATE TABLE work_schedules (
            id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0))""")
        self._db.execute("""CREATE TABLE work_schedule_events (
            id INTEGER PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES work_schedules(id),
            revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
            state_digest TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
            UNIQUE(schedule_id, revision))""")
        self._db.execute("CREATE INDEX work_schedule_history ON work_schedule_events(schedule_id, id)")

    def _schedule_append(self, document, revision, event_type, change):
        count = self._db.execute("SELECT COUNT(*) FROM work_schedule_events WHERE schedule_id=?", (document["id"],)).fetchone()[0]
        if count >= MAX_HISTORY:
            raise ValueError("Schedule history reached its 512-event budget")
        last = self._db.execute("SELECT id,hash FROM work_schedule_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {"id": last["id"] + 1 if last else 1, "schedule_id": document["id"], "revision": revision,
                 "event_type": event_type, "data": {"document": document, "change": change},
                 "created_at": document["updated_at"], "state_digest": _digest(document),
                 "previous_hash": last["hash"] if last else ZERO}
        event["hash"] = _digest(event)
        self._db.execute("INSERT INTO work_schedule_events VALUES (?,?,?,?,?,?,?,?,?)",
                         (event["id"], event["schedule_id"], revision, event_type, _encoded(event["data"]), event["created_at"],
                          event["state_digest"], event["previous_hash"], event["hash"]))
        return event

    def _schedule_write(self, document, revision, event_type, change):
        checked = validate_schedule(document)
        next_revision = revision + 1
        if revision == 0:
            self._db.execute("INSERT INTO work_schedules VALUES (?,?,?)", (checked["id"], _encoded(checked), next_revision))
        else:
            changed = self._db.execute("UPDATE work_schedules SET document=?, revision=? WHERE id=? AND revision=?",
                                       (_encoded(checked), next_revision, checked["id"], revision))
            if changed.rowcount != 1:
                raise ScheduleConflictError("Schedule changed; reload its current revision")
        self._schedule_append(checked, next_revision, event_type, change)
        return {**checked, "revision": next_revision}

    def get_schedule(self, schedule_id):
        _uuid(schedule_id)
        with self._read_transaction():
            row = self._db.execute("SELECT * FROM work_schedules WHERE id=?", (schedule_id,)).fetchone()
            if row is None:
                raise ValueError("Schedule not found")
            return {**json.loads(row["document"]), "revision": row["revision"]}

    def list_schedules(self):
        with self._read_transaction():
            documents = [{**json.loads(row["document"]), "revision": row["revision"]}
                         for row in self._db.execute("SELECT * FROM work_schedules ORDER BY rowid")]
            if len(_encoded(documents).encode("utf-8")) > MAX_LIST_BYTES:
                raise ValueError("Schedule list exceeds its 3 MiB retrieval budget")
            return documents

    def save_schedule(self, document, expected_revision, authority):
        if authority != SCHEDULE_AUTHORITY:
            raise ValueError("Schedule changes require explicit local-user work-schedules authority")
        checked = validate_schedule(document)
        if type(expected_revision) is not int or not 0 <= expected_revision < 2**63 - 1:
            raise ValueError("Expected schedule revision must be a nonnegative integer")
        with self._transaction():
            row = self._db.execute("SELECT * FROM work_schedules WHERE id=?", (checked["id"],)).fetchone()
            actual = row["revision"] if row else 0
            if actual != expected_revision:
                raise ScheduleConflictError("Schedule changed; reload its current revision")
            if row:
                _saved(json.loads(row["document"]), checked)
            else:
                _initial(checked)
                if self._db.execute("SELECT COUNT(*) FROM work_schedules").fetchone()[0] >= MAX_SCHEDULES:
                    raise ValueError("Schedules are limited to 100 documents")
            count = self._db.execute("SELECT COUNT(*) FROM work_schedule_events WHERE schedule_id=?", (checked["id"],)).fetchone()[0]
            reserved = 2 * (checked["max_runs"] - checked["runs_completed"]) - int(checked["active_request_id"] is not None)
            if count + 1 + reserved > MAX_HISTORY:
                raise ValueError("Schedule edit would exhaust history reserved for remaining runs")
            proposed = [item for item in self.list_schedules() if item["id"] != checked["id"]]
            proposed.append({**checked, "revision": expected_revision + 1})
            # Reserve space for identifiers and an eventual error per document;
            # later claim/completion must remain readable without dropping rows.
            if len(_encoded(proposed).encode("utf-8")) + MAX_SCHEDULES * 8192 > MAX_LIST_BYTES:
                raise ValueError("Schedule configuration exceeds its 3 MiB retrieval budget including runtime reserve")
            return self._schedule_write(checked, expected_revision, "schedule.saved" if row else "schedule.created",
                                        {"authority": SCHEDULE_AUTHORITY})

    def claim_due_schedules(self, now=None, limit=1):
        instant = _clock(now)
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("Claim limit must be 1..20")
        with self._transaction():
            schedules = self.list_schedules()
            eligible = [item for item in schedules if item["active_request_id"] is not None or
                        (item["enabled"] and item["runs_completed"] < item["max_runs"]
                         and _time(item["next_run_at"]) <= instant and _time(item["updated_at"]) <= instant)]
            eligible.sort(key=lambda item: (item["active_request_id"] is None, _time(item["next_run_at"]), item["id"]))
            claims = []
            for item in eligible[:limit]:
                replayed = item["active_request_id"] is not None
                if not replayed:
                    document = {key: value for key, value in item.items() if key != "revision"}
                    document.update(active_request_id=str(uuid.uuid4()), updated_at=instant.isoformat())
                    item = self._schedule_write(document, item["revision"], "schedule.claimed",
                                                {"request": _request(document), "reason": "Enabled schedule reached its committed next run time",
                                                 "authority_source": "local-user schedule configuration"})
                claims.append({"schedule": item, "request": _request(item), "replayed": replayed})
            return claims

    def complete_schedule(self, schedule_id, mission_id, now=None):
        if not isinstance(mission_id, str) or not _MID.fullmatch(mission_id):
            raise ValueError("Schedule completion requires a real Work mission identifier")
        instant = _clock(now)
        with self._transaction():
            current = self.get_schedule(schedule_id)
            mission = self.get_work(mission_id)
            # Repeating completion is read-only, including after later runs.
            prior = self._db.execute("SELECT data FROM work_schedule_events WHERE schedule_id=? AND event_type='schedule.completed' ORDER BY id",
                                     (schedule_id,)).fetchall()
            previous = next((json.loads(row["data"])["change"] for row in prior
                             if json.loads(row["data"])["change"]["mission_id"] == mission_id), None)
            if previous is not None:
                return {"schedule": current, "mission_status": previous["mission_status"], "replayed": True}
            if mission["status"] not in _TERMINAL:
                raise ValueError("Only actual terminal Work can complete a schedule run")
            if (current["active_request_id"] is None or mission["request_id"] != current["active_request_id"]
                    or mission["conversation_id"] != current["conversation_id"] or mission["request"] != _request(current)):
                raise ValueError("Work mission does not match this schedule's active derived request")
            stamp = max(instant, _time(current["updated_at"]), _time(mission["updated_at"]))
            document = {key: value for key, value in current.items() if key != "revision"}
            completed = current["runs_completed"] + 1
            document.update(runs_completed=completed, active_request_id=None, last_mission_id=mission_id,
                            last_error="" if mission["status"] == "completed" else _error(mission["error"] or f"Work {mission['status']}"),
                            enabled=current["enabled"] and completed < current["max_runs"] and mission["status"] != "cancelled",
                            updated_at=stamp.isoformat(), next_run_at=(stamp + timedelta(seconds=current["interval_seconds"])).isoformat())
            result = self._schedule_write(document, current["revision"], "schedule.completed",
                                          {"request_id": mission["request_id"], "mission_id": mission_id, "mission_status": mission["status"],
                                           "work_revision": mission["revision"], "work_receipt": self.work_events(mission_id)[-1]["hash"]})
            return {"schedule": result, "mission_status": mission["status"], "replayed": False}

    def record_schedule_dispatch_error(self, schedule_id, request_id, error, now=None):
        """Record pre-OM failure honestly: no completed run or fabricated mission."""
        _uuid(request_id)
        message = _error(error)
        if not message.strip():
            raise ValueError("Dispatch failure requires an error description")
        instant = _clock(now)
        with self._transaction():
            current = self.get_schedule(schedule_id)
            if current["active_request_id"] != request_id:
                raise ScheduleConflictError("Schedule active request changed")
            if self.get_work_by_request(request_id) is not None:
                raise ValueError("Work already exists; reconcile its actual terminal state")
            document = {key: value for key, value in current.items() if key != "revision"}
            document.update(enabled=False, active_request_id=None, last_error=message,
                            updated_at=max(instant, _time(current["updated_at"])).isoformat())
            return self._schedule_write(document, current["revision"], "schedule.dispatch_failed",
                                        {"request_id": request_id, "reason": "No Work mission was created", "error": message})

    def schedule_events(self, schedule_id, limit=100, before_id=None):
        _uuid(schedule_id)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Schedule history pages contain 1..100 events")
        if before_id is not None and (type(before_id) is not int or before_id < 1):
            raise ValueError("Schedule history cursor must be a positive event identifier")
        with self._read_transaction():
            rows = self._db.execute("SELECT * FROM work_schedule_events WHERE schedule_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?",
                                    (schedule_id, before_id, before_id, limit + 1)).fetchall()
            events, size = [], 0
            for row in rows[:limit]:
                event = {**dict(row), "data": json.loads(row["data"])}
                length = len(_encoded(event).encode("utf-8"))
                if size + length > MAX_HISTORY_PAGE_BYTES:
                    if not events:
                        raise ValueError("Schedule event exceeds its 1 MiB history page budget")
                    break
                events.append(event)
                size += length
            return {"events": events, "next_before_id": events[-1]["id"] if len(rows) > len(events) else None}

    def _verify_schedules(self):
        latest, counts, previous, total = {}, {}, ZERO, 0
        for row in self._db.execute("SELECT * FROM work_schedule_events ORDER BY id"):
            event = dict(row)
            event["data"] = json.loads(event["data"])
            stored_hash = event.pop("hash")
            document = validate_schedule(event["data"]["document"])
            change = event["data"]["change"]
            total += 1
            old = latest.get(event["schedule_id"])
            if (event["id"] != total or event["previous_hash"] != previous or _digest(event) != stored_hash
                    or document["id"] != event["schedule_id"] or _digest(document) != event["state_digest"]
                    or event["revision"] != (old[0] + 1 if old else 1) or event["created_at"] != document["updated_at"]):
                raise ValueError("Schedule event chain or revision mismatch")
            if old is None:
                if event["event_type"] != "schedule.created" or change != {"authority": SCHEDULE_AUTHORITY}:
                    raise ValueError("Schedule must begin with authorized configuration")
                _initial(document)
            else:
                self._verify_schedule_transition(old[1], document, event["event_type"], change)
            counts[document["id"]] = counts.get(document["id"], 0) + 1
            if counts[document["id"]] > MAX_HISTORY:
                raise ValueError("Schedule exceeded bounded history")
            latest[document["id"]] = (event["revision"], document)
            previous = stored_hash
        rows = self._db.execute("SELECT * FROM work_schedules").fetchall()
        if len(rows) > MAX_SCHEDULES or {row["id"] for row in rows} != set(latest):
            raise ValueError("Schedule event coverage or document budget mismatch")
        for row in rows:
            if latest[row["id"]] != (row["revision"], json.loads(row["document"])):
                raise ValueError("Schedule document differs from committed history")
        if len(_encoded([{**json.loads(row["document"]), "revision": row["revision"]} for row in rows]).encode("utf-8")) > MAX_LIST_BYTES:
            raise ValueError("Schedule aggregate retrieval budget exceeded")
        return {"schedules": len(rows), "schedule_events": total, "schedule_head_hash": previous}

    def _verify_schedule_transition(self, old, new, kind, change):
        if any(old[key] != new[key] for key in ("id", "conversation_id", "created_at")) or _time(new["updated_at"]) < _time(old["updated_at"]):
            raise ValueError("Schedule identity or clock changed")
        if kind == "schedule.saved":
            if change != {"authority": SCHEDULE_AUTHORITY}:
                raise ValueError("Schedule edit authority mismatch")
            _saved(old, new)
            return
        allowed = {"active_request_id", "updated_at"}
        if kind == "schedule.claimed":
            if (not old["enabled"] or old["active_request_id"] is not None or new["active_request_id"] is None
                    or old["runs_completed"] >= old["max_runs"] or _time(new["updated_at"]) < _time(old["next_run_at"])
                    or change.get("request") != _request(new)):
                raise ValueError("Invalid schedule claim or derived context")
        elif kind == "schedule.completed":
            allowed |= {"runs_completed", "last_mission_id", "last_error", "enabled", "next_run_at"}
            if (old["active_request_id"] is None or new["active_request_id"] is not None
                    or change.get("request_id") != old["active_request_id"] or new["runs_completed"] != old["runs_completed"] + 1
                    or change.get("mission_id") != new["last_mission_id"] or change.get("mission_status") not in _TERMINAL
                    or _time(new["next_run_at"]) != _time(new["updated_at"]) + timedelta(seconds=old["interval_seconds"])):
                raise ValueError("Invalid schedule completion")
            work = self.get_work(change["mission_id"])
            # Bind the actual terminal revision: a failed Work request can later
            # be resumed independently without rewriting this observed outcome.
            events = self.work_events(work["id"])
            proof = next((item for item in events if item["revision"] == change.get("work_revision")), None)
            observed = proof["data"]["document"] if proof else {}
            status = observed.get("status")
            expected_enabled = old["enabled"] and new["runs_completed"] < old["max_runs"] and status != "cancelled"
            expected_error = "" if status == "completed" else _error(observed.get("error") or f"Work {status}")
            if (work["request"] != _request(old) or status != change["mission_status"] or proof is None
                    or proof["hash"] != change.get("work_receipt")
                    or new["enabled"] != expected_enabled or new["last_error"] != expected_error):
                raise ValueError("Schedule completion does not match actual terminal Work")
        elif kind == "schedule.dispatch_failed":
            allowed |= {"enabled", "last_error"}
            if (old["active_request_id"] is None or change.get("request_id") != old["active_request_id"]
                    or new["active_request_id"] is not None or new["enabled"] or not new["last_error"]
                    or change.get("error") != new["last_error"]):
                raise ValueError("Invalid schedule dispatch failure")
        else:
            raise ValueError("Unknown schedule event type")
        if any(old[key] != new[key] for key in _FIELDS - allowed):
            raise ValueError("Runtime schedule event changed configuration")
