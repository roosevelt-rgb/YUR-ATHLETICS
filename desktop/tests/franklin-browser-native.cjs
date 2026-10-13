'use strict';
// Actual Electron browser controls against one owned loopback fixture. No user
// browser window/profile, external endpoint, account, credential, or outreach.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createBrowserHost } = require('../src/browser-host');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-browser-native-'));
app.setPath('userData', path.join(home, 'electron')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
const sources = ['src/browser-host.js', 'src/franklin-browser-actions.js', 'tests/franklin-browser-native.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')]));
const sourceBefore = hashes(), checks = [], requests = [], events = [];
let window, host, view, origin;
const server = http.createServer(async (request, response) => {
  let body = ''; for await (const part of request) body += String(part);
  requests.push({ path: request.url, method: request.method, body });
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/submitted') return response.end('<title>Owned submission received</title><h1>Local fixture received form</h1>');
  if (request.url === '/next') return response.end('<title>Next local page</title><h1>Owned next page</h1>');
  if (request.url === '/frame') return response.end('<button>FRAME_ONLY_CONTROL</button>');
  response.end(`<!doctype html><html><head><title>Owned browser controls</title></head><body>
    <h1>Local browser operation fixture</h1>
    <button id="count" type="button" onclick="window.clicks++; document.getElementById('count-value').textContent=window.clicks">Add one</button><span id="count-value">0</span>
    <button id="changed" type="button" onclick="window.changedClicks++">Original action</button>
    <button id="replace" type="button" onclick="window.replacedClicks++">Replaceable action</button>
    <button disabled>Disabled action</button><button hidden>HIDDEN_CONTROL</button>
    <div style="opacity:0"><button>INVISIBLE_CONTROL</button></div>
    <input type="password" aria-label="PASSWORD_CONTROL" value="PASSWORD_SENTINEL"><input type="file" aria-label="FILE_CONTROL">
    <input type="hidden" value="HIDDEN_SENTINEL" aria-label="HIDDEN_INPUT"><input type="text" autocomplete="one-time-code" aria-label="OTP_CONTROL">
    <label>Amount<input id="amount" type="number" value="4"></label>
    <form id="fixture-form" action="/submitted" method="post">
      <label>Recipient<input id="recipient" name="recipient" type="email" value="initial@example.test"></label>
      <label>Message<textarea id="message" name="message">EXISTING_PRIVATE_FIELD</textarea></label>
      <label>Choice<select id="choice" name="choice"><option value="basic">Basic</option><option value="full">Full</option><option value="disabled" disabled>Disabled option</option></select></label>
      <input type="hidden" name="csrf" value="SYNTHETIC_HIDDEN_NONCE">
      <button id="submit" type="submit">Submit local fixture</button>
    </form>
    <a href="/next">Next owned page</a><a href="javascript:window.pwned=true">EXECUTABLE_LINK</a>
    <iframe src="/frame" title="Owned frame"></iframe>
    <script>window.clicks=0;window.changedClicks=0;window.replacedClicks=0;window.inputs=0;window.changes=0;
    document.getElementById('message').addEventListener('input',()=>window.inputs++);
    document.getElementById('message').addEventListener('change',()=>window.changes++);</script>
  </body></html>`);
});
const inspect = () => host.inspectControls();
const control = (snapshot, label) => { const found = snapshot.controls.find(item => item.label === label); assert(found, 'Missing fixture control: ' + label); return found; };
const payload = (snapshot, label, value) => ({ document_id: snapshot.document_id, ref: control(snapshot, label).ref, ...(value === undefined ? {} : { value }) });
const evaluate = code => view.webContents.executeJavaScript(code);
async function until(predicate, name, milliseconds = 7000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Native fixture timed out: ' + name);
}
const ready = () => until(() => !host.state().loading, 'page loaded');
async function navigate(url) { await host.navigate(url); await ready(); }
async function run() {
  await Promise.all([app.whenReady(), new Promise(resolve => server.listen(0, '127.0.0.1', resolve))]);
  origin = 'http://127.0.0.1:' + server.address().port;
  window = new BrowserWindow({ show: false, skipTaskbar: true, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  host = createBrowserHost({ window, onEvent: event => events.push(event), electron: { session,
    WebContentsView: function (options) { view = new WebContentsView(options); return view; }, shell: { openExternal: async () => { throw new Error('External browser is outside this fixture'); } } } });
  host.setBounds({ x: 0, y: 0, width: 950, height: 750 }); host.setVisible(true);
  await navigate(origin + '/');
  let snapshot = await inspect();
  for (const forbidden of ['PASSWORD_CONTROL', 'FILE_CONTROL', 'HIDDEN_INPUT', 'OTP_CONTROL', 'HIDDEN_CONTROL', 'INVISIBLE_CONTROL', 'FRAME_ONLY_CONTROL']) {
    assert(!snapshot.controls.some(item => item.label === forbidden), forbidden);
  }
  assert.equal(JSON.stringify(snapshot).includes('EXISTING_PRIVATE_FIELD'), false);
  assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC_HIDDEN_NONCE'), false);
  assert.deepEqual(control(snapshot, 'Disabled action').actions, []);
  assert.deepEqual(control(snapshot, 'EXECUTABLE_LINK').actions, []);
  const reading = await host.readVisiblePage(); assert(!reading.text.includes('EXISTING_PRIVATE_FIELD')); assert(!reading.text.includes('PASSWORD_SENTINEL'));
  checks.push('Actual isolated DOM inspection excludes sensitive, hidden, subframe controls and current form values; existing browser text exclusions remain');

  const click = await host.prepareControl('click', payload(snapshot, 'Add one'));
  assert.equal(await evaluate('window.clicks'), 0);
  assert.throws(() => JSON.stringify(click), /private/);
  assert.equal((await host.executeControl(click)).performed, true);
  assert.equal(await evaluate('window.clicks'), 1);
  await assert.rejects(host.executeControl(click), /already used/); assert.equal(await evaluate('window.clicks'), 1);
  checks.push('Preparation makes no page change; approved native click operates the actual control exactly once');

  snapshot = await inspect();
  const exact = "'); globalThis.pwned = true; //\n</script>\nOwned text";
  const fill = await host.prepareControl('fill', payload(snapshot, 'Message', exact));
  assert.equal(await evaluate('document.getElementById("message").value'), 'EXISTING_PRIVATE_FIELD');
  await host.executeControl(fill);
  assert.deepEqual(await evaluate('({value:document.getElementById("message").value,inputs:window.inputs,changes:window.changes,pwned:typeof window.pwned})'),
    { value: exact, inputs: 1, changes: 1, pwned: 'undefined' });
  await assert.rejects(host.prepareControl('fill', payload(snapshot, 'Message', 'overwrite stale')), /changed/);
  checks.push('Exact multiline field data reaches native value/input/change behavior, remains literal data, and makes older value bindings stale');

  snapshot = await inspect();
  const select = await host.prepareControl('select', payload(snapshot, 'Choice', 'full'));
  assert.equal(await evaluate('document.getElementById("choice").value'), 'basic');
  await host.executeControl(select); assert.equal(await evaluate('document.getElementById("choice").value'), 'full');
  snapshot = await inspect();
  await assert.rejects(host.prepareControl('select', payload(snapshot, 'Choice', 'disabled')), /enabled exact option/);
  await assert.rejects(host.prepareControl('fill', payload(snapshot, 'Amount', 'not-a-number')), /numeric/);
  assert.equal(await evaluate('document.getElementById("amount").value'), '4');
  checks.push('Native select changes only a reviewed enabled exact option; invalid numeric fill is rejected before mutation');

  snapshot = await inspect();
  const changed = await host.prepareControl('click', payload(snapshot, 'Original action'));
  await evaluate('document.getElementById("changed").textContent="Changed consequence"');
  await assert.rejects(host.executeControl(changed), /changed/); assert.equal(await evaluate('window.changedClicks'), 0);
  snapshot = await inspect(); const replaced = await host.prepareControl('click', payload(snapshot, 'Replaceable action'));
  await evaluate('(()=>{const button=document.getElementById("replace");button.replaceWith(button.cloneNode(true));})()');
  await assert.rejects(host.executeControl(replaced), /changed/); assert.equal(await evaluate('window.replacedClicks'), 0);
  checks.push('Changed action label and identical-looking replaced DOM element both invalidate the exact prepared reference');

  snapshot = await inspect(); const changedForm = await host.prepareControl('click', payload(snapshot, 'Submit local fixture'));
  assert(changedForm.review.control.may_submit);
  assert(changedForm.review.form_fields.some(field => field.name === 'recipient' && field.value === 'initial@example.test'));
  assert.equal(changedForm.review.hidden_form_fields, 1); assert(!JSON.stringify(changedForm.review).includes('SYNTHETIC_HIDDEN_NONCE'));
  await evaluate('document.getElementById("recipient").value="changed@example.test"');
  await assert.rejects(host.executeControl(changedForm), /changed/);
  assert.equal(requests.filter(item => item.path === '/submitted').length, 0);
  snapshot = await inspect(); const submit = await host.prepareControl('click', payload(snapshot, 'Submit local fixture'));
  assert.equal(submit.review.form_fields.find(field => field.name === 'recipient').value, 'changed@example.test');
  await host.executeControl(submit);
  await until(() => requests.some(item => item.path === '/submitted'), 'owned local form submission'); await ready();
  const sent = requests.find(item => item.path === '/submitted'); assert.equal(sent.method, 'POST');
  const form = new URLSearchParams(sent.body); assert.equal(form.get('recipient'), 'changed@example.test'); assert.equal(form.get('message').replace(/\r\n/g, '\n'), exact); assert.equal(form.get('choice'), 'full');
  checks.push('Native submit reviews visible form values, binds hidden state without exposing it, rejects changed recipients, and submits only the owned local fixture');

  await navigate(origin + '/'); snapshot = await inspect();
  const stale = await host.prepareControl('click', payload(snapshot, 'Add one'));
  await navigate(origin + '/'); await assert.rejects(host.executeControl(stale), /changed/); assert.equal(await evaluate('window.clicks'), 0);
  snapshot = await inspect(); const hidden = await host.prepareControl('click', payload(snapshot, 'Add one'));
  host.setVisible(false); await assert.rejects(host.executeControl(hidden), /Show/); host.setVisible(true);
  assert.equal(await evaluate('window.clicks'), 0);
  snapshot = await inspect(); const link = await host.prepareControl('click', payload(snapshot, 'Next owned page'));
  await host.executeControl(link); await until(() => host.state().url === origin + '/next', 'owned link navigation'); await ready();
  assert((await host.readVisiblePage()).text.includes('Owned next page'));
  checks.push('Same-URL replacement and hidden view revoke pending actions; reviewed same-origin link navigates the real browser');
}
(async () => {
  let failure;
  const timeout = setTimeout(() => { failure = { message: 'Native browser acceptance exceeded 90 seconds' }; void cleanup(); }, 90000);
  let finished = false;
  async function cleanup() {
    if (finished) return; finished = true; clearTimeout(timeout);
    try { await host?.destroy(); } catch (error) { failure ||= { message: error.message }; }
    if (window && !window.isDestroyed()) window.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const sourceAfter = hashes(), sourceChanged = sources.filter(file => sourceBefore[file] !== sourceAfter[file]);
    if (sourceChanged.length) failure ||= { message: 'Browser acceptance sources changed during the run', sourceChanged };
    const receipt = path.join(home, 'browser-controls-receipt.json');
    fs.writeFileSync(receipt, JSON.stringify({ passed: !failure, checks, failure: failure || null, source_before: sourceBefore, source_after: sourceAfter,
      source_changed: sourceChanged, requests, events, limitations: ['Owned loopback fixture only; no external form, outreach, account or user-profile claim.',
        'Fixed DOM activation and native value/input/change dispatch. Pages requiring trusted OS input, subframes, shadow roots or sensitive controls remain outside this capability.'] }, null, 2));
    console.log(JSON.stringify({ passed: !failure, checks: checks.length, receipt, failure: failure || null })); app.exit(failure ? 1 : 0);
  }
  try { await run(); } catch (error) { failure = { message: error.message, stack: error.stack }; }
  await cleanup();
})();
