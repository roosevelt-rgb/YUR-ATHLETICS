"""Fixed setup protocol with real temporary journals and synthetic guest holds."""
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import unittest
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry import execution_setup_cli as cli
from foundry import runtime_setup_contract as contract
from test_execution_setup import DISTRO, FakeHold, FakeRuntime


def frame(command, **fields):
    return {'request_id': str(uuid.uuid4()), 'command': command, **fields}


class InputPipe:
    def __init__(self):
        self.items = queue.Queue()

    def send(self, value):
        self.items.put(contract.canonical(value) + b'\n')

    def end(self):
        self.items.put(b'')

    def readline(self, _limit):
        return self.items.get(timeout=5)


class OutputPipe:
    def __init__(self, callback):
        self.frames = []
        self.callback = callback

    def write(self, data):
        value = json.loads(data)
        self.frames.append(value)
        self.callback(value)

    def flush(self):
        pass


class SetupProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'state'
        self.manager = None
        self.holds = []
        self.runtime = FakeRuntime()
        self.addCleanup(self.close)

    def close(self):
        if self.manager is not None:
            self.manager.store.close()

    def manager_factory(self, *, create=False):
        if self.manager is None and (create or (self.root / 'foundry.sqlite3').is_file()):
            self.manager = OrchestrationManager(CommitService(self.root))
        return self.manager

    def hold_factory(self):
        hold = FakeHold(lambda: self.assertEqual(self.manager.active_runtime_setup()['state'], 'starting'))
        self.holds.append(hold)
        return hold

    def serve(self, incoming, callback, hold_factory=None):
        output = OutputPipe(callback)
        code = cli.serve(incoming, output, self.manager_factory, runtime=self.runtime,
                         hold_factory=hold_factory or self.hold_factory)
        return code, output.frames

    def test_exact_private_token_roundtrip_and_other_secret_fields_remain_rejected(self):
        request = frame('prepare', operation_id=str(uuid.uuid4()), resource_id='a' * 64,
                        check_token=str(uuid.uuid4()))
        self.assertEqual(cli.validate_request(request), request)
        for key, value in [('check_token', 'not-a-uuid'), ('root', 'C:/elsewhere'),
                           ('authority', {'issuer': 'model'}), ('argv', ['any'])]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                cli.validate_request({**request, key: value})
        for distro in ['bad/name', 'api_key=abcdefghijklmnopqrstuvwxyz', 'x' * 65]:
            with self.subTest(distro=distro), self.assertRaises(ValueError):
                cli.validate_request(frame('check', distro=distro, configuration_source='operator'))
        self.assertFalse(self.root.exists())

    def test_check_readonly_then_eof_creates_no_journal_or_holder(self):
        incoming = InputPipe()
        incoming.send(frame('check', distro=DISTRO, configuration_source='operator'))
        code, frames = self.serve(incoming, lambda value: incoming.end() if value['type'] == 'result' else None)
        self.assertEqual(code, 0)
        self.assertEqual(frames[0]['result']['check']['status'], 'stopped')
        contract.validate_uuid(frames[0]['result']['check']['check_token'])
        self.assertFalse(self.root.exists())
        self.assertEqual(self.holds, [])

    def test_same_pipe_check_prepare_replay_inspect_release_and_reopen_receipt(self):
        incoming = InputPipe(); operation = str(uuid.uuid4()); prepare = None; ready = None
        results = []; token = None
        def receive(value):
            nonlocal prepare, ready, token
            if value['type'] != 'result':
                return
            self.assertTrue(value['ok'], value)
            results.append(value)
            command = value['command']
            if command == 'check':
                check = value['result']['check']; token = check['check_token']
                prepare = frame('prepare', operation_id=operation, resource_id=check['selected_resource_id'], check_token=token)
                incoming.send(prepare)
            elif command == 'prepare' and not value['result']['replayed']:
                ready = value['result']; incoming.send(prepare)
            elif command == 'prepare':
                self.assertEqual(value['result']['receipt'], ready['receipt'])
                incoming.send(frame('inspect', operation_id=operation))
            elif command == 'inspect' and value['result']['setup']['state'] == 'ready':
                incoming.send(frame('release', operation_id=operation))
            elif command == 'release':
                incoming.send(frame('inspect', operation_id=operation))
            else:
                incoming.end()
        incoming.send(frame('check', distro=DISTRO, configuration_source='operator'))
        code, frames = self.serve(incoming, receive)
        self.assertEqual(code, 0)
        self.assertEqual(len(results), 6)
        self.assertEqual(len(self.holds), 1)
        self.assertEqual(self.holds[0].releases, 1)
        released = results[-1]['result']
        self.assertEqual(released['setup']['state'], 'released')
        self.assertNotIn(token.encode(), contract.canonical(self.manager.runtime_setup_events(operation)))
        self.assertEqual([value['setup']['state'] for value in frames if value['type'] == 'state'],
                         ['starting', 'ready', 'releasing', 'released'])
        self.manager.store.close(); self.manager = None
        next_input = InputPipe(); next_input.send(frame('inspect', operation_id=operation))
        _, reopened = self.serve(next_input, lambda value: next_input.end())
        self.assertEqual(reopened[0]['result'], released)
        self.assertEqual(len(self.holds), 1)

    def test_changed_request_identifier_is_rejected_without_state(self):
        incoming = InputPipe(); request = frame('check', distro=DISTRO, configuration_source='operator')
        incoming.send(request)
        def receive(value):
            if value['ok']:
                incoming.send({**request, 'configuration_source': 'settings'})
            else:
                incoming.end()
        code, frames = self.serve(incoming, receive)
        self.assertEqual(code, 0)
        self.assertEqual(frames[-1]['error']['code'], 'REQUEST_REUSED')
        self.assertEqual(self.runtime.observations, 1)
        self.assertFalse(self.root.exists())

    def test_eof_during_prepare_closes_owned_pipe_and_retains_failed_cleanup(self):
        incoming = InputPipe(); operation = str(uuid.uuid4())
        class EofHold(FakeHold):
            def start(this, distro, seconds, expires_at, stop_event):
                super().start(distro, seconds, expires_at, stop_event)
                incoming.end()
                self.assertTrue(stop_event.wait(2), 'Reader must signal EOF during Prepare')
        def make_hold():
            hold = EofHold(); self.holds.append(hold); return hold
        def receive(value):
            if value['type'] == 'result' and value['command'] == 'check':
                check = value['result']['check']
                incoming.send(frame('prepare', operation_id=operation, resource_id=check['selected_resource_id'],
                                    check_token=check['check_token']))
        incoming.send(frame('check', distro=DISTRO, configuration_source='operator'))
        code, frames = self.serve(incoming, receive, make_hold)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.holds), 1)
        self.assertGreaterEqual(self.holds[0].closed, 1)
        self.assertEqual(self.holds[0].releases, 1)
        retained = self.manager.get_runtime_setup(operation)
        self.assertEqual(retained['state'], 'failed')
        self.assertTrue(retained['evidence']['owned_process_exit_confirmed'])
        self.assertNotIn('ready', [item['setup']['state'] for item in frames if item['type'] == 'state'])

    def test_oversize_and_duplicate_key_frames_fail_closed_without_state(self):
        for raw in [b'x' * (cli.MAX_FRAME_BYTES + 1), b'{"command":"check","command":"prepare"}\n']:
            with self.subTest(raw=raw[:40]):
                incoming = io.BytesIO(raw)
                code, frames = self.serve(incoming, lambda _value: None)
                self.assertEqual(code, 1)
                self.assertEqual(frames, [])
                self.assertFalse(self.root.exists())
                self.assertFalse(self.holds)

    def test_actual_cli_inspect_absent_has_no_runtime_or_state_effect(self):
        # This subprocess only asks for an absent journal record. It cannot
        # inspect/start WSL: no Check or Prepare command is sent.
        request = frame('inspect', operation_id=str(uuid.uuid4()))
        environment = {**os.environ, 'YUR_DESKTOP_HOME': str(self.root), 'PYTHONNOUSERSITE': '1'}
        process = subprocess.run([sys.executable, '-B', '-m', 'foundry.execution_setup_cli'],
            input=contract.canonical(request) + b'\n', capture_output=True, timeout=8,
            cwd=Path(__file__).resolve().parents[1], env=environment,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        answer = json.loads(process.stdout)
        self.assertEqual(answer['request_id'], request['request_id'])
        self.assertEqual(answer['result'], {'setup': None, 'receipt': None})
        self.assertFalse(self.root.exists())


if __name__ == '__main__':
    unittest.main()
