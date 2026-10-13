# Gridiron Scout recruiting engine (`recruit/`)

The data engine behind **Gridiron Scout**: every NCAA football program's roster, staff and derived needs, every Texas
UIL high-school program, and an outreach ledger for the athlete the workspace serves. Everything here is deterministic
Python over public pages; no LLM is in the data path. The agent in `agent/` adds advisory film notes and outreach
drafts on top, and sends nothing.

Everything these scripts write (`ledger.db`, `cache/`, `data/`) stays on your machine and out of git; see
[`data/README.md`](data/README.md).

## Pipeline (run from this folder, `python -P`)

| step | script                                                                             | what it does                                                                                                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `ingest_tracker.py`                                                                | seeds `ledger.db` from your own coach-tracker TSV (schools, QB coach and recruiting coordinator contacts, email/DM touches, bounces from Notes). Idempotent.                                                                                                                                                                                      |
| 2    | `ncaa_directory.py` then `ledger_fixup.py`                                         | loads the NCAA directory: official name, division, FBS/FCS, conference, state, **athletics website**; adds every program the tracker lacked; merges tracker rows NCAA names differently; marks tracker rows with no football program `no_football`.                                                                                               |
| 3    | `uil_alignment.py`                                                                 | parses the public UIL alignment PDF (`data/uil/Alpha_26-28.pdf`) into `hs_schools`.                                                                                                                                                                                                                                                               |
| 4    | `scrape_roster.py [--texas] [--division D1] [--force] [--refetch] [--names "A,B"]` | fetches each program's roster page (Sidearm NextGen / classic / WMT / PrestoSports), parses players and staff with `sidearm_parser.py`, discovers the staff page when the roster page has no emails, renders JS-only sites with headless Chromium, and stores players / staff / needs / footprint. 1 request per 2 s per host, cached, resumable. |
| 5    | `export_firestore.py`                                                              | writes the three seed files Gridiron Scout imports (`coaches.seed.json`, `colleges.seed.json`, `highschools.seed.json`) into `../src/data/` (git-ignored; the committed samples are in `../src/data/sample/`).                                                                                                                                    |
| 6    | `load_mongo.py` (or `refresh.ps1` = export + load)                                 | upserts the seeds and `data/athletes/*.json` into MongoDB db `gridiron` and reloads raw players, staff and touches from `ledger.db` when it exists.                                                                                                                                                                                               |

`match_programs.py` and `resolve_domains.py` are the earlier Wikipedia-based reference/domain steps; the NCAA directory
replaced them. `sidearm_parser.py` can be run on a saved page:
`python -P sidearm_parser.py cache/<host>/sports_football_roster.html "<School>"`.

## What the needs model computes (per program, per position group)

- **count** and **byClass** (FR/RFR/SO/RSO/JR/RJR/SR/RSR/GR) from the roster.
- **openingsByHsClass** = players whose eligibility ends before that high-school class's first season.
- **heightIn / weightLb min-avg-max** = the measurables band the program actually rosters.
- **footprint**: hometown counts (total, Texas, DFW metro, top states) = who really recruits the area. The DFW place
  lists are your local data (`data/dfw_cities.txt`, `data/dfw_school_prefixes.txt`; see `data/README.md`).
- **positionalNeeds[pos]** (0-1) = openings for the next class ÷ typical room size, which feeds the app's
  `MatchmakingEngine`.
- **staff**: every football staffer with title → role (`head_coach`, `recruiting_coordinator`, `player_personnel`,
  `qb_coach`, `oc`, `other`), email, source URL and date.

## Gridiron Scout pages fed by this

- `/coaches` Recruiting Staff: search plus division / state / role / status filters, bounce and "replied" badges, admin
  **Import ledger** button.
- `/needs` Who's Looking: position × HS class × division × state × height/weight × recruits-DFW; ranked by openings then
  DFW footprint.
- `/players` and `/player/:id`: the player card (identity, tiles, Board / Outreach log / Film / Stats / Agent tabs).
  Athlete source files are `data/athletes/<id>.json` (verified facts only; `load_mongo.py` upserts them). A fictional
  sample is in `data/sample/athletes/`.

## Database and API

- **MongoDB** (`MONGO_URL`, default `mongodb://localhost:27017`, db `gridiron`) is the serving store.
- **Express API** in `../server.ts` (same `npm run dev`, port 3000): `/api/health`,
  `/api/coaches?state=&division=&role=&status=&q=&limit=`, `/api/colleges?scraped=1&division=&state=`,
  `/api/highschools?dfw=1`, `/api/programs/:id/players`, `/api/athletes`, `/api/athletes/:id` and the per-athlete routes
  below. The `/api/athletes*` routes answer only on this computer.
- **Pages read the API first**, then Firestore (signed in), then the bundled seed JSON.

## MaxPreps

`maxpreps_sync.py` is a deterministic parser for the MaxPreps football stats page (one table per category, Year column);
it writes `athletes.stats` and `stats_history` with sourceUrl / fetchedAt / sha256. It needs `media.maxPrepsUrl` on the
athlete record.

## Agent loop and film evaluator (`agent/`)

Ported from earlier YUR projects (see `agent/__init__.py`):

- **Orchestration**: planner → stage-batched, dependency-gated scheduler → result store with provenance →
  synthesizer. Steps run through `llm.py` engines (only keys that answer).
- **Report format**: a six-section structured prompt rewritten for a QB: PRE-SNAP · DROP & FOOTWORK · POCKET & PRESSURE ·
  RELEASE & ARM · BALL PLACEMENT & DECISION · KEY ISSUES · DRILLS · SHOW COACHES.
- **Consensus**: median score, items agreed by 2+ engines first, confidence from score variance (`agent/consensus.py`),
  used when more than one engine key is live.
- **Display contract**: frames by point code, prime points with severity, top priorities, confidence, with football
  point codes S1 Pre-snap … S7 Result, rendered on the player card's Film tab.

Pipelines (`python -P agent/run.py --athlete <athlete-id> --pipeline film-evaluation|recruiting-outreach|all`):

- `film-evaluation`: plays from `REEL_ROOT/catalog.json` (default `data/reel/`, git-ignored) → per-play frame sheet →
  vision engine → note (sections, key issues, drills, prime points, scores, visibility limits) → season rollup →
  Mongo `film_notes` / `film_reports` / `athletes.filmSummary`, plus `data/film/<athlete>/`. Every note says what the
  frames do NOT show. Frame extraction (`agent/frames.py`) runs on a GPU/CPU pod, not on the desktop computer.
- `recruiting-outreach`: board (programs with QB openings for the athlete's class, Texas and DFW footprint, divisions
  from `preferences`; skips programs already emailed unless `--follow-up`, replied programs and bounced or unverified
  addresses) → one draft per program from verified facts only → guardrails (length, unverified numbers, hype words,
  single recipient, placeholders) → Mongo `drafts` (status draft | needs_review) + `agent_runs`. **Nothing is sent.**
  Approve in the Agent tab; sending needs a sender mailbox on the athlete record and a per-batch yes.
- Engines: `XAI_API_KEY` and **Ollama Cloud** (`OLLAMA_API_KEY`, `AGENT_OLLAMA_MODEL`); `AGENT_ENGINES=xai,ollama` pins
  the set and order; `XAI_MODEL`, `AGENT_OLLAMA_MODEL`, `OPENAI_MODEL`, `AGENT_MODEL`, `GEMINI_MODEL` pick models.
- `agent/qb_match.py`: deterministic program match for the athlete's class (`gradYear`); set `QB_MATCH_LOOKALIKE_MAX`
  (inches) near the athlete's height.

Gridiron Scout: `GET /api/athletes/:id/film-notes|drafts|runs`, `POST /api/athletes/:id/drafts/:draftId {status}`,
`POST /api/agent/run/:id {pipeline, limit, engines, followUp}` (spawns the runner; `GET /api/agent/jobs/:jobId` for the
log).

## Rules of the road

- Don't rebuild: wire into this ledger and the Gridiron Scout app. Tracker rows are never deleted; scrape rows are
  `source='scrape'`.
- Public pages only, polite rate, cache everything, record failures instead of guessing. No recruiting-service scraping.
- One-to-one email only; no CC lists of coaches; never send to a bounced or unverified address.
- Athlete data, contacts, film and the team's game data never enter git.

The season film-study scripts (box scores, play-by-play, staff tags, season reports, resume and coach brief builders)
are not part of this repository: they read a team's private game data. `package_rebuild` reports those steps as not
present and runs the rest.
