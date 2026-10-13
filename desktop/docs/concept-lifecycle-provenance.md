# Concept lifecycle policy provenance

This is a pure transition policy under the existing OrchestrationManager and CommitService. It does not start an agent loop, allocate workers, call models, open a database, or mutate concept history. Concept stages describe long-horizon development; missions, execution runs, conversations and saved specialist versions retain separate identities and clocks.

## Source and retained semantics

The donor is the explicitly supplied `<yur-ai-core>\yur-ai` standalone package. Its applicable AGENTS.md, README, pyproject, all three lifecycle files, eight stage handlers and evaluation gates were read as source. No donor code was imported or executed.

| Source relative to donor root | Bytes | SHA-256 |
| --- | ---: | --- |
| core/lifecycle/stages.py | 4385 | a8d271b712c474cfa67b65e3366992256aadddc3dfc7e82bb13c7966086d3ea4 |
| core/lifecycle/concept.py | 2949 | 32639bf225c442e529d3c02f2b3467f3e6a90a0f6356c63363d40b1b9310ee71 |
| core/lifecycle/engine.py | 4256 | 0be809f8bf2d6cad9fd75342a7cc04c2119761707ed5d13d7198588a857d6e22 |
| core/eval/gates.py | 2276 | cdaa636ab3a7721fb9c6b8093dce9012aa8baac427228cf660c0b4100d67533d |
| stages/genesis.py | 1707 | e23b6c5692029e6277e121ab62f3b6d38b779040e7568baa5185b4cc4f34446d |
| stages/inception.py | 2199 | 70f3deaff39798fdda3b464949a79debfc2dab7a911816b24c0bdfc8921361e3 |
| stages/development.py | 1906 | e4d0d718345d70db784342ceab44f3e43011a3cc6a6f334bda9f8831834cdc4b |
| stages/stabilization.py | 1871 | 21dc2e5ba3960d71bd292118077394ab3fb5c16e6065d4236277355150b5f221 |
| stages/maturation.py | 1592 | e9c9d6cfd47a2fae2776f8611ff3f6bdd024ff00ff63ef20872cc0c1be7a6757 |
| stages/monetization.py | 1924 | 74117ad8903f0484d355ae313f880d305abb647b33a5a00e12b0e623f818a5a5 |
| stages/regeneration.py | 2389 | a48e5e318e958bc37fb80bd6f8deb985eec90e9b26f4f9d7e7935a406cf6565e |
| stages/evolution.py | 1744 | 8776388fe69bd68aaa59530c3cd2ab2ed2a647923ecc07dd15af33a5bda4be12 |

`stage_catalog()` preserves the eight names, intents, entry/exit artifact requirements and declared back routes from `core/lifecycle/stages.py:13–98`. Its normal forward route follows the actual `next_stage` function at lines 101–112: Genesis → Inception → Development → Stabilization → Maturation → Monetization → Evolution. Regeneration is triggered by degradation rather than automatically entered. The source README's cycle diagram is not substituted for this executable routing contract.

`core/lifecycle/concept.py:31–43,74–82` supplies retained identity, parent identity, ancestry and a new Genesis successor. The policy preserves that distinction: linking another specialist build to a concept is not Evolution, and proposing a successor does not replace, retire or erase its predecessor. A successor's lineage is exactly the predecessor's retained ancestors plus its ID. Cycles and identity reuse are rejected.

## Reconciliation

The donor's `LifecycleEngine.run` loop, registry, supervisor and provenance ledger are not imported. Its artifact-bag presence gate (`core/eval/gates.py:26–32,41–50`) is replaced with exact evidence lookup. Its default stability score of 0.75 (`stages/stabilization.py:27–32`), assumed production deployment and live health (`maturation.py:27–33`), unwired billing and automatic attribution (`monetization.py:28–34`), and default applied restoration (`regeneration.py:42–49`) cannot advance this policy.

The donor's 0.6 stability threshold describes a gate, not a measurement method. Neither that threshold nor built-in package fixture counts manufacture independent evaluation, industry acceptance or deployment readiness. No stability score is supplied by default.

## Pure API and authority seam

```python
stage_catalog() -> list[dict]
validate_transition(concept, request, *, resolve_evidence) -> dict
validate_successor(parent, request, *, resolve_evidence) -> dict
```

The concept view is exactly `{id, stage, parent_id, lineage, revision, history_hash}`. Concept IDs are canonical UUIDs. Revision and history hash come from the committed concept, not a model. The transition request is `{transition_id, to_stage, evidence, reason?}`. Each reference is exactly `{requirement, artifact_id, artifact_sha256, receipt_hash}`; artifact identity is a UUID or existing 32-hex mission/artifact ID. At most twelve evidence references, 64 ancestors and bounded JSON/text are accepted. A request cannot replace history or provide pass flags, authority, scores, deployment claims or resolver facts.

`resolve_evidence` is an internal trusted CommitService adapter supplied by the host. It must fetch and verify actual creation events, committed Work documents, preserved specialist package/validation artifacts and execution records before returning normalized facts. Passing renderer/model dictionaries as this callback's output would violate the integration contract. The policy does not claim that comparing an arbitrary caller's hashes proves authenticity; the store establishes provenance, and the policy independently checks the required type, content and cross-record binding.

Resolved records contain the four reference fields plus `{concept_id, evidence_type, facts}`:

| Evidence type | Required facts | Qualification |
| --- | --- | --- |
| committed-plan | `{content: string or list[string]}` | Actual bounded plan content exists; not proof of quality or completed work. |
| validated-build | `{build_mission_id, artifact_digest, runtime_digest, validation_receipt_hash, artifact_receipt_hash}` | The exact package was independently validated and committed under its admitted runtime. |
| execution-receipt | `{build_mission_id, artifact_digest, runtime_digest, capability_id, input_hash, output_hash}` | A real execution of the same package/runtime supplies instrumentation evidence. |

The store normalizes Genesis fields from the actual concept creation event. Inception fields come from committed, strictly identified Work plan artifacts. The policy requires typed nonempty content; booleans and bare key presence do not count. Development artifact/build_log references must match distinct artifact/validation event hashes, and instrumentation must reference a separate execution event. All three must agree on build mission, artifact digest and runtime digest. A later current runtime cannot replace the runtime that produced the evidence.

The decision is `{allowed, from_stage, to_stage, missing, errors, requirements, evidence, identity, expected_revision, history_hash}`. It includes only qualified evidence references, not expanded source contents. The persistence layer must compare-and-swap the expected revision/history and append its own event; an allowed policy result is not itself a commit. Malformed shapes raise `ValueError`; unresolved, unsupported or mismatched evidence produces explicit missing evidence. Resolver exceptions fail closed without exposing storage diagnostics.

## Gates currently supported

Genesis → Inception requires documented thesis, name and domain tags. Inception → Development requires charter, success criteria and constraint set. Development → Stabilization requires the validated package, actual build/validation events and matching execution evidence. This last transition means entry into independent stabilization work; it does not assert stabilization has passed.

Stabilization → Maturation is blocked until explicit independent evaluation, measured stability and known-failure-mode adapters exist. Deployment, production telemetry, billing, attribution and health/restoration adapters are also unavailable and return concrete gaps. Model-created documents labeled with those fields do not satisfy these gates.

Backward routes require an explicit reason and independently verified failed-gate evidence. No failed-gate adapter exists yet. Regeneration requires an explicit reason and verified degradation; exiting it requires a health-bound plan and verified restoration, not a fabricated reset. Although the donor lists every stage as a possible Regeneration back route, the admitted restoration route is restricted to earlier stages; it cannot skip directly to Evolution.

`validate_successor` accepts `{transition_id, successor_id, seed_prompt, evidence}` and returns the ordinary decision plus `successor_identity`. It requires the predecessor's Evolution stage and mature-concept, successor-seed and lineage evidence. Those adapters are currently unavailable. A structurally valid proposed lineage can therefore be displayed without claiming that a successor was created or that maturity was achieved.

## Validation boundary

`tests/test_concept_policy.py` uses synthetic trusted resolver records to exercise the pure policy. It covers early plan gates, actual receipt contract shapes, same-build/runtime binding, receipt separation, plan/content type checks, missing evidence, unsupported later-stage claims, back-route reasons, resolver failures, strict fields, stable history identity, successor ancestry and deterministic decisions. Durable concept integration and real source lookup are tested separately by the CommitService implementation owner.

On 2026-09-12, `python -B -m unittest discover -s tests -p test_concept_policy.py -v` passed all 14 policy tests with no skips. This is pure policy acceptance, not live lifecycle progression or deployment validation.
