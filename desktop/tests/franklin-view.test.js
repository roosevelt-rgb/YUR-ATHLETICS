"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create, normalizeSnapshot } = require("../src/franklin-view");
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this._text = ""; this.className = ""; this.value = ""; this.hidden = false; this.disabled = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(" "); }
  set innerHTML(_) { throw new Error("Assistant content must remain inert text"); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  focus() { this.ownerDocument.focused = this; }
  remove() { this.removed = true; }
}
const all = root => [root, ...root.children.flatMap(all)];
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) { for (let i = 0; i < 100; i++) { if (condition()) return; await settle(); } throw new Error("Expected UI state did not settle"); }
function setup(overrides = {}, initial = {}, options = {}) {
  const document = { createElement: tag => new Element(tag, document) }, host = document.createElement("body");
  let saved = { preferences: { model: "kimi-k3:cloud", open: false, draft: "" }, models: ["kimi-k3:cloud", "deepseek-v4-pro:cloud", "minimax-m3:cloud"], messages: [], events: [], active_request: null, status: { phase: "ready" }, ...initial };
  const calls = { configure: [], send: [], cancel: [], queue: [], snapshots: 0 }, events = {};
  const api = {
    snapshot: async () => { calls.snapshots++; return structuredClone(saved); },
    configure: async patch => { calls.configure.push(patch); saved.preferences = { ...saved.preferences, ...patch }; return structuredClone(saved); },
    send: async request => { calls.send.push(request); saved.messages.push({ role: "user", content: request.text, request_id: request.request_id }, { role: "assistant", content: "Done with a real reported result.", request_id: request.request_id }); return { completed: true, request_id: request.request_id, snapshot: structuredClone(saved) }; },
    cancel: async request => { calls.cancel.push(request); saved.active_request = null; return { cancelled: true, status: "cancelled", snapshot: structuredClone(saved) }; },
    onEvent: callback => { events.emit = callback; return () => { events.unsubscribed = true; }; },
    ...overrides,
  };
  const controller = create(host, { api, requestId: () => "12345678-1234-4234-9234-123456789012", debounceMs: 5000, ...options });
  return { host, api, controller, calls, events, get saved() { return saved; }, set saved(value) { saved = value; },
    get: id => all(host).find(node => node.id === id),
    type(value) { const input = this.get("franklin-input"); input.value = value; input.listeners.input(); },
    submit() { all(host).find(node => node.tagName === "form").listeners.submit({ preventDefault() {} }); },
  };
}

function fakeVoice(preferences = { dictation_enabled: true, restricted_session: false }) {
  const calls = { start: 0, stop: 0, cancel: 0, dispose: 0 };
  let callbacks;
  const state = phase => callbacks.onState({ ready: true, phase, seconds: 1, max_seconds: 60 });
  return { calls, api: { voice: {} }, readPreferences: async () => preferences,
    createDictation: options => { callbacks = options; return {
      refresh: async () => state('idle'), start: async () => { calls.start++; state('recording'); },
      stop: async () => { calls.stop++; state('transcribing'); await callbacks.onResult({ text: 'Recognized locally' }); state('idle'); },
      cancel: async () => { calls.cancel++; state('idle'); },
      dispose: async () => { calls.dispose++; },
    }; },
  };
}

test("Franklin local dictation requires settings and transcript review before draft or send", async () => {
  const preferences = { dictation_enabled: false, restricted_session: false }, voice = fakeVoice(preferences);
  const v = setup({}, {}, { voice }); await settle();
  v.type('Existing draft');
  await v.get('franklin-dictate').listeners.click();
  assert.equal(voice.calls.start, 0); assert.match(v.get('franklin-voice-status').textContent, /disabled/);
  preferences.dictation_enabled = true;
  await v.get('franklin-dictate').listeners.click();
  assert.equal(voice.calls.start, 1); assert.equal(v.get('franklin-send').disabled, true);
  v.type('Edited while recording');
  await v.get('franklin-dictate-stop').listeners.click();
  assert.equal(v.get('franklin-input').value, 'Edited while recording');
  assert.equal(v.get('franklin-transcript').value, 'Recognized locally');
  assert.equal(v.get('franklin-send').disabled, true); assert.equal(v.calls.send.length, 0);
  v.get('franklin-transcript-insert').listeners.click(); await v.controller.flushDraft();
  assert.equal(v.saved.preferences.draft, 'Edited while recording\n\nRecognized locally');
  assert.equal(v.calls.send.length, 0); assert.equal(v.get('franklin-send').disabled, false);
  v.controller.dispose(); await settle(); assert.equal(voice.calls.dispose, 1);
});

test("Franklin dictation cancel and restricted settings leave the saved draft untouched", async () => {
  const preferences = { dictation_enabled: true, restricted_session: false }, voice = fakeVoice(preferences);
  const v = setup({}, {}, { voice }); await settle(); v.type('Keep this');
  await v.get('franklin-dictate').listeners.click(); await v.get('franklin-dictate-cancel').listeners.click();
  assert.equal(v.get('franklin-transcript').value, ''); assert.equal(v.get('franklin-input').value, 'Keep this');
  await v.get('franklin-dictate').listeners.click(); v.controller.collapse(); await settle();
  assert.equal(voice.calls.cancel, 2);
  preferences.restricted_session = true;
  await v.get('franklin-dictate').listeners.click(); assert.equal(voice.calls.start, 2);
  await v.controller.flushDraft(); assert.equal(v.saved.preferences.draft, 'Keep this'); v.controller.dispose();
});

test("snapshot normalization preserves every available model and bounds messages without trusting markup", () => {
  const models = Array.from({ length: 36 }, (_, n) => ({ id: "model-" + n + ":cloud", label: "Model " + n }));
  const snapshot = normalizeSnapshot({ models: [...models, models[0], { id: "bad\nmodel" }], messages: [{ role: "assistant", content: "<img src=x onerror=bad()>" }] });
  assert.equal(snapshot.models.length, 36); assert.equal(snapshot.models[35].id, "model-35:cloud"); assert.equal(snapshot.messages[0].content, "<img src=x onerror=bad()>");
  assert.throws(() => normalizeSnapshot({ ok: false, error: { message: "Disconnected" } }), /Disconnected/);
});

test("assistant mounts once outside work sections and persists panel state through the host", async () => {
  const v = setup(); await settle(); assert.equal(create(v.host, { api: v.api }), v.controller); assert.equal(v.calls.snapshots, 1);
  assert.equal(v.get("franklin-panel").hidden, true); assert.equal(v.get("yur-franklin").dataset.expanded, "false"); v.controller.open(); await settle();
  assert.equal(v.get("franklin-panel").hidden, false); assert.equal(v.get("yur-franklin").dataset.expanded, "true"); assert.equal(v.saved.preferences.open, true);
  v.controller.collapse(); await settle(); assert.equal(v.saved.preferences.open, false); assert.equal(v.calls.send.length, 0);
  v.controller.dispose(); assert.equal(v.events.unsubscribed, true);
});

test("failed initial connection is visible on the collapsed badge and can recover without sending work", async () => {
  const v = setup({ snapshot: async () => { throw new Error('Assistant service is unavailable'); } });
  await settle();
  assert.equal(v.get('franklin-panel').hidden, true);
  assert.match(v.get('franklin-toggle').textContent, /Needs attention/);
  assert.doesNotMatch(v.get('franklin-toggle').textContent, /Connecting/);
  assert.match(v.get('franklin-status').textContent, /choose Refresh/);
  assert.equal(v.get('franklin-refresh').disabled, false);
  assert.equal(v.get('franklin-send').disabled, true);
  v.api.snapshot = async () => structuredClone(v.saved);
  await v.get('franklin-refresh').listeners.click(); await settle();
  assert.match(v.get('franklin-toggle').textContent, /Ready/);
  assert.equal(v.get('franklin-error').hidden, true);
  assert.equal(v.get('franklin-input').disabled, false);
  assert.equal(v.calls.send.length, 0);
  v.controller.dispose();
});

test("saved draft and full model catalog remain available; editing is persisted without requesting a model", async () => {
  const v = setup({}, { preferences: { model: "minimax-m3:cloud", open: true, draft: "Saved request" } }); await settle();
  assert.equal(v.get("franklin-input").value, "Saved request"); assert.equal(v.get("franklin-model").value, "minimax-m3:cloud");
  assert.equal(v.get("franklin-model").children.length, 4);
  v.type("New draft across windows"); await v.controller.flushDraft(); assert.equal(v.saved.preferences.draft, "New draft across windows"); assert.equal(v.calls.send.length, 0);
  const model = v.get("franklin-model"); model.value = "deepseek-v4-pro:cloud"; model.listeners.change(); await settle();
  assert.equal(v.saved.preferences.model, "deepseek-v4-pro:cloud"); v.controller.dispose();
});

test("workspace handoff appends to an existing draft without submitting or interrupting a mission", async () => {
  const v = setup({}, { preferences: { model: 'kimi-k3:cloud', draft: 'Keep this existing request', open: false } }); await settle();
  assert.deepEqual(v.controller.prepareDraft('Inspect the selected Unreal project'), { prepared: true, submitted: false });
  await v.controller.flushDraft();
  assert.equal(v.saved.preferences.draft, 'Keep this existing request\n\nInspect the selected Unreal project');
  assert.equal(v.get('franklin-panel').hidden, false); assert.equal(v.calls.send.length, 0);
  assert.throws(() => v.controller.prepareDraft('x'.repeat(8001)), /bounded/); v.controller.dispose();
  const active = setup({}, { active_request: { request_id: 'active', text: 'Working', status: 'running' } }); await settle();
  assert.throws(() => active.controller.prepareDraft('Another mission'), /current Franklin request/);
  assert.equal(active.calls.send.length, 0); assert.equal(active.calls.cancel.length, 0); active.controller.dispose();
});

test("a send records exact request identity, receives persisted history and clears only its accepted draft", async () => {
  const v = setup(); await settle(); v.type("Inspect my coding work"); v.submit(); await until(() => v.calls.send.length === 1 && v.get("franklin-stop").hidden);
  await settle(); assert.deepEqual(v.calls.send[0], { text: "Inspect my coding work", request_id: "12345678-1234-4234-9234-123456789012" });
  assert.match(v.get("franklin-log").textContent, /Done with a real reported result/); assert.equal(v.saved.preferences.draft, ""); assert.equal(v.get("franklin-retry").hidden, true); v.controller.dispose();
});

test("an uncertain transport outcome blocks new sends and retries the original request exactly once", async () => {
  let v, attempts = 0;
  v = setup({ send: async request => {
    v.calls.send.push(request); attempts++;
    if (attempts === 1) throw new Error("Response was lost");
    v.saved.messages = [{ role: "user", content: request.text, request_id: request.request_id }, { role: "assistant", content: "Recovered committed result", request_id: request.request_id }];
    return { completed: true, request_id: request.request_id, snapshot: structuredClone(v.saved) };
  } }); await settle(); v.type("Original task"); v.submit(); await until(() => !v.get("franklin-retry").hidden);
  v.type("A different draft stays intact"); v.submit(); await settle(); assert.equal(v.calls.send.length, 1);
  v.get("franklin-retry").listeners.click(); await until(() => attempts === 2 && v.get("franklin-retry").hidden);
  assert.deepEqual(v.calls.send[0], v.calls.send[1]); assert.equal(v.get("franklin-input").value, "A different draft stays intact"); assert.match(v.get("franklin-log").textContent, /Recovered committed result/);
  await v.controller.flushDraft(); v.controller.dispose();
});

test("stop targets only the persisted active request and collapse does not cancel it", async () => {
  const active_request = { request_id: "active-123", text: "Working task", status: "running" };
  const v = setup({}, { active_request }); await settle(); v.controller.collapse(); await settle(); assert.equal(v.calls.cancel.length, 0);
  assert.equal(v.get("franklin-send").disabled, true); await v.get("franklin-stop").listeners.click(); await settle();
  assert.deepEqual(v.calls.cancel, [{ request_id: "active-123" }]); assert.equal(v.get("franklin-stop").hidden, true); v.controller.dispose();
});

test("unavailable selected model is shown explicitly and cannot silently fall back", async () => {
  const v = setup({}, { preferences: { model: "unavailable:cloud", open: true, draft: "Do work" } }); await settle();
  assert.match(v.get("franklin-model").textContent, /unavailable:cloud · unavailable/); assert.equal(v.get("franklin-send").disabled, true); v.submit(); await settle(); assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

test("paused runtime and denied receipts do not become ready or committed claims", async () => {
  const v = setup({}, { status: { phase: "paused", message: "Assistant is paused" }, events: [{ type: "approval.denied", summary: "No change performed", receipt: { status: "denied" } }] }); await settle();
  assert.match(v.get("franklin-toggle").textContent, /Paused/); assert.match(v.get("franklin-timeline").textContent, /Reported receipt details/); assert.doesNotMatch(v.get("franklin-timeline").textContent, /Committed receipt details/); v.controller.dispose();
});

test("compiled context, permission state and receipts remain distinct from streamed assistant text", async () => {
  const v = setup({}, { context: { summary: "Coding session active, two work missions" }, permissions: { summary: "Changes require existing authority", review: { status: "pending", summary: "Review file update" } }, active_request: { request_id: "active", text: "Work" } }); await settle();
  v.events.emit({ type: "message.delta", request_id: "foreign", text: "Wrong session" });
  v.events.emit({ type: "reasoning.delta", request_id: "active", text: "Private reasoning" });
  v.events.emit({ type: "message.delta", request_id: "active", text: "Visible response" });
  v.events.emit({ type: "authority.commit", request_id: "active", summary: "Saved selected artifact", receipt: { commit_id: "commit-real", status: "committed" } });
  assert.match(v.get("franklin-log").textContent, /Visible response/); assert.doesNotMatch(v.host.textContent, /Wrong session|Private reasoning/);
  assert.match(v.get("franklin-context").textContent, /Coding session active/); assert.match(v.get("franklin-context").textContent, /Review file update/); assert.match(v.get("franklin-timeline").textContent, /commit-real/); v.controller.dispose();
});

test("live Desktop observation updates without inference, saving or overriding an active turn", async () => {
  const v = setup({}, { active_request: { request_id: 'active', text: 'Work' } }); await settle();
  v.events.emit({ type: 'desktop.activity', observation: { sequence: 12, active: 2, awaiting_review: 1, failed: 0,
    latest: { mission_id: 'a'.repeat(32), label: 'Work request', phase: 'Waiting for operator review' } } });
  assert.match(v.get('franklin-observation').textContent, /2 active · 1 awaiting review/);
  assert.match(v.get('franklin-observation').textContent, /Waiting for operator review/);
  assert.equal(v.get('franklin-observation').dataset.missionId, 'a'.repeat(32));
  assert.match(v.get('franklin-toggle').textContent, /Working/);
  v.events.emit({ type: 'desktop.activity', observation: { sequence: 10, active: 0 } });
  assert.match(v.get('franklin-observation').textContent, /2 active/);
  assert.equal(v.calls.send.length, 0); assert.equal(v.calls.configure.length, 0);
  assert.equal(v.calls.snapshots, 1); v.controller.dispose();
});

test('a failed turn remains visible after recovery refresh and does not leave Working displayed', async () => {
  const v = setup({}, { active_request: { request_id: 'active', text: 'Work' } }); await settle();
  v.saved.active_request = null;
  v.saved.messages = [{ request_id: 'active', role: 'error', content: 'Request interrupted; committed work retained.' }];
  v.events.emit({ type: 'turn.error', request_id: 'active', error: { code: 'FRANKLIN_INTERRUPTED', message: 'Runtime stopped before returning a result.' } });
  await settle();
  assert.match(v.get('franklin-error').textContent, /Runtime stopped/);
  assert.equal(v.get('franklin-error').hidden, false);
  assert.doesNotMatch(v.get('franklin-toggle').textContent, /Working/);
  assert.equal(v.get('franklin-retry').hidden, true);
  assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

const QUEUE_REQUEST = '12345678-1234-4234-9234-123456789012', QUEUE_CALL = 'a'.repeat(32);
const retainedQueue = extra => ({ request_id: QUEUE_REQUEST, call_id: QUEUE_CALL, phase: 'accepted', remote_state: 'IN_QUEUE', durable: true, ...extra });

test('foreign cloud events cannot create a progress label or protected recovery identity', async () => {
  const v = setup({}, { active_request: { request_id: QUEUE_REQUEST, text: 'Work' } }); await settle();
  v.events.emit({ type: 'model_queue', ...retainedQueue({ request_id: '87654321-1234-4234-9234-123456789012' }) });
  v.events.emit({ type: 'model_queue', call_id: QUEUE_CALL, phase: 'status', remote_state: 'IN_PROGRESS' });
  assert.equal(v.get('franklin-cloud-status').hidden, true);
  assert.equal(v.get('franklin-cloud-check').hidden, true);
  assert.equal(v.calls.queue.length, 0); assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

test('current queue progress shows starting, running and validating with elapsed time without repeated timeline entries', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let elapsed = 0;
  const v = setup({}, { active_request: { request_id: QUEUE_REQUEST, text: 'Work' } }, { now: () => elapsed }); await settle();
  try {
    v.events.emit({ type: 'model_queue', ...retainedQueue({ phase: 'submit_intent', remote_state: 'UNKNOWN' }) });
    assert.match(v.get('franklin-cloud-status').textContent, /Starting cloud work.*Elapsed 0m 0s/);
    const timeline = v.get('franklin-timeline').textContent;
    elapsed = 65000; t.mock.timers.tick(1000);
    assert.match(v.get('franklin-cloud-status').textContent, /Elapsed 1m 5s/);
    assert.equal(v.get('franklin-timeline').textContent, timeline);
    assert.equal(v.calls.snapshots, 1, 'Local elapsed updates must not poll or infer');
    v.events.emit({ type: 'model_queue', ...retainedQueue({ phase: 'status', remote_state: 'IN_PROGRESS' }) });
    assert.match(v.get('franklin-cloud-status').textContent, /Cloud work is running/);
    v.events.emit({ type: 'model_queue', ...retainedQueue({ phase: 'terminal', remote_state: 'COMPLETED' }) });
    assert.match(v.get('franklin-cloud-status').textContent, /Validating the cloud result/);
    assert.equal(v.get('franklin-cloud-check').hidden, true);
    assert.equal(v.calls.send.length, 0);
  } finally { v.controller.dispose(); t.mock.timers.reset(); }
});

test('runtime-finished Stop acknowledgment preserves unconfirmed cloud cancellation through refresh and reload', async () => {
  let v;
  v = setup({ cancel: async identity => {
    v.calls.cancel.push(identity); v.saved.active_request = null;
    v.saved.messages = [{ role: 'assistant', request_id: QUEUE_REQUEST, content: 'This local request was stopped.' }];
    return { cancelled: true, remote_cleanup: 'runtime_finished', snapshot: structuredClone(v.saved) };
  }, queueReconcile: async () => { throw new Error('Must require a click'); } }, {
    active_request: { request_id: QUEUE_REQUEST, text: 'Work' }, queue_calls: [retainedQueue()]
  }); await settle();
  await v.get('franklin-stop').listeners.click(); await settle();
  assert.match(v.get('franklin-toggle').textContent, /Needs attention/);
  assert.match(v.get('franklin-cloud-status').textContent, /remote cancellation is unconfirmed/);
  assert.doesNotMatch(v.get('franklin-cloud-status').textContent, /cancellation confirmed/);
  assert.equal(v.get('franklin-cloud-check').hidden, false);
  assert.equal(v.get('franklin-retry').hidden, true);
  const persisted = structuredClone(v.saved); persisted.queue_calls[0].local_cancelled = true; v.controller.dispose();
  const reopened = setup({ queueReconcile: async () => { throw new Error('Must require a click'); } }, persisted); await settle();
  assert.match(reopened.get('franklin-toggle').textContent, /Needs attention/);
  assert.match(reopened.get('franklin-cloud-status').textContent, /remote cancellation is unconfirmed/);
  assert.equal(reopened.get('franklin-cloud-stop').hidden, false);
  assert.equal(reopened.calls.queue.length, 0); assert.equal(reopened.calls.send.length, 0); reopened.controller.dispose();
});

test('turn.cancelled refresh retains late unconfirmed provider telemetry without treating local stop as remote proof', async () => {
  const v = setup({ queueReconcile: async () => {} }, { active_request: { request_id: QUEUE_REQUEST, text: 'Work' }, queue_calls: [retainedQueue()] }); await settle();
  v.saved.active_request = null; v.saved.messages = [{ role: 'assistant', request_id: QUEUE_REQUEST, content: 'Stopped locally.' }];
  v.events.emit({ type: 'model_queue', ...retainedQueue({ phase: 'cancel_unconfirmed', remote_state: 'UNKNOWN', durable: false }) });
  v.events.emit({ type: 'turn.cancelled', request_id: QUEUE_REQUEST }); await settle();
  assert.match(v.get('franklin-cloud-status').textContent, /unconfirmed.*UNKNOWN/);
  assert.match(v.get('franklin-toggle').textContent, /Needs attention/);
  await v.controller.refresh();
  assert.match(v.get('franklin-cloud-status').textContent, /unconfirmed.*UNKNOWN/);
  assert.equal(v.calls.send.length, 0); assert.equal(v.calls.queue.length, 0); v.controller.dispose();
});

test('protected cloud Check and Stop submit only selected retained identities and require explicit clicks', async () => {
  let v;
  v = setup({ queueReconcile: async identity => {
    v.calls.queue.push(identity);
    return { ...identity, remote_state: identity.cancel ? 'CANCELLED' : 'IN_PROGRESS', cancel_confirmed: identity.cancel, outcome_known: true,
      job_id: 'host-only-job', endpoint_id: 'host-only-endpoint', token: 'PRIVATE_TOKEN' };
  } }, { queue_calls: [retainedQueue({ local_cancelled: true })] }); await settle();
  assert.equal(v.calls.queue.length, 0); assert.equal(v.calls.send.length, 0);
  await v.get('franklin-cloud-check').listeners.click();
  assert.deepEqual(v.calls.queue[0], { request_id: QUEUE_REQUEST, call_id: QUEUE_CALL, cancel: false });
  assert.match(v.get('franklin-cloud-status').textContent, /unconfirmed.*IN_PROGRESS/);
  await v.get('franklin-cloud-stop').listeners.click();
  assert.deepEqual(v.calls.queue[1], { request_id: QUEUE_REQUEST, call_id: QUEUE_CALL, cancel: true });
  assert.match(v.get('franklin-cloud-status').textContent, /Cloud cancellation confirmed by the provider/);
  assert.equal(v.get('franklin-cloud-check').hidden, true);
  assert.doesNotMatch(v.host.textContent, /PRIVATE_TOKEN|host-only-job|host-only-endpoint/);
  assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

test('a completed remote job racing Stop is reported as completed and discarded locally, with no canceled claim', async () => {
  const v = setup({ queueReconcile: async identity => ({ ...identity, remote_state: 'COMPLETED', cancel_confirmed: false, outcome_known: true }) },
    { queue_calls: [retainedQueue({ local_cancelled: true })] }); await settle();
  await v.get('franklin-cloud-stop').listeners.click();
  assert.match(v.get('franklin-cloud-status').textContent, /completed remotely after Stop.*discarded locally/);
  assert.doesNotMatch(v.get('franklin-cloud-status').textContent, /cancellation confirmed|cancelled|canceled/);
  assert.equal(v.get('franklin-cloud-stop').hidden, true);
  await v.controller.refresh();
  assert.match(v.get('franklin-cloud-status').textContent, /completed remotely after Stop.*discarded locally/);
  assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

test('unknown outcome or missing retained call identity remains attention and never invents retry or resubmission', async () => {
  let v;
  v = setup({ queueReconcile: async identity => { v.calls.queue.push(identity); return { ...identity, remote_state: 'UNKNOWN', cancel_confirmed: false, outcome_known: false }; } },
    { queue_calls: [retainedQueue({ local_cancelled: true })] }); await settle();
  await v.get('franklin-cloud-check').listeners.click();
  assert.match(v.get('franklin-toggle').textContent, /Needs attention/);
  assert.match(v.get('franklin-cloud-status').textContent, /unconfirmed.*UNKNOWN/);
  v.controller.dispose();
  const missing = setup({ queueReconcile: async () => { throw new Error('No retained identity'); } },
    { queue_calls: [retainedQueue({ call_id: null, phase: 'submit_uncertain', remote_state: 'UNKNOWN', local_cancelled: true })] }); await settle();
  assert.match(missing.get('franklin-toggle').textContent, /Needs attention/);
  assert.match(missing.get('franklin-cloud-status').textContent, /No retained call identity/);
  assert.equal(missing.get('franklin-cloud-check').hidden, true); assert.equal(missing.get('franklin-cloud-stop').hidden, true);
  missing.type('A different request'); missing.submit(); await settle();
  assert.equal(missing.calls.send.length, 0); assert.equal(missing.calls.queue.length, 0); missing.controller.dispose();
});

test('cloud recovery rejects a foreign returned call and keeps the original exact job available', async () => {
  const v = setup({ queueReconcile: async identity => ({ ...identity, call_id: 'b'.repeat(32), remote_state: 'CANCELLED', cancel_confirmed: true, outcome_known: true }) },
    { queue_calls: [retainedQueue({ local_cancelled: true })] }); await settle();
  await v.get('franklin-cloud-check').listeners.click();
  assert.match(v.get('franklin-error').textContent, /different retained identity/);
  assert.match(v.get('franklin-cloud-status').textContent, /unconfirmed/);
  assert.equal(v.get('franklin-cloud-stop').hidden, false);
  assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

test('unused cloud controls stay hidden and all existing model choices remain intact', async () => {
  const v = setup(); await settle();
  assert.equal(v.get('franklin-cloud-status').hidden, true);
  assert.equal(v.get('franklin-cloud-check').hidden, true); assert.equal(v.get('franklin-cloud-stop').hidden, true);
  assert.equal(v.get('franklin-model').children.length, 4);
  assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

test('newest retained cloud call is selected and changing selection cannot send arbitrary remote identifiers', async () => {
  let v; const olderCall = 'b'.repeat(32);
  v = setup({ queueReconcile: async identity => { v.calls.queue.push(identity); return { ...identity, remote_state: 'IN_PROGRESS', cancel_confirmed: false, outcome_known: true }; } },
    { queue_calls: [retainedQueue({ local_cancelled: true }), retainedQueue({ call_id: olderCall, local_cancelled: true })] }); await settle();
  await v.get('franklin-cloud-check').listeners.click();
  assert.equal(v.calls.queue[0].call_id, QUEUE_CALL);
  const select = v.get('franklin-cloud-job'); assert.equal(select.hidden, false);
  select.value = QUEUE_REQUEST + ':' + olderCall; select.listeners.change();
  await v.get('franklin-cloud-stop').listeners.click();
  assert.deepEqual(v.calls.queue[1], { request_id: QUEUE_REQUEST, call_id: olderCall, cancel: true });
  select.value = 'https://foreign.example.test/job'; select.listeners.change();
  await v.get('franklin-cloud-check').listeners.click();
  assert.deepEqual(v.calls.queue[2], { request_id: QUEUE_REQUEST, call_id: olderCall, cancel: false });
  assert.equal(v.calls.send.length, 0); v.controller.dispose();
});

test('an explicit unknown outcome cannot be upgraded into cancellation confirmation by an inconsistent reply', async () => {
  const v = setup({ queueReconcile: async identity => ({ ...identity, remote_state: 'CANCELLED', cancel_confirmed: true, outcome_known: false }) },
    { queue_calls: [retainedQueue({ local_cancelled: true })] }); await settle();
  await v.get('franklin-cloud-check').listeners.click();
  assert.match(v.get('franklin-cloud-status').textContent, /remote cancellation is unconfirmed/);
  assert.match(v.get('franklin-toggle').textContent, /Needs attention/);
  assert.equal(v.get('franklin-cloud-check').hidden, false);
  assert.equal(v.calls.send.length, 0); v.controller.dispose();
});
