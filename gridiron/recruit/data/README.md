# recruit/data (local only)

This folder holds the recruiting engine's working data, and **none of it is published**. Athlete records describe real
high-school athletes, who are usually minors, so the records and everything built from them stay on the machine that
makes them: recruiting packages, resumes, briefs and cards, game film and frames, film-study results and reports,
outreach drafts, coach-tracker exports with contact details, crawl outputs and logs. The `.gitignore` files ignore
everything here except this README and the fictional `sample/` folder, so files copied in later stay out of git too.

What ships, under `sample/`:

| file                                             | what it is                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sample/athletes/quinn-placeholder.json`         | a fictional athlete record (the shape `load_mongo.py` loads and `/api/athletes/:id` serves), with a `card` block so the player card renders |
| `sample/athletes/quinn-placeholder.package.json` | a fictional, empty recruiting package (the shape `/api/athletes/:id/schedule` reads)                                                        |

The sample athlete matches the desktop's `editions/athletics.example.json` (athlete id `quinn-placeholder`), so the
YUR Athletics side browser opens its pages.

## Run the demo

```powershell
New-Item -ItemType Directory -Force recruit\data\athletes | Out-Null
Copy-Item recruit\data\sample\athletes\*.json recruit\data\athletes\
python -P recruit\load_mongo.py      # sample seeds (src/data/sample) + data/athletes -> MongoDB db "gridiron"
npm run dev                          # http://127.0.0.1:3000/player/quinn-placeholder
```

`Start Gridiron Scout.cmd` copies the sample on first run (when `data/athletes/` has no records).

## Build your own data (all of it stays out of git)

- `ncaa_directory.py`, `scrape_roster.py`, `history_crawl.py` and `uil_alignment.py` crawl public pages into
  `recruit/ledger.db` and `recruit/data/`.
- `export_firestore.py` writes the real seed files to `src/data/*.seed.json`; `load_mongo.py` loads them.
- Add `data/athletes/<your-id>.json` in the same shape as the sample, and remove the sample record when you no longer
  want it in MongoDB.
- The film evaluator reads `data/reel/catalog.json` and its frame sheets (or the folder in `REEL_ROOT`).
- The DFW flags (`uil_alignment.py` for schools, `sidearm_parser.py` for roster hometowns) read
  `data/dfw_school_prefixes.txt` and `data/dfw_cities.txt`: your own lists of DFW metro place names, one per line
  (`#` starts a comment). Without them nothing is flagged DFW; see `dfw_cities.py`.
