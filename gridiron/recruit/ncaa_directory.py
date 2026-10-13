"""NCAA member directory (football sponsors, all divisions) -> ledger schools: official name, division, FBS/FCS, conference,
state, athletics website. Source: https://web3.ncaa.org/directory/api/directory/memberList?type=12&sportCode=MFB (saved
data/ncaa_directory_MFB.json, fetched 2026-10-10). Adds every program the tracker lacked; overwrites athletics_domain."""
import json, re, csv, sqlite3, pathlib, unicodedata, sys
HERE = pathlib.Path(__file__).resolve().parent; D = HERE / "data"
def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower().replace("&", " and ")
    s = re.sub(r"\(.*?\)", " ", s); s = re.sub(r"[^a-z0-9 ]", " ", s); return re.sub(r"\s+", " ", s).strip()
def variants(name):
    v = {norm(name)}
    while True:
        n = len(v)
        for a, b in ((r"^the ", ""), (r"^university of ", ""), (r" university$", ""), (r" university", ""), (r"^college of ", ""), (r" college$", ""),
                     (r",.*$", ""), (r" at ", " "), (r" main campus$", ""), (r"state university", "state"), (r"^saint ", "st "), (r"^st ", "saint "),
                     (r"institute of technology", "tech"), (r"polytechnic institute and state", "tech"), (r" and a and m college$", "")):
            v |= {re.sub(a, b, x).strip() for x in list(v)}
        if len(v) == n: return {x for x in v if x}
ALIAS = {"University of Texas": "The University of Texas at Austin", "Texas A&M University": "Texas A&M University, College Station",
         "University of Miami": "University of Miami (Florida)", "Army West Point": "U.S. Military Academy", "Brigham Young University": "Brigham Young University",
         "University of Louisiana at Lafayette": "University of Louisiana at Lafayette", "University of Louisiana at Monroe": "University of Louisiana Monroe",
         "University of St. Thomas": "University of St. Thomas (Minnesota)", "Missouri S&T": "Missouri University of Science and Technology",
         "University of California, San Diego": "University of San Diego", "Penn State University": "Pennsylvania State University",
         "Fresno State": "California State University, Fresno", "University of Hawaiʻi at Mānoa": "University of Hawaii, Manoa",
         "University of Nevada, Reno": "University of Nevada, Reno", "Virginia Polytechnic Institute and State University": "Virginia Polytechnic Institute and State University",
         "Lindenwood University": "Lindenwood University", "Sioux Falls University": "University of Sioux Falls", "South Dakota Mines": "South Dakota School of Mines and Technology"}
members = json.load(open(D / "ncaa_directory_MFB.json", encoding="utf-8"))
rows = []
for m in members:
    if m.get("deactive") == "Y": continue
    div = m.get("division"); sub = m.get("subdivision")
    subdivision = {1: "FBS", 2: "FCS"}.get(sub, {1: "", 2: "D2", 3: "D3"}.get(div, ""))
    if div == 1 and not subdivision: subdivision = "FCS"
    rows.append({"orgId": m["orgId"], "name": (m.get("nameOfficial") or "").strip(), "division": f"D{div}", "subdivision": subdivision,
                 "conference": (m.get("conferenceName") or "").strip(), "state": ((m.get("memberOrgAddress") or {}).get("state") or "").strip(),
                 "athleticWebUrl": (m.get("athleticWebUrl") or "").strip(), "webSiteUrl": (m.get("webSiteUrl") or "").strip(),
                 "reclass": f"{m.get('reclassYear') or ''}/{m.get('reclassDivision') or ''}/{m.get('reclassSubdivision') or ''}".strip("/")})
with open(D / "ncaa_directory.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
from collections import Counter
print("NCAA football members (active):", len(rows), dict(Counter(r["division"] for r in rows)), dict(Counter(r["subdivision"] for r in rows)))
print(" with athleticWebUrl:", sum(1 for r in rows if r["athleticWebUrl"]), "| Texas:", sum(1 for r in rows if r["state"] == "TX"))
idx = {}
for r in rows:
    for v in variants(r["name"]): idx.setdefault(v, []).append(r)
con = sqlite3.connect(HERE / "ledger.db", timeout=180)
con.execute("ALTER TABLE schools ADD COLUMN ncaa_org_id INTEGER") if "ncaa_org_id" not in [c[1] for c in con.execute("PRAGMA table_info(schools)")] else None
matched = unmatched = added = 0; amb = []
for sid, name, div in con.execute("SELECT id, name, division FROM schools").fetchall():
    cands = []
    if name in ALIAS: cands = [r for r in rows if r["name"] == ALIAS[name]] or [r for r in rows if norm(r["name"]) == norm(ALIAS[name])]
    if not cands:
        for v in sorted(variants(name), key=len, reverse=True):
            if v in idx: cands = idx[v]; break
    cands = [c for c in cands if (div == "D2") == (c["division"] == "D2")] or cands
    uniq = {c["orgId"]: c for c in cands}.values()
    if len(uniq) == 1:
        c = next(iter(uniq)); matched += 1
        con.execute("UPDATE schools SET ncaa_org_id=?, athletics_domain=?, conference=COALESCE(NULLIF(?, ''), conference), state=COALESCE(NULLIF(?, ''), state), subdivision=COALESCE(NULLIF(?, ''), subdivision), division=? WHERE id=?",
                    (c["orgId"], ("https://" + c["athleticWebUrl"]) if c["athleticWebUrl"] and not c["athleticWebUrl"].startswith("http") else c["athleticWebUrl"], c["conference"], c["state"], c["subdivision"], c["division"], sid))
    elif len(uniq) > 1: amb.append((name, [c["name"] for c in uniq])); unmatched += 1
    else: unmatched += 1; print("  unmatched:", div, "|", name)
have = {r[0] for r in con.execute("SELECT ncaa_org_id FROM schools WHERE ncaa_org_id IS NOT NULL")}
for r in rows:
    if r["orgId"] in have: continue
    url = r["athleticWebUrl"]; url = ("https://" + url) if url and not url.startswith("http") else url
    con.execute("INSERT OR IGNORE INTO schools(division,subdivision,name,state,conference,athletics_domain,is_texas,ncaa_org_id,status) VALUES(?,?,?,?,?,?,?,?,?)",
                (r["division"], r["subdivision"], r["name"], r["state"], r["conference"], url, 1 if r["state"] == "TX" else 0, r["orgId"], "open"))
    added += con.total_changes and 1
con.commit()
print(f"ledger: matched={matched} unmatched={unmatched} ambiguous={len(amb)} added_new_programs={added}")
for a in amb[:10]: print("  AMBIGUOUS", a)
print("schools now:", con.execute("SELECT division, COUNT(*), SUM(athletics_domain IS NOT NULL AND athletics_domain<>''), SUM(is_texas) FROM schools GROUP BY division").fetchall())
print("Texas programs with site:", con.execute("SELECT name, subdivision, athletics_domain FROM schools WHERE is_texas=1 AND athletics_domain<>'' ORDER BY subdivision, name").fetchall())
