"""Real Work CLI, HTTP model protocol, existing manager and CommitService."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid

SOURCE_ROOT = Path(__file__).resolve().parents[1]


class WorkCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        self.file = self.root / "report.txt"
        self.file.write_text("Measured quantity: 24", encoding="utf-8")
        self.state = Path(self.temp.name) / "journal"
        self.requests = []
        suite = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                suite.requests.append(request)
                count = len(suite.requests)
                if count == 1:
                    message = {"content": "", "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "report.txt"}}}]}
                elif count == 2:
                    suite.assertIn("Measured quantity: 24", request["messages"][-1]["content"])
                    message = {"content": "", "tool_calls": [{"function": {"name": "create_artifact", "arguments": {"name": "summary.md", "media_type": "text/markdown", "content": "# Measured quantity\n24"}}}]}
                else:
                    suite.assertIn('"artifact_status": "committed"', request["messages"][-1]["content"])
                    message = {"content": "Created summary.md from the measured quantity of 24."}
                encoded = json.dumps({"done": True, "message": message}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}"
        self.request = {"request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "mode": "work", "goal": "Read and summarize the report", "root": str(self.root), "provider": "ollama", "model": "fixture", "messages": [{"role": "user", "content": "Read report.txt and create a summary."}]}

    def rpc(self, request):
        environment = {**os.environ, "YUR_DESKTOP_HOME": str(self.state), "YUR_OLLAMA_URL": self.endpoint, "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1"}
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        raw = request if isinstance(request, str) else json.dumps(request)
        result = subprocess.run([sys.executable, "-B", "-m", "foundry.work_cli"], cwd=SOURCE_ROOT, env=environment, input=raw.encode(), capture_output=True, timeout=15)
        self.assertEqual(result.stderr, b"")
        records = [json.loads(line) for line in result.stdout.decode().splitlines()]
        self.assertTrue(records, result.stdout)
        self.assertEqual(records[-1]["type"], "result")
        return result.returncode, records

    def test_actual_worker_lock_returns_typed_identity_and_preserves_exact_queued_request(self):
        from foundry.commit_service import CommitService
        with CommitService(self.state) as holder, holder.acquire_worker():
            code, records = self.rpc({'command': 'start', 'request': self.request})
            error = records[-1]['error']
            self.assertEqual(code, 1)
            self.assertEqual(error['code'], 'WORKER_BUSY')
            self.assertEqual(error['request_id'], self.request['request_id'])
            self.assertEqual(error['conversation_id'], self.request['conversation_id'])
            self.assertEqual(holder.get_work(error['mission_id'])['status'], 'queued')
            self.assertEqual(self.requests, [])
        code, records = self.rpc({'command': 'start', 'request': self.request})
        self.assertEqual(code, 0, records)
        self.assertEqual(records[-1]['result']['mission']['id'], error['mission_id'])
        self.assertEqual(records[-1]['result']['mission']['status'], 'completed')

    def test_worker_error_text_or_unrelated_os_failure_is_not_contention(self):
        import errno
        from foundry.work_cli import _worker_busy
        for cause in [None, OSError(errno.EACCES, 'Synthetic fixture denial'), OSError(errno.EIO, 'Synthetic fixture IO')]:
            try:
                raise RuntimeError('Another factory worker owns the exclusive worker lock') from cause
            except RuntimeError as error:
                self.assertFalse(_worker_busy(error))

    def test_actual_tool_continuation_commits_artifact_and_replay_never_calls_model(self):
        code, records = self.rpc({"command": "start", "request": self.request})
        self.assertEqual(code, 0, records)
        mission = records[-1]["result"]["mission"]
        self.assertEqual(mission["status"], "completed")
        self.assertEqual(len(mission["steps"]), 2)
        self.assertEqual(mission["artifacts"][0]["proposal"]["content"], "# Measured quantity\n24")
        self.assertEqual(mission["artifacts"][0]["status"], "committed")
        self.assertEqual(len(self.requests), 3)
        for event in records[:-1]:
            self.assertIn(event["type"], {"status", "tool", "model"})
            self.assertEqual(event["request_id"], self.request["request_id"])
            self.assertEqual(event["conversation_id"], self.request["conversation_id"])
        model_events = [event for event in records if event['type'] == 'model']
        self.assertEqual([(event['call_id'], event['status']) for event in model_events],
                         [(call_id, status) for call_id in range(1, 4) for status in ('running', 'completed')])
        for event in model_events:
            self.assertEqual(set(event), {'type', 'mission_id', 'request_id', 'conversation_id', 'call_id', 'status', 'text'})
            self.assertEqual(event['mission_id'], mission['id'])
        self.assertNotIn('Measured quantity', json.dumps(model_events))
        self.assertFalse((self.root / "summary.md").exists())
        self.assertEqual(self.file.read_text(), "Measured quantity: 24")
        _, replay = self.rpc({"command": "start", "request": self.request})
        self.assertEqual(replay[-1]["result"]["mission"]["id"], mission["id"])
        self.assertEqual(len(self.requests), 3)
        self.assertFalse(any(event['type'] == 'model' for event in replay))
        _, inspected = self.rpc({"command": "inspect", "mission_id": mission["id"]})
        evidence = inspected[-1]["result"]
        self.assertEqual(evidence["events"][-1]["event_type"], "work.completed")
        self.assertNotIn("document", evidence["events"][-1])
        self.assertEqual(len(evidence["events"][-1]["hash"]), 64)
        _, listed = self.rpc({"command": "list", "conversation_id": self.request["conversation_id"]})
        summary = listed[-1]["result"]["missions"][0]
        self.assertEqual(summary["step_count"], 2)
        self.assertNotIn("messages", summary)

    def test_cancellation_before_worker_acceptance_is_durable_and_blocks_execution(self):
        code, cancelled = self.rpc({"command": "cancel_request", "request": self.request})
        self.assertEqual(code, 0, cancelled)
        mission = cancelled[-1]["result"]["mission"]
        self.assertEqual(mission["status"], "cancelled")
        _, started = self.rpc({"command": "start", "request": self.request})
        self.assertEqual(started[-1]["result"]["mission"]["status"], "cancelled")
        self.assertEqual(self.requests, [])
        _, inspected = self.rpc({"command": "inspect", "mission_id": mission["id"]})
        self.assertEqual(inspected[-1]["result"]["events"][-1]["event_type"], "work.cancelled")

    def test_readonly_empty_listing_and_unknown_inspection_create_no_state(self):
        code, listed = self.rpc({"command": "list", "conversation_id": None})
        self.assertEqual(code, 0)
        self.assertEqual(listed[-1]["result"], {"missions": []})
        code, _ = self.rpc({"command": "inspect", "mission_id": "a" * 32})
        self.assertEqual(code, 1)
        self.assertFalse(self.state.exists())

    def test_unsupported_foundry_and_unknown_fields_fail_without_provider_calls_or_state(self):
        code, unsupported = self.rpc({"command": "start", "request": {**self.request, "provider": "foundry"}})
        self.assertEqual(code, 1)
        self.assertEqual(unsupported[-1]["error"]["code"], "UNSUPPORTED_PROVIDER")
        for request in ({"command": "start", "request": self.request, "authority": {}}, {"command": "list", "conversation_id": None, "root": "other"}, '{"command":"list","command":"start"}'):
            with self.subTest(request=request):
                code, response = self.rpc(request)
                self.assertEqual(code, 1)
                self.assertEqual(response[-1]["error"]["code"], "INVALID_REQUEST")
        self.assertEqual(self.requests, [])
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
