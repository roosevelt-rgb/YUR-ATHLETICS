'use strict';

// Real Electron renderer, preload, main process, versioned Hermes snapshot,
// Python adapter, and conversation journal. Only model inference is a fixture.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-hermes-smoke-'));
const selectedPath = 'skills/research/research-paper-writing/SKILL.md';
const instructionProof = 'End-to-end pipeline for producing publication-ready ML/AI research papers';
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.setPath('userData', path.join(home, 'electron'));
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal');
process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.APPDATA = path.join(home, 'appdata');

const checks = [], requests = [], rendererErrors = [], blocked = [], screenshots = {};
let finished = false, testWindow = null;
const started = Date.now();
const fixture = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/api/health') return reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: [{ name: 'hermes-fixture', kind: 'fixture' }] });
  if (request.url === '/api/tags') return reply(200, { models: [] });
  if (request.method !== 'POST' || request.url !== '/api/ask') return reply(404, { error: 'Unknown fixture route.' });
  let body = '';
  request.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 500000) request.destroy(); });
  request.on('end', () => {
    const payload = JSON.parse(body); requests.push(payload);
    const query = String(payload.query || '');
    const grounded = query.includes('SELECTED_HERMES_SKILL') && query.includes(instructionProof) && query.includes('research-paper-writing');
    reply(200, { answer: grounded ? 'Verified Hermes research-paper-writing guidance reached the model fixture.' : 'Hermes guidance missing.', provider: 'hermes-smoke-fixture', model: 'hermes-fixture' });
  });
});

const deadline = setTimeout(() => finish(new Error('Hermes smoke exceeded its deadline.')), 120000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline); fixture.closeAllConnections(); fixture.close();
  const report = { ok: !error, verification: 'native-desktop-versioned-hermes-skills', ...(error ? { error: error.message } : {}), checks, renderer_errors: rendererErrors, blocked_external_requests: blocked, model_fixture_requests: requests.length, screenshots, elapsed_ms: Date.now() - started, test_home: home };
  fs.writeFileSync(path.join(home, 'hermes-smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
  app.exit(error ? 1 : 0);
}
async function waitFor(contents, expression, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const detail = await contents.executeJavaScript('document.getElementById("yc-notice")?.textContent || document.getElementById("yc-catalog-note")?.textContent || ""');
  throw new Error(`Timed out: ${expression}. ${detail}`);
}
async function capture(contents, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const screenshot = await contents.capturePage(undefined, { stayHidden: true });
      assert.equal(screenshot.isEmpty(), false);
      const target = path.join(home, `hermes-${name}.png`);
      fs.writeFileSync(target, screenshot.toPNG()); screenshots[name] = target; return;
    } catch (error) { if (attempt === 2 || !error.message.includes('UnknownVizError')) throw error; }
  }
}

async function run(window) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  await waitFor(contents, 'Boolean(window.studio?.hermes && document.getElementById("yc-hermes-toggle") && !document.getElementById("yc-send").disabled)');
  const outside = await evaluate('window.studio.hermes.catalog({root:"C:/",query:"",lane:"",limit:30,offset:0})');
  assert.equal(outside.ok, false, 'The renderer cannot redirect the versioned Hermes root.');
  const support = await evaluate(`window.studio.hermes.acquire({path:${JSON.stringify('skills/research/research-paper-writing/templates/README.md')},expected_sha256:${JSON.stringify('0'.repeat(64))}})`);
  assert.equal(support.ok, false, 'Support files cannot be acquired as executable instruction targets.');
  checks.push('Trusted IPC fixes the YUR snapshot root and rejects support-file acquisition');

  await evaluate('document.querySelector(\'[data-workspace="tools"]\').click(); document.getElementById("yc-hermes-toggle").click();');
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 30 && document.getElementById("yc-catalog-note").textContent.includes("177 skills")');
  assert.equal(await evaluate('document.getElementById("yc-catalog-note").textContent.includes("774 skill support files")'), true);
  assert.equal(await evaluate('document.getElementById("yc-catalog-note").textContent.includes("27 package files")'), true);
  await evaluate('document.getElementById("yc-library-kind").value = "optional"; document.getElementById("yc-library-kind").dispatchEvent(new Event("change")); document.getElementById("yc-section-search").value = "fastmcp"; document.getElementById("yc-section-search").dispatchEvent(new Event("input"));');
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 1 && document.getElementById("yc-section-resources").textContent.includes("fastmcp")');
  checks.push('Capabilities exposes the complete snapshot count and filters the optional source lane');

  await evaluate('document.getElementById("yc-library-kind").value = "active"; document.getElementById("yc-library-kind").dispatchEvent(new Event("change")); document.getElementById("yc-section-search").value = "research-paper-writing"; document.getElementById("yc-section-search").dispatchEvent(new Event("input"));');
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 1 && document.getElementById("yc-section-resources").textContent.includes("Research Paper Writing")');
  await capture(contents, 'library');
  await evaluate('document.querySelector("#yc-section-resources .yc-resource-card").click()');
  assert.equal(await evaluate('document.querySelector("#yc-resource-detail").textContent.includes("support files") && document.querySelector("#yc-resource-detail").textContent.includes("manifest")'), true);
  await evaluate('document.querySelector("#yc-resource-detail .yc-resource-action").click()');
  assert.equal(await evaluate('document.getElementById("yc-instructions").textContent.includes("Research Paper Writing") && !document.getElementById("yc-main").classList.contains("section-open")'), true);
  assert.equal(requests.length, 0);
  checks.push('A real active skill shows its versioned support manifest and attaches without inference');

  const question = 'Use the selected research paper skill and confirm the grounded pipeline.';
  const previous = await evaluate('document.querySelectorAll("#yc-messages .yc-message").length');
  await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(question)}; document.getElementById('yc-form').requestSubmit();`);
  await waitFor(contents, `document.querySelectorAll('#yc-messages .yc-message').length >= ${previous + 2} && !document.getElementById('yc-send').disabled`, 40000);
  assert.equal(requests.length, 1);
  const modelRequest = JSON.stringify(requests[0]);
  assert.ok(modelRequest.includes('SELECTED_HERMES_SKILL') && modelRequest.includes(instructionProof));
  assert.ok(modelRequest.includes('Foundry, OrchestrationManager, Validation and Commit Service retain authority'));
  assert.equal(await evaluate('document.querySelector(".yc-message.assistant")?.textContent.includes("Verified Hermes")'), true);
  const history = await evaluate('window.studio.conversations.list()');
  const conversation = history.result.conversations.find(item => item.messages.some(message => message.content === question));
  assert.ok(conversation);
  const evidence = conversation.messages.map(message => message.evidence?.hermes).find(Boolean);
  assert.equal(evidence.entry.path, selectedPath);
  assert.equal(evidence.identity.version, '0.18.2');
  assert.match(evidence.snapshot_id, /^[a-f0-9]{64}$/);
  assert.ok(evidence.support_assets_verified > 0);
  assert.equal(evidence.support_assets_verified, evidence.entry.support_files);
  assert.equal(evidence.provenance.operation, 'hermes.instructions.acquired');
  assert.equal(Object.hasOwn(evidence, 'content'), false);
  assert.equal(Object.hasOwn(evidence, 'support_assets'), false);
  assert.ok(!JSON.stringify(history).includes(instructionProof), 'Raw Hermes instruction bodies must not be persisted in conversation evidence.');
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false, 'Read-only Hermes acquisition must not open Commit Service state.');
  checks.push('Full verified instructions reach the model while the journal stores bounded source and support proof only');
  await capture(contents, 'grounded');

  const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded;
  await waitFor(contents, '!document.getElementById("yc-send").disabled');
  await waitFor(contents, `[...document.querySelectorAll('#yc-history button')].some(button => button.title === ${JSON.stringify(question)})`);
  await evaluate(`[...document.querySelectorAll('#yc-history button')].find(button => button.title === ${JSON.stringify(question)}).click()`);
  assert.equal(await evaluate('document.getElementById("yc-instructions").textContent.includes("Research Paper Writing")'), true);
  const count = await evaluate('document.querySelectorAll("#yc-messages .yc-message").length');
  await evaluate(`document.getElementById('yc-input').value = 'Use the same verified Hermes skill again.'; document.getElementById('yc-form').requestSubmit();`);
  await waitFor(contents, `document.querySelectorAll('#yc-messages .yc-message').length >= ${count + 2} && !document.getElementById('yc-send').disabled`, 40000);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].query.includes(instructionProof));
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(blocked, []);
  checks.push('Selection and evidence survive reload, and follow-up reacquires the hash-verified snapshot');
  finish();
}

app.on('browser-window-created', (_event, window) => {
  if (testWindow) return;
  testWindow = window; window.hide(); window.setSkipTaskbar(true); window.setSize(1440, 960);
  const contents = window.webContents; contents.setBackgroundThrottling(false);
  contents.once('render-process-gone', (_event, detail) => finish(new Error(`Hermes renderer exited before verification (${detail.reason}; exit ${detail.exitCode}).`)));
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
