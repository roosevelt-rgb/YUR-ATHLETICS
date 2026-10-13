// Synthetic acceptance provider. Only tools/call accesses the canary.
const fs = require('node:fs');
const readline = require('node:readline');
const [canary, counter, pidFile] = process.argv.slice(2);
fs.appendFileSync(pidFile, JSON.stringify({ pid: process.pid, script: __filename }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-approval-acceptance', version: '1.0.0' } };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') result = { tools: [{ name: 'read_awareness', description: 'Read the isolated synthetic approval acceptance canary.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }] };
  else if (request.method === 'tools/call') {
    if (request.params?.name !== 'read_awareness' || request.params?.arguments?.key !== 'approval-acceptance') return send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Synthetic fixture accepts one exact canary read only.' } });
    fs.appendFileSync(counter, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, method: request.method, arguments: request.params.arguments }) + '\n');
    result = { content: [{ type: 'text', text: fs.readFileSync(canary, 'utf8') }], isError: false };
  } else return send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method unavailable in synthetic fixture.' } });
  send({ jsonrpc: '2.0', id: request.id, result });
});
