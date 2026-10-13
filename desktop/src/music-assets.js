'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { rangeFor } = require('./media-host');
const MAX_BYTES = 128 * 1024 * 1024;
const TYPES = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'application/zip': 'zip' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Only committed, content-addressed bytes from the already-bound Music owner.
// Service credentials remain in this process, never in an audio URL.
function createMusicAssets({ getConfiguration, getWindow, dialog, protocol, fetchImpl = fetch }) {
  const grants = new Map();
  let disposed = false;
  function scope(owner) {
    if (disposed || !owner || owner.isDestroyed() || !getWindow() || getWindow().isDestroyed() || getWindow().webContents !== owner)
      throw new Error('The Music window is unavailable.');
    const config = getConfiguration();
    if (!config || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(config.endpoint || '') || Number(new URL(config.endpoint).port) > 65535
        || !/^[\x21-\x7e]{32,4096}$/.test(config.token || '')) throw new Error('Connect the Music service first.');
    return { ...config };
  }
  function unchanged(owner, config) {
    const now = scope(owner);
    if (now.endpoint !== config.endpoint || now.token !== config.token) throw new Error('Music connection changed. Select the asset again.');
  }
  async function download(owner, id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Select a committed Music asset.');
    const config = scope(owner);
    const response = await fetchImpl(config.endpoint + '/api/assets/' + id, { headers: { Authorization: 'Bearer ' + config.token },
      redirect: 'error', signal: AbortSignal.timeout(30000) });
    let reader;
    try {
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const length = response.headers.get('content-length');
      if (response.status !== 200 || response.redirected || !(type in TYPES) || length && (!/^\d+$/.test(length) || +length > MAX_BYTES))
        throw new Error('The Music asset did not return an admitted type and byte budget.');
      reader = response.body.getReader(); const chunks = []; let bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > MAX_BYTES) throw new Error('The Music asset exceeds the playback/export limit.');
        unchanged(owner, config); chunks.push(Buffer.from(next.value));
      }
      const raw = Buffer.concat(chunks, bytes);
      if (!bytes || length && +length !== bytes || digest(raw) !== id) throw new Error('Music asset integrity check failed.');
      unchanged(owner, config);
      return { raw, mime: type, extension: TYPES[type], id, config };
    } finally { if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } else await response.body?.cancel().catch(() => {}); }
  }
  protocol.handle('yur-music', async incoming => {
    const grant = grants.get(incoming.url);
    try {
      if (!grant || grant.expires < Date.now() || !['GET', 'HEAD'].includes(incoming.method)) return new Response('', { status: 410 });
      unchanged(grant.owner, grant.item.config);
      const item = grant.item; let range;
      try { range = rangeFor(incoming.headers.get('range'), item.raw.length); }
      catch { return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${item.raw.length}` } }); }
      const headers = { 'Content-Type': item.mime, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${item.raw.length}`;
      return new Response(incoming.method === 'HEAD' ? null : item.raw.subarray(range.start, range.end + 1), { status: range.partial ? 206 : 200, headers });
    } catch { return new Response('', { status: 410 }); }
  });
  const result = fn => async (...args) => { try { return { ok: true, result: await fn(...args) }; }
    catch { return { ok: false, error: { code: 'MUSIC_ASSET_FAILED', message: 'Music playback or save failed. Check the connection, asset integrity and selected new filename.' } }; } };
  async function regularDirectory(folder) {
    for (let current = folder; ; current = path.dirname(current)) {
      const metadata = await fs.lstat(current), real = await fs.realpath(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || path.resolve(real).toLowerCase() !== path.resolve(current).toLowerCase()) throw new Error('Choose an ordinary local directory.');
      if (path.dirname(current) === current) break;
    }
  }
  return {
    asset: result(async (owner, id) => {
      const item = await download(owner, id);
      if (!item.mime.startsWith('audio/')) throw new Error('Select audio for playback.');
      // One retained track bounds memory. Selecting another track revokes the old grant.
      grants.clear(); const url = `yur-music://asset/${randomUUID()}/${id}.${item.extension}`;
      grants.set(url, { owner, item, expires: Date.now() + 60 * 60 * 1000 });
      return { url, asset_id: id, mime: item.mime, bytes: item.raw.length };
    }),
    save: result(async (owner, id) => {
      const item = await download(owner, id);
      const choice = await dialog.showSaveDialog(getWindow(), { title: 'Save Music as a new file',
        defaultPath: `yur-music-${id.slice(0, 12)}.${item.extension}`, filters: [{ name: 'Music asset', extensions: [item.extension] }] });
      unchanged(owner, item.config);
      if (choice.canceled || !choice.filePath) return { cancelled: true };
      const target = choice.filePath;
      if (typeof target !== 'string' || target.length > 4096 || !path.isAbsolute(target) || /^[/\\]{2}/.test(target)
          || target.slice(path.parse(target).root.length).includes(':') || /[\x00-\x1f]/.test(target) || path.extname(target).toLowerCase() !== '.' + item.extension)
        throw new Error('Choose a local file of the selected type.');
      await regularDirectory(path.dirname(target)); unchanged(owner, item.config);
      // Exclusive open preserves any existing file, including symbolic links.
      const handle = await fs.open(target, 'wx', 0o600);
      try { await handle.writeFile(item.raw); await handle.sync(); }
      finally { await handle.close(); }
      return { saved: true, asset_id: id, path: target, bytes: item.raw.length };
    }),
    dispose() { if (disposed) return; disposed = true; grants.clear(); protocol.unhandle('yur-music'); },
  };
}
module.exports = { createMusicAssets, MAX_BYTES };
