"""Conversation persistence checks use only isolated temporary state."""

from copy import deepcopy
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

from foundry.commit_service import CommitService, ConversationConflictError, SCHEMA_VERSION


AUTHORITY = {"issuer": "local-user", "scope": "conversation-state", "actions": ["commit"]}
MISSION_AUTHORITY = {"issuer": "local-user", "scope": "local-artifacts",
                     "actions": ["build", "run", "commit"], "max_candidates": 2, "max_input_bytes": 65536}
SOURCE_ROOT = Path(__file__).resolve().parents[1]


def conversation() -> dict:
    stamp = datetime.now(timezone.utc).isoformat()
    return {"id": str(uuid.uuid4()), "title": "Build a specialist", "createdAt": stamp,
            "updatedAt": stamp, "model": "local:auto", "messages": [
                {"id": str(uuid.uuid4()), "role": "user", "content": "Keep my original request.", "createdAt": stamp}
            ]}


class ConversationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "state"
        self.store = CommitService(self.root)

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def save(self, value, revision=0):
        return self.store.commit_conversation(value, revision, authority=AUTHORITY)

    def cli(self, payload, root=None):
        environment = {**os.environ, "YUR_DESKTOP_HOME": str(root or self.root),
                       "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1"}
        environment.pop("PYTHONPATH", None)
        result = subprocess.run([sys.executable, "-B", "-m", "foundry.conversation_cli"],
                                cwd=SOURCE_ROOT, env=environment,
                                input=json.dumps(payload).encode("utf-8"), capture_output=True, timeout=15)
        self.assertEqual(result.stderr, b"")
        return result.returncode, json.loads(result.stdout)

    def test_new_record_reload_and_revision(self):
        document = conversation()
        document["messages"].append({"id": str(uuid.uuid4()), "role": "assistant", "content": "Ready.",
                                     "createdAt": document["updatedAt"], "provider": "local",
                                     "evidence": {"observed": True, "source": ["request"]}})
        saved = self.save(document)
        self.assertEqual(saved, {**document, "revision": 1})
        document["title"] = "Renamed specialist"
        document["draft"] = "Next idea"
        self.assertEqual(self.save(document, 1)["revision"], 2)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.store.list_conversations(), [{**document, "revision": 2}])
        self.assertEqual(self.store.verify_integrity()["conversation_events"], 2)
        self.assertEqual(self.store.list_missions(), [])

    def test_conflict_between_connections_does_not_overwrite(self):
        document = conversation()
        self.save(document)
        with CommitService(self.root) as second:
            changed = {**document, "title": "Other writer"}
            second.commit_conversation(changed, 1, authority=AUTHORITY)
            with self.assertRaises(ConversationConflictError):
                self.save({**document, "title": "Stale writer"}, 1)
        self.assertEqual(self.store.list_conversations()[0]["title"], "Other writer")
        self.assertEqual(self.store.verify_integrity()["conversation_events"], 2)

    def test_optional_metadata_survives_commit_and_reopen_without_changing_legacy_documents(self):
        legacy = conversation()
        self.save(legacy)
        document = conversation()
        document["metadata"] = {"mode": "work", "project_id": str(uuid.uuid4()),
                                "pinned": True, "archived": False, "parent_id": legacy["id"]}
        self.save(document)
        self.store.close()
        self.store = CommitService(self.root)
        records = {record["id"]: record for record in self.store.list_conversations()}
        self.assertEqual(records[legacy["id"]], {**legacy, "revision": 1})
        self.assertEqual(records[document["id"]], {**document, "revision": 1})
        document["metadata"] = {"mode": "code", "project_id": None, "parent_id": None}
        self.assertEqual(self.save(document, 1)["metadata"], document["metadata"])

    def test_metadata_strict_contract(self):
        for metadata in (None, [], {"unknown": 1}, {"mode": "autonomous"},
                         {"pinned": 1}, {"archived": "false"}, {"project_id": "../path"},
                         {"parent_id": 0}):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                self.save({**conversation(), "metadata": metadata})
        document = conversation()
        document["metadata"] = {"parent_id": document["id"]}
        with self.assertRaises(ValueError):
            self.save(document)
        self.assertEqual(self.store.list_conversations(), [])

    def test_source_draft_references_survive_reopen_remove_and_conflict_without_reading_source(self):
        legacy = conversation()
        self.save(legacy)
        reference = {"source_id": "yur-os", "relative_path": "proto/spine.proto",
                     "sha256": "a" * 64, "name": "Spine service contract"}
        document = {**conversation(), "draft": "Read this contract.", "source_selections": [reference]}
        # Saving a reference does not read a donor or confer acquisition authority.
        with patch("foundry.sources.read_checked", side_effect=AssertionError("Unexpected source acquisition")):
            self.save(document)
        document["source_selections"][0]["name"] = "Caller mutation"
        self.store.close()
        self.store = CommitService(self.root)
        records = {item["id"]: item for item in self.store.list_conversations()}
        self.assertNotIn("source_selections", records[legacy["id"]])
        retained = records[document["id"]]
        self.assertEqual(retained["source_selections"][0]["name"], "Spine service contract")
        removed = {key: value for key, value in retained.items() if key != "revision"}
        removed["source_selections"] = []
        self.save(removed, 1)
        with self.assertRaises(ConversationConflictError):
            self.save(document, 1)
        code, reply = self.cli({"command": "list"})
        self.assertEqual(code, 0)
        actual = next(item for item in reply["result"]["conversations"] if item["id"] == document["id"])
        self.assertEqual(actual["source_selections"], [])
        self.assertEqual(actual["revision"], 2)
        self.assertTrue(self.store.verify_integrity()["passed"])
        self.assertEqual(self.store.list_missions(), [])

    def test_source_references_reject_content_authority_duplicates_paths_and_overflow(self):
        reference = {"source_id": "yur-os", "relative_path": "proto/spine.proto",
                     "sha256": "a" * 64, "name": "Spine contract"}
        invalid = [None, {}, [reference] * 4, [reference, {**reference, "relative_path": "PROTO/SPINE.PROTO"}]]
        for field, value in (("content", "Secret source"), ("authority", AUTHORITY), ("root", "D:/private"),
                             ("source_id", "../unknown"), ("source_id", ""), ("source_id", "x" * 81),
                             ("relative_path", "/absolute"), ("relative_path", "proto/../private"),
                             ("relative_path", "proto\\spine.proto"), ("relative_path", "D:/private"),
                             ("relative_path", "proto//spine.proto"), ("relative_path", "x" * 301),
                             ("sha256", "A" * 64), ("sha256", "a" * 63),
                             ("name", "x" * 201), ("name", "line\nbreak"), ("name", None)):
            invalid.append([{**reference, field: value}])
        for references in invalid:
            with self.subTest(references=references), self.assertRaises(ValueError):
                self.save({**conversation(), "source_selections": references})
        self.assertEqual(self.store.list_conversations(), [])

    def test_new_id_with_nonzero_revision_cannot_impersonate_existing(self):
        document = conversation()
        self.save(document)
        document["id"] = str(uuid.uuid4())
        with self.assertRaises(ConversationConflictError):
            self.save(document, 1)
        self.assertEqual(len(self.store.list_conversations()), 1)

    def test_immutable_created_at_and_monotonic_updated_at(self):
        document = conversation()
        document["createdAt"] = "2025-01-01T00:00:00Z"
        self.save(document)
        for changed in ({**document, "createdAt": "2025-02-01T00:00:00Z"},
                        {**document, "updatedAt": "2025-01-02T00:00:00Z"}):
            with self.assertRaises(ValueError):
                self.save(changed, 1)
        self.assertEqual(self.store.list_conversations()[0]["revision"], 1)

    def test_local_conversation_authority_is_separate(self):
        for authority in (None, {}, MISSION_AUTHORITY, {**AUTHORITY, "issuer": "model"},
                          {**AUTHORITY, "actions": ["commit", "run"]}):
            with self.assertRaises(ValueError):
                self.store.commit_conversation(conversation(), 0, authority=authority)
        self.assertEqual(self.store.list_conversations(), [])

    def test_document_contract_rejects_unknown_fields_and_invalid_values(self):
        invalid = []
        for field, value in (("id", "../state"), ("title", "x" * 161), ("draft", "x" * 32001),
                             ("model", "x" * 257), ("createdAt", "2026-01-01"),
                             ("updatedAt", "2026-01-01T00:00:00"), ("revision", 1), ("authority", AUTHORITY)):
            invalid.append({**conversation(), field: value})
        for field, value in (("id", "invalid"), ("role", "system"), ("content", "x" * 100001),
                             ("provider", "x" * 257), ("evidence", []), ("path", "ignored")):
            document = conversation()
            document["messages"][0][field] = value
            invalid.append(document)
        invalid.append({**conversation(), "messages": [conversation()["messages"][0]] * 201})
        document = conversation()
        document["messages"] *= 2
        invalid.append(document)
        for document in invalid:
            with self.subTest(keys=list(document)):
                with self.assertRaises(ValueError):
                    self.save(document)
        for revision in (True, -1, 1.0, "0", 2**63):
            with self.assertRaises(ValueError):
                self.save(conversation(), revision)
        self.assertEqual(self.store.list_conversations(), [])

    def test_document_size_and_nonfinite_json_rejected(self):
        document = conversation()
        document["messages"][0]["evidence"] = {"payload": "a" * (1024 * 1024)}
        with self.assertRaisesRegex(ValueError, "1 MiB"):
            self.save(document)
        document["messages"][0]["evidence"] = {"number": float("nan")}
        with self.assertRaises(ValueError):
            self.save(document)

    def test_history_overflow_rejected_without_truncation(self):
        self.save(conversation())
        with patch("foundry.commit_service.MAX_CONVERSATIONS", 1):
            with self.assertRaisesRegex(ValueError, "200 conversations"):
                self.save(conversation())
        document = deepcopy(self.store.list_conversations()[0])
        document.pop("revision")
        document["draft"] = "x" * 30000
        with patch("foundry.commit_service.MAX_CONVERSATION_LIST_BYTES", 4000):
            with self.assertRaisesRegex(ValueError, "4 MiB"):
                self.save(document, 1)
        self.assertEqual(len(self.store.list_conversations()), 1)
        self.assertNotIn("draft", self.store.list_conversations()[0])

    def test_event_failure_rolls_back_document_and_revision(self):
        document = conversation()
        with patch.object(self.store, "_append_conversation_event", side_effect=RuntimeError("Injected event failure")):
            with self.assertRaises(RuntimeError):
                self.save(document)
        self.assertEqual(self.store.list_conversations(), [])
        self.assertEqual(self.store.verify_integrity()["conversation_events"], 0)

    def test_conversation_tampering_fails_closed_on_read_write_and_restart(self):
        document = conversation()
        self.save(document)
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.execute("UPDATE conversations SET document=? WHERE id=?", (json.dumps({**document, "title": "Tampered"}), document["id"]))
        for operation in (self.store.list_conversations, lambda: self.save(conversation())):
            with self.assertRaisesRegex(RuntimeError, "integrity check failed"):
                operation()
        self.store.close()
        with self.assertRaisesRegex(RuntimeError, "integrity check failed"):
            CommitService(self.root)

    def test_conversation_event_tampering_fails_closed(self):
        self.save(conversation())
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.execute("UPDATE conversation_events SET data='{}'")
        with self.assertRaisesRegex(RuntimeError, "Conversation event hash chain"):
            self.store.verify_integrity()

    def test_schema_migration_preserves_mission_receipts_and_clocks(self):
        mission = self.store.submit({"name": "Unchanged mission"}, "mission-1", MISSION_AUTHORITY)
        events = self.store.events(mission["id"])
        before = self.store.verify_integrity()
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute("DROP TABLE concept_events")
            raw.execute("DROP TABLE concept_documents")
            raw.execute("DROP TABLE work_schedule_events")
            raw.execute("DROP TABLE work_schedules")
            raw.execute("DROP TABLE work_events")
            raw.execute("DROP TABLE work_missions")
            raw.execute("DROP TABLE workspace_events")
            raw.execute("DROP TABLE workspace_documents")
            raw.execute("DROP TABLE conversation_events")
            raw.execute("DROP TABLE conversations")
            raw.execute("DROP TABLE runtime_setup_events")
            raw.execute("DROP TABLE runtime_setups")
            raw.execute("PRAGMA user_version=1")
        self.store = CommitService(self.root)
        self.save(conversation())
        self.assertEqual(self.store.get_mission(mission["id"]), mission)
        self.assertEqual(self.store.events(mission["id"]), events)
        after = self.store.verify_integrity()
        self.assertEqual(before["head_hash"], after["head_hash"])
        self.assertEqual(after["events"], 1)
        self.assertEqual(after["conversation_events"], 1)
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            self.assertEqual(raw.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_migration_rolls_back_when_existing_mission_is_corrupt(self):
        self.store.submit({"name": "Old mission"}, "old-mission", MISSION_AUTHORITY)
        self.store.close()
        database = self.root / "foundry.sqlite3"
        with closing(sqlite3.connect(database)) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute("DROP TABLE concept_events")
            raw.execute("DROP TABLE concept_documents")
            raw.execute("DROP TABLE work_schedule_events")
            raw.execute("DROP TABLE work_schedules")
            raw.execute("DROP TABLE work_events")
            raw.execute("DROP TABLE work_missions")
            raw.execute("DROP TABLE workspace_events")
            raw.execute("DROP TABLE workspace_documents")
            raw.execute("DROP TABLE conversation_events")
            raw.execute("DROP TABLE conversations")
            raw.execute("DROP TABLE runtime_setup_events")
            raw.execute("DROP TABLE runtime_setups")
            raw.execute("PRAGMA user_version=1")
            raw.execute("UPDATE missions SET status='cancelled'")
        with self.assertRaisesRegex(RuntimeError, "integrity check failed"):
            CommitService(self.root)
        with closing(sqlite3.connect(database)) as raw, raw:
            self.assertEqual(raw.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertIsNone(raw.execute("SELECT name FROM sqlite_master WHERE name='conversations'").fetchone())

    def test_cli_roundtrip_and_conflict_error_envelope(self):
        document = conversation()
        code, result = self.cli({"command": "save", "conversation": document, "expected_revision": 0})
        self.assertEqual(code, 0)
        self.assertEqual(result["result"]["conversation"], {**document, "revision": 1})
        code, result = self.cli({"command": "list"})
        self.assertEqual(code, 0)
        self.assertEqual(len(result["result"]["conversations"]), 1)
        code, result = self.cli({"command": "save", "conversation": document, "expected_revision": 0})
        self.assertEqual(code, 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "CONFLICT")

    def test_cli_absent_list_creates_no_state_and_rejects_arbitrary_fields(self):
        unused = Path(self.temporary.name) / "untouched"
        code, result = self.cli({"command": "list"}, unused)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"ok": True, "result": {"conversations": []}})
        self.assertFalse(unused.exists())
        code, result = self.cli({"command": "list", "path": str(self.root)})
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "INVALID_REQUEST")
        code, result = self.cli({"command": "list"}, Path("relative-state"))
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "INVALID_REQUEST")


if __name__ == "__main__":
    unittest.main()
