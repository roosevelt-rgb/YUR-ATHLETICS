"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create, newState, resetSession, ingest, applyDelegation, consoleResult, responseFailed, responseCancelled, toolFailed } = require("../src/rc6-observer-view");
const event = (type, payload = {}, session_id = "owned") => ({ type, payload, session_id });
const session = () => { const state = newState(); state.runtime = { running: true }; resetSession(state, "owned"); return state; };

test("observer accepts exact-session runtime events, rejects unrelated sessions and excludes private reasoning text", () => {
  const state = session();
  assert.equal(ingest(state, event("tool.start", { tool_id: "other", name: "write_file" }, "foreign")), false);
  assert.equal(ingest(state, event("tool.start", { tool_id: "unscoped", name: "write_file" }, null)), false);
  assert.equal(ingest(state, { type: "tool.start", payload: { tool_id: "unscoped" } }), false);
  assert.equal(ingest(state, event("message.delta", { text: "PRIVATE_TOKEN_STREAM" })), false);
  ingest(state, event("reasoning.summary", { text: "PRIVATE_REASONING" }));
  ingest(state, event("message.complete", { reasoning: "PRIVATE_REASONING", usage: { model: "kimi-k3:cloud", total: 41, calls: 1, cost_status: "unknown" } }));
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/); assert.equal(state.usage.total, 41); assert.equal(state.usage.cost_usd, undefined);
  assert.equal(state.tools.size, 0);
});

test("tool identity, duration and terminal output come only from reported fields", () => {
  const state = session();
  ingest(state, event("tool.start", { tool_id: "call1", name: "terminal", context: "pwd" }));
  ingest(state, event("tool.progress", { name: "terminal", preview: "C:\\project" }));
  ingest(state, event("tool.complete", { tool_id: "call1", name: "terminal", summary: "Command finished", duration_s: .5, stdout: "\x1b[32mC:\\project\x1b[0m" }));
  assert.equal(state.toolCount, 1); assert.equal(state.tools.size, 1); assert.equal(state.tools.get("call1").status, "finished");
  assert.equal(state.tools.get("call1").duration_s, .5); assert.equal(state.terminal.length, 3); assert.equal(state.terminal[2].stdout, "C:\\project");
  assert.equal(state.tools.get("call1").exit_code, undefined);
});

test("response completion and tool completion preserve reported failure instead of implying success", () => {
  assert.equal(responseFailed({ status: "failed" }), true);
  assert.equal(responseFailed({ status: "error" }), true);
  assert.equal(responseCancelled({ status: "cancelled" }), true);
  assert.equal(toolFailed({ result: { error: "command rejected" } }), true);
  assert.equal(toolFailed({ success: false }), true);
  const state = session();
  ingest(state, event("tool.complete", { tool_id: "failed-tool", name: "write_file", status: "failed", summary: "Write was rejected" }));
  assert.equal(state.tools.get("failed-tool").status, "failed");
  assert.match(state.events.at(-1).detail, /^Tool failed:/);
  assert.equal(state.healthStale, true);
  ingest(state, event("message.complete", { status: "error", usage: { total: 3 } }));
  assert.equal(state.phase, "error"); assert.equal(state.responseStatus, "failed");
  assert.equal(state.usage.total, 3); assert.equal(state.events.at(-1).detail, "Response failed");
  ingest(state, event("message.complete", { status: "cancelled" }));
  assert.equal(state.responseStatus, "cancelled");
  ingest(state, event("message.complete", {}));
  assert.equal(state.responseStatus, "ended; result not verified");
  assert.match(state.events.at(-1).detail, /inspect tool and validation receipts/);
});

test("agent disappearance is not invented completion and exact source counters are retained", () => {
  const state = session(); ingest(state, event("subagent.start", { subagent_id: "child1", goal: "Read source", model: "deepseek-v4-pro:cloud", tool_count: 2 }));
  applyDelegation(state, { active: [], paused: false, max_concurrent_children: 3 });
  assert.equal(state.agents.get("child1").status, "no longer active (completion not reported)");
  ingest(state, event("subagent.complete", { subagent_id: "child1", status: "completed", input_tokens: 123, output_tokens: 4 }));
  assert.equal(state.agents.get("child1").status, "completed"); assert.equal(state.agents.get("child1").input_tokens, 123);
  assert.throws(() => applyDelegation(state, {}), /invalid delegated-agent/);
});

test("session reset clears events, tools, agents and usage while keeping runtime identity", () => {
  const state = session(); ingest(state, event("tool.start", { tool_id: "one", name: "read_file" }));
  ingest(state, event("message.complete", { usage: { total: 8 } })); resetSession(state, "next");
  assert.equal(state.sessionId, "next"); assert.equal(state.events.length, 0); assert.equal(state.tools.size, 0); assert.equal(state.usage, null); assert.equal(state.runtime.running, true);
});

test("long-running telemetry remains bounded without falsifying observed totals", () => {
  const state = session();
  for (let i = 0; i < 300; i++) { ingest(state, event("tool.start", { tool_id: "call" + i, name: "terminal", context: "x".repeat(9000) })); ingest(state, event("subagent.start", { subagent_id: "agent" + i })); }
  assert.equal(state.events.length, 200); assert.equal(state.tools.size, 200); assert.equal(state.agents.size, 100); assert.equal(state.terminal.length, 100);
  assert.equal(state.toolCount, 300); assert.equal(state.eventCount, 600); assert.equal(state.terminal.at(-1).detail.length, 4000);
  applyDelegation(state, { active: Array.from({ length: 150 }, (_, n) => ({ subagent_id: "snapshot" + n })) });
  assert.equal(state.agents.size, 100); assert.equal(state.delegation.activeCount, 150);
});

class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this._text = ""; this.className = ""; this.value = ""; this.hidden = false;
    this.classList = { toggle: (name, force) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); this.className = [...classes].join(" "); return classes.has(name); } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(" "); }
  set innerHTML(_) { throw new Error("Runtime strings must remain inert text"); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  remove() { this.removed = true; }
}
const all = root => [root, ...root.children.flatMap(all)];
const settle = () => new Promise(resolve => setImmediate(resolve));
function view(api = {}) {
  const document = { createElement: tag => new Element(tag, document) }, host = document.createElement("div");
  const controller = create(host, { api: { inventory: async () => ({ capabilities: [] }), health: async () => ({ status: "healthy" }), info: async () => ({ harness_id: "actual-rc6" }), delegationStatus: async () => ({ active: [] }), ...api } });
  controller.setRuntime({ running: true, model: "kimi-k3:cloud", workspace: "C:\\owned", profile: "private" }); controller.setSession("owned");
  return { controller, host, panel: key => all(host).find(node => node.id === "rc6-observer-" + key) };
}

test("complete capability search reaches entries beyond the first page without executing any tool", async () => {
  let calls = 0;
  const capabilities = Array.from({ length: 115 }, (_, n) => ({ name: "tool-" + n, operational_state: n === 114 ? "missing_dependency" : "available", permissions: ["read"] }));
  const v = view({ inventory: async () => { calls++; return { capabilities }; } }); await v.controller.refresh();
  const panel = v.panel("tools"), input = all(panel).find(node => node.type === "search");
  assert.match(panel.textContent, /50 of 115 matching/); input.value = "tool-114"; input.listeners.input();
  assert.match(panel.textContent, /tool-114 · missing_dependency/); assert.equal(calls, 1);
  assert.equal(all(panel).filter(node => node.tagName === "button" && /Run|Execute/.test(node.textContent)).length, 0);
});

test("slow inventory does not hide health already returned; unavailable inventory never becomes an empty successful catalog", async () => {
  let rejectInventory;
  const v = view({ inventory: () => new Promise((_resolve, reject) => { rejectInventory = reject; }), health: async () => ({ status: "degraded", reasons: ["Optional provider unavailable"], tools: { total: 52 } }) });
  const pending = v.controller.refresh(); await settle(); v.controller.selectTab("system");
  assert.match(v.panel("system").textContent, /Health · degraded/); assert.match(v.panel("system").textContent, /Optional provider unavailable/);
  rejectInventory(new Error("Inventory request timed out")); await pending; v.controller.selectTab("tools");
  assert.match(v.host.textContent, /Inventory request timed out/); assert.doesNotMatch(v.panel("tools").textContent, /0 returned by /);
});

test("failed tool makes the last health response stale until a later probe returns", async () => {
  const healthReplies = [];
  const v = view({ health: () => new Promise(resolve => { healthReplies.push(resolve); }) });
  const first = v.controller.refresh(); await settle();
  healthReplies.shift()({ status: "healthy" }); await first;
  v.controller.selectTab("system");
  assert.match(v.panel("system").textContent, /Health · healthy/);
  assert.match(v.panel("system").textContent, /Health observed/);
  v.controller.onEvent(event("tool.complete", { tool_id: "broken", name: "read_file", status: "failed" }));
  assert.match(v.panel("system").textContent, /Health · stale \(last reported healthy\)/);
  await settle(); assert.equal(healthReplies.length, 1);
  healthReplies.shift()({ status: "degraded", reasons: ["Tool failure reported"] });
  await settle(); await settle();
  assert.match(v.panel("system").textContent, /Health · degraded/);
  assert.doesNotMatch(v.panel("system").textContent, /Health · stale/);
});

test("failure during a pending probe cannot turn its older result into current health", async () => {
  const healthReplies = [];
  const v = view({ health: () => new Promise(resolve => { healthReplies.push(resolve); }) });
  const pending = v.controller.refresh(); await settle();
  v.controller.onEvent(event("tool.complete", { tool_id: "broken", status: "failed" }));
  healthReplies.shift()({ status: "healthy" }); await pending; await settle();
  v.controller.selectTab("system");
  assert.match(v.panel("system").textContent, /Health · stale \(last reported healthy\)/);
  assert.equal(healthReplies.length, 1);
  healthReplies.shift()({ status: "degraded" }); await settle(); await settle();
  assert.match(v.panel("system").textContent, /Health · degraded/);
});

test("health probe failure retains only a clearly stale last response", async () => {
  let count = 0;
  const v = view({ health: async () => { if (++count === 1) return { status: "healthy" }; throw new Error("Health probe failed"); } });
  await v.controller.refresh(); v.controller.selectTab("system");
  v.controller.onEvent(event("tool.complete", { tool_id: "broken", error: "tool failed" }));
  await settle(); await settle();
  assert.match(v.panel("system").textContent, /Health · stale \(last reported healthy\)/);
  assert.match(v.host.textContent, /health: Health probe failed/);
});

test("collapse control remains visible, keyboard addressable, and expands the selected panel", () => {
  const v = view(); v.controller.selectTab("system");
  const button = all(v.host).find(node => node.id === "rc6-observer-collapse");
  assert.equal(button.type, "button"); assert.equal(button.attributes["aria-expanded"], "true");
  button.listeners.click();
  assert.match(v.host.className, /rc6-observer-collapsed/);
  assert.equal(button.hidden, false); assert.equal(button.attributes["aria-expanded"], "false");
  assert.equal(v.panel("system").hidden, true);
  button.listeners.click();
  assert.doesNotMatch(v.host.className, /rc6-observer-collapsed/);
  assert.equal(button.attributes["aria-expanded"], "true"); assert.equal(v.panel("system").hidden, false);
});

test("late runtime and delegation snapshots cannot populate a disconnected runtime or a replacement session", async () => {
  let inventory, delegation;
  const v = view({ inventory: () => new Promise(resolve => { inventory = resolve; }), delegationStatus: () => new Promise(resolve => { delegation = resolve; }) });
  const pending = v.controller.refresh(); await settle(); v.controller.setSession("next");
  delegation({ active: [{ subagent_id: "old-child", goal: "Old session" }] }); inventory({ capabilities: [{ name: "global-tool" }] }); await pending;
  v.controller.selectTab("agents"); assert.doesNotMatch(v.panel("agents").textContent, /old-child|Old session/);
  const again = v.controller.refresh(); await settle(); v.controller.setRuntime(null);
  inventory({ capabilities: [{ name: "stale-tool" }] }); delegation({ active: [] }); await again;
  v.controller.selectTab("tools"); assert.doesNotMatch(v.panel("tools").textContent, /stale-tool/);
});

test("terminal panel renders actual events but exposes no command execution without a host binding", () => {
  const v = view(); v.controller.onEvent(event("tool.start", { tool_id: "t", name: "terminal", context: "pwd" })); v.controller.selectTab("terminal");
  assert.match(v.panel("terminal").textContent, /pwd/); assert.match(v.panel("terminal").textContent, /Reported tool context/);
  assert.equal(all(v.panel("terminal")).filter(node => node.tagName === "form").length, 0);
});

test('console events and promise reconcile one result and reject another runtime or session', () => {
  const state = session(); state.runtime.runtimeKey = 'rc6';
  const result = { requestId: 'one', sessionId: 'owned', runtimeKey: 'rc6', command: 'pwd', stdout: 'owned', stderr: '', code: 0, policy: 'read-only' };
  ingest(state, event('console.started', { ...result, stdout: '' }));
  ingest(state, event('console.completed', result)); consoleResult(state, result);
  assert.equal(state.terminal.length, 1); assert.equal(state.terminal[0].stdout, 'owned');
  assert.equal(ingest(state, { ...event('console.completed', result), runtimeKey: 'construction-v1' }), false);
  assert.equal(consoleResult(state, { ...result, sessionId: 'foreign' }), false);
  for (let i = 0; i < 150; i++) consoleResult(state, { ...result, requestId: String(i) });
  assert.equal(state.terminal.length, 100);
});

test('repository console keeps busy state across runtime events, renders inert output, and deduplicates', async () => {
  let resolve, calls = 0;
  const v = view({ console: () => { calls++; return new Promise(done => { resolve = done; }); } });
  v.controller.selectTab('terminal');
  let form = all(v.panel('terminal')).find(node => node.tagName === 'form');
  const input = all(form).find(node => node.tagName === 'input'); input.value = 'pwd'; input.listeners.input();
  const pending = form.listeners.submit({ preventDefault() {} });
  v.controller.onEvent(event('console.started', { requestId: 'r', command: 'pwd' }));
  form = all(v.panel('terminal')).find(node => node.tagName === 'form');
  assert.equal(all(form).find(node => node.tagName === 'button').disabled, true);
  await form.listeners.submit({ preventDefault() {} }); assert.equal(calls, 1);
  const result = { requestId: 'r', sessionId: 'owned', command: 'pwd', stdout: '<img onerror="unsafe">', stderr: 'reported warning', code: 7, policy: 'read-only' };
  v.controller.onEvent(event('console.completed', result)); resolve(result); await pending;
  assert.match(v.panel('terminal').textContent, /<img onerror="unsafe">/);
  assert.match(v.panel('terminal').textContent, /Exit 7/);
  assert.equal(all(v.panel('terminal')).filter(node => node.tagName === 'article').length, 1);
  assert.equal(all(v.panel('terminal')).find(node => node.tagName === 'button').disabled, false);
});

test('console rejection preserves input, while late results cannot cross a replacement session', async () => {
  const v = view({ console: async () => { throw new Error('Only pwd, dir or type are supported'); } });
  v.controller.selectTab('terminal');
  let form = all(v.panel('terminal')).find(node => node.tagName === 'form');
  all(form).find(node => node.tagName === 'input').value = 'git reset';
  await form.listeners.submit({ preventDefault() {} });
  assert.match(v.host.textContent, /Only pwd, dir or type/);
  assert.equal(all(v.panel('terminal')).find(node => node.tagName === 'input').value, 'git reset');
  let done; const stale = view({ console: () => new Promise(resolve => { done = resolve; }) });
  stale.controller.selectTab('terminal'); form = all(stale.panel('terminal')).find(node => node.tagName === 'form');
  all(form).find(node => node.tagName === 'input').value = 'pwd';
  const pending = form.listeners.submit({ preventDefault() {} }); stale.controller.setSession('new-session');
  done({ requestId: 'late', sessionId: 'owned', stdout: 'OLD OUTPUT', code: 0 }); await pending;
  assert.doesNotMatch(stale.panel('terminal').textContent, /OLD OUTPUT/);
  stale.controller.setRuntime(null);
  assert.equal(all(stale.panel('terminal')).find(node => node.tagName === 'button').disabled, true);
});
