"""Fixed operator setup session over bounded NDJSON; ordinary Work RPC is separate."""
from __future__ import annotations

import json
import queue
import sys
import threading
import time

from . import runtime_setup_contract as contract
from .conversation_cli import _object, state_root
from .execution_setup import ExecutionSetupSession, SetupError, _failure, safe_private_token

MAX_FRAME_BYTES = 8192
MAX_INPUT_BYTES = 128 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_REQUESTS = 64
MAX_SESSION_SECONDS = 1200


def validate_request(value):
    fields = {
        'check': {'request_id', 'command', 'distro', 'configuration_source'},
        'prepare': {'request_id', 'command', 'operation_id', 'resource_id', 'check_token'},
        'inspect': {'request_id', 'command', 'operation_id'},
        'release': {'request_id', 'command', 'operation_id'},
    }
    if type(value) is not dict or value.get('command') not in fields or set(value) != fields[value['command']]:
        raise ValueError('Unsupported execution setup command or fields')
    contract.validate_uuid(value['request_id'])
    if value['command'] == 'check':
        if value['distro'] is not None:
            contract.validate_distro(value['distro'])
        if value['configuration_source'] not in {'operator', 'settings', 'auto'}:
            raise ValueError('Invalid execution selection source')
    else:
        contract.validate_uuid(value['operation_id'])
    if value['command'] == 'prepare':
        contract.validate_uuid(value['check_token'])
        contract.validate_hash(value['resource_id'])
    return safe_private_token(value, MAX_FRAME_BYTES)


def dispatch(session, request):
    value = validate_request(request)
    command = value['command']
    if command == 'check':
        return session.check(value['distro'], value['configuration_source'])
    if command == 'prepare':
        return session.prepare(value['operation_id'], value['resource_id'], value['check_token'])
    if command == 'inspect':
        return session.inspect(value['operation_id'])
    return session.release(value['operation_id'])


def serve(input_stream, output_stream, manager_factory, *, runtime=None, hold_factory=None,
          monotonic=time.monotonic):
    """One serialized owner pipe. Reader may close a hold, never write the store."""
    incoming = queue.Queue(maxsize=8)
    sent, seen = 0, {}
    writer_lock = threading.Lock()

    def emit(value):
        nonlocal sent
        data = contract.canonical(value) + b'\n'
        if sent + len(data) > MAX_OUTPUT_BYTES:
            raise SetupError('OUTPUT_LIMIT', 'Execution setup session exceeded its output budget.')
        with writer_lock:
            output_stream.write(data)
            output_stream.flush()
            sent += len(data)

    options = {'runtime': runtime, 'monotonic': monotonic, 'on_state': emit}
    if hold_factory is not None:
        options['hold_factory'] = hold_factory
    session = ExecutionSetupSession(manager_factory, **options)

    def receive():
        total = 0
        try:
            while True:
                raw = input_stream.readline(MAX_FRAME_BYTES + 1)
                if not raw:
                    session.owner_eof()
                    incoming.put(('eof', None), timeout=1)
                    return
                total += len(raw)
                if len(raw) > MAX_FRAME_BYTES or total > MAX_INPUT_BYTES or not raw.endswith(b'\n'):
                    raise ValueError('Invalid setup frame budget')
                value = json.loads(raw.decode('utf-8'), object_pairs_hook=_object,
                                   parse_constant=lambda _value: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
                incoming.put(('request', value), timeout=1)
        except Exception:
            session.owner_eof()
            try:
                incoming.put(('protocol', None), timeout=1)
            except queue.Full:
                pass

    threading.Thread(target=receive, daemon=True).start()
    deadline = monotonic() + MAX_SESSION_SECONDS
    try:
        while monotonic() < deadline:
            session.tick()
            try:
                kind, value = incoming.get(timeout=.25)
            except queue.Empty:
                if session.stop_event.is_set():
                    break
                continue
            if kind == 'eof':
                break
            if kind == 'protocol':
                return 1
            identity = {'request_id': None, 'command': None}
            try:
                request = validate_request(value)
                identity = {key: request[key] for key in identity}
                digest = contract.digest(request)
                if request['request_id'] in seen and seen[request['request_id']] != digest:
                    raise SetupError('REQUEST_REUSED', 'This request identifier belongs to different input.')
                if request['request_id'] not in seen and len(seen) >= MAX_REQUESTS:
                    raise SetupError('REQUEST_LIMIT', 'Execution setup session exceeded its request limit.')
                seen[request['request_id']] = digest
                result = dispatch(session, request)
                emit({'type': 'result', **identity, 'ok': True, 'result': result})
            except (ValueError, TypeError, KeyError, OSError, RuntimeError) as error:
                failure = _failure(error, 'INVALID_REQUEST')
                emit({'type': 'result', **identity, 'ok': False, 'error': failure})
        return 0
    except (BrokenPipeError, OSError, ValueError, RuntimeError):
        return 1
    finally:
        session.close()


def main():
    # No state directory or manager is opened until a state operation needs it.
    # Check on a fresh profile therefore cannot create a database or schema.
    manager = None

    def get_manager(*, create=False):
        nonlocal manager
        if manager is not None:
            return manager
        root = state_root()
        if not create and not (root / 'foundry.sqlite3').is_file():
            return None
        from .commit_service import CommitService
        from .orchestration import OrchestrationManager
        manager = OrchestrationManager(CommitService(root))
        return manager

    try:
        return serve(sys.stdin.buffer, sys.stdout.buffer, get_manager)
    finally:
        if manager is not None:
            manager.store.close()


if __name__ == '__main__':
    raise SystemExit(main())
