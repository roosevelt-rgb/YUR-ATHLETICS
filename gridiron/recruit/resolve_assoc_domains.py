"""Athletics websites for NAIA / NJCAA football programs (not in the NCAA directory).
Chain per school: Wikipedia school article infobox `website` -> school homepage -> the "Athletics" link's host (or athletics.<domain>).
Records every hop in data/assoc_domains.csv; sets schools.athletics_domain. Polite: ~1 request / 1.5 s. Resumable.
"""
import csv, json, re, time, sqlite3, pathlib, urllib.parse
import httpx
from bs4 import BeautifulSoup
HERE = pathlib.Path(__file__).resolve().parent; D = HERE / "data"; OUT = D / "assoc_domains.csv"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
API = "https://en.wikipedia.org/w/api.php"
WEB = re.compile(r"^\s*\|\s*website\s*=\s*(.+)$", re.I | re.M)

def wiki_site(cl, title):
    r = cl.get(API, params={"action": "parse", "page": title, "prop": "wikitext", "formatversion": 2, "format": "json", "redirects": 1}, headers={"User-Agent": "GridironScout/0.1 (+https://github.com/YUR-AI/YUR-ATHLETICIS-; roster-needs research)"})
    j = r.json()
    if "parse" not in j: return "", ""
    wt = j["parse"]["wikitext"]; m = WEB.search(wt)
    if not m: return j["parse"]["title"], ""
    v = m.group(1)
    u = re.search(r"\{\{URL\|([^}|]+)", v) or re.search(r"\[(https?://[^\s\]]+)", v) or re.search(r"(https?://\S+|[\w.-]+\.(?:edu|com|org|net)\S*)", v)
    site = (u.group(1) if u else "").strip().rstrip("/")
    if site and not site.startswith("http"): site = "https://" + site
    return j["parse"]["title"], site

def athletics_from_home(cl, home):
    try: r = cl.get(home, headers={"User-Agent": UA}, timeout=20)
    except Exception as e: return "", f"home {e.__class__.__name__}"
    if r.status_code != 200: return "", f"home {r.status_code}"
    soup = BeautifulSoup(r.text, "lxml"); host = urllib.parse.urlparse(str(r.url)).netloc.lower()
    cands = []
    for a in soup.select("a[href]"):
        txt = a.get_text(" ", strip=True).lower(); href = a["href"]
        if re.search(r"\bathletics?\b|\bsports\b", txt) or re.search(r"athletics", href, re.I):
            full = urllib.parse.urljoin(str(r.url), href); h = urllib.parse.urlparse(full).netloc.lower()
            score = (2 if h and h != host and not h.endswith("." + host.replace("www.", "")) else 1) + (1 if "athletic" in txt else 0)
            cands.append((score, full))
    if not cands: return "", "no athletics link"
    cands.sort(reverse=True); best = cands[0][1]
    u = urllib.parse.urlparse(best)
    return f"{u.scheme}://{u.netloc}" + (u.path.rstrip("/") if u.netloc == host else ""), "from homepage link"

def main():
    con = sqlite3.connect(HERE / "ledger.db", timeout=180)
    ref = list(csv.DictReader(open(D / "assoc_programs.csv", encoding="utf-8")))
    done = {r["school"]: r for r in csv.DictReader(open(OUT, encoding="utf-8"))} if OUT.exists() else {}
    rows = list(done.values())
    with httpx.Client(follow_redirects=True, timeout=25) as cl:
        for i, r in enumerate(ref, 1):
            if r["school"] in done: continue
            title, home = wiki_site(cl, r["school"]); time.sleep(0.8)
            if not home and r["association"] == "JUCO":
                title, home = wiki_site(cl, r["school"] + " College"); time.sleep(0.8)
            ath, note = ("", "no wiki website")
            if home: ath, note = athletics_from_home(cl, home); time.sleep(1.2)
            rows.append({"association": r["association"], "school": r["school"], "wiki_title": title, "homepage": home, "athletics": ath, "note": note})
            if ath: con.execute("UPDATE schools SET athletics_domain=? WHERE name=?", (ath, r["school"]))
            print(f"[{i}/{len(ref)}] {r['association']} {r['school']} -> {home or '-'} -> {ath or 'NOT FOUND'} ({note})", flush=True)
            if i % 10 == 0:
                con.commit()
                with open(OUT, "w", newline="", encoding="utf-8") as f:
                    w = csv.DictWriter(f, fieldnames=["association", "school", "wiki_title", "homepage", "athletics", "note"]); w.writeheader(); w.writerows(rows)
    con.commit()
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["association", "school", "wiki_title", "homepage", "athletics", "note"]); w.writeheader(); w.writerows(rows)
    print("done:", sum(1 for r in rows if r["athletics"]), "/", len(rows), "athletics sites found")

if __name__ == "__main__":
    main()
