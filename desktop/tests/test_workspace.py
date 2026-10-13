"""Workspace persistence acceptance through the existing Commit Service authority."""

from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService, SCHEMA_VERSION, WorkspaceConflictError


AUTHORITY = {"issuer": "local-user", "scope": "workspace-state", "actions": ["commit"]}
CONVERSATION_AUTHORITY = {"issuer": "local-user", "scope": "conversation-state", "actions": ["commit"]}
MISSION_AUTHORITY = {"issuer": "local-user", "scope": "local-artifacts", "actions": ["build", "run", "commit"],
                     "max_candidates": 2, "max_input_bytes": 65536}
SOURCE_ROOT = Path(__file__).resolve().parents[1]


def project():
    stamp = datetime.now(timezone.utc).isoformat()
    return {"id": str(uuid.uuid4()), "name": "Quantity review", "root": "", "instructions": "Check source quantities.",
            "createdAt": stamp, "updatedAt": stamp}


def settings():
    return {"id": "desktop", "theme": "system", "default_model": "local:auto",
            "foundry_url": "http://127.0.0.1:8080", "ollama_url": "http://localhost:11434",
            "custom_instructions": "Use the selected project context."}


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "state"
        self.store = CommitService(self.root)

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def save(self, kind, document, revision=0):
        return self.store.commit_workspace(kind, document, revision, authority=AUTHORITY)

    def test_typed_preferences_commit_reopen_and_reject_invalid_updates_atomically(self):
        from foundry.settings_contract import preference_fields
        original = settings()
        self.save('settings', original)
        self.assertNotIn('preferences', self.store.list_workspace('settings')[0])
        preferences = {key: rule['default'] for key, rule in preference_fields().items()}
        preferences.update(display_name='Purchased desktop', send_shortcut='ctrl-enter', speech_rate=1.2)
        expected = self.save('settings', {**original, 'preferences': preferences}, 1)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.store.list_workspace('settings'), [expected])
        before = self.store.verify_integrity()['workspace_events']
        for bad in ({'subscription': True}, {'font_size': True}, {'speech_rate': float('nan')},
                    {'speech_rate': 3}, {'display_name': 'x' * 81}, {'display_name': 'unsafe\0value'},
                    {'browser_enabled': 'false'}, {'send_shortcut': 'unbound'}, []):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                self.save('settings', {**original, 'preferences': bad}, 2)
        self.assertEqual(self.store.list_workspace('settings'), [expected])
        self.assertEqual(self.store.verify_integrity()['workspace_events'], before)

    def test_optional_execution_distribution_is_only_a_preference_and_preserves_legacy_shape(self):
        original = settings()
        self.save('settings', original)
        self.assertNotIn('execution_distro', self.store.list_workspace('settings')[0])
        saved = self.save('settings', {**original, 'execution_distro': 'Ubuntu-24.04'}, 1)
        self.assertEqual(saved['execution_distro'], 'Ubuntu-24.04')
        self.assertIsNone(self.store.active_runtime_setup())
        self.assertEqual(self.store.list_work(), [])
        self.save('settings', {**original, 'execution_distro': ''}, 2)
        for selected in (None, True, '../Ubuntu', 'Ubuntu --exec', 'x'*65, 'sk-' + 'Q'*48):
            with self.assertRaises(ValueError): self.save('settings', {**original, 'execution_distro': selected}, 3)
        self.assertEqual(self.store.list_workspace('settings')[0]['revision'], 3)

    def cli(self, payload, root=None):
        environment = {**os.environ, "YUR_DESKTOP_HOME": str(root or self.root),
                       "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1"}
        environment.pop("PYTHONPATH", None)
        result = subprocess.run([sys.executable, "-B", "-m", "foundry.conversation_cli"],
                                cwd=SOURCE_ROOT, env=environment, input=json.dumps(payload).encode("utf-8"),
                                capture_output=True, timeout=15)
        self.assertEqual(result.stderr, b"")
        return result.returncode, json.loads(result.stdout)

    def test_projects_and_settings_survive_reopen_and_online_backup_with_history(self):
        selected = project()
        selected["root"] = str(Path(self.temporary.name) / "selected-but-unopened")
        preferences = settings()
        self.assertEqual(self.save("project", selected), {**selected, "revision": 1})
        self.save("settings", preferences)
        preferences["theme"] = "dark"
        self.save("settings", preferences, 1)
        before = self.store.verify_integrity()
        self.assertEqual(before["workspace_documents"], 2)
        self.assertEqual(before["workspace_events"], 3)
        self.assertEqual(self.store.list_missions(), [])
        self.assertEqual(self.store.list_conversations(), [])
        self.assertFalse(Path(selected["root"]).exists())
        backup_root = Path(self.temporary.name) / "backup"
        backup_root.mkdir()
        with closing(sqlite3.connect(self.store.path)) as source, closing(sqlite3.connect(backup_root / "foundry.sqlite3")) as destination:
            source.backup(destination)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.store.list_workspace("project"), [{**selected, "revision": 1}])
        self.assertEqual(self.store.list_workspace("settings"), [{**preferences, "revision": 2}])
        with CommitService(backup_root) as backup:
            self.assertEqual(backup.verify_integrity(), before)
            self.assertEqual(backup.list_workspace("settings"), [{**preferences, "revision": 2}])

    def test_optimistic_revision_conflicts_between_connections_leave_original(self):
        document = project()
        self.save("project", document)
        with CommitService(self.root) as second:
            changed = {**document, "name": "Other writer"}
            second.commit_workspace("project", changed, 1, authority=AUTHORITY)
            with self.assertRaises(WorkspaceConflictError):
                self.save("project", {**document, "name": "Stale writer"}, 1)
        self.assertEqual(self.store.list_workspace("project"), [{**changed, "revision": 2}])
        with self.assertRaises(WorkspaceConflictError):
            self.save("project", project(), 1)
        for revision in (-1, True, 1.0, "0", 2**63):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                self.save("project", project(), revision)

    def test_project_clocks_are_immutable_and_monotonic(self):
        document = project()
        document["createdAt"] = "2025-01-01T00:00:00Z"
        self.save("project", document)
        for changed in ({**document, "createdAt": "2025-02-01T00:00:00Z"},
                        {**document, "updatedAt": "2025-01-02T00:00:00Z"}):
            with self.assertRaises(ValueError):
                self.save("project", changed, 1)
        self.assertEqual(self.store.list_workspace("project")[0]["revision"], 1)

    def test_workspace_authority_cannot_execute_or_persist_other_lifecycles(self):
        for authority in (None, {}, CONVERSATION_AUTHORITY, MISSION_AUTHORITY,
                          {**AUTHORITY, "issuer": "model"}, {**AUTHORITY, "actions": ["commit", "run"]}):
            with self.subTest(authority=authority), self.assertRaises(ValueError):
                self.store.commit_workspace("settings", settings(), 0, authority=authority)
        mission = self.store.submit({"name": "Unrelated mission"}, "unrelated", MISSION_AUTHORITY)
        events = self.store.events(mission["id"])
        stamp = datetime.now(timezone.utc).isoformat()
        conversation = {"id": str(uuid.uuid4()), "title": "Existing conversation", "model": "local:auto",
                        "createdAt": stamp, "updatedAt": stamp, "messages": []}
        self.store.commit_conversation(conversation, 0, authority=CONVERSATION_AUTHORITY)
        before = self.store.verify_integrity()
        self.save("settings", settings())
        after = self.store.verify_integrity()
        self.assertEqual(self.store.get_mission(mission["id"]), mission)
        self.assertEqual(self.store.events(mission["id"]), events)
        self.assertEqual(before["head_hash"], after["head_hash"])
        self.assertEqual(before["conversation_head_hash"], after["conversation_head_hash"])

    def test_documents_reject_unknown_fields_wrong_types_and_oversized_content(self):
        invalid = [("project", {**project(), field: value}) for field, value in (
            ("id", "../state"), ("name", " "), ("name", "x" * 161), ("root", "x" * 4097),
            ("root", None), ("root", "root\0suffix"), ("instructions", "x" * 32001),
            ("createdAt", "yesterday"), ("updatedAt", "2000-01-01T00:00:00Z"), ("revision", 2), ("authority", AUTHORITY))]
        invalid += [("settings", {**settings(), field: value}) for field, value in (
            ("id", str(uuid.uuid4())), ("theme", "neon"), ("default_model", "x" * 257),
            ("custom_instructions", "x" * 32001), ("custom_instructions", float("nan")),
            ("createdAt", "2026-01-01T00:00:00Z"), ("api_key", "not-accepted"))]
        invalid += [("project", {}), ("settings", []), ("mission", project())]
        for kind, document in invalid:
            with self.subTest(kind=kind, keys=list(document)), self.assertRaises(ValueError):
                self.save(kind, document)
        with self.assertRaisesRegex(ValueError, "64 KiB"):
            self.save("project", {**project(), "instructions": "界" * 32000})
        with self.assertRaisesRegex(ValueError, "valid UTF-8"):
            self.save("settings", {**settings(), "custom_instructions": "\ud800"})
        self.assertEqual(self.store.list_workspace("settings"), [])

    def test_endpoints_allow_only_unconfigured_https_or_loopback_http_origins(self):
        document = settings()
        for index, value in enumerate(("", "https://models.example.com", "https://models.example.com/",
                                       "http://127.0.0.1:8000", "http://[::1]:11434", "http://localhost:11434")):
            document["foundry_url"] = value
            self.save("settings", document, index)
        for value in ("http://remote.example.com", "file:///tmp/config", "javascript:alert(1)",
                      "https://user:pass@models.example.com", "https://user@models.example.com",
                      "https://models.example.com/api", "https://models.example.com?token=test",
                      "https://models.example.com?", "https://models.example.com#", "https://models.example.com/#fragment",
                      " https://models.example.com", "https://models.example.com\n", "https://models.example.com:0",
                      "https://models.example.com:65536", "http://127.0.0.1\\@remote.example.com"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.save("settings", {**settings(), "ollama_url": value}, 6)
        self.assertEqual(self.store.list_workspace("settings")[0]["revision"], 6)

    def test_recognized_credentials_are_not_written_or_echoed(self):
        marker = "sk-" + "synthetic" * 5
        with self.assertRaisesRegex(ValueError, "must not contain credentials") as error:
            self.save("settings", {**settings(), "custom_instructions": "Use " + marker})
        self.assertNotIn(marker, str(error.exception))
        self.assertEqual(self.store.verify_integrity()["workspace_events"], 0)

    def test_boundaries_fail_honestly_without_omitting_records(self):
        document = project()
        self.save("project", document)
        with patch("foundry.commit_service.MAX_WORKSPACE_DOCUMENTS", 1):
            with self.assertRaisesRegex(ValueError, "limited to"):
                self.save("project", project())
        with patch("foundry.commit_service.MAX_WORKSPACE_LIST_BYTES", 1000):
            with self.assertRaisesRegex(ValueError, "4 MiB"):
                self.save("project", {**document, "instructions": "x" * 2000}, 1)
        self.assertEqual(self.store.list_workspace("project"), [{**document, "revision": 1}])

    def test_event_failure_rolls_back_new_and_updated_documents(self):
        document = settings()
        with patch.object(self.store, "_append_workspace_event", side_effect=RuntimeError("Interrupted commit")):
            with self.assertRaisesRegex(RuntimeError, "Interrupted commit"):
                self.save("settings", document)
        self.assertEqual(self.store.list_workspace("settings"), [])
        self.save("settings", document)
        with patch.object(self.store, "_append_workspace_event", side_effect=RuntimeError("Interrupted update")):
            with self.assertRaisesRegex(RuntimeError, "Interrupted update"):
                self.save("settings", {**document, "theme": "light"}, 1)
        self.assertEqual(self.store.list_workspace("settings"), [{**document, "revision": 1}])
        self.assertEqual(self.store.verify_integrity()["workspace_events"], 1)

    def test_workspace_tampering_fails_on_read_write_and_restart(self):
        self.save("settings", settings())
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.execute("UPDATE workspace_documents SET document=?", (json.dumps({**settings(), "theme": "dark"}),))
        for operation in (lambda: self.store.list_workspace("settings"), lambda: self.save("project", project())):
            with self.assertRaisesRegex(RuntimeError, "integrity check failed"):
                operation()
        self.store.close()
        with self.assertRaisesRegex(RuntimeError, "integrity check failed"):
            CommitService(self.root)

    def test_workspace_event_tampering_fails_closed(self):
        self.save("project", project())
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.execute("UPDATE workspace_events SET data='{}'")
        with self.assertRaisesRegex(RuntimeError, "Workspace event hash chain"):
            self.store.verify_integrity()

    def test_v2_migration_preserves_missions_and_conversations_and_rolls_back_corruption(self):
        self.store.submit({"name": "Prior mission"}, "prior", MISSION_AUTHORITY)
        stamp = datetime.now(timezone.utc).isoformat()
        old_conversation = {"id": str(uuid.uuid4()), "title": "Before workspace", "createdAt": stamp,
                            "updatedAt": stamp, "model": "local:auto", "messages": []}
        self.store.commit_conversation(old_conversation, 0, authority=CONVERSATION_AUTHORITY)
        before = self.store.verify_integrity()
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute("DROP TABLE runtime_setup_events")
            raw.execute("DROP TABLE runtime_setups")
            raw.execute("DROP TABLE concept_events")
            raw.execute("DROP TABLE concept_documents")
            raw.execute("DROP TABLE work_schedule_events")
            raw.execute("DROP TABLE work_schedules")
            raw.execute("DROP TABLE work_events")
            raw.execute("DROP TABLE work_missions")
            raw.execute("DROP TABLE workspace_events")
            raw.execute("DROP TABLE workspace_documents")
            raw.execute("PRAGMA user_version=2")
        self.store = CommitService(self.root)
        after = self.store.verify_integrity()
        self.assertEqual(before, after)
        self.assertEqual(self.store.list_conversations(), [{**old_conversation, "revision": 1}])
        self.save("settings", settings())
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute("DROP TABLE runtime_setup_events")
            raw.execute("DROP TABLE runtime_setups")
            raw.execute("DROP TABLE concept_events")
            raw.execute("DROP TABLE concept_documents")
            raw.execute("DROP TABLE work_schedule_events")
            raw.execute("DROP TABLE work_schedules")
            raw.execute("DROP TABLE work_events")
            raw.execute("DROP TABLE work_missions")
            raw.execute("DROP TABLE workspace_events")
            raw.execute("DROP TABLE workspace_documents")
            raw.execute("PRAGMA user_version=2")
            raw.execute("UPDATE conversations SET revision=2")
        with self.assertRaisesRegex(RuntimeError, "integrity check failed"):
            CommitService(self.root)
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw:
            self.assertEqual(raw.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertIsNone(raw.execute("SELECT name FROM sqlite_master WHERE name='workspace_documents'").fetchone())

    def test_cli_roundtrip_conflicts_strict_fields_and_missing_list_no_state(self):
        unused = Path(self.temporary.name) / "unused"
        for kind in ("project", "settings"):
            code, result = self.cli({"command": "workspace_list", "kind": kind}, unused)
            self.assertEqual((code, result), (0, {"ok": True, "result": {"documents": []}}))
            self.assertFalse(unused.exists())
        document = settings()
        payload = {"command": "workspace_save", "kind": "settings", "document": document, "expected_revision": 0}
        code, result = self.cli(payload)
        self.assertEqual(code, 0)
        self.assertEqual(result["result"]["document"], {**document, "revision": 1})
        code, result = self.cli({"command": "workspace_list", "kind": "settings"})
        self.assertEqual(result["result"]["documents"], [{**document, "revision": 1}])
        code, result = self.cli(payload)
        self.assertEqual((code, result["error"]["code"]), (1, "CONFLICT"))
        for invalid in ({"command": "workspace_list", "kind": "all"},
                        {"command": "workspace_list", "kind": "project", "path": str(self.root)},
                        {**payload, "authority": AUTHORITY},
                        {**payload, "document": {**document, "revision": 1}}):
            code, result = self.cli(invalid)
            self.assertEqual((code, result["error"]["code"]), (1, "INVALID_REQUEST"))
        with closing(sqlite3.connect(self.store.path)) as raw:
            self.assertEqual(raw.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
