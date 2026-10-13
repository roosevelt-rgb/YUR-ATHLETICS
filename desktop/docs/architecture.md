# Factory authority and integration

## Executable authority map

| Stage | Implementation | Responsibility |
| --- | --- | --- |
| Intent / mission | `factory_cli.decode_request`, `OrchestrationManager.submit` | Strict local operator ingress, idempotency and explicit authority |
| Cognitive work instance | `OrchestrationManager._build` | Independent instance ID for each attempt; mission persists across attempts |
| Environment | `EnvironmentModel` | Resolved source/state/runtime dependencies; no network required |
| Context | `ContextCompiler` | Bounded normalized spec and selected capability contracts |
| Discovery | `CapabilityRegistry`, `SourceRegistry` | Discover executable local contracts or read-only donor metadata |
| Resolution | `CapabilityResolver` | Exact admitted capability IDs with selection reasons |
| Orchestration | `foundry.orchestration.OrchestrationManager` | Single factory coordinator, OS worker lock, budgets and recovery |
| Desktop cadence | `src/factory-scheduler.js` | Bounded timing only; invokes the same manager through RPC and owns no mission state |
| Execution cells | Pure `compile_pack` and audited specialist handlers | Bounded computation; no authoritative state |
| Validation | `validate_pack` | Trusted reconstruction, contract checks, fixtures, hashes and bindings |
| Commit | `CommitService` | Revalidate, enforce mission/selection/authority, atomically persist artifact + completed state + event |
| Events | Commit Service transaction | Hash chain, snapshots, selection and run receipts |
| Artifact | DB-authoritative file mapping / derived ZIP | Immutable committed output with deterministic packaging |

Validation and commit remain distinct. A caller cannot complete a mission through
a generic state transition, a producer cannot persist, and a forged passed flag
cannot admit a package. Publication reruns independent validation and binds the
manifest's spec, strategy and digest to the mission and selection record.

The concept stages are Genesis, Inception, Development, Stabilization, Maturation,
Monetization, Regeneration and Evolution. These labels are exposed separately
from mission status, cognitive instance IDs and execution cell IDs. Long-horizon
concept transitions are **not implemented** by the factory; the current build
records Development rather than claiming a completed lifecycle engine.

## Existing systems retained

- `ouroboros.producer.ProduceResult` is reused by the compiler. Existing Ouroboros
  pipeline/gates remain unchanged and fail closed when their sealed dependencies
  are absent. The factory does not fabricate a frozen-spine seal.
- The existing agent-pack cartridge now resolves to
  `compilers.agent_pack.adapter:AgentPackCompiler`. This adapter only proposes
  artifacts. The mesh wrapper still needs the external `franklin_mesh` package.
- `cognition-engine/orchestration_manager.py` is classified as a legacy
  construction-bid augmentation strategy, not wired as a second factory authority.
- The external YUR AgentRuntime remains the agent runtime. Its plugin adapter
  exposes bounded factory actions and never owns factory persistence.
- The supplied external arbiter remains a policy helper. Its keyword approval is
  not treated as a signed authority envelope or sufficient permission for effects.
- The existing IDE retains its user-invoked editing and terminal functions. These
  legacy paths do not yet satisfy universal Commit Service governance. The
  isolated factory renderer has none of those APIs.

## Trust and evidence limits

The local OS account is the principal. Authority envelopes are internally scoped
permissions, not cryptographic delegation between untrusted tenants. An attacker
with full write access to the entire state database could rewrite an unkeyed
event chain; an external trust anchor is needed for stronger authenticity.

The two candidate strategies use different deterministic rules and workflow
descriptions. Their measured tradeoffs are fixture results, bytes and zero local
provider cost. They do not supply blind LLM ensemble generation or calibrated
market-quality scores. Candidate generation is independent: no candidate sees a
sibling's output. The validator runs trusted handlers, not arbitrary generated
Python. Exported packages are exercised separately as standalone processes by
acceptance tests.

Provider/model services are not required for this release. Adding a model worker
requires a typed adapter, bounded costs/timeouts, policy admission, independent
outcome cases and the same commit path. A model cannot expand the registry,
authorize itself, or install arbitrary code from its response.
