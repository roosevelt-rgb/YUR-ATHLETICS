"""Resolve each ledger school's official athletics website from the Wikipedia team article infobox.
Source: the FBS / FCS / D2 list pages already saved in data/wiki_*.json (team-article links) -> action=parse&prop=wikitext
-> `| website = ...`. Writes data/domains.csv and schools.athletics_domain. Polite: 1 request / 0.6 s, resumable."""
import json, re, csv, time, sqlite3, pathlib, sys, urllib.parse
import httpx
from bs4 import BeautifulSoup

HERE = pathlib.Path(__file__).resolve().parent; D = HERE / "data"
UA = "GridironScout/0.1 (+https://github.com/YUR-AI/YUR-ATHLETICIS-; roster-needs research)"
API = "https://en.wikipedia.org/w/api.php"
OUT = D / "domains.csv"

def team_links():
    """school/team display name -> wiki article title, from the three list pages (Nickname / Team column links)."""
    links = {}
    for pg in ("List_of_NCAA_Division_I_FBS_football_programs", "List_of_NCAA_Division_I_FCS_football_programs", "List_of_NCAA_Division_II_football_programs"):
        html = json.load(open(D / f"wiki_{pg}.json", encoding="utf-8"))["parse"]["text"]
        soup = BeautifulSoup(html, "lxml")
        for table in soup.select("table.wikitable"):
            hdr = [th.get_text(" ", strip=True).lower() for th in table.select("tr")[0].find_all(["th", "td"])]
            for tr in table.select("tr")[1:]:
                cells = tr.find_all(["td", "th"])
                if len(cells) < 3: continue
                row = {hdr[i]: cells[i] for i in range(min(len(hdr), len(cells)))}
                school_cell = next((row[k] for k in row if k.startswith("school") or k == "team" or k.startswith("institution")), None)
                nick_cell = next((row[k] for k in row if k.startswith("nickname") or k.startswith("name")), None)
                if school_cell is None: continue
                school = school_cell.get_text(" ", strip=True)
                a = (nick_cell.select_one("a[href^='/wiki/']") if nick_cell is not None else None) or school_cell.select_one("a[href^='/wiki/']")
                if a: links[school] = urllib.parse.unquote(a["href"].split("/wiki/")[1]).replace("_", " ")
    return links

WEB = re.compile(r"\|\s*website\s*=\s*(.+)", re.I)
def extract_site(wikitext: str) -> str:
    m = WEB.search(wikitext or "")
    if not m: return ""
    v = m.group(1)
    u = re.search(r"\{\{URL\|([^}|]+)", v) or re.search(r"\[(https?://[^\s\]]+)", v) or re.search(r"(https?://\S+|[\w.-]+\.(?:com|edu|org|net)\S*)", v)
    if not u: return ""
    site = u.group(1).strip().rstrip("/")
    if not site.startswith("http"): site = "https://" + site
    return site

def main(limit=None):
    con = sqlite3.connect(HERE / "ledger.db")
    prog = {r[0]: r for r in csv.reader(open(D / "programs.csv", encoding="utf-8")) if r[0] != "school_id"}
    done = {r["school"]: r for r in csv.DictReader(open(OUT, encoding="utf-8"))} if OUT.exists() else {}
    links = team_links()
    rows = list(done.values())
    todo = [(sid, name) for sid, name, div, sub, st, conf, match, wiki in (prog[k] for k in prog) if match in ("matched", "ambiguous") and name not in done]
    if limit: todo = todo[:limit]
    print(f"resolving {len(todo)} schools ({len(done)} already done)")
    with httpx.Client(headers={"User-Agent": UA}, timeout=20, follow_redirects=True) as cl:
        for i, (sid, name) in enumerate(todo, 1):
            wiki = prog[sid][7]
            title = links.get(wiki) or links.get(name) or ""
            site = ""; note = ""
            if not title:
                # try the school article itself, then "<wiki> football"
                for cand in (f"{wiki} football", wiki, name):
                    r = cl.get(API, params={"action": "parse", "page": cand, "prop": "wikitext", "formatversion": 2, "format": "json", "redirects": 1})
                    j = r.json()
                    if "parse" in j:
                        title = j["parse"]["title"]; site = extract_site(j["parse"]["wikitext"]); break
                    time.sleep(0.4)
                note = "fallback-title"
            else:
                for cand in (title if "football" in title.lower() else f"{title} football", title):
                    r = cl.get(API, params={"action": "parse", "page": cand, "prop": "wikitext", "formatversion": 2, "format": "json", "redirects": 1})
                    j = r.json()
                    if "parse" in j:
                        site = extract_site(j["parse"]["wikitext"]); title = j["parse"]["title"]
                        if site: break
                    time.sleep(0.4)
            rows.append({"school": name, "school_id": sid, "wiki_title": title, "website": site, "note": note})
            if site: con.execute("UPDATE schools SET athletics_domain=? WHERE id=?", (site, int(sid)))
            print(f"[{i}/{len(todo)}] {name} -> {title!r} -> {site or 'NOT FOUND'}", flush=True)
            if i % 10 == 0:
                con.commit()
                with open(OUT, "w", newline="", encoding="utf-8") as f:
                    w = csv.DictWriter(f, fieldnames=["school", "school_id", "wiki_title", "website", "note"]); w.writeheader(); w.writerows(rows)
            time.sleep(0.6)
    con.commit()
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["school", "school_id", "wiki_title", "website", "note"]); w.writeheader(); w.writerows(rows)
    found = sum(1 for r in rows if r["website"]); print(f"done: {found}/{len(rows)} websites found -> {OUT}")

if __name__ == "__main__":
    main(limit=int(sys.argv[1]) if len(sys.argv) > 1 else None)
