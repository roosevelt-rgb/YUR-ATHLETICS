"""Pure transition evidence gates; real receipt lookup belongs to CommitService."""
import copy
import hashlib
import unittest
from uuid import uuid4

from foundry.concept_policy import STAGES, stage_catalog, validate_successor, validate_transition


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def concept(stage="genesis"):
    return {"id": str(uuid4()), "stage": stage, "parent_id": None, "lineage": [], "revision": 3, "history_hash": digest("retained-history")}


def request(target, evidence=None, **extra):
    return {"transition_id": str(uuid4()), "to_stage": target, "evidence": evidence or [], **extra}


def plan_evidence(view, requirements):
    references, records = [], {}
    for requirement in requirements:
        reference = {"requirement": requirement, "artifact_id": str(uuid4()), "artifact_sha256": digest(requirement + " document"),
                     "receipt_hash": digest(requirement + " receipt")}
        content = ["Explicit operator requirement"] if requirement in {"domain_tags", "success_criteria", "constraint_set"} else "Documented operator plan"
        references.append(reference)
        records[requirement] = {**reference, "concept_id": view["id"], "evidence_type": "committed-plan", "facts": {"content": content}}
    return references, records


def development_evidence(view):
    shared = {"build_mission_id": "a" * 32, "artifact_digest": digest("exact-artifact"), "runtime_digest": digest("original-runtime")}
    references, records = [], {}
    for requirement in ("artifact", "build_log", "instrumentation"):
        receipt_hash = digest(requirement + " committed event")
        reference = {"requirement": requirement, "artifact_id": str(uuid4()), "artifact_sha256": shared["artifact_digest"], "receipt_hash": receipt_hash}
        facts = ({**shared, "capability_id": "construction.opc.inspect", "input_hash": digest("actual input"), "output_hash": digest("actual output")}
                 if requirement == "instrumentation" else
                 {**shared, "validation_receipt_hash": digest("build_log committed event"), "artifact_receipt_hash": digest("artifact committed event")})
        references.append(reference)
        records[requirement] = {**reference, "concept_id": view["id"], "evidence_type": "execution-receipt" if requirement == "instrumentation" else "validated-build", "facts": facts}
    return references, records


class ConceptPolicyTests(unittest.TestCase):
    def test_eight_stage_contracts_preserve_forward_path_and_detached_catalog(self):
        catalog = stage_catalog()
        self.assertEqual(tuple(item["stage"] for item in catalog), STAGES)
        self.assertEqual(catalog[5]["forward_stage"], "evolution")
        self.assertIsNone(catalog[6]["forward_stage"])
        self.assertEqual(catalog[3]["exit_artifacts"], ["eval_report", "stability_score", "known_failure_modes"])
        self.assertTrue(all(not item["available"] for item in catalog[3]["exit_evidence"]))
        catalog[0]["exit_artifacts"].append("forged")
        self.assertNotIn("forged", stage_catalog()[0]["exit_artifacts"])

    def test_documented_genesis_and_inception_can_advance_without_claiming_quality(self):
        for stage, target, requirements in (("genesis", "inception", ["thesis_statement", "name", "domain_tags"]),
                                             ("inception", "development", ["charter", "success_criteria", "constraint_set"])):
            view = concept(stage)
            refs, records = plan_evidence(view, requirements)
            decision = validate_transition(view, request(target, refs), resolve_evidence=lambda ref: records[ref["requirement"]])
            self.assertTrue(decision["allowed"], decision)
            self.assertEqual(decision["requirements"], requirements)
            self.assertEqual({item["qualification"] for item in decision["evidence"]}, {"documented_plan_only"})
            self.assertEqual((decision["expected_revision"], decision["history_hash"]), (view["revision"], view["history_hash"]))

    def test_plan_presence_boolean_empty_content_and_wrong_types_are_not_evidence(self):
        view = concept()
        refs, records = plan_evidence(view, ["thesis_statement", "name", "domain_tags"])
        for facts in ({"content": ""}, {"content": True}, {"content": []}, {"nonempty": True}, {"content": "Plan", "passed": True}):
            bad = copy.deepcopy(records)
            bad["thesis_statement"]["facts"] = facts
            decision = validate_transition(view, request("inception", refs), resolve_evidence=lambda ref: bad[ref["requirement"]])
            self.assertFalse(decision["allowed"])
            self.assertEqual(decision["missing"][0]["requirement"], "thesis_statement")
        records["domain_tags"]["facts"]["content"] = "A comma separated claim is not the typed domain tag list"
        self.assertFalse(validate_transition(view, request("inception", refs), resolve_evidence=lambda ref: records[ref["requirement"]])["allowed"])

    def test_exact_validated_build_and_real_execution_bind_development_exit(self):
        view = concept("development")
        refs, records = development_evidence(view)
        decision = validate_transition(view, request("stabilization", refs), resolve_evidence=lambda ref: records[ref["requirement"]])
        self.assertTrue(decision["allowed"], decision)
        self.assertEqual({item["qualification"] for item in decision["evidence"]}, {"validated_local_artifact_only"})
        missing = validate_transition(view, request("stabilization", refs[:2]), resolve_evidence=lambda ref: records[ref["requirement"]])
        self.assertFalse(missing["allowed"])
        self.assertEqual(missing["missing"][0]["requirement"], "instrumentation")

    def test_mixed_build_runtime_and_artifact_receipts_fail(self):
        view = concept("development")
        refs, records = development_evidence(view)
        for field, value in (("build_mission_id", "b" * 32), ("runtime_digest", digest("new-runtime")), ("artifact_digest", digest("other-artifact"))):
            bad = copy.deepcopy(records)
            bad["instrumentation"]["facts"][field] = value
            decision = validate_transition(view, request("stabilization", refs), resolve_evidence=lambda ref: bad[ref["requirement"]])
            self.assertFalse(decision["allowed"], field)
        records["build_log"]["facts"]["validation_receipt_hash"] = digest("unrelated receipt")
        self.assertFalse(validate_transition(view, request("stabilization", refs), resolve_evidence=lambda ref: records[ref["requirement"]])["allowed"])

    def test_validation_commit_and_execution_are_distinct_consistent_receipts(self):
        view = concept("development")
        refs, records = development_evidence(view)
        wrong_pair = copy.deepcopy(records)
        wrong_pair["artifact"]["facts"]["validation_receipt_hash"] = digest("different validation")
        decision = validate_transition(view, request("stabilization", refs), resolve_evidence=lambda ref: wrong_pair[ref["requirement"]])
        self.assertFalse(decision["allowed"])
        self.assertTrue(decision["errors"])
        aliased_refs = copy.deepcopy(refs)
        aliased_records = copy.deepcopy(records)
        artifact_receipt = records["artifact"]["receipt_hash"]
        aliased_refs[-1]["receipt_hash"] = artifact_receipt
        aliased_records["instrumentation"]["receipt_hash"] = artifact_receipt
        self.assertFalse(validate_transition(view, request("stabilization", aliased_refs), resolve_evidence=lambda ref: aliased_records[ref["requirement"]])["allowed"])
        same_receipt = copy.deepcopy(records)
        same_receipt["artifact"]["facts"]["validation_receipt_hash"] = artifact_receipt
        self.assertFalse(validate_transition(view, request("stabilization", refs), resolve_evidence=lambda ref: same_receipt[ref["requirement"]])["allowed"])

    def test_resolved_foreign_concept_id_hash_type_and_injected_facts_fail_closed(self):
        view = concept("development")
        refs, records = development_evidence(view)
        for key, value in (("concept_id", str(uuid4())), ("receipt_hash", digest("forged")), ("artifact_id", str(uuid4())),
                           ("artifact_sha256", digest("forged")), ("requirement", "name"), ("evidence_type", "committed-plan"), ("passed", True)):
            bad = copy.deepcopy(records)
            bad["artifact"][key] = value
            decision = validate_transition(view, request("stabilization", refs), resolve_evidence=lambda ref: bad[ref["requirement"]])
            self.assertFalse(decision["allowed"], key)

    def test_independent_stability_and_later_adapters_stay_explicitly_unavailable(self):
        called = []
        for stage, target, missing in (("stabilization", "maturation", "stability_score"),
                                        ("maturation", "monetization", "deployment"),
                                        ("monetization", "evolution", "billing_integration")):
            view = concept(stage)
            requirement_names = next(item["exit_artifacts"] for item in stage_catalog() if item["stage"] == stage)
            refs = [{"requirement": name, "artifact_id": "c" * 32, "artifact_sha256": digest("fake"), "receipt_hash": digest("fake receipt")} for name in requirement_names]
            decision = validate_transition(view, request(target, refs), resolve_evidence=lambda ref: called.append(ref) or {"passed": True, "score": .75})
            self.assertFalse(decision["allowed"])
            self.assertIn(missing, {item["requirement"] for item in decision["missing"]})
        self.assertEqual(called, [], "Unsupported proofs must not be treated as content-presence checks.")

    def test_backtracking_and_regeneration_need_reason_and_independent_failure_evidence(self):
        for stage, target, requirement in (("development", "inception", "gate_failure"),
                                            ("inception", "regeneration", "health_signal"),
                                            ("regeneration", "development", "restored_artifact_or_fork")):
            view = concept(stage)
            decision = validate_transition(view, request(target), resolve_evidence=lambda _: None)
            self.assertFalse(decision["allowed"])
            self.assertTrue(decision["errors"])
            explained = validate_transition(view, request(target, reason="Observed test failures require revisiting the scope."), resolve_evidence=lambda _: None)
            self.assertFalse(explained["allowed"])
            self.assertIn(requirement, {item["requirement"] for item in explained["missing"]})

    def test_stage_skips_same_stage_and_evolution_to_regeneration_dont_auto_progress(self):
        for stage, target in (("genesis", "development"), ("genesis", "genesis"), ("regeneration", "evolution"), ("evolution", "genesis")):
            decision = validate_transition(concept(stage), request(target), resolve_evidence=lambda _: None)
            self.assertFalse(decision["allowed"])
            self.assertTrue(decision["errors"])

    def test_resolver_failure_missing_and_oversized_content_are_missing_evidence(self):
        view = concept()
        refs, records = plan_evidence(view, ["thesis_statement", "name", "domain_tags"])
        def broken(_reference):
            raise RuntimeError("private storage diagnostic must not escape")
        for resolver in (broken, lambda _: None, lambda _: {"unexpected": "x" * 50_000}):
            decision = validate_transition(view, request("inception", refs), resolve_evidence=resolver)
            self.assertFalse(decision["allowed"])
            self.assertNotIn("private storage", str(decision))
        records["name"]["facts"]["content"] = "x" * 201
        self.assertFalse(validate_transition(view, request("inception", refs), resolve_evidence=lambda ref: records[ref["requirement"]])["allowed"])

    def test_strict_request_shapes_cannot_replace_concept_history_or_add_authority(self):
        view = concept()
        for bad in ({**request("inception"), "authority": {"passed": True}}, {**request("inception"), "history": []},
                    request("inception", [{"requirement": "name", "artifact_id": "a" * 32, "artifact_sha256": digest("x"), "receipt_hash": digest("r"), "passed": True}]),
                    request("inception", [{}] * 13), {**request("inception"), "transition_id": "not-uuid"}):
            with self.assertRaises(ValueError):
                validate_transition(view, bad, resolve_evidence=lambda _: None)
        for bad in ({**view, "history": []}, {**view, "revision": True}, {**view, "history_hash": "bad"}, {**view, "lineage": [view["id"]]}):
            with self.assertRaises(ValueError):
                validate_transition(bad, request("inception"), resolve_evidence=lambda _: None)

    def test_inputs_remain_unchanged_and_repeated_decision_is_deterministic(self):
        view = concept()
        refs, records = plan_evidence(view, ["thesis_statement", "name", "domain_tags"])
        proposed = request("inception", refs)
        before = copy.deepcopy((view, proposed, records))
        first = validate_transition(view, proposed, resolve_evidence=lambda ref: records[ref["requirement"]])
        self.assertEqual(first, validate_transition(view, proposed, resolve_evidence=lambda ref: records[ref["requirement"]]))
        first["identity"]["lineage"].append(str(uuid4()))
        self.assertEqual((view, proposed, records), before)

    def test_successor_preserves_predecessor_history_and_requires_real_maturity(self):
        ancestor = str(uuid4())
        parent = {**concept("evolution"), "parent_id": ancestor, "lineage": [ancestor]}
        original = copy.deepcopy(parent)
        proposed = {"transition_id": str(uuid4()), "successor_id": str(uuid4()), "seed_prompt": "Explore the successor without retiring the parent", "evidence": []}
        decision = validate_successor(parent, proposed, resolve_evidence=lambda _: {"mature": True})
        self.assertFalse(decision["allowed"])
        self.assertEqual({item["requirement"] for item in decision["missing"]}, {"mature_concept", "successor_seeds", "lineage_record"})
        self.assertEqual(decision["successor_identity"], {"id": proposed["successor_id"], "stage": "genesis", "parent_id": parent["id"],
                                                        "lineage": [ancestor, parent["id"]], "seed_prompt": proposed["seed_prompt"]})
        self.assertEqual(parent, original)
        self.assertEqual((decision["expected_revision"], decision["history_hash"]), (parent["revision"], parent["history_hash"]))
        self.assertTrue(validate_successor(concept("development"), proposed, resolve_evidence=lambda _: None)["errors"])
        for successor_id in (parent["id"], ancestor):
            with self.assertRaises(ValueError):
                validate_successor(parent, {**proposed, "successor_id": successor_id}, resolve_evidence=lambda _: None)


if __name__ == "__main__":
    unittest.main()
