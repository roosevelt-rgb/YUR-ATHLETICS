import json
import hashlib
import tempfile
import unittest
from pathlib import Path

from foundry.hermes_library import HermesLibrary, dispatch
from scripts.import_hermes_skills import build_snapshot


class HermesLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.active = base / "active"
        self.optional = base / "optional"
        self.package = base / "package"
        self.snapshot = base / "snapshot"
        self.package.mkdir()
        (self.package / "pyproject.toml").write_text('[project]\nname = "hermes-agent"\nversion = "0.18.2"\nlicense = "MIT"\n', encoding="utf-8")
        (self.package / "LICENSE").write_text("MIT License\nfixture\n", encoding="utf-8")
        self.put(self.active, "research/source-review/SKILL.md", "---\nname: source-review\ndescription: Review exact source evidence.\nversion: 1.2.3\nlicense: MIT\nplatforms: [windows, linux]\n---\n# Source review\nUse the selected evidence.\n")
        self.put(self.active, "research/source-review/scripts/check.py", "api_key = 'abcdefghijklmnop'\nprint('never automatically execute')\n")
        self.put(self.active, "research/source-review/.usage.json", '{"private_runtime_state": true}')
        self.put(self.active, "research/DESCRIPTION.md", "# Research package\n")
        self.put(self.optional, "mcp/fastmcp/SKILL.md", "---\nname: fastmcp\ndescription: Build an MCP server.\nversion: 1.0.0\nlicense: MIT\nplatforms: [windows]\n---\n# FastMCP\nCreate a typed server.\n")
        self.put(self.optional, "mcp/fastmcp/references/api.md", "# API\nReference material only.\n")
        self.catalog = build_snapshot(self.active, self.optional, self.package, self.snapshot, False)

    @staticmethod
    def put(root: Path, relative: str, content: str):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def test_imports_active_optional_and_support_with_redaction(self):
        self.assertEqual(self.catalog["counts"]["skills"], 2)
        self.assertEqual(self.catalog["counts"]["support_files"], 2)
        self.assertEqual(self.catalog["counts"]["package_files"], 1)
        self.assertTrue((self.snapshot / "package/active/research/DESCRIPTION.md").is_file())
        self.assertEqual(self.catalog["counts"]["redacted_files"], 1)
        self.assertFalse((self.snapshot / "skills/research/source-review/.usage.json").exists())
        admitted = (self.snapshot / "skills/research/source-review/scripts/check.py").read_text()
        self.assertIn("REDACTED_CREDENTIAL_LIKE_VALUE", admitted)
        self.assertNotIn("abcdefghijklmnop", admitted)
        manifest = next(item for item in self.catalog["files"] if item["path"].endswith("check.py"))
        self.assertNotEqual(manifest["sha256"], manifest["source_sha256"])
        self.assertEqual(manifest["redactions"], 1)

    def test_catalog_searches_lanes_and_acquire_verifies_every_support(self):
        library = HermesLibrary(self.snapshot)
        page = library.catalog("server", "optional", 30, 0)
        self.assertEqual(page["total_skills"], 2)
        self.assertEqual(page["total_matches"], 1)
        self.assertEqual(page["entries"][0]["name"], "fastmcp")
        selected = library.catalog("source-review")["entries"][0]
        acquired = library.acquire(selected["path"], selected["sha256"])
        self.assertEqual(acquired["entry"]["support_files"], 1)
        self.assertEqual(len(acquired["support_assets"]), 1)
        self.assertEqual(acquired["provenance"]["operation"], "hermes.instructions.acquired")
        self.assertIn("Foundry, OrchestrationManager, Validation and Commit Service", acquired["provenance"]["authority"])
        (self.snapshot / acquired["support_assets"][0]["path"]).write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "support asset changed"):
            library.acquire(selected["path"], selected["sha256"])

    def test_dispatch_rejects_unmanifested_paths_and_changed_skill_hash(self):
        selected = dispatch({"command": "catalog", "root": str(self.snapshot), "query": "fastmcp", "lane": "", "limit": 30, "offset": 0})["entries"][0]
        with self.assertRaisesRegex(ValueError, "exact skill"):
            dispatch({"command": "acquire", "root": str(self.snapshot), "path": "skills/mcp/fastmcp/references/api.md", "expected_sha256": selected["sha256"]})
        skill = self.snapshot / selected["path"]
        skill.write_text(skill.read_text() + "\nchanged\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "changed after"):
            dispatch({"command": "acquire", "root": str(self.snapshot), "path": selected["path"], "expected_sha256": selected["sha256"]})

    def test_catalog_rejects_manifest_identity_tampering(self):
        catalog_path = self.snapshot / "catalog.json"
        data = json.loads(catalog_path.read_text())
        data["snapshot_id"] = "0" * 64
        catalog_path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "identity does not match"):
            HermesLibrary(self.snapshot)


_HERMES_SNAPSHOT = Path(__file__).resolve().parents[1] / "integrations" / "hermes_skills"


@unittest.skipUnless((_HERMES_SNAPSHOT / "v1").is_dir() or (_HERMES_SNAPSHOT / "v1.bundle.zip").is_file(),
                     "the Hermes skill snapshot is imported locally (scripts/import_hermes_skills.py) and not published")
class HermesBundledSnapshotTests(unittest.TestCase):
    def test_every_versioned_asset_and_skill_is_hash_verified(self):
        root = Path(__file__).resolve().parents[1] / "integrations" / "hermes_skills" / "v1"
        bundle = root.parent / "v1.bundle.zip"
        unpacked = root.is_dir()
        library = HermesLibrary(root if unpacked else bundle)
        catalog = library.catalog_data
        self.assertEqual(catalog["identity"]["version"], "0.18.2")
        self.assertEqual(catalog["snapshot_id"], "659bf95db24b6e8407f1c5c674fdf548b300b037a70c6769c278dff26699ea39")
        self.assertEqual(catalog["counts"], {"skills": 177, "files": 978, "support_files": 774, "package_files": 27,
                                             "redacted_files": 69, "redactions": 222,
                                             "excluded_files": 0, "bytes": 12818365})
        self.assertEqual(sum(skill["source_lane"] == "active" for skill in catalog["skills"]), 75)
        self.assertEqual(sum(skill["source_lane"] == "optional" for skill in catalog["skills"]), 102)
        skill_ids = {skill["id"] for skill in catalog["skills"]}
        self.assertTrue({"autonomous-ai-agents/hermes-cli-branding", "creative/yur-console-theming",
                         "software-development/yur-ecosystem-navigation", "mcp/fastmcp"} <= skill_ids)
        for manifest in catalog["files"]:
            if unpacked:
                path = root / manifest["path"]
                self.assertFalse(path.is_symlink(), manifest["path"])
                data = path.read_bytes()
            else:
                # Source releases carry the validated bundle rather than its extracted donor tree.
                data = library._read(manifest["path"], manifest["bytes"])
            self.assertEqual(len(data), manifest["bytes"], manifest["path"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), manifest["sha256"], manifest["path"])
            self.assertFalse(manifest["execution_admitted"])
        for skill in catalog["skills"]:
            acquired = library.acquire(skill["path"], skill["sha256"])
            self.assertEqual(acquired["entry"]["support_files"], len(acquired["support_assets"]))
            self.assertFalse(acquired["entry"]["execution_admitted"])
        bundled = HermesLibrary(bundle)
        self.assertEqual(bundled.catalog_data["snapshot_id"], catalog["snapshot_id"])
        fastmcp = bundled.catalog("fastmcp", "optional")["entries"][0]
        self.assertEqual(bundled.acquire(fastmcp["path"], fastmcp["sha256"])["entry"]["id"], "mcp/fastmcp")


if __name__ == "__main__":
    unittest.main()
