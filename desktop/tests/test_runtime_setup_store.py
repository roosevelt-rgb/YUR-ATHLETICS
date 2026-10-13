"""Real CommitService transactions with synthetic observations; no WSL or models."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService, SCHEMA_VERSION
from foundry.orchestration import OrchestrationManager
from foundry import runtime_setup_contract as c
from foundry.runtime_setup_store import RuntimeSetupConflictError
from foundry.work_engine import AUTHORITY as WORK_AUTHORITY


STAMP = '2026-09-13T00:00:00+00:00'


def check(state='stopped'):
    return {'checked_at': STAMP, 'expires_at': '2026-09-13T00:02:00+00:00',
            'token_sha256': 'a'*64, 'observation_sha256': 'b'*64,
            'state': state, 'configuration_source': 'operator'}


def observed_runtime(distro='Ubuntu-24.04'):
    return {'distro': distro, 'architecture': 'x86_64', 'python': '3.12.3', 'libseccomp': '2.5.5',
            'kernel': 'synthetic-test-kernel', 'artifacts': {'/usr/bin/python3': {
                'path': '/usr/bin/python3.12', 'bytes': 100, 'sha256': 'c'*64}}}


def failure():
    return {'code': 'unavailable', 'message': 'Synthetic process observation was lost', 'diagnostics': None}


class RuntimeSetupStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'state'
        self.clock = [STAMP]
        self.addCleanup(patch.stopall)
        patch('foundry.runtime_setup_store._now', side_effect=lambda: self.clock[0]).start()
        self.store = CommitService(self.root); self.addCleanup(lambda: self.store.close())
        self.manager = OrchestrationManager(self.store)
        self.operation = str(uuid.uuid4()); self.owner = str(uuid.uuid4())
        self.distro = 'Ubuntu-24.04'; self.resource = c.resource_id_for(self.distro)
        self.authority = c.mint_authority(self.operation, self.resource)

    def accept(self, **changes):
        args = {'operation_id': self.operation, 'resource_id': self.resource, 'distro': self.distro,
                'check': check(), 'authority': self.authority, 'owner_session_id': self.owner}
        args.update(changes)
        return self.manager.accept_runtime_setup(**args)

    def transition(self, response, state, **changes):
        evidence = {**response['setup']['evidence'], **changes}
        return self.manager.transition_runtime_setup(self.operation, response['setup']['revision'], state,
                                                       evidence, owner_session_id=self.owner)

    def ready(self):
        accepted = self.accept(); starting = self.transition(accepted, 'starting')
        return self.transition(starting, 'ready', runtime=observed_runtime(), started_by_this_setup=True)

    def test_operator_setup_clock_receipts_and_global_lease_leave_work_untouched(self):
        accepted = self.accept()
        self.assertEqual(accepted['setup']['state'], 'accepted')
        self.assertEqual(accepted['receipt']['event_type'], 'runtime.setup.accepted')
        self.assertIsNone(self.store._lock_file)
        with self.assertRaises(RuntimeSetupConflictError):
            other = str(uuid.uuid4()); resource = c.resource_id_for('Ubuntu-Test')
            self.accept(operation_id=other, distro='Ubuntu-Test', resource_id=resource,
                        authority=c.mint_authority(other, resource))
        starting = self.transition(accepted, 'starting')
        ready = self.transition(starting, 'ready', runtime=observed_runtime(), started_by_this_setup=True)
        self.assertEqual(self.manager.active_runtime_setup()['operation_id'], self.operation)
        releasing = self.transition(ready, 'releasing', release_reason='operator')
        released = self.transition(releasing, 'released', owned_process_exit_confirmed=True)
        self.assertIsNone(self.manager.active_runtime_setup())
        history = self.manager.runtime_setup_events(self.operation, limit=2)
        self.assertEqual([e['state'] for e in history['events']], ['released', 'releasing'])
        self.assertIsNotNone(history['next_cursor'])
        self.assertEqual(released['setup']['revision'], 5)
        self.assertEqual(self.store.list_work(), []); self.assertEqual(self.store.list_missions(), [])
        self.assertEqual(self.store.list_conversations(), [])
        self.assertTrue(self.store.verify_integrity()['passed'])

    def test_exact_idempotency_cas_and_owner_binding(self):
        first = self.accept(); duplicate = self.accept()
        self.assertTrue(duplicate['replayed']); self.assertEqual(first['receipt'], duplicate['receipt'])
        for changed in ({'owner_session_id': str(uuid.uuid4())}, {'check': {**check(), 'token_sha256': 'd'*64}},
                        {'authority': {**self.authority, 'actions': ['compute']}}):
            with self.assertRaises(ValueError): self.accept(**changed)
        starting = self.transition(first, 'starting')
        duplicate = self.manager.transition_runtime_setup(self.operation, 1, 'starting', c.empty_evidence(), owner_session_id=self.owner)
        self.assertTrue(duplicate['replayed']); self.assertEqual(starting['receipt'], duplicate['receipt'])
        with self.assertRaises(RuntimeSetupConflictError):
            self.manager.transition_runtime_setup(self.operation, 2, 'releasing', c.empty_evidence(), owner_session_id=str(uuid.uuid4()))
        with self.assertRaises(RuntimeSetupConflictError):
            self.manager.transition_runtime_setup(self.operation, 1, 'ready', c.empty_evidence(), owner_session_id=self.owner)

    def test_stale_check_unknown_selection_and_unsupported_evidence_fail_closed(self):
        for value in ({**check(), 'state': 'unknown'}, {**check(), 'raw_token': 'not-admitted'},
                      {**check(), 'expires_at': '2026-09-13T00:02:01+00:00'}):
            with self.assertRaises(ValueError): self.accept(check=value)
        self.clock[0] = '2026-09-13T00:02:01+00:00'
        with self.assertRaises(ValueError): self.accept()
        self.clock[0] = STAMP
        with self.assertRaises(ValueError): self.accept(resource_id='d'*64)
        self.assertEqual(self.store.verify_integrity()['runtime_setup_events'], 0)

    def test_uncertain_lease_survives_reopen_and_expiry_does_not_claim_exit(self):
        ready = self.ready()
        uncertain = self.transition(ready, 'uncertain', error=failure())
        self.store.close(); self.store = CommitService(self.root); self.manager = OrchestrationManager(self.store)
        self.clock[0] = '2026-09-13T00:16:00+00:00'
        self.assertEqual(self.manager.active_runtime_setup()['state'], 'uncertain')
        with self.assertRaises(ValueError): self.transition(uncertain, 'expired', release_reason='deadline')
        with self.assertRaises(ValueError): self.transition(uncertain, 'failed')
        expired = self.transition(uncertain, 'expired', release_reason='deadline', owned_process_exit_confirmed=True)
        self.assertEqual(expired['setup']['state'], 'expired'); self.assertIsNone(self.manager.active_runtime_setup())

    def test_ready_requires_actual_bound_runtime_and_preserves_retained_evidence(self):
        accepted = self.accept()
        with self.assertRaises(ValueError): self.transition(accepted, 'ready')
        starting = self.transition(accepted, 'starting')
        for changes in ({'started_by_this_setup': True}, {'runtime': observed_runtime('Ubuntu-Other'), 'started_by_this_setup': True}):
            with self.assertRaises(ValueError): self.transition(starting, 'ready', **changes)
        ready = self.transition(starting, 'ready', runtime=observed_runtime(), started_by_this_setup=True)
        with self.assertRaises(ValueError): self.transition(ready, 'releasing', runtime=None)
        with self.assertRaises(ValueError): self.transition(ready, 'released', release_reason='operator')

    def test_lost_acceptance_and_transition_ack_recover_same_commits_without_new_operation(self):
        original = self.manager.accept_runtime_setup; saved = []
        def lost(*args, **kwargs):
            saved.append(original(*args, **kwargs))
            raise OSError('Synthetic response loss after successful commit')
        with patch.object(self.manager, 'accept_runtime_setup', side_effect=lost):
            with self.assertRaises(OSError): self.accept()
        self.store.close(); self.store = CommitService(self.root); self.manager = OrchestrationManager(self.store)
        replay = self.accept(); self.assertEqual(replay['receipt'], saved[0]['receipt']); self.assertTrue(replay['replayed'])
        starting = self.transition(replay, 'starting')
        retry = self.manager.transition_runtime_setup(self.operation, 1, 'starting', c.empty_evidence(), owner_session_id=self.owner)
        self.assertEqual(starting['receipt'], retry['receipt']); self.assertTrue(retry['replayed'])
        self.assertEqual(self.store.verify_integrity()['runtime_setup_events'], 2)

    def test_transaction_failure_rolls_back_projection_and_event_together(self):
        with patch.object(self.store, '_runtime_setup_append', side_effect=OSError('Synthetic failed persistence')):
            with self.assertRaises(OSError): self.accept()
        self.assertIsNone(self.manager.get_runtime_setup(self.operation))
        accepted = self.accept()
        with patch.object(self.store, '_runtime_setup_append', side_effect=OSError('Synthetic failed persistence')):
            with self.assertRaises(OSError): self.transition(accepted, 'starting')
        self.assertEqual(self.manager.get_runtime_setup(self.operation), accepted['setup'])
        self.assertTrue(self.store.verify_integrity()['passed'])

    def _legacy_rows(self):
        return {row[0]: list(self.store._db.execute('SELECT * FROM "' + row[0] + '" ORDER BY rowid'))
                for row in self.store._db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'runtime_setup%'")}

    def test_schema7_migration_keeps_all_work_concept_settings_rows_and_receipts_byte_identical(self):
        preferences = {'id': 'desktop', 'theme': 'system', 'default_model': '', 'foundry_url': '', 'ollama_url': '', 'custom_instructions': ''}
        self.store.commit_workspace('settings', preferences, 0, authority={'issuer': 'local-user', 'scope': 'workspace-state', 'actions': ['commit']})
        request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'code', 'root': None,
                   'goal': 'Retained intent', 'provider': 'ollama', 'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Retain this intent'}]}
        self.store.submit_work(request, WORK_AUTHORITY)
        self.store.create_concept({'name': 'Retained', 'domain_tags': ['test'], 'thesis_statement': 'Preserve immutable intent'},
            {'issuer': 'local-user', 'scope': 'concept-development', 'actions': ['commit']}, str(uuid.uuid4()))
        before = {name: [tuple(row) for row in rows] for name, rows in self._legacy_rows().items()}
        self.store.close()
        with closing(sqlite3.connect(self.root / 'foundry.sqlite3')) as db:
            db.execute("DROP TABLE project_file_events")
            db.execute("DROP TABLE project_files")
            db.execute("DROP TABLE project_file_blobs")
            db.execute('DROP TABLE runtime_setup_events'); db.execute('DROP TABLE runtime_setups'); db.execute('PRAGMA user_version=7'); db.commit()
        self.store = CommitService(self.root)
        self.assertEqual(before, {name: [tuple(row) for row in rows] for name, rows in self._legacy_rows().items()})
        self.assertEqual(self.store._db.execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)
        self.assertNotIn('execution_distro', self.store.list_workspace('settings')[0])
        self.assertEqual(self.store.verify_integrity()['runtime_setup_events'], 0)

    def test_schema7_corruption_rejected_before_new_table_creation(self):
        self.store.close()
        with closing(sqlite3.connect(self.root / 'foundry.sqlite3')) as db:
            db.execute("DROP TABLE project_file_events")
            db.execute("DROP TABLE project_files")
            db.execute("DROP TABLE project_file_blobs")
            db.execute('DROP TABLE runtime_setup_events'); db.execute('DROP TABLE runtime_setups'); db.execute('PRAGMA user_version=7')
            db.execute("INSERT INTO workspace_documents VALUES ('settings','desktop','{}',1)"); db.commit()
        with self.assertRaises(RuntimeError): CommitService(self.root)
        with closing(sqlite3.connect(self.root / 'foundry.sqlite3')) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 7)
            self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_setup%'").fetchall(), [])

    def test_setup_projection_tampering_is_rejected(self):
        self.accept(); self.store.close()
        with closing(sqlite3.connect(self.root / 'foundry.sqlite3')) as db:
            db.execute('UPDATE runtime_setups SET active_lease=NULL'); db.commit()
        with self.assertRaises(RuntimeError): CommitService(self.root)

    def test_rehashed_authority_expansion_is_semantically_rejected(self):
        self.accept(); self.store.close()
        with closing(sqlite3.connect(self.root / 'foundry.sqlite3')) as db:
            db.row_factory = sqlite3.Row
            event = dict(db.execute('SELECT * FROM runtime_setup_events').fetchone())
            event['data'] = json.loads(event['data']); document = event['data']['document']
            document['authority']['actions'].append('install')
            event['state_digest'] = c.digest({'document': document, 'revision': event['revision']})
            del event['hash']; event['hash'] = c.digest(event)
            db.execute('UPDATE runtime_setup_events SET data=?,state_digest=?,hash=?',
                       (c.canonical(event['data']).decode(), event['state_digest'], event['hash']))
            db.execute('UPDATE runtime_setups SET document=?', (c.canonical(document).decode(),)); db.commit()
        with self.assertRaises(RuntimeError): CommitService(self.root)

    def test_diagnostic_reuse_rejects_raw_streams_invalid_types_and_credentials(self):
        diagnostic = {'schema': 'yur.execution-diagnostic.v1', 'phase': 'wsl_status', 'outcome': 'timeout', 'timeout_seconds': 8}
        evidence = {**c.empty_evidence(), 'error': {**failure(), 'diagnostics': diagnostic}}
        self.assertEqual(c.validate_evidence(evidence), evidence)
        for changed in ({**diagnostic, 'stdout': 'raw output'}, {**diagnostic, 'stdout_bytes': '8'},
                        {**diagnostic, 'outcome': 'ready'}, {**diagnostic, 'selected_distro': 'sk-' + 'Q'*48}):
            with self.assertRaises(ValueError): c.validate_evidence({**evidence, 'error': {**failure(), 'diagnostics': changed}})


if __name__ == '__main__': unittest.main()
