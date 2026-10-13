"""
ouroboros.config -- single source of truth for endpoints, paths, and budgets.

HARD RULE (owner): never hardcode a port. Every network endpoint is resolved
here from environment variables, with *advisory* defaults drawn from the repo's
documented port map and held in ONE registry. Pipeline logic calls
``endpoint()`` / ``endpoint_url()`` -- no bare port literal ever lives in the
control flow. The orchestrator itself binds NO ports (it is a stateless CLI
sweep); ports appear only as outbound, overridable, pre-flighted worker
endpoints, and dispatch fails closed when a required one is unreachable.

Runtime state is kept OFF the Google Drive mount by default (hot ledger writes
must not thrash Drive sync); code lives in-repo, state lives local.
"""

from __future__ import annotations

import os
import socket
from pathlib import Path

# --- Repo anchor -----------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[1]

# Source of the sealed frozen-spine hash manifest. Default = this repo; point
# OURO_GOVERNANCE_ROOT at the verified sealed release (e.g. the
# YUR-AI-sovereignty-paradox-v1-verified tree) to anchor integrity to sealed
# hashes while still verifying the files actually on the import path (REPO_ROOT).
GOVERNANCE_ROOT = Path(os.environ.get("OURO_GOVERNANCE_ROOT", str(REPO_ROOT)))


# --- Runtime home (local, not the Drive mount) -----------------------------
def _default_home() -> Path:
    base = (
        os.environ.get("OURO_HOME_BASE")
        or os.environ.get("LOCALAPPDATA")
        or os.environ.get("XDG_STATE_HOME")
        or os.path.expanduser("~")
    )
    return Path(base) / "ouroboros"


HOME = Path(os.environ.get("OUROBOROS_HOME", str(_default_home())))
LEDGER_PATH = Path(os.environ.get("OURO_LEDGER", str(HOME / "ledger.jsonl")))
TASKS_DIR = HOME / "tasks"
STAGING_DIR = HOME / "staging"
PRODUCED_DIR = HOME / "produced"
QUARANTINE_DIR = HOME / "quarantine"
STOP_FILE = HOME / "STOP"

# Route franklin_arbiter's hash-chained audit log into our local home (never the
# Drive/repo). We set the env var the arbiter reads unless the operator already
# chose one -- this mirrors the CLAUDE.md guidance for the audit log path.
AUDIT_LOG_ENV = "TRINITY_FRANKLIN_AUDIT_LOG"
AUDIT_LOG_PATH = Path(os.environ.get(AUDIT_LOG_ENV, str(HOME / "franklin_arbiter_audit.log")))


def bind_audit_log() -> None:
    """Point franklin_arbiter's audit log at our local home. Called lazily (never
    at import) so merely importing ouroboros has no process-global side effects."""
    os.environ.setdefault(AUDIT_LOG_ENV, str(AUDIT_LOG_PATH))


# --- Trusted secret store (OUTSIDE OUROBOROS_HOME) -------------------------
# The ledger's HMAC key + tamper anchor must NOT live in the untrusted state dir,
# or an attacker who can write OUROBOROS_HOME could forge/reset the audit trail.
SECRET_DIR = Path(os.environ.get("OURO_SECRET_DIR", str(Path.home() / ".ouroboros-secret")))
LEDGER_KEY_FILE = SECRET_DIR / "ledger.key"
LEDGER_ANCHOR_FILE = SECRET_DIR / "ledger.anchor.json"

# --- Produced-output caps (resource-DoS guard) ----------------------------
MAX_PRODUCE_BYTES = int(os.environ.get("OURO_MAX_PRODUCE_BYTES", str(5_000_000)))
MAX_PRODUCE_FILES = int(os.environ.get("OURO_MAX_PRODUCE_FILES", str(200)))


def ensure_dirs() -> None:
    for d in (HOME, TASKS_DIR, STAGING_DIR, PRODUCED_DIR, QUARANTINE_DIR):
        d.mkdir(parents=True, exist_ok=True)
    SECRET_DIR.mkdir(parents=True, exist_ok=True)
    bind_audit_log()


# --- Service registry (NO hardcoded ports in logic) ------------------------
# name -> (env_prefix, advisory_default_host, advisory_default_port)
# Defaults mirror the repo port map but are advisory only; <PREFIX>_HOST and
# <PREFIX>_PORT override at runtime. Add adapters here, never inline a port.
_SERVICES: dict[str, tuple[str, str, int]] = {
    "headless_agent": ("OURO_AGENT", "127.0.0.1", 8845),
    "sovereign_swarm": ("OURO_SWARM", "127.0.0.1", 8846),
    "trinity_hub": ("OURO_HUB", "127.0.0.1", 8000),
}


def register_service(name: str, env_prefix: str, default_host: str, default_port: int) -> None:
    """Register (or override) a logical service endpoint. Keeps ports out of logic."""
    _SERVICES[name] = (env_prefix, default_host, int(default_port))


def endpoint(name: str) -> tuple[str, int]:
    if name not in _SERVICES:
        raise KeyError(f"unknown service '{name}'; known: {sorted(_SERVICES)}")
    prefix, dhost, dport = _SERVICES[name]
    host = os.environ.get(f"{prefix}_HOST", dhost)
    port = int(os.environ.get(f"{prefix}_PORT", str(dport)))
    return host, port


def endpoint_url(name: str, scheme: str = "http") -> str:
    host, port = endpoint(name)
    return f"{scheme}://{host}:{port}"


def port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def preflight(name: str, timeout: float = 0.5) -> bool:
    """True iff the (env-resolved) endpoint for `name` is accepting connections."""
    host, port = endpoint(name)
    return port_open(host, port, timeout)


# --- Budgets (env-driven cost ceilings) ------------------------------------
def _f(env: str, default: float) -> float:
    try:
        return float(os.environ.get(env, default))
    except (TypeError, ValueError):
        return default


STAGE_COST_CEILING: dict[str, float] = {
    "research": _f("OURO_CEIL_RESEARCH", 0.10),
    "produce": _f("OURO_CEIL_PRODUCE", 0.40),
    "review": _f("OURO_CEIL_REVIEW", 0.10),
    "validate": _f("OURO_CEIL_VALIDATE", 0.05),
    "promote": _f("OURO_CEIL_PROMOTE", 0.03),
}
COST_WARN = _f("OURO_COST_WARN", 3.0)
COST_HARD_STOP = _f("OURO_COST_HARDSTOP", 10.0)


# --- Sweep knobs (dynamic scaling / variable speed) ------------------------
MAX_TASKS_PER_SWEEP = int(os.environ.get("OURO_MAX_TASKS_PER_SWEEP", "4"))
MAX_ATTEMPTS = int(os.environ.get("OURO_MAX_ATTEMPTS", "2"))
