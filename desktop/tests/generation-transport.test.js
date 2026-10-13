'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createGenerationTransport, validateGeneration, resolveEndpointSettings } = require('../src/generation-transport');
const { loadCapabilities } = require('../src/desktop-capabilities');

const request = (fields = {}) => ({ request_id: randomUUID(), conversation_id: randomUUID(), provider: 'ollama', model: 'fixture-local', messages: [{ role: 'user', content: 'Test a real HTTP transport.' }], ...fields });
const record = (content, done = false, extra = {}) => JSON.stringify({ model: 'fixture-local', message: { role: 'assistant', content }, done, ...extra }) + '\n';

async function fixture(t, handler, options = {}) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const transport = createGenerationTransport({ getEndpoints: () => ({ foundry: { url }, ollama: { url } }), onEvent: (event, owner) => events.push({ ...event, owner }), timeoutMs: 1000, ...options });
  t.after(() => { transport.dispose(); return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  return { transport, events };
}

test('generation input is a bounded text contract without model-controlled action authority', () => {
  const input = request();
  const validated = validateGeneration(input);
  input.messages[0].content = 'changed';
  assert.notEqual(input.messages[0].content, validated.messages[0].content);
  for (const invalid of [null, request({ request_id: 'bad' }), request({ provider: 'shell' }), request({ model: '' }), request({ tools: [{ name: 'write' }] }), request({ messages: [{ role: 'user', content: 'x', root: 'C:/' }] }), request({ messages: [{ role: 'tool', content: 'untrusted tool result' }] }), request({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }), request({ provider: 'foundry', query: '' })]) assert.throws(() => validateGeneration(invalid));
});

test('endpoint settings preserve host overrides and prohibit credentials and cleartext remote traffic', () => {
  const endpoints = resolveEndpointSettings({ foundry_url: 'https://foundry.example', ollama_url: 'http://[::1]:11434' }, { YUR_FOUNDRY_URL: 'http://127.0.0.1:9922' });
  assert.deepEqual(endpoints.foundry, { url: 'http://127.0.0.1:9922', source: 'environment' });
  assert.deepEqual(endpoints.ollama, { url: 'http://[::1]:11434', source: 'settings' });
  assert.equal(resolveEndpointSettings().foundry.source, 'default');
  for (const url of ['http://192.168.1.10:11434', 'http://example.com', 'https://user:token@example.com', 'https://example.com/path', 'https://example.com?token=x']) assert.throws(() => resolveEndpointSettings({ foundry_url: url }));
  assert.throws(() => resolveEndpointSettings({ foundry_url: 'http://remote.example' }, { YUR_FOUNDRY_URL: 'http://localhost' }), /HTTPS/);
});

test('image context is bounded and sent only after actual model vision capability discovery', async t => {
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(512 * 1024)]).toString('base64');
  const input = request({ messages: [{ role: 'user', content: 'Describe this image.', images: [png] }] });
  assert.equal(validateGeneration(input).messages[0].images[0], png);
  for (const invalid of [request({ provider: 'foundry', query: 'image', messages: input.messages }), request({ messages: [{ role: 'assistant', content: '', images: [png] }] }), request({ messages: [{ role: 'user', content: '', images: ['not-base64'] }] }), request({ messages: [{ role: 'user', content: '', images: Array(6).fill(png) }] })]) assert.throws(() => validateGeneration(invalid));
  const seen = [];
  const { transport } = await fixture(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); seen.push(req.url);
    if (req.url === '/api/show') { assert.equal(body.model, input.model); res.end(JSON.stringify({ capabilities: ['completion', 'vision'] })); }
    else { assert.equal(body.messages.find(message => message.role === 'user').images[0], png); res.end(record('Image received.', true)); }
  });
  const result = await transport.start(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(seen, ['/api/show', '/api/chat']);
  assert.equal(result.result.evidence.vision.capability, 'vision');
});

test('models without advertised vision never receive image bytes', async t => {
  const { transport } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/api/show');
    res.end(JSON.stringify({ capabilities: ['completion'] }));
  });
  const response = await transport.start(request({ messages: [{ role: 'user', content: 'Image', images: [Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')] }] }));
  assert.equal(response.ok, false);
  assert.match(response.error.message, /vision/);
});

test('Ollama streams actual deltas across fragmented Unicode and preserves native tool calls without executing them', async t => {
  let body;
  const tool = { function: { name: 'read_file', arguments: { path: 'src/main.js' } } };
  const { transport, events } = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/api/chat');
    let input = ''; for await (const chunk of req) input += chunk;
    body = JSON.parse(input);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const first = Buffer.from(record('雪'));
    const unicodeIndex = first.indexOf(Buffer.from('雪'));
    res.write(first.subarray(0, unicodeIndex + 1));
    setImmediate(() => { res.write(first.subarray(unicodeIndex + 1)); res.end(record(' response', false, { message: { content: ' response', tool_calls: [tool] } }) + record('', true, { eval_count: 2 }).trimEnd()); });
  });
  const input = request(); const owner = {};
  const response = await transport.start(input, owner);
  assert.equal(body.stream, true);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.answer, '雪 response');
  assert.deepEqual(response.result.evidence.tool_calls, [tool]);
  assert.equal(response.result.evidence.tool_execution, 'not-executed');
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['雪', ' response']);
  for (const event of events) { assert.equal(event.request_id, input.request_id); assert.equal(event.conversation_id, input.conversation_id); assert.equal(event.owner, owner); }
});

test('Foundry preserves its JSON response and evidence without fabricating streaming tokens', async t => {
  let body;
  const { transport, events } = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/api/ask');
    let input = ''; for await (const chunk of req) input += chunk;
    body = JSON.parse(input);
    res.end(JSON.stringify({ answer: 'Verified fixture response', provider: 'configured-service', model: 'selected-model', citations: [{ file: 'a.md', line: 2 }], tool_calls: [] }));
  });
  const result = await transport.start(request({ provider: 'foundry', model: 'selected-model', query: 'Compiled transcript' }));
  assert.equal(body.provider, 'auto'); assert.equal(body.model, 'selected-model');
  assert.match(body.query, /yur.desktop-capabilities.v1/); assert.ok(body.query.endsWith('Compiled transcript'));
  assert.equal(result.result.answer, 'Verified fixture response');
  assert.equal(result.result.provider, 'configured-service');
  assert.deepEqual(result.result.evidence.citations, [{ file: 'a.md', line: 2 }]);
  assert.equal(events.some(event => event.type === 'delta'), false);
});

test('both Chat providers receive the source-owned overview and cannot forge its retained provenance', async t => {
  const loaded = loadCapabilities(), requests = [];
  const { transport } = await fixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const content = req.url === '/api/chat' ? body.messages[0].content : body.query;
    assert.ok(content.includes(loaded.sha256)); assert.match(content, /YUR AI is a local-first desktop/);
    assert.match(content, /Projects and shared reference files/); assert.match(content, /Awesome Copilot/);
    assert.match(content, /reference_catalog/); assert.match(content, /Chat can reason.*executes no model tool calls/);
    const metadata = {desktop_capabilities:{sha256:'provider-forgery',readiness:'all-ready'}};
    res.end(req.url === '/api/chat' ? record('Capabilities fixture answer',true,metadata) : JSON.stringify({answer:'Capabilities fixture answer',...metadata}));
  });
  for (const provider of ['ollama','foundry']) {
    const input = request({provider,query:'What can YUR do?'}), original = JSON.parse(JSON.stringify(input));
    const result = await transport.start(input);
    assert.equal(result.ok,true,JSON.stringify(result)); assert.deepEqual(input,original);
    assert.deepEqual(result.result.evidence.desktop_capabilities,{schema:loaded.manifest.schema,sha256:loaded.sha256,mode:'chat',readiness:'not_checked'});
  }
  assert.equal(requests.length,2); assert.equal(requests[0].messages[0].role,'system');
  assert.equal(requests[0].tools,undefined); assert.equal(requests[1].tools,undefined);
});

test('host overview preserves original total request limits instead of silently truncating user context', async t => {
  let calls = 0;
  const { transport } = await fixture(t, (_req,res) => {calls++; res.end(record('Unexpected',true));});
  const result = await transport.start(request({provider:'foundry', query:'x'.repeat(256 * 1024)}));
  assert.equal(result.ok,false); assert.equal(result.error.code,'CAPABILITY_CONTEXT_UNAVAILABLE'); assert.equal(calls,0);
});

test('cancellation aborts only the owning request, keeps partial text, and frees conversation capacity', async t => {
  let ready;
  const received = new Promise(resolve => { ready = resolve; });
  let calls = 0;
  const { transport, events } = await fixture(t, (_req, res) => {
    if (++calls > 1) { res.end(record('Other session', true)); return; }
    res.writeHead(200); res.write(record('Partial response'));
  }, { onEvent: event => { if (event.type === 'delta' && event.text === 'Partial response') ready(); } });
  const owner = {}; const input = request();
  const pending = transport.start(input, owner);
  await received;
  assert.equal(transport.cancel(input.request_id, {}).result.cancelled, false);
  assert.equal((await transport.start(input, owner)).error.code, 'DUPLICATE_REQUEST');
  assert.equal((await transport.start(request({ conversation_id: input.conversation_id }), owner)).error.code, 'BUSY');
  assert.equal((await transport.start(request(), owner)).result.answer, 'Other session');
  assert.equal(transport.cancel(input.request_id, owner).result.cancelled, true);
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'CANCELLED');
  assert.equal(cancelled.error.partial_answer, 'Partial response');
  assert.equal((await transport.start(request({ conversation_id: input.conversation_id }), owner)).ok, true);
  assert.equal(transport.cancel(input.request_id, owner).result.cancelled, false);
  assert.equal(events.length, 0); // Custom event callback was used above.
});

test('malformed, incomplete, oversized and failed HTTP streams never report completion', async t => {
  let mode;
  const { transport } = await fixture(t, (_req, res) => {
    if (mode === 'invalid') res.end('not-json\n');
    else if (mode === 'incomplete') res.end(record('partial'));
    else if (mode === 'after-done') res.end(record('complete', true) + record('extra'));
    else if (mode === 'large') res.end(record('x'.repeat(101), true));
    else if (mode === 'provider-error') res.end('{"error":"model unavailable"}\n');
    else { res.writeHead(503); res.end('{"error":"unavailable"}'); }
  }, { maxAnswerBytes: 100 });
  for (mode of ['invalid', 'incomplete', 'after-done', 'large', 'provider-error', 'http']) {
    const response = await transport.start(request());
    assert.equal(response.ok, false, mode);
    assert.equal(response.error.code, 'GENERATION_FAILED', mode);
  }
});

test('deadline, global concurrency and owner disposal bound active provider requests', async t => {
  const { transport } = await fixture(t, () => {}, { timeoutMs: 40, maxConcurrent: 2 });
  const ownerA = {}; const ownerB = {};
  const pendingA = transport.start(request(), ownerA);
  const pendingB = transport.start(request(), ownerB);
  assert.equal((await transport.start(request())).error.code, 'BUSY');
  transport.cancelOwner(ownerA);
  assert.equal((await pendingA).error.code, 'CANCELLED');
  const timeout = await pendingB;
  assert.equal(timeout.error.code, 'GENERATION_FAILED');
  assert.match(timeout.error.message, /timed out/);
});

test('activity reports provider lifecycle and public character totals without answer or private reasoning content', async t => {
  const activity = [], owner = {}, input = request({ messages: [{ role: 'user', content: 'PROMPT_MUST_NOT_LEAK' }] });
  const { transport } = await fixture(t, (_req, res) => {
    res.writeHead(200); res.write(JSON.stringify({ message: { thinking: 'PRIVATE_REASONING_MUST_NOT_LEAK', content: 'Hi 🚀' }, done: false }) + '\n');
    res.end(record('!', true));
  }, { onActivity: (event, actualOwner) => activity.push({ event, owner: actualOwner }) });
  const result = await transport.start(input, owner); assert.equal(result.ok, true); assert.equal(result.result.answer, 'Hi 🚀!');
  assert.deepEqual(activity[0], { owner, event: { type: 'begin', id: input.request_id, kind: 'chat', origin: 'conversation',
    conversation_id: input.conversation_id, provider: input.provider, model: input.model, phase: 'model_running' } });
  assert.ok(activity.some(item => item.event.phase === 'streaming' && item.event.output_chars === 4));
  assert.deepEqual(activity.at(-1), { owner, event: { type: 'finish', id: input.request_id, phase: 'completed', output_chars: 5 } });
  assert.doesNotMatch(JSON.stringify(activity), /PROMPT|PRIVATE|Hi|🚀|thinking|tool_calls/);
});

test('activity Stop remains pending until provider cancellation settles and does not notify for a foreign owner', async t => {
  const activity = []; let ready;
  const received = new Promise(resolve => { ready = resolve; });
  const { transport } = await fixture(t, (_req, res) => { res.writeHead(200); res.write(record('held')); ready(); },
    { onActivity: event => activity.push(event) });
  const input = request(), owner = {}; const pending = transport.start(input, owner); await received;
  const before = activity.length;
  assert.equal(transport.cancel(input.request_id, {}).result.cancelled, false); assert.equal(activity.length, before);
  assert.equal(transport.cancel(input.request_id, owner).result.cancelled, true);
  assert.equal(activity.at(-1).phase, 'stopping'); assert.equal(activity.some(event => event.type === 'finish'), false);
  assert.equal((await pending).error.code, 'CANCELLED'); assert.equal(activity.at(-1).phase, 'cancelled');
  assert.equal(activity.filter(event => event.type === 'finish').length, 1);
});

test('activity observers cannot stop generation and validation failures create no phantom run', async t => {
  let observations = 0;
  const { transport } = await fixture(t, (_req, res) => res.end(record('Complete', true)),
    { onActivity: () => { observations++; throw new Error('observer unavailable'); } });
  assert.equal((await transport.start(request({ request_id: 'bad' }))).ok, false); assert.equal(observations, 0);
  assert.equal((await transport.start(request())).ok, true); assert.ok(observations >= 2);
});
