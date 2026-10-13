'use strict';
// Native UI -> actual Franklin transport/Python Work/OM/Commit -> host/adapters.
// Only the local model, execution transports and explicit human dialog decisions
// are fixtures. No installed gateway, external provider, deployment or purchase.
const { app, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const sourceRoot = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-franklin-mission-'));
const workspace = path.join(home, 'selected-workspace'); fs.mkdirSync(workspace);
const evidence = path.resolve(__dirname, '../../../evidence/glider-rc6/comprehensive/franklin-mission-execution-2026-10-05/native');
const attempt = path.join(evidence, 'attempt-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(attempt, { recursive: true });
const monitored = ['src/main.js', 'src/preload.js', 'src/franklin-host.js', 'src/franklin-transport.js', 'src/franklin-view.js',
  'src/franklin-execution.js', 'src/franklin-coding.js', 'src/franklin-surfaces.js', 'src/media-host.js',
  'foundry/work_desktop.py', 'foundry/franklin_cli.py', 'foundry/franklin_store.py', 'foundry/work_engine.py', 'foundry/commit_service.py'];
const fingerprint = () => Object.fromEntries(monitored.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, name))).digest('hex')]));
const receipt = { started_at: new Date().toISOString(), home, workspace, attempt, checks: [], source_before: fingerprint(), limitations: [
  'This uses the actual Electron Franklin panel, IPC, Python Work/OrchestrationManager/CommitService and Desktop execution adapters.',
  'Model responses are deterministic localhost fixtures; this is not model quality, cloud provider or live production acceptance.',
  'Coding transport, media request backend and marketplace sidecar callbacks are synthetic. No installed gateway or user session is used.',
  'Native confirmation dialogs use scripted human allow/deny decisions. This validates the confirmation boundary, not an autonomous approval grant.',
  'Synthetic generated media and forged packs do not claim provider generation, native validation, deployment, installation or commercial outcome.'
] };
let win, modelServer, transport, deadline, finalized = false, activeCase = '', heldApproval, releaseApproval;
const actions = [], terminalEvents = [], modelRequests = [], dialogs = [], codingCalls = [], mediaCalls = [], marketplaceCalls = [];
const workerSession = 'franklin-fixture-worker-1';
const mediaPrompt = 'Synthetic courtyard image for execution routing';
const codingPrompt = 'Build only fixture-module.py in the selected workspace. Run the assigned synthetic checks and return evidence.';
const plan = { mission: 'Synthetic bounded Desktop execution', deliverables: ['fixture-module.py'],
  roles: [{ role: 'Implementation worker', owns: ['fixture-module.py'] }], acceptance: ['Observe the worker result'],
  unresolved: ['Public deployment and live provider generation are outside this fixture'] };

process.env.YUR_GLIDER_RC6 = '1'; process.env.YUR_HARNESS_AUTOSTART = '0';
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.APPDATA = path.join(home, 'appdata'); process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot');
process.env.YUR_WORKFORCE_SOURCE = path.join(home, 'unused-workforce');
process.env.YUR_FACTORY_PYTHON = require('../src/desktop-runtime').desktopPython(sourceRoot);
process.env.PYTHONDONTWRITEBYTECODE = '1'; process.env.YUR_FRANKLIN_MODEL = 'franklin-mission-fixture';
process.env.YUR_FRANKLIN_API_KEY = 'local-fixture';
app.setPath('userData', path.join(home, 'electron')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('mute-audio');

// Substitute only the native transport. The Franklin coding adapter and all of
// main.js's routing, ownership, event handling and confirmations remain real.
const codingModule = require('../src/rc6-transport');
codingModule.createRc6Transport = options => {
  assert.equal(path.resolve(options.profile), path.join(home, 'electron'));
  const state = { running: false, runtimeKey: 'rc6', runtimeName: 'Synthetic RC6 transport', workspace,
    model: null, baseUrl: null, verifiedDigest: 'a'.repeat(64), tools: [] };
  return {
    status: () => ({ ...state }),
    availableRuntimes: () => [{ runtimeKey: 'rc6', runtimeName: 'Synthetic RC6', scope: 'fixture-only', installed: true }],
    async start(selection) { codingCalls.push({ operation: 'start', selection }); Object.assign(state, selection, { running: true }); return { ...state }; },
    async createSession() { codingCalls.push({ operation: 'createSession', session_id: workerSession }); return { session_id: workerSession }; },
    async submit(session_id, text) {
      codingCalls.push({ operation: 'submit', session_id, text }); assert.equal(session_id, workerSession);
      setTimeout(() => {
        options.onEvent({ type: 'tool.result', session_id, runtimeKey: 'rc6', payload: {
          name: 'synthetic-check', summary: 'Synthetic assigned checks passed', receipt: { status: 'fixture', commit_id: 'fixture-only' } } });
        options.onEvent({ type: 'message.complete', session_id, runtimeKey: 'rc6', payload: {
          text: 'Synthetic worker completed its bounded assignment. No public deployment occurred.', status: 'completed' } });
      }, 75);
      return { accepted: true };
    },
    async interrupt(session_id) { codingCalls.push({ operation: 'interrupt', session_id }); return { requested: true }; },
    async approval() { throw new Error('This fixture must never grant a native tool approval.'); },
    stop() { state.running = false; },
    chooseRuntime() { throw new Error('Fixture runtime must remain selected.'); },
    chooseWorkspace() { throw new Error('Fixture workspace must remain selected.'); },
    console() { throw new Error('Fixture must not execute console commands.'); },
  };
};
const mediaModule = require('../src/media-host'), originalMedia = mediaModule.createMediaHost;
mediaModule.createMediaHost = options => {
  assert.ok(path.resolve(options.getRoot()).startsWith(home + path.sep));
  return originalMedia({ ...options, request: async request => {
    const { action, payload } = request; mediaCalls.push({ action, payload });
    if (action === 'catalog') return { ok: true, result: { presets: [{ id: 'flux-klein-image-v1', kind: 'image', width: 1024, height: 1024 }] } };
    if (action === 'status') return { ok: true, result: { ready: true, provider: 'synthetic-no-inference' } };
    if (action === 'list') return { ok: true, result: { jobs: [] } };
    if (action === 'submit') return { ok: true, result: { id: payload.request.request_id.replaceAll('-', ''), request: payload.request,
      state: 'queued', assets: [], provider: { provider: 'synthetic-no-inference' } } };
    throw new Error('Unexpected fixture media operation ' + action);
  } });
};
require('../src/harness-sidecar').createHarnessSidecar = options => {
  assert.ok(path.resolve(options.stateDir).startsWith(home + path.sep));
  return {
    status: () => ({ state: 'idle', running: false, fixture: true }), start: async () => ({ running: false, fixture: true }), stop: async () => ({}),
    async request(method, apiPath, body) {
      marketplaceCalls.push({ method, path: apiPath, body });
      if (method === 'GET' && apiPath === '/api/inventory') return { ok: true, result: { inventory: [{ id: 'fixture-pack' }], fixture: true } };
      if (method === 'GET' && apiPath === '/api/packs') return { ok: true, result: { packs: [{ id: 'fixture-pack' }], fixture: true } };
      if (method === 'GET' && apiPath === '/api/packs/fixture-pack') return { ok: true, result: { id: 'fixture-pack', installed: false, fixture: true } };
      if (method === 'POST' && apiPath === '/api/karma/forge') return { ok: true, result: { pack_id: 'fixture-forged-pack', status: 'candidate', deployed: false, fixture: true } };
      throw new Error('Unexpected fixture marketplace operation ' + method + ' ' + apiPath);
    },
  };
};
dialog.showMessageBox = async (_owner, options) => {
  assert.equal(options.title, 'Franklin · Confirm mission action', 'Only the host mission confirmation is scripted');
  assert.deepEqual(options.buttons, ['Cancel', 'Execute this action']);
  const row = { case: activeCase, title: options.title, detail: options.detail, default_id: options.defaultId };
  dialogs.push(row);
  assert.equal(options.defaultId, 0); assert.match(options.detail, /Mission: [a-f0-9]{32}/); assert.match(options.detail, /Exact action: [a-f0-9]{64}/);
  if (activeCase === 'cancelapproval') {
    heldApproval = row;
    return new Promise(resolve => { releaseApproval = () => { row.response = 1; resolve({ response: 1 }); }; });
  }
  row.response = activeCase === 'denied' ? 0 : 1;
  return { response: row.response };
};
const hostModule = require('../src/franklin-host'), originalHost = hostModule.createFranklinHost;
hostModule.createFranklinHost = options => {
  const host = originalHost(options);
  return { ...host, async execute(action, payload, identity) {
    const row = { action, payload, case: activeCase, request_id: identity.request_id, mission_id: identity.mission_id, action_id: identity.action_id };
    actions.push(row);
    try { row.result = await host.execute(action, payload, identity); return row.result; }
    catch (error) { row.error = error.message; throw error; }
  } };
};
const transportModule = require('../src/franklin-transport'), originalTransport = transportModule.createFranklinTransport;
transportModule.createFranklinTransport = options => (transport = originalTransport({ ...options, onEvent(event, owner) {
  if (/^turn\./.test(event.type)) terminalEvents.push(event);
  options.onEvent(event, owner);
} }));

const action = (name, payload = {}) => ({ name: 'desktop_action', arguments: { action: name, payload } });
const media = prompt => action('media_submit', { preset: 'flux-klein-image-v1', prompt });
const forge = { agent_type: 'Synthetic estimator', capabilities: ['Report bounded fixture values'], industry: 'Fixture',
  name: 'Fixture pack', description: 'Synthetic forge callback only', team: false, provider: 'ollama', model: '' };
const plans = {
  build: [{ name: 'create_artifact', arguments: { name: 'mission-plan.json', media_type: 'application/json', content: JSON.stringify(plan) } },
    action('desktop_capabilities'), action('coding_catalog'),
    action('coding_start', { runtime_key: 'rc6', workspace, model: 'ollama:franklin-mission-fixture' }),
    action('coding_submit', { session_id: workerSession, text: codingPrompt, role: 'Implementation worker' }),
    action('coding_wait', { session_id: workerSession, timeout_ms: 25000 }), action('coding_status', { session_id: workerSession })],
  denied: [media('Synthetic denied image')], generated: [media(mediaPrompt)],
  marketplace: [action('marketplace_inventory'), action('marketplace_packs'), action('marketplace_pack', { pack_id: 'fixture-pack' }), action('marketplace_forge', forge)],
  foreign: [action('coding_status', { session_id: 'foreign-human-session' })],
  cancelapproval: [media('Synthetic cancelled while awaiting confirmation')],
};
const evaluate = code => win.webContents.executeJavaScript('(()=>{' + code + '})()', true);
async function until(test, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
}
const waitUi = (expression, label) => until(() => evaluate('return ' + expression), label || expression);
async function send(name, during, expected = 'turn.complete') {
  activeCase = name; const actionBefore = actions.length, terminalBefore = terminalEvents.length;
  await waitUi(`!document.getElementById('franklin-input').disabled`);
  await evaluate(`const input=document.getElementById('franklin-input');input.value=${JSON.stringify('MISSION_CASE:' + name + ' Execute the bounded fixture mission and report only observed results.')};input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await waitUi(`!document.getElementById('franklin-send').disabled`);
  await evaluate(`document.querySelector('.yur-franklin-form').requestSubmit();`);
  if (during) await during();
  await until(() => terminalEvents.length > terminalBefore, 'Franklin turn ' + name, 45000);
  const terminal = terminalEvents.at(-1);
  assert.equal(terminal.type, expected, JSON.stringify(terminal));
  const rows = actions.slice(actionBefore);
  assert.equal(rows.length, plans[name].filter(item => item.name === 'desktop_action').length);
  const snapshot = await evaluate('return window.studio.franklin.snapshot();'); assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const request = snapshot.result.requests.find(item => item.id === terminal.request_id); assert.ok(request);
  assert.equal(request.status, expected === 'turn.cancelled' ? 'cancelled' : 'completed');
  const inspected = await evaluate(`return window.studio.work.inspect(${JSON.stringify(request.mission_id)});`);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  receipt.turns ||= []; receipt.turns.push({ name, request, mission: inspected.result.mission, events: inspected.result.events });
  return { rows, request, mission: inspected.result.mission };
}
async function finish(error) {
  if (finalized) return; finalized = true; clearTimeout(deadline); transport?.shutdown();
  releaseApproval?.();
  receipt.completed_at = new Date().toISOString(); receipt.source_after = fingerprint();
  receipt.source_changed = monitored.filter(name => receipt.source_before[name] !== receipt.source_after[name]);
  if (receipt.source_changed.length) error ||= new Error('Source changed during native validation: ' + receipt.source_changed.join(', '));
  receipt.passed = !error; receipt.error = error?.stack;
  Object.assign(receipt, { actions, dialogs, coding_calls: codingCalls, media_calls: mediaCalls, marketplace_calls: marketplaceCalls,
    model_requests: modelRequests, terminal_events: terminalEvents });
  if (error && win && !win.isDestroyed()) { try { receipt.ui_error = await evaluate('return document.getElementById("franklin-error")?.textContent'); } catch {} }
  if (win && !win.isDestroyed()) win.destroy(); modelServer?.closeAllConnections(); modelServer?.close();
  fs.writeFileSync(path.join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(evidence, 'latest.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed: !error, error: error?.message, checks: receipt.checks, attempt, home }));
  app.exit(error ? 1 : 0);
}
async function test() {
  try {
    const entered = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await evaluate('setTimeout(()=>window.studio.launch.enter(),25);'); await entered;
    await waitUi(`!!document.getElementById('franklin-toggle')&&!document.getElementById('franklin-input').disabled`);
    await evaluate(`document.getElementById('franklin-toggle').click();`);
    await waitUi(`!document.getElementById('franklin-model').disabled`);
    const configured = await evaluate(`return window.studio.franklin.configure({model:'openai:franklin-mission-fixture'});`); assert.equal(configured.ok, true);

    const build = await send('build');
    assert.equal(build.mission.request.root, null); assert.equal(build.mission.request.mode, 'work');
    assert.equal(build.mission.artifacts.length, 1); assert.equal(build.mission.artifacts[0].status, 'committed');
    assert.ok(JSON.stringify(build.mission.artifacts[0]).includes('Implementation worker'));
    assert.ok(build.mission.steps.every(step => step.succeeded));
    const submitted = build.rows.find(row => row.action === 'coding_submit');
    assert.equal(submitted.result.session_id, workerSession); assert.equal(submitted.result.role, 'Implementation worker');
    assert.equal(codingCalls.filter(row => row.operation === 'start').length, 1);
    assert.equal(codingCalls.filter(row => row.operation === 'createSession').length, 1);
    assert.deepEqual(codingCalls.find(row => row.operation === 'submit'), { operation: 'submit', session_id: workerSession, text: codingPrompt });
    const observed = build.rows.find(row => row.action === 'coding_status').result;
    assert.equal(observed.status, 'completed'); assert.equal(observed.runtime_completed, true);
    assert.match(observed.output, /Synthetic worker completed/); assert.equal(observed.role, 'Implementation worker');
    assert.ok(observed.events.some(row => row.name === 'synthetic-check'));
    assert.ok(build.rows.find(row => row.action === 'desktop_capabilities').result.capabilities.some(row => row.id === 'phone-outreach' && row.connected === false));
    assert.equal(dialogs.filter(row => row.case === 'build').length, 2);
    receipt.checks.push('Actual Franklin panel commits a plan and role, discovers bindings, creates a dedicated synthetic coding session, submits exact text once and observes worker completion through native host wiring');

    const beforeDenied = mediaCalls.filter(row => row.action === 'submit').length;
    const denied = await send('denied');
    assert.equal(denied.rows[0].result.status, 'rejected'); assert.equal(denied.rows[0].result.executed, false);
    assert.equal(denied.mission.steps[0].result.status, 'failed');
    assert.equal(mediaCalls.filter(row => row.action === 'submit').length, beforeDenied);
    receipt.checks.push('Scripted human denial reaches actual confirmation dialog, records failed action and dispatches zero media generation callbacks');

    const generated = await send('generated'); const generation = generated.rows[0];
    const generationCalls = mediaCalls.filter(row => row.action === 'submit'); assert.equal(generationCalls.length, beforeDenied + 1);
    const request = generationCalls.at(-1).payload.request;
    assert.equal(request.request_id.replaceAll('-', ''), generation.action_id); assert.equal(request.prompt, mediaPrompt);
    assert.equal(request.width, 1024); assert.equal(request.height, 1024); assert.equal(request.seed, 1);
    assert.equal(generation.result.state, 'queued'); assert.equal(generation.result.confirmation.approved, true);
    assert.equal(generated.mission.steps[0].result.receipt.event_type, 'franklin.action.completed');
    receipt.checks.push('Scripted human approval dispatches one normalized media request with exact action-derived request_id through the actual Media host and persists its queued synthetic result');

    const market = await send('marketplace');
    assert.ok(market.rows.every(row => !row.error)); assert.equal(dialogs.filter(row => row.case === 'marketplace').length, 1);
    assert.deepEqual(marketplaceCalls.map(row => [row.method, row.path]), [['GET', '/api/inventory'], ['GET', '/api/packs'], ['GET', '/api/packs/fixture-pack'], ['POST', '/api/karma/forge']]);
    assert.deepEqual(marketplaceCalls.at(-1).body, forge); assert.equal(market.rows.at(-1).result.deployed, false);
    receipt.checks.push('Actual marketplace surface routing inspects three catalogs without mutation confirmation and confirms one exact forge candidate request without deployment');

    const submitCount = codingCalls.filter(row => row.operation === 'submit').length;
    const foreign = await send('foreign'); assert.match(foreign.rows[0].error, /does not belong/);
    assert.equal(foreign.mission.steps[0].result.status, 'failed'); assert.equal(codingCalls.filter(row => row.operation === 'submit').length, submitCount);
    assert.equal(dialogs.filter(row => row.case === 'foreign').length, 0);
    receipt.checks.push('A foreign human session identifier is rejected by the actual coding ownership adapter and has no native submission or approval side effect');

    const beforeCancelled = mediaCalls.filter(row => row.action === 'submit').length;
    const cancelled = await send('cancelapproval', async () => {
      await until(() => Boolean(heldApproval), 'human confirmation held');
      await waitUi(`!document.getElementById('franklin-stop').disabled`);
      await evaluate(`document.getElementById('franklin-stop').click();`);
      await until(() => terminalEvents.at(-1)?.type === 'turn.cancelled', 'cancelled while confirmation pending');
      releaseApproval();
      await until(() => Boolean(actions.at(-1)?.error), 'late approval rejected');
    }, 'turn.cancelled');
    assert.equal(cancelled.mission.status, 'cancelled'); assert.match(cancelled.rows[0].error, /no longer active|scope.*cancelled/);
    assert.equal(mediaCalls.filter(row => row.action === 'submit').length, beforeCancelled);
    receipt.checks.push('Actual Franklin Stop cancels the committed mission while its human dialog is pending; a later scripted approval cannot dispatch media');

    const final = await evaluate('return window.studio.franklin.snapshot();'); assert.equal(final.ok, true);
    assert.equal(final.result.requests.length, 6); assert.equal(final.result.active_request, null);
    receipt.final_snapshot = final.result;
    const verified = require('node:child_process').spawnSync(process.env.YUR_FACTORY_PYTHON, ['-B', '-c',
      "import json, os\nfrom pathlib import Path\nfrom foundry.commit_service import CommitService\nwith CommitService(Path(os.environ['YUR_DESKTOP_HOME'])) as store:\n print(json.dumps(store.verify_integrity()))"],
      { cwd: sourceRoot, windowsHide: true, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' } });
    assert.equal(verified.status, 0, verified.stderr); receipt.integrity = JSON.parse(verified.stdout);
    assert.equal(receipt.integrity.ok, true);
    try { const image = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }), new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot exceeded three seconds')), 3000))]); fs.writeFileSync(path.join(attempt, 'franklin-mission-results.png'), image.toPNG()); }
    catch (error) { receipt.capture_limit = error.message; }
    receipt.checks.push('Six requests retain actual Work missions, action receipts, observed outcomes and cancellation state; an independent CommitService reader verifies journal integrity');
    await finish();
  } catch (error) { await finish(error); }
}
(async () => {
  modelServer = http.createServer((req, res) => {
    const reply = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/tags') return reply({ models: [{ name: 'franklin-mission-fixture' }] });
    if (req.url === '/api/health') return reply({ fixture: true }); if (req.url === '/api/models') return reply({ models: [] });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw), messages = body.messages; let index = -1, name;
        for (let n = messages.length - 1; n >= 0; n--) {
          const match = messages[n].role === 'user' && messages[n].content.match(/MISSION_CASE:([a-z]+)/);
          if (match) { index = n; name = match[1]; break; }
        }
        assert.ok(plans[name], 'Unknown deterministic fixture case');
        const results = messages.slice(index + 1).filter(message => message.role === 'tool');
        modelRequests.push({ case: name, tools: body.tools.map(item => item.function.name), results: results.map(item => JSON.parse(item.content)) });
        const step = plans[name][results.length];
        const message = step ? { role: 'assistant', content: '', tool_calls: [{ id: 'fixture_' + name + '_' + results.length, type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
          : { role: 'assistant', content: 'The observed fixture results are retained. A queued image is not generation completion, a candidate is not deployment, and rejected work did not execute.' };
        reply({ id: 'fixture-' + randomUUID(), object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message, finish_reason: step ? 'tool_calls' : 'stop' }] });
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    });
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + modelServer.address().port;
  process.env.YUR_FRANKLIN_OPENAI_URL = origin + '/v1'; process.env.YUR_OLLAMA_URL = origin; process.env.YUR_FOUNDRY_URL = origin;
  app.on('browser-window-created', (_event, created) => {
    win = created; win.webContents.setBackgroundThrottling(false); win.setFocusable(false); win.setOpacity(0);
    win.setPosition(-16000, -16000); win.setSkipTaskbar(true); win.webContents.once('did-finish-load', test);
  });
  deadline = setTimeout(() => finish(new Error('Native Franklin mission acceptance exceeded three minutes')), 180000);
  require('../src/main');
})().catch(finish);
