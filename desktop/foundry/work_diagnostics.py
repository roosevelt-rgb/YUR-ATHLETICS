"""Bounded failure metadata for committed Work events; no raw error payloads."""
from __future__ import annotations

from copy import deepcopy
import math
import json
import re
from .repository_context import SECRET_CONTENT

_HASH = re.compile(r'[0-9a-f]{64}')
_DISTRO = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
_EXECUTION_PHASES = {'wsl_status', 'runtime_selection', 'runtime_verification'}
_EXECUTION_OUTCOMES = {'timeout', 'os_error', 'nonzero_exit', 'output_limit',
                       'selected_not_running', 'invalid_selection', 'ambiguous_selection',
                       'malformed_response', 'fingerprint_mismatch'}


def _integer(value, minimum=0, maximum=2**63 - 1):
    return type(value) is int and minimum <= value <= maximum


def safe_diagnostic(value):
    """Return a detached exact-version record, or None for unknown/malformed data."""
    if type(value) is not dict:
        return None
    schema = value.get('schema')
    if schema == 'yur.execution-diagnostic.v1':
        required = {'schema', 'phase', 'outcome'}
        optional = {'timeout_seconds', 'errno', 'winerror', 'returncode', 'stdout_bytes', 'stderr_bytes',
                    'stdout_sha256', 'stderr_sha256', 'selected_distro', 'running_distros',
                    'running_distros_truncated'}
        if not required <= set(value) <= required | optional:
            return None
        if (type(value['phase']) is not str or type(value['outcome']) is not str
                or value['phase'] not in _EXECUTION_PHASES or value['outcome'] not in _EXECUTION_OUTCOMES):
            return None
        for key, item in value.items():
            if key == 'timeout_seconds' and (type(item) not in (int, float) or not 0 < item <= 3600 or not math.isfinite(item)):
                return None
            if key in {'errno', 'winerror', 'returncode'} and not _integer(item, -(2**31), 2**32 - 1):
                return None
            if key in {'stdout_bytes', 'stderr_bytes'} and not _integer(item):
                return None
            if key in {'stdout_sha256', 'stderr_sha256'} and (type(item) is not str or not _HASH.fullmatch(item)):
                return None
            if key == 'selected_distro' and (type(item) is not str or not _DISTRO.fullmatch(item) or SECRET_CONTENT.search(item)):
                return None
            if key == 'running_distros':
                if (type(item) is not list or len(item) > 32
                        or any(type(name) is not str or not _DISTRO.fullmatch(name) or SECRET_CONTENT.search(name) for name in item)
                        or item != sorted(set(item))):
                    return None
            if key == 'running_distros_truncated' and type(item) is not bool:
                return None
    elif schema == 'yur.work-provider-diagnostic.v1':
        required = {'schema', 'provider', 'outcome', 'done_reason', 'content_chars', 'thinking_chars', 'tool_call_count'}
        if not required <= set(value) <= required | {'eval_count', 'prompt_eval_count'}:
            return None
        if (value['provider'] != 'ollama' or value['outcome'] != 'empty_response'
                or type(value['done_reason']) is not str
                or value['done_reason'] not in {'stop', 'length', 'load', 'unload', 'missing', 'other'}):
            return None
        if any(not _integer(value[key]) for key in set(value) - {'schema', 'provider', 'outcome', 'done_reason'}):
            return None
    else:
        return None
    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) > 4096:
        return None
    return deepcopy(value)


def failure_change(error):
    """Inspect only known host exceptions and explicit causes, bounded to 8 links.

    A wrapper preserves the pending operation on an interrupted acknowledgment;
    its known cause may retain useful metadata. Implicit exception context and
    arbitrary attributes, messages, commands and output streams are never copied.
    """
    from .execution_cell import ExecutionCellError
    from .work_provider import EmptyWorkResponse

    change = {'error_type': type(error).__name__}
    seen = set()
    current = error
    for _ in range(8):
        if not isinstance(current, BaseException) or id(current) in seen:
            break
        seen.add(id(current))
        if type(current) in {ExecutionCellError, EmptyWorkResponse}:
            diagnostic = safe_diagnostic(getattr(current, 'diagnostics', None))
            if diagnostic is not None:
                change['diagnostics'] = diagnostic
                break
        current = current.__cause__
    return change
