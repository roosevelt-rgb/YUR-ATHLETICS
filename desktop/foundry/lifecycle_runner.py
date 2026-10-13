"""Headless lifecycle runner: keeps deployed agents running without the Desktop UI.

    python -B -m foundry.lifecycle_runner              # loop until stopped (Ctrl+C)
    python -B -m foundry.lifecycle_runner --once       # one tick (Task Scheduler friendly)
    python -B -m foundry.lifecycle_runner --interval 30

The runner is single-instance (an OS file lock beside the journal). While it
holds the lock, the Desktop's in-app lifecycle dispatcher defers to it, so a
deployment is never driven by two hosts. It only follows committed claims:
claim -> resolve existing Work -> run through OrchestrationManager -> reconcile
the actual terminal Work, or record an honest pre-Work dispatch failure.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import time

LOCK_NAME = "lifecycle-runner.lock"
STATUS_NAME = "lifecycle-runner.json"
_TERMINAL = {"completed", "failed", "cancelled"}


def _now():
    return datetime.now(timezone.utc).isoformat()


class RunnerLock:
    """Non-blocking exclusive lock on a sidecar file (released by the OS on exit)."""

    def __init__(self, root):
        self.path = Path(root) / LOCK_NAME
        self.handle = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self.handle = handle
        return True

    def release(self):
        if self.handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None


def runner_status(root):
    """Whether a headless runner currently owns lifecycle dispatch (read-only probe)."""
    if root is None:
        return {"running": False, "detail": None}
    root = Path(root)
    detail = None
    try:
        detail = json.loads((root / STATUS_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        detail = None
    if not (root / LOCK_NAME).exists():
        return {"running": False, "detail": detail}
    probe = RunnerLock(root)
    if probe.acquire():
        probe.release()
        return {"running": False, "detail": detail}
    return {"running": True, "detail": detail}


def _write_status(root, **fields):
    path = Path(root) / STATUS_NAME
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"pid": os.getpid(), "heartbeat_at": _now(), **fields}, sort_keys=True),
                         encoding="utf-8")
    os.replace(temporary, path)


def _endpoint(store):
    from .work_provider import DEFAULT_OLLAMA_URL
    preferences = store.list_workspace("settings")
    saved = preferences[0] if preferences else {}
    return os.environ.get("YUR_OLLAMA_URL") or saved.get("ollama_url") or DEFAULT_OLLAMA_URL


def tick(root, adapter_factory=None, log=print):
    """One dispatch cycle. Returns a summary of what happened (for tests and logs)."""
    from .commit_service import CommitService
    from .orchestration import OrchestrationManager
    from .work_provider import create_model_adapter

    summary = {"claimed": 0, "completed": 0, "dispatch_errors": 0, "busy": 0, "ship_checks": 0, "ship_debts_proposed": 0}
    if not (Path(root) / "foundry.sqlite3").exists():
        return summary
    with CommitService(Path(root)) as store:
        manager = OrchestrationManager(store)
        claims = store.claim_due_deployments(limit=1)
        for claim in claims:
            summary["claimed"] += 1
            deployment, request = claim["deployment"], claim["request"]
            mission = store.get_work_by_request(request["request_id"])
            if mission is None and deployment["state"] == "active":
                try:
                    factory = adapter_factory or (lambda model: create_model_adapter("ollama", model, endpoint=_endpoint(store)))
                    log(f"[lifecycle] running {deployment['name']!r} ({deployment['id']})")
                    manager.run_work(request, factory(request["model"]))
                except (sqlite3.OperationalError, OSError) as error:
                    if "busy" in str(error).lower() or "locked" in str(error).lower():
                        summary["busy"] += 1
                        log(f"[lifecycle] worker busy; keeping claim for next tick: {error}")
                        continue
                    log(f"[lifecycle] run error: {error}")
                except Exception as error:  # Work commits its own failed state first.
                    log(f"[lifecycle] run ended with error: {error}")
                mission = store.get_work_by_request(request["request_id"])
            if mission is not None and mission["status"] in _TERMINAL:
                store.complete_deployment_run(deployment["id"], mission["id"])
                summary["completed"] += 1
            elif mission is None:
                store.record_deployment_dispatch_error(deployment["id"], request["request_id"],
                                                       "The headless runner could not start Work for this run")
                summary["dispatch_errors"] += 1
        # Ship gate: read-only probes for due candidates; a fresh DEBT proposes a paused mission.
        from .organism_rpc import perform_check
        for candidate in store.due_ship_candidates(limit=3):
            outcome = perform_check(store, candidate, log)
            summary["ship_checks"] += outcome["verdict"] is not None
            summary["ship_debts_proposed"] += outcome["proposed"] is not None
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description="YUR AI Desktop headless lifecycle runner")
    parser.add_argument("--once", action="store_true", help="run a single dispatch tick and exit")
    parser.add_argument("--interval", type=int, default=15, help="seconds between ticks (5..600)")
    parser.add_argument("--state", help="journal folder (defaults to the Desktop state root)")
    args = parser.parse_args(argv)
    if not 5 <= args.interval <= 600:
        parser.error("--interval must be 5..600 seconds")
    if args.state:
        root = Path(args.state)
    else:
        from .conversation_cli import state_root
        root = state_root()
    lock = RunnerLock(root)
    if not lock.acquire():
        print("[lifecycle] another lifecycle runner already owns this journal", file=sys.stderr)
        return 2
    stopping = {"flag": False}

    def stop(*_):
        stopping["flag"] = True

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)
    started = _now()
    try:
        while True:
            try:
                summary = tick(root)
                _write_status(root, started_at=started, mode="once" if args.once else "loop", last=summary)
            except Exception as error:  # keep the runner alive; the journal stays authoritative
                print(f"[lifecycle] tick failed: {error}", file=sys.stderr)
                _write_status(root, started_at=started, mode="once" if args.once else "loop", error=str(error)[:500])
            if args.once or stopping["flag"]:
                return 0
            for _ in range(args.interval):
                if stopping["flag"]:
                    return 0
                time.sleep(1)
    finally:
        lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
