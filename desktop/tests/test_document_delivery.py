"""Office proposals pass through real Work, independent validation and commit."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from zipfile import ZipFile

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_documents import artifact_bytes


class DocumentDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = CommitService(Path(self.temp.name) / 'state')
        self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)

    def mission(self, recipe):
        calls = iter([
            {'content': '', 'tool_calls': [{'function': {'name': 'create_document', 'arguments': recipe}}]},
            {'content': 'The document is committed and ready to export.'},
        ])
        request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'work',
                   'goal': 'Create an Office report', 'root': None, 'provider': 'ollama', 'model': 'fixture',
                   'messages': [{'role': 'user', 'content': 'Create an Office report'}]}
        return self.manager.run_work(request, lambda _messages, _tools: next(calls))

    def test_all_three_formats_deliver_actual_zip_bytes_and_reopen_without_reexecution(self):
        recipes = [
            {'name': 'report.docx', 'format': 'docx', 'title': 'Measured report', 'sections': [{'heading': 'Area', 'paragraphs': ['Room measures 317 square feet.']}]},
            {'name': 'estimate.xlsx', 'format': 'xlsx', 'title': 'Estimate', 'sheets': [{'name': 'Areas', 'columns': ['Name', 'Area'], 'rows': [['Room A', 317], ['=not_a_formula', 9.5]]}]},
            {'name': 'briefing.pptx', 'format': 'pptx', 'title': 'Briefing', 'slides': [{'title': 'Verified area', 'bullets': ['Room A: 317 square feet', 'Ready for review']}]}]
        for recipe in recipes:
            with self.subTest(format=recipe['format']):
                mission = self.mission(recipe)
                self.assertTrue(mission['steps'][0]['succeeded'], mission['steps'][0])
                item = mission['artifacts'][0]
                self.assertEqual(item['status'], 'committed')
                self.assertEqual(json.loads(item['proposal']['content']), recipe)
                expected = artifact_bytes(item['proposal'])
                self.assertTrue(expected.startswith(b'PK'))
                plan = self.store.validate_work_delivery(mission['id'], item['id'])
                target = Path(plan['plan']['path'])
                self.assertFalse(target.exists(), 'Validation cannot export a file')
                authority = {'issuer': 'local-user', 'scope': 'reviewed-work-artifact', 'actions': ['commit'], 'mission_id': mission['id'], 'artifact_id': item['id']}
                result = self.store.commit_work_delivery(mission['id'], item['id'], plan['validation_token'], authority)
                self.assertEqual(target.read_bytes(), expected)
                self.assertEqual(result['delivery']['verified_sha256'], hashlib.sha256(expected).hexdigest())
                with ZipFile(io.BytesIO(target.read_bytes())) as archive:
                    self.assertIn('[Content_Types].xml', archive.namelist())
                    self.assertTrue(any(b'317' in archive.read(name) for name in archive.namelist()))
                replay = self.store.validate_work_delivery(mission['id'], item['id'])
                self.assertTrue(replay['already_applied'])
                repeated = self.store.commit_work_delivery(mission['id'], item['id'], replay['validation_token'], authority)
                self.assertTrue(repeated['replayed'])
                self.assertEqual(target.read_bytes(), expected)
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_delivery_rejects_altered_recipe_metadata_and_destination(self):
        mission = self.mission({'name': 'report.docx', 'format': 'docx', 'title': 'Report', 'sections': [{'heading': 'Scope', 'paragraphs': ['Original facts.']}]})
        item = mission['artifacts'][0]
        for key, value in [('sha256', '0' * 64), ('preview_text', 'Fabricated preview'), ('name', 'other.docx')]:
            altered = copy.deepcopy(item['proposal']); altered[key] = value
            with self.assertRaises(ValueError):
                artifact_bytes(altered)
        plan = self.store.validate_work_delivery(mission['id'], item['id'])
        target = Path(plan['plan']['path']); target.parent.mkdir(parents=True)
        target.write_bytes(b'Preserve existing unrelated file')
        authority = {'issuer': 'local-user', 'scope': 'reviewed-work-artifact', 'actions': ['commit'], 'mission_id': mission['id'], 'artifact_id': item['id']}
        with self.assertRaisesRegex(ValueError, 'Destination changed'):
            self.store.commit_work_delivery(mission['id'], item['id'], plan['validation_token'], authority)
        self.assertEqual(target.read_bytes(), b'Preserve existing unrelated file')


if __name__ == '__main__':
    unittest.main()
