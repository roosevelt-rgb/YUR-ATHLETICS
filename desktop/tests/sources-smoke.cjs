'use strict';
// Actual packaged main/preload, approved-source CLI and conversation journal.
// Provider replies and an IPC delay are isolated fixtures. No donor is executed.
const { app, ipcMain, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-sources-smoke-'));
const donor = path.join(home, 'reviewed-yur-os'), ecosystem = path.join(home, 'reviewed-ecosystem'); fs.mkdirSync(donor); fs.mkdirSync(ecosystem);
const names = ['__SPINE_NODE__.json','README.md','Cargo.toml','rust-toolchain.toml','proto/spine.proto','yur-types/src/constitution.rs','yur-substrate/src/main.rs','yur-substrate/src/grpc.rs','yur-substrate/src/wasm_jit.rs','yur-substrate/src/rbac.rs','yur-substrate/src/interceptor.rs','yur-cortex-py/client.py','yur-cortex-py/pyproject.toml','yur-cortex-py/tests/test_smoke_round_trip.py','yur-intern/src/lib.rs'];
const marker = 'ACTUAL_REVIEWED_SOURCE_871ff', source = '# Reviewed donor fixture\n' + marker + '\n<img src="https://example.invalid/no-load" onerror="window.sourceExecuted=true">\nReference only.\n';
for (const name of names) { const file = path.join(donor, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name === 'README.md' ? source : name.endsWith('.py') ? 'raise RuntimeError("DONOR_MUST_NEVER_EXECUTE")\n' : 'UNSELECTED_SOURCE_583bb\n'); }
fs.writeFileSync(path.join(donor, '.env'), 'EXCLUDED_PRIVATE_SOURCE_152bb');
const sourceFile = path.join(donor, 'README.md');
const noteFile = path.join(home, 'note.txt'); fs.writeFileSync(noteFile, 'Unrelated attached note.'); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [noteFile] });
const production = ['tests/sources-smoke.cjs','src/main.js','src/preload.js','src/desktop-security.js','src/conversation-transport.js','src/conversation-view.js','src/conversation.css','src/source-context.js','src/studio-editor.html','foundry/sources.py','foundry/factory_cli.py','foundry/commit_service.py','foundry/conversation_cli.py'];
const fingerprints = () => Object.fromEntries(production.map(name => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))]));
const before = fingerprints(), originalDonor = Object.fromEntries(names.map(name => [name, sha(fs.readFileSync(path.join(donor, name)))]));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(home, 'electron')); process.env.APPDATA = path.join(home, 'appdata');
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory'); process.env.YUR_OS_ROOT = donor; process.env.YUR_ECOSYSTEM_ROOT = ecosystem;
let holdAcquire = false, held = false, releaseAcquire = null, holdAttachment = false, attachmentHeld = false, releaseAttachment = null;
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => realHandle(channel, !['sources:acquire','attachments:read'].includes(channel) ? handler : async (...args) => {
  const result = await handler(...args);
  if (channel === 'sources:acquire' && holdAcquire) { holdAcquire = false; held = true; await new Promise(resolve => { releaseAcquire = resolve; }); }
  if (channel === 'attachments:read' && holdAttachment) { holdAttachment = false; attachmentHeld = true; await new Promise(resolve => { releaseAttachment = resolve; }); }
  return result;
});
const checks = [], requests = [], rendererErrors = [], externalRequests = [], screenshots = {}, proof = {};
let window, finished = false; const started = Date.now();
const server = http.createServer((request, response) => {
  const reply = value => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/api/health') return reply({ fixture: true });
  if (request.url === '/api/models') return reply({ models: [{ name: 'sources-fixture' }] });
  if (request.url === '/api/tags') return reply({ models: [] });
  if (request.method !== 'POST' || request.url !== '/api/ask') { response.writeHead(404); response.end(); return; }
  let raw = ''; request.on('data', chunk => { raw += chunk; });
  request.on('end', () => { const body = JSON.parse(raw); requests.push(body); reply({ answer: String(body.query).includes(marker) ? 'SOURCE_CONTEXT_CONFIRMED: selected reference read.' : 'NO_SELECTED_SOURCE: no donor content was sent.', provider: 'sources-fixture', model: 'sources-fixture' }); });
});
const deadline = setTimeout(() => finish(new Error('Sources native fixture exceeded 120 seconds')), 120000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline); releaseAcquire?.(); releaseAttachment?.(); server.closeAllConnections?.(); server.close();
  const result = { ok: !error, verification: 'native-electron-sources-fixture', live_model_verified: false, ...(error ? { error: error.message, stack: error.stack } : {}), checks, model_requests: requests.length, renderer_errors: rendererErrors, external_requests: externalRequests, proof, screenshots, test_home: home, elapsed_ms: Date.now() - started };
  fs.writeFileSync(path.join(home, 'sources-smoke-result.json'), JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify(result) + '\n'); app.exit(error ? 1 : 0);
}
async function run() {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const waitFor = async (code, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out: ' + code + ' ' + await evaluate('document.getElementById("yc-notice")?.textContent')); };
  const waitHeld = async () => { const end = Date.now() + 15000; while (!held && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(held); };
  const envelope = async code => { const value = await evaluate(code); assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
  const capture = async name => { await new Promise(resolve => setTimeout(resolve, 200)); const image = await window.webContents.capturePage(); assert.equal(image.isEmpty(), false); const file = path.join(home, `sources-${name}.png`); fs.writeFileSync(file, image.toPNG()); screenshots[name] = file; };
  const reload = async () => { const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await loaded; await ready(); };
  const ready = () => waitFor('Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  const draft = async text => evaluate(`document.getElementById('yc-input').value=${JSON.stringify(text)}; document.getElementById('yc-input').dispatchEvent(new Event('input')); true;`);
  const openSources = async () => { await evaluate('document.querySelector("[data-workspace=vault]").click(); document.getElementById("yc-sources-toggle").click()'); await waitFor('[...document.querySelectorAll(".yc-resource-card h2")].some(node=>node.textContent==="YUR OS")'); await evaluate('[...document.querySelectorAll(".yc-resource-card")].find(node=>node.querySelector("h2").textContent==="YUR OS").click()'); };
  const inspect = async () => { await evaluate(`document.querySelector('.yc-source-file[data-path="README.md"] .yc-source-inspect').click()`); await waitFor('Boolean(document.querySelector(".yc-source-use"))'); };
  const reopen = async title => { await waitFor(`Boolean([...document.querySelectorAll('.yc-history-item')].find(node=>node.textContent.includes(${JSON.stringify(title)})))`); await evaluate(`[...document.querySelectorAll('.yc-history-item')].find(node=>node.textContent.includes(${JSON.stringify(title)})).click()`); };
  await ready(); await waitFor('[...document.getElementById("yc-model").options].some(option=>option.value==="foundry:sources-fixture")');
  await evaluate('document.getElementById("yc-model").value="foundry:sources-fixture"; document.getElementById("yc-model").dispatchEvent(new Event("change")); true;');
  const described = await envelope('studio.sources.describe({query:"",limit:12})'); const selected = described.sources.find(item => item.id === 'yur-os'); assert.equal(selected.evidence.length, 15); assert.equal(selected.runtime_verified, false); assert.equal(selected.execution_admitted, false); assert.equal(selected.path, donor);
  assert.equal(described.sources.length, 7); assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false);
  for (const request of [{source_id:'yur-os',relative_path:'../.env',expected_sha256:sha(source)}, {source_id:'yur-os',relative_path:'README.md',expected_sha256:sha(source),root:donor}]) assert.equal((await evaluate(`studio.sources.acquire(${JSON.stringify(request)})`)).ok, false);
  checks.push('Actual source CLI describes independent configured roots and15 reviewed files; narrow IPC rejects arbitrary paths/roots and creates no factory state');
  await draft('Sources draft preserved'); await openSources(); await capture('reviewed-files'); await inspect();
  assert.equal(await evaluate('document.querySelector(".yc-source-content").textContent'), source); assert.equal(await evaluate('document.querySelector(".yc-source-preview img, .yc-source-preview script")!==null'), false);
  await evaluate('document.querySelector(".yc-source-preview").scrollIntoView({block:"center"}); true;'); await capture('individual-excerpt');
  await evaluate('document.querySelector(".yc-source-use").click()'); await waitFor('document.querySelectorAll(".yc-source-chip").length===1 && !document.getElementById("yc-send").disabled');
  assert.equal(await evaluate('document.getElementById("yc-input").value'), 'Sources draft preserved');
  const initial = (await envelope('studio.conversations.list()')).conversations.find(item => item.source_selections?.length); proof.conversation_id = initial.id; assert.equal(initial.source_selections[0].sha256, sha(source)); assert.equal(initial.messages.length, 0);
  await evaluate('document.getElementById("yc-new-chat").click()'); assert.equal(await evaluate('document.querySelectorAll(".yc-source-chip").length'), 0); await draft('Other draft stays separate');
  await reload(); await reopen('Sources draft preserved'); assert.equal(await evaluate('document.querySelectorAll(".yc-source-chip").length'), 1); assert.equal(await evaluate('document.getElementById("yc-input").value'), 'Sources draft preserved');
  checks.push('Source excerpt is inert text; Use retains typed draft and commits references only; independent conversation and reload preserve exact source selection');
  // Delay only the acknowledgment from an actual source CLI read, then switch.
  await evaluate('document.getElementById("yc-attach").click()'); await waitFor('document.querySelectorAll("#yc-attachments .yc-attachment").length===1 && !document.getElementById("yc-send").disabled');
  holdAcquire = true; held = false; holdAttachment = true; await draft('SOURCE_SEND_A'); await evaluate('document.getElementById("yc-form").requestSubmit()');
  const attachmentDeadline = Date.now()+15000; while (!attachmentHeld && Date.now()<attachmentDeadline) await new Promise(resolve=>setTimeout(resolve,100)); assert.ok(attachmentHeld);
  assert.equal(await evaluate('document.querySelector(".yc-source-chip").disabled'),true); await evaluate('document.querySelector(".yc-source-chip").click()'); assert.equal(await evaluate('document.querySelectorAll(".yc-source-chip").length'),1); releaseAttachment(); await waitHeld();
  await evaluate('document.getElementById("yc-new-chat").click()'); await draft('Concurrent draft must survive'); releaseAcquire();
  await waitFor('!document.getElementById("yc-send").disabled'); await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(await evaluate('document.getElementById("yc-input").value'), 'Concurrent draft must survive'); assert.equal(await evaluate('document.getElementById("yc-messages").textContent.includes("SOURCE_CONTEXT_CONFIRMED")'), false);
  await reopen('SOURCE_SEND_A'); await waitFor('document.getElementById("yc-messages").textContent.includes("SOURCE_CONTEXT_CONFIRMED") && !document.getElementById("yc-send").disabled');
  assert.equal(requests.length, 1); assert.ok(requests[0].query.includes(marker)); assert.equal(requests[0].query.includes('UNSELECTED_SOURCE_583bb'), false); assert.equal(requests[0].query.includes('EXCLUDED_PRIVATE_SOURCE_152bb'), false);
  const saved = (await envelope('studio.conversations.list()')).conversations.find(item => item.id === initial.id); proof.source_evidence = saved.messages[0].evidence.sources;
  assert.equal(saved.messages[0].evidence.sources[0].sha256, sha(source)); assert.equal(JSON.stringify(saved).includes(marker), false); assert.equal(saved.metadata.project_id, null); assert.equal(saved.messages[0].evidence.repository_selection, null);
  await capture('conversation-source'); checks.push('Send reacquires only selected source and binds actual evidence to captured conversation; switching and concurrent typing retain association without source/project authority or content in journal');
  fs.writeFileSync(sourceFile, source + '\nSOURCE_CHANGED\n'); const beforeStale = requests.length; await draft('Check changed source'); await evaluate('document.getElementById("yc-form").requestSubmit()'); await waitFor('Boolean(document.querySelector(".yc-message.error")) && !document.getElementById("yc-send").disabled');
  assert.equal(requests.length, beforeStale); assert.match(await evaluate('document.querySelector(".yc-message.error").textContent'), /changed|hash/i); await capture('changed-source'); fs.writeFileSync(sourceFile, source);
  await evaluate('document.querySelector(".yc-source-chip").click()'); await waitFor('!document.querySelector(".yc-source-chip") && !document.getElementById("yc-send").disabled'); await reload(); await reopen('SOURCE_SEND_A');
  assert.equal(await evaluate('document.querySelectorAll(".yc-source-chip").length'), 0); await draft('Continue without selected donor'); await evaluate('document.getElementById("yc-form").requestSubmit()'); await waitFor('document.getElementById("yc-messages").textContent.includes("NO_SELECTED_SOURCE") && !document.getElementById("yc-send").disabled');
  assert.equal(requests.length, 2); assert.equal(requests.at(-1).query.includes(marker), false);
  const removed = (await envelope('studio.conversations.list()')).conversations.find(item => item.id === initial.id); assert.deepEqual(removed.source_selections, []); assert.equal(removed.messages[0].evidence.sources[0].sha256, sha(source));
  checks.push('Changed source fails before inference; removing selection persists across reload without resurrecting prior references or losing historical evidence');
  for (const name of names) assert.equal(sha(fs.readFileSync(path.join(donor, name))), originalDonor[name]);
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false); assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []);
  const after = fingerprints(), changed = production.filter(name => before[name] !== after[name]); proof.source_verification = { before, after, changed }; assert.deepEqual(changed, []);
  proof.capture_condition = 'Actual native window, transparent, offscreen, nonfocusable and skip-taskbar; direct capture'; await finish();
}
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created; window.setFocusable(false); window.setOpacity(0); window.setPosition(-16000,-16000); window.setSkipTaskbar(true); window.setSize(1440,960); window.webContents.setBackgroundThrottling(false);
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details, callback) => { externalRequests.push(details.url); callback({cancel:true}); });
  window.webContents.on('preload-error', (_event,_path,error) => rendererErrors.push(error.message)); window.webContents.on('console-message', detail => { if(detail.level===3||detail.level==='error') rendererErrors.push(String(detail.message)); });
  window.webContents.once('did-finish-load', () => run().catch(async error => { try { const image=await window.webContents.capturePage(); const file=path.join(home,'sources-failure.png'); fs.writeFileSync(file,image.toPNG()); screenshots.failure=file; } catch {} await finish(error); }));
});
server.listen(0,'127.0.0.1',()=>{ const origin=`http://127.0.0.1:${server.address().port}`; process.env.YUR_FOUNDRY_URL=origin; process.env.YUR_OLLAMA_URL=origin; require('../src/main.js'); });
