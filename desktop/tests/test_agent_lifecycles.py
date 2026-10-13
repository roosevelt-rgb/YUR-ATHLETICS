"""Deployed agent lifecycles through the real local Work authority."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import tempfile
import unittest

from foundry.agent_lifecycles import LIFECYCLE_AUTHORITY, LifecycleConflictError, derived_request
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager

AUTH = LIFECYCLE_AUTHORITY


def ok_model(*_):
    return {"content": "Lifecycle run result", "tool_calls": []}


def broken_model(*_):
    raise RuntimeError("model endpoint unavailable")


class AgentLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "journal"
        self.store = CommitService(self.root)
        self.addCleanup(lambda: self.store.close())
        self.manager = OrchestrationManager(self.store)
        self.time = datetime.now(timezone.utc).replace(microsecond=0)

    def spec(self, **changes):
        return {"name": "Bid evidence watcher", "kind": "work_goal", "goal": "Summarize new bid evidence.",
                "model": "fixture", "trigger": {"kind": "interval", "seconds": 60}, "max_runs": 5, **changes}

    def deploy(self, **changes):
        return self.store.create_deployment(self.spec(**changes), AUTH, now=self.time)

    def claim(self, offset):
        claims = self.store.claim_due_deployments(self.time + timedelta(seconds=offset))
        self.assertEqual(len(claims), 1)
        return claims[0]

    def execute(self, claim, model=ok_model, offset=0):
        try:
            mission = self.manager.run_work(claim["request"], model)
        except RuntimeError:
            # Work commits its actual failed state before re-raising.
            mission = self.store.get_work_by_request(claim["request"]["request_id"])
        return self.store.complete_deployment_run(claim["deployment"]["id"], mission["id"],
                                                  now=self.time + timedelta(seconds=offset))

    def test_interval_deployment_runs_reconciles_and_verifies(self):
        deployed = self.deploy()
        self.assertEqual(deployed["state"], "active")
        self.assertEqual(self.store.claim_due_deployments(self.time + timedelta(seconds=59)), [])
        claim = self.claim(60)
        self.assertEqual(claim["request"], derived_request(claim["deployment"]))
        result = self.execute(claim, offset=61)
        done = result["deployment"]
        self.assertEqual((done["runs_completed"], done["last_status"], done["failures_in_row"]), (1, "completed", 0))
        self.assertIsNone(done["active_request_id"])
        self.assertEqual(done["next_run_at"], (self.time + timedelta(seconds=121)).isoformat())
        integrity = self.store.verify_integrity()
        self.assertEqual(integrity["deployments"], 1)
        self.assertEqual(integrity["deployment_events"], 3)
        # Completing the same mission again is a read-only replay.
        again = self.store.complete_deployment_run(done["id"], done["last_mission_id"])
        self.assertTrue(again["replayed"])

    def test_instructions_travel_as_system_context(self):
        deployed = self.deploy(kind="marketplace_pack", instructions="You are the BID ZONE estimator.",
                               source={"pack_id": "pack_abc123", "engine": "intelliflow-harness", "agent_type": "estimator"},
                               trigger={"kind": "continuous", "cooldown_seconds": 30})
        claim = self.claim(0)
        self.assertEqual(claim["request"]["messages"][0], {"role": "system", "content": "You are the BID ZONE estimator."})
        self.assertEqual(claim["request"]["messages"][1]["content"], deployed["goal"])
        done = self.execute(claim, offset=5)["deployment"]
        self.assertEqual(done["next_run_at"], (self.time + timedelta(seconds=35)).isoformat())

    def test_marketplace_revision_digest_is_retained_and_malformed_digests_rejected(self):
        source = {"pack_id": "pack_reviewed", "engine": "intelliflow-harness", "content_sha256": "a" * 64}
        deployed = self.deploy(kind="marketplace_pack", source=source)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.store.list_deployments()[0]["source"], source)
        for digest in ("", "A" * 64, "z" * 64, "a" * 63, None):
            with self.subTest(digest=digest), self.assertRaisesRegex(ValueError, "source revision"):
                self.deploy(kind="marketplace_pack", source={**source, "content_sha256": digest})
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_claim_survives_restart_and_replays_same_request(self):
        self.deploy(trigger={"kind": "continuous", "cooldown_seconds": 30})
        first = self.claim(0)
        self.store.close()
        self.store = CommitService(self.root)
        self.manager = OrchestrationManager(self.store)
        replay = self.claim(300)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["request"], first["request"])

    def test_failure_streak_auto_pauses(self):
        self.deploy(max_failures_in_row=2, trigger={"kind": "continuous", "cooldown_seconds": 30})
        first = self.execute(self.claim(0), broken_model, offset=1)["deployment"]
        self.assertEqual((first["state"], first["failures_in_row"], first["last_status"]), ("active", 1, "failed"))
        second = self.execute(self.claim(40), broken_model, offset=41)["deployment"]
        self.assertEqual(second["state"], "paused")
        self.assertIn("Auto-paused after 2", second["last_error"])
        self.assertIsNone(second["next_run_at"])
        self.assertEqual(self.store.claim_due_deployments(self.time + timedelta(days=1)), [])
        resumed = self.store.set_deployment_state(second["id"], second["revision"], "active", AUTH,
                                                  now=self.time + timedelta(seconds=50))
        self.assertEqual((resumed["state"], resumed["failures_in_row"]), ("active", 0))
        self.store.verify_integrity()

    def test_budget_finishes_and_once_finishes(self):
        finished = self.deploy(max_runs=1, trigger={"kind": "continuous", "cooldown_seconds": 30})
        result = self.execute(self.claim(0), offset=1)["deployment"]
        self.assertEqual((result["state"], result["next_run_at"]), ("finished", None))
        once = self.store.create_deployment(self.spec(name="One shot", trigger={"kind": "once", "at": self.time.isoformat()}),
                                            AUTH, now=self.time)
        claims = self.store.claim_due_deployments(self.time + timedelta(seconds=2))
        self.assertEqual([item["deployment"]["id"] for item in claims], [once["id"]])
        mission = self.manager.run_work(claims[0]["request"], ok_model)
        once_done = self.store.complete_deployment_run(once["id"], mission["id"], now=self.time + timedelta(seconds=3))
        self.assertEqual(once_done["deployment"]["state"], "finished")
        with self.assertRaises(ValueError):
            self.store.set_deployment_state(finished["id"], result["revision"], "active", AUTH)

    def test_manual_run_now_pause_retire_and_renew(self):
        manual = self.deploy(trigger={"kind": "manual"})
        self.assertIsNone(manual["next_run_at"])
        self.assertEqual(self.store.claim_due_deployments(self.time + timedelta(days=30)), [])
        requested = self.store.request_deployment_run(manual["id"], manual["revision"], AUTH, now=self.time + timedelta(seconds=5))
        claim = self.claim(6)
        self.assertEqual(claim["deployment"]["id"], manual["id"])
        with self.assertRaises(ValueError):  # in flight
            self.store.request_deployment_run(manual["id"], claim["deployment"]["revision"], AUTH)
        with self.assertRaises(ValueError):  # retire requires reconciliation
            self.store.set_deployment_state(manual["id"], claim["deployment"]["revision"], "retired", AUTH)
        done = self.execute(claim, offset=7)["deployment"]
        self.assertIsNone(done["next_run_at"])
        retired = self.store.set_deployment_state(done["id"], done["revision"], "retired", AUTH, now=self.time + timedelta(seconds=8))
        with self.assertRaises(ValueError):
            self.store.set_deployment_state(retired["id"], retired["revision"], "active", AUTH)
        renewed = self.store.create_deployment(self.spec(previous_deployment_id=retired["id"]), AUTH, now=self.time + timedelta(seconds=9))
        self.assertEqual(renewed["previous_deployment_id"], retired["id"])
        self.assertEqual(requested["revision"], 2)
        self.store.verify_integrity()

    def test_edit_rules_and_optimistic_concurrency(self):
        deployed = self.deploy()
        edited = self.store.update_deployment(deployed["id"], deployed["revision"],
                                              {"trigger": {"kind": "cron", "expression": "0 * * * *", "timezone": "UTC"},
                                               "goal": "Updated goal"}, AUTH, now=self.time + timedelta(seconds=1))
        self.assertEqual(edited["goal"], "Updated goal")
        self.assertTrue(edited["next_run_at"].endswith(":00:00+00:00"))
        with self.assertRaises(LifecycleConflictError):
            self.store.update_deployment(deployed["id"], deployed["revision"], {"goal": "stale"}, AUTH)
        for bad in ({"state": "retired"}, {"runs_completed": 9}, {"source": {}}, {}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.store.update_deployment(deployed["id"], edited["revision"], bad, AUTH)
        with self.assertRaises(ValueError):
            self.store.update_deployment(deployed["id"], edited["revision"], {"goal": "x"}, {"issuer": "model"})

    def test_spec_validation(self):
        for bad in ({"kind": "saved_specialist", "source": {}},
                    {"kind": "marketplace_pack", "source": {"pack_id": "p1", "engine": "random-web"}},
                    {"goal": "api_key=sk-ant-REDACTEDREDACTEDREDACTED"},
                    {"trigger": {"kind": "interval", "seconds": 5}},
                    {"max_runs": 0}, {"mode": "chat"}, {"state": "finished"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.store.create_deployment(self.spec(**bad), AUTH, now=self.time)

    def test_tampering_is_detected(self):
        self.deploy()
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("UPDATE agent_deployments SET document=replace(document,'Summarize','Exfiltrate')")
        with self.assertRaises(RuntimeError):
            CommitService(self.root)


if __name__ == "__main__":
    unittest.main()
