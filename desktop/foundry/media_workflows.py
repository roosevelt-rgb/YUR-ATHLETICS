"""Admitted ComfyUI graphs extracted from proven media workflows.

No model-generated graph is accepted. Only typed operator parameter slots vary.
See docs/MEDIA-DONOR-PROVENANCE.md for donor receipts and derivative differences.
"""
from __future__ import annotations
from .media_contracts import PRESETS, digest, identity, request


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def build(value, job_id, uploaded_image=None):
    req = request(value)
    identity(job_id)
    preset = PRESETS[req["preset"]]
    if req.get("input_asset_id") and not uploaded_image:
        raise ValueError("Input image must be uploaded before compiling the workflow")
    prefix = f"yur-desktop/{job_id}"
    if preset["kind"] == "image":
        graph = {
            "1": node("UNETLoader", unet_name=preset["model"], weight_dtype="default"),
            "2": node("CLIPLoader", clip_name="qwen_3_4b.safetensors", type="flux2", device="default"),
            "3": node("VAELoader", vae_name="flux2-vae.safetensors"),
            "4": node("CLIPTextEncode", text=req["prompt"], clip=["2", 0]),
            "5": node("ConditioningZeroOut", conditioning=["4", 0]),
            "6": node("CFGGuider", model=["1", 0], positive=["4", 0], negative=["5", 0], cfg=1.0),
            "7": node("KSamplerSelect", sampler_name="euler"),
            "8": node("Flux2Scheduler", steps=4, width=req["width"], height=req["height"]),
            "9": node("EmptyFlux2LatentImage", width=req["width"], height=req["height"], batch_size=1),
            "10": node("RandomNoise", noise_seed=req["seed"]),
            "11": node("SamplerCustomAdvanced", noise=["10", 0], guider=["6", 0], sampler=["7", 0], sigmas=["8", 0], latent_image=["9", 0]),
            "12": node("VAEDecode", samples=["11", 0], vae=["3", 0]),
            "13": node("SaveImage", images=["12", 0], filename_prefix=prefix),
        }
        if uploaded_image:
            graph.update({
                "30": node("LoadImage", image=uploaded_image),
                "31": node("ImageScaleToTotalPixels", image=["30", 0], upscale_method="lanczos", megapixels=1.0, resolution_steps=16),
                "32": node("VAEEncode", pixels=["31", 0], vae=["3", 0]),
                "33": node("ReferenceLatent", conditioning=["4", 0], latent=["32", 0]),
                "34": node("ReferenceLatent", conditioning=["5", 0], latent=["32", 0]),
            })
            graph["6"]["inputs"].update(positive=["33", 0], negative=["34", 0])
    else:
        graph = {
            "1": node("UNETLoader", unet_name=preset["model"], weight_dtype="default"),
            "2": node("CLIPLoader", clip_name="umt5_xxl_fp8_e4m3fn_scaled.safetensors", type="wan", device="default"),
            "3": node("VAELoader", vae_name="wan2.2_vae.safetensors"),
            "4": node("ModelSamplingSD3", model=["1", 0], shift=8.0),
            "5": node("CLIPTextEncode", clip=["2", 0], text=req["prompt"]),
            "6": node("CLIPTextEncode", clip=["2", 0], text=req["negative_prompt"]),
            "7": node("Wan22ImageToVideoLatent", vae=["3", 0], width=req["width"], height=req["height"], length=req["frames"], batch_size=1, start_image=["20", 0]),
            "8": node("KSampler", model=["4", 0], positive=["5", 0], negative=["6", 0], latent_image=["7", 0], seed=req["seed"], steps=20, cfg=5.0, sampler_name="uni_pc", scheduler="simple", denoise=1.0),
            "9": node("VAEDecode", samples=["8", 0], vae=["3", 0]),
            "10": node("CreateVideo", images=["9", 0], fps=24.0),
            "11": node("SaveVideo", video=["10", 0], filename_prefix=prefix, format="mp4", codec="h264"),
            "20": node("LoadImage", image=uploaded_image),
        }
    return graph


def catalog():
    values = []
    for key, preset in PRESETS.items():
        template_request = {"request_id": "00000000-0000-4000-8000-000000000000", "preset": key, "prompt": "<operator-prompt>", "input_asset_id": "0" * 64}
        graph = build(template_request, "0" * 32, "<validated-input-image>")
        values.append({"id": key, **preset, "template_sha256": digest(graph), "capabilities": ["media.image.generate", "media.image.edit"] if preset["kind"] == "image" else ["media.video.generate"], "permissions": ["send-prompt-to-configured-provider", "send-selected-image", "commit-validated-media"], "rollback": "Cancel only this job while queued; committed assets remain in the gallery", "validation": "File integrity and bounded dimensions; artistic quality requires preview"})
    return {"schema": "yur.media.catalog.v1", "provider": "comfy-media", "presets": values}
