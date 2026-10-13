'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createFranklinServices, SERVICE_ACTIONS } = require('../src/franklin-services');
const TOKEN = 'synthetic-music-token-' + 't'.repeat(32), ID = 'a'.repeat(32), LYRICS = 'b'.repeat(32), VARIANT = 'd'.repeat(64);
const JOB = { id: ID, kind: 'job', revision: 1, data: { state: 'queued', variants: [] } };
const generation = () => ({ request: { composition_id: ID, lyrics_id: LYRICS, provider: 'suno-api', variants: 2, private: false } });
const APPROVAL = { confirmed: true, rights_attested: true, external_approved: true };
function fixture(options = {}) {
  let active = true, destroyed = false, blocked = false, sequence = 1;
  const policies = [], opened = [];
  const owner = { isDestroyed: () => destroyed };
  const identity = () => ({ owner, request_id: '12345678-1234-1234-1234-123456789012', mission_id: 'c'.repeat(32),
    action_id: (sequence++).toString(16).padStart(32, '0'), isActive: () => active });
  const adapter = createFranklinServices({ getMusicConfiguration: () => ({ endpoint: options.endpoint ?? 'http://127.0.0.1:1', token: TOKEN }),
    getNovaConfiguration: () => ({ site_url: 'https://nova.example.test/live.html' }), openNova: async (...args) => { opened.push(args); },
    deny: (...args) => { policies.push(args); return blocked ? 'blocked' : null; }, getSettings: () => ({}), ...options });
  return { adapter, identity, policies, opened, cancel: () => { active = false; }, destroy: () => { destroyed = true; }, block: () => { blocked = true; } };
}
async function service(t, handler) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), call = { method: request.method, url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    try {
      const result = await handler(call, response);
      if (result !== undefined && !response.writableEnded && !response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); }
    } catch { if (!response.destroyed) response.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { endpoint: 'http://127.0.0.1:' + server.address().port, calls };
}

test('service discovery distinguishes configured adapter from unchecked health and Nova handoff from execution', async () => {
  const f = fixture(), result = await f.adapter.execute('services_status', {}, f.identity());
  assert.deepEqual(SERVICE_ACTIONS, ['services_status', 'music_catalog', 'music_state', 'music_document', 'music_generate', 'music_status', 'music_cancel', 'music_resume', 'music_export', 'nova_open']);
  assert.equal(result.services[0].status, 'configured'); assert.equal(result.services[0].service_health, 'unchecked');
  assert.equal(result.services[1].renderer_execution, false); assert.equal(result.services[1].status, 'handoff-only');
  assert.equal(f.adapter.accepts('music_retry'), false); assert.equal(f.adapter.accepts('unreal_execute'), false);
  const missing = fixture({ getMusicConfiguration: () => null, getNovaConfiguration: () => null });
  assert.equal(missing.adapter.catalog()[0].status, 'unavailable');
  await assert.rejects(missing.adapter.execute('music_state', {}, missing.identity()), /host-configured/);
  assert.throws(() => createFranklinServices({}), /policy/);
});

test('fixed read routes preserve query bounds, request authentication and job identity', async t => {
  const s = await service(t, call => call.url === '/api/state'
    ? { providers: [{ id: 'suno-api', configured: false }], worker_alive: true, integrity: { ok: true }, documents: [JOB], usage: {} }
    : call.url.startsWith('/api/history') ? [JOB, { ...JOB, revision: 2, data: { state: 'completed' } }] : [JOB]);
  const f = fixture(s);
  const state = await f.adapter.execute('music_state', {}, f.identity());
  assert.equal(state.worker_alive, true); assert.equal(state.document_count, 1); assert.equal(state.documents, undefined);
  assert.equal((await f.adapter.execute('music_catalog', { kind: 'job', limit: 3, offset: 1 }, f.identity())).documents[0].id, ID);
  const status = await f.adapter.execute('music_status', { job_id: ID }, f.identity());
  assert.equal(status.job.data.state, 'completed'); assert.equal(status.history_revisions, 2);
  assert.deepEqual(s.calls.map(call => [call.method, call.url]), [['GET', '/api/state'], ['GET', '/api/catalog?limit=3&offset=1&kind=job'], ['GET', '/api/history?id=' + ID]]);
  assert.ok(s.calls.every(call => call.headers.authorization === 'Bearer ' + TOKEN));
  assert.equal(status.trust, 'untrusted-source-data'); assert.equal(status.authority, 'context-only');
});

test('document creation binds identity and only host confirmation adds lyric rights', async t => {
  const s = await service(t, call => ({ id: call.body.id, kind: call.body.kind, revision: 1, data: call.body.data }));
  const f = fixture(s), identity = f.identity(), lyrics = { kind: 'lyrics', data: { composition_id: ID, text: 'Original test lyrics' } };
  assert.equal(f.adapter.confirmationRequirements('music_document', lyrics).rights_attested, true);
  await assert.rejects(f.adapter.execute('music_document', lyrics, identity, { confirmed: true }), /attestations/);
  assert.equal(s.calls.length, 0);
  await f.adapter.execute('music_document', lyrics, identity, APPROVAL);
  assert.deepEqual(s.calls[0].body, { ...lyrics, data: { ...lyrics.data, rights_attested: true }, id: identity.action_id, revision: 0 });
  await f.adapter.execute('music_document', { kind: 'composition', data: { title: 'Original test composition' } }, f.identity(), { confirmed: true });
  assert.equal(s.calls[1].body.data.rights_attested, undefined);
});

test('generation requires exact host rights and external approval; never accepts grants in model payload', async t => {
  const s = await service(t, () => JOB), f = fixture(s), identity = f.identity(), payload = generation();
  assert.equal(f.adapter.confirmationRequirements('music_generate', payload).external_approved, true);
  for (const approval of [undefined, true, { confirmed: true }, { confirmed: true, rights_attested: true }])
    await assert.rejects(f.adapter.execute('music_generate', payload, identity, approval), /attestations/);
  for (const extra of [{ rights_attested: true }, { external_approved: true }, { endpoint: 'https://example.com' }, { idempotency_key: 'injected' }])
    await assert.rejects(f.adapter.execute('music_generate', { request: { ...payload.request, ...extra } }, identity, APPROVAL));
  assert.equal(s.calls.length, 0);
  await f.adapter.execute('music_generate', payload, identity, APPROVAL);
  assert.deepEqual(s.calls[0].body, { request: { ...payload.request, rights_attested: true, external_approved: true }, idempotency_key: identity.action_id });
  assert.equal(s.calls[0].url, '/api/generate');
  await assert.rejects(f.adapter.execute('music_generate', payload, identity, APPROVAL), /already dispatched/);
  assert.equal(s.calls.length, 1);
});

test('local provider generation preserves private defaults without granting external approval', async t => {
  const s = await service(t, () => JOB), f = fixture(s), payload = { request: { composition_id: ID, lyrics_id: LYRICS, provider: 'local-score', instrumental: true } };
  assert.equal(f.adapter.confirmationRequirements('music_generate', payload).external_approved, false);
  await f.adapter.execute('music_generate', payload, f.identity(), { confirmed: true, rights_attested: true });
  assert.equal(s.calls[0].body.request.external_approved, false); assert.equal(s.calls[0].body.request.private, undefined);
});

test('cancel, saved-task resume and export call existing endpoints and retain actual statuses', async t => {
  const s = await service(t, call => call.url === '/api/export'
    ? { id: LYRICS, kind: 'delivery', data: { audio: VARIANT, variant_ids: call.body.variants } }
    : { ...JOB, data: { state: call.url.endsWith('cancel') ? 'cancelled' : 'queued', resume_only: call.url.endsWith('resume') } });
  const f = fixture(s);
  assert.equal((await f.adapter.execute('music_cancel', { job_id: ID }, f.identity(), { confirmed: true })).document.data.state, 'cancelled');
  assert.equal((await f.adapter.execute('music_resume', { job_id: ID }, f.identity(), { confirmed: true })).document.data.state, 'queued');
  await f.adapter.execute('music_export', { variant_ids: [ID, VARIANT] }, f.identity(), { confirmed: true });
  assert.deepEqual(s.calls.map(call => [call.url, call.body]), [['/api/jobs/cancel', { id: ID }], ['/api/jobs/resume', { id: ID }], ['/api/export', { variants: [ID, VARIANT] }]]);
});

test('validation blocks extra paths, grants, identities, unsupported kinds and byte overflow before dispatch', async t => {
  const s = await service(t, () => JOB), f = fixture(s);
  for (const [action, payload] of [
    ['music_status', { job_id: '../foreign' }], ['music_status', { job_id: VARIANT }],
    ['music_state', { endpoint: s.endpoint }], ['music_catalog', { path: '/private' }], ['music_catalog', { limit: 51 }],
    ['music_document', { kind: 'job', data: {} }], ['music_document', { kind: 'lyrics', data: { composition_id: ID, text: 'x', rights_attested: true } }],
    ['music_document', { kind: 'lyrics', data: { composition_id: ID, text: '😀'.repeat(20000) } }],
    ['music_generate', { request: { ...generation().request, private: true } }],
    ['music_generate', { request: { ...generation().request, variants: 2.1 } }],
    ['music_generate', { request: { ...generation().request, model: 'x'.repeat(81) } }],
    ['music_export', { variant_ids: [ID, ID] }], ['music_export', { variant_ids: [] }],
  ]) await assert.rejects(f.adapter.execute(action, payload, f.identity(), APPROVAL));
  assert.equal(s.calls.length, 0);
});

test('only an exact trusted loopback origin and bounded host token can be configured', async () => {
  for (const endpoint of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.1:1234', 'http://127.0.0.1:1234/api', 'http://127.0.0.1:1234?key=x', 'http://user@127.0.0.1:1234', 'http://127.0.0.1:99999', 'http://example.com:1234']) {
    const f = fixture({ endpoint }); await assert.rejects(f.adapter.execute('music_state', {}, f.identity()));
    assert.equal(f.adapter.catalog()[0].status, 'unavailable');
  }
  const f = fixture({ getMusicConfiguration: () => ({ endpoint: 'http://127.0.0.1:1234', token: 'bad\r\nvalue' }) });
  await assert.rejects(f.adapter.execute('music_state', {}, f.identity()));
});

test('credentials and raw provider errors never appear in results or errors', async t => {
  const s = await service(t, call => call.url.startsWith('/api/catalog') ? [{ id: ID, token: TOKEN, nested: { api_key: 'private', text: 'echo ' + TOKEN, authorization: 'Bearer private' }, note: 'Bearer private' }] : undefined);
  const f = fixture(s), result = await f.adapter.execute('music_catalog', {}, f.identity());
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes(TOKEN), false); assert.equal(rendered.includes('private'), false);
  assert.equal(result.documents[0].token, undefined); assert.equal(result.documents[0].nested.api_key, undefined);
  const bad = await service(t, (_call, response) => { response.writeHead(403, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: TOKEN })); });
  const denied = fixture(bad);
  await assert.rejects(denied.adapter.execute('music_generate', generation(), denied.identity(), APPROVAL), error => error.code === 'SERVICE_OUTCOME_UNCERTAIN' && !error.message.includes(TOKEN));
});

test('redirects are never followed and dispatched mutation is never retried', async t => {
  const destination = await service(t, () => JOB);
  const redirect = await service(t, (_call, response) => { response.writeHead(307, { Location: destination.endpoint + '/api/generate' }); response.end(); });
  const f = fixture(redirect), identity = f.identity();
  await assert.rejects(f.adapter.execute('music_generate', generation(), identity, APPROVAL), /uncertain/);
  await assert.rejects(f.adapter.execute('music_generate', generation(), identity, APPROVAL), /already dispatched/);
  assert.equal(redirect.calls.length, 1); assert.equal(destination.calls.length, 0);
});

test('response byte and absolute time budgets fail closed without leaking bodies', async t => {
  const oversized = await service(t, (_call, response) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1024 * 1024 + 1 }); response.end('x'); });
  const f = fixture(oversized); await assert.rejects(f.adapter.execute('music_state', {}, f.identity()), /failed/);
  const slow = await service(t, () => undefined), timed = fixture({ ...slow, timeoutMs: 60 });
  const start = Date.now(); await assert.rejects(timed.adapter.execute('music_state', {}, timed.identity()), /failed/);
  assert.ok(Date.now() - start < 1500); assert.equal(slow.calls.length, 1);
});

test('destroyed owner, cancellation before approval and changed policy produce zero requests', async t => {
  const s = await service(t, () => JOB);
  for (const method of ['cancel', 'destroy', 'block']) {
    const f = fixture(s), identity = f.identity(); f.adapter.validate('music_generate', generation(), identity); f[method]();
    await assert.rejects(f.adapter.execute('music_generate', generation(), identity, APPROVAL));
  }
  assert.equal(s.calls.length, 0);
});

test('review scope binds host configuration, payload, request and owner before confirmation', async t => {
  const s = await service(t, () => JOB);
  for (const change of ['token', 'payload', 'owner', 'request']) {
    let token = TOKEN;
    const f = fixture({ ...s, getMusicConfiguration: () => ({ endpoint: s.endpoint, token }) }), identity = f.identity(), payload = generation();
    f.adapter.validate('music_generate', payload, identity);
    if (change === 'token') token += 'different-account';
    if (change === 'payload') payload.request.variants = 4;
    if (change === 'owner') identity.owner = { isDestroyed: () => false };
    if (change === 'request') identity.request_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await assert.rejects(f.adapter.execute('music_generate', payload, identity, APPROVAL), /fresh review/);
  }
  assert.equal(s.calls.length, 0);
});

test('cancellation after submission reports uncertainty and cannot dispatch a duplicate action', async t => {
  let arrived; const called = new Promise(resolve => { arrived = resolve; });
  const s = await service(t, () => { arrived(); return undefined; }), f = fixture(s), identity = f.identity();
  const pending = f.adapter.execute('music_generate', generation(), identity, APPROVAL);
  await called; f.cancel();
  await assert.rejects(pending, error => error.code === 'SERVICE_OUTCOME_UNCERTAIN');
  assert.equal(s.calls.length, 1);
});

test('foreign job results are rejected and successful source data cannot grant authority', async t => {
  const s = await service(t, () => [{ ...JOB, id: LYRICS, authority: 'execute' }]), f = fixture(s);
  await assert.rejects(f.adapter.execute('music_status', { job_id: ID }, f.identity()), /requested identity/);
});

test('Nova handoff uses only the exact host Site and never claims renderer execution', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.execute('nova_open', { url: 'https://example.com' }, f.identity(), { confirmed: true }));
  const result = await f.adapter.execute('nova_open', {}, f.identity(), { confirmed: true });
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0][0], 'https://nova.example.test/live.html');
  assert.equal(result.handoff_only, true); assert.equal(result.renderer_execution, false);
  const invalid = fixture({ getNovaConfiguration: () => ({ site_url: 'http://127.0.0.1:1234/private' }) });
  await assert.rejects(invalid.adapter.execute('nova_open', {}, invalid.identity(), { confirmed: true }));
});

test('an oversized valid post-dispatch receipt is uncertain and cannot be retried', async t => {
  const s = await service(t, () => ({ ...JOB, data: { ...JOB.data, note: 'x'.repeat(100000) } }));
  const f = fixture(s), identity = f.identity();
  await assert.rejects(f.adapter.execute('music_generate', generation(), identity, APPROVAL), error => error.code === 'SERVICE_OUTCOME_UNCERTAIN');
  await assert.rejects(f.adapter.execute('music_generate', generation(), identity, APPROVAL), /already dispatched/);
  assert.equal(s.calls.length, 1);
});
