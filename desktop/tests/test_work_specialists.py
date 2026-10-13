"""Real compiler, OM, CommitService and executable-package acceptance."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService, artifact_digest
from foundry.orchestration import OrchestrationManager, local_authority
from foundry.specialists import CapabilityRegistry, validate_schema
from foundry.work_engine import AUTHORITY
from foundry.work_store import now
from foundry import work_specialists


SPEC = {"name": "Evidence specialist", "description": "Analyze supplied text and table records.",
        "capabilities": ["text.analyze", "data.profile"]}


class WorkSpecialistTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = CommitService(Path(self.temp.name) / "state")
        self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        self.parent = self.new_parent()

    def new_parent(self):
        request = {"request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "mode": "work",
                   "goal": "Build and use a bounded specialist", "root": None, "provider": "ollama", "model": "fixture",
                   "messages": [{"role": "user", "content": "Build and use a bounded specialist"}]}
        parent = self.store.submit_work(request, AUTHORITY)
        document = {key: value for key, value in parent.items() if key not in {"revision", "receipt"}}
        document.update(status="running", updated_at=now())
        return self.store.commit_work(document, parent["revision"], "work.started", {})

    def invoke(self, tool, args, parent=None):
        try:
            with self.store.acquire_worker():
                return work_specialists.execute(self.manager, parent or self.parent, tool, copy.deepcopy(args))
        finally:
            # Exact requests and saved selections can commit a parent revision.
            # Explicit stale-parent fixtures retain the snapshot they supplied.
            if parent is None:
                self.parent = self.store.get_work(self.parent["id"])

    def advance(self, tool, args, result):
        document = {key: value for key, value in self.parent.items() if key not in {"revision", "receipt"}}
        document["steps"] = [*document["steps"], {"id": uuid.uuid4().hex, "tool": tool, "arguments": args,
                                                "result": result, "succeeded": True, "completed_at": now()}]
        document["updated_at"] = now()
        self.parent = self.store.commit_work(document, self.parent["revision"], "work.tool.completed", {"tool": tool})

    def build(self):
        result = self.invoke("build_specialist", SPEC)
        self.advance("build_specialist", SPEC, result)
        return result

    def event_type(self, child, kind):
        return [event for event in self.store.events(child) if event["event_type"] == kind]

    def test_build_uses_blind_candidates_independent_validation_and_immutable_package(self):
        result = self.invoke("build_specialist", SPEC)
        detail = self.manager.inspect(result["mission_id"])
        self.assertEqual(detail["status"], "completed")
        self.assertEqual(len(detail["candidates"]), 2)
        self.assertEqual(len({candidate["digest"] for candidate in detail["candidates"]}), 2)
        self.assertTrue(all(candidate["passed"] for candidate in detail["candidates"]))
        self.assertTrue(all(event["data"]["blind_generation"] for event in self.event_type(result["mission_id"], "cell.started")))
        artifact = self.store.get_artifact(result["mission_id"])
        self.assertEqual(result["artifact"]["digest"], artifact_digest(artifact["files"]))
        self.assertEqual(result["artifact"]["files"], sorted(artifact["files"]))
        self.assertTrue(result["artifact"]["validation"]["passed"])
        self.assertIn("independent_outcome_fixtures", result["artifact"]["validation"]["checks"])
        self.assertIn("reason", result["artifact"]["selection"])
        self.assertNotIn(artifact["files"]["agent.py"], json.dumps(result))
        self.assertNotIn(artifact["files"]["runtime.py"], json.dumps(result))
        self.assertEqual(result["provenance"]["parent_work_id"], self.parent["id"])
        self.assertEqual(self.event_type(result["mission_id"], "artifact.exported"), [])
        for entry in work_specialists.catalog():
            if entry["name"] == "build_specialist":
                validate_schema(result, entry["output_schema"])
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_generated_package_executes_and_built_specialist_handles_new_typed_input(self):
        built = self.build()
        files = self.store.get_artifact(built["mission_id"])["files"]
        unpacked = Path(self.temp.name) / "isolated-package"
        for name, content in files.items():
            target = unpacked / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        executed = subprocess.run([sys.executable, "-B", "agent.py"], cwd=unpacked,
                                  input=json.dumps({"capability": "text.analyze", "input": {"text": "Actual standalone specialist output."}}),
                                  capture_output=True, text=True, timeout=15)
        self.assertEqual(executed.returncode, 0, executed.stderr)
        self.assertEqual(json.loads(executed.stdout)["result"]["word_count"], 4)
        args = {"mission_id": built["mission_id"], "capability_id": "data.profile", "input": {"rows": [{"units": 19}, {"units": 19}, {}]}}
        result = self.invoke("run_built_specialist", args)
        self.assertEqual(result["output"]["row_count"], 3)
        self.assertEqual(result["output"]["duplicate_rows"], 1)
        completion = self.event_type(built["mission_id"], "execution.completed")[0]
        self.assertEqual(result["run_id"], completion["data"]["run_id"])
        self.assertEqual(result["execution_receipt"]["hash"], completion["hash"])
        self.assertNotIn("data", result["execution_receipt"])
        self.assertEqual(completion["data"]["output"], result["output"])
        output_schema = next(item["output_schema"] for item in work_specialists.catalog() if item["name"] == "run_built_specialist")
        output_schema["properties"]["output"] = CapabilityRegistry().get(args["capability_id"])["output_schema"]
        validate_schema(result, output_schema)

    def test_parent_receipt_interruption_replays_exact_build_and_run_without_reexecution(self):
        built = self.invoke("build_specialist", SPEC)
        with patch.object(self.manager, "process_locked_child", side_effect=AssertionError("Completed build cannot be repeated")):
            self.assertEqual(self.invoke("build_specialist", SPEC), built)
        self.assertEqual(len(self.store.list_missions()), 1)
        with self.assertRaisesRegex(ValueError, "different"):
            self.invoke("build_specialist", {**SPEC, "description": "A changed task"})
        self.advance("build_specialist", SPEC, built)
        args = {"mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "A fresh observed outcome."}}
        ran = self.invoke("run_built_specialist", args)
        with patch.object(self.manager, "run", side_effect=AssertionError("Completed run cannot be repeated")):
            self.assertEqual(self.invoke("run_built_specialist", args), ran)
        with self.assertRaisesRegex(ValueError, "different"):
            self.invoke("run_built_specialist", {**args, "input": {"text": "Changed input"}})
        self.assertEqual(len(self.event_type(built["mission_id"], "execution.started")), 1)
        self.assertEqual(len(self.event_type(built["mission_id"], "execution.completed")), 1)

    def test_child_publication_interruption_recovers_same_artifact_without_rebuild(self):
        record = self.store.record_event

        def interrupt(child, kind, data):
            if kind == "work.specialist.result.committed":
                raise RuntimeError("Interrupted after child publication")
            return record(child, kind, data)

        with patch.object(self.store, "record_event", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "after child publication"):
                self.invoke("build_specialist", SPEC)
        child = self.store.list_missions()[0]
        digest = self.store.get_artifact(child["id"])["digest"]
        with patch.object(self.manager, "_build", side_effect=AssertionError("No rebuild after child publication")):
            result = self.invoke("build_specialist", SPEC)
        self.assertEqual(result["mission_id"], child["id"])
        self.assertEqual(result["artifact"]["digest"], digest)
        self.assertEqual(len(self.event_type(child["id"], "artifact.committed")), 1)

    def test_run_link_interruption_recovers_retained_output_using_exact_execution_key(self):
        built = self.build()
        args = {"mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "Precisely retained execution output."}}
        record = self.store.record_event

        def interrupt(child, kind, data):
            if kind == "work.specialist.result.committed":
                raise RuntimeError("Interrupted after execution completed")
            return record(child, kind, data)

        with patch.object(self.store, "record_event", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "execution completed"):
                self.invoke("run_built_specialist", args)
        completed = self.event_type(built["mission_id"], "execution.completed")[0]
        # A separate later run with matching input must not replace this result.
        other = self.manager.run(built["mission_id"], "text.analyze", args["input"], retain_output=True)
        self.assertNotEqual(other["run_id"], completed["data"]["run_id"])
        with patch("foundry.orchestration.run_admitted_capability", side_effect=AssertionError("A retained execution cannot be rerun")):
            result = self.invoke("run_built_specialist", args)
        self.assertEqual(result["run_id"], completed["data"]["run_id"])
        self.assertEqual(result["output"], completed["data"]["output"])
        self.assertEqual(len(self.event_type(built["mission_id"], "execution.completed")), 2)
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_interrupted_build_recovery_is_targeted_and_input_bound_before_work(self):
        queued = self.manager.submit(SPEC, "unrelated-queued", local_authority())
        running = self.manager.submit({**SPEC, "name": "Unrelated running"}, "unrelated-running", local_authority())
        self.store.transition(running["id"], "queued", "running")
        before = {mission["id"]: self.store.get_mission(mission["id"]) for mission in (queued, running)}
        with patch.object(self.manager, "process_locked_child", side_effect=RuntimeError("Interrupted before child build")):
            with self.assertRaisesRegex(RuntimeError, "before child build"):
                self.invoke("build_specialist", SPEC)
        child = next(mission for mission in self.store.list_missions() if mission["id"] not in before)
        self.assertEqual(len(self.event_type(child["id"], "work.specialist.accepted")), 1)
        with self.assertRaisesRegex(ValueError, "different"):
            self.invoke("build_specialist", {**SPEC, "capabilities": ["support.triage"]})
        self.store.transition(child["id"], "queued", "running")
        result = self.invoke("build_specialist", SPEC)
        self.assertEqual(result["mission_id"], child["id"])
        for mission_id, old in before.items():
            self.assertEqual(self.store.get_mission(mission_id), old)

    def test_invalid_args_scope_and_missing_lock_never_execute_or_grant_authority(self):
        with self.assertRaisesRegex(RuntimeError, "worker lock"):
            work_specialists.execute(self.manager, self.parent, "build_specialist", SPEC)
        for args in ({**SPEC, "capabilities": ["shell.execute"]}, {**SPEC, "capabilities": ["text.analyze"] * 2},
                     {**SPEC, "capabilities": list(work_specialists.ADMITTED_CAPABILITIES)}, {**SPEC, "authority": {}},
                     {**SPEC, "name": " Name with spaces "}, {**SPEC, "description": "x" * 2001}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.invoke("build_specialist", args)
        self.assertEqual(self.store.list_missions(), [])
        built = self.build()
        other = self.new_parent()
        args = {"mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "Scoped"}}
        with self.assertRaisesRegex(ValueError, "this parent"):
            self.invoke("run_built_specialist", args, other)
        with self.assertRaisesRegex(ValueError, "not bound"):
            self.invoke("run_built_specialist", {**args, "capability_id": "support.triage", "input": {"subject": "Question", "body": "How does this work?"}})
        with self.assertRaises(ValueError):
            self.invoke("run_built_specialist", {**args, "input": {"text": "ok", "unknown": True}})
        self.assertEqual(self.event_type(built["mission_id"], "execution.started"), [])

    def test_failed_independent_validation_never_publishes_or_exports(self):
        with patch("foundry.orchestration.validate_pack", return_value={"passed": False, "errors": ["Fixture outcome rejected"]}):
            with self.assertRaisesRegex(ValueError, "did not pass publication"):
                self.invoke("build_specialist", SPEC)
        child = self.store.list_missions()[0]
        self.assertEqual(child["status"], "failed")
        self.assertIsNone(self.store.get_artifact(child["id"]))
        self.assertEqual(self.event_type(child["id"], "artifact.exported"), [])
        with self.assertRaisesRegex(ValueError, "did not pass publication"):
            self.invoke("build_specialist", SPEC)

    def test_catalog_is_detached_and_does_not_create_state(self):
        first = work_specialists.catalog()
        self.assertEqual({item["name"] for item in first}, {"build_specialist", "run_built_specialist", "list_built_specialists", "run_saved_specialist"})
        self.assertEqual({entry["id"] for entry in first[0]["capabilities"]}, set(work_specialists.ADMITTED_CAPABILITIES))
        first[0]["input_schema"]["properties"]["name"]["maxLength"] = 100000
        self.assertEqual(work_specialists.catalog()[0]["input_schema"]["properties"]["name"]["maxLength"], 100)
        self.assertEqual(self.store.list_missions(), [])

    def test_submission_acceptance_interruption_keeps_child_and_rejects_changed_spec(self):
        record = self.store.record_event

        def interrupt(child, kind, data):
            if kind == "work.specialist.accepted":
                raise RuntimeError("Interrupted before acceptance event")
            return record(child, kind, data)

        with patch.object(self.store, "record_event", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "acceptance event"):
                self.invoke("build_specialist", SPEC)
        child = self.store.list_missions()[0]
        self.assertEqual(child["status"], "queued")
        with self.assertRaisesRegex(ValueError, "different"):
            self.invoke("build_specialist", {**SPEC, "name": "Changed specialist"})
        result = self.invoke("build_specialist", SPEC)
        self.assertEqual(result["mission_id"], child["id"])
        self.assertEqual(len(self.store.list_missions()), 1)

    def test_cancelled_or_stale_parent_cannot_start_child_and_nonfinite_inputs_fail_closed(self):
        stale = copy.deepcopy(self.parent)
        self.advance("fixture", {}, {})
        with self.assertRaisesRegex(ValueError, "changed"):
            self.invoke("build_specialist", SPEC, stale)
        self.manager.cancel_work(self.parent["id"])
        with self.assertRaisesRegex(ValueError, "not running"):
            self.invoke("build_specialist", SPEC)
        self.assertEqual(self.store.list_missions(), [])
        self.parent = self.new_parent()
        for invalid in (float("nan"), float("inf")):
            with self.assertRaisesRegex(ValueError, "finite"):
                self.invoke("run_built_specialist", {"mission_id": "0" * 32, "capability_id": "data.profile", "input": {"rows": [{"value": invalid}]}})
        with self.assertRaisesRegex(ValueError, "credential"):
            self.invoke("build_specialist", {**SPEC, "description": "api_key=" + "sk-" + "a" * 40})
        self.assertEqual(self.store.list_missions(), [])

    def test_actual_work_engine_builds_then_runs_child_and_replays_completed_parent(self):
        request = {**self.parent["request"], "request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4())}
        seen = []

        def model(messages, tools):
            names = {tool["name"] for tool in tools}
            self.assertTrue({"build_specialist", "run_built_specialist"}.issubset(names))
            outputs = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
            seen.append(outputs)
            if not outputs:
                return {"content": "", "tool_calls": [{"function": {"name": "build_specialist", "arguments": SPEC}}]}
            if len(outputs) == 1:
                child = outputs[0]["mission_id"]
                self.assertTrue(self.store.get_artifact(child))
                return {"content": "", "tool_calls": [{"function": {"name": "run_built_specialist", "arguments": {
                    "mission_id": child, "capability_id": "text.analyze", "input": {"text": "A newly built worker executed."}}}}]}
            self.assertEqual(outputs[1]["output"]["word_count"], 5)
            return {"content": "Created the specialist and verified its new input result.", "tool_calls": []}

        events = []
        completed = self.manager.run_work(request, model, events.append)
        self.assertEqual(completed["status"], "completed")
        self.assertEqual([step["tool"] for step in completed["steps"]], ["build_specialist", "run_built_specialist"])
        self.assertTrue(all(step["succeeded"] for step in completed["steps"]))
        self.assertEqual(len(seen), 3)
        child = completed["steps"][0]["result"]["mission_id"]
        self.assertEqual(completed["steps"][1]["result"]["mission_id"], child)
        replay = self.manager.run_work(request, lambda *_: self.fail("Completed parent must not call a model again"))
        self.assertEqual(replay["id"], completed["id"])
        self.assertEqual(len(self.event_type(child, "artifact.committed")), 1)
        self.assertEqual(len(self.event_type(child, "execution.completed")), 1)
        self.assertEqual(self.event_type(child, "artifact.exported"), [])
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_real_parent_tool_commit_interruption_reuses_completed_child_on_resume(self):
        request = {**self.parent["request"], "request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4())}

        def model(messages, _tools):
            if not any(message["role"] == "tool" for message in messages):
                return {"content": "", "tool_calls": [{"function": {"name": "build_specialist", "arguments": SPEC}}]}
            return {"content": "Recovered the existing committed specialist.", "tool_calls": []}

        commit = self.store.commit_work_checkpoint

        def interrupt(document, expected_revision, event_type, change=None):
            if event_type == "work.tool.completed":
                raise RuntimeError("Interrupted before parent tool receipt")
            return commit(document, expected_revision, event_type, change)

        with patch.object(self.store, "commit_work_checkpoint", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "parent tool receipt"):
                self.manager.run_work(request, model)
        child = self.store.list_missions()[0]
        self.assertEqual(child["status"], "completed")
        with patch.object(self.manager, "_build", side_effect=AssertionError("Parent recovery must reuse its completed child")):
            recovered = self.manager.run_work(request, model)
        self.assertEqual(recovered["status"], "completed")
        self.assertEqual(recovered["steps"][0]["result"]["mission_id"], child["id"])
        self.assertEqual(len(self.store.list_missions()), 1)
        self.assertEqual(len(self.event_type(child["id"], "artifact.committed")), 1)
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_saved_discovery_is_bounded_paginated_and_contains_no_source_or_context(self):
        foreign = self.manager.submit(SPEC, "not-work-origin", local_authority())
        self.manager.process(1, mission_id=foreign["id"])
        first = self.build()
        second_spec = {**SPEC, "name": "Second saved specialist"}
        second = self.invoke("build_specialist", second_spec)
        self.advance("build_specialist", second_spec, second)
        original_parent = self.parent["id"]
        self.parent = self.new_parent()
        before = self.store.verify_integrity()
        with patch("foundry.work_specialists.MAX_DISCOVERY_MISSIONS", 2):
            page = self.invoke("list_built_specialists", {"limit": 20})
        self.assertEqual(page["scanned"], 2)
        self.assertEqual(page["excluded"], 1)
        self.assertEqual([item["mission_id"] for item in page["entries"]], [first["mission_id"]])
        self.assertTrue(page["coverage_limited"])
        following = self.invoke("list_built_specialists", {"limit": 1, "cursor": page["next_cursor"]})
        self.assertEqual([item["mission_id"] for item in following["entries"]], [second["mission_id"]])
        self.assertIsNone(following["next_cursor"])
        entry = page["entries"][0]
        self.assertEqual(entry["source_parent_work_id"], original_parent)
        self.assertEqual(entry["lifecycle"]["concept_stage"], "Development")
        self.assertEqual(entry["capabilities"], SPEC["capabilities"])
        self.assertNotIn("description", entry)
        self.assertNotIn("messages", json.dumps(page))
        self.assertNotIn(self.store.get_artifact(first["mission_id"])["files"]["agent.py"], json.dumps(page))
        self.assertEqual(self.store.verify_integrity(), before)
        validate_schema(page, next(item["output_schema"] for item in work_specialists.catalog() if item["name"] == "list_built_specialists"))
        with self.assertRaisesRegex(ValueError, "cursor"):
            self.invoke("list_built_specialists", {"cursor": "f" * 32})
        with self.assertRaises(ValueError):
            self.invoke("list_built_specialists", {"limit": 21})

    def test_store_discovery_retrieves_only_bounded_metadata_in_stable_order(self):
        missions = [self.manager.submit({**SPEC, "name": f"Metadata {index}"}, f"meta-{index}", local_authority()) for index in range(3)]
        page = self.store.list_missions_page(2)
        self.assertEqual(len(page["missions"]), 2)
        self.assertEqual(page["total"], 3)
        self.assertEqual(set(page["missions"][0]), {"id", "status", "created_at", "updated_at", "idempotency_key"})
        final = self.store.list_missions_page(2, page["next_cursor"])
        self.assertEqual(len(final["missions"]), 1)
        self.assertIsNone(final["next_cursor"])
        self.assertEqual([item["id"] for item in page["missions"] + final["missions"]], [item["id"] for item in missions])
        for value in (True, 0, 201):
            with self.assertRaises(ValueError):
                self.store.list_missions_page(value)

    def test_new_work_mission_discovers_and_runs_saved_specialist_without_rebuilding(self):
        built = self.build()
        original_parent = self.parent["id"]
        request = {**self.parent["request"], "request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4())}

        def model(messages, _tools):
            outputs = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
            if not outputs:
                return {"content": "", "tool_calls": [{"function": {"name": "list_built_specialists", "arguments": {"limit": 10}}}]}
            if len(outputs) == 1:
                self.assertEqual(outputs[0]["entries"][0]["mission_id"], built["mission_id"])
                return {"content": "", "tool_calls": [{"function": {"name": "run_saved_specialist", "arguments": {
                    "mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "Previously built worker handles new evidence."}}}}]}
            self.assertEqual(outputs[1]["output"]["word_count"], 6)
            return {"content": "Reused the saved specialist on new evidence."}

        with patch.object(self.manager, "_build", side_effect=AssertionError("Reuse must not create another specialist")):
            completed = self.manager.run_work(request, model)
        self.assertEqual(completed["status"], "completed")
        self.assertTrue(all(step["succeeded"] for step in completed["steps"]))
        result = completed["steps"][1]["result"]
        self.assertEqual(result["selection"]["source_parent_work_id"], original_parent)
        self.assertEqual(result["provenance"]["parent_work_id"], completed["id"])
        self.assertEqual(result["selection"]["artifact_digest"], built["artifact"]["digest"])
        self.assertEqual(len(self.store.list_missions()), 1)
        self.assertEqual(len(self.event_type(built["mission_id"], "artifact.committed")), 1)
        selections = [event for event in self.store.work_events(completed["id"]) if event["event_type"] == "work.specialist.selected"]
        self.assertEqual(len(selections), 1)
        self.assertNotIn("Previously built", json.dumps(selections[0]["data"]["change"]))
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_saved_execution_recovers_after_parent_receipt_crash_reopen_without_second_run(self):
        built = self.build()
        request = {**self.parent["request"], "request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4())}
        args = {"mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "Retain this exact result across restart."}}

        def model(messages, _tools):
            if not any(message["role"] == "tool" for message in messages):
                return {"content": "", "tool_calls": [{"function": {"name": "run_saved_specialist", "arguments": args}}]}
            return {"content": "Recovered saved specialist execution."}

        commit = self.store.commit_work_checkpoint

        def interrupt(document, revision, event_type, change=None):
            if event_type == "work.tool.completed":
                raise RuntimeError("Interrupted saved execution parent receipt")
            return commit(document, revision, event_type, change)

        with patch.object(self.store, "commit_work_checkpoint", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "saved execution"):
                self.manager.run_work(request, model)
        first = self.event_type(built["mission_id"], "execution.completed")[0]
        root = self.store.root
        self.store.close()
        self.store = CommitService(root)
        self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)
        with patch.object(self.manager, "run", side_effect=AssertionError("Saved committed output must not execute twice")):
            recovered = self.manager.run_work(request, model)
        self.assertEqual(recovered["status"], "completed")
        self.assertEqual(recovered["steps"][0]["result"]["run_id"], first["data"]["run_id"])
        self.assertEqual(len(self.event_type(built["mission_id"], "execution.completed")), 1)
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_saved_parent_selection_rejects_changed_target_input_and_tool_before_execution(self):
        first = self.build()
        next_spec = {**SPEC, "name": "Alternate saved worker"}
        second = self.invoke("build_specialist", next_spec)
        self.advance("build_specialist", next_spec, second)
        self.parent = self.new_parent()
        args = {"mission_id": first["mission_id"], "capability_id": "text.analyze", "input": {"text": "Original selected input"}}
        with patch.object(self.manager, "run", side_effect=RuntimeError("Interrupted after selection")):
            with self.assertRaisesRegex(RuntimeError, "after selection"):
                self.invoke("run_saved_specialist", args)
        self.parent = self.store.get_work(self.parent["id"])
        for tool, changed in (("run_saved_specialist", {**args, "mission_id": second["mission_id"]}),
                              ("run_saved_specialist", {**args, "input": {"text": "Changed input"}}),
                              ("build_specialist", SPEC), ("list_built_specialists", {})):
            with self.subTest(tool=tool), self.assertRaisesRegex(ValueError, "different"):
                self.invoke(tool, changed)
        result = self.invoke("run_saved_specialist", args)
        self.assertEqual(result["output"]["word_count"], 3)
        self.assertEqual(self.event_type(second["mission_id"], "execution.started"), [])
        self.assertEqual(len([event for event in self.store.work_events(self.parent["id"]) if event["event_type"] == "work.specialist.selected"]), 1)

    def test_saved_scope_rejects_foreign_unlinked_uncommitted_and_unbound_capability(self):
        built = self.build()
        origin = self.parent
        foreign = self.manager.submit(SPEC, "foreign-factory-only", local_authority())
        self.manager.process(1, mission_id=foreign["id"])
        unrecorded = self.invoke("build_specialist", {**SPEC, "name": "No committed parent step yet"})
        origin = self.store.get_work(origin["id"])
        self.parent = self.new_parent()
        args = {"mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "New scope"}}
        for mission_id in (foreign["id"], unrecorded["mission_id"], "e" * 32):
            with self.subTest(mission_id=mission_id), self.assertRaises(ValueError):
                self.invoke("run_saved_specialist", {**args, "mission_id": mission_id})
        with self.assertRaisesRegex(ValueError, "this parent"):
            self.invoke("run_built_specialist", args)
        with self.assertRaisesRegex(ValueError, "not bound"):
            self.invoke("run_saved_specialist", {**args, "capability_id": "support.triage", "input": {"subject": "Question", "body": "Account"}})
        self.assertEqual(self.event_type(built["mission_id"], "execution.started"), [])
        self.assertEqual(self.store.get_work(origin["id"]), {key: value for key, value in origin.items() if key != "receipt"})

    def test_saved_execution_stale_parent_and_cancellation_never_reanimate_work(self):
        built = self.build()
        self.parent = self.new_parent()
        old = copy.deepcopy(self.parent)
        self.advance("fixture", {}, {})
        args = {"mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "A bounded request"}}
        with self.assertRaisesRegex(ValueError, "changed"):
            self.invoke("run_saved_specialist", args, old)
        request = {**self.parent["request"], "request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4())}
        original_run = self.manager.run

        def cancel_after_execution(*positional, **keyword):
            result = original_run(*positional, **keyword)
            parent = self.store.get_work_by_request(request["request_id"])
            self.manager.cancel_work(parent["id"])
            return result

        response = {"content": "", "tool_calls": [{"function": {"name": "run_saved_specialist", "arguments": args}}]}
        with patch.object(self.manager, "run", side_effect=cancel_after_execution):
            cancelled = self.manager.run_work(request, lambda *_: response)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["steps"], [])
        self.assertEqual(len(self.event_type(built["mission_id"], "execution.completed")), 1)
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_saved_execution_recovers_child_completion_before_result_link_without_rerun(self):
        built = self.build()
        self.parent = self.new_parent()
        args = {"mission_id": built["mission_id"], "capability_id": "text.analyze", "input": {"text": "Recover one committed execution"}}
        record = self.store.record_event

        def interrupt(child, kind, data):
            if kind == "work.specialist.result.committed":
                raise RuntimeError("Interrupted saved result link")
            return record(child, kind, data)

        with patch.object(self.store, "record_event", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "saved result link"):
                self.invoke("run_saved_specialist", args)
        self.parent = self.store.get_work(self.parent["id"])
        completed = self.event_type(built["mission_id"], "execution.completed")[0]
        with patch("foundry.orchestration.run_admitted_capability", side_effect=AssertionError("Previously completed execution cannot run again")):
            recovered = self.invoke("run_saved_specialist", args)
        self.assertEqual(recovered["run_id"], completed["data"]["run_id"])
        self.assertEqual(recovered["output"], completed["data"]["output"])
        self.assertEqual(len(self.event_type(built["mission_id"], "execution.completed")), 1)

    def test_saved_discovery_excludes_packages_unavailable_to_current_validation(self):
        self.build()
        self.parent = self.new_parent()
        with patch("foundry.work_specialists.validate_pack", return_value={"passed": False, "errors": ["Runtime no longer admitted"]}):
            discovered = self.invoke("list_built_specialists", {})
        self.assertEqual(discovered["entries"], [])
        self.assertEqual(discovered["excluded"], 1)
        self.assertFalse(discovered["coverage_limited"])


if __name__ == "__main__":
    unittest.main()
