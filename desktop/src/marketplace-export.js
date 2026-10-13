'use strict';

// Source-preview transport and native save adapter. The marketplace Commit
// Service owns export preparation; this host only verifies and copies its bytes.
const nativeFs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const MAX_PACK_EXPORT_BYTES = 18 * 1024 * 1024;
const PACK = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const DOWNLOAD = /^\/api\/packs\/[A-Za-z0-9._:-]{1,128}\/download$/;
const scope = 'local_source_preview';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = message => ({ ok: false, error: { code: 'PACK_SOURCE_EXPORT_FAILED', message } });
class ExportError extends Error {}

function isPackDownloadPath(value) {
  return typeof value === 'string' && DOWNLOAD.test(value) && !value.includes('..');
}

async function fetchPackSourceArchive({ fetchImpl, base, apiPath, headers }) {
  if (typeof fetchImpl !== 'function' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(base)
      || Number(new URL(base).port) > 65535 || !isPackDownloadPath(apiPath))
    throw new Error('A fixed local marketplace source-export endpoint is required.');
  const response = await fetchImpl(base + apiPath, { method: 'GET', headers,
    redirect: 'error', signal: AbortSignal.timeout(120000) });
  let reader;
  try {
    if (response.status !== 200 || response.redirected || (response.url && response.url !== base + apiPath))
      throw new Error('The local marketplace source export was rejected.');
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const exportScope = response.headers.get('x-yur-export-scope');
    const content = response.headers.get('x-yur-content-sha256'), archive = response.headers.get('x-yur-archive-sha256');
    const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
    if (type !== 'application/zip' || exportScope !== scope || !SHA.test(content || '') || !SHA.test(archive || '')
        || (encoding && encoding !== 'identity') || (length !== null && (!/^[0-9]+$/.test(length)
          || Number(length) < 1 || Number(length) > MAX_PACK_EXPORT_BYTES)))
      throw new Error('The local source export headers or byte budget are invalid.');
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('The source export has no bounded stream.');
    reader = response.body.getReader();
    const chunks = []; let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error('Invalid source export stream.');
      total += next.value.byteLength;
      if (total > MAX_PACK_EXPORT_BYTES) throw new Error('The source export exceeds its byte budget.');
      chunks.push(Buffer.from(next.value));
    }
    if (!total || (length !== null && total !== Number(length))) throw new Error('The source export length changed.');
    const bytes = Buffer.concat(chunks, total);
    if (hash(bytes) !== archive || bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
      throw new Error('The source archive does not match its declared digest or ZIP format.');
    return { bytes, scope: exportScope, content_sha256: content, archive_sha256: archive };
  } finally {
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    else { try { await response.body?.cancel(); } catch {} }
  }
}

function createMarketplaceExport({ requestBinary, dialog, getWindow, deny, getSettings, fs = nativeFs } = {}) {
  if (typeof requestBinary !== 'function' || typeof dialog?.showSaveDialog !== 'function'
      || typeof getWindow !== 'function' || typeof deny !== 'function' || typeof getSettings !== 'function')
    throw new ExportError('Source export requires the native transport, Save picker and current policy.');
  function check(payload, identity) {
    const window = getWindow();
    if (!identity || typeof identity.isActive !== 'function' || !identity.isActive() || !identity.owner
        || typeof identity.owner.isDestroyed !== 'function' || identity.owner.isDestroyed()
        || !window || window.isDestroyed() || window.webContents !== identity.owner)
      throw new ExportError('Source export is no longer owned by the active Franklin window.');
    const reason = deny('harness:request', ['GET', `/api/packs/${payload.pack_id}`], getSettings());
    if (reason) throw new ExportError('Source export is disabled by current Desktop policy.');
    return window;
  }
  function payloadCheck(payload) {
    if (!payload || Object.keys(payload).sort().join(',') !== 'expected_content_sha256,pack_id'
        || typeof payload.pack_id !== 'string' || !PACK.test(payload.pack_id) || payload.pack_id.includes('..')
        || typeof payload.expected_content_sha256 !== 'string' || !SHA.test(payload.expected_content_sha256))
      throw new ExportError('Choose an exact inspected pack and content digest; the human selects the save path.');
  }
  async function directorySnapshot(folder) {
    const result = [];
    for (let current = folder; ; current = path.dirname(current)) {
      // Windows file identities may exceed Number's exact-integer range.
      const info = await fs.lstat(current, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ExportError('Source export cannot traverse a linked save directory.');
      const real = await fs.realpath(current);
      const equal = process.platform === 'win32' ? real.toLowerCase() === current.toLowerCase() : real === current;
      if (!equal) throw new ExportError('Source export cannot traverse a redirected save directory.');
      result.push([current, String(info.dev), String(info.ino)]);
      if (path.dirname(current) === current) return result;
    }
  }
  async function availableTarget(target) {
    try { await fs.lstat(target); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new ExportError('Choose a new ZIP filename. Existing files are preserved.');
  }
  function selectedPath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f]/.test(value)
        || /^[/\\]{2}/.test(value) || path.extname(value).toLowerCase() !== '.zip')
      throw new ExportError('Choose a regular local ZIP destination.');
    const root = path.parse(value).root, parts = value.slice(root.length).split(/[\\/]/);
    if (!parts.length || parts.some(part => !part || ['.', '..'].includes(part) || /[:<>"|?*]/.test(part)
        || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))
      throw new ExportError('Choose a portable local ZIP destination.');
    return path.resolve(value);
  }
  async function exportPack(supplied, identity) {
    let temporary = null, handle = null;
    try {
      payloadCheck(supplied);
      const payload = { ...supplied }; check(payload, identity);
      const downloaded = await requestBinary(`/api/packs/${payload.pack_id}/download`);
      check(payload, identity);
      const item = downloaded?.result;
      if (downloaded?.ok !== true || !item || item.scope !== scope || item.content_sha256 !== payload.expected_content_sha256
          || !SHA.test(item.archive_sha256 || '') || !Buffer.isBuffer(item.bytes)
          || item.bytes.length < 4 || item.bytes.length > MAX_PACK_EXPORT_BYTES)
        throw new ExportError('Source export did not return the reviewed pack revision and a bounded ZIP archive.');
      const bytes = Buffer.from(item.bytes), archiveDigest = item.archive_sha256;
      if (hash(bytes) !== archiveDigest || bytes.readUInt32LE(0) !== 0x04034b50)
        throw new ExportError('Source archive bytes changed before saving.');
      const choice = await dialog.showSaveDialog(check(payload, identity), { title: 'Save pack source preview as a new ZIP',
        defaultPath: `yur-pack-${payload.expected_content_sha256.slice(0, 12)}-source-preview.zip`,
        filters: [{ name: 'Source preview ZIP', extensions: ['zip'] }] });
      check(payload, identity);
      if (choice.canceled || !choice.filePath) return { ok: true, result: { cancelled: true, saved: false } };
      const target = selectedPath(choice.filePath), parent = path.dirname(target);
      const directories = await directorySnapshot(parent); await availableTarget(target); check(payload, identity);
      temporary = path.join(parent, `.yur-source-export-${randomUUID()}.tmp`);
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync();
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.size !== BigInt(bytes.length)) throw new ExportError('The temporary source export did not retain every byte.');
      if (JSON.stringify(await directorySnapshot(parent)) !== JSON.stringify(directories))
        throw new ExportError('The chosen save directory changed during source export.');
      const current = await fs.lstat(temporary, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile() || current.dev !== info.dev || current.ino !== info.ino)
        throw new ExportError('The temporary source export changed before publication.');
      await availableTarget(target); check(payload, identity);
      // Exclusive hard-link publication makes a complete file visible atomically
      // and cannot overwrite a file or symlink created since the Save selection.
      await fs.link(temporary, target);
      return { ok: true, result: { saved: true, scope, pack_id: payload.pack_id, content_sha256: payload.expected_content_sha256,
        archive_sha256: archiveDigest, archive_bytes: bytes.length, path: target,
        source_preview_only: true, purchase_or_installation_verified: false } };
    } catch (error) {
      return failure(error instanceof ExportError ? error.message : 'Source export could not save verified bytes. Choose an available local folder and a new filename.');
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (temporary) await fs.unlink(temporary).catch(() => {});
    }
  }
  return Object.freeze({ exportPack });
}

module.exports = { createMarketplaceExport, fetchPackSourceArchive, isPackDownloadPath, MAX_PACK_EXPORT_BYTES };
