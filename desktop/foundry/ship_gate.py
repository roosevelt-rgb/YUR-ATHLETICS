"""Ship gate: "can it make money now?", persisted only by the existing CommitService.

Ported from the LAUNCH RP ship ledger (its ship_ledger.py):
a candidate ships (PASS) only when every probe passes; anything else is DEBT.
Differences from the original, on purpose:

* probes are a closed set of safe, read-only kinds (loopback HTTP, read-only SQLite);
* a live endpoint means a strict 2xx (the original counted 401/500 as live);
* "a file contains a word" is not a probe here;
* the verdict is recomputed from probe results at commit time, never trusted from a caller;
* a new DEBT proposes one *paused* Work mission that an operator must activate.

This module never opens a socket or file while a journal transaction is held: hosts
run probes first (``run_probes``), then commit the observed results.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote, urlsplit
import urllib.error
import urllib.request
import uuid

from .lifecycle_triggers import parse_instant
from .repository_context import SECRET_CONTENT

SHIP_AUTHORITY = {"issuer": "local-user", "scope": "ship-gate", "actions": ["commit"]}
MAX_CANDIDATES = 50
MAX_PROBES = 12
MAX_CHECKS = 10000
MAX_DOCUMENT_BYTES = 64 * 1024
MAX_HISTORY_PAGE_BYTES = 1024 * 1024
ZERO = "0" * 64
STATES = ("active", "paused", "retired")
VERDICTS = ("", "PASS", "DEBT")
PROBE_KINDS = ("http_ok", "http_money", "sqlite_metric")
OPERATORS = {">=": lambda a, b: a >= b, ">": lambda a, b: a > b, "<=": lambda a, b: a <= b,
             "<": lambda a, b: a < b, "==": lambda a, b: a == b}
DEFAULT_DEBT_MODEL = "qwen3.5:9b"
_FIELDS = {"id", "name", "money_path", "probes", "interval_seconds", "state", "next_check_at", "checks_run",
           "last_verdict", "last_notes", "last_checked_at", "debt_goal", "debt_model", "debt_deployment_id",
           "created_at", "updated_at"}
_SELECT = re.compile(r"^\s*select\b", re.IGNORECASE)
_FORBIDDEN_SQL = re.compile(r";|\b(attach|detach|pragma|load_extension|insert|update|delete|replace|create|drop|alter|vacuum)\b",
                            re.IGNORECASE)
# Same deliberately narrow money signal as the original ledger: a price or a billing id, not the word "billing".
PRICE_RE = re.compile(
    # The original pattern required `price:` directly, so ordinary JSON (`"price": 99`) never matched.
    r"(?:\$\d+(?:\.\d{2})?|USD\s?\d+|price['\"]?\s*[:=]\s*['\"]?\d+|amount[_a-z]*['\"]?\s*[:=]\s*\d+"
    r"|unit[_a-z]*['\"]?\s*[:=]\s*['\"]?(?:subscription|month|seat|token)"
    r"|stripe_id|checkout[._-]session[._-]id|invoice[._-]id"
    r"|\"status\"\s*:\s*\"(?:active|trialing|past_due|paid)\"|payment_(?:url|intent|method))",
    re.IGNORECASE)


class ShipGateConflictError(ValueError):
    """The candidate changed after the caller read it."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_encoded(value).encode("utf-8")).hexdigest()


def _uuid(value, label="Ship gate identifiers"):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{label} must be canonical UUID strings") from exc


def _clock(value=None):
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("Ship gate clock requires a timezone")
        return value.astimezone(timezone.utc)
    return parse_instant(value)


def _text(value, field, maximum, nonempty=False):
    if not isinstance(value, str) or len(value) > maximum or "\0" in value or (nonempty and not value.strip()):
        raise ValueError(f"Invalid bounded ship candidate {field}")


def _loopback_url(url):
    _text(url, "probe url", 512, True)
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost"} or parts.username or parts.password:
        raise ValueError("Ship probes may only call loopback http:// endpoints without credentials")
    return url


def validate_probe(probe):
    if not isinstance(probe, dict) or probe.get("kind") not in PROBE_KINDS:
        raise ValueError(f"Probe kind must be one of {', '.join(PROBE_KINDS)}")
    if probe["kind"] in {"http_ok", "http_money"}:
        if set(probe) != {"kind", "url", "label"}:
            raise ValueError("HTTP probes take exactly kind, url and label")
        _loopback_url(probe["url"])
    else:
        if set(probe) != {"kind", "path", "query", "op", "threshold", "label"}:
            raise ValueError("SQLite probes take exactly kind, path, query, op, threshold and label")
        _text(probe["path"], "probe path", 1024, True)
        path = Path(probe["path"])
        if not path.is_absolute() or path.suffix.lower() not in {".db", ".sqlite", ".sqlite3"}:
            raise ValueError("SQLite probes need an absolute .db/.sqlite/.sqlite3 path")
        _text(probe["query"], "probe query", 1000, True)
        if not _SELECT.match(probe["query"]) or _FORBIDDEN_SQL.search(probe["query"]):
            raise ValueError("SQLite probes run exactly one read-only SELECT")
        if probe["op"] not in OPERATORS:
            raise ValueError(f"Probe comparison must be one of {', '.join(OPERATORS)}")
        if type(probe["threshold"]) not in (int, float) or not math.isfinite(probe["threshold"]):
            raise ValueError("Probe threshold must be a finite number")
    _text(probe["label"], "probe label", 160, True)
    return probe


def validate_candidate(document):
    if not isinstance(document, dict) or set(document) != _FIELDS:
        raise ValueError("Ship candidate contains missing or unsupported fields")
    _uuid(document["id"])
    _text(document["name"], "name", 160, True)
    _text(document["money_path"], "money path", 2000, True)
    if not isinstance(document["probes"], list) or not 1 <= len(document["probes"]) <= MAX_PROBES:
        raise ValueError(f"A ship candidate needs 1..{MAX_PROBES} probes")
    for probe in document["probes"]:
        validate_probe(probe)
    if type(document["interval_seconds"]) is not int or not 300 <= document["interval_seconds"] <= 7 * 86400:
        raise ValueError("Ship check interval must be 300 seconds .. 7 days")
    if document["state"] not in STATES:
        raise ValueError(f"Ship candidate state must be one of {', '.join(STATES)}")
    if type(document["checks_run"]) is not int or not 0 <= document["checks_run"] <= MAX_CHECKS:
        raise ValueError("Ship check count is outside its bounds")
    if document["last_verdict"] not in VERDICTS or (document["checks_run"] == 0) != (document["last_verdict"] == ""):
        raise ValueError("A verdict exists exactly when a check has run")
    if not isinstance(document["last_notes"], list) or len(document["last_notes"]) > MAX_PROBES or any(
            not isinstance(note, str) or len(note) > 500 for note in document["last_notes"]):
        raise ValueError("Ship notes must be bounded strings")
    _text(document["debt_goal"], "debt goal", 8000)
    _text(document["debt_model"], "debt model", 256, True)
    if document["debt_deployment_id"] is not None:
        _uuid(document["debt_deployment_id"])
    created, updated = _clock(document["created_at"]), _clock(document["updated_at"])
    if updated < created:
        raise ValueError("Ship candidate clocks cannot precede creation")
    for key in ("next_check_at", "last_checked_at"):
        if document[key] is not None:
            _clock(document[key])
    if (document["state"] == "active") != (document["next_check_at"] is not None):
        raise ValueError("Exactly active candidates carry a next check")
    if (document["checks_run"] == 0) != (document["last_checked_at"] is None):
        raise ValueError("A check time exists exactly when a check has run")
    encoded = _encoded(document)
    if len(encoded.encode("utf-8")) > MAX_DOCUMENT_BYTES:
        raise ValueError("Ship candidate exceeds its 64 KiB budget")
    if SECRET_CONTENT.search(encoded):
        raise ValueError("Ship candidates must not contain credentials")
    return json.loads(encoded)


def new_candidate(spec, instant=None):
    if not isinstance(spec, dict):
        raise ValueError("Ship candidate spec must be an object")
    allowed = {"name", "money_path", "probes", "interval_seconds", "state", "debt_goal", "debt_model"}
    if not set(spec) <= allowed or not {"name", "money_path", "probes"} <= set(spec):
        raise ValueError("Ship candidate spec requires name, money_path and probes and nothing unsupported")
    stamp = _clock(instant)
    state = spec.get("state", "active")
    if state not in {"active", "paused"}:
        raise ValueError("New ship candidates start active or paused")
    return validate_candidate({
        "id": str(uuid.uuid4()), "name": spec["name"], "money_path": spec["money_path"], "probes": spec["probes"],
        "interval_seconds": spec.get("interval_seconds", 86400), "state": state,
        "next_check_at": stamp.isoformat() if state == "active" else None, "checks_run": 0, "last_verdict": "",
        "last_notes": [], "last_checked_at": None, "debt_goal": spec.get("debt_goal", ""),
        "debt_model": spec.get("debt_model", DEFAULT_DEBT_MODEL), "debt_deployment_id": None,
        "created_at": stamp.isoformat(), "updated_at": stamp.isoformat()})


# ── probes (host side; never inside a journal transaction) ─────────────────
def _http(url, timeout):
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "yur-ship-gate/1"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback must never leave via a proxy
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(64 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, b""
    except (urllib.error.URLError, OSError, ValueError) as error:
        return 0, str(getattr(error, "reason", error)).encode("utf-8", "replace")[:200]


def _sqlite_value(probe, timeout):
    uri = "file:" + quote(Path(probe["path"]).as_posix(), safe="/:") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=timeout)
    try:
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}
        connection.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
        budget = {"steps": 0}

        def guard():
            budget["steps"] += 1
            return 1 if budget["steps"] > 2000 else 0  # ~20M VM instructions, then abort

        connection.set_progress_handler(guard, 10000)
        row = connection.execute(probe["query"]).fetchone()
    finally:
        connection.close()
    if row is None or len(row) < 1:
        raise ValueError("query returned no row")
    value = row[0]
    if value is None:
        raise ValueError("query returned NULL")
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("query did not return a finite number")
    return value


def run_probe(probe, timeout=4.0):
    """Execute one validated probe. Returns {passed, note, observed}; never raises."""
    validate_probe(probe)
    label = probe["label"]
    try:
        if probe["kind"] in {"http_ok", "http_money"}:
            status, body = _http(probe["url"], timeout)
            if status == 0:
                return {"passed": False, "note": f"{label}: unreachable ({body.decode('utf-8', 'replace')[:120]})",
                        "observed": None}
            if not 200 <= status < 300:
                return {"passed": False, "note": f"{label}: HTTP {status}", "observed": status}
            if probe["kind"] == "http_money" and not PRICE_RE.search(body.decode("utf-8", "replace")):
                return {"passed": False, "note": f"{label}: HTTP {status} but no money signal", "observed": status}
            return {"passed": True, "note": f"{label}: HTTP {status}" + (" with money signal" if probe["kind"] == "http_money" else ""),
                    "observed": status}
        if not Path(probe["path"]).is_file():
            return {"passed": False, "note": f"{label}: database missing", "observed": None}
        value = _sqlite_value(probe, timeout)
        passed = OPERATORS[probe["op"]](value, probe["threshold"])
        shown = round(value, 4) if isinstance(value, float) else value
        return {"passed": passed, "note": f"{label}: {shown} {probe['op']} {probe['threshold']} → {'ok' if passed else 'not yet'}",
                "observed": shown}
    except Exception as error:  # a probe failure is DEBT evidence, not a crash
        return {"passed": False, "note": f"{label}: {type(error).__name__}: {str(error)[:200]}", "observed": None}


def run_probes(candidate, timeout=4.0):
    return [run_probe(probe, timeout) for probe in candidate["probes"]]


def _validated_results(candidate, results):
    if not isinstance(results, list) or len(results) != len(candidate["probes"]):
        raise ValueError("Ship check needs exactly one result per probe")
    checked = []
    for result in results:
        if (not isinstance(result, dict) or set(result) != {"passed", "note", "observed"}
                or type(result["passed"]) is not bool or not isinstance(result["note"], str) or len(result["note"]) > 500
                or not (result["observed"] is None or type(result["observed"]) in (int, float))):
            raise ValueError("Invalid ship probe result")
        checked.append({**result, "note": SECRET_CONTENT.sub("[redacted]", result["note"])})
    return checked


def debt_spec(candidate):
    """The paused Work mission a fresh DEBT proposes (operator activates it)."""
    goal = candidate["debt_goal"].strip() or (
        f"The ship gate marked '{candidate['name']}' as DEBT. Review the failing probes below, explain what blocks "
        "it from making money now, and propose the smallest concrete fix.")
    notes = "\n".join(f"- {note}" for note in candidate["last_notes"])
    return {"name": f"Ship debt: {candidate['name']}"[:160], "kind": "work_goal", "state": "paused",
            "goal": f"{goal}\n\nMoney path: {candidate['money_path']}\n\nLast check:\n{notes}"[:24000],
            "model": candidate["debt_model"], "trigger": {"kind": "manual"}, "max_runs": 5}


class ShipGateCommitMixin:
    """Ship candidates share CommitService transactions and keep their own hash chain."""

    def _initialize_ship_schema(self):
        self._db.execute("""CREATE TABLE IF NOT EXISTS ship_candidates (
            id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0))""")
        self._db.execute("""CREATE TABLE IF NOT EXISTS ship_events (
            id INTEGER PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES ship_candidates(id),
            revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
            state_digest TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
            UNIQUE(candidate_id, revision))""")
        self._db.execute("CREATE INDEX IF NOT EXISTS ship_history ON ship_events(candidate_id, id)")

    def _ship_write(self, document, revision, event_type, change):
        checked = validate_candidate(document)
        next_revision = revision + 1
        if revision == 0:
            self._db.execute("INSERT INTO ship_candidates VALUES (?,?,?)", (checked["id"], _encoded(checked), next_revision))
        else:
            changed = self._db.execute("UPDATE ship_candidates SET document=?, revision=? WHERE id=? AND revision=?",
                                       (_encoded(checked), next_revision, checked["id"], revision))
            if changed.rowcount != 1:
                raise ShipGateConflictError("Ship candidate changed; reload its current revision")
        last = self._db.execute("SELECT id,hash FROM ship_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {"id": last["id"] + 1 if last else 1, "candidate_id": checked["id"], "revision": next_revision,
                 "event_type": event_type, "data": {"document": checked, "change": change},
                 "created_at": checked["updated_at"], "state_digest": _digest(checked),
                 "previous_hash": last["hash"] if last else ZERO}
        event["hash"] = _digest(event)
        self._db.execute("INSERT INTO ship_events VALUES (?,?,?,?,?,?,?,?,?)",
                         (event["id"], event["candidate_id"], next_revision, event_type, _encoded(event["data"]),
                          event["created_at"], event["state_digest"], event["previous_hash"], event["hash"]))
        return {**checked, "revision": next_revision}

    def _ship_authority(self, authority):
        if authority != SHIP_AUTHORITY:
            raise ValueError("Ship gate changes require explicit local-user ship-gate authority")

    def _ship_current(self, candidate_id, expected_revision=None):
        current = self.get_ship_candidate(candidate_id)
        if expected_revision is not None and current["revision"] != expected_revision:
            raise ShipGateConflictError("Ship candidate changed; reload its current revision")
        return current

    # ── reads ─────────────────────────────────────────────────────────────
    def get_ship_candidate(self, candidate_id):
        _uuid(candidate_id)
        with self._read_transaction():
            row = self._db.execute("SELECT * FROM ship_candidates WHERE id=?", (candidate_id,)).fetchone()
            if row is None:
                raise ValueError("Ship candidate not found")
            return {**json.loads(row["document"]), "revision": row["revision"]}

    def list_ship_candidates(self):
        with self._read_transaction():
            return [{**json.loads(row["document"]), "revision": row["revision"]}
                    for row in self._db.execute("SELECT * FROM ship_candidates ORDER BY rowid")]

    def due_ship_candidates(self, now=None, limit=5):
        instant = _clock(now)
        due = [item for item in self.list_ship_candidates()
               if item["state"] == "active" and item["next_check_at"] and _clock(item["next_check_at"]) <= instant]
        due.sort(key=lambda item: (item["next_check_at"], item["id"]))
        return due[:limit]

    def ship_events(self, candidate_id, limit=50):
        _uuid(candidate_id)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Ship history pages contain 1..100 events")
        with self._read_transaction():
            rows = self._db.execute("SELECT * FROM ship_events WHERE candidate_id=? ORDER BY id DESC LIMIT ?",
                                    (candidate_id, limit)).fetchall()
            events, size = [], 0
            for row in rows:
                event = {**dict(row), "data": json.loads(row["data"])}
                event = {key: value for key, value in event.items() if key != "data"} | {"change": event["data"]["change"]}
                size += len(_encoded(event).encode("utf-8"))
                if size > MAX_HISTORY_PAGE_BYTES:
                    break
                events.append(event)
            return events

    # ── operator actions ──────────────────────────────────────────────────
    def create_ship_candidate(self, spec, authority, now=None):
        self._ship_authority(authority)
        document = new_candidate(spec, now)
        with self._transaction():
            if self._db.execute("SELECT COUNT(*) FROM ship_candidates WHERE json_extract(document,'$.state')!='retired'"
                                ).fetchone()[0] >= MAX_CANDIDATES:
                raise ValueError(f"Ship gate is limited to {MAX_CANDIDATES} non-retired candidates")
            return self._ship_write(document, 0, "ship.created", {"authority": SHIP_AUTHORITY})

    def set_ship_candidate_state(self, candidate_id, expected_revision, state, authority, now=None):
        self._ship_authority(authority)
        if state not in STATES:
            raise ValueError("Operators may activate, pause or retire a ship candidate")
        instant = _clock(now)
        with self._transaction():
            current = self._ship_current(candidate_id, expected_revision)
            if current["state"] == "retired":
                raise ValueError("A retired ship candidate is terminal")
            if current["state"] == state:
                return current
            stamp = max(instant, _clock(current["updated_at"]))
            document = {key: value for key, value in current.items() if key != "revision"}
            document.update(state=state, updated_at=stamp.isoformat(),
                            next_check_at=stamp.isoformat() if state == "active" else None)
            return self._ship_write(document, current["revision"], f"ship.{state}",
                                    {"authority": SHIP_AUTHORITY, "from": current["state"]})

    def request_ship_check(self, candidate_id, expected_revision, authority, now=None):
        """Operator or Pulse 'check now': make an active candidate due immediately."""
        self._ship_authority(authority)
        instant = _clock(now)
        with self._transaction():
            current = self._ship_current(candidate_id, expected_revision)
            if current["state"] != "active":
                raise ValueError("Only an active ship candidate can be checked on request")
            stamp = max(instant, _clock(current["updated_at"]))
            document = {key: value for key, value in current.items() if key != "revision"}
            document.update(updated_at=stamp.isoformat(), next_check_at=stamp.isoformat())
            return self._ship_write(document, current["revision"], "ship.check_requested", {"authority": SHIP_AUTHORITY})

    # ── host protocol ─────────────────────────────────────────────────────
    def record_ship_check(self, candidate_id, expected_revision, results, now=None):
        """Commit observed probe results. The verdict is derived here, never accepted from the caller."""
        instant = _clock(now)
        with self._transaction():
            current = self._ship_current(candidate_id, expected_revision)
            if current["state"] != "active":
                raise ValueError("Only an active ship candidate records checks")
            if current["checks_run"] >= MAX_CHECKS:
                raise ValueError("Ship candidate reached its check budget")
            checked = _validated_results(current, results)
            verdict = "PASS" if all(item["passed"] for item in checked) else "DEBT"
            stamp = max(instant, _clock(current["updated_at"]))
            document = {key: value for key, value in current.items() if key != "revision"}
            document.update(checks_run=current["checks_run"] + 1, last_verdict=verdict,
                            last_notes=[item["note"] for item in checked], last_checked_at=stamp.isoformat(),
                            updated_at=stamp.isoformat(),
                            next_check_at=(stamp + timedelta(seconds=current["interval_seconds"])).isoformat())
            saved = self._ship_write(document, current["revision"], "ship.checked",
                                     {"results": checked, "verdict": verdict, "previous_verdict": current["last_verdict"]})
            propose = verdict == "DEBT" and current["last_verdict"] != "DEBT" and saved["debt_deployment_id"] is None
            return {"candidate": saved, "verdict": verdict, "propose_debt": propose}

    def link_ship_debt(self, candidate_id, expected_revision, deployment_id, now=None):
        _uuid(deployment_id)
        instant = _clock(now)
        with self._transaction():
            current = self._ship_current(candidate_id, expected_revision)
            if current["debt_deployment_id"] is not None or current["last_verdict"] != "DEBT":
                raise ValueError("Only a DEBT candidate without a proposal can link one")
            deployment = self.get_deployment(deployment_id)
            if deployment["kind"] != "work_goal" or deployment["runs_completed"] != 0:
                raise ValueError("A ship debt proposal must be a fresh Work-goal deployment")
            document = {key: value for key, value in current.items() if key != "revision"}
            document.update(debt_deployment_id=deployment_id,
                            updated_at=max(instant, _clock(current["updated_at"])).isoformat())
            return self._ship_write(document, current["revision"], "ship.debt_proposed", {"deployment_id": deployment_id})

    # ── verification ──────────────────────────────────────────────────────
    def _verify_ship_gate(self):
        latest, previous, total = {}, ZERO, 0
        for row in self._db.execute("SELECT * FROM ship_events ORDER BY id"):
            event = dict(row)
            event["data"] = json.loads(event["data"])
            stored = event.pop("hash")
            document = validate_candidate(event["data"]["document"])
            change = event["data"]["change"]
            total += 1
            old = latest.get(event["candidate_id"])
            if (event["id"] != total or event["previous_hash"] != previous or _digest(event) != stored
                    or document["id"] != event["candidate_id"] or _digest(document) != event["state_digest"]
                    or event["revision"] != (old[0] + 1 if old else 1) or event["created_at"] != document["updated_at"]):
                raise ValueError("Ship event chain or revision mismatch")
            if old is None:
                if event["event_type"] != "ship.created" or change != {"authority": SHIP_AUTHORITY} or document["checks_run"]:
                    raise ValueError("Ship candidates must begin with authorized, unchecked configuration")
            else:
                self._verify_ship_transition(old[1], document, event["event_type"], change)
            latest[document["id"]] = (event["revision"], document)
            previous = stored
        rows = self._db.execute("SELECT * FROM ship_candidates").fetchall()
        if {row["id"] for row in rows} != set(latest):
            raise ValueError("Ship candidate event coverage mismatch")
        for row in rows:
            if latest[row["id"]] != (row["revision"], json.loads(row["document"])):
                raise ValueError("Ship candidate differs from committed history")
        return {"ship_candidates": len(rows), "ship_events": total, "ship_head_hash": previous}

    def _verify_ship_transition(self, old, new, kind, change):
        immutable = ("id", "name", "money_path", "probes", "interval_seconds", "debt_goal", "debt_model", "created_at")
        if any(old[key] != new[key] for key in immutable) or _clock(new["updated_at"]) < _clock(old["updated_at"]):
            raise ValueError("Ship candidate identity or clock changed")
        if old["state"] == "retired":
            raise ValueError("Retired ship candidates are terminal")
        if kind in {"ship.active", "ship.paused", "ship.retired"}:
            if change != {"authority": SHIP_AUTHORITY, "from": old["state"]} or new["state"] != kind.split(".", 1)[1]:
                raise ValueError("Invalid ship candidate state change")
            allowed = {"state", "next_check_at", "updated_at"}
        elif kind == "ship.check_requested":
            if change != {"authority": SHIP_AUTHORITY} or old["state"] != "active" or new["next_check_at"] != new["updated_at"]:
                raise ValueError("Invalid ship check request")
            allowed = {"next_check_at", "updated_at"}
        elif kind == "ship.checked":
            results = change.get("results")
            verdict = "PASS" if isinstance(results, list) and results and all(item.get("passed") is True for item in results) else "DEBT"
            if (old["state"] != "active" or change.get("verdict") != verdict or new["last_verdict"] != verdict
                    or change.get("previous_verdict") != old["last_verdict"] or new["checks_run"] != old["checks_run"] + 1
                    or len(results or []) != len(old["probes"])
                    or new["last_notes"] != [item["note"] for item in results]):
                raise ValueError("Ship check verdict does not follow its recorded probe results")
            allowed = {"checks_run", "last_verdict", "last_notes", "last_checked_at", "updated_at", "next_check_at"}
        elif kind == "ship.debt_proposed":
            if (old["debt_deployment_id"] is not None or old["last_verdict"] != "DEBT"
                    or new["debt_deployment_id"] != change.get("deployment_id")):
                raise ValueError("Invalid ship debt proposal")
            allowed = {"debt_deployment_id", "updated_at"}
        else:
            raise ValueError("Unknown ship event type")
        if any(old[key] != new[key] for key in _FIELDS - allowed):
            raise ValueError("Ship event changed fields outside its authority")
