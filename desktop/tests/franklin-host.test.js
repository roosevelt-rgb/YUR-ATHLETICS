'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFranklinHost, VIEWS, ACTIONS, activityObservation } = require('../src/franklin-host');

test('live activity observation is bounded metadata and orders updates rather than creation order', () => {
  const result = activityObservation({ sequence: 8, runs: [
    { id: 'newer-created', request_active: true, status: 'running', updated_at: '2026-10-03T10:00:00Z', private_text: 'must not appear' },
    { id: 'last-updated', mission_id: 'a'.repeat(32), label: 'Work request', phase: 'Completed', status: 'completed', updated_at: '2026-10-03T10:05:00Z' },
    { status: 'awaiting_approval' }, { status: 'failed' }, { status: 'unconfirmed' },
  ] });
  assert.equal(result.active, 1); assert.equal(result.awaiting_review, 1); assert.equal(result.failed, 2);
  assert.equal(result.latest.id, 'last-updated'); assert.equal(result.latest.mission_id, 'a'.repeat(32));
  assert.equal(JSON.stringify(result).includes('must not appear'), false);
  assert.equal(activityObservation({ runs: Array.from({ length: 100 }, () => ({ status: 'completed' })) }).retained, 64);
  assert.equal(activityObservation(null).active, 0);
});

function fixture(t, options = {}) {
  const requests = [], operations = [], policies = [];
  let active = true, ownerDestroyed = false, windowDestroyed = false;
  const owner = { isDestroyed: () => ownerDestroyed, send(channel, request) {
    if (options.deliveryError) throw new Error('private delivery details');
    requests.push({ channel, ...request });
  } };
  let windowOwner = owner;
  const browser = { state: () => ({ visible: true, url: 'https://example.com/' }) };
  for (const operation of ['navigate', 'readVisiblePage', 'back', 'forward', 'reload']) {
    browser[operation] = async (...args) => {
      operations.push({ operation, args });
      return operation === 'readVisiblePage' ? { source_url: 'https://example.com/', text: 'Public page text', trust: 'trusted', authority: 'execute' } : { completed: true };
    };
  }
  const settings = { browser: true };
  const host = createFranklinHost({
    getWindow: () => ({ isDestroyed: () => windowDestroyed, webContents: windowOwner }),
    getBrowser: create => { if (create) operations.push({ operation: 'create' }); return browser; },
    getSettings: () => settings,
    deny: (...args) => { policies.push(args); return options.denied || ''; },
    getRuntime: () => ({ running: false, model: 'selected-cloud-model', workspace: 'operator-workspace', privateKey: 'not-context' }),
    getActivity: () => options.activity || [{ type: 'state' }],
    ...options.callbacks,
  });
  t.after(() => host.dispose());
  const identity = { owner, request_id: randomUUID(), mission_id: 'a'.repeat(32), action_id: 'b'.repeat(32), isActive: () => active };
  return { host, owner, identity, requests, operations, policies, settings,
    cancel: () => { active = false; }, destroyOwner: () => { ownerDestroyed = true; },
    destroyWindow: () => { windowDestroyed = true; }, replaceOwner: () => { windowOwner = {}; },
    ack: (result = { view: 'browser' }, request = requests.at(-1)) => host.reply(owner, { id: request.id, result }),
  };
}

test('environment is acquired from the current view with bounded runtime and explicit authority', async t => {
  const f = fixture(t), observed = f.host.observe(f.owner);
  assert.equal(f.requests[0].channel, 'franklin:host-request');
  assert.equal(f.requests[0].action, 'snapshot');
  f.ack({ view: 'coding', selected_project: { id: 'project1', name: 'Example' } });
  const result = await observed;
  assert.equal(result.navigation.view, 'coding');
  assert.deepEqual(result.coding, { running: false, model: 'selected-cloud-model', workspace: 'operator-workspace' });
  assert.equal(JSON.stringify(result).includes('not-context'), false);
  assert.equal(result.browser.url, 'https://example.com/');
  assert.equal(result.authority.scope, 'desktop-mission-execution-v1');
  assert.equal(result.authority.max_actions, 20);
  assert.deepEqual(result.authority.actions, ACTIONS);
  assert.deepEqual(result.views, VIEWS);
});

test('scope rejects foreign owners, missing identities and cancelled requests before any action', async t => {
  const f = fixture(t);
  for (const identity of [null, {}, { ...f.identity, owner: {} }, { ...f.identity, request_id: 'bad' }, { ...f.identity, mission_id: '../mission' }, { ...f.identity, isActive: false }]) {
    await assert.rejects(f.host.execute('open_view', { view: 'media' }, identity), /scope|unavailable/);
  }
  f.cancel();
  await assert.rejects(f.host.execute('browser_navigate', { url: 'https://example.com' }, f.identity), /cancelled/);
  assert.equal(f.requests.length, 0); assert.equal(f.operations.length, 0);
});

test('a busy Desktop supplies bounded recent activity without injecting its full event history', async t => {
  const runs = Array.from({ length: 64 }, (_, id) => ({ id: String(id), status: 'completed',
    tools: Array.from({ length: 20 }, (_, index) => ({ id: String(index), name: 'text_analyze', status: 'completed' })),
    events: Array.from({ length: 80 }, () => ({ label: 'Retained operational detail '.repeat(8) })) }));
  const f = fixture(t, { activity: { schema: 'yur.activity.v1', runs, omitted_runs: 2 } });
  const pending = f.host.observe(f.owner); f.ack({ view: 'conversation' });
  const environment = await pending;
  assert.equal(environment.activity.runs.length, 12); assert.equal(environment.activity.omitted_runs, 54);
  assert.equal(environment.activity.runs[0].tools.length, 8);
  assert.equal(Object.hasOwn(environment.activity.runs[0], 'events'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(environment)) < 32768);
});

test('only exact admitted view payloads are sent to the existing Desktop navigation', async t => {
  const f = fixture(t);
  for (const [action, payload] of [['open_view', { view: 'shell' }], ['open_view', { view: 'media', code: 'anything' }], ['shell', {}], ['browser_read', { script: 'anything' }], ['snapshot', { any: true }], ['open_view', []]]) {
    await assert.rejects(f.host.execute(action, payload, f.identity));
  }
  assert.equal(f.requests.length, 0);
  const opened = f.host.execute('open_view', { view: 'workforce' }, f.identity);
  assert.equal(f.requests[0].action, 'open_view'); assert.deepEqual(f.requests[0].payload, { view: 'workforce' });
  // Existing navigation may report its established internal alias.
  f.ack({ view: 'agents' }); assert.deepEqual(await opened, { view: 'agents' });
});

test('browser policy and URL constraints apply before opening a view or navigating', async t => {
  const denied = fixture(t, { denied: 'Browser operation is disabled.' });
  await assert.rejects(denied.host.execute('browser_navigate', { url: 'https://example.com' }, denied.identity), /disabled/);
  assert.equal(denied.requests.length, 0); assert.equal(denied.operations.length, 0);
  assert.deepEqual(denied.policies[0], ['browser:action', ['navigate', 'https://example.com'], denied.settings]);
  const f = fixture(t);
  for (const url of ['file:///private', 'http://example.com', 'https://user:secret@example.com', 'javascript:alert(1)', 'https://example.com/\n']) {
    await assert.rejects(f.host.execute('browser_navigate', { url }, f.identity));
  }
  assert.equal(f.requests.length, 0); assert.equal(f.operations.length, 0);
  for (const url of ['https://example.com/allowed', 'http://127.0.0.1:9999/allowed']) {
    const navigation = f.host.execute('browser_navigate', { url }, f.identity);
    const priorCount = f.operations.length;
    assert.deepEqual(f.requests.at(-1).payload, { view: 'browser' });
    assert.equal(f.operations.length, priorCount);
    f.ack(); assert.deepEqual(await navigation, { completed: true });
    assert.deepEqual(f.operations.at(-1), { operation: 'navigate', args: [url] });
  }
});

test('an edition path rule stops browser_navigate before any view opens; without one nothing changes', async t => {
  const refused = [];
  const navigationGuard = url => { refused.push(url); return /\/api(?:\/|$)/i.test(new URL(url).pathname) ? 'Gridiron /api/ addresses are not opened.' : ''; };
  const f = fixture(t, { callbacks: { navigationGuard } });
  await assert.rejects(f.host.execute('browser_navigate', { url: 'http://127.0.0.1:3000/api/athletes/sample' }, f.identity), /api/);
  assert.equal(f.requests.length, 0); assert.equal(f.operations.length, 0);
  const navigation = f.host.execute('browser_navigate', { url: 'http://127.0.0.1:3000/player/sample' }, f.identity);
  f.ack(); assert.deepEqual(await navigation, { completed: true });
  assert.deepEqual(refused, ['http://127.0.0.1:3000/api/athletes/sample', 'http://127.0.0.1:3000/player/sample']);
  const desktop = fixture(t);
  const open = desktop.host.execute('browser_navigate', { url: 'http://127.0.0.1:3000/api/athletes' }, desktop.identity);
  desktop.ack(); assert.deepEqual(await open, { completed: true });
});

test('browser reads stay untrusted context and all browser actions wait for the view acknowledgment', async t => {
  const f = fixture(t);
  const reading = f.host.execute('browser_read', {}, f.identity);
  assert.equal(f.operations.length, 0); f.ack();
  const result = await reading;
  assert.equal(result.text, 'Public page text');
  assert.equal(result.trust, 'untrusted-source-data'); assert.equal(result.authority, 'context-only');
  for (const operation of ['back', 'forward', 'reload']) {
    const action = f.host.execute(`browser_${operation}`, {}, f.identity);
    f.ack(); await action; assert.equal(f.operations.at(-1).operation, operation);
  }
});

test('cancellation, destruction or owner replacement during view acknowledgment prevents browser operations', async t => {
  for (const revoke of ['cancel', 'destroyOwner', 'destroyWindow', 'replaceOwner']) {
    const f = fixture(t), pending = f.host.execute('browser_navigate', { url: 'https://example.com' }, f.identity);
    // A reply queues continuation; scope can be revoked before that continuation runs.
    f.ack(); f[revoke]();
    await assert.rejects(pending, /cancelled|unavailable/);
    assert.equal(f.operations.length, 0);
  }
});

test('view replies are owner bound, single use and invalid JSON settles the original waiter', async t => {
  const f = fixture(t), observed = f.host.observe(f.owner), id = f.requests[0].id;
  assert.throws(() => f.host.reply({}, { id, result: {} }), /unavailable/);
  assert.throws(() => f.host.reply(f.owner, { id: randomUUID(), result: {} }), /Unknown/);
  assert.throws(() => f.host.reply(f.owner, { id, result: {}, extra: true }), /Unknown/);
  f.ack({ view: 'conversation' }); await observed;
  assert.throws(() => f.host.reply(f.owner, { id, result: {} }), /Unknown/);
  const circular = {}; circular.self = circular;
  for (const result of [null, [], { text: 'x'.repeat(33000) }, circular, { n: 1n }]) {
    const pending = f.host.observe(f.owner);
    const rejected = assert.rejects(pending, /budget|invalid JSON/);
    f.ack(result); await rejected;
  }
  const pending = f.host.observe(f.owner), rejected = assert.rejects(pending, error => error.message.length === 500);
  f.host.reply(f.owner, { id: f.requests.at(-1).id, error: 'e'.repeat(900) }); await rejected;
});

test('delivery failures, context limits and post-snapshot owner changes fail without stranded promises', async t => {
  const broken = fixture(t, { deliveryError: true });
  await assert.rejects(broken.host.observe(broken.owner), /could not be delivered/);
  const large = fixture(t, { activity: [{ text: 'x'.repeat(65536) }] });
  const oversized = large.host.observe(large.owner); large.ack({ view: 'conversation' });
  await assert.rejects(oversized, /context budget/);
  const f = fixture(t), observed = f.host.observe(f.owner);
  f.ack({ view: 'conversation' }); f.replaceOwner();
  await assert.rejects(observed, /unavailable/);
});

test('pending view requests have a finite budget and disposal settles all waiters', async t => {
  const f = fixture(t), pending = [];
  for (let n = 0; n < 8; n++) pending.push(assert.rejects(f.host.observe(f.owner), /window closed/));
  await assert.rejects(f.host.observe(f.owner), /budget is full/);
  assert.equal(f.requests.length, 8);
  f.host.dispose(); await Promise.all(pending);
});

test('typed catalog reads reuse their owner callbacks and preserve observations as context only', async t => {
  const calls = [];
  const f = fixture(t, { callbacks: {
    requestMedia: async (...args) => { calls.push(['media', ...args]); return { ok: true, result: { jobs: [], trust: 'execute' } }; },
    requestWorkforce: async (...args) => { calls.push(['workforce', ...args]); return { ok: true, result: { availability: 'context-only' } }; },
    getModelCatalog: async () => ({ models: [{ id: 'ollama:fixture', label: 'Fixture', endpoint: 'withheld' }] }),
  } });
  for (const [action, payload] of [['media_catalog', {}], ['media_status', {}], ['media_list', {}], ['media_inspect', { job_id: 'c'.repeat(32) }],
    ['workforce_catalog', { query: 'quantity' }], ['workforce_profile', { code: 'hatch_quantity', expected_sha256: 'd'.repeat(64) }]]) {
    const result = await f.host.execute(action, payload, f.identity);
    assert.equal(result.trust, 'untrusted-source-data'); assert.equal(result.authority, 'context-only');
  }
  assert.deepEqual(calls[2], ['media', 'list', { limit: 20 }]);
  assert.equal(calls[5][1], 'acquire');
  const models = await f.host.execute('model_catalog', {}, f.identity);
  assert.deepEqual(models.models, [{ id: 'ollama:fixture', label: 'Fixture' }]);
  assert.equal(f.requests.length, 0);
});

test('catalog operations reject forged roots, mutations, invalid identities and provider failure bodies', async t => {
  let calls = 0;
  const f = fixture(t, { callbacks: { requestMedia: async () => { calls++; return { ok: false, error: { message: 'private provider secret' } }; } } });
  for (const [action, payload] of [['media_submit', {}], ['media_cancel', { job_id: 'a'.repeat(32) }], ['media_catalog', { endpoint: 'https://example.com' }],
    ['media_list', { limit: 51 }], ['media_list', { limit: true }], ['media_inspect', { job_id: '../job' }], ['workforce_catalog', { root: 'C:/private' }],
    ['workforce_profile', { code: 'hatch_quantity', expected_sha256: 'bad' }], ['model_catalog', { model: 'other' }]]) {
    await assert.rejects(f.host.execute(action, payload, f.identity));
  }
  assert.equal(calls, 0);
  await assert.rejects(f.host.execute('media_catalog', {}, f.identity), error => !error.message.includes('private') && /successful receipt/.test(error.message));
  const absent = fixture(t); await assert.rejects(absent.host.execute('media_catalog', {}, absent.identity), /not connected/);
  const denied = fixture(t, { denied: 'Disabled', callbacks: { requestMedia: () => assert.fail('policy bypass') } });
  await assert.rejects(denied.host.execute('media_status', {}, denied.identity), /Disabled/);
});

test('media draft uses committed identity and owner acknowledgment without any generation submission', async t => {
  const f = fixture(t, { callbacks: { requestMedia: () => assert.fail('draft cannot submit media') } });
  const pending = f.host.execute('media_draft', { preset: 'flux-klein-image-v1', prompt: 'A pool garden' }, f.identity);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].action, 'media_draft');
  assert.deepEqual(f.requests[0].payload.request, { request_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', preset: 'flux-klein-image-v1', prompt: 'A pool garden', negative_prompt: '', seed: 1, width: 1024, height: 1024 });
  f.ack({ prepared: true, request_id: f.requests[0].payload.request.request_id, requires_operator: true }); const result = await pending;
  assert.equal(result.prepared, true); assert.equal(result.submitted, false); assert.equal(result.requires_operator_review, true);
  assert.equal(result.action_id, f.identity.action_id);
});

test('media draft validation and revoked scope prevent form changes', async t => {
  const f = fixture(t, { callbacks: { prepareMediaDraft: () => assert.fail('cancelled draft prepared') } });
  for (const patch of [{ request_id: randomUUID() }, { preset: 'arbitrary' }, { width: 257 }, { width: 1536, height: 1536, preset: 'wan22-video-v1', input_asset_id: 'a'.repeat(64) },
    { preset: 'wan22-video-v1' }, { frames: 49 }, { prompt: ' ' }, { seed: true }, { negative_prompt: 'ignored for images' }]) {
    await assert.rejects(f.host.execute('media_draft', { preset: 'flux-klein-image-v1', prompt: 'Garden', ...patch }, f.identity));
  }
  assert.equal(f.requests.length, 0);
  f.cancel();
  await assert.rejects(f.host.execute('media_draft', { preset: 'flux-klein-image-v1', prompt: 'Garden' }, f.identity), /cancelled/);
  assert.equal(f.requests.length, 0);
});

test('media draft acknowledgment must identify the exact request and cannot complete after cancellation', async t => {
  for (const request_id of [undefined, randomUUID()]) {
    const f = fixture(t), pending = f.host.execute('media_draft', { preset: 'flux-klein-image-v1', prompt: 'Garden' }, f.identity);
    f.ack({ prepared: true, request_id }); await assert.rejects(pending, /exact draft/);
    assert.equal(f.requests.length, 1);
  }
  const f = fixture(t), pending = f.host.execute('media_draft', { preset: 'flux-klein-image-v1', prompt: 'Garden' }, f.identity);
  f.ack({ prepared: true, request_id: f.requests[0].payload.request.request_id }); f.cancel();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.requests.length, 1);
});

test('music drafts preserve exact owner identity and never acknowledge generation', async t => {
  const f = fixture(t), draft = { mode: 'custom', title: 'Silver light', lyrics: '[Verse]\nA new beginning', style: 'Soul', instrumental: false };
  const pending = f.host.execute('music_draft', draft, f.identity);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].action, 'music_draft');
  assert.deepEqual(f.requests[0].payload.draft, draft);
  assert.equal(f.requests[0].payload.request_id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  f.ack({ prepared: true, submitted: false, request_id: f.requests[0].payload.request_id });
  const receipt = await pending; assert.equal(receipt.prepared, true); assert.equal(receipt.submitted, false);
  for (const patch of [{ request_id: randomUUID() }, { mode: 'other' }, { external_approved: true }, { instrumental: 'false' }, { title: 'x'.repeat(81) }]) {
    await assert.rejects(f.host.execute('music_draft', { ...draft, ...patch }, f.identity));
  }
  assert.equal(f.requests.length, 1);
});

test('music drafts reject foreign or generation acknowledgments and cancelled owners', async t => {
  for (const patch of [{ request_id: randomUUID() }, { submitted: true }, { submitted: undefined }]) {
    const f = fixture(t), pending = f.host.execute('music_draft', { mode: 'simple', description: 'A hopeful song' }, f.identity);
    f.ack({ prepared: true, submitted: false, request_id: f.requests[0].payload.request_id, ...patch });
    await assert.rejects(pending, /exact draft/);
  }
  const f = fixture(t), pending = f.host.execute('music_draft', { mode: 'simple' }, f.identity);
  f.ack({ prepared: true, submitted: false, request_id: f.requests[0].payload.request_id }); f.cancel();
  await assert.rejects(pending, /cancelled/);
});

test('catalog result budgets and cancellation apply after asynchronous reads', async t => {
  let finish;
  const f = fixture(t, { callbacks: { requestMedia: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = f.host.execute('media_catalog', {}, f.identity); f.cancel(); finish({ ok: true, result: {} });
  await assert.rejects(pending, /cancelled/);
  for (const result of [{ text: 'x'.repeat(100000) }, { count: Infinity }]) {
    const large = fixture(t, { callbacks: { requestMedia: async () => ({ ok: true, result }) } });
    await assert.rejects(large.host.execute('media_catalog', {}, large.identity), /budget|nonfinite/);
  }
});
