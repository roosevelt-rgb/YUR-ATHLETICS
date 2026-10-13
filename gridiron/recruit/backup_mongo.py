"""Snapshot the local `gridiron` Mongo db to gzipped JSON-lines, one file per collection (no mongodump needed).

usage:   python -P recruit/backup_mongo.py                 -> backups/gridiron_<UTC stamp>/<collection>.jsonl.gz
restore: python -P recruit/backup_mongo.py --restore backups/gridiron_<stamp>   (replaces each collection it finds)
Keeps the newest 10 snapshots. backups/ is git-ignored.
"""
from __future__ import annotations
import argparse, datetime, gzip, os, pathlib, shutil
from bson import json_util
from pymongo import MongoClient

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "backups"
db = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"), serverSelectionTimeoutMS=5000)[os.environ.get("MONGO_DB", "gridiron")]


def backup(keep: int = 10) -> pathlib.Path:
    d = OUT / ("gridiron_" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    d.mkdir(parents=True)
    for name in sorted(db.list_collection_names()):
        n = 0
        with gzip.open(d / f"{name}.jsonl.gz", "wt", encoding="utf-8") as f:
            for doc in db[name].find():
                f.write(json_util.dumps(doc) + "\n"); n += 1
        print(f"{name:<22} {n:>7}")
    snaps = sorted(p for p in OUT.glob("gridiron_*") if p.is_dir())
    for old in snaps[:-keep]:
        shutil.rmtree(old)
    return d


def restore(d: pathlib.Path) -> None:
    for f in sorted(d.glob("*.jsonl.gz")):
        name = f.name[:-len(".jsonl.gz")]
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            docs = [json_util.loads(line) for line in fh if line.strip()]
        db[name].drop()
        if docs:
            db[name].insert_many(docs)
        print(f"restored {name:<22} {len(docs):>7}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--restore", default="")
    a = ap.parse_args()
    if a.restore:
        restore(pathlib.Path(a.restore))
    else:
        print("snapshot:", backup())
