"""Quarterback intake history per program, from the historical rosters (players_hist) + the current 2026 roster.

For every program it reconstructs each quarterback's career on that roster (seasons, class each season, size, hometown,
high school or previous college), decides how he arrived (high-school signee vs transfer), and summarizes the program's
revealed preference: how many HS quarterbacks it takes per year, from where (Texas, DFW, UIL classification), how big,
and how many arrivals look like a given athlete ("comparables").

Arrival rules (honest about censoring):
  - first season seen == earliest archived season for that program -> intake "unknown" (he may have arrived earlier)
  - first class FR / RFR (redshirt freshman) and previous school is not a college -> "hs" (high-school signee)
  - previous school looks like a college (University, College, CC, JC, State, A&M, Tech, Institute) or first class SO+ -> "transfer"
UIL classification uses the 2026-28 alignment (schools move classes over time; treated as approximate).

usage: python -P recruit/qb_history.py [--athlete <athlete-id>]
writes Mongo gridiron.qb_careers, gridiron.program_qb_history; data/qb_history/program_qb_history.csv
"""
from __future__ import annotations
import argparse, csv, json, pathlib, re, sqlite3, statistics, sys
from collections import defaultdict
from pymongo import MongoClient

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from sidearm_parser import is_dfw  # noqa: E402

COLLEGE_RX = re.compile(r"\b(university|college|univ\.?|cc|jc|juco|community|state|a&m|tech|institute|academy of|u\.)\b", re.I)
HS_CLASSES = {"FR", "RFR"}
LATER = {"SO", "RSO", "JR", "RJR", "SR", "RSR", "GR"}


def norm(s: str) -> str:
    return re.sub(r"[^a-z]", "", (s or "").lower())


def is_texas(home: str) -> bool:
    return bool(re.search(r"\btexas\b|\bTX\b|\bTex\.", home or "", re.I))


def city_of(home: str) -> str:
    return (home or "").split(",")[0].strip()


class UIL:
    def __init__(self, con):
        self.rows = [dict(zip(("school", "conference", "enrollment"), r)) for r in con.execute("SELECT school, conference, enrollment FROM hs_schools")]
        self.by = {norm(r["school"]): r for r in self.rows}

    def match(self, prev: str, home: str) -> dict | None:
        if not prev or not is_texas(home):
            return None
        p = re.sub(r"\b(high school|h\.?s\.?|senior high|high)\b", "", prev, flags=re.I).strip(" ,.-")
        city = city_of(home)
        for key in (norm(p), norm(city + " " + p), norm(p.replace(city, "").strip())):
            if key and key in self.by:
                return self.by[key]
        # unique suffix match ("Oak Hill" -> "Springfield Oak Hill") within the same city
        cands = [r for k, r in self.by.items() if k.endswith(norm(p)) and len(norm(p)) >= 5 and k.startswith(norm(city))]
        return cands[0] if len(cands) == 1 else None


def careers(rows: list[dict]) -> list[dict]:
    by = defaultdict(list)
    for r in rows:
        by[(norm(r["name"]), norm(city_of(r["hometown"])) or "x")].append(r)
    out = []
    for (_, _), rs in by.items():
        rs.sort(key=lambda r: r["season"])
        hs = [r["height_in"] for r in rs if r["height_in"]]
        out.append({"name": rs[-1]["name"], "seasons": [r["season"] for r in rs], "classes": [r["class"] for r in rs],
                    "first_season": rs[0]["season"], "first_class": rs[0]["class"] or "", "last_season": rs[-1]["season"],
                    "height_in": int(statistics.median(hs)) if hs else None, "weight_lb": rs[0]["weight_lb"],
                    "hometown": next((r["hometown"] for r in rs if r["hometown"]), ""),
                    "previous_school": next((r["previous_school"] for r in rs if r["previous_school"]), "")})
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--athlete", default="quinn-placeholder")
    a = ap.parse_args()
    con = sqlite3.connect(HERE / "ledger.db", timeout=180); con.row_factory = sqlite3.Row
    uil = UIL(con)
    db = MongoClient("mongodb://localhost:27017")["gridiron"]
    ath = db.athletes.find_one({"id": a.athlete}, {"_id": 0})
    a_h = ath.get("heightInches") or (ath.get("listed") or {}).get("heightInches") or 72
    a_uil = "6A"
    divs = {c["metadata"]["name"]: c["metadata"].get("division", "") for c in db.colleges.find({}, {"_id": 0, "metadata.name": 1, "metadata.division": 1})}
    hist = defaultdict(list)
    for r in con.execute("SELECT college, season, name, class, height_in, weight_lb, hometown, previous_school FROM players_hist WHERE pos_group='QB'"):
        hist[r["college"]].append(dict(r))
    for p in db.players.find({"pos_group": "QB"}, {"_id": 0, "school": 1, "name": 1, "class": 1, "height_in": 1, "weight_lb": 1, "hometown": 1, "previous_school": 1}):
        hist[p["school"]].append({"college": p["school"], "season": 2026, "name": p["name"], "class": p.get("class") or "", "height_in": p.get("height_in"),
                                  "weight_lb": p.get("weight_lb"), "hometown": p.get("hometown") or "", "previous_school": p.get("previous_school") or ""})
    prog_rows, career_docs = [], []
    for college, rows in hist.items():
        seasons = sorted({r["season"] for r in rows})
        if len(seasons) < 2:
            continue
        first_archived = seasons[0]
        cs = careers(rows)
        intakes = []
        for c in cs:
            prev = c["previous_school"]; fc = c["first_class"]
            if c["first_season"] == first_archived:
                kind = "unknown"
            elif COLLEGE_RX.search(prev or "") or fc in LATER:
                kind = "transfer"
            elif fc in HS_CLASSES or not fc:
                kind = "hs"
            else:
                kind = "unknown"
            u = uil.match(prev, c["hometown"])
            c.update({"college": college, "division": divs.get(college, ""), "intake": kind, "texas": is_texas(c["hometown"]),
                      "dfw": is_dfw(c["hometown"]), "uil": u["conference"] if u else None, "uil_school": u["school"] if u else None})
            c["comparable"] = (kind == "hs" and c["texas"] and c["height_in"] is not None and abs(c["height_in"] - a_h) <= 2
                               and (c["uil"] in ("6A", "5A")))
            career_docs.append(c)
            if kind in ("hs", "transfer"):
                intakes.append(c)
        hs = [c for c in intakes if c["intake"] == "hs"]
        tr = [c for c in intakes if c["intake"] == "transfer"]
        win = [y for y in seasons if y != first_archived]
        yrs = max(1, len(win))
        recent = [c for c in hs if c["first_season"] >= 2021]
        hh = [c["height_in"] for c in hs if c["height_in"]]
        prog = {
            "college": college, "division": divs.get(college, ""), "seasons_archived": len(seasons), "first_season": first_archived,
            "last_season": seasons[-1], "intake_years": yrs,
            "hs_qb_intakes": len(hs), "hs_qb_per_year": round(len(hs) / yrs, 2), "transfer_qb_intakes": len(tr),
            "transfer_share": round(len(tr) / max(1, len(hs) + len(tr)), 2),
            "texas_hs_qb": sum(c["texas"] for c in hs), "texas_share": round(sum(c["texas"] for c in hs) / max(1, len(hs)), 2),
            "dfw_hs_qb": sum(c["dfw"] for c in hs), "tx_6a_hs_qb": sum(1 for c in hs if c["uil"] == "6A"), "tx_5a_hs_qb": sum(1 for c in hs if c["uil"] == "5A"),
            "hs_height_median": statistics.median(hh) if hh else None, "hs_height_p25": (sorted(hh)[len(hh) // 4] if hh else None),
            "hs_at_or_below_athlete_height": sum(1 for h in hh if h <= a_h), "comparables": sum(c["comparable"] for c in intakes),
            "comparables_since_2021": sum(1 for c in recent if c["comparable"]),
            "comparable_names": [f"{c['name']} ({c['first_season']}, {c['uil_school']}, {c['height_in']}in)" for c in intakes if c["comparable"]][:12],
            "athlete": a.athlete, "athlete_height_in": a_h, "athlete_uil": a_uil,
        }
        prog_rows.append(prog)
    out = HERE / "data" / "qb_history"; out.mkdir(parents=True, exist_ok=True)
    with open(out / "program_qb_history.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[k for k in prog_rows[0] if k != "comparable_names"] + ["comparable_names"]); w.writeheader()
        for p in sorted(prog_rows, key=lambda p: (-p["comparables"], -p["texas_hs_qb"])):
            w.writerow({**p, "comparable_names": "; ".join(p["comparable_names"])})
    db.qb_careers.delete_many({}); db.qb_careers.insert_many([dict(c) for c in career_docs]) if career_docs else None
    db.program_qb_history.delete_many({}); db.program_qb_history.insert_many([dict(p) for p in prog_rows]) if prog_rows else None
    print(f"programs {len(prog_rows)}  qb careers {len(career_docs)}  hs intakes {sum(p['hs_qb_intakes'] for p in prog_rows)}  "
          f"transfers {sum(p['transfer_qb_intakes'] for p in prog_rows)}  uil-matched {sum(1 for c in career_docs if c['uil'])}")
    for p in sorted(prog_rows, key=lambda p: (-p["comparables"], -p["texas_hs_qb"]))[:15]:
        print(f"  {p['college'][:34]:<34} {p['division']:<5} {p['first_season']}-{p['last_season']} HS QBs {p['hs_qb_intakes']:>3} ({p['hs_qb_per_year']}/yr) "
              f"TX {p['texas_hs_qb']:>3} 6A {p['tx_6a_hs_qb']:>2} DFW {p['dfw_hs_qb']:>2} transfers {p['transfer_qb_intakes']:>2} med ht {p['hs_height_median']} comps {p['comparables']} (since21 {p['comparables_since_2021']})")


if __name__ == "__main__":
    main()
