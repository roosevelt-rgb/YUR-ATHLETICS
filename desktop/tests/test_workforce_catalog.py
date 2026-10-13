import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from foundry.workforce_catalog import WorkforceCatalog

GENOME = '''class Authority:
    APPROVE = "APPROVE"
    ABSTAIN = "ABSTAIN"
class Scope:
    INTERNAL = "internal"
class Stage:
    EMBRYO = "embryo"
    MATURE = "mature"
class Genome:
    code: str
    name: str
    lineage: str = "fixture.genesis"
    version: str = "0.1.0"
    default_authority: Authority = Authority.ABSTAIN
    max_authority: Authority = Authority.APPROVE
    rate_limit_per_min: int = 60
    burst: int = 10
    memory_budget_mb: int = 512
    receptors: list = field(default_factory=list)
    cytokines: list = field(default_factory=list)
class Superagent:
    pass
'''


def agent(code="fixture", name="Fixture Specialist", body="return {'ok': True, 'proposal': sig.get('intent')}"):
    return f'''"""A fixture source profile with meaningful behavior."""
from ..genome import Genome, Scope, Superagent, EndpointAffinity
from ._common import gated_handle
class Worker(Superagent):
    def __init__(self):
        super().__init__(Genome(code={code!r}, name={name!r}, description="FIXTURE_PROFILE_SOURCE",
            affinities=[EndpointAffinity("fixture:inspect", Scope.INTERNAL, 0.2, "Inspect input")],
            receptors=["inspect.request"], cytokines=["inspection.ready"]))
    async def handle(self, sig):
        action = sig.get("action", "inspect.request")
        if action == "inspect.request":
            {body}
        return await gated_handle(self, sig, self.handle)
def register_me():
    return Worker()
'''


class WorkforceCatalogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.put("genome.py", GENOME)
        self.put("registry.py", "def register(agent): pass\n")
        self.put("dispatch_map.py", "def dispatch_signal(signal): pass\n")
        self.put("docs/README.md", "# Fixture workforce\nSource evidence only.\n")
        self.put("agents/fixture.py", agent())

    def put(self, relative, content):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return target

    def test_catalog_preserves_real_genome_behavior_and_source_identity(self):
        result = WorkforceCatalog(self.root).catalog()
        self.assertEqual(result["total_profiles"], 1)
        profile = result["entries"][0]
        self.assertEqual(profile["code"], "fixture")
        self.assertEqual(profile["name"], "Fixture Specialist")
        self.assertEqual(profile["lineage"], "fixture.genesis")
        self.assertEqual(profile["affinities"][0]["risk"], "internal")
        self.assertEqual(profile["actions"], ["inspect.request"])
        self.assertIn("intent", profile["input_fields"])
        self.assertIn("local-transform-or-proposal", profile["classification"])
        self.assertEqual(profile["lifecycle"]["initial_stage"], "embryo")
        self.assertFalse(profile["execution_admitted"])
        self.assertEqual(profile["default_authority"], "ABSTAIN")
        self.assertEqual(len(result["identity"]["source_files"]), 4)

    def test_top_level_tripwires_are_never_executed_and_selected_source_is_complete(self):
        marker = self.root / "must-not-exist.txt"
        source = f"from pathlib import Path\nPath({str(marker)!r}).write_text('EXECUTED')\nraise RuntimeError('do not import')\n" + agent()
        path = self.put("agents/fixture.py", source)
        expected = hashlib.sha256(path.read_bytes()).hexdigest()
        library = WorkforceCatalog(self.root)
        profile = library.catalog()["entries"][0]
        result = library.acquire(profile["code"], expected)
        self.assertFalse(marker.exists())
        self.assertEqual(result["content"], path.read_bytes().decode("utf-8"))
        self.assertEqual(result["profile"]["sha256"], expected)
        self.assertEqual(result["provenance"]["mode"], "read-only")

    def test_changed_source_invalid_hash_and_traversal_are_rejected(self):
        library = WorkforceCatalog(self.root)
        digest = library.catalog()["entries"][0]["sha256"]
        self.put("agents/fixture.py", agent(name="Changed profile"))
        with self.assertRaisesRegex(ValueError, "changed since selection"):
            library.acquire("fixture", digest)
        for code, digest in (("../fixture", "a" * 64), ("fixture", None), ("fixture", "bad")):
            with self.subTest(code=code), self.assertRaises(ValueError):
                library.acquire(code, digest)

    def test_dynamic_genome_and_credential_content_never_enter_the_catalog(self):
        self.put("agents/dynamic.py", agent("dynamic").replace("name='Fixture Specialist'", "name=resolve_name()"))
        self.put("agents/unsafe.py", agent("unsafe") + '\napi_key="SECRET_CREDENTIAL_MARKER"\n')
        self.put("agents/renamed.py", agent("mismatched"))
        result = WorkforceCatalog(self.root).catalog()
        self.assertEqual(result["total_profiles"], 1)
        self.assertEqual(len(result["excluded"]), 3)
        self.assertNotIn("SECRET_CREDENTIAL_MARKER", json.dumps(result))

    def test_scan_does_not_read_state_nested_scripts_or_private_files(self):
        self.put("data/state.json", "PRIVATE_STATE")
        self.put("agents/.env", "PRIVATE_ENV")
        self.put("agents/credentials.py", "PRIVATE_CREDENTIALS")
        self.put("agents/nested/ignored.py", agent("ignored"))
        from foundry.sources import read_checked
        observed = []

        def read(root, relative, maximum):
            observed.append(relative)
            return read_checked(root, relative, maximum)

        with patch("foundry.workforce_catalog.read_checked", side_effect=read):
            WorkforceCatalog(self.root).catalog()
        self.assertEqual(set(observed), {"genome.py", "registry.py", "dispatch_map.py", "docs/README.md", "agents/fixture.py"})

    def test_reparse_ancestor_rejected_and_linked_agent_excluded(self):
        actual = Path.lstat

        def reparse_file(path, *args, **kwargs):
            if path == self.root / "agents/fixture.py":
                return SimpleNamespace(st_mode=0o100644, st_file_attributes=0x400)
            return actual(path, *args, **kwargs)

        with patch.object(Path, "lstat", reparse_file):
            self.assertEqual(WorkforceCatalog(self.root).catalog()["total_profiles"], 0)

        def reparse_ancestor(path, *args, **kwargs):
            if path == self.root:
                return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
            return actual(path, *args, **kwargs)

        with patch.object(Path, "lstat", reparse_ancestor), self.assertRaisesRegex(ValueError, "reparse"):
            WorkforceCatalog(self.root)

    def test_source_authorities_and_tool_dependencies_remain_declarations(self):
        source = agent("controller", body="self.enter_apoptosis(); return call(tool='bash', params={})")
        self.put("agents/controller.py", source)
        profile = WorkforceCatalog(self.root).catalog("controller")["entries"][0]
        self.assertIn("legacy-lifecycle-controller", profile["classification"])
        self.assertIn("substrate-adapter", profile["classification"])
        self.assertEqual(profile["dependencies"]["substrate_tools"], ["bash"])
        self.assertFalse(profile["execution_admitted"])

    def test_only_quantity_profile_with_real_survey_function_gets_candidate_binding(self):
        self.put("agents/hatch_quantity.py", agent("hatch_quantity") + "\ndef _survey(plans, specs, scope): return {'line_items': []}\n")
        self.put("agents/hatch_cost.py", agent("hatch_cost"))
        entries = WorkforceCatalog(self.root).catalog("hatch")["entries"]
        by_code = {entry["code"]: entry for entry in entries}
        self.assertEqual(by_code["hatch_quantity"]["capability_candidate"]["id"], "workforce.hatch.quantity")
        self.assertNotIn("capability_candidate", by_code["hatch_cost"])
        self.assertFalse(by_code["hatch_quantity"]["execution_admitted"])

    def test_pagination_and_search_validation_are_bounded(self):
        self.put("agents/second.py", agent("second", "Another profile"))
        library = WorkforceCatalog(self.root)
        first = library.catalog(limit=1)
        self.assertEqual(first["next_offset"], 1)
        self.assertEqual(len(library.catalog(offset=1)["entries"]), 1)
        self.assertEqual(library.catalog("Another")["entries"][0]["code"], "second")
        for arguments in ({"query": "x" * 201}, {"limit": True}, {"limit": 51}, {"offset": -1}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                library.catalog(**arguments)

    def test_bridge_reports_exact_admission_counts_and_does_not_admit_changed_source(self):
        from foundry import workforce_bridge
        source = agent("hatch_quantity") + "\ndef _survey(plans, specs, scope): return {'line_items': []}\n"
        source_path = self.put("agents/hatch_quantity.py", source)
        digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
        with patch.object(workforce_bridge, "ADMITTED_SOURCE_SHA256", digest):
            result = workforce_bridge.catalog({"root": str(self.root)})
            self.assertEqual(result["availability"], {"listed_profiles": 2, "context_profiles": 1,
                                                    "executable_profiles": 1, "coverage_limited": False})
            by_code = {entry["code"]: entry for entry in result["entries"]}
            self.assertTrue(by_code["hatch_quantity"]["execution_admitted"])
            self.assertEqual(by_code["fixture"]["availability"], "context-only")
            self.put("agents/hatch_quantity.py", source + "\n# new revision\n")
            changed = workforce_bridge.catalog({"root": str(self.root)})
            self.assertEqual(changed["availability"]["executable_profiles"], 0)
            self.assertTrue(all(not entry["execution_admitted"] for entry in changed["entries"]))

    def test_file_count_and_source_size_limits_report_incomplete_discovery(self):
        from foundry import workforce_catalog
        self.put("agents/oversized.py", "x" * (workforce_catalog.LIMITS["source_bytes"] + 1))
        self.put("agents/third.py", agent("third"))
        with patch.object(workforce_catalog, "LIMITS", {**workforce_catalog.LIMITS, "agent_files": 2}):
            result = WorkforceCatalog(self.root).catalog()
        self.assertTrue(result["truncated"])
        self.assertEqual(result["total_profiles"], 1)
        self.assertEqual(result["excluded"][0]["path"], "agents/oversized.py")
        self.assertLess(result["source_bytes_read"], 65536)


if __name__ == "__main__":
    unittest.main()
