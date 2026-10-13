"""Read-only acquisition of explicitly selected Awesome Copilot instructions.

This adapter imports no donor code, follows no Markdown links, installs no tools,
and grants no execution authority. Selected content remains subordinate to the
operator request and YUR governance when a caller compiles it into model context.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .repository_context import SECRET_CONTENT
from .sources import read_checked, reject_reparse

MAX_ASSET_BYTES = 65_536
MAX_ENTRIES = 4000
MAX_DIRECTORY_ENTRIES = 6000
MAX_REQUEST_BYTES = 16_384
LIMITS = {"directory_entries_per_collection": MAX_DIRECTORY_ENTRIES,
          "catalog_assets": MAX_ENTRIES, "page_size": 100,
          "asset_bytes": MAX_ASSET_BYTES, "request_bytes": MAX_REQUEST_BYTES,
          "collection_depth": 2}
KINDS = ("skill", "agent", "instruction")
_SLUG = r"[A-Za-z0-9][A-Za-z0-9._-]{0,160}"
_PATTERNS = {
    "skill": re.compile(rf"skills/({_SLUG})/SKILL\.md\Z"),
    "agent": re.compile(rf"agents/({_SLUG})\.agent\.md\Z"),
    "instruction": re.compile(rf"instructions/({_SLUG})\.instructions\.md\Z"),
}


def _classify(relative_path: str) -> tuple[str, str]:
    if not isinstance(relative_path, str) or "\\" in relative_path or ".." in relative_path:
        raise ValueError("Select an exact supported library-relative Markdown path")
    for kind, pattern in _PATTERNS.items():
        match = pattern.fullmatch(relative_path)
        if match:
            return kind, match.group(1)
    raise ValueError("Only skills/*/SKILL.md, agents/*.agent.md and instructions/*.instructions.md are supported")


def _scalar_metadata(content: str) -> dict:
    """Display-only frontmatter projection; never instantiate YAML or obey fields."""
    lines = content.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    values = {}
    for line in lines[1:150]:
        if line.strip() == "---":
            break
        match = re.match(r"^(name|description|license|compatibility|applyTo):\s*(.*)$", line)
        if not match:
            continue
        key, value = match.groups()
        if value in {"|", ">", "|-", ">-", "|+", ">+"}:
            continue
        if len(value) > 1 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value[:1000]
    return values


class CopilotLibrary:
    def __init__(self, root: Path | str):
        if not isinstance(root, (str, Path)) or not str(root) or not Path(root).is_absolute():
            raise ValueError("Library root must be an explicit absolute directory")
        self.root = Path(root)
        reject_reparse(self.root)
        if not self.root.is_dir():
            raise ValueError("The selected library directory is unavailable")
        manifest_bytes = read_checked(self.root, "package.json", 65_536)
        if SECRET_CONTENT.search(manifest_bytes.decode("utf-8-sig")):
            raise ValueError("Library identity contains credential-like data and is excluded")
        manifest = json.loads(manifest_bytes)
        if not isinstance(manifest, dict) or manifest.get("name") != "awesome-copilot":
            raise ValueError("The selected directory is not an Awesome Copilot library")
        license_bytes = read_checked(self.root, "LICENSE", 16_384)
        self.license_notice = license_bytes.decode("utf-8-sig")
        if SECRET_CONTENT.search(self.license_notice):
            raise ValueError("Library license contains credential-like data and is excluded")
        repository = manifest.get("repository", {})
        if isinstance(repository, dict):
            repository = repository.get("url", "")
        self.identity = {
            "name": "awesome-copilot",
            "version": str(manifest.get("version", ""))[:100],
            "repository": repository[:300] if isinstance(repository, str) else "",
            "license": str(manifest.get("license", ""))[:100],
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "license_sha256": hashlib.sha256(license_bytes).hexdigest(),
        }

    def _paths(self) -> tuple[list[str], bool]:
        paths = []
        truncated = False
        for collection in ("skills", "agents", "instructions"):
            folder = self.root / collection
            reject_reparse(folder)
            if not folder.exists():
                continue
            with os.scandir(folder) as entries:
                names = []
                for index, item in enumerate(entries):
                    if index >= MAX_DIRECTORY_ENTRIES:
                        truncated = True
                        break
                    if item.name.startswith(".") or item.is_symlink():
                        continue
                    if collection == "skills" and item.is_dir(follow_symlinks=False):
                        relative = f"skills/{item.name}/SKILL.md"
                    elif collection != "skills" and item.is_file(follow_symlinks=False):
                        relative = f"{collection}/{item.name}"
                    else:
                        continue
                    try:
                        _classify(relative)
                        reject_reparse(self.root / relative)
                        if not (self.root / relative).is_file():
                            continue
                    except (OSError, ValueError):
                        continue
                    names.append(relative)
                paths.extend(sorted(names, key=str.casefold))
        paths.sort(key=str.casefold)
        return paths[:MAX_ENTRIES], truncated or len(paths) > MAX_ENTRIES

    def _entry(self, relative_path: str) -> tuple[dict, str]:
        kind, slug = _classify(relative_path)
        raw = read_checked(self.root, relative_path, MAX_ASSET_BYTES)
        content = raw.decode("utf-8-sig")
        if "\x00" in content:
            raise ValueError("Selected instructions must be UTF-8 Markdown text")
        if SECRET_CONTENT.search(content):
            raise ValueError("Selected instructions contain credential-like data and are excluded")
        fields = _scalar_metadata(content)
        entry = {
            "id": relative_path,
            "kind": kind,
            "name": fields.get("name") or slug.replace("-", " "),
            "path": relative_path,
            "description": fields.get("description", ""),
            "compatibility": fields.get("compatibility", ""),
            "apply_to": fields.get("applyTo", ""),
            "license": fields.get("license") or self.identity["license"],
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "binding": "selected-instructions",
            "execution_admitted": False,
        }
        return entry, content

    def catalog(self, query: str = "", kind: str = "", limit: int = 30, offset: int = 0) -> dict:
        if not isinstance(query, str) or len(query) > 200:
            raise ValueError("Library search must contain at most 200 characters")
        if kind not in ("", *KINDS):
            raise ValueError("Unknown library resource kind")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Library result limit must be 1..100")
        if type(offset) is not int or not 0 <= offset <= MAX_ENTRIES:
            raise ValueError("Library offset must be 0..4000")
        paths, truncated = self._paths()
        terms = re.findall(r"[a-z0-9]+", query.lower())
        matches = [relative for relative in paths
                   if (not kind or _classify(relative)[0] == kind)
                   and all(term in relative.lower() for term in terms)]
        entries, excluded = [], []
        for relative in matches[offset:offset + limit]:
            try:
                entry, _ = self._entry(relative)
                entry["selection_reason"] = "Library name/path matches the explicit search and kind filter"
                entries.append(entry)
            except (OSError, ValueError, UnicodeError):
                excluded.append({"path": relative, "reason": "Unavailable, unsafe content, invalid text or exceeds 64 KiB"})
        return {
            "root": str(self.root), "identity": self.identity,
            "entries": entries, "total_matches": len(matches), "total_assets": len(paths),
            "offset": offset, "next_offset": offset + limit if offset + limit < len(matches) else None,
            "truncated": truncated, "excluded": excluded,
            "search_fields": ["name", "path"], "mode": "read-only",
            "limits": LIMITS,
        }

    def acquire(self, relative_path: str, expected_sha256: str | None = None) -> dict:
        if expected_sha256 is not None and (not isinstance(expected_sha256, str)
                or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)):
            raise ValueError("Expected SHA-256 must be a lowercase 64-character digest")
        entry, content = self._entry(relative_path)
        if expected_sha256 is not None and entry["sha256"] != expected_sha256:
            raise ValueError("Library instructions changed since selection; refresh the library before using them")
        return {
            "root": str(self.root), "identity": self.identity, "entry": entry,
            "content": content, "license_notice": self.license_notice,
            "provenance": {
                "operation_id": str(uuid.uuid4()), "acquired_at": datetime.now(timezone.utc).isoformat(),
                "operation": "library.instructions.acquired", "mode": "read-only",
                "relative_path": entry["path"], "sha256": entry["sha256"], "bytes": entry["bytes"],
                "selection_reason": "Explicit operator-selected library instructions",
                "authority": "instructions-only; no tool, shell, network or filesystem-write grants",
                "dependencies": "Referenced scripts, files, tools and models are not loaded or installed",
            },
            "limits": LIMITS,
        }


def dispatch(request: dict) -> dict:
    if not isinstance(request, dict):
        raise ValueError("Expected a library request object")
    command = request.get("command")
    fields = {"catalog": {"command", "root", "query", "kind", "limit", "offset"},
              "acquire": {"command", "root", "path", "expected_sha256"}}
    if not isinstance(command, str) or command not in fields or set(request) - fields[command]:
        raise ValueError("Unsupported library command or request fields")
    library = CopilotLibrary(request.get("root"))
    if command == "catalog":
        return library.catalog(request.get("query", ""), request.get("kind", ""),
                               request.get("limit", 30), request.get("offset", 0))
    return library.acquire(request.get("path"), request.get("expected_sha256"))


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("Library request exceeds 16 KiB")
        result = dispatch(json.loads(raw))
        response = {"ok": True, "result": result}
        status = 0
    except (OSError, ValueError, TypeError, UnicodeError) as exc:
        response = {"ok": False, "error": {"code": "LIBRARY_UNAVAILABLE", "message": str(exc)[:1000]}}
        status = 1
    print(json.dumps(response, ensure_ascii=True, allow_nan=False))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
