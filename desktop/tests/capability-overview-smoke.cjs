'use strict';
// Real Desktop/main/preload and committed Work; provider replies are loopback
// fixtures. Browsing the description never calls a model or starts a worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const { loadCapabilities } = require('../src/desktop-capabilities');

const appRoot = path.resolve(__dirname, '..');
const monitored = ['tests/capability-overview-smoke.cjs', 'tests/specialists-smoke.cjs',
  'desktop-capabilities.json', 'src/desktop-capabilities.js', 'src/main.js', 'src/preload.js',
  'src/conversation-view.js', 'src/conversation.css', 'src/studio-editor.html',
  'src/generation-transport.js', 'src/work-transport.js', 'src/conversation-transport.js',
  'src/model-setup.js', 'src/desktop-runtime.js', 'src/embedded-runtime.js',
  ...fs.readdirSync(path.join(appRoot, 'foundry')).filter(name => name.endsWith('.py')).map(name => `foundry/${name}`)];
const fingerprints = () => Object.fromEntries(monitored.map(name => [name, sha(fs.readFileSync(path.join(appRoot, name)))]));
const before = fingerprints(), loaded = loadCapabilities();
const model = 'capability-overview-fixture';
const chatRequests = []; let chatServer = null, originalOllama = null;
function checkContext(body, route) {
  const content = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(content.includes('yur.desktop-capabilities.v1'), `${route} must receive the host-owned capability schema`);
  assert.ok(content.includes(loaded.sha256), `${route} must receive the exact loaded manifest hash`);
  for (const phrase of ['Projects', 'Studio', 'specialist', 'reference']) assert.ok(content.toLowerCase().includes(phrase.toLowerCase()), `${route} must describe the wider Desktop, including ${phrase}`);
  return { route, schema: loaded.manifest.schema, manifest_sha256: loaded.sha256, compiled_system_sha256: sha(content), compiled_system_bytes: Buffer.byteLength(content) };
}
async function closeChatServer() {
  if (originalOllama !== null) { process.env.YUR_OLLAMA_URL = originalOllama; originalOllama = null; }
  if (chatServer) { const server = chatServer; chatServer = null; server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}

nativeFixture({ prefix: 'capability-overview', model, gracefulShutdown: true,
  async afterShutdown(ctx, observed) {
    await closeChatServer();
    const after = fingerprints(); ctx.proof.source_verification = { before, after, changed: Object.keys(before).filter(name => before[name] !== after[name]) };
    ctx.proof.chat_provider_calls = chatRequests.length; ctx.proof.work_provider_calls = ctx.requests.length;
    ctx.proof.total_provider_calls = chatRequests.length + ctx.requests.length;
    assert.deepEqual(after, before); assert.equal(observed, true);
  },
  handle({ body, completed, goal, send, proof }) {
    assert.ok(goal.includes('CAPABILITY_WORK_REQUEST')); assert.equal(completed.length, 0);
    assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'Work still receives its actual typed tool catalog');
    proof.work_context = checkContext(body, 'work');
    send('CAPABILITY_WORK_DONE: the desktop description was supplied alongside this mission’s typed tools.');
  },
  async run(ctx) {
    const { evaluate, envelope, waitFor } = ctx;
    const openOverview = async () => {
      await evaluate('document.querySelector(\'[data-workspace="tools"]\').click()');
      await waitFor(`document.getElementById('yc-capability-overview')?.dataset.manifestSha256===${JSON.stringify(loaded.sha256)} && document.getElementById('yc-capability-overview').getAttribute('aria-busy')==='false'`);
    };
    const description = await envelope('studio.capabilities.describe()'); assert.deepEqual(description, loaded);
    const rejected = await evaluate('studio.capabilities.describe({path:"not-an-input"})');
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'INVALID_REQUEST');
    await openOverview();
    const overview = await evaluate(`(()=>{const host=document.getElementById('yc-capability-overview');return {title:document.getElementById('yc-thread-title').textContent,text:host.textContent,features:[...host.querySelectorAll('.yc-capability-feature')].map(card=>({id:card.dataset.featureId,access:card.dataset.access,text:card.textContent})),legacy:document.getElementById('yc-catalog-note').textContent}})()`);
    assert.equal(overview.title, 'Capabilities'); assert.equal(overview.features.length, loaded.manifest.features.length);
    for (const feature of loaded.manifest.features) {
      const card = overview.features.find(item => item.id === feature.id); assert.ok(card); assert.equal(card.access, feature.access);
      for (const text of [feature.label, feature.surface, feature.summary, ...feature.requirements, ...feature.limitations]) assert.ok(card.text.includes(text), `Missing actual feature text: ${feature.id}`);
    }
    assert.ok(overview.text.includes(loaded.manifest.identity)); assert.ok(overview.text.includes(loaded.manifest.availability_policy));
    for (const boundary of loaded.manifest.boundaries) assert.ok(overview.text.includes(boundary));
    assert.match(overview.legacy, /Legacy workspace definitions.*live runtime availability has not been reported/);
    assert.equal(ctx.requests.length + chatRequests.length, 0);
    ctx.proof.manifest = { schema: loaded.manifest.schema, sha256: loaded.sha256, feature_count: loaded.manifest.features.length,
      access_counts: Object.fromEntries(['desktop_ui', 'model_tools', 'conditional', 'reference_catalog'].map(access => [access, overview.features.filter(feature => feature.access === access).length])) };
    await ctx.capture('desktop-overview');
    await evaluate('document.querySelector(\'.yc-capability-group[data-access="reference_catalog"]\').scrollIntoView({block:"start"})'); await ctx.capture('reference-boundaries');
    await evaluate('document.querySelector(\'.yc-capability-group[data-access="conditional"]\').scrollIntoView({block:"start"})'); await ctx.capture('conditional-features');
    ctx.checks.push('The real trusted IPC returns the verified host manifest, rejects arguments, and the Capabilities page displays all actual features and separate conditional/reference/legacy boundaries with zero provider calls');

    await evaluate('document.getElementById("yc-section-search").value="reference"; document.getElementById("yc-section-search").dispatchEvent(new Event("input"))');
    const filtered = await evaluate('[...document.querySelectorAll(".yc-capability-feature")].map(card=>card.dataset.featureId)');
    const expected = loaded.manifest.features.filter(feature => [feature.label, feature.surface, feature.summary, ...feature.requirements, ...feature.limitations].join('\n').toLowerCase().includes('reference')).map(feature => feature.id);
    assert.deepEqual([...filtered].sort(), [...expected].sort());
    await evaluate('document.getElementById("yc-section-search").value=""; document.getElementById("yc-section-search").dispatchEvent(new Event("input")); document.getElementById("yc-capability-refresh").click()');
    await waitFor('!document.getElementById("yc-capability-refresh").disabled');
    await evaluate('document.querySelector(\'[data-workspace="agents"]\').click()');
    assert.equal(await evaluate('document.getElementById("yc-capability-overview").classList.contains("yc-hidden")'), true);
    await openOverview(); await ctx.reload(); await openOverview(); assert.equal(ctx.requests.length + chatRequests.length, 0);
    ctx.checks.push('Search, refresh, navigation and renderer reload retain the exact host description without model inference or falsely activating catalog entries');

    await evaluate('document.getElementById("yc-back-chat").click()');
    await waitFor('!document.getElementById("yc-main").classList.contains("section-open")');
    // A separate fixture serves streaming Chat. The common Work fixture keeps
    // its strict stream:false contract; no production parser is replaced.
    chatServer = http.createServer((request, response) => {
      if (request.url === '/api/tags') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ models: [{ name: model }] })); return; }
      if (request.method !== 'POST' || request.url !== '/api/chat') { response.writeHead(404); response.end(); return; }
      let input = ''; request.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 1024 * 1024) request.destroy(); });
      request.on('end', () => {
        try {
          const body = JSON.parse(input); chatRequests.push(body); assert.equal(body.model, model); assert.equal(body.stream, true);
          ctx.proof.chat_context = checkContext(body, 'chat'); assert.equal(body.tools, undefined);
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          response.end(JSON.stringify({ message: { role: 'assistant', content: 'CAPABILITY_CHAT_DONE: the whole Desktop description was supplied to Chat.' }, done: true }) + '\n');
        } catch (error) { ctx.proof.chat_fixture_error = error.message; response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
      });
    });
    await new Promise((resolve, reject) => { chatServer.once('error', reject); chatServer.listen(0, '127.0.0.1', resolve); });
    originalOllama = process.env.YUR_OLLAMA_URL; process.env.YUR_OLLAMA_URL = `http://127.0.0.1:${chatServer.address().port}`;
    try {
      await evaluate(`document.getElementById('yc-model').value=${JSON.stringify('ollama:' + model)}; document.getElementById('yc-model').dispatchEvent(new Event('change')); document.querySelector('#yc-mode-switch [data-mode="chat"]').click(); document.getElementById('yc-input').value='CAPABILITY_CHAT_REQUEST: explain what this desktop can do.'; document.getElementById('yc-input').dispatchEvent(new Event('input')); document.getElementById('yc-form').requestSubmit()`);
      await waitFor('document.getElementById("yc-messages").textContent.includes("CAPABILITY_CHAT_DONE") && !document.getElementById("yc-send").disabled');
      assert.equal(chatRequests.length, 1); assert.equal(ctx.requests.length, 0);
    } finally { await closeChatServer(); }
    ctx.checks.push('Actual Chat transport sends the manifest schema, exact hash and full-Desktop context to a loopback streaming provider without granting model tool access');

    await evaluate('document.querySelector(\'#yc-mode-switch [data-mode="work"]\').click(); document.getElementById("yc-input").value="CAPABILITY_WORK_REQUEST: explain the Desktop and this mission’s executable scope."; document.getElementById("yc-input").dispatchEvent(new Event("input")); document.getElementById("yc-form").requestSubmit()');
    await waitFor('document.getElementById("yc-messages").textContent.includes("CAPABILITY_WORK_DONE") && !document.getElementById("yc-send").disabled');
    const list = await envelope('studio.work.list(null)'); assert.equal(list.missions.length, 1);
    const record = await envelope(`studio.work.inspect(${JSON.stringify(list.missions[0].id)})`);
    assert.equal(record.mission.status, 'completed'); assert.equal(record.mission.steps.length, 0); assert.equal(record.mission.artifacts.length, 0);
    ctx.proof.work_mission_id = record.mission.id; assert.equal(ctx.requests.length, 1); assert.equal(chatRequests.length, 1);
    await ctx.reload(); await openOverview();
    const restored = await envelope(`studio.work.inspect(${JSON.stringify(record.mission.id)})`); assert.equal(restored.mission.revision, record.mission.revision);
    assert.equal(ctx.requests.length, 1); assert.equal(chatRequests.length, 1);
    ctx.checks.push('Actual Work provider context contains the same manifest and its independent typed tool catalog; the committed response and overview reopen without replaying inference or tool execution');
  },
});
