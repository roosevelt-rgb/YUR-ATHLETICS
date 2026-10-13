"""One bounded OpenAI-compatible model call for the existing Work strategy.

Reuses work_provider's message/catalog contracts and bounded HTTP conventions.
This adapter owns no agent loop, retry, mission state, tool execution or commit.
Safe prefix bases support hosted vLLM/Serverless as well as loopback `/v1`.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import http.client
import json
import re
import socket
import threading
import time
from urllib.parse import urlsplit

from .work_provider import MAX_INPUT_BYTES, MAX_RESPONSE_BYTES, _constant, _messages, _unique, native_tools
from .work_provider import normalize_endpoint as normalize_origin
from .specialists import validate_schema

MAX_ARGUMENT_BYTES = 64 * 1024


def normalize_endpoint(value):
    """Normalize an origin or safe versioned base without vendor assumptions."""
    if not isinstance(value, str) or not value or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\%]", value):
        raise ValueError("Model endpoint requires an HTTPS or loopback HTTP base ending in /v1")
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Model endpoint cannot contain credentials, query or fragment")
    origin = normalize_origin(parsed.scheme + "://" + parsed.netloc)
    path = parsed.path.rstrip("/")
    if not path:
        path = "/v1"
    parts = path.split("/")[1:]
    if (not path.startswith("/") or not parts or parts[-1] != "v1" or len(parts) > 12
            or any(not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", part) for part in parts)):
        raise ValueError("Model endpoint path must contain simple segments ending in /v1")
    return origin + path


def _encoded(value):
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError):
        raise ValueError("Model message contains unsupported JSON values") from None


def _arguments(value, name, schemas):
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_ARGUMENT_BYTES:
            raise ValueError("Tool arguments exceed 64 KiB")
        try:
            value = json.loads(value, object_pairs_hook=_unique, parse_constant=_constant)
        except (ValueError, RecursionError):
            raise ValueError("Model returned invalid or duplicate tool argument JSON") from None
    if not isinstance(value, dict) or len(_encoded(value).encode()) > MAX_ARGUMENT_BYTES:
        raise ValueError("Native tool arguments must be a bounded JSON object")
    try:
        schema = deepcopy(schemas[name])
        validate_schema(value, schema)
        # native_tools expresses specialist payload alternatives as oneOf.
        # Validate each supported branch without changing the core validator.
        alternatives = schema.get("oneOf")
        if alternatives:
            accepted = 0
            for alternative in alternatives:
                branch = {**schema, "properties": {**schema.get("properties", {}), **alternative.get("properties", {})}, "required": list(set(schema.get("required", []) + alternative.get("required", [])))}
                try:
                    validate_schema(value, branch)
                    accepted += 1
                except ValueError:
                    pass
            if accepted != 1:
                raise ValueError()
    except (ValueError, KeyError, RecursionError):
        # Do not echo raw arguments or schema error property names into logs.
        raise ValueError("Model tool arguments do not match the registered input contract") from None
    return deepcopy(value)


def _call(value, schemas, fallback):
    if (not isinstance(value, dict) or set(value) - {"id", "type", "function", "index"}
            or value.get("type", "function") != "function" or not isinstance(value.get("function"), dict)):
        raise ValueError("Model returned a malformed native function call")
    function = value["function"]
    if ({"name", "arguments"} - set(function) or set(function) - {"name", "arguments", "index"}
            or function.get("name") not in schemas):
        raise ValueError("Model requested a tool outside the registered catalog")
    for candidate in (value, function):
        if "index" in candidate and (type(candidate["index"]) is not int or not 0 <= candidate["index"] < 8):
            raise ValueError("Model returned an invalid tool call index")
    arguments = _arguments(function["arguments"], function["name"], schemas)
    call_id = value.get("id")
    if call_id is None:
        fingerprint = _encoded({"position": fallback, "function": {"name": function["name"], "arguments": arguments}})
        call_id = "call_" + hashlib.sha256(fingerprint.encode()).hexdigest()[:32]
    if not isinstance(call_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", call_id):
        raise ValueError("Model returned an invalid tool call identifier")
    return {"id": call_id, "type": "function", "function": {"name": function["name"], "arguments": arguments}}


def convert_messages(messages, tools):
    """Map committed Ollama-style history to explicit OpenAI call/result IDs.

    Existing returned IDs survive exactly. Legacy calls without IDs get stable
    digests. Same-name results pair with the earliest unmatched preceding call.
    The function is pure; it never repairs or writes the mission journal.
    """
    checked = _messages(messages)
    schemas = {tool["function"]["name"]: tool["function"]["parameters"] for tool in tools}
    converted, pending, used = [], [], set()
    for index, message in enumerate(checked):
        role = message["role"]
        if role == "tool":
            name = message.get("tool_name")
            matched = next((call for call in pending if call["function"]["name"] == name), None)
            if matched is None:
                raise ValueError("Tool result has no matching preceding assistant call")
            converted.append({"role": "tool", "tool_call_id": matched["id"], "content": message["content"]})
            pending.remove(matched)
            continue
        if pending:
            raise ValueError("All recorded tool calls need committed results before continuing")
        entry = {"role": role, "content": message["content"]}
        if message.get("tool_calls"):
            calls = [_call(value, schemas, f"history:{index}:{number}") for number, value in enumerate(message["tool_calls"])]
            for call in calls:
                if call["id"] in used:
                    raise ValueError("Recorded tool call identifiers must be unique")
                used.add(call["id"])
            pending = calls.copy()
            entry["tool_calls"] = [{**call, "function": {**call["function"], "arguments": _encoded(call["function"]["arguments"])}} for call in calls]
        converted.append(entry)
    if pending:
        raise ValueError("Unresolved tool calls cannot be sent as completed Work history")
    return converted


def _response(value, schemas, request_digest):
    if (not isinstance(value, dict) or value.get("error") or not isinstance(value.get("choices"), list)
            or len(value["choices"]) != 1 or not isinstance(value["choices"][0], dict)):
        raise ValueError("Model returned an incomplete or invalid chat completion")
    choice = value["choices"][0]
    message = choice.get("message")
    if (choice.get("finish_reason") not in {"stop", "tool_calls"} or not isinstance(message, dict)
            or message.get("role") != "assistant" or message.get("refusal")):
        raise ValueError("Model did not finish an executable Work response")
    content, calls = message.get("content"), message.get("tool_calls", [])
    content = "" if content is None else content
    calls = [] if calls is None else calls
    if (not isinstance(content, str) or len(content) > 100000 or len(content.encode()) > 128 * 1024
            or not isinstance(calls, list) or len(calls) > 8):
        raise ValueError("Model response exceeds its answer or tool-call budget")
    normalized = [_call(call, schemas, f"response:{request_digest}:{index}") for index, call in enumerate(calls)]
    if len({call["id"] for call in normalized}) != len(normalized):
        raise ValueError("Model returned duplicate tool call identifiers")
    if not content.strip() and not normalized:
        raise ValueError("Model returned neither native tool calls nor a public answer")
    # Provider reasoning/private metadata is intentionally not forwarded.
    return {"content": content, "tool_calls": normalized}


def create_model_adapter(model, endpoint, api_key=None, timeout_seconds=120):
    """Return callable(messages, catalog) -> {content, tool_calls}; never retry."""
    if not isinstance(model, str) or not model.strip() or len(model) > 256 or re.search(r"[\x00-\x1f\x7f]", model):
        raise ValueError("Work requires a bounded explicit model name")
    base = normalize_endpoint(endpoint)
    if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= 120):
        raise ValueError("Work provider timeout must be 0..120 seconds")
    if api_key is not None and (not isinstance(api_key, str) or not 1 <= len(api_key) <= 8192 or re.search(r"[^\x21-\x7e]", api_key)):
        raise ValueError("Model credential must be a bounded printable bearer token")

    def adapter(messages, catalog):
        tools = native_tools(catalog)
        payload = {"model": model, "messages": convert_messages(messages, tools), "tools": tools, "stream": False}
        raw = _encoded(payload).encode()
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("Work provider context exceeds 1 MiB")
        schemas = {tool["function"]["name"]: tool["function"]["parameters"] for tool in tools}
        url = urlsplit(base)
        connection = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(url.hostname, url.port, timeout=timeout_seconds)
        timed_out, sockets = threading.Event(), []
        def abort():
            timed_out.set()
            for channel in sockets:
                try:
                    channel.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()
        timer = threading.Timer(timeout_seconds, abort)
        timer.daemon = True
        deadline, response = time.monotonic() + timeout_seconds, None
        try:
            timer.start()
            connection.connect()
            if timed_out.is_set():
                raise TimeoutError("Model request deadline elapsed")
            sockets.append(connection.sock)
            headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "YUR-AI-Desktop/1.0 (Work model adapter)"}
            if api_key is not None:
                headers["Authorization"] = "Bearer " + api_key
            connection.request("POST", url.path + "/chat/completions", body=raw, headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError(f"Work model request failed (HTTP {response.status}); redirects and automatic retries are disabled")
            declared = response.getheader("Content-Length")
            if declared and (not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
                raise ValueError("Work model response exceeds 512 KiB")
            chunks, total = [], 0
            while not response.isclosed() and response.length != 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or timed_out.is_set():
                    raise TimeoutError("Model request deadline elapsed")
                sockets[0].settimeout(remaining)
                chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise ValueError("Work model response exceeds 512 KiB")
            if declared and total != int(declared):
                raise ValueError("Work model response was incomplete")
            try:
                value = json.loads(b"".join(chunks), object_pairs_hook=_unique, parse_constant=_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise ValueError("Work model returned invalid completion JSON") from None
            return _response(value, schemas, hashlib.sha256(raw).hexdigest())
        except (OSError, http.client.HTTPException) as error:
            if timed_out.is_set() or isinstance(error, (TimeoutError, socket.timeout)):
                raise TimeoutError("Work model request exceeded its provider deadline; no automatic retry was made") from None
            raise RuntimeError("Work model transport failed; no automatic retry was made") from None
        finally:
            timer.cancel()
            if response:
                response.close()
            connection.close()
    return adapter
