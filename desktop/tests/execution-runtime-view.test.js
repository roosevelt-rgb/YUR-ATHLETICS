'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.isConnected = true; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Runtime evidence must remain text.'); }
  append(...items) { this.children.push(...items); } appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; this._text = ''; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
const nodes = host => [host, ...host.children.flatMap(nodes)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resource = 'b'.repeat(64);
function check(status = 'ready', source = 'auto') { return { status, checked_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120000).toISOString(), check_token: 'TOKEN_NOT_VISIBLE', resources: [{ resource_id: resource, distro: 'Ubuntu-24.04', state: status === 'stopped' ? 'stopped' : 'running' }], selected_resource_id: resource, configuration_source: source, runtime: { distro: 'Ubuntu-24.04' }, diagnostics: null, active_setup: null }; }
function setup(state = 'ready', revision = 3) { return { operation_id: id, resource_id: resource, distro: 'Ubuntu-24.04', state, revision, expires_at: new Date(Date.now() + 900000).toISOString(), check: { configuration_source: 'environment' }, evidence: { started_by_this_setup: false, runtime: { distro: 'Ubuntu-24.04' }, owned_process_exit_confirmed: state === 'released', release_reason: state === 'released' ? 'operator' : null } }; }
const envelope = result => ({ ok: true, result });
function view(t, handlers = {}, options = {}) {
  const calls = [], listeners = new Set();
  const api = Object.fromEntries(['check', 'prepare', 'inspect', 'release'].map(method => [method, async request => { calls.push({ method, request }); return handlers[method]?.(request) || envelope({ setup: null, receipt: null }); }]));
  api.onEvent = callback => { listeners.add(callback); return () => listeners.delete(callback); };
  const document = { createElement: tag => new Node(tag) }, window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/execution-runtime-view.js'), 'utf8'), { window, document, crypto: { randomUUID }, setTimeout, clearTimeout, Date });
  const host = new Node('section'); const controller = window.yurExecutionRuntimeView.create(host, { api, uuid: () => id, ...options }); t.after(() => controller.dispose());
  return { host, calls, controller, emit: event => listeners.forEach(callback => callback(event)), get: suffix => nodes(host).find(item => item.id === 'yc-execution-' + suffix), click: async suffix => { const button = nodes(host).find(item => item.id === 'yc-execution-' + suffix); if (!button.disabled) await button.listeners.click(); } };
}

test('mount restores only the main-owned receipt, while Check and Prepare remain explicit separate actions', async t => {
  const observation = check('ready', 'environment');
  const v = view(t, { check: () => envelope({ check: observation }) }); await tick();
  assert.deepEqual(v.calls.map(item => item.method), ['inspect']); assert.equal(v.get('prepare').disabled, true);
  await v.click('check'); assert.equal(v.get('prepare').disabled, false); assert.match(v.get('prepare').textContent, /Keep ready for 15 minutes/);
  assert.equal(v.get('distro').disabled, true); assert.match(v.get('source').textContent, /YUR_EXECUTION_DISTRO/);
  assert.equal(v.host.textContent.includes('TOKEN_NOT_VISIBLE'), false); assert.equal(v.calls.filter(item => item.method === 'prepare').length, 0);
});

test('ready setup restores distro, environment priority, lifetime and receipt without another runtime check', async t => {
  const current = setup(); current.evidence.started_by_this_setup = true;
  const v = view(t, { inspect: () => envelope({ setup: current, receipt: { hash: 'c'.repeat(64) } }) }); await tick();
  assert.equal(v.host.dataset.operationId, id); assert.match(v.get('distro').textContent, /Ubuntu-24.04.*retained setup/);
  assert.match(v.get('source').textContent, /environment setting takes precedence/); assert.equal(v.get('prepare').disabled, true);
  assert.match(v.get('expiry').textContent, /A start was attempted from the observed stopped state/); assert.doesNotMatch(v.get('expiry').textContent, /This setup started/);
  assert.equal(v.calls.length, 1); assert.match(v.get('receipt').textContent, new RegExp('c'.repeat(64)));
});

test('Prepare captures its UUID before awaiting and a late acknowledgment cannot downgrade a newer committed event', async t => {
  let resolve; const v = view(t, { check: () => envelope({ check: check() }), prepare: () => new Promise(done => resolve = done) }); await tick(); await v.click('check');
  const pending = v.click('prepare'); assert.equal(v.host.dataset.operationId, id); assert.equal(v.get('prepare').disabled, true); await v.click('prepare');
  assert.equal(v.calls.filter(item => item.method === 'prepare').length, 1);
  v.emit({ type: 'state', operation_id: id, setup: setup('ready', 3), receipt: { hash: 'd'.repeat(64) } });
  resolve(envelope({ setup: setup('starting', 2), receipt: { hash: 'e'.repeat(64) }, replayed: false })); await pending;
  assert.equal(v.host.dataset.state, 'ready'); assert.match(v.get('receipt').textContent, new RegExp('d'.repeat(64))); assert.equal(v.get('release').disabled, false);
});

test('an uncertain acknowledgment keeps the same operation for Inspect and never automatically prepares again', async t => {
  let initial = true;
  const v = view(t, { check: () => envelope({ check: check() }), prepare: () => ({ ok: false, error: { message: 'Acknowledgment timeout; state is uncertain.' } }), inspect: () => initial ? (initial = false, envelope({ setup: null, receipt: null })) : envelope({ setup: setup(), receipt: { hash: 'f'.repeat(64) } }) }); await tick(); await v.click('check'); await v.click('prepare');
  assert.equal(v.host.dataset.state, 'uncertain'); assert.equal(v.get('prepare').disabled, true); assert.equal(v.get('check').disabled, true); assert.equal(v.get('inspect').disabled, false);
  await v.click('inspect'); assert.equal(v.calls.at(-1).request.operation_id, id); assert.equal(v.host.dataset.state, 'ready'); assert.equal(v.calls.filter(item => item.method === 'prepare').length, 1);
});

test('unknown or mismatch observations never enable preparation, and process text remains inert', async t => {
  const observation = check('unknown'); observation.check_token = null; observation.diagnostics = { message: '<img src=x onerror=alert(1)>status timeout' };
  const v = view(t, { check: () => envelope({ check: observation }) }); await tick(); await v.click('check');
  assert.equal(v.get('prepare').disabled, true); assert.match(v.get('status').textContent, /availability is undetermined/); assert.ok(v.get('status').textContent.includes('<img'));
  assert.equal(nodes(v.host).some(item => item.tagName === 'img'), false); assert.doesNotMatch(v.get('status').textContent, /is stopped/);
});

test('selection saves only the chosen installed distro before checking; detached responses do not alter another view', async t => {
  const order = [], observation = check(); observation.resources.push({ resource_id: 'a'.repeat(64), distro: 'Other', state: 'stopped' });
  let resolve;
  const v = view(t, { check: request => { order.push('check:' + request.resource_id); return envelope({ check: observation }); }, prepare: () => new Promise(done => resolve = done) }, { saveSelection: async distro => { order.push('save:' + distro); } }); await tick(); await v.click('check');
  v.get('distro').value = 'a'.repeat(64); await v.get('distro').listeners.change();
  assert.deepEqual(order.slice(-2), ['save:Other', 'check:' + 'a'.repeat(64)]);
  const pending = v.click('prepare'); v.controller.dispose(); const before = v.host.textContent;
  resolve(envelope({ setup: setup(), receipt: { hash: 'd'.repeat(64) } })); await pending; assert.equal(v.host.textContent, before);
});

test('Release reports only the confirmed owned hold and permits a new explicit Check', async t => {
  const v = view(t, { inspect: () => envelope({ setup: setup(), receipt: { hash: 'a'.repeat(64) } }), release: request => { assert.equal(request.operation_id, id); return envelope({ setup: setup('released', 5), receipt: { hash: 'b'.repeat(64) }, replayed: false }); } }); await tick(); await v.click('release');
  assert.equal(v.host.dataset.state, 'released'); assert.match(v.get('status').textContent, /Owned hold released/); assert.equal(v.get('release').disabled, true); assert.equal(v.get('check').disabled, false);
  assert.doesNotMatch(v.get('status').textContent, /distribution stopped|shutdown|mission retried/);
});

test('an absent operation response clears uncertainty without presenting a fabricated release', async t => {
  const v = view(t, { check: () => envelope({ check: check() }), prepare: () => ({ ok: false, error: { message: 'Uncertain acknowledgment.' } }), release: () => envelope({ setup: null, receipt: null, replayed: true }) }); await tick(); await v.click('check'); await v.click('prepare'); await v.click('release');
  assert.equal(v.host.dataset.operationId, ''); assert.equal(v.host.dataset.state, 'ready');
  assert.match(v.get('status').textContent, /No release was claimed/); assert.equal(v.get('release').disabled, true); assert.equal(v.get('prepare').disabled, true, 'A new explicit Check is still required');
});

test('a newer Check supersedes a terminal setup label without replacing its historical runtime or receipt', async t => {
  let observation = check('unknown'); observation.runtime = null; observation.check_token = null; observation.diagnostics = { code: 'STATUS_UNKNOWN', message: 'The new status query timed out.' };
  let current = setup(); const releasedReceipt = { hash: 'e'.repeat(64) };
  const v = view(t, { inspect: () => envelope({ setup: current, receipt: releasedReceipt }), release: () => { current = setup('released', 5); return envelope({ setup: current, receipt: releasedReceipt, replayed: false }); }, check: () => envelope({ check: observation }) });
  await tick(); await v.click('release'); assert.equal(v.host.dataset.state, 'released');
  await v.click('check'); assert.equal(v.host.dataset.state, 'unknown'); assert.match(v.get('status').textContent, /availability is undetermined.*new status query timed out/);
  assert.doesNotMatch(v.get('status').textContent, /ready|passed verification|Owned hold released/i); assert.equal(v.get('prepare').disabled, true);
  let facts = JSON.parse(v.get('receipt').textContent);
  assert.equal(facts.latest_check.runtime, null); assert.equal(facts.latest_check.status, 'unknown'); assert.equal(facts.retained_setup.runtime_at_verification.distro, 'Ubuntu-24.04'); assert.deepEqual(facts.receipt, releasedReceipt);
  await v.click('inspect'); assert.equal(v.host.dataset.state, 'unknown', 'Re-reading the same historical revision does not hide a newer Check');
  observation = check('ready'); await v.click('check');
  assert.equal(v.host.dataset.state, 'ready'); assert.match(v.get('status').textContent, /passed verification.*for this check/); assert.equal(v.get('prepare').disabled, false);
  facts = JSON.parse(v.get('receipt').textContent); assert.equal(facts.latest_check.runtime.distro, 'Ubuntu-24.04'); assert.equal(facts.retained_setup.state, 'released'); assert.deepEqual(facts.receipt, releasedReceipt);
  observation = check('mismatch'); observation.runtime = null; observation.check_token = null; observation.diagnostics = { message: 'The checked environment differs.' }; await v.click('check');
  assert.equal(v.host.dataset.state, 'mismatch'); assert.match(v.get('status').textContent, /did not match.*environment differs/); assert.equal(v.get('prepare').disabled, true);
});
