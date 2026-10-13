import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from foundry.commit_service import CommitService
from foundry.factory_cli import decode_request
from foundry.orchestration import OrchestrationManager, local_authority

ROOT = Path(__file__).resolve().parents[1]
SPEC = {"name": "Operations Specialist", "description": "Analyze operator-provided business text and tables",
        "capabilities": ["text.analyze", "data.profile", "support.triage"]}


class FactoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = CommitService(Path(self.temp.name) / "state")
        self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)

    def submit(self, key="mission-test"):
        return self.manager.submit(SPEC, key, local_authority())

    def test_full_mission_pack_execution_and_export(self):
        mission = self.submit()
        self.assertEqual(mission["id"], self.submit()["id"])
        result = self.manager.process(1)
        self.assertEqual(result["processed"], [mission["id"]])
        detail = self.manager.inspect(mission["id"])
        self.assertEqual(detail["status"], "completed")
        self.assertEqual(len(detail["candidates"]), 2)
        self.assertTrue(all(c["passed"] for c in detail["candidates"]))
        self.assertEqual(len({c["digest"] for c in detail["candidates"]}), 2)
        output = self.manager.run(mission["id"], "data.profile", {"rows": [{"name": "A"}, {"name": "A"}, {}]})
        self.assertEqual(output["output"]["row_count"], 3)
        self.assertEqual(output["output"]["duplicate_rows"], 1)
        export = self.store.export_artifact(mission["id"])
        unpack = Path(self.temp.name) / "unpacked"
        with zipfile.ZipFile(export["path"]) as bundle:
            bundle.extractall(unpack)
        completed = subprocess.run([sys.executable, "-B", "agent.py"], cwd=unpack,
                                   input=json.dumps({"capability": "text.analyze", "input": {"text": "Verified real pack output."}}),
                                   text=True, capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["result"]["word_count"], 4)
        self.assertEqual(self.manager.process()["processed"], [])
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_unknown_capability_never_creates_mission(self):
        with self.assertRaises((KeyError, ValueError)):
            self.manager.submit({**SPEC, "capabilities": ["shell.execute"]}, "bad", local_authority())
        self.assertEqual(self.store.list_missions(), [])

    def test_failed_validation_cannot_publish(self):
        mission = self.submit()
        with patch("foundry.orchestration.validate_pack", return_value={"passed": False, "errors": ["failed outcome"]}):
            self.manager.process()
        self.assertEqual(self.store.get_mission(mission["id"])["status"], "failed")
        self.assertIsNone(self.store.get_artifact(mission["id"]))

    def test_cancelled_and_out_of_scope_execution(self):
        mission = self.submit()
        self.manager.cancel(mission["id"])
        self.assertEqual(self.manager.process()["processed"], [])
        with self.assertRaises(ValueError):
            self.manager.run(mission["id"], "text.analyze", {"text": "No"})
        mission2 = self.manager.submit({**SPEC, "capabilities": ["text.analyze"]}, "limited", local_authority())
        self.manager.process()
        with self.assertRaises(PermissionError):
            self.manager.run(mission2["id"], "data.profile", {"rows": []})

    def test_recover_interrupted_execution_and_bound_attempts(self):
        mission = self.submit()
        self.store.transition(mission["id"], "queued", "running")
        result = self.manager.process()
        self.assertEqual(result["recovered"], [mission["id"]])
        self.assertEqual(self.store.get_mission(mission["id"])["status"], "completed")
        another = self.submit("exhaust")
        for _ in range(3):
            self.store.transition(another["id"], "queued", "running")
            if _ < 2:
                with self.store.acquire_worker():
                    self.store.transition(another["id"], "running", "queued")
        self.manager.process()
        self.assertEqual(self.store.get_mission(another["id"])["status"], "failed")

    def test_process_limit_and_single_owner(self):
        one, two = self.submit("one"), self.submit("two")
        with self.store.acquire_worker():
            with self.assertRaises(RuntimeError):
                self.manager.process()
        self.assertEqual(len(self.manager.process(1)["processed"]), 1)
        self.assertEqual(self.manager.process(1)["remaining"], 0)
        self.assertEqual({m["id"] for m in self.store.list_missions()}, {one["id"], two["id"]})
        for value in (True, 0, -1, 26, 1.5):
            with self.assertRaises(ValueError):
                self.manager.process(value)

    def test_watch_is_bounded_and_stoppable(self):
        self.submit()
        events = []
        result = self.manager.watch(1, 1, on_cycle=events.append)
        self.assertEqual(result["cycles"], 1)
        self.assertEqual(len(events), 1)
        self.assertEqual(self.manager.watch(3, 1, stop_requested=lambda: True)["cycles"], 0)

    def test_watch_picks_up_new_missions_on_later_cycles(self):
        first = self.submit("cycle-first")
        seen = []

        def on_cycle(result):
            seen.extend(result["processed"])
            if result["cycle"] == 1:
                self.submit("cycle-second")

        result = self.manager.watch(2, 1, on_cycle=on_cycle)
        self.assertEqual(result["cycles"], 2)
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0], first["id"])
        self.assertTrue(all(m["status"] == "completed" for m in self.store.list_missions()))

    def test_rpc_strictness_and_real_cli_roundtrip(self):
        for raw in (b'[]', b'{"command":"health","command":"run"}', b'{"command":"submit","spec":NaN}',
                    b'{"command":"health","authority":{}}', b'{"command":"arbitrary"}', b'x' * 131073):
            with self.assertRaises(ValueError):
                decode_request(raw)
        proc = subprocess.run([sys.executable, "-B", "-m", "foundry.factory_cli", "--home", str(Path(self.temp.name) / "rpc"), "rpc"],
                              cwd=ROOT, input='{"command":"health"}', text=True, capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        self.assertTrue(json.loads(proc.stdout)["ok"])

    def test_payloads_are_hashed_in_execution_provenance(self):
        mission = self.submit()
        self.manager.process()
        self.manager.run(mission["id"], "text.analyze", {"text": "private-example-never-persisted"})
        events = json.dumps(self.store.events(mission["id"]))
        self.assertNotIn("private-example-never-persisted", events)
        self.assertIn("input_hash", events)


if __name__ == "__main__":
    unittest.main()
