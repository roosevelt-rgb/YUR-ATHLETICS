const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createRc6Transport, rc6Selection, resolvePackagedGateway, resolveInstalledExecutable } = require('../src/rc6-transport');
const constructionBinding = require('../src/construction-v1-binding.json');
const rc6Binding = require('../src/glider-rc6-binding.json');
// Protocol fixtures do not certify RC6 authority. Actual execution is exercised
// independently by the native/live acceptance tests against the pinned install.
function fixture(onEvent = () => {}, environment = {}, options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc6-protocol-'));
  const executable = path.join(profile, 'fixture.bin'); fs.writeFileSync(executable, 'Protocol fixture only');
  const expectedDigest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  const calls = [], children = [], spawns = [], launches = [];
  const launchProcess = options.launchProcess || ((file, args, launchOptions) => {
    launches.push({ file, args, options: launchOptions });
    const process = new EventEmitter(); process.pid = 4242; process.unref = () => {}; return process;
  });
  const transport = createRc6Transport({ profile, executable, expectedDigest, constructionExecutable: executable, constructionExpectedDigest: expectedDigest, onEvent, environment, ...options, launchProcess, spawnProcess(file, args, spawnOptions) {
    spawns.push({ file, args, options: spawnOptions });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.emitMessage = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin = new Writable({ write(bytes, _encoding, callback) {
      const request = JSON.parse(bytes.toString()); calls.push(request);
      if (request.method === 'session.create') setImmediate(() => child.emitMessage({ id: request.id, result: { session_id: 'session-' + calls.length } }));
      if (request.method === 'approval.respond') setImmediate(() => child.emitMessage({ id: request.id, result: { accepted: true } }));
      callback();
    } });
    child.kill = () => { child.killed = true; }; children.push(child); return child;
  } });
  return { profile, executable, expectedDigest, calls, children, spawns, launches, transport };
}
function packagedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-native-resource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'resources/app'); fs.mkdirSync(appRoot, { recursive: true });
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const executableBytes = Buffer.from('Protocol fixture only'), expectedDigest = hash(executableBytes);
  const marker = { schema: 'yur.desktop-native-components.v1', platform: 'win32', arch: 'x64', components: {} };
  const locations = {};
  for (const component of ['intelliflow', 'construction-v1']) {
    const folder = path.join(root, 'resources/native', component); fs.mkdirSync(path.join(folder, '_internal'), { recursive: true });
    const donor = Buffer.from('{"synthetic":"reviewed inert native bundle"}');
    const payload = { 'yur-gateway.exe': executableBytes, '_internal/core.dll': Buffer.from('Required inert dependency'), 'donor-manifest.json': donor };
    const files = Object.entries(payload).map(([name, bytes]) => { fs.writeFileSync(path.join(folder, name), bytes); return { path: name, bytes: bytes.length, sha256: hash(bytes) }; });
    const manifest = { schema: 'yur.native-gateway.v1', component, platform: 'win32', arch: 'x64', entrypoint: 'yur-gateway.exe',
      executable_sha256: expectedDigest, files, donor: { source_identity: 'Synthetic gateway protocol fixture', manifest_sha256: hash(donor), manifest_bytes: donor.length } };
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(folder, 'runtime.json'), bytes);
    marker.components[component] = { resource: '../native/' + component, manifest_sha256: hash(bytes) };
    locations[component] = { folder, manifest };
  }
  const markerPath = path.join(appRoot, '.desktop-native-components.json');
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  return { root, appRoot, expectedDigest, markerPath, marker, locations };
}

test('installed gateway paths come from the binding tokens rather than a second hardcoded path', () => {
  const localAppData = path.join('C:', 'Users', 'fixture', 'AppData', 'Local');
  assert.equal(resolveInstalledExecutable(rc6Binding, { LOCALAPPDATA: localAppData }),
    path.join(localAppData, 'Intelliflow', 'resources', 'gateway-runtime', 'yur-gateway.exe'));
  assert.equal(resolveInstalledExecutable(constructionBinding, { LOCALAPPDATA: localAppData }),
    path.join(localAppData, 'Intelliflow Construction V1', 'resources', 'gateway-runtime-v11', 'yur-gateway.exe'));
  assert.equal(resolveInstalledExecutable(constructionBinding, {}), null);
});

test('packaged gateways take precedence over installed executables while preserving private profiles', async t => {
  const packaged = packagedFixture(t), f = fixture(() => {}, {}, { appRoot: packaged.appRoot });
  t.after(() => f.transport.stop());
  assert.equal(f.transport.status().executable, path.join(packaged.locations.intelliflow.folder, 'yur-gateway.exe'));
  await f.transport.start();
  assert.equal(f.spawns[0].file, f.transport.status().executable);
  assert.equal(f.spawns[0].options.env.YUR_HOME, path.join(f.profile, 'rc6/home'));
  f.transport.stop(); f.transport.chooseRuntime('construction-v1'); await f.transport.start();
  assert.equal(f.spawns[1].file, path.join(packaged.locations['construction-v1'].folder, 'yur-gateway.exe'));
  assert.equal(f.spawns[1].options.env.YUR_HOME, path.join(f.profile, 'construction-v1/master-orcha/home'));
  assert.equal(fs.existsSync(path.join(packaged.root, 'rc6')), false);
});

test('packaged internal payload drift cannot fall back to an installed gateway or create state', async t => {
  const packaged = packagedFixture(t), f = fixture(() => {}, {}, { appRoot: packaged.appRoot });
  fs.writeFileSync(path.join(packaged.locations.intelliflow.folder, '_internal/core.dll'), 'changed required dependency');
  await assert.rejects(f.transport.start(), /runtime.*invalid|resource exceeds|payload digest/i);
  assert.equal(f.spawns.length, 0); assert.equal(fs.existsSync(path.join(f.profile, 'rc6')), false);
});

test('missing native metadata, changed manifests and nonfixed resource paths fail closed', t => {
  const packaged = packagedFixture(t);
  const markerBytes = fs.readFileSync(packaged.markerPath);
  fs.unlinkSync(packaged.markerPath);
  assert.throws(() => resolvePackagedGateway(packaged.appRoot, 'intelliflow', packaged.expectedDigest), /metadata is missing/);
  fs.writeFileSync(packaged.markerPath, markerBytes);
  const resource = packaged.marker.components.intelliflow.resource;
  packaged.marker.components.intelliflow.resource = '../../foreign'; fs.writeFileSync(packaged.markerPath, JSON.stringify(packaged.marker));
  assert.throws(() => resolvePackagedGateway(packaged.appRoot, 'intelliflow', packaged.expectedDigest), /fixed resource binding/);
  packaged.marker.components.intelliflow.resource = resource; fs.writeFileSync(packaged.markerPath, JSON.stringify(packaged.marker));
  fs.appendFileSync(path.join(packaged.locations.intelliflow.folder, 'runtime.json'), ' ');
  assert.throws(() => resolvePackagedGateway(packaged.appRoot, 'intelliflow', packaged.expectedDigest), /manifest digest differs/);
});

test('unlisted state, absent dependencies and hard-linked packaged files never start a gateway', async t => {
  for (const corruption of ['private-state', 'missing-dependency', 'hard-link']) {
    const packaged = packagedFixture(t), f = fixture(() => {}, {}, { appRoot: packaged.appRoot });
    const folder = packaged.locations.intelliflow.folder, dependency = path.join(folder, '_internal/core.dll');
    if (corruption === 'private-state') fs.writeFileSync(path.join(folder, 'session.sqlite3'), 'Private fixture state');
    else {
      fs.unlinkSync(dependency);
      if (corruption === 'hard-link') fs.linkSync(f.executable, dependency);
    }
    await assert.rejects(f.transport.start(), /excluded state|inventory differs|hard-linked/i);
    assert.equal(f.spawns.length, 0); assert.equal(fs.existsSync(path.join(f.profile, 'rc6')), false);
  }
});

test('packaged donor metadata is hash-bound and cannot change between selection and launch', async t => {
  const packaged = packagedFixture(t), f = fixture(() => {}, {}, { appRoot: packaged.appRoot });
  fs.appendFileSync(packaged.markerPath, ' ');
  await assert.rejects(f.transport.start(), /metadata or inventory changed/);
  assert.equal(f.spawns.length, 0); assert.equal(fs.existsSync(path.join(f.profile, 'rc6')), false);
});
test('runtime drift fails before a gateway process starts', async () => {
  const f = fixture(); fs.appendFileSync(f.executable, 'changed');
  await assert.rejects(f.transport.start(), /hash differs/); assert.equal(f.spawns.length, 0);
});

test('runtime catalog is read-only and Construction has a separate pinned master profile', async () => {
  const inherited = { YUR_MISSION_TRANSPORT_ENDPOINT: 'http://localhost:1', YUR_MISSION_TRANSPORT_TOKEN: 'fixture-only', YUR_CONSTRUCTION_EVIDENCE_ROOT: 'foreign', YUR_VALIDATION_PROJECT_ROOT: 'foreign' };
  const f = fixture(() => {}, inherited);
  const catalog = f.transport.availableRuntimes();
  assert.deepEqual(catalog.map(item => [item.runtimeKey, item.runtimeId, item.installed]), [['rc6', 'glider-rc6', true], ['construction-v1', 'master-orcha', true]]);
  assert.equal(f.spawns.length, 0); assert.equal(fs.existsSync(path.join(f.profile, 'rc6')), false);
  const original = f.transport.status(); assert.equal(original.verifiedDigest, null);
  for (const key of [null, {}, '__proto__', 'toString', 'unregistered']) assert.throws(() => f.transport.chooseRuntime(key));
  const selected = f.transport.chooseRuntime('construction-v1');
  assert.equal(selected.runtimeName, 'IntelliFlow Construction V1');
  assert.equal(selected.profile, path.join(f.profile, 'construction-v1/master-orcha/home'));
  const started = await f.transport.start(), env = f.spawns[0].options.env;
  assert.equal(started.verifiedDigest, f.expectedDigest); assert.equal(env.YUR_RUNTIME_ID, 'master-orcha');
  assert.equal(env.YUR_MISSION_TRANSPORT_ENDPOINT, undefined); assert.equal(env.YUR_MISSION_TRANSPORT_TOKEN, undefined);
  assert.equal(env.YUR_VALIDATION_PROJECT_ROOT, undefined);
  assert.equal(env.YUR_CONSTRUCTION_EVIDENCE_ROOT, path.join(selected.profile, 'construction-evidence'));
  assert.equal(env.YUR_CONSTRUCTION_VALIDATION_ROOT, path.join(selected.profile, 'construction-validation'));
  assert(env.YUR_ALLOWED_ROOTS.split(';').includes(env.YUR_MANAGED_CAPABILITY_ROOT));
  assert.throws(() => f.transport.chooseRuntime('rc6'), /Disconnect/);
  f.transport.stop(); assert.equal(f.transport.status().verifiedDigest, null);
  assert.equal(f.transport.chooseRuntime('rc6').profile, original.profile);
});

test('missing or drifted Construction executable fails before state or process creation', async () => {
  for (const overrides of [{ constructionExecutable: null }, { constructionExpectedDigest: '0'.repeat(64) }]) {
    const f = fixture(() => {}, {}, overrides); f.transport.chooseRuntime('construction-v1');
    await assert.rejects(f.transport.start(), /unavailable|hash differs/);
    assert.equal(f.spawns.length, 0); assert.equal(fs.existsSync(path.join(f.profile, 'construction-v1')), false);
  }
});

test('Construction opens the verified six-department workbench through its separate native authority', () => {
  const shell = path.join(os.tmpdir(), 'construction-workbench-' + crypto.randomUUID() + '.exe');
  const bytes = Buffer.from('Verified Construction V1 shell fixture'); fs.writeFileSync(shell, bytes);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const events = [], f = fixture(event => events.push(event), {}, {
    constructionWorkbenchExecutable: shell,
    constructionWorkbenchExpectedDigest: digest,
  });
  try {
    assert.throws(() => f.transport.openWorkbench(), /Select IntelliFlow Construction V1/);
    f.transport.chooseRuntime('construction-v1');
    assert.equal(f.transport.status().workbench.available, true);
    const result = f.transport.openWorkbench();
    assert.deepEqual(result, { state: 'dispatched', executable: shell, argument: '--open-master-orcha', sha256: digest, runtime_id: 'master-orcha', separate_authority: true, pid: 4242 });
    assert.deepEqual(f.launches[0].args, ['--open-master-orcha']);
    assert.equal(f.launches[0].options.detached, true);
    assert.equal(f.launches[0].options.shell, false);
    assert.equal(f.launches[0].options.stdio, 'ignore');
    assert.deepEqual(events.map(event => event.type), ['workbench.launch.requested', 'workbench.launch.dispatched']);
    f.transport.start();
    assert.throws(() => f.transport.openWorkbench(), /Disconnect the Construction V1 gateway/);
  } finally {
    f.transport.stop(); fs.rmSync(shell, { force: true }); fs.rmSync(f.profile, { recursive: true, force: true });
  }
});

test('Construction workbench launch fails closed when the pinned outer shell changes', () => {
  const shell = path.join(os.tmpdir(), 'construction-workbench-drift-' + crypto.randomUUID() + '.exe');
  fs.writeFileSync(shell, 'unreviewed shell');
  const f = fixture(() => {}, {}, { constructionWorkbenchExecutable: shell, constructionWorkbenchExpectedDigest: '0'.repeat(64) });
  try {
    f.transport.chooseRuntime('construction-v1');
    assert.throws(() => f.transport.openWorkbench(), /workbench hash differs/);
    assert.equal(f.launches.length, 0);
  } finally {
    f.transport.stop(); fs.rmSync(shell, { force: true }); fs.rmSync(f.profile, { recursive: true, force: true });
  }
});

test('runtime workspace selections persist independently and old approvals cannot cross switch', async () => {
  const f = fixture();
  const a = path.join(f.profile, 'project-a'), b = path.join(f.profile, 'project-b'); fs.mkdirSync(a); fs.mkdirSync(b);
  f.transport.chooseWorkspace(a); await f.transport.start();
  const oldSession = (await f.transport.createSession()).session_id;
  f.children[0].emitMessage({ method: 'event', params: { session_id: oldSession, payload: { kind: 'ApprovalRequest', request_id: 'old' } } });
  f.transport.stop(); f.transport.chooseRuntime('construction-v1'); f.transport.chooseWorkspace(b); await f.transport.start();
  assert.throws(() => f.transport.approval(oldSession, 'old', 'approve'), /does not belong/);
  f.children[0].emitMessage({ method: 'event', params: { session_id: oldSession, payload: { kind: 'ApprovalRequest', request_id: 'late-old' } } });
  assert.equal(f.transport.status().pendingApprovals, 0);
  f.transport.stop();
  const next = createRc6Transport({ profile: f.profile, executable: f.executable, expectedDigest: f.expectedDigest });
  assert.equal(next.status().workspace, a); next.chooseRuntime('construction-v1'); assert.equal(next.status().workspace, b);
});

test('console validates ownership and grammar before RPC and returns actual bounded results/events', async () => {
  const events = [], f = fixture(event => events.push(event)); await f.transport.start();
  const session = (await f.transport.createSession()).session_id;
  const count = f.calls.length;
  await assert.rejects(f.transport.console('foreign', 'pwd'), /does not belong/);
  await assert.rejects(f.transport.console(session, 'git branch -D no'), /Use pwd/);
  await assert.rejects(f.transport.console(session, 'type ../outside'), /traversal/);
  assert.equal(f.calls.length, count);
  const pending = f.transport.console(session, 'pwd'), wire = f.calls.at(-1);
  assert.equal(wire.method, 'shell.exec'); assert.deepEqual(wire.params, { session_id: session, command: 'Get-Location' });
  f.children[0].emitMessage({ id: wire.id, result: { stdout: 'x'.repeat(5000), stderr: 'error', code: 7, policy: 'read-only', reason: 'read-only command' } });
  const result = await pending;
  assert.equal(result.stdout.length, 4000); assert.equal(result.code, 7); assert.equal(result.runtimeKey, 'rc6'); assert.equal(result.sessionId, session);
  assert.equal(result.command, 'pwd'); assert.equal(typeof result.requestId, 'string');
  assert.deepEqual(events.map(item => item.type), ['console.started', 'console.completed']);
  assert.equal(events[1].payload.requestId, result.requestId); assert.equal(events[1].runtimeKey, 'rc6');
  f.transport.stop();
});

test('console rejects non-readonly or malformed results and stale completions', async () => {
  const events = [], f = fixture(event => events.push(event)); await f.transport.start();
  const session = (await f.transport.createSession()).session_id;
  for (const result of [{ stdout: '', stderr: '', code: 0, policy: 'write', reason: 'x' }, { stdout: {}, stderr: '', code: 0, policy: 'read-only', reason: 'x' }, { stdout: '', stderr: '', code: '0', policy: 'read-only', reason: 'x' }]) {
    const pending = f.transport.console(session, 'pwd'), wire = f.calls.at(-1);
    const rejected = assert.rejects(pending, /unsupported console result/);
    f.children[0].emitMessage({ id: wire.id, result }); await rejected;
  }
  assert.equal(events.filter(item => item.type === 'console.failed').length, 3);
  const pending = f.transport.console(session, 'pwd'), wire = f.calls.at(-1);
  const rejected = assert.rejects(pending, /stopped/);
  f.transport.stop(); f.transport.chooseRuntime('construction-v1'); await f.transport.start();
  f.children[0].emitMessage({ id: wire.id, result: { stdout: 'stale', stderr: '', code: 0, policy: 'read-only', reason: 'x' } });
  await rejected; assert.equal(events.filter(item => item.type === 'console.completed').length, 0); f.transport.stop();
});

test('optional RC6 can be inspected without a Windows runtime and fails before spawning', async () => {
  const previous = process.env.LOCALAPPDATA;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc6-unavailable-'));
  let spawned = false;
  try {
    delete process.env.LOCALAPPDATA;
    const transport = createRc6Transport({ profile, spawnProcess() { spawned = true; } });
    assert.equal(transport.status().running, false);
    assert.equal(transport.status().executable, null);
    await assert.rejects(transport.start(), /IntelliFlow runtime is unavailable/);
    assert.equal(spawned, false);
    assert.equal(fs.existsSync(path.join(profile, 'rc6')), false);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
test('gateway bindings isolate state and workspace while keeping stdio typed', async () => {
  const f = fixture(); await f.transport.start(); const { options } = f.spawns[0];
  assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(options.env.YUR_HOME.startsWith(f.profile)); assert.ok(options.env.YUR_DATA_DIR.startsWith(f.profile));
  assert.equal(options.env.YUR_ALLOWED_ROOTS, options.cwd); assert.equal(options.env.TERMINAL_CWD, options.cwd);
  assert.equal(options.env.YUR_MCP_CONFIG_PATHS_JSON, '[]'); f.transport.stop();
});
test('managed memory, scheduler and intake use the gateway names inside the isolated profile', async () => {
  const f = fixture(); await f.transport.start();
  const env = f.spawns[0].options.env;
  for (const [key, child] of [['YUR_MANAGED_SCHEDULER_ROOT', 'cron'], ['YUR_MANAGED_MEMORY_ROOT', 'memories'], ['YUR_MANAGED_KNOWLEDGE_ROOT', 'knowledge-intake']])
    assert.equal(env[key], path.join(env.YUR_HOME, child));
  f.transport.stop();
});
test('observer RPCs return gateway facts and delegation cannot inspect a foreign session', async () => {
  const f = fixture(); await f.transport.start();
  for (const [method, wireMethod] of [['inventory', 'capabilities.inventory'], ['health', 'capabilities.health'], ['info', 'harness.info']]) {
    const pending = f.transport[method](); const sent = f.calls.at(-1);
    assert.equal(sent.method, wireMethod); assert.deepEqual(sent.params, {});
    f.children[0].emitMessage({ id: sent.id, result: { source: wireMethod } });
    assert.deepEqual(await pending, { source: wireMethod });
  }
  assert.throws(() => f.transport.delegationStatus('foreign'), /does not belong/);
  const session = (await f.transport.createSession()).session_id;
  const pending = f.transport.delegationStatus(session), sent = f.calls.at(-1);
  assert.equal(sent.method, 'delegation.status'); assert.deepEqual(sent.params, { session_id: session });
  f.children[0].emitMessage({ id: sent.id, result: { active: [], paused: false } });
  assert.deepEqual(await pending, { active: [], paused: false });
  f.transport.stop();
  assert.throws(() => f.transport.delegationStatus(session), /does not belong/);
});
test('approval answers use an immutable exact request and reject replay or foreign sessions', async () => {
  const f = fixture(event => { if (event.payload?.kind === 'ApprovalRequest') event.payload.argument_digest = 'renderer-mutated'; });
  await f.transport.start(); const session = (await f.transport.createSession()).session_id;
  const request = { kind: 'ApprovalRequest', request_id: 'request-1', argument_digest: 'original-digest', destination: { model: 'test-model' }, authority_envelope: { envelope_id: 'envelope-1' } };
  f.children[0].emitMessage({ method: 'event', params: { type: 'approval.request', session_id: session, payload: request } });
  assert.throws(() => f.transport.approval('foreign', 'request-1', 'approve'), /does not belong/);
  assert.throws(() => f.transport.approval(session, 'request-1', 'always'), /Invalid approval/);
  assert.equal((await f.transport.approval(session, 'request-1', 'approve')).accepted, true);
  const wire = f.calls.find(call => call.method === 'approval.respond');
  assert.deepEqual(wire.params, { session_id: session, choice: 'approve', request_id: 'request-1', argument_digest: 'original-digest', destination_model: 'test-model', authority_envelope_id: 'envelope-1' });
  assert.throws(() => f.transport.approval(session, 'request-1', 'approve'), /already answered/); f.transport.stop();
});
test('clarification input stays bound to the owned session and uses the typed response field', async () => {
  const f = fixture(); await f.transport.start(); const session = (await f.transport.createSession()).session_id;
  const pending = f.transport.input(session, 'clarify-1', 'clarify', 'Apply the reviewed patch now.');
  const wire = f.calls.at(-1); assert.equal(wire.method, 'clarify.respond');
  assert.deepEqual(wire.params, { session_id: session, request_id: 'clarify-1', answer: 'Apply the reviewed patch now.' });
  f.children[0].emitMessage({ id: wire.id, result: { accepted: true } }); assert.deepEqual(await pending, { accepted: true });
  assert.throws(() => f.transport.input('foreign', 'clarify-2', 'clarify', 'x'), /does not belong/);
  assert.throws(() => f.transport.input(session, 'clarify-3', 'unknown', 'x'), /type is invalid/); f.transport.stop();
});
test('deny retains the same exact scope and cannot be upgraded afterward', async () => {
  const f = fixture(); await f.transport.start(); const session = (await f.transport.createSession()).session_id;
  f.children[0].emitMessage({ method: 'event', params: { type: 'approval.request', payload: { kind: 'ApprovalRequest', session_id: session, request_id: 'deny-1', argument_digest: 'deny-digest', destination: { model: 'test-model' }, authority_envelope: { envelope_id: 'deny-envelope' } } } });
  await f.transport.approval(session, 'deny-1', 'deny'); assert.equal(f.calls.at(-1).params.choice, 'deny');
  assert.throws(() => f.transport.approval(session, 'deny-1', 'approve'), /already answered/); f.transport.stop();
});
test('same approval identity cannot replace reviewed arguments or create duplicate dialogs', async () => {
  const events = [], f = fixture(event => events.push(event));
  await f.transport.start(); const session = (await f.transport.createSession()).session_id;
  const send = digest => f.children[0].emitMessage({ method: 'event', params: { type: 'approval.request', session_id: session,
    payload: { kind: 'ApprovalRequest', request_id: 'same-id', argument_digest: digest, destination: { model: 'test-model' }, authority_envelope: { envelope_id: 'e' } } } });
  send('original'); send('original');
  assert.equal(events.filter(x => x.payload?.kind === 'ApprovalRequest').length, 1);
  send('changed');
  assert.equal(events.at(-1).type, 'approval.invalidated');
  assert.throws(() => f.transport.approval(session, 'same-id', 'approve'), /absent/);
  send('original');
  assert.throws(() => f.transport.approval(session, 'same-id', 'approve'), /absent/);
  assert.equal(f.calls.filter(x => x.method === 'approval.respond').length, 0); f.transport.stop();
});
test('replayed native challenge cannot revive a consumed approval', async () => {
  const f = fixture(); await f.transport.start(); const session = (await f.transport.createSession()).session_id;
  const event = { method: 'event', params: { type: 'approval.request', session_id: session,
    payload: { kind: 'ApprovalRequest', request_id: 'consumed', argument_digest: 'digest', destination: { model: 'test-model' }, authority_envelope: { envelope_id: 'e' } } } };
  f.children[0].emitMessage(event); await f.transport.approval(session, 'consumed', 'deny');
  f.children[0].emitMessage(event);
  assert.throws(() => f.transport.approval(session, 'consumed', 'approve'), /absent/); f.transport.stop();
});
test('reconnect ignores old process exit and revokes old sessions', async () => {
  const f = fixture(); await f.transport.start(); const session = (await f.transport.createSession()).session_id;
  const old = f.children[0]; f.transport.stop(); await f.transport.start();
  old.emit('exit', 0); assert.equal(f.transport.status().running, true);
  assert.throws(() => f.transport.submit(session, 'stale'), /does not belong/);
  const fresh = await f.transport.createSession(); assert.ok(fresh.session_id); f.transport.stop();
});
test('workspace selection survives reload and cannot change during execution', async () => {
  const f = fixture(), selected = path.join(f.profile, 'selected'); fs.mkdirSync(selected);
  f.transport.chooseWorkspace(selected); await f.transport.start();
  assert.throws(() => f.transport.chooseWorkspace(f.profile), /Stop the harness/); f.transport.stop();
  const next = createRc6Transport({ profile: f.profile, executable: f.executable, expectedDigest: f.expectedDigest });
  assert.equal(next.status().workspace, selected);
});

test('Desktop Ollama picker identifiers preserve exact cloud aliases', () => {
  for (const model of ['kimi-k3:cloud', 'deepseek-v4-pro:cloud', 'minimax-m3:cloud', 'glm-5.2:cloud', 'qwen3.5:397b-cloud']) {
    assert.deepEqual(rc6Selection('ollama:' + model, 'http://127.0.0.1:11434'), { model, baseUrl: 'http://127.0.0.1:11434/v1' });
  }
  for (const model of [undefined, null, {}, 'foundry:auto', 'deepseek-v4-pro:cloud', 'ollama:', 'ollama: x', 'ollama:x\ny', 'ollama:' + 'x'.repeat(250)]) {
    assert.throws(() => rc6Selection(model, 'http://127.0.0.1:11434'), /Ollama model/);
  }
});

test('RC6 derives its endpoint from the host Ollama origin under the existing URL contract', () => {
  const selection = 'ollama:deepseek-v4-pro:cloud';
  assert.equal(rc6Selection(selection, 'http://localhost:11435/').baseUrl, 'http://localhost:11435/v1');
  assert.equal(rc6Selection(selection, 'http://[::1]:11434').baseUrl, 'http://[::1]:11434/v1');
  assert.equal(rc6Selection(selection, 'https://ollama.example.test').baseUrl, 'https://ollama.example.test/v1');
  for (const origin of ['http://remote.example.test', 'https://user:secret@example.test', 'https://example.test/v1', 'https://example.test?token=secret', 'file:///v1']) assert.throws(() => rc6Selection(selection, origin));
});

test('selected model and configured endpoint reach the actual child environment and status', async () => {
  const f = fixture(), selection = rc6Selection('ollama:deepseek-v4-pro:cloud', 'http://localhost:11435');
  const status = await f.transport.start(selection), env = f.spawns[0].options.env;
  assert.equal(env.YUR_MODEL, 'deepseek-v4-pro:cloud'); assert.equal(env.YUR_INFERENCE_MODEL, status.model);
  assert.equal(env.CUSTOM_BASE_URL, 'http://localhost:11435/v1'); assert.equal(env.CUSTOM_BASE_URL, status.baseUrl);
  assert.equal(status.selectedModel, 'deepseek-v4-pro:cloud'); assert.equal(status.modelSource, 'selection'); assert.equal(status.endpointSource, 'selection');
  selection.model = 'changed-by-caller'; assert.equal(f.transport.status().model, 'deepseek-v4-pro:cloud');
  f.transport.stop();
});

test('a connected process keeps its provider until disconnect and reconnect', async () => {
  const f = fixture(), first = rc6Selection('ollama:kimi-k3:cloud', 'http://127.0.0.1:11434');
  await f.transport.start(first); await f.transport.start(first); await f.transport.start();
  assert.equal(f.spawns.length, 1);
  const second = rc6Selection('ollama:deepseek-v4-pro:cloud', 'http://127.0.0.1:11434');
  await assert.rejects(f.transport.start(second), /Disconnect the harness/);
  await assert.rejects(f.transport.start({ ...first, baseUrl: 'http://localhost:11435/v1' }), /Disconnect the harness/);
  assert.equal(f.transport.status().model, first.model); assert.equal(f.spawns.length, 1);
  f.transport.stop(); await f.transport.start(second);
  assert.equal(f.transport.status().model, second.model); assert.equal(f.spawns.length, 2); f.transport.stop();
});

test('intentional environment overrides take precedence and are reported without changing a running process', async () => {
  const environment = { YUR_GLIDER_MODEL: 'glm-5.2:cloud', YUR_GLIDER_PROVIDER_URL: 'http://localhost:11435/v1/' };
  const f = fixture(() => {}, environment), selection = rc6Selection('ollama:kimi-k3:cloud', 'http://127.0.0.1:11434');
  const status = await f.transport.start(selection);
  assert.equal(status.model, 'glm-5.2:cloud'); assert.equal(status.selectedModel, 'kimi-k3:cloud');
  assert.equal(status.baseUrl, 'http://localhost:11435/v1'); assert.equal(status.modelSource, 'environment'); assert.equal(status.endpointSource, 'environment');
  assert.equal(f.spawns[0].options.env.YUR_MODEL, status.model); assert.equal(f.spawns[0].options.env.CUSTOM_BASE_URL, status.baseUrl);
  environment.YUR_GLIDER_MODEL = 'minimax-m3:cloud';
  assert.equal((await f.transport.start()).model, 'glm-5.2:cloud');
  await assert.rejects(f.transport.start(selection), /Disconnect the harness/);
  f.transport.stop(); assert.equal((await f.transport.start()).model, 'minimax-m3:cloud'); f.transport.stop();
});

test('invalid model selections and endpoint overrides fail before spawning or writing runtime state', async () => {
  const f = fixture();
  for (const selection of [null, [], 'model', { model: '' }, { model: 'x\ny' }, { model: 'x'.repeat(257) }, { model: 'ok', unexpected: true }, { baseUrl: 'http://remote.example.test/v1' }, { baseUrl: 'http://user:secret@localhost:11434/v1' }, { baseUrl: 'http://localhost:11434/api' }, { baseUrl: 'http://localhost:11434/v1?token=secret' }, { baseUrl: 'http://localhost:11434/v1#fragment' }, { baseUrl: 'http://localhost:11434/v1\n' }]) await assert.rejects(f.transport.start(selection));
  assert.equal(f.spawns.length, 0); assert.equal(fs.existsSync(path.join(f.profile, 'rc6')), false);
  const invalidOverride = fixture(() => {}, { YUR_GLIDER_PROVIDER_URL: 'http://remote.example.test/v1' });
  await assert.rejects(invalidOverride.transport.start(rc6Selection('ollama:kimi-k3:cloud', 'http://127.0.0.1:11434')));
  assert.equal(invalidOverride.spawns.length, 0);
});

test('pinned inventory Infinity metadata is normalized without changing quoted text', { timeout: 3000 }, async t => {
  const f = fixture(); t.after(() => f.transport.stop()); await f.transport.start();
  const pending = f.transport.inventory(), id = f.calls.at(-1).id;
  const description = 'Infinity -Infinity NaN with \\"quoted\\" text and emoji 🔎';
  const line = `{"jsonrpc":"2.0","id":${id},"result":{"count":2,"capabilities":[{"name":"read_file","input_contract":{"description":${JSON.stringify(description)}},"trust":{"bounded_result_chars":Infinity}},{"name":"write_file","trust":{"bounded_result_chars":100000}}]}}\n`;
  const bytes = Buffer.from(line), split = bytes.indexOf(Buffer.from('🔎')) + 2;
  f.children[0].stdout.write(bytes.subarray(0, split)); f.children[0].stdout.write(bytes.subarray(split));
  const result = await pending;
  assert.equal(result.count, 2);
  assert.deepEqual(result.capabilities[0].trust, { bounded_result_chars: null, result_size_unbounded: true });
  assert.equal(result.capabilities[0].input_contract.description, description);
  assert.deepEqual(result.capabilities[1].trust, { bounded_result_chars: 100000 });
});

test('non-finite tokens are rejected outside the one verified inventory field', { timeout: 5000 }, async t => {
  const f = fixture(); t.after(() => f.transport.stop()); await f.transport.start();
  for (const result of [
    '{"capabilities":[{"trust":{"bounded_result_chars":-Infinity}}]}',
    '{"capabilities":[{"trust":{"bounded_result_chars":NaN}}]}',
    '{"capabilities":[{"trust":{"bounded_result_chars":1e999}}]}',
    '{"capabilities":[{"trust":{"different_limit":Infinity}}]}',
    '{"capabilities":[{"input_contract":{"maximum":Infinity},"trust":{"bounded_result_chars":100}}]}',
    '{"tools":[{"trust":{"bounded_result_chars":Infinity}}]}',
    '{"count":Infinity,"capabilities":[]}',
    '{"capabilities":[{"trust":{"bounded_result_chars":Infinity,"result_size_unbounded":false}}]}',
    '{"capabilities":[{"trust":{"bounded_result_chars":Infinity}}],"capabilities":[]}',
  ]) {
    const pending = f.transport.inventory(), id = f.calls.at(-1).id;
    const rejected = assert.rejects(pending, /non-finite|Malformed/i);
    f.children[0].stdout.write(`{"id":${id},"result":${result}}\n`);
    await rejected;
  }
});

test('the Infinity exception cannot cross from inventory to another RPC', { timeout: 3000 }, async t => {
  const f = fixture(); t.after(() => f.transport.stop()); await f.transport.start();
  const inventory = f.transport.inventory(), inventoryId = f.calls.at(-1).id;
  const health = f.transport.health(), healthId = f.calls.at(-1).id;
  const rejected = assert.rejects(health, /non-finite/);
  f.children[0].stdout.write(`{"id":${healthId},"result":{"capabilities":[{"trust":{"bounded_result_chars":Infinity}}]}}\n`);
  await rejected;
  f.children[0].emitMessage({ id: inventoryId, result: { capabilities: [{ name: 'quoted', trust: { bounded_result_chars: 'Infinity' } }] } });
  assert.deepEqual((await inventory).capabilities[0].trust, { bounded_result_chars: 'Infinity' });
});

test('matching malformed JSON fails promptly and does not consume a sibling request', { timeout: 3000 }, async t => {
  const f = fixture(); t.after(() => f.transport.stop()); await f.transport.start();
  const pending = f.transport.inventory(), id = f.calls.at(-1).id;
  const info = f.transport.info(), infoId = f.calls.at(-1).id;
  const rejected = assert.rejects(pending, /Malformed/);
  f.children[0].stdout.write(`{"id":${id},"result":{"capabilities":oops}}\n`);
  await rejected;
  f.children[0].emitMessage({ id: infoId, result: { harness_id: 'fixture' } });
  assert.equal((await info).harness_id, 'fixture');
});

test('oversized unterminated frames are bounded and the reader recovers at the next line', { timeout: 5000 }, async t => {
  const f = fixture(); t.after(() => f.transport.stop()); await f.transport.start();
  const pending = f.transport.inventory(), id = f.calls.at(-1).id;
  const rejected = assert.rejects(pending, /4 MiB frame budget/);
  f.children[0].stdout.write(`{"id":${id},"result":{"text":"`);
  for (let index = 0; index < 65; index++) f.children[0].stdout.write(Buffer.alloc(65536, 120));
  await rejected;
  f.children[0].stdout.write('"}}\n');
  const info = f.transport.info(), infoId = f.calls.at(-1).id;
  f.children[0].emitMessage({ id: infoId, result: { harness_id: 'after-limit' } });
  assert.equal((await info).harness_id, 'after-limit');
});
