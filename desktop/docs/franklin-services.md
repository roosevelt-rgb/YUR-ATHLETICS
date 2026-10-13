# Franklin service bindings

`src/franklin-services.js` is a typed client of existing Music Studio and a
browser handoff to the host-selected Nova Site. It starts no service or engine,
changes no service configuration, and owns no domain persistence or orchestration.

Music remains at `<unified-root>/apps/music-studio`. The Desktop `music/` draft is
superseded. Its API and immutable document/job workflow are reused as inspected
October 5, 2026. Music's existing Foundry binding owns provider dispatch,
validation, commit, cancellation and saved-task recovery.

## Trusted host injection

Construct `createFranklinServices` with:

- `getMusicConfiguration() -> {endpoint, token}` from host configuration only.
  Desktop uses `YUR_FRANKLIN_MUSIC_URL` and `YUR_FRANKLIN_MUSIC_TOKEN`. The endpoint
  must be an exact `http://127.0.0.1:<port>` origin. Music must separately admit
  the token through its existing `YUR_MUSIC_ACCESS_TOKENS` role/tenant map.
- `getNovaConfiguration() -> {site_url}` and `openNova(url, identity)` for an
  exact HTTPS Site selected by the host. No project or session data is transferred.
- `deny(channel, args, settings)` and `getSettings()` for current Desktop policy.
  The channel is `franklin:service`, with `[{action,payload}]` arguments.
- Optional `timeoutMs` from 50 through 30000; default 15000.

Use `accepts`, `isReadOnly`, `validate`, `catalog`,
`confirmationRequirements(action,payload)`, and
`execute(action,payload,identity,confirmation)` from the existing execution broker.
The identity is the existing owner-bound request UUID, mission/action 32-hex IDs,
and active-request predicate. Configuration, payload, request and owner are bound
at validation; changing them while human review is open blocks dispatch.

The broker fingerprints the payload and review, asks the human, then supplies
`{confirmed:true,rights_attested:boolean,external_approved:boolean}` separately.
These fields never come from model payloads. Lyric creation and generation need
explicit input-rights attestation. Every provider except the two existing local
engines additionally needs reviewed external transmission/credit approval and
`private:false`. Unknown provider names receive the external gate and remain
subject to the Music registry; a provider ID cannot select a network endpoint.

## Actions

The exact exported order is `services_status`, `music_catalog`, `music_state`,
`music_document`, `music_generate`, `music_status`, `music_cancel`, `music_resume`,
`music_export`, `nova_open`.

| Action | Payload | Existing owner operation |
|---|---|---|
| `services_status` | `{}` | Configuration/readiness labels only; no health request |
| `music_catalog` | Optional `kind`, `limit` 1..50, `offset` 0..10000 | GET `/api/catalog` |
| `music_state` | `{}` | GET `/api/state`, bounded health/provider projection |
| `music_document` | `{kind:'composition',data:{title}}` or `{kind:'lyrics',data:{composition_id,text}}` | POST `/api/documents`; host derives new immutable document ID |
| `music_generate` | `{request:{composition_id,lyrics_id,provider,...typed creative settings}}` | POST `/api/generate`; action ID is the idempotency key |
| `music_status` | `{job_id}` | GET `/api/history?id=...`; exact matching job identity |
| `music_cancel` | `{job_id}` | POST `/api/jobs/cancel`; existing queued-only rule |
| `music_resume` | `{job_id}` | POST `/api/jobs/resume`; existing saved-task retrieval only |
| `music_export` | `{variant_ids:[...]}` | POST `/api/export`; existing Music delivery ZIP |
| `nova_open` | `{}` | Open host Site only; renderer execution remains false |

Catalog kinds are project, composition, lyrics, job, variant and delivery. Document
IDs are 32 or 64 lowercase hex; jobs are 32 hex. Export permits 1..8 distinct
variant IDs. Creative settings are validated against the current Music contract,
including mode, variants, duration, tempo, seed, bounded descriptive strings and
finite style/creativity weights. No arbitrary URLs, credentials, scripts, grants,
state roots or provider retry operation is admitted.

## Bounds and evidence

Requests are at most 64 KiB; HTTP JSON responses at most 1 MiB; returned model
context at most 96 KiB. There is an absolute request deadline, no redirect follow,
and no automatic retry. Token-like fields and known bearer values are redacted.
Cancellation before dispatch makes zero calls. Cancellation, disconnect or a bad
response after mutation dispatch is uncertain; the action cannot be resent.
Native Music receipts determine the actual outcome. An adapter configuration is
not a healthy server, completed song, listening approval or reconciled cost.

Nova remains handoff-only because Desktop has no authenticated Site project,
review/commit owner or renderer session. The actual Nova Site retains that chain;
opening it cannot be reported as a rendered change. No outbound communications
provider is connected by this module.

`node --test tests/franklin-services.test.js` uses owned local fixture endpoints.
It does not start Music, Unreal or an external provider and proves transport and
boundary behavior, not live generation, playback or commercial delivery.

## Native Desktop Music

`src/music-view.js` and `src/music.css` render Music inside Desktop. The navigation
entry mounts the existing service workflow with Simple song descriptions, Custom
lyrics and title, style suggestions, Instrumental, observed provider/model
choices, saved jobs, and inline audio. Suggestions are editable creative inputs;
they are not provider capabilities. No account credits or provider choices are
invented. Missing configuration is shown as unavailable while the draft remains.

The view uses the trusted host's `music.invoke(action,payload)` envelope,
`{ok:true,result}` or `{ok:false,error:{message,code,recovery?}}`. Opening/refreshing
calls `connect` before `music_state` and bounded job/variant catalogs. The host
owns startup and must refuse automatic worker startup when old queued/running
jobs would cause unattended execution. Existing Music starts its job worker with
its lightweight HTTP server; a separate engine launch is never implied.

The supervised child preserves an explicit host `YUR_FOUNDRY_ROOT` override after
checking its ordinary local D: directory and existing `foundry/commit_service.py`
and `foundry/orchestration.py` files. That selection participates in the live
connection scope: changing it invalidates the owned connection. If no override
is supplied, Music keeps the authority root in its existing
`music/runtime-binding.json`; Desktop does not silently choose a new authority.
Externally configured Music services retain their own authority binding.

One form submission calls `generate_song` with `{title,lyrics,request}`. The host
reviews the complete inputs once, then performs composition save, lyrics save,
and generation through the existing Music authority. This is a bounded sequence,
not an atomic transaction. The success envelope includes `document` as the native
job; partial failures include known IDs in `error.recovery`. The renderer neither
grants rights nor sets `external_approved`. An uncertain dispatch blocks another
submission and retains the draft, including across navigation in the current
Desktop window. It does not retry a generation automatically.

Native provider records are read from `music_state.providers`: `id`, `name`,
`configured`, `status`, `external`, `capabilities`, optional `models` and
`default_model`. Unknown requested providers/models remain unavailable selections;
they are not replaced silently. A native variant is a document with
`kind:'variant'` and `data.audio` as its 64-hex blob ID, plus `result_title` or
`settings.title`, `provider`, `index` and `validation.duration`. The view calls
`music.asset(asset_id)` and accepts only the host's opaque
`yur-music://asset/<UUID>/<matching-64hex>.<wav|mp3>` grant for playback. Listen
reacquires the selected asset and removes revoked inactive players; library
refresh preserves the current player without renewing or revoking its grant.
`music.save(asset_id)` uses the native save picker. Export uses the existing
`music_export` delivery and its `document.data.audio` ZIP asset.

`window.yurMusic.open(draft)` (also accepting `{draft}`) prepares the form only.
The `music_draft` host request acknowledges `{prepared:true,submitted:false,
request_id}`. Its typed draft supports mode, description, lyrics, title, style,
instrumental, provider and model. It never submits a song. The host derives and
matches the request identity separately from model content.

`tests/music-view.test.js` exercises draft retention, resource selection, refusal,
uncertainty, safe asset playback and queued/saved-task controls. The separate
`tests/music-view-native.cjs` renders this actual component in isolated Electron,
uses synthetic API records and a local WAV fixture, and records screenshots plus
real decode/play/seek/pause checks. Those results do not prove an external song
was generated or an account is connected.

`tests/music-desktop-native.cjs` is a separate read-only acceptance using the
actual Desktop main/preload/navigation, supervised canonical Music service,
existing library and real asset download/integrity/audio decoding. It rejects
Music mutation dispatch and compares existing job IDs, revisions and states
before and after. `--shutdown` additionally follows the real `app.quit()` path,
records component shutdown events and requires normal `will-quit` plus owned
Music shutdown. A forced fixture cleanup is not normal-shutdown proof. Provider
configuration and any unavailable background services are reported separately.
