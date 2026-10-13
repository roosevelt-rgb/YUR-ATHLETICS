"""Committed project reference snapshots, separate from workspace metadata/authority.

Only CommitService owns this mixin. Acquiring/extracting a source is read-only;
the same acquired bytes and bounded text snapshot are atomically committed.
Removal is a tombstone, never deletion of evidence. Integrity binds extraction
snapshots without rerunning a potentially newer PDF/Office parser on history.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import uuid

from .attachments import acquire_attachment, contains_credential_material, MAX_FILE_BYTES, MAX_TEXT_CHARS, TEXT_EXTENSIONS
from .repository_context import SENSITIVE_NAME

AUTHORITY = {"issuer": "local-user", "scope": "project-reference-files", "actions": ["commit"]}
MAX_ACTIVE = 32
MAX_RETAINED_PROJECT = 128
MAX_RETAINED = 256
MAX_PROJECT_BYTES = 128 * 1024 * 1024
MAX_RETAINED_BYTES = 256 * 1024 * 1024
MAX_SELECTED = 8
LIMITS = {"files": MAX_SELECTED, "file_characters": 16000, "excerpt_characters": 48000,
          "excerpt_bytes": 65536, "context_bytes": 98304}
ZERO = "0" * 64
SUMMARY_FIELDS = ("id", "project_id", "name", "sha256", "bytes", "created_at", "content_sha256", "extraction")
RECEIPT_FIELDS = ("id", "project_id", "file_id", "operation_id", "collection_revision", "file_revision",
                  "event_type", "created_at", "previous_hash", "hash")


class ProjectFileConflictError(ValueError):
    """A project, collection, file or operation identity is no longer current."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _uuid(value):
    try:
        valid = type(value) is str and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        valid = False
    if not valid:
        raise ValueError("Project references require canonical UUIDs")


def _hash(value):
    if type(value) is not str or re.fullmatch(r"[a-f0-9]{64}", value) is None:
        raise ValueError("Project references require lowercase SHA-256 values")


def _revision(value, *, zero=False):
    if type(value) is not int or not (0 if zero else 1) <= value <= 1_000_000:
        raise ValueError("Project reference revision is invalid")


def _text(value, maximum, *, empty=False, multiline=False):
    if (type(value) is not str or len(value) > maximum or (not empty and not value)
            or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]" if multiline else r"[\x00-\x1f\x7f]", value)
            or contains_credential_material(value)):
        raise ValueError("Project reference text is oversized, invalid or contains credential-like material")
    value.encode("utf-8")


def validate_selections(value):
    if type(value) is not list or len(value) > MAX_SELECTED:
        raise ValueError("Select at most eight project reference files")
    seen = set()
    for item in value:
        if type(item) is not dict or set(item) != {"file_id", "revision", "sha256"}:
            raise ValueError("Project file selection requires file_id, revision and sha256 only")
        _uuid(item["file_id"]); _revision(item["revision"]); _hash(item["sha256"])
        if item["file_id"] in seen: raise ValueError("Project file selections must be distinct")
        seen.add(item["file_id"])
    return deepcopy(value)


def validate_request(request):
    """Exact ingress fields, checked before opening an unused desktop journal."""
    if type(request) is not dict: raise ValueError("Expected a project reference request")
    command = request.get("command")
    fields = {"command", "project_id", "expected_project_revision"}
    if command == "project_file_add":
        fields |= {"expected_collection_revision", "operation_id", "path", "expected_sha256"}
    elif command == "project_file_remove":
        fields |= {"expected_collection_revision", "operation_id", "file_id", "expected_file_revision", "expected_sha256"}
    elif command == "project_files_context": fields.add("selections")
    elif command != "project_files_list": raise ValueError("Unsupported project reference command")
    if set(request) != fields: raise ValueError("Project reference request has missing or unsupported fields")
    _uuid(request["project_id"]); _revision(request["expected_project_revision"])
    if command in ("project_file_add", "project_file_remove"):
        _uuid(request["operation_id"]); _revision(request["expected_collection_revision"], zero=True)
        _hash(request["expected_sha256"])
    if command == "project_file_add":
        path = request["path"]; _text(path, 4096)
        selected = Path(path)
        if (not selected.is_absolute() or ".." in selected.parts or selected.name.startswith(".")
                or SENSITIVE_NAME.search(selected.name)):
            raise ValueError("Select a nonsensitive absolute project reference path")
        if selected.suffix.lower() not in TEXT_EXTENSIONS | {".pdf", ".docx", ".xlsx", ".pptx"}:
            raise ValueError("Project reference files support text, PDF and Office documents; images are unsupported")
    elif command == "project_file_remove":
        _uuid(request["file_id"]); _revision(request["expected_file_revision"])
    elif command == "project_files_context": validate_selections(request["selections"])
    return deepcopy(request)


def _validate_document(document):
    expected = {"schema", "id", "project_id", "name", "sha256", "bytes", "created_at", "removed_at",
                "content", "content_sha256", "extraction", "source_path", "project_revision", "operation_id"}
    if type(document) is not dict or set(document) != expected or document["schema"] != "yur.project-file.v1":
        raise ValueError("Invalid project file document")
    for key in ("id", "project_id", "operation_id"): _uuid(document[key])
    for key in ("sha256", "content_sha256"): _hash(document[key])
    _revision(document["project_revision"])
    _text(document["name"], 255); _text(document["source_path"], 4096)
    if Path(document["source_path"]).name != document["name"]: raise ValueError("Project reference name mismatch")
    if type(document["bytes"]) is not int or not 0 <= document["bytes"] <= MAX_FILE_BYTES:
        raise ValueError("Project reference byte count exceeds limits")
    _text(document["content"], MAX_TEXT_CHARS, empty=True, multiline=True)
    if _sha(document["content"].encode("utf-8")) != document["content_sha256"]:
        raise ValueError("Project reference extraction digest mismatch")
    extraction = document["extraction"]
    if (type(extraction) is not dict or type(extraction.get("truncated")) is not bool
            or len(extraction) > 12 or len(canonical(extraction).encode("utf-8")) > 2048):
        raise ValueError("Project reference extraction metadata exceeds limits")
    for key, value in extraction.items():
        _text(key, 64)
        if type(value) not in (bool, int) or (type(value) is int and not 0 <= value <= 10_000_000):
            raise ValueError("Invalid project reference extraction metadata")
    for key in ("created_at", "removed_at"):
        value = document[key]
        if key == "removed_at" and value is None: continue
        _text(value, 64)
        if datetime.fromisoformat(value).utcoffset() != timezone.utc.utcoffset(None):
            raise ValueError("Project reference timestamps must be UTC")
    if document["removed_at"] is not None and document["removed_at"] < document["created_at"]:
        raise ValueError("Project reference removal predates creation")
    return document


def _summary(document, revision):
    return {**{key: deepcopy(document[key]) for key in SUMMARY_FIELDS}, "revision": revision}


class ProjectFileCommitMixin:
    def _initialize_project_file_schema(self):
        self._db.execute("""CREATE TABLE project_file_blobs (
            sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, payload BLOB NOT NULL)""")
        self._db.execute("""CREATE TABLE project_files (
            id TEXT PRIMARY KEY, project_kind TEXT NOT NULL CHECK(project_kind='project'), project_id TEXT NOT NULL,
            blob_sha256 TEXT NOT NULL REFERENCES project_file_blobs(sha256), document TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision IN(1,2)),
            FOREIGN KEY(project_kind,project_id) REFERENCES workspace_documents(kind,id))""")
        self._db.execute("""CREATE TABLE project_file_events (
            id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, file_id TEXT NOT NULL REFERENCES project_files(id),
            operation_id TEXT NOT NULL UNIQUE, collection_revision INTEGER NOT NULL, file_revision INTEGER NOT NULL,
            event_type TEXT NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
            state_digest TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
            UNIQUE(project_id,collection_revision))""")
        self._db.execute("CREATE INDEX project_files_project ON project_files(project_id,id)")

    def _project_file_project(self, project_id, expected_revision):
        row = self._db.execute("SELECT revision FROM workspace_documents WHERE kind='project' AND id=?", (project_id,)).fetchone()
        if row is None: raise ValueError("Project does not exist")
        if row["revision"] != expected_revision: raise ProjectFileConflictError("Project revision changed; refresh project files")

    def _project_file_collection(self, project_id, project_revision, through=None):
        # A historical operation replay returns its original collection, even if
        # later independent operations changed the project or removed a file.
        records, revision = {}, 0
        for row in self._db.execute("SELECT * FROM project_file_events WHERE project_id=? ORDER BY collection_revision", (project_id,)):
            if through is not None and row["collection_revision"] > through: break
            records[row["file_id"]] = (json.loads(row["data"])["document"], row["file_revision"])
            revision = row["collection_revision"]
        files = [_summary(doc, rev) for doc, rev in records.values() if doc["removed_at"] is None]
        files.sort(key=lambda item: (item["created_at"], item["id"]))
        return {"project_id": project_id, "project_revision": project_revision, "collection_revision": revision, "files": files}

    def _project_file_replay(self, request):
        row = self._db.execute("SELECT * FROM project_file_events WHERE operation_id=?", (request["operation_id"],)).fetchone()
        if row is None: return None
        if row["request"] != canonical(request): raise ProjectFileConflictError("Project file operation belongs to a different request")
        return {**self._project_file_collection(row["project_id"], request["expected_project_revision"], row["collection_revision"]),
                "receipt": {key: row[key] for key in RECEIPT_FIELDS}, "replayed": True}

    def _project_file_preflight(self, request):
        replay = self._project_file_replay(request)
        if replay is not None: return replay
        self._project_file_project(request["project_id"], request["expected_project_revision"])
        collection = self._project_file_collection(request["project_id"], request["expected_project_revision"])
        if collection["collection_revision"] != request["expected_collection_revision"]:
            raise ProjectFileConflictError("Project file collection changed; refresh before committing")
        return None

    def _project_file_append(self, request, document, revision):
        last = self._db.execute("SELECT id,hash FROM project_file_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {"id": last["id"] + 1 if last else 1, "project_id": document["project_id"], "file_id": document["id"],
                 "operation_id": request["operation_id"], "collection_revision": request["expected_collection_revision"] + 1,
                 "file_revision": revision, "event_type": "project.file.added" if revision == 1 else "project.file.removed",
                 "request": request, "data": {"document": document, "authority": AUTHORITY},
                 "created_at": document["created_at"] if revision == 1 else document["removed_at"],
                 "state_digest": digest({"document": document, "revision": revision}), "previous_hash": last["hash"] if last else ZERO}
        event["hash"] = digest(event)
        keys = ("id", "project_id", "file_id", "operation_id", "collection_revision", "file_revision", "event_type",
                "request", "data", "created_at", "state_digest", "previous_hash", "hash")
        self._db.execute("INSERT INTO project_file_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         tuple(canonical(event[key]) if key in ("request", "data") else event[key] for key in keys))
        return {key: event[key] for key in RECEIPT_FIELDS}

    def list_project_files(self, project_id, expected_project_revision):
        validate_request({"command": "project_files_list", "project_id": project_id, "expected_project_revision": expected_project_revision})
        with self._read_transaction():
            self._project_file_project(project_id, expected_project_revision)
            return self._project_file_collection(project_id, expected_project_revision)

    def add_project_file(self, request, *, authority):
        request = validate_request(request)
        if request["command"] != "project_file_add" or authority != AUTHORITY: raise ValueError("Project file commits require local-user reference authority")
        with self._read_transaction():
            replay = self._project_file_preflight(request)
            if replay is not None: return replay
        data, extracted = acquire_attachment({"path": request["path"], "expected_sha256": request["expected_sha256"]}, text_only=True)
        if (_sha(data) != request["expected_sha256"] or extracted["sha256"] != request["expected_sha256"]
                or extracted["bytes"] != len(data) or extracted["kind"] != "text"):
            raise ValueError("Project reference acquisition identity mismatch")
        stamp = datetime.now(timezone.utc).isoformat()
        document = _validate_document({"schema": "yur.project-file.v1", "id": str(uuid.uuid4()), "project_id": request["project_id"],
            "name": extracted["name"], "sha256": extracted["sha256"], "bytes": len(data), "created_at": stamp, "removed_at": None,
            "content": extracted["content"], "content_sha256": _sha(extracted["content"].encode("utf-8")),
            "extraction": extracted["extraction"], "source_path": request["path"],
            "project_revision": request["expected_project_revision"], "operation_id": request["operation_id"]})
        with self._transaction():
            replay = self._project_file_preflight(request)
            if replay is not None: return replay
            rows = list(self._db.execute("SELECT project_id,document FROM project_files"))
            project_docs = [json.loads(row["document"]) for row in rows if row["project_id"] == request["project_id"]]
            if (len(rows) >= MAX_RETAINED or len(project_docs) >= MAX_RETAINED_PROJECT
                    or sum(doc["removed_at"] is None for doc in project_docs) >= MAX_ACTIVE
                    or sum(doc["bytes"] for doc in project_docs) + len(data) > MAX_PROJECT_BYTES):
                raise ValueError("Project reference collection reached its retained file or byte limit")
            existing = self._db.execute("SELECT 1 FROM project_file_blobs WHERE sha256=?", (document["sha256"],)).fetchone()
            if existing is None:
                total = self._db.execute("SELECT coalesce(sum(bytes),0) FROM project_file_blobs").fetchone()[0]
                if total + len(data) > MAX_RETAINED_BYTES: raise ValueError("Retained project reference bytes exceed the journal limit")
                self._db.execute("INSERT INTO project_file_blobs VALUES (?,?,?)", (document["sha256"], len(data), data))
            self._db.execute("INSERT INTO project_files VALUES (?,'project',?,?,?,1)",
                             (document["id"], document["project_id"], document["sha256"], canonical(document)))
            receipt = self._project_file_append(request, document, 1)
            return {**self._project_file_collection(document["project_id"], request["expected_project_revision"]), "receipt": receipt, "replayed": False}

    def remove_project_file(self, request, *, authority):
        request = validate_request(request)
        if request["command"] != "project_file_remove" or authority != AUTHORITY: raise ValueError("Project file commits require local-user reference authority")
        with self._transaction():
            replay = self._project_file_preflight(request)
            if replay is not None: return replay
            row = self._db.execute("SELECT * FROM project_files WHERE id=? AND project_id=?", (request["file_id"], request["project_id"])).fetchone()
            if row is None: raise ValueError("Project file does not belong to this project")
            document = json.loads(row["document"])
            if (row["revision"] != request["expected_file_revision"] or document["sha256"] != request["expected_sha256"]
                    or document["removed_at"] is not None):
                raise ProjectFileConflictError("Project file version changed or was removed")
            document["removed_at"] = datetime.now(timezone.utc).isoformat()
            _validate_document(document)
            self._db.execute("UPDATE project_files SET document=?,revision=2 WHERE id=?", (canonical(document), document["id"]))
            receipt = self._project_file_append(request, document, 2)
            return {**self._project_file_collection(document["project_id"], request["expected_project_revision"]), "receipt": receipt, "replayed": False}

    def project_files_context(self, project_id, expected_project_revision, selections):
        validate_request({"command": "project_files_context", "project_id": project_id,
                          "expected_project_revision": expected_project_revision, "selections": selections})
        with self._read_transaction():
            self._project_file_project(project_id, expected_project_revision)
            collection = self._project_file_collection(project_id, expected_project_revision)
            parts, evidence, characters, byte_count = [], [], 0, 0
            for selected in selections:
                row = self._db.execute("SELECT document,revision FROM project_files WHERE id=? AND project_id=?", (selected["file_id"], project_id)).fetchone()
                if row is None: raise ValueError("Selected project file does not belong to this project")
                doc = json.loads(row["document"])
                if row["revision"] != selected["revision"] or doc["sha256"] != selected["sha256"] or doc["removed_at"] is not None:
                    raise ProjectFileConflictError("Selected project file changed or was removed; select its current version")
                text = doc["content"][:min(LIMITS["file_characters"], LIMITS["excerpt_characters"] - characters)]
                text = text.encode("utf-8")[:LIMITS["excerpt_bytes"] - byte_count].decode("utf-8", errors="ignore")
                if not text and doc["content"]: raise ValueError("Selected project files exceed the context budget; select fewer files")
                raw = text.encode("utf-8"); characters += len(text); byte_count += len(raw)
                item = {"id": doc["id"], "name": doc["name"], "sha256": doc["sha256"], "revision": row["revision"],
                        "content_sha256": doc["content_sha256"], "excerpt_sha256": _sha(raw),
                        "excerpt_characters": len(text), "excerpt_bytes": len(raw),
                        "truncated": doc["extraction"]["truncated"] or len(text) < len(doc["content"])}
                parts.append({**item, "text": text}); evidence.append(item)
            context = canonical({"schema": "yur.project-files-context.v1", "context_only": True,
                                 "project_id": project_id, "files": parts})
            if len(context.encode("utf-8")) > LIMITS["context_bytes"]:
                raise ValueError("Selected project files exceed the serialized context budget; select fewer files")
            return {"context": context, "evidence": {"schema": "yur.project-files-context.v1", "project_id": project_id,
                    "project_revision": expected_project_revision, "collection_revision": collection["collection_revision"],
                    "files": evidence, "context_sha256": _sha(context.encode("utf-8")), "limits": deepcopy(LIMITS)}}

    def _verify_project_files(self):
        blob_count, total_bytes, blobs = 0, 0, {}
        for row in self._db.execute("SELECT * FROM project_file_blobs"):
            blob_count += 1; _hash(row["sha256"])
            if (type(row["payload"]) is not bytes or len(row["payload"]) != row["bytes"]
                    or not 0 <= row["bytes"] <= MAX_FILE_BYTES or _sha(row["payload"]) != row["sha256"]):
                raise ValueError("Project reference immutable byte digest mismatch")
            total_bytes += row["bytes"]; blobs[row["sha256"]] = row["bytes"]
        if blob_count > MAX_RETAINED or total_bytes > MAX_RETAINED_BYTES: raise ValueError("Project reference blob limit exceeded")
        previous, latest, collections, count = ZERO, {}, {}, 0
        for row in self._db.execute("SELECT * FROM project_file_events ORDER BY id"):
            event = dict(row); event["request"] = json.loads(event["request"]); event["data"] = json.loads(event["data"])
            stored_hash = event.pop("hash"); count += 1
            if count > MAX_RETAINED * 2 or event["id"] != count or event["previous_hash"] != previous or digest(event) != stored_hash:
                raise ValueError("Project reference event chain mismatch")
            request = validate_request(event["request"])
            if type(event["data"]) is not dict or set(event["data"]) != {"document", "authority"} or event["data"]["authority"] != AUTHORITY:
                raise ValueError("Project reference event authority mismatch")
            doc = _validate_document(event["data"]["document"]); identity = doc["id"]
            if (doc["project_id"] != event["project_id"] or identity != event["file_id"]
                    or request["project_id"] != event["project_id"] or request["operation_id"] != event["operation_id"]
                    or event["collection_revision"] != collections.get(doc["project_id"], 0) + 1
                    or request["expected_collection_revision"] != event["collection_revision"] - 1
                    or event["state_digest"] != digest({"document": doc, "revision": event["file_revision"]})
                    or blobs.get(doc["sha256"]) != doc["bytes"]):
                raise ValueError("Project reference identity or revision mismatch")
            if not self._db.execute("SELECT 1 FROM workspace_events WHERE kind='project' AND document_id=? AND revision=?",
                                    (doc["project_id"], request["expected_project_revision"])).fetchone():
                raise ValueError("Project reference lacks a committed project revision")
            if identity not in latest:
                if (request["command"] != "project_file_add" or doc["removed_at"] is not None or event["file_revision"] != 1
                        or doc["operation_id"] != request["operation_id"] or doc["source_path"] != request["path"]
                        or doc["sha256"] != request["expected_sha256"] or doc["project_revision"] != request["expected_project_revision"]
                        or event["created_at"] != doc["created_at"] or event["event_type"] != "project.file.added"):
                    raise ValueError("Project reference history must begin with an acquired snapshot")
            else:
                old, old_revision = latest[identity]
                if (request["command"] != "project_file_remove" or old_revision != 1 or event["file_revision"] != 2
                        or request["file_id"] != identity or request["expected_file_revision"] != 1
                        or request["expected_sha256"] != old["sha256"] or doc["removed_at"] is None
                        or {**doc, "removed_at": None} != old or event["created_at"] != doc["removed_at"]
                        or event["event_type"] != "project.file.removed"):
                    raise ValueError("Project reference immutable history changed")
            latest[identity] = (doc, event["file_revision"])
            collections[doc["project_id"]] = event["collection_revision"]; previous = stored_hash
        rows = list(self._db.execute("SELECT * FROM project_files"))
        if len(rows) > MAX_RETAINED or {row["id"] for row in rows} != set(latest): raise ValueError("Project reference state/event coverage mismatch")
        if set(blobs) != {doc["sha256"] for doc, rev in latest.values()}: raise ValueError("Project reference orphaned byte snapshot")
        for row in rows:
            doc, revision = latest[row["id"]]
            if (row["project_kind"] != "project" or row["project_id"] != doc["project_id"] or row["blob_sha256"] != doc["sha256"]
                    or row["document"] != canonical(doc) or row["revision"] != revision):
                raise ValueError("Project reference projection mismatch")
        for project_id in collections:
            documents = [doc for doc, rev in latest.values() if doc["project_id"] == project_id]
            if (len(documents) > MAX_RETAINED_PROJECT or sum(doc["bytes"] for doc in documents) > MAX_PROJECT_BYTES
                    or sum(doc["removed_at"] is None for doc in documents) > MAX_ACTIVE):
                raise ValueError("Project reference collection limit exceeded")
        return {"project_files": len(rows), "project_file_events": count, "project_file_blobs": blob_count,
                "project_file_bytes": total_bytes, "project_file_head_hash": previous}
