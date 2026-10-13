"""Pure deterministic specialist packaging and independent trusted validation.

Compilation proposes files using Ouroboros's existing producer contract. This
module never persists a package or executes code supplied by a candidate.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import re

from ouroboros.producer import ProduceResult
from .runtime_admission import admit_runtime, current_runtime, trusted_current_source

MAX_PACK_BYTES = 5_000_000
EXPECTED_FILES = frozenset({"manifest.json", "agent.py", "runtime.py", "tests/fixtures.json", "sbom.json", "attestation.json", "README.md"})
_SPEC_SCHEMA = {"type": "object", "required": ["name", "description", "capabilities"], "additionalProperties": False,
                "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                               "description": {"type": "string", "maxLength": 2000},
                               "capabilities": {"type": "array", "minItems": 1, "maxItems": 3,
                                                "items": {"type": "string", "maxLength": 80}}}}


def _json(value):
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True, allow_nan=False) + "\n"


def _sha(content):
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


# A long-lived factory process must package the same release as its imported
# handlers. Never adopt a source edit during a watch cycle while continuing to
# validate with the previous functions cached by Python's import machinery.
_RUNTIME_PATH = Path(__file__).with_name("specialists.py")
_RUNTIME_SOURCE = trusted_current_source()
_RUNTIME_SOURCE_SHA256 = _sha(_RUNTIME_SOURCE)


def _trusted_runtime_source():
    current = trusted_current_source()
    if _sha(current) != _RUNTIME_SOURCE_SHA256:
        raise ValueError("trusted runtime source changed during this process; restart with a verified source release")
    return _RUNTIME_SOURCE


def _strict_json(content):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON property")
            result[key] = value
        return result

    def constant(value):
        raise ValueError(f"non-finite JSON number: {value}")

    return json.loads(content, object_pairs_hook=pairs, parse_constant=constant)


def _normalized_spec(spec, runtime):
    runtime.validate_schema(spec, _SPEC_SCHEMA, "spec")
    if not spec["name"].strip() or any(ord(c) < 32 for c in spec["name"]):
        raise ValueError("spec.name must contain a printable nonblank name")
    runtime.resolve(spec["capabilities"])
    return {"name": spec["name"].strip(), "description": spec["description"],
            "capabilities": sorted(spec["capabilities"])}


def _agent_source(ids, strategy):
    return '''"""Executable bounded specialist agent. No network or durable mutations."""
from __future__ import annotations
import json
import sys
from runtime import run_capability

CAPABILITIES = ''' + repr(tuple(ids)) + '''
STRATEGY = ''' + repr(strategy) + '''


def run(capability_id, payload):
    if capability_id not in CAPABILITIES:
        raise ValueError("capability is not bound to this specialist")
    return run_capability(capability_id, payload, STRATEGY)


def main():
    try:
        raw = sys.stdin.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("request exceeds 2 MB")
        request = json.loads(raw)
        if not isinstance(request, dict) or set(request) != {"capability", "input"}:
            raise ValueError("request requires exactly capability and input")
        result = run(request["capability"], request["input"])
        print(json.dumps({"ok": True, "result": result}, sort_keys=True, allow_nan=False))
    except (ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def compile_pack(spec, strategy="balanced"):
    _trusted_runtime_source()
    return _compile_pack(spec, strategy, current_runtime())


def _compile_pack(spec, strategy, runtime):
    """Reconstruct the unchanged v1 package contract for an admitted revision."""
    runtime.verify()
    runtime_source = runtime.source
    if strategy not in runtime.strategies:
        raise ValueError("unknown specialist strategy")
    normalized = _normalized_spec(spec, runtime)
    resolved = runtime.resolve(normalized["capabilities"])
    slug = re.sub(r"[^a-z0-9]+", "-", normalized["name"].lower()).strip("-") or "specialist"
    workflow = (["validate_input", "direct_rule_dispatch", "validate_output"] if strategy == "balanced" else
                ["validate_input", "preserve_source_values", "context_sensitive_rule_dispatch", "validate_output"])
    manifest = {"schema_version": "1.0", "id": slug, "name": normalized["name"], "description": normalized["description"],
                "version": "1.0.0", "strategy": strategy, "workflow": workflow,
                "capabilities": [{key: value for key, value in item.items() if key != "fixtures"} for item in resolved],
                "bindings": {item["id"]: item["runtime"]["handler"] for item in resolved},
                "runtime": {"language": "python", "minimum_version": "3.11", "entrypoint": "agent.py", "dependencies": []},
                "permissions": [], "provenance": {"producer": "foundry.specialist-pack.v1", "spec_sha256": _sha(_json(normalized)),
                                                   "source_control_attestation": "not_claimed"}}
    fixtures = {"schema_version": "1.0", "cases": [{"capability": item["id"], **fixture} for item in resolved
                                                        for fixture in item["fixtures"] if fixture["strategy"] == strategy]}
    sbom = {"bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1,
            "metadata": {"component": {"type": "application", "name": slug, "version": "1.0.0"}},
            "components": [{"type": "library", "name": "python-standard-library", "scope": "required",
                            "properties": [{"name": "minimum-python-version", "value": "3.11"}]}], "dependencies": []}
    readme = f'''# {normalized["name"]}

{normalized["description"]}

This package executes {", ".join(normalized["capabilities"])} using the `{strategy}` strategy.
It requires Python 3.11 or newer and no third-party packages. It performs no network
requests, shell execution, file writes or model calls. Ticket routing is a recommendation;
no message is sent. Rule confidence is a deterministic score, not a calibrated probability.

Run `python -B agent.py`, providing one JSON object on standard input:
`{{"capability":"text.analyze","input":{{"text":"Useful agents produce evidence."}}}}`
Use an identifier bound in manifest.json and its exact input contract. See
tests/fixtures.json for examples covering every capability this package exposes.

Balanced uses word frequencies, numeric-string inference and keyword triage.
Precision uses adjacent phrases, preserves data types and requires outage context
while excluding a limited set of negated assertions. Neither strategy establishes
industry superiority; compare them using independent domain acceptance cases.

Files are deterministically generated. attestation.json records SHA-256 integrity;
this is a local build attestation, not a publisher signature or security certificate.
The factory validates fixed outcomes with trusted handlers before Commit Service
may persist this candidate. Runtime outcomes have no durable side effects to undo.
'''
    files = {"manifest.json": _json(manifest), "agent.py": _agent_source(normalized["capabilities"], strategy),
             "runtime.py": runtime_source, "tests/fixtures.json": _json(fixtures), "sbom.json": _json(sbom), "README.md": readme}
    files["attestation.json"] = _json({"schema_version": "1.0", "builder": "foundry.specialist-pack.v1", "strategy": strategy,
                                      "spec_sha256": _sha(_json(normalized)), "reproducible": True,
                                      "files": {name: _sha(content) for name, content in sorted(files.items())}})
    return ProduceResult(files=files, cost=0.0, producer="specialist_pack", meta={"strategy": strategy, "spec": normalized,
                                                                               "capabilities": normalized["capabilities"]})


def validate_pack(files):
    errors, checks = [], []
    admitted = None
    metrics = {"capability_count": 0, "fixture_count": 0, "fixtures_passed": 0, "fixture_pass_rate": 0.0,
               "artifact_bytes": 0, "runtime_bytes": 0, "reproducible": False}

    def finish():
        return {"passed": not errors, "errors": errors, "checks": checks, "metrics": metrics,
                **({"runtime": {"id": admitted.identifier, "sha256": admitted.sha256}} if admitted else {})}

    try:
        _trusted_runtime_source()
    except ValueError as exc:
        errors.append(str(exc))
        return finish()
    checks.append("pinned_runtime_source")

    if not isinstance(files, dict) or not files or len(files) > len(EXPECTED_FILES):
        errors.append("invalid artifact file mapping")
        return finish()
    for name, content in files.items():
        if (not isinstance(name, str) or not name or "\\" in name or ":" in name or
                PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts or
                any(ord(char) < 32 for char in name) or name not in EXPECTED_FILES):
            errors.append("unsafe or unknown artifact path")
        if not isinstance(content, str):
            errors.append("artifact contents must be UTF-8 text")
    if errors:
        return finish()
    if set(files) != EXPECTED_FILES:
        errors.append("artifact file set does not match the package contract")
        return finish()
    try:
        metrics["artifact_bytes"] = sum(len(content.encode("utf-8")) for content in files.values())
    except UnicodeError:
        errors.append("artifact contains invalid Unicode")
        return finish()
    if metrics["artifact_bytes"] > MAX_PACK_BYTES:
        errors.append("artifact exceeds the 5 MB package limit")
        return finish()
    checks.append("bounded_safe_paths")
    try:
        admitted = admit_runtime(files["runtime.py"])
    except (ValueError, UnicodeError) as exc:
        errors.extend(["trusted reconstruction mismatch: runtime.py", str(exc)])
        return finish()
    checks.append("admitted_runtime_revision")
    try:
        manifest = _strict_json(files["manifest.json"])
        if not isinstance(manifest, dict):
            raise ValueError("manifest must be an object")
        spec = {"name": manifest["name"], "description": manifest["description"],
                "capabilities": [item["id"] for item in manifest["capabilities"]]}
        expected = _compile_pack(spec, manifest["strategy"], admitted).files
        for name in sorted(EXPECTED_FILES):
            if files[name] != expected[name]:
                errors.append(f"trusted reconstruction mismatch: {name}")
        attestation = _strict_json(files["attestation.json"])
        if attestation.get("files") != {name: _sha(content) for name, content in sorted(files.items()) if name != "attestation.json"}:
            errors.append("build attestation hashes do not match artifact contents")
        checks.extend(["strict_manifest_and_bindings", "trusted_runtime_reconstruction", "build_hashes_and_sbom"])
        fixture_doc = _strict_json(files["tests/fixtures.json"])
        # Use the trusted reconstructed fixtures even if candidate data is malformed.
        trusted_cases = _strict_json(expected["tests/fixtures.json"])["cases"]
        if fixture_doc != _strict_json(expected["tests/fixtures.json"]):
            errors.append("fixture contract differs from independent reference cases")
        metrics["capability_count"] = len(spec["capabilities"])
        metrics["fixture_count"] = len(trusted_cases)
        for fixture in trusted_cases:
            actual = admitted.run(fixture["capability"], fixture["input"], fixture["strategy"])
            if actual == fixture["expected"]:
                metrics["fixtures_passed"] += 1
            else:
                errors.append(f"outcome fixture failed: {fixture['capability']}/{fixture['name']}")
        metrics["fixture_pass_rate"] = metrics["fixtures_passed"] / len(trusted_cases) if trusted_cases else 0.0
        metrics["runtime_bytes"] = len(files["runtime.py"].encode("utf-8"))
        metrics["reproducible"] = files == expected
        checks.append("independent_outcome_fixtures")
    except (KeyError, TypeError, ValueError, AttributeError, RecursionError) as exc:
        errors.append(f"invalid package contract: {type(exc).__name__}: {str(exc)[:200]}")
    return finish()
