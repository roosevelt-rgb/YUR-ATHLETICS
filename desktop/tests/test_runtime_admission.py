"""Real historical package compatibility; no user state or candidate execution."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry import pack_compiler, runtime_admission, specialists, specialist_runtime_v1, work_specialists
from foundry.commit_service import CommitService, artifact_digest
from foundry.orchestration import OrchestrationManager, local_authority
from foundry.work_engine import AUTHORITY
from foundry.work_store import now

ROOT = Path(__file__).resolve().parents[1]
SPEC = {"name": "Legacy Operations", "description": "Pinned compatibility fixture",
        "capabilities": ["text.analyze", "data.profile", "support.triage"]}
QUANTITY = {"name": "Legacy Quantity", "description": "Pinned compatibility fixture",
            "capabilities": ["workforce.hatch.quantity"]}
# Captured with the original compiler BEFORE the current registry changed.
# Order: manifest, agent, runtime, fixtures, SBOM, README, attestation.
FILE_ORDER = ["manifest.json", "agent.py", "runtime.py", "tests/fixtures.json", "sbom.json", "README.md", "attestation.json"]
GOLDEN = [
    (SPEC, "balanced", "22ea49447a4d2248756938e10c13c401803e3ce240278b5c801f02d7816e4164 3664ae73582ad833fb6fefe39d90163781c32c15fc888c58a51728122c1cfa22 d1bba1a6a94c8b0aad0441d3bd9a457b343ee514e464097e8923333787831e08 cb88840ccc4d7f706c2596083a3a05654c6b0220b85eb4f1fe2754abcaf20f69 c5ce57cd7fbc313866be08237b295be4c806aba4403a20d26ab8f4cd3e384eee ed2b564a776c70a713e9738edc11666698436f50a081a6ed00ac2439352bbc30 17ad0eed8dea7ece5d9ae9a855f653af2ef8e414b3756bdcefcf95ebdc0d2daf"),
    (SPEC, "precision", "786db2a198d4158e77dbe8263119ca95be61b894c9ed150dbcaa25258827c3b7 170a390cfed54e9cd6ff59b573425081cbec4a313c3c63dba7ffe203486a37a4 d1bba1a6a94c8b0aad0441d3bd9a457b343ee514e464097e8923333787831e08 f3beaefaa1decf4876396c7ed909222001f1a8f7b9397844d927384306e2c563 c5ce57cd7fbc313866be08237b295be4c806aba4403a20d26ab8f4cd3e384eee e7e5d34491c31a6f60322beb3a19d7e2905c4a2b87b597f70e83f6b2fac4c07d 5fc291bef8ca5a8a1fd8d8f1808b4ce83856962ffeb84b242bb01c742d0ff0b1"),
    (QUANTITY, "balanced", "d30cb653d178791a56bc9501b5fa51fd0fd9214ffbc1697a2194331cb9e7cea5 706dfa1dad19d68ffe728741f7d6cd545f154612aefb1a3a5c99a78983e37718 d1bba1a6a94c8b0aad0441d3bd9a457b343ee514e464097e8923333787831e08 3ca5d9d67e38948d21ce5a53e1b0ef9c141b5a7d0472a683a2d96ae7d8a59bfd 73b539778debb0fb6805a9f99945f819cb6c18791a482d505f99136bdf03bc94 cf33260d19011a6e77ef632068966718d2480814d8a0599f71a1bac8beddbde2 246a8ef05b6703e91bfcb1839f38931ac509c299b95ee6d43187887a8f6f5446"),
    (QUANTITY, "precision", "407222b027c870be579edacc079bf9e9d653b16786b3c480b46134a9f84919f0 819cf48717a621d4802e9e178c1485e25e176e87aa9067079af494e49ab8714f d1bba1a6a94c8b0aad0441d3bd9a457b343ee514e464097e8923333787831e08 87d705355031b03357818765369586723a9918c16bb2d667c9251c6cf58c4626 73b539778debb0fb6805a9f99945f819cb6c18791a482d505f99136bdf03bc94 46ef24c52d51edd36851b6cf106da0bb3c0041a5d81a73bf27120246335abdd8 cdf66f1fc799e57882fb3d1a91ebfddabbb177c054bba547f4283ce5d30bf33b"),
]


class RuntimeAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.store = CommitService(self.home / "state")
        self.addCleanup(lambda: self.store.close())
        self.manager = OrchestrationManager(self.store)
        self.legacy = runtime_admission.runtime_by_hash(runtime_admission.HISTORICAL_SHA256)

    def old_pack(self, spec=SPEC, strategy="balanced"):
        return pack_compiler._compile_pack(copy.deepcopy(spec), strategy, self.legacy).files

    def publish(self, files, spec=SPEC):
        mission = self.manager.submit(spec, uuid.uuid4().hex, local_authority())
        self.store.transition(mission["id"], "queued", "running")
        self.store.transition(mission["id"], "running", "validating")
        validation = {**pack_compiler.validate_pack(files), "artifact_digest": artifact_digest(files)}
        self.assertTrue(validation["passed"], validation)
        self.store.publish(mission["id"], files, validation,
                           {"strategy": json.loads(files["manifest.json"])["strategy"],
                            "digest": artifact_digest(files), "reason": "Historical compatibility fixture"})
        return mission["id"]

    def test_all_pre_change_package_files_remain_byte_identical(self):
        for spec, strategy, expected in GOLDEN:
            with self.subTest(spec=spec["name"], strategy=strategy):
                files = self.old_pack(spec, strategy)
                self.assertEqual([hashlib.sha256(files[name].encode()).hexdigest() for name in FILE_ORDER], expected.split())
                validation = pack_compiler.validate_pack(files)
                self.assertTrue(validation["passed"], validation)
                self.assertEqual(validation["runtime"]["sha256"], self.legacy.sha256)
                self.assertEqual(json.loads(files["manifest.json"])["version"], "1.0.0")

    def test_old_contracts_fixtures_and_handler_ignore_changed_current_registry(self):
        files = self.old_pack()
        mission = self.publish(files)
        with patch.object(specialists, "CapabilityResolver", side_effect=AssertionError("Current resolver is not historical")), \
                patch.object(specialists, "run_capability", side_effect=AssertionError("Current handler is not historical")):
            validation = pack_compiler.validate_pack(files)
            self.assertTrue(validation["passed"], validation)
            output = self.manager.run(mission, "text.analyze", {"text": "Old agents preserve exact behavior."})
        self.assertEqual(output["output"]["word_count"], 5)
        self.assertEqual(output["receipt"]["data"]["runtime_sha256"], self.legacy.sha256)
        self.assertEqual(self.store.get_artifact(mission)["files"], files)

    def test_current_package_uses_current_revision_and_new_capability_is_not_in_old(self):
        current = runtime_admission.current_runtime()
        self.assertNotEqual(current.sha256, self.legacy.sha256)
        self.assertIn("construction.opc.inspect", [item["id"] for item in specialists.catalog()])
        with self.assertRaises(ValueError):
            self.legacy.resolve(["construction.opc.inspect"])
        files = pack_compiler.compile_pack(SPEC).files
        mission = self.publish(files)
        with patch.object(specialist_runtime_v1, "run_capability", side_effect=AssertionError("Historical handler must not run current pack")):
            result = self.manager.run(mission, "text.analyze", {"text": "Current admitted source executes."})
        self.assertEqual(result["output"]["word_count"], 4)
        self.assertEqual(result["receipt"]["data"]["runtime_sha256"], current.sha256)

    def test_unknown_package_code_never_executes_even_with_new_attestation_hash(self):
        files = self.old_pack()
        files["runtime.py"] += "\nraise RuntimeError('CANDIDATE CODE MUST NEVER EXECUTE')\n"
        attestation = json.loads(files["attestation.json"])
        attestation["files"]["runtime.py"] = hashlib.sha256(files["runtime.py"].encode()).hexdigest()
        files["attestation.json"] = json.dumps(attestation, indent=2, sort_keys=True) + "\n"
        with patch("builtins.exec", side_effect=AssertionError("Candidate source was executed")):
            rejected = pack_compiler.validate_pack(files)
        self.assertFalse(rejected["passed"])
        self.assertEqual(rejected["metrics"]["fixtures_passed"], 0)
        with self.assertRaisesRegex(ValueError, "not an admitted"):
            runtime_admission.admit_runtime(files["runtime.py"])

    def test_package_cannot_mix_historical_runtime_with_new_contracts(self):
        files = pack_compiler.compile_pack({**SPEC, "capabilities": ["construction.opc.inspect"]}).files
        files["runtime.py"] = self.legacy.source
        result = pack_compiler.validate_pack(files)
        self.assertFalse(result["passed"])
        self.assertEqual(result["metrics"]["fixtures_passed"], 0)

    def test_both_source_guards_fail_before_handler_execution(self):
        old = self.old_pack()
        original_read = Path.read_text
        for filename in ("specialists.py", "specialist_runtime_v1.py"):
            def changed(path, *args, **kwargs):
                text = original_read(path, *args, **kwargs)
                return text + "\n# source drift" if path.name == filename else text
            with self.subTest(filename=filename), patch.object(Path, "read_text", autospec=True, side_effect=changed), \
                    patch.object(specialist_runtime_v1, "run_capability") as execution:
                result = pack_compiler.validate_pack(old)
                self.assertFalse(result["passed"])
                self.assertEqual(result["metrics"]["fixtures_passed"], 0)
                execution.assert_not_called()
        self.assertTrue(pack_compiler.validate_pack(old)["passed"])

    def test_historical_source_pin_is_checked_before_static_import_in_new_process(self):
        root = self.home / "import-fixture"
        package = root / "foundry"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("", encoding="utf-8")
        for name in ("runtime_admission.py", "specialists.py"):
            (package / name).write_text((ROOT / "foundry" / name).read_text(encoding="utf-8"), encoding="utf-8")
        marker = root / "MUST_NOT_EXIST"
        poisoned = "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('executed')\n"
        (package / "specialist_runtime_v1.py").write_text(poisoned, encoding="utf-8")
        result = subprocess.run([sys.executable, "-B", "-c", "import foundry.runtime_admission"], cwd=root,
                                text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixed admission pin", result.stderr)
        self.assertFalse(marker.exists())

    def test_old_execution_receipt_replays_without_running_after_reopen(self):
        mission = self.publish(self.old_pack())
        payload = {"text": "A durable result is reused."}
        result = self.manager.run(mission, "text.analyze", payload, retain_output=True, execution_key="legacy:one")
        self.store.close()
        self.store = CommitService(self.home / "state")
        self.manager = OrchestrationManager(self.store)
        with patch("foundry.orchestration.run_admitted_capability", side_effect=AssertionError("Replay executed")), \
                patch("foundry.orchestration.validate_pack", side_effect=AssertionError("Replay revalidated")):
            replay = self.manager.run(mission, "text.analyze", payload, retain_output=True, execution_key="legacy:one")
            self.assertEqual(replay, result)
            with self.assertRaisesRegex(ValueError, "different input"):
                self.manager.run(mission, "text.analyze", {"text": "Changed"}, retain_output=True, execution_key="legacy:one")
        self.assertEqual(len([event for event in self.store.events(mission) if event["event_type"] == "execution.started"]), 1)

    def test_historical_failure_receipt_and_scope_are_pinned(self):
        mission = self.publish(self.old_pack(QUANTITY), QUANTITY)
        with self.assertRaises(PermissionError):
            self.manager.run(mission, "text.analyze", {"text": "outside binding"})
        with self.assertRaises(ValueError):
            self.manager.run(mission, "workforce.hatch.quantity", {"scope_manifest": {}})
        failed = [event for event in self.store.events(mission) if event["event_type"] == "execution.failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["data"]["runtime_sha256"], self.legacy.sha256)

    def test_saved_work_uses_pinned_input_and_output_contracts(self):
        request = {"request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "mode": "work",
                   "goal": "Build historical worker", "root": None, "provider": "ollama", "model": "fixture",
                   "messages": [{"role": "user", "content": "Build historical worker"}]}
        count = 0
        def build_adapter(_messages, _tools):
            nonlocal count
            count += 1
            return ({"content": "", "tool_calls": [{"function": {"name": "build_specialist", "arguments": SPEC}}]}
                    if count == 1 else {"content": "Built."})
        def historical_compile(spec, strategy="balanced"):
            return pack_compiler._compile_pack(spec, strategy, self.legacy)
        with patch("foundry.orchestration.compile_pack", side_effect=historical_compile):
            built_parent = self.manager.run_work(request, build_adapter)
        self.assertEqual(built_parent["status"], "completed", built_parent["error"])
        child_id = built_parent["steps"][0]["result"]["mission_id"]
        fresh = self.store.submit_work({**request, "request_id": str(uuid.uuid4()), "goal": "Reuse historical worker"}, AUTHORITY)
        doc = {key: value for key, value in fresh.items() if key not in {"revision", "receipt"}}
        doc.update(status="running", updated_at=now())
        fresh = self.store.commit_work(doc, fresh["revision"], "work.started", {})
        args = {"mission_id": child_id, "capability_id": "data.profile", "input": {"rows": [{"units": 7}, {"units": 8}]}}
        with self.store.acquire_worker(), \
                patch.object(specialists, "CapabilityResolver", side_effect=AssertionError("Wrong resolver")), \
                patch.object(specialists, "CapabilityRegistry", side_effect=AssertionError("Wrong registry")), \
                patch.object(work_specialists, "CapabilityRegistry", side_effect=AssertionError("Wrong Work registry")), \
                patch.object(specialists, "run_capability", side_effect=AssertionError("Wrong handler")):
            result = work_specialists.execute(self.manager, fresh, "run_saved_specialist", args)
        self.assertEqual(result["output"]["row_count"], 2)
        self.assertEqual(result["output"]["columns"][0]["name"], "units")
        self.assertEqual(result["runtime_sha256"], self.legacy.sha256)
        self.assertEqual(result["selection"]["source_parent_work_id"], built_parent["id"])
        self.assertEqual(len(self.store.list_missions()), 1)


if __name__ == "__main__":
    unittest.main()
