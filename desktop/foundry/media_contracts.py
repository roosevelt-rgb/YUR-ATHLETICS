"""Bounded operator requests and independent media candidate validation."""
from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit

MAX_INPUT = 16 * 1024 * 1024
MAX_ASSET = 128 * 1024 * 1024
AUTHORITY = {"issuer": "local-user", "scope": "media-generation",
             "actions": ["submit", "inspect", "import", "validate", "commit", "cancel-own-queued"]}
PRESETS = {
    "flux-klein-image-v1": {"label": "Flux 2 Klein · Image", "kind": "image", "input": "optional",
                            "model": "flux-2-klein-4b-fp8.safetensors", "output_node": "13",
                            "width": 1024, "height": 1024, "steps": 4},
    "wan22-video-v1": {"label": "Wan 2.2 · Image to video", "kind": "video", "input": "required",
                       "model": "wan2.2_ti2v_5B_fp16.safetensors", "output_node": "11",
                       "width": 832, "height": 480, "steps": 20, "frames": 49, "fps": 24},
}


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def authority(value):
    if value != AUTHORITY:
        raise PermissionError("Media operations require explicit local-user media authority")


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("Invalid media job identity")
    return value


def asset_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("Invalid media asset identity")
    return value


def endpoint(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Enter a ComfyUI base URL")
    value = value.strip().rstrip("/")
    p = urlsplit(value)
    if (not p.hostname or p.username or p.password or p.path or p.query or p.fragment
            or (p.scheme != "https" and not (p.scheme == "http" and p.hostname in {"localhost", "127.0.0.1", "::1"}))):
        raise ValueError("ComfyUI needs HTTPS, or loopback HTTP, without credentials or a path")
    try:
        p.port
    except ValueError as exc:
        raise ValueError("Invalid ComfyUI port") from exc
    return value


def configuration(value):
    """Materialize legacy or independent bindings without rewriting receipts.

    The compatibility endpoint is populated only when both kinds share a URL.
    Explicit empty kind bindings disable new work for that kind; they must not
    fall back to another resource. Configuration never claims provider health.
    """
    fields = {"provider", "endpoint", "image_endpoint", "video_endpoint"}
    if not isinstance(value, dict) or set(value) - fields or value.get("provider") != "comfy-media":
        raise ValueError("Invalid media provider configuration")
    legacy = value.get("endpoint", "")
    if not isinstance(legacy, str):
        raise ValueError("Media endpoint bindings must be strings")
    legacy = endpoint(legacy) if legacy else ""
    bindings = {}
    for kind in ("image", "video"):
        key = kind + "_endpoint"
        url = value.get(key, legacy)
        if not isinstance(url, str):
            raise ValueError("Media endpoint bindings must be strings")
        bindings[key] = endpoint(url) if url else ""
    shared = bindings["image_endpoint"] if bindings["image_endpoint"] == bindings["video_endpoint"] else ""
    return {"provider": "comfy-media", "endpoint": shared, **bindings}


def configure_request(value):
    """Validate typed operator bindings before the CommitService mutation."""
    if not isinstance(value, dict) or not value or set(value) - {"endpoint", "image_endpoint", "video_endpoint"}:
        raise ValueError("Media configuration accepts endpoint bindings only; keep secrets in the environment")
    if "endpoint" in value:
        if set(value) != {"endpoint"}:
            raise ValueError("Choose shared endpoint or independent media bindings, not both")
        # Preserve the established legacy command and its nonempty URL rule.
        return {"endpoint": endpoint(value["endpoint"])}
    result = {}
    for key, url in value.items():
        if not isinstance(url, str):
            raise ValueError("Media endpoint bindings must be strings; use an empty string to clear a binding")
        result[key] = endpoint(url) if url else ""
    return result


def provider_binding(value, kind):
    """Select a resource from operator configuration, never from a prompt."""
    if kind not in {"image", "video"}:
        raise ValueError("Unknown media kind")
    config = configuration(value)
    key = kind + "_endpoint"
    return {"provider": config["provider"], "endpoint": config[key], "kind": kind, "logical_service": "media." + kind,
            "binding": key, "selection_reason": "The operator-selected admitted " + kind + " preset uses the configured " + kind + " endpoint"}


def request(value):
    if not isinstance(value, dict) or set(value) - {"request_id", "preset", "prompt", "negative_prompt", "seed", "width", "height", "frames", "input_asset_id"}:
        raise ValueError("Unsupported media request fields")
    req = dict(value)
    try:
        if str(uuid.UUID(req["request_id"])) != req["request_id"]:
            raise ValueError()
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise ValueError("Media request_id must be a canonical UUID") from exc
    if req.get("preset") not in PRESETS:
        raise ValueError("Choose an admitted media preset")
    preset = PRESETS[req["preset"]]
    for key, limit in (("prompt", 8000), ("negative_prompt", 2000)):
        text = req.setdefault(key, "")
        if not isinstance(text, str) or len(text) > limit or (key == "prompt" and not text.strip()):
            raise ValueError(f"{key} must contain {'1' if key == 'prompt' else '0'}..{limit} characters")
    for key, default, lo, hi in (("seed", 1, 0, 2147483647), ("width", preset["width"], 256, 1536), ("height", preset["height"], 256, 1536)):
        n = req.setdefault(key, default)
        if type(n) is not int or not lo <= n <= hi:
            raise ValueError(f"{key} must be an integer from {lo} to {hi}")
    multiple = 32 if preset["kind"] == "video" else 16
    if req["width"] % multiple or req["height"] % multiple or req["width"] * req["height"] > (1280 * 736 if preset["kind"] == "video" else 1536 ** 2):
        raise ValueError(f"Dimensions must be multiples of {multiple} within the preset pixel budget")
    if preset["kind"] == "video":
        n = req.setdefault("frames", 49)
        if type(n) is not int or not 17 <= n <= 121 or (n - 1) % 4:
            raise ValueError("Video frames must be 17..121 with (frames - 1) divisible by 4")
    elif "frames" in req:
        raise ValueError("Image requests do not accept video frames")
    elif req["negative_prompt"]:
        raise ValueError("This image preset uses zero conditioning; negative prompts are available for video")
    incoming = req.get("input_asset_id")
    if incoming:
        asset_id(incoming)
    elif preset["input"] == "required":
        raise ValueError("Import or select a starting image for video")
    else:
        req.pop("input_asset_id", None)
    return json.loads(encoded(req))


def validate_candidate(raw, kind):
    """Decode untrusted candidate bytes before they may become committed assets.

    This judges file integrity and bounded dimensions, not artistic quality.
    Video is probed and one frame decoded; completion never asserts every frame
    or artistic/safety correctness. Inspection remains available to the user.
    """
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_ASSET:
        raise ValueError("Media asset is empty or exceeds 128 MiB")
    sha = hashlib.sha256(raw).hexdigest()
    if kind == "image":
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("Only PNG, JPEG and WebP images are admitted")
            width, height = image.size
            if width < 1 or height < 1 or width * height > 24_000_000 or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Image dimensions or animation exceed limits")
            fmt = image.format
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
        mime, ext = {"PNG": ("image/png", "png"), "JPEG": ("image/jpeg", "jpg"), "WEBP": ("image/webp", "webp")}[fmt]
        result = {"kind": kind, "mime": mime, "extension": ext, "width": width, "height": height, "checks": ["signature", "image-verify", "image-decode", "dimensions"]}
    elif kind == "video":
        ffprobe, ffmpeg = shutil.which("ffprobe"), shutil.which("ffmpeg")
        if not ffprobe or not ffmpeg:
            raise ValueError("FFmpeg and ffprobe are required to validate video before commit")
        if len(raw) < 12 or raw[4:8] != b"ftyp":
            raise ValueError("Expected an MP4 video container")
        with tempfile.TemporaryDirectory(prefix="yur-media-validation-") as folder:
            path = Path(folder) / "candidate.mp4"
            path.write_bytes(raw)
            probe = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, timeout=30, check=True)
            if len(probe.stdout) > 1024 * 1024:
                raise ValueError("Oversized video probe")
            metadata = json.loads(probe.stdout)
            streams = metadata.get("streams", [])
            videos = [s for s in streams if s.get("codec_type") == "video"]
            if len(videos) != 1 or len(streams) > 2:
                raise ValueError("Expected one video stream")
            stream = videos[0]
            width, height = int(stream["width"]), int(stream["height"])
            duration = float(metadata.get("format", {}).get("duration", 0))
            if not 0 < width * height <= 3840 * 2160 or not 0 < duration <= 30:
                raise ValueError("Video exceeds dimension or duration limits")
            subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], capture_output=True, timeout=30, check=True)
        result = {"kind": kind, "mime": "video/mp4", "extension": "mp4", "width": width, "height": height, "duration": duration, "checks": ["mp4-container", "ffprobe", "first-frame-decode", "dimensions", "duration"]}
    else:
        raise ValueError("Unknown media kind")
    return {**result, "schema": "yur.media.validation.v1", "passed": True, "sha256": sha, "bytes": len(raw)}
