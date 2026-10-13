# Selected browser pages in Work

In the Browser pane, open a page and choose **Allow Work to read this page**.
The composer shows a removable **Work page** selection. Send in Work or Code
mode to let that mission request one bounded text acquisition from that loaded
page. **Use page in chat** keeps its existing behavior: it captures text
immediately as a conversation attachment.

Selection exposes the page identity, not its body. When the model calls
`acquire_selected_page`, the existing OrchestrationManager records acceptance,
the main process checks the operator's retained selection, and the existing
fixed browser extractor acquires text. CommitService records the validated
result before the next model call can use it. Page text remains untrusted
evidence and does not grant tools, permissions or persistence authority.

The selection expires after two minutes and permits one acquisition. The
source is tied to the owning desktop window, conversation, Work request, native
view and navigation revision. Navigating or reloading the page invalidates a
fresh acquisition, including a reload to the same URL. The Work detail pane may
hide the browser without navigating it; acquisition can read that same retained
document. It never opens or navigates a page on the model's behalf.

The extractor retains its existing limits: 32,000 characters, 64 KiB of text,
5,000 visited text nodes and a two-second deadline. It reads the main frame's
rendered text, excluding forms, editable controls and subframes. The complete
response is bounded separately. Source URL, title and text pass the existing
credential-pattern filter before commitment or model exposure. This is a
bounded excerpt, not proof of complete page coverage or factual accuracy.

The immutable optional `browser_source` request field uses
`yur.work-browser-source.v1`. It is audit metadata, not a bearer token. Only the
main process can retain the corresponding live grant. Models supply only its
`source_id`; the tool accepts no URL, selector, script, credentials or navigation
arguments. The ordinary Work authority envelope remains unchanged.

Two parent events retain the execution boundaries:

- `work.browser.acquisition.accepted` binds mission, tool step, exact input,
  selected source and authority hashes.
- `work.browser.result.committed` retains the validated context or a typed
  denial and its acceptance receipt.

A committed result is replayed before checking whether a live selection still
exists. It survives renderer reload, page closure and expiry. Lost commit
acknowledgments preserve the original acquisition identity. A read that was
never committed has no durable result guarantee; unavailable grants produce a
retained denial. Cancellation aborts the pending main-process acquisition and
uses the existing durable Work cancellation path. Late responses cannot grant
another read or revive cancelled work.

Only selected-page starts use the fixed `--browser-acquisition-v1` child
protocol. Other Work commands retain their EOF-based RPC contract. No new
orchestrator, browser automation service, database or execution runtime is added.
Recurring schedules do not inherit page selections, and new conversations,
branches and retries require their own selection.

Automated coverage is in `test_work_browser*.py`, browser-host/broker and Work
transport/view tests. Native acceptance uses an isolated loopback page and
fixture model decisions through the actual desktop and CommitService; those
fixture decisions are not a live-model evaluation.
