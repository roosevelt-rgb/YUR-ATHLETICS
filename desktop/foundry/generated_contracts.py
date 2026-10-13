"""Pure contracts for generated Python workers; no code execution or persistence.

Acceptance examples are operator-supplied finite expectations, not a certificate
of domain correctness. Only public_contract() belongs in candidate-generation
context. The caller freezes the complete contract before asking for candidates.
"""
from copy import deepcopy
import hashlib
import json
import math
import re

from .repository_context import SECRET_CONTENT
from .specialists import validate_schema

SCHEMA = "yur.python-specialist-contract.v1"
MAX_CONTRACT_BYTES = 64 * 1024
MAX_INPUT_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 32 * 1024
MAX_SCHEMA_DEPTH = 8
MAX_PROPERTIES = 32
MAX_ARRAY_ITEMS = 128
MAX_STRING_LENGTH = 8000
MAX_SAFE_NUMBER = 9007199254740991
MAX_JSON_NODES = 6000
_FIELDS = {"schema", "name", "description", "input_schema", "output_schema", "cases"}
_CASE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_SCALARS = {"string", "integer", "number", "boolean", "null"}
_KEYWORDS = {
    "object": {"type", "properties", "required", "additionalProperties", "maxProperties"},
    "array": {"type", "items", "minItems", "maxItems"},
    "string": {"type", "enum", "minLength", "maxLength"},
    "integer": {"type", "enum", "minimum", "maximum"},
    "number": {"type", "enum", "minimum", "maximum"},
    "boolean": {"type", "enum"},
    "null": {"type", "enum"},
}


def _json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _checked_json(value, byte_limit, *, max_depth=24):
    """Reject non-JSON Python values before serialization, with bounded traversal."""
    nodes = 0
    active = set()

    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > MAX_JSON_NODES or depth > max_depth:
            raise ValueError("JSON nesting or node budget exceeded")
        kind = type(item)
        if item is None or kind is bool:
            return
        if kind in (int, float):
            if (kind is float and not math.isfinite(item)) or abs(item) > MAX_SAFE_NUMBER:
                raise ValueError("JSON numbers must be finite and within the JavaScript-safe magnitude")
            return
        if kind is str:
            if len(item) > MAX_STRING_LENGTH or any((ord(char) < 32 and char not in "\t\r\n") or ord(char) == 127 for char in item):
                raise ValueError("JSON string limit or control-character restriction exceeded")
            try:
                item.encode("utf-8")
            except UnicodeError as error:
                raise ValueError("JSON strings must contain valid Unicode") from error
            if SECRET_CONTENT.search(item):
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
                if len(item) > MAX_PROPERTIES:
                    raise ValueError("JSON object property budget exceeded")
                for key, child in item.items():
                    if type(key) is not str or not key or len(key) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in key):
                        raise ValueError("JSON property names must be bounded printable strings")
                    visit(key, depth + 1)
                    visit(child, depth + 1)
            else:
                if len(item) > MAX_ARRAY_ITEMS:
                    raise ValueError("JSON array item budget exceeded")
                for child in item:
                    visit(child, depth + 1)
        finally:
            active.remove(identity)

    visit(value, 0)
    raw = _json_bytes(value)
    if len(raw) > byte_limit:
        raise ValueError("JSON byte budget exceeded")
    # Detect assignments such as {"password": "..."} as well as standalone tokens.
    if SECRET_CONTENT.search(raw.decode("utf-8")):
        raise ValueError("Credential-like content is not admitted in a worker contract or value")
    return raw


def _integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be a bounded integer")


def _semantic_key(value):
    """Treat 1/1.0 and signed numeric zero as ambiguous duplicate examples."""
    if type(value) is float and value.is_integer():
        value = int(value)
    elif type(value) is list:
        value = [_semantic_key(item) for item in value]
    elif type(value) is dict:
        value = {key: _semantic_key(item) for key, item in value.items()}
    return value


def _definition(schema, depth=1):
    if depth > MAX_SCHEMA_DEPTH or type(schema) is not dict:
        raise ValueError("Schema must be an object within the eight-level definition limit")
    kind = schema.get("type")
    if type(kind) is not str or kind not in _KEYWORDS or set(schema) - _KEYWORDS[kind]:
        raise ValueError("Unsupported schema type or keyword; references, unions and patterns are not admitted")
    if kind == "object":
        if not {"properties", "required", "additionalProperties"} <= set(schema):
            raise ValueError("Object schemas require properties, required and additionalProperties:false")
        properties, required = schema["properties"], schema["required"]
        if type(properties) is not dict or len(properties) > MAX_PROPERTIES or schema["additionalProperties"] is not False:
            raise ValueError("Object schemas must enumerate at most 32 properties and reject extras")
        if (type(required) is not list or any(type(key) is not str for key in required)
                or len(required) != len(set(required)) or set(required) - set(properties)):
            raise ValueError("Required properties must be distinct declared names")
        maximum = schema.get("maxProperties", len(properties))
        _integer(maximum, 0, MAX_PROPERTIES, "maxProperties")
        if maximum < len(required):
            raise ValueError("maxProperties contradicts required properties")
        for child in properties.values():
            _definition(child, depth + 1)
    elif kind == "array":
        if not {"items", "maxItems"} <= set(schema):
            raise ValueError("Array schemas require an item schema and explicit maxItems")
        _integer(schema["maxItems"], 0, MAX_ARRAY_ITEMS, "maxItems")
        _integer(schema.get("minItems", 0), 0, schema["maxItems"], "minItems")
        _definition(schema["items"], depth + 1)
    elif kind == "string":
        if "maxLength" not in schema:
            raise ValueError("String schemas require an explicit maxLength")
        _integer(schema["maxLength"], 0, MAX_STRING_LENGTH, "maxLength")
        _integer(schema.get("minLength", 0), 0, schema["maxLength"], "minLength")
    elif kind in ("number", "integer"):
        for key in ("minimum", "maximum"):
            if key in schema and (type(schema[key]) not in ((int,) if kind == "integer" else (int, float))):
                raise ValueError("Numeric schema bounds must match the declared numeric type")
        if schema.get("minimum", -MAX_SAFE_NUMBER) > schema.get("maximum", MAX_SAFE_NUMBER):
            raise ValueError("minimum must not exceed maximum")
    if "enum" in schema:
        enum = schema["enum"]
        if kind not in _SCALARS or type(enum) is not list or not 1 <= len(enum) <= 32:
            raise ValueError("Enums require one to 32 scalar values")
        base = {key: value for key, value in schema.items() if key != "enum"}
        seen = set()
        for value in enum:
            validate_schema(value, base, "enum")
            key = _json_bytes(_semantic_key(value))
            if key in seen:
                raise ValueError("Enum values must be distinct and unambiguous")
            seen.add(key)


def _payload(schema, value, maximum, label):
    _checked_json(value, maximum, max_depth=MAX_SCHEMA_DEPTH)
    validate_schema(value, schema, label)
    return deepcopy(value)


def validate_contract(contract):
    """Validate exact fields, schema definitions and every finite acceptance case."""
    _checked_json(contract, MAX_CONTRACT_BYTES)
    if type(contract) is not dict or set(contract) != _FIELDS or contract["schema"] != SCHEMA:
        raise ValueError("Expected the exact yur.python-specialist-contract.v1 fields")
    if (type(contract["name"]) is not str or not 1 <= len(contract["name"]) <= 100
            or contract["name"] != contract["name"].strip() or any(ord(char) < 32 or ord(char) == 127 for char in contract["name"])):
        raise ValueError("Contract name must be one to 100 printable characters without surrounding whitespace")
    if type(contract["description"]) is not str or not contract["description"].strip() or len(contract["description"]) > 4000:
        raise ValueError("Contract description must contain one to 4000 characters")
    for key in ("input_schema", "output_schema"):
        _definition(contract[key])
        if contract[key]["type"] != "object":
            raise ValueError("Worker input and output schemas must have object roots")
    cases = contract["cases"]
    if type(cases) is not list or not 3 <= len(cases) <= 8:
        raise ValueError("A contract requires three to eight acceptance cases")
    identities, inputs = set(), set()
    for case in cases:
        if type(case) is not dict or set(case) != {"id", "input", "expected"}:
            raise ValueError("Acceptance cases require exactly id, input and expected")
        if type(case["id"]) is not str or not _CASE_ID.fullmatch(case["id"]) or case["id"] in identities:
            raise ValueError("Acceptance case IDs must be distinct lowercase logical identifiers")
        identities.add(case["id"])
        _payload(contract["input_schema"], case["input"], MAX_INPUT_BYTES, "case input")
        _payload(contract["output_schema"], case["expected"], MAX_OUTPUT_BYTES, "case expected")
        key = _json_bytes(_semantic_key(case["input"]))
        if key in inputs:
            raise ValueError("Acceptance inputs must be distinct; duplicate or ambiguous cases are not admitted")
        inputs.add(key)
    return deepcopy(contract)


def public_contract(contract):
    """Only this projection belongs in blind candidate-generation messages."""
    checked = validate_contract(contract)
    return {key: checked[key] for key in ("name", "description", "input_schema", "output_schema")}


def contract_digest(contract):
    return hashlib.sha256(_json_bytes(validate_contract(contract))).hexdigest()


def validate_input(contract, value):
    checked = validate_contract(contract)
    return _payload(checked["input_schema"], value, MAX_INPUT_BYTES, "input")


def validate_output(contract, value):
    checked = validate_contract(contract)
    return _payload(checked["output_schema"], value, MAX_OUTPUT_BYTES, "output")


def outputs_equal(actual, expected):
    """Exact canonical JSON comparison, not Python's coercive value equality.

    Object key order is irrelevant; array order, numeric representation (1 versus
    1.0), signed floating zero, and scalar types are significant. Invalid JSON
    raises ValueError instead of being accepted as an outcome.
    """
    return (_checked_json(actual, MAX_OUTPUT_BYTES, max_depth=MAX_SCHEMA_DEPTH)
            == _checked_json(expected, MAX_OUTPUT_BYTES, max_depth=MAX_SCHEMA_DEPTH))
