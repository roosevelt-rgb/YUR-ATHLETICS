"""Pure concept-clock policy reconciled from the user's eight-stage lifecycle.

The caller supplies a trusted CommitService evidence resolver. References are
untrusted; resolver records must come from verified committed artifacts/events,
never a renderer/model dictionary. This module owns no I/O, worker or state.
Evidence of documented plans is deliberately weaker than validated outcomes.
"""
from __future__ import annotations

from copy import deepcopy
import json
import re
from typing import Callable, TypedDict


STAGES = ("genesis", "inception", "development", "stabilization", "maturation", "monetization", "regeneration", "evolution")
POLICY_VERSION = "yur.concept-policy.v1"
MAX_EVIDENCE = 12
MAX_LINEAGE = 64
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_ID = re.compile(r"[0-9a-f]{32}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")


class ConceptView(TypedDict):
    id: str
    stage: str
    parent_id: str | None
    lineage: list[str]
    revision: int
    history_hash: str


class EvidenceRef(TypedDict):
    requirement: str
    artifact_id: str
    artifact_sha256: str
    receipt_hash: str


EvidenceResolver = Callable[[EvidenceRef], dict | None]

_CONTRACTS = (
    ("genesis", "Bring a concept into existence. Diverge, name, frame.", ("seed_prompt",), ("thesis_statement", "name", "domain_tags"), ()),
    ("inception", "Define scope, constraints, and success criteria. Sign the charter.", ("thesis_statement",), ("charter", "success_criteria", "constraint_set"), ("genesis",)),
    ("development", "Build. Iterate. Instrument. Produce a functional artifact.", ("charter",), ("artifact", "build_log", "instrumentation"), ("inception",)),
    ("stabilization", "Harden. Eval against edge cases. Pass quality gates.", ("artifact",), ("eval_report", "stability_score", "known_failure_modes"), ("development",)),
    ("maturation", "Deploy. Go live. Establish telemetry baseline.", ("artifact", "eval_report"), ("deployment", "telemetry_baseline"), ("stabilization",)),
    ("monetization", "Capture value. Pricing, billing, distribution, attribution.", ("deployment", "telemetry_baseline"), ("pricing_model", "billing_integration", "attribution_chain"), ("maturation",)),
    ("regeneration", "Detect entropy. Refactor. Restore vitality or fork.", ("health_signal",), ("regeneration_plan", "restored_artifact_or_fork"), STAGES),
    ("evolution", "Transcend. Spawn successor concepts. Establish lineage.", ("mature_concept",), ("successor_seeds", "lineage_record"), ()),
)
_SPEC = {stage: {"stage": stage, "intent": intent, "entry_artifacts": list(entry), "exit_artifacts": list(exit_artifacts),
                 "can_route_back_to": list(back)} for stage, intent, entry, exit_artifacts, back in _CONTRACTS}
_FORWARD = dict(zip(("genesis", "inception", "development", "stabilization", "maturation", "monetization"),
                    ("inception", "development", "stabilization", "maturation", "monetization", "evolution")))
_PLAN_REQUIREMENTS = frozenset({"thesis_statement", "name", "domain_tags", "charter", "success_criteria", "constraint_set"})
_EVIDENCE_TYPES = {**{name: "committed-plan" for name in _PLAN_REQUIREMENTS},
                   "artifact": "validated-build", "build_log": "validated-build", "instrumentation": "execution-receipt"}
_UNAVAILABLE = {
    "seed_prompt": "Concept creation records its operator-provided seed; no transition adapter supplies this input.",
    "eval_report": "An independent evaluation-report adapter is unavailable; built-in package fixtures do not prove this gate.",
    "stability_score": "A measured stability-score adapter is unavailable; no default score or fixture-count substitution is allowed.",
    "known_failure_modes": "An independently evaluated failure-mode evidence adapter is unavailable.",
    "deployment": "A verified deployment receipt adapter is unavailable.",
    "telemetry_baseline": "A measured production telemetry-baseline adapter is unavailable.",
    "pricing_model": "A reviewed pricing-model evidence adapter is unavailable.",
    "billing_integration": "A verified billing-integration receipt adapter is unavailable.",
    "attribution_chain": "A closed revenue-attribution evidence adapter is unavailable.",
    "health_signal": "A verified runtime health/degradation evidence adapter is unavailable.",
    "regeneration_plan": "A health-bound regeneration-plan evidence adapter is unavailable.",
    "restored_artifact_or_fork": "Verified restoration or mature-successor evidence is unavailable; a patch claim is insufficient.",
    "mature_concept": "Verified maturation and concept-history evidence is unavailable.",
    "successor_seeds": "A mature-concept-bound successor seed evidence adapter is unavailable.",
    "lineage_record": "A verified Evolution lineage evidence adapter is unavailable.",
    "gate_failure": "An independently verified failed-gate evidence adapter is unavailable for this backward route.",
}


def stage_catalog() -> list[dict]:
    """Return detached donor contracts and the current evidence-adapter coverage."""
    return [{**deepcopy(_SPEC[stage]), "forward_stage": _FORWARD.get(stage), "policy_version": POLICY_VERSION,
             "exit_evidence": [{"requirement": requirement, "evidence_type": _EVIDENCE_TYPES.get(requirement),
                                "available": requirement in _EVIDENCE_TYPES,
                                "qualification": "documented_plan_only" if requirement in _PLAN_REQUIREMENTS else
                                                 "validated_local_artifact_only" if requirement in _EVIDENCE_TYPES else "unavailable",
                                "gap": _UNAVAILABLE.get(requirement)} for requirement in _SPEC[stage]["exit_artifacts"]]}
            for stage in STAGES]


def _keys(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise ValueError("Unexpected or missing concept policy fields")


def _matches(value, pattern):
    return isinstance(value, str) and bool(pattern.fullmatch(value))


def _bounded_text(value, maximum):
    return (isinstance(value, str) and 0 < len(value.strip()) <= maximum and len(value) <= maximum
            and not any((ord(char) < 32 and char not in "\n\r\t") or ord(char) == 127 for char in value))


def _copy_bounded(value, maximum):
    try:
        encoded = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError("Concept policy requires bounded JSON values") from exc
    if len(encoded.encode("utf-8")) > maximum:
        raise ValueError("Concept policy value exceeds its byte budget")
    return json.loads(encoded)


def _concept(value) -> ConceptView:
    _keys(value, ("id", "stage", "parent_id", "lineage", "revision", "history_hash"))
    if not _matches(value["id"], _UUID) or value["stage"] not in STAGES or not _matches(value["history_hash"], _SHA):
        raise ValueError("Invalid concept identity, stage or history hash")
    if type(value["revision"]) is not int or not 1 <= value["revision"] <= 1_000_000_000:
        raise ValueError("Invalid concept revision")
    lineage = value["lineage"]
    if (not isinstance(lineage, list) or len(lineage) > MAX_LINEAGE or any(not _matches(item, _UUID) for item in lineage)
            or len(set(lineage)) != len(lineage) or value["id"] in lineage):
        raise ValueError("Invalid or cyclic concept lineage")
    parent = value["parent_id"]
    if (parent is None and lineage) or (parent is not None and (not _matches(parent, _UUID) or not lineage or lineage[-1] != parent)):
        raise ValueError("Concept parent does not match retained lineage")
    return _copy_bounded(value, 8192)


def _references(value) -> list[EvidenceRef]:
    if not isinstance(value, list) or len(value) > MAX_EVIDENCE:
        raise ValueError("Concept evidence requires at most twelve references")
    seen = set()
    for reference in value:
        _keys(reference, ("requirement", "artifact_id", "artifact_sha256", "receipt_hash"))
        requirement = reference["requirement"]
        if not isinstance(requirement, str) or requirement not in {*_EVIDENCE_TYPES, *_UNAVAILABLE} or requirement in seen:
            raise ValueError("Unknown or duplicate concept evidence requirement")
        if not (_matches(reference["artifact_id"], _UUID) or _matches(reference["artifact_id"], _ID)):
            raise ValueError("Concept evidence requires an exact artifact identity")
        if not _matches(reference["artifact_sha256"], _SHA) or not _matches(reference["receipt_hash"], _SHA):
            raise ValueError("Concept evidence requires exact artifact and receipt hashes")
        seen.add(requirement)
    return _copy_bounded(value, 16_384)


def _generated_binding(reference, record):
    """Bind generated source and its independently checked acceptance cohort."""
    facts = record['facts']
    common = ('source_kind', 'source_work_id', 'build_step_index', 'artifact_digest', 'source_sha256',
              'contract_sha256', 'driver_sha256', 'runtime_digest', 'acceptance_cohort_sha256', 'evidence_verifier')
    build = ('validation_receipt_hash', 'artifact_receipt_hash')
    execution = ('execution_work_id', 'execution_step_index', 'capability_id', 'input_hash', 'output_hash',
                 'accepted_receipt_hash', 'snapshot_receipt_hash', 'execution_receipt_hash', 'result_receipt_hash')
    is_build = record['evidence_type'] == 'validated-build'
    bounds = {'yur.generated-evidence.v1': 20, 'yur.generated-evidence.v2': 128}
    execution_version = facts.get('execution_verifier', 'yur.generated-evidence.v1')
    extra = ('execution_verifier',) if not is_build and 'execution_verifier' in facts else ()
    _keys(facts, (*common, *(build if is_build else execution), *extra))
    if (facts['source_kind'] != 'generated_python' or type(facts['evidence_verifier']) is not str
            or facts['evidence_verifier'] not in bounds
            or not _matches(facts['source_work_id'], _ID) or type(facts['build_step_index']) is not int
            or not 0 <= facts['build_step_index'] < bounds[facts['evidence_verifier']]
            or facts['artifact_digest'] != reference['artifact_sha256']):
        raise ValueError('Generated evidence requires an exact source publication and historical verifier')
    hashes = ('artifact_digest', 'source_sha256', 'contract_sha256', 'driver_sha256', 'runtime_digest', 'acceptance_cohort_sha256')
    if any(not _matches(facts[key], _SHA) for key in hashes):
        raise ValueError('Generated evidence requires exact source, contract, driver, runtime and cohort hashes')
    if is_build:
        if (any(not _matches(facts[key], _SHA) for key in build)
                or facts['validation_receipt_hash'] == facts['artifact_receipt_hash']
                or reference['receipt_hash'] != facts['artifact_receipt_hash' if reference['requirement'] == 'artifact' else 'validation_receipt_hash']):
            raise ValueError('Generated cohort validation and publication require distinct bound receipts')
    else:
        if (type(execution_version) is not str or execution_version not in bounds
                or (facts['evidence_verifier'] != 'yur.generated-evidence.v1' and not extra)
                or not _matches(facts['execution_work_id'], _ID) or type(facts['execution_step_index']) is not int
                or not 0 <= facts['execution_step_index'] < bounds[execution_version] or facts['capability_id'] != 'python.run'
                or (facts['execution_work_id'], facts['execution_step_index']) == (facts['source_work_id'], facts['build_step_index'])
                or any(not _matches(facts[key], _SHA) for key in execution[3:])
                or reference['receipt_hash'] != facts['result_receipt_hash']
                or len({facts[key] for key in execution[5:]}) != 4):
            raise ValueError('Generated instrumentation requires a distinct accepted fresh-input execution and result')
    return tuple(facts[key] for key in common)


def _check_resolved(concept, reference, record):
    _keys(record, ("requirement", "artifact_id", "artifact_sha256", "receipt_hash", "concept_id", "evidence_type", "facts"))
    if any(record[key] != reference[key] for key in reference) or record["concept_id"] != concept["id"]:
        raise ValueError("Resolved evidence does not match its concept, artifact and receipt references")
    requirement = reference["requirement"]
    if record["evidence_type"] != _EVIDENCE_TYPES[requirement]:
        raise ValueError("Resolved evidence has the wrong independently sourced evidence type")
    facts = record["facts"]
    if record["evidence_type"] == "committed-plan":
        _keys(facts, ("content",))
        content = facts["content"]
        if requirement in {"domain_tags", "success_criteria", "constraint_set"}:
            maximum_items, maximum_text = (20, 80) if requirement == "domain_tags" else (64, 2000)
            if not isinstance(content, list) or not 1 <= len(content) <= maximum_items or any(not _bounded_text(item, maximum_text) for item in content):
                raise ValueError("The committed plan requirement needs a bounded nonempty list of text")
        elif not _bounded_text(content, 200 if requirement == "name" else 16_000):
            raise ValueError("The committed plan requirement needs bounded nonempty text")
        _copy_bounded(content, 32_768)
        return None
    if isinstance(facts, dict) and facts.get('source_kind') == 'generated_python':
        return _generated_binding(reference, record)
    common = ("build_mission_id", "artifact_digest", "runtime_digest")
    if record["evidence_type"] == "validated-build":
        _keys(facts, (*common, "validation_receipt_hash", "artifact_receipt_hash"))
        if any(not _matches(facts[key], _SHA) for key in ("validation_receipt_hash", "artifact_receipt_hash")):
            raise ValueError("Build evidence needs actual validation and artifact event hashes")
        if facts["validation_receipt_hash"] == facts["artifact_receipt_hash"]:
            raise ValueError("Independent validation and artifact commit require distinct receipts")
        expected = facts["artifact_receipt_hash" if requirement == "artifact" else "validation_receipt_hash"]
        if reference["receipt_hash"] != expected:
            raise ValueError("Build requirement is bound to the wrong committed event")
    else:
        _keys(facts, (*common, "capability_id", "input_hash", "output_hash"))
        if not _bounded_text(facts["capability_id"], 80) or any(not _matches(facts[key], _SHA) for key in ("input_hash", "output_hash")):
            raise ValueError("Execution instrumentation needs exact capability, input and output evidence")
    if (not _matches(facts["build_mission_id"], _ID) or not _matches(facts["artifact_digest"], _SHA)
            or not _matches(facts["runtime_digest"], _SHA) or facts["artifact_digest"] != reference["artifact_sha256"]):
        raise ValueError("Build/execution evidence does not bind the exact artifact/runtime")
    return tuple(facts[key] for key in common)


def _decision(concept, target, requirements, references, resolve_evidence, errors):
    if not callable(resolve_evidence):
        raise ValueError("A trusted CommitService evidence resolver is required")
    missing, evidence, bindings, build_receipts, execution_receipts = [], [], [], [], []
    by_requirement = {reference["requirement"]: reference for reference in references}
    if set(by_requirement) - set(requirements):
        errors.append("Evidence includes requirements outside this exact stage transition")
    for requirement in requirements:
        if requirement in _UNAVAILABLE:
            missing.append({"requirement": requirement, "reason": _UNAVAILABLE[requirement]})
            continue
        reference = by_requirement.get(requirement)
        if reference is None:
            missing.append({"requirement": requirement, "reason": "A verified committed artifact and receipt reference is required."})
            continue
        try:
            resolved = resolve_evidence(deepcopy(reference))
            if resolved is None:
                raise ValueError("The referenced artifact/receipt is unavailable or unverified")
            resolved = _copy_bounded(resolved, 40_960)
            binding = _check_resolved(concept, reference, resolved)
            if binding:
                bindings.append(binding)
            if resolved["evidence_type"] == "validated-build":
                build_receipts.append((resolved["facts"]["validation_receipt_hash"], resolved["facts"]["artifact_receipt_hash"]))
            elif resolved["evidence_type"] == "execution-receipt":
                execution_receipts.append(reference["receipt_hash"])
            evidence.append({**reference, "evidence_type": resolved["evidence_type"],
                             "qualification": "documented_plan_only" if requirement in _PLAN_REQUIREMENTS else "validated_local_artifact_only"})
        except Exception:
            # Resolver failures cannot become a passed gate or expose storage diagnostics.
            missing.append({"requirement": requirement, "reason": "Evidence could not be independently resolved and bound to this concept, artifact and receipt."})
    if len(set(bindings)) > 1:
        errors.append("Development evidence refers to different builds, artifacts or runtime revisions")
    if len(set(build_receipts)) > 1:
        errors.append("Build evidence does not share the same independent validation and artifact commit receipts")
    if any(receipt in pair for receipt in execution_receipts for pair in build_receipts):
        errors.append("Execution instrumentation cannot reuse a validation or artifact commit receipt")
    return {"allowed": not missing and not errors, "from_stage": concept["stage"], "to_stage": target,
            "missing": missing, "errors": errors, "requirements": list(requirements), "evidence": evidence,
            "identity": {key: deepcopy(concept[key]) for key in ("id", "parent_id", "lineage")},
            "expected_revision": concept["revision"], "history_hash": concept["history_hash"]}


def validate_transition(concept: ConceptView, request: dict, *, resolve_evidence: EvidenceResolver) -> dict:
    """Validate one requested concept move; never execute it or replace history."""
    concept = _concept(concept)
    _keys(request, ("transition_id", "to_stage", "evidence"), ("reason",))
    if not _matches(request["transition_id"], _UUID) or request["to_stage"] not in STAGES:
        raise ValueError("Invalid concept transition identity or destination")
    reason = request.get("reason", "")
    if not isinstance(reason, str) or len(reason) > 2000 or (reason and not _bounded_text(reason, 2000)):
        raise ValueError("A route reason must be bounded text")
    references = _references(request["evidence"])
    stage, target = concept["stage"], request["to_stage"]
    errors = []
    if target == stage:
        requirements = []
        errors.append("A new concept transition must change its stage")
    elif target == "regeneration":
        requirements = ["health_signal"]
        if not reason:
            errors.append("Regeneration requires an explicit reason and verified degradation evidence")
    elif stage == "regeneration" and target in STAGES[:6]:
        requirements = ["regeneration_plan", "restored_artifact_or_fork", "health_signal"]
        if not reason:
            errors.append("Restoration requires an explicit replay target reason")
    elif _FORWARD.get(stage) == target:
        requirements = list(dict.fromkeys([*_SPEC[stage]["exit_artifacts"], *_SPEC[target]["entry_artifacts"]]))
    elif target in _SPEC[stage]["can_route_back_to"] and stage != "regeneration":
        requirements = ["gate_failure"]
        if not reason:
            errors.append("A backward route requires an explicit reason and failed-gate evidence")
    else:
        requirements = []
        errors.append("The donor stage contract does not admit this transition")
    return _decision(concept, target, requirements, references, resolve_evidence, errors)


def validate_successor(parent: ConceptView, request: dict, *, resolve_evidence: EvidenceResolver) -> dict:
    """Propose a new Genesis identity without modifying the retained predecessor."""
    parent = _concept(parent)
    _keys(request, ("transition_id", "successor_id", "seed_prompt", "evidence"))
    if (not _matches(request["transition_id"], _UUID) or not _matches(request["successor_id"], _UUID)
            or request["successor_id"] in [parent["id"], *parent["lineage"]]
            or not _bounded_text(request["seed_prompt"], 8000) or len(parent["lineage"]) >= MAX_LINEAGE):
        raise ValueError("Successor requires a new identity, bounded seed and acyclic retained lineage")
    references = _references(request["evidence"])
    errors = [] if parent["stage"] == "evolution" else ["A successor concept requires the predecessor's Evolution stage and maturity evidence"]
    decision = _decision(parent, "genesis", ["mature_concept", "successor_seeds", "lineage_record"], references, resolve_evidence, errors)
    decision["successor_identity"] = {"id": request["successor_id"], "stage": "genesis", "parent_id": parent["id"],
                                      "lineage": [*parent["lineage"], parent["id"]], "seed_prompt": request["seed_prompt"]}
    return decision
