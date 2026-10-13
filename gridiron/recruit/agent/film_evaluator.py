"""Film evaluator: per-play frame sheets -> QB rubric (GolfSnapPro six-section prompt, football) -> consensus -> notes + rollup.

Inputs (on disk under REEL_ROOT, default recruit/data/reel, which stays out of git; nothing is re-rendered locally):
  catalog.json        {"plays": [{"id", "desc", "label", "game", "td", "window": [in_s, out_s], "sheets": ["sheets/<id>.jpg"], "clip"}]}
                      in reel order; "game" is free text such as "vs Opponent (date)"; "clip" is read by frames.py on the pod
  sheets/<id>.jpg     1-s frame sheets per play (paths in "sheets" are relative to REEL_ROOT)
Frame extraction from the 1080p clips (ffmpeg) is pod work per the no-local-heavy-compute rule; `frames.py` is written
for the RunPod pod and is not run here. The sheets are what the evaluator sees today, and every note links the sheet it used.

usage: python -P agent/film_evaluator.py --athlete <athlete-id> [--plays <id>,<id>] [--limit N] [--engines xai]
       [--no-consensus] [--dry] [--from-json notes.json]   (from-json loads a hand/in-session evaluation in the same shape)
"""
from __future__ import annotations
import argparse
import os
import json
import pathlib
import re
import sys
from typing import Any, Dict, List

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(os.environ.get("REEL_ROOT") or HERE.parent / "data" / "reel")   # reel catalog and frame sheets stay out of git
sys.path.insert(0, str(HERE.parent))

from agent.models import POINT_CODES, SECTION_KEYS, SECTION_TITLES, empty_play_note
from agent.planner import build_film_plan
from agent.scheduler import WorkloadOrchestrator
from agent.consensus import merge_notes
from agent.synthesizer import film_rollup
from agent import store

SYSTEM = ("You are a college quarterback coach writing film notes for a high-school quarterback's own development. "
          "You only describe what is visible in the frames you are given, you say plainly what you cannot judge, and you never "
          "invent measurables, stats, or outcomes. No medical or injury language. Return JSON only.")

PROMPT = """The image is a frame sheet of ONE play: consecutive frames in time order (left to right, then top to bottom); each cell is labelled with its timestamp in seconds. The play is roughly seconds {t_in}-{t_out}; cells outside that window are context.
Athlete: {name}, #{jersey}, {position}, throws {throws}, class of {gradYear}, {highSchool}. Identify him by jersey number only.
Play: {desc}   (game: {game}{td})

Evaluate, using ONLY what is visible:
1. PRE-SNAP & SETUP   - alignment (gun / under center), formation + motion use, posture, eyes before the snap
2. DROP & FOOTWORK    - drop type and depth, base, hitch / reset, balance, eyes up through the drop
3. POCKET & PRESSURE  - pocket movement (climb / slide), handling of pressure, when he leaves, scramble decision
4. RELEASE & ARM      - platform (set vs. on the run), release timing, arm angle ({throws}-handed), follow-through
5. BALL PLACEMENT & DECISION - target choice vs. coverage, anticipation / timing, placement relative to the defender, outcome
6. KEY ISSUES (top 3) - most critical items on this play, their impact, priority order
7. DRILLS (3-5)       - name, step-by-step instructions, what it fixes, reps / duration
8. SHOW COACHES       - one sentence on what a college coach should notice first here, and whether this play belongs in the first 60 seconds of a reel

Prime points per phase (S1 Pre-snap, S2 Snap/mesh, S3 Drop, S4 Set/hitch, S5 Release, S6 Ball in air, S7 Result): metric, score 0-1, severity low|moderate|high, one-line insight, and the frame label (seconds) you judged it from.
Scores 0-100: overall, decision, accuracy, mechanics, mobility. Visibility: what the resolution / angle does NOT let you judge, and a 0-1 confidence.

Return ONE JSON object only, exactly this shape:
{{"sections":{{"pre_snap":{{"title":"PRE-SNAP & SETUP","items":[{{"item":"","observation":"","recommendation":""}}]}},"drop_footwork":{{"title":"DROP & FOOTWORK","items":[]}},"pocket_pressure":{{"title":"POCKET & PRESSURE","items":[]}},"release_arm":{{"title":"RELEASE & ARM","items":[]}},"ball_decision":{{"title":"BALL PLACEMENT & DECISION","items":[]}}}},
 "key_issues":[{{"priority":1,"name":"","description":"","impact_on_play":""}}],
 "drills":[{{"name":"","fixes":"","instructions":"","reps":""}}],
 "show_coaches":{{"note":"","reel_opener":true}},
 "prime_points":[{{"point_code":"S5","metric":"","score":0.8,"severity":"low","insight":"","frame_label":""}}],
 "scores":{{"overall":0,"decision":0,"accuracy":0,"mechanics":0,"mobility":0}},
 "visibility":{{"limits":"","confidence":0.0}}}}"""


def play_catalog(only: List[str] | None = None) -> List[Dict[str, Any]]:
    """REEL_ROOT/catalog.json in reel order; a play keeps only the frame sheets that exist on disk."""
    path = ROOT / "catalog.json"
    if not path.exists():
        return []
    out = []
    for i, s in enumerate(json.load(open(path, encoding="utf-8")).get("plays", []), 1):
        pid = s["id"]
        if only and pid not in only:
            continue
        window = s.get("window")
        out.append({
            "id": pid, "reelOrder": i, "desc": s.get("desc", ""), "label": s.get("label", ""), "game": s.get("game", ""),
            "td": bool(s.get("td")), "window": window if window and window[0] is not None else None,
            "sheets": [str(ROOT / p) for p in s.get("sheets", []) if (ROOT / p).exists()],
        })
    return out


def compose(step, _store):
    play = step.payload["play"]; a = step.payload["athlete"]
    t_in, t_out = (play.get("window") or ["?", "?"])
    return PROMPT.format(t_in=t_in, t_out=t_out, name=a.get("name"), jersey=a.get("jersey"), position=a.get("position"), throws=a.get("throws", "?"),
                         gradYear=a.get("gradYear"), highSchool=a.get("highSchool"), desc=play.get("desc", ""), game=play.get("game", ""),
                         td=", touchdown" if play.get("td") else ""), SYSTEM


def to_note(play: Dict[str, Any], data: Dict[str, Any], engine: str) -> Dict[str, Any]:
    note = empty_play_note(play)
    note["frames"] = [{"frame_url": p, "label": pathlib.Path(p).stem} for p in play.get("sheets", [])]
    note["engine"] = engine
    if not data or data.get("_unparsed"):
        note["visibility"] = {"limits": "model reply was not valid JSON; raw text kept in rawText", "confidence": 0.0}
        note["rawText"] = json.dumps(data.get("sections_text", {}))[:4000] if data else ""
        return note
    for sk in SECTION_KEYS:
        sec = (data.get("sections") or {}).get(sk) or {}
        items = [it for it in (sec.get("items") or []) if isinstance(it, dict)]
        note["sections"][sk] = {"title": SECTION_TITLES[sk], "items": items[:6]}
    note["key_issues"] = [k for k in (data.get("key_issues") or []) if isinstance(k, dict)][:3]
    note["drills"] = [d for d in (data.get("drills") or []) if isinstance(d, dict)][:5]
    note["show_coaches"] = data.get("show_coaches") if isinstance(data.get("show_coaches"), dict) else {"note": "", "reel_opener": False}
    valid = {c for c, _ in POINT_CODES}
    note["prime_points"] = [p for p in (data.get("prime_points") or []) if isinstance(p, dict) and p.get("point_code") in valid]
    note["scores"] = {k: float(v) for k, v in (data.get("scores") or {}).items() if isinstance(v, (int, float))}
    note["visibility"] = data.get("visibility") if isinstance(data.get("visibility"), dict) else {"limits": "", "confidence": 0.5}
    # a zero overall (or none) means "not scorable from these frames", not a grade: keep the note, exclude it from averages
    note["graded"] = bool(note["scores"].get("overall"))
    if not note["graded"]:
        note["scores"] = {}
    return note


def rollup_handler(step, _store, context):
    notes = context["artifacts"]["notes"]
    rep = film_rollup(context["athlete"], notes)
    context["artifacts"]["report"] = rep
    return {"text": rep["markdown"][:600], "confidence": rep.get("confidence") or 0.0}


def evaluate(athlete_id: str, plays: List[Dict[str, Any]], engines: str | None, consensus: bool, dry: bool, log=print) -> Dict[str, Any]:
    import os
    if engines:
        os.environ["AGENT_ENGINES"] = engines
    # 2026-10-11 timing on the same sheet: grok-4.7 (reasoning) 90-180 s and often "not scorable"; grok-4.20 non-reasoning 27 s with a
    # full note. Vision steps default to the fast one; XAI_MODEL in the environment still wins.
    os.environ.setdefault("XAI_MODEL", "grok-4.20-0309-non-reasoning")
    athlete = store.load_athlete(athlete_id)
    run = None if dry else store.start_run(athlete_id, "film-evaluation", {"plays": [p["id"] for p in plays], "engines": engines, "consensus": consensus})
    steps = build_film_plan(plays, consensus=consensus)
    for s in steps:
        s.payload["athlete"] = athlete
    context = {"athlete": athlete, "compose": compose, "artifacts": {"notes": []}}
    orch = WorkloadOrchestrator(handlers={"film_rollup": rollup_handler}, workers=2, log=log)

    # evaluate stage, then build notes, then rollup (handler reads context.artifacts.notes)
    eval_steps = [s for s in steps if s.payload.get("kind") == "film_play"]
    report0 = orch.run("film-evaluation " + athlete_id, eval_steps, context)
    notes = []
    for s in eval_steps:
        r = report0.results.get(s.id)
        play = s.payload["play"]
        if not r or r.error:
            notes.append(dict(empty_play_note(play), engine=r.engine if r else "none", error=r.error if r else "no result", engines=[], confidence=0.0)); continue
        answers = r.data.get("answers") if r.data.get("answers") is not None else [r.data]
        engs = r.data.get("engines") or [r.engine]
        per_engine = [to_note(play, d, e) for d, e in zip(answers, engs)]
        notes.append(merge_notes(empty_play_note(play), per_engine))
    context["artifacts"]["notes"] = notes
    roll = [s for s in steps if s.payload.get("kind") == "film_rollup"]
    report1 = orch.run("film-rollup " + athlete_id, roll, context)
    rep = context["artifacts"].get("report") or film_rollup(athlete, notes)

    outdir = HERE.parent / "data" / "film" / athlete_id
    outdir.mkdir(parents=True, exist_ok=True)
    stamp = rep["generatedAt"][:10]
    (outdir / f"notes_{stamp}.json").write_text(json.dumps(notes, indent=1), encoding="utf-8")
    (outdir / f"rollup_{stamp}.md").write_text(rep["markdown"], encoding="utf-8")
    log(f"wrote {outdir / f'notes_{stamp}.json'} and rollup_{stamp}.md")
    if not dry and run:
        n = store.save_notes(athlete_id, run["id"], notes)
        store.save_report({k: v for k, v in rep.items()}, run["id"])
        store.finish_run(run, "done", {"plays": len(plays), "evaluated": rep["evaluated"], "notes": n}, rep["markdown"], report0.timeline + report1.timeline)
        log(f"run {run['id']}: {rep['evaluated']}/{len(plays)} evaluated, overall {rep['overall']}, confidence {rep['confidence']}")
    return {"notes": notes, "report": rep, "run": run}


def load_from_json(athlete_id: str, path: pathlib.Path, log=print) -> None:
    """Load notes produced outside the pipeline (same shape; e.g. an in-session evaluation) and build the rollup."""
    athlete = store.load_athlete(athlete_id)
    raw = json.load(open(path, encoding="utf-8"))
    cat = {p["id"]: p for p in play_catalog()}
    notes = []
    for item in raw:
        play = cat.get(item["playId"]) or {"id": item["playId"], "desc": item.get("desc", ""), "game": item.get("game", "")}
        note = to_note(play, item, item.get("engine", "in-session"))
        note["engines"] = [note["engine"]]; note["confidence"] = round(float((note.get("visibility") or {}).get("confidence") or 0.6) * 0.9, 2)
        notes.append(note)
    run = store.start_run(athlete_id, "film-evaluation", {"fromJson": str(path), "plays": [n["playId"] for n in notes]})
    rep = film_rollup(athlete, notes)
    outdir = HERE.parent / "data" / "film" / athlete_id; outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"rollup_{rep['generatedAt'][:10]}.md").write_text(rep["markdown"], encoding="utf-8")
    store.save_notes(athlete_id, run["id"], notes); store.save_report(rep, run["id"])
    store.finish_run(run, "done", {"plays": len(notes), "evaluated": rep["evaluated"]}, rep["markdown"], [])
    log(f"loaded {len(notes)} notes from {path.name}; run {run['id']}; overall {rep['overall']}")


def rollup_only(athlete_id: str, log=print) -> None:
    """Recompute the season rollup from the notes already in Mongo (no model calls)."""
    athlete = store.load_athlete(athlete_id)
    notes = list(store.db().film_notes.find({"athleteId": athlete_id}, {"_id": 0}).sort("reelOrder", 1))
    rep = film_rollup(athlete, notes)
    outdir = HERE.parent / "data" / "film" / athlete_id; outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"rollup_{rep['generatedAt'][:10]}.md").write_text(rep["markdown"], encoding="utf-8")
    store.save_report(rep, notes[0].get("runId", "rollup") if notes else "rollup")
    log(f"rollup from {len(notes)} notes: overall {rep['overall']}, fix-first {[f['name'] for f in rep['fixFirst']]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--athlete", default="quinn-placeholder"); ap.add_argument("--plays", default=""); ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--engines", default=""); ap.add_argument("--no-consensus", action="store_true"); ap.add_argument("--dry", action="store_true")
    ap.add_argument("--from-json", default=""); ap.add_argument("--list", action="store_true"); ap.add_argument("--rollup-only", action="store_true")
    a = ap.parse_args()
    if a.rollup_only:
        return rollup_only(a.athlete)
    if a.from_json:
        return load_from_json(a.athlete, pathlib.Path(a.from_json))
    plays = play_catalog([x.strip() for x in a.plays.split(",") if x.strip()] or None)
    if a.limit:
        plays = plays[:a.limit]
    if a.list:
        for p in plays: print(p["reelOrder"], p["id"], p["game"], p["window"], p["sheets"] and pathlib.Path(p["sheets"][0]).name, "|", p["desc"])
        return
    missing = [p["id"] for p in plays if not p["sheets"]]
    if missing:
        print("no sheet for:", missing)
    plays = [p for p in plays if p["sheets"]]
    evaluate(a.athlete, plays, a.engines or None, not a.no_consensus, a.dry)


if __name__ == "__main__":
    main()
