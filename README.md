# YUR Athletics

**SUPER INTELLIGENT ANALYTICS FOR THE MODERN ATHLETE**

YUR Athletics is a desktop for one athlete and their family. **Franklin**, the athlete's own agent, works beside a
side browser that shows **Gridiron**, the athlete's recruiting workspace: the player card, film study, highlights,
stats, camps, the college board, coaches and outreach. Franklin reads those pages, explains them, and drafts the next
step. Nothing leaves the computer without a person saying yes.

This is **V1**. It holds two parts:

| folder      | what it is                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop/`  | The YUR AI Desktop (Electron) with the **Athletics edition**: the YUR Athletics brand, the launch page, the twelve sections, Franklin and Franklin's Gridiron tools. |
| `gridiron/` | **Gridiron Scout**: the web app (React and Vite, served by an Express API over MongoDB), the scout tools Franklin calls, and the recruiting data pipeline.           |

Brand: **YUR Athletics**. The logo set (lockups, Y mark, icons) is in
[`desktop/src/athletics-brand/brand/`](desktop/src/athletics-brand/brand).

## How the two halves fit

```
 YUR Athletics window (desktop/, YUR_EDITION=athletics)
 ┌──────────────────────────────┬─────────────────────────────────────────┐
 │ Franklin (the athlete's      │ side browser: the Gridiron sections      │
 │ agent, Ollama Cloud model)   │ http://127.0.0.1:3000/player/<id>?tab=…  │
 │                              │                                          │
 │ Gridiron tools over MCP ─────┼──► gridiron/agent_runtime/gridiron_mcp.py│
 └──────────────────────────────┴─────────────────────────────────────────┘
                                         │
                gridiron/server.ts (Express + Vite, 127.0.0.1:3000) ──► MongoDB (db "gridiron")
                                         ▲
                gridiron/recruit/ (Python pipeline: public rosters, staff, UIL list, MaxPreps, agent drafts)
```

- The edition manifest, `desktop/editions/athletics.json`, names the athlete (id, sport, position, class year), the
  Gridiron origin, the MCP server Franklin may start and the twelve sections. Nothing in the shell assumes one sport:
  the sport, position and throwing hand come from the manifest, so the same desktop serves any sport.
- The twelve sections: Franklin · My card · Film study · Highlights · Stats and MaxPreps · Camps and schedule ·
  Resume and report · College board · Coaches · Outreach and drafts · Approvals · Settings.
- On Gridiron's address the side browser refuses the `/api/` routes (they return raw records) and other athletes'
  pages; it opens this athlete's pages and the shared ones such as `/coaches`.

## Governance

- **Franklin asks first.** Every click, every piece of typing and every write that Franklin wants to make goes through a
  native confirmation dialog. Reading a page needs no dialog; acting on one always does.
- **Drafts never send.** The outreach pipeline writes drafts to Gridiron's Approvals and Outreach sections. No email,
  DM or post is sent by Franklin or by the pipeline; sending stays with the family.
- **Cloud models only in this edition.** Franklin runs on Ollama Cloud models (`:cloud` tags reached through the local
  Ollama daemon). The edition refuses a model that would run on the computer itself.
- **Local by default.** The web app, the API and the scout tools listen on `127.0.0.1` unless you change `HOST`.

## Run it

Requirements: Windows 10 or 11, **Node.js 24** (22.12 or later works), **Python 3.14** (3.11 or later works),
**Ollama** signed in for Ollama Cloud, and **MongoDB** for Gridiron. Run each block from the repository root.

### 1. Gridiron

```powershell
cd gridiron
npm ci
python -m pip install -r requirements.txt
# First run: start from the fictional sample athlete and sample seeds
New-Item -ItemType Directory -Force recruit\data\athletes | Out-Null
Copy-Item recruit\data\sample\athletes\*.json recruit\data\athletes\
python -P recruit\load_mongo.py          # loads the seeds and athletes into MongoDB (db "gridiron")
npm run dev                              # http://127.0.0.1:3000/player/quinn-placeholder
```

`Start Gridiron Scout.cmd` does the same start in one step (MongoDB check, Ollama, the web app and the YUR Athletics
window) and copies the sample athlete on first run. Settings are environment variables, documented in
[`gridiron/README.md`](gridiron/README.md).

### 2. The YUR Athletics desktop

```powershell
cd desktop
& ".\Setup YUR AI Desktop.cmd"           # npm ci + an isolated Python environment (.desktop-python)
copy editions\athletics.example.json editions\athletics.json
copy ..\gridiron\agent_runtime\yur_desktop\mcp_servers.example.json ..\gridiron\agent_runtime\yur_desktop\mcp_servers.json
```

Edit `editions\athletics.json` for your athlete and your machine. The schema is strict (`desktop/src/edition.js`):

- `athlete`: `id` (lower-case slug, the same id as the Gridiron athlete record), `sport`, `display_name`, `position`,
  `position_code`, `class_of`, and `throws` (`left` or `right`, optional).
- `gridiron_mcp.config_path`: the **absolute** path of Gridiron's MCP config, for example
  `C:\YUR-ATHLETICS\gridiron\agent_runtime\yur_desktop\mcp_servers.json`. Create it from
  `mcp_servers.example.json` in the same folder.
- `gridiron_mcp.command` and `args`: the absolute `python.exe` and the absolute path of
  `gridiron\agent_runtime\gridiron_mcp.py`. The MCP config's `gridiron-scout` entry must name the same command and
  arguments, or Franklin will not start the tools.
- Every tab `path` that starts with `/player/` uses the athlete id.

The example assumes this repository is cloned to `C:\YUR-ATHLETICS` and Python is at `C:\Python314\python.exe`.

Then double-click **`Start YUR AI Athletics.cmd`**. Franklin's default model is `ollama:deepseek-v4-pro:cloud`; set
`YUR_FRANKLIN_MODEL` to choose another Ollama Cloud model with tool calling.

### Tests

```powershell
cd desktop
node --test --test-concurrency=1 tests/*.test.js
python -B -m unittest discover -s tests -p "test_*.py"
```

The tests read the committed sample manifest (`desktop/tests/fixtures/athletics.sample.json`); they do not need
`editions/athletics.json`. Gridiron's own check: `cd gridiron && python -B -m unittest discover -s tests`.

## What is deliberately not in this repository

Athlete records describe real high-school athletes, who are usually minors. This repository ships the code and
fictional samples only. These stay on the machine that builds them and are blocked by the `.gitignore` files:

- **The athlete's data**: the edition manifest (`desktop/editions/athletics.json`), athlete records, recruiting
  packages, resumes, briefs, cards, film-study results, highlight orders and reports (`gridiron/recruit/data/`).
- **Family and coach contact details**: outreach drafts, the coach-tracker export, the contact ledger
  (`recruit/ledger.db`) and the real seed exports with coach emails and phone numbers (`gridiron/src/data/*.seed.json`).
- **The team's playbook and game data**: staff play-call and formation tags, game film, frames, play-by-play, season
  reports and the film-study workspace, plus the scripts that build them.
- **Accounts and machine state**: `.env` files and keys, the Firebase web config (`firebase-applet-config.json`; a
  placeholder `firebase-applet-config.example.json` ships), usage and billing ledgers, browser profiles, agent
  runtime state, the bundled Python runtime and local models, and build output.
- **The Hermes skill snapshot** (`desktop/integrations/hermes_skills/`): import your own with
  `desktop/scripts/import_hermes_skills.py`; the Hermes library stays empty until you do.

Gridiron builds and runs from the samples (`gridiron/src/data/sample/`, `gridiron/recruit/data/sample/`) until you
build your own data with the pipeline in [`gridiron/recruit/`](gridiron/recruit/README.md).
