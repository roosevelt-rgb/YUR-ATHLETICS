"""Parse college football roster / staff pages into players + staff + derived program needs.

Layouts verified 2026-10-10 (Texas crawl):
  NextGen Sidearm (Nuxt; SMU, TCU, Rice, UNT, UH, Tech, SFA, SHSU, ACU, Texas, Baylor*): #tablePanel holds a roster table
     ['#','Name','Pos','Ht','Wt','Year|Class|Cls.|Academic Year|Years / At ACU','Hometown / Previous School'] plus
     'Coaching Staff' and 'Support Staff' tables ['<section>','Image','Name','Title','Email','Phone Number'] (header has one
     extra cell). Texas's table lacks Ht/Wt but its .s-person-card cards carry label/value pairs. *Baylor renders client-side
     (needs the Playwright fallback in scrape_roster.py).
  Classic Sidearm (most FCS/D2/D3): two 'Statistic' tables then the roster table ['#|No.|Image','Full Name|Name','Pos.','Ht.',
     'Wt.','Yr.|Cl.|Class|Academic Year|Yr.-Exp.','Hometown / High School', ...]; staff lives on /staff.aspx
     ['Image','Name','Title','Email','Phone','X'] with one-cell department rows ('Football').
  WMT (Texas A&M, UTSA): ['# Jersey Number','Name','Position','Height','Weight','Class','Hometown','High School'] + a
     ['Name','Title'] table; emails on /staff-directory/department/football (.staff-directory-table-member-position rows).
  PrestoSports (D3): /sports/fball/<season>/roster, cells prefixed 'Pos.: WR', 'Cl.: Jr', 'Ht.: 5-8'.
Class tokens seen: Fr. So. Jr. Sr. Gr. 5th 4th 1st R-So. RS-Fr. Redshirt Senior Freshman So.-1L Jr.-TR 5TH YR '3 / 1' (ACU years).
"""
from __future__ import annotations
import re, json, sys, pathlib, datetime
from collections import Counter, defaultdict
from bs4 import BeautifulSoup
import dfw_cities

EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")
PHONE = re.compile(r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")
HT = re.compile(r"(\d)\s*['’\-]\s*(\d{1,2})")           # 6' 2'' | 6-2 | 6’2”
ORD = {"1st": "FR", "2nd": "SO", "3rd": "JR", "4th": "SR", "5th": "GR", "6th": "GR", "1": "FR", "2": "SO", "3": "JR", "4": "SR", "5": "GR", "6": "GR"}
WORDS = {"freshman": "FR", "sophomore": "SO", "junior": "JR", "senior": "SR", "graduate": "GR", "grad": "GR", "fr": "FR", "so": "SO", "jr": "JR", "sr": "SR", "gr": "GR"}
# class -> remaining eligibility seasons AFTER the current one (approximation; redshirts counted conservatively)
SEASONS_LEFT = {"FR": 3, "RFR": 3, "SO": 2, "RSO": 2, "JR": 1, "RJR": 1, "SR": 0, "RSR": 0, "GR": 0, "": 1}
POS_GROUP = {"QB": "QB", "RB": "RB", "HB": "RB", "TB": "RB", "FB": "RB", "WR": "WR", "TE": "TE", "OL": "OL", "OT": "OL", "OG": "OL", "C": "OL",
             "G": "OL", "T": "OL", "DL": "DL", "DE": "DL", "DT": "DL", "NT": "DL", "NG": "DL", "EDGE": "DL", "LB": "LB", "ILB": "LB", "OLB": "LB",
             "MLB": "LB", "DB": "DB", "CB": "DB", "S": "DB", "FS": "DB", "SS": "DB", "NB": "DB", "K": "K", "PK": "K", "P": "P", "LS": "LS",
             "ATH": "ATH", "KR": "ATH", "PR": "ATH", "SLOT": "WR", "SAF": "DB", "STAR": "DB", "NICKEL": "DB", "H": "TE", "HB/FB": "RB", "OLB/DE": "LB", "JACK": "LB", "BUCK": "LB", "VIPER": "LB", "ROVER": "DB", "WILL": "LB", "MIKE": "LB", "SAM": "LB", "BANDIT": "DL"}
ROLE_RULES = [  # first match wins
    ("head_coach", r"^head coach\b|^head football coach|^interim head coach"),
    ("recruiting_coordinator", r"recruit"),
    ("player_personnel", r"player personnel|general manager|\bgm\b|scouting|talent acquisition|roster management"),
    ("qb_coach", r"quarterback|\bqbs?\b|passing game coordinator"),
    ("oc", r"offensive coordinator|co-offensive coordinator"),
    ("other", r"."),
]
TX_METRO_DFW = dfw_cities.regex(r"\b", dfw_cities.CITIES)  # a hometown's city part (local data, see dfw_cities.py)
HDR = {  # column key -> regex on lowercased header text
    "number": r"^(#|no\.?$|no\b|jersey)", "name": r"name", "pos": r"^pos", "ht": r"^ht|height", "wt": r"^wt|weight",
    "class": r"year|^yr|^cl\b|^cl\.|^cls|class|acad|elig", "hometown": r"hometown", "prev": r"high school|previous|last school|prev\b",
}
LABELS = {"jersey number": "number", "position": "pos", "academic year": "class", "class": "class", "year": "class", "height": "ht",
          "weight": "wt", "hometown": "hometown", "last school": "prev", "high school": "prev", "previous school": "prev", "custom field 1": "_x"}

def clean(s: str) -> str:
    s = s or ""
    if re.match(r"^\s*[A-Za-z./ ]{1,22}:\s", s): s = re.sub(r"^\s*[A-Za-z./ ]{1,22}:\s*", "", s)   # 'Pos.: WR' -> 'WR'
    return re.sub(r"\s+", " ", s).strip()

def parse_height(s: str) -> int | None:
    m = HT.search(s or "")
    return int(m.group(1)) * 12 + int(m.group(2)) if m else None

def parse_weight(s: str) -> int | None:
    m = re.search(r"(\d{2,3})", s or ""); return int(m.group(1)) if m else None

def norm_class(s: str) -> str:
    s = (s or "").strip().lower().replace(".", "")
    s = re.sub(r"^academic year\s*", "", s)
    s = re.sub(r"\s*(yr|year)s?$", "", s)
    s = re.sub(r"\s*/\s*\d+.*$", "", s)                      # '3 / 1' (ACU years / at ACU) -> '3'
    red = bool(re.match(r"^(redshirt|rs|r)([\s-]|$)", s))   # longest alternative first: 'redshirt senior', 'rs-fr', 'r-so'
    if red: s = re.sub(r"^(redshirt|rs|r)[\s-]*", "", s)
    s = re.sub(r"-(1l|2l|3l|4l|tr|hs|rs|jc|sq|v)$", "", s)      # 'so-1l' (letters won), 'jr-tr' (transfer), 'fr-hs', 'fr-rs'
    if s.endswith("-rs"): red = True
    base = ORD.get(s) or WORDS.get(s) or ("GR" if re.match(r"^(5th|6th|grad|gr)", s) else "")
    if not base and s[:2] in WORDS: base = WORDS[s[:2]]
    return ("R" + base) if (red and base in ("FR", "SO", "JR", "SR")) else base

def classify_title(title: str) -> str:
    t = (title or "").lower()
    for role, rx in ROLE_RULES:
        if re.search(rx, t): return role
    return "other"

def _header(table):
    ths = table.select("thead th")
    if ths: return [th.get_text(" ", strip=True) for th in ths]
    first = table.select_one("tr")
    return [x.get_text(" ", strip=True) for x in first.find_all(["th", "td"])] if first else []

def _col_index(hdr: list[str]) -> dict:
    h = [x.lower() for x in hdr]; ix = {}
    for key, rx in HDR.items():
        for i, x in enumerate(h):
            if re.search(rx, x) and i not in ix.values():
                ix[key] = i; break
    return ix

POS_WORDS = {"quarterback": "QB", "running back": "RB", "wide receiver": "WR", "tight end": "TE", "offensive line": "OL", "offensive lineman": "OL",
             "offensive tackle": "OT", "offensive guard": "OG", "center": "C", "defensive line": "DL", "defensive lineman": "DL", "defensive end": "DE",
             "defensive tackle": "DT", "nose tackle": "NT", "linebacker": "LB", "inside linebacker": "ILB", "outside linebacker": "OLB",
             "defensive back": "DB", "cornerback": "CB", "safety": "S", "kicker": "K", "punter": "P", "long snapper": "LS", "athlete": "ATH", "edge": "EDGE"}
def _player(number, name, pos_raw, ht, wt, cls, hometown, prev):
    pos_raw = clean(pos_raw)
    if pos_raw.lower() in POS_WORDS: pos_raw = POS_WORDS[pos_raw.lower()]
    elif "/" in pos_raw and any(w in POS_WORDS for w in [x.strip().lower() for x in pos_raw.split("/")]):
        pos_raw = "/".join(POS_WORDS.get(x.strip().lower(), x.strip()) for x in pos_raw.split("/"))
    pos_raw = pos_raw.upper(); pos = re.split(r"[/,\s]", pos_raw)[0] if pos_raw else ""
    hometown = clean(hometown); prev = clean(prev)
    if "/" in hometown and not prev:
        hometown, _, prev = hometown.partition("/")
    return {"number": clean(number), "name": clean(name), "pos": pos_raw, "pos_group": POS_GROUP.get(pos, pos or "?"),
            "height_in": parse_height(clean(ht)), "weight_lb": parse_weight(clean(wt)), "class": norm_class(clean(cls)),
            "hometown": hometown.strip(), "previous_school": prev.strip()}

def parse_roster_tables(soup) -> list[dict]:
    players = []
    for table in soup.select("table"):
        hdr = _header(table); ix = _col_index(hdr)
        if "pos" not in ix or "name" not in ix or not ({"ht", "class", "hometown"} & set(ix)): continue
        body = table.select("tbody tr") or table.select("tr")[1:]
        for tr in body:
            c = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if len(c) < 3: continue
            off = len(hdr) - len(c) if 0 < len(hdr) - len(c) <= 1 else 0
            g = lambda k: (c[ix[k] - off] if k in ix and 0 <= ix[k] - off < len(c) else "")
            if not clean(g("name")) or not clean(g("pos")): continue
            players.append(_player(g("number"), g("name"), g("pos"), g("ht"), g("wt"), g("class"), g("hometown"), g("prev")))
    return players

def parse_roster_cards(soup) -> list[dict]:
    """NextGen Sidearm person cards: sr-only labels followed by values."""
    players = []
    for card in soup.select(".s-person-card"):
        txt = card.get_text(" | ", strip=True)
        if "Position" not in txt or "Hometown" not in txt: continue
        toks = [t.strip() for t in txt.split(" | ")]
        f = {}; name = ""
        link = card.select_one("[data-test-id='s-person-details__personal-single-line-person-link'], .s-person-details__personal-single-line a, h3 a")
        if link: name = link.get_text(" ", strip=True)
        for i, t in enumerate(toks[:-1]):
            k = LABELS.get(t.lower())
            if k: f.setdefault(k, toks[i + 1])
        if not name and "number" in f:
            j = toks.index(f["number"]) if f["number"] in toks else -1
            if j >= 0 and j + 1 < len(toks): name = toks[j + 1]
        if not name or not f.get("pos"): continue
        players.append(_player(f.get("number", ""), name, f.get("pos", ""), f.get("ht", ""), f.get("wt", ""), f.get("class", ""), f.get("hometown", ""), f.get("prev", "")))
    return players

def parse_staff_tables(soup, only_football: bool = False) -> list[dict]:
    """Tables with Name + Title (+ Email) columns. One-cell rows are department headers (classic /staff.aspx)."""
    staff = []
    for table in soup.select("table"):
        hdr = _header(table); h = [x.lower() for x in hdr]
        if not any(x == "name" or x.endswith(" name") for x in h) or not any("title" in x or "position" in x for x in h): continue
        if any(re.search(r"^pos|^ht|height", x) for x in h): continue  # that's a roster table
        ix = {k: next((i for i, x in enumerate(h) if re.search(rx, x)), None) for k, rx in (("name", r"name"), ("title", r"title|position"), ("email", r"e-?mail"), ("phone", r"phone"))}
        section = hdr[0] if hdr and hdr[0].lower() not in ("name", "image", "") and not re.search(r"name|title", hdr[0].lower()) else ""
        dept = section
        for tr in (table.select("tbody tr") or table.select("tr")[1:]):
            c = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if len(c) == 1 and c[0]:
                dept = c[0]; continue
            off = len(hdr) - len(c) if 0 < len(hdr) - len(c) <= 1 else 0
            g = lambda k: (c[ix[k] - off] if ix.get(k) is not None and 0 <= ix[k] - off < len(c) else "")
            name, title = g("name"), g("title")
            if not name or len(name) > 60: continue
            em = EMAIL.search(g("email") or "")
            if not em:
                a = tr.select_one("a[href^='mailto:']"); em = EMAIL.search(a["href"]) if a else None
            if not em:  # classic Sidearm /staff.aspx obfuscation: var firstHalf = "tnix"; var secondHalf = "tarleton.edu"
                sc = " ".join(x.get_text() for x in tr.select("script"))
                m1 = re.search(r'firstHalf\s*=\s*"([^"]+)"', sc); m2 = re.search(r'secondHalf\s*=\s*"([^"]+)"', sc)
                if m1 and m2: em = EMAIL.search(f"{m1.group(1)}@{m2.group(1)}")
            if only_football and dept and not re.search(r"football", dept, re.I): continue
            staff.append({"name": name, "title": title, "email": em.group(0).lower() if em else "", "phone": g("phone"),
                          "role": classify_title(title), "section": dept})
    return staff

def parse_staff_headerless(soup, only_football: bool = False) -> list[dict]:
    """Tables with no usable header whose rows read name | title | email | phone (classic coaches pages)."""
    staff = []
    for table in soup.select("table"):
        hdr = [x.lower() for x in _header(table)]
        if any("name" in x for x in hdr) and any("title" in x for x in hdr): continue   # handled by parse_staff_tables
        rows = table.select("tr"); hits = []
        dept = ""
        for tr in rows:
            cells = tr.find_all(["td", "th"]); c = [x.get_text(" ", strip=True) for x in cells]
            if len(c) == 1 and c[0]: dept = c[0]; continue
            if len(c) < 3: continue
            a = tr.select_one("a[href^='mailto:']"); em = EMAIL.search(a["href"]) if a else None
            if not em:
                sc = " ".join(x.get_text() for x in tr.select("script"))
                m1 = re.search(r'firstHalf\s*=\s*"([^"]+)"', sc); m2 = re.search(r'secondHalf\s*=\s*"([^"]+)"', sc)
                if m1 and m2: em = EMAIL.search(f"{m1.group(1)}@{m2.group(1)}")
            if not em: em = next((EMAIL.search(x) for x in c if EMAIL.search(x)), None)
            text = [x for x in c if x and not EMAIL.search(x) and not PHONE.search(x) and not re.match(r"^@\w+$", x)]
            if len(text) < 2 or len(text[0]) > 60: continue
            hits.append({"name": text[0], "title": text[1], "email": em.group(0).lower() if em else "", "phone": "", "role": classify_title(text[1]), "section": dept})
        if hits and sum(1 for h in hits if h["email"]) >= 2:
            staff += [h for h in hits if not (only_football and h["section"] and not re.search(r"football", h["section"], re.I))]
    return staff

def parse_staff_wmt(soup) -> list[dict]:
    staff = []
    for row in soup.select(".staff-directory-table-member-position"):
        name = row.select_one(".staff-directory-table-member-position__name"); title = row.select_one(".staff-directory-table-member-position__position")
        emc = row.select_one(".staff-directory-table-member-position__email")
        em = None
        if emc:
            em = EMAIL.search(emc.get_text(" ", strip=True))
            a = emc.select_one("a[href^='mailto:']")
            if not em and a: em = EMAIL.search(a["href"])
        if not name: continue
        t = title.get_text(" ", strip=True) if title else ""
        staff.append({"name": name.get_text(" ", strip=True), "title": t, "email": em.group(0).lower() if em else "", "phone": "", "role": classify_title(t), "section": "Football"})
    return staff

def parse_staff_cards(soup, only_football: bool = False) -> list[dict]:
    """Card layouts: classic Sidearm coach cards (.sidearm-coaches-coach, /sports/football/coaches), classic staff directory
    members (.sidearm-staff-member grouped by .sidearm-staff-category), roster-page coach cards (.sidearm-roster-coach),
    NextGen list cards (.s-person-card--list). Card text reads: name | title | email | phone."""
    staff = []
    for card in soup.select(".sidearm-coaches-coach, .sidearm-staff-member, .sidearm-roster-coach, .s-person-card--list, .staff-member, .coach-card"):
        toks = [t.strip() for t in card.get_text(" | ", strip=True).split(" | ") if t.strip()]
        if not toks: continue
        a = card.select_one("a[href^='mailto:']")
        em = EMAIL.search(a["href"]) if a else EMAIL.search(card.get_text(" "))
        if not em:
            sc = " ".join(x.get_text() for x in card.select("script"))
            m1 = re.search(r'firstHalf\s*=\s*"([^"]+)"', sc); m2 = re.search(r'secondHalf\s*=\s*"([^"]+)"', sc)
            if m1 and m2: em = EMAIL.search(f"{m1.group(1)}@{m2.group(1)}")
        name_el = card.select_one(".sidearm-coaches-coach-name, .sidearm-staff-member-name, .sidearm-roster-coach-name, [class*='person-link'], h3 a, h3, h4, .name")
        name = name_el.get_text(" ", strip=True) if name_el else toks[0]
        title_el = card.select_one(".sidearm-coaches-coach-title, .sidearm-staff-member-title, .sidearm-roster-coach-title, [class*='title'], .position")
        title = title_el.get_text(" ", strip=True) if title_el else ""
        if not title:
            rest = [t for t in toks if t != name and not EMAIL.search(t) and not PHONE.search(t) and not re.match(r"^(full bio|bio|email|phone|twitter|x|instagram)$", t, re.I)]
            title = rest[0] if rest else ""
        if not name or len(name) > 60 or EMAIL.search(name): continue
        cat = card.find_previous(class_=re.compile(r"sidearm-staff-category|staff-category|category-title")) if "sidearm-staff-member" in " ".join(card.get("class", [])) else None
        section = cat.get_text(" ", strip=True) if cat else ("Coaching Staff" if "coach" in " ".join(card.get("class", [])) else "")
        if only_football and section and not re.search(r"football", section, re.I): continue
        staff.append({"name": name, "title": title, "email": em.group(0).lower() if em else "", "phone": "", "role": classify_title(title), "section": section})
    return staff


# ---------------- WMT / Nuxt SSR payload (Auburn, Clemson, Arizona State, ...) ----------------
def _devalue(data):
    """Resolve a Nuxt 3 devalue payload (JSON array; object/array members are indices into the array)."""
    cache = {}
    def res(v, depth=0):
        if depth > 6: return None
        if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < len(data):
            if v in cache: return cache[v]
            cache[v] = None
            out = res(data[v], depth + 1) if isinstance(data[v], (dict, list)) else data[v]
            cache[v] = out; return out
        if isinstance(v, dict): return {k: res(x, depth + 1) for k, x in v.items()}
        if isinstance(v, list): return [res(x, depth + 1) for x in v]
        return v
    return res

def parse_nuxt_payload(html: str) -> tuple[list[dict], list[dict]]:
    m = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m: return [], []
    try: data = json.loads(m.group(1))
    except ValueError: return [], []
    if not isinstance(data, list): return [], []
    res = _devalue(data)
    players, staff, seen = [], [], set()
    for i, v in enumerate(data):
        if not isinstance(v, dict): continue
        if "first_name" in v and "height_feet" in v:
            d = res(i)
            if not isinstance(d, dict): continue
            name = d.get("full_name") or f"{d.get('first_name', '')} {d.get('last_name', '')}".strip()
            if not name or name in seen: continue
            seen.add(name)
            pos = d.get("player_position") or {}; cls = d.get("class_level") or {}
            pos_s = (pos.get("abbreviation") or pos.get("name") or "") if isinstance(pos, dict) else ""
            cls_s = (cls.get("abbreviation") or cls.get("name") or "") if isinstance(cls, dict) else ""
            hf, hi = d.get("height_feet"), d.get("height_inches")
            ht = f"{hf}-{hi}" if isinstance(hf, int) and isinstance(hi, int) else ""
            players.append(_player(str(d.get("jersey_number_label") or d.get("jersey_number") or ""), name, pos_s, ht, str(d.get("weight") or ""), cls_s,
                                   d.get("hometown") or "", d.get("high_school") or d.get("previous_school") or ""))
        elif "first_name" in v and "position" in v and "height_feet" not in v:
            d = res(i)
            if not isinstance(d, dict): continue
            name = f"{d.get('first_name', '')} {d.get('last_name', '')}".strip(); title = d.get("position") or ""
            if not name or (name, title) in seen: continue
            seen.add((name, title))
            staff.append({"name": name, "title": title, "email": (d.get("email") or "").lower(), "phone": d.get("phone") or "", "role": classify_title(title), "section": "Staff"})
    return players, staff

def dedupe(players):
    seen, out = set(), []
    for p in players:
        k = (p["name"].lower(), p["pos"], p["number"])
        if k in seen: continue
        seen.add(k); out.append(p)
    return out

def dedupe_staff(staff):
    seen, out = set(), []
    for s in staff:
        k = (s["name"].lower(), s["title"].lower())
        if k in seen: continue
        seen.add(k); out.append(s)
    return out

def parse(html: str, school: str = "", source_url: str = "") -> dict:
    soup = BeautifulSoup(html, "lxml")
    panel = soup.select_one("#tablePanel")
    players = parse_roster_tables(panel) if panel else []
    if not players: players = parse_roster_tables(soup)
    if not players: players = parse_roster_cards(soup)
    nuxt_staff = []
    if not players and "__NUXT_DATA__" in html:
        players, nuxt_staff = parse_nuxt_payload(html)
    players = dedupe(players)
    if players and not any(p["height_in"] for p in players):
        by_name = {c["name"].lower(): c for c in parse_roster_cards(soup)}
        for p in players:
            c = by_name.get(p["name"].lower())
            if c:
                p["height_in"] = p["height_in"] or c["height_in"]; p["weight_lb"] = p["weight_lb"] or c["weight_lb"]
                p["class"] = p["class"] or c["class"]; p["hometown"] = p["hometown"] or c["hometown"]; p["previous_school"] = p["previous_school"] or c["previous_school"]
    staff = parse_staff_tables(panel if panel else soup)
    if not staff: staff = parse_staff_wmt(soup) or parse_staff_cards(soup) or nuxt_staff
    return {"school": school, "source_url": source_url, "scraped_at": datetime.date.today().isoformat(),
            "players": players, "staff": dedupe_staff(staff), "needs": derive_needs(players), "footprint": footprint(players)}

def parse_staff_page(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    s = parse_staff_tables(soup, only_football=True)
    if not s: s = parse_staff_wmt(soup)
    if not s: s = parse_staff_cards(soup, only_football=True)
    if not s or not any(x["email"] for x in s): s = parse_staff_headerless(soup, only_football=True) or s
    return dedupe_staff(s)

def derive_needs(players: list[dict]) -> dict:
    """Per position group: roster count by class, projected openings by HS class year, measurables band."""
    out = {}
    by = defaultdict(list)
    for p in players: by[p["pos_group"]].append(p)
    year = datetime.date.today().year
    for g, ps in sorted(by.items()):
        classes = Counter(p["class"] for p in ps)
        left = [SEASONS_LEFT.get(p["class"], 1) for p in ps]
        openings = {str(year + k + 1): sum(1 for s in left if s <= k) for k in range(0, 3)}
        hts = [p["height_in"] for p in ps if p["height_in"]]; wts = [p["weight_lb"] for p in ps if p["weight_lb"]]
        out[g] = {"count": len(ps), "by_class": dict(classes), "openings_by_hs_class": openings,
                  "class_known": sum(1 for p in ps if p["class"]),
                  "height_in": {"min": min(hts), "avg": round(sum(hts) / len(hts), 1), "max": max(hts)} if hts else None,
                  "weight_lb": {"min": min(wts), "avg": round(sum(wts) / len(wts), 1), "max": max(wts)} if wts else None}
    return out

TEXAS_RX = re.compile(r"\btexas\b|\bTX\b|\bTex\.", re.I)


def is_texas(home: str) -> bool:
    return bool(TEXAS_RX.search(home or ""))


def is_dfw(home: str) -> bool:
    """DFW only when the hometown is in Texas and its city part (before the first comma) is a DFW city.
    Without the Texas check 'Dallas, Ga.', 'Allen, Okla.' or 'Princeton, N.J.' were counted as DFW."""
    return is_texas(home) and bool(TX_METRO_DFW.search((home or "").split(",")[0]))


def footprint(players: list[dict]) -> dict:
    states = Counter(); dfw = 0; tx = 0
    for p in players:
        home = p.get("hometown", "")
        st = home.split(",")[-1].strip() if "," in home else ""
        if st: states[st] += 1
        if is_texas(home): tx += 1
        if is_dfw(home): dfw += 1
    return {"total": len(players), "texas": tx, "dfw": dfw, "top_states": states.most_common(8)}

if __name__ == "__main__":
    html = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="ignore")
    res = parse(html, school=sys.argv[2] if len(sys.argv) > 2 else "")
    print(json.dumps({"players": len(res["players"]), "staff": len(res["staff"]), "footprint": res["footprint"],
                      "needs": {k: v for k, v in res["needs"].items() if k == "QB"},
                      "recruiting_staff": [s for s in res["staff"] if s["role"] in ("recruiting_coordinator", "player_personnel", "qb_coach", "head_coach")]},
                     indent=1))
