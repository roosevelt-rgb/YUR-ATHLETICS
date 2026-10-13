'use strict';
const { createHash } = require('node:crypto');
// Bounded adapter over the existing coding transport. The gateway remains the
// execution owner; Desktop Work retains mission/action receipts and admission.
const ACTIONS = Object.freeze(['coding_start', 'coding_submit', 'coding_status', 'coding_wait', 'coding_cancel']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 1000) => {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\0/g, '').slice(0, limit);
  return Buffer.byteLength(cleaned) <= limit ? cleaned : Buffer.from(cleaned).subarray(0, limit).toString('utf8').replace(/\uFFFD+$/, '');
};
const terminal = state => ['completed', 'failed', 'cancelled', 'uncertain', 'stale'].includes(state);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{32}$/;
const sessionId = /^[A-Za-z0-9_.:-]{1,200}$/;
const fields = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
function approvalFingerprint(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) throw new Error('Native approval exceeds its scope budget.');
  function ordered(item, depth = 0) {
    if (depth > 16) throw new Error('Native approval exceeds its nesting budget.');
    if (Array.isArray(item)) return item.map(child => ordered(child, depth + 1));
    if (object(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key], depth + 1)]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

function createFranklinCoding({ runtime, resolveSelection, getModelCatalog, onEvent = () => {} }) {
  if (!runtime || typeof runtime.status !== 'function') throw new Error('Coding transport is required.');
  const sessions = new Map(), actions = new Set(), waiters = new Set(), challengeScopes = new Map();
  let generation = 0, connection = null, starting = false;
  function publicRuntime(value) {
    return { running: value.running === true, runtime_key: text(value.runtimeKey, 100), runtime_name: text(value.runtimeName, 160),
      workspace: text(value.workspace, 4096), model: text(value.model, 256), verified: Boolean(value.verifiedDigest) };
  }
  function signal(record, eventType) {
    record.sequence++; record.updated_at = new Date().toISOString();
    for (const listener of [...waiters]) listener();
    try { onEvent({ type: 'coding.event', event_type: eventType, session_id: record.id, runtime_key: record.runtime.runtime_key,
      status: record.status, sequence: record.sequence, origin: { ...record.origin }, action: record.action ? { ...record.action } : null,
      pending_approvals: [...record.approvals.values()].map(value => ({ ...value })) }); } catch { /* UI telemetry has no execution authority. */ }
  }
  function invalidate(reason) {
    generation++;
    for (const record of sessions.values()) {
      if (record.status === 'stale') continue;
      record.prior_status = record.status; record.status = 'stale'; record.notice = reason; record.approvals.clear();
      signal(record, 'connection.invalidated');
    }
  }
  const connectionKey = value => JSON.stringify([value.running === true, value.runtimeKey, value.workspace, value.model, value.baseUrl, value.verifiedDigest]);
  function observedRuntime() {
    const value = runtime.status();
    if (!object(value)) throw new Error('Coding transport returned an invalid status.');
    return value;
  }
  function synchronize() {
    const value = observedRuntime(), key = connectionKey(value);
    if (connection !== null && connection !== key) invalidate('The coding connection changed. Create a new Franklin coding session.');
    connection = key;
    return value;
  }
  function identityChecked(identity) {
    if (!object(identity) || !identity.owner || !uuid.test(String(identity.request_id)) || !hex.test(String(identity.mission_id))
      || !hex.test(String(identity.action_id)) || (identity.isActive !== undefined && (typeof identity.isActive !== 'function' || !identity.isActive()))) {
      throw new Error('A current Franklin request and committed action identity are required.');
    }
    if (typeof identity.owner.isDestroyed === 'function' && identity.owner.isDestroyed()) throw new Error('The Franklin owner window is unavailable.');
    return identity;
  }
  function provenance(identity) { return { request_id: identity.request_id, mission_id: identity.mission_id, action_id: identity.action_id }; }
  function availableAction(identity) {
    const key = identity.mission_id + ':' + identity.action_id;
    if (actions.has(key)) throw new Error('This coding action identity was already used; inspect its session instead of repeating it.');
    if (actions.size >= 4096) throw new Error('Franklin coding action retention is full; restart Desktop after inspecting retained work.');
    return key;
  }
  function reserve(identity) { actions.add(availableAction(identity)); }
  function owned(id, owner, requireCurrent = true) {
    synchronize();
    const record = sessions.get(id);
    if (!record || record.owner !== owner) throw new Error('This coding session does not belong to Franklin in this window.');
    if (requireCurrent && (record.generation !== generation || record.status === 'stale')) throw new Error('The coding session is stale after a connection change.');
    return record;
  }
  function snapshot(record) {
    const events = []; let bytes = 0;
    for (const event of record.events.slice().reverse()) {
      const encoded = JSON.stringify(event);
      if (bytes + Buffer.byteLength(encoded) > 32000) break;
      events.unshift(JSON.parse(encoded)); bytes += Buffer.byteLength(encoded);
    }
    return { session_id: record.id, runtime: { ...record.runtime }, status: record.status, prior_status: record.prior_status || null,
      sequence: record.sequence, origin: { ...record.origin }, action: record.action ? { ...record.action } : null,
      cancel_action: record.cancel_action ? { ...record.cancel_action } : null, role: record.role || null,
      output: record.output, output_truncated: record.output_truncated, events_omitted: record.events_omitted + record.events.length - events.length,
      events, pending_approvals: [...record.approvals.values()].map(value => ({ ...value })),
      notice: record.notice, updated_at: record.updated_at, runtime_completed: record.status === 'completed',
      trust: 'untrusted-runtime-evidence', authority: 'context-only' };
  }
  function keepEvent(record, event) {
    record.events.push(event);
    if (record.events.length > 24) { record.events.shift(); record.events_omitted++; }
  }
  function appendOutput(record, value) {
    const next = record.output + text(value, 16385);
    if (Buffer.byteLength(next) > 16384 || (typeof value === 'string' && Buffer.byteLength(value) > 16384)) record.output_truncated = true;
    record.output = Buffer.byteLength(next) > 16384 ? Buffer.from(next).subarray(-16384).toString('utf8').replace(/^\uFFFD+/, '') : next;
  }
  function ingest(event) {
    if (!object(event)) return false;
    const payload = object(event.payload) ? event.payload : {}, type = text(event.type, 100);
    if (type === 'bridge.stopped' || type === 'bridge.error') {
      const current = runtime.status();
      if (event.runtimeKey && event.runtimeKey !== current.runtimeKey) return false;
      invalidate('The coding runtime disconnected. Its earlier sessions cannot be reused.'); connection = null; return true;
    }
    const record = sessions.get(event.session_id || payload.session_id);
    if (!record || !type || /^(reasoning|thinking)\./.test(type)) return false;
    synchronize();
    if (record.generation !== generation || record.status === 'stale' || (event.runtimeKey && event.runtimeKey !== record.runtime.runtime_key)) return false;
    if (!record.action || ['completed', 'failed', 'cancelled'].includes(record.status)) return false;
    if (payload.kind === 'ApprovalRequest' && typeof payload.request_id === 'string' && record.status !== 'cancel_requested') {
      let fingerprint;
      try { fingerprint = approvalFingerprint({ session_id: record.id, runtime_key: record.runtime.runtime_key, payload }); }
      catch { record.status = 'uncertain'; record.notice = 'Native approval scope could not be validated.'; signal(record, 'approval.invalidated'); return false; }
      const prior = challengeScopes.get(payload.request_id);
      if (prior) {
        if (prior.fingerprint === fingerprint) return false;
        prior.state = 'conflicted';
        const previous = sessions.get(prior.session_id);
        if (previous) { previous.approvals.delete(payload.request_id); if (!terminal(previous.status)) previous.status = 'uncertain';
          previous.notice = 'A native approval identifier was reused with a changed scope. No decision may be sent for that identifier.'; signal(previous, 'approval.invalidated'); }
        record.status = 'uncertain'; record.notice = 'Conflicting native approval identity; inspect the coding runtime.';
        if (record !== previous) signal(record, 'approval.invalidated');
        return false;
      }
      if (challengeScopes.size >= 4096) { record.status = 'uncertain'; record.notice = 'Native approval retention is full; inspect retained work.'; signal(record, 'approval.invalidated'); return false; }
      challengeScopes.set(payload.request_id, { fingerprint, session_id: record.id, state: 'pending' });
      if (record.approvals.size >= 8 && !record.approvals.has(payload.request_id)) {
        record.status = 'uncertain'; record.notice = 'Native approval budget exceeded; inspect the coding runtime.';
      } else {
        record.approvals.set(payload.request_id, { request_id: text(payload.request_id, 200),
          description: text(payload.description || payload.reason, 2000), tool: text(payload.tool?.name || payload.source?.logical_id, 160),
          destination_model: text(payload.destination?.model, 256), human_review_required: true });
        record.status = 'awaiting_approval'; record.notice = 'The native runtime is waiting for the operator to decide this exact request.';
      }
    } else if (type === 'approval.invalidated') {
      record.approvals.delete(payload.request_id);
      const prior = challengeScopes.get(payload.request_id); if (prior) prior.state = 'conflicted';
      record.status = 'uncertain'; record.notice = 'The coding transport invalidated a changed native approval scope. Inspect the runtime before continuing.';
    } else if (type === 'message.delta') {
      appendOutput(record, payload.delta ?? payload.text ?? payload.content);
    } else if (type === 'message.complete') {
      if (!record.output) appendOutput(record, payload.text ?? payload.content);
      record.status = payload.error || ['error', 'failed'].includes(payload.status) ? 'failed'
        : payload.cancelled === true || payload.status === 'cancelled' ? 'cancelled' : 'completed';
      record.approvals.clear(); record.notice = 'Runtime response ended. Tool and validation receipts determine what was actually accomplished.';
    } else if (type === 'error') {
      record.status = 'failed'; record.approvals.clear(); record.notice = 'The coding runtime reported an error; inspect the bounded event evidence.';
    } else if (['session.cancelled', 'session.interrupted'].includes(type)) {
      record.status = 'cancelled'; record.approvals.clear(); record.notice = 'The coding runtime reported that this session was interrupted.';
    }
    if (type !== 'message.delta') {
      const receipt = object(payload.receipt) ? payload.receipt : {};
      keepEvent(record, { type, tool_id: text(payload.tool_id || payload.tool_call_id, 160),
        name: text(payload.name || payload.tool_name, 160), summary: text(payload.summary || payload.preview || payload.message || payload.reason || payload.status, 1000),
        stdout: text(payload.stdout || payload.result?.stdout, 1000), stderr: text(payload.stderr || payload.result?.stderr, 1000),
        commit_id: text(receipt.commit_id, 160), receipt_status: text(receipt.status, 100),
        request_id: text(receipt.request_id || payload.request_id, 200), validation: text(receipt.validation, 100),
        approved: typeof receipt.approved === 'boolean' ? receipt.approved : null,
        data_read: typeof receipt.data_read === 'boolean' ? receipt.data_read : null,
        execution_count: Number.isSafeInteger(receipt.execution_count) && receipt.execution_count >= 0 ? receipt.execution_count : null,
        changed_paths: Array.isArray(receipt.changed_paths) ? receipt.changed_paths.slice(0, 8).map(value => text(value, 256)) : [] });
    }
    signal(record, type); return true;
  }
  function selectionFor(model) {
    if (typeof resolveSelection !== 'function') throw new Error('The host has not bound coding model selection.');
    const selection = resolveSelection(model);
    if (!object(selection) || typeof selection.model !== 'string' || !selection.model || typeof selection.baseUrl !== 'string' || !selection.baseUrl) {
      throw new Error('The host returned an invalid configured coding model.');
    }
    return selection;
  }
  const compatible = (current, selection) => !current.running || (current.model === selection.model && current.baseUrl === selection.baseUrl);
  // Pure admission checks: no runtime calls other than status, no reservations,
  // no synchronization events. The broker uses these before a human dialog;
  // execute repeats them after that dialog and before any native mutation.
  function preflight(action, payload, identity) {
    identityChecked(identity);
    if (!ACTIONS.includes(action)) throw new Error('Unsupported Franklin coding action.');
    if (!object(payload) || Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024) throw new Error('Coding payload exceeds its 64 KiB context budget.');
    const current = observedRuntime();
    if (action === 'coding_start') {
      if (!fields(payload, ['runtime_key', 'workspace', 'model']) || typeof payload.runtime_key !== 'string' || typeof payload.workspace !== 'string'
        || !['rc6', 'construction-v1'].includes(payload.runtime_key) || !payload.workspace.trim() || payload.workspace.length > 4096
        || typeof payload.model !== 'string' || !payload.model.trim() || payload.model.length > 200) throw new Error('Select an explicit coding runtime, current workspace, and configured model.');
      if (payload.runtime_key !== current.runtimeKey || payload.workspace !== current.workspace) throw new Error('Choose this runtime and workspace in Coding first. Franklin does not switch an occupied runtime or workspace.');
      if (starting) throw new Error('A Franklin coding session is already being created.');
      if (sessions.size >= 64) throw new Error('Franklin coding session retention is full; inspect retained sessions before restarting Desktop.');
      const selection = selectionFor(payload.model);
      if (!compatible(current, selection)) throw new Error('The connected coding runtime uses a different model or provider. Select the intended connection in Coding first.');
      availableAction(identity);
      return { current, selection };
    }
    const expectedFields = action === 'coding_submit' ? ['session_id', 'text', ...('role' in payload ? ['role'] : [])]
      : action === 'coding_wait' ? ['session_id', ...('timeout_ms' in payload ? ['timeout_ms'] : [])] : ['session_id'];
    if (!fields(payload, expectedFields) || typeof payload.session_id !== 'string' || !sessionId.test(payload.session_id)) throw new Error('Coding actions require an exact owned session and typed payload.');
    if ('role' in payload && (typeof payload.role !== 'string' || !payload.role.trim() || payload.role.length > 100)) throw new Error('Coding role must be bounded nonblank metadata.');
    const record = sessions.get(payload.session_id);
    if (!record || record.owner !== identity.owner) throw new Error('This coding session does not belong to Franklin in this window.');
    if (!['coding_status', 'coding_wait'].includes(action) && (record.generation !== generation || record.status === 'stale'
      || (connection !== null && connectionKey(current) !== connection))) throw new Error('The coding session is stale after a connection change.');
    if (action === 'coding_wait') {
      const timeout = payload.timeout_ms ?? 25000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 25000) throw new Error('Coding wait must be between 1 and 25000 milliseconds.');
    }
    if (action === 'coding_submit') {
      if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 64000) throw new Error('Enter a bounded coding instruction under 64001 characters.');
      if (!['ready', 'completed', 'cancelled', 'failed'].includes(record.status)) throw new Error('This Franklin coding session has active or unresolved work. Inspect or cancel it first.');
      availableAction(identity);
    }
    if (action === 'coding_cancel') {
      if (terminal(record.status) || record.status === 'ready') throw new Error('This coding session has no confirmed active request to cancel.');
      availableAction(identity);
    }
    return { current };
  }
  function validate(action, payload, identity) {
    const checked = preflight(action, payload, identity);
    return { valid: true, action, runtime: publicRuntime(checked.current) };
  }
  async function execute(action, payload, identity) {
    const checked = preflight(action, payload, identity);
    synchronize();
    if (action === 'coding_start') {
      const { current, selection } = checked;
      reserve(identity); starting = true;
      try {
        const beforeStart = generation;
        if (!current.running) await runtime.start(selection);
        identityChecked(identity);
        if (beforeStart !== generation) throw new Error('The coding connection changed during the start request.');
        const connected = synchronize();
        if (!connected.running || connected.runtimeKey !== payload.runtime_key || connected.workspace !== payload.workspace
          || connected.model !== selection.model || connected.baseUrl !== selection.baseUrl || (current.running && beforeStart !== generation)) {
          throw new Error('The coding runtime changed during connection. Inspect its actual selection before continuing.');
        }
        const expected = generation;
        const created = await runtime.createSession();
        synchronize();
        if (expected !== generation) throw new Error('The coding connection changed while creating the Franklin session.');
        if (!object(created) || typeof created.session_id !== 'string' || !sessionId.test(created.session_id) || sessions.has(created.session_id)) {
          throw new Error('The coding runtime returned an invalid or reused session identity.');
        }
        const record = { id: created.session_id, owner: identity.owner, generation, runtime: publicRuntime(connected), origin: provenance(identity),
          action: null, status: 'ready', sequence: 0, output: '', output_truncated: false, events: [], events_omitted: 0,
          approvals: new Map(), notice: 'Franklin session created. No build prompt has been submitted.', updated_at: new Date().toISOString() };
        sessions.set(record.id, record); signal(record, 'session.created'); identityChecked(identity);
        return snapshot(record);
      } finally { starting = false; }
    }
    const record = owned(payload.session_id, identity.owner, !['coding_status', 'coding_wait'].includes(action));
    if (action === 'coding_status') return snapshot(record);
    if (action === 'coding_wait') {
      const timeout = payload.timeout_ms ?? 25000;
      if (!terminal(record.status) && !['ready', 'awaiting_approval'].includes(record.status)) {
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); waiters.delete(check); resolve(); };
          const check = () => { if (terminal(record.status) || record.status === 'awaiting_approval') finish(); };
          const timer = setTimeout(finish, timeout); waiters.add(check); check();
        });
      }
      identityChecked(identity); owned(record.id, identity.owner, false); return snapshot(record);
    }
    if (action === 'coding_submit') {
      reserve(identity); record.action = provenance(identity); record.status = 'submitting'; record.output = ''; record.output_truncated = false;
      record.cancel_action = null; record.role = payload.role || null;
      record.events = []; record.events_omitted = 0; record.approvals.clear(); record.notice = 'Submitting the exact operator-admitted build request.';
      signal(record, 'prompt.submitting');
      try {
        await runtime.submit(record.id, payload.text);
        owned(record.id, identity.owner);
        if (record.status === 'submitting') { record.status = 'running'; record.notice = 'Build request accepted; awaiting runtime events.'; signal(record, 'prompt.accepted'); }
        identityChecked(identity); return snapshot(record);
      } catch (error) {
        if (!terminal(record.status) && record.status !== 'awaiting_approval') { record.status = 'uncertain'; record.notice = 'Submission outcome is uncertain. Do not repeat this build; inspect its runtime session.'; signal(record, 'prompt.uncertain'); }
        throw error;
      }
    }
    reserve(identity); record.cancel_action = provenance(identity); record.status = 'cancel_requested';
    record.approvals.clear();
    record.notice = 'Interruption requested for this Franklin session only; awaiting the native runtime outcome.'; signal(record, 'cancel.requested');
    try { await runtime.interrupt(record.id); owned(record.id, identity.owner); identityChecked(identity); return snapshot(record); }
    catch (error) { if (!terminal(record.status)) { record.status = 'uncertain'; record.notice = 'Interruption outcome is uncertain; inspect the coding runtime.'; signal(record, 'cancel.uncertain'); } throw error; }
  }
  // This is a human-interface method, deliberately absent from ACTIONS/catalog.
  async function approval(sessionId, requestId, choice, owner) {
    const record = owned(sessionId, owner);
    if (!['approve', 'deny'].includes(choice) || !record.approvals.has(requestId)) throw new Error('This native approval is absent or already answered.');
    const scope = challengeScopes.get(requestId);
    if (!scope || !['pending', 'deciding'].includes(scope.state)) throw new Error('This native approval scope was invalidated.');
    const request = record.approvals.get(requestId);
    if (request.deciding) throw new Error('This native approval decision is already in flight.');
    request.deciding = true; scope.state = 'deciding';
    try {
      await runtime.approval(sessionId, requestId, choice); owned(sessionId, owner);
      if (scope.state === 'conflicted') throw new Error('Native approval scope changed while its decision was in flight.');
      scope.state = 'completed';
      record.approvals.delete(requestId);
      if (record.status === 'awaiting_approval' && !record.approvals.size) record.status = 'running';
      record.notice = 'Human decision sent to the native runtime; awaiting its outcome.'; signal(record, 'approval.decided'); return snapshot(record);
    } catch (error) { if (scope.state !== 'conflicted') scope.state = 'uncertain'; record.approvals.delete(requestId); if (!terminal(record.status)) { record.status = 'uncertain'; record.notice = 'Native approval outcome is uncertain; do not repeat the decision.'; signal(record, 'approval.uncertain'); } throw error; }
  }
  function status() {
    const current = synchronize(), retained = [...sessions.values()];
    return { runtime: publicRuntime(current), sessions: retained.slice(-16).map(record => ({ session_id: record.id, status: record.status,
      runtime_key: record.runtime.runtime_key, origin: { ...record.origin }, sequence: record.sequence, updated_at: record.updated_at })),
      omitted_sessions: Math.max(0, retained.length - 16) };
  }
  async function catalog() {
    let configured = null, modelNotice = '';
    if (typeof getModelCatalog !== 'function') modelNotice = 'The host has not supplied the configured coding model catalog.';
    else {
      try {
        configured = await getModelCatalog();
        if (!object(configured) || !Array.isArray(configured.models)) throw new Error();
        if (configured.notice) modelNotice = 'Some configured model discovery is unavailable. Inspect the existing model connection.';
      }
      catch { configured = null; modelNotice = 'The configured coding model catalog is unavailable; refresh it before selecting a model.'; }
    }
    const current = synchronize(), models = [], seen = new Set();
    const candidates = configured?.models || [];
    let truncated = candidates.length > 500;
    for (const model of candidates.slice(0, 500)) {
      if (!object(model) || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200 || text(model.id, 200) !== model.id || seen.has(model.id)) continue;
      let selection; try { selection = selectionFor(model.id); } catch { continue; }
      seen.add(model.id);
      if (models.length >= 100) { truncated = true; continue; }
      const fits = compatible(current, selection);
      models.push({ id: model.id, label: text(model.label, 256) || model.id, compatible_with_connection: fits,
        ...(fits ? {} : { unavailable_reason: 'The active coding connection has a different model or provider; select the intended connection in Coding first.' }) });
    }
    if (!models.length && !modelNotice) modelNotice = 'No configured model identifiers were accepted by the coding transport. Refresh the Coding model selection.';
    return { ...status(), actions: [...ACTIONS], models, models_truncated: truncated, model_notice: modelNotice,
      runtimes: runtime.availableRuntimes().map(value => ({
      runtime_key: text(value.runtimeKey, 100), name: text(value.runtimeName, 160), scope: text(value.scope, 100), installed: value.installed === true })),
      notice: 'For coding_start.model use an exact identifier from coding_catalog.models with compatible_with_connection=true. Use the current Coding runtime and workspace selection. Start creates a dedicated Franklin session. Native tool approvals require the human operator.' };
  }
  return { catalog, status, validate, execute, ingest, approval, owns(sessionId) { return sessions.has(sessionId); } };
}
module.exports = { createFranklinCoding, ACTIONS };
