"""Source manifest validation and actual OM/CommitService context evidence."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry import desktop_capabilities as capabilities
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_engine import AUTHORITY
from foundry import work_tools, work_specialists, work_concepts, work_cells, work_generated, work_browser


def fixture():
    return {'schema': 'yur.desktop-capabilities.v1', 'identity': 'YUR AI is a whole desktop workspace.',
            'explanation_policy': 'Explain projects, Studio and tools separately.',
            'availability_policy': 'No runtime health is inferred from this source description.',
            'features': [{'id': 'projects', 'label': 'Projects and references', 'surface': 'Projects',
                          'summary': 'Retain explicitly selected shared reference files.', 'access': 'desktop_ui',
                          'requirements': ['Operator selection'], 'limitations': ['Context only'],
                          'sources': ['src/project-files-view.js', 'foundry/project_files.py']}],
            'boundaries': ['Only the supplied tools and unchanged authority permit execution.']}


class DesktopCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'desktop-capabilities.json'

    def write(self, document=None, *, raw=None):
        self.path.write_bytes(raw if raw is not None else json.dumps(document or fixture(), ensure_ascii=False).encode('utf-8'))
        return self.path

    def test_actual_source_manifest_is_bounded_and_describes_whole_desktop(self):
        loaded = capabilities.load_capabilities()
        raw = capabilities.MANIFEST_PATH.read_bytes()
        self.assertLessEqual(len(raw), capabilities.MAX_MANIFEST_BYTES)
        self.assertEqual(loaded['sha256'], hashlib.sha256(raw).hexdigest())
        text = capabilities.compile_capabilities(loaded, 'work')
        self.assertIn('yur.desktop-capabilities.v1', text); self.assertIn(loaded['sha256'], text)
        self.assertIn('whole desktop', loaded['manifest']['explanation_policy'].lower())
        for feature in loaded['manifest']['features']:
            self.assertIn(feature['label'], text); self.assertIn(feature['access'], text)
        self.assertIn('not a runtime health check or a permission grant', text)
        self.assertLessEqual(len(text.encode('utf-8')), capabilities.MAX_CONTEXT_BYTES)

    def test_raw_hash_records_whitespace_and_reference_paths_are_never_read(self):
        doc = fixture(); doc['features'][0]['sources'] = ['not-present/reviewed-source.py']
        original = json.dumps(doc, ensure_ascii=False).encode('utf-8')
        with patch.object(capabilities, 'read_checked', wraps=capabilities.read_checked) as read:
            first = capabilities.load_capabilities(self.write(raw=original))
            self.assertEqual(read.call_count, 1)
        second = capabilities.load_capabilities(self.write(raw=original + b'\n'))
        self.assertEqual(first['manifest'], second['manifest']); self.assertNotEqual(first['sha256'], second['sha256'])
        self.assertIn('not-present/reviewed-source.py', capabilities.compile_capabilities(second, 'code'))
        self.assertFalse((self.path.parent / 'not-present').exists())

    def test_invalid_schema_fields_access_and_duplicate_features_are_rejected(self):
        mutations = [lambda doc: doc.update(schema='other'), lambda doc: doc.update(authority={'actions': ['shell']}),
                     lambda doc: doc.update(identity={}), lambda doc: doc.update(boundaries=[]),
                     lambda doc: doc.update(features=[]), lambda doc: doc['features'][0].update(access='host_shell'),
                     lambda doc: doc['features'][0].update(extra='unknown'), lambda doc: doc['features'][0].update(summary='\x00'),
                     lambda doc: doc['features'][0].update(requirements='anything'),
                     lambda doc: doc['features'].append(deepcopy(doc['features'][0]))]
        for mutate in mutations:
            doc = fixture(); mutate(doc)
            with self.subTest(doc=doc), self.assertRaises(ValueError):
                capabilities.load_capabilities(self.write(doc))

    def test_source_references_are_relative_bounded_and_cannot_escape_or_select_streams(self):
        for source in ['../outside.py', './file.py', '/root/file.py', 'C:/file.py', 'src/../file.py',
                       'src\\file.py', 'file.py:stream', 'src//file.py', 'src/trailing.', 'src/line\nfile.py', 'x' * 241]:
            doc = fixture(); doc['features'][0]['sources'] = [source]
            with self.subTest(source=source), self.assertRaises(ValueError):
                capabilities.load_capabilities(self.write(doc))

    def test_invalid_encoding_duplicate_keys_depth_and_byte_budgets_fail_closed(self):
        for raw in [b'\xff', b'{"schema":"x","schema":"y"}', b'[' * 1500 + b']' * 1500,
                    b' ' * (capabilities.MAX_MANIFEST_BYTES + 1), b'{}']:
            with self.subTest(bytes=len(raw)), self.assertRaises(ValueError):
                capabilities.load_capabilities(self.write(raw=raw))
        doc = fixture(); doc['features'] = [{**doc['features'][0], 'id': f'feature{index}'} for index in range(25)]
        with self.assertRaises(ValueError): capabilities.load_capabilities(self.write(doc))
        doc = fixture(); doc['features'][0]['limitations'] = ['bounded'] * 13
        with self.assertRaises(ValueError): capabilities.load_capabilities(self.write(doc))

    def test_missing_manifest_and_reparse_boundary_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError, 'manifest is unavailable'):
            capabilities.load_capabilities(self.path)
        self.write()
        with patch('foundry.sources.reject_reparse', side_effect=ValueError('Synthetic reparse refusal')):
            with self.assertRaisesRegex(ValueError, 'safe read boundary'):
                capabilities.load_capabilities(self.path)

    def test_compiler_revalidates_data_and_framing_does_not_mutate_manifest(self):
        loaded = capabilities.load_capabilities(self.write()); saved = deepcopy(loaded)
        for mode in ('work', 'code'):
            text = capabilities.compile_capabilities(loaded, mode)
            self.assertIn(f'{mode.title()} mode inside the broader Desktop', text)
            self.assertIn('only the supplied typed tool catalog', text)
        self.assertEqual(loaded, saved)
        for mode in ('chat', 'shell', None, {}):
            with self.assertRaises(ValueError): capabilities.compile_capabilities(loaded, mode)
        loaded['manifest']['features'][0]['access'] = 'execute_anything'
        with self.assertRaises(ValueError): capabilities.compile_capabilities(loaded, 'work')


class DesktopCapabilityWorkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = CommitService(Path(self.temp.name) / 'journal'); self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)

    def request(self, mode='work'):
        return {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': mode,
                'goal': 'Explain the Desktop and its current execution boundary.', 'root': None, 'provider': 'ollama',
                'model': 'inert-fixture', 'messages': [{'role': 'user', 'content': 'What can the Desktop do?'}]}

    def test_manager_compiles_whole_desktop_with_environment_bound_toolset_and_start_event(self):
        loaded = capabilities.load_capabilities()
        project = Path(self.temp.name) / 'selected-project'; project.mkdir()
        for mode, root in ((mode, root) for mode in ('work', 'code') for root in (None, str(project))):
            seen = []
            def adapter(messages, tools):
                seen.append(messages)
                base = work_tools.tool_catalog()
                if root is None:
                    unavailable = {'list_files', 'read_file', 'search_files', 'propose_edit'}
                    base = [tool for tool in base if tool['name'] not in unavailable]
                expected = [*base, *work_specialists.catalog(), *work_concepts.catalog(),
                            *(work_cells.catalog() if mode == 'code' else []), *work_generated.catalog(mode), *work_browser.catalog(None)]
                self.assertEqual(tools, expected)
                context = messages[0]['content']
                self.assertEqual(messages[0]['role'], 'system')
                self.assertTrue(context.startswith(capabilities.compile_capabilities(loaded, mode)))
                for feature in loaded['manifest']['features']: self.assertIn(feature['label'], context)
                self.assertIn('Only the selected folder is available for reads', context)
                self.assertIn('No browser page is selected', context)
                self.assertEqual(work_cells.TOOL in [tool['name'] for tool in tools], mode == 'code')
                return {'content': 'Desktop capabilities described with current task limits.'}
            with self.subTest(mode=mode, root=root):
                mission = self.manager.run_work({**self.request(mode), 'root': root}, adapter)
                self.assertEqual(len(seen), 1); self.assertEqual(mission['authority'], AUTHORITY)
                self.assertEqual(mission['status'], 'completed'); self.assertEqual(mission['steps'], [])
                events = self.store.work_events(mission['id'])
                started = [event for event in events if event['event_type'] == 'work.started']
                self.assertEqual(len(started), 1)
                self.assertEqual(started[0]['data']['change']['desktop_capabilities_sha256'], loaded['sha256'])
                self.assertEqual(started[0]['data']['change']['desktop_capabilities_status'], 'validated')
                self.assertEqual(len(started[0]['hash']), 64); self.store.verify_integrity()

    def test_completed_cancelled_and_awaiting_replay_require_no_manifest_or_model(self):
        completed_request = self.request()
        completed = self.manager.run_work(completed_request, lambda *_: {'content': 'Completed once.'})
        cancelled_request = self.request(); cancelled = self.manager.cancel_work_request(cancelled_request)
        waiting_request = self.request(); waiting = self.store.submit_work(waiting_request, AUTHORITY)
        document = {key: value for key, value in waiting.items() if key not in {'revision', 'receipt'}}
        document['status'] = 'running'; running = self.store.commit_work(document, waiting['revision'], 'work.started')
        document['status'] = 'awaiting_approval'; waiting = self.store.commit_work(document, running['revision'], 'work.awaiting_approval')
        count = self.store.verify_integrity()['work_events']
        with patch('foundry.work_engine.load_capabilities', side_effect=AssertionError('Replay reread manifest')):
            for request, expected in [(completed_request, completed), (cancelled_request, cancelled), (waiting_request, waiting)]:
                self.assertEqual(self.manager.run_work(request, lambda *_: self.fail('Replay called model')),
                                 {key: value for key, value in expected.items() if key != 'receipt'})
        self.assertEqual(self.store.verify_integrity()['work_events'], count)

    def test_missing_or_malformed_manifest_commits_honest_failure_without_provider_or_tools(self):
        target = Path(self.temp.name) / 'invalid-manifest.json'
        for missing in (True, False):
            if not missing: target.write_text('{"schema":"wrong"}', encoding='utf-8')
            with self.subTest(missing=missing), patch.object(capabilities, 'MANIFEST_PATH', target):
                request = self.request()
                with self.assertRaisesRegex(ValueError, 'Desktop capability manifest'):
                    self.manager.run_work(request, lambda *_: self.fail('Invalid overview reached model'))
                mission = self.store.get_work_by_request(request['request_id'])
                self.assertEqual(mission['status'], 'failed'); self.assertEqual(mission['steps'], []); self.assertEqual(mission['artifacts'], [])
                events = self.store.work_events(mission['id'])
                self.assertEqual([event['event_type'] for event in events], ['work.submitted', 'work.started', 'work.failed'])
                self.assertIsNone(events[1]['data']['change']['desktop_capabilities_sha256'])
                self.assertEqual(events[1]['data']['change']['desktop_capabilities_status'], 'unavailable')
                self.store.verify_integrity()

    def test_overview_is_loaded_once_per_attempt_and_same_hash_survives_tool_continuation(self):
        request = self.request(); calls = []
        def adapter(messages, _tools):
            calls.append(messages[0]['content'])
            if len(calls) == 1:
                return {'content': '', 'tool_calls': [{'function': {'name': 'create_artifact', 'arguments': {
                    'name': 'overview.md', 'media_type': 'text/markdown', 'content': 'A bounded retained note.'}}}]}
            return {'content': 'Created one retained note.'}
        with patch('foundry.work_engine.load_capabilities', wraps=capabilities.load_capabilities) as loader:
            mission = self.manager.run_work(request, adapter)
            self.assertEqual(loader.call_count, 1)
        self.assertEqual(len(calls), 2); self.assertEqual(len(mission['steps']), 1)
        digests = [line for line in calls[0].splitlines() if line.startswith('Manifest SHA-256:')]
        self.assertEqual(len(digests), 1); self.assertIn(digests[0], calls[1])

    def test_start_event_manifest_digest_is_covered_by_existing_integrity_chain(self):
        mission = self.manager.run_work(self.request(), lambda *_: {'content': 'Recorded overview.'})
        row = self.store._db.execute("SELECT id,data FROM work_events WHERE mission_id=? AND event_type='work.started'", (mission['id'],)).fetchone()
        data = json.loads(row['data']); data['change']['desktop_capabilities_sha256'] = '0' * 64
        self.store._db.execute('UPDATE work_events SET data=? WHERE id=?', (json.dumps(data), row['id']))
        with self.assertRaises(RuntimeError): self.store.verify_integrity()


if __name__ == '__main__':
    unittest.main()
