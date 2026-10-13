"""Weekly MaxPreps stats sync for every athlete card that has media.maxPrepsUrl.

MaxPreps athlete football stats page (verified 2026-10-10 on a public athlete):
  https://www.maxpreps.com/<st>/<city>/<school-slug>/athletes/<name-slug>/football/stats/?careerid=<id>
  one <table> per category (Passing, Rushing, Receiving, Tackles, ...), preceded by a heading with the category name;
  header: ['GD','Team','Year','GP', <stat columns...>]; one row per season (Year like '25-26').
Fetch goes through the app's own proxy when the dev server is up (same UA/headers as the in-app Sync button), else direct.
Writes athlete.stats = [{season, team, grade, gp, source:'maxpreps', sourceUrl, fetchedAt, sha256, <category>: {...}}] and keeps a
history row in stats_history. Deterministic: no LLM. Nothing is written if no table parsed.

usage: python maxpreps_sync.py [--athlete <athlete-id>] [--url <stats url>]   (schedule weekly: Mondays 06:00 CT)
"""
import argparse, datetime, hashlib, json, os, pathlib, re, sys, time
import httpx
from bs4 import BeautifulSoup
from pymongo import MongoClient
HERE = pathlib.Path(__file__).resolve().parent
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MONGO = os.environ.get("MONGO_URL", "mongodb://localhost:27017")

def stats_url(url: str) -> str:
    """Accepts the athlete home ('/athlete/<name>/<id>/default.htm'), the stats page, or the school athlete page; returns the stats page."""
    u = url.strip()
    if "/football/stats" in u: return u
    base, _, query = u.partition("?")
    if re.search(r"/athletes/[^/]+/?$", base):
        return base.rstrip("/") + "/football/stats/" + ("?" + query if query else "")
    return u

def fetch(url: str) -> str:
    try:
        r = httpx.get("http://localhost:3000/api/proxy/maxpreps", params={"url": url}, timeout=40)
        if r.status_code == 200 and r.json().get("html"): return r.json()["html"]
    except Exception: pass
    r = httpx.get(url, headers={"User-Agent": UA, "Accept": "text/html"}, follow_redirects=True, timeout=40)
    r.raise_for_status(); return r.text

def num(s: str):
    s = (s or "").strip().replace(",", "")
    if re.fullmatch(r"-?\d+", s): return int(s)
    if re.fullmatch(r"-?\d*\.\d+", s): return float(s)
    return s

def parse_stats(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml"); seasons: dict[str, dict] = {}
    for t in soup.select("table"):
        hdr = [th.get_text(" ", strip=True) for th in t.select("thead th")] or [x.get_text(" ", strip=True) for x in (t.select_one("tr") or t).find_all(["th", "td"])]
        if "Year" not in hdr: continue
        cap = t.find_previous(["h2", "h3", "h4", "caption"]); category = (cap.get_text(" ", strip=True) if cap else "Stats").lower()
        category = re.sub(r"[^a-z0-9]+", "_", category).strip("_") or "stats"
        ix = {h: i for i, h in enumerate(hdr)}
        for tr in (t.select("tbody tr") or t.select("tr")[1:]):
            c = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if len(c) < len(hdr) - 2 or "Year" not in ix or ix["Year"] >= len(c): continue
            season = c[ix["Year"]]
            if not re.match(r"^\d{2}-\d{2}$", season): continue
            s = seasons.setdefault(season, {"season": "20" + season.split("-")[0] + "-" + season.split("-")[1], "grade": c[ix["GD"]] if "GD" in ix else "", "team": c[ix["Team"]] if "Team" in ix else "", "gp": num(c[ix["GP"]]) if "GP" in ix else None})
            s[category] = {h: num(c[i]) for h, i in ix.items() if h not in ("GD", "Team", "Year", "GP") and i < len(c)}
    return sorted(seasons.values(), key=lambda s: s["season"], reverse=True)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--athlete", default=""); ap.add_argument("--url", default=""); ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    db = MongoClient(MONGO, serverSelectionTimeoutMS=5000)["gridiron"]
    q = {"id": a.athlete} if a.athlete else {"media.maxPrepsUrl": {"$nin": ["", None]}}
    for ath in db.athletes.find(q):
        url = a.url or (ath.get("media") or {}).get("maxPrepsUrl") or ""
        if not url: print(ath["id"], ": no MaxPreps URL on file"); continue
        url = stats_url(url); html = fetch(url); rows = parse_stats(html)
        digest = hashlib.sha256(html.encode("utf-8", "ignore")).hexdigest()[:16]; now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        if not rows: print(ath["id"], ": no stat tables parsed at", url); continue
        for r in rows: r.update({"source": "maxpreps", "sourceUrl": url, "fetchedAt": now, "sha256": digest})
        print(ath["id"], ":", len(rows), "season rows", [(r["season"], [k for k in r if isinstance(r[k], dict)]) for r in rows])
        if a.dry: print(json.dumps(rows, indent=1)[:1500]); continue
        db.athletes.update_one({"id": ath["id"]}, {"$set": {"stats": rows, "statsNote": "", "media.maxPrepsStatsUrl": url, "statsUpdatedAt": now}})
        db.stats_history.insert_one({"athleteId": ath["id"], "fetchedAt": now, "sourceUrl": url, "sha256": digest, "rows": rows})
        time.sleep(2)

if __name__ == "__main__":
    main()
