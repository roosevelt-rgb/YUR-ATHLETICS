"""Map ledger schools -> NCAA program reference (FBS/FCS/D2, state, conference) from the Wikipedia lists.
Writes data/programs.csv and prints unmatched schools for manual aliasing."""
import json, re, csv, sqlite3, unicodedata, pathlib
HERE = pathlib.Path(__file__).resolve().parent; D = HERE / "data"
def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ").replace("–", "-").replace("—", "-")
    s = re.sub(r"\[.*?\]|\(.*?\)", " ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()
def variants(name):
    n = norm(name); v = {n}
    while True:
      before = len(v)
      for a, b in ((r"^university of ", ""), (r"^the ", ""), (r" university$", ""), (r"^college of ", ""), (r" college$", ""),
                 (r" university", ""), (r" at ", " "), (r"institute of technology", "tech"), (r"polytechnic institute and state university", "tech"),
                 (r"polytechnic state university", "poly"), (r" and a and m college$", ""), (r"^saint ", "st "), (r"^st ", "saint ")):
        v |= {re.sub(a, b, x).strip() for x in list(v)}
      if len(v) == before: break
    return {x for x in v if x}
ALIAS = {  # tracker name -> wiki name (FBS short names / FCS full names) for the cases normalization cannot bridge
 "Army West Point": "Army", "Brigham Young University": "BYU", "Southern Methodist University": "SMU", "Texas Christian University": "TCU",
 "University of Texas at El Paso": "UTEP", "University of Texas at San Antonio": "UTSA", "University of Central Florida": "UCF",
 "University of Southern California": "USC", "University of California, Los Angeles": "UCLA", "University of California, Berkeley": "California",
 "University of Nevada, Las Vegas": "UNLV", "University of Nevada, Reno": "Nevada", "University of Massachusetts Amherst": "UMass",
 "Florida International University": "FIU", "University of Miami": "Miami (FL)", "University of Mississippi": "Ole Miss",
 "University of Southern Mississippi": "Southern Miss", "Middle Tennessee State University": "Middle Tennessee",
 "University of Louisiana at Lafayette": "Louisiana", "University of Louisiana at Monroe": "ULM", "Saint Francis University": "Saint Francis (PA)", "Bethune-Cookman University": "Bethune–Cookman University", "University at Buffalo": "Buffalo", "Bowling Green State University": "Bowling Green",
 "University of North Carolina at Chapel Hill": "North Carolina", "University of North Carolina at Charlotte": "Charlotte",
 "University of Illinois Urbana-Champaign": "Illinois", "University of Hawaiʻi at Mānoa": "Hawaii", "Sam Houston State University": "Sam Houston",
 "University of Maryland, College Park": "Maryland", "Indiana University Bloomington": "Indiana", "University of Wisconsin-Madison": "Wisconsin",
 "University of Colorado Boulder": "Colorado", "University of Nebraska-Lincoln": "Nebraska", "Penn State University": "Penn State",
 "Georgia Institute of Technology": "Georgia Tech", "Virginia Polytechnic Institute and State University": "Virginia Tech",
 "California Polytechnic State University": "Cal Poly", "College of the Holy Cross": "Holy Cross", "Virginia Military Institute": "VMI",
 "University of St. Thomas": "St. Thomas", "University of California, San Diego": "San Diego", "University of San Diego": "San Diego",
 "Southern University and A&M College": "Southern", "University at Albany": "Albany", "Long Island University": "Long Island",
 "Missouri S&T": "Missouri University of Science and Technology", "University of Oklahoma at Tulsa": None, "University of South Florida St. Petersburg": None,
 "Sioux Falls University": "University of Sioux Falls", "Thomas Jefferson University": "Thomas Jefferson", "Nyack College": None,
 "Notre Dame College": None, "Lincoln University": "Lincoln University (Missouri)", "University of Mary": "University of Mary",
}
raw = json.load(open(D / "ncaa_programs_raw.json", encoding="utf-8"))
ref = []
for r in raw:
    sub = r["_sub"]
    if sub == "D2" and ("Current level" in r or "Last Division II season" in r): continue  # former-D2 table
    name = r.get("School") or r.get("Team"); short = r.get("Team") or r.get("School")
    state = r.get("State [ a ]") or r.get("State/ province") or ""
    conf = r.get("Current conference [ b ]") or r.get("Conference [ b ]") or r.get("Conference") or ""
    ref.append({"wiki": name, "short": short, "sub": sub, "state": state, "conf": conf})
index = {}
for p in ref:
    for v in variants(p["wiki"]) | variants(p["short"]):
        index.setdefault(v, []).append(p)
con = sqlite3.connect(HERE / "ledger.db")
schools = con.execute("SELECT id, name, division FROM schools ORDER BY division, name").fetchall()
rows, unmatched, amb = [], [], []
for sid, name, div in schools:
    cands = []
    if name in ALIAS:
        a = ALIAS[name]
        if a is None: rows.append((sid, name, div, "", "", "", "excluded", "")); continue
        cands = [p for p in ref if p["wiki"] == a or p["short"] == a] or [p for p in ref if norm(p["wiki"]) == norm(a) or norm(p["short"]) == norm(a)]
    if not cands:
        for v in variants(name):
            if v in index: cands = index[v]; break
    # a D1 tracker school should not match a D2 ref and vice versa; prefer same division
    want = {"D1": ("FBS", "FCS"), "D2": ("D2",)}[div]
    cands = [c for c in cands if c["sub"] in want] or cands
    uniq = {(c["wiki"], c["sub"]): c for c in cands}.values(); uniq = list(uniq)
    if len(uniq) == 1:
        c = uniq[0]; rows.append((sid, name, div, c["sub"], c["state"], c["conf"], "matched", c["wiki"]))
    elif len(uniq) > 1:
        amb.append((name, [(c["wiki"], c["sub"]) for c in uniq])); c = uniq[0]
        rows.append((sid, name, div, c["sub"], c["state"], c["conf"], "ambiguous", c["wiki"]))
    else:
        unmatched.append((div, name)); rows.append((sid, name, div, "", "", "", "unmatched", ""))
with open(D / "programs.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["school_id", "school", "division", "subdivision", "state", "conference", "match", "wiki_name"]); w.writerows(rows)
# write back to ledger
for sid, name, div, sub, state, conf, m, wk in rows:
    if m in ("matched", "ambiguous"):
        con.execute("UPDATE schools SET subdivision=?, state=?, conference=? WHERE id=?", (sub, state, conf, sid))
con.commit()
from collections import Counter
print("match:", Counter(r[6] for r in rows)); print("subdivision:", Counter(r[3] for r in rows if r[3]))
print("\nUNMATCHED (%d):" % len(unmatched)); [print("  ", d, "|", n) for d, n in unmatched]
print("\nAMBIGUOUS (%d):" % len(amb)); [print("  ", n, "->", c) for n, c in amb]
# programs in the reference that the tracker lacks (FBS + FCS, and Texas D2)
have = {r[7] for r in rows if r[7]}
missing_fbs = [p for p in ref if p["sub"] == "FBS" and p["wiki"] not in have]
missing_fcs = [p for p in ref if p["sub"] == "FCS" and p["wiki"] not in have]
missing_d2_tx = [p for p in ref if p["sub"] == "D2" and p["wiki"] not in have and p["state"] in ("Texas", "TX")]
print("\nFBS programs NOT in tracker (%d): %s" % (len(missing_fbs), ", ".join(p["wiki"] for p in missing_fbs)))
print("\nFCS programs NOT in tracker (%d): %s" % (len(missing_fcs), ", ".join(p["wiki"] for p in missing_fcs)))
print("\nTexas D2 programs NOT in tracker (%d): %s" % (len(missing_d2_tx), ", ".join(p["wiki"] for p in missing_d2_tx)))
print("\nTexas programs in reference:", [(p["wiki"], p["sub"]) for p in ref if p["state"] in ("Texas", "TX")])
