'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createMusicConnection } = require('../src/music-connection');

const root = path.resolve(__dirname, '..');
const windowsD = process.platform === 'win32' && path.parse(root).root.toLowerCase() === 'd:\\';
const scopedTest = (name, fn) => test(name, { skip: !windowsD && 'Music requires the Windows local D: storage contract' }, fn);
const endpoint = 'http://127.0.0.1:45678';
let sequence = 1000;
class Child extends EventEmitter {
  constructor() { super(); this.pid = ++sequence; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.kills = []; this.autoClose = true; }
  kill(signal = 'SIGTERM') { this.kills.push(signal); if (this.autoClose) process.nextTick(() => this.emit('close', 0)); return true; }
}
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(root, '.music-connection-test-'));
  const source = path.join(directory, 'source'); fs.mkdirSync(path.join(source, 'music'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: '@yur/music-studio', version: 'fixture' }));
  for (const name of ['__init__.py', 'server.py', 'authority.py', 'contracts.py']) fs.writeFileSync(path.join(source, 'music', name), '');
  fs.writeFileSync(path.join(source, 'music', 'runtime-binding.json'), '{}');
  const state = { source, data: null, external: null, foundryRoot: null, children: [], calls: [] };
  const connection = createMusicConnection({ getSourceRoot: () => state.source, getDataRoot: () => state.data,
    getPython: () => 'python', getExternalConfiguration: () => state.external, getFoundryRoot: () => state.foundryRoot, timeoutMs: 200, stopTimeoutMs: 10,
    spawn: (...args) => { const child = new Child(); state.calls.push(args); state.children.push(child); return child; }, ...overrides });
  t.after(async () => {
    for (const child of state.children) { child.autoClose = true; child.emit('close', 0); }
    await connection.stop();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(root + path.sep + '.music-connection-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const announce = (message, index = state.children.length - 1) => state.children[index].stdout.write(JSON.stringify(message) + '\n');
  function guard(kind = 'clear', index = state.children.length - 1) {
    announce({ music_connection_guard: kind, nonce: state.calls[index][1][4] }, index);
  }
  function ready(extra = {}, index = state.children.length - 1) {
    guard('clear', index); announce({ status: 'listening', url: endpoint, storage: state.calls[index][1][3], ...extra }, index);
  }
  return { connection, state, directory, source, announce, guard, ready };
}

scopedTest('owned startup uses existing server, read-only guard and fresh local owner token; public state has no secret', async t => {
  const f = fixture(t), starting = f.connection.start();
  assert.equal(f.connection.status().status, 'starting'); assert.equal(f.connection.configuration(), null);
  assert.equal(f.connection.start(), starting); assert.equal(f.state.calls.length, 1);
  const [python, args, options] = f.state.calls[0];
  assert.equal(python, 'python'); assert.equal(args[0], '-B'); assert.equal(args[1], '-c');
  assert.equal(options.cwd, f.source); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(args[3], path.join(f.source, 'music', 'runtime'));
  const tokens = JSON.parse(options.env.YUR_MUSIC_ACCESS_TOKENS), [token] = Object.keys(tokens);
  assert.equal(Object.keys(tokens).length, 1); assert.ok(token.length >= 32);
  assert.deepEqual(tokens[token], { tenant: 'local', user: 'operator', role: 'owner' });
  assert.equal(options.env.PYTHONPATH, undefined); assert.equal(options.env.YUR_FOUNDRY_ROOT, undefined);
  f.ready(); const result = await starting;
  assert.equal(result.status, 'connected'); assert.equal(result.owned, true);
  assert.deepEqual(f.connection.configuration(), { endpoint, token });
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(f.connection.status()).includes(token));
  await f.connection.stop(); assert.equal(f.connection.status().status, 'stopped'); assert.equal(f.connection.configuration(), null);
  const second = f.connection.start(); f.ready(); await second;
  assert.notEqual(Object.keys(JSON.parse(f.state.calls[1][2].env.YUR_MUSIC_ACCESS_TOKENS))[0], token);
});

scopedTest('explicit Foundry authority binding is validated, forwarded and held stable for the owned process', async t => {
  const f = fixture(t);
  f.state.foundryRoot = path.join(f.directory, 'authority');
  fs.mkdirSync(path.join(f.state.foundryRoot, 'foundry'), { recursive: true });
  for (const name of ['commit_service.py', 'orchestration.py']) fs.writeFileSync(path.join(f.state.foundryRoot, 'foundry', name), '');
  const starting = f.connection.start();
  assert.equal(f.state.calls[0][2].env.YUR_FOUNDRY_ROOT, f.state.foundryRoot);
  assert.equal(f.state.calls[0][2].env.PYTHONPATH, undefined);
  f.ready(); await starting;
  f.state.foundryRoot = null;
  assert.equal(f.connection.configuration(), null);
  assert.equal(f.state.children[0].kills.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  const fallback = f.connection.start(); f.ready(); await fallback;
  assert.equal(f.state.calls[1][2].env.YUR_FOUNDRY_ROOT, undefined);
});

scopedTest('invalid or incomplete explicit Foundry authority fails before process launch', async t => {
  const f = fixture(t);
  f.state.foundryRoot = 'C:\\not-allowed';
  await assert.rejects(f.connection.start(), /local D:/);
  f.state.foundryRoot = path.join(f.directory, 'incomplete');
  fs.mkdirSync(path.join(f.state.foundryRoot, 'foundry'), { recursive: true });
  fs.writeFileSync(path.join(f.state.foundryRoot, 'foundry', 'commit_service.py'), '');
  await assert.rejects(f.connection.start(), /incomplete/);
  assert.equal(f.state.calls.length, 0);
});

scopedTest('valid external connection wins without spawn, filesystem discovery, or process ownership', async t => {
  let calls = 0;
  const external = { endpoint, token: 'x'.repeat(43) };
  const connection = createMusicConnection({ getSourceRoot: () => { throw new Error('not available'); }, getPython: () => 'python',
    getExternalConfiguration: () => external, spawn: () => { calls++; throw new Error('must not spawn'); } });
  assert.equal((await connection.start()).status, 'external'); assert.equal(calls, 0);
  assert.deepEqual(connection.configuration(), external); assert.equal(connection.status().owned, false);
  assert.equal((await connection.stop()).connected, true); assert.equal(calls, 0);
});

scopedTest('incomplete, wrong, off-drive and reparse source or storage are refused before launch', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'package.json'), '{"name":"other-app"}');
  await assert.rejects(f.connection.start(), /existing Music/); assert.equal(f.state.calls.length, 0);
  fs.writeFileSync(path.join(f.source, 'package.json'), '{"name":"@yur/music-studio"}');
  f.state.data = 'C:\\outside'; await assert.rejects(f.connection.start(), /local D:/); assert.equal(f.state.calls.length, 0);
  f.state.data = path.join(f.directory, 'linked');
  fs.symlinkSync(f.source, f.state.data, 'junction');
  await assert.rejects(f.connection.start(), /reparse/); assert.equal(f.state.calls.length, 0);
  fs.unlinkSync(f.state.data); f.state.data = null;
  fs.unlinkSync(path.join(f.source, 'music', 'authority.py'));
  await assert.rejects(f.connection.start(), /incomplete/); assert.equal(f.state.calls.length, 0);
});

scopedTest('pending prior jobs refuse startup transparently; startup pipe never mints authority without guard and matching storage', async t => {
  const f = fixture(t), pending = f.connection.start();
  f.guard('needs_review'); await assert.rejects(pending, /queued or running.*review/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.connection.status().status, 'needs_review'); assert.equal(f.connection.configuration(), null);
  assert.equal(f.state.children[0].kills.length, 1);
  const missingGuard = f.connection.start();
  f.announce({ status: 'listening', url: endpoint, storage: f.state.calls[1][1][3] });
  await assert.rejects(missingGuard, /readiness/); await new Promise(resolve => setImmediate(resolve));
  const wrongStorage = f.connection.start(); f.ready({ storage: path.join(f.directory, 'other') });
  await assert.rejects(wrongStorage, /readiness/); await new Promise(resolve => setImmediate(resolve));
  const badPort = f.connection.start(); f.ready({ url: 'http://127.0.0.1:99999' });
  await assert.rejects(badPort, /readiness/);
});

scopedTest('configuration changes invalidate and stop only the owned child; late readiness cannot revive it', async t => {
  const f = fixture(t), pending = f.connection.start(); f.ready(); await pending;
  f.state.data = path.join(f.directory, 'changed');
  assert.equal(f.connection.configuration(), null); assert.equal(f.state.children[0].kills.length, 1);
  f.announce({ status: 'listening', url: endpoint, storage: f.state.calls[0][1][3] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.connection.configuration(), null);
  const restarted = f.connection.start(); f.ready(); await restarted;
  f.state.external = { endpoint: 'http://127.0.0.1:45679', token: 'e'.repeat(43) };
  assert.deepEqual(f.connection.configuration(), f.state.external);
  await f.connection.stop(); assert.equal(f.state.children[1].kills.length, 1);
  assert.equal(f.connection.status().status, 'external');
});

scopedTest('live streaming configuration checks do not traverse source or storage files again', async t => {
  const f = fixture(t), start = f.connection.start(); f.ready(); await start;
  const original = fs.lstatSync;
  fs.lstatSync = () => { throw new Error('unexpected filesystem discovery'); };
  try {
    for (let index = 0; index < 20; index++) {
      assert.equal(f.connection.configuration().endpoint, endpoint);
      assert.equal(f.connection.status().connected, true);
    }
  } finally { fs.lstatSync = original; }
  assert.equal(f.state.children[0].kills.length, 0);
});

scopedTest('abort and deadline invalidate startup, kill only the owned process, and suppress raw diagnostics', async t => {
  const f = fixture(t, { timeoutMs: 15 }), controller = new AbortController();
  const pending = f.connection.start({ signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /cancelled/); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.connection.status().connected, false);
  const timed = f.connection.start();
  f.state.children[1].stderr.write('PRIVATE secret provider diagnostics');
  await assert.rejects(timed, /deadline/); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.children[1].kills.length, 1);
  assert.ok(!JSON.stringify(f.connection.status()).includes('PRIVATE'));
  controller.abort(); const calls = f.state.calls.length;
  await assert.rejects(f.connection.start({ signal: controller.signal }), /cancelled/); assert.equal(f.state.calls.length, calls);
});

scopedTest('oversized readiness and process failures are bounded; unexpected exit removes the connection', async t => {
  const f = fixture(t), overflow = f.connection.start();
  f.state.children[0].stdout.write('s'.repeat(17000));
  await assert.rejects(overflow, /bounded/); await new Promise(resolve => setImmediate(resolve));
  const start = f.connection.start(); f.ready(); await start;
  f.state.children[1].emit('close', 9);
  assert.equal(f.connection.configuration(), null); assert.equal(f.connection.status().status, 'failed');
  const spawnError = f.connection.start(); f.state.children[2].pid = undefined;
  f.state.children[2].emit('error', new Error('PRIVATE runtime error'));
  await assert.rejects(spawnError, /could not start/);
  assert.ok(!JSON.stringify(f.connection.status()).includes('PRIVATE'));
});

scopedTest('unconfirmed stop prevents replacement and keeps ownership until the same child really exits', async t => {
  const f = fixture(t), start = f.connection.start(); f.ready(); await start;
  const child = f.state.children[0]; child.autoClose = false;
  const stopped = await f.connection.stop();
  assert.equal(stopped.owned, true); assert.equal(stopped.connected, false); assert.match(stopped.notice, /unconfirmed/);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(f.connection.start(), /has not exited/); assert.equal(f.state.calls.length, 1);
  child.emit('close', 0); assert.equal(f.connection.status().owned, false);
});

scopedTest('actual trusted Python guard reads synthetic SQLite and refuses queued/running jobs before importing fixture server', async t => {
  const f = fixture(t), pending = f.connection.start();
  const [, args, options] = f.state.calls[0];
  const runtime = args[3], state = path.join(runtime, 'state'); fs.mkdirSync(state, { recursive: true });
  const database = path.join(state, 'foundry.sqlite3'), canary = path.join(f.directory, 'server-imported');
  fs.writeFileSync(path.join(f.source, 'music', 'server.py'), 'from pathlib import Path\nPath(' + JSON.stringify(canary) + ').write_text("imported")\n');
  const setup = 'import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1]);c.execute("CREATE TABLE IF NOT EXISTS music_documents(kind TEXT,document TEXT)");c.execute("DELETE FROM music_documents");c.execute("INSERT INTO music_documents VALUES(?,?)",("job",json.dumps({"data":{"state":sys.argv[2]}})));c.commit();c.close()';
  for (const prior of ['queued', 'running']) {
    const created = spawnSync('python', ['-B', '-c', setup, database, prior], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(created.status, 0, created.stderr);
    const before = createHash('sha256').update(fs.readFileSync(database)).digest('hex');
    const result = spawnSync('python', args, { ...options, stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 72, result.stderr); assert.match(result.stdout, /needs_review/);
    assert.equal(fs.existsSync(canary), false);
    assert.equal(createHash('sha256').update(fs.readFileSync(database)).digest('hex'), before);
  }
  const created = spawnSync('python', ['-B', '-c', setup, database, 'needs_review'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(created.status, 0, created.stderr);
  const cleared = spawnSync('python', args, { ...options, stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
  assert.equal(cleared.status, 0, cleared.stderr); assert.match(cleared.stdout, /clear/); assert.equal(fs.existsSync(canary), true);
  f.guard('needs_review'); await assert.rejects(pending, /need review/);
});
