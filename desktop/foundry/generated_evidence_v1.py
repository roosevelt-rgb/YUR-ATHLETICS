"""Immutable v1 reconstruction of committed generated-worker evidence.

Read-only historical interpretation, not runtime admission or a new authority.
Public entry points enter CommitService._read_transaction(), which verifies the
entire journal before reading and shares the verified snapshot when nested in
an existing CommitService transaction. Never pass a model-supplied store object.
Event hashes and semantic links are additionally checked here. Hashes prove
record consistency, not a cryptographic signature or independent authenticity
against an actor able to replace the whole local journal.

The frozen code below is extracted from the listed canonical source revisions;
only pure JSON/schema/source-shape validation is retained. Candidate source is
parsed as data, NEVER imported, evaluated or executed. Current runtime modules,
current admission, filesystem sources and WSL liveness are never consulted.
A future semantic change belongs in a new verifier module, not this revision.
Source provenance hashes use normalized UTF-8/LF source. Structural candidate
hashes use a frozen formatter matching the publisher's CPython 3.14 default
ast.dump output. Parsing still depends on host AST node shapes with Python
3.12 grammar; future parser changes require explicit compatibility review.
"""
from copy import deepcopy
import ast
import base64
import hashlib
import json
import math
import re

VERIFIER = 'yur.generated-evidence.v1'
SOURCE_PROVENANCE = {'generated_contracts.py': '653a29ba4936958777311439e14914db770cf4e8bc52cb9ca6ad82e048111096', 'generated_worker.py': '28d18493941e4c2c3e6d71063bd76787b7b30c26b1ab6c29c9fc19848e8a2c3c', 'specialist_runtime_v1.py': 'd1bba1a6a94c8b0aad0441d3bd9a457b343ee514e464097e8923333787831e08', 'execution_cell.py': '57f2785dc60959c334c20205eaefc0cc1dbf4bffc1bf817f8186d28cd32aad5c', 'repository_context.py': '83881b770d9bf299dd8ac1abddabdd776efd5a19dc4b5033ff88a58711fdaa76'}
_SECRET_V1 = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}"
    r"|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r"|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|[a-z]+://[^\s/:]+:[^\s/@]+@"
    r"|[\"']?(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|authorization|client[_-]?secret|password|passwd|private[_-]?key|secret)[\"']?\s*[:=]\s*(?:[\"'][^\"'\r\n]+[\"']|[A-Za-z0-9_+/-]{12,}\s*(?:$|[#;]))",
    re.I | re.M,
)

def _validate_schema_v1(value, schema, path="input", depth=0):
    """Validate the bounded subset of JSON Schema used by the shipped contracts."""
    if depth > 12:
        raise ValueError(f"{path}: nesting exceeds the contract limit")
    kind = schema.get("type")
    kinds = kind if isinstance(kind, list) else [kind]
    matches = {
        "null": value is None,
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (float, int)) and not isinstance(value, bool),
        "string": isinstance(value, str),
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }
    if kind is not None and not any(matches.get(k, False) for k in kinds):
        raise ValueError(f"{path}: expected {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: unsupported value")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"{path}: numbers must be finite")
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            raise ValueError(f"{path}: number outside contract bounds")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", _MAX_TEXT_LENGTH_V1):
            raise ValueError(f"{path}: text length outside contract bounds")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", 10_000):
            raise ValueError(f"{path}: item count outside contract bounds")
        for index, item in enumerate(value):
            _validate_schema_v1(item, schema.get("items", {}), f"{path}[{index}]", depth + 1)
    if isinstance(value, dict):
        if len(value) > schema.get("maxProperties", 100):
            raise ValueError(f"{path}: too many properties")
        if any(not isinstance(key, str) or len(key) > 200 for key in value):
            raise ValueError(f"{path}: property names must be bounded strings")
        required = schema.get("required", [])
        if any(key not in value for key in required):
            raise ValueError(f"{path}: missing required property")
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", False)
        for key, item in value.items():
            if key in properties:
                child = properties[key]
            elif isinstance(extra, dict):
                child = extra
            elif extra is True:
                child = {}
            else:
                raise ValueError(f"{path}: unknown property {key!r}")
            _validate_schema_v1(item, child, f"{path}.{key}", depth + 1)
_MAX_TEXT_LENGTH_V1 = 100000

_c_SCHEMA = "yur.python-specialist-contract.v1"

_c_MAX_CONTRACT_BYTES = 64 * 1024

_c_MAX_INPUT_BYTES = 16 * 1024

_c_MAX_OUTPUT_BYTES = 32 * 1024

_c_MAX_SCHEMA_DEPTH = 8

_c_MAX_PROPERTIES = 32

_c_MAX_ARRAY_ITEMS = 128

_c_MAX_STRING_LENGTH = 8000

_c_MAX_SAFE_NUMBER = 9007199254740991

_c_MAX_JSON_NODES = 6000

_c_FIELDS = {"schema", "name", "description", "input_schema", "output_schema", "cases"}

_c_CASE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

_c_SCALARS = {"string", "integer", "number", "boolean", "null"}

_c_KEYWORDS = {
    "object": {"type", "properties", "required", "additionalProperties", "maxProperties"},
    "array": {"type", "items", "minItems", "maxItems"},
    "string": {"type", "enum", "minLength", "maxLength"},
    "integer": {"type", "enum", "minimum", "maximum"},
    "number": {"type", "enum", "minimum", "maximum"},
    "boolean": {"type", "enum"},
    "null": {"type", "enum"},
}

def _c_json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")

def _c_checked_json(value, byte_limit, *, max_depth=24):
    """Reject non-JSON Python values before serialization, with bounded traversal."""
    nodes = 0
    active = set()

    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > _c_MAX_JSON_NODES or depth > max_depth:
            raise ValueError("JSON nesting or node budget exceeded")
        kind = type(item)
        if item is None or kind is bool:
            return
        if kind in (int, float):
            if (kind is float and not math.isfinite(item)) or abs(item) > _c_MAX_SAFE_NUMBER:
                raise ValueError("JSON numbers must be finite and within the JavaScript-safe magnitude")
            return
        if kind is str:
            if len(item) > _c_MAX_STRING_LENGTH or any((ord(char) < 32 and char not in "\t\r\n") or ord(char) == 127 for char in item):
                raise ValueError("JSON string limit or control-character restriction exceeded")
            try:
                item.encode("utf-8")
            except UnicodeError as error:
                raise ValueError("JSON strings must contain valid Unicode") from error
            if _SECRET_V1.search(item):
                raise ValueError("Credential-like content is not admitted in a worker contract or value")
            return
        if kind not in (list, dict):
            raise ValueError("Only plain JSON values are admitted")
        identity = id(item)
        if identity in active:
            raise ValueError("Cyclic JSON values are not admitted")
        active.add(identity)
        try:
            if kind is dict:
                if len(item) > _c_MAX_PROPERTIES:
                    raise ValueError("JSON object property budget exceeded")
                for key, child in item.items():
                    if type(key) is not str or not key or len(key) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in key):
                        raise ValueError("JSON property names must be bounded printable strings")
                    visit(key, depth + 1)
                    visit(child, depth + 1)
            else:
                if len(item) > _c_MAX_ARRAY_ITEMS:
                    raise ValueError("JSON array item budget exceeded")
                for child in item:
                    visit(child, depth + 1)
        finally:
            active.remove(identity)

    visit(value, 0)
    raw = _c_json_bytes(value)
    if len(raw) > byte_limit:
        raise ValueError("JSON byte budget exceeded")
    # Detect assignments such as {"password": "..."} as well as standalone tokens.
    if _SECRET_V1.search(raw.decode("utf-8")):
        raise ValueError("Credential-like content is not admitted in a worker contract or value")
    return raw

def _c_integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be a bounded integer")

def _c_semantic_key(value):
    """Treat 1/1.0 and signed numeric zero as ambiguous duplicate examples."""
    if type(value) is float and value.is_integer():
        value = int(value)
    elif type(value) is list:
        value = [_c_semantic_key(item) for item in value]
    elif type(value) is dict:
        value = {key: _c_semantic_key(item) for key, item in value.items()}
    return value

def _c_definition(schema, depth=1):
    if depth > _c_MAX_SCHEMA_DEPTH or type(schema) is not dict:
        raise ValueError("Schema must be an object within the eight-level definition limit")
    kind = schema.get("type")
    if type(kind) is not str or kind not in _c_KEYWORDS or set(schema) - _c_KEYWORDS[kind]:
        raise ValueError("Unsupported schema type or keyword; references, unions and patterns are not admitted")
    if kind == "object":
        if not {"properties", "required", "additionalProperties"} <= set(schema):
            raise ValueError("Object schemas require properties, required and additionalProperties:false")
        properties, required = schema["properties"], schema["required"]
        if type(properties) is not dict or len(properties) > _c_MAX_PROPERTIES or schema["additionalProperties"] is not False:
            raise ValueError("Object schemas must enumerate at most 32 properties and reject extras")
        if (type(required) is not list or any(type(key) is not str for key in required)
                or len(required) != len(set(required)) or set(required) - set(properties)):
            raise ValueError("Required properties must be distinct declared names")
        maximum = schema.get("maxProperties", len(properties))
        _c_integer(maximum, 0, _c_MAX_PROPERTIES, "maxProperties")
        if maximum < len(required):
            raise ValueError("maxProperties contradicts required properties")
        for child in properties.values():
            _c_definition(child, depth + 1)
    elif kind == "array":
        if not {"items", "maxItems"} <= set(schema):
            raise ValueError("Array schemas require an item schema and explicit maxItems")
        _c_integer(schema["maxItems"], 0, _c_MAX_ARRAY_ITEMS, "maxItems")
        _c_integer(schema.get("minItems", 0), 0, schema["maxItems"], "minItems")
        _c_definition(schema["items"], depth + 1)
    elif kind == "string":
        if "maxLength" not in schema:
            raise ValueError("String schemas require an explicit maxLength")
        _c_integer(schema["maxLength"], 0, _c_MAX_STRING_LENGTH, "maxLength")
        _c_integer(schema.get("minLength", 0), 0, schema["maxLength"], "minLength")
    elif kind in ("number", "integer"):
        for key in ("minimum", "maximum"):
            if key in schema and (type(schema[key]) not in ((int,) if kind == "integer" else (int, float))):
                raise ValueError("Numeric schema bounds must match the declared numeric type")
        if schema.get("minimum", -_c_MAX_SAFE_NUMBER) > schema.get("maximum", _c_MAX_SAFE_NUMBER):
            raise ValueError("minimum must not exceed maximum")
    if "enum" in schema:
        enum = schema["enum"]
        if kind not in _c_SCALARS or type(enum) is not list or not 1 <= len(enum) <= 32:
            raise ValueError("Enums require one to 32 scalar values")
        base = {key: value for key, value in schema.items() if key != "enum"}
        seen = set()
        for value in enum:
            _validate_schema_v1(value, base, "enum")
            key = _c_json_bytes(_c_semantic_key(value))
            if key in seen:
                raise ValueError("Enum values must be distinct and unambiguous")
            seen.add(key)

def _c_payload(schema, value, maximum, label):
    _c_checked_json(value, maximum, max_depth=_c_MAX_SCHEMA_DEPTH)
    _validate_schema_v1(value, schema, label)
    return deepcopy(value)

def _c_validate_contract(contract):
    """Validate exact fields, schema definitions and every finite acceptance case."""
    _c_checked_json(contract, _c_MAX_CONTRACT_BYTES)
    if type(contract) is not dict or set(contract) != _c_FIELDS or contract["schema"] != _c_SCHEMA:
        raise ValueError("Expected the exact yur.python-specialist-contract.v1 fields")
    if (type(contract["name"]) is not str or not 1 <= len(contract["name"]) <= 100
            or contract["name"] != contract["name"].strip() or any(ord(char) < 32 or ord(char) == 127 for char in contract["name"])):
        raise ValueError("Contract name must be one to 100 printable characters without surrounding whitespace")
    if type(contract["description"]) is not str or not contract["description"].strip() or len(contract["description"]) > 4000:
        raise ValueError("Contract description must contain one to 4000 characters")
    for key in ("input_schema", "output_schema"):
        _c_definition(contract[key])
        if contract[key]["type"] != "object":
            raise ValueError("Worker input and output schemas must have object roots")
    cases = contract["cases"]
    if type(cases) is not list or not 3 <= len(cases) <= 8:
        raise ValueError("A contract requires three to eight acceptance cases")
    identities, inputs = set(), set()
    for case in cases:
        if type(case) is not dict or set(case) != {"id", "input", "expected"}:
            raise ValueError("Acceptance cases require exactly id, input and expected")
        if type(case["id"]) is not str or not _c_CASE_ID.fullmatch(case["id"]) or case["id"] in identities:
            raise ValueError("Acceptance case IDs must be distinct lowercase logical identifiers")
        identities.add(case["id"])
        _c_payload(contract["input_schema"], case["input"], _c_MAX_INPUT_BYTES, "case input")
        _c_payload(contract["output_schema"], case["expected"], _c_MAX_OUTPUT_BYTES, "case expected")
        key = _c_json_bytes(_c_semantic_key(case["input"]))
        if key in inputs:
            raise ValueError("Acceptance inputs must be distinct; duplicate or ambiguous cases are not admitted")
        inputs.add(key)
    return deepcopy(contract)

def _c_public_contract(contract):
    """Only this projection belongs in blind candidate-generation messages."""
    checked = _c_validate_contract(contract)
    return {key: checked[key] for key in ("name", "description", "input_schema", "output_schema")}

def _c_contract_digest(contract):
    return hashlib.sha256(_c_json_bytes(_c_validate_contract(contract))).hexdigest()

def _c_validate_input(contract, value):
    checked = _c_validate_contract(contract)
    return _c_payload(checked["input_schema"], value, _c_MAX_INPUT_BYTES, "input")

def _c_validate_output(contract, value):
    checked = _c_validate_contract(contract)
    return _c_payload(checked["output_schema"], value, _c_MAX_OUTPUT_BYTES, "output")

def _c_outputs_equal(actual, expected):
    """Exact canonical JSON comparison, not Python's coercive value equality.

    Object key order is irrelevant; array order, numeric representation (1 versus
    1.0), signed floating zero, and scalar types are significant. Invalid JSON
    raises ValueError instead of being accepted as an outcome.
    """
    return (_c_checked_json(actual, _c_MAX_OUTPUT_BYTES, max_depth=_c_MAX_SCHEMA_DEPTH)
            == _c_checked_json(expected, _c_MAX_OUTPUT_BYTES, max_depth=_c_MAX_SCHEMA_DEPTH))

_w_MAX_SOURCE_BYTES = 24 * 1024

_w_MAX_INPUT_BYTES = 16 * 1024

_w_MAX_OUTPUT_BYTES = 32 * 1024

_w_MAX_JSON_DEPTH = 12

_w_MAX_JSON_NODES = 6000

_w_MAX_COLLECTION_ITEMS = 1000

_w_MAX_SAFE_NUMBER = 2**53 - 1

_w_ENVELOPE_SCHEMA = "yur.generated-worker-output.v1"

_w_DRIVER_VERSION = "yur.generated-worker-driver.v1"

_w_WORKER_FILE = "worker.py"

_w_DRIVER_FILE = "test_worker_driver.py"

_w_INPUT_FILE = "_worker_input.py"

class _w_GeneratedWorkerError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

_w_DRIVER_SOURCE = r'''"""Fixed generated-worker driver v1; no acceptance expectations."""
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

_w_DRIVER_SHA256 = hashlib.sha256(_w_DRIVER_SOURCE.encode("utf-8")).hexdigest()

def _w_json_bytes(value, limit: int) -> bytes:
    nodes = 0

    def visit(item, depth=0):
        nonlocal nodes
        nodes += 1
        if depth > _w_MAX_JSON_DEPTH or nodes > _w_MAX_JSON_NODES:
            raise _w_GeneratedWorkerError("invalid_json", "JSON exceeds its depth or node budget")
        kind = type(item)
        if item is None or kind is bool:
            return
        if kind is int:
            if abs(item) > _w_MAX_SAFE_NUMBER:
                raise _w_GeneratedWorkerError("invalid_json", "JSON integer exceeds safe magnitude")
        elif kind is float:
            if not math.isfinite(item) or abs(item) > _w_MAX_SAFE_NUMBER:
                raise _w_GeneratedWorkerError("invalid_json", "JSON number must be finite and within safe magnitude")
        elif kind is str:
            if len(item) > limit:
                raise _w_GeneratedWorkerError("invalid_json", "JSON string exceeds its byte budget")
            item.encode("utf-8", errors="strict")
        elif kind is list:
            if len(item) > _w_MAX_COLLECTION_ITEMS:
                raise _w_GeneratedWorkerError("invalid_json", "JSON collection exceeds its item budget")
            for child in item:
                visit(child, depth + 1)
        elif kind is dict:
            if len(item) > _w_MAX_COLLECTION_ITEMS or any(type(key) is not str for key in item):
                raise _w_GeneratedWorkerError("invalid_json", "JSON objects require bounded string keys")
            for key, child in item.items():
                if len(key) > limit:
                    raise _w_GeneratedWorkerError("invalid_json", "JSON key exceeds its byte budget")
                key.encode("utf-8", errors="strict")
                visit(child, depth + 1)
        else:
            raise _w_GeneratedWorkerError("invalid_json", "Only JSON values are admitted")

    try:
        visit(value)
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (UnicodeError, RecursionError) as error:
        raise _w_GeneratedWorkerError("invalid_json", "JSON must be bounded strict UTF-8") from error
    if len(encoded) > limit:
        raise _w_GeneratedWorkerError("invalid_json", "JSON exceeds its byte budget")
    return encoded

def _w_unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _w_GeneratedWorkerError("invalid_json", "Duplicate JSON fields are not admitted")
        result[key] = value
    return result

def _w_parse_json(raw: bytes, limit: int):
    if not isinstance(raw, bytes) or len(raw) > limit:
        raise _w_GeneratedWorkerError("invalid_json", "JSON exceeds its byte budget")
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_w_unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
        encoded = _w_json_bytes(value, limit)
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise _w_GeneratedWorkerError("invalid_json", "Malformed, duplicate, or unbounded JSON is not admitted") from error
    if encoded != raw:
        raise _w_GeneratedWorkerError("invalid_json", "JSON must use the exact canonical encoding")
    return value

def _w_source(source: str) -> bytes:
    if type(source) is not str or not source.strip() or "\0" in source:
        raise _w_GeneratedWorkerError("invalid_source", "Worker source must be nonempty Python without NUL bytes")
    if len(source) > _w_MAX_SOURCE_BYTES:
        raise _w_GeneratedWorkerError("invalid_source", "Worker source exceeds 24 KiB")
    try:
        encoded = source.encode("utf-8", errors="strict")
    except UnicodeError as error:
        raise _w_GeneratedWorkerError("invalid_source", "Worker source must be strict UTF-8") from error
    if len(encoded) > _w_MAX_SOURCE_BYTES:
        raise _w_GeneratedWorkerError("invalid_source", "Worker source exceeds 24 KiB")
    if _SECRET_V1.search(source):
        raise _w_GeneratedWorkerError("invalid_source", "Credential-like worker source is not admitted")
    try:
        tree = ast.parse(source, filename=_w_WORKER_FILE, feature_version=(3, 12))
    except (SyntaxError, ValueError, RecursionError) as error:
        raise _w_GeneratedWorkerError("invalid_source", "Worker source must parse as bounded Python") from error
    definitions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run"]
    if len(definitions) != 1 or not isinstance(definitions[0], ast.FunctionDef):
        raise _w_GeneratedWorkerError("invalid_source", "Worker must define one synchronous top-level run(payload)")
    function = definitions[0]
    arguments = function.args
    if (len(arguments.posonlyargs) + len(arguments.args) != 1 or arguments.defaults or arguments.kwonlyargs
            or arguments.vararg or arguments.kwarg or function.decorator_list):
        raise _w_GeneratedWorkerError("invalid_source", "Worker run requires one positional input and no defaults or decorators")
    return encoded

def _w_input_source(encoded: bytes) -> str:
    return "PAYLOAD_JSON = " + repr(encoded.decode("utf-8")) + "\n"

def _w_file(name: str, content: str) -> dict:
    raw = content.encode("utf-8")
    return {"path": name, "content": content, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}

V1_DRIVER_SHA256 = 'fd601eb5d08165d8a330203e11b528929e54aab7d72edb6a11653411137d31d8'
V1_GUARDIAN_SHA256 = '3d68708aebe7cd59192d8c951f4c9a1a675a776d28732aa3d0241d27c5a0f5f9'
V1_RUNTIME_PINS = {'/usr/bin/python3': '1643dacd9feaedc58f3cc581e4d22577dfe25c09b10282936186ccf0f2e61118', '/usr/bin/bwrap': '52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712', '/usr/bin/prlimit': '17064f67e650d6152a6902b013aab496b54c87587c8eea6f5023aafee6154069', '/usr/lib/x86_64-linux-gnu/libseccomp.so.2': 'b4d9140a7797ccf3ac14f5d9d579b64f157111662940cb8330c632b11a8cea8e'}
V1_BPF_SHA256 = '1e734cb834049b904340a8f9ab70bc0cd21b350fc7fdfcfa4d2b2f2188d4a565'
V1_CELL_LIMITS = {'address_space_bytes': 134217728, 'cpu_soft_seconds': 1, 'cpu_hard_seconds': 2, 'wall_seconds': 4, 'output_bytes_per_stream': 65536, 'output_bytes_total': 65536, 'file_bytes': 1048576, 'work_tmpfs_bytes': 16777216, 'temp_tmpfs_bytes': 16777216, 'shm_tmpfs_bytes': 1048576, 'open_files': 64, 'processes': 32, 'new_processes': 0, 'new_threads': 0}

# The following identities describe what old receipts prove, never what may run now.
_RUNTIME_IDENTITY = {'schema': 'yur.generated-runtime-evidence.v1', 'profile': 'python-unittest-serial',
    'architecture': 'x86_64', 'python': '3.12.3', 'libseccomp': '2.5.5',
    'driver_sha256': V1_DRIVER_SHA256, 'guardian_sha256': V1_GUARDIAN_SHA256,
    'bpf_sha256': V1_BPF_SHA256, 'artifacts': V1_RUNTIME_PINS, 'limits': V1_CELL_LIMITS}
_PREFIX = 'work.generated.'
_KINDS = {'accepted', 'candidate.committed', 'snapshot.committed', 'cell.committed',
          'evaluation.committed', 'published', 'result.committed'}
_AUTHORITY = {'issuer': 'local-user', 'scope': 'work-proposals',
              'actions': ['read', 'compute', 'propose', 'commit-artifact'], 'max_steps': 20}
_QUALIFICATION = 'Exact outcomes passed for the supplied finite acceptance cases; broader domain correctness and commercial readiness are unverified.'
_SELECTION = 'Among candidates passing every case, select the smaller UTF-8 source; SHA-256 breaks ties. This is a packaging tradeoff, not a general quality ranking.'


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def _digest(value):
    return hashlib.sha256(_canonical(value)).hexdigest()


def _same(left, right):
    if _canonical(left) != _canonical(right):
        raise ValueError('Historical generated evidence binding differs')


def _keys(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError('Historical generated evidence has unexpected fields')


def _sha(value):
    if type(value) is not str or re.fullmatch('[0-9a-f]{64}', value) is None:
        raise ValueError('Historical evidence requires an exact SHA-256')
    return value


def _identity(mission, step):
    if type(mission) is not str or re.fullmatch('[0-9a-f]{32}', mission) is None or type(step) is not int or not 0 <= step < 20:
        raise ValueError('Select an exact Work identity and step index')


def _snapshot(source, payload):
    _w_source(source)
    encoded = _w_json_bytes(payload, 16384)
    if hashlib.sha256(_w_DRIVER_SOURCE.encode()).hexdigest() != V1_DRIVER_SHA256:
        raise ValueError('Frozen historical driver identity differs')
    body = {'schema': 'yur.execution-snapshot.v1', 'profile': 'python-unittest-serial', 'test_directory': '.',
            'files': [_w_file('worker.py', source), _w_file('test_worker_driver.py', _w_DRIVER_SOURCE),
                      _w_file('_worker_input.py', _w_input_source(encoded))]}
    return {**body, 'id': _digest(body)}


def _frame(snapshot, execution):
    _keys(execution, ('schema', 'snapshot_id', 'profile', 'status', 'exit_code', 'stdout', 'stderr',
        'stdout_bytes', 'stderr_bytes', 'stdout_sha256', 'stderr_sha256', 'duration_ms', 'runtime', 'limits', 'scratch'))
    if (execution['schema'] != 'yur.execution-cell-result.v1' or execution['snapshot_id'] != snapshot['id']
            or execution['profile'] != snapshot['profile'] or execution['status'] not in
            {'completed', 'failed', 'timeout', 'output_limit', 'cancelled'}
            or type(execution['exit_code']) is not int or not -255 <= execution['exit_code'] <= 255
            or type(execution['duration_ms']) is not int or not 0 <= execution['duration_ms'] <= 15000):
        raise ValueError('Historical cell identity or outcome is invalid')
    if ((execution['status'] == 'completed' and execution['exit_code'] != 0)
            or (execution['status'] == 'failed' and execution['exit_code'] == 0) or execution['scratch'] != 'discarded'):
        raise ValueError('Historical cell outcome is inconsistent')
    _same(execution['limits'], V1_CELL_LIMITS)
    for channel in ('stdout', 'stderr'):
        value = execution[channel]
        if type(value) is not str:
            raise ValueError('Historical cell output must be text')
        raw = value.encode('utf-8')
        if (len(raw) > 65536 or type(execution[channel + '_bytes']) is not int
                or len(raw) != execution[channel + '_bytes']
                or hashlib.sha256(raw).hexdigest() != execution[channel + '_sha256']):
            raise ValueError('Historical cell output hash or size differs')
    if execution['stdout_bytes'] + execution['stderr_bytes'] > 65536 or len(_canonical(execution)) > 160 * 1024:
        raise ValueError('Historical cell output exceeds its retained budget')
    runtime = execution['runtime']
    if (type(runtime) is not dict or any(runtime.get(key) != _RUNTIME_IDENTITY[key]
            for key in ('architecture', 'python', 'libseccomp', 'guardian_sha256', 'bpf_sha256'))
            or type(runtime.get('artifacts')) is not dict or set(runtime['artifacts']) != set(V1_RUNTIME_PINS)):
        raise ValueError('Historical cell runtime differs from the pinned v1 evidence identity')
    for name, sha in V1_RUNTIME_PINS.items():
        if type(runtime['artifacts'][name]) is not dict or runtime['artifacts'][name].get('sha256') != sha:
            raise ValueError('Historical runtime resource fingerprint differs')
    return execution


def _output(snapshot, execution):
    try:
        _frame(snapshot, execution)
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        raise ValueError('Worker result failed the current cell evidence contract') from error
    if execution['status'] != 'completed' or execution['exit_code'] != 0:
        raise ValueError('Worker did not complete successfully inside its bounded cell')
    text = execution['stdout']
    if not text.endswith('\n'):
        raise ValueError('Worker output requires one complete canonical envelope')
    try:
        envelope = _w_parse_json(text[:-1].encode('ascii'), 65536)
        _keys(envelope, ('schema', 'payload'))
        if envelope['schema'] != 'yur.generated-worker-output.v1' or type(envelope['payload']) is not str:
            raise ValueError('Invalid worker output envelope')
        encoded = envelope['payload'].encode('ascii')
        raw = base64.b64decode(encoded, validate=True)
        if base64.b64encode(raw) != encoded:
            raise ValueError('Noncanonical base64')
        return _w_parse_json(raw, 32768)
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise ValueError('Worker output is not one bounded canonical base64-JSON envelope') from error


def _find(events, kind, required=True, **identity):
    found = [event for event in events if event['event_type'] == _PREFIX + kind
             and all(event['data']['change'].get(key) == value for key, value in identity.items())]
    if len(found) > 1 or (required and not found):
        raise ValueError('Historical generated boundary is absent or duplicated')
    return found[0] if found else None


def _before(*events):
    if any(left['id'] >= right['id'] for left, right in zip(events, events[1:])):
        raise ValueError('Historical generated boundaries are out of order')


def _history(store, mission_id, step_index, tool):
    _identity(mission_id, step_index)
    work = store.get_work(mission_id)
    _same(work['authority'], _AUTHORITY)
    if work['request']['mode'] != 'code':
        raise ValueError('Generated evidence requires actual Code-origin Work')
    events = [event for event in store.work_events(mission_id) if event['event_type'].startswith(_PREFIX)
              and event['data']['change'].get('step_index') == step_index]
    if not 1 <= len(events) <= 56:
        raise ValueError('Historical generated boundary count exceeds the v1 limit')
    accepted = _find(events, 'accepted')
    change = accepted['data']['change']
    arguments = change['arguments']
    binding = {'step_index': step_index, 'tool': tool, 'input_hash': _digest(arguments)}
    for event in events:
        _keys(event, ('id', 'mission_id', 'revision', 'event_type', 'data', 'created_at', 'state_digest', 'previous_hash', 'hash'))
        if (event['event_type'][len(_PREFIX):] not in _KINDS or event['mission_id'] != mission_id
                or type(event['id']) is not int or event['id'] < 1 or len(_canonical(event)) > 2 * 1024 * 1024):
            raise ValueError('Invalid historical Work event identity or size')
        _sha(event['previous_hash'])
        _same(_digest({key: value for key, value in event.items() if key != 'hash'}), event['hash'])
        document, fields = event['data']['document'], event['data']['change']
        _same(_digest(document), event['state_digest'])
        _same(document['request'], work['request'])
        _same(document['authority'], _AUTHORITY)
        if document['id'] != mission_id or document['status'] != 'running' or len(document['steps']) != step_index:
            raise ValueError('Generated boundary is not from its exact running Work step')
        if any(type(fields.get(key)) is not type(value) or fields[key] != value for key, value in binding.items()):
            raise ValueError('Generated boundary differs from the accepted operation')
        if event is not accepted:
            _before(accepted, event)
    return work, events, accepted, binding


def _cell(events, binding, source, payload, key, after):
    snap = _find(events, 'snapshot.committed', cell_key=key)
    cell = _find(events, 'cell.committed', cell_key=key)
    expected = _snapshot(source, payload)
    _same(snap['data']['change'], {**binding, 'cell_key': key, 'snapshot': expected})
    fields = cell['data']['change']
    _keys(fields, (*binding, 'cell_key', 'snapshot_id', 'snapshot_receipt', 'execution'))
    _same({k: fields[k] for k in (*binding, 'cell_key', 'snapshot_id', 'snapshot_receipt')},
          {**binding, 'cell_key': key, 'snapshot_id': expected['id'], 'snapshot_receipt': snap['hash']})
    _before(after, snap, cell)
    # Even rejected candidate outcomes must have a valid outer frame.
    _frame(expected, fields['execution'])
    return snap, cell, expected, fields['execution']


def _metadata(artifact):
    return {**{key: deepcopy(artifact[key]) for key in ('name', 'description', 'input_schema', 'output_schema',
        'source_sha256', 'contract_sha256', 'driver_sha256')}, 'sha256': _digest(artifact)}


def _result(events, binding, accepted, work_id, result, required):
    event = _find(events, 'result.committed', required=required)
    if event is None:
        return None
    expected = {**result, 'schema': 'yur.work-generated-specialist-result.v1', 'tool': binding['tool'], 'committed': True,
        'provenance': {'parent_work_id': work_id, 'step_index': binding['step_index'], 'input_hash': binding['input_hash'],
                       'accepted_receipt': accepted['hash']}}
    _same(event['data']['change'], {**binding, 'result': expected})
    return event


# Adapted from CPython 3.14.7 Lib/ast.py dump, Python License / PSF-2.0.
# Copyright 2008 Armin Ronacher.
# Copyright (c) 2001 Python Software Foundation; All Rights Reserved.
# Changes: retain only annotate_fields=True, include_attributes=False,
# indent=None, show_empty=False. No parsing, execution or model authority.
_AST_DUMP_PROVENANCE = {'version': 'CPython 3.14.7', 'function': 'ast.dump', 'sha256': '43fdd3794a17808f358946dd481520e3fc06472eba4b6ad68b758e22d17d279e'}
_PSF_LICENSE = 'PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2\n--------------------------------------------\n\n1. This LICENSE AGREEMENT is between the Python Software Foundation\n("PSF"), and the Individual or Organization ("Licensee") accessing and\notherwise using this software ("Python") in source or binary form and\nits associated documentation.\n\n2. Subject to the terms and conditions of this License Agreement, PSF hereby\ngrants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,\nanalyze, test, perform and/or display publicly, prepare derivative works,\ndistribute, and otherwise use Python alone or in any derivative version,\nprovided, however, that PSF\'s License Agreement and PSF\'s notice of copyright,\ni.e., "Copyright (c) 2001 Python Software Foundation; All Rights Reserved"\nare retained in Python alone or in any derivative version prepared by Licensee.\n\n3. In the event Licensee prepares a derivative work that is based on\nor incorporates Python or any part thereof, and wants to make\nthe derivative work available to others as provided herein, then\nLicensee hereby agrees to include in any such work a brief summary of\nthe changes made to Python.\n\n4. PSF is making Python available to Licensee on an "AS IS"\nbasis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR\nIMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND\nDISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS\nFOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT\nINFRINGE ANY THIRD PARTY RIGHTS.\n\n5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON\nFOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS\nA RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,\nOR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.\n\n6. This License Agreement will automatically terminate upon a material\nbreach of its terms and conditions.\n\n7. Nothing in this License Agreement shall be deemed to create any\nrelationship of agency, partnership, or joint venture between PSF and\nLicensee.  This License Agreement does not grant permission to use PSF\ntrademarks or trade name in a trademark sense to endorse or promote\nproducts or services of Licensee, or any third party.\n\n8. By copying, installing or otherwise using Python, Licensee\nagrees to be bound by the terms and conditions of this License\nAgreement.'


def _ast_dump_v1(node):
    """Frozen single-line structural representation; never call current dump."""
    if not isinstance(node, ast.AST):
        raise TypeError('expected AST')
    def format_value(value):
        if isinstance(value, ast.AST):
            cls, fields = type(value), []
            for name in value._fields:
                try:
                    child = getattr(value, name)
                except AttributeError:
                    continue
                if child is None and getattr(cls, name, ...) is None:
                    continue
                if child == [] and getattr(cls._field_types.get(name, object), '__origin__', ...) is list:
                    continue
                fields.append(name + '=' + format_value(child))
            return cls.__name__ + '(' + ', '.join(fields) + ')'
        if isinstance(value, list):
            return '[' + ', '.join(format_value(child) for child in value) + ']'
        return repr(value)
    return format_value(node)


def _publication(store, source_work_id, build_step_index, expected_sha256):
    if expected_sha256 is not None:
        _sha(expected_sha256)
    work, events, accepted, binding = _history(store, source_work_id, build_step_index, 'forge_python_specialist')
    fields = accepted['data']['change']
    _keys(fields, (*binding, 'arguments', 'contract', 'source', 'contract_sha256'))
    args, source = fields['arguments'], fields['source']
    _keys(args, ('contract_path', 'expected_sha256'))
    _keys(source, ('path', 'sha256', 'bytes'))
    _sha(args['expected_sha256'])
    path = args['contract_path']
    if (type(path) is not str or not 1 <= len(path) <= 240 or not path.endswith('.json')
            or any(c in path for c in '\\:\x00') or any(part in ('', '.', '..') for part in path.split('/'))
            or source['path'] != path or source['sha256'] != args['expected_sha256']
            or type(source['bytes']) is not int or not 1 <= source['bytes'] <= 65536):
        raise ValueError('Historical contract source reference differs')
    contract = _c_validate_contract(fields['contract'])
    contract_sha = _c_contract_digest(contract)
    _same(contract_sha, fields['contract_sha256'])
    published = _find(events, 'published')
    summaries, candidates, cohorts = [], [], []
    prior = accepted
    for strategy in ('direct', 'decomposed'):
        candidate_event = _find(events, 'candidate.committed', strategy=strategy)
        candidate_fields = candidate_event['data']['change']
        _keys(candidate_fields, (*binding, 'strategy', 'candidate'))
        candidate = candidate_fields['candidate']
        _keys(candidate, ('source', 'source_sha256', 'structural_sha256', 'error'))
        if type(candidate['error']) is not str or len(candidate['error']) > 500:
            raise ValueError('Invalid candidate rejection description')
        _before(prior, candidate_event, published)
        prior = candidate_event
        passed, cohort = 0, []
        if candidate['source'] is None:
            if candidate['source_sha256'] is not None or candidate['structural_sha256'] is not None or not candidate['error']:
                raise ValueError('Rejected candidate lacks its bounded rejection')
        else:
            raw = _w_source(candidate['source'])
            structural = hashlib.sha256(_ast_dump_v1(ast.parse(candidate['source'], feature_version=(3, 12))).encode()).hexdigest()
            if (candidate['source_sha256'] != hashlib.sha256(raw).hexdigest() or candidate['structural_sha256'] != structural
                    or candidate['error'] or any(item['structural_sha256'] == structural for item in candidates)):
                raise ValueError('Candidate source or structural diversity differs')
            for index, case in enumerate(contract['cases']):
                key = f'{strategy}:{index}'
                snap, cell, snapshot, execution = _cell(events, binding, candidate['source'], case['input'], key, prior)
                evaluation = _find(events, 'evaluation.committed', cell_key=key)
                _before(cell, evaluation, published)
                output = None
                try:
                    output = _output(snapshot, execution)
                    _c_validate_output(contract, output)
                    success = _c_outputs_equal(output, case['expected'])
                    error = '' if success else 'Actual output differs from the independent expected value'
                except (ValueError, TypeError, KeyError) as failure:
                    success, error = False, str(failure)[:500]
                _same(evaluation['data']['change'], {**binding, 'cell_key': key, 'case_id': case['id'],
                    'cell_receipt': cell['hash'], 'passed': success, 'error': error, 'contract_sha256': contract_sha})
                passed += int(success)
                cohort.append({'case_id': case['id'], 'input_hash': _digest(case['input']),
                    'expected_hash': _digest(case['expected']), 'output_hash': _digest(output),
                    'snapshot_id': snapshot['id'], 'snapshot_receipt_hash': snap['hash'],
                    'cell_receipt_hash': cell['hash'], 'evaluation_receipt_hash': evaluation['hash']})
                prior = evaluation
        candidates.append(candidate)
        cohorts.append(cohort)
        summaries.append({'strategy': strategy, 'status': 'passed' if passed == len(contract['cases']) else 'rejected',
            'passed': passed == len(contract['cases']), 'cases_passed': passed, 'cases_total': len(contract['cases']),
            'source_sha256': candidate['source_sha256'], 'structural_sha256': candidate['structural_sha256'], 'error': candidate['error']})
    eligible = [i for i, entry in enumerate(summaries) if entry['passed']]
    if not eligible:
        raise ValueError('Historical publication has no passing candidate')
    selected = min(eligible, key=lambda i: (len(candidates[i]['source'].encode()), candidates[i]['source_sha256']))
    validation = {'cases_total': len(contract['cases']), 'candidates': summaries, 'selected_strategy': ('direct', 'decomposed')[selected],
                  'qualification': _QUALIFICATION, 'selection_reason': _SELECTION}
    artifact = {'schema': 'yur.contained-python-specialist.v1', **_c_public_contract(contract),
                'source': candidates[selected]['source'], 'source_sha256': candidates[selected]['source_sha256'],
                'contract_sha256': contract_sha, 'driver_sha256': V1_DRIVER_SHA256, 'validation': validation}
    artifact_sha = _digest(artifact)
    if expected_sha256 is not None:
        _same(expected_sha256, artifact_sha)
    _same(published['data']['change'], {**binding, 'artifact': artifact, 'artifact_sha256': artifact_sha, 'accepted_receipt': accepted['hash']})
    result = _result(events, binding, accepted, source_work_id,
        {'status': 'published', 'artifact': _metadata(artifact), 'validation': validation}, required=False)
    if result:
        _before(published, result)
    expected_count = 1 + 2 + sum(len(items) * 3 for items in cohorts) + 1 + bool(result)
    if len(events) != expected_count:
        raise ValueError('Unexpected generated events outside the verified cohort')
    cohort = cohorts[selected]
    facts = {'schema': 'yur.generated-publication-evidence.v1', 'verifier': VERIFIER,
        'source_work_id': source_work_id, 'build_step_index': build_step_index, 'artifact_sha256': artifact_sha,
        'name': artifact['name'], 'source_sha256': artifact['source_sha256'], 'contract_sha256': contract_sha,
        'source_file_sha256': source['sha256'], 'driver_sha256': V1_DRIVER_SHA256,
        'runtime_sha256': _digest(_RUNTIME_IDENTITY), 'accepted_receipt_hash': accepted['hash'],
        'publication_receipt_hash': published['hash'], 'validation_receipt_hash': cohort[-1]['evaluation_receipt_hash'],
        'validation_anchor': 'final_selected_case_evaluation', 'validation_cohort_sha256': _digest(cohort),
        'validation_cohort': cohort, 'cases_total': len(cohort), 'qualification': _QUALIFICATION}
    if len(_canonical(facts)) > 16384:
        raise ValueError('Historical publication facts exceed their bounded contract')
    return facts, artifact, contract, published


def resolve_publication(store, source_work_id, build_step_index, expected_sha256=None):
    """Reconstruct immutable facts in the existing verified read transaction.

    This verifies recorded evidence, including synthetic test fixtures if present;
    it does not independently attest that a local journal is an authentic host.
    No source files or current runtime resources are read. Original source-file
    SHA is the accepted acquisition reference; only canonical contract bytes are
    retained and rehashed, so original whitespace bytes cannot be reconstructed.
    """
    with store._read_transaction():
        facts, _, _, _ = _publication(store, source_work_id, build_step_index, expected_sha256)
        return deepcopy(facts)


def resolve_execution(store, publication_facts, execution_work_id, execution_step_index):
    """Verify a subsequent run against freshly reconstructed publication facts.

    Requires the actual committed run result, not just a cell or a forge case.
    Output is schema-checked; unseen-input semantic correctness is not inferred.
    """
    with store._read_transaction():
        if type(publication_facts) is not dict or len(_canonical(publication_facts)) > 16384:
            raise ValueError('Select bounded historical publication facts')
        facts, artifact, contract, published = _publication(store, publication_facts['source_work_id'],
            publication_facts['build_step_index'], publication_facts['artifact_sha256'])
        _same(publication_facts, facts)
        work, events, accepted, binding = _history(store, execution_work_id, execution_step_index, 'run_python_specialist')
        fields = accepted['data']['change']
        _keys(fields, (*binding, 'arguments', 'artifact', 'input', 'published_receipt'))
        args = fields['arguments']
        _keys(args, ('source_work_id', 'build_step_index', 'artifact_sha256', 'input'))
        _same({key: args[key] for key in ('source_work_id', 'build_step_index', 'artifact_sha256')},
              {key: facts[key] for key in ('source_work_id', 'build_step_index', 'artifact_sha256')})
        payload = _c_validate_input(contract, args['input'])
        _same(fields['input'], payload)
        _same(fields['artifact'], artifact)
        _same(fields['published_receipt'], published['hash'])
        _before(published, accepted)
        snap, cell, snapshot, execution = _cell(events, binding, artifact['source'], payload, 'fresh-input', accepted)
        output = _c_validate_output(contract, _output(snapshot, execution))
        selection = {'source_work_id': facts['source_work_id'], 'build_step_index': facts['build_step_index'],
            'artifact_sha256': facts['artifact_sha256'], 'published_receipt': published['hash'],
            'reason': 'Exact retained worker selected and independently reverified before fresh contained execution'}
        result = _result(events, binding, accepted, execution_work_id, {'status': 'recorded', 'artifact': _metadata(artifact),
            'output': output, 'error': '', 'execution': execution, 'selection': selection, 'execution_receipt': cell['hash'],
            'qualification': 'Actual contained output checked against its schema; correctness on this new input is not established by the original finite acceptance cases.'}, required=True)
        _before(cell, result)
        if len(events) != 4:
            raise ValueError('Unexpected generated run boundaries')
        return {**{key: facts[key] for key in ('verifier', 'source_work_id', 'build_step_index', 'artifact_sha256',
            'source_sha256', 'contract_sha256', 'driver_sha256', 'runtime_sha256', 'publication_receipt_hash', 'validation_cohort_sha256')},
            'schema': 'yur.generated-execution-evidence.v1', 'execution_work_id': execution_work_id,
            'execution_step_index': execution_step_index, 'capability_id': 'python.run', 'input_hash': _digest(payload),
            'output_hash': _digest(output), 'accepted_receipt_hash': accepted['hash'], 'snapshot_id': snapshot['id'],
            'snapshot_receipt_hash': snap['hash'], 'execution_receipt_hash': cell['hash'], 'result_receipt_hash': result['hash'],
            'qualification': 'Recorded contained output validated against its schema; correctness on unseen input is unverified.'}
