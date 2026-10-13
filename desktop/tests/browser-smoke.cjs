'use strict';

// Real main/preload/browser UI, real native page and real conversation journal.
// Model output alone is a loopback fixture; every test write stays in this root.
const { app, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
// Capture the actual host constructed by main.js. This test-only hook exercises
// its trusted navigation command/reply path without making any model request.
const franklinModule = require('../src/franklin-host');
const createFranklinHost = franklinModule.createFranklinHost;
let franklinHost;
if (process.env.YUR_GLIDER_RC6 === '1') franklinModule.createFranklinHost = options => (franklinHost = createFranklinHost(options));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-browser-smoke-'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(home, 'electron')); process.env.APPDATA = path.join(home, 'appdata');
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot'); process.env.YUR_WORKFORCE_ROOT = path.join(home, 'unused-workforce');
const marker = 'BROWSER_SOURCE_MEASURED_37', forbidden = 'FORM_VALUE_MUST_NOT_LEAVE';
const checks = [], modelRequests = [], pageRequests = [], errors = [], screenshots = [], captures = [], navigation = [];
const monitoredFiles = ['tests/browser-smoke.cjs', 'src/main.js', 'src/preload.js', 'src/desktop-security.js',
  'src/browser-host.js', 'src/browser-view.js', 'src/franklin-host.js', 'src/conversation-view.js', 'src/conversation.css',
  'src/studio-editor.html', 'src/foundry-transport.js', 'src/generation-transport.js',
  'src/conversation-transport.js', 'foundry/conversation_cli.py', 'foundry/commit_service.py'];
const fingerprint = () => Object.fromEntries(monitoredFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')]));
const sourceBefore = fingerprint();
let testWindow, origin, otherOrigin, finished = false;
const other = http.createServer((req, res) => { pageRequests.push(`other:${req.url}`); res.end('<h1>Explicitly approved destination</h1>'); });
const site = http.createServer((req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/api/health') return reply(200, { fixture: true });
  if (req.url === '/api/models') return reply(200, { models: [{ name: 'browser-fixture' }] });
  if (req.url === '/api/tags') return reply(200, { models: [] });
  if (req.method === 'POST' && req.url === '/api/ask') {
    let body = ''; req.on('data', chunk => { body += chunk; });
    return req.on('end', () => { const request = JSON.parse(body); modelRequests.push(request);
      reply(200, { answer: String(request.query).includes(marker) ? 'The sourced page measured 37 units.' : 'No page evidence received.', provider: 'browser-loopback-fixture', model: 'browser-fixture' }); });
  }
  pageRequests.push(`site:${req.url}`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url === '/second') return res.end('<title>Second page</title><h1>Native second page</h1>');
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Measured source</title>
    <style>body{margin:0;padding:28px;background:#f7f5f1;color:#302a26;font:16px/1.6 system-ui}h1{font-size:28px;line-height:1.2}strong{font-size:40px;display:block;color:#764755}small{display:block;overflow-wrap:anywhere;color:#746b64}nav{display:flex;gap:20px;margin:24px 0}a{color:#794557}label{display:block;margin:12px 0}input,textarea{display:block;width:100%;box-sizing:border-box;font:12px/1.4 system-ui;padding:7px;border:1px solid #cabfb7;border-radius:6px}</style>
    <small>LOCAL BROWSER FIXTURE</small><h1>Measured source</h1><p>The measured quantity is <strong>37 units</strong></p>
    <p>Read the source, then use the page in your conversation.</p><nav><a id="next" href="/second">Second page</a><a id="outside" href="${otherOrigin}/approved">Other origin</a></nav>
    <small>${marker}</small><small id="boundary"></small>
    <label>Private form field — excluded from page context<input value="${forbidden}"></label><textarea aria-label="Private notes">${forbidden}</textarea><p hidden>HIDDEN_MUST_NOT_LEAVE</p>
    <script>document.getElementById('boundary').textContent='API_BOUNDARY:'+typeof window.studio+','+typeof require+','+typeof process;</script>`);
});

async function waitFor(predicate, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
}
async function capture(contents, label, expectedBounds = null) {
  await new Promise(resolve => setTimeout(resolve, 200));
  let timer;
  const image = await Promise.race([contents.capturePage(undefined, { stayHidden: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} capture exceeded 5 seconds`)), 5000); })]).finally(() => clearTimeout(timer));
  assert.equal(image.isEmpty(), false, `${label} is an actual nonempty native capture`);
  const size = image.getSize(), pixels = image.toBitmap(); let paintedPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] > 0 && Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 210) paintedPixels++;
  }
  assert.ok(paintedPixels > 300, `${label} contains visible painted content, not a blank surface`);
  if (expectedBounds) {
    const dimensions = await contents.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
    assert.equal(dimensions.width, expectedBounds.width); assert.equal(dimensions.height, expectedBounds.height);
    assert.ok(Math.abs(size.width - expectedBounds.width * dimensions.dpr) <= 1);
    assert.ok(Math.abs(size.height - expectedBounds.height * dimensions.dpr) <= 1);
  }
  const target = path.join(home, label + '.png'), png = image.toPNG(); fs.writeFileSync(target, png); screenshots.push(target);
  captures.push({ label, method: 'WebContents.capturePage', web_contents_id: contents.id, url: contents.getURL(), size, bounds: expectedBounds, owner_window: { opacity: testWindow.getOpacity(), position: testWindow.getPosition(), native_visible: testWindow.isVisible() }, painted_pixels: paintedPixels, sha256: createHash('sha256').update(png).digest('hex') });
}
async function run(window) {
  const contents = window.webContents, evaluate = code => contents.executeJavaScript(code);
  const browserState = async () => { const result = await evaluate('studio.browser.state()'); assert.equal(result.ok, true); return result.result; };
  const waitUi = (expression, label) => waitFor(() => evaluate(expression), label);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const go = async url => {
    await waitFor(async () => !(await browserState()).loading && await evaluate('!document.getElementById("yc-browser-go").disabled'), 'Go control is ready after the previous navigation');
    await evaluate(`document.getElementById('yc-browser-address').value=${JSON.stringify(url)}; document.getElementById('yc-browser-go').click()`);
    await waitFor(async () => { const state = await browserState(); return state.url === url && !state.loading; }, 'native browser URL ' + url);
  };
  await waitUi('Boolean(window.studio?.browser && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)', 'conversation runtime');
  if (process.env.YUR_GLIDER_RC6 === '1') {
    await waitUi('Boolean(document.getElementById("glider-frame"))', 'combined Glider frame');
    assert.equal((await evaluate('window.studio.integration.info()')).enabled, true);
    checks.push('Browser fixture runs inside the actual combined Glider frame');
    assert.ok(franklinHost, 'Main must construct its actual Franklin host');
    const identity = { owner: contents, request_id: randomUUID(), mission_id: randomUUID().replaceAll('-', ''), isActive: () => true };
    const before = modelRequests.length;
    for (const view of ['conversation', 'coding', 'editor', 'capabilities', 'workforce', 'deployed-agents', 'browser']) {
      const reply = await franklinHost.execute('open_view', { view }, identity);
      assert.equal(reply.view, view, `Navigation reply must preserve canonical ${view} identity`);
      const observed = await franklinHost.observe(contents);
      assert.equal(observed.navigation.view, view, `Independent snapshot must identify canonical ${view}`);
      navigation.push({ requested: view, reply: reply.view, observed: observed.navigation.view, title: observed.navigation.title });
    }
    assert.equal(modelRequests.length, before, 'Host navigation and observation must not request inference');
    await franklinHost.execute('open_view', { view: 'conversation' }, identity);
    // Conversation preserves the user's side pane. Reset it explicitly before
    // the existing browser-toggle acceptance starts from its closed state.
    await click('yc-close-details');
    await waitFor(async () => !(await browserState()).visible, 'operator closes side browser before fixture');
    checks.push('Seven canonical Franklin destinations navigate and independently report their exact view through real host/main/preload/renderer replies without inference');
  }
  const originalUrl = contents.getURL();
  await click('yc-browser-toggle');
  await waitFor(async () => (await browserState()).visible, 'blank browser becomes visible');
  await go(`${origin}/page`);
  const state = await browserState(); assert.ok(state.bounds.width > 0 && state.bounds.height > 0);
  assert.ok(state.bounds.x + state.bounds.width <= window.getContentBounds().width);
  assert.ok(state.bounds.y + state.bounds.height <= window.getContentBounds().height);
  const page = webContents.getAllWebContents().find(candidate => candidate !== contents && candidate.getURL() === `${origin}/page`);
  assert.ok(page, 'The page must be a real native WebContents, not renderer markup.');
  page.setBackgroundThrottling(false);
  assert.equal(page.getLastWebPreferences().preload, undefined); assert.equal(page.getLastWebPreferences().sandbox, true);
  const evidence = await evaluate('studio.browser.readVisiblePage()'); assert.equal(evidence.ok, true);
  assert.ok(evidence.result.text.includes(marker)); assert.ok(evidence.result.text.includes('API_BOUNDARY:undefined,undefined,undefined'));
  assert.equal(evidence.result.text.includes(forbidden), false); assert.equal(evidence.result.text.includes('HIDDEN_MUST_NOT_LEAVE'), false);
  assert.equal(evidence.result.sha256, createHash('sha256').update(evidence.result.text).digest('hex'));
  checks.push('Real main/preload/native page source, isolated APIs, visible text and form exclusion');
  assert.equal(window.getOpacity(), 0, 'Fixture owner stays transparent to the user');
  assert.ok(window.getPosition()[0] < -8000, 'Fixture owner stays offscreen');
  assert.equal(state.granted_origin, origin); assert.equal(state.visible, true);
  await capture(page, 'browser-native-page', state.bounds);
  await capture(contents, 'browser-desktop');
  checks.push('Genuine painted native Browser page captured at the same Desktop pane dimensions, with its approved URL and no composite image');

  await click('yc-browser-full-view');
  const fullView = await waitFor(async () => {
    const current = await browserState();
    return current.bounds.width > state.bounds.width + 100 && await evaluate('document.getElementById("yc-browser-full-view").getAttribute("aria-pressed") === "true"') ? current : null;
  }, 'full workspace browser viewport');
  assert.equal(await evaluate('document.getElementById("yc-main").classList.contains("browser-full-view")'), true);
  await capture(page, 'browser-full-workspace', fullView.bounds);
  await click('yc-browser-full-view');
  await waitFor(async () => (await browserState()).bounds.width < fullView.bounds.width - 100 && await evaluate('document.getElementById("yc-browser-full-view").getAttribute("aria-pressed") === "false"'), 'restored browser side pane');
  checks.push('Full view expands the actual isolated native browser viewport, then restores its side pane');

  await page.executeJavaScript("document.getElementById('next').click()", true);
  await waitFor(async () => (await browserState()).url === `${origin}/second`, 'same-origin link');
  await waitUi(`document.getElementById('yc-browser-address').value === ${JSON.stringify(`${origin}/second`)}`, 'address reflects native page navigation');
  await waitUi('!document.getElementById("yc-browser-back").disabled', 'back enabled'); await click('yc-browser-back');
  await waitFor(async () => { const state = await browserState(); return state.url === `${origin}/page` && !state.loading; }, 'UI back');
  await click('yc-browser-forward'); await waitFor(async () => (await browserState()).url === `${origin}/second`, 'UI forward');
  await go(`${origin}/page`);
  await page.executeJavaScript("document.getElementById('outside').click()", true);
  await waitFor(async () => (await browserState()).pending_url === `${otherOrigin}/approved`, 'pending origin');
  assert.equal(pageRequests.includes('other:/approved'), false);
  assert.equal(await evaluate('document.getElementById("yc-browser-address").value'), `${otherOrigin}/approved`);
  await click('yc-browser-go'); await waitFor(async () => (await browserState()).url === `${otherOrigin}/approved`, 'operator approves origin');
  assert.equal(pageRequests.includes('other:/approved'), true);
  await go(`${origin}/page`);
  checks.push('UI back/forward and same-origin browsing; off-origin page requires explicit Go');

  await click('yc-browser-use');
  await waitUi('document.getElementById("yc-attachments").textContent.includes("Page")', 'page attached to composer');
  await evaluate("document.getElementById('yc-input').value='What quantity does the attached page report?'; document.getElementById('yc-form').requestSubmit()");
  await waitUi('Boolean(document.querySelector(".yc-message.assistant")) && !document.getElementById("yc-send").disabled', 'sourced answer');
  assert.equal(modelRequests.length, 1); assert.ok(modelRequests[0].query.includes(marker)); assert.ok(modelRequests[0].query.includes('trust="untrusted-source"'));
  assert.equal(modelRequests[0].query.includes(forbidden), false);
  assert.ok((await evaluate('document.querySelector(".yc-message.assistant").textContent')).includes('37 units'));
  const journal = await evaluate('studio.conversations.list()'); assert.equal(journal.ok, true);
  const attachment = journal.result.conversations.flatMap(conversation => conversation.messages).flatMap(message => message.evidence?.attachments || []).find(item => item.source_url === `${origin}/page`);
  assert.ok(attachment, 'Page evidence must survive journal persistence.'); assert.equal(attachment.sha256, evidence.result.sha256);
  assert.equal(attachment.provenance.authority, 'context-only');
  checks.push('Use page in chat reaches selected model as untrusted context and persists source/hash through CommitService');

  await click('yc-details-tab'); await waitFor(async () => !(await browserState()).visible, 'work tab hides native view');
  await click('yc-browser-tab'); await waitFor(async () => (await browserState()).visible, 'browser tab shows native view');
  const before = (await browserState()).bounds.width;
  await evaluate("document.getElementById('yc-detail-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
  await waitFor(async () => (await browserState()).bounds.width !== before, 'keyboard pane resizing');
  await evaluate("const overlay=document.createElement('dialog'); overlay.id='browser-test-dialog'; document.body.appendChild(overlay); overlay.showModal()");
  await waitFor(async () => !(await browserState()).visible, 'modal hides native content');
  await evaluate("document.getElementById('browser-test-dialog').close(); document.getElementById('browser-test-dialog').remove()");
  await waitFor(async () => (await browserState()).visible, 'modal close restores view');
  await evaluate("document.querySelector('[data-workspace=agents]').click()");
  await waitFor(async () => !(await browserState()).visible, 'workspace section hides native view');
  assert.equal(contents.getURL(), originalUrl);
  await click('yc-back-chat'); await click('yc-browser-toggle');
  await waitFor(async () => (await browserState()).visible, 'chat/browser returns');
  window.setSize(800, 700);
  await waitFor(async () => { const state = await browserState(), bounds = window.getContentBounds(); return bounds.width <= 850 && bounds.height <= 750 && state.bounds.x + state.bounds.width <= bounds.width && state.bounds.y + state.bounds.height <= bounds.height; }, 'narrow native bounds');
  await capture(contents, 'browser-800');
  await capture(page, 'browser-native-page-800', (await browserState()).bounds);
  checks.push('Side pane/native bounds follow tabs, resize, modal visibility and same-shell workspace navigation');
  await click('yc-close-details'); await waitFor(async () => !(await browserState()).visible, 'closed pane hidden');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  checks.push('No main renderer console/preload errors');
}

async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  const sourceAfter = fingerprint(), changed = monitoredFiles.filter(file => sourceBefore[file] !== sourceAfter[file]);
  if (changed.length) error ||= new Error('Source changed during validation: ' + changed.join(', '));
  if (testWindow && !testWindow.isDestroyed()) { if (error) { try { await capture(testWindow.webContents, 'failure'); } catch {} } testWindow.destroy(); }
  await Promise.all([site, other].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  const receipt = path.join(home, 'browser-smoke-result.json');
  fs.writeFileSync(receipt, JSON.stringify({ passed: !error, verification: 'native-electron-browser-fixture', live_model_verified: false, checks, navigation, failure: error ? { message: error.message, stack: error.stack } : null, errors, model_requests: modelRequests.length, page_requests: pageRequests, screenshots, captures, source_verification: { scope: 'Explicit Browser/Franklin-host/main/UI/provider/journal files; unrelated specialist implementation excluded', before: sourceBefore, after: sourceAfter, changed } }, null, 2));
  console.log(JSON.stringify({ passed: !error, checks: checks.length, receipt, failure: error?.message || null })); app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => finish(new Error('Native browser UI smoke exceeded 75 seconds.')), 75000);
app.on('browser-window-created', (_event, window) => {
  if (testWindow) return;
  testWindow = window; window.setOpacity(0); window.setPosition(-16000, -16000); window.setSkipTaskbar(true); window.setSize(1440, 960); window.webContents.setBackgroundThrottling(false);
  window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) errors.push(`Main frame load failed (${code}): ${description} at ${url}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason} (${details.exitCode})`));
  window.webContents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') errors.push(String(detail.message).slice(0, 400)); });
  window.webContents.once('did-finish-load', () => run(window).then(() => finish()).catch(finish));
});
Promise.all([new Promise(resolve => site.listen(0, '127.0.0.1', resolve)), new Promise(resolve => other.listen(0, '127.0.0.1', resolve))]).then(() => {
  origin = `http://127.0.0.1:${site.address().port}`; otherOrigin = `http://127.0.0.1:${other.address().port}`;
  process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin;
  require('../src/main.js');
}).catch(finish);
