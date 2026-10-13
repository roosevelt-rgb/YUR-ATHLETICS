'use strict';
// Read-only rendering of bounded host observations. Timers update elapsed time
// and fetch snapshots; they never create request progress or infer reasoning.
(function (root, factory) {
  const view = factory();
  if (typeof module === 'object' && module.exports) module.exports = view;
  if (root) root.yurActivityView = view;
})(typeof window === 'object' ? window : null, function () {
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const MID = /^[a-f0-9]{32}$/;
  const states = { queued: 'Queued', running: 'Running', stopping: 'Stopping', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', awaiting_approval: 'Awaiting approval', unconfirmed: 'Unconfirmed' };
  const kinds = { chat: 'Chat', work: 'Work', code: 'Code', factory: 'Factory' };
  const origins = { conversation: 'Conversation', schedule: 'Scheduled task', factory: 'Factory' };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const text = (value, max) => typeof value === 'string' && value.length <= max * 2 && [...value].length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const instant = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
  const nullable = (value, check) => value === null || check(value);
  let instance = 0;

  function checkedSnapshot(value) {
    if (!object(value) || value.schema !== 'yur.activity.v1' || !UUID.test(value.session_id || '') || !count(value.sequence) || !instant(value.observed_at)
        || !Array.isArray(value.runs) || value.runs.length > 64 || !count(value.omitted_runs)) throw new Error('The host returned an invalid activity snapshot.');
    const seen = new Set(), observed = Date.parse(value.observed_at);
    const runs = value.runs.map(run => {
      if (!object(run) || !UUID.test(run.id || '') || seen.has(run.id) || !Object.hasOwn(kinds, run.kind) || !Object.hasOwn(origins, run.origin)
          || !nullable(run.conversation_id, item => UUID.test(item)) || !nullable(run.mission_id, item => MID.test(item))
          || !text(run.label, 80) || !text(run.phase, 160) || !nullable(run.provider, item => text(item, 64)) || !nullable(run.model, item => text(item, 256))
          || !Object.hasOwn(states, run.status) || typeof run.request_active !== 'boolean' || !count(run.output_chars) || run.output_chars > 1000000000
          || !instant(run.started_at) || !instant(run.updated_at) || !nullable(run.ended_at, instant)
          || Date.parse(run.started_at) > Date.parse(run.updated_at) || Date.parse(run.updated_at) > observed
          || (run.request_active && run.ended_at !== null) || (!run.request_active && run.ended_at === null)
          || (run.ended_at !== null && (Date.parse(run.ended_at) < Date.parse(run.started_at) || Date.parse(run.ended_at) > observed))
          || !Array.isArray(run.tools) || run.tools.length > 20 || !Array.isArray(run.events) || run.events.length > 80 || !count(run.omitted_events)) throw new Error('The host returned an invalid activity request.');
      seen.add(run.id);
      const toolIds = new Set();
      const tools = run.tools.map(tool => {
        if (!object(tool) || !MID.test(tool.id || '') || toolIds.has(tool.id) || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(tool.name)
            || !['running', 'completed', 'rejected'].includes(tool.status)) throw new Error('The host returned invalid tool activity.');
        toolIds.add(tool.id); return { id: tool.id, name: tool.name, status: tool.status };
      });
      let previous = 0;
      const events = run.events.map(event => {
        if (!object(event) || !count(event.sequence) || event.sequence <= previous || event.sequence > value.sequence || !instant(event.at)
            || Date.parse(event.at) < Date.parse(run.started_at) || Date.parse(event.at) > observed
            || !['lifecycle', 'status', 'model', 'tool', 'correction', 'output'].includes(event.kind) || !text(event.label, 160)
            || !nullable(event.step_id, item => MID.test(item))) throw new Error('The host returned invalid activity events.');
        previous = event.sequence; return { sequence: event.sequence, at: event.at, kind: event.kind, label: event.label, step_id: event.step_id };
      });
      // Deliberately project only declared telemetry: never retain a prompt,
      // response, arguments, tool output, diagnostics or model reasoning.
      return { id: run.id, kind: run.kind, origin: run.origin, conversation_id: run.conversation_id, mission_id: run.mission_id,
        label: run.label, provider: run.provider, model: run.model, status: run.status, phase: run.phase,
        started_at: run.started_at, updated_at: run.updated_at, ended_at: run.ended_at, request_active: run.request_active,
        output_chars: run.output_chars, tools, events, omitted_events: run.omitted_events };
    });
    return { session_id: value.session_id, sequence: value.sequence, observed_at: value.observed_at, runs, omitted_runs: value.omitted_runs };
  }
  function category(run) {
    if (run.status === 'unconfirmed') return 'unconfirmed';
    if (['queued', 'awaiting_approval'].includes(run.status)) return 'waiting';
    if (run.request_active) return 'active';
    return ['completed', 'failed', 'cancelled'].includes(run.status) ? 'finished' : 'unconfirmed';
  }
  function duration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function create(host, { snapshot, onEvent, onOpenWork, onOpenConversation, getConversationTitle, now = () => Date.now(), timers = globalThis } = {}) {
    if (!host?.ownerDocument || typeof snapshot !== 'function' || typeof onEvent !== 'function' || typeof now !== 'function'
        || typeof timers?.setInterval !== 'function' || typeof timers?.clearInterval !== 'function'
        || (onOpenWork !== undefined && typeof onOpenWork !== 'function') || (onOpenConversation !== undefined && typeof onOpenConversation !== 'function')
        || (getConversationTitle !== undefined && typeof getConversationTitle !== 'function')) throw new TypeError('Activity requires a host snapshot and subscription.');
    const document = host.ownerDocument, prefix = `yc-activity-${++instance}`;
    const node = (tag, text = '', className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };
    const section = node('section', '', 'yc-activity'); section.setAttribute('aria-label', 'Live Desktop activity');
    const header = node('div', '', 'yc-activity-heading'); header.append(node('h2', 'Activity'), node('p', 'Follow the requests and tools in this Desktop session.'));
    const connection = node('p', '', 'yc-activity-connection'); connection.setAttribute('role', 'status'); connection.setAttribute('aria-live', 'polite');
    const scope = node('p', 'Host-reported request activity and tool events. An active request does not prove the model is thinking. Private reasoning, prompts and tool contents are not shown. Earlier sessions remain in Recent work.', 'yc-activity-scope');
    const summary = node('div', '', 'yc-activity-summary'), totals = {};
    for (const [key, label] of [['active', 'Active'], ['waiting', 'Waiting'], ['finished', 'Finished'], ['unconfirmed', 'Unconfirmed']]) {
      const stat = node('div', '', 'yc-activity-stat'); stat.dataset.category = key;
      totals[key] = node('strong', '0'); stat.append(totals[key], node('span', label)); summary.appendChild(stat);
    }
    const controls = node('div', '', 'yc-activity-controls');
    function field(label, tag, className) {
      const wrapper = node('label', label, 'yc-activity-field'), input = node(tag, '', className); input.id = `${prefix}-${className}`; wrapper.htmlFor = input.id; wrapper.appendChild(input); controls.appendChild(wrapper); return input;
    }
    const search = field('Search activity', 'input', 'yc-activity-search'); search.type = 'search'; search.maxLength = 256; search.placeholder = 'Request, phase, model or tool';
    const filter = field('Show', 'select', 'yc-activity-filter');
    for (const [value, label] of [['all', 'All requests'], ['active', 'Active'], ['waiting', 'Waiting'], ['finished', 'Finished'], ['unconfirmed', 'Unconfirmed']]) { const option = node('option', label); option.value = value; filter.appendChild(option); } filter.value = 'all';
    const refreshButton = node('button', 'Refresh now', 'yc-activity-refresh'); refreshButton.type = 'button'; controls.appendChild(refreshButton);
    const error = node('p', '', 'yc-activity-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const coverage = node('p', '', 'yc-activity-coverage'), results = node('div', '', 'yc-activity-results'); results.setAttribute('role', 'list');
    section.append(header, connection, scope, summary, controls, error, coverage, results); host.appendChild(section);
    let disposed = false, current = null, requestGeneration = 0, refreshing = false, lastSuccess = null, lastFailure = null, pushError = '', unsubscribe = null;
    let lastPoll = now(); const retired = new Set(), cards = new Map();
    const active = () => !disposed && section.parentNode === host && host.isConnected !== false;
    const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
    function conversationTitle(run) {
      if (!run.conversation_id || !getConversationTitle) return '';
      try { const value = getConversationTitle(run.conversation_id); return text(value, 200) ? value.trim() : ''; } catch { return ''; }
    }
    function showError(message) { if (active()) { error.textContent = message; error.hidden = !message; } }
    function paintFreshness() {
      if (!active()) return;
      const age = lastSuccess === null ? null : Math.max(0, now() - lastSuccess);
      const stale = age !== null && age > 6000;
      const status = lastSuccess === null ? lastFailure !== null ? 'disconnected' : 'connecting' : stale ? lastFailure !== null ? 'disconnected' : 'stale' : lastFailure !== null ? 'reconnecting' : 'live';
      connection.dataset.state = status;
      setText(connection, status === 'connecting' ? 'Connecting to host telemetry…' : status === 'disconnected' ? 'Telemetry disconnected · retained observations only' : status === 'stale' ? 'Telemetry stale · waiting for a fresh host snapshot' : status === 'reconnecting' ? 'Snapshot refresh failed · reconnecting' : 'Connected to host telemetry');
      section.dataset.freshness = status;
      for (const card of cards.values()) {
        const run = card.run, until = run.ended_at === null ? now() : Date.parse(run.ended_at);
        setText(card.elapsed, `Request elapsed ${duration(until - Date.parse(run.started_at))}`);
        setText(card.age, `Last event ${duration(now() - Date.parse(run.updated_at))} ago`);
      }
      if (current) setText(coverage, `${current.runs.length} retained requests · ${current.omitted_runs} omitted · Snapshot ${new Date(current.observed_at).toLocaleTimeString()}${age === null ? '' : ` (${duration(age)} ago)`}${pushError ? ' · Live push unavailable; polling every 2 seconds.' : ' · Polling every 2 seconds.'}`);
    }
    function action(label, className, callback) {
      const button = node('button', label, className); button.type = 'button'; button.disabled = !callback;
      button.addEventListener('click', async () => {
        if (!active() || button.disabled || !callback) return;
        button.disabled = true; showError('');
        try { await callback(); } catch (failure) { showError(typeof failure?.message === 'string' ? failure.message.slice(0, 1000) : 'The retained record could not be opened.'); }
        finally { if (active()) button.disabled = false; }
      });
      return button;
    }
    function newCard(run) {
      const element = node('article', '', 'yc-activity-card'); element.dataset.requestId = run.id; element.setAttribute('role', 'listitem');
      const heading = node('div', '', 'yc-activity-card-heading'), title = node('h3'), state = node('span', '', 'yc-activity-state'); title.id = `${prefix}-${run.id}`; element.setAttribute('aria-labelledby', title.id); heading.append(title, state);
      const origin = node('p', '', 'yc-activity-origin'), phase = node('p', '', 'yc-activity-phase'), tracking = node('p', '', 'yc-activity-tracking');
      const resource = node('p', '', 'yc-activity-resource'), times = node('div', '', 'yc-activity-times'), elapsed = node('span'), age = node('span'); times.append(elapsed, age);
      const output = node('p', '', 'yc-activity-output'), tools = node('ul', '', 'yc-activity-tools'); tools.setAttribute('aria-label', 'Observed tool states');
      const timeline = node('details', '', 'yc-activity-timeline'), timelineTitle = node('summary'), events = node('ol'), omitted = node('p', '', 'yc-activity-omitted'); timeline.append(timelineTitle, events, omitted);
      const actions = node('div', '', 'yc-activity-actions');
      element.append(heading, origin, phase, tracking, resource, times, output, tools, timeline, actions);
      const card = { element, title, state, origin, phase, tracking, resource, elapsed, age, output, tools, timeline, timelineTitle, events, omitted, actions, run, key: '', actionKey: '', eventNodes: new Map() };
      cards.set(run.id, card); return card;
    }
    function updateCard(card, run, localTitle) {
      card.run = run;
      const key = JSON.stringify([run, localTitle]); if (card.key === key) return; card.key = key;
      card.element.dataset.status = run.status; card.element.dataset.category = category(run);
      setText(card.title, localTitle || run.label || `${kinds[run.kind]} request`); setText(card.state, states[run.status]);
      setText(card.origin, `${kinds[run.kind]} · ${origins[run.origin]} · Request ${run.id.slice(0, 8)}`); setText(card.phase, run.phase);
      setText(card.tracking, run.request_active ? 'Request active in the last host snapshot' : 'Request no longer active in the last host snapshot');
      setText(card.resource, [run.provider, run.model].filter(Boolean).join(' · ') || 'Provider/model not reported');
      setText(card.output, run.output_chars ? `${run.output_chars.toLocaleString()} output characters observed` : 'No output characters reported');
      const toolKey = JSON.stringify([run.tools, run.request_active]);
      if (card.tools.dataset.key !== toolKey) {
        card.tools.dataset.key = toolKey;
        card.tools.replaceChildren(...run.tools.map(tool => {
          const item = node('li'); item.dataset.stepId = tool.id;
          const status = tool.status === 'running' && !run.request_active ? 'Last observed running; completion not observed' : states[tool.status] || 'Rejected';
          item.append(node('code', tool.name), node('span', status)); return item;
        }));
      }
      setText(card.timelineTitle, `Event timeline · ${run.events.length} retained`); setText(card.omitted, run.omitted_events ? `${run.omitted_events} earlier events omitted.` : 'Only fixed host event summaries are shown.');
      const retained = new Set(); let position = 0;
      for (const event of run.events) {
        retained.add(event.sequence); let item = card.eventNodes.get(event.sequence);
        if (!item) { item = node('li'); const time = node('time', new Date(event.at).toLocaleTimeString()); time.dateTime = event.at; time.title = event.at; item.append(time, node('span', event.label)); item.dataset.eventSequence = String(event.sequence); card.eventNodes.set(event.sequence, item); }
        if (card.events.children[position] !== item) card.events.insertBefore(item, card.events.children[position] || null); position++;
      }
      for (const [sequence, item] of card.eventNodes) if (!retained.has(sequence)) { item.remove(); card.eventNodes.delete(sequence); }
      const actionKey = `${run.mission_id}:${run.conversation_id}`;
      if (card.actionKey !== actionKey) {
        card.actionKey = actionKey; card.actions.replaceChildren();
        if (run.mission_id) { const id = run.mission_id; card.actions.appendChild(action('Open work record', 'yc-activity-open-work', onOpenWork && (() => onOpenWork(id)))); }
        if (run.conversation_id) { const id = run.conversation_id; card.actions.appendChild(action('Open conversation', 'yc-activity-open-conversation', onOpenConversation && (() => onOpenConversation(id)))); }
      }
    }
    function render() {
      if (!active()) return;
      const rows = current?.runs || [], counts = { active: 0, waiting: 0, finished: 0, unconfirmed: 0 }, ids = new Set(rows.map(run => run.id));
      for (const run of rows) counts[category(run)]++;
      for (const key of Object.keys(totals)) setText(totals[key], String(counts[key]));
      for (const [id, card] of cards) if (!ids.has(id)) { card.element.remove(); cards.delete(id); }
      const query = search.value.trim().toLocaleLowerCase();
      const titles = new Map(rows.map(run => [run.id, conversationTitle(run)]));
      const visible = rows.filter(run => (filter.value === 'all' || category(run) === filter.value)
        && (!query || [titles.get(run.id), run.id, run.label, run.phase, run.provider, run.model, kinds[run.kind], origins[run.origin], ...run.tools.map(tool => tool.name)].join('\n').toLocaleLowerCase().includes(query)));
      visible.sort((a, b) => Number(category(b) === 'active') - Number(category(a) === 'active') || Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.id.localeCompare(b.id));
      const shown = new Set(); let position = 0;
      for (const run of visible) { const card = cards.get(run.id) || newCard(run); updateCard(card, run, titles.get(run.id)); shown.add(card.element); if (results.children[position] !== card.element) results.insertBefore(card.element, results.children[position] || null); position++; }
      for (const child of [...results.children]) if (!shown.has(child)) child.remove();
      if (!visible.length) results.appendChild(node('p', !current ? 'Waiting for a verified host snapshot.' : !rows.length ? 'No requests observed in this Desktop session yet.' : 'No requests match these filters.', 'yc-activity-empty'));
      paintFreshness();
    }
    function accept(value, fromSnapshot) {
      const next = checkedSnapshot(value);
      if (current && next.session_id !== current.session_id) {
        if (!fromSnapshot || retired.has(next.session_id)) return false;
        retired.add(current.session_id); if (retired.size > 64) retired.delete(retired.values().next().value);
        for (const card of cards.values()) card.element.remove(); cards.clear();
      } else if (current && (next.sequence < current.sequence || (next.sequence === current.sequence && Date.parse(next.observed_at) < Date.parse(current.observed_at)))) return false;
      const same = current && next.session_id === current.session_id && next.sequence === current.sequence;
      if (same && !fromSnapshot && next.observed_at === current.observed_at) return false;
      current = same ? { ...current, observed_at: next.observed_at } : next;
      section.dataset.sessionId = current.session_id; section.dataset.sequence = String(current.sequence);
      lastSuccess = now(); lastFailure = null; showError(''); render(); return true;
    }
    async function refresh() {
      if (!active()) return false;
      const generation = ++requestGeneration; refreshing = true; lastPoll = now(); refreshButton.disabled = true; section.setAttribute('aria-busy', 'true');
      try {
        const response = await snapshot();
        if (!active() || generation !== requestGeneration) return false;
        if (!response?.ok) throw new Error('The host activity snapshot is unavailable.');
        return accept(response.result, true);
      } catch (failure) {
        if (active() && generation === requestGeneration) { lastFailure = now(); showError('Activity could not refresh. Retained observations do not confirm that a request is still active.'); paintFreshness(); }
        return false;
      } finally { if (active() && generation === requestGeneration) { refreshing = false; refreshButton.disabled = false; section.setAttribute('aria-busy', 'false'); } }
    }
    search.addEventListener('input', render); filter.addEventListener('change', render); refreshButton.addEventListener('click', refresh);
    try {
      unsubscribe = onEvent(value => {
        if (!active()) return;
        try { accept(value, false); } catch { showError('An invalid activity update was ignored. Waiting for a verified host snapshot.'); }
      });
      if (typeof unsubscribe !== 'function') { unsubscribe = null; throw new Error('No subscription cleanup supplied'); }
    } catch { pushError = 'unavailable'; }
    const timer = timers.setInterval(() => {
      if (!active()) { dispose(); return; }
      paintFreshness(); if (!refreshing && now() - lastPoll >= 2000) void refresh();
    }, 1000);
    function dispose() {
      if (disposed) return; disposed = true; requestGeneration++; timers.clearInterval(timer);
      try { unsubscribe?.(); } catch {} unsubscribe = null;
      search.removeEventListener('input', render); filter.removeEventListener('change', render); refreshButton.removeEventListener('click', refresh);
      cards.clear(); if (section.parentNode === host) host.removeChild(section);
    }
    render(); void refresh();
    return Object.freeze({ refresh, dispose });
  }
  return Object.freeze({ create });
});
