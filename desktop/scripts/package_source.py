"""Build an allowlisted source release without traversing donor or state trees."""
from __future__ import annotations

import ast
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MAX_SOURCE_BYTES = 8_000_000
MAX_RELEASE_BYTES = 64_000_000
# Reviewed bridge/acceptance and versioned evidence additions; retain a bounded inventory.
MAX_SOURCE_FILES = 458
# A product edition's own files (manifest, launch page, brand, Gridiron tools and their tests) enter
# a release only when that edition is requested; they hold its personal details, such as an
# athlete's name, class year and local paths, so the default YUR AI Desktop never ships them.
EDITION_ALLOWLIST = "scripts/edition-files.json"
MAX_EDITION_FILES = 64
# Font assets still require explicit allowlist entries and all path/byte guards.
ALLOWED_SUFFIXES = {".py", ".js", ".cjs", ".mjs", ".json", ".html", ".css", ".md", ".yml", ".yaml", ".cmd", ".zip", ".woff2"}
# A product edition's brand art (window and tray icon, logos, the hero raster) may be named only in
# that edition's own list; the YUR AI Desktop allowlist ships none of these types.
EDITION_ART_SUFFIXES = {".ico", ".png", ".webp", ".svg"}


def reject_reparse(path: Path) -> None:
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(info.st_mode)
                or getattr(info, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            raise ValueError("Release paths must not use symlinks or reparse points")


def read_source(root: Path, relative: str, budget: int = MAX_SOURCE_BYTES) -> bytes:
    parts = PurePosixPath(relative).parts
    if (not relative or "\\" in relative or ":" in relative or relative.startswith("/")
            or any(part in {"", ".", ".."} for part in relative.split("/"))
            or any(part.lower() in {"__pycache__", "node_modules", ".keys", "secrets", "credentials",
                                   "_secrets", "_memory", ".codex", "evidence", "runtime", "_state",
                                   "logs", "cache", "caches", "build", "dist", "release"} for part in parts)
            or any(part.lower().startswith(".env") for part in parts) or ".local." in relative.lower()):
        raise ValueError("Unsafe source allowlist path")
    path = root / relative
    reject_reparse(path)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Package source escaped workspace")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > budget:
            raise ValueError("Source file is not regular or exceeds its byte budget")
        reject_reparse(path)
        current = path.lstat()
        if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("Source changed during acquisition")
        content = source.read(budget + 1)
        if len(content) > budget:
            raise ValueError("Source file exceeds its byte budget")
        return content


def edition_files(root: Path, editions) -> tuple[list[str], bytes | None]:
    """The reviewed files of each requested edition, and the edition allowlist that names them."""
    if not editions:
        return [], None
    data = read_source(root, EDITION_ALLOWLIST, 65536)
    document = json.loads(data)
    if (not isinstance(document, dict) or set(document) != {"format", "editions"}
            or document["format"] != "yur.edition-allowlist.v1" or not isinstance(document["editions"], dict)):
        raise ValueError("Invalid edition allowlist document")
    names = []
    for edition in dict.fromkeys(editions):
        files = document["editions"].get(edition) if isinstance(edition, str) else None
        if not isinstance(files, list) or not files or any(not isinstance(name, str) for name in files):
            raise ValueError("Unknown product edition or invalid edition file list")
        names.extend(files)
    if len(names) > MAX_EDITION_FILES or len(names) != len(set(names)) or EDITION_ALLOWLIST in names:
        raise ValueError("Edition files must be unique and within the edition budget")
    return names, data


def collect_sources(root: Path, editions=()) -> tuple[dict[str, bytes], str]:
    """Only explicitly reviewed file paths can enter the release; editions only on request."""
    reject_reparse(root)
    allowlist_data = read_source(root, "scripts/source-files.json", 65536)
    allowlist = json.loads(allowlist_data)
    if (not isinstance(allowlist, dict) or set(allowlist) != {"format", "release_version", "required"}
            or allowlist["format"] != "yur.source-allowlist.v1"):
        raise ValueError("Invalid source allowlist document")
    version = allowlist["release_version"]
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", version):
        raise ValueError("Invalid source release version")
    names = allowlist["required"]
    if isinstance(names, list) and len(names) > MAX_SOURCE_FILES:
        raise ValueError(f"Source allowlist exceeds the {MAX_SOURCE_FILES}-file release budget")
    if (not isinstance(names, list) or not names
            or any(not isinstance(name, str) for name in names) or len(names) != len(set(names))):
        raise ValueError("Source allowlist must contain unique required paths")
    if "scripts/source-files.json" not in names:
        raise ValueError("The source allowlist must attest itself")
    extra, edition_data = edition_files(root, editions)
    if set(extra) & set(names):
        raise ValueError("Edition files must stay outside the Desktop allowlist")
    content, total, edition_names = {}, 0, set(extra)
    for relative in sorted([*names, *extra]):
        allowed = ALLOWED_SUFFIXES | EDITION_ART_SUFFIXES if relative in edition_names else ALLOWED_SUFFIXES
        if relative not in {".gitignore", "requirements-desktop.txt", "requirements-voice.txt"} and PurePosixPath(relative).suffix not in allowed:
            raise ValueError("Source allowlist contains an unapproved file type")
        data = read_source(root, relative)
        total += len(data)
        if total > MAX_RELEASE_BYTES:
            raise ValueError("Source release exceeds total byte budget")
        if relative.endswith(".py"):
            ast.parse(data.decode("utf-8"), filename=relative)
        content[relative] = data
    if content["scripts/source-files.json"] != allowlist_data:
        raise ValueError("Source allowlist changed during collection")
    if edition_data is not None:
        # An edition release attests the edition allowlist it was built from.
        content[EDITION_ALLOWLIST] = edition_data
    return content, version


def build_release(root: Path, editions=()) -> dict:
    """Install a deterministic content-addressed ZIP with no silent overwrites."""
    root = Path(root)
    reject_reparse(root)
    content, version = collect_sources(root, editions)
    selection = "explicit required paths in scripts/source-files.json"
    if EDITION_ALLOWLIST in content:
        selection += " plus the " + ", ".join(dict.fromkeys(editions)) + " edition files in " + EDITION_ALLOWLIST
    manifest = {"format": "yur.source-release.v1", "version": version, "signed": False,
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in content.items()},
                "release_status": "local-release-candidate", "git_revision": None,
                "source_selection": selection}
    content["SOURCE_ATTESTATION.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as bundle:
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, data)
    payload = buffer.getvalue()
    digest = hashlib.sha256(payload).hexdigest()
    release = root / "release"
    # An edition release names its edition (it holds that edition's personal details); the Desktop's
    # own release name is unchanged.
    named = "".join(f"-{edition}" for edition in dict.fromkeys(editions)) if EDITION_ALLOWLIST in content else ""
    target = release / f"yur-specialist-factory-{version}{named}-{digest[:16]}-source.zip"
    reject_reparse(target)
    release.mkdir(exist_ok=True)
    reject_reparse(target)

    def verify_existing():
        reject_reparse(target)
        with target.open("rb") as existing:
            actual = existing.read(len(payload) + 1)
        if actual != payload:
            raise ValueError("Existing content-addressed release has conflicting bytes; refusing overwrite")

    if target.exists():
        verify_existing()
    else:
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".source-release-", suffix=".tmp", dir=release,
                                             delete=False) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
            reject_reparse(target)
            try:
                os.link(temporary_path, target)
            except FileExistsError:
                verify_existing()
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
    return {"path": str(target.absolute()), "files": len(content), "sha256": digest, "signed": False}


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edition", action="append", default=[], help="add a product edition (scripts/edition-files.json)")
    args = parser.parse_args(argv)
    subprocess.run(["node", str(ROOT / "scripts/verify.cjs")], cwd=ROOT, check=True)
    print(json.dumps(build_release(ROOT, tuple(args.edition))))


if __name__ == "__main__":
    main()
