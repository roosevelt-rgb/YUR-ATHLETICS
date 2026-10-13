"""UIL 2026-28 realignment -> every Texas HS football program (conference, enrollment, football district, division, 11-man/6-man).
Source: data/uil/Alpha_26-28.pdf (http://www.uiltexas.org/files/alignments/Alpha_26-28.pdf), table-extracted with pdfplumber.
Writes data/uil_schools.csv and ledger table hs_schools. Region is derived from the district number per UIL bracket structure."""
import re, csv, sqlite3, pathlib, pdfplumber
import dfw_cities
HERE = pathlib.Path(__file__).resolve().parent; D = HERE / "data" / "uil"
PDF = D / "Alpha_26-28.pdf"; OUT = HERE / "data" / "uil_schools.csv"
DFW = dfw_cities.regex("^", dfw_cities.SCHOOL_PREFIXES)  # a school name that starts with a DFW place (local data, see dfw_cities.py)
def region(conf: str, dist: int, fb_div: str) -> str:
    if not dist: return ""
    per = 8 if conf == "6A" else 4            # 6A: 32 districts/4 regions; others: 16 per division
    return f"Region {((dist - 1) // per) + 1}"
def main():
    rows = []
    with pdfplumber.open(PDF) as pdf:
        for page in pdf.pages:
            for t in page.extract_tables():
                for r in t:
                    if not r or not r[0] or r[0].strip() == "School Name": continue
                    r = [(c or "").strip() for c in r] + [""] * (8 - len(r))
                    name, conf, enr, vb, bb, fb, div, typ = r[:8]
                    if not re.match(r"^[1-6]A$", conf): continue
                    rows.append({"school": name, "conference": conf, "enrollment": enr, "football_district": fb, "fb_div": div, "fb_type": typ,
                                 "plays_football": "yes" if typ and typ != "None" else "no",
                                 "region": region(conf, int(fb) if fb.isdigit() else 0, div),
                                 "is_dfw": "yes" if DFW.match(name) else "no"})
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    con = sqlite3.connect(HERE / "ledger.db", timeout=180)
    con.executescript("""CREATE TABLE IF NOT EXISTS hs_schools(id INTEGER PRIMARY KEY, school TEXT UNIQUE, conference TEXT, enrollment REAL,
        football_district INTEGER, fb_div TEXT, fb_type TEXT, plays_football INTEGER, region TEXT, is_dfw INTEGER, city TEXT, source TEXT, cycle TEXT);
        DELETE FROM hs_schools WHERE source='uil_alpha_26_28';""")
    for r in rows:
        con.execute("INSERT OR REPLACE INTO hs_schools(school,conference,enrollment,football_district,fb_div,fb_type,plays_football,region,is_dfw,source,cycle) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (r["school"], r["conference"], float(r["enrollment"]) if re.match(r"^\d+(\.\d+)?$", r["enrollment"]) else None,
                     int(r["football_district"]) if r["football_district"].isdigit() else None, r["fb_div"], r["fb_type"],
                     1 if r["plays_football"] == "yes" else 0, r["region"], 1 if r["is_dfw"] == "yes" else 0, "uil_alpha_26_28", "2026-28"))
    con.commit()
    from collections import Counter
    fb = [r for r in rows if r["plays_football"] == "yes"]
    print(f"UIL schools parsed: {len(rows)} | football programs: {len(fb)} | 11-man: {sum(1 for r in fb if r['fb_type']=='11-Man')} | 6-man: {sum(1 for r in fb if r['fb_type']=='6-Man')}")
    print(" by conference (football):", dict(sorted(Counter(r["conference"] for r in fb).items())))
    dfw = [r for r in fb if r["is_dfw"] == "yes"]
    print(f" DFW football programs (name-prefix match): {len(dfw)} | DFW 6A: {sum(1 for r in dfw if r['conference']=='6A')} | DFW 5A: {sum(1 for r in dfw if r['conference']=='5A')}")
    print("->", OUT)
if __name__ == "__main__":
    main()
