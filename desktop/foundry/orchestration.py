"""The factory's single authoritative mission coordinator.

Legacy coordinators remain unbound strategies. Producers return candidates;
validators judge them; only CommitService persists authoritative state.
"""
from __future__ import annotations

import copy
import hashlib
import json
import platform
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .commit_service import CommitService, artifact_digest
from .pack_compiler import compile_pack, validate_pack
from .specialists import CapabilityResolver, catalog
from .runtime_admission import run_admitted_capability

CONCEPT_STAGES = (
    "Genesis", "Inception", "Development", "Stabilization", "Maturation",
    "Monetization", "Regeneration", "Evolution",
)
STRATEGIES = ("balanced", "precision")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def local_authority() -> dict:
    """Called only at the local operator ingress, never by a model/provider."""
    return {"issuer": "local-user", "scope": "local-artifacts",
            "actions": ["build", "run", "commit"], "max_candidates": 2,
            "max_input_bytes": 65536}


def bounded_integer(value: object, name: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer between {low} and {high}")
    return value


@dataclass(frozen=True)
class EnvironmentModel:
    source_root: Path
    state_root: Path

    def describe(self) -> dict:
        return {"source_root": str(self.source_root.resolve()),
                "state_root": str(self.state_root.resolve()),
                "python": platform.python_version(), "provider": "audited-local-functions",
                "network_required": False, "shell_execution": False,
                "runtime": "python-stdlib", "authority": "local-artifacts"}


class ContextCompiler:
    """Compile bounded mission inputs and selected contracts, never a whole corpus."""

    def compile(self, spec: dict, environment: EnvironmentModel) -> dict:
        if not isinstance(spec, dict) or set(spec) - {"name", "description", "capabilities"}:
            raise ValueError("spec accepts only name, description and capabilities")
        name, description = spec.get("name"), spec.get("description", "")
        if not isinstance(name, str) or not name.strip() or len(name) > 100 or any(ord(c) < 32 for c in name):
            raise ValueError("name must contain 1..100 printable characters")
        if not isinstance(description, str) or len(description) > 2000:
            raise ValueError("description must contain at most 2000 characters")
        capabilities = spec.get("capabilities")
        if not isinstance(capabilities, list) or not 1 <= len(capabilities) <= 3:
            raise ValueError("select 1..3 registered capability IDs")
        if any(not isinstance(cap, str) for cap in capabilities):
            raise ValueError("capability IDs must be strings")
        if len(set(capabilities)) != len(capabilities):
            raise ValueError("duplicate capabilities are not allowed")
        normalized = {"name": name.strip(), "description": description.strip(),
                      "capabilities": capabilities}
        selected = CapabilityResolver().resolve(capabilities)
        if len(canonical(normalized)) > 16384:
            raise ValueError("mission exceeds context budget")
        return {"spec": normalized, "capabilities": selected,
                "environment": environment.describe(),
                "context_digest": hashlib.sha256(canonical(normalized)).hexdigest()}


class OrchestrationManager:
    def __init__(self, store: CommitService):
        self.store = store
        self.environment = EnvironmentModel(Path(__file__).resolve().parents[1], store.root)
        self.context_compiler = ContextCompiler()

    def run_work(self, request, model_adapter, on_event=lambda event: None, *, acquire_page=None, execute_desktop=None):
        from .work_engine import run_work
        return run_work(self, request, model_adapter, on_event, acquire_page=acquire_page, execute_desktop=execute_desktop)

    def media(self, action, payload=None):
        from .media_execution import dispatch
        from .media_contracts import AUTHORITY
        return dispatch(self, action, payload, envelope=AUTHORITY)

    def accept_runtime_setup(self, operation_id, resource_id, distro, check, authority, owner_session_id):
        """Accept operator resource preparation independently of Work authority."""
        return self.store.accept_runtime_setup(operation_id, resource_id, distro, check, authority, owner_session_id)

    def transition_runtime_setup(self, operation_id, expected_revision, state, evidence, *, owner_session_id):
        return self.store.transition_runtime_setup(operation_id, expected_revision, state, evidence,
                                                   owner_session_id=owner_session_id)

    def get_runtime_setup(self, operation_id):
        return self.store.get_runtime_setup(operation_id)

    def active_runtime_setup(self, resource_id=None):
        return self.store.active_runtime_setup(resource_id)

    def runtime_setup_events(self, operation_id, limit=50, before_id=None):
        return self.store.runtime_setup_events(operation_id, limit, before_id)

    def cancel_work(self, mission_id):
        from .work_engine import cancel_work
        return cancel_work(self, mission_id)

    def cancel_work_request(self, request):
        from .work_engine import validate_request, AUTHORITY
        if isinstance(request, dict) and isinstance(request.get('request_id'), str):
            existing = self.store.get_work_by_request(request['request_id'])
            if existing is not None:
                if existing['request'] != request:
                    raise ValueError('Work request ID already belongs to different input')
                return self.cancel_work(existing['id'])
        accepted = self.store.submit_work(validate_request(request), AUTHORITY)
        return self.cancel_work(accepted['id'])

    def submit(self, spec: dict, idempotency_key: str, authority: dict) -> dict:
        context = self.context_compiler.compile(spec, self.environment)
        return self.store.submit(context["spec"], idempotency_key, authority)

    def inspect(self, mission_id: str) -> dict:
        mission = self.store.get_mission(mission_id)
        if mission is None:
            raise ValueError("mission not found")
        artifact = self.store.get_artifact(mission_id)
        if artifact:
            artifact = {key: value for key, value in artifact.items() if key != "files"}
        return {**mission, "candidates": mission.get("data", {}).get("candidates", []),
                "events": self.store.events(mission_id), "artifact": artifact}

    def health(self) -> dict:
        integrity = self.store.verify_integrity()
        return {"status": "ready" if integrity.get("ok", False) else "degraded",
                "runtime": f"Python {platform.python_version()}",
                "environment": self.environment.describe(),
                "counts": dict(Counter(m["status"] for m in self.store.list_missions())),
                "integrity": integrity, "capabilities": len(catalog()),
                "release_gates": [
                    {"id": "local-factory", "status": "implemented", "detail": "Run npm test for current verification"},
                    {"id": "external-specialists", "status": "not-admitted", "detail": "Donor metadata requires executable binding and outcome evidence"},
                    {"id": "market-benchmarks", "status": "open", "detail": "Independent industry acceptance datasets required"},
                    {"id": "signed-desktop", "status": "open", "detail": "Signing, installer and update channel not configured"},
                    {"id": "legacy-ide", "status": "open", "detail": "Legacy IDE has broader authority; factory is an isolated surface"},
                    {"id": "multi-tenant", "status": "out-of-scope", "detail": "Local OS account is the trust boundary"},
                ]}

    def process(self, max_missions: int = 1, mission_id: str | None = None) -> dict:
        bounded_integer(max_missions, "max_missions", 1, 25)
        if mission_id is not None and self.store.get_mission(mission_id) is None:
            raise ValueError("mission not found")
        processed, recovered = [], []
        with self.store.acquire_worker():
            # Holding the OS lock proves there is no live factory worker. A new
            # instance may replay interrupted generation, never a completed commit.
            for mission in self.store.list_missions():
                if mission_id is not None and mission["id"] != mission_id:
                    continue
                if mission["status"] in {"running", "validating"}:
                    if mission["attempts"] >= 3:
                        self.store.transition(mission["id"], mission["status"], "failed",
                                              {"error": "Recovery attempt budget exhausted"})
                    else:
                        self.store.transition(mission["id"], mission["status"], "queued",
                                              {"recovered": True})
                        recovered.append(mission["id"])
            queue = [m for m in self.store.list_missions() if m["status"] == "queued"
                     and (mission_id is None or m["id"] == mission_id)]
            for mission in queue[:max_missions]:
                self._build(mission)
                processed.append(mission["id"])
        remaining = sum(m["status"] == "queued" for m in self.store.list_missions())
        return {"processed": processed, "recovered": recovered, "remaining": remaining}

    def process_locked_child(self, mission_id: str) -> dict:
        """Run one linked child while this same manager already owns the cell lock."""
        if self.store._lock_file is None:
            raise RuntimeError('Child processing requires the existing exclusive worker lock')
        mission = self.store.get_mission(mission_id)
        if mission is None:
            raise ValueError('Child mission not found')
        if mission['status'] in {'running', 'validating'}:
            if mission['attempts'] >= 3:
                self.store.transition(mission_id, mission['status'], 'failed', {'error': 'Recovery attempt budget exhausted'})
            else:
                self.store.transition(mission_id, mission['status'], 'queued', {'recovered': True})
            mission = self.store.get_mission(mission_id)
        if mission['status'] == 'queued':
            self._build(mission)
        return self.inspect(mission_id)

    def _build(self, mission: dict) -> None:
        mission_id = mission["id"]
        try:
            instance_id = uuid.uuid4().hex
            context = self.context_compiler.compile(mission["spec"], self.environment)
            self.store.transition(mission_id, "queued", "running", {
                "instance_id": instance_id, "context": context,
                "concept_stage": "Development", "concept_stages": list(CONCEPT_STAGES)})
            candidates = []
            viable = []
            cap = mission["authority"]["max_candidates"]
            for strategy in STRATEGIES[:cap]:
                current = self.store.get_mission(mission_id)
                if current["status"] == "cancelled":
                    return
                cell_id = uuid.uuid4().hex
                self.store.record_event(mission_id, "cell.started", {
                    "instance_id": instance_id, "cell_id": cell_id, "strategy": strategy,
                    "provider": "audited-local-functions", "blind_generation": True})
                # Neither candidate can inspect a sibling's output.
                result = compile_pack(copy.deepcopy(context["spec"]), strategy=strategy)
                validation = validate_pack(result.files)
                digest = artifact_digest(result.files)
                validation["artifact_digest"] = digest
                size = sum(len(v.encode("utf-8")) for v in result.files.values())
                candidate = {"strategy": strategy, "digest": digest,
                             "passed": validation["passed"], "validation": validation,
                             "bytes": size, "file_count": len(result.files),
                             "cost": result.cost, "cell_id": cell_id}
                candidates.append(candidate)
                self.store.record_event(mission_id, "cell.validated", candidate)
                if validation["passed"]:
                    viable.append((candidate, result.files, validation))
            if not viable:
                raise ValueError("No candidate passed independent validation")
            # Cost and artifact size are transparent measured tradeoffs, not a
            # fabricated quality or industry-leadership score.
            winner = min(viable, key=lambda item: (item[0]["cost"], item[0]["bytes"], item[0]["strategy"]))
            chosen, files, validation = winner
            pareto = [candidate["digest"] for candidate, _, _ in viable if not any(
                other["cost"] <= candidate["cost"] and other["bytes"] <= candidate["bytes"]
                and (other["cost"] < candidate["cost"] or other["bytes"] < candidate["bytes"])
                for other, _, _ in viable)]
            selection = {"strategy": chosen["strategy"], "digest": chosen["digest"],
                         "reason": "All admitted candidates pass outcome gates; minimize measured cost then package bytes, with strategy as deterministic tie-breaker",
                         "pareto_frontier": pareto, "candidate_count": len(candidates),
                         "quality_claim": "Built-in fixtures only; no comparative market certification"}
            self.store.transition(mission_id, "running", "validating", {
                "candidates": candidates, "selection": selection})
            self.store.publish(mission_id, files, validation, selection)
        except Exception as exc:
            current = self.store.get_mission(mission_id)
            if current and current["status"] in {"running", "validating"}:
                self.store.transition(mission_id, current["status"], "failed", {
                    "error": f"{type(exc).__name__}: {exc}"[:1000]})
            elif current and current["status"] == "cancelled":
                return
            else:
                raise

    def cancel(self, mission_id: str) -> dict:
        mission = self.store.get_mission(mission_id)
        if not mission:
            raise ValueError("mission not found")
        if mission["status"] == "cancelled":
            return mission
        if mission["status"] not in {"queued", "running", "validating"}:
            raise ValueError("only pending missions can be cancelled")
        return self.store.transition(mission_id, mission["status"], "cancelled", {"cancelled_by": "local-user"})

    def run(self, mission_id: str, capability_id: str, payload: dict, *, retain_output: bool = False, execution_key: str | None = None) -> dict:
        if execution_key is not None and (not isinstance(execution_key, str) or not 1 <= len(execution_key) <= 200 or not retain_output):
            raise ValueError('Correlated execution requires a bounded key and retained output')
        mission = self.store.get_mission(mission_id)
        if not mission or mission["status"] != "completed":
            raise ValueError("a completed mission is required")
        if capability_id not in mission["spec"]["capabilities"]:
            raise PermissionError("capability is outside this agent's authority")
        if len(canonical(payload)) > mission["authority"]["max_input_bytes"]:
            raise ValueError("input exceeds authority budget")
        artifact = self.store.get_artifact(mission_id)
        if artifact_digest(artifact["files"]) != artifact["digest"]:
            raise PermissionError("artifact integrity check failed")
        run_id = uuid.uuid4().hex
        input_hash = hashlib.sha256(canonical(payload)).hexdigest()
        correlation = {'execution_key': execution_key} if execution_key is not None else {}
        if execution_key is not None:
            for event in self.store.events(mission_id):
                data = event['data']
                if data.get('execution_key') != execution_key:
                    continue
                if event['event_type'] in {'execution.started', 'execution.completed'} and (data.get('input_hash') != input_hash or data.get('capability_id') != capability_id):
                    raise ValueError('Execution key already belongs to different input or capability')
                if event['event_type'] == 'execution.completed':
                    if 'output' not in data or hashlib.sha256(canonical(data['output'])).hexdigest() != data['output_hash']:
                        raise ValueError('Retained execution output is unavailable or inconsistent')
                    return {'run_id': data['run_id'], 'output': data['output'], 'receipt': event}
        validation = validate_pack(artifact['files'])
        if not validation['passed']:
            raise PermissionError('artifact integrity check failed')
        runtime_sha256 = validation['runtime']['sha256']
        self.store.record_event(mission_id, "execution.started", {
            "run_id": run_id, "capability_id": capability_id, "input_hash": input_hash,
            "runtime_sha256": runtime_sha256, **correlation})
        try:
            output = run_admitted_capability(runtime_sha256, capability_id, payload, strategy=artifact["selection"]["strategy"])
        except Exception as exc:
            self.store.record_event(mission_id, "execution.failed", {
                "run_id": run_id, "error_type": type(exc).__name__, "runtime_sha256": runtime_sha256, **correlation})
            raise
        receipt = self.store.record_event(mission_id, "execution.completed", {
            "run_id": run_id, "capability_id": capability_id,
            "input_hash": input_hash, "output_hash": hashlib.sha256(canonical(output)).hexdigest(),
            "artifact_digest": artifact["digest"], "runtime_sha256": runtime_sha256,
            **correlation, **({"output": output} if retain_output else {})})
        return {"run_id": run_id, "output": output, "receipt": receipt}

    def watch(self, max_cycles: int, interval_seconds: int, max_missions: int = 1,
              stop_requested=lambda: False, on_cycle=lambda _: None) -> dict:
        bounded_integer(max_cycles, "max_cycles", 1, 1000)
        bounded_integer(interval_seconds, "interval_seconds", 1, 3600)
        bounded_integer(max_missions, "max_missions", 1, 25)
        cycles = 0
        while cycles < max_cycles and not stop_requested():
            result = self.process(max_missions)
            cycles += 1
            on_cycle({"cycle": cycles, **result})
            if cycles < max_cycles:
                deadline = time.monotonic() + interval_seconds
                while time.monotonic() < deadline and not stop_requested():
                    time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        return {"cycles": cycles, "stopped": bool(stop_requested()), "max_cycles": max_cycles}
