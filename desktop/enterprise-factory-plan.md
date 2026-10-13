# Specialist factory implementation plan

## Mission and boundary

Extend this exact desktop application into a usable local specialist-agent factory. The user has authorized local implementation and non-destructive testing. Deployment, purchasing, external publication, and credential changes are outside this implementation. Existing neighboring systems remain integration targets, not source to overwrite.

## Observed starting point

- `src/main.js` launches the existing Electron IDE; package scripts currently only launch Electron.
- `foundry/compilers/agent_pack/compiler.yaml` defines a cartridge but points at a missing compiler adapter.
- `ouroboros/producer.py` already provides a typed producer result and pluggable producer interface; its offline agent is a descriptive stub.
- Ouroboros guards require a sealed governance manifest absent from this checkout. Its gates must remain fail-closed.
- The legacy cognitive orchestration manager is a construction-specific augmentation strategy with external database dependencies. It is not the authority for the new factory.
- This folder has no Git metadata. Release provenance must identify this limitation.

## Implementation

1. Add executable specialist capability bindings, typed contracts, deterministic pack compilation, outcome fixtures, independent validation, hashes and build attestation; reuse the producer contract and existing cartridge boundary.
2. Add one factory OrchestrationManager with task-scoped context, capability resolution, bounded execution, distinct validation and Commit Service, durable mission state, idempotent submissions, event provenance, recovery and bounded continuous processing.
3. Integrate a factory console into the existing desktop with narrow IPC; provide a local command-line interface using the same manager.
4. Add meaningful integration/adversarial tests, reproducible verification commands, source hygiene, architecture mapping, operating instructions and explicit release gates.

## Acceptance evidence

- Submit a specialist mission, compile diverse candidates, execute domain fixtures, select with reasons, commit an immutable package, and run that package on new input.
- Reject unknown capabilities, invalid contracts, unauthorized actions, failed outcomes and tampered artifacts.
- Demonstrate idempotency, concurrency protection, recovery, cancellation and bounded recurring work.
- Run local CLI and renderer smoke checks; keep external dependencies and commercial-readiness gaps explicit.

## Product readiness

Successful local validation establishes the implemented factory's behavior. It does not establish comparative industry leadership, independent security certification, a signed desktop release, or unrestricted autonomous authority.

## Delivered implementation

- Executable specialist compiler and cartridge adapter, two independent rule strategies,
  fixture validation, SBOM, deterministic package and source distributions.
- One factory manager, strict context/environment contracts, bounded capabilities,
  transactional Commit Service, immutable artifacts, cancellation, retries and OS locking.
- CLI continuous worker and desktop bounded cadence control using the same manager.
- Isolated factory console, narrowed IPC, safe text rendering and shell-free file search.
- Read-only source registry for the six user-supplied roots and a tested YUR core plugin adapter.
- Integration, adversarial, recovery, packaging and real Electron acceptance evidence.

The external TERRA/core/governance/catalog/infrastructure trees remain intact.
Remaining commercialization work is explicitly listed in `docs/release-readiness.md`.
