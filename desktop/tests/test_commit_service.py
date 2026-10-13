"""Commit Service tests use isolated temporary databases, never host state."""

import json
from contextlib import closing, contextmanager
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import zipfile
from unittest.mock import patch

from foundry.commit_service import CommitService, _safe_path, artifact_digest
from foundry.pack_compiler import compile_pack


def authority(**overrides):
    return {"issuer": "local-user", "scope": "local-artifacts",
            "actions": ["build", "run", "commit"], "max_candidates": 2,
            "max_input_bytes": 65536, **overrides}


@contextmanager
def database(path):
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            yield connection


class CommitServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "factory"
        self.store = CommitService(self.root)

    def tearDown(self):
        self.doCleanups()
        self.store.close()
        self.temporary.cleanup()

    def submit(self, key="mission-1"):
        return self.store.submit({"name": "contract-test", "description": "Verified test specialist",
                                  "capabilities": ["text.analyze"]}, key, authority())

    def to_validating(self):
        mission = self.submit()
        self.store.transition(mission["id"], "queued", "running")
        return self.store.transition(mission["id"], "running", "validating")

    def test_idempotency_and_conflicts_survive_reopen(self):
        first = self.submit()
        self.assertEqual(self.submit(), first)
        self.assertEqual(len(self.store.events(first["id"])), 1)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.submit(), first)
        with self.assertRaisesRegex(ValueError, "Idempotency"):
            self.store.submit({"name": "different"}, "mission-1", authority())
        with self.assertRaisesRegex(ValueError, "Idempotency"):
            self.store.submit(first["spec"], "mission-1", authority(max_candidates=1))
        self.assertEqual(len(self.store.list_missions()), 1)

    def test_authority_is_explicit_bounded_and_unexpired(self):
        invalid = [None, {}, authority(issuer="model"), authority(scope="anywhere"),
                   authority(actions=["build"]), authority(max_candidates=3),
                   authority(max_candidates=True), authority(max_input_bytes=65537),
                   authority(expires_at="2000-01-01T00:00:00+00:00"),
                   authority(expires_at="2100-01-01T00:00:00"), authority(expires_at=None)]
        for envelope in invalid:
            with self.subTest(envelope=envelope), self.assertRaises(ValueError):
                self.store.submit({"name": "test"}, "invalid", envelope)
        with self.assertRaisesRegex(ValueError, "input limit"):
            self.store.submit({"name": "test"}, "oversized", authority(max_input_bytes=1))
        self.assertEqual(self.store.list_missions(), [])

    def test_transition_compare_and_swap_and_no_unvalidated_completion(self):
        mission = self.submit()
        with self.assertRaisesRegex(ValueError, "Illegal"):
            self.store.transition(mission["id"], "queued", "completed")
        running = self.store.transition(mission["id"], "queued", "running", {"first": 1})
        self.assertEqual(running["attempts"], 1)
        with self.assertRaisesRegex(ValueError, "expected queued"):
            self.store.transition(mission["id"], "queued", "cancelled")
        updated = self.store.transition(mission["id"], "running", "validating", {"second": 2})
        self.assertEqual(updated["data"], {"first": 1, "second": 2})
        self.store.transition(mission["id"], "validating", "cancelled")
        with self.assertRaisesRegex(ValueError, "Illegal"):
            self.store.transition(mission["id"], "cancelled", "running")

    def test_worker_lock_contention_and_recovery_after_close(self):
        other = CommitService(self.root)
        self.addCleanup(other.close)
        mission = self.submit()
        self.store.transition(mission["id"], "queued", "running")
        with self.assertRaisesRegex(RuntimeError, "worker lock"):
            other.transition(mission["id"], "running", "queued")
        with self.store.acquire_worker():
            with self.assertRaisesRegex(RuntimeError, "worker lock"):
                with other.acquire_worker():
                    self.fail("Two workers acquired one lock")
            self.store.close()
            with other.acquire_worker():
                recovered = other.transition(mission["id"], "running", "queued", {"recovered": True})
                self.assertEqual(recovered["status"], "queued")
        self.assertTrue(other.verify_integrity()["passed"])

    def test_worker_lock_released_after_abrupt_process_exit(self):
        script = (
            "import os,sys; from pathlib import Path; "
            "from foundry.commit_service import CommitService; "
            "store=CommitService(Path(sys.argv[1])); "
            "guard=store.acquire_worker(); guard.__enter__(); "
            "print('locked',flush=True); sys.stdin.readline(); os._exit(0)"
        )
        process = subprocess.Popen([sys.executable, "-c", script, str(self.root)],
                                   cwd=Path(__file__).resolve().parents[1],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "locked")
            with self.assertRaisesRegex(RuntimeError, "worker lock"):
                with self.store.acquire_worker():
                    self.fail("Child process did not own worker lock")
            process.communicate("release\n", timeout=10)
            self.assertEqual(process.returncode, 0)
            with self.store.acquire_worker():
                self.assertTrue(self.store.verify_integrity()["passed"])
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()

    def test_event_tamper_fails_on_read_write_and_restart(self):
        mission = self.submit()
        with database(self.store.path) as attacker:
            attacker.execute("UPDATE events SET data='{}' WHERE id=1")
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            self.store.verify_integrity()
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            self.store.record_event(mission["id"], "tamper.should-not-commit", {})
        self.store.close()
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            CommitService(self.root)

    def test_state_tamper_fails_closed(self):
        mission = self.submit()
        with database(self.store.path) as attacker:
            attacker.execute("UPDATE missions SET spec=? WHERE id=?", ('{"name":"changed"}', mission["id"]))
        with self.assertRaisesRegex(RuntimeError, "state mismatch"):
            self.store.verify_integrity()
        with self.assertRaisesRegex(RuntimeError, "state mismatch"):
            self.store.transition(mission["id"], "queued", "running")

    def test_publication_rejects_forged_validation_and_unsafe_paths(self):
        mission = self.to_validating()
        files = {"agent.py": "print('untrusted')"}
        evidence = {"passed": True, "artifact_digest": artifact_digest(files)}
        with self.assertRaisesRegex(ValueError, "Independent"):
            self.store.publish(mission["id"], files, evidence, {"reason": "forged"})
        with self.assertRaisesRegex(ValueError, "bound"):
            self.store.publish(mission["id"], files, {"passed": True}, {"reason": "missing digest"})
        with self.assertRaisesRegex(ValueError, "normalized"):
            self.store.publish(mission["id"], {"../escape": "bad"}, evidence, {"reason": "unsafe"})
        self.assertEqual(self.store.get_mission(mission["id"])["status"], "validating")
        self.assertIsNone(self.store.get_artifact(mission["id"]))

    def test_publication_is_atomic_and_immutable(self):
        # Isolate storage behavior; compiler correctness is covered independently.
        mission = self.to_validating()
        files = compile_pack(mission["spec"]).files
        evidence = {"passed": True, "errors": [], "artifact_digest": artifact_digest(files)}
        selection = {"reason": "storage transaction fixture", "strategy": "balanced", "digest": artifact_digest(files)}
        with patch("foundry.pack_compiler.validate_pack", return_value={"passed": True, "errors": []}):
            with patch.object(self.store, "_append_event", side_effect=RuntimeError("simulated event failure")):
                with self.assertRaisesRegex(RuntimeError, "simulated"):
                    self.store.publish(mission["id"], files, evidence, selection)
            self.assertEqual(self.store.get_mission(mission["id"])["status"], "validating")
            self.assertIsNone(self.store.get_artifact(mission["id"]))
            artifact = self.store.publish(mission["id"], files, evidence, selection)
            self.assertEqual(artifact["files"], files)
            self.assertEqual(artifact["digest"], artifact_digest(files))
            with self.assertRaisesRegex(ValueError, "validating"):
                self.store.publish(mission["id"], files, evidence, {"reason": "again"})
        self.assertEqual(self.store.get_mission(mission["id"])["status"], "completed")
        self.assertEqual(self.store.events(mission["id"])[-1]["event_type"], "artifact.committed")
        self.assertTrue(self.store.verify_integrity()["passed"])
        with database(self.store.path) as attacker:
            attacker.execute("UPDATE artifacts SET files=?", (json.dumps({"test.txt": "tampered"}),))
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            self.store.get_artifact(mission["id"])

    def test_unknown_future_schema_is_rejected_without_downgrade(self):
        self.store.close()
        with database(self.root / "foundry.sqlite3") as connection:
            connection.execute("PRAGMA user_version=9000")
        with self.assertRaisesRegex(RuntimeError, "newer"):
            CommitService(self.root)
        with database(self.root / "foundry.sqlite3") as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 9000)

    def test_export_is_deterministic_roundtrips_and_rejects_changed_cache(self):
        mission = self.to_validating()
        files = compile_pack(mission["spec"]).files
        evidence = {"passed": True, "errors": [], "artifact_digest": artifact_digest(files)}
        with patch("foundry.pack_compiler.validate_pack", return_value={"passed": True, "errors": []}):
            self.store.publish(mission["id"], files, evidence, {"reason": "export storage fixture",
                               "strategy": "balanced", "digest": artifact_digest(files)})
        first = self.store.export_artifact(mission["id"])
        second = self.store.export_artifact(mission["id"])
        self.assertEqual(first, second)
        self.assertEqual(Path(first["path"]).parent, self.root / "exports")
        with zipfile.ZipFile(first["path"]) as archive:
            self.assertEqual({name: archive.read(name).decode("utf-8") for name in archive.namelist()}, files)
            self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()))
        Path(first["path"]).write_bytes(b"tampered export")
        with self.assertRaisesRegex(RuntimeError, "Existing export differs"):
            self.store.export_artifact(mission["id"])
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_export_rejects_uncommitted_mission(self):
        mission = self.submit()
        with self.assertRaisesRegex(ValueError, "completed"):
            self.store.export_artifact(mission["id"])

    def test_valid_pack_for_another_mission_cannot_be_published(self):
        mission = self.to_validating()
        files = compile_pack({**mission["spec"], "name": "Different authorized purpose"}).files
        evidence = {"passed": True, "errors": [], "artifact_digest": artifact_digest(files)}
        with self.assertRaisesRegex(ValueError, "authorized mission specification"):
            self.store.publish(mission["id"], files, evidence, {"reason": "wrong mission"})
        self.assertEqual(self.store.get_mission(mission["id"])["status"], "validating")

    def test_selection_cannot_change_the_validated_execution_strategy(self):
        mission = self.to_validating()
        files = compile_pack(mission["spec"], "balanced").files
        evidence = {"passed": True, "errors": [], "artifact_digest": artifact_digest(files)}
        with self.assertRaisesRegex(ValueError, "manifest strategy"):
            self.store.publish(mission["id"], files, evidence, {"reason": "wrong behavior",
                               "strategy": "precision", "digest": artifact_digest(files)})
        self.assertIsNone(self.store.get_artifact(mission["id"]))

    def test_malformed_ids_rejected_without_path_access(self):
        for identifier in ("../elsewhere", "C:\\Windows", "", None):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                self.store.get_artifact(identifier)

    @unittest.skipIf(os.name == "nt", "Windows symbolic links need optional host privileges")
    def test_symlink_state_roots_are_rejected(self):
        target = Path(self.temporary.name) / "target"
        target.mkdir()
        linked = Path(self.temporary.name) / "linked"
        linked.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            CommitService(linked)

    def test_windows_reparse_metadata_is_rejected_without_host_privileges(self):
        metadata = SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
        with patch.object(Path, "lstat", return_value=metadata):
            with self.assertRaisesRegex(ValueError, "reparse"):
                _safe_path(self.root / "junction" / "foundry.sqlite3")


if __name__ == "__main__":
    unittest.main()
