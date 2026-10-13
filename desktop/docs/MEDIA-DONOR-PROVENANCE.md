# Media generation integration provenance

Implementation date: 2026-10-03. Selected source: `desktop/studio-electron` in the operator-selected YUR AI Desktop unified workspace. This integration promotes bounded provider behavior under the existing `OrchestrationManager` and `CommitService`; it does not create another orchestrator.

## Reused donor behavior

| Donor | SHA-256 at inspection | Reused behavior |
|---|---|---|
| `<unified-root>/apps/music-studio/music/comfy_provider.py` | `42dca0c09d7ffd70011cfb49477d26279ff306ab56e190f9505c2bebb49320c3` | No-redirect bounded HTTP; admitted graph submission; durable provider receipt; polling by prompt identity; strict output-prefix binding; binary retrieval and independent decoding |
| `<unified-root>/apps/music-studio/music/workflow.py` | `7dd268780c6010b61534c99595d354d117db13fadf3ce5d7b2a58edaf6b2dd70` | Strategies called by the existing manager; receipt retained before later processing; resumption without a replacement paid task |
| `<unified-root>/apps/music-studio/music/store.py` | `8788e9c6ecf6903721de681fe6e738acbc54809b4afc36ea605b4e037f5f3600` | Explicit persistence delegation boundary inspected |
| Selected source `foundry/music_store.py` | `c617fd835cb57b3fa11297523adc5bfbc004266f612b5442d55ea94d5e21d145` | Existing CommitService mixin pattern, event chain, revision checking, idempotency, binary blobs separate from JSON |

The audio-specific music schema and tenant principal contract were not relabeled as generic media. The selected Desktop is a local OS-account trust boundary. `media_store.py` supplies additive media tables on that same authoritative CommitService. The donor files were not modified.

## Admitted workflow origin

Read-only ComfyUI history was inspected on the already running operator-owned media worker. Original private prompts, source-image filenames and generated media were not copied into source.

| Preset | Existing successful receipt | Derivative changes |
|---|---|---|
| `flux-klein-image-v1` | `<history-prompt-id>` | Flux 2 Klein FP8 + Qwen 3 4B encoder + Flux2 VAE; preserved four-step Euler/reference-latent graph. Operator prompt, seed, dimensions, job prefix and validated starting image become typed slots. Omit the reference-latent input branch for text-to-image. Default 1024 square. |
| `wan22-video-v1` | `<history-prompt-id>` | Wan 2.2 TI2V 5B FP16 + UMT5 encoder + Wan VAE; preserved 20-step UniPC, shift 8, CFG 5, H.264 MP4 at 24 fps. Operator prompt/negative prompt, seed, dimensions, frame count and starting image are typed slots. Default 832×480 and 49 frames. |

Hashes of the original complete API graphs, computed in memory without copying private prompt text or source-image names: image edit `c6bc3c4a90cafae0af4a5bde8959393d8bdb3ff38ee58df290267471d3e6b2d3`; video `c33b25818271e2640684c582d5e86aed503d4ca243f412d4f4a30c662f65a79a`. Both original history receipts reported completed. The cloud proxy requires an identified client; the adapter uses the truthful `YUR-AI-Desktop/1.0 (ComfyUI media client)` user agent.

Template hashes returned by `media_workflows.catalog()` bind normalized graph definitions with placeholder user inputs, a zero job identity and fixed default dimensions:

- Flux image/edit template: `3f989649523be293658ac24d094f6d77ebf8360973e91c7779562eeac82305a8`.
- Wan video template: `4f8f87c2a8389eac66b89e4e5ef7ba3f5e0513070824cbf4b27bc58abe150a0d`.

Each submitted concrete graph receives its own hash in the durable job and provider metadata. Arbitrary model-generated graphs are rejected. Model names live in replaceable preset definitions, not the authority contract. A future provider can implement the same bounded adapter contract without changing the coordinator.

## Contract and persistence

`OrchestrationManager.media(action, payload)` delegates to `media_execution.dispatch` with an explicit local-user media authority envelope. Operator actions are catalog, configure, status, list, submit, inspect, resume, cancel, import and asset. Configuration stores the logical provider `comfy-media` and an operator-configured HTTPS endpoint (loopback HTTP is also accepted). Optional provider tokens come from `YUR_MEDIA_PROVIDER_TOKEN`, never the renderer or committed configuration. `YUR_MEDIA_COMFY_URL` is an optional initial environment binding.

A submission has a canonical UUID `request_id`, admitted `preset`, prompt, seed, bounded dimensions, optional `input_asset_id` and video-only frame count/negative prompt. A repeated request ID returns the same job. Changed input with an existing ID is rejected. Submit commits intent before the provider POST. An unknown POST outcome enters `submission_unknown`; resume searches exact job ID plus graph hash in provider queue/history and never sends another generation. An interrupted pre-submit upload may be repeated, but it cannot start generation.

Jobs pin their provider endpoint and prompt receipt. Reconfiguring a new disposable pod does not send an old receipt to that new pod. A deleted pod may make unfinished outputs unrecoverable; committed local assets survive. The media view polls saved jobs while open; closing it does not cancel remote rendering. Reopening or pressing Resume reconciles the saved receipt.

Images are bounded to 16 MiB for import and decoded with Pillow. Outputs are bounded to 128 MiB. Images are verified and decoded; MP4 videos require ffprobe plus FFmpeg first-frame decoding, dimension and duration limits. This is file-integrity validation, not a claim about every video frame, artistic quality, factuality or suitability. Validation and binary commit are separate operations. Binary blobs are stored in `media_blobs`, not mission JSON. Materialized preview copies live under the authoritative state root `media-assets/` and are rebuilt from verified committed bytes. Native previews and Save a copy are provided by the Desktop main process.

Queue cancellation names only this application's saved prompt ID. Running shared GPU work is never globally interrupted. No media pod, volume, model installation or existing job is mutated by health checks or discovery.

## Verification and acceptance

- `python -m unittest discover -s tests -p test_media_generation.py -v`: 19 passed, including a real tiny MP4 generated by CPU FFmpeg solely to verify the video decoder path and interrupted-output-download resumption without a new generation. The provider in this suite is a fake; independent cloud acceptance follows below.
- `node --check src/media-view.js`: passed.
- Hidden Electron `tests/media-view-smoke.cjs`: six checks passed against the real renderer DOM with a mock operator API: image defaults, exact typed submission, required video input, selected-image binding, own-job cancellation and disposal. Receipt: `%TEMP%/yur-media-view-<random>/media-view-receipt.json`.
- `node --test tests/media-host.test.js`: six passed, covering native export bytes/metadata, cancelled dialogs, preview grant expiry and method checks, rejected paths, changed-file digest refusal, GET/HEAD and MP4 byte ranges.
- Live read-only readiness through the actual Python adapter confirmed both admitted presets' node and checkpoint requirements and an idle 0-running/0-pending queue immediately before the root-authorized live acceptance run.
- `tests/glider-media-live.cjs`: real integrated Glider Desktop native acceptance passed. The real operator UI submitted one 512×512 Flux image and used its committed image as the starting input for one 512×288, 17-frame Wan MP4. Image and video passed independent validation and CommitService commit. Native image dimensions, video metadata/seek, trusted protocol HEAD/byte ranges, and native Save As exact SHA-256 bytes passed.
- `tests/glider-media-live.cjs --verify-restart`: a subsequent Electron process using the same isolated test profile restored exact completed job IDs, remote receipts and asset hashes, displayed/decoded both assets, and exported the same verified bytes without another generation.

The live image job is `<image-job-id>`; video job is `<video-job-id>`. Machine-specific receipts and outputs are kept outside source under the selected unified workspace's `evidence/glider-rc6/comprehensive/media-live/`: `media-live-receipt.json`, `media-restart-receipt.json`, `image.png`, `video.mp4`. Profile `%TEMP%/yur-glider-media-<random>` was explicitly isolated from installed and user candidate state. No test inference ran on the local GPU. The existing media pod, network volume and other work were left intact.

The first fixture attempt exposed a test-only event-timing race: its synthetic click on Use as starting image and form submission occurred in the same JavaScript evaluation before the click microtask selected the input. The fixture now awaits the visible selected-image label. The continuation used the exact already committed image and original profile; it did not submit a replacement image. The intentional splash IPC denial and already-offline external Foundry service were logged independently from the passing media path.
