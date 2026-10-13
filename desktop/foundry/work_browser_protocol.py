"""Fixed optional Work/browser pipe framing; no general IPC or orchestration."""
import json
import os
import queue
import threading
import weakref

from .work_browser import (MAX_RESULT_BYTES, validate_acquisition_request,
                           validate_acquisition_reply, error_reply)

MAX_INITIAL_BYTES = 256 * 1024 + 1024
MAX_REPLY_BYTES = MAX_RESULT_BYTES + 4096
MAX_TIMEOUT_SECONDS = 5
_READERS = weakref.WeakKeyDictionary()


class _LineReader:
    """Raw OS reads avoid a daemon holding stdin's buffered lock at exit.

    Initial input and the reply share this reader, including bytes after the
    first newline. Synthetic streams without a file descriptor remain supported.
    """
    def __init__(self, stream):
        try:
            self.fd = stream.fileno()
        except (AttributeError, OSError, ValueError):
            self.fd = None
        self.fallback = stream if self.fd is None else None
        self.buffer = b''

    def readline(self, maximum):
        if self.fd is None:
            return self.fallback.readline(maximum)
        while True:
            end = self.buffer.find(b'\n')
            if end >= 0:
                if end + 1 > maximum:
                    raise ValueError('Browser protocol frame exceeds its bound')
                value, self.buffer = self.buffer[:end + 1], self.buffer[end + 1:]
                return value
            if len(self.buffer) >= maximum:
                raise ValueError('Browser protocol frame exceeds its bound')
            data = os.read(self.fd, min(16384, maximum - len(self.buffer)))
            if not data:
                value, self.buffer = self.buffer, b''
                return value
            self.buffer += data


def _reader(stream):
    if stream not in _READERS:
        _READERS[stream] = _LineReader(stream)
    return _READERS[stream]


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate browser protocol field')
        value[key] = item
    return value


def _read(stream, maximum):
    raw = _reader(stream).readline(maximum + 1)
    if type(raw) is not bytes or not raw or len(raw) > maximum or not raw.endswith(b'\n'):
        raise ValueError('Browser protocol requires one bounded newline JSON frame')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique,
                       parse_constant=lambda _value: (_ for _ in ()).throw(ValueError('Nonfinite browser frame')))
    if type(value) is not dict:
        raise ValueError('Browser protocol requires a JSON object')
    return value


def read_initial(input_stream, maximum=MAX_INITIAL_BYTES):
    if type(maximum) is not int or not 1 <= maximum <= MAX_INITIAL_BYTES:
        raise ValueError('Initial Work frame budget is invalid')
    return _read(input_stream, maximum)


def create_acquirer(input_stream, emit, *, timeout_seconds=MAX_TIMEOUT_SECONDS):
    """Return the one fixed callback for a Work process's private owner pipe.

    emit uses the existing Work CLI stdout budget. A daemon reads only one
    bounded reply, and never touches state. The channel is single acquisition;
    an exact repeat returns its already-validated reply without another read.
    """
    if type(timeout_seconds) not in (int, float) or not 0 < timeout_seconds <= MAX_TIMEOUT_SECONDS or not callable(emit):
        raise ValueError('Browser protocol requires a bounded deadline and output callback')
    previous, cached, active = None, None, False

    def acquire(frame):
        nonlocal previous, cached, active
        checked = validate_acquisition_request(frame)
        if previous is not None:
            if previous == checked and cached is not None:
                return json.loads(json.dumps(cached))
            return error_reply(checked, 'BROKER_ALREADY_USED', 'This owner pipe has already handled its single page acquisition.')
        if active:
            return error_reply(checked, 'BROKER_BUSY', 'Another page acquisition is already pending.')
        previous, active = checked, True
        results = queue.Queue(maxsize=1)
        def receive():
            try:
                results.put(('value', _read(input_stream, MAX_REPLY_BYTES)))
            except Exception:
                results.put(('error', None))
        try:
            emit(checked)
            threading.Thread(target=receive, daemon=True).start()
            try:
                kind, value = results.get(timeout=timeout_seconds)
            except queue.Empty:
                cached = error_reply(checked, 'BROKER_TIMEOUT', 'The page acquisition broker did not reply within five seconds.')
            else:
                if kind == 'error':
                    cached = error_reply(checked, 'BROKER_CLOSED', 'The page acquisition owner pipe closed or returned an invalid frame.')
                else:
                    try:
                        cached = validate_acquisition_reply(checked, value)
                    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
                        cached = error_reply(checked, 'INVALID_BROKER_REPLY', 'The page acquisition reply did not match its exact request or evidence bounds.')
        except (OSError, ValueError, RuntimeError):
            cached = error_reply(checked, 'BROKER_CLOSED', 'The page acquisition owner pipe could not accept its request.')
        finally:
            active = False
        return json.loads(json.dumps(cached))
    return acquire
