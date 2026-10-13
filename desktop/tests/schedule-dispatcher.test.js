'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createScheduleDispatcher } = require('../src/schedule-dispatcher');
const { createWorkTransport } = require('../src/work-transport');
const { desktopPython } = require('../src/desktop-runtime');
const ok = result => ({ ok: true, result });
const clone = value => JSON.parse(JSON.stringify(value));
function claim(fields = {}) {
  const request = { request_id: randomUUID(), conversation_id: randomUUID(), mode: 'work', goal: 'Summarize the selected evidence.', root: null, provider: 'ollama', model: 'fixture', messages: [{ role: 'user', content: 'Summarize the selected evidence.' }] };
  return { schedule: { id: randomUUID(), enabled: true, active_request_id: request.request_id, conversation_id: request.conversation_id, runs_completed: 0, ...fields }, request, replayed: false };
}
const missionFor = (item, status) => ({ id: randomUUID().replaceAll('-', ''), request_id: item.request.request_id, conversation_id: item.request.conversation_id, request: item.request, status });
function fixture(items, overrides = {}) {
  const calls = [], states = [], timers = new Map(), missions = new Map(); let nextTimer = 0;
  const transport = {
    async request(input) {
      calls.push({ ...input });
      const replacement = await overrides.request?.(input, { missions, items, calls });
      if (replacement !== undefined) return replacement;
      const item = items.find(item => item.schedule.id === input.schedule_id || item.request.request_id === input.request_id);
      if (input.command === 'schedule_claim') return ok({ claims: clone(items.filter(item => item.schedule.active_request_id !== null)) });
      if (input.command === 'schedule_resolve') return ok({ mission: clone(missions.get(input.request_id) || null) });
      if (input.command === 'schedule_complete') {
        const mission = [...missions.values()].find(mission => mission.id === input.mission_id);
        assert.ok(['completed', 'failed', 'cancelled'].includes(mission.status));
        item.schedule.active_request_id = null; item.schedule.runs_completed++;
        return ok({ schedule: clone(item.schedule), mission_status: mission.status, replayed: false });
      }
      if (input.command === 'schedule_dispatch_error') {
        assert.equal(missions.has(input.request_id), false);
        item.schedule.enabled = false; item.schedule.active_request_id = null; item.schedule.last_error = input.error;
        return ok({ schedule: clone(item.schedule) });
      }
      if (input.command === 'schedule_cancel_request') {
        const mission = missions.get(input.request_id) || missionFor(item, 'cancelled'); mission.status = 'cancelled'; missions.set(input.request_id, mission); return ok({ mission: clone(mission) });
      }
      throw new Error('Unexpected fixture command: ' + input.command);
    },
    async start(request, owner) {
      calls.push({ command: 'start', request: clone(request), owner });
      if (overrides.start) return overrides.start(request, owner, { missions, items, calls });
      const item = items.find(item => item.request.request_id === request.request_id), mission = missionFor(item, 'completed'); missions.set(request.request_id, mission); return ok({ mission: clone(mission) });
    },
    async cancel(requestId, owner) {
      calls.push({ command: 'transport_cancel', request_id: requestId, owner });
      if (overrides.cancel) return overrides.cancel(requestId, owner, { missions, items, calls });
      return ok({ cancelled: Boolean(missions.get(requestId)?.status === 'cancelled'), mission: clone(missions.get(requestId) || null) });
    },
  };
  const dispatcher = createScheduleDispatcher({ workTransport: transport, onState: state => states.push(state), now: () => 1000,
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  return { dispatcher, calls, states, timers, missions, transport };
}

test('one committed claim is handed unchanged to the existing Work transport and counted only from terminal state', async () => {
  const item = claim(), f = fixture([item]); f.dispatcher.start(); await f.dispatcher.wake();
  const start = f.calls.find(call => call.command === 'start'); assert.deepEqual(start.request, item.request);
  assert.equal(Object.isFrozen(start.owner), true); assert.equal(f.calls.filter(call => call.command === 'start').length, 1);
  assert.equal(item.schedule.runs_completed, 1); assert.equal(f.dispatcher.status().last_result.mission_status, 'completed');
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [10000]);
  assert.equal(JSON.stringify(f.dispatcher.status()).includes(item.request.goal), false);
  await f.dispatcher.stop(); assert.equal(f.timers.size, 0);
});

test('wake/start coalesce during active work and another due request waits for the next ordinary tick', async () => {
  const first = claim(), second = claim(); let finish;
  const f = fixture([first, second], { start: async (request, _owner, { missions }) => new Promise(resolve => { finish = () => { const mission = missionFor(first, 'completed'); missions.set(request.request_id, mission); resolve(ok({ mission })); }; }) });
  f.dispatcher.start(); const pending = f.dispatcher.wake();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.filter(call => call.command === 'start').length, 1);
  f.dispatcher.start(); assert.equal(f.dispatcher.wake(), pending); assert.equal(f.timers.size, 0);
  finish(); await pending; assert.equal(f.calls.filter(call => call.command === 'start').length, 1); assert.equal(second.schedule.runs_completed, 0);
  await f.dispatcher.stop();
});

test('terminal replay reconciles without restarting and awaiting review does not starve another bounded claim', async () => {
  const terminal = claim(), approval = claim(), fresh = claim(), f = fixture([terminal, approval, fresh]);
  f.missions.set(terminal.request.request_id, missionFor(terminal, 'failed')); f.missions.set(approval.request.request_id, missionFor(approval, 'awaiting_approval'));
  f.dispatcher.start(); await f.dispatcher.wake();
  assert.deepEqual(f.calls.filter(call => call.command === 'start').map(call => call.request.request_id), [fresh.request.request_id]);
  assert.equal(terminal.schedule.runs_completed, 1); assert.equal(approval.schedule.runs_completed, 0); assert.equal(fresh.schedule.runs_completed, 1);
  await f.dispatcher.wake(); assert.equal(f.calls.filter(call => call.command === 'start').length, 1); assert.equal(f.dispatcher.status().phase, 'awaiting_review');
  await f.dispatcher.stop();
});

test('a lost start reply recovers actual completed Work without recording a pre-acceptance failure', async () => {
  const item = claim(), f = fixture([item], { start: async (request, _owner, { missions }) => {
    missions.set(request.request_id, missionFor(item, 'completed')); return { ok: false, error: { code: 'LOST_RESPONSE', message: 'Fixture response lost' } };
  } });
  f.dispatcher.start(); await f.dispatcher.wake();
  assert.equal(item.schedule.runs_completed, 1); assert.equal(f.calls.some(call => call.command === 'schedule_dispatch_error'), false);
  assert.equal(f.dispatcher.status().error, null); await f.dispatcher.stop();
});

test('pre-acceptance failure disables honestly; existing running Work retains identity and retries only on another tick', async () => {
  const missing = claim(), f = fixture([missing], { start: async () => ({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Selected folder is absent.' } }) });
  f.dispatcher.start(); await f.dispatcher.wake(); assert.equal(missing.schedule.enabled, false); assert.equal(missing.schedule.runs_completed, 0);
  assert.equal(f.calls.filter(call => call.command === 'schedule_dispatch_error').length, 1); await f.dispatcher.stop();
  const running = claim(), g = fixture([running], { start: async () => ({ ok: false, error: { code: 'BUSY', message: 'Existing canonical worker holds its lock.' } }) });
  g.missions.set(running.request.request_id, missionFor(running, 'running')); g.dispatcher.start(); await g.dispatcher.wake();
  assert.equal(g.calls.filter(call => call.command === 'start').length, 1); assert.equal(g.calls.some(call => call.command === 'schedule_dispatch_error'), false); assert.equal(running.schedule.active_request_id, running.request.request_id);
  assert.equal(g.dispatcher.status().error.code, 'BUSY');
  await g.dispatcher.wake(); assert.equal(g.calls.filter(call => call.command === 'start').length, 2); assert.equal(running.schedule.runs_completed, 0); await g.dispatcher.stop();
});

test('paused claims cancel through their committed schedule identity and then complete actual cancelled Work', async () => {
  const item = claim({ enabled: false }), f = fixture([item]);
  f.dispatcher.start(); await f.dispatcher.wake();
  assert.equal(f.calls.some(call => call.command === 'start'), false);
  const cancellation = f.calls.find(call => call.command === 'schedule_cancel_request');
  assert.deepEqual(cancellation, { command: 'schedule_cancel_request', schedule_id: item.schedule.id, request_id: item.request.request_id });
  assert.equal(item.schedule.runs_completed, 1); assert.equal(f.dispatcher.status().last_result.mission_status, 'cancelled'); await f.dispatcher.stop();
});

test('shutdown cancellation closes only its private-owner start after durable cancellation and leaves no timer', async () => {
  const item = claim(); let finishStart;
  const f = fixture([item], {
    start: async (request, _owner, { missions }) => { missions.set(request.request_id, missionFor(item, 'running')); return new Promise(resolve => { finishStart = resolve; }); },
    cancel: async (requestId, _owner, { missions, calls }) => { assert.ok(calls.some(call => call.command === 'schedule_cancel_request')); const mission = clone(missions.get(requestId)); finishStart(ok({ mission })); return ok({ cancelled: true, mission }); },
  });
  f.dispatcher.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.dispatcher.cancel(randomUUID())).result.cancelled, false);
  const stopped = await f.dispatcher.stop(); assert.equal(stopped.enabled, false); assert.equal(stopped.running, false); assert.equal(stopped.phase, 'stopped'); assert.equal(f.timers.size, 0);
  const start = f.calls.find(call => call.command === 'start'), cancellation = f.calls.find(call => call.command === 'transport_cancel'); assert.equal(start.owner, cancellation.owner);
  assert.equal(item.schedule.runs_completed, 1); assert.equal(f.dispatcher.status().last_result.mission_status, 'cancelled');
});

test('unresolved or mismatched missions retain claims and never manufacture completion or dispatch-failure receipts', async () => {
  const item = claim(), later = claim(); let started = false;
  const f = fixture([item, later], {
    start: async () => { started = true; return { ok: false, error: { code: 'REPLY_LOST', message: 'unknown outcome' } }; },
    request: input => input.command === 'schedule_resolve' && started ? { ok: false, error: { code: 'OFFLINE', message: 'Cannot inspect durable state' } } : undefined,
  });
  f.dispatcher.start(); await f.dispatcher.wake(); assert.equal(item.schedule.active_request_id, item.request.request_id);
  assert.equal(f.calls.filter(call => call.command === 'start').length, 1, 'A failed resolution after start still consumes this tick\'s one-start budget.');
  assert.equal(f.calls.some(call => ['schedule_complete', 'schedule_dispatch_error'].includes(call.command)), false); assert.equal(f.dispatcher.status().error.code, 'OFFLINE'); await f.dispatcher.stop();
  const mismatch = claim(), g = fixture([mismatch]); g.missions.set(mismatch.request.request_id, { ...missionFor(mismatch, 'completed'), request_id: randomUUID() });
  g.dispatcher.start(); await g.dispatcher.wake(); assert.equal(g.calls.some(call => ['start', 'schedule_complete', 'schedule_dispatch_error'].includes(call.command)), false); assert.match(g.dispatcher.status().error.message, /does not match/); await g.dispatcher.stop();
});

test('malformed/duplicate batches are rejected before dispatch and a stopped tick does not start work', async () => {
  for (const claims of [[claim(), ...Array(20).fill(claim())], [{ schedule: {}, request: {}, replayed: false }]]) {
    const f = fixture([], { request: input => input.command === 'schedule_claim' ? ok({ claims }) : undefined });
    f.dispatcher.start(); await f.dispatcher.wake(); assert.equal(f.calls.some(call => call.command === 'start'), false); assert.ok(f.dispatcher.status().error); await f.dispatcher.stop();
  }
  const item = claim(), f = fixture([item]);
  await f.dispatcher.wake(); assert.equal(f.calls.length, 0);
  assert.equal((await f.dispatcher.cancelActive()).result.cancelled, false);
  f.dispatcher.start(); await f.dispatcher.stop(); assert.equal(f.calls.some(call => call.command === 'start'), false); assert.equal(f.timers.size, 0);
});

test('a full transport queue preserves the exact enabled schedule claim for a later tick', async () => {
  const item = claim(); let busy = true;
  const f = fixture([item], { start: async (request, _owner, state) => {
    assert.deepEqual(request, item.request);
    if (busy) return { ok: false, error: { code: 'BUSY', message: 'Work queue is full before admission.' } };
    const mission = missionFor(item, 'completed'); state.missions.set(request.request_id, mission); return ok({ mission });
  } });
  f.dispatcher.start(); await f.dispatcher.wake();
  assert.equal(f.dispatcher.status().phase, 'waiting'); assert.equal(item.schedule.enabled, true);
  assert.equal(item.schedule.active_request_id, item.request.request_id); assert.equal(item.schedule.runs_completed, 0);
  assert.equal(f.calls.some(call => ['schedule_complete', 'schedule_dispatch_error', 'schedule_cancel_request', 'transport_cancel'].includes(call.command)), false);
  busy = false; await f.dispatcher.wake();
  assert.equal(item.schedule.runs_completed, 1); assert.equal(item.schedule.active_request_id, null);
  assert.deepEqual(f.calls.filter(call => call.command === 'start').map(call => call.request), [item.request, item.request]);
  await f.dispatcher.stop();
});

test('actual CLI/OrchestrationManager/CommitService dispatch creates one linked mission and replay performs no provider call', async t => {
  const sourceRoot = path.resolve(__dirname, '..'), temporaryBase = path.resolve(os.tmpdir());
  const home = fs.mkdtempSync(path.join(temporaryBase, 'yur-schedule-dispatcher-'));
  const stateRoot = path.join(home, 'journal'), requests = [];
  let holdProvider = false, heldProviderClosed = false;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      if (holdProvider) { res.on('close', () => { heldProviderClosed = true; }); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ done: true, message: { role: 'assistant', content: 'Scheduled evidence review completed.' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = createWorkTransport({ sourceRoot, getStateRoot: () => stateRoot, getPython: () => desktopPython(sourceRoot), getOllamaUrl: () => `http://127.0.0.1:${server.address().port}`, timeoutMs: 15000 });
  const dispatcher = createScheduleDispatcher({ workTransport: transport });
  t.after(async () => {
    await dispatcher.stop(); await transport.dispose();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    const relative = path.relative(temporaryBase, path.resolve(home));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(home).startsWith('yur-schedule-dispatcher-')) throw new Error('Temporary cleanup escaped its fixture root.');
    fs.rmSync(home, { recursive: true, force: true });
  });
  const created = new Date(Date.now() - 120000).toISOString();
  const document = { id: randomUUID(), conversation_id: randomUUID(), name: 'Dispatcher acceptance fixture', goal: 'Summarize the supplied scheduling fixture.', root: null, provider: 'ollama', model: 'local-fixture', mode: 'work', interval_seconds: 60, max_runs: 2,
    enabled: true, created_at: created, updated_at: created, next_run_at: new Date(Date.now() - 1000).toISOString(), runs_completed: 0, active_request_id: null, last_mission_id: null, last_error: '' };
  const saved = await transport.request({ command: 'schedule_save', document, expected_revision: 0 }); assert.equal(saved.ok, true, JSON.stringify(saved));
  dispatcher.start(); const state = await dispatcher.wake(); assert.equal(state.error, null, JSON.stringify(state));
  const listed = await transport.request({ command: 'schedule_list' }); assert.equal(listed.ok, true, JSON.stringify(listed));
  const schedule = listed.result.schedules.find(item => item.id === document.id);
  assert.equal(schedule.runs_completed, 1); assert.equal(schedule.active_request_id, null); assert.match(schedule.last_mission_id, /^[0-9a-f]{32}$/);
  const inspection = await transport.request({ command: 'inspect', mission_id: schedule.last_mission_id }); assert.equal(inspection.ok, true);
  assert.equal(inspection.result.mission.status, 'completed'); assert.equal(inspection.result.mission.conversation_id, document.conversation_id);
  const history = await transport.request({ command: 'schedule_events', schedule_id: document.id, before_id: null }); assert.equal(history.ok, true);
  assert.deepEqual(history.result.events.map(event => event.event_type), ['schedule.completed', 'schedule.claimed', 'schedule.created']);
  assert.equal(history.result.events[0].change.mission_id, inspection.result.mission.id); assert.match(history.result.events[0].change.work_receipt, /^[0-9a-f]{64}$/);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/chat');
  const replay = await transport.request({ command: 'schedule_complete', schedule_id: document.id, mission_id: schedule.last_mission_id }); assert.equal(replay.ok, true); assert.equal(replay.result.replayed, true);
  await dispatcher.wake(); assert.equal(requests.length, 1);
  holdProvider = true;
  const second = { ...document, id: randomUUID(), conversation_id: randomUUID(), name: 'Shutdown acceptance fixture' };
  assert.equal((await transport.request({ command: 'schedule_save', document: second, expected_revision: 0 })).ok, true);
  const active = dispatcher.wake();
  const wait = async (predicate, message) => { const end = Date.now() + 8000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(predicate(), message); };
  await wait(() => requests.length === 2, 'The second mission must reach its real provider before shutdown.');
  await dispatcher.stop(); await active;
  await wait(() => heldProviderClosed, 'Shutdown must close the exact active provider connection.');
  const afterStop = await transport.request({ command: 'schedule_list' }); assert.equal(afterStop.ok, true);
  const stopped = afterStop.result.schedules.find(item => item.id === second.id);
  assert.equal(stopped.runs_completed, 1); assert.equal(stopped.enabled, false); assert.equal(stopped.active_request_id, null);
  const cancelled = await transport.request({ command: 'inspect', mission_id: stopped.last_mission_id }); assert.equal(cancelled.ok, true); assert.equal(cancelled.result.mission.status, 'cancelled');
  assert.equal(dispatcher.status().enabled, false); assert.equal(dispatcher.status().next_tick_at, null);
});
