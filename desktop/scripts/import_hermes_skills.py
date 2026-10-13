"""Create a deterministic, versioned YUR snapshot of Hermes skill packages.

The importer copies declared skill directories plus non-hidden package-level
documentation and metadata. Hidden/runtime state, cache directories, sensitive
filenames, reparse points, and credential-bearing text are rejected. Admitted
files remain inert, hash-addressed assets; this script never imports Python
modules or executes donor scripts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import uuid
import zipfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from foundry.repository_context import SECRET_CONTENT


SCHEMA = "yur.hermes-skill-snapshot.v1"
MAX_FILES = 5_000
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
TEXT_EXTENSIONS = {
    "", ".bib", ".bst", ".css", ".html", ".ini", ".js", ".json", ".md",
    ".mjs", ".py", ".sh", ".sty", ".tex", ".tmpl", ".toml", ".txt",
    ".xml", ".xsd", ".yaml", ".yml",
}
BLOCKED_DIRECTORIES = {"__pycache__", "cache", "caches", "logs", "state", "sessions"}
BLOCKED_FILES = {".env", ".keys", "credentials.json", "secrets.json", "tokens.json"}
BLOCKED_SUFFIXES = {".key", ".pem", ".pfx", ".p12", ".db", ".sqlite", ".sqlite3"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def is_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return True
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def reject_path(path: Path, rel: str) -> None:
    parts = Path(rel).parts
    if not parts or any(part.startswith(".") for part in parts):
        raise ValueError(f"hidden path is not admitted: {rel}")
    lowered = [part.casefold() for part in parts]
    if any(part in BLOCKED_DIRECTORIES for part in lowered[:-1]):
        raise ValueError(f"cache or runtime-state directory is not admitted: {rel}")
    name = lowered[-1]
    if (name in BLOCKED_FILES or name.startswith(".env.") or name.startswith(("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"))
            or Path(name).suffix in BLOCKED_SUFFIXES):
        raise ValueError(f"sensitive or runtime-state filename is not admitted: {rel}")
    cursor = path
    while True:
        if is_reparse(cursor):
            raise ValueError(f"reparse points are not admitted: {rel}")
        if cursor.parent == cursor:
            break
        cursor = cursor.parent


def scalar(value: str) -> str:
    value = value.strip()
    if len(value) > 1 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value.strip()


def list_value(value: str) -> list[str]:
    value = value.strip()
    if not (value.startswith("[") and value.endswith("]")):
        return []
    return [scalar(part)[:200] for part in value[1:-1].split(",") if scalar(part)]


def frontmatter(content: str, fallback: str) -> dict:
    lines = content.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != "---":
        return {"name": fallback, "description": "", "version": "", "license": "", "platforms": [], "dependencies": [], "tags": [], "commands": [], "toolsets": []}
    fields: dict[str, object] = {}
    index = 1
    while index < min(len(lines), 240):
        line = lines[index]
        if line.strip() == "---":
            break
        match = re.match(r"^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$", line)
        if match:
            key, value = match.groups()
            if key in {"name", "title", "description", "version", "author", "license"}:
                if value in {"|", ">", "|-", ">-", "|+", ">+"}:
                    block = []
                    index += 1
                    while index < len(lines) and (not lines[index].strip() or lines[index].startswith((" ", "\t"))):
                        block.append(lines[index].strip())
                        index += 1
                    fields[key] = " ".join(part for part in block if part)[:2000]
                    continue
                fields[key] = scalar(value)[:2000]
            elif key in {"platforms", "dependencies", "tags", "commands", "requires_toolsets", "env_vars"}:
                fields[key] = list_value(value)
        index += 1
    return {
        "name": str(fields.get("title") or fields.get("name") or fallback)[:200],
        "description": str(fields.get("description") or "")[:2000],
        "version": str(fields.get("version") or "")[:100],
        "author": str(fields.get("author") or "")[:300],
        "license": str(fields.get("license") or "")[:100],
        "platforms": fields.get("platforms", []),
        "dependencies": fields.get("dependencies", []),
        "tags": fields.get("tags", []),
        "commands": fields.get("commands", []),
        "env_vars": fields.get("env_vars", []),
        "toolsets": fields.get("requires_toolsets", []),
    }


def package_identity(package_root: Path) -> dict:
    pyproject = (package_root / "pyproject.toml").read_bytes()
    license_bytes = (package_root / "LICENSE").read_bytes()
    text = pyproject.decode("utf-8-sig")
    def value(name: str) -> str:
        match = re.search(rf"(?m)^{name}\s*=\s*['\"]([^'\"]+)['\"]", text)
        return match.group(1) if match else ""
    if value("name") != "hermes-agent" or value("license") != "MIT":
        raise ValueError("source package is not the expected MIT-licensed hermes-agent package")
    if SECRET_CONTENT.search(text) or SECRET_CONTENT.search(license_bytes.decode("utf-8-sig")):
        raise ValueError("package identity contains credential-like content")
    return {
        "name": value("name"), "version": value("version"), "license": value("license"),
        "pyproject_sha256": digest(pyproject), "license_sha256": digest(license_bytes),
        "license_bytes": license_bytes,
    }


def discover_lane(root: Path, lane: str) -> list[tuple[Path, str, str]]:
    if not root.is_absolute() or not root.is_dir() or is_reparse(root):
        raise ValueError(f"{lane} skill root is unavailable or unsafe")
    skills = []
    for skill_file in sorted(root.rglob("SKILL.md"), key=lambda item: relative(item, root).casefold()):
        rel = relative(skill_file, root)
        if any(part.startswith(".") for part in Path(rel).parts):
            continue
        reject_path(skill_file, rel)
        skills.append((skill_file.parent, skill_file.parent.relative_to(root).as_posix(), lane))
    return skills


def collect(active: Path, optional: Path) -> tuple[list[dict], dict[str, tuple[Path, str, bytes, int, str]], list[dict]]:
    lane_roots = ((active, "active"), (optional, "optional"))
    skill_dirs = discover_lane(active, "active") + discover_lane(optional, "optional")
    files: dict[str, tuple[Path, str, bytes, int, str]] = {}
    skills = []
    redacted = []
    seen_skills = set()
    total_bytes = 0
    for directory, skill_rel, lane in skill_dirs:
        output_skill = f"skills/{skill_rel}/SKILL.md"
        if output_skill in seen_skills:
            raise ValueError(f"duplicate skill path across source lanes: {output_skill}")
        seen_skills.add(output_skill)
        support_paths = []
        for source in sorted(directory.rglob("*"), key=lambda item: item.as_posix().casefold()):
            if not source.is_file():
                continue
            rel_inside = source.relative_to(directory).as_posix()
            if any(part.startswith(".") for part in Path(rel_inside).parts):
                continue
            source_rel = f"{skill_rel}/{rel_inside}"
            reject_path(source, source_rel)
            size = source.stat().st_size
            if size > MAX_FILE_BYTES:
                raise ValueError(f"skill asset exceeds 2 MiB: {source_rel}")
            data = source.read_bytes()
            if len(data) != size:
                raise ValueError(f"skill asset changed while importing: {source_rel}")
            redaction_count = 0
            if source.suffix.lower() in TEXT_EXTENSIONS:
                try:
                    text = data.decode("utf-8-sig")
                except UnicodeError as exc:
                    raise ValueError(f"text skill asset is not UTF-8: {source_rel}") from exc
                if "\x00" in text:
                    raise ValueError(f"binary content is not admitted as text: {source_rel}")
                text, redaction_count = SECRET_CONTENT.subn("[REDACTED_CREDENTIAL_LIKE_VALUE]", text)
                if redaction_count:
                    data = text.encode("utf-8")
                    redacted.append({"path": f"skills/{source_rel}", "source_lane": lane,
                                     "redactions": redaction_count,
                                     "reason": "credential-like source text replaced before admission"})
            output_rel = f"skills/{source_rel}"
            prior = files.get(output_rel)
            if prior and prior[0] != source:
                raise ValueError(f"duplicate output asset: {output_rel}")
            if not prior:
                files[output_rel] = (source, lane, data, redaction_count,
                                     "skill_definition" if rel_inside == "SKILL.md" else "support")
                total_bytes += len(data)
            if rel_inside != "SKILL.md":
                support_paths.append(output_rel)
        skill_data = files[output_skill][2]
        metadata = frontmatter(skill_data.decode("utf-8-sig"), Path(skill_rel).name)
        skills.append({
            "id": skill_rel, "path": output_skill, "category": skill_rel.split("/", 1)[0],
            "source_lane": lane, **metadata,
            "sha256": digest(skill_data), "bytes": len(skill_data),
            "support_paths": sorted(set(support_paths), key=str.casefold),
        })
    for root, lane in lane_roots:
        lane_skill_dirs = [directory for directory, _, item_lane in skill_dirs if item_lane == lane]
        for source in sorted(root.rglob("*"), key=lambda item: relative(item, root).casefold()):
            if not source.is_file():
                continue
            source_rel = relative(source, root)
            if any(part.startswith(".") for part in Path(source_rel).parts):
                continue
            if any(source == directory or directory in source.parents for directory in lane_skill_dirs):
                continue
            reject_path(source, source_rel)
            size = source.stat().st_size
            if size > MAX_FILE_BYTES:
                raise ValueError(f"package asset exceeds 2 MiB: {source_rel}")
            data = source.read_bytes()
            if len(data) != size:
                raise ValueError(f"package asset changed while importing: {source_rel}")
            redaction_count = 0
            if source.suffix.lower() in TEXT_EXTENSIONS:
                try:
                    text = data.decode("utf-8-sig")
                except UnicodeError as exc:
                    raise ValueError(f"text package asset is not UTF-8: {source_rel}") from exc
                if "\x00" in text:
                    raise ValueError(f"binary content is not admitted as text: {source_rel}")
                text, redaction_count = SECRET_CONTENT.subn("[REDACTED_CREDENTIAL_LIKE_VALUE]", text)
                if redaction_count:
                    data = text.encode("utf-8")
            output_rel = f"package/{lane}/{source_rel}"
            if output_rel in files:
                raise ValueError(f"duplicate package asset: {output_rel}")
            files[output_rel] = (source, lane, data, redaction_count, "package_metadata")
            total_bytes += len(data)
            if redaction_count:
                redacted.append({"path": output_rel, "source_lane": lane,
                                 "redactions": redaction_count,
                                 "reason": "credential-like source text replaced before admission"})
    if len(files) > MAX_FILES or total_bytes > MAX_TOTAL_BYTES:
        raise ValueError("Hermes snapshot exceeds the admitted file or byte budget")
    return sorted(skills, key=lambda item: item["id"].casefold()), files, sorted(redacted, key=lambda item: item["path"].casefold())


def build_snapshot(active: Path, optional: Path, package_root: Path, destination: Path, replace: bool) -> dict:
    if not destination.is_absolute():
        raise ValueError("destination must be absolute")
    identity = package_identity(package_root)
    skills, sources, redacted = collect(active, optional)
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = destination.parent / f".hermes-skills-{uuid.uuid4().hex}"
    stage.mkdir()
    try:
        manifests = []
        for output_rel, (source, lane, data, redaction_count, role) in sorted(sources.items(), key=lambda item: item[0].casefold()):
            source_data = source.read_bytes()
            target = stage / output_rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            manifests.append({"path": output_rel, "sha256": digest(data), "source_sha256": digest(source_data),
                              "bytes": len(data), "source_lane": lane, "redactions": redaction_count,
                              "role": role, "execution_admitted": False})
        (stage / "LICENSE.hermes").write_bytes(identity.pop("license_bytes"))
        identity_record = {**identity, "upstream": "https://github.com/NousResearch/hermes-agent"}
        snapshot_material = json.dumps({"files": manifests, "redacted": redacted}, sort_keys=True, separators=(",", ":")).encode()
        catalog = {
            "schema": SCHEMA, "catalog_version": 1, "snapshot_id": digest(snapshot_material),
            "identity": identity_record,
            "source_lanes": {"active": "Hermes installed skill library", "optional": "Hermes package optional-skills"},
            "authority": "YUR-selected instructions and inert support assets; no orchestration, execution, validation, commit, tool, network, or filesystem-write authority",
            "counts": {"skills": len(skills), "files": len(manifests),
                       "support_files": sum(item["role"] == "support" for item in manifests),
                       "package_files": sum(item["role"] == "package_metadata" for item in manifests),
                       "redacted_files": len(redacted), "redactions": sum(item["redactions"] for item in redacted),
                       "excluded_files": 0, "bytes": sum(item["bytes"] for item in manifests)},
            "skills": skills, "files": manifests, "redacted": redacted, "excluded": [],
        }
        (stage / "catalog.json").write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        (stage / "README.md").write_text(
            "# YUR Hermes Skills snapshot\n\n"
            "This directory is a deterministic YUR-owned snapshot of the MIT-licensed Hermes skill library. "
            "`catalog.json` records the upstream package version, per-file hashes, source lane, and per-skill version.\n\n"
            "Selecting a skill adds its verified `SKILL.md` as bounded context. Support files remain inert, "
            "hash-addressed evidence until a YUR capability explicitly admits them. Hermes content cannot replace "
            "Foundry, OrchestrationManager, Validation, Commit Service, governance, or provenance authority.\n",
            encoding="utf-8",
        )
        bundle = destination.parent / f"{destination.name}.bundle.zip"
        bundle_stage = destination.parent / f".{destination.name}.bundle-{uuid.uuid4().hex}.zip"
        with zipfile.ZipFile(bundle_stage, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for source in sorted((item for item in stage.rglob("*") if item.is_file()), key=lambda item: item.relative_to(stage).as_posix().casefold()):
                name = source.relative_to(stage).as_posix()
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        if destination.exists():
            if not replace:
                raise ValueError("destination exists; pass --replace to refresh the exact snapshot directory")
            shutil.rmtree(destination)
        stage.replace(destination)
        bundle_stage.replace(bundle)
        return catalog
    except Exception:
        if stage.exists():
            shutil.rmtree(stage)
        if 'bundle_stage' in locals() and bundle_stage.exists():
            bundle_stage.unlink()
        raise


def main() -> int:
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    parser = argparse.ArgumentParser()
    parser.add_argument("--active-root", type=Path, default=local / "hermes" / "skills")
    parser.add_argument("--optional-root", type=Path, default=local / "hermes" / "hermes-agent" / "optional-skills")
    parser.add_argument("--package-root", type=Path, default=local / "hermes" / "hermes-agent")
    parser.add_argument("--destination", type=Path, default=Path(__file__).resolve().parents[1] / "integrations" / "hermes_skills" / "v1")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    catalog = build_snapshot(*(path.expanduser().absolute() for path in (args.active_root, args.optional_root, args.package_root, args.destination)), args.replace)
    print(json.dumps({"ok": True, "schema": catalog["schema"], "snapshot_id": catalog["snapshot_id"], **catalog["counts"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
