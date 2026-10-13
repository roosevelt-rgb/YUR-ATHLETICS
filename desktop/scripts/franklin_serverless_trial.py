"""One supervised, disposable Franklin Serverless acceptance trial.

Default invocation prints a proposal only. --check performs read-only preflight.
Cloud writes require --execute-approved-trial after explicit owner approval.
No pod/volume APIs, retries of inference/create, or automatic allocation upgrades.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid

MODEL = "deepseek-ai/DeepSeek-V4-Flash"
REVISION = "60d8d70770c6776ff598c94bb586a859a38244f1"
MODEL_REFERENCE = f"https://huggingface.co/{MODEL}:{REVISION}"
SERVED_MODEL = "franklin-deepseek-v4-flash"
IMAGE = "runpod/worker-v1-vllm@sha256:f0cba070a8d324fc664934c31b9e89d7a294f9116b2c81984defc2edcbc7098d"
CACHE = f"/runpod-volume/huggingface-cache/hub/models--deepseek-ai--DeepSeek-V4-Flash/snapshots/{REVISION}"
CONTROL = "https://api.runpod.io/v2"
INVOKE = "https://api.runpod.ai/v2"
OWNER = "yur.franklin.serverless-trial.v1"
PRICE_LIMIT = 11.86
MAX_WALL_SECONDS = 45 * 60
CLEANUP_RESERVE = 120
TERMINAL = {"COMPLETED", "CANCELLED", "FAILED", "TIMED_OUT"}
ENV = {
    "MODEL_NAME": CACHE, "OPENAI_SERVED_MODEL_NAME_OVERRIDE": SERVED_MODEL,
    "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    "TOKENIZER_MODE": "deepseek_v4", "TOOL_CALL_PARSER": "deepseek_v4",
    "ENABLE_AUTO_TOOL_CHOICE": "true", "REASONING_PARSER": "deepseek_v4",
    "REASONING_CONFIG": json.dumps({"reasoning_parser": "deepseek_v4", "reasoning_start_str": "", "reasoning_end_str": ""}, separators=(",", ":")),
    "TENSOR_PARALLEL_SIZE": "2", "KV_CACHE_DTYPE": "fp8", "BLOCK_SIZE": "256",
    "MAX_MODEL_LEN": "32768", "MAX_NUM_SEQS": "1", "MAX_NUM_BATCHED_TOKENS": "4096",
    "MAX_CONCURRENCY": "1", "GPU_MEMORY_UTILIZATION": "0.90", "ENFORCE_EAGER": "true",
    "ENABLE_FLASHINFER_AUTOTUNE": "false", "VLLM_USE_DEEP_GEMM": "1",
    "VLLM_STARTUP_TIMEOUT": "1200",
}


class TrialError(RuntimeError):
    """Messages deliberately contain no raw provider or subprocess output."""


class ApiError(TrialError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"RunPod HTTP {status}")


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def resource_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        raise TrialError("Missing or invalid resource ID")
    return value


def unwrap(value, *keys):
    for key in keys:
        if isinstance(value, dict) and isinstance(value.get(key), dict):
            return value[key]
    return value


class RunPod:
    def __init__(self, cli, key=None):
        self.cli_path = str(cli)
        self.key = key if key is not None else os.environ.get("RUNPOD_API_KEY", "")
        if not self.key:
            raise TrialError("RUNPOD_API_KEY is not available in the process environment")

    def request(self, method, path, body=None, invoke=False):
        # The tool deliberately cannot operate pods, volumes, accounts, or secrets.
        if invoke:
            if not re.fullmatch(r"/[A-Za-z0-9_-]+/(run|status/[A-Za-z0-9_-]+|cancel/[A-Za-z0-9_-]+)", path):
                raise TrialError("Disallowed inference route")
        elif not re.match(r"^/(serverless|templates|catalog/gpus)(/|\?|$)", path):
            raise TrialError("Disallowed control route")
        data = None if body is None else json.dumps(body).encode()
        req = Request((INVOKE if invoke else CONTROL) + path, data=data, method=method,
                      headers={"Authorization": "Bearer " + self.key,
                               "Content-Type": "application/json", "User-Agent": OWNER})
        try:
            with urlopen(req, timeout=30) as response:
                raw = response.read(4 * 1024 * 1024)
                return json.loads(raw) if raw else {}
        except HTTPError as exc:
            raise ApiError(exc.code) from None
        except (TimeoutError, OSError, ValueError):
            raise TrialError("RunPod request failed or returned invalid JSON; no request was retried") from None

    def cli(self, args, timeout=120):
        try:
            result = subprocess.run([self.cli_path, *args, "--output", "json"],
                                    capture_output=True, text=True, timeout=timeout,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.TimeoutExpired):
            raise TrialError("RunPod CLI did not return; resource outcome requires reconciliation") from None
        if result.returncode:
            raise TrialError(f"RunPod CLI exited {result.returncode}; no automatic retry")
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise TrialError("RunPod CLI response was not JSON; outcome requires reconciliation") from None

    def verify_cli(self):
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            version = subprocess.run([self.cli_path, "version"], capture_output=True, text=True, timeout=10, creationflags=flags)
            help_result = subprocess.run([self.cli_path, "serverless", "create", "--help"], capture_output=True, text=True, timeout=10, creationflags=flags)
        except (OSError, subprocess.TimeoutExpired):
            raise TrialError("The approved RunPod CLI is unavailable") from None
        if version.returncode or not version.stdout.startswith("runpodctl 2.14.0"):
            raise TrialError("Expected the reviewed RunPod CLI 2.14.0")
        required = ("--model-reference", "--gpu-count", "--workers-min", "--workers-max",
                    "--idle-timeout", "--execution-timeout", "--min-cuda-version", "--scale-by")
        if help_result.returncode or any(flag not in help_result.stdout for flag in required):
            raise TrialError("RunPod CLI lacks a required reviewed flag")
        return version.stdout.strip()

    def list_resources(self, kind):
        if kind not in {"serverless", "templates"}:
            raise TrialError("Unowned resource type")
        result, cursor = [], None
        for _ in range(20):
            query = {"limit": 100}
            if cursor:
                query["cursor"] = cursor
            value = self.request("GET", "/" + kind + "?" + urlencode(query))
            rows = value.get("items", value.get("endpoints" if kind == "serverless" else "templates", []))
            if not isinstance(rows, list):
                raise TrialError("Invalid resource inventory")
            result.extend(rows)
            cursor = value.get("pagination", {}).get("nextCursor")
            if not cursor:
                return result
        raise TrialError("Resource inventory exceeds bounded pagination")


def preflight(api):
    version = api.verify_cli()
    gpu = unwrap(api.request("GET", "/catalog/gpus/NVIDIA%20H200?include=AVAILABILITY&product=SERVERLESS&count=2&minCudaVersion=13.0"), "gpu")
    price = gpu.get("price", {}).get("serverless")
    if isinstance(price, bool) or not isinstance(price, (int, float)) or price <= 0:
        raise TrialError("Current H200 Serverless price is unavailable")
    total = round(price * 2, 6)
    if total > PRICE_LIMIT:
        raise TrialError("Current two-H200 price exceeds the approved $11.86/hour ceiling")
    if gpu.get("pool") != "HOPPER_141" or gpu.get("availability") not in {"LOW", "MEDIUM", "HIGH"}:
        raise TrialError("Two H200 Serverless GPUs are not currently available")
    existing = {kind: [resource_id(x.get("id")) for x in api.list_resources(kind)] for kind in ("serverless", "templates")}
    return {"cli": version, "price_per_worker_hour": total, "gpu_availability": gpu["availability"], "existing_ids": existing}


def template_body(name):
    return {"name": name, "serverless": True, "category": "NVIDIA", "image": IMAGE, "disk": 40, "env": dict(ENV)}


def create_arguments(template_id, name):
    return ["serverless", "create", "--name", name, "--template-id", resource_id(template_id),
            "--gpu-id", "NVIDIA H200", "--gpu-count", "2", "--workers-min", "0", "--workers-max", "1",
            "--scale-by", "delay", "--scale-threshold", "4", "--idle-timeout", "60",
            "--execution-timeout", "600", "--flash-boot", "--min-cuda-version", "13.0",
            "--model-reference", MODEL_REFERENCE]


def verify_endpoint(value, cli_value, state):
    value = unwrap(value, "endpoint")
    cli_value = unwrap(cli_value, "endpoint")
    if value.get("id") != state["endpoint_id"] or value.get("name") != state["endpoint_name"] or value.get("image") != IMAGE:
        raise TrialError("Endpoint identity or image digest did not match")
    if value.get("type") != "QUEUE" or value.get("gpu", {}).get("count") != 2 or value.get("gpu", {}).get("pools") != ["HOPPER_141"]:
        raise TrialError("Endpoint GPU allocation or routing did not match")
    if value.get("gpu", {}).get("minCudaVersion") != "13.0":
        raise TrialError("Endpoint CUDA floor did not match")
    if value.get("workers") != {"min": 0, "max": 1, "idleTimeout": 60}:
        raise TrialError("Endpoint worker limits did not match")
    if value.get("scaling") != {"type": "QUEUE_DELAY", "queueDelay": 4} or value.get("timeout") != 600000 or value.get("flashboot") != "FLASHBOOT":
        raise TrialError("Endpoint scaling, timeout, or FlashBoot did not match")
    if value.get("networkVolumes"):
        raise TrialError("Unexpected network volume attachment")
    if any(value.get("env", {}).get(k) != v for k, v in ENV.items()):
        raise TrialError("Endpoint environment or pinned model path did not match")
    refs = cli_value.get("modelReferences")
    if refs != [MODEL_REFERENCE]:
        raise TrialError("Managed cache revision was missing or did not match exactly")
    return {key: value.get(key) for key in ("id", "name", "image", "gpu", "workers", "scaling", "timeout", "flashboot", "networkVolumes")}


def receipt_output(value):
    """Retain visible trial outputs and usage; exclude private reasoning and headers."""
    if not isinstance(value, dict):
        return {"format": type(value).__name__}
    if value.get("error"):
        error = value["error"]
        return {"error_type": error.get("type", "provider_error") if isinstance(error, dict) else "provider_error"}
    saved = {key: value[key] for key in ("id", "model", "created", "usage") if key in value}
    saved["choices"] = []
    for choice in value.get("choices", [])[:4]:
        message = choice.get("message") or {}
        saved["choices"].append({"finish_reason": choice.get("finish_reason"),
                                 "message": {key: message[key] for key in ("role", "content", "tool_calls") if key in message}})
    return saved


def load_state(directory, nonce=None):
    state = read_json(Path(directory) / "receipt.json")
    if state.get("owner") != OWNER or not re.fullmatch(r"[a-f0-9]{32}", state.get("nonce", "")):
        raise TrialError("Invalid trial ownership record")
    if nonce is not None and state["nonce"] != nonce:
        raise TrialError("Watchdog ownership mismatch")
    expected = "yur-franklin-trial-" + state["nonce"]
    if state.get("endpoint_name") != expected or state.get("template_name") != expected + "-template":
        raise TrialError("Invalid owned resource names")
    return state


def owned_resource(api, state, kind, identity):
    identity = resource_id(identity)
    if identity in state["preflight"]["existing_ids"][kind]:
        raise TrialError("Cleanup refused an existing resource")
    try:
        value = unwrap(api.request("GET", f"/{kind}/{identity}"), "endpoint" if kind == "serverless" else "template")
    except ApiError as exc:
        if exc.status == 404:
            return None
        raise
    name = state["endpoint_name" if kind == "serverless" else "template_name"]
    if value.get("id") != identity or value.get("name") != name or value.get("image") != IMAGE:
        raise TrialError("Cleanup refused resource identity/image mismatch")
    return value


def recover_created_id(api, state, kind):
    """Reconcile an uncertain create once; never repeat the create operation."""
    name = state["endpoint_name" if kind == "serverless" else "template_name"]
    matches = [x for x in api.list_resources(kind) if x.get("name") == name and x.get("image") == IMAGE
               and x.get("id") not in state["preflight"]["existing_ids"][kind]]
    if len(matches) > 1:
        raise TrialError("Ambiguous resource ownership; manual reconciliation required")
    return resource_id(matches[0]["id"]) if matches else None


def pid_running(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            status = wintypes.DWORD()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(status))) and status.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def cleanup(api, directory, nonce=None, clock=time.time, sleep=time.sleep):
    directory = Path(directory)
    state = load_state(directory, nonce)
    previous_path = directory / "cleanup.json"
    if previous_path.exists():
        previous = read_json(previous_path)
        if previous.get("owner") == OWNER and previous.get("nonce") == state["nonce"] and previous.get("status") == "complete":
            return previous
    lock = directory / "cleanup.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            previous = read_json(lock)
            if previous.get("nonce") != state["nonce"] or pid_running(previous.get("pid")):
                return {"status": "cleanup_already_owned"}
            lock.unlink()  # Recover only this trial's dead-process lock.
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except (OSError, ValueError):
            return {"status": "cleanup_already_owned"}
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump({"nonce": state["nonce"], "pid": os.getpid()}, stream)
    result = {"owner": OWNER, "nonce": state["nonce"], "started_at": clock(), "status": "incomplete",
              "worker_zero_verified": False, "endpoint_absent_verified": False, "template_absent_verified": False,
              "cancel_requested_jobs": [], "errors": []}
    atomic_json(directory / "abort.json", {"reason": "cleanup_started", "at": clock()})
    try:
        eid = state.get("endpoint_id")
        tid = state.get("template_id")
        if not eid and state.get("endpoint_create_attempted"):
            eid = recover_created_id(api, state, "serverless")
        if not tid and state.get("template_create_attempted"):
            tid = recover_created_id(api, state, "templates")
        result.update(endpoint_id=eid, template_id=tid)
        if eid:
            endpoint = owned_resource(api, state, "serverless", eid)
            if endpoint:
                try:
                    api.request("PATCH", f"/serverless/{eid}", {"workers": {"min": 0, "max": 0}})
                except TrialError as exc:
                    result["errors"].append(str(exc))
                for job in state.get("jobs", []):
                    if job.get("status") not in TERMINAL:
                        jid = resource_id(job["id"])
                        try:
                            api.request("POST", f"/{eid}/cancel/{jid}", invoke=True)
                            result["cancel_requested_jobs"].append(jid)
                        except TrialError as exc:
                            if not isinstance(exc, ApiError) or exc.status != 404:
                                result["errors"].append(str(exc))
                until = clock() + CLEANUP_RESERVE
                while clock() < until:
                    try:
                        workers = api.request("GET", f"/serverless/{eid}/workers")
                    except TrialError as exc:
                        result["errors"].append(str(exc))
                        break
                    if workers.get("summary", {}).get("total") == 0 and workers.get("workers") == []:
                        result["worker_zero_verified"] = True
                        break
                    sleep(3)
                # Deletion still occurs when scale-down cannot be verified; receipt stays incomplete.
                api.request("DELETE", f"/serverless/{eid}")
            result["endpoint_absent_verified"] = owned_resource(api, state, "serverless", eid) is None
        else:
            result["endpoint_absent_verified"] = not state.get("endpoint_create_attempted")
            result["worker_zero_verified"] = not state.get("endpoint_create_attempted")
        if tid and owned_resource(api, state, "templates", tid):
            api.request("DELETE", f"/templates/{tid}")
        result["template_absent_verified"] = (owned_resource(api, state, "templates", tid) is None) if tid else not state.get("template_create_attempted")
        complete = all(result[k] for k in ("worker_zero_verified", "endpoint_absent_verified", "template_absent_verified"))
        if complete and not result["errors"]:
            result["status"] = "complete"
    except TrialError as exc:
        result["errors"].append(str(exc))
    except Exception:
        result["errors"].append("Unexpected cleanup failure; inspect resource IDs manually")
    finally:
        result["finished_at"] = clock()
        atomic_json(directory / "cleanup.json", result)
        lock.unlink(missing_ok=True)
    return result


class Trial:
    def __init__(self, api, directory, preflight_result, clock=time.time, sleep=time.sleep):
        self.api, self.directory, self.clock, self.sleep = api, Path(directory), clock, sleep
        nonce = uuid.uuid4().hex
        self.state = {"owner": OWNER, "nonce": nonce, "created_at": clock(), "deadline": clock() + MAX_WALL_SECONDS,
                      "cleanup_at": clock() + MAX_WALL_SECONDS - CLEANUP_RESERVE, "status": "prepared",
                      "endpoint_name": "yur-franklin-trial-" + nonce, "template_name": "yur-franklin-trial-" + nonce + "-template",
                      "preflight": preflight_result, "jobs": [], "checks": [], "worker_observations": {},
                      "model_reference": MODEL_REFERENCE, "image": IMAGE, "target_budget_usd": 10}
        self.directory.mkdir(parents=True, exist_ok=False)
        self.save()

    def save(self):
        self.state["updated_at"] = self.clock()
        atomic_json(self.directory / "receipt.json", self.state)

    def guard(self):
        if self.clock() >= self.state["cleanup_at"] or (self.directory / "abort.json").exists():
            raise TrialError("Trial deadline/cleanup boundary reached")

    def provision(self):
        self.guard()
        self.state["template_create_attempted"] = True
        self.save()
        value = unwrap(self.api.request("POST", "/templates", template_body(self.state["template_name"])), "template")
        self.state["template_id"] = resource_id(value.get("id"))
        self.save()
        self.guard()
        self.state["endpoint_create_attempted"] = True
        self.save()
        value = unwrap(self.api.cli(create_arguments(self.state["template_id"], self.state["endpoint_name"])), "endpoint")
        self.state["endpoint_id"] = resource_id(value.get("id"))
        self.save()
        self.guard()
        eid = self.state["endpoint_id"]
        actual = self.api.request("GET", f"/serverless/{eid}")
        cli_value = self.api.cli(["serverless", "get", eid, "--include-template"])
        self.state["verified_configuration"] = verify_endpoint(actual, cli_value, self.state)
        self.state["status"] = "provisioned"
        self.save()

    def observe_workers(self):
        data = self.api.request("GET", f"/serverless/{self.state['endpoint_id']}/workers")
        if data.get("summary", {}).get("total", 0) > 1:
            raise TrialError("More than one worker observed")
        for worker in data.get("workers", []):
            wid = resource_id(worker.get("id"))
            if worker.get("status") == "UNHEALTHY" or worker.get("isStale"):
                raise TrialError("Unhealthy or stale worker observed; no replacement trial authorized")
            if worker.get("gpuCount") != 2 or worker.get("gpuTypeId") not in (None, "NVIDIA H200") or worker.get("image") not in (None, IMAGE):
                raise TrialError("Worker hardware or image mismatch")
            seen = self.state["worker_observations"]
            if seen and wid not in seen:
                raise TrialError("Worker replacement observed; no paid retry authorized")
            old = seen.get(wid, {})
            if old.get("startedAt") and worker.get("startedAt") != old["startedAt"]:
                raise TrialError("Worker restart observed; no paid retry authorized")
            seen[wid] = {k: worker.get(k) for k in ("id", "status", "gpuCount", "gpuTypeId", "image", "startedAt", "uptimeSeconds")}
        self.save()

    def submit(self, body, label):
        self.guard()
        # Persist intent before POST. An uncertain submit is never repeated.
        self.state["pending_submit"] = {"label": label, "at": self.clock()}
        self.save()
        eid = self.state["endpoint_id"]
        result = self.api.request("POST", f"/{eid}/run", {"input": {"openai_route": "/v1/chat/completions", "openai_input": body},
            "policy": {"executionTimeout": 600000, "ttl": 1800000}}, invoke=True)
        jid = resource_id(result.get("id"))
        job = {"id": jid, "label": label, "status": result.get("status", "IN_QUEUE"), "submitted_at": self.clock()}
        self.state["jobs"].append(job)
        self.state.pop("pending_submit", None)
        self.save()
        return job

    def wait_job(self, job, timeout=1200, expect_cancel=False):
        end = self.clock() + timeout
        eid = self.state["endpoint_id"]
        while self.clock() < end:
            self.guard()
            self.observe_workers()
            result = self.api.request("GET", f"/{eid}/status/{job['id']}", invoke=True)
            job["status"] = result.get("status", "UNKNOWN")
            self.save()
            if job["status"] in TERMINAL:
                job["finished_at"] = self.clock()
                job["delay_ms"] = result.get("delayTime")
                job["execution_ms"] = result.get("executionTime")
                output = result.get("output")
                if isinstance(output, list) and len(output) == 1:
                    output = output[0]
                # Only trial-generated content is retained; request/response headers and env are excluded.
                job["output"] = receipt_output(output)
                self.save()
                if expect_cancel:
                    if job["status"] != "CANCELLED":
                        raise TrialError("Cancellation did not produce a verified remote CANCELLED state")
                    return result
                if job["status"] != "COMPLETED" or not isinstance(output, dict) or output.get("error"):
                    raise TrialError("Inference did not complete successfully; no request retry")
                return output
            self.sleep(3)
        raise TrialError("Inference polling timed out; cleanup will cancel the retained remote job")

    def chat(self, messages, label, **extra):
        body = {"model": SERVED_MODEL, "messages": messages, "max_tokens": 512,
                "temperature": 0, "stream": False, "chat_template_kwargs": {"thinking": False}, **extra}
        output = self.wait_job(self.submit(body, label))
        try:
            return output["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            raise TrialError("No valid chat completion message") from None

    def accept(self):
        code = "FRANKLIN_" + self.state["nonce"][:12]
        messages = [{"role": "user", "content": f"Remember the validation code {code}. Reply with exactly that code."}]
        first = self.chat(messages, "cold_chat")
        if code not in (first.get("content") or ""):
            raise TrialError("Cold chat verification failed")
        messages.append(first)
        messages.append({"role": "user", "content": "Call report_trial_value with the integer 17. After receiving the tool result, state its value."})
        tool = {"type": "function", "function": {"name": "report_trial_value", "description": "Report an inert test value; no external side effects.",
                "parameters": {"type": "object", "properties": {"value": {"type": "integer", "const": 17}}, "required": ["value"], "additionalProperties": False}}}
        called = self.chat(messages, "typed_tool", tools=[tool], tool_choice={"type": "function", "function": {"name": "report_trial_value"}})
        calls = called.get("tool_calls", [])
        if len(calls) != 1 or calls[0].get("function", {}).get("name") != "report_trial_value" or not calls[0].get("id"):
            raise TrialError("Typed tool call identity failed")
        try:
            arguments = json.loads(calls[0]["function"]["arguments"])
        except (ValueError, KeyError, TypeError):
            raise TrialError("Tool arguments are not valid JSON") from None
        if arguments != {"value": 17} or type(arguments.get("value")) is not int:
            raise TrialError("Typed tool arguments did not match the inert contract")
        messages += [called, {"role": "tool", "tool_call_id": calls[0]["id"], "content": '{"value":17,"receipt":"inert-local-test"}'}]
        after = self.chat(messages, "tool_result")
        if not re.search(r"\b17\b", after.get("content") or ""):
            raise TrialError("Tool-result roundtrip failed")
        messages += [after, {"role": "user", "content": "What was the original validation code? Return it exactly."}]
        followup = self.chat(messages, "multi_turn")
        if code not in (followup.get("content") or ""):
            raise TrialError("Multi-turn recall verification failed")
        cancellation = self.submit({"model": SERVED_MODEL, "messages": [{"role": "user", "content": "Count upwards from one, one number per line, continuing for at least 3000 numbers."}],
                                    "max_tokens": 4096, "stream": False, "chat_template_kwargs": {"thinking": False}}, "remote_cancel")
        self.api.request("POST", f"/{self.state['endpoint_id']}/cancel/{cancellation['id']}", invoke=True)
        self.wait_job(cancellation, timeout=60, expect_cancel=True)
        self.state["checks"] = ["real_chat", "typed_tool_arguments", "tool_result_roundtrip", "multi_turn", "remote_cancel"]
        self.state["status"] = "acceptance_passed_pending_cleanup"
        self.save()


def start_watchdog(trial, cli):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    with (trial.directory / "watchdog.log").open("a", encoding="utf-8") as log:
        proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--watchdog", str(trial.directory),
                                 "--nonce", trial.state["nonce"], "--cli", str(cli)], stdin=subprocess.DEVNULL,
                                stdout=log, stderr=log, creationflags=flags, close_fds=True)
    until = time.time() + 10
    while time.time() < until:
        if (trial.directory / "watchdog-ready.json").exists() and proc.poll() is None:
            trial.state["watchdog_pid"] = proc.pid
            trial.save()
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.1)
    raise TrialError("Independent cleanup watchdog failed to start; allocation refused")


def watchdog(api, directory, nonce, clock=time.time, sleep=time.sleep):
    state = load_state(directory, nonce)
    atomic_json(Path(directory) / "watchdog-ready.json", {"owner": OWNER, "nonce": nonce, "pid": os.getpid()})
    while clock() < state["cleanup_at"]:
        if (Path(directory) / "cleanup.json").exists():
            return 0 if read_json(Path(directory) / "cleanup.json").get("status") == "complete" else 2
        if (Path(directory) / "abort.json").exists():
            break
        sleep(min(5, max(0.1, state["cleanup_at"] - clock())))
    while True:
        result = cleanup(api, directory, nonce, clock, sleep)
        if result.get("status") != "cleanup_already_owned":
            return 0 if result.get("status") == "complete" else 2
        # Stay available if the parent's cleanup dies while holding its lock.
        if (Path(directory) / "cleanup.json").exists():
            return 0 if read_json(Path(directory) / "cleanup.json").get("status") == "complete" else 2
        sleep(3)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--execute-approved-trial", action="store_true", help="BILLABLE: use only after explicit owner approval")
    mode.add_argument("--check", action="store_true", help="Read-only CLI, price, availability, inventory checks")
    parser.add_argument("--cli", type=Path, default=Path(os.environ.get("TEMP", ".")) / "yur-runpod-tools-2.14.0" / "runpodctl.exe")
    parser.add_argument("--receipt-root", type=Path, default=Path(__file__).resolve().parents[3] / "evidence" / "glider-rc6" / "comprehensive" / "franklin-serverless-trials")
    parser.add_argument("--watchdog", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--nonce", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.watchdog:
        if not args.nonce or args.execute_approved_trial or args.check:
            raise TrialError("Invalid watchdog invocation")
        return watchdog(RunPod(args.cli), args.watchdog, args.nonce)
    if not args.execute_approved_trial and not args.check:
        print(json.dumps({"mode": "proposal_only", "billable_actions": 0, "model": MODEL, "revision": REVISION,
                          "image": IMAGE, "gpu_count": 2, "min_workers": 0, "max_workers": 1,
                          "price_ceiling_usd_hour": PRICE_LIMIT, "wall_minutes": 45, "target_budget_usd": 10,
                          "note": "No API calls. --check is read-only; execution requires --execute-approved-trial after owner approval."}, indent=2))
        return 0
    api = RunPod(args.cli)
    checked = preflight(api)
    if args.check and not args.execute_approved_trial:
        print(json.dumps({"mode": "read_only", "cli": checked["cli"], "price_per_worker_hour": checked["price_per_worker_hour"],
                          "gpu_availability": checked["gpu_availability"], "billable_actions": 0}, indent=2))
        return 0
    directory = args.receipt_root / (time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:12])
    trial = Trial(api, directory, checked)
    try:
        start_watchdog(trial, args.cli)
        trial.provision()
        trial.accept()
    except (TrialError, KeyboardInterrupt) as exc:
        trial.state["status"] = "failed"
        trial.state["failure"] = str(exc) if isinstance(exc, TrialError) else "Interrupted by operator"
        trial.save()
    except Exception:
        trial.state["status"] = "failed"
        trial.state["failure"] = "Unexpected trial error; no automatic retry"
        trial.save()
    finally:
        result = cleanup(api, directory, trial.state["nonce"])
        if result["status"] == "cleanup_already_owned":
            until = time.time() + CLEANUP_RESERVE + 60
            while time.time() < until and not (directory / "cleanup.json").exists():
                time.sleep(1)
            if (directory / "cleanup.json").exists():
                result = read_json(directory / "cleanup.json")
    if trial.state["status"] == "acceptance_passed_pending_cleanup" and result["status"] == "complete":
        trial.state["status"] = "acceptance_passed"
        trial.save()
    print(json.dumps({"receipt_directory": str(directory), "trial_status": trial.state["status"], "cleanup_status": result["status"]}, indent=2))
    return 0 if trial.state["status"] == "acceptance_passed" and result["status"] == "complete" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except TrialError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
