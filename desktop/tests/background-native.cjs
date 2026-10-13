'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createBackgroundLifetime, trayBitmap } = require('../src/background-lifetime');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-background-native-'));
app.setPath('userData', path.join(home, 'profile')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
let window, lifetime, tray, menu;
const events = [];
function sourceHashes() {
  return Object.fromEntries(['src/background-lifetime.js', 'tests/background-native.cjs'].map(relative =>
    [relative, createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', relative))).digest('hex')]));
}
const sourceBefore = sourceHashes();
function state(event) {
  const destroyed = !window || window.isDestroyed();
  events.push({ event, at: new Date().toISOString(), destroyed,
    visible: destroyed ? false : window.isVisible(), minimized: destroyed ? false : window.isMinimized() });
}
async function visible(expected) {
  for (let n = 0; n < 30 && window.isVisible() !== expected; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(window.isVisible(), expected, JSON.stringify(events));
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => lifetime?.beginQuit());
app.whenReady().then(async () => {
  // Exercise the actual visible-window close path. A never-shown window with
  // show:false follows a different first-show path under Windows hidden startup.
  // Do not focus the fixture or add a taskbar item while proving real visibility.
  window = new BrowserWindow({ show: true, focusable: false, skipTaskbar: true,
    width: 320, height: 160, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  for (const event of ['ready-to-show', 'show', 'hide', 'close', 'closed', 'minimize', 'restore']) window.on(event, () => state(event));
  lifetime = createBackgroundLifetime({ getWindow: () => window, isEnabled: () => true,
    createTray: () => { tray = new Tray(trayBitmap(nativeImage)); return tray; },
    createMenu: items => { menu = Menu.buildFromTemplate(items); return menu; }, quit: () => app.quit() });
  window.on('close', event => lifetime.close(event));
  await window.loadURL('data:text/html,<title>Owned background lifetime test</title><p>Isolated test</p>');
  state('loaded');
  window.showInactive();
  await visible(true); state('initial-visible');
  const identity = window.webContents.id;
  await window.webContents.executeJavaScript('window.fixtureMission = { step: 1 }; true');
  lifetime.sync(); assert.equal(lifetime.status().available, true);
  const closeAttempt = new Promise(resolve => window.once('close', resolve));
  window.close(); await closeAttempt;
  assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false);
  assert.equal(window.webContents.id, identity);
  const step = await window.webContents.executeJavaScript('window.fixtureMission.step += 1');
  assert.equal(step, 2);
  tray.emit('double-click');
  await visible(true); state('reopened'); assert.equal(window.webContents.id, identity);
  assert.equal(await window.webContents.executeJavaScript('window.fixtureMission.step'), 2);
  app.once('will-quit', () => {
    assert.equal(window.isDestroyed(), true);
    assert.equal(tray.isDestroyed(), true);
    assert.equal(lifetime.status().quitting, true);
    state('will-quit');
    const sourceAfter = sourceHashes(); assert.deepEqual(sourceAfter, sourceBefore);
    const receipt = { status: 'passed', checked_at: new Date().toISOString(), events,
      source_before: sourceBefore, source_after: sourceAfter,
      checks: ['owned window initially visible', 'real system tray created', 'close preserves the same webContents',
        'hidden page retains and updates its mission fixture', 'tray callback reopens the same live state',
        'tray Quit callback reaches app will-quit with destroyed window and tray'],
      evidence_limit: 'Window lifetime verification in an owned temporary profile. Tray callbacks are triggered programmatically, not by OS pointer automation. The fixture is not a model mission or a restart-resume claim.' };
    fs.writeFileSync(path.join(home, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ ...receipt, evidence: path.join(home, 'receipt.json') }));
  });
  menu.items[2].click();
}).catch(error => { console.error(error.stack); lifetime?.beginQuit(); if (window && !window.isDestroyed()) window.destroy(); app.exit(1); });
setTimeout(() => { console.error('Background fixture deadline'); app.exit(1); }, 20000).unref();
