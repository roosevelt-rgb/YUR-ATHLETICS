"""Operator-only preparation adapter; existing OM/CommitService own all state.

The only executable launch is a fixed passive Python hold in an explicitly
selected installed WSL2 distribution. This module never installs software,
dispatches Work, executes caller code, or shuts down a distribution.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import queue
import re
import subprocess
import threading
import time
import uuid

from . import execution_cell as cell
from . import runtime_setup_contract as contract

CHECK_SCHEMA = 'yur.execution-setup-check.v1'
TOKEN_SECONDS = 120
MAX_RESOURCES = 16

# Fixed source, not a shell command. EOF and both clocks bound the passive hold.
# No filesystem writes, network, subprocesses or Work payload enter this guest.
HOLDER_SOURCE = r'''import json,os,select,sys,time
limit=time.monotonic()+2
if not select.select([sys.stdin.buffer],[],[],max(0,limit-time.monotonic()))[0]: raise SystemExit(2)
raw=sys.stdin.buffer.readline(512)
value=json.loads(raw)
if set(value)!={'seconds','expires_at'} or type(value['seconds']) not in (int,float) or not 0<value['seconds']<=900 or type(value['expires_at']) not in (int,float): raise SystemExit(2)
remaining=min(value['seconds'],value['expires_at']-time.time())
if not 0<remaining<=900: raise SystemExit(2)
deadline=time.monotonic()+remaining
print(json.dumps({'schema':'yur.passive-runtime-hold.v1','state':'holding'}),flush=True)
while time.monotonic()<deadline:
    readable,_,_=select.select([sys.stdin.buffer],[],[],min(.25,max(0,deadline-time.monotonic())))
    if readable:
        if os.read(sys.stdin.fileno(),1): raise SystemExit(2)
        break
print(json.dumps({'schema':'yur.passive-runtime-hold.v1','state':'released'}),flush=True)
'''
HOLDER_SHA256 = hashlib.sha256(HOLDER_SOURCE.encode('utf-8')).hexdigest()


class SetupError(RuntimeError):
    def __init__(self, code, message, diagnostics=None):
        self.code, self.message, self.diagnostics = code, message, diagnostics
        super().__init__(message)


def _diagnostic(code, message):
    return {'code': code, 'message': message}


def _failure(error, code='SETUP_FAILED'):
    if isinstance(error, SetupError):
        value = {'code': error.code, 'message': error.message, 'diagnostics': error.diagnostics}
    elif isinstance(error, cell.ExecutionCellError):
        value = {'code': 'RUNTIME_UNVERIFIED', 'message': 'The selected runtime could not be verified.',
                 'diagnostics': cell._safe_diagnostics(error.diagnostics)}
    else:
        value = {'code': code, 'message': 'Runtime preparation did not complete; inspect its retained record.', 'diagnostics': None}
    return contract.safe(value, 8192)


def _iso(value):
    return value.astimezone(timezone.utc).isoformat()


def safe_private_token(value, maximum):
    """Validate the one private protocol UUID separately from secret-bearing data.

    This exception applies only to the exact ephemeral check_token field. All
    other fields retain the shared secret filter; durable records use its hash.
    """
    token = value.get('check_token')
    if token is not None:
        contract.validate_uuid(token)
    projected = {**value, 'check_token': None} if 'check_token' in value else value
    checked = contract.safe(projected, maximum)
    if 'check_token' in value:
        checked['check_token'] = token
    if len(contract.canonical(checked)) > maximum:
        raise ValueError('Private setup frame exceeds its byte budget')
    return checked


class SystemRuntime:
    """Bounded metadata acquisition and the existing pinned runtime verifier."""
    def __init__(self, *, run=subprocess.run, environment=None):
        self.run = run
        self.environment = os.environ if environment is None else environment

    def observe(self, distro, configuration_source):
        selected = self.environment.get('YUR_EXECUTION_DISTRO')
        if selected is not None:
            configuration_source = 'environment'
        else:
            selected = distro
        if selected is not None:
            try:
                contract.validate_distro(selected)
            except ValueError as error:
                raise SetupError('INVALID_SELECTION', 'Configured execution distribution is invalid; no fallback was selected.') from error
        try:
            result = self.run([cell.WSL, '--list', '--verbose'], capture_output=True, timeout=8,
                              env=cell._environment(), creationflags=cell._NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SetupError('STATUS_UNKNOWN', 'Installed runtime status is unavailable; timeout does not mean stopped.') from error
        if result.returncode or len(result.stdout) > 65536 or len(result.stderr) > 65536:
            raise SetupError('STATUS_UNKNOWN', 'Installed runtime status could not be read within its bounds.')
        try:
            text = result.stdout.decode('utf-16-le' if b'\0' in result.stdout else 'utf-8', errors='strict')
        except UnicodeError as error:
            raise SetupError('STATUS_UNKNOWN', 'Runtime status metadata has an unsupported encoding.') from error
        resources, names = [], set()
        for line in text.splitlines():
            if not line.strip() or re.fullmatch(r'\s*NAME\s+STATE\s+VERSION\s*', line, re.I):
                continue
            match = re.fullmatch(r'\s*\*?\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(Running|Stopped)\s+([12])\s*', line)
            if not match:
                raise SetupError('STATUS_UNKNOWN', 'Runtime status metadata is unsupported; no state was assumed.')
            name, state, version = match.groups()
            try:
                contract.validate_distro(name)
            except ValueError as error:
                raise SetupError('STATUS_UNKNOWN', 'Runtime status contains unsafe resource metadata.') from error
            if name in names:
                raise SetupError('STATUS_UNKNOWN', 'Runtime status contains duplicate resource identities.')
            names.add(name)
            if version == '2':
                resources.append({'resource_id': contract.resource_id_for(name), 'distro': name,
                                  'state': state.lower(), 'version': 2})
        if len(resources) > MAX_RESOURCES:
            raise SetupError('STATUS_UNKNOWN', 'Installed runtime inventory exceeds the bounded selection limit.')
        resources.sort(key=lambda item: item['distro'])
        if selected is None and len(resources) == 1:
            selected, configuration_source = resources[0]['distro'], 'auto'
        chosen = next((item for item in resources if item['distro'] == selected), None)
        return {'resources': resources, 'selected': chosen, 'configuration_source': configuration_source}

    def verify(self, distro):
        # Explicit distro verification avoids ambient fallback or temporary env edits.
        runtime = cell._runtime_for(distro)
        contract._runtime(runtime)
        cell._verify_runtime(runtime)
        return contract.safe(runtime)


class PassiveHold:
    """Own one Popen/pipe, never a distribution or a persisted PID."""
    def __init__(self, *, spawn=subprocess.Popen, monotonic=time.monotonic):
        self.spawn, self.monotonic = spawn, monotonic
        self.process = None
        self.frames = queue.Queue(maxsize=4)
        self.released_frame = False

    def _read(self, stream, label):
        try:
            for _ in range(3):
                data = stream.readline(1025)
                if not data:
                    return
                self.frames.put((label, data), timeout=1)
                if len(data) > 1024:
                    return
        except (OSError, ValueError, queue.Full):
            return

    def start(self, distro, seconds, expires_at, stop_event):
        if self.process is not None:
            raise SetupError('ALREADY_STARTED', 'This setup already owns a hold.')
        if not 0 < seconds <= contract.MAX_HOLD_SECONDS:
            raise SetupError('DEADLINE_EXPIRED', 'Preparation deadline elapsed before launch.')
        self.process = self.spawn(cell._wsl_argv(contract.validate_distro(distro), HOLDER_SOURCE),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=cell._environment(), creationflags=cell._NO_WINDOW, shell=False)
        for stream, label in ((self.process.stdout, 'stdout'), (self.process.stderr, 'stderr')):
            threading.Thread(target=self._read, args=(stream, label), daemon=True).start()
        self.process.stdin.write(contract.canonical({'seconds': seconds, 'expires_at': expires_at}) + b'\n')
        self.process.stdin.flush()
        deadline = self.monotonic() + 15
        while self.monotonic() < deadline:
            if stop_event.is_set():
                self.close_input()
                raise SetupError('OWNER_CLOSED', 'Preparation owner closed before readiness.')
            try:
                label, raw = self.frames.get(timeout=.1)
            except queue.Empty:
                if self.process.poll() is not None:
                    raise SetupError('HOLD_FAILED', 'The passive runtime hold ended before readiness.')
                continue
            if label != 'stdout' or len(raw) > 1024:
                raise SetupError('HOLD_PROTOCOL', 'The passive runtime hold returned unexpected metadata.')
            try:
                frame = cell._decode_frame(raw)
            except cell.ExecutionCellError as error:
                raise SetupError('HOLD_PROTOCOL', 'The passive runtime hold returned invalid metadata.') from error
            if frame != {'schema': 'yur.passive-runtime-hold.v1', 'state': 'holding'}:
                raise SetupError('HOLD_PROTOCOL', 'The passive runtime hold did not acknowledge readiness.')
            return
        raise SetupError('HOLD_TIMEOUT', 'The passive runtime hold did not become ready within 15 seconds.')

    def close_input(self):
        if self.process is not None:
            try:
                self.process.stdin.close()
            except (OSError, ValueError):
                pass

    def alive(self):
        return self.process is not None and self.process.poll() is None

    def release(self):
        if self.process is None:
            return True  # There is positively no owned process to release.
        self.close_input()
        try:
            code = self.process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            return False
        deadline = self.monotonic() + .5
        while self.monotonic() < deadline:
            try:
                label, raw = self.frames.get(timeout=.05)
            except queue.Empty:
                continue
            try:
                if label == 'stdout' and cell._decode_frame(raw) == {'schema': 'yur.passive-runtime-hold.v1', 'state': 'released'}:
                    self.released_frame = True
            except cell.ExecutionCellError:
                pass
        return code == 0 and self.released_frame


class ExecutionSetupSession:
    def __init__(self, manager_factory, *, runtime=None, hold_factory=PassiveHold,
                 monotonic=time.monotonic, utcnow=lambda: datetime.now(timezone.utc), on_state=lambda value: None):
        self.manager_factory, self.runtime, self.hold_factory = manager_factory, runtime or SystemRuntime(), hold_factory
        self.monotonic, self.utcnow, self.on_state = monotonic, utcnow, on_state
        self.session_id = str(uuid.uuid4())
        self.tokens = {}
        self.operation_id = None
        self.hold = None
        self.deadline = None
        self.last_setup = None
        self.automatic_cleanup_attempted = False
        self.stop_event = threading.Event()

    def owner_eof(self):
        # Safe on the pipe-reader thread: authoritative state stays on main thread.
        self.stop_event.set()
        if self.hold is not None:
            self.hold.close_input()

    def _manager(self, create=False):
        return self.manager_factory(create=create)

    def _response(self, setup):
        if setup is None:
            return {'setup': None, 'receipt': None}
        manager = self._manager()
        events = manager.runtime_setup_events(setup['operation_id'], limit=1)['events']
        keys = {'id', 'operation_id', 'revision', 'event_type', 'created_at', 'previous_hash', 'hash'}
        receipt = {key: events[0][key] for key in keys}
        return {'setup': setup, 'receipt': receipt}

    def inspect(self, operation_id):
        contract.validate_uuid(operation_id)
        manager = self._manager()
        return self._response(manager.get_runtime_setup(operation_id) if manager is not None else None)

    def check(self, distro=None, configuration_source='auto'):
        if configuration_source not in {'settings', 'operator', 'auto'}:
            raise SetupError('INVALID_REQUEST', 'Unsupported runtime selection source.')
        if self.operation_id is not None:
            raise SetupError('SESSION_ALREADY_USED', 'Inspect or release the existing preparation; use a new session for Check.')
        if getattr(self.runtime, 'environment', {}).get('YUR_EXECUTION_DISTRO') is not None:
            configuration_source = 'environment'
        resources, chosen, runtime, diagnostics, status = [], None, None, None, 'unknown'
        try:
            observed = self.runtime.observe(distro, configuration_source)
            resources, chosen = observed['resources'], observed['selected']
            configuration_source = observed['configuration_source']
            if chosen is None:
                diagnostics = _diagnostic('SELECTION_REQUIRED', 'Select one installed WSL2 resource; no fallback was selected.')
            elif chosen['state'] == 'stopped':
                status = 'stopped'
            else:
                try:
                    runtime = self.runtime.verify(chosen['distro'])
                    status = 'ready'
                except cell.ExecutionCellError as error:
                    outcome = (error.diagnostics or {}).get('outcome')
                    status = 'mismatch' if outcome in {'fingerprint_mismatch', 'nonzero_exit'} else 'unknown'
                    diagnostics = _diagnostic('RUNTIME_MISMATCH' if status == 'mismatch' else 'STATUS_UNKNOWN',
                                              'The selected running runtime could not satisfy the reviewed verification.')
                except (SetupError, ValueError, OSError):
                    diagnostics = _diagnostic('STATUS_UNKNOWN', 'Runtime verification did not complete safely.')
        except SetupError as error:
            diagnostics = _diagnostic(error.code, error.message)
        completed = self.utcnow()
        value = {'schema': CHECK_SCHEMA, 'status': status, 'checked_at': _iso(completed),
                 'expires_at': _iso(completed + timedelta(seconds=TOKEN_SECONDS)), 'resources': resources,
                 'selected_resource_id': chosen['resource_id'] if chosen else None,
                 'configuration_source': configuration_source, 'runtime': runtime, 'diagnostics': diagnostics,
                 'check_token': None, 'active_setup': None}
        manager = self._manager()
        if manager is not None:
            value['active_setup'] = manager.active_runtime_setup(None)
        self.tokens.clear()
        if chosen and status in {'ready', 'stopped'} and value['active_setup'] is None and not self.stop_event.is_set():
            token = str(uuid.uuid4())
            observation = {'resource': chosen, 'configuration_source': configuration_source}
            check = {'checked_at': value['checked_at'], 'expires_at': value['expires_at'],
                     'token_sha256': hashlib.sha256(token.encode()).hexdigest(), 'observation_sha256': contract.digest(observation),
                     'state': chosen['state'], 'configuration_source': configuration_source}
            self.tokens[token] = {'expires': self.monotonic() + TOKEN_SECONDS, 'resource': deepcopy(chosen),
                                  'observation': observation, 'check': check, 'operation_id': None}
            value['check_token'] = token
        return {'check': safe_private_token(value, 48 * 1024)}

    def _transition(self, manager, setup, state, evidence):
        try:
            result = manager.transition_runtime_setup(setup['operation_id'], setup['revision'], state, evidence,
                                                       owner_session_id=self.session_id)
        except (ValueError, OSError, RuntimeError) as error:
            raise SetupError('ACKNOWLEDGMENT_UNCERTAIN', 'Inspect the retained setup before retrying; no additional hold was started.') from error
        self.last_setup = result['setup']
        try:
            self.on_state({'type': 'state', 'operation_id': setup['operation_id'],
                           'setup': result['setup'], 'receipt': result['receipt']})
        except Exception:
            self.owner_eof()
            raise SetupError('OWNER_CLOSED', 'Preparation owner disconnected after a committed transition.')
        return result

    def prepare(self, operation_id, resource_id, check_token):
        contract.validate_uuid(operation_id); contract.validate_uuid(check_token); contract.validate_hash(resource_id)
        manager = self._manager()
        prior = manager.get_runtime_setup(operation_id) if manager else None
        if prior is not None:
            if prior['resource_id'] != resource_id or prior['check']['token_sha256'] != hashlib.sha256(check_token.encode()).hexdigest():
                raise SetupError('OPERATION_MISMATCH', 'This operation belongs to a different resource or check.')
            return {**self._response(prior), 'replayed': True}
        token = self.tokens.get(check_token)
        if self.operation_id is not None or token is None or token['operation_id'] is not None:
            raise SetupError('INVALID_TOKEN', 'Prepare requires this session\'s unused Check token.')
        if self.stop_event.is_set() or self.monotonic() >= token['expires']:
            raise SetupError('TOKEN_EXPIRED', 'Check token expired or its owner closed; check again.')
        if token['resource']['resource_id'] != resource_id:
            raise SetupError('RESOURCE_MISMATCH', 'Check token belongs to a different resource.')
        observed = self.runtime.observe(token['resource']['distro'], token['check']['configuration_source'])
        fresh = {'resource': observed['selected'], 'configuration_source': observed['configuration_source']}
        if fresh != token['observation']:
            raise SetupError('SOURCE_CHANGED', 'Runtime selection or observed state changed; check again.')
        if self.stop_event.is_set() or self.monotonic() >= token['expires']:
            raise SetupError('TOKEN_EXPIRED', 'Check token expired before acceptance; check again.')
        token['operation_id'] = operation_id
        self.operation_id = operation_id
        manager = self._manager(create=True)
        accepted_at = self.monotonic()
        try:
            accepted = manager.accept_runtime_setup(operation_id, resource_id, token['resource']['distro'],
                token['check'], contract.mint_authority(operation_id, resource_id), self.session_id)
        except (ValueError, OSError, RuntimeError) as error:
            raise SetupError('ACKNOWLEDGMENT_UNCERTAIN', 'Preparation acceptance was interrupted; inspect this operation before retrying.') from error
        if accepted['replayed']:
            return accepted
        setup = accepted['setup']
        self.last_setup = setup
        self.deadline = accepted_at + contract.MAX_HOLD_SECONDS
        evidence = contract.empty_evidence()
        setup = self._transition(manager, setup, 'starting', evidence)['setup']
        self.hold = self.hold_factory()
        try:
            if self.stop_event.is_set():
                raise SetupError('OWNER_CLOSED', 'Preparation owner closed before launch.')
            self.hold.start(setup['distro'], max(0, self.deadline - self.monotonic()),
                            contract.timestamp(setup['expires_at']).timestamp(), self.stop_event)
            # This records a start attempt from observed stopped state, not
            # exclusive ownership of distribution startup or shutdown rights.
            evidence['started_by_this_setup'] = token['resource']['state'] == 'stopped'
            if self.stop_event.is_set():
                raise SetupError('OWNER_CLOSED', 'Preparation owner closed before verification.')
            runtime = self.runtime.verify(setup['distro'])
            if self.stop_event.is_set() or not self.hold.alive() or self.monotonic() >= self.deadline:
                raise SetupError('HOLD_ENDED', 'The owned hold ended before readiness could be committed.')
            evidence['runtime'] = runtime
            return self._transition(manager, setup, 'ready', evidence)
        except Exception as error:
            self.automatic_cleanup_attempted = True
            confirmed = self.hold.release()
            current = manager.get_runtime_setup(operation_id)
            evidence = deepcopy(current['evidence'])
            if evidence['started_by_this_setup'] is None:
                launched = self.hold.process is not None if isinstance(self.hold, PassiveHold) else bool(getattr(self.hold, 'started', False))
                evidence['started_by_this_setup'] = launched and token['resource']['state'] == 'stopped'
            evidence.update(owned_process_exit_confirmed=confirmed, release_reason='verification_failed', error=_failure(error))
            try:
                self._transition(manager, current, 'failed' if confirmed else 'uncertain', evidence)
            except SetupError:
                pass
            raise SetupError('PREPARE_FAILED', 'Preparation failed; its retained record contains the cleanup outcome.') from error

    def release(self, operation_id, reason='operator'):
        contract.validate_uuid(operation_id)
        try:
            manager = self._manager()
            setup = manager.get_runtime_setup(operation_id) if manager else None
        except (ValueError, OSError, RuntimeError) as error:
            if operation_id == self.operation_id and self.hold is not None:
                self.automatic_cleanup_attempted = True
                self.hold.release()
            raise SetupError('ACKNOWLEDGMENT_UNCERTAIN', 'The retained setup could not be read; only the current session owned hold was closed.') from error
        if setup is None:
            return {'setup': None, 'receipt': None, 'replayed': True}
        if setup['state'] not in contract.ACTIVE_STATES:
            return {**self._response(setup), 'replayed': True}
        if setup['owner_session_id'] != self.session_id or self.operation_id != operation_id:
            raise SetupError('FOREIGN_OWNER', 'This session cannot release another owner\'s hold; retained truth remains available to inspect.')
        evidence = deepcopy(setup['evidence'])
        if setup['state'] != 'releasing':
            try:
                setup = self._transition(manager, setup, 'releasing', evidence)['setup']
            except SetupError:
                # Closing our exact owned pipe must not depend on a journal
                # acknowledgment. Keep the retained nonterminal truth until an
                # explicit retry can record the observed cleanup outcome.
                self.automatic_cleanup_attempted = True
                if self.hold is not None:
                    self.hold.release()
                raise
        confirmed = self.hold.release() if self.hold is not None else True
        evidence['owned_process_exit_confirmed'] = confirmed
        evidence['release_reason'] = reason
        if not confirmed:
            evidence['error'] = _failure(SetupError('RELEASE_UNCONFIRMED', 'Owned hold exit was not confirmed; no distribution shutdown was attempted.'))
            state = 'uncertain'
        else:
            evidence['error'] = None
            state = 'expired' if reason == 'deadline' and self.utcnow() >= contract.timestamp(setup['expires_at']) else 'released'
        return self._transition(manager, setup, state, evidence)

    def tick(self):
        if (self.operation_id is None or self.last_setup is None or self.last_setup['state'] not in contract.ACTIVE_STATES
                or self.automatic_cleanup_attempted):
            return
        if self.stop_event.is_set():
            self.automatic_cleanup_attempted = True
            self.release(self.operation_id, 'owner_eof')
        elif self.deadline is not None and self.monotonic() >= self.deadline:
            self.automatic_cleanup_attempted = True
            self.release(self.operation_id, 'deadline')
        elif self.hold is not None and not self.hold.alive():
            self.automatic_cleanup_attempted = True
            self.release(self.operation_id, 'process_exit')

    def close(self):
        self.owner_eof()
        if self.operation_id is not None and not self.automatic_cleanup_attempted:
            self.automatic_cleanup_attempted = True
            try:
                self.release(self.operation_id, 'owner_eof')
            except Exception:
                pass  # Unconfirmed durable state is deliberately not fabricated.
