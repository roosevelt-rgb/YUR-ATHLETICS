'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { create } = require('../src/recent-work');

// Minimal inert DOM. Any attempted HTML interpretation fails this fixture.
class Node {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = ''; this._text = ''; this.value = ''; this.disabled = false; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Recorded work must remain inert text'); }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) { const at = this.children.indexOf(node); if (at >= 0) this.children.splice(at, 1); node.parentNode = null; return node; }
  replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
  async dispatch(name) { for (const callback of this.listeners.get(name) || []) await callback({ target: this }); }
}
const all = node => [node, ...node.children.flatMap(all)];
const find = (host, className) => all(host).find(node => node.className.split(' ').includes(className));
const cards = host => all(host).filter(node => node.className === 'yc-recent-card');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const mid = number => number.toString(16).padStart(32, '0');
function mission(number = 1, changes = {}) {
  return { id: mid(number), request_id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222',
    status: 'completed', created_at: '2026-09-15T09:00:00+00:00', updated_at: '2026-09-15T10:00:00+00:00', revision: 4,
    mode: 'work', goal: `Task ${number}`, root: null, provider: 'ollama', model: 'fixture', answer: 'Retained answer', error: '', step_count: 1,
    artifacts: [{ id: mid(1000 + number), kind: 'artifact', status: 'committed', name: `report-${number}.txt` }], ...changes };
}
const response = rows => ({ ok: true, result: { missions: rows } });
function setup(options = {}, implementation = create) {
  const document = { createElement: tag => new Node(tag, document) }; const host = new Node('main', document);
  const opened = [], conversations = []; let calls = 0;
  const view = implementation(host, { list: async () => { calls++; return response([mission()]); },
    onOpenWork: (...ids) => opened.push(ids), onOpenConversation: id => conversations.push(id), ...options });
  return { host, view, opened, conversations, calls: () => calls, document };
}

test('CommonJS and browser expose the same read-only create interface', async () => {
  const sandbox = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/recent-work.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.yurRecentWork.create, 'function');
  const fixture = setup({}, sandbox.window.yurRecentWork.create); await settle();
  assert.equal(fixture.calls(), 1); assert.equal(cards(fixture.host).length, 1);
  assert.deepEqual(Object.keys(fixture.view).sort(), ['dispose', 'refresh']);
  assert.deepEqual(fixture.opened, []); assert.deepEqual(fixture.conversations, []);
});

test('recorded statuses and bounded coverage stay explicit without implying live activity', async () => {
  const rows = ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'].map((status, index) => mission(index + 1, { status }));
  const fixture = setup({ list: async () => response(rows) }); await settle();
  assert.match(fixture.host.textContent, /200 most recently created work records/);
  assert.match(fixture.host.textContent, /not proof that a process is active/);
  assert.match(fixture.host.textContent, /does not run or resume work/);
  for (const label of ['Queued', 'Running', 'Awaiting approval', 'Completed', 'Failed', 'Cancelled']) assert.match(fixture.host.textContent, new RegExp(`Recorded: ${label}`));
  assert.equal(all(fixture.host).some(node => node.tagName === 'button' && /resume|run again|retry/i.test(node.textContent)), false);
  const full = setup({ list: async () => response(Array.from({ length: 200 }, (_, index) => mission(index + 1))) }); await settle();
  assert.equal(cards(full.host).length, 200); assert.match(find(full.host, 'yc-recent-count').textContent, /Latest 200 only; older work may exist/);
});

test('search covers goal, answer and artifact names and combines with recorded-state filtering', async () => {
  const rows = [mission(1, { goal: 'Survey concrete', answer: 'Measured quantity', status: 'running' }),
    mission(2, { goal: 'Plan procurement', answer: 'Measured quantity', status: 'completed', artifacts: [{ id: mid(22), kind: 'edit', status: 'proposed', name: 'estimate-α.py' }] })];
  const fixture = setup({ list: async () => response(rows) }); await settle();
  const search = find(fixture.host, 'yc-recent-search'), status = find(fixture.host, 'yc-recent-status');
  search.value = 'CONCRETE'; await search.dispatch('input'); assert.deepEqual(cards(fixture.host).map(node => node.dataset.missionId), [mid(1)]);
  search.value = 'measured'; await search.dispatch('input'); assert.equal(cards(fixture.host).length, 2);
  status.value = 'completed'; await status.dispatch('change'); assert.deepEqual(cards(fixture.host).map(node => node.dataset.missionId), [mid(2)]);
  search.value = 'ESTIMATE-Α'; await search.dispatch('input'); assert.equal(cards(fixture.host).length, 1);
  search.value = 'missing'; await search.dispatch('input'); assert.equal(cards(fixture.host).length, 0); assert.match(fixture.host.textContent, /No loaded work matches/);
  assert.equal(fixture.calls(), 0); assert.deepEqual(fixture.opened, []);
});

test('sort order has deterministic mission-ID ties and operates only on the loaded set', async () => {
  const rows = [mission(3, { goal: 'Apple' }), mission(2, { goal: 'Zebra' }), mission(1, { goal: 'apple', updated_at: '2026-09-15T11:00:00Z' })];
  const fixture = setup({ list: async () => response(rows) }); await settle();
  const ids = () => cards(fixture.host).map(node => node.dataset.missionId);
  assert.deepEqual(ids(), [mid(1), mid(2), mid(3)]);
  const sort = find(fixture.host, 'yc-recent-sort'); sort.value = 'oldest'; await sort.dispatch('change'); assert.deepEqual(ids(), [mid(2), mid(3), mid(1)]);
  sort.value = 'goal'; await sort.dispatch('change'); assert.deepEqual(ids(), [mid(1), mid(3), mid(2)]);
});

test('all summaries stay inert and navigation callbacks receive only exact retained IDs', async () => {
  const hostile = '<img src=x onerror="execute()">'; const row = mission(1, { goal: hostile, answer: '<script>execute()</script>', error: 'Literal failure text', artifacts: [{ id: mid(99), name: hostile, kind: 'artifact', status: 'committed' }] });
  const fixture = setup({ list: async () => response([row]) }); await settle();
  assert.ok(fixture.host.textContent.includes(hostile)); assert.ok(fixture.host.textContent.includes('<script>execute()</script>'));
  assert.equal(all(fixture.host).some(node => ['script', 'img', 'iframe', 'a'].includes(node.tagName)), false);
  assert.deepEqual(fixture.opened, []);
  await find(fixture.host, 'yc-recent-open-work').dispatch('click');
  await find(fixture.host, 'yc-recent-open-conversation').dispatch('click');
  await find(fixture.host, 'yc-recent-open-artifact').dispatch('click');
  assert.deepEqual(fixture.opened, [[row.id], [row.id, mid(99)]]); assert.deepEqual(fixture.conversations, [row.conversation_id]);
});

test('Python summary character bounds preserve supplementary Unicode and reject oversized text', async () => {
  const goal = '🧱'.repeat(500); let next = response([mission(1, { goal, answer: goal })]);
  const fixture = setup({ list: async () => next }); await settle();
  assert.equal(cards(fixture.host).length, 1); assert.ok(fixture.host.textContent.includes(goal));
  next = response([mission(2, { goal: goal + '🧱' })]); assert.equal(await fixture.view.refresh(), false);
  assert.deepEqual(cards(fixture.host).map(node => node.dataset.missionId), [mid(1)]);
});

test('a newer refresh wins, including when an older result is malformed or fails late', async () => {
  const older = deferred(), newer = deferred(); let calls = 0;
  const fixture = setup({ list: () => ++calls === 1 ? older.promise : newer.promise });
  const refresh = fixture.view.refresh(); newer.resolve(response([mission(2)])); assert.equal(await refresh, true);
  older.resolve({ ok: true, result: { missions: 'malformed stale reply' } }); await settle();
  assert.deepEqual(cards(fixture.host).map(node => node.dataset.missionId), [mid(2)]);
  assert.equal(find(fixture.host, 'yc-recent-error').hidden, true); assert.equal(find(fixture.host, 'yc-recent-refresh').disabled, false);
});

test('dispose and a replaced host prevent late asynchronous DOM writes or navigation', async () => {
  const pending = deferred(); const fixture = setup({ list: () => pending.promise }); fixture.view.dispose();
  const replacement = fixture.document.createElement('aside'); replacement.textContent = 'Other workspace'; fixture.host.appendChild(replacement);
  pending.resolve(response([mission()])); await settle(); assert.equal(fixture.host.textContent, 'Other workspace'); assert.equal(await fixture.view.refresh(), false);
  const late = deferred(), other = setup({ list: () => late.promise }); other.host.replaceChildren(other.document.createElement('different'));
  late.resolve(response([mission()])); await settle(); assert.equal(other.host.children[0].tagName, 'different'); assert.equal(cards(other.host).length, 0);
});

test('refresh failure keeps prior valid records and malformed identities never become links', async () => {
  let next = response([mission()]); const fixture = setup({ list: async () => next }); await settle();
  for (const bad of [response([mission(2, { id: '../unsafe' })]), response([mission(), mission()]), response(Array.from({ length: 201 }, (_, index) => mission(index + 1))),
    response([mission(2, { artifacts: [{ id: '../file', kind: 'artifact', status: 'committed', name: 'bad' }] })]), { ok: false, error: { message: 'Runtime unavailable' } }]) {
    next = bad; assert.equal(await fixture.view.refresh(), false); assert.deepEqual(cards(fixture.host).map(node => node.dataset.missionId), [mid(1)]);
    assert.match(find(fixture.host, 'yc-recent-error').textContent, /Showing the last loaded records/); assert.equal(find(fixture.host, 'yc-recent-refresh').disabled, false);
  }
  assert.deepEqual(fixture.opened, []);
});

test('empty, loading and inaccessible records have usable labels and honest errors', async () => {
  const pending = deferred(); const fixture = setup({ list: () => pending.promise, onOpenWork: async () => { throw new Error('Recorded work unavailable'); } });
  assert.equal(find(fixture.host, 'yc-recent-work').attributes['aria-busy'], 'true'); assert.equal(find(fixture.host, 'yc-recent-count').attributes['aria-live'], 'polite');
  pending.resolve(response([])); await settle(); assert.match(fixture.host.textContent, /No saved Work or Code tasks yet/);
  for (const label of all(fixture.host).filter(node => node.tagName === 'label')) assert.equal(label.htmlFor, label.children[0].id);
  const other = setup({ onOpenWork: async () => { throw new Error('Recorded work unavailable'); } }); await settle();
  await find(other.host, 'yc-recent-open-work').dispatch('click'); assert.match(find(other.host, 'yc-recent-error').textContent, /Recorded work unavailable/);
  assert.equal(find(other.host, 'yc-recent-open-work').disabled, false);
  assert.ok(all(other.host).filter(node => node.tagName === 'button').every(node => node.type === 'button'));
  assert.ok(all(other.host).find(node => node.tagName === 'time').dateTime);
});
