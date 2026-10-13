"""Contract and oracle-boundary checks; never execute generated or donor code."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest

from foundry import generated_contracts as contracts


def object_schema(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def contract():
    return {"schema": contracts.SCHEMA, "name": "Counter", "description": "Return the supplied count unchanged.",
            "input_schema": object_schema({"count": {"type": "integer", "minimum": 0, "maximum": 100}}),
            "output_schema": object_schema({"count": {"type": "integer", "minimum": 0, "maximum": 100}}),
            "cases": [{"id": f"count-{value}", "input": {"count": value}, "expected": {"count": value}} for value in (0, 2, 100)]}


class GeneratedContractTests(unittest.TestCase):
    def test_example_contains_literal_quantity_expectations_without_unit_mixing(self):
        path = Path(__file__).resolve().parents[1] / "examples" / "quantity-rollup.specialist.json"
        example = contracts.validate_contract(json.loads(path.read_text(encoding="utf-8")))
        cases = {case["id"]: case for case in example["cases"]}
        self.assertEqual(cases["empty"]["expected"], {"groups": [], "input_count": 0})
        self.assertEqual(cases["combine-repeated-code"]["expected"]["groups"][0]["quantity"], 11)
        self.assertEqual(cases["keep-units-separate-and-sort"]["expected"], {"groups": [
            {"code": "01", "unit": "EA", "quantity": 0}, {"code": "03", "unit": "LF", "quantity": 5},
            {"code": "03", "unit": "SF", "quantity": 10}], "input_count": 4})
        self.assertEqual(cases["sum-maximum-line-values"]["expected"]["groups"][0]["quantity"], 2000000)
        self.assertEqual(contracts.validate_input(example, {"lines": [{"code": "04", "unit": "EA", "quantity": 19}]}),
                         {"lines": [{"code": "04", "unit": "EA", "quantity": 19}]})
        for quantity in (-1, True, 1.0, 1000001):
            with self.subTest(quantity=quantity), self.assertRaises(ValueError):
                contracts.validate_input(example, {"lines": [{"code": "04", "unit": "EA", "quantity": quantity}]})

    def test_public_projection_cannot_leak_or_mutate_acceptance_cases(self):
        original = contract(); checked = contracts.validate_contract(original)
        public = contracts.public_contract(checked)
        self.assertEqual(set(public), {"name", "description", "input_schema", "output_schema"})
        self.assertNotIn("count-100", json.dumps(public))
        public["input_schema"]["properties"]["count"]["maximum"] = 1
        checked["cases"][0]["expected"]["count"] = 9
        self.assertEqual(original["input_schema"]["properties"]["count"]["maximum"], 100)
        self.assertEqual(original["cases"][0]["expected"]["count"], 0)

    def test_digest_binds_full_cases_but_not_dictionary_insertion_order(self):
        original = contract()
        expected = hashlib.sha256(json.dumps(original, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(contracts.contract_digest(original), expected)
        self.assertEqual(contracts.contract_digest(dict(reversed(list(original.items())))), expected)
        changed = deepcopy(original); changed["cases"][0]["expected"]["count"] = 1
        self.assertNotEqual(contracts.contract_digest(changed), expected)

    def test_exact_contract_fields_name_description_and_case_limits(self):
        bad = []
        for key in contract():
            value = contract(); del value[key]; bad.append(value)
        for key in ("authority", "root", "worker", "provider", "passed"):
            value = contract(); value[key] = "not admitted"; bad.append(value)
        for name in ("", " x", "x ", "x\n", "x" * 101):
            value = contract(); value["name"] = name; bad.append(value)
        for description in ("", "  ", "x" * 4001):
            value = contract(); value["description"] = description; bad.append(value)
        for cases in ([], contract()["cases"][:2], contract()["cases"] * 3):
            value = contract(); value["cases"] = cases; bad.append(value)
        value = contract(); value["schema"] = "other"; bad.append(value)
        for value in bad:
            with self.subTest(keys=list(value)), self.assertRaises(ValueError): contracts.validate_contract(value)

    def test_schema_keywords_never_silently_pass(self):
        for keyword, value in {"$ref": "local", "$schema": "unknown", "pattern": "x", "format": "date", "default": 0,
                               "anyOf": [], "allOf": [], "oneOf": [], "not": {}, "const": 2, "multipleOf": 2,
                               "exclusiveMinimum": 1, "unevaluatedProperties": False, "description": "ignored", "typo": 3}.items():
            candidate = contract(); candidate["input_schema"]["properties"]["count"][keyword] = value
            with self.subTest(keyword=keyword), self.assertRaises(ValueError): contracts.validate_contract(candidate)
        for kind in (["integer", "null"], None, "unrecognized"):
            candidate = contract(); candidate["input_schema"]["properties"]["count"]["type"] = kind
            with self.subTest(kind=kind), self.assertRaises(ValueError): contracts.validate_contract(candidate)

    def test_required_names_extra_properties_and_numeric_bounds_are_strict(self):
        bad = [object_schema({"x": {"type": "integer", "minimum": True}}),
               object_schema({"x": {"type": "integer", "minimum": 1.5}}),
               object_schema({"x": {"type": "number", "minimum": 4, "maximum": 3}}),
               {"type": "object", "properties": {}, "additionalProperties": False},
               {"type": "object", "properties": {}, "required": ["absent"], "additionalProperties": False},
               {"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x", "x"], "additionalProperties": False},
               {"type": "object", "properties": {}, "required": [], "additionalProperties": True},
               {**object_schema({"x": {"type": "integer"}}), "maxProperties": 0},
               {"type": "integer"}]
        for schema in bad:
            candidate = contract(); candidate["input_schema"] = schema
            with self.subTest(schema=schema), self.assertRaises(ValueError): contracts.validate_contract(candidate)

    def test_string_array_and_object_definition_caps_are_explicit(self):
        bad = [{"type": "string"}, {"type": "string", "maxLength": True}, {"type": "string", "maxLength": 8001},
               {"type": "string", "minLength": 2, "maxLength": 1}, {"type": "array", "items": {"type": "boolean"}},
               {"type": "array", "maxItems": 2}, {"type": "array", "maxItems": 129, "items": {"type": "boolean"}},
               {"type": "array", "minItems": 3, "maxItems": 2, "items": {"type": "boolean"}},
               object_schema({f"p{i}": {"type": "boolean"} for i in range(33)})]
        for schema in bad:
            candidate = contract(); candidate["output_schema"] = object_schema({"value": schema})
            with self.subTest(schema=schema), self.assertRaises(ValueError): contracts.validate_contract(candidate)

    def test_schema_depth_is_checked_even_for_unvisited_optional_properties(self):
        nested = {"type": "boolean"}
        for _ in range(8): nested = {"type": "array", "maxItems": 1, "items": nested}
        candidate = contract(); candidate["input_schema"]["properties"]["optional"] = nested
        with self.assertRaisesRegex(ValueError, "eight-level"): contracts.validate_contract(candidate)

    def test_enums_validate_types_bounds_and_duplicate_numeric_forms(self):
        for schema in ({"type": "integer", "enum": [True]}, {"type": "integer", "minimum": 1, "enum": [0]},
                       {"type": "number", "enum": [1, 1.0]}, {"type": "string", "maxLength": 2, "enum": ["long"]},
                       {"type": "boolean", "enum": []}, {"type": "boolean", "enum": [True, True]}):
            candidate = contract(); candidate["input_schema"]["properties"]["optional"] = schema
            with self.subTest(schema=schema), self.assertRaises(ValueError): contracts.validate_contract(candidate)

    def test_supported_scalar_and_nested_array_contracts_accept_real_values(self):
        schema = object_schema({
            "mode": {"type": "string", "maxLength": 5, "enum": ["count", "sum"]},
            "ratio": {"type": "number", "minimum": 0, "maximum": 1},
            "active": {"type": "boolean", "enum": [True, False]},
            "empty": {"type": "null", "enum": [None]},
            "labels": {"type": "array", "minItems": 0, "maxItems": 2, "items": {"type": "string", "maxLength": 6}},
        })
        candidate = contract(); candidate["input_schema"] = schema; candidate["output_schema"] = deepcopy(schema)
        candidate["cases"] = [{"id": f"ratio-{i}", "input": {"mode": "count", "ratio": value, "active": False,
                              "empty": None, "labels": ["π"]}, "expected": {"mode": "sum", "ratio": value,
                              "active": True, "empty": None, "labels": []}} for i, value in enumerate((0, 0.5, 1))]
        checked = contracts.validate_contract(candidate)
        for case in checked["cases"]:
            self.assertEqual(contracts.validate_input(checked, case["input"]), case["input"])
            self.assertEqual(contracts.validate_output(checked, case["expected"]), case["expected"])
        invalid = deepcopy(checked["cases"][0]["input"]); invalid["active"] = 0
        with self.assertRaises(ValueError): contracts.validate_input(checked, invalid)

    def test_cases_reject_reused_ids_and_ambiguous_inputs_regardless_of_expected_output(self):
        for mutation in ("id", "input", "conflict", "extra", "uppercase", "numeric"):
            candidate = contract()
            if mutation == "id": candidate["cases"][1]["id"] = candidate["cases"][0]["id"]
            elif mutation in ("input", "conflict"):
                candidate["cases"][1]["input"] = deepcopy(candidate["cases"][0]["input"])
                if mutation == "input": candidate["cases"][1]["expected"] = deepcopy(candidate["cases"][0]["expected"])
            elif mutation == "extra": candidate["cases"][0]["passed"] = True
            elif mutation == "uppercase": candidate["cases"][0]["id"] = "Case"
            else:
                candidate["input_schema"]["properties"]["count"]["type"] = "number"
                candidate["cases"][1]["input"]["count"] = -0.0
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): contracts.validate_contract(candidate)

    def test_case_expected_values_and_fresh_inputs_outputs_use_the_declared_schema(self):
        candidate = contract(); candidate["cases"][0]["expected"] = {"count": False}
        with self.assertRaises(ValueError): contracts.validate_contract(candidate)
        for value in ({}, {"count": 1, "extra": 2}, {"count": "2"}, {"count": -1}, {"count": 101}):
            for validate in (contracts.validate_input, contracts.validate_output):
                with self.subTest(value=value), self.assertRaises(ValueError): validate(contract(), value)
        value = {"count": 19}; result = contracts.validate_output(contract(), value); result["count"] = 20
        self.assertEqual(value, {"count": 19})

    def test_canonical_comparison_does_not_coerce_scalars_or_reorder_arrays(self):
        self.assertTrue(contracts.outputs_equal({"a": [1, "π"], "b": None}, {"b": None, "a": [1, "π"]}))
        for left, right in ((True, 1), (False, 0), (1, 1.0), (-0.0, 0.0), ([1, 2], [2, 1]), ("1", 1)):
            with self.subTest(left=left, right=right): self.assertFalse(contracts.outputs_equal(left, right))

    def test_non_json_cycles_numbers_unicode_controls_and_secrets_are_rejected(self):
        cycle = []; cycle.append(cycle)
        values = [float("nan"), float("inf"), -float("inf"), 2**53, {1: "bad"}, {"x": b"bytes"},
                  {"x": {1, 2}}, {"x": (1, 2)}, {"x": "\ud800"}, {"x": "\x00"}, cycle]
        for value in values:
            with self.subTest(kind=type(value).__name__), self.assertRaises(ValueError): contracts.outputs_equal(value, value)
        for text in ("sk-" + "SYNTHETIC_CANARY_" * 2, 'password="synthetic-not-a-real-password"'):
            candidate = contract(); candidate["description"] = text
            with self.assertRaisesRegex(ValueError, "Credential-like"): contracts.validate_contract(candidate)
        with self.assertRaisesRegex(ValueError, "Credential-like"):
            contracts.outputs_equal({"password": "synthetic-only"}, {"password": "synthetic-only"})

    def test_utf8_input_output_and_total_contract_byte_budgets(self):
        candidate = contract()
        text = {"type": "string", "maxLength": 8000}
        candidate["input_schema"]["properties"]["text"] = text
        candidate["output_schema"] = object_schema({"text": text, "other": text})
        for case in candidate["cases"]: case["expected"] = {"text": "ok", "other": ""}
        contracts.validate_contract(candidate)
        with self.assertRaisesRegex(ValueError, "byte budget"):
            contracts.validate_input(candidate, {"count": 1, "text": "界" * 6000})
        with self.assertRaisesRegex(ValueError, "byte budget"):
            contracts.validate_output(candidate, {"text": "界" * 7000, "other": "界" * 7000})
        for i in range(5): candidate["cases"].append({"id": f"extra-{i}", "input": {"count": i + 3}, "expected": {"text": "x" * 8000, "other": "y" * 1000}})
        for case in candidate["cases"][:3]: case["expected"] = {"text": "x" * 8000, "other": "y" * 1000}
        with self.assertRaisesRegex(ValueError, "byte budget"): contracts.validate_contract(candidate)

    def test_node_budget_and_immutable_result_are_bounded(self):
        crowded = [{f"p{i}": True for i in range(32)} for _ in range(100)]
        with self.assertRaisesRegex(ValueError, "node budget"): contracts.outputs_equal(crowded, crowded)
        original = contract(); checked = contracts.validate_contract(original)
        original["input_schema"]["properties"]["count"]["maximum"] = 9
        self.assertEqual(checked["input_schema"]["properties"]["count"]["maximum"], 100)


if __name__ == "__main__":
    unittest.main()
