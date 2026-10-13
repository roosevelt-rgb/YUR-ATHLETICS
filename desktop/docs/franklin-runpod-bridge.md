# Franklin queue model bridge

`foundry/runpod_work_provider.py` adds a bounded RunPod queue transport beneath
the existing callable Work model contract. It reuses OpenAI message conversion,
registered tool schemas, argument validation and public response parsing. The
existing OrchestrationManager and CommitService retain all work, tool, state and
commit authority. No provisioning, model download or runtime fallback occurs.

The already prepared Franklin trial uses the pinned vLLM worker's exact input:
`input.openai_route=/v1/chat/completions` and `input.openai_input` containing the
existing explicit model/messages/tools. Streaming is false, output is capped at
4,096 tokens, and the existing trial's `chat_template_kwargs.thinking=false`
avoids requesting private reasoning. Only public content and validated tool calls
are forwarded. The worker supports this shape in its
[pinned v2.28.0 handler](https://github.com/runpod-workers/worker-vllm/blob/v2.28.0/src/handler.py).

## Trusted host selection

| Environment binding | Meaning |
|---|---|
| `YUR_FRANKLIN_RUNPOD_URL` | Exact `https://api.runpod.ai/v2/<endpoint-id>`; no credentials, extra path, query, fragment, escaped IDs or alternate origin |
| `YUR_FRANKLIN_RUNPOD_MODEL` | Exact served model admitted by the host; no model is invented or silently substituted |
| `YUR_FRANKLIN_RUNPOD_API_KEY` | Host bearer credential; headers only, never persisted or sent to renderer/model input |

The existing `openai:<exact model>` identity remains provider-neutral. Only an
exact match to `YUR_FRANKLIN_RUNPOD_MODEL` selects queue transport in
`franklin_cli.model_adapter_for`. Other OpenAI/Ollama models retain their existing
adapters and endpoints. A configured transport is not proof that the pinned model
or endpoint passed runtime acceptance. The dedicated model remains subject to the
existing billable-provisioning hold and trial acceptance.

## Submission, deadlines and cancellation

Each model call commits a body-free `submit_intent` before its one `/run` POST.
The returned exact job ID is committed before polling or using output. The adapter
polls only `/status/<that-id>` and can cancel only `/cancel/<that-id>`. It never
calls retry, queue purge, infrastructure or arbitrary worker routes. A malformed
or lost submit acknowledgment blocks further submission by that adapter; there
is no automatic replay with new identifiers.

The host factory uses a 1,200-second outer cold-start deadline. Every HTTP exchange
has its own absolute 20-second maximum, including trickled bodies. Normal polling
waits one second and checks the owner cancellation predicate in at most 50 ms
sleep slices. The HTTP reader allows at most 512 KiB, rejects duplicate/nonfinite
JSON, validates exact job IDs/states, refuses redirects, and rejects a public
completion or receipt identity that echoes the host credential.

On local cancellation, timeout, known-job status failure or failed acceptance
commit, one exact-job cancellation attempt runs with a five-second cleanup
deadline. Direct adapter callers may select at most ten seconds. A cancel
acknowledgment is insufficient: a subsequent exact `/status` must say `CANCELLED`
before `cancel_confirmed=true` is emitted. Completion racing cancellation is
reported as `COMPLETED` with cancellation unconfirmed. Missing/malformed/expired
remote state remains unknown. The request retains the existing trial's
600,000 ms execution policy and 1,800,000 ms TTL; these are separate from the
client deadline and do not create a dollar cap.
[RunPod request and policy contract](https://docs.runpod.io/serverless/endpoints/send-requests).

The main host must first commit local cancellation, stop authorizing host actions,
retain the active owner reservation while the child cleans up, and allow a
35-second grace before force termination. App shutdown needs the same sequencing.
Force termination, host loss, network failure or a lost POST acknowledgment can
prevent confirmed remote cancellation. No local stopped/cancelled label proves
that GPU billing ended.

## Existing durable provenance and recovery

While Work is running, existing CommitService checkpoints record
`work.provider.queue.<phase>`: schema, transport, logical call ID, endpoint ID,
exact model, request hash, known remote job ID, status transitions, terminal
state and successful response validation. Bodies, credentials, headers, provider
errors and private reasoning are excluded. Intent-commit failure causes zero
network calls. Failed job-ID commitment triggers bounded cancellation.

Existing terminal Work rules are preserved. Once another owner process has
committed local cancellation, later provider events are live telemetry with
`durable=false`; they are not appended by weakening terminal-state rules. Earlier
accepted job IDs remain durable for recovery. A crash between remote acceptance
and local ID commitment can leave only submit intent, so exact remote identity
may remain unavailable. That case cannot authorize a resubmission or guessed
cancellation.

Every CLI snapshot response also projects `queue_calls`: at most 30 newest
distinct retained calls from the snapshot's existing recent request missions.
Each item contains request/call identity, latest durable phase, last remote state,
`durable=true`, `local_cancelled` from the current persisted request status and
whether a terminal remote outcome is retained. Explicit persisted cancellation
confirmation is included when available. Endpoint IDs, remote job IDs, credentials,
bodies and model output stay outside this renderer projection. Enrichment reads
existing queue events/request documents and makes no new durable mutation. A
locally cancelled request whose latest durable provider record is `accepted`
remains remote cancellation unconfirmed after reload, even if later live
telemetry showed successful cancellation. Its retained call can be reconciled.

The host-only `queue_reconcile` RPC accepts exactly `command`, `request_id`,
`call_id`, and boolean `cancel`. Request/call IDs resolve the job from committed
queue events; the caller supplies no URL, job ID, credential or output selector.
The retained endpoint/model must match the current host-selected binding, and
ambiguous or missing receipts fail before network access. It returns body-free
remote state, `cancel_requested`, `cancel_confirmed`, `outcome_known` and
`durable=false`. It makes status/cancel requests only and never creates another
job. The underlying callable also exposes `reconcile_job` for a trusted owner
that has already resolved its retained identity.

## Verification

Focused tests use an owned local HTTP queue fixture beneath the HTTPS connection
factory; no cloud API or inference request occurs. They cover exact worker input,
OpenAI tool-result identity/schema reuse, input/response bounds, endpoint/credential
rejection, malformed/uncertain acknowledgment without replay, foreign-job
rejection, terminal failures, absolute trickle deadline, confirmed/unconfirmed
cancellation, a cancellation committed by another Store connection, actual
CommitService intent/job receipts and reopen integrity, and protected
reconciliation without endpoint retargeting or output disclosure. All 30 queue
contract tests passed, including bounded snapshot recovery, every returned RPC
snapshot path, uncertain-submit attention and cancellation truth after reload.
The 20 existing Franklin and 13 existing OpenAI checks also passed: 63 focused
Python checks in total. Root's host integration passed 18 JavaScript checks.
These checks prove the local contract;
real model serving, cold-start latency, provider cancellation and billed cost
require the previously approved-specific trial procedure and a new concrete
owner approval before allocation.
