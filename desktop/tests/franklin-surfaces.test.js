'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createFranklinSurfaces, SURFACE_ACTIONS } = require('../src/franklin-surfaces');

function fixture(options = {}) {
  const calls = [], policies = [];
  let active = true, destroyed = false, blocked = false;
  const identity = { request_id: '11111111-2222-3333-4444-555555555555', mission_id: 'a'.repeat(32),
    action_id: '0123456789abcdef0123456789abcdef', owner: { isDestroyed: () => destroyed }, isActive: () => active };
  const adapter = createFranklinSurfaces({
    requestWorkforce: async (...args) => { calls.push(['workforce', ...args]); return options.response || { ok: true, result: { run_id: 'c'.repeat(32) } }; },
    requestMarketplace: async (...args) => { calls.push(['marketplace', ...args]); return options.response || { ok: true, result: { packs: [] } }; },
    deny: (...args) => { policies.push(args); return blocked ? 'Operation disabled by current policy.' : null; },
    getSettings: () => ({ preferences: { restricted_session: blocked } }),
    ...options.callbacks,
  });
  return { adapter, identity, calls, policies, block: () => { blocked = true; }, cancel: () => { active = false; }, destroy: () => { destroyed = true; } };
}
const survey = () => ({ code: 'hatch_quantity', expected_sha256: 'b'.repeat(64), input: { plans_text: 'Concrete 125 CY', specs_text: '' } });
const forge = () => ({ agent_type: 'Quantity reviewer', capabilities: ['Review quantities'], industry: 'construction', name: '', description: 'Review stated quantities.\nPreserve evidence.', team: false, provider: 'ollama', model: '' });
const pack = () => {
  const files = { 'agents/reviewer.agent.md': 'Review the supplied evidence.', 'tools/read.json': '{}' };
  const content_sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { pack_id: 'reviewer-v1', content_sha256, agent_type: 'Reviewer', entry_id: 'e'.repeat(64), pack: { files } };
};
const deployment = () => ({ pack_id: 'reviewer-v1', expected_content_sha256: pack().content_sha256,
  options: { name: 'Review local evidence', goal: 'Review the supplied notes.', model: 'selected-model', mode: 'work',
    trigger: { kind: 'manual' }, maxRuns: 1, maxFailuresInRow: 1 } });
const role = () => ({ code: 'reviewer', expected_sha256: 'c'.repeat(64), session_id: 'franklin:owned-1', text: 'Review this project and report specific findings.' });
const profile = () => ({ profile: { code: 'reviewer', sha256: 'c'.repeat(64), name: 'Evidence reviewer',
  docstring: 'Review declared evidence.', actions: ['review'], input_fields: ['evidence'], classification: ['governance-advisory'] },
  content: 'RAW_DONOR_SOURCE_MUST_NOT_BE_EXECUTED', root: 'PRIVATE_DONOR_ROOT', affinities: ['PRIVATE_ENDPOINT'] });

test('surfaces distinguish connected adapters, confirmation and unavailable capabilities honestly', () => {
  const f = fixture();
  assert.deepEqual(SURFACE_ACTIONS, ['workforce_run', 'workforce_result', 'marketplace_inventory', 'marketplace_packs', 'marketplace_pack', 'marketplace_forge', 'marketplace_deploy', 'workforce_assign', 'marketplace_export']);
  assert.equal(f.adapter.isReadOnly('marketplace_forge'), false);
  assert.equal(f.adapter.isReadOnly('workforce_result'), true);
  for (const action of ['marketplace_install', 'marketplace_import', 'music_submit', 'workflow_run', 'phone_call', 'unknown']) {
    assert.equal(f.adapter.accepts(action), false); assert.equal(f.adapter.isReadOnly(action), false);
  }
  const catalog = f.adapter.catalog();
  for (const id of ['marketplace_delivery', 'marketplace_export', 'marketplace_deployment', 'workforce_assignments', 'music', 'unreal', 'outreach', 'workflows']) assert.equal(catalog.find(item => item.id === id).status, 'unavailable');
  assert.throws(() => f.adapter.validate('marketplace_deploy', deployment(), f.identity), /not connected/);
  assert.throws(() => f.adapter.validate('workforce_assign', role(), f.identity), /not connected/);
  assert.throws(() => f.adapter.validate('marketplace_export', { pack_id: 'reviewer-v1', expected_content_sha256: pack().content_sha256 }, f.identity), /not connected/);
  assert.match(catalog.find(item => item.id === 'marketplace').notice, /declarations/);
  const missing = fixture({ callbacks: { requestWorkforce: undefined, requestMarketplace: undefined } });
  assert.equal(missing.adapter.catalog()[0].status, 'unavailable');
  assert.throws(() => missing.adapter.validate('workforce_run', survey(), missing.identity), /not connected/);
  assert.throws(() => createFranklinSurfaces({}), /policy checks/);
});

test('workforce uses exact admitted worker input and derives stable request identity at dispatch', async () => {
  const f = fixture(), payload = survey();
  const checked = f.adapter.validate('workforce_run', payload, f.identity);
  checked.input.plans_text = 'changed local copy';
  assert.equal(payload.input.plans_text, 'Concrete 125 CY');
  assert.equal(f.calls.length, 0);
  const result = await f.adapter.execute('workforce_run', payload, f.identity);
  const [surface, operation, input, identity] = f.calls[0];
  assert.equal(surface, 'workforce'); assert.equal(operation, 'run'); assert.equal(identity, f.identity);
  assert.deepEqual(input, { ...payload, request_id: '01234567-89ab-cdef-0123-456789abcdef' });
  assert.equal(result.trust, 'untrusted-source-data'); assert.equal(result.authority, 'context-only');
  assert.equal(f.policies.at(-1)[0], 'factory:request');
  assert.equal(f.policies.at(-1)[1][0].command, 'workforce_run');
  await f.adapter.execute('workforce_result', { mission_id: 'a'.repeat(32), run_id: 'c'.repeat(32) }, f.identity);
  assert.equal(f.calls[1][1], 'result'); assert.equal(Object.hasOwn(f.calls[1][2], 'request_id'), false);
});

test('unadmitted workers, forged identifiers, extra authority and oversized data never dispatch', async () => {
  const f = fixture();
  for (const payload of [
    { ...survey(), code: 'other_worker' }, { ...survey(), expected_sha256: '../source' },
    { ...survey(), request_id: f.identity.request_id }, { ...survey(), root: 'D:/donor' },
    { ...survey(), input: { plans_text: '', specs_text: '' } },
    { ...survey(), input: { plans_text: 'x', specs_text: '', command: 'run' } },
    { ...survey(), input: { plans_text: 'x'.repeat(30001), specs_text: '' } },
    { ...survey(), input: { plans_text: '漢'.repeat(30000), specs_text: '' } },
    { ...survey(), input: { plans_text: '\0', specs_text: '' } },
  ]) await assert.rejects(f.adapter.execute('workforce_run', payload, f.identity));
  await assert.rejects(f.adapter.execute('workforce_result', { mission_id: 'a'.repeat(32), run_id: f.identity.request_id }, f.identity));
  assert.equal(f.calls.length, 0);
});

test('marketplace maps only validated actions to the existing fixed HTTP contract', async () => {
  const f = fixture();
  await f.adapter.execute('marketplace_inventory', {}, f.identity);
  await f.adapter.execute('marketplace_packs', {}, f.identity);
  await f.adapter.execute('marketplace_pack', { pack_id: 'pack:quantity-v1.0' }, f.identity);
  await f.adapter.execute('marketplace_forge', forge(), f.identity);
  assert.deepEqual(f.calls.map(call => call.slice(1, 4)), [
    ['GET', '/api/inventory', undefined], ['GET', '/api/packs', undefined],
    ['GET', '/api/packs/pack:quantity-v1.0', undefined], ['POST', '/api/karma/forge', forge()],
  ]);
  assert.deepEqual(f.policies.at(-1).slice(0, 2), ['harness:request', ['POST', '/api/karma/forge', forge()]]);
  for (const [action, payload] of [
    ['marketplace_inventory', { path: '/api/private' }], ['marketplace_pack', { pack_id: '../secret' }],
    ['marketplace_pack', { pack_id: 'pack..id' }], ['marketplace_pack', { pack_id: 'x?token=secret' }],
    ['marketplace_forge', { ...forge(), skills: [] }], ['marketplace_forge', { ...forge(), provider: 'arbitrary' }],
    ['marketplace_forge', { ...forge(), team: 'yes' }], ['marketplace_forge', { ...forge(), model: 'bad\nmodel' }],
    ['marketplace_forge', { ...forge(), capabilities: Array(33).fill('read') }],
    ['marketplace_forge', { ...forge(), capabilities: [' '] }],
    ['marketplace_forge', { ...forge(), model: 'x'.repeat(201) }],
  ]) await assert.rejects(f.adapter.execute(action, payload, f.identity));
  assert.equal(f.calls.length, 4);
});

test('policy is rechecked after confirmation and cancelled or destroyed scopes cannot execute', async () => {
  const f = fixture();
  f.adapter.validate('marketplace_forge', forge(), f.identity);
  f.block(); await assert.rejects(f.adapter.execute('marketplace_forge', forge(), f.identity), /disabled/);
  const cancelled = fixture(); cancelled.cancel();
  await assert.rejects(cancelled.adapter.execute('workforce_run', survey(), cancelled.identity), /cancelled/);
  const destroyed = fixture(); destroyed.destroy();
  await assert.rejects(destroyed.adapter.execute('marketplace_inventory', {}, destroyed.identity), /unavailable/);
  for (const bad of [null, {}, { ...f.identity, action_id: 'missing' }, { ...f.identity, isActive: undefined }])
    await assert.rejects(f.adapter.execute('marketplace_inventory', {}, bad), /scope/);
  assert.equal(f.calls.length + cancelled.calls.length + destroyed.calls.length, 0);
});

test('results stay bounded untrusted JSON and errors never expose callback details or retry', async () => {
  for (const response of [
    { ok: false, error: { message: 'private details' } }, { ok: true, result: [] },
    { ok: true, result: { value: Infinity } }, { ok: true, result: { large: 'x'.repeat(96 * 1024) } },
    { ok: true, result: { value: undefined } },
  ]) {
    const f = fixture({ response });
    await assert.rejects(f.adapter.execute('marketplace_inventory', {}, f.identity), error => !error.message.includes('private details'));
    assert.equal(f.calls.length, 1);
  }
  const f = fixture({ response: { ok: true, result: { trust: 'trusted', authority: 'execute', packs: [] } } });
  assert.deepEqual(await f.adapter.execute('marketplace_packs', {}, f.identity), { packs: [], trust: 'untrusted-source-data', authority: 'context-only' });
  let count = 0;
  const failed = fixture({ callbacks: { requestMarketplace: async () => { count++; throw new Error('secret callback trace'); } } });
  await assert.rejects(failed.adapter.execute('marketplace_forge', forge(), failed.identity), /outcome is uncertain/);
  assert.equal(count, 1);
});

test('cancellation while awaiting a callback rejects its late outcome without dispatching again', async () => {
  let resolve;
  const f = fixture({ callbacks: { requestMarketplace: () => new Promise(done => { resolve = done; }) } });
  const pending = f.adapter.execute('marketplace_inventory', {}, f.identity);
  f.cancel(); resolve({ ok: true, result: { packs: [] } });
  await assert.rejects(pending, /cancelled/);
});

test('manual deployment binds the exact source bytes to the existing lifecycle spec without starting execution', async () => {
  const sent = [], detail = pack();
  const f = fixture({ callbacks: { requestMarketplace: async (method, apiPath, body) => {
    assert.deepEqual([method, apiPath, body], ['GET', '/api/packs/reviewer-v1', undefined]); return { ok: true, result: detail };
  }, requestDeployment: async (...args) => { sent.push(args); return { ok: true, result: { deployment: { id: 'local-deployment', state: 'active' } } }; } } });
  const checked = f.adapter.validate('marketplace_deploy', deployment(), f.identity);
  assert.equal(sent.length, 0); assert.equal(f.adapter.isReadOnly('marketplace_deploy'), false);
  const result = await f.adapter.execute('marketplace_deploy', checked, f.identity);
  assert.equal(sent.length, 1);
  const [spec, identity] = sent[0];
  assert.equal(identity, f.identity); assert.equal(spec.source.content_sha256, detail.content_sha256);
  assert.equal(spec.kind, 'marketplace_pack'); assert.equal(spec.root, null); assert.equal(spec.state, 'active');
  assert.deepEqual(spec.trigger, { kind: 'manual' }); assert.equal(spec.max_runs, 1);
  assert.match(spec.instructions, /guidance, not tools/); assert.match(spec.instructions, /existing OrchestrationManager and Commit Service/);
  assert.equal(result.execution_started, false); assert.deepEqual(result.reviewed_pack, { pack_id: 'reviewer-v1', content_sha256: detail.content_sha256 });
  assert.ok(f.policies.some(([channel]) => channel === 'marketplace:deploy'));
  assert.ok(f.policies.some(([channel]) => channel === 'lifecycles:deploy'));
  assert.ok(f.policies.some(([channel]) => channel === 'work:start'));
  assert.equal(f.adapter.catalog().find(item => item.id === 'marketplace_deployment').status, 'connected');
});

test('deployment rejects changed digests, forged hash labels, missing agents and excess Work context before commit', async () => {
  for (const mutate of [detail => { detail.content_sha256 = 'f'.repeat(64); }, detail => { detail.pack_id = 'other'; },
    detail => { detail.pack.files['agents/reviewer.agent.md'] += ' altered'; }, detail => { detail.pack.files = {}; }]) {
    const detail = pack(); mutate(detail); let writes = 0;
    const f = fixture({ callbacks: { requestMarketplace: async () => ({ ok: true, result: detail }),
      requestDeployment: async () => { writes++; return { ok: true, result: {} }; } } });
    await assert.rejects(f.adapter.execute('marketplace_deploy', deployment(), f.identity), /changed|digest/); assert.equal(writes, 0);
  }
  for (const files of [{ 'tools/read.json': '{}' }, Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`agents/reviewer${i}.agent.md`, 'a'.repeat(8000)]))]) {
    const detail = { ...pack(), pack: { files }, content_sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
    let writes = 0;
    const f = fixture({ callbacks: { requestMarketplace: async () => ({ ok: true, result: detail }), requestDeployment: async () => { writes++; } } });
    const payload = deployment(); payload.expected_content_sha256 = detail.content_sha256; payload.options.goal = 'x'.repeat(24000);
    await assert.rejects(f.adapter.execute('marketplace_deploy', payload, f.identity), /agent instructions|context budget/); assert.equal(writes, 0);
  }
});

test('deployment accepts only explicit manual bounded options and rechecks policy and cancellation after source read', async () => {
  const f = fixture({ callbacks: { requestDeployment: async () => ({ ok: true, result: {} }) } });
  for (const change of [{ trigger: { kind: 'interval', seconds: 10 } }, { root: 'D:/arbitrary' }, { state: 'active' },
    { model: '' }, { name: '' }, { maxRuns: 0 }, { maxRuns: 501 }, { maxRuns: 1.5 }, { maxFailuresInRow: 21 }, { mode: 'shell' }]) {
    await assert.rejects(f.adapter.execute('marketplace_deploy', { ...deployment(), options: { ...deployment().options, ...change } }, f.identity));
  }
  assert.equal(f.calls.length, 0);
  for (const stop of ['cancel', 'block', 'destroy']) {
    let writes = 0; let current;
    current = fixture({ callbacks: { requestMarketplace: async () => { current[stop](); return { ok: true, result: pack() }; },
      requestDeployment: async () => { writes++; return { ok: true, result: {} }; } } });
    await assert.rejects(current.adapter.execute('marketplace_deploy', deployment(), current.identity)); assert.equal(writes, 0);
  }
});

test('workforce assignment dispatches bounded role metadata into the owned coding adapter without donor execution', async () => {
  const sent = [], checked = [];
  const f = fixture({ callbacks: { requestWorkforce: async (operation, payload, identity) => {
    assert.equal(operation, 'acquire'); assert.deepEqual(payload, { code: role().code, expected_sha256: role().expected_sha256 });
    assert.equal(identity, f.identity); return { ok: true, result: profile() };
  }, validateCodingAssignment: (...args) => { checked.push(args); }, requestCodingAssignment: async (...args) => {
    sent.push(args); return { ok: true, result: { session_id: role().session_id, status: 'running' } };
  } } });
  f.adapter.validate('workforce_assign', role(), f.identity); assert.equal(sent.length, 0);
  const result = await f.adapter.execute('workforce_assign', role(), f.identity);
  assert.equal(sent.length, 1); assert.equal(checked.length, 3);
  const [compiled, identity] = sent[0];
  assert.equal(identity, f.identity); assert.equal(compiled.role, 'workforce:reviewer'); assert.equal(compiled.session_id, role().session_id);
  assert.match(compiled.text, /role guidance only/); assert.ok(compiled.text.includes(role().expected_sha256)); assert.ok(compiled.text.endsWith(role().text));
  assert.doesNotMatch(compiled.text, /RAW_DONOR|PRIVATE_DONOR|PRIVATE_ENDPOINT/);
  assert.equal(result.donor_execution_admitted, false); assert.equal(result.status, 'running');
  assert.ok(f.policies.some(([channel, args]) => channel === 'factory:request' && args[0].command === 'workforce_acquire'));
  assert.ok(f.policies.some(([channel]) => channel === 'rc6:submit'));
  assert.equal(f.adapter.catalog().find(item => item.id === 'workforce_assignments').status, 'connected');
});

test('assignment rejects stale profiles, injected source authority and stale coding ownership without mutation', async () => {
  for (const bad of [{ ...role(), code: '../donor' }, { ...role(), expected_sha256: 'fake' }, { ...role(), session_id: '' },
    { ...role(), root: 'D:/donor' }, { ...role(), text: '' }, { ...role(), text: 'x'.repeat(24001) }]) {
    const f = fixture({ callbacks: { validateCodingAssignment() {}, requestCodingAssignment: async () => ({ ok: true, result: {} }) } });
    await assert.rejects(f.adapter.execute('workforce_assign', bad, f.identity)); assert.equal(f.calls.length, 0);
  }
  for (const change of [{ sha256: 'd'.repeat(64) }, { code: 'other' }, { actions: Array(65).fill('read') }]) {
    let writes = 0; const acquired = profile(); Object.assign(acquired.profile, change);
    const f = fixture({ callbacks: { requestWorkforce: async () => ({ ok: true, result: acquired }), validateCodingAssignment() {},
      requestCodingAssignment: async () => { writes++; } } });
    await assert.rejects(f.adapter.execute('workforce_assign', role(), f.identity)); assert.equal(writes, 0);
  }
  const f = fixture({ callbacks: { validateCodingAssignment() { throw new Error('Owned coding session is stale.'); }, requestCodingAssignment() {} } });
  await assert.rejects(f.adapter.execute('workforce_assign', role(), f.identity), /stale/); assert.equal(f.calls.length, 0);
});

test('assignment rechecks policy and native ownership after profile acquisition and never resubmits uncertain mutations', async () => {
  for (const type of ['policy', 'identity', 'ownership']) {
    let current, writes = 0, acquired = false;
    current = fixture({ callbacks: { requestWorkforce: async () => { acquired = true; if (type === 'policy') current.block(); if (type === 'identity') current.cancel(); return { ok: true, result: profile() }; },
      validateCodingAssignment() { if (type === 'ownership' && acquired) throw new Error('Coding connection changed.'); },
      requestCodingAssignment() { writes++; } } });
    await assert.rejects(current.adapter.execute('workforce_assign', role(), current.identity)); assert.equal(writes, 0);
  }
  let writes = 0;
  const failed = fixture({ callbacks: { requestWorkforce: async () => ({ ok: true, result: profile() }), validateCodingAssignment() {},
    requestCodingAssignment: async () => { writes++; throw new Error('PRIVATE'); } } });
  await assert.rejects(failed.adapter.execute('workforce_assign', role(), failed.identity), error => /uncertain/.test(error.message) && !error.message.includes('PRIVATE'));
  assert.equal(writes, 1);
});

test('source digest matches the existing Python engine canonical Unicode and numeric-key ordering', async () => {
  // Computed independently with Python json.dumps(sort_keys=True,
  // ensure_ascii=False, separators=(',', ':')), the engine's existing contract.
  const expected = '6a7c69a6b1dacbc0b37b57ab65ae553087bb65174bb21aea6cfa02277b22d10e';
  const detail = { ...pack(), content_sha256: expected, pack: { files: {
    'agents/reviewer.agent.md': 'Review supplied evidence.', '9': 'numeric', '\uE000': 'bmp', '\u{10000}': 'astral' } } };
  let writes = 0;
  const f = fixture({ callbacks: { requestMarketplace: async () => ({ ok: true, result: detail }),
    requestDeployment: async () => { writes++; return { ok: true, result: {} }; } } });
  await f.adapter.execute('marketplace_deploy', { ...deployment(), expected_content_sha256: expected }, f.identity);
  assert.equal(writes, 1);
  detail.pack.files['agents/reviewer.agent.md'] = '\uD800';
  await assert.rejects(f.adapter.execute('marketplace_deploy', { ...deployment(), expected_content_sha256: expected }, f.identity), /Unicode/);
  assert.equal(writes, 1);
});

test('source export passes only reviewed identity to native Save handling and retains honest preview evidence', async () => {
  const payload = { pack_id: 'reviewer-v1', expected_content_sha256: pack().content_sha256 }, sent = [];
  const f = fixture({ callbacks: { requestMarketplace: async () => ({ ok: true, result: pack() }),
    requestPackExport: async (...args) => { sent.push(args); return { ok: true, result: { saved: true, scope: 'local_source_preview',
      pack_id: payload.pack_id, content_sha256: payload.expected_content_sha256, archive_sha256: 'a'.repeat(64), archive_bytes: 100, path: 'operator-selected.zip' } }; } } });
  f.adapter.validate('marketplace_export', payload, f.identity); assert.equal(sent.length, 0);
  const result = await f.adapter.execute('marketplace_export', payload, f.identity);
  assert.deepEqual(sent, [[payload, f.identity]]);
  assert.equal(result.source_preview_only, true); assert.equal(result.purchase_or_installation_verified, false);
  assert.equal(result.path, 'operator-selected.zip'); assert.equal(f.adapter.isReadOnly('marketplace_export'), false);
  assert.equal(f.adapter.catalog().find(item => item.id === 'marketplace_export').status, 'connected');
  for (const extra of [{ path: 'model-supplied.zip' }, { archive_bytes: 'injected' }, { options: {} }])
    await assert.rejects(f.adapter.execute('marketplace_export', { ...payload, ...extra }, f.identity));
  assert.equal(sent.length, 1);
});

test('source export rejects stale pack bytes before Save and invalid archive receipts after dispatch', async () => {
  const payload = { pack_id: 'reviewer-v1', expected_content_sha256: pack().content_sha256 };
  let saves = 0; const stale = pack(); stale.pack.files['agents/reviewer.agent.md'] += ' changed';
  const changed = fixture({ callbacks: { requestMarketplace: async () => ({ ok: true, result: stale }), requestPackExport: async () => { saves++; } } });
  await assert.rejects(changed.adapter.execute('marketplace_export', payload, changed.identity), /digest/); assert.equal(saves, 0);
  for (const invalid of [ { saved: true, cancelled: true }, { saved: true, scope: 'paid_delivery' },
    { saved: true, scope: 'local_source_preview', pack_id: 'reviewer-v1', content_sha256: payload.expected_content_sha256,
      archive_sha256: 'bad', archive_bytes: 100 },
    { saved: true, scope: 'local_source_preview', pack_id: 'reviewer-v1', content_sha256: payload.expected_content_sha256,
      archive_sha256: 'a'.repeat(64), archive_bytes: 19 * 1024 * 1024 } ]) {
    const f = fixture({ callbacks: { requestMarketplace: async () => ({ ok: true, result: pack() }),
      requestPackExport: async () => { saves++; return { ok: true, result: invalid }; } } });
    await assert.rejects(f.adapter.execute('marketplace_export', payload, f.identity), /export/);
  }
  assert.equal(saves, 4);
});

test('source export preserves native picker cancellation and rejects cancellation during source acquisition', async () => {
  const payload = { pack_id: 'reviewer-v1', expected_content_sha256: pack().content_sha256 };
  const f = fixture({ callbacks: { requestMarketplace: async () => ({ ok: true, result: pack() }),
    requestPackExport: async () => ({ ok: true, result: { cancelled: true, saved: false } }) } });
  const result = await f.adapter.execute('marketplace_export', payload, f.identity);
  assert.equal(result.cancelled, true); assert.equal(result.saved, false);
  let current, saves = 0;
  current = fixture({ callbacks: { requestMarketplace: async () => { current.cancel(); return { ok: true, result: pack() }; },
    requestPackExport: async () => { saves++; } } });
  await assert.rejects(current.adapter.execute('marketplace_export', payload, current.identity), /cancelled/); assert.equal(saves, 0);
});
