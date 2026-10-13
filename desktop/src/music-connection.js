'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn: nodeSpawn } = require('node:child_process');

// Supervision only: the existing Music service retains its worker lock,
// orchestration and CommitService. No GPU engine or provider process is started.
const STARTUP = String.raw`
import json, os, runpy, sqlite3, sys
from pathlib import Path
root = Path(sys.argv[1])
nonce = sys.argv[2]
def emit(state):
    print(json.dumps({'music_connection_guard': state, 'nonce': nonce}), flush=True)
try:
    for item in (root, root/'state', root/'state'/'foundry.sqlite3'):
        for part in (item, *item.parents):
            if part.exists() and (part.is_symlink() or getattr(part, 'is_junction', lambda: False)()):
                raise ValueError('reparse')
        if item.resolve().drive.upper() != 'D:':
            raise ValueError('storage')
    db = root/'state'/'foundry.sqlite3'
    if db.exists():
        with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=1) as connection:
            connection.execute('PRAGMA query_only=ON')
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='music_documents'").fetchone():
                rows = connection.execute("SELECT document FROM music_documents WHERE kind='job'")
                count = 0
                for (raw,) in rows:
                    count += 1
                    if count > 10000 or not isinstance(raw, str) or len(raw.encode('utf-8')) > 65536:
                        raise ValueError('budget')
                    document = json.loads(raw)
                    state = document['data']['state']
                    if state in ('queued', 'running'):
                        emit('needs_review')
                        raise SystemExit(72)
                    if state not in ('completed', 'failed', 'cancelled', 'needs_review'):
                        raise ValueError('job state')
    emit('clear')
except SystemExit:
    raise
except Exception:
    emit('unavailable')
    raise SystemExit(73)
sys.argv = ['music.server', '--root', str(root), '--port', '0']
runpy.run_module('music.server', run_name='__main__')
`;

function localConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(value.endpoint)
      || typeof value.token !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(value.token)) return null;
  try {
    const url = new URL(value.endpoint);
    return url.port && Number(url.port) <= 65535 ? { endpoint: url.origin, token: value.token } : null;
  } catch { return null; }
}
function resolvedDirectory(value) {
  if (typeof value !== 'string' || !/^[dD]:[\\/]/.test(value) || /[\x00-\x1f\x7f]/.test(value)
      || value.length > 4096 || value.includes(':', 2)) throw new Error('Music requires an explicit local D: directory.');
  const resolved = path.resolve(value);
  if (path.parse(resolved).root.toLowerCase() !== 'd:\\') throw new Error('Music storage must remain on local D:.');
  return resolved;
}
function directory(value, mustExist = true) {
  const resolved = resolvedDirectory(value);
  for (let item = resolved; ; item = path.dirname(item)) {
    let stat; try { stat = fs.lstatSync(item); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Music directory could not be inspected.'); }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()
        || fs.realpathSync.native(item).toLowerCase() !== item.toLowerCase())) throw new Error('Music directories must not traverse reparse points.');
    if (item === path.dirname(item)) break;
  }
  if (mustExist && !fs.existsSync(resolved)) throw new Error('The configured Music source is unavailable.');
  return resolved;
}
function file(root, relative, maximum = 1024 * 1024) {
  const target = path.join(root, relative);
  directory(path.dirname(target));
  let stat; try { stat = fs.lstatSync(target); } catch { throw new Error('The configured Music source is incomplete.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum
      || fs.realpathSync.native(target).toLowerCase() !== target.toLowerCase()) throw new Error('Music source files must be bounded local files.');
  return target;
}
function configuredScope(getSourceRoot, getDataRoot, getPython, getFoundryRoot) {
  let sourceValue, selected, python, foundryValue;
  try { sourceValue = getSourceRoot(); selected = getDataRoot?.(); python = getPython(); foundryValue = getFoundryRoot(); }
  catch { throw new Error('Music host configuration could not be read.'); }
  const source = resolvedDirectory(sourceValue);
  const data = resolvedDirectory(selected || path.join(source, 'music', 'runtime'));
  if (typeof python !== 'string' || !python.trim() || python.length > 4096 || /[\x00-\x1f\x7f]/.test(python)) throw new Error('The host Python runtime is unavailable.');
  // An explicit host override must survive the child environment allowlist.
  // Without one, Music retains its existing runtime-binding.json selection.
  const foundryRoot = foundryValue ? resolvedDirectory(foundryValue) : null;
  return { source, data, python, foundryRoot, key: JSON.stringify([source.toLowerCase(), data.toLowerCase(), python, foundryRoot?.toLowerCase()]) };
}
function scope(getSourceRoot, getDataRoot, getPython, getFoundryRoot) {
  const selected = configuredScope(getSourceRoot, getDataRoot, getPython, getFoundryRoot);
  const { source, data } = selected;
  directory(source);
  let manifest; try { manifest = JSON.parse(fs.readFileSync(file(source, 'package.json', 32768), 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('The configured Music source requires its application manifest.'); }
  if (manifest?.name !== '@yur/music-studio') throw new Error('The configured source is not the existing Music application.');
  for (const relative of ['music/__init__.py', 'music/server.py', 'music/authority.py', 'music/contracts.py', 'music/runtime-binding.json']) file(source, relative);
  if (selected.foundryRoot) {
    directory(selected.foundryRoot);
    for (const relative of ['foundry/commit_service.py', 'foundry/orchestration.py']) file(selected.foundryRoot, relative);
  }
  directory(data, false);
  for (const relative of ['state', 'temp', 'cache', 'logs', 'downloads', 'models', 'exports']) directory(path.join(data, relative), false);
  for (const relative of ['foundry.sqlite3', 'foundry.sqlite3-wal', 'foundry.sqlite3-shm']) {
    const target = path.join(data, 'state', relative);
    if (fs.existsSync(target)) file(data, path.join('state', relative), Number.MAX_SAFE_INTEGER);
  }
  return selected;
}

function createMusicConnection({ getSourceRoot, getDataRoot, getPython, getExternalConfiguration = () => null,
  getFoundryRoot = () => process.env.YUR_FOUNDRY_ROOT,
  spawn = nodeSpawn, timeoutMs = 15000, stopTimeoutMs = 2000 } = {}) {
  if (![getSourceRoot, getPython, getExternalConfiguration, getFoundryRoot, spawn].every(value => typeof value === 'function')
      || getDataRoot !== undefined && typeof getDataRoot !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 5000) throw new Error('Music connection requires trusted host bindings.');
  let active = null, phase = 'stopped', notice = 'Music is not connected.';
  function external() { try { return localConfiguration(getExternalConfiguration()); } catch { return null; } }
  function settle(record, error) {
    clearTimeout(record.timer); record.signal?.removeEventListener('abort', record.abort);
    if (record.settled) return;
    record.settled = true;
    if (error) record.reject(new Error(error));
    else {
      const current = status();
      if (current.connected && record.configuration) record.resolve(current);
      else record.reject(new Error('Music connection scope changed during startup.'));
    }
  }
  function close(record) {
    if (record.closed) return;
    record.closed = true; record.configuration = null;
    clearTimeout(record.killTimer); clearTimeout(record.stopTimer);
    if (active === record) {
      active = null;
      if (phase === 'stopping') { phase = 'stopped'; notice = 'The owned Music process stopped.'; }
      else if (phase === 'starting' || phase === 'connected') { phase = 'failed'; notice = 'The owned Music process exited. Inspect the existing service before starting again.'; }
    }
    settle(record, notice); record.stoppedResolve?.();
  }
  function terminate(record, nextPhase, message) {
    if (!record || record.closed) return Promise.resolve();
    record.configuration = null;
    if (active === record) { phase = nextPhase; notice = message; }
    settle(record, message);
    if (record.stopped) return record.stopped;
    record.stopped = new Promise(resolve => { record.stoppedResolve = resolve; });
    record.killTimer = setTimeout(() => { if (!record.closed) { try { record.child.kill('SIGKILL'); } catch {} } }, stopTimeoutMs);
    record.stopTimer = setTimeout(() => {
      if (record.closed) return;
      if (active === record) { phase = 'failed'; notice = 'Music stop is unconfirmed; the owned process will not be replaced automatically.'; }
      record.stoppedResolve();
    }, stopTimeoutMs * 2);
    try { record.child.kill(); } catch {}
    return record.stopped;
  }
  function reconcile() {
    if (!active || active.closed || !['starting', 'connected'].includes(phase)) return;
    let unchanged = false;
    // Streaming clients consult configuration for every chunk. The live process
    // keeps its already-admitted endpoint; compare host choices without filesystem
    // traversal here. Full source/storage attestation happens at start/readiness.
    try { unchanged = configuredScope(getSourceRoot, getDataRoot, getPython, getFoundryRoot).key === active.scope.key && !external(); } catch {}
    if (!unchanged) void terminate(active, 'failed', 'Music connection scope changed. Review its configuration before starting again.');
  }
  function configuration() {
    reconcile();
    const configured = external();
    if (configured) return configured;
    return phase === 'connected' && active?.configuration ? { ...active.configuration } : null;
  }
  function status() {
    const configured = configuration(), outside = external();
    return { status: outside ? 'external' : phase, connected: Boolean(configured), owned: Boolean(active && !active.closed),
      endpoint: configured?.endpoint || null, notice: outside ? 'An existing externally configured Music connection is selected; Desktop does not own its process.' : notice };
  }
  function start({ signal } = {}) {
    const existing = external();
    if (existing) { reconcile(); return Promise.resolve(status()); }
    reconcile();
    if (active) return phase === 'starting' ? active.promise : phase === 'connected' ? Promise.resolve(status())
      : Promise.reject(new Error('The prior owned Music process has not exited; inspect its status before restarting.'));
    if (signal?.aborted) return Promise.reject(new Error('Music connection start was cancelled.'));
    let selected; try { selected = scope(getSourceRoot, getDataRoot, getPython, getFoundryRoot); }
    catch (error) { phase = 'failed'; notice = error.message; return Promise.reject(new Error(notice)); }
    const token = randomBytes(32).toString('base64url'), nonce = randomBytes(16).toString('hex');
    const allowed = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'YUR_MUSIC_ELEVEN_API_KEY', 'YUR_MUSIC_SUNO_API_KEY', 'YUR_MUSIC_SUNO_CALLBACK_URL', 'YUR_MUSIC_SUNO_MODEL', 'YUR_MUSIC_COMFY_URL'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.includes(key.toUpperCase())));
    Object.assign(env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1',
      ...(selected.foundryRoot ? { YUR_FOUNDRY_ROOT: selected.foundryRoot } : {}),
      YUR_MUSIC_CONVERSION_TEMP: path.join(selected.data, 'temp'),
      YUR_MUSIC_ACCESS_TOKENS: JSON.stringify({ [token]: { tenant: 'local', user: 'operator', role: 'owner' } }) });
    const record = { scope: selected, configuration: null, guard: false, settled: false, closed: false,
      stdout: '', stdoutBytes: 0, stderrBytes: 0, signal };
    record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    active = record; phase = 'starting'; notice = 'Checking prior jobs and starting the existing lightweight Music service.';
    try {
      record.child = spawn(selected.python, ['-B', '-c', STARTUP, selected.data, nonce],
        { cwd: selected.source, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      record.child.once('close', () => close(record));
      record.child.once('error', () => {
        if (active === record) { phase = 'failed'; notice = 'The host Python runtime could not start Music.'; }
        if (!record.child.pid) close(record); else void terminate(record, 'failed', notice);
      });
      record.child.stdout.setEncoding('utf8');
      record.child.stdout.on('data', chunk => {
        if (record.closed || !['starting', 'connected'].includes(phase) || active !== record) return;
        record.stdoutBytes += Buffer.byteLength(chunk);
        record.stdout += chunk;
        if (record.stdoutBytes > 65536 || record.stdout.length > 16384) { void terminate(record, 'failed', 'Music startup output exceeded its bounded contract.'); return; }
        let newline;
        while ((newline = record.stdout.indexOf('\n')) !== -1) {
          const line = record.stdout.slice(0, newline).trim(); record.stdout = record.stdout.slice(newline + 1);
          if (!line) continue;
          let message; try { message = JSON.parse(line); } catch { void terminate(record, 'failed', 'Music startup returned an invalid readiness message.'); return; }
          if (message?.music_connection_guard && message.nonce === nonce && !record.guard) {
            if (message.music_connection_guard === 'clear') { record.guard = true; continue; }
            const pending = message.music_connection_guard === 'needs_review';
            void terminate(record, pending ? 'needs_review' : 'failed', pending
              ? 'Existing queued or running Music jobs need review before Desktop may start the service. No old work was launched.'
              : 'The read-only Music job check could not be completed. The service was not started.'); return;
          }
          let announced = localConfiguration({ endpoint: message?.url, token });
          try {
            if (!record.guard || phase !== 'starting' || message?.status !== 'listening' || !announced
                || typeof message.storage !== 'string' || directory(message.storage, false).toLowerCase() !== selected.data.toLowerCase()
                || scope(getSourceRoot, getDataRoot, getPython, getFoundryRoot).key !== selected.key || external()) throw new Error();
          } catch { void terminate(record, 'failed', 'Music readiness did not match its owned process and reviewed storage.'); return; }
          record.configuration = announced; phase = 'connected'; notice = 'The owned Music server is listening. Provider health and job outcomes require their own checks.';
          settle(record);
        }
      });
      record.child.stderr.on('data', chunk => {
        record.stderrBytes += Buffer.byteLength(chunk);
        if (record.stderrBytes > 65536) void terminate(record, 'failed', 'Music diagnostics exceeded their bounded contract.');
      });
      record.timer = setTimeout(() => void terminate(record, 'failed', 'Music did not become ready before its startup deadline.'), timeoutMs);
      record.abort = () => void terminate(record, 'stopping', 'Music connection start was cancelled.');
      signal?.addEventListener('abort', record.abort, { once: true });
      if (signal?.aborted) record.abort();
    } catch {
      phase = 'failed'; notice = 'The configured Music process could not be started.';
      if (record.child) void terminate(record, 'failed', notice); else close(record);
    }
    return record.promise;
  }
  async function stop() {
    if (active) await terminate(active, 'stopping', 'Stopping only the Music process started by Desktop.');
    return status();
  }
  return { start, status, configuration, stop };
}
module.exports = { createMusicConnection };
