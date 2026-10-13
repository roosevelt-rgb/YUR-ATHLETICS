"""Transactional authority for local factory state, artifacts and provenance.

Event hashes detect accidental or partial tampering, including changes to mission
state. They are unkeyed checksums, not signatures: an actor able to rewrite the
whole database can rewrite the chain. Backups or external trust anchors are
required for stronger authenticity guarantees.

Importing this module neither opens a database nor creates machine state.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import ipaddress
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
from typing import Any, Iterator
from urllib.parse import urlsplit
import uuid
import zipfile

from .work_store import WorkCommitMixin
from .work_schedules import ScheduleCommitMixin
from .concept_store import ConceptCommitMixin
from .runtime_setup_store import RuntimeSetupCommitMixin
from .project_files import ProjectFileCommitMixin, validate_selections as _project_file_selections
from .agent_lifecycles import LifecycleCommitMixin
from .ship_gate import ShipGateCommitMixin
from .media_store import MediaCommitMixin
from .franklin_store import FranklinCommitMixin

SCHEMA_VERSION = 11
MAX_CONVERSATION_BYTES = 1024 * 1024
MAX_CONVERSATIONS = 200
MAX_CONVERSATION_LIST_BYTES = 4 * 1024 * 1024
MAX_WORKSPACE_BYTES = 64 * 1024
MAX_WORKSPACE_DOCUMENTS = 200
MAX_WORKSPACE_LIST_BYTES = 4 * 1024 * 1024
_ZERO_HASH = "0" * 64
_MISSION_ID = re.compile(r"^[a-f0-9]{32}$")
_TRANSITIONS = {
    "queued": {"running", "cancelled"},
    "running": {"queued", "validating", "failed", "cancelled"},
    "validating": {"queued", "failed", "cancelled"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)


def _digest(value: Any) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def artifact_digest(files: dict[str, str]) -> str:
    """Canonical UTF-8 digest shared by validation and publication."""
    return _digest(files)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ConversationConflictError(ValueError):
    """The caller's conversation revision is no longer current."""


class WorkspaceConflictError(ValueError):
    """The caller's workspace document revision is no longer current."""


def _conversation_authority(authority: Any) -> None:
    # Issued by the local application ingress, never read from model output.
    if authority != {"issuer": "local-user", "scope": "conversation-state", "actions": ["commit"]}:
        raise ValueError("Conversation commits require explicit local-user conversation-state authority")


def _iso_timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or len(value) > 64 or "T" not in value:
        raise ValueError(f"{field} must be a timezone-aware ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Missing timezone")
        return parsed
    except ValueError as exc:
        raise ValueError(f"{field} must be a timezone-aware ISO timestamp") from exc


def _uuid(value: Any, field: str) -> None:
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError("Noncanonical UUID")
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{field} must be a canonical UUID") from exc


def _bounded_text(value: Any, field: str, maximum: int) -> None:
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"{field} must be text of at most {maximum} characters")


def _conversation_source_selections(value: Any) -> None:
    """Persist bounded references, never content or source-read authority.

    The acquisition service independently resolves its approved source/file
    pairs and rechecks actual bytes before these references enter context.
    """
    if not isinstance(value, list) or len(value) > 3:
        raise ValueError("Conversation source selections must contain at most three references")
    seen = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"source_id", "relative_path", "sha256", "name"}:
            raise ValueError("Conversation source selection has unsupported fields")
        for field, maximum in (("source_id", 80), ("relative_path", 300), ("sha256", 64), ("name", 200)):
            _bounded_text(item[field], f"Source selection {field}", maximum)
            if not item[field] or re.search(r"[\x00-\x1f\x7f]", item[field]):
                raise ValueError("Source selection fields must be nonempty text without control characters")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", item["source_id"]):
            raise ValueError("Source selection requires a logical source identifier")
        if not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
            raise ValueError("Source selection requires a lowercase SHA-256")
        relative = item["relative_path"]
        if "\\" in relative or ":" in relative or any(part in {"", ".", ".."} for part in relative.split("/")):
            raise ValueError("Source selection requires a canonical relative file reference")
        identity = (item["source_id"], relative.casefold())
        if identity in seen:
            raise ValueError("Conversation source selections must identify distinct source files")
        seen.add(identity)


def _conversation_document(conversation: Any) -> tuple[dict[str, Any], str]:
    """Validate the exact public document contract and detach mutable inputs."""
    required = {"id", "title", "createdAt", "updatedAt", "model", "messages"}
    if (not isinstance(conversation, dict) or not required <= conversation.keys()
            or conversation.keys() - required - {"draft", "metadata", "source_selections", "project_file_selections"}):
        raise ValueError("Conversation has missing or unsupported fields")
    _uuid(conversation["id"], "Conversation id")
    _bounded_text(conversation["title"], "Conversation title", 160)
    _bounded_text(conversation["model"], "Conversation model", 256)
    created = _iso_timestamp(conversation["createdAt"], "Conversation createdAt")
    updated = _iso_timestamp(conversation["updatedAt"], "Conversation updatedAt")
    if updated < created:
        raise ValueError("Conversation updatedAt precedes createdAt")
    if "draft" in conversation:
        _bounded_text(conversation["draft"], "Conversation draft", 32000)
    if "source_selections" in conversation:
        _conversation_source_selections(conversation["source_selections"])
    if "metadata" in conversation:
        metadata = conversation["metadata"]
        if (not isinstance(metadata, dict)
                or metadata.keys() - {"mode", "project_id", "pinned", "archived", "parent_id"}):
            raise ValueError("Conversation metadata has unsupported fields")
        if "mode" in metadata and metadata["mode"] not in ("chat", "work", "code"):
            raise ValueError("Conversation mode must be chat, work or code")
        for field in ("pinned", "archived"):
            if field in metadata and type(metadata[field]) is not bool:
                raise ValueError(f"Conversation {field} must be a boolean")
        for field in ("project_id", "parent_id"):
            if field in metadata and metadata[field] is not None:
                _uuid(metadata[field], f"Conversation {field}")
        if metadata.get("parent_id") == conversation["id"]:
            raise ValueError("Conversation cannot be its own parent")
    if "project_file_selections" in conversation:
        selection = conversation["project_file_selections"]
        if type(selection) is not dict or set(selection) != {"project_id", "files"}:
            raise ValueError("Conversation project references require project_id and files only")
        _uuid(selection["project_id"], "Project reference project_id")
        _project_file_selections(selection["files"])
        if selection["project_id"] != conversation.get("metadata", {}).get("project_id"):
            raise ValueError("Conversation project references must belong to its selected project")
    messages = conversation["messages"]
    if not isinstance(messages, list) or len(messages) > 200:
        raise ValueError("Conversation messages must be a list of at most 200 messages")
    seen = set()
    message_required = {"id", "role", "content", "createdAt"}
    for message in messages:
        if (not isinstance(message, dict) or not message_required <= message.keys()
                or message.keys() - message_required - {"model", "provider", "evidence"}):
            raise ValueError("Message has missing or unsupported fields")
        _uuid(message["id"], "Message id")
        if message["id"] in seen:
            raise ValueError("Message identifiers must be unique within a conversation")
        seen.add(message["id"])
        if message["role"] not in ("user", "assistant", "error"):
            raise ValueError("Message role must be user, assistant or error")
        _bounded_text(message["content"], "Message content", 100000)
        _iso_timestamp(message["createdAt"], "Message createdAt")
        for field in ("model", "provider"):
            if field in message:
                _bounded_text(message[field], f"Message {field}", 256)
        if "evidence" in message and not isinstance(message["evidence"], dict):
            raise ValueError("Message evidence must be a JSON object")
    try:
        encoded = _json(conversation)
        if len(encoded.encode("utf-8")) > MAX_CONVERSATION_BYTES:
            raise ValueError("Conversation exceeds the 1 MiB document limit")
        detached = json.loads(encoded)
        # JSON objects have string keys; reject Python-only objects/coercions too.
        if detached != conversation:
            raise ValueError("Conversation must contain only JSON values")
        return detached, encoded
    except (TypeError, RecursionError, UnicodeError) as exc:
        raise ValueError("Conversation must contain bounded, valid UTF-8 JSON values") from exc


def _workspace_kind(kind: Any) -> None:
    if kind not in ("project", "settings"):
        raise ValueError("Workspace kind must be project or settings")


def _workspace_authority(authority: Any) -> None:
    if authority != {"issuer": "local-user", "scope": "workspace-state", "actions": ["commit"]}:
        raise ValueError("Workspace commits require explicit local-user workspace-state authority")


def _workspace_url(value: Any, field: str) -> None:
    _bounded_text(value, field, 2048)
    if not value:
        return  # Unconfigured; no endpoint is invented by persistence.
    if value != value.strip() or any(ord(char) <= 32 for char in value) or "\\" in value:
        raise ValueError(f"{field} must be a credential-free HTTPS or loopback HTTP origin")
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
        loopback = host == "localhost"
        if host and not loopback:
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                pass
        if (not host or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or "?" in value or "#" in value
                or parsed.path not in ("", "/") or (port is not None and port == 0)
                or (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback))):
            raise ValueError("Invalid endpoint")
    except ValueError as exc:
        raise ValueError(f"{field} must be a credential-free HTTPS or loopback HTTP origin") from exc


def _workspace_document(kind: Any, document: Any) -> tuple[dict[str, Any], str]:
    """Workspace selection/preferences are data, never a grant of execution authority."""
    _workspace_kind(kind)
    required = ({"id", "name", "root", "instructions", "createdAt", "updatedAt"} if kind == "project"
                else {"id", "theme", "default_model", "foundry_url", "ollama_url", "custom_instructions"})
    optional = {"execution_distro", "preferences"} if kind == "settings" else set()
    if not isinstance(document, dict) or not required <= set(document) or set(document) - required - optional:
        raise ValueError("Workspace document has missing or unsupported fields")
    if kind == "project":
        _uuid(document["id"], "Project id")
        _bounded_text(document["name"], "Project name", 160)
        if not document["name"].strip():
            raise ValueError("Project name must not be empty")
        _bounded_text(document["root"], "Project root", 4096)
        _bounded_text(document["instructions"], "Project instructions", 32000)
        created = _iso_timestamp(document["createdAt"], "Project createdAt")
        updated = _iso_timestamp(document["updatedAt"], "Project updatedAt")
        if updated < created:
            raise ValueError("Project updatedAt precedes createdAt")
    else:
        if "preferences" in document:
            from .settings_contract import validate_preferences
            validate_preferences(document["preferences"])
        if document["id"] != "desktop":
            raise ValueError("Settings id must be desktop")
        if document["theme"] not in ("system", "light", "dark"):
            raise ValueError("Settings theme must be system, light or dark")
        _bounded_text(document["default_model"], "Settings default_model", 256)
        _bounded_text(document["custom_instructions"], "Settings custom_instructions", 32000)
        for field in ("foundry_url", "ollama_url"):
            _workspace_url(document[field], f"Settings {field}")
        if "execution_distro" in document:
            selected = document["execution_distro"]
            if not isinstance(selected, str) or (selected and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", selected)):
                raise ValueError("Settings execution_distro must be an empty preference or bounded local distribution name")
    if any(isinstance(value, str) and "\0" in value for value in document.values()):
        raise ValueError("Workspace text must not contain NUL characters")
    try:
        encoded = _json(document)
        if len(encoded.encode("utf-8")) > MAX_WORKSPACE_BYTES:
            raise ValueError("Workspace document exceeds the 64 KiB limit")
        detached = json.loads(encoded)
        if detached != document:
            raise ValueError("Workspace document must contain only JSON values")
        # Reuse the acquisition detector; do not persist recognized credential material.
        from .repository_context import SECRET_CONTENT
        if any(SECRET_CONTENT.search(value) for value in document.values() if isinstance(value, str)):
            raise ValueError("Workspace documents must not contain credentials")
        return detached, encoded
    except (TypeError, RecursionError, UnicodeError) as exc:
        raise ValueError("Workspace document must contain bounded, valid UTF-8 JSON values") from exc


def validate_authority(authority: dict[str, Any]) -> None:
    """Validate the local user's bounded authority envelope, never model text."""
    if not isinstance(authority, dict):
        raise ValueError("An explicit authority envelope is required")
    if authority.get("issuer") != "local-user" or authority.get("scope") != "local-artifacts":
        raise ValueError("Authority must be issued by local-user for local-artifacts")
    actions = authority.get("actions")
    if (not isinstance(actions, list) or any(not isinstance(a, str) for a in actions)
            or set(actions) != {"build", "run", "commit"} or len(actions) != 3):
        raise ValueError("Authority must explicitly grant build, run and commit")
    for key, ceiling in (("max_candidates", 2), ("max_input_bytes", 65536)):
        value = authority.get(key)
        if type(value) is not int or not 1 <= value <= ceiling:
            raise ValueError(f"Authority {key} must be an integer from 1 to {ceiling}")
    if "expires_at" in authority:
        try:
            expiry = datetime.fromisoformat(authority["expires_at"].replace("Z", "+00:00"))
            if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
                raise ValueError("Authority has expired or lacks a timezone")
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError("Authority expiry must be a future timezone-aware ISO timestamp") from exc
    _json(authority)


def _safe_path(path: Path) -> None:
    """Refuse symlinks and Windows junction/reparse points, including ancestors."""
    for candidate in (path, *path.parents):
        try:
            metadata = candidate.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(metadata.st_mode)
                or getattr(metadata, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            raise ValueError(f"Factory state paths must not use symlinks or reparse points: {candidate}")


class CommitService(WorkCommitMixin, ScheduleCommitMixin, ConceptCommitMixin, RuntimeSetupCommitMixin, ProjectFileCommitMixin,
                    LifecycleCommitMixin, ShipGateCommitMixin, MediaCommitMixin, FranklinCommitMixin):
    def validate_work_delivery(self, mission_id, artifact_id):
        from .work_delivery import validate_delivery
        return validate_delivery(self, mission_id, artifact_id)

    def commit_work_delivery(self, mission_id, artifact_id, validation_token, authority):
        from .work_delivery import commit_delivery
        return commit_delivery(self, mission_id, artifact_id, validation_token, authority)

    """The only writer of authoritative factory state and artifact contents."""

    def __init__(self, root: Path):
        _safe_path(Path(root))
        self.root = Path(os.path.abspath(root))
        if os.name == "nt" and self.root.drive.startswith("\\\\"):
            raise ValueError("Factory state must use a local filesystem root")
        self.path = self.root / "foundry.sqlite3"
        self._lock_file: Any = None
        self._closed = False
        self._check_paths()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._check_paths()
        if self.path.exists() and not self.path.is_file():
            raise ValueError("Factory database path must be a regular file")
        self._db = sqlite3.connect(str(self.path), timeout=5, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        try:
            self._db.execute("PRAGMA busy_timeout=5000")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._initialize_schema()
            self.verify_integrity()
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
        except BaseException:
            self._db.close()
            self._closed = True
            raise

    def _check_paths(self) -> None:
        for path in (self.root, self.path, self.root / "worker.lock",
                     Path(str(self.path) + "-wal"), Path(str(self.path) + "-shm"),
                     Path(str(self.path) + "-journal")):
            _safe_path(path)

    def _initialize_schema(self) -> None:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            version = self._db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError(f"Factory database schema {version} is newer than supported {SCHEMA_VERSION}")
            if version == 0:
                tables = self._db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                if tables:
                    raise RuntimeError("Refusing to adopt an unversioned database with existing tables")
                statements = (
                    """CREATE TABLE missions (
                        id TEXT PRIMARY KEY, spec TEXT NOT NULL, status TEXT NOT NULL,
                        authority TEXT NOT NULL, created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL, data TEXT NOT NULL, attempts INTEGER NOT NULL,
                        idempotency_key TEXT NOT NULL UNIQUE, submission_digest TEXT NOT NULL
                    )""",
                    """CREATE TABLE artifacts (
                        mission_id TEXT PRIMARY KEY REFERENCES missions(id), files TEXT NOT NULL,
                        digest TEXT NOT NULL, validation TEXT NOT NULL, selection TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )""",
                    """CREATE TABLE events (
                        id INTEGER PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
                        event_type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
                        state_digest TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL
                    )""",
                    "CREATE INDEX events_mission_id ON events(mission_id, id)",
                    "PRAGMA user_version=1",
                )
                for statement in statements:
                    self._db.execute(statement)
            if version < 2:
                for statement in (
                    """CREATE TABLE conversations (
                        id TEXT PRIMARY KEY, document TEXT NOT NULL,
                        revision INTEGER NOT NULL CHECK(revision > 0),
                        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                    )""",
                    """CREATE TABLE conversation_events (
                        id INTEGER PRIMARY KEY,
                        conversation_id TEXT NOT NULL REFERENCES conversations(id),
                        revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL,
                        created_at TEXT NOT NULL, state_digest TEXT NOT NULL,
                        previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
                        UNIQUE(conversation_id, revision)
                    )""",
                    "CREATE INDEX conversation_events_conversation ON conversation_events(conversation_id, id)",
                    "PRAGMA user_version=2",
                ):
                    self._db.execute(statement)
            if version < 3:
                for statement in (
                    """CREATE TABLE workspace_documents (
                        kind TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
                        revision INTEGER NOT NULL CHECK(revision > 0),
                        PRIMARY KEY(kind, id)
                    )""",
                    """CREATE TABLE workspace_events (
                        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, document_id TEXT NOT NULL,
                        revision INTEGER NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL,
                        created_at TEXT NOT NULL, state_digest TEXT NOT NULL,
                        previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
                        FOREIGN KEY(kind, document_id) REFERENCES workspace_documents(kind, id),
                        UNIQUE(kind, document_id, revision)
                    )""",
                    "CREATE INDEX workspace_events_document ON workspace_events(kind, document_id, id)",
                    "PRAGMA user_version=3",
                ):
                    self._db.execute(statement)
            if version < 4:
                self._initialize_work_schema()
                self._db.execute("PRAGMA user_version=4")
            if version < 5:
                self._initialize_schedule_schema()
                self._db.execute("PRAGMA user_version=5")
            if version < 6:
                self._initialize_concept_schema()
                self._db.execute("PRAGMA user_version=6")
            if version < 7:
                # Generated Concept version variants need no table or row rewrite.
                # Existing receipt bytes remain intact; verification below must
                # succeed before this marker-only migration is committed.
                self._db.execute("PRAGMA user_version=7")
            if version < 8:
                # Verify the complete existing journal before adding this lane.
                # No prior documents, mission clocks or receipt bytes are rewritten.
                self._verify_or_raise(include_runtime_setups=False, include_project_files=False, include_lifecycles=False,
                                      include_ship_gate=False)
                self._initialize_runtime_setup_schema()
                self._db.execute("PRAGMA user_version=8")
            if version < 9:
                self._verify_or_raise(include_project_files=False, include_lifecycles=False, include_ship_gate=False)
                self._initialize_project_file_schema()
                self._db.execute("PRAGMA user_version=9")
            if version < 10:
                # Deployed agent lifecycles: a new independent lane. Existing journals
                # are verified first; no prior document or receipt bytes are rewritten.
                self._verify_or_raise(include_lifecycles=False, include_ship_gate=False)
                self._initialize_lifecycle_schema()
                self._db.execute("PRAGMA user_version=10")
            if version < 11:
                # Ship gate: a new independent lane, verified-first like v10. Nothing prior is rewritten.
                self._verify_or_raise(include_ship_gate=False)
                self._initialize_ship_schema()
                self._db.execute("PRAGMA user_version=11")
            self._initialize_franklin_schema()
            if version < SCHEMA_VERSION:
                # Roll back all migration work if an existing journal is corrupt.
                self._verify_or_raise()
            self._db.execute("COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK")
            raise

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("CommitService is closed")
        self._check_paths()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self._ensure_open()
        self._db.execute("BEGIN IMMEDIATE")
        try:
            self._verify_or_raise()
            yield
            self._db.execute("COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK")
            raise

    @contextmanager
    def _read_transaction(self) -> Iterator[None]:
        self._ensure_open()
        if self._db.in_transaction:
            yield
            return
        self._db.execute("BEGIN")
        try:
            self._verify_or_raise()
            yield
        finally:
            self._db.execute("ROLLBACK")

    @staticmethod
    def _check_id(mission_id: str) -> None:
        if not isinstance(mission_id, str) or not _MISSION_ID.fullmatch(mission_id):
            raise ValueError("Invalid mission identifier")

    @staticmethod
    def _mission(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "spec": json.loads(row["spec"]),
                "status": row["status"], "authority": json.loads(row["authority"]),
                "created_at": row["created_at"], "updated_at": row["updated_at"],
                "data": json.loads(row["data"]), "attempts": row["attempts"]}

    def _required(self, mission_id: str) -> dict[str, Any]:
        mission = self.get_mission(mission_id)
        if mission is None:
            raise KeyError(f"Mission {mission_id} does not exist")
        return mission

    def _state_digest(self, mission_id: str) -> str:
        mission = self._db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone()
        artifact = self._db.execute("SELECT * FROM artifacts WHERE mission_id=?", (mission_id,)).fetchone()
        return _digest({"mission": dict(mission) if mission else None,
                        "artifact": dict(artifact) if artifact else None})

    def _append_event(self, mission_id: str, event_type: str, data: dict[str, Any]) -> dict[str, Any]:
        last = self._db.execute("SELECT id, hash FROM events ORDER BY id DESC LIMIT 1").fetchone()
        event = {"id": last["id"] + 1 if last else 1, "mission_id": mission_id,
                 "event_type": event_type, "data": data, "created_at": _now(),
                 "state_digest": self._state_digest(mission_id),
                 "previous_hash": last["hash"] if last else _ZERO_HASH}
        event["hash"] = _digest(event)
        self._db.execute("""INSERT INTO events
            (id, mission_id, event_type, data, created_at, state_digest, previous_hash, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (event["id"], mission_id, event_type, _json(data), event["created_at"],
             event["state_digest"], event["previous_hash"], event["hash"]))
        return event

    def submit(self, spec: dict[str, Any], idempotency_key: str,
               authority: dict[str, Any]) -> dict[str, Any]:
        validate_authority(authority)
        if not isinstance(spec, dict) or not spec:
            raise ValueError("Mission specification must be a non-empty object")
        if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 256:
            raise ValueError("Idempotency key must contain 1 to 256 characters")
        spec_json = _json(spec)
        if len(spec_json.encode("utf-8")) > authority["max_input_bytes"]:
            raise ValueError("Mission specification exceeds the authority input limit")
        submission_digest = _digest({"spec": spec, "authority": authority})
        with self._transaction():
            existing = self._db.execute("SELECT * FROM missions WHERE idempotency_key=?",
                                        (idempotency_key,)).fetchone()
            if existing:
                if existing["submission_digest"] != submission_digest:
                    raise ValueError("Idempotency key already belongs to a different specification or authority")
                return self._mission(existing)
            mission_id, timestamp = uuid.uuid4().hex, _now()
            self._db.execute("INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (mission_id, spec_json, "queued", _json(authority), timestamp, timestamp, "{}", 0,
                 idempotency_key, submission_digest))
            self._append_event(mission_id, "mission.submitted", {"submission_digest": submission_digest})
            return self._required(mission_id)

    def list_missions(self) -> list[dict[str, Any]]:
        with self._read_transaction():
            return [self._mission(row) for row in self._db.execute("SELECT * FROM missions ORDER BY created_at, id")]

    def list_missions_page(self, limit: int = 200, cursor: str | None = None) -> dict[str, Any]:
        """Bounded discovery metadata, without mission context or artifact source."""
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("Mission discovery pages contain 1..200 records")
        if cursor is not None:
            self._check_id(cursor)
        with self._read_transaction():
            anchor = None
            if cursor is not None:
                anchor = self._db.execute("SELECT created_at,id FROM missions WHERE id=?", (cursor,)).fetchone()
                if anchor is None:
                    raise ValueError("Mission discovery cursor not found")
            fields = "id,status,created_at,updated_at,idempotency_key"
            if anchor:
                rows = self._db.execute(f"SELECT {fields} FROM missions WHERE (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?",
                                        (anchor["created_at"], anchor["id"], limit + 1)).fetchall()
            else:
                rows = self._db.execute(f"SELECT {fields} FROM missions ORDER BY created_at,id LIMIT ?", (limit + 1,)).fetchall()
            missions = [dict(row) for row in rows[:limit]]
            return {"missions": missions, "next_cursor": missions[-1]["id"] if len(rows) > limit else None,
                    "total": self._db.execute("SELECT COUNT(*) FROM missions").fetchone()[0]}

    def get_mission(self, mission_id: str) -> dict[str, Any] | None:
        self._check_id(mission_id)
        with self._read_transaction():
            row = self._db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone()
            return self._mission(row) if row else None

    def get_mission_by_key(self, key: str) -> dict[str, Any] | None:
        if not isinstance(key, str) or not 1 <= len(key) <= 200:
            raise ValueError('Mission lookup requires a bounded idempotency key')
        with self._read_transaction():
            row = self._db.execute('SELECT * FROM missions WHERE idempotency_key=?', (key,)).fetchone()
            return self._mission(row) if row else None

    def transition(self, mission_id: str, expected_status: str, new_status: str,
                   data: dict[str, Any] | None = None) -> dict[str, Any]:
        if data is not None and not isinstance(data, dict):
            raise ValueError("Mission data must be an object")
        with self._transaction():
            mission = self._required(mission_id)
            validate_authority(mission["authority"])
            if mission["status"] != expected_status:
                raise ValueError(f"Mission status is {mission['status']}, expected {expected_status}")
            if new_status not in _TRANSITIONS.get(expected_status, set()):
                raise ValueError(f"Illegal mission transition {expected_status} -> {new_status}")
            if new_status == "queued" and self._lock_file is None:
                raise RuntimeError("Interrupted mission recovery requires the exclusive worker lock")
            merged = {**mission["data"], **(data or {})}
            attempts = mission["attempts"] + (1 if new_status == "running" else 0)
            self._db.execute("UPDATE missions SET status=?, updated_at=?, data=?, attempts=? WHERE id=?",
                             (new_status, _now(), _json(merged), attempts, mission_id))
            self._append_event(mission_id, "mission.transitioned",
                               {"from": expected_status, "to": new_status, "data": data or {}})
            return self._required(mission_id)

    def record_event(self, mission_id: str, event_type: str,
                     data: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(event_type, str) or not event_type.strip() or len(event_type) > 128:
            raise ValueError("Event type must contain 1 to 128 characters")
        if not isinstance(data, dict):
            raise ValueError("Event data must be an object")
        with self._transaction():
            mission = self._required(mission_id)
            validate_authority(mission["authority"])
            return self._append_event(mission_id, event_type, data)

    def publish(self, mission_id: str, files: dict[str, str], validation: dict[str, Any],
                selection: dict[str, Any]) -> dict[str, Any]:
        if (not isinstance(files, dict) or not files
                or any(not isinstance(k, str) or not isinstance(v, str) for k, v in files.items())):
            raise ValueError("Artifact files must be a non-empty mapping of text paths to text contents")
        for name in files:
            if (not name or "\\" in name or name.startswith("/") or ":" in name
                    or any(part in {"", ".", ".."} for part in name.split("/"))):
                raise ValueError("Artifact paths must be normalized relative paths")
        digest = artifact_digest(files)
        if (not isinstance(validation, dict) or validation.get("passed") is not True
                or validation.get("errors") or validation.get("artifact_digest") != digest):
            raise ValueError("Publication requires passed validation bound to this artifact digest")
        if not isinstance(selection, dict) or not selection:
            raise ValueError("Publication requires an explainable selection record")
        # Deliberately resolve the independent validator here. A caller-provided
        # passed flag never grants permission to publish executable content.
        from foundry.pack_compiler import validate_pack
        independently_verified = validate_pack(files)
        if independently_verified.get("passed") is not True or independently_verified.get("errors"):
            raise ValueError("Independent pack validation rejected publication")
        evidence = {**validation, "independent_validation": independently_verified}
        with self._transaction():
            mission = self._required(mission_id)
            validate_authority(mission["authority"])
            if mission["status"] != "validating":
                raise ValueError("Only a validating mission can publish an artifact")
            try:
                manifest = json.loads(files["manifest.json"])
                published_spec = {"name": manifest["name"], "description": manifest["description"],
                                  "capabilities": sorted(item["id"] for item in manifest["capabilities"])}
                expected_spec = {**mission["spec"], "name": mission["spec"]["name"].strip(),
                                 "capabilities": sorted(mission["spec"]["capabilities"])}
            except (KeyError, TypeError, AttributeError, ValueError) as exc:
                raise ValueError("Publication requires a manifest bound to the mission specification") from exc
            if published_spec != expected_spec:
                raise ValueError("Published pack does not match the authorized mission specification")
            if (selection.get("strategy") != manifest["strategy"] or selection.get("digest") != digest
                    or not isinstance(selection.get("reason"), str) or not selection["reason"].strip()):
                raise ValueError("Selection must explain and identify this artifact digest and manifest strategy")
            if self._db.execute("SELECT 1 FROM artifacts WHERE mission_id=?", (mission_id,)).fetchone():
                raise ValueError("An immutable artifact is already committed for this mission")
            timestamp = _now()
            self._db.execute("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)",
                             (mission_id, _json(files), digest, _json(evidence), _json(selection), timestamp))
            self._db.execute("UPDATE missions SET status='completed', updated_at=? WHERE id=?",
                             (timestamp, mission_id))
            self._append_event(mission_id, "artifact.committed",
                               {"artifact_digest": digest, "validation": evidence, "selection": selection})
            artifact = self.get_artifact(mission_id)
            assert artifact is not None
            return artifact

    def get_artifact(self, mission_id: str) -> dict[str, Any] | None:
        self._check_id(mission_id)
        with self._read_transaction():
            row = self._db.execute("SELECT * FROM artifacts WHERE mission_id=?", (mission_id,)).fetchone()
            if row is None:
                return None
            result = dict(row)
            for key in ("files", "validation", "selection"):
                result[key] = json.loads(result[key])
            if artifact_digest(result["files"]) != result["digest"]:
                raise RuntimeError("Factory integrity check failed: artifact digest mismatch")
            return result

    def export_artifact(self, mission_id: str) -> dict[str, Any]:
        """Materialize an immutable deterministic ZIP from committed DB content.

        The ZIP is a derived export cache. A crash between installing it and
        committing its receipt may leave a valid unreceipted cache file; retry
        verifies identical bytes and records the receipt. SQLite remains the
        authoritative artifact store throughout.
        """
        with self._transaction():
            mission = self._required(mission_id)
            validate_authority(mission["authority"])
            artifact = self.get_artifact(mission_id)
            if mission["status"] != "completed" or artifact is None:
                raise ValueError("Only a completed mission has an exportable artifact")
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, content in sorted(artifact["files"].items()):
                    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    entry.create_system = 3
                    entry.external_attr = 0o100644 << 16
                    entry.compress_type = zipfile.ZIP_STORED
                    archive.writestr(entry, content.encode("utf-8"))
            payload = buffer.getvalue()
            zip_digest = hashlib.sha256(payload).hexdigest()
            directory = self.root / "exports"
            destination = directory / f"{artifact['digest']}.zip"
            _safe_path(destination)
            directory.mkdir(exist_ok=True)
            _safe_path(destination)
            if destination.exists():
                if not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != zip_digest:
                    raise RuntimeError("Existing export differs from the immutable committed artifact")
            else:
                temporary_path = None
                try:
                    with tempfile.NamedTemporaryFile(prefix=".export-", suffix=".tmp", dir=directory,
                                                     delete=False) as temporary:
                        temporary_path = Path(temporary.name)
                        temporary.write(payload)
                        temporary.flush()
                        os.fsync(temporary.fileno())
                    _safe_path(destination)
                    try:
                        # Link installation is atomic and refuses an existing target.
                        # The temporary file is on the same volume as the destination.
                        os.link(temporary_path, destination)
                    except FileExistsError:
                        _safe_path(destination)
                        if hashlib.sha256(destination.read_bytes()).hexdigest() != zip_digest:
                            raise RuntimeError("A conflicting immutable export appeared during installation")
                finally:
                    if temporary_path is not None:
                        temporary_path.unlink(missing_ok=True)
            receipt = {"mission_id": mission_id, "artifact_digest": artifact["digest"],
                       "path": str(destination), "zip_digest": zip_digest, "bytes": len(payload)}
            self._append_event(mission_id, "artifact.exported", receipt)
            return receipt

    def events(self, mission_id: str) -> list[dict[str, Any]]:
        self._check_id(mission_id)
        with self._read_transaction():
            result = []
            for row in self._db.execute("SELECT * FROM events WHERE mission_id=? ORDER BY id", (mission_id,)):
                event = dict(row)
                event["data"] = json.loads(event["data"])
                result.append(event)
            return result

    @staticmethod
    def _conversation(row: sqlite3.Row) -> dict[str, Any]:
        return {**json.loads(row["document"]), "revision": row["revision"]}

    def _conversation_list(self) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT * FROM conversations ORDER BY updated_at DESC, id LIMIT ?",
            (MAX_CONVERSATIONS + 1,),
        ).fetchall()
        result = [self._conversation(row) for row in rows]
        self._check_conversation_list(result)
        return result

    @staticmethod
    def _check_conversation_list(conversations: list[dict[str, Any]]) -> None:
        if len(conversations) > MAX_CONVERSATIONS:
            raise ValueError("Conversation journal is limited to 200 conversations")
        envelope = {"ok": True, "result": {"conversations": conversations}}
        if len(_json(envelope).encode("utf-8")) + 1 > MAX_CONVERSATION_LIST_BYTES:
            raise ValueError("Conversation journal exceeds the 4 MiB history limit")

    def list_conversations(self) -> list[dict[str, Any]]:
        """Return the complete bounded history; never silently omit records."""
        with self._read_transaction():
            return self._conversation_list()

    def _conversation_state_digest(self, conversation_id: str) -> str:
        row = self._db.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        return _digest(dict(row) if row else None)

    def _append_conversation_event(self, conversation: dict[str, Any], revision: int,
                                   authority: dict[str, Any]) -> dict[str, Any]:
        last = self._db.execute("SELECT id, hash FROM conversation_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {
            "id": last["id"] + 1 if last else 1,
            "conversation_id": conversation["id"], "revision": revision,
            "event_type": "conversation.created" if revision == 1 else "conversation.updated",
            # Snapshots retain the source content for reconstructing earlier revisions.
            "data": {"authority": authority, "conversation": conversation},
            "created_at": _now(),
            "state_digest": self._conversation_state_digest(conversation["id"]),
            "previous_hash": last["hash"] if last else _ZERO_HASH,
        }
        event["hash"] = _digest(event)
        self._db.execute(
            """INSERT INTO conversation_events
               (id, conversation_id, revision, event_type, data, created_at, state_digest, previous_hash, hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            tuple(_json(event[key]) if key == "data" else event[key] for key in (
                "id", "conversation_id", "revision", "event_type", "data", "created_at",
                "state_digest", "previous_hash", "hash")),
        )
        return event

    def commit_conversation(self, conversation: dict[str, Any], expected_revision: int,
                            *, authority: dict[str, Any]) -> dict[str, Any]:
        """Commit conversational state under a local ingress authority envelope.

        Revision zero creates a record. Subsequent writes must name the exact
        committed revision. Conversation timestamps never drive mission state.
        """
        _conversation_authority(authority)
        document, encoded = _conversation_document(conversation)
        if type(expected_revision) is not int or not 0 <= expected_revision < 2**63 - 1:
            raise ValueError("expected_revision must be a nonnegative integer")
        with self._transaction():
            current = self._db.execute("SELECT * FROM conversations WHERE id=?", (document["id"],)).fetchone()
            revision = current["revision"] if current else 0
            if expected_revision != revision:
                raise ConversationConflictError(
                    f"Conversation revision conflict: expected {expected_revision}, current {revision}")
            if current:
                previous = json.loads(current["document"])
                if document["createdAt"] != previous["createdAt"]:
                    raise ValueError("Conversation id and createdAt are immutable")
                if _iso_timestamp(document["updatedAt"], "updatedAt") < _iso_timestamp(previous["updatedAt"], "updatedAt"):
                    raise ValueError("Conversation updatedAt cannot move backwards")
            saved = {**document, "revision": revision + 1}
            projected = [item for item in self._conversation_list() if item["id"] != document["id"]]
            self._check_conversation_list([*projected, saved])
            created_at = _iso_timestamp(document["createdAt"], "createdAt").astimezone(timezone.utc).isoformat(timespec="microseconds")
            updated_at = _iso_timestamp(document["updatedAt"], "updatedAt").astimezone(timezone.utc).isoformat(timespec="microseconds")
            if current:
                self._db.execute("UPDATE conversations SET document=?, revision=?, updated_at=? WHERE id=? AND revision=?",
                                 (encoded, revision + 1, updated_at, document["id"], revision))
            else:
                self._db.execute("INSERT INTO conversations (id, document, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                                 (document["id"], encoded, 1, created_at, updated_at))
            self._append_conversation_event(document, revision + 1, authority)
            return saved

    def _verify_conversations(self) -> dict[str, Any]:
        previous_hash, count, latest = _ZERO_HASH, 0, {}
        for row in self._db.execute("SELECT * FROM conversation_events ORDER BY id"):
            event = dict(row)
            event["data"] = json.loads(event["data"])
            stored_hash = event.pop("hash")
            count += 1
            if event["id"] != count or event["previous_hash"] != previous_hash or _digest(event) != stored_hash:
                raise ValueError(f"Conversation event hash chain mismatch at event {event['id']}")
            _conversation_authority(event["data"]["authority"])
            document, encoded = _conversation_document(event["data"]["conversation"])
            previous = latest.get(event["conversation_id"])
            expected = previous["revision"] + 1 if previous else 1
            if (event["revision"] != expected or document["id"] != event["conversation_id"]
                    or event["event_type"] != ("conversation.created" if expected == 1 else "conversation.updated")):
                raise ValueError("Conversation revision or identity mismatch")
            created_at = _iso_timestamp(document["createdAt"], "createdAt").astimezone(timezone.utc).isoformat(timespec="microseconds")
            updated_at = _iso_timestamp(document["updatedAt"], "updatedAt").astimezone(timezone.utc).isoformat(timespec="microseconds")
            if previous and (previous["createdAt"] != document["createdAt"] or updated_at < previous["updated_at"]):
                raise ValueError("Conversation immutable timestamp or clock mismatch")
            state = {"id": document["id"], "document": encoded, "revision": expected,
                     "created_at": created_at, "updated_at": updated_at}
            if _digest(state) != event["state_digest"]:
                raise ValueError("Conversation event snapshot mismatch")
            latest[event["conversation_id"]] = {"revision": expected, "digest": event["state_digest"],
                                                 "createdAt": document["createdAt"], "updated_at": updated_at}
            previous_hash = stored_hash
        conversations = self._conversation_list()
        if {record["id"] for record in conversations} != set(latest):
            raise ValueError("Conversation/event coverage mismatch")
        for record in conversations:
            if (record["revision"] != latest[record["id"]]["revision"]
                    or self._conversation_state_digest(record["id"]) != latest[record["id"]]["digest"]):
                raise ValueError("Conversation state does not match its committed journal")
        return {"conversations": len(conversations), "conversation_events": count,
                "conversation_head_hash": previous_hash}

    def _workspace_list(self, kind: str) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT document, revision FROM workspace_documents WHERE kind=? ORDER BY id LIMIT ?",
            (kind, MAX_WORKSPACE_DOCUMENTS + 1),
        ).fetchall()
        result = [{**json.loads(row["document"]), "revision": row["revision"]} for row in rows]
        self._check_workspace_list(kind, result)
        return result

    @staticmethod
    def _check_workspace_list(kind: str, documents: list[dict[str, Any]]) -> None:
        maximum = 1 if kind == "settings" else MAX_WORKSPACE_DOCUMENTS
        if len(documents) > maximum:
            raise ValueError(f"Workspace {kind} journal is limited to {maximum} documents")
        envelope = {"ok": True, "result": {"documents": documents}}
        if len(_json(envelope).encode("utf-8")) + 1 > MAX_WORKSPACE_LIST_BYTES:
            raise ValueError("Workspace journal exceeds the 4 MiB history limit")

    def list_workspace(self, kind: str) -> list[dict[str, Any]]:
        """List complete bounded workspace records independently of mission state."""
        _workspace_kind(kind)
        with self._read_transaction():
            return self._workspace_list(kind)

    def _workspace_state_digest(self, kind: str, document_id: str) -> str:
        row = self._db.execute("SELECT * FROM workspace_documents WHERE kind=? AND id=?",
                               (kind, document_id)).fetchone()
        return _digest(dict(row) if row else None)

    def _append_workspace_event(self, kind: str, document: dict[str, Any], revision: int,
                                authority: dict[str, Any]) -> dict[str, Any]:
        last = self._db.execute("SELECT id, hash FROM workspace_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {
            "id": last["id"] + 1 if last else 1, "kind": kind,
            "document_id": document["id"], "revision": revision,
            "event_type": f"workspace.{kind}.{'created' if revision == 1 else 'updated'}",
            "data": {"authority": authority, "document": document}, "created_at": _now(),
            "state_digest": self._workspace_state_digest(kind, document["id"]),
            "previous_hash": last["hash"] if last else _ZERO_HASH,
        }
        event["hash"] = _digest(event)
        self._db.execute(
            """INSERT INTO workspace_events
               (id, kind, document_id, revision, event_type, data, created_at, state_digest, previous_hash, hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            tuple(_json(event[key]) if key == "data" else event[key] for key in (
                "id", "kind", "document_id", "revision", "event_type", "data", "created_at",
                "state_digest", "previous_hash", "hash")),
        )
        return event

    def commit_workspace(self, kind: str, document: dict[str, Any], expected_revision: int,
                         *, authority: dict[str, Any]) -> dict[str, Any]:
        """Commit selected project metadata or credential-free desktop preferences.

        Paths/endpoints are stored as user selections; this grants no filesystem,
        network or mission authority and does not access the selected resources.
        """
        _workspace_authority(authority)
        document, encoded = _workspace_document(kind, document)
        if type(expected_revision) is not int or not 0 <= expected_revision < 2**63 - 1:
            raise ValueError("expected_revision must be a nonnegative integer")
        with self._transaction():
            current = self._db.execute("SELECT * FROM workspace_documents WHERE kind=? AND id=?",
                                       (kind, document["id"])).fetchone()
            revision = current["revision"] if current else 0
            if revision != expected_revision:
                raise WorkspaceConflictError(
                    f"Workspace revision conflict: expected {expected_revision}, current {revision}")
            if current and kind == "project":
                previous = json.loads(current["document"])
                if document["createdAt"] != previous["createdAt"]:
                    raise ValueError("Project id and createdAt are immutable")
                if _iso_timestamp(document["updatedAt"], "updatedAt") < _iso_timestamp(previous["updatedAt"], "updatedAt"):
                    raise ValueError("Project updatedAt cannot move backwards")
            saved = {**document, "revision": revision + 1}
            projected = [item for item in self._workspace_list(kind) if item["id"] != document["id"]]
            self._check_workspace_list(kind, [*projected, saved])
            if current:
                self._db.execute(
                    "UPDATE workspace_documents SET document=?, revision=? WHERE kind=? AND id=? AND revision=?",
                    (encoded, revision + 1, kind, document["id"], revision))
            else:
                self._db.execute("INSERT INTO workspace_documents (kind, id, document, revision) VALUES (?, ?, ?, ?)",
                                 (kind, document["id"], encoded, 1))
            self._append_workspace_event(kind, document, revision + 1, authority)
            return saved

    def _verify_workspace(self) -> dict[str, Any]:
        previous_hash, count, latest = _ZERO_HASH, 0, {}
        for row in self._db.execute("SELECT * FROM workspace_events ORDER BY id"):
            event = dict(row)
            event["data"] = json.loads(event["data"])
            stored_hash = event.pop("hash")
            count += 1
            if event["id"] != count or event["previous_hash"] != previous_hash or _digest(event) != stored_hash:
                raise ValueError(f"Workspace event hash chain mismatch at event {event['id']}")
            _workspace_authority(event["data"]["authority"])
            document, encoded = _workspace_document(event["kind"], event["data"]["document"])
            key = (event["kind"], event["document_id"])
            previous = latest.get(key)
            expected = previous["revision"] + 1 if previous else 1
            if (event["revision"] != expected or document["id"] != event["document_id"]
                    or event["event_type"] != f"workspace.{event['kind']}.{'created' if expected == 1 else 'updated'}"):
                raise ValueError("Workspace revision or identity mismatch")
            if previous and event["kind"] == "project":
                if (document["createdAt"] != previous["document"]["createdAt"]
                        or _iso_timestamp(document["updatedAt"], "updatedAt")
                        < _iso_timestamp(previous["document"]["updatedAt"], "updatedAt")):
                    raise ValueError("Project immutable timestamp or clock mismatch")
            state = {"kind": event["kind"], "id": document["id"], "document": encoded, "revision": expected}
            if _digest(state) != event["state_digest"]:
                raise ValueError("Workspace event snapshot mismatch")
            latest[key] = {"revision": expected, "digest": event["state_digest"], "document": document}
            previous_hash = stored_hash
        records = list(self._db.execute("SELECT kind, id, revision FROM workspace_documents"))
        if {(row["kind"], row["id"]) for row in records} != set(latest):
            raise ValueError("Workspace/event coverage mismatch")
        for row in records:
            key = (row["kind"], row["id"])
            if (row["revision"] != latest[key]["revision"]
                    or self._workspace_state_digest(*key) != latest[key]["digest"]):
                raise ValueError("Workspace state does not match its committed journal")
        for kind in ("project", "settings"):
            self._workspace_list(kind)
        return {"workspace_documents": len(records), "workspace_events": count,
                "workspace_head_hash": previous_hash}

    def _verify_or_raise(self, *, include_runtime_setups: bool = True, include_project_files: bool = True,
                         include_lifecycles: bool = True, include_ship_gate: bool = True) -> dict[str, Any]:
        try:
            if self._db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("SQLite structural check failed")
            if self._db.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Database contains orphaned records")
            previous_hash, count, latest = _ZERO_HASH, 0, {}
            for row in self._db.execute("SELECT * FROM events ORDER BY id"):
                event = dict(row)
                event["data"] = json.loads(event["data"])
                stored_hash = event.pop("hash")
                count += 1
                if (event["id"] != count or event["previous_hash"] != previous_hash
                        or _digest(event) != stored_hash):
                    raise ValueError(f"Event hash chain mismatch at event {event['id']}")
                previous_hash = stored_hash
                latest[event["mission_id"]] = event["state_digest"]
            missions = list(self._db.execute("SELECT id, status FROM missions"))
            if {row["id"] for row in missions} != set(latest):
                raise ValueError("Mission/event coverage mismatch")
            for mission in missions:
                if mission["status"] not in _TRANSITIONS:
                    raise ValueError("Unknown mission status")
                if self._state_digest(mission["id"]) != latest[mission["id"]]:
                    raise ValueError(f"Mission or artifact state mismatch for {mission['id']}")
                artifact = self._db.execute("SELECT * FROM artifacts WHERE mission_id=?", (mission["id"],)).fetchone()
                if bool(artifact) != (mission["status"] == "completed"):
                    raise ValueError("Committed artifact/completed mission mismatch")
                if artifact and artifact_digest(json.loads(artifact["files"])) != artifact["digest"]:
                    raise ValueError("Artifact digest mismatch")
            conversation_integrity = self._verify_conversations()
            workspace_integrity = self._verify_workspace()
            work_integrity = self._verify_work()
            schedule_integrity = self._verify_schedules()
            concept_integrity = self._verify_concepts()
            runtime_integrity = self._verify_runtime_setups() if include_runtime_setups else {}
            project_file_integrity = self._verify_project_files() if include_project_files else {}
            lifecycle_integrity = self._verify_lifecycles() if include_lifecycles else {}
            ship_integrity = self._verify_ship_gate() if include_ship_gate else {}
            franklin_integrity = self._verify_franklin()
            return {"ok": True, "passed": True, "events": count, "missions": len(missions),
                    "head_hash": previous_hash,
                    **conversation_integrity,
                    **workspace_integrity,
                    **work_integrity,
                    **schedule_integrity,
                    **concept_integrity,
                    **runtime_integrity,
                    **project_file_integrity,
                    **lifecycle_integrity,
                    **ship_integrity,
                    **franklin_integrity,
                    "assurance": "Unkeyed integrity chain; not a signature or proof against full database rewriting"}
        except (ValueError, TypeError, KeyError, RecursionError, sqlite3.DatabaseError) as exc:
            raise RuntimeError(f"Factory integrity check failed: {exc}") from exc

    def verify_integrity(self) -> dict[str, Any]:
        self._ensure_open()
        # A read transaction keeps the chain and state on one consistent snapshot.
        self._db.execute("BEGIN")
        try:
            return self._verify_or_raise()
        finally:
            self._db.execute("ROLLBACK")

    @contextmanager
    def acquire_worker(self) -> Iterator["CommitService"]:
        """Acquire a nonblocking OS lock; process death automatically releases it."""
        self._ensure_open()
        if self._lock_file is not None:
            raise RuntimeError("This CommitService already holds the factory worker lock")
        lock_path = self.root / "worker.lock"
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(lock_path, flags, 0o600)
        handle = os.fdopen(descriptor, "r+b", buffering=0)
        try:
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b"\0")
            handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError("Another factory worker owns the exclusive worker lock") from exc
            self._lock_file = handle
            try:
                self.verify_integrity()
                yield self
            finally:
                self._release_worker()
        finally:
            if not handle.closed:
                handle.close()

    def _release_worker(self) -> None:
        handle = self._lock_file
        if handle is None:
            return
        self._lock_file = None
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def close(self) -> None:
        if not self._closed:
            self._release_worker()
            self._db.close()
            self._closed = True

    def __enter__(self) -> "CommitService":
        self._ensure_open()
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
