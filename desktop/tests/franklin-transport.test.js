'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { createFranklinTransport } = require('../src/franklin-transport');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await tick(); } assert.fail('Fixture did not settle'); }
function fixture(t, options = {}) {
  const children = [], events = [], actions = [], spawns = [];
  function spawnProcess(executable, args, spawnOptions) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.inputs = []; child.killed = false; child.closed = false;
    child.finish = code => { if (child.closed) return; child.closed = true; child.emit('close', code); };
    child.frame = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.kill = () => { child.killed = true; setImmediate(() => child.finish(1)); };
    let buffered = '';
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      buffered += chunk.toString(); let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffered.slice(0, index)); buffered = buffered.slice(index + 1); child.inputs.push(value);
        if (!child.command) { child.command = value.command; if (child.command !== 'send') setImmediate(() => {
          if (options.control) options.control(child, value);
          else { child.frame({ type: 'result', response: { ok: true, result: child.command === 'cancel' ? { cancelled: true, request_id: value.request_id } : {} } }); child.finish(0); }
        }); }
      }
      callback();
    } });
    children.push(child); spawns.push({ executable, args, options: spawnOptions }); return child;
  }
  const transport = createFranklinTransport({ sourceRoot: process.cwd(), getPython: () => 'python-fixture', getStateRoot: () => 'state-root',
    getEnvironment: options.getEnvironment || (() => ({ PATH: 'runtime-path', PYTHONPATH: 'discard', PYTHONHOME: 'discard' })),
    executeHost: async (...args) => { actions.push(args); return options.executeHost ? options.executeHost(...args) : { completed: true }; },
    observeEnvironment: options.observe || (async () => ({ view: 'conversation' })), onEvent: (event, owner) => events.push({ event, owner }), spawnProcess });
  t.after(() => transport.shutdown());
  return { transport, children, events, actions, spawns, live: () => children.findLast(child => child.command === 'send') };
}
function request() { return { request_id: randomUUID(), text: 'Inspect the Desktop' }; }
function action(req, extra = {}) { return { type: 'host_action', id: 'call1', request_id: req.request_id, mission_id: 'a'.repeat(32), action: 'open_view', payload: { view: 'media' }, ...extra }; }

test('Franklin reserves one owner/request/text and duplicate exact send does not spawn work again', async t => {
  const f = fixture(t), owner = {}, req = request();
  assert.equal((await f.transport.send(req, owner)).ok, true);
  assert.equal((await f.transport.send(req, owner)).ok, true);
  assert.equal((await f.transport.send(req, {})).error.code, 'WRONG_OWNER');
  assert.equal((await f.transport.send({ ...req, text: 'Different intent' }, owner)).error.code, 'REQUEST_CONFLICT');
  assert.equal(f.children.filter(child => child.command === 'send').length, 1);
  assert.equal(f.spawns[0].options.windowsHide, true); assert.equal(f.spawns[0].options.shell, false);
  assert.equal(f.spawns[0].options.env.PYTHONPATH, undefined); assert.equal(f.spawns[0].options.env.PYTHONHOME, undefined);
  f.live().frame({ type: 'result', response: { ok: true, result: { completed: true } } }); f.live().finish(0);
  await until(() => f.transport.active() === null);
  assert.equal(f.events.at(-1).event.type, 'turn.complete'); assert.equal(f.events.at(-1).owner, owner);
});

test('fragmented NDJSON preserves owner scope and permits each host action ID only once', async t => {
  const f = fixture(t), owner = {}, req = request(); await f.transport.send(req, owner);
  const child = f.live(), raw = JSON.stringify(action(req)) + '\n';
  child.stdout.write(raw.slice(0, 12)); child.stdout.write(raw.slice(12));
  await until(() => child.inputs.length === 2);
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0][2].owner, owner); assert.equal(f.actions[0][2].isActive(), true);
  assert.equal(f.actions[0][2].action_id, 'call1');
  assert.equal(child.inputs[1].type, 'host_result'); assert.equal(child.inputs[1].id, 'call1');
  child.frame(action(req));
  await until(() => f.events.some(item => item.event.type === 'turn.error'));
  assert.equal(f.actions.length, 1); assert.equal(child.killed, true);
  assert.equal(f.events.at(-1).event.error.code, 'FRANKLIN_PROTOCOL');
});

test('foreign request, changed mission, or concurrent host request cannot cross the active scope', async t => {
  const f = fixture(t), owner = {}, req = request(); await f.transport.send(req, owner);
  f.live().frame(action(req)); await until(() => f.live().inputs.length === 2);
  f.live().frame(action(req, { id: 'call2', mission_id: 'b'.repeat(32) }));
  await until(() => f.events.some(item => item.event.type === 'turn.error'));
  assert.equal(f.actions.length, 1);
  const next = request(); await f.transport.send(next, owner);
  f.live().frame(action(next, { request_id: randomUUID() }));
  await until(() => f.transport.active() === null);
  assert.equal(f.actions.length, 1);
});

test('runtime host actions are unavailable to snapshot/control RPC and trailing protocol is rejected', async t => {
  let malicious = false;
  const f = fixture(t, { control(child, req) {
    if (req.command === 'recover') child.frame({ type: 'result', response: { ok: true, result: {} } });
    else if (malicious) child.frame(action(request()));
    else { child.frame({ type: 'result', response: { ok: true, result: {} } }); child.stdout.write('{unfinished'); }
    setImmediate(() => child.finish(0));
  } });
  const partial = await f.transport.request({ command: 'snapshot' }); assert.equal(partial.error.code, 'FRANKLIN_PROTOCOL');
  malicious = true;
  const attempted = await f.transport.request({ command: 'snapshot' }); assert.equal(attempted.error.code, 'FRANKLIN_PROTOCOL');
  assert.equal(f.actions.length, 0);
});

test('Stop during asynchronous context observation prevents any model/worker spawn', async t => {
  let resolveContext; const context = new Promise(resolve => { resolveContext = resolve; });
  const f = fixture(t, { observe: () => context }), owner = {}, req = request();
  const sent = f.transport.send(req, owner); await until(() => f.transport.active() !== null);
  const cancelled = await f.transport.cancel({ request_id: req.request_id }, owner);
  assert.equal(cancelled.result.cancelled, true);
  resolveContext({ view: 'media' });
  assert.equal((await sent).result.status, 'cancelled');
  assert.equal(f.children.filter(child => child.command === 'send').length, 0);
});

test('Stop commits cancellation before killing child and invalidates awaited host continuation', async t => {
  let release, actionIdentity;
  const f = fixture(t, { executeHost: (_a, _p, identity) => { actionIdentity = identity; return new Promise(resolve => { release = resolve; }); } });
  const owner = {}, req = request(); await f.transport.send(req, owner); const child = f.live(); child.frame(action(req));
  await until(() => Boolean(release));
  assert.equal((await f.transport.cancel({ request_id: req.request_id }, {})).error.code, 'WRONG_OWNER');
  assert.equal(child.killed, false);
  assert.equal((await f.transport.cancel({ request_id: req.request_id }, owner)).ok, true);
  assert.equal(child.killed, true); assert.equal(actionIdentity.isActive(), false);
  release({ completed: true }); await tick();
  assert.equal(child.inputs.filter(value => value.type === 'host_result').length, 0);
  await until(() => f.events.some(item => item.event.type === 'turn.cancelled'));
});

test('byte limits, malformed frames and invalid input fail closed without stderr leaking', async t => {
  const f = fixture(t), owner = {}, req = request();
  assert.equal((await f.transport.send({ ...req, authority: {} }, owner)).error.code, 'INVALID_REQUEST');
  await f.transport.send(req, owner); const child = f.live();
  child.stderr.write('PRIVATE_PROVIDER_SECRET'); child.stdout.write('x'.repeat(1024 * 1024 + 1));
  await until(() => f.events.some(item => item.event.type === 'turn.error'));
  assert.equal(f.events.at(-1).event.error.code, 'FRANKLIN_LIMIT'); assert.equal(JSON.stringify(f.events).includes('PRIVATE_PROVIDER_SECRET'), false);
  const tooLarge = await f.transport.request({ command: 'configure', value: 'x'.repeat(128 * 1024) });
  assert.equal(tooLarge.error.code, 'FRANKLIN_LIMIT');
});

test('successful result cannot race an unfinished host action or be overwritten by a later frame', async t => {
  let release;
  const f = fixture(t, { executeHost: () => new Promise(resolve => { release = resolve; }) }), req = request();
  await f.transport.send(req, {}); f.live().frame(action(req));
  await until(() => Boolean(release));
  f.live().frame({ type: 'result', response: { ok: true, result: { forged: true } } });
  await until(() => f.events.some(item => item.event.type === 'turn.error'));
  assert.equal(f.events.at(-1).event.error.code, 'FRANKLIN_PROTOCOL'); release({});
});

test('unexpected worker exit reconciles committed state before permitting another turn', async t => {
  let recoveries = 0, activeChild;
  const recovered = { messages: [{ role: 'assistant', content: 'Interrupted; inspect receipts.' }], active_request: null };
  const f = fixture(t, { control(child, req) {
    if (req.command === 'recover') { recoveries++; if (activeChild) assert.equal(activeChild.closed, true); }
    child.frame({ type: 'result', response: { ok: true, result: recoveries > 1 ? recovered : {} } }); child.finish(0);
  } });
  await f.transport.send(request(), {}); activeChild = f.live(); activeChild.finish(1);
  await until(() => f.events.some(item => item.event.type === 'turn.error'));
  assert.equal(recoveries, 2);
  assert.equal(f.transport.active(), null);
  assert.deepEqual(f.events.at(-1).event.snapshot, recovered);
  assert.equal(f.children.filter(child => child.command === 'send').length, 1);
  assert.equal((await f.transport.send(request(), {})).ok, true);
});

test('protocol failure waits for actual child exit before recovery and never repeats host work', async t => {
  const f = fixture(t); await f.transport.send(request(), {});
  const child = f.live(); child.kill = () => { child.killed = true; };
  child.stdout.write('{malformed}\n'); await tick();
  assert.equal(child.killed, true);
  assert.equal(f.children.filter(item => item.command === 'recover').length, 1);
  assert.notEqual(f.transport.active(), null);
  child.finish(1);
  await until(() => f.events.some(item => item.event.type === 'turn.error'));
  assert.equal(f.children.filter(item => item.command === 'recover').length, 2);
  assert.equal(f.children.filter(item => item.command === 'send').length, 1);
  assert.equal(f.actions.length, 0);
});

test('timeout recovers after exit without automatically reissuing the request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await f.transport.send(request(), {}); const child = f.live();
  t.mock.timers.tick(10 * 60 * 1000);
  await until(() => f.events.some(item => item.event.error?.code === 'FRANKLIN_TIMEOUT'));
  assert.equal(child.closed, true);
  assert.equal(f.children.filter(item => item.command === 'recover').length, 2);
  assert.equal(f.children.filter(item => item.command === 'send').length, 1);
  t.mock.timers.reset();
});

test('shutdown while a failed child exits cannot spawn recovery work', async t => {
  const f = fixture(t); await f.transport.send(request(), {});
  const child = f.live(); child.kill = () => { child.killed = true; };
  child.stdout.write('{invalid}\n'); await tick(); f.transport.shutdown(); child.finish(1); await tick();
  assert.equal(f.children.filter(item => item.command === 'recover').length, 1);
  assert.equal(f.events.filter(item => item.event.type === 'turn.error').length, 0);
});

test('queue Stop retains the reservation through durable cancellation and disables host continuations until original runtime exits', async t => {
  let release, identity, cancelChild;
  const f = fixture(t, {
    executeHost: (_action, _payload, authority) => { identity = authority; return new Promise(resolve => { release = resolve; }); },
    control(child, value) {
      if (value.command === 'cancel') { cancelChild = child; return; }
      child.frame({ type: 'result', response: { ok: true, result: {} } }); child.finish(0);
    }
  });
  const owner = {}, req = request(); await f.transport.send(req, owner); const child = f.live();
  try {
    child.frame({ type: 'event', event: { type: 'model_queue', request_id: req.request_id, state: 'IN_QUEUE' } });
    child.frame(action(req)); await until(() => Boolean(release));
    const stopped = f.transport.cancel({ request_id: req.request_id }, owner);
    await until(() => Boolean(cancelChild));
    assert.equal(identity.isActive(), true, 'Host scope changes only after durable cancellation');
    cancelChild.frame({ type: 'result', response: { ok: true, result: { cancelled: true, request_id: req.request_id } } }); cancelChild.finish(0);
    await tick();
    assert.equal(identity.isActive(), false);
    assert.equal(child.killed, false, 'Queue cleanup must be allowed to use the original remote receipt');
    assert.equal(f.transport.active().request_id, req.request_id);
    assert.equal((await f.transport.send(request(), owner)).error.code, 'BUSY');
    let finished = false; stopped.then(() => { finished = true; }); await tick(); assert.equal(finished, false);
    release({ completed: true }); await tick();
    assert.equal(child.inputs.filter(value => value.type === 'host_result').length, 0);
    child.finish(0);
    const result = await stopped;
    assert.equal(result.result.cancelled, true);
    assert.equal(result.result.remote_cleanup, 'runtime_finished');
    await until(() => f.transport.active() === null);
    assert.equal(f.events.filter(item => item.event.type === 'turn.cancelled').length, 1);
    assert.equal(f.children.filter(item => item.command === 'recover').length, 1);
  } finally { release?.({}); cancelChild?.finish(1); child.finish(1); }
});

test('duplicate queue Stop after durable cancellation reuses the pending cleanup without another cancel RPC', async t => {
  const f = fixture(t), owner = {}, req = request(); await f.transport.send(req, owner); const child = f.live();
  try {
    child.frame({ type: 'event', event: { type: 'model_queue', request_id: req.request_id, state: 'IN_PROGRESS' } });
    const first = f.transport.cancel({ request_id: req.request_id }, owner);
    await until(() => f.children.some(item => item.command === 'cancel' && item.closed));
    const second = f.transport.cancel({ request_id: req.request_id }, owner);
    await tick();
    assert.equal(f.children.filter(item => item.command === 'cancel').length, 1);
    assert.equal(f.transport.active().request_id, req.request_id);
    assert.equal(child.killed, false);
    child.finish(0);
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].result.remote_cleanup, 'runtime_finished');
  } finally { child.finish(1); }
});

test('concurrent duplicate queue Stop shares its durable cancel request before the receipt returns', async t => {
  const f = fixture(t, { control(child, value) {
    if (value.command !== 'cancel') { child.frame({ type: 'result', response: { ok: true, result: {} } }); child.finish(0); }
  } }), owner = {}, req = request(); await f.transport.send(req, owner); const child = f.live();
  try {
    child.frame({ type: 'event', event: { type: 'model_queue', request_id: req.request_id, state: 'IN_QUEUE' } });
    const first = f.transport.cancel({ request_id: req.request_id }, owner);
    await until(() => f.children.some(item => item.command === 'cancel'));
    const second = f.transport.cancel({ request_id: req.request_id }, owner);
    await tick();
    const controls = f.children.filter(item => item.command === 'cancel');
    assert.equal(controls.length, 1, 'Concurrent Stop must not issue another durable cancel RPC');
    for (const control of controls) { control.frame({ type: 'result', response: { ok: true, result: { cancelled: true, request_id: req.request_id } } }); control.finish(0); }
    await tick(); child.finish(0);
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].result.remote_cleanup, 'runtime_finished');
  } finally {
    for (const control of f.children.filter(item => item.command === 'cancel')) {
      if (!control.closed) { control.frame({ type: 'result', response: { ok: true, result: { cancelled: true, request_id: req.request_id } } }); control.finish(0); }
    }
    child.finish(1); await tick();
  }
});

test('queue shutdown waits for original cleanup, reuses shutdown and rejects new sends during cleanup', async t => {
  const f = fixture(t), owner = {}, req = request(); await f.transport.send(req, owner); const child = f.live();
  try {
    child.frame({ type: 'event', event: { type: 'model_queue', request_id: req.request_id, state: 'IN_QUEUE' } });
    const shutdown = f.transport.shutdown();
    assert.equal(f.transport.shutdown(), shutdown);
    await until(() => f.children.some(item => item.command === 'cancel' && item.closed));
    let finished = false; shutdown.then(() => { finished = true; }); await tick();
    assert.equal(finished, false);
    assert.equal(child.killed, false);
    assert.equal(f.transport.active().request_id, req.request_id);
    assert.equal((await f.transport.send(request(), owner)).error.code, 'FRANKLIN_CLOSING');
    assert.equal(f.children.filter(item => item.command === 'send').length, 1);
    child.finish(0); await shutdown;
    assert.equal(f.transport.active(), null);
    assert.equal((await f.transport.send(request(), owner)).error.code, 'FRANKLIN_CLOSING');
    assert.equal(f.children.filter(item => item.command === 'cancel').length, 1);
    assert.equal(f.children.filter(item => item.command === 'recover').length, 1);
  } finally { child.finish(1); }
});

test('queue cleanup expires at 35 seconds with reconciliation required instead of claiming remote completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), owner = {}, req = request(); await f.transport.send(req, owner); const child = f.live();
  child.kill = () => { child.killed = true; };
  try {
    child.frame({ type: 'event', event: { type: 'model_queue', request_id: req.request_id, state: 'IN_QUEUE' } });
    const stopped = f.transport.cancel({ request_id: req.request_id }, owner);
    await until(() => f.children.some(item => item.command === 'cancel' && item.closed));
    t.mock.timers.tick(34999); await tick();
    assert.equal(child.killed, false);
    assert.equal(f.transport.active().request_id, req.request_id);
    t.mock.timers.tick(1);
    const result = await stopped;
    assert.equal(child.killed, true);
    assert.equal(child.closed, false, 'Local kill is not a verified remote cleanup receipt');
    assert.equal(result.result.remote_cleanup, 'needs_reconciliation');
  } finally { child.finish(1); t.mock.timers.reset(); }
});

test('configured queue cold start survives ten minutes and expires exactly at the 1,235,000ms ceiling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { getEnvironment: () => ({ PATH: 'runtime-path', YUR_FRANKLIN_RUNPOD_URL: 'https://queue.example.test', YUR_FRANKLIN_RUNPOD_MODEL: 'selected-model' }) });
  await f.transport.send(request(), {}); const child = f.live();
  try {
    t.mock.timers.tick(10 * 60 * 1000); await tick();
    assert.equal(child.killed, false);
    assert.notEqual(f.transport.active(), null);
    assert.equal(f.events.some(item => item.event.error?.code === 'FRANKLIN_TIMEOUT'), false);
    t.mock.timers.tick(634999); await tick();
    assert.equal(child.killed, false);
    assert.notEqual(f.transport.active(), null);
    t.mock.timers.tick(1);
    await until(() => f.events.some(item => item.event.error?.code === 'FRANKLIN_TIMEOUT'));
    assert.equal(child.closed, true);
    assert.equal(f.transport.active(), null);
    assert.equal(f.children.filter(item => item.command === 'send').length, 1);
    assert.equal(f.children.filter(item => item.command === 'recover').length, 2);
  } finally { child.finish(1); t.mock.timers.reset(); }
});
