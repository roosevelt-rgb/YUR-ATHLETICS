import express from "express";
import { createServer as createViteServer, loadEnv } from "vite";
import path from "path";
import { readFile, readdir, stat } from "fs/promises";
import { fileURLToPath } from "url";
import { MongoClient, Db } from "mongodb";
import { spawn } from "child_process";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  // PORT is only for a second, temporary instance; the desktop and the launchers expect 3000.
  const PORT = Number(process.env.PORT) || 3000;

  // The Gemini relay below takes a prompt plus up to 50,000 characters of fetched page HTML, so it gets a larger limit.
  app.use("/api/gemini", express.json({ limit: "1mb" }));
  app.use(express.json());

  // ---------------- Gridiron data API (MongoDB, db "gridiron"; loaded by recruit/load_mongo.py) ----------------
  const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017";
  let mongoDb: Db | null = null;
  const getDb = async (): Promise<Db | null> => {
    if (mongoDb) return mongoDb;
    try {
      const client = new MongoClient(MONGO_URL, {
        serverSelectionTimeoutMS: 3000,
      });
      await client.connect();
      mongoDb = client.db(process.env.MONGO_DB || "gridiron");
      console.log(`[Mongo] connected ${MONGO_URL}`);
      return mongoDb;
    } catch (e: any) {
      console.error("[Mongo] unavailable:", e.message);
      return null;
    }
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // The write routes answer only this app's own pages (Sec-Fetch-Site: same-origin) or non-browser callers, which send
  // no such header. A report opened in its sandbox (an opaque origin) or another site gets "cross-site" and is refused.
  const crossSiteWrite = (req: express.Request) => {
    const site = req.headers["sec-fetch-site"];
    return typeof site === "string" && site !== "same-origin";
  };
  const notThisApp = (res: express.Response) =>
    res
      .status(403)
      .json({ error: "writes are only taken from this app's pages" });

  // ---------------- Gemini relay (the profile helpers in src/App.tsx) ----------------
  // GEMINI_API_KEY is read here only (the environment, or .env / .env.local beside this file) and never reaches the page.
  const fileEnv = loadEnv(process.env.NODE_ENV === "production" ? "production" : "development", __dirname, "");
  app.post("/api/gemini/generate", async (req, res) => {
    if (crossSiteWrite(req)) return notThisApp(res);
    const key = process.env.GEMINI_API_KEY || fileEnv.GEMINI_API_KEY || "";
    if (!key)
      return res.status(503).json({ error: "GEMINI_API_KEY is not set for the Gridiron server (.env.local)." });
    const { model, contents, config } = req.body || {};
    if (typeof model !== "string" || !/^gemini-[\w.-]+$/.test(model) || contents == null)
      return res.status(400).json({ error: "model (gemini-*) and contents are required" });
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await ai.models.generateContent({ model, contents, config });
      res.json({ text: response.text ?? "" });
    } catch (e: any) {
      res.status(502).json({ error: String(e?.message || e).split(key).join("<key>").slice(0, 500) });
    }
  });

  app.get("/api/health", async (_req, res) => {
    const db = await getDb();
    if (!db) return res.json({ mongo: false });
    const [coaches, colleges, highschools, players] = await Promise.all([
      db.collection("coaches").countDocuments(),
      db.collection("colleges").countDocuments(),
      db.collection("highschools").countDocuments(),
      db.collection("players").countDocuments(),
    ]);
    res.json({ mongo: true, coaches, colleges, highschools, players });
  });

  app.get("/api/coaches", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const q: Record<string, unknown> = {};
    if (str(req.query.college)) q.college = str(req.query.college);
    if (str(req.query.state) && str(req.query.state) !== "ALL")
      q.state = str(req.query.state);
    if (str(req.query.division) && str(req.query.division) !== "ALL")
      q.division = str(req.query.division);
    if (str(req.query.role) && str(req.query.role) !== "ALL")
      q.role = str(req.query.role);
    if (str(req.query.status) === "bounced") q.emailStatus = "bounced";
    if (str(req.query.status) === "responded") q.schoolStatus = "responded";
    if (str(req.query.status) === "emailed") q.touches = { $gt: 0 };
    if (str(req.query.status) === "untouched") q.touches = { $in: [0, null] };
    const text = str(req.query.q).trim();
    if (text) {
      const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ name: rx }, { college: rx }, { title: rx }, { email: rx }];
    }
    const limit = Math.min(
      parseInt(str(req.query.limit) || "500", 10) || 500,
      5000,
    );
    const rows = await db
      .collection("coaches")
      .find(q, { projection: { _id: 0, updatedAt: 0 } })
      .sort({ isTexas: -1, college: 1, role: 1 })
      .limit(limit)
      .toArray();
    const total = await db.collection("coaches").countDocuments(q);
    res.json({ total, rows });
  });

  app.get("/api/colleges", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const q: Record<string, unknown> = {};
    if (str(req.query.scraped) === "1") q["rosterProfile.scrapeStatus"] = "ok";
    if (str(req.query.division) && str(req.query.division) !== "ALL")
      q["metadata.division"] = str(req.query.division);
    if (str(req.query.state) && str(req.query.state) !== "ALL")
      q["metadata.state"] = str(req.query.state);
    const rows = await db
      .collection("colleges")
      .find(q, { projection: { _id: 0, updatedAt: 0 } })
      .sort({ "metadata.name": 1 })
      .toArray();
    res.json({ total: rows.length, rows });
  });

  app.get("/api/highschools", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const q: Record<string, unknown> = {};
    if (str(req.query.dfw) === "1") q.isDfw = true;
    if (str(req.query.conference)) q.conference = str(req.query.conference);
    const rows = await db
      .collection("highschools")
      .find(q, { projection: { _id: 0, updatedAt: 0 } })
      .sort({ name: 1 })
      .toArray();
    res.json({ total: rows.length, rows });
  });

  app.get("/api/programs/:id/players", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const college = await db
      .collection("colleges")
      .findOne({ id: req.params.id }, { projection: { "metadata.name": 1 } });
    if (!college) return res.status(404).json({ error: "unknown program" });
    const rows = await db
      .collection("players")
      .find({ school: college.metadata.name }, { projection: { _id: 0 } })
      .sort({ pos_group: 1, number: 1 })
      .toArray();
    res.json({ total: rows.length, rows });
  });

  // Family-only fields stay out of the two athlete reads, which have no login: contacts (parent, head coach and their
  // emails) and agent (outreach settings, sender mailbox included). agent_runtime/gridiron_mcp.py drops the same two
  // from scout_athlete. The card's Agent tab reads its status line from here, so it shows the defaults (OFF, cadence
  // "—", last run "never") until it has a loopback-only status read of its own that leaves the mailbox out.
  const ATHLETE_PRIVATE_FIELDS = { contacts: 0, agent: 0 } as const;
  // Every /api/athletes read (list, record, card, outreach, film notes, drafts, runs, agent status) answers
  // this computer only, peer and Host both loopback, as /reports does: the 127.0.0.1 bind alone does not
  // stop another site's page from reading them through DNS rebinding. Writes keep their crossSiteWrite check.
  app.use("/api/athletes", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (isLocalRequest(req)) return next();
    res.status(403).json({ error: "athlete data is only served to this computer" });
  });
  app.get("/api/athletes", async (_req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const rows = await db
      .collection("athletes")
      .find(
        {},
        { projection: { _id: 0, updatedAt: 0, ...ATHLETE_PRIVATE_FIELDS } },
      )
      .sort({ name: 1 })
      .toArray();
    res.json({ total: rows.length, rows });
  });
  app.get("/api/athletes/:id", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const row = await db
      .collection("athletes")
      .findOne(
        { id: req.params.id },
        { projection: { _id: 0, ...ATHLETE_PRIVATE_FIELDS } },
      );
    if (!row) return res.status(404).json({ error: "unknown athlete" });
    res.json(row);
  });
  // The card's Agent panel status line, without the record's private fields: the outreach settings it shows,
  // with the sender mailbox reduced to whether one is set (the address is never sent). The player card can
  // read this in place of the agent field the two athlete reads above leave out.
  app.get("/api/athletes/:id/agent-status", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const row = await db
      .collection("athletes")
      .findOne({ id: req.params.id }, { projection: { _id: 0, agent: 1 } });
    if (!row) return res.status(404).json({ error: "unknown athlete" });
    const a = (row.agent && typeof row.agent === "object" ? row.agent : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 80) : null);
    res.set("Cache-Control", "no-store").json({
      enabled: a.enabled === true,
      cadence: str(a.cadence),
      maxSendsPerWeek: Number.isInteger(a.maxSendsPerWeek) ? a.maxSendsPerWeek : null,
      approvalMode: str(a.approvalMode),
      lastRun: str(a.lastRun),
      nextRun: str(a.nextRun),
      hasSenderMailbox: typeof a.senderMailbox === "string" && a.senderMailbox.trim().length > 0,
    });
  });
  // Trading-card payload, rebuilt from verified data by recruit/card_data.py (official stats, film study, highlights).
  app.get("/api/athletes/:id/card", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const row = await db
      .collection("athletes")
      .findOne({ id: req.params.id }, { projection: { _id: 0, card: 1 } });
    if (!row?.card)
      return res
        .status(404)
        .json({ error: "no card yet: run python -P recruit/card_data.py" });
    res.json(row.card);
  });
  app.get("/api/athletes/:id/outreach", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const rows = await db
      .collection("touches")
      .find({ athleteId: req.params.id }, { projection: { _id: 0 } })
      .sort({ at: -1 })
      .limit(2000)
      .toArray();
    res.json({ total: rows.length, rows });
  });

  // ---- per-athlete agent outputs (written by recruit/agent/*.py; advisory, nothing here sends email) ----
  app.get("/api/athletes/:id/film-notes", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const rows = await db
      .collection("film_notes")
      .find({ athleteId: req.params.id }, { projection: { _id: 0 } })
      .sort({ reelOrder: 1, playId: 1 })
      .toArray();
    const report = await db
      .collection("film_reports")
      .find({ athleteId: req.params.id }, { projection: { _id: 0 } })
      .sort({ generatedAt: -1 })
      .limit(1)
      .next();
    res.json({ total: rows.length, rows, report });
  });
  app.get("/api/athletes/:id/drafts", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const rows = await db
      .collection("drafts")
      .find({ athleteId: req.params.id }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(300)
      .toArray();
    res.json({ total: rows.length, rows });
  });
  app.get("/api/athletes/:id/runs", async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const rows = await db
      .collection("agent_runs")
      .find(
        { athleteId: req.params.id },
        { projection: { _id: 0, timeline: 0 } },
      )
      .sort({ startedAt: -1 })
      .limit(50)
      .toArray();
    res.json({ total: rows.length, rows });
  });
  app.post("/api/athletes/:id/drafts/:draftId", async (req, res) => {
    if (crossSiteWrite(req)) return notThisApp(res);
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "mongo unavailable" });
    const status = str(req.body?.status);
    if (!["draft", "approved", "rejected", "needs_review"].includes(status))
      return res.status(400).json({ error: "bad status" });
    const r = await db.collection("drafts").updateOne(
      { id: req.params.draftId, athleteId: req.params.id },
      {
        $set: {
          status,
          approvedAt: status === "approved" ? new Date().toISOString() : null,
        },
      },
    );
    res.json({ ok: r.matchedCount === 1 });
  });

  // ---- recruiting package + season film study files (written by recruit/*.py; read-only here) ----
  // The request names a report from this fixed list, never a path. The 2026 season files under games/ are the season
  // study of an athlete whose package is built (packages/<id>/card.json), the same rule as scout_season_study in
  // agent_runtime/scout_tools.py. The family film study is private and packages are not approved for coaches yet,
  // so these files are only served to this computer (loopback address and a loopback Host header, which also stops
  // DNS rebinding).
  const RECRUIT_DATA = path.join(__dirname, "recruit", "data");
  const ATHLETE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/; // agent_runtime/scout_tools.py ATHLETE_ID_RE
  type ReportType = "html" | "pdf" | "json";
  interface ReportSpec {
    title: string;
    type: ReportType;
    season?: boolean; // a 2026 season file under games/, not per athlete
    private?: boolean; // family only
    file?: (id: string) => string[]; // path parts under recruit/data
    match?: RegExp; // or: the newest file in packages/<id>/ with a matching name (written by another agent)
    noScript?: boolean; // html that the card sizes through a same-origin frame (the resume): no script runs in it
    fields?: string[]; // json keyed by game: serve only these fields of each game
  }
  const REPORTS: Record<string, ReportSpec> = {
    "film-study": {
      title: "2026 season film study (family copy)",
      type: "html",
      season: true,
      private: true,
      file: () => ["games", "season_2026_full_report.html"],
    },
    "coach-report": {
      title: "2026 film report (coach copy)",
      type: "html",
      season: true,
      file: () => ["games", "season_2026_coach_report.html"],
    },
    resume: {
      title: "Athletic resume",
      type: "html",
      noScript: true,
      file: (id) => ["packages", id, "athletic_resume.html"],
    },
    "coach-brief": {
      title: "Coach brief",
      type: "html",
      match: /^coach_brief[a-z0-9_-]*\.html$/i,
    },
    "coach-brief-pdf": {
      title: "Coach brief (PDF)",
      type: "pdf",
      match: /^coach_brief[a-z0-9_-]*\.pdf$/i,
    },
    "film-report": {
      title: "Full film report",
      type: "html",
      file: (id) => ["packages", id, "film_report_2026.html"],
    },
    highlights: {
      title: "Mid-season highlight order",
      type: "json",
      file: (id) => ["packages", id, "highlight_midseason_2026.json"],
    },
    "official-check": {
      title: "Official 2026 stat lines",
      type: "json",
      season: true,
      file: () => ["games", "season_2026_official_check.json"],
    },
    // the file also holds the family's film analysis (grades, verdicts, costly misses); the card shows only these
    "season-scores": {
      title: "2026 games: opponent, date and result",
      type: "json",
      season: true,
      file: () => ["games", "season_2026_scores.json"],
      fields: ["opponent", "date", "result"],
    },
  };
  const CONTENT_TYPES: Record<ReportType, string> = {
    html: "text/html; charset=utf-8",
    pdf: "application/pdf",
    json: "application/json; charset=utf-8",
  };
  const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
  const isLocalRequest = (req: express.Request) =>
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress || "",
    ) && LOOPBACK_HOST.test(req.headers.host || "");
  const notLocal = (res: express.Response) =>
    res.status(403).json({ error: "reports are only served to this computer" });
  const fileStat = async (p: string) => {
    try {
      const s = await stat(p);
      return s.isFile() ? s : null;
    } catch {
      return null;
    }
  };
  // a lowercase slug of an athlete that exists (recruit/data/athletes/<id>.json), else null
  const knownAthlete = async (raw: string) =>
    raw.length <= 64 &&
    ATHLETE_ID_RE.test(raw) &&
    (await fileStat(path.join(RECRUIT_DATA, "athletes", `${raw}.json`)))
      ? raw
      : null;
  const findReport = async (id: string, spec: ReportSpec) => {
    if (
      spec.season &&
      !(await fileStat(path.join(RECRUIT_DATA, "packages", id, "card.json")))
    )
      return null;
    let file: string | null = null;
    if (spec.file) file = path.join(RECRUIT_DATA, ...spec.file(id));
    else if (spec.match) {
      const dir = path.join(RECRUIT_DATA, "packages", id);
      let newest = 0;
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!spec.match.test(name)) continue;
        const s = await fileStat(path.join(dir, name));
        if (s && s.mtimeMs > newest) {
          newest = s.mtimeMs;
          file = path.join(dir, name);
        }
      }
    }
    if (!file || !file.startsWith(RECRUIT_DATA + path.sep)) return null;
    const s = await fileStat(file);
    return s ? { file, bytes: s.size, updatedAt: s.mtime.toISOString() } : null;
  };

  // which reports exist right now (names from the fixed list only; no directory listing)
  app.get("/api/athletes/:id/reports", async (req, res) => {
    if (!isLocalRequest(req)) return notLocal(res);
    const id = await knownAthlete(req.params.id);
    if (!id) return res.status(404).json({ error: "unknown athlete" });
    const reports = await Promise.all(
      Object.entries(REPORTS).map(async ([name, spec]) => {
        const f = await findReport(id, spec);
        return {
          name,
          title: spec.title,
          type: spec.type,
          private: !!spec.private,
          available: !!f,
          url: `/api/athletes/${id}/reports/${name}`,
          bytes: f?.bytes ?? null,
          updatedAt: f?.updatedAt ?? null,
        };
      }),
    );
    res.set("Cache-Control", "no-store").json({ athleteId: id, reports });
  });
  // one report, exactly as its generator wrote it (Film study, Resume and report, Highlights and Stats sections)
  app.get("/api/athletes/:id/reports/:name", async (req, res) => {
    if (!isLocalRequest(req)) return notLocal(res);
    const id = await knownAthlete(req.params.id);
    if (!id) return res.status(404).json({ error: "unknown athlete" });
    const spec = Object.hasOwn(REPORTS, req.params.name)
      ? REPORTS[req.params.name]
      : null;
    if (!spec)
      return res
        .status(404)
        .json({ error: "unknown report", reports: Object.keys(REPORTS) });
    const f = await findReport(id, spec);
    if (!f)
      return res.status(404).json({ error: `${spec.title}: not built yet` });
    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPES[spec.type],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      // An HTML report's own script runs in an opaque-origin sandbox, also when the report is opened as a full page,
      // so it cannot use this origin's routes. The resume is measured by the card through a same-origin frame, so it
      // keeps its origin and runs no script instead.
      "Content-Security-Policy": [
        "frame-ancestors 'self'",
        ...(spec.type !== "html"
          ? []
          : spec.noScript
            ? ["script-src 'none'", "object-src 'none'"]
            : ["sandbox allow-scripts"]),
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      ...(spec.type === "pdf"
        ? {
            "Content-Disposition": `inline; filename="${path.basename(f.file)}"`,
          }
        : {}),
    };
    if (spec.fields) {
      const keep = spec.fields;
      let games: Record<string, unknown>;
      try {
        games = JSON.parse(
          (await readFile(f.file, "utf8")).replace(/^\uFEFF/, ""),
        );
      } catch {
        return res.status(404).json({ error: `${spec.title}: not available` });
      }
      const out: Record<string, Record<string, unknown>> = {};
      for (const [code, g] of Object.entries(games || {}))
        if (g && typeof g === "object" && !Array.isArray(g))
          out[code] = Object.fromEntries(
            keep
              .filter((k) => Object.hasOwn(g, k))
              .map((k) => [k, (g as Record<string, unknown>)[k]]),
          );
      return res.set(headers).send(JSON.stringify(out));
    }
    res.sendFile(
      f.file,
      { cacheControl: false, headers },
      (err) => {
        if (err && !res.headersSent)
          res.status(404).json({ error: `${spec.title}: not available` });
      },
    );
  });
  // the rest of the season and any camps the family listed (athletes/<id>.package.json); no contacts or references
  app.get("/api/athletes/:id/schedule", async (req, res) => {
    if (!isLocalRequest(req)) return notLocal(res);
    const id = await knownAthlete(req.params.id);
    if (!id) return res.status(404).json({ error: "unknown athlete" });
    let pkg: Record<string, unknown> | null = null;
    try {
      const raw = await readFile(
        path.join(RECRUIT_DATA, "athletes", `${id}.package.json`),
        "utf8",
      );
      pkg = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      pkg = null;
    }
    if (!pkg)
      return res.status(404).json({ error: "no recruiting package yet" });
    res.set("Cache-Control", "no-store").json({
      remaining: Array.isArray(pkg.remaining_2026) ? pkg.remaining_2026 : [],
      source: str(pkg.remaining_source) || null,
      camps: Array.isArray(pkg.camps) ? pkg.camps : [],
    });
  });

  // agent jobs: spawn the python runner (recruit/agent/run.py). Pipelines: film-evaluation | recruiting-outreach | all.
  const AGENT_DIR = process.env.AGENT_DIR || path.join(__dirname, "recruit");
  interface AgentJob {
    id: string;
    athleteId: string;
    pipeline: string;
    startedAt: string;
    finishedAt?: string;
    status: string;
    log: string[];
    result?: unknown;
  }
  const jobs = new Map<string, AgentJob>();
  app.post("/api/agent/run/:id", (req, res) => {
    if (crossSiteWrite(req)) return notThisApp(res);
    const athleteId = req.params.id;
    if (!/^[a-z0-9-]{3,60}$/.test(athleteId))
      return res.status(400).json({ error: "bad athlete id" });
    if (
      [...jobs.values()].some(
        (j) => j.athleteId === athleteId && j.status === "running",
      )
    )
      return res
        .status(409)
        .json({ error: "a run is already in progress for this athlete" });
    const pipeline = ["film-evaluation", "recruiting-outreach", "all"].includes(
      str(req.body?.pipeline),
    )
      ? str(req.body.pipeline)
      : "all";
    const limit = Math.max(0, Math.min(200, Number(req.body?.limit) || 0));
    const engines = str(req.body?.engines).replace(/[^a-z,]/g, "");
    const args = [
      "-P",
      "agent/run.py",
      "--athlete",
      athleteId,
      "--pipeline",
      pipeline,
    ];
    if (limit) args.push("--limit", String(limit));
    if (engines) args.push("--engines", engines);
    if (req.body?.followUp) args.push("--follow-up");
    const job: AgentJob = {
      id: "job_" + Math.random().toString(36).slice(2, 10),
      athleteId,
      pipeline,
      startedAt: new Date().toISOString(),
      status: "running",
      log: [],
    };
    jobs.set(job.id, job);
    const child = spawn(process.env.PYTHON || "python", args, {
      cwd: AGENT_DIR,
      env: process.env,
    });
    const push = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim() || line.includes("SyntaxWarning")) continue;
        job.log.push(line.slice(0, 400));
        if (job.log.length > 400) job.log.shift();
      }
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.log.push("spawn error: " + e.message);
    });
    child.on("close", (code) => {
      job.status = code === 0 ? "done" : "failed";
      job.finishedAt = new Date().toISOString();
      const r = [...job.log].reverse().find((l) => l.startsWith("RESULT "));
      if (r) {
        try {
          job.result = JSON.parse(r.slice(7));
        } catch {
          /* keep log */
        }
      }
    });
    res.json({ jobId: job.id });
  });
  app.get("/api/agent/jobs/:jobId", (req, res) => {
    const j = jobs.get(req.params.jobId);
    if (!j) return res.status(404).json({ error: "unknown job" });
    res.json(j);
  });

  // Proxy route to fetch MaxPreps content. It fetches server-side, so it only goes to https MaxPreps hosts (every
  // redirect hop is checked too); any other URL would let a page on this origin reach other local services.
  const isMaxPrepsUrl = (u: URL) =>
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    u.port === "" &&
    (u.hostname === "maxpreps.com" || u.hostname.endsWith(".maxpreps.com"));
  app.get("/api/proxy/maxpreps", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return res.status(400).json({ error: "URL is not valid" });
    }
    if (!isMaxPrepsUrl(target)) {
      return res
        .status(400)
        .json({ error: "Only https://www.maxpreps.com pages can be fetched" });
    }

    console.log(`[Proxy] Attempting to fetch: ${url}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Sec-Ch-Ua":
          '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      };
      let response = await fetch(target, {
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
      for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
        const location = response.headers.get("location");
        const next = location ? new URL(location, target) : null;
        if (!next || hop >= 5 || !isMaxPrepsUrl(next)) {
          clearTimeout(timeoutId);
          return res.status(502).json({
            error: "MaxPreps redirected away from maxpreps.com",
            location: next ? next.origin : null,
          });
        }
        target = next;
        response.body?.cancel().catch(() => {});
        response = await fetch(target, {
          redirect: "manual",
          signal: controller.signal,
          headers,
        });
      }

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(
          `[Proxy] Upstream error: ${response.status} ${response.statusText} for ${url}`,
        );
        const errorText = await response.text().catch(() => "No error body");
        console.error(
          `[Proxy] Upstream error body: ${errorText.substring(0, 200)}`,
        );
        return res.status(response.status).json({
          error: `MaxPreps returned ${response.status}: ${response.statusText}`,
          details: errorText.substring(0, 200),
        });
      }

      const html = await response.text();
      console.log(
        `[Proxy] Successfully fetched ${html.length} bytes from ${url}`,
      );
      res.json({ html });
    } catch (error: any) {
      if (error.name === "AbortError") {
        console.error(`[Proxy] Timeout fetching ${url}`);
        return res.status(504).json({ error: "Request to MaxPreps timed out" });
      }
      console.error("[Proxy] Internal error:", error);
      res.status(500).json({
        error: "Failed to fetch profile content",
        message: error.message,
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // The /api/athletes* routes have no login yet (contacts, outreach history, agent drafts), so the dev server only
  // answers this machine. Set HOST=0.0.0.0 only behind real auth (e.g. Firebase ID-token middleware) for a deployment.
  const HOST = process.env.HOST || "127.0.0.1";
  app.listen(PORT, HOST, () => {
    console.log(
      `Server running on http://127.0.0.1:${PORT} (bound to ${HOST})`,
    );
  });
}

startServer();
