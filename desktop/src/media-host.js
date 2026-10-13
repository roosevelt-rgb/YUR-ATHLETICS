'use strict';

// Trusted presentation/export adapter. The existing CommitService owns media.
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const SCHEME = 'yur-media';
const MAX_BYTES = 128 * 1024 * 1024;
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']);
const fail = error => ({ ok: false, error: { code: 'MEDIA_HOST_FAILED', message: String(error?.message || error).slice(0, 1000) } });
function rangeFor(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid media range');
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('Unsatisfiable media range');
  return { start, end: Math.min(end, size - 1), partial: true };
}
function createMediaHost({ request, getRoot, dialog, getWindow, protocol, now = Date.now }) {
  const grants = new Map();
  const invoke = (action, payload = {}) => request({ command: 'media', action, payload }, 'media');
  async function checkedAsset(payload) {
    if (!payload || Object.keys(payload).join(',') !== 'asset_id' || !/^[a-f0-9]{64}$/.test(payload.asset_id)) throw new Error('Select a committed media asset.');
    const result = await invoke('asset', payload);
    if (!result.ok) throw new Error(result.error?.message || 'Media asset is unavailable.');
    const item = result.result;
    const folder = path.resolve(getRoot(), 'media-assets');
    if (item.id !== payload.asset_id || !MIME.has(item.mime) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_BYTES
      || path.dirname(path.resolve(item.path)) !== folder || path.basename(item.path) !== `${item.id}.${item.extension}`) throw new Error('Media asset did not match its committed record.');
    return item;
  }
  async function openChecked(item) {
    const stat = await fs.lstat(item.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) throw new Error('Media asset changed since validation.');
    const handle = await fs.open(item.path, 'r');
    try {
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(256 * 1024); let position = 0;
      while (position < item.bytes) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, item.bytes - position), position);
        if (!bytesRead) throw new Error('Media asset was truncated.');
        digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if ((await handle.stat()).size !== item.bytes || digest.digest('hex') !== item.id) throw new Error('Media asset bytes differ from their committed digest.');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  protocol.handle(SCHEME, async incoming => {
    let handle;
    try {
      const grant = grants.get(incoming.url);
      if (!grant || grant.expires < now() || !['GET', 'HEAD'].includes(incoming.method)) return new Response('', { status: 403 });
      const item = grant.item;
      let range;
      try { range = rangeFor(incoming.headers.get('range'), item.bytes); }
      catch { return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${item.bytes}` } }); }
      handle = await openChecked(item);
      const headers = { 'Content-Type': item.mime, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" };
      if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${item.bytes}`;
      if (incoming.method === 'HEAD') { await handle.close(); return new Response(null, { status: range.partial ? 206 : 200, headers }); }
      const stream = handle.createReadStream({ start: range.start, end: range.end, autoClose: true });
      handle = null;
      return new Response(Readable.toWeb(stream), { status: range.partial ? 206 : 200, headers });
    } catch { if (handle) await handle.close().catch(() => {}); return new Response('', { status: 410 }); }
  });
  const result = operation => async (...args) => { try { return await operation(...args); } catch (error) { return fail(error); } };
  return Object.freeze({
    invoke,
    asset: result(async payload => {
      const item = await checkedAsset(payload);
      for (const [url, grant] of grants) if (grant.expires < now()) grants.delete(url);
      while (grants.size >= 32) grants.delete(grants.keys().next().value);
      const url = `${SCHEME}://asset/${randomUUID()}/${item.id}.${item.extension}`;
      grants.set(url, { item, expires: now() + 60 * 60 * 1000 });
      const { path: _path, ...publicItem } = item;
      return { ok: true, result: { ...publicItem, url } };
    }),
    importImage: result(async () => {
      const selection = await dialog.showOpenDialog(getWindow(), { title: 'Choose an image for generation', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      if (selection.canceled || !selection.filePaths?.[0]) return { ok: true, result: { cancelled: true } };
      return invoke('import', { path: selection.filePaths[0] });
    }),
    exportAsset: result(async payload => {
      const item = await checkedAsset(payload);
      const selection = await dialog.showSaveDialog(getWindow(), { title: 'Save generated media', defaultPath: `yur-${item.id.slice(0, 12)}.${item.extension}`, filters: [{ name: 'Generated media', extensions: [item.extension] }] });
      if (selection.canceled || !selection.filePath) return { ok: true, result: { cancelled: true } };
      const source = await openChecked(item);
      try {
        // Native Save As authorizes this path; export copies verified committed bytes.
        await fs.writeFile(selection.filePath, await source.readFile());
      } finally { await source.close(); }
      return { ok: true, result: { asset_id: item.id, path: selection.filePath, bytes: item.bytes } };
    }),
    dispose() { grants.clear(); protocol.unhandle(SCHEME); },
  });
}
module.exports = { createMediaHost, rangeFor, SCHEME };
