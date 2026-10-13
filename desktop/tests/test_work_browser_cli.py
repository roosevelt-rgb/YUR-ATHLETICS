"""Actual opt-in Work child framing, model HTTP continuation and journal proof."""
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'CURRENT_SELECTED_PAGE_QUANTITY_47'


class WorkBrowserCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'journal'
        selected = datetime.now(timezone.utc)
        self.source = {'schema': 'yur.work-browser-source.v1', 'source_id': str(uuid.uuid4()),
                       'source_url': 'https://example.test/report', 'title': 'Selected report',
                       'selected_at': selected.isoformat(), 'expires_at': (selected + timedelta(seconds=120)).isoformat(),
                       'max_acquisitions': 1}
        self.request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()),
                        'mode': 'work', 'root': None, 'provider': 'ollama', 'model': 'browser-cli-fixture',
                        'goal': 'Read the selected page when needed.', 'messages': [{'role': 'user', 'content': 'Read the selected page when needed.'}],
                        'browser_source': self.source}
        self.context = {'schema': 'yur.browser-context.v1', 'source_url': self.source['source_url'],
                        'title': self.source['title'], 'text': MARKER,
                        'sha256': hashlib.sha256(MARKER.encode()).hexdigest(),
                        'acquired_at': selected.isoformat(), 'truncated': False,
                        'limits': {'text_chars': 32000, 'text_bytes': 65536, 'text_nodes': 5000,
                                   'main_frame_only': True, 'form_fields_excluded': True}}
        self.requests, self.errors = [], []
        suite = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass

            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    suite.requests.append(body)
                    completed = [item for item in body['messages'] if item['role'] == 'tool']
                    if not completed:
                        suite.assertNotIn(MARKER, json.dumps(body))
                        suite.assertIn('acquire_selected_page', [tool['function']['name'] for tool in body['tools']])
                        message = {'content': '', 'tool_calls': [{'function': {'name': 'acquire_selected_page', 'arguments': {'source_id': suite.source['source_id']}}}]}
                    else:
                        message = {'content': 'Selected page result retained.'}
                    payload = json.dumps({'done': True, 'message': message}).encode()
                    self.send_response(200); self.send_header('Content-Length', str(len(payload)))
                    self.end_headers(); self.wfile.write(payload)
                except Exception as error:
                    suite.errors.append(str(error)); self.send_error(500)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close); self.addCleanup(self.server.shutdown)
        self.environment = {**os.environ, 'YUR_DESKTOP_HOME': str(self.state),
                            'YUR_OLLAMA_URL': f'http://127.0.0.1:{self.server.server_port}',
                            'PYTHONIOENCODING': 'utf-8', 'PYTHONNOUSERSITE': '1'}
        self.environment.pop('PYTHONPATH', None); self.environment.pop('PYTHONHOME', None)

    def rpc(self, request, flags=()):
        output = subprocess.run([sys.executable, '-B', '-m', 'foundry.work_cli', *flags],
                                input=json.dumps(request).encode() + (b'\n' if flags else b''),
                                cwd=ROOT, env=self.environment, capture_output=True, timeout=20)
        self.assertEqual(output.stderr, b'')
        return output.returncode, [json.loads(line) for line in output.stdout.splitlines()]

    def exchange(self):
        process = subprocess.Popen([sys.executable, '-B', '-m', 'foundry.work_cli', '--browser-acquisition-v1'],
                                   cwd=ROOT, env=self.environment, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        records, lines = [], queue.Queue()
        def reader():
            for line in process.stdout: lines.put(line)
            lines.put(None)
        thread = threading.Thread(target=reader, daemon=True); thread.start()
        try:
            process.stdin.write(json.dumps({'command': 'start', 'request': self.request}).encode() + b'\n')
            process.stdin.flush()
            while True:
                line = lines.get(timeout=15)
                if line is None: break
                record = json.loads(line); records.append(record)
                if record['type'] == 'browser_acquire':
                    self.assertEqual(record['source_id'], self.source['source_id'])
                    self.assertEqual(record['request_id'], self.request['request_id'])
                    self.assertEqual(len(self.requests), 1)
                    reply = {**record, 'type': 'browser_result', 'context': self.context}
                    process.stdin.write(json.dumps(reply).encode() + b'\n'); process.stdin.flush()
            self.assertEqual(process.wait(timeout=5), 0, records)
            self.assertEqual(process.stderr.read(), b'')
        finally:
            if process.poll() is None: process.kill(); process.wait(timeout=5)
            process.stdin.close(); process.stdout.close(); process.stderr.close(); thread.join(timeout=2)
        return records

    def test_framed_acquisition_is_lazy_committed_and_replays_without_browser_or_model(self):
        records = self.exchange()
        self.assertEqual(self.errors, [])
        self.assertEqual(len([item for item in records if item['type'] == 'browser_acquire']), 1)
        mission = records[-1]['result']['mission']
        self.assertEqual(mission['status'], 'completed')
        self.assertEqual(mission['steps'][0]['tool'], 'acquire_selected_page')
        self.assertIn(MARKER, json.dumps(mission['steps'][0]['result']))
        self.assertEqual(len(self.requests), 2)
        self.assertIn(MARKER, self.requests[1]['messages'][-1]['content'])
        code, inspection = self.rpc({'command': 'inspect', 'mission_id': mission['id']})
        self.assertEqual(code, 0)
        events = inspection[-1]['result']['events']
        types = [item['event_type'] for item in events]
        self.assertLess(types.index('work.browser.acquisition.accepted'), types.index('work.browser.result.committed'))
        self.assertLess(types.index('work.browser.result.committed'), types.index('work.tool.completed'))
        self.assertNotIn(MARKER, json.dumps(events), 'Page body must not duplicate into event summaries')
        code, replay = self.rpc({'command': 'start', 'request': self.request}, ['--browser-acquisition-v1'])
        self.assertEqual(code, 0)
        self.assertEqual(replay[-1]['result']['mission'], {key: value for key, value in mission.items() if key != 'receipt'})
        self.assertFalse(any(item['type'] == 'browser_acquire' for item in replay))
        self.assertEqual(len(self.requests), 2)

    def test_legacy_eof_with_selected_source_commits_unavailable_result_and_never_emits_browser_frame(self):
        code, records = self.rpc({'command': 'start', 'request': self.request})
        self.assertEqual(code, 0, records)
        self.assertEqual(self.errors, [])
        self.assertFalse(any(item['type'] == 'browser_acquire' for item in records))
        result = records[-1]['result']['mission']['steps'][0]['result']
        self.assertNotIn(MARKER, json.dumps(result))
        self.assertIn('error', result)

    def test_framed_protocol_requires_selected_start_and_unknown_option_is_rejected_without_state(self):
        for request, flags in [({'command': 'list', 'conversation_id': None}, ['--browser-acquisition-v1']),
                               ({'command': 'start', 'request': {key: value for key, value in self.request.items() if key != 'browser_source'}}, ['--browser-acquisition-v1']),
                               ({'command': 'list', 'conversation_id': None}, ['--arbitrary-command'])]:
            code, records = self.rpc(request, flags)
            self.assertEqual(code, 1, records)
            self.assertEqual(records[-1]['error']['code'], 'INVALID_REQUEST')
        self.assertFalse(self.state.exists())
        self.assertEqual(self.requests, [])


if __name__ == '__main__': unittest.main()
