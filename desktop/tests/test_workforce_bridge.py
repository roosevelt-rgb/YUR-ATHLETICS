"""Real journal/OM replay acceptance; source acquisition has its separate tests."""
import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager, canonical, local_authority
from foundry import workforce_bridge


CAPABILITY = "workforce.hatch.quantity"
PINNED_SOURCE = {
    "profile": {"code": "hatch_quantity", "name": "HATCH Quantity (Survey)",
                "lineage": "yur.genesis.hatch.quantity", "version": "0.1.0",
                "relative_path": "agents/hatch_quantity.py",
                "sha256": "da68288a6d51def386e6cd909e46fa3b3a72c331cdddda05fb666a2e9de10477"},
    "provenance": {"operation": "workforce.profile.acquired", "mode": "read-only",
                   "relative_path": "agents/hatch_quantity.py",
                   "sha256": "da68288a6d51def386e6cd909e46fa3b3a72c331cdddda05fb666a2e9de10477",
                   "authority_promoted": False},
    "content": "Acquisition fixture only: production source parsing is covered by test_workforce_catalog.py.",
}
PAYLOAD = {"plans_text": "Division 03\nConcrete 25 CY", "specs_text": "09 51 00\nBoard 320 SF"}
SPEC = {"name": "Unrelated quantity worker", "description": "Independent mission fixture", "capabilities": [CAPABILITY]}


class WorkforceBridgeReplayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = CommitService(Path(self.directory.name) / "state")
        self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        # The pinned original source identity is literal fixture data. This suite
        # never imports, copies, or reads the external workforce installation.
        self.acquisition = patch("foundry.workforce_bridge.acquire", side_effect=lambda _request: copy.deepcopy(PINNED_SOURCE))
        self.acquisition.start()
        self.addCleanup(self.acquisition.stop)

    def request(self, *, request_id=None, payload=None):
        return {"root": str(Path(self.directory.name) / "source-not-executed"),
                "code": "hatch_quantity", "expected_sha256": PINNED_SOURCE["profile"]["sha256"],
                "request_id": request_id or str(uuid.uuid4()), "input": copy.deepcopy(payload or PAYLOAD)}

    def events(self, mission_id, event_type):
        return [event for event in self.store.events(mission_id) if event["event_type"] == event_type]

    def interrupted_build(self, request):
        with patch.object(self.manager, "process", side_effect=RuntimeError("interrupted before build")):
            with self.assertRaisesRegex(RuntimeError, "interrupted before build"):
                workforce_bridge.run(request, self.manager)
        missions = self.store.list_missions()
        candidates = [mission for mission in missions if any(
            event["event_type"] == "workforce.request.accepted" and event["data"]["request_id"] == request["request_id"]
            for event in self.store.events(mission["id"]))]
        self.assertEqual(len(candidates), 1, "The request must bind its input before its worker starts")
        return candidates[0]

    def test_same_request_replays_original_result_across_runtime_digest_change(self):
        request = self.request()
        original = workforce_bridge.run(request, self.manager)
        with patch("foundry.workforce_bridge._trusted_runtime_source", return_value="a different installed runtime source"), \
                patch.object(self.manager, "run", side_effect=AssertionError("A completed request cannot execute again")):
            replayed = workforce_bridge.run(copy.deepcopy(request), self.manager)
        self.assertEqual(replayed, original)
        self.assertEqual(len(self.store.list_missions()), 1)
        self.assertEqual(len(self.events(original["mission_id"], "execution.started")), 1)
        self.assertEqual(len(self.events(original["mission_id"], "execution.completed")), 1)
        self.assertEqual(len(self.events(original["mission_id"], "workforce.result.committed")), 1)
        self.assertEqual(workforce_bridge.result({"mission_id": original["mission_id"], "run_id": original["run_id"]}, self.manager), original)
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_changed_input_rejected_after_initial_build_interruption(self):
        request = self.request()
        mission = self.interrupted_build(request)
        accepted = self.events(mission["id"], "workforce.request.accepted")
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["data"]["input_hash"], hashlib.sha256(canonical(PAYLOAD)).hexdigest())
        self.assertEqual(accepted[0]["data"]["profile"], PINNED_SOURCE["profile"])
        self.assertEqual(accepted[0]["data"]["source_provenance"], PINNED_SOURCE["provenance"])
        changed = copy.deepcopy(request)
        changed["input"]["plans_text"] = "Division 03\nConcrete 99 CY"
        with patch.object(self.manager, "process") as process, patch.object(self.manager, "run") as execute:
            with self.assertRaisesRegex(ValueError, "different.*input|input.*different"):
                workforce_bridge.run(changed, self.manager)
            process.assert_not_called()
            execute.assert_not_called()
        self.assertEqual(self.store.get_mission(mission["id"])["status"], "queued")
        self.assertEqual(self.events(mission["id"], "execution.started"), [])
        recovered = workforce_bridge.run(request, self.manager)
        self.assertEqual(recovered["mission_id"], mission["id"])
        self.assertEqual(recovered["output"]["by_division"]["Division 03"]["CY"], 25.0)

    def test_result_commit_interruption_recovers_retained_output_without_rerun(self):
        request = self.request()
        actual_record = self.store.record_event

        def interrupt_result(mission_id, event_type, data):
            if event_type == "workforce.result.committed":
                raise RuntimeError("interrupted after completed execution")
            return actual_record(mission_id, event_type, data)

        with patch.object(self.store, "record_event", side_effect=interrupt_result):
            with self.assertRaisesRegex(RuntimeError, "interrupted after completed execution"):
                workforce_bridge.run(request, self.manager)
        mission = self.store.list_missions()[0]
        completed = self.events(mission["id"], "execution.completed")
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]["data"]["output"]["area_total_sf"], 320.0)
        self.assertEqual(self.events(mission["id"], "workforce.result.committed"), [])
        with patch.object(self.manager, "run", side_effect=AssertionError("Committed execution must not run twice")):
            recovered = workforce_bridge.run(request, self.manager)
        self.assertEqual(recovered["run_id"], completed[0]["data"]["run_id"])
        self.assertEqual(recovered["output"], completed[0]["data"]["output"])
        self.assertEqual(len(self.events(mission["id"], "execution.started")), 1)
        self.assertEqual(len(self.events(mission["id"], "execution.completed")), 1)
        self.assertEqual(len(self.events(mission["id"], "workforce.result.committed")), 1)
        self.assertEqual(workforce_bridge.run(request, self.manager), recovered)
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_new_request_after_cancelled_or_failed_request_leaves_unrelated_work_untouched(self):
        queued = self.manager.submit(SPEC, "unrelated-queued", local_authority())
        running = self.manager.submit({**SPEC, "name": "Unrelated active worker"}, "unrelated-running", local_authority())
        self.store.transition(running["id"], "queued", "running", {"fixture": "unrelated active mission"})
        original_queued = self.store.get_mission(queued["id"])
        original_running = self.store.get_mission(running["id"])
        queued_events = self.store.events(queued["id"])
        running_events = self.store.events(running["id"])
        for final_status in ("cancelled", "failed"):
            with self.subTest(final_status=final_status):
                previous_request = self.request()
                previous = self.interrupted_build(previous_request)
                if final_status == "cancelled":
                    self.manager.cancel(previous["id"])
                else:
                    self.store.transition(previous["id"], "queued", "running")
                    self.store.transition(previous["id"], "running", "failed", {"error": "fixture failure"})
                fresh = workforce_bridge.run(self.request(), self.manager)
                self.assertNotEqual(fresh["mission_id"], previous["id"])
                self.assertEqual(self.store.get_mission(fresh["mission_id"])["status"], "completed")
                self.assertEqual(self.store.get_mission(previous["id"])["status"], final_status)
                self.assertEqual(self.store.get_mission(queued["id"]), original_queued)
                self.assertEqual(self.store.get_mission(running["id"]), original_running)
                self.assertEqual(self.store.events(queued["id"]), queued_events)
                self.assertEqual(self.store.events(running["id"]), running_events)
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_output_retention_is_opt_in_for_other_mission_consumers(self):
        mission = self.manager.submit({"name": "Text worker", "description": "Default execution event contract", "capabilities": ["text.analyze"]},
                                      "text-default-retention", local_authority())
        self.manager.process(1, mission_id=mission["id"])
        self.manager.run(mission["id"], "text.analyze", {"text": "One source statement."})
        first = self.events(mission["id"], "execution.completed")[0]
        self.assertNotIn("output", first["data"])
        retained = self.manager.run(mission["id"], "text.analyze", {"text": "A retained result."}, retain_output=True)
        second = self.events(mission["id"], "execution.completed")[1]
        self.assertEqual(second["data"]["output"], retained["output"])
        self.assertEqual(second["data"]["output_hash"], hashlib.sha256(canonical(retained["output"])).hexdigest())


if __name__ == "__main__":
    unittest.main()
