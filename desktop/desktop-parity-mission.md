# Unified YUR Desktop mission

Requested 2026-09-12: make the existing YUR Desktop chat experience combine
ChatGPT Desktop / Work / Codex, Hermes Agent Desktop, and Claude Desktop /
Claude Code / Cowork. Preserve the existing YUR harness and prove working flows.
The user explicitly authorized sustained implementation and requested research
of the examples. This document tracks the whole target across implementation
passes; incomplete rows must not be presented as complete product parity.

## Product contract

One conversation surface connects user intent, project context, selected models,
skills and specialists to work. Coding, document work, tools, artifacts, progress,
steering, cancellation and durable recovery remain accessible beside chat.
Profiles, tool labels and visible buttons alone are not acceptance evidence.

The existing OrchestrationManager owns missions. CommitService owns durable
state and committed outputs. Models propose operations within explicit scopes;
they cannot grant themselves filesystem, network, connector or execution rights.
The previous Workforce, repository, Copilot, Studio and factory flows must remain
working. No substitute checkout, donor boot, or parallel orchestration authority.

## Research and acceptance ledger

| Area | Required observable behavior | Starting evidence |
| --- | --- | --- |
| Conversation | Rich Markdown, code actions, copy, edit/retry/branch, live progress and Stop | Text and fences only; one-shot request |
| Organization | Search message content; rename, pin, archive; durable projects and drafts | Basic persisted conversation list |
| Composer | Attach/drop/paste files and images; inspect context; model and work mode selection | Bounded text attachments, model/repo/skill/profile selection |
| Work | User intent reaches an executable typed tool loop; tools/results/progress remain visible in chat | Four admitted pure capabilities; factory separate |
| Coding | Scoped reads, proposed edits, review/commit, test/terminal evidence, retained editor state | Manual Studio editor/PTY works; no agent action loop |
| Deliverables | Documents, tables, code and interactive previews open beside chat; durable export/reopen | Factory ZIPs and JSON work details |
| Models | Explicit provider configuration, real health/model discovery, no silent fallback, streaming/stop | Foundry and Ollama, environment-only configuration |
| Skills/agents | Discover/select existing sources; explain executable bindings; bounded specialist work | Copilot plus 23 Workforce profiles, one Workforce worker admitted |
| Ongoing work | Mission independent of chat; pause/stop, inspect, resume; bounded scheduling | Targeted factory queue and run recovery |
| Browser/research | Sources/citations; browser page work with explicit site access and inspectable actions | Links and preview primitives; no governed browser worker |
| Voice/media | Explicit device consent; visible recording/session state; real transcription/speech/media adapters | Not implemented |
| Connectors | Installed integrations, permission scopes, authentic tool execution and revocation | Source definitions do not imply connected services |
| Desktop | Keyboard navigation, light/dark/responsive layouts, reliable launcher, local persistence and recovery | Light shell and launcher verified |
| Ecosystem evolution | Mission-linked specialist creation, validation, admission, lineage and lifecycle evidence | Deterministic factory exists; broader evolution remains incomplete |

## Reference sources

Official current behavior is checked against the source pages, not inferred from
screenshots or prior product names. Snapshot date: 2026-09-12.

- [OpenAI ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275):
  conversation and outcome-oriented work, projects, local folders, progress,
  steering and voice; availability and execution location depend on context.
- [OpenAI Projects](https://help.openai.com/en/articles/10169521): project context
  combines related conversations, files and instructions.
- [OpenAI desktop browser](https://help.openai.com/en/articles/20001277): browser
  tabs share visible page state with the user and have explicit site permissions.
- The completed [reference research](docs/desktop-reference-research.md) records
  official Hermes, Claude Code, Cowork, Artifacts, connector and scheduling
  sources, including differences between current product rollouts. Local Hermes
  desktop/runtime source metadata was checked read-only; it is a reference donor.

## Execution passes

1. Research all named examples and map their workflows to source and tests.
2. Upgrade conversation rendering, organization, projects, drafts, provider
   transport and interruption behavior while preserving existing flows.
3. Connect typed tool work and artifacts to chat through the canonical harness;
   implement scoped review/commit for coding and document work.
4. Complete remaining browser, media, connector and ongoing-work integrations
   against actual available runtimes. Record required external services clearly.
5. Run adversarial contract tests, native user-flow tests and outcome checks;
   inspect the UI and produce source-linked verification evidence after edits.

No deployment, account purchase, credential change, external publication or
destructive migration is authorized by this local build. Local implementation,
tests, donor inspection, research and reversible fixes are already authorized.

## Current status

Mission active. Existing baseline: 178 automated tests passed, one host-privilege
skip, and seven native Workforce acceptance checks. These counts describe the
previous baseline, not verification of this new mission's eventual changes.

Verified during this mission (2026-09-12):

- Eleven native conversation workflow groups passed through real Electron,
  preload, local HTTP transport and CommitService: inert Markdown, exact code
  copy/editor handoff, streaming/Stop, session isolation, projects/settings,
  history organization, branches, and durable drafts.
- Eight native attachment workflow groups passed with the default project Python
  environment, no interpreter override: actual PDF/Office/text extraction, image
  capability discovery and forwarding, hash revalidation, byte-free conversation
  evidence, and visible failures before network traffic. The provider was an
  isolated HTTP fixture, not a live-model quality evaluation.
- Eight Work engine outcome tests and five delivery tests passed: durable read
  results, committed artifact records, proposal-only edits, replay prevention,
  provider recovery, cancellation, separate validation/commit, stale-source
  rejection, create-only export, and recovery after a write/receipt interruption.

- Five native Work groups passed: real read/propose/artifact execution, reviewed
  edits, export, restart inspection, stale-source refusal and upstream Stop.
- Real local Qwen3.5:9b completed a read/create/export mission with a fresh nonce
  and dimensions. Qwen2.5VL:3b described a desktop screenshot. Llama3.2 failed the
  Work quality criterion twice; installed models are not uniformly reliable.
- Native browser tests passed six host and six full-desktop groups: rendered
  DOM, site grants, navigation, isolated permissions and reviewed page context.
  The later `browser-native-proof/browser-smoke-result.json` binds readable
  direct child-page captures to actual pane bounds and source fingerprints.
  Its native owner is transparent and offscreen so Chromium can paint; a truly
  hidden child had no display surface. Parent-page screenshots exclude the
  separate child view, and no screenshots were composited.
- Seven native offline voice groups passed with a fake microphone/public WAV:
  explicit permission, local recognition, track release, editable unsent draft,
  explicit Send without journaled PCM, cancellation and grant revocation on reload.
  Six transport and six UI-controller tests passed. The fixture transcription
  contained errors; local voice metadata was discovered without playing sound.
- Four native artifact-preview host groups passed: an interactive calculation,
  opaque isolated origin, no desktop API, blocked external traffic/navigation/
  devices, and teardown. Three additional full-desktop groups passed through a
  real committed HTML artifact: calculation in the Artifact pane, modal and
  workspace visibility/mutual exclusion, inert source, exact export, reload
  without another model request, and rejection of an invalid artifact identity.
  Reload while the preview is visible hides the native view. Renderer-crash
  cleanup is implemented but was not separately exercised by this native test.
- Specialist outcome tests passed, including discovery and reuse by a later Work
  mission, parent selection receipts, interrupted result recovery and rejection
  of unbound/foreign packages. Generation now composes five admitted capabilities;
  it does not admit arbitrary model-generated handlers. Five native Desktop
  groups proved actual build/run/export/reload, model-free **Agents → Built
  specialists** discovery/inspect/export, an editable selection draft, and a
  later Work mission running the same specialist on fresh input without a new
  build. Four public catalog CLI tests passed: strict paging/field contracts,
  read-only empty discovery, real source-parent evidence, no package source in
  returned summaries, and exclusion of factory-only or uncommitted children.
- Fourteen schedule persistence and ten dispatcher tests passed, including actual
  CLI/manager dispatch, duplicate prevention and enabled-run shutdown. Eleven
  additional RPC/export tests cover strict ingress and exact specialist ZIPs.
  Four native schedule groups passed: explicit bounded dispatch, actual read and
  artifact results, reload without duplication, active Pause with upstream
  cancellation, and unavailable-source failure before a model request. Closing
  during an active run cancels it and disables its recurrence; idle schedules
  survive.
- Office generation now produces bounded DOCX reports, XLSX workbooks and PPTX
  decks without new product dependencies. Fourteen mandatory worker tests passed
  in project Python; three optional reader checks were skipped there and passed
  with the development interpreter's python-docx/openpyxl/python-pptx, giving
  17 worker tests passed under that interpreter. Two real Work delivery tests
  cover all three ZIP formats, deterministic regeneration, separate validation
  and commit, replay, tamper checks and refusal to overwrite a changed target.
  Five native Office groups passed with the default project Python: all three
  actual tool/proposal flows, readable text previews instead of recipe JSON,
  verified binary export, attachment readback of exact values, native reveal and
  restored export receipts after reload without provider replay. Seven captured
  screenshots were inspected. No renderer errors, external renderer requests or
  changes to tracked production source occurred during that native run.

The latest native receipts for these added flows are retained outside the source
archive under the local visualization proof root:

| Proof directory / receipt | Native groups | Fixture model calls | Meaning |
| --- | --- | --- | --- |
| `artifact-native-proof/artifact-smoke-result.json` | 3 | 2 | Full Desktop committed HTML preview, isolation, export and reload |
| `specialists-reuse-native-proof/specialists-smoke-result.json` | 5 | 6 | Creation, saved catalog, export and cross-mission reuse |
| `schedules-native-proof/schedules-smoke-result.json` | 4 | 4 | Actual scheduled Work dispatch, recovery, Pause and source failure |
| `documents-native-proof/documents-smoke-result.json` | 5 | 4 | DOCX/XLSX/PPTX creation, verified export, intake and reload |
| `code-cell-native-proof/code-cell-smoke-result.json` | 3 | 5 | Actual admitted WSL checks, staged source and retained execution evidence |

These receipts use isolated local HTTP model fixtures and temporary journals,
not production accounts, donor execution, or a live-model quality benchmark.
The UI tests establish Desktop document handling, not native Microsoft Office
rendering or broad Office feature compatibility.

Serial Python execution-cell integration is **under validation**. The new
`work_cells` binding retains an exact source snapshot and actual execution result
through CommitService. Nine binding tests passed for Code-only authority,
snapshot/result receipts and replay behavior; the actual exit result remains
separate from the fact that its receipt was recorded. `execution_cell` resolves
an already-running admitted
WSL/Bubblewrap resource and applies bounded filesystem, environment, network,
process/thread, output and resource policies. The fixed-code
`scripts/probe_execution_cell.py` is a separate opt-in diagnostic, not an
application execution API. Neither its existence nor a fixed-probe pass proves
the complete Code-mode workflow or arbitrary hostile-code containment. Eleven
adapter tests passed with native execution enabled (five local contract tests
and six actual execution groups), including exact-child interruption. Six local
probe tests and 31 fixed-code live boundary checks also passed. Three native
Desktop Code-mode groups then passed against the actual admitted runtime:
compile and staged unittest checks, an independently retained failed exit,
source-preserving review before apply, exact snapshot/output evidence and
restored results without reexecution. Five renderer tests passed. This uses an
isolated model fixture and an already-running verified WSL environment, not a
live-model coding benchmark. Final regression and broader runtime acceptance
remain in progress;
missing or changed runtime resources must fail instead of invoking host Python.

A separate live Qwen3.5:9b Code outcome passed against the actual admitted WSL
runner (`yur-live-code-qwen-host.json`). The model read a fresh two-file fixture,
recorded the real failing unittest exit, proposed the arithmetic correction,
and recorded a zero exit on the staged snapshot. The test file and original
source remained unchanged, and implementation fingerprints stayed constant
during that proof. Early invalid tool arguments were rejected before the model
recovered; this was one successful local outcome, not a coding benchmark. An
earlier sandbox-only attempt could not query WSL and failed visibly; its failed
receipt is retained as `yur-live-code-qwen.json`.

Active-work steering passed four full native Desktop groups in
`steering-native-proof/steering-smoke-result.json` with five held model fixture
requests and no renderer errors or external renderer requests. Corrections stay
within the same mission, persist before queue submission, and enter context at a
committed checkpoint. The old model response is discarded when its intent became
stale; completed bounded work is preserved. A lost acknowledgment, concurrent
draft edits, conversation switching, Stop and reload are covered. Stop/reload
leave any pending correction honestly marked not consumed, without restart.
Fifteen store tests, four engine race tests and the real control-CLI transport
test cover idempotency, ordering, receipt binding, final-commit races and unchanged
authority. Default development verification ran 310 Python tests (300 passed,
10 explicit environment/optional skips) and all 112 Node tests passed. Final
source-linked regression remains separate while further integration continues.

The source allowlist includes the document, artifact UI, saved-catalog and
execution-cell modules/tests plus explicit diagnostic scripts. Default execution
contract tests disable native execution; live adapter tests and fixed probes
require separate opt-in npm commands described in the
[working guide](docs/desktop-work-guide.md). Final source assembly is deferred
until concurrent implementation is frozen and regression checks finish.

Runtime revision admission preserves the four pre-construction packages with
their original seven-file contents. Historical runtime source is pinned to
`d1bba1a6a94c8b0aad0441d3bd9a457b343ee514e464097e8923333787831e08`;
unknown or altered package runtime code is never imported. Its input/output
contracts, fixtures and execution stay bound to that revision. New execution
receipts carry the actual runtime SHA-256. Ten targeted compatibility tests
cover historical packages, changed current handlers, tampering, standalone
validation and retained replay; legacy immutable results remain readable.

`construction.opc.inspect` reconciles the BID-ZONE donor's quoted cost rows into
a pure capability with exact source spans and decimal arithmetic. Twelve
focused tests plus existing specialist/HATCH regressions passed, including
actual standalone packages. Work now advertises its exact typed input contract
for direct, newly built and saved specialist execution. Three native groups
passed with six model-fixture calls, readable arithmetic and exact source
quotations, actual build and later reuse, and reload without reexecution. The test
also found and fixed UTF-16 title truncation that split an emoji and caused a
valid conversation to be rejected. This capability does not infer prices,
quantities, market suitability or approval.

The existing `YUR-AI-CORE/yur-ai` lifecycle contracts now inform a separate
Concept projection in CommitService schema 6, not another coordinator. Fourteen
pure policy tests, twenty-two store tests and ten real Work integration tests
have passed during development. Across two missions, a retained concept records
Genesis intent, Inception plans, an independently validated executable version
and its real execution, then enters Stabilization. An unsupported Maturation
request is denied with unchanged stage and an attributable receipt. Interrupted
Work recovers the original concept operation without duplicating identity.
Version ancestry preserves earlier package hashes; Evolution and concept
succession remain behind unsatisfied mature-concept evidence. Four Concept and
nine Work renderer tests passed. Three native Concept groups with twenty-three
model-fixture calls passed for the retained identity, actual evidence and
version, denied gate, read-only library and reload without replay. Full
unchanged-source regression remains separate while backend recovery is hardened.

A live Qwen3.5:9b construction proof completed two missions: it built and ran the
quoted-row specialist, detected the exact 0.15 discrepancy, then discovered and
reused the same package on fresh input with zero discrepancy. Its receipt is
`yur-live-construction-qwen.json`. A later run with stricter proof-script
fingerprinting read, built and executed successfully but received an empty final
provider response; it failed visibly before the second mission. That receipt is
retained as `yur-live-construction-qwen-current.json`. The earlier outcome does
not establish model reliability or acceptance of subsequently changed sources.

The mission remains active. External connectors, contained agent command/test
execution acceptance, broader document/media capabilities, broader specialist
evolution and production distribution remain open. Mission success counts do
not replace the separate eight-stage Concept Lifecycle. Final native UI and
regression verification continue.
These checks do not establish full feature parity or market readiness.

`<yur-os-root>` is now an independent configured source alongside the six existing
YUR-UNIFIED groups. All fifteen reviewed files were acquired for source identity
(221,951 bytes). A separate actual CLI proof acquired `proto/spine.proto` as
9,897 bytes of context with its selected whole-file hash and created no journal.
The Sources surface belongs to Cognitive Vault in the current Desktop; individual
selections persist through CommitService and are reacquired at Send. Thirty-two
source tests and nineteen conversation tests passed; native UI verification is
tracked separately. The donor's Rust graph/constitutional/snapshot mechanisms
remain classified source behavior. Its service and Wasm execution are not admitted.

Thirteen acknowledgment tests now cover lost receipts before and after specialist
publication/execution and execution-cell snapshots/results. Retrying preserves
the exact queued child or committed source snapshot; failed precommit validation
remains a finite rejection. The current live construction retry again performed
real read/build/run work but returned a thinking-only empty final response with
`done_reason=stop`; `yur-live-construction-qwen-recovery.json` preserves the failed
mission and safe diagnostics. This provider continuation problem is under
investigation and is not marked successful.

Sources passed four native Desktop groups using two fixture-model calls. They
cover durable selection/removal, fresh hash acquisition, changed-source rejection
before inference and conversation switching during delayed acquisition. A
separate native capture used the actual configured roots with zero model calls:
`source-actual-native-proof/actual-sources-result.json`. It displayed all fifteen
reviewed yur-os files and the actual 9,897-byte protocol excerpt. Donor service
execution was not started or authorized by reading that file.

The final native Concept recapture passed three groups and twenty-three fixture
calls with unchanged source hashes. A separate live Qwen3.5:9b outcome passed
creation and rediscovery across two independent conversations, six retained
intent/plan evidence records, entry into Development and denied Stabilization
and Maturation requests. Its receipt is `yur-live-concepts-qwen-contract.json`.
Two stale-revision calls were rejected and recovered through fresh inspection;
`first_pass_clean` is false. The verifier now distinguishes exact final-outcome
success from its optional `--require-first-pass` criterion. Earlier failed
receipts remain available. No package, deployment or maturity was inferred from
those three plan artifacts.

The local five-call provider diagnostic did not reproduce the construction
empty-response failure with either preserved or rewritten tool history. That
smaller exchange does not establish a cause or repair for the larger failing
mission. Safe diagnostic metadata is retained without model thinking content.

The Sources checkpoint's final unchanged-source regression passed: 428 Python
tests ran (418 passed, ten explicit skips), and all 124 Node tests passed.
`desktop-verification-sources-final.json` records the exact source fingerprints.
The deterministic unsigned source checkpoint is
`yur-specialist-factory-0.2.0-86e4729d6f8fc9f4-source.zip`; its reproducible rebuild,
ZIP contents and CRC were checked. This is a source checkpoint with prerequisites,
not a standalone installer or completion of the overall product mission.

Generated Python workers now have a separate versioned artifact contract alongside
the unchanged trusted-handler packs. A Code mission acquires an existing source
acceptance contract at its current hash, freezes it, and requests two isolated
candidate implementations without the expected cases or sibling source in either
generation context. The existing cell executes the candidates. A host validator
compares their returned values with the frozen finite cases before CommitService
publishes source, contract, driver and validation digests. Later Work discovers
the same publication and Code executes its retained source on fresh typed input.

Sixteen contract tests, eighteen manager/recovery tests and sixteen worker tests
passed during development. The worker run included five actual admitted WSL
groups; default regression leaves those five opt-in groups explicitly skipped.
The existing guardian and execution runtime were unchanged. The review added
rejection of same-mission artifact contracts, full saved-outcome revalidation,
real close/reopen recovery and bounded publication pagination.

Four native generated-worker groups passed with fourteen model-fixture calls and
fourteen actual contained executions. They cover new publication, wrong-candidate
rejection, saved reuse with new results, reload without replay and the actual
read-only **Agents → Generated Python** library. The receipt is
`generated-specialists-native-proof-library/generated-specialists-smoke-result.json`.
Model-decision fixtures establish wiring and UI behavior, not model reliability.
Two separate actual Qwen3.5:9b attempts submitted generated source but failed
before any cell executed: `yur-live-generated-qwen.json` and
`yur-live-generated-qwen-host.json`. The first could not verify running WSL
distributions; the second did not observe the selected distribution as running.
Both requested host escalation. Their effective execution contexts were not
reported, and a later exact pinned-runtime preflight passed. The causes remain
unresolved; these receipts do not establish an end-to-end live-model outcome.
Neither test started a guest, retried a mission or changed the runtime policy.

Final library styling was separately recaptured with current main/preload/UI and
the retained isolated native fixture records, without model calls or execution:
`generated-specialists-native-proof-style-final/generated-library-style-result.json`.
Only the saved-generated-card CSS selectors changed after the four functional
native groups. The styling capture verifies unchanged current source hashes and
the actual bordered, spaced actions; the original functional receipt remains
available with its earlier CSS fingerprint.

Final unchanged-source regression for this generated-worker slice is tracked
separately in `desktop-verification-generated-final.json`. Source, UI and later
proof receipts must be compared before calling any checkpoint current. At that
checkpoint, generated-worker publication was not yet accepted as Concept version
evidence. The next integration retains its distinct artifact identity and real
execution receipts.

## Generated Concept evidence and runtime diagnostics

The earlier generated checkpoint passed 478 Python tests (15 explicit opt-in
skips) and 133 Node tests. Its deterministic unsigned source ZIP is
`yur-specialist-factory-0.2.0-ae0fea9a05fd6f46-source.zip` and its proof is
`generated-checkpoint-release.json`. Subsequent changes require a new receipt.

Runtime discovery now provides bounded typed failure metadata. Work preserves
known diagnostic records through explicit error causes and CommitService;
the desktop shows the last failed event's observed phase and outcome. A status
query timeout leaves runtime availability undetermined. Safe provider counts
and stop reasons also survive a failed mission; raw thinking and response content
are excluded from these diagnostics. A read-only typed runtime probe succeeded
in 166 ms (`yur-runtime-typed-diagnostic.json`), which does not resolve the earlier
intermittent failure. Query timeouts, execution limits, pins and no-boot policy
are unchanged.

Generated Concept versions use an explicit source Work/step/artifact identity,
never a substituted legacy build ID. Historical interpretation lives in
`generated_evidence_v1.py`; new binding additionally checks current admission.
The historical verifier reconstructs both candidates, selected finite case
cohort, source and runtime fingerprints, publication and later execution
receipts without importing generated source or consulting current runtime
liveness. A frozen AST formatter removes current `ast.dump` formatting drift;
Python 3.12 grammar parsing and compatible node shapes remain a host dependency.
There is no claim that every future Python host upgrade is automatically safe.

Generated artifact/build-log evidence uses the complete selected cohort and its
final-case evaluation anchor. Instrumentation needs a distinct committed
`run_python_specialist` result. All evidence must share one publication and
runtime identity. Existing package versions retain their exact fields and
history; schema 7 adds the new version union without rewriting earlier rows.
Finite acceptance and recorded execution do not satisfy the independent
Stabilization exit requirements or establish Maturation.

The full Python regression phase now has a five-minute test-harness deadline:
the added historical reconstruction and journal recovery tests alone take
over thirty seconds in focused runs. Production WSL status checks retain their
eight-second deadlines. New native and final unchanged-source verification
receipts will report the scope of this integration separately.

The corrected full native run passed five groups, 33 fixture model requests and
14 actual contained executions in 100.58 seconds. Its receipt and nine direct
screenshots are in `generated-specialists-native-proof-concepts-verified`.
The final Concept sequence performed 18 tools, retained one generated version
and nine evidence references at revision 15, entered Stabilization and preserved
the denied Maturation request. Reload retained the exact source, acceptance
cohort and execution identities without another model call or execution. All
monitored source hashes were unchanged; renderer and external errors were zero.

Two preceding native failures remain preserved: the first fixture omitted the
model reselection after a new conversation, and the second compared the complete
read-only Concept schema with its intentionally smaller Work projection. Neither
is represented as a passing run. A separate continuation from a copy of the
closed fixture journal checked the remaining views with no model or execution
before the corrected full test was run.

This full validation used an explicitly prepared development execution resource.
Fresh WSL metadata reported the reviewed Ubuntu-24.04 distribution stopped; a
separate proof helper started that exact distribution and held one passive
process for at most 900 seconds. The setup receipt is
`yur-execution-validation-setup-<operation-id>.json`.
Runtime pins were verified before native execution. Application and fixture
no-autoboot rules, limits and admission checks were not changed. This preparation
does not establish the cause of earlier status-query timeouts, and it did not
start the YUR-OS donor runtime.

The actual-model run `yur-live-generated-qwen-prepared-runtime.json` produced
two independent Qwen implementations, each passing all five operator cases in
ten actual cells, and published the selected source. Its fresh conversation
discovered the exact publication and supplied the correct nested quantity input.
The generic tool-envelope validator nevertheless rejected `lines[0].code` before
execution because its untyped nested-object fallback forbids unknown properties.
The complete two-mission proof therefore failed; the later model answer reported
the failure rather than invented output. Ten reuse calls were rejected, some
with malformed alternative inputs after the first correct attempt. The receipt
retains all 17 model calls and verifies source and journal integrity.

This failure identifies an application boundary defect, not a failed generated
algorithm or an initially malformed model request. The repair belongs in the
generated tool-envelope validation and recovery path: preserve exact selection
fields, validate bounded JSON, then validate the original nested input against
the published worker's strict contract. The shared shipped schema validator and
frozen historical evidence semantics must remain unchanged. Post-repair native,
actual-model and unchanged-source results require new receipts.

The scoped repair now follows the existing trusted specialist runner's separation
of envelope and payload checks. Both new calls and pending generated operations
validate the unchanged nested JSON against the selected publication. Completed
result replay verifies the retained exact input without requiring another cell
or current runtime admission. Twenty-four generated Work tests passed, including
an actually admissible 6,000-node input whose metadata must not consume its input
budget. Twenty-two historical evidence tests passed during development, including
quantity-rollup execution and lost-acknowledgment recovery. These focused checks
use explicit synthetic cells; new native and actual-model receipts provide
separate execution evidence.

Post-repair full native acceptance passed the same five groups, 33 fixture model
requests and 14 actual cells in 100.027 seconds with unchanged monitored source
and zero renderer/external errors. Its nine screenshots and receipt are in
`generated-specialists-native-proof-nested-input-final`. The unchanged UI fixture
checks its sum worker; the quantity worker's nested behavior is independently
covered by the focused tests and actual-model result below.

`yur-live-generated-qwen-nested-input-final.json` passed both actual Qwen missions
in 88.379 seconds: eight actual model calls, two independent candidates each
passing five cases, and eleven actual cells including fresh saved-source reuse.
The fresh conversation discovered the publication without injected identifiers.
Its first reuse call returned the exact independently specified result:
01/EA = 0, 03/LF = 9, 03/SF = 20, 26/EA = 12, with input_count = 6.
There were no rejected calls, mission resumes or script retries. The 49 retained
Work events passed integrity verification, and source/project fingerprints were
unchanged. The finite scope does not establish general specialist reliability.

The new validation resource setup is recorded separately in
`yur-execution-validation-setup-<operation-id>.json`.
Ubuntu-24.04 was already running at this setup's preflight; a new bounded passive
holder reused it after the earlier holder had been gracefully released. The
actual-model `-context.json` companion binds the run to that setup snapshot.

Source-package dependency review found and repaired an omitted active
`src/artifact-view.js` entry. Packaging tests now check first-party HTML and
relative JavaScript dependency closure, including fixtures with valid ZIP hashes
but missing loaded modules. Final regression and reproducible packaging are
recorded in `desktop-verification-generated-concepts-final.json` and
`generated-concepts-checkpoint-release.json`. These are unsigned source
checkpoints: the current virtual environment still depends on host Python,
and model/WSL resources are not bundled portable desktop components.

## Execution runtime preparation from Settings

The desktop now exposes separate Check, explicit Prepare, Inspect and Release
controls for the reviewed local execution resource. Preparation uses a private
bounded pipe and an expiring exact-selection token. The existing manager and
CommitService retain setup acceptance before startup, verified readiness,
revisions, owned cleanup evidence and receipts. Schema 8 adds operational
records without rewriting prior Work, Concept or settings rows. Model
connectivity, runtime preparation, mission execution and Concept progression
remain separate.

The native acceptance in `execution-runtime-native-verified.json` passed four
groups in 5.486 seconds: an environment-selected Ubuntu-24.04 check, explicit
bounded hold, one actual contained Code compile, release, reload, fresh Check
and normal shutdown followed by independent receipt inspection. It used two
fixture model responses. The resource was already running at Check; this run
does not prove stopped-resource startup. Source fingerprints were unchanged,
owned-process exit was confirmed, and there were no renderer errors or
external browser requests. Four screenshots are retained with the receipt.

Runtime preparation does not submit or retry Work. The selected saved runtime
is forwarded to subsequent Work processes; an explicit environment selection
takes precedence. A fresh Check status cannot be hidden by an older released
setup status. Lost acknowledgments preserve operation identity, and an
uncertain exit cannot silently free the lease. The native test uses the actual
desktop shutdown path on failure as well as success.

Focused checks cover 12 store tests and 23 adapter/protocol tests using
synthetic resources and actual temporary journals. Desktop tests cover runtime
transport, view, sender trust, selection forwarding and execution-failure links.
The unchanged-source full regression and reproducible source package are
recorded by `desktop-verification-execution-runtime-verified-final.json` and
`execution-runtime-verified-checkpoint-release.json`. Those receipt outcomes, rather
than their filenames, determine verification status. Remaining limitations,
including orphan reconciliation, bounded history and the existing WSL
observation/verification race, are recorded in
`docs/execution-runtime-preparation.md`.

An additional intentional native handler failure in
`execution-runtime-native-failure-cleanup.json` proves the normal shutdown path
releases an active owned hold. Its mission remains failed, with one fixture
request and no executed Code cell. The earlier full regression's two historical
schema-fixture errors are preserved in `desktop-verification-execution-runtime-final.json`;
the schema-1 and schema-4 test databases were corrected without changing
production migration logic.

### Selected browser page acquisition — 2026-09-13

Browser now exposes **Allow Work to read this page** alongside the existing
manual **Use page in chat**. Selection creates metadata only. An optional Work
request descriptor binds one current loaded document to the main-process owner,
conversation and request for two minutes. The model's typed
`acquire_selected_page` call goes through the existing OrchestrationManager,
accepted/result CommitService boundaries and fixed browser extractor. No new
orchestrator, navigation authority or runtime is admitted.

`browser-work-native-final.json` passed four groups in 4.043 seconds with the
actual desktop, native page, child protocol and journal. Four fixture model
responses covered two missions. The extractor ran exactly once: zero reads at
selection, fresh same-document text at the requested acquisition, no additional
read on renderer reload, and no extraction after a same-URL document reload
invalidated the next selection. Form/hidden text exclusions, source/hash and
the retained denial were checked. Normal shutdown completed, source fingerprints
were unchanged, and no renderer errors or external browser requests occurred.
Five actual screenshots are retained with that receipt. This fixture is not a
live-model evaluation.

The first native attempt is preserved in `browser-work-native-first.json`.
It exposed a presentation race after correctly committing the denial: a late
generic details refresh could detach an explicitly opened Work record. Selected
records now survive redraws within their conversation; stale inspection replies
cannot overwrite another conversation or record. Four focused deferred-response
regressions cover this fix. Explicit refresh and return-to-details controls remain
available, including artifact and scheduled-task source inspection.

Focused tests cover acquisition budgets, exact identities/hashes, credential
filtering, Stop, expired/changed sources, lost acceptance/result acknowledgments,
duplicate frames and replay before checking a live grant. The raw pipe reader
also exits cleanly after a real five-second unanswered acquisition, avoiding a
buffered-stdin shutdown lock. Host timeout is four seconds, inside the child's
five-second budget and outside the extractor's two-second bound.

The unchanged-source full regression and deterministic source package are
recorded by `desktop-verification-browser-work-final.json` and
`browser-work-checkpoint-release.json`; inspect their outcomes, not filenames,
to determine verification status. The combined binding is
`browser-work-verified-checkpoint.json`. Limits and usage are documented in
`docs/selected-browser-page-work.md`. This remains a source distribution;
portable binary packaging and broader production readiness are separate work.

### Project navigation and mode controls — 2026-09-15

Named projects now appear in the sidebar. Each project has a home showing its
instructions, source folder and related conversations, with direct New Chat,
New Work and New Code actions. Starting one creates a separate committed draft;
browsing projects does not reassign the previous conversation. Draft previews
distinguish unsent conversations, and the header's mode controls share the existing
mode contract with busy-state guards and keyboard support. No backend schema or
orchestration authority changed.

Nine project-navigation tests and the related Work-record/selected-page regression
tests pass. `project-navigation-native-final.json` records five actual Electron
groups in 9.957 seconds using two loopback model responses, real project and
conversation commits, actual selected-project file acquisition, completed Work,
reload without replay, keyboard controls and measured narrow-window layout.
Normal shutdown completed with unchanged monitored source and no renderer errors
or external requests. Five native screenshots are retained with the receipt.

Earlier attempts are preserved: the first exposed the project-page title refresh
defect, the second had a test assertion against the wrong mission field, the third
prompted clearer draft previews, and the fourth incorrectly assumed Windows
outer-window width equaled renderer width. The final native proof uses the actual
mission request contract and measured content viewport. The full unchanged-source
regression is recorded separately in `desktop-verification-project-navigation-final.json`:
606 Python tests passed with 15 environment-dependent skips; all 226 JavaScript
tests passed. Its source snapshots match. Later packaging edits have their own
validation receipts and do not silently inherit this earlier source fingerprint.

Portable preparation now also has 19 synthetic assembler tests for exact inputs,
safe extraction, wheel integrity, dependency inventories, deterministic output,
relocation and no-overwrite behavior. These do not establish acceptance of an
assembled executable. The real portable bundle and native relocation remain
separate gates.

The portable input acquisition retains publisher SHA-256/size evidence for
Electron 44.3.0, Python 3.14.7, pypdf 5.9.0 and Pillow 12.1.0, plus the current
production Node dependency inventory. A bounded-reader allocation correction
reduced the synthetic assembler suite from 49 seconds to 1.5 seconds while
retaining growth and size rejection. See `docs/portable-desktop.md` for local
assembly, separate untouched-startup and test-derivative gates, and external
runtime resources. Build/native receipts must name the exact candidate; source
tests and archive hashes alone do not establish portable runtime acceptance.

Final review added acknowledged-save refresh for project row rename, pin and
archive, preserving whichever project or section is currently open. Eleven
project-navigation tests now cover this menu path and delayed acknowledgment;
the native fixture additionally checks actual committed row management. The
portable fixture inventories raw ASAR bytes through Electron's `original-fs`,
and production screenshot capture precedes window minimization. These follow-up
changes require their own unchanged-source regression and new candidate receipts.

Actual relocated acceptance reached PDF/image intake, finite specialist build
and execution, and DOCX export/readback before exposing node-pty's final-PATH-entry
shell lookup defect. Terminal startup now resolves an admitted shell to an
existing absolute executable before spawning it. This preserves the restrictive
test environment rather than masking the failure by changing PATH. The original
failed receipt and subsequent candidate-specific results remain separate.
