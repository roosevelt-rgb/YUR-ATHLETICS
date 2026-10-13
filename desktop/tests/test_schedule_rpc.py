"""Real stdin/stdout schedule ingress and shared Work journal acceptance."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_engine import AUTHORITY

SOURCE_ROOT = Path(__file__).resolve().parents[1]


class ScheduleRpcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "journal"

    def document(self, **changes):
        stamp = datetime.now(timezone.utc).isoformat()
        return {"id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "name": "RPC recurring review",
                "goal": "Inspect freshly selected facts", "root": None, "provider": "ollama", "model": "local-fixture",
                "mode": "work", "interval_seconds": 60, "max_runs": 2, "enabled": True, "created_at": stamp,
                "updated_at": stamp, "next_run_at": stamp, "runs_completed": 0, "active_request_id": None,
                "last_mission_id": None, "last_error": "", **changes}

    def rpc(self, payload):
        environment = {**os.environ, "YUR_DESKTOP_HOME": str(self.state), "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1"}
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        raw = payload if isinstance(payload, str) else json.dumps(payload)
        process = subprocess.run([sys.executable, "-B", "-m", "foundry.work_cli"], cwd=SOURCE_ROOT, env=environment,
                                 input=raw.encode(), capture_output=True, timeout=15)
        self.assertEqual(process.stderr, b"")
        records = [json.loads(line) for line in process.stdout.decode().splitlines()]
        self.assertEqual(len(records), 1, "Schedule control cannot execute providers or emit worker tool events")
        self.assertEqual(records[0]["type"], "result")
        return process.returncode, records[0]

    def success(self, payload):
        code, response = self.rpc(payload)
        self.assertEqual(code, 0, response)
        self.assertTrue(response["ok"])
        return response["result"]

    def save(self, document, revision=0):
        return self.success({"command": "schedule_save", "document": document, "expected_revision": revision})["schedule"]

    @staticmethod
    def edit(saved, **changes):
        return {key: changes.get(key, value) for key, value in saved.items() if key != "revision"}

    def test_empty_list_and_claim_are_read_only(self):
        self.assertEqual(self.success({"command": "schedule_list"}), {"schedules": []})
        self.assertEqual(self.success({"command": "schedule_claim"}), {"claims": []})
        self.assertFalse(self.state.exists())

    def test_strict_fields_reject_renderer_clock_authority_and_runtime_forgery(self):
        doc = self.document()
        invalid = [
            {"command": "schedule_claim", "now": "2099-01-01T00:00:00Z"},
            {"command": "schedule_claim", "limit": 100},
            {"command": "schedule_list", "root": "other"},
            {"command": "schedule_save", "document": doc, "expected_revision": 0, "authority": {}},
            {"command": "schedule_save", "document": {**doc, "active_request_id": str(uuid.uuid4())}, "expected_revision": 0},
            {"command": "schedule_save", "document": {**doc, "messages": []}, "expected_revision": 0},
            {"command": "schedule_save", "document": doc, "expected_revision": True},
            {"command": "schedule_save", "document": doc, "expected_revision": 2**53},
            {"command": "schedule_events", "schedule_id": doc["id"], "before_id": False},
            {"command": "schedule_resolve", "request_id": "bad"},
            {"command": "schedule_complete", "schedule_id": doc["id"], "mission_id": "../escape"},
            {"command": "schedule_complete", "schedule_id": doc["id"], "mission_id": "a" * 32, "now": "2099"},
            {"command": "schedule_dispatch_error", "schedule_id": doc["id"], "request_id": str(uuid.uuid4()), "error": ""},
            '{"command":"schedule_list","command":"schedule_claim"}',
            '{"command":"schedule_save","document":NaN,"expected_revision":0}',
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                code, response = self.rpc(payload)
                self.assertEqual(code, 1)
                self.assertEqual(response["error"]["code"], "INVALID_REQUEST")
        if self.state.exists():
            with CommitService(self.state) as store:
                self.assertEqual(store.list_schedules(), [])
                self.assertEqual(store.list_work(), [])

    def test_save_claim_resolve_complete_and_history_use_actual_shared_state(self):
        doc = self.document()
        saved = self.save(doc)
        self.assertEqual(saved, {**doc, "revision": 1})
        claim = self.success({"command": "schedule_claim"})["claims"][0]
        replay = self.success({"command": "schedule_claim"})["claims"][0]
        self.assertEqual(claim["request"], replay["request"])
        self.assertEqual(claim["request"]["messages"], [{"role": "user", "content": doc["goal"]}])
        self.assertFalse(claim["replayed"])
        self.assertTrue(replay["replayed"])
        self.assertIsNone(self.success({"command": "schedule_resolve", "request_id": claim["request"]["request_id"]})["mission"])
        with CommitService(self.state) as store:
            manager = OrchestrationManager(store)
            mission = manager.run_work(claim["request"], lambda *_: {"content": "Actual scheduled output"})
            self.assertEqual(store.list_conversations(), [])
        resolved = self.success({"command": "schedule_resolve", "request_id": claim["request"]["request_id"]})["mission"]
        self.assertEqual(resolved["id"], mission["id"])
        result = self.success({"command": "schedule_complete", "schedule_id": doc["id"], "mission_id": mission["id"]})
        self.assertEqual(result["schedule"]["runs_completed"], 1)
        self.assertEqual(result["mission_status"], "completed")
        self.assertFalse(result["replayed"])
        again = self.success({"command": "schedule_complete", "schedule_id": doc["id"], "mission_id": mission["id"]})
        self.assertTrue(again["replayed"])
        history = self.success({"command": "schedule_events", "schedule_id": doc["id"], "before_id": None})
        self.assertEqual([item["event_type"] for item in history["events"]], ["schedule.completed", "schedule.claimed", "schedule.created"])
        self.assertTrue(all("data" not in item and "document" not in item for item in history["events"]))
        self.assertEqual(history["events"][-1]["change"]["authority"], {"issuer": "local-user", "scope": "work-schedules", "actions": ["commit"]})
        self.assertEqual(history["events"][0]["change"]["mission_id"], mission["id"])
        self.assertEqual(len(history["events"][0]["hash"]), 64)

    def test_only_paused_exact_active_request_cancels_even_after_source_disappears(self):
        source = Path(self.temp.name) / "source"
        source.mkdir()
        doc = self.document(root=str(source))
        self.save(doc)
        claim = self.success({"command": "schedule_claim"})["claims"][0]
        payload = {"command": "schedule_cancel_request", "schedule_id": doc["id"], "request_id": claim["request"]["request_id"]}
        code, response = self.rpc(payload)
        self.assertEqual(code, 1)
        self.assertIn("Pause", response["error"]["message"])
        with CommitService(self.state) as store:
            accepted = store.submit_work(claim["request"], AUTHORITY)
        source.rmdir()  # Empty test-owned source; existing cancellation must not reacquire it.
        self.save(self.edit(claim["schedule"], enabled=False), claim["schedule"]["revision"])
        code, response = self.rpc({**payload, "request_id": str(uuid.uuid4())})
        self.assertEqual(code, 1)
        cancelled = self.success(payload)["mission"]
        self.assertEqual(cancelled["id"], accepted["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        final = self.success({"command": "schedule_complete", "schedule_id": doc["id"], "mission_id": cancelled["id"]})
        self.assertFalse(final["schedule"]["enabled"])
        self.assertEqual(final["schedule"]["runs_completed"], 1)

    def test_dispatch_error_is_exact_unaccepted_request_and_not_a_completed_run(self):
        doc = self.document(root=str(Path(self.temp.name) / "unavailable"))
        self.save(doc)
        claim = self.success({"command": "schedule_claim"})["claims"][0]
        payload = {"command": "schedule_dispatch_error", "schedule_id": doc["id"], "request_id": claim["request"]["request_id"], "error": "Selected source is unavailable"}
        code, _ = self.rpc({**payload, "request_id": str(uuid.uuid4())})
        self.assertEqual(code, 1)
        failed = self.success(payload)["schedule"]
        self.assertEqual(failed["runs_completed"], 0)
        self.assertIsNone(failed["last_mission_id"])
        self.assertIsNone(failed["active_request_id"])
        self.assertFalse(failed["enabled"])
        with CommitService(self.state) as store:
            self.assertEqual(store.list_work(), [])

    def test_stale_save_and_wrong_completion_identity_preserve_runtime(self):
        doc = self.document()
        self.save(doc)
        claim = self.success({"command": "schedule_claim"})["claims"][0]
        code, response = self.rpc({"command": "schedule_save", "document": {**doc, "name": "Stale edit"}, "expected_revision": 1})
        self.assertEqual(code, 1)
        self.assertIn("reload", response["error"]["message"].lower())
        with CommitService(self.state) as store:
            unrelated = OrchestrationManager(store).run_work({**claim["request"], "request_id": str(uuid.uuid4())}, lambda *_: {"content": "Unrelated completion"})
        code, response = self.rpc({"command": "schedule_complete", "schedule_id": doc["id"], "mission_id": unrelated["id"]})
        self.assertEqual(code, 1)
        self.assertIn("does not match", response["error"]["message"])
        saved = self.success({"command": "schedule_list"})["schedules"][0]
        self.assertEqual(saved["active_request_id"], claim["request"]["request_id"])
        self.assertEqual(saved["runs_completed"], 0)


if __name__ == "__main__":
    unittest.main()
