"""Bounded generated Python behavior inside the existing serial execution cell.

This module prepares data and validates returned data. It never imports or
executes candidate source on the host, runs a cell, owns state, or evaluates an
acceptance oracle. The caller commits snapshots/results through the existing OM.
"""
from __future__ import annotations

import ast
from copy import deepcopy
import hashlib
import json
import math

from . import execution_cell
from .repository_context import SECRET_CONTENT

MAX_SOURCE_BYTES = 24 * 1024
MAX_INPUT_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 32 * 1024
MAX_JSON_DEPTH = 12
MAX_JSON_NODES = 6000
MAX_COLLECTION_ITEMS = 1000
MAX_SAFE_NUMBER = 2**53 - 1
ENVELOPE_SCHEMA = "yur.generated-worker-output.v1"
DRIVER_VERSION = "yur.generated-worker-driver.v1"
WORKER_FILE = "worker.py"
DRIVER_FILE = "test_worker_driver.py"
INPUT_FILE = "_worker_input.py"


class GeneratedWorkerError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# The driver has no oracle, expected output, host path, or control descriptor.
# Its entire interpreter is untrusted after importing worker. Only the outer
# guardian owns exit/status/hash framing, and the host validates output again.
DRIVER_SOURCE = r'''"""Fixed generated-worker driver v1; no acceptance expectations."""
import base64
from contextlib import redirect_stdout
import json
import math
import sys
import unittest
from _worker_input import PAYLOAD_JSON

def checked_json(value):
    nodes = 0
    def visit(item, depth=0):
        nonlocal nodes
        nodes += 1
        if nodes > 6000 or depth > 12:
            raise ValueError("Worker output exceeds JSON structure limits")
        kind = type(item)
        if item is None or kind is bool:
            return
        if kind is int:
            if abs(item) > 9007199254740991:
                raise ValueError("Worker output integer exceeds safe magnitude")
        elif kind is float:
            if not math.isfinite(item) or abs(item) > 9007199254740991:
                raise ValueError("Worker output number exceeds safe magnitude")
        elif kind is str:
            if len(item) > 32768:
                raise ValueError("Worker output string exceeds limit")
            item.encode("utf-8", errors="strict")
        elif kind is list:
            if len(item) > 1000:
                raise ValueError("Worker output collection exceeds limit")
            for child in item:
                visit(child, depth + 1)
        elif kind is dict:
            if len(item) > 1000 or any(type(key) is not str for key in item):
                raise ValueError("Worker output requires bounded string keys")
            for key, child in item.items():
                if len(key) > 32768:
                    raise ValueError("Worker output key exceeds limit")
                key.encode("utf-8", errors="strict")
                visit(child, depth + 1)
        else:
            raise ValueError("Worker output must be JSON values")
    visit(value)
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(payload) > 32768:
        raise ValueError("Worker output exceeds 32 KiB")
    return payload

class GeneratedWorkerDriver(unittest.TestCase):
    def test_run(self):
        with redirect_stdout(sys.stderr):
            import worker
            value = worker.run(json.loads(PAYLOAD_JSON))
            encoded = checked_json(value)
        envelope = {"schema": "yur.generated-worker-output.v1", "payload": base64.b64encode(encoded).decode("ascii")}
        print(json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False), flush=True)
'''
DRIVER_SHA256 = hashlib.sha256(DRIVER_SOURCE.encode("utf-8")).hexdigest()


def _json_bytes(value, limit: int) -> bytes:
    nodes = 0

    def visit(item, depth=0):
        nonlocal nodes
        nodes += 1
        if depth > MAX_JSON_DEPTH or nodes > MAX_JSON_NODES:
            raise GeneratedWorkerError("invalid_json", "JSON exceeds its depth or node budget")
        kind = type(item)
        if item is None or kind is bool:
            return
        if kind is int:
            if abs(item) > MAX_SAFE_NUMBER:
                raise GeneratedWorkerError("invalid_json", "JSON integer exceeds safe magnitude")
        elif kind is float:
            if not math.isfinite(item) or abs(item) > MAX_SAFE_NUMBER:
                raise GeneratedWorkerError("invalid_json", "JSON number must be finite and within safe magnitude")
        elif kind is str:
            if len(item) > limit:
                raise GeneratedWorkerError("invalid_json", "JSON string exceeds its byte budget")
            item.encode("utf-8", errors="strict")
        elif kind is list:
            if len(item) > MAX_COLLECTION_ITEMS:
                raise GeneratedWorkerError("invalid_json", "JSON collection exceeds its item budget")
            for child in item:
                visit(child, depth + 1)
        elif kind is dict:
            if len(item) > MAX_COLLECTION_ITEMS or any(type(key) is not str for key in item):
                raise GeneratedWorkerError("invalid_json", "JSON objects require bounded string keys")
            for key, child in item.items():
                if len(key) > limit:
                    raise GeneratedWorkerError("invalid_json", "JSON key exceeds its byte budget")
                key.encode("utf-8", errors="strict")
                visit(child, depth + 1)
        else:
            raise GeneratedWorkerError("invalid_json", "Only JSON values are admitted")

    try:
        visit(value)
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (UnicodeError, RecursionError) as error:
        raise GeneratedWorkerError("invalid_json", "JSON must be bounded strict UTF-8") from error
    if len(encoded) > limit:
        raise GeneratedWorkerError("invalid_json", "JSON exceeds its byte budget")
    return encoded


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GeneratedWorkerError("invalid_json", "Duplicate JSON fields are not admitted")
        result[key] = value
    return result


def _parse_json(raw: bytes, limit: int):
    if not isinstance(raw, bytes) or len(raw) > limit:
        raise GeneratedWorkerError("invalid_json", "JSON exceeds its byte budget")
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
        encoded = _json_bytes(value, limit)
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise GeneratedWorkerError("invalid_json", "Malformed, duplicate, or unbounded JSON is not admitted") from error
    if encoded != raw:
        raise GeneratedWorkerError("invalid_json", "JSON must use the exact canonical encoding")
    return value


def _source(source: str) -> bytes:
    if type(source) is not str or not source.strip() or "\0" in source:
        raise GeneratedWorkerError("invalid_source", "Worker source must be nonempty Python without NUL bytes")
    if len(source) > MAX_SOURCE_BYTES:
        raise GeneratedWorkerError("invalid_source", "Worker source exceeds 24 KiB")
    try:
        encoded = source.encode("utf-8", errors="strict")
    except UnicodeError as error:
        raise GeneratedWorkerError("invalid_source", "Worker source must be strict UTF-8") from error
    if len(encoded) > MAX_SOURCE_BYTES:
        raise GeneratedWorkerError("invalid_source", "Worker source exceeds 24 KiB")
    if SECRET_CONTENT.search(source):
        raise GeneratedWorkerError("invalid_source", "Credential-like worker source is not admitted")
    try:
        tree = ast.parse(source, filename=WORKER_FILE, feature_version=(3, 12))
    except (SyntaxError, ValueError, RecursionError) as error:
        raise GeneratedWorkerError("invalid_source", "Worker source must parse as bounded Python") from error
    definitions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run"]
    if len(definitions) != 1 or not isinstance(definitions[0], ast.FunctionDef):
        raise GeneratedWorkerError("invalid_source", "Worker must define one synchronous top-level run(payload)")
    function = definitions[0]
    arguments = function.args
    if (len(arguments.posonlyargs) + len(arguments.args) != 1 or arguments.defaults or arguments.kwonlyargs
            or arguments.vararg or arguments.kwarg or function.decorator_list):
        raise GeneratedWorkerError("invalid_source", "Worker run requires one positional input and no defaults or decorators")
    return encoded


def _input_source(encoded: bytes) -> str:
    return "PAYLOAD_JSON = " + repr(encoded.decode("utf-8")) + "\n"


def _file(name: str, content: str) -> dict:
    raw = content.encode("utf-8")
    return {"path": name, "content": content, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}


def prepare_worker_snapshot(source: str, payload) -> dict:
    """Prepare immutable data only; caller commits and executes through its OM."""
    _source(source)
    encoded = _json_bytes(payload, MAX_INPUT_BYTES)
    body = {"schema": "yur.execution-snapshot.v1", "profile": "python-unittest-serial", "test_directory": ".",
            "files": [_file(WORKER_FILE, source), _file(DRIVER_FILE, DRIVER_SOURCE), _file(INPUT_FILE, _input_source(encoded))]}
    return execution_cell.validate_snapshot({**body, "id": execution_cell.snapshot_digest(body)})


def _worker_snapshot(snapshot) -> dict:
    try:
        checked = execution_cell.validate_snapshot(snapshot)
    except (execution_cell.ExecutionCellError, TypeError, KeyError, ValueError, UnicodeError, RecursionError) as error:
        raise GeneratedWorkerError("invalid_snapshot", "Worker snapshot failed cell identity validation") from error
    if (checked["profile"] != "python-unittest-serial" or checked["test_directory"] != "."
            or [item["path"] for item in checked["files"]] != [WORKER_FILE, DRIVER_FILE, INPUT_FILE]
            or checked["files"][1]["content"] != DRIVER_SOURCE or checked["files"][1]["sha256"] != DRIVER_SHA256):
        raise GeneratedWorkerError("invalid_snapshot", "Worker snapshot differs from the fixed driver contract")
    _source(checked["files"][0]["content"])
    source = checked["files"][2]["content"]
    try:
        tree = ast.parse(source)
        node = tree.body[0] if len(tree.body) == 1 else None
        if (not isinstance(node, ast.Assign) or len(node.targets) != 1
                or not isinstance(node.targets[0], ast.Name) or node.targets[0].id != "PAYLOAD_JSON"
                or not isinstance(node.value, ast.Constant) or type(node.value.value) is not str):
            raise ValueError("invalid input wrapper")
        encoded = node.value.value.encode("utf-8", errors="strict")
        _parse_json(encoded, MAX_INPUT_BYTES)
        if source != _input_source(encoded):
            raise ValueError("noncanonical input wrapper")
    except (ValueError, SyntaxError, UnicodeError, RecursionError) as error:
        raise GeneratedWorkerError("invalid_snapshot", "Worker input must be exact canonical inert JSON data") from error
    return checked


def validate_worker_execution(snapshot, execution):
    """Return domain JSON, never acceptance or authority, from one actual cell.

    Stdout hashes describe the guardian's normalized display bytes. The complete
    canonical ASCII/base64 envelope guards decoding; raw stdout is not claimed.
    Acceptance expected values belong to an independent caller, never this cell.
    """
    checked = _worker_snapshot(snapshot)
    try:
        actual = execution_cell._validate_result(deepcopy(execution), checked)
    except (execution_cell.ExecutionCellError, TypeError, KeyError, ValueError, UnicodeError, RecursionError) as error:
        raise GeneratedWorkerError("invalid_execution", "Worker result failed the current cell evidence contract") from error
    if actual["status"] != "completed" or actual["exit_code"] != 0:
        raise GeneratedWorkerError("execution_failed", "Worker did not complete successfully inside its bounded cell")
    text = actual["stdout"]
    if not text.endswith("\n"):
        raise GeneratedWorkerError("invalid_output", "Worker output requires one complete canonical envelope")
    try:
        raw = text[:-1].encode("ascii", errors="strict")
        envelope = _parse_json(raw, execution_cell.CELL_LIMITS["output_bytes_total"])
        if (not isinstance(envelope, dict) or set(envelope) != {"schema", "payload"}
                or envelope["schema"] != ENVELOPE_SCHEMA or type(envelope["payload"]) is not str):
            raise ValueError("invalid envelope")
        import base64
        encoded = envelope["payload"].encode("ascii", errors="strict")
        decoded = base64.b64decode(encoded, validate=True)
        if base64.b64encode(decoded) != encoded:
            raise ValueError("noncanonical base64")
        return _parse_json(decoded, MAX_OUTPUT_BYTES)
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise GeneratedWorkerError("invalid_output", "Worker output is not one bounded canonical base64-JSON envelope") from error
