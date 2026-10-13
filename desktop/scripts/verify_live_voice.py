"""Opt-in offline recognition check against an explicit, non-microphone WAV."""
import argparse
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import uuid
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from foundry.voice import transcribe

parser = argparse.ArgumentParser()
parser.add_argument('wave_file', type=Path)
parser.add_argument('receipt', type=Path)
parser.add_argument('--expected', required=True)
args = parser.parse_args()
with wave.open(str(args.wave_file), 'rb') as source:
    if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000 or source.getnframes() > 960000:
        raise ValueError('Voice verification requires a bounded mono 16 kHz 16-bit PCM WAV')
    pcm = source.readframes(source.getnframes())
result = transcribe({'request_id': str(uuid.uuid4()), 'sample_rate': 16000, 'pcm_base64': base64.b64encode(pcm).decode()})
report = {'type': 'live-offline-recognition', 'source': 'explicit test WAV, no microphone capture', 'completed_at': datetime.now(timezone.utc).isoformat(),
          'expected': args.expected, 'passed': args.expected.lower() in result['text'].lower(), 'result': result}
args.receipt.write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
raise SystemExit(0 if report['passed'] else 1)
