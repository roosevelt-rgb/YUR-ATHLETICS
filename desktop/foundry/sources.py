"""Explicit, read-only source acquisition. Discovery never grants execution authority."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
import re
import stat
from pathlib import Path

SOURCE_SLICES = {
    "terra-pack": ("agents/packs/terra", ["agent-pack.json", "manifest.json", "mesh/engine_manifest.json", "industry/tools/tools-index.json"]),
    "catalog": ("catalog", ["skills/_global/index.json"]),
    "yur-agent-core": ("core/agents/yur-agent", ["packages/core/package.json", "packages/core/src/types/plugin.ts"]),
    "franklin-arbiter": ("governance/arbiter", ["franklin_arbiter.py", "semantic_analyzer.py"]),
    "governance": ("governance", ["intelliport/intelliport.py"]),
    "infrastructure": ("infrastructure", ["port_usher/port_usher_client.py", "switchboard/switchboard_client.py"]),
}

# Reviewed source only. Never enumerate the donor or follow references in these
# files: target/, data/, generated bindings, keys, and machine state are excluded.
YUR_OS_SOURCE_FILES = (
    "__SPINE_NODE__.json", "README.md", "Cargo.toml", "rust-toolchain.toml",
    "proto/spine.proto", "yur-types/src/constitution.rs",
    "yur-substrate/src/main.rs", "yur-substrate/src/grpc.rs",
    "yur-substrate/src/wasm_jit.rs", "yur-substrate/src/rbac.rs",
    "yur-substrate/src/interceptor.rs", "yur-cortex-py/client.py",
    "yur-cortex-py/pyproject.toml", "yur-cortex-py/tests/test_smoke_round_trip.py",
    "yur-intern/src/lib.rs",
)
YUR_OS_FILE_BYTES = 128 * 1024
YUR_OS_TOTAL_BYTES = 512 * 1024
SOURCE_EXCERPT_CHARACTERS = 16000
SOURCE_EXCERPT_BYTES = 64 * 1024
CATALOG_FIELD_LIMITS = {
    "entry_id": 256, "name": 500, "kind": 100, "provider": 200,
    "industry": 300, "workflow": 1000, "path": 4096,
}


def reject_reparse(path: Path) -> None:
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(info.st_mode)
                or getattr(info, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            raise ValueError("source reparse points are not admitted")


def checked_file(root: Path, relative: str, max_bytes: int = 2_000_000) -> Path:
    candidate = root / relative
    reject_reparse(candidate)
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError("source path escapes configured root")
    if not candidate.is_file() or candidate.stat().st_size > max_bytes:
        raise ValueError("source file missing or exceeds read budget")
    return candidate


def read_checked(root: Path, relative: str, max_bytes: int = 2_000_000) -> bytes:
    """Read from one opened regular file, enforcing the budget on actual bytes."""
    target = checked_file(root, relative, max_bytes)
    descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise ValueError("source file missing or exceeds read budget")
        reject_reparse(target)
        current = target.lstat()
        if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("source file changed during acquisition")
        content = stream.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise ValueError("source file exceeds read budget")
        return content


def _configured_root(value: str | None, name: str) -> Path | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 4096 or "\0" in value or not value.strip():
        raise ValueError(f"{name} must be a nonempty path string of at most 4096 characters")
    path = Path(value).absolute()
    reject_reparse(path)
    if path.exists() and not path.is_dir():
        raise ValueError(f"{name} must identify a directory")
    return path


class SourceRegistry:
    def __init__(self, ecosystem_root: Path | None, yur_os_root: Path | None = None):
        # Preserve the original constructor and .root contract for catalog users.
        self.root = ecosystem_root
        self.yur_os_root = yur_os_root
        for root in (self.root, self.yur_os_root):
            if root is not None:
                if not isinstance(root, Path):
                    raise ValueError("source root must be a Path or None")
                reject_reparse(root)
                if root.exists() and not root.is_dir():
                    raise ValueError("source root must identify a directory")

    @classmethod
    def from_environment(cls):
        configured = {
            "ecosystem_root": os.environ.get("YUR_ECOSYSTEM_ROOT"),
            "yur_os_root": os.environ.get("YUR_OS_ROOT"),
        }
        local_config = Path(__file__).resolve().parents[1] / ".factory-sources.local.json"
        # Resolve each root independently; an explicit nonempty environment
        # value wins for that root only. Empty values retain legacy fallback.
        if not all(configured.values()) and local_config.is_file():
            raw = read_checked(local_config.parent, local_config.name, 4096)
            settings = json.loads(raw)
            if not isinstance(settings, dict):
                raise ValueError("source configuration must be an object")
            for name, value in configured.items():
                if not value:
                    configured[name] = settings.get(name)
        return cls(_configured_root(configured["ecosystem_root"], "ecosystem_root"),
                   _configured_root(configured["yur_os_root"], "yur_os_root"))

    def describe(self, query: str = "", limit: int = 12) -> dict:
        if not isinstance(query, str) or len(query) > 200:
            raise ValueError("source query exceeds 200 characters")
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError("source result limit must be 1..50")
        if self.root is None and self.yur_os_root is None:
            return {"configured": False, "sources": [], "catalog_matches": [],
                    "instruction": "Set YUR_ECOSYSTEM_ROOT, YUR_OS_ROOT, or .factory-sources.local.json"}
        records = []
        ecosystem_slices = SOURCE_SLICES.items() if self.root is not None else ()
        for identifier, (relative, slices) in ecosystem_slices:
            base = self.root / relative
            evidence = []
            for name in slices:
                try:
                    content = read_checked(self.root, f"{relative}/{name}")
                    evidence.append({"relative_path": name, "bytes": len(content),
                                     "sha256": hashlib.sha256(content).hexdigest(), "available": True})
                except (OSError, ValueError):
                    evidence.append({"relative_path": name, "available": False})
            records.append({"id": identifier, "path": str(base), "mode": "read-only",
                            "available": all(e["available"] for e in evidence),
                            "execution_admitted": False, "evidence": evidence})
        if self.yur_os_root is not None:
            records.append(self._describe_yur_os())
        matches, count = self.search_catalog(query, limit)
        return {"configured": True, "sources": records, "catalog_matches": matches,
                "catalog_entries": count,
                "admission": "Source identity and catalog presence are evidence of existence; neither authorizes execution or establishes outcome quality"}

    def _describe_yur_os(self) -> dict:
        evidence = []
        remaining = YUR_OS_TOTAL_BYTES
        for name in YUR_OS_SOURCE_FILES:
            try:
                if remaining <= 0:
                    raise ValueError("source acquisition budget exhausted")
                content = read_checked(self.yur_os_root, name, min(YUR_OS_FILE_BYTES, remaining))
                remaining -= len(content)
                evidence.append({"relative_path": name, "bytes": len(content),
                                 "sha256": hashlib.sha256(content).hexdigest(), "available": True})
            except (OSError, ValueError):
                evidence.append({"relative_path": name, "available": False})
        return {"id": "yur-os", "path": str(self.yur_os_root), "mode": "read-only",
                "classification": "source-only", "execution_admitted": False,
                "runtime_verified": False,
                "available": all(item["available"] for item in evidence), "evidence": evidence,
                "limits": {"files": len(YUR_OS_SOURCE_FILES), "file_bytes": YUR_OS_FILE_BYTES,
                           "total_bytes": YUR_OS_TOTAL_BYTES},
                "acquired_bytes": YUR_OS_TOTAL_BYTES - remaining}

    def acquire(self, source_id: str, relative_path: str, expected_sha256: str) -> dict:
        """Acquire one exact registered source as context, never executable input."""
        if (not isinstance(source_id, str) or len(source_id) > 80
                or source_id not in (*SOURCE_SLICES, "yur-os")):
            raise ValueError("Unknown registered source")
        if (not isinstance(relative_path, str) or len(relative_path) > 300
                or not isinstance(expected_sha256, str)
                or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None):
            raise ValueError("An exact registered file and lowercase SHA-256 are required")
        if source_id == "yur-os":
            root, prefix, files = self.yur_os_root, "", YUR_OS_SOURCE_FILES
        else:
            prefix, files = SOURCE_SLICES[source_id]
            root = self.root
        if relative_path not in files:
            raise ValueError("File is outside the registered source allowlist")
        if root is None:
            raise ValueError("Registered source root is not configured")
        full_relative = f"{prefix}/{relative_path}" if prefix else relative_path
        raw = read_checked(root, full_relative, YUR_OS_FILE_BYTES)
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected_sha256:
            raise ValueError("Registered source changed; refresh its source evidence before acquisition")
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ValueError("Registered source is not strict UTF-8 text") from error
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
            raise ValueError("Binary or control-bearing source content is not admitted")
        # Import lazily: repository_context also reuses the checked-file reader.
        # Scan the whole file before taking an excerpt, including any hidden tail.
        from .repository_context import SECRET_CONTENT
        if SECRET_CONTENT.search(text):
            raise ValueError("Credential-like source content is not admitted")
        excerpt = text[:SOURCE_EXCERPT_CHARACTERS]
        encoded = excerpt.encode("utf-8")
        if len(encoded) > SOURCE_EXCERPT_BYTES:
            raise ValueError("Source excerpt exceeds its byte budget")
        evidence = {
            "schema": "yur.source-evidence.v1", "source_id": source_id,
            "root": str(root / prefix) if prefix else str(root), "relative_path": relative_path,
            "sha256": digest, "bytes": len(raw), "acquired_at": datetime.now(timezone.utc).isoformat(),
            "truncated": len(excerpt) != len(text), "excerpt_characters": len(excerpt),
            "excerpt_bytes": len(encoded), "excerpt_sha256": hashlib.sha256(encoded).hexdigest(),
            "context_only": True, "execution_admitted": False,
            "selection_reason": "Exact registered source and file selected with matching whole-file SHA-256",
            "limits": {"file_bytes": YUR_OS_FILE_BYTES, "excerpt_characters": SOURCE_EXCERPT_CHARACTERS,
                       "excerpt_bytes": SOURCE_EXCERPT_BYTES},
        }
        return {"schema": "yur.source-acquisition.v1", "context_only": True,
                "execution_admitted": False, "content": excerpt, "evidence": evidence}

    def search_catalog(self, query: str, limit: int) -> tuple[list, int]:
        if self.root is None:
            return [], 0
        try:
            index = json.loads(read_checked(self.root, "catalog/skills/_global/index.json"))
        except (OSError, ValueError):
            return [], 0
        if not isinstance(index, dict):
            raise ValueError("catalog index must be an object")
        entries = index.get("entries", {})
        if not isinstance(entries, dict) or len(entries) > 10000:
            raise ValueError("catalog index shape or entry budget is invalid")
        from .repository_context import SECRET_CONTENT
        terms = set(re.findall(r"[a-z0-9]+", query.lower()))
        ranked = []
        for key, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            fields = {key: entry.get(key) for key in CATALOG_FIELD_LIMITS}
            if any(value is not None and (
                    not isinstance(value, str) or len(value) > CATALOG_FIELD_LIMITS[field]
                    or re.search(r"[\x00-\x1f\x7f]", value) or SECRET_CONTENT.search(value))
                    for field, value in fields.items()):
                continue
            text = " ".join(str(fields.get(k) or "") for k in ("name", "kind", "industry", "workflow")).lower()
            metadata_terms = set(re.findall(r"[a-z0-9]+", text))
            hits = len(terms & metadata_terms)
            if terms and not hits:
                continue
            # Reference path is returned as an untrusted claim, never followed.
            ranked.append((hits, str(key), {**fields, "execution_admitted": False,
                                          "selection_reason": f"{hits} query terms matched catalog metadata"}))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        return [entry for _, _, entry in ranked[:limit]], len(entries)
