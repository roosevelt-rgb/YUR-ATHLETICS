"""Fixed ingress for the ship gate, Pulse intake and the Organism view.

    ship_list / ship_create / ship_state / ship_check_now / ship_events
    pulse_intake
    organism_status

Operator commands get explicit local-user authority here. ``perform_check`` runs a
candidate's read-only probes outside any journal transaction, commits the observed
results, and, on a fresh DEBT, proposes one paused Work mission (shared with the
headless runner).
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import urllib.error
import urllib.request
import uuid

from .agent_lifecycles import LIFECYCLE_AUTHORITY
from .ship_gate import SHIP_AUTHORITY, ShipGateConflictError, debt_spec, run_probes

FIELDS = {
    "ship_list": {"command"},
    "ship_create": {"command", "spec"},
    "ship_state": {"command", "candidate_id", "expected_revision", "state"},
    "ship_check_now": {"command", "candidate_id"},
    "ship_events": {"command", "candidate_id"},
    "pulse_intake": {"command", "mutation"},
    "organism_status": {"command"},
}
PREFIXES = ("ship_", "pulse_", "organism_")
MAX_INPUT_BYTES = 64 * 1024


def owns(command):
    return isinstance(command, str) and command.startswith(PREFIXES)


def validate(request):
    if not isinstance(request, dict) or set(request) != FIELDS.get(request.get("command")):
        raise ValueError("Invalid organism RPC fields")
    if "candidate_id" in request:
        try:
            if not isinstance(request["candidate_id"], str) or str(uuid.UUID(request["candidate_id"])) != request["candidate_id"]:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ValueError("Ship gate RPC requires a canonical candidate UUID") from exc
    if "expected_revision" in request and (type(request["expected_revision"]) is not int
                                           or not 1 <= request["expected_revision"] < 2**53):
        raise ValueError("Ship gate changes require a safe revision")
    if "state" in request and request["state"] not in {"active", "paused", "retired"}:
        raise ValueError("Ship candidate state must be active, paused or retired")
    if "spec" in request and not isinstance(request["spec"], dict):
        raise ValueError("Ship candidate spec must be an object")
    if "mutation" in request and not isinstance(request["mutation"], dict):
        raise ValueError("Pulse mutation must be an object")
    if len(json.dumps(request, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("Organism RPC exceeds its input budget")
    return request


def empty_result(command):
    """Results before any journal exists."""
    if command == "ship_list":
        return {"candidates": []}
    if command == "organism_status":
        return _status(None, None)
    return None


def perform_check(store, candidate, log=lambda message: None):
    """Probe → commit → (fresh DEBT) propose a paused mission. Never fabricates a result."""
    results = run_probes(candidate)
    try:
        outcome = store.record_ship_check(candidate["id"], candidate["revision"], results)
    except ShipGateConflictError:
        log(f"[ship] {candidate['name']!r} changed while probing; it will be checked again")
        return {"candidate": store.get_ship_candidate(candidate["id"]), "verdict": None, "proposed": None}
    log(f"[ship] {candidate['name']!r} → {outcome['verdict']}")
    proposed = None
    if outcome["propose_debt"]:
        saved = outcome["candidate"]
        deployment = store.create_deployment(debt_spec(saved), LIFECYCLE_AUTHORITY)
        outcome["candidate"] = store.link_ship_debt(saved["id"], saved["revision"], deployment["id"])
        proposed = deployment
        log(f"[ship] proposed paused debt mission {deployment['id']} for {saved['name']!r}")
    return {"candidate": outcome["candidate"], "verdict": outcome["verdict"], "proposed": proposed}


def _reachable(url, timeout=1.0):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(urllib.request.Request(url, method="GET"), timeout=timeout) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _status(store, state_root):
    from .lifecycle_runner import runner_status
    deployments = store.list_deployments() if store else []
    candidates = store.list_ship_candidates() if store else []
    integrity = store.verify_integrity() if store else {}
    recent = []
    if store:
        rows = store._db.execute(
            "SELECT id, deployment_id, event_type, created_at, data FROM agent_deployment_events ORDER BY id DESC LIMIT 30").fetchall()
        names = {item["id"]: item["name"] for item in deployments}
        for row in rows:
            change = json.loads(row["data"])["change"]
            recent.append({"id": row["id"], "lane": "lifecycle", "event_type": row["event_type"], "at": row["created_at"],
                           "subject": names.get(row["deployment_id"], row["deployment_id"]),
                           "detail": change.get("mission_status") or change.get("reason") or change.get("from") or ""})
        rows = store._db.execute("SELECT id, candidate_id, event_type, created_at, data FROM ship_events ORDER BY id DESC LIMIT 30").fetchall()
        labels = {item["id"]: item["name"] for item in candidates}
        for row in rows:
            change = json.loads(row["data"])["change"]
            recent.append({"id": row["id"], "lane": "ship", "event_type": row["event_type"], "at": row["created_at"],
                           "subject": labels.get(row["candidate_id"], row["candidate_id"]),
                           "detail": change.get("verdict") or change.get("deployment_id") or change.get("from") or ""})
        recent.sort(key=lambda item: item["at"], reverse=True)
    by_state = {}
    for item in deployments:
        by_state[item["state"]] = by_state.get(item["state"], 0) + 1
    return {
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "deployments": {"total": len(deployments), "by_state": by_state,
                        "runs_completed": sum(item["runs_completed"] for item in deployments),
                        "in_flight": sum(1 for item in deployments if item["active_request_id"]),
                        "awaiting_approval": sum(1 for item in deployments if item["state"] == "paused" and item["runs_completed"] == 0),
                        "items": [{key: item[key] for key in ("id", "name", "kind", "state", "runs_completed", "max_runs",
                                                              "failures_in_row", "next_run_at", "last_status", "last_error",
                                                              "last_mission_id", "revision")} for item in deployments]},
        "ship": {"total": len(candidates),
                 "pass": sum(1 for item in candidates if item["last_verdict"] == "PASS"),
                 "debt": sum(1 for item in candidates if item["last_verdict"] == "DEBT"),
                 "items": [{key: item[key] for key in ("id", "name", "money_path", "state", "last_verdict", "last_notes",
                                                       "last_checked_at", "next_check_at", "checks_run", "debt_deployment_id",
                                                       "revision")} for item in candidates]},
        "integrity": {key: integrity[key] for key in integrity if key.endswith("_head_hash") or key in
                      {"passed", "missions", "deployments", "deployment_events", "ship_candidates", "ship_events"}},
        "runner": runner_status(state_root),
        "providers": {"ollama": _reachable("http://127.0.0.1:11434/api/version"),
                      "comfyui": _reachable("http://127.0.0.1:8188/system_stats")},
        "recent": recent[:40],
    }


def handle(store, request, *, state_root=None):
    command = request["command"]
    if command == "organism_status":
        return _status(store, state_root)
    if command == "ship_list":
        return {"candidates": store.list_ship_candidates()}
    if command == "ship_create":
        return {"candidate": store.create_ship_candidate(request["spec"], SHIP_AUTHORITY)}
    if command == "ship_state":
        return {"candidate": store.set_ship_candidate_state(request["candidate_id"], request["expected_revision"],
                                                            request["state"], SHIP_AUTHORITY)}
    if command == "ship_check_now":
        candidate = store.get_ship_candidate(request["candidate_id"])
        if candidate["state"] != "active":
            raise ValueError("Activate the ship candidate before checking it")
        return perform_check(store, candidate)
    if command == "ship_events":
        return {"events": store.ship_events(request["candidate_id"])}
    if command == "pulse_intake":
        from .pulse_intake import intake
        return intake(store, request["mutation"])
    raise ValueError("Unsupported organism operation")
