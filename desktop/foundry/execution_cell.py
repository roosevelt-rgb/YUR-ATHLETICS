"""Restricted serial Python execution cell; no orchestration or durable writes.

Policy extracted from scripts/probe_execution_cell.py, verified source SHA
74aab6fdff2e7bead430d89e69549bb8412860bd9d2b518500a05fa8d530fa92.
The parent commits the immutable snapshot before calling this adapter and records
the returned exit/output evidence afterward. Test output never becomes control.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
import queue
import re
import subprocess
import threading
import time

PROFILES = ("python-unittest-serial", "python-compile-serial")
MAX_FILES = 32
MAX_SOURCE_BYTES = 128 * 1024
MAX_REQUEST_BYTES = 1024 * 1024
MAX_FRAME_BYTES = 256 * 1024
CELL_LIMITS = {
    "address_space_bytes": 134217728, "cpu_soft_seconds": 1, "cpu_hard_seconds": 2,
    "wall_seconds": 4, "output_bytes_per_stream": 65536, "output_bytes_total": 65536, "file_bytes": 1048576,
    "work_tmpfs_bytes": 16777216, "temp_tmpfs_bytes": 16777216, "shm_tmpfs_bytes": 1048576,
    "open_files": 64, "processes": 32, "new_processes": 0, "new_threads": 0,
}
RUNTIME_PINS = {
    "/usr/bin/python3": "1643dacd9feaedc58f3cc581e4d22577dfe25c09b10282936186ccf0f2e61118",
    "/usr/bin/bwrap": "52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712",
    "/usr/bin/prlimit": "17064f67e650d6152a6902b013aab496b54c87587c8eea6f5023aafee6154069",
    "/usr/lib/x86_64-linux-gnu/libseccomp.so.2": "b4d9140a7797ccf3ac14f5d9d579b64f157111662940cb8330c632b11a8cea8e",
}
BPF_SHA256 = "1e734cb834049b904340a8f9ab70bc0cd21b350fc7fdfcfa4d2b2f2188d4a565"
WSL = r"C:\Windows\System32\wsl.exe"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_HASH = re.compile(r"^[0-9a-f]{64}$")
_DISTRO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ExecutionCellError(RuntimeError):
    def __init__(self, code, message, *, diagnostics=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.diagnostics = _safe_diagnostics(diagnostics)


def _diagnostic_name(value):
    if type(value) is not str or not _DISTRO.fullmatch(value):
        return False
    # Runtime labels are still untrusted metadata. Reuse the source-acquisition
    # detector instead of allowing a credential-shaped label into an error event.
    from .repository_context import SECRET_CONTENT
    return not SECRET_CONTENT.search(value)


def _safe_diagnostics(value):
    """Keep a detached finite metadata envelope; invalid additions are omitted."""
    required = {"schema", "phase", "outcome"}
    optional = {"timeout_seconds", "errno", "winerror", "returncode", "stdout_bytes", "stderr_bytes",
                "stdout_sha256", "stderr_sha256", "selected_distro", "running_distros", "running_distros_truncated"}
    if type(value) is not dict or not required <= value.keys() or set(value) - required - optional:
        return None
    if (not all(type(value[key]) is str for key in required)
            or value["schema"] != "yur.execution-diagnostic.v1"
            or value["phase"] not in {"wsl_status", "runtime_selection", "runtime_verification"}
            or value["outcome"] not in {"timeout", "os_error", "nonzero_exit", "output_limit", "selected_not_running",
                                        "invalid_selection", "ambiguous_selection", "malformed_response", "fingerprint_mismatch"}):
        return None
    for key in ("errno", "winerror", "returncode"):
        if key in value and (type(value[key]) is not int or not -(2**31) <= value[key] <= 2**32 - 1):
            return None
    for key in ("stdout_bytes", "stderr_bytes"):
        if key in value and (type(value[key]) is not int or not 0 <= value[key] <= 2**63 - 1):
            return None
    if "timeout_seconds" in value and (type(value["timeout_seconds"]) not in {int, float}
                                       or not 0 < value["timeout_seconds"] <= 3600):
        return None
    for key in ("stdout_sha256", "stderr_sha256"):
        if key in value and (type(value[key]) is not str or not _HASH.fullmatch(value[key])):
            return None
    if "selected_distro" in value and not _diagnostic_name(value["selected_distro"]):
        return None
    if "running_distros" in value and (type(value["running_distros"]) is not list
            or len(value["running_distros"]) > 32 or not all(_diagnostic_name(name) for name in value["running_distros"])
            or value["running_distros"] != sorted(set(value["running_distros"]))):
        return None
    if "running_distros_truncated" in value and type(value["running_distros_truncated"]) is not bool:
        return None
    if len(_canonical(value)) > 4096:
        return None
    return deepcopy(value)


def _runtime_diagnostic(phase, outcome, *, error=None, result=None, selected=None, running=None):
    """Summarize observed failures without logging streams, argv or environment."""
    value = {"schema": "yur.execution-diagnostic.v1", "phase": phase, "outcome": outcome}
    if isinstance(error, subprocess.TimeoutExpired):
        timeout = error.timeout
        if type(timeout) in {int, float} and 0 < timeout <= 3600:
            value["timeout_seconds"] = timeout
    if isinstance(error, OSError):
        for key in ("errno", "winerror"):
            number = getattr(error, key, None)
            if type(number) is int and -(2**31) <= number <= 2**32 - 1:
                value[key] = number
    if result is not None:
        if type(result.returncode) is int and -(2**31) <= result.returncode <= 2**32 - 1:
            value["returncode"] = result.returncode
        for channel in ("stdout", "stderr"):
            data = getattr(result, channel, None)
            if type(data) is bytes:
                value[channel + "_bytes"] = len(data)
                value[channel + "_sha256"] = hashlib.sha256(data).hexdigest()
    if _diagnostic_name(selected):
        value["selected_distro"] = selected
    if running is not None:
        names = sorted(name for name in running if _diagnostic_name(name))[:32]
        value.update(running_distros=names, running_distros_truncated=len(names) < len(running))
    return value


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def snapshot_digest(body_without_id):
    return hashlib.sha256(_canonical(body_without_id)).hexdigest()


def _relative(value, directory=False):
    if directory and value == ".":
        return value
    if not isinstance(value, str) or not value or len(value) > 240 or any(ord(c) < 32 for c in value) or any(c in value for c in "\\:\x7f"):
        raise ExecutionCellError("invalid", "Snapshot paths must be bounded relative POSIX paths")
    parts = value.split("/")
    if len(parts) > 8 or any(not part or part in (".", "..") or part.startswith(".") or part.endswith((" ", ".")) for part in parts):
        raise ExecutionCellError("invalid", "Snapshot paths contain a forbidden component")
    if not directory and not value.endswith(".py"):
        raise ExecutionCellError("invalid", "Only UTF-8 Python source files are admitted")
    return value


def validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != {"schema", "id", "files", "profile", "test_directory"}:
        raise ExecutionCellError("invalid", "Invalid execution snapshot fields")
    if snapshot["schema"] != "yur.execution-snapshot.v1" or snapshot["profile"] not in PROFILES or not isinstance(snapshot["id"], str) or not _HASH.fullmatch(snapshot["id"]):
        raise ExecutionCellError("invalid", "Invalid snapshot schema, profile or digest")
    _relative(snapshot["test_directory"], directory=True)
    files = snapshot["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ExecutionCellError("invalid", "Snapshot must contain one to 32 Python source files")
    seen, total = set(), 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "content", "sha256", "bytes"}:
            raise ExecutionCellError("invalid", "Invalid snapshot file fields")
        path = _relative(entry["path"])
        if path.casefold() in seen or not isinstance(entry["content"], str) or len(entry["content"]) > MAX_SOURCE_BYTES or "\x00" in entry["content"] or type(entry["bytes"]) is not int:
            raise ExecutionCellError("invalid", "Duplicate path or invalid source content")
        seen.add(path.casefold())
        try: content = entry["content"].encode("utf-8")
        except UnicodeError as error: raise ExecutionCellError("invalid", "Source content must encode as UTF-8") from error
        if len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ExecutionCellError("invalid", "Snapshot source hash or byte count mismatch")
        total += len(content)
    if total > MAX_SOURCE_BYTES:
        raise ExecutionCellError("invalid", "Snapshot exceeds its 128 KiB source budget")
    directory = snapshot["test_directory"]
    if directory != "." and not any(entry["path"].startswith(directory + "/") for entry in files):
        raise ExecutionCellError("invalid", "Test directory is absent from the snapshot")
    try:
        body = {key: value for key, value in snapshot.items() if key != "id"}
        valid = snapshot_digest(body) == snapshot["id"] and len(_canonical(snapshot)) <= MAX_REQUEST_BYTES
    except (ValueError, TypeError, UnicodeError) as error:
        raise ExecutionCellError("invalid", "Snapshot must contain bounded canonical JSON") from error
    if not valid:
        raise ExecutionCellError("invalid", "Snapshot digest mismatch or envelope limit exceeded")
    return deepcopy(snapshot)


# The fixed inner bootstrap sees only its own source snapshot and isolated pipes.
# It closes inherited descriptors before repository imports. Result envelopes,
# timeouts, process identities and output hashes exist only in the outer guardian.
_INNER = r'''
import hashlib,json,os,pathlib,sys
snapshot=json.load(sys.stdin)
for entry in snapshot["files"]:
    data=entry["content"].encode("utf-8")
    if len(data)!=entry["bytes"] or hashlib.sha256(data).hexdigest()!=entry["sha256"]: raise ValueError("Invalid source digest")
    target=pathlib.Path("/work")/entry["path"]
    target.parent.mkdir(parents=True,exist_ok=True)
    with target.open("xb") as output: output.write(data)
os.close(0); os.closerange(3,65536)
sys.argv=[snapshot["profile"]]
sys.dont_write_bytecode=True
if snapshot["profile"]=="python-compile-serial":
    for entry in snapshot["files"]: compile(entry["content"],entry["path"],"exec",dont_inherit=True)
    print("Compiled staged Python sources.")
else:
    import unittest
    sys.path.insert(0,"/work")
    suite=unittest.defaultTestLoader.discover("/work/"+snapshot["test_directory"],pattern="test*.py")
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
'''

_RUNTIME_CODE = r'''
import ctypes,hashlib,json,os,pathlib,platform,subprocess,sys
def verified_runtime():
    if platform.machine()!="x86_64" or tuple(sys.version_info[:3])!=(3,12,3): raise RuntimeError("Unreviewed Python or architecture")
    artifacts={}
    for name,expected in PINS.items():
        target=pathlib.Path(name).resolve(strict=True)
        if not str(target).startswith("/usr/") or not target.is_file() or target.stat().st_size>16777216: raise RuntimeError("Invalid runtime artifact")
        data=target.read_bytes(); actual=hashlib.sha256(data).hexdigest()
        if actual!=expected: raise RuntimeError("Runtime fingerprint changed: "+name)
        artifacts[name]={"path":str(target),"sha256":actual,"bytes":len(data)}
    lib=ctypes.CDLL("/usr/lib/x86_64-linux-gnu/libseccomp.so.2")
    class Version(ctypes.Structure): _fields_=[("major",ctypes.c_uint),("minor",ctypes.c_uint),("micro",ctypes.c_uint)]
    lib.seccomp_version.restype=ctypes.POINTER(Version)
    version=lib.seccomp_version().contents
    if (version.major,version.minor,version.micro)!=(2,5,5): raise RuntimeError("Unreviewed libseccomp version")
    return {"architecture":"x86_64","python":"3.12.3","libseccomp":"2.5.5","artifacts":artifacts,"kernel":platform.release()}
'''

_FILTER_CODE = r'''
def sealed_filter():
    import errno,fcntl
    lib=ctypes.CDLL("/usr/lib/x86_64-linux-gnu/libseccomp.so.2")
    lib.seccomp_init.argtypes=[ctypes.c_uint32]; lib.seccomp_init.restype=ctypes.c_void_p
    lib.seccomp_release.argtypes=[ctypes.c_void_p]
    lib.seccomp_arch_native.restype=ctypes.c_uint32
    lib.seccomp_arch_resolve_name.argtypes=[ctypes.c_char_p]; lib.seccomp_arch_resolve_name.restype=ctypes.c_uint32
    lib.seccomp_arch_exist.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
    lib.seccomp_syscall_resolve_name_arch.argtypes=[ctypes.c_uint32,ctypes.c_char_p]
    lib.seccomp_attr_set.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_uint32]
    lib.seccomp_rule_add.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint32]
    lib.seccomp_export_bpf.argtypes=[ctypes.c_void_p,ctypes.c_int]
    native=lib.seccomp_arch_native()
    if native!=lib.seccomp_arch_resolve_name(b"x86_64") or not native: raise RuntimeError("Unreviewed filter architecture")
    context=lib.seccomp_init(0x7fff0000)
    if not context: raise RuntimeError("Seccomp unavailable")
    try:
        if lib.seccomp_attr_set(context,2,0x80000000)!=0: raise RuntimeError("Cannot deny alternate ABIs")
        for name in (b"x86",b"x32"):
            token=lib.seccomp_arch_resolve_name(name)
            if not token or lib.seccomp_arch_exist(context,token)!=-errno.EEXIST: raise RuntimeError("Unexpected ABI admission")
        for name in (b"fork",b"vfork",b"clone",b"clone3"):
            number=lib.seccomp_syscall_resolve_name_arch(native,name)
            if number<0 or lib.seccomp_rule_add(context,0x00050000|errno.EPERM,number,0)!=0: raise RuntimeError("Cannot enforce serial syscall policy")
        fd=os.memfd_create("yur-serial-policy",os.MFD_ALLOW_SEALING)
        if lib.seccomp_export_bpf(context,fd)!=0: raise RuntimeError("Cannot export serial policy")
    finally: lib.seccomp_release(context)
    size=os.lseek(fd,0,os.SEEK_END)
    if size!=96: raise RuntimeError("Unreviewed BPF program length")
    os.lseek(fd,0,os.SEEK_SET); data=os.read(fd,size); os.lseek(fd,0,os.SEEK_SET)
    if hashlib.sha256(data).hexdigest()!=BPF_HASH: raise RuntimeError("Unreviewed BPF program")
    fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
    return fd
'''

_GUARDIAN_CODE = r'''
import selectors,signal,time
def frame(value):
    try: print(json.dumps(value,separators=(",",":"),ensure_ascii=False),flush=True)
    except BrokenPipeError: pass
def main():
    line=sys.stdin.buffer.readline(1048577)
    if not line.endswith(b"\n") or len(line)>1048576: raise ValueError("Invalid snapshot frame")
    snapshot=json.loads(line)
    if set(snapshot)!={"schema","id","files","profile","test_directory"} or snapshot["schema"]!="yur.execution-snapshot.v1" or snapshot["profile"] not in ("python-unittest-serial","python-compile-serial"): raise ValueError("Invalid snapshot")
    body={k:v for k,v in snapshot.items() if k!="id"}
    canonical=json.dumps(body,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
    if hashlib.sha256(canonical).hexdigest()!=snapshot["id"]: raise ValueError("Invalid snapshot digest")
    paths=set(); total=0
    if not isinstance(snapshot["files"],list) or not 1<=len(snapshot["files"])<=32: raise ValueError("Invalid file count")
    for entry in snapshot["files"]:
        if set(entry)!={"path","content","sha256","bytes"}: raise ValueError("Invalid source fields")
        name=entry["path"]
        if not isinstance(name,str) or not name.endswith(".py") or len(name)>240 or any(c in name for c in "\\:\x7f") or any(ord(c)<32 for c in name): raise ValueError("Invalid source path")
        if any(not part or part in (".","..") or part.startswith(".") or part.endswith((" ",".")) for part in name.split("/")) or len(name.split("/"))>8 or name.casefold() in paths: raise ValueError("Invalid source path")
        paths.add(name.casefold()); data=entry["content"].encode("utf-8"); total+=len(data)
        if b"\0" in data or len(data)!=entry["bytes"] or hashlib.sha256(data).hexdigest()!=entry["sha256"]: raise ValueError("Invalid source hash")
    if total>131072: raise ValueError("Source budget exceeded")
    directory=snapshot["test_directory"]
    if directory!="." and (not isinstance(directory,str) or len(directory)>240 or "\\" in directory or ":" in directory or any(ord(c)<32 for c in directory) or any(not p or p in (".","..") or p.startswith(".") for p in directory.split("/")) or not any(e["path"].startswith(directory+"/") for e in snapshot["files"])): raise ValueError("Invalid test directory")
    runtime=verified_runtime(); policy=sealed_filter()
    runtime["bpf_sha256"]=BPF_HASH
    runtime["guardian_sha256"]=GUARDIAN_HASH
    # EOF before launch means the host worker already stopped. Never start then.
    selector=selectors.DefaultSelector(); selector.register(sys.stdin,selectors.EVENT_READ,"host")
    if selector.select(0): os.close(policy); return
    payload=os.memfd_create("yur-execution-snapshot",os.MFD_CLOEXEC)
    os.write(payload,line); os.lseek(payload,0,os.SEEK_SET)
    command=list(COMMAND); command[command.index("POLICY_FD")]=str(policy)
    started=time.monotonic()
    process=subprocess.Popen(command,stdin=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        pass_fds=(policy,),close_fds=True,env={"PATH":"/usr/bin:/bin","LANG":"C.UTF-8"})
    os.close(payload); os.close(policy)
    pidfd=os.pidfd_open(process.pid)
    # This frame is guardian-owned and never exposed as an untrusted channel.
    frame({"type":"started","cell_pid":process.pid,"guardian_pid":os.getpid(),"runtime":runtime})
    buffers={"stdout":bytearray(),"stderr":bytearray()}; closed=set(); progress=set(); reason=None
    selector.register(process.stdout,selectors.EVENT_READ,"stdout"); selector.register(process.stderr,selectors.EVENT_READ,"stderr")
    def terminate(cause):
        nonlocal reason
        if reason is None: reason=cause
        try: signal.pidfd_send_signal(pidfd,signal.SIGKILL)
        except ProcessLookupError: pass
    try:
        while len(closed)<2:
            if time.monotonic()-started>4: terminate("timeout")
            for key,_ in selector.select(0.05):
                channel=key.data
                if channel=="host":
                    # Any further input, or EOF, is cancellation; repository code
                    # never inherits this pipe. No command or PID is parsed.
                    os.read(sys.stdin.fileno(),4096); selector.unregister(sys.stdin); terminate("cancelled"); continue
                data=os.read(key.fileobj.fileno(),4096)
                if not data:
                    selector.unregister(key.fileobj); closed.add(channel); continue
                if channel not in progress:
                    progress.add(channel); frame({"type":"progress","channel":channel})
                room=65536-sum(map(len,buffers.values())); buffers[channel].extend(data[:max(0,room)])
                if len(data)>room: terminate("output_limit")
            if time.monotonic()-started>7: terminate("timeout"); break
        code=process.wait(timeout=2)
    finally:
        if process.poll() is None: terminate("cancelled"); process.wait(timeout=2)
        os.close(pidfd); selector.close(); process.stdout.close(); process.stderr.close()
    output={}; remaining=65536
    for channel,data in buffers.items():
        decoded=bytes(data).decode("utf-8",errors="replace")
        display="".join(c if (ord(c)>=32 and ord(c)!=127) or c in "\n\r\t" else "\\x%02x"%ord(c) for c in decoded)
        normalized=display.encode("utf-8")
        if len(normalized)>remaining:
            normalized=normalized[:remaining].decode("utf-8",errors="ignore").encode("utf-8")
            if reason is None: reason="output_limit"
        remaining-=len(normalized)
        output[channel]=normalized.decode("utf-8"); output[channel+"_bytes"]=len(normalized)
        output[channel+"_sha256"]=hashlib.sha256(normalized).hexdigest()
    frame({"type":"result","result":{"schema":"yur.execution-cell-result.v1","snapshot_id":snapshot["id"],
        "profile":snapshot["profile"],"status":reason or ("completed" if code==0 else "failed"),"exit_code":code,
        **output,"duration_ms":round((time.monotonic()-started)*1000),"runtime":runtime,"limits":LIMITS,"scratch":"discarded"}})
try: main()
except Exception as error:
    frame({"type":"error","code":"unavailable","message":str(error)[:500]})
    raise SystemExit(1)
'''


def _bwrap_command():
    return ["/usr/bin/bwrap", "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
            "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
            "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev",
            "--size", "1048576", "--tmpfs", "/dev/shm", "--remount-ro", "/dev",
            "--size", "16777216", "--tmpfs", "/tmp", "--size", "16777216", "--tmpfs", "/work",
            "--remount-ro", "/", "--chdir", "/work", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
            "--seccomp", "POLICY_FD", "/usr/bin/prlimit", "--as=134217728:134217728", "--cpu=1:2",
            "--fsize=1048576:1048576", "--nofile=64:64", "--nproc=32:32", "--core=0:0",
            "/usr/bin/python3", "-I", "-B", "-c", _INNER]


def _guardian_program():
    return "PINS=" + repr(RUNTIME_PINS) + "\nBPF_HASH=" + repr(BPF_SHA256) + "\nLIMITS=" + repr(CELL_LIMITS) + "\nCOMMAND=" + repr(_bwrap_command()) + "\n" + _RUNTIME_CODE + _FILTER_CODE + _GUARDIAN_CODE


def _guardian_source():
    program = _guardian_program()
    # Hash covers the full fixed executable program before the constant prefix.
    return "GUARDIAN_HASH=" + repr(hashlib.sha256(program.encode()).hexdigest()) + "\n" + program


def _environment():
    return {"SystemRoot": r"C:\Windows", "WINDIR": r"C:\Windows"}


def _wsl_argv(distro, code):
    return [WSL, "-d", distro, "--exec", "/usr/bin/python3", "-I", "-B", "-c", code]


def _running():
    try:
        result = subprocess.run([WSL, "--list", "--verbose"], capture_output=True, timeout=8, env=_environment(), creationflags=_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ExecutionCellError("unavailable", "Cannot verify already-running WSL distributions",
                                 diagnostics=_runtime_diagnostic("wsl_status", "timeout" if isinstance(error, subprocess.TimeoutExpired) else "os_error", error=error)) from error
    if result.returncode or len(result.stdout) > 65536 or len(result.stderr) > 65536:
        raise ExecutionCellError("unavailable", "WSL distribution status is unavailable",
                                 diagnostics=_runtime_diagnostic("wsl_status", "nonzero_exit" if result.returncode else "output_limit", result=result))
    text = result.stdout.decode("utf-16-le" if b"\0" in result.stdout else "utf-8", errors="replace")
    return set(re.findall(r"^\s*\*?\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+Running\s+2\s*$", text, re.M))


def _runtime_for(distro):
    running = _running()
    if distro not in running:
        raise ExecutionCellError("unavailable", "Selected WSL distribution is not already running; no guest will be started",
                                 diagnostics=_runtime_diagnostic("runtime_selection", "selected_not_running", selected=distro, running=running))
    code = "PINS=" + repr(RUNTIME_PINS) + "\n" + _RUNTIME_CODE + "\nprint(json.dumps(verified_runtime()))\n"
    try:
        result = subprocess.run(_wsl_argv(distro, code), capture_output=True, timeout=8, env=_environment(), creationflags=_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ExecutionCellError("unavailable", "Execution runtime verification failed",
                                 diagnostics=_runtime_diagnostic("runtime_verification", "timeout" if isinstance(error, subprocess.TimeoutExpired) else "os_error", error=error, selected=distro)) from error
    if result.returncode or len(result.stdout) > 16384 or len(result.stderr) > 16384:
        raise ExecutionCellError("unavailable", "Execution runtime differs from the reviewed Python/Bubblewrap/libseccomp fingerprints",
                                 diagnostics=_runtime_diagnostic("runtime_verification", "nonzero_exit" if result.returncode else "output_limit", result=result, selected=distro))
    try: info = _decode_frame(result.stdout)
    except ExecutionCellError as error:
        raise ExecutionCellError("unavailable", "Malformed runtime verification",
                                 diagnostics=_runtime_diagnostic("runtime_verification", "malformed_response", result=result, selected=distro)) from error
    try: _verify_runtime(info)
    except ExecutionCellError as error:
        raise ExecutionCellError(error.code, error.message,
                                 diagnostics=_runtime_diagnostic("runtime_verification", "fingerprint_mismatch", result=result, selected=distro)) from error
    return {"distro": distro, **info}


def resolve_runtime():
    """Read-only discovery; never boots a distribution or accepts an unpinned runtime."""
    selected = os.environ.get("YUR_EXECUTION_DISTRO")
    running = _running()
    if selected:
        if not _DISTRO.fullmatch(selected) or selected not in running:
            raise ExecutionCellError("unavailable", "YUR_EXECUTION_DISTRO must name an already-running WSL2 distribution",
                                     diagnostics=_runtime_diagnostic("runtime_selection", "invalid_selection" if not _DISTRO.fullmatch(selected) else "selected_not_running", selected=selected, running=running))
        return _runtime_for(selected)
    candidates = []
    for distro in sorted(name for name in running if name == "Ubuntu" or name.startswith("Ubuntu-")):
        try: candidates.append(_runtime_for(distro))
        except ExecutionCellError: continue
    if len(candidates) != 1:
        raise ExecutionCellError("unavailable", "Select one already-running, verified Ubuntu execution resource with YUR_EXECUTION_DISTRO",
                                 diagnostics=_runtime_diagnostic("runtime_selection", "ambiguous_selection", running=running))
    return candidates[0]


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value: raise ValueError("Duplicate field")
        value[key] = item
    return value


def _decode_frame(data):
    try:
        if len(data) > MAX_FRAME_BYTES: raise ValueError("Oversized frame")
        value = json.loads(data, object_pairs_hook=_unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite value")))
        if not isinstance(value, dict): raise ValueError("Expected object")
        return value
    except (ValueError, UnicodeError, TypeError) as error:
        raise ExecutionCellError("protocol", "Invalid trusted guardian frame") from error


def _verify_runtime(value, guardian=False):
    if not isinstance(value, dict) or value.get("architecture") != "x86_64" or value.get("python") != "3.12.3" or value.get("libseccomp") != "2.5.5":
        raise ExecutionCellError("unavailable", "Runtime verification does not match the reviewed resource")
    artifacts = value.get("artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) != set(RUNTIME_PINS) or any(not isinstance(artifacts[name], dict) or artifacts[name].get("sha256") != sha for name, sha in RUNTIME_PINS.items()):
        raise ExecutionCellError("unavailable", "Runtime source fingerprints changed")
    if guardian and (value.get("bpf_sha256") != BPF_SHA256 or value.get("guardian_sha256") != hashlib.sha256(_guardian_program().encode()).hexdigest()):
        raise ExecutionCellError("unavailable", "Execution policy fingerprint changed")


def _validate_result(result, snapshot):
    expected = {"schema", "snapshot_id", "profile", "status", "exit_code", "stdout", "stderr", "stdout_bytes", "stderr_bytes", "stdout_sha256", "stderr_sha256", "duration_ms", "runtime", "limits", "scratch"}
    if not isinstance(result, dict) or set(result) != expected or result["schema"] != "yur.execution-cell-result.v1" or result["snapshot_id"] != snapshot["id"] or result["profile"] != snapshot["profile"]:
        raise ExecutionCellError("protocol", "Cell result identity mismatch")
    if result["status"] not in {"completed", "failed", "timeout", "output_limit", "cancelled"} or type(result["exit_code"]) is not int or not -255 <= result["exit_code"] <= 255 or type(result["duration_ms"]) is not int or not 0 <= result["duration_ms"] <= 15000:
        raise ExecutionCellError("protocol", "Invalid execution status")
    if (result["status"] == "completed" and result["exit_code"] != 0) or (result["status"] == "failed" and result["exit_code"] == 0):
        raise ExecutionCellError("protocol", "Inconsistent execution exit status")
    if result["limits"] != CELL_LIMITS or result["scratch"] != "discarded":
        raise ExecutionCellError("protocol", "Execution bounds changed")
    for channel in ("stdout", "stderr"):
        if not isinstance(result[channel], str): raise ExecutionCellError("protocol", "Invalid output text")
        data = result[channel].encode("utf-8")
        if len(data) > 65536 or type(result[channel + "_bytes"]) is not int or result[channel + "_bytes"] != len(data) or result[channel + "_sha256"] != hashlib.sha256(data).hexdigest():
            raise ExecutionCellError("protocol", "Output evidence hash/count mismatch")
    if result["stdout_bytes"] + result["stderr_bytes"] > CELL_LIMITS["output_bytes_total"] or len(_canonical(result)) > 160 * 1024:
        raise ExecutionCellError("protocol", "Combined output budget exceeded")
    _verify_runtime(result["runtime"], guardian=True)
    return result


def _read_lines(stream, events, label):
    try:
        while line := stream.readline(MAX_FRAME_BYTES + 1):
            events.put((label, line))
            if len(line) > MAX_FRAME_BYTES: break
    finally: events.put((label, None))


def run_snapshot(snapshot, on_event=None):
    """Execute one committed snapshot. Closing this host's stdin pipe cancels it.

    UTF-8 replacement normalizes invalid bytes and makes control characters visible;
    byte counts/SHA-256 cover that exact text, within a shared 64 KiB output budget.
    No test-derived JSON, PID, counts or paths are trusted.
"""
    snapshot = validate_snapshot(snapshot)
    runtime = resolve_runtime()
    running = _running()
    if runtime["distro"] not in running:
        raise ExecutionCellError("unavailable", "Execution resource stopped before launch",
                                 diagnostics=_runtime_diagnostic("runtime_selection", "selected_not_running", selected=runtime["distro"], running=running))
    def notify(text):
        if on_event:
            try: on_event({"text": text[:500]})
            except Exception: pass
    notify("Verified the restricted serial Python execution resource.")
    try:
        process = subprocess.Popen(_wsl_argv(runtime["distro"], _guardian_source()), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   close_fds=True, env=_environment(), creationflags=_NO_WINDOW)
    except OSError as error:
        raise ExecutionCellError("unavailable", "Cannot start the verified execution guardian") from error
    events = queue.Queue(maxsize=8)
    for label, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
        threading.Thread(target=_read_lines, args=(stream, events, label), daemon=True).start()
    result = None
    started_frame = False
    progress_channels = set()
    deadline = time.monotonic() + 15
    stderr_bytes = 0
    try:
        # Keep this pipe OPEN until the guardian's terminal receipt arrives.
        process.stdin.write(_canonical(snapshot) + b"\n"); process.stdin.flush()
        closed = set()
        while result is None and len(closed) < 2:
            if time.monotonic() > deadline:
                raise ExecutionCellError("unavailable", "Execution guardian exceeded its deadline")
            try: label, line = events.get(timeout=0.05)
            except queue.Empty: continue
            if line is None: closed.add(label); continue
            if label == "stderr":
                stderr_bytes += len(line)
                if stderr_bytes > 16384: raise ExecutionCellError("protocol", "Guardian diagnostics exceeded their budget")
                continue
            frame = _decode_frame(line)
            if frame.get("type") == "started" and not started_frame and set(frame) == {"type", "cell_pid", "guardian_pid", "runtime"}:
                if any(type(frame[name]) is not int or frame[name] < 2 for name in ("cell_pid", "guardian_pid")):
                    raise ExecutionCellError("protocol", "Invalid guardian process evidence")
                _verify_runtime(frame["runtime"], guardian=True)
                started_frame = True
                notify("Running the staged Python snapshot in the isolated serial cell.")
            elif frame.get("type") == "result" and started_frame and set(frame) == {"type", "result"}:
                result = _validate_result(frame["result"], snapshot)
            elif frame.get("type") == "progress" and started_frame and set(frame) == {"type", "channel"} and frame["channel"] in ("stdout", "stderr") and frame["channel"] not in progress_channels:
                progress_channels.add(frame["channel"])
                notify("Captured output from the isolated execution cell.")
            elif frame.get("type") == "error":
                raise ExecutionCellError("unavailable", "The execution guardian could not establish the verified cell")
            else: raise ExecutionCellError("protocol", "Unexpected trusted guardian frame")
        if result is None:
            raise ExecutionCellError("protocol", "Execution ended without a trusted terminal result")
        process.stdin.close()
        if process.wait(timeout=3) != 0:
            raise ExecutionCellError("protocol", "Guardian exited unsuccessfully after its result")
        result["runtime"]["distro"] = runtime["distro"]
        notify("Execution cell finished: " + result["status"] + ".")
        return deepcopy(result)
    finally:
        if not process.stdin.closed: process.stdin.close()
        if process.poll() is None:
            # EOF first: the guest guardian cancels its own pidfd and waits.
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=2)
        process.stdout.close(); process.stderr.close()
