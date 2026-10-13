"""Harmless fixture checks for product knowledge coverage and read boundaries."""
import builtins
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from foundry.product_knowledge import (
    ReadScope, SQLiteReadOnlyBackend, build_product_manifest,
    product_scope_from_manifest, query_scoped_knowledge,
)


class ProductKnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "selected-product"
        self.root.mkdir()

    def write(self, relative, contents="fixture source\n"):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
        return path

    def index(self, rows):
        database = Path(self.temporary.name) / "existing-index.sqlite"
        with closing(sqlite3.connect(database)) as connection:
            with connection:
                connection.execute("CREATE TABLE knowledge_chunks ("
                                   "scope_kind TEXT, owner_id TEXT, namespace_id TEXT, "
                                   "version TEXT, coverage_digest TEXT, source_path TEXT, chunk_id INTEGER, snippet TEXT)")
                connection.executemany("INSERT INTO knowledge_chunks VALUES (?,?,?,?,?,?,?,?)", rows)
        return database

    def test_metadata_only_manifest_records_coverage_and_redacted_exclusions(self):
        self.write("src/main.py", "print('PUBLIC_FIXTURE')\n")
        self.write("src/config-secret.py", "PRIVATE_FIXTURE\n")
        self.write("private/vault.json", "PRIVATE_FIXTURE\n")
        self.write("src/production.env.json", "PRIVATE_FIXTURE\n")
        self.write("node_modules/pkg/index.js", "DEPENDENCY_FIXTURE\n")
        self.write("src/image.png", "not source")
        self.write("src/events.json", "runtime state")
        with patch.object(builtins, "open", side_effect=AssertionError("source opened")):
            manifest = build_product_manifest(self.root, "desktop", "2026.10.07")
        serialized = json.dumps(manifest)
        self.assertEqual([entry["path"] for entry in manifest["included"]], ["src/main.py"])
        self.assertEqual(manifest["counts"]["included"], 1)
        self.assertEqual(manifest["counts"]["excluded_subtree"], 2)
        self.assertGreaterEqual(manifest["counts"]["sensitive_or_private_name"], 3)
        self.assertFalse(manifest["source_contents_read"])
        self.assertNotIn("config-secret.py", serialized)
        self.assertNotIn("vault.json", serialized)
        self.assertNotIn("production.env.json", serialized)
        self.assertNotIn("PRIVATE_FIXTURE", serialized)
        self.assertIn("node_modules", serialized)
        self.assertTrue(manifest["coverage_complete"])

    def test_manifest_is_version_bound_and_tampering_rejected(self):
        self.write("main.py")
        first = build_product_manifest(self.root, "desktop", "v1")
        again = build_product_manifest(self.root, "desktop", "v1")
        second = build_product_manifest(self.root, "desktop", "v2")
        self.assertEqual(first["manifest_digest"], again["manifest_digest"])
        self.assertNotEqual(first["manifest_digest"], second["manifest_digest"])
        scope = product_scope_from_manifest(first)
        self.assertEqual((scope.namespace_id, scope.version), ("product:desktop", "v1"))
        changed = dict(first)
        changed["included"] = []
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            product_scope_from_manifest(changed)

    def test_budget_exhaustion_never_claims_complete_coverage(self):
        self.write("a.py")
        self.write("b.py")
        with self.assertRaisesRegex(ValueError, "entry budget"):
            build_product_manifest(self.root, "desktop", "v1", max_entries=1)

    def test_immutable_sqlite_lookup_is_exactly_scoped_and_nonmutating(self):
        self.write("src/main.py")
        manifest = build_product_manifest(self.root, "desktop", "v1")
        product = product_scope_from_manifest(manifest)
        user = ReadScope("user", "person1", "space1", frozenset({"notes/readme.md"}), "a" * 64)
        database = self.index([
            ("product", "desktop", "product:desktop", "v1", product.coverage_digest, "src/main.py", 1, "shared marker product"),
            ("product", "desktop", "product:desktop", "v2", product.coverage_digest, "src/main.py", 2, "shared marker old"),
            ("user", "person1", "user:person1", "space1", user.coverage_digest, "notes/readme.md", 3, "shared marker user"),
            ("user", "person2", "user:person2", "space1", user.coverage_digest, "notes/readme.md", 4, "shared marker other"),
            ("product", "desktop", "product:desktop", "v1", "b" * 64, "src/main.py", 5, "shared marker stale index"),
        ])
        before = hashlib.sha256(database.read_bytes()).hexdigest()
        backend = SQLiteReadOnlyBackend(database)
        product_result = query_scoped_knowledge(backend, product, "shared marker")
        user_result = query_scoped_knowledge(backend, user, "shared marker")
        self.assertTrue(product_result["ok"])
        self.assertEqual([row["chunk_id"] for row in product_result["results"]], [1])
        self.assertTrue(user_result["ok"])
        self.assertEqual([row["chunk_id"] for row in user_result["results"]], [3])
        self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), before)
        self.assertEqual(query_scoped_knowledge(backend, product, "' OR 1=1 --")["results"], [])

    def test_missing_backend_and_bad_schema_are_explicit_failures(self):
        self.write("src/main.py")
        scope = product_scope_from_manifest(build_product_manifest(self.root, "desktop", "v1"))
        result = query_scoped_knowledge(None, scope, "search")
        self.assertEqual(result["error"]["code"], "backend_unavailable")
        self.assertEqual(result["results"], [])
        missing = SQLiteReadOnlyBackend(Path(self.temporary.name) / "absent.sqlite")
        self.assertEqual(query_scoped_knowledge(missing, scope, "search")["error"]["code"],
                         "backend_unavailable")
        self.assertFalse((Path(self.temporary.name) / "absent.sqlite").exists())
        empty = Path(self.temporary.name) / "empty.sqlite"
        with closing(sqlite3.connect(empty)):
            pass
        self.assertEqual(query_scoped_knowledge(SQLiteReadOnlyBackend(empty), scope, "search")
                         ["error"]["code"], "backend_unavailable")

    def test_backend_rows_fail_closed_before_any_result_is_returned(self):
        self.write("src/main.py")
        scope = product_scope_from_manifest(build_product_manifest(self.root, "desktop", "v1"))
        good = {"scope_kind": "product", "owner_id": "desktop",
                "namespace_id": "product:desktop", "version": "v1", "coverage_digest": scope.coverage_digest,
                "source_path": "src/main.py", "chunk_id": 1, "snippet": "safe text"}

        class FakeBackend:
            def __init__(self, rows):
                self.rows = rows

            def query_read_only(self, _scope, _text, _limit):
                return self.rows

        for changed, code in [
            ({"namespace_id": "user:person1"}, "scope_mismatch"),
            ({"version": "v2"}, "scope_mismatch"),
            ({"coverage_digest": "b" * 64}, "scope_mismatch"),
            ({"source_path": "src/other.py"}, "source_uncovered"),
            ({"source_path": ["src/main.py"]}, "source_uncovered"),
            ({"snippet": "password = 'PRIVATE_FIXTURE'"}, "content_rejected"),
            ({"chunk_id": -1}, "backend_contract"),
        ]:
            with self.subTest(code=code):
                result = query_scoped_knowledge(FakeBackend([good, good | changed]), scope, "safe")
                self.assertFalse(result["ok"])
                self.assertEqual(result["results"], [])
                self.assertEqual(result["error"]["code"], code)
                self.assertNotIn("PRIVATE_FIXTURE", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
