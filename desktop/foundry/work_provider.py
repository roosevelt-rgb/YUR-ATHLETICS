"""Provider adapter for the existing Work strategy; no loop or state ownership."""
from __future__ import annotations

from copy import deepcopy
import http.client
import ipaddress
import json
import os
import re
import socket
import threading
import time
from urllib.parse import urlsplit

MAX_INPUT_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_CONTEXT_TOKENS = 16384
MAX_CONTEXT_TOKENS = 131072


class UnsupportedWorkProvider(ValueError):
    pass


class EmptyWorkResponse(ValueError):
    """No executable response; metadata only, never model reasoning or content."""

    code = "EMPTY_WORK_RESPONSE"

    def __init__(self, response: dict):
        message = response["message"]
        reason = response.get("done_reason")
        reason = (reason if isinstance(reason, str) and reason in {"stop", "length", "load", "unload"}
                  else "missing" if reason is None else "other")
        self.diagnostics = {
            "schema": "yur.work-provider-diagnostic.v1",
            "provider": "ollama", "outcome": "empty_response", "done_reason": reason,
            "content_chars": len(message.get("content", "")),
            "thinking_chars": len(message["thinking"]) if isinstance(message.get("thinking"), str) else 0,
            "tool_call_count": len(message.get("tool_calls", [])),
        }
        for key in ("eval_count", "prompt_eval_count"):
            count = response.get(key)
            if type(count) is int and 0 <= count <= 2**63 - 1:
                self.diagnostics[key] = count
        summary = "; ".join(f"{key}={value}" for key, value in self.diagnostics.items()
                            if key not in {"schema", "provider", "outcome"})
        super().__init__(f"Ollama returned neither work nor an answer ({summary})")


def normalize_endpoint(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValueError("Work endpoint must be an HTTP loopback or HTTPS origin")
    try:
        url = urlsplit(value)
        port = url.port
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
            raise ValueError("Work endpoint must be an origin without credentials, paths or queries")
        if url.scheme == "http" and url.hostname.lower() != "localhost":
            try:
                loopback = ipaddress.ip_address(url.hostname).is_loopback
            except ValueError:
                loopback = False
            if not loopback:
                raise ValueError("Non-loopback Work endpoints require HTTPS")
        host = f"[{url.hostname.lower()}]" if ":" in url.hostname else url.hostname.lower()
        default = 443 if url.scheme == "https" else 80
        return f"{url.scheme}://{host}" + (f":{port}" if port and port != default else "")
    except (ValueError, TypeError) as error:
        raise ValueError("Work endpoint must be an HTTP loopback or HTTPS origin without credentials, paths or queries") from error


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Provider returned duplicate JSON fields")
        value[key] = item
    return value


def _constant(_value):
    raise ValueError("Provider returned a non-finite JSON value")


def native_tools(catalog: list) -> list[dict]:
    if not isinstance(catalog, list) or not 1 <= len(catalog) <= 32:
        raise ValueError("Work requires a bounded registered tool catalog")
    tools, seen = [], set()
    for entry in catalog:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", entry["name"]) or entry["name"] in seen:
            raise ValueError("Invalid or duplicate registered tool name")
        if not isinstance(entry.get("description"), str) or not isinstance(entry.get("input_schema"), dict):
            raise ValueError("Registered tools require descriptions and input schemas")
        parameters = deepcopy(entry["input_schema"])
        if parameters.get("type") != "object" or parameters.get("additionalProperties") is not False:
            raise ValueError("Work tools require strict object input schemas")
        if entry["name"] in {"run_specialist", "run_built_specialist", "run_saved_specialist"} and entry.get("capabilities"):
            # Preserve exact specialist payload schemas in the native model API,
            # rather than exposing an opaque object the model must guess at.
            parameters["oneOf"] = [{"properties": {"capability_id": {"enum": [capability["id"]]}, "input": deepcopy(capability["input_schema"])},
                                      "required": ["capability_id", "input"]} for capability in entry["capabilities"]]
        seen.add(entry["name"])
        tools.append({"type": "function", "function": {"name": entry["name"], "description": entry["description"], "parameters": parameters}})
    return tools


def _messages(messages):
    if not isinstance(messages, list) or not 1 <= len(messages) <= 121:
        raise ValueError("Work provider context exceeds its message budget")
    for message in messages:
        if not isinstance(message, dict) or set(message) - {"role", "content", "tool_calls", "tool_name"} or message.get("role") not in {"system", "user", "assistant", "tool"} or not isinstance(message.get("content"), str):
            raise ValueError("Invalid Work provider message")
        if "tool_calls" in message and (message["role"] != "assistant" or not isinstance(message["tool_calls"], list) or len(message["tool_calls"]) > 8):
            raise ValueError("Invalid recorded tool calls")
        if "tool_name" in message and (message["role"] != "tool" or not isinstance(message["tool_name"], str) or len(message["tool_name"]) > 80):
            raise ValueError("Invalid recorded tool result")
    return deepcopy(messages)


def create_model_adapter(provider: str, model: str, *, endpoint=DEFAULT_OLLAMA_URL, timeout_seconds=120, context_tokens=None):
    """Return one bounded model request callable; the manager owns continuation."""
    if provider != "ollama":
        raise UnsupportedWorkProvider("The selected Foundry service has no verified tool-call contract. Select an Ollama model for Work or Code; regular Foundry chat remains available.")
    if not isinstance(model, str) or not model.strip() or len(model) > 256 or re.search(r"[\x00-\x1f\x7f]", model):
        raise ValueError("Work requires a bounded explicit model name")
    origin = normalize_endpoint(endpoint)
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not 0 < timeout_seconds <= 120:
        raise ValueError("Work provider timeout must be 0..120 seconds")
    # A provider default can allocate the model's entire 128K+ context even for
    # a tiny mission. Bound this request without rewriting the user's model.
    if context_tokens is None:
        configured = os.environ.get("YUR_WORK_CONTEXT_TOKENS")
        if configured is None:
            context_tokens = DEFAULT_CONTEXT_TOKENS
        elif re.fullmatch(r"[0-9]{4,6}", configured):
            context_tokens = int(configured)
        else:
            raise ValueError("YUR_WORK_CONTEXT_TOKENS must be an integer from 4096 to 131072")
    if type(context_tokens) is not int or not 4096 <= context_tokens <= MAX_CONTEXT_TOKENS:
        raise ValueError("Work context_tokens must be an integer from 4096 to 131072")

    def adapter(messages, catalog):
        # Work needs either native tool calls or a public final answer. Disable
        # provider-side private thinking so a successful stop cannot contain
        # only hidden reasoning after committed tool results.
        payload = {"model": model, "messages": _messages(messages), "tools": native_tools(catalog),
                   "think": False, "stream": False, "options": {"num_ctx": context_tokens}}
        raw = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("Work provider context exceeds 1 MiB; inspect committed results before continuing")
        url = urlsplit(origin)
        connection_class = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(url.hostname, url.port, timeout=timeout_seconds)
        timed_out = threading.Event()
        sockets = []

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
        deadline = time.monotonic() + timeout_seconds
        response = None
        try:
            timer.start()
            connection.connect()
            if timed_out.is_set():
                raise TimeoutError("Work provider deadline elapsed")
            sockets.append(connection.sock)
            connection.request("POST", "/api/chat", body=raw, headers={"Content-Type": "application/json", "Accept": "application/json"})
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError(f"Ollama Work request failed (HTTP {response.status}); redirects are not followed")
            declared = response.getheader("Content-Length")
            if declared and (not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
                raise ValueError("Work provider response exceeds 512 KiB")
            chunks, total = [], 0
            while True:
                if response.isclosed() or response.length == 0:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0 or timed_out.is_set():
                    raise TimeoutError("Work provider deadline elapsed")
                sockets[0].settimeout(remaining)
                chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise ValueError("Work provider response exceeds 512 KiB")
            if declared and total != int(declared):
                raise ValueError("Work provider response was incomplete")
            value = json.loads(b"".join(chunks), object_pairs_hook=_unique, parse_constant=_constant)
            if not isinstance(value, dict) or value.get("error") or value.get("done") is not True or not isinstance(value.get("message"), dict):
                raise ValueError("Ollama returned an incomplete or invalid Work response")
            message = value["message"]
            content, calls = message.get("content", ""), message.get("tool_calls", [])
            if not isinstance(content, str) or len(content) > 100000 or len(content.encode("utf-8")) > 128 * 1024 or not isinstance(calls, list) or len(calls) > 8:
                raise ValueError("Work response exceeds its answer or tool-call budget")
            for call in calls:
                function = call.get("function") if isinstance(call, dict) else None
                if not isinstance(function, dict) or not isinstance(function.get("name"), str) or len(function["name"]) > 80 or not isinstance(function.get("arguments"), (dict, str)):
                    raise ValueError("Ollama returned a malformed native tool call")
            if not content.strip() and not calls:
                raise EmptyWorkResponse(value)
            return {"content": content, "tool_calls": calls}
        except (OSError, http.client.HTTPException) as error:
            if timed_out.is_set() or isinstance(error, (TimeoutError, socket.timeout)):
                raise TimeoutError("Ollama Work request exceeded its provider deadline") from error
            raise RuntimeError(f"Ollama Work transport failed at {origin}: {type(error).__name__}") from error
        finally:
            timer.cancel()
            if response:
                response.close()
            connection.close()

    return adapter
