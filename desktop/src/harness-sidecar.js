"use strict";

// Supervises the IntelliFlow coding harness engine (agent-marketplace
// engine/yur_harness: OrchestrationManager -> Candidate -> Validation -> Commit,
// approvals, audit ledger, Karma pack forge, catalog) as a private loopback
// sidecar of this Desktop. The engine stays its own product root; this module
// binds to it only through its HTTP contract.
// Packaged Desktop users may select that existing installation with
// YUR_HARNESS_ENGINE_ROOT; this adapter does not install or bundle the engine.
//
// Security posture:
// - binds 127.0.0.1 only, on a free port in a private range; gRPC is disabled
// - per-install random admin secret and Karma token, stored 0600 under userData
// - explicit YUR_ALLOWED_ROOTS (the engine treats an empty list as "anywhere")
// - only an allowlist of API paths can be proxied from the renderer
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { fetchPackSourceArchive, isPackDownloadPath } = require('./marketplace-export');

const PORT_RANGE = [8177, 8196];
const HEALTH_TIMEOUT_MS = 60000;
const LOG_LINES = 200;
const ALLOWED = [
  ["GET", /^\/api\/health$/],
  ["GET", /^\/api\/status$/],
  ["GET", /^\/api\/missions(\?.*)?$/],
  ["GET", /^\/api\/workspaces$/],
  ["POST", /^\/api\/workspaces\/open$/],
  // Read-only repository evidence uses the engine's scoped, redacted read tools.
  ["GET", /^\/api\/workspaces\/[A-Za-z0-9_-]{1,80}\/graph$/],
  ["GET", /^\/api\/workspaces\/[A-Za-z0-9_-]{1,80}\/file\?path=[A-Za-z0-9%._~-]+$/],
  ["GET", /^\/api\/tasks(\?.*)?$/],
  ["POST", /^\/api\/tasks$/],
  [
    "GET",
    /^\/api\/tasks\/[A-Za-z0-9_-]{1,80}(\/events(\?.*)?|\/certificate)?$/,
  ],
  ["POST", /^\/api\/tasks\/[A-Za-z0-9_-]{1,80}\/(pause|resume|cancel)$/],
  ["GET", /^\/api\/approvals(\?.*)?$/],
  ["POST", /^\/api\/approvals\/[A-Za-z0-9_-]{1,80}$/],
  ["GET", /^\/api\/inventory$/],
  ["GET", /^\/api\/packs$/],
  ["GET", /^\/api\/packs\/[A-Za-z0-9._:-]{1,128}$/],
  ["POST", /^\/api\/karma\/forge$/],
  ["GET", /^\/api\/authority\/log(\?.*)?$/],
];

function isAllowed(method, apiPath) {
  return (
    typeof apiPath === "string" &&
    apiPath.length <= 512 &&
    !apiPath.includes("..") &&
    ALLOWED.some(([verb, pattern]) => verb === method && pattern.test(apiPath))
  );
}

function engineDir(unifiedRoot, env = process.env) {
  const selected = env.YUR_HARNESS_ENGINE_ROOT === undefined
    ? path.join(unifiedRoot, "marketplace", "engine")
    : env.YUR_HARNESS_ENGINE_ROOT;
  return typeof selected === "string" && selected.trim() && !selected.includes("\0") && path.isAbsolute(selected)
    ? path.resolve(selected) : null;
}

function validEngine(directory) {
  try {
    return !!directory && fs.statSync(directory).isDirectory()
      && fs.statSync(path.join(directory, "yur_harness", "__main__.py")).isFile();
  } catch {
    return false;
  }
}

function runtimeGuidance(unifiedRoot) {
  let setupAvailable = false;
  try { setupAvailable = fs.statSync(path.join(unifiedRoot, "Setup YUR AI Unified.cmd")).isFile(); } catch {}
  return 'Select an existing Marketplace engine installation with YUR_HARNESS_ENGINE_ROOT. '
    + 'Python defaults to that engine\'s .venv; use YUR_HARNESS_PYTHON for another prepared harness environment.'
    + (setupAvailable ? ' For this source installation, run "Setup YUR AI Unified.cmd" to prepare its default engine environment.' : ' The Desktop package does not include this engine environment.');
}

function resolvePython(unifiedRoot, env = process.env) {
  const engine = engineDir(unifiedRoot, env);
  const candidates = [
    env.YUR_HARNESS_PYTHON,
    engine && path.join(
      engine,
      ".venv",
      process.platform === "win32" ? "Scripts\\python.exe" : "bin/python",
    ),
  ].filter(Boolean);
  return (
    candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) || null
  );
}

function loadLink(stateDir) {
  const file = path.join(stateDir, "link.json");
  try {
    const link = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof link.admin_password === "string" &&
      link.admin_password.length >= 24 &&
      typeof link.karma_token === "string"
    )
      return link;
  } catch {
    /* create below */
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const link = {
    admin_password: crypto.randomBytes(24).toString("base64url"),
    karma_token: crypto.randomBytes(24).toString("base64url"),
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(link), {
    encoding: "utf8",
    mode: 0o600,
  });
  return link;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function pickPort(preferred) {
  const ordered = [
    preferred,
    ...Array.from(
      { length: PORT_RANGE[1] - PORT_RANGE[0] + 1 },
      (_, i) => PORT_RANGE[0] + i,
    ),
  ].filter(Boolean);
  for (const port of [...new Set(ordered)])
    if (await portFree(port)) return port;
  throw new Error(
    `No free loopback port in ${PORT_RANGE[0]}-${PORT_RANGE[1]} for the IntelliFlow harness.`,
  );
}

function createHarnessSidecar({
  unifiedRoot,
  stateDir,
  getAllowedRoots = () => [],
  getOllama = () => ({}),
  environment = process.env,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  onState = () => {},
} = {}) {
  if (!unifiedRoot || !stateDir || typeof fetchImpl !== "function")
    throw new Error(
      "Harness sidecar requires the unified root, a state folder and fetch.",
    );
  let child = null,
    token = null,
    starting = null;
  const logs = [];
  const current = {
    state: "stopped",
    port: null,
    base: null,
    pid: null,
    error: null,
    python: null,
    engine_dir: engineDir(unifiedRoot, environment),
    started_at: null,
  };
  const status = () => ({ ...current, log_tail: logs.slice(-40) });
  const publish = () => {
    try {
      onState(status());
    } catch {
      /* observers cannot change the sidecar */
    }
  };
  const update = (fields) => {
    Object.assign(current, fields);
    publish();
  };
  const log = (line) => {
    logs.push(String(line).slice(0, 500));
    if (logs.length > LOG_LINES) logs.splice(0, logs.length - LOG_LINES);
  };

  async function raw(method, apiPath, body, headers = {}) {
    const response = await fetchImpl(`${current.base}${apiPath}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { detail: text.slice(0, 2000) };
    }
    return { status: response.status, data };
  }
  async function login(link) {
    const result = await raw("POST", "/api/auth/login", {
      username: "admin",
      password: link.admin_password,
    });
    if (result.status !== 200 || !result.data?.access_token)
      throw new Error(`Harness login failed (${result.status}).`);
    token = result.data.access_token;
  }
  async function waitHealthy(deadline) {
    while (Date.now() < deadline) {
      if (!child)
        throw new Error(
          "The IntelliFlow harness exited during startup. See its log.",
        );
      try {
        const result = await raw("GET", "/api/health");
        if (result.status === 200 && result.data?.ok) return result.data;
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      "The IntelliFlow harness did not become healthy within 60 seconds.",
    );
  }

  async function start() {
    if (current.state === "ready") return status();
    if (starting) return starting;
    starting = (async () => {
      const engine = engineDir(unifiedRoot, environment);
      if (!validEngine(engine)) {
        update({ state: "unavailable", python: null, engine_dir: engine,
          error: 'IntelliFlow harness engine must be an existing absolute directory containing yur_harness/__main__.py. ' + runtimeGuidance(unifiedRoot) });
        return status();
      }
      const python = resolvePython(unifiedRoot, environment);
      if (!python) {
        update({
          state: "unavailable",
          python: null,
          engine_dir: engine,
          error:
            'IntelliFlow harness Python environment not found. ' + runtimeGuidance(unifiedRoot),
        });
        return status();
      }
      try {
        const link = loadLink(stateDir);
        const port = await pickPort(link.port);
        if (link.port !== port) {
          link.port = port;
          fs.writeFileSync(
            path.join(stateDir, "link.json"),
            JSON.stringify(link),
            { encoding: "utf8", mode: 0o600 },
          );
        }
        const roots = [
          ...new Set(
            getAllowedRoots().filter(
              (root) => typeof root === "string" && path.isAbsolute(root),
            ),
          ),
        ];
        const ollama = getOllama() || {};
        const env = {
          ...environment,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONNOUSERSITE: "1",
          YUR_HOST: "127.0.0.1",
          YUR_PORT: String(port),
          YUR_GRPC_ENABLED: "false",
          YUR_DATA_DIR: path.join(stateDir, "data"),
          YUR_ADMIN_USER: "admin",
          YUR_ADMIN_PASSWORD: link.admin_password,
          YUR_KARMA_TOKEN: link.karma_token,
          YUR_ALLOWED_ROOTS:
            roots.join(process.platform === "win32" ? ";" : ":") || stateDir,
          YUR_DEFAULT_PROVIDER: "ollama",
          ...(ollama.url ? { OLLAMA_BASE_URL: ollama.url } : {}),
          ...(ollama.model
            ? { OLLAMA_MODEL: ollama.model, YUR_DEFAULT_MODEL: ollama.model }
            : {}),
        };
        // Never forward cloud keys implicitly; the harness uses the local Ollama provider by default.
        for (const key of [
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "YUR_COMPAT_API_KEY",
        ])
          delete env[key];
        update({
          state: "starting",
          port,
          base: `http://127.0.0.1:${port}`,
          error: null,
          python,
          engine_dir: engine,
          started_at: new Date().toISOString(),
        });
        child = spawnImpl(
          python,
          ["-B", "-m", "yur_harness", "serve", "--no-browser"],
          {
            cwd: engine,
            env,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        current.pid = child.pid ?? null;
        child.stdout?.on("data", (chunk) =>
          String(chunk)
            .split(/\r?\n/)
            .filter(Boolean)
            .forEach((line) =>
              log(line.replace(link.admin_password, "[redacted]")),
            ),
        );
        child.stderr?.on("data", (chunk) =>
          String(chunk)
            .split(/\r?\n/)
            .filter(Boolean)
            .forEach((line) =>
              log(line.replace(link.admin_password, "[redacted]")),
            ),
        );
        child.once("exit", (code) => {
          log(`[harness exited ${code}]`);
          child = null;
          token = null;
          if (current.state !== "stopped")
            update({
              state: "error",
              pid: null,
              error: `IntelliFlow harness exited (${code}).`,
            });
        });
        const health = await waitHealthy(Date.now() + HEALTH_TIMEOUT_MS);
        await login(link);
        update({
          state: "ready",
          health: {
            ready: health.ready,
            version: health.version,
            authority: health.authority,
          },
        });
      } catch (error) {
        update({
          state: "error",
          error: String(error.message || error).slice(0, 2000),
        });
        if (child) {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }
      }
      return status();
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function stop() {
    update({ state: "stopped", error: null });
    token = null;
    if (child) {
      const exiting = child;
      child = null;
      try {
        exiting.kill();
      } catch {
        /* already gone */
      }
    }
    update({ pid: null });
    return status();
  }

  async function request(method, apiPath, body) {
    method = String(method || "GET").toUpperCase();
    if (!isAllowed(method, apiPath))
      return {
        ok: false,
        error: {
          code: "HARNESS_PATH_DENIED",
          message: `The Desktop does not proxy ${method} ${String(apiPath).slice(0, 120)}.`,
        },
      };
    if (current.state !== "ready")
      return {
        ok: false,
        error: {
          code: "HARNESS_NOT_READY",
          message: current.error || "Start the IntelliFlow harness first.",
        },
      };
    const link = loadLink(stateDir);
    const headers = () => ({
      authorization: `Bearer ${token}`,
      "x-karma-token": link.karma_token,
    });
    try {
      let result = await raw(method, apiPath, body, headers());
      if (result.status === 401) {
        await login(link);
        result = await raw(method, apiPath, body, headers());
      }
      if (result.status >= 400)
        return {
          ok: false,
          error: {
            code: `HTTP_${result.status}`,
            message: (typeof result.data?.detail === 'string' ? result.data.detail : result.data?.detail ? JSON.stringify(result.data.detail) : `Harness returned ${result.status}`).slice(0, 2000),
          },
          status: result.status,
        };
      return { ok: true, result: result.data, status: result.status };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "HARNESS_REQUEST_FAILED",
          message: String(error.message || error).slice(0, 2000),
        },
      };
    }
  }

  async function requestBinary(apiPath) {
    if (!isPackDownloadPath(apiPath)) return { ok: false, error: { code: 'HARNESS_PATH_DENIED', message: 'Choose a local pack source-preview export.' } };
    if (current.state !== 'ready' || !child || !token) return { ok: false, error: { code: 'HARNESS_NOT_READY', message: 'Start the existing local marketplace harness first.' } };
    const base = current.base, owner = child;
    try {
      // Export must not provision credentials when the established link is gone.
      const linkPath = path.join(stateDir, 'link.json');
      const linkInfo = fs.lstatSync(linkPath);
      if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.size > 16384) throw new Error('Harness link unavailable.');
      const link = JSON.parse(fs.readFileSync(linkPath, 'utf8'));
      if (typeof link.karma_token !== 'string' || !link.karma_token || link.karma_token.length > 1024) throw new Error('Harness link unavailable.');
      const result = await fetchPackSourceArchive({ fetchImpl, base, apiPath,
        headers: { authorization: `Bearer ${token}`, 'x-karma-token': link.karma_token } });
      if (current.state !== 'ready' || current.base !== base || child !== owner) throw new Error('Harness connection changed.');
      return { ok: true, result };
    } catch {
      // Never include response bodies, credential headers, or transport traces.
      // Export preparation is recorded by the engine; do not automatically retry.
      return { ok: false, error: { code: 'HARNESS_SOURCE_EXPORT_FAILED', message: 'The local source preview could not be verified. Inspect the pack and harness before retrying.' } };
    }
  }

  return Object.freeze({ start, stop, request, requestBinary, status });
}

module.exports = { createHarnessSidecar, isAllowed, resolvePython, loadLink };
