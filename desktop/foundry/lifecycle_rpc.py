"""Fixed deployed-agent lifecycle ingress. Only hosts dispatch claimed runs.

Operator commands (deploy/update/state/run-now) carry explicit local-user
lifecycle authority added here; dispatcher commands (claim/resolve/complete/
dispatch_error/cancel_request) only advance committed claims.
"""
from datetime import datetime, timezone
import re
import uuid

from .agent_lifecycles import LIFECYCLE_AUTHORITY, derived_request
from .lifecycle_triggers import preview, validate_trigger

FIELDS = {
    "lifecycle_list": {"command"},
    "lifecycle_deploy": {"command", "spec"},
    "lifecycle_update": {"command", "deployment_id", "expected_revision", "changes"},
    "lifecycle_state": {"command", "deployment_id", "expected_revision", "state"},
    "lifecycle_run_now": {"command", "deployment_id", "expected_revision"},
    "lifecycle_events": {"command", "deployment_id", "before_id"},
    "lifecycle_preview": {"command", "trigger"},
    "lifecycle_runner": {"command"},
    "lifecycle_claim": {"command"},
    "lifecycle_resolve": {"command", "request_id"},
    "lifecycle_complete": {"command", "deployment_id", "mission_id"},
    "lifecycle_dispatch_error": {"command", "deployment_id", "request_id", "error"},
    "lifecycle_cancel_request": {"command", "deployment_id", "request_id"},
}
STATELESS = {"lifecycle_preview", "lifecycle_runner"}


def validate(request):
    if not isinstance(request, dict) or set(request) != FIELDS.get(request.get("command")):
        raise ValueError("Invalid lifecycle RPC fields")
    for key in ("deployment_id", "request_id"):
        if key in request and (not isinstance(request[key], str) or str(uuid.UUID(request[key])) != request[key]):
            raise ValueError("Lifecycle RPC requires canonical UUIDs")
    if "mission_id" in request and (not isinstance(request["mission_id"], str)
                                    or not re.fullmatch(r"[0-9a-f]{32}", request["mission_id"])):
        raise ValueError("Lifecycle completion requires a mission identifier")
    if "expected_revision" in request and (type(request["expected_revision"]) is not int
                                           or not 1 <= request["expected_revision"] < 2**53):
        raise ValueError("Lifecycle changes require a safe revision")
    if "before_id" in request and request["before_id"] is not None and (
            type(request["before_id"]) is not int or not 1 <= request["before_id"] < 2**53):
        raise ValueError("Invalid lifecycle history cursor")
    if "error" in request and (not isinstance(request["error"], str) or not 1 <= len(request["error"]) <= 2000):
        raise ValueError("Dispatch error must contain bounded text")
    if "state" in request and request["state"] not in {"active", "paused", "retired"}:
        raise ValueError("Lifecycle state must be active, paused or retired")
    if "spec" in request and not isinstance(request["spec"], dict):
        raise ValueError("Deployment spec must be an object")
    if "changes" in request and not isinstance(request["changes"], dict):
        raise ValueError("Deployment changes must be an object")
    if "trigger" in request:
        validate_trigger(request["trigger"])
    return request


def handle_stateless(state_root, request):
    command = request["command"]
    if command == "lifecycle_preview":
        return {"times": preview(request["trigger"], datetime.now(timezone.utc), 5)}
    if command == "lifecycle_runner":
        from .lifecycle_runner import runner_status
        return {"runner": runner_status(state_root)}
    raise ValueError("Unsupported stateless lifecycle operation")


def empty_result(command):
    """Results before any journal exists (nothing has ever been deployed)."""
    if command == "lifecycle_list":
        return {"deployments": []}
    if command == "lifecycle_claim":
        return {"claims": []}
    if command == "lifecycle_resolve":
        return {"mission": None}
    return None


def handle(manager, request, *, state_root=None, claim_limit=20):
    store, command = manager.store, request["command"]
    if command in STATELESS:
        return handle_stateless(state_root, request)
    if command == "lifecycle_list":
        return {"deployments": store.list_deployments()}
    if command == "lifecycle_deploy":
        return {"deployment": store.create_deployment(request["spec"], LIFECYCLE_AUTHORITY)}
    if command == "lifecycle_update":
        return {"deployment": store.update_deployment(request["deployment_id"], request["expected_revision"],
                                                      request["changes"], LIFECYCLE_AUTHORITY)}
    if command == "lifecycle_state":
        return {"deployment": store.set_deployment_state(request["deployment_id"], request["expected_revision"],
                                                         request["state"], LIFECYCLE_AUTHORITY)}
    if command == "lifecycle_run_now":
        return {"deployment": store.request_deployment_run(request["deployment_id"], request["expected_revision"],
                                                           LIFECYCLE_AUTHORITY)}
    if command == "lifecycle_events":
        result = store.deployment_events(request["deployment_id"], before_id=request["before_id"])
        return {**result, "events": [{**{key: value for key, value in event.items() if key != "data"},
                                      "change": event["data"]["change"]} for event in result["events"]]}
    if command == "lifecycle_claim":
        # One process per dispatcher tick: defer to the headless runner when it owns the journal.
        from .lifecycle_runner import runner_status
        if state_root is not None and runner_status(state_root)["running"]:
            return {"claims": [], "delegated": True}
        return {"claims": store.claim_due_deployments(limit=claim_limit), "delegated": False}
    if command == "lifecycle_resolve":
        return {"mission": store.get_work_by_request(request["request_id"])}
    if command == "lifecycle_complete":
        return store.complete_deployment_run(request["deployment_id"], request["mission_id"])
    if command == "lifecycle_dispatch_error":
        return {"deployment": store.record_deployment_dispatch_error(request["deployment_id"], request["request_id"],
                                                                     request["error"])}
    if command == "lifecycle_cancel_request":
        deployment = store.get_deployment(request["deployment_id"])
        if deployment["active_request_id"] != request["request_id"] or deployment["state"] == "active":
            raise ValueError("Pause the deployment before cancelling its exact active run")
        return {"mission": manager.cancel_work_request(derived_request(deployment))}
    raise ValueError("Unsupported lifecycle operation")
