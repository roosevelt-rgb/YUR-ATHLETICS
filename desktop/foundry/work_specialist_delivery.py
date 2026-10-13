"""Explicit user inspection and export of a specialist committed by Work."""
from __future__ import annotations

import hashlib

from .commit_service import _safe_path


def linked_specialist(manager, parent_id, specialist_id):
    store = manager.store
    store.verify_integrity()
    parent = store.get_work(parent_id)
    result = next((step["result"] for step in parent["steps"]
                   if step["tool"] == "build_specialist" and step["succeeded"] is True
                   and isinstance(step.get("result"), dict)
                   and step["result"].get("mission_id") == specialist_id), None)
    if (not result or result.get("schema") != "yur.work-specialist-result.v1"
            or result.get("committed") is not True or result.get("status") != "completed"
            or result.get("provenance", {}).get("parent_work_id") != parent_id):
        raise ValueError("Specialist is not linked to a committed build in this Work mission")
    child = store.get_mission(specialist_id)
    artifact = store.get_artifact(specialist_id)
    if (not child or child["status"] != "completed" or not artifact
            or artifact["digest"] != result["artifact"]["digest"]):
        raise ValueError("Specialist package differs from its committed Work result")
    return artifact


def handle(manager, command, parent_id, specialist_id):
    artifact = linked_specialist(manager, parent_id, specialist_id)
    if command == "inspect_specialist":
        return {"parent_work_id": parent_id, "specialist": manager.inspect(specialist_id)}
    if command == "export_specialist":
        return {"parent_work_id": parent_id, "specialist_id": specialist_id,
                "export": manager.store.export_artifact(specialist_id)}
    if command != "reveal_specialist":
        raise ValueError("Unsupported specialist delivery operation")
    # Reveal is read-only. Reconstruct the confined path; never trust a stored path.
    receipts = [event["data"] for event in manager.store.events(specialist_id)
                if event["event_type"] == "artifact.exported"
                and event["data"].get("artifact_digest") == artifact["digest"]]
    if not receipts:
        raise ValueError("Export this specialist before revealing its package")
    receipt = receipts[-1]
    destination = manager.store.root / "exports" / (artifact["digest"] + ".zip")
    _safe_path(destination)
    if (not destination.is_file() or destination.stat().st_size != receipt["bytes"]
            or receipt["bytes"] > 6_000_000
            or hashlib.sha256(destination.read_bytes()).hexdigest() != receipt["zip_digest"]):
        raise ValueError("Exported specialist bytes no longer match their receipt")
    return {"parent_work_id": parent_id, "specialist_id": specialist_id, "path": str(destination)}
