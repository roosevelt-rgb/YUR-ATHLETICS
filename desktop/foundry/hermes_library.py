"""Read-only access to the versioned YUR Hermes skill snapshot.

Hermes skills contribute operator-selected context and an inert support-asset
manifest. They never become providers, orchestrators, validators, committers,
or executable tools merely by appearing in this catalog.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from .repository_context import SECRET_CONTENT
from .sources import read_checked, reject_reparse


SCHEMA = "yur.hermes-skill-snapshot.v1"
MAX_CATALOG_BYTES = 2 * 1024 * 1024
MAX_SKILL_BYTES = 300 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024
MAX_SKILLS = 500
MAX_FILES = 5_000
MAX_BUNDLE_FILES = 1_000
MAX_BUNDLE_BYTES = 20 * 1024 * 1024
MAX_REQUEST_BYTES = 16_384
MAX_PAGE = 100
LIMITS = {
    "catalog_bytes": MAX_CATALOG_BYTES, "skill_bytes": MAX_SKILL_BYTES,
    "support_asset_bytes": MAX_ASSET_BYTES, "catalog_skills": MAX_SKILLS,
    "catalog_files": MAX_FILES, "page_size": MAX_PAGE,
}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key in Hermes snapshot: {key}")
        result[key] = value
    return result


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _text(value, maximum=2_000) -> bool:
    return isinstance(value, str) and len(value) <= maximum and "\0" not in value


def _string_list(value, maximum=200) -> bool:
    return isinstance(value, list) and len(value) <= maximum and all(_text(item, 500) for item in value)


class HermesLibrary:
    def __init__(self, root: Path | str):
        if not isinstance(root, (str, Path)) or not str(root) or not Path(root).is_absolute():
            raise ValueError("Hermes snapshot root must be an explicit absolute directory")
        self.root = Path(root)
        reject_reparse(self.root)
        self._bundled = self.root.is_file()
        if not self.root.is_dir() and not (self._bundled and self.root.suffix.lower() == ".zip"):
            raise ValueError("The versioned Hermes snapshot is unavailable")
        if self._bundled:
            self._validate_bundle()
        raw = self._read("catalog.json", MAX_CATALOG_BYTES)
        try:
            catalog = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_unique_object,
                                 parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"invalid JSON constant: {value}")))
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ValueError("The Hermes snapshot catalog is invalid") from exc
        self._validate_catalog(catalog)
        license_bytes = self._read("LICENSE.hermes", 64 * 1024)
        if _digest(license_bytes) != catalog["identity"]["license_sha256"]:
            raise ValueError("The Hermes snapshot license no longer matches its catalog")
        self.catalog_data = catalog
        self.license_notice = license_bytes.decode("utf-8-sig")
        self.skills = {entry["path"]: entry for entry in catalog["skills"]}
        self.files = {entry["path"]: entry for entry in catalog["files"]}

    def _validate_bundle(self) -> None:
        names, total = set(), 0
        try:
            with zipfile.ZipFile(self.root) as archive:
                entries = archive.infolist()
                if not 1 <= len(entries) <= MAX_BUNDLE_FILES:
                    raise ValueError("Hermes bundle entry count is outside its bound")
                for item in entries:
                    name = item.filename
                    parts = Path(name).parts
                    mode = item.external_attr >> 16
                    if (item.is_dir() or not name or "\\" in name or ":" in name or name.startswith("/")
                            or any(part in {"", ".", ".."} for part in parts) or name.casefold() in names
                            or (mode and (mode & 0o170000) not in {0, 0o100000})
                            or item.file_size > MAX_ASSET_BYTES):
                        raise ValueError("Hermes bundle contains an unsafe or oversized entry")
                    names.add(name.casefold())
                    total += item.file_size
                    if total > MAX_BUNDLE_BYTES:
                        raise ValueError("Hermes bundle exceeds its expanded byte budget")
        except zipfile.BadZipFile as exc:
            raise ValueError("The versioned Hermes bundle is invalid") from exc

    def _read(self, relative: str, maximum: int) -> bytes:
        if not self._bundled:
            return read_checked(self.root, relative, maximum)
        try:
            with zipfile.ZipFile(self.root) as archive:
                info = archive.getinfo(relative)
                if info.file_size > maximum:
                    raise ValueError("Hermes bundle entry exceeds its read budget")
                data = archive.read(info)
        except (KeyError, zipfile.BadZipFile, RuntimeError) as exc:
            raise ValueError("Hermes bundle entry is unavailable or corrupt") from exc
        if len(data) > maximum or len(data) != info.file_size:
            raise ValueError("Hermes bundle entry exceeds its read budget")
        return data

    def _validate_catalog(self, catalog: object) -> None:
        if not isinstance(catalog, dict) or catalog.get("schema") != SCHEMA or catalog.get("catalog_version") != 1:
            raise ValueError("The directory is not a supported YUR Hermes snapshot")
        identity = catalog.get("identity")
        skills, files = catalog.get("skills"), catalog.get("files")
        redacted = catalog.get("redacted", [])
        if (not isinstance(identity, dict) or identity.get("name") != "hermes-agent" or identity.get("license") != "MIT"
                or not _text(identity.get("version"), 100) or not _sha(identity.get("license_sha256"))
                or not isinstance(skills, list) or not 1 <= len(skills) <= MAX_SKILLS
                or not isinstance(files, list) or not len(skills) <= len(files) <= MAX_FILES
                or not isinstance(redacted, list) or len(redacted) > MAX_FILES):
            raise ValueError("The Hermes snapshot identity or bounds are invalid")
        file_paths, skill_paths = set(), set()
        for item in files:
            if (not isinstance(item, dict) or set(item) != {"path", "sha256", "source_sha256", "bytes", "source_lane", "redactions", "role", "execution_admitted"}
                    or not _text(item["path"], 500) or "\\" in item["path"] or ".." in Path(item["path"]).parts
                    or not item["path"].startswith(("skills/", "package/")) or not _sha(item["sha256"]) or not _sha(item["source_sha256"])
                    or type(item["bytes"]) is not int or not 0 <= item["bytes"] <= MAX_ASSET_BYTES
                    or item["source_lane"] not in {"active", "optional"} or type(item["redactions"]) is not int or item["redactions"] < 0
                    or item["role"] not in {"skill_definition", "support", "package_metadata"} or item["execution_admitted"] is not False
                    or item["path"] in file_paths):
                raise ValueError("The Hermes file manifest is invalid")
            file_paths.add(item["path"])
        for entry in skills:
            required = {"id", "path", "category", "source_lane", "name", "description", "version", "author", "license", "platforms", "dependencies", "tags", "commands", "env_vars", "toolsets", "sha256", "bytes", "support_paths"}
            if (not isinstance(entry, dict) or set(entry) != required or not all(_text(entry[key], 2_000) for key in ("id", "path", "category", "name", "description", "version", "author", "license"))
                    or entry["source_lane"] not in {"active", "optional"} or not all(_string_list(entry[key]) for key in ("platforms", "dependencies", "tags", "commands", "env_vars", "toolsets", "support_paths"))
                    or not _sha(entry["sha256"]) or type(entry["bytes"]) is not int or not 0 <= entry["bytes"] <= MAX_SKILL_BYTES
                    or entry["path"] not in file_paths or not entry["path"].endswith("/SKILL.md") or entry["path"] in skill_paths
                    or any(path not in file_paths or path == entry["path"] for path in entry["support_paths"])):
                raise ValueError("The Hermes skill manifest is invalid")
            skill_paths.add(entry["path"])
        material = json.dumps({"files": files, "redacted": redacted}, sort_keys=True, separators=(",", ":")).encode()
        if not _sha(catalog.get("snapshot_id")) or _digest(material) != catalog["snapshot_id"]:
            raise ValueError("The Hermes snapshot identity does not match its file manifest")
        counts = catalog.get("counts")
        if (not isinstance(counts, dict) or counts.get("skills") != len(skills) or counts.get("files") != len(files)
                or counts.get("support_files") != sum(item["role"] == "support" for item in files)
                or counts.get("package_files") != sum(item["role"] == "package_metadata" for item in files)):
            raise ValueError("The Hermes snapshot counts are inconsistent")

    def _skill(self, path: str, verify_support: bool = False) -> tuple[dict, str, list[dict]]:
        if not isinstance(path, str) or path not in self.skills:
            raise ValueError("Select an exact skill from the current Hermes snapshot")
        entry = self.skills[path]
        raw = self._read(path, MAX_SKILL_BYTES)
        if len(raw) != entry["bytes"] or _digest(raw) != entry["sha256"]:
            raise ValueError("Hermes skill content changed after the snapshot was created")
        try:
            content = raw.decode("utf-8-sig")
        except UnicodeError as exc:
            raise ValueError("Hermes skill instructions must be UTF-8 text") from exc
        if "\0" in content or SECRET_CONTENT.search(content):
            raise ValueError("Hermes skill instructions contain content that was not safely admitted")
        supports = []
        for support_path in entry["support_paths"]:
            manifest = self.files[support_path]
            if verify_support:
                support = self._read(support_path, MAX_ASSET_BYTES)
                if len(support) != manifest["bytes"] or _digest(support) != manifest["sha256"]:
                    raise ValueError(f"Hermes support asset changed after snapshot creation: {support_path}")
            supports.append({key: manifest[key] for key in ("path", "sha256", "bytes", "role", "redactions", "execution_admitted")})
        public = {key: entry[key] for key in entry if key != "support_paths"}
        public.update({"kind": "skill", "binding": "selected-instructions", "execution_admitted": False,
                       "support_files": len(supports), "support_bytes": sum(item["bytes"] for item in supports),
                       "support_manifest_sha256": _digest(json.dumps(supports, sort_keys=True, separators=(",", ":")).encode())})
        return public, content, supports

    def catalog(self, query: str = "", lane: str = "", limit: int = 30, offset: int = 0) -> dict:
        if not isinstance(query, str) or len(query) > 200:
            raise ValueError("Hermes skill search must contain at most 200 characters")
        if lane not in {"", "active", "optional"}:
            raise ValueError("Unknown Hermes source lane")
        if type(limit) is not int or not 1 <= limit <= MAX_PAGE or type(offset) is not int or not 0 <= offset <= MAX_SKILLS:
            raise ValueError("Invalid Hermes catalog page")
        terms = re.findall(r"[a-z0-9]+", query.lower())
        matches = []
        for skill in self.catalog_data["skills"]:
            haystack = " ".join([skill["id"], skill["name"], skill["description"], skill["category"], *skill["tags"]]).lower()
            if (not lane or skill["source_lane"] == lane) and all(term in haystack for term in terms):
                matches.append(skill)
        entries = []
        for skill in matches[offset:offset + limit]:
            entry, _, _ = self._skill(skill["path"])
            entry["selection_reason"] = "Name, description, category, tags, or path matches the explicit search and source-lane filter"
            entries.append(entry)
        identity = {key: self.catalog_data["identity"][key] for key in ("name", "version", "license", "upstream", "license_sha256")}
        return {
            "root": str(self.root), "schema": SCHEMA, "snapshot_id": self.catalog_data["snapshot_id"],
            "identity": identity, "entries": entries, "total_matches": len(matches),
            "total_skills": len(self.catalog_data["skills"]), "total_files": len(self.catalog_data["files"]),
            "support_files": self.catalog_data["counts"]["support_files"], "redacted_files": self.catalog_data["counts"]["redacted_files"],
            "package_files": self.catalog_data["counts"]["package_files"],
            "offset": offset, "next_offset": offset + limit if offset + limit < len(matches) else None,
            "mode": "read-only", "search_fields": ["name", "description", "category", "tags", "path"], "limits": LIMITS,
        }

    def acquire(self, path: str, expected_sha256: str) -> dict:
        if not _sha(expected_sha256):
            raise ValueError("Expected SHA-256 must identify the selected Hermes skill version")
        entry, content, supports = self._skill(path, verify_support=True)
        if entry["sha256"] != expected_sha256:
            raise ValueError("Hermes skill instructions changed since selection; refresh the library before using them")
        return {
            "root": str(self.root), "schema": SCHEMA, "snapshot_id": self.catalog_data["snapshot_id"],
            "identity": self.catalog_data["identity"], "entry": entry, "content": content,
            "support_assets": supports, "license_notice": self.license_notice,
            "provenance": {
                "operation_id": str(uuid.uuid4()), "acquired_at": datetime.now(timezone.utc).isoformat(),
                "operation": "hermes.instructions.acquired", "mode": "read-only", "relative_path": entry["path"],
                "sha256": entry["sha256"], "bytes": entry["bytes"], "snapshot_id": self.catalog_data["snapshot_id"],
                "selection_reason": "Explicit operator-selected versioned Hermes skill instructions",
                "authority": "instructions-only; Foundry, OrchestrationManager, Validation and Commit Service retain authority",
                "dependencies": "Support files are hash-verified but inert; referenced commands, packages, providers, credentials and services are not installed, started or admitted",
            },
            "limits": LIMITS,
        }


def dispatch(request: dict) -> dict:
    if not isinstance(request, dict):
        raise ValueError("Expected a Hermes library request object")
    command = request.get("command")
    fields = {"catalog": {"command", "root", "query", "lane", "limit", "offset"},
              "acquire": {"command", "root", "path", "expected_sha256"}}
    if command not in fields or set(request) - fields[command]:
        raise ValueError("Unsupported Hermes library command or request fields")
    library = HermesLibrary(request.get("root"))
    if command == "catalog":
        return library.catalog(request.get("query", ""), request.get("lane", ""), request.get("limit", 30), request.get("offset", 0))
    return library.acquire(request.get("path"), request.get("expected_sha256"))


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("Hermes library request exceeds 16 KiB")
        response, status = {"ok": True, "result": dispatch(json.loads(raw, object_pairs_hook=_unique_object))}, 0
    except (OSError, ValueError, TypeError, UnicodeError) as exc:
        response, status = {"ok": False, "error": {"code": "HERMES_LIBRARY_UNAVAILABLE", "message": str(exc)[:1000]}}, 1
    print(json.dumps(response, ensure_ascii=True, allow_nan=False))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
