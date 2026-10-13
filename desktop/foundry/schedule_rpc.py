"""Fixed desktop schedule ingress. Only the host dispatches claimed intents."""
import re
import uuid
from .work_schedules import validate_schedule, SCHEDULE_AUTHORITY

FIELDS = {
    "schedule_list": {"command"}, "schedule_claim": {"command"},
    "schedule_save": {"command", "document", "expected_revision"},
    "schedule_events": {"command", "schedule_id", "before_id"},
    "schedule_resolve": {"command", "request_id"},
    "schedule_complete": {"command", "schedule_id", "mission_id"},
    "schedule_dispatch_error": {"command", "schedule_id", "request_id", "error"},
    "schedule_cancel_request": {"command", "schedule_id", "request_id"},
}


def validate(request):
    if set(request) != FIELDS.get(request.get("command")):
        raise ValueError("Invalid schedule RPC fields")
    for key in ("schedule_id", "request_id"):
        if key in request and (not isinstance(request[key], str) or str(uuid.UUID(request[key])) != request[key]):
            raise ValueError("Schedule RPC requires canonical UUIDs")
    if "mission_id" in request and (not isinstance(request["mission_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["mission_id"])):
        raise ValueError("Schedule completion requires a mission identifier")
    if request["command"] == "schedule_save":
        validate_schedule(request["document"])
        if type(request["expected_revision"]) is not int or not 0 <= request["expected_revision"] < 2**53:
            raise ValueError("Schedule save requires a safe revision")
    if "before_id" in request and request["before_id"] is not None and (type(request["before_id"]) is not int or not 1 <= request["before_id"] < 2**53):
        raise ValueError("Invalid schedule history cursor")
    if "error" in request and (not isinstance(request["error"], str) or not 1 <= len(request["error"]) <= 2000):
        raise ValueError("Dispatch error must contain bounded text")
    return request


def handle(manager, request):
    store, command = manager.store, request["command"]
    if command == "schedule_list":
        return {"schedules": store.list_schedules()}
    if command == "schedule_save":
        return {"schedule": store.save_schedule(request["document"], request["expected_revision"], SCHEDULE_AUTHORITY)}
    if command == "schedule_events":
        result = store.schedule_events(request["schedule_id"], before_id=request["before_id"])
        return {**result, "events": [{**{key: value for key, value in event.items() if key != "data"},
                                      "change": event["data"]["change"]} for event in result["events"]]}
    if command == "schedule_claim":
        return {"claims": store.claim_due_schedules(limit=20)}
    if command == "schedule_resolve":
        return {"mission": store.get_work_by_request(request["request_id"])}
    if command == "schedule_complete":
        return store.complete_schedule(request["schedule_id"], request["mission_id"])
    if command == "schedule_dispatch_error":
        return {"schedule": store.record_schedule_dispatch_error(request["schedule_id"], request["request_id"], request["error"])}
    if command == "schedule_cancel_request":
        from .work_schedules import _request
        schedule = store.get_schedule(request["schedule_id"])
        if schedule["active_request_id"] != request["request_id"] or schedule["enabled"]:
            raise ValueError("Pause the schedule before cancelling its exact active request")
        return {"mission": manager.cancel_work_request(_request(schedule))}
    raise ValueError("Unsupported schedule operation")
