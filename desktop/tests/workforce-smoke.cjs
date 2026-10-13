'use strict';

// Real Desktop IPC, AST-only profile acquisition, OrchestrationManager and
// CommitService in isolated temporary state. Model output and one deliberately
// lost response after a real commit are the only transport fixtures.
const { app, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const reviewedQuantity = require('./workforce-fixture.cjs');

const sourceRoot = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-workforce-smoke-'));
const workforceRoot = path.join(home, 'workforce source fixture');
const marker = 'WORKFORCE_PROFILE_SOURCE_9a041';
const forbidden = 'EXCLUDED_WORKFORCE_SECRET_71a9b';
const sentinel = path.join(home, 'DONOR_EXECUTED');
function put(relative, text) {
  const target = path.join(workforceRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
const tripwire = `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text('executed')\nraise RuntimeError('Donor source must never execute')\n`;
put('__init__.py', tripwire);
put('genome.py', `${tripwire}\nfrom enum import Enum\nclass Scope(str, Enum):\n    INTERNAL = 'internal'\nclass Authority(str, Enum):\n    APPROVE = 'APPROVE'\n    ABSTAIN = 'ABSTAIN'\nclass Genome:\n    pass\nclass Superagent:\n    pass\nclass EndpointAffinity:\n    pass\n`);
put('registry.py', tripwire);
put('dispatch_map.py', tripwire);
put('docs/README.md', '# YUR Workforce fixture\nSource profiles and pure capability provenance only.\n');
function profile(code, name, description, endpoint) {
  return `${tripwire}\nfrom ..genome import Genome, Superagent, EndpointAffinity, Scope, Authority\nclass FixtureAgent(Superagent):\n    def __init__(self):\n        super().__init__(Genome(\n            code=${JSON.stringify(code)}, name=${JSON.stringify(name)},\n            lineage='fixture.workforce', version='0.1.0',\n            description=${JSON.stringify(description)},\n            affinities=[EndpointAffinity(${JSON.stringify(endpoint)}, Scope.INTERNAL, 0.2, 'Bounded fixture profile')],\n            receptors=['quantity.survey'], cytokines=['quantity.ready'],\n            default_authority=Authority.ABSTAIN, max_authority=Authority.APPROVE,\n            rate_limit_per_min=120\n        ))\n    async def handle(self, signal):\n        raise RuntimeError('Never call donor handle')\n`;
}
const profilePath = 'agents/oracle.py';
const profileText = profile('oracle', 'Oracle', `Cross-domain reasoning fixture. ${marker}.`, 'yur:reason');
put(profilePath, profileText);
assert.equal(createHash('sha256').update(reviewedQuantity.source).digest('hex'), reviewedQuantity.sha256);
put('agents/hatch_quantity.py', reviewedQuantity.source);
put('agents/__init__.py', tripwire);
put('server.py', tripwire);
put('.env', `PRIVATE_VALUE=${forbidden}\n`);
put('data/private.py', `# ${forbidden}\n`);
const profileDigest = createHash('sha256').update(profileText).digest('hex');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.setPath('userData', path.join(home, 'electron'));
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal');
process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.YUR_WORKFORCE_SOURCE = workforceRoot;
process.env.APPDATA = path.join(home, 'appdata');
const checks = [], requests = [], rendererErrors = [], blocked = [];
const screenshots = {};
let finished = false, testWindow = null;
let pendingMissionId = null, execution = null;
let discardNextWorkforceResponse = false, lostExecution = null, lostResponses = 0, recoveryVerified = false;
// Wrap registration through the public Electron API before main.js registers
// its handlers. The real authenticated handler, child process and commit finish
// before this single selected IPC response is discarded.
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerIpcHandler(channel, channel === 'workforce:run' ? async (...args) => {
  const response = await handler(...args);
  if (discardNextWorkforceResponse && response?.ok === true) {
    discardNextWorkforceResponse = false; lostExecution = response.result; lostResponses += 1;
    return { ok: false, error: { code: 'RUNTIME_RESPONSE_LOST', message: 'The smoke test discarded this response after the real commit.' } };
  }
  return response;
} : handler);
const started = Date.now();
const children = new Set();
function rpc(request) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
    delete env.PYTHONPATH; delete env.PYTHONHOME;
    const child = spawn(process.env.YUR_FACTORY_PYTHON || 'python', ['-B', '-m', 'foundry.factory_cli', 'rpc'], { cwd: sourceRoot, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '', settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); done(new Error('Canonical CLI request timed out.')); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) { child.kill(); done(new Error('CLI output exceeds test bound.')); } });
    child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 65536) { child.kill(); done(new Error('CLI diagnostics exceed test bound.')); } });
    child.on('error', error => done(error));
    child.stdin.on('error', error => done(error));
    child.on('close', code => {
      children.delete(child);
      try {
        const envelope = JSON.parse(stdout);
        if (code !== 0 || envelope.ok !== true) throw new Error(`Canonical CLI failed: ${JSON.stringify(envelope)} ${stderr}`);
        done(null, envelope.result);
      } catch (error) { done(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
const fixture = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/api/health') return reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: [{ name: 'workforce-fixture', kind: 'fixture' }] });
  if (request.url === '/api/tags') return reply(200, { models: [] });
  if (request.method !== 'POST' || request.url !== '/api/ask') return reply(404, { error: 'Unknown fixture route.' });
  let body = '';
  request.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 300000) request.destroy(); });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body); requests.push(payload);
      const selected = String(payload.query || '').includes(marker);
      reply(200, { answer: selected ? `Selected Oracle profile: ${marker}.` : 'No workforce profile was supplied.', provider: 'workforce-smoke-fixture', model: 'workforce-fixture' });
    } catch (error) { reply(400, { error: error.message }); }
  });
});
const deadline = setTimeout(() => finish(new Error('Workforce smoke exceeded its deadline.')), 120000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline);
  for (const child of children) child.kill();
  fixture.closeAllConnections(); fixture.close();
  const report = { ok: !error, verification: 'native-desktop-workforce-canonical-execution', ...(error ? { error: error.message, stack: error.stack } : {}), checks, renderer_errors: rendererErrors, blocked_external_requests: blocked, model_fixture_requests: requests.length, unrelated_mission_id: pendingMissionId, execution, lost_response_recovery: { responses_discarded: lostResponses, verified: recoveryVerified, mission_id: lostExecution?.mission_id, run_id: lostExecution?.run_id, request_id: lostExecution?.request_id }, screenshots, source_root: workforceRoot, profile_sha256: profileDigest, admitted_quantity_sha256: reviewedQuantity.sha256, elapsed_ms: Date.now() - started, test_home: home };
  fs.writeFileSync(path.join(home, 'workforce-smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
  app.exit(error ? 1 : 0);
}
async function waitFor(contents, expression, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const notice = await contents.executeJavaScript('document.getElementById("yc-notice")?.textContent || document.getElementById("yc-catalog-note")?.textContent || ""');
  throw new Error(`Timed out: ${expression}. ${notice}`);
}
async function capture(contents, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const shot = await contents.capturePage(undefined, { stayHidden: true });
      assert.equal(shot.isEmpty(), false);
      const target = path.join(home, `workforce-${name}.png`);
      fs.writeFileSync(target, shot.toPNG()); screenshots[name] = target; return;
    } catch (error) { if (attempt === 2 || !error.message.includes('UnknownVizError')) throw error; }
  }
}

async function run(window) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  const assertNoProfileMission = async message => {
    if (process.env.YUR_GLIDER_RC6 === '1') {
      // Combined mode starts the real lifecycle dispatcher. Its read-only
      // discovery may initialize storage before profile browsing does any work.
      const listed = await evaluate('window.studio.work.list(null)');
      assert.equal(listed.ok, true); assert.deepEqual(listed.result.missions, [], message);
    } else assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false, message);
  };
  await waitFor(contents, 'Boolean(window.studio?.workforce && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  if (process.env.YUR_GLIDER_RC6 === '1') {
    await waitFor(contents, 'Boolean(document.getElementById("glider-frame"))');
    assert.equal((await evaluate('window.studio.integration.info()')).enabled, true);
    checks.push('Workforce fixture runs inside the actual combined Glider frame');
  }
  const originalUrl = contents.getURL();
  const openWorkforce = async () => {
    await evaluate('document.querySelector(\'[data-workspace="agents"]\').click(); if (document.getElementById("yc-workforce-toggle").getAttribute("aria-pressed") !== "true") document.getElementById("yc-workforce-toggle").click();');
    await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 2 && document.getElementById("yc-section-resources").textContent.includes("HATCH Quantity")');
  };
  assert.equal((await evaluate('window.studio.workforce.catalog({root:"C:/"})')).ok, false, 'Renderer cannot replace the configured source root.');
  await openWorkforce();
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 2 && document.getElementById("yc-section-resources").textContent.includes("HATCH Quantity")');
  assert.equal(contents.getURL(), originalUrl);
  assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode")'), true);
  assert.equal(fs.existsSync(sentinel), false, 'Catalog must parse source without executing donor modules.');
  await assertNoProfileMission('Profile browsing must not create a mission.');
  checks.push('Agents reads real source profiles through AST acquisition in the current shell without importing donor modules');
  await capture(contents, 'profiles');
  await evaluate('[...document.querySelectorAll("#yc-section-resources .yc-resource-card")].find(button => button.textContent.includes("Oracle")).click()');
  await evaluate('[...document.querySelectorAll("#yc-resource-detail button")].find(button => button.textContent === "Use in conversation").click()');
  await waitFor(contents, 'document.getElementById("yc-workforce").textContent.includes("Oracle") && !document.getElementById("yc-main").classList.contains("section-open")');
  assert.equal(requests.length, 0);
  const question = 'Explain the selected workforce profile and its source marker.';
  await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(question)}; document.getElementById('yc-form').requestSubmit();`);
  await waitFor(contents, 'document.querySelectorAll("#yc-messages .yc-message").length === 2 && !document.getElementById("yc-send").disabled');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].query.includes(marker) && requests[0].query.includes(profileDigest), 'Actual selected source definition and hash must reach inference.');
  assert.ok(!JSON.stringify(requests).includes(forbidden));
  assert.equal(await evaluate(`document.querySelector('.yc-message.assistant')?.textContent.includes(${JSON.stringify(marker)})`), true);
  const history = await evaluate('window.studio.conversations.list()');
  assert.ok(JSON.stringify(history).includes(profileDigest), 'Selected source evidence must be committed to the conversation journal.');
  assert.equal(fs.existsSync(sentinel), false);
  await assertNoProfileMission('Profile conversation must not create a Work mission.');
  checks.push('Selected profile source reaches model context and journaled provenance without starting donor execution');
  await capture(contents, 'conversation');

  const input = { plans_text: 'Division 03\nConcrete 125 CY', specs_text: '09 51 00\nGypsum 1,200 SF' };
  const forbiddenAuthority = { code: 'hatch_quantity', expected_sha256: reviewedQuantity.sha256, input, request_id: randomUUID(), authority: { issuer: 'system', actions: ['*'] } };
  assert.equal((await evaluate(`window.studio.workforce.run(${JSON.stringify(forbiddenAuthority)})`)).ok, false, 'Renderer cannot supply its own authority envelope.');
  await assertNoProfileMission('Invalid authority injection must stop before mission creation.');
  checks.push('Authenticated preload rejects source-root and authority overrides before execution');

  const pending = await rpc({ command: 'submit', spec: { name: 'Unrelated pending smoke mission', description: 'Must remain queued during the explicit quantity survey.', capabilities: ['text.analyze'] }, idempotency_key: 'workforce-smoke-unrelated-pending' });
  pendingMissionId = pending.id;
  assert.ok(pendingMissionId);
  const before = await rpc({ command: 'inspect', mission_id: pendingMissionId });
  assert.equal(before.status, 'queued');
  await openWorkforce();
  await evaluate('[...document.querySelectorAll("#yc-section-resources .yc-resource-card")].find(button => button.textContent.includes("HATCH Quantity")).click()');
  await waitFor(contents, 'Boolean(document.getElementById("yc-workforce-plans") && document.getElementById("yc-workforce-specs") && document.getElementById("yc-workforce-run"))');
  await evaluate(`document.getElementById('yc-workforce-plans').value = ${JSON.stringify(input.plans_text)}; document.getElementById('yc-workforce-specs').value = ${JSON.stringify(input.specs_text)}; document.getElementById('yc-workforce-run').click();`);
  await waitFor(contents, 'Boolean(document.getElementById("yc-workforce-output")?.textContent.trim()) && !document.getElementById("yc-workforce-run").disabled', 45000);
  execution = JSON.parse(await evaluate('document.getElementById("yc-workforce-output").textContent'));
  assert.equal(execution.capability_id, 'workforce.hatch.quantity');
  assert.ok(execution.mission_id && execution.run_id && execution.request_id && execution.input_hash);
  assert.equal(execution.profile.sha256, reviewedQuantity.sha256);
  assert.equal(execution.execution_receipt.event_type, 'execution.completed');
  assert.equal(execution.output_record.event_type, 'workforce.result.committed');
  assert.equal(execution.output.line_count, 2);
  assert.equal(execution.output.area_total_sf, 1200);
  assert.equal(execution.output.method, 'source_quantity_tokens');
  assert.equal(execution.output.totals_scope, 'returned_line_items');
  const concrete = execution.output.line_items.find(item => item.unit === 'CY');
  const gypsum = execution.output.line_items.find(item => item.unit === 'SF');
  assert.equal(concrete.qty, 125); assert.equal(gypsum.qty, 1200);
  assert.equal(concrete.sources[0].field, 'plans_text'); assert.equal(concrete.sources[0].line, 2);
  assert.equal(gypsum.sources[0].field, 'specs_text'); assert.equal(gypsum.sources[0].line, 2);
  assert.equal(requests.length, 1, 'Explicit quantity execution must use the admitted local worker, not a model.');
  const mission = await rpc({ command: 'inspect', mission_id: execution.mission_id });
  assert.equal(mission.status, 'completed');
  assert.ok(mission.artifact?.digest, 'Executed worker package must have a committed artifact.');
  assert.deepEqual(mission.spec.capabilities, ['workforce.hatch.quantity']);
  assert.deepEqual(await rpc({ command: 'inspect', mission_id: pendingMissionId }), before, 'Targeted HATCH execution must not process or mutate another queued mission.');
  assert.equal(await evaluate('document.getElementById("yc-resource-detail").getClientRects().length > 0 && document.getElementById("yc-workforce-status").getClientRects().length > 0 && document.querySelector("#yc-workforce-result table").getClientRects().length > 0 && document.getElementById("yc-section-resources").getClientRects().length === 0'), true, 'Completed quantity table and status must remain visible; a delayed catalog response must not replace the open detail with its grid.');
  assert.equal(await evaluate('document.getElementById("yc-workforce-output").closest("details").open'), false, 'Raw execution evidence should remain collapsed by default.');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#yc-workforce-result table tr")].slice(1).map(row => [...row.cells].map(cell => cell.textContent))'), [['Division 03', '125', 'CY', 'Concrete 125 CY'], ['09 51 00', '1,200', 'SF', 'Gypsum 1,200 SF']]);
  checks.push('Run quantity survey validates and commits the admitted worker, executes exact token quantities, and leaves unrelated queued mission untouched');
  await evaluate('document.getElementById("yc-workforce-result").scrollIntoView({block:"center"})');
  await capture(contents, 'quantity-result');

  const replayRequest = { code: 'hatch_quantity', expected_sha256: reviewedQuantity.sha256, input, request_id: execution.request_id };
  const replay = await evaluate(`window.studio.workforce.run(${JSON.stringify(replayRequest)})`);
  assert.equal(replay.ok, true); assert.deepEqual(replay.result, execution);
  const recovered = await evaluate(`window.studio.workforce.result(${JSON.stringify({ mission_id: execution.mission_id, run_id: execution.run_id })})`);
  assert.equal(recovered.ok, true); assert.deepEqual(recovered.result, execution);
  const afterReplay = await rpc({ command: 'inspect', mission_id: execution.mission_id });
  assert.equal(afterReplay.events.filter(event => event.event_type === 'execution.completed').length, 1);
  assert.equal(afterReplay.events.filter(event => event.event_type === 'workforce.result.committed').length, 1);
  const conflict = await evaluate(`window.studio.workforce.run(${JSON.stringify({ ...replayRequest, input: { ...input, plans_text: 'Division 03\nConcrete 999 CY' } })})`);
  assert.equal(conflict.ok, false, 'A repeated request UUID with different input must fail closed.');
  assert.deepEqual(await rpc({ command: 'inspect', mission_id: execution.mission_id }), afterReplay);
  checks.push('Committed output is retrievable; same-request retry returns one execution receipt and changed-input replay is rejected');

  const journalBeforeLoss = await evaluate('window.studio.conversations.list()');
  const conversationBeforeLoss = journalBeforeLoss.result.conversations.find(session => session.messages.some(message => message.evidence?.workforce_run?.run_id === execution.run_id));
  assert.ok(conversationBeforeLoss);
  const userCountBeforeLoss = conversationBeforeLoss.messages.filter(message => message.role === 'user').length;
  discardNextWorkforceResponse = true;
  await evaluate('document.getElementById("yc-workforce-run").click()');
  await waitFor(contents, 'document.getElementById("yc-workforce-status").textContent.includes("Run again with the same text") && !document.getElementById("yc-workforce-run").disabled', 45000);
  assert.equal(lostResponses, 1); assert.ok(lostExecution?.run_id);
  assert.notEqual(lostExecution.request_id, execution.request_id, 'An explicit new run after completion gets a new request UUID.');
  assert.notEqual(lostExecution.mission_id, execution.mission_id, 'Distinct requests must have separate missions so a previous terminal mission cannot wedge the next run.');
  const lostMission = await rpc({ command: 'inspect', mission_id: lostExecution.mission_id });
  assert.equal(lostMission.status, 'completed', 'Response loss must occur after actual worker execution and commit.');
  assert.equal(lostMission.events.filter(event => event.event_type === 'execution.completed').length, 1);
  assert.equal(lostMission.events.filter(event => event.event_type === 'workforce.result.committed').length, 1);
  const journalUncertain = await evaluate('window.studio.conversations.list()');
  const conversationUncertain = journalUncertain.result.conversations.find(session => session.id === conversationBeforeLoss.id);
  const uncertainRequest = conversationUncertain.messages.find(message => message.id === lostExecution.request_id);
  assert.equal(uncertainRequest.evidence.workforce_request_status, 'uncertain');
  assert.equal(uncertainRequest.evidence.workforce_request.request_id, lostExecution.request_id);
  assert.deepEqual(uncertainRequest.evidence.workforce_request.input, input);
  assert.equal(conversationUncertain.messages.filter(message => message.role === 'user').length, userCountBeforeLoss + 1);
  await evaluate('document.getElementById("yc-workforce-run").click()');
  await waitFor(contents, 'document.getElementById("yc-workforce-status").textContent.includes("2 quantity lines") && !document.getElementById("yc-workforce-run").disabled', 45000);
  assert.deepEqual(JSON.parse(await evaluate('document.getElementById("yc-workforce-output").textContent')), lostExecution, 'Same-form retry must recover the original committed response.');
  const journalRecovered = await evaluate('window.studio.conversations.list()');
  const conversationRecovered = journalRecovered.result.conversations.find(session => session.id === conversationBeforeLoss.id);
  assert.equal(conversationRecovered.messages.filter(message => message.role === 'user').length, userCountBeforeLoss + 1, 'Recovery must reuse the original user request, not append another.');
  assert.equal(conversationRecovered.messages.find(message => message.id === lostExecution.request_id).evidence.workforce_request_status, 'completed');
  assert.equal(conversationRecovered.messages.filter(message => message.evidence?.workforce_run?.run_id === lostExecution.run_id).length, 1);
  assert.deepEqual(await rpc({ command: 'inspect', mission_id: lostExecution.mission_id }), lostMission, 'Recovery must not add another execution or commit event.');
  assert.deepEqual(await rpc({ command: 'inspect', mission_id: pendingMissionId }), before);
  assert.equal(requests.length, 1);
  recoveryVerified = true;
  checks.push('Lost response after real commit persists an uncertain request; same-form retry recovers its receipt without duplicate execution or user message, and a new UUID uses a distinct mission');
  await evaluate('document.getElementById("yc-workforce-result").scrollIntoView({block:"center"})');
  await capture(contents, 'recovered-quantity');

  const unbound = await evaluate(`window.studio.workforce.run(${JSON.stringify({ ...replayRequest, code: 'oracle', expected_sha256: profileDigest, request_id: randomUUID() })})`);
  assert.equal(unbound.ok, false, 'A source profile without an admitted binding cannot execute.');
  put('agents/hatch_quantity.py', reviewedQuantity.source + '\n# Source changed after selection.\n');
  const changed = await evaluate(`window.studio.workforce.run(${JSON.stringify({ ...replayRequest, request_id: randomUUID() })})`);
  assert.equal(changed.ok, false, 'Changed donor revision must not inherit the reviewed execution admission.');
  assert.deepEqual(await rpc({ command: 'inspect', mission_id: execution.mission_id }), afterReplay);
  assert.deepEqual(await rpc({ command: 'inspect', mission_id: pendingMissionId }), before);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.existsSync(path.join(workforceRoot, '__pycache__')), false);
  assert.ok(!JSON.stringify(requests).includes(forbidden));
  assert.deepEqual(rendererErrors, []); assert.deepEqual(blocked, []);
  checks.push('Unbound profiles and changed source revisions cannot execute; donor tripwires remain inert and no external requests occur');
  finish();
}

app.on('browser-window-created', (_event, window) => {
  if (testWindow) return;
  testWindow = window; window.hide(); window.setSkipTaskbar(true); window.setSize(1440, 960);
  const contents = window.webContents; contents.setBackgroundThrottling(false);
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { blocked.push(details.url); callback({ cancel: true }); });
  contents.on('preload-error', (_event, _preload, error) => rendererErrors.push(error.message));
  contents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') rendererErrors.push(String(detail.message).slice(0, 400)); });
  contents.once('did-finish-load', () => run(window).catch(async error => { try { await capture(contents, 'failure'); } catch {} finish(error); }));
});
fixture.on('error', error => finish(error));
fixture.listen(0, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin;
  require('../src/main.js');
});
