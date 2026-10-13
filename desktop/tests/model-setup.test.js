'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, create } = require('../src/model-setup.js');

class Node {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.parentNode = null; this.listeners = {}; this.dataset = {}; this.attributes = {}; this._text = ''; this.value = ''; this.disabled = false; this.isConnected = true; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Model labels must be rendered as text'); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this._text = ''; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; this.isConnected = false; }
}
const all = node => [node, ...node.children.flatMap(all)];
const available = overrides => summarize({ checked: true, contextKey: 'conversation-a', selectedModel: 'ollama:one', mode: 'chat', foundry: { online: false, models: [] }, ollama: { online: true, models: ['one', 'two'] }, ...overrides });
function view(callbacks = {}) {
  const document = { createElement: tag => new Node(tag, document) }, host = document.createElement('div');
  const controller = create(host, callbacks);
  return { host, controller, get: role => all(host).find(item => item.className === 'yc-model-setup-' + role), card: () => all(host).find(item => item.className === 'yc-model-setup'),
    choose(model) { this.get('select').value = model; this.get('select').listeners.change(); } };
}

test('connection evidence distinguishes checking, offline, online with no models, unavailable selection and usable routes', () => {
  assert.equal(summarize().status, 'checking');
  assert.equal(summarize({ checked: true }).status, 'offline');
  const empty = summarize({ checked: true, selectedModel: 'ollama:missing', ollama: { online: true, models: [] } });
  assert.equal(empty.status, 'online-empty'); assert.equal(empty.services[1].status, 'online-empty'); assert.match(empty.message, /will not download or switch/);
  const missing = available({ selectedModel: 'foundry:auto' }); assert.equal(missing.status, 'selected-unavailable'); assert.equal(missing.selectedModel, 'foundry:auto'); assert.equal(missing.models.some(item => item.id === 'foundry:auto'), false);
  assert.equal(available().status, 'usable');
  assert.equal(summarize({ checked: true, selectedModel: 'foundry:auto', foundry: { online: true, models: [] } }).status, 'usable');
});

test('Work and Code explicitly reject the Foundry route without claiming Ollama tool capability verification', () => {
  for (const mode of ['work', 'code']) {
    const state = available({ mode, selectedModel: 'foundry:auto', foundry: { online: true, models: ['remote'] } });
    assert.equal(state.status, 'unsupported'); assert.ok(state.models.filter(item => item.provider === 'foundry').every(item => !item.supported));
    assert.match(state.message, /currently supports Chat/); assert.match(state.message, /tool-capable/);
    assert.match(available({ mode }).message, /does not verify that capability/);
  }
});

test('discovery is bounded and deduplicated, ignores control characters and does not trust models from offline responses', () => {
  const state = available({ foundry: { online: false, models: ['should-not-be-available'] }, ollama: { online: true, models: ['one', { name: 'one' }, { id: 'two' }, { name: 'bad\nname' }, 'x'.repeat(256), ...Array.from({ length: 300 }, (_, i) => `model-${i}`)] } });
  assert.equal(state.models.filter(item => item.id === 'ollama:one').length, 1); assert.ok(state.models.some(item => item.id === 'ollama:two'));
  assert.ok(state.models.length <= 200); assert.ok(state.models.every(item => item.id.length <= 256 && !item.id.includes('\n'))); assert.ok(state.models.every(item => item.provider === 'ollama'));
});

test('mount and update cause no callbacks, retain unavailable selection and render provider text inertly', () => {
  let calls = 0; const v = view({ onChoose: () => calls++, onRefresh: () => calls++, onOpenSettings: () => calls++ });
  const malicious = '<img src=x onerror=alert(1)>';
  v.controller.update(available({ selectedModel: 'foundry:auto', ollama: { online: true, models: [malicious] } }));
  assert.equal(calls, 0); assert.equal(v.get('select').value, 'foundry:auto'); assert.equal(v.get('use').disabled, true);
  assert.ok(v.host.textContent.includes(malicious)); assert.equal(all(v.host).some(item => item.tagName === 'img'), false);
  assert.equal(v.get('status').attributes['aria-live'], 'polite'); assert.equal(v.get('error').attributes.role, 'alert');
  assert.equal(v.get('label').htmlFor, v.get('select').id);
});

test('explicit candidate survives refresh and disappearance without silently choosing another model', () => {
  const v = view({ onChoose: async () => {} }); v.controller.update(available()); v.choose('ollama:two');
  v.controller.update(available({ ollama: { online: true, models: ['three', 'two', 'one'] } }));
  assert.equal(v.get('select').value, 'ollama:two'); assert.equal(v.get('use').disabled, false);
  v.controller.update(available({ ollama: { online: true, models: ['one'] } }));
  assert.equal(v.get('select').value, 'ollama:two'); assert.equal(v.get('use').disabled, true); assert.match(v.get('select').textContent, /ollama:two · unavailable/);
});

test('choosing captures model and default intent, blocks duplicate actions, and announces success only after acknowledgment', async () => {
  const calls = []; let resolve; const v = view({ onChoose: value => { calls.push(value); return new Promise(done => resolve = done); }, onRefresh: () => assert.fail('Refresh during choice') });
  v.controller.update(available()); v.choose('ollama:two'); v.get('default').checked = true;
  const operation = v.get('use').listeners.click(); await v.get('use').listeners.click(); await v.get('refresh').listeners.click();
  assert.deepEqual(calls, [{ model: 'ollama:two', makeDefault: true }]); assert.equal(v.get('use').disabled, true); assert.equal(v.get('select').disabled, true);
  assert.match(v.get('status').textContent, /Applying/); assert.doesNotMatch(v.get('status').textContent, /saved as/);
  resolve(); await operation; assert.equal(v.get('use').disabled, false); assert.match(v.get('status').textContent, /saved as the default/);
});

test('failed selection stays visible for an explicit retry and never reports a successful save', async () => {
  let calls = 0; const v = view({ onChoose: async () => { calls++; throw new Error('Journal is unavailable'); } });
  v.controller.update(available()); await v.get('use').listeners.click();
  assert.equal(v.get('error').hidden, false); assert.equal(v.get('error').textContent, 'Journal is unavailable'); assert.equal(v.get('select').value, 'ollama:one'); assert.doesNotMatch(v.get('status').textContent, /Model applied/); assert.equal(calls, 1);
  await v.get('use').listeners.click(); assert.equal(calls, 2);
});

test('conversation change clears unsubmitted choice/default and ignores the former conversation acknowledgment', async () => {
  let resolve; const v = view({ onChoose: () => new Promise(done => resolve = done) });
  v.controller.update(available()); v.choose('ollama:two'); v.get('default').checked = true;
  const operation = v.get('use').listeners.click();
  v.controller.update(available({ contextKey: 'conversation-b', selectedModel: 'ollama:one' }));
  assert.equal(v.get('select').value, 'ollama:one'); assert.equal(v.get('default').checked, false);
  resolve(); await operation; assert.doesNotMatch(v.get('status').textContent, /Model applied|saved as/); assert.equal(v.get('use').disabled, false);
});

test('busy or checking context cannot apply a model, and refresh/settings remain explicit callbacks', async () => {
  const calls = []; const v = view({ onChoose: () => calls.push('choose'), onOpenSettings: () => calls.push('settings'), onRefresh: () => calls.push('refresh') });
  assert.equal(v.get('use').disabled, true); await v.get('refresh').listeners.click(); await v.get('settings').listeners.click();
  assert.deepEqual(calls, ['refresh', 'settings']);
  v.controller.update(available({ busy: true })); await v.get('use').listeners.click(); v.choose('ollama:two');
  assert.equal(v.get('select').value, 'ollama:one'); assert.deepEqual(calls, ['refresh', 'settings']);
});

test('disposing removes only its own card and suppresses late asynchronous errors or updates', async () => {
  let reject; const v = view({ onChoose: () => new Promise((_resolve, fail) => reject = fail) });
  const sibling = v.host.ownerDocument.createElement('p'); sibling.textContent = 'Unrelated settings'; v.host.appendChild(sibling);
  v.controller.update(available()); const operation = v.get('use').listeners.click(); v.controller.dispose();
  reject(new Error('late failure')); await operation; v.controller.update(available({ selectedModel: 'ollama:two' }));
  assert.equal(v.host.textContent, 'Unrelated settings'); assert.equal(v.host.children.length, 1);
});
