# Gridiron Scout

The recruiting workspace YUR Athletics shows in its side browser: the player card, film study, highlights, stats,
camps and schedule, the college board, coaches and outreach drafts. A React and Vite web app is served by an Express API
(`server.ts`) over MongoDB, on `http://127.0.0.1:3000` only. Franklin, the athlete's agent in the YUR Athletics
desktop, reaches it through the scout tools in `agent_runtime/`.

## Run (demo data)

Requirements: Node.js 22.12 or later, Python 3.11 or later, MongoDB on `mongodb://localhost:27017`, and Ollama for the
agent tools.

```powershell
npm ci
python -m pip install -r requirements.txt
New-Item -ItemType Directory -Force recruit\data\athletes | Out-Null
Copy-Item recruit\data\sample\athletes\*.json recruit\data\athletes\   # the fictional sample athlete
python -P recruit\load_mongo.py                                        # seeds + athletes -> MongoDB db "gridiron"
npm run dev                                                            # http://127.0.0.1:3000/player/quinn-placeholder
```

`Start Gridiron Scout.cmd` checks MongoDB and Ollama, copies the sample athlete on first run, starts the web app
and opens the YUR Athletics window from `../desktop`. `Stop Gridiron Scout.cmd` stops the web app and the scout agent.

Without your own data the app builds from the committed samples: `src/data/sample/*.seed.json` (fictional coaches,
colleges and high schools) and `firebase-applet-config.example.json` (a placeholder Firebase project). Your real files
(`src/data/*.seed.json`, `firebase-applet-config.json`) take their place when present and are git-ignored.

## Settings (environment variables, no values in the repo)

| variable                                                               | used by                                        | what it does                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `MONGO_URL`, `MONGO_DB`                                                | `server.ts`, `recruit/*.py`                    | MongoDB (default `mongodb://localhost:27017`, db `gridiron`)                  |
| `HOST`, `PORT`                                                         | `server.ts`                                    | listen address (default `127.0.0.1:3000`)                                     |
| `AGENT_DIR`, `PYTHON`                                                  | `server.ts`                                    | where the agent runner lives (default `recruit/`) and which Python runs it    |
| `GRIDIRON_ATHLETE`                                                     | `recruit/load_mongo.py`, launch                | the athlete id the outreach ledger belongs to and the page the launcher opens |
| `REEL_ROOT`                                                            | `recruit/agent/film_evaluator.py`, `frames.py` | reel catalog and frame sheets (default `recruit/data/reel`)                   |
| `XAI_API_KEY`, `OLLAMA_API_KEY`, `AGENT_OLLAMA_MODEL`, `AGENT_ENGINES` | `recruit/llm.py`, `recruit/agent/`             | model engines for film notes and drafts                                       |
| `SCOUT_ENGINE_DIR`, `SCOUT_MODEL`                                      | `agent_runtime/scout_harness.py`               | the agent-marketplace engine (`yur_harness`) and its model                    |
| `VITE_ADMIN_EMAIL`                                                     | `src/App.tsx`                                  | optional admin account for the Coaches import and the first-run seed          |
| `VITE_HUDL_TEAM_ID`                                                    | `src/App.tsx`                                  | optional Hudl team library for clip links; without it no Hudl link is shown   |
| `GEMINI_API_KEY`                                                       | `server.ts` (`/api/gemini/generate`)           | optional, for the profile helpers; read by the server only, never built into the page |

Put browser-side values (`VITE_*`) in `.env.local`. Firestore admins are users whose profile has `role: 'admin'`
(`firestore.rules`); set it in the Firebase console.

## Franklin's tools (MCP)

`agent_runtime/gridiron_mcp.py` serves the scout tools to the YUR Athletics desktop. Copy
`agent_runtime/yur_desktop/mcp_servers.example.json` to `mcp_servers.json` in the same folder and set the absolute
`python.exe` and `gridiron_mcp.py` paths; the desktop's `editions/athletics.json` must name the same command and
arguments. Read tools answer directly; every write tool (`draft_save`, `content_save`, `maxpreps_sync_now`,
`package_rebuild`) waits for the user's yes in the desktop. The MCP server leaves out `email_send`, `page_publish`
and the open-web browser tools, so Franklin cannot send email or change the athlete's public page. The separate
scout-agent harness (`agent_runtime/scout_harness.py`) keeps `email_send` behind a person's approval on every send.

## Layout

- `src/` the web app (`App.tsx`), `server.ts` the API and dev server, `firestore.rules` the Firestore rules.
- `recruit/` the data pipeline and the per-athlete agent (film evaluator, outreach drafts): see
  [`recruit/README.md`](recruit/README.md).
- `recruit/data/` local data only: see [`recruit/data/README.md`](recruit/data/README.md).
- `agent_runtime/` the scout tools, the MCP server and the scout-agent harness.
- `tests/` `python -B -m unittest discover -s tests`.
