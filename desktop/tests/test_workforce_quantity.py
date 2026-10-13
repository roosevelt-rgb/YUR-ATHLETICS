"""Fixed quantity outcomes, source fidelity, and governed standalone execution."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager, local_authority
from foundry.pack_compiler import compile_pack, validate_pack
from foundry.specialists import CapabilityRegistry, run_capability


CAPABILITY = "workforce.hatch.quantity"
SPEC = {"name": "HATCH Quantity Survey", "description": "Survey explicit quantities from operator-provided plans and specifications text.",
        "capabilities": [CAPABILITY]}
ROOT = Path(__file__).resolve().parents[1]


class WorkforceQuantityTests(unittest.TestCase):
    def survey(self, plans="", specs="", strategy="balanced"):
        return run_capability(CAPABILITY, {"plans_text": plans, "specs_text": specs}, strategy)

    def test_explicit_units_divisions_and_source_spans(self):
        payload = {"plans_text": "Division 03\r\nSlab 2,400 sq. ft\r\nConcrete 18 CY\r\nVolume 5 CF",
                   "specs_text": "09 51 00 - Finishes\nBoard 75 GSF\nTrim 42 LF\nDevices 8 EA\nSteel 3 TONS\nPaint 12 GAL\nWeight 20 LBS"}
        result = run_capability(CAPABILITY, payload)
        self.assertEqual([(item["qty"], item["unit"]) for item in result["line_items"]],
                         [(2400.0, "SF"), (18.0, "CY"), (5.0, "CF"), (75.0, "SF"), (42.0, "LF"),
                          (8.0, "EA"), (3.0, "TON"), (12.0, "GAL"), (20.0, "LBS")])
        self.assertEqual(result["area_total_sf"], 2475.0)
        self.assertEqual(result["by_division"]["Division 03"], {"SF": 2400.0, "CY": 18.0, "CF": 5.0})
        self.assertEqual(result["by_division"]["09 51 00"]["TON"], 3.0)
        for item in result["line_items"]:
            source = item["sources"][0]
            self.assertEqual(payload[source["field"]][source["start"]:source["end"]], source["text"])
            self.assertIn(source["text"], payload[source["field"]].splitlines()[source["line"] - 1])

    def test_zero_negative_and_non_quantity_text_report_empty_honestly(self):
        for plans, specs in (("", ""), ("No measured quantities supplied.", "False SF and NaN CY")):
            with self.subTest(plans=plans):
                result = self.survey(plans, specs)
                self.assertEqual(result["line_items"], [])
                self.assertEqual(result["by_division"], {})
                self.assertEqual((result["line_count"], result["area_total_sf"], result["truncated"]), (0, 0.0, False))
        result = self.survey("0 SF\n-12 CY\n\u22124 LF\n-0.5 EA")
        self.assertEqual(result["line_items"], [])
        self.assertEqual(result["excluded_quantities"], 4)

    def test_reject_partial_range_malformed_and_exponential_values(self):
        result = self.survey("1,23 SF\n1e309 SF\n1e3 SF\n10 to 12 CY\n10-12 CY\nitem12 EA\n12/24 LF\n12.3.4 SF\nnegative 8 SF\nValid .5 SF")
        self.assertEqual([(item["qty"], item["unit"]) for item in result["line_items"]], [(0.5, "SF")])
        self.assertEqual(result["excluded_quantities"], 5)

    def test_source_documents_do_not_share_heading_authority(self):
        result = self.survey("Division 03\nConcrete 12 CY", "Fill 8 CY")
        self.assertEqual([item["division"] for item in result["line_items"]], ["Division 03", "unknown"])
        self.assertEqual(result["by_division"], {"Division 03": {"CY": 12.0}, "unknown": {"CY": 8.0}})

    def test_twelve_line_heading_window_and_numeric_quantity_not_csi(self):
        inside = "Division 03\n" + "context\n" * 10 + "Concrete 12 CY"
        outside = "Division 03\n" + "context\n" * 11 + "Concrete 12 CY"
        self.assertEqual(self.survey(inside)["line_items"][0]["division"], "Division 03")
        self.assertEqual(self.survey(outside)["line_items"][0]["division"], "unknown")
        result = self.survey("Division 09\nBoard 123456 SF")
        self.assertEqual(result["line_items"][0]["division"], "Division 09")
        self.assertEqual(result["area_total_sf"], 123456.0)

    def test_exact_duplicates_collapse_without_prefix_or_quantity_rounding_collisions(self):
        prefix = "Long repeated source description " * 3
        lines = [f"{prefix}segment A 12.001 SF", f"{prefix}segment B 12.002 SF"]
        result = self.survey("\n".join([lines[0], lines[0], lines[1]]))
        self.assertEqual(result["line_count"], 2)
        self.assertEqual([item["qty"] for item in result["line_items"]], [12.001, 12.002])
        self.assertAlmostEqual(result["area_total_sf"], 24.003)
        self.assertEqual([item["sources"][0]["line"] for item in result["line_items"]], [1, 3])

    def test_one_thousand_item_limit_has_honest_totals_and_truncation(self):
        plans = "\n".join(f"Segment {index} 1 SF" for index in range(1001))
        result = self.survey(plans)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["line_items"]), 1000)
        self.assertEqual(result["line_count"], 1000)
        self.assertEqual(result["area_total_sf"], 1000.0)
        self.assertEqual(result["by_division"], {"unknown": {"SF": 1000.0}})
        self.assertEqual(result["totals_scope"], "returned_line_items")
        exact = self.survey("\n".join(f"Segment {index} 1 SF" for index in range(1000)))
        self.assertFalse(exact["truncated"])

    def test_numeric_conversion_and_aggregate_overflow_are_excluded(self):
        huge = "9" * 309
        result = self.survey(f"Invalid {huge} SF")
        self.assertEqual(result["line_count"], 0)
        self.assertEqual(result["excluded_quantities"], 1)
        finite = "1" + "0" * 308
        result = self.survey(f"Segment A {finite} SF\nSegment B {finite} SF")
        self.assertEqual(result["line_count"], 1)
        self.assertEqual(result["area_total_sf"], 1e308)
        self.assertEqual(result["excluded_quantities"], 1)
        json.dumps(result, allow_nan=False)

    def test_typed_raw_source_only_and_payload_is_not_modified(self):
        invalid = ({"plans_text": False, "specs_text": ""}, {"plans_text": "12 SF"},
                   {"plans_text": "", "specs_text": [], "scope_manifest": {}},
                   {"plans_text": "", "specs_text": "", "scope_manifest": {"area_total_sf": 999}},
                   {"plans_text": "x" * 30001, "specs_text": ""})
        for payload in invalid:
            with self.subTest(payload_keys=list(payload)), self.assertRaises(ValueError):
                run_capability(CAPABILITY, payload)
        payload = {"plans_text": "Division 03\nConcrete 25 CY", "specs_text": ""}
        before = copy.deepcopy(payload)
        outputs = [run_capability(CAPABILITY, payload, strategy) for strategy in ("balanced", "precision")]
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(payload, before)

    def test_catalog_and_package_preserve_donor_provenance_without_legacy_authority(self):
        registered = CapabilityRegistry().get(CAPABILITY)
        provenance = registered["runtime"]["provenance"]
        self.assertEqual(provenance["source_sha256"], "da68288a6d51def386e6cd909e46fa3b3a72c331cdddda05fb666a2e9de10477")
        self.assertFalse(provenance["authority_promoted"])
        self.assertEqual(registered["permissions"], [])
        for strategy in ("balanced", "precision"):
            files = compile_pack(SPEC, strategy).files
            validation = validate_pack(files)
            self.assertTrue(validation["passed"], validation)
            self.assertEqual(validation["metrics"]["fixture_count"], 2)
            manifest = json.loads(files["manifest.json"])
            self.assertEqual(manifest["capabilities"][0]["runtime"]["provenance"], provenance)
            self.assertNotIn("from ..genome import", files["runtime.py"])
            self.assertNotIn("from ._common import", files["runtime.py"])

    def test_promotion_receipt_matches_runtime_functions_and_original_identity(self):
        receipt = json.loads((ROOT / "docs/workforce-quantity-provenance.json").read_text(encoding="utf-8"))
        source = (ROOT / "foundry/specialists.py").read_text(encoding="utf-8").replace("\r\n", "\n")
        functions = {node.name: node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}
        for name, evidence in receipt["target"]["functions"].items():
            digest = hashlib.sha256(ast.get_source_segment(source, functions[name]).encode("utf-8")).hexdigest()
            self.assertEqual(digest, evidence["sha256"])
        catalog_evidence = CapabilityRegistry().get(CAPABILITY)["runtime"]["provenance"]
        self.assertEqual(catalog_evidence["source_sha256"], receipt["source"]["sha256"])
        self.assertEqual(catalog_evidence["functions"], {name: record["sha256"] for name, record in receipt["source"]["functions"].items()})

    def test_governed_mission_commits_runs_and_exports_standalone_quantity_agent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with CommitService(root / "state") as store:
                manager = OrchestrationManager(store)
                mission = manager.submit(SPEC, "hatch-quantity-e2e", local_authority())
                self.assertEqual(manager.process(1)["processed"], [mission["id"]])
                detail = manager.inspect(mission["id"])
                self.assertEqual(detail["status"], "completed")
                self.assertTrue(all(candidate["passed"] for candidate in detail["candidates"]))
                payload = {"plans_text": "Division 03\nConcrete 25 CY", "specs_text": "09 51 00\nBoard 320 SF"}
                execution = manager.run(mission["id"], CAPABILITY, payload)
                self.assertEqual(execution["output"]["area_total_sf"], 320.0)
                self.assertEqual(execution["output"]["by_division"], {"Division 03": {"CY": 25.0}, "09 51 00": {"SF": 320.0}})
                self.assertTrue(execution["receipt"])
                self.assertTrue(store.verify_integrity()["passed"])
                exported = store.export_artifact(mission["id"])
                unpacked = root / "standalone"
                with zipfile.ZipFile(exported["path"]) as bundle:
                    bundle.extractall(unpacked)
                process = subprocess.run([sys.executable, "-B", "agent.py"], cwd=unpacked,
                                         input=json.dumps({"capability": CAPABILITY, "input": payload}),
                                         text=True, capture_output=True, timeout=10)
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(json.loads(process.stdout)["result"], execution["output"])
                self.assertEqual(manager.process()["processed"], [])


if __name__ == "__main__":
    unittest.main()
