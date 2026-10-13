'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../src/activity-view');
const { createActivityFeed } = require('../src/activity-feed');

class Node {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = ''; this.value = ''; this._text = ''; this.disabled = false; this.isConnected = true; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(_) { throw new Error('Telemetry must remain inert text'); }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, before) { node.remove(); const index = this.children.indexOf(before); node.parentNode = this; if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); return node; }
  removeChild(node) { const index = this.children.indexOf(node); if (index >= 0) this.children.splice(index, 1); node.parentNode = null; return node; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
  async dispatch(name) { for (const callback of this.listeners.get(name) || []) await callback({ target: this }); }
}
const all = node => [node, ...node.children.flatMap(all)];
const find = (node, className) => all(node).find(item => item.className.split(' ').includes(className));
const cards = host => all(host).filter(item => item.className === 'yc-activity-card');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const uuid = number => `11111111-1111-4111-8111-${number.toString(16).padStart(12, '0')}`;
const mid = number => number.toString(16).padStart(32, '0');
const BASE = Date.parse('2026-09-16T12:00:00Z');
const iso = timestamp => new Date(timestamp).toISOString();
const copy = value => JSON.parse(JSON.stringify(value));
function run(number = 1, changes = {}) {
  return { id: uuid(number), kind: 'work', origin: 'conversation', conversation_id: uuid(200 + number), mission_id: mid(number), label: 'Work request', provider: 'ollama', model: 'fixture-model', status: 'running', phase: 'Waiting for provider',
    started_at: iso(BASE - 5000), updated_at: iso(BASE - 1000), ended_at: null, request_active: true, output_chars: 0,
    tools: [{ id: mid(80), name: 'read_file', status: 'completed' }], events: [{ sequence: 1, at: iso(BASE - 5000), kind: 'lifecycle', label: 'Request started', step_id: null }, { sequence: 2, at: iso(BASE - 1000), kind: 'model', label: 'Model request sent', step_id: null }], omitted_events: 0, ...changes };
}
function snapshot(runs = [run()], changes = {}) { return { schema: 'yur.activity.v1', session_id: uuid(1000), sequence: 2, observed_at: iso(BASE), runs, omitted_runs: 0, ...changes }; }
const response = data => ({ ok: true, result: data });
function fixture(options = {}, implementation = create) {
  const document = { createElement: tag => new Node(tag, document) }, host = new Node('main', document), intervals = new Map();
  let time = BASE, timerId = 0, calls = 0, unsubscribed = 0, deliver = null;
  const opened = [], conversations = [];
  const timers = { setInterval(fn, ms) { intervals.set(++timerId, { fn, ms, next: time + ms }); return timerId; }, clearInterval(id) { intervals.delete(id); } };
  const read = options.snapshot || (() => response(snapshot([run()], { observed_at: iso(time) })));
  const view = implementation(host, { now: () => time, timers, onOpenWork: id => opened.push(id), onOpenConversation: id => conversations.push(id), ...options,
    snapshot: async () => { calls++; return read(); }, onEvent: options.onEvent || (callback => { deliver = callback; return () => { unsubscribed++; }; }) });
  return { host, view, document, opened, conversations, intervals, calls: () => calls, unsubscribed: () => unsubscribed,
    push: value => deliver?.(value), time: () => time,
    async advance(ms) { const end = time + ms; while (time < end) { time = Math.min(end, time + 1000); for (const item of [...intervals.values()]) if (time >= item.next) { item.next += item.ms; item.fn(); } await settle(); } },
  };
}

test('browser and CommonJS expose the same read-only interface and mount subscribes before one snapshot', async () => {
  const sandbox = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/activity-view.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.yurActivityView.create, 'function');
  const f = fixture({}, sandbox.window.yurActivityView.create); await settle();
  assert.deepEqual(Object.keys(f.view).sort(), ['dispose', 'refresh']); assert.equal(f.calls(), 1); assert.equal(cards(f.host).length, 1);
  assert.equal(find(f.host, 'yc-activity-connection').dataset.state, 'live'); assert.deepEqual(f.opened, []); assert.deepEqual(f.conversations, []);
  assert.ok(all(f.host).filter(node => node.tagName === 'button').every(node => node.type === 'button'));
  for (const label of all(f.host).filter(node => node.tagName === 'label')) assert.equal(label.htmlFor, label.children[0].id);
  f.view.dispose(); assert.equal(f.intervals.size, 0); assert.equal(f.unsubscribed(), 1);
});

test('actual host projection renders scheduled Code tools and terminal factory observations', async () => {
  let clock = BASE - 3000, push = null;
  const feed = createActivityFeed({ sessionId: uuid(1000), now: () => clock, onChange: value => push?.(value) });
  assert.equal(feed.observe({ type: 'begin', id: uuid(1), kind: 'code', origin: 'schedule', conversation_id: uuid(201), provider: 'ollama', model: 'fixture-model', phase: 'queued' }), true);
  const f = fixture({ snapshot: () => response(feed.snapshot()), onEvent: callback => { push = callback; return () => { push = null; }; } }); await settle();
  assert.equal(cards(f.host).length, 1); assert.match(f.host.textContent, /Code · Scheduled task/);
  clock += 1000;
  feed.observe({ type: 'update', id: uuid(1), phase: 'tool_running', mission_id: mid(1), tool: { id: mid(80), name: 'run_python_checks', status: 'running' } });
  assert.match(f.host.textContent, /run_python_checks/); assert.equal(cards(f.host)[0].dataset.category, 'active');
  clock += 1000;
  feed.observe({ type: 'finish', id: uuid(1), phase: 'completed', output_chars: 48 });
  feed.observe({ type: 'begin', id: uuid(2), kind: 'factory', origin: 'factory', conversation_id: null, provider: null, model: null, phase: 'factory_running' });
  feed.observe({ type: 'finish', id: uuid(2), phase: 'unconfirmed' });
  assert.equal(cards(f.host).length, 2); assert.match(f.host.textContent, /48 output characters observed/);
  assert.equal(cards(f.host).find(card => card.dataset.requestId === uuid(1)).dataset.category, 'finished');
  assert.equal(cards(f.host).find(card => card.dataset.requestId === uuid(2)).dataset.category, 'unconfirmed');
  assert.equal(find(f.host, 'yc-activity-error').hidden, true); f.view.dispose(); assert.equal(push, null);
});

test('admitted uppercase Chat UUIDs preserve exact identity without hiding other host records', async () => {
  const feed = createActivityFeed({ sessionId: uuid(0xabcdef).toUpperCase(), now: () => BASE });
  const chatId = uuid(0xabc).toUpperCase(), conversationId = uuid(0xdef).toUpperCase();
  assert.equal(feed.observe({ type: 'begin', id: chatId, kind: 'chat', origin: 'conversation', conversation_id: conversationId, provider: 'ollama', model: 'fixture-model', phase: 'model_running' }), true);
  assert.equal(feed.observe({ type: 'begin', id: uuid(1), kind: 'work', origin: 'conversation', conversation_id: uuid(201), provider: 'ollama', model: 'fixture-model', phase: 'queued' }), true);
  const f = fixture({ snapshot: () => response(feed.snapshot()) }); await settle();
  assert.equal(cards(f.host).length, 2); assert.equal(find(f.host, 'yc-activity-error').hidden, true);
  assert.equal(find(f.host, 'yc-activity').dataset.sessionId, uuid(0xabcdef).toUpperCase());
  const chat = cards(f.host).find(card => card.dataset.requestId === chatId); assert.ok(chat);
  await find(chat, 'yc-activity-open-conversation').dispatch('click'); assert.deepEqual(f.conversations, [conversationId]);
  assert.ok(cards(f.host).some(card => card.dataset.requestId === uuid(1))); f.view.dispose();
});

test('terminal requests qualify retained running tools without inventing completion events', async () => {
  for (const status of ['cancelled', 'failed']) {
    const tools = [{ id: mid(80), name: 'run_python_checks', status: 'running' }];
    const initial = run(1, { tools }), f = fixture({ snapshot: () => response(snapshot([initial])) }); await settle();
    const card = cards(f.host)[0], timeline = find(card, 'yc-activity-timeline'), priorEvents = [...timeline.children[1].children];
    assert.equal(find(card, 'yc-activity-tools').children[0].children[1].textContent, 'Running');
    f.push(snapshot([run(1, { status, tools, request_active: false, ended_at: iso(BASE), updated_at: iso(BASE) })], { sequence: 3 }));
    assert.equal(cards(f.host)[0], card);
    assert.equal(find(card, 'yc-activity-tools').children[0].children[1].textContent, 'Last observed running; completion not observed');
    assert.deepEqual(timeline.children[1].children, priorEvents);
    assert.equal(find(card, 'yc-activity-tools').textContent.includes('Completed'), false);
    assert.equal(find(card, 'yc-activity-tools').textContent.includes('Rejected'), false); f.view.dispose();
  }
});

test('summary separates tracked, waiting, finished and unconfirmed requests without invented progress', async () => {
  const rows = [run(1), run(2, { kind: 'chat', mission_id: null, status: 'stopping' }), run(3, { status: 'queued', origin: 'schedule' }),
    run(4, { status: 'awaiting_approval', request_active: false, ended_at: iso(BASE - 1000) }),
    ...['completed', 'failed', 'cancelled', 'unconfirmed'].map((status, index) => run(index + 5, { kind: 'factory', origin: 'factory', status, request_active: false, ended_at: iso(BASE - 1000), conversation_id: null }))];
  const f = fixture({ snapshot: async () => response(snapshot(rows, { omitted_runs: 9 })) }); await settle();
  const totals = Object.fromEntries(all(find(f.host, 'yc-activity-summary')).filter(node => node.dataset.category).map(node => [node.dataset.category, node.children[0].textContent]));
  assert.deepEqual(totals, { active: '2', waiting: '2', finished: '3', unconfirmed: '1' });
  assert.match(f.host.textContent, /active request does not prove the model is thinking/); assert.match(f.host.textContent, /8 retained requests · 9 omitted/);
  assert.match(f.host.textContent, /Scheduled task/); assert.match(f.host.textContent, /Request active in the last host snapshot/);
  assert.equal(/\d+%|tokens\/s|thinking speed/.test(f.host.textContent), false);
  assert.equal(all(f.host).some(node => node.tagName === 'button' && /cancel|resume|retry mission/i.test(node.textContent)), false);
  f.view.dispose();
});

test('newer pushes win the initial snapshot race and equal-sequence heartbeat changes only freshness', async () => {
  const pending = deferred(), f = fixture({ snapshot: () => pending.promise });
  const progressed = run(1, { phase: 'Running bounded tool', tools: [{ id: mid(81), name: 'create_artifact', status: 'running' }], updated_at: iso(BASE) });
  f.push(snapshot([progressed], { sequence: 3 }));
  pending.resolve(response(snapshot())); await settle();
  assert.equal(find(f.host, 'yc-activity-phase').textContent, 'Running bounded tool'); assert.equal(find(f.host, 'yc-activity').dataset.sequence, '3');
  const currentCard = cards(f.host)[0];
  f.push(snapshot([run(1, { phase: 'MUST NOT OVERWRITE SAME SEQUENCE' })], { sequence: 3, observed_at: iso(BASE + 1000) }));
  assert.equal(cards(f.host)[0], currentCard); assert.equal(find(f.host, 'yc-activity-phase').textContent, 'Running bounded tool');
  f.push(snapshot([run(1, { phase: 'STALE UPDATE' })], { sequence: 2, observed_at: iso(BASE + 2000) }));
  assert.equal(find(f.host, 'yc-activity-phase').textContent, 'Running bounded tool'); f.view.dispose();
});

test('only the newest snapshot response can change sessions and retired pushes cannot replace current cards', async () => {
  const reads = [], f = fixture({ snapshot: () => { const pending = deferred(); reads.push(pending); return pending.promise; } });
  reads[0].resolve(response(snapshot())); await settle();
  f.push(snapshot([run(2)], { session_id: uuid(1001), sequence: 10 })); assert.equal(cards(f.host)[0].dataset.requestId, uuid(1));
  const older = f.view.refresh(), newer = f.view.refresh();
  reads[2].resolve(response(snapshot([run(3, { kind: 'code', label: 'Code request' })], { session_id: uuid(1002), sequence: 2 }))); assert.equal(await newer, true);
  reads[1].resolve(response(snapshot([run(2)], { session_id: uuid(1001), sequence: 50 }))); assert.equal(await older, false);
  f.push(snapshot([run(1)], { sequence: 99 }));
  assert.equal(cards(f.host)[0].dataset.requestId, uuid(3)); assert.equal(find(f.host, 'yc-activity').dataset.sessionId, uuid(1002));
  f.view.dispose();
});

test('malformed identities, bounds, timestamps and events fail closed while preserving valid observations', async () => {
  let next = snapshot(); const f = fixture({ snapshot: async () => response(next) }); await settle();
  const invalid = [snapshot([run(1, { id: '../unsafe' })]), snapshot([run(), run()]), snapshot(Array.from({ length: 65 }, (_, i) => run(i + 1))),
    snapshot([run(1, { model: 'x'.repeat(257) })]), snapshot([run(1, { output_chars: -1 })]), snapshot([run(1, { started_at: iso(BASE + 1000) })]),
    snapshot([run(1, { tools: [{ id: mid(80), name: 'read_file; rm', status: 'running' }] })]), snapshot([run(1, { events: [{ sequence: 3, at: iso(BASE), kind: 'thinking', label: 'secret', step_id: null }] })]),
    snapshot([run(1, { events: [run().events[0], run().events[0]] })]), snapshot([run(1, { request_active: true, ended_at: iso(BASE) })])];
  for (const value of invalid) { next = value; assert.equal(await f.view.refresh(), false); assert.equal(cards(f.host)[0].dataset.requestId, uuid(1)); assert.match(find(f.host, 'yc-activity-error').textContent, /Retained observations/); }
  assert.deepEqual(f.opened, []); assert.deepEqual(f.conversations, []); f.view.dispose();
});

test('unknown reasoning, prompt, arguments and result fields are ignored and allowed text remains inert', async () => {
  const source = snapshot([run(1, { label: '<img src=x onerror=execute()>', model: '<script>execute()</script>', thinking: 'PRIVATE_REASONING', input: 'PRIVATE_INPUT', response: 'PRIVATE_RESPONSE' })]);
  source.reasoning = 'PRIVATE_ROOT'; source.runs[0].tools[0].arguments = { text: 'PRIVATE_ARGUMENT' }; source.runs[0].tools[0].result = 'PRIVATE_RESULT'; source.runs[0].events[0].content = 'PRIVATE_EVENT';
  const f = fixture({ snapshot: async () => response(source) }); await settle();
  assert.ok(f.host.textContent.includes('<img src=x onerror=execute()>')); assert.ok(f.host.textContent.includes('<script>execute()</script>'));
  assert.equal(f.host.textContent.includes('PRIVATE_'), false); assert.equal(all(f.host).some(node => ['script', 'img', 'iframe'].includes(node.tagName)), false);
  await find(f.host, 'yc-activity-open-work').dispatch('click'); await find(f.host, 'yc-activity-open-conversation').dispatch('click');
  assert.deepEqual(f.opened, [mid(1)]); assert.deepEqual(f.conversations, [uuid(201)]); f.view.dispose();
});

test('filter and search use declared request metadata and never fetch history or invoke navigation', async () => {
  const f = fixture({ snapshot: async () => response(snapshot([run(1), run(2, { label: 'Code request', kind: 'code', origin: 'schedule', status: 'completed', request_active: false, ended_at: iso(BASE - 1000), model: 'different-model' })])) }); await settle();
  const search = find(f.host, 'yc-activity-search'), filter = find(f.host, 'yc-activity-filter');
  search.value = 'scheduled'; await search.dispatch('input'); assert.deepEqual(cards(f.host).map(node => node.dataset.requestId), [uuid(2)]);
  search.value = 'READ_FILE'; filter.value = 'active'; await filter.dispatch('change'); assert.deepEqual(cards(f.host).map(node => node.dataset.requestId), [uuid(1)]);
  search.value = 'missing'; await search.dispatch('input'); assert.equal(cards(f.host).length, 0); assert.match(f.host.textContent, /No requests match/);
  assert.equal(f.calls(), 1); assert.deepEqual(f.opened, []); f.view.dispose();
});

test('existing local conversation titles are bounded, inert, searchable and independent of host telemetry', async () => {
  let title = 'Quantity <img src=x> review'; const lookups = [];
  const f = fixture({ snapshot: async () => response(snapshot([run(1), run(2, { conversation_id: null, origin: 'schedule' })])), getConversationTitle: id => { lookups.push(id); return title; } }); await settle();
  assert.equal(cards(f.host)[0].children[0].children[0].textContent, title); assert.match(f.host.textContent, /Request 11111111/);
  assert.ok(lookups.every(id => id === uuid(201))); assert.equal(all(f.host).some(node => node.tagName === 'img'), false);
  const search = find(f.host, 'yc-activity-search'); search.value = 'quantity'; await search.dispatch('input'); assert.equal(cards(f.host).length, 1);
  title = 'x'.repeat(201); search.value = ''; await search.dispatch('input'); assert.equal(cards(f.host)[0].children[0].children[0].textContent, 'Work request');
  assert.equal(f.calls(), 1); f.view.dispose();
});

test('timelines and historical event nodes survive progress and elapsed-time updates', async () => {
  const f = fixture({ snapshot: async () => response(snapshot()) }); await settle();
  const card = cards(f.host)[0], timeline = find(card, 'yc-activity-timeline'), firstEvent = all(timeline).find(node => node.dataset.eventSequence === '1'); timeline.open = true;
  const next = run(1, { phase: 'Output received', output_chars: 125, updated_at: iso(BASE), events: [...run().events, { sequence: 3, at: iso(BASE), kind: 'output', label: 'Output received', step_id: null }], omitted_events: 2 });
  f.push(snapshot([next], { sequence: 3 }));
  assert.equal(cards(f.host)[0], card); assert.equal(find(card, 'yc-activity-timeline'), timeline); assert.equal(timeline.open, true);
  assert.equal(all(timeline).find(node => node.dataset.eventSequence === '1'), firstEvent); assert.match(timeline.textContent, /2 earlier events omitted/);
  await f.advance(1000); assert.equal(timeline.open, true); assert.match(card.textContent, /Request elapsed 6s/); assert.match(card.textContent, /Last event 1s ago/);
  assert.match(card.textContent, /125 output characters observed/); f.view.dispose();
});

test('polling confirms host freshness without fabricating events or tool progress', async () => {
  const f = fixture(); await settle(); const card = cards(f.host)[0], timeline = find(card, 'yc-activity-timeline'); timeline.open = true;
  await f.advance(8000);
  assert.equal(f.calls(), 5); assert.equal(cards(f.host)[0], card); assert.equal(timeline.open, true);
  assert.equal(find(f.host, 'yc-activity-connection').dataset.state, 'live'); assert.equal(find(f.host, 'yc-activity').dataset.sequence, '2');
  assert.match(card.textContent, /Last event 9s ago/); assert.match(card.textContent, /Request elapsed 13s/); assert.match(timeline.textContent, /2 retained/);
  f.view.dispose();
});

test('hung or failed refresh becomes stale/disconnected and a fresh equal-sequence response reconnects', async () => {
  let reply = response(snapshot()); const pending = deferred(); const f = fixture({ snapshot: () => reply }); await settle();
  reply = pending.promise; await f.advance(7000); assert.equal(f.calls(), 2);
  assert.equal(find(f.host, 'yc-activity-connection').dataset.state, 'stale'); assert.match(find(f.host, 'yc-activity-phase').textContent, /Waiting for provider/);
  pending.resolve({ ok: false, error: { message: 'PRIVATE_FAILURE_DIAGNOSTICS' } }); await settle();
  assert.equal(find(f.host, 'yc-activity-connection').dataset.state, 'disconnected'); assert.equal(f.host.textContent.includes('PRIVATE_FAILURE_DIAGNOSTICS'), false);
  reply = response(snapshot(undefined, { observed_at: iso(f.time()) })); assert.equal(await f.view.refresh(), true);
  assert.equal(find(f.host, 'yc-activity-connection').dataset.state, 'live'); assert.equal(find(f.host, 'yc-activity-error').hidden, true);
  assert.match(cards(f.host)[0].textContent, /Last event 8s ago/); f.view.dispose();
});

test('duplicate old pushed snapshots do not conceal stale telemetry', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ snapshot: () => ++calls === 1 ? response(snapshot()) : pending.promise }); await settle();
  await f.advance(7000); f.push(snapshot());
  assert.equal(find(f.host, 'yc-activity-connection').dataset.state, 'stale'); f.view.dispose(); pending.resolve(response(snapshot())); await settle();
});

test('subscription failure still supports polling and duplicate record actions are guarded', async () => {
  const opened = deferred(); let opens = 0;
  const f = fixture({ onEvent() { throw new Error('no push'); }, onOpenWork: () => { opens++; return opened.promise; } }); await settle();
  assert.match(f.host.textContent, /Live push unavailable; polling/); await f.advance(2000); assert.equal(f.calls(), 2);
  const button = find(f.host, 'yc-activity-open-work'), first = button.dispatch('click'); await button.dispatch('click'); assert.equal(opens, 1);
  opened.resolve(); await first; assert.equal(button.disabled, false); f.view.dispose();
});

test('dispose stops subscription and timers and late callbacks cannot paint a replacement view', async () => {
  const pending = deferred(), f = fixture({ snapshot: () => pending.promise }); f.view.dispose(); f.view.dispose();
  assert.equal(f.unsubscribed(), 1); assert.equal(f.intervals.size, 0);
  const other = f.document.createElement('aside'); other.textContent = 'Different workspace'; f.host.appendChild(other);
  pending.resolve(response(snapshot())); f.push(snapshot()); await settle(); await f.advance(10000);
  assert.equal(f.host.textContent, 'Different workspace'); assert.equal(await f.view.refresh(), false); assert.equal(f.calls(), 1);
  const detached = fixture(); await settle(); detached.host.replaceChildren(); await detached.advance(1000);
  assert.equal(detached.intervals.size, 0); assert.equal(detached.unsubscribed(), 1); assert.equal(detached.calls(), 1);
});

test('completed request elapsed time freezes while last-event age continues and record errors stay readable', async () => {
  const done = run(1, { status: 'completed', request_active: false, ended_at: iso(BASE - 1000) });
  const f = fixture({ snapshot: async () => response(snapshot([done], { observed_at: iso(BASE + 10000) })), onOpenConversation: async () => { throw new Error('Conversation is not loaded'); } }); await settle();
  await f.advance(3000); assert.match(cards(f.host)[0].textContent, /Request elapsed 4s/); assert.match(cards(f.host)[0].textContent, /Last event 4s ago/);
  await find(f.host, 'yc-activity-open-conversation').dispatch('click'); assert.match(find(f.host, 'yc-activity-error').textContent, /Conversation is not loaded/); f.view.dispose();
});
