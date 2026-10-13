"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  createHarnessSidecar,
  isAllowed,
  loadLink,
  resolvePython,
} = require("../src/harness-sidecar");
const { packToDeploymentSpec, declaredTools } = require("../src/marketplace-deploy");

const pack = {
  pack_id: "pack_estimator_01",
  entry_id: "e1",
  agent_type: "estimator",
  provider: "ollama",
  agent_count: 2,
  tool_count: 2,
  pack: {
    files: {
      "agents/lead.agent.md": "Lead estimator: price the takeoff.",
      "agents/risk.agent.md": "Risk analyst.",
      "tools/takeoff.json": "{}",
      "tools/pricing.json": "{}",
      "README.md": "x",
    },
  },
};

// Matches marketplace/engine/yur_harness/pack_generator.py's index contract.
function generatedToolIndex(toolIds, metadata = {}) {
  return JSON.stringify({
    provider: "ollama",
    tool_ids: toolIds,
    source: "pack-generator",
    reference_status: "declared",
    execution_authority: "none",
    task_tested: false,
    ...metadata,
  }, null, 2) + "\n";
}

function packWithIndex(index) {
  return {
    ...pack,
    pack: { files: { ...pack.pack.files, "tools/tools-index.json": index } },
  };
}

test("pack maps to an honest marketplace deployment spec", () => {
  const spec = packToDeploymentSpec(pack, {
    goal: "Price new bids nightly.",
    model: "qwen3.5:9b",
    trigger: { kind: "cron", expression: "0 2 * * *", timezone: "UTC" },
  });
  assert.equal(spec.kind, "marketplace_pack");
  assert.deepEqual(spec.source, {
    pack_id: "pack_estimator_01",
    engine: "intelliflow-harness",
    entry_id: "e1",
    agent_type: "estimator",
    provider: "ollama",
    agent_count: 2,
    tool_count: 2,
  });
  assert.match(spec.instructions, /### lead\nLead estimator/);
  assert.match(spec.instructions, /guidance only\): pricing, takeoff/);
  assert.match(spec.instructions, /not tools you can call/);
  assert.throws(
    () => packToDeploymentSpec(pack, { goal: "", model: "m" }),
    /Describe/,
  );
  assert.throws(
    () => packToDeploymentSpec({ pack_id: "../x" }, { goal: "g", model: "m" }),
    /valid identifier/,
  );
});

test("marketplace deployment requires usable instructions and preserves all model IDs without promoting pack authority", () => {
  for (const files of [{}, { "agents/empty.agent.md": "   " }, { "agents/malformed.agent.md": 42 }])
    assert.throws(() => packToDeploymentSpec({ ...pack, pack: { files } }, { goal: "Review", model: "kimi-k3:cloud" }), /no usable agent instructions/);
  for (const model of ["kimi-k3:cloud", "deepseek-v4-pro:cloud", "minimax-m3:cloud", "glm-5.2:cloud"])
    assert.equal(packToDeploymentSpec(pack, { goal: "Review", model }).model, model);
  assert.match(packToDeploymentSpec(pack, { goal: "Review", model: "cloud-model" }).instructions, /coordinator instructions do not grant orchestration/);
  assert.equal(packToDeploymentSpec({ ...pack, content_sha256: "a".repeat(64) }, { goal: "Review", model: "cloud-model" }).source.content_sha256, "a".repeat(64));
  assert.throws(() => packToDeploymentSpec({ ...pack, content_sha256: "not-a-digest" }, { goal: "Review", model: "cloud-model" }), /source digest is invalid/);
});

test("generated tool indexes contribute real, stably ordered declarations without filename leakage", () => {
  const ids = ["réviser", "工具-２", "zeta", "generate_code", "alpha.v1", "namespace:tool"];
  const detail = packWithIndex(generatedToolIndex(ids));
  const before = JSON.stringify(detail);
  const expected = [...ids].sort();
  assert.deepEqual(declaredTools(detail.pack.files), expected);
  assert.deepEqual(declaredTools(packWithIndex(generatedToolIndex([...ids].reverse())).pack.files), expected);
  const spec = packToDeploymentSpec(detail, { goal: "Review", model: "m" });
  assert.ok(spec.instructions.includes(`Declared pack tools (guidance only): ${expected.join(", ")}.`));
  assert.doesNotMatch(spec.instructions, /tools-index|guidance only\): pricing/);
  assert.match(spec.instructions, /not tools you can call/);
  assert.match(spec.instructions, /OrchestrationManager and Commit Service remain authoritative/);
  assert.equal(JSON.stringify(detail), before);
  assert.equal(spec.source.content_sha256, undefined);
  const digest = "b".repeat(64);
  assert.equal(packToDeploymentSpec({ ...detail, content_sha256: digest }, { goal: "Review", model: "m" }).source.content_sha256, digest);
});

test("an empty generated tool index stays empty even when legacy tool files exist", () => {
  const detail = packWithIndex(generatedToolIndex([]));
  assert.deepEqual(declaredTools(detail.pack.files), []);
  const spec = packToDeploymentSpec(detail, { goal: "Review", model: "m" });
  assert.doesNotMatch(spec.instructions, /Declared pack tools/);
  assert.match(spec.instructions, /not tools you can call/);
});

test("malformed tool indexes fail closed without falling back to filenames", () => {
  const cases = [
    [undefined, /JSON text/],
    [null, /JSON text/],
    [{ tool_ids: ["run"] }, /JSON text/],
    [Buffer.from('{"tool_ids":[]}'), /JSON text/],
    ["{", /malformed JSON/],
    ["", /malformed JSON/],
    ["null", /tool_ids array/],
    ["[]", /tool_ids array/],
    ["true", /tool_ids array/],
    ["42", /tool_ids array/],
    ['"run"', /tool_ids array/],
    ["{}", /tool_ids array/],
    ['{"tool_ids":"run"}', /tool_ids array/],
    ['{"tool_ids":{}}', /tool_ids array/],
    [generatedToolIndex(["run", "run"]), /duplicate tool identifiers/],
  ];
  for (const [index, error] of cases) {
    const detail = packWithIndex(index);
    assert.throws(() => packToDeploymentSpec(detail, { goal: "Review", model: "m" }), error);
  }
});

test("tool declarations reject control characters, paths, non-string IDs and invalid lengths", () => {
  for (const id of [
    "", 5, null, {}, [], true, " tool", "tool name", "tool\n", "tool\r", "tool\0", "tool\t",
    "tool\u007f", "tool\u0085", "tool\u202e", "../tool", "..", "a..b", "/tool", "tools/run",
    "tools\\run", "C:run", "C:\\run", "file:///tool", "https://example.test/tool", "run;exit",
    "a".repeat(129),
  ]) {
    const detail = packWithIndex(generatedToolIndex(["valid", id]));
    assert.throws(() => packToDeploymentSpec(detail, { goal: "Review", model: "m" }), /invalid tool identifier/, JSON.stringify(id));
  }
  const longUnicodeId = "𐐀".repeat(128);
  assert.deepEqual(declaredTools(packWithIndex(generatedToolIndex([longUnicodeId])).pack.files), [longUnicodeId]);
});

test("tool index byte and item limits reject oversized declarations without truncation", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `tool-${i}`);
  assert.deepEqual(declaredTools(packWithIndex(generatedToolIndex(ids)).pack.files), [...ids].sort());
  assert.throws(() => declaredTools(packWithIndex(generatedToolIndex([...ids, "extra"])).pack.files), /at most 60/);
  const exactLimit = '{"tool_ids":[]}' + " ".repeat(64 * 1024 - '{"tool_ids":[]}'.length);
  assert.deepEqual(declaredTools(packWithIndex(exactLimit).pack.files), []);
  assert.throws(() => declaredTools(packWithIndex(exactLimit + " ").pack.files), /64 KiB/);
  const utf8Oversize = generatedToolIndex([], { extra: "界".repeat(24000) });
  assert.ok(utf8Oversize.length < 64 * 1024);
  assert.throws(() => declaredTools(packWithIndex(utf8Oversize).pack.files), /64 KiB/);
});

test("packaged code and claimed index authority are never executed or admitted", () => {
  const detail = packWithIndex(generatedToolIndex(["run"], {
    execution_authority: "unrestricted",
    reference_status: "admitted",
    task_tested: true,
    entrypoint: "tools/run.js",
  }));
  Object.defineProperty(detail.pack.files, "tools/run.js", {
    enumerable: true,
    get() { throw new Error("Pack code must not be read or imported"); },
  });
  Object.freeze(detail.pack.files);
  Object.freeze(detail.pack);
  Object.freeze(detail);
  const spec = packToDeploymentSpec(detail, { goal: "Review", model: "m" });
  assert.match(spec.instructions, /Declared pack tools \(guidance only\): run\./);
  assert.match(spec.instructions, /not tools you can call/);
  assert.match(spec.instructions, /do not grant orchestration, validation, commit, filesystem, or provider authority/);
  assert.doesNotMatch(spec.instructions, /unrestricted|admitted|entrypoint|run\.js/);
  assert.deepEqual(Object.keys(spec.source).sort(), ["agent_count", "agent_type", "engine", "entry_id", "pack_id", "provider", "tool_count"]);
});

test("legacy filename guidance remains available only when the exact tool index is absent", () => {
  assert.deepEqual(declaredTools(pack.pack.files), ["pricing", "takeoff"]);
  assert.deepEqual(declaredTools({
    "tools/zeta.py": "raise RuntimeError('must not execute')",
    "tools/alpha.yaml": "not a runnable tool",
    "tools/beta.md": "guidance",
    "other/tools-index.json": "invalid JSON ignored outside exact path",
  }), ["alpha", "beta", "zeta"]);
});

test("only allowlisted harness API paths are proxied", () => {
  assert.equal(isAllowed("GET", "/api/health"), true);
  assert.equal(isAllowed("POST", "/api/tasks"), true);
  assert.equal(isAllowed("POST", "/api/approvals/abc123"), true);
  assert.equal(isAllowed("GET", "/api/packs/pack_estimator_01"), true);
  for (const [method, apiPath] of [
    ["POST", "/api/auth/change-password"],
    ["DELETE", "/api/tasks"],
    ["GET", "/api/packs/../auth"],
    ["POST", "/api/inventory/seed"],
    ["GET", "/api/orders"],
  ]) {
    assert.equal(isAllowed(method, apiPath), false, `${method} ${apiPath}`);
  }
});

test("sidecar starts loopback-only with a per-install secret, logs in and proxies with bearer + karma token", async () => {
  const unified = fs.mkdtempSync(path.join(os.tmpdir(), "yur-unified-"));
  const state = path.join(unified, "state");
  const venv = path.join(
    unified,
    "marketplace",
    "engine",
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
  );
  fs.mkdirSync(venv, { recursive: true });
  fs.writeFileSync(
    path.join(venv, process.platform === "win32" ? "python.exe" : "python"),
    "",
  );
  const engine = path.join(unified, "marketplace", "engine");
  fs.mkdirSync(path.join(engine, "yur_harness"));
  fs.writeFileSync(path.join(engine, "yur_harness", "__main__.py"), "# Inert engine fixture\n");
  let spawned = null;
  const requests = [];
  const spawnImpl = (cmd, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = () => child.emit("exit", 0);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawned = { cmd, args, options };
    return child;
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const reply = (status, body) => ({
      status,
      text: async () => JSON.stringify(body),
    });
    if (url.endsWith("/api/health"))
      return reply(200, {
        ok: true,
        ready: true,
        version: "1.0.0",
        authority: { orchestration: "OrchestrationManager" },
      });
    if (url.endsWith("/api/auth/login"))
      return reply(200, { access_token: "tok", token_type: "bearer" });
    if (url.endsWith("/api/packs")) return reply(200, { packs: [] });
    return reply(404, { detail: "nope" });
  };
  const sidecar = createHarnessSidecar({
    unifiedRoot: unified,
    stateDir: state,
    environment: { ANTHROPIC_API_KEY: "synthetic-key-must-not-reach-child" },
    getAllowedRoots: () => [unified],
    getOllama: () => ({ url: "http://127.0.0.1:11434", model: "qwen3.5:9b" }),
    spawnImpl,
    fetchImpl,
  });
  const started = await sidecar.start();
  assert.equal(started.state, "ready");
  assert.deepEqual(spawned.args, [
    "-B",
    "-m",
    "yur_harness",
    "serve",
    "--no-browser",
  ]);
  const env = spawned.options.env;
  assert.equal(spawned.options.cwd, engine);
  assert.equal(started.engine_dir, engine);
  assert.equal(env.YUR_HOST, "127.0.0.1");
  assert.equal(env.YUR_GRPC_ENABLED, "false");
  assert.equal(env.YUR_ALLOWED_ROOTS, unified);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.YUR_ADMIN_PASSWORD, loadLink(state).admin_password);
  const listed = await sidecar.request("GET", "/api/packs");
  assert.deepEqual(listed, { ok: true, result: { packs: [] }, status: 200 });
  const last = requests.at(-1).init.headers;
  assert.equal(last.authorization, "Bearer tok");
  assert.equal(last["x-karma-token"], loadLink(state).karma_token);
  assert.equal(
    (await sidecar.request("POST", "/api/auth/change-password", {})).error.code,
    "HARNESS_PATH_DENIED",
  );
  await sidecar.stop();
  assert.equal(sidecar.status().state, "stopped");
  fs.rmSync(unified, { recursive: true, force: true });
});

test("missing harness environment reports unavailable instead of failing silently", async () => {
  const unified = fs.mkdtempSync(path.join(os.tmpdir(), "yur-unified-"));
  try {
    const sidecar = createHarnessSidecar({
      unifiedRoot: unified,
      stateDir: path.join(unified, "s"),
      environment: {},
      spawnImpl: () => assert.fail("Missing engine must not spawn"),
      fetchImpl: async () => {
        throw new Error("no");
      },
    });
    const result = await sidecar.start();
    assert.equal(result.state, "unavailable");
    assert.match(result.error, /YUR_HARNESS_ENGINE_ROOT/);
    assert.match(result.error, /YUR_HARNESS_PYTHON/);
    assert.match(result.error, /does not include this engine environment/);
    assert.doesNotMatch(result.error, /Setup YUR AI Unified/);
    assert.equal(fs.existsSync(path.join(unified, "s")), false);
  } finally {
    fs.rmSync(unified, { recursive: true, force: true });
  }
});

function engineFixture(root, withPython = true) {
  fs.mkdirSync(path.join(root, "yur_harness"), { recursive: true });
  fs.writeFileSync(path.join(root, "yur_harness", "__main__.py"), "# Inert engine fixture\n");
  const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (withPython) {
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "");
  }
  return python;
}

test("external engine selection binds its own Python and cwd without widening allowed roots", async () => {
  const unified = fs.mkdtempSync(path.join(os.tmpdir(), "yur-unified-external-"));
  let sidecar;
  try {
    const engine = path.join(unified, "external-engine");
    const python = engineFixture(engine);
    const defaultPython = engineFixture(path.join(unified, "marketplace", "engine"));
    const environment = { YUR_HARNESS_ENGINE_ROOT: engine };
    assert.equal(resolvePython(unified, environment), python);
    assert.equal(resolvePython(unified, { ...environment, YUR_HARNESS_PYTHON: defaultPython }), defaultPython);
    let spawned;
    sidecar = createHarnessSidecar({ unifiedRoot: unified, stateDir: path.join(unified, "state"), environment,
      getAllowedRoots: () => [path.join(unified, "selected-workspace")],
      spawnImpl: (command, args, options) => {
        spawned = { command, args, options };
        const child = new EventEmitter(); child.pid = 4242;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => child.emit("exit", 0);
        return child;
      },
      fetchImpl: async url => ({ status: 200, text: async () => JSON.stringify(url.endsWith("/api/health")
        ? { ok: true, ready: true, version: "fixture" } : { access_token: "fixture-token" }) }),
    });
    const result = await sidecar.start();
    assert.equal(result.state, "ready");
    assert.equal(result.engine_dir, engine);
    assert.equal(spawned.command, python);
    assert.equal(spawned.options.cwd, engine);
    assert.equal(spawned.options.env.YUR_ALLOWED_ROOTS, path.join(unified, "selected-workspace"));
    assert.equal(spawned.options.env.YUR_HOST, "127.0.0.1");
    assert.equal(spawned.options.env.YUR_GRPC_ENABLED, "false");
  } finally {
    await sidecar?.stop();
    fs.rmSync(unified, { recursive: true, force: true });
  }
});

test("invalid explicit engine never falls back or creates profile state", async () => {
  const unified = fs.mkdtempSync(path.join(os.tmpdir(), "yur-unified-invalid-"));
  try {
    const python = engineFixture(path.join(unified, "marketplace", "engine"));
    const notEngine = path.join(unified, "empty-directory");
    fs.mkdirSync(notEngine);
    for (const selected of ["", "relative-engine", path.join(unified, "absent"), python, notEngine, "bad\0path"]) {
      const state = path.join(unified, "state");
      const sidecar = createHarnessSidecar({ unifiedRoot: unified, stateDir: state,
        environment: { YUR_HARNESS_ENGINE_ROOT: selected, YUR_HARNESS_PYTHON: python },
        spawnImpl: () => assert.fail("Invalid explicit engine must not start any engine"),
        fetchImpl: async () => assert.fail("Invalid engine must not make an HTTP request"),
      });
      const result = await sidecar.start();
      assert.equal(result.state, "unavailable", selected);
      assert.equal(result.pid, null);
      assert.equal(result.port, null);
      assert.equal(result.python, null);
      assert.equal(fs.existsSync(state), false);
      assert.match(result.error, /existing absolute directory/);
    }
  } finally {
    fs.rmSync(unified, { recursive: true, force: true });
  }
});

test("missing Python names source setup only when that setup file exists", async () => {
  const unified = fs.mkdtempSync(path.join(os.tmpdir(), "yur-unified-python-"));
  try {
    engineFixture(path.join(unified, "marketplace", "engine"), false);
    const sidecar = createHarnessSidecar({ unifiedRoot: unified, stateDir: path.join(unified, "state"), environment: {},
      spawnImpl: () => assert.fail("Missing Python cannot spawn"), fetchImpl: async () => assert.fail("No HTTP expected") });
    const missing = await sidecar.start();
    assert.equal(missing.state, "unavailable");
    assert.match(missing.error, /Python environment not found/);
    assert.doesNotMatch(missing.error, /Setup YUR AI Unified/);
    fs.writeFileSync(path.join(unified, "Setup YUR AI Unified.cmd"), "@rem Inert fixture\n");
    const source = await sidecar.start();
    assert.match(source.error, /For this source installation, run "Setup YUR AI Unified.cmd"/);
    assert.equal(fs.existsSync(path.join(unified, "state")), false);
  } finally {
    fs.rmSync(unified, { recursive: true, force: true });
  }
});
