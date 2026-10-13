"""Historical rosters: every program's football roster for past seasons (as far back as each site keeps them).

Why: the strongest matching signal is revealed preference -- which quarterbacks (size, home state, high school level,
high-school signee vs transfer) each program actually brought in, year after year.

How: for each program already scraped (Mongo gridiron.colleges, rosterProfile.sourceUrl), request
  <roster url>/<year>           (Sidearm NextGen / classic / most sites; verified on 8 schools FBS->JUCO 2026-10-11)
  <base>/sports/fball/<yy>/roster  (PrestoSports)
walking back from 2025 to 2006, stopping after 3 consecutive missing seasons once older history is exhausted.
A season counts only if the page parses to players AND it is not the current roster served under an old URL
(year must appear on the page and the name overlap with the 2026 roster must be < 85%).
Polite: 1 request / 2 s per host, browser UA, gzip disk cache in cache_hist/<host>/, resumable (skips cached seasons).

Writes ledger.db table players_hist (all positions) and program_history (per program per season: status, players, url).
usage: python -P recruit/history_crawl.py [--workers 24] [--names "A,B"] [--from 2025] [--to 2006] [--limit N]
"""
from __future__ import annotations
import argparse, datetime, gzip, hashlib, json, pathlib, re, sqlite3, sys, threading, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import httpx
from pymongo import MongoClient

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sidearm_parser as sp

CACHE = HERE / "cache_hist"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
SCHEMA = """
CREATE TABLE IF NOT EXISTS players_hist(id INTEGER PRIMARY KEY, college TEXT, division TEXT, season INTEGER, number TEXT, name TEXT,
  pos TEXT, pos_group TEXT, height_in INTEGER, weight_lb INTEGER, class TEXT, hometown TEXT, previous_school TEXT, source_url TEXT, scraped_at TEXT);
CREATE INDEX IF NOT EXISTS ix_ph_college ON players_hist(college, season);
CREATE INDEX IF NOT EXISTS ix_ph_pos ON players_hist(pos_group);
CREATE TABLE IF NOT EXISTS program_history(college TEXT, season INTEGER, status TEXT, players INTEGER, qbs INTEGER, url TEXT, note TEXT,
  checked_at TEXT, PRIMARY KEY(college, season));
"""
_db_lock = threading.Lock()
_host_lock: dict[str, threading.Lock] = {}
_host_last: dict[str, float] = {}


def norm(n: str) -> str:
    return re.sub(r"[^a-z]", "", (n or "").lower())


def cache_file(url: str) -> pathlib.Path:
    u = urllib.parse.urlparse(url)
    name = re.sub(r"[^a-z0-9]+", "_", (u.path + ("?" + u.query if u.query else "")).lower()).strip("_") or "root"
    if len(name) > 90:
        name = name[:70] + "_" + hashlib.md5(name.encode()).hexdigest()[:10]
    return CACHE / re.sub(r"[^a-z0-9.-]", "_", u.netloc.lower()) / f"{name}.html.gz"


def fetch(client: httpx.Client, url: str) -> tuple[int, str, str]:
    """returns (status, html, final_url); gzip cache; 1 req / 2 s per host"""
    cf = cache_file(url); miss = cf.with_suffix(".miss")
    if cf.exists():
        meta = cf.with_suffix(".url")
        return 200, gzip.decompress(cf.read_bytes()).decode("utf-8", "ignore"), (meta.read_text() if meta.exists() else url)
    if miss.exists():
        return int(miss.read_text() or 0), "", url
    host = urllib.parse.urlparse(url).netloc.lower()
    lock = _host_lock.setdefault(host, threading.Lock())
    with lock:
        wait = 2.0 - (time.time() - _host_last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        try:
            r = client.get(url)
        except Exception as e:
            _host_last[host] = time.time()
            return 0, f"ERR {e.__class__.__name__}", url
        _host_last[host] = time.time()
    cf.parent.mkdir(parents=True, exist_ok=True)
    if r.status_code == 200 and len(r.text) > 5000:
        cf.write_bytes(gzip.compress(r.text.encode("utf-8", "ignore")))
        cf.with_suffix(".url").write_text(str(r.url))
    elif r.status_code in (404, 410) or (r.status_code == 200 and len(r.text) <= 5000):
        miss.write_text(str(r.status_code))
    return r.status_code, r.text, str(r.url)


def season_urls(src: str, year: int) -> list[str]:
    u = urllib.parse.urlparse(src); base = f"{u.scheme}://{u.netloc}"
    path = u.path.rstrip("/")
    out = []
    if re.search(r"/sports/[^/]+/roster$", path):
        out.append(base + path + f"/{year}")
    m = re.search(r"/sports/fball/\d{4}-\d{2}/roster", path)
    if m or "presto" in src:
        out.append(base + f"/sports/fball/{year}-{str(year + 1)[2:]}/roster")
    if "roster.aspx" in path:
        q = urllib.parse.parse_qs(u.query)
        out.append(base + f"/roster.aspx?path={q.get('path', ['football'])[0]}&year={year}")
    if not out:
        out.append(base + "/sports/football/roster" + f"/{year}")
    return out


def crawl_program(college: dict, years: list[int], current_names: set[str], con_path: str) -> dict:
    name = college["metadata"]["name"]; div = college["metadata"].get("division", "")
    src = college["rosterProfile"]["sourceUrl"]
    client = httpx.Client(headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}, timeout=30, follow_redirects=True)
    got, misses, rows, status_rows = 0, 0, [], []
    try:
        for y in years:
            ok = False; note = ""; used = ""
            for url in season_urls(src, y):
                code, html, final = fetch(client, url)
                if code != 200 or not html:
                    note = f"http {code}"; continue
                res = sp.parse(html, name, url)
                players = res["players"]
                if not players:
                    note = "no players parsed"; continue
                names = {norm(p["name"]) for p in players}
                overlap = len(names & current_names) / max(1, len(names))
                if str(y) not in html:
                    note = "year not on page"; continue
                if overlap >= 0.85 and y <= 2024:
                    note = f"same as current roster ({overlap:.0%})"; continue
                ok = True; used = url
                now = datetime.date.today().isoformat()
                rows += [(name, div, y, p["number"], p["name"], p["pos"], p["pos_group"], p["height_in"], p["weight_lb"], p["class"],
                          p["hometown"], p["previous_school"], url, now) for p in players]
                status_rows.append((name, y, "ok", len(players), sum(1 for p in players if p["pos_group"] == "QB"), url, "", now))
                break
            if ok:
                got += 1; misses = 0
            else:
                misses += 1
                status_rows.append((name, y, "missing", 0, 0, used, note, datetime.date.today().isoformat()))
                if misses >= 3 and (got > 0 or y <= 2021):
                    break
    finally:
        client.close()
    with _db_lock:
        con = sqlite3.connect(con_path, timeout=180)
        con.execute("DELETE FROM players_hist WHERE college=?", (name,))
        con.executemany("INSERT INTO players_hist(college,division,season,number,name,pos,pos_group,height_in,weight_lb,class,hometown,previous_school,source_url,scraped_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        con.executemany("INSERT OR REPLACE INTO program_history(college,season,status,players,qbs,url,note,checked_at) VALUES(?,?,?,?,?,?,?,?)", status_rows)
        con.commit(); con.close()
    return {"college": name, "seasons": got, "rows": len(rows)}


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # program names like Hawaiʻi crashed cp1252 prints
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=24); ap.add_argument("--names", default="")
    ap.add_argument("--from", dest="y0", type=int, default=2025); ap.add_argument("--to", dest="y1", type=int, default=2006)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    con_path = str(HERE / "ledger.db")
    con = sqlite3.connect(con_path, timeout=180); con.executescript(SCHEMA); con.close()
    db = MongoClient("mongodb://localhost:27017")["gridiron"]
    colleges = list(db.colleges.find({"rosterProfile.scrapeStatus": "ok", "rosterProfile.sourceUrl": {"$exists": True}},
                                     {"_id": 0, "metadata": 1, "rosterProfile.sourceUrl": 1}))
    if a.names:
        want = [n.strip().lower() for n in a.names.split(",")]
        colleges = [c for c in colleges if any(c["metadata"]["name"].lower().startswith(w) for w in want)]
    if a.limit:
        colleges = colleges[:a.limit]
    current = {}
    for p in db.players.find({}, {"_id": 0, "school": 1, "name": 1}):
        current.setdefault(p["school"], set()).add(norm(p["name"]))
    years = list(range(a.y0, a.y1 - 1, -1))
    print(f"history crawl: {len(colleges)} programs, seasons {a.y0}->{a.y1}, {a.workers} workers", flush=True)
    done = 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(crawl_program, c, years, current.get(c["metadata"]["name"], set()), con_path): c["metadata"]["name"] for c in colleges}
        for f in as_completed(futs):
            done += 1
            try:
                r = f.result(); print(f"[{done}/{len(colleges)}] {r['college']}: {r['seasons']} seasons, {r['rows']} player-rows", flush=True)
            except Exception as e:
                print(f"[{done}/{len(colleges)}] {futs[f]}: ERROR {e.__class__.__name__}: {e}", flush=True)
    print("HISTORY_DONE", flush=True)


if __name__ == "__main__":
    main()
