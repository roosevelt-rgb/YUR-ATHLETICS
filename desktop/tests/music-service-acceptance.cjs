'use strict';
// Explicitly invoked read-only acceptance against an existing Music library.
// No POST, provider generation, retry/resume, GPU launch, or user-window access.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createMusicConnection } = require('../src/music-connection');
const { createMusicAssets } = require('../src/music-assets');
const desktop = path.resolve(__dirname, '..');
const maximumAudio = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--source', '--data'].includes(key) || !value || value.startsWith('--') || key in options) throw new Error('Use --source with optional --data only.');
  options[key] = value;
}
if (!options['--source']) throw new Error('An explicit existing Music --source is required.');
const source = path.resolve(options['--source']);
const sourceFiles = ['src/music-connection.js', 'src/music-assets.js', 'tests/music-service-acceptance.cjs'];
const canonicalFiles = ['package.json', 'music/server.py', 'music/authority.py', 'music/contracts.py', 'music/runtime-binding.json'];
function sourceHashes() {
  return Object.fromEntries([...sourceFiles.map(name => [name, path.join(desktop, name)]),
    ...canonicalFiles.map(name => ['music-source/' + name, path.join(source, name)])]
    .map(([name, file]) => [name, hash(fs.readFileSync(file))]));
}
const evidenceRoot = path.resolve(desktop, '../../evidence/glider-rc6/comprehensive/franklin-mission-execution-2026-10-05/music-service');
const receipt = { schema: 'yur.music-library-acceptance.v1', status: 'running', checked_at: new Date().toISOString(),
  checks: [], requests: [], providers: [], variants: [], started_processes: [],
  evidence_limit: 'Existing library read and authenticated asset playback integration only. No fresh song generation, vocals, provider billing, GPU model launch, or external publication was attempted.' };
let connection, assets, currentCheck = 'source-attestation', ownedChild = null;
const handlers = new Map();
async function readBounded(response, maximum) {
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength; if (size > maximum) throw new Error('Read exceeded its acceptance byte bound.');
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, size);
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
async function get(route) {
  if (!/^\/api\/(?:state|catalog\?kind=(?:variant|job)&limit=50&offset=0)$/.test(route)) throw new Error('Read-only acceptance route not admitted.');
  const config = connection.configuration(); assert.ok(config);
  receipt.requests.push({ method: 'GET', route });
  const response = await fetch(config.endpoint + route, { method: 'GET', redirect: 'error',
    signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + config.token } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^application\/json/);
  return JSON.parse((await readBounded(response, 1024 * 1024)).toString('utf8'));
}
async function boundedAssetFetch(url, init) {
  const config = connection.configuration();
  assert.ok(config && url.startsWith(config.endpoint + '/api/assets/'));
  assert.match(url.slice((config.endpoint + '/api/assets/').length), /^[a-f0-9]{64}$/);
  assert.equal(init.method || 'GET', 'GET');
  receipt.requests.push({ method: 'GET', route: new URL(url).pathname });
  const response = await fetch(url, init);
  const bytes = await readBounded(response, maximumAudio);
  return new Response(bytes, { status: response.status, headers: response.headers });
}
async function run() {
  try {
    receipt.source_before = sourceHashes();
    const python = path.join(desktop, '.desktop-python', 'Scripts', 'python.exe');
    assert.ok(fs.statSync(python).isFile());
    connection = createMusicConnection({ getSourceRoot: () => source,
      getDataRoot: () => options['--data'], getPython: () => python, getExternalConfiguration: () => null,
      spawn: (command, args, settings) => {
        assert.equal(command, python); assert.deepEqual(args.slice(0, 2), ['-B', '-c']);
        assert.equal(settings.cwd, source); assert.equal(settings.windowsHide, true); assert.equal(settings.shell, false);
        ownedChild = spawn(command, args, settings);
        receipt.started_processes.push({ role: 'existing-music-server', pid: ownedChild.pid || null,
          executable_name: path.basename(command), gpu_or_model_process: false });
        return ownedChild;
      } });
    currentCheck = 'guarded-service-start';
    try { receipt.connection_started = await connection.start(); }
    catch {
      const status = connection.status();
      if (status.status === 'needs_review') { receipt.status = 'blocked'; receipt.blocked_reason = 'Existing queued or running jobs require review; the service was not started.'; return; }
      throw new Error('The existing Music connection did not start.');
    }
    assert.equal(receipt.connection_started.owned, true); assert.equal(receipt.connection_started.connected, true);
    receipt.checks.push('queued/running startup guard admitted existing source and storage; owned loopback listener established');
    currentCheck = 'service-state';
    const state = await get('/api/state');
    assert.equal(state.worker_alive, true); assert.ok(Array.isArray(state.providers));
    receipt.worker_alive = state.worker_alive;
    receipt.integrity_ok = state.integrity?.ok === true;
    receipt.providers = state.providers.map(provider => {
      assert.match(provider.id, /^[A-Za-z0-9._:-]{1,100}$/);
      return { id: provider.id, configured: provider.configured === true, external: provider.external === true };
    });
    receipt.checks.push('authenticated existing service state and worker liveness read');
    currentCheck = 'library-catalog';
    const variants = await get('/api/catalog?kind=variant&limit=50&offset=0');
    const jobs = await get('/api/catalog?kind=job&limit=50&offset=0');
    assert.ok(Array.isArray(variants) && variants.length <= 50); assert.ok(Array.isArray(jobs) && jobs.length <= 50);
    receipt.job_states = {};
    for (const job of jobs) {
      assert.ok(['completed', 'failed', 'cancelled', 'needs_review'].includes(job.data?.state));
      receipt.job_states[job.data.state] = (receipt.job_states[job.data.state] || 0) + 1;
    }
    receipt.variants = variants.map(variant => {
      assert.equal(variant.kind, 'variant'); assert.match(variant.id, /^[a-f0-9]{32}(?:[a-f0-9]{32})?$/);
      assert.match(variant.data.audio, /^[a-f0-9]{64}$/);
      // Historical immutable variants predate the optional MIME metadata. The
      // authenticated blob owner and integrity check determine the actual type.
      if (variant.data.mime !== undefined) assert.ok(['audio/wav', 'audio/mpeg'].includes(variant.data.mime));
      return { variant_id: variant.id, asset_sha256: variant.data.audio, catalog_mime: variant.data.mime || null };
    });
    assert.ok(receipt.variants.length > 0, 'Existing committed audio is required for playback acceptance.');
    receipt.checks.push('existing variant catalog and non-running job state read without lyrics in evidence');
    currentCheck = 'committed-audio-playback';
    const owner = { isDestroyed: () => false }, window = { isDestroyed: () => false, webContents: owner };
    assets = createMusicAssets({ getConfiguration: () => connection.configuration(), getWindow: () => window,
      dialog: { showSaveDialog() { throw new Error('No file export is admitted in this acceptance.'); } },
      protocol: { handle: (name, callback) => handlers.set(name, callback), unhandle: name => handlers.delete(name) },
      fetchImpl: boundedAssetFetch });
    const selected = receipt.variants[0], asset = await assets.asset(owner, selected.asset_sha256);
    assert.equal(asset.ok, true); assert.ok(asset.result.bytes > 0 && asset.result.bytes <= maximumAudio);
    assert.ok(asset.result.url.startsWith('yur-music://asset/'));
    const play = handlers.get('yur-music');
    const full = await play(new Request(asset.result.url)); assert.equal(full.status, 200);
    const bytes = await readBounded(full, maximumAudio); assert.equal(hash(bytes), selected.asset_sha256);
    assert.equal(full.headers.get('content-type'), asset.result.mime);
    if (selected.catalog_mime) assert.equal(asset.result.mime, selected.catalog_mime);
    const head = await play(new Request(asset.result.url, { method: 'HEAD' })); assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await play(new Request(asset.result.url, { headers: { Range: 'bytes=0-31' } })); assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 32));
    receipt.playback = { ...selected, mime: asset.result.mime, bytes: bytes.length, sha256_verified: true, full_status: full.status, head_status: head.status,
      range_status: range.status, range_bytes: 32, route: 'parent MusicAssets private protocol', audible_playback: false };
    receipt.checks.push('existing committed audio SHA256 verified through actual authenticated download and MusicAssets full/HEAD/range playback');
    currentCheck = 'owned-process-stop';
    const stopped = await connection.stop(); assert.equal(stopped.connected, false); assert.equal(stopped.owned, false);
    assert.notEqual(ownedChild.exitCode === null && ownedChild.signalCode === null, true);
    receipt.connection_stopped = stopped;
    receipt.owned_process_exit = { exit_code: ownedChild.exitCode, signal: ownedChild.signalCode };
    assert.equal((await play(new Request(asset.result.url))).status, 410);
    receipt.checks.push('owned process exit confirmed and prior playback grant invalidated');
    receipt.status = 'passed';
  } catch {
    receipt.status = 'failed'; receipt.failed_check = currentCheck;
    receipt.error = 'Music library acceptance failed at the named check; raw service bodies, credentials and lyrics are withheld.';
  } finally {
    assets?.dispose();
    if (connection) {
      const stopped = await connection.stop(); receipt.final_connection = stopped;
      if (stopped.owned || stopped.connected) { receipt.status = 'failed'; receipt.cleanup_unconfirmed = true; }
    }
    try { receipt.source_after = sourceHashes(); assert.deepEqual(receipt.source_before, receipt.source_after); }
    catch { receipt.status = 'failed'; receipt.source_changed_or_unavailable = true; }
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const evidence = path.join(evidenceRoot, 'music-service-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(evidence, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks.length, failed_check: receipt.failed_check,
      providers: receipt.providers, variants: receipt.variants.length, playback: receipt.playback, final_connection: receipt.final_connection, evidence }));
    process.exitCode = receipt.status === 'passed' ? 0 : receipt.status === 'blocked' ? 2 : 1;
  }
}
void run();
