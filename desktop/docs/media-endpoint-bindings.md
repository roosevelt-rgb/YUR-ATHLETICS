# Independent media endpoint bindings

The existing Desktop media owner now admits separate ComfyUI resources for `media.image` and `media.video`. This is a source-level binding change in the existing OrchestrationManager strategy and CommitService media mixin. It does not allocate resources or establish live cloud acceptance.

## Operator contract

The existing `configure` action accepts either the established shared binding or typed independent bindings:

```json
{"endpoint":"https://shared-comfy.example.test"}
```

```json
{"image_endpoint":"https://image-comfy.example.test","video_endpoint":"https://video-comfy.example.test"}
```

Each independent field may be patched alone. An omitted field keeps its current binding; an explicit empty string clears that kind and prevents new generation for it. The other kind never becomes an automatic fallback. The legacy shared setter replaces both bindings together. Mixing `endpoint` with an independent field is rejected to keep the selection unambiguous.

Only strings are admitted. Base URLs require HTTPS, or loopback HTTP, without embedded credentials, paths, queries or fragments. Unknown fields, inline tokens and missing local-user media authority are rejected before configuration is journaled. Provider secrets retain their existing process-environment handling; this change adds no credential fields or new credential management.

Validation of the operator URL contract precedes the existing CommitService transaction. That transaction journals the configuration and its existing `provider.configured` event together. Configuring a binding does not contact its provider or claim readiness. Independent candidate byte validation and validated asset commit remain separate operations.

## Configuration and readiness views

Configuration/status returns `provider`, `image_endpoint`, `video_endpoint` and the compatibility `endpoint`. The compatibility field contains the common URL when both kinds share it, and is empty when the bindings differ. Consumers must select the field matching the active preset kind; a blank compatibility field does not mean both independent bindings are absent.

The existing `status` action probes each admitted preset on that preset's kind binding. Each result includes the preset `id`, `kind`, selected `endpoint` and its own `ready`/missing/error result. An unconfigured kind is reported unready and causes no provider call. A failed video probe cannot invalidate a successful image probe or borrow its readiness. Aggregate `ready` retains the existing meaning of at least one ready preset. The active preset's readiness controls whether that preset may be offered as available. A provider probe establishes graph/model availability at that moment, not successful generation, output quality, reopen recovery or bill attribution.

When no CommitService configuration has been saved, startup environment defaults are resolved as follows:

| Setting | Binding |
|---|---|
| `YUR_MEDIA_COMFY_URL` | Legacy default for both kinds |
| `YUR_MEDIA_IMAGE_COMFY_URL` | Image override when the variable is present |
| `YUR_MEDIA_VIDEO_COMFY_URL` | Video override when the variable is present |

An explicitly present empty independent environment variable disables that kind. URLs are validated before readiness checks or new job selection. A saved configuration takes precedence over environment defaults. A complete explicit selection of both independent fields, or the legacy shared setter, can replace malformed ambient configuration without inheriting its invalid URL.

## Durable jobs and compatibility

The admitted preset determines the logical media service and binding. Request prompts and model responses cannot choose endpoints, providers or arbitrary workflow graphs. New accepted jobs save their selected endpoint, kind, logical service, binding field and selection reason under the existing `provider` snapshot. They do not snapshot the unrelated kind's URL. Existing workflow hashes, remote receipts, authority envelopes, events and validation receipts stay with the existing media job.

All subsequent preparation, resume, ambiguous-submission reconciliation, output retrieval and owned queued cancellation use the saved job's `provider.endpoint`. Changing or clearing the current binding affects new requests only. Retrying an existing identical `request_id` returns the durable original even after its kind binding was cleared; it does not create a replacement job or make another submission. Reusing that request identity for different input still fails.

Previously saved configuration documents containing exactly `provider` and `endpoint` are materialized as two shared bindings when read. Neither their stored JSON nor journal hashes are rewritten. Previously saved jobs retain their original provider schema and endpoint snapshot. The legacy configure command continues saving the established compact document schema. Event chain and document/event consistency verification remain in force for both formats.

## Local verification and unresolved acceptance

Focused verification uses the Desktop-selected Python runtime and `tests/test_media_generation.py`. The tests use temporary CommitService state and fake providers for independent selection, per-kind health, empty/partial updates, environment precedence, authority/URL rejection, unchanged legacy JSON/event hashes, pinned cancellation, reconfiguration, ambiguous submission recovery after restart and idempotent retry after a cleared binding. The existing candidate integrity and video decode tests remain part of that focused check.

No normal Desktop was restarted for this change. No cloud endpoint was configured in the real profile, no generation request was sent to a cloud resource, and no pod, queue, volume, job or credential was created or changed. Live acceptance still requires separately authorized resources, exact model/path/auth readiness, a bounded real request through the Desktop for each service, validated output commit, application reopen and original receipt recovery, and provider-side cancellation/cleanup plus billing readback. Image/video default dimensions, throughput and quality remain outside these local binding tests.
