'use strict';

// Native phase-one acceptance: real renderer, preload, main, repository adapter
// and CommitService. Only model HTTP responses, folder chooser and clipboard
// destination are fixtures. No live model, user profile, clipboard or donor is read.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-desktop-parity-smoke-'));
const projectRoot = path.join(home, 'project fixture');
const sourcePath = path.join(projectRoot, 'fixture.js');
const sourceContent = '// Existing source stays unchanged.\nexport const original = "SOURCE_ON_DISK_831cb";\n';
const projectMarker = 'PROJECT_SOURCE_BODY_790ef';
const personalMarker = 'PERSONAL_CONTEXT_5c0e3';
const instructionsMarker = 'PROJECT_INSTRUCTIONS_4a327';
const editedInstructionsMarker = 'PROJECT_EDITED_INSTRUCTIONS_79a15';
const fullTextMarker = 'BODY_SEARCH_ONLY_817e4';
const draftMarker = 'DRAFT_REOPEN_6d0bc: an unsent idea';
const codeText = 'const literal = "<img src=x onerror=window.__parityInjected=true>";\n\nconsole.log(literal);';
const fence = '`'.repeat(3);
const markdownAnswer = [
  '# Verified fixture response', '', `The body marker is **${fullTextMarker}** with *emphasis* and \`inline code\`.`, '',
  '| Division | Quantity |', '| --- | ---: |', '| Concrete | 12 |', '| Masonry | 8 |', '',
  '- First item', '- Second item', '', '> This is inert model text.', '',
  '<img src="https://example.invalid/parity.png" onerror="window.__parityInjected=true">',
  '<script>window.__parityInjected=true</script>', '[Unsafe](javascript:alert(1))', '',
  `${fence}javascript`, codeText, fence,
].join('\n');
fs.mkdirSync(projectRoot);
fs.writeFileSync(sourcePath, sourceContent);
fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'desktop-parity-fixture', version: '1.0.0' }));
fs.writeFileSync(path.join(projectRoot, 'README.md'), `# Project fixture\n\n${projectMarker}\nSource-grounded project context for native acceptance.\n`);
const originalDigest = createHash('sha256').update(sourceContent).digest('hex');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(home, 'electron'));
process.env.APPDATA = path.join(home, 'appdata');
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal');
process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
// Main process root configuration points exclusively to the isolated fixture.
process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot');
process.env.YUR_WORKFORCE_ROOT = path.join(home, 'unused-workforce');
dialog.showOpenDialog = async (_window, options = {}) => ({ canceled: false, filePaths: [options.properties?.includes('openDirectory') ? projectRoot : sourcePath] });

const checks = [], modelRequests = [], blockedRequests = [], rendererErrors = [], screenshots = {};
const startedAt = Date.now();
let finished = false, testWindow, releaseStream, stopStreamClosed = false;
const diagnostics = [];
function recordDiagnostic(event, details = {}) {
  diagnostics.push({ event, elapsed_ms: Date.now() - startedAt, ...details });
  fs.writeFileSync(path.join(home, 'desktop-parity-diagnostics.json'), JSON.stringify({ test_home: home, diagnostics }, null, 2));
}
recordDiagnostic('fixture-started');
process.stdout.write(JSON.stringify({ event: 'desktop-parity-fixture-started', test_home: home }) + '\n');
const fixture = http.createServer((request, response) => {
  const reply = (status, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  };
  if (request.url === '/api/health') return reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: [{ name: 'parity-foundry', kind: 'fixture' }] });
  if (request.url === '/api/tags') return reply(200, { models: [{ name: 'parity-stream', details: { family: 'fixture' } }] });
  if (request.method !== 'POST' || !['/api/ask', '/api/chat'].includes(request.url)) return reply(404, { error: 'Unknown fixture route.' });
  let encoded = '';
  request.on('data', chunk => { encoded += chunk; if (Buffer.byteLength(encoded) > 500000) request.destroy(); });
  request.on('end', () => {
    let body;
    try { body = JSON.parse(encoded); } catch { return reply(400, { error: 'Invalid fixture JSON.' }); }
    const query = body.query || body.messages?.filter(message => message.role === 'user').at(-1)?.content || '';
    modelRequests.push({ route: request.url, body });
    if (request.url === '/api/chat') {
      assert.equal(body.stream, true, 'Native Ollama generation must request actual streaming.');
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const record = (content, done = false) => {
        if (response.destroyed || response.writableEnded) return;
        response.write(JSON.stringify({ model: 'parity-stream', message: { role: 'assistant', content }, done }) + '\n');
        if (done) response.end();
      };
      if (query.includes('PARITY_STREAM')) {
        record('STREAM_PARTIAL_169a7');
        releaseStream = () => record('\n\nSTREAM_COMPLETE_5e61f', true);
      } else if (query.includes('PARITY_STOP')) {
        response.on('close', () => { if (!response.writableEnded) stopStreamClosed = true; });
        record('STOP_PARTIAL_76fbe');
      } else record('ISOLATED_FAST_40f8c', true);
      return;
    }
    const context = JSON.stringify(body);
    const answer = query.includes('PARITY_MARKDOWN') ? markdownAnswer
      : context.includes(projectMarker) && context.includes(editedInstructionsMarker) ? `PROJECT_EDITED_GROUNDED: ${projectMarker} / ${editedInstructionsMarker}`
        : context.includes(projectMarker) && context.includes(instructionsMarker) ? `PROJECT_GROUNDED: ${projectMarker} / ${instructionsMarker}`
          : 'FOUNDRY_COMPLETE_ba82c: fixture response.';
    reply(200, { answer, provider: 'native-parity-fixture', model: 'parity-foundry', sources: [{ source: 'isolated HTTP fixture' }] });
  });
});

const deadline = setTimeout(() => finish(new Error('Desktop parity smoke exceeded 180 seconds.')), 180000);
async function finish(error) {
  if (finished) return;
  recordDiagnostic('finishing', error ? { error: error.message, stack: error.stack } : {});
  finished = true; clearTimeout(deadline); fixture.closeAllConnections?.(); fixture.close();
  let diagnosticTimer;
  const rejections = testWindow && !testWindow.isDestroyed()
    ? await Promise.race([
      testWindow.webContents.executeJavaScript('window.__parityRejections || []').catch(failure => { recordDiagnostic('renderer-diagnostics-unavailable', { error: failure.message }); return []; }),
      new Promise(resolve => { diagnosticTimer = setTimeout(() => { recordDiagnostic('renderer-diagnostics-timeout'); resolve([]); }, 1500); }),
    ]) : [];
  clearTimeout(diagnosticTimer);
  const report = { ok: !error, verification: 'native-electron-desktop-parity-fixture', live_harness_verified: false,
    mode_execution_verified: false, ...(error ? { error: error.message, stack: error.stack } : {}), checks,
    renderer_errors: rendererErrors, renderer_rejections: rejections, blocked_external_requests: blockedRequests, diagnostics,
    fixture_model_requests: modelRequests.length, upstream_stop_observed: stopStreamClosed, screenshots,
    source_unchanged: createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex') === originalDigest,
    elapsed_ms: Date.now() - startedAt, test_home: home };
  fs.writeFileSync(path.join(home, 'desktop-parity-smoke-result.json'), JSON.stringify(report, null, 2));
  const exitCode = error ? 1 : 0;
  const flushDeadline = setTimeout(() => app.exit(exitCode), 1500);
  process.stdout.write(JSON.stringify(report) + '\n', () => { clearTimeout(flushDeadline); app.exit(exitCode); });
}
process.on('uncaughtException', error => { recordDiagnostic('uncaught-exception', { error: error.message, stack: error.stack }); void finish(error); });
process.on('unhandledRejection', reason => { const error = reason instanceof Error ? reason : new Error(String(reason)); recordDiagnostic('unhandled-rejection', { error: error.message, stack: error.stack }); void finish(error); });
process.on('exit', code => recordDiagnostic('process-exit', { code }));
app.on('will-quit', () => recordDiagnostic('app-will-quit', { receipt_written: fs.existsSync(path.join(home, 'desktop-parity-smoke-result.json')) }));
async function waitFor(contents, expression, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const notice = await contents.executeJavaScript('document.getElementById("yc-notice")?.textContent || document.querySelector(".yc-form-error")?.textContent || ""').catch(() => 'Renderer unavailable');
  throw new Error(`Timed out: ${expression}. ${notice}`);
}
async function capture(contents, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const image = await contents.capturePage(undefined, { stayHidden: true });
      assert.equal(image.isEmpty(), false);
      const target = path.join(home, `desktop-parity-${name}.png`);
      fs.writeFileSync(target, image.toPNG()); screenshots[name] = target; return;
    } catch (error) { if (attempt === 2 || !String(error.message).includes('UnknownVizError')) throw error; }
  }
}

async function run(window) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  const journal = async () => { const response = await evaluate('window.studio.conversations.list()'); assert.equal(response.ok, true, JSON.stringify(response)); return response.result.conversations; };
  const workspace = async kind => { const response = await evaluate(`window.studio.workspace.list(${JSON.stringify(kind)})`); assert.equal(response.ok, true, JSON.stringify(response)); return response.result.documents; };
  const instrument = async () => {
    await evaluate(`window.__parityRejections = []; window.__parityCopied = null;
      window.addEventListener('unhandledrejection', event => window.__parityRejections.push(String(event.reason?.message || event.reason)));
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.__parityCopied = text;}}});`);
  };
  const clickText = async (selector, text) => {
    const expression = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.trim() === ${JSON.stringify(text)})`;
    await waitFor(contents, `Boolean(${expression})`); await evaluate(`${expression}.click()`);
  };
  const selectHistory = async title => {
    const expression = `[...document.querySelectorAll('#yc-history .yc-history-item')].find(button => button.title === ${JSON.stringify(title)})`;
    await waitFor(contents, `Boolean(${expression})`); await evaluate(`${expression}.click()`);
  };
  const setValue = async (id, value, type = 'input') => evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(type)}, {bubbles:true}));`);
  const chooseModel = async value => { await waitFor(contents, `Boolean([...document.getElementById('yc-model').options].find(option => option.value === ${JSON.stringify(value)}))`); await setValue('yc-model', value, 'change'); };
  const send = async (text, complete = true) => {
    await waitFor(contents, 'Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
    const previous = await evaluate('document.querySelectorAll("#yc-messages .yc-message").length');
    await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(text)}; document.getElementById('yc-form').requestSubmit();`);
    if (complete) await waitFor(contents, `document.querySelectorAll('#yc-messages .yc-message').length >= ${previous + 2} && !document.getElementById('yc-send').disabled`, 25000);
  };
  const reload = async () => {
    const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded; await instrument();
    await waitFor(contents, 'Boolean(window.studio?.workspace && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  };
  const currentRecord = async () => {
    const title = await evaluate('document.getElementById("yc-thread-title").textContent');
    return (await journal()).find(item => item.title === title);
  };

  await instrument();
  await waitFor(contents, 'Boolean(window.studio?.workspace && window.studio?.generation && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  assert.equal(contents.getLastWebPreferences().contextIsolation, true);
  assert.equal(contents.getLastWebPreferences().sandbox, true);
  assert.equal(contents.getLastWebPreferences().nodeIntegration, false);
  // Franklin recovery may initialize the shared journal schema without admitting work.
  assert.deepEqual(await journal(), []);
  const startupWork = await evaluate('window.studio.work.list(null)');
  assert.equal(startupWork.ok, true, JSON.stringify(startupWork));
  assert.deepEqual(startupWork.result.missions, []);
  assert.equal(modelRequests.length, 0);
  assert.equal(createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), originalDigest);
  assert.deepEqual(await workspace('project'), []);
  assert.deepEqual(await workspace('settings'), []);
  assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode")'), true);
  await new Promise(resolve => setTimeout(resolve, 1200)); await capture(contents, 'home');
  checks.push('Default chat shell and isolated preload; startup admits no mission, saved conversation, project, settings document or model request and preserves fixture source');

  await chooseModel('foundry:parity-foundry');
  await send('PARITY_MARKDOWN: show the fixture report.');
  const markdownConversation = await currentRecord();
  assert.ok(markdownConversation);
  assert.equal(markdownConversation.messages.find(message => message.role === 'assistant').content, markdownAnswer);
  assert.equal(await evaluate('Boolean(document.querySelector(".yc-message.assistant h1") && document.querySelector(".yc-message.assistant strong") && document.querySelector(".yc-message.assistant em") && document.querySelector(".yc-message.assistant blockquote"))'), true);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".yc-message.assistant table tr")].map(row => [...row.cells].map(cell => cell.textContent))'), [['Division', 'Quantity'], ['Concrete', '12'], ['Masonry', '8']]);
  assert.equal(await evaluate('document.querySelector("#yc-messages img, #yc-messages script, #yc-messages a[href^=javascript]") === null && window.__parityInjected === undefined'), true);
  assert.equal(await evaluate('document.querySelector(".yc-code-block code").textContent'), codeText);
  await clickText('.yc-code-toolbar button', 'Copy code');
  assert.equal(await evaluate('window.__parityCopied'), codeText);
  await capture(contents, 'markdown');
  checks.push('Real response preserves Markdown source; headings, emphasis, table, list and code render inertly; Copy code carries exact text to isolated clipboard adapter');

  await clickText('.yc-code-toolbar button', 'Open in Studio');
  await waitFor(contents, 'Boolean(window.monaco?.editor && state.editor && state.activeTab && document.querySelector("#yc-studio-editor-host .monaco-editor"))');
  assert.equal(await evaluate('state.editor.getValue()'), codeText);
  assert.equal(await evaluate('document.body.classList.contains("yur-conversation-mode") && document.getElementById("yc-main").classList.contains("studio-open")'), true);
  await evaluate('window.__parityEditor = state.editor; window.__parityCodeTab = state.activeTab; window.__parityCodeModel = state.editor.getModel(); true;');
  await evaluate('document.getElementById("yc-studio-back").click()');
  await evaluate('document.querySelector(\'[data-workspace="files"]\').click()');
  await waitFor(contents, 'document.getElementById("yc-main").classList.contains("studio-open")');
  assert.equal(await evaluate('state.editor === window.__parityEditor && state.activeTab === window.__parityCodeTab && state.editor.getModel() === window.__parityCodeModel && state.editor.getValue() === ' + JSON.stringify(codeText)), true);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceContent);
  await capture(contents, 'code-in-studio');
  await evaluate('document.getElementById("yc-studio-back").click()');
  checks.push('Open in Studio uses existing Monaco editor and retains its model/tab across navigation without executing code or changing source files');

  await evaluate('document.getElementById("yc-new-chat").click()'); await chooseModel('ollama:parity-stream');
  await send('PARITY_STREAM: show incremental output.', false);
  await waitFor(contents, 'document.querySelector(".yc-streaming")?.textContent.includes("STREAM_PARTIAL_169a7")');
  assert.equal(await evaluate('document.getElementById("yc-send").disabled'), true);
  assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("STREAM_COMPLETE_5e61f")'), false);
  assert.equal(typeof releaseStream, 'function');
  await capture(contents, 'partial-stream'); releaseStream();
  await waitFor(contents, 'document.querySelector(".yc-message.assistant:not(.yc-streaming)")?.textContent.includes("STREAM_COMPLETE_5e61f") && !document.getElementById("yc-send").disabled');
  const streamed = await currentRecord();
  assert.equal(streamed.messages.at(-1).content, 'STREAM_PARTIAL_169a7\n\nSTREAM_COMPLETE_5e61f');
  checks.push('Ollama NDJSON chunks reach visible partial output before completion; exact final answer is committed');

  await evaluate('document.getElementById("yc-new-chat").click()');
  await send('PARITY_STOP: preserve my partial response.', false);
  await waitFor(contents, 'document.querySelector(".yc-streaming")?.textContent.includes("STOP_PARTIAL_76fbe")');
  await evaluate('document.getElementById("yc-new-chat").click()');
  await send('PARITY_FAST: answer in this conversation only.');
  assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("STOP_PARTIAL_76fbe")'), false);
  await selectHistory('PARITY_STOP: preserve my partial response.');
  assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("ISOLATED_FAST_40f8c")'), false);
  await evaluate('document.getElementById("yc-stop").click()');
  await waitFor(contents, 'document.querySelector(".yc-interrupted") && !document.getElementById("yc-send").disabled');
  const stopDeadline = Date.now() + 5000;
  while (!stopStreamClosed && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopStreamClosed, true, 'Stop must close the upstream HTTP response.');
  const stopped = await currentRecord();
  assert.equal(stopped.messages.at(-1).content, 'STOP_PARTIAL_76fbe');
  assert.equal(stopped.messages.at(-1).evidence.interrupted, true);
  await selectHistory('PARITY_FAST: answer in this conversation only.');
  assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("STOP_PARTIAL_76fbe")'), false);
  checks.push('Concurrent conversations isolate stream events; Stop aborts actual upstream transport and journals interrupted partial text');

  await evaluate('document.getElementById("yc-projects-open").click()');
  await waitFor(contents, 'Boolean(document.getElementById("yc-new-project"))');
  await evaluate('document.getElementById("yc-new-project").click()');
  await setValue('yc-field-project-name', 'Parity project');
  await clickText('.yc-dialog button', 'Choose folder');
  assert.equal(await evaluate('document.getElementById("yc-field-project-root").value'), projectRoot);
  await setValue('yc-field-project-instructions', instructionsMarker);
  await clickText('.yc-dialog button', 'Save project');
  await waitFor(contents, 'document.querySelector(".yc-project-card h2")?.textContent === "Parity project" && !document.querySelector(".yc-dialog")');
  let selectedProject = (await workspace('project'))[0];
  assert.equal(selectedProject.root, projectRoot); assert.equal(selectedProject.instructions, instructionsMarker); assert.equal(selectedProject.revision, 1);
  await capture(contents, 'projects');
  await clickText('.yc-preferences-heading button', '← Back to conversation');
  await evaluate('document.getElementById("yc-new-chat").click()'); await chooseModel('foundry:parity-foundry');
  await setValue('yc-project', selectedProject.id, 'change');
  await send('PARITY_PROJECT: read the project source marker.');
  assert.equal(await evaluate('document.querySelector(".yc-message.assistant")?.textContent.includes("PROJECT_GROUNDED")'), true);
  const projectConversation = await currentRecord();
  assert.equal(projectConversation.metadata.project_id, selectedProject.id);
  assert.ok(JSON.stringify(modelRequests.at(-1).body).includes(projectMarker));
  assert.ok(JSON.stringify(modelRequests.at(-1).body).includes(instructionsMarker));
  assert.ok(projectConversation.messages[0].evidence.repository.files.length > 0);
  assert.equal(projectConversation.messages[0].evidence.project.revision, 1);
  checks.push('Projects create through UI and CommitService; selected folder is freshly acquired and full project instructions/source reach the real model transport');

  await evaluate('document.getElementById("yc-projects-open").click()');
  await clickText('.yc-project-card button', 'Edit project');
  await setValue('yc-field-project-name', 'Parity project edited');
  await setValue('yc-field-project-instructions', editedInstructionsMarker);
  await clickText('.yc-dialog button', 'Save project');
  await waitFor(contents, 'document.querySelector(".yc-project-card h2")?.textContent === "Parity project edited" && !document.querySelector(".yc-dialog")');
  selectedProject = (await workspace('project'))[0]; assert.equal(selectedProject.revision, 2);
  await reload(); await selectHistory('PARITY_PROJECT: read the project source marker.');
  assert.equal(await evaluate('document.getElementById("yc-project").selectedOptions[0].textContent'), 'Parity project edited');
  await send('Reacquire the updated project guidance and source.');
  assert.ok(JSON.stringify(modelRequests.at(-1).body).includes(editedInstructionsMarker));
  assert.equal((await currentRecord()).messages.at(-1).content, `PROJECT_EDITED_GROUNDED: ${projectMarker} / ${editedInstructionsMarker}`);
  checks.push('Project edits increase revision; reload restores selection and follow-up uses current project instructions');

  await evaluate('document.getElementById("yc-settings-open").click()');
  await waitFor(contents, 'Boolean(document.getElementById("yc-settings-form"))');
  const settingsPages = await evaluate('[...document.querySelectorAll("[data-settings-page]")].map(button => button.dataset.settingsPage)');
  assert.equal(settingsPages.length, 24);
  for (const id of settingsPages) {
    await evaluate(`document.querySelector('[data-settings-page="${id}"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.ys-page:not([hidden])').length === 1 && !document.getElementById('yc-settings-page-${id}').hidden && document.getElementById('yc-settings-page-${id}').children.length > 1`), true, id);
  }
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#yur-conversation > .yc-sidebar")).display'), 'none');
  assert.equal(await evaluate('document.getElementById("yc-main").getBoundingClientRect().left'), 0);
  await evaluate('document.querySelector(\'[data-settings-page="general"]\').click()');
  // An untouched profile has no committed settings document; renderer default is system.
  const appearanceBeforeSave = (await workspace('settings')).find(item => item.id === 'desktop') || { theme: 'system' };
  assert.equal(await evaluate('document.getElementById("yc-settings-scheme").textContent'), 'Blue slate and silver');
  assert.equal(await evaluate('Boolean(document.getElementById("yc-settings-theme") || document.getElementById("yc-pref-accent"))'), false);
  await setValue('yc-field-default-model', 'foundry:parity-foundry');
  await setValue('yc-field-custom-instructions', personalMarker);
  await setValue('yc-pref-display_name', 'Purchased desktop profile');
  await setValue('yc-pref-send_shortcut', 'ctrl-enter');
  await setValue('yc-pref-before_send', 'SETTINGS_HOOK_672af');
  await setValue('yc-pref-font_size', '16');
  await evaluate('["browser_enabled", "browser_context_enabled", "code_enabled", "libraries_enabled", "dictation_enabled"].forEach(key => document.getElementById("yc-pref-" + key).checked = false); document.getElementById("yc-pref-pet_enabled").checked = true;');
  await evaluate('document.getElementById("yc-settings-form").requestSubmit()');
  await waitFor(contents, 'document.querySelector("#yc-settings-form .yc-form-error")?.textContent === "Settings saved."');
  assert.equal((await workspace('settings'))[0].theme, appearanceBeforeSave.theme);
  assert.equal((await workspace('settings'))[0].preferences?.accent, appearanceBeforeSave.preferences?.accent);
  assert.equal((await workspace('settings'))[0].custom_instructions, personalMarker);
  assert.equal((await workspace('settings'))[0].preferences.display_name, 'Purchased desktop profile');
  const denied = await evaluate(`Promise.all([window.studio.browser.navigate('https://example.invalid'), window.studio.work.start({mode:'code'}), window.studio.voice.arm()])`);
  for (const result of denied) assert.equal(result.error.code, 'PREFERENCE_DISABLED');
  assert.equal(await evaluate('document.getElementById("yc-browser-toggle").hidden'), true);
  assert.equal(await evaluate('document.getElementById("yc-desktop-pet").hidden'), false);
  await capture(contents, 'settings-fixed-scheme');
  await evaluate('document.querySelector(\'[data-settings-page="appearance"]\').click()'); await capture(contents, 'settings-appearance');
  await evaluate('document.querySelector(\'[data-settings-page="import"]\').click()');
  const exported = (await workspace('settings'))[0]; exported.preferences.display_name = 'Imported desktop profile'; exported.theme = 'light'; exported.preferences.accent = 'blue';
  await setValue('yc-settings-import', JSON.stringify({ schema: 'yur.settings-export.v1', settings: exported }));
  await clickText('#yc-settings-page-import button', 'Import settings');
  await waitFor(contents, 'document.querySelector("#yc-settings-form .yc-form-error")?.textContent.startsWith("Settings imported.")');
  assert.equal(await evaluate('document.getElementById("yc-pref-display_name").value'), 'Imported desktop profile');
  await evaluate('document.getElementById("yc-settings-form").requestSubmit()');
  await waitFor(contents, 'document.querySelector("#yc-settings-form .yc-form-error")?.textContent === "Settings saved."');
  assert.equal((await workspace('settings'))[0].preferences.display_name, 'Imported desktop profile', 'Saving after import must not restore stale form values.');
  assert.equal((await workspace('settings'))[0].theme, 'light', 'Save after import preserves legacy theme.');
  assert.equal((await workspace('settings'))[0].preferences.accent, 'blue', 'Save after import preserves legacy accent.');
  await evaluate('document.querySelector(\'[data-settings-page="appshots"]\').click()');
  await clickText('#yc-settings-page-appshots button', 'Capture this window');
  await waitFor(contents, 'document.querySelector(".ys-appshot")?.naturalWidth > 0');
  await evaluate('document.getElementById("yc-pref-restricted_session").checked = true; document.getElementById("yc-settings-form").requestSubmit()');
  await waitFor(contents, 'document.querySelector("#yc-settings-form .yc-form-error")?.textContent === "Settings saved."');
  assert.equal((await evaluate('window.studio.generation.start({})')).error.code, 'PREFERENCE_DISABLED');
  await evaluate('["browser_enabled", "browser_context_enabled", "code_enabled", "libraries_enabled", "dictation_enabled"].forEach(key => document.getElementById("yc-pref-" + key).checked = true); document.getElementById("yc-pref-restricted_session").checked = false; document.getElementById("yc-settings-form").requestSubmit()');
  await waitFor(contents, 'document.querySelector("#yc-settings-form .yc-form-error")?.textContent === "Settings saved."');
  checks.push('All 24 Settings pages render; profile, appearance, companion and capability controls commit; host denies disabled actions; imports refresh the form; Appshots capture the actual window');
  await reload();
  assert.equal(await evaluate('document.getElementById("yur-conversation").dataset.theme'), 'light', 'Imported legacy theme survives reload.');
  assert.equal((await workspace('settings'))[0].preferences.accent, 'blue', 'Imported legacy accent survives reload.');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("yur-conversation")).getPropertyValue("--yc-accent").trim() === getComputedStyle(document.documentElement).getPropertyValue("--dt-silver").trim()'), true, 'Legacy values do not override the fixed silver renderer accent.');
  assert.equal(await evaluate('document.querySelector(".yc-profile strong").textContent'), 'Imported desktop profile');
  await selectHistory('PARITY_PROJECT: read the project source marker.');
  await send('Apply my saved personal and project guidance.');
  assert.ok(JSON.stringify(modelRequests.at(-1).body).includes(personalMarker));
  assert.ok(JSON.stringify(modelRequests.at(-1).body).includes('SETTINGS_HOOK_672af'));
  assert.ok(JSON.stringify(modelRequests.at(-1).body).includes(editedInstructionsMarker));
  checks.push('Legacy theme/accent and instructions persist across reload, fixed silver scheme stays applied, and saved guidance is compiled into the next response');

  await evaluate('document.getElementById("yc-search-toggle").click()');
  await setValue('yc-history-search', fullTextMarker);
  assert.equal(await evaluate('document.querySelectorAll("#yc-history .yc-history-item").length'), 1);
  assert.equal(await evaluate('document.querySelector("#yc-history .yc-history-item").title'), 'PARITY_MARKDOWN: show the fixture report.');
  await setValue('yc-history-search', ''); await selectHistory('PARITY_MARKDOWN: show the fixture report.');
  await evaluate('document.getElementById("yc-conversation-actions").click()');
  await setValue('yc-field-conversation-title', 'Pinned native report');
  await evaluate('document.getElementById("yc-field-conversation-pinned").checked = true');
  await clickText('.yc-dialog button', 'Save changes');
  await waitFor(contents, 'document.getElementById("yc-thread-title").textContent === "Pinned native report" && !document.querySelector(".yc-dialog")');
  assert.equal(await evaluate('document.querySelector("#yc-history .yc-history-item").title'), 'Pinned native report');
  let renamed = (await journal()).find(item => item.id === markdownConversation.id);
  assert.equal(renamed.metadata.pinned, true);
  await evaluate('document.getElementById("yc-conversation-actions").click(); document.getElementById("yc-field-conversation-archived").checked = true;');
  await clickText('.yc-dialog button', 'Save changes');
  await waitFor(contents, '!document.querySelector(".yc-dialog") && ![...document.querySelectorAll("#yc-history .yc-history-item")].some(button => button.title === "Pinned native report")');
  await evaluate('document.getElementById("yc-history-archived").click()'); await selectHistory('Pinned native report');
  await evaluate('document.getElementById("yc-conversation-actions").click(); document.getElementById("yc-field-conversation-archived").checked = false;');
  await clickText('.yc-dialog button', 'Save changes');
  await waitFor(contents, '!document.querySelector(".yc-dialog")');
  await evaluate('document.getElementById("yc-history-archived").click()'); await selectHistory('Pinned native report');
  renamed = (await journal()).find(item => item.id === markdownConversation.id);
  assert.equal(renamed.metadata.archived, false); assert.equal(renamed.title, 'Pinned native report');
  assert.deepEqual(renamed.messages, markdownConversation.messages);
  checks.push('Full-text history finds answer content; rename/pin/archive/unarchive commit without changing original messages');

  const originalMessages = JSON.stringify(renamed.messages);
  await evaluate('document.getElementById("yc-conversation-actions").click()');
  await clickText('.yc-dialog button', 'Branch conversation');
  await waitFor(contents, 'document.getElementById("yc-thread-title").textContent.startsWith("Branch ·") && !document.querySelector(".yc-dialog")');
  let branch = await currentRecord(); assert.equal(branch.metadata.parent_id, renamed.id);
  assert.equal(JSON.stringify(branch.messages), originalMessages);
  await selectHistory('Pinned native report');
  await clickText('.yc-message.user .yc-message-meta button', 'Edit as branch');
  await setValue('yc-field-branch-message', 'PARITY_EDITED: use this revised prompt.');
  await clickText('.yc-dialog button', 'Create branch');
  await waitFor(contents, 'document.getElementById("yc-input").value === "PARITY_EDITED: use this revised prompt." && !document.querySelector(".yc-dialog")');
  assert.equal(await evaluate('document.querySelectorAll("#yc-messages .yc-message").length'), 0);
  await send('PARITY_EDITED: use this revised prompt.');
  const edited = await currentRecord(); assert.equal(edited.metadata.parent_id, renamed.id);
  assert.equal(edited.messages[0].content, 'PARITY_EDITED: use this revised prompt.');
  await selectHistory('Pinned native report');
  const countBeforeRetry = modelRequests.length;
  await clickText('.yc-message.assistant .yc-message-meta button', 'Retry as branch');
  await waitFor(contents, `document.getElementById('yc-thread-title').textContent === 'PARITY_MARKDOWN: show the fixture report.' && !document.getElementById('yc-send').disabled && Boolean(document.querySelector('.yc-message.assistant'))`);
  assert.equal(modelRequests.length, countBeforeRetry + 1);
  const retried = (await journal()).filter(item => item.metadata?.parent_id === renamed.id).find(item => item.title === 'PARITY_MARKDOWN: show the fixture report.');
  assert.ok(retried);
  assert.equal(JSON.stringify((await journal()).find(item => item.id === renamed.id).messages), originalMessages);
  checks.push('Branch/edit/retry create separate child conversations; original message ids/content and history remain intact');

  await evaluate('document.getElementById("yc-new-chat").click()');
  await setValue('yc-mode', 'code', 'change');
  await setValue('yc-input', draftMarker);
  await waitFor(contents, `(async () => { const response = await window.studio.conversations.list(); return response.ok && response.result.conversations.some(item => item.draft === ${JSON.stringify(draftMarker)} && item.metadata?.mode === 'code'); })()`);
  await reload();
  const draftTitle = `Draft · ${draftMarker}`;
  await selectHistory(draftTitle);
  assert.equal(await evaluate('document.getElementById("yc-input").value'), draftMarker);
  assert.equal(await evaluate('document.getElementById("yc-mode").value'), 'code');
  assert.equal(await evaluate('document.querySelectorAll("#yc-messages .yc-message").length'), 0);
  await capture(contents, 'reopened-draft');
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceContent);
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false, 'Conversation features do not silently create factory execution state.');
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(await evaluate('window.__parityRejections'), []);
  assert.deepEqual(blockedRequests, []);
  checks.push('Unsent draft and selected mode survive reload; no autonomous execution, source mutation, remote resources or user state used');
  await finish();
}

app.on('browser-window-created', (_event, window) => {
  if (testWindow) return;
  testWindow = window; window.hide(); window.setSkipTaskbar(true); window.setSize(1440, 960);
  const contents = window.webContents; contents.setBackgroundThrottling(false);
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { blockedRequests.push(details.url); callback({ cancel: true }); });
  contents.on('preload-error', (_event, _preload, error) => rendererErrors.push(error.message));
  contents.on('render-process-gone', (_event, details) => { recordDiagnostic('render-process-gone', details); void finish(new Error(`Renderer stopped: ${details.reason} (exit ${details.exitCode})`)); });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { recordDiagnostic('did-fail-load', { code, description }); void finish(new Error(`Desktop failed to load: ${description} (${code})`)); } });
  contents.on('did-finish-load', () => recordDiagnostic('did-finish-load', { url: contents.getURL() }));
  contents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') rendererErrors.push(String(detail.message).slice(0, 600)); });
  contents.once('did-finish-load', () => run(window).catch(async error => { try { await capture(contents, 'failure'); } catch {} await finish(error); }));
});
fixture.on('error', error => finish(error));
fixture.listen(0, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin;
  require('../src/main.js');
});
