"""Mongo persistence for agent outputs (same `gridiron` db the Express API serves).

collections: film_notes (latest per athlete+play), film_notes_history, film_reports, drafts, agent_runs"""
from __future__ import annotations
import datetime
import os
import uuid
from typing import Any, Dict, List, Optional

from pymongo import MongoClient

MONGO = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
_DB = None


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def db():
    global _DB
    if _DB is None:
        _DB = MongoClient(MONGO, serverSelectionTimeoutMS=5000)[os.environ.get("MONGO_DB", "gridiron")]
        _DB.film_notes.create_index([("athleteId", 1), ("playId", 1)], unique=True)
        _DB.drafts.create_index([("athleteId", 1), ("createdAt", -1)])
        _DB.agent_runs.create_index([("athleteId", 1), ("startedAt", -1)])
    return _DB


def start_run(athlete_id: str, pipeline: str, args: Dict[str, Any]) -> Dict[str, Any]:
    run = {"id": "run_" + uuid.uuid4().hex[:10], "athleteId": athlete_id, "pipeline": pipeline, "status": "running", "startedAt": now_iso(), "args": args, "steps": [], "counts": {}}
    db().agent_runs.insert_one(dict(run))
    return run


def finish_run(run: Dict[str, Any], status: str, counts: Dict[str, Any], report_md: str, timeline: List[Dict[str, Any]], error: Optional[str] = None) -> None:
    db().agent_runs.update_one({"id": run["id"]}, {"$set": {"status": status, "finishedAt": now_iso(), "counts": counts, "report": report_md, "timeline": timeline, "error": error}})
    db().athletes.update_one({"id": run["athleteId"]}, {"$set": {"agent.lastRun": now_iso(), "agent.lastRunId": run["id"], "agent.lastPipeline": run["pipeline"]}})


def save_notes(athlete_id: str, run_id: str, notes: List[Dict[str, Any]]) -> int:
    n = 0
    for note in notes:
        doc = dict(note, athleteId=athlete_id, runId=run_id, updatedAt=now_iso())
        db().film_notes_history.insert_one(dict(doc))
        db().film_notes.replace_one({"athleteId": athlete_id, "playId": note["playId"]}, doc, upsert=True)
        n += 1
    return n


def save_report(report: Dict[str, Any], run_id: str) -> None:
    db().film_reports.insert_one(dict(report, runId=run_id))
    db().athletes.update_one({"id": report["athleteId"]}, {"$set": {"filmSummary": {k: report[k] for k in ("overall", "scores", "strengths", "fixFirst", "confidence", "generatedAt", "evaluated", "plays")}}})


def save_drafts(drafts: List[Dict[str, Any]]) -> int:
    """A new run replaces the athlete's unapproved drafts for the same program; approved / rejected ones are kept."""
    if not drafts:
        return 0
    d = db()
    for x in drafts:
        d.drafts.delete_many({"athleteId": x["athleteId"], "school": x["school"], "status": {"$in": ["draft", "needs_review"]}})
    d.drafts.insert_many([dict(x) for x in drafts])
    return len(drafts)


def load_athlete(athlete_id: str) -> Dict[str, Any]:
    a = db().athletes.find_one({"id": athlete_id}, {"_id": 0})
    if not a:
        raise SystemExit(f"unknown athlete {athlete_id} (run load_mongo.py first)")
    return a
