'use strict';

// Real Electron renderer/preload/main, source adapter, and CommitService journal.
// Only the model is a deterministic HTTP fixture. Donor content is never executed.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-copilot-smoke-'));
const libraryRoot = path.join(home, 'awesome-copilot fixture');
const relativeSkill = 'skills/source-review/SKILL.md';
const skillFile = path.join(libraryRoot, relativeSkill);
const marker = 'COPILOT_SELECTED_BODY_91c81';
const bodyOnly = 'BODY_ONLY_NOT_JOURNALED_74aba';
const secret = 'EXCLUDED_FIXTURE_SECRET_1d2fa';
const executionSentinel = path.join(home, 'DONOR_SCRIPT_EXECUTED');
const skillText = `---\nname: 'Source Review'\ndescription: 'Read source evidence and explain the result.'\nlicense: MIT\n---\n# Source Review\nThe selected guidance marker is ${marker}.\nInternal fixture body marker: ${bodyOnly}.\nApply source-specific review guidance. A bundled [helper](scripts/run.py) is available.\n`;
function put(relative, content) {
  const target = path.join(libraryRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
put('package.json', JSON.stringify({ name: 'awesome-copilot', version: '1.0.0', license: 'MIT', repository: { url: 'https://github.com/github/awesome-copilot.git' } }));
put('LICENSE', 'MIT License\n\nCopyright GitHub, Inc.\n\nPermission is hereby granted to use this fixture.\n');
put(relativeSkill, skillText);
put('skills/source-review/scripts/run.py', `from pathlib import Path\nPath(${JSON.stringify(executionSentinel)}).write_text('executed')\n`);
put('instructions/python.instructions.md', "---\ndescription: 'Prefer explicit Python interfaces.'\napplyTo: '**/*.py'\n---\nUse descriptive names.\n");
for (let index = 0; index < 33; index += 1) {
  put(`agents/helper-${String(index).padStart(2, '0')}.agent.md`, `---\nname: 'Helper ${index}'\ndescription: 'Fixture agent profile ${index}.'\n---\nExplain verified source details.\n`);
}
put('.env', `PRIVATE_VALUE=${secret}\n`);
put('hooks/excluded.md', `Do not load ${secret}.`);
const sourceDigest = createHash('sha256').update(skillText).digest('hex');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.setPath('userData', path.join(home, 'electron'));
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal');
process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.YUR_COPILOT_LIBRARY = libraryRoot;
process.env.APPDATA = path.join(home, 'appdata');
const checks = [], requests = [], rendererErrors = [], blocked = [];
const screenshots = {};
let finished = false, testWindow = null;
const started = Date.now();
const fixture = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/api/health') return reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: [{ name: 'copilot-fixture', kind: 'fixture' }] });
  if (request.url === '/api/tags') return reply(200, { models: [] });
  if (request.method !== 'POST' || request.url !== '/api/ask') return reply(404, { error: 'Unknown fixture route.' });
  let body = '';
  request.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 300000) request.destroy(); });
  request.on('end', () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    const query = String(payload.query || '');
    const selected = query.includes('SELECTED_COPILOT_INSTRUCTIONS') && query.includes(marker) && query.includes(bodyOnly);
    reply(200, { answer: selected ? `Selected source review guidance applied: ${marker}.` : 'Ordinary response without selected library instructions.', provider: 'copilot-smoke-fixture', model: 'copilot-fixture' });
  });
});

const deadline = setTimeout(() => finish(new Error('Copilot smoke exceeded its deadline.')), 90000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline); fixture.closeAllConnections(); fixture.close();
  const report = { ok: !error, verification: 'native-desktop-copilot-library-fixture', ...(error ? { error: error.message } : {}), checks, renderer_errors: rendererErrors, blocked_external_requests: blocked, model_fixture_requests: requests.length, screenshots, elapsed_ms: Date.now() - started, test_home: home };
  fs.writeFileSync(path.join(home, 'copilot-smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
  app.exit(error ? 1 : 0);
}
async function waitFor(contents, expression, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
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
      const target = path.join(home, `copilot-${name}.png`);
      fs.writeFileSync(target, screenshot.toPNG()); screenshots[name] = target; return;
    } catch (error) { if (attempt === 2 || !error.message.includes('UnknownVizError')) throw error; }
  }
}

async function run(window) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  const send = async text => {
    await waitFor(contents, 'Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
    const previous = await evaluate('document.querySelectorAll("#yc-messages .yc-message").length');
    await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(text)}; document.getElementById('yc-form').requestSubmit();`);
    await waitFor(contents, `document.querySelectorAll('#yc-messages .yc-message').length >= ${previous + 2} && !document.getElementById('yc-send').disabled`, 25000);
  };
  await waitFor(contents, 'Boolean(window.studio?.copilot && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  const outside = await evaluate('window.studio.copilot.catalog({root:"C:/"})');
  assert.equal(outside.ok, false, 'Renderer requests cannot replace the operator-configured library root.');
  const unsupported = await evaluate('window.studio.copilot.acquire({path:"skills/source-review/scripts/run.py"})');
  assert.equal(unsupported.ok, false, 'Linked donor scripts are not executable or instruction acquisition targets.');
  checks.push('Trusted IPC fixes the library root and rejects linked script acquisition');

  await evaluate('document.querySelector(\'[data-workspace="tools"]\').click(); document.getElementById("yc-library-toggle").click();');
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 30 && !document.getElementById("yc-library-more").classList.contains("yc-hidden")');
  assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode")'), true);
  await evaluate('document.getElementById("yc-library-more").click()');
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 35 && document.getElementById("yc-library-more").classList.contains("yc-hidden")');
  await evaluate('document.getElementById("yc-library-kind").value = "instruction"; document.getElementById("yc-library-kind").dispatchEvent(new Event("change"));');
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 1 && document.getElementById("yc-section-resources").textContent.includes("Python")');
  checks.push('Capabilities loads actual library resources, paginates 30 to 35, and filters instruction type inside the current UI');

  await evaluate('document.getElementById("yc-library-kind").value = "skill"; document.getElementById("yc-library-kind").dispatchEvent(new Event("change")); document.getElementById("yc-section-search").value = "source-review"; document.getElementById("yc-section-search").dispatchEvent(new Event("input"));');
  await waitFor(contents, 'document.querySelectorAll("#yc-section-resources .yc-resource-card").length === 1 && document.getElementById("yc-section-resources").textContent.includes("Source Review")');
  await capture(contents, 'library');
  await evaluate('document.querySelector("#yc-section-resources .yc-resource-card").click()');
  assert.equal(await evaluate('document.querySelector("#yc-resource-detail .yc-resource-action").textContent'), 'Use in conversation');
  await evaluate('document.querySelector("#yc-resource-detail .yc-resource-action").click()');
  assert.equal(await evaluate('document.getElementById("yc-instructions").textContent.includes("Source Review") && !document.getElementById("yc-main").classList.contains("section-open")'), true);
  assert.equal(requests.length, 0, 'Browsing and selecting library guidance must not call a model.');
  checks.push('Search selects a real skill and Use in conversation attaches its instruction chip without inference');

  const question = 'Apply the selected source review guidance and identify its marker.';
  await send(question);
  assert.equal(requests.length, 1);
  const modelRequest = JSON.stringify(requests[0]);
  assert.ok(modelRequest.includes(marker) && modelRequest.includes(bodyOnly), 'The model must receive full acquired instruction content, not metadata alone.');
  assert.ok(modelRequest.includes('Copyright GitHub, Inc.') && modelRequest.includes(sourceDigest));
  assert.ok(!modelRequest.includes(secret));
  assert.equal(await evaluate(`document.querySelector('.yc-message.assistant')?.textContent.includes(${JSON.stringify(marker)})`), true);
  let history = await evaluate('window.studio.conversations.list()');
  let conversation = history.result.conversations.find(item => item.messages.some(message => message.content === question));
  assert.ok(conversation);
  let evidence = conversation.messages.map(message => message.evidence?.copilot).find(Boolean);
  assert.equal(evidence.entry.path, relativeSkill);
  assert.equal(evidence.entry.sha256, sourceDigest);
  assert.equal(evidence.provenance.operation, 'library.instructions.acquired');
  assert.equal(path.resolve(evidence.root), libraryRoot);
  assert.equal(Object.hasOwn(evidence, 'content'), false);
  assert.equal(Object.hasOwn(evidence, 'license_notice'), false);
  assert.ok(!JSON.stringify(history).includes(bodyOnly), 'Raw selected instruction body must not be persisted in conversation evidence.');
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false);
  assert.equal(fs.existsSync(executionSentinel), false);
  checks.push('Full selected instructions and attribution reach model; CommitService saves source evidence without instruction body or factory state');
  await capture(contents, 'grounded');

  const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded;
  await waitFor(contents, '!document.getElementById("yc-send").disabled');
  await waitFor(contents, `[...document.querySelectorAll('#yc-history button')].some(button => button.title === ${JSON.stringify(question)})`);
  await evaluate(`[...document.querySelectorAll('#yc-history button')].find(button => button.title === ${JSON.stringify(question)}).click()`);
  assert.equal(await evaluate('document.getElementById("yc-instructions").textContent.includes("Source Review")'), true);
  await send('Apply the same selected guidance on this follow-up.');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].query.includes(bodyOnly), 'Reloaded selection must reacquire the real instruction body for follow-up.');
  checks.push('Selection, answer and evidence survive reload; follow-up reacquires selected instructions');

  fs.writeFileSync(skillFile, skillText + '\nChanged after explicit selection.\n');
  await send('Apply the chosen guidance again after the source changed.');
  assert.equal(requests.length, 2, 'A changed selected source hash must fail before model inference.');
  assert.equal(await evaluate('document.querySelector(".yc-message.error")?.textContent.includes("changed since selection")'), true);
  assert.equal(await evaluate('document.querySelectorAll(".yc-message.assistant").length'), 2);
  checks.push('Changed instruction SHA produces a visible error and prevents model inference');

  await evaluate('document.querySelector("#yc-instructions button").click()');
  await send('Continue without selected library instructions.');
  assert.equal(requests.length, 3);
  assert.ok(!requests[2].query.includes('SELECTED_COPILOT_INSTRUCTIONS'));
  assert.ok(!requests[2].query.includes(bodyOnly));
  history = await evaluate('window.studio.conversations.list()');
  conversation = history.result.conversations.find(item => item.id === conversation.id);
  const lastUser = conversation.messages.filter(message => message.role === 'user').at(-1);
  assert.equal(lastUser.evidence.instruction_selection, null);
  assert.ok(!JSON.stringify(history).includes(bodyOnly));
  assert.ok(!JSON.stringify(requests).includes(secret));
  assert.equal(fs.existsSync(executionSentinel), false);
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false);
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(blocked, []);
  checks.push('Removing instructions stops subsequent acquisition; excluded secrets stay private and donor scripts remain unexecuted');
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
