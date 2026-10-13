"""Trading-card data for an athlete: one JSON payload the player page (and any card design) reads, rebuilt from verified data.

usage: python -P recruit/card_data.py [--athlete <athlete-id>]

Reads the same verified files as the reports (official box-score lines, the season film study, the blind audit, the
highlight order, the package fields) and writes:
  data/packages/<id>/card.json      the payload (also served at GET /api/athletes/<id>/card)
  Mongo gridiron.athletes.<id>.card the same payload, when MONGO_URL (default mongodb://localhost:27017) is reachable
Rules: no number is typed in by hand; every block carries its source and as-of date; unconfirmed measurables are
flagged; the rank block stays null until the ranking engine has a real peer pool. Re-run after any stat or film update.
"""
from __future__ import annotations
import argparse, csv, json, os, pathlib, statistics
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent
G = ROOT / "data" / "games"


def rating_nfl(c, a, y, td, i):
    cl = lambda v: max(0.0, min(2.375, v))
    return round((cl((c / a - 0.3) * 5) + cl((y / a - 3) * 0.25) + cl(td / a * 20) + cl(2.375 - i / a * 25)) / 6 * 100, 1)


def efficiency_ncaa(c, a, y, td, i):
    return round((8.4 * y + 330 * td + 100 * c - 200 * i) / a, 1)


def split(rows, pred):
    rs = [r for r in rows if pred(r)]
    att = [r for r in rs if r["outcome"] in ("complete", "incomplete", "interception")]
    cmp_ = [r for r in att if r["outcome"] == "complete"]
    yds = sum(int(r["gain"] or 0) for r in cmp_)
    return {"dropbacks": len(rs), "cmp": len(cmp_), "att": len(att), "yds": yds, "ypa": round(yds / len(att), 1) if att else None,
            "td": sum(1 for r in cmp_ if r["td"] == "True"), "int": sum(1 for r in rs if r["outcome"] == "interception"),
            "sacks": sum(1 for r in rs if r["outcome"] == "sack")}


def build(athlete: str) -> dict:
    ath = json.load(open(ROOT / "data" / "athletes" / f"{athlete}.json", encoding="utf-8"))
    pkg = json.load(open(ROOT / "data" / "athletes" / f"{athlete}.package.json", encoding="utf-8"))
    off = json.load(open(G / "season_2026_official_check.json", encoding="utf-8"))
    scores = json.load(open(G / "season_2026_scores.json", encoding="utf-8"))
    rows = list(csv.DictReader(open(G / "season_2026_dropbacks.csv", encoding="utf-8")))
    audit = json.load(open(G / "season_2026_blind_audit.json", encoding="utf-8"))
    hl = json.load(open(ROOT / "data" / "packages" / athlete / "highlight_midseason_2026.json", encoding="utf-8"))
    so = off["season_official"]
    wins = sum(1 for s in scores.values() if (s["result"] or "").startswith("W"))
    losses = sum(1 for s in scores.values() if (s["result"] or "").startswith("L"))
    career = {k: sum(p[k] for p in pkg["career_prior"]) + so[k] for k in ("cmp", "att", "yds", "td", "int")}
    v = {k: sum(1 for r in rows if r["verdict"] == k) for k in ("right read", "acceptable", "missed read", "cannot tell")}
    judged = v["right read"] + v["acceptable"] + v["missed read"]
    confirmed = sum(1 for x in audit if x["prior"] == "missed read" and x["verdict"] == "missed read")
    timed = [float(r["ttt"]) for r in rows if r["ttt"]]
    third4 = split(rows, lambda r: r["down"] in ("3", "4"))
    clean = split(rows, lambda r: r["pressure"] == "none")
    rz = split(rows, lambda r: r["ytg"] and int(r["ytg"]) <= 20)
    top = hl["reel"][0]
    ms = pkg["measurables"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    card = {
        "id": ath["id"], "name": ath["name"], "firstName": ath["firstName"], "lastName": ath["lastName"],
        "position": ath["position"], "jersey": ath["jersey"], "throws": ath["throws"], "gradYear": ath["gradYear"],
        "school": ath["highSchool"], "city": ath["city"], "state": ath["state"],
        "classification": f"UIL {ath['uil']['conference']} District {ath['uil']['footballDistrict']}",
        "photoUrl": ath.get("media", {}).get("photoUrl") or None,
        "measurables": {k: {"value": ms[k]["value"], "confirmed": ms[k]["confirmed"], "source": ms[k]["source"]} for k in ("height", "weight")},
        "season": {"year": 2026, "games": len(scores), "record": f"{wins}-{losses}", "cmp": so["cmp"], "att": so["att"],
                   "pct": round(100 * so["cmp"] / so["att"], 1), "yds": so["yds"], "ypa": round(so["yds"] / so["att"], 1),
                   "td": so["td"], "int": so["int"], "ncaaEfficiency": efficiency_ncaa(so["cmp"], so["att"], so["yds"], so["td"], so["int"]),
                   "nflRating": rating_nfl(so["cmp"], so["att"], so["yds"], so["td"], so["int"]),
                   "source": "official box scores (MaxPreps game pages plus any official opponent box score)"},
        "career": {**career, "games": sum(p["gp"] for p in pkg["career_prior"]) + len(scores), "source": "MaxPreps varsity career + 2026 official"},
        "film": {"dropbacks": len(rows), "judged": judged, "rightReads": v["right read"], "acceptable": v["acceptable"],
                 "rightOrAcceptablePct": round(100 * (v["right read"] + v["acceptable"]) / judged), "missedFlagged": v["missed read"],
                 "missedConfirmedBlind": confirmed, "cantTell": v["cannot tell"],
                 "ballOutMedianS": round(statistics.median(timed), 1), "ballOutTimed": len(timed),
                 "cleanPocket": clean, "thirdAndFourthDown": third4, "redZone": rz,
                 "method": "every 2026 dropback read from game film by a reviewer and a second checker; flagged misses re-judged blind",
                 "source": "Gridiron Scout season film study (family-run, AI-assisted, ~1 frame/s Hudl wide angle)"},
        "highlights": {"topPlay": {k: top[k] for k in ("opponent", "situation", "result", "score")}, "reelPlays": len(hl["reel"]),
                       "reelUrl": pkg["links"]["highlight_reel"]["url"] or None},
        "rank": {"national": None, "state": None, "percentile": None, "pool": None,
                 "note": "filled by the ranking engine once a comparable peer pool exists"},
        "links": {"maxpreps": pkg["links"]["maxpreps"], "hudl": ath.get("media", {}).get("hudlUrl")},
        "asOf": now, "version": 1,
    }
    return card


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--athlete", default="quinn-placeholder")
    a = ap.parse_args()
    card = build(a.athlete)
    out = ROOT / "data" / "packages" / a.athlete / "card.json"
    json.dump(card, open(out, "w", encoding="utf-8"), indent=1)
    msg = "mongo: skipped"
    try:
        from pymongo import MongoClient
        cli = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"), serverSelectionTimeoutMS=2000)
        res = cli["gridiron"]["athletes"].update_one({"id": a.athlete}, {"$set": {"card": card}})
        msg = f"mongo: matched {res.matched_count}, modified {res.modified_count}"
    except Exception as e:
        msg = f"mongo: not written ({type(e).__name__})"
    print(f"wrote {out} | {msg} | season {card['season']['cmp']}/{card['season']['att']} {card['season']['yds']} yds, NCAA eff {card['season']['ncaaEfficiency']}")


if __name__ == "__main__":
    main()
