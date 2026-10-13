"""Lifecycle RPC through the real Work CLI entry point, plus the headless runner."""
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from foundry import work_cli
from foundry.lifecycle_runner import RunnerLock, runner_status, tick


def ok_model(*_):
    return {"content": "Headless lifecycle result", "tool_calls": []}


class LifecycleRpcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "desktop-home"
        patcher = patch.dict(os.environ, {"YUR_DESKTOP_HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def rpc(self, **request):
        return work_cli.handle(request)

    def spec(self, **changes):
        return {"name": "Nightly bid digest", "kind": "work_goal", "goal": "Write the nightly bid digest.",
                "model": "fixture", "trigger": {"kind": "continuous", "cooldown_seconds": 60}, "max_runs": 3, **changes}

    def test_empty_journal_answers_without_creating_state(self):
        self.assertEqual(self.rpc(command="lifecycle_list"), {"deployments": []})
        self.assertEqual(self.rpc(command="lifecycle_claim"), {"claims": []})
        self.assertEqual(self.rpc(command="lifecycle_runner")["runner"]["running"], False)
        times = self.rpc(command="lifecycle_preview", trigger={"kind": "cron", "expression": "0 6 * * *", "timezone": "UTC"})["times"]
        self.assertEqual(len(times), 5)
        self.assertFalse((self.home / "foundry.sqlite3").exists())

    def test_deploy_then_headless_runner_executes_and_reconciles(self):
        deployed = self.rpc(command="lifecycle_deploy", spec=self.spec())["deployment"]
        self.assertEqual(deployed["state"], "active")
        summary = tick(self.home, adapter_factory=lambda model: ok_model, log=lambda *_: None)
        self.assertEqual(summary, {"claimed": 1, "completed": 1, "dispatch_errors": 0, "busy": 0,
                                   "ship_checks": 0, "ship_debts_proposed": 0})
        current = self.rpc(command="lifecycle_list")["deployments"][0]
        self.assertEqual((current["runs_completed"], current["last_status"]), (1, "completed"))
        mission = work_cli.handle({"command": "inspect", "mission_id": current["last_mission_id"]})["mission"]
        self.assertEqual(mission["status"], "completed")
        events = self.rpc(command="lifecycle_events", deployment_id=deployed["id"], before_id=None)["events"]
        self.assertEqual([event["event_type"] for event in events], ["deployment.completed", "deployment.claimed", "deployment.created"])
        # Nothing is due during the cooldown.
        self.assertEqual(tick(self.home, adapter_factory=lambda model: ok_model, log=lambda *_: None)["claimed"], 0)

    def test_operator_controls_round_trip(self):
        deployed = self.rpc(command="lifecycle_deploy", spec=self.spec(trigger={"kind": "manual"}))["deployment"]
        paused = self.rpc(command="lifecycle_state", deployment_id=deployed["id"], expected_revision=deployed["revision"], state="paused")["deployment"]
        active = self.rpc(command="lifecycle_state", deployment_id=deployed["id"], expected_revision=paused["revision"], state="active")["deployment"]
        due = self.rpc(command="lifecycle_run_now", deployment_id=deployed["id"], expected_revision=active["revision"])["deployment"]
        self.assertEqual(due["next_run_at"], due["updated_at"])
        edited = self.rpc(command="lifecycle_update", deployment_id=deployed["id"], expected_revision=due["revision"],
                          changes={"name": "Renamed"})["deployment"]
        self.assertEqual(edited["name"], "Renamed")
        with self.assertRaises(ValueError):
            self.rpc(command="lifecycle_state", deployment_id=deployed["id"], expected_revision=edited["revision"], state="finished")

    def test_rpc_validation(self):
        for bad in ({"command": "lifecycle_list", "extra": 1}, {"command": "lifecycle_state", "deployment_id": "x", "expected_revision": 1, "state": "paused"},
                    {"command": "lifecycle_preview", "trigger": {"kind": "interval", "seconds": 1}},
                    {"command": "lifecycle_complete", "deployment_id": "00000000-0000-4000-8000-000000000000", "mission_id": "nope"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                work_cli.validate_rpc(bad)

    def test_runner_lock_is_exclusive_and_reported(self):
        self.home.mkdir(parents=True)
        lock = RunnerLock(self.home)
        self.assertTrue(lock.acquire())
        try:
            self.assertFalse(RunnerLock(self.home).acquire())
            self.assertTrue(runner_status(self.home)["running"])
        finally:
            lock.release()
        self.assertFalse(runner_status(self.home)["running"])


if __name__ == "__main__":
    unittest.main()
