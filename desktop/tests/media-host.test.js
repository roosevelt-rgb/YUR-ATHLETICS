'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createMediaHost, rangeFor } = require('../src/media-host');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yur-media-host-'));
  const raw = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const id = createHash('sha256').update(raw).digest('hex');
  const folder = path.join(root, 'media-assets'); await fs.mkdir(folder);
  const item = { id, path: path.join(folder, id + '.mp4'), bytes: raw.length, mime: 'video/mp4', extension: 'mp4' };
  await fs.writeFile(item.path, raw);
  let now = 100, route, calls = [], record = item, selection = { canceled: true }, stopped = false;
  const dialog = { showOpenDialog: async () => selection, showSaveDialog: async () => selection };
  const host = createMediaHost({
    request: async req => { calls.push(req); return req.action === 'asset' ? { ok: true, result: record } : { ok: true, result: { imported: true, path: req.payload.path } }; },
    getRoot: () => root, getWindow: () => null, dialog,
    protocol: { handle: (scheme, handler) => { assert.equal(scheme, 'yur-media'); route = handler; }, unhandle: () => { stopped = true; } }, now: () => now,
  });
  t.after(async () => { host.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { host, root, item, raw, calls, route: req => route(req), record: value => { record = value; }, selection: value => { selection = value; }, advance: ms => { now += ms; }, stopped: () => stopped };
}

test('media host provides only committed hash-bound preview grants and exact GET/HEAD/range bytes', async t => {
  const f = await fixture(t);
  const response = await f.host.asset({ asset_id: f.item.id });
  assert.equal(response.ok, true); assert.equal(Object.hasOwn(response.result, 'path'), false);
  const url = response.result.url; assert.match(url, /^yur-media:\/\/asset\//);
  const full = await f.route(new Request(url)); assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.raw);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  const head = await f.route(new Request(url, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(f.raw.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const partial = await f.route(new Request(url, { headers: { Range: 'bytes=3-8' } }));
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 3-8/${f.raw.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), f.raw.subarray(3, 9));
  const suffix = await f.route(new Request(url, { headers: { Range: 'bytes=-5' } }));
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), f.raw.subarray(-5));
  const invalid = await f.route(new Request(url, { headers: { Range: 'bytes=999-' } }));
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${f.raw.length}`);
});

test('media host rejects unknown, expired, wrong-method and tampered-byte preview requests', async t => {
  const f = await fixture(t); const { result } = await f.host.asset({ asset_id: f.item.id });
  assert.equal((await f.route(new Request(result.url + '?other=1'))).status, 403);
  assert.equal((await f.route(new Request(result.url, { method: 'POST' }))).status, 403);
  await fs.writeFile(f.item.path, Buffer.alloc(f.raw.length, 1));
  assert.equal((await f.route(new Request(result.url))).status, 410);
  await fs.writeFile(f.item.path, f.raw); f.advance(3600001);
  assert.equal((await f.route(new Request(result.url))).status, 403);
});

test('media host refuses arbitrary IDs, paths, extensions and changed metadata', async t => {
  const f = await fixture(t);
  assert.equal((await f.host.asset({ asset_id: '../secret' })).ok, false);
  assert.equal((await f.host.asset({ asset_id: f.item.id, path: 'other' })).ok, false);
  assert.equal(f.calls.length, 0);
  f.record({ ...f.item, path: path.join(f.root, 'outside.mp4') });
  assert.equal((await f.host.asset({ asset_id: f.item.id })).ok, false);
  f.record({ ...f.item, id: 'b'.repeat(64) });
  assert.equal((await f.host.asset({ asset_id: f.item.id })).ok, false);
  f.record({ ...f.item, mime: 'text/html' });
  assert.equal((await f.host.asset({ asset_id: f.item.id })).ok, false);
});

test('native import cancellation performs no read; selection supplies only the native chosen path', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.host.importImage(), { ok: true, result: { cancelled: true } });
  assert.equal(f.calls.length, 0);
  f.selection({ canceled: false, filePaths: [path.join(f.root, 'chosen.png')] });
  assert.equal((await f.host.importImage({ path: '/ignored-renderer-choice' })).ok, true);
  assert.deepEqual(f.calls[0], { command: 'media', action: 'import', payload: { path: path.join(f.root, 'chosen.png') } });
});

test('native Save As writes exact verified bytes and returns matching export metadata', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.host.exportAsset({ asset_id: f.item.id }), { ok: true, result: { cancelled: true } });
  const destination = path.join(f.root, 'saved.mp4'); f.selection({ canceled: false, filePath: destination });
  const exported = await f.host.exportAsset({ asset_id: f.item.id });
  assert.equal(exported.ok, true); assert.deepEqual(await fs.readFile(destination), f.raw);
  assert.deepEqual(exported.result, { asset_id: f.item.id, path: destination, bytes: f.raw.length });
  await fs.writeFile(f.item.path, Buffer.alloc(f.raw.length, 0));
  await fs.unlink(destination);
  assert.equal((await f.host.exportAsset({ asset_id: f.item.id })).ok, false);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('range parsing accepts bounded forms and rejects malformed/multiple/zero suffix ranges', () => {
  assert.deepEqual(rangeFor('bytes=10-', 30), { start: 10, end: 29, partial: true });
  assert.deepEqual(rangeFor('bytes=10-99', 30), { start: 10, end: 29, partial: true });
  for (const invalid of ['bytes=3-2', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=abc-def', 'bytes=-', 'items=0-1']) assert.throws(() => rangeFor(invalid, 30));
});
