"""Code-mode execution-cell binding under the existing Work manager and store.

Source snapshots and cell results commit before model continuation. The external
cell receives only selected source bytes; it never receives a host folder mount.
"""
from copy import deepcopy
import hashlib
import json
import re

from .sources import read_checked, reject_reparse
from .specialists import validate_schema
from .repository_context import SECRET_CONTENT
from .work_store import now
from .work_tools import _root, _relative, execute_tool

TOOL = 'run_python_checks'
PROFILES = ['python-unittest-serial', 'python-compile-serial']
SNAPSHOT = 'work.cell.snapshot.committed'
RESULT = 'work.cell.result.committed'
MAX_SOURCE_BYTES = 128 * 1024
INPUT = {'type': 'object', 'additionalProperties': False, 'required': ['files', 'profile', 'test_directory', 'proposal_ids'], 'properties': {
    'files': {'type': 'array', 'minItems': 1, 'maxItems': 32, 'items': {'type': 'string', 'minLength': 1, 'maxLength': 240}},
    'profile': {'type': 'string', 'enum': PROFILES},
    'test_directory': {'type': 'string', 'minLength': 1, 'maxLength': 240},
    'proposal_ids': {'type': 'array', 'maxItems': 20, 'items': {'type': 'string', 'minLength': 32, 'maxLength': 32}},
}}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def _hash(value):
    return hashlib.sha256(_canonical(value)).hexdigest()


def catalog():
    return [{'name': TOOL, 'description': 'In Code mode, compile or run serial Python unittest checks on an exact bounded source snapshot, optionally including this mission\'s existing edit proposals. Requires an already-running admitted WSL/Bubblewrap runtime. No network, host filesystem mount, subprocesses, threads or package installation. Scratch changes are discarded; existing edits still require review. Report the actual exit status, not certification.',
             'input_schema': deepcopy(INPUT), 'output_schema': {'type': 'object', 'additionalProperties': False,
             'required': ['schema', 'tool', 'status', 'committed', 'execution', 'snapshot', 'provenance'], 'properties': {
                 'schema': {'type': 'string', 'enum': ['yur.work-cell-result.v1']}, 'tool': {'type': 'string', 'enum': [TOOL]},
                 'status': {'type': 'string', 'enum': ['recorded']}, 'committed': {'type': 'boolean', 'enum': [True]},
                 'execution': {'type': 'object', 'additionalProperties': True}, 'snapshot': {'type': 'object', 'additionalProperties': True},
                 'provenance': {'type': 'object', 'additionalProperties': True}}},
             'permissions': ['read', 'compute'], 'runtime': {'resource': 'python-serial-cell', 'requires': ['running WSL guest', 'Bubblewrap', 'libseccomp'], 'network': False, 'host_writes': False},
             'limits': {'files': 32, 'source_bytes': MAX_SOURCE_BYTES, 'processes': 1},
             'rollback': {'behavior': 'scratch discarded; committed source snapshot and result retained'}}]


def _current(manager, supplied):
    if getattr(manager.store, '_lock_file', None) is None:
        raise RuntimeError('Execution cells require the existing exclusive Work worker lock')
    current = manager.store.get_work(supplied['id'])
    if (current['status'] != 'running' or current['revision'] != supplied['revision'] or current['steps'] != supplied['steps']
            or current['request']['mode'] != 'code' or not {'read', 'compute'} <= set(current['authority']['actions'])):
        raise ValueError('Cell execution requires the current Code-mode mission and bounded read/compute authority')
    return current


def _events(manager, parent):
    return [event for event in manager.store.work_events(parent['id'])
            if event['event_type'] in {SNAPSHOT, RESULT} and event['data']['change'].get('step_index') == len(parent['steps'])]


def check_step_binding(manager, parent, name, arguments):
    for event in _events(manager, parent):
        if name != TOOL or event['data']['change']['input_hash'] != _hash(arguments):
            raise ValueError('This Work step is already bound to a different execution snapshot request')


def pending_call(manager, parent):
    """Resume a committed cell request before asking a model to choose new work."""
    accepted = next((event for event in _events(manager, parent) if event['event_type'] == SNAPSHOT), None)
    if accepted is None:
        return None
    arguments = deepcopy(accepted['data']['change']['arguments'])
    validate_schema(arguments, INPUT)
    if _hash(arguments) != accepted['data']['change']['input_hash']:
        raise ValueError('Committed cell request failed input validation')
    return {'function': {'name': TOOL, 'arguments': arguments}}


def _record(manager, parent, kind, change):
    current = manager.store.get_work(parent['id'])
    if current['status'] != 'running' or current['steps'] != parent['steps']:
        raise ValueError('Work changed while its execution cell was running')
    document = {key: deepcopy(value) for key, value in current.items() if key not in {'revision', 'receipt'}}
    document['updated_at'] = now()
    committed = manager.store.commit_work_checkpoint(document, current['revision'], kind, change)
    return next(event for event in manager.store.work_events(parent['id']) if event['revision'] == committed['revision'])


def _snapshot(parent, args):
    root = _root(parent['request']['root'])
    paths = [_relative(value) for value in args['files']]
    if len(set(path.casefold() for path in paths)) != len(paths) or any(not path.endswith('.py') for path in paths):
        raise ValueError('Select distinct Python source paths')
    directory = _relative(args['test_directory'], directory=True)
    overlays = {}
    if len(set(args['proposal_ids'])) != len(args['proposal_ids']):
        raise ValueError('Proposal identifiers must be distinct')
    for identity in args['proposal_ids']:
        if not re.fullmatch(r'[0-9a-f]{32}', identity):
            raise ValueError('Select a committed edit-proposal identifier')
        item = next((item for item in parent['artifacts'] if item['id'] == identity), None)
        if not item or item['proposal'].get('kind') != 'edit':
            raise ValueError('Cell overlays must be this Work mission\'s edit proposals')
        proposal = item['proposal']
        checked = execute_tool('propose_edit', {key: proposal[key] for key in ('path', 'content', 'expected_sha256')}, root)['proposal']
        if checked != proposal or proposal['path'] not in paths or proposal['path'] in overlays:
            raise ValueError('Overlay is stale, duplicated or outside the selected snapshot')
        overlays[proposal['path']] = proposal
    files, sources, used = [], [], 0
    for relative in paths:
        target = root / relative; reject_reparse(target)
        original = None
        if target.exists():
            raw = read_checked(root, relative, min(64 * 1024, MAX_SOURCE_BYTES - used))
            original = hashlib.sha256(raw).hexdigest()
        elif relative in overlays and overlays[relative]['expected_sha256'] is None:
            raw = b''
        else:
            raise ValueError('Selected snapshot source does not exist')
        if relative in overlays:
            raw = overlays[relative]['content'].encode('utf-8')
        used += len(raw)
        if used > MAX_SOURCE_BYTES:
            raise ValueError('Execution snapshot exceeds 128 KiB')
        content = raw.decode('utf-8')
        if SECRET_CONTENT.search(content):
            raise ValueError('Credential-like source cannot enter an execution snapshot')
        files.append({'path': relative, 'content': content, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
        sources.append({'path': relative, 'original_sha256': original, 'staged_sha256': files[-1]['sha256'], 'overlay': relative in overlays})
    body = {'schema': 'yur.execution-snapshot.v1', 'profile': args['profile'], 'test_directory': directory, 'files': files}
    from .execution_cell import validate_snapshot, ExecutionCellError
    try:
        snapshot = validate_snapshot({**body, 'id': _hash(body)})
    except ExecutionCellError as error:
        raise ValueError(str(error)) from error
    return snapshot, sources


def execute(manager, supplied, arguments, runner=None, on_event=None):
    validate_schema(arguments, INPUT)
    parent = _current(manager, supplied)
    check_step_binding(manager, parent, TOOL, arguments)
    binding = {'step_index': len(parent['steps']), 'input_hash': _hash(arguments)}
    events = _events(manager, parent)
    completed = next((event for event in events if event['event_type'] == RESULT), None)
    if completed:
        recovered = deepcopy(completed['data']['change']['result'])
        recovered['provenance']['result_receipt'] = completed['hash']
        return recovered
    accepted = next((event for event in events if event['event_type'] == SNAPSHOT), None)
    if accepted is None:
        snapshot, sources = _snapshot(parent, arguments)
        change = {**binding, 'arguments': deepcopy(arguments), 'snapshot': snapshot, 'sources': sources,
                  'authority_source': 'local-user Code mode; bounded read and compute'}
        try:
            accepted = _record(manager, parent, SNAPSHOT, change)
        except (ValueError, OSError, TypeError, KeyError) as error:
            try:
                retained = [event for event in _events(manager, parent) if event['event_type'] == SNAPSHOT]
                if len(retained) > 1 or any(event['data']['change'] != change for event in retained):
                    raise ValueError('Retained execution snapshot differs from its exact request')
            except Exception as resolution_error:
                raise RuntimeError('Execution snapshot acknowledgment is uncertain; resume this Work request to resolve its retained snapshot') from resolution_error
            if retained:
                raise RuntimeError('Execution snapshot was committed but its acknowledgment was interrupted; resume the same Work request') from error
            raise
    snapshot = accepted['data']['change']['snapshot']
    if runner is None:
        from .execution_cell import run_snapshot
        runner = run_snapshot
    execution = runner(deepcopy(snapshot), on_event=on_event)
    fields = {'schema', 'snapshot_id', 'profile', 'status', 'exit_code', 'stdout', 'stderr', 'stdout_bytes', 'stderr_bytes', 'stdout_sha256', 'stderr_sha256', 'duration_ms', 'runtime', 'limits', 'scratch'}
    if not isinstance(execution, dict) or set(execution) != fields or execution.get('schema') != 'yur.execution-cell-result.v1' or execution.get('snapshot_id') != snapshot['id'] or execution.get('profile') != snapshot['profile']:
        raise ValueError('Execution cell returned a mismatched snapshot result')
    if (execution.get('status') not in {'completed', 'failed', 'timeout', 'output_limit', 'cancelled'}
            or type(execution.get('exit_code')) is not int or not -255 <= execution['exit_code'] <= 255
            or type(execution.get('duration_ms')) is not int or not 0 <= execution['duration_ms'] <= 15000
            or not isinstance(execution.get('runtime'), dict) or not isinstance(execution.get('limits'), dict)
            or execution.get('scratch') != 'discarded'
            or (execution['status'] == 'completed' and execution['exit_code'] != 0)
            or (execution['status'] == 'failed' and execution['exit_code'] == 0)):
        raise ValueError('Execution cell returned an invalid terminal result')
    for stream in ('stdout', 'stderr'):
        text = execution.get(stream)
        if not isinstance(text, str) or len(text.encode('utf-8')) > 65536 or type(execution.get(stream + '_bytes')) is not int or execution.get(stream + '_bytes') != len(text.encode('utf-8')) or execution.get(stream + '_sha256') != hashlib.sha256(text.encode('utf-8')).hexdigest():
            raise ValueError('Execution output failed byte/hash validation')
    if execution['stdout_bytes'] + execution['stderr_bytes'] > 65536 or len(_canonical(execution)) > 160 * 1024:
        raise ValueError('Execution result exceeds its committed byte budget')
    result = {'schema': 'yur.work-cell-result.v1', 'tool': TOOL, 'status': 'recorded', 'committed': True, 'execution': execution,
              'snapshot': {'id': snapshot['id'], 'profile': snapshot['profile'], 'sources': accepted['data']['change']['sources']},
              'provenance': {'parent_work_id': parent['id'], 'step_index': binding['step_index'], 'input_hash': binding['input_hash'], 'snapshot_receipt': accepted['hash']}}
    try:
        committed = _record(manager, parent, RESULT, {**binding, 'snapshot_id': snapshot['id'], 'result': result})
        result['provenance']['result_receipt'] = committed['hash']
    except (ValueError, OSError, TypeError, KeyError) as error:
        raise RuntimeError('Execution finished but its acknowledgment was interrupted; resume the retained snapshot to recover any committed result') from error
    return result
