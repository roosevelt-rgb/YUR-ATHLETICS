import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from foundry.copilot_library import CopilotLibrary, dispatch
from foundry.sources import read_checked


class CopilotLibraryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "package.json").write_text(json.dumps({
            "name": "awesome-copilot", "version": "1.0.0", "license": "MIT",
            "repository": {"url": "https://github.com/github/awesome-copilot.git"}}))
        (self.root / "LICENSE").write_text("MIT License\nCopyright GitHub, Inc.\n")
        self.skill = "skills/acquire-codebase-knowledge/SKILL.md"
        self.put(self.skill, "---\nname: acquire-codebase-knowledge\ndescription: 'Map an existing repository.'\n---\n# Inspect\nRead repository manifests.\n")
        self.put("agents/api-architect.agent.md", "---\nname: 'API Architect'\ntools: ['shell', 'write']\n---\n# API Architecture\nGive design guidance.\n")
        self.put("instructions/python.instructions.md", "---\ndescription: 'Python style'\napplyTo: '**/*.py'\n---\n# Python\nUse clear names.\n")

    def put(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_catalog_search_pages_and_kind_return_actual_assets(self):
        library = CopilotLibrary(self.root)
        result = library.catalog(limit=1)
        self.assertEqual(result["total_assets"], 3)
        self.assertEqual(result["next_offset"], 1)
        self.assertEqual(len(library.catalog(offset=1)["entries"]), 2)
        selection = library.catalog("codebase", kind="skill")["entries"]
        self.assertEqual([entry["path"] for entry in selection], [self.skill])
        self.assertEqual(selection[0]["description"], "Map an existing repository.")
        self.assertFalse(selection[0]["execution_admitted"])

    def test_acquire_returns_exact_instruction_content_and_evidence(self):
        raw = (self.root / self.skill).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        result = CopilotLibrary(self.root).acquire(self.skill, digest)
        self.assertEqual(result["content"], raw.decode())
        self.assertEqual(result["entry"]["sha256"], digest)
        self.assertEqual(result["provenance"]["bytes"], len(raw))
        self.assertIn("Copyright GitHub", result["license_notice"])
        self.assertIn("no tool", result["provenance"]["authority"])

    def test_changed_selected_asset_is_rejected(self):
        library = CopilotLibrary(self.root)
        digest = library.catalog("codebase")["entries"][0]["sha256"]
        self.put(self.skill, "Changed instructions")
        with self.assertRaisesRegex(ValueError, "changed since selection"):
            library.acquire(self.skill, digest)

    def test_catalog_never_reads_secrets_hooks_scripts_or_unselected_content(self):
        self.put(".env", "SECRET")
        self.put("hooks/run.md", "Run something")
        self.put("skills/acquire-codebase-knowledge/scripts/scan.py", "raise RuntimeError('do not execute')")
        self.put("skills/acquire-codebase-knowledge/references/private.md", "do not load")
        observed = []

        def read(root, relative, maximum):
            observed.append(relative)
            return read_checked(root, relative, maximum)

        with patch("foundry.copilot_library.read_checked", side_effect=read):
            library = CopilotLibrary(self.root)
            library.catalog("codebase")
        self.assertEqual(set(observed), {"package.json", "LICENSE", self.skill})

    def test_path_escape_and_unsupported_assets_are_rejected(self):
        library = CopilotLibrary(self.root)
        for invalid in ("../outside.md", ".env", "skills/acquire-codebase-knowledge/scripts/scan.py",
                        "C:/other/agents/test.agent.md", "agents/../test.agent.md", "agents\\api-architect.agent.md", None):
            with self.subTest(path=invalid), self.assertRaises(ValueError):
                library.acquire(invalid)

    def test_oversized_and_binary_instruction_content_are_rejected(self):
        library = CopilotLibrary(self.root)
        self.put("agents/huge.agent.md", "x" * 65_537)
        self.put("agents/binary.agent.md", "nul\x00bytes")
        result = library.catalog(kind="agent")
        self.assertEqual(len(result["excluded"]), 2)
        with self.assertRaises(ValueError):
            library.acquire("agents/huge.agent.md")
        with self.assertRaises(ValueError):
            library.acquire("agents/binary.agent.md")

    def test_reparse_validation_is_applied_to_selected_assets(self):
        library = CopilotLibrary(self.root)
        with patch("foundry.sources.reject_reparse", side_effect=ValueError("source reparse points are not admitted")):
            with self.assertRaisesRegex(ValueError, "reparse"):
                library.acquire(self.skill)

    def test_credential_like_bodies_are_excluded_before_returning_content(self):
        library = CopilotLibrary(self.root)
        self.put("agents/api-architect.agent.md", "# Example\napi_key = 'do-not-return-this-credential'\n")
        result = library.catalog("api")
        self.assertEqual(result["entries"], [])
        self.assertEqual(len(result["excluded"]), 1)
        self.assertNotIn("do-not-return-this-credential", json.dumps(result))
        with self.assertRaisesRegex(ValueError, "credential-like"):
            library.acquire("agents/api-architect.agent.md")

    def test_agent_tools_and_embedded_instructions_never_grant_authority(self):
        library = CopilotLibrary(self.root)
        result = library.acquire("agents/api-architect.agent.md")
        self.assertIn("tools: ['shell', 'write']", result["content"])
        self.assertFalse(result["entry"]["execution_admitted"])
        self.assertNotIn("tools", result["entry"])
        self.assertIn("no tool, shell, network or filesystem-write grants", result["provenance"]["authority"])

    def test_identity_and_request_boundaries(self):
        with self.assertRaises(ValueError):
            CopilotLibrary("relative-directory")
        for query, kind, limit, offset in (("x" * 201, "", 30, 0), ("", "hook", 30, 0),
                                          ("", "", True, 0), ("", "", 101, 0), ("", "", 30, -1)):
            with self.subTest(query=query, kind=kind, limit=limit, offset=offset), self.assertRaises(ValueError):
                CopilotLibrary(self.root).catalog(query, kind, limit, offset)
        with self.assertRaises(ValueError):
            dispatch({"command": "acquire", "root": str(self.root), "path": self.skill, "execute": True})
        result = dispatch({"command": "acquire", "root": str(self.root), "path": self.skill})
        self.assertEqual(result["entry"]["kind"], "skill")
        (self.root / "package.json").write_text('{"name":"another-library"}')
        with self.assertRaisesRegex(ValueError, "not an Awesome Copilot"):
            CopilotLibrary(self.root)


if __name__ == "__main__":
    unittest.main()
