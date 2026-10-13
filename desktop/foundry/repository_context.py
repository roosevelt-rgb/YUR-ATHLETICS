"""Bounded, read-only acquisition of user-selected repository source context."""
from __future__ import annotations

from collections import Counter, deque
from datetime import datetime, timezone
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

from .sources import read_checked, reject_reparse

AUTHORITY = {"issuer": "local-user", "scope": "repository-read", "actions": ["list", "read", "search"]}
BOOTSTRAP_MODES = {"repo", "folder", "federation"}
BOOTSTRAP_MAX_ROOTS = 3
LIMITS = {"input_bytes": 40 * 1024, "depth": 5, "nodes": 1500, "directories": 100,
          "inventory": 200, "files_read": 16, "source_bytes": 2 * 1024 * 1024,
          "file_bytes": 512 * 1024, "excerpt_bytes": 32 * 1024}
EXTENSIONS = {".md", ".txt", ".json", ".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
              ".html", ".css", ".scss", ".yaml", ".yml", ".toml", ".mod", ".rs", ".go", ".java", ".c", ".h", ".cpp"}
BLOCKED_DIRS = {"node_modules", "vendor", "cache", "caches", "__pycache__", "build", "builds", "dist", "out",
                "release", "releases", "archive", "archives", "state", "logs", "log",
                "coverage", "venv", "env", "target", "tmp", "temp", "uploads", "backups"}
SENSITIVE_NAME = re.compile(r"(?:^|[._ -])(?:credentials?|secrets?|keys?|tokens?|passwords?|recovery[_-]?codes)(?:[._ -]|$)|config[._-]local|[._-]local[.]|^id_(?:rsa|dsa|ecdsa|ed25519)", re.I)
STATE_FILE = re.compile(r"(?:^|[._-])(?:state|sessions?|history|ledger|events|memory|logs?)(?:[._-].*)?\.(?:json|jsonl|txt|yaml|yml)$", re.I)
SECRET_CONTENT = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}"
    r"|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r"|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|[a-z]+://[^\s/:]+:[^\s/@]+@"
    r"|[\"']?(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|authorization|client[_-]?secret|password|passwd|private[_-]?key|secret)[\"']?\s*[:=]\s*(?:[\"'][^\"'\r\n]+[\"']|[A-Za-z0-9_+/-]{12,}\s*(?:$|[#;]))",
    re.I | re.M,
)
STOP_WORDS = {"the", "and", "this", "that", "with", "from", "what", "where", "how", "does", "repo", "repository", "code", "read", "can", "you", "for", "are", "its"}


def _request(request: dict) -> tuple[Path, str]:
    if not isinstance(request, dict) or set(request) != {"root", "question", "authority"}:
        raise ValueError("Expected exactly root, question, and authority.")
    if request["authority"] != AUTHORITY:
        raise ValueError("Explicit local-user repository-read authority is required.")
    root_text, question = request["root"], request["question"]
    if not isinstance(root_text, str) or not root_text or "\0" in root_text:
        raise ValueError("A selected absolute repository directory is required.")
    if not isinstance(question, str) or len(question.encode("utf-8")) > 32 * 1024:
        raise ValueError("Question exceeds the repository context budget.")
    root = Path(root_text)
    if not root.is_absolute() or ".." in root.parts or root == Path(root.anchor):
        raise ValueError("Relative paths, traversal, and drive roots are not admitted.")
    reject_reparse(root)
    if not root.is_dir() or root.name.startswith(".") or root.name.lower() in BLOCKED_DIRS:
        raise ValueError("Selected repository directory is unavailable or excluded.")
    return root.resolve(), question


def _inventory(root: Path, excluded: Counter, truncated: dict, usage: dict) -> list[str]:
    pending, candidates = deque([(root, 0)]), []
    while pending:
        directory, depth = pending.popleft()
        if usage["directories"] >= LIMITS["directories"] or usage["nodes"] >= LIMITS["nodes"]:
            truncated["inventory_scan"] = True
            break
        try:
            reject_reparse(directory)
            usage["directories"] += 1
            with os.scandir(directory) as scan:
                remaining = LIMITS["nodes"] - usage["nodes"]
                entries = list(islice(scan, remaining + 1))
            if len(entries) > remaining:
                truncated["inventory_scan"] = True
                entries = entries[:remaining]
            for entry in sorted(entries, key=lambda value: value.name.casefold()):
                usage["nodes"] += 1
                name = entry.name.lower()
                if name.startswith(".") or SENSITIVE_NAME.search(name) or STATE_FILE.search(name):
                    excluded["hidden_or_sensitive_name"] += 1
                    continue
                if name in BLOCKED_DIRS:
                    excluded["excluded_directory"] += 1
                    continue
                path = directory / entry.name
                try:
                    reject_reparse(path)
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        if depth >= LIMITS["depth"]:
                            excluded["depth_limit"] += 1
                            truncated["inventory_scan"] = True
                        else:
                            pending.append((path, depth + 1))
                    elif stat.S_ISREG(info.st_mode):
                        if path.suffix.lower() not in EXTENSIONS or (path.suffix.lower() == ".txt" and name not in {"requirements.txt", "cmakelists.txt", "readme.txt"}):
                            excluded["unsupported_extension"] += 1
                        elif info.st_size > LIMITS["file_bytes"]:
                            excluded["file_size_limit"] += 1
                        else:
                            candidates.append(path.relative_to(root).as_posix())
                    else:
                        excluded["non_regular"] += 1
                except (OSError, ValueError):
                    excluded["unavailable_or_reparse"] += 1
        except (OSError, ValueError):
            excluded["unavailable_or_reparse"] += 1
    return candidates


def _rank(path: str, question: str, terms: set[str]) -> tuple[int, str]:
    lowered, name = path.lower(), Path(path).name.lower()
    if lowered in question or (len(name) > 3 and name in question):
        return 1000, "The question names this source file."
    if "/" not in lowered and name in {"readme.md", "agents.md", "package.json", "pyproject.toml", "cargo.toml", "go.mod"}:
        return 700, "Root repository instructions or manifest."
    hits = len(set(re.findall(r"[a-z0-9]+", lowered)) & terms)
    if hits:
        return 400 + hits * 20, f"{hits} question terms match the source path."
    if name in {"readme.md", "agents.md", "package.json", "pyproject.toml", "cargo.toml", "go.mod"}:
        return 150 - lowered.count("/") * 10, "Nested package instructions or manifest."
    if re.search(r"(?:^|/)(?:main|app|index|server|cli|__main__|config)[.][^/]+$", lowered):
        return 300 - lowered.count("/") * 10, "Application entry point or configuration source."
    if lowered.startswith(("src/", "foundry/", "lib/", "app/")):
        return 100, "Implementation source in the selected repository."
    return 10, "Source sampled within the bounded repository inventory."


def _explicit_paths(candidates: list[str], question: str) -> list[str]:
    def mentioned(path: str) -> bool:
        return bool(re.search(r"(?<![\w./-])/?" + re.escape(path.lower()) + r"(?![\w/-]|\.\w)", question))

    exact = [path for path in candidates if mentioned(path)]
    # A filename at the repository root is an exact path. A basename elsewhere
    # is usable only when unique, so package.json never means every subpackage.
    by_name = {}
    for path in candidates:
        by_name.setdefault(Path(path).name.lower(), []).append(path)
    unique = [paths[0] for name, paths in by_name.items() if len(paths) == 1 and mentioned(name)]
    return sorted(set(exact + unique), key=lambda path: (path.count("/"), path.casefold()))


def _excerpts(source: str, terms: set[str], budget: int) -> tuple[list[dict], bool, int]:
    lines = source.splitlines()
    matches = [i for i, line in enumerate(lines) if terms & set(re.findall(r"[a-z0-9]+", line.lower()))]
    complete = "\n".join(lines)
    if len(complete.encode("utf-8")) <= budget:
        return ([{"start_line": 1, "end_line": len(lines), "text": complete}] if lines else []), False, len(matches)
    preferred = []
    for index in matches[:8]:
        preferred.extend(range(max(0, index - 3), min(len(lines), index + 6)))
    preferred.extend(range(min(len(lines), 48)))
    selected, used = set(), 0
    for index in dict.fromkeys(preferred):
        size = len(lines[index].encode("utf-8")) + 1
        if used + size <= budget:
            selected.add(index)
            used += size
    excerpts = []
    for index in sorted(selected):
        if excerpts and excerpts[-1]["end_line"] == index:
            excerpts[-1]["end_line"] = index + 1
            excerpts[-1]["text"] += "\n" + lines[index]
        else:
            excerpts.append({"start_line": index + 1, "end_line": index + 1, "text": lines[index]})
    return excerpts, len(selected) < len(lines), len(matches)


def acquire_context(request: dict) -> dict:
    """Acquire facts only: returned source text is untrusted, never executed."""
    if len(json.dumps(request, ensure_ascii=False).encode("utf-8")) > LIMITS["input_bytes"]:
        raise ValueError("Repository context request exceeds 40 KiB.")
    root, question = _request(request)
    # A root identifies the acquisition boundary, not the topic to rank against.
    # Preserve a named child source path after removing that boundary prefix.
    retrieval_question = question.replace("\\_", "_").replace("\\", "/").lower()
    retrieval_question = retrieval_question.replace(root.as_posix().lower(), "")
    terms = set(re.findall(r"[a-z0-9]{3,}", retrieval_question)) - STOP_WORDS
    excluded = Counter()
    usage = {"nodes": 0, "directories": 0, "files_read": 0, "source_bytes": 0, "excerpt_bytes": 0}
    truncated = {"inventory_scan": False, "inventory": False, "files": False, "source_bytes": False, "excerpts": False}
    candidates = _inventory(root, excluded, truncated, usage)
    ranked = sorted(candidates, key=lambda path: (-_rank(path, retrieval_question, terms)[0], path.casefold()))
    explicit = _explicit_paths(candidates, retrieval_question)
    selected = explicit or ranked
    if explicit:
        ranked = explicit + [path for path in ranked if path not in explicit]
    inventory = ranked[:LIMITS["inventory"]]
    truncated["inventory"] = len(ranked) > len(inventory)
    files = []
    for relative in selected:
        if usage["files_read"] >= LIMITS["files_read"]:
            truncated["files"] = True
            break
        remaining = LIMITS["source_bytes"] - usage["source_bytes"]
        if remaining <= 0:
            truncated["source_bytes"] = True
            break
        usage["files_read"] += 1
        try:
            content = read_checked(root, relative, min(LIMITS["file_bytes"], remaining))
            usage["source_bytes"] += len(content)
            text = content.decode("utf-8-sig")
            if "\0" in text:
                excluded["binary_content"] += 1
                continue
            if SECRET_CONTENT.search(text):
                excluded["secret_content"] += 1
                continue
        except UnicodeError:
            excluded["non_utf8"] += 1
            continue
        except (OSError, ValueError):
            excluded["unavailable_or_read_budget"] += 1
            if remaining < LIMITS["file_bytes"]:
                truncated["source_bytes"] = True
            continue
        budget = min(8192, LIMITS["excerpt_bytes"] // min(len(selected), LIMITS["files_read"]))
        excerpts, omitted, hits = _excerpts(text, terms, budget)
        used = sum(len(excerpt["text"].encode("utf-8")) for excerpt in excerpts)
        usage["excerpt_bytes"] += used
        truncated["excerpts"] |= omitted
        reason = "Explicit source file requested; other inventory files were not read." if explicit else _rank(relative, retrieval_question, terms)[1]
        if hits:
            reason += f" {hits} source lines match question terms; excerpts prioritize those matches."
        files.append({"path": relative, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content),
                      "total_lines": len(text.splitlines()), "excerpts": excerpts, "selection_reason": reason})
    return {"schema": "yur.repository-context.v1", "operation_id": str(uuid.uuid4()), "root": str(root),
            "acquired_at": datetime.now(timezone.utc).isoformat(), "access": "read-only", "files": files,
            "inventory": inventory, "excluded": dict(excluded), "truncated": truncated, "limits": dict(LIMITS),
            "usage": usage, "selection": {"mode": "explicit-files" if explicit else "bounded-overview", "requested_files": explicit},
            "omitted": {"unread_candidates": max(0, len(ranked) - usage["files_read"]),
                                       "unknown_descendants": truncated["inventory_scan"]}}


def acquire_bootstrap(request: dict) -> dict:
    """Acquire one bounded repository orientation or a small set of independent folders."""
    if not isinstance(request, dict) or set(request) != {"roots", "question", "bootstrap", "authority"}:
        raise ValueError("Expected exactly roots, question, bootstrap, and authority.")
    if request["authority"] != AUTHORITY:
        raise ValueError("Explicit local-user repository-read authority is required.")
    mode = request["bootstrap"]
    roots = request["roots"]
    question = request["question"]
    if mode not in BOOTSTRAP_MODES:
        raise ValueError("Unsupported repository bootstrap.")
    if not isinstance(roots, list) or not 1 <= len(roots) <= BOOTSTRAP_MAX_ROOTS:
        raise ValueError("Choose between one and three repository folders.")
    if mode != "federation" and len(roots) != 1:
        raise ValueError("Repo and folder bootstrap each accept one folder.")
    if not isinstance(question, str) or "\0" in question or len(question.encode("utf-8")) > 32 * 1024:
        raise ValueError("Question exceeds the repository bootstrap budget.")
    normalized = []
    for root in roots:
        if not isinstance(root, str) or not root or "\0" in root:
            raise ValueError("Each bootstrap folder must be an absolute directory.")
        candidate, _ = _request({"root": root, "question": question, "authority": AUTHORITY})
        if str(candidate).casefold() in {item.casefold() for item in normalized}:
            raise ValueError("Federated folders must be distinct.")
        normalized.append(str(candidate))

    contexts = []
    for index, root in enumerate(normalized):
        # A folder bootstrap is deliberately orientation-first: the generic
        # question cannot pull the reader away from manifests, instructions,
        # and entry points before the operator understands the folder.
        orientation_question = question if mode != "folder" else "folder overview README AGENTS manifest package entrypoint structure"
        context = acquire_context({"root": root, "question": orientation_question, "authority": AUTHORITY})
        context["selection"] = {**context.get("selection", {}), "bootstrap": mode, "root_index": index}
        contexts.append(context)

    return {
        "schema": "yur.repository-bootstrap.v1",
        "operation_id": str(uuid.uuid4()),
        "bootstrap": mode,
        "roots": normalized,
        "acquired_at": datetime.now(timezone.utc).isoformat(),
        "access": "read-only",
        "authority": dict(AUTHORITY),
        "limits": {"max_roots": BOOTSTRAP_MAX_ROOTS, "per_root": dict(LIMITS)},
        "usage": {"roots_read": len(contexts), "files_read": sum(item["usage"]["files_read"] for item in contexts),
                  "source_bytes": sum(item["usage"]["source_bytes"] for item in contexts)},
        "selection": {"mode": mode, "roots": normalized},
        "contexts": contexts,
    }


def main() -> int:
    try:
        payload = sys.stdin.buffer.read(LIMITS["input_bytes"] + 1)
        if len(payload) > LIMITS["input_bytes"]:
            raise ValueError("Repository context request exceeds 40 KiB.")
        request = json.loads(payload.decode("utf-8"))
        result = acquire_bootstrap(request) if isinstance(request, dict) and request.get("bootstrap") in BOOTSTRAP_MODES else acquire_context(request)
        response = {"ok": True, "result": result}
    except (ValueError, OSError, UnicodeError) as error:
        response = {"ok": False, "error": {"code": "repository_context_rejected", "message": str(error)}}
    except Exception:
        response = {"ok": False, "error": {"code": "repository_context_failed", "message": "Repository context acquisition failed."}}
    sys.stdout.buffer.write((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))
    return 0 if response["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
