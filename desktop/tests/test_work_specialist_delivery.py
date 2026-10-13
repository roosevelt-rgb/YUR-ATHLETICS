"""Actual parent-bound specialist inspection, immutable ZIP export and reveal."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
import zipfile

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager, local_authority

SOURCE_ROOT = Path(__file__).resolve().parents[1]
SPEC = {"name": "Delivery fixture specialist", "description": "Bounded executable text review", "capabilities": ["text.analyze"]}


class WorkSpecialistDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "journal"
        self.store = CommitService(self.state)
        self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        self.parent = self.build()
        self.child_id = self.parent["steps"][0]["result"]["mission_id"]

    def build(self, spec=SPEC):
        request = {"request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "mode": "work",
                   "goal": "Build an executable specialist", "root": None, "provider": "ollama", "model": "fixture",
                   "messages": [{"role": "user", "content": "Build an executable specialist"}]}
        responses = iter([{"content": "", "tool_calls": [{"function": {"name": "build_specialist", "arguments": spec}}]},
                          {"content": "Specialist committed."}])
        mission = self.manager.run_work(request, lambda *_: next(responses))
        self.assertTrue(mission["steps"][0]["succeeded"])
        return mission

    def rpc(self, command, **changes):
        payload = {"command": command, "mission_id": self.parent["id"], "specialist_id": self.child_id, **changes}
        environment = {**os.environ, "YUR_DESKTOP_HOME": str(self.state), "PYTHONNOUSERSITE": "1", "PYTHONIOENCODING": "utf-8"}
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        process = subprocess.run([sys.executable, "-B", "-m", "foundry.work_cli"], cwd=SOURCE_ROOT, env=environment,
                                 input=json.dumps(payload).encode(), capture_output=True, timeout=15)
        self.assertEqual(process.stderr, b"")
        records = [json.loads(line) for line in process.stdout.decode().splitlines()]
        self.assertEqual(len(records), 1)
        return process.returncode, records[0]

    def success(self, command, **changes):
        code, response = self.rpc(command, **changes)
        self.assertEqual(code, 0, response)
        self.assertTrue(response["ok"])
        return response["result"]

    def test_inspect_returns_real_validation_provenance_without_package_source(self):
        result = self.success("inspect_specialist")
        specialist = result["specialist"]
        self.assertEqual(result["parent_work_id"], self.parent["id"])
        self.assertEqual(specialist["id"], self.child_id)
        self.assertEqual(specialist["status"], "completed")
        self.assertEqual(len(specialist["candidates"]), 2)
        self.assertTrue(specialist["artifact"]["validation"]["passed"])
        self.assertNotIn("files", specialist["artifact"])
        artifact = self.store.get_artifact(self.child_id)
        encoded = json.dumps(result)
        self.assertNotIn(artifact["files"]["agent.py"], encoded)
        self.assertNotIn(artifact["files"]["runtime.py"], encoded)
        self.assertFalse((self.state / "exports").exists())

    def test_explicit_export_is_deterministic_confined_and_contains_exact_committed_files(self):
        first = self.success("export_specialist")["export"]
        destination = Path(first["path"])
        self.assertTrue(destination.is_relative_to(self.state / "exports"))
        self.assertEqual(destination.name, self.store.get_artifact(self.child_id)["digest"] + ".zip")
        original = destination.read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), first["zip_digest"])
        self.assertEqual(len(original), first["bytes"])
        second = self.success("export_specialist")["export"]
        self.assertEqual(second, first)
        self.assertEqual(destination.read_bytes(), original)
        files = self.store.get_artifact(self.child_id)["files"]
        with zipfile.ZipFile(destination) as package:
            self.assertEqual(set(package.namelist()), set(files))
            for name, content in files.items():
                self.assertEqual(package.read(name).decode("utf-8"), content)
        reveal = self.success("reveal_specialist")
        self.assertEqual(reveal["path"], str(destination))
        self.assertEqual(reveal["specialist_id"], self.child_id)
        self.assertEqual(self.store.get_work(self.parent["id"])["status"], "completed")

    def test_reveal_requires_export_and_rejects_same_length_modified_zip(self):
        code, response = self.rpc("reveal_specialist")
        self.assertEqual(code, 1)
        self.assertIn("Export", response["error"]["message"])
        self.assertFalse((self.state / "exports").exists())
        exported = self.success("export_specialist")["export"]
        target = Path(exported["path"])
        bytes_before = target.read_bytes()
        damaged = bytes([bytes_before[0] ^ 1]) + bytes_before[1:]
        target.write_bytes(damaged)
        code, response = self.rpc("reveal_specialist")
        self.assertEqual(code, 1)
        self.assertIn("no longer match", response["error"]["message"])
        code, _ = self.rpc("export_specialist")
        self.assertEqual(code, 1)
        self.assertEqual(target.read_bytes(), damaged, "Export must not silently overwrite changed delivery bytes")

    def test_unrelated_parent_or_factory_specialist_cannot_inspect_export_or_reveal(self):
        other_parent = self.build({**SPEC, "name": "Different parent specialist"})
        unlinked = self.manager.submit(SPEC, "outside-work-factory-child", local_authority())
        self.manager.process(1, mission_id=unlinked["id"])
        for command in ("inspect_specialist", "export_specialist", "reveal_specialist"):
            for changes in ({"mission_id": other_parent["id"]}, {"specialist_id": unlinked["id"]}):
                with self.subTest(command=command, changes=changes):
                    code, response = self.rpc(command, **changes)
                    self.assertEqual(code, 1)
                    self.assertIn("not linked", response["error"]["message"])
        self.assertFalse((self.state / "exports").exists())

    def test_rpc_rejects_invalid_identity_extra_export_path_and_renderer_authority(self):
        for changes in ({"mission_id": "../state"}, {"specialist_id": str(uuid.uuid4())},
                        {"destination": str(Path(self.temp.name) / "outside.zip")}, {"authority": local_authority()}):
            with self.subTest(changes=changes):
                code, response = self.rpc("export_specialist", **changes)
                self.assertEqual(code, 1)
                self.assertEqual(response["error"]["code"], "INVALID_REQUEST")
        self.assertFalse((self.state / "exports").exists())


if __name__ == "__main__":
    unittest.main()
