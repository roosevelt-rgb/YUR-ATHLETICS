'use strict';
// Native fixtures execute the real main/preload, manager, validators and commits.
// HTTP model replies and explicit shell reveal are fixtures; no donor is executed.
const { app, dialog, shell, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');

function nativeFixture({ prefix, model, handle, run }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `yur-${prefix}-smoke-`));
  const sourceRoot = path.join(tempRoot, 'source'); fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'story.md'), '# Native fixture\n\nSOURCE_MARKER_92bd: exact source content.\n');
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: `${prefix}-fixture`, version: '1.0.0' }));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.setPath('userData', path.join(tempRoot, 'electron'));
  process.env.APPDATA = path.join(tempRoot, 'appdata');
  process.env.YUR_DESKTOP_HOME = path.join(tempRoot, 'journal'); process.env.YUR_FACTORY_HOME = path.join(tempRoot, 'factory');
  process.env.YUR_COPILOT_LIBRARY = path.join(tempRoot, 'unused-copilot'); process.env.YUR_WORKFORCE_ROOT = path.join(tempRoot, 'unused-workforce');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceRoot] });
  const context = { tempRoot, sourceRoot, model, checks: [], requests: [], rendererErrors: [], externalRequests: [], screenshots: {}, reveals: [], proof: {} };
  shell.showItemInFolder = value => context.reveals.push(value);
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
        const body = JSON.parse(encoded); context.requests.push(body); assert.equal(body.model, model); assert.equal(body.stream, false);
        const completed = body.messages.filter(message => message.role === 'tool').map(message => ({ name: message.tool_name, value: JSON.parse(message.content) }));
        const goal = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
        const send = (content, calls = []) => reply(200, { model, done: true, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } });
        const call = (name, args) => send('', [{ function: { name, arguments: args } }]);
        handle({ ...context, body, completed, goal, call, send, response });
      } catch (error) { reply(500, { error: error.message }); finish(error); }
    });
  });
  const deadline = setTimeout(() => finish(new Error(`Native ${prefix} fixture exceeded 180 seconds`)), 180000);
  async function finish(error) {
    if (finished) return; finished = true; clearTimeout(deadline); server.closeAllConnections?.(); server.close();
    const report = { ok: !error, verification: `native-electron-${prefix}-fixture`, live_model_verified: false, ...(error ? { error: error.message, stack: error.stack } : {}), checks: context.checks, proof: context.proof, model_requests: context.requests.length, renderer_errors: context.rendererErrors, external_requests: context.externalRequests, screenshots: context.screenshots, test_home: tempRoot, elapsed_ms: Date.now() - started };
    fs.writeFileSync(path.join(tempRoot, `${prefix}-smoke-result.json`), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report) + '\n'); app.exit(error ? 1 : 0);
  }
  async function execute(window) {
    const contents = window.webContents;
    context.evaluate = value => contents.executeJavaScript(value);
    context.waitFor = async (value, timeout = 30000) => {
      const limit = Date.now() + timeout;
      while (Date.now() < limit) { if (await context.evaluate(value)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      const errors = await context.evaluate('[...document.querySelectorAll("#yc-notice,.yc-form-error")].map(node=>node.textContent).filter(Boolean).join(" | ")');
      throw new Error(`Timed out: ${value}. ${errors}`);
    };
    context.click = async (selector, label) => {
      const query = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.trim()===${JSON.stringify(label)})`;
      await context.waitFor(`Boolean(${query})`); await context.evaluate(`${query}.click()`);
    };
    context.capture = async name => {
      await new Promise(resolve => setTimeout(resolve, 180));
      const image = await contents.capturePage(undefined, { stayHidden: true }); assert.equal(image.isEmpty(), false);
      const target = path.join(tempRoot, `${prefix}-${name}.png`); fs.writeFileSync(target, image.toPNG()); context.screenshots[name] = target;
    };
    context.reload = async () => { const loaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await loaded; await context.waitFor('Boolean(document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)'); };
    context.envelope = async expression => { const value = await context.evaluate(expression); assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
    await context.waitFor('Boolean(window.studio?.work && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)');
    await context.evaluate('window.addEventListener("unhandledrejection", event => console.error(String(event.reason?.message||event.reason))); true;');
    await context.waitFor(`Boolean([...document.getElementById('yc-model').options].find(item=>item.value===${JSON.stringify('ollama:' + model)}))`);
    await context.evaluate(`document.getElementById('yc-model').value=${JSON.stringify('ollama:' + model)}; document.getElementById('yc-model').dispatchEvent(new Event('change')); true;`);
    await run(context);
    assert.deepEqual(context.rendererErrors, []); assert.deepEqual(context.externalRequests, []); await finish();
  }
  app.on('browser-window-created', (_event, window) => {
    if (testWindow) return; testWindow = window; window.hide(); window.setSkipTaskbar(true); window.setSize(1440, 960);
    window.webContents.setBackgroundThrottling(false);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { context.externalRequests.push(details.url); callback({ cancel: true }); });
    window.webContents.on('preload-error', (_event, _file, error) => context.rendererErrors.push(error.message));
    window.webContents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') context.rendererErrors.push(String(detail.message).slice(0, 1000)); });
    window.webContents.once('did-finish-load', () => execute(window).catch(async error => { try { await context.capture?.('failure'); } catch {} await finish(error); }));
  });
  server.on('error', finish);
  server.listen(0, '127.0.0.1', () => { const origin = `http://127.0.0.1:${server.address().port}`; process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin; require('../src/main.js'); });
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Material estimator</title><style>body{margin:0;padding:30px;background:#f4f1eb;color:#302a26;font:16px/1.6 system-ui}h1{font-size:28px;line-height:1.2}label{display:block;margin:20px 0}input,button{font:inherit;padding:9px;border:1px solid #bcb1a7;border-radius:8px}button{background:#703d4b;color:white;cursor:pointer}output{display:block;margin-top:24px;font-size:30px;font-weight:600}.note{color:#6e645b;font-size:13px}</style></head><body><p class="note">LOCAL WORK ARTIFACT</p><h1>Material estimator</h1><p>Compare area and unit cost before you order.</p><label>Area in square feet <input id="area" type="number" value="200"></label><label>Cost per square foot <input id="rate" type="number" value="3"></label><button id="calculate">Calculate estimate</button><output id="answer">Choose your inputs</output><p class="note">Fixture calculation. This preview cannot place orders.</p><script>document.querySelector('#calculate').onclick=()=>document.querySelector('#answer').textContent='$'+(Number(document.querySelector('#area').value)*Number(document.querySelector('#rate').value)).toLocaleString();</script></body></html>`;
nativeFixture({ prefix: 'artifact', model: 'artifact-tool-fixture',
  handle({ completed, call, send, proof }) {
    if (!completed.length) return call('create_artifact', { name: 'material-estimator.html', media_type: 'text/html', content: html });
    assert.equal(completed.length, 1); const result = completed[0].value;
    assert.equal(result.artifact_status, 'committed'); assert.equal(result.proposal.sha256, sha(html)); proof.artifact_id = result.artifact_id; proof.sha256 = result.proposal.sha256;
    send('ARTIFACT_NATIVE_READY: an interactive material estimator is committed.');
  },
  async run(ctx) {
    const { evaluate, waitFor, click, envelope } = ctx;
    const goal = 'Create an offline interactive HTML material estimator.';
    await evaluate(`document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change')); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit();`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("ARTIFACT_NATIVE_READY") && !document.getElementById("yc-send").disabled');
    const parents = (await envelope('window.studio.work.list(null)')).missions; assert.equal(parents.length, 1); const parentId = parents[0].id; ctx.proof.parent_id = parentId;
    const record = await envelope(`window.studio.work.inspect(${JSON.stringify(parentId)})`); assert.equal(record.mission.status, 'completed'); assert.equal(record.mission.artifacts[0].status, 'committed');
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('Boolean(document.querySelector(".yc-artifact-open"))');
    await click('.yc-work-artifact button', 'Open interactive preview');
    await waitFor('document.getElementById("yc-artifact-status")?.textContent.startsWith("Ready.")');
    await waitFor('window.studio.artifacts.state().then(value=>value.ok && value.result.visible)');
    const state = await envelope('window.studio.artifacts.state()'); assert.equal(state.sha256, sha(html)); assert.equal(state.name, 'material-estimator.html'); assert.equal(state.network, false);
    const page = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('yur-artifact://')); assert.ok(page);
    await page.executeJavaScript("document.getElementById('area').value='317'; document.getElementById('rate').value='4'; document.getElementById('calculate').click()", true);
    assert.equal(await page.executeJavaScript("document.getElementById('answer').textContent"), '$1,268');
    assert.deepEqual(await page.executeJavaScript('({node:typeof require,bridge:typeof studio,process:typeof process})'), { node: 'undefined', bridge: 'undefined', process: 'undefined' });
    const captured = await page.capturePage(undefined, { stayHidden: true }); assert.equal(captured.isEmpty(), false);
    const imagePath = path.join(ctx.tempRoot, 'artifact-native-calculation.png'); fs.writeFileSync(imagePath, captured.toPNG()); ctx.screenshots.calculation = imagePath;
    await ctx.capture('pane'); ctx.checks.push('Actual Work-created committed HTML opens by IDs, verified hash/name match, isolated native calculator returns $1,268 with no Node or Desktop bridge');
    await evaluate('document.getElementById("yc-conversation-actions").click()');
    await waitFor('Boolean(document.querySelector("dialog[open]"))');
    await waitFor('window.studio.artifacts.state().then(value=>value.ok && !value.result.visible)');
    await click('dialog button', 'Cancel'); await waitFor('window.studio.artifacts.state().then(value=>value.ok && value.result.visible)');
    await evaluate('document.getElementById("yc-close-details").click()'); await waitFor('window.studio.artifacts.state().then(value=>value.ok && !value.result.visible)');
    await evaluate('document.getElementById("yc-context-toggle").click(); document.getElementById("yc-artifact-tab").click()');
    await waitFor('window.studio.artifacts.state().then(value=>value.ok && value.result.visible)');
    await evaluate('document.getElementById("yc-browser-tab").click()');
    await waitFor('window.studio.artifacts.state().then(value=>value.ok && !value.result.visible)');
    await evaluate('document.getElementById("yc-artifact-tab").click()'); await waitFor('window.studio.artifacts.state().then(value=>value.ok && value.result.visible)');
    assert.equal((await envelope('window.studio.browser.state()')).visible, false);
    await evaluate('document.querySelector("[data-workspace=agents]").click()'); await waitFor('window.studio.artifacts.state().then(value=>value.ok && !value.result.visible)');
    ctx.checks.push('Native preview hides for a real modal, close, Browser tab and Agents navigation; reopening preserves the verified preview and panes remain mutually exclusive');
    await click('#yc-history .yc-history-item', goal); await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('Boolean(document.querySelector(".yc-artifact-open"))');
    await click('.yc-work-artifact button', 'Open interactive preview'); await waitFor('window.studio.artifacts.state().then(value=>value.ok && value.result.visible)');
    await evaluate('document.getElementById("yc-artifact-source").click()'); await waitFor('Boolean([...document.querySelectorAll(".yc-work-artifact details[open]")].find(node=>node.textContent.includes("Material estimator")))');
    await waitFor('window.studio.artifacts.state().then(value=>value.ok && !value.result.visible)');
    await click('.yc-work-artifact button', 'Export artifact'); await waitFor('document.querySelector(".yc-work-delivery").textContent.includes("Artifact exported.")');
    const delivered = await envelope(`window.studio.work.inspect(${JSON.stringify(parentId)})`); const artifact = delivered.mission.artifacts[0];
    assert.equal(artifact.delivery.status, 'applied'); assert.equal(fs.readFileSync(artifact.delivery.plan.path, 'utf8'), html); assert.equal(sha(fs.readFileSync(artifact.delivery.plan.path)), sha(html)); ctx.proof.delivery = artifact.delivery;
    await ctx.capture('source-and-export'); const calls = ctx.requests.length;
    await click('.yc-work-artifact button', 'Open interactive preview'); await waitFor('window.studio.artifacts.state().then(value=>value.ok && value.result.visible)');
    await ctx.reload();
    assert.equal((await envelope('window.studio.artifacts.state()')).visible, false, 'Reloaded conversation must not inherit an orphan visible preview');
    await click('#yc-history .yc-history-item', goal);
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('Boolean(document.querySelector(".yc-artifact-open"))'); await click('.yc-work-artifact button', 'Open interactive preview');
    await waitFor('document.getElementById("yc-artifact-status")?.textContent.startsWith("Ready.")'); await waitFor('window.studio.artifacts.state().then(value=>value.ok && value.result.visible)');
    assert.equal(ctx.requests.length, calls); assert.equal((await envelope('window.studio.artifacts.state()')).sha256, sha(html));
    const denied = await evaluate(`window.studio.artifacts.open(${JSON.stringify(parentId)},'00000000000000000000000000000000')`); assert.equal(denied.ok, false);
    ctx.checks.push('Source stays inert, explicit export commits exact HTML bytes, reload reopens the same artifact without model replay, and uncommitted IDs are denied');
  },
});
