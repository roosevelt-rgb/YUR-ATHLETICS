/**
 * Independent native-gateway acceptance. Run explicitly after implementation:
 *   node tests/coding-runtimes-live.cjs --run-installed
 *   node tests/coding-runtimes-live.cjs --run-bundled <distribution> --evidence-root <outside-directory>
 * Uses actual pinned binaries in fresh private profiles, sequentially. No model
 * requests, department dispatch, installed-profile access or product mutation.
 * This is transport acceptance, not Electron UI or approval-cycle acceptance.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const arguments_ = process.argv.slice(2);
const bundledIndex = arguments_.indexOf('--run-bundled');
const bundled = bundledIndex !== -1;
const distributionRoot = bundled && arguments_[bundledIndex + 1] && !arguments_[bundledIndex + 1].startsWith('--')
  ? path.resolve(arguments_[bundledIndex + 1]) : null;
const productRoot = distributionRoot ? path.join(distributionRoot, 'resources', 'app') : path.resolve(__dirname, '..');
const taskRoot = path.resolve(productRoot, '../..');
const evidenceIndex = arguments_.indexOf('--evidence-root');
const evidenceRoot = evidenceIndex !== -1 && arguments_[evidenceIndex + 1] && !arguments_[evidenceIndex + 1].startsWith('--')
  ? path.resolve(arguments_[evidenceIndex + 1])
  : path.join(taskRoot, 'evidence/glider-rc6/comprehensive/coding-runtimes-2026-10-05');
const bindings = {
  rc6: {
    name: 'IntelliFlow', runtimeId: 'glider-rc6', scope: 'coding',
    executable: 'Intelliflow/resources/gateway-runtime/yur-gateway.exe',
    component: 'intelliflow',
    digest: 'af79aeeede5f6e31dddca91809c1e7de504d4284994a2f2f0fbc03890071e8a2',
    home: 'rc6/home',
  },
  'construction-v1': {
    name: 'IntelliFlow Construction V1', runtimeId: 'master-orcha', scope: 'construction-master',
    executable: 'Intelliflow Construction V1/resources/gateway-runtime-v11/yur-gateway.exe',
    component: 'construction-v1',
    digest: 'c5ca2b75443295b3697faf475a068aa3dab86c69eb26cb21bc1b2c5494b240bd',
    home: 'construction-v1/master-orcha/home',
  },
};
const sourceNames = [
  'src/rc6-transport.js', 'src/glider-rc6-binding.json',
  'src/construction-v1-binding.json', 'src/coding-console-policy.js',
  'src/main.js', 'src/preload.js', 'src/glider-frame.js', 'src/rc6-observer-view.js',
];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const inside = (root, item) => {
  const relative = path.relative(path.resolve(root), path.resolve(item));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const sourceHashes = () => Object.fromEntries(sourceNames.map(name => [name, fs.existsSync(path.join(productRoot, name)) ? sha(path.join(productRoot, name)) : null]));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  assert(bundled !== arguments_.includes('--run-installed'), 'Choose exactly one explicit --run-installed or --run-bundled mode; no gateway was started.');
  assert.equal(process.platform, 'win32', 'Native Windows gateway acceptance requires Windows.');
  assert(process.env.LOCALAPPDATA, 'LOCALAPPDATA is missing.');
  if (bundled) {
    assert(distributionRoot, '--run-bundled requires the distribution directory.');
    assert(evidenceIndex !== -1 && arguments_[evidenceIndex + 1] && !arguments_[evidenceIndex + 1].startsWith('--'), 'Bundled acceptance requires an explicit external --evidence-root.');
    assert(!inside(distributionRoot, evidenceRoot), 'Acceptance receipts must remain outside the untouched distribution.');
    assert(fs.existsSync(path.join(distributionRoot, 'electron.exe')), 'Bundled Electron is missing.');
    assert(fs.existsSync(path.join(productRoot, '.desktop-native-components.json')), 'Bundled native component marker is missing.');
  }
  const { createRc6Transport, resolvePackagedGateway } = require(path.join(productRoot, 'src/rc6-transport'));
  const at = new Date().toISOString();
  const runId = at.replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const runEvidence = path.join(evidenceRoot, runId);
  fs.mkdirSync(runEvidence, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-coding-runtimes-'));
  const profile = path.join(tempRoot, 'profile');
  const events = [], processes = [], instances = [];
  let selectedKey = 'rc6';
  const receipt = {
    schema: bundled ? 'yur.coding-runtimes.bundled-transport-acceptance.v1' : 'yur.coding-runtimes.installed-transport-acceptance.v1', at, runId,
    passed: false, scope: 'actual ' + (bundled ? 'bundled' : 'installed') + ' gateway transport, isolated state, no inference',
    mode: bundled ? 'bundled' : 'installed', distributionRoot,
    sourceBefore: sourceHashes(), profile, fixtureRoot: tempRoot,
    checks: [], runtimes: {}, processes: [], limitations: [
      'No Electron picker or visible native UI interaction in this test.',
      'No model inference, real approval cycle, tool mutation or department mission dispatched.',
      'Inventory admission and health responses do not certify every capability execution.',
      'No installed-profile migration or six-department runtime acceptance.',
    ],
  };
  const save = () => fs.writeFileSync(path.join(runEvidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const check = async (name, action) => {
    const began = Date.now();
    try {
      const result = await action();
      receipt.checks.push({ name, passed: true, elapsedMs: Date.now() - began });
      save(); console.log('PASS ' + name); return result;
    } catch (error) {
      receipt.checks.push({ name, passed: false, elapsedMs: Date.now() - began, error: error.message });
      save(); throw error;
    }
  };
  const reject = (action, pattern = /./) => assert.rejects(Promise.resolve().then(action), pattern);
  const environment = { ...process.env };
  delete environment.YUR_GLIDER_MODEL;
  delete environment.YUR_GLIDER_PROVIDER_URL;
  if (bundled) {
    environment.APPDATA = path.join(tempRoot, 'roaming');
    environment.LOCALAPPDATA = path.join(tempRoot, 'local');
    environment.USERPROFILE = path.join(tempRoot, 'user');
    environment.YUR_UNIFIED_ROOT = distributionRoot;
  }
  const selection = bundled ? { model: 'acceptance-no-inference', baseUrl: 'http://127.0.0.1:1/v1' }
    : { model: 'qwen3.5:9b', baseUrl: 'http://127.0.0.1:11434/v1' };
  // Deliberate inert inherited values must never reach Construction's process.
  environment.YUR_MISSION_TRANSPORT_ENDPOINT = 'http://127.0.0.1:1/acceptance-must-strip';
  environment.YUR_MISSION_TRANSPORT_TOKEN = 'SYNTHETIC-ACCEPTANCE-NOT-A-CREDENTIAL';
  const make = () => {
    const transport = createRc6Transport({
      profile, environment, appRoot: productRoot,
      onEvent(event) {
        if (events.length >= 1000) return;
        const payload = event?.payload || {};
        events.push({ at: new Date().toISOString(), selectedKey, type: event?.type || null,
          sessionId: event?.session_id || payload.sessionId || payload.session_id || null,
          runtimeKey: event?.runtimeKey || payload.runtimeKey || null,
          requestId: payload.requestId || payload.request_id || null,
          policy: payload.policy || null });
      },
      spawnProcess(executable, args, options) {
        assert.equal(options.windowsHide, true);
        if (bundled) {
          assert(inside(distributionRoot, executable), 'Gateway executable escaped the candidate distribution.');
          assert.equal(normalized(executable), normalized(path.join(distributionRoot, 'resources', 'native', bindings[selectedKey].component, 'yur-gateway.exe')));
        }
        const child = spawn(executable, args, options);
        const entry = { child, selectedKey, closed: false, executable, pid: child.pid,
          cwd: options.cwd, runtimeId: options.env.YUR_RUNTIME_ID,
          home: options.env.YUR_HOME, authorityData: options.env.YUR_DATA_DIR,
          allowedRoots: options.env.YUR_ALLOWED_ROOTS,
          missionEndpointAbsent: !options.env.YUR_MISSION_TRANSPORT_ENDPOINT,
          missionTokenAbsent: !options.env.YUR_MISSION_TRANSPORT_TOKEN,
          managedRoots: Object.fromEntries(['YUR_MANAGED_SKILL_ROOT', 'YUR_MANAGED_CAPABILITY_ROOT',
            'YUR_MANAGED_SCHEDULER_ROOT', 'YUR_MANAGED_MEMORY_ROOT', 'YUR_MANAGED_KNOWLEDGE_ROOT',
            'YUR_CONSTRUCTION_EVIDENCE_ROOT', 'YUR_CONSTRUCTION_VALIDATION_ROOT']
            .map(key => [key, options.env[key] || null])) };
        child.once('close', (code, signal) => { entry.closed = true; entry.code = code; entry.signal = signal; });
        processes.push(entry);
        return child;
      },
    });
    instances.push(transport); return transport;
  };
  async function stop(transport) {
    transport.stop();
    const end = Date.now() + 12000;
    while (processes.some(item => !item.closed) && Date.now() < end) await delay(100);
    assert(processes.every(item => item.closed), 'Gateway did not close; refuse to overlap installed runtimes.');
    assert.equal(transport.status().running, false);
    assert.equal(transport.status().verifiedDigest, null);
  }
  const timeout = setTimeout(() => {
    receipt.error = 'Acceptance exceeded its five-minute deadline.';
    for (const transport of instances) { try { transport.stop(); } catch {} }
    receipt.passed = false; save(); process.exitCode = 1;
  }, 300000);
  timeout.unref();
  let previousSession;
  try {
    const transport = make();
    await check('new selector and console contract is present', () => {
      for (const method of ['availableRuntimes', 'chooseRuntime', 'console']) assert.equal(typeof transport[method], 'function', method + ' has not landed');
      assert.equal(transport.status().runtimeKey, 'rc6');
    });
    await check('read-only runtime discovery preserves both ' + (bundled ? 'bundled' : 'installed') + ' bindings', async () => {
      const entries = await transport.availableRuntimes();
      assert(Array.isArray(entries));
      for (const [key, expected] of Object.entries(bindings)) {
        const item = entries.find(entry => entry.runtimeKey === key);
        assert(item, 'Missing runtime ' + key); assert.equal(item.installed, true);
        assert.equal(item.runtimeName, expected.name); assert.equal(item.runtimeId, expected.runtimeId);
        assert.equal(item.scope, expected.scope);
      }
      assert.equal(processes.length, 0);
      assert.equal(fs.existsSync(profile), false, 'Discovery must not provision runtime state.');
      receipt.catalog = entries;
      await reject(() => transport.chooseRuntime('unregistered-runtime'));
    });
    fs.writeFileSync(path.join(tempRoot, 'outside.txt'), 'ACCEPTANCE_OUTSIDE_SELECTED_WORKSPACE\n');
    for (const [key, expected] of Object.entries(bindings)) {
      selectedKey = key;
      const workspace = path.join(tempRoot, 'projects', key + ' project');
      const nested = path.join(workspace, 'sub folder');
      fs.mkdirSync(nested, { recursive: true });
      const file = path.join(workspace, 'marker.txt'), spaced = path.join(nested, 'marker with spaces.txt');
      const marker = 'LIVE_CONSOLE_' + key.toUpperCase().replaceAll('-', '_') + '_' + runId;
      fs.writeFileSync(file, marker + '\n'); fs.writeFileSync(spaced, marker + '_SPACED\n');
      const originals = { [file]: sha(file), [spaced]: sha(spaced) };
      const selected = await transport.chooseRuntime(key);
      assert.equal(selected.runtimeKey, key);
      transport.chooseWorkspace(workspace);
      const runtime = receipt.runtimes[key] = { workspace, observations: {} };
      await check(key + ': exact ' + (bundled ? 'bundled' : 'installed') + ' executable and private state', async () => {
        const executable = bundled ? path.join(distributionRoot, 'resources', 'native', expected.component, 'yur-gateway.exe')
          : path.join(process.env.LOCALAPPDATA, expected.executable);
        assert.equal(sha(executable), expected.digest, 'Native binary drifted since independent identification.');
        if (bundled) {
          assert(inside(distributionRoot, fs.realpathSync.native(executable)));
          const resolved = resolvePackagedGateway(productRoot, expected.component, expected.digest);
          assert(resolved, 'Packaged native component was not resolved.');
          const manifestPath = path.join(path.dirname(executable), 'runtime.json');
          const nativeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          runtime.bundleOrigin = { executable, executable_sha256: sha(executable), manifestPath,
            runtime_manifest_sha256: sha(manifestPath), donor: nativeManifest.donor,
            donor_manifest_sha256: sha(path.join(path.dirname(executable), 'donor-manifest.json')) };
          assert.equal(runtime.bundleOrigin.donor_manifest_sha256, nativeManifest.donor.manifest_sha256);
        }
        const result = await transport.start(selection);
        assert.equal(result.runtimeKey, key); assert.equal(result.runtimeName, expected.name);
        assert.equal(result.runtimeId, expected.runtimeId); assert.equal(result.scope, expected.scope);
        assert.equal(result.expectedDigest, expected.digest); assert.equal(result.verifiedDigest, expected.digest);
        assert.equal(normalized(result.executable), normalized(executable));
        assert.equal(normalized(result.workspace), normalized(workspace));
        assert.equal(normalized(result.profile), normalized(path.join(profile, expected.home)));
        const processEntry = processes.at(-1);
        assert.equal(processEntry.runtimeId, expected.runtimeId);
        assert.equal(normalized(processEntry.home), normalized(result.profile));
        assert(inside(result.profile, processEntry.authorityData));
        for (const root of Object.values(processEntry.managedRoots).filter(Boolean)) assert(inside(result.profile, root), 'Managed root escaped private runtime home.');
        if (key === 'construction-v1') {
          assert(processEntry.missionEndpointAbsent && processEntry.missionTokenAbsent, 'Inherited department mission credentials reached isolated Construction.');
        }
        runtime.status = result;
        await reject(() => transport.chooseRuntime(key === 'rc6' ? 'construction-v1' : 'rc6'));
      });
      const inventory = await check(key + ': actual gateway inventory and health', async () => {
        const inventory = await transport.inventory();
        const health = await transport.health();
        const info = await transport.info();
        assert(Array.isArray(inventory.capabilities) && inventory.capabilities.length > 0);
        assert(health && typeof health === 'object' && !Array.isArray(health));
        assert(info && typeof info === 'object' && !Array.isArray(info));
        runtime.inventory = inventory.capabilities.map(item => ({ name: item.name || item.capability_id,
          operational_state: item.operational_state ?? null, health: item.health ?? null,
          authority: item.authority ?? null, available: item.available ?? null }));
        runtime.health = { status: health.status ?? null, harness_id: health.harness_id ?? null,
          version: health.version ?? null, tools: health.tools ?? null,
          reasons: Array.isArray(health.reasons) ? health.reasons.slice(0, 20).map(value => String(value).slice(0, 500)) : [] };
        runtime.harness = { harness_id: info.harness_id ?? null, version: info.version ?? null,
          architecture: info.architecture ?? null, shell_mode: info.shell_mode ?? null };
        return inventory;
      });
      await check(key + ': master capability registration is accurately distinguished', () => {
        const names = new Set(inventory.capabilities.map(item => item.name || item.capability_id));
        const required = ['construction_project_intake', 'construction_project_status', 'construction_evidence_compile',
          'construction_cognitive_bootstrap', 'construction_cognitive_maintain', 'construction_cognitive_query',
          'construction_cognitive_status', 'construction_validation_run', 'construction_workload_plan'];
        if (key === 'construction-v1') for (const name of required) assert(names.has(name), 'Master tool missing: ' + name);
        else assert(!names.has('construction_project_intake'), 'RC6 unexpectedly identifies as Construction master.');
        runtime.masterToolsPresent = required.filter(name => names.has(name));
      });
      const session = (await transport.createSession()).session_id;
      assert.equal(typeof session, 'string'); assert(session);
      runtime.session = session;
      await check(key + ': session ownership and prior-session invalidation', async () => {
        await reject(() => transport.console('invented-session', 'pwd'));
        if (previousSession) await reject(() => transport.console(previousSession, 'pwd'));
      });
      await check(key + ': real pwd, dir and bounded file-read results', async () => {
        const inputs = ['pwd', 'dir', 'type marker.txt', 'type "sub folder/marker with spaces.txt"'];
        const replies = [];
        for (const command of inputs) {
          const result = await transport.console(session, command);
          assert.equal(result.policy, 'read-only'); assert.equal(result.code, 0);
          assert.equal(result.runtimeKey, key); assert.equal(result.sessionId, session);
          assert.equal(result.command, command); assert.equal(typeof result.requestId, 'string'); assert(result.requestId);
          assert.equal(typeof result.stdout, 'string'); assert.equal(typeof result.stderr, 'string');
          replies.push(result);
        }
        assert(normalized(replies[0].stdout.trim()).includes(normalized(workspace)) || replies[0].stdout.toLowerCase().replaceAll('\\', '/').includes(normalized(workspace)), 'pwd did not identify selected workspace.');
        assert(replies[1].stdout.includes('marker.txt'));
        assert(replies[2].stdout.includes(marker)); assert(replies[3].stdout.includes(marker + '_SPACED'));
        runtime.observations.console = replies;
      });
      await check(key + ': unsupported and outside-workspace requests rejected', async () => {
        const requests = ['echo unsupported-console-grammar', 'type ../outside.txt', 'type ..\\..\\outside.txt',
          'type "' + path.join(tempRoot, 'outside.txt') + '"', 'pwd; pwd', 'type .env'];
        for (const command of requests) await reject(() => transport.console(session, command));
        runtime.observations.rejectedCommands = requests;
        for (const [name, digest] of Object.entries(originals)) assert.equal(sha(name), digest, 'Console changed fixture bytes.');
      });
      await check(key + ': disconnect revokes session and closes gateway before next runtime', async () => {
        await stop(transport);
        await reject(() => transport.console(session, 'pwd'));
      });
      previousSession = session;
      await check(key + ': new transport restores this runtime workspace and reconnects', async () => {
        const reloaded = make();
        assert.equal(reloaded.status().runtimeKey, 'rc6');
        await reloaded.chooseRuntime(key);
        assert.equal(normalized(reloaded.status().workspace), normalized(workspace));
        await reloaded.start(selection);
        await reject(() => reloaded.console(session, 'pwd'));
        const fresh = (await reloaded.createSession()).session_id;
        const result = await reloaded.console(fresh, 'type marker.txt');
        assert.equal(result.policy, 'read-only'); assert(result.stdout.includes(marker));
        runtime.reconnect = { session: fresh, workspace: reloaded.status().workspace, profile: reloaded.status().profile,
          verifiedDigest: reloaded.status().verifiedDigest, readMarker: true };
        await stop(reloaded);
      });
    }
    await check('runtime homes are distinct and product sources remained stable during acceptance', () => {
      assert.notEqual(normalized(receipt.runtimes.rc6.status.profile), normalized(receipt.runtimes['construction-v1'].status.profile));
      receipt.sourceAfter = sourceHashes();
      assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Product source changed during acceptance; rerun against stable merged sources.');
    });
    receipt.passed = true;
  } catch (error) {
    receipt.error = error.stack || error.message; process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    for (const transport of instances) { try { transport.stop(); } catch {} }
    const end = Date.now() + 12000;
    while (processes.some(item => !item.closed) && Date.now() < end) await delay(100);
    receipt.processes = processes.map(({ child, ...item }) => item);
    if (processes.some(item => !item.closed)) { receipt.passed = false; receipt.cleanupError = 'An owned gateway process did not report closure.'; process.exitCode = 1; }
    receipt.endedAt = new Date().toISOString();
    receipt.sourceAfter ||= sourceHashes();
    receipt.events = events;
    save();
    console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(runEvidence, 'receipt.json'),
      checksPassed: receipt.checks.filter(item => item.passed).length, error: receipt.error || receipt.cleanupError || null }));
    // Preserve only our fresh fixture/profile for receipt inspection. Never remove
    // user workspaces, installed state, or another acceptance run's directory.
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
