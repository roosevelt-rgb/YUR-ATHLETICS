# Model setup, reading continuity and shared project files

This extends the existing YUR Desktop conversation surface and its existing
OrchestrationManager/CommitService. It does not create a second agent runtime.

## Using the desktop

- Choose an available model in the setup card and select **Use this model**.
  **Use as default** saves the selection for new conversations. Connection
  settings distinguish an unreachable service from an online Ollama service
  that has no models. Work and Code currently require a tool-capable Ollama model.
- Scroll earlier in a conversation while work continues. Updates preserve the
  reading anchor and existing message elements. **Jump to latest** resumes
  following the response; switching conversations retains each reading position
  while Desktop remains open.
- Open **Recent work** to search goals, answers and artifact names across the
  latest 200 recorded missions. Open the exact work record, artifact or owning
  conversation. Recorded status is not a claim that a worker is currently alive.
  Browsing does not restart tasks or export files.
- Open a project and use **Add files** to retain a shared text, PDF or Office
  reference. Start or open a conversation in that project, then use **Project
  files** to select up to eight references for that conversation. Selection is
  saved after the journal acknowledgment. Each new conversation chooses its own
  references. The source folder and uploaded references remain separate.
- **Remove from project** removes a reference from future selection. Previously
  recorded evidence and immutable source bytes remain retained. A conversation
  still selecting a removed reference must clear that selection before Send.

## Execution and persistence

Work transport uses a finite FIFO with at most four operations, one dispatched
at a time. It retries only typed contention on the existing canonical worker
lock with the same immutable request. Queue waiting and execution each have a
finite deadline. Stop targets the exact request, including a waiting request;
scheduled work retains its claim when transport capacity is busy. A child must
close before the next operation is dispatched. This is transport scheduling,
not a new owner of mission state.

Project files use schema 9 in the existing CommitService. Byte snapshots,
extraction snapshots, collection revisions, immutable operation IDs and chained
receipts are separate from project metadata. Import checks the selected source
hash and stores the same bytes it acquired. Retrying an acknowledged or uncertain
operation resolves its original receipt before stale revision checks or a new
source read. Changing projects clears that conversation's live file selection;
branching within a project retains the selected identities without replaying work.

Only explicitly selected versions enter compiled task context. Their IDs,
source hashes, extraction hashes, excerpt hashes and truncation evidence are
recorded with the user message. Missing, removed, changed or foreign references
fail before model dispatch. Shared references never expand the task's filesystem
root or execution permissions. Provider settings changed during preparation stop
dispatch; personal instructions are captured at Send rather than read later.

Bounds: 16 MiB per imported file; 32 active references per project; 128 retained
references/128 MiB per project; 256 references/256 MiB of unique retained bytes
globally. Context accepts eight selections, 16,000 characters per file, 48,000
characters/64 KiB total excerpt bytes and 96 KiB serialized context, within the
existing conversation/Work envelope limits. Images remain conversation attachments.
These limits are explicit admission limits, not automatic eviction of evidence.

## Verification and limits

`tests/desktop-usability-smoke.cjs` exercises real Electron/preload/CommitService
with isolated state and loopback model replies: explicit setup, retained drafts,
reading state through actual tool progress, artifact discovery and reload without
replay. `tests/project-files-smoke.cjs` exercises committed reference reuse and
stale selection refusal. Unit/integration tests cover queue contention, cancellation,
CAS conflicts, exact-operation replay, schema migration, tamper detection and backup.
Native screenshots and invocation receipts are generated separately from source.

This work does not establish full ChatGPT service parity, domain outcome quality,
commercial signing, account sync, execution while Desktop is closed, or general
enterprise acceptance. The portable distribution requires a new attested build
after source changes; an older packaged candidate does not receive these edits.
