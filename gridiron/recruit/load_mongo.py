"""Load the Gridiron Scout seed exports (and raw players/staff) into local MongoDB: db `gridiron`.
Run after export_firestore.py. Upserts by id, so it is safe to re-run after every crawl.
  MONGO_URL env (default mongodb://localhost:27017)  — point at a RunPod-hosted Mongo later with the same script.
"""
import os, json, sqlite3, pathlib, datetime
from pymongo import MongoClient, UpdateOne, ASCENDING, TEXT
HERE = pathlib.Path(__file__).resolve().parent
DATA = pathlib.Path(__file__).resolve().parent.parent / "src" / "data"   # local exports; fictional samples in src/data/sample
def seed(name):
    return DATA / name if (DATA / name).exists() else DATA / "sample" / name
URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")

def upsert(col, docs, key="id"):
    if not docs: return 0
    ops = [UpdateOne({"_id": d[key]}, {"$set": {**d, "_id": d[key], "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}}, upsert=True) for d in docs]
    r = col.bulk_write(ops, ordered=False); return r.upserted_count + r.modified_count

def main():
    cl = MongoClient(URL, serverSelectionTimeoutMS=5000); db = cl["gridiron"]
    coaches = json.load(open(seed("coaches.seed.json"), encoding="utf-8"))["coaches"]
    colleges = json.load(open(seed("colleges.seed.json"), encoding="utf-8"))["colleges"]
    hs = json.load(open(seed("highschools.seed.json"), encoding="utf-8"))["highschools"]
    print("coaches:", upsert(db.coaches, coaches), "| colleges:", upsert(db.colleges, colleges), "| highschools:", upsert(db.highschools, hs))
    athletes = [json.load(open(f, encoding="utf-8")) for f in sorted((HERE / "data" / "athletes").glob("*.json"))]
    print("athletes:", upsert(db.athletes, athletes))
    # raw tables for deeper queries later (recruit/ledger.db exists once the pipeline has run)
    if not (HERE / "ledger.db").exists():
        print("no recruit/ledger.db yet: players, staff and touches load after the crawl (see recruit/README.md)")
        return finish(db)
    con = sqlite3.connect(HERE / "ledger.db", timeout=180); con.row_factory = sqlite3.Row
    players = [dict(r) | {"id": f"p{r['id']}"} for r in con.execute("SELECT p.*, s.name AS school FROM players p JOIN schools s ON s.id=p.school_id")]
    staff = [dict(r) | {"id": f"s{r['id']}"} for r in con.execute("SELECT t.*, s.name AS school FROM staff_scrape t JOIN schools s ON s.id=t.school_id")]
    touches = [dict(r) | {"id": f"t{r['id']}"} for r in con.execute("SELECT t.*, s.name AS school, s.division, s.subdivision, c.name AS contact_name, c.email AS contact_email, c.role AS contact_role FROM touches t JOIN schools s ON s.id=t.school_id LEFT JOIN contacts c ON c.id=t.contact_id")]
    # the outreach ledger belongs to GRIDIRON_ATHLETE, else to the one athlete record loaded above
    owner = os.environ.get("GRIDIRON_ATHLETE") or (athletes[0]["id"] if len(athletes) == 1 else "")
    db.touches.drop()
    if touches: db.touches.insert_many([{**t, "_id": t["id"], "athleteId": owner} for t in touches], ordered=False)
    db.players.drop(); db.staff.drop()
    if players: db.players.insert_many([{**p, "_id": p["id"]} for p in players], ordered=False)
    if staff: db.staff.insert_many([{**p, "_id": p["id"]} for p in staff], ordered=False)
    print("players:", db.players.count_documents({}), "| staff:", db.staff.count_documents({}), "| touches:", db.touches.count_documents({}))
    finish(db)


def finish(db):
    db.coaches.create_index([("college", ASCENDING)]); db.coaches.create_index([("state", ASCENDING), ("division", ASCENDING), ("role", ASCENDING)])
    db.coaches.create_index([("name", TEXT), ("college", TEXT), ("title", TEXT), ("email", TEXT)], name="coach_text")
    db.colleges.create_index([("metadata.division", ASCENDING), ("metadata.state", ASCENDING)]); db.colleges.create_index([("rosterProfile.scrapeStatus", ASCENDING)])
    db.highschools.create_index([("isDfw", ASCENDING), ("conference", ASCENDING)]); db.players.create_index([("school_id", ASCENDING), ("pos_group", ASCENDING)])
    print("db gridiron ready at", URL, "| collections:", sorted(db.list_collection_names()))

if __name__ == "__main__":
    main()
