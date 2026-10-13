"""Media strategies invoked by the existing OrchestrationManager.

Each call performs a bounded step and returns. Durable receipts resume after
restart, independently of the renderer, conversation, and provider pod lifetime.
"""
from __future__ import annotations
import hashlib
from pathlib import Path
from . import media_contracts as contract
from .media_provider import ComfyMedia, RejectedRequest
from .media_workflows import build, catalog

FIELDS = {"catalog": set(), "configure": {"endpoint", "image_endpoint", "video_endpoint"}, "status": set(), "list": {"limit"},
          "submit": {"request"}, "inspect": {"job_id"}, "resume": {"job_id"}, "cancel": {"job_id"},
          "import": {"path"}, "asset": {"asset_id"}}


def dispatch(manager, action, payload=None, *, envelope=None, provider_factory=ComfyMedia):
    if action not in FIELDS or not isinstance(payload if payload is not None else {}, dict):
        raise ValueError("Unknown media action")
    payload = payload or {}
    if set(payload) - FIELDS[action]:
        raise ValueError("Unsupported media action fields")
    contract.authority(envelope)
    store = manager.store
    store.initialize_media()
    if action == "catalog":
        return catalog()
    if action == "configure":
        return store.media_configure(payload, envelope)
    if action == "list":
        return {"jobs": store.media_list(payload.get("limit", 100))}
    if action == "inspect":
        job = store.media_get(payload.get("job_id"))
        return {**job, "events": store.media_events(job["id"])}
    if action == "asset":
        return store.media_materialize(payload.get("asset_id"))
    if action == "status":
        config = store.media_configuration()
        if not config["image_endpoint"] and not config["video_endpoint"]:
            return {**config, "ready": False, "notice": "Configure a ComfyUI media endpoint", "presets": []}
        results = []
        for preset in catalog()["presets"]:
            binding = contract.provider_binding(config, preset["kind"])
            identity = {"id": preset["id"], "kind": preset["kind"], "endpoint": binding["endpoint"]}
            if not binding["endpoint"]:
                results.append({**identity, "ready": False, "missing": [], "notice": "Configure the " + preset["kind"] + " endpoint"})
                continue
            req = {"request_id": "00000000-0000-4000-8000-000000000000", "preset": preset["id"], "prompt": "readiness", "input_asset_id": "0" * 64}
            try:
                provider = provider_factory(binding["endpoint"])
                health = provider.health([build(req, "0" * 32, "readiness.png")])
                results.append({**health, **identity})
            except Exception as exc:
                results.append({**identity, "ready": False, "missing": [], "notice": _safe_error(exc)})
        return {**config, "ready": any(p["ready"] for p in results), "presets": results}
    if action == "import":
        path = Path(payload.get("path", ""))
        if not path.is_absolute() or not path.is_file() or path.is_symlink() or path.stat().st_size > contract.MAX_INPUT:
            raise ValueError("Choose an ordinary image file no larger than 16 MiB")
        raw = path.read_bytes()
        if len(raw) > contract.MAX_INPUT:
            raise ValueError("Input image changed or exceeds 16 MiB")
        validation = contract.validate_candidate(raw, "image")
        return store.media_commit_blob(raw, validation, envelope, origin={"kind": "operator-import", "name": path.name})
    # The existing worker lock prevents parallel POST claims; no new coordinator
    # is introduced. It is held only for this bounded operation, never rendering.
    with store.acquire_worker():
        if action == "submit":
            return submit(manager, payload.get("request"), envelope, provider_factory)
        if action == "resume":
            return resume(manager, payload.get("job_id"), envelope, provider_factory)
        if action == "cancel":
            return cancel(manager, payload.get("job_id"), provider_factory)
    raise ValueError("Unsupported media action")


def _safe_error(exc):
    if isinstance(exc, (ValueError, ConnectionError, TimeoutError)):
        return str(exc)[:500]
    return "Media operation could not complete (" + type(exc).__name__ + "). Inspect or resume its saved receipt."


def submit(manager, value, envelope, provider_factory):
    req = contract.request(value)
    store = manager.store
    config = contract.provider_binding(store.media_configuration(), contract.PRESETS[req["preset"]]["kind"])
    if req.get("input_asset_id"):
        raw, validation = store.media_blob(req["input_asset_id"])
        if validation["kind"] != "image" or len(raw) > contract.MAX_INPUT:
            raise ValueError("Starting image must be a committed image under 16 MiB")
    job, created = store.media_create(req, config, envelope)
    # Duplicate submissions return the durable job, even after an ambiguous POST.
    if not created:
        return job
    return _prepare(manager, job, provider_factory)


def _prepare(manager, job, provider_factory):
    store = manager.store
    if job["state"] == "accepted":
        job = store.media_update(job, {"state": "preparing"}, "media.preparing")
    provider = provider_factory(job["provider"]["endpoint"])
    try:
        req = job["request"]
        uploaded = None
        if req.get("input_asset_id"):
            raw, validation = store.media_blob(req["input_asset_id"])
            uploaded = provider.upload(raw, validation, job["id"])
        graph = build(req, job["id"], uploaded)
        health = provider.health([graph])
        if not health["ready"]:
            raise ValueError("Media execution cell is missing: " + ", ".join(health.get("missing", [])))
        sha = contract.digest(graph)
        # Commit this before sending POST. Interrupted/ambiguous POSTs are only
        # reconciled; resume never authorizes another charge or duplicate job.
        job = store.media_update(job, {"state": "submitting", "workflow_sha256": sha, "uploaded_image": uploaded}, "media.submit-intent")
        prompt_id = provider.submit(graph, job["id"], sha)
        receipt = {"prompt_id": prompt_id, "workflow_sha256": sha, "preset": req["preset"],
                   "provider": "comfy-media", "model": contract.PRESETS[req["preset"]]["model"],
                   "selection_reason": "Operator selected this admitted preset", "seed": req["seed"]}
        return store.media_update(job, {"state": "queued", "receipt": receipt}, "media.provider-accepted")
    except Exception as exc:
        if job["state"] == "submitting" and not isinstance(exc, RejectedRequest):
            return store.media_update(job, {"state": "submission_unknown", "error": _safe_error(exc), "notice": "Submission outcome is unknown. Resume searches for this exact job; it never submits another generation."}, "media.submission-unknown")
        return store.media_update(job, {"state": "failed", "error": _safe_error(exc)}, "media.failed")


def resume(manager, job_id, envelope, provider_factory):
    store = manager.store
    job = store.media_get(job_id)
    if job["state"] in {"completed", "failed", "cancelled"}:
        return job
    if job["state"] in {"accepted", "preparing"}:
        return _prepare(manager, job, provider_factory)
    provider = provider_factory(job["provider"]["endpoint"])
    if job["state"] in {"submitting", "submission_unknown"}:
        if job["state"] == "submitting":
            job = store.media_update(job, {"state": "submission_unknown"}, "media.interrupted-submit")
        prompt_id = provider.reconcile(job["id"], job["workflow_sha256"])
        if not prompt_id:
            return {**job, "notice": "No matching receipt found in current queue or latest 200 history entries. No generation was resubmitted."}
        receipt = {"prompt_id": prompt_id, "workflow_sha256": job["workflow_sha256"], "preset": job["request"]["preset"],
                   "provider": "comfy-media", "model": contract.PRESETS[job["request"]["preset"]]["model"],
                   "selection_reason": "Recovered exact operator request after interrupted submission", "seed": job["request"]["seed"]}
        job = store.media_update(job, {"state": "queued", "receipt": receipt, "error": "", "notice": "Remote receipt recovered without resubmission"}, "media.receipt-recovered")
    remote = provider.inspect(job["receipt"]["prompt_id"])
    if remote["state"] == "failed":
        return store.media_update(job, {"state": "failed", "error": remote["error"]}, "media.provider-failed")
    if remote["state"] != "ready":
        if job["state"] == "validating":
            return {**job, "notice": "Validation was interrupted; original remote output is currently unavailable. Nothing is resubmitted."}
        if remote["state"] == job["state"]:
            return job
        return store.media_update(job, {"state": remote["state"], "notice": remote.get("notice", "")}, "media.provider-state")
    if job["state"] != "validating":
        job = store.media_update(job, {"state": "validating"}, "media.validation-started")
    try:
        preset = contract.PRESETS[job["request"]["preset"]]
        candidates = provider.outputs(remote, preset["output_node"], job["id"], preset["kind"])
        # Validate every candidate before committing any binary asset.
        validated = [(candidate, contract.validate_candidate(candidate["bytes"], preset["kind"])) for candidate in candidates]
        assets = []
        for candidate, validation in validated:
            if validation["width"] != job["request"]["width"] or validation["height"] != job["request"]["height"]:
                raise ValueError("Provider output dimensions do not match the admitted request")
        for candidate, validation in validated:
            assets.append(store.media_commit_blob(candidate["bytes"], validation, envelope,
                          origin={"job_id": job["id"], "receipt": job["receipt"], "remote": candidate["remote"]}))
        return store.media_update(job, {"state": "completed", "assets": assets, "error": "", "validation": {"passed": True, "asset_ids": [a["id"] for a in assets]}, "notice": "Validated media committed. Preview to assess artistic quality."}, "media.completed")
    except Exception as exc:
        if isinstance(exc, (ConnectionError, TimeoutError)):
            notice = "Output transfer was interrupted. Resume retrieves the original receipt; generation will not be repeated."
            if job.get("notice") == notice:
                return job
            return store.media_update(job, {"state": "validating", "notice": notice, "error": _safe_error(exc)}, "media.output-transfer-interrupted")
        return store.media_update(job, {"state": "failed", "error": _safe_error(exc)}, "media.validation-failed")


def cancel(manager, job_id, provider_factory):
    store = manager.store
    job = store.media_get(job_id)
    if job["state"] == "accepted":
        return store.media_update(job, {"state": "cancelled"}, "media.cancelled-before-submit")
    if job["state"] not in {"queued", "running", "unresolved"}:
        return {**job, "notice": "This job cannot be cancelled at its current stage"}
    result = provider_factory(job["provider"]["endpoint"]).cancel_queued(job["receipt"]["prompt_id"])
    if result["cancelled"]:
        return store.media_update(job, {"state": "cancelled", "notice": result["notice"]}, "media.queued-cancelled")
    return {**job, "notice": result["notice"]}
