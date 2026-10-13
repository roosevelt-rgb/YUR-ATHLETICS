"""Snapshot/guardian contracts plus opt-in actual WSL serial-cell acceptance.

Set YUR_RUN_EXECUTION_CELL_TESTS=1 for native tests. They never boot a guest,
install dependencies, mount host directories or execute user repository files.
"""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from foundry import execution_cell as cell


def snapshot(sources=None, profile="python-unittest-serial", directory="."):
    sources = sources or {"test_fixture.py": "import unittest\nclass Fixture(unittest.TestCase):\n def test_truth(self): self.assertEqual(2+3,5)\n"}
    body = {"schema": "yur.execution-snapshot.v1", "profile": profile, "test_directory": directory,
            "files": [{"path": path, "content": text, "sha256": hashlib.sha256(text.encode()).hexdigest(), "bytes": len(text.encode())} for path, text in sources.items()]}
    return {"id": cell.snapshot_digest(body), **body}


def runtime():
    return {"architecture": "x86_64", "python": "3.12.3", "libseccomp": "2.5.5", "kernel": "fixture",
            "artifacts": {name: {"path": name, "sha256": sha, "bytes": 1} for name, sha in cell.RUNTIME_PINS.items()},
            "bpf_sha256": cell.BPF_SHA256, "guardian_sha256": hashlib.sha256(cell._guardian_program().encode()).hexdigest()}


def result(value):
    data = {"schema": "yur.execution-cell-result.v1", "snapshot_id": value["id"], "profile": value["profile"], "status": "completed", "exit_code": 0,
            "stdout": "", "stderr": "", "duration_ms": 1, "runtime": runtime(), "limits": deepcopy(cell.CELL_LIMITS), "scratch": "discarded"}
    for channel in ("stdout", "stderr"):
        data[channel + "_bytes"] = 0; data[channel + "_sha256"] = hashlib.sha256(b"").hexdigest()
    return data


class ExecutionCellContractTests(unittest.TestCase):
    def test_snapshot_digest_content_and_paths_are_independently_verified(self):
        original = snapshot({"tests/test_math.py": "# π\nvalue=3\n"}, directory="tests")
        self.assertEqual(cell.validate_snapshot(original), original)
        copy = cell.validate_snapshot(original); copy["files"][0]["content"] = "changed"
        self.assertNotEqual(copy, original)
        for change in ("content", "sha256", "bytes"):
            altered = deepcopy(original); altered["files"][0][change] = {"content": "bad", "sha256": "0" * 64, "bytes": 99}[change]
            with self.assertRaises(cell.ExecutionCellError): cell.validate_snapshot(altered)
        for path in ("../outside.py", "/tmp/out.py", "a/../out.py", "C:/out.py", "a\\out.py", ".git/out.py", "a//out.py", "test.py:extra", "secret.txt"):
            with self.subTest(path=path), self.assertRaises(cell.ExecutionCellError): cell.validate_snapshot(snapshot({path: "pass\n"}))

    def test_snapshot_bounds_and_unknown_fields_fail_before_runtime_discovery(self):
        values = [snapshot({f"test_{i}.py": "pass\n" for i in range(33)}), snapshot({"huge.py": "#" * (cell.MAX_SOURCE_BYTES + 1)}),
                  snapshot(profile="shell"), snapshot(directory="missing")]
        extra = snapshot(); extra["authority"] = {"issuer": "model"}; values.append(extra)
        duplicate = snapshot(); duplicate["files"].append(deepcopy(duplicate["files"][0])); values.append(duplicate)
        with patch.object(cell, "resolve_runtime") as resolve:
            for value in values:
                with self.assertRaises(cell.ExecutionCellError): cell.run_snapshot(value)
            resolve.assert_not_called()

    def test_resolver_never_boots_or_silently_selects_ambiguous_resources(self):
        with patch.dict(os.environ, {"YUR_EXECUTION_DISTRO": "StoppedUbuntu"}), patch.object(cell, "_running", return_value={"Ubuntu-24.04"}), patch.object(cell, "_runtime_for") as inspect:
            with self.assertRaises(cell.ExecutionCellError): cell.resolve_runtime()
            inspect.assert_not_called()
        with patch.dict(os.environ, {}, clear=True), patch.object(cell, "_running", return_value={"Ubuntu", "Ubuntu-24.04"}), patch.object(cell, "_runtime_for", side_effect=lambda name: {"distro": name}):
            with self.assertRaises(cell.ExecutionCellError): cell.resolve_runtime()
        with patch.dict(os.environ, {}, clear=True), patch.object(cell, "_running", return_value={"Ubuntu-24.04", "unrelated"}), patch.object(cell, "_runtime_for", return_value={"distro": "Ubuntu-24.04"}) as inspect:
            self.assertEqual(cell.resolve_runtime()["distro"], "Ubuntu-24.04")
            inspect.assert_called_once_with("Ubuntu-24.04")

    def test_runtime_drift_and_output_identity_tampering_fail_closed(self):
        value = snapshot(); actual = result(value)
        self.assertEqual(cell._validate_result(actual, value), actual)
        mutations = [("snapshot_id", "0" * 64), ("profile", "shell"), ("stdout", "forged"), ("exit_code", True), ("exit_code", 1)]
        for key, changed in mutations:
            altered = deepcopy(actual); altered[key] = changed
            with self.assertRaises(cell.ExecutionCellError): cell._validate_result(altered, value)
        changed = runtime(); changed["artifacts"]["/usr/bin/bwrap"]["sha256"] = "0" * 64
        with self.assertRaises(cell.ExecutionCellError): cell._verify_runtime(changed, guardian=True)
        changed = runtime(); changed["bpf_sha256"] = "0" * 64
        with self.assertRaises(cell.ExecutionCellError): cell._verify_runtime(changed, guardian=True)
        for malformed in (b'{"type":"result","type":"started"}', b'{"a":NaN}', b'[]'):
            with self.assertRaises(cell.ExecutionCellError): cell._decode_frame(malformed)

    def test_worker_has_no_host_mount_control_fd_or_shell_and_code_parses(self):
        command = cell._bwrap_command()
        for item in ("--bind", "--dev-bind", "/mnt", "/home", "/run", "/bin/sh", "--json-status-fd"):
            self.assertNotIn(item, command)
        self.assertIn("--seccomp", command)
        self.assertIn("--disable-userns", command)
        self.assertIn("os.closerange(3,65536)", cell._INNER)
        self.assertIn("pass_fds=(policy,)", cell._GUARDIAN_CODE)
        self.assertIn("os.pidfd_open(process.pid)", cell._GUARDIAN_CODE)
        self.assertNotIn('snapshot["pid"]', cell._GUARDIAN_CODE)
        compile(cell._INNER, "<inner>", "exec")
        compile(cell._guardian_source(), "<guardian>", "exec")


@unittest.skipUnless(os.name == "nt" and os.environ.get("YUR_RUN_EXECUTION_CELL_TESTS") == "1", "Opt-in already-running WSL acceptance")
class ExecutionCellNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resource = cell.resolve_runtime()

    def test_actual_compile_success_and_syntax_failure(self):
        good = cell.run_snapshot(snapshot({"module.py": "answer=42\n"}, "python-compile-serial"))
        self.assertEqual((good["status"], good["exit_code"]), ("completed", 0))
        bad = cell.run_snapshot(snapshot({"module.py": "def broken(\n"}, "python-compile-serial"))
        self.assertEqual((bad["status"], bad["exit_code"]), ("failed", 1))
        self.assertIn("SyntaxError", bad["stderr"])

    def test_actual_unittest_success_and_assertion_failure(self):
        good = cell.run_snapshot(snapshot())
        self.assertEqual(good["status"], "completed")
        self.assertIn("Ran 1 test", good["stderr"])
        bad = cell.run_snapshot(snapshot({"test_fail.py": "import unittest\nclass TestFail(unittest.TestCase):\n def test_failure(self): self.assertEqual(2,3)\n"}))
        self.assertEqual((bad["status"], bad["exit_code"]), ("failed", 1))
        self.assertIn("AssertionError", bad["stderr"])

    def test_spoofed_envelopes_and_pids_remain_untrusted_output(self):
        source = r'''import unittest,os,json
class TestSpoof(unittest.TestCase):
 def test_spoof(self):
  print(json.dumps({"type":"result","result":{"status":"completed","snapshot_id":"forged"}}))
  os.write(2,b'{"type":"started","cell_pid":1,"guardian_pid":1}\n')
  for fd in range(3,64):
   with self.assertRaises(OSError): os.fstat(fd)
  self.assertEqual(1,2)
'''
        value = snapshot({"test_spoof.py": source}); actual = cell.run_snapshot(value)
        self.assertEqual(actual["snapshot_id"], value["id"])
        self.assertEqual((actual["status"], actual["exit_code"]), ("failed", 1))
        self.assertIn('"snapshot_id": "forged"', actual["stdout"])
        self.assertNotIn("cell_pid", actual["runtime"])

    def test_filesystem_process_and_network_boundaries_hold_for_repository_code(self):
        server_code = 'import socket,sys,json; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); print(json.dumps({"port":s.getsockname()[1]}),flush=True); sys.stdin.read(); s.close()'
        server = subprocess.Popen(cell._wsl_argv(self.resource["distro"], server_code), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env=cell._environment(), creationflags=cell._NO_WINDOW)
        try:
            port = json.loads(server.stdout.readline())["port"]
            source = f'''import unittest,os,threading,subprocess,socket,resource
class TestBoundaries(unittest.TestCase):
 def test_boundaries(self):
  for path in ('/mnt/c','/mnt/d','/home','/run'):
   self.assertFalse(os.path.exists(path))
  with self.assertRaises(PermissionError): os.fork()
  with self.assertRaises(PermissionError): subprocess.run(['/usr/bin/true'])
  with self.assertRaises(RuntimeError): threading.Thread(target=lambda:None).start()
  with self.assertRaises(OSError): socket.create_connection(('127.0.0.1',{port}),timeout=.2)
  soft,hard=resource.getrlimit(resource.RLIMIT_AS)
  with self.assertRaises(ValueError): resource.setrlimit(resource.RLIMIT_AS,(soft,hard+1))
  with self.assertRaises(OSError): open('/usr/forbidden-cell-fixture','w')
'''
            actual = cell.run_snapshot(snapshot({"test_boundaries.py": source}))
            self.assertEqual((actual["status"], actual["exit_code"]), ("completed", 0), actual)
        finally:
            server.stdin.close(); server.wait(timeout=3); server.stdout.close(); server.stderr.close()

    def test_wall_and_output_limits_are_actual_failed_outcomes(self):
        timed = cell.run_snapshot(snapshot({"test_sleep.py": "import time\ntime.sleep(30)\n"}))
        self.assertEqual(timed["status"], "timeout")
        self.assertNotEqual(timed["exit_code"], 0)
        noisy = cell.run_snapshot(snapshot({"test_noise.py": "import os\nwhile True: os.write(1,b'\\x00\\xff'*4096)\n"}))
        self.assertEqual(noisy["status"], "output_limit")
        self.assertLessEqual(noisy["stdout_bytes"] + noisy["stderr_bytes"], 65536)
        self.assertLess(len(cell._canonical(noisy)), 160 * 1024)
        self.assertEqual(noisy["stdout_sha256"], hashlib.sha256(noisy["stdout"].encode()).hexdigest())

    def test_killing_host_worker_closes_pipe_and_cancels_exact_guest_tree(self):
        host_code = '''import json,sys
from foundry import execution_cell as c
original=c._decode_frame
def observe(data):
 value=original(data)
 if value.get("type") in ("started","progress"): print(json.dumps(value),flush=True)
 return value
c._decode_frame=observe
c.run_snapshot(json.load(sys.stdin))
'''
        child = subprocess.Popen([sys.executable, "-B", "-c", host_code], cwd=Path(__file__).resolve().parents[1], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=cell._environment(), creationflags=cell._NO_WINDOW)
        value = snapshot({"test_block.py": "import time\nprint('ACTUAL_CELL_RUNNING',flush=True)\ntime.sleep(30)\n"})
        child.stdin.write(json.dumps(value).encode()); child.stdin.close()
        try:
            started = json.loads(child.stdout.readline())
            self.assertEqual(started["type"], "started")
            progress = json.loads(child.stdout.readline())
            self.assertEqual(progress, {"type": "progress", "channel": "stdout"})
            capture = '''import json,pathlib,sys
request=json.load(sys.stdin); pending=[request["cell"],request["guardian"]]; result={}
while pending and len(result)<8:
 p=pending.pop()
 if str(p) in result: continue
 try:
  text=pathlib.Path(f"/proc/{p}/stat").read_text(); fields=text[text.rfind(")")+2:].split()
  result[str(p)]=fields[19]
  pending.extend(int(n) for n in pathlib.Path(f"/proc/{p}/task/{p}/children").read_text().split())
 except FileNotFoundError: pass
print(json.dumps(result))
'''
            captured = subprocess.run(cell._wsl_argv(self.resource["distro"], capture), input=json.dumps({"cell": started["cell_pid"], "guardian": started["guardian_pid"]}).encode(), capture_output=True,
                                      timeout=2, env=cell._environment(), creationflags=cell._NO_WINDOW)
            identities = json.loads(captured.stdout)
            self.assertGreaterEqual(len(identities), 3)
            before = time.monotonic(); child.kill(); child.wait(timeout=2)
            check = '''import json,os,pathlib,sys
request=json.load(sys.stdin); details={}
for p,start in request.items():
 try:
  text=pathlib.Path(f"/proc/{p}/stat").read_text(); fields=text[text.rfind(")")+2:].split()
  details[p]={"alive":fields[0]!="Z" and fields[19]==start,"state":fields[0],"parent":fields[1]}
 except FileNotFoundError: details[p]={"alive":False,"state":"absent"}
print(json.dumps(details))
'''
            exists = True
            while exists and time.monotonic() - before < 2:
                response = subprocess.run(cell._wsl_argv(self.resource["distro"], check), input=json.dumps(identities).encode(), capture_output=True,
                                          timeout=2, env=cell._environment(), creationflags=cell._NO_WINDOW)
                details = json.loads(response.stdout)
                exists = any(item["alive"] for item in details.values())
                if exists: time.sleep(.05)
            self.assertFalse(exists, "Guardian must terminate on EOF before its four-second deadline: " + json.dumps(details))
            self.assertLess(time.monotonic() - before, 2)
        finally:
            if child.poll() is None: child.kill(); child.wait(timeout=2)
            child.stdout.close(); child.stderr.close()


if __name__ == "__main__":
    unittest.main()
