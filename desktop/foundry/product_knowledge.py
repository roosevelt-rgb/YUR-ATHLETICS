"""Version-bound product source coverage and strict, read-only knowledge lookup.

This module does not ingest files, create an index, grant authority, or contact a
model. A trusted caller chooses a product root and supplies a separately admitted
ReadScope. The manifest is path/metadata coverage, not proof of file contents.
The SQLite adapter expects an already built, immutable ``knowledge_chunks`` index.
"""
from __future__ import annotations

from collections import Counter
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
from typing import Mapping, Protocol

from .repository_context import SECRET_CONTENT, SENSITIVE_NAME, STATE_FILE
from .sources import reject_reparse


MANIFEST_SCHEMA = "yur.product-knowledge-coverage.v1"
MAX_ENTRIES = 250_000
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_RESULTS = 20
MAX_SNIPPET_CHARS = 4096
SOURCE_SUFFIXES = frozenset({
    ".c", ".cc", ".cjs", ".cpp", ".css", ".go", ".h", ".html",
    ".java", ".js", ".json", ".jsx", ".md", ".mjs", ".mod",
    ".proto", ".ps1", ".py", ".rs", ".scss", ".sh", ".sql",
    ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
})
EXCLUDED_DIRECTORIES = frozenset({
    "__pycache__", "archive", "archives", "backups", "build", "builds",
    "cache", "caches", "coverage", "dist", "env", "log", "logs",
    "node_modules", "out", "private", "personal", "profiles", "release",
    "releases", "state", "target", "user-data", "userdata",
    "temp", "tmp", "uploads", "venv", "vendor",
})
PRIVATE_SUFFIXES = frozenset({
    ".db", ".db3", ".kdbx", ".key", ".p12", ".pem", ".pfx",
    ".sqlite", ".sqlite3",
})
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
ENV_NAME = re.compile(r"(?:^|[._-])env(?:[._-]|$)", re.I)


def _identifier(value: str, name: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError(f"{name} must be a stable identifier of at most 80 characters")
    return value


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sensitive_name(name: str) -> bool:
    lowered = name.casefold()
    return (name.startswith(".") or bool(ENV_NAME.search(name))
            or bool(SENSITIVE_NAME.search(name))
            or bool(STATE_FILE.search(name)) or Path(lowered).suffix in PRIVATE_SUFFIXES)


def _source_path(path: str) -> bool:
    if not isinstance(path, str) or not path or "\\" in path or path.startswith("/"):
        return False
    components = path.split("/")
    return all(component not in {"", ".", ".."} and not _sensitive_name(component)
               and component.casefold() not in EXCLUDED_DIRECTORIES for component in components)


def _is_reparse(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _manifest_identity(manifest: Mapping) -> dict:
    return {key: manifest[key] for key in (
        "schema", "product_id", "product_version", "root_fingerprint",
        "included", "excluded", "counts", "coverage_complete", "source_contents_read",
    )}


def build_product_manifest(root: str | Path, product_id: str, version: str,
                           *, max_entries: int = MAX_ENTRIES) -> dict:
    """Inventory a selected product tree without opening any source file.

    Every observed entry is included or has an explicit exclusion reason.
    Excluded directories are *subtrees not scanned*, so this is complete only
    for eligible source candidates under this policy, not every file on disk.
    Sensitive entry names are redacted from the returned manifest.
    A scan error or budget exhaustion raises instead of reporting success.
    """
    _identifier(product_id, "product_id")
    _identifier(version, "version")
    if type(max_entries) is not int or max_entries < 1:
        raise ValueError("max_entries must be a positive integer")
    selected = Path(root)
    if not selected.is_absolute() or ".." in selected.parts or selected == Path(selected.anchor):
        raise ValueError("An absolute non-drive-root product directory is required")
    reject_reparse(selected)
    if not selected.is_dir() or _sensitive_name(selected.name):
        raise ValueError("Selected product directory is unavailable or excluded")
    selected = selected.resolve(strict=True)

    included: list[dict] = []
    excluded: list[dict] = []
    counts: Counter = Counter()
    pending = [selected]
    observed = 0
    while pending:
        directory = pending.pop()
        reject_reparse(directory)
        try:
            with os.scandir(directory) as scan:
                entries = sorted(scan, key=lambda entry: entry.name.casefold())
        except OSError as error:
            raise ValueError("Product coverage scan failed") from error
        for entry in entries:
            observed += 1
            if observed > max_entries:
                raise ValueError("Product coverage scan exceeded its entry budget")
            relative = (directory / entry.name).relative_to(selected).as_posix()
            if _sensitive_name(entry.name):
                # Do not stat, enter, or disclose the name of a sensitive entry.
                excluded.append({"path": None, "reason": "sensitive_or_private_name"})
                counts["sensitive_or_private_name"] += 1
                continue
            if entry.name.casefold() in EXCLUDED_DIRECTORIES:
                excluded.append({"path": relative, "reason": "excluded_subtree"})
                counts["excluded_subtree"] += 1
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise ValueError("Product coverage metadata scan failed") from error
            if _is_reparse(info):
                excluded.append({"path": relative, "reason": "reparse_point"})
                counts["reparse_point"] += 1
            elif stat.S_ISDIR(info.st_mode):
                pending.append(Path(entry.path))
                counts["directories_scanned"] += 1
            elif stat.S_ISREG(info.st_mode):
                suffix = Path(entry.name).suffix.casefold()
                if suffix not in SOURCE_SUFFIXES or (suffix == ".txt" and entry.name.casefold() not in {
                        "readme.txt", "requirements.txt", "cmakelists.txt"}):
                    reason = "unsupported_type"
                elif info.st_size > MAX_SOURCE_BYTES:
                    reason = "oversize_source"
                else:
                    included.append({"path": relative, "size_bytes": info.st_size,
                                     "mtime_ns": info.st_mtime_ns})
                    counts["included"] += 1
                    continue
                excluded.append({"path": relative, "reason": reason})
                counts[reason] += 1
            else:
                excluded.append({"path": relative, "reason": "non_regular"})
                counts["non_regular"] += 1

    included.sort(key=lambda item: item["path"])
    excluded.sort(key=lambda item: (item["path"] or "", item["reason"]))
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "product_id": product_id,
        "product_version": version,
        "root_fingerprint": hashlib.sha256(str(selected).encode("utf-8")).hexdigest(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "coverage_complete": True,
        "coverage_meaning": "all eligible source paths observed under the exclusion policy",
        "source_contents_read": False,
        "included": included,
        "excluded": excluded,
        "counts": dict(sorted(counts.items())),
    }
    manifest["manifest_digest"] = hashlib.sha256(_canonical(_manifest_identity(manifest))).hexdigest()
    return manifest


@dataclass(frozen=True)
class ReadScope:
    """Exact read boundary supplied by an already authorized caller.

    This is a query constraint, not an authentication or approval token.
    User and extension scopes require separately admitted source inventories.
    """

    kind: str
    owner_id: str
    version: str
    allowed_sources: frozenset[str]
    coverage_digest: str

    def __post_init__(self) -> None:
        if self.kind not in {"product", "user", "extension"}:
            raise ValueError("Unsupported knowledge scope kind")
        _identifier(self.owner_id, "owner_id")
        _identifier(self.version, "version")
        if not isinstance(self.allowed_sources, frozenset) or any(
                not _source_path(path) for path in self.allowed_sources):
            raise ValueError("Read scope requires normalized eligible source paths")
        if not isinstance(self.coverage_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", self.coverage_digest):
            raise ValueError("Read scope requires a coverage digest")

    @property
    def namespace_id(self) -> str:
        return f"{self.kind}:{self.owner_id}"


def product_scope_from_manifest(manifest: Mapping) -> ReadScope:
    """Bind queries to the exact product version and manifest source allowlist."""
    try:
        if manifest["schema"] != MANIFEST_SCHEMA or manifest["coverage_complete"] is not True \
                or manifest["source_contents_read"] is not False:
            raise ValueError("Product manifest is incomplete or unsupported")
        actual = hashlib.sha256(_canonical(_manifest_identity(manifest))).hexdigest()
        if manifest["manifest_digest"] != actual:
            raise ValueError("Product manifest digest mismatch")
        paths = [entry["path"] for entry in manifest["included"]]
        if len(paths) != len(set(paths)):
            raise ValueError("Product manifest contains duplicate source paths")
        return ReadScope("product", manifest["product_id"], manifest["product_version"],
                         frozenset(paths), actual)
    except (KeyError, TypeError) as error:
        raise ValueError("Malformed product manifest") from error


class ReadOnlyBackend(Protocol):
    def query_read_only(self, scope: ReadScope, text: str, limit: int) -> list[Mapping]: ...


class SQLiteReadOnlyBackend:
    """Literal substring lookup in an existing immutable SQLite knowledge index.

    Expected ``knowledge_chunks`` columns: scope_kind, owner_id, namespace_id,
    version, coverage_digest, source_path, chunk_id, snippet. No schema creation
    or writes occur. All five scope predicates are mandatory; there is no
    broad-query fallback.
    """

    def __init__(self, database: str | Path):
        path = Path(database)
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError("Knowledge index path must be absolute")
        self.database = path

    def query_read_only(self, scope: ReadScope, text: str, limit: int) -> list[Mapping]:
        reject_reparse(self.database)
        if not self.database.is_file():
            raise OSError("Knowledge index unavailable")
        uri = self.database.as_uri() + "?mode=ro&immutable=1"
        with closing(sqlite3.connect(uri, uri=True, timeout=1)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            rows = connection.execute(
                "SELECT scope_kind, owner_id, namespace_id, version, coverage_digest, source_path, "
                "chunk_id, snippet FROM knowledge_chunks "
                "WHERE scope_kind=? AND owner_id=? AND namespace_id=? AND version=? AND coverage_digest=? "
                "AND instr(lower(snippet), lower(?)) > 0 "
                "ORDER BY source_path, chunk_id LIMIT ?",
                (scope.kind, scope.owner_id, scope.namespace_id, scope.version,
                 scope.coverage_digest, text, limit),
            ).fetchall()
        return [dict(row) for row in rows]


def query_scoped_knowledge(backend: ReadOnlyBackend | None, scope: ReadScope,
                           question: str, *, limit: int = 8) -> dict:
    """Return only fully validated rows; failure never masquerades as zero hits."""
    if not isinstance(scope, ReadScope):
        raise ValueError("A previously admitted read scope is required")
    if not isinstance(question, str) or not question.strip() or len(question) > 512:
        raise ValueError("Knowledge question must contain 1 to 512 characters")
    if type(limit) is not int or not 1 <= limit <= MAX_RESULTS:
        raise ValueError("Knowledge result limit is out of range")
    boundary = {"kind": scope.kind, "owner_id": scope.owner_id,
                "namespace_id": scope.namespace_id, "version": scope.version,
                "coverage_digest": scope.coverage_digest}

    def failure(code: str, message: str) -> dict:
        return {"ok": False, "scope": boundary, "results": [],
                "error": {"code": code, "message": message}}

    if backend is None:
        return failure("backend_unavailable", "Knowledge backend is not configured")
    try:
        rows = backend.query_read_only(scope, question.strip(), limit)
    except (OSError, sqlite3.Error, ValueError):
        return failure("backend_unavailable", "Knowledge backend could not complete the read")
    except Exception:
        return failure("backend_failed", "Knowledge backend failed")
    if not isinstance(rows, list) or len(rows) > limit:
        return failure("backend_contract", "Knowledge backend returned an invalid result set")

    results = []
    for row in rows:
        if not isinstance(row, Mapping) or any(row.get(field) != value for field, value in (
                ("scope_kind", scope.kind), ("owner_id", scope.owner_id),
                ("namespace_id", scope.namespace_id), ("version", scope.version),
                ("coverage_digest", scope.coverage_digest))):
            return failure("scope_mismatch", "Knowledge backend crossed the requested scope")
        path, snippet = row.get("source_path"), row.get("snippet")
        if not isinstance(path, str) or path not in scope.allowed_sources:
            return failure("source_uncovered", "Knowledge result is outside covered sources")
        if not isinstance(snippet, str) or len(snippet) > MAX_SNIPPET_CHARS or SECRET_CONTENT.search(snippet):
            return failure("content_rejected", "Knowledge result failed content checks")
        chunk_id = row.get("chunk_id")
        if type(chunk_id) is not int or chunk_id < 0:
            return failure("backend_contract", "Knowledge result has an invalid chunk identity")
        results.append({"source_path": path, "chunk_id": chunk_id, "snippet": snippet})
    return {"ok": True, "scope": boundary, "results": results, "error": None}
