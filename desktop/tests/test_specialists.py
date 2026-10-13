"""Outcome, contract, reproducibility and adversarial package tests."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from compilers.agent_pack.adapter import AgentPackCompiler
from foundry.pack_compiler import compile_pack, validate_pack
from foundry.specialists import CapabilityRegistry, CapabilityResolver, catalog, run_capability


SPEC = {"name": "Operations Specialist", "description": "Analyze text, data and support requests.",
        "capabilities": ["text.analyze", "data.profile", "support.triage"]}


class SpecialistOutcomeTests(unittest.TestCase):
    def test_all_published_reference_outcomes(self):
        for item in catalog():
            for fixture in item["fixtures"]:
                with self.subTest(capability=item["id"], fixture=fixture["name"]):
                    self.assertEqual(run_capability(item["id"], fixture["input"], fixture["strategy"]), fixture["expected"])

    def test_text_new_input_and_phrase_boundaries(self):
        result = run_capability("text.analyze", {"text": "Blue sky. Blue sea!", "top_k": 2})
        self.assertEqual(result["word_count"], 4)
        self.assertEqual(result["sentence_count"], 2)
        self.assertEqual(result["keywords"], [{"term": "blue", "count": 2}, {"term": "sea", "count": 1}])
        phrases = run_capability("text.analyze", {"text": "Blue sky. Blue sea!"}, "precision")["keywords"]
        self.assertEqual(phrases, [{"term": "blue sea", "count": 1}, {"term": "blue sky", "count": 1}])

    def test_unicode_text(self):
        result = run_capability("text.analyze", {"text": "Café café. naïve!"})
        self.assertEqual(result["word_count"], 3)
        self.assertEqual(result["keywords"][0], {"term": "café", "count": 2})

    def test_data_empty_missing_mixed_and_duplicate(self):
        empty = run_capability("data.profile", {"rows": []})
        self.assertEqual((empty["row_count"], empty["column_count"], empty["duplicate_rows"]), (0, 0, 0))
        result = run_capability("data.profile", {"rows": [{"a": 1}, {"a": False}, {"b": None}, {"a": 1}]})
        self.assertEqual(result["duplicate_rows"], 1)
        self.assertEqual(result["columns"][0], {"name": "a", "type": "mixed", "missing_count": 1,
                                               "missing_fraction": 0.25, "distinct_count": 2})
        self.assertEqual(result["columns"][1]["type"], "unknown")

    def test_support_evidence_points_to_real_source_span(self):
        payload = {"subject": "Please correct this invoice", "body": "I was charged twice."}
        result = run_capability("support.triage", payload)
        self.assertEqual((result["category"], result["route"], result["priority"]), ("billing", "billing-support", "normal"))
        for evidence in result["evidence"]:
            self.assertEqual(payload[evidence["field"]][evidence["start"]:evidence["end"]], evidence["match"])

    def test_precision_rejects_negated_emergency(self):
        payload = {"subject": "Question", "body": "No security breach"}
        result = run_capability("support.triage", payload, "precision")
        self.assertEqual(result["priority"], "normal")
        self.assertEqual(result["category"], "general")
        self.assertTrue(result["requires_human_review"])
        self.assertEqual(result["evidence"], [])

    def test_explicit_premium_rule(self):
        result = run_capability("support.triage", {"subject": "Question", "body": "Please help", "customer_tier": "premium"})
        self.assertEqual(result["priority"], "high")
        self.assertEqual(result["evidence"][0]["rule"], "priority.premium")

    def test_inputs_are_not_modified(self):
        for item in catalog():
            payload = copy.deepcopy(item["fixtures"][0]["input"])
            before = copy.deepcopy(payload)
            run_capability(item["id"], payload)
            self.assertEqual(payload, before)


class SpecialistContractTests(unittest.TestCase):
    def test_catalog_cannot_mutate_registry(self):
        first = CapabilityRegistry().get("text.analyze")
        first["input_schema"]["properties"]["text"]["maxLength"] = 10**20
        first["permissions"].append("network")
        second = CapabilityRegistry().get("text.analyze")
        self.assertEqual(second["permissions"], [])
        self.assertEqual(second["input_schema"]["properties"]["text"]["maxLength"], 100_000)

    def test_resolver_only_exact_unique_ids(self):
        for bad in (["unknown"], ["text.analyze", "text.analyze"], [], "text.analyze", [None], ["TEXT.ANALYZE"]):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                CapabilityResolver().resolve(bad)
        self.assertIn("Explicit mission request", CapabilityResolver().resolve(["text.analyze"])[0]["selection_reason"])

    def test_strict_inputs(self):
        invalid = [
            ("text.analyze", {}), ("text.analyze", {"text": ""}), ("text.analyze", {"text": "x", "top_k": True}),
            ("text.analyze", {"text": "x", "top_k": 0}), ("text.analyze", {"text": "x", "unknown": 1}),
            ("text.analyze", {"text": "x" * 100_001}),
            ("data.profile", {"rows": [{"x": float("nan")}]}), ("data.profile", {"rows": [{"x": float("inf")}]}),
            ("data.profile", {"rows": [{"x": {"nested": "object"}}]}), ("data.profile", {"rows": [{}] * 2001}),
            ("data.profile", {"rows": [{index: "not string"} for index in range(3)]}),
            ("support.triage", {"subject": "x", "body": "x", "customer_tier": "admin"}),
            ("support.triage", {"subject": "x"}),
        ]
        for cid, payload in invalid:
            with self.subTest(capability=cid, keys=list(payload)), self.assertRaises(ValueError):
                run_capability(cid, payload)

    def test_combined_column_limit(self):
        with self.assertRaises(ValueError):
            run_capability("data.profile", {"rows": [{f"a{i}": 1} for i in range(101)]})

    def test_unknown_dispatch(self):
        with self.assertRaises(ValueError):
            run_capability("shell.execute", {"command": "whoami"})
        with self.assertRaises(ValueError):
            run_capability("text.analyze", {"text": "hello"}, "unbounded")


class SpecialistPackTests(unittest.TestCase):
    def test_reproducible_compilation_and_both_strategies(self):
        for strategy in ("balanced", "precision"):
            with self.subTest(strategy=strategy):
                files = compile_pack(SPEC, strategy).files
                self.assertEqual(files, compile_pack(copy.deepcopy(SPEC), strategy).files)
                self.assertEqual(files, compile_pack({**SPEC, "capabilities": list(reversed(SPEC["capabilities"]))}, strategy).files)
                result = validate_pack(files)
                self.assertTrue(result["passed"], result)
                self.assertEqual(result["metrics"]["fixture_count"], 3)
                self.assertEqual(result["metrics"]["fixture_pass_rate"], 1.0)
        self.assertNotEqual(compile_pack(SPEC).files, compile_pack(SPEC, "precision").files)

    def test_unknown_malformed_and_extra_spec_fields(self):
        for spec in ({**SPEC, "capabilities": ["unknown"]}, {**SPEC, "name": "  "}, {**SPEC, "name": "x\nInjected"},
                     {**SPEC, "deploy": True}, {**SPEC, "capabilities": []}, {"name": "Missing fields"}):
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                compile_pack(spec)

    def test_adapter_proposes_without_commit(self):
        result = AgentPackCompiler().compile({"spec": SPEC, "strategy": "precision"}, trace_id="T-test")
        self.assertEqual(result["status"], "validated_candidate")
        self.assertEqual(result["trace_id"], "T-test")
        self.assertTrue(result["validation"]["passed"])
        self.assertNotIn("committed", result)

    def test_reject_tampered_runtime_even_with_recomputed_hashes(self):
        files = compile_pack(SPEC).files
        files["runtime.py"] += "\nraise RuntimeError('untrusted code must never run')\n"
        attestation = json.loads(files["attestation.json"])
        attestation["files"]["runtime.py"] = hashlib.sha256(files["runtime.py"].encode()).hexdigest()
        files["attestation.json"] = json.dumps(attestation, indent=2, sort_keys=True) + "\n"
        result = validate_pack(files)
        self.assertFalse(result["passed"])
        self.assertIn("trusted reconstruction mismatch: runtime.py", result["errors"])

    def test_long_lived_process_rejects_source_drift_before_compilation_or_validation(self):
        files = compile_pack(SPEC).files
        original_read = Path.read_text

        def drifted_read(path, *args, **kwargs):
            source = original_read(path, *args, **kwargs)
            if path.name == "specialists.py":
                return source + "\nraise RuntimeError('new disk code must never be packaged or executed')\n"
            return source

        with patch.object(Path, "read_text", autospec=True, side_effect=drifted_read), \
                patch("foundry.runtime_admission.AdmittedRuntime.run") as execute:
            with self.assertRaisesRegex(ValueError, "runtime source changed"):
                compile_pack(SPEC)
            result = validate_pack(files)
            self.assertFalse(result["passed"])
            self.assertTrue(any("runtime source changed" in error for error in result["errors"]))
            self.assertEqual(result["metrics"]["fixtures_passed"], 0)
            execute.assert_not_called()
        # No source was edited. A valid package remains accepted after the mock.
        self.assertTrue(validate_pack(files)["passed"])

    def test_missing_runtime_source_fails_closed_before_fixture_execution(self):
        files = compile_pack(SPEC).files
        with patch.object(Path, "read_text", side_effect=FileNotFoundError("simulated unavailable release")), \
                patch("foundry.runtime_admission.AdmittedRuntime.run") as execute:
            with self.assertRaisesRegex(ValueError, "runtime source is unavailable"):
                compile_pack(SPEC)
            result = validate_pack(files)
            self.assertFalse(result["passed"])
            self.assertTrue(any("runtime source is unavailable" in error for error in result["errors"]))
            execute.assert_not_called()

    def test_reject_false_outcome_fixture(self):
        files = compile_pack(SPEC).files
        fixture = json.loads(files["tests/fixtures.json"])
        fixture["cases"][0]["expected"] = {"fake": "passed"}
        files["tests/fixtures.json"] = json.dumps(fixture)
        result = validate_pack(files)
        self.assertFalse(result["passed"])
        self.assertTrue(any("fixture" in error for error in result["errors"]))

    def test_reject_malformed_fixture_and_metadata(self):
        for name, replacement in (("tests/fixtures.json", "[]"), ("attestation.json", "null"),
                                  ("manifest.json", "[]"), ("manifest.json", '{"name":"a","name":"b"}'),
                                  ("manifest.json", "NaN")):
            files = compile_pack(SPEC).files
            files[name] = replacement
            with self.subTest(file=name):
                self.assertFalse(validate_pack(files)["passed"])

    def test_reject_invented_bindings(self):
        files = compile_pack(SPEC).files
        manifest = json.loads(files["manifest.json"])
        manifest["bindings"]["text.analyze"] = "exec"
        files["manifest.json"] = json.dumps(manifest)
        self.assertFalse(validate_pack(files)["passed"])

    def test_reject_unsafe_missing_unknown_binary_and_oversized_files(self):
        original = compile_pack(SPEC).files
        cases = [None, {}, {**original, "../escape.py": "x"}, {**original, "C:/escape.py": "x"},
                 {**original, "tests\\fixtures.json": "x"}, {**original, "unknown.txt": "x"},
                 {key: value for key, value in original.items() if key != "agent.py"},
                 {**original, "runtime.py": b"binary"}, {**original, "runtime.py": "x" * 5_000_001}]
        for files in cases:
            with self.subTest(kind=type(files).__name__):
                self.assertFalse(validate_pack(files)["passed"])

    def test_standalone_generated_agent_executes_new_input_and_enforces_binding(self):
        spec = {"name": "Text Specialist", "description": "Text outcomes", "capabilities": ["text.analyze"]}
        files = compile_pack(spec).files
        self.assertTrue(validate_pack(files)["passed"])
        with tempfile.TemporaryDirectory(prefix="yur-specialist-") as directory:
            for name, content in files.items():
                target = Path(directory) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            success = subprocess.run([sys.executable, "-B", str(Path(directory) / "agent.py")],
                                     input=json.dumps({"capability": "text.analyze", "input": {"text": "New useful input."}}),
                                     capture_output=True, text=True, timeout=10, check=False)
            self.assertEqual(success.returncode, 0, success.stderr)
            self.assertEqual(json.loads(success.stdout)["result"]["word_count"], 3)
            denied = subprocess.run([sys.executable, "-B", str(Path(directory) / "agent.py")],
                                    input=json.dumps({"capability": "data.profile", "input": {"rows": []}}),
                                    capture_output=True, text=True, timeout=10, check=False)
            self.assertEqual(denied.returncode, 1)
            self.assertFalse(json.loads(denied.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
