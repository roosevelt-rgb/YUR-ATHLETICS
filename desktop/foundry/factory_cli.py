"""Local operator ingress; stdin RPC and CLI share exactly one coordinator."""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from pathlib import Path

from .commit_service import CommitService
from .orchestration import OrchestrationManager, local_authority
from .specialists import catalog

MAX_REQUEST_BYTES = 131072
COMMAND_FIELDS = {
    "media": {"action", "payload"},
    "health": set(), "catalog": set(), "list": set(),
    "submit": {"spec", "idempotency_key"}, "process": {"max_missions"},
    "inspect": {"mission_id"}, "cancel": {"mission_id"},
    "run": {"mission_id", "capability_id", "input"}, "export": {"mission_id"},
    "sources": {"query", "limit"},
    "source_acquire": {"source_id", "relative_path", "expected_sha256"},
    "repository_context": {"root", "question", "authority"},
    "repository_bootstrap": {"roots", "question", "bootstrap", "authority"},
    "copilot_catalog": {"root", "query", "kind", "limit", "offset"},
    "copilot_acquire": {"root", "path", "expected_sha256"},
    "hermes_catalog": {"root", "query", "lane", "limit", "offset"},
    "hermes_acquire": {"root", "path", "expected_sha256"},
    "workforce_catalog": {"root", "query"},
    "workforce_acquire": {"root", "code", "expected_sha256"},
    "workforce_run": {"root", "code", "expected_sha256", "input", "request_id"},
    "workforce_result": {"mission_id", "run_id"},
    "attachment_read": {"path", "expected_sha256"},
}


def state_home() -> Path:
    configured = os.environ.get("YUR_FACTORY_HOME")
    if configured:
        return Path(configured).expanduser().absolute()
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_STATE_HOME")
    return (Path(base) if base else Path.home() / ".local" / "state") / "yur-foundry"


def decode_request(raw: bytes) -> dict:
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("request exceeds 128 KiB")

    def reject_constant(value: str):
        raise ValueError(f"non-finite JSON constant: {value}")

    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON fields are not allowed")
            result[key] = value
        return result

    request = json.loads(raw, parse_constant=reject_constant, object_pairs_hook=unique_keys)
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    command = request.get("command")
    if not isinstance(command, str) or command not in COMMAND_FIELDS:
        raise ValueError("unknown command")
    if set(request) - ({"command"} | COMMAND_FIELDS[command]):
        raise ValueError("unexpected request fields")
    return request


def dispatch(request: dict, manager: OrchestrationManager):
    command = request["command"]
    if command == "media":
        return manager.media(request.get("action"), request.get("payload", {}))
    if command in {"workforce_run", "workforce_result"}:
        from . import workforce_bridge
        return getattr(workforce_bridge, command.removeprefix("workforce_"))(request, manager)
    if command == "health":
        return manager.health()
    if command == "catalog":
        return catalog()
    if command == "list":
        return manager.store.list_missions()
    if command == "submit":
        return manager.submit(request.get("spec"), request.get("idempotency_key"), local_authority())
    if command == "process":
        return manager.process(request.get("max_missions", 1))
    if command == "inspect":
        return manager.inspect(request.get("mission_id"))
    if command == "cancel":
        return manager.cancel(request.get("mission_id"))
    if command == "run":
        return manager.run(request.get("mission_id"), request.get("capability_id"), request.get("input"))
    if command == "export":
        return manager.store.export_artifact(request.get("mission_id"))
    if command in {"sources", "source_acquire"}:
        return acquire_source(request)
    raise ValueError("unsupported command")


def acquire_source(request: dict) -> dict:
    """Read-only ingress shared by RPC/CLI, before any journal is opened."""
    from .sources import SourceRegistry
    registry = SourceRegistry.from_environment()
    if request["command"] == "sources":
        return registry.describe(request.get("query", ""), request.get("limit", 12))
    return registry.acquire(request.get("source_id"), request.get("relative_path"), request.get("expected_sha256"))


def envelope_error(exc: Exception) -> dict:
    code = "denied" if isinstance(exc, PermissionError) else "invalid_request" if isinstance(exc, (ValueError, TypeError, KeyError)) else "operation_failed"
    return {"ok": False, "error": {"code": code, "message": str(exc)[:1000]}}


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=True, allow_nan=False), flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="YUR governed local specialist factory")
    parser.add_argument("--home", type=Path, help="explicit local factory state directory")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("rpc", help="one JSON request on stdin; one response on stdout")
    for name in ("health", "catalog", "list"):
        sub.add_parser(name)
    submit = sub.add_parser("submit")
    submit.add_argument("--name", required=True)
    submit.add_argument("--description", default="")
    submit.add_argument("--capability", action="append", required=True)
    submit.add_argument("--idempotency-key", required=True)
    process = sub.add_parser("process")
    process.add_argument("--max-missions", type=int, default=1)
    for name in ("inspect", "cancel", "export"):
        sub.add_parser(name).add_argument("mission_id")
    run = sub.add_parser("run")
    run.add_argument("mission_id")
    run.add_argument("--capability", required=True)
    run.add_argument("--input", required=True, help="JSON object; keep sensitive payloads out of shell history")
    sources = sub.add_parser("sources")
    sources.add_argument("--query", default="")
    sources.add_argument("--limit", type=int, default=12)
    watch = sub.add_parser("watch", help="continuously process the durable queue with an explicit cycle ceiling")
    watch.add_argument("--max-cycles", type=int, required=True)
    watch.add_argument("--interval-seconds", type=int, default=30)
    watch.add_argument("--max-missions", type=int, default=1)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        request = None
        if args.command == "sources":
            emit({"ok": True, "result": acquire_source({"command": "sources", "query": args.query, "limit": args.limit})})
            return 0
        if args.command == "rpc":
            request = decode_request(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))
            if request["command"] in {"sources", "source_acquire"}:
                emit({"ok": True, "result": acquire_source(request)})
                return 0
            if request["command"] == "attachment_read":
                from .attachments import read_attachment
                emit({"ok": True, "result": read_attachment({key: value for key, value in request.items() if key != "command"})})
                return 0
            if request["command"] in {"workforce_catalog", "workforce_acquire"}:
                from . import workforce_bridge
                emit({"ok": True, "result": getattr(workforce_bridge, request["command"].removeprefix("workforce_"))(request)})
                return 0
            if request["command"] == "repository_context":
                from .repository_context import acquire_context
                emit({"ok": True, "result": acquire_context({key: value for key, value in request.items() if key != "command"})})
                return 0
            if request["command"] == "repository_bootstrap":
                from .repository_context import acquire_bootstrap
                emit({"ok": True, "result": acquire_bootstrap({key: value for key, value in request.items() if key != "command"})})
                return 0
            if request["command"] in {"copilot_catalog", "copilot_acquire"}:
                from .copilot_library import dispatch as acquire_library
                library_request = {**request, "command": request["command"].removeprefix("copilot_")}
                emit({"ok": True, "result": acquire_library(library_request)})
                return 0
            if request["command"] in {"hermes_catalog", "hermes_acquire"}:
                from .hermes_library import dispatch as acquire_hermes
                library_request = {**request, "command": request["command"].removeprefix("hermes_")}
                emit({"ok": True, "result": acquire_hermes(library_request)})
                return 0
        with CommitService(args.home or state_home()) as store:
            manager = OrchestrationManager(store)
            if args.command == "watch":
                stopped = False

                def stop(_signum, _frame):
                    nonlocal stopped
                    stopped = True

                signal.signal(signal.SIGINT, stop)
                signal.signal(signal.SIGTERM, stop)
                result = manager.watch(args.max_cycles, args.interval_seconds, args.max_missions,
                                       stop_requested=lambda: stopped,
                                       on_cycle=lambda cycle: emit({"ok": True, "event": "cycle", "result": cycle}))
            else:
                if request is None:
                    request = {"command": args.command}
                    if args.command == "submit":
                        request.update(spec={"name": args.name, "description": args.description,
                                             "capabilities": args.capability}, idempotency_key=args.idempotency_key)
                    elif args.command == "process":
                        request["max_missions"] = args.max_missions
                    elif args.command in {"inspect", "cancel", "export", "run"}:
                        request["mission_id"] = args.mission_id
                        if args.command == "run":
                            request.update(capability_id=args.capability, input=json.loads(args.input))
                    elif args.command == "sources":
                        request.update(query=args.query, limit=args.limit)
                    request = decode_request(json.dumps(request).encode("utf-8"))
                result = dispatch(request, manager)
            emit({"ok": True, "result": result})
        return 0
    except Exception as exc:
        emit(envelope_error(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
