"""
ouroboros.producer -- the probabilistic 20%: pluggable artifact producers.

A Producer turns a grounded spec into candidate files. It runs INSIDE the
governance cage: its output is written only to a staging area and is not trusted
until the deterministic 80% (frozen re-verify + AST safety + structural checks)
signs off. Producers never touch existing repo files.

Shipped:
  * ScaffoldProducer   -- zero-dependency, deterministic, $0. Emits a vertical
                          package (manifest + wire + landing + agent stub) from
                          the spec. Proves the whole loop with no external service.
  * HttpWorkerProducer -- dispatches to a real worker endpoint (headless agent /
                          sovereign swarm), resolved from config (NO hardcoded
                          ports) and pre-flighted; fails closed if unreachable.
"""

from __future__ import annotations

import html
import json
import urllib.request
from dataclasses import dataclass, field
from typing import Protocol

from . import config


@dataclass
class ProduceResult:
    files: dict[str, str]  # relative path -> content
    cost: float = 0.0
    producer: str = "unknown"
    meta: dict = field(default_factory=dict)


class Producer(Protocol):
    name: str

    def produce(self, spec: dict) -> ProduceResult: ...


def _slug(text: str) -> str:
    out = "".join(c.lower() if c.isalnum() else "-" for c in text.strip())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or "vertical"


class ScaffoldProducer:
    """Deterministic, offline vertical-package generator. Additive-only, $0."""

    name = "scaffold"

    def produce(self, spec: dict) -> ProduceResult:
        name = str(spec.get("name") or "Untitled Vertical")
        slug = _slug(name)
        desc = str(spec.get("description") or "")
        caps = spec.get("capabilities") or []
        if not isinstance(caps, list):
            caps = [str(caps)]
        root = f"verticals/{slug}"

        manifest = {
            "id": slug,
            "name": name,
            "description": desc,
            "capabilities": caps,
            "generated_by": "ouroboros.ScaffoldProducer",
            "schema": "yur.vertical.v1",
        }
        wire = {
            "id": slug,
            "content": [
                {"kind": "welcome", "title": name},
                {"kind": "markdown", "body": desc or name},
                {"kind": "agent-chat", "agent": f"{slug}-agent"},
            ],
        }
        landing = (
            '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            f"<title>{html.escape(name)}</title></head>\n<body>\n"
            f"  <h1>{html.escape(name)}</h1>\n  <p>{html.escape(desc)}</p>\n  <ul>\n"
            + "".join(f"    <li>{html.escape(str(c))}</li>\n" for c in caps)
            + "  </ul>\n</body></html>\n"
        )
        agent_py = (
            f'"""Auto-generated agent stub for the {name} vertical."""\n\n'
            f"AGENT_ID = {slug!r}\n\n"
            "def describe() -> dict:\n"
            f"    return {{\"id\": {slug!r}, \"name\": {name!r}, "
            f"\"capabilities\": {caps!r}}}\n"
        )

        # Demo-only hook to exercise the fail-closed quarantine path.
        if spec.get("_inject_unsafe"):
            agent_py += "\nimport os\nos.system('echo pwned')\n"

        files = {
            f"{root}/manifest.json": json.dumps(manifest, indent=2) + "\n",
            f"{root}/wire.json": json.dumps(wire, indent=2) + "\n",
            f"{root}/landing.html": landing,
            f"{root}/agent.py": agent_py,
        }
        return ProduceResult(
            files=files, cost=0.0, producer=self.name, meta={"root": root, "slug": slug}
        )


class HttpWorkerProducer:
    """Dispatch production to a real worker endpoint (config-resolved, preflighted)."""

    name = "http_worker"

    def __init__(self, service: str = "sovereign_swarm", path: str = "/mission", timeout: float = 120.0):
        self.service = service
        self.path = path
        self.timeout = timeout

    def produce(self, spec: dict) -> ProduceResult:
        if not config.preflight(self.service):
            raise RuntimeError(
                f"worker '{self.service}' unreachable at "
                f"{config.endpoint_url(self.service)} (fail-closed)"
            )
        url = config.endpoint_url(self.service) + self.path
        body = json.dumps({"spec": spec}).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 (config-resolved)
            raw = resp.read(config.MAX_PRODUCE_BYTES + 1)
        if len(raw) > config.MAX_PRODUCE_BYTES:
            raise RuntimeError(f"worker response exceeds {config.MAX_PRODUCE_BYTES} bytes (fail-closed)")
        payload = json.loads(raw.decode("utf-8"))
        files = payload.get("files") or {}
        if not isinstance(files, dict) or not files:
            raise RuntimeError("worker returned no files (fail-closed)")
        if len(files) > config.MAX_PRODUCE_FILES:
            raise RuntimeError(f"worker returned {len(files)} files > cap {config.MAX_PRODUCE_FILES} (fail-closed)")
        return ProduceResult(
            files={str(k): str(v) for k, v in files.items()},
            cost=float(payload.get("cost", 0.0)),
            producer=self.name,
            meta={"endpoint": url},
        )


def get_producer(name: str) -> Producer:
    if name == "scaffold":
        return ScaffoldProducer()
    if name == "http_worker":
        return HttpWorkerProducer()
    raise KeyError(f"unknown producer '{name}'")
