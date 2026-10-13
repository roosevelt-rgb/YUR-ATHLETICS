"""Desktop ingress for source profiles and admitted workers under the existing OM."""
from __future__ import annotations

import hashlib
import uuid

from .orchestration import canonical, local_authority
from .pack_compiler import _trusted_runtime_source
from .specialists import CapabilityRegistry, validate_schema
from .workforce_catalog import WorkforceCatalog

CAPABILITY = "workforce.hatch.quantity"
ADMITTED_SOURCE_SHA256 = "da68288a6d51def386e6cd909e46fa3b3a72c331cdddda05fb666a2e9de10477"


def catalog(request):
    result = WorkforceCatalog(request["root"]).catalog(request.get("query", ""))
    for entry in result["entries"]:
        entry["availability"] = "context-only"
        if entry["code"] == "hatch_quantity" and entry["sha256"] == ADMITTED_SOURCE_SHA256:
            entry["availability"] = "admitted-worker"
            entry["execution_admitted"] = True
            entry["execution_binding"] = {"capability_id": CAPABILITY, "status": "admitted",
                                          "authority": "OrchestrationManager / CommitService"}
    executable = sum(entry["execution_admitted"] for entry in result["entries"])
    result["availability"] = {
        "listed_profiles": len(result["entries"]),
        "context_profiles": len(result["entries"]) - executable,
        "executable_profiles": executable,
        "coverage_limited": bool(result["truncated"] or result["next_offset"] is not None),
    }
    return result


def acquire(request):
    return WorkforceCatalog(request["root"]).acquire(request["code"], request["expected_sha256"])


def _result(event):
    data = event["data"]
    return {**data, "output_record": {key: value for key, value in event.items() if key != "data"}}


def result(request, manager):
    for event in reversed(manager.store.events(request["mission_id"])):
        if event["event_type"] == "workforce.result.committed" and event["data"]["run_id"] == request["run_id"]:
            return _result(event)
    raise ValueError("Workforce result not found")


def _recover(request, mission_id, input_hash, manager):
    """Called under the worker lock; recover persisted output without executing."""
    events = manager.store.events(mission_id)
    accepted = next((event["data"] for event in events
                     if event["event_type"] == "workforce.request.accepted"), None)
    if accepted and (accepted["input_hash"] != input_hash
                     or accepted["profile"]["sha256"] != request["expected_sha256"]):
        raise ValueError("Request ID already used with different quantity input or source")
    for event in events:
        if event["event_type"] == "workforce.result.committed":
            if event["data"]["input_hash"] != input_hash:
                raise ValueError("Request ID already used with different quantity input")
            return _result(event), accepted
    # Completion retains its output in the same CommitService transaction. If
    # the desktop exited before linking that result, only create the missing link.
    for event in reversed(events):
        if (accepted and event["event_type"] == "execution.completed"
                and event["data"].get("capability_id") == CAPABILITY
                and event["data"].get("input_hash") == input_hash
                and "output" in event["data"]):
            execution = {"run_id": event["data"]["run_id"],
                         "output": event["data"]["output"], "receipt": event}
            return _commit_result(request, mission_id, accepted, execution, manager), accepted
    return None, accepted


def _commit_result(request, mission_id, accepted, execution, manager):
    event = manager.store.record_event(mission_id, "workforce.result.committed", {
        "mission_id": mission_id, "run_id": execution["run_id"], "request_id": request["request_id"],
        "capability_id": CAPABILITY, "input_hash": accepted["input_hash"], "output": execution["output"],
        "execution_receipt": execution["receipt"], "profile": accepted["profile"],
        "source_provenance": accepted["source_provenance"],
    })
    return _result(event)


def run(request, manager):
    """Use one admitted pure worker; never import or dispatch the donor controller."""
    if request["code"] != "hatch_quantity":
        raise PermissionError("This workforce profile has no admitted execution binding")
    if str(uuid.UUID(request["request_id"])) != request["request_id"]:
        raise ValueError("A canonical request UUID is required")
    selected = acquire(request)
    if selected["profile"]["sha256"] != ADMITTED_SOURCE_SHA256:
        raise PermissionError("This source revision has not been admitted for execution")
    contract = CapabilityRegistry().get(CAPABILITY)
    payload = request["input"]
    validate_schema(payload, contract["input_schema"])
    if len(canonical(payload)) > local_authority()["max_input_bytes"]:
        raise ValueError("Quantity input exceeds the 64 KiB execution authority")
    runtime_digest = hashlib.sha256(_trusted_runtime_source().encode("utf-8")).hexdigest()
    mission = manager.submit({"name": "HATCH Quantity (Survey)",
                              "description": "Source-backed quantity extraction from supplied plans and specifications; no drawing measurements or cost assumptions.",
                              "capabilities": [CAPABILITY]},
                             "workforce.quantity:" + request["request_id"],
                             local_authority())
    input_hash = hashlib.sha256(canonical(payload)).hexdigest()
    with manager.store.acquire_worker():
        recovered, accepted = _recover(request, mission["id"], input_hash, manager)
        if recovered:
            return recovered
        if not accepted:
            manager.store.record_event(mission["id"], "workforce.request.accepted", {
                "request_id": request["request_id"], "input_hash": input_hash,
                "runtime_sha256": runtime_digest, "profile": selected["profile"],
                "source_provenance": selected["provenance"],
            })
    manager.process(1, mission_id=mission["id"])
    with manager.store.acquire_worker():
        recovered, accepted = _recover(request, mission["id"], input_hash, manager)
        if recovered:
            return recovered
        execution = manager.run(mission["id"], CAPABILITY, payload, retain_output=True)
        return _commit_result(request, mission["id"], accepted, execution, manager)
