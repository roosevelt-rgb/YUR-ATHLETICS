'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFranklinCoding, ACTIONS } = require('../src/franklin-coding');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  const calls = [], events = [], owner = {}, otherOwner = {};
  let nextSession = 0, nextAction = 0, active = true;
  const current = { running: false, runtimeKey: 'rc6', runtimeName: 'IntelliFlow', workspace: 'C:\\selected-project',
    model: null, baseUrl: null, verifiedDigest: null, executable: 'PRIVATE_EXECUTABLE', profile: 'PRIVATE_PROFILE' };
  const hooks = {};
  const runtime = {
    status: () => ({ ...current }),
    availableRuntimes: () => [{ runtimeKey: 'rc6', runtimeName: 'IntelliFlow', scope: 'coding', installed: true },
      { runtimeKey: 'construction-v1', runtimeName: 'IntelliFlow Construction V1', scope: 'construction-master', installed: true }],
    async start(selection) { calls.push(['start', selection]); Object.assign(current, selection, { running: true, verifiedDigest: 'verified' }); if (hooks.start) await hooks.start(); return this.status(); },
    async createSession() { calls.push(['create']); if (hooks.create) return hooks.create(); return { session_id: 'franklin-' + ++nextSession }; },
    async submit(id, prompt) { calls.push(['submit', id, prompt]); if (hooks.submit) return hooks.submit(id, prompt); return { accepted: true }; },
    async interrupt(id) { calls.push(['interrupt', id]); if (hooks.interrupt) return hooks.interrupt(); return { accepted: true }; },
    async approval(id, requestId, choice) { calls.push(['approval', id, requestId, choice]); if (hooks.approval) return hooks.approval(); return { accepted: true }; },
  };
  const adapter = createFranklinCoding({ runtime, resolveSelection: model => {
    if (!model.startsWith('ollama:')) throw new Error('Model is unavailable in the configured picker.');
    return { model: model.slice(7), baseUrl: 'http://configured.example/v1' };
  }, onEvent: event => events.push(event), ...options });
  const identity = (overrides = {}) => ({ owner, request_id: randomUUID(), mission_id: 'a'.repeat(32),
    action_id: (++nextAction).toString(16).padStart(32, '0'), isActive: () => active, ...overrides });
  const start = (overrides = {}, scope = identity()) => adapter.execute('coding_start', {
    runtime_key: current.runtimeKey, workspace: current.workspace, model: 'ollama:chosen-model', ...overrides }, scope);
  const event = (id, type, payload = {}, extra = {}) => adapter.ingest({ runtimeKey: current.runtimeKey, session_id: id, type, payload, ...extra });
  const read = id => adapter.execute('coding_status', { session_id: id }, identity());
  return { adapter, current, calls, events, hooks, owner, otherOwner, identity, start, event, read, cancelIdentity: () => { active = false; } };
}

test('catalog describes existing runtimes; start creates only dedicated sessions using explicit current selection', async () => {
  const f = fixture();
  const catalog = await f.adapter.catalog();
  assert.deepEqual(catalog.actions, ACTIONS);
  assert.equal(catalog.runtimes[1].runtime_key, 'construction-v1');
  assert.equal(JSON.stringify(catalog).includes('PRIVATE_'), false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(catalog.models, []); assert.match(catalog.model_notice, /not supplied/);
  const created = await f.start();
  assert.equal(created.status, 'ready'); assert.equal(created.output, '');
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'create']);
  assert.equal(f.adapter.owns(created.session_id), true);
  assert.equal(f.adapter.owns('operator-session'), false);
  const second = await f.start();
  assert.notEqual(second.session_id, created.session_id);
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'create', 'create']);
  assert(!ACTIONS.some(value => /approval|shell|switch/.test(value)));
});

test('selection mismatches and inactive authority fail before native side effects', async () => {
  const f = fixture();
  await assert.rejects(f.start({ runtime_key: 'construction-v1' }), /Choose this runtime/);
  await assert.rejects(f.start({ workspace: 'C:\\other' }), /Choose this runtime/);
  await assert.rejects(f.start({ model: 'unavailable' }), /unavailable/);
  await assert.rejects(f.start({}, f.identity({ owner: null })), /identity/);
  f.cancelIdentity(); await assert.rejects(f.start(), /identity/);
  assert.equal(f.calls.length, 0);
});

test('current Construction selection uses the same bridge without selecting or replacing any runtime', async () => {
  const f = fixture(); Object.assign(f.current, { runtimeKey: 'construction-v1', runtimeName: 'IntelliFlow Construction V1' });
  const session = await f.start();
  assert.equal(session.runtime.runtime_key, 'construction-v1');
  await assert.rejects(f.start({ model: 'ollama:different' }), /different model/);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});

test('submit preserves exact prompt, role is metadata, subsequent turns keep origin, duplicate action never replays', async () => {
  const f = fixture(), origin = f.identity(), session = await f.start({}, origin);
  const submitIdentity = f.identity({ mission_id: 'b'.repeat(32) });
  const prompt = 'Build the requested capability.\nPreserve this exact input.';
  const running = await f.adapter.execute('coding_submit', { session_id: session.session_id, text: prompt, role: 'implementation' }, submitIdentity);
  assert.equal(running.status, 'running'); assert.equal(running.role, 'implementation');
  assert.equal(running.origin.mission_id, origin.mission_id); assert.equal(running.action.mission_id, submitIdentity.mission_id);
  assert.deepEqual(f.calls.at(-1), ['submit', session.session_id, prompt]);
  await assert.rejects(f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'second' }, f.identity()), /active or unresolved/);
  f.event(session.session_id, 'message.complete');
  await assert.rejects(f.adapter.execute('coding_submit', { session_id: session.session_id, text: prompt }, submitIdentity), /already used/);
  assert.equal(f.calls.filter(call => call[0] === 'submit').length, 1);
  assert.equal((await f.read(session.session_id)).status, 'completed');
});

test('operator sessions, foreign owners, malformed and oversized payloads never reach the transport', async () => {
  const f = fixture(), session = await f.start();
  for (const action of ['coding_submit', 'coding_cancel', 'coding_status']) {
    const payload = { session_id: 'operator-session', ...(action === 'coding_submit' ? { text: 'unsafe' } : {}) };
    await assert.rejects(f.adapter.execute(action, payload, f.identity()), /does not belong/);
  }
  await assert.rejects(f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'x' }, f.identity({ owner: f.otherOwner })), /does not belong/);
  for (const payload of [
    { session_id: session.session_id, text: 'x', command: 'extra' },
    { session_id: session.session_id, text: 'x', role: ' ' },
    { session_id: session.session_id, text: '界'.repeat(24000) },
    { session_id: session.session_id, text: ' ' },
  ]) await assert.rejects(f.adapter.execute('coding_submit', payload, f.identity()));
  assert.equal(f.calls.filter(call => call[0] === 'submit' || call[0] === 'interrupt').length, 0);
});

test('native public events are correlated and bounded; reasoning and foreign session data are excluded', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  assert.equal(f.event('operator-session', 'message.delta', { text: 'FOREIGN' }), false);
  assert.equal(f.event(session.session_id, 'message.delta', { text: 'WRONG_RUNTIME' }, { runtimeKey: 'construction-v1' }), false);
  assert.equal(f.event(session.session_id, 'reasoning.delta', { text: 'PRIVATE_REASONING' }), false);
  for (let index = 0; index < 80; index++) {
    f.event(session.session_id, 'tool.complete', { tool_id: 'tool' + index, name: 'read_file', summary: 'Evidence', stdout: 'o'.repeat(5000), reasoning: 'PRIVATE_REASONING' });
    f.event(session.session_id, 'message.delta', { text: 'r'.repeat(500) });
  }
  f.event(session.session_id, 'authority.commit', { receipt: { commit_id: 'native-commit', status: 'committed', changed_paths: ['src/result.js'] } });
  f.event(session.session_id, 'message.complete', { reasoning: 'PRIVATE_REASONING' });
  const result = await f.read(session.session_id);
  assert.equal(result.status, 'completed'); assert.equal(result.runtime_completed, true);
  assert.equal(result.output.length, 16384); assert.equal(result.output_truncated, true);
  assert(result.events.length <= 24); assert(result.events_omitted > 0);
  assert.equal(result.events.at(-2).commit_id, 'native-commit');
  assert.deepEqual(result.events.at(-2).changed_paths, ['src/result.js']);
  assert.equal(/PRIVATE_REASONING|FOREIGN|WRONG_RUNTIME/.test(JSON.stringify(result)), false);
  assert(Buffer.byteLength(JSON.stringify(result)) < 96 * 1024);
});

test('approval waits for a human decision, duplicate decisions are blocked, native completion determines outcome', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  f.event(session.session_id, 'approval.request', { kind: 'ApprovalRequest', request_id: 'request-1', description: 'Write the selected file',
    tool: { name: 'write_file', arguments: { file: 'src/result.js' } }, destination: { model: 'chosen-model' } });
  const waiting = await f.read(session.session_id);
  assert.equal(waiting.status, 'awaiting_approval'); assert.equal(waiting.pending_approvals[0].human_review_required, true);
  assert.equal(f.calls.some(call => call[0] === 'approval'), false);
  await assert.rejects(f.adapter.execute('coding_approval', { session_id: session.session_id }, f.identity()), /Unsupported/);
  await assert.rejects(f.adapter.approval(session.session_id, 'request-1', 'approve', f.otherOwner), /does not belong/);
  const decision = deferred(); f.hooks.approval = () => decision.promise;
  const pending = f.adapter.approval(session.session_id, 'request-1', 'deny', f.owner);
  await assert.rejects(f.adapter.approval(session.session_id, 'request-1', 'approve', f.owner), /in flight/);
  decision.resolve({ accepted: true }); assert.equal((await pending).status, 'running');
  await assert.rejects(f.adapter.approval(session.session_id, 'request-1', 'deny', f.owner), /absent/);
  f.event(session.session_id, 'message.complete', { status: 'error' });
  assert.equal((await f.read(session.session_id)).status, 'failed');
});

test('wait returns on native completion or approval without generating a provider request', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  const before = f.calls.length;
  const wait = f.adapter.execute('coding_wait', { session_id: session.session_id, timeout_ms: 1000 }, f.identity());
  f.event(session.session_id, 'tool.start', { name: 'read_file' });
  f.event(session.session_id, 'message.complete', { text: 'Actual public completion' });
  assert.equal((await wait).output, 'Actual public completion'); assert.equal(f.calls.length, before);
  await assert.rejects(f.adapter.execute('coding_wait', { session_id: session.session_id, timeout_ms: 0 }, f.identity()), /between/);
  await assert.rejects(f.adapter.execute('coding_wait', { session_id: session.session_id, timeout_ms: 25001 }, f.identity()), /between/);
  assert.equal((await f.adapter.execute('coding_wait', { session_id: session.session_id }, f.identity())).status, 'completed');
});

test('stop and identical reconnect invalidate sessions and approvals; old events cannot revive them', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  f.event(session.session_id, 'approval.request', { kind: 'ApprovalRequest', request_id: 'old' });
  Object.assign(f.current, { running: false, verifiedDigest: null, model: null, baseUrl: null });
  f.adapter.ingest({ type: 'bridge.stopped', runtimeKey: 'rc6' });
  await f.start();
  assert.equal((await f.read(session.session_id)).status, 'stale');
  assert.equal((await f.read(session.session_id)).pending_approvals.length, 0);
  assert.equal(f.event(session.session_id, 'message.complete'), false);
  await assert.rejects(f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'repeat' }, f.identity()), /stale/);
  await assert.rejects(f.adapter.approval(session.session_id, 'old', 'approve', f.owner), /stale/);
});

test('creating a session rejects a reconnect race and blocks a concurrent start', async () => {
  const f = fixture(), gate = deferred(); f.hooks.create = () => gate.promise;
  const pending = f.start();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.start(), /already being created/);
  f.adapter.ingest({ type: 'bridge.stopped', runtimeKey: 'rc6' });
  gate.resolve({ session_id: 'late-session' });
  await assert.rejects(pending, /connection changed/); assert.equal(f.adapter.owns('late-session'), false);
});

test('runtime fingerprint changes invalidate sessions even when a lifecycle event was missed', async () => {
  const f = fixture(), session = await f.start();
  f.current.workspace = 'C:\\different-selection';
  assert.equal((await f.read(session.session_id)).status, 'stale');
  assert.equal(f.calls.some(call => call[0] === 'submit'), false);
});

test('uncertain submit is never repeated and later native evidence can reconcile it', async () => {
  const f = fixture(), session = await f.start(), scope = f.identity();
  f.hooks.submit = () => { throw new Error('Transport acknowledgment lost'); };
  await assert.rejects(f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build once' }, scope), /acknowledgment lost/);
  assert.equal((await f.read(session.session_id)).status, 'uncertain');
  await assert.rejects(f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build again' }, f.identity()), /active or unresolved/);
  f.event(session.session_id, 'message.complete', { text: 'Runtime actually finished' });
  assert.equal((await f.read(session.session_id)).status, 'completed');
  assert.equal(f.calls.filter(call => call[0] === 'submit').length, 1);
});

test('cancel targets only the owned session and reports a request until native cancellation arrives', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  const scope = f.identity(), cancelled = await f.adapter.execute('coding_cancel', { session_id: session.session_id }, scope);
  assert.equal(cancelled.status, 'cancel_requested'); assert.equal(cancelled.cancel_action.action_id, scope.action_id);
  assert.deepEqual(f.calls.at(-1), ['interrupt', session.session_id]);
  f.event(session.session_id, 'session.interrupted'); assert.equal((await f.read(session.session_id)).status, 'cancelled');
  await assert.rejects(f.adapter.execute('coding_cancel', { session_id: session.session_id }, f.identity()), /no confirmed active/);
  assert.equal(f.calls.filter(call => call[0] === 'interrupt').length, 1);
});

test('completion before submit acknowledgment remains completed and does not regress to running', async () => {
  const f = fixture(), session = await f.start();
  f.hooks.submit = () => { f.event(session.session_id, 'message.complete', { text: 'Done' }); return { accepted: true }; };
  const result = await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'Done');
});

test('multibyte output, tool evidence and pending approvals stay within the host result budget', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  for (let index = 0; index < 40; index++) {
    f.event(session.session_id, 'tool.complete', { name: '界'.repeat(500), summary: '界'.repeat(5000), stdout: '界'.repeat(5000), stderr: '界'.repeat(5000),
      receipt: { changed_paths: Array(8).fill('界'.repeat(2000)) } });
    f.event(session.session_id, 'message.delta', { text: '界'.repeat(5000) });
  }
  for (let index = 0; index < 8; index++) f.event(session.session_id, 'approval.request', { kind: 'ApprovalRequest', request_id: 'native-' + index,
    description: '界'.repeat(5000), tool: { name: '界'.repeat(500) }, destination: { model: '界'.repeat(500) } });
  const result = await f.read(session.session_id);
  assert(Buffer.byteLength(result.output) <= 16384);
  assert(Buffer.byteLength(JSON.stringify(result)) < 96 * 1024);
  assert.equal(result.output_truncated, true); assert(result.events_omitted > 0);
});

test('cancellation retires pending approvals and a late challenge cannot reverse cancellation state', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  f.event(session.session_id, 'approval.request', { kind: 'ApprovalRequest', request_id: 'old' });
  await f.adapter.execute('coding_cancel', { session_id: session.session_id }, f.identity());
  f.event(session.session_id, 'approval.request', { kind: 'ApprovalRequest', request_id: 'late' });
  const result = await f.read(session.session_id);
  assert.equal(result.status, 'cancel_requested'); assert.equal(result.pending_approvals.length, 0);
  await assert.rejects(f.adapter.approval(session.session_id, 'old', 'approve', f.owner), /absent/);
  await assert.rejects(f.adapter.approval(session.session_id, 'late', 'approve', f.owner), /absent/);
});

test('reconnection during start rejects before creating a Franklin session', async () => {
  const f = fixture();
  f.hooks.start = () => { f.adapter.ingest({ type: 'bridge.stopped', runtimeKey: 'rc6' }); };
  await assert.rejects(f.start(), /connection changed/);
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
});

test('runtime cannot reuse a prior session identity after reconnect', async () => {
  const f = fixture(), first = await f.start();
  f.adapter.ingest({ type: 'bridge.stopped', runtimeKey: 'rc6' });
  f.hooks.create = () => ({ session_id: first.session_id });
  await assert.rejects(f.start(), /reused session identity/);
  assert.equal((await f.read(first.session_id)).status, 'stale');
});

test('identical native approval is ignored; changed same-ID scope retires the open decision permanently', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  const request = { kind: 'ApprovalRequest', request_id: 'native-id', argument_digest: 'original', tool: { name: 'write_file' } };
  assert.equal(f.event(session.session_id, 'approval.request', request), true);
  const sequence = (await f.read(session.session_id)).sequence;
  assert.equal(f.event(session.session_id, 'approval.request', { ...request }), false);
  assert.equal((await f.read(session.session_id)).sequence, sequence);
  assert.equal(f.event(session.session_id, 'approval.request', { ...request, argument_digest: 'changed' }), false);
  assert.equal((await f.read(session.session_id)).status, 'uncertain');
  assert.equal((await f.read(session.session_id)).pending_approvals.length, 0);
  await assert.rejects(f.adapter.approval(session.session_id, request.request_id, 'approve', f.owner), /absent|invalidated/);
  assert.equal(f.event(session.session_id, 'approval.request', request), false);
  assert.equal(f.calls.filter(call => call[0] === 'approval').length, 0);
});

test('transport approval invalidation clears pending decisions and wakes a status wait with uncertainty', async () => {
  const f = fixture(), session = await f.start();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  f.event(session.session_id, 'approval.request', { kind: 'ApprovalRequest', request_id: 'invalidated' });
  f.event(session.session_id, 'approval.invalidated', { request_id: 'invalidated' });
  const result = await f.adapter.execute('coding_wait', { session_id: session.session_id, timeout_ms: 1000 }, f.identity());
  assert.equal(result.status, 'uncertain'); assert.equal(result.pending_approvals.length, 0);
  await assert.rejects(f.adapter.approval(session.session_id, 'invalidated', 'approve', f.owner), /absent/);
});

test('an in-flight decision cannot be relabeled successful after the native scope is invalidated', async () => {
  const f = fixture(), session = await f.start(), decision = deferred();
  await f.adapter.execute('coding_submit', { session_id: session.session_id, text: 'Build' }, f.identity());
  f.event(session.session_id, 'approval.request', { kind: 'ApprovalRequest', request_id: 'race' });
  f.hooks.approval = () => decision.promise;
  const pending = f.adapter.approval(session.session_id, 'race', 'approve', f.owner);
  f.event(session.session_id, 'approval.invalidated', { request_id: 'race' });
  decision.resolve({ accepted: true });
  await assert.rejects(pending, /scope changed/);
  assert.equal((await f.read(session.session_id)).status, 'uncertain');
});

test('coding catalog excludes unsupported generic chat provider identifiers and bounds exact IDs and labels', async () => {
  const f = fixture({ getModelCatalog: async () => ({ models: [
    { id: 'openai:deepseek-v4-pro:cloud', label: 'Generic chat endpoint' },
    { id: 'ollama:chosen-model', label: 'Coding model' },
    { id: 'ollama:chosen-model', label: 'Duplicate' },
    { id: 'ollama:second', label: '界'.repeat(500) },
    { id: 'ollama:' + 'x'.repeat(210), label: 'Too long' },
    { id: '', label: 'Empty' }, { id: 'ollama:has\0control', label: 'Control character' }, null,
  ] }) });
  const catalog = await f.adapter.catalog();
  assert.deepEqual(catalog.models.map(item => item.id), ['ollama:chosen-model', 'ollama:second']);
  assert(catalog.models.every(item => item.compatible_with_connection === true));
  assert(Buffer.byteLength(catalog.models[1].label) <= 256);
  assert.match(catalog.notice, /coding_catalog\.models/);
  assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
});

test('coding catalog follows the injected resolver without hardcoding a provider preference', async () => {
  const f = fixture({
    getModelCatalog: () => ({ models: [{ id: 'openai:approved-by-host', label: 'Host resource' }, { id: 'ollama:unbound', label: 'Unbound' }] }),
    resolveSelection: identifier => {
      if (identifier !== 'openai:approved-by-host') throw new Error('No coding binding');
      return { model: 'host-resource', baseUrl: 'http://host-selected.example/v1' };
    },
  });
  const catalog = await f.adapter.catalog();
  assert.deepEqual(catalog.models.map(item => item.id), ['openai:approved-by-host']);
  assert.equal(f.calls.length, 0);
});

test('catalog shows active connection compatibility using actual configured model and provider', async () => {
  const f = fixture({ getModelCatalog: () => ({ models: [
    { id: 'ollama:chosen-model', label: 'Current' }, { id: 'ollama:other-model', label: 'Other' },
  ] }) });
  await f.start();
  const catalog = await f.adapter.catalog();
  assert.equal(catalog.models[0].compatible_with_connection, true);
  assert.equal(catalog.models[1].compatible_with_connection, false);
  assert.match(catalog.models[1].unavailable_reason, /active coding connection/);
  f.current.baseUrl = 'http://changed-provider.example/v1';
  const changed = await f.adapter.catalog();
  assert(changed.models.every(item => item.compatible_with_connection === false));
});

test('model catalog refresh uses the connection observed after asynchronous discovery and stays bounded', async () => {
  const gate = deferred(), f = fixture({ getModelCatalog: () => gate.promise });
  const pending = f.adapter.catalog();
  await f.start();
  gate.resolve({ models: [{ id: 'ollama:chosen-model', label: 'Current' },
    ...Array.from({ length: 650 }, (_, index) => ({ id: 'ollama:resource-' + index, label: '界'.repeat(500) }))] });
  const catalog = await pending;
  assert.equal(catalog.models.length, 100); assert.equal(catalog.models_truncated, true);
  assert.equal(catalog.models[0].compatible_with_connection, true);
  assert.equal(catalog.models[1].compatible_with_connection, false);
  assert(Buffer.byteLength(JSON.stringify(catalog)) < 96 * 1024);
});

test('model catalog errors remain explicit and do not leak provider details or start a runtime', async () => {
  const f = fixture({ getModelCatalog: () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); } });
  const catalog = await f.adapter.catalog();
  assert.deepEqual(catalog.models, []); assert.match(catalog.model_notice, /unavailable/);
  assert.equal(JSON.stringify(catalog).includes('PRIVATE_PROVIDER_DETAIL'), false);
  assert.equal(f.calls.length, 0);
  const partial = fixture({ getModelCatalog: () => ({ models: [{ id: 'openai:unbound', label: 'Generic chat' }], notice: 'PRIVATE_PROVIDER_DETAIL' }) });
  const observed = await partial.adapter.catalog();
  assert.deepEqual(observed.models, []);
  assert.equal(observed.model_notice, 'Some configured model discovery is unavailable. Inspect the existing model connection.');
  assert.equal(JSON.stringify(observed).includes('PRIVATE_PROVIDER_DETAIL'), false);
});

test('preflight rejects an incompatible model before confirmation and never reserves an action or mutates state', async () => {
  const f = fixture(), scope = f.identity();
  const payload = { runtime_key: 'rc6', workspace: f.current.workspace, model: 'openai:deepseek-v4-pro:cloud' };
  assert.throws(() => f.adapter.validate('coding_start', payload, scope), /unavailable/);
  assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
  const valid = { ...payload, model: 'ollama:chosen-model' };
  assert.equal(f.adapter.validate('coding_start', valid, scope).valid, true);
  assert.equal(f.adapter.validate('coding_start', valid, scope).valid, true);
  assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
  const session = await f.adapter.execute('coding_start', valid, scope);
  assert.equal(session.status, 'ready');
  assert.throws(() => f.adapter.validate('coding_start', valid, scope), /already used/);
});

test('execute repeats preflight after a human review and rejects changed connection without native mutation', async () => {
  const f = fixture(); await f.start();
  const scope = f.identity(), payload = { runtime_key: 'rc6', workspace: f.current.workspace, model: 'ollama:chosen-model' };
  assert.equal(f.adapter.validate('coding_start', payload, scope).valid, true);
  const before = f.calls.length, eventCount = f.events.length;
  f.current.model = 'operator-changed-model';
  assert.throws(() => f.adapter.validate('coding_start', payload, scope), /different model/);
  assert.equal(f.events.length, eventCount, 'validation must not emit invalidation or change session state');
  await assert.rejects(f.adapter.execute('coding_start', payload, scope), /different model/);
  assert.equal(f.calls.length, before);
});

test('submit preflight protects foreign/stale sessions and can be repeated before the one native submission', async () => {
  const f = fixture(), session = await f.start(), scope = f.identity();
  const payload = { session_id: session.session_id, text: 'Build once' };
  assert.equal(f.adapter.validate('coding_submit', payload, scope).valid, true);
  assert.equal(f.adapter.validate('coding_submit', payload, scope).valid, true);
  assert.throws(() => f.adapter.validate('coding_submit', { ...payload, session_id: 'operator-session' }, scope), /does not belong/);
  await f.adapter.execute('coding_submit', payload, scope);
  assert.equal(f.calls.filter(call => call[0] === 'submit').length, 1);
  f.current.workspace = 'C:\\other-workspace';
  assert.throws(() => f.adapter.validate('coding_submit', payload, f.identity()), /stale/);
});
