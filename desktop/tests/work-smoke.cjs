'use strict';

// Native Work acceptance using the actual OrchestrationManager and CommitService.
// Only model responses and the explicit source-folder chooser are fixtures.
// All applied/exported files and operational state live in this test's temp root.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { desktopPython } = require('../src/desktop-runtime');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-work-smoke-'));
const sourceRoot = path.join(home, 'source'); fs.mkdirSync(sourceRoot);
const storyPath = path.join(sourceRoot, 'story.md'), stalePath = path.join(sourceRoot, 'stale.md');
const original = '# Fixture story\n\nSOURCE_READ_4308a: value = 1.\n';
const revised = original.replace('value = 1', 'value = 2');
const staleOriginal = '# Stale fixture\n\nSTALE_READ_1342b: value = 3.\n';
const staleRevised = staleOriginal.replace('value = 3', 'value = 4');
const externalChange = '# Independent change after review\n\nKeep this text intact.\n';
const reportContent = '# Work report\n\nRead source hash, prepared the reviewed edit, and committed this artifact.\n';
const sha = value => createHash('sha256').update(value).digest('hex');
fs.writeFileSync(storyPath, original); fs.writeFileSync(stalePath, staleOriginal);
fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'native-work-fixture', version: '1.0.0' }));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceRoot] });

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(home, 'electron'));
process.env.APPDATA = path.join(home, 'appdata');
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'unused-factory');
process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot'); process.env.YUR_WORKFORCE_ROOT = path.join(home, 'unused-workforce');

const checks = [], modelRequests = [], rendererErrors = [], blockedRequests = [], screenshots = {}, toolResultProof = [];
const startedAt = Date.now();
let testWindow, finished = false, releaseMain, cancelRequestSeen = false, cancelSocketClosed = false, priorWorkEventCount = 0;
const fixture = http.createServer((request, response) => {
  const reply = (status, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  };
  if (request.url === '/api/health') return reply(200, { fixture: true });
  if (request.url === '/api/models') return reply(200, { models: [] });
  if (request.url === '/api/tags') return reply(200, { models: [{ name: 'work-tool-fixture' }] });
  if (request.method !== 'POST' || request.url !== '/api/chat') return reply(404, { error: 'Unknown fixture route.' });
  let encoded = '';
  request.on('data', chunk => { encoded += chunk; if (Buffer.byteLength(encoded) > 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    try {
      const body = JSON.parse(encoded); modelRequests.push(body);
      assert.equal(body.model, 'work-tool-fixture'); assert.equal(body.stream, false);
      const tools = body.tools.map(tool => tool.function.name);
      for (const name of ['read_file', 'propose_edit', 'create_artifact']) assert.ok(tools.includes(name));
      const goal = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
      if (goal.includes('WORK_CANCEL')) {
        cancelRequestSeen = true;
        response.on('close', () => { if (!response.writableEnded) cancelSocketClosed = true; });
        return;
      }
      const stale = goal.includes('WORK_STALE');
      const target = stale ? 'stale.md' : 'story.md', before = stale ? staleOriginal : original, after = stale ? staleRevised : revised;
      const completed = body.messages.filter(message => message.role === 'tool').map(message => ({ name: message.tool_name, value: JSON.parse(message.content) }));
      const send = (content, calls = []) => reply(200, { model: body.model, done: true, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } });
      const call = (name, args) => send('', [{ function: { name, arguments: args } }]);
      if (completed.length === 0) return call('read_file', { path: target });
      const read = completed[0].value;
      assert.equal(read.tool, 'read_file'); assert.equal(read.content, before); assert.equal(read.sha256, sha(before));
      if (completed.length === 1) {
        toolResultProof.push({ operation: 'read', path: target, sha256: read.sha256 });
        return call('propose_edit', { path: target, expected_sha256: read.sha256, content: after });
      }
      const edit = completed[1].value;
      assert.equal(edit.proposal.original_content, before); assert.equal(edit.proposal.new_sha256, sha(after));
      assert.equal(edit.artifact_status, 'awaiting_operator_review');
      assert.equal(fs.readFileSync(stale ? stalePath : storyPath, 'utf8'), before, 'Tool proposal must not mutate the source.');
      if (stale) return send('WORK_STALE_READY: edit prepared for explicit review.');
      if (completed.length === 2) return call('create_artifact', { name: 'work-report.md', media_type: 'text/markdown', content: reportContent });
      assert.equal(completed.length, 3);
      const artifact = completed[2].value;
      assert.equal(artifact.artifact_status, 'committed'); assert.equal(artifact.proposal.sha256, sha(reportContent));
      toolResultProof.push({ operation: 'artifact', artifact_id: artifact.artifact_id, sha256: artifact.proposal.sha256 });
      releaseMain = () => send('WORK_MAIN_READY: source read, reviewed edit proposed, and work-report.md committed.');
    } catch (error) { reply(500, { error: error.message }); finish(error); }
  });
});
const deadline = setTimeout(() => finish(new Error('Native Work smoke exceeded 180 seconds.')), 180000);
async function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline); fixture.closeAllConnections?.(); fixture.close();
  const observations = testWindow && !testWindow.isDestroyed() ? await testWindow.webContents.executeJavaScript('({events:window.__workEvents||[], rejections:window.__workRejections||[]})').catch(() => ({ events: [], rejections: [] })) : { events: [], rejections: [] };
  const report = { ok: !error, verification: 'native-electron-governed-work-fixture', live_model_verified: false,
    python_runtime: desktopPython(path.resolve(__dirname, '..')),
    ...(error ? { error: error.message, stack: error.stack } : {}), checks, fixture_model_requests: modelRequests.length,
    upstream_cancel_observed: cancelSocketClosed, tool_result_proof: toolResultProof, work_event_count: priorWorkEventCount + observations.events.length,
    renderer_errors: rendererErrors, renderer_rejections: observations.rejections, blocked_external_requests: blockedRequests,
    screenshots, elapsed_ms: Date.now() - startedAt, test_home: home };
  fs.writeFileSync(path.join(home, 'work-smoke-result.json'), JSON.stringify(report, null, 2));
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
      const target = path.join(home, `work-${name}.png`); fs.writeFileSync(target, image.toPNG()); screenshots[name] = target; return;
    } catch (error) { if (attempt === 2 || !String(error.message).includes('UnknownVizError')) throw error; }
  }
}

async function run(window) {
  const contents = window.webContents, evaluate = source => contents.executeJavaScript(source);
  const instrument = () => evaluate('window.__workEvents = []; window.__workRejections = []; window.studio.work.onEvent(event => window.__workEvents.push(event)); window.addEventListener("unhandledrejection", event => window.__workRejections.push(String(event.reason?.message || event.reason))); true;');
  const inspect = async id => { const response = await evaluate(`window.studio.work.inspect(${JSON.stringify(id)})`); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; };
  const missions = async () => { const response = await evaluate('window.studio.work.list(null)'); assert.equal(response.ok, true, JSON.stringify(response)); return response.result.missions; };
  const history = async () => { const response = await evaluate('window.studio.conversations.list()'); assert.equal(response.ok, true); return response.result.conversations; };
  const clickText = async (selector, label) => {
    const query = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.trim() === ${JSON.stringify(label)})`;
    await waitFor(contents, `Boolean(${query})`); await evaluate(`${query}.click()`);
  };
  const artifactButton = async (name, label) => {
    const query = `[...document.querySelectorAll('.yc-work-artifact')].find(item => item.querySelector('h4')?.textContent === ${JSON.stringify(name)})`;
    await waitFor(contents, `Boolean(${query})`);
    const button = `[...${query}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
    await waitFor(contents, `Boolean(${button})`); await evaluate(`${button}.click()`);
  };
  const send = async (text, complete = true) => {
    await waitFor(contents, '!document.getElementById("yc-send").disabled');
    await evaluate(`document.getElementById('yc-input').value = ${JSON.stringify(text)}; document.getElementById('yc-form').requestSubmit();`);
    if (complete) await waitFor(contents, 'Boolean(document.querySelector(".yc-message.assistant, .yc-message.error")) && !document.getElementById("yc-send").disabled');
  };
  const setWork = async mode => {
    await waitFor(contents, 'Boolean([...document.getElementById("yc-model").options].find(option => option.value === "ollama:work-tool-fixture"))');
    await evaluate(`document.getElementById('yc-model').value = 'ollama:work-tool-fixture'; document.getElementById('yc-model').dispatchEvent(new Event('change')); document.getElementById('yc-mode').value = ${JSON.stringify(mode)}; document.getElementById('yc-mode').dispatchEvent(new Event('change')); document.getElementById('yc-attach-repository').click();`);
    await waitFor(contents, `document.getElementById('yc-repository').textContent.includes(${JSON.stringify(sourceRoot)})`);
  };
  const selectHistory = async title => {
    const query = `[...document.querySelectorAll('#yc-history .yc-history-item')].find(button => button.title === ${JSON.stringify(title)})`;
    await waitFor(contents, `Boolean(${query})`); await evaluate(`${query}.click()`);
  };
  const openRecord = async () => {
    // The final answer opens a fresh committed mission inspection through IPC.
    await waitFor(contents, 'Boolean(document.querySelector(".yc-open-work"))');
    await evaluate('document.querySelector(".yc-open-work").click()');
    await waitFor(contents, '!document.getElementById("yc-details").classList.contains("yc-hidden")');
    await waitFor(contents, 'document.querySelectorAll("#yc-detail-body .yc-work-record .yc-work-artifact").length > 0');
  };
  const reload = async () => { priorWorkEventCount += await evaluate('(window.__workEvents || []).length'); const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded; await waitFor(contents, 'Boolean(window.studio?.work && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)'); await instrument(); };

  await waitFor(contents, 'Boolean(window.studio?.work && window.yurWorkView && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)'); await instrument();
  assert.deepEqual(await missions(), []);
  // Franklin's startup recovery shares this journal and may initialize its
  // schema before any user request. Root-directory absence is no longer a
  // full-Desktop invariant. The isolated Work read-only/no-state contract is
  // tested in test_work_cli.py; here assert that startup admitted no work.
  assert.deepEqual(await history(), []);
  assert.equal(modelRequests.length, 0);
  assert.deepEqual(await evaluate('window.__workEvents'), []);
  assert.equal(fs.readFileSync(storyPath, 'utf8'), original);
  assert.equal(fs.readFileSync(stalePath, 'utf8'), staleOriginal);
  checks.push('Full Desktop startup admits no Work mission, saved conversation or inference and preserves both fixture source files; Franklin may initialize the shared journal schema');
  await setWork('code');
  const mainGoal = 'WORK_MAIN: read story.md, propose the change, and create a work report.';
  await send(mainGoal, false);
  await waitFor(contents, 'window.__workEvents.filter(event => event.type === "tool" && event.status === "completed").length === 3');
  const heldUntil = Date.now() + 10000;
  while (!releaseMain && Date.now() < heldUntil) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(typeof releaseMain, 'function');
  assert.equal(fs.readFileSync(storyPath, 'utf8'), original);
  assert.deepEqual(await evaluate(`(() => { const send = document.getElementById('yc-send'); return { disabled: send.disabled, label: send.getAttribute('aria-label'), correction: send.dataset.correction }; })()`),
    { disabled: false, label: 'Send correction', correction: 'true' });
  assert.equal(await evaluate('[...document.querySelectorAll(".yc-work-progress li")].some(item => item.textContent === "create_artifact · completed")'), true);
  const running = (await missions()).find(mission => mission.goal === mainGoal);
  assert.ok(running); assert.equal(running.status, 'running');
  const requestsBeforeEmptySubmit = modelRequests.length;
  await evaluate('document.getElementById("yc-input").value = ""; document.getElementById("yc-form").requestSubmit()');
  assert.deepEqual((await missions()).map(mission => mission.id), [running.id], 'The enabled correction control must not start a second mission.');
  assert.equal(modelRequests.length, requestsBeforeEmptySubmit, 'An empty correction must not start another provider request.');
  const runningRecord = await inspect(running.id);
  assert.equal(runningRecord.mission.steps.length, 3); assert.equal(runningRecord.mission.artifacts.length, 2);
  await capture(contents, 'live-tools'); releaseMain();
  await waitFor(contents, 'document.getElementById("yc-messages").textContent.includes("WORK_MAIN_READY") && !document.getElementById("yc-send").disabled');
  const completed = await inspect(running.id);
  assert.equal(completed.mission.status, 'completed');
  assert.deepEqual(completed.mission.steps.map(step => step.tool), ['read_file', 'propose_edit', 'create_artifact']);
  assert.ok(completed.mission.steps.every(step => step.succeeded));
  assert.ok(completed.events.some(event => event.event_type === 'work.completed'));
  assert.equal(fs.readFileSync(storyPath, 'utf8'), original);
  checks.push('Code composer runs actual OM read/propose/artifact cells with typed model tool calls and visible live progress; steps/artifacts persist before final response, source remains unchanged');

  await openRecord();
  assert.equal(await evaluate('document.querySelectorAll("#yc-detail-body .yc-work-steps details").length'), 3);
  const proposedEdit = completed.mission.artifacts.find(item => item.proposal.kind === 'edit' && item.proposal.path === 'story.md');
  assert.ok(proposedEdit, 'The committed Work record must contain the story.md edit proposal.');
  const displayedDiff = await evaluate(`(() => {
    const artifact = document.querySelector(${JSON.stringify(`.yc-work-artifact[data-artifact-id="${proposedEdit.id}"]`)});
    if (!artifact) throw new Error('The recorded edit artifact is missing from the Work view.');
    const review = [...artifact.querySelectorAll(':scope > details')].find(node => node.querySelector(':scope > summary')?.textContent === 'Review proposed changes');
    if (!review) throw new Error('The edit artifact is missing its review disclosure.');
    review.open = true; artifact.scrollIntoView({ block: 'start' });
    return review.querySelector('pre')?.textContent;
  })()`);
  assert.equal(displayedDiff, proposedEdit.proposal.diff, 'The displayed diff must match the committed edit proposal.');
  assert.ok(displayedDiff.includes('-SOURCE_READ_4308a: value = 1.'));
  assert.ok(displayedDiff.includes('+SOURCE_READ_4308a: value = 2.'));
  await capture(contents, 'proposed-diff');
  await artifactButton('story.md', 'Validate edit for review');
  await waitFor(contents, '[...document.querySelectorAll(".yc-work-artifact button")].some(button => button.textContent === "Apply reviewed edit")');
  assert.equal(fs.readFileSync(storyPath, 'utf8'), original);
  assert.equal(await evaluate(`document.querySelector('#yc-detail-body').textContent.includes(${JSON.stringify(sha(original))})`), true);
  await evaluate('document.querySelector(".yc-work-artifact .yc-work-delivery").scrollIntoView({block:"start"}); true;');
  await capture(contents, 'review-before-apply');
  await artifactButton('story.md', 'Apply reviewed edit');
  await waitFor(contents, 'document.getElementById("yc-detail-body").textContent.includes("Reviewed edit applied.")');
  assert.equal(fs.readFileSync(storyPath, 'utf8'), revised);
  let delivered = await inspect(running.id);
  const editArtifact = delivered.mission.artifacts.find(item => item.proposal.kind === 'edit');
  assert.equal(editArtifact.delivery.status, 'applied'); assert.equal(editArtifact.delivery.verified_sha256, sha(revised));
  assert.ok(delivered.events.some(event => event.event_type === 'work.artifact.prepared'));
  assert.ok(delivered.events.some(event => event.event_type === 'work.artifact.applied'));
  checks.push('Native Validate edit is read-only; explicit Apply reviewed edit commits actual bytes with prepared/applied receipts and verified output hash');

  await artifactButton('work-report.md', 'Export artifact');
  await waitFor(contents, 'document.getElementById("yc-detail-body").textContent.includes("Artifact exported.")');
  delivered = await inspect(running.id);
  const artifact = delivered.mission.artifacts.find(item => item.proposal.kind === 'artifact');
  assert.equal(artifact.delivery.status, 'applied');
  assert.ok(path.resolve(artifact.delivery.plan.path).startsWith(path.resolve(process.env.YUR_DESKTOP_HOME) + path.sep));
  assert.equal(fs.readFileSync(artifact.delivery.plan.path, 'utf8'), reportContent);
  assert.equal(artifact.delivery.verified_sha256, sha(reportContent));
  await evaluate('[...document.querySelectorAll(".yc-work-artifact")].find(item => item.querySelector("h4")?.textContent === "work-report.md").scrollIntoView({block:"start"}); true;');
  await capture(contents, 'committed-deliveries');
  const callsBeforeReload = modelRequests.length;
  await reload(); await selectHistory(mainGoal); await openRecord();
  assert.equal(modelRequests.length, callsBeforeReload);
  assert.equal((await inspect(running.id)).mission.artifacts.filter(item => item.delivery?.status === 'applied').length, 2);
  const session = (await history()).find(item => item.title === mainGoal);
  assert.ok(JSON.stringify(session.messages).includes(running.id));
  assert.equal(await evaluate('document.getElementById("yc-detail-body").textContent.includes("work-report.md")'), true);
  checks.push('Export writes exact committed artifact within local state; reload restores mission/proposals/delivery receipts without rerunning the model');

  await evaluate('document.getElementById("yc-close-details").click(); document.getElementById("yc-new-chat").click()'); await setWork('work');
  const staleGoal = 'WORK_STALE: prepare an edit for stale.md.';
  await send(staleGoal); await openRecord();
  const staleMission = (await missions()).find(mission => mission.goal === staleGoal); assert.ok(staleMission);
  await artifactButton('stale.md', 'Validate edit for review');
  await waitFor(contents, '[...document.querySelectorAll(".yc-work-artifact button")].some(button => button.textContent === "Apply reviewed edit")');
  fs.writeFileSync(stalePath, externalChange);
  await artifactButton('stale.md', 'Apply reviewed edit');
  await waitFor(contents, 'document.querySelector(".yc-work-delivery .yc-form-error")?.textContent.includes("changed")');
  assert.equal(fs.readFileSync(stalePath, 'utf8'), externalChange);
  assert.equal((await inspect(staleMission.id)).mission.artifacts[0].delivery, undefined);
  checks.push('Source modified after review invalidates delivery and preserves independently changed bytes');

  await evaluate('document.getElementById("yc-close-details").click(); document.getElementById("yc-new-chat").click()'); await setWork('work');
  const cancelGoal = 'WORK_CANCEL: hold while I verify cancellation.';
  await send(cancelGoal, false);
  const pendingUntil = Date.now() + 10000;
  while (!cancelRequestSeen && Date.now() < pendingUntil) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cancelRequestSeen, true);
  const cancelledId = (await missions()).find(mission => mission.goal === cancelGoal)?.id; assert.ok(cancelledId);
  await evaluate('document.getElementById("yc-stop").click()');
  await waitFor(contents, '!document.getElementById("yc-send").disabled');
  const socketUntil = Date.now() + 5000;
  while (!cancelSocketClosed && Date.now() < socketUntil) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cancelSocketClosed, true);
  const cancelled = await inspect(cancelledId); assert.equal(cancelled.mission.status, 'cancelled');
  assert.ok(cancelled.events.some(event => event.event_type === 'work.cancelled'));
  const countAfterStop = modelRequests.length;
  await reload(); await selectHistory(cancelGoal);
  assert.equal((await inspect(cancelledId)).mission.status, 'cancelled'); assert.equal(modelRequests.length, countAfterStop);
  assert.equal(fs.readFileSync(storyPath, 'utf8'), revised); assert.equal(fs.readFileSync(stalePath, 'utf8'), externalChange);
  assert.equal(fs.existsSync(process.env.YUR_FACTORY_HOME), false);
  assert.deepEqual(rendererErrors, []); assert.deepEqual(await evaluate('window.__workRejections'), []); assert.deepEqual(blockedRequests, []);
  checks.push('Stop records durable cancellation and aborts pending provider process/socket; reload preserves cancelled status and unrelated completed work');
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
  const origin = `http://127.0.0.1:${fixture.address().port}`; process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin;
  require('../src/main.js');
});
