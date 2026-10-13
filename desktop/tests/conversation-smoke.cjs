'use strict';

// Native Electron fixture verification, not a live YUR harness acceptance test.
// The real main process, preload and conversation journal are used. Network
// responses come only from the ephemeral HTTP fixture below; no user state is read.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-conversation-smoke-'));
const startedAt = Date.now();
const checks = [];
const requests = [];
const blockedRequests = [];
const rendererErrors = [];
const rendererErrorDetails = [];
const previewDiagnostics = [];
const screenshots = {};
const journalRoot = path.join(testHome, 'journal');
const invalidJournalRoot = path.join(testHome, 'invalid-journal-file');
fs.writeFileSync(invalidJournalRoot, 'Isolated fixture used to simulate unavailable journal storage.');
const studioFixtureRoot = path.join(testHome, 'studio-files');
fs.mkdirSync(studioFixtureRoot);
const studioOpenPath = path.join(studioFixtureRoot, 'studio-open-fixture.md');
const studioSavePath = path.join(studioFixtureRoot, 'studio-saved-fixture.md');
let nextSavePath = studioSavePath;
let terminalVerification = null;
let ownedTestPtyId = null;
const studioOpenContent = '# Native file fixture\n\nRead this through the real desktop file bridge.\n';
fs.writeFileSync(studioOpenPath, studioOpenContent);
const dialogCalls = [];
// Only the native chooser is substituted. The existing main/preload file IO,
// Monaco editor, models, tab state, dirty tracking and save path remain real.
dialog.showOpenDialog = async (_window, options = {}) => {
  const folder = options.properties?.includes('openDirectory');
  dialogCalls.push(folder ? 'open-folder' : 'open-file');
  return { canceled: false, filePaths: [folder ? studioFixtureRoot : studioOpenPath] };
};
dialog.showSaveDialog = async () => {
  dialogCalls.push('save');
  return { canceled: false, filePath: nextSavePath };
};
let finished = false;
let delayedReply = null;
let saveFailureReply = null;
let testWindow = null;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(testHome, 'electron'));
// Any shell history produced by this test stays inside its temporary profile.
process.env.APPDATA = path.join(testHome, 'appdata');
process.env.YUR_DESKTOP_HOME = journalRoot;
process.env.YUR_FACTORY_HOME = path.join(testHome, 'factory');

const fixture = http.createServer((request, response) => {
  const send = (status, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'GET' && request.url === '/api/health') return send(200, { fixture: true, stats: {} });
  if (request.method === 'GET' && request.url === '/api/models') return send(200, { models: [{ name: 'fixture-model', kind: 'fixture' }] });
  if (request.method === 'GET' && request.url === '/api/tags') return send(200, { models: [] });
  if (request.method !== 'POST' || request.url !== '/api/ask') return send(404, { error: 'Unknown fixture route.' });
  let encoded = '';
  request.on('data', chunk => { encoded += chunk; if (encoded.length > 300000) request.destroy(); });
  request.on('end', () => {
    let body;
    try { body = JSON.parse(encoded); } catch { return send(400, { error: 'Invalid fixture JSON.' }); }
    requests.push(body);
    const query = String(body.query || '');
    const answer = query.includes('SMOKE_SAVE_FAILURE') ? 'SMOKE_SAVE_READY: fixture response awaiting a successful journal retry.'
      : query.includes('SMOKE_DELAY') ? 'SMOKE_DELAY_READY: fixture response for the earlier conversation.'
      : query.includes('SMOKE_FAST') ? 'SMOKE_FAST_READY: fixture response for the active conversation.'
        : 'SMOKE_CONTEXT_READY: the attached fixture says delivery_date = 2026-09-12. <img src="https://example.invalid/fixture.png" onerror="window.__fixtureInjected=true">';
    const payload = { answer, provider: 'smoke-fixture', model: body.model || 'fixture-auto', sources: [{ id: 'fixture-document', source: 'isolated test fixture' }], mission_id: 'fixture-mission-not-live' };
    if (query.includes('SMOKE_SAVE_FAILURE')) {
      saveFailureReply = () => { process.env.YUR_DESKTOP_HOME = invalidJournalRoot; send(200, payload); };
      return;
    }
    if (query.includes('SMOKE_FAILURE')) return send(503, { error: 'Deliberate fixture failure.' });
    if (query.includes('SMOKE_DELAY')) { delayedReply = () => send(200, payload); return; }
    send(200, payload);
  });
});

const deadline = setTimeout(() => finish(new Error('Conversation fixture smoke exceeded 120 seconds.')), 120000);

async function finish(error, result = {}) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  fixture.closeAllConnections?.();
  fixture.close();
  if (ownedTestPtyId && testWindow && !testWindow.isDestroyed()) {
    await Promise.race([
      testWindow.webContents.executeJavaScript(`window.studio.terminal.kill(${ownedTestPtyId})`).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    ownedTestPtyId = null;
  }
  const rendererRejections = testWindow && !testWindow.isDestroyed()
    ? await Promise.race([
      testWindow.webContents.executeJavaScript('window.__smokeRejections || []').catch(() => []),
      new Promise(resolve => setTimeout(() => resolve([]), 1000)),
    ]) : [];
  const report = {
    ok: !error,
    verification: 'native-electron-local-fixture',
    live_harness_verified: false,
    ...(error ? { error: error.message } : {}),
    checks,
    renderer_errors: rendererErrors,
    renderer_error_details: rendererErrorDetails,
    renderer_rejections: rendererRejections,
    preview_diagnostics: previewDiagnostics,
    blocked_external_requests: blockedRequests,
    fixture_requests: requests.length,
    screenshots,
    ...result,
    elapsed_ms: Date.now() - startedAt,
    test_home: testHome,
  };
  fs.writeFileSync(path.join(testHome, 'conversation-smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  app.exit(error ? 1 : 0);
}

async function waitFor(contents, expression, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const notice = await contents.executeJavaScript('document.getElementById("yc-notice")?.textContent || ""').catch(() => 'renderer unavailable');
  throw new Error(`Timed out: ${expression}. Notice: ${notice}`);
}

async function waitForFrameText(contents, marker) {
  try {
    await waitFor(contents, `(() => { const frame = document.getElementById('html-preview'); const rect = frame?.getBoundingClientRect(); return Boolean(frame?.srcdoc.includes(${JSON.stringify(marker)}) && window.__smokePreviewText?.includes(${JSON.stringify(marker)}) && rect.width > 0 && rect.height > 0 && !frame.sandbox.contains('allow-same-origin')); })()`, 10000);
  } catch (error) {
    const frame = await contents.executeJavaScript(`(() => { const frame = document.getElementById('html-preview'); const rect = frame.getBoundingClientRect(); return {src: frame.src, srcdoc: frame.srcdoc, renderedMessage: window.__smokePreviewText, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height}; })()`);
    previewDiagnostics.push({ marker, ...frame, frame_urls: contents.mainFrame.frames.map(frame => frame.url) });
    throw error;
  }
}

async function capture(contents, name) {
  const target = path.join(testHome, `conversation-${name}.png`);
  let image;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Hidden Electron windows can report UnknownVizError until a new layout
    // has composited. Preserve screenshot verification with bounded retries.
    await new Promise(resolve => setTimeout(resolve, 120));
    try { image = await contents.capturePage(undefined, { stayHidden: true }); break; }
    catch (error) {
      if (!String(error.message).includes('UnknownVizError') || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.equal(image.isEmpty(), false, 'Screenshot must contain a rendered page.');
  fs.writeFileSync(target, image.toPNG());
  screenshots[name] = target;
}

async function runSmoke(window) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  const captureRejections = () => evaluate(`
    window.__smokeRejections = []; window.__smokePreviewText = '';
    window.addEventListener('unhandledrejection', event => { const reason = event.reason; window.__smokeRejections.push({name: reason?.name, message: String(reason?.message || reason), stack: String(reason?.stack || '').slice(0, 8000)}); });
    window.addEventListener('message', event => { if (event.source === document.getElementById('html-preview')?.contentWindow && event.data?.type === 'studio-preview-smoke' && typeof event.data.text === 'string') window.__smokePreviewText = event.data.text; });
  `);
  await captureRejections();
  const send = async text => {
    await waitFor(contents, 'Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
    await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(text)}; document.getElementById('yc-form').requestSubmit();`);
  };
  const selectHistory = async title => {
    const expression = `[...document.querySelectorAll('#yc-history button')].find(button => button.title.startsWith(${JSON.stringify(title)}))`;
    await waitFor(contents, `Boolean(${expression})`);
    await evaluate(`${expression}.click()`);
  };

  await waitFor(contents, 'Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  await waitFor(contents, 'Boolean([...document.getElementById("yc-model").options].find(option => option.value === "foundry:fixture-model"))');
  const preferences = contents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode") && document.querySelector(".yc-heading").textContent.includes("build")'), true);
  assert.equal(await evaluate('document.querySelectorAll(".yc-message").length'), 0);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  assert.deepEqual(blockedRequests, [], 'Conversation startup must not request external resources.');
  // Chromium needs an initial composite before capturing a never-shown window.
  await new Promise(resolve => setTimeout(resolve, 1500));
  await capture(contents, 'empty');
  checks.push('conversation default, empty layout, isolated preload, startup without CDN requests');

  window.setSize(800, 700);
  await waitFor(contents, 'window.innerWidth === 800 && window.innerHeight === 700');
  assert.equal(await evaluate(`['yc-input', 'yc-send'].every(id => { const rect = document.getElementById(id).getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })`), true, 'Composer and send button must remain within the smaller viewport.');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".yc-sidebar")).visibility === "hidden"'), true);
  await evaluate('document.getElementById("yc-sidebar-toggle").click()');
  await waitFor(contents, 'getComputedStyle(document.querySelector(".yc-sidebar")).visibility === "visible" && document.getElementById("yc-sidebar-toggle").getAttribute("aria-expanded") === "true"');
  await evaluate('document.getElementById("yc-sidebar-toggle").click()');
  await waitFor(contents, 'getComputedStyle(document.querySelector(".yc-sidebar")).visibility === "hidden" && document.getElementById("yc-sidebar-toggle").getAttribute("aria-expanded") === "false"');
  await capture(contents, 'responsive-800x700');
  window.setSize(1440, 960);
  await waitFor(contents, 'window.innerWidth === 1440 && window.innerHeight === 960');
  checks.push('800x700 composer visibility and responsive sidebar toggle');

  await evaluate('document.getElementById("yc-input").value = "SMOKE_DRAFT: keep my unsent idea"; document.getElementById("yc-new-chat").click()');
  await selectHistory('Draft · SMOKE_DRAFT');
  assert.equal(await evaluate('document.getElementById("yc-input").value'), 'SMOKE_DRAFT: keep my unsent idea');
  assert.equal(await evaluate('document.querySelectorAll(".yc-message").length'), 0);
  checks.push('unsent draft remains discoverable and retains its input after switching');

  await evaluate(`
    const model = document.getElementById('yc-model'); model.value = 'foundry:fixture-model'; model.dispatchEvent(new Event('change'));
    const transfer = new DataTransfer(); transfer.items.add(new File(['Fixture document. delivery_date = 2026-09-12.'], 'fixture-context.txt', {type:'text/plain'}));
    const input = document.getElementById('yc-file-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  `);
  await waitFor(contents, 'document.querySelectorAll(".yc-attachment").length === 1');
  await send('SMOKE_CONTEXT: summarize my fixture document <script>window.__fixtureInjected=true</script>');
  await waitFor(contents, 'document.querySelector(".yc-message.assistant")?.textContent.includes("SMOKE_CONTEXT_READY") && !document.getElementById("yc-send").disabled');
  assert.equal(requests[0].model, 'fixture-model');
  assert.equal(requests[0].provider, 'auto');
  assert.ok(requests[0].query.includes('fixture-context.txt') && requests[0].query.includes('delivery_date = 2026-09-12'));
  assert.equal(await evaluate('document.querySelector("#yc-messages img, #yc-messages script") === null && window.__fixtureInjected === undefined'), true);
  const firstJournal = await evaluate('window.studio.conversations.list()');
  assert.equal(firstJournal.ok, true);
  const firstConversation = firstJournal.result.conversations.find(item => item.title.startsWith('SMOKE_CONTEXT'));
  assert.ok(firstConversation && firstConversation.revision > 0);
  assert.equal(firstConversation.messages.find(message => message.role === 'assistant').evidence.mission_id, 'fixture-mission-not-live');
  await evaluate('document.getElementById("yc-context-toggle").click()');
  assert.equal(await evaluate('document.getElementById("yc-detail-body").textContent.includes("fixture-mission-not-live")'), true);
  await evaluate('document.getElementById("yc-close-details").click()');
  checks.push('selected model, attached file, real ask IPC, journal commit, safe text, returned evidence');

  await evaluate('document.getElementById("yc-new-chat").click()');
  await send('SMOKE_DELAY: reply to this earlier conversation only.');
  const delayDeadline = Date.now() + 15000;
  while (!delayedReply && Date.now() < delayDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(typeof delayedReply, 'function', 'The delayed fixture request must reach the real transport.');
  await evaluate('document.getElementById("yc-new-chat").click()');
  await send('SMOKE_FAST: keep this conversation separate.');
  await waitFor(contents, 'document.querySelector(".yc-message.assistant")?.textContent.includes("SMOKE_FAST_READY") && !document.getElementById("yc-send").disabled');
  delayedReply();
  await waitFor(contents, `(async () => { const journal = await window.studio.conversations.list(); return journal.ok && journal.result.conversations.some(item => item.title.startsWith('SMOKE_DELAY') && item.messages.some(message => message.content.includes('SMOKE_DELAY_READY'))); })()`);
  assert.equal(await evaluate('document.getElementById("yc-thread-title").textContent.startsWith("SMOKE_FAST") && !document.getElementById("yc-messages").textContent.includes("SMOKE_DELAY_READY")'), true);
  await selectHistory('SMOKE_DELAY');
  assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("SMOKE_DELAY_READY") && !document.getElementById("yc-messages").textContent.includes("SMOKE_FAST_READY")'), true);
  checks.push('new conversation during pending reply retains correct session association');

  await evaluate('document.getElementById("yc-new-chat").click()');
  await send('SMOKE_FAILURE: report this deliberate backend failure.');
  await waitFor(contents, 'document.querySelector(".yc-message.error")?.textContent.includes("503") && !document.getElementById("yc-send").disabled');
  assert.equal(await evaluate('document.querySelectorAll(".yc-message.assistant").length'), 0);
  checks.push('HTTP failure appears as an error, without a success message');

  process.env.YUR_DESKTOP_HOME = invalidJournalRoot;
  const loaded = new Promise(resolve => contents.once('did-finish-load', resolve));
  contents.reload();
  await loaded;
  await captureRejections();
  await waitFor(contents, 'document.getElementById("yc-retry-journal") && !document.getElementById("yc-retry-journal").classList.contains("yc-hidden") && !document.getElementById("yc-retry-journal").disabled && document.getElementById("yc-send").disabled');
  assert.equal(await evaluate('document.getElementById("yc-retry-journal").textContent'), 'Retry history');
  process.env.YUR_DESKTOP_HOME = journalRoot;
  await evaluate('document.getElementById("yc-retry-journal").click()');
  await waitFor(contents, 'document.getElementById("yc-send") && !document.getElementById("yc-send").disabled && document.querySelectorAll("#yc-history .yc-history-item").length === 4');
  assert.equal(await evaluate('document.getElementById("yc-retry-journal").classList.contains("yc-hidden")'), true);
  checks.push('history load failure disables sending and recovers through Retry history');
  await selectHistory('SMOKE_CONTEXT');
  assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("SMOKE_CONTEXT_READY") && document.getElementById("yc-messages").textContent.includes("fixture-context.txt")'), true);
  assert.equal(await evaluate('document.querySelector("#yc-messages img, #yc-messages script") === null && window.__fixtureInjected === undefined'), true);
  let journal = await evaluate('window.studio.conversations.list()');
  assert.equal(journal.ok, true);
  assert.equal(journal.result.conversations.length, 4);
  assert.deepEqual(blockedRequests, [], 'Chat and history must remain independent of external resources.');
  checks.push('four conversations, model, attachments and safe response survive page reload');

  await evaluate('document.getElementById("yc-new-chat").click()');
  await send('SMOKE_SAVE_FAILURE: preserve my answer if background storage fails.');
  const saveFailureDeadline = Date.now() + 15000;
  while (!saveFailureReply && Date.now() < saveFailureDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(typeof saveFailureReply, 'function');
  await evaluate(`
    document.getElementById('yc-new-chat').click();
    window.__smokeBackgroundHistoryRefresh = false;
    const observer = new MutationObserver(() => { window.__smokeBackgroundHistoryRefresh = true; observer.disconnect(); });
    observer.observe(document.getElementById('yc-history'), {childList: true});
  `);
  saveFailureReply();
  await waitFor(contents, 'window.__smokeBackgroundHistoryRefresh === true');
  await selectHistory('SMOKE_SAVE_FAILURE');
  await waitFor(contents, 'document.getElementById("yc-notice").textContent.startsWith("Conversation not saved:") && document.getElementById("yc-retry-journal").textContent === "Retry save"');
  assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("SMOKE_SAVE_READY")'), true);
  await evaluate('document.getElementById("yc-context-toggle").click()');
  assert.equal(await evaluate('document.getElementById("yc-detail-body").textContent.includes("latest changes not saved")'), true);
  process.env.YUR_DESKTOP_HOME = journalRoot;
  await evaluate('document.getElementById("yc-retry-journal").click()');
  await waitFor(contents, 'document.getElementById("yc-notice").classList.contains("yc-hidden") && document.getElementById("yc-detail-body").textContent.includes("saved locally") && !document.getElementById("yc-send").disabled');
  journal = await evaluate('window.studio.conversations.list()');
  assert.equal(journal.ok, true);
  assert.equal(journal.result.conversations.length, 5);
  assert.ok(journal.result.conversations.find(item => item.title.startsWith('SMOKE_SAVE_FAILURE')).messages.some(message => message.role === 'assistant' && message.content.includes('SMOKE_SAVE_READY')));
  await evaluate('document.getElementById("yc-close-details").click()');
  checks.push('background final-save failure survives switching, shows unsaved status, and retries successfully');
  await selectHistory('SMOKE_CONTEXT');

  const conversationUrl = contents.getURL();
  const navigationDraft = 'SMOKE_NAV_DRAFT: retain this unsent follow-up while I browse my workspace.';
  const conversationMessages = await evaluate('[...document.querySelectorAll("#yc-messages .yc-message")].map(message => message.textContent)');
  await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(navigationDraft)}; document.getElementById('yc-input').dispatchEvent(new Event('input', {bubbles:true}));`);
  for (const [section, heading] of [['agents', 'Agents'], ['tools', 'Capabilities'], ['workflows', 'Workflows'], ['vault', 'Cognitive Vault']]) {
    await evaluate(`document.querySelector('#yur-conversation [data-workspace="${section}"]').click()`);
    await waitFor(contents, `(() => { const panel = document.getElementById('yc-section-panel'); return panel?.dataset.section === '${section}' && getComputedStyle(panel).display !== 'none' && panel.getBoundingClientRect().height > 0; })()`);
    assert.equal(contents.getURL(), conversationUrl, `${heading} must remain in the original document.`);
    assert.equal(contents.getTitle(), 'YUR AI Desktop', `${heading} must retain the desktop document title.`);
    assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode")'), true, `${heading} must keep the conversation shell.`);
    assert.equal(await evaluate(`(() => { const sidebar = document.querySelector('#yur-conversation .yc-sidebar'); const rect = sidebar.getBoundingClientRect(); return getComputedStyle(sidebar).visibility === 'visible' && getComputedStyle(sidebar).display !== 'none' && rect.width > 0 && rect.height > 0; })()`), true, `${heading} must keep workspace navigation visible.`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#yc-section-panel h1, #yc-section-panel h2')].some(node => node.textContent.trim() === ${JSON.stringify(heading)})`), true, `${heading} must have a visible section heading.`);
    assert.equal(await evaluate('getComputedStyle(document.getElementById("yc-back-chat")).display !== "none"'), true);
    if (section === 'agents') {
      await waitFor(contents, 'document.getElementById("yc-built-toggle").getAttribute("aria-pressed") === "true" && document.getElementById("yc-catalog-note").textContent.startsWith("0 saved builds") && Boolean(document.getElementById("yc-create-first-specialist"))');
      assert.equal(await evaluate('document.querySelectorAll("#yc-section-panel .yc-resource-card").length'), 0, 'A fresh fixture must not invent saved agents.');
      assert.equal(await evaluate('document.getElementById("yc-create-first-specialist").getBoundingClientRect().height > 0'), true, 'The empty saved-agent library must offer creation.');
      await evaluate('document.getElementById("yc-agent-libraries").open = true; document.getElementById("yc-profiles-toggle").click();');
      await waitFor(contents, 'document.getElementById("yc-built-toggle").getAttribute("aria-pressed") === "false" && document.querySelectorAll("#yc-section-panel .yc-resource-card").length > 0');
      const resourceCount = await evaluate('document.querySelectorAll("#yc-section-panel .yc-resource-card").length');
      assert.ok(resourceCount > 0, 'Workspace profiles must show the existing resource definitions.');
      await evaluate(`document.getElementById('yc-section-search').value = 'SMOKE_NO_MATCH_9b7d_workspace'; document.getElementById('yc-section-search').dispatchEvent(new Event('input', {bubbles:true}));`);
      assert.equal(await evaluate('[...document.querySelectorAll("#yc-section-panel .yc-resource-card")].filter(card => getComputedStyle(card).display !== "none" && card.getBoundingClientRect().height > 0).length'), 0, 'An unmatched search must hide all resource cards.');
      assert.equal(await evaluate(`(() => { const empty = document.querySelector('#yc-section-panel .yc-section-empty'); return Boolean(empty && getComputedStyle(empty).display !== 'none' && empty.getBoundingClientRect().height > 0); })()`), true, 'An unmatched search must show an empty result state.');
      await evaluate(`document.getElementById('yc-section-search').value = ''; document.getElementById('yc-section-search').dispatchEvent(new Event('input', {bubbles:true}));`);
      assert.equal(await evaluate('[...document.querySelectorAll("#yc-section-panel .yc-resource-card")].filter(card => getComputedStyle(card).display !== "none" && card.getBoundingClientRect().height > 0).length'), resourceCount, 'Clearing search must restore the resource list.');
      checks.push('Agents opens the empty saved-agent library; Workspace profiles search filters resource definitions and clearing search restores them');
    }
    await capture(contents, `section-${section}`);
    if (section === 'agents') {
      window.setSize(800, 700);
      await waitFor(contents, 'window.innerWidth === 800 && window.innerHeight === 700');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Agents must fit the smaller viewport without horizontal scrolling.');
      assert.equal(await evaluate(`['yc-section-search', 'yc-back-chat'].every(id => { const rect = document.getElementById(id).getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })`), true, 'Agents search and Back must remain visible at 800x700.');
      await capture(contents, 'responsive-agents-800x700');
      window.setSize(1440, 960);
      await waitFor(contents, 'window.innerWidth === 1440 && window.innerHeight === 960');
      checks.push('Agents section fits 800x700 with usable search and return controls');
    }
    if (section === 'tools' || section === 'vault') await selectHistory('SMOKE_CONTEXT');
    else await evaluate('document.getElementById("yc-back-chat").click()');
    await waitFor(contents, 'getComputedStyle(document.getElementById("yc-section-panel")).display === "none"');
    assert.equal(contents.getURL(), conversationUrl);
    assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode")'), true);
    assert.equal(await evaluate('document.getElementById("yc-input").value'), navigationDraft, `Returning from ${heading} must preserve the unsent draft.`);
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#yc-messages .yc-message")].map(message => message.textContent)'), conversationMessages, `Returning from ${heading} must preserve conversation messages.`);
  }
  checks.push('Agents, Capabilities, Workflows and Cognitive Vault stay in the conversation shell; Back and recent history preserve draft and messages');
  assert.deepEqual(blockedRequests, [], 'Same-shell workspace sections must not request external editor resources.');

  const studioCommand = command => evaluate(`document.querySelector('#yc-studio-panel [data-studio-command="${command}"]').click()`);
  const openStudio = async () => {
    await evaluate('document.querySelector(\'#yur-conversation [data-workspace="files"]\').click()');
    await waitFor(contents, `document.getElementById('yc-main').classList.contains('studio-open') && getComputedStyle(document.getElementById('yc-studio-panel')).display !== 'none' && document.getElementById('yc-studio-panel').getBoundingClientRect().height > 0`);
    assert.equal(await evaluate('document.getElementById("yc-intelliflow-coding-tab").getAttribute("aria-pressed")'), 'true', 'IntelliFlow opens its coding workspace by default.');
    await evaluate('document.getElementById("yc-intelliflow-files-tab").click()');
    await waitFor(contents, `(() => { const body = document.querySelector('#yc-studio-panel .yc-studio-body'); const toolbar = document.getElementById('yc-studio-editor-toolbar'); return document.getElementById('yc-intelliflow-files-tab').getAttribute('aria-pressed') === 'true' && !body.hidden && !toolbar.hidden && body.getBoundingClientRect().width > 0 && body.getBoundingClientRect().height > 0; })()`);
    assert.equal(contents.getURL(), conversationUrl, 'Studio must remain in the original document.');
    assert.equal(contents.getTitle(), 'YUR AI Desktop');
    assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode") && getComputedStyle(document.getElementById("yur-conversation")).display !== "none"'), true, 'Studio must retain the conversation shell.');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".ide-shell")).display === "none"'), true, 'The original full editor shell must remain hidden.');
    assert.equal(await evaluate('Boolean(document.querySelector("#yc-studio-editor-host .editor-area") && document.querySelector("#yc-studio-files-host #file-tree") && document.querySelector("#yc-studio-terminal-host .panel"))'), true, 'Studio must mount the existing editor, tree and terminal DOM.');
  };
  const assertChatPreserved = async () => {
    assert.equal(await evaluate('document.getElementById("yc-input").value'), navigationDraft);
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#yc-messages .yc-message")].map(message => message.textContent)'), conversationMessages);
  };

  await openStudio();
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#yur-conversation .yc-sidebar")).visibility === "visible"'), true);
  await studioCommand('new-file');
  await waitFor(contents, 'Boolean(window.monaco?.editor && state.editor && state.activeTab && state.files.get(state.activeTab)?.model)');
  const studioEditedContent = '# Preserved Studio model\n\nLiteral "quotes", Unicode 雪, and an unsaved change.\n';
  await evaluate(`
    window.__smokeStudioEditor = state.editor;
    window.__smokeStudioModel = state.editor.getModel();
    window.__smokeStudioDom = state.editor.getDomNode();
    window.__smokeStudioTab = state.activeTab;
    state.editor.setValue(${JSON.stringify(studioEditedContent)});
  `);
  await waitFor(contents, 'state.files.get(window.__smokeStudioTab).dirty === true');
  assert.equal(await evaluate('document.getElementById("yc-studio-editor-host").contains(window.__smokeStudioDom) && Boolean(document.querySelector("#yc-studio-editor-host .monaco-editor"))'), true, 'The visible editor must contain the real Monaco instance.');
  await evaluate('document.querySelector(\'#yur-conversation [data-workspace="agents"]\').click()');
  await waitFor(contents, 'document.getElementById("yc-section-panel").dataset.section === "agents" && getComputedStyle(document.getElementById("yc-section-panel")).display !== "none"');
  await evaluate('document.getElementById("yc-back-chat").click()');
  await assertChatPreserved();
  await openStudio();
  assert.equal(await evaluate('state.editor === window.__smokeStudioEditor && state.editor.getModel() === window.__smokeStudioModel && state.editor.getDomNode() === window.__smokeStudioDom && state.activeTab === window.__smokeStudioTab && state.files.get(state.activeTab).dirty === true'), true, 'Navigation must preserve the same editor, model, DOM, active tab and dirty flag.');
  assert.equal(await evaluate('state.editor.getValue()'), studioEditedContent);
  checks.push('Studio mounts the real Monaco editor in the conversation shell; Agents and chat roundtrip preserve its model, DOM, content and dirty state');

  await studioCommand('save');
  await waitFor(contents, 'state.activeTab && state.files.get(state.activeTab)?.dirty === false');
  assert.ok(dialogCalls.includes('save'), 'New file save must use the native save chooser.');
  assert.equal(fs.readFileSync(studioSavePath, 'utf8'), studioEditedContent, 'The real file bridge must save the exact Monaco contents.');
  await studioCommand('open-folder');
  await waitFor(contents, 'document.getElementById("file-tree").textContent.includes("studio-open-fixture.md")');
  assert.ok(dialogCalls.includes('open-folder'));
  await studioCommand('open-file');
  await waitFor(contents, `state.editor?.getValue() === ${JSON.stringify(studioOpenContent)}`);
  assert.ok(dialogCalls.includes('open-file'));
  await evaluate('window.__smokeOpenedModel = state.editor.getModel(); window.__smokeOpenedTab = state.activeTab;');
  assert.equal(await evaluate('state.files.get(state.activeTab).dirty'), false);
  checks.push('Native Studio folder/file dialogs use isolated fixtures; real file IO saves exact edited contents and opens a second file');

  const previewScript = `<script>parent.postMessage({type:'studio-preview-smoke',text:document.body.innerText},'*');</script>`;
  const htmlAlpha = `<!doctype html><html><body><h1>SMOKE_HTML_ALPHA</h1><p>Independent first preview.</p>${previewScript}</body></html>`;
  const htmlBeta = `<!doctype html><html><body><h1>SMOKE_HTML_BETA</h1><p>Independent second preview.</p>${previewScript}</body></html>`;
  await studioCommand('html');
  await waitFor(contents, 'state.files.get(state.activeTab)?.type === "html" && Boolean(state.htmlEditor)');
  await evaluate(`window.__smokeHtmlTab = state.activeTab; window.__smokeHtmlModel = state.htmlEditor.getModel(); state.htmlEditor.setValue(${JSON.stringify(htmlAlpha)}); renderHtml();`);
  await waitForFrameText(contents, 'SMOKE_HTML_ALPHA');
  await studioCommand('html');
  await waitFor(contents, 'state.files.get(state.activeTab)?.type === "html" && state.activeTab !== window.__smokeHtmlTab');
  await evaluate(`window.__smokeHtmlBetaModel = state.htmlEditor.getModel(); state.htmlEditor.setValue(${JSON.stringify(htmlBeta)}); renderHtml();`);
  await waitForFrameText(contents, 'SMOKE_HTML_BETA');
  await evaluate('switchTab(window.__smokeHtmlTab)');
  assert.equal(await evaluate('state.htmlEditor.getModel() === window.__smokeHtmlModel && window.__smokeHtmlBetaModel !== window.__smokeHtmlModel && state.files.get(state.activeTab).dirty === true'), true);
  assert.equal(await evaluate('state.htmlEditor.getValue()'), htmlAlpha);
  await waitForFrameText(contents, 'SMOKE_HTML_ALPHA');
  nextSavePath = path.join(studioFixtureRoot, 'studio-html-alpha.html');
  await studioCommand('save');
  await waitFor(contents, 'state.files.get(state.activeTab)?.dirty === false');
  assert.equal(fs.readFileSync(nextSavePath, 'utf8'), htmlAlpha, 'Saving HTML A must never write HTML B contents.');
  await capture(contents, 'studio-html-preview');
  checks.push('HTML preview source and visible frame, independent tab models and native save preserve HTML A after editing HTML B');

  const diagramAlpha = 'graph TD\n  A[SMOKE_GRAPH_ALPHA] --> B[Ready]\n';
  const diagramBeta = 'graph LR\n  X[SMOKE_GRAPH_BETA] --> Y[Independent]\n';
  await studioCommand('mermaid');
  await waitFor(contents, 'state.files.get(state.activeTab)?.type === "mermaid" && Boolean(state.mermaidEditor)');
  await evaluate(`window.__smokeDiagramTab = state.activeTab; window.__smokeDiagramModel = state.mermaidEditor.getModel(); state.mermaidEditor.setValue(${JSON.stringify(diagramAlpha)}); renderMermaid();`);
  await waitFor(contents, 'document.querySelector("#mermaid-render-target svg")?.textContent.includes("SMOKE_GRAPH_ALPHA")');
  await studioCommand('mermaid');
  await waitFor(contents, 'state.files.get(state.activeTab)?.type === "mermaid" && state.activeTab !== window.__smokeDiagramTab');
  await evaluate(`window.__smokeDiagramBetaModel = state.mermaidEditor.getModel(); state.mermaidEditor.setValue(${JSON.stringify(diagramBeta)}); renderMermaid();`);
  await waitFor(contents, 'document.querySelector("#mermaid-render-target svg")?.textContent.includes("SMOKE_GRAPH_BETA")');
  await evaluate('switchTab(window.__smokeDiagramTab)');
  assert.equal(await evaluate('state.mermaidEditor.getModel() === window.__smokeDiagramModel && window.__smokeDiagramBetaModel !== window.__smokeDiagramModel'), true);
  assert.equal(await evaluate('state.mermaidEditor.getValue()'), diagramAlpha);
  await waitFor(contents, 'document.querySelector("#mermaid-render-target svg")?.textContent.includes("SMOKE_GRAPH_ALPHA")');
  assert.equal(await evaluate('document.querySelector("#mermaid-render-target svg").getBoundingClientRect().width > 100'), true, 'Mermaid must produce a visibly sized SVG.');
  nextSavePath = path.join(studioFixtureRoot, 'studio-diagram-alpha.mmd');
  await studioCommand('save');
  await waitFor(contents, 'state.files.get(state.activeTab)?.dirty === false');
  assert.equal(fs.readFileSync(nextSavePath, 'utf8'), diagramAlpha);
  await capture(contents, 'studio-diagram-preview');
  checks.push('Local Mermaid creates visible SVG; independent diagram models and native save preserve graph A after editing graph B');

  await studioCommand('terminal');
  await waitFor(contents, 'Boolean(state.term && document.querySelector("#yc-studio-terminal-host .xterm"))');
  await waitFor(contents, 'Boolean(state.ptyId || document.getElementById("workspace-notice")?.textContent.trim())');
  const testPtyId = await evaluate('state.ptyId');
  ownedTestPtyId = testPtyId;
  if (testPtyId) {
    assert.ok(Number.isInteger(testPtyId) && testPtyId > 0);
    const terminalCommand = "Write-Output ('YUR_STUDIO_' + 'TERMINAL_VERIFIED')" + String.fromCharCode(13);
    await evaluate(`window.studio.terminal.input(${testPtyId}, ${JSON.stringify(terminalCommand)})`);
    await waitFor(contents, `Array.from({length: state.term.buffer.active.length}, (_, index) => state.term.buffer.active.getLine(index)?.translateToString(true) || '').join(String.fromCharCode(10)).includes('YUR_STUDIO_TERMINAL_VERIFIED')`);
    terminalVerification = { status: 'native-pty-output-verified', commands_sent: true, marker: 'YUR_STUDIO_TERMINAL_VERIFIED' };
  } else {
    assert.equal(await evaluate(`(() => { const notice = document.getElementById('workspace-notice'); return Boolean(notice && notice.textContent.trim() && getComputedStyle(notice).display !== 'none' && notice.getBoundingClientRect().height > 0); })()`), true, 'Unavailable PTY must produce an explicit visible error.');
    terminalVerification = { status: 'native-pty-unavailable-visible-error', commands_sent: false };
  }
  await evaluate('window.__smokeTerminal = state.term; window.__smokeTerminalDom = state.term.element; window.__smokePtyId = state.ptyId;');
  await evaluate('document.querySelector(\'#yur-conversation [data-workspace="tools"]\').click()');
  await evaluate('document.getElementById("yc-back-chat").click()');
  await assertChatPreserved();
  await openStudio();
  assert.equal(await evaluate('state.term === window.__smokeTerminal && state.term.element === window.__smokeTerminalDom && state.ptyId === window.__smokePtyId && document.getElementById("yc-studio-terminal-host").contains(state.term.element)'), true, 'Terminal object, DOM and session must persist through navigation.');
  await capture(contents, 'studio-terminal');
  if (testPtyId) { await evaluate(`window.studio.terminal.kill(${testPtyId})`); ownedTestPtyId = null; }
  await studioCommand('terminal');
  await evaluate('switchTab(window.__smokeOpenedTab)');
  checks.push('Local xterm retains terminal state across navigation; native PTY connects or a visible error reports unavailability');

  const tabsBeforeShortcut = await evaluate('state.openTabs.length');
  await evaluate('document.getElementById("yc-studio-back").focus()');
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] });
  await waitFor(contents, `state.openTabs.length === ${tabsBeforeShortcut + 1}`);
  assert.equal(await evaluate('document.getElementById("yc-main").classList.contains("studio-open")'), true, 'Ctrl+N in Studio must create a file without changing workspace.');
  assert.equal(await evaluate('window.__smokeOpenedModel.getValue()'), studioOpenContent);
  await evaluate('switchTab(window.__smokeOpenedTab)');
  await capture(contents, 'studio-desktop');
  window.setSize(800, 700);
  await waitFor(contents, 'window.innerWidth === 800 && window.innerHeight === 700');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Studio must fit 800x700 without horizontal page overflow.');
  assert.equal(await evaluate(`['yc-studio-back', 'yc-studio-toggle-files'].every(id => { const rect = document.getElementById(id).getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })`), true, 'Studio return and file toggle controls must fit 800x700.');
  assert.equal(await evaluate('state.editor.getDomNode().getBoundingClientRect().width > 100 && state.editor.getDomNode().getBoundingClientRect().height > 100'), true);
  await capture(contents, 'studio-responsive-800x700');
  window.setSize(1440, 960);
  await waitFor(contents, 'window.innerWidth === 1440 && window.innerHeight === 960');
  await evaluate('document.getElementById("yc-studio-back").click()');
  await waitFor(contents, '!document.getElementById("yc-main").classList.contains("studio-open")');
  await assertChatPreserved();
  const retainedTabs = await evaluate('state.openTabs.length');
  await evaluate('document.getElementById("yc-input").focus()');
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] });
  await waitFor(contents, 'document.querySelectorAll("#yc-messages .yc-message").length === 0 && document.getElementById("yc-input").value === ""');
  assert.equal(await evaluate('state.openTabs.length'), retainedTabs, 'Ctrl+N in chat must not create an editor file.');
  await selectHistory('SMOKE_CONTEXT');
  await assertChatPreserved();
  assert.equal(await evaluate('state.editor === window.__smokeStudioEditor && window.__smokeStudioModel.getValue() === ' + JSON.stringify(studioEditedContent)), true);
  checks.push('Studio fits 800x700; Ctrl+N creates a file in Studio and a conversation in chat without losing either workspace');
  assert.deepEqual(blockedRequests, [], 'Studio must load its real editor dependencies locally without external requests.');
  await capture(contents, 'populated');
  assert.deepEqual(rendererErrors, []);
  finish(null, { saved_conversations: journal.result.conversations.length, selected_model: requests[0].model, fixture_mission_id: 'fixture-mission-not-live', journal_root: process.env.YUR_DESKTOP_HOME, studio_saved_file: studioSavePath, native_dialog_calls: dialogCalls, terminal_verification: terminalVerification });
}

app.on('browser-window-created', (_event, window) => {
  if (testWindow) return;
  testWindow = window;
  window.hide();
  window.setSkipTaskbar(true);
  window.setSize(1440, 960);
  const contents = window.webContents;
  contents.setBackgroundThrottling(false);
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    blockedRequests.push(details.url);
    callback({ cancel: true });
  });
  contents.on('preload-error', (_event, _preload, error) => rendererErrors.push(error.message));
  contents.on('render-process-gone', (_event, details) => { if (!finished) finish(new Error(`Renderer exited: ${details.reason} (${details.exitCode})`)); });
  contents.on('console-message', (event) => {
    const detail = event;
    if ((detail.level === 3 || detail.level === 'error') && !String(detail.message).includes('ERR_BLOCKED_BY_CLIENT')) {
      rendererErrors.push(String(detail.message).slice(0, 400));
      rendererErrorDetails.push({ message: String(detail.message).slice(0, 400), source: detail.sourceId, line: detail.lineNumber, stage: checks.at(-1) || 'startup' });
    }
  });
  contents.once('did-finish-load', () => runSmoke(window).catch(async error => {
    try { await capture(contents, 'failure'); } catch {}
    finish(error);
  }));
});

fixture.on('error', error => finish(error));
fixture.listen(0, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  process.env.YUR_FOUNDRY_URL = origin;
  process.env.YUR_OLLAMA_URL = origin;
  require('../src/main.js');
});
