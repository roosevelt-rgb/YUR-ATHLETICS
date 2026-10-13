# Franklin dedicated model worker

Prepared 2026-10-03. Allocation requires owner approval for the concrete cost below.

The owner requested roughly 250 billion parameters. The closest verified DeepSeek checkpoint is `deepseek-ai/DeepSeek-V4-Flash`: 284B total, 13B active per token, official mixed FP4/FP8 weights. This is the earlier V4 Flash checkpoint. The newer 0731 release has 304B parameters and a different deployment/DSpark support matrix; it must not silently replace this tested recipe. Model size is not an equivalence claim to GPT-6.

## Proposed bounded acceptance allocation

- One separate RunPod Secure Cloud pod, name `yur-franklin-acceptance`.
- Two `NVIDIA RTX PRO 6000 Blackwell Server Edition` GPUs, 96 GB each.
- Live catalog quote: $2.09 per GPU-hour, or $4.18 per hour for both, excluding disk. Two-card availability was MEDIUM on 2026-10-03. Recheck immediately before creation.
- One supervised acceptance session, target within one hour and $5 total. Delete this pod immediately after the evidence is retrieved, or if startup/inference fails. No always-on allocation is authorized by this plan.
- 300 GB container disk for the approximately 160 GB checkpoint and runtime headroom; no new persistent network volume until the model passes acceptance and the owner selects ongoing operation.
- SGLang provider adapter with an OpenAI-compatible endpoint; credentials remain in the host environment. Expose inference only through authenticated HTTPS or an authenticated private tunnel.
- Existing media pod `<media-pod-id>` is a separate resource and must not be modified or stopped.
- At this GPU rate, continuous operation would cost $100.32/day or $3,009.60 per 30 days before storage. Existing Ollama cloud models remain available independently.

## Upstream recipe and application binding

The SGLang maintained configuration marks the following combination verified: `rtx6000`, `flash`, `fp4`, `low-latency`, `single`. It specifies:

```text
sglang serve --model-path deepseek-ai/DeepSeek-V4-Flash
  --trust-remote-code --tp 2
  --moe-runner-backend flashinfer_mxfp4
  --mem-fraction-static 0.92 --cuda-graph-max-bs-decode 32
  --host 0.0.0.0 --port 30000
```

Pinned candidate image: `lmsysorg/sglang@sha256:b27fce60bc5494c118c4910702812bcfa8cee67abcdd1ff8b0902f21647552f4` (Linux amd64 manifest for published `v0.5.20-cu130`). Pinned model revision: `60d8d70770c6776ff598c94bb586a859a38244f1`. These registry identities were read live; execution has not yet been tested.

Before inference verify the actual image supports this hardware and the DeepSeek V4 tokenizer/tool parser, and record them in the receipt. Bind authentication and tool parsing explicitly; the abbreviated upstream recipe above does not supply authentication. Acceptance must check chat, exact typed tool-call arguments, a tool result followed by a final answer, cancellation, repeated turns, and reconnection. A listening port or a model listing alone does not pass acceptance.

Franklin remains a strategy/view under the Desktop's existing OrchestrationManager and CommitService. Model inference owns no mission state, memory, tool authority, or desktop control. Persist the provider resource binding independently from conversation state; compile only the current bounded task and selected environment facts.

## Sources checked

- https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash
- https://github.com/sgl-project/sglang/blob/main/docs/cookbook/autoregressive/DeepSeek/DeepSeek-V4.mdx
- https://github.com/sgl-project/sglang/blob/main/docs/src/snippets/configs/deepseek-ai/deepseek-v4.jsx
- Authenticated RunPod REST v2 `GET /catalog/gpus?include=AVAILABILITY&product=POD&count=2&cloud=SECURE` (selected public capacity/pricing fields only; credentials never recorded).
