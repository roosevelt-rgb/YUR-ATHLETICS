"""Bounded offline speech acquisition; never stores audio or executes transcript."""
from __future__ import annotations
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import sys
import uuid

from .sources import read_checked, reject_reparse

RATE = 16000
MAX_SECONDS = 60
MAX_AUDIO_BYTES = RATE * 2 * MAX_SECONDS
MAX_REQUEST_BYTES = 3 * 1024 * 1024
MODEL_NAME = 'vosk-model-small-en-us-0.15'


def model_root():
    root = Path(os.environ.get('YUR_VOICE_MODEL') or Path(__file__).resolve().parents[1] / '.desktop-models' / MODEL_NAME)
    if not root.is_absolute() or '..' in root.parts: raise ValueError('Voice model requires an absolute local path')
    reject_reparse(root)
    return root


def info():
    root = model_root()
    ready = importlib.util.find_spec('vosk') is not None and (root / 'yur-model-source.json').is_file() and (root / 'am/final.mdl').is_file()
    return {'ready': ready, 'model': root.name, 'language': 'en-US', 'max_seconds': MAX_SECONDS, 'sample_rate': RATE,
            'local': True, 'setup': '' if ready else 'Run Setup Offline Voice.cmd in the desktop folder.'}


def checked_model():
    root = model_root()
    manifest = json.loads(read_checked(root, 'yur-model-source.json', 128 * 1024))
    files = manifest.get('files')
    if not isinstance(files, dict) or not 1 <= len(files) <= 200: raise ValueError('Invalid voice model manifest')
    total = 0
    for relative, sha in files.items():
        path = PurePosixPath(relative)
        if path.is_absolute() or '..' in path.parts or '\\' in relative or ':' in relative or not relative:
            raise ValueError('Invalid voice model path')
        content = read_checked(root, relative, 128 * 1024 * 1024)
        total += len(content)
        if total > 200 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != sha:
            raise ValueError('Voice model bytes differ from the installed manifest')
    if not {'am/final.mdl', 'conf/model.conf'}.issubset(files): raise ValueError('Incomplete voice model manifest')
    return root, hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def transcribe(request):
    if not isinstance(request, dict) or set(request) != {'request_id', 'sample_rate', 'pcm_base64'}:
        raise ValueError('Dictation requires bounded PCM audio and a request identifier')
    if not isinstance(request['request_id'], str) or str(uuid.UUID(request['request_id'])) != request['request_id']:
        raise ValueError('Invalid voice request identifier')
    if type(request['sample_rate']) is not int or request['sample_rate'] != RATE: raise ValueError('Dictation requires 16 kHz mono signed 16-bit PCM')
    encoded = request['pcm_base64']
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_AUDIO_BYTES * 4 // 3 + 4:
        raise ValueError('Dictation audio exceeds 60 seconds')
    try: pcm = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error: raise ValueError('Invalid PCM encoding') from error
    if not pcm or len(pcm) % 2 or len(pcm) > MAX_AUDIO_BYTES or base64.b64encode(pcm).decode() != encoded:
        raise ValueError('Invalid PCM length or encoding')
    root, model_hash = checked_model()
    import vosk
    vosk.SetLogLevel(-1)
    model = vosk.Model(str(root))
    recognizer = vosk.KaldiRecognizer(model, RATE)
    recognizer.SetWords(True)
    parts, words = [], []
    for offset in range(0, len(pcm), 8000):
        if recognizer.AcceptWaveform(pcm[offset:offset + 8000]):
            result = json.loads(recognizer.Result()); parts.append(result.get('text', '')); words.extend(result.get('result', []))
    result = json.loads(recognizer.FinalResult()); parts.append(result.get('text', '')); words.extend(result.get('result', []))
    text = ' '.join(part.strip() for part in parts if part.strip())
    if len(text) > 16000 or len(words) > 4000: raise ValueError('Dictation result exceeds its text budget')
    return {'request_id': request['request_id'], 'text': text, 'audio_sha256': hashlib.sha256(pcm).hexdigest(),
            'samples': len(pcm) // 2, 'seconds': len(pcm) / (RATE * 2), 'model': root.name, 'model_sha256': model_hash,
            'local': True, 'words': words, 'audio_retained': False}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES: raise ValueError('Voice input exceeds 3 MiB')
        request = json.loads(raw)
        if request == {'command': 'info'}: result = info()
        elif isinstance(request, dict) and set(request) == {'command', 'request'} and request['command'] == 'transcribe': result = transcribe(request['request'])
        else: raise ValueError('Unsupported voice request')
        response = {'ok': True, 'result': result}
    except Exception as error:
        response = {'ok': False, 'error': {'code': 'VOICE_FAILED', 'message': str(error)[:1000]}}
    sys.stdout.write(json.dumps(response, ensure_ascii=True))
    return 0 if response['ok'] else 1


if __name__ == '__main__': raise SystemExit(main())
