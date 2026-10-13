'use strict';

// Uses the real Desktop renderer/preload/main, Python repository reader and
// conversation journal. Only model responses and the native folder chooser are
// fixtures. --live-local additionally checks the real installed local model.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');

const live = process.argv.includes('--live-local');
const sourceRoot = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-repository-smoke-'));
const repositoryRoot = path.join(home, 'sample_repo with spaces');
const alpha = 'REPO_SOURCE_ALPHA_95e';
const beta = 'REPO_SOURCE_BETA_82c';
const forbidden = 'FAKE_FORBIDDEN_SECRET_dbb024';
const packageName = 'yur-repository-context-fixture';
const sourceFile = path.join(repositoryRoot, 'src', 'index.js');
const sourceText = marker => `// Public fixture source.\nexport const SOURCE_MARKER = '${marker}';\nexport function entry() { return SOURCE_MARKER; }\n`;
fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
fs.mkdirSync(path.join(repositoryRoot, 'node_modules'));
fs.mkdirSync(path.join(repositoryRoot, '.cache'));
fs.writeFileSync(path.join(repositoryRoot, 'package.json'), JSON.stringify({ name: packageName, main: 'src/index.js', version: '1.0.0' }, null, 2));
fs.writeFileSync(path.join(repositoryRoot, 'README.md'), '# Repository context fixture\n\nRead package.json for identity and src/index.js for SOURCE_MARKER.\n');
fs.writeFileSync(sourceFile, sourceText(alpha));
fs.writeFileSync(path.join(repositoryRoot, '.env'), `PRIVATE_VALUE=${forbidden}\n`);
fs.writeFileSync(path.join(repositoryRoot, 'credentials.json'), JSON.stringify({ token: forbidden }));
fs.writeFileSync(path.join(repositoryRoot, 'node_modules', 'excluded.js'), forbidden);
fs.writeFileSync(path.join(repositoryRoot, '.cache', 'excluded.txt'), forbidden);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.setPath('userData', path.join(home, 'electron'));
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal');
process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.APPDATA = path.join(home, 'appdata');
let folderDialogCalls = 0;
dialog.showOpenDialog = async (_window, options = {}) => {
  assert.ok(options.properties?.includes('openDirectory'), 'Only the repository folder chooser may be opened.');
  folderDialogCalls += 1;
  return { canceled: false, filePaths: [repositoryRoot] };
};

const checks = [], requests = [], rendererErrors = [], blocked = [];
const screenshots = {};
let finished = false, testWindow = null;
const started = Date.now();
const fixture = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/api/health') return live ? reply(503, { error: 'The fixture does not verify a live YUR harness.' }) : reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: live ? [] : [{ name: 'repository-fixture', kind: 'fixture' }] });
  if (request.url === '/api/tags') return reply(200, { models: [] });
  if (request.method !== 'POST' || request.url !== '/api/ask') return reply(404, { error: 'Unknown fixture route.' });
  let body = '';
  request.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 300000) request.destroy(); });
  request.on('end', () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    const query = String(payload.query || '');
    const marker = query.includes(beta) ? beta : query.includes(alpha) ? alpha : null;
    const answer = marker ? `Repository package ${packageName}; entry src/index.js; SOURCE_MARKER=${marker}.` : 'ORDINARY_CHAT_READY: no repository source supplied.';
    reply(200, { answer, provider: 'repository-smoke-fixture', model: 'repository-fixture' });
  });
});

const deadline = setTimeout(() => finish(new Error('Repository smoke exceeded its deadline.')), live ? 180000 : 90000);
function finish(error, result = {}) {
  if (finished) return;
  finished = true; clearTimeout(deadline); fixture.closeAllConnections(); fixture.close();
  const report = { ok: !error, verification: live ? 'native-desktop-live-local-repository' : 'native-desktop-repository-fixture', ...(error ? { error: error.message } : {}), checks, renderer_errors: rendererErrors, blocked_external_requests: blocked, model_fixture_requests: requests.length, folder_dialog_calls: folderDialogCalls, screenshots, ...result, elapsed_ms: Date.now() - started, test_home: home };
  fs.writeFileSync(path.join(home, 'repository-smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
  app.exit(error ? 1 : 0);
}
async function waitFor(contents, expression, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const notice = await contents.executeJavaScript('document.getElementById("yc-notice")?.textContent || document.querySelector(".yc-message.error")?.textContent || ""');
  throw new Error(`Timed out: ${expression}. ${notice}`);
}
async function capture(contents, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const screenshot = await contents.capturePage(undefined, { stayHidden: true });
      assert.equal(screenshot.isEmpty(), false);
      const target = path.join(home, `repository-${name}.png`);
      fs.writeFileSync(target, screenshot.toPNG()); screenshots[name] = target; return;
    } catch (error) { if (attempt === 2 || !error.message.includes('UnknownVizError')) throw error; }
  }
}

async function run(window) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  const send = async message => {
    await waitFor(contents, 'Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
    const previous = await evaluate('document.querySelectorAll("#yc-messages .yc-message").length');
    await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(message)}; document.getElementById('yc-form').requestSubmit();`);
    await waitFor(contents, `document.querySelectorAll('#yc-messages .yc-message').length >= ${previous + 2} && !document.getElementById('yc-send').disabled`, live ? 140000 : 25000);
  };
  const selectHistory = async title => {
    const selector = `[...document.querySelectorAll('#yc-history button')].find(button => button.title.startsWith(${JSON.stringify(title)}))`;
    await waitFor(contents, `Boolean(${selector})`); await evaluate(`${selector}.click()`);
  };
  const newChat = () => evaluate('document.getElementById("yc-new-chat").click()');
  await waitFor(contents, 'Boolean(window.studio?.repository && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');

  if (live) {
    const target = process.env.YUR_TEST_LOCAL_MODEL || 'llama3.2:latest';
    const tags = await evaluate('window.studio.ollama.tags()');
    const model = tags.models?.find(item => item.name === target);
    assert.ok(model && !model.remote_host && !/cloud/i.test(model.name), 'Live repository smoke requires the selected installed local model.');
    await waitFor(contents, `Array.from(document.getElementById('yc-model').options).some(option => option.value === ${JSON.stringify('ollama:' + target)})`);
    await evaluate(`document.getElementById('yc-model').value = ${JSON.stringify('ollama:' + target)}; document.getElementById('yc-model').dispatchEvent(new Event('change'));`);
    await send(`Read this local repository's package.json. Give the exact package name and main entry file from the supplied source. Do not run commands. Repository: ${sourceRoot}`);
    const answer = await evaluate('document.querySelector(".yc-message.assistant .yc-prose")?.textContent || ""');
    const expected = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    assert.ok(answer.includes(expected.name) && answer.includes(expected.main), `Local model did not return grounded package fields: ${answer}`);
    const history = await evaluate('window.studio.conversations.list()');
    const repositoryEvidence = history.result.conversations.flatMap(session => session.messages).map(message => message.evidence?.repository).find(Boolean);
    assert.equal(path.resolve(repositoryEvidence.root), sourceRoot);
    assert.ok(repositoryEvidence.files.some(file => file.path === 'package.json'));
    assert.equal(requests.length, 0, 'The live answer must not come from the model fixture.');
    checks.push('Actual local model answered package name and entry from repository acquisition, with saved source evidence');
    await capture(contents, 'live-local');
    return finish(null, { model: target, answer, repository_root: sourceRoot });
  }

  assert.deepEqual(await evaluate('window.studio.repository.context({message:"Hello, ordinary chat.", root:null})'), { ok: true, result: null });
  await send('Say hello without using a repository.');
  assert.ok(requests[0].query.includes('Say hello'));
  assert.ok(!JSON.stringify(requests[0]).includes(alpha));
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false, 'An ordinary chat must not create repository/factory state.');
  checks.push('Ordinary chat returns no repository context and does not start repository storage');

  await newChat();
  const question = `Can you read this repo and tell me its package name, main entry and SOURCE_MARKER? ${repositoryRoot}`;
  await send(question);
  assert.equal(requests.length, 2, 'Typed repository request must reach model inference once.');
  assert.ok(requests[1].query.includes(alpha) && requests[1].query.includes(packageName) && requests[1].query.includes('src/index.js'), 'Model must receive acquired source, not just a folder path.');
  assert.ok(!JSON.stringify(requests).includes(forbidden), 'Excluded fixture secrets must never reach the model.');
  assert.equal(await evaluate(`document.querySelector('.yc-message.assistant')?.textContent.includes(${JSON.stringify(alpha)})`), true);
  assert.equal(await evaluate(`(() => { const badge = document.getElementById('yc-repository'); return badge && badge.textContent.includes(${JSON.stringify(path.basename(repositoryRoot))}) && getComputedStyle(badge).display !== 'none'; })()`), true);
  let history = await evaluate('window.studio.conversations.list()');
  let session = history.result.conversations.find(item => item.messages.some(message => message.content === question));
  const firstEvidence = session.messages.map(message => message.evidence?.repository).find(Boolean);
  assert.ok(firstEvidence && firstEvidence.operation_id && firstEvidence.files.length > 0);
  assert.equal(path.resolve(firstEvidence.root), repositoryRoot);
  assert.equal(firstEvidence.access, 'read-only');
  const firstSource = firstEvidence.files.find(file => file.path === 'src/index.js');
  assert.equal(firstSource.sha256, createHash('sha256').update(sourceText(alpha)).digest('hex'));
  assert.ok(!JSON.stringify(firstEvidence).includes(forbidden));
  await capture(contents, 'grounded');
  checks.push('Typed absolute repo path with spaces acquires actual source before inference, shows badge, and journals source hashes');

  fs.writeFileSync(sourceFile, sourceText(beta));
  await send('Read the repository again. What is SOURCE_MARKER now?');
  assert.ok(requests.at(-1).query.includes(beta), 'Follow-up must reread changed source.');
  assert.equal(await evaluate(`[...document.querySelectorAll('.yc-message.assistant')].at(-1)?.textContent.includes(${JSON.stringify(beta)})`), true);
  history = await evaluate('window.studio.conversations.list()');
  session = history.result.conversations.find(item => item.id === session.id);
  const refreshedEvidence = session.messages.map(message => message.evidence?.repository).filter(Boolean).at(-1);
  assert.equal(refreshedEvidence.files.find(file => file.path === 'src/index.js').sha256, createHash('sha256').update(sourceText(beta)).digest('hex'));
  const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded;
  await waitFor(contents, '!document.getElementById("yc-send").disabled');
  await selectHistory('Can you read this repo');
  assert.equal(await evaluate(`document.getElementById('yc-messages').textContent.includes(${JSON.stringify(beta)})`), true);
  assert.equal(await evaluate(`document.getElementById('yc-repository').textContent.includes(${JSON.stringify(path.basename(repositoryRoot))})`), true);
  checks.push('Follow-up rereads changed source; answer, context badge and acquisition evidence survive reload');

  await newChat();
  const beforeMissing = requests.length;
  await send(`Can you read this repo: ${path.join(home, 'missing repository')}`);
  assert.equal(requests.length, beforeMissing, 'A missing repository must fail before model inference.');
  assert.equal(await evaluate('document.querySelectorAll(".yc-message.assistant").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll(".yc-message.error").length'), 1);
  checks.push('Missing repository produces a visible error and prevents model inference');

  await newChat();
  await evaluate('document.querySelector(\'button[aria-label="Attach repository"]\').click()');
  await waitFor(contents, `document.getElementById('yc-repository').textContent.includes(${JSON.stringify(path.basename(repositoryRoot))})`);
  await send('Read the attached repository package and SOURCE_MARKER.');
  assert.equal(folderDialogCalls, 1);
  assert.ok(requests.at(-1).query.includes(beta));
  assert.ok(!JSON.stringify(requests).includes(forbidden));
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(blocked, []);
  checks.push('Native Attach repository uses the same bounded reader; forbidden fixture files never enter model context');
  await capture(contents, 'attached');
  finish(null, { repository_root: repositoryRoot, acquisition_operation: refreshedEvidence.operation_id });
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
  process.env.YUR_FOUNDRY_URL = origin;
  if (!live) process.env.YUR_OLLAMA_URL = origin;
  else {
    const service = new URL(process.env.YUR_OLLAMA_URL || 'http://127.0.0.1:11434');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(service.hostname)) return finish(new Error('Live repository smoke requires a loopback Ollama service.'));
  }
  require('../src/main.js');
});
