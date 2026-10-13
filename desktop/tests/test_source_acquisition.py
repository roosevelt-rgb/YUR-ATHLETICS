"""Exact registered source context; no donor import, runtime, or journal."""
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

from foundry.factory_cli import decode_request
from foundry.sources import SourceRegistry, YUR_OS_FILE_BYTES

APP_ROOT = Path(__file__).resolve().parents[1]


class SourceAcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "yur-os"
        self.root.mkdir()
        self.ecosystem = self.base / "ecosystem"
        self.ecosystem.mkdir()
        self.registry = SourceRegistry(self.ecosystem, self.root)
        self.raw = b"# Reviewed source\r\nFixture source content.\r\n"
        self.target = self.root / "README.md"
        self.target.write_bytes(self.raw)

    def request(self, **changes):
        return {"source_id": "yur-os", "relative_path": "README.md",
                "expected_sha256": hashlib.sha256(self.raw).hexdigest(), **changes}

    def acquire(self, **changes):
        return self.registry.acquire(**self.request(**changes))

    def test_exact_source_text_with_separate_fresh_metadata(self):
        result = self.acquire()
        self.assertEqual(set(result), {"schema", "content", "evidence", "context_only", "execution_admitted"})
        self.assertEqual(result["schema"], "yur.source-acquisition.v1")
        self.assertEqual(result["content"], self.raw.decode("utf-8"))
        self.assertTrue(result["context_only"])
        self.assertFalse(result["execution_admitted"])
        evidence = result["evidence"]
        self.assertEqual(evidence["schema"], "yur.source-evidence.v1")
        self.assertEqual(evidence["root"], str(self.root))
        self.assertEqual(evidence["relative_path"], "README.md")
        self.assertEqual(evidence["source_id"], "yur-os")
        self.assertEqual(evidence["sha256"], hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(evidence["bytes"], len(self.raw))
        self.assertEqual(evidence["excerpt_sha256"], evidence["sha256"])
        self.assertEqual(evidence["excerpt_bytes"], len(self.raw))
        self.assertEqual(evidence["excerpt_characters"], len(result["content"]))
        self.assertFalse(evidence["truncated"])
        self.assertTrue(evidence["context_only"])
        self.assertFalse(evidence["execution_admitted"])
        self.assertNotIn("content", evidence)
        self.assertIn("+00:00", evidence["acquired_at"])

    def test_source_hash_change_requires_new_selection(self):
        self.target.write_bytes(self.raw + b"Changed after selection\n")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.acquire()
        new_hash = hashlib.sha256(self.target.read_bytes()).hexdigest()
        self.assertIn("Changed after selection", self.acquire(expected_sha256=new_hash)["content"])

    def test_all_input_ids_paths_and_hashes_are_strict(self):
        invalid = [{"source_id": "unknown"}, {"source_id": None}, {"source_id": 4},
                   {"relative_path": "../README.md"}, {"relative_path": str(self.target)},
                   {"relative_path": "README.md:secret"}, {"relative_path": "readme.md"},
                   {"relative_path": "data/ledger.redb"}, {"relative_path": "other.py"},
                   {"relative_path": None}, {"relative_path": "./README.md"},
                   {"relative_path": "yur-substrate\\src\\main.rs"},
                   {"expected_sha256": None}, {"expected_sha256": True},
                   {"expected_sha256": "a" * 63}, {"expected_sha256": "A" * 64},
                   {"expected_sha256": "z" * 64}]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError), patch("foundry.sources.read_checked", side_effect=AssertionError("invalid input must not read")):
                self.acquire(**changes)

    def test_unconfigured_and_missing_file_cannot_acquire(self):
        with self.assertRaisesRegex(ValueError, "not configured"):
            SourceRegistry(None).acquire(**self.request())
        self.target.unlink()
        with self.assertRaises(ValueError):
            self.acquire()
        self.assertFalse(self.target.exists())

    def test_legacy_registered_file_and_root_remain_separate(self):
        target = self.ecosystem / "agents/packs/terra/agent-pack.json"
        target.parent.mkdir(parents=True)
        raw = b'{"name":"TERRA", "reference":"../../not-admitted.py"}'
        target.write_bytes(raw)
        result = self.acquire(source_id="terra-pack", relative_path="agent-pack.json",
                              expected_sha256=hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["content"], raw.decode())
        self.assertEqual(result["evidence"]["root"], str(target.parent))
        self.assertEqual(result["evidence"]["source_id"], "terra-pack")
        with self.assertRaises(ValueError):
            self.acquire(source_id="terra-pack", relative_path="../../not-admitted.py")

    def test_catalog_metadata_path_never_becomes_an_acquisition_path(self):
        index = self.ecosystem / "catalog/skills/_global/index.json"
        index.parent.mkdir(parents=True)
        index.write_text(json.dumps({"entries": {"example": {"name": "Example", "path": "outside.py"}}}))
        self.assertEqual(self.registry.search_catalog("Example", 1)[0][0]["path"], "outside.py")
        with self.assertRaisesRegex(ValueError, "allowlist"):
            self.acquire(source_id="catalog", relative_path="outside.py")

    def test_excerpt_is_bounded_and_whole_file_provenance_is_retained(self):
        text = "\U0001f332" * 16001
        raw = text.encode("utf-8")
        self.target.write_bytes(raw)
        result = self.acquire(expected_sha256=hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["content"], text[:16000])
        evidence = result["evidence"]
        self.assertTrue(evidence["truncated"])
        self.assertEqual(evidence["bytes"], 64004)
        self.assertEqual(evidence["excerpt_bytes"], 64000)
        self.assertLessEqual(evidence["excerpt_bytes"], evidence["limits"]["excerpt_bytes"])
        self.assertEqual(evidence["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(evidence["excerpt_sha256"], hashlib.sha256(result["content"].encode()).hexdigest())
        self.assertNotEqual(evidence["sha256"], evidence["excerpt_sha256"])

    def test_entire_file_secret_check_includes_unreturned_tail(self):
        # Deliberately synthetic canary: must never appear in a result or error.
        canary = "sk-" + "SOURCE_TEST_CANARY_" * 2
        raw = ("safe source\n" * 1800 + canary).encode()
        self.target.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "Credential-like") as raised:
            self.acquire(expected_sha256=hashlib.sha256(raw).hexdigest())
        self.assertNotIn(canary, str(raised.exception))

    def test_binary_or_invalid_utf8_is_refused_without_excerpt(self):
        for raw in (b"text\x00binary", b"\xff\xfeinvalid", b"text\x1bcontrol", b"safe\n" * 4000 + b"\x00"):
            self.target.write_bytes(raw)
            with self.subTest(raw_length=len(raw)), self.assertRaises(ValueError):
                self.acquire(expected_sha256=hashlib.sha256(raw).hexdigest())

    def test_whole_file_limit_applies_to_legacy_and_yur_os(self):
        raw = b"x" * (YUR_OS_FILE_BYTES + 1)
        self.target.write_bytes(raw)
        digest = hashlib.sha256(raw).hexdigest()
        with self.assertRaisesRegex(ValueError, "budget"):
            self.acquire(expected_sha256=digest)
        target = self.ecosystem / "agents/packs/terra/agent-pack.json"
        target.parent.mkdir(parents=True)
        target.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "budget"):
            self.acquire(source_id="terra-pack", relative_path="agent-pack.json", expected_sha256=digest)

    def test_nested_reparse_is_refused_after_registry_construction(self):
        target = self.root / "yur-substrate/src/main.rs"
        target.parent.mkdir(parents=True)
        target.write_bytes(self.raw)
        actual_lstat = Path.lstat

        def metadata(path, *args, **kwargs):
            if path == target.parent:
                return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
            return actual_lstat(path, *args, **kwargs)

        with patch.object(Path, "lstat", metadata), self.assertRaisesRegex(ValueError, "reparse"):
            self.acquire(relative_path="yur-substrate/src/main.rs")

    def test_acquisition_does_not_execute_python_source(self):
        marker = self.base / "must-not-exist"
        raw = ("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('EXECUTED')\n").encode()
        target = self.root / "yur-cortex-py/client.py"
        target.parent.mkdir(parents=True)
        target.write_bytes(raw)
        result = self.acquire(relative_path="yur-cortex-py/client.py", expected_sha256=hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["content"], raw.decode())
        self.assertFalse(marker.exists())

    def rpc(self, request=None, args=None):
        home = self.base / "state-must-not-be-created"
        environment = {**os.environ, "YUR_ECOSYSTEM_ROOT": str(self.ecosystem), "YUR_OS_ROOT": str(self.root),
                       "YUR_FACTORY_HOME": str(home), "PYTHONNOUSERSITE": "1", "PYTHONUTF8": "1"}
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        completed = subprocess.run([sys.executable, "-B", "-m", "foundry.factory_cli", *(args or ["rpc"])],
                                   input=json.dumps(request).encode() if request is not None else b"",
                                   cwd=APP_ROOT, env=environment, capture_output=True, timeout=10)
        self.assertFalse(home.exists(), "read-only source RPC created operational state")
        self.assertEqual(completed.stderr, b"")
        return completed, json.loads(completed.stdout)

    def test_actual_cli_describe_and_acquire_create_no_state(self):
        described, source = self.rpc({"command": "sources"})
        self.assertEqual(described.returncode, 0, source)
        self.assertTrue(source["ok"])
        record = next(item for item in source["result"]["sources"] if item["id"] == "yur-os")
        evidence = next(item for item in record["evidence"] if item["relative_path"] == "README.md")
        acquired, result = self.rpc({"command": "source_acquire", **self.request(expected_sha256=evidence["sha256"])})
        self.assertEqual(acquired.returncode, 0, result)
        self.assertEqual(result["result"]["content"], self.raw.decode())
        self.assertFalse(result["result"]["execution_admitted"])
        cli, result = self.rpc(args=["sources", "--query", "fixture"])
        self.assertEqual(cli.returncode, 0, result)

    def test_actual_cli_errors_remain_read_only_and_do_not_leak_source(self):
        for change in ({"expected_sha256": "0" * 64}, {"source_id": "unknown"}, {"relative_path": "../outside"}, {"authority": "model"}):
            completed, result = self.rpc({"command": "source_acquire", **self.request(), **change})
            self.assertEqual(completed.returncode, 1)
            self.assertFalse(result["ok"])
            self.assertNotIn("result", result)
        canary = "sk-" + "SOURCE_TEST_CANARY_" * 2
        self.target.write_text(canary)
        completed, result = self.rpc({"command": "source_acquire", **self.request(expected_sha256=hashlib.sha256(canary.encode()).hexdigest())})
        self.assertEqual(completed.returncode, 1)
        self.assertNotIn(canary, completed.stdout.decode())
        self.assertFalse(result["ok"])

    def test_actual_cli_discovery_drops_secret_metadata_without_dropping_safe_entries(self):
        index = self.ecosystem / "catalog/skills/_global/index.json"
        index.parent.mkdir(parents=True)
        canary = "sk-" + "SYNTHETIC_DISCOVERY_CANARY_" * 2
        index.write_text(json.dumps({"entries": {
            "safe": {"name": "Safe source", "path": "safe.py"},
            "unsafe": {"name": "Unsafe source", "path": canary},
        }}))
        completed, result = self.rpc({"command": "sources"})
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual([entry["name"] for entry in result["result"]["catalog_matches"]], ["Safe source"])
        self.assertNotIn(canary, completed.stdout.decode())

    def test_rpc_rejects_arbitrary_roots_and_unexpected_fields(self):
        for field in ("root", "path", "authority", "context", "execute"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "unexpected"):
                decode_request(json.dumps({"command": "source_acquire", **self.request(), field: "ignored"}).encode())


if __name__ == "__main__":
    unittest.main()
