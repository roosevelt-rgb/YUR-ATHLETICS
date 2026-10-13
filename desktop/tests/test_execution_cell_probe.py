"""Policy regressions for the opt-in fixed execution-cell proof; no WSL boot."""
import json
import unittest
from unittest.mock import patch

from scripts import probe_execution_cell as probe


class ExecutionCellProbeTests(unittest.TestCase):
    def test_all_profiles_use_same_fixed_command_without_shell_or_host_mounts(self):
        command = probe.bwrap_argv("unittest")
        self.assertEqual(command[:2], ["/usr/bin/bwrap", "--unshare-all"])
        self.assertEqual(command, probe.bwrap_argv("compile"))
        for flag in ("--die-with-parent", "--new-session", "--clearenv", "--unshare-user", "--disable-userns", "--assert-userns-disabled"):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index("--cap-drop") + 1], "ALL")
        self.assertEqual(command[command.index("--ro-bind") + 1:command.index("--ro-bind") + 3], ["/usr", "/usr"])
        for forbidden in ("--bind", "--dev-bind", "--share-net", "/mnt", "/home", "/run", "/bin/sh", "-lc"):
            self.assertNotIn(forbidden, command)
        self.assertEqual(command[-1], probe.GUEST_PROBE)
        self.assertEqual(command[command.index("--seccomp") + 1], "POLICY_FD")
        self.assertIn("--as=134217728:134217728", command)
        self.assertIn("--cpu=1:2", command)
        self.assertIn("--core=0:0", command)
        self.assertEqual(command.count("16777216"), 2)
        with self.assertRaises(ValueError): probe.cell_argv("arbitrary_command")

    def test_distributions_must_be_explicitly_running_wsl2(self):
        self.assertEqual(probe.running_distributions("* Ubuntu-24.04 Running 2\n Ubuntu Stopped 2\n"), {"Ubuntu-24.04"})
        self.assertNotIn(probe.DISTRO, probe.running_distributions("Ubuntu-24.04 Stopped 2"))
        self.assertNotIn(probe.DISTRO, probe.running_distributions("Ubuntu-24.04 Running 1"))
        text = "Ubuntu-24.04 Running 2"
        self.assertEqual(probe.decode_wsl(text.encode("utf-16-le")), text)

    def test_guest_environment_never_inherits_host_credentials_or_paths(self):
        with patch.dict(probe.os.environ, {"OPENAI_API_KEY": "test-secret", "PATH": "private-path", "HOME": "private-home"}):
            env = probe.clean_environment()
        self.assertEqual(set(env), {"SystemRoot", "WINDIR", "WSLENV", probe.CANARY})
        self.assertEqual(env["WSLENV"], probe.CANARY)
        self.assertNotIn("test-secret", json.dumps(env))
        for source in (probe.GUEST_PROBE, probe.SERVER_PROBE, probe.BASELINE_PROBE, probe.PROCESS_PROBE, probe.SECCOMP_BUILDER, probe.cell_argv("unittest")[-1]):
            compile(source, "<fixed probe source>", "exec")

    def test_incomplete_or_claimed_results_cannot_pass_boundary_assessment(self):
        cases = [{"mode": mode, "records": [{"passed": True}], "returncode": 0,
                  "elapsed_seconds": 0, "output_limited": False, "stdout_bytes_retained": 0,
                  "host_timeout": False, "child_after": None, "cancellation": None} for mode in probe.MODES]
        checks = probe.assess(cases, {"network_namespace": "net:[1]", "canary_present": True}, {"reachable": True})
        self.assertFalse(checks["host_paths_absent"])
        self.assertFalse(checks["network_namespace_distinct"])
        self.assertFalse(checks["controlled_server_blocked"])
        self.assertFalse(checks["all_children_gone"])
        self.assertFalse(checks["exact_child_cancelled"])
        self.assertFalse(checks["root_and_runtime_readonly"])
        self.assertFalse(checks["cpu_limit"])
        self.assertFalse(checks["output_limit"])

    def test_pidfd_cancellation_requires_captured_identity(self):
        # Code policy matters here: process signalling must occur only after a
        # pinned pidfd and /proc start-time comparison, never process-name kill.
        source = probe.PROCESS_PROBE
        self.assertLess(source.index("os.pidfd_open(pid)"), source.index("signal.pidfd_send_signal"))
        self.assertIn('request["start_time"] is not None and same', source)
        self.assertNotIn("os.kill(", source)
        self.assertNotIn("pkill", source)

    def test_serial_filter_is_sealed_and_missing_syscall_resolution_fails_closed(self):
        source = probe.SECCOMP_BUILDER
        self.assertIn('("fork", "vfork", "clone", "clone3")', source)
        self.assertIn('if number < 0: raise RuntimeError', source)
        self.assertIn('seccomp_syscall_resolve_name_arch(native, name.encode())', source)
        self.assertIn('fcntl.F_SEAL_WRITE', source)
        self.assertIn('seccomp_attr_set(context, 2, 0x80000000)', source)
        self.assertIn('for arch in (b"x86", b"x32")', source)
        self.assertNotIn('seccomp_arch_add(', source)
        command = probe.cell_argv("unittest")
        self.assertEqual(command[:5], [probe.WSL, "-d", "Ubuntu-24.04", "--exec", "/usr/bin/python3"])
        self.assertNotIn('/usr/bin/timeout', probe.bwrap_argv("unittest"))


if __name__ == "__main__":
    unittest.main()
