import base64
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

from foundry.voice import transcribe, info


class VoiceTests(unittest.TestCase):
    def test_audio_shape_rejected_before_model_load(self):
        valid = {'request_id': str(uuid.uuid4()), 'sample_rate': 16000, 'pcm_base64': base64.b64encode(b'\0\0' * 100).decode()}
        bad = [None, {**valid, 'command': 'shell'}, {**valid, 'request_id': 'bad'}, {**valid, 'sample_rate': 48000},
               {**valid, 'pcm_base64': '!!!'}, {**valid, 'pcm_base64': base64.b64encode(b'a').decode()},
               {**valid, 'pcm_base64': base64.b64encode(b'\0' * 1920002).decode()}]
        with patch('foundry.voice.checked_model', side_effect=AssertionError('Invalid input reached model')):
            for request in bad:
                with self.assertRaises((ValueError, TypeError)):
                    transcribe(request)

    def test_missing_model_reports_setup_without_network_or_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'missing-model'
            with patch('foundry.voice.model_root', return_value=root):
                result = info()
            self.assertFalse(result['ready'])
            self.assertIn('Setup Offline Voice.cmd', result['setup'])
            self.assertFalse(root.exists())


if __name__ == '__main__': unittest.main()
