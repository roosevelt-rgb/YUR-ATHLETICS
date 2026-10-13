"""Actual CommitService project reference acceptance; all source/state fixtures are temporary."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
from zipfile import ZipFile

from foundry import attachments, project_files as files
from foundry.commit_service import CommitService, SCHEMA_VERSION

WORKSPACE_AUTHORITY = {"issuer": "local-user", "scope": "workspace-state", "actions": ["commit"]}
CONVERSATION_AUTHORITY = {"issuer": "local-user", "scope": "conversation-state", "actions": ["commit"]}
SOURCE = Path(__file__).resolve().parents[1]


def sha(data): return hashlib.sha256(data).hexdigest()


class ProjectFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "journal"
        self.store = CommitService(self.state)
        self.project = self.new_project()

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def new_project(self):
        stamp = datetime.now(timezone.utc).isoformat()
        doc = {"id": str(uuid.uuid4()), "name": "Shared references", "root": "", "instructions": "Inspect explicit references only.",
               "createdAt": stamp, "updatedAt": stamp}
        return self.store.commit_workspace("project", doc, 0, authority=WORKSPACE_AUTHORITY)

    def source(self, name="reference.txt", content=b"Concrete: 12 CY\nSteel: 4 tons"):
        path = self.root / name
        path.write_bytes(content if type(content) is bytes else content.encode("utf-8"))
        return path

    def request(self, path=None, *, project=None, revision=0):
        project = project or self.project
        path = path or self.source()
        return {"command": "project_file_add", "project_id": project["id"], "expected_project_revision": project["revision"],
                "expected_collection_revision": revision, "operation_id": str(uuid.uuid4()), "path": str(path), "expected_sha256": sha(path.read_bytes())}

    def add(self, path=None, **fields):
        return self.store.add_project_file(self.request(path, **fields), authority=files.AUTHORITY)

    def selection(self, record):
        return {"file_id": record["id"], "revision": record["revision"], "sha256": record["sha256"]}

    def context(self, selected, project=None):
        project = project or self.project
        return self.store.project_files_context(project["id"], project["revision"], selected)

    def remove_request(self, record, revision=1, project=None):
        project = project or self.project
        return {"command": "project_file_remove", "project_id": project["id"], "expected_project_revision": project["revision"],
                "expected_collection_revision": revision, "operation_id": str(uuid.uuid4()), "file_id": record["id"],
                "expected_file_revision": record["revision"], "expected_sha256": record["sha256"]}

    def cli(self, request, state=None):
        environment = {**os.environ, "YUR_DESKTOP_HOME": str(state or self.state), "PYTHONNOUSERSITE": "1", "PYTHONIOENCODING": "utf-8"}
        environment.pop("PYTHONPATH", None)
        result = subprocess.run([sys.executable, "-B", "-m", "foundry.conversation_cli"], input=json.dumps(request).encode(),
                                cwd=SOURCE, env=environment, capture_output=True, timeout=15)
        self.assertEqual(result.stderr, b"")
        return result.returncode, json.loads(result.stdout)

    def test_empty_list_is_readonly_and_does_not_change_project_metadata(self):
        before = self.store.verify_integrity()
        self.assertEqual(self.store.list_project_files(self.project["id"], 1),
                         {"project_id": self.project["id"], "project_revision": 1, "collection_revision": 0, "files": []})
        self.assertEqual(self.store.verify_integrity(), before)
        self.assertEqual(self.store.list_workspace("project"), [self.project])
        self.assertEqual(json.loads(self.context([])["context"])["files"], [])

    def test_single_acquisition_stores_exact_bytes_and_context_survives_source_deletion(self):
        original = b"Snapshot 12 CY"
        path = self.source(content=original); request = self.request(path)
        real_read = attachments.read_checked
        def read_then_change(*args):
            data = real_read(*args)
            path.write_bytes(b"Later source is unrelated")
            return data
        with patch.object(attachments, "read_checked", side_effect=read_then_change) as read:
            result = self.store.add_project_file(request, authority=files.AUTHORITY)
        self.assertEqual(read.call_count, 1)
        record = result["files"][0]
        self.assertEqual(self.store._db.execute("SELECT payload FROM project_file_blobs").fetchone()[0], original)
        path.unlink()
        first = self.context([self.selection(record)])
        self.assertEqual(json.loads(first["context"])["files"][0]["text"], original.decode())
        self.assertNotIn("source_path", json.dumps(first)); self.assertNotIn("content", record)
        self.store.close(); self.store = CommitService(self.state)
        self.assertEqual(self.context([self.selection(record)]), first)

    def test_add_and_remove_replay_original_response_after_later_changes_and_deleted_source(self):
        path = self.source(); request = self.request(path)
        added = self.store.add_project_file(request, authority=files.AUTHORITY)
        remove = self.remove_request(added["files"][0])
        removed = self.store.remove_project_file(remove, authority=files.AUTHORITY)
        path.unlink()
        project = {key: value for key, value in self.project.items() if key != "revision"}
        project["updatedAt"] = datetime.now(timezone.utc).isoformat(); project["name"] = "Updated project"
        self.store.commit_workspace("project", project, 1, authority=WORKSPACE_AUTHORITY)
        self.assertEqual(self.store.add_project_file(request, authority=files.AUTHORITY), {**added, "replayed": True})
        self.assertEqual(self.store.remove_project_file(remove, authority=files.AUTHORITY), {**removed, "replayed": True})
        with self.assertRaises(files.ProjectFileConflictError):
            self.store.add_project_file({**request, "expected_project_revision": 2}, authority=files.AUTHORITY)
        self.assertEqual(self.store.verify_integrity()["project_file_events"], 2)

    def test_tombstone_blocks_future_selection_but_retains_bytes_and_prior_context_evidence(self):
        added = self.add(); record = added["files"][0]; context = self.context([self.selection(record)])
        removed = self.store.remove_project_file(self.remove_request(record), authority=files.AUTHORITY)
        self.assertEqual(removed["files"], []); self.assertEqual(removed["collection_revision"], 2)
        self.assertEqual(removed["receipt"]["file_revision"], 2)
        self.assertEqual(self.store.verify_integrity()["project_file_blobs"], 1)
        self.assertEqual(sha(context["context"].encode()), context["evidence"]["context_sha256"])
        with self.assertRaises(files.ProjectFileConflictError): self.context([self.selection(record)])
        # A subsequent addition is a separate immutable version, not an overwrite.
        readded = self.add(revision=2)["files"][0]
        self.assertNotEqual(readded["id"], record["id"])
        self.assertEqual(readded["revision"], 1)
        self.assertEqual(self.store.verify_integrity()["project_file_blobs"], 1)

    def test_project_collection_and_file_cas_reject_stale_or_foreign_selection(self):
        first = self.add()["files"][0]; second_project = self.new_project()
        with self.assertRaises(files.ProjectFileConflictError): self.add(revision=0)
        with self.assertRaises(ValueError): self.context([self.selection(first)], second_project)
        with self.assertRaises(ValueError):
            self.store.remove_project_file(self.remove_request(first, revision=0, project=second_project), authority=files.AUTHORITY)
        for field, value in (("revision", 2), ("sha256", "0" * 64)):
            with self.assertRaises(files.ProjectFileConflictError): self.context([{**self.selection(first), field: value}])
        with self.assertRaises(files.ProjectFileConflictError): self.store.list_project_files(self.project["id"], 2)
        with self.assertRaises(ValueError): self.store.list_project_files(str(uuid.uuid4()), 1)

    def test_independent_connections_cas_and_changed_project_during_acquisition(self):
        second = CommitService(self.state)
        try:
            request = self.request()
            second.add_project_file(request, authority=files.AUTHORITY)
            with self.assertRaises(files.ProjectFileConflictError): self.add()
            request = self.request(revision=1)
            real_acquire = files.acquire_attachment
            def change_project(*args, **kwargs):
                result = real_acquire(*args, **kwargs)
                project = {key: value for key, value in self.project.items() if key != "revision"}
                project["updatedAt"] = datetime.now(timezone.utc).isoformat()
                second.commit_workspace("project", project, 1, authority=WORKSPACE_AUTHORITY)
                return result
            with patch.object(files, "acquire_attachment", side_effect=change_project):
                with self.assertRaises(files.ProjectFileConflictError): self.store.add_project_file(request, authority=files.AUTHORITY)
            self.assertEqual(self.store.verify_integrity()["project_files"], 1)
        finally: second.close()

    def test_changed_source_hash_secret_and_image_fail_before_commit(self):
        path = self.source(); request = self.request(path); path.write_text("Different")
        with self.assertRaisesRegex(ValueError, "changed"): self.store.add_project_file(request, authority=files.AUTHORITY)
        for name, data in (("picture.png", b"not an image"), ("hidden.env", b"value"), ("reference.txt", "sk-" + "A" * 48)):
            with self.subTest(name=name):
                with self.assertRaises(ValueError): self.add(self.source(name, data))
        self.assertEqual(self.store.verify_integrity()["project_files"], 0)

    def test_docx_xlsx_pptx_extraction_preserves_exact_snapshot_and_no_macro_execution(self):
        fixtures = {
            "scope.docx": {"word/document.xml": '<document><p><t>Concrete 125 CY</t></p></document>'},
            "budget.xlsx": {"xl/worksheets/sheet1.xml": '<worksheet><row><c r="A1" t="inlineStr"><is><t>Concrete</t></is></c><c r="B1"><v>125</v></c></row></worksheet>'},
            "brief.pptx": {"ppt/slides/slide1.xml": '<slide><t>Concrete 125 CY</t></slide>'}}
        for index, (name, parts) in enumerate(fixtures.items()):
            data = io.BytesIO()
            with ZipFile(data, "w") as archive:
                for member, body in parts.items(): archive.writestr(member, body)
            record = self.add(self.source(name, data.getvalue()), revision=index)["files"][-1]
            value = self.context([self.selection(record)])
            self.assertIn("125", value["context"]); self.assertIn("Concrete", value["context"])
            self.assertEqual(record["sha256"], sha(data.getvalue()))
        self.assertEqual(self.store.verify_integrity()["project_files"], 3)

    def test_pdf_snapshot_context_without_pdf_parser_after_commit(self):
        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
        writer = PdfWriter(); page = writer.add_blank_page(width=200, height=200)
        stream = DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 20 100 Td (Reference 125 CY) Tj ET")
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        page[NameObject('/Contents')] = writer._add_object(stream)
        payload = io.BytesIO(); writer.write(payload)
        record = self.add(self.source("reference.pdf", payload.getvalue()))["files"][0]
        self.assertFalse(record["extraction"]["ocr_performed"])
        with patch.object(attachments, "_pdf", side_effect=AssertionError("No historical reparse")):
            self.store.close(); self.store = CommitService(self.state)
            self.assertIn("125 CY", self.context([self.selection(record)])["context"])

    def test_explicit_context_only_selected_files_unicode_byte_bounds_and_truncation(self):
        records = []
        for index, text in enumerate(("A" * 70000, "😀" * 64000, "not selected")):
            records.append(self.add(self.source(f"reference{index}.txt", text), revision=index)["files"][-1])
        context = self.context([self.selection(records[0]), self.selection(records[1])])
        decoded = json.loads(context["context"])
        self.assertEqual(len(decoded["files"]), 2)
        self.assertNotIn("not selected", context["context"])
        self.assertTrue(all(item["truncated"] for item in context["evidence"]["files"]))
        self.assertLessEqual(sum(item["excerpt_bytes"] for item in context["evidence"]["files"]), 65536)
        self.assertLessEqual(len(context["context"].encode()), 98304)
        for item, proof in zip(decoded["files"], context["evidence"]["files"]):
            self.assertEqual(sha(item["text"].encode()), proof["excerpt_sha256"])
        with self.assertRaises(ValueError): self.context([self.selection(records[0])] * 2)

    def test_budgets_file_active_retained_and_global_bytes_are_atomic(self):
        with patch.object(files, "MAX_ACTIVE", 1):
            self.add()
            with self.assertRaisesRegex(ValueError, "limit"): self.add(self.source("next.txt", "next"), revision=1)
        self.assertEqual(self.store.verify_integrity()["project_files"], 1)
        with patch.object(files, "MAX_RETAINED_BYTES", 31):
            with self.assertRaisesRegex(ValueError, "limit"): self.add(self.source("other.txt", b"x" * 20), revision=1)
        with patch.object(attachments, "MAX_FILE_BYTES", 2):
            with self.assertRaises(ValueError): self.add(self.source("huge.txt", b"abc"), revision=1)
        self.assertEqual(self.store.verify_integrity()["project_file_events"], 1)

    def test_wrong_authority_and_strict_commands_cannot_grant_root_or_execution(self):
        request = self.request()
        for authority in ({}, {**files.AUTHORITY, "actions": ["execute"]}, WORKSPACE_AUTHORITY):
            with self.assertRaises(ValueError): self.store.add_project_file(request, authority=authority)
        for change in ({"root": str(self.root)}, {"authority": files.AUTHORITY}, {"operation_id": "invalid"}, {"expected_collection_revision": True}):
            with self.assertRaises(ValueError): self.store.add_project_file({**request, **change}, authority=files.AUTHORITY)
        self.assertEqual(self.store.list_work(), [])

    def test_append_failure_rolls_back_blob_document_and_event(self):
        original = self.store._project_file_append
        def fail_after_insert(*args):
            original(*args)
            raise OSError("Synthetic transaction failure")
        with patch.object(self.store, "_project_file_append", side_effect=fail_after_insert):
            with self.assertRaises(OSError): self.add()
        proof = self.store.verify_integrity()
        self.assertEqual([proof[key] for key in ("project_files", "project_file_events", "project_file_blobs")], [0, 0, 0])

    def test_lost_commit_ack_recovers_operation_once_without_source(self):
        request = self.request(); original = self.store.add_project_file
        saved = []
        def lost_ack(*args, **kwargs):
            saved.append(original(*args, **kwargs))
            raise OSError("Synthetic lost acknowledgment after actual commit")
        with patch.object(self.store, "add_project_file", side_effect=lost_ack):
            with self.assertRaises(OSError): self.store.add_project_file(request, authority=files.AUTHORITY)
        Path(request["path"]).unlink()
        self.store.close(); self.store = CommitService(self.state)
        replay = self.store.add_project_file(request, authority=files.AUTHORITY)
        self.assertEqual(replay, {**saved[0], "replayed": True})
        self.assertEqual(self.store.verify_integrity()["project_file_events"], 1)

    def test_online_backup_contains_immutable_bytes_and_identical_context_receipts(self):
        record = self.add()["files"][0]; context = self.context([self.selection(record)])
        target = self.root / "backup"; target.mkdir()
        with closing(sqlite3.connect(target / "foundry.sqlite3")) as destination: self.store._db.backup(destination)
        with CommitService(target) as backup:
            self.assertEqual(backup.verify_integrity(), self.store.verify_integrity())
            self.assertEqual(backup.project_files_context(self.project["id"], 1, [self.selection(record)]), context)

    def test_blob_projection_event_tamper_fail_on_read_and_reopen(self):
        for target in ("blob", "projection", "event"):
            with self.subTest(target=target):
                isolated = self.root / ("tamper-" + target); isolated.mkdir()
                self.add(revision=self.store.verify_integrity()["project_file_events"])
                with closing(sqlite3.connect(isolated / "foundry.sqlite3")) as raw: self.store._db.backup(raw)
                with closing(sqlite3.connect(isolated / "foundry.sqlite3")) as raw, raw:
                    if target == "blob": raw.execute("UPDATE project_file_blobs SET payload=?", (b"tampered",))
                    elif target == "projection": raw.execute("UPDATE project_files SET revision=2")
                    else: raw.execute("UPDATE project_file_events SET hash=?", ("0" * 64,))
                with self.assertRaisesRegex(RuntimeError, "integrity check failed"): CommitService(isolated)
        self.store._db.execute("UPDATE project_file_blobs SET payload=?", (b"tampered",))
        with self.assertRaises(RuntimeError): self.store.list_project_files(self.project["id"], 1)

    def test_schema8_migration_preserves_all_old_rows_and_rejects_prior_corruption(self):
        old_rows = [tuple(row) for row in self.store._db.execute("SELECT * FROM workspace_events")]
        self.store.close()
        with closing(sqlite3.connect(self.state / "foundry.sqlite3")) as raw, raw:
            for name in ("project_file_events", "project_files", "project_file_blobs"): raw.execute("DROP TABLE " + name)
            raw.execute("PRAGMA user_version=8")
        self.store = CommitService(self.state)
        self.assertEqual(self.store._db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
        self.assertEqual([tuple(row) for row in self.store._db.execute("SELECT * FROM workspace_events")], old_rows)
        self.store.close()
        with closing(sqlite3.connect(self.state / "foundry.sqlite3")) as raw, raw:
            for name in ("project_file_events", "project_files", "project_file_blobs"): raw.execute("DROP TABLE " + name)
            raw.execute("PRAGMA user_version=8"); raw.execute("UPDATE workspace_documents SET revision=2")
        with self.assertRaises(RuntimeError): CommitService(self.state)
        with closing(sqlite3.connect(self.state / "foundry.sqlite3")) as raw:
            self.assertEqual(raw.execute("PRAGMA user_version").fetchone()[0], 8)
            self.assertEqual(raw.execute("SELECT name FROM sqlite_master WHERE name LIKE 'project_file%'").fetchall(), [])

    def test_conversation_selections_are_only_refs_and_project_isolation_is_strict(self):
        record = self.add()["files"][0]; stamp = datetime.now(timezone.utc).isoformat()
        conversation = {"id": str(uuid.uuid4()), "title": "References", "model": "local:auto", "createdAt": stamp, "updatedAt": stamp,
                        "messages": [], "metadata": {"project_id": self.project["id"]},
                        "project_file_selections": {"project_id": self.project["id"], "files": [self.selection(record)]}}
        self.store.commit_conversation(conversation, 0, authority=CONVERSATION_AUTHORITY)
        self.assertEqual(self.store.list_conversations()[0]["project_file_selections"], conversation["project_file_selections"])
        for bad in ({"project_id": str(uuid.uuid4()), "files": []},
                    {"project_id": self.project["id"], "files": [{**self.selection(record), "path": str(self.root)}]},
                    {"project_id": self.project["id"], "files": [self.selection(record)] * 9}):
            with self.assertRaises(ValueError): self.store.commit_conversation({**conversation, "project_file_selections": bad}, 1, authority=CONVERSATION_AUTHORITY)
        # Historical conversations need not resolve a currently known project.
        unknown = str(uuid.uuid4())
        valid = {**conversation, "metadata": {"project_id": unknown}, "project_file_selections": {"project_id": unknown, "files": []}}
        self.store.commit_conversation(valid, 1, authority=CONVERSATION_AUTHORITY)

    def test_actual_cli_roundtrip_context_replay_conflicts_and_absent_profile_no_creation(self):
        request = self.request()
        code, response = self.cli(request); self.assertEqual(code, 0)
        record = response["result"]["files"][0]
        context_request = {"command": "project_files_context", "project_id": self.project["id"], "expected_project_revision": 1,
                           "selections": [self.selection(record)]}
        self.assertEqual(self.cli(context_request)[1]["result"], self.context(context_request["selections"]))
        self.assertTrue(self.cli(request)[1]["result"]["replayed"])
        code, response = self.cli({**request, "operation_id": str(uuid.uuid4())})
        self.assertEqual(code, 1); self.assertEqual(response["error"]["code"], "CONFLICT")
        removed = self.cli(self.remove_request(record))[1]
        self.assertTrue(removed["ok"]); self.assertEqual(removed["result"]["files"], [])
        unused = self.root / "unused"
        for payload in ({"command": "project_files_list", "project_id": self.project["id"], "expected_project_revision": 1},
                        context_request, request, {**request, "authority": files.AUTHORITY}):
            code, value = self.cli(payload, unused)
            self.assertEqual(code, 1); self.assertEqual(value["error"]["code"], "INVALID_REQUEST")
            self.assertFalse(unused.exists())


if __name__ == "__main__": unittest.main()
