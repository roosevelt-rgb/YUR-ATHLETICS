'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.isConnected = true; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; } get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  set innerHTML(_) { throw new Error('Page metadata must remain text.'); }
  append(...items) { this.children.push(...items); } appendChild(item) { this.children.push(item); return item; }
  setAttribute(key, value) { this[key] = value; } addEventListener(key, value) { this.listeners[key] = value; }
  getBoundingClientRect() { return { left: 600, top: 100, right: 1100, bottom: 700 }; } getClientRects() { return [{}]; } remove() { this.isConnected = false; }
}
const descendants = host => [host, ...host.children.flatMap(descendants)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const descriptor = () => { const now = Date.now(); return { schema: 'yur.work-browser-source.v1', source_id: randomUUID(), source_url: 'https://example.test/page', title: '<img> reviewed page', selected_at: new Date(now).toISOString(), expires_at: new Date(now + 120000).toISOString(), max_acquisitions: 1 }; };
function fixture(t, options = {}, handlers = {}) {
  const calls = []; let eventCallback;
  const page = { url: 'https://example.test/page', title: 'Reviewed page', visible: true, loading: false, canGoBack: false, canGoForward: false };
  const browser = Object.fromEntries(['state', 'navigate', 'back', 'forward', 'reload', 'stop', 'openExternal', 'setBounds', 'setVisible', 'readVisiblePage', 'selectForWork', 'releaseWorkSource'].map(method => [method, async argument => { calls.push({ method, argument }); return handlers[method]?.(argument) || { ok: true, result: page }; }]));
  browser.onEvent = callback => { eventCallback = callback; return () => { eventCallback = null; }; };
  const document = { body: new Node('body'), createElement: tag => new Node(tag), querySelector: () => null };
  const window = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  class Observer { observe() {} disconnect() {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/browser-view.js'), 'utf8'), { window, document, URL, Date, ResizeObserver: Observer, MutationObserver: Observer, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const host = new Node('aside'); const view = window.yurBrowserView.create(host, { api: { browser }, ...options }); t.after(() => view.dispose());
  return { calls, view, helper: window.yurBrowserView, event: value => eventCallback?.(value), get: id => descendants(host).find(item => item.id === id), host };
}

test('Allow Work selects metadata only for the captured conversation while preserving manual Use page in chat', async t => {
  let target = randomUUID(); const original = target, selected = descriptor(), selectionCalls = [], contexts = [], stateCalls = []; let respond;
  const f = fixture(t, { getContextTarget: () => target, onWorkSource: (source, id) => selectionCalls.push({ source, id }), onWorkSelectionState: (id, busy) => stateCalls.push({ id, busy }), onContext: (page, id) => contexts.push({ page, id }) }, {
    selectForWork: request => { assert.equal(request.conversation_id, original); return new Promise(resolve => respond = resolve); },
    readVisiblePage: () => ({ ok: true, result: { schema: 'yur.browser-context.v1', source_url: selected.source_url, sha256: 'a'.repeat(64), text: 'MANUAL_VISIBLE_TEXT', truncated: false } }),
  }); await tick();
  const operation = f.get('yc-browser-allow-work').listeners.click(); target = randomUUID(); assert.equal(f.get('yc-browser-allow-work').disabled, true);
  respond({ ok: true, source: selected }); await operation;
  assert.equal(selectionCalls.length, 1); assert.equal(selectionCalls[0].id, original); assert.equal(JSON.stringify(selectionCalls[0].source), JSON.stringify(selected));
  assert.equal(f.calls.filter(call => call.method === 'readVisiblePage').length, 0); assert.equal(contexts.length, 0); assert.deepEqual(stateCalls.map(call => call.busy), [true, false]);
  await f.get('yc-browser-use').listeners.click(); assert.equal(contexts[0].id, target); assert.equal(contexts[0].page.text, 'MANUAL_VISIBLE_TEXT');
});

test('selection is disabled while the conversation prepares or the page is hidden/loading', async t => {
  let allowed = false; const f = fixture(t, { getContextTarget: randomUUID, onWorkSource() {}, canSelectWork: () => allowed }); await tick();
  assert.equal(f.get('yc-browser-allow-work').disabled, true); await f.get('yc-browser-allow-work').listeners.click(); assert.equal(f.calls.some(call => call.method === 'selectForWork'), false);
  allowed = true; f.view.refresh(); assert.equal(f.get('yc-browser-allow-work').disabled, false);
  f.event({ type: 'state', state: { url: 'https://example.test', loading: true, visible: true } }); assert.equal(f.get('yc-browser-allow-work').disabled, true);
  f.event({ type: 'state', state: { url: 'https://example.test', loading: false, visible: false } }); assert.equal(f.get('yc-browser-allow-work').disabled, true);
});

test('a disposed selection releases its exact unbound source rather than delivering it to another view', async t => {
  const id = randomUUID(), source = descriptor(); let respond, delivered = 0;
  const f = fixture(t, { getContextTarget: () => id, onWorkSource: () => delivered++ }, { selectForWork: () => new Promise(resolve => respond = resolve), releaseWorkSource: () => ({ ok: true, result: { released: true } }) }); await tick();
  const operation = f.get('yc-browser-allow-work').listeners.click(); f.view.dispose(); respond({ ok: true, source }); await operation;
  assert.equal(delivered, 0); assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(call => call.method === 'releaseWorkSource').argument)), { source_id: source.source_id, conversation_id: id });
});

test('page grant descriptors reject bodies, expired timestamps and unexpected authority fields', async t => {
  const f = fixture(t); await tick(); const value = descriptor(); const copy = f.helper.workSource(value); assert.notEqual(copy, value); assert.equal(JSON.stringify(copy), JSON.stringify(value));
  for (const mutation of [source => source.text = 'EAGER_BODY', source => source.authority = { actions: ['navigate'] }, source => source.max_acquisitions = 2, source => source.source_url = 'http://remote.example/', source => source.expires_at = new Date(Date.now() - 1).toISOString()]) { const invalid = { ...value }; mutation(invalid); assert.throws(() => f.helper.workSource(invalid)); }
  assert.equal(f.calls.filter(call => call.method === 'readVisiblePage').length, 0);
});
