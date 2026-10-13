'use strict';

// Real native intake, parser, preload, provider transport and CommitService.
// The file chooser and model server are isolated fixtures. No user files or
// credentials are read; document content and formulas are never executed.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { desktopPython } = require('../src/desktop-runtime');
const pythonRuntime = desktopPython(path.resolve(__dirname, '..'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-attachment-smoke-'));
const documentsRoot = path.join(home, 'documents'); fs.mkdirSync(documentsRoot);
const paths = Object.fromEntries(['notes.txt', 'brief.docx', 'quantities.xlsx', 'slides.pptx', 'evidence.pdf', 'sample.png'].map(name => [name, path.join(documentsRoot, name)]));
const textMarker = 'TEXT_BODY_3419f', docxMarker = 'DOCX_BODY_56ed1', xlsxMarker = 'XLSX_BODY_26b79';
const pptxMarker = 'PPTX_BODY_19fe3', pdfMarker = 'PDF_BODY_91bc0', pathlessMarker = 'PATHLESS_TEXT_5171d';
const documentMarkers = [textMarker, docxMarker, xlsxMarker, pptxMarker, pdfMarker];
// Build honest format fixtures using the same documented parser dependencies.
// This trusted test code creates documents; it does not import/execute attachments.
const build = spawnSync(pythonRuntime, ['-B', '-c', `
from pathlib import Path
from zipfile import ZipFile
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
import sys
root = Path(sys.argv[1])
(root / 'notes.txt').write_text('${textMarker}', encoding='utf-8')
parts = {
 'brief.docx': {'word/document.xml': '<document><p><t>${docxMarker}</t></p><p><t>Project brief</t></p></document>', 'word/_rels/document.xml.rels': '<Relationships><Relationship Target="https://example.invalid/do-not-fetch"/></Relationships>'},
 'quantities.xlsx': {'xl/sharedStrings.xml': '<sst><si><t>${xlsxMarker}</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>125</v></c><c r="C1"><f>B1*2</f><v>250</v></c></row></sheetData></worksheet>'},
 'slides.pptx': {'ppt/slides/slide1.xml': '<slide><t>${pptxMarker}</t></slide>'}}
for name, entries in parts.items():
 with ZipFile(root / name, 'w') as archive:
  for item, content in entries.items(): archive.writestr(item, content)
writer = PdfWriter()
page = writer.add_blank_page(width=200, height=200)
stream = DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 20 100 Td (${pdfMarker}) Tj ET')
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
page[NameObject('/Contents')] = writer._add_object(stream)
with (root / 'evidence.pdf').open('wb') as output: writer.write(output)
Image.new('RGB', (2, 3), '#128856').save(root / 'sample.png', format='PNG')
`, documentsRoot], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
if (build.status !== 0) throw new Error(`Attachment fixture dependencies unavailable: ${build.stderr || build.error?.message || build.status}`);
const imageBytes = fs.readFileSync(paths['sample.png']);
const imageBase64 = imageBytes.toString('base64');
const imageHash = createHash('sha256').update(imageBytes).digest('hex');
const originalHashes = Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
let selectedPaths = [], chooserCalls = 0;
dialog.showOpenDialog = async () => { chooserCalls += 1; return { canceled: false, filePaths: [...selectedPaths] }; };

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(home, 'electron'));
process.env.APPDATA = path.join(home, 'appdata');
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot'); process.env.YUR_WORKFORCE_ROOT = path.join(home, 'unused-workforce');

const checks = [], modelRequests = [], showRequests = [], blockedRequests = [], rendererErrors = [], screenshots = {};
let testWindow, finished = false;
const startedAt = Date.now();
const fixture = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/api/health') return reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: [{ name: 'attachment-foundry', kind: 'fixture' }] });
  if (request.url === '/api/tags') return reply(200, { models: [{ name: 'attachment-vision' }, { name: 'attachment-text' }] });
  if (request.method !== 'POST' || !['/api/ask', '/api/chat', '/api/show'].includes(request.url)) return reply(404, { error: 'Unknown route.' });
  let encoded = '';
  request.on('data', chunk => { encoded += chunk; if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    const body = JSON.parse(encoded);
    if (request.url === '/api/show') { showRequests.push(body); return reply(200, { capabilities: body.model === 'attachment-vision' ? ['completion', 'vision'] : ['completion'] }); }
    modelRequests.push({ route: request.url, body });
    if (request.url === '/api/chat') {
      const images = body.messages.flatMap(message => message.images || []);
      const matches = images.length === 1 && images[0] === imageBase64;
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: matches ? 'IMAGE_BYTES_CONFIRMED: the original saved PNG reached the vision transport.' : 'NO_MATCHING_IMAGE_BYTES' }, done: true }) + '\n');
      return;
    }
    const query = String(body.query || '');
    const answer = documentMarkers.every(marker => query.includes(marker)) ? 'ALL_DOCUMENT_FORMATS_CONFIRMED: text PDF DOCX XLSX PPTX bodies acquired.'
      : query.includes(pathlessMarker) ? 'PATHLESS_TEXT_CONFIRMED: browser File text reached the model.' : 'No document marker found.';
    reply(200, { answer, provider: 'attachment-fixture', model: 'attachment-foundry' });
  });
});
const deadline = setTimeout(() => finish(new Error('Attachment smoke exceeded 180 seconds.')), 180000);
async function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline); fixture.closeAllConnections?.(); fixture.close();
  const rejections = testWindow && !testWindow.isDestroyed() ? await testWindow.webContents.executeJavaScript('window.__attachmentRejections || []').catch(() => []) : [];
  const report = { ok: !error, verification: 'native-electron-attachment-fixture', live_model_verified: false,
    python_runtime: pythonRuntime, python_selection: process.env.YUR_FACTORY_PYTHON ? 'environment' : 'default',
    ...(error ? { error: error.message, stack: error.stack } : {}), checks, fixture_model_requests: modelRequests.length,
    vision_capability_requests: showRequests.length, chooser_calls: chooserCalls, renderer_errors: rendererErrors,
    renderer_rejections: rejections, blocked_external_requests: blockedRequests, screenshots,
    elapsed_ms: Date.now() - startedAt, test_home: home };
  fs.writeFileSync(path.join(home, 'attachment-smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n'); app.exit(error ? 1 : 0);
}
async function waitFor(contents, expression, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await contents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  const notice = await contents.executeJavaScript('document.getElementById("yc-notice")?.textContent || ""');
  throw new Error(`Timed out: ${expression}. ${notice}`);
}
async function capture(contents, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try { const image = await contents.capturePage(undefined, { stayHidden: true }); assert.equal(image.isEmpty(), false);
      const target = path.join(home, `attachment-${name}.png`); fs.writeFileSync(target, image.toPNG()); screenshots[name] = target; return;
    } catch (error) { if (attempt === 2 || !String(error.message).includes('UnknownVizError')) throw error; }
  }
}
async function run(window) {
  const contents = window.webContents, evaluate = source => contents.executeJavaScript(source);
  const instrument = () => evaluate('window.__attachmentRejections = []; window.addEventListener("unhandledrejection", event => window.__attachmentRejections.push(String(event.reason?.message || event.reason)));');
  const journal = async () => { const result = await evaluate('window.studio.conversations.list()'); assert.equal(result.ok, true); return result.result.conversations; };
  const chooseModel = async model => {
    await waitFor(contents, `Boolean([...document.getElementById('yc-model').options].find(option => option.value === ${JSON.stringify(model)}))`);
    await evaluate(`document.getElementById('yc-model').value = ${JSON.stringify(model)}; document.getElementById('yc-model').dispatchEvent(new Event('change'));`);
  };
  const attach = async files => {
    selectedPaths = files;
    await evaluate('document.getElementById("yc-attach").click()');
    await waitFor(contents, `document.querySelectorAll('#yc-attachments .yc-attachment').length === ${files.length} && !document.getElementById('yc-send').disabled`);
  };
  const send = async text => {
    await waitFor(contents, '!document.getElementById("yc-send").disabled');
    const previous = await evaluate('document.querySelectorAll("#yc-messages .yc-message").length');
    await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(text)}; document.getElementById('yc-form').requestSubmit();`);
    await waitFor(contents, `document.querySelectorAll('#yc-messages .yc-message').length >= ${previous + 2} && !document.getElementById('yc-send').disabled`);
  };
  const selectHistory = async title => {
    const query = `[...document.querySelectorAll('#yc-history .yc-history-item')].find(button => button.title === ${JSON.stringify(title)})`;
    await waitFor(contents, `Boolean(${query})`); await evaluate(`${query}.click()`);
  };
  const reload = async () => { const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded; await instrument(); await waitFor(contents, 'Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)'); };

  await instrument();
  await waitFor(contents, 'Boolean(window.yurComposerIntake && window.studio?.attachments?.choose && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
  await chooseModel('foundry:attachment-foundry');
  await attach(['notes.txt', 'brief.docx', 'quantities.xlsx', 'slides.pptx', 'evidence.pdf'].map(name => paths[name]));
  assert.equal(chooserCalls, 1); assert.equal(modelRequests.length, 0);
  await capture(contents, 'documents-selected');
  const documentsQuestion = 'ATTACH_DOCUMENTS: inspect every selected document.';
  await send(documentsQuestion);
  assert.equal(modelRequests.length, 1);
  assert.ok(documentMarkers.every(marker => modelRequests[0].body.query.includes(marker)));
  assert.ok(modelRequests[0].body.query.includes('C1=250 [formula: B1*2; cached value only]'));
  assert.equal(await evaluate('document.querySelector(".yc-message.assistant")?.textContent.includes("ALL_DOCUMENT_FORMATS_CONFIRMED")'), true);
  const documentSession = (await journal()).find(item => item.title === documentsQuestion);
  const evidence = documentSession.messages[0].evidence.attachments;
  assert.equal(evidence.length, 5);
  for (const item of evidence) {
    assert.equal(item.sha256, originalHashes[item.name]); assert.equal(path.resolve(item.path), paths[item.name]);
    assert.equal(item.provenance.code_executed, false);
    assert.equal(Object.hasOwn(item, 'content'), false); assert.equal(Object.hasOwn(item, 'data_url'), false);
  }
  assert.equal(evidence.find(item => item.name === 'quantities.xlsx').extraction.formulas_executed, false);
  assert.equal(evidence.find(item => item.name === 'evidence.pdf').extraction.ocr_performed, false);
  checks.push('Native chooser acquires text/PDF/DOCX/XLSX/PPTX through real parsers; full bounded text reaches model and hashes/extraction provenance persist without duplicate body');

  await evaluate('document.getElementById("yc-new-chat").click()');
  await evaluate(`const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(pathlessMarker)}], 'browser-file.txt', {type:'text/plain'})); document.getElementById('yc-file-input').files = transfer.files; document.getElementById('yc-file-input').dispatchEvent(new Event('change'));`);
  await waitFor(contents, 'document.querySelectorAll("#yc-attachments .yc-attachment").length === 1 && !document.getElementById("yc-send").disabled');
  await send('ATTACH_PATHLESS: summarize my selected browser File.');
  assert.ok(modelRequests.at(-1).body.query.includes(pathlessMarker));
  const pathlessSession = (await journal()).find(item => item.title === 'ATTACH_PATHLESS: summarize my selected browser File.');
  assert.equal(pathlessSession.messages[0].evidence.attachments[0].provenance.source, 'selected-browser-file');
  assert.equal(Object.hasOwn(pathlessSession.messages[0].evidence.attachments[0], 'path'), false);
  checks.push('Existing pathless text File input remains supported with read-only hash provenance');

  await evaluate('document.getElementById("yc-new-chat").click()');
  await attach([paths['sample.png']]);
  await waitFor(contents, 'Boolean(document.querySelector("#yc-attachments .yc-image-thumbnail"))');
  assert.equal(await evaluate('document.querySelector("#yc-attachments .yc-image-thumbnail").src'), 'data:image/png;base64,' + imageBase64);
  await capture(contents, 'image-selected');
  const beforeFoundry = modelRequests.length;
  const imageQuestion = 'ATTACH_IMAGE: inspect the saved image.';
  await send(imageQuestion);
  assert.equal(modelRequests.length, beforeFoundry, 'Foundry image requests must fail before inference.');
  assert.equal(await evaluate('document.querySelector(".yc-message.error")?.textContent.includes("vision-capable Ollama")'), true);
  const imageSession = (await journal()).find(item => item.title === imageQuestion);
  const imageEvidence = imageSession.messages[0].evidence.attachments[0];
  assert.equal(imageEvidence.kind, 'image'); assert.equal(imageEvidence.sha256, imageHash);
  assert.equal(imageEvidence.path, paths['sample.png']);
  assert.equal(Object.hasOwn(imageEvidence, 'data_url'), false);
  assert.equal(Object.hasOwn(imageEvidence, 'content'), false);
  assert.equal(JSON.stringify(imageSession).includes(imageBase64), false);
  checks.push('Image thumbnail uses validated in-memory bytes; Foundry vision is explicitly unavailable and journal stores source metadata only');

  await chooseModel('ollama:attachment-vision');
  await send('Use the selected vision model on the earlier image.');
  assert.equal(modelRequests.length, beforeFoundry + 1);
  assert.equal(modelRequests.at(-1).route, '/api/chat');
  assert.ok(showRequests.some(item => item.model === 'attachment-vision'));
  const visionRequest = modelRequests.at(-1).body;
  assert.equal(visionRequest.stream, true);
  assert.deepEqual(visionRequest.messages.flatMap(item => item.images || []), [imageBase64]);
  assert.equal(await evaluate('document.querySelectorAll(".yc-message.assistant").length'), 1);
  assert.equal(await evaluate('document.querySelector(".yc-message.assistant")?.textContent.includes("IMAGE_BYTES_CONFIRMED")'), true);
  assert.equal(JSON.stringify(await journal()).includes(imageBase64), false);
  await capture(contents, 'vision-answer');
  checks.push('Actual Ollama /api/show advertises vision before /api/chat receives exact original PNG base64 in the associated user message');

  await reload(); await selectHistory(imageQuestion);
  await send('Reinspect the saved image after reload.');
  assert.equal(modelRequests.length, beforeFoundry + 2);
  assert.deepEqual(modelRequests.at(-1).body.messages.flatMap(item => item.images || []), [imageBase64]);
  assert.equal(JSON.stringify(await journal()).includes(imageBase64), false);
  checks.push('Reload and follow-up reacquire the image from path/hash and do not depend on persisted image bytes');

  const networkBeforeChange = modelRequests.length, capabilitiesBeforeChange = showRequests.length;
  fs.appendFileSync(paths['sample.png'], Buffer.from('EXPLICIT_FIXTURE_SOURCE_CHANGE'));
  await send('Reject this changed image source.');
  assert.equal(modelRequests.length, networkBeforeChange);
  assert.equal(showRequests.length, capabilitiesBeforeChange, 'Changed source must fail before even requesting provider capabilities.');
  assert.equal(await evaluate('[...document.querySelectorAll(".yc-message.error")].at(-1)?.textContent.includes("changed")'), true);
  checks.push('Changed source hash after reload fails before capability lookup or inference with an explicit reselect error');
  fs.writeFileSync(paths['sample.png'], imageBytes);

  await evaluate('document.getElementById("yc-new-chat").click()'); await chooseModel('ollama:attachment-text');
  await attach([paths['sample.png']]); const beforeNonVision = modelRequests.length;
  await send('ATTACH_NONVISION: use this text-only model.');
  assert.equal(modelRequests.length, beforeNonVision);
  assert.ok(showRequests.some(item => item.model === 'attachment-text'));
  assert.equal(await evaluate('Boolean(document.querySelector(".yc-message.error"))'), true);
  checks.push('Selected text-only model capability response prevents image inference rather than pretending to inspect it');

  const history = JSON.stringify(await journal());
  assert.equal(history.includes(imageBase64), false);
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false);
  for (const [name, file] of Object.entries(paths)) assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), originalHashes[name]);
  assert.deepEqual(rendererErrors, []); assert.deepEqual(await evaluate('window.__attachmentRejections'), []); assert.deepEqual(blockedRequests, []);
  checks.push('All fixture sources restored/unchanged; no factory state, document code execution, remote renderer fetches or image bytes in journal');
  await finish();
}
app.on('browser-window-created', (_event, window) => {
  if (testWindow) return;
  testWindow = window; window.hide(); window.setSkipTaskbar(true); window.setSize(1440, 960);
  const contents = window.webContents; contents.setBackgroundThrottling(false);
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { blockedRequests.push(details.url); callback({ cancel: true }); });
  contents.on('preload-error', (_event, _preload, error) => rendererErrors.push(error.message));
  contents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') rendererErrors.push(String(detail.message).slice(0, 600)); });
  contents.once('did-finish-load', () => run(window).catch(async error => { try { await capture(contents, 'failure'); } catch {} await finish(error); }));
});
fixture.on('error', error => finish(error));
fixture.listen(0, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin;
  require('../src/main.js');
});
