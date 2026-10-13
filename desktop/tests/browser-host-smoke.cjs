'use strict';

// Actual isolated Electron WebContentsView, with two test-owned loopback sites.
// No remote sites, user profile, system browser, or privileged Desktop APIs.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createBrowserHost } = require('../src/browser-host');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-browser-host-smoke-'));
app.setPath('userData', path.join(home, 'electron'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
const checks = [], events = [], requests = [], external = [];
let window, host, view, origin, otherOrigin, socketClosed = false;
const other = http.createServer((req, res) => { requests.push(`other:${req.url}`); res.end('<h1>Approved second origin</h1>'); });
const site = http.createServer((req, res) => {
  requests.push(`site:${req.url}`);
  if (req.url === '/redirect-same') { res.writeHead(302, { Location: '/two' }); return res.end(); }
  if (req.url === '/redirect-other') { res.writeHead(302, { Location: `${otherOrigin}/redirected` }); return res.end(); }
  if (req.url === '/slow') { res.on('close', () => { socketClosed = true; }); return; }
  if (req.url === '/download') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="blocked-fixture.txt"', 'Content-Type': 'text/plain' }); return res.end('Must never be downloaded'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url === '/two') return res.end('<title>Second fixture</title><h1>Second rendered page</h1>');
  res.end(`<!doctype html><title>Isolated browser fixture</title>
    <h1>Verified native browser page</h1><p id="proof"></p><p id="permission"></p>
    <p hidden>HIDDEN_SENTINEL</p><div style="display:none">CSS_HIDDEN_SENTINEL</div>
    <div style="opacity:0"><span>ANCESTOR_HIDDEN_SENTINEL</span></div>
    <input value="INPUT_SENTINEL"><textarea>TEXTAREA_SENTINEL</textarea><div contenteditable>EDITABLE_SENTINEL</div>
    <a id="same" href="/two">Go to second page</a>
    <a id="off" href="${otherOrigin}/blocked-link">Another origin</a>
    <a id="popup" target="_blank" href="${otherOrigin}/popup">Popup</a>
    <a id="download" href="/download">Download</a>
    <script>
      document.querySelector('#proof').textContent = 'REMOTE_BOUNDARY:' + [typeof window.studio, typeof require, typeof process].join(',');
      localStorage.setItem('test-owned-key','test-owned-value');
      fetch('${otherOrigin}/blocked-fetch').catch(() => {});
      Notification.requestPermission().then(value => { document.querySelector('#permission').textContent = 'PERMISSION:' + value; });
    </script>`);
});

const waitFor = async (predicate, label, timeout = 7000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
};
const ready = async () => waitFor(() => !host.state().loading, 'native page load');
const navigate = async url => { await host.navigate(url); await ready(); };
const check = (name, data = {}) => checks.push({ name, ...data });

async function run() {
  await Promise.all([new Promise(resolve => site.listen(0, '127.0.0.1', resolve)), new Promise(resolve => other.listen(0, '127.0.0.1', resolve)), app.whenReady()]);
  origin = `http://127.0.0.1:${site.address().port}`; otherOrigin = `http://127.0.0.1:${other.address().port}`;
  window = new BrowserWindow({ show: false, skipTaskbar: true, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  host = createBrowserHost({ window, onEvent: event => events.push(event), electron: { session,
    WebContentsView: function (options) { view = new WebContentsView(options); return view; },
    shell: { openExternal: async url => { external.push(url); } } } });
  host.setBounds({ x: 0, y: 0, width: 900, height: 700 }); host.setVisible(true);
  await navigate(`${origin}/one`);
  await waitFor(async () => (await host.readVisiblePage()).text.includes('PERMISSION:denied'), 'permission denial');
  const evidence = await host.readVisiblePage();
  assert.ok(evidence.text.includes('Verified native browser page'));
  assert.ok(evidence.text.includes('REMOTE_BOUNDARY:undefined,undefined,undefined'));
  for (const marker of ['HIDDEN_SENTINEL', 'CSS_HIDDEN_SENTINEL', 'ANCESTOR_HIDDEN_SENTINEL', 'INPUT_SENTINEL', 'TEXTAREA_SENTINEL', 'EDITABLE_SENTINEL', 'document.querySelector']) assert.equal(evidence.text.includes(marker), false, marker);
  assert.equal(evidence.source_url, `${origin}/one`); assert.equal(evidence.sha256, createHash('sha256').update(evidence.text).digest('hex'));
  assert.equal(requests.some(value => value === 'other:/blocked-fetch'), false);
  check('actual rendered text, source/hash, no Desktop or Node API, hidden/form exclusion and permission denial', { evidence });

  await view.webContents.executeJavaScript("document.querySelector('#same').click()");
  await waitFor(() => host.state().url === `${origin}/two`, 'same-origin link'); await ready();
  assert.ok((await host.readVisiblePage()).text.includes('Second rendered page'));
  await host.back(); await ready(); assert.equal(host.state().url, `${origin}/one`);
  await host.forward(); await ready(); assert.equal(host.state().url, `${origin}/two`);
  await host.reload(); await ready();
  await navigate(`${origin}/redirect-same`); assert.equal(host.state().url, `${origin}/two`);
  check('actual same-origin link, native history, reload and redirect');

  await navigate(`${origin}/one`);
  await view.webContents.executeJavaScript("document.querySelector('#off').click()");
  await waitFor(() => host.state().pending_url === `${otherOrigin}/blocked-link`, 'off-origin pending navigation');
  assert.equal(host.state().url, `${origin}/one`); assert.equal(requests.includes('other:/blocked-link'), false);
  await navigate(host.state().pending_url);
  assert.ok((await host.readVisiblePage()).text.includes('Approved second origin'));
  assert.equal(requests.includes('other:/blocked-link'), true);
  await assert.rejects(host.navigate(`${origin}/redirect-other`));
  assert.equal(host.state().pending_url, `${otherOrigin}/redirected`); assert.equal(requests.includes('other:/redirected'), false);
  check('off-origin links and redirects require explicit operator navigation');

  await navigate(`${origin}/one`);
  await view.webContents.executeJavaScript("document.querySelector('#popup').click()");
  await waitFor(() => events.some(event => event.type === 'blocked' && event.reason === 'popup-blocked'), 'blocked popup');
  assert.equal(requests.includes('other:/popup'), false);
  await view.webContents.executeJavaScript("document.querySelector('#download').click()");
  await waitFor(() => events.some(event => event.type === 'blocked' && event.reason === 'download-blocked'), 'blocked download');
  await ready();
  check('popups and actual download requests denied');

  const slow = host.navigate(`${origin}/slow`); const stopped = assert.rejects(slow, /stopped/);
  await waitFor(() => requests.includes('site:/slow'), 'slow upstream');
  host.stop(); await stopped; await waitFor(() => socketClosed, 'stopped network socket');
  await navigate(`${origin}/two`);
  await host.openExternal(); assert.deepEqual(external, [`${origin}/two`]);
  host.setVisible(false); await assert.rejects(host.readVisiblePage(), /Show/); host.setVisible(true);
  try {
    const image = await view.webContents.capturePage(undefined, { stayHidden: true }); fs.writeFileSync(path.join(home, 'native-browser.png'), image.toPNG());
  } catch (error) { check('hidden native-view capture unavailable', { limitation: error.message }); }
  check('Stop closes network request, explicit external-open URL, hidden view cannot acquire');

  const remoteContents = view.webContents;
  await host.destroy(); assert.equal(remoteContents.isDestroyed(), true); assert.equal(host.state().closed, true);
  check('native renderer destroyed and isolated session storage cleared');
}

(async () => {
  let failure;
  try { await run(); } catch (error) { failure = { message: error.message, stack: error.stack }; }
  try { await host?.destroy(); } catch (error) { failure ||= { message: error.message, stack: error.stack }; }
  if (window && !window.isDestroyed()) window.destroy();
  await Promise.all([site, other].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  const receipt = path.join(home, 'browser-host-smoke-result.json');
  fs.writeFileSync(receipt, JSON.stringify({ passed: !failure, checks, failure: failure || null, events, requests, screenshot: path.join(home, 'native-browser.png') }, null, 2));
  console.log(JSON.stringify({ passed: !failure, checks: checks.length, receipt, failure: failure || null }));
  app.exit(failure ? 1 : 0);
})();
