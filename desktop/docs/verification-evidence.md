# Local acceptance evidence

This document preserves the initial factory acceptance snapshot. Its counts and
capability inventory describe that historical version. Current Desktop scope,
later validation receipts and remaining gaps are tracked in
[the Desktop mission record](../desktop-parity-mission.md).

The implemented factory has been exercised using actual Python subprocesses,
exported packages, the core YUR plugin transport, and a real Electron renderer.
Synthetic test input was used; no external systems or customers were modified.

## Real desktop acceptance

- Capabilities displayed: 3.
- Mission `<mission-id>` reached `completed` through UI submission and queue processing.
- Committed artifact digest: `fefbb1e1cdff0591ba22b09494949b79024e185b9ee499028aa40ca5a1744798`.
- New support input returned `identity-support` with an execution receipt.
- Export size: 27,570 bytes.
- Source panel returned all six configured source roots.
- No renderer console/preload errors were observed.
- A second mission, `<second-mission-id>`, completed through the
  Start continuous control. The supervisor stopped at its one-cycle limit with
  `enabled: false`, `running: false`, `remaining: 0`, and `error: null`.
- Sidebar fragment navigation and subsequent trusted IPC were verified.

The initial attempt inside the Codex tool sandbox failed during Electron GPU
subprocess startup (`-1073741515`). The same smoke test succeeded with authorized
host execution, while Electron's `sandbox: true`, context isolation and disabled
Node integration remained enforced. Hardware acceleration is disabled in the
smoke harness only; the test does not use `--no-sandbox`.

The test writes `smoke-result.json`, `factory-console.png` and
`factory-sources.png` to a newly created temporary directory. It hides the test
window and uses isolated factory and Electron state. Run `npm run test:electron`
to obtain a fresh report for the current source.

## Reviewable TERRA evidence package

`python -B scripts/demo_factory.py --home .factory-state/acceptance` created
mission `<mission-id>`, named TERRA Evidence Analyst. Its actual
bindings are `data.profile` and `text.analyze`. This name identifies a local
evidence-analysis composition; it does not certify the donor's land-intelligence
claims or fill its empty agent bindings.

The synthetic table had three records. The exported specialist correctly
reported one duplicate and two missing source-reference values. Package digest:
`e5709173c4eacbef5a86caa753ab15fe740f2118587f2d89f2125f19aca56860`.
ZIP SHA-256: `9670beb7794667320f8fc66b9785562357c38b4b827e180b9ee37816368a2fce`.
The ZIP remains under `.factory-state/acceptance/exports/` for review.

## Automated checks

The final local `npm test` run passed **63 Python tests and 27 JavaScript tests**;
one additional Unix-only symbolic-link test was skipped on Windows. The real
Electron acceptance above is a separate passing integration check.

Run `npm test` for refreshed counts. Coverage includes fixture outcomes, strict
contracts, unknown bindings, forged validation, code with recomputed hashes,
runtime source drift, idempotency, transactional publication, cancellation,
worker process crashes, bounded continuous cycles, source/path constraints,
renderer authority, plugin receipt binding, timeout and output limits.

The Windows run skips the Unix-only symbolic-link test; Windows reparse-point
rejection is covered separately. These are scoped factory checks. They do not
prove legacy services, the entire external core runtime, hosted CI or enterprise
release gates have passed.
