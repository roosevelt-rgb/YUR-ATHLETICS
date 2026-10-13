"""Commits (so openings are net of players already pledged) and camps (prospect / QB camp links + dates) per program.

commits: data/commits.csv  columns: school, hs_class, pos, player, hometown, source_url, note
   -> table commits. Verbal commits for a future class are only published by recruiting services (247Sports / Rivals / On3),
      whose terms forbid scraping, so this file is maintained by hand from those pages (or the program's own announcements).
      netOpenings = max(0, projected openings - commits on file). "unknown" when nothing is on file for that program/class.

camps:   python commits_and_camps.py --camps [--texas] [--force]
   -> fetches each program's football landing page (cached), collects links whose text/href says camp/clinic/prospect day,
      opens up to 2 of them, extracts date strings; stores table program_camps.
"""
import argparse, csv, re, sqlite3, pathlib, datetime, time, urllib.parse, sys
import httpx
from bs4 import BeautifulSoup
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from scrape_roster import Fetcher, HERE, cache_path

SCHEMA = """
CREATE TABLE IF NOT EXISTS commits(id INTEGER PRIMARY KEY, school_id INTEGER, hs_class TEXT, pos_group TEXT, player TEXT, hometown TEXT,
  source_url TEXT, note TEXT, added_at TEXT, UNIQUE(school_id, hs_class, player));
CREATE TABLE IF NOT EXISTS program_camps(id INTEGER PRIMARY KEY, school_id INTEGER, url TEXT, label TEXT, dates_text TEXT, scraped_at TEXT,
  UNIQUE(school_id, url));
"""
CAMP_RX = re.compile(r"\bcamps?\b|\bclinic\b|prospect day|elite day|7[- ]on[- ]7|showcase", re.I)
DATE_RX = re.compile(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:\s*[-–&]\s*\d{1,2})?(?:,?\s+20\d{2})?", re.I)
POS_GROUP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "OL": "OL", "OT": "OL", "OG": "OL", "C": "OL", "DL": "DL", "DE": "DL", "DT": "DL", "EDGE": "DL",
             "LB": "LB", "DB": "DB", "CB": "DB", "S": "DB", "K": "K", "P": "P", "LS": "LS", "ATH": "ATH"}
INDEX_PATHS = ["/sports/football", "/sports/football/", "/index.aspx?path=football", "/sports/fball/index", "/sports/football/camps", "/camps"]

def import_commits(con):
    f = HERE / "data" / "commits.csv"
    if not f.exists():
        f.write_text("school,hs_class,pos,player,hometown,source_url,note\n", encoding="utf-8")
        print("created empty data/commits.csv (fill from 247Sports / Rivals / On3 or program announcements)"); return 0
    n = 0
    for r in csv.DictReader(open(f, encoding="utf-8")):
        if not r.get("school") or not r.get("player"): continue
        sid = con.execute("SELECT id FROM schools WHERE name=?", (r["school"].strip(),)).fetchone()
        if not sid: print("  unknown school in commits.csv:", r["school"]); continue
        pos = POS_GROUP.get((r.get("pos") or "").strip().upper(), (r.get("pos") or "").strip().upper())
        con.execute("INSERT OR REPLACE INTO commits(school_id,hs_class,pos_group,player,hometown,source_url,note,added_at) VALUES(?,?,?,?,?,?,?,?)",
                    (sid[0], (r.get("hs_class") or "").strip(), pos, r["player"].strip(), (r.get("hometown") or "").strip(), (r.get("source_url") or "").strip(), (r.get("note") or "").strip(), datetime.date.today().isoformat())); n += 1
    con.commit(); return n

def discover_camps(f: Fetcher, base: str):
    found = {}
    for path in INDEX_PATHS:
        code, html, _ = f.get(base + path)
        if code != 200 or len(html) < 5000: continue
        soup = BeautifulSoup(html, "lxml")
        for a in soup.select("a[href]"):
            txt = a.get_text(" ", strip=True); href = a["href"]
            if not (CAMP_RX.search(txt) or re.search(r"camp", href, re.I)): continue
            if re.search(r"campus|camping|campaign|champ", txt + href, re.I) and not CAMP_RX.search(txt): continue
            full = urllib.parse.urljoin(base + path, href)
            if full.startswith(("mailto:", "javascript", "tel:")) or re.search(r"safelinks|outlook\.com|facebook|twitter|x\.com|instagram|youtube", full, re.I): continue
            found.setdefault(full, txt[:80] or "Camps")
            if len(found) >= 6: break
        if found: break
    camps = []
    for url, label in list(found.items())[:3]:
        dates = ""
        code, html, _ = f.get(url)
        if code == 200 and html:
            text = BeautifulSoup(html, "lxml").get_text(" ", strip=True)
            ds = []
            for m in DATE_RX.finditer(text):
                d = m.group(0).strip()
                if d not in ds: ds.append(d)
                if len(ds) >= 6: break
            dates = "; ".join(ds)
        camps.append((url, label, dates))
    return camps

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--camps", action="store_true"); ap.add_argument("--texas", action="store_true"); ap.add_argument("--force", action="store_true"); ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    con = sqlite3.connect(HERE / "ledger.db", timeout=180); con.executescript(SCHEMA)
    print("commits imported:", import_commits(con))
    if not a.camps: return
    q = "SELECT id, name, athletics_domain FROM schools WHERE athletics_domain<>'' AND status<>'no_football'"
    if a.texas: q += " AND is_texas=1"
    rows = con.execute(q + " ORDER BY is_texas DESC, division, name").fetchall()
    if not a.force:
        done = {r[0] for r in con.execute("SELECT DISTINCT school_id FROM program_camps")}; rows = [r for r in rows if r[0] not in done]
    if a.limit: rows = rows[:a.limit]
    f = Fetcher(refetch=False, use_browser=False); ok = 0
    try:
        for i, (sid, name, site) in enumerate(rows, 1):
            base = re.sub(r"(https?://[^/]+).*", r"\1", site if site.startswith("http") else "https://" + site)
            camps = discover_camps(f, base)
            con.execute("DELETE FROM program_camps WHERE school_id=?", (sid,))
            for url, label, dates in camps:
                con.execute("INSERT OR IGNORE INTO program_camps(school_id,url,label,dates_text,scraped_at) VALUES(?,?,?,?,?)", (sid, url, label, dates, datetime.date.today().isoformat()))
            if not camps: con.execute("INSERT OR IGNORE INTO program_camps(school_id,url,label,dates_text,scraped_at) VALUES(?,?,?,?,?)", (sid, "", "none found", "", datetime.date.today().isoformat()))
            con.commit(); ok += bool(camps)
            print(f"[{i}/{len(rows)}] {name}: {len(camps)} camp link(s)" + (f" -> {camps[0][0]} [{camps[0][2][:60]}]" if camps else ""), flush=True)
    finally:
        f.close()
    print(f"camps done: {ok}/{len(rows)} programs with camp links")

if __name__ == "__main__":
    main()
