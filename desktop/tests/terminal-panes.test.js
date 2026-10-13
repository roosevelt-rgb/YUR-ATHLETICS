'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/terminal-panes');

function fixture(options = {}) {
  const terminals = [], calls = { spawn: [], kill: [], input: [], resize: [], errors: [] }, listeners = new Set();
  class Element {
    constructor(tag) { this.tagName = tag; this.ownerDocument = document; this.style = {}; this.children = []; this.events = new Map(); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    setAttribute() {}
    addEventListener(name, fn) { this.events.set(name, fn); }
    removeEventListener(name) { this.events.delete(name); }
    fire(name) { this.events.get(name)?.(); }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  }
  const document = { createElement: tag => new Element(tag) };
  class Terminal {
    constructor(settings) { this.options = settings; this.cols = 80; this.rows = 24; this.output = ''; this.focused = 0; this.cleared = 0; this.disposed = false; terminals.push(this); }
    loadAddon(value) { this.addon = value; }
    open(host) { this.host = host; if (options.openError) throw new Error('Renderer failed'); }
    onData(fn) { this.data = fn; return { dispose: () => { this.data = null; } }; }
    write(data) { this.output += data; }
    clear() { this.cleared++; }
    focus() { this.focused++; }
    dispose() { this.disposed = true; }
  }
  class FitAddon { constructor() { this.fits = 0; } fit() { this.fits++; } }
  const parent = new Element('div'), host = new Element('div'); parent.style.display = 'block'; parent.append(host);
  const primary = new Terminal({ fontFamily: 'Fixture', fontSize: 14, cursorBlink: true, theme: { background: '#101722' } });
  const api = {
    spawn: async args => { calls.spawn.push(args); return options.spawn ? options.spawn(args) : 22; },
    kill: async id => { calls.kill.push(id); if (options.kill) await options.kill(id); },
    input: (id, data) => calls.input.push([id, data]), resize: (...args) => calls.resize.push(args),
    onData: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  let visible = true;
  const controller = create({ primary, host, api, Terminal, FitAddon, getShell: () => 'powershell', canFit: () => visible, onError: error => calls.errors.push(error.message) });
  return { controller, parent, host, primary, calls, terminals, listeners, emit(id, text) { for (const fn of listeners) fn(id, text); }, visible(value) { visible = value; } };
}

test('split creates one additional owned PTY, keeps primary settings and caps at two panes', async () => {
  const f = fixture(); await f.controller.split(); await f.controller.split();
  assert.equal(f.calls.spawn.length, 1); assert.deepEqual(f.calls.spawn[0], { cols: 80, rows: 24, shell: 'powershell' });
  assert.equal(f.terminals.length, 2); assert.equal(f.controller.state().id, 22); assert.equal(f.parent.children.length, 2);
  assert.deepEqual(f.terminals[1].options, f.primary.options); assert.notEqual(f.terminals[1].options.theme, f.primary.options.theme);
  assert.equal(f.primary.disposed, false); await f.controller.close();
});

test('output/input stay bound to second PTY and focused clear never clears the other pane', async () => {
  const f = fixture(); await f.controller.split(); const secondary = f.terminals[1];
  f.emit(11, 'FOREIGN'); f.emit(22, 'SECOND'); assert.equal(secondary.output, 'SECOND'); assert.equal(f.primary.output, '');
  secondary.data('echo owned\r'); assert.deepEqual(f.calls.input, [[22, 'echo owned\r']]);
  f.controller.clear(); assert.equal(secondary.cleared, 1); assert.equal(f.primary.cleared, 0);
  f.host.fire('focusin'); f.controller.clear(); assert.equal(f.primary.cleared, 1); assert.equal(secondary.cleared, 1);
  f.parent.children[1].fire('focusin'); f.controller.focus(); assert.equal(f.controller.state().active, 'split');
  await f.controller.close();
});

test('close kills only second PTY, unsubscribes, restores layout/focus and allows a new split', async () => {
  const f = fixture(); await f.controller.split(); const old = f.terminals[1];
  await Promise.all([f.controller.close(), f.controller.close()]);
  assert.deepEqual(f.calls.kill, [22]); assert.equal(old.disposed, true); assert.equal(old.data, null); assert.equal(f.listeners.size, 0);
  assert.equal(f.primary.disposed, false); assert.equal(f.parent.children.length, 1); assert.equal(f.parent.style.display, 'block');
  assert.equal(f.controller.state().active, 'primary'); assert.ok(f.primary.focused > 0);
  await f.controller.split(); assert.equal(f.calls.spawn.length, 2); await f.controller.dispose();
});

test('concurrent split requests share the pending spawn and close during startup kills the returned PTY once', async () => {
  let ready; const f = fixture({ spawn: () => new Promise(resolve => { ready = resolve; }) });
  const first = f.controller.split(), duplicate = f.controller.split(); assert.equal(first, duplicate); assert.equal(f.calls.spawn.length, 1);
  const close = f.controller.close(); ready(33); await Promise.all([first, duplicate, close]);
  assert.deepEqual(f.calls.kill, [33]); assert.equal(f.controller.state().split, false); assert.equal(f.listeners.size, 0);
});

test('dispose during pending spawn removes only owned late child and rejects future splits', async () => {
  let ready; const f = fixture({ spawn: () => new Promise(resolve => { ready = resolve; }) });
  const started = f.controller.split(); const disposed = f.controller.dispose(); ready(44); await Promise.all([started, disposed]);
  assert.deepEqual(f.calls.kill, [44]); assert.equal(f.primary.disposed, false); assert.equal(f.host.events.has('focusin'), false);
  await assert.rejects(f.controller.split(), /closed/);
});

test('spawn failure and renderer setup failure leave first terminal usable and permit retry', async () => {
  let fail = true; const f = fixture({ spawn: () => { if (fail) throw new Error('Shell unavailable'); return 55; } });
  await assert.rejects(f.controller.split(), /Shell unavailable/); assert.equal(f.controller.state().split, false); assert.equal(f.parent.children.length, 1); assert.equal(f.listeners.size, 0);
  assert.equal(f.terminals[1].disposed, true); assert.deepEqual(f.calls.kill, []);
  fail = false; await f.controller.split(); await f.controller.close();
  const broken = fixture({ openError: true }); await assert.rejects(broken.controller.split(), /Renderer failed/);
  assert.equal(broken.calls.spawn.length, 0); assert.equal(broken.parent.children.length, 1); assert.equal(broken.primary.disposed, false);
});

test('kill failure is visible and retains the pane so close can be retried without starting another PTY', async () => {
  let fail = true; const f = fixture({ kill: () => { if (fail) throw new Error('Close failed'); } });
  await f.controller.split(); await assert.rejects(f.controller.close(), /Close failed/);
  assert.equal(f.controller.state().split, true); assert.equal(f.terminals[1].disposed, false);
  await f.controller.split(); assert.equal(f.calls.spawn.length, 1);
  fail = false; await f.controller.close(); assert.deepEqual(f.calls.kill, [22, 22]); assert.equal(f.controller.state().split, false);
});

test('hidden panes do not resize or dispose; visible layout resizes only the second owned PTY', async () => {
  const f = fixture(); await f.controller.split(); f.visible(false); f.controller.fit(); assert.deepEqual(f.calls.resize, []);
  assert.equal(f.controller.state().split, true); f.visible(true); f.controller.fit(); assert.deepEqual(f.calls.resize, [[22, 80, 24]]);
  await f.controller.dispose(); f.controller.fit(); assert.deepEqual(f.calls.resize, [[22, 80, 24]]);
});
