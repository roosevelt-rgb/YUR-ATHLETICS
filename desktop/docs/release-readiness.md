# Release readiness

Status: local release candidate, requiring the verification commands below.

## Implemented acceptance surface

- Executable contracts and fixtures for text analysis, table profiling, support triage,
  HATCH source quantity extraction and quoted construction-cost arithmetic.
- Two strategy candidates with separate validation, explainable deterministic
  selection and Pareto evidence. Structural independence is capability-specific;
  quoted construction-cost candidates share their parser.
- Immutable deterministic packages, handler bindings, SBOM and hash attestation.
- Single manager, context/environment models, distinct validation and Commit Service.
- Durable queue, idempotency, cancellation, OS worker locking and bounded recovery.
- Continuous queue worker with explicit cycle/time/batch limits.
- Isolated desktop factory UI and a compatible core YUR plugin transport.
- Read-only source discovery for the operator's supplied ecosystem locations.

## Verification commands

`npm test` runs the shared local verification suite. `npm run test:electron`
exercises real Electron/Python IPC. Tests create temporary runtime state and do
not invoke external paid providers, boot donor systems, or contact customers.
The Windows run skips the Unix symbolic-link test; Windows reparse-point rejection
has separate coverage. CI configuration is provided; the source is in a local
Git repository, but no hosted CI run is claimed.

Work and Code requests use an explicit 16,384-token Ollama context window. This
prevents a small local mission from allocating a model's full 128K context by
default. Operators can set `YUR_WORK_CONTEXT_TOKENS` to an integer from 4096 to
131072 before starting the desktop; larger windows require additional memory.
The setting applies per request and does not modify or download models. Provider
context limits still apply; long work histories require a suitably sized window.
The existing message, byte, tool-step and response deadlines remain enforced.

## Gates still open for an enterprise launch

1. Market-specific independently maintained evaluation datasets and agreed
   acceptance thresholds. Current fixtures establish bounded behavior only.
2. Broader TERRA specialization, acquisition contracts and independently maintained
   domain acceptance evidence. HATCH quantities and BID-ZONE quoted-cost inspection
   now execute locally; they do not establish complete TERRA behavior.
3. Broader qualification of externally generated/model-backed code. The current
   generated-Python path has finite independent acceptance, contained execution,
   saved reuse and actual local-model evidence; broader domains, adversarial
   coverage and sustained reliability remain open.
4. Signed desktop installer, secure update/rollback channel, dependency security
   audit and licensing review of the complete distributed application.
5. Governance of legacy IDE filesystem/process paths and removal of remote code
   dependencies from that privileged surface.
6. Tenant/service identity, cryptographic authority, external provenance anchors,
   backup/restore drills, retention controls, load tests and operational support.
7. Full core YUR runtime integration acceptance in its own environment. The local
   adapter contract and actual factory transport are tested separately.
8. Broader upgrade support across compiler/validator versions, source-control history
   and reproducible signed build provenance. The pinned pre-construction runtime
   preserves its original four packages; that is a bounded compatibility test,
   not universal migration support. The parent desktop folder is now the Git
   root, with initial source baseline `444b231`. Source ZIP attestations remain
   unsigned and do not automatically inherit a Git revision or hosted CI result.

None of these gates is silently marked passed by generated code, a metadata hash,
an LLM assertion, or an interface status badge.
