'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackgroundLifetime } = require('../src/background-lifetime');
function fixture(overrides = {}) {
  let enabled = true, destroyed = false, quit = 0, prevented = 0;
  const calls = [], window = { isDestroyed: () => false, isMinimized: () => true,
    restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus'), hide: () => calls.push('hide') };
  const tray = { setToolTip(value) { this.tooltip = value; }, setContextMenu(menu) { this.menu = menu; }, on(name, fn) { this[name] = fn; }, destroy() { destroyed = true; } };
  const host = createBackgroundLifetime({ getWindow: () => window, isEnabled: () => enabled,
    createTray: () => tray, createMenu: x => x, quit: () => quit++, ...overrides });
  return { host, calls, tray, event: { preventDefault: () => prevented++ }, disable: () => enabled = false,
    state: () => ({ destroyed, quit, prevented }) };
}
test('closing retains the same window and reopen restores it without restarting owners', () => {
  const f = fixture(); assert.equal(f.host.close(f.event), true);
  assert.deepEqual(f.calls, ['hide']); assert.equal(f.state().prevented, 1);
  f.tray['double-click'](); assert.deepEqual(f.calls, ['hide', 'restore', 'show', 'focus']);
  assert.equal(f.state().quit, 0);
});
test('explicit Quit disposes tray and allows real window shutdown', () => {
  const f = fixture(); f.host.sync(); f.tray.menu[2].click();
  assert.equal(f.state().quit, 1); assert.equal(f.state().destroyed, true);
  assert.equal(f.host.close(f.event), false);
});
test('turning background off reveals the retained window before removing tray', () => {
  const f = fixture(); f.host.close(f.event); f.disable(); f.host.sync();
  assert.equal(f.state().destroyed, true); assert.ok(f.calls.includes('show'));
  assert.equal(f.host.close(f.event), false);
});
test('missing or failing tray cannot hide the application', () => {
  const f = fixture({ createTray: () => { throw new Error('unavailable'); } });
  assert.equal(f.host.close(f.event), false); assert.deepEqual(f.calls, []);
});
test('the tray names IntelliFlow by default and a product edition by its own name', () => {
  const desktop = fixture(); desktop.host.sync();
  assert.deepEqual(desktop.tray.menu.filter(item => item.label).map(item => item.label), ['Open IntelliFlow', 'Quit IntelliFlow and stop background work']);
  assert.equal(desktop.tray.tooltip, 'IntelliFlow · Franklin is available');
  let tooltip = null;
  const edition = fixture({ name: 'YUR Athletics', createTray: () => ({ setToolTip(value) { tooltip = value; }, setContextMenu(menu) { this.menu = menu; }, on() {}, destroy() {} }) });
  edition.host.sync();
  assert.equal(tooltip, 'YUR Athletics · Franklin is available');
});
