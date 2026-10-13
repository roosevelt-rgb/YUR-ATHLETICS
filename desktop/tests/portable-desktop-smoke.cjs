'use strict';
// In an explicitly labeled test copy, set package.json main to this script.
// Packaged Electron ignores a positional test path; retain the original bundle
// and verify its normal production startup separately.
// All application/Python imports must come from that relocated distribution.
// Provider responses are loopback fixtures; no WSL, model service or user files
// are used. Real main/preload, parsers, OM, CommitService and node-pty run here.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Whole-distribution fingerprints must hash ASAR archive bytes, not Electron's
// virtual archive directories: https://www.electronjs.org/docs/latest/tutorial/asar-archives
const rawFs = require('original-fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const APP = path.resolve(__dirname, '..'), DISTRIBUTION = path.resolve(APP, '..', '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-portable-desktop-smoke-'));
const reportPath = path.join(home, 'portable-desktop-smoke-result.json');
const model = 'portable-desktop-fixture', done = 'PORTABLE_WORK_DONE_17bd';
const pdfMarker = 'PORTABLE_PDF_BODY_23bc', officeMarker = 'PORTABLE_DOCX_BODY_317';
const recipe = { name: 'portable-report.docx', format: 'docx', title: 'Portable verified report', sections: [{ heading: 'Measured scope', paragraphs: [officeMarker + ': 317 square feet.', 'Created through the actual Work manager.'] }] };
const proof = { application_root: APP, distribution_root: DISTRIBUTION, electron: { executable: process.execPath, version: process.versions.electron, node: process.versions.node, modules_abi: process.versions.modules }, setup: 'No runtime boot, installation or host configuration changes' };
const checks = [], requests = [], rendererErrors = [], externalRequests = [], screenshots = {};
let testWindow, server, mainLoaded = false, finished = false, before, python, terminalId = null;
const started = Date.now();
fs.writeFileSync(path.join(home, 'portable-desktop-smoke-started.json'), JSON.stringify({ schema: 'yur.portable-smoke-start.v1', app: APP, executable: process.execPath, started_at: new Date().toISOString() }, null, 2));
process.stdout.write(JSON.stringify({ event: 'portable-desktop-smoke-started', test_home: home, executable: process.execPath }) + '\n');
const deadline = setTimeout(() => finish(new Error('Portable acceptance exceeded 300 seconds')), 300000);

function within(root, file) { const relative = path.relative(root, file); return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); }
function inventory() {
  const files = []; let total = 0, nodes = 0;
  function walk(directory) {
    for (const item of rawFs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(++nodes <= 150000, 'Distribution inventory exceeded its metadata bound');
      const file = path.join(directory, item.name); assert.equal(item.isSymbolicLink(), false, 'Portable payload cannot contain links');
      if (item.isDirectory()) walk(file);
      else {
        assert.equal(item.isFile(), true, 'Portable payload must contain regular files');
        const bytes = rawFs.readFileSync(file); total += bytes.length; assert.ok(total <= 4 * 1024 ** 3, 'Distribution inventory exceeded 4 GiB');
        files.push({ path: path.relative(DISTRIBUTION, file).split(path.sep).join('/'), bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  walk(DISTRIBUTION); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, count: files.length, bytes: total, sha256: sha(JSON.stringify(files)) };
}
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  if (testWindow && !testWindow.isDestroyed()) {
    if (error) { try { await capture('failure'); } catch {} }
    if (terminalId !== null) {
      try { await testWindow.webContents.executeJavaScript(`studio.terminal.kill(${JSON.stringify(terminalId)})`); proof.terminal_cleanup = 'Exact fixture PTY stopped'; terminalId = null; }
      catch (failure) { proof.terminal_cleanup = failure.message; if (!error) error = failure; }
    }
  }
  server?.closeAllConnections?.(); server?.close();
  if (mainLoaded) {
    const observed = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 20000);
      app.once('will-quit', event => { event.preventDefault(); clearTimeout(timer); resolve(true); }); app.quit();
    });
    proof.normal_shutdown_observed = observed;
    if (!observed && !error) error = new Error('Application shutdown did not complete within 20 seconds');
  }
  if (before) {
    try {
      const after = inventory(); fs.writeFileSync(path.join(home, 'distribution-after.json'), JSON.stringify(after, null, 2));
      const prior = new Map(before.files.map(file => [file.path, file.sha256])), next = new Map(after.files.map(file => [file.path, file.sha256]));
      proof.distribution_after = { sha256: after.sha256, files: after.count, bytes: after.bytes };
      proof.distribution_changed = [...new Set([...prior.keys(), ...next.keys()])].filter(file => prior.get(file) !== next.get(file));
      if (proof.distribution_changed.length && !error) error = new Error('Distribution changed during portable acceptance');
    } catch (failure) { proof.distribution_verification_error = failure.message; if (!error) error = failure; }
  }
  const report = { ok: !error, verification: 'native-relocated-portable-desktop-fixture', live_model_verified: false, wsl_execution_verified: false, native_microsoft_office_verified: false,
    ...(error ? { error: error.message, stack: error.stack } : {}), checks, proof, model_requests: requests.length, renderer_errors: rendererErrors,
    external_requests: externalRequests, screenshots, test_home: home, elapsed_ms: Date.now() - started };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report) + '\n'); app.exit(error ? 1 : 0);
}
async function capture(name) {
  await new Promise(resolve => setTimeout(resolve, 180)); const image = await testWindow.webContents.capturePage(undefined, { stayHidden: true }); assert.equal(image.isEmpty(), false);
  const file = path.join(home, `portable-desktop-${name}.png`); fs.writeFileSync(file, image.toPNG()); screenshots[name] = file;
}
function prepare() {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.ok(process.versions.electron);
  assert.equal(path.basename(APP), 'app'); assert.equal(path.basename(path.dirname(APP)), 'resources');
  assert.equal(within(DISTRIBUTION, process.execPath), true, 'Must execute the relocated distribution Electron');
  assert.equal(fs.realpathSync(path.dirname(process.execPath)), fs.realpathSync(DISTRIBUTION));
  before = inventory(); fs.writeFileSync(path.join(home, 'distribution-before.json'), JSON.stringify(before, null, 2));
  proof.distribution_before = { sha256: before.sha256, files: before.count, bytes: before.bytes };
  const metadataFile = path.join(APP, '.desktop-distribution.json'), raw = fs.readFileSync(metadataFile), metadata = JSON.parse(raw);
  assert.equal(metadata.schema, 'yur.desktop-distribution.v1'); assert.equal(metadata.python_resource, '../python');
  assert.equal(metadata.platform, 'win32'); assert.equal(metadata.arch, 'x64');
  proof.distribution_metadata = { ...metadata, sha256: sha(raw) };

  // Preserve only Windows executable search locations. Explicit runtime/import
  // overrides cannot accidentally make an incomplete distribution look portable.
  const systemRoot = process.env.SystemRoot; assert.ok(systemRoot && path.isAbsolute(systemRoot));
  const search = [path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')];
  for (const directory of search) for (const name of ['node.exe', 'python.exe', 'python3.exe']) assert.equal(fs.existsSync(path.join(directory, name)), false, `Host ${name} must not be present in the test PATH`);
  process.env.PATH = search.join(path.delimiter);
  for (const key of ['YUR_FACTORY_PYTHON', 'PYTHONHOME', 'PYTHONPATH', 'NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'YUR_EXECUTION_DISTRO']) delete process.env[key];
  process.env.PYTHONNOUSERSITE = '1'; process.env.PYTHONDONTWRITEBYTECODE = '1'; process.env.PYTHONIOENCODING = 'utf-8'; process.env.PYTHONUTF8 = '1';
  process.env.APPDATA = path.join(home, 'appdata'); process.env.LOCALAPPDATA = path.join(home, 'localappdata'); process.env.USERPROFILE = path.join(home, 'profile'); fs.mkdirSync(process.env.USERPROFILE);
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
  process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot'); process.env.YUR_WORKFORCE_SOURCE = path.join(home, 'unused-workforce');
  app.setPath('appData', process.env.APPDATA);
  app.setPath('userData', path.join(home, 'electron')); proof.path_without_host_node_or_python = search;
  python = require('../src/desktop-runtime').desktopPython(APP, process.env);
  assert.equal(python, path.resolve(APP, metadata.python_resource, 'python.exe')); assert.equal(within(DISTRIBUTION, fs.realpathSync(python)), true);
  const runtimeManifest = fs.readFileSync(path.join(path.dirname(python), 'runtime.json')); assert.equal(sha(runtimeManifest), metadata.python_manifest_sha256);
  proof.python = { executable: python, sha256: sha(fs.readFileSync(python)), runtime_manifest_sha256: sha(runtimeManifest) };
  const fixtures = path.join(home, 'fixtures résumé 測試'); fs.mkdirSync(fixtures);
  const created = spawnSync(python, ['-B', '-c', `
import json, sys, sqlite3
from pathlib import Path
import PIL, pypdf
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
root = Path(sys.argv[1])
writer = PdfWriter(); page = writer.add_blank_page(width=240, height=200)
stream = DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 20 100 Td (${pdfMarker}) Tj ET')
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
page[NameObject('/Contents')] = writer._add_object(stream)
with (root / 'evidence.pdf').open('wb') as output: writer.write(output)
Image.new('RGB', (2, 3), '#128856').save(root / 'sample.png', format='PNG')
print(json.dumps({'executable':sys.executable,'version':sys.version,'sqlite':sqlite3.sqlite_version,'modules':{'PIL':PIL.__file__,'pypdf':pypdf.__file__}}))
`, fixtures], { cwd: APP, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(created.status, 0, created.stderr || created.error?.message || 'Bundled Python fixture creation failed');
  proof.python.probe = JSON.parse(created.stdout); assert.equal(path.resolve(proof.python.probe.executable), python);
  for (const file of Object.values(proof.python.probe.modules)) assert.equal(within(path.dirname(python), file), true, 'Parser imports must come from bundled Python');
  proof.fixture_files = Object.fromEntries(['evidence.pdf', 'sample.png'].map(name => { const file = path.join(fixtures, name), bytes = fs.readFileSync(file); return [name, { path: file, sha256: sha(bytes), bytes: bytes.length }]; }));
  checks.push('Relocated Electron resolves the verified sibling embedded Python with no host Node/Python on PATH; SQLite and parser imports come from the bundle');
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
function startServer() {
  server = http.createServer((request, response) => {
    const reply = (status, value) => { if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); } };
    if (request.url === '/api/health') return reply(200, { fixture: true });
    if (request.url === '/api/models') return reply(200, { models: [] });
    if (request.url === '/api/tags') return reply(200, { models: [{ name: model }] });
    if (request.url === '/api/show') return reply(200, { capabilities: ['tools'] });
    if (request.method !== 'POST' || request.url !== '/api/chat') return reply(404, { error: 'Unknown isolated fixture route' });
    let raw = ''; request.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw); assert.equal(body.model, model); assert.equal(body.stream, false); requests.push(body);
        const completed = body.messages.filter(message => message.role === 'tool').map(message => ({ name: message.tool_name, value: JSON.parse(message.content) }));
        const call = (name, args) => reply(200, { model, done: true, message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
        if (!completed.length) return call('build_specialist', { name: 'Portable text specialist', description: 'Finite fixture behavior through the existing factory.', capabilities: ['text.analyze'] });
        const build = completed[0].value; assert.equal(completed[0].name, 'build_specialist'); assert.equal(build.committed, true); assert.equal(build.artifact.validation.independent_validation.passed, true);
        if (completed.length === 1) return call('run_built_specialist', { mission_id: build.mission_id, capability_id: 'text.analyze', input: { text: 'Alpha beta alpha.' } });
        const run = completed[1].value; assert.equal(completed[1].name, 'run_built_specialist'); assert.equal(run.mission_id, build.mission_id); assert.equal(run.output.word_count, 3); assert.equal(run.committed, true);
        if (completed.length === 2) return call('create_document', recipe);
        assert.equal(completed.length, 3); assert.equal(completed[2].name, 'create_document'); assert.equal(completed[2].value.proposal.encoding, 'ooxml-spec-v1');
        reply(200, { model, done: true, message: { role: 'assistant', content: done + ': real specialist execution and document creation completed.' } });
      } catch (error) { reply(500, { error: error.message }); void finish(error); }
    });
  });
  server.on('error', error => finish(error));
  server.listen(0, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin;
    try { mainLoaded = true; require('../src/main.js'); } catch (error) { void finish(error); }
  });
}
async function execute(window) {
  const evaluate = value => window.webContents.executeJavaScript(value);
  const launchUrl = window.webContents.getURL();
  if (/(?:yur-ai|glider)-launch\.html$/.test(launchUrl)) {
    const entered = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    try {
      const response = await evaluate('void window.studio.launch.enter(); true');
      if (response?.ok === false) throw new Error(response.error?.message || 'Packaged launch entry failed');
    } catch (error) {
      if (!/navigat|context.*destroyed/i.test(error.message)) throw error;
    }
    await entered;
    assert.ok(/studio-editor\.html$/.test(window.webContents.getURL()), 'Real splash entry must load the packaged production desktop');
    proof.launch_entry = { launch_url: launchUrl, desktop_url: window.webContents.getURL(), via: 'actual studio.launch.enter preload IPC' };
    checks.push('Actual packaged splash enters the production desktop through its trusted preload bridge');
  }
  const envelope = async expression => { const value = await evaluate(expression); assert.equal(value?.ok, true, JSON.stringify(value)); return value.result; };
  const waitFor = async (expression, timeout = 45000) => {
    const expires = Date.now() + timeout;
    while (Date.now() < expires) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    const notice = await evaluate('document.getElementById("yc-notice")?.textContent'); throw new Error(`Timed out: ${expression}. ${notice || ''}`);
  };
  await waitFor('Boolean(window.studio?.work && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  assert.equal(await evaluate('typeof require'), 'undefined'); assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true); assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  await evaluate('window.addEventListener("unhandledrejection", event => console.error(String(event.reason?.message || event.reason))); true;');
  await capture('home');
  proof.intake = {};
  for (const [name, fixture] of Object.entries(proof.fixture_files)) {
    const acquired = await envelope(`studio.attachments.read(${JSON.stringify({ path: fixture.path, expected_sha256: fixture.sha256 })})`);
    assert.equal(acquired.sha256, fixture.sha256); assert.equal(acquired.bytes, fixture.bytes);
    if (name.endsWith('.pdf')) { assert.equal(acquired.kind, 'text'); assert.ok(acquired.content.includes(pdfMarker)); proof.intake.pdf = { sha256: acquired.sha256, content: acquired.content, extraction: acquired.extraction }; }
    else { assert.equal(acquired.kind, 'image'); assert.equal(acquired.width, 2); assert.equal(acquired.height, 3); assert.equal(sha(Buffer.from(acquired.data_url.split(',')[1], 'base64')), fixture.sha256); proof.intake.image = { sha256: acquired.sha256, width: acquired.width, height: acquired.height, mime: acquired.mime }; }
  }
  checks.push('Actual isolated main/preload attachment IPC extracts PDF text and returns the original PNG bytes using bundled parser/native dependencies');
  await waitFor(`Boolean([...document.getElementById('yc-model').options].find(item=>item.value===${JSON.stringify('ollama:' + model)}))`);
  const goal = 'Build and run the portable text specialist, then create the measured report.';
  await evaluate(`document.getElementById('yc-model').value=${JSON.stringify('ollama:' + model)}; document.getElementById('yc-model').dispatchEvent(new Event('change')); document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change')); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit()`);
  await waitFor(`document.getElementById('yc-messages').textContent.includes(${JSON.stringify(done)}) && !document.getElementById('yc-send').disabled`, 120000);
  const missions = (await envelope('studio.work.list(null)')).missions; assert.equal(missions.length, 1);
  let record = await envelope(`studio.work.inspect(${JSON.stringify(missions[0].id)})`);
  assert.equal(record.mission.status, 'completed'); assert.deepEqual(record.mission.steps.map(step => step.tool), ['build_specialist', 'run_built_specialist', 'create_document']); assert.ok(record.mission.steps.every(step => step.succeeded));
  const build = record.mission.steps[0].result, run = record.mission.steps[1].result;
  assert.equal(run.output.word_count, 3); assert.equal(build.artifact.validation.passed, true); assert.equal(build.artifact.validation.independent_validation.passed, true);
  proof.work = { mission_id: record.mission.id, conversation_id: record.mission.conversation_id, revision: record.mission.revision, steps: record.mission.steps, events: record.events };
  const child = await envelope(`studio.work.inspectSpecialist(${JSON.stringify(record.mission.id)},${JSON.stringify(build.mission_id)})`); assert.equal(child.specialist.id, build.mission_id); assert.equal(child.specialist.status, 'completed');
  await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-specialist-card").length===2 && document.querySelectorAll(".yc-work-artifact").length===1'); await capture('factory-and-office');
  checks.push('Real factory compilation, independent validation and text.analyze execution complete under the Work manager; committed output is shown in the portable UI');

  const artifact = record.mission.artifacts[0]; assert.equal(artifact.proposal.name, recipe.name);
  const validation = await envelope(`studio.work.validateDelivery(${JSON.stringify(record.mission.id)},${JSON.stringify(artifact.id)})`);
  assert.equal(within(home, validation.plan.path), true); assert.equal(fs.existsSync(validation.plan.path), false, 'Validation alone must not write the Office export');
  await evaluate('[...document.querySelectorAll(".yc-work-artifact button")].find(button=>button.textContent==="Export artifact").click()');
  await waitFor('document.querySelector(".yc-work-delivery")?.textContent.includes("Artifact exported.")');
  record = await envelope(`studio.work.inspect(${JSON.stringify(record.mission.id)})`);
  const exported = record.mission.artifacts[0], bytes = fs.readFileSync(exported.delivery.plan.path);
  assert.equal(exported.delivery.status, 'applied'); assert.equal(bytes.subarray(0, 2).toString(), 'PK'); assert.equal(bytes.length, exported.proposal.bytes); assert.equal(sha(bytes), exported.proposal.sha256);
  const readback = await envelope(`studio.attachments.read(${JSON.stringify({ path: exported.delivery.plan.path, expected_sha256: exported.proposal.sha256 })})`);
  assert.ok(readback.content.includes(officeMarker)); assert.ok(readback.content.includes('317'));
  proof.office_export = { artifact_id: artifact.id, delivery: exported.delivery, bytes: bytes.length, sha256: sha(bytes), extracted_text: readback.content };
  await capture('exported-report'); checks.push('Explicit portable export commits a genuine DOCX with verified ZIP bytes; bundled intake reads the exported text back');

  await evaluate('window.__portableTerminal={chunks:[]}; window.__portableTerminal.off=studio.terminal.onData((id,data)=>{window.__portableTerminal.chunks.push({id,data});}); true;');
  terminalId = await evaluate('studio.terminal.spawn({cols:100,rows:24,shell:"powershell"})'); assert.ok(Number.isInteger(terminalId) && terminalId > 0, 'Actual bundled node-pty must start the Windows NoProfile shell');
  await evaluate(`studio.terminal.input(${JSON.stringify(terminalId)}, ${JSON.stringify("Write-Output ('PORTABLE_PTY_' + (17 + 25))\r")}); true;`);
  await waitFor(`window.__portableTerminal.chunks.filter(item=>item.id===${terminalId}).map(item=>item.data).join('').includes('PORTABLE_PTY_42')`, 20000);
  const output = await evaluate(`window.__portableTerminal.chunks.filter(item=>item.id===${terminalId}).map(item=>item.data).join('')`);
  proof.terminal = { native_pid: terminalId, shell: 'Windows PowerShell -NoLogo -NoProfile', output_sha256: sha(output), output_bytes: Buffer.byteLength(output), computed_marker: 'PORTABLE_PTY_42' };
  await evaluate(`studio.terminal.kill(${terminalId})`); terminalId = null; await evaluate('window.__portableTerminal.off(); true;'); proof.terminal_cleanup = 'Exact fixture PTY stopped';
  checks.push('Bundled node-pty loads in the relocated Electron ABI and returns computed native PowerShell output; only the fixture PTY is stopped');

  const conversations = (await envelope('studio.conversations.list()')).conversations, saved = conversations.find(item => item.id === record.mission.conversation_id);
  assert.ok(saved && saved.revision > 0); assert.ok(saved.messages.some(message => message.evidence?.work_mission?.mission_id === record.mission.id));
  const count = requests.length; assert.equal(count, 4);
  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await loaded;
  await waitFor('Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  await waitFor(`Boolean([...document.querySelectorAll('#yc-history .yc-history-item')].find(item=>item.textContent.trim()===${JSON.stringify(goal)}))`);
  await evaluate(`[...document.querySelectorAll('#yc-history .yc-history-item')].find(item=>item.textContent.trim()===${JSON.stringify(goal)}).click()`);
  await waitFor('Boolean(document.querySelector(".yc-open-work"))'); await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-specialist-card").length===2 && document.querySelector(".yc-work-delivery")?.textContent.includes("Export delivery recorded.")');
  const reopened = (await envelope('studio.conversations.list()')).conversations.find(item => item.id === saved.id); assert.equal(reopened.revision, saved.revision); assert.deepEqual(reopened.messages, saved.messages);
  const retained = await envelope(`studio.work.inspect(${JSON.stringify(record.mission.id)})`); assert.deepEqual(retained, record); assert.equal(requests.length, count); assert.equal(sha(fs.readFileSync(exported.delivery.plan.path)), exported.proposal.sha256);
  proof.conversation = { id: saved.id, revision: saved.revision, messages_sha256: sha(JSON.stringify(saved.messages)), reopened_exactly: true }; await capture('reopened-receipts');
  checks.push('Renderer reload reopens actual Python-backed conversation/Work/export receipts with the same IDs and bytes and zero additional provider calls');
  assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []); await finish();
}
app.on('browser-window-created', (_event, window) => {
  if (testWindow) return; testWindow = window; window.setFocusable(false); window.setOpacity(0); window.setPosition(-16000, -16000); window.setSkipTaskbar(true); window.setSize(1440, 960);
  window.webContents.setBackgroundThrottling(false);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { externalRequests.push(details.url); callback({ cancel: true }); });
  window.webContents.on('preload-error', (_event, _file, error) => rendererErrors.push(error.message));
  window.webContents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') rendererErrors.push(String(detail.message).slice(0, 1000)); });
  window.webContents.once('did-finish-load', () => execute(window).catch(error => finish(error)));
});
try { prepare(); startServer(); } catch (error) { void finish(error); }
