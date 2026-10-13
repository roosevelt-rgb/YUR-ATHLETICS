"""Real loopback HTTP contract tests; no cloud models or tool side effects."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time
import unittest

from foundry.openai_work_provider import create_model_adapter, convert_messages, normalize_endpoint
from foundry.work_provider import MAX_RESPONSE_BYTES, native_tools

CATALOG = [{"name": "lookup_fact", "description": "Read a bounded test fact", "input_schema": {
    "type": "object", "properties": {"name": {"type": "string", "maxLength": 100}}, "required": ["name"], "additionalProperties": False}}]


def completion(*, content="Fact accepted", calls=None, finish="stop"):
    return {"id": "completion-fixture", "choices": [{"index": 0, "finish_reason": finish,
            "message": {"role": "assistant", "content": content, **({"tool_calls": calls} if calls is not None else {})}}]}


def call(name="fixture", identity="call_provider_1"):
    return {"id": identity, "type": "function", "function": {"name": "lookup_fact", "arguments": json.dumps({"name": name})}}


class CompatibleProviderTests(unittest.TestCase):
    def setUp(self):
        self.requests, self.mode = [], "normal"
        self.body = completion(content=None, calls=[call()], finish="tool_calls")
        suite = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                suite.requests.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(raw)})
                mode = suite.mode
                status = 302 if mode == "redirect" else 503 if mode == "error" else 200
                raw = json.dumps(suite.body).encode()
                if mode == "duplicate":
                    raw = b'{"choices":[],"choices":[]}'
                elif mode == "invalid-json":
                    raw = b'provider-secret-MUST-NOT-LEAK'
                elif mode == "oversized":
                    raw = b" " * (MAX_RESPONSE_BYTES + 1)
                elif mode == "error":
                    raw = b'provider-secret-MUST-NOT-LEAK'
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                if mode not in {"slow", "oversized-unknown"}:
                    self.send_header("Content-Length", str(len(raw) + (20 if mode == "truncated" else 0)))
                self.send_header("Location", "/should-never-be-requested")
                self.end_headers()
                try:
                    if mode == "slow":
                        for _ in range(100):
                            self.wfile.write(b" "); self.wfile.flush(); time.sleep(.02)
                    elif mode == "oversized-unknown":
                        self.wfile.write(b" " * (MAX_RESPONSE_BYTES + 1))
                    else:
                        self.wfile.write(raw)
                except OSError:
                    pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}/v1"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def adapter(self, **kwargs):
        return create_model_adapter("fixture-model", self.endpoint, **kwargs)

    def ask(self, **kwargs):
        return self.adapter(**kwargs)([{"role": "user", "content": "Look up the test fact"}], CATALOG)

    def test_native_call_preserves_provider_id_and_complete_tool_schema(self):
        result = self.ask(api_key="TEST-SECRET")
        self.assertEqual(result, {"content": "", "tool_calls": [{"id": "call_provider_1", "type": "function", "function": {"name": "lookup_fact", "arguments": {"name": "fixture"}}}]})
        request = self.requests[0]
        self.assertEqual(request["path"], "/v1/chat/completions")
        self.assertEqual(request["headers"]["Authorization"], "Bearer TEST-SECRET")
        self.assertNotIn("TEST-SECRET", json.dumps(request["body"]))
        self.assertFalse(request["body"]["stream"])
        self.assertEqual(request["body"]["tools"], native_tools(CATALOG))

    def test_two_turn_roundtrip_maps_work_tool_name_back_to_original_id(self):
        first = self.ask()
        messages = [{"role": "user", "content": "Read the test fact"},
                    {"role": "assistant", "content": first["content"], "tool_calls": first["tool_calls"]},
                    {"role": "tool", "tool_name": "lookup_fact", "content": '{"value":"ACTUAL_TEST_FACT"}'}]
        original = copy.deepcopy(messages)
        self.body = completion()
        second = self.adapter()(messages, CATALOG)
        self.assertEqual(second["content"], "Fact accepted")
        wire = self.requests[-1]["body"]["messages"]
        self.assertEqual(wire[-1], {"role": "tool", "tool_call_id": "call_provider_1", "content": '{"value":"ACTUAL_TEST_FACT"}'})
        self.assertEqual(wire[-2]["tool_calls"][0]["id"], "call_provider_1")
        self.assertEqual(messages, original)

    def test_legacy_missing_ids_are_deterministic_distinct_and_pair_same_named_results(self):
        legacy = [{"function": {"index": index, "name": "lookup_fact", "arguments": {"name": "same"}}} for index in range(2)]
        messages = [{"role": "assistant", "content": "", "tool_calls": legacy},
                    {"role": "tool", "tool_name": "lookup_fact", "content": "first"},
                    {"role": "tool", "tool_name": "lookup_fact", "content": "second"}]
        first = convert_messages(messages, native_tools(CATALOG))
        self.assertEqual(first, convert_messages(messages, native_tools(CATALOG)))
        ids = [item["id"] for item in first[0]["tool_calls"]]
        self.assertNotEqual(*ids)
        self.assertEqual([item["tool_call_id"] for item in first[1:]], ids)

    def test_missing_provider_id_gets_stable_id_retained_on_next_round(self):
        value = call(); value.pop("id")
        self.body = completion(content=None, calls=[value], finish="tool_calls")
        first, repeated = self.ask(), self.ask()
        self.assertEqual(first, repeated)
        self.assertTrue(first["tool_calls"][0]["id"].startswith("call_"))
        wire = convert_messages([{"role": "assistant", "content": "", "tool_calls": first["tool_calls"]}, {"role": "tool", "tool_name": "lookup_fact", "content": "result"}], native_tools(CATALOG))
        self.assertEqual(wire[1]["tool_call_id"], first["tool_calls"][0]["id"])

    def test_orphan_unresolved_duplicate_and_unknown_history_is_rejected_before_network(self):
        records = [
            [{"role": "tool", "tool_name": "lookup_fact", "content": "orphan"}],
            [{"role": "assistant", "content": "", "tool_calls": [call()]}],
            [{"role": "assistant", "content": "", "tool_calls": [call(), call()]}, {"role": "tool", "tool_name": "lookup_fact", "content": "result"}],
            [{"role": "user", "content": "hello", "authority": {}}],
        ]
        for messages in records:
            with self.subTest(messages=messages), self.assertRaises(ValueError):
                self.adapter()(messages, CATALOG)
        self.assertEqual([], self.requests)

    def test_response_contract_rejects_invalid_names_json_arguments_schemas_and_ids(self):
        variants = []
        unknown = call(); unknown["function"]["name"] = "unauthorized_tool"; variants.append(unknown)
        for raw in ('{"name":"a","name":"b"}', '{"name":NaN}', '[]', '{"unexpected":"private-value"}', '{"name":123}'):
            value = call(); value["function"]["arguments"] = raw; variants.append(value)
        invalid = call(); invalid["id"] = "bad id\n"; variants.append(invalid)
        for value in variants:
            self.body = completion(content=None, calls=[value], finish="tool_calls")
            with self.subTest(call=value), self.assertRaises(ValueError) as caught:
                self.ask()
            self.assertNotIn("private-value", str(caught.exception))
        self.body = completion(content=None, calls=[call(), call()], finish="tool_calls")
        with self.assertRaisesRegex(ValueError, "duplicate tool call"):
            self.ask()

    def test_incomplete_empty_private_reasoning_and_refusal_are_not_public_answers(self):
        variants = [completion(finish="length"), completion(content=""), {"choices": []}, completion()]
        variants[-1]["choices"][0]["message"] = {"role": "assistant", "content": None, "reasoning_content": "PRIVATE_REASONING"}
        refused = completion(); refused["choices"][0]["message"]["refusal"] = "PRIVATE_REFUSAL"; variants.append(refused)
        for body in variants:
            self.body = body
            with self.assertRaises(ValueError) as caught:
                self.ask()
            self.assertNotIn("PRIVATE", str(caught.exception))
        self.body = completion(); self.body["choices"][0]["message"]["reasoning_content"] = "PRIVATE_REASONING"
        self.body["choices"][0]["message"]["tool_calls"] = None
        self.assertEqual(self.ask(), {"content": "Fact accepted", "tool_calls": []})

    def test_network_errors_redirects_bad_json_oversized_and_truncated_are_bounded_no_retry(self):
        for mode in ("error", "redirect", "invalid-json", "duplicate", "oversized", "oversized-unknown", "truncated"):
            self.mode = mode
            before = len(self.requests)
            with self.subTest(mode=mode), self.assertRaises((ValueError, RuntimeError)) as caught:
                self.ask(api_key="TEST-SECRET")
            self.assertEqual(before + 1, len(self.requests))
            self.assertNotIn("TEST-SECRET", str(caught.exception))
            self.assertNotIn("provider-secret", str(caught.exception))

    def test_absolute_timeout_stops_trickling_response_without_retry(self):
        self.mode = "slow"
        started = time.monotonic()
        with self.assertRaises((ValueError, TimeoutError)) as caught:
            self.ask(timeout_seconds=.08)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(1, len(self.requests))

    def test_context_limit_invalid_credentials_and_timeouts_fail_before_network(self):
        with self.assertRaisesRegex(ValueError, "1 MiB"):
            self.adapter()([{"role": "user", "content": "x" * (1024 * 1024)}], CATALOG)
        for timeout in (True, 0, -1, 121, float('nan'), '120'):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                self.adapter(timeout_seconds=timeout)
        for key in ('', 'secret\nheader', 'bad key', 123):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.adapter(api_key=key)
        self.assertEqual([], self.requests)

    def test_serverless_prefix_is_preserved_in_actual_post_path(self):
        base = self.endpoint.removesuffix('/v1') + '/v2/my-endpoint/openai/v1'
        adapter = create_model_adapter('fixture-model', base)
        adapter([{'role': 'user', 'content': 'Read test fact'}], CATALOG)
        self.assertEqual('/v2/my-endpoint/openai/v1/chat/completions', self.requests[-1]['path'])


class EndpointContractTests(unittest.TestCase):
    def test_safe_provider_neutral_prefix_bases_and_loopback(self):
        self.assertEqual('https://api.runpod.ai/v2/endpoint-id/openai/v1', normalize_endpoint('https://api.runpod.ai/v2/endpoint-id/openai/v1/'))
        self.assertEqual('http://127.0.0.1:11434/v1', normalize_endpoint('http://127.0.0.1:11434'))
        self.assertEqual('http://[::1]:9000/v1', normalize_endpoint('http://[::1]:9000/v1/'))
        self.assertEqual('https://provider.test/team/model/v1', normalize_endpoint('https://provider.test:443/team/model/v1'))

    def test_path_credential_query_encoding_and_plaintext_remote_rejected(self):
        for value in ('http://remote.test/v1', 'https://user:secret@provider.test/v1', 'https://provider.test/v1?token=secret',
                      'https://provider.test/a/../v1', 'https://provider.test/a/%2e%2e/v1', 'https://provider.test/a%2fb/v1',
                      'https://provider.test/a//v1', 'https://provider.test/v1/chat/completions', 'https://provider.test/v1#x',
                      'https://provider.test/a\\b/v1', 'https://provider.test/a%252fb/v1'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_endpoint(value)


if __name__ == '__main__':
    unittest.main()
