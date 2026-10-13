"""Media persistence methods on the existing authoritative CommitService.

Binary assets are held separately from job JSON. Validation receipts bind bytes
before commit. Revision checks prevent two resumes from changing the same job.
"""
from __future__ import annotations
import hashlib
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from .media_contracts import MAX_ASSET, asset_id, authority, configuration, configure_request, digest, encoded, endpoint, identity


def now():
    return datetime.now(timezone.utc).isoformat()


class MediaCommitMixin:
    def initialize_media(self):
        with self._transaction():
            self._db.execute("CREATE TABLE IF NOT EXISTS media_jobs (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL)")
            self._db.execute("CREATE TABLE IF NOT EXISTS media_events (seq INTEGER PRIMARY KEY, entity TEXT NOT NULL, event TEXT NOT NULL, document TEXT NOT NULL, at TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL)")
            self._db.execute("CREATE TABLE IF NOT EXISTS media_blobs (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, validation TEXT NOT NULL)")
            self._db.execute("CREATE TABLE IF NOT EXISTS media_configuration (id TEXT PRIMARY KEY, document TEXT NOT NULL)")
        self.verify_media()

    def _media_event(self, entity, event, document):
        previous = self._db.execute("SELECT hash FROM media_events ORDER BY seq DESC LIMIT 1").fetchone()
        data = {"entity": entity, "event": event, "document": encoded(document), "at": now(), "previous": previous[0] if previous else "0" * 64}
        self._db.execute("INSERT INTO media_events(entity,event,document,at,previous,hash) VALUES(?,?,?,?,?,?)", (*data.values(), digest(data)))

    def media_configure(self, value, envelope):
        authority(envelope)
        update = configure_request(value)
        with self._transaction():
            self.verify_media()
            if "endpoint" in update:
                # Existing clients keep the exact established persisted schema.
                # Read-time materialization maps this shared URL to both kinds.
                document = {"provider": "comfy-media", **update}
            elif set(update) == {"image_endpoint", "video_endpoint"}:
                # A complete operator selection can replace a malformed ambient
                # environment; no unselected environment URL enters the commit.
                document = configuration({"provider": "comfy-media", **update})
            else:
                document = configuration({**self.media_configuration(), **update})
            self._db.execute("INSERT INTO media_configuration VALUES('comfy-media',?) ON CONFLICT(id) DO UPDATE SET document=excluded.document", (encoded(document),))
            self._media_event("comfy-media", "provider.configured", document)
        return configuration(document)

    def media_configuration(self):
        row = self._db.execute("SELECT document FROM media_configuration WHERE id='comfy-media'").fetchone()
        if row:
            return configuration(json.loads(row[0]))
        url = os.getenv("YUR_MEDIA_COMFY_URL", "")
        return configuration({"provider": "comfy-media", "endpoint": url,
                              "image_endpoint": os.getenv("YUR_MEDIA_IMAGE_COMFY_URL", url),
                              "video_endpoint": os.getenv("YUR_MEDIA_VIDEO_COMFY_URL", url)})

    def media_create(self, request, config, envelope):
        authority(envelope)
        with self._transaction():
            self.verify_media()
            row = self._db.execute("SELECT document FROM media_jobs WHERE request_id=?", (request["request_id"],)).fetchone()
            if row:
                document = json.loads(row[0])
                if document["request"] != request:
                    raise ValueError("Media request_id already belongs to different input")
                return document, False
            # An idempotent retry returns its original durable job even when a
            # binding has since been cleared. Only new jobs require a binding.
            if not config.get("endpoint"):
                raise ValueError("Configure the " + config.get("kind", "media") + " endpoint before generation")
            endpoint(config["endpoint"])
            stamp = now()
            document = {"id": uuid.uuid4().hex, "revision": 1, "request": request, "state": "accepted",
                        "created_at": stamp, "updated_at": stamp, "provider": config,
                        "authority": envelope, "receipt": None, "assets": [], "error": "", "notice": ""}
            self._db.execute("INSERT INTO media_jobs VALUES(?,?,?,?)", (document["id"], request["request_id"], 1, encoded(document)))
            self._media_event(document["id"], "media.accepted", document)
        return document, True

    def media_get(self, job_id):
        identity(job_id)
        row = self._db.execute("SELECT document FROM media_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise ValueError("Media job not found")
        return json.loads(row[0])

    def media_list(self, limit=100):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Media list limit must be 1..100")
        return [json.loads(row[0]) for row in self._db.execute("SELECT document FROM media_jobs ORDER BY rowid DESC LIMIT ?", (limit,))]

    def media_update(self, previous, changes, event):
        if set(changes) - {"state", "receipt", "assets", "error", "notice", "workflow_sha256", "uploaded_image", "validation"}:
            raise ValueError("Unsupported media transition")
        transitions = {
            "accepted": {"preparing", "cancelled"}, "preparing": {"submitting", "failed"},
            "submitting": {"queued", "submission_unknown", "failed"},
            "submission_unknown": {"submission_unknown", "queued"},
            "queued": {"queued", "running", "unresolved", "validating", "failed", "cancelled"},
            "running": {"running", "queued", "unresolved", "validating", "failed"},
            "unresolved": {"unresolved", "queued", "running", "validating", "failed"},
            "validating": {"validating", "completed", "failed"},
            "completed": set(), "failed": set(), "cancelled": set(),
        }
        next_state = changes.get("state", previous["state"])
        if next_state not in transitions[previous["state"]]:
            raise ValueError("Invalid media state transition")
        document = {**previous, **changes, "revision": previous["revision"] + 1, "updated_at": now()}
        if len(encoded(document).encode()) > 65536:
            raise ValueError("Media metadata exceeds 64 KiB")
        with self._transaction():
            self.verify_media()
            changed = self._db.execute("UPDATE media_jobs SET revision=?,document=? WHERE id=? AND revision=?", (document["revision"], encoded(document), document["id"], previous["revision"]))
            if changed.rowcount != 1:
                raise ValueError("Media job revision changed; refresh before continuing")
            self._media_event(document["id"], event, document)
        return document

    def media_commit_blob(self, raw, validation, envelope, *, origin):
        authority(envelope)
        if (not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_ASSET or not isinstance(validation, dict)
                or validation.get("schema") != "yur.media.validation.v1" or validation.get("passed") is not True
                or validation.get("sha256") != hashlib.sha256(raw).hexdigest() or validation.get("bytes") != len(raw)
                or validation.get("mime") not in {"image/png", "image/jpeg", "image/webp", "video/mp4"}):
            raise ValueError("Media commit requires a passed validation bound to exact bytes")
        item = {"id": validation["sha256"], **validation}
        with self._transaction():
            self.verify_media()
            old = self._db.execute("SELECT validation FROM media_blobs WHERE id=?", (item["id"],)).fetchone()
            if old is None:
                self._db.execute("INSERT INTO media_blobs VALUES(?,?,?)", (item["id"], raw, encoded(validation)))
                self._media_event(item["id"], "media.asset.committed", {"asset": item, "origin": origin, "authority": envelope})
            elif json.loads(old[0]) != validation:
                raise ValueError("Asset validation identity conflict")
        return item

    def media_blob(self, blob_id):
        asset_id(blob_id)
        row = self._db.execute("SELECT bytes,validation FROM media_blobs WHERE id=?", (blob_id,)).fetchone()
        if not row:
            raise ValueError("Media asset not found")
        raw, validation = row[0], json.loads(row[1])
        if hashlib.sha256(raw).hexdigest() != blob_id or len(raw) != validation["bytes"]:
            raise ValueError("Media blob integrity failure")
        return raw, validation

    def media_materialize(self, blob_id):
        raw, validation = self.media_blob(blob_id)
        folder = self.root / "media-assets"
        if folder.is_symlink() or (folder.exists() and (not folder.is_dir() or getattr(os.path, "isjunction", lambda p: False)(folder))):
            raise ValueError("Media cache must be an owned ordinary directory")
        folder.mkdir(exist_ok=True)
        path = folder / (blob_id + "." + validation["extension"])
        if path.is_symlink() or path.resolve().parent != folder.resolve():
            raise ValueError("Media cache path escaped its root")
        if not path.exists() or path.read_bytes() != raw:
            fd, name = tempfile.mkstemp(prefix=".asset-", dir=folder)
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(raw)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(name, path)
            finally:
                if os.path.exists(name):
                    os.unlink(name)
        return {"id": blob_id, "path": str(path), **validation}

    def media_events(self, job_id):
        identity(job_id)
        return [dict(row) for row in self._db.execute("SELECT seq,event,at,hash FROM media_events WHERE entity=? ORDER BY seq", (job_id,))]

    def verify_media(self):
        previous, jobs, assets, config = "0" * 64, {}, {}, None
        for row in self._db.execute("SELECT * FROM media_events ORDER BY seq"):
            value = dict(row)
            value.pop("seq")
            stored = value.pop("hash")
            if value["previous"] != previous or digest(value) != stored:
                raise ValueError("Media event chain integrity failure")
            previous = stored
            if value["event"] == "provider.configured":
                config = value["document"]
            elif value["event"] == "media.asset.committed":
                assets[value["entity"]] = json.loads(value["document"])["asset"]
            else:
                jobs[value["entity"]] = value["document"]
        rows = list(self._db.execute("SELECT id,document FROM media_jobs"))
        if len(rows) != len(jobs) or any(jobs.get(row[0]) != row[1] for row in rows):
            raise ValueError("Media job/event mismatch")
        blobs = list(self._db.execute("SELECT id,validation FROM media_blobs"))
        if len(blobs) != len(assets) or any(assets.get(row[0]) != {"id": row[0], **json.loads(row[1])} for row in blobs):
            raise ValueError("Media asset/event mismatch")
        saved = self._db.execute("SELECT document FROM media_configuration WHERE id='comfy-media'").fetchone()
        if (saved[0] if saved else None) != config:
            raise ValueError("Media configuration/event mismatch")
        return {"ok": True, "jobs": len(jobs), "assets": len(assets), "head": previous}
