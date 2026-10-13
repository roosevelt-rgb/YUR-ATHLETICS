"""Fetch every program's football roster (+ staff directory) page, parse players + staff + needs, store in ledger.db.
Polite (1 request / 2 s per host, browser UA, on-disk cache in cache/<host>/), resumable, never guesses: a school whose page
cannot be found/parsed is recorded in program_scrapes with status != 'ok' and listed in the summary.

usage: python scrape_roster.py [--texas] [--division D1|D2|D3] [--limit N] [--force] [--refetch] [--names "A,B"] [--no-browser]
  --force     re-parse and re-store schools already marked ok (uses the cache)
  --refetch   ignore the cache and hit the network again
"""
from __future__ import annotations
import argparse, datetime, json, pathlib, re, sqlite3, sys, time, urllib.parse
import httpx
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import sidearm_parser as sp

HERE = pathlib.Path(__file__).resolve().parent
CACHE = HERE / "cache"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
SEASON = "2026"; PRESTO_SEASONS = ("2026-27", "2025-26")
ROSTER_PATHS = ["/sports/football/roster", "/sports/football/roster/", "/roster.aspx?path=football", "/roster.aspx?path=fb",
                "/sports/fball/2026-27/roster", "/sports/fball/2025-26/roster", "/sports/football/roster/2026", "/sports/fball/roster",
                "/sports/m-footbl/roster", "/football/roster"]
STAFF_PATHS = ["/staff-directory/department/football", "/staff.aspx", "/staff-directory", "/sports/football/coaches", "/coaches.aspx?path=football",
               "/sports/fball/2026-27/coaches", "/sports/football/roster/coaches", "/staff-directory/department/football-operations"]
SCHEMA = """
CREATE TABLE IF NOT EXISTS program_scrapes(id INTEGER PRIMARY KEY, school_id INTEGER, url TEXT, status TEXT, http INTEGER,
  players INTEGER, staff INTEGER, scraped_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS players(id INTEGER PRIMARY KEY, school_id INTEGER, season TEXT, number TEXT, name TEXT, pos TEXT, pos_group TEXT,
  height_in INTEGER, weight_lb INTEGER, class TEXT, hometown TEXT, previous_school TEXT, source_url TEXT, scraped_at TEXT);
CREATE TABLE IF NOT EXISTS staff_scrape(id INTEGER PRIMARY KEY, school_id INTEGER, name TEXT, title TEXT, email TEXT, phone TEXT, role TEXT,
  section TEXT, source_url TEXT, scraped_at TEXT);
CREATE TABLE IF NOT EXISTS program_needs(id INTEGER PRIMARY KEY, school_id INTEGER, season TEXT, pos_group TEXT, count INTEGER,
  by_class TEXT, openings_by_hs_class TEXT, height_min INTEGER, height_avg REAL, height_max INTEGER, weight_min INTEGER, weight_avg REAL,
  weight_max INTEGER, scraped_at TEXT);
CREATE TABLE IF NOT EXISTS program_footprint(school_id INTEGER PRIMARY KEY, season TEXT, total INTEGER, texas INTEGER, dfw INTEGER,
  top_states TEXT, scraped_at TEXT);
CREATE INDEX IF NOT EXISTS ix_players_school ON players(school_id);
CREATE INDEX IF NOT EXISTS ix_staff_scrape_school ON staff_scrape(school_id);
"""

def host_of(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower()

def cache_path(url: str, rendered: bool = False) -> pathlib.Path:
    import hashlib
    u = urllib.parse.urlparse(url)
    name = re.sub(r"[^a-z0-9]+", "_", (u.path + ("?" + u.query if u.query else "")).lower()).strip("_") or "root"
    if len(name) > 80: name = name[:60] + "_" + hashlib.md5(name.encode()).hexdigest()[:10]
    host = re.sub(r"[^a-z0-9.-]", "_", u.netloc.lower())[:120] or "nohost"
    return CACHE / host / f"{name}{'.rendered' if rendered else ''}.html"

class Fetcher:
    def __init__(self, refetch: bool, use_browser: bool):
        self.client = httpx.Client(headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}, timeout=30, follow_redirects=True)
        self.refetch = refetch; self.use_browser = use_browser; self.last: dict = {}; self._pw = None; self._browser = None
    def _throttle(self, url):
        h = host_of(url); wait = 2.0 - (time.time() - self.last.get(h, 0))
        if wait > 0: time.sleep(wait)
        self.last[h] = time.time()
    def get(self, url: str) -> tuple[int, str, bool]:
        cp = cache_path(url); miss = cp.with_suffix(".miss")
        if cp.exists() and not self.refetch: return 200, cp.read_text(encoding="utf-8", errors="ignore"), True
        if miss.exists() and not self.refetch:
            try: return int(miss.read_text().strip() or 0), "", True
            except ValueError: pass
        self._throttle(url)
        try: r = self.client.get(url)
        except Exception as e: return 0, f"ERR {e.__class__.__name__}: {e}", False
        cp.parent.mkdir(parents=True, exist_ok=True)
        if r.status_code == 200 and len(r.text) > 5000: cp.write_text(r.text, encoding="utf-8")
        elif r.status_code in (404, 410) or (r.status_code == 200 and len(r.text) <= 5000): miss.write_text(str(r.status_code))
        return r.status_code, r.text, False
    def render(self, url: str) -> str:
        """Headless Chromium for client-rendered NextGen pages (Baylor et al.)."""
        cp = cache_path(url, rendered=True)
        if cp.exists() and not self.refetch: return cp.read_text(encoding="utf-8", errors="ignore")
        if not self.use_browser: return ""
        try:
            if self._pw is None:
                from playwright.sync_api import sync_playwright
                self._pw = sync_playwright().start(); self._browser = self._pw.chromium.launch(headless=True)
            self._throttle(url)
            pg = self._browser.new_page(user_agent=UA)
            pg.goto(url, wait_until="domcontentloaded", timeout=60000)
            try: pg.wait_for_selector("#tablePanel table tbody tr, .s-person-card, table.sidearm-table, .sidearm-roster-player", timeout=25000)
            except Exception: pass
            html = pg.content(); pg.close()
            if len(html) > 20000: cp.parent.mkdir(parents=True, exist_ok=True); cp.write_text(html, encoding="utf-8")
            return html
        except Exception as e:
            return f"ERR {e.__class__.__name__}: {e}"
    def close(self):
        self.client.close()
        if self._browser: self._browser.close()
        if self._pw: self._pw.stop()

def looks_like_roster(html: str) -> bool:
    return bool(re.search(r"roster", html, re.I)) and bool(re.search(r"\bQB\b|\bOL\b|\bWR\b|Quarterback|Linebacker", html))

def store(con, sid: int, res: dict, url: str, staff_url: str):
    now = res["scraped_at"]
    con.execute("DELETE FROM players WHERE school_id=? AND season=?", (sid, SEASON))
    con.execute("DELETE FROM staff_scrape WHERE school_id=?", (sid,))
    con.execute("DELETE FROM program_needs WHERE school_id=? AND season=?", (sid, SEASON))
    con.execute("DELETE FROM contacts WHERE school_id=? AND source='scrape'", (sid,))
    con.executemany("INSERT INTO players(school_id,season,number,name,pos,pos_group,height_in,weight_lb,class,hometown,previous_school,source_url,scraped_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(sid, SEASON, p["number"], p["name"], p["pos"], p["pos_group"], p["height_in"], p["weight_lb"], p["class"], p["hometown"], p["previous_school"], url, now) for p in res["players"]])
    con.executemany("INSERT INTO staff_scrape(school_id,name,title,email,phone,role,section,source_url,scraped_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    [(sid, s["name"], s["title"], s["email"], s["phone"], s["role"], s["section"], s.get("_url", staff_url or url), now) for s in res["staff"]])
    for g, n in res["needs"].items():
        h = n["height_in"] or {}; w = n["weight_lb"] or {}
        con.execute("INSERT INTO program_needs(school_id,season,pos_group,count,by_class,openings_by_hs_class,height_min,height_avg,height_max,weight_min,weight_avg,weight_max,scraped_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (sid, SEASON, g, n["count"], json.dumps(n["by_class"]), json.dumps(n["openings_by_hs_class"]), h.get("min"), h.get("avg"), h.get("max"), w.get("min"), w.get("avg"), w.get("max"), now))
    f = res["footprint"]
    con.execute("INSERT OR REPLACE INTO program_footprint(school_id,season,total,texas,dfw,top_states,scraped_at) VALUES(?,?,?,?,?,?,?)",
                (sid, SEASON, f["total"], f["texas"], f["dfw"], json.dumps(f["top_states"]), now))
    for s in res["staff"]:
        if s["role"] in ("head_coach", "recruiting_coordinator", "player_personnel", "qb_coach", "oc") or s["email"]:
            con.execute("INSERT OR IGNORE INTO contacts(school_id,role,name,title,email,phone,source,source_url,verified_at,email_status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (sid, s["role"], s["name"], s["title"], s["email"], s["phone"], "scrape", s.get("_url", staff_url or url), now, "unknown"))
    con.execute("UPDATE schools SET staff_url=? WHERE id=?", (staff_url or url, sid))

def scrape_one(f: Fetcher, base: str, name: str) -> tuple[str, dict | None, str, str, str]:
    """returns (status, result, roster_url, staff_url, note)"""
    html = url_used = ""; note = ""; status = "no_roster_page"; first_200 = ""
    for path in ROSTER_PATHS:
        url = base + path
        code, body, cached = f.get(url)
        if code == 200 and looks_like_roster(body):
            if not first_200: first_200 = url
            res = sp.parse(body, name, url)
            if res["players"]:
                html, url_used, status = body, url, "ok"; break
            note = f"200 but no roster table at {path}"
        elif code in (403, 429):
            status = f"blocked_{code}"; note = f"{code} at {path}"; break
        else:
            note = f"last {code} at {path}"
    if status != "ok" and first_200 and status.startswith("no_roster") or (status != "ok" and first_200 and "__NUXT__" in (f.get(first_200)[1] or "")):
        rendered = f.render(first_200)
        if rendered and not rendered.startswith("ERR"):
            res = sp.parse(rendered, name, first_200)
            if res["players"]: html, url_used, status, note = rendered, first_200, "ok", "rendered with headless browser"
        elif rendered: note = rendered[:120]
    if status != "ok": return status, None, url_used or first_200, "", note
    res = sp.parse(html, name, url_used)
    staff_url = ""
    emails = sum(1 for s in res["staff"] if s["email"])
    if emails < 3:  # staff lives on a separate page for classic Sidearm / WMT / Presto
        for path in STAFF_PATHS:
            url = base + path
            code, body, cached = f.get(url)
            if code != 200 or len(body) < 5000: continue
            extra = sp.parse_staff_page(body)
            if sum(1 for s in extra for _ in [1] if s["email"]) >= 2 or (extra and len(extra) >= 3 and not res["staff"]):
                for s in extra: s["_url"] = url
                merged = {(s["name"].lower(), s["title"].lower()): s for s in res["staff"]}
                for s in extra:
                    k = (s["name"].lower(), s["title"].lower())
                    if k not in merged or (s["email"] and not merged[k]["email"]): merged[k] = s   # prefer the row that has an email
                by_name = {s["name"].lower(): s for s in extra if s["email"]}
                for s in merged.values():                                                        # same person, slightly different title
                    if not s["email"] and s["name"].lower() in by_name: s["email"] = by_name[s["name"].lower()]["email"]; s["_url"] = url
                res["staff"] = list(merged.values()); staff_url = url
                break
    return "ok", res, url_used, staff_url, note

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--texas", action="store_true"); ap.add_argument("--division", default=""); ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true"); ap.add_argument("--refetch", action="store_true"); ap.add_argument("--names", default="")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    con = sqlite3.connect(HERE / "ledger.db", timeout=180); con.executescript(SCHEMA)
    q = "SELECT id, name, athletics_domain FROM schools WHERE athletics_domain IS NOT NULL AND athletics_domain <> '' AND status <> 'no_football'"
    if a.texas: q += " AND is_texas=1"
    if a.division: q += f" AND division='{a.division}'"
    rows = con.execute(q + " ORDER BY is_texas DESC, division, name").fetchall()
    ov = HERE / "data" / "domain_overrides.csv"
    if ov.exists():
        import csv as _csv
        over = {r["school"]: r["base"] for r in _csv.DictReader(open(ov, encoding="utf-8"))}
        rows = [(sid, name, over.get(name, site)) for sid, name, site in rows]
    if a.names:
        want = {n.strip().lower() for n in a.names.split(",")}; rows = [r for r in rows if r[1].lower() in want]
    done = {r[0] for r in con.execute("SELECT school_id FROM program_scrapes WHERE status='ok'")} if not a.force else set()
    rows = [r for r in rows if r[0] not in done]
    if a.limit: rows = rows[:a.limit]
    print(f"scraping {len(rows)} programs (skipping {len(done)} already ok)", flush=True)
    f = Fetcher(refetch=a.refetch, use_browser=not a.no_browser); ok = fail = 0
    try:
        for i, (sid, name, site) in enumerate(rows, 1):
            base = site.strip().rstrip("/")
            if not base.startswith("http"): base = "https://" + base
            base = re.sub(r"(https?://[^/]+).*", r"\1", base)
            status, res, url_used, staff_url, note = scrape_one(f, base, name)
            if status == "ok":
                store(con, sid, res, url_used, staff_url); ok += 1
                em = sum(1 for s in res["staff"] if s["email"])
                print(f"[{i}/{len(rows)}] OK  {name}: {len(res['players'])} players ({res['needs'].get('QB', {}).get('class_known', 0)}/{res['needs'].get('QB', {}).get('count', 0)} QB classes), {len(res['staff'])} staff ({em} emails), TX {res['footprint']['texas']}, DFW {res['footprint']['dfw']}  <- {url_used}{(' + ' + staff_url) if staff_url else ''}", flush=True)
            else:
                fail += 1; print(f"[{i}/{len(rows)}] --  {name}: {status} ({note}) base={base}", flush=True)
            con.execute("DELETE FROM program_scrapes WHERE school_id=?", (sid,))
            con.execute("INSERT INTO program_scrapes(school_id,url,status,http,players,staff,scraped_at,note) VALUES(?,?,?,?,?,?,?,?)",
                        (sid, url_used or base, status, None, len(res["players"]) if res else None, len(res["staff"]) if res else None, datetime.date.today().isoformat(), note))
            con.commit()
    finally:
        f.close()
    print(f"done: ok={ok} failed={fail}")

if __name__ == "__main__":
    main()
