"""One-off after ncaa_directory.py: merge tracker rows that NCAA lists under longer official names, dedupe schools sharing an
NCAA org id, scrub junk athletics_domain values, mark tracker D2 rows with no NCAA football program as no_football."""
import re, csv, sqlite3, pathlib, unicodedata
HERE = pathlib.Path(__file__).resolve().parent
con = sqlite3.connect(HERE / "ledger.db", timeout=180)
ncaa = list(csv.DictReader(open(HERE / "data" / "ncaa_directory.csv", encoding="utf-8")))
def norm(s): return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", unicodedata.normalize("NFKD", s or "").encode("ascii","ignore").decode().lower().replace("&"," and "))).strip()
PAIRS = {  # tracker name -> regex on NCAA official name
 "University of Arkansas": r"^university of arkansas fayetteville", "University at Buffalo": r"^university at buffalo", "Columbia University": r"^columbia university",
 "University of Missouri": r"^university of missouri columbia", "Montana State University": r"^montana state university(-| )bozeman|^montana state university$",
 "Rutgers University": r"^rutgers", "University of South Carolina": r"^university of south carolina columbia", "Southern University and A&M College": r"^southern university",
 "University of Tennessee": r"^university of tennessee knoxville", "University of Texas": r"texas at austin", "University of California, San Diego": None, "University of San Diego": r"^university of san diego",
}
def merge(keep_id, drop_id):
    con.execute("UPDATE OR IGNORE contacts SET school_id=? WHERE school_id=?", (keep_id, drop_id))
    con.execute("DELETE FROM contacts WHERE school_id=?", (drop_id,))  # leftovers were exact duplicates of rows already on keep_id
    con.execute("UPDATE touches SET school_id=? WHERE school_id=?", (keep_id, drop_id))
    for t in ("players", "staff_scrape", "program_needs", "program_scrapes"):
        try: con.execute(f"UPDATE {t} SET school_id=? WHERE school_id=?", (keep_id, drop_id))
        except sqlite3.OperationalError: pass
    con.execute("DELETE FROM schools WHERE id=?", (drop_id,))
merged = 0
for tname, rx in PAIRS.items():
    row = con.execute("SELECT id, ncaa_org_id FROM schools WHERE name=?", (tname,)).fetchone()
    if not row or row[1] is not None or rx is None: continue
    cands = [r for r in ncaa if re.search(rx, norm(r["name"]), re.I)]
    if len(cands) != 1: print("  skip", tname, [c["name"] for c in cands]); continue
    c = cands[0]; added = con.execute("SELECT id FROM schools WHERE ncaa_org_id=?", (int(c["orgId"]),)).fetchone()
    url = c["athleticWebUrl"]; url = ("https://" + url) if url and not url.startswith("http") else url
    con.execute("UPDATE schools SET ncaa_org_id=?, athletics_domain=?, conference=?, state=?, subdivision=?, division=?, is_texas=? WHERE id=?",
                (int(c["orgId"]), url, c["conference"], c["state"], c["subdivision"], c["division"], 1 if c["state"] == "TX" else 0, row[0]))
    if added and added[0] != row[0]: merge(row[0], added[0]); merged += 1
    print(f"  merged {tname!r} <- NCAA {c['name']!r} ({c['subdivision']}, {url})")
# UC San Diego row in the tracker actually carried University of San Diego emails -> fold it into University of San Diego
ucsd = con.execute("SELECT id FROM schools WHERE name='University of California, San Diego'").fetchone()
usd = con.execute("SELECT id FROM schools WHERE name='University of San Diego'").fetchone()
if ucsd and usd and ucsd[0] != usd[0]: merge(usd[0], ucsd[0]); merged += 1; print("  folded 'University of California, San Diego' into 'University of San Diego'")
# generic dedupe: same NCAA org id on two rows -> keep the one with more contacts
for (org,) in con.execute("SELECT ncaa_org_id FROM schools WHERE ncaa_org_id IS NOT NULL GROUP BY ncaa_org_id HAVING COUNT(*)>1").fetchall():
    ids = con.execute("SELECT s.id, s.name, (SELECT COUNT(*) FROM contacts c WHERE c.school_id=s.id) n FROM schools s WHERE ncaa_org_id=? ORDER BY n DESC, id", (org,)).fetchall()
    for d in ids[1:]: merge(ids[0][0], d[0]); merged += 1; print(f"  dedupe org {org}: kept {ids[0][1]!r}, merged {d[1]!r}")
# scrub junk domains written by the abandoned Wikipedia resolver
bad = con.execute("SELECT id, name, athletics_domain FROM schools WHERE athletics_domain LIKE '%|%' OR athletics_domain LIKE '%archive.org%' OR athletics_domain LIKE '%}%' OR athletics_domain LIKE '%stats.ncaa.org%' OR athletics_domain LIKE '%wikipedia%'").fetchall()
for sid, name, dom in bad: con.execute("UPDATE schools SET athletics_domain=NULL WHERE id=?", (sid,)); print("  scrubbed", name, "|", dom[:60])
# tracker schools with no NCAA football program -> no_football (D2 non-football members, FDU, Jacksonville U)
nf = con.execute("UPDATE schools SET status='no_football' WHERE ncaa_org_id IS NULL AND name <> 'Lincoln University'").rowcount
con.commit()
print(f"merged={merged} scrubbed={len(bad)} no_football={nf}")
print("schools by division:", con.execute("SELECT division, subdivision, COUNT(*), SUM(athletics_domain IS NOT NULL AND athletics_domain<>''), SUM(is_texas) FROM schools WHERE status<>'no_football' GROUP BY division, subdivision").fetchall())
print("texas scrape targets:", con.execute("SELECT COUNT(*) FROM schools WHERE is_texas=1 AND athletics_domain<>'' AND status<>'no_football'").fetchone()[0])
print("UT row:", con.execute("SELECT id, name, subdivision, athletics_domain, (SELECT COUNT(*) FROM contacts c WHERE c.school_id=s.id) FROM schools s WHERE name LIKE 'University of Texas%' ORDER BY name").fetchall())
