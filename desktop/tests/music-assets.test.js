'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createMusicAssets, MAX_BYTES } = require('../src/music-assets');
function fixture(options = {}) {
  const raw = Buffer.from('RIFF owned fixture bytes'), id = createHash('sha256').update(raw).digest('hex');
  let destroyed = false, handler, configuration = { endpoint: 'http://127.0.0.1:18080', token: 'host-secret-'.repeat(4) };
  const owner = { isDestroyed: () => destroyed }, window = { webContents: owner, isDestroyed: () => false }, calls = [];
  const host = createMusicAssets({ getConfiguration: () => configuration, getWindow: () => window,
    dialog: { showSaveDialog: async () => ({ canceled: true }) }, protocol: { handle: (_s, fn) => handler = fn, unhandle() {} },
    fetchImpl: async (url, request) => { calls.push({ url, request }); return new Response(raw, { headers: { 'content-type': 'audio/wav', 'content-length': String(raw.length) } }); }, ...options });
  return { host, id, raw, owner, calls, request: (url, headers = {}) => handler(new Request(url, { headers })), destroy: () => destroyed = true,
    change: () => configuration = { ...configuration, token: 'different-'.repeat(4) } };
}
test('verified local audio exposes only a private preview grant, with byte-range playback', async () => {
  const f = fixture(), result = await f.host.asset(f.owner, f.id);
  assert.equal(result.ok, true); assert.ok(result.result.url.startsWith('yur-music://asset/'));
  assert.equal(JSON.stringify(result).includes('host-secret'), false);
  assert.equal(f.calls[0].request.redirect, 'error');
  const response = await f.request(result.result.url, { range: 'bytes=0-3' });
  assert.equal(response.status, 206); assert.equal(await response.text(), 'RIFF');
  assert.equal((await f.request(result.result.url, { range: 'bytes=99999-' })).status, 416);
  f.change(); assert.equal((await f.request(result.result.url)).status, 410);
});
test('hash mismatch, redirects and advertised oversize never produce playback grants', async () => {
  const f = fixture(); assert.equal((await f.host.asset(f.owner, 'a'.repeat(64))).ok, false);
  const huge = fixture({ fetchImpl: async () => new Response('x', { headers: { 'content-type': 'audio/wav', 'content-length': String(MAX_BYTES + 1) } }) });
  assert.equal((await huge.host.asset(huge.owner, huge.id)).ok, false);
  const redirect = fixture({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.test' } }) });
  assert.equal((await redirect.host.asset(redirect.owner, redirect.id)).ok, false);
});
test('closed window revokes previews and cancellation writes no file', async () => {
  const f = fixture(), grant = await f.host.asset(f.owner, f.id);
  assert.equal((await f.host.save(f.owner, f.id)).result.cancelled, true);
  f.destroy(); assert.equal((await f.request(grant.result.url)).status, 410);
});
test('repeated native quit passes unregister audio once and revoke in-flight access', async () => {
  let unregisters = 0;
  const f = fixture({ protocol: { handle() {}, unhandle() { if (++unregisters > 1) throw new Error('Handler already removed'); } } });
  assert.equal((await f.host.asset(f.owner, f.id)).ok, true);
  f.host.dispose(); assert.doesNotThrow(() => f.host.dispose());
  assert.equal(unregisters, 1); assert.equal((await f.host.asset(f.owner, f.id)).ok, false);
});
test('native save copies verified bytes and preserves an existing destination', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'yur-music-save-')), target = path.join(folder, 'song.wav');
  const f = fixture({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) } });
  try {
    assert.equal((await f.host.save(f.owner, f.id)).result.saved, true); assert.deepEqual(await fs.readFile(target), f.raw);
    assert.equal((await f.host.save(f.owner, f.id)).ok, false); assert.deepEqual(await fs.readFile(target), f.raw);
  } finally { await fs.unlink(target).catch(() => {}); await fs.rmdir(folder); }
});
