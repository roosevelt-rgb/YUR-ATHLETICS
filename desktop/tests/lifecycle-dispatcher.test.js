"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createLifecycleDispatcher } = require("../src/lifecycle-dispatcher");

const ok = (result) => ({ ok: true, result });
const clone = (value) => JSON.parse(JSON.stringify(value));
function claim(fields = {}) {
  const request = {
    request_id: randomUUID(),
    conversation_id: randomUUID(),
    mode: "work",
    goal: "Watch bid evidence.",
    root: null,
    provider: "ollama",
    model: "fixture",
    messages: [
      { role: "system", content: "You are the estimator." },
      { role: "user", content: "Watch bid evidence." },
    ],
  };
  return {
    deployment: {
      id: randomUUID(),
      state: "active",
      active_request_id: request.request_id,
      conversation_id: request.conversation_id,
      runs_completed: 0,
      ...fields,
    },
    request,
    replayed: false,
  };
}
const missionFor = (item, status) => ({
  id: randomUUID().replaceAll("-", ""),
  request_id: item.request.request_id,
  conversation_id: item.request.conversation_id,
  status,
});

function fixture(items, { runner = false, start } = {}) {
  const calls = [],
    states = [],
    timers = new Map(),
    missions = new Map();
  let nextTimer = 0;
  const transport = {
    async request(input) {
      calls.push({ ...input });
      const item = items.find(
        (entry) =>
          entry.deployment.id === input.deployment_id ||
          entry.request.request_id === input.request_id,
      );
      if (input.command === "lifecycle_runner")
        throw new Error(
          "The dispatcher must not spend a process on a separate runner probe",
        );
      if (input.command === "lifecycle_claim")
        return ok(
          runner
            ? { claims: [], delegated: true }
            : {
                claims: clone(
                  items.filter(
                    (entry) => entry.deployment.active_request_id !== null,
                  ),
                ),
                delegated: false,
              },
        );
      if (input.command === "lifecycle_resolve")
        return ok({ mission: clone(missions.get(input.request_id) || null) });
      if (input.command === "lifecycle_complete") {
        const mission = [...missions.values()].find(
          (entry) => entry.id === input.mission_id,
        );
        item.deployment.active_request_id = null;
        item.deployment.runs_completed++;
        return ok({
          deployment: clone(item.deployment),
          mission_status: mission.status,
          replayed: false,
        });
      }
      if (input.command === "lifecycle_dispatch_error") {
        assert.equal(missions.has(input.request_id), false);
        item.deployment.state = "paused";
        item.deployment.active_request_id = null;
        item.deployment.last_error = input.error;
        return ok({ deployment: clone(item.deployment) });
      }
      throw new Error("Unexpected fixture command: " + input.command);
    },
    async start(request, owner) {
      calls.push({ command: "start", request: clone(request), owner });
      if (start) return start(request, { missions, items });
      const item = items.find(
          (entry) => entry.request.request_id === request.request_id,
        ),
        mission = missionFor(item, "completed");
      missions.set(request.request_id, mission);
      return ok({ mission: clone(mission) });
    },
    async cancel() {
      return ok({ cancelled: false, mission: null });
    },
  };
  const dispatcher = createLifecycleDispatcher({
    workTransport: transport,
    onState: (state) => states.push(state),
    now: () => 1000,
    setTimer: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return { dispatcher, calls, states, timers, missions };
}

test("claims, starts the exact derived request and reconciles terminal Work", async () => {
  const item = claim();
  const { dispatcher, calls } = fixture([item]);
  dispatcher.start();
  await dispatcher.wake();
  const started = calls.find((call) => call.command === "start");
  assert.deepEqual(started.request, item.request);
  assert.equal(started.owner.kind, "committed-lifecycle-dispatcher");
  assert.ok(calls.some((call) => call.command === "lifecycle_complete"));
  assert.equal(dispatcher.status().last_result.mission_status, "completed");
  assert.equal(item.deployment.runs_completed, 1);
  await dispatcher.stop();
});

test("defers entirely while the headless runner owns the journal", async () => {
  const item = claim();
  const { dispatcher, calls } = fixture([item], { runner: true });
  dispatcher.start();
  await dispatcher.wake();
  assert.equal(dispatcher.status().phase, "delegated");
  // One RPC per tick: the claim itself reports delegation; nothing is started.
  assert.deepEqual(
    calls.map((call) => call.command),
    ["lifecycle_claim"],
  );
  await dispatcher.stop();
});

test("a failed start without Work is recorded honestly and pauses, never a fabricated run", async () => {
  const item = claim();
  const { dispatcher, calls } = fixture([item], {
    start: async () => ({
      ok: false,
      error: { code: "UNSUPPORTED_PROVIDER", message: "Ollama model missing" },
    }),
  });
  dispatcher.start();
  await dispatcher.wake();
  const recorded = calls.find(
    (call) => call.command === "lifecycle_dispatch_error",
  );
  assert.equal(recorded.error, "Ollama model missing");
  assert.equal(item.deployment.state, "paused");
  assert.equal(
    calls.some((call) => call.command === "lifecycle_complete"),
    false,
  );
  await dispatcher.stop();
});

test("a busy worker keeps the committed claim for the next tick", async () => {
  const item = claim();
  const { dispatcher, calls } = fixture([item], {
    start: async () => ({
      ok: false,
      error: { code: "WORKER_BUSY", message: "busy" },
    }),
  });
  dispatcher.start();
  await dispatcher.wake();
  assert.equal(dispatcher.status().phase, "waiting");
  assert.equal(
    calls.some((call) => call.command === "lifecycle_dispatch_error"),
    false,
  );
  assert.equal(item.deployment.active_request_id, item.request.request_id);
  await dispatcher.stop();
});

test("rejects claims whose identity does not match", async () => {
  const item = claim();
  item.deployment.conversation_id = randomUUID();
  const { dispatcher, calls } = fixture([item]);
  dispatcher.start();
  await dispatcher.wake();
  assert.equal(dispatcher.status().phase, "error");
  assert.equal(
    calls.some((call) => call.command === "start"),
    false,
  );
  await dispatcher.stop();
});
