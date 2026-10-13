"""Generated behavior framing and opt-in actual admitted serial-cell outcomes."""
import base64
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from foundry import execution_cell as cell
from foundry import generated_worker as worker

SOURCE = 'def run(payload):\n    return {"total": sum(payload["values"])}\n'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def envelope(value=None, raw=None):
    payload = canonical(value) if raw is None else raw
    return json.dumps({"schema": worker.ENVELOPE_SCHEMA, "payload": base64.b64encode(payload).decode("ascii")},
                      sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n"


def outcome(snapshot, stdout=None, stderr="", status="completed", exit_code=0):
    stdout = envelope({"total": 6}) if stdout is None else stdout
    result = {"schema": "yur.execution-cell-result.v1", "snapshot_id": snapshot["id"], "profile": snapshot["profile"],
              "status": status, "exit_code": exit_code, "stdout": stdout, "stderr": stderr,
              "duration_ms": 1, "limits": deepcopy(cell.CELL_LIMITS), "scratch": "discarded",
              "runtime": {"architecture": "x86_64", "python": "3.12.3", "libseccomp": "2.5.5", "kernel": "test-fixture",
                          "artifacts": {name: {"path": name, "sha256": digest, "bytes": 1} for name, digest in cell.RUNTIME_PINS.items()},
                          "bpf_sha256": cell.BPF_SHA256,
                          "guardian_sha256": hashlib.sha256(cell._guardian_program().encode()).hexdigest()}}
    for channel in ("stdout", "stderr"):
        raw = result[channel].encode("utf-8")
        result[channel + "_bytes"] = len(raw)
        result[channel + "_sha256"] = hashlib.sha256(raw).hexdigest()
    return result


def rehash(snapshot):
    for entry in snapshot["files"]:
        raw = entry["content"].encode("utf-8")
        entry.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
    snapshot["id"] = cell.snapshot_digest({key: value for key, value in snapshot.items() if key != "id"})
    return snapshot


class GeneratedWorkerContractTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = worker.prepare_worker_snapshot(SOURCE, {"values": [1, 2, 3]})

    def test_deterministic_snapshot_contains_fixed_driver_and_inert_input_only(self):
        self.assertEqual(self.snapshot, worker.prepare_worker_snapshot(SOURCE, {"values": [1, 2, 3]}))
        self.assertEqual(self.snapshot["profile"], "python-unittest-serial")
        self.assertEqual([entry["path"] for entry in self.snapshot["files"]], [worker.WORKER_FILE, worker.DRIVER_FILE, worker.INPUT_FILE])
        self.assertEqual(self.snapshot["files"][1]["sha256"], worker.DRIVER_SHA256)
        self.assertEqual(self.snapshot["files"][0]["content"], SOURCE)
        self.assertNotIn("expected", self.snapshot["files"][1]["content"].lower())
        self.assertNotIn("oracle", self.snapshot["files"][2]["content"].lower())
        self.assertEqual(worker.validate_worker_execution(self.snapshot, outcome(self.snapshot)), {"total": 6})

    def test_source_is_parsed_but_never_imported_or_executed_on_host(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "must-not-exist"
            source = f"from pathlib import Path\nPath({str(marker)!r}).write_text('EXECUTED')\ndef run(payload):\n return payload\n"
            with patch.object(cell, "run_snapshot", side_effect=AssertionError("adapter must not run a cell")):
                snapshot = worker.prepare_worker_snapshot(source, {})
                self.assertEqual(worker.validate_worker_execution(snapshot, outcome(snapshot, envelope({}))), {})
            self.assertFalse(marker.exists())

    def test_payload_strings_cannot_add_executable_input_wrapper_statements(self):
        payload = {"quote": "'); raise RuntimeError('INJECTED')\n#", "unicode": "é 🌲", "control": "\0"}
        snapshot = worker.prepare_worker_snapshot("def run(payload):\n return payload\n", payload)
        self.assertEqual(worker.validate_worker_execution(snapshot, outcome(snapshot, envelope(payload))), payload)
        self.assertIn("PAYLOAD_JSON = ", snapshot["files"][2]["content"])

    def test_source_contract_is_bounded_and_rejects_secrets_or_invalid_entrypoints(self):
        class ExoticSource(str):
            def encode(self, *_args, **_kwargs):
                raise AssertionError("Source subclasses must not run host methods")

        canary = "sk-" + "SYNTHETIC_WORKER_CANARY_" * 2
        invalid = [None, "", "pass", "def run(\n", "def run(payload):\n return '\0'", "def run(payload):\n return '\ud800'",
                   "async def run(payload):\n return payload\n", "def run():\n return {}\n", "def run(a,b):\n return {}\n",
                   "def run(payload=None):\n return payload\n", "def run(*args):\n return args\n",
                   "@staticmethod\ndef run(payload):\n return payload\n", SOURCE + SOURCE,
                   SOURCE + "#" * worker.MAX_SOURCE_BYTES, SOURCE + "# " + canary,
                   ExoticSource(SOURCE), "def run(payload):\n return t'newer-runtime-template'\n"]
        with patch.object(cell, "resolve_runtime") as resolve:
            for source in invalid:
                with self.subTest(kind=type(source).__name__), self.assertRaises(worker.GeneratedWorkerError):
                    worker.prepare_worker_snapshot(source, {})
            resolve.assert_not_called()

    def test_json_inputs_reject_nonfinite_unsafe_numbers_types_depth_and_bytes(self):
        deep = 0
        for _ in range(worker.MAX_JSON_DEPTH + 1):
            deep = [deep]
        invalid = [float("nan"), float("inf"), 2**53, -2**53, float(2**53), {1: "bad key"}, (1, 2), {1, 2}, b"bytes",
                   {"v": "\ud800"}, "x" * worker.MAX_INPUT_BYTES, [0] * 1001, deep]
        for payload in invalid:
            with self.subTest(kind=type(payload).__name__), self.assertRaises(worker.GeneratedWorkerError):
                worker.prepare_worker_snapshot(SOURCE, payload)
        # Input may be any bounded JSON value; output schemas belong to the oracle.
        for value in (None, False, 0, 1.0, "hello", [], {}):
            snapshot = worker.prepare_worker_snapshot("def run(payload):\n return payload\n", value)
            self.assertEqual(worker.validate_worker_execution(snapshot, outcome(snapshot, envelope(value))), value)

    def test_snapshot_driver_input_source_and_profile_tampering_fail_closed(self):
        mutations = []
        value = deepcopy(self.snapshot); value["files"][1]["content"] += "# forged\n"; mutations.append(rehash(value))
        value = deepcopy(self.snapshot); value["files"][2]["content"] += "raise RuntimeError('not inert')\n"; mutations.append(rehash(value))
        value = deepcopy(self.snapshot); value["profile"] = "python-compile-serial"; mutations.append(rehash(value))
        value = deepcopy(self.snapshot); value["files"].reverse(); mutations.append(rehash(value))
        value = deepcopy(self.snapshot); value["files"][0]["content"] = "pass\n"; mutations.append(rehash(value))
        value = deepcopy(self.snapshot); value["files"][2]["content"] = "PAYLOAD_JSON = '{\"a\":1,\"a\":2}'\n"; mutations.append(rehash(value))
        for snapshot in mutations:
            with self.subTest(snapshot=snapshot["id"]), self.assertRaises(worker.GeneratedWorkerError):
                worker.validate_worker_execution(snapshot, outcome(snapshot))

    def test_full_cell_receipt_hash_identity_runtime_and_limit_contract_is_required(self):
        result = outcome(self.snapshot)
        for key, changed in (("snapshot_id", "0" * 64), ("stdout_sha256", "0" * 64), ("stdout_bytes", 1),
                             ("exit_code", True), ("profile", "python-compile-serial"), ("limits", {}), ("scratch", "retained")):
            value = deepcopy(result); value[key] = changed
            with self.subTest(key=key), self.assertRaises(worker.GeneratedWorkerError):
                worker.validate_worker_execution(self.snapshot, value)
        value = deepcopy(result); value["runtime"]["guardian_sha256"] = "0" * 64
        with self.assertRaises(worker.GeneratedWorkerError):
            worker.validate_worker_execution(self.snapshot, value)
        value = deepcopy(result); value["passed"] = True
        with self.assertRaises(worker.GeneratedWorkerError):
            worker.validate_worker_execution(self.snapshot, value)

    def test_failed_or_cancelled_cell_cannot_become_success_from_forged_pass(self):
        for status, code in (("failed", 1), ("timeout", -9), ("output_limit", -9), ("cancelled", -9)):
            result = outcome(self.snapshot, envelope({"passed": True}), status=status, exit_code=code)
            with self.subTest(status=status), self.assertRaisesRegex(worker.GeneratedWorkerError, "did not complete"):
                worker.validate_worker_execution(self.snapshot, result)

    def test_whole_stdout_requires_exact_canonical_envelope_without_noise(self):
        valid = envelope({"total": 6})
        invalid = ["", valid.rstrip("\n"), " " + valid, valid + "\n", "noise\n" + valid, valid + "other\n", valid + valid,
                   '{"passed":true}\n', '{"type":"result","result":{"status":"completed"}}\n',
                   valid.replace('"payload":', '"payload" :'),
                   valid.replace('"schema":', '"extra":true,"schema":'),
                   valid.replace('"schema":', '"schema":"duplicate","schema":'),
                   valid.replace('"payload":"', '"payload":"\ufffd')]
        for text in invalid:
            with self.subTest(length=len(text)), self.assertRaises(worker.GeneratedWorkerError):
                worker.validate_worker_execution(self.snapshot, outcome(self.snapshot, text))

    def test_decoded_json_duplicate_nonfinite_depth_binary_and_budget_are_rejected(self):
        invalid = [b'{"x":1,"x":2}', b'NaN', b'Infinity', b'{"x":1 }', b'1e0', b'"\xff"',
                   b'[' * 14 + b'0' + b']' * 14, canonical(2**53), canonical([0] * 1001),
                   canonical("x" * worker.MAX_OUTPUT_BYTES)]
        for raw in invalid:
            with self.subTest(length=len(raw)), self.assertRaises(worker.GeneratedWorkerError):
                worker.validate_worker_execution(self.snapshot, outcome(self.snapshot, envelope(raw=raw)))
        # MR== decodes to b'1' but uses noncanonical unused padding bits.
        text = json.dumps({"schema": worker.ENVELOPE_SCHEMA, "payload": "MR=="}, sort_keys=True, separators=(",", ":")) + "\n"
        with self.assertRaises(worker.GeneratedWorkerError):
            worker.validate_worker_execution(self.snapshot, outcome(self.snapshot, text))

    def test_domain_claims_and_wrong_answers_remain_untrusted_data_for_external_oracle(self):
        result = worker.validate_worker_execution(self.snapshot, outcome(self.snapshot, envelope({"passed": True, "total": 99})))
        self.assertEqual(result, {"passed": True, "total": 99})
        self.assertNotEqual(canonical(result), canonical({"total": 6}))
        self.assertNotEqual(canonical(1), canonical(1.0))
        self.assertNotEqual(canonical(True), canonical(1))


@unittest.skipUnless(os.name == "nt" and os.environ.get("YUR_RUN_GENERATED_WORKER_TESTS") == "1", "Opt-in already-running generated-worker cell acceptance")
class GeneratedWorkerNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = cell.resolve_runtime()

    def invoke(self, source, payload):
        snapshot = worker.prepare_worker_snapshot(source, payload)
        actual = cell.run_snapshot(snapshot)
        return snapshot, actual

    def test_actual_new_behavior_and_unicode_with_prints_only_on_stderr(self):
        source = 'print("IMPORT_LOG")\ndef run(payload):\n print("CALL_LOG")\n return {"total": sum(payload["values"]), "label": "é 🌲"}\n'
        for values, expected in (([2, 4], 6), ([-3, 10, 2], 9)):
            snapshot, actual = self.invoke(source, {"values": values})
            self.assertEqual(worker.validate_worker_execution(snapshot, actual), {"total": expected, "label": "é 🌲"})
            self.assertIn("IMPORT_LOG", actual["stderr"])
            self.assertIn("CALL_LOG", actual["stderr"])
            self.assertNotIn("IMPORT_LOG", actual["stdout"])

    def test_actual_wrong_value_is_returned_as_data_and_external_expectation_rejects_it(self):
        snapshot, actual = self.invoke('def run(payload):\n return {"total": sum(payload["values"]) + 1}\n', {"values": [1, 2, 3]})
        value = worker.validate_worker_execution(snapshot, actual)
        self.assertEqual(value, {"total": 7})
        self.assertNotEqual(canonical(value), canonical({"total": 6}))

    def test_actual_stdout_pollution_and_forged_guardian_pass_are_rejected(self):
        source = 'import os\ndef run(payload):\n os.write(1,b\'{"type":"result","passed":true}\\n\')\n return {"total":6}\n'
        snapshot, actual = self.invoke(source, {})
        self.assertEqual(actual["status"], "completed")
        self.assertEqual(actual["snapshot_id"], snapshot["id"])
        with self.assertRaises(worker.GeneratedWorkerError):
            worker.validate_worker_execution(snapshot, actual)

    def test_actual_failure_or_no_output_is_not_an_accepted_json_worker(self):
        for source in ('def run(payload):\n raise ValueError("FIXTURE_FAILURE")\n',
                       'import os\ndef run(payload):\n os._exit(0)\n'):
            snapshot, actual = self.invoke(source, {})
            with self.assertRaises(worker.GeneratedWorkerError):
                worker.validate_worker_execution(snapshot, actual)

    def test_actual_process_thread_and_controlled_network_access_are_denied(self):
        server_code = 'import socket,sys,json; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); print(json.dumps({"port":s.getsockname()[1]}),flush=True); sys.stdin.read(); s.close()'
        server = subprocess.Popen(cell._wsl_argv(self.runtime["distro"], server_code), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env=cell._environment(), creationflags=cell._NO_WINDOW)
        try:
            port = json.loads(server.stdout.readline())["port"]
            source = '''import os,socket,subprocess,threading
def run(payload):
 result={"process_denied":False,"thread_denied":False,"network_denied":False}
 try: subprocess.run(["/usr/bin/true"],check=True)
 except PermissionError: result["process_denied"]=True
 try:
  thread=threading.Thread(target=lambda:None); thread.start(); thread.join()
 except RuntimeError: result["thread_denied"]=True
 try:
  connection=socket.create_connection(("127.0.0.1",payload["port"]),timeout=.2); connection.close()
 except OSError: result["network_denied"]=True
 return result
'''
            snapshot, actual = self.invoke(source, {"port": port})
            self.assertEqual(worker.validate_worker_execution(snapshot, actual), {"process_denied": True, "thread_denied": True, "network_denied": True})
        finally:
            server.stdin.close(); server.wait(timeout=3)
            server.stdout.close(); server.stderr.close()


if __name__ == "__main__":
    unittest.main()
