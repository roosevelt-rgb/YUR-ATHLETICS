const http = require('node:http');
const crypto = require('node:crypto');
const MODEL = 'approval-acceptance-fixture';
async function startModelFixture(onRequest = () => {}) {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, size: 1, details: { family: 'synthetic-acceptance', parameter_size: 'fixture' } }] })); }
    if (request.url === '/api/version') return response.end(JSON.stringify({ version: 'acceptance-fixture' }));
    if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'synthetic-acceptance' }] })); }
    if (!['/v1/chat/completions', '/chat/completions'].includes(request.url)) { response.statusCode = 404; return response.end('{}'); }
    const parts = []; for await (const part of request) parts.push(part);
    let body; try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { response.statusCode = 400; return response.end('{}'); }
    requests++;
    const messages = body.messages || [], last = messages.at(-1), isResult = last?.role === 'tool';
    const tools = body.tools || [];
    const name = tools.map(item => item.function?.name).find(value => value === 'mcp_yur_knowledge_read_awareness');
    const call = { id: 'call_' + crypto.randomBytes(6).toString('hex'), type: 'function', function: { name: name || 'mcp_yur_knowledge_read_awareness', arguments: JSON.stringify({ key: 'approval-acceptance' }) } };
    const content = isResult ? 'Synthetic model observed the real gateway tool result: ' + String(last.content) : null;
    onRequest({ sequence: requests, stream: Boolean(body.stream), last_role: last?.role, advertised_tool: Boolean(name), result: isResult ? String(last.content) : null, prompt: messages.filter(item => item.role === 'user').at(-1)?.content });
    const base = { id: 'chatcmpl_acceptance_' + requests, created: Math.floor(Date.now() / 1000), model: MODEL };
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const emit = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      emit({ role: 'assistant', ...(isResult ? { content } : { tool_calls: [{ index: 0, ...call }] }) });
      emit({}, isResult ? 'stop' : 'tool_calls'); response.end('data: [DONE]\n\n');
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content, ...(isResult ? {} : { tool_calls: [call] }) }, finish_reason: isResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, model: MODEL, close: () => { server.closeAllConnections(); server.close(); } };
}
module.exports = { startModelFixture };
