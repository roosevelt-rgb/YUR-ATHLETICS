'use strict';
// Actual main/preload, Python missions and schedule dispatch. Provider answers
// are controlled loopback fixtures; observations must follow real operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const appRoot = path.resolve(__dirname, '..');
const monitored = ['src/main.js', 'src/preload.js', 'src/activity-feed.js', 'src/activity-view.js', 'src/activity-view.css',
  'src/work-transport.js', 'src/generation-transport.js', 'src/conversation-view.js', 'src/studio-editor.html',
  'src/schedule-dispatcher.js', 'foundry/work_engine.py', 'foundry/work_cli.py', 'tests/activity-smoke.cjs', 'tests/specialists-smoke.cjs'];
const fingerprints = () => Object.fromEntries(monitored.map(file => [file, sha(fs.readFileSync(path.join(appRoot, file)))]));
const before = fingerprints();
const model = 'activity-fixture';
const PRIVATE = 'PRIVATE_REASONING_MUST_NOT_REACH_ACTIVITY_82b4';
let releaseFirst, heldCancel = false, cancelSocketClosed = false;

nativeFixture({ prefix: 'activity', model, gracefulShutdown: true,
  afterShutdown(ctx) { const after = fingerprints(); assert.deepEqual(after, before); ctx.proof.source_verification = { before, after, changed: [] }; },
  handle({ goal, completed, call, send, response }) {
    if (goal.includes('ACTIVITY_CANCEL')) {
      heldCancel = true; response.on('close', () => { if (!response.writableEnded) cancelSocketClosed = true; }); return;
    }
    if (goal.includes('ACTIVITY_FIRST') && completed.length === 0) {
      releaseFirst = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ done: true, message: { role: 'assistant', content: '', thinking: PRIVATE,
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'story.md' } } }] } }));
      }; return;
    }
    if (goal.includes('ACTIVITY_SCHEDULE') && !completed.length) return call('read_file', { path: 'story.md' });
    if (completed.length) assert.equal(completed[0].name, 'read_file');
    send('ACTIVITY_DONE: the requested fixture operation finished.');
  },
  async run(ctx) {
    const { evaluate, envelope, waitFor } = ctx;
    const snapshot = () => envelope('studio.activity.snapshot()');
    const waitSnapshot = async predicate => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) { const value = await snapshot(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
      throw new Error('Timed out waiting for actual activity observation');
    };
    const waitProvider = async predicate => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('Timed out waiting for actual provider arrival');
    };
    const open = async () => { await evaluate('document.getElementById("yc-activity-open").click()'); await waitFor('Boolean(document.querySelector(".yc-activity-card, .yc-activity-empty"))'); };
    const request = goal => ({ request_id: randomUUID(), conversation_id: randomUUID(), mode: 'work', goal,
      root: ctx.sourceRoot, provider: 'ollama', model, messages: [{ role: 'user', content: goal }] });
    const launch = async (input, key) => evaluate(`(()=>{window[${JSON.stringify(key)}]=null; studio.work.start(${JSON.stringify(input)}).then(value=>window[${JSON.stringify(key)}]=value);return true;})()`);
    await open(); const empty = await snapshot(); assert.equal(empty.runs.length, 0);
    assert.equal((await evaluate('studio.activity.snapshot({include:"thinking"})')).ok, false);
    assert.equal(ctx.requests.length, 0);
    ctx.checks.push('Activity browsing uses the trusted no-argument read-only snapshot and starts no model, tool or mission');

    const first = request('ACTIVITY_FIRST: read the selected fixture file.'), second = request('ACTIVITY_SECOND: answer briefly.');
    await launch(first, '__activityFirst');
    await waitSnapshot(value => value.runs.some(run => run.id === first.request_id && run.request_active && run.events.some(event => event.kind === 'model')));
    await waitProvider(() => typeof releaseFirst === 'function');
    assert.equal(typeof releaseFirst, 'function');
    await launch(second, '__activitySecond');
    await waitSnapshot(value => value.runs.some(run => run.id === second.request_id && run.status === 'queued'));
    await waitFor('document.querySelectorAll(".yc-activity-card").length===2');
    await ctx.capture('active-and-queued');
    assert.equal(ctx.requests.length, 1, 'Queued work must not pretend to have called a model.');

    // Use the actual schedule form, which persists its conversation first.
    await evaluate('document.getElementById("yc-schedules-open").click()');
    await waitFor('Boolean(document.getElementById("yc-new-schedule"))');
    await evaluate('document.getElementById("yc-new-schedule").click()');
    await waitFor('Boolean(document.querySelector("dialog[open] #yc-field-schedule-name"))');
    const values = { 'schedule-name': 'Activity scheduled fixture', 'schedule-goal': 'ACTIVITY_SCHEDULE: read story.md.',
      'schedule-root': ctx.sourceRoot, 'schedule-model': model, 'schedule-interval': '1', 'schedule-max-runs': '1' };
    await evaluate(`for(const [key,value] of Object.entries(${JSON.stringify(values)})) document.getElementById('yc-field-'+key).value=value; document.getElementById('yc-field-schedule-enabled').checked=true; document.getElementById('yc-field-schedule-run-now').checked=true; document.querySelector('dialog[open] form').requestSubmit();`);
    await waitFor('!document.querySelector("dialog[open]")');
    const queued = await waitSnapshot(value => value.runs.some(run => run.origin === 'schedule' && run.status === 'queued'));
    const scheduledId = queued.runs.find(run => run.origin === 'schedule').id;
    await open(); await waitFor('document.querySelectorAll(".yc-activity-card").length===3'); await ctx.capture('scheduled-and-concurrent');
    ctx.checks.push('A held real provider request, another conversation and an actual scheduled mission appear together with one running worker and two genuinely queued requests');

    releaseFirst();
    const finished = await waitSnapshot(value => [first.request_id, second.request_id, scheduledId].every(id => value.runs.some(run => run.id === id && run.status === 'completed' && !run.request_active)));
    for (const id of [first.request_id, scheduledId]) {
      const observed = finished.runs.find(run => run.id === id);
      assert.equal(observed.tools.length, 1); assert.equal(observed.tools[0].name, 'read_file'); assert.equal(observed.tools[0].status, 'completed');
      const retained = await envelope(`studio.work.inspect(${JSON.stringify(observed.mission_id)})`);
      assert.equal(retained.mission.status, 'completed'); assert.equal(retained.mission.steps[0].tool, 'read_file');
      assert.equal(retained.mission.steps[0].succeeded, true);
    }
    assert.equal(JSON.stringify(finished).includes(PRIVATE), false);
    assert.equal(JSON.stringify(finished).includes('SOURCE_MARKER_92bd'), false);
    assert.equal(JSON.stringify(finished).includes('ACTIVITY_FIRST'), false);
    await waitFor('document.querySelectorAll(".yc-activity-card[data-status=completed]").length===3 && document.querySelectorAll(".yc-activity-tools li").length===2 && [...document.querySelectorAll(".yc-activity-tools li")].every(node=>node.textContent.includes("Completed"))');
    await evaluate('document.querySelectorAll(".yc-activity-card details").forEach(node=>node.open=true)');
    await ctx.capture('committed-tool-timeline');
    ctx.proof.work_request_ids = [first.request_id, second.request_id, scheduledId];
    ctx.proof.work_mission_ids = finished.runs.map(run => run.mission_id);
    ctx.checks.push('Live model and tool observations resolve to actual committed read_file outcomes; private reasoning, source contents and user prompts never enter the activity feed');

    const cancel = request('ACTIVITY_CANCEL: wait for operator cancellation.'); await launch(cancel, '__activityCancel');
    await waitSnapshot(value => value.runs.some(run => run.id === cancel.request_id && run.events.some(event => event.kind === 'model')));
    await waitProvider(() => heldCancel);
    assert.equal(heldCancel, true);
    const cancellation = await evaluate(`studio.work.cancel(${JSON.stringify(cancel.request_id)})`); assert.equal(cancellation.ok, true);
    await waitSnapshot(value => value.runs.some(run => run.id === cancel.request_id && run.status === 'cancelled' && !run.request_active));
    assert.equal(cancelSocketClosed, true);
    ctx.checks.push('Exact-request cancellation is observed through actual provider socket closure and runtime exit before the feed claims cancellation confirmed');

    // Streaming Chat runs through its real transport with a controlled provider.
    let releaseChat, chatCalls = 0;
    const original = process.env.YUR_OLLAMA_URL;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
      let input = ''; req.on('data', bytes => { input += bytes; if (Buffer.byteLength(input) > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        const body = JSON.parse(input); assert.equal(body.stream, true); chatCalls++;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'Public response', thinking: PRIVATE }, done: false }) + '\n');
        releaseChat = () => res.end(JSON.stringify({ message: { role: 'assistant', content: ' complete.' }, done: true }) + '\n');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.YUR_OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
    try {
      const chat = { request_id: randomUUID(), conversation_id: randomUUID(), provider: 'ollama', model,
        query: 'ACTIVITY_CHAT_PRIVATE_PROMPT', messages: [{ role: 'user', content: 'ACTIVITY_CHAT_PRIVATE_PROMPT' }] };
      await evaluate(`(()=>{studio.generation.start(${JSON.stringify(chat)}).then(value=>window.__activityChat=value);return true;})()`);
      const streaming = await waitSnapshot(value => value.runs.some(run => run.id === chat.request_id && run.request_active && run.output_chars > 0));
      assert.equal(JSON.stringify(streaming).includes(PRIVATE), false); assert.equal(JSON.stringify(streaming).includes('Public response'), false);
      await ctx.capture('chat-output-activity'); releaseChat();
      await waitSnapshot(value => value.runs.some(run => run.id === chat.request_id && run.status === 'completed' && !run.request_active));
      assert.equal(chatCalls, 1); ctx.proof.chat_requests = chatCalls;
    } finally { process.env.YUR_OLLAMA_URL = original; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    ctx.checks.push('Actual streaming Chat updates an output-character count while active; neither public answer text nor provider reasoning or prompt content enters aggregate telemetry');

    await envelope('studio.factory.open()');
    let factory;
    const factoryDeadline = Date.now() + 10000;
    while (Date.now() < factoryDeadline) { factory = BrowserWindow.getAllWindows().find(window => /factory\.html$/.test(window.webContents.getURL())); if (factory) break; await new Promise(resolve => setTimeout(resolve, 80)); }
    assert.ok(factory); factory.hide();
    const factoryResult = await factory.webContents.executeJavaScript('studio.factory.request({command:"process",max_missions:1})');
    assert.equal(factoryResult.ok, true); factory.close();
    await waitSnapshot(value => value.runs.some(run => run.kind === 'factory' && run.status === 'completed' && !run.request_active));
    const stable = await snapshot(), calls = ctx.requests.length;
    await ctx.reload(); await open();
    const reloaded = await snapshot(); assert.equal(reloaded.session_id, stable.session_id);
    assert.deepEqual(reloaded.runs.map(run => run.id), stable.runs.map(run => run.id)); assert.equal(ctx.requests.length, calls);
    assert.ok(reloaded.runs.every(run => !run.request_active));
    await ctx.capture('reloaded-activity');
    ctx.proof.final_snapshot = reloaded; ctx.proof.total_provider_calls = calls + chatCalls;
    ctx.checks.push('A separate real factory RPC is observed without giving it model authority; renderer reload restores host activity with the same request identities and zero replayed inference');
  },
});
