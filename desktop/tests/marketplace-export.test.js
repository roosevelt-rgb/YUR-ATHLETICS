'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createMarketplaceExport, fetchPackSourceArchive, isPackDownloadPath, MAX_PACK_EXPORT_BYTES } = require('../src/marketplace-export');
const { createHarnessSidecar, isAllowed } = require('../src/harness-sidecar');
const contentDigest = 'c'.repeat(64);
const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('owned source fixture')]);
const archiveDigest = createHash('sha256').update(bytes).digest('hex');
const payload = { pack_id: 'owned-pack-v1', expected_content_sha256: contentDigest };
const binary = () => ({ ok: true, result: { bytes: Buffer.from(bytes), scope: 'local_source_preview', content_sha256: contentDigest, archive_sha256: archiveDigest } });
const headers = () => ({ 'content-type': 'application/zip', 'x-yur-export-scope': 'local_source_preview',
  'x-yur-content-sha256': contentDigest, 'x-yur-archive-sha256': archiveDigest, 'content-length': String(bytes.length) });

async function fixture(t, overrides = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'franklin-pack-export-'));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let active = true, blocked = false, destroyed = false;
  const calls = [], owner = { isDestroyed: () => destroyed };
  const window = { webContents: owner, isDestroyed: () => destroyed };
  const identity = { owner, isActive: () => active };
  const target = path.join(folder, 'chosen.zip');
  const host = createMarketplaceExport({ requestBinary: async (...args) => { calls.push(['download', ...args]); return binary(); },
    dialog: { showSaveDialog: async (...args) => { calls.push(['picker', ...args]); return { canceled: false, filePath: target }; } },
    getWindow: () => window, deny: () => blocked ? 'blocked' : null, getSettings: () => ({}), ...overrides });
  return { host, folder, target, identity, calls, cancel: () => { active = false; }, block: () => { blocked = true; }, destroy: () => { destroyed = true; } };
}

test('binary source transport accepts only the fixed loopback export path and never expands the renderer JSON allowlist', async () => {
  assert.equal(isPackDownloadPath('/api/packs/owned-pack-v1/download'), true);
  assert.equal(isAllowed('GET', '/api/packs/owned-pack-v1/download'), false);
  for (const value of ['/api/packs/../download', '/api/packs/id/download?url=x', 'https://other/export', '/api/orders/x/download'])
    assert.equal(isPackDownloadPath(value), false);
  let calls = 0;
  const result = await fetchPackSourceArchive({ base: 'http://127.0.0.1:8181', apiPath: '/api/packs/owned-pack-v1/download', headers: { authorization: 'Bearer fixture-only' },
    fetchImpl: async (url, init) => {
      calls++; assert.equal(url, 'http://127.0.0.1:8181/api/packs/owned-pack-v1/download'); assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error'); assert.ok(init.signal); return new Response(bytes, { headers: headers() });
    } });
  assert.equal(calls, 1); assert.deepEqual(result.bytes, bytes); assert.equal(result.archive_sha256, archiveDigest);
  assert.deepEqual(Object.keys(result).sort(), ['archive_sha256', 'bytes', 'content_sha256', 'scope']);
  for (const base of ['https://outside.invalid', 'http://localhost:8181', 'http://127.0.0.1:8181/private', 'http://127.0.0.1:65536'])
    await assert.rejects(fetchPackSourceArchive({ base, apiPath: '/api/packs/id/download', fetchImpl: () => { throw new Error('Must not fetch'); } }));
});

test('binary transport rejects redirects, HTTP rejection, oversized headers, wrong digest and truncated body', async () => {
  const replies = [
    () => new Response(null, { status: 302, headers: { location: 'https://outside.invalid' } }),
    () => new Response('PRIVATE_SERVER_DETAIL', { status: 403 }),
    () => new Response(bytes, { headers: { ...headers(), 'content-length': String(MAX_PACK_EXPORT_BYTES + 1) } }),
    () => new Response(bytes, { headers: { ...headers(), 'x-yur-archive-sha256': 'a'.repeat(64) } }),
    () => new Response(bytes, { headers: { ...headers(), 'x-yur-export-scope': 'paid_delivery' } }),
    () => new Response(bytes, { headers: { ...headers(), 'content-length': String(bytes.length + 1) } }),
  ];
  for (const reply of replies) await assert.rejects(fetchPackSourceArchive({ base: 'http://127.0.0.1:8181', apiPath: '/api/packs/id/download', fetchImpl: async () => reply() }),
    error => !error.message.includes('PRIVATE_SERVER_DETAIL'));
});

test('binary transport cancels a stream that exceeds the budget without a length header', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const h = headers(); delete h['content-length'];
  await assert.rejects(fetchPackSourceArchive({ base: 'http://127.0.0.1:8181', apiPath: '/api/packs/id/download', fetchImpl: async () => new Response(stream, { headers: h }) }), /byte budget/);
  assert.equal(cancelled, true);
});

test('native export saves verified bytes exclusively at the chosen path and removes its temporary file', async t => {
  const f = await fixture(t);
  const result = await f.host.exportPack(payload, f.identity);
  assert.equal(result.ok, true); assert.equal(result.result.saved, true); assert.equal(result.result.scope, 'local_source_preview');
  assert.equal(result.result.path, f.target); assert.equal(result.result.content_sha256, contentDigest); assert.equal(result.result.archive_sha256, archiveDigest);
  assert.deepEqual(await fs.readFile(f.target), bytes); assert.deepEqual(await fs.readdir(f.folder), ['chosen.zip']);
  assert.equal(f.calls[0][1], '/api/packs/owned-pack-v1/download'); assert.equal(f.calls[1][0], 'picker');
});

test('changed content or archive digest and excessive bytes are rejected before the save picker', async t => {
  for (const alter of [item => { item.content_sha256 = 'd'.repeat(64); }, item => { item.archive_sha256 = 'a'.repeat(64); },
    item => { item.bytes = Buffer.alloc(MAX_PACK_EXPORT_BYTES + 1); }, item => { item.scope = 'delivery'; }]) {
    const item = binary(); alter(item.result);
    const f = await fixture(t, { requestBinary: async () => item });
    assert.equal((await f.host.exportPack(payload, f.identity)).ok, false); assert.equal(f.calls.length, 0);
    assert.deepEqual(await fs.readdir(f.folder), []);
  }
});

test('native export rejects model paths, foreign windows and secret transport errors without side effects', async t => {
  const f = await fixture(t);
  assert.equal((await f.host.exportPack({ ...payload, path: 'model-path.zip' }, f.identity)).ok, false);
  assert.equal((await f.host.exportPack(payload, { ...f.identity, owner: { isDestroyed: () => false } })).ok, false);
  assert.equal(f.calls.length, 0);
  const broken = await fixture(t, { requestBinary: async () => { throw new Error('Source export PRIVATE_BEARER_DETAIL'); } });
  const result = await broken.host.exportPack(payload, broken.identity);
  assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BEARER_DETAIL/);
});

test('cancelled picker writes nothing and revoked policy or ownership after picker prevents saving', async t => {
  const cancelled = await fixture(t, { dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  assert.deepEqual(await cancelled.host.exportPack(payload, cancelled.identity), { ok: true, result: { cancelled: true, saved: false } });
  assert.deepEqual(await fs.readdir(cancelled.folder), []);
  for (const stop of ['cancel', 'block', 'destroy']) {
    let f; f = await fixture(t, { dialog: { showSaveDialog: async () => { f[stop](); return { canceled: false, filePath: f.target }; } } });
    assert.equal((await f.host.exportPack(payload, f.identity)).ok, false); assert.deepEqual(await fs.readdir(f.folder), []);
  }
});

test('existing files and targets that appear just before publication are never overwritten', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'existing');
  const result = await f.host.exportPack(payload, f.identity); assert.equal(result.ok, false);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'existing'); assert.deepEqual(await fs.readdir(f.folder), ['chosen.zip']);
  let racing;
  racing = await fixture(t, { fs: { ...fs, link: async (temporary, target) => { await fs.writeFile(target, 'appeared'); return fs.link(temporary, target); } } });
  assert.equal((await racing.host.exportPack(payload, racing.identity)).ok, false);
  assert.equal(await fs.readFile(racing.target, 'utf8'), 'appeared'); assert.deepEqual(await fs.readdir(racing.folder), ['chosen.zip']);
});

test('linked save directories and changed directory identity are refused', async t => {
  const f = await fixture(t, { fs: { ...fs, lstat: async (name, options) => {
    const info = await fs.lstat(name, options);
    if (name === f.folder) return { ...info, isDirectory: () => true, isSymbolicLink: () => true };
    return info;
  } } });
  assert.equal((await f.host.exportPack(payload, f.identity)).ok, false); assert.deepEqual(await fs.readdir(f.folder), []);
  let reads = 0, changed; const optionsSeen = [], largeIdentity = 9007199254740992n;
  assert.equal(Number(largeIdentity), Number(largeIdentity + 1n), 'Fixture identities must collide when rounded to Number.');
  changed = await fixture(t, { fs: { ...fs, lstat: async (name, options) => {
    const info = await fs.lstat(name, options);
    if (name === changed.folder) {
      optionsSeen.push(options);
      const exactIdentity = largeIdentity + (++reads > 1 ? 1n : 0n);
      return { ...info, ino: options?.bigint ? exactIdentity : Number(exactIdentity), isDirectory: () => true, isSymbolicLink: () => false };
    }
    return info;
  } } });
  const result = await changed.host.exportPack(payload, changed.identity);
  assert.equal(result.ok, false); assert.match(result.error.message, /directory changed/);
  assert.equal(reads, 2); assert.ok(optionsSeen.every(options => options?.bigint === true));
  assert.deepEqual(await fs.readdir(changed.folder), []);
});

test('policy revocation after temporary preparation prevents publication and cleans owned scratch', async t => {
  let f;
  f = await fixture(t, { fs: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: (...a) => handle.writeFile(...a), sync: async () => { await handle.sync(); f.block(); }, stat: (...a) => handle.stat(...a), close: () => handle.close() };
  } } });
  const result = await f.host.exportPack(payload, f.identity);
  assert.equal(result.ok, false); assert.match(result.error.message, /disabled by current Desktop policy/); assert.deepEqual(await fs.readdir(f.folder), []);
});

test('dedicated sidecar binary API fails closed before startup and does not proxy arbitrary paths', async t => {
  const f = await fixture(t);
  let calls = 0;
  const sidecar = createHarnessSidecar({ unifiedRoot: f.folder, stateDir: path.join(f.folder, 'state'), fetchImpl: async () => { calls++; throw new Error('No network expected'); } });
  assert.equal((await sidecar.requestBinary('/api/orders/id/download')).error.code, 'HARNESS_PATH_DENIED');
  assert.equal((await sidecar.requestBinary('/api/packs/id/download')).error.code, 'HARNESS_NOT_READY');
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(f.folder), []);
});

test('sidecar binary export uses its existing local credentials once, returns no credentials, and never reprovisions a missing link', async t => {
  const f = await fixture(t);
  const environment = path.join(f.folder, 'marketplace', 'engine', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await fs.mkdir(environment, { recursive: true });
  await fs.writeFile(path.join(environment, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  const enginePackage = path.join(f.folder, 'marketplace', 'engine', 'yur_harness');
  await fs.mkdir(enginePackage);
  await fs.writeFile(path.join(enginePackage, '__main__.py'), '# Inert engine fixture\n');
  let downloads = 0;
  const spawnImpl = () => {
    const child = new EventEmitter(); child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => child.emit('exit', 0); return child;
  };
  const state = path.join(f.folder, 'state');
  const sidecar = createHarnessSidecar({ unifiedRoot: f.folder, stateDir: state, spawnImpl, environment: {},
    fetchImpl: async (url, init) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:/); assert.equal(init.redirect, 'error');
      if (url.endsWith('/api/health')) return { status: 200, text: async () => JSON.stringify({ ok: true, ready: true }) };
      if (url.endsWith('/api/auth/login')) return { status: 200, text: async () => JSON.stringify({ access_token: 'private-fixture-token' }) };
      assert.ok(url.endsWith('/api/packs/owned-pack-v1/download')); downloads++;
      assert.equal(init.headers.authorization, 'Bearer private-fixture-token'); assert.equal(typeof init.headers['x-karma-token'], 'string');
      return new Response(bytes, { headers: headers() });
    } });
  t.after(() => sidecar.stop());
  assert.equal((await sidecar.start()).state, 'ready');
  const result = await sidecar.requestBinary('/api/packs/owned-pack-v1/download');
  assert.equal(result.ok, true); assert.deepEqual(result.result.bytes, bytes);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-token|authorization|karma_token/);
  assert.equal(downloads, 1);
  await fs.unlink(path.join(state, 'link.json'));
  assert.equal((await sidecar.requestBinary('/api/packs/owned-pack-v1/download')).ok, false);
  await assert.rejects(fs.stat(path.join(state, 'link.json')), { code: 'ENOENT' }); assert.equal(downloads, 1);
});
