"""Offline lifecycle/authority/failure tests. Never contact RunPod or start GPUs."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "scripts" / "franklin_serverless_trial.py"
spec = importlib.util.spec_from_file_location("franklin_trial", MODULE)
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.resources = {"templates": {}, "serverless": {}}
        self.price = 5.93
        self.references = [trial.MODEL_REFERENCE]
        self.worker_rows = []
        self.zero_after_scale = True
        self.create_uncertain = False
        self.job_statuses = {}
        self.next_outputs = []
        self.cli_count = 0

    def verify_cli(self):
        return "runpodctl 2.14.0-dd55bcf"

    def list_resources(self, kind):
        return list(self.resources[kind].values())

    def cli(self, args, timeout=120):
        self.calls.append(("CLI", args))
        if args[1] == "get":
            return {"id": "e1", "modelReferences": self.references}
        self.cli_count += 1
        name = args[args.index("--name") + 1]
        self.resources["serverless"]["e1"] = {
            "id": "e1", "name": name, "image": trial.IMAGE, "type": "QUEUE",
            "gpu": {"pools": ["HOPPER_141"], "count": 2, "minCudaVersion": "13.0"},
            "workers": {"min": 0, "max": 1, "idleTimeout": 60},
            "scaling": {"type": "QUEUE_DELAY", "queueDelay": 4}, "timeout": 600000,
            "flashboot": "FLASHBOOT", "networkVolumes": [], "env": copy.deepcopy(trial.ENV),
        }
        if self.create_uncertain:
            raise trial.TrialError("uncertain create")
        return {"id": "e1"}

    def request(self, method, path, body=None, invoke=False):
        self.calls.append((method, path, copy.deepcopy(body)))
        if path.startswith("/catalog/gpus/"):
            return {"price": {"serverless": self.price}, "pool": "HOPPER_141", "availability": "MEDIUM"}
        if invoke:
            parts = path.strip("/").split("/")
            if parts[1] == "run":
                jid = "j" + str(len(self.job_statuses) + 1)
                output = self.next_outputs.pop(0) if self.next_outputs else {"choices": [{"message": {"role": "assistant", "content": "test"}}]}
                self.job_statuses[jid] = {"id": jid, "status": "COMPLETED", "output": [output]}
                return {"id": jid, "status": "IN_QUEUE"}
            jid = parts[2]
            if parts[1] == "cancel":
                self.job_statuses[jid] = {"id": jid, "status": "CANCELLED"}
            return self.job_statuses[jid]
        parts = path.strip("/").split("/")
        kind = parts[0]
        if method == "POST" and kind == "templates":
            self.resources[kind]["t1"] = {"id": "t1", **body}
            return {"id": "t1"}
        identity = parts[1]
        if identity not in self.resources[kind]:
            raise trial.ApiError(404)
        if len(parts) == 3 and parts[2] == "workers":
            return {"workers": self.worker_rows, "summary": {"total": len(self.worker_rows)}}
        if method == "GET":
            return self.resources[kind][identity]
        if method == "PATCH":
            self.resources[kind][identity].update(body)
            if self.zero_after_scale:
                self.worker_rows = []
            return self.resources[kind][identity]
        if method == "DELETE":
            del self.resources[kind][identity]
            return {}
        raise AssertionError((method, path))


class TrialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.api, self.clock = FakeAPI(), Clock()
        self.directory = Path(self.temp.name) / "trial"
        self.run = trial.Trial(self.api, self.directory, trial.preflight(self.api), self.clock, self.clock.sleep)

    def cleanup_trial(self):
        return trial.cleanup(self.api, self.directory, self.run.state["nonce"], self.clock, self.clock.sleep)

    def test_default_is_local_proposal_without_api_access(self):
        with patch.object(trial, "RunPod", side_effect=AssertionError("API created")), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(trial.main([]), 0)
        self.assertEqual(json.loads(out.getvalue())["billable_actions"], 0)

    def test_price_refresh_refuses_higher_or_unavailable_price(self):
        for price in (5.94, None, True, -1):
            self.api.price = price
            with self.assertRaises(trial.TrialError):
                trial.preflight(self.api)
        self.assertFalse(any(x[0] in {"POST", "PATCH", "DELETE"} for x in self.api.calls))

    def test_exact_pinned_configuration_and_cache_flags(self):
        self.run.provision()
        args = next(x[1] for x in self.api.calls if x[0] == "CLI" and x[1][1] == "create")
        for flag, value in (("--gpu-count", "2"), ("--workers-min", "0"), ("--workers-max", "1"),
                            ("--model-reference", trial.MODEL_REFERENCE), ("--idle-timeout", "60")):
            self.assertEqual(args[args.index(flag) + 1], value)
        self.assertEqual(self.run.state["verified_configuration"]["image"], trial.IMAGE)
        self.assertEqual(self.cleanup_trial()["status"], "complete")

    def test_revision_failure_cleans_up_without_inference(self):
        self.api.references = [trial.MODEL_REFERENCE.replace(trial.REVISION, "main")]
        with self.assertRaisesRegex(trial.TrialError, "cache revision"):
            self.run.provision()
        result = self.cleanup_trial()
        self.assertEqual(result["status"], "complete")
        self.assertFalse(any(x[0] == "POST" and str(x[1]).endswith("/run") for x in self.api.calls))
        self.assertEqual(self.api.cli_count, 1)

    def test_worker_limits_or_image_mismatch_is_rejected(self):
        self.run.provision()
        endpoint = self.api.resources["serverless"]["e1"]
        for field, value in (("workers", {"min": 1, "max": 2, "idleTimeout": 60}), ("image", "other:latest")):
            changed = {**endpoint, field: value}
            with self.assertRaises(trial.TrialError):
                trial.verify_endpoint(changed, {"modelReferences": self.api.references}, self.run.state)

    def test_uncertain_create_reconciles_unique_owned_resource_once(self):
        self.api.create_uncertain = True
        with self.assertRaisesRegex(trial.TrialError, "uncertain"):
            self.run.provision()
        self.assertNotIn("endpoint_id", self.run.state)
        result = self.cleanup_trial()
        self.assertEqual(result["endpoint_id"], "e1")
        self.assertEqual(result["status"], "complete")
        self.assertEqual(self.api.cli_count, 1)

    def test_cleanup_refuses_preexisting_or_identity_changed_resources(self):
        self.run.provision()
        self.run.state["preflight"]["existing_ids"]["serverless"].append("e1")
        self.run.save()
        result = self.cleanup_trial()
        self.assertEqual(result["status"], "incomplete")
        self.assertIn("e1", self.api.resources["serverless"])
        self.assertFalse(any(x[0] == "DELETE" for x in self.api.calls))

    def test_startup_error_is_not_a_success_or_automatically_retried(self):
        self.run.provision()
        self.api.next_outputs = [{"error": {"type": "startup_error", "message": "out of memory"}}]
        with self.assertRaises(trial.TrialError):
            self.run.chat([{"role": "user", "content": "hello"}], "startup")
        self.assertEqual(len(self.run.state["jobs"]), 1)
        self.assertEqual(self.cleanup_trial()["status"], "complete")

    def test_timeout_retains_remote_job_and_requests_cancel_before_delete(self):
        self.run.provision()
        job = self.run.submit({"model": trial.SERVED_MODEL, "messages": []}, "timeout")
        self.api.job_statuses[job["id"]] = {"status": "IN_QUEUE"}
        with self.assertRaisesRegex(trial.TrialError, "timed out"):
            self.run.wait_job(job, timeout=4)
        result = self.cleanup_trial()
        self.assertEqual(result["cancel_requested_jobs"], [job["id"]])
        self.assertEqual(self.api.job_statuses[job["id"]]["status"], "CANCELLED")
        self.assertEqual(result["status"], "complete")

    def test_typed_tool_roundtrip_multiturn_and_remote_cancel(self):
        self.run.provision()
        code = "FRANKLIN_" + self.run.state["nonce"][:12]
        self.api.next_outputs = [
            {"choices": [{"message": {"role": "assistant", "content": code}}]},
            {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call1", "type": "function", "function": {"name": "report_trial_value", "arguments": '{"value":17}'}}]}}]},
            {"choices": [{"message": {"role": "assistant", "content": "The value is 17."}}]},
            {"choices": [{"message": {"role": "assistant", "content": code}}]},
        ]
        self.run.accept()
        self.assertEqual(self.run.state["checks"], ["real_chat", "typed_tool_arguments", "tool_result_roundtrip", "multi_turn", "remote_cancel"])
        self.assertEqual(len(self.run.state["jobs"]), 5)
        self.assertEqual(self.run.state["jobs"][-1]["status"], "CANCELLED")
        self.assertEqual(self.cleanup_trial()["status"], "complete")

    def test_worker_replacement_stops_trial(self):
        self.run.provision()
        base = {"id": "w1", "status": "RUNNING", "gpuCount": 2, "image": trial.IMAGE, "gpuTypeId": "NVIDIA H200", "startedAt": "first"}
        self.api.worker_rows = [base]
        self.run.observe_workers()
        self.api.worker_rows = [{**base, "id": "w2"}]
        with self.assertRaisesRegex(trial.TrialError, "replacement"):
            self.run.observe_workers()
        self.assertEqual(self.cleanup_trial()["status"], "complete")

    def test_no_false_cleanup_success_without_zero_worker_readback(self):
        self.run.provision()
        self.api.zero_after_scale = False
        self.api.worker_rows = [{"id": "w1", "status": "RUNNING"}]
        result = self.cleanup_trial()
        self.assertEqual(result["status"], "incomplete")
        self.assertFalse(result["worker_zero_verified"])
        self.assertTrue(result["endpoint_absent_verified"])
        self.assertNotIn("e1", self.api.resources["serverless"])

    def test_watchdog_deadline_owns_cleanup_independently(self):
        self.run.provision()
        self.clock.now = self.run.state["cleanup_at"]
        status = trial.watchdog(self.api, self.directory, self.run.state["nonce"], self.clock, self.clock.sleep)
        self.assertEqual(status, 0)
        self.assertEqual(trial.read_json(self.directory / "cleanup.json")["status"], "complete")
        self.assertEqual(self.api.resources["serverless"], {})

    def test_watchdog_rejects_wrong_nonce_and_deadline_prevents_allocations(self):
        with self.assertRaises(trial.TrialError):
            trial.watchdog(self.api, self.directory, "wrong", self.clock, self.clock.sleep)
        self.clock.now = self.run.state["cleanup_at"]
        with self.assertRaises(trial.TrialError):
            self.run.provision()
        self.assertFalse(any(x[0] == "POST" for x in self.api.calls))

    def test_network_routes_cannot_mutate_media_pods_or_volumes(self):
        api = trial.RunPod("unused", key="secret-placeholder")
        with patch.object(trial, "urlopen", side_effect=AssertionError("network reached")):
            for path in ("/pods/abcdefghijklmn", "/volumes/media", "/account/secrets"):
                with self.assertRaises(trial.TrialError):
                    api.request("DELETE", path)

    def test_cli_failure_never_prints_secret_output(self):
        api = trial.RunPod("unused", key="secret-placeholder")
        response = type("Response", (), {"returncode": 1, "stdout": "secret-placeholder", "stderr": "secret-placeholder"})()
        with patch.object(trial.subprocess, "run", return_value=response):
            with self.assertRaises(trial.TrialError) as raised:
                api.cli(["serverless", "get", "fixture"])
        self.assertNotIn("secret-placeholder", str(raised.exception))

    def test_cleanup_is_idempotent_and_retains_zero_worker_proof(self):
        self.run.provision()
        first = self.cleanup_trial()
        call_count = len(self.api.calls)
        second = self.cleanup_trial()
        self.assertEqual(first, second)
        self.assertEqual(second["status"], "complete")
        self.assertEqual(len(self.api.calls), call_count)

    def test_cleanup_recovers_dead_process_lock_only_with_own_nonce(self):
        self.run.provision()
        trial.atomic_json(self.directory / "cleanup.lock", {"nonce": self.run.state["nonce"], "pid": 999999})
        with patch.object(trial, "pid_running", return_value=False):
            self.assertEqual(self.cleanup_trial()["status"], "complete")

    def test_receipt_excludes_private_reasoning_and_provider_headers(self):
        output = {"model": "test", "usage": {"total_tokens": 12}, "headers": {"Authorization": "secret"},
                  "choices": [{"message": {"role": "assistant", "content": "visible", "reasoning_content": "private"}}]}
        saved = json.dumps(trial.receipt_output(output))
        self.assertIn("visible", saved)
        self.assertNotIn("private", saved)
        self.assertNotIn("secret", saved)

    def test_windows_pid_probe_identifies_current_process(self):
        self.assertTrue(trial.pid_running(trial.os.getpid()))
        self.assertFalse(trial.pid_running(-1))

    def test_real_hidden_watchdog_process_finishes_empty_trial_without_network(self):
        # No create intents/IDs exist, so the child has no reason to issue an API request.
        # A deliberately unusable API key also prevents accidental real resource access.
        standalone = trial.Trial(self.api, Path(self.temp.name) / "watchdog-process", trial.preflight(self.api))
        standalone.state["cleanup_at"] = trial.time.time() + 1.5
        standalone.save()
        with patch.dict(trial.os.environ, {"RUNPOD_API_KEY": "offline-test-no-auth"}):
            process = trial.start_watchdog(standalone, "unused-cli-no-provision")
        self.assertEqual(process.wait(timeout=10), 0)
        result = trial.read_json(standalone.directory / "cleanup.json")
        self.assertEqual(result["status"], "complete")
        self.assertIsNone(result["endpoint_id"])
        self.assertIsNone(result["template_id"])


if __name__ == "__main__":
    unittest.main()
