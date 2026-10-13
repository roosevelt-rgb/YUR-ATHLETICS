'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createExecutionRuntimeTransport, resolveExecutionSelection, validateCheck, validateSetup, validateReceipt, resourceId } = require('../src/execution-runtime-transport');

const hash = 'a'.repeat(64), distro = 'Ubuntu-24.04', resource = resourceId(distro);
const runtime = () => ({ distro, architecture: 'x86_64', python: '3.12.3', libseccomp: '2.5.5', artifacts: { '/usr/bin/python3': { path: '/usr/bin/python3.12', sha256: hash, bytes: 100 } } });
function checked(status = 'ready', source = 'auto') {
  const time = Date.now();
  return { schema: 'yur.execution-setup-check.v1', status, checked_at: new Date(time).toISOString(), expires_at: new Date(time + 120000).toISOString(), resources: [{ resource_id: resource, distro, state: status === 'stopped' ? 'stopped' : 'running', version: 2 }], selected_resource_id: resource, configuration_source: source, runtime: status === 'ready' ? runtime() : null, diagnostics: null, check_token: ['ready', 'stopped'].includes(status) ? randomUUID() : null, active_setup: null };
}
function setup(operationId, state = 'ready', revision = 3) {
  const created = Date.now() - 1000;
  return { schema: 'yur.execution-runtime-setup.v1', operation_id: operationId, resource_id: resource, distro, owner_session_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', state, created_at: new Date(created).toISOString(), updated_at: new Date(created + revision).toISOString(), expires_at: new Date(created + 900000).toISOString(), check: { checked_at: new Date(created - 1000).toISOString(), expires_at: new Date(created + 119000).toISOString(), token_sha256: hash, observation_sha256: hash, state: 'running', configuration_source: 'auto' }, authority: { issuer: 'local-user', scope: 'execution-runtime-prepare', actions: ['start-reviewed-runtime', 'hold-reviewed-runtime', 'release-owned-hold'], operation_id: operationId, resource_id: resource }, evidence: { started_by_this_setup: false, runtime: runtime(), owned_process_exit_confirmed: ['released', 'expired'].includes(state), release_reason: ['released', 'expired'].includes(state) ? 'operator' : null, error: null }, revision };
}
const receipt = value => ({ id: value.revision, operation_id: value.operation_id, revision: value.revision, event_type: 'runtime.setup.' + value.state, created_at: value.updated_at, previous_hash: hash, hash });
function fixture(t, handle, overrides = {}) {
  const calls = [], children = [], events = [];
  const transport = createExecutionRuntimeTransport({ sourceRoot: path.resolve(__dirname, '..'), getStateRoot: () => path.join(__dirname, 'unused-test-state'), getPython: () => 'fixture-python', getEnvironment: () => ({ PATH: 'trusted', PYTHONPATH: 'never', PYTHONHOME: 'never', SECRET: 'never' }), getSelection: () => ({ distro: null, configuration_source: 'auto' }), onEvent: event => events.push(event), cleanupTimeoutMs: 20, ...overrides,
    spawnProcess(executable, args, options) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let ended = false;
      child.kill = () => { if (!ended) { ended = true; child.emit('close', 0); } return true; };
      child.stdin = new Writable({ write(chunk, _encoding, done) { const frame = JSON.parse(chunk.toString()); calls.push({ frame, child, executable, args, options }); queueMicrotask(() => handle?.(frame, child)); done(); }, final(done) { done(); queueMicrotask(() => child.kill()); } });
      children.push(child); return child;
    },
  });
  t.after(async () => { await transport.dispose(); for (const child of children) child.kill(); });
  return { transport, calls, children, events };
}
const respond = (child, frame, result) => child.stdout.write(JSON.stringify({ type: 'result', request_id: frame.request_id, command: frame.command, ok: true, result }) + '\n');

test('runtime selection preserves environment priority and rejects invalid names without fallback', () => {
  assert.deepEqual(resolveExecutionSelection({ execution_distro: 'Saved' }, { YUR_EXECUTION_DISTRO: 'Pinned' }, 'Checked'), { distro: 'Pinned', configuration_source: 'environment' });
  assert.deepEqual(resolveExecutionSelection({ execution_distro: 'Saved' }, {}, 'Checked'), { distro: 'Saved', configuration_source: 'settings' });
  assert.deepEqual(resolveExecutionSelection({}, {}, 'Checked'), { distro: 'Checked', configuration_source: 'auto' });
  for (const value of ['', 'Ubuntu;echo', '../../bin', 42]) assert.throws(() => resolveExecutionSelection({}, { YUR_EXECUTION_DISTRO: value }));
});

test('Check and explicit Prepare share one clean, framed process; Release and Inspect preserve receipts', async t => {
  let observation = checked(), current;
  const f = fixture(t, (frame, child) => {
    if (frame.command === 'check') respond(child, frame, { check: observation });
    if (frame.command === 'prepare') { current = setup(frame.operation_id); child.stdout.write(JSON.stringify({ type: 'state', operation_id: current.operation_id, setup: current, receipt: receipt(current) }) + '\n'); respond(child, frame, { setup: current, receipt: receipt(current), replayed: false }); }
    if (frame.command === 'release') { current = { ...current, state: 'released', revision: 5, updated_at: new Date(Date.parse(current.created_at) + 5).toISOString(), evidence: { ...current.evidence, owned_process_exit_confirmed: true, release_reason: 'operator' } }; respond(child, frame, { setup: current, receipt: receipt(current), replayed: false }); }
    if (frame.command === 'inspect') respond(child, frame, { setup: current, receipt: receipt(current) });
  });
  assert.equal((await f.transport.inspect({ operation_id: null })).result.setup, null); assert.equal(f.calls.length, 0, 'Mount-style inspection does not spawn or check WSL');
  assert.equal((await f.transport.check({ resource_id: null })).ok, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.shell, false); assert.equal(f.calls[0].options.windowsHide, true); assert.deepEqual(f.calls[0].args, ['-B', '-m', 'foundry.execution_setup_cli']);
  for (const key of ['SECRET', 'PYTHONPATH', 'PYTHONHOME']) assert.equal(f.calls[0].options.env[key], undefined);
  assert.equal(f.calls[0].options.env.PYTHONNOUSERSITE, '1');
  const id = randomUUID(); const request = { operation_id: id, resource_id: resource, check_token: observation.check_token };
  assert.equal((await f.transport.prepare(request)).result.setup.state, 'ready'); assert.equal(f.children.length, 1); assert.equal(f.events.length, 1);
  assert.equal((await f.transport.prepare(request)).error.code, 'INSPECT_REQUIRED');
  assert.equal((await f.transport.check({ resource_id: null })).error.code, 'SETUP_ACTIVE');
  assert.equal((await f.transport.release({ operation_id: id })).result.setup.state, 'released');
  assert.equal((await f.transport.inspect({ operation_id: null })).result.setup.operation_id, id);
  observation = checked(); assert.equal((await f.transport.check({ resource_id: null })).ok, true); assert.equal(f.children.length, 2, 'A terminal single-use connection is closed before a new explicit Check');
  assert.equal(f.calls.filter(item => item.frame.command === 'prepare').length, 1);
});

test('stale or changed check selection and unknown resource IDs cannot prepare', async t => {
  let selected = null; const observation = checked();
  const f = fixture(t, (frame, child) => respond(child, frame, { check: observation }), { getSelection: () => ({ distro: selected, configuration_source: 'settings' }) });
  await f.transport.check({ resource_id: null }); selected = 'Different';
  assert.equal((await f.transport.prepare({ operation_id: randomUUID(), resource_id: resource, check_token: observation.check_token })).error.code, 'SELECTION_CHANGED');
  assert.equal((await f.transport.check({ resource_id: '0'.repeat(64) })).error.code, 'INVALID_SELECTION');
  selected = null; observation.checked_at = new Date(Date.now() - 120001).toISOString(); observation.expires_at = new Date(Date.now() - 1).toISOString();
  await f.transport.check({ resource_id: null });
  assert.equal((await f.transport.prepare({ operation_id: randomUUID(), resource_id: resource, check_token: observation.check_token })).error.code, 'CHECK_REQUIRED');
  assert.equal(f.calls.length, 2);
});

test('timed-out Prepare retains exact operation identity for inspection and never retries effects', async t => {
  const observation = checked(); let current;
  const f = fixture(t, (frame, child) => {
    if (frame.command === 'check') respond(child, frame, { check: observation });
    if (frame.command === 'prepare') current = setup(frame.operation_id);
    if (frame.command === 'inspect') respond(child, frame, { setup: current, receipt: receipt(current) });
    if (frame.command === 'release') { current.state = 'released'; current.revision = 5; current.evidence.owned_process_exit_confirmed = true; current.evidence.release_reason = 'operator'; respond(child, frame, { setup: current, receipt: receipt(current), replayed: false }); }
  }, { prepareTimeoutMs: 15 });
  await f.transport.check({ resource_id: null }); const id = randomUUID();
  const prepared = await f.transport.prepare({ operation_id: id, resource_id: resource, check_token: observation.check_token });
  assert.equal(prepared.error.code, 'ACKNOWLEDGMENT_UNCERTAIN');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.transport.inspect({ operation_id: null })).result.setup.operation_id, id);
  assert.equal(f.calls.filter(item => item.frame.command === 'prepare').length, 1);
  assert.equal((await f.transport.prepare({ operation_id: id, resource_id: resource, check_token: observation.check_token })).error.code, 'INSPECT_REQUIRED');
});

test('mismatched frames and oversized stderr fail without exposing process output or killing another process', async t => {
  const f = fixture(t, (_frame, child) => child.stdout.write(JSON.stringify({ type: 'result', request_id: randomUUID(), command: 'check', ok: true, result: { check: checked() } }) + '\n'));
  assert.equal((await f.transport.check({ resource_id: null })).error.code, 'INVALID_RUNTIME_RESPONSE');
  const g = fixture(t, (_frame, child) => child.stderr.write('PRIVATE_RAW_STREAM'.repeat(5000)));
  const result = await g.transport.check({ resource_id: null }); assert.equal(result.error.code, 'OUTPUT_LIMIT'); assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_STREAM'), false);
});

test('strict setup and receipt checks reject resource, authority, clock, state and revision substitutions', () => {
  const value = setup(randomUUID()); assert.doesNotThrow(() => validateSetup(value)); assert.doesNotThrow(() => validateReceipt(receipt(value), value));
  for (const mutation of [s => s.resource_id = hash, s => s.revision = 17, s => s.check.checked_at = new Date(Date.parse(s.created_at) + 1).toISOString(), s => s.authority.actions.push('execute-anything'), s => s.evidence.runtime.distro = 'Other', s => s.state = 'released']) {
    const copy = structuredClone(value); mutation(copy); assert.throws(() => validateSetup(copy));
  }
  assert.throws(() => validateReceipt({ ...receipt(value), event_type: 'runtime.setup.released' }, value));
  assert.throws(() => validateReceipt({ ...receipt(value), created_at: value.created_at }, value));
  const check = checked(); check.resources.push({ ...check.resources[0] }); assert.throws(() => validateCheck(check));
  const unknown = checked('unknown'); unknown.check_token = randomUUID(); assert.throws(() => validateCheck(unknown));
});

test('an absent operation release is an exact no-op and does not poison the connection or invent a receipt', async t => {
  const f = fixture(t, (frame, child) => respond(child, frame, frame.command === 'release' ? { setup: null, receipt: null, replayed: true } : { setup: null, receipt: null }));
  const id = randomUUID(); assert.deepEqual(await f.transport.release({ operation_id: id }), { ok: true, result: { setup: null, receipt: null, replayed: true } });
  assert.deepEqual(await f.transport.inspect({ operation_id: id }), { ok: true, result: { setup: null, receipt: null } }); assert.equal(f.children.length, 1);
});

test('main-owned cached inspection during Prepare restores acknowledged state while concurrent mutations stay blocked', async t => {
  const observation = checked(); let request, child, current;
  const f = fixture(t, (frame, process) => {
    if (frame.command === 'check') respond(process, frame, { check: observation });
    if (frame.command === 'prepare') { request = frame; child = process; current = setup(frame.operation_id); process.stdout.write(JSON.stringify({ type: 'state', operation_id: current.operation_id, setup: current, receipt: receipt(current) }) + '\n'); }
    if (frame.command === 'release') { current.state = 'released'; current.evidence.owned_process_exit_confirmed = true; current.evidence.release_reason = 'operator'; respond(process, frame, { setup: current, receipt: receipt(current), replayed: false }); }
  });
  await f.transport.check({ resource_id: null });
  const promise = f.transport.prepare({ operation_id: randomUUID(), resource_id: resource, check_token: observation.check_token }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.transport.inspect({ operation_id: null })).result.setup.operation_id, request.operation_id);
  assert.equal((await f.transport.release({ operation_id: request.operation_id })).error.code, 'BUSY');
  respond(child, request, { setup: current, receipt: receipt(current), replayed: false }); await promise;
});

test('closing during Prepare ends the owned input pipe without starting another controller or claiming release', async t => {
  const observation = checked();
  const f = fixture(t, (frame, child) => { if (frame.command === 'check') respond(child, frame, { check: observation }); });
  await f.transport.check({ resource_id: null });
  const pending = f.transport.prepare({ operation_id: randomUUID(), resource_id: resource, check_token: observation.check_token });
  await f.transport.dispose();
  assert.equal((await pending).error.code, 'CLOSED');
  assert.equal(f.children[0].stdin.writableEnded, true);
  assert.deepEqual(f.calls.map(item => item.frame.command), ['check', 'prepare']);
  assert.equal((await f.transport.check({ resource_id: null })).error.code, 'CLOSED');
});
