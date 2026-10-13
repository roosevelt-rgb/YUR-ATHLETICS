"""Agent entry point (what the Express route and the weekly schedule call).

python -P agent/run.py --athlete <athlete-id> --pipeline film-evaluation|recruiting-outreach|all [--limit N] [--engines xai] [--dry]
Exit code 0 on success; prints one JSON line at the end for the caller."""
from __future__ import annotations
import argparse
import json
import pathlib
import sys
import traceback

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from agent import film_evaluator, outreach, store


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--athlete", required=True); ap.add_argument("--pipeline", default="all", choices=["film-evaluation", "recruiting-outreach", "all"])
    ap.add_argument("--limit", type=int, default=0); ap.add_argument("--engines", default=""); ap.add_argument("--dry", action="store_true")
    ap.add_argument("--follow-up", action="store_true"); ap.add_argument("--no-consensus", action="store_true")
    a = ap.parse_args()
    out = {"athlete": a.athlete, "pipeline": a.pipeline, "runs": []}
    try:
        if a.pipeline in ("film-evaluation", "all"):
            plays = [p for p in film_evaluator.play_catalog() if p["sheets"]]
            if a.limit:
                plays = plays[:a.limit]
            r = film_evaluator.evaluate(a.athlete, plays, a.engines or None, not a.no_consensus, a.dry)
            out["runs"].append({"pipeline": "film-evaluation", "runId": (r["run"] or {}).get("id"), "evaluated": r["report"]["evaluated"], "overall": r["report"]["overall"]})
        if a.pipeline in ("recruiting-outreach", "all"):
            r = outreach.draft(a.athlete, a.limit, a.follow_up, a.engines or None, a.dry)
            out["runs"].append({"pipeline": "recruiting-outreach", "runId": r["run"].get("id"), "drafted": r["report"].get("drafted"), "needsReview": r["report"].get("needsReview"), "held": len(r["held"])})
        out["ok"] = True
    except Exception as e:
        out.update({"ok": False, "error": f"{e.__class__.__name__}: {e}", "trace": traceback.format_exc()[-1500:]})
    print("RESULT " + json.dumps(out))
    sys.exit(0 if out.get("ok") else 1)


if __name__ == "__main__":
    main()
