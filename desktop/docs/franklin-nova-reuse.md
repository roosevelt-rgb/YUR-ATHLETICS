# Franklin: Nova donor reconciliation into Desktop

Source inspected on 2026-10-03. The selected Desktop remains the runtime binding;
Nova and YUR AI World are unchanged donors for this extraction.

## Donor sources and promoted behavior

- `<workspace>/2026-10-01/task-5/franklin_adapter.py`:
  `department_memory` (line 124) supplies bounded recent user/assistant memory;
  `run_department` (lines 376–443) submits typed work through the existing
  `OrchestrationManager`, retaining request identity and event receipts.
- `<workspace>/2026-10-01/task-5/workflow_contract.py` and
  `structured_provider.py`: typed action/provider boundaries and independent
  argument validation. Their pool specialization and fixed provider are omitted.
- `<workspace>/2026-10-01/task-4/nova-source/public/copilot-actions.mjs`:
  `validateNavigation`, `activatePanel`, `previewReview`, `hydrateStudio`, and
  `navigateStudio` demonstrate typed navigation intent with a host-owned binding.
- `<workspace>/2026-10-01/task-4/nova-source/public/copilot.js` and
  `lib/franklin-conversation.ts`: persistent assistant presentation and conversation
  identities inform the Desktop UI adaptation; browser storage is not promoted
  into authoritative state.

This is a responsibility-level adaptation, not an import of the donor service.
No second HTTP service, orchestration manager, donor database, fixed model digest,
credentials, pool design schema, or inherited mutation authority is introduced.

## Reconciled contracts

`FranklinCommitMixin` owns additive `franklin_documents` and `franklin_events`
tables inside Desktop's existing CommitService SQLite journal. Preferences,
accepted conversation requests, public final summaries, and host action receipts
have independent revisions and a hash chain. Work missions retain their existing
state and lifecycle. Hashes detect accidental/partial mutation; they are not
signatures or protection against rewriting the whole database.

`franklin_cli` accepts one bounded NDJSON request, emits event and host-action
frames, and receives only the matching host result. It compiles up to twelve
recalled messages (12,000 characters total), the current user task, and at most
32 KiB of observed environment into the actual Work request. This corrects the
donor workflow path which read history but passed only the latest user message
at the adapter call sites (donor lines 472/482; compare legacy 543/558/564).
Only public user/assistant messages are retained; provider private reasoning is
not requested or stored in this conversation lane.

`desktop_action` retains its seven navigation/browser operations and adds eight
bounded operations: `media_catalog`, `media_list`, `media_inspect`, `media_status`,
`media_draft`, `workforce_catalog`, `workforce_profile`, and `model_catalog`.
The main host injects existing media and workforce read bridges and the configured
model catalog. A workforce profile remains source context, not permission to
execute a donor handler. Model catalog reads do not change model selection.
The model cannot supply JavaScript, file paths, arbitrary IPC, provider endpoints,
new infrastructure requests, purchases, installations, or extra authority.
All acquired content is untrusted context, never an instruction source or
authority grant. Read results have a 96 KiB budget; list and model counts are bounded.

`media_draft` validates the two existing presets and prepares only the existing
Media form. Its request UUID is derived from the committed action ID. The host
waits for owner-bound view acknowledgment, reports `submitted: false`, and leaves
review and generation to the operator's existing Generate action. Cancellation
before the view handoff prevents preparation; an interrupted or uncertain action
is never automatically replayed. This binding does not call media submission,
resume, cancel, imports, exports, or provider configuration. Existing media stays
in its factory journal; Franklin stays in its conversation journal. No nested
generation worker lock or second orchestrator is introduced.

An action intent is committed before invoking the host; its result is committed
before Work records the tool step. Accepted/failed/uncertain actions cannot be
silently reissued after a crash. Same-request replay verifies the input digest
and returns the existing snapshot without inference or host calls. Recovery
takes the existing worker lock, reconciles completed missions, cancels unfinished
ones and marks unanswered host receipts uncertain. It does not restart work.
The host also performs this reconciliation after a crashed, timed-out or
protocol-rejected turn, waiting for the child process to exit first. Recovery
cannot take ownership from a live worker, and application shutdown cannot launch
a replacement recovery process. If recovery is unavailable, its pending status
remains explicit rather than claiming an interrupted turn has completed.

The adapter uses the selected Ollama model or an `openai:` model through the
existing provider-neutral Work contract. Only trusted host environment supplies
`YUR_FRANKLIN_OPENAI_URL` / `YUR_FRANKLIN_API_KEY`; renderer/model payloads cannot
choose endpoints or credentials. `YUR_DESKTOP_HOME` supplies the existing journal
root. No provider request is performed by importing these modules.
When both a trusted endpoint and a bare `YUR_FRANKLIN_MODEL` are configured, the
initial preference resolves to `openai:<model>` consistently with the host picker.

The snapshot targets 512 KiB of visible history and caps the complete serialized
snapshot at 768 KiB, leaving room inside the host's 1 MiB frame limit. A
`history_truncated` flag describes the projection; durable messages and request
identities are retained. Replay identities are
not evicted; the bounded admission capacity fails closed for operator archival.
Navigation to media, workforce, marketplace or workflows exposes those existing
views. It does not itself grant purchases, deployment, installation or execution.
Franklin still uses Work mode without a selected repository. Repository/Code-mode
authority requires a future explicit operator selector and is not inferred from
browser content or the visible coding workspace. Existing pure Work specialists,
including the admitted HATCH quantity capability, remain available through Work.
