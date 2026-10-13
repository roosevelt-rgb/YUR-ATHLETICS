"""Bounded work cells: acquire source, prepare proposals, or run pure specialists.

The host supplies the selected root separately from model arguments. This module
never writes files, starts processes, calls providers, or commits operational
state. A successful proposal still requires independent validation and commit.
"""
from __future__ import annotations

from collections import Counter, deque
from copy import deepcopy
from datetime import datetime, timezone
import difflib
import hashlib
from itertools import islice
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import uuid

from .repository_context import BLOCKED_DIRS, EXTENSIONS, SECRET_CONTENT, SENSITIVE_NAME, STATE_FILE
from .sources import read_checked, reject_reparse
from .specialists import CapabilityRegistry, CapabilityResolver, run_capability, validate_schema
from . import work_documents

MAX_BYTES = 128 * 1024
MAX_FILE_BYTES = 64 * 1024
MAX_EDIT_BYTES = 24 * 1024
MAX_ENTRIES = 500
MAX_DEPTH = 5
MAX_DIRECTORIES = 100
MAX_SEARCH_FILES = 100
ADMITTED_CAPABILITIES = ("text.analyze", "data.profile", "support.triage", "workforce.hatch.quantity", "construction.opc.inspect")
EXCLUDED_DIRS = frozenset(BLOCKED_DIRS | {"runtime", "runtimes", "runtime_data", "runtime-state", "data", "databases", "database", "secrets", "credentials"})
SOURCE_EXTENSIONS = frozenset(EXTENSIONS | {".csv", ".sql", ".xml", ".htm", ".sh", ".ps1", ".bat", ".cmd", ".vue", ".svelte", ".ini", ".cfg", ".graphql", ".gql", ".tex", ".rst", ".swift", ".kt", ".cs"})
SOURCE_NAMES = frozenset({"dockerfile", "makefile", "license", "procfile", "gemfile", "justfile"})
MEDIA_EXTENSIONS = {"text/plain": {".txt"}, "text/markdown": {".md"}, "text/csv": {".csv"},
                    "text/html": {".html", ".htm"}, "application/json": {".json"}}
HASH = re.compile(r"^[0-9a-f]{64}$")
RESERVED = re.compile(r"^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", re.I)
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _digest(value) -> str:
    return hashlib.sha256(_json(value)).hexdigest()


def _object(properties, required=None):
    return {"type": "object", "properties": properties, "required": list(properties) if required is None else required,
            "additionalProperties": False}


TEXT = {"type": "string", "maxLength": MAX_BYTES}
PATH = {"type": "string", "minLength": 1, "maxLength": 1024}
COUNT = {"type": "integer", "minimum": 0}
SHA = {"type": "string", "minLength": 64, "maxLength": 64}
NULL_SHA = {"type": ["string", "null"], "minLength": 64, "maxLength": 64}
SOURCE = _object({"path": PATH, "sha256": SHA, "bytes": COUNT})
SOURCE_LIST = {"type": "array", "items": SOURCE, "maxItems": MAX_SEARCH_FILES}
PROVENANCE = _object({"operation_id": {"type": "string", "maxLength": 36}, "acquired_at": {"type": "string", "maxLength": 40},
                      "input_sha256": SHA, "result_sha256": SHA, "sources": SOURCE_LIST})


def _output(extra, proposed=False):
    return _object({"schema": {"type": "string", "enum": ["yur.work-tool-result.v1"]}, "tool": {"type": "string", "maxLength": 80},
                    "status": {"type": "string", "enum": ["proposed" if proposed else "completed"]},
                    "committed": {"type": "boolean", "enum": [False]}, "root": {"type": ["string", "null"], "maxLength": 4096},
                    "provenance": PROVENANCE, **extra})


_INPUTS = {
    "list_files": _object({"path": PATH, "max_entries": {"type": "integer", "minimum": 1, "maximum": MAX_ENTRIES},
                           "depth": {"type": "integer", "minimum": 0, "maximum": MAX_DEPTH}}, []),
    "read_file": _object({"path": PATH, "line_start": {"type": "integer", "minimum": 1, "maximum": 100000},
                          "line_end": {"type": "integer", "minimum": 1, "maximum": 100000}}, ["path"]),
    "search_files": _object({"path": PATH, "query": {"type": "string", "minLength": 1, "maxLength": 200},
                             "max_matches": {"type": "integer", "minimum": 1, "maximum": 100}}, ["query"]),
    "propose_edit": _object({"path": PATH, "content": {"type": "string", "maxLength": MAX_EDIT_BYTES}, "expected_sha256": NULL_SHA}),
    "create_artifact": _object({"name": {"type": "string", "minLength": 1, "maxLength": 120,
                                         "description": "Plain filename with a matching extension: .txt, .md, .csv, .html/.htm, or .json. Example: mission-plan.md for text/markdown."},
                                "media_type": {"type": "string", "enum": list(MEDIA_EXTENSIONS)},
                                "content": {"type": "string", "maxLength": MAX_FILE_BYTES}}),
    "run_specialist": _object({"capability_id": {"type": "string", "enum": list(ADMITTED_CAPABILITIES)},
                               "input": {"type": "object", "additionalProperties": True}}),
}
_OUTPUTS = {
    "list_files": _output({"entries": {"type": "array", "maxItems": MAX_ENTRIES, "items": _object({"path": PATH, "kind": {"type": "string", "enum": ["file", "directory"]}, "bytes": COUNT})},
                           "truncated": {"type": "boolean"}, "excluded": {"type": "object", "additionalProperties": COUNT}, "inventory_sha256": SHA}),
    "read_file": _output({"path": PATH, "sha256": SHA, "bytes": COUNT, "total_lines": COUNT, "line_start": COUNT, "line_end": COUNT,
                          "content": TEXT, "truncated": {"type": "boolean"}}),
    "search_files": _output({"matches": {"type": "array", "maxItems": 100, "items": _object({"path": PATH, "sha256": SHA, "line": COUNT, "text": TEXT, "text_truncated": {"type": "boolean"}})},
                             "files_read": COUNT, "source_bytes": COUNT, "truncated": {"type": "boolean"}, "excluded": {"type": "object", "additionalProperties": COUNT}}),
    "propose_edit": _output({"proposal": _object({"kind": {"type": "string", "enum": ["edit"]}, "path": PATH, "content": TEXT,
                              "expected_sha256": NULL_SHA, "original_sha256": NULL_SHA, "original_content": TEXT,
                              "new_sha256": SHA, "diff": TEXT, "is_new": {"type": "boolean"}})}, proposed=True),
    "create_artifact": _output({"proposal": _object({"kind": {"type": "string", "enum": ["artifact"]},
                                 "name": {"type": "string", "maxLength": 120}, "media_type": {"type": "string", "enum": list(MEDIA_EXTENSIONS)},
                                 "content": TEXT, "sha256": SHA, "bytes": COUNT})}, proposed=True),
    # The selected capability's precise input/output schema is separately applied
    # by run_capability; metadata below exposes each admitted contract to the planner.
    "run_specialist": _output({"capability_id": {"type": "string", "enum": list(ADMITTED_CAPABILITIES)},
                               "output": {"type": "object", "additionalProperties": True}}),
}
_DESCRIPTIONS = {
    "list_files": "List bounded source paths within the host-selected repository; excludes hidden, sensitive and runtime files.",
    "read_file": "Read fresh UTF-8 source lines and a hash within the selected repository, at most 64 KiB per source file.",
    "search_files": "Search a case-sensitive literal string across bounded source files; reports incomplete coverage explicitly.",
    "propose_edit": "Prepare a complete file edit and unified diff without writing. Existing files require their exact fresh SHA-256; null means create only if absent.",
    "create_artifact": "Prepare a text, Markdown, CSV, HTML or JSON artifact for validation and mission commit. Use a plain filename with its matching extension, such as mission-plan.md with text/markdown. Does not write into the selected project folder or publish it.",
    "run_specialist": "Execute one exact admitted pure specialist. No filesystem, network, messaging or persistence effects.",
}


def tool_catalog() -> list[dict]:
    """Return independent typed metadata; discovery grants no execution authority."""
    registry = CapabilityRegistry()
    result = [{"name": name, "description": _DESCRIPTIONS[name], "input_schema": deepcopy(_INPUTS[name]),
             "output_schema": deepcopy(_OUTPUTS[name]), "permissions": ["repository.read"] if name in {"list_files", "read_file", "search_files", "propose_edit"} else [],
             "runtime": {"language": "python", "dependencies": [], "network": False, "subprocess": False},
             "rollback": {"behavior": "no_durable_mutation"},
             **({"capabilities": [{key: entry[key] for key in ("id", "input_schema", "output_schema", "runtime", "trust")} for entry in (registry.get(cid) for cid in ADMITTED_CAPABILITIES)]} if name == "run_specialist" else {})}
            for name in _INPUTS]
    for entry in work_documents.catalog():
        result.append({**entry, "output_schema": _output(entry["output_schema"]["properties"], proposed=True)})
    return result


def _excluded_name(name: str) -> bool:
    return (name.startswith(".") or name.casefold() in EXCLUDED_DIRS or bool(SENSITIVE_NAME.search(name))
            or bool(STATE_FILE.search(name)) or bool(RESERVED.match(name)) or name.endswith((".", " ")))


def _relative(value: str, *, directory=False) -> str:
    if directory and value == ".":
        return "."
    if not isinstance(value, str) or not value or len(value) > 1024 or re.search(r'[\x00-\x1f\x7f:*?"<>|]', value):
        raise ValueError("A bounded relative source path is required")
    if PureWindowsPath(value).drive or value.startswith(("/", "\\")):
        raise ValueError("Absolute paths and drive paths are not admitted as tool arguments")
    parts = value.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") or _excluded_name(part) for part in parts):
        raise ValueError("Source path is excluded or contains traversal")
    if not directory and PurePosixPath(parts[-1]).suffix.lower() not in SOURCE_EXTENSIONS and parts[-1].lower() not in SOURCE_NAMES:
        raise ValueError("Only admitted text source file types may be acquired or proposed")
    return "/".join(parts)


def _root(value) -> Path:
    if not isinstance(value, (str, Path)) or not str(value) or len(str(value)) > 4096 or "\0" in str(value):
        raise ValueError("This tool requires a host-selected repository root")
    root = Path(value)
    if not root.is_absolute() or root == Path(root.anchor) or ".." in root.parts or str(root).startswith(("\\\\", "//")):
        raise ValueError("Selected root must be a local absolute repository directory")
    reject_reparse(root)
    if not root.is_dir() or _excluded_name(root.name):
        raise ValueError("Selected repository root is unavailable or excluded")
    return root.resolve(strict=True)


def _target(root: Path, relative: str) -> Path:
    target = root / relative
    reject_reparse(target)
    if not target.resolve().is_relative_to(root):
        raise ValueError("Source path escapes the selected root")
    return target


def _text(content: str, maximum: int) -> bytes:
    raw = content.encode("utf-8")
    if len(raw) > maximum:
        raise ValueError("Source text exceeds the tool byte budget")
    if CONTROL.search(content):
        raise ValueError("Binary or control-character content is not admitted")
    if SECRET_CONTENT.search(content):
        raise ValueError("Potential secret content is not admitted")
    return raw


def _read(root: Path, relative: str, maximum=MAX_FILE_BYTES) -> tuple[str, dict]:
    target = _target(root, relative)
    before = target.lstat()
    if before.st_nlink > 1:
        raise ValueError("Hard-linked source files are not admitted")
    raw = read_checked(root, relative, maximum)
    reject_reparse(target)
    after = target.lstat()
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_nlink")
    if any(getattr(before, field) != getattr(after, field) for field in fields) or len(raw) != after.st_size:
        raise ValueError("Source changed during acquisition")
    # Keep BOM and line endings exactly: proposals must preserve the original bytes.
    content = raw.decode("utf-8")
    _text(content, maximum)
    return content, {"path": relative, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}


def _inventory(root: Path, relative: str, maximum=MAX_ENTRIES, depth_limit=MAX_DEPTH) -> tuple[list, Counter, bool]:
    start = _target(root, relative)
    if not start.is_dir():
        raise ValueError("Listing and search require a repository directory")
    pending, entries, excluded = deque([(start, 0)]), [], Counter()
    visited = nodes = 0
    truncated = False
    while pending:
        directory, depth = pending.popleft()
        if visited >= MAX_DIRECTORIES or nodes >= MAX_ENTRIES or len(entries) >= maximum:
            truncated = True
            break
        reject_reparse(directory)
        visited += 1
        with os.scandir(directory) as scan:
            batch = list(islice(scan, MAX_ENTRIES - nodes + 1))
        if len(batch) > MAX_ENTRIES - nodes:
            batch = batch[:MAX_ENTRIES - nodes]
            truncated = True
        for entry in sorted(batch, key=lambda item: item.name.casefold()):
            nodes += 1
            if len(entries) >= maximum:
                truncated = True
                break
            if _excluded_name(entry.name):
                excluded["excluded_name"] += 1
                continue
            path = directory / entry.name
            try:
                reject_reparse(path)
                # Windows DirEntry.stat may omit link-count metadata; lstat is
                # required before deciding whether a file has external aliases.
                info = path.lstat()
                is_directory = stat.S_ISDIR(info.st_mode)
                relative_path = _relative(path.relative_to(root).as_posix(), directory=is_directory)
                if is_directory:
                    entries.append({"path": relative_path, "kind": "directory", "bytes": 0})
                    if depth < depth_limit:
                        pending.append((path, depth + 1))
                    else:
                        excluded["depth_limit"] += 1
                        truncated = True
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_FILE_BYTES:
                    entries.append({"path": relative_path, "kind": "file", "bytes": info.st_size})
                else:
                    excluded["non_regular_linked_or_oversized"] += 1
            except (OSError, ValueError):
                excluded["unavailable_or_excluded"] += 1
    return entries, excluded, truncated


def _diff(original: str, content: str, relative: str, is_new: bool) -> str:
    result = []
    for line in difflib.unified_diff(original.splitlines(keepends=True), content.splitlines(keepends=True),
                                     fromfile="/dev/null" if is_new else "a/" + relative, tofile="b/" + relative, lineterm="\n"):
        result.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    return "".join(result)


def _execute(name: str, arguments: dict, root: Path | None) -> tuple[dict, list]:
    if name == "list_files":
        entries, excluded, truncated = _inventory(root, _relative(arguments.get("path", "."), directory=True), arguments.get("max_entries", MAX_ENTRIES), arguments.get("depth", MAX_DEPTH))
        return {"entries": entries, "truncated": truncated, "excluded": dict(excluded), "inventory_sha256": _digest(entries)}, []
    if name == "read_file":
        relative = _relative(arguments["path"])
        content, source = _read(root, relative)
        lines = content.splitlines(keepends=True)
        start, end = arguments.get("line_start", 1), arguments.get("line_end", max(1, len(lines)))
        if end < start or (start > max(1, len(lines))):
            raise ValueError("Requested line range does not exist or is reversed")
        end = min(end, len(lines))
        return {**source, "total_lines": len(lines), "line_start": start if lines else 0, "line_end": end, "content": "".join(lines[start - 1:end]),
                "truncated": start > 1 or end < len(lines)}, [source]
    if name == "search_files":
        query = arguments["query"]
        if "\n" in query or "\r" in query or CONTROL.search(query):
            raise ValueError("Search requires one literal text line")
        entries, excluded, truncated = _inventory(root, _relative(arguments.get("path", "."), directory=True))
        matches, sources, used, attempted = [], [], 0, 0
        limit = arguments.get("max_matches", 100)
        for entry in entries:
            if entry["kind"] != "file":
                continue
            if attempted >= MAX_SEARCH_FILES or used >= MAX_BYTES or len(matches) >= limit:
                truncated = True
                break
            attempted += 1
            maximum = min(MAX_FILE_BYTES, MAX_BYTES - used)
            if entry["bytes"] > maximum:
                truncated = True
                excluded["source_budget"] += 1
                continue
            # Charge attempted reads too, including files withheld by the content guard.
            used += entry["bytes"]
            try:
                content, source = _read(root, entry["path"], min(maximum, entry["bytes"]))
            except (OSError, ValueError, UnicodeError):
                excluded["unavailable_or_unsafe_content"] += 1
                truncated = True
                continue
            sources.append(source)
            for index, line in enumerate(content.splitlines(), 1):
                if query not in line:
                    continue
                if len(matches) >= limit:
                    truncated = True
                    break
                # Include the match itself even on a long source line.
                position = line.index(query)
                begin = max(0, position - 120)
                excerpt = line[begin:begin + 500]
                matches.append({"path": source["path"], "sha256": source["sha256"], "line": index,
                                "text": excerpt, "text_truncated": begin > 0 or begin + len(excerpt) < len(line)})
        return {"matches": matches, "files_read": len(sources), "source_bytes": used, "truncated": truncated, "excluded": dict(excluded)}, sources
    if name == "propose_edit":
        relative = _relative(arguments["path"])
        content = arguments["content"]
        raw = _text(content, MAX_EDIT_BYTES)
        expected = arguments["expected_sha256"]
        if expected is not None and (not isinstance(expected, str) or not HASH.fullmatch(expected)):
            raise ValueError("Edit precondition must be a lowercase SHA-256 or null for a new file")
        target = _target(root, relative)
        try:
            target.lstat()
            exists = True
        except FileNotFoundError:
            exists = False
        if exists:
            if expected is None:
                raise ValueError("Existing files require an exact expected SHA-256")
            original, source = _read(root, relative, MAX_EDIT_BYTES)
            if source["sha256"] != expected:
                raise ValueError("Edit precondition failed: source changed since acquisition")
            sources = [source]
        else:
            if expected is not None:
                raise ValueError("Edit precondition failed: expected source no longer exists")
            original, sources = "", []
        proposal = {"kind": "edit", "path": relative, "content": content, "expected_sha256": expected,
                    "original_sha256": sources[0]["sha256"] if sources else None, "original_content": original,
                    "new_sha256": hashlib.sha256(raw).hexdigest(), "diff": _diff(original, content, relative, not exists), "is_new": not exists}
        return {"proposal": proposal}, sources
    if name == "create_artifact":
        artifact_name = _relative(arguments["name"])
        if "/" in artifact_name or PurePosixPath(artifact_name).suffix.lower() not in MEDIA_EXTENSIONS[arguments["media_type"]]:
            raise ValueError("Artifact requires a plain filename matching its text media type")
        raw = _text(arguments["content"], MAX_FILE_BYTES)
        if arguments["media_type"] == "application/json":
            _validate_json_artifact(arguments["content"])
        return {"proposal": {"kind": "artifact", "name": artifact_name, "media_type": arguments["media_type"], "content": arguments["content"],
                              "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}}, []
    if name == "run_specialist":
        capability_id = arguments["capability_id"]
        CapabilityResolver().resolve([capability_id])
        output = run_capability(capability_id, arguments["input"])
        return {"capability_id": capability_id, "output": output}, []
    raise ValueError("Unknown work tool")


def _validate_json_artifact(content: str) -> None:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("JSON artifact contains duplicate keys")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("JSON artifact contains a non-finite number")

    try:
        value = json.loads(content, object_pairs_hook=pairs, parse_constant=reject_constant)
    except RecursionError as error:
        raise ValueError("JSON artifact nesting exceeds the tool limit") from error
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > 20:
            raise ValueError("JSON artifact nesting exceeds the tool limit")
        if isinstance(item, (dict, list)):
            pending.extend((child, depth + 1) for child in (item.values() if isinstance(item, dict) else item))


def _reject_argument_secrets(arguments: dict) -> None:
    if SECRET_CONTENT.search(_json(arguments).decode("utf-8")):
        raise ValueError("Potential secret content is not admitted")
    pending = [arguments]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            _text(item, MAX_BYTES)
        elif isinstance(item, (dict, list)):
            pending.extend(item.values() if isinstance(item, dict) else item)


def execute_tool(name: str, arguments: dict, root=None) -> dict:
    """Execute one host-dispatched bounded cell; return facts or uncommitted proposals.

    A model cannot provide root, authority, commands, URLs or commit instructions
    through arguments. File tools require the separate host-selected root.
    """
    if not isinstance(name, str) or name not in {*_INPUTS, "create_document"}:
        raise ValueError("Unknown work tool")
    if name == "create_document":
        descriptor = work_documents.catalog()[0]
        input_schema, output_schema = descriptor["input_schema"], _output(descriptor["output_schema"]["properties"], proposed=True)
    else:
        input_schema, output_schema = _INPUTS[name], _OUTPUTS[name]
    if name == "run_specialist" and isinstance(arguments, dict) and arguments.get("capability_id") in ADMITTED_CAPABILITIES:
        capability = CapabilityRegistry().get(arguments["capability_id"])
        input_schema, output_schema = deepcopy(input_schema), deepcopy(output_schema)
        input_schema["properties"]["input"] = capability["input_schema"]
        output_schema["properties"]["output"] = capability["output_schema"]
    validate_schema(arguments, input_schema)
    if len(_json(arguments)) > MAX_BYTES:
        raise ValueError("Tool input exceeds 128 KiB")
    _reject_argument_secrets(arguments)
    arguments = deepcopy(arguments)
    needs_root = name in {"list_files", "read_file", "search_files", "propose_edit"}
    selected = _root(root) if needs_root or root is not None else None
    payload, sources = (work_documents.create_document(arguments), []) if name == "create_document" else _execute(name, arguments, selected)
    result = {"schema": "yur.work-tool-result.v1", "tool": name, "status": "proposed" if name in {"propose_edit", "create_artifact", "create_document"} else "completed",
              "committed": False, "root": str(selected) if selected else None, **payload,
              "provenance": {"operation_id": str(uuid.uuid4()), "acquired_at": datetime.now(timezone.utc).isoformat(),
                             "input_sha256": _digest(arguments), "result_sha256": _digest(payload), "sources": sources}}
    validate_schema(result, output_schema, "output")
    if len(_json(result)) > MAX_BYTES:
        raise ValueError("Tool output exceeds 128 KiB; narrow the request")
    return result
