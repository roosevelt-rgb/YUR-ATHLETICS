"""Bounded browser frames, including actual CLI pipe timeout without a model."""
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
import uuid

from foundry import work_browser as browser
from foundry import work_browser_protocol as protocol
from foundry.work_store import digest
from test_work_browser import source, response


def request(selected):
    mission = uuid.uuid4().hex
    return {'type': 'browser_acquire', 'schema': browser.FRAME_SCHEMA,
            'acquisition_id': browser.acquisition_id(mission, 0), 'request_id': str(uuid.uuid4()),
            'conversation_id': str(uuid.uuid4()), 'mission_id': mission, 'step_index': 0,
            'source_id': selected['source_id'], 'source_sha256': digest(selected),
            'input_sha256': digest({'source_id': selected['source_id']}),
            'authority_sha256': digest(browser.AUTHORITY), 'accepted_receipt': 'a' * 64}


class BrowserProtocolTests(unittest.TestCase):
    def test_one_reply_matches_all_identities_and_exact_repeat_does_not_read(self):
        selected = source(); frame = request(selected); reply = response(frame, selected)
        stream = io.BytesIO(browser.canonical(reply) + b'\n'); emitted = []
        acquire = protocol.create_acquirer(stream, emitted.append)
        actual = acquire(frame)
        self.assertEqual(actual, reply)
        self.assertEqual(acquire(frame), reply)
        self.assertEqual(emitted, [frame])
        another = request(selected)
        self.assertEqual(acquire(another)['error']['code'], 'BROKER_ALREADY_USED')
        self.assertEqual(len(emitted), 1)

    def test_initial_and_reply_share_raw_reader_without_losing_prefetched_bytes(self):
        selected = source(); frame = request(selected); reply = response(frame, selected)
        read_fd, write_fd = os.pipe()
        stream = os.fdopen(read_fd, 'rb')
        self.addCleanup(stream.close)
        initial = {'command': 'start', 'fixture': True}
        os.write(write_fd, browser.canonical(initial) + b'\n' + browser.canonical(reply) + b'\n')
        os.close(write_fd)
        self.assertEqual(protocol.read_initial(stream), initial)
        self.assertEqual(protocol.create_acquirer(stream, lambda _frame: None)(frame), reply)

    def test_wrong_identity_fields_missing_limits_secrets_and_arbitrary_reply_commands_fail(self):
        selected = source(); frame = request(selected)
        for kind in ('mission', 'step', 'accepted_receipt', 'extra', 'limits', 'secret', 'both'):
            with self.subTest(kind=kind):
                reply = response(frame, selected)
                if kind == 'mission': reply['mission_id'] = uuid.uuid4().hex
                if kind == 'step': reply['step_index'] = 1
                if kind == 'accepted_receipt': reply['accepted_receipt'] = 'b' * 64
                if kind == 'extra': reply['command'] = 'navigate'
                if kind == 'limits': del reply['context']['limits']
                if kind == 'secret': reply['context']['title'] = 'password="fixture-private-content"'
                if kind == 'both': reply['error'] = {'code': 'DENIED', 'message': 'Not allowed'}
                actual = protocol.create_acquirer(io.BytesIO(browser.canonical(reply) + b'\n'), lambda _frame: None)(frame)
                self.assertEqual(actual['error']['code'], 'INVALID_BROKER_REPLY')
                self.assertNotIn('fixture-private-content', json.dumps(actual))

    def test_duplicate_nonfinite_eof_and_oversize_lines_fail_closed(self):
        selected = source(); frame = request(selected)
        for raw in (b'', b'{"x":1,"x":2}\n', b'{"value":NaN}\n', b'[]\n', b'x' * (protocol.MAX_REPLY_BYTES + 2)):
            with self.subTest(raw=raw[:30]):
                actual = protocol.create_acquirer(io.BytesIO(raw), lambda _frame: None)(frame)
                self.assertEqual(actual['error']['code'], 'BROKER_CLOSED')
        for raw in (b'{}', b'{"x":1,"x":2}\n', b'x' * (protocol.MAX_INITIAL_BYTES + 2)):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                protocol.read_initial(io.BytesIO(raw))

    def test_deadline_poisoning_and_late_reply_cannot_be_reused(self):
        selected = source(); frame = request(selected); released = threading.Event()
        class Waiting:
            def readline(self, _maximum):
                released.wait(2)
                return browser.canonical(response(frame, selected)) + b'\n'
        emitted = []
        acquire = protocol.create_acquirer(Waiting(), emitted.append, timeout_seconds=.02)
        actual = acquire(frame)
        self.assertEqual(actual['error']['code'], 'BROKER_TIMEOUT')
        released.set()
        self.assertEqual(acquire(frame), actual)
        self.assertEqual(len(emitted), 1)

    def test_actual_subprocess_default_timeout_exits_cleanly_while_parent_stdin_stays_open(self):
        selected = source(); frame = request(selected)
        program = """import json,sys
from foundry.work_browser_protocol import read_initial,create_acquirer
frame=read_initial(sys.stdin.buffer)
def emit(value):
 print(json.dumps(value),flush=True)
result=create_acquirer(sys.stdin.buffer,emit)(frame)
print(json.dumps({'done':result['error']['code']}),flush=True)
"""
        process = subprocess.Popen([sys.executable, '-B', '-c', program], cwd=Path(__file__).resolve().parents[1],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            process.stdin.write(browser.canonical(frame) + b'\n'); process.stdin.flush()
            # Intentionally do not close or send a reply: default 5s timeout must
            # not leave a daemon owning the buffered stdin finalization lock.
            self.assertEqual(process.wait(timeout=8), 0)
            lines = [json.loads(line) for line in process.stdout.read().splitlines()]
            self.assertEqual(lines, [frame, {'done': 'BROKER_TIMEOUT'}])
            self.assertEqual(process.stderr.read(), b'')
            self.assertFalse(process.stdin.closed)
        finally:
            if process.poll() is None:
                process.kill(); process.wait(timeout=3)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()


if __name__ == '__main__':
    unittest.main()
