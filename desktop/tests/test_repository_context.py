import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from foundry import repository_context as context


class RepositoryContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "selected user's repo"
        self.root.mkdir()

    def write(self, relative, text):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target

    def request(self, question="Explain this repository"):
        return {"root": str(self.root), "question": question, "authority": dict(context.AUTHORITY)}

    def test_acquires_actual_content_and_question_selected_source(self):
        self.write("README.md", "# Sample product\nThe entry point is src/main.py.\n")
        self.write("src/main.py", "def main():\n    return 'ACTUAL_SOURCE_MARKER'\n")
        for index in range(30):
            self.write(f"src/module{index}.py", f"value = {index}\n")
        target = self.write("src/user's handler.py", "def reconcile():\n    return 'QUESTION_SELECTED_MARKER'\n")
        result = context.acquire_context(self.request('How does "user\'s handler.py" reconcile requests?'))
        by_path = {file["path"]: file for file in result["files"]}
        selected = by_path["src/user's handler.py"]
        self.assertEqual(result["root"], str(self.root.resolve()))
        self.assertEqual(result["access"], "read-only")
        self.assertEqual(selected["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(selected["total_lines"], 2)
        self.assertIn("QUESTION_SELECTED_MARKER", json.dumps(selected))
        self.assertEqual(list(by_path), ["src/user's handler.py"])
        overview = context.acquire_context(self.request())
        self.assertIn("ACTUAL_SOURCE_MARKER", json.dumps(overview["files"]))
        self.assertIn("README.md", [file["path"] for file in overview["files"]])
        self.assertTrue(overview["truncated"]["files"])

    def test_excluded_directories_and_sensitive_filenames_never_open(self):
        self.write("src/allowed.py", "answer = 42\n")
        excluded = [".env", "config.local.json", "credentials.json", "api_keys.py", "state.json.db", "agent_state.json", "session_history.json", "private_notes.txt",
                    ".git/hidden.py", "node_modules/hidden.py", "archive/hidden.py", "build/hidden.py",
                    "logs/hidden.py", "state/hidden.py", "cache/hidden.py"]
        for name in excluded:
            self.write(name, "DO_NOT_OPEN")
        scanned, opened = [], []
        actual_scan, actual_read = os.scandir, context.read_checked

        def scan(path):
            scanned.append(Path(path).relative_to(self.root).as_posix())
            return actual_scan(path)

        def read(root, relative, maximum):
            opened.append(relative)
            return actual_read(root, relative, maximum)

        with patch.object(context.os, "scandir", scan), patch.object(context, "read_checked", read):
            result = context.acquire_context(self.request())
        self.assertEqual(opened, ["src/allowed.py"])
        self.assertEqual(set(scanned), {".", "src"})
        self.assertEqual(result["inventory"], ["src/allowed.py"])

    def test_authority_shape_roots_and_traversal_fail_closed(self):
        for root in ("relative", str(Path(self.root.anchor)), str(self.root / ".." / self.root.name), str(self.root / "missing")):
            request = self.request()
            request["root"] = root
            with self.subTest(root=root), self.assertRaises(ValueError):
                context.acquire_context(request)
        for change in ({"authority": {}}, {"authority": {**context.AUTHORITY, "actions": ["read", "write"]}}, {"extra": True}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                context.acquire_context({**self.request(), **change})
        with self.assertRaises(ValueError):
            context.acquire_context(self.request("x" * context.LIMITS["input_bytes"]))

    def test_reparse_root_ancestor_and_child_are_never_followed(self):
        self.write("linked/hidden.py", "EXTERNAL_MARKER")
        self.write("safe.py", "safe = True")
        actual_lstat = Path.lstat

        def fake_metadata(path, *args, **kwargs):
            if path == self.root / "linked":
                return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
            return actual_lstat(path, *args, **kwargs)

        with patch.object(Path, "lstat", fake_metadata):
            result = context.acquire_context(self.request())
        self.assertNotIn("linked/hidden.py", result["inventory"])
        self.assertEqual(result["excluded"]["unavailable_or_reparse"], 1)

        def fake_ancestor(path, *args, **kwargs):
            if path == self.root.parent:
                return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
            return actual_lstat(path, *args, **kwargs)

        with patch.object(Path, "lstat", fake_ancestor), self.assertRaisesRegex(ValueError, "reparse"):
            context.acquire_context(self.request())

    def test_inline_credentials_and_binary_text_are_omitted(self):
        markers = ["INLINE_PASSWORD_MARKER", "sk-" + "Z" * 30, "-----BEGIN PRIVATE KEY-----"]
        self.write("src/settings.py", 'password = "' + markers[0] + '"')
        self.write("src/provider.py", 'value = "' + markers[1] + '"')
        self.write("src/certificate.md", markers[2] + "\nprivate material")
        self.write("src/binary.py", "before\0after")
        self.write("src/okay.py", 'api_key = os.environ.get("SERVICE_TOKEN")\n')
        result = context.acquire_context(self.request())
        serialized = json.dumps(result)
        for marker in markers:
            self.assertNotIn(marker, serialized)
        self.assertEqual(result["excluded"]["secret_content"], 3)
        self.assertEqual(result["excluded"]["binary_content"], 1)
        self.assertEqual([file["path"] for file in result["files"]], ["src/okay.py"])

    def test_budgets_report_omissions_and_actual_excerpt_bytes(self):
        for index in range(20):
            self.write(f"src/item{index:02}.py", "# relevant search term " + ("a" * 480) + "\n" + ("line = 1\n" * 400))
        self.write("too_big.py", "x" * (context.LIMITS["file_bytes"] + 1))
        limits = {**context.LIMITS, "nodes": 12, "directories": 3, "inventory": 7, "files_read": 3, "source_bytes": 12000, "excerpt_bytes": 600}
        with patch.object(context, "LIMITS", limits):
            result = context.acquire_context(self.request("relevant search term"))
        self.assertLessEqual(result["usage"]["nodes"], 12)
        self.assertLessEqual(result["usage"]["directories"], 3)
        self.assertLessEqual(result["usage"]["files_read"], 3)
        self.assertLessEqual(result["usage"]["source_bytes"], 12000)
        self.assertLessEqual(sum(len(excerpt["text"].encode()) for file in result["files"] for excerpt in file["excerpts"]), 600)
        self.assertLessEqual(len(result["inventory"]), 7)
        self.assertTrue(result["truncated"]["inventory_scan"])
        self.assertTrue(result["truncated"]["inventory"])
        self.assertTrue(result["truncated"]["excerpts"])
        self.assertGreater(result["omitted"]["unread_candidates"], 0)

    def test_excerpts_have_real_line_numbers_and_prioritize_source_matches(self):
        source = "\n".join(["ordinary content"] * 80 + ["def specialist_launch():", "    return 'LATE_MATCH'"])
        self.write("src/main.py", source)
        result = context.acquire_context(self.request("Explain specialist_launch"))
        for excerpt in result["files"][0]["excerpts"]:
            self.assertEqual(excerpt["text"], "\n".join(source.splitlines()[excerpt["start_line"] - 1:excerpt["end_line"]]))
        self.assertIn("LATE_MATCH", json.dumps(result["files"]))

    def test_depth_and_directory_limits_do_not_enumerate_descendants(self):
        self.write("src/deep/further/hidden.py", "NOT_WITHIN_DEPTH")
        self.write("src/main.py", "visible = True")
        with patch.object(context, "LIMITS", {**context.LIMITS, "depth": 1}):
            result = context.acquire_context(self.request())
        self.assertNotIn("NOT_WITHIN_DEPTH", json.dumps(result))
        self.assertEqual(result["usage"]["directories"], 2)
        self.assertEqual(result["excluded"]["depth_limit"], 1)
        with patch.object(context, "LIMITS", {**context.LIMITS, "directories": 1}):
            result = context.acquire_context(self.request())
        self.assertEqual(result["files"], [])
        self.assertTrue(result["omitted"]["unknown_descendants"])

    def test_root_mention_does_not_rank_nested_name_matches_above_the_app(self):
        self.write("README.md", "Repository identity\n")
        self.write("package.json", '{"main":"src/main.js"}')
        self.write("src/main.js", "function startApplication() {}\n")
        for index in range(20):
            self.write(f"tools/selected/user/repo/module{index}/index.js", "nested = true;\n")
        result = context.acquire_context(self.request(str(self.root) + " can you read this repo"))
        paths = [file["path"] for file in result["files"]]
        self.assertEqual(paths[:3], ["package.json", "README.md", "src/main.js"])

    def test_cli_emits_one_json_envelope_without_writing_repository_state(self):
        self.write("main.py", "value = 'CLI_CONTEXT_MARKER'\n")
        before = set(self.root.rglob("*"))
        process = subprocess.run([sys.executable, "-B", "-m", "foundry.repository_context"], input=json.dumps(self.request()).encode(), capture_output=True, cwd=Path(__file__).resolve().parents[1], timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        response = json.loads(process.stdout)
        self.assertTrue(response["ok"])
        self.assertIn("CLI_CONTEXT_MARKER", json.dumps(response["result"]))
        self.assertEqual(before, set(self.root.rglob("*")))
        self.assertEqual(process.stderr, b"")

    def test_bootstrap_modes_return_separate_bounded_contexts(self):
        self.write("README.md", "# Bootstrap fixture\n")
        self.write("package.json", '{"name":"bootstrap-fixture"}')
        self.write("src/main.py", "BOOTSTRAP_SOURCE_MARKER = True\n")
        second = Path(self.temporary.name) / "second folder"
        second.mkdir()
        (second / "README.md").write_text("# Second folder\n", encoding="utf-8")
        (second / "main.py").write_text("SECOND_BOOTSTRAP_MARKER = True\n", encoding="utf-8")
        request = {"roots": [str(self.root), str(second)], "question": "Compare these folders", "bootstrap": "federation", "authority": dict(context.AUTHORITY)}
        result = context.acquire_bootstrap(request)
        self.assertEqual(result["schema"], "yur.repository-bootstrap.v1")
        self.assertEqual(result["bootstrap"], "federation")
        self.assertEqual(result["usage"]["roots_read"], 2)
        self.assertEqual([item["root"] for item in result["contexts"]], [str(self.root.resolve()), str(second.resolve())])
        folder = context.acquire_bootstrap({**request, "roots": [str(self.root)], "bootstrap": "folder"})
        self.assertEqual(folder["contexts"][0]["selection"]["bootstrap"], "folder")
        self.assertIn("BOOTSTRAP_SOURCE_MARKER", json.dumps(folder))
        with self.assertRaises(ValueError):
            context.acquire_bootstrap({**request, "roots": [str(self.root), str(second)], "bootstrap": "repo"})

    def test_explicit_root_manifest_never_reads_nested_same_basename(self):
        root_manifest = json.dumps({"name": "actual-root-app", "main": "src/main.js"}, indent=2)
        self.write("package.json", root_manifest)
        self.write("cognition-engine/package.json", '{"name":"other-app","main":"wrong.js"}')
        self.write("tools/demo/package.json", '{"name":"demo","main":"also-wrong.js"}')
        self.write("package-lock.json", '{"lockfileVersion": 3}')
        question = "Read this local repository's package.json. Give the exact package name and main entry file from the supplied source. Do not run commands. Repository: " + str(self.root)
        with patch.object(context, "read_checked", wraps=context.read_checked) as read:
            result = context.acquire_context(self.request(question))
        self.assertEqual([call.args[1] for call in read.call_args_list], ["package.json"])
        self.assertEqual([file["path"] for file in result["files"]], ["package.json"])
        self.assertEqual(result["files"][0]["excerpts"][0]["text"], root_manifest)
        self.assertEqual(result["selection"]["mode"], "explicit-files")
        self.assertIn("cognition-engine/package.json", result["inventory"])
        self.assertNotIn("wrong.js", json.dumps(result))

    def test_explicit_nested_absolute_and_multiple_paths_stay_exact(self):
        self.write("package.json", '{"name":"root"}')
        self.write("nested/package.json", '{"name":"nested"}')
        self.write("src/main.js", "const entry = true;\n")
        for question in ('Read "nested/package.json".', f'Read "{self.root / "nested" / "package.json"}".'):
            with self.subTest(question=question):
                result = context.acquire_context(self.request(question))
                self.assertEqual([file["path"] for file in result["files"]], ["nested/package.json"])
        result = context.acquire_context(self.request("Compare package.json and src/main.js"))
        self.assertEqual([file["path"] for file in result["files"]], ["package.json", "src/main.js"])


if __name__ == "__main__":
    unittest.main()
