const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRc6Transport } = require('../src/rc6-transport');
const evidence = path.resolve(__dirname, '../../..', 'evidence/glider-rc6');
fs.mkdirSync(evidence, { recursive: true });
const write = process.argv.includes('--write');
const profile = path.join(process.env.LOCALAPPDATA, 'YUR-Glider-RC6-validation');
const events = [], started = Date.now(); let session, answer = '', finished = false;
const transport = createRc6Transport({ profile, onEvent(event) {
  const payload = event.payload || {};
  if (event.type === 'message.delta') answer += payload.text || '';
  if (!event.type?.includes('delta') && event.type !== 'reasoning.available') events.push({ type: event.type, session: event.session_id, ...(event.type?.startsWith('approval.') || event.type?.startsWith('authority.') || event.type === 'tool.complete' || event.type === 'error' ? { payload } : {}) });
  if (payload.kind === 'ApprovalRequest' && payload.request_id && write) {
    transport.approval(session, payload.request_id, 'approve').catch(error => finish(error));
  }
  if (event.type === 'message.complete') { answer = payload.text || answer; finish(); }
  if (event.type === 'error') finish(new Error(JSON.stringify(payload)));
} });
const file = path.join(transport.status().workspace, 'glider-rc6-integration-proof.txt');
const deadline = setTimeout(() => finish(new Error('Live RC6 response exceeded 180 seconds')), 180000);
function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline); transport.stop();
  try {
    if (error) throw error;
    if (write) { assert.equal(fs.readFileSync(file, 'utf8').trim(), 'GLIDER_RC6_COMMIT_PROOF'); }
    else assert.equal(answer.trim(), 'GLIDER_RC6_CONNECTED');
    const receipt = { at: new Date().toISOString(), elapsed_ms: Date.now() - started, mode: write ? 'isolated-file-write' : 'live-response', session, runtime: transport.status(), answer, events, file: write ? file : undefined };
    fs.writeFileSync(path.join(evidence, write ? 'live-write-receipt.json' : 'live-response-receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ passed: true, mode: receipt.mode, elapsed_ms: receipt.elapsed_ms, answer, events: events.map(e => e.type) }));
  } catch (failure) { console.error(failure.stack); fs.writeFileSync(path.join(evidence, 'live-failure.json'), JSON.stringify({ at: new Date().toISOString(), mode: write ? 'write' : 'response', error: failure.message, events, answer }, null, 2)); process.exitCode = 1; }
}
(async () => {
  await transport.start(); session = (await transport.createSession()).session_id;
  await transport.submit(session, write ? `Integration acceptance test in your isolated candidate workspace. Use your native write_file tool to create exactly ${file}, containing only GLIDER_RC6_COMMIT_PROOF followed by a newline. Do not use terminal, delegation, network, or any other files. If approval is required, request it. After the committed write, report completion.` : 'Respond exactly GLIDER_RC6_CONNECTED. Do not use tools or change files.');
})().catch(finish);
