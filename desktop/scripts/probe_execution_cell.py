"""Opt-in, fixed-code WSL/Bubblewrap proof. Not an application execution API.

No guest starts, package installs, shell commands, host directory mounts or model
code are accepted. Guest writes occur in fresh tmpfs mounts only. The optional
receipt is the only host file written. See --help before running this live probe.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time

DISTRO = "Ubuntu-24.04"
WSL = r"C:\Windows\System32\wsl.exe"
MAX_OUTPUT = 65536
CANARY = "YUR_EXECUTION_CELL_CANARY"
CANARY_VALUE = "fixture-only-no-user-secret"
MODES = frozenset({"boundaries", "memory", "cpu", "wall", "output", "cancel", "compile", "unittest", "serial", "abi_x86", "abi_x32", "exec_limits"})

# These strings are audited, fixed Python programs. No shell interprets them.
# JSON on stdin contains mode/fixture port only, never source or argv.
GUEST_PROBE = r'''
import errno, hashlib, io, json, os, pathlib, resource, socket, sys, time
request = json.load(sys.stdin)
if set(request) != {"mode", "port"} or request["mode"] not in {"boundaries", "memory", "cpu", "wall", "output", "cancel", "compile", "unittest", "serial", "abi_x86", "abi_x32", "exec_limits"}:
    raise ValueError("Invalid fixed probe request")
mode = request["mode"]
def emit(data): print(json.dumps(data, sort_keys=True), flush=True)
emit({"ready": True, "mode": mode, "pid": os.getpid()})
if mode == "boundaries":
    denied = {}
    for name in ("/mnt/c", "/mnt/d", "/home", "/run"):
        try: os.stat(name); denied[name] = False
        except (FileNotFoundError, PermissionError): denied[name] = True
    writes = {}
    for name in ("/forbidden-probe", "/usr/forbidden-probe", "/work/allowed-probe", "/tmp/allowed-probe"):
        try:
            pathlib.Path(name).write_text("fixed temporary fixture", encoding="utf-8")
            writes[name] = {"allowed": True}
        except OSError as error: writes[name] = {"allowed": False, "errno": error.errno}
    try:
        with socket.create_connection(("127.0.0.1", request["port"]), timeout=0.5): network_blocked = False
    except OSError: network_blocked = True
    file_limit = False
    try:
        with open("/work/file-limit", "wb") as target:
            for _ in range(33): target.write(b"x" * 65536)
    except OSError as error: file_limit = error.errno == errno.EFBIG
    status = pathlib.Path("/proc/self/status").read_text()
    security = {line.split(":",1)[0]: line.split(":",1)[1].strip() for line in status.splitlines() if line.startswith(("CapEff:", "CapBnd:", "NoNewPrivs:", "Seccomp:"))}
    emit({"denied_paths": denied, "writes": writes, "network_blocked": network_blocked,
          "network_namespace": os.readlink("/proc/self/ns/net"), "environment": dict(os.environ),
          "file_size_limit": file_limit, "security": security,
          "limits": {name: resource.getrlimit(getattr(resource, name)) for name in ("RLIMIT_AS", "RLIMIT_CPU", "RLIMIT_FSIZE", "RLIMIT_NOFILE", "RLIMIT_NPROC")},
          "mounts": [line for line in pathlib.Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[4] in ("/", "/usr", "/tmp", "/work", "/proc", "/dev", "/dev/shm")]})
elif mode == "memory":
    try: value = bytearray(256 * 1024 * 1024); emit({"memory_denied": False})
    except MemoryError: emit({"memory_denied": True})
elif mode == "cpu":
    while True: pass
elif mode in ("wall", "cancel"):
    time.sleep(30)
elif mode == "output":
    while True: os.write(1, b"x" * 4096)
elif mode == "compile":
    import py_compile
    source = pathlib.Path("/work/example.py")
    source.write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    output = py_compile.compile(str(source), doraise=True)
    emit({"compiled": True, "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "artifact_sha256": hashlib.sha256(pathlib.Path(output).read_bytes()).hexdigest(), "artifact_path": output})
elif mode == "unittest":
    import unittest
    class ArithmeticFixture(unittest.TestCase):
        def test_add(self): self.assertEqual(2 + 3, 5)
        def test_multiply(self): self.assertEqual(2 * 3, 6)
    result = unittest.TextTestRunner(stream=io.StringIO()).run(unittest.defaultTestLoader.loadTestsFromTestCase(ArithmeticFixture))
    emit({"tests_run": result.testsRun, "passed": result.wasSuccessful()})
elif mode == "serial":
    import ctypes, subprocess, threading
    denied = {}
    try:
        pid = os.fork()
        if pid == 0: os._exit(0)
        os.waitpid(pid, 0); denied["fork"] = False
    except OSError as error: denied["fork"] = error.errno == errno.EPERM
    try:
        child = subprocess.Popen(["/usr/bin/true"]); child.wait(timeout=1); denied["subprocess"] = False
    except OSError as error: denied["subprocess"] = error.errno == errno.EPERM
    thread_ran = []
    try:
        thread = threading.Thread(target=lambda: thread_ran.append(True)); thread.start(); thread.join(1); denied["thread"] = False
    except RuntimeError: denied["thread"] = not thread_ran
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    libc = ctypes.CDLL(None, use_errno=True); libc.syscall.restype = ctypes.c_long
    for name in ("clone", "clone3"):
        number = lib.seccomp_syscall_resolve_name(name.encode())
        if number < 0: raise RuntimeError("Unresolved syscall")
        ctypes.set_errno(0)
        outcome = libc.syscall(ctypes.c_long(number), 0, 0, 0, 0, 0)
        if outcome == 0: os._exit(0)
        if outcome > 0: os.waitpid(outcome, 0)
        denied[name] = outcome == -1 and ctypes.get_errno() == errno.EPERM
    hard_denied = {}
    for name in ("RLIMIT_AS", "RLIMIT_CPU", "RLIMIT_FSIZE", "RLIMIT_NOFILE", "RLIMIT_NPROC", "RLIMIT_CORE"):
        limit = getattr(resource, name); soft, hard = resource.getrlimit(limit)
        try: resource.setrlimit(limit, (soft, hard + 1)); hard_denied[name] = False
        except (ValueError, OSError): hard_denied[name] = True
    emit({"creation_denied": denied, "hard_limit_raise_denied": hard_denied,
          "remaining_children": pathlib.Path(f"/proc/self/task/{os.getpid()}/children").read_text().strip()})
elif mode in ("abi_x86", "abi_x32"):
    import ctypes, mmap, struct
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_arch_resolve_name.argtypes = [ctypes.c_char_p]; lib.seccomp_arch_resolve_name.restype = ctypes.c_uint32
    lib.seccomp_syscall_resolve_name_arch.argtypes = [ctypes.c_uint32, ctypes.c_char_p]
    number = lib.seccomp_syscall_resolve_name_arch(lib.seccomp_arch_resolve_name(mode[4:].encode()), b"getpid")
    if number < 0: raise RuntimeError("Unresolved alternate ABI syscall")
    libc = ctypes.CDLL(None, use_errno=True); libc.syscall.restype = ctypes.c_long
    emit({"alternate_abi_attempt": mode[4:], "resolved_getpid": number})
    if mode == "abi_x32": libc.syscall(ctypes.c_long(number))
    else:
        # Fixed x86-64 callable trampoline: mov eax,<library-resolved getpid>;
        # int 0x80; ret. This tests the i386 audit architecture without a fork.
        machine_code = b"\xb8" + struct.pack("<I", number) + b"\xcd\x80\xc3"
        memory = mmap.mmap(-1, mmap.PAGESIZE, prot=mmap.PROT_READ | mmap.PROT_WRITE)
        memory.write(machine_code)
        address = ctypes.addressof(ctypes.c_char.from_buffer(memory))
        libc.mprotect.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        if libc.mprotect(address, mmap.PAGESIZE, mmap.PROT_READ | mmap.PROT_EXEC) != 0: raise RuntimeError("Cannot prepare fixed ABI probe")
        ctypes.CFUNCTYPE(ctypes.c_long)(address)()
    emit({"alternate_abi_survived": True})
elif mode == "exec_limits":
    before = time.process_time()
    while time.process_time() - before < 0.2: pass
    next_program = 'import json,resource,time; print(json.dumps({"exec_cpu_limit":resource.getrlimit(resource.RLIMIT_CPU),"exec_as_limit":resource.getrlimit(resource.RLIMIT_AS),"cpu_used_before_exec":time.process_time()}),flush=True)\nwhile True: pass'
    os.execv("/usr/bin/python3", ["/usr/bin/python3", "-I", "-B", "-c", next_program])
'''

# Public libseccomp constants come from its seccomp.h (not guessed syscall
# numbers). The library resolves every architecture/syscall and compiles BPF.
# Only the native x86-64 ABI is admitted. Other ABIs terminate with SIGSYS.
SECCOMP_BUILDER = r'''
import ctypes, errno, fcntl, hashlib, json, os, sys
lib = ctypes.CDLL("libseccomp.so.2")
lib.seccomp_init.argtypes = [ctypes.c_uint32]; lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_release.argtypes = [ctypes.c_void_p]
lib.seccomp_arch_native.restype = ctypes.c_uint32
lib.seccomp_arch_resolve_name.argtypes = [ctypes.c_char_p]; lib.seccomp_arch_resolve_name.restype = ctypes.c_uint32
lib.seccomp_arch_exist.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
lib.seccomp_syscall_resolve_name_arch.argtypes = [ctypes.c_uint32, ctypes.c_char_p]
lib.seccomp_attr_set.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32]
lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
class Version(ctypes.Structure): _fields_ = [("major", ctypes.c_uint), ("minor", ctypes.c_uint), ("micro", ctypes.c_uint)]
lib.seccomp_version.restype = ctypes.POINTER(Version)
native = lib.seccomp_arch_native()
if native != lib.seccomp_arch_resolve_name(b"x86_64") or not native: raise RuntimeError("Only verified x86_64 serial profile is admitted")
context = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
if not context: raise RuntimeError("Cannot initialize seccomp")
try:
    if lib.seccomp_attr_set(context, 2, 0x80000000) != 0: raise RuntimeError("Cannot set SCMP_FLTATR_ACT_BADARCH=KILL_PROCESS")
    for arch in (b"x86", b"x32"):
        token = lib.seccomp_arch_resolve_name(arch)
        if not token or lib.seccomp_arch_exist(context, token) != -errno.EEXIST: raise RuntimeError("Unexpected alternate ABI admission")
    numbers = {}
    for name in ("fork", "vfork", "clone", "clone3"):
        number = lib.seccomp_syscall_resolve_name_arch(native, name.encode())
        if number < 0: raise RuntimeError("Unresolved native syscall: " + name)
        if lib.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0: raise RuntimeError("Cannot deny syscall: " + name)
        numbers[name] = number
    policy_fd = os.memfd_create("yur-serial-seccomp", os.MFD_ALLOW_SEALING)
    if lib.seccomp_export_bpf(context, policy_fd) != 0: raise RuntimeError("Cannot export seccomp BPF")
finally: lib.seccomp_release(context)
length = os.lseek(policy_fd, 0, os.SEEK_END)
if not 0 < length <= 65536 or length % 8: raise RuntimeError("Invalid BPF program length")
os.lseek(policy_fd, 0, os.SEEK_SET); policy_bytes = os.read(policy_fd, length); os.lseek(policy_fd, 0, os.SEEK_SET)
fcntl.fcntl(policy_fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
os.set_inheritable(policy_fd, True)
version = lib.seccomp_version().contents
print(json.dumps({"serial_policy": {"native_arch": native, "syscalls_denied": numbers, "bad_arch_action": "KILL_PROCESS", "bpf_sha256": hashlib.sha256(policy_bytes).hexdigest(), "bpf_bytes": length, "libseccomp_version": f"{version.major}.{version.minor}.{version.micro}"}}), file=sys.stderr, flush=True)
'''

SERVER_PROBE = r'''
import json, os, selectors, signal, socket, sys
signal.alarm(90)
server = socket.socket()
server.bind(("127.0.0.1", 0)); server.listen(2)
print(json.dumps({"port": server.getsockname()[1], "network_namespace": os.readlink("/proc/self/ns/net"), "canary_present": os.environ.get("YUR_EXECUTION_CELL_CANARY") == "fixture-only-no-user-secret"}), flush=True)
selector = selectors.DefaultSelector(); selector.register(server, selectors.EVENT_READ); selector.register(sys.stdin, selectors.EVENT_READ)
while True:
    for key, _ in selector.select(2):
        if key.fileobj is sys.stdin: server.close(); sys.exit(0)
        connection, _ = server.accept()
        with connection: connection.sendall(b"YUR_CELL_CONTROLLED_LOOPBACK")
'''

BASELINE_PROBE = r'''
import json, socket, sys
request = json.load(sys.stdin)
with socket.create_connection(("127.0.0.1", request["port"]), timeout=1) as connection:
    print(json.dumps({"reachable": connection.recv(128) == b"YUR_CELL_CONTROLLED_LOOPBACK"}))
'''

# Only the captured child PID is inspected/signalled. pidfd pins process identity;
# start-time comparison prevents a reused PID from becoming a cancellation target.
PROCESS_PROBE = r'''
import json, os, pathlib, signal, sys
request = json.load(sys.stdin)
pid = request["pid"]
if type(pid) is not int or pid < 2 or set(request) != {"pid", "start_time", "cancel"}: raise ValueError("Invalid exact process request")
try:
    fd = os.pidfd_open(pid)
    try:
        stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
        fields = stat[stat.rfind(")")+2:].split()
        start = fields[19]
        same = request["start_time"] is None or request["start_time"] == start
        if request["cancel"] and request["start_time"] is not None and same: signal.pidfd_send_signal(fd, signal.SIGKILL)
        print(json.dumps({"exists": fields[0] != "Z", "start_time": start, "same_process": same, "cancelled": bool(request["cancel"] and request["start_time"] is not None and same)}))
    finally: os.close(fd)
except ProcessLookupError: print(json.dumps({"exists": False, "cancelled": False}))
except FileNotFoundError: print(json.dumps({"exists": False, "cancelled": False}))
'''


def clean_environment():
    return {"SystemRoot": r"C:\Windows", "WINDIR": r"C:\Windows",
            "WSLENV": CANARY, CANARY: CANARY_VALUE}


def decode_wsl(data):
    return data.decode("utf-16-le" if b"\x00" in data else "utf-8", errors="replace")


def running_distributions(text):
    return set(re.findall(r"^\s*\*?\s*(\S+)\s+Running\s+2\s*$", text, flags=re.MULTILINE))


def wsl_status():
    result = subprocess.run([WSL, "--list", "--verbose"], capture_output=True,
                            timeout=8, env=clean_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode != 0:
        raise RuntimeError("Cannot verify already-running WSL distributions: " + decode_wsl(result.stderr)[:1000])
    text = decode_wsl(result.stdout)
    if DISTRO not in running_distributions(text):
        raise RuntimeError("Ubuntu-24.04 is not already running; the probe will not boot it")
    return text


def guest_argv(code):
    return [WSL, "-d", DISTRO, "--exec", "/usr/bin/python3", "-I", "-B", "-c", code]


def bwrap_argv(mode):
    if mode not in MODES:
        raise ValueError("Unknown fixed probe mode")
    return ["/usr/bin/bwrap",
            "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
            "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev",
            "--size", "1048576", "--tmpfs", "/dev/shm", "--remount-ro", "/dev",
            "--size", "16777216", "--tmpfs", "/tmp",
            "--size", "16777216", "--tmpfs", "/work", "--remount-ro", "/",
            "--chdir", "/work", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
            "--json-status-fd", "2", "--seccomp", "POLICY_FD", "/usr/bin/prlimit", "--as=134217728:134217728",
            "--cpu=1:2", "--fsize=1048576:1048576", "--nofile=64:64", "--nproc=32:32", "--core=0:0",
            "/usr/bin/python3", "-I", "-B", "-c", GUEST_PROBE]


def cell_argv(mode):
    command = bwrap_argv(mode)
    # The outer fixed launcher creates the anonymous, sealed BPF descriptor;
    # timeout runs outside the filtered namespace because it needs one fork.
    # No request field can change this command, filter or source code.
    launcher = SECCOMP_BUILDER + "\ncommand = " + repr(command) + r'''
command[command.index("POLICY_FD")] = str(policy_fd)
os.execve("/usr/bin/timeout", ["/usr/bin/timeout", "--signal=TERM", "--kill-after=1s", "4s"] + command,
          {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "YUR_EXECUTION_CELL_CANARY": "fixture-only-no-user-secret"})
'''
    return guest_argv(launcher)


def guest_call(code, payload):
    wsl_status()
    result = subprocess.run(guest_argv(code), input=json.dumps(payload).encode(), capture_output=True,
                            timeout=8, env=clean_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode or len(result.stdout) > MAX_OUTPUT or len(result.stderr) > MAX_OUTPUT:
        raise RuntimeError("Fixed guest helper failed: " + result.stderr[:1000].decode(errors="replace"))
    return json.loads(result.stdout)


def process_state(pid, start_time=None, cancel=False):
    return guest_call(PROCESS_PROBE, {"pid": pid, "start_time": start_time, "cancel": cancel})


def _reader(stream, channel, events):
    try:
        while chunk := os.read(stream.fileno(), 4096):
            events.put((channel, chunk))
    finally:
        events.put((channel, None))


def run_cell(mode, port):
    wsl_status()
    command = cell_argv(mode)
    started = time.monotonic()
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=clean_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
    events = queue.Queue(maxsize=64)
    for channel, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
        threading.Thread(target=_reader, args=(stream, channel, events), daemon=True).start()
    process.stdin.write(json.dumps({"mode": mode, "port": port}).encode()); process.stdin.close()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    done = set()
    pid = None
    identity = None
    cancellation = None
    output_limited = False
    host_timeout = False
    try:
        while len(done) < 2:
            if time.monotonic() - started > 12:
                host_timeout = True
                if pid and identity and identity.get("exists"):
                    cancellation = process_state(pid, identity["start_time"], True)
                process.kill()
                break
            try: channel, chunk = events.get(timeout=0.05)
            except queue.Empty: continue
            if chunk is None:
                done.add(channel); continue
            remaining = MAX_OUTPUT - len(buffers[channel])
            buffers[channel].extend(chunk[:max(remaining, 0)])
            if len(chunk) > remaining: output_limited = True
            if pid is None:
                for line in buffers["stderr"].splitlines():
                    try: candidate = json.loads(line)
                    except (ValueError, UnicodeDecodeError): continue
                    if type(candidate.get("child-pid")) is int:
                        pid = candidate["child-pid"]
                        identity = process_state(pid)
                        break
            ready = b'"ready": true' in buffers["stdout"]
            if cancellation is None and pid and identity and identity.get("exists") and ((mode == "cancel" and ready) or output_limited):
                cancellation = process_state(pid, identity["start_time"], True)
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            if pid and identity and identity.get("exists"):
                process_state(pid, identity["start_time"], True)
            process.kill(); process.wait(timeout=5)
        process.stdout.close(); process.stderr.close()
    records = []
    for line in buffers["stdout"].splitlines():
        try: records.append(json.loads(line))
        except (ValueError, UnicodeDecodeError): pass
    final_identity = process_state(pid, identity.get("start_time") if identity else None) if pid else None
    return {"mode": mode, "returncode": process.returncode, "elapsed_seconds": round(time.monotonic()-started, 3),
            "records": records, "stdout_bytes_retained": len(buffers["stdout"]),
            "stderr": buffers["stderr"].decode(errors="replace"), "output_limited": output_limited,
            "host_timeout": host_timeout, "cancellation": cancellation, "child_after": final_identity,
            "command_sha256": hashlib.sha256(json.dumps(command).encode()).hexdigest()}


def _last(case):
    return case["records"][-1] if case["records"] else {}


def assess(cases, server, baseline):
    indexed = {case["mode"]: case for case in cases}
    boundary = _last(indexed["boundaries"])
    mounts = boundary.get("mounts", [])
    def mount_has(target, text):
        return any(line.split()[4] == target and text in line for line in mounts)
    checks = {
        "outside_controlled_server_reachable": baseline.get("reachable") is True,
        "fixture_environment_reached_guest": server.get("canary_present") is True,
        "isolated_python_executed": indexed["boundaries"]["returncode"] == 0,
        "host_paths_absent": all(boundary.get("denied_paths", {}).get(path) is True for path in ("/mnt/c", "/mnt/d", "/home", "/run")),
        "network_namespace_distinct": bool(boundary.get("network_namespace")) and boundary["network_namespace"] != server["network_namespace"],
        "controlled_server_blocked": boundary.get("network_blocked") is True,
        "environment_cleared": CANARY not in boundary.get("environment", {}) and set(boundary.get("environment", {})) <= {"PATH", "LANG", "PWD"},
        "capabilities_dropped": boundary.get("security", {}).get("CapEff") == "0000000000000000" and boundary.get("security", {}).get("CapBnd") == "0000000000000000",
        "no_new_privileges": boundary.get("security", {}).get("NoNewPrivs") == "1",
        "root_and_runtime_readonly": all(boundary.get("writes", {}).get(path, {}).get("errno") == 30 for path in ("/forbidden-probe", "/usr/forbidden-probe")),
        "temporary_filesystems_writable_and_capped": all(boundary.get("writes", {}).get(path, {}).get("allowed") is True for path in ("/work/allowed-probe", "/tmp/allowed-probe")) and mount_has("/work", "size=16384k") and mount_has("/tmp", "size=16384k"),
        "file_size_limit": boundary.get("file_size_limit") is True,
        "address_space_limit": _last(indexed["memory"]).get("memory_denied") is True,
        "cpu_limit": indexed["cpu"]["returncode"] in (137, 152, -9, -24) and indexed["cpu"]["elapsed_seconds"] < 6,
        "wall_limit": indexed["wall"]["returncode"] == 124 and indexed["wall"]["elapsed_seconds"] < 8,
        "output_limit": indexed["output"]["output_limited"] and indexed["output"]["stdout_bytes_retained"] <= MAX_OUTPUT,
        "exact_child_cancelled": (indexed["cancel"].get("cancellation") or {}).get("cancelled") is True and not (indexed["cancel"].get("child_after") or {}).get("exists", True),
        "all_children_gone": all(case.get("child_after") is not None and case["child_after"].get("exists") is False for case in cases),
        "python_compile_profile": _last(indexed["compile"]).get("compiled") is True,
        "python_unittest_profile": _last(indexed["unittest"]).get("passed") is True and _last(indexed["unittest"]).get("tests_run") == 2,
        "no_host_deadline_fallback": not any(case["host_timeout"] for case in cases),
        "seccomp_active": boundary.get("security", {}).get("Seccomp") == "2",
        "device_and_proc_mounts_readonly": all(any(line.split()[4] == target and "ro" in line.split()[5].split(",") for line in mounts) for target in ("/dev", "/proc")),
        "shared_memory_tmpfs_capped": mount_has("/dev/shm", "size=1024k"),
        "process_and_thread_creation_denied": all(_last(indexed["serial"]).get("creation_denied", {}).get(name) is True for name in ("fork", "subprocess", "thread", "clone", "clone3")),
        "hard_limit_increases_denied": all(_last(indexed["serial"]).get("hard_limit_raise_denied", {}).get(name) is True for name in ("RLIMIT_AS", "RLIMIT_CPU", "RLIMIT_FSIZE", "RLIMIT_NOFILE", "RLIMIT_NPROC", "RLIMIT_CORE")),
        "no_fork_children": _last(indexed["serial"]).get("remaining_children") == "",
        "alternate_x86_abi_killed": indexed["abi_x86"]["returncode"] in (159, -31) and _last(indexed["abi_x86"]).get("alternate_abi_attempt") == "x86",
        "alternate_x32_abi_killed": indexed["abi_x32"]["returncode"] in (159, -31) and _last(indexed["abi_x32"]).get("alternate_abi_attempt") == "x32",
        "limits_survive_exec": indexed["exec_limits"]["returncode"] in (152, -24) and _last(indexed["exec_limits"]).get("exec_cpu_limit") == [1, 2] and _last(indexed["exec_limits"]).get("exec_as_limit") == [134217728, 134217728] and _last(indexed["exec_limits"]).get("cpu_used_before_exec", 0) >= 0.2,
    }
    return checks


def probe():
    before = wsl_status()
    server = subprocess.Popen(guest_argv(SERVER_PROBE), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=clean_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
    events = queue.Queue()
    threading.Thread(target=lambda: events.put(server.stdout.readline()), daemon=True).start()
    try:
        server_info = json.loads(events.get(timeout=8))
        baseline = guest_call(BASELINE_PROBE, {"port": server_info["port"]})
        cases = [run_cell(mode, server_info["port"]) for mode in ("boundaries", "memory", "cpu", "wall", "output", "cancel", "compile", "unittest", "serial", "abi_x86", "abi_x32", "exec_limits")]
    finally:
        server.stdin.close()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill(); server.wait(timeout=5)
        server.stdout.close(); server.stderr.close()
    checks = assess(cases, server_info, baseline)
    after = wsl_status()
    checks["no_new_running_distributions"] = running_distributions(before) == running_distributions(after)
    source = Path(__file__).resolve()
    return {"schema": "yur.execution-cell-probe.v1", "completed_at": datetime.now(timezone.utc).isoformat(),
            "passed": all(checks.values()), "checks": checks, "cases": cases, "guest_server": server_info,
            "distro": DISTRO, "wsl_before": before, "wsl_after": after,
            "source": {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
            "fixed_command": cell_argv("boundaries"), "bwrap_command": bwrap_argv("boundaries"),
            "profiles": ["serial-python-compile-fixture", "serial-python-unittest-fixture"],
            "profile_limitations": ["No fork, subprocess, multiprocessing or thread-dependent tests", "Only native x86_64 ABI; other ABIs terminate", "Read-only guest /usr and temporary scratch mounts only"],
            "unproven": ["Arbitrary or hostile repository code admission", "Aggregate cgroup controls and broader kernel-resource syscall policy beyond process/thread creation", "Read-only /usr runtime supply-chain pinning", "Staged workspace transfer, diff validation and CommitService integration", "Automatic recovery after host/WSL failure", "Kernel vulnerability resistance", "Node or dependency installation"],
            "references": ["https://github.com/containers/bubblewrap/blob/main/README.md", "https://manpages.debian.org/bookworm/bubblewrap/bwrap.1.en.html", "https://github.com/seccomp/libseccomp/blob/main/include/seccomp.h.in", "https://github.com/seccomp/libseccomp/blob/main/doc/man/man3/seccomp_arch_add.3", "https://github.com/seccomp/libseccomp/blob/main/doc/man/man3/seccomp_syscall_resolve_name.3"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Explicitly run fixed probes in already-running Ubuntu-24.04")
    parser.add_argument("--receipt", type=Path, help="Create a new proof JSON file; refuses overwrite")
    args = parser.parse_args()
    if not args.run:
        parser.error("Live containment proof requires --run")
    if args.receipt and args.receipt.exists():
        parser.error("Receipt already exists; choose a new file")
    try:
        report = probe()
    except Exception as error:
        report = {"schema": "yur.execution-cell-probe.v1", "passed": False, "error": {"type": type(error).__name__, "message": str(error)[:2000]}, "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    if args.receipt:
        with args.receipt.open("x", encoding="utf-8") as target:
            json.dump(report, target, indent=2)
    print(json.dumps({key: value for key, value in report.items() if key not in ("fixed_command", "bwrap_command", "cases")}, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
