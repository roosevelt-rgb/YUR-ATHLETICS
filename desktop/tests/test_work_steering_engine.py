"""Corrections change real continuation without replacing mission authority."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry import work_engine


class WorkSteeringEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source'; self.source.mkdir()
        (self.source / 'report.txt').write_text('Original source measurement: 317', encoding='utf-8')
        self.store = CommitService(Path(self.temp.name) / 'journal'); self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        self.request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'work',
                        'goal': 'Read the measurement and summarize.', 'root': str(self.source), 'provider': 'ollama',
                        'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Read the measurement and summarize.'}]}
        self.events = []

    def queue(self, text='Correction: only report the verified quantity.', correction_id=None):
        # Independent RPC connections can enqueue while the manager holds its
        # worker lock. The event transaction still belongs to CommitService.
        with CommitService(self.store.root) as writer:
            mission = writer.get_work_by_request(self.request['request_id'])
            return writer.queue_work_steering(mission['id'], self.request['conversation_id'], correction_id or str(uuid.uuid4()), text)

    @staticmethod
    def calls(*items):
        return {'content': '', 'tool_calls': [{'function': {'name': name, 'arguments': arguments}} for name, arguments in items]}

    def test_correction_during_model_request_discards_stale_tool_calls(self):
        count = 0
        original = copy.deepcopy(self.request)
        def adapter(messages, _tools):
            nonlocal count
            count += 1
            if count == 1:
                self.queue()
                return self.calls(('create_artifact', {'name': 'stale.md', 'media_type': 'text/markdown', 'content': 'Old intent'}))
            self.assertEqual(messages[-1]['role'], 'user')
            self.assertIn('only report the verified quantity', messages[-1]['content'])
            return {'content': 'Correction received; no old artifact created.'}
        mission = self.manager.run_work(self.request, adapter, self.events.append)
        self.assertEqual((count, mission['status'], mission['steps'], mission['artifacts']), (2, 'completed', [], []))
        self.assertEqual(mission['request'], original)
        self.assertEqual(mission['authority'], work_engine.AUTHORITY)
        self.assertEqual(self.store.work_steering_state(mission['id'])[0]['status'], 'consumed')
        self.assertEqual(sum(event['type'] == 'steering' for event in self.events), 1)
        replay = self.manager.run_work(self.request, lambda *_: self.fail('Completed steering replayed'))
        self.assertEqual(replay['id'], mission['id'])

    def test_correction_during_bounded_tool_preserves_result_and_discards_remaining_calls(self):
        original_execute = work_engine.execute_tool
        queued = False
        def execute(name, arguments, root):
            nonlocal queued
            value = original_execute(name, arguments, root)
            if not queued:
                queued = True
                self.queue('Correction after the read: stop creating extra artifacts.')
            return value
        count = 0
        def adapter(messages, _tools):
            nonlocal count
            count += 1
            if count == 1:
                return self.calls(('read_file', {'path': 'report.txt'}), ('create_artifact', {'name': 'stale.md', 'media_type': 'text/markdown', 'content': 'Old second action'}))
            self.assertEqual(messages[-1]['role'], 'user')
            self.assertIn('stop creating extra artifacts', messages[-1]['content'])
            self.assertIn('317', messages[-2]['content'])
            return {'content': 'The bounded read finished; no extra artifact was created.'}
        with patch('foundry.work_engine.execute_tool', side_effect=execute):
            mission = self.manager.run_work(self.request, adapter, self.events.append)
        self.assertEqual([step['tool'] for step in mission['steps']], ['read_file'])
        self.assertEqual(mission['artifacts'], [])
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_correction_at_final_commit_wins_over_old_answer(self):
        complete = self.store.complete_work_unsteered
        calls = 0
        def racing_complete(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.queue('Correction at final checkpoint: include the scope limit.')
            return complete(*args, **kwargs)
        answers = iter([{'content': 'Old answer before correction'}, {'content': 'Updated answer including the scope limit'}])
        with patch.object(self.store, 'complete_work_unsteered', side_effect=racing_complete):
            mission = self.manager.run_work(self.request, lambda *_: next(answers), self.events.append)
        self.assertEqual(mission['answer'], 'Updated answer including the scope limit')
        self.assertEqual(sum(event['event_type'] == 'work.completed' for event in self.store.work_events(mission['id'])), 1)

    def test_stop_marks_unconsumed_correction_without_resuming(self):
        def adapter(*_args):
            queued = self.queue()
            self.manager.cancel_work(queued['mission_id'])
            return {'content': 'Discard this cancelled response'}
        mission = self.manager.run_work(self.request, adapter, self.events.append)
        self.assertEqual((mission['status'], mission['steps']), ('cancelled', []))
        self.assertEqual(self.store.work_steering_state(mission['id'])[0]['status'], 'not_consumed')
        self.assertFalse(any(event['type'] == 'steering' for event in self.events))


if __name__ == '__main__':
    unittest.main()
