import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from foundry.sources import (
    CATALOG_FIELD_LIMITS, SourceRegistry, YUR_OS_FILE_BYTES, YUR_OS_SOURCE_FILES, YUR_OS_TOTAL_BYTES,
    checked_file, read_checked,
)


class SourceTests(unittest.TestCase):
    @staticmethod
    def yur_os_fixture(root):
        for name in YUR_OS_SOURCE_FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(("source fixture: " + name + "\r\n").encode("utf-8"))

    @staticmethod
    def config_fixture(root, contents):
        module = root / "foundry" / "sources.py"
        module.parent.mkdir(parents=True, exist_ok=True)
        (root / ".factory-sources.local.json").write_text(json.dumps(contents), encoding="utf-8")
        return str(module)

    def test_unconfigured_and_untrusted_catalog_references(self):
        self.assertFalse(SourceRegistry(None).describe()["configured"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = root / "catalog/skills/_global/index.json"
            index.parent.mkdir(parents=True)
            index.write_text(json.dumps({"entries": {
                "abc": {"entry_id": "abc", "name": "terra-market", "path": "../../secret.key", "kind": "skill"},
                "def": {"entry_id": "def", "name": "other", "kind": "skill"}
            }}), encoding="utf-8")
            result = SourceRegistry(root).describe("terra", 1)
            self.assertEqual(result["catalog_entries"], 2)
            self.assertEqual(len(result["catalog_matches"]), 1)
            self.assertFalse(result["catalog_matches"][0]["execution_admitted"])
            self.assertEqual(result["catalog_matches"][0]["path"], "../../secret.key")

    def test_source_read_budget_and_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                checked_file(root, "../outside")
            target = root / "index.json"
            target.write_text("123456")
            with self.assertRaises(ValueError):
                checked_file(root, "index.json", 3)
        for query, limit in (("x" * 201, 1), ("", True), ("", 0), ("", 51)):
            with self.assertRaises(ValueError):
                SourceRegistry(None).describe(query, limit)

    def test_catalog_requires_a_json_object(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = root / "catalog/skills/_global/index.json"
            index.parent.mkdir(parents=True)
            for value in ([], None, "invalid", 4):
                index.write_text(json.dumps(value), encoding="utf-8")
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, "must be an object"):
                    SourceRegistry(root).describe()

    def test_terra_query_does_not_match_terraform(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = root / "catalog/skills/_global/index.json"
            index.parent.mkdir(parents=True)
            index.write_text(json.dumps({"entries": {
                "terra": {"name": "TERRA-agent", "kind": "pack"},
                "terraform": {"name": "terraform-infrastructure", "kind": "skill"}
            }}), encoding="utf-8")
            matches, count = SourceRegistry(root).search_catalog("terra", 12)
            self.assertEqual(count, 2)
            self.assertEqual([entry["name"] for entry in matches], ["TERRA-agent"])

    def test_discovery_excludes_secret_or_oversized_metadata_but_keeps_safe_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = root / "catalog/skills/_global/index.json"
            index.parent.mkdir(parents=True)
            canary = "sk-" + "SYNTHETIC_CATALOG_CANARY_" * 2
            entries = {"safe": {"entry_id": "safe", "name": "Terra safe", "path": "../../untrusted-reference.py"}}
            for field, maximum in CATALOG_FIELD_LIMITS.items():
                entries["secret_" + field] = {"name": "Terra unsafe", field: canary}
                entries["oversized_" + field] = {"name": "Terra oversized", field: "x" * (maximum + 1)}
            entries["credential_assignment"] = {"name": "Terra api_key='SYNTHETIC_CREDENTIAL_VALUE'"}
            entries["control"] = {"name": "Terra injected\nmetadata"}
            index.write_text(json.dumps({"entries": entries}), encoding="utf-8")
            result = SourceRegistry(root).describe("terra", 50)
            self.assertEqual(result["catalog_entries"], len(entries))
            self.assertEqual([entry["entry_id"] for entry in result["catalog_matches"]], ["safe"])
            self.assertEqual(result["catalog_matches"][0]["path"], "../../untrusted-reference.py")
            self.assertNotIn(canary, json.dumps(result))
            self.assertNotIn("SYNTHETIC_CREDENTIAL_VALUE", json.dumps(result))

    def test_reparse_ancestor_above_configured_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            ancestor = Path(directory)
            root = ancestor / "corpus"
            root.mkdir()
            (root / "index.json").write_text("{}")
            actual_lstat = Path.lstat

            def metadata(path, *args, **kwargs):
                if path == ancestor:
                    return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
                return actual_lstat(path, *args, **kwargs)

            with patch.object(Path, "lstat", metadata), self.assertRaisesRegex(ValueError, "reparse"):
                checked_file(root, "index.json")

    def test_source_growing_after_stat_still_obeys_handle_read_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "index.json"
            target.write_bytes(b"ab")
            actual_fdopen = os.fdopen
            requested = []

            class GrowingReader:
                def __init__(self, stream):
                    self.stream = stream

                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    self.stream.close()

                def fileno(self):
                    return self.stream.fileno()

                def read(self, count):
                    requested.append(count)
                    with target.open("ab") as writer:
                        writer.write(b"cdefghijk")
                    return self.stream.read(count)

            def opened(fd, *args, **kwargs):
                return GrowingReader(actual_fdopen(fd, *args, **kwargs))

            with patch("foundry.sources.os.fdopen", opened), self.assertRaisesRegex(ValueError, "budget"):
                read_checked(root, "index.json", 3)
            self.assertEqual(requested, [4])

    def test_yur_os_is_independent_and_catalog_without_root_is_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.yur_os_fixture(root)
            registry = SourceRegistry(None, yur_os_root=root)
            result = registry.describe("anything", 1)
            self.assertTrue(result["configured"])
            self.assertEqual([item["id"] for item in result["sources"]], ["yur-os"])
            self.assertEqual(result["catalog_matches"], [])
            self.assertEqual(result["catalog_entries"], 0)
            self.assertEqual(registry.search_catalog("terra", 12), ([], 0))
            self.assertEqual(SourceRegistry(None).search_catalog("terra", 12), ([], 0))
            source = result["sources"][0]
            self.assertTrue(source["available"])
            self.assertFalse(source["execution_admitted"])
            self.assertFalse(source["runtime_verified"])
            self.assertEqual(source["classification"], "source-only")
            self.assertEqual(source["mode"], "read-only")
            self.assertEqual(source["acquired_bytes"], sum(item["bytes"] for item in source["evidence"]))

    def test_existing_catalog_constructor_and_yur_os_root_do_not_replace_each_other(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            ecosystem, yur_os = base / "ecosystem", base / "yur-os"
            index = ecosystem / "catalog/skills/_global/index.json"
            index.parent.mkdir(parents=True)
            index.write_text(json.dumps({"entries": {"terra": {"name": "Terra land"}}}))
            self.yur_os_fixture(yur_os)
            old = SourceRegistry(ecosystem).describe("terra")
            registry = SourceRegistry(ecosystem, yur_os)
            current = registry.describe("terra")
            self.assertEqual(registry.root, ecosystem)
            self.assertEqual(current["sources"][:-1], old["sources"])
            self.assertEqual(current["catalog_matches"], old["catalog_matches"])
            self.assertEqual(current["sources"][-1]["path"], str(yur_os))

    def test_yur_os_reads_only_fixed_source_slices_and_hashes_actual_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.yur_os_fixture(root)
            target = root / "yur-cortex-py/client.py"
            content = b"raise RuntimeError('SOURCE_MUST_NOT_EXECUTE')\r\n"
            target.write_bytes(content)
            for name in (".env", "data/ledger.redb", "target/secret.py", "other.py"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"UNREAD_TEST_CANARY")
            # Even a reviewed manifest's references cannot enlarge acquisition.
            (root / "__SPINE_NODE__.json").write_text('{"read":"../outside","runtime":"other.py"}')
            with patch("foundry.sources.read_checked", wraps=read_checked) as acquired:
                source = SourceRegistry(None, root).describe()["sources"][0]
            self.assertEqual([call.args[1] for call in acquired.call_args_list], list(YUR_OS_SOURCE_FILES))
            self.assertTrue(all(call.args[0] == root for call in acquired.call_args_list))
            client = next(item for item in source["evidence"] if item["relative_path"] == "yur-cortex-py/client.py")
            self.assertEqual(client["sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual(client["bytes"], len(content))
            target.write_bytes(content + b"# changed\n")
            changed = SourceRegistry(None, root).describe()["sources"][0]
            new_client = next(item for item in changed["evidence"] if item["relative_path"] == client["relative_path"])
            self.assertNotEqual(client["sha256"], new_client["sha256"])
            self.assertFalse(changed["execution_admitted"])

    def test_yur_os_missing_root_or_file_is_unavailable_without_creating_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "not-created"
            result = SourceRegistry(None, root).describe()
            self.assertTrue(result["configured"])
            self.assertFalse(result["sources"][0]["available"])
            self.assertTrue(all(not item["available"] for item in result["sources"][0]["evidence"]))
            self.assertFalse(root.exists())
            self.yur_os_fixture(root)
            (root / "proto/spine.proto").unlink()
            source = SourceRegistry(None, root).describe()["sources"][0]
            self.assertFalse(source["available"])
            self.assertEqual([item["relative_path"] for item in source["evidence"] if not item["available"]],
                             ["proto/spine.proto"])

    def test_yur_os_file_and_aggregate_budgets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.yur_os_fixture(root)
            (root / YUR_OS_SOURCE_FILES[0]).write_bytes(b"x" * (YUR_OS_FILE_BYTES + 1))
            oversized = SourceRegistry(None, root).describe()["sources"][0]
            self.assertFalse(oversized["evidence"][0]["available"])
            for name in YUR_OS_SOURCE_FILES[:5]:
                (root / name).write_bytes(b"x" * YUR_OS_FILE_BYTES)
            bounded = SourceRegistry(None, root).describe()["sources"][0]
            self.assertEqual(bounded["acquired_bytes"], YUR_OS_TOTAL_BYTES)
            self.assertEqual(sum(item["available"] for item in bounded["evidence"]), 4)
            self.assertFalse(bounded["available"])

    def test_environment_configuration_precedence_is_per_root(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            local_eco, local_os = base / "local-ecosystem", base / "local-os"
            env_eco, env_os = base / "env-ecosystem", base / "env-os"
            module = self.config_fixture(base, {"ecosystem_root": str(local_eco), "yur_os_root": str(local_os)})
            cases = [({}, local_eco, local_os),
                     ({"YUR_ECOSYSTEM_ROOT": str(env_eco)}, env_eco, local_os),
                     ({"YUR_OS_ROOT": str(env_os)}, local_eco, env_os),
                     ({"YUR_OS_ROOT": ""}, local_eco, local_os),
                     ({"YUR_ECOSYSTEM_ROOT": str(env_eco), "YUR_OS_ROOT": str(env_os)}, env_eco, env_os)]
            for environment, expected_eco, expected_os in cases:
                with self.subTest(environment=environment), patch("foundry.sources.__file__", module), patch.dict(os.environ, environment, clear=True):
                    registry = SourceRegistry.from_environment()
                    self.assertEqual(registry.root, expected_eco)
                    self.assertEqual(registry.yur_os_root, expected_os)
            self.assertFalse(local_eco.exists())
            self.assertFalse(env_os.exists())

    def test_environment_roots_do_not_read_unused_local_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            module = self.config_fixture(base, "invalid unused config")
            environment = {"YUR_ECOSYSTEM_ROOT": str(base / "ecosystem"), "YUR_OS_ROOT": str(base / "os")}
            with patch("foundry.sources.__file__", module), patch.dict(os.environ, environment, clear=True), patch("foundry.sources.read_checked", side_effect=AssertionError("must not acquire config")):
                registry = SourceRegistry.from_environment()
            self.assertEqual(registry.yur_os_root, base / "os")

    def test_configuration_rejects_invalid_roots_shapes_and_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            values = [[], "not an object", {"ecosystem_root": 3}, {"yur_os_root": []},
                      {"yur_os_root": False}, {"yur_os_root": "  "}, {"yur_os_root": "bad\0path"},
                      {"yur_os_root": "x" * 4097}]
            file = base / "not-directory.txt"
            file.write_text("fixture")
            values.append({"yur_os_root": str(file)})
            for value in values:
                module = self.config_fixture(base, value)
                with self.subTest(value=type(value)), patch("foundry.sources.__file__", module), patch.dict(os.environ, {}, clear=True), self.assertRaises(ValueError):
                    SourceRegistry.from_environment()
            module = self.config_fixture(base, {"yur_os_root": None})
            with patch("foundry.sources.__file__", module), patch.dict(os.environ, {}, clear=True):
                self.assertFalse(SourceRegistry.from_environment().describe()["configured"])

    def test_yur_os_reparse_root_and_nested_source_are_never_acquired(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "donor"
            self.yur_os_fixture(root)
            actual_lstat = Path.lstat

            def root_metadata(path, *args, **kwargs):
                if path == root:
                    return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
                return actual_lstat(path, *args, **kwargs)

            with patch.object(Path, "lstat", root_metadata), patch("foundry.sources.read_checked") as acquired:
                with self.assertRaisesRegex(ValueError, "reparse"):
                    SourceRegistry(None, root)
                acquired.assert_not_called()

            def child_metadata(path, *args, **kwargs):
                if path == root / "proto":
                    return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
                return actual_lstat(path, *args, **kwargs)

            with patch.object(Path, "lstat", child_metadata):
                source = SourceRegistry(None, root).describe()["sources"][0]
                proto = next(item for item in source["evidence"] if item["relative_path"] == "proto/spine.proto")
                self.assertFalse(proto["available"])


if __name__ == "__main__":
    unittest.main()
