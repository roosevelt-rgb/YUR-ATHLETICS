'use strict';
// Native fixtures execute the real main/preload, manager, validators and commits.
// HTTP model replies and explicit shell reveal are fixtures; no donor is executed.
const { app, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');

function nativeFixture({ prefix, model, handle, run, timeoutMs = 180000, gracefulShutdown = false, afterShutdown = null }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Native fixture deadline must be bounded.');
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
    if (request.url === '/api/show') return reply(200, { capabilities: context.providerCapabilities || ['tools'] });
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
  const deadline = setTimeout(() => finish(new Error(`Native ${prefix} fixture exceeded ${timeoutMs / 1000} seconds`)), timeoutMs);
  async function finish(error) {
    if (finished) return; finished = true; clearTimeout(deadline); server.closeAllConnections?.(); server.close();
    if (gracefulShutdown) {
      // Let the actual main process close its owned setup connection on every
      // exit path, including handler assertions and the global test deadline.
      const observed = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 20000);
        app.once('will-quit', event => { event.preventDefault(); clearTimeout(timer); resolve(true); });
        app.quit();
      });
      context.proof.normal_shutdown_observed = observed;
      if (!observed && !error) error = new Error('Native desktop shutdown did not finish within 20 seconds');
      try { if (afterShutdown) await afterShutdown(context, observed); }
      catch (failure) { context.proof.shutdown_verification_error = failure.message; if (!error) error = failure; }
    }
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
    if (testWindow) return; testWindow = window; window.setFocusable(false); window.setOpacity(0); window.setPosition(-16000, -16000); window.setSkipTaskbar(true); window.setSize(1440, 960);
    window.webContents.setBackgroundThrottling(false);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { context.externalRequests.push(details.url); callback({ cancel: true }); });
    window.webContents.on('preload-error', (_event, _file, error) => context.rendererErrors.push(error.message));
    window.webContents.on('render-process-gone', (_event, details) => { void finish(new Error(`Renderer stopped: ${details.reason} (exit ${details.exitCode})`)); });
    window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) void finish(new Error(`Desktop failed to load: ${description} (${code})`)); });
    window.webContents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') context.rendererErrors.push(String(detail.message).slice(0, 1000)); });
    window.webContents.once('did-finish-load', () => execute(window).catch(async error => { try { await context.capture?.('failure'); } catch {} await finish(error); }));
  });
  server.on('error', finish);
  server.listen(0, '127.0.0.1', () => { const origin = `http://127.0.0.1:${server.address().port}`; process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin; require('../src/main.js'); });
}

function specialists() {
  const name = 'Native evidence specialist';
  nativeFixture({ prefix: 'specialists', model: 'specialist-tool-fixture',
    handle({ body, completed, goal, call, send, proof }) {
      assert.ok(body.tools.some(tool => tool.function.name === 'build_specialist'));
      assert.ok(body.tools.some(tool => tool.function.name === 'run_built_specialist'));
      if (goal.includes('NATIVE_REUSE_CHECK')) {
        if (!completed.length) return call('list_built_specialists', { limit: 20 });
        const catalog = completed[0].value; assert.equal(catalog.schema, 'yur.work-specialist-catalog.v1'); assert.equal(catalog.entries.length, 1); assert.equal(catalog.entries[0].mission_id, proof.child_id); assert.equal(catalog.entries[0].source_parent_work_id, proof.parent_id);
        if (completed.length === 1) return call('run_saved_specialist', { mission_id: proof.child_id, capability_id: 'text.analyze', input: { text: 'Saved workers stay reusable.' } });
        assert.equal(completed.length, 2); const result = completed[1].value; assert.equal(result.tool, 'run_saved_specialist'); assert.equal(result.mission_id, proof.child_id); assert.equal(result.output.word_count, 4); assert.equal(result.selection.source_parent_work_id, proof.parent_id); assert.notEqual(result.provenance.parent_work_id, proof.parent_id); proof.saved_run_id = result.run_id; proof.reuse_parent_id = result.provenance.parent_work_id;
        return send('SPECIALIST_REUSE_DONE: the same committed specialist ran on new input without rebuilding.');
      }
      if (!completed.length) return call('build_specialist', { name, description: 'Deterministic native fixture evidence analysis.', capabilities: ['text.analyze'] });
      const build = completed[0].value; assert.equal(build.schema, 'yur.work-specialist-result.v1'); assert.equal(build.committed, true); assert.equal(build.artifact.validation.passed, true); assert.equal(build.artifact.validation.independent_validation.passed, true);
      proof.child_id = build.mission_id; proof.artifact_digest = build.artifact.digest; proof.fixtures = build.artifact.validation.metrics;
      if (completed.length === 1) return call('run_built_specialist', { mission_id: build.mission_id, capability_id: 'text.analyze', input: { text: 'Alpha beta alpha.' } });
      assert.equal(completed.length, 2); const result = completed[1].value; assert.equal(result.mission_id, build.mission_id); assert.equal(result.committed, true); assert.equal(result.output.word_count, 3); assert.equal(result.output.sentence_count, 1);
      proof.output = result.output; proof.run_id = result.run_id; send('SPECIALIST_NATIVE_DONE: the committed specialist ran on fresh input.');
    },
    async run(ctx) {
      const { evaluate, waitFor, click, envelope } = ctx;
      const goal = 'Build a text analysis specialist and run it on Alpha beta alpha.';
      await evaluate(`document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change')); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit();`);
      await waitFor('document.getElementById("yc-messages").textContent.includes("SPECIALIST_NATIVE_DONE") && !document.getElementById("yc-send").disabled');
      const parents = (await envelope('window.studio.work.list(null)')).missions; assert.equal(parents.length, 1); const parentId = parents[0].id;
      const record = await envelope(`window.studio.work.inspect(${JSON.stringify(parentId)})`); assert.equal(record.mission.status, 'completed'); assert.deepEqual(record.mission.steps.map(step => step.tool), ['build_specialist', 'run_built_specialist']);
      assert.ok(record.mission.steps.every(step => step.succeeded)); ctx.proof.parent_id = parentId;
      await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-specialist-card").length===2');
      assert.equal(await evaluate(`document.querySelector('.yc-specialist-card h4').textContent`), name);
      assert.equal(await evaluate('document.querySelector(".yc-specialist-card").textContent.includes("Independent validation passed.")'), true);
      await ctx.capture('built-and-run'); ctx.checks.push('Real OM compiled and independently validated a specialist, then executed its admitted capability; UI shows committed cards and actual output');
      await evaluate('document.querySelector(".yc-specialist-output").scrollIntoView({block:"center"}); true;'); await ctx.capture('actual-output');
      await click('.yc-specialist-card button', 'Inspect specialist'); await waitFor('document.querySelector(".yc-specialist-export-status").textContent.includes("Current specialist record")');
      await click('.yc-specialist-card button', 'Export specialist pack'); await waitFor('document.querySelector(".yc-specialist-export-status").textContent.includes("Specialist pack exported.")');
      const exported = await envelope(`window.studio.work.exportSpecialist(${JSON.stringify(parentId)},${JSON.stringify(ctx.proof.child_id)})`);
      const pack = exported.export, relative = path.relative(ctx.tempRoot, pack.path); assert.equal(path.isAbsolute(relative) || relative.startsWith('..'), false);
      const bytes = fs.readFileSync(pack.path); assert.equal(bytes.length, pack.bytes); assert.equal(sha(bytes), pack.zip_digest); assert.equal(pack.artifact_digest, ctx.proof.artifact_digest); assert.equal(bytes.subarray(0, 2).toString(), 'PK'); ctx.proof.export = pack;
      await click('.yc-specialist-card button', 'Show exported pack'); const deadline = Date.now() + 3000; while (!ctx.reveals.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(ctx.reveals, [pack.path]);
      await evaluate('document.querySelector(".yc-specialist-export-status").scrollIntoView({block:"center"}); true;');
      await ctx.capture('exported-pack'); ctx.checks.push('Actual parent-bound inspect/export/reveal validates ZIP bytes, artifact digest and native reveal destination');
      const before = ctx.requests.length; await ctx.reload(); await click('#yc-history .yc-history-item', goal);
      await waitFor('Boolean(document.querySelector(".yc-open-work"))'); await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-specialist-card").length===2');
      assert.equal(ctx.requests.length, before); const child = await envelope(`window.studio.work.inspectSpecialist(${JSON.stringify(parentId)},${JSON.stringify(ctx.proof.child_id)})`); assert.equal(child.specialist.id, ctx.proof.child_id);
      const denied = await evaluate(`window.studio.work.inspectSpecialist('00000000000000000000000000000000',${JSON.stringify(ctx.proof.child_id)})`); assert.equal(denied.ok, false);
      assert.equal(sha(fs.readFileSync(pack.path)), pack.zip_digest); ctx.checks.push('Reload restores the same specialist/run/export without provider replay, and an unrelated parent cannot inspect that child');
      const beforeBrowse = ctx.requests.length;
      await evaluate('document.querySelector("[data-workspace=agents]").click(); document.getElementById("yc-built-toggle").click()');
      await waitFor('document.getElementById("yc-catalog-note").textContent.includes("1 saved builds") && document.querySelectorAll(".yc-resource-card").length===1');
      await click('.yc-resource-card', await evaluate('document.querySelector(".yc-resource-card").textContent.trim()'));
      await waitFor('Boolean(document.querySelector(".yc-saved-specialist"))');
      await click('.yc-saved-specialist button', 'Inspect specialist'); await waitFor('document.querySelector(".yc-saved-specialist").textContent.includes("Current specialist record")');
      await click('.yc-saved-specialist button', 'Export specialist pack'); await waitFor('document.querySelector(".yc-saved-specialist").textContent.includes("Specialist pack exported.")');
      await ctx.capture('saved-library');
      await click('.yc-saved-specialist button', 'Use in conversation');
      assert.equal(await evaluate('document.getElementById("yc-mode").value'), 'work'); assert.equal(await evaluate('document.getElementById("yc-input").value.includes(' + JSON.stringify(ctx.proof.child_id) + ')'), true); assert.equal(ctx.requests.length, beforeBrowse);
      ctx.checks.push('Agents Built specialists discovers the real committed build without a model request; source-parent inspect/export work and Use only prepares an editable Work draft');
      await evaluate('document.getElementById("yc-input").value+="\\nNATIVE_REUSE_CHECK: run text analysis on Saved workers stay reusable."; document.getElementById("yc-form").requestSubmit()');
      await waitFor('document.getElementById("yc-messages").textContent.includes("SPECIALIST_REUSE_DONE") && !document.getElementById("yc-send").disabled');
      await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()');
      await waitFor('Boolean(document.querySelector(".yc-specialist-catalog")) && document.querySelector(".yc-specialist-card .yc-specialist-eyebrow")?.textContent==="SAVED SPECIALIST RESULT"');
      assert.equal(await evaluate('document.querySelector(".yc-specialist-output").textContent.includes("4")'), true);
      await click('.yc-specialist-card button', 'Inspect specialist'); await waitFor('document.querySelector(".yc-specialist-card").textContent.includes("Current specialist record")');
      const reuse = await envelope(`window.studio.work.inspect(${JSON.stringify(ctx.proof.reuse_parent_id)})`); assert.deepEqual(reuse.mission.steps.map(step => step.tool), ['list_built_specialists', 'run_saved_specialist']);
      const saved = await envelope('window.studio.specialists.list(20,null)'); assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].mission_id, ctx.proof.child_id);
      await evaluate('document.querySelector(".yc-specialist-output").scrollIntoView({block:"center"}); true;'); await ctx.capture('saved-run-output');
      ctx.checks.push('A later real Work request discovers and runs the same specialist with fresh input, creates no duplicate build, and saved-run Inspect resolves its original build parent');
    },
  });
}

module.exports = { nativeFixture, sha };
// Electron loads the entry through its default-app module, so require.main is
// not a portable entry check here. Importing this helper must never launch a
// second fixture; the regression entry adapter preserves the selected argv path.
if (path.basename(process.argv[1] || '') === 'specialists-smoke.cjs') specialists();
