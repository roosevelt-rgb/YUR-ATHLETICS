"""One local Work RPC per process; state and coordination stay in existing core."""
from __future__ import annotations

import errno
import json
import os
import re
import sqlite3
import sys
import uuid

from .commit_service import CommitService
from .conversation_cli import _object, state_root
from .orchestration import OrchestrationManager
from .work_engine import validate_request
from .work_provider import create_model_adapter, DEFAULT_OLLAMA_URL, UnsupportedWorkProvider

MAX_INPUT_BYTES = 256 * 1024 + 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024


def _worker_busy(error):
    """Type only the canonical OS-lock contention, never a worker's error text."""
    if (type(error) is not RuntimeError
            or str(error) != "Another factory worker owns the exclusive worker lock"
            or not isinstance(error.__cause__, OSError)
            or error.__cause__.errno not in {errno.EACCES, errno.EAGAIN}):
        return False
    frame = error.__traceback__
    while frame is not None and frame.tb_next is not None:
        frame = frame.tb_next
    return frame is not None and frame.tb_frame.f_code is CommitService.acquire_worker.__wrapped__.__code__


def _uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Conversation ID must be a canonical UUID")


def validate_rpc(request):
    if isinstance(request, dict) and isinstance(request.get("command"), str) and request["command"].startswith("concept_"):
        from .concept_rpc import validate
        return validate(request)
    if isinstance(request, dict) and isinstance(request.get("command"), str) and request["command"].startswith("lifecycle_"):
        from .lifecycle_rpc import validate as validate_lifecycle
        validate_lifecycle(request)
        if len(json.dumps(request, ensure_ascii=False, allow_nan=False).encode()) > MAX_INPUT_BYTES:
            raise ValueError("Lifecycle RPC exceeds its input budget")
        return request
    if isinstance(request, dict) and isinstance(request.get("command"), str) and request["command"].startswith(("ship_", "pulse_", "organism_")):
        from .organism_rpc import validate as validate_organism
        return validate_organism(request)
    if isinstance(request, dict) and isinstance(request.get("command"), str) and request["command"].startswith("schedule_"):
        from .schedule_rpc import validate
        validate(request)
        if len(json.dumps(request, ensure_ascii=False, allow_nan=False).encode()) > MAX_INPUT_BYTES:
            raise ValueError("Schedule RPC exceeds its input budget")
        return request
    fields = {"start": {"command", "request"}, "cancel_request": {"command", "request"},
              "steer": {"command", "mission_id", "conversation_id", "correction_id", "text"},
              "list_saved_specialists": {"command", "limit", "cursor"},
              "list_generated_specialists": {"command", "limit", "cursor"},
              "list": {"command", "conversation_id"}, "inspect": {"command", "mission_id"}, "cancel": {"command", "mission_id"},
              "validate_delivery": {"command", "mission_id", "artifact_id"}, "deliver": {"command", "mission_id", "artifact_id", "validation_token"},
              **{command: {"command", "mission_id", "specialist_id"} for command in ("inspect_specialist", "export_specialist", "reveal_specialist")}}
    if not isinstance(request, dict) or not isinstance(request.get("command"), str) or request["command"] not in fields or set(request) != fields[request["command"]]:
        raise ValueError("Invalid Work RPC fields")
    if request["command"] in {"start", "cancel_request"}:
        validate_request(request["request"])
    elif request["command"] == "list_saved_specialists":
        if type(request["limit"]) is not int or not 1 <= request["limit"] <= 20 or (request["cursor"] is not None and (not isinstance(request["cursor"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["cursor"]))):
            raise ValueError("Saved specialist discovery requires a bounded page and cursor")
    elif request['command'] == 'list_generated_specialists':
        if type(request['limit']) is not int or not 1 <= request['limit'] <= 20 or (request['cursor'] is not None and (not isinstance(request['cursor'], str) or not re.fullmatch(r'[0-9a-f]{32}:(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])', request['cursor']))):
            raise ValueError('Generated specialist discovery requires a bounded page and publication cursor')
    elif request["command"] == "list":
        if request["conversation_id"] is not None:
            _uuid(request["conversation_id"])
    elif not isinstance(request["mission_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["mission_id"]):
        raise ValueError("Work mission ID must be 32 lowercase hexadecimal characters")
    if request['command'] == 'steer':
        _uuid(request['conversation_id']); _uuid(request['correction_id'])
        if not isinstance(request['text'], str) or not request['text'].strip() or len(request['text']) > 8000 or len(request['text'].encode('utf-8')) > 32000:
            raise ValueError('A correction requires 1..8000 characters of text within 32 KiB')
    if request["command"] in {"validate_delivery", "deliver"}:
        if not isinstance(request["artifact_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["artifact_id"]):
            raise ValueError("Work artifact ID must be 32 lowercase hexadecimal characters")
        if request["command"] == "deliver" and (not isinstance(request["validation_token"], str) or not re.fullmatch(r"[0-9a-f]{64}", request["validation_token"])):
            raise ValueError("Delivery requires the exact validation token")
    if request["command"].endswith("_specialist") and (not isinstance(request["specialist_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["specialist_id"])):
        raise ValueError("Specialist identifier must be 32 lowercase hexadecimal characters")
    if len(json.dumps(request, ensure_ascii=False, allow_nan=False).encode()) > MAX_INPUT_BYTES:
        raise ValueError("Work RPC exceeds the input byte budget")
    return request


def _summary(mission):
    return {**{key: mission[key] for key in ("id", "request_id", "conversation_id", "status", "created_at", "updated_at", "revision")},
            "mode": mission["request"]["mode"], "goal": mission["request"]["goal"][:500], "root": mission["request"]["root"],
            "provider": mission["request"]["provider"], "model": mission["request"]["model"], "answer": mission["answer"][:500],
            "error": mission["error"][:500], "step_count": len(mission["steps"]),
            "artifacts": [{"id": artifact["id"], "status": artifact["status"], "kind": artifact["proposal"]["kind"],
                           "name": artifact["proposal"].get("name", artifact["proposal"].get("path"))} for artifact in mission["artifacts"]]}


def _event_summaries(events):
    summaries = []
    for event in events:
        change = event['data'].get('change', {})
        if event['event_type'].startswith('work.generated.'):
            # Acceptance cases, candidate source and raw cell streams remain in
            # the journal; model-facing summaries contain identity and receipts.
            change = {key: change[key] for key in ('step_index', 'tool', 'input_hash', 'cell_key', 'strategy',
                       'case_id', 'passed', 'artifact_sha256', 'contract_sha256', 'snapshot_id',
                       'accepted_receipt', 'snapshot_receipt', 'cell_receipt') if key in change}
            change['content'] = 'omitted-from-summary'
        elif event['event_type'].startswith('work.browser.'):
            change = {key: value for key, value in change.items() if key not in {'result', 'context', 'reply'}}
            change['result_output'] = 'available-in-mission-step'
        elif event['event_type'] == 'work.cell.snapshot.committed':
            snapshot = change['snapshot']
            change = {**change, 'snapshot': {**snapshot, 'files': [
                {key: value for key, value in item.items() if key != 'content'} for item in snapshot['files']]},
                'snapshot_content': 'omitted-from-summary'}
        elif event['event_type'] == 'work.cell.result.committed':
            result = change['result']
            change = {**change, 'result': {**result, 'execution': {
                key: value for key, value in result['execution'].items() if key not in {'stdout', 'stderr'}}},
                'result_output': 'available-in-mission-step'}
        elif event['event_type'] == 'work.concept.result.committed':
            result = change['result']
            change = {key: value for key, value in change.items() if key != 'result'}
            change.update(result_summary={key: result[key] for key in ('schema', 'tool', 'status', 'committed')},
                          result_output='available-in-mission-step')
        summaries.append({**{key: value for key, value in event.items() if key != 'data'}, 'change': change})
    return summaries


def handle(request, on_event=lambda event: None, *, acquire_page=None):
    request = validate_rpc(request)
    root = state_root()
    if root.exists() and not root.is_dir():
        raise ValueError("Work state root must be a directory")
    if request["command"].startswith("lifecycle_"):
        from .lifecycle_rpc import STATELESS, empty_result, handle_stateless
        if request["command"] in STATELESS:
            return handle_stateless(root, request)
        if not (root / "foundry.sqlite3").exists():
            empty = empty_result(request["command"])
            if empty is not None:
                return empty
    if request["command"].startswith(("ship_", "pulse_", "organism_")) and not (root / "foundry.sqlite3").exists():
        from .organism_rpc import empty_result as organism_empty
        empty = organism_empty(request["command"])
        if empty is not None:
            return empty
    if not (root / "foundry.sqlite3").exists():
        if request["command"].startswith("concept_"):
            from .concept_rpc import handle as concept_handle
            return concept_handle(None, request)
        if request["command"] in {"list_saved_specialists", "list_generated_specialists"}:
            return {"entries": [], "scanned": 0, "excluded": 0, "next_cursor": None, "coverage_limited": False}
        if request["command"] == "schedule_list":
            return {"schedules": []}
        if request["command"] == "schedule_claim":
            return {"claims": []}
        if request["command"] == "list":
            return {"missions": []}
        if request["command"] in {"inspect", "cancel", "validate_delivery", "deliver", "steer"}:
            raise ValueError("Work mission not found")
    # Reject the unsupported provider before creating any state.
    if request["command"] == "start" and request["request"]["provider"] != "ollama":
        raise UnsupportedWorkProvider("Foundry Work is unavailable until the selected service exposes a verified tool-call contract; choose an Ollama model or regular chat")
    with CommitService(root) as store:
        if request["command"].startswith("concept_"):
            from .concept_rpc import handle as concept_handle
            return concept_handle(store, request)
        manager = OrchestrationManager(store)
        if request['command'] == 'list_generated_specialists':
            from .work_generated import list_generated_specialists
            return list_generated_specialists(manager, {'limit': request['limit'], 'cursor': request['cursor']})
        if request["command"] == "list_saved_specialists":
            from .work_specialists import list_saved_specialists
            return list_saved_specialists(manager, {"limit": request["limit"], "cursor": request["cursor"]})
        if request["command"].startswith("lifecycle_"):
            from .lifecycle_rpc import handle as lifecycle_handle
            return lifecycle_handle(manager, request, state_root=root)
        if request["command"].startswith(("ship_", "pulse_", "organism_")):
            from .organism_rpc import handle as organism_handle
            return organism_handle(store, request, state_root=root)
        if request["command"].startswith("schedule_"):
            from .schedule_rpc import handle as schedule_handle
            return schedule_handle(manager, request)
        if request["command"].endswith("_specialist"):
            from .work_specialist_delivery import handle as specialist_delivery
            return specialist_delivery(manager, request["command"], request["mission_id"], request["specialist_id"])
        if request["command"] == "list":
            return {"missions": [_summary(mission) for mission in store.list_work(request["conversation_id"])]}
        if request["command"] == "inspect":
            return {"mission": store.get_work(request["mission_id"]), "events": _event_summaries(store.work_events(request["mission_id"])),
                    "steering": store.work_steering_state(request['mission_id'])}
        if request['command'] == 'steer':
            return store.queue_work_steering(request['mission_id'], request['conversation_id'], request['correction_id'], request['text'])
        if request["command"] == "cancel":
            return {"mission": manager.cancel_work(request["mission_id"])}
        if request["command"] == "cancel_request":
            return {"mission": manager.cancel_work_request(request["request"])}
        if request["command"] == "validate_delivery":
            return store.validate_work_delivery(request["mission_id"], request["artifact_id"])
        if request["command"] == "deliver":
            authority = {"issuer": "local-user", "scope": "reviewed-work-artifact", "actions": ["commit"],
                         "mission_id": request["mission_id"], "artifact_id": request["artifact_id"]}
            return store.commit_work_delivery(request["mission_id"], request["artifact_id"], request["validation_token"], authority)
        work = request["request"]
        preferences = store.list_workspace("settings")
        saved = preferences[0] if preferences else {}
        endpoint = os.environ.get("YUR_OLLAMA_URL") or saved.get("ollama_url") or DEFAULT_OLLAMA_URL
        adapter = create_model_adapter(work["provider"], work["model"], endpoint=endpoint)

        def emit(event):
            on_event({**event, "request_id": work["request_id"], "conversation_id": work["conversation_id"]})

        return {"mission": manager.run_work(work, adapter, emit, acquire_page=acquire_page)}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    sent = 0
    identity = {}

    def emit(record):
        nonlocal sent
        if record.get("type") in {"status", "tool", "steering", "model"}:
            identity.update({key: record[key] for key in ("mission_id", "request_id", "conversation_id") if key in record})
        encoded = json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
        sent += len(encoded.encode())
        if sent > MAX_OUTPUT_BYTES:
            raise ValueError("Work RPC output exceeds 4 MiB")
        sys.stdout.write(encoded)
        sys.stdout.flush()

    try:
        acquire_page = None
        if sys.argv[1:] == ['--browser-acquisition-v1']:
            from .work_browser_protocol import read_initial, create_acquirer
            request = read_initial(sys.stdin.buffer, maximum=MAX_INPUT_BYTES)
            validate_rpc(request)
            if request['command'] != 'start' or 'browser_source' not in request['request']:
                raise ValueError('Browser acquisition protocol requires a Work start with an operator-selected source')
            acquire_page = create_acquirer(sys.stdin.buffer, emit)
        else:
            if sys.argv[1:]:
                raise ValueError('Unsupported Work protocol option')
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            if len(raw) > MAX_INPUT_BYTES:
                raise ValueError("Work RPC input exceeds its byte budget")

            def reject_constant(_value):
                raise ValueError("Work RPC cannot contain non-finite JSON values")

            request = json.loads(raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=reject_constant)
        result = handle(request, emit, acquire_page=acquire_page)
        emit({"type": "result", "ok": True, "result": result})
        return 0
    except UnsupportedWorkProvider as error:
        code, message = "UNSUPPORTED_PROVIDER", str(error)
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        code, message = "INVALID_REQUEST", str(error)
    except (OSError, RuntimeError, sqlite3.DatabaseError) as error:
        code, message = "WORKER_BUSY" if _worker_busy(error) else "WORK_FAILED", str(error)
    failure = {"type": "result", "ok": False, "error": {"code": code, "message": message[:2000], **identity}}
    if sent + len(json.dumps(failure, ensure_ascii=False).encode()) + 1 <= MAX_OUTPUT_BYTES:
        emit(failure)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
