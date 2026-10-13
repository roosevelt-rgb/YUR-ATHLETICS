"""QB Match v1, "Pathway x Player Fit" (design: recruit/MATCH_V1_DESIGN.md). Deterministic, no LLM anywhere in scoring.

A match is a program whose own rosters show it already brings in high-school quarterbacks like the athlete: Texas / DFW,
about his size, passers rather than runners, at a school that still signs HS QBs. MATCH ranks past behaviour. It is NOT a
chance of an offer.

Data
  rosters  : ledger.db players_hist (2006-2025, all positions) + Mongo gridiron.players (2026)
  QB careers are rebuilt here from those rows (name + hometown city), so one feature builder serves both the live board
  (predict the athlete's class Y, the record's gradYear, from seasons < Y) and the rolling backtest (predict class Y from seasons < Y).
  scheme   : data/match_inputs/scheme_ncaa_2026.json (ncaa.com 2026 team + individual tables, prototype pull)
  comps    : data/match_inputs/hs_comps_maxpreps.json (MaxPreps HS lines of 11 signees; family view only, never quoted out)

Pathway (0-100)  = 100 * (wP*P + wQ*Q + wC*C + wN*N)
  P  Texas / DFW share of the whole roster in season Y-1 (DFW requires a Texas hometown)
  Q  Texas share of the QB room in Y-1, smoothed toward the division
  C  look-alike signees: Texas HS QBs no taller than LOOKALIKE_MAX in the last 4 classes, each class weighted 0.5^(age/2) (half-life 2 classes)
  N  slot outlook: HS-QB intake rate and Y-1 seniors x HS share of arrivals; projected, commits not known
PlayerFit (0-100) = weighted mean of the checks that have data: SZ size 0.5, ST style 0.3, PR production 0.2
MATCH = Pathway * (0.6 + 0.4 * PlayerFit / 100)      (PlayerFit can only lower a pipeline, never create one)

usage
  python -P recruit/agent/qb_match.py --backtest            rolling 2016-2025 backtest, leave-one-season-out weights
  python -P recruit/agent/qb_match.py --score [--write]     board for the athlete's class; --write saves gridiron.matches
  python -P recruit/agent/qb_match.py --school "Hardin"     one program, with its inputs
"""
from __future__ import annotations
import argparse, hashlib, itertools, json, math, os, pathlib, re, sqlite3, statistics, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pymongo import MongoClient

RECRUIT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RECRUIT))
from sidearm_parser import is_dfw, is_texas  # noqa: E402

LOOKALIKE_MAX = int(os.environ.get("QB_MATCH_LOOKALIKE_MAX", "74"))   # inches: signees this tall or shorter count as look-alikes; set it near the athlete's height
HT = f"{LOOKALIKE_MAX // 12}'{LOOKALIKE_MAX % 12}\""
HALF_LIFE = 2.0             # classes; a signee two classes back counts half
WINDOW = 4                  # classes looked back
W_DESIGN = (0.60, 0.15, 0.15, 0.10)    # P, Q, C, N
PRIOR_N = 4                 # pseudo-count for the size prior
COLLEGE_HINT = re.compile(r"\b(cc|c c|jc|j c|community college|junior college|juco|university|college|state|univ)\b", re.I)
HS_HINT = re.compile(r"\b(hs|h s|high|high school|academy|prep|preparatory|christian|catholic|episcopal|jesuit|lutheran|regional|senior high|sr high|ihs|chs|area)\b", re.I)
LATER = {"SO", "RSO", "JR", "RJR", "SR", "RSR", "GR"}
LEAVING = {"SR", "RSR", "GR"}
CLASS_AGE = {"FR": 0, "RFR": 1, "SO": 1, "RSO": 2, "JR": 2, "RJR": 3, "SR": 3, "RSR": 4, "GR": 4}


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9& ]+", " ", (s or "").lower())).strip()


class Origins:
    """Where a QB arrived from: 'hs' | 'college' | 'unknown' (port of the prototype classifier, ~31/35 on a hand check)."""

    def __init__(self, db):
        keys = set()
        for c in db.colleges.find({}, {"metadata.name": 1}):
            n = norm(c["metadata"]["name"]); keys.add(n)
            short = re.sub(r" university$| college$", "", re.sub(r"^the |^university of |^college of ", "", n)).strip()
            if len(short) > 3:
                keys.add(short)
        keys |= {"lsu", "ucla", "usc", "tcu", "smu", "utsa", "utep", "unlv", "byu", "ucf", "usf", "uab", "uconn", "unc", "ole miss", "fiu", "fau",
                 "penn state", "ohio state", "texas tech", "texas a&m", "notre dame", "pitt", "miami", "georgia", "alabama", "auburn", "arkansas",
                 "florida", "oregon", "washington", "stanford", "nebraska", "purdue", "indiana", "illinois", "iowa", "kansas", "kentucky",
                 "louisville", "memphis", "houston", "rice", "baylor", "texas", "tulsa", "tulane", "cincinnati", "syracuse", "duke", "vanderbilt",
                 "clemson", "tennessee", "missouri", "minnesota", "wisconsin", "northwestern", "rutgers", "maryland", "marshall", "troy",
                 "toledo", "akron", "buffalo", "navy", "army", "western kentucky", "east carolina", "ut martin", "sfa", "oklahoma", "virginia",
                 "boston college", "colorado", "utah", "arizona", "nevada", "hawaii", "wyoming", "new mexico"}
        self.keys = keys

    def __call__(self, previous_school: str, first_class: str) -> str:
        prev = norm(previous_school)
        if not prev or prev in ("previous school", "high school"):
            return "unknown"
        parts = [norm(x) for x in re.split(r"/|,", previous_school or "") if norm(x)]
        if any(x in self.keys for x in parts):
            return "college"
        if HS_HINT.search(prev):
            return "hs"
        if COLLEGE_HINT.search(prev):
            return "college"
        return "college" if first_class == "GR" else "hs"


class UIL:
    def __init__(self, db):
        self.by = {norm(u["name"]): u for u in db.highschools.find({}, {"_id": 0, "name": 1, "conference": 1, "isDfw": 1})}

    def __call__(self, previous_school: str, hometown: str):
        if not is_texas(hometown):
            return None
        city = norm(hometown.split(",")[0])
        hs_home = norm(hometown.split("/")[1]) if "/" in hometown else ""
        for raw in (previous_school or "", hs_home):
            s = re.sub(r"\b(hs|h s|high school|high|school)\b", "", norm(raw)).strip()
            if not s:
                continue
            for k in (s, f"{city} {s}", city if s == city else None):
                if k and k in self.by:
                    return self.by[k]
            cands = [u for k, u in self.by.items() if k.endswith(" " + s) and k.startswith(city)]
            if len(cands) == 1:
                return cands[0]
        return None


# ----------------------------------------------------------------------------- data
class Data:
    """All roster-derived inputs, built once. careers[college] -> list of careers; fp[(college, season)] -> (total, tx, dfw)."""

    def __init__(self, db, con):
        self.db = db
        self.cols = {c["metadata"]["name"]: c for c in db.colleges.find({}, {"_id": 0, "metadata": 1, "rosterProfile.scrapeStatus": 1})}
        origin, uil = Origins(db), UIL(db)
        self.fp = defaultdict(lambda: [0, 0, 0])
        qb_rows = defaultdict(list)
        for college, season, pos_group, hometown, *rest in con.execute(
                "SELECT college, season, pos_group, hometown, name, class, height_in, previous_school FROM players_hist"):
            v = self.fp[(college, season)]; v[0] += 1; v[1] += is_texas(hometown); v[2] += is_dfw(hometown)
            if pos_group == "QB":
                name, cls, h, prev = rest
                qb_rows[college].append({"season": season, "name": name, "class": cls or "", "height_in": h, "hometown": hometown or "", "previous_school": prev or ""})
        for p in db.players.find({}, {"_id": 0, "school": 1, "hometown": 1, "pos_group": 1, "name": 1, "class": 1, "height_in": 1, "previous_school": 1}):
            v = self.fp[(p["school"], 2026)]; h = p.get("hometown") or ""; v[0] += 1; v[1] += is_texas(h); v[2] += is_dfw(h)
            if p.get("pos_group") == "QB":
                qb_rows[p["school"]].append({"season": 2026, "name": p["name"], "class": p.get("class") or "", "height_in": p.get("height_in"),
                                             "hometown": h, "previous_school": p.get("previous_school") or ""})
        self.seasons = defaultdict(set)
        for (c, s) in self.fp:
            self.seasons[c].add(s)
        self.careers = {}
        for college, rows in qb_rows.items():
            first_archived = min(self.seasons[college])
            by = defaultdict(list)
            for r in rows:
                by[(norm(r["name"]), norm(r["hometown"].split(",")[0]) or "x")].append(r)
            out = []
            for rs in by.values():
                rs.sort(key=lambda r: r["season"])
                hts = [r["height_in"] for r in rs if r["height_in"]]
                cls = {r["season"]: r["class"] for r in rs}
                first = rs[0]
                home = next((r["hometown"] for r in rs if r["hometown"]), "")
                prev = next((r["previous_school"] for r in rs if r["previous_school"]), "")
                o = origin(prev, first["class"])
                if o == "college" or first["class"] in LATER and first["season"] > first_archived:
                    intake = "transfer" if o != "unknown" or first["class"] in LATER else "unknown"
                elif o == "hs" or (o == "unknown" and first["class"] in ("FR", "RFR")):
                    intake = "hs"
                else:
                    intake = "unknown"
                # the arrival class: a left-censored player (first seen in the first archived season) is dated by his class age
                arrival = first["season"] - (CLASS_AGE.get(first["class"], 0) if first["season"] == first_archived else (1 if first["class"] == "RFR" else 0))
                if first["season"] == first_archived and first["class"] not in ("FR", "RFR") and intake == "hs":
                    intake = "hs_censored"          # arrived before our archive starts: counts for the room, not as a dated signee
                u = uil(prev, home)
                out.append({"name": rs[-1]["name"], "seasons": [r["season"] for r in rs], "cls": cls, "arrival": arrival, "intake": intake,
                            "height_in": int(statistics.median(hts)) if hts else None, "texas": is_texas(home), "dfw": is_dfw(home),
                            "uil": u["conference"] if u else None, "hometown": home, "previous_school": prev})
            self.careers[college] = out

    def division(self, college):
        return (self.cols.get(college) or {}).get("metadata", {}).get("division", "")


# ----------------------------------------------------------------------------- features
def priors(data: Data, Y: int) -> dict:
    """Division priors from classes before Y: Texas share of QB rooms and share of HS signees <= LOOKALIKE_MAX (+1 for SZ)."""
    tx, room, short, n = Counter(), Counter(), Counter(), Counter()
    for college, cs in data.careers.items():
        d = data.division(college)
        for c in cs:
            if Y - 1 in c["seasons"]:
                room[d] += 1; tx[d] += c["texas"]
            if c["intake"] == "hs" and Y - WINDOW <= c["arrival"] < Y and c["height_in"]:
                n[d] += 1; short[d] += c["height_in"] <= LOOKALIKE_MAX
    return {d: {"tx": tx[d] / room[d] if room[d] else 0.5, "short": short[d] / n[d] if n[d] else 0.5} for d in set(room) | set(n)}


def features(data: Data, college: str, Y: int, pr: dict, h: int = 72, decay: bool = True) -> dict | None:
    """Features for predicting class Y from seasons < Y. None when the program has no roster for Y-1."""
    prev = Y - 1
    fpv = data.fp.get((college, prev))
    if not fpv or fpv[0] < 15:
        return None
    d = data.division(college); p = pr.get(d) or {"tx": 0.5, "short": 0.5}
    tot, tx, dfw = fpv
    P = 0.7 * min(1, (tx / tot) / 0.5) + 0.3 * min(1, (dfw / tot) / 0.15)
    cs = data.careers.get(college, [])
    room = [c for c in cs if prev in c["seasons"]]
    Q = min(1, ((sum(c["texas"] for c in room) + 3 * p["tx"]) / (len(room) + 3)) / 0.5)
    w = lambda c: (0.5 ** ((prev - c["arrival"]) / HALF_LIFE)) if decay else (1.0 if c["arrival"] >= Y - 2 else 0.0)
    signees = [c for c in cs if c["intake"] == "hs" and Y - WINDOW <= c["arrival"] < Y and w(c) > 0]
    look = [c for c in signees if c["texas"] and c["height_in"] and c["height_in"] <= LOOKALIKE_MAX]
    partial = [c for c in signees if (c["height_in"] and c["height_in"] <= LOOKALIKE_MAX) or c["texas"]]
    C = max(min(1, sum(w(c) for c in look)), 0.6 * min(1, sum(w(c) for c in partial)))
    if any(c["uil"] == "6A" or c["dfw"] for c in look):
        C = min(1.0, C + 0.2)
    hs2 = sum(1 for c in cs if c["intake"] == "hs" and Y - 2 <= c["arrival"] < Y)
    xfer2 = sum(1 for c in cs if c["intake"] == "transfer" and Y - 2 <= c["arrival"] < Y)
    leaving = sum(1 for c in room if c["cls"].get(prev) in LEAVING)
    E = max(hs2 / 2, leaving * (hs2 + 1) / (hs2 + xfer2 + 2))
    N = 1 - math.exp(-E)
    sized = [c for c in signees if c["height_in"]]
    k = sum(w(c) * (c["height_in"] <= h + 1) for c in sized); n = sum(w(c) for c in sized)
    SZ = min(100.0, 100 * ((k + PRIOR_N * p["short"]) / (n + PRIOR_N)) / 0.70)
    return {"P": P, "Q": Q, "C": C, "N": N, "E": E, "SZ": SZ, "tot": tot, "tx": tx, "dfw": dfw, "room": len(room), "hs2": hs2, "xfer2": xfer2,
            "leaving": leaving, "look": look, "signee_heights": sorted(c["height_in"] for c in sized), "div": d}


def pathway(f: dict, W=W_DESIGN) -> float:
    return 100 * (W[0] * f["P"] + W[1] * f["Q"] + W[2] * f["C"] + W[3] * f["N"])


def label(data: Data, college: str, Y: int) -> int | None:
    """Did class Y bring in a Texas HS QB no taller than LOOKALIKE_MAX? None when season Y is not archived for the program."""
    if Y not in data.seasons.get(college, ()):
        return None
    return int(any(c["intake"] == "hs" and c["arrival"] == Y and c["texas"] and c["height_in"] and c["height_in"] <= LOOKALIKE_MAX
                   for c in data.careers.get(college, [])))


# ----------------------------------------------------------------------------- backtest
def auc(pairs):
    pos = [s for s, y in pairs if y]; neg = [s for s, y in pairs if not y]
    if not pos or not neg:
        return None
    pos.sort(); neg.sort()
    # rank-based (Mann-Whitney) to stay fast on ~6k rows
    allv = sorted([(s, 1) for s in pos] + [(s, 0) for s in neg])
    ranks, i = {}, 0
    rank_sum = 0.0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]:
            j += 1
        r = (i + j) / 2 + 1
        rank_sum += r * sum(1 for t in allv[i:j + 1] if t[1])
        i = j + 1
    return round((rank_sum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)), 3)


def backtest(data: Data, years=range(2016, 2026)):
    rows = []
    for Y in years:
        pr = priors(data, Y)
        for college in data.careers:
            y = label(data, college, Y)
            if y is None:
                continue
            f = features(data, college, Y, pr)
            if not f:
                continue
            f0 = features(data, college, Y, pr, decay=False)
            st = (data.cols.get(college) or {}).get("metadata", {}).get("state")
            rows.append({"Y": Y, "college": college, "y": y, "tx": st == "TX", "f": f, "f0": f0})
    out = {"programs_x_seasons": len(rows), "positives": sum(r["y"] for r in rows), "by_season": {}}
    W_GRID = [w for w in itertools.product([.4, .5, .6, .7], [0, .1, .15, .2], [0, .1, .15, .2, .3], [0, .05, .1, .15]) if abs(sum(w) - 1) < 1e-9]

    def score_set(rs, key):
        return auc([(key(r), r["y"]) for r in rs])

    for Y in years:
        rs = [r for r in rows if r["Y"] == Y]
        if not rs:
            continue
        rest = [r for r in rows if r["Y"] != Y]
        best = max(W_GRID, key=lambda W: score_set(rest, lambda r, W=W: pathway(r["f"], W)) or 0)
        top25 = sorted(rs, key=lambda r: -pathway(r["f"]))[:25]
        out["by_season"][Y] = {"programs": len(rs), "positives": sum(r["y"] for r in rs),
                               "pathway_design": score_set(rs, lambda r: pathway(r["f"])),
                               "pathway_no_decay": score_set(rs, lambda r: pathway(r["f0"])),
                               "pathway_loso_weights": score_set(rs, lambda r, W=best: pathway(r["f"], W)), "loso_weights": best,
                               "P_only": score_set(rs, lambda r: r["f"]["P"]), "texas_school": score_set(rs, lambda r: int(r["tx"])),
                               "hits_top25": sum(r["y"] for r in top25),
                               "outside_texas": score_set([r for r in rs if not r["tx"]], lambda r: pathway(r["f"])),
                               "inside_texas": score_set([r for r in rs if r["tx"]], lambda r: pathway(r["f"]))}
    allp = lambda key: score_set(rows, key)
    out["pooled"] = {"pathway_design": allp(lambda r: pathway(r["f"])), "pathway_no_decay": allp(lambda r: pathway(r["f0"])),
                     "P_only": allp(lambda r: r["f"]["P"]), "texas_school": allp(lambda r: int(r["tx"])),
                     "outside_texas": score_set([r for r in rows if not r["tx"]], lambda r: pathway(r["f"])),
                     "inside_texas": score_set([r for r in rows if r["tx"]], lambda r: pathway(r["f"]))}
    vals = [v["pathway_loso_weights"] for v in out["by_season"].values() if v["pathway_loso_weights"]]
    out["loso_mean_auc"] = round(statistics.mean(vals), 3) if vals else None
    out["design_mean_auc"] = round(statistics.mean(v["pathway_design"] for v in out["by_season"].values() if v["pathway_design"]), 3)
    out["loso_weight_votes"] = Counter(str(v["loso_weights"]) for v in out["by_season"].values()).most_common(3)
    return out


# ----------------------------------------------------------------------------- player fit
def eff(C, Att, Y, TD, I):
    return (8.4 * Y + 330 * TD + 100 * C - 200 * I) / Att


def Phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


class PlayerFit:
    def __init__(self, athlete: dict):
        st0 = (athlete.get("stats") or [{}])[0]
        pa, ru = st0.get("passing") or {}, st0.get("rushing") or {}
        gp = st0.get("gp") or 1
        self.h = (athlete.get("heightInches") or (athlete.get("listed") or {}).get("heightInches") or 72)
        self.h_confirmed = bool(athlete.get("heightInches"))
        self.rypg = (ru.get("Yds") or 0) / gp
        a_eff = eff(pa["C"], pa["Att"], pa["Yds"], pa["TD"], pa["Int"]) if pa.get("Att") else None
        self.scheme = {r["school"]: r for r in json.load(open(RECRUIT / "data" / "match_inputs" / "scheme_ncaa_2026.json", encoding="utf-8"))}
        comps = json.load(open(RECRUIT / "data" / "match_inputs" / "hs_comps_maxpreps.json", encoding="utf-8"))
        for c in comps:
            use = [r for r in c["rows"] if (r.get("grade") or "")[:2] in ("Sr", "Jr") and (r.get("passing") or {}).get("Att")]
            if use:
                s = lambda k: sum(r["passing"][k] for r in use)
                g = sum(r.get("gp") or 0 for r in use)
                ry = sum(((r.get("rushing") or {}).get("Yds") or 0) for r in use if isinstance(r.get("rushing"), dict))
                c["f"] = {"att": s("Att"), "eff": eff(s("C"), s("Att"), s("Yds"), s("TD"), s("Int")), "rypg": ry / g if g else None}
        self.comps = [c for c in comps if c.get("f") and c["f"]["att"] >= 50]
        effs = [c["f"]["eff"] for c in self.comps]
        self.pool_med, self.pool_sd, pool_mean = statistics.median(effs), statistics.pstdev(effs), statistics.mean(effs)
        self.a_eff = (pa["Att"] * a_eff + 150 * pool_mean) / (pa["Att"] + 150) if a_eff else None   # shrink a 5-game sample

    def __call__(self, college: str, SZ: float) -> dict:
        parts = {"SZ": (SZ, 0.5)}
        sc = self.scheme.get(college) or {}
        car = (sc.get("starter") or {}).get("rushPerG")
        own = [c for c in self.comps if c["college"] == college]
        st_vals = []
        if car is not None:
            st_vals.append(100 if car <= 10 else 70 if car <= 12 else 40 if car <= 15 else 10)
        if own and all(c["f"]["rypg"] is not None for c in own):
            st_vals.append(100 * math.exp(-max(0, statistics.median(c["f"]["rypg"] for c in own) - self.rypg) / 40))
        if st_vals:
            parts["ST"] = (sum(st_vals) / len(st_vals), 0.3)
        if own and self.a_eff:
            w = len(own) / (len(own) + 3)
            m_eff = w * statistics.median(c["f"]["eff"] for c in own) + (1 - w) * self.pool_med
            parts["PR"] = (100 * Phi((self.a_eff - m_eff) / self.pool_sd), 0.2)
        pf = sum(v * w for v, w in parts.values()) / sum(w for _, w in parts.values())
        run_first = (sc.get("passRate") is not None and sc["passRate"] < 0.30) or (car is not None and car > 15)
        return {"PF": pf, "parts": {k: round(v[0]) for k, v in parts.items()}, "checks": len(parts), "passRate": sc.get("passRate"),
                "starterCarG": car, "run_first": run_first, "own_comps": len(own)}


# ----------------------------------------------------------------------------- board
ORDER = ["Reach", "Target", "Likely"]


def tier(div, C, SZ, N, closed, engaged, cls):
    if closed:
        return f"Closed {cls}"
    if div == "JUCO":
        return "Fallback"
    t = "Reach" if div == "FBS" else ("Target" if C >= 1 else "Reach") if div == "FCS" else \
        ("Likely" if C >= 1 and SZ >= 60 and N >= 0.6 else "Target")
    return ORDER[min(2, ORDER.index(t) + 1)] if engaged and t in ORDER else t


def reasons(college, f, pf, ft, cls):
    sh = f["signee_heights"]
    ft = lambda h: f"{h // 12}'{h % 12}\""
    hts = (f"{sum(h <= LOOKALIKE_MAX for h in sh)} of {len(sh)} at {HT} or shorter (range {ft(sh[0])} to {ft(sh[-1])}, median {ft(int(statistics.median(sh)))})"
           if sh else "none on record")
    r = [f"{f['tx']} of {f['tot']} players on the 2026 roster are from Texas, {f['dfw']} from DFW."]
    if f["look"]:
        r.append(f"Signed {len(f['look'])} Texas high-school QB(s) {HT} or shorter in the last {WINDOW} classes"
                 + (" (incl. a UIL 6A or DFW school)." if any(c['uil'] == '6A' or c['dfw'] for c in f['look']) else "."))
    else:
        r.append(f"No Texas high-school QB {HT} or shorter in the last {WINDOW} classes.")
    r.append(f"High-school QB signees in the last {WINDOW} classes: {hts}.")
    if pf.get("starterCarG") is not None:
        r.append(f"Starter carries about {pf['starterCarG']:.0f} times a game; team passes on {round(100 * (pf['passRate'] or 0))}% of plays.")
    r.append(f"Projected {cls} departures {f['leaving']}; HS QBs signed in the last 2 classes {f['hs2']}, transfers {f['xfer2']} (projected, commits not known).")
    return r


def score_board(data: Data, athlete_id: str, write: bool):
    db = data.db
    ath = db.athletes.find_one({"id": athlete_id}, {"_id": 0})
    fit = PlayerFit(ath)
    Y = int((ath or {}).get("gradYear") or datetime.now(timezone.utc).year + 1)
    pr = priors(data, Y)
    replied = {t["school"]: (t.get("note") or t.get("channel") or "") for t in db.touches.find({"direction": "in"})}
    emailed = {t["school"] for t in db.touches.find({"direction": "out"})}
    rows = []
    for college, c in data.cols.items():
        if (c.get("rosterProfile") or {}).get("scrapeStatus") != "ok":
            continue
        f = features(data, college, Y, pr, h=fit.h)
        if not f or not f["room"]:
            continue
        pth = pathway(f)
        pf = fit(college, f["SZ"])
        m = pth * (0.6 + 0.4 * pf["PF"] / 100)
        at = {hh: pth * (0.6 + 0.4 * fit(college, features(data, college, Y, pr, h=hh)["SZ"])["PF"] / 100) for hh in (fit.h - 1, fit.h + 1)}
        closed = bool(re.search(r"commit", replied.get(college, ""), re.I))
        engaged = college in replied and not closed
        t = tier(f["div"], f["C"], f["SZ"], f["N"], closed, engaged, Y)
        conf = "High" if pf["checks"] == 3 or (pf["checks"] == 2 and len(f["signee_heights"]) >= 5) else "Medium" if pf["checks"] == 2 or len(f["signee_heights"]) >= 3 else "Low"
        rows.append({"athleteId": athlete_id, "school": college, "division": f["div"], "state": c["metadata"].get("state"),
                     "match": round(m, 1), "pathway": round(pth, 1), "playerFit": round(pf["PF"], 1), "tier": t,
                     "hold": "run-first offense" if pf["run_first"] else (f"closed for {Y}" if closed else None),
                     "confidence": conf, "checks": pf["checks"], "parts": pf["parts"],
                     "inputs": {k: round(f[k], 3) for k in ("P", "Q", "C", "N", "E", "SZ")} | {"tot": f["tot"], "tx": f["tx"], "dfw": f["dfw"], "room": f["room"]},
                     f"at{fit.h - 1}": round(at[fit.h - 1], 1), f"at{fit.h + 1}": round(at[fit.h + 1], 1),
                     "heightSensitive": abs(at[fit.h + 1] - at[fit.h - 1]) >= 10, "heightConfirmed": fit.h_confirmed,
                     "contacted": college in emailed, "engaged": engaged, "reasons": reasons(college, f, pf, t, Y)})
    rows.sort(key=lambda r: -r["match"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    h = hashlib.sha256(json.dumps([(r["school"], r["match"]) for r in rows]).encode()).hexdigest()[:16]
    now = datetime.now(timezone.utc).isoformat()
    for r in rows:
        r.update({"inputsHash": h, "scoredAt": now, "model": "qb_match v1 (pathway x player fit, decayed 4-class window)"})
    if write:
        db.matches.delete_many({"athleteId": athlete_id})
        db.matches.insert_many([dict(r) for r in rows])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backtest", action="store_true"); ap.add_argument("--score", action="store_true"); ap.add_argument("--write", action="store_true")
    ap.add_argument("--school", default=""); ap.add_argument("--athlete", default="quinn-placeholder")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    db = MongoClient("mongodb://localhost:27017")["gridiron"]
    con = sqlite3.connect(RECRUIT / "ledger.db", timeout=180)
    data = Data(db, con)
    if a.backtest:
        bt = backtest(data)
        (RECRUIT / "data" / "match_inputs" / "backtest_rolling.json").write_text(json.dumps(bt, indent=1, default=str), encoding="utf-8")
        print(json.dumps({k: v for k, v in bt.items() if k != "by_season"}, indent=1, default=str))
        for y, v in bt["by_season"].items():
            print(y, {k: v[k] for k in ("programs", "positives", "pathway_design", "pathway_no_decay", "pathway_loso_weights", "P_only", "texas_school", "hits_top25", "inside_texas", "outside_texas")})
    if a.score or a.school:
        rows = score_board(data, a.athlete, a.write)
        print(f"scored {len(rows)} programs; tiers {dict(Counter(r['tier'] for r in rows))}; holds {sum(1 for r in rows if r['hold'])}; written={a.write}")
        sel = [r for r in rows if a.school.lower() in r["school"].lower()] if a.school else rows[:25]
        for r in sel:
            print(f"#{r['rank']:<3} {r['match']:5} path {r['pathway']:5} PF {r['playerFit']:5} {r['division']:4} {r['state']} {r['tier']:7} {r['confidence']:6} "
                  f"{'HOLD ' + r['hold'] if r['hold'] else ''} {r['school']} {r['parts']}")
            if a.school:
                print("   ", r["inputs"]); [print("    -", x) for x in r["reasons"]]


if __name__ == "__main__":
    main()
