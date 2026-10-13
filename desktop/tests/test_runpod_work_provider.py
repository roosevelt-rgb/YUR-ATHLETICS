"""Owned local HTTP queue fixture; no RunPod API, model or billable requests."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.franklin_cli import handle, model_adapter_for, validate_rpc
from foundry.runpod_work_provider import (RunPodWorkCancelled, RunPodWorkError,
                                         create_model_adapter, normalize_endpoint)
from foundry.work_desktop import HOST_AUTHORITY
from foundry.work_provider import MAX_RESPONSE_BYTES, native_tools

ENDPOINT = "https://api.runpod.ai/v2/owned-fixture-endpoint"
PREFIX = "/v2/owned-fixture-endpoint"
JOB = "owned-job-1"
KEY = "TEST-CREDENTIAL-MUST-NOT-PERSIST"
CATALOG = [{"name": "lookup_fact", "description": "Read one owned fixture fact", "input_schema": {
    "type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": False}}]
MESSAGES = [{"role": "user", "content": "Read the fixture fact"}]


def completion(content="Fixture fact received", calls=None):
    return {"choices": [{"finish_reason": "tool_calls" if calls else "stop", "message": {
        "role": "assistant", "content": content, "tool_calls": calls,
        "reasoning_content": "PRIVATE-REASONING-MUST-NOT-PERSIST"}}]}


def call(arguments='{"name":"fixture"}'):
    return {"id": "call_fixture", "type": "function", "function": {"name": "lookup_fact", "arguments": arguments}}


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.requests, self.events, self.responses = [], [], {}
        self.remote_cancelled, self.cancel_state, self.slow_path = False, "CANCELLED", None
        suite = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def serve(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                suite.requests.append({"method": self.command, "path": self.path,
                                       "headers": dict(self.headers), "body": json.loads(raw) if raw else None})
                if self.path == PREFIX + "/cancel/" + JOB:
                    suite.remote_cancelled = True
                selected = suite.responses.get((self.command, self.path))
                if selected:
                    response = selected.pop(0) if len(selected) > 1 else selected[0]
                elif self.command == "POST" and self.path.endswith("/run"):
                    response = {"id": JOB, "status": "IN_QUEUE"}
                elif "/cancel/" in self.path:
                    response = {"id": JOB, "status": "CANCELLED"}
                elif suite.remote_cancelled:
                    response = {"id": JOB, "status": suite.cancel_state}
                else:
                    response = {"id": JOB, "status": "COMPLETED", "output": [completion()]}
                status, body = response if isinstance(response, tuple) else (200, response)
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Location", "https://unapproved.example/steal")
                if self.path != suite.slow_path:
                    self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    if self.path == suite.slow_path:
                        for _ in range(100):
                            self.wfile.write(b" "); self.wfile.flush(); time.sleep(.01)
                    else:
                        self.wfile.write(raw)
                except OSError:
                    pass

            do_GET = do_POST = serve

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

        def connection(host, **kwargs):
            self.assertEqual(host, "api.runpod.ai")
            return http.client.HTTPConnection("127.0.0.1", self.server.server_port, **kwargs)

        self.http = patch("foundry.runpod_work_provider.http.client.HTTPSConnection", side_effect=connection)
        self.http.start(); self.addCleanup(self.http.stop)

    def adapter(self, **options):
        return create_model_adapter("exact-host-served-model", ENDPOINT, KEY, poll_seconds=.01,
                                    cancel_timeout_seconds=.1, on_job=self.events.append, **options)

    def ask(self, **options):
        return self.adapter(**options)(MESSAGES, CATALOG)

    def test_exact_worker_payload_and_public_response_reuse(self):
        result = self.ask()
        self.assertEqual(result, {"content": "Fixture fact received", "tool_calls": []})
        request = self.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", PREFIX + "/run"))
        self.assertEqual(request["headers"]["Authorization"], "Bearer " + KEY)
        self.assertEqual(request["body"]["policy"], {"executionTimeout": 600000, "ttl": 1800000})
        worker = request["body"]["input"]
        self.assertEqual(worker["openai_route"], "/v1/chat/completions")
        self.assertEqual(worker["openai_input"]["tools"], native_tools(CATALOG))
        self.assertEqual(worker["openai_input"]["model"], "exact-host-served-model")
        self.assertFalse(worker["openai_input"]["stream"])
        self.assertEqual(worker["openai_input"]["max_tokens"], 4096)
        self.assertNotIn(KEY, json.dumps(request["body"]))
        self.assertNotIn("PRIVATE-REASONING", json.dumps([result, self.events]))
        self.assertEqual([e["phase"] for e in self.events], ["submit_intent", "accepted", "status", "terminal", "validated"])

    def test_native_tool_roundtrip_preserves_id_and_validates_registered_schema(self):
        self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": "COMPLETED", "output": completion(None, [call()])}]
        adapter = self.adapter()
        result = adapter(MESSAGES, CATALOG)
        self.assertEqual(result["tool_calls"][0]["function"]["arguments"], {"name": "fixture"})
        messages = [*MESSAGES, {"role": "assistant", **result}, {"role": "tool", "tool_name": "lookup_fact", "content": "actual bounded result"}]
        self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": "COMPLETED", "output": completion()}]
        adapter(messages, CATALOG)
        request = [r for r in self.requests if r["path"].endswith("/run")][-1]
        self.assertEqual(request["body"]["input"]["openai_input"]["messages"][-1]["tool_call_id"], "call_fixture")
        self.assertEqual(len([r for r in self.requests if r["path"].endswith("/run")]), 2)

    def test_unknown_tool_and_invalid_argument_json_fail_after_one_completed_job(self):
        variants = [call('{"name":"a","name":"b"}'), call('{"name":NaN}'), call('{"name":3}')]
        unknown = call(); unknown["function"]["name"] = "unadmitted_tool"; variants.append(unknown)
        for item in variants:
            self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": "COMPLETED", "output": completion(None, [item])}]
            with self.subTest(item=item), self.assertRaises(RunPodWorkError):
                self.ask()
        self.assertFalse(any("/cancel/" in r["path"] for r in self.requests))

    def test_https_allowlist_rejects_credentials_wrong_host_paths_ports_and_encoded_ids(self):
        bad = ["http://api.runpod.ai/v2/a", "https://api.runpod.ai.evil/v2/a", "https://api.runpod.ai:443/v2/a",
               "https://secret@api.runpod.ai/v2/a", ENDPOINT + "?key=secret", ENDPOINT + "#fragment",
               ENDPOINT + "/run", "https://api.runpod.ai/v2/%2e%2e", "https://api.runpod.ai/v2/../a",
               "https://127.0.0.1/v2/a", "https://api.runpod.ai/v2/a\\b"]
        for endpoint in bad:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                normalize_endpoint(endpoint)
        self.assertEqual(normalize_endpoint(ENDPOINT + "/"), ENDPOINT)
        self.assertEqual(self.requests, [])

    def test_missing_credential_invalid_deadline_and_orphan_history_make_no_requests(self):
        for key in (None, "", "bad\nkey"):
            with self.assertRaises(ValueError):
                create_model_adapter("model", ENDPOINT, key)
        for timeout in (False, 0, float("nan"), 1201):
            with self.assertRaises(ValueError):
                self.adapter(timeout_seconds=timeout)
        with self.assertRaises(ValueError):
            self.adapter()([{"role": "tool", "tool_name": "lookup_fact", "content": "orphan"}], CATALOG)
        self.assertEqual(self.requests, [])

    def test_cancel_before_submit_makes_zero_calls(self):
        with self.assertRaises(RunPodWorkCancelled):
            self.ask(is_cancelled=lambda: True)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.events, [])

    def test_durable_intent_failure_prevents_submit(self):
        def refuse(event):
            raise ValueError("owned commit unavailable")
        adapter = create_model_adapter("model", ENDPOINT, KEY, on_job=refuse)
        with self.assertRaises(ValueError):
            adapter(MESSAGES, CATALOG)
        self.assertEqual(self.requests, [])

    def test_user_cancel_posts_only_known_job_then_checks_confirmation(self):
        cancelled = [False]
        def receipt(event):
            self.events.append(event)
            if event["phase"] == "accepted":
                cancelled[0] = True
        adapter = create_model_adapter("model", ENDPOINT, KEY, on_job=receipt, is_cancelled=lambda: cancelled[0],
                                       poll_seconds=.01, cancel_timeout_seconds=.1)
        with self.assertRaises(RunPodWorkCancelled):
            adapter(MESSAGES, CATALOG)
        self.assertEqual([(r["method"], r["path"]) for r in self.requests],
                         [("POST", PREFIX + "/run"), ("POST", PREFIX + "/cancel/" + JOB), ("GET", PREFIX + "/status/" + JOB)])
        self.assertTrue(self.events[-1]["cancel_confirmed"])

    def test_cancel_ack_does_not_claim_cancel_when_status_completed(self):
        self.cancel_state = "COMPLETED"
        adapter = self.adapter(is_cancelled=lambda: any(e["phase"] == "accepted" for e in self.events))
        with self.assertRaises(RunPodWorkCancelled):
            adapter(MESSAGES, CATALOG)
        self.assertFalse(self.events[-1]["cancel_confirmed"])
        self.assertEqual(self.events[-1]["remote_state"], "COMPLETED")

    def test_absolute_deadline_cancels_known_job_once_without_submit_retry(self):
        self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": "IN_PROGRESS"}]
        # After cancellation the fixture reports a real terminal state.
        self.cancel_state = "CANCELLED"
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.ask(timeout_seconds=.05)
        self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(len([r for r in self.requests if r["path"].endswith("/run")]), 1)
        self.assertEqual(len([r for r in self.requests if "/cancel/" in r["path"]]), 1)

    def test_uncertain_submit_is_not_resubmitted_even_on_repeated_adapter_call(self):
        self.responses[("POST", PREFIX + "/run")] = [(200, b"provider-secret-and-invalid-json")]
        adapter = self.adapter()
        for _ in range(2):
            with self.assertRaises(RunPodWorkError) as caught:
                adapter(MESSAGES, CATALOG)
            self.assertNotIn("provider-secret", str(caught.exception))
            self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.events[-1]["phase"], "submit_uncertain")
        self.assertNotIn("job_id", self.events[-1])

    def test_redirect_and_http_failure_never_follow_or_retry(self):
        for code in (302, 403, 429, 503):
            self.responses[("POST", PREFIX + "/run")] = [(code, b"provider-secret")]
            before = len(self.requests)
            with self.subTest(code=code), self.assertRaises(RunPodWorkError) as caught:
                self.ask()
            self.assertEqual(len(self.requests), before + 1)
            self.assertNotIn(KEY, str(caught.exception))
            self.assertNotIn("provider-secret", str(caught.exception))
        self.assertTrue(all(r["path"] == PREFIX + "/run" for r in self.requests))

    def test_foreign_status_identity_is_rejected_and_only_owned_job_is_cancelled(self):
        self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": "foreign-job", "status": "COMPLETED", "output": completion()}]
        with self.assertRaisesRegex(RunPodWorkError, "identity"):
            self.ask()
        self.assertEqual([r["path"] for r in self.requests if "/cancel/" in r["path"]], [PREFIX + "/cancel/" + JOB])
        self.assertFalse(self.events[-1]["cancel_confirmed"])

    def test_unknown_state_and_multi_output_fail_closed(self):
        for value in ({"id": JOB, "status": "UNKNOWN"}, {"id": JOB, "status": "COMPLETED", "output": [completion(), completion()]}):
            self.responses[("GET", PREFIX + "/status/" + JOB)] = [value]
            with self.assertRaises(RunPodWorkError):
                self.ask()

    def test_known_submit_id_is_retained_and_cancelled_even_with_unknown_state(self):
        self.responses[("POST", PREFIX + "/run")] = [{"id": JOB, "status": "UNKNOWN"}]
        with self.assertRaises(RunPodWorkError):
            self.ask()
        invalid = next(event for event in self.events if event["phase"] == "acceptance_invalid")
        self.assertEqual(invalid["job_id"], JOB)
        self.assertEqual([r["path"] for r in self.requests if "/cancel/" in r["path"]], [PREFIX + "/cancel/" + JOB])

    def test_provider_echoed_credential_cannot_be_a_public_answer_or_receipt(self):
        self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": "COMPLETED", "output": completion(KEY)}]
        with self.assertRaises(RunPodWorkError) as caught:
            self.ask()
        self.assertNotIn(KEY, str(caught.exception))
        self.assertNotIn(KEY, json.dumps(self.events))
        self.responses[("POST", PREFIX + "/run")] = [{"id": "echo-" + KEY, "status": "IN_QUEUE"}]
        with self.assertRaises(RunPodWorkError):
            self.ask()
        self.assertNotIn(KEY, json.dumps(self.events))
        # Inspect parsed strings, since JSON escaping must not hide a token.
        escaped_key = 'TEST-ONLY-"ESCAPED\\TOKEN'
        self.responses[("POST", PREFIX + "/run")] = [{"id": JOB, "status": "IN_QUEUE"}]
        for output in (completion(escaped_key), completion(None, [call(json.dumps({"name": escaped_key}))])):
            self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": "COMPLETED", "output": output}]
            adapter = create_model_adapter("model", ENDPOINT, escaped_key, poll_seconds=.01, on_job=self.events.append)
            with self.subTest(output=output), self.assertRaises(RunPodWorkError) as caught:
                adapter(MESSAGES, CATALOG)
            self.assertNotIn(escaped_key, str(caught.exception))

    def test_terminal_failures_never_return_output_or_retry(self):
        for state in ("FAILED", "TIMED_OUT", "CANCELLED"):
            self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": state, "error": "private-provider-body"}]
            with self.subTest(state=state), self.assertRaises(RunPodWorkError) as caught:
                self.ask()
            self.assertNotIn("private-provider-body", str(caught.exception))
        self.assertFalse(any("/cancel/" in r["path"] for r in self.requests))

    def test_duplicate_nonfinite_and_oversized_status_envelopes_are_bounded(self):
        for raw in (b'{"id":"a","id":"b"}', b'{"id":"a","status":NaN}', b" " * (MAX_RESPONSE_BYTES + 1)):
            self.responses[("GET", PREFIX + "/status/" + JOB)] = [(200, raw)]
            with self.assertRaises(RunPodWorkError):
                self.ask()

    def test_slow_unknown_submit_obeys_absolute_deadline(self):
        self.slow_path = PREFIX + "/run"
        started = time.monotonic()
        with self.assertRaises((RunPodWorkError, TimeoutError)):
            self.ask(timeout_seconds=.05)
        self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(len(self.requests), 1)

    def test_trickled_status_has_its_own_absolute_deadline_with_long_outer_budget(self):
        self.slow_path = PREFIX + "/status/" + JOB
        started = time.monotonic()
        with patch('foundry.runpod_work_provider.MAX_EXCHANGE_SECONDS', .05), self.assertRaises(TimeoutError):
            self.ask(timeout_seconds=1)
        self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(len([r for r in self.requests if r['path'].endswith('/run')]), 1)
        self.assertEqual(len([r for r in self.requests if '/cancel/' in r['path']]), 1)

    def test_acceptance_commit_failure_attempts_one_exact_job_cancel(self):
        def receipt(event):
            self.events.append(event)
            if event["phase"] == "accepted":
                raise ValueError("fixture commit unavailable")
        adapter = create_model_adapter("model", ENDPOINT, KEY, on_job=receipt, cancel_timeout_seconds=.1)
        with self.assertRaises(RunPodWorkError):
            adapter(MESSAGES, CATALOG)
        self.assertEqual([r["path"] for r in self.requests if "/cancel/" in r["path"]], [PREFIX + "/cancel/" + JOB])

    def test_host_transport_selection_preserves_other_openai_and_ollama_resources(self):
        env = {"YUR_FRANKLIN_RUNPOD_URL": ENDPOINT, "YUR_FRANKLIN_RUNPOD_MODEL": "dedicated-model",
               "YUR_FRANKLIN_RUNPOD_API_KEY": KEY, "YUR_FRANKLIN_OPENAI_URL": "https://other.example/v1"}
        with patch.dict("os.environ", env, clear=True):
            self.assertTrue(model_adapter_for({"provider": "openai-compatible", "model": "dedicated-model"}).queue_transport)
            with patch("foundry.openai_work_provider.create_model_adapter", return_value="ordinary-openai") as factory:
                self.assertEqual(model_adapter_for({"provider": "openai-compatible", "model": "other-model"}), "ordinary-openai")
                self.assertEqual(factory.call_args.args[:2], ("other-model", "https://other.example/v1"))
            with patch("foundry.work_provider.create_model_adapter", return_value="ordinary-ollama"):
                self.assertEqual(model_adapter_for({"provider": "ollama", "model": "dedicated-model"}), "ordinary-ollama")

    def test_real_commit_owner_retains_intent_job_identity_and_reopen_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "journal"
            store = CommitService(root)
            store.franklin_configure({"model": "openai:exact-host-served-model"})
            identity = str(uuid.uuid4())
            request = {"command": "send", "text": "Return the owned fixture answer", "request_id": identity,
                       "environment": {"schema": "yur.franklin.environment.v1", "authority": deepcopy(HOST_AUTHORITY)}}
            emitted = []
            try:
                result = handle(request, store=store, model_adapter=self.adapter(), emit=emitted.append,
                                execute_desktop=lambda *_args: {"status": "unused"})
                mission = store.get_work_by_request(identity)
                self.assertEqual(mission["status"], "completed")
                events = store.work_events(mission["id"])
                queue = [event for event in events if event["event_type"].startswith("work.provider.queue.")]
                self.assertEqual(queue[0]["data"]["change"]["phase"], "submit_intent")
                self.assertEqual(queue[1]["data"]["change"]["job_id"], JOB)
                receipt = queue[-1]["hash"]
                self.assertTrue(all(event["event"].get("durable") is True for event in emitted if event["event"].get("type") == "model_queue"))
                self.assertNotIn(KEY, json.dumps(events))
                self.assertNotIn("PRIVATE-REASONING", json.dumps(events))
                self.assertEqual(result["requests"][-1]["status"], "completed")
                self.assertEqual(len(result['queue_calls']), 1)
                retained_call = result['queue_calls'][0]
                self.assertEqual(retained_call['phase'], 'validated')
                self.assertEqual(retained_call['remote_state'], 'COMPLETED')
                self.assertTrue(retained_call['outcome_known'])
                self.assertTrue(retained_call['durable'])
                self.assertFalse(retained_call['local_cancelled'])
                self.assertEqual(set(retained_call), {'request_id', 'call_id', 'phase', 'remote_state',
                                                     'durable', 'local_cancelled', 'outcome_known'})
            finally:
                store.close()
            with CommitService(root) as reopened:
                retained = reopened.work_events(mission["id"])
                self.assertTrue(any(event["hash"] == receipt for event in retained))
                self.assertEqual(reopened.get_work(mission["id"])["answer"], "Fixture fact received")
                self.assertGreater(reopened.verify_integrity()["work_events"], 0)
                before_network = len(self.requests)
                commands = ({'command': 'snapshot'}, {'command': 'recover'},
                            {'command': 'configure', 'patch': {'open': True}},
                            {'command': 'cancel', 'request_id': identity}, request)
                for rpc in commands:
                    with self.subTest(command=rpc['command']):
                        restored = handle(rpc, store=reopened, execute_desktop=lambda *_args: {'status': 'unused'})
                        self.assertEqual(restored['queue_calls'], [retained_call])
                self.assertEqual(len(self.requests), before_network)

    def test_existing_terminal_cancellation_rule_is_preserved_and_remote_result_is_live_only(self):
        with tempfile.TemporaryDirectory() as temp, CommitService(Path(temp) / "journal") as store, CommitService(Path(temp) / "journal") as cancelling_store:
            store.franklin_configure({"model": "openai:exact-host-served-model"})
            identity = str(uuid.uuid4())
            request = {"command": "send", "text": "Cancel this owned fixture", "request_id": identity,
                       "environment": {"schema": "yur.franklin.environment.v1", "authority": deepcopy(HOST_AUTHORITY)}}
            emitted = []
            def emit(frame):
                emitted.append(frame)
                if frame.get("event", {}).get("phase") == "accepted":
                    cancelling_store.franklin_cancel(identity)
            result = handle(request, store=store, model_adapter=self.adapter(), emit=emit,
                            execute_desktop=lambda *_args: {"status": "unused"})
            mission = store.get_work_by_request(identity)
            self.assertEqual(mission["status"], "cancelled")
            events = store.work_events(mission["id"])
            self.assertTrue(any(event["data"]["change"].get("job_id") == JOB for event in events))
            final = next(frame["event"] for frame in emitted if frame.get("event", {}).get("phase") == "cancel_confirmed")
            self.assertFalse(final["durable"])
            self.assertTrue(final["cancel_confirmed"])
            self.assertEqual(events[-1]["event_type"], "work.cancelled")
            self.assertTrue(store.verify_integrity()["passed"])
            retained_call = result['queue_calls'][0]
            self.assertTrue(retained_call['local_cancelled'])
            self.assertEqual(retained_call['phase'], 'accepted')
            self.assertFalse(retained_call['outcome_known'])
            self.assertNotIn('cancel_confirmed', retained_call)
            self.assertEqual(handle({'command': 'snapshot'}, store=cancelling_store)['queue_calls'], [retained_call])

    def test_snapshot_projects_only_30_newest_distinct_calls_without_new_commit(self):
        with tempfile.TemporaryDirectory() as temp, CommitService(Path(temp) / 'journal') as store:
            store.franklin_configure({'model': 'openai:exact-host-served-model'})
            identity = str(uuid.uuid4())
            request = {'command': 'send', 'text': 'Return the fixture answer', 'request_id': identity,
                       'environment': {'schema': 'yur.franklin.environment.v1', 'authority': deepcopy(HOST_AUTHORITY)}}
            adapter = self.adapter()
            bind = adapter.bind_owner
            def bind_with_history(*, cancelled, receipt):
                def populated(event):
                    if event['phase'] == 'submit_intent':
                        for index in range(35):
                            receipt({**event, 'call_id': f'{index:032x}'})
                            receipt({**event, 'call_id': f'{index:032x}', 'phase': 'accepted',
                                     'job_id': f'owned-history-{index}', 'remote_state': 'IN_PROGRESS'})
                    receipt(event)
                bind(cancelled=cancelled, receipt=populated)
            adapter.bind_owner = bind_with_history
            result = handle(request, store=store, model_adapter=adapter, execute_desktop=lambda *_args: {'status': 'unused'})
            calls = result['queue_calls']
            self.assertEqual(len(calls), 30)
            self.assertEqual(len({item['call_id'] for item in calls}), 30)
            self.assertEqual(calls[0]['phase'], 'validated')
            self.assertEqual([item['call_id'] for item in calls[1:]], [f'{i:032x}' for i in range(34, 5, -1)])
            self.assertNotIn('owned-history-', json.dumps(calls))
            self.assertNotIn('endpoint_id', json.dumps(calls))
            before = store.verify_integrity()
            self.assertEqual(handle({'command': 'snapshot'}, store=store)['queue_calls'], calls)
            self.assertEqual(store.verify_integrity(), before)

    def test_snapshot_retains_uncertain_submit_attention_without_job_or_output(self):
        self.responses[("POST", PREFIX + "/run")] = [(200, b'unknown-acknowledgment')]
        with tempfile.TemporaryDirectory() as temp, CommitService(Path(temp) / 'journal') as store:
            store.franklin_configure({'model': 'openai:exact-host-served-model'})
            identity = str(uuid.uuid4())
            request = {'command': 'send', 'text': 'Use the fixture', 'request_id': identity,
                       'environment': {'schema': 'yur.franklin.environment.v1', 'authority': deepcopy(HOST_AUTHORITY)}}
            result = handle(request, store=store, model_adapter=self.adapter(), execute_desktop=lambda *_args: {'status': 'unused'})
            retained_call = result['queue_calls'][0]
            self.assertEqual(retained_call['phase'], 'submit_uncertain')
            self.assertEqual(retained_call['remote_state'], 'UNKNOWN')
            self.assertFalse(retained_call['outcome_known'])
            self.assertFalse(retained_call['local_cancelled'])
            self.assertNotIn('job_id', retained_call)
            with self.assertRaises(ValueError):
                handle({'command': 'queue_reconcile', 'request_id': identity,
                        'call_id': retained_call['call_id'], 'cancel': False}, store=store)
            self.assertEqual(len(self.requests), 1)

    def test_reconciliation_reads_retained_identity_and_never_submits_or_exposes_output(self):
        adapter = self.adapter()
        result = adapter.reconcile_job(JOB)
        self.assertEqual(result["remote_state"], "COMPLETED")
        self.assertTrue(result["outcome_known"])
        self.assertNotIn("output", result)
        self.assertEqual([(r["method"], r["path"]) for r in self.requests], [("GET", PREFIX + "/status/" + JOB)])
        self.assertEqual(self.events, [])

    def test_reconciliation_cancel_checks_remote_confirmation_without_resubmission(self):
        self.responses[("GET", PREFIX + "/status/" + JOB)] = [{"id": JOB, "status": "IN_QUEUE"}, {"id": JOB, "status": "CANCELLED"}]
        result = self.adapter().reconcile_job(JOB, cancel=True, timeout_seconds=.1)
        self.assertTrue(result["cancel_requested"])
        self.assertTrue(result["cancel_confirmed"])
        self.assertEqual([(r["method"], r["path"]) for r in self.requests],
                         [("GET", PREFIX + "/status/" + JOB), ("POST", PREFIX + "/cancel/" + JOB), ("GET", PREFIX + "/status/" + JOB)])

    def test_reconciliation_mismatch_or_missing_job_is_body_free_unknown(self):
        for value in ({"id": "foreign-job", "status": "COMPLETED", "output": completion(KEY)}, (404, b"private-provider-error")):
            self.responses[("GET", PREFIX + "/status/" + JOB)] = [value]
            result = self.adapter().reconcile_job(JOB, cancel=True, timeout_seconds=.1)
            self.assertFalse(result["outcome_known"])
            self.assertFalse(result["cancel_confirmed"])
            self.assertNotIn(KEY, json.dumps(result))
        self.assertFalse(any(r["method"] == "POST" for r in self.requests))

    def test_reconcile_rpc_uses_committed_identity_and_rejects_resource_retargeting(self):
        with tempfile.TemporaryDirectory() as temp, CommitService(Path(temp) / 'journal') as store:
            store.franklin_configure({'model': 'openai:exact-host-served-model'})
            identity = str(uuid.uuid4())
            request = {'command': 'send', 'text': 'Use the fixture', 'request_id': identity,
                       'environment': {'schema': 'yur.franklin.environment.v1', 'authority': deepcopy(HOST_AUTHORITY)}}
            handle(request, store=store, model_adapter=self.adapter(), execute_desktop=lambda *_args: {'status': 'unused'})
            mission = store.get_work_by_request(identity)
            accepted = next(event['data']['change'] for event in store.work_events(mission['id'])
                            if event['event_type'] == 'work.provider.queue.accepted')
            rpc = {'command': 'queue_reconcile', 'request_id': identity, 'call_id': accepted['call_id'], 'cancel': False}
            env = {'YUR_FRANKLIN_RUNPOD_URL': ENDPOINT, 'YUR_FRANKLIN_RUNPOD_MODEL': 'exact-host-served-model',
                   'YUR_FRANKLIN_RUNPOD_API_KEY': KEY}
            before = len(self.requests)
            with patch.dict('os.environ', env, clear=True):
                result = handle(rpc, store=store)
                self.assertEqual(result['job_id'], JOB)
                self.assertEqual(result['remote_state'], 'COMPLETED')
                self.assertFalse(result['durable'])
                self.assertNotIn('output', result)
                with patch.dict('os.environ', {'YUR_FRANKLIN_RUNPOD_URL': 'https://api.runpod.ai/v2/foreign-endpoint'}), self.assertRaises(ValueError):
                    handle(rpc, store=store)
                with self.assertRaises(ValueError):
                    handle({**rpc, 'call_id': 'f' * 32}, store=store)
            self.assertEqual(len(self.requests), before + 1)
            self.assertEqual(store.get_work(mission['id'])['revision'], mission['revision'])
            with self.assertRaises(ValueError):
                validate_rpc({**rpc, 'job_id': 'foreign-job'})


if __name__ == "__main__":
    unittest.main()
