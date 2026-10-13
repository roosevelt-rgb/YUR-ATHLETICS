'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createWorkBrowserBroker, validateSource, validateAcquisition, validateContext, digest, AUTHORITY, TTL_MS } = require('../src/work-browser-broker');

function fixture() {
  let clock = 100, wall = Date.parse('2026-09-13T00:00:00Z'), revision = 1, visible = true, reads = 0;
  const owner = { isDestroyed: () => false }, conversation_id = randomUUID();
  const context = text => ({ schema: 'yur.browser-context.v1', source_url: 'https://example.test/page', title: 'Measured page', text, sha256: createHash('sha256').update(text).digest('hex'), acquired_at: new Date(wall).toISOString(), truncated: false, limits: { text_chars: 32000, text_bytes: 65536, text_nodes: 5000, main_frame_only: true, form_fields_excluded: true } });
  const originalHost = { selectWorkDocument() { if (!visible) throw new Error('Show page'); return { source_url: 'https://example.test/page', title: 'Measured page', revision }; },
    async readSelectedPage(document) { reads++; if (document.revision !== revision) throw new Error('Changed'); return context('Quantity 37'); } };
  let host = originalHost;
  const broker = createWorkBrowserBroker({ getHost: () => host, now: () => wall, monotonic: () => clock });
  const select = () => broker.select({ conversation_id }, owner).source;
  const request = source => ({ request_id: randomUUID(), conversation_id, browser_source: source });
  const frame = request => ({ type: 'browser_acquire', schema: 'yur.work-browser-acquisition.v1', acquisition_id: digest({ mission_id: 'a'.repeat(32), step_index: 0, tool: 'acquire_selected_page' }).slice(0, 32), request_id: request.request_id, conversation_id, mission_id: 'a'.repeat(32), step_index: 0, source_id: request.browser_source.source_id, source_sha256: digest(request.browser_source), input_sha256: digest({ source_id: request.browser_source.source_id }), authority_sha256: digest(AUTHORITY), accepted_receipt: 'b'.repeat(64) });
  return { broker, owner, conversation_id, select, request, frame, context, originalHost, reads: () => reads,
    advance: ms => { clock += ms; }, wall: ms => { wall += ms; }, hide: () => { visible = false; }, navigate: () => { revision++; }, replace: () => { host = { ...originalHost }; } };
}

test('browser grant selects only visible operator document and binds one hidden read to its owner/request', async () => {
  const f = fixture(), source = f.select(), request = f.request(source), frame = f.frame(request);
  const binding = f.broker.bind(request, f.owner);
  assert.equal(source.max_acquisitions, 1); assert.equal(Date.parse(source.expires_at) - Date.parse(source.selected_at), TTL_MS);
  f.hide(); assert.throws(f.select, /Show/);
  assert.equal((await f.broker.acquire(frame, request, f.owner, binding)).text, 'Quantity 37');
  assert.equal((await f.broker.acquire(frame, request, f.owner, binding)).text, 'Quantity 37');
  await assert.rejects(f.broker.acquire({ ...frame, accepted_receipt: 'c'.repeat(64) }, request, f.owner, binding), { code: 'BROWSER_SOURCE_CONSUMED' });
  assert.equal(f.reads(), 1);
  assert.equal(f.broker.release({ source_id: source.source_id, conversation_id: f.conversation_id }, f.owner).result.released, false);
  f.broker.complete(binding);
  await assert.rejects(f.broker.acquire(frame, request, f.owner, binding), { code: 'BROWSER_SOURCE_UNAVAILABLE' });
});

test('descriptors never mint authority and cross-owner/conversation/request substitution cannot acquire', async () => {
  const f = fixture(), source = f.select(), request = f.request(source), frame = f.frame(request);
  assert.equal(f.broker.bind(request, {}), null);
  assert.equal(f.broker.bind({ ...request, conversation_id: randomUUID() }, f.owner), null);
  assert.equal(f.broker.bind({ ...request, browser_source: { ...source, title: 'forged' } }, f.owner), null);
  const binding = f.broker.bind(request, f.owner);
  const another = f.request(source);
  assert.equal(f.broker.bind(another, f.owner), null);
  await assert.rejects(f.broker.acquire(frame, request, {}, binding), { code: 'BROWSER_SOURCE_UNAVAILABLE' });
  await assert.rejects(f.broker.acquire(f.frame(another), another, f.owner, binding), { code: 'BROWSER_SOURCE_UNAVAILABLE' });
  await assert.rejects(f.broker.acquire(frame, request, f.owner, null), { code: 'BROWSER_SOURCE_UNAVAILABLE' });
  assert.equal(f.reads(), 0);
});

test('descriptor structure is bounded but expiry does not prevent historical request replay', () => {
  const f = fixture(), source = f.select();
  f.advance(TTL_MS + 1);
  assert.deepEqual(validateSource(source), source);
  assert.equal(f.broker.bind(f.request(source), f.owner), null);
  for (const bad of [{ ...source, authority: AUTHORITY }, { ...source, max_acquisitions: 2 }, { ...source, source_url: 'file:///private' }, { ...source, title: 'x'.repeat(513) }, { ...source, title: '\ud800' }, { ...source, expires_at: source.selected_at }, { ...source, selected_at: '2026-09-13T00:00:00+01:00' }]) assert.throws(() => validateSource(bad));
});

test('browser TTL uses monotonic time and is checked again after extraction', async () => {
  const f = fixture(), source = f.select(), request = f.request(source), binding = f.broker.bind(request, f.owner);
  f.wall(-86400000); f.advance(TTL_MS);
  await assert.rejects(f.broker.acquire(f.frame(request), request, f.owner, binding), { code: 'BROWSER_SOURCE_EXPIRED' });
  assert.equal(f.reads(), 0);
  const g = fixture(), next = g.request(g.select()), token = g.broker.bind(next, g.owner);
  g.originalHost.readSelectedPage = async () => { g.advance(TTL_MS); return g.context('Late'); };
  await assert.rejects(g.broker.acquire(g.frame(next), next, g.owner, token), { code: 'BROWSER_SOURCE_EXPIRED' });
});

test('same-URL document replacement, host replacement, owner teardown and release invalidate grants', async () => {
  for (const change of ['navigate', 'replace', 'revoke']) {
    const f = fixture(), source = f.select(), request = f.request(source), binding = f.broker.bind(request, f.owner);
    if (change === 'revoke') f.broker.revokeOwner(f.owner); else f[change]();
    await assert.rejects(f.broker.acquire(f.frame(request), request, f.owner, binding));
  }
  const f = fixture(), source = f.select(), request = f.request(source);
  assert.equal(f.broker.release({ source_id: source.source_id, conversation_id: f.conversation_id }, {}).result.released, false);
  assert.equal(f.broker.release({ source_id: source.source_id, conversation_id: f.conversation_id }, f.owner).result.released, true);
  assert.equal(f.broker.bind(request, f.owner), null);
});

test('browser acquisition binds exact deterministic ID, all hashes and current mission', () => {
  const f = fixture(), request = f.request(f.select()), frame = f.frame(request);
  assert.equal(validateAcquisition(frame, request, frame.mission_id), frame);
  for (const key of ['accepted_receipt', 'acquisition_id', 'source_sha256', 'input_sha256', 'authority_sha256', 'request_id', 'conversation_id', 'source_id']) assert.throws(() => validateAcquisition({ ...frame, [key]: 'wrong' }, request));
  assert.throws(() => validateAcquisition({ ...frame, input_sha256: digest({ source_id: frame.source_id, url: 'https://other.test/' }) }, request));
  assert.throws(() => validateAcquisition({ ...frame, script: 'arbitrary' }, request));
  assert.throws(() => validateAcquisition(frame, request, 'c'.repeat(32)));
});

test('actual context is validated for source, UTF8 hash, fixed exclusion limits and output bounds', () => {
  const f = fixture(), source = f.select(), context = f.context('Page evidence');
  assert.deepEqual(validateContext(context, source), context);
  for (const bad of [{ ...context, sha256: '0'.repeat(64) }, { ...context, source_url: 'https://other.test/' }, { ...context, limits: { ...context.limits, form_fields_excluded: false } }, f.context('x'.repeat(32001)), f.context('界'.repeat(30000)), f.context('\ud800'), { ...context, code: 'untrusted' }]) assert.throws(() => validateContext(bad, source));
});

test('cancellation discards late extraction and a failed extraction never receives a second use', async () => {
  const f = fixture(), request = f.request(f.select()), frame = f.frame(request), binding = f.broker.bind(request, f.owner), controller = new AbortController();
  let release;
  f.originalHost.readSelectedPage = () => new Promise(resolve => { release = resolve; });
  const pending = f.broker.acquire(frame, request, f.owner, binding, { signal: controller.signal });
  controller.abort(); release(f.context('late'));
  await assert.rejects(pending, { code: 'BROWSER_ACQUISITION_CANCELLED' });
  await assert.rejects(f.broker.acquire(frame, request, f.owner, binding), { code: 'BROWSER_ACQUISITION_CANCELLED' });
});

test('browser credential-like title, URL/query encodings and acquired text are refused before persistence', async () => {
  const f = fixture(), source = f.select(), canary = 'sk-' + 'SYNTHETIC_NOT_A_REAL_KEY_'.repeat(2);
  for (const bad of [{ ...source, title: canary }, { ...source, title: 'api_key="synthetic-fixture-secret"' }, { ...source, source_url: 'https://example.test/?q=' + canary }, { ...source, source_url: 'https://example.test/?api_key=synthetic-value' }, { ...source, source_url: 'https://example.test/?%61pi%5fkey=synthetic-value' }, { ...source, source_url: 'https://example.test/?password=%2522syntheticvalue123%2522' }]) assert.throws(() => validateSource(bad), { code: 'BROWSER_PRIVATE_CONTENT' });
  assert.throws(() => validateContext(f.context(canary), source), { code: 'BROWSER_PRIVATE_CONTENT' });
  assert.throws(() => validateContext(f.context('password="synthetic-fixture-secret"'), source), { code: 'BROWSER_PRIVATE_CONTENT' });
  assert.throws(() => validateContext({ ...f.context('public text'), title: 'api_key="synthetic-fixture-secret"' }, source), { code: 'BROWSER_PRIVATE_CONTENT' });
  f.originalHost.selectWorkDocument = () => ({ source_url: source.source_url, title: canary });
  assert.throws(f.select, { code: 'BROWSER_PRIVATE_CONTENT' });
});

test('literal percent URL stays compatible while malformed escapes cannot mask encoded credentials', () => {
  const f = fixture(), source = f.select();
  assert.doesNotThrow(() => validateSource({ ...source, source_url: 'https://example.test/?discount=50%25' }));
  assert.throws(() => validateSource({ ...source, source_url: 'https://example.test/%ZZ/sk%2DSYNTHETIC_NOT_A_REAL_KEY_12345678' }), { code: 'BROWSER_PRIVATE_CONTENT' });
});

test('identical acquisition shares pending/cached evidence without rereading after navigation or expiry', async () => {
  const f = fixture(), request = f.request(f.select()), frame = f.frame(request), binding = f.broker.bind(request, f.owner);
  let resolvePage, reads = 0;
  f.originalHost.readSelectedPage = () => { reads++; return new Promise(resolve => { resolvePage = resolve; }); };
  const first = f.broker.acquire(frame, request, f.owner, binding), duplicate = f.broker.acquire(frame, request, f.owner, binding);
  resolvePage(f.context('Acquired once'));
  assert.deepEqual(await first, await duplicate);
  f.navigate(); f.advance(TTL_MS + 1);
  const replay = await f.broker.acquire(frame, request, f.owner, binding);
  assert.equal(replay.text, 'Acquired once'); assert.equal(reads, 1);
  f.broker.complete(binding);
  await assert.rejects(f.broker.acquire(frame, request, f.owner, binding), { code: 'BROWSER_SOURCE_UNAVAILABLE' });
});

test('selection budget is finite and replacing an unused conversation grant revokes the prior one', () => {
  const f = fixture(), old = f.select(), replacement = f.select();
  assert.notEqual(old.source_id, replacement.source_id); assert.equal(f.broker.bind(f.request(old), f.owner), null);
  for (let index = 1; index < 32; index++) f.broker.select({ conversation_id: randomUUID() }, f.owner);
  assert.throws(() => f.broker.select({ conversation_id: randomUUID() }, f.owner), { code: 'BROWSER_SOURCE_LIMIT' });
});
