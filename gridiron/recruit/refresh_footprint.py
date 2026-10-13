"""Recompute every program's roster footprint (total / Texas / DFW / top states) from the stored 2026 rosters.

Why: sidearm_parser.footprint counted DFW city names without a Texas check, so 'Dallas, Ga.', 'Allen, Okla.' and
'Princeton, N.J.' counted as DFW. The parser is fixed (is_dfw); this rewrites the stored numbers without re-scraping.
Source of truth: Mongo gridiron.players (school, hometown). Writes Mongo colleges.rosterProfile.footprint.
usage: python -P recruit/refresh_footprint.py [--dry]
"""
from __future__ import annotations
import argparse, pathlib, sys
from collections import defaultdict
from pymongo import MongoClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from sidearm_parser import footprint  # noqa: E402


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    db = MongoClient("mongodb://localhost:27017")["gridiron"]
    by = defaultdict(list)
    for p in db.players.find({}, {"_id": 0, "school": 1, "hometown": 1}):
        by[p["school"]].append({"hometown": p.get("hometown") or ""})
    changed, same, missing = [], 0, 0
    for c in db.colleges.find({"rosterProfile": {"$exists": True}}, {"_id": 1, "metadata.name": 1, "rosterProfile.footprint": 1}):
        name = c["metadata"]["name"]
        ps = by.get(name)
        if not ps:
            missing += 1
            continue
        new = footprint(ps)
        old = (c.get("rosterProfile") or {}).get("footprint") or {}
        if old.get("dfw") != new["dfw"] or old.get("texas") != new["texas"] or old.get("total") != new["total"]:
            changed.append((name, old.get("texas"), new["texas"], old.get("dfw"), new["dfw"]))
            if not a.dry:
                db.colleges.update_one({"_id": c["_id"]}, {"$set": {"rosterProfile.footprint": {"total": new["total"], "texas": new["texas"], "dfw": new["dfw"],
                                                                                              "topStates": new["top_states"]}}})
        else:
            same += 1
    print(f"programs changed {len(changed)}  unchanged {same}  no stored roster {missing}  ({'dry run' if a.dry else 'written'})")
    for n, ot, nt, od, nd in sorted(changed, key=lambda x: -abs((x[3] or 0) - x[4]))[:15]:
        print(f"  {n[:40]:<40} TX {ot}->{nt}  DFW {od}->{nd}")


if __name__ == "__main__":
    main()
