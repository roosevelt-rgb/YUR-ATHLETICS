"""Selected-page authority and durable recovery using actual temporary Work state."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry import work_browser as browser
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_engine import AUTHORITY
from foundry.work_store import now, digest
from foundry.specialists import validate_schema


def source():
    current = datetime.now(timezone.utc)
    return {'schema': browser.SOURCE_SCHEMA, 'source_id': str(uuid.uuid4()),
            'source_url': 'https://example.test/selected?q=quantities', 'title': 'Selected fixture page',
            'selected_at': current.isoformat(), 'expires_at': (current + timedelta(seconds=120)).isoformat(),
            'max_acquisitions': 1}


def context(selected, text='Actual selected page: 12.50 + 2.50 = 15.00. Unicode: façade 🧱.'):
    return {'schema': 'yur.browser-context.v1', 'source_url': selected['source_url'], 'title': selected['title'],
            'text': text, 'sha256': hashlib.sha256(text.encode()).hexdigest(),
            'acquired_at': datetime.now(timezone.utc).isoformat(), 'truncated': False,
            'limits': deepcopy(browser.LIMITS)}


def response(frame, selected, text=None):
    return {**frame, 'type': 'browser_result', 'context': context(selected) if text is None else context(selected, text)}


class WorkBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'state'
        self.store = CommitService(self.root); self.addCleanup(self.close)
        self.manager = OrchestrationManager(self.store)
        self.source = source(); self.args = {'source_id': self.source['source_id']}
        self.request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'work',
                        'goal': 'Read the selected page', 'root': None, 'provider': 'ollama', 'model': 'fixture',
                        'messages': [{'role': 'user', 'content': 'Read the selected page'}], 'browser_source': self.source}
        self.parent = self.store.submit_work(self.request, AUTHORITY)
        self.update(status='running')

    def close(self):
        if self.store:
            self.store.close()

    def update(self, **changes):
        document = {key: deepcopy(value) for key, value in self.parent.items() if key not in {'revision', 'receipt'}}
        document.update(changes, updated_at=now())
        self.parent = self.store.commit_work(document, self.parent['revision'], 'work.test.fixture', {})

    def refresh(self):
        self.parent = self.store.get_work(self.parent['id'])

    def invoke(self, acquire=None, args=None):
        with self.store.acquire_worker():
            return browser.execute(self.manager, self.parent, self.args if args is None else args, acquire_page=acquire)

    def events(self):
        return [event for event in self.store.work_events(self.parent['id']) if event['event_type'].startswith('work.browser.')]

    def test_acceptance_precedes_actual_callback_and_result_contains_committed_citation(self):
        captured = []
        def acquire(frame):
            captured.append(frame)
            accepted = self.events()[-1]
            self.assertEqual(accepted['event_type'], browser.ACCEPTED)
            self.assertEqual(frame['accepted_receipt'], accepted['hash'])
            self.assertEqual(frame['source_sha256'], digest(self.source))
            self.assertEqual(frame['authority_sha256'], digest(AUTHORITY))
            self.assertIsNotNone(self.store._lock_file)
            return response(frame, self.source)
        result = self.invoke(acquire)
        self.assertEqual(len(captured), 1)
        self.assertEqual(result['status'], 'recorded')
        self.assertTrue(result['committed'])
        self.assertIsNone(result['error'])
        self.assertEqual(result['context']['source_url'], self.source['source_url'])
        self.assertIn('façade 🧱', result['context']['text'])
        self.assertEqual(result['provenance']['result_receipt'], self.events()[-1]['hash'])
        self.assertEqual(self.store.get_work(self.parent['id'])['authority'], AUTHORITY)
        validate_schema(result, browser.catalog(self.source)[0]['output_schema'])

    def test_structural_validation_catalog_and_secrets_do_not_acquire(self):
        self.assertEqual(browser.catalog(None), [])
        self.assertEqual(browser.catalog(self.source)[0]['input_schema']['properties']['source_id']['enum'], [self.source['source_id']])
        for patch_value in [{'extra': True}, {'max_acquisitions': True}, {'title': 'x' * 513},
                            {'source_url': 'http://outside.example/path'}, {'source_url': 'https://u:p@example.test'},
                            {'source_url': 'https://example.test/?token=private-test-value&safe=true'},
                            {'title': 'api_key="fixture-private-value"'}]:
            with self.subTest(patch_value=patch_value), self.assertRaises(ValueError):
                browser.validate_source({**self.source, **patch_value})
        for args in [{'source_id': str(uuid.uuid4())}, {**self.args, 'url': 'https://elsewhere.test'}, {**self.args, 'authority': 'model'}]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.invoke(lambda _frame: self.fail('No acquisition'), args)
        self.assertEqual(self.events(), [])

    def test_missing_broker_commits_finite_denial_and_replays_it(self):
        result = self.invoke()
        self.assertEqual(result['status'], 'denied')
        self.assertEqual(result['error']['code'], 'BROKER_UNAVAILABLE')
        self.assertIsNone(result['context'])
        validate_schema(result, browser.catalog(self.source)[0]['output_schema'])
        self.refresh()
        self.assertEqual(self.invoke(lambda _frame: self.fail('Denied acquisition must not retry')), result)
        self.assertEqual(len(self.events()), 2)

    def test_result_replays_after_expiry_reopen_without_broker(self):
        result = self.invoke(lambda frame: response(frame, self.source))
        self.store.close(); self.store = CommitService(self.root); self.manager = OrchestrationManager(self.store)
        self.refresh()
        class Later(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(timezone.utc) + timedelta(days=1)
        with patch.object(browser, 'datetime', Later):
            self.assertEqual(browser.validate_source(self.source), self.source)
            self.assertEqual(self.invoke(), result)
        self.assertEqual(len(self.events()), 2)

    def test_expired_selection_commits_denial_without_callback(self):
        class Later(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(timezone.utc) + timedelta(seconds=121)
        with patch.object(browser, 'datetime', Later):
            result = self.invoke(lambda _frame: self.fail('No expired acquisition'))
        self.assertEqual(result['error']['code'], 'SOURCE_EXPIRED')
        self.assertEqual(len(self.events()), 2)

    def test_invalid_hash_limits_source_secret_and_frame_identity_are_denied_without_raw_persistence(self):
        changes = ['hash', 'limits', 'source', 'secret', 'identity']
        for change in changes:
            with self.subTest(change=change):
                # Separate real Work identities retain their own immutable source.
                if self.events():
                    self.request['request_id'] = str(uuid.uuid4())
                    self.parent = self.store.submit_work(self.request, AUTHORITY); self.update(status='running')
                marker = 'fixture-private-value'
                def acquire(frame):
                    value = response(frame, self.source)
                    if change == 'hash': value['context']['sha256'] = 'f' * 64
                    if change == 'limits': value['context']['limits']['form_fields_excluded'] = False
                    if change == 'source': value['context']['source_url'] = 'https://other.test/'
                    if change == 'secret': value['context'] = context(self.source, 'api_key="' + marker + '"')
                    if change == 'identity': value['conversation_id'] = str(uuid.uuid4())
                    return value
                result = self.invoke(acquire)
                self.assertEqual(result['status'], 'denied')
                self.assertEqual(result['error']['code'], 'INVALID_PAGE_EVIDENCE')
                self.assertNotIn(marker, json.dumps(self.events()))

    def test_acceptance_acknowledgment_loss_preserves_exact_pending_request(self):
        for error_type in (ValueError, OSError):
            with self.subTest(error_type=error_type.__name__):
                if self.events():
                    self.request['request_id'] = str(uuid.uuid4())
                    self.parent = self.store.submit_work(self.request, AUTHORITY); self.update(status='running')
                original = self.store.commit_work_checkpoint
                def interrupted(*args, **kwargs):
                    result = original(*args, **kwargs)
                    if args[2] == browser.ACCEPTED: raise error_type('Synthetic postcommit acceptance loss')
                    return result
                with patch.object(self.store, 'commit_work_checkpoint', side_effect=interrupted):
                    with self.assertRaises(RuntimeError):
                        self.invoke(lambda _frame: self.fail('No acquisition before acknowledged acceptance'))
                self.refresh()
                self.assertEqual(browser.pending_call(self.manager, self.parent)['function']['arguments'], self.args)
                result = self.invoke(lambda frame: response(frame, self.source))
                self.assertEqual(result['status'], 'recorded')
                self.assertEqual([event['event_type'] for event in self.events()], [browser.ACCEPTED, browser.RESULT])

    def test_result_acknowledgment_loss_recovers_exact_committed_content_without_second_read(self):
        for error_type in (ValueError, OSError):
            with self.subTest(error_type=error_type.__name__):
                if self.events():
                    self.request['request_id'] = str(uuid.uuid4())
                    self.parent = self.store.submit_work(self.request, AUTHORITY); self.update(status='running')
                original = self.store.commit_work_checkpoint; acquired = []
                def interrupted(*args, **kwargs):
                    result = original(*args, **kwargs)
                    if args[2] == browser.RESULT: raise error_type('Synthetic postcommit result loss')
                    return result
                def acquire(frame):
                    acquired.append(frame); return response(frame, self.source, 'Retained exact original text')
                with patch.object(self.store, 'commit_work_checkpoint', side_effect=interrupted):
                    with self.assertRaises(RuntimeError): self.invoke(acquire)
                self.refresh()
                result = self.invoke(lambda _frame: self.fail('Committed result must replay'))
                self.assertEqual(result['context']['text'], 'Retained exact original text')
                self.assertEqual(len(acquired), 1)
                self.assertEqual(len(self.events()), 2)

    def test_missing_room_refuses_before_acceptance_or_acquisition(self):
        self.update(messages=[{'role': 'user', 'content': 'x' * 800000}])
        with self.assertRaisesRegex(ValueError, 'room'):
            self.invoke(lambda _frame: self.fail('No unretainable acquisition'))
        self.assertEqual(self.events(), [])

    def test_no_worker_lock_stale_parent_or_cancelled_work_cannot_acquire(self):
        with self.assertRaises(RuntimeError):
            browser.execute(self.manager, self.parent, self.args)
        stale = deepcopy(self.parent); self.update(error='Changed metadata')
        with self.store.acquire_worker(), self.assertRaises(ValueError):
            browser.execute(self.manager, stale, self.args)
        self.update(status='cancelled')
        with self.assertRaises(ValueError): self.invoke()
        self.assertEqual(self.events(), [])

    def test_one_acquisition_limit_survives_next_step_and_request_unchanged(self):
        result = self.invoke(lambda frame: response(frame, self.source)); self.refresh()
        self.update(steps=[{'id': uuid.uuid4().hex, 'tool': browser.TOOL, 'arguments': self.args, 'result': result,
                           'succeeded': True, 'completed_at': now()}])
        with self.assertRaisesRegex(ValueError, 'one selected-page'):
            self.invoke(lambda _frame: self.fail('No second acquisition'))
        self.assertEqual(len(self.events()), 2)
        self.assertEqual(self.store.get_work(self.parent['id'])['request'], self.request)

    def test_queued_correction_during_acquisition_is_preserved(self):
        other = CommitService(self.root); self.addCleanup(other.close)
        correction = str(uuid.uuid4())
        def acquire(frame):
            other.queue_work_steering(self.parent['id'], self.parent['conversation_id'], correction, 'Use the units shown on the page.')
            return response(frame, self.source)
        result = self.invoke(acquire)
        self.assertEqual(result['status'], 'recorded')
        state = self.store.work_steering_state(self.parent['id'])
        self.assertEqual(state[0]['correction_id'], correction)
        self.assertEqual(state[0]['status'], 'queued')

    def test_stop_after_acceptance_prevents_callback_and_keeps_cancelled_state(self):
        other = CommitService(self.root); self.addCleanup(other.close)
        manager = OrchestrationManager(other)
        original = self.store.commit_work_checkpoint
        def stop_after_acceptance(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[2] == browser.ACCEPTED:
                manager.cancel_work(self.parent['id'])
            return result
        with patch.object(self.store, 'commit_work_checkpoint', side_effect=stop_after_acceptance):
            with self.assertRaises(ValueError):
                self.invoke(lambda _frame: self.fail('Stop was committed before acquisition'))
        self.assertEqual(self.store.get_work(self.parent['id'])['status'], 'cancelled')
        self.assertEqual([event['event_type'] for event in self.events()], [browser.ACCEPTED])

    def test_definite_precommit_acceptance_failure_stays_finite_and_does_not_acquire(self):
        with patch.object(self.store, 'commit_work_checkpoint', side_effect=ValueError('Synthetic precommit rejection')):
            with self.assertRaises(ValueError):
                self.invoke(lambda _frame: self.fail('No accepted acquisition'))
        self.assertEqual(self.events(), [])

    def test_actual_journal_tampering_is_detected_on_reopen(self):
        self.invoke(lambda frame: response(frame, self.source))
        event = self.events()[-1]
        changed = deepcopy(event['data'])
        changed['change']['reply']['context']['text'] = 'Uncommitted replacement content'
        self.store._db.execute('UPDATE work_events SET data=? WHERE id=?', (json.dumps(changed), event['id']))
        self.store.close(); self.store = None
        with self.assertRaisesRegex(RuntimeError, 'chain|mismatch'):
            CommitService(self.root)


if __name__ == '__main__':
    unittest.main()
