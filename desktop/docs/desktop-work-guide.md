# Using the unified desktop

Run **Setup YUR AI Desktop.cmd** once, then **Start YUR AI Desktop.cmd**. Select a
configured model in the composer. Work and Code currently require an Ollama model
with dependable tool calling. An unavailable provider never silently changes.

## Registered sources

Open **Cognitive Vault → Sources** to inspect the configured source groups.
Choose an available reviewed file and use it in the current conversation. Up to
three selections stay with that conversation's draft and survive reopening.
Remove a selection using its composer chip. Selections contain references and
hashes; they do not select a project folder or grant source execution.

Send reads the selected files again and checks the selected hashes. If a file
changed, refresh its evidence and select the current version before sending.
Only those selected excerpts enter context. Each file is limited to 128 KiB and
its excerpt to 16,000 Unicode characters and 64 KiB; the source details identify
any truncation. Binary, invalid UTF-8 and credential-like content are rejected.
Source browsing and acquisition create no mission or journal.

The user-selected `yur-os` root is configured independently from YUR-UNIFIED;
the [integration record](yur-os-integration.md) identifies its fifteen reviewed
files and actual Rust/Python contracts. Source availability does not establish
that the Rust service or its Wasm workers are running.

## Work and artifacts

Attach a repository or select a project, choose Work or Code, and describe the
outcome. The work panel shows actual steps, results, artifacts and mission status
after reopening the conversation. Stop cancels the exact provider request.

File edits are proposals. **Validate edit** checks the current file, then
**Apply reviewed edit** applies the displayed changes through Commit Service.
A changed file invalidates review. **Export artifact** creates a verified local
file. **Show file** rechecks its bytes. Studio's manual editor/terminal
remain available; models are not granted that terminal's host authority.

## Documents and interactive artifacts

Ask Work for a DOCX report, XLSX workbook or PPTX slide deck. Reports contain a
title, headings and paragraphs; workbooks contain named sheets, column labels and
typed rows; slides contain titles and bullets. The Work card identifies the
format and byte count. Expand **Preview content** to review its text, then select
**Export artifact** to create the actual Office file. Reopening the conversation
restores the same document and export receipt without asking the model again.

The journal stores a bounded recipe. Delivery regenerates and verifies the same
ZIP bytes. These document tools do not support macros, formulas, external links,
embedded images, templates or arbitrary Office features. Formula-looking cell
strings stay literal text. Numeric cells accept at most 15 significant digits;
exact identifiers or numbers outside the supported range must be text. The recipe
limit is 48 KiB, generated files are limited to 1 MiB, and workbooks contain at
most 2,000 cells including headers. The preview can be shorter than the document
and explicitly identifies that limit.

For a committed HTML artifact, select **Open interactive preview**. Its isolated
Artifact pane supports local interaction while blocking desktop APIs, external
network access, navigation and device access. The original source remains inert
in the Work record and can be exported as exact bytes. Closing the pane, changing
workspace or reloading hides the preview. It does not acquire host authority.

Native Desktop tests verified creation, preview, export and reload for all three
Office formats. Independent Python Office readers also opened the generated
files and verified their contents. These are local fixture outcomes; native
Microsoft Office rendering and live-model document quality remain unverified.

## Saved specialists

The desktop and the agent generator have separate responsibilities. The desktop
collects the user's intent, previews a specialist and opens its work. The existing
manager, validators and Commit Service build and retain executable packages.
Adding a builder surface does not introduce another generator or orchestrator.

Open **Agents → Create agent** for the guided builder. Name your specialist,
choose its main ability and optionally edit the sample or add more abilities.
The preview explains the selected behavior. **Build and check** starts a new Work
conversation and asks the existing tools to build and then run the sample.
Your prior conversation, draft and source selections stay in their original
conversation. An available Work-compatible model is required; setup appears
inside the builder when needed. Actual tool evidence in the Work record determines
whether the build and sample succeeded. A model response alone is not proof.

The five starter abilities below are the currently admitted deterministic
behaviors, not a claim of general agent generation. A name or description does
not generate new behavior. Custom Python generation remains a separate Code
workflow under **Explore libraries → Generated Python**. Secondary libraries and
workspace profiles are grouped under **Explore libraries**; chat remains unchanged.

Ask Work to build a specialist from text analysis, data profiling, support triage,
HATCH quantity extraction or quoted construction cost inspection. The existing compiler independently tests two
candidates and commits the selected executable package. Its card shows real
bindings and selection evidence. **Export specialist pack** materializes that
package. Later Work missions can discover and reuse admitted packages, retaining
the selection, parent and execution receipts without rebuilding them.

Open **Agents → My agents** (the default view) to browse those committed local builds
without starting a mission or calling a model. Inspect or export a package using
its recorded origin. **Use in conversation** prepares an editable Work draft;
Send still starts the work. Later execution must match the selected package and
an admitted capability. The catalog reports bounded coverage and excludes builds
that lack the required Work origin or current package validation. Copilot and
Workforce source profiles remain separate selections.

The guided builder takes its builder/preview/reusable-library interaction from
the user's `<yur-alpha-root>\EvoViper\ui\agent_forge\index.html` reference.
It does not copy that page's service connections, generated scaffolds, local
vault, provider assumptions or success logic. The reference file is unchanged.
Run `npm run test:specialist-forge` for the native desktop create/sample/reuse
journey against the real local manager and commits with scripted model replies;
this fixture does not establish live-model behavior or quality.

The construction inspector accepts explicit six-field pipe/tab rows or six-line
blocks: item, description, quantity, unit, unit price, total. It retains exact
source quotes and checks decimal arithmetic. A discrepancy is evidence for
review, not a quote approval or market-price assessment. Missing or ambiguous
rows remain excluded and visible. Both candidate strategies share this parser;
the package does not claim structural diversity for that capability.

Saved packages bind their exact admitted runtime revision. Packages produced
before the construction addition retain their original contents and use the
pinned historical implementation. The host never imports a package-supplied
runtime merely because it calls itself a YUR agent.

## Continuing concepts

Work can retain a named concept with a thesis and domain tags, then continue
that same identity in later missions. Its eight stages are Genesis, Inception,
Development, Stabilization, Maturation, Monetization, Regeneration and Evolution.
Conversation completion and mission completion do not advance that clock.

Genesis requires committed intent evidence. Inception requires committed charter,
success-criteria and constraint documents; those are plans. Development requires
an independently validated specialist package, its actual build evidence, and a
matching execution receipt. This permits entry into Stabilization for further
evaluation. It does not prove maturity, deployment, reliability or commercial
readiness. Missing later evidence leaves the stage unchanged and retains the
denied gate's reasons.

Each bound package version retains its original artifact and runtime hashes. A
later version must name its same-concept predecessor; the previous version stays
available. Package version ancestry and successor concept lineage are separate.
Evolution and successor concepts still require mature-concept evidence that the
current local adapters cannot supply.

## Code checks

Code mode also supports new generated Python specialists from an existing
acceptance contract. Prepare the contract before the mission, then ask YUR to
read its file hash and forge the worker. Inspect retained results in
**Agents → Generated Python** and choose **Use in Code** to prepare fresh input
for the exact saved worker. See the [contract format and example](generated-python-specialists.md).
Finite example matches and fresh output-schema checks have distinct meanings;
neither establishes industry or market readiness.

Code mode supports bounded serial Python compile and unittest checks.
It sends an exact bounded source snapshot, optionally including this mission's
edit proposals, to an already-running admitted WSL/Bubblewrap environment. It is
designed to retain the source and actual exit/output evidence through the same
CommitService. No host directory mount, network, package installation, new
processes or threads are admitted; scratch changes do not apply edits.

The admitted runtime's native boundary and interruption tests and three full
Desktop Code-mode fixture groups have passed, including compile, passing tests,
failing tests and a separately reviewed Apply. These checks cover this bounded
Python adapter; a general agent terminal and other execution runtimes remain
outside its admitted contract.
A live Qwen3.5:9b check also completed a failing-test, proposed-fix and
passing-staged-test sequence without applying the edit. That outcome is retained
separately from the fixture-based UI tests.
Missing or changed runtime dependencies must fail visibly;
the Desktop does not boot a guest or silently fall back to host execution.

## Browser and local voice

Open Browser beside chat and enter HTTPS. New sites require explicit navigation.
**Use page in conversation** acquires bounded visible text and URL/hash evidence.
Page text cannot grant tools or permissions.

Run **Setup Offline Voice.cmd** for optional offline English dictation. It installs
Vosk 0.3.45 in project Python and downloads the official small English model into
ignored `.desktop-models`. The installer verifies a pinned download hash and
records file hashes. Setup needs HTTPS; transcription needs no network. Models
and audio are excluded from source releases.

The microphone explicitly records up to 60 seconds. Stop releases the device
before recognition. The transcript enters the draft for review and requires Send.
Cancel discards pending audio/transcription. PCM is not journaled. Read aloud
uses only local system voices, when available. Recognition can mishear words.
Acceptance used a public WAV and fake device, without the operator's microphone
or speakers. Sources: [Vosk models](https://alphacephei.com/vosk/models) and the
[official recognition example](https://github.com/alphacep/vosk-api/blob/master/python/example/test_simple.py).

## Correcting active work

While an accepted Work or Code mission is running, type a text correction into
the same composer and choose **Send correction**. The selected folder, model,
mode and permissions stay fixed. The queue accepts up to eight corrections per
mission within a combined 32 KiB text budget.

The chat bubble shows whether the correction is queued or has entered the
mission context. A correction arriving during a model response prevents that
older response from launching more tools. An already-running bounded tool can
finish; its real result is retained before the corrected continuation.

If an acknowledgment is lost, the desktop checks the committed mission before
retrying with the same correction ID. Text you type during that check stays in
your draft. **Stop** and renderer reload retain their existing cancellation
behavior: an accepted correction that never reached a checkpoint is shown as
**Not consumed by the mission**. Reopening the conversation does not restart it.

`npm run test:steering` exercises this flow through the real desktop and local
CommitService using held model-response fixtures, including a lost acknowledgment.

## Work records and continuing development

### Understanding a failed run

Open the failed mission's Work record. When available, the desktop shows the
last committed diagnostic with its receipt. A WSL status-query timeout means
availability could not be determined during that check. A selection failure
and a runtime fingerprint mismatch are different recorded outcomes. Provider
empty-response diagnostics show bounded counts and stop reasons, without model
reasoning or raw response content. Reopening the record does not rerun work.

### Retaining generated agent development

Use **Agents → Generated Python** to select a saved worker, then continue it in
a conversation. Ask to bind its exact publication to a named Concept. The
Concept records immutable versions, validation evidence and later execution
receipts independently from conversation and mission completion. Its stage
advances only when the required evidence is accepted. See the
[generated specialist guide](generated-python-specialists.md) for source
identities and the acceptance limits.

## Recurring tasks

Open **Scheduled tasks**, create a task from a conversation, and review its goal,
folder, model, interval and run limit. Each run compiles fresh goal context and
uses the existing manager. File edits still require review. Pause cancels the
active run; Open last run shows its actual mission and results.

Schedules run while YUR Desktop is open. Idle schedules survive reopening;
closing during an active run cancels it and disables that recurrence. Enable it
again when ready. Failures remain visible and do not count as successful work.
Runs are bounded to 1–100, with intervals of 1–1,440 minutes. No OS background
service is installed.

## Reproducing the new acceptance checks

**Create agent → Build and check** reads the selected model's advertised tool
capability through the existing configured provider transport before creating a
Work conversation. Missing tool evidence or an unavailable provider leaves the
form intact. This check does not prove inference, validation, or a committed
outcome. The existing Work manager, specialist compiler, validators and Commit
Service retain those responsibilities.

`npm run test:specialist-forge` exercises this journey with native Desktop IPC
and fixture model decisions, including readiness rejection and saved reuse.
For actual provider acceptance, set `YUR_FORGE_TEST_MODEL=ollama:<installed-model>`
in the host environment and run `npm run test:specialist-forge:live`.
The test uses temporary Desktop/Factory state and the existing endpoint resolver
(defaults or `YUR_OLLAMA_URL`); it does not copy normal Desktop settings or state.
It does not install models or start services. Without a selected model it reports
available models and exits unsuccessfully without dispatching a build.
Its retained `result.json` identifies the test home and accepts success only
after the exact requested build and sample have committed evidence, independent
validation, matching artifact identity in My agents, and the expected sample
counts. Advertised tools support alone and assistant prose cannot pass the test.

After setup, `npm run test:documents` exercises the full Office UI and
`npm run test:artifacts/full` exercises committed HTML through the Artifact pane.
Both use an isolated Electron window, temporary local state and a local model
fixture. `npm run test:specialists` covers build, reuse and the saved catalog;
`npm run test:schedules` covers actual scheduled dispatch and cancellation.

`npm run test:execution` runs local adapter, probe and Work-binding contract tests
and explicitly skips the native
execution cases. `npm run test:execution:live` opts into the production adapter's
native tests; `npm run test:code:live` opts into the full Code-mode native
fixture. `npm run test:execution:probe` opts into
fixed-code boundary probes. These native commands require an already-running
compatible WSL environment and do not install dependencies or start a guest.
When multiple resources exist, select an admitted guest with the host
`YUR_EXECUTION_DISTRO` setting; the model does not choose that setting.
The fixed-code probe is diagnostic
evidence, not the application execution API. Do not treat its pass as acceptance
of the Work integration or of arbitrary hostile code containment.

The [mission ledger](../desktop-parity-mission.md) distinguishes fixture tests,
live model outcomes, native proof and unfinished features. This checkout is not
a signed portable distribution or enterprise certification.
