'use strict';
// Native test only: real main/preload/Work/CommitService and artifact intake.
// Model replies, file choice and shell reveal are local isolated fixtures.
const { app, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');

const ROOT = path.resolve(__dirname, '..');
const model = 'office-document-fixture';
const recipes = [
  { name: 'verified-report.docx', format: 'docx', title: 'Native verified report', sections: [
    { heading: 'Measured scope', paragraphs: ['DOCUMENT_DOCX_MARKER_ae31: 317 square feet.', 'Estimated cost: $18,750.50.', '<script>window.DOCUMENT_UNSAFE=true</script>'] },
  ] },
  { name: 'verified-estimate.xlsx', format: 'xlsx', title: 'Native verified estimate', sheets: [
    { name: 'Quantities', columns: ['Item', 'Area', 'Approved', 'Note'], rows: [['DOCUMENT_XLSX_MARKER_ae31', 317, true, '=SUM(B2:B3)'], ['Allowance', 0, false, null], ['Rate', 9.5, true, 'Literal data']] },
  ] },
  { name: 'verified-briefing.pptx', format: 'pptx', title: 'Native verified briefing', slides: [
    { title: 'DOCUMENT_PPTX_MARKER_ae31', bullets: ['317 square feet verified.', 'Review source evidence before approving changes.'] },
    { title: 'Next decision', bullets: ['Keep each exported result linked to its Work receipt.'] },
  ] },
];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-documents-smoke-'));
const sourceRoot = path.join(tempRoot, 'source'); fs.mkdirSync(sourceRoot);
fs.writeFileSync(path.join(sourceRoot, 'story.md'), 'Native Office fixture. Preserve source bytes.\n');
const sourceBytes = fs.readFileSync(path.join(sourceRoot, 'story.md'));
const observed = ['src/main.js', 'src/preload.js', 'src/conversation-view.js', 'src/conversation.css', 'src/work-view.js', 'src/work-transport.js',
  'foundry/work_cli.py', 'foundry/work_tools.py', 'foundry/work_documents.py', 'foundry/work_delivery.py', 'foundry/work_engine.py',
  'foundry/work_store.py', 'foundry/commit_service.py', 'foundry/attachments.py'];
const snapshot = () => Object.fromEntries(observed.map(file => [file, sha(fs.readFileSync(path.join(ROOT, file)))]));
const baseline = snapshot();
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(tempRoot, 'electron'));
process.env.APPDATA = path.join(tempRoot, 'appdata');
process.env.YUR_DESKTOP_HOME = path.join(tempRoot, 'journal'); process.env.YUR_FACTORY_HOME = path.join(tempRoot, 'factory');
process.env.YUR_COPILOT_LIBRARY = path.join(tempRoot, 'unused-copilot'); process.env.YUR_WORKFORCE_ROOT = path.join(tempRoot, 'unused-workforce');
delete process.env.YUR_FACTORY_PYTHON;
const defaultPython = require('../src/desktop-runtime.js').desktopPython(ROOT, process.env);
assert.equal(defaultPython, path.join(ROOT, '.desktop-python', 'Scripts', 'python.exe')); assert.ok(fs.existsSync(defaultPython));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceRoot] });
const checks = [], requests = [], rendererErrors = [], externalRequests = [], screenshots = {}, reveals = [], exportsProof = [];
const proof = { python: defaultPython, source_before: baseline, recipes, exports: exportsProof };
shell.showItemInFolder = value => reveals.push(value);
let testWindow, finished = false;
const started = Date.now();
const server = http.createServer((request, response) => {
  const reply = (status, value) => { if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); } };
  if (request.url === '/api/health') return reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: [] });
  if (request.url === '/api/tags') return reply(200, { models: [{ name: model }] });
  if (request.url === '/api/show') return reply(200, { capabilities: ['tools'] });
  if (request.method !== 'POST' || request.url !== '/api/chat') return reply(404, { error: 'Unknown fixture route' });
  let encoded = '';
  request.on('data', chunk => { encoded += chunk; if (Buffer.byteLength(encoded) > 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    try {
      const body = JSON.parse(encoded); requests.push(body); assert.equal(body.model, model); assert.equal(body.stream, false);
      assert.ok(body.tools.some(tool => tool.function.name === 'create_document'));
      const completed = body.messages.filter(message => message.role === 'tool').map(message => ({ name: message.tool_name, value: JSON.parse(message.content) }));
      for (let index = 0; index < completed.length; index++) {
        const result = completed[index].value;
        assert.equal(completed[index].name, 'create_document'); assert.equal(result.proposal.encoding, 'ooxml-spec-v1');
        assert.equal(result.proposal.name, recipes[index].name); assert.equal(result.artifact_status, 'committed');
        assert.deepEqual(JSON.parse(result.proposal.content), recipes[index]);
      }
      const message = completed.length < recipes.length
        ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'create_document', arguments: recipes[completed.length] } }] }
        : { role: 'assistant', content: 'DOCUMENTS_NATIVE_DONE: your report, workbook and deck are committed and ready to export.' };
      reply(200, { model, done: true, message });
    } catch (error) { reply(500, { error: error.message }); finish(error); }
  });
});
const deadline = setTimeout(() => finish(new Error('Native document fixture exceeded 180 seconds')), 180000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline); server.closeAllConnections?.(); server.close();
  proof.source_after = snapshot(); proof.source_changed_during_validation = JSON.stringify(proof.source_after) !== JSON.stringify(baseline);
  if (!error && proof.source_changed_during_validation) error = new Error('Source changed during native validation');
  const report = { ok: !error, verification: 'native-electron-documents-fixture', live_model_verified: false, native_microsoft_office_verified: false,
    ...(error ? { error: error.message, stack: error.stack } : {}), checks, proof, model_requests: requests.length,
    renderer_errors: rendererErrors, external_requests: externalRequests, screenshots, test_home: tempRoot, elapsed_ms: Date.now() - started };
  fs.writeFileSync(path.join(tempRoot, 'documents-smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n'); app.exit(error ? 1 : 0);
}

async function execute(window) {
  const contents = window.webContents;
  const evaluate = value => contents.executeJavaScript(value);
  const waitFor = async (value, timeout = 30000) => {
    const limit = Date.now() + timeout;
    while (Date.now() < limit) { if (await evaluate(value)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    const errors = await evaluate('[...document.querySelectorAll("#yc-notice,.yc-form-error")].map(node=>node.textContent).filter(Boolean).join(" | ")');
    throw new Error(`Timed out: ${value}. ${errors}`);
  };
  const click = async (selector, label) => {
    const query = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.trim()===${JSON.stringify(label)})`;
    await waitFor(`Boolean(${query})`); await evaluate(`${query}.click()`);
  };
  const capture = async name => {
    await new Promise(resolve => setTimeout(resolve, 180));
    const image = await contents.capturePage(undefined, { stayHidden: true }); assert.equal(image.isEmpty(), false);
    const target = path.join(tempRoot, `documents-${name}.png`); fs.writeFileSync(target, image.toPNG()); screenshots[name] = target;
  };
  const envelope = async expression => { const value = await evaluate(expression); assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
  try {
    await waitFor('Boolean(window.studio?.work && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
    await evaluate('window.addEventListener("unhandledrejection", event => console.error(String(event.reason?.message||event.reason))); true;');
    await waitFor(`Boolean([...document.getElementById('yc-model').options].find(item=>item.value===${JSON.stringify('ollama:' + model)}))`);
    const goal = 'Create a verified report, estimate workbook and briefing deck from the supplied native fixture facts.';
    await evaluate(`document.getElementById('yc-model').value=${JSON.stringify('ollama:' + model)}; document.getElementById('yc-model').dispatchEvent(new Event('change')); document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change')); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit();`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("DOCUMENTS_NATIVE_DONE") && !document.getElementById("yc-send").disabled');
    const parents = (await envelope('window.studio.work.list(null)')).missions; assert.equal(parents.length, 1);
    const missionId = parents[0].id; proof.mission_id = missionId;
    let record = await envelope(`window.studio.work.inspect(${JSON.stringify(missionId)})`);
    assert.equal(record.mission.status, 'completed'); assert.equal(record.mission.artifacts.length, 3);
    assert.deepEqual(record.mission.steps.map(step => step.tool), ['create_document', 'create_document', 'create_document']);
    assert.ok(record.mission.steps.every(step => step.succeeded)); assert.equal(requests.length, 4);
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-work-artifact").length===3');
    checks.push('Actual Work tool execution and CommitService retain all three typed Office proposals under one completed mission');
    for (let index = 0; index < recipes.length; index++) {
      const recipe = recipes[index]; const artifact = record.mission.artifacts.find(item => item.proposal.name === recipe.name);
      assert.ok(artifact); const proposal = artifact.proposal;
      const card = `.yc-work-artifact[data-artifact-id="${artifact.id}"]`;
      await click(`${card} summary`, 'Preview content');
      const previewText = await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelector('details[open] pre').textContent`);
      assert.equal(previewText, proposal.preview_text); assert.notEqual(previewText, proposal.content);
      assert.ok(await evaluate(`document.querySelector(${JSON.stringify(card)}).textContent.includes(${JSON.stringify({ docx: 'Word document · DOCX', xlsx: 'Spreadsheet · XLSX', pptx: 'Slide deck · PPTX' }[recipe.format])})`));
      assert.equal(await evaluate('typeof window.DOCUMENT_UNSAFE'), 'undefined');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelectorAll('script,iframe,object,embed').length`), 0);
      await evaluate(`document.querySelector(${JSON.stringify(card)}).scrollIntoView({block:'center'}); true;`);
      await capture(`${recipe.format}-preview`);
      const validation = await envelope(`window.studio.work.validateDelivery(${JSON.stringify(missionId)},${JSON.stringify(artifact.id)})`);
      assert.equal(fs.existsSync(validation.plan.path), false, 'Validation must not write an export');
      await click(`${card} button`, 'Export artifact');
      await waitFor(`document.querySelector(${JSON.stringify(card + ' .yc-work-delivery')})?.textContent.includes('Artifact exported.')`);
      const current = await envelope(`window.studio.work.inspect(${JSON.stringify(missionId)})`);
      const delivered = current.mission.artifacts.find(item => item.id === artifact.id).delivery;
      assert.equal(delivered.status, 'applied');
      const destination = delivered.plan.path; const relative = path.relative(tempRoot, destination);
      assert.equal(path.isAbsolute(relative) || relative.startsWith('..'), false);
      const raw = fs.readFileSync(destination);
      assert.equal(raw.subarray(0, 2).toString(), 'PK'); assert.equal(raw.length, proposal.bytes); assert.equal(sha(raw), proposal.sha256);
      assert.equal(delivered.verified_sha256, proposal.sha256); assert.notEqual(sha(proposal.content), proposal.sha256);
      const acquired = await envelope(`window.studio.attachments.read(${JSON.stringify({ path: destination, expected_sha256: proposal.sha256 })})`);
      assert.equal(acquired.kind, 'text'); assert.equal(acquired.sha256, proposal.sha256);
      assert.ok(acquired.content.includes(`DOCUMENT_${recipe.format.toUpperCase()}_MARKER_ae31`));
      assert.ok(acquired.content.includes('317')); assert.equal(acquired.extraction.truncated, false);
      if (recipe.format === 'docx') assert.ok(acquired.content.includes('<script>window.DOCUMENT_UNSAFE=true</script>'));
      if (recipe.format === 'xlsx') { assert.ok(acquired.content.includes('B2=317')); assert.ok(acquired.content.includes('B3=0')); assert.ok(acquired.content.includes('B4=9.5')); assert.ok(acquired.content.includes('D2==SUM(B2:B3)')); assert.equal(acquired.extraction.formulas_executed, false); }
      if (recipe.format === 'pptx') assert.equal(acquired.extraction.slides, 2);
      exportsProof.push({ format: recipe.format, name: recipe.name, path: destination, sha256: sha(raw), bytes: raw.length, artifact_id: artifact.id,
        extraction: acquired.extraction, extracted_text: acquired.content });
      await click(`${card} button`, 'Show file'); await waitFor(`true`);
      const revealDeadline = Date.now() + 5000; while (reveals.length <= index && Date.now() < revealDeadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(reveals[index], destination);
      await evaluate(`document.querySelector(${JSON.stringify(card)}).scrollIntoView({block:'center'}); true;`);
      await capture(`${recipe.format}-exported`);
    }
    checks.push('Native cards show report/workbook/deck text previews without raw recipe JSON or executable HTML');
    checks.push('Each explicit export writes actual deterministic ZIP bytes with a verified receipt; validation alone writes nothing');
    checks.push('Default shipped Python attachment intake reads all exported Office formats, including exact numbers and inert formula text; native reveal targets match');
    const before = requests.length;
    const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded;
    await waitFor('Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
    await waitFor('Boolean([...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("Create a verified report")))');
    await evaluate('[...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("Create a verified report")).click()');
    await waitFor('Boolean(document.querySelector(".yc-open-work"))'); await evaluate('document.querySelector(".yc-open-work").click()');
    await waitFor('document.querySelectorAll(".yc-work-artifact").length===3');
    assert.equal(requests.length, before);
    record = await envelope(`window.studio.work.inspect(${JSON.stringify(missionId)})`);
    assert.equal(record.mission.id, missionId);
    assert.equal(await evaluate(`document.querySelector('.yc-work-record .yc-work-id')?.textContent.includes(${JSON.stringify(missionId)})`), true);
    assert.ok(record.mission.artifacts.every(item => item.delivery.status === 'applied'));
    for (const artifact of record.mission.artifacts) {
      const card = `.yc-work-artifact[data-artifact-id="${artifact.id}"]`;
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card)}).textContent.includes('Export delivery recorded.')`), true);
      await click(`${card} summary`, 'Preview content');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelector('details[open] pre').textContent`), artifact.proposal.preview_text);
      assert.equal(sha(fs.readFileSync(artifact.delivery.plan.path)), artifact.proposal.sha256);
    }
    await capture('reopened-deliveries');
    checks.push('Reload restores the same mission, previews and applied export receipts without provider replay');
    assert.deepEqual(fs.readFileSync(path.join(sourceRoot, 'story.md')), sourceBytes);
    assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false); assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []);
    await finish();
  } catch (error) { try { await capture('failure'); } catch {} await finish(error); }
}

app.on('browser-window-created', (_event, window) => {
  if (testWindow) return; testWindow = window; window.hide(); window.setSkipTaskbar(true); window.setSize(1440, 960);
  window.webContents.setBackgroundThrottling(false);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { externalRequests.push(details.url); callback({ cancel: true }); });
  window.webContents.on('preload-error', (_event, _file, error) => rendererErrors.push(error.message));
  window.webContents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') rendererErrors.push(String(detail.message).slice(0, 1000)); });
  window.webContents.once('did-finish-load', () => execute(window).catch(finish));
});
server.on('error', finish);
server.listen(0, '127.0.0.1', () => { const origin = `http://127.0.0.1:${server.address().port}`; process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin; require('../src/main.js'); });
