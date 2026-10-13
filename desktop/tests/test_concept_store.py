"""Concept transactions use real local OM receipts and isolated temporary state."""
from contextlib import closing
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService, SCHEMA_VERSION
from foundry.concept_store import CONCEPT_AUTHORITY, ConceptConflictError, _digest
from foundry.orchestration import OrchestrationManager, local_authority
from foundry.work_engine import AUTHORITY
from foundry.work_store import now

SEED = {"name": "Evidence-driven estimating", "domain_tags": ["construction", "estimating"],
        "thesis_statement": "Keep source quantities and build evidence attached to an estimating specialist."}
SPEC = {"name": "Concept quantity worker", "description": "Bounded source quantities",
        "capabilities": ["workforce.hatch.quantity", "text.analyze"]}


def operation():
    return str(uuid.uuid4())


class ConceptStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "state"
        self.store = CommitService(self.root)
        self.addCleanup(lambda: self.store.close())
        self.manager = OrchestrationManager(self.store)

    def create(self, **changes):
        return self.store.create_concept({**SEED, **changes}, CONCEPT_AUTHORITY, operation())

    def add(self, concept, requirement, source):
        return self.store.submit_concept_evidence(concept["id"], concept["revision"],
            {"requirement": requirement, "source": source}, operation(), CONCEPT_AUTHORITY)

    def move(self, concept, target, requirements):
        ids = [item["id"] for item in concept["evidence"] if item["requirement"] in requirements]
        return self.store.transition_concept(concept["id"], concept["revision"], target, ids, operation(), CONCEPT_AUTHORITY)

    def inception(self):
        concept = self.create()
        for requirement in ("name", "domain_tags", "thesis_statement"):
            concept = self.add(concept, requirement, {"kind": "concept_intent"})
        moved = self.move(concept, "inception", {"name", "domain_tags", "thesis_statement"})
        self.assertTrue(moved["decision"]["allowed"], moved)
        return moved["concept"]

    def work_request(self, goal="Create exact concept plans"):
        return {"request_id": operation(), "conversation_id": operation(), "mode": "work", "goal": goal,
                "root": None, "provider": "ollama", "model": "fixture", "messages": [{"role": "user", "content": goal}]}

    def plans(self, concept_id, overrides=None):
        bodies = {"charter": "Build one bounded source-preserving worker.",
                  "success_criteria": ["Retain source quantities and their receipt hashes"],
                  "constraint_set": ["No external writes or invented quantities"]}
        bodies.update(overrides or {})
        calls = []
        for requirement, content in bodies.items():
            plan = {"schema": "yur.concept-plan.v1", "concept_id": concept_id, "requirement": requirement, "content": content}
            calls.append({"function": {"name": "create_artifact", "arguments": {
                "name": requirement + ".json", "media_type": "application/json", "content": json.dumps(plan)}}})
        count = 0
        def adapter(_messages, _tools):
            nonlocal count
            count += 1
            return {"content": "", "tool_calls": calls} if count == 1 else {"content": "Plans committed."}
        mission = self.manager.run_work(self.work_request(), adapter)
        self.assertEqual(mission["status"], "completed", mission["error"])
        self.assertTrue(all(step["succeeded"] for step in mission["steps"]), mission)
        return mission

    def development(self):
        concept = self.inception()
        mission = self.plans(concept["id"])
        for step in mission["steps"]:
            requirement = json.loads(step["arguments"]["content"])["requirement"]
            concept = self.add(concept, requirement, {"kind": "work_artifact", "mission_id": mission["id"], "artifact_id": step["id"]})
        result = self.move(concept, "development", {"charter", "success_criteria", "constraint_set"})
        self.assertTrue(result["decision"]["allowed"], result)
        return result["concept"]

    def build(self, name=None):
        mission = self.manager.submit({**SPEC, **({"name": name} if name else {})}, operation(), local_authority())
        self.manager.process(mission_id=mission["id"])
        self.assertEqual(self.store.get_mission(mission["id"])["status"], "completed")
        return mission["id"]

    def bind(self, concept, mission_id, parent=None):
        return self.store.bind_concept_version(concept["id"], concept["revision"], mission_id, parent, operation(), CONCEPT_AUTHORITY)

    def test_initial_identity_and_seed_are_separate_from_missions_and_conversations(self):
        self.assertEqual(self.store.list_concepts(), {"concepts": [], "next_cursor": None, "total": 0})
        concept = self.create()
        self.assertEqual(concept["stage"], "genesis")
        self.assertEqual(concept["versions"], [])
        self.assertEqual(concept["parent_id"], None)
        self.assertEqual(concept["lineage"], [])
        self.assertEqual(concept["receipt"]["hash"], concept["history_hash"])
        self.assertEqual(self.store.list_missions(), [])
        self.assertEqual(self.store.list_work(), [])
        summary = self.store.list_concepts()["concepts"][0]
        self.assertNotIn("thesis_statement", summary)
        self.assertEqual(summary["version_count"], 0)

    def test_creation_replay_returns_exact_original_snapshot_and_rejects_changed_seed(self):
        key = operation()
        original = self.store.create_concept(SEED, CONCEPT_AUTHORITY, key)
        self.add(original, "name", {"kind": "concept_intent"})
        replay = self.store.create_concept(copy.deepcopy(SEED), CONCEPT_AUTHORITY, key)
        self.assertEqual(replay, original)
        with self.assertRaisesRegex(ValueError, "different arguments"):
            self.store.create_concept({**SEED, "name": "Changed"}, CONCEPT_AUTHORITY, key)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.store.create_concept(SEED, CONCEPT_AUTHORITY, key), original)

    def test_strict_seed_authority_and_budgets_cannot_invent_progress(self):
        for extra in ({"stage": "evolution"}, {"parent_id": operation()}, {"lineage": []}, {"passed": True}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.store.create_concept({**SEED, **extra}, CONCEPT_AUTHORITY, operation())
        for authority in ({}, {**CONCEPT_AUTHORITY, "issuer": "model"}, {**CONCEPT_AUTHORITY, "actions": ["commit", "deploy"]}):
            with self.assertRaises(ValueError):
                self.store.create_concept(SEED, authority, operation())
        for changes in ({"name": " "}, {"domain_tags": ["same", "same"]}, {"domain_tags": []}, {"thesis_statement": "x" * 8001}):
            with self.assertRaises(ValueError):
                self.create(**changes)
        self.assertEqual(self.store.list_concepts()["total"], 0)

    def test_operation_lookup_retains_original_creation_and_denial_after_later_changes(self):
        create_key, denial_key = operation(), operation()
        original = self.store.create_concept(SEED, CONCEPT_AUTHORITY, create_key)
        denied = self.store.transition_concept(original["id"], original["revision"], "inception", [], denial_key, CONCEPT_AUTHORITY)
        self.add(denied["concept"], "name", {"kind": "concept_intent"})
        before, changes = self.store.verify_integrity(), self.store._db.total_changes
        self.assertEqual(self.store.get_concept_operation(create_key, CONCEPT_AUTHORITY), original)
        self.assertEqual(self.store.get_concept_operation(denial_key, CONCEPT_AUTHORITY), denied)
        self.assertIsNone(self.store.get_concept_operation(operation(), CONCEPT_AUTHORITY))
        self.assertEqual(self.store._db.total_changes, changes)
        self.assertEqual(self.store.verify_integrity(), before)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.store.get_concept_operation(create_key, CONCEPT_AUTHORITY), original)
        self.assertEqual(self.store.get_concept_operation(denial_key, CONCEPT_AUTHORITY), denied)

    def test_operation_lookup_requires_exact_owner_but_allows_new_receipt_and_terminal_work(self):
        def running_work():
            work = self.store.submit_work(self.work_request(), AUTHORITY)
            document = {key: value for key, value in work.items() if key not in {"revision", "receipt"}}
            document.update(status="running", updated_at=now())
            return self.store.commit_work(document, work["revision"], "work.started", {})
        work, other = running_work(), running_work()
        key = operation()
        with self.store.acquire_worker():
            authority = self.store.concept_authority_for_work(work["id"])
            original = self.store.create_concept(SEED, authority, key)
            document = {field: value for field, value in work.items() if field not in {"revision", "receipt"}}
            work = self.store.commit_work_checkpoint(document, work["revision"], "work.progress", {})
            refreshed = self.store.concept_authority_for_work(work["id"])
            self.assertNotEqual(authority["work_receipt_hash"], refreshed["work_receipt_hash"])
            self.assertEqual(self.store.get_concept_operation(key, refreshed), original)
            foreign = self.store.concept_authority_for_work(other["id"])
            with self.assertRaisesRegex(ValueError, "different authority"):
                self.store.get_concept_operation(key, foreign)
            with self.assertRaisesRegex(ValueError, "different authority"):
                self.store.get_concept_operation(key, CONCEPT_AUTHORITY)
            self.store.complete_work_unsteered(work["id"], work["revision"], "Retained once.")
        before = self.store.verify_integrity()
        self.assertEqual(self.store.get_concept_operation(key, refreshed), original)
        self.assertEqual(self.store.verify_integrity(), before)
        self.store.close()
        self.store = CommitService(self.root)
        self.assertEqual(self.store.get_concept_operation(key, authority), original)
        self.assertEqual(self.store.get_concept_operation(key, refreshed), original)

    def test_operation_lookup_does_not_mask_malformed_authority_or_corrupt_records_as_absent(self):
        key = operation()
        original = self.store.create_concept(SEED, CONCEPT_AUTHORITY, key)
        for authority in ({}, {**CONCEPT_AUTHORITY, "issuer": "model"}):
            with self.assertRaises(ValueError):
                self.store.get_concept_operation(operation(), authority)
        for invalid_id in (None, "bad-id", True):
            with self.assertRaises(ValueError):
                self.store.get_concept_operation(invalid_id, CONCEPT_AUTHORITY)
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.execute("UPDATE concept_events SET hash=? WHERE operation_id=?", ("f" * 64, key))
        with self.assertRaises(RuntimeError):
            self.store.get_concept_operation(key, CONCEPT_AUTHORITY)
        with self.assertRaises(RuntimeError):
            self.store.get_concept_operation(operation(), CONCEPT_AUTHORITY)

    def test_seed_receipts_allow_inception_without_claiming_outcome(self):
        concept = self.inception()
        self.assertEqual(concept["stage"], "inception")
        self.assertEqual(concept["revision"], 5)
        events = self.store.concept_events(concept["id"])["events"]
        self.assertEqual(events[-1]["event_type"], "concept.transitioned")
        self.assertTrue(all(item["qualification"] == "documented_plan_only" for item in events[-1]["decision"]["evidence"]))
        self.assertEqual(self.store.verify_integrity()["concept_events"], 5)

    def test_actual_work_plans_allow_development_and_remain_bound_to_concept(self):
        concept = self.development()
        self.assertEqual(concept["stage"], "development")
        self.assertEqual(len(concept["evidence"]), 6)
        self.assertEqual(concept["versions"], [])
        other = self.create(name="Other concept")
        plan = next(item for item in concept["evidence"] if item["source"]["kind"] == "work_artifact")
        with self.assertRaisesRegex(ValueError, "identity"):
            self.add(other, plan["requirement"], plan["source"])
        self.assertEqual(self.store.get_concept(other["id"]), other)

    def test_real_build_execution_gate_stabilization_and_denies_unmeasured_maturation(self):
        concept = self.development()
        mission_id = self.build()
        concept = self.bind(concept, mission_id)
        version = concept["versions"][0]
        for requirement in ("artifact", "build_log"):
            concept = self.add(concept, requirement, {"kind": "specialist_build", "version_id": version["id"]})
        result = self.manager.run(mission_id, "workforce.hatch.quantity", {"plans_text": "125 CY", "specs_text": ""}, retain_output=True)
        concept = self.add(concept, "instrumentation", {"kind": "specialist_execution", "version_id": version["id"], "run_id": result["run_id"]})
        moved = self.move(concept, "stabilization", {"artifact", "build_log", "instrumentation"})
        self.assertTrue(moved["decision"]["allowed"], moved)
        self.assertEqual(moved["concept"]["stage"], "stabilization")
        denied = self.move(moved["concept"], "maturation", {"artifact"})
        self.assertFalse(denied["decision"]["allowed"])
        self.assertEqual(denied["concept"]["stage"], "stabilization")
        self.assertEqual(denied["concept"]["receipt"]["event_type"], "concept.transition.denied")
        self.assertEqual({item["requirement"] for item in denied["decision"]["missing"]}, {"eval_report", "stability_score", "known_failure_modes"})
        self.assertTrue(self.store.verify_integrity()["ok"])

    def test_version_parentage_is_immutable_and_does_not_advance_concept_clock(self):
        concept = self.create()
        first_mission = self.build()
        concept = self.bind(concept, first_mission)
        first = copy.deepcopy(concept["versions"][0])
        second_mission = self.build("New version with a distinct manifest")
        with self.assertRaisesRegex(ValueError, "parent"):
            self.bind(concept, second_mission)
        concept = self.bind(concept, second_mission, first["id"])
        self.assertEqual(concept["versions"][0], first)
        self.assertEqual(concept["versions"][1]["parent_version_id"], first["id"])
        self.assertEqual(concept["stage"], "genesis")
        self.assertEqual(concept["versions"][1]["ordinal"], 2)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.bind(concept, first_mission, first["id"])
        other = self.create(name="Foreign concept")
        with self.assertRaisesRegex(ValueError, "parent"):
            self.bind(other, first_mission, first["id"])

    def test_unfinished_or_uninstrumented_versions_do_not_forge_evidence(self):
        concept = self.create()
        pending = self.manager.submit(SPEC, operation(), local_authority())
        with self.assertRaisesRegex(ValueError, "completed"):
            self.bind(concept, pending["id"])
        mission = self.build()
        concept = self.bind(concept, mission)
        version = concept["versions"][0]
        for source, requirement in (({"kind": "specialist_execution", "version_id": version["id"], "run_id": uuid.uuid4().hex}, "instrumentation"),
                                    ({"kind": "specialist_build", "version_id": version["id"]}, "stability_score")):
            with self.assertRaises(ValueError):
                self.add(concept, requirement, source)
        ran = self.manager.run(mission, "text.analyze", {"text": "Output deliberately not retained"})
        with self.assertRaisesRegex(ValueError, "retained output"):
            self.add(concept, "instrumentation", {"kind": "specialist_execution", "version_id": version["id"], "run_id": ran["run_id"]})
        self.assertEqual(self.store.get_concept(concept["id"]), concept)

    def test_forged_hash_fields_and_foreign_transition_refs_are_rejected(self):
        concept, other = self.create(), self.create(name="Other")
        other = self.add(other, "name", {"kind": "concept_intent"})
        with self.assertRaisesRegex(ValueError, "another concept"):
            self.store.transition_concept(concept["id"], concept["revision"], "inception", [other["evidence"][0]["id"]], operation(), CONCEPT_AUTHORITY)
        for evidence in ({"requirement": "name", "source": {"kind": "concept_intent"}, "passed": True},
                         {"requirement": "name", "source": {"kind": "concept_intent", "receipt_hash": "0" * 64}}):
            with self.assertRaises(ValueError):
                self.store.submit_concept_evidence(concept["id"], concept["revision"], evidence, operation(), CONCEPT_AUTHORITY)

    def test_cas_replay_checks_original_args_before_stale_revision_across_connections(self):
        concept = self.create()
        evidence = {"requirement": "name", "source": {"kind": "concept_intent"}}
        key = operation()
        with CommitService(self.root) as other:
            with self.store.acquire_worker():
                committed = other.submit_concept_evidence(concept["id"], 1, evidence, key, CONCEPT_AUTHORITY)
            with self.assertRaises(ConceptConflictError):
                self.store.submit_concept_evidence(concept["id"], 1, {**evidence, "requirement": "domain_tags"}, operation(), CONCEPT_AUTHORITY)
            self.assertEqual(other.submit_concept_evidence(concept["id"], 1, evidence, key, CONCEPT_AUTHORITY), committed)
            with self.assertRaisesRegex(ValueError, "different arguments"):
                other.submit_concept_evidence(concept["id"], 2, evidence, key, CONCEPT_AUTHORITY)

    def test_denial_receipt_replays_exactly_without_claiming_progress(self):
        concept = self.create()
        key = operation()
        first = self.store.transition_concept(concept["id"], 1, "inception", [], key, CONCEPT_AUTHORITY)
        self.assertFalse(first["decision"]["allowed"])
        self.add(first["concept"], "name", {"kind": "concept_intent"})
        self.assertEqual(self.store.transition_concept(concept["id"], 1, "inception", [], key, CONCEPT_AUTHORITY), first)
        self.assertEqual(first["concept"]["revision"], 2)
        self.assertEqual(first["concept"]["stage"], "genesis")

    def test_delegation_requires_exact_real_work_and_survives_its_completion(self):
        work = self.store.submit_work(self.work_request(), AUTHORITY)
        document = {key: value for key, value in work.items() if key not in {"revision", "receipt"}}
        document.update(status="running", updated_at=now())
        work = self.store.commit_work(document, work["revision"], "work.started", {})
        with self.assertRaisesRegex(ValueError, "worker lock"):
            self.store.concept_authority_for_work(work["id"])
        key = operation()
        with self.store.acquire_worker():
            authority = self.store.concept_authority_for_work(work["id"])
            original = self.store.create_concept(SEED, authority, key)
            self.store.complete_work_unsteered(work["id"], work["revision"], "Concept retained.")
        self.assertEqual(self.store.create_concept(SEED, authority, key), original)
        with self.assertRaisesRegex(ValueError, "running Work"):
            self.store.create_concept(SEED, authority, operation())
        self.assertTrue(self.store.verify_integrity()["ok"])

    def test_failed_event_commit_rolls_back_document_and_operation(self):
        key = operation()
        with patch.object(self.store, "_concept_append", side_effect=RuntimeError("interrupted concept event")):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.store.create_concept(SEED, CONCEPT_AUTHORITY, key)
        self.assertEqual(self.store.list_concepts()["total"], 0)
        created = self.store.create_concept(SEED, CONCEPT_AUTHORITY, key)
        self.assertEqual(created["revision"], 1)
        self.assertEqual(self.store.verify_integrity()["concept_events"], 1)

    def test_state_and_event_tamper_fail_closed_on_read_and_reopen(self):
        concept = self.create()
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            document = json.loads(raw.execute("SELECT document FROM concept_documents").fetchone()[0])
            document["stage"] = "evolution"
            raw.execute("UPDATE concept_documents SET document=?", (json.dumps(document),))
        with self.assertRaisesRegex(RuntimeError, "projection"):
            self.store.get_concept(concept["id"])
        self.store.close()
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            CommitService(self.root)

    def test_rehashed_self_consistent_fake_stage_is_rejected_by_semantic_projection(self):
        concept = self.create()
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.row_factory = sqlite3.Row
            event = dict(raw.execute("SELECT * FROM concept_events").fetchone())
            event["data"] = json.loads(event["data"])
            event["data"]["document"]["stage"] = "evolution"
            event["state_digest"] = _digest(event["data"]["document"])
            event.pop("hash")
            hashed = _digest(event)
            raw.execute("UPDATE concept_events SET data=?,state_digest=?,hash=?", (json.dumps(event["data"]), event["state_digest"], hashed))
            raw.execute("UPDATE concept_documents SET document=?", (json.dumps(event["data"]["document"]),))
        with self.assertRaisesRegex(RuntimeError, "invent progress"):
            self.store.get_concept(concept["id"])

    def test_bounded_catalog_pagination_and_history(self):
        concepts = [self.create(name="Concept " + str(index)) for index in range(3)]
        page = self.store.list_concepts(2)
        second = self.store.list_concepts(2, page["next_cursor"])
        self.assertEqual({item["id"] for item in page["concepts"] + second["concepts"]}, {item["id"] for item in concepts})
        self.assertIsNone(second["next_cursor"])
        for limit in (True, 0, 21):
            with self.assertRaises(ValueError):
                self.store.list_concepts(limit)
        with self.assertRaisesRegex(ValueError, "cursor"):
            self.store.list_concepts(cursor=operation())
        with patch("foundry.concept_store.MAX_CONCEPTS", 3):
            with self.assertRaisesRegex(ValueError, "100 identities"):
                self.create(name="Over budget")
        with patch("foundry.concept_store.MAX_HISTORY", 1):
            with self.assertRaises(ValueError):
                self.add(concepts[0], "name", {"kind": "concept_intent"})
        self.assertEqual(self.store.get_concept(concepts[0]["id"])["revision"], 1)

    def test_rehashed_version_hash_cannot_replace_actual_committed_build_evidence(self):
        concept = self.bind(self.create(), self.build())
        with closing(sqlite3.connect(self.store.path)) as raw, raw:
            raw.row_factory = sqlite3.Row
            event = dict(raw.execute("SELECT * FROM concept_events ORDER BY id DESC LIMIT 1").fetchone())
            event["data"] = json.loads(event["data"])
            event["data"]["document"]["versions"][0]["artifact_sha256"] = "f" * 64
            event["data"]["change"]["version"]["artifact_sha256"] = "f" * 64
            event["state_digest"] = _digest(event["data"]["document"])
            event.pop("hash")
            hashed = _digest(event)
            raw.execute("UPDATE concept_events SET data=?,state_digest=?,hash=? WHERE id=?",
                        (json.dumps(event["data"]), event["state_digest"], hashed, event["id"]))
            raw.execute("UPDATE concept_documents SET document=?", (json.dumps(event["data"]["document"]),))
        with self.assertRaisesRegex(RuntimeError, "version source mismatch"):
            self.store.get_concept(concept["id"])

    def test_backup_and_schema5_migration_preserve_existing_receipts(self):
        concept = self.inception()
        before = self.store.verify_integrity()
        backup_root = Path(self.temp.name) / "backup"
        backup_root.mkdir()
        with closing(sqlite3.connect(self.store.path)) as source, closing(sqlite3.connect(backup_root / "foundry.sqlite3")) as target:
            source.backup(target)
        with CommitService(backup_root) as backup:
            self.assertEqual(backup.get_concept(concept["id"]), concept)
            self.assertEqual(backup.verify_integrity(), before)
        mission = self.build()
        factory_events = self.store.events(mission)
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute("DROP TABLE concept_events")
            raw.execute("DROP TABLE concept_documents")
            raw.execute("DROP TABLE runtime_setup_events")
            raw.execute("DROP TABLE runtime_setups")
            raw.execute("PRAGMA user_version=5")
        self.store = CommitService(self.root)
        self.assertEqual(self.store.list_concepts()["total"], 0)
        self.assertEqual(self.store.events(mission), factory_events)
        with closing(sqlite3.connect(self.store.path)) as raw:
            self.assertEqual(raw.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_corrupt_old_database_rolls_back_schema6_migration(self):
        mission = self.build()
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("DROP TABLE project_file_events")
            raw.execute("DROP TABLE project_files")
            raw.execute("DROP TABLE project_file_blobs")
            raw.execute("DROP TABLE concept_events")
            raw.execute("DROP TABLE concept_documents")
            raw.execute("DROP TABLE runtime_setup_events")
            raw.execute("DROP TABLE runtime_setups")
            raw.execute("PRAGMA user_version=5")
            raw.execute("UPDATE events SET data='{}' WHERE mission_id=? AND id=1", (mission,))
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            CommitService(self.root)
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw:
            self.assertEqual(raw.execute("PRAGMA user_version").fetchone()[0], 5)
            self.assertFalse(raw.execute("SELECT name FROM sqlite_master WHERE name='concept_documents'").fetchone())


if __name__ == "__main__":
    unittest.main()
