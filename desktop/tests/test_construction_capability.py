"""Quoted OPC outcomes, exact evidence, and standalone specialist admission."""
import copy
from decimal import Inexact, ROUND_DOWN, localcontext
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from foundry.pack_compiler import compile_pack, validate_pack
from foundry.specialists import CapabilityRegistry, run_capability


CAPABILITY = "construction.opc.inspect"
SPEC = {"name": "Construction OPC Inspector", "description": "Inspect quoted construction OPC rows and arithmetic with source evidence.",
        "capabilities": [CAPABILITY]}


class ConstructionCapabilityTests(unittest.TestCase):
    def inspect(self, text, strategy="balanced"):
        return run_capability(CAPABILITY, {"text": text}, strategy)

    def assert_sources(self, result, text):
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(text.encode("utf-8")).hexdigest())
        self.assertEqual(result["source"]["bytes"], len(text.encode("utf-8")))
        self.assertEqual(result["source"]["characters"], len(text))
        self.assertEqual(result["source"]["offset_unit"], "unicode-code-points")
        records = [source for row in result["line_items"] for source in row["sources"].values()]
        records += [item["source"] for item in result["excluded"]]
        for source in records:
            self.assertEqual(source["field"], "text")
            self.assertEqual(text[source["start"]:source["end"]], source["text"])
            self.assertEqual(source["line"], len(text[:source["start"]].splitlines()) + (not text[:source["start"]] or text[:source["start"]].endswith(("\n", "\r"))))

    def test_pipe_and_tab_rows_preserve_quoted_fields_and_normalize_units(self):
        text = "ITEM | DESCRIPTION | QUANTITY | UNIT | UNIT PRICE | TOTAL\r\n1.1 | CUT | 2.5 | C.Y. | $4.00 | $10.00\r\n1.2\tPipe 雪\t1,200\tL.F.\t2.25\t2,700.00"
        result = self.inspect(text)
        self.assertEqual([(r["description"], r["quantity"], r["unit"], r["unit_price"], r["stated_total"], r["arithmetic"], r["format"]) for r in result["line_items"]],
                         [("CUT", "2.5", "CY", "4.00", "10.00", "consistent", "pipe"),
                          ("Pipe 雪", "1200", "LF", "2.25", "2700.00", "consistent", "tab")])
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["excluded_count"], 0)
        self.assertEqual(result["unrecognized_lines"], 0)
        self.assertFalse(result["requires_review"])
        self.assert_sources(result, text)

    def test_adjacent_vertical_rows_keep_uppercase_descriptions_and_decimal_quantities(self):
        text = "2.5\nCUT\n625000\nC.Y.\n$1.50\n$937,500.00\n2.6\nFILL\n12.50\nCY\n$2.25\n$28.13"
        result = self.inspect(text)
        self.assertEqual([(r["item_number"], r["description"], r["quantity"], r["calculated_total"]) for r in result["line_items"]],
                         [("2.5", "CUT", "625000", "937500.00"), ("2.6", "FILL", "12.5", "28.13")])
        self.assertEqual([r["difference"] for r in result["line_items"]], ["0.00", "0.00"])
        self.assertEqual(result["candidate_count"], 2)
        self.assert_sources(result, text)

    def test_decimal_rounding_and_mismatch_do_not_assert_price_validity(self):
        result = self.inspect("1.1 | Fine fill | 0.5 | CY | $0.01 | $0.00")
        row = result["line_items"][0]
        self.assertEqual((row["calculated_total"], row["difference"], row["arithmetic"], row["rounding"]),
                         ("0.01", "-0.01", "mismatch", "ROUND_HALF_UP"))
        self.assertTrue(result["requires_review"])
        self.assertEqual(result["assessment"], "quoted_arithmetic_only")
        self.assertNotIn("approved", result)
        zero = self.inspect("1.2 | Explicit zero | 0 | EA | 0 | 0")["line_items"][0]
        self.assertEqual((zero["quantity"], zero["unit_price"], zero["stated_total"]), ("0", "0.00", "0.00"))

    def test_caller_decimal_context_cannot_change_arithmetic(self):
        text = "1.1 | CUT | 12.5 | CY | $2.25 | $28.13"
        expected = self.inspect(text)
        with localcontext() as context:
            context.prec = 3
            context.rounding = ROUND_DOWN
            context.traps[Inexact] = True
            self.assertEqual(self.inspect(text), expected)

    def test_partial_row_never_borrows_the_next_item_fields(self):
        text = "1.1\nCUT\n2.5\nCY\n$4.00\n1.2\nFILL\n3\nCY\n$2.00\n$6.00"
        result = self.inspect(text)
        self.assertEqual([r["item_number"] for r in result["line_items"]], ["1.2"])
        self.assertEqual(result["excluded_count"], 1)
        self.assertEqual(result["excluded"][0]["reason"], "malformed_fields")
        self.assertNotIn("1.2", result["excluded"][0]["source"]["text"])
        self.assertTrue(result["requires_review"])
        self.assert_sources(result, text)

    def test_unit_only_description_unknown_unit_and_vertical_unpriced_fields_require_review(self):
        for text, reason in (("1.1 | EA | 2 | EA | $3.00 | $6.00", "ambiguous_description"),
                             ("1.1\nCY\n2\nCY\n$3.00\n$6.00", "ambiguous_description"),
                             ("1.1 | CUT | 2 | mystery | $3.00 | $6.00", "unsupported_unit"),
                             ("1.1\nCUT\n2\nCY\n3.00\n6.00", "invalid_unit_price")):
            with self.subTest(text=text):
                result = self.inspect(text)
                self.assertEqual(result["line_items"], [])
                self.assertEqual(result["excluded"][0]["reason"], reason)
                self.assertTrue(result["requires_review"])

    def test_bad_grouping_negative_exponential_excess_precision_and_extremes_are_excluded(self):
        for quantity, price, total in (("1,23", "$2.00", "$246.00"), ("-2", "$2.00", "$4.00"),
                                       ("2", "-$2.00", "$4.00"), ("2", "$2.00", "($4.00)"),
                                       ("1e3", "$2.00", "$2000.00"), ("2.0000001", "$2.00", "$4.00"),
                                       ("2", "$2.001", "$4.00"), ("1000000001", "$1.00", "$1.00"),
                                       ("1", "$1000000000001.00", "$1.00"), ("9" * 200, "$1.00", "$1.00"),
                                       ("1000000000", "$1000000000000.00", "$1.00")):
            with self.subTest(quantity=quantity, price=price):
                result = self.inspect(f"1.1 | CUT | {quantity} | CY | {price} | {total}")
                self.assertEqual(result["line_items"], [])
                self.assertEqual(result["excluded_count"], 1)
                self.assertTrue(result["requires_review"])

    def test_no_supported_rows_empty_input_and_strict_source_contract(self):
        for text in ("", "Site estimate pending; no quoted quantities supplied."):
            result = self.inspect(text)
            self.assertEqual(result["line_items"], [])
            self.assertTrue(result["requires_review"])
        for payload in ({"text": False}, {"text": "", "baseline": []}, {"text": "x" * 30001}, {"text": "雪" * 25000}, {"text": "bad\x00source"}):
            with self.subTest(keys=list(payload)), self.assertRaises(ValueError):
                run_capability(CAPABILITY, payload)

    def test_oversized_units_mixed_separators_and_missing_cells_fail_closed(self):
        for text, reason in (("1.1 | CUT\textra | 2 | CY | $1.00 | $2.00", "malformed_fields"),
                             ("1.1 | CUT | 2 | " + "." * 600 + "CY | $1.00 | $2.00", "unsupported_unit"),
                             ("1.1 | CUT | | CY | $1.00 | $2.00", "malformed_fields")):
            result = self.inspect(text)
            self.assertEqual(result["line_items"], [])
            self.assertEqual(result["excluded"][0]["reason"], reason)
            self.assertTrue(result["requires_review"])
            self.assert_sources(result, text)

    def test_output_record_and_byte_limits_have_honest_omission_counts(self):
        result = self.inspect("\n".join(f"{i}.1 | CUT | 1 | CY | $1.00 | $1.00" for i in range(101)))
        self.assertEqual((len(result["line_items"]), result["candidate_count"], result["omitted_count"]), (100, 101, 1))
        self.assertTrue(result["truncated"])
        self.assertTrue(result["requires_review"])
        self.assertEqual(result["arithmetic_scope"], "returned_line_items")
        text = "\n".join(f"{i}.1 | {'雪' * 200} | 1 | CY | $1.00 | $1.00" for i in range(90))
        result = self.inspect(text)
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=True).encode()), 128 * 1024)
        self.assertGreater(result["omitted_count"], 0)
        self.assertEqual(len(result["line_items"]) + result["omitted_count"], 90)
        excluded = self.inspect("\n".join(f"{i}.1 | CUT | missing | CY | $1.00 | $1.00" for i in range(101)))
        self.assertEqual((len(excluded["excluded"]), excluded["excluded_count"], excluded["omitted_count"]), (100, 101, 1))

    def test_registry_provenance_fixed_outcomes_and_shared_strategy_are_explicit(self):
        entry = CapabilityRegistry().get(CAPABILITY)
        self.assertEqual(entry["permissions"], [])
        provenance = entry["runtime"]["provenance"]
        self.assertEqual(provenance["source_sha256"], "9e37e64eff05cd6c72be67c1b8e7f0348d3a28c04f1d231236a8da5aadc20439")
        self.assertFalse(provenance["authority_promoted"])
        self.assertIn("same", provenance["strategy_behavior"].lower())
        self.assertEqual(len(entry["fixtures"]), 4)
        for fixture in entry["fixtures"]:
            self.assertEqual(self.inspect(fixture["input"]["text"], fixture["strategy"]), fixture["expected"])
        payload = {"text": "1.1 | CUT | 2.5 | CY | $4.00 | $10.00"}
        original = copy.deepcopy(payload)
        self.assertEqual(run_capability(CAPABILITY, payload, "balanced"), run_capability(CAPABILITY, payload, "precision"))
        self.assertEqual(payload, original)

    def test_pack_validation_and_actual_standalone_execution_preserve_domain_outcome(self):
        payload = {"text": "1.1 | CUT | 2.5 | CY | $4.00 | $10.00"}
        for strategy in ("balanced", "precision"):
            files = compile_pack(SPEC, strategy).files
            self.assertEqual(files, compile_pack(SPEC, strategy).files)
            validation = validate_pack(files)
            self.assertTrue(validation["passed"], validation)
            with tempfile.TemporaryDirectory() as temporary:
                for name, content in files.items():
                    target = Path(temporary) / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")
                process = subprocess.run([sys.executable, "-B", "agent.py"], cwd=temporary,
                                         input=json.dumps({"capability": CAPABILITY, "input": payload}), text=True,
                                         capture_output=True, timeout=10)
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(json.loads(process.stdout)["result"], run_capability(CAPABILITY, payload, strategy))


if __name__ == "__main__":
    unittest.main()
