'use strict';
// Bounded acceptance through the public launcher and real owner profile.
// No mock provider, transport, dialogs, journal, gateway, or desktop API.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const profile = path.join(process.env.APPDATA, 'yur-intelliflow-glider-rc6');
const evidence = path.join(root, 'evidence/glider-rc6/normal-profile-acceptance-2026-10-05');
fs.mkdirSync(evidence, { recursive: true });
const receiptFile = path.join(evidence, 'receipt.json');
const receipt = { started_at: new Date().toISOString(), launcher: path.join(root, 'Start YUR AI Unified.cmd'),
  profile, scope: 'Normal profile: live Franklin tool action, installed harness read, graceful reopen and retained state. No external write or provisioning.',
  checks: [], limitations: ['Native coding connections start explicitly; existing coding tasks are never replayed on restart.',
    'Cloud media, Unreal and general plugin integration are separate acceptance items.'] };
const save = () => fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function pass(label, details) { receipt.checks.push({ label, passed: true, details }); save(); console.log(JSON.stringify({ passed: label })); }
async function until(fn, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(250); }
  throw new Error('Timed out: ' + label);
}
async function rpcSocket(url) {
  const ws = new WebSocket(url), pending = new Map(); let id = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', e => { const message = JSON.parse(e.data); const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); });
  ws.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Desktop diagnostic socket closed')); } pending.clear(); });
  return { close: () => ws.close(), send(method, params = {}) { return new Promise((resolve, reject) => {
    const sequence = ++id, timer = setTimeout(() => { pending.delete(sequence); reject(new Error('Diagnostic deadline: ' + method)); }, 45000);
    pending.set(sequence, { resolve, reject, timer }); ws.send(JSON.stringify({ id: sequence, method, params }));
  }); } };
}
let connection;
let attachOwned = process.argv.includes('--attach-owned');
async function launch() {
  const launchedAt = attachOwned ? 0 : Date.now();
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  if (!attachOwned) {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', "& '" + receipt.launcher.replaceAll("'", "''") + "' --remote-debugging-port=0 --remote-debugging-address=127.0.0.1"],
      { cwd: root, windowsHide: true, env: environment, stdio: 'ignore' });
    child.on('error', error => { receipt.launch_error = error.message; save(); });
  }
  attachOwned = false;
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await until(async () => {
    try { if (fs.statSync(portFile).mtimeMs < launchedAt - 1000) return false; const value = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); return value > 0 ? value : false; } catch { return false; }
  }, 'normal Desktop diagnostics');
  const target = await until(async () => { try { const entries = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); return entries.find(item => item.type === 'page' && /glider-launch\.html|studio-editor\.html/.test(item.url)); } catch { return false; } }, 'packaged Desktop page');
  const socket = await rpcSocket(target.webSocketDebuggerUrl);
  async function evaluate(expression) {
    const result = await socket.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.result?.description || 'evaluation failed'));
    return result.result.value;
  }
  connection = { socket, evaluate, port };
  if (/glider-launch\.html/.test(target.url)) {
    try { await evaluate('window.studio.launch.enter()'); }
    catch (error) { if (!/navigated|context.*destroyed/i.test(error.message)) throw error; }
  }
  await until(() => evaluate('Boolean(document.getElementById("franklin-send") && document.getElementById("glider-coding"))'), 'actual Desktop and Franklin');
  const integration = await evaluate('window.studio.integration.info()'); assert.equal(integration.enabled, true);
  const snapshot = await until(async () => { const result = await evaluate('window.studio.franklin.snapshot()'); return result.ok ? result.result : false; }, 'saved Franklin state');
  assert(!snapshot.active_request, 'Preserve an active Franklin request; acceptance will not replace it');
  assert(snapshot.models.some(item => item.id === snapshot.preferences.model), 'Saved Franklin model is available in the live catalog');
  pass('Normal public launcher opens Code Glider and retained Franklin profile', { model: snapshot.preferences.model, models: snapshot.models.length,
    retained_requests: snapshot.requests.length, open: snapshot.preferences.open, draft_characters: snapshot.preferences.draft.length });
  return snapshot;
}
async function screenshot(name) {
  const image = await connection.socket.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name), Buffer.from(image.data, 'base64'));
}
async function codingRead(model, cycle) {
  const evaluate = connection.evaluate;
  const catalog = await evaluate('window.studio.rc6.availableRuntimes()');
  assert(catalog.some(item => item.runtimeKey === 'rc6' && item.installed));
  assert(catalog.some(item => item.runtimeKey === 'construction-v1' && item.installed));
  const status = await evaluate('window.studio.rc6.connect(' + JSON.stringify(model) + ')'); assert.equal(status.running, true);
  const health = await evaluate('window.studio.rc6.health()');
  const session = await evaluate('window.studio.rc6.createSession()');
  const sessionId = session.session_id || session.id;
  assert.equal(typeof sessionId, 'string');
  const result = await evaluate('window.studio.rc6.console(' + JSON.stringify(sessionId) + ', "pwd")');
  pass(cycle + ': installed IntelliFlow gateway connects and executes a bounded real console read', { runtime: status.runtimeName,
    verified_sha256: status.verifiedDigest, workspace: status.workspace, session_id: sessionId,
    health: { status: health.status, tools: health.tools, authority: health.authority,
      mcp: health.mcp.servers.map(item => ({ name: item.name, connected: item.connected, tool_count: item.tool_count })) }, read: result });
  return { sessionId, model: status.model, workspace: status.workspace };
}
async function closeDesktop() {
  const { port, socket } = connection;
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  const browser = await rpcSocket(version.webSocketDebuggerUrl);
  try { await browser.send('Browser.close'); } catch (error) { if (!/closed/i.test(error.message)) throw error; }
  browser.close(); socket.close();
  await until(async () => { try { await fetch('http://127.0.0.1:' + port + '/json/version'); return false; } catch { return true; } }, 'owned Desktop graceful shutdown');
  connection = null; await delay(1500);
}
async function main() {
  const processCheck = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'electron|yur-shell|intelliflow|yur-gateway' } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  assert.equal(processCheck.status, 0);
  if (attachOwned) {
    const rows = JSON.parse(processCheck.stdout || '[]'), processes = Array.isArray(rows) ? rows : [rows];
    assert(processes.length && processes.every(item => item.Name === 'electron.exe' && item.ExecutablePath === path.join(root, 'desktop/studio-electron/node_modules/electron/dist/electron.exe')),
      'Attach only the exact agent-launched Desktop process');
    receipt.attached_owned_processes = processes.map(item => item.ProcessId);
  } else assert(!processCheck.stdout.trim(), 'Preserve occupied Desktop/IntelliFlow processes before acceptance');
  const initial = await launch();
  assert.equal(initial.preferences.draft, '', 'Preserve an existing user draft before live acceptance');
  const marker = 'NORMAL_PROFILE_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const prompt = 'Franklin, this is a bounded connection check in my normal Desktop. Use desktop_action with action open_view and payload {"view":"workforce"} to open Workforce now. Then answer with the marker ' + marker + ' and say which view you actually opened. Do not start other work, create files, send messages, generate media or provision compute.';
  const requestId = randomUUID(); receipt.live_request = { id: requestId, marker, prompt, model: initial.preferences.model }; save();
  const sent = await connection.evaluate('window.studio.franklin.send(' + JSON.stringify({ request_id: requestId, text: prompt }) + ')'); assert.equal(sent.ok, true);
  let lastState = '';
  const completed = await until(async () => {
    const response = await connection.evaluate('window.studio.franklin.snapshot()'); if (!response.ok) return false;
    const request = response.result.requests.find(item => item.id === requestId);
    if (request?.status && request.status !== lastState) { lastState = request.status; console.log(JSON.stringify({ franklin_status: lastState })); }
    if (request && ['failed', 'cancelled', 'interrupted'].includes(request.status)) throw new Error('Live Franklin result: ' + request.status);
    return request?.status === 'completed' ? response.result : false;
  }, 'live Franklin tool operation', 240000);
  const actions = completed.events.filter(item => item.request_id === requestId && item.type.startsWith('franklin.action.'));
  assert(actions.some(item => item.status === 'completed' && item.summary.includes('open view')));
  const reply = completed.messages.filter(item => item.role === 'assistant').at(-1)?.content || '';
  assert(reply.includes(marker), 'Actual cloud response contains requested marker');
  const view = await connection.evaluate('({phase:document.getElementById("yur-franklin")?.dataset.phase, text:document.getElementById("franklin-status")?.textContent})');
  view.observed_view = completed.context.sections.find(item => item.label === 'View')?.value;
  assert.equal(view.observed_view, 'workforce', 'Actual Desktop acknowledges the requested Workforce view');
  pass('Real cloud Franklin answers and completes an actual Desktop tool action in the normal profile', { request_id: requestId, mission_id: completed.requests.find(item => item.id === requestId).mission_id,
    reply, action_events: actions.map(item => ({ type: item.type, status: item.status, summary: item.summary })), ui: view });
  const firstCoding = await codingRead(initial.preferences.model, 'Initial launch');
  await screenshot('normal-session.png'); await closeDesktop();
  const reopened = await launch();
  assert.equal(reopened.preferences.model, initial.preferences.model);
  assert.equal(reopened.requests.find(item => item.id === requestId)?.status, 'completed');
  assert.equal(reopened.requests.length, completed.requests.length, 'Reopen must not replay inference or accepted work');
  assert(reopened.messages.some(item => item.role === 'assistant' && item.content.includes(marker)));
  pass('Reopen restores actual Franklin response and selected model without replaying work', { request_id: requestId, requests: reopened.requests.length, model: reopened.preferences.model });
  const beforeReconnect = await connection.evaluate('window.studio.rc6.status()'); assert.equal(beforeReconnect.running, false);
  const secondCoding = await codingRead(reopened.preferences.model, 'Reopened launch');
  assert.notEqual(firstCoding.sessionId, secondCoding.sessionId, 'New process uses new owned session rather than stale identity');
  await screenshot('reopened-session.png');
  receipt.passed = true; receipt.finished_at = new Date().toISOString();
  receipt.left_open = true; receipt.diagnostic_port = connection.port;
  save(); connection.socket.close(); console.log(JSON.stringify({ passed: true, receipt: receiptFile }));
}
main().catch(async error => { receipt.passed = false; receipt.error = String(error.message).slice(0, 1500); receipt.finished_at = new Date().toISOString(); save(); console.error(receipt.error);
  if (connection) connection.socket.close(); process.exitCode = 1; });
