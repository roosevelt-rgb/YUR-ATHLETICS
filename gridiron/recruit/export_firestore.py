"""ledger.db -> Gridiron Scout seed files (src/data/*.seed.json) for the admin "Import ledger" action.
  coaches.seed.json     one doc per contact (tracker + scrape), Coach schema + ledger extras
  colleges.seed.json    one doc per program: metadata, rosterProfile (needs by position / HS class), footprint, staff summary
  highschools.seed.json one doc per UIL football program (2026-28 alignment)
"""
import sqlite3, json, re, pathlib, datetime, unicodedata
from collections import Counter
HERE = pathlib.Path(__file__).resolve().parent
OUTDIR = pathlib.Path(__file__).resolve().parent.parent / "src" / "data"   # repo: gridiron-scout/src/data
ABBR = {"Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO","Connecticut":"CT","Delaware":"DE","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY","District of Columbia":"DC","British Columbia":"BC"}
REGION = {}
for st in "CT ME MA NH RI VT NY NJ PA DE MD DC".split(): REGION[st] = "Northeast"
for st in "VA WV NC SC GA FL AL MS TN KY".split(): REGION[st] = "Southeast"
for st in "OH MI IN IL WI MN IA MO ND SD NE KS".split(): REGION[st] = "Midwest"
for st in "TX OK NM AZ AR LA".split(): REGION[st] = "Southwest"
for st in "CO UT NV ID MT WY WA OR CA AK HI BC".split(): REGION[st] = "West"
TITLE = {"qb_coach": "Quarterbacks Coach", "recruiting_coordinator": "Recruiting Coordinator", "player_personnel": "Director of Player Personnel",
         "area_recruiter_dfw": "Area Recruiter (DFW)", "oc": "Offensive Coordinator", "head_coach": "Head Coach", "other": "Football Staff"}
TYPICAL_ROOM = {"QB": 5, "RB": 8, "WR": 14, "TE": 7, "OL": 17, "DL": 16, "LB": 12, "DB": 18, "K": 2, "P": 2, "LS": 2, "ATH": 4}

def slug(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s)).strip("-")

def dump(name, payload):
    OUTDIR.mkdir(parents=True, exist_ok=True)
    (OUTDIR / name).write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    print("wrote", OUTDIR / name)

def main():
    con = sqlite3.connect(HERE / "ledger.db", timeout=180); con.row_factory = sqlite3.Row
    today = datetime.date.today().isoformat()
    schools = con.execute("SELECT * FROM schools WHERE status <> 'no_football' ORDER BY name").fetchall()

    # ---------------- coaches ----------------
    docs, seen = [], {}
    for s in schools:
        st = ABBR.get(s["state"] or "", s["state"] or "")
        sub = s["subdivision"] or ("D2" if s["division"] == "D2" else "D3" if s["division"] == "D3" else "FCS")
        last = con.execute("SELECT MAX(at) FROM touches WHERE school_id=? AND direction='out'", (s["id"],)).fetchone()[0]
        n_out = con.execute("SELECT COUNT(*) FROM touches WHERE school_id=? AND direction='out'", (s["id"],)).fetchone()[0]
        scraped_emails = {r[0] for r in con.execute("SELECT email FROM contacts WHERE school_id=? AND source='scrape' AND email<>''", (s["id"],))}
        for c in con.execute("SELECT * FROM contacts WHERE school_id=? ORDER BY CASE source WHEN 'scrape' THEN 0 ELSE 1 END, role", (s["id"],)):
            if not (c["name"] or c["email"]): continue
            if c["source"] == "tracker" and c["email"] and c["email"] in scraped_emails:
                continue  # the scrape re-verified this address; keep the scraped row (has title + source url)
            base = f"{slug(s['name'])}-{c['role']}-{slug(c['name'] or c['email'])[:30]}"; k = seen.get(base, 0) + 1; seen[base] = k
            d = {"id": base if k == 1 else f"{base}-{k}", "name": c["name"] or "(unknown)", "title": c["title"] or TITLE.get(c["role"], "Football Staff"),
                 "college": s["name"], "division": sub, "region": REGION.get(st, "Southwest" if s["is_texas"] else "Southeast"),
                 "role": c["role"], "state": st, "conference": s["conference"] or "", "source": c["source"], "sourceUrl": c["source_url"] or "",
                 "verifiedAt": c["verified_at"] or "", "emailStatus": c["email_status"] or "unknown",
                 "programStatus": "verified" if s["ncaa_org_id"] else "unverified", "lastTouch": last or "", "touches": n_out,
                 "isTexas": bool(s["is_texas"]), "schoolStatus": s["status"] or "open"}
            if c["email"]: d["email"] = c["email"]
            if c["phone"]: d["phone"] = c["phone"]
            if c["twitter"]: d["twitterUrl"] = c["twitter"]
            docs.append(d)
    dump("coaches.seed.json", {"generatedAt": today, "source": "recruit/ledger.db (tracker + NCAA directory + roster/staff scrape)", "coaches": docs})
    print(" coaches:", len(docs), dict(Counter(d["division"] for d in docs)), "| with email:", sum(1 for d in docs if "email" in d), "| scraped:", sum(1 for d in docs if d["source"] == "scrape"))

    # ---------------- colleges (program needs) ----------------
    cols = []
    for s in schools:
        st = ABBR.get(s["state"] or "", s["state"] or "")
        sub = s["subdivision"] or ("D2" if s["division"] == "D2" else "D3" if s["division"] == "D3" else "FCS")
        needs = con.execute("SELECT * FROM program_needs WHERE school_id=? AND season='2026'", (s["id"],)).fetchall()
        fp = con.execute("SELECT * FROM program_footprint WHERE school_id=?", (s["id"],)).fetchone()
        scr = con.execute("SELECT status, url, scraped_at, players, staff FROM program_scrapes WHERE school_id=? ORDER BY id DESC LIMIT 1", (s["id"],)).fetchone()
        by_pos, pos_needs = {}, {}
        for n in needs:
            op = json.loads(n["openings_by_hs_class"]); byc = json.loads(n["by_class"])
            by_pos[n["pos_group"]] = {"count": n["count"], "byClass": byc, "openingsByHsClass": op,
                                      "heightIn": {"min": n["height_min"], "avg": n["height_avg"], "max": n["height_max"]} if n["height_min"] else None,
                                      "weightLb": {"min": n["weight_min"], "avg": n["weight_avg"], "max": n["weight_max"]} if n["weight_min"] else None}
            room = TYPICAL_ROOM.get(n["pos_group"], 6)
            pos_needs[n["pos_group"]] = round(min(1.0, (op.get("2027", 0) / room)), 2)   # feeds MatchmakingEngine.positionalNeeds
        staff_summary = {r["role"]: r["n"] for r in con.execute("SELECT role, COUNT(*) n FROM staff_scrape WHERE school_id=? GROUP BY role", (s["id"],))}
        # commits on file (manual: data/commits.csv) -> net openings per position / HS class
        commits = {}
        try:
            for c in con.execute("SELECT hs_class, pos_group, player, hometown, source_url FROM commits WHERE school_id=?", (s["id"],)):
                commits.setdefault(c["hs_class"], {}).setdefault(c["pos_group"], []).append({"player": c["player"], "hometown": c["hometown"], "sourceUrl": c["source_url"]})
        except sqlite3.OperationalError: pass
        for g, prof in by_pos.items():
            prof["committedByHsClass"] = {y: len(commits.get(y, {}).get(g, [])) for y in prof["openingsByHsClass"]}
            prof["netOpeningsByHsClass"] = {y: max(0, prof["openingsByHsClass"][y] - prof["committedByHsClass"][y]) for y in prof["openingsByHsClass"]}
            prof["commitsKnown"] = {y: (y in commits) for y in prof["openingsByHsClass"]}
        camps = []
        try:
            camps = [{"url": c["url"], "label": c["label"], "dates": c["dates_text"], "scrapedAt": c["scraped_at"]} for c in con.execute("SELECT url, label, dates_text, scraped_at FROM program_camps WHERE school_id=? AND url<>''", (s["id"],))]
        except sqlite3.OperationalError: pass
        cols.append({"id": slug(s["name"]),
                     "metadata": {"name": s["name"], "division": sub, "conference": s["conference"] or "", "region": REGION.get(st, "Southwest" if s["is_texas"] else "Southeast"),
                                  "state": st, "ncaaOrgId": s["ncaa_org_id"], "athleticsUrl": s["athletics_domain"] or ""},
                     "academicThresholds": {"minGpa": 2.5},
                     "positionalNeeds": pos_needs,
                     "rosterProfile": {"season": "2026", "byPosition": by_pos,
                                       "footprint": {"total": fp["total"], "texas": fp["texas"], "dfw": fp["dfw"], "topStates": json.loads(fp["top_states"])} if fp else None,
                                       "staffCounts": staff_summary, "sourceUrl": scr["url"] if scr else "", "scrapedAt": scr["scraped_at"] if scr else "",
                                       "scrapeStatus": scr["status"] if scr else "not_scraped"},
                     "commits": {y: {g: v for g, v in d.items()} for y, d in commits.items()},
                     "camps": camps,
                     # D1 policy context (public rules, not per-school numbers): House settlement rev-share cap, 105-man roster limit, portal window
                     "policy": ({"revShareCapUsd": 21300000, "capSeason": "2026-27",
                                 "capNote": "Settlement-wide ceiling per school (~$21.3M reported for 2026-27, +~4%/yr); each school chooses how much goes to football. No per-school football figure is published.",
                                 "capSource": "https://legionreport.com/house-settlement-explained/", "footballRosterLimit": 105,
                                 "rosterRoom": (105 - fp["total"]) if fp else None,
                                 "portalWindow": "2026-01-02 to 2026-01-16 (single window; +5 days after CFP elimination)",
                                 "portalSource": "https://footballscoop.com/2025/09/17/ncaa-sets-single-transfer-portal-window"}
                                if s["division"] == "D1" else None),
                     "isTexas": bool(s["is_texas"]), "schoolStatus": s["status"] or "open"})
    dump("colleges.seed.json", {"generatedAt": today, "source": "recruit/ledger.db program_needs/program_footprint (roster scrape)", "colleges": cols})
    print(" colleges:", len(cols), "| scraped ok:", sum(1 for c in cols if c["rosterProfile"]["scrapeStatus"] == "ok"), "| with QB needs:", sum(1 for c in cols if "QB" in c["rosterProfile"]["byPosition"]))

    # ---------------- high schools (UIL) ----------------
    hs = []
    for r in con.execute("SELECT * FROM hs_schools WHERE plays_football=1 ORDER BY school"):
        hs.append({"id": "uil-" + slug(r["school"]), "name": r["school"], "state": "TX", "league": "UIL", "conference": r["conference"], "enrollment": r["enrollment"],
                   "footballDistrict": r["football_district"], "division": r["fb_div"] or "", "footballType": r["fb_type"], "region": r["region"],
                   "isDfw": bool(r["is_dfw"]), "cycle": r["cycle"], "source": "UIL Alpha_26-28.pdf"})
    dump("highschools.seed.json", {"generatedAt": today, "source": "UIL 2026-28 realignment (uil_alignment.py)", "highschools": hs})
    print(" highschools:", len(hs), "| DFW:", sum(1 for h in hs if h["isDfw"]), "| 6A:", sum(1 for h in hs if h["conference"] == "6A"))

if __name__ == "__main__":
    main()
