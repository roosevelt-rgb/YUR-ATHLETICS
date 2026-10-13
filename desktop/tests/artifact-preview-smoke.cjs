// Native isolation/outcome checks; all content and storage belong to this test.
'use strict';
const { app, BrowserWindow, WebContentsView, session, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { registerArtifactScheme, createArtifactPreview, checkedArtifact } = require('../src/artifact-preview');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-artifact-preview-'));
app.setPath('userData', path.join(home, 'electron'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
registerArtifactScheme(protocol);
let window, host, view;
const checks = [], requests = [], events = [];
const server = http.createServer((request, response) => { requests.push(request.url); response.end('Must not be acquired'); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  await Promise.all([app.whenReady(), new Promise(resolve => server.listen(0, '127.0.0.1', resolve))]);
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, skipTaskbar: true, width: 1050, height: 750, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  host = createArtifactPreview({ window, electron: { session, WebContentsView: function(options) { view = new WebContentsView(options); return view; } }, onEvent: event => events.push(event) });
  host.setBounds({ x: 20, y: 20, width: 900, height: 650 }); host.setVisible(true);
  const content = `<!doctype html><title>Interactive estimate</title><style>body{font:20px system-ui;background:#eef2ff;padding:35px}button{font:inherit}</style><h1>Interactive estimate</h1><label>Area <input id="area" type="number" value="200"></label><button id="compute">Calculate</button><output id="answer"></output><p id="boundary"></p><a id="leave" href="${origin}/navigate">External link</a><a id="popup" target="_blank" href="${origin}/popup">Popup</a><form action="${origin}/form"><button id="submit">Submit</button></form><img src="${origin}/image"><iframe src="${origin}/frame"></iframe><script>
    document.querySelector('#boundary').textContent=[typeof require,typeof process,typeof studio,typeof window.opener].join(',');
    document.querySelector('#compute').onclick=()=>document.querySelector('#answer').textContent=Number(document.querySelector('#area').value)*3;
    fetch('${origin}/fetch').catch(()=>{}); new WebSocket('ws://127.0.0.1:${server.address().port}/socket').onerror=()=>{};
    try{localStorage.setItem('no','no')}catch(e){document.body.dataset.storage='denied'};
    Notification.requestPermission().then(value=>document.body.dataset.permission=value);
    </script>`;
  const artifact = { name: 'estimate.html', media_type: 'text/html', content, sha256: createHash('sha256').update(content).digest('hex') };
  assert.throws(() => checkedArtifact({ ...artifact, sha256: '0'.repeat(64) }), /digest/);
  await host.open(artifact);
  await view.webContents.executeJavaScript("document.querySelector('#area').value='317';document.querySelector('#compute').click()");
  const state = await view.webContents.executeJavaScript("({text:document.querySelector('#answer').textContent,boundary:document.querySelector('#boundary').textContent,storage:document.body.dataset.storage,title:document.title})");
  assert.equal(state.text, '951'); assert.equal(state.title, 'Interactive estimate');
  assert.equal(state.boundary, 'undefined,undefined,undefined,object'); assert.equal(state.storage, 'denied');
  checks.push({ name: 'actual interactive HTML outcome and isolated no-bridge opaque origin', result: state });
  await view.webContents.executeJavaScript("document.querySelector('#leave').click();document.querySelector('#popup').click();document.querySelector('#submit').click()");
  await wait(150);
  assert.deepEqual(requests, []); assert.equal(view.webContents.getURL(), `yur-artifact://view/${artifact.sha256}/index.html`);
  assert.ok(events.some(event => event.type === 'blocked'));
  checks.push({ name: 'fetch, WebSocket, images, frames, forms, navigation and popups blocked before network', requests });
  const denied = await view.webContents.executeJavaScript("navigator.mediaDevices.getUserMedia({audio:true}).then(()=>false,()=>true)");
  assert.equal(denied, true); checks.push({ name: 'microphone denied in artifact renderer' });
  host.setVisible(false); assert.equal(host.state().visible, false);
  await host.destroy(); await assert.rejects(host.open(artifact), /closed/);
  checks.push({ name: 'native view hide and destroy revoke preview access' });
  fs.writeFileSync(path.join(home, 'artifact-preview-result.json'), JSON.stringify({ passed: true, checks, source_sha256: createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../src/artifact-preview.js'))).digest('hex'), limitation: 'Native DOM and interaction checks; hidden child-view pixel capture is not asserted.' }, null, 2));
  console.log(JSON.stringify({ passed: true, groups: checks.length, proof: home }));
}
run().then(() => { server.closeAllConnections(); server.close(); window?.destroy(); app.exit(0); }).catch(error => {
  console.error(error.stack); fs.writeFileSync(path.join(home, 'artifact-preview-failure.json'), JSON.stringify({ passed: false, error: error.stack, checks, requests, events }, null, 2));
  server.closeAllConnections(); server.close(); window?.destroy(); app.exit(1);
});
