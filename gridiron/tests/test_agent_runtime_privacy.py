"""Checks for the family-privacy and MaxPreps-sync fixes (server.ts athlete reads, agent_runtime tools).

Run from the repo root:  python -m unittest discover -s tests -v
Set GRIDIRON_TEST_ORIGIN=http://127.0.0.1:3000 (or a second instance's origin) to also check a running server.
"""
from __future__ import annotations

import ast
import asyncio
import json
import os
import pathlib
import re
import sys
import tempfile
import textwrap
import time
import unittest
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
AGENT_RUNTIME = REPO / "agent_runtime"
PRIVATE = ("contacts", "agent")


def alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            k.GetExitCodeProcess(h, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def handler_body(src: str, route: str) -> str:
    """The text of one app.get(route, ...) handler, up to the next app.<verb>( call."""
    start = src.index(f'app.get("{route}", ')
    nxt = re.compile(r"\n\s*app\.(?:get|post|put|delete|use)\(").search(src, start + 1)
    return src[start: nxt.start() if nxt else len(src)]


class ServerProjection(unittest.TestCase):
    src = (REPO / "server.ts").read_text(encoding="utf-8")

    def test_private_fields_constant(self):
        m = re.search(r"const ATHLETE_PRIVATE_FIELDS = \{([^}]*)\} as const;", self.src)
        self.assertIsNotNone(m, "ATHLETE_PRIVATE_FIELDS is gone from server.ts")
        fields = dict(re.findall(r"(\w+):\s*(\d+)", m.group(1)))
        for k in PRIVATE:
            self.assertEqual(fields.get(k), "0", f"{k} must be excluded")

    def test_both_athlete_reads_exclude_private_fields(self):
        for route in ("/api/athletes", "/api/athletes/:id"):
            body = handler_body(self.src, route)
            self.assertIn('.collection("athletes")', body, route)
            proj = re.search(r"projection:\s*\{([^}]*)\}", body)
            self.assertIsNotNone(proj, f"{route} has no projection")
            self.assertIn("...ATHLETE_PRIVATE_FIELDS", proj.group(1), f"{route} projection must spread ATHLETE_PRIVATE_FIELDS")
            self.assertIn("_id: 0", proj.group(1), route)


@unittest.skipUnless(os.environ.get("GRIDIRON_TEST_ORIGIN"), "set GRIDIRON_TEST_ORIGIN to check a running server")
class LiveServer(unittest.TestCase):
    origin = os.environ.get("GRIDIRON_TEST_ORIGIN", "").rstrip("/")

    def get(self, path: str):
        with urllib.request.urlopen(self.origin + path, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def test_list_and_single_leave_out_private_fields(self):
        rows = self.get("/api/athletes")["rows"]
        self.assertTrue(rows, "no athletes loaded")
        for row in rows:
            # assertFalse, not assertNotIn: a failure must not print the record (family contacts) into the test log
            for k in PRIVATE:
                self.assertFalse(k in row, f"/api/athletes row {row.get('id')} still has {k}")
            one = self.get(f"/api/athletes/{row['id']}")
            for k in PRIVATE:
                self.assertFalse(k in one, f"/api/athletes/{row['id']} still has {k}")
            for k in ("id", "name", "position", "gradYear", "highSchool"):
                self.assertTrue(k in one, f"the player card still needs {k}")


class McpDocstring(unittest.TestCase):
    tree = ast.parse((AGENT_RUNTIME / "gridiron_mcp.py").read_text(encoding="utf-8"))

    def test_docstring_names_the_maxpreps_fetches(self):
        doc = ast.get_docstring(self.tree) or ""
        self.assertNotIn("Nothing here leaves this computer", doc)
        for tool in ("maxpreps_check", "maxpreps_sync_now"):
            self.assertIn(tool, doc)
        self.assertIn("internet", doc)

    def test_scout_athlete_still_drops_private_fields(self):
        for node in self.tree.body:
            if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "PRIVATE_ATHLETE_FIELDS" for t in node.targets):
                self.assertEqual(set(ast.literal_eval(node.value)), set(PRIVATE))
                return
        self.fail("PRIVATE_ATHLETE_FIELDS is gone from gridiron_mcp.py")


FAKE_SLOW_SYNC = textwrap.dedent("""
    import pathlib, subprocess, sys, time
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(90)"])
    pathlib.Path(sys.argv[0]).with_name("pids.txt").write_text(f"{__import__('os').getpid()} {child.pid}")
    print("fake sync started", flush=True)
    time.sleep(90)
""")
FAKE_QUICK_SYNC = 'import sys; print("fake sync done for", sys.argv[sys.argv.index("--athlete") + 1])\n'


class MaxPrepsSyncTimeout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(AGENT_RUNTIME))
        import scout_tools  # noqa: E402  (httpx + pymongo; no database connection at import)
        cls.st = scout_tools

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.saved = (self.st.RECRUIT, self.st.MAXPREPS_SYNC_TIMEOUT)
        self.addCleanup(self.restore)
        self.st.RECRUIT = pathlib.Path(self.tmp.name)

    def restore(self):
        self.st.RECRUIT, self.st.MAXPREPS_SYNC_TIMEOUT = self.saved

    def test_finished_sync_returns_its_output(self):
        (self.st.RECRUIT / "maxpreps_sync.py").write_text(FAKE_QUICK_SYNC, encoding="utf-8")
        r = asyncio.run(self.st.maxpreps_sync_now(None, {"athlete_id": "test-athlete"}))
        self.assertEqual(r["returncode"], 0)
        self.assertIn("fake sync done for test-athlete", r["output"])
        self.assertNotIn("timed_out", r)

    def test_timeout_stops_the_sync_and_what_it_started(self):
        (self.st.RECRUIT / "maxpreps_sync.py").write_text(FAKE_SLOW_SYNC, encoding="utf-8")
        self.st.MAXPREPS_SYNC_TIMEOUT = 4
        t0 = time.monotonic()
        r = asyncio.run(self.st.maxpreps_sync_now(None, {"athlete_id": "test-athlete"}))
        self.assertLess(time.monotonic() - t0, 40)
        pids = [int(x) for x in (self.st.RECRUIT / "pids.txt").read_text().split()]
        deadline = time.monotonic() + 10
        while any(alive(p) for p in pids) and time.monotonic() < deadline:
            time.sleep(0.2)
        left = [p for p in pids if alive(p)]
        if left:  # do not leave sleepers behind if the fix regresses
            for p in left:
                try:
                    os.kill(p, 9)
                except OSError:
                    pass
        self.assertEqual(left, [], "the sync process or its child outlived the timeout")
        self.assertIs(r["timed_out"], True)
        self.assertIs(r["still_running"], False)
        self.assertIsNotNone(r["returncode"])
        self.assertIn("did not finish within 4 s", r["error"])
        self.assertIn("together with everything it started", r["error"])
        self.assertIn("fake sync started", r["output"])


if __name__ == "__main__":
    unittest.main()
