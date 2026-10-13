"""Ship gate, Pulse intake and Organism status through the real CommitService and Work CLI."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from foundry import work_cli
from foundry.commit_service import CommitService, SCHEMA_VERSION
from foundry.lifecycle_runner import tick
from foundry.organism_rpc import perform_check
from foundry.pulse_intake import MutationAdapter, MutationAdapterError
from foundry.ship_gate import SHIP_AUTHORITY, ShipGateConflictError, run_probe, validate_probe

AUTH = SHIP_AUTHORITY


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - http.server API
        routes = {"/health": (200, b'{"ok": true}'), "/pricing": (200, b'{"plan": "pro", "price": 99}'),
                  "/gated": (401, b"no"), "/broken": (500, b"boom")}
        status, body = routes.get(self.path, (404, b"missing"))
        self.send_response(status)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class ShipGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "journal"
        self.store = CommitService(self.root)
        self.addCleanup(lambda: self.store.close())
        self.time = datetime.now(timezone.utc).replace(microsecond=0)
        # A ledger shaped like LITHIUM's clv_picks (30 settled picks, slightly negative CLV).
        self.ledger = Path(self.temp.name) / "brain.db"
        with closing(sqlite3.connect(self.ledger)) as raw, raw:
            raw.execute("CREATE TABLE clv_picks (pick_id INTEGER PRIMARY KEY, clv_points REAL, settled_ts TEXT)")
            raw.executemany("INSERT INTO clv_picks (clv_points, settled_ts) VALUES (?, ?)",
                            [(0.5 if i % 2 else -0.6, "2026-09-20") for i in range(30)] + [(None, None)] * 5)

    def clv_probes(self, picks=256, edge=0.0):
        query_n = "SELECT COUNT(*) FROM clv_picks WHERE settled_ts IS NOT NULL"
        query_clv = "SELECT AVG(clv_points) FROM clv_picks WHERE settled_ts IS NOT NULL"
        return [{"kind": "sqlite_metric", "label": "settled picks", "path": str(self.ledger), "query": query_n,
                 "op": ">=", "threshold": picks},
                {"kind": "sqlite_metric", "label": "average CLV", "path": str(self.ledger), "query": query_clv,
                 "op": ">", "threshold": edge}]

    def create(self, probes, **changes):
        return self.store.create_ship_candidate({"name": "LITHIUM NFL predictor", "money_path": "Pro $99/mo signals",
                                                 "probes": probes, **changes}, AUTH, now=self.time)

    def test_pass_requires_every_probe(self):
        candidate = self.create([{"kind": "http_ok", "label": "health", "url": f"{self.base}/health"},
                                 {"kind": "http_money", "label": "pricing", "url": f"{self.base}/pricing"},
                                 *self.clv_probes(picks=30, edge=-0.1)])
        outcome = perform_check(self.store, candidate)
        self.assertEqual(outcome["verdict"], "PASS", outcome["candidate"]["last_notes"])
        self.assertIsNone(outcome["proposed"])
        self.assertEqual(outcome["candidate"]["checks_run"], 1)
        self.assertTrue(self.store.verify_integrity()["ship_head_hash"])

    def test_strict_http_and_money_signal(self):
        notes = {path: run_probe({"kind": "http_ok", "label": path, "url": f"{self.base}{path}"})
                 for path in ("/health", "/gated", "/broken", "/missing")}
        self.assertTrue(notes["/health"]["passed"])
        self.assertFalse(notes["/gated"]["passed"])  # the original ledger counted 401 as live
        self.assertFalse(notes["/broken"]["passed"])  # ... and 500
        self.assertFalse(run_probe({"kind": "http_money", "label": "h", "url": f"{self.base}/health"})["passed"])
        self.assertFalse(run_probe({"kind": "http_ok", "label": "dead", "url": "http://127.0.0.1:9/x"})["passed"])

    def test_debt_proposes_exactly_one_paused_mission(self):
        candidate = self.create(self.clv_probes(), debt_goal="Improve the model until CLV beats the close.")
        first = perform_check(self.store, candidate)
        self.assertEqual(first["verdict"], "DEBT")
        self.assertIn("settled picks: 30 >= 256", first["candidate"]["last_notes"][0])
        self.assertIn("average CLV: -0.05", first["candidate"]["last_notes"][1])
        proposal = first["proposed"]
        self.assertEqual((proposal["state"], proposal["kind"], proposal["runs_completed"]), ("paused", "work_goal", 0))
        self.assertIn("Improve the model", proposal["goal"])
        self.assertEqual(first["candidate"]["debt_deployment_id"], proposal["id"])
        again = self.store.request_ship_check(candidate["id"], first["candidate"]["revision"], AUTH)
        second = perform_check(self.store, again)
        self.assertEqual(second["verdict"], "DEBT")
        self.assertIsNone(second["proposed"])  # no proposal spam while DEBT persists
        self.assertEqual(len(self.store.list_deployments()), 1)

    def test_probe_validation_is_closed_and_read_only(self):
        bad = [{"kind": "http_ok", "label": "x", "url": "https://example.com/"},
               {"kind": "http_ok", "label": "x", "url": "http://10.0.0.5/"},
               {"kind": "http_ok", "label": "x", "url": "http://user:pw@127.0.0.1/"},
               {**self.clv_probes()[0], "query": "DELETE FROM clv_picks"},
               {**self.clv_probes()[0], "query": "SELECT 1; DROP TABLE clv_picks"},
               {**self.clv_probes()[0], "query": "SELECT * FROM pragma_table_info('x') -- pragma"},
               {**self.clv_probes()[0], "path": "relative.db"},
               {"kind": "file_contains", "label": "x"}]
        for probe in bad:
            with self.assertRaises(ValueError, msg=probe):
                validate_probe(probe)
        sneaky = {**self.clv_probes()[0], "query": "SELECT writefile('x', 'y')"}
        self.assertFalse(run_probe(sneaky)["passed"])  # unknown functions fail closed, nothing is written

    def test_verdict_cannot_be_forged_and_tampering_is_detected(self):
        candidate = self.create(self.clv_probes())
        with self.assertRaises(ValueError):
            self.store.record_ship_check(candidate["id"], candidate["revision"], [{"passed": True}])
        outcome = perform_check(self.store, candidate)
        self.assertEqual(outcome["verdict"], "DEBT")
        with self.assertRaises(ShipGateConflictError):
            self.store.record_ship_check(candidate["id"], candidate["revision"],
                                         [{"passed": True, "note": "x", "observed": 1}] * 2)
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("UPDATE ship_candidates SET document=replace(document,'\"DEBT\"','\"PASS\"')")
        with self.assertRaises(RuntimeError):
            CommitService(self.root)

    def test_v10_journal_migrates_after_verification(self):
        self.store.close()
        with closing(sqlite3.connect(self.root / "foundry.sqlite3")) as raw, raw:
            raw.execute("DROP TABLE ship_events")
            raw.execute("DROP TABLE ship_candidates")
            raw.execute("PRAGMA user_version=10")
        self.store = CommitService(self.root)
        self.assertEqual(self.store._db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
        self.assertEqual(self.store.verify_integrity()["ship_candidates"], 0)

    def test_pulse_contract_and_routes(self):
        with self.assertRaises(MutationAdapterError):
            MutationAdapter().adapt({"source": "x", "mutation_type": "teleport", "payload": {}})
        with self.assertRaises(MutationAdapterError):
            MutationAdapter().adapt({"source": "x", "mutation_type": "webhook", "payload": {"token": "sk-ant-" + "a" * 40}})
        mission = MutationAdapter().adapt({"source": "stripe", "mutation_type": "webhook", "payload": {"path": "/alert/fail"}})
        self.assertEqual(mission["routing_hints"], {"domain": "api_intake", "urgency": "high"})


class OrganismRpcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "desktop-home"
        patcher = patch.dict(os.environ, {"YUR_DESKTOP_HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ledger = Path(self.temp.name) / "brain.db"
        with closing(sqlite3.connect(self.ledger)) as raw, raw:
            raw.execute("CREATE TABLE clv_picks (clv_points REAL, settled_ts TEXT)")
            raw.executemany("INSERT INTO clv_picks VALUES (?, ?)", [(-0.04, "2026-09-20")] * 30)

    def rpc(self, **request):
        return work_cli.handle(request)

    def test_empty_journal_status_creates_nothing(self):
        status = self.rpc(command="organism_status")
        self.assertEqual(status["deployments"]["total"], 0)
        self.assertEqual(self.rpc(command="ship_list"), {"candidates": []})
        self.assertFalse((self.home / "foundry.sqlite3").exists())

    def test_full_loop_pulse_to_ship_gate_to_proposed_mission(self):
        candidate = self.rpc(command="ship_create", spec={
            "name": "LITHIUM NFL predictor", "money_path": "Pro tier signals", "interval_seconds": 86400,
            "probes": [{"kind": "sqlite_metric", "label": "average CLV", "path": str(self.ledger), "op": ">", "threshold": 0,
                        "query": "SELECT AVG(clv_points) FROM clv_picks WHERE settled_ts IS NOT NULL"}]})["candidate"]
        # The headless runner checks the due candidate: DEBT proposes one paused mission.
        summary = tick(self.home, log=lambda *_: None)
        self.assertEqual((summary["ship_checks"], summary["ship_debts_proposed"]), (1, 1))
        # A Pulse schedule tick targets the candidate; the next runner tick re-checks it (no new proposal).
        routed = self.rpc(command="pulse_intake", mutation={"source": "lithium", "mutation_type": "schedule_pulse",
                                                            "payload": {"target": {"ship_candidate_id": candidate["id"]}}})
        self.assertEqual(routed["routed"], "check_candidate")
        self.assertEqual(tick(self.home, log=lambda *_: None)["ship_debts_proposed"], 0)
        # An untargeted event becomes a paused proposed mission (the attention queue).
        dropped = self.rpc(command="pulse_intake", mutation={"source": "inbox", "mutation_type": "file_drop",
                                                             "payload": {"path": "bids/new-bid.pdf"}})
        self.assertEqual((dropped["routed"], dropped["deployment"]["state"]), ("proposed_mission", "paused"))
        status = self.rpc(command="organism_status")
        self.assertEqual(status["ship"]["debt"], 1)
        self.assertEqual(status["deployments"]["awaiting_approval"], 2)
        self.assertTrue(status["integrity"]["passed"])
        self.assertIn("ship.checked", {item["event_type"] for item in status["recent"]})
        events = self.rpc(command="ship_events", candidate_id=candidate["id"])["events"]
        self.assertEqual([event["event_type"] for event in reversed(events)],
                         ["ship.created", "ship.checked", "ship.debt_proposed", "ship.check_requested", "ship.checked"])

    def test_operator_check_and_state(self):
        candidate = self.rpc(command="ship_create", spec={
            "name": "Storefront", "money_path": "Checkout", "state": "paused",
            "probes": [{"kind": "http_ok", "label": "checkout", "url": "http://127.0.0.1:9/health"}]})["candidate"]
        with self.assertRaises(ValueError):
            self.rpc(command="ship_check_now", candidate_id=candidate["id"])
        active = self.rpc(command="ship_state", candidate_id=candidate["id"], expected_revision=candidate["revision"],
                          state="active")["candidate"]
        result = self.rpc(command="ship_check_now", candidate_id=active["id"])
        self.assertEqual(result["verdict"], "DEBT")
        with self.assertRaises(ValueError):
            self.rpc(command="ship_create", spec={"name": "x", "money_path": "y", "probes": [], "bogus": 1})


if __name__ == "__main__":
    unittest.main()
