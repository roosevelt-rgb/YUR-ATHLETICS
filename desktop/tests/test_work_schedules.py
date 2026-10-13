"""Schedule transactions and replay through the real local Work authority."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_schedules import SCHEDULE_AUTHORITY, ScheduleConflictError


class WorkScheduleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "journal"
        self.store = CommitService(self.root)
        self.addCleanup(lambda: self.store.close())
        self.manager = OrchestrationManager(self.store)
        self.time = datetime.now(timezone.utc)

    def document(self, **changes):
        stamp = self.time.isoformat()
        return {"id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "name": "Recurring evidence review",
                "goal": "Inspect the selected source and report its current value.", "root": None,
                "provider": "ollama", "model": "fixture", "mode": "work", "interval_seconds": 60,
                "max_runs": 2, "enabled": True, "created_at": stamp, "updated_at": stamp,
                "next_run_at": stamp, "runs_completed": 0, "active_request_id": None, "last_mission_id": None,
                "last_error": "", **changes}

    def save(self, document, revision=0):
        return self.store.save_schedule(document, revision, SCHEDULE_AUTHORITY)

    @staticmethod
    def edited(saved, **changes):
        return {key: changes.get(key, value) for key, value in saved.items() if key != "revision"}

    def claim(self, offset=0):
        return self.store.claim_due_schedules(self.time + timedelta(seconds=offset))[0]

    def finish_work(self, claim):
        return self.manager.run_work(claim["request"], lambda *_: {"content": "Actual scheduled result", "tool_calls": []})

    def test_due_claim_is_atomic_goal_only_and_recovers_same_request_after_reopen(self):
        doc = self.document(next_run_at=(self.time + timedelta(seconds=60)).isoformat())
        self.save(doc)
        self.assertEqual(self.store.claim_due_schedules(self.time), [])
        claimed = self.claim(60)
        self.assertFalse(claimed["replayed"])
        self.assertEqual(claimed["request"]["messages"], [{"role": "user", "content": doc["goal"]}])
        self.assertEqual(set(claimed["request"]), {"request_id", "conversation_id", "mode", "goal", "root", "provider", "model", "messages"})
        first_head = self.store.verify_integrity()["schedule_head_hash"]
        self.store.close()
        self.store = CommitService(self.root)
        self.manager = OrchestrationManager(self.store)
        recovered = self.claim(600)
        self.assertTrue(recovered["replayed"])
        self.assertEqual(recovered["request"], claimed["request"])
        self.assertEqual(recovered["schedule"], claimed["schedule"])
        self.assertEqual(self.store.verify_integrity()["schedule_head_hash"], first_head)
        self.assertEqual(self.store.list_work(), [])
        self.assertEqual(self.store.list_conversations(), [])

    def test_independent_connections_claim_once_and_complete_once(self):
        doc = self.document()
        self.save(doc)
        barrier = threading.Barrier(2)

        def claim():
            with CommitService(self.root) as store:
                barrier.wait(timeout=5)
                return store.claim_due_schedules(self.time)[0]

        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda _: claim(), range(2)))
        self.assertEqual(claims[0]["request"], claims[1]["request"])
        self.assertEqual(sorted(item["replayed"] for item in claims), [False, True])
        self.assertEqual(self.store.verify_integrity()["schedule_events"], 2)
        work = self.finish_work(claims[0])
        barrier = threading.Barrier(2)

        def complete():
            with CommitService(self.root) as store:
                barrier.wait(timeout=5)
                return store.complete_schedule(doc["id"], work["id"], self.time + timedelta(seconds=2))

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: complete(), range(2)))
        self.assertEqual(sorted(item["replayed"] for item in results), [False, True])
        self.assertEqual(self.store.get_schedule(doc["id"])["runs_completed"], 1)
        self.assertEqual(self.store.verify_integrity()["schedule_events"], 3)

    def test_completed_run_replays_om_without_model_then_advances_and_exhausts_budget(self):
        doc = self.document()
        self.save(doc)
        first = self.claim()
        mission = self.finish_work(first)
        replay = self.manager.run_work(self.claim()["request"], lambda *_: self.fail("A completed request must not call its model again"))
        self.assertEqual(replay["id"], mission["id"])
        done = self.store.complete_schedule(doc["id"], mission["id"], self.time + timedelta(seconds=1))
        self.assertTrue(done["schedule"]["enabled"])
        self.assertEqual(done["schedule"]["next_run_at"], (self.time + timedelta(seconds=61)).isoformat())
        self.assertEqual(self.store.claim_due_schedules(self.time + timedelta(seconds=60)), [])
        second = self.claim(61)
        self.assertNotEqual(first["request"]["request_id"], second["request"]["request_id"])
        second_work = self.finish_work(second)
        completed = self.store.complete_schedule(doc["id"], second_work["id"], self.time + timedelta(seconds=62))
        self.assertFalse(completed["schedule"]["enabled"])
        self.assertEqual(completed["schedule"]["runs_completed"], 2)
        self.assertEqual(self.store.claim_due_schedules(self.time + timedelta(days=1)), [])
        old_replay = self.store.complete_schedule(doc["id"], mission["id"])
        self.assertTrue(old_replay["replayed"])
        self.assertEqual(old_replay["schedule"]["runs_completed"], 2)

    def test_failure_is_recorded_and_cancellation_disables_future_runs(self):
        doc = self.document(max_runs=3)
        self.save(doc)
        claimed = self.claim()

        def fail(*_):
            raise ValueError("Provider fixture failed before answer")

        with self.assertRaisesRegex(ValueError, "Provider fixture"):
            self.manager.run_work(claimed["request"], fail)
        failed = self.store.get_work_by_request(claimed["request"]["request_id"])
        recorded = self.store.complete_schedule(doc["id"], failed["id"], self.time + timedelta(seconds=1))
        self.assertEqual(recorded["mission_status"], "failed")
        self.assertIn("Provider fixture", recorded["schedule"]["last_error"])
        self.assertEqual(recorded["schedule"]["runs_completed"], 1)
        self.assertTrue(recorded["schedule"]["enabled"])
        # A separately resumed failed Work keeps the historical failed revision.
        self.manager.run_work(claimed["request"], lambda *_: {"content": "Independent retry succeeded"})
        self.assertTrue(self.store.verify_integrity()["passed"])
        next_claim = self.claim(61)
        cancelled = self.manager.cancel_work_request(next_claim["request"])
        result = self.store.complete_schedule(doc["id"], cancelled["id"], self.time + timedelta(seconds=62))
        self.assertEqual(result["mission_status"], "cancelled")
        self.assertFalse(result["schedule"]["enabled"])
        self.assertEqual(result["schedule"]["runs_completed"], 2)
        self.assertEqual(self.store.claim_due_schedules(self.time + timedelta(days=1)), [])

    def test_user_cas_and_active_disable_preserve_original_request(self):
        doc = self.document()
        saved = self.save(doc)
        with CommitService(self.root) as second:
            changed = second.save_schedule(self.edited(saved, name="Revised schedule"), saved["revision"], SCHEDULE_AUTHORITY)
        with self.assertRaises(ScheduleConflictError):
            self.save(self.edited(saved, name="Stale schedule"), saved["revision"])
        active = self.claim()["schedule"]
        for update in ({"goal": "Changed goal"}, {"root": "another root"}, {"model": "other"}, {"next_run_at": (self.time + timedelta(days=1)).isoformat()}):
            with self.subTest(update=update), self.assertRaisesRegex(ValueError, "only be disabled"):
                self.save(self.edited(active, **update), active["revision"])
        disabled = self.save(self.edited(active, enabled=False), active["revision"])
        replay = self.claim()
        self.assertTrue(replay["replayed"])
        self.assertFalse(replay["schedule"]["enabled"])
        self.assertEqual(replay["request"]["request_id"], disabled["active_request_id"])
        self.assertEqual(replay["request"]["goal"], doc["goal"])

    def test_completion_rejects_unrelated_request_conversation_and_nonterminal_work(self):
        doc = self.document()
        self.save(doc)
        active = self.claim()
        unrelated = self.manager.run_work({**active["request"], "request_id": str(uuid.uuid4())}, lambda *_: {"content": "Other mission"})
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.store.complete_schedule(doc["id"], unrelated["id"])
        from foundry.work_engine import AUTHORITY
        pending = self.store.submit_work(active["request"], AUTHORITY)
        with self.assertRaisesRegex(ValueError, "terminal"):
            self.store.complete_schedule(doc["id"], pending["id"])
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.store.record_schedule_dispatch_error(doc["id"], active["request"]["request_id"], "Must not bypass pending Work")
        self.assertEqual(self.store.get_schedule(doc["id"])["runs_completed"], 0)

    def test_new_dispatch_reacquires_changed_source_and_has_no_prior_compiled_context(self):
        source = Path(self.temp.name) / "source"
        source.mkdir()
        target = source / "current.md"
        target.write_text("SOURCE_VERSION_ONE", encoding="utf-8")
        doc = self.document(root=str(source), goal="Read current.md and report its current value.")
        self.save(doc)

        def model(messages, _tools):
            outputs = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
            if not outputs:
                return {"content": "", "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "current.md"}}}]}
            return {"content": outputs[-1]["content"]}

        first = self.claim()
        mission = self.manager.run_work(first["request"], model)
        self.assertEqual(mission["answer"], "SOURCE_VERSION_ONE")
        self.store.complete_schedule(doc["id"], mission["id"], self.time + timedelta(seconds=1))
        target.write_text("SOURCE_VERSION_TWO", encoding="utf-8")
        second = self.claim(61)
        self.assertNotIn("SOURCE_VERSION_ONE", json.dumps(second["request"]))
        fresh = self.manager.run_work(second["request"], model)
        self.assertEqual(fresh["answer"], "SOURCE_VERSION_TWO")
        self.assertNotEqual(mission["steps"][0]["result"]["sha256"], fresh["steps"][0]["result"]["sha256"])

    def test_pre_dispatch_missing_source_disables_without_fabricated_run_and_can_be_corrected(self):
        source = Path(self.temp.name) / "missing-source"
        doc = self.document(root=str(source))
        self.save(doc)
        claimed = self.claim()
        with self.assertRaisesRegex(ValueError, "unavailable") as error:
            self.manager.run_work(claimed["request"], lambda *_: self.fail("Missing source must fail before provider"))
        failed = self.store.record_schedule_dispatch_error(doc["id"], claimed["request"]["request_id"], str(error.exception), self.time)
        self.assertFalse(failed["enabled"])
        self.assertEqual(failed["runs_completed"], 0)
        self.assertIsNone(failed["last_mission_id"])
        self.assertIsNone(failed["active_request_id"])
        self.assertEqual(self.store.list_work(), [])
        source.mkdir()
        self.save(self.edited(failed, enabled=True), failed["revision"])
        retried = self.claim()
        self.assertNotEqual(retried["request"]["request_id"], claimed["request"]["request_id"])
        mission = self.finish_work(retried)
        finished = self.store.complete_schedule(doc["id"], mission["id"], self.time + timedelta(seconds=1))
        self.assertEqual(finished["schedule"]["last_error"], "")
        self.assertEqual(finished["schedule"]["runs_completed"], 1)

    def test_invalid_fields_authority_counters_and_credential_material_create_no_schedule(self):
        for changes in ({"interval_seconds": 59}, {"interval_seconds": 86401}, {"interval_seconds": True}, {"max_runs": 101},
                        {"runs_completed": 1}, {"active_request_id": str(uuid.uuid4())}, {"last_error": "Invented failure"},
                        {"provider": "foundry"}, {"enabled": "true"}, {"model": ""}, {"goal": "x" * 32001},
                        {"messages": [{"role": "system", "content": "cached context"}]}, {"id": "bad"},
                        {"updated_at": "2020-01-01T00:00:00Z"}, {"root": "bad\0root"},
                        {"goal": "api_key=" + "sk-" + "a" * 40}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.save(self.document(**changes))
        for authority in ({}, None, {**SCHEDULE_AUTHORITY, "issuer": "model"}, {**SCHEDULE_AUTHORITY, "actions": ["commit", "run"]}):
            with self.assertRaises(ValueError):
                self.store.save_schedule(self.document(), 0, authority)
        self.assertEqual(self.store.list_schedules(), [])

    def test_schedule_event_interruption_rolls_back_document_and_claim_identity(self):
        doc = self.document()
        with patch.object(self.store, "_schedule_append", side_effect=RuntimeError("Interrupted schedule event")):
            with self.assertRaises(RuntimeError):
                self.save(doc)
        self.assertEqual(self.store.list_schedules(), [])
        saved = self.save(doc)
        with patch.object(self.store, "_schedule_append", side_effect=RuntimeError("Interrupted claim")):
            with self.assertRaises(RuntimeError):
                self.claim()
        self.assertEqual(self.store.get_schedule(doc["id"]), saved)
        self.assertFalse(self.claim()["replayed"])

    def test_bounded_history_has_explicit_pagination_and_reserves_completion_space(self):
        doc = self.document(max_runs=1)
        saved = self.save(doc)
        for index in range(5):
            saved = self.save(self.edited(saved, name=f"Revision {index}"), saved["revision"])
        page = self.store.schedule_events(doc["id"], limit=2)
        ids = [event["id"] for event in page["events"]]
        while page["next_before_id"] is not None:
            page = self.store.schedule_events(doc["id"], limit=2, before_id=page["next_before_id"])
            ids.extend(event["id"] for event in page["events"])
        self.assertEqual(ids, list(range(6, 0, -1)))
        with patch("foundry.work_schedules.MAX_HISTORY_PAGE_BYTES", 4000):
            bounded = self.store.schedule_events(doc["id"], limit=100)
            self.assertLess(len(bounded["events"]), 6)
            self.assertIsNotNone(bounded["next_before_id"])
            self.assertLessEqual(sum(len(json.dumps(item, separators=(",", ":")).encode()) for item in bounded["events"]), 4000)
        with patch("foundry.work_schedules.MAX_HISTORY", 8):
            with self.assertRaisesRegex(ValueError, "reserved"):
                self.save(self.edited(saved, name="Cannot consume completion space"), saved["revision"])
            claimed = self.claim()
            work = self.finish_work(claimed)
            self.store.complete_schedule(doc["id"], work["id"], self.time + timedelta(seconds=1))
            self.assertEqual(self.store.verify_integrity()["schedule_events"], 8)

    def test_document_and_list_limits_reject_without_hiding_existing_schedules(self):
        saved = self.save(self.document())
        with patch("foundry.work_schedules.MAX_SCHEDULES", 1):
            with self.assertRaisesRegex(ValueError, "limited"):
                self.save(self.document())
        with patch("foundry.work_schedules.MAX_LIST_BYTES", 820000):
            with self.assertRaisesRegex(ValueError, "retrieval budget"):
                self.save(self.edited(saved, goal="Longer configuration " * 100), saved["revision"])
        self.assertEqual(self.store.list_schedules(), [saved])

    def test_backup_reopen_and_schema4_migration_preserve_other_authoritative_state(self):
        doc = self.document()
        self.save(doc)
        claim = self.claim()
        work = self.finish_work(claim)
        self.store.complete_schedule(doc["id"], work["id"], self.time + timedelta(seconds=1))
        before = self.store.verify_integrity()
        backup_root = Path(self.temp.name) / "backup"
        backup_root.mkdir()
        with closing(sqlite3.connect(self.store.path)) as source, closing(sqlite3.connect(backup_root / "foundry.sqlite3")) as destination:
            source.backup(destination)
        with CommitService(backup_root) as backup:
            self.assertEqual(backup.verify_integrity(), before)
            self.assertEqual(backup.list_schedules(), self.store.list_schedules())
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute("DROP TABLE concept_events")
            raw.execute("DROP TABLE concept_documents")
            raw.execute("DROP TABLE work_schedule_events")
            raw.execute("DROP TABLE work_schedules")
            raw.execute("DROP TABLE runtime_setup_events")
            raw.execute("DROP TABLE runtime_setups")
            raw.execute("PRAGMA user_version=4")
        self.store = CommitService(self.root)
        self.assertEqual(self.store.list_schedules(), [])
        self.assertEqual(self.store.get_work(work["id"])["answer"], work["answer"])
        self.assertEqual(self.store.verify_integrity()["work_head_hash"], before["work_head_hash"])

    def test_schedule_state_and_chain_tamper_fail_on_read_and_reopen(self):
        doc = self.document()
        self.save(doc)
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.execute("UPDATE work_schedules SET document=? WHERE id=?", (json.dumps({**doc, "goal": "Tampered goal"}), doc["id"]))
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            self.store.list_schedules()
        self.store.close()
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            CommitService(self.root)


if __name__ == "__main__":
    unittest.main()
