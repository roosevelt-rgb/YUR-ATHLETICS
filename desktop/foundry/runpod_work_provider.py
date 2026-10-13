"""Bounded async queue transport for the existing provider-neutral Work adapter.

Models request tools; existing Work/CommitService retain all operating authority.
Only an explicit host-selected RunPod endpoint is admitted. No infra API, retry,
queue purge, new orchestration, credential persistence or model fallback exists.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import math
import re
import socket
import threading
import time
from urllib.parse import urlsplit
import uuid

from .openai_work_provider import _encoded, _response, convert_messages
from .work_provider import MAX_INPUT_BYTES, MAX_RESPONSE_BYTES, _constant, _unique, native_tools

STATES = {"IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"}
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"}
MAX_EXCHANGE_SECONDS = 20
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


class RunPodWorkError(RuntimeError):
    """Body-free public failure; exact remote identity lives in owner receipts."""


class RunPodWorkCancelled(RunPodWorkError):
    pass


def normalize_endpoint(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\%]", value):
        raise ValueError("Select an exact RunPod HTTPS queue endpoint")
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or parsed.netloc.lower() != "api.runpod.ai"
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or not re.fullmatch(r"/v2/[A-Za-z0-9_-]{1,128}/?", parsed.path)):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("RunPod queue endpoint must be https://api.runpod.ai/v2/<endpoint-id> without credentials or redirects") from None
    return "https://api.runpod.ai" + parsed.path.rstrip("/")


def _duration(value, minimum, maximum, label):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(label + " exceeds its bounded range")
    return float(value)


def _contains_credential(value, credential):
    if isinstance(value, str):
        return credential in value
    if isinstance(value, list):
        return any(_contains_credential(item, credential) for item in value)
    if isinstance(value, dict):
        return any(_contains_credential(key, credential) or _contains_credential(item, credential)
                   for key, item in value.items())
    return False


def create_model_adapter(model, endpoint, api_key=None, timeout_seconds=120, *,
                         is_cancelled=lambda: False, on_job=lambda event: None,
                         poll_seconds=1, cancel_timeout_seconds=5):
    """Return callable(messages,catalog)->{content,tool_calls}; submit exactly once.

    on_job is a trusted owner callback: its submit-intent commit must succeed
    before a POST. Job acceptance must be committed before polling/using output.
    A callback failure after submit triggers one bounded exact-job cancel attempt.
    """
    if not isinstance(model, str) or not model.strip() or len(model) > 256 or re.search(r"[\x00-\x1f\x7f]", model):
        raise ValueError("Work requires a bounded explicit model name")
    base = normalize_endpoint(endpoint)
    if not isinstance(api_key, str) or not 1 <= len(api_key) <= 8192 or re.search(r"[^\x21-\x7e]", api_key):
        raise ValueError("RunPod requires a host-provided printable bearer credential")
    if api_key in model or api_key in base:
        raise ValueError("RunPod credential cannot be a public resource identifier")
    timeout = _duration(timeout_seconds, .01, 1200, "RunPod deadline")
    interval = _duration(poll_seconds, .01, 5, "RunPod polling interval")
    cleanup_timeout = _duration(cancel_timeout_seconds, .01, 10, "RunPod cancellation deadline")
    if not callable(is_cancelled) or not callable(on_job):
        raise ValueError("RunPod requires trusted cancellation and provenance bindings")
    route = urlsplit(base).path
    endpoint_id = route.rsplit("/", 1)[1]
    blocked, started = False, False

    def exchange(method, suffix, body, deadline):
        # No single trickled response may consume the entire cold-start budget.
        # This also bounds the time until the owner cancellation predicate can
        # be checked again in the SQLite-owning thread.
        deadline = min(deadline, time.monotonic() + MAX_EXCHANGE_SECONDS)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("RunPod request deadline elapsed")
        connection = http.client.HTTPSConnection("api.runpod.ai", timeout=min(20, remaining))
        response = None
        expired, sockets = threading.Event(), []

        def abort():
            expired.set()
            for channel in sockets:
                try:
                    channel.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()

        timer = threading.Timer(remaining, abort)
        timer.daemon = True
        try:
            timer.start()
            connection.connect()
            if expired.is_set():
                raise TimeoutError("RunPod request deadline elapsed")
            channel = connection.sock
            sockets.append(channel)
            connection.request(method, route + suffix, body=None if body is None else _encoded(body).encode(),
                               headers={"Content-Type": "application/json", "Accept": "application/json",
                                        "Authorization": "Bearer " + api_key,
                                        "User-Agent": "YUR-AI-Desktop/1.0 (Work queue adapter)"})
            response = connection.getresponse()
            if response.status != 200:
                raise RunPodWorkError("RunPod request rejected (HTTP " + str(response.status) + "); no automatic retry")
            declared = response.getheader("Content-Length")
            if declared and (not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
                raise RunPodWorkError("RunPod response exceeds 512 KiB")
            chunks, total = [], 0
            while not response.isclosed() and response.length != 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or expired.is_set():
                    raise TimeoutError("RunPod request deadline elapsed")
                channel.settimeout(min(20, remaining))
                piece = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - total))
                if not piece:
                    break
                chunks.append(piece)
                total += len(piece)
                if total > MAX_RESPONSE_BYTES:
                    raise RunPodWorkError("RunPod response exceeds 512 KiB")
            if declared and total != int(declared):
                raise RunPodWorkError("RunPod response was incomplete")
            try:
                value = json.loads(b"".join(chunks), object_pairs_hook=_unique, parse_constant=_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise RunPodWorkError("RunPod returned invalid response JSON") from None
            if not isinstance(value, dict):
                raise RunPodWorkError("RunPod returned an invalid job envelope")
            return value
        except (OSError, http.client.HTTPException):
            if expired.is_set() or time.monotonic() >= deadline:
                raise TimeoutError("RunPod request deadline elapsed; no automatic retry") from None
            raise RunPodWorkError("RunPod transport outcome is uncertain; no automatic retry") from None
        finally:
            timer.cancel()
            if response:
                response.close()
            connection.close()

    def envelope(value, job_id=None):
        identity, status = value.get("id"), value.get("status")
        if not isinstance(identity, str) or not _ID.fullmatch(identity) or api_key in identity or job_id is not None and identity != job_id:
            raise RunPodWorkError("RunPod response does not match its exact job identity")
        if not isinstance(status, str) or status not in STATES:
            raise RunPodWorkError("RunPod returned an unknown job state")
        return identity, status

    def adapter(messages, catalog):
        nonlocal blocked, started
        if blocked:
            raise RunPodWorkError("Prior RunPod outcome needs owner reconciliation; no new submission")
        started = True
        if is_cancelled():
            raise RunPodWorkCancelled("Work was cancelled before RunPod submission")
        tools = native_tools(catalog)
        body = {"model": model, "messages": convert_messages(messages, tools), "tools": tools,
                "stream": False, "max_tokens": 4096, "chat_template_kwargs": {"thinking": False}}
        payload = {"input": {"openai_route": "/v1/chat/completions", "openai_input": body},
                   "policy": {"executionTimeout": 600000, "ttl": 1800000}}
        raw = _encoded(payload).encode()
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("Work provider context exceeds 1 MiB")
        schemas = {tool["function"]["name"]: tool["function"]["parameters"] for tool in tools}
        metadata = {"schema": "yur.work-queue-receipt.v1", "transport": "runpod-queue",
                    "endpoint_id": endpoint_id, "call_id": uuid.uuid4().hex,
                    "request_sha256": hashlib.sha256(raw).hexdigest(), "model": model}
        job_id, remote_state, submitted, completed = None, None, False, False
        deadline = time.monotonic() + timeout

        def notify(phase, **extra):
            on_job({**metadata, "phase": phase, **({"job_id": job_id} if job_id else {}), **extra})

        def cancel_known_job():
            cleanup_deadline = time.monotonic() + cleanup_timeout
            confirmed, state = False, "UNKNOWN"
            try:
                # Ack is a request only. Confirm through /status of the same job.
                acknowledgment = exchange("POST", "/cancel/" + job_id, {}, cleanup_deadline)
                envelope(acknowledgment, job_id)
                while time.monotonic() < cleanup_deadline:
                    record = exchange("GET", "/status/" + job_id, None, cleanup_deadline)
                    _, state = envelope(record, job_id)
                    if state in TERMINAL:
                        confirmed = state == "CANCELLED"
                        break
                    time.sleep(min(.1, max(0, cleanup_deadline - time.monotonic())))
            except Exception:
                pass
            try:
                notify("cancel_confirmed" if confirmed else "cancel_unconfirmed", remote_state=state,
                       cancel_confirmed=confirmed)
            except Exception:
                pass
            return confirmed

        try:
            notify("submit_intent")
            if is_cancelled():
                raise RunPodWorkCancelled("Work was cancelled before RunPod submission")
            # A lost POST acknowledgment never authorizes a second submit.
            submitted = True
            value = exchange("POST", "/run", payload, deadline)
            returned_id = value.get("id")
            if isinstance(returned_id, str) and _ID.fullmatch(returned_id) and api_key not in returned_id:
                job_id = returned_id
            try:
                job_id, remote_state = envelope(value)
            except RunPodWorkError:
                if job_id:
                    notify("acceptance_invalid", remote_state="UNKNOWN")
                raise
            notify("accepted", remote_state=remote_state)
            while True:
                if is_cancelled():
                    raise RunPodWorkCancelled("Work cancelled; remote cancellation requires its exact receipt")
                if time.monotonic() >= deadline:
                    raise TimeoutError("RunPod queue deadline elapsed; remote job needs reconciliation")
                if remote_state in TERMINAL:
                    completed = True
                    notify("terminal", remote_state=remote_state)
                    if remote_state != "COMPLETED":
                        raise RunPodWorkError("RunPod job ended in " + remote_state + "; no automatic retry")
                    output = value.get("output")
                    if isinstance(output, list) and len(output) == 1:
                        output = output[0]
                    result = _response(output, schemas, metadata["request_sha256"])
                    if _contains_credential(result, api_key):
                        raise RunPodWorkError("RunPod completion contained a host credential; output rejected")
                    notify("validated", remote_state=remote_state)
                    return result
                # Interruptible between status requests without another thread
                # reading the owner's SQLite connection.
                wait_until = min(deadline, time.monotonic() + interval)
                while time.monotonic() < wait_until:
                    if is_cancelled():
                        raise RunPodWorkCancelled("Work cancelled; remote cancellation requires its exact receipt")
                    time.sleep(min(.05, max(0, wait_until - time.monotonic())))
                value = exchange("GET", "/status/" + job_id, None, deadline)
                _, changed = envelope(value, job_id)
                if changed != remote_state:
                    remote_state = changed
                    notify("status", remote_state=remote_state)
        except Exception as error:
            if submitted:
                blocked = True
                if job_id and not completed:
                    cancel_known_job()
                elif not job_id:
                    try:
                        notify("submit_uncertain")
                    except Exception:
                        pass
            if isinstance(error, (RunPodWorkError, TimeoutError)):
                raise
            if submitted:
                raise RunPodWorkError("RunPod receipt or completion validation failed; inspect the committed job identity") from None
            raise

    def bind_owner(*, cancelled, receipt):
        nonlocal is_cancelled, on_job
        if started or not callable(cancelled) or not callable(receipt):
            raise ValueError("RunPod owner bindings must be fixed before the first call")
        is_cancelled, on_job = cancelled, receipt

    def reconcile_job(job_id, *, cancel=False, timeout_seconds=5):
        """Inspect/cancel one owner-retained job; never submit or expose output.

        The caller must resolve this identity from its committed submit receipt,
        not from a model/renderer payload. Endpoint and credential remain fixed
        to this host adapter. Cancel acknowledgment alone is never confirmation.
        """
        if not isinstance(job_id, str) or not _ID.fullmatch(job_id) or api_key in job_id or type(cancel) is not bool:
            raise ValueError("Queue reconciliation requires an exact retained job and action")
        limit = _duration(timeout_seconds, .01, 10, "RunPod reconciliation deadline")
        deadline = time.monotonic() + limit
        state, requested = "UNKNOWN", False
        try:
            record = exchange("GET", "/status/" + job_id, None, deadline)
            _, state = envelope(record, job_id)
            if cancel and state not in TERMINAL:
                requested = True
                acknowledgment = exchange("POST", "/cancel/" + job_id, {}, deadline)
                envelope(acknowledgment, job_id)
                while time.monotonic() < deadline:
                    record = exchange("GET", "/status/" + job_id, None, deadline)
                    _, state = envelope(record, job_id)
                    if state in TERMINAL:
                        break
                    time.sleep(min(.1, max(0, deadline - time.monotonic())))
            return {"endpoint_id": endpoint_id, "job_id": job_id, "remote_state": state,
                    "cancel_requested": requested, "cancel_confirmed": state == "CANCELLED",
                    "outcome_known": True}
        except Exception:
            return {"endpoint_id": endpoint_id, "job_id": job_id, "remote_state": "UNKNOWN",
                    "cancel_requested": requested, "cancel_confirmed": False, "outcome_known": False}

    adapter.queue_transport = True
    adapter.bind_owner = bind_owner
    adapter.reconcile_job = reconcile_job
    return adapter
