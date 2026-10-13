"""Native Ollama tool protocol over a real loopback HTTP fixture."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
import unittest
from unittest.mock import patch

from foundry.work_provider import create_model_adapter, native_tools, normalize_endpoint, UnsupportedWorkProvider, EmptyWorkResponse, MAX_RESPONSE_BYTES, DEFAULT_CONTEXT_TOKENS
from foundry.work_tools import tool_catalog
from foundry.work_specialists import catalog as specialist_catalog
from foundry.work_concepts import catalog as concept_catalog


class WorkProviderTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {})
        environment.start()
        os.environ.pop('YUR_WORK_CONTEXT_TOKENS', None)
        self.addCleanup(environment.stop)
        self.requests = []
        self.mode = "tool"
        self.response_body = None
        suite = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                suite.requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                mode = suite.mode
                body = {"model": "fixture", "done": True, "message": {"role": "assistant", "content": ""}}
                status = 200
                if mode == "tool":
                    body["message"]["tool_calls"] = [{"function": {"name": "read_file", "arguments": {"path": "src/main.py"}}}]
                elif mode == "answer":
                    body["message"]["content"] = "Answer from actual tool evidence."
                elif mode == "incomplete":
                    body["done"] = False
                elif mode == "error":
                    status = 503
                elif mode == "redirect":
                    status = 302
                elif mode == "invalid-call":
                    body["message"]["tool_calls"] = [{"function": {"name": "read_file", "arguments": []}}]
                elif mode == "custom":
                    body = suite.response_body
                data = json.dumps(body).encode()
                if mode == "malformed":
                    data = b'{"done":true,"done":false}'
                if mode == "oversized":
                    data = b"x" * (MAX_RESPONSE_BYTES + 1)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                if mode not in {"slow", "truncated"}:
                    self.send_header("Content-Length", str(len(data)))
                if mode == "truncated":
                    self.send_header("Content-Length", str(len(data) + 100))
                self.end_headers()
                try:
                    if mode == "slow":
                        for _ in range(100):
                            self.wfile.write(b" ")
                            self.wfile.flush()
                            time.sleep(0.01)
                    else:
                        self.wfile.write(data)
                except (OSError, ValueError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def adapter(self, **options):
        return create_model_adapter("ollama", "fixture", endpoint=self.endpoint, **options)

    def test_native_tool_schema_and_actual_structured_response(self):
        result = self.adapter()([{"role": "user", "content": "Read source."}], [*tool_catalog(), *specialist_catalog(), *concept_catalog()])
        self.assertEqual(result["tool_calls"][0]["function"]["arguments"], {"path": "src/main.py"})
        path, request = self.requests[0]
        self.assertEqual(path, "/api/chat")
        self.assertFalse(request["stream"])
        self.assertFalse(request["think"])
        self.assertEqual(request["options"], {"num_ctx": DEFAULT_CONTEXT_TOKENS})
        self.assertEqual(request["model"], "fixture")
        functions = {entry["function"]["name"]: entry["function"] for entry in request["tools"]}
        self.assertFalse(functions["read_file"]["parameters"]["additionalProperties"])
        self.assertEqual(functions["add_concept_evidence"]["parameters"]["properties"]["requirement"]["enum"],
                         ["name", "thesis_statement", "domain_tags", "charter", "success_criteria", "constraint_set",
                          "artifact", "build_log", "instrumentation"])
        for name in ("run_specialist", "run_built_specialist", "run_saved_specialist"):
            contracts = functions[name]["parameters"]["oneOf"]
            self.assertEqual(len(contracts), 5)
            construction = next(item for item in contracts if item["properties"]["capability_id"]["enum"] == ["construction.opc.inspect"])
            self.assertEqual(construction["properties"]["input"]["required"], ["text"])
            self.assertFalse(construction["properties"]["input"]["additionalProperties"])
            if name != "run_specialist":
                self.assertIn("mission_id", functions[name]["parameters"]["required"])
                identity = functions[name]['parameters']['properties']['mission_id']
                self.assertEqual((identity['minLength'], identity['maxLength']), (32, 32))
                self.assertIn('Copy the exact 32-character', identity['description'])
                self.assertIn('build_specialist' if name == 'run_built_specialist' else 'list_built_specialists', identity['description'])

    def test_continuation_preserves_assistant_calls_and_actual_tool_result(self):
        self.mode = "answer"
        messages = [{"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "main.py"}}}]},
                    {"role": "tool", "tool_name": "read_file", "content": '{"content":"ACTUAL_SOURCE"}'}]
        result = self.adapter()(messages, tool_catalog())
        self.assertIn("actual tool evidence", result["content"])
        self.assertEqual(self.requests[-1][1]["messages"], messages)

    def test_explicit_context_budget_and_environment_override_are_sent_to_provider(self):
        messages = [{"role": "user", "content": "Read source."}]
        with patch.dict('os.environ', {'YUR_WORK_CONTEXT_TOKENS': '32768'}):
            self.adapter()(messages, tool_catalog())
            self.assertEqual(self.requests[-1][1]['options']['num_ctx'], 32768)
            self.adapter(context_tokens=8192)(messages, tool_catalog())
            self.assertEqual(self.requests[-1][1]['options']['num_ctx'], 8192)

    def test_invalid_context_budgets_fail_before_any_http_request(self):
        for value in (True, 0, 4095, 131073, 16384.0, '16384'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.adapter(context_tokens=value)
        for value in ('', 'invalid', '4095', '131073', '16384.0', ' 16384', '-16384'):
            with self.subTest(environment=value), patch.dict('os.environ', {'YUR_WORK_CONTEXT_TOKENS': value}), self.assertRaises(ValueError):
                self.adapter()
        self.assertEqual(self.requests, [])

    def test_invalid_providers_origins_and_context_fail_before_any_http_request(self):
        with self.assertRaises(UnsupportedWorkProvider):
            create_model_adapter("foundry", "auto")
        for endpoint in ("http://192.168.1.1", "http://example.com", "https://user:secret@example.com", "https://example.com/api/chat", "http://localhost?token=x", "file:///source"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                normalize_endpoint(endpoint)
        self.assertEqual(normalize_endpoint("http://[::1]:11434/"), "http://[::1]:11434")
        self.assertEqual(normalize_endpoint("https://example.com:443/"), "https://example.com")
        with self.assertRaises(ValueError):
            self.adapter()([{"role": "user", "content": "hi", "authority": {}}], tool_catalog())
        self.assertEqual(self.requests, [])

    def test_malformed_incomplete_oversized_and_error_responses_are_not_answers(self):
        for mode in ("incomplete", "error", "redirect", "invalid-call", "malformed", "oversized", "truncated"):
            self.mode = mode
            with self.subTest(mode=mode), self.assertRaises((ValueError, RuntimeError)):
                self.adapter()([{"role": "user", "content": "hi"}], tool_catalog())

    def test_absolute_deadline_stops_a_trickling_response(self):
        self.mode = "slow"
        started = time.monotonic()
        with self.assertRaises((TimeoutError, ValueError)):
            self.adapter(timeout_seconds=0.08)([{"role": "user", "content": "hi"}], tool_catalog())
        self.assertLess(time.monotonic() - started, 1)

    def test_catalog_conversion_never_mutates_registry_and_rejects_duplicate_tools(self):
        catalog = tool_catalog()
        result = native_tools(catalog)
        result[0]["function"]["parameters"]["properties"].clear()
        self.assertIn("path", catalog[0]["input_schema"]["properties"])
        with self.assertRaises(ValueError):
            native_tools([catalog[0], catalog[0]])

    def test_empty_response_retains_safe_diagnostics_without_reasoning_or_retry(self):
        self.mode = "custom"
        private_text = "PRIVATE_REASONING_MUST_NOT_LEAVE_ADAPTER"
        self.response_body = {"done": True, "done_reason": "length", "eval_count": 4096, "prompt_eval_count": 1234,
                              "message": {"role": "assistant", "content": " \n", "thinking": private_text, "tool_calls": []}}
        with self.assertRaises(EmptyWorkResponse) as caught:
            self.adapter()([{"role": "user", "content": "Finish from the existing tool result."}], tool_catalog())
        error = caught.exception
        self.assertIsInstance(error, ValueError)
        self.assertEqual(error.code, "EMPTY_WORK_RESPONSE")
        self.assertEqual(error.diagnostics, {"schema": "yur.work-provider-diagnostic.v1", "provider": "ollama",
                         "outcome": "empty_response", "done_reason": "length", "content_chars": 2,
                         "thinking_chars": len(private_text), "tool_call_count": 0, "eval_count": 4096, "prompt_eval_count": 1234})
        self.assertNotIn(private_text, str(error))
        self.assertNotIn(private_text, json.dumps(error.diagnostics))
        self.assertIn("done_reason=length", str(error))
        self.assertEqual(len(self.requests), 1, "An empty answer must not retry or replay tool effects")

    def test_diagnostic_metadata_is_allowlisted_and_bounded(self):
        self.mode = "custom"
        for metadata, expected_reason in (({}, "missing"), ({"done_reason": "stop", "eval_count": 0}, "stop"),
                ({"done_reason": "PRIVATE_REASONING_IN_METADATA", "eval_count": "PRIVATE_TOKEN", "prompt_eval_count": True}, "other"),
                ({"done_reason": {"private": "PRIVATE_TOKEN"}, "eval_count": -1, "prompt_eval_count": 2**80}, "other")):
            self.response_body = {"done": True, "message": {"role": "assistant"}, **metadata}
            with self.subTest(metadata=metadata), self.assertRaises(EmptyWorkResponse) as caught:
                self.adapter()([{"role": "user", "content": "Finish."}], tool_catalog())
            diagnostic = caught.exception.diagnostics
            self.assertEqual(diagnostic["done_reason"], expected_reason)
            self.assertEqual(diagnostic["content_chars"], 0)
            self.assertNotIn("PRIVATE", str(caught.exception))
            self.assertNotIn("PRIVATE", json.dumps(diagnostic))
            if metadata.get("eval_count") != 0:
                self.assertNotIn("eval_count", diagnostic)
            self.assertNotIn("prompt_eval_count", diagnostic)
        self.assertEqual(len(self.requests), 4)

    def test_answer_and_typed_calls_are_preserved_while_reasoning_is_not_forwarded(self):
        self.mode = "custom"
        call = {"function": {"name": "read_file", "arguments": {"path": "quoted source.py"}}}
        for content, calls in (("Actual final answer.\n", []), ("", [call]), ("Use this result.", [call])):
            self.response_body = {"done": True, "done_reason": "stop", "message": {"role": "assistant",
                                  "content": content, "tool_calls": calls, "thinking": "PRIVATE_REASONING"}}
            result = self.adapter()([{"role": "user", "content": "Continue."}], tool_catalog())
            self.assertEqual(result, {"content": content, "tool_calls": calls})
            self.assertNotIn("PRIVATE_REASONING", json.dumps(result))
        self.assertEqual(len(self.requests), 3)


if __name__ == "__main__":
    unittest.main()
