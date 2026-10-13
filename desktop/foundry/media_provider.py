"""Bounded ComfyUI execution-cell adapter, derived from the Music Studio donor.

Connectors acquire responses. They neither select workflows nor persist state.
"""
from __future__ import annotations
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from .media_contracts import MAX_ASSET, MAX_INPUT, endpoint, identity


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Media provider redirects are forbidden")


class RejectedRequest(ValueError):
    """Provider definitively rejected the graph; no accepted job is known."""


class ComfyMedia:
    id = "comfy-media"

    def __init__(self, url):
        self.url = endpoint(url)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def exchange(self, path, body=None, *, raw_body=None, content_type="application/json", binary=False, timeout=20):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Invalid provider path")
        headers = {"Content-Type": content_type, "Accept": "*/*" if binary else "application/json",
                   "User-Agent": "YUR-AI-Desktop/1.0 (ComfyUI media client)"}
        # Optional secret stays in the process environment, never runtime config.
        token = os.getenv("YUR_MEDIA_PROVIDER_TOKEN", "")
        if token:
            headers["Authorization"] = "Bearer " + token
        data = raw_body if raw_body is not None else None if body is None else json.dumps(body, allow_nan=False).encode()
        req = urllib.request.Request(self.url + path, data, headers)
        limit = MAX_ASSET if binary else 4 * 1024 * 1024
        try:
            with self.opener.open(req, timeout=timeout) as response:
                raw = response.read(limit + 1)
        except urllib.error.HTTPError as exc:
            # Never expose provider response bodies, which may echo prompts/tokens.
            if exc.code in {400, 422}:
                raise RejectedRequest(f"Media provider rejected request (HTTP {exc.code})") from None
            raise ConnectionError(f"Media provider returned HTTP {exc.code}") from None
        except urllib.error.URLError:
            raise ConnectionError("Media provider connection failed; saved receipts remain available") from None
        if len(raw) > limit:
            raise ValueError("Media provider response exceeded its byte budget")
        return raw if binary else json.loads(raw)

    def health(self, graphs):
        self.exchange("/system_stats", timeout=8)
        requirements = {}
        for graph in graphs:
            for node in graph.values():
                requirements.setdefault(node["class_type"], []).append(node["inputs"])
        missing = []
        for kind, inputs_list in requirements.items():
            info = self.exchange("/object_info/" + urllib.parse.quote(kind, safe=""), timeout=8)
            if kind not in info:
                missing.append(kind)
                continue
            required = info[kind].get("input", {}).get("required", {})
            for field in ("unet_name", "clip_name", "vae_name"):
                expected = {inputs[field] for inputs in inputs_list if field in inputs}
                options = required.get(field, [[]])[0]
                for model in expected:
                    if not isinstance(options, list) or model not in options:
                        missing.append(model)
        return {"ready": not missing, "missing": sorted(set(missing)), "provider": self.id}

    def upload(self, raw, validation, job_id):
        identity(job_id)
        if len(raw) > MAX_INPUT or validation["kind"] != "image":
            raise ValueError("Input image exceeds its byte budget")
        name = f"yur-{job_id}.{validation['extension']}"
        boundary = "yur-media-" + uuid.uuid4().hex
        part = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: {validation['mime']}\r\n\r\n").encode() + raw + b"\r\n"
        part += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n--{boundary}--\r\n").encode()
        result = self.exchange("/upload/image", raw_body=part, content_type="multipart/form-data; boundary=" + boundary, timeout=60)
        returned = result.get("name", "")
        subfolder = result.get("subfolder", "")
        if (result.get("type", "input") != "input" or subfolder or not isinstance(returned, str)
                or not re.fullmatch(r"yur-" + job_id + r"(?: \(\d+\))?\.(?:png|jpg|webp)", returned)):
            raise ValueError("Provider returned an unexpected uploaded image identity")
        return returned

    def submit(self, graph, job_id, workflow_sha256):
        identity(job_id)
        result = self.exchange("/prompt", {"prompt": graph, "client_id": "yur-desktop-" + job_id,
                                         "extra_data": {"yur_media_job": job_id, "workflow_sha256": workflow_sha256}}, timeout=30)
        prompt_id = result.get("prompt_id")
        if result.get("node_errors") or not isinstance(prompt_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", prompt_id):
            raise RejectedRequest("ComfyUI did not accept the admitted media workflow")
        return prompt_id

    def inspect(self, prompt_id):
        if not isinstance(prompt_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", prompt_id):
            raise ValueError("Invalid provider receipt")
        history = self.exchange("/history/" + urllib.parse.quote(prompt_id, safe=""))
        record = history.get(prompt_id)
        if record:
            if record.get("status", {}).get("status_str") == "error":
                return {"state": "failed", "error": "The media execution cell reported a generation error"}
            if record.get("status", {}).get("completed"):
                return {"state": "ready", "outputs": record.get("outputs", {})}
        queue = self.exchange("/queue")
        for key, state in (("queue_running", "running"), ("queue_pending", "queued")):
            if any(isinstance(row, list) and len(row) > 1 and row[1] == prompt_id for row in queue.get(key, [])):
                return {"state": state}
        return {"state": "unresolved", "notice": "Receipt saved; provider no longer lists this job. Resume never submits it again."}

    def reconcile(self, job_id, workflow_sha256):
        """Recover an accepted receipt after a timeout without another POST."""
        identity(job_id)
        def matching(row):
            return (isinstance(row, list) and len(row) >= 4 and isinstance(row[3], dict)
                    and row[3].get("yur_media_job") == job_id and row[3].get("workflow_sha256") == workflow_sha256)
        queue = self.exchange("/queue")
        matches = {row[1] for key in ("queue_running", "queue_pending") for row in queue.get(key, []) if matching(row)}
        history = self.exchange("/history?max_items=200")
        matches.update(key for key, record in history.items() if matching(record.get("prompt")))
        if len(matches) > 1:
            raise ValueError("More than one remote receipt matches this job; manual provider review required")
        return next(iter(matches), None)

    def outputs(self, remote, output_node, job_id, kind):
        expected = remote.get("outputs", {}).get(output_node, {})
        items = expected.get("images", []) if kind == "image" else expected.get("images", expected.get("gifs", expected.get("videos", [])))
        if not isinstance(items, list) or not 1 <= len(items) <= 4:
            raise ValueError("Expected 1..4 generated media assets from the admitted output node")
        result = []
        for item in items:
            name = item.get("filename", "")
            if (item.get("type") != "output" or item.get("subfolder") != "yur-desktop"
                    or not isinstance(name, str) or not name.startswith(job_id + "_")
                    or "/" in name or "\\" in name or ".." in name):
                raise ValueError("Output identity does not belong to this media job")
            query = urllib.parse.urlencode({"filename": name, "subfolder": "yur-desktop", "type": "output"})
            result.append({"bytes": self.exchange("/view?" + query, binary=True, timeout=90), "remote": {"filename": name, "subfolder": "yur-desktop", "type": "output"}})
        return result

    def cancel_queued(self, prompt_id):
        state = self.inspect(prompt_id)["state"]
        if state != "queued":
            return {"cancelled": False, "state": state, "notice": "Only this job while queued can be cancelled. Running jobs are preserved; no global interrupt is sent."}
        self.exchange("/queue", {"delete": [prompt_id]})
        after = self.inspect(prompt_id)["state"]
        return {"cancelled": after == "unresolved", "state": after,
                "notice": "Queued job removed" if after == "unresolved" else "Job started before removal; it remains available for completion"}
