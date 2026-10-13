"""Real temporary-source outcomes and negative boundaries for bounded work cells."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from foundry import work_tools as tools


class WorkToolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "selected repository"
        self.root.mkdir()

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8") if isinstance(text, str) else text)
        return path

    def run_tool(self, name, arguments, root=True):
        return tools.execute_tool(name, arguments, self.root if root else None)

    def test_catalog_is_typed_and_caller_mutations_cannot_change_registry(self):
        catalog = tools.tool_catalog()
        self.assertEqual({entry["name"] for entry in catalog}, {"list_files", "read_file", "search_files", "propose_edit", "create_artifact", "create_document", "run_specialist"})
        for entry in catalog:
            self.assertFalse(entry["input_schema"]["additionalProperties"])
            self.assertFalse(entry["output_schema"]["additionalProperties"])
            self.assertFalse(entry["runtime"]["network"])
            self.assertFalse(entry["runtime"]["subprocess"])
            self.assertEqual(entry["rollback"]["behavior"], "no_durable_mutation")
        catalog[0]["input_schema"]["properties"].clear()
        self.assertIn("path", tools.tool_catalog()[0]["input_schema"]["properties"])
        specialist = next(entry for entry in tools.tool_catalog() if entry["name"] == "run_specialist")
        self.assertEqual({entry["id"] for entry in specialist["capabilities"]}, set(tools.ADMITTED_CAPABILITIES))

    def test_listing_excludes_state_secrets_and_dependencies_without_opening_contents(self):
        self.write("README.md", "# Source\n")
        self.write("src/main.py", "answer = 42\n")
        for relative in (".env", ".git/config", "credentials.json", "api_keys.py", "state.json", "agent_history.json", "database.sqlite", "runtime/file.py", "runtimes/file.py", "cache/file.py", "node_modules/file.js", "data/file.json"):
            self.write(relative, "must not be opened")
        with patch.object(tools, "read_checked", side_effect=AssertionError("Listing must not read source")):
            result = self.run_tool("list_files", {})
        self.assertEqual({entry["path"] for entry in result["entries"]}, {"README.md", "src", "src/main.py"})
        self.assertFalse(result["committed"])
        self.assertGreater(sum(result["excluded"].values()), 0)
        self.assertEqual(result["provenance"]["sources"], [])

    def test_fresh_read_preserves_bytes_bom_and_line_endings_with_provenance(self):
        target = self.write("src/main.py", b"\xef\xbb\xbf# heading\r\nvalue = 'ALPHA'\r\nprint(value)\r\n")
        first = self.run_tool("read_file", {"path": "src\\main.py", "line_start": 2, "line_end": 2})
        self.assertEqual(first["path"], "src/main.py")
        self.assertEqual(first["content"], "value = 'ALPHA'\r\n")
        self.assertEqual(first["total_lines"], 3)
        self.assertTrue(first["truncated"])
        self.assertEqual(first["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(first["provenance"]["sources"], [{"path": "src/main.py", "sha256": first["sha256"], "bytes": first["bytes"]}])
        self.write("src/main.py", "value = 'BETA'\n")
        second = self.run_tool("read_file", {"path": "src/main.py"})
        self.assertNotEqual(second["sha256"], first["sha256"])
        self.assertIn("BETA", second["content"])
        self.assertFalse(second["truncated"])

    def test_empty_file_and_requested_line_ranges_are_explicit(self):
        self.write("empty.py", "")
        result = self.run_tool("read_file", {"path": "empty.py"})
        self.assertEqual((result["line_start"], result["line_end"], result["total_lines"], result["content"]), (0, 0, 0, ""))
        self.write("lines.py", "one\ntwo\n")
        for arguments in ({"path": "lines.py", "line_start": 2, "line_end": 1}, {"path": "lines.py", "line_start": 3}, {"path": "lines.py", "line_start": 0}, {"path": "lines.py", "line_start": True}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                self.run_tool("read_file", arguments)

    def test_literal_search_returns_source_lines_and_does_not_interpret_regex(self):
        self.write("a.py", "before\nmarker.* = literal\nMARKER.* = another\n")
        self.write("src/b.py", "only markerZZ\n")
        result = self.run_tool("search_files", {"query": "marker.*"})
        self.assertEqual(len(result["matches"]), 1)
        self.assertEqual(result["matches"][0]["line"], 2)
        self.assertEqual(result["matches"][0]["text"], "marker.* = literal")
        self.assertEqual(result["files_read"], 2)
        self.assertFalse(result["truncated"])
        self.assertEqual(len(result["provenance"]["sources"]), 2)
        with self.assertRaises(ValueError):
            self.run_tool("search_files", {"query": "two\nlines"})

    def test_search_budgets_are_visible_and_long_lines_retain_the_actual_match(self):
        self.write("large.py", "x" * 4000 + "SOURCE_MARKER" + "y" * 4000)
        long = self.run_tool("search_files", {"query": "SOURCE_MARKER"})
        self.assertIn("SOURCE_MARKER", long["matches"][0]["text"])
        self.assertTrue(long["matches"][0]["text_truncated"])
        self.write("a.py", ("term\n" * 5000))
        self.write("b.py", ("term\n" * 5000))
        bounded = self.run_tool("search_files", {"query": "term", "max_matches": 2})
        self.assertEqual(len(bounded["matches"]), 2)
        self.assertTrue(bounded["truncated"])
        self.assertLessEqual(bounded["source_bytes"], tools.MAX_BYTES)

    def test_edit_proposal_preserves_original_diff_and_precondition_without_writing(self):
        original = "\ufeffanswer = 41\r\n"
        target = self.write("src/main.py", original)
        before = target.read_bytes()
        digest = hashlib.sha256(before).hexdigest()
        content = "\ufeffanswer = 42\r\n"
        result = self.run_tool("propose_edit", {"path": "src/main.py", "content": content, "expected_sha256": digest})
        proposal = result["proposal"]
        self.assertEqual(result["status"], "proposed")
        self.assertFalse(result["committed"])
        self.assertEqual(proposal["original_content"], original)
        self.assertEqual(proposal["original_sha256"], digest)
        self.assertEqual(proposal["expected_sha256"], digest)
        self.assertEqual(proposal["new_sha256"], hashlib.sha256(content.encode()).hexdigest())
        self.assertIn("--- a/src/main.py", proposal["diff"])
        self.assertIn("+\ufeffanswer = 42", proposal["diff"])
        self.assertEqual(target.read_bytes(), before)

    def test_new_edit_requires_missing_target_and_never_creates_directories(self):
        result = self.run_tool("propose_edit", {"path": "new/nested.py", "content": "answer = 42", "expected_sha256": None})
        proposal = result["proposal"]
        self.assertTrue(proposal["is_new"])
        self.assertIsNone(proposal["original_sha256"])
        self.assertEqual(proposal["original_content"], "")
        self.assertIn("--- /dev/null", proposal["diff"])
        self.assertIn("\\ No newline at end of file", proposal["diff"])
        self.assertFalse((self.root / "new").exists())
        self.write("exists.py", "original")
        for expected in (None, "a" * 64, "A" * 64, "not-a-hash"):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                self.run_tool("propose_edit", {"path": "exists.py", "content": "replacement", "expected_sha256": expected})
        with self.assertRaises(ValueError):
            self.run_tool("propose_edit", {"path": "missing.py", "content": "replacement", "expected_sha256": "a" * 64})
        self.assertEqual((self.root / "exists.py").read_text(), "original")

    def test_changed_source_invalidates_an_edit_precondition(self):
        target = self.write("file.py", "before")
        read = self.run_tool("read_file", {"path": "file.py"})
        target.write_text("after", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source changed"):
            self.run_tool("propose_edit", {"path": "file.py", "content": "replacement", "expected_sha256": read["sha256"]})

    def test_artifact_proposals_are_content_hashed_and_do_not_write_or_render(self):
        for name, media_type, content in (("report.md", "text/markdown", "# Report\nActual findings."), ("report.html", "text/html", "<h1>Report</h1><script>throw Error('not executed')</script>"), ("report.json", "application/json", '{"count":2}'), ("report.csv", "text/csv", "name,count\nSample,2\n")):
            with self.subTest(name=name):
                result = self.run_tool("create_artifact", {"name": name, "media_type": media_type, "content": content}, root=False)
                self.assertIsNone(result["root"])
                self.assertEqual(result["status"], "proposed")
                self.assertFalse(result["committed"])
                self.assertEqual(result["proposal"]["content"], content)
                self.assertEqual(result["proposal"]["sha256"], hashlib.sha256(content.encode()).hexdigest())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_artifacts_reject_media_mismatch_nested_paths_and_ambiguous_json(self):
        invalid = [("report.pdf", "application/pdf", "not a PDF"), ("report.md", "application/json", "{}"), ("nested/report.md", "text/markdown", "# X"), ("report.json", "application/json", '{"value":1,"value":2}'), ("report.json", "application/json", '{"value":NaN}'), ("report.json", "application/json", "[" * 22 + "0" + "]" * 22)]
        for name, media_type, content in invalid:
            with self.subTest(name=name, content=content), self.assertRaises(ValueError):
                self.run_tool("create_artifact", {"name": name, "media_type": media_type, "content": content}, root=False)

    def test_all_admitted_specialists_execute_actual_outcomes_without_root(self):
        cases = [
            ("text.analyze", {"text": "Fast agents build. Fast agents build."}, "word_count", 6),
            ("data.profile", {"rows": [{"id": 1}, {"id": 1}]}, "duplicate_rows", 1),
            ("support.triage", {"subject": "Outage", "body": "Production down"}, "priority", "critical"),
            ("workforce.hatch.quantity", {"plans_text": "Division 03\nConcrete 125 CY", "specs_text": "09 51 00\nGypsum 1,200 SF"}, "area_total_sf", 1200.0),
            ("construction.opc.inspect", {"text": "1 | FORM | 3 | EA | 19.95 | 60.00"}, "requires_review", True),
        ]
        for capability_id, payload, field, expected in cases:
            with self.subTest(capability_id=capability_id):
                result = self.run_tool("run_specialist", {"capability_id": capability_id, "input": payload}, root=False)
                self.assertEqual(result["output"][field], expected)
                self.assertFalse(result["committed"])
                self.assertEqual(result["provenance"]["sources"], [])
        with self.assertRaises(ValueError):
            self.run_tool("run_specialist", {"capability_id": "shell.execute", "input": {}}, root=False)
        with self.assertRaises(ValueError):
            self.run_tool("run_specialist", {"capability_id": "text.analyze", "input": {"text": "hello", "command": "execute"}}, root=False)

    def test_unknown_fields_and_model_authority_never_reach_workers(self):
        for name, arguments in (("list_files", {"root": str(self.root)}), ("list_files", {"authority": {"actions": ["write"]}}), ("read_file", {"path": "file.py", "command": "run"}), ("run_specialist", {"capability_id": "text.analyze", "input": {"text": "hello"}, "strategy": "custom"}), ("unknown", {})):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.run_tool(name, arguments)
        for name, arguments in (("list_files", {}), ("read_file", {"path": "file.py"}), ("search_files", {"query": "find"}), ("propose_edit", {"path": "file.py", "content": "x", "expected_sha256": None})):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "host-selected"):
                self.run_tool(name, arguments, root=False)

    def test_traversal_ads_devices_hidden_and_runtime_paths_are_rejected_before_reads(self):
        paths = ["../outside.py", "src/../../outside.py", "/absolute.py", "C:relative.py", "C:/absolute.py", "\\\\host\\share\\file.py", "file.py:stream", "src//file.py", "src/./file.py", "src/CON.py", "src/LPT1.txt", "src/file.py.", "src/file.py ", ".env", ".git/config", "credentials.py", "cache/file.py", "runtime/file.py", "state.json", "file.sqlite3"]
        with patch.object(tools, "read_checked", side_effect=AssertionError("Excluded path must never open")):
            for relative in paths:
                with self.subTest(relative=relative), self.assertRaises(ValueError):
                    self.run_tool("read_file", {"path": relative})
        for root in ("relative", str(Path(self.root.anchor)), str(self.root / ".." / self.root.name), str(self.root / "absent")):
            with self.subTest(root=root), self.assertRaises(ValueError):
                tools.execute_tool("list_files", {}, root)

    def test_secret_content_and_binary_data_never_escape_read_search_or_proposals(self):
        fake = 'password = "fixture-only-value"\n'
        self.write("source.py", fake)
        self.write("binary.py", b"\0binary")
        for relative in ("source.py", "binary.py"):
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                self.run_tool("read_file", {"path": relative})
        result = self.run_tool("search_files", {"query": "fixture"})
        self.assertEqual(result["matches"], [])
        self.assertNotIn("fixture-only-value", json.dumps(result))
        self.assertTrue(result["truncated"])
        for name, arguments in (("propose_edit", {"path": "new.py", "content": fake, "expected_sha256": None}), ("create_artifact", {"name": "report.md", "media_type": "text/markdown", "content": fake}), ("run_specialist", {"capability_id": "text.analyze", "input": {"text": fake}})):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "secret"):
                self.run_tool(name, arguments)

    def test_reparse_root_ancestor_and_child_are_never_followed(self):
        self.write("linked/file.py", "outside-like source")
        self.write("safe.py", "safe = True")
        original = Path.lstat

        def metadata(path, *args, **kwargs):
            if path == self.root / "linked":
                return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
            return original(path, *args, **kwargs)

        with patch.object(Path, "lstat", metadata):
            listed = self.run_tool("list_files", {})
            self.assertNotIn("linked/file.py", json.dumps(listed))
            with self.assertRaisesRegex(ValueError, "reparse"):
                self.run_tool("read_file", {"path": "linked/file.py"})

        def ancestor(path, *args, **kwargs):
            if path == self.root.parent:
                return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
            return original(path, *args, **kwargs)

        with patch.object(Path, "lstat", ancestor), self.assertRaisesRegex(ValueError, "reparse"):
            self.run_tool("list_files", {})

    def test_hard_links_are_not_proposed_as_local_independent_files(self):
        original = self.write("original.py", "original")
        linked = self.root / "linked.py"
        try:
            os.link(original, linked)
        except OSError as error:
            self.skipTest(f"Host cannot create the test-owned hard link: {error}")
        with self.assertRaisesRegex(ValueError, "Hard-linked"):
            self.run_tool("read_file", {"path": "linked.py"})
        self.assertEqual(self.run_tool("list_files", {})["entries"], [])

    def test_changed_during_read_and_oversized_sources_fail_closed(self):
        target = self.write("file.py", "original")
        reader = tools.read_checked

        def changed(root, relative, maximum):
            data = reader(root, relative, maximum)
            target.write_text("changed after read", encoding="utf-8")
            return data

        with patch.object(tools, "read_checked", changed), self.assertRaisesRegex(ValueError, "changed during"):
            self.run_tool("read_file", {"path": "file.py"})
        self.write("large.py", "x" * (tools.MAX_FILE_BYTES + 1))
        with self.assertRaises(ValueError):
            self.run_tool("read_file", {"path": "large.py"})
        with self.assertRaises(ValueError):
            self.run_tool("propose_edit", {"path": "new.py", "content": "x" * (tools.MAX_EDIT_BYTES + 1), "expected_sha256": None})
        with patch.object(tools, "run_capability", return_value={"result": "x" * tools.MAX_BYTES}), self.assertRaises(ValueError):
            self.run_tool("run_specialist", {"capability_id": "text.analyze", "input": {"text": "hello"}}, root=False)

    def test_inventory_entry_and_depth_budgets_report_incomplete_coverage(self):
        for index in range(510):
            self.write(f"file{index}.py", "source")
        result = self.run_tool("list_files", {})
        self.assertLessEqual(len(result["entries"]), 500)
        self.assertTrue(result["truncated"])
        limited = self.run_tool("list_files", {"max_entries": 2})
        self.assertEqual(len(limited["entries"]), 2)
        self.assertTrue(limited["truncated"])
        self.write("nested/a/b/c/d/e/f/hidden.py", "too deep")
        deep = self.run_tool("list_files", {"path": "nested", "depth": 5})
        self.assertTrue(deep["truncated"])
        self.assertNotIn("hidden.py", json.dumps(deep["entries"]))


if __name__ == "__main__":
    unittest.main()
