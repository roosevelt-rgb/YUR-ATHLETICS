"""Independent validation and actual file delivery through CommitService."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager


class WorkDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name) / 'project'; self.folder.mkdir()
        self.source = self.folder / 'source.txt'; self.source.write_text('before', encoding='utf-8')
        self.store = CommitService(Path(self.temp.name) / 'journal')
        self.manager = OrchestrationManager(self.store)

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def proposal(self, artifact=False, new=False):
        request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'code',
                   'goal': 'Prepare an output', 'root': str(self.folder), 'provider': 'ollama', 'model': 'fixture',
                   'messages': [{'role': 'user', 'content': 'Prepare an output'}]}
        args = ({'name': 'result.md', 'content': '# Verified output', 'media_type': 'text/markdown'} if artifact else
                {'path': 'new.txt' if new else 'source.txt', 'content': 'after',
                 'expected_sha256': None if new else hashlib.sha256(b'before').hexdigest()})
        replies = iter([{'content': '', 'tool_calls': [{'function': {'name': 'create_artifact' if artifact else 'propose_edit', 'arguments': args}}]}, {'content': 'Prepared.'}])
        mission = self.manager.run_work(request, lambda *_: next(replies))
        return mission['id'], mission['artifacts'][0]['id']

    def authority(self, mission, artifact):
        return {'issuer': 'local-user', 'scope': 'reviewed-work-artifact', 'actions': ['commit'], 'mission_id': mission, 'artifact_id': artifact}

    def deliver(self, mission, artifact):
        validation = self.store.validate_work_delivery(mission, artifact)
        return self.store.commit_work_delivery(mission, artifact, validation['validation_token'], self.authority(mission, artifact))

    def test_validation_has_no_write_and_commit_verifies_actual_bytes_and_replay(self):
        mission, artifact = self.proposal()
        count = self.store.verify_integrity()['work_events']
        validation = self.store.validate_work_delivery(mission, artifact)
        self.assertEqual(self.source.read_text(), 'before')
        self.assertEqual(self.store.verify_integrity()['work_events'], count)
        with self.assertRaisesRegex(ValueError, 'approval'):
            self.store.commit_work_delivery(mission, artifact, validation['validation_token'], {})
        result = self.store.commit_work_delivery(mission, artifact, validation['validation_token'], self.authority(mission, artifact))
        self.assertEqual(self.source.read_text(), 'after')
        self.assertEqual(result['delivery']['verified_sha256'], hashlib.sha256(b'after').hexdigest())
        count = self.store.verify_integrity()['work_events']
        self.assertTrue(self.deliver(mission, artifact)['replayed'])
        self.assertEqual(self.store.verify_integrity()['work_events'], count)
        self.assertEqual(result['mission']['status'], 'completed')

    def test_changed_source_and_stale_review_never_overwrite(self):
        mission, artifact = self.proposal()
        validation = self.store.validate_work_delivery(mission, artifact)
        self.source.write_text('operator changed this')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.store.commit_work_delivery(mission, artifact, validation['validation_token'], self.authority(mission, artifact))
        self.assertEqual(self.source.read_text(), 'operator changed this')
        self.assertNotIn('delivery', self.store.get_work(mission)['artifacts'][0])

    def test_export_creates_verified_artifact_only_inside_commitservice_output_folder(self):
        mission, artifact = self.proposal(artifact=True)
        validation = self.store.validate_work_delivery(mission, artifact)
        target = Path(validation['plan']['path'])
        self.assertFalse(target.exists())
        self.deliver(mission, artifact)
        self.assertTrue(target.is_relative_to(self.store.root / 'work-artifacts'))
        self.assertEqual(target.read_text(), '# Verified output')

    def test_new_file_create_only_does_not_replace_late_file(self):
        mission, artifact = self.proposal(new=True)
        validation = self.store.validate_work_delivery(mission, artifact)
        target = self.folder / 'new.txt'; target.write_text('created by operator')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.store.commit_work_delivery(mission, artifact, validation['validation_token'], self.authority(mission, artifact))
        self.assertEqual(target.read_text(), 'created by operator')

    def test_interruption_after_write_recovers_receipt_without_rewriting(self):
        mission, artifact = self.proposal()
        real_commit = self.store.commit_work
        def interrupted(document, revision, event_type, change=None):
            if event_type == 'work.artifact.applied':
                raise OSError('Simulated interruption after durable filesystem output')
            return real_commit(document, revision, event_type, change)
        with patch.object(self.store, 'commit_work', side_effect=interrupted):
            with self.assertRaisesRegex(OSError, 'interruption'):
                self.deliver(mission, artifact)
        self.assertEqual(self.source.read_text(), 'after')
        self.assertEqual(self.store.get_work(mission)['artifacts'][0]['delivery']['status'], 'prepared')
        with patch('foundry.work_delivery.os.replace', side_effect=AssertionError('Replayed write')):
            recovered = self.deliver(mission, artifact)
        self.assertEqual(recovered['delivery']['status'], 'applied')
        self.assertTrue(self.store.verify_integrity()['ok'])


if __name__ == '__main__': unittest.main()
