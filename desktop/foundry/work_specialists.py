"""Bind Work tool calls to the existing specialist compiler and its one OM.

The caller holds CommitService's worker lock. This adapter does not coordinate
workers, transition child lifecycles, export packages, or execute donor code.
Each parent step binds one exact input before child work starts. The immutable
child artifact and execution receipts survive an interrupted parent commit.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re

from .orchestration import canonical, local_authority
from .pack_compiler import validate_pack
from .repository_context import SECRET_CONTENT
from .runtime_admission import admit_runtime
from .specialists import CapabilityRegistry, CapabilityResolver, validate_schema
from .work_store import MAX_WORK_STEPS, now

ADMITTED_CAPABILITIES = ("text.analyze", "data.profile", "support.triage", "workforce.hatch.quantity", "construction.opc.inspect")
MAX_INPUT_BYTES = 65536
MAX_RESULT_BYTES = 384 * 1024
MAX_DISCOVERY_MISSIONS = 200
_ID = re.compile(r"^[0-9a-f]{32}$")
_PREFIX = "work.specialist:"
_ACCEPTED = "work.specialist.accepted"
_COMPLETED = "work.specialist.result.committed"
_REQUEST = "work.specialist.request.accepted"


def _object(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


_INPUTS = {
    "build_specialist": _object({
        "name": {"type": "string", "minLength": 1, "maxLength": 100},
        "description": {"type": "string", "maxLength": 2000},
        "capabilities": {"type": "array", "minItems": 1, "maxItems": 3,
                         "items": {"type": "string", "enum": list(ADMITTED_CAPABILITIES)}},
    }),
    "run_built_specialist": _object({
        "mission_id": {"type": "string", "minLength": 32, "maxLength": 32,
                       "description": "Copy the exact 32-character top-level mission_id from the successful build_specialist tool result. Do not use the parent Work id, artifact digest, explanatory text or a placeholder."},
        "capability_id": {"type": "string", "enum": list(ADMITTED_CAPABILITIES)},
        "input": {"type": "object", "additionalProperties": True},
    }),
}
_INPUTS["run_saved_specialist"] = deepcopy(_INPUTS["run_built_specialist"])
_INPUTS["run_saved_specialist"]["properties"]["mission_id"]["description"] = (
    "Copy the exact 32-character mission_id of the selected entry returned by list_built_specialists. "
    "Do not use the parent Work id, artifact digest, explanatory text or a placeholder.")
_INPUTS["list_built_specialists"] = {
    **_object({"limit": {"type": "integer", "minimum": 1, "maximum": 20},
               "cursor": {"type": ["string", "null"], "minLength": 32, "maxLength": 32}}), "required": []}

_SHA = {"type": "string", "minLength": 64, "maxLength": 64}
_TEXT = {"type": "string", "maxLength": 2000}
_MID = {"type": "string", "minLength": 32, "maxLength": 32}
_RECEIPT = _object({"id": {"type": "integer", "minimum": 1}, "mission_id": _MID,
                    "event_type": {"type": "string", "maxLength": 128}, "created_at": {"type": "string", "maxLength": 64},
                    "state_digest": _SHA, "previous_hash": _SHA, "hash": _SHA})
_VALIDATION = _object({"passed": {"type": "boolean"},
                       "errors": {"type": "array", "maxItems": 100, "items": _TEXT},
                       "checks": {"type": "array", "maxItems": 100, "items": _TEXT},
                       "metrics": _object({**{key: {"type": "integer", "minimum": 0} for key in
                                               ("capability_count", "fixture_count", "fixtures_passed", "artifact_bytes", "runtime_bytes")},
                                           "fixture_pass_rate": {"type": "number", "minimum": 0, "maximum": 1},
                                           "reproducible": {"type": "boolean"}})})
# Optional for pre-admission receipts; new validation records identify the exact
# runtime while existing immutable results remain schema-compatible.
_VALIDATION["properties"]["runtime"] = _object({"id": _TEXT, "sha256": _SHA})
_ARTIFACT_VALIDATION = deepcopy(_VALIDATION)
_ARTIFACT_VALIDATION["properties"].update(artifact_digest=_SHA, independent_validation=_VALIDATION)
_ARTIFACT_VALIDATION["required"].extend(["artifact_digest", "independent_validation"])
_SELECTION = _object({"source_parent_work_id": _MID, "artifact_digest": _SHA, "reason": _TEXT,
                      "build_accepted_receipt": _RECEIPT, "build_result_receipt": _RECEIPT})
_DISCOVERY_SCHEMA = _object({
    "schema": {"type": "string", "enum": ["yur.work-specialist-catalog.v1"]},
    "tool": {"type": "string", "enum": ["list_built_specialists"]}, "status": {"type": "string", "enum": ["completed"]},
    "committed": {"type": "boolean", "enum": [False]},
    "entries": {"type": "array", "maxItems": 20, "items": _object({
        "mission_id": _MID, "name": {"type": "string", "maxLength": 100},
        "capabilities": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "string", "enum": list(ADMITTED_CAPABILITIES)}},
        "artifact_digest": _SHA, "source_parent_work_id": _MID, "created_at": {"type": "string", "maxLength": 64},
        "lifecycle": _object({"mission_status": {"type": "string", "enum": ["completed"]},
                              "origin_work_status": {"type": "string", "maxLength": 40},
                              "concept_stage": {"type": ["string", "null"], "maxLength": 80}}),
        "evidence": _object({"validation": {"type": "string", "enum": ["independent-fixed-outcome-fixtures"]},
                             "fixtures_passed": {"type": "integer", "minimum": 0},
                             "build_result_hash": _SHA})})},
    "scanned": {"type": "integer", "minimum": 0, "maximum": MAX_DISCOVERY_MISSIONS},
    "excluded": {"type": "integer", "minimum": 0, "maximum": MAX_DISCOVERY_MISSIONS},
    "next_cursor": {"type": ["string", "null"], "minLength": 32, "maxLength": 32},
    "coverage_limited": {"type": "boolean"},
    "provenance": _object({"parent_work_id": _MID, "input_hash": _SHA, "reason": _TEXT}),
})


def _result_schema(tool, capability_id=None, runtime=None):
    if tool == "list_built_specialists":
        return deepcopy(_DISCOVERY_SCHEMA)
    properties = {
        "schema": {"type": "string", "enum": ["yur.work-specialist-result.v1"]},
        "tool": {"type": "string", "enum": [tool]}, "status": {"type": "string", "enum": ["completed"]},
        "committed": {"type": "boolean", "enum": [True]}, "mission_id": _MID,
        "provenance": _object({"operation_key": {"type": "string", "maxLength": 200}, "parent_work_id": _MID,
                               "parent_request_id": {"type": "string", "maxLength": 36},
                               "step_index": {"type": "integer", "minimum": 0, "maximum": MAX_WORK_STEPS - 1}, "input_hash": _SHA,
                               "accepted_receipt": _RECEIPT, "result_receipt": _RECEIPT}),
    }
    if tool == "build_specialist":
        properties.update(name={"type": "string", "maxLength": 100},
                          capabilities={"type": "array", "maxItems": 3, "items": _object({
                              "id": {"type": "string", "enum": list(ADMITTED_CAPABILITIES)}, "selection_reason": _TEXT})},
                          artifact=_object({"digest": _SHA, "files": {"type": "array", "maxItems": 7, "items": {"type": "string", "maxLength": 128}},
                                            "bytes": {"type": "integer", "minimum": 1, "maximum": 5_000_000},
                                            "validation": _ARTIFACT_VALIDATION,
                                            "selection": _object({"strategy": {"type": "string", "enum": ["balanced", "precision"]},
                                                                  "digest": _SHA, "reason": _TEXT, "quality_claim": _TEXT,
                                                                  "candidate_count": {"type": "integer", "minimum": 1, "maximum": 2},
                                                                  "pareto_frontier": {"type": "array", "maxItems": 2, "items": _SHA}})}))
    else:
        properties.update(capability_id={"type": "string", "enum": list(ADMITTED_CAPABILITIES)}, run_id=_MID,
                          output=(runtime.resolve([capability_id])[0] if runtime else CapabilityRegistry().get(capability_id))["output_schema"] if capability_id else {"type": "object", "additionalProperties": True},
                          execution_receipt=_RECEIPT)
        if tool == "run_saved_specialist":
            properties["selection"] = _SELECTION
    schema = _object(properties)
    if tool != "build_specialist":
        schema["properties"]["runtime_sha256"] = _SHA
    return deepcopy(schema)


def catalog():
    """Discovery advertises admitted behavior; it never grants authority."""
    registry = CapabilityRegistry()
    capabilities = [{key: value for key, value in registry.get(cid).items() if key != "fixtures"}
                    for cid in ADMITTED_CAPABILITIES]
    descriptions = {
        "build_specialist": "Build and independently validate two deterministic specialist candidates under YUR's existing factory, then commit the selected executable package. Choose 1..3 admitted capabilities; no new arbitrary handler is generated, and no package is exported.",
        "run_built_specialist": "Execute one capability bound in a specialist built by this Work mission, on new typed input. Wait for build_specialist to succeed, then copy its top-level mission_id exactly into this call. Returns actual output and committed execution receipt; no network or external action.",
        "list_built_specialists": "Discover up to 20 previously committed local specialists with verified original Work build evidence. Optional cursor resumes a bounded scan of up to 200 factory missions. Returns names, admitted capabilities, package hashes and lifecycle evidence only.",
        "run_saved_specialist": "Reuse one exact previously committed local Work specialist in this mission. Its original build, admitted pure capability and package digest are verified before new input executes under YUR; returns actual output and selection/execution receipts.",
    }
    result = []
    for name, schema in _INPUTS.items():
        result.append({"name": name, "description": descriptions[name], "input_schema": deepcopy(schema),
                       "output_schema": _result_schema(name), "capabilities": deepcopy(capabilities),
                       "permissions": ["read"] if name == "list_built_specialists" else ["compute", "commit-artifact"],
                       "runtime": {"language": "python", "dependencies": [], "network": False, "subprocess": False,
                                   "authority": "OrchestrationManager / CommitService"},
                       "trust": {"source": "audited-local", "health": "available", "validation": "independent-fixed-outcome-fixtures"},
                       "limits": {"input_bytes": MAX_INPUT_BYTES, "result_bytes": MAX_RESULT_BYTES, "max_capabilities_per_pack": 3},
                       "rollback": {"behavior": "no durable mutation" if name == "list_built_specialists" else "immutable child package and receipts retained; no filesystem export"}})
    return result


def _digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _receipt(event):
    return {key: value for key, value in event.items() if key != "data"}


def _safe_json(value):
    def visit(item, depth=0):
        if depth > 12:
            raise ValueError("Specialist input exceeds its nesting limit")
        if isinstance(item, dict):
            if len(item) > 128 or any(not isinstance(key, str) for key in item):
                raise ValueError("Specialist objects require bounded string keys")
            for child in item.values():
                visit(child, depth + 1)
        elif isinstance(item, list):
            if len(item) > 1000:
                raise ValueError("Specialist arrays exceed 1000 items")
            for child in item:
                visit(child, depth + 1)
        elif item is not None and type(item) not in (str, int, float, bool):
            raise ValueError("Specialist input must contain only JSON values")
    visit(value)
    try:
        encoded = canonical(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("Specialist input must be finite JSON") from exc
    if len(encoded) > MAX_INPUT_BYTES:
        raise ValueError("Specialist input exceeds 64 KiB")
    if SECRET_CONTENT.search(encoded.decode("utf-8")):
        raise ValueError("Specialist input contains credential-like material")
    return json.loads(encoded)


def _work(manager, supplied):
    if getattr(manager.store, "_lock_file", None) is None:
        raise RuntimeError("Specialist tools require the existing exclusive Work worker lock")
    if not isinstance(supplied, dict) or not isinstance(supplied.get("id"), str) or not _ID.fullmatch(supplied["id"]):
        raise ValueError("A committed parent Work mission is required")
    current = manager.store.get_work(supplied["id"])
    if (current["status"] != "running" or current["revision"] != supplied.get("revision")
            or current["steps"] != supplied.get("steps")):
        raise ValueError("Parent Work changed or is not running; reload its current revision")
    authority = current["authority"]
    from .work_desktop import AUTHORITY as FRANKLIN_AUTHORITY
    if (authority != FRANKLIN_AUTHORITY and (authority.get("issuer") != "local-user" or authority.get("scope") != "work-proposals"
            or not {"compute", "commit-artifact"}.issubset(authority.get("actions", [])))):
        raise ValueError("Parent Work does not authorize specialist computation and artifact commitment")
    if len(current["steps"]) >= authority["max_steps"]:
        raise ValueError("Parent Work exhausted its step budget")
    return current


def _children(manager, parent):
    return [child for index in range(len(parent["steps"]) + 1)
            if (child := manager.store.get_mission_by_key(f"{_PREFIX}{parent['id']}:{index}")) is not None]


def _parent_selection(manager, parent):
    key = f"{_PREFIX}{parent['id']}:{len(parent['steps'])}"
    matches = [event for event in manager.store.work_events(parent["id"])
               if event["event_type"] == "work.specialist.selected"
               and event["data"]["change"].get("operation_key") == key]
    if len(matches) > 1:
        raise ValueError("Parent specialist step has conflicting selection records")
    return matches[0]["data"]["change"] if matches else None


def _parent_request(manager, parent):
    key = f"{_PREFIX}{parent['id']}:{len(parent['steps'])}"
    matches = [event for event in manager.store.work_events(parent["id"])
               if event["event_type"] == _REQUEST and event["data"]["change"].get("operation_key") == key]
    if len(matches) > 1:
        raise ValueError("Parent specialist step has conflicting request records")
    return matches[0] if matches else None


def pending_call(manager, parent):
    """Recover newly retained exact input; never infer legacy run payloads."""
    event = _parent_request(manager, parent)
    if event is None:
        return None
    binding = event["data"]["change"]
    tool, args = binding["tool"], _safe_json(binding["arguments"])
    if (tool not in _INPUTS or tool == "list_built_specialists"
            or binding["parent_work_id"] != parent["id"]
            or binding["parent_request_id"] != parent["request_id"]
            or binding["step_index"] != len(parent["steps"])
            or binding["input_hash"] != _digest(args)):
        raise RuntimeError("Retained specialist request identity or input differs")
    envelope = {**args, "input": {}} if tool in {"run_built_specialist", "run_saved_specialist"} and isinstance(args.get("input"), dict) else args
    validate_schema(envelope, _INPUTS[tool], "retained request")
    return {"function": {"name": tool, "arguments": args}}


def check_step_binding(manager, parent, tool, arguments):
    """The Work strategy calls this for every tool before dispatching a retry."""
    request = _parent_request(manager, parent)
    if request and (request["data"]["change"]["tool"] != tool or request["data"]["change"]["input_hash"] != _digest(arguments)):
        raise ValueError("Work specialist step is already bound to different input or tool")
    selected = _parent_selection(manager, parent)
    if selected and (selected.get("tool") != tool or selected.get("input_hash") != _digest(arguments)):
        raise ValueError("Work specialist step is already bound to different input or tool")
    return selected


def _accept_parent_request(manager, parent, tool, args):
    change = {"operation_key": f"{_PREFIX}{parent['id']}:{len(parent['steps'])}",
              "tool": tool, "input_hash": _digest(args), "arguments": deepcopy(args),
              "parent_work_id": parent["id"], "parent_request_id": parent["request_id"],
              "step_index": len(parent["steps"])}
    existing = _parent_request(manager, parent)
    if existing:
        if existing["data"]["change"] != change:
            raise ValueError("Retained specialist request differs from its exact input")
        return parent
    document = {key: deepcopy(value) for key, value in parent.items() if key not in {"revision", "receipt"}}
    document["updated_at"] = now()
    try:
        return manager.store.commit_work_checkpoint(document, parent["revision"], _REQUEST, change)
    except (ValueError, OSError, TypeError, KeyError) as error:
        try:
            retained = _parent_request(manager, parent)
        except Exception as resolution_error:
            raise RuntimeError("Specialist request acknowledgment is uncertain; resume the same Work request") from resolution_error
        if retained is not None:
            raise RuntimeError("Specialist request was retained; resume the same Work request") from error
        raise


def _select_parent(manager, parent, key, tool, input_hash, child, selection):
    current = _parent_selection(manager, parent)
    change = {"operation_key": key, "tool": tool, "input_hash": input_hash,
              "mission_id": child["id"], "selection": selection}
    if current:
        if current != change:
            raise ValueError("Parent Work selection differs from its committed specialist binding")
        return parent
    document = {key: value for key, value in parent.items() if key not in {"revision", "receipt"}}
    document["updated_at"] = now()
    return manager.store.commit_work_checkpoint(document, parent["revision"], "work.specialist.selected", change)


def _saved_origin(manager, mission_id):
    """Verify the concrete original build, without returning source or context."""
    if not isinstance(mission_id, str) or not _ID.fullmatch(mission_id):
        raise ValueError("Saved specialist requires an exact child mission identifier")
    child = manager.store.get_mission(mission_id)
    if not child or child["status"] != "completed" or child["authority"] != local_authority():
        raise ValueError("Saved specialist requires a completed local generated pack")
    capabilities = child["spec"].get("capabilities")
    if (not isinstance(capabilities, list) or not 1 <= len(capabilities) <= 3
            or any(capability not in ADMITTED_CAPABILITIES for capability in capabilities)):
        raise ValueError("Saved specialist contains an unadmitted capability")
    events = manager.store.events(mission_id)
    builds = [event for event in events if event["event_type"] == _ACCEPTED
              and event["data"].get("tool") == "build_specialist"]
    if len(builds) != 1:
        raise ValueError("Saved specialist has no unique original Work build")
    accepted = builds[0]
    binding = accepted["data"]
    index = binding.get("step_index")
    if type(index) is not int or not 0 <= index < 20:
        raise ValueError("Saved specialist original step identity is invalid")
    parent = manager.store.get_work(binding["parent_work_id"])
    original_key = f"{_PREFIX}{parent['id']}:{index}"
    keyed_child = manager.store.get_mission_by_key(original_key)
    if (binding["child_mission_id"] != mission_id or binding["operation_key"] != original_key
            or binding["parent_request_id"] != parent["request_id"] or binding["conversation_id"] != parent["conversation_id"]
            or keyed_child is None or keyed_child["id"] != mission_id):
        raise ValueError("Saved specialist original authority binding differs")
    commits = [event for event in events if event["event_type"] == _COMPLETED
               and event["data"].get("operation_key") == original_key]
    if len(commits) != 1:
        raise ValueError("Saved specialist original result was not committed")
    built = _result(commits[0])
    if index >= len(parent["steps"]):
        raise ValueError("Saved specialist lacks a committed original parent build step")
    step = parent["steps"][index]
    if (step.get("tool") != "build_specialist" or step.get("succeeded") is not True or step.get("result") != built
            or _digest(step["arguments"]) != binding["input_hash"] or built["provenance"]["accepted_receipt"] != _receipt(accepted)):
        raise ValueError("Saved specialist original parent build evidence differs")
    artifact = manager.store.get_artifact(mission_id)
    if (artifact is None or artifact["digest"] != built["artifact"]["digest"]
            or artifact["validation"].get("passed") is not True
            or artifact["validation"].get("independent_validation", {}).get("passed") is not True):
        raise ValueError("Saved specialist package differs from independently validated build evidence")
    admit_runtime(artifact["files"]["runtime.py"]).resolve(capabilities)
    selection = {"source_parent_work_id": parent["id"], "artifact_digest": artifact["digest"],
                 "reason": "Exact saved mission identifier matched a committed local Work build and its admitted pure capability package.",
                 "build_accepted_receipt": _receipt(accepted), "build_result_receipt": _receipt(commits[0])}
    return child, artifact, parent, selection


def list_saved_specialists(manager, arguments):
    """Read-only desktop catalog; no conversation or fake parent mission needed."""
    validate_schema(arguments, _INPUTS['list_built_specialists'], 'discovery')
    manager.store.verify_integrity()
    limit, cursor = arguments.get("limit", 20), arguments.get("cursor")
    page = manager.store.list_missions_page(MAX_DISCOVERY_MISSIONS, cursor)
    entries, scanned, excluded, next_cursor = [], 0, 0, None
    for index, summary in enumerate(page["missions"]):
        scanned += 1
        if not summary["idempotency_key"].startswith(_PREFIX) or summary["status"] != "completed":
            excluded += 1
        else:
            try:
                child, artifact, origin, selection = _saved_origin(manager, summary["id"])
                validation = validate_pack(artifact["files"])
                if not validation["passed"]:
                    raise ValueError("Saved package is not admitted by this runtime release")
                entries.append({"mission_id": child["id"], "name": child["spec"]["name"],
                                "capabilities": child["spec"]["capabilities"], "artifact_digest": artifact["digest"],
                                "source_parent_work_id": origin["id"], "created_at": child["created_at"],
                                "lifecycle": {"mission_status": child["status"], "origin_work_status": origin["status"],
                                              "concept_stage": child["data"].get("concept_stage")},
                                "evidence": {"validation": "independent-fixed-outcome-fixtures",
                                             "fixtures_passed": validation["metrics"]["fixtures_passed"],
                                             "build_result_hash": selection["build_result_receipt"]["hash"]}})
            except (ValueError, KeyError, TypeError):
                excluded += 1
        if len(entries) >= limit:
            if index + 1 < len(page["missions"]) or page["next_cursor"] is not None:
                next_cursor = summary["id"]
            break
    else:
        next_cursor = page["next_cursor"]
    return {"entries": entries, "scanned": scanned, "excluded": excluded, "next_cursor": next_cursor,
            "coverage_limited": next_cursor is not None}


def _discover(manager, parent, arguments):
    discovery = list_saved_specialists(manager, arguments)
    result = {"schema": "yur.work-specialist-catalog.v1", "tool": "list_built_specialists", "status": "completed", "committed": False,
              **discovery,
              "provenance": {"parent_work_id": parent["id"], "input_hash": _digest(arguments),
                             "reason": "Bounded local factory metadata scan; entries require original Work build and current fixed-outcome validation."}}
    validate_schema(result, _DISCOVERY_SCHEMA)
    if len(canonical(result)) > 65536:
        raise ValueError("Saved specialist discovery exceeded 64 KiB")
    return result


def _binding(manager, children, operation_key, tool, input_hash):
    found = None
    for child in children:
        for event in manager.store.events(child["id"]):
            if event["event_type"] == _ACCEPTED and event["data"].get("operation_key") == operation_key:
                data = event["data"]
                if data.get("tool") != tool or data.get("input_hash") != input_hash:
                    raise ValueError("Work specialist step is already bound to different input or tool")
                if found is not None:
                    raise ValueError("Work specialist step has conflicting child bindings")
                found = event
    return found


def _recovered(manager, child_id, accepted):
    for event in manager.store.events(child_id):
        if event["event_type"] == _COMPLETED and event["data"].get("operation_key") == accepted["data"]["operation_key"]:
            if event["data"].get("input_hash") != accepted["data"]["input_hash"]:
                raise ValueError("Committed specialist result input binding differs")
            runtime = None
            if event["data"]["result"]["tool"] != "build_specialist":
                runtime = admit_runtime(manager.store.get_artifact(child_id)["files"]["runtime.py"])
            return _result(event, runtime)
    return None


def _result(event, runtime=None):
    result = deepcopy(event["data"]["result"])
    result["provenance"]["result_receipt"] = _receipt(event)
    if runtime and result.get("runtime_sha256", runtime.sha256) != runtime.sha256:
        raise ValueError("Specialist result runtime differs from its committed package")
    validate_schema(result, _result_schema(result["tool"], result.get("capability_id"), runtime), "result")
    return result


def _accept(manager, parent, child, key, tool, input_hash, selection=None):
    return manager.store.record_event(child["id"], _ACCEPTED, {
        "operation_key": key, "tool": tool, "input_hash": input_hash, "parent_work_id": parent["id"],
        "parent_request_id": parent["request_id"], "conversation_id": parent["conversation_id"],
        "step_index": len(parent["steps"]), "child_mission_id": child["id"],
        "authority_source": "committed-parent-work:compute,commit-artifact",
        **({"selection": selection} if selection is not None else {}),
    })


def _commit_result(manager, accepted, content):
    binding = accepted["data"]
    result = {"schema": "yur.work-specialist-result.v1", "tool": binding["tool"], "status": "completed",
              "committed": True, "mission_id": binding["child_mission_id"], **content,
              "provenance": {key: binding[key] for key in ("operation_key", "parent_work_id", "parent_request_id", "step_index", "input_hash")}}
    result["provenance"]["accepted_receipt"] = _receipt(accepted)
    if len(canonical(result)) > MAX_RESULT_BYTES:
        raise ValueError(f"Committed specialist result exceeds Work context budget; inspect child {binding['child_mission_id']}")
    runtime = None
    if result["tool"] != "build_specialist":
        runtime = admit_runtime(manager.store.get_artifact(binding["child_mission_id"])["files"]["runtime.py"])
    schema = _result_schema(result["tool"], result.get("capability_id"), runtime)
    schema["properties"]["provenance"]["required"].remove("result_receipt")
    validate_schema(result, schema, "result")
    event = manager.store.record_event(binding["child_mission_id"], _COMPLETED,
                                      {"operation_key": binding["operation_key"], "input_hash": binding["input_hash"], "result": result})
    return _result(event, runtime)


def _durable_action(manager, parent, tool, args):
    """Resolve actual child admission/publication or completed execution."""
    key = f"{_PREFIX}{parent['id']}:{len(parent['steps'])}"
    if tool != "build_specialist" and not _ID.fullmatch(args["mission_id"]):
        return False
    with manager.store._read_transaction():
        child = (manager.store.get_mission_by_key(key) if tool == "build_specialist"
                 else manager.store.get_mission(args["mission_id"]))
        if child is None:
            return False
        events = manager.store.events(child["id"])
        if tool == "build_specialist":
            request = _parent_request(manager, parent)
            if request is not None:
                binding = request["data"]["change"]
                if (child["spec"] != args or child["authority"] != local_authority()
                        or any(binding.get(field) != expected for field, expected in {
                            "operation_key": key, "parent_work_id": parent["id"],
                            "parent_request_id": parent["request_id"], "tool": tool,
                            "step_index": len(parent["steps"]), "input_hash": _digest(args),
                            "arguments": args}.items())):
                    raise ValueError("Admitted specialist child differs from its retained parent request")
                # A lost submit/accept acknowledgment must not orphan a queued
                # executable child. Failed validation remains a finite rejection.
                if child["status"] in {"queued", "running", "validating"} or manager.store.get_artifact(child["id"]) is not None:
                    return True
        accepted = [event for event in events if event["event_type"] == _ACCEPTED and event["data"].get("operation_key") == key]
        if not accepted:
            return False
        if len(accepted) != 1 or any(accepted[0]["data"].get(field) != expected for field, expected in {
                "parent_work_id": parent["id"], "parent_request_id": parent["request_id"],
                "tool": tool, "input_hash": _digest(args), "child_mission_id": child["id"]}.items()):
            raise ValueError("Specialist durable action has conflicting ownership or input")
        if any(event["event_type"] == _COMPLETED and event["data"].get("operation_key") == key for event in events):
            return True
        if tool == "build_specialist":
            return manager.store.get_artifact(child["id"]) is not None
        completed = [event for event in events if event["event_type"] == "execution.completed" and event["data"].get("execution_key") == key]
        if completed and any(event["data"].get("capability_id") != args["capability_id"] or event["data"].get("input_hash") != _digest(args["input"]) for event in completed):
            raise ValueError("Specialist execution acknowledgment has different input")
        return bool(completed)


def execute(manager, workmission, tool, args):
    """Run under OM's held lock. Saved reuse can commit a parent selection;
    the caller reloads that revision before committing the normal tool result.
    """
    if tool not in _INPUTS:
        raise ValueError("Unknown specialist creation tool")
    args = _safe_json(args)
    schema = deepcopy(_INPUTS[tool])
    envelope = args
    if tool in {"run_built_specialist", "run_saved_specialist"} and isinstance(args, dict) and isinstance(args.get("input"), dict):
        # Check the outer tool contract now. Nested capability input is checked
        # below using the selected artifact's revision, never today's registry.
        envelope = {**args, "input": {}}
    validate_schema(envelope, schema, "arguments")
    parent = _work(manager, workmission)
    check_step_binding(manager, parent, tool, args)
    if tool == "list_built_specialists":
        return _discover(manager, parent, args)
    try:
        return _execute_mutation(manager, parent, tool, args)
    except (ValueError, OSError, TypeError, KeyError) as error:
        try:
            committed = _durable_action(manager, parent, tool, args)
        except Exception as resolution_error:
            raise RuntimeError("Specialist acknowledgment is uncertain; resume this Work request to resolve its retained action") from resolution_error
        if committed:
            raise RuntimeError("Specialist work was admitted or completed but its acknowledgment was interrupted; resume this Work request") from error
        raise


def _execute_mutation(manager, parent, tool, args):
    key = f"{_PREFIX}{parent['id']}:{len(parent['steps'])}"
    input_hash = _digest(args)
    children = _children(manager, parent)
    accepted = _binding(manager, children, key, tool, input_hash)
    if tool == "build_specialist":
        # Preserve exact input binding despite the compiler's whitespace cleanup.
        if args["name"] != args["name"].strip() or args["description"] != args["description"].strip():
            raise ValueError("Specialist name and description cannot have surrounding whitespace")
        resolved = CapabilityResolver().resolve(args["capabilities"])
        parent = _accept_parent_request(manager, parent, tool, args)
        child = manager.submit(args, key, local_authority())
        if accepted is not None and accepted["data"]["child_mission_id"] != child["id"]:
            raise ValueError("Work specialist child binding changed")
        accepted = accepted or _accept(manager, parent, child, key, tool, input_hash)
        recovered = _recovered(manager, child["id"], accepted)
        if recovered is not None:
            return recovered
        manager.process_locked_child(child["id"])
        child = manager.store.get_mission(child["id"])
        artifact = manager.store.get_artifact(child["id"])
        if child["status"] != "completed" or artifact is None:
            raise ValueError(f"Specialist child {child['id']} did not pass publication ({child['status']})")
        return _commit_result(manager, accepted, {
            "name": child["spec"]["name"],
            "capabilities": [{key: entry[key] for key in ("id", "selection_reason")} for entry in resolved],
            "artifact": {"digest": artifact["digest"], "files": sorted(artifact["files"]),
                         "bytes": sum(len(value.encode("utf-8")) for value in artifact["files"].values()),
                         "validation": artifact["validation"], "selection": artifact["selection"]},
        })

    if not _ID.fullmatch(args["mission_id"]):
        raise ValueError("Built specialist requires an exact child mission identifier")
    selection = None
    if tool == "run_saved_specialist":
        child, _artifact, _origin, selection = _saved_origin(manager, args["mission_id"])
        if child["id"] not in {item["id"] for item in children}:
            children.append(child)
        accepted = _binding(manager, children, key, tool, input_hash)
    else:
        child = next((item for item in children if item["id"] == args["mission_id"]), None)
        if child is None or not any(event["event_type"] == _ACCEPTED and event["data"].get("tool") == "build_specialist"
                                    and event["data"].get("parent_work_id") == parent["id"] for event in manager.store.events(child["id"])):
            raise ValueError("Specialist must have been built by this parent Work mission")
    if accepted is not None and accepted["data"]["child_mission_id"] != child["id"]:
        raise ValueError("Work specialist step cannot change its child mission")
    if args["capability_id"] not in child["spec"]["capabilities"]:
        raise ValueError("Capability is not bound to the selected built specialist")
    runtime = admit_runtime(manager.store.get_artifact(child["id"])["files"]["runtime.py"])
    selected = runtime.resolve([args["capability_id"]])[0]
    runtime.validate_schema(args["input"], selected["input_schema"], "input")
    parent = _accept_parent_request(manager, parent, tool, args)
    if selection is not None:
        parent = _select_parent(manager, parent, key, tool, input_hash, child, selection)
    accepted = accepted or _accept(manager, parent, child, key, tool, input_hash, selection)
    recovered = _recovered(manager, child["id"], accepted)
    if recovered is not None:
        return recovered
    execution = manager.run(child["id"], args["capability_id"], args["input"], retain_output=True, execution_key=key)
    runtime.validate_schema(execution["output"], selected["output_schema"], "output")
    return _commit_result(manager, accepted, {"capability_id": args["capability_id"], "run_id": execution["run_id"],
                                           "output": execution["output"], "execution_receipt": _receipt(execution["receipt"]),
                                           "runtime_sha256": runtime.sha256,
                                           **({"selection": selection} if selection is not None else {})})
