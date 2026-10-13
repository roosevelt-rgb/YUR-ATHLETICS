"""Real durable actions must not become false rejection on lost acknowledgments."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager, local_authority
from foundry.work_engine import AUTHORITY
from foundry.work_store import now
from foundry import work_cells, work_specialists


SPEC = {"name": "Acknowledged worker", "description": "Retain actual output once.", "capabilities": ["text.analyze"]}


def request(mode="work", root=None):
    return {"request_id": str(uuid.uuid4()), "conversation_id": str(uuid.uuid4()), "mode": mode,
            "goal": "Retain exact specialist results and receipts.", "root": root,
            "provider": "ollama", "model": "fixture", "messages": [{"role": "user", "content": "Retain exact results."}]}


def call(name, arguments):
    return {"content": "", "tool_calls": [{"function": {"name": name, "arguments": arguments}}]}


def outcome(snapshot):
    text = "Checked the exact fixture snapshot"
    return {"schema": "yur.execution-cell-result.v1", "snapshot_id": snapshot["id"], "profile": snapshot["profile"],
            "status": "completed", "exit_code": 0, "stdout": text, "stderr": "", "stdout_bytes": len(text.encode()),
            "stderr_bytes": 0, "stdout_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "stderr_sha256": hashlib.sha256(b"").hexdigest(), "duration_ms": 1,
            "runtime": {"test_adapter": True}, "limits": {}, "scratch": "discarded"}


class WorkAcknowledgmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = CommitService(Path(self.temp.name) / "journal"); self.addCleanup(self.store.close)
        self.manager = OrchestrationManager(self.store)

    def final_after_results(self, count, callback=None):
        calls = []
        def model(messages, _catalog):
            results = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
            self.assertEqual(len(results), count, "Pending operation must recover before asking the provider")
            self.assertTrue(all(item["committed"] for item in results))
            if callback:
                callback(results)
            calls.append(results)
            return {"content": "The retained operation was acknowledged."}
        return model, calls

    def interrupted(self, req, model):
        with self.assertRaises(RuntimeError):
            self.manager.run_work(req, model)
        failed = self.store.get_work_by_request(req["request_id"])
        self.assertEqual(failed["status"], "failed")
        return failed

    def test_build_ack_errors_before_and_after_receipt_preserve_one_published_child(self):
        for error_type in (ValueError, OSError):
            for after_commit in (False, True):
                with self.subTest(error=error_type.__name__, after_commit=after_commit):
                    req = request(); original = self.store.record_event
                    def interrupted_record(mid, kind, data):
                        if kind == work_specialists._COMPLETED:
                            if after_commit:
                                original(mid, kind, data)
                            raise error_type("Injected lost build acknowledgment")
                        return original(mid, kind, data)
                    with patch.object(self.store, "record_event", side_effect=interrupted_record):
                        failed = self.interrupted(req, lambda *_: call("build_specialist", SPEC))
                    self.assertEqual(failed["steps"], [])
                    pending = work_specialists.pending_call(self.manager, failed)
                    self.assertEqual(pending, call("build_specialist", SPEC)["tool_calls"][0])
                    key = f"work.specialist:{failed['id']}:0"
                    child = self.store.get_mission_by_key(key)
                    artifact = self.store.get_artifact(child["id"])
                    self.assertIsNotNone(artifact)
                    generation_count = sum(event["event_type"] == "cell.started" for event in self.store.events(child["id"]))
                    model, calls = self.final_after_results(1)
                    completed = self.manager.run_work(req, model)
                    self.assertEqual((completed["status"], len(completed["steps"]), len(calls)), ("completed", 1, 1))
                    self.assertEqual(self.store.get_artifact(child["id"]), artifact)
                    events = self.store.events(child["id"])
                    self.assertEqual(sum(event["event_type"] == "cell.started" for event in events), generation_count)
                    self.assertEqual(sum(event["event_type"] == work_specialists._COMPLETED for event in events), 1)
                    self.assertEqual(sum(event["event_type"] == work_specialists._REQUEST for event in self.store.work_events(completed["id"])), 1)
                    entries = work_specialists.list_saved_specialists(self.manager, {})["entries"]
                    self.assertIn(child["id"], [entry["mission_id"] for entry in entries])
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_execution_ack_errors_after_actual_run_recover_without_reexecuting(self):
        for error_type in (ValueError, OSError):
            with self.subTest(error=error_type.__name__):
                req = request(); original = self.manager.run
                def model(messages, _catalog):
                    results = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
                    if not results:
                        return call("build_specialist", SPEC)
                    self.assertEqual(len(results), 1)
                    return call("run_built_specialist", {"mission_id": results[0]["mission_id"], "capability_id": "text.analyze", "input": {"text": "Exact fresh text."}})
                def interrupted_run(*args, **kwargs):
                    original(*args, **kwargs)
                    raise error_type("Injected lost actual execution acknowledgment")
                with patch.object(self.manager, "run", side_effect=interrupted_run):
                    failed = self.interrupted(req, model)
                self.assertEqual(len(failed["steps"]), 1)
                child_id = failed["steps"][0]["result"]["mission_id"]
                before = [event for event in self.store.events(child_id) if event["event_type"] == "execution.completed"]
                self.assertEqual(len(before), 1)
                resumed, calls = self.final_after_results(2, lambda results: self.assertEqual(results[1]["run_id"], before[0]["data"]["run_id"]))
                completed = self.manager.run_work(req, resumed)
                self.assertEqual((completed["status"], len(calls)), ("completed", 1))
                self.assertEqual([event for event in self.store.events(child_id) if event["event_type"] == "execution.completed"], before)

    def test_child_submission_and_acceptance_ack_loss_never_orphan_queued_work(self):
        for boundary in ("submission", "acceptance"):
            for error_type in (ValueError, OSError):
                with self.subTest(boundary=boundary, error=error_type.__name__):
                    req = request(); before = len(self.store.list_missions())
                    if boundary == "submission":
                        original = self.manager.submit
                        def interrupted_submit(*values, **options):
                            original(*values, **options)
                            raise error_type("Actual child submitted before acknowledgment loss")
                        patched = patch.object(self.manager, "submit", side_effect=interrupted_submit)
                    else:
                        original = self.store.record_event
                        def interrupted_accept(mid, kind, data):
                            event = original(mid, kind, data)
                            if kind == work_specialists._ACCEPTED:
                                raise error_type("Actual child acceptance committed before acknowledgment loss")
                            return event
                        patched = patch.object(self.store, "record_event", side_effect=interrupted_accept)
                    with patched:
                        failed = self.interrupted(req, lambda *_: call("build_specialist", SPEC))
                    self.assertEqual(failed["steps"], [])
                    self.assertEqual(work_specialists.pending_call(self.manager, failed)["function"]["arguments"], SPEC)
                    child = self.store.get_mission_by_key(f"work.specialist:{failed['id']}:0")
                    self.assertEqual(child["status"], "queued")
                    self.assertIsNone(self.store.get_artifact(child["id"]))
                    self.assertEqual(sum(event["event_type"] == work_specialists._ACCEPTED for event in self.store.events(child["id"])), 0 if boundary == "submission" else 1)
                    model, calls = self.final_after_results(1, lambda results: self.assertEqual(results[0]["mission_id"], child["id"]))
                    completed = self.manager.run_work(req, model)
                    self.assertEqual((completed["status"], len(calls)), ("completed", 1))
                    self.assertEqual(len(self.store.list_missions()), before + 1)
                    events = self.store.events(child["id"])
                    self.assertEqual(sum(event["event_type"] == work_specialists._ACCEPTED for event in events), 1)
                    self.assertEqual(sum(event["event_type"] == "artifact.committed" for event in events), 1)
                    self.assertEqual(sum(event["event_type"] == "cell.started" for event in events), 2)
                    self.assertIn(child["id"], [entry["mission_id"] for entry in work_specialists.list_saved_specialists(self.manager, {})["entries"]])

    def test_terminal_failed_child_without_artifact_is_a_finite_rejection(self):
        req = request(); calls = []
        def model(messages, _catalog):
            results = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
            if not results:
                return call("build_specialist", SPEC)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["status"], "rejected")
            self.assertFalse(results[0]["committed"])
            self.assertIn("did not pass publication", results[0]["error"])
            calls.append(results)
            return {"content": "Independent validation failed, so no worker was published."}
        with patch("foundry.orchestration.validate_pack", return_value={"passed": False, "errors": ["Known fixture rejection"]}):
            completed = self.manager.run_work(req, model)
        child = self.store.list_missions()[0]
        self.assertEqual((child["status"], completed["status"], len(calls)), ("failed", "completed", 1))
        self.assertIsNone(self.store.get_artifact(child["id"]))
        self.assertIsNone(work_specialists.pending_call(self.manager, completed))
        self.manager.run_work(req, lambda *_: self.fail("A completed rejection must not retry"))
        self.assertEqual(len(self.store.list_missions()), 1)

    def test_request_commit_precedes_child_submit_and_replay_uses_exact_args(self):
        req = request()
        with patch.object(self.manager, "submit", side_effect=OSError("No child submission occurred")):
            # The accepted request alone is not an actual published result. This
            # definite pre-publication failure can be rejected without a claim.
            results = []
            def model(messages, _catalog):
                outputs = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
                if not outputs:
                    return call("build_specialist", SPEC)
                results.extend(outputs)
                return {"content": "The worker was not published."}
            completed = self.manager.run_work(req, model)
        self.assertFalse(results[0]["committed"])
        self.assertEqual(self.store.list_missions(), [])
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(sum(event["event_type"] == work_specialists._REQUEST for event in self.store.work_events(completed["id"])), 1)

        req = request()
        with patch.object(self.manager, "submit", side_effect=RuntimeError("Process interrupted before child submission")):
            failed = self.interrupted(req, lambda *_: call("build_specialist", SPEC))
        self.assertEqual(work_specialists.pending_call(self.manager, failed)["function"]["arguments"], SPEC)
        resumed, _calls = self.final_after_results(1)
        result = self.manager.run_work(req, resumed)
        self.assertEqual(result["steps"][0]["arguments"], SPEC)
        self.assertEqual(len(self.store.list_missions()), 1)

    def test_precommit_invalid_run_is_rejected_without_uncertain_acknowledgment(self):
        req = request(); count = 0
        def model(messages, _catalog):
            nonlocal count
            count += 1
            if count == 1:
                return call("run_built_specialist", {"mission_id": "z" * 32, "capability_id": "text.analyze", "input": {"text": "test"}})
            return {"content": "Invalid identity was rejected."}
        result = self.manager.run_work(req, model)
        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["steps"][0]["result"]["committed"])
        self.assertFalse(any(event["event_type"] == work_specialists._REQUEST for event in self.store.work_events(result["id"])))

    def test_lost_parent_request_acknowledgment_retains_exact_input_before_child_work(self):
        for error_type in (ValueError, OSError):
            with self.subTest(error=error_type.__name__):
                req = request(); original = self.store.commit_work_checkpoint
                before = len(self.store.list_missions())
                def commit_then_interrupt(document, revision, kind, change=None):
                    committed = original(document, revision, kind, change)
                    if kind == work_specialists._REQUEST:
                        raise error_type("Request saved but acknowledgment lost")
                    return committed
                with patch.object(self.store, "commit_work_checkpoint", side_effect=commit_then_interrupt):
                    failed = self.interrupted(req, lambda *_: call("build_specialist", SPEC))
                self.assertEqual(len(self.store.list_missions()), before)
                self.assertEqual(failed["steps"], [])
                with self.assertRaisesRegex(ValueError, "different input"):
                    work_specialists.check_step_binding(self.manager, failed, "build_specialist", {**SPEC, "name": "Changed"})
                self.assertEqual(work_specialists.pending_call(self.manager, failed)["function"]["arguments"], SPEC)
                resumed, _calls = self.final_after_results(1)
                self.manager.run_work(req, resumed)
                self.assertEqual(len(self.store.list_missions()), before + 1)

    def test_saved_run_replays_original_input_then_consumes_queued_correction(self):
        seed_request = request()
        def seed_model(messages, _catalog):
            return ({"content": "Worker built."} if any(message["role"] == "tool" for message in messages)
                    else call("build_specialist", SPEC))
        built_work = self.manager.run_work(seed_request, seed_model)
        child_id = built_work["steps"][0]["result"]["mission_id"]
        artifact = self.store.get_artifact(child_id)
        req = request()
        args = {"mission_id": child_id, "capability_id": "text.analyze", "input": {"text": "Original exact saved-worker input."}}
        correction = "After recording that accepted run, explain the retained evidence."
        correction_id = str(uuid.uuid4()); original = self.manager.run
        def run_queue_and_interrupt(*values, **options):
            original(*values, **options)
            parent = self.store.get_work_by_request(req["request_id"])
            with CommitService(self.store.root) as writer:
                writer.queue_work_steering(parent["id"], req["conversation_id"], correction_id, correction)
            raise OSError("Saved execution completed before acknowledgment")
        with patch.object(self.manager, "run", side_effect=run_queue_and_interrupt):
            failed = self.interrupted(req, lambda *_: call("run_saved_specialist", args))
        self.assertEqual(failed["steps"], [])
        self.assertEqual(work_specialists.pending_call(self.manager, failed)["function"]["arguments"], args)
        with self.assertRaisesRegex(ValueError, "different input"):
            work_specialists.check_step_binding(self.manager, failed, "run_saved_specialist", {**args, "input": {"text": "Changed"}})
        executions = [event for event in self.store.events(child_id) if event["event_type"] == "execution.completed"]
        calls = []
        def resumed(messages, _catalog):
            outputs = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0]["run_id"], executions[0]["data"]["run_id"])
            self.assertEqual(outputs[0]["selection"]["source_parent_work_id"], built_work["id"])
            self.assertEqual(messages[-1], {"role": "user", "content": correction})
            calls.append(1)
            return {"content": "Accepted output retained, correction incorporated."}
        with patch("foundry.orchestration.run_admitted_capability", side_effect=AssertionError("An acknowledged saved run must not execute twice")):
            completed = self.manager.run_work(req, resumed)
        self.assertEqual((len(calls), completed["status"], completed["steps"][0]["arguments"]), (1, "completed", args))
        self.assertEqual(self.store.get_artifact(child_id), artifact)
        self.assertEqual(len(self.store.list_missions()), 1)
        self.assertEqual([event for event in self.store.events(child_id) if event["event_type"] == "execution.completed"], executions)
        self.assertEqual(self.store.work_steering_state(completed["id"])[0]["status"], "consumed")

    def test_stop_after_publication_keeps_receipts_and_never_resumes_cancelled_work(self):
        req = request(); original = self.manager.process_locked_child
        def publish_then_cancel(child_id):
            result = original(child_id)
            parent = self.store.get_work_by_request(req["request_id"])
            self.manager.cancel_work(parent["id"])
            return result
        with patch.object(self.manager, "process_locked_child", side_effect=publish_then_cancel):
            cancelled = self.manager.run_work(req, lambda *_: call("build_specialist", SPEC))
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["steps"], [])
        child = self.store.list_missions()[0]
        artifact = self.store.get_artifact(child["id"])
        self.assertIsNotNone(artifact)
        events = self.store.events(child["id"])
        self.assertEqual(sum(event["event_type"] == work_specialists._COMPLETED for event in events), 1)
        with patch.object(self.manager, "process_locked_child", side_effect=AssertionError("Cancelled Work cannot resume")):
            result = self.manager.run_work(req, lambda *_: self.fail("Cancelled Work called a provider"))
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(self.store.events(child["id"]), events)
        self.assertEqual(self.store.get_artifact(child["id"]), artifact)

    def test_legacy_child_receipt_does_not_invent_an_unretained_run_payload(self):
        parent = self.store.submit_work(request(), AUTHORITY)
        document = {key: value for key, value in parent.items() if key not in {"revision", "receipt"}}
        document.update(status="running", updated_at=now())
        parent = self.store.commit_work(document, parent["revision"], "work.started", {})
        with self.store.acquire_worker():
            key = f"work.specialist:{parent['id']}:0"
            child = self.manager.submit(SPEC, key, local_authority())
            work_specialists._accept(self.manager, parent, child, key, "run_built_specialist", "a" * 64)
        self.assertIsNone(work_specialists.pending_call(self.manager, parent))
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_cell_ack_errors_after_committed_result_replay_without_runner_or_source_read(self):
        project = Path(self.temp.name) / "source"; project.mkdir()
        source = project / "sample.py"; source.write_text("value=42\n", encoding="utf-8")
        args = {"files": ["sample.py"], "profile": "python-compile-serial", "test_directory": ".", "proposal_ids": []}
        for error_type in (ValueError, OSError):
            with self.subTest(error=error_type.__name__):
                req = request("code", str(project)); original = work_cells._record
                def interrupted_record(manager, parent, kind, change):
                    event = original(manager, parent, kind, change)
                    if kind == work_cells.RESULT:
                        raise error_type("Injected lost cell acknowledgment")
                    return event
                with patch.object(work_cells, "_record", side_effect=interrupted_record), patch("foundry.execution_cell.run_snapshot", side_effect=lambda snapshot, **kwargs: outcome(snapshot)) as runner:
                    failed = self.interrupted(req, lambda *_: call(work_cells.TOOL, args))
                self.assertEqual(runner.call_count, 1)
                self.assertEqual(failed["steps"], [])
                source.write_text("changed source is deliberately invalid", encoding="utf-8")
                before = [event for event in self.store.work_events(failed["id"]) if event["event_type"] == work_cells.RESULT]
                resumed, calls = self.final_after_results(1)
                with patch("foundry.execution_cell.run_snapshot", side_effect=AssertionError("Committed cell must not rerun")):
                    completed = self.manager.run_work(req, resumed)
                self.assertEqual((completed["status"], len(calls)), ("completed", 1))
                self.assertEqual([event for event in self.store.work_events(failed["id"]) if event["event_type"] == work_cells.RESULT], before)
                self.assertEqual(completed["steps"][0]["result"]["execution"]["stdout"], "Checked the exact fixture snapshot")
        self.assertTrue(self.store.verify_integrity()["passed"])

    def test_snapshot_ack_loss_recovers_original_source_before_executing_once(self):
        project = Path(self.temp.name) / "source"; project.mkdir()
        source = project / "sample.py"
        args = {"files": ["sample.py"], "profile": "python-compile-serial", "test_directory": ".", "proposal_ids": []}
        original_text = "value=42\n"
        for error_type in (ValueError, OSError):
            with self.subTest(error=error_type.__name__):
                source.write_bytes(original_text.encode("utf-8"))
                req = request("code", str(project)); original = work_cells._record
                def commit_then_interrupt(manager, parent, kind, change):
                    event = original(manager, parent, kind, change)
                    if kind == work_cells.SNAPSHOT:
                        raise error_type("Snapshot committed before lost acknowledgment")
                    return event
                with patch.object(work_cells, "_record", side_effect=commit_then_interrupt), patch("foundry.execution_cell.run_snapshot", side_effect=AssertionError("Snapshot not acknowledged yet")) as runner:
                    failed = self.interrupted(req, lambda *_: call(work_cells.TOOL, args))
                self.assertEqual(runner.call_count, 0)
                self.assertEqual(failed["steps"], [])
                self.assertEqual(work_cells.pending_call(self.manager, failed)["function"]["arguments"], args)
                snapshots = [event for event in self.store.work_events(failed["id"]) if event["event_type"] == work_cells.SNAPSHOT]
                self.assertEqual(len(snapshots), 1)
                source.write_text("changed source must not replace the committed snapshot", encoding="utf-8")
                def run_original(snapshot, **_kwargs):
                    self.assertEqual(snapshot["files"][0]["content"], original_text)
                    self.assertEqual(snapshot["files"][0]["sha256"], hashlib.sha256(original_text.encode()).hexdigest())
                    return outcome(snapshot)
                model, calls = self.final_after_results(1)
                with patch("foundry.execution_cell.run_snapshot", side_effect=run_original) as runner:
                    completed = self.manager.run_work(req, model)
                self.assertEqual((completed["status"], runner.call_count, len(calls)), ("completed", 1, 1))
                self.assertEqual([event for event in self.store.work_events(failed["id"]) if event["event_type"] == work_cells.SNAPSHOT], snapshots)
                self.assertEqual(sum(event["event_type"] == work_cells.RESULT for event in self.store.work_events(failed["id"])), 1)
                self.assertEqual(source.read_text(encoding="utf-8"), "changed source must not replace the committed snapshot")

    def test_snapshot_record_error_before_commit_remains_finite_rejection(self):
        project = Path(self.temp.name) / "source"; project.mkdir()
        (project / "sample.py").write_text("value=42\n", encoding="utf-8")
        args = {"files": ["sample.py"], "profile": "python-compile-serial", "test_directory": ".", "proposal_ids": []}
        for error_type in (ValueError, OSError):
            with self.subTest(error=error_type.__name__):
                req = request("code", str(project)); original = work_cells._record
                def reject_before_record(manager, parent, kind, change):
                    if kind == work_cells.SNAPSHOT:
                        raise error_type("Snapshot was not committed")
                    return original(manager, parent, kind, change)
                def model(messages, _catalog):
                    outputs = [json.loads(message["content"]) for message in messages if message["role"] == "tool"]
                    if not outputs:
                        return call(work_cells.TOOL, args)
                    self.assertFalse(outputs[0]["committed"])
                    return {"content": "No snapshot or check was committed."}
                with patch.object(work_cells, "_record", side_effect=reject_before_record), patch("foundry.execution_cell.run_snapshot", side_effect=AssertionError("Uncommitted snapshot cannot execute")):
                    completed = self.manager.run_work(req, model)
                self.assertEqual(completed["status"], "completed")
                self.assertFalse(any(event["event_type"] == work_cells.SNAPSHOT for event in self.store.work_events(completed["id"])))
                self.assertIsNone(work_cells.pending_call(self.manager, completed))


if __name__ == "__main__":
    unittest.main()
