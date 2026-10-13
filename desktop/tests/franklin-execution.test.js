'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFranklinExecution } = require('../src/franklin-execution');
function fixture(options = {}) {
  const calls = [], confirmations = [], settings = {};
  let active = true;
  const identity = { owner: { isDestroyed: () => false }, request_id: randomUUID(), mission_id: 'a'.repeat(32), action_id: 'b'.repeat(32), isActive: () => active };
  const broker = createFranklinExecution({ coding: { catalog: () => ({ selected: 'rc6' }), execute: async (...args) => { calls.push(['coding', ...args]); return { status: 'running', session_id: 'owned' }; } },
    media: async (...args) => { calls.push(['media', ...args]); return { ok: true, result: { id: 'c'.repeat(32), state: 'submitted' } }; },
    validateMedia: payload => { if (payload.preset !== 'flux-klein-image-v1' || 'request_id' in payload) throw new Error('Invalid media'); return { ...payload, seed: 1 }; },
    confirm: async request => { confirmations.push(request); return true; },
    deny: () => '', getSettings: () => settings, ...options });
  return { broker, identity, calls, confirmations, settings, cancel: () => { active = false; } };
}
test('capability discovery distinguishes connected paths and genuinely unbound services', async () => {
  const f = fixture(); const result = await f.broker.execute('desktop_capabilities', {}, f.identity);
  assert.equal(result.capabilities.find(x => x.id === 'coding').connected, true);
  for (const id of ['music', 'unreal', 'phone-outreach']) assert.equal(result.capabilities.find(x => x.id === id).connected, false);
  assert.equal(f.calls.length, 0); assert.equal(f.confirmations.length, 0);
});
test('media execution uses normalized exact human-reviewed scope and host identity', async () => {
  const f = fixture(); const payload = { preset: 'flux-klein-image-v1', prompt: 'A desktop campaign image' };
  const result = await f.broker.execute('media_submit', payload, f.identity);
  assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].payload.seed, 1);
  assert.match(f.confirmations[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(f.calls[0][2].request_id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(result.id, 'c'.repeat(32)); assert.equal(result.confirmation.approved, true);
  assert.equal(payload.request_id, undefined);
  await assert.rejects(f.broker.execute('media_submit', payload, f.identity), /already used/);
  assert.equal(f.calls.length, 1);
});
test('human denial executes nothing and cannot be replayed', async () => {
  const f = fixture({ confirm: async () => false });
  assert.equal((await f.broker.execute('coding_submit', { session_id: 's', text: 'build' }, f.identity)).executed, false);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.broker.execute('coding_submit', { session_id: 's', text: 'changed' }, f.identity), /already used/);
});
test('cancellation or changed settings during human confirmation blocks dispatch', async () => {
  let f = fixture({ confirm: async () => { f.cancel(); return true; } });
  await assert.rejects(f.broker.execute('media_resume', { job_id: 'c'.repeat(32) }, f.identity), /no longer active/);
  assert.equal(f.calls.length, 0);
  let blocked = false;
  f = fixture({ deny: () => blocked ? 'Restricted session' : '', confirm: async () => { blocked = true; return true; } });
  await assert.rejects(f.broker.execute('coding_start', { runtime_key: 'rc6', workspace: 'selected', model: 'selected' }, f.identity), /Restricted/);
  assert.equal(f.calls.length, 0);
});
test('media cancellation is reviewed and exports retain native Save As ownership', async () => {
  const f = fixture();
  await f.broker.execute('media_cancel', { job_id: 'c'.repeat(32) }, f.identity);
  assert.equal(f.confirmations.length, 1);
  await f.broker.execute('media_export', { asset_id: 'd'.repeat(64) }, { ...f.identity, action_id: 'e'.repeat(32) });
  assert.equal(f.confirmations.length, 1); assert.equal(f.calls[1][1], 'export');
  await assert.rejects(f.broker.execute('media_export', { asset_id: 'd'.repeat(64), path: 'arbitrary' }, { ...f.identity, action_id: 'f'.repeat(32) }), /committed/);
});
test('uncertain provider outcome remains non-replayable and no fake success is returned', async () => {
  let count = 0; const f = fixture({ media: async () => { count++; throw new Error('connection lost'); } });
  const input = { preset: 'flux-klein-image-v1', prompt: 'image' };
  await assert.rejects(f.broker.execute('media_submit', input, f.identity), /connection lost/);
  await assert.rejects(f.broker.execute('media_submit', input, f.identity), /already used/);
  assert.equal(count, 1);
});
test('changed action scope during confirmation is rejected before execution', async () => {
  const f = fixture({ confirm: async request => { request.payload.text = 'different instruction'; return true; } });
  await assert.rejects(f.broker.execute('coding_submit', { session_id: 's', text: 'reviewed instruction' }, f.identity), /changed during confirmation/);
  assert.equal(f.calls.length, 0);
});
test('status and bounded waits delegate to the ownership-checking coding adapter without approval prompts', async () => {
  const f = fixture(); await f.broker.execute('coding_status', { session_id: 'owned' }, f.identity);
  assert.equal(f.confirmations.length, 0); assert.equal(f.calls[0][1], 'coding_status');
});
test('surface mutations validate before confirmation and retain their exact callback result', async () => {
  let validated = false, ran = false;
  const f = fixture({ surfaces: { accepts: a => a === 'workforce_run', isReadOnly: () => false, catalog: () => [],
    validate: () => { validated = true; }, execute: async () => { ran = true; return { run_id: 'result' }; } },
    confirm: async () => { assert.equal(validated, true); assert.equal(ran, false); return true; } });
  assert.equal((await f.broker.execute('workforce_run', {}, f.identity)).run_id, 'result'); assert.equal(ran, true);
});

test('incompatible coding model is rejected before confirmation or connection', async () => {
  let connections = 0;
  const f = fixture({ coding: {
    validate: () => { throw new Error('Choose a compatible model from coding_catalog.models.'); },
    execute: async () => { connections++; return {}; },
  } });
  await assert.rejects(f.broker.execute('coding_start', {
    runtime_key: 'rc6', workspace: 'selected', model: 'incompatible:model',
  }, f.identity), /compatible model/);
  assert.equal(f.confirmations.length, 0);
  assert.equal(connections, 0);
});

test('browser review binds human-readable target and exact value before dispatch', async () => {
  let ran = 0;
  const review = { source_url: 'https://example.test/form', control: { label: 'Campaign title' }, value: 'A campaign' };
  const f = fixture({ browser: { prepare: async () => ({ review, execute: async () => { ran++; return { performed: true }; } }) },
    confirm: async request => { assert.deepEqual(request.review, review); assert.equal(ran, 0); return true; } });
  const result = await f.broker.execute('browser_fill', { document_id: 'doc', ref: 'field', value: 'A campaign' }, f.identity);
  assert.equal(result.performed, true); assert.equal(ran, 1);
  await assert.rejects(f.broker.execute('browser_fill', { document_id: 'doc', ref: 'field', value: 'A campaign' }, f.identity), /already used/);
  assert.equal(ran, 1);
});
test('browser inspection needs page permission but not an action approval', async () => {
  const f = fixture({ browser: { inspect: async () => ({ controls: [] }) } });
  assert.deepEqual(await f.broker.execute('browser_inspect', {}, f.identity), { controls: [] });
  assert.equal(f.confirmations.length, 0);
  const blocked = fixture({ browser: { inspect: async () => assert.fail('must not inspect') }, deny: () => 'Page permission disabled' });
  await assert.rejects(blocked.broker.execute('browser_inspect', {}, blocked.identity), /permission disabled/);
});
test('a browser page or setting changed during approval cannot be executed', async () => {
  let blocked = false, ran = 0;
  const f = fixture({ browser: { prepare: async () => ({ review: { control: 'Send' }, execute: async () => { ran++; return {}; } }) },
    confirm: async () => { blocked = true; return true; }, deny: () => blocked ? 'Browser disabled' : '' });
  await assert.rejects(f.broker.execute('browser_click', { document_id: 'doc', ref: 'button' }, f.identity), /Browser disabled/);
  assert.equal(ran, 0);
});
test('service attestations are tied to explicit human review and never accepted from model flags', async () => {
  let received;
  const services = { accepts: action => action === 'music_generate', isReadOnly: () => false,
    validate: (_a, payload) => { if ('external_approved' in payload) throw new Error('Host owns approval'); },
    confirmationRequirements: () => ({ external_approved: true, rights_attested: true, message: 'Approve sending these lyrics to the selected provider and attest usage rights.' }),
    execute: async (_a, _p, _i, confirmation) => { received = confirmation; return { status: 'queued' }; } };
  const f = fixture({ services });
  await f.broker.execute('music_generate', { request: {} }, f.identity);
  assert.deepEqual(received, { confirmed: true, rights_attested: true, external_approved: true });
  assert.match(f.confirmations[0].review.message, /usage rights/);
  await assert.rejects(f.broker.execute('music_generate', { external_approved: true }, { ...f.identity, action_id: 'c'.repeat(32) }), /Host owns/);
});
test('a service with one action for reads and writes decides from the typed payload whether the dialog is needed', async () => {
  const seen = [];
  const services = { accepts: action => action === 'gridiron_call', isReadOnly: (_action, payload) => { seen.push(payload); return payload?.tool === 'read'; },
    validate() {}, confirmationRequirements: (_action, payload) => ({ required: payload.tool !== 'read' }),
    execute: async (_action, payload, _identity, confirmation) => ({ tool: payload.tool, given: confirmation }) };
  const f = fixture({ services });
  const read = await f.broker.execute('gridiron_call', { tool: 'read', arguments: {} }, f.identity);
  assert.deepEqual([read.given, read.confirmation.required, f.confirmations.length], [{}, false, 0]);
  const write = await f.broker.execute('gridiron_call', { tool: 'write', arguments: {} }, { ...f.identity, action_id: 'c'.repeat(32) });
  assert.deepEqual([write.given.confirmed, write.confirmation.required, f.confirmations.length], [true, true, 1]);
  assert.deepEqual(seen, [{ tool: 'read', arguments: {} }, { tool: 'write', arguments: {} }]);
});
