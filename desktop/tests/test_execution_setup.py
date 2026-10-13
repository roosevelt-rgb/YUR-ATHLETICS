"""Actual setup journal with synthetic process/status adapters; never runs WSL."""
from copy import deepcopy
from datetime import datetime, timezone
import ast
import hashlib
import io
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from foundry import execution_cell as cell
from foundry import execution_setup as setup
from foundry import runtime_setup_contract as contract
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager


DISTRO = 'Ubuntu-Fixture'


def runtime_info():
    return {'distro': DISTRO, 'architecture': 'x86_64', 'python': '3.12.3', 'libseccomp': '2.5.5',
            'kernel': 'synthetic-test-kernel',
            'artifacts': {name: {'path': name, 'sha256': sha, 'bytes': 1} for name, sha in cell.RUNTIME_PINS.items()}}


class FakeRuntime:
    def __init__(self, state='stopped'):
        self.state = state
        self.observations, self.verifications = 0, 0
        self.error = None
        self.environment = {}

    def observe(self, distro, source):
        self.observations += 1
        resource = {'resource_id': contract.resource_id_for(DISTRO), 'distro': DISTRO, 'state': self.state, 'version': 2}
        return {'resources': [resource], 'selected': resource, 'configuration_source': source}

    def verify(self, distro):
        self.verifications += 1
        if self.error:
            raise self.error
        return runtime_info()


class FakeHold:
    def __init__(self, before_start=lambda: None, confirmed=True):
        self.before_start, self.confirmed = before_start, confirmed
        self.started, self.running, self.closed, self.releases = False, False, 0, 0
        self.arguments = None

    def start(self, distro, seconds, expires_at, stop_event):
        self.before_start()
        self.arguments = distro, seconds, expires_at
        self.started = self.running = True

    def alive(self):
        return self.running

    def close_input(self):
        self.closed += 1

    def release(self):
        self.releases += 1
        self.close_input()
        if self.confirmed:
            self.running = False
        return self.confirmed


class SetupAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'state'
        self.manager = None
        self.runtime = FakeRuntime()
        self.holds = []
        self.clock = 100.0
        self.events = []
        self.session = setup.ExecutionSetupSession(self.get_manager, runtime=self.runtime,
            hold_factory=self.new_hold, monotonic=lambda: self.clock, on_state=self.events.append)
        self.addCleanup(self.cleanup)

    def get_manager(self, *, create=False):
        if self.manager is None and (create or (self.root / 'foundry.sqlite3').is_file()):
            self.manager = OrchestrationManager(CommitService(self.root))
        return self.manager

    def cleanup(self):
        self.session.close()
        if self.manager:
            self.manager.store.close()

    def new_hold(self):
        def before_start():
            events = self.manager.runtime_setup_events(self.session.operation_id)['events']
            self.assertEqual([event['state'] for event in reversed(events)], ['accepted', 'starting'])
            self.assertIsNone(self.manager.store._lock_file)
        hold = FakeHold(before_start)
        self.holds.append(hold)
        return hold

    def checked(self):
        return self.session.check(DISTRO, 'operator')['check']

    def prepare(self):
        checked = self.checked()
        operation = str(uuid.uuid4())
        result = self.session.prepare(operation, checked['selected_resource_id'], checked['check_token'])
        return operation, checked, result

    def test_check_is_readonly_and_distinguishes_four_states(self):
        for state, error, expected in [
            ('stopped', None, 'stopped'), ('running', None, 'ready'),
            ('running', cell.ExecutionCellError('unavailable', 'fixture', diagnostics={
                'schema': 'yur.execution-diagnostic.v1', 'phase': 'runtime_verification', 'outcome': 'fingerprint_mismatch'}), 'mismatch'),
            ('running', cell.ExecutionCellError('unavailable', 'fixture', diagnostics={
                'schema': 'yur.execution-diagnostic.v1', 'phase': 'runtime_verification', 'outcome': 'timeout'}), 'unknown'),
        ]:
            with self.subTest(expected=expected):
                self.runtime.state, self.runtime.error = state, error
                checked = self.checked()
                self.assertEqual(checked['status'], expected)
                self.assertEqual(checked['check_token'] is not None, expected in {'ready', 'stopped'})
                self.assertFalse(self.root.exists())
                self.assertFalse(self.holds)

    def test_prepare_commits_before_start_verifies_and_releases_owned_hold(self):
        operation, checked, ready = self.prepare()
        self.assertEqual(ready['setup']['state'], 'ready')
        self.assertTrue(ready['setup']['evidence']['started_by_this_setup'])
        self.assertEqual(ready['setup']['evidence']['runtime'], runtime_info())
        self.assertEqual(self.holds[0].arguments[0], DISTRO)
        self.assertLessEqual(self.holds[0].arguments[1], 900)
        serialized = contract.canonical(ready)
        self.assertNotIn(checked['check_token'].encode(), serialized)
        self.assertEqual(ready['setup']['check']['token_sha256'], hashlib.sha256(checked['check_token'].encode()).hexdigest())
        released = self.session.release(operation)
        self.assertEqual(released['setup']['state'], 'released')
        self.assertTrue(released['setup']['evidence']['owned_process_exit_confirmed'])
        self.assertEqual(self.holds[0].releases, 1)
        self.assertEqual(self.session.release(operation)['receipt'], released['receipt'])
        self.assertEqual(self.holds[0].releases, 1)
        self.manager.store.close(); self.manager = None
        reopened = self.session.inspect(operation)
        self.assertEqual(reopened['receipt'], released['receipt'])

    def test_running_resource_hold_is_not_claimed_as_booted(self):
        self.runtime.state = 'running'
        _, _, result = self.prepare()
        self.assertFalse(result['setup']['evidence']['started_by_this_setup'])

    def test_tokens_are_owner_bound_single_use_and_monotonic(self):
        check = self.checked()
        other = setup.ExecutionSetupSession(self.get_manager, runtime=self.runtime, hold_factory=self.new_hold)
        with self.assertRaises(setup.SetupError):
            other.prepare(str(uuid.uuid4()), check['selected_resource_id'], check['check_token'])
        with self.assertRaises(setup.SetupError):
            self.session.prepare(str(uuid.uuid4()), 'f' * 64, check['check_token'])
        self.clock += 121
        with self.assertRaisesRegex(setup.SetupError, 'expired'):
            self.session.prepare(str(uuid.uuid4()), check['selected_resource_id'], check['check_token'])
        self.assertFalse(self.root.exists())
        self.assertFalse(self.holds)

    def test_fresh_state_change_requires_new_check_before_acceptance(self):
        check = self.checked(); self.runtime.state = 'running'
        with self.assertRaisesRegex(setup.SetupError, 'changed'):
            self.session.prepare(str(uuid.uuid4()), check['selected_resource_id'], check['check_token'])
        self.assertFalse(self.root.exists())

    def test_same_operation_replay_across_session_never_starts_another_hold(self):
        operation, checked, result = self.prepare()
        other = setup.ExecutionSetupSession(self.get_manager, runtime=self.runtime,
            hold_factory=lambda: self.fail('No replacement holder'))
        before = self.runtime.observations
        self.clock += 200
        replay = other.prepare(operation, checked['selected_resource_id'], checked['check_token'])
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], result['receipt'])
        self.assertEqual(self.runtime.observations, before)
        with self.assertRaises(setup.SetupError):
            other.release(operation)
        with self.assertRaises(setup.SetupError):
            other.prepare(str(uuid.uuid4()), checked['selected_resource_id'], checked['check_token'])
        self.assertEqual(len(self.holds), 1)

    def test_acceptance_and_starting_acknowledgment_loss_never_duplicate_start(self):
        for boundary in ('accepted', 'starting'):
            with self.subTest(boundary=boundary):
                session = setup.ExecutionSetupSession(self.get_manager, runtime=self.runtime,
                    hold_factory=lambda: self.fail('No spawn after uncertain prestart acknowledgment'))
                checked = session.check(DISTRO, 'operator')['check']
                operation = str(uuid.uuid4())
                manager = self.get_manager(create=True)
                method = 'accept_runtime_setup' if boundary == 'accepted' else 'transition_runtime_setup'
                original = getattr(manager, method)
                def interrupted(*args, **kwargs):
                    result = original(*args, **kwargs)
                    raise OSError('Synthetic postcommit acknowledgment loss')
                with patch.object(manager, method, side_effect=interrupted), self.assertRaises(setup.SetupError):
                    session.prepare(operation, checked['selected_resource_id'], checked['check_token'])
                replay = session.prepare(operation, checked['selected_resource_id'], checked['check_token'])
                self.assertEqual(replay['setup']['state'], boundary)
                self.assertTrue(replay['replayed'])
                session.close()
                self.assertEqual(manager.get_runtime_setup(operation)['state'], 'released')

    def test_verification_failure_records_actual_cleanup(self):
        checked = self.checked()
        self.runtime.error = cell.ExecutionCellError('unavailable', 'Synthetic mismatch')
        operation = str(uuid.uuid4())
        with self.assertRaises(setup.SetupError):
            self.session.prepare(operation, checked['selected_resource_id'], checked['check_token'])
        record = self.manager.get_runtime_setup(operation)
        self.assertEqual(record['state'], 'failed')
        self.assertTrue(record['evidence']['owned_process_exit_confirmed'])
        self.assertEqual(self.holds[0].releases, 1)
        self.session.close()
        self.assertEqual(self.holds[0].releases, 1)

    def test_uncertain_automatic_cleanup_does_not_loop_or_free_lease(self):
        operation, _, _ = self.prepare()
        self.holds[0].confirmed = False
        self.clock += 901
        self.session.tick()
        before = self.manager.runtime_setup_events(operation)
        self.assertEqual(self.manager.get_runtime_setup(operation)['state'], 'uncertain')
        for _ in range(20):
            self.session.tick()
        self.session.close()
        self.assertEqual(self.holds[0].releases, 1)
        self.assertEqual(self.manager.runtime_setup_events(operation), before)
        self.assertEqual(self.manager.active_runtime_setup()['operation_id'], operation)
        self.holds[0].confirmed = True
        self.assertEqual(self.session.release(operation)['setup']['state'], 'released')

    def test_eof_closes_only_owned_pipe_and_deadline_uses_monotonic(self):
        operation, _, _ = self.prepare()
        self.session.owner_eof()
        self.assertEqual(self.holds[0].closed, 1)
        self.session.tick()
        self.assertEqual(self.manager.get_runtime_setup(operation)['state'], 'released')
        self.assertEqual(self.manager.get_runtime_setup(operation)['evidence']['release_reason'], 'owner_eof')
        self.assertIsNone(self.manager.store._lock_file)

    def test_release_acknowledgment_loss_still_closes_owned_hold_immediately(self):
        operation, _, _ = self.prepare()
        original = self.manager.transition_runtime_setup
        def interrupted(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[2] == 'releasing':
                raise OSError('Synthetic postcommit release acknowledgment loss')
            return result
        with patch.object(self.manager, 'transition_runtime_setup', side_effect=interrupted):
            with self.assertRaises(setup.SetupError):
                self.session.release(operation)
        self.assertEqual(self.holds[0].releases, 1)
        self.assertFalse(self.holds[0].alive())
        self.assertEqual(self.manager.get_runtime_setup(operation)['state'], 'releasing')
        for _ in range(20):
            self.session.tick()
        self.assertEqual(self.holds[0].releases, 1)
        self.assertEqual(self.session.release(operation)['setup']['state'], 'released')

    def test_release_read_failure_still_closes_only_current_owned_hold(self):
        operation, _, _ = self.prepare()
        with patch.object(self.manager, 'get_runtime_setup', side_effect=OSError('Synthetic unavailable journal')):
            with self.assertRaises(setup.SetupError):
                self.session.release(operation)
        self.assertEqual(self.holds[0].releases, 1)
        self.assertFalse(self.holds[0].alive())
        self.assertEqual(self.manager.get_runtime_setup(operation)['state'], 'ready')
        self.assertEqual(self.session.release(operation)['setup']['state'], 'released')


class RuntimeMetadataTests(unittest.TestCase):
    def test_installed_inventory_is_bounded_readonly_and_environment_wins(self):
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return SimpleNamespace(returncode=0, stdout=b'  NAME STATE VERSION\n* Ubuntu-A Running 2\n Ubuntu-B Stopped 2\n Old Stopped 1\n', stderr=b'')
        adapter = setup.SystemRuntime(run=run, environment={'YUR_EXECUTION_DISTRO': 'Ubuntu-B'})
        observed = adapter.observe('Ubuntu-A', 'settings')
        self.assertEqual(observed['selected']['distro'], 'Ubuntu-B')
        self.assertEqual(observed['configuration_source'], 'environment')
        self.assertEqual(len(observed['resources']), 2)
        self.assertEqual(calls[0][0], [cell.WSL, '--list', '--verbose'])
        self.assertEqual(calls[0][1]['timeout'], 8)

    def test_timeout_and_unsupported_inventory_remain_unknown(self):
        def timeout(*_args, **_kwargs):
            raise subprocess.TimeoutExpired('synthetic', 8)
        with self.assertRaisesRegex(setup.SetupError, 'does not mean stopped'):
            setup.SystemRuntime(run=timeout, environment={}).observe(None, 'auto')
        invalid = lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=b'localized or secret metadata', stderr=b'')
        with self.assertRaises(setup.SetupError):
            setup.SystemRuntime(run=invalid, environment={}).observe(None, 'auto')

    def test_fixed_holder_source_has_no_work_or_distribution_shutdown(self):
        ast.parse(setup.HOLDER_SOURCE, feature_version=(3, 12))
        self.assertEqual(hashlib.sha256(setup.HOLDER_SOURCE.encode()).hexdigest(), setup.HOLDER_SHA256)
        for forbidden in ('subprocess', 'socket', 'shutdown', 'terminate', 'exec(', 'eval(', 'open('):
            self.assertNotIn(forbidden, setup.HOLDER_SOURCE)
        self.assertIn('select.select', setup.HOLDER_SOURCE)
        self.assertIn('time.monotonic()', setup.HOLDER_SOURCE)
        self.assertIn("'seconds','expires_at'", setup.HOLDER_SOURCE)

    def test_passive_process_uses_fixed_argv_clean_environment_and_owned_eof(self):
        class Input(io.BytesIO):
            closed_by_owner = False
            def close(this):
                this.closed_by_owner = True
        class Process:
            def __init__(this):
                this.stdin = Input()
                this.stdout = io.BytesIO(b'{"schema":"yur.passive-runtime-hold.v1","state":"holding"}\n'
                                         b'{"schema":"yur.passive-runtime-hold.v1","state":"released"}\n')
                this.stderr = io.BytesIO()
                this.returncode = None
            def poll(this):
                return this.returncode
            def wait(this, timeout):
                self.assertTrue(this.stdin.closed_by_owner)
                self.assertEqual(timeout, 3)
                this.returncode = 0
                return 0
        process, calls = Process(), []
        def spawn(argv, **kwargs):
            calls.append((argv, kwargs)); return process
        holder = setup.PassiveHold(spawn=spawn)
        holder.start(DISTRO, 900, datetime.now(timezone.utc).timestamp() + 900, threading.Event())
        self.assertEqual(calls[0][0], cell._wsl_argv(DISTRO, setup.HOLDER_SOURCE))
        self.assertEqual(calls[0][1]['env'], cell._environment())
        self.assertFalse(calls[0][1]['shell'])
        self.assertEqual(set(__import__('json').loads(process.stdin.getvalue())), {'seconds', 'expires_at'})
        self.assertTrue(holder.release())


if __name__ == '__main__':
    unittest.main()
