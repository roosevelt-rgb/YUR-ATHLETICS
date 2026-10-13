# Conversation desktop

The default Electron window opens a conversation-first YUR workspace inspired by
the user-supplied CarGurus, ChatGPT, and Hermes references. The existing Studio is
retained in the same document so changing views does not discard editor models,
open files, or terminal state. No second orchestration runtime was introduced.

## User flow

- Start a conversation or search and reopen a saved one.
- Choose YUR harness Auto, a harness-discovered model, or an explicit Ollama model.
- Attach up to five text/code files. File context is sent only with a submitted
  message, with size limits and credential-file exclusions.
- Submit and continue the conversation. The composer moves beneath the messages.
  Switching conversations does not redirect an outstanding response to another chat.
- Open Work details for connection state and any sources, artifacts, mission IDs,
  validation data, or receipts actually returned by the harness.
- Open Agents, Capabilities, Workflows, or Cognitive Vault within the same desktop
  shell. Search the existing workspace definitions, inspect details, or return to
  the current conversation without losing its draft. Catalog entries are not
  newly verified live agents; availability is labeled accordingly. Vault also
  includes evidence actually returned in saved conversations.
- Open Studio in the same desktop shell to open folders and files, edit and save
  code, preview HTML and diagrams, or use the terminal. Navigating away preserves
  the existing editor models, unsaved changes, and terminal session. Ctrl+N creates
  a file while Studio is active and a conversation elsewhere. The existing
  Specialist Factory remains a separate-window action inside workflow details.

## Connections and state

| Configuration | Behavior |
| --- | --- |
| `YUR_FOUNDRY_URL` | Existing Cognitive Foundry service origin; default `http://127.0.0.1:8844` |
| `YUR_OLLAMA_URL` | Explicit Ollama service origin; default `http://127.0.0.1:11434` |
| `YUR_DESKTOP_HOME` | Absolute conversation journal directory; default Electron userData/conversations |
| `YUR_FACTORY_PYTHON` | Existing Python executable override, also used by the journal CLI |
| `YUR_COPILOT_LIBRARY` | Local Awesome Copilot source directory; this host defaults to the exact operator-supplied `C:\User\caches\agentPlugins\github.com\github\awesome-copilot` |

The Foundry contract remains `POST /api/ask` with `query`, `provider`, and optional
`model`. Because this contract has no verified conversation-history endpoint,
the desktop compiles the current conversation into the query. Ollama receives
the message array through its existing `/api/chat` adapter. Context over the
configured limit is rejected visibly, never silently dropped.

## Local repository context and selected instructions

Paste an absolute repository folder with a question or use **Attach repository**
beside the composer. A fresh read happens before inference, using the existing
descriptor-checked reader and bounded Python bridge. The connector rejects
reparse paths, drive roots, credentials and runtime state. It inventories up to
1,500 nodes at depth five, reads up to 16 source files / 2 MiB and supplies at
most 32 KiB of excerpts. It ranks root manifests, entry points and question terms;
the result lists line ranges, original file hashes, read limits and omissions.
Questions naming an existing relative source path read those named files;
root `package.json` does not select nested projects' manifests. General repository
questions use a bounded overview instead. The evidence identifies the selection.
This is task-specific context, not an assertion that the entire tree was read.
An explicit read refusal in the current message skips repository acquisition.

**Capabilities → Awesome Copilot** and **Agents → Awesome Copilot** browse the
operator's local library. Search by resource name/path, filter by type, load more,
and choose **Use in conversation**. The adapter supports `skills/*/SKILL.md`,
`agents/*.agent.md` and `instructions/*.instructions.md`. It validates the library
manifest, preserves the license, and reacquires the selected complete Markdown
file (at most 64 KiB) with a matching SHA-256 on each submitted turn. Changed or
missing files stop the request and require a fresh selection. No linked scripts,
tools or remote services are installed, followed or executed by this adapter.

Both read operations use the existing Python RPC transport but return before
opening factory state or constructing OrchestrationManager. The selected local
context is compiled into the existing Foundry query or Ollama messages. Models
cannot call the reader or broaden its authority. Selection and read metadata are
committed through the existing conversation journal; fresh source excerpts are
not saved there. Work details labels local reads separately from harness receipts.
Removing the composer chip excludes that context on the next submitted message.

`npm run test:repository` exercises the actual native Desktop, Python reader and
journal against temporary repository/model fixtures, including changed-source
follow-ups, missing folders, source hashes, reload and credential exclusions.
`npm run test:repository:live` uses an already installed local Ollama model against
this app's actual repository without uploading to a cloud provider.
`npm run test:copilot` tests library selection, acquired instruction content and
conversation evidence through the native Desktop against isolated fixtures.

The selected backend handles inference; selecting a model does not grant tool
permissions. A failed request stays failed and never silently switches to another
provider. The UI does not invent agents, successful execution, or commit receipts.
Ollama is a service gateway and may expose cloud models as well as local models.

Conversation snapshots and their revision events use the existing CommitService
implementation with distinct tables and an explicit conversation-state authority
envelope from the trusted desktop adapter. They use a separate state directory
from the factory. Conversation IDs and revision clocks are separate from mission
IDs, lifecycle stages, validation, and artifact commitments. Revision conflicts
fail closed. The journal hash chain is integrity evidence, not a digital signature.

The home surface uses local HTML/CSS/JavaScript and no remote fonts or UI libraries.
Studio loads the existing versions of Monaco, Mermaid, and terminal libraries
from installed local dependencies on demand. No CDN or remote fonts are needed
for these surfaces. Failure to load a dependency is visible and does not prevent
returning to chat. Install dependencies with `npm ci` for a fresh checkout.

## Verification

`npm test` runs JavaScript syntax, transport/security, storage, and existing
factory regression tests. `npm run test:conversation` runs the real Electron
preload and main process against an explicitly identified local HTTP fixture and
isolated temporary journal. It covers multi-turn context, attachment text, model
selection, chat switching during requests, persistence after reload, failed
requests, safe rendering, and Studio navigation. It also uses the real local
Monaco, Mermaid, and xterm libraries, verifies independent preview tab contents,
and exercises native file open/save against temporary fixture paths. This is a contract test, not
evidence that the user's production harness executed a mission.

`npm run test:conversation:live` is an optional smoke check against an already
installed local `llama3.2:latest` through Ollama. It uses temporary conversation
state and captures the actual Electron UI. It does not download a model or test
governed harness execution.

The selected Desktop previously pointed at Foundry port 8844. During this change
that endpoint refused connections, while the existing Ollama service responded.
The desktop connection is configurable; starting or identifying the intended
live Foundry service remains necessary for live harness mission verification.

## Checked on 2026-09-12

- Local-context follow-up: 100 Python tests and 51 JavaScript tests passed; one
  Windows symlink-privilege test was skipped. Native repository and Copilot
  fixtures passed 5 and 7 checks respectively, and the 18-check conversation /
  Studio regression also passed. Final local Ollama verification returned the
  exact `studio-electron` and `src/main.js` values from root `package.json`.
  Repository receipt: `yur-repository-smoke-5Q3qk0/repository-smoke-result.json`;
  library receipt: `yur-copilot-smoke-phtNJU/copilot-smoke-result.json`, both in the
  host temporary directory. The live inference check used no fixture answer.
- Full verification: 78 Python tests and 42 JavaScript tests passed; one Windows
  symlink-privilege test was skipped. Reparse-point rejection was tested separately.
- Native Electron fixture: 18 checks passed, including draft recovery, background
  save errors and retry, all five sidebar destinations, real editor model retention,
  native file open/save, independent HTML/diagram previews, terminal retention,
  and 800 x 700 responsive layout. No renderer errors or external asset requests.
- Live local Ollama: `llama3.2:latest` returned `YUR desktop connection verified`
  through the actual preload/IPC path, and the response was committed to the
  isolated test journal.
- Native captures were inspected at 1440 x 960 and 800 x 700. Electron's renderer
  needed execution outside the tool sandbox for the capture tests on this host.
- Final Studio receipt: `conversation-smoke-o9FhB8/conversation-smoke-result.json`
  in the host temporary directory. The real PowerShell PTY produced the requested
  output marker and was closed after the check. Sandboxed HTML A/B/A contents
  were verified through messages from the actual child frame. Hidden-window
  captures on this host do not paint that isolated iframe; those images alone
  are not visual acceptance of the HTML preview. Editor and diagram captures
  were inspected separately.

## Navigation correction

All five primary sidebar destinations, including Studio, now render inside
`#yur-conversation`, preserving its sidebar, URL, conversation, and draft. The
remaining legacy `yurWorkspace.open()` entry point dispatches to this shell.
Studio mounts the original editor, file tree, and terminal DOM once, retaining
their models and state instead of exposing the old surrounding layout. Native
navigation tests cover all primary routes and real Monaco editing across view
changes; file dialogs use temporary test paths and the real preload/file IPC.

The installed Monaco 0.52 occurrence highlighter leaves a rejected cancellation
promise when a preview model changes during its pending highlight delay. Studio
disables occurrence marking through the editor's supported option; syntax
highlighting, editing, and other editor features remain enabled. This prevents
the failing jobs without suppressing renderer errors globally.
