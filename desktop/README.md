# YUR AI Desktop

Double-click **Start YUR AI Desktop.cmd** in this folder or its parent workspace
to launch the desktop. The launcher uses this checkout's installed Electron and
does not install dependencies or start backend services.

For a fresh checkout, run **Setup YUR AI Desktop.cmd** once. It installs the
locked Node dependencies and creates `.desktop-python` from the pinned
`requirements-desktop.txt`. The app selects that isolated Python environment
automatically; `YUR_FACTORY_PYTHON` remains an explicit host override. This
source checkout needs Node, Python and a configured model service; it is not a
self-contained signed portable executable.

A separate [Windows portable candidate assembler](docs/portable-desktop.md)
combines reviewed local Electron/Python archives, pinned intake wheels, the
source allowlist, and an inventory of production Node dependencies. It produces
an unsigned folder/ZIP with a top-level launcher and byte-level attestation.
Each candidate requires matching relocated acceptance receipts demonstrating
operation without host Node or Python. Providers, the reviewed WSL execution
runtime, and optional voice resources remain separate.

The current desktop mission and verification boundaries are tracked in
[desktop-parity-mission.md](desktop-parity-mission.md), with primary product
research in [desktop-reference-research.md](docs/desktop-reference-research.md).
Chat supports Markdown/code actions, projects, message search, branches, drafts,
themes, streamed Ollama responses and Stop. Attachments support text, PDF text,
Word, Excel and PowerPoint extraction. Native image files are reacquired by hash
for a selected Ollama model that advertises vision support. Scanned PDFs need
image/OCR processing; formulas and macros are never executed.

See the [desktop work guide](docs/desktop-work-guide.md) for governed Work,
specialist packages, the browser, optional offline voice and recurring tasks.

[Model setup, shared project files and Recent Work](docs/desktop-usability.md)
cover explicit provider selection, retained reference documents across
conversations, stable reading position during tasks, saved artifact discovery
and the bounded Work queue. These source features require a newly assembled
portable candidate; previously packaged folders keep their original source.

For on-demand page evidence, open a page in Browser and choose **Allow Work to
read this page**, then send in Work or Code mode. The mission may acquire that
selected document once and retains its text, source and receipt. See
[selected browser pages](docs/selected-browser-page-work.md) for expiry,
navigation, recovery and extraction limits.

`npm start` opens the conversation workspace: recent conversations, a central
composer, model selection, explicit text-file context, and returned work evidence.
Agents, Capabilities, Workflows, and Cognitive Vault have dedicated pages within
the conversation interface. They reuse existing workspace definitions and returned
conversation evidence. Studio uses the same interface for files, code, previews,
and the terminal. Moving between sections preserves open editor tabs, unsaved
code, and the current conversation draft.

Chat can read a local repository: paste its absolute folder path with your question,
or use **Attach repository** beside the message input. Each turn acquires bounded
source excerpts from that folder and shows the actual file hashes and line ranges
in **Work details**. Repository selection follows its conversation. Missing folders
fail visibly before inference; credentials, runtime state, dependencies and build
output are excluded. Source reads do not execute repository code.

**Projects in the sidebar** open a home for shared instructions, source folders
and related conversations. Start a separate Chat, Work or Code conversation from
that project; existing drafts stay intact. Header mode buttons also support arrow,
Home and End keys and stay locked while a response is active. See
[project navigation](docs/project-navigation.md) for behavior and validation.

**Cognitive Vault → Sources** lists the configured YUR ecosystem sources and the
separate `yur-os` source. Inspect one reviewed file, then select it for a
conversation. Up to three selections persist with the draft; Send reacquires
each exact file and verifies its hash before providing bounded source context.
A changed file requires refreshing its selection. This preserves source identity
without executing donor code or adopting a donor's orchestration authority.
See [yur-os integration](docs/yur-os-integration.md) for configuration, reviewed
contracts, acquisition limits, and the remaining runtime integration boundary.

Under **Capabilities → Awesome Copilot** (also available in Agents), search the
local library, open a skill, agent profile or instruction file, and choose **Use in
conversation**. Its complete bounded Markdown content is acquired for the selected
model with source/version evidence. The approved library on this host is
`C:\User\caches\agentPlugins\github.com\github\awesome-copilot`; set
`YUR_COPILOT_LIBRARY` to relocate it. Selection applies instructions; referenced
scripts, tools and services are not installed or executed. Source stays in place
and retains its license and provenance.

**Agents or Capabilities → Explore libraries → Hermes skills** opens the
YUR-versioned Hermes snapshot. It contains 177 active and optional skills and
774 inert skill support files and 27 package documentation files from `hermes-agent` 0.18.2. Selecting a skill verifies
its instruction file and every declared support-file hash before adding the
instructions to the current conversation. It does not execute support scripts,
start MCP servers, install dependencies or grant authority. See
[Hermes skills integration](docs/hermes-skills.md) for the import boundary,
version evidence and refresh command.

**Agents → YUR Workforce** reads the existing source at
`D:\YUR-UNIFIED\agents\workforce` (override with `YUR_WORKFORCE_SOURCE`). Its
23 profiles retain their Genome identity, lineage, receptors, emitted signals,
declared dependencies and source hashes. **Use in conversation** supplies the
selected profile to your chosen model alongside repository context and skills.

**HATCH Quantity (Survey) → Run quantity survey** executes the admitted local
quantity worker through the existing OrchestrationManager and CommitService.
Paste plans/specifications text to extract stated quantities, CSI divisions and
exact source references. Complete results remain retrievable from **Work details**
after reload. Other workforce profiles provide conversation guidance; their
legacy handlers and lifecycle controllers are not executed. See
[workforce integration](docs/workforce-desktop.md) for scope and verification.

The desktop uses the existing Cognitive Foundry `/api/ask` bridge. Configure
`YUR_FOUNDRY_URL` to the running service origin; the previous default remains
`http://127.0.0.1:8844`. Local or cloud models exposed through your Ollama service
are selectable explicitly. A failed harness request does not switch providers.
The desktop does not start a backend service automatically.

Conversation history is committed locally through the existing CommitService
implementation into a separate conversation journal. It never represents mission
completion, specialist admission, or execution authority. See
[conversation desktop](docs/conversation-desktop.md) for configuration and checks.

**Agents → Generated Python** contains new worker code produced from an existing
operator-supplied acceptance contract. In Code mode, YUR generates two isolated
candidates, evaluates their actual outputs inside the existing execution cell,
and retains a passing worker for later missions. Its expected outputs are checked
outside the candidate process; generated code is never imported into the Desktop.
The [generated specialist guide](docs/generated-python-specialists.md) includes
the contract format, a quantity-rollup example and the finite validation limits.

## Existing specialist factory

A local specialist-agent factory integrated into the existing YUR Studio desktop.
It builds executable packages, tests their outcomes, records why a candidate was
selected, and commits immutable artifacts with provenance. The new factory runs
with Python standard-library dependencies and the existing Electron installation.

This is a **local release candidate**, not an enterprise or industry-leadership
certification. The built-in pack capabilities are text analysis, data profiling,
support triage, source-backed HATCH quantity extraction, and quoted construction
cost inspection. External pack metadata is discoverable but requires separate
capability admission before it becomes executable.

## Launch

From this directory, with Node 22.12+ and Python 3.11+ available:

```powershell
npm run factory
```

The conversation workspace and its Studio remain available through `npm start`
and from the factory's Open Studio button. For a fresh checkout, install desktop dependencies with
`npm ci`; no Python package installation is required for the factory. The factory
has its own isolated window, local resources, strict CSP, and narrow IPC.

Create a mission, choose executable capabilities, and process the queue. The
Automatic queue control runs subsequent passes with an explicit cycle ceiling
and interval; Stop prevents the next pass while current bounded work finishes.
Inspect
the candidates and validation evidence, run the committed specialist on JSON
input, or export its deterministic ZIP. Export location and hashes are shown in
the console. The export runs independently through `python -B agent.py`.

## CLI and continuous processing

```powershell
python -B -m foundry.factory_cli health
python -B -m foundry.factory_cli catalog
python -B -m foundry.factory_cli submit --name "Evidence Analyst" --description "Profile operator-provided records and text" --capability data.profile --capability text.analyze --idempotency-key evidence-analyst-v1
python -B -m foundry.factory_cli process --max-missions 1
python -B -m foundry.factory_cli list
python -B -m foundry.factory_cli inspect MISSION_ID
python -B -m foundry.factory_cli export MISSION_ID
python -B -m foundry.factory_cli watch --max-cycles 120 --interval-seconds 30 --max-missions 4
```

The desktop's automatic queue uses the same manager through a main-process
cadence timer. It stops on error, budget exhaustion, or factory-window closure;
its timer settings do not survive app restart. Mission state stays durable.

`watch` processes newly queued missions without repeated human actions. Its cycle
ceiling is explicit; Ctrl+C stops it between bounded operations. It does not
invent new market requirements or authorize external actions. A process restart
can recover interrupted missions up to three attempts. Duplicate submission keys
return the original mission; changed input with the same key is rejected.

For programmatic use, `python -B -m foundry.factory_cli rpc` reads one JSON request
on stdin and emits one `{ok,result}` or `{ok:false,error}` envelope. The desktop
and core-agent adapter use this same interface.

## Environment and source authority

| Setting | Purpose |
| --- | --- |
| `YUR_FACTORY_PYTHON` | Python executable used by Electron and verification |
| `YUR_FACTORY_HOME` | Explicit local operational state directory |
| CLI `--home PATH` | Override state for this CLI invocation |
| `YUR_ECOSYSTEM_ROOT` | Read-only YUR ecosystem root for named source slices |
| `.factory-sources.local.json` | Ignored machine-local alternative for source discovery |

The desktop defaults to `app.getPath('userData')/factory`; the CLI defaults to the
OS state directory's `yur-foundry`. **Set `YUR_FACTORY_HOME` to the same directory
when the desktop and CLI should share a queue.** State must be a local path without
symlinks or Windows reparse points. It contains a SQLite database, OS worker lock,
and derived exports. Do not place state, credentials, keys or local path settings
in source control.

`sources --query terra --limit 12` reads only explicit manifests and the catalog's
global metadata index. It does not recurse through the corpus, follow arbitrary
catalog paths, load donor code, inspect credentials, or grant execution rights.
The supplied TERRA/catalog/core/governance/infrastructure roots are mapped in
[the source assessment](docs/source-assessment.md).

## Core YUR agent integration

The [YUR core plugin adapter](integrations/yur-agent/README.md) uses the actual
Plugin/Action contract from the supplied `yur-agent` core. It binds only the
capabilities of a completed, validated mission. The adapter calls the factory
for bounded execution and receives provenance receipts. It does not instantiate
another runtime or copy the core's orchestration.

## Verification and packaging

```powershell
npm test
npm run test:electron
npm run package:source
```

`npm test` checks JavaScript syntax, Python integration/adversarial cases, desktop
security helpers, and the YUR plugin transport. `test:electron` exercises the real
local renderer and Python IPC using temporary state. It requires a desktop
session and installed Electron. `package:source` reruns verification and creates
a deterministic source ZIP with per-file hashes, excluding dependencies and
machine state. Signing and an installer/update channel are still release gates.

See [architecture](docs/architecture.md), [operations](docs/operations.md), and
[release readiness](docs/release-readiness.md) for exact boundaries and evidence.

## Capability overview

Open **Capabilities** for the shared desktop overview, including feature entry
points, requirements and source-only libraries. Chat, Work and Code use the same
source-owned description. See [how capability answers are grounded](docs/desktop-capabilities.md).

## Live agent activity

Open **Activity** to follow current Desktop-managed Chat, Work/Code, schedules and factory requests with live phases and tool timelines. See [Live activity](docs/live-activity.md) for scope and retention.
