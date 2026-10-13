'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFoundryTransport, normalizeFoundryUrl } = require('../src/foundry-transport');

async function serverFor(t, handler, options = {}) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return createFoundryTransport({ getBaseUrl: () => url, configured: () => true, timeoutMs: 1000, ...options });
}

test('Foundry preserves the existing ask payload and HTTP result contract', async t => {
  const expected = { query: 'A quoted "intent" with history\nUser: 雪', provider: 'auto', model: 'local-specialist' };
  const transport = await serverFor(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/ask');
    assert.equal(req.headers['content-type'], 'application/json');
    let input = ''; for await (const chunk of req) input += chunk;
    assert.deepEqual(JSON.parse(input), expected);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answer: 'Existing harness answer', provider: 'local', model: 'local-specialist' }));
  });
  assert.equal(transport.info().configured, true);
  const result = await transport.request('POST', '/api/ask', expected);
  assert.deepEqual(result, { status: 200, json: { answer: 'Existing harness answer', provider: 'local', model: 'local-specialist' } });
});

test('service configuration permits HTTP(S) origins only', () => {
  assert.equal(normalizeFoundryUrl('https://localhost:8844/'), 'https://localhost:8844');
  for (const value of [null, '', 'ftp://localhost', 'http://user:password@localhost', 'http://localhost/api', 'http://localhost/?key=x', 'http://localhost/#x', 'http://192.168.1.20', 'http://remote.example']) assert.throws(() => normalizeFoundryUrl(value));
  assert.throws(() => createFoundryTransport({ timeoutMs: 0 }));
});

test('invalid paths and oversized or malformed requests never reach the service', async t => {
  let requests = 0;
  const transport = await serverFor(t, (_req, res) => { requests += 1; res.end('{}'); }, { maxRequestBytes: 64 });
  for (const apiPath of ['/api/../private', '/api/%2e%2e/private', 'https://example.com/api/ask', '//example.com/api/ask', '/api/ask#fragment', '/api/ask\\private', '/api/a\u0000']) await assert.rejects(transport.request('GET', apiPath));
  await assert.rejects(transport.request('DELETE', '/api/ask'));
  await assert.rejects(transport.request('GET', '/api/health', undefined, 2000), /deadline/);
  await assert.rejects(transport.request('GET', '/api/ask', {}));
  await assert.rejects(transport.request('POST', '/api/ask', { query: 'x'.repeat(100) }), /size limit/);
  const circular = {}; circular.self = circular;
  await assert.rejects(transport.request('POST', '/api/ask', circular));
  assert.equal(requests, 0);
  assert.deepEqual(await transport.request('GET', '/api/models'), { status: 200, json: {} });
});

test('HTTP errors remain errors and redirects are never followed', async t => {
  let requests = 0;
  const transport = await serverFor(t, (req, res) => {
    requests += 1;
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: '/api/target' }); res.end('{"error":"moved"}'); }
    else { res.writeHead(503); res.end('{"error":"provider unavailable"}'); }
  });
  assert.deepEqual(await transport.request('GET', '/api/health'), { status: 503, json: { error: 'provider unavailable' } });
  assert.equal((await transport.request('GET', '/api/redirect')).status, 302);
  assert.equal(requests, 2);
});

test('malformed, truncated and oversized service responses fail closed', async t => {
  const transport = await serverFor(t, (req, res) => {
    if (req.url === '/api/invalid') res.end('<html>not JSON</html>');
    else if (req.url === '/api/large') res.end(JSON.stringify({ answer: 'x'.repeat(200) }));
    else { res.writeHead(200, { 'Content-Length': '500' }); res.end('{}'); setImmediate(() => res.socket?.destroy()); }
  }, { maxResponseBytes: 100 });
  await assert.rejects(transport.request('GET', '/api/invalid'), /invalid JSON/);
  await assert.rejects(transport.request('GET', '/api/large'), /size limit/);
  await assert.rejects(transport.request('GET', '/api/truncated'), /interrupted|timed out/);
});

test('absolute deadline bounds a trickling response and capacity recovers after failures', async t => {
  const transport = await serverFor(t, (req, res) => {
    if (req.url === '/api/health') { res.end('{"ready":true}'); return; }
    res.writeHead(200);
    const ticker = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(ticker));
  }, { timeoutMs: 70 });
  const pending = Array.from({ length: 4 }, () => transport.request('GET', '/api/slow').then(() => null, error => error));
  await assert.rejects(transport.request('GET', '/api/slow'), /busy/);
  const failures = await Promise.all(pending);
  for (const error of failures) assert.match(error.message, /timed out/);
  assert.deepEqual(await transport.request('GET', '/api/health'), { status: 200, json: { ready: true } });
});

test('health and discovery requests can use a shorter deadline than inference', async t => {
  const transport = await serverFor(t, (_req, _res) => {}, { timeoutMs: 1000 });
  await assert.rejects(transport.request('GET', '/api/health', undefined, 20), /timed out after 20 ms/);
});

test('connection failure identifies the explicitly selected service', async t => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  const transport = createFoundryTransport({ getBaseUrl: () => url, timeoutMs: 100, serviceName: 'Ollama', setting: 'YUR_OLLAMA_URL' });
  await assert.rejects(transport.request('GET', '/api/tags'), /Ollama request failed.*ECONNREFUSED/);
});
