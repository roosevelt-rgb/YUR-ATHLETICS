"""Public saved-specialist RPC: bounded discovery without a fake Work mission."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager, local_authority

ROOT = Path(__file__).resolve().parents[1]
SPEC = {"name": "Saved catalog specialist", "description": "CATALOG_SOURCE_EXCLUSION_81f4", "capabilities": ["text.analyze"]}


class SavedSpecialistCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "journal"

    def rpc(self, **fields):
        payload = {"command": "list_saved_specialists", "limit": 20, "cursor": None, **fields}
        environment = {**os.environ, "YUR_DESKTOP_HOME": str(self.state), "PYTHONNOUSERSITE": "1", "PYTHONIOENCODING": "utf-8"}
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        process = subprocess.run([sys.executable, "-B", "-m", "foundry.work_cli"], cwd=ROOT, env=environment,
                                 input=json.dumps(payload).encode(), capture_output=True, timeout=15)
        self.assertEqual(process.stderr, b"")
        records = [json.loads(line) for line in process.stdout.decode().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["type"], "result")
        return process.returncode, records[0]

    def success(self, **fields):
        code, response = self.rpc(**fields)
        self.assertEqual(code, 0, response)
        self.assertTrue(response["ok"])
        return response["result"]

    def build(self, store, name):
        request = {"request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "mode": "work",
                   "goal": "Build a real saved catalog specialist", "root": None, "provider": "ollama", "model": "fixture",
                   "messages": [{"role": "user", "content": "Build a real saved catalog specialist"}]}
        calls = iter([{"content": "", "tool_calls": [{"function": {"name": "build_specialist", "arguments": {**SPEC, "name": name}}}]},
                      {"content": "Committed a specialist."}])
        mission = OrchestrationManager(store).run_work(request, lambda *_: next(calls))
        self.assertTrue(mission["steps"][0]["succeeded"], mission)
        return mission, mission["steps"][0]["result"]["mission_id"]

    def test_empty_discovery_is_read_only_and_requires_no_parent(self):
        result = self.success()
        self.assertEqual(result, {"entries": [], "scanned": 0, "excluded": 0, "next_cursor": None, "coverage_limited": False})
        self.assertFalse(self.state.exists())
        with CommitService(self.state) as store:
            self.assertEqual(store.list_work(), [])
            before = store.verify_integrity()
            self.assertEqual(self.success(), result)
            self.assertEqual(store.list_work(), [])
            self.assertEqual(store.list_missions_page()["total"], 0)
            self.assertEqual(store.verify_integrity(), before)

    def test_strict_limit_cursor_types_and_no_renderer_authority_root_or_parent(self):
        for fields in ({"limit": 0}, {"limit": 21}, {"limit": True}, {"limit": 1.5}, {"limit": "1"},
                       {"cursor": 1}, {"cursor": "../journal"}, {"cursor": str(uuid.uuid4())}, {"cursor": "A" * 32},
                       {"authority": local_authority()}, {"root": str(self.state)}, {"parent_work_id": "0" * 32},
                       {"conversation_id": str(uuid.uuid4())}, {"command": "list_saved_specialists", "extra": None}):
            with self.subTest(fields=fields):
                code, result = self.rpc(**fields)
                self.assertEqual(code, 1)
                self.assertEqual(result["error"]["code"], "INVALID_REQUEST")
                self.assertFalse(self.state.exists())

    def test_actual_saved_entries_page_and_provenance_without_payload_or_source_files(self):
        with CommitService(self.state) as store:
            first_parent, first_child = self.build(store, "First catalog specialist")
            second_parent, second_child = self.build(store, "Second catalog specialist")
            before = store.verify_integrity()
            first = self.success(limit=1)
            second = self.success(limit=1, cursor=first["next_cursor"])
            self.assertEqual(first["next_cursor"], first_child)
            self.assertTrue(first["coverage_limited"])
            self.assertEqual(second["next_cursor"], None)
            self.assertFalse(second["coverage_limited"])
            self.assertEqual([first["entries"][0]["mission_id"], second["entries"][0]["mission_id"]], [first_child, second_child])
            for result, child, parent in ((first, first_child, first_parent), (second, second_child, second_parent)):
                self.assertLessEqual(result["scanned"], 200)
                entry = result["entries"][0]
                self.assertEqual(entry["source_parent_work_id"], parent["id"])
                self.assertEqual(entry["artifact_digest"], store.get_artifact(child)["digest"])
                self.assertEqual(entry["capabilities"], ["text.analyze"])
                self.assertEqual(entry["lifecycle"]["mission_status"], "completed")
                self.assertGreater(entry["evidence"]["fixtures_passed"], 0)
                self.assertEqual(set(entry), {"mission_id", "name", "capabilities", "artifact_digest", "source_parent_work_id", "created_at", "lifecycle", "evidence"})
                encoded = json.dumps(result)
                self.assertNotIn(SPEC["description"], encoded)
                self.assertNotIn("agent.py", encoded)
                self.assertNotIn("runtime.py", encoded)
                self.assertNotIn('"files"', encoded)
                self.assertNotIn('"request"', encoded)
            self.assertEqual(len(store.list_work()), 2)
            self.assertEqual(store.list_missions_page()["total"], 2)
            self.assertEqual(store.verify_integrity(), before)
            self.assertFalse((self.state / "exports").exists())
            code, result = self.rpc(cursor="f" * 32)
            self.assertEqual(code, 1)
            self.assertIn("cursor", result["error"]["message"].lower())

    def test_factory_only_or_uncommitted_children_are_not_saved_work_specialists(self):
        with CommitService(self.state) as store:
            manager = OrchestrationManager(store)
            outside = manager.submit(SPEC, "outside-work-catalog-fixture", local_authority())
            manager.process(1, mission_id=outside["id"])
            manager.submit({**SPEC, "name": "Queued child"}, "work.specialist:unproven-origin:0", local_authority())
            result = self.success()
            self.assertEqual(result["entries"], [])
            self.assertEqual(result["scanned"], 2)
            self.assertEqual(result["excluded"], 2)
            self.assertEqual(store.list_work(), [])


if __name__ == "__main__":
    unittest.main()
