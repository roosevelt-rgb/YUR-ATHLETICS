// Native independent acceptance: real installed gateway/transport/UI; synthetic providers only.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { startModelFixture } = require('./fixtures/rc6-approval-model.cjs');
const evidence = path.resolve(__dirname, '../../..', 'evidence/glider-rc6/comprehensive/approval-native-2026-10-05');
fs.mkdirSync(evidence, { recursive: true });
if (fs.existsSync(path.join(evidence, 'native-receipt.json')) || fs.existsSync(path.join(evidence, 'native-failure.json'))) {
  const archive = path.join(evidence, 'prior-' + new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(archive);
  for (const entry of fs.readdirSync(evidence, { withFileTypes: true })) if (entry.isFile()) fs.copyFileSync(path.join(evidence, entry.name), path.join(archive, entry.name));
}
const sourceNames = ['main.js', 'preload.js', 'glider-frame.js', 'glider-frame.css', 'rc6-observer-view.js', 'rc6-observer-view.css', 'rc6-transport.js', 'coding-console-policy.js', 'glider-rc6-binding.json', 'construction-v1-binding.json'];
const sourceHashes = () => Object.fromEntries(sourceNames.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../src', name))).digest('hex')]));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc6-native-approval-'));
const counter = path.join(profile, 'provider-calls.jsonl'), pidFile = path.join(profile, 'provider-pids.jsonl');
const canary = 'SYNTHETIC_RC6_CANARY_' + crypto.randomBytes(16).toString('hex');
const canaryPath = path.join(profile, 'approval-acceptance.awareness'); fs.writeFileSync(canaryPath, canary);
const nodeExe = process.env.YUR_APPROVAL_TEST_NODE;
assert.ok(nodeExe && fs.existsSync(nodeExe), 'Set YUR_APPROVAL_TEST_NODE to an existing node.exe');
const mcpConfig = path.join(profile, 'mcp_servers.json');
fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'yur-knowledge': { command: nodeExe, args: [path.join(__dirname, 'fixtures/rc6-approval-mcp.cjs'), canaryPath, counter, pidFile], enabled: true } } }, null, 2));
const expectedDigest = 'af79aeeede5f6e31dddca91809c1e7de504d4284994a2f2f0fbc03890071e8a2';
const events = [], wire = [], modelRequests = [], checks = [], rawWaiters = new Map(), children = [];
let model, currentChild, currentTransport, windowRef, finalized = false, deadline;
const receipt = { started_at: new Date().toISOString(), profile, expected_gateway_sha256: expectedDigest, source_before: sourceHashes(), checks, limitations: ['Synthetic local model and knowledge provider; no model-quality or cloud-provider claim.', 'This checks read approval; Commit Service write acceptance is separate.', 'Test-only spawn dependency overrides the isolated MCP registry; installed configuration is untouched.'] };
const eventValue = (key, value) => /^(reasoning|thinking)(?:_|$)/i.test(key) ? undefined : value;
const count = () => fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
function save(name, value) { fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, eventValue, 2)); }
function rawRpc(method, params) {
  const id = 'acceptance-raw-' + crypto.randomBytes(6).toString('hex');
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { rawWaiters.delete(id); reject(new Error('Raw RPC timed out: ' + method)); }, 30000); rawWaiters.set(id, message => { clearTimeout(timer); resolve(message); }); currentChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
async function finish(error) {
  if (finalized) return; finalized = true; clearTimeout(deadline);
  receipt.source_after = sourceHashes(); receipt.source_changed = sourceNames.filter(name => receipt.source_before[name] !== receipt.source_after[name]);
  if (!error && receipt.source_changed.length) error = new Error('Product sources changed during acceptance: ' + receipt.source_changed.join(', '));
  receipt.completed_at = new Date().toISOString(); receipt.passed = !error; receipt.provider_calls = count();
  if (error) receipt.error = error.stack || String(error);
  try { if (windowRef && !windowRef.isDestroyed()) receipt.final_ui = await windowRef.webContents.executeJavaScript('document.getElementById("rc6-log")?.textContent || document.body.textContent'); } catch {}
  save(error ? 'native-failure.json' : 'native-receipt.json', receipt); save('gateway-events.json', events); save('gateway-wire.json', wire); save('synthetic-model-requests.json', modelRequests);
  if (fs.existsSync(counter)) fs.copyFileSync(counter, path.join(evidence, 'provider-calls.jsonl'));
  currentTransport?.stop(); for (const child of children) if (child.exitCode === null) child.kill();
  if (fs.existsSync(pidFile)) for (const row of fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean)) { try { const item = JSON.parse(row); if (item.script === path.join(__dirname, 'fixtures/rc6-approval-mcp.cjs')) process.kill(item.pid); } catch {} }
  model?.close(); console.log(JSON.stringify({ passed: !error, error: error?.message, checks, provider_calls: count(), profile, evidence }));
  setTimeout(() => app.exit(error ? 1 : 0), 250);
}
async function nativeTest(win) {
  windowRef = win;
  const evaluate = code => win.webContents.executeJavaScript(code);
  const wait = async (predicate, label, milliseconds = 90000) => { const end = Date.now() + milliseconds; while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Acceptance timed out: ' + label); };
  const waitUi = (code, label, ms) => wait(() => evaluate(code), label || code, ms);
  const capture = async name => { try { const shot = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }), new Promise((_, reject) => setTimeout(() => reject(new Error('Capture timed out')), 5000))]); fs.writeFileSync(path.join(evidence, name + '.png'), shot.toPNG()); } catch (error) { (receipt.capture_errors ||= []).push(error.message); } };
  const session = async () => { const reply = wire.filter(item => item.direction === 'out' && item.message.result?.session_id).at(-1); return reply?.message.result.session_id; };
  const connect = async () => {
    await evaluate('document.getElementById("glider-coding").click()');
    await waitUi(`!document.getElementById('rc6-model').disabled && Array.from(document.getElementById('rc6-model').options).some(o=>o.value===${JSON.stringify('ollama:' + model.model)})`, 'fixture model catalog refreshed and enabled');
    await evaluate(`(()=>{const picker=document.getElementById('rc6-model'); picker.value=${JSON.stringify('ollama:' + model.model)}; picker.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('rc6-connect').click(); return true;})()`);
    await waitUi('!document.getElementById("rc6-new").disabled', 'real gateway connected');
    await evaluate('document.getElementById("rc6-new").click()');
    await waitUi('!document.getElementById("rc6-prompt").disabled', 'real session created');
    return session();
  };
  const request = async label => {
    const start = events.length;
    await evaluate(`document.getElementById('rc6-prompt').value=${JSON.stringify('Acceptance case ' + label + ': read synthetic awareness key approval-acceptance once. Use the knowledge tool only. No file changes.')}; document.querySelector('#rc6-panel form').requestSubmit(); true`);
    await wait(() => events.slice(start).some(event => event.payload?.kind === 'ApprovalRequest'), 'installed gateway ApprovalRequest: ' + label);
    const challenge = events.slice(start).find(event => event.payload?.kind === 'ApprovalRequest');
    await waitUi('document.querySelectorAll(".rc6-approval button:not(:disabled)").length >= 2', 'native approval card');
    assert.ok(challenge.payload.argument_digest); assert.ok(challenge.payload.authority_envelope.envelope_id);
    assert.equal(challenge.payload.tool.name, 'mcp_yur_knowledge_read_awareness');
    assert.equal(challenge.payload.destination.model, model.model);
    const card = await evaluate(`(()=>{const cards=[...document.querySelectorAll('.rc6-approval')];const card=cards[cards.length-1], log=document.getElementById('rc6-log').getBoundingClientRect();return {open:card.querySelector('details')?.open,text:card.innerText,log:{top:log.top,bottom:log.bottom},buttons:[...card.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {top:r.top,bottom:r.bottom}})};})()`);
    assert.equal(card.open, false, 'Exact approval JSON starts collapsed'); assert.ok(card.text.includes(challenge.payload.request_id));
    for (const button of card.buttons) assert.ok(button.top >= card.log.top && button.bottom <= card.log.bottom, 'Approval decision must be visible within transcript: ' + JSON.stringify(card));
    (receipt.approval_layouts ||= []).push({ label, ...card });
    return { start, challenge, payload: challenge.payload, sessionId: challenge.session_id || challenge.payload.session_id };
  };
  const decisionParams = (attempt, choice = 'approve') => ({ session_id: attempt.sessionId, request_id: attempt.payload.request_id, choice, argument_digest: attempt.payload.argument_digest, destination_model: attempt.payload.destination.model, authority_envelope_id: attempt.payload.authority_envelope.envelope_id });
  const done = async attempt => { await wait(() => events.slice(attempt.start).some(event => event.type === 'message.complete'), 'turn completes'); await waitUi('!document.getElementById("rc6-send").disabled', 'Send recovers'); };
  try {
    assert.ok(await evaluate('!!document.querySelector(".splash-core")'));
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await evaluate('setTimeout(()=>window.studio.launch.enter(),25); true'); await loaded;
    await waitUi('!!document.getElementById("glider-coding")', 'shared desktop loaded');
    const firstSession = await connect(); receipt.runtime = currentTransport.status(); receipt.session_id = firstSession;
    const denied = await request('deny'); assert.equal(count(), 0); await capture('deny-pending');
    await evaluate('Array.from(document.querySelectorAll(".rc6-approval button:not(:disabled)")).find(b=>b.textContent==="Deny").click()');
    await done(denied); assert.equal(count(), 0);
    const denial = events.slice(denied.start).find(event => event.type === 'approval.denied')?.payload.receipt;
    assert.equal(denial?.approved, false); assert.equal(denial?.data_read, false); assert.equal(denial?.execution_count, 0);
    assert.equal(JSON.stringify(modelRequests).includes(canary), false); checks.push('Native deny: real request, provider accesses zero, no canary sent to model, denial receipt zero executions');
    const approved = await request('approve'); assert.equal(count(), 0); await capture('approve-pending');
    await evaluate('Array.from(document.querySelectorAll(".rc6-approval button:not(:disabled)")).find(b=>b.textContent==="Approve this request once").click()');
    await done(approved); assert.equal(count(), 1);
    const completed = events.slice(approved.start).find(event => event.type === 'approval.receipt')?.payload.receipt;
    assert.equal(completed?.approved, true); assert.equal(completed?.data_read, true); assert.equal(completed?.execution_count, 1); assert.equal(completed?.validation, 'passed');
    assert.equal(modelRequests.filter(item => item.result?.includes(canary)).length, 1);
    const realDecision = wire.find(item => item.direction === 'in' && item.message.method === 'approval.respond' && item.message.params?.request_id === approved.payload.request_id);
    assert.deepEqual(realDecision?.message.params, decisionParams(approved));
    checks.push('Native approve: immutable request decision, provider accesses exactly one, canary returned once, validated one-shot receipt');
    await capture('approved-receipt');
    await assert.rejects(evaluate(`window.studio.rc6.approval(${JSON.stringify(approved.sessionId)},${JSON.stringify(approved.payload.request_id)},'approve')`), /already answered|absent/);
    const replay = await rawRpc('approval.respond', decisionParams(approved)); assert.equal(replay.result.classification, 'approval_duplicate_or_replayed'); assert.equal(count(), 1); receipt.replay = replay;
    checks.push('UI transport and actual installed gateway reject duplicate approval; provider count remains one');
    const altered = await request('altered-digest');
    const rejected = await rawRpc('approval.respond', { ...decisionParams(altered), argument_digest: 'altered-digest' });
    assert.equal(rejected.result.classification, 'approval_decision_rejected'); await done(altered); assert.equal(count(), 1); receipt.scope_rejection = rejected;
    checks.push('Actual gateway rejects altered argument digest before provider access');
    await evaluate('document.getElementById("rc6-disconnect").click()'); await wait(() => !currentTransport.status().running, 'disconnect');
    const secondSession = await connect(); assert.notEqual(secondSession, firstSession);
    await assert.rejects(evaluate(`window.studio.rc6.approval(${JSON.stringify(approved.sessionId)},${JSON.stringify(approved.payload.request_id)},'approve')`), /does not belong/);
    const reconnectReplay = await rawRpc('approval.respond', { ...decisionParams(approved), session_id: secondSession });
    assert.equal(reconnectReplay.result.classification, 'approval_unknown_or_replayed'); assert.equal(count(), 1); receipt.reconnect_rejection = reconnectReplay;
    checks.push('Reconnect rejects old session and old gateway approval; no extra provider access');
    receipt.denial_receipt = denial; receipt.approval_receipt = completed;
    const provenance = path.join(currentTransport.status().profile, 'authority/provenance/approval-events.jsonl');
    assert.ok(fs.existsSync(provenance)); fs.copyFileSync(provenance, path.join(evidence, 'approval-provenance.jsonl'));
    checks.push('Redacted approval provenance survives gateway restart in isolated profile');
    await finish();
  } catch (error) { await finish(error); }
}
(async () => {
  model = await startModelFixture(item => modelRequests.push(item));
  process.env.YUR_GLIDER_RC6 = '1'; process.env.YUR_HARNESS_AUTOSTART = '0'; process.env.YUR_OLLAMA_URL = model.origin;
  process.env.YUR_GLIDER_MODEL = model.model; process.env.YUR_GLIDER_PROVIDER_URL = model.origin + '/v1';
  process.env.YUR_DESKTOP_HOME = path.join(profile, 'desktop'); process.env.YUR_FACTORY_HOME = path.join(profile, 'factory');
  app.setPath('userData', path.join(profile, 'electron')); app.disableHardwareAcceleration();
  const moduleRef = require('../src/rc6-transport'), originalCreate = moduleRef.createRc6Transport;
  moduleRef.createRc6Transport = options => {
    const transport = originalCreate({ ...options, expectedDigest, spawnProcess(executable, args, spawnOptions) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), expectedDigest);
      const child = spawn(executable, args, { ...spawnOptions, env: { ...spawnOptions.env, YUR_MCP_CONFIG_PATHS_JSON: JSON.stringify([mcpConfig]), CUSTOM_API_KEY: 'synthetic-local-fixture', OPENAI_API_KEY: 'synthetic-local-fixture', YUR_AWARENESS_DIR: path.join(profile, 'unused-awareness'), YUR_SQLITE_PATH: path.join(profile, 'unused-synthetic.db') } });
      currentChild = child; children.push(child);
      const write = child.stdin.write.bind(child.stdin); child.stdin.write = (chunk, ...args) => { try { wire.push({ direction: 'in', message: JSON.parse(String(chunk)) }); } catch {} return write(chunk, ...args); };
      readline.createInterface({ input: child.stdout }).on('line', line => { try { const message = JSON.parse(line); if (message.id != null) { wire.push({ direction: 'out', message }); const resolve = rawWaiters.get(message.id); if (resolve) { rawWaiters.delete(message.id); resolve(message); } } } catch {} });
      child.stderr.on('data', data => fs.appendFileSync(path.join(profile, 'gateway-stderr.log'), data));
      return child;
    }, onEvent(event) { events.push(event); options.onEvent?.(event); } });
    currentTransport = transport; return transport;
  };
  app.on('browser-window-created', (_event, win) => { win.webContents.setBackgroundThrottling(false); win.setFocusable(false); win.setOpacity(0); win.setPosition(-16000, -16000); win.setSkipTaskbar(true); win.webContents.once('did-finish-load', () => nativeTest(win)); });
  deadline = setTimeout(() => finish(new Error('Native approval acceptance exceeded 6 minutes')), 360000);
  require('../src/main.js');
})().catch(finish);
