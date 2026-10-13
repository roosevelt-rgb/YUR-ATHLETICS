"""Seed recruit/ledger.db from the D1/D2 QB coach tracker (TSV export of the QB coach tracker spreadsheet).
Idempotent: re-running wipes and rebuilds the tracker-sourced rows only."""
import csv, re, sqlite3, sys, pathlib, datetime
HERE = pathlib.Path(__file__).resolve().parent
DB = HERE / "ledger.db"
SEED = HERE / "data" / "tracker_seed_2026-10-10.tsv"
EMAIL = re.compile(r"[\w.'+-]+@[\w.-]+\.\w+")
DATE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
TX = re.compile(r"texas|houston|rice university|southern methodist|baylor|tarleton|abilene christian|sam houston|lamar university|prairie view|utsa|utep|rio grande|angelo state|west texas|midwestern|kingsville|lubbock christian|permian basin|st\. mary's university|saint edward's|texas woman|a&m international|dallas baptist", re.I)
SCHEMA = """
CREATE TABLE IF NOT EXISTS schools(
  id INTEGER PRIMARY KEY, division TEXT, subdivision TEXT, name TEXT UNIQUE, state TEXT, conference TEXT,
  athletics_domain TEXT, staff_url TEXT, is_texas INTEGER DEFAULT 0, tracker_notes TEXT, status TEXT DEFAULT 'open');
CREATE TABLE IF NOT EXISTS contacts(
  id INTEGER PRIMARY KEY, school_id INTEGER REFERENCES schools(id), role TEXT, name TEXT, title TEXT,
  email TEXT, phone TEXT, twitter TEXT, recruiting_area TEXT, source TEXT, source_url TEXT,
  verified_at TEXT, email_status TEXT DEFAULT 'unknown', UNIQUE(school_id, role, name, email));
CREATE TABLE IF NOT EXISTS touches(
  id INTEGER PRIMARY KEY, school_id INTEGER REFERENCES schools(id), contact_id INTEGER, channel TEXT,
  direction TEXT, at TEXT, subject TEXT, draft_id TEXT, message_id TEXT, note TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS ix_contacts_school ON contacts(school_id);
CREATE INDEX IF NOT EXISTS ix_touches_school ON touches(school_id);
"""
def iso(m):
    mo, d, y = (int(x) for x in m.groups()); return datetime.date(y, mo, d).isoformat()
def main():
    rows = list(csv.reader(open(SEED, encoding="utf-8"), delimiter="\t"))
    data = [r + [""] * (11 - len(r)) for r in rows[1:] if any(c.strip() for c in r)]
    con = sqlite3.connect(DB); con.executescript(SCHEMA)
    con.execute("DELETE FROM touches WHERE source='tracker'"); con.execute("DELETE FROM contacts WHERE source='tracker'")
    n_s = n_c = n_t = n_b = 0; seen = set()
    for r in data:
        div, school, qb, qbe, rc, rce, emailed, dm, follows, resp, notes = [c.strip() for c in r[:11]]
        if school in seen:  # duplicate row in sheet (San Francisco State twice); keep first
            continue
        seen.add(school)
        # Maine row has the email and date merged into one cell
        if rce and DATE.search(rce) and EMAIL.search(rce):
            m = DATE.search(rce); emailed = emailed or m.group(0); rce = rce[:m.start()]
        con.execute("INSERT OR IGNORE INTO schools(division,name,is_texas,tracker_notes) VALUES(?,?,?,?)",
                    (div, school, 1 if TX.search(school) else 0, notes))
        con.execute("UPDATE schools SET division=?, is_texas=?, tracker_notes=? WHERE name=?",
                    (div, 1 if TX.search(school) else 0, notes, school))
        sid = con.execute("SELECT id FROM schools WHERE name=?", (school,)).fetchone()[0]; n_s += 1
        low = notes.lower()
        both_bounced = "both emails returned" in low or "emails returned" in low
        def add(role, name, email):
            nonlocal n_c, n_b
            if not (name or email): return None
            e = EMAIL.search(email or ""); e = e.group(0).lower() if e else ""
            status = "unknown"
            if e:
                last = (name.split()[-1].lower() if name else "")
                if both_bounced or (last and re.search(r"coach\s+" + re.escape(last) + r".*(returned|rejected)", low)) \
                   or (role == "qb_coach" and not rc and re.search(r"email (returned|rejected|retuurned)", low)):
                    status = "bounced"; n_b += 1
            con.execute("INSERT OR IGNORE INTO contacts(school_id,role,name,email,source,verified_at,email_status) VALUES(?,?,?,?,?,?,?)",
                        (sid, role, name, e, "tracker", "2026-08-09", status)); n_c += 1
            return con.execute("SELECT id FROM contacts WHERE school_id=? AND role=? AND name=? AND email=?", (sid, role, name, e)).fetchone()[0]
        add("qb_coach", qb, qbe); add("recruiting_coordinator", rc, rce)
        for col, chan in ((emailed, "email"), (dm, "dm")):
            m = DATE.search(col)
            if m:
                con.execute("INSERT INTO touches(school_id,channel,direction,at,note,source) VALUES(?,?,?,?,?,?)",
                            (sid, chan, "out", iso(m), "from tracker sheet", "tracker")); n_t += 1
        if follows.lower() == "yes":
            con.execute("INSERT INTO touches(school_id,channel,direction,at,note,source) VALUES(?,?,?,?,?,?)",
                        (sid, "follow", "in", None, "coach follows back (tracker)", "tracker")); n_t += 1
        m = DATE.search(resp)
        if m:
            con.execute("INSERT INTO touches(school_id,channel,direction,at,note,source) VALUES(?,?,?,?,?,?)",
                        (sid, "email", "in", iso(m), notes, "tracker")); n_t += 1
            con.execute("UPDATE schools SET status='responded' WHERE id=?", (sid,))
    con.commit()
    print(f"schools={n_s} contacts={n_c} touches={n_t} bounced_flagged={n_b}")
    for row in con.execute("""SELECT s.division, COUNT(*), SUM(EXISTS(SELECT 1 FROM contacts c WHERE c.school_id=s.id AND c.email<>'')),
        SUM(EXISTS(SELECT 1 FROM touches t WHERE t.school_id=s.id AND t.channel='email' AND t.direction='out')),
        SUM(NOT EXISTS(SELECT 1 FROM contacts c WHERE c.school_id=s.id)) FROM schools s GROUP BY s.division"""):
        print("  div=%s schools=%d with_email=%d emailed=%d no_contacts=%d" % row)
    print("  texas schools:", con.execute("SELECT COUNT(*) FROM schools WHERE is_texas=1").fetchone()[0])
    print("  bounced contacts:", con.execute("SELECT COUNT(*) FROM contacts WHERE email_status='bounced'").fetchone()[0])
    print("  responded:", con.execute("SELECT name, tracker_notes FROM schools WHERE status='responded'").fetchall())
if __name__ == "__main__":
    main()
