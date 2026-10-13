# Franklin DeepSeek Serverless proposal

Prepared 2026-10-03 from live read-only RunPod catalog/API metadata and official upstream sources. **No endpoint, worker, pod, template, network volume, or billable request was created.** This proposal supersedes the dedicated-pod route in `FRANKLIN-RUNPOD-PLAN.md` for the owner's Serverless preference. The earlier two-RTX SGLang price must not be presented as a Serverless vLLM quote.

## Recommendation and acceptance boundary

Use one separate **queue-based RunPod vLLM Serverless endpoint** for Franklin's optional self-hosted DeepSeek resource:

- `deepseek-ai/DeepSeek-V4-Flash`, the 284B total / 13B active preview checkpoint, official mixed FP4/FP8 weights, revision `60d8d70770c6776ff598c94bb586a859a38244f1`.
- Two H200 SXM GPUs per worker, 141 GB each, pool `HOPPER_141`, CUDA floor `13.0`.
- Minimum workers **0**, maximum **1**, queue-delay scaling threshold 4 seconds, idle timeout 60 seconds, standard FlashBoot.
- Begin with one sequence, 32,768-token maximum context, eager mode, and no speculative decoding. This is a conservative acceptance configuration, not a throughput or 1M-context claim.
- RunPod-managed Hugging Face model cache, pinned to the exact revision. No new paid network volume and no attachment to the media volume.
- A supervised initial trial with a **45-minute wall-clock cutoff from creation** and **$10 target budget**, including startup and final shutdown. This is an operational budget, not a native dollar cap.
- Require an explicit owner-approved billed trial before provisioning. Stop on incompatible kernels, startup failure, missing pinned cache, or failed tool-call acceptance; do not silently switch to a larger allocation or a different checkpoint.
- One deployment attempt and no automatic paid resubmission/redeployment. On the first terminal startup error, cancel the trial and scale down/delete the trial resource; a fresh billed attempt requires owner direction.

RunPod's own DeepSeek deployment guidance recommends two H200s for the original Flash checkpoint. The official vLLM recipe identifies the original checkpoint's mixed-precision minimum as about 170 GB and recognizes Hopper support. However, its present published launch examples emphasize four-GPU expert parallelism or eight-GPU TP. **This exact two-H200 + worker-v2.28.0 combination has not been run in this task.** The proposed trial establishes that missing runtime proof. [RunPod deployment guidance](https://www.runpod.io/blog/deepseek-v4-in-the-wild-and-how-to-run-it-on-runpod), [pinned vLLM recipe](https://github.com/vllm-project/recipes/blob/cbf76c0dedcd4404e2ca6a6ac14f00bbf4215888/models/deepseek-ai/DeepSeek-V4-Flash.yaml).

Two RTX PRO 6000 96 GB GPUs remain an economical **SGLang** recipe in the earlier document. That does not prove stock **vLLM** compatibility at TP2. The current official vLLM recipe's RTX PRO 6000 profile is an eight-card configuration with SM120-specific adjustments. Do not substitute the two-RTX allocation into this proposal.

The newer `DeepSeek-V4-Flash-0731` is a separate 304B checkpoint with DSpark and different memory/configuration requirements. It must be a deliberate later model selection. Parameter count is not evidence of equivalence to GPT-6. Existing cloud-model choices remain independent resources.

## Current price and scale-to-zero behavior

The authenticated live Serverless GPU catalog was queried with `product=SERVERLESS`, `count=2`, `include=AVAILABILITY`, and CUDA >=13.0. Prices below are the returned USD per GPU-hour, not pod rental prices:

| GPU | Per GPU-hour | Two GPUs per running worker-hour | Observed two-card availability |
| --- | ---: | ---: | --- |
| H200 SXM 141 GB | $5.93 | **$11.86** | Medium |
| RTX PRO 6000 SE 96 GB | $3.49 | $6.98 | High; this TP2 vLLM configuration unverified |
| B200 180 GB | $8.64 | $17.28 | Low |
| B300 288 GB | $10.65 | $21.30 | Low |

At the proposed H200 rate: 10 running minutes cost about **$1.98**; 45 running minutes about **$8.90**; 60 seconds of idle retention about **$0.20**. These are compute estimates before disk/tax and billing rounding. Four H200s would be $23.72 per running hour and are outside this proposed trial.

A worker is billed while starting, loading the model into GPU memory, executing, and waiting through its idle timeout. Model caching is a specific exception: RunPod downloads managed cache weights **before** starting the worker and says that download time is not billed as worker time. Container disk is separately billed in five-minute intervals at approximately $0.10/GB/month. The proposed 40 GB ephemeral disk is for the roughly 9 GB compressed image and scratch data; the model must live in the managed cache. The stock image is not small enough to promise instant first boot. [Billing](https://docs.runpod.io/serverless/pricing), [cached-model behavior](https://docs.runpod.io/serverless/endpoints/model-caching).

With minimum workers zero, compute can stop after idle shutdown; Franklin's persisted conversation, task receipts, and preferences stay in the Desktop through CommitService. Do not keep the endpoint warm with a timer or background model-health generation. Readiness/cold-start checks should be user-driven. A continuously busy two-H200 worker would cost about $284.64/day or $8,539.20/30 days before storage; scale-to-zero is therefore part of this design, not an optional cosmetic setting.

No measured cold-start promise is available for this checkpoint. Host cache removes repeated download cost, and FlashBoot can revive retained worker state, but capacity placement, image pull, GPU loading, and compilation still vary. Use the async job route for first inference and show “Starting model” plus elapsed time in Franklin. A synchronous HTTP timeout is not evidence that the remote job stopped. [Endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations).

## Immutable serving image

Official worker release inspected:

| Identity | Value |
| --- | --- |
| Human-readable tag | `runpod/worker-v1-vllm:v2.28.0` |
| Released | 2026-09-28 |
| Worker source commit | `26f892c0ac99fac87d13641b8e46af5646ea953a` |
| vLLM | `0.30.0` |
| Image CUDA | `13.0.2`, inspected from registry config |
| OCI index digest | `sha256:6d8e4ff417e09aeffe6a55e547ed81203b02228533c5305e726caaa7dab34571` |
| Linux amd64 image digest | `sha256:f0cba070a8d324fc664934c31b9e89d7a294f9116b2c81984defc2edcbc7098d` |
| Registry config digest | `sha256:2a0e63d391c7c8a080d6936633c8e2ae8a6a9cacfc94d411eeec7d5327b45a6f` |

Deploy the Linux amd64 digest, not `latest`. The worker accepts vLLM flags through uppercase environment names; the official recipe supplies `deepseek_v4` tokenizer/tool/reasoning parsers. Set `VLLM_USE_DEEP_GEMM=1` explicitly because the Hub's published default is zero. [Worker release](https://github.com/runpod-workers/worker-vllm/releases/tag/v2.28.0), [Dockerfile](https://github.com/runpod-workers/worker-vllm/blob/v2.28.0/Dockerfile), [argument builder](https://github.com/runpod-workers/worker-vllm/blob/v2.28.0/src/args_builder.py).

An upstream behavior matters for reproducibility: this worker can remove explicit `MODEL_REVISION`/`TOKENIZER_REVISION` pins after a stale-revision failure and retry the default branch. The proposed configuration instead loads the absolute cache snapshot path and enables HF/Transformers offline mode. Missing cache must fail closed; it must not download or serve an unapproved revision. [Worker retry source](https://github.com/runpod-workers/worker-vllm/blob/v2.28.0/src/main.py).

The worker also has one automatic out-of-memory recovery path. Its source only relaxes graph capture and the batched-token budget; this proposal already uses eager mode and a 4,096-token batch budget, so that recovery has no smaller setting to retry. Unrecognized worker crashes can still cause platform replacement. The watchdog must treat the first observed crash/startup failure as terminal and stop this endpoint; this stock platform cannot honestly be described as having a native zero-retry/dollar-cap guarantee.

## API contract and the managed-cache gap

The current REST v2 control URL is **`https://api.runpod.io/v2/serverless`**. The invoke URL is separately `https://api.runpod.ai/v2/<endpoint-id>/...`. The live OpenAPI document is `https://api.runpod.io/v2/openapi.json`. `rest.runpod.io/v2/openapi.json` returns an HTML documentation page and is not this schema.

Live v2 `CreateEndpointRequest` contains image/env, GPU, workers, scaling, flashboot, timeout, and network volumes. **It has no `modelReferences` or managed-cache binding field and rejects unevaluated properties.** Creating the endpoint through this schema alone would not establish the proposed cached weights. Do not insert a guessed field or imply that setting `MODEL_NAME` alone enables pre-worker caching.

The documented exact route for the desired cache is:

1. After approval, create a private Serverless template with the pinned image and the environment below, using REST v2/MCP `create_template`.
2. Create the endpoint from that template using the official `runpodctl serverless create --model-reference` route (or the RunPod console's Model field). The official CLI's current implementation uses RunPod GraphQL for cached-model creation. This is a documented RunPod route, not a custom provider API.
3. Read the created endpoint and its resolved model reference back before sending work. Reject any image, GPU, limits, or revision mismatch.

The existing `%TEMP%\yur-runpod-tools-2.14.0\runpodctl.exe` was inspected read-only. It reports `2.14.0-dd55bcf`; its help confirms every cache/GPU/scaling/timeout flag below and JSON output. No CLI create command was executed. [Official CLI source](https://github.com/runpod/runpodctl/blob/main/cmd/serverless/create.go), [CLI command reference](https://github.com/runpod/runpodctl/blob/main/docs/runpodctl_serverless_create.md), [REST v2 schema](https://docs.runpod.io/api-reference-v2/serverless/create-a-serverless-endpoint).

Proposed template body (full environment recorded in private `template.v2.proposed.json`):

```json
{
  "name": "yur-franklin-deepseek-v4-flash-v2280",
  "serverless": true,
  "category": "NVIDIA",
  "image": "runpod/worker-v1-vllm@sha256:f0cba070a8d324fc664934c31b9e89d7a294f9116b2c81984defc2edcbc7098d",
  "disk": 40,
  "env": {
    "MODEL_NAME": "/runpod-volume/huggingface-cache/hub/models--deepseek-ai--DeepSeek-V4-Flash/snapshots/60d8d70770c6776ff598c94bb586a859a38244f1",
    "OPENAI_SERVED_MODEL_NAME_OVERRIDE": "franklin-deepseek-v4-flash",
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "TENSOR_PARALLEL_SIZE": "2",
    "MAX_CONCURRENCY": "1",
    "MAX_NUM_SEQS": "1",
    "MAX_NUM_BATCHED_TOKENS": "4096",
    "MAX_MODEL_LEN": "32768",
    "GPU_MEMORY_UTILIZATION": "0.90",
    "ENFORCE_EAGER": "true",
    "ENABLE_FLASHINFER_AUTOTUNE": "false",
    "TOKENIZER_MODE": "deepseek_v4",
    "TOOL_CALL_PARSER": "deepseek_v4",
    "ENABLE_AUTO_TOOL_CHOICE": "true",
    "REASONING_PARSER": "deepseek_v4",
    "REASONING_CONFIG": "{\"reasoning_parser\":\"deepseek_v4\",\"reasoning_start_str\":\"\",\"reasoning_end_str\":\"\"}",
    "KV_CACHE_DTYPE": "fp8",
    "BLOCK_SIZE": "256",
    "VLLM_USE_DEEP_GEMM": "1",
    "VLLM_STARTUP_TIMEOUT": "1200"
  }
}
```

Proposed subsequent command, **not executed**; substitute only the returned private template ID:

```powershell
runpodctl serverless create --name yur-franklin-deepseek-v4-flash --template-id <RETURNED_TEMPLATE_ID> --gpu-id "NVIDIA H200" --gpu-count 2 --workers-min 0 --workers-max 1 --scale-by delay --scale-threshold 4 --idle-timeout 60 --execution-timeout 600 --flash-boot --min-cuda-version 13.0 --model-reference "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash:60d8d70770c6776ff598c94bb586a859a38244f1"
```

Equivalent v2 endpoint settings, for reference only, are `gpu:{pools:["HOPPER_141"],count:2,minCudaVersion:"13.0"}`, `workers:{min:0,max:1,idleTimeout:60}`, `scaling:{type:"QUEUE_DELAY",queueDelay:4}`, `flashboot:"FLASHBOOT"`, `timeout:600000`. V2 timeout is milliseconds; the CLI flag above is seconds. Live schema says idleTimeout is rejected for **QUEUE + REQUEST_COUNT**; use queue-delay scaling as specified. The private `endpoint.v2.shape-only.json` is schema-shaped reference data, **not a complete deployable cached-model request**.

No network volume is needed for public upstream weights when managed caching is enabled. This cache is not the user's durable storage or a backup; provider eviction can require repopulation. A separate network volume would add ongoing storage cost and placement constraints and needs a different approved plan. Conversation/memory/provenance belong to Desktop state, never to the disposable worker cache.

## Bounded acceptance and cleanup

After approval, record the resource IDs and install a separate watchdog before the first inference. A client request timeout alone cannot enforce a spending limit.

1. Read back exact worker limits, GPU count/pool, image digest, cache revision, and auth behavior. Verify the actual model-loading path in worker logs; a successful endpoint create or workers-ready count alone does not pass.
2. Submit one short **async** generation, retain the remote job ID, poll boundedly, and verify correct final text. Avoid duplicate requests while cold starting.
3. Exercise a typed, inert tool call and exact JSON argument parsing; return its controlled result and verify a coherent final answer. Then test a multi-turn exchange.
4. Verify cancel by remote job ID, reconnect, and the Desktop's exact request receipt. Cancellation of a client task is insufficient without confirmed remote termination/completion.
5. Record token usage and latency; keep model-private reasoning out of UI telemetry. Validate warm and cold behavior separately.
6. Remove outstanding jobs and shut down/delete **only this newly created endpoint and its dedicated template** by the 45-minute wall deadline or immediately on failure. Read worker/billing status back. The timer and observed billing are operational safeguards, not a guaranteed platform dollar ceiling.
7. Save a provenance receipt with configuration, hashes, revision, real responses, elapsed billed-worker time, cost, cleanup status, and any limitation. Ongoing endpoint retention or increasing context/concurrency requires an explicit next decision.

The existing media pod and `yur-media-models` volume are protected and untouched. No separate media or coding models are displaced.

## Prepared local execution tool

`scripts/franklin_serverless_trial.py` implements the bounded trial and defaults to a local proposal with **no API calls**:

```powershell
python scripts/franklin_serverless_trial.py
python scripts/franklin_serverless_trial.py --check
```

`--check` performs only CLI help/version, current H200 price/availability, and resource-inventory reads. This was run successfully on 2026-10-03: CLI `2.14.0-dd55bcf`, $11.86/two-H200-hour, medium availability, zero billable actions. It refuses missing prices, unavailable GPUs, or any quote above $11.86/hour.

**Only after explicit owner approval**, the executable entry is:

```powershell
python scripts/franklin_serverless_trial.py --execute-approved-trial
```

The tool starts a separate hidden watchdog before allocation and refuses to create anything if that watchdog does not signal readiness. It records pre-existing resource IDs, uses unique nonce-based names, persists create intentions before network calls, records returned IDs, and reconciles an uncertain create by exact owned name/image without repeating it. Every resource deletion verifies ID/name/image and rejects pre-existing IDs. Its API wrapper exposes no pod or volume routes.

The watchdog starts cleanup at minute 43, reserving two minutes for shutdown toward the 45-minute wall budget. It survives loss of the calling console and can recover a dead parent's cleanup lock. This does not survive a host power-off or total network outage; such conditions prevent remote cleanup and require immediate manual attention. Unknown remote outcomes remain marked incomplete.

After exact image, GPU, worker-limit, environment and managed-cache revision readback, the tool makes five bounded async requests: cold chat, one typed inert tool call, its result, a multi-turn recall check, and a request canceled by retained remote job ID. It demands remote `CANCELLED` state for that last check; a completion/cancel race is reported as unverified cancellation and is not retried. New worker IDs/restarts, stale/unhealthy workers, malformed tool arguments, startup errors and request timeouts terminate the trial. Any unreturned submit is never resent; cleanup disables and removes the owning endpoint.

Receipts are fsync'd and atomically replaced under the unified workspace's private `evidence/glider-rc6/comprehensive/franklin-serverless-trials/<run>/`. They retain selected resource metadata, visible test output, usage, job IDs and cleanup results; they exclude credentials, response headers and model-private reasoning. The tool records the current rate and elapsed times; an actual billing reconciliation remains a separate read after the trial because billing can lag.

Cleanup first scales the owned endpoint to zero, requests cancellation of outstanding known jobs, observes `workers=[]` and `summary.total=0`, deletes the owned endpoint/template, and verifies their 404 readbacks. If zero-worker readback cannot be obtained it still attempts deletion, but explicitly leaves cleanup **incomplete**. It never turns an unobserved shutdown into a successful receipt.

Validation: `python tests/test_franklin_serverless_trial.py -v` passes 21 focused offline tests. Coverage includes price gates, configuration/revision mismatch, uncertain creation, pre-existing-resource refusal, timeout/cancel, typed tool/multi-turn flow, worker replacement, zero-worker evidence, idempotent cleanup, dead-process locks, credential-output protection, and a real separate Windows watchdog process with an empty trial and unusable test credential. This validates the local guardrails, not GPU/model serving.

## Franklin integration contract

Bind a logical resource such as `franklin.self_hosted.deepseek_v4_flash` to the approved endpoint only after acceptance. Keep keys in the host credential layer; renderer code never contacts RunPod directly. The host maps async submit/status/stream/cancel into persistent task receipts and displays truthful “starting / running / stopped / failed” states.

One authoritative OrchestrationManager continues to compile context, select capabilities, and authorize tools. CommitService continues to persist preferences, history, work state, and artifacts. The model's tool calls are requests to this existing authority boundary; the Serverless worker receives no desktop operating authority or durable mission state.

## Evidence

Selected, non-secret read-only metadata and proposed payloads are under:

`evidence/glider-rc6/comprehensive/franklin-serverless-plan/`

Files: `selected-metadata.json`, `template.v2.proposed.json`, `endpoint.v2.shape-only.json`, and `schema-validation.json`. Both proposed JSON bodies passed Draft 2020-12 validation against the live REST v2 component schemas. No create request was sent. The authenticated endpoint list was empty at inspection. GPU availability and pricing are snapshots and must be refreshed immediately before provisioning.
