/* Construction inspector adaptation. Read-only presentation of the bound RC6
 * runtime: no coordinator, model loop, shell or capability admission lives here.
 * Donors: construction-v1/frontend/{coding.html,src/coding.ts,src/runtime-workspace.ts}.
 * The existing host supplies scoped RPCs and the original gateway event stream. */
(function (root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.yurRc6Observer = exported;
})(typeof window === "undefined" ? null : window, function () {
  "use strict";
  const MAX_EVENTS = 200, MAX_TOOLS = 200, MAX_AGENTS = 100, MAX_TERMINAL = 100;
  const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = (value, maximum = 4000) => typeof value === "string" ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\0/g, "").slice(0, maximum) : "";
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const shown = value => value == null || value === "" ? "Not reported" : typeof value === "object" ? text(JSON.stringify(value), 8000) : String(value);
  const isTerminal = name => /(?:terminal|shell|powershell|bash|exec_command|run_command|process)/i.test(name || "");
  const tail = (items, value, maximum) => { items.push(value); if (items.length > maximum) items.splice(0, items.length - maximum); };
  const failedStatus = value => ["error", "failed", "failure"].includes(text(value, 80).trim().toLowerCase());
  const responseFailed = payload => Boolean(record(payload).error) || failedStatus(record(payload).status);
  const responseCancelled = payload => record(payload).cancelled === true || ["cancelled", "canceled"].includes(text(record(payload).status, 80).trim().toLowerCase());
  const toolFailed = payload => {
    const item = record(payload), result = record(item.result);
    return responseFailed(item) || responseFailed(result) || item.success === false || result.success === false;
  };
  const invalidatesHealth = event => {
    const type = text(record(event).type, 120);
    return ["gateway.ready", "gateway.error", "bridge.error", "bridge.stopped", "backend.stopped", "backend.exited", "error"].includes(type)
      || (type === "tool.complete" && toolFailed(record(event.payload)));
  };
  function consoleResult(state, value, type = 'console.completed') {
    value = record(value);
    if (!value.requestId || (value.sessionId && value.sessionId !== state.sessionId)
        || (value.runtimeKey && state.runtime?.runtimeKey && value.runtimeKey !== state.runtime.runtimeKey)) return false;
    const row = { requestId: text(value.requestId, 160), type, detail: text(value.command, 2000),
      stdout: text(value.stdout, 12000), stderr: text(value.stderr || value.message, 4000),
      code: Number.isInteger(value.code) ? value.code : undefined, policy: text(value.policy, 80), observedAt: new Date().toISOString() };
    const prior = state.terminal.findIndex(item => item.requestId === row.requestId);
    if (prior >= 0) state.terminal[prior] = row; else tail(state.terminal, row, MAX_TERMINAL);
    return true;
  }

  function newState() {
    return { sessionId: null, runtime: null, usage: null, phase: "disconnected", events: [], eventCount: 0,
      tools: new Map(), toolCount: 0, agents: new Map(), terminal: [], inventory: null, health: null, info: null,
      delegation: null, snapshotAt: null, healthObservedAt: null, healthStale: false,
      responseStatus: null, error: "", sequence: 0 };
  }
  function resetSession(state, id) {
    state.sessionId = id || null; state.usage = null; state.responseStatus = null; state.events = []; state.eventCount = 0;
    state.tools.clear(); state.toolCount = 0; state.agents.clear(); state.terminal = [];
    state.delegation = null; state.sequence = 0; state.phase = state.runtime?.running ? "idle" : "disconnected";
  }
  function eventSummary(type, payload) {
    if (/^(reasoning|thinking)\./.test(type)) return "Reasoning active; tool events show operational progress.";
    if (type === "message.complete") return responseFailed(payload) ? "Response failed" : responseCancelled(payload) ? "Response cancelled" : "Response ended; inspect tool and validation receipts for the result.";
    if (type === "tool.complete") return `${toolFailed(payload) ? "Tool failed" : "Tool finished"}: ${text(payload.name || payload.tool_name || payload.tool, 160) || "tool"}${payload.summary ? " · " + text(payload.summary, 1000) : ""}`;
    if (type === "authority.commit") {
      const receipt = record(payload.receipt);
      return `${text(receipt.status, 80) || "Receipt"} · ${text(receipt.commit_id, 160)} · ${(Array.isArray(receipt.changed_paths) ? receipt.changed_paths.slice(0, 20).map(path => text(path, 240)) : []).join(", ")}`;
    }
    return text(payload.summary || payload.preview || payload.context || payload.message || payload.reason || payload.tool_preview || payload.name || payload.tool_name || payload.status || type);
  }
  function ingest(state, event) {
    event = record(event); const payload = record(event.payload), type = text(event.type, 120);
    if ((event.runtimeKey || payload.runtimeKey) && state.runtime?.runtimeKey && (event.runtimeKey || payload.runtimeKey) !== state.runtime.runtimeKey) return false;
    const eventSession = event.session_id || payload.session_id;
    if (!type || (eventSession && eventSession !== state.sessionId)) return false;
    if (!eventSession && !/^(gateway\.|bridge\.|backend\.)/.test(type)) return false;
    if (type === "message.delta" || /^(reasoning|thinking)\.delta$/.test(type)) return false;
    if (type === "message.start") state.phase = "working";
    if (type === "message.complete") {
      state.responseStatus = responseFailed(payload) ? "failed" : responseCancelled(payload) ? "cancelled" : "ended; result not verified";
      state.phase = responseFailed(payload) ? "error" : responseCancelled(payload) ? "cancelled" : "idle";
      const usage = record(payload.usage); state.usage = { model: text(usage.model, 256), cost_status: text(usage.cost_status, 80) };
      for (const key of ["input", "output", "total", "calls", "cache_read", "cache_write", "context_used", "context_max", "context_percent", "compressions", "cost_usd"])
        if (number(usage[key]) !== null) state.usage[key] = usage[key];
    }
    if (type === "gateway.ready") state.phase = "idle";
    if (["bridge.stopped", "backend.stopped", "backend.exited"].includes(type)) state.phase = "disconnected";
    if (["bridge.error", "error"].includes(type)) state.phase = "error";
    if (invalidatesHealth(event)) state.healthStale = true;
    const detail = eventSummary(type, payload);
    if (/^(reasoning|thinking)\./.test(type) && state.events.at(-1)?.type === type) return true;
    const row = { sequence: ++state.sequence, type, detail, observedAt: new Date().toISOString() };
    tail(state.events, row, MAX_EVENTS); state.eventCount++;
    if (type.startsWith('console.')) consoleResult(state, { ...payload, sessionId: eventSession }, type);
    if (type.startsWith("tool.")) {
      const name = text(payload.name || payload.tool_name || payload.tool, 160), id = text(payload.tool_id || payload.tool_call_id, 240);
      if (id) {
        const prior = state.tools.get(id);
        const tool = { ...prior, id, name: name || prior?.name || "Tool", status: type === "tool.complete" ? (toolFailed(payload) ? "failed" : "finished") : type === "tool.start" ? "running" : prior?.status || "reported", detail, observedAt: row.observedAt };
        if (number(payload.duration_s) !== null) tool.duration_s = payload.duration_s;
        if (typeof payload.inline_diff === "string") tool.inline_diff = text(payload.inline_diff, 12000);
        state.tools.set(id, tool); if (!prior) state.toolCount++;
        if (state.tools.size > MAX_TOOLS) state.tools.delete(state.tools.keys().next().value);
      }
      if (isTerminal(name)) tail(state.terminal, { ...row, name, tool_id: id, stdout: text(payload.stdout || record(payload.result).stdout, 12000), stderr: text(payload.stderr || record(payload.result).stderr, 4000), reported: true }, MAX_TERMINAL);
    }
    if (type.startsWith("subagent.")) {
      const id = text(payload.subagent_id || payload.task_id, 240);
      if (id) {
        const prior = state.agents.get(id) || {};
        const agent = { ...prior, id, goal: text(payload.goal, 2000) || prior.goal, model: text(payload.model, 256) || prior.model,
          status: text(payload.status, 80) || (type === "subagent.complete" ? "completed" : "running"), detail, source: "session event" };
        for (const key of ["depth", "tool_count", "duration_seconds", "input_tokens", "output_tokens", "api_calls", "cost_usd"])
          if (number(payload[key]) !== null) agent[key] = payload[key];
        state.agents.set(id, agent); if (state.agents.size > MAX_AGENTS) state.agents.delete(state.agents.keys().next().value);
      }
      if (isTerminal(payload.tool_name)) tail(state.terminal, { ...row, name: text(payload.tool_name, 160), reported: true }, MAX_TERMINAL);
    }
    return true;
  }
  function applyDelegation(state, value) {
    value = record(value);
    if (!Array.isArray(value.active)) throw new Error("The harness returned an invalid delegated-agent snapshot.");
    state.delegation = { activeCount: value.active.length, paused: value.paused, max_spawn_depth: value.max_spawn_depth, max_concurrent_children: value.max_concurrent_children };
    const active = new Set();
    for (const source of value.active.slice(0, MAX_AGENTS)) {
      const item = record(source), id = text(item.subagent_id || item.id, 240);
      if (!id) continue; active.add(id);
      state.agents.set(id, { ...state.agents.get(id), id, goal: text(item.goal, 2000), model: text(item.model, 256),
        status: text(item.status, 80) || "running", tool_count: number(item.tool_count), source: "runtime snapshot" });
    }
    for (const agent of state.agents.values()) if (agent.status === "running" && !active.has(agent.id)) agent.status = "no longer active (completion not reported)";
    while (state.agents.size > MAX_AGENTS) state.agents.delete(state.agents.keys().next().value);
  }

  function create(host, { api = {}, onError = () => {} } = {}) {
    const doc = host.ownerDocument || document, state = newState();
    const el = (tag, value = "", className = "") => { const node = doc.createElement(tag); node.textContent = value; node.className = className; return node; };
    const root = el("aside", "", "rc6-observer"); root.setAttribute("aria-label", "Coding runtime inspector"); root.id = "rc6-observer";
    const tabs = el("nav", "", "rc6-observer-tabs"); tabs.setAttribute("aria-label", "Coding inspector views");
    const toolbar = el("div", "", "rc6-observer-toolbar"), status = el("span", "Disconnected", "rc6-observer-status"), refreshButton = el("button", "Refresh"); refreshButton.type = "button"; refreshButton.id = "rc6-observer-refresh";
    const collapseButton = el("button", "Collapse inspector"); collapseButton.type = "button"; collapseButton.id = "rc6-observer-collapse";
    const error = el("p", "", "rc6-observer-error"); error.setAttribute("role", "status");
    const panels = {}; let activeTab = "tools", epoch = 0, disposed = false, flight = null, displayed = 50, search = "", collapsed = false;
    let healthRevision = 0, refreshAfterFlight = false;
    let consoleBusy = false, consoleDraft = '', consoleEpoch = 0;
    const runtimeName = () => state.runtime?.runtimeName || 'coding runtime';
    const tabLabels = { tools: "Tools", agents: "Agents", terminal: "Terminal", activity: "Activity", system: "System" };
    for (const [key, label] of Object.entries(tabLabels)) {
      const button = el("button", label); button.type = "button"; button.dataset.observerTab = key; button.setAttribute("aria-controls", `rc6-observer-${key}`);
      button.addEventListener("click", () => selectTab(key)); tabs.append(button);
      const panel = el("section", "", "rc6-observer-panel"); panel.id = `rc6-observer-${key}`; panels[key] = panel;
    }
    collapseButton.setAttribute("aria-controls", Object.values(panels).map(panel => panel.id).join(" "));
    collapseButton.addEventListener("click", () => { collapsed = !collapsed; host.classList.toggle("rc6-observer-collapsed", collapsed); render(); });
    toolbar.append(status, refreshButton, collapseButton); root.append(tabs, toolbar, error, ...Object.values(panels)); host.append(root);
    function note(parent, content) { parent.append(el("p", content, "rc6-observer-note")); }
    function metadata(parent, values) { const list = el("dl", "", "rc6-observer-facts"); for (const [label, value] of values) { list.append(el("dt", label), el("dd", shown(value))); } parent.append(list); }
    function empty(parent, content) { note(parent, content); }
    function drawTools() {
      const panel = panels.tools; panel.replaceChildren();
      const title = el("h3", `Tool calls · ${state.toolCount} observed`); panel.append(title);
      if (!state.tools.size) empty(panel, "No tool calls reported for this coding session.");
      if (state.toolCount > state.tools.size) note(panel, `Showing the latest ${state.tools.size} tool identities.`);
      for (const tool of [...state.tools.values()].reverse()) {
        const row = el("details", "", "rc6-observer-card"); row.append(el("summary", `${tool.name} · ${tool.status}${tool.duration_s == null ? "" : ` · ${tool.duration_s.toFixed(2)}s`}`));
        row.append(el("pre", tool.detail)); if (tool.inline_diff) row.append(el("pre", tool.inline_diff)); metadata(row, [["Tool call", tool.id]]); panel.append(row);
      }
      panel.append(el("h3", "Runtime capability inventory"));
      if (!state.inventory) return empty(panel, flight ? 'Checking ' + runtimeName() + ' capability inventory. Runtime discovery may take a moment…' : 'Connect a coding harness and refresh to inspect its actual tools, permissions and dependencies.');
      const inventory = state.inventory.capabilities;
      const searchBox = el("input"); searchBox.type = "search"; searchBox.value = search; searchBox.placeholder = "Search every capability"; searchBox.setAttribute("aria-label", "Search harness capabilities");
      const results = el("div"), count = el("p", "", "rc6-observer-note");
      const drawMatches = () => {
        results.replaceChildren(); const query = search.toLocaleLowerCase();
        const matches = inventory.filter(item => [item.name, item.capability_id, item.role, item.operational_state, item.health_reason].some(value => String(value || "").toLocaleLowerCase().includes(query)));
        count.textContent = `${Math.min(matches.length, displayed)} of ${matches.length} matching capabilities · ${inventory.length} returned by ${runtimeName()}`;
        for (const item of matches.slice(0, displayed)) {
          const card = el("details", "", "rc6-observer-card"); card.append(el("summary", `${text(item.name || item.capability_id, 180) || "Capability"} · ${text(item.operational_state || item.health, 80) || "state not reported"}`));
          metadata(card, [["Capability", item.capability_id], ["Role", item.role], ["Health", item.health], ["Health detail", item.health_reason], ["Permissions", item.permissions], ["Dependencies", item.dependencies], ["Runtime requirements", item.runtime_requirements], ["Mutation authority", item.mutation_authority], ["Read authority", item.read_authority], ["Provenance", item.provenance_policy], ["Rollback", item.rollback_behavior]]);
          const contract = el("details"); contract.append(el("summary", "Input / output contracts"), el("pre", shown({ input: item.input_contract, output: item.output_contract }))); card.append(contract); results.append(card);
        }
        if (matches.length > displayed) { const more = el("button", "Show more capabilities"); more.type = "button"; more.addEventListener("click", () => { displayed += 50; drawMatches(); }); results.append(more); }
        if (!matches.length) empty(results, "No capabilities match this search.");
      };
      searchBox.addEventListener("input", () => { search = searchBox.value; displayed = 50; drawMatches(); }); panel.append(searchBox, count, results); drawMatches();
    }
    function drawAgents() {
      const panel = panels.agents; panel.replaceChildren(); const running = [...state.agents.values()].filter(item => item.status === "running").length;
      panel.append(el("h3", `Delegated agents · ${running} reported running`));
      note(panel, 'Live delegated workers from this private ' + runtimeName() + '. Workforce source profiles remain available in the Desktop Workforce view.');
      if (state.delegation) metadata(panel, [["Snapshot active", state.delegation.activeCount], ["New delegation paused", state.delegation.paused], ["Concurrency limit", state.delegation.max_concurrent_children]]);
      if ((state.delegation?.activeCount || 0) > MAX_AGENTS) note(panel, `Showing at most ${MAX_AGENTS} agent records from this bounded inspector.`);
      if (!state.agents.size) return empty(panel, "No delegated agents have been reported. A model must actually delegate work before an agent appears here.");
      for (const agent of state.agents.values()) {
        const card = el("article", "", "rc6-observer-card"); card.append(el("strong", agent.goal || agent.id), el("p", `${agent.status} · ${agent.model || "model not reported"}`));
        metadata(card, [["Agent", agent.id], ["Tools observed", agent.tool_count], ["Duration (seconds)", agent.duration_seconds], ["Source", agent.source]]);
        if (agent.detail) card.append(el("pre", agent.detail));
        if (agent.status === "running" && typeof api.interruptAgent === "function") {
          const stop = el("button", "Interrupt agent"); stop.type = "button";
          stop.addEventListener("click", async () => { const expected = state.sessionId; stop.disabled = true; try { const result = await api.interruptAgent(expected, agent.id); if (expected !== state.sessionId || disposed) return; if (!result?.found) throw new Error("The agent is no longer active."); agent.status = "interrupt requested"; render(); } catch (failure) { fail(failure); } finally { stop.disabled = false; } }); card.append(stop);
        }
        panel.append(card);
      }
    }
    function drawTerminal() {
      const panel = panels.terminal; panel.replaceChildren(); panel.append(el("h3", "Terminal activity"));
      note(panel, 'Commands and output reported by ' + runtimeName() + '. A reported summary is shown when the runtime does not expose full output.');
      if (typeof api.console === "function") {
        note(panel, 'Repository console: pwd · dir [relative folder] · type <relative file>. Quote paths with spaces. Changes go through the coding conversation.');
        const form = el('form', '', 'rc6-observer-console'), input = el('input'), button = el('button', consoleBusy ? 'Running…' : 'Run read-only command');
        input.placeholder = 'pwd, dir, or type "file name.txt"'; input.setAttribute('aria-label', 'Coding repository console command'); input.maxLength = 2000;
        input.value = consoleDraft; input.disabled = consoleBusy || !state.sessionId || !state.runtime?.running;
        input.addEventListener('input', () => { consoleDraft = input.value; }); button.type = 'submit'; button.disabled = input.disabled;
        form.append(input, button); form.addEventListener('submit', async event => {
          event.preventDefault(); const command = input.value.trim(), expected = state.sessionId, expectedEpoch = consoleEpoch;
          if (!command || !expected || consoleBusy || !state.runtime?.running) return;
          consoleBusy = true; consoleDraft = input.value; state.error = ''; render();
          try {
            const result = await api.console(expected, command);
            if (disposed || expectedEpoch !== consoleEpoch || expected !== state.sessionId) return;
            if (!result || result.sessionId !== expected || (state.runtime.runtimeKey && result.runtimeKey !== state.runtime.runtimeKey)) throw new Error('Console result belongs to another session or runtime.');
            consoleResult(state, result); consoleDraft = '';
          } catch (failure) { if (expectedEpoch === consoleEpoch && expected === state.sessionId) fail(failure); }
          finally { if (!disposed && expectedEpoch === consoleEpoch) { consoleBusy = false; render(); } }
        }); panel.append(form);
      } else note(panel, "Request commands in the coding conversation to execute them through the runtime's governed tools.");
      if (!state.terminal.length) return empty(panel, "No terminal operations reported for this session.");
      for (const entry of state.terminal.slice().reverse()) {
        const card = el("article", "", "rc6-observer-card"); card.append(el("strong", entry.name || entry.type), el("pre", entry.detail));
        if (entry.stdout) card.append(el("pre", entry.stdout, "rc6-observer-stdout")); if (entry.stderr) card.append(el("pre", entry.stderr, "rc6-observer-stderr"));
        if (entry.code !== undefined) note(card, `Exit ${entry.code} · ${entry.policy || "policy not reported"}`);
        if (entry.reported && !entry.stdout && !entry.stderr) note(card, "Reported tool context / summary"); panel.append(card);
      }
    }
    function drawActivity() {
      const panel = panels.activity; panel.replaceChildren(); panel.append(el("h3", `Runtime events · ${state.eventCount} observed`));
      if (state.eventCount > state.events.length) note(panel, `Showing the latest ${state.events.length} events.`);
      if (!state.events.length) return empty(panel, "Waiting for runtime events.");
      for (const entry of state.events.slice().reverse()) { const card = el("article", "", "rc6-observer-card"); card.append(el("strong", entry.type), el("p", entry.detail), el("small", entry.observedAt)); panel.append(card); }
    }
    function drawSystem() {
      const panel = panels.system; panel.replaceChildren(); panel.append(el("h3", "Runtime and usage"));
      metadata(panel, [['Harness', state.runtime?.runtimeName], ['Authority', state.runtime?.authority], ['Verified executable', state.runtime?.verifiedDigest], ["Connection", state.runtime?.running ? "Connected" : "Disconnected"], ["Session", state.sessionId], ["Phase", state.phase], ["Latest response", state.responseStatus], ["Model", state.runtime?.model], ["Workspace", state.runtime?.workspace], ["Snapshot observed", state.snapshotAt]]);
      if (state.usage) {
        panel.append(el("h3", "Latest response usage")); metadata(panel, [["Reported model", state.usage.model], ["Input tokens", state.usage.input], ["Output tokens", state.usage.output], ["Total tokens", state.usage.total], ["Model calls", state.usage.calls], ["Context used", state.usage.context_used], ["Context maximum", state.usage.context_max], ["Cache read tokens", state.usage.cache_read], ["Cost", state.usage.cost_usd == null ? state.usage.cost_status || "Not reported" : `$${state.usage.cost_usd}`]]);
      } else note(panel, "Usage appears when the model reports a response. Missing values are not zero usage.");
      if (state.health) {
        const h = state.health, a = record(h.authority);
        panel.append(el("h3", state.healthStale ? `Health · stale (last reported ${shown(h.status)})` : `Health · ${shown(h.status)}`));
        metadata(panel, [["Health observed", state.healthObservedAt], ["Reasons", h.reasons], ["OrchestrationManager", a.orchestration_manager], ["Commit Service", a.commit_service], ["Validation separated", a.validation_commit_separated], ["Tool counts", h.tools], ["MCP", h.mcp], ["Skills", h.skills]]);
        if (state.healthStale) note(panel, "A runtime event occurred after this health response. Refresh to recheck the runtime.");
      } else note(panel, "Health unavailable. Connect the harness and refresh to request a health response.");
      if (state.info) metadata(panel, [["Harness", state.info.harness_id], ["Version", state.info.version], ["Architecture", state.info.architecture], ["Shell mode", state.info.shell_mode]]);
      for (const item of state.health?.roots || state.info?.roots || []) { const card = el("details", "", "rc6-observer-card"); card.append(el("summary", `${shown(item.id)} · ${item.present ? "present" : "not present"}`)); metadata(card, [["Role", item.role], ["Path", item.path], ["Authority", item.authority], ["Mutable", item.mutable]]); panel.append(card); }
    }
    function render() {
      if (disposed) return; status.textContent = `${runtimeName()} · ${state.runtime?.running ? "Connected" : "Disconnected"} · ${state.phase}${state.sessionId ? " · " + state.sessionId : ""}`; error.textContent = state.error;
      refreshButton.disabled = Boolean(flight) || !state.runtime?.running;
      tabs.hidden = collapsed; status.hidden = collapsed; error.hidden = collapsed; refreshButton.hidden = collapsed;
      collapseButton.textContent = collapsed ? "Expand inspector" : "Collapse inspector";
      collapseButton.setAttribute("aria-expanded", String(!collapsed));
      for (const button of tabs.children) button.setAttribute("aria-pressed", String(button.dataset.observerTab === activeTab));
      for (const [key, panel] of Object.entries(panels)) panel.hidden = collapsed || key !== activeTab;
      if (!collapsed) ({ tools: drawTools, agents: drawAgents, terminal: drawTerminal, activity: drawActivity, system: drawSystem })[activeTab]();
    }
    function selectTab(key) { if (!Object.hasOwn(panels, key)) return; activeTab = key; render(); }
    function fail(failure) { if (disposed) return; state.error = text(failure?.message || String(failure)); error.textContent = state.error; onError(state.error); }
    async function refresh() {
      if (disposed || !state.runtime?.running) return;
      if (flight) { refreshAfterFlight = true; return flight; }
      const expectedEpoch = epoch, expectedHealthRevision = healthRevision, session = state.sessionId;
      const requests = [["inventory", api.inventory], ["health", api.health], ["info", api.info], ...(session ? [["delegation", () => api.delegationStatus?.(session)]] : [])];
      state.error = "";
      const failures = [];
      const pending = Promise.allSettled(requests.map(async ([name, call]) => {
        try {
          if (typeof call !== "function") throw new Error("This runtime observation binding is unavailable.");
          const value = record(await call());
          if (disposed || epoch !== expectedEpoch) return;
          if (name === "inventory" && !Array.isArray(value.capabilities)) throw new Error("Invalid capability inventory");
          if (name === "health" && (typeof value.status !== "string" || !value.status.trim())) throw new Error("Invalid health response");
          if (name === "delegation") { if (session === state.sessionId) applyDelegation(state, value); }
          else if (name === "health") {
            state.health = value; state.healthObservedAt = new Date().toISOString();
            state.healthStale = healthRevision !== expectedHealthRevision;
          }
          else state[name] = value;
        } catch (failure) {
          if (disposed || epoch !== expectedEpoch) return;
          if (name === "health") state.healthStale = true;
          else state[name] = null;
          failures.push(`${name}: ${failure.message || "request failed"}`); state.error = failures.join(" · ");
        }
        if (!disposed && epoch === expectedEpoch) render();
      })); flight = pending; render();
      try {
        await pending; if (disposed || epoch !== expectedEpoch) return;
        state.snapshotAt = new Date().toISOString(); state.error = failures.join(" · ");
      } finally {
        if (flight === pending) flight = null;
        if (epoch === expectedEpoch) {
          render();
          if (refreshAfterFlight) { refreshAfterFlight = false; void refresh(); }
        }
      }
    }
    refreshButton.addEventListener("click", () => refresh()); render();
    return {
      onEvent(event) {
        if (disposed || !ingest(state, event)) return;
        if (invalidatesHealth(event)) healthRevision++;
        render();
        if (event.type === "gateway.ready" || (event.type === "tool.complete" && toolFailed(record(event.payload)))) void refresh();
      },
      setSession(id) { if (id === state.sessionId) return; consoleEpoch++; consoleBusy = false; consoleDraft = ''; state.error = ''; resetSession(state, typeof id === "string" ? id : null); render(); },
      setRuntime(value) { const prior = state.runtime; state.runtime = value && typeof value === "object" ? value : null; if (!state.runtime?.running || (prior && ['runtimeKey', "model", "workspace", "profile"].some(key => prior[key] !== state.runtime?.[key]))) { epoch++; healthRevision++; refreshAfterFlight = false; consoleEpoch++; consoleBusy = false; consoleDraft = ''; state.error = ''; flight = null; resetSession(state, null); state.inventory = null; state.health = null; state.healthObservedAt = null; state.healthStale = false; state.info = null; state.snapshotAt = null; } else if (state.phase === "disconnected") state.phase = "starting"; render(); },
      refresh, selectTab,
      dispose() { disposed = true; epoch++; root.remove(); },
    };
  }
  return { create, newState, resetSession, ingest, applyDelegation, isTerminal, consoleResult, responseFailed, responseCancelled, toolFailed };
});
