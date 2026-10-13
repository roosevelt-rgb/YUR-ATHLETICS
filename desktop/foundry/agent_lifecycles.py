"""Deployed agent lifecycles, persisted only by the existing CommitService.

A deployment binds one agent (a Work goal, a saved Foundry specialist, or a pack
forged by the IntelliFlow harness / marketplace) to a trigger (manual, once,
interval, cron or continuous) and a lifecycle state:

    active ──pause──▶ paused ──resume──▶ active
      │                                    │
      └─(budget used / once done)─▶ finished    any ──retire──▶ retired (terminal)

Like work_schedules, this module has no timer, process, provider or filesystem
reader. A host dispatcher (Desktop main process or the headless lifecycle runner)
claims due runs and executes them through the existing OrchestrationManager.
Every transition is a hash-chained event re-verified on each transaction.
Failure streaks auto-pause a deployment (restart policy) instead of looping.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
import uuid

from .lifecycle_triggers import first_run, following_run, parse_instant, validate_trigger
from .repository_context import SECRET_CONTENT

LIFECYCLE_AUTHORITY = {"issuer": "local-user", "scope": "agent-lifecycles", "actions": ["commit"]}
MAX_DEPLOYMENTS = 50
MAX_RUNS = 500
MAX_DOCUMENT_BYTES = 64 * 1024
MAX_LIST_BYTES = 4 * 1024 * 1024
MAX_HISTORY_PAGE_BYTES = 1024 * 1024
HISTORY_SLACK = 64
ZERO = "0" * 64
STATES = ("active", "paused", "finished", "retired")
KINDS = ("work_goal", "saved_specialist", "marketplace_pack")
_MID = re.compile(r"^[0-9a-f]{32}$")
_PACK_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_FIELDS = {"id", "name", "kind", "source", "conversation_id", "instructions", "goal", "root", "provider", "model", "mode",
           "trigger", "state", "max_runs", "max_failures_in_row", "runs_completed", "failures_in_row", "next_run_at",
           "active_request_id", "last_mission_id", "last_status", "last_error", "previous_deployment_id",
           "created_at", "updated_at"}
_RUNTIME = {"runs_completed", "failures_in_row", "active_request_id", "last_mission_id", "last_status", "last_error"}
_CONFIG = {"name", "instructions", "goal", "root", "model", "mode", "trigger", "max_runs", "max_failures_in_row"}
_TERMINAL = {"completed", "failed", "cancelled"}


class LifecycleConflictError(ValueError):
    """The deployment changed after the caller read it."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_encoded(value).encode("utf-8")).hexdigest()


def _uuid(value, label="Lifecycle identifiers"):
    if not isinstance(value, str):
        raise ValueError(f"{label} must be canonical UUID strings")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError("Noncanonical UUID")
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{label} must be canonical UUID strings") from exc


def _time(value):
    return parse_instant(value)


def _clock(value=None):
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("Lifecycle clock requires a timezone")
        return value.astimezone(timezone.utc)
    return _time(value)


def _text(value, field, maximum, nonempty=False):
    if (not isinstance(value, str) or len(value) > maximum or "\0" in value
            or (nonempty and not value.strip())):
        raise ValueError(f"Invalid bounded deployment {field}")


def _error(value):
    return SECRET_CONTENT.sub("[redacted]", str(value))[:2000].replace("\0", "")


def _validate_source(kind, source):
    if not isinstance(source, dict):
        raise ValueError("Deployment source must be an object")
    if kind == "work_goal":
        if source != {}:
            raise ValueError("A Work-goal deployment has no external source")
    elif kind == "saved_specialist":
        if set(source) != {"mission_id", "specialist_id"} or not all(
                isinstance(source[key], str) and _MID.fullmatch(source[key]) for key in source):
            raise ValueError("A specialist deployment needs its exact Foundry mission and specialist identifiers")
    elif kind == "marketplace_pack":
        allowed = {"pack_id", "entry_id", "agent_type", "provider", "agent_count", "tool_count", "engine", "content_sha256"}
        if not set(source) <= allowed or not {"pack_id", "engine"} <= set(source):
            raise ValueError("A marketplace deployment needs its pack identity and engine")
        if not isinstance(source["pack_id"], str) or not _PACK_ID.fullmatch(source["pack_id"]):
            raise ValueError("Invalid marketplace pack identifier")
        if source["engine"] != "intelliflow-harness":
            raise ValueError("Marketplace packs are admitted only from the IntelliFlow harness engine")
        if "content_sha256" in source and (not isinstance(source["content_sha256"], str)
                                           or not re.fullmatch(r"[a-f0-9]{64}", source["content_sha256"])):
            raise ValueError("Marketplace source revision must be a lowercase SHA-256 digest")
        for key in ("entry_id", "agent_type", "provider"):
            if key in source:
                _text(source[key], key, 200)
        for key in ("agent_count", "tool_count"):
            if key in source and (type(source[key]) is not int or not 0 <= source[key] <= 10000):
                raise ValueError(f"Invalid marketplace {key}")
    else:
        raise ValueError(f"Deployment kind must be one of {', '.join(KINDS)}")


def validate_deployment(document):
    if not isinstance(document, dict) or set(document) != _FIELDS:
        raise ValueError("Deployment document contains missing or unsupported fields")
    for key in ("id", "conversation_id"):
        _uuid(document[key])
    if document["previous_deployment_id"] is not None:
        _uuid(document["previous_deployment_id"])
    if document["kind"] not in KINDS:
        raise ValueError(f"Deployment kind must be one of {', '.join(KINDS)}")
    _validate_source(document["kind"], document["source"])
    for key, maximum, nonempty in (("name", 160, True), ("goal", 24000, True), ("instructions", 24000, False),
                                   ("model", 256, True), ("last_error", 2000, False)):
        _text(document[key], key, maximum, nonempty)
    if len(document["goal"]) + len(document["instructions"]) > 32000:
        raise ValueError("Deployment goal and instructions exceed the 32,000-character Work budget")
    if document["root"] is not None:
        _text(document["root"], "root", 4096, True)
    if document["provider"] != "ollama" or document["mode"] not in {"work", "code"}:
        raise ValueError("Deployed agents run through the admitted Ollama Work provider in work/code mode")
    validate_trigger(document["trigger"])
    if document["state"] not in STATES:
        raise ValueError(f"Deployment state must be one of {', '.join(STATES)}")
    for key, minimum, maximum in (("max_runs", 1, MAX_RUNS), ("max_failures_in_row", 1, 20),
                                  ("runs_completed", 0, MAX_RUNS), ("failures_in_row", 0, MAX_RUNS)):
        if type(document[key]) is not int or not minimum <= document[key] <= maximum:
            raise ValueError(f"Deployment {key} is outside its bounds")
    if document["runs_completed"] > document["max_runs"]:
        raise ValueError("Deployment run count exceeds its budget")
    if document["state"] == "active" and document["runs_completed"] >= document["max_runs"]:
        raise ValueError("A deployment with an exhausted run budget cannot be active")
    if document["last_status"] not in {"", *_TERMINAL}:
        raise ValueError("Deployment last status must be a terminal Work status")
    created, updated = _time(document["created_at"]), _time(document["updated_at"])
    if updated < created:
        raise ValueError("Deployment clocks cannot precede creation")
    if document["next_run_at"] is not None:
        if _time(document["next_run_at"]) < created:
            raise ValueError("Deployment next run cannot precede creation")
        if document["state"] != "active":
            raise ValueError("Only active deployments carry a next run")
    if document["active_request_id"] is not None:
        _uuid(document["active_request_id"])
        if document["state"] == "retired":
            raise ValueError("A retired deployment cannot hold an active request")
    if document["last_mission_id"] is not None and (not isinstance(document["last_mission_id"], str)
                                                     or not _MID.fullmatch(document["last_mission_id"])):
        raise ValueError("Deployment last mission must be an exact Work identifier")
    if (document["runs_completed"] == 0) != (document["last_mission_id"] is None) or \
            (document["runs_completed"] == 0) != (document["last_status"] == ""):
        raise ValueError("Completed runs require a real Work mission link and status")
    try:
        encoded = _encoded(document)
        if len(encoded.encode("utf-8")) > MAX_DOCUMENT_BYTES:
            raise ValueError("Deployment exceeds its 64 KiB document budget")
        if SECRET_CONTENT.search(encoded):
            raise ValueError("Deployments must not contain credentials")
        return json.loads(encoded)
    except (TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError("Deployment requires bounded UTF-8 JSON") from exc


def derived_request(document):
    """The exact Work request a deployment run submits to OrchestrationManager."""
    messages = []
    if document["instructions"].strip():
        messages.append({"role": "system", "content": document["instructions"]})
    messages.append({"role": "user", "content": document["goal"]})
    return {"request_id": document["active_request_id"], "conversation_id": document["conversation_id"],
            "mode": document["mode"], "goal": document["goal"], "root": document["root"],
            "provider": document["provider"], "model": document["model"], "messages": messages}


def _history_budget(document):
    return 2 * document["max_runs"] + HISTORY_SLACK


def _strip(document):
    return {key: value for key, value in document.items() if key != "revision"}


def new_deployment(spec, instant=None):
    """Build a validated, never-run deployment from a caller spec (server-assigned identity)."""
    if not isinstance(spec, dict):
        raise ValueError("Deployment spec must be an object")
    allowed = {"name", "kind", "source", "instructions", "goal", "root", "model", "mode", "trigger", "max_runs",
               "max_failures_in_row", "state", "previous_deployment_id"}
    if not set(spec) <= allowed or not {"name", "kind", "goal", "model", "trigger"} <= set(spec):
        raise ValueError("Deployment spec requires name, kind, goal, model and trigger and nothing unsupported")
    stamp = _clock(instant)
    state = spec.get("state", "active")
    if state not in {"active", "paused"}:
        raise ValueError("New deployments start active or paused")
    trigger = validate_trigger(spec["trigger"])
    upcoming = first_run(trigger, stamp) if state == "active" else None
    document = {
        "id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()),
        "name": spec["name"], "kind": spec["kind"], "source": spec.get("source", {}),
        "instructions": spec.get("instructions", ""), "goal": spec["goal"], "root": spec.get("root"),
        "provider": "ollama", "model": spec["model"], "mode": spec.get("mode", "work"), "trigger": trigger,
        "state": state, "max_runs": spec.get("max_runs", 100), "max_failures_in_row": spec.get("max_failures_in_row", 3),
        "runs_completed": 0, "failures_in_row": 0,
        "next_run_at": upcoming.isoformat() if upcoming else None,
        "active_request_id": None, "last_mission_id": None, "last_status": "", "last_error": "",
        "previous_deployment_id": spec.get("previous_deployment_id"),
        "created_at": stamp.isoformat(), "updated_at": stamp.isoformat(),
    }
    return validate_deployment(document)


class LifecycleCommitMixin:
    """Deployment records share CommitService transactions and independent provenance."""

    def _initialize_lifecycle_schema(self):
        # IF NOT EXISTS: a migration may meet these tables already present; the full
        # verification that ends every migration still checks any rows they hold.
        self._db.execute("""CREATE TABLE IF NOT EXISTS agent_deployments (
            id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0))""")
        self._db.execute("""CREATE TABLE IF NOT EXISTS agent_deployment_events (
            id INTEGER PRIMARY KEY, deployment_id TEXT NOT NULL REFERENCES agent_deployments(id),
            revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
            state_digest TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
            UNIQUE(deployment_id, revision))""")
        self._db.execute("CREATE INDEX IF NOT EXISTS agent_deployment_history ON agent_deployment_events(deployment_id, id)")

    # ── writes ────────────────────────────────────────────────────────────
    def _lifecycle_append(self, document, revision, event_type, change):
        count = self._db.execute("SELECT COUNT(*) FROM agent_deployment_events WHERE deployment_id=?",
                                 (document["id"],)).fetchone()[0]
        if count >= _history_budget(document):
            raise ValueError("Deployment history reached its budget; renew the deployment to continue")
        last = self._db.execute("SELECT id,hash FROM agent_deployment_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {"id": last["id"] + 1 if last else 1, "deployment_id": document["id"], "revision": revision,
                 "event_type": event_type, "data": {"document": document, "change": change},
                 "created_at": document["updated_at"], "state_digest": _digest(document),
                 "previous_hash": last["hash"] if last else ZERO}
        event["hash"] = _digest(event)
        self._db.execute("INSERT INTO agent_deployment_events VALUES (?,?,?,?,?,?,?,?,?)",
                         (event["id"], event["deployment_id"], revision, event_type, _encoded(event["data"]),
                          event["created_at"], event["state_digest"], event["previous_hash"], event["hash"]))
        return event

    def _lifecycle_write(self, document, revision, event_type, change):
        checked = validate_deployment(document)
        next_revision = revision + 1
        if revision == 0:
            self._db.execute("INSERT INTO agent_deployments VALUES (?,?,?)", (checked["id"], _encoded(checked), next_revision))
        else:
            changed = self._db.execute("UPDATE agent_deployments SET document=?, revision=? WHERE id=? AND revision=?",
                                       (_encoded(checked), next_revision, checked["id"], revision))
            if changed.rowcount != 1:
                raise LifecycleConflictError("Deployment changed; reload its current revision")
        self._lifecycle_append(checked, next_revision, event_type, change)
        return {**checked, "revision": next_revision}

    def _require_authority(self, authority):
        if authority != LIFECYCLE_AUTHORITY:
            raise ValueError("Deployment changes require explicit local-user agent-lifecycles authority")

    def _current(self, deployment_id, expected_revision=None):
        current = self.get_deployment(deployment_id)
        if expected_revision is not None and current["revision"] != expected_revision:
            raise LifecycleConflictError("Deployment changed; reload its current revision")
        return current

    # ── reads ─────────────────────────────────────────────────────────────
    def get_deployment(self, deployment_id):
        _uuid(deployment_id)
        with self._read_transaction():
            row = self._db.execute("SELECT * FROM agent_deployments WHERE id=?", (deployment_id,)).fetchone()
            if row is None:
                raise ValueError("Deployment not found")
            return {**json.loads(row["document"]), "revision": row["revision"]}

    def list_deployments(self):
        with self._read_transaction():
            documents = [{**json.loads(row["document"]), "revision": row["revision"]}
                         for row in self._db.execute("SELECT * FROM agent_deployments ORDER BY rowid")]
            if len(_encoded(documents).encode("utf-8")) > MAX_LIST_BYTES:
                raise ValueError("Deployment list exceeds its retrieval budget")
            return documents

    # ── operator actions ──────────────────────────────────────────────────
    def create_deployment(self, spec, authority, now=None):
        self._require_authority(authority)
        document = new_deployment(spec, now)
        with self._transaction():
            if self._db.execute("SELECT COUNT(*) FROM agent_deployments WHERE json_extract(document,'$.state')!='retired'"
                                ).fetchone()[0] >= MAX_DEPLOYMENTS:
                raise ValueError(f"Deployments are limited to {MAX_DEPLOYMENTS} non-retired agents")
            if document["previous_deployment_id"] is not None:
                previous = self.get_deployment(document["previous_deployment_id"])
                if previous["state"] not in {"finished", "retired"}:
                    raise ValueError("Only a finished or retired deployment can be renewed")
            return self._lifecycle_write(document, 0, "deployment.created", {"authority": LIFECYCLE_AUTHORITY})

    def update_deployment(self, deployment_id, expected_revision, changes, authority, now=None):
        self._require_authority(authority)
        if not isinstance(changes, dict) or not changes or not set(changes) <= _CONFIG:
            raise ValueError("Deployment edits may change only its configuration fields")
        instant = _clock(now)
        with self._transaction():
            current = self._current(deployment_id, expected_revision)
            if current["active_request_id"] is not None:
                raise ValueError("Pause the deployment and let its active run reconcile before editing")
            if current["state"] == "retired":
                raise ValueError("A retired deployment cannot be edited; renew it instead")
            document = _strip(current)
            document.update(changes, updated_at=max(instant, _time(current["updated_at"])).isoformat())
            if "trigger" in changes and document["state"] == "active":
                upcoming = first_run(document["trigger"], _time(document["updated_at"]))
                document["next_run_at"] = upcoming.isoformat() if upcoming else None
            if document["runs_completed"] >= document["max_runs"] and document["state"] == "active":
                document.update(state="finished", next_run_at=None)
            used = self._db.execute("SELECT COUNT(*) FROM agent_deployment_events WHERE deployment_id=?",
                                    (deployment_id,)).fetchone()[0]
            if used + 1 + 2 * (document["max_runs"] - document["runs_completed"]) > _history_budget(document):
                raise ValueError("Edit would exhaust history reserved for the remaining runs")
            return self._lifecycle_write(document, current["revision"], "deployment.saved",
                                         {"authority": LIFECYCLE_AUTHORITY, "fields": sorted(changes)})

    def set_deployment_state(self, deployment_id, expected_revision, state, authority, now=None):
        self._require_authority(authority)
        if state not in {"active", "paused", "retired"}:
            raise ValueError("Operators may activate, pause or retire a deployment")
        instant = _clock(now)
        with self._transaction():
            current = self._current(deployment_id, expected_revision)
            if current["state"] == "retired":
                raise ValueError("A retired deployment is terminal; renew it instead")
            if current["state"] == state:
                return current
            if state == "retired" and current["active_request_id"] is not None:
                raise ValueError("Pause the deployment and let its active run reconcile before retiring it")
            document = _strip(current)
            stamp = max(instant, _time(current["updated_at"]))
            document["updated_at"] = stamp.isoformat()
            if state == "active":
                if current["runs_completed"] >= current["max_runs"]:
                    raise ValueError("Raise the run budget before reactivating a finished deployment")
                upcoming = first_run(current["trigger"], stamp)
                document.update(state="active", failures_in_row=0, next_run_at=upcoming.isoformat() if upcoming else None)
            else:
                # An in-flight run keeps its exact identity until its Work reconciles.
                document.update(state=state, next_run_at=None)
            return self._lifecycle_write(document, current["revision"], f"deployment.{state}",
                                         {"authority": LIFECYCLE_AUTHORITY, "from": current["state"]})

    def request_deployment_run(self, deployment_id, expected_revision, authority, now=None):
        """Operator 'Run now': make an active deployment due immediately."""
        self._require_authority(authority)
        instant = _clock(now)
        with self._transaction():
            current = self._current(deployment_id, expected_revision)
            if current["state"] != "active":
                raise ValueError("Only an active deployment can run on request")
            if current["active_request_id"] is not None:
                raise ValueError("This deployment already has a run in flight")
            stamp = max(instant, _time(current["updated_at"]))
            document = _strip(current)
            document.update(updated_at=stamp.isoformat(), next_run_at=stamp.isoformat())
            return self._lifecycle_write(document, current["revision"], "deployment.run_requested",
                                         {"authority": LIFECYCLE_AUTHORITY})

    # ── dispatcher protocol ───────────────────────────────────────────────
    def claim_due_deployments(self, now=None, limit=1):
        instant = _clock(now)
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("Claim limit must be 1..20")
        with self._transaction():
            deployments = self.list_deployments()
            eligible = [item for item in deployments if item["active_request_id"] is not None or
                        (item["state"] == "active" and item["next_run_at"] is not None
                         and item["runs_completed"] < item["max_runs"]
                         and _time(item["next_run_at"]) <= instant and _time(item["updated_at"]) <= instant)]
            eligible.sort(key=lambda item: (item["active_request_id"] is None, item["next_run_at"] or "", item["id"]))
            claims = []
            for item in eligible[:limit]:
                replayed = item["active_request_id"] is not None
                if not replayed:
                    document = _strip(item)
                    document.update(active_request_id=str(uuid.uuid4()), updated_at=instant.isoformat())
                    item = self._lifecycle_write(document, item["revision"], "deployment.claimed",
                                                 {"request": derived_request(document),
                                                  "reason": "Active deployment reached its committed next run time",
                                                  "authority_source": "local-user deployment configuration"})
                claims.append({"deployment": item, "request": derived_request(item), "replayed": replayed})
            return claims

    def complete_deployment_run(self, deployment_id, mission_id, now=None):
        if not isinstance(mission_id, str) or not _MID.fullmatch(mission_id):
            raise ValueError("Deployment completion requires a real Work mission identifier")
        instant = _clock(now)
        with self._transaction():
            current = self.get_deployment(deployment_id)
            mission = self.get_work(mission_id)
            prior = self._db.execute(
                "SELECT data FROM agent_deployment_events WHERE deployment_id=? AND event_type='deployment.completed' ORDER BY id",
                (deployment_id,)).fetchall()
            previous = next((json.loads(row["data"])["change"] for row in prior
                             if json.loads(row["data"])["change"]["mission_id"] == mission_id), None)
            if previous is not None:
                return {"deployment": current, "mission_status": previous["mission_status"], "replayed": True}
            if mission["status"] not in _TERMINAL:
                raise ValueError("Only actual terminal Work can complete a deployment run")
            if (current["active_request_id"] is None or mission["request_id"] != current["active_request_id"]
                    or mission["conversation_id"] != current["conversation_id"] or mission["request"] != derived_request(current)):
                raise ValueError("Work mission does not match this deployment's active derived request")
            stamp = max(instant, _time(current["updated_at"]), _time(mission["updated_at"]))
            document = _strip(current)
            document.update(self._completion_fields(current, mission["status"], mission["error"], stamp, mission_id))
            result = self._lifecycle_write(document, current["revision"], "deployment.completed",
                                           {"request_id": mission["request_id"], "mission_id": mission_id,
                                            "mission_status": mission["status"], "work_revision": mission["revision"],
                                            "work_receipt": self.work_events(mission_id)[-1]["hash"]})
            return {"deployment": result, "mission_status": mission["status"], "replayed": False}

    @staticmethod
    def _completion_fields(current, status, error, stamp, mission_id):
        runs = current["runs_completed"] + 1
        failures = 0 if status == "completed" else current["failures_in_row"] + 1
        message = "" if status == "completed" else _error(error or f"Work {status}")
        state, upcoming = current["state"], None
        if state == "active":
            if status == "cancelled":
                state, message = "paused", message or "Work cancelled"
            elif failures >= current["max_failures_in_row"]:
                state = "paused"
                message = f"Auto-paused after {failures} consecutive failed runs. Last error: {message}"[:2000]
            elif runs >= current["max_runs"]:
                state = "finished"
            else:
                upcoming = following_run(current["trigger"], stamp)
                if upcoming is None:
                    state = "finished"
        return {"runs_completed": runs, "failures_in_row": failures, "active_request_id": None,
                "last_mission_id": mission_id, "last_status": status, "last_error": message, "state": state,
                "next_run_at": upcoming.isoformat() if upcoming else None, "updated_at": stamp.isoformat()}

    def record_deployment_dispatch_error(self, deployment_id, request_id, error, now=None):
        """Record pre-OM failure honestly: no completed run or fabricated mission; pause to stop loops."""
        _uuid(request_id)
        message = _error(error)
        if not message.strip():
            raise ValueError("Dispatch failure requires an error description")
        instant = _clock(now)
        with self._transaction():
            current = self.get_deployment(deployment_id)
            if current["active_request_id"] != request_id:
                raise LifecycleConflictError("Deployment active request changed")
            if self.get_work_by_request(request_id) is not None:
                raise ValueError("Work already exists; reconcile its actual terminal state")
            document = _strip(current)
            document.update(state="paused" if current["state"] == "active" else current["state"], next_run_at=None,
                            active_request_id=None, last_error=message,
                            updated_at=max(instant, _time(current["updated_at"])).isoformat())
            return self._lifecycle_write(document, current["revision"], "deployment.dispatch_failed",
                                         {"request_id": request_id, "reason": "No Work mission was created", "error": message})

    def deployment_events(self, deployment_id, limit=100, before_id=None):
        _uuid(deployment_id)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Deployment history pages contain 1..100 events")
        if before_id is not None and (type(before_id) is not int or before_id < 1):
            raise ValueError("Deployment history cursor must be a positive event identifier")
        with self._read_transaction():
            rows = self._db.execute(
                "SELECT * FROM agent_deployment_events WHERE deployment_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?",
                (deployment_id, before_id, before_id, limit + 1)).fetchall()
            events, size = [], 0
            for row in rows[:limit]:
                event = {**dict(row), "data": json.loads(row["data"])}
                length = len(_encoded(event).encode("utf-8"))
                if size + length > MAX_HISTORY_PAGE_BYTES:
                    if not events:
                        raise ValueError("Deployment event exceeds its history page budget")
                    break
                events.append(event)
                size += length
            return {"events": events, "next_before_id": events[-1]["id"] if len(rows) > len(events) else None}

    # ── verification ──────────────────────────────────────────────────────
    def _verify_lifecycles(self):
        latest, counts, previous, total = {}, {}, ZERO, 0
        for row in self._db.execute("SELECT * FROM agent_deployment_events ORDER BY id"):
            event = dict(row)
            event["data"] = json.loads(event["data"])
            stored_hash = event.pop("hash")
            document = validate_deployment(event["data"]["document"])
            change = event["data"]["change"]
            total += 1
            old = latest.get(event["deployment_id"])
            if (event["id"] != total or event["previous_hash"] != previous or _digest(event) != stored_hash
                    or document["id"] != event["deployment_id"] or _digest(document) != event["state_digest"]
                    or event["revision"] != (old[0] + 1 if old else 1) or event["created_at"] != document["updated_at"]):
                raise ValueError("Deployment event chain or revision mismatch")
            if old is None:
                if event["event_type"] != "deployment.created" or change != {"authority": LIFECYCLE_AUTHORITY}:
                    raise ValueError("Deployment must begin with authorized configuration")
                if document["runs_completed"] or document["active_request_id"] or document["last_mission_id"]:
                    raise ValueError("New deployments cannot carry runtime state")
            else:
                self._verify_lifecycle_transition(old[1], document, event["event_type"], change)
            counts[document["id"]] = counts.get(document["id"], 0) + 1
            if counts[document["id"]] > _history_budget(document):
                raise ValueError("Deployment exceeded bounded history")
            latest[document["id"]] = (event["revision"], document)
            previous = stored_hash
        rows = self._db.execute("SELECT * FROM agent_deployments").fetchall()
        if {row["id"] for row in rows} != set(latest):
            raise ValueError("Deployment event coverage mismatch")
        for row in rows:
            if latest[row["id"]] != (row["revision"], json.loads(row["document"])):
                raise ValueError("Deployment document differs from committed history")
        return {"deployments": len(rows), "deployment_events": total, "deployment_head_hash": previous}

    def _verify_lifecycle_transition(self, old, new, kind, change):
        immutable = ("id", "conversation_id", "created_at", "kind", "source", "provider", "previous_deployment_id")
        if any(old[key] != new[key] for key in immutable) or _time(new["updated_at"]) < _time(old["updated_at"]):
            raise ValueError("Deployment identity or clock changed")
        if old["state"] == "retired":
            raise ValueError("Retired deployments are terminal")
        operator = {"authority": LIFECYCLE_AUTHORITY}
        if kind == "deployment.saved":
            if {k: v for k, v in change.items() if k != "fields"} != operator or old["active_request_id"] is not None:
                raise ValueError("Invalid deployment edit")
            if new["state"] != old["state"] and not (old["state"] == "active" and new["state"] == "finished"
                                                     and new["runs_completed"] >= new["max_runs"]):
                raise ValueError("A configuration edit cannot change lifecycle state")
            allowed = _CONFIG | {"updated_at", "next_run_at", "state"}
        elif kind in {"deployment.active", "deployment.paused", "deployment.retired"}:
            if change != {**operator, "from": old["state"]} or new["state"] != kind.split(".", 1)[1]:
                raise ValueError("Invalid deployment state change")
            allowed = {"state", "next_run_at", "updated_at", "failures_in_row"}
        elif kind == "deployment.run_requested":
            if (change != operator or old["state"] != "active" or old["active_request_id"] is not None
                    or new["next_run_at"] != new["updated_at"]):
                raise ValueError("Invalid run request")
            allowed = {"next_run_at", "updated_at"}
        elif kind == "deployment.claimed":
            if (old["state"] != "active" or old["active_request_id"] is not None or new["active_request_id"] is None
                    or old["next_run_at"] is None or _time(new["updated_at"]) < _time(old["next_run_at"])
                    or old["runs_completed"] >= old["max_runs"] or change.get("request") != derived_request(new)):
                raise ValueError("Invalid deployment claim or derived request")
            allowed = {"active_request_id", "updated_at"}
        elif kind == "deployment.completed":
            if old["active_request_id"] is None or change.get("request_id") != old["active_request_id"] \
                    or change.get("mission_status") not in _TERMINAL:
                raise ValueError("Invalid deployment completion")
            work = self.get_work(change["mission_id"])
            proof = next((item for item in self.work_events(work["id"]) if item["revision"] == change.get("work_revision")), None)
            observed = proof["data"]["document"] if proof else {}
            if (proof is None or proof["hash"] != change.get("work_receipt") or observed.get("status") != change["mission_status"]
                    or work["request"] != derived_request(old)):
                raise ValueError("Deployment completion does not match actual terminal Work")
            expected = self._completion_fields(old, observed["status"], observed.get("error"), _time(new["updated_at"]),
                                               change["mission_id"])
            if any(new[key] != value for key, value in expected.items()):
                raise ValueError("Deployment completion state does not follow its committed policy")
            allowed = set(expected)
        elif kind == "deployment.dispatch_failed":
            if (old["active_request_id"] is None or change.get("request_id") != old["active_request_id"]
                    or new["active_request_id"] is not None or not new["last_error"] or change.get("error") != new["last_error"]
                    or new["next_run_at"] is not None):
                raise ValueError("Invalid deployment dispatch failure")
            allowed = {"state", "next_run_at", "active_request_id", "last_error", "updated_at"}
        else:
            raise ValueError("Unknown deployment event type")
        if any(old[key] != new[key] for key in _FIELDS - allowed):
            raise ValueError("Deployment event changed fields outside its authority")
