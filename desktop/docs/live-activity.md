# Live agent activity

Open **Activity** in the Desktop sidebar to follow work across conversations.
The page shows Chat responses, Work and Code missions, recurring scheduled work,
and specialist factory requests observed by this running Desktop host.

Each request has a stable identity, its model when applicable, queue/execution
phase, elapsed time, age of its last observation, tool states and a bounded event
timeline. Existing conversation titles identify loaded conversations. Open the
associated Work record for committed outcomes and receipts.

The host pushes changes and the page refreshes the read-only snapshot every two
seconds. A connected snapshot proves the host responded; it does not fabricate
worker progress. A quiet request keeps its actual last-event time. A failed or
stale connection is shown explicitly. Queued work is not presented as running,
and stop requests remain unconfirmed until the actual transport outcome arrives.

Model phases report when a provider request starts, returns or fails. They do
not expose private reasoning. The aggregate feed excludes prompts, response
text, source contents, tool arguments, raw stdout and error payloads. Streaming
Chat reports a count of received output characters, not an invented token rate.
Tool requests may still be checking their arguments or bindings; completed tool
events follow the existing committed result.

This is an in-memory observation feed, not another orchestrator or state store.
The existing OrchestrationManager and Commit Service still own durable Work.
Scheduled requests pass through the same Work transport and remain visible even
when no conversation owns their UI. Factory completion describes the local RPC
finishing; it does not declare every mission in a batch successful.

Up to 64 requests, 80 observations per request and 20 tool steps are retained.
Active requests are preserved; truncation counts disclose omitted history.
Renderer reload reconnects to the same host feed without rerunning work. Closing
the host resets this session feed; durable records remain in Recent work.
Unconnected external runtimes, catalog profiles and historical running records
are not counted as currently active agents.
