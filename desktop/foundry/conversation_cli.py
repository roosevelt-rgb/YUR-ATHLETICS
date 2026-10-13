"""Bounded local desktop ingress for conversational state.

The Electron main process supplies the state directory. Renderer/model payloads
cannot select a database, issue SQL, or grant themselves mission authority.
Importing this module does not open or create state.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Any

from .commit_service import (CommitService, ConversationConflictError, WorkspaceConflictError,
                             _json, _safe_path, _workspace_kind)
from .project_files import AUTHORITY as PROJECT_FILE_AUTHORITY, ProjectFileConflictError, validate_request as validate_project_request


MAX_REQUEST_BYTES = 1024 * 1024 + 1024


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def state_root() -> Path:
    value = os.environ.get("YUR_DESKTOP_HOME")
    if not value or not Path(value).is_absolute():
        raise ValueError("YUR_DESKTOP_HOME must name an absolute local state directory")
    root = Path(value)
    if os.name == "nt" and root.drive.startswith("\\\\"):
        raise ValueError("YUR_DESKTOP_HOME must use a local filesystem")
    _safe_path(root)
    _safe_path(root / "foundry.sqlite3")
    return root


def handle(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("Expected a JSON request object")
    command = request.get("command")
    if command == "list":
        if set(request) != {"command"}:
            raise ValueError("List accepts only command")
    elif command == "save":
        if set(request) != {"command", "conversation", "expected_revision"}:
            raise ValueError("Save requires conversation and expected_revision only")
    elif command == "workspace_list":
        if set(request) != {"command", "kind"}:
            raise ValueError("Workspace list requires kind only")
        _workspace_kind(request["kind"])
    elif command == "workspace_save":
        if set(request) != {"command", "kind", "document", "expected_revision"}:
            raise ValueError("Workspace save requires kind, document and expected_revision only")
        _workspace_kind(request["kind"])
    elif command in ("project_files_list", "project_file_add", "project_file_remove", "project_files_context"):
        validate_project_request(request)
    else:
        raise ValueError("Unsupported conversation command")
    root = state_root()
    if root.exists() and not root.is_dir():
        raise ValueError("YUR_DESKTOP_HOME must be a directory")
    if command in ("list", "workspace_list") and not (root / "foundry.sqlite3").exists():
        # Reading an unused desktop profile must not create machine state.
        return {"conversations" if command == "list" else "documents": []}
    if command in ("project_files_list", "project_files_context", "project_file_add", "project_file_remove") and not (root / "foundry.sqlite3").exists():
        # A project must already have a committed identity. Even failed add/read
        # operations on an unused profile cannot create an empty journal.
        raise ValueError("Project does not exist")
    with CommitService(root) as store:
        if command == "list":
            return {"conversations": store.list_conversations()}
        if command == "workspace_list":
            return {"documents": store.list_workspace(request["kind"])}
        if command == "project_files_list":
            return store.list_project_files(request["project_id"], request["expected_project_revision"])
        if command == "project_file_add":
            return store.add_project_file(request, authority=PROJECT_FILE_AUTHORITY)
        if command == "project_file_remove":
            return store.remove_project_file(request, authority=PROJECT_FILE_AUTHORITY)
        if command == "project_files_context":
            return store.project_files_context(request["project_id"], request["expected_project_revision"], request["selections"])
        if command == "workspace_save":
            authority = {"issuer": "local-user", "scope": "workspace-state", "actions": ["commit"]}
            document = store.commit_workspace(request["kind"], request["document"],
                                               request["expected_revision"], authority=authority)
            return {"document": document}
        # This ingress envelope permits local conversation persistence only.
        authority = {"issuer": "local-user", "scope": "conversation-state", "actions": ["commit"]}
        conversation = store.commit_conversation(request["conversation"], request["expected_revision"], authority=authority)
        return {"conversation": conversation}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    try:
        payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(payload) > MAX_REQUEST_BYTES:
            raise ValueError("Conversation request exceeds the byte limit")
        request = json.loads(payload.decode("utf-8"), object_pairs_hook=_object,
                             parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Invalid JSON constant: {value}")))
        result = {"ok": True, "result": handle(request)}
        code = 0
    except (ConversationConflictError, WorkspaceConflictError, ProjectFileConflictError) as exc:
        result = {"ok": False, "error": {"code": "CONFLICT", "message": str(exc)}}
        code = 1
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        result = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": str(exc)}}
        code = 1
    except (OSError, RuntimeError, sqlite3.DatabaseError) as exc:
        error_code = "INTEGRITY_ERROR" if "integrity check failed" in str(exc) else "STORAGE_ERROR"
        result = {"ok": False, "error": {"code": error_code, "message": str(exc)}}
        code = 1
    sys.stdout.write(_json(result) + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
