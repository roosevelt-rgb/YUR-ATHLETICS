'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createWorkTransport, validateWorkRequest, validateSteerRequest, validateRpc, cleanEnvironment } = require('../src/work-transport');
const { digest, AUTHORITY } = require('../src/work-browser-broker');
const { createActivityFeed } = require('../src/activity-feed');

const sourceRoot = path.resolve(__dirname, '..');
const work = (fields = {}) => ({ request_id: randomUUID(), conversation_id: randomUUID(), mode: 'work', goal: 'Read report and create summary.', root: null, provider: 'ollama', model: 'fixture', messages: [{ role: 'user', content: 'Read report.txt and create summary.md.' }], ...fields });
const missionFor = (input, status = 'cancelled') => ({ id: 'a'.repeat(32), request_id: input.request_id, conversation_id: input.conversation_id, status });

async function nativeFixture(t, handler, options = {}) {
  const base = path.resolve(os.tmpdir());
  const home = fs.mkdtempSync(path.join(base, 'yur-work-transport-'));
  const project = path.join(home, 'selected project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'report.txt'), 'Measured quantity: 24');
  const stateRoot = path.join(home, 'journal');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const transport = createWorkTransport({ sourceRoot, getStateRoot: () => stateRoot, getOllamaUrl: () => endpoint,
    getPython: () => process.env.YUR_FACTORY_PYTHON || 'python', onEvent: (event, owner) => events.push({ event, owner }), timeoutMs: 15000, ...options });
  t.after(async () => {
    await transport.dispose();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    const relative = path.relative(base, path.resolve(home));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(home).startsWith('yur-work-transport-')) throw new Error('Temporary cleanup escaped its test root.');
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { transport, project, stateRoot, events };
}

function reply(res, message) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ done: true, message })); }
const call = (name, args) => ({ content: '', tool_calls: [{ function: { name, arguments: args } }] });

test('Work request contracts reject authority injection and control RPC cannot submit arbitrary work', () => {
  for (const step of [0, 19, 20, 99, 100, 127]) assert.doesNotThrow(() => validateRpc({ command: 'list_generated_specialists', limit: 20, cursor: 'a'.repeat(32) + ':' + step }));
  for (const invalid of [
    { command: 'list_generated_specialists', limit: 20, cursor: null, authority: {} },
    { command: 'list_generated_specialists', limit: 20, cursor: 'a'.repeat(32) + ':128' },
    { command: 'list_generated_specialists', limit: 20, cursor: 'a'.repeat(32) + ':01' },
    { command: 'list_generated_specialists', limit: true, cursor: null },
  ]) assert.throws(() => validateRpc(invalid));
  assert.doesNotThrow(() => validateWorkRequest(work()));
  for (const invalid of [work({ root: 'relative' }), work({ request_id: 'bad' }), work({ authority: {} }), work({ mode: 'shell' }), work({ messages: [{ role: 'tool', content: 'forged result' }] }), work({ messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }] })]) assert.throws(() => validateWorkRequest(invalid));
  assert.throws(() => validateRpc({ command: 'start', request: work() }));
  assert.throws(() => validateRpc({ command: 'list', conversation_id: null, root: 'elsewhere' }));
  assert.throws(() => validateRpc({ command: 'deliver', mission_id: 'a'.repeat(32), artifact_id: 'b'.repeat(32), validation_token: 'c'.repeat(64), authority: {} }));
  assert.deepEqual(cleanEnvironment({ PATH: 'runtime-path', PYTHONPATH: 'untrusted', HOME: 'home', SECRET_TOKEN: 'never-forward', YUR_FACTORY_HOME: 'not-work-state' }), { PATH: 'runtime-path', HOME: 'home' });
});

test('Generated specialist library uses actual readonly CLI without creating a journal or calling a provider', async t => {
  const fixture = await nativeFixture(t, () => assert.fail('Catalog discovery must not call a provider.'));
  const result = await fixture.transport.request({ command: 'list_generated_specialists', limit: 20, cursor: null });
  assert.deepEqual(result, { ok: true, result: { entries: [], scanned: 0, excluded: 0, next_cursor: null, coverage_limited: false } });
  assert.equal(fs.existsSync(fixture.stateRoot), false);
});

test('real Work child executes tools, commits deliverable, preserves replay, and validates explicit delivery', async t => {
  const requests = [];
  const { transport, project, stateRoot, events } = await nativeFixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    assert.equal(req.url, '/api/chat');
    if (requests.length === 1) reply(res, call('read_file', { path: 'report.txt' }));
    else if (requests.length === 2) {
      assert.ok(input.messages.at(-1).content.includes('Measured quantity: 24'));
      reply(res, call('create_artifact', { name: 'summary.md', media_type: 'text/markdown', content: '# Result\nMeasured quantity: 24' }));
    } else reply(res, { content: 'Created summary.md from the measured quantity of 24.' });
  });
  assert.deepEqual(await transport.request({ command: 'list', conversation_id: null }), { ok: true, result: { missions: [] } });
  assert.equal(fs.existsSync(stateRoot), false);
  const input = work({ root: project }); const owner = {};
  const response = await transport.start(input, owner);
  assert.equal(response.ok, true, JSON.stringify(response));
  const mission = response.result.mission;
  assert.equal(mission.status, 'completed'); assert.equal(mission.steps.length, 2);
  assert.equal(mission.artifacts[0].status, 'committed');
  assert.equal(fs.readFileSync(path.join(project, 'report.txt'), 'utf8'), 'Measured quantity: 24');
  assert.equal(fs.existsSync(path.join(project, 'summary.md')), false);
  for (const { event, owner: actualOwner } of events) { assert.equal(event.request_id, input.request_id); assert.equal(event.conversation_id, input.conversation_id); assert.equal(actualOwner, owner); }
  const replay = await transport.start(input, owner);
  assert.equal(replay.result.mission.id, mission.id); assert.equal(requests.length, 3);
  const inspected = await transport.request({ command: 'inspect', mission_id: mission.id });
  assert.equal(inspected.result.events.at(-1).event_type, 'work.completed');
  const artifactId = mission.artifacts[0].id;
  const validation = await transport.request({ command: 'validate_delivery', mission_id: mission.id, artifact_id: artifactId });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const delivered = await transport.request({ command: 'deliver', mission_id: mission.id, artifact_id: artifactId, validation_token: validation.result.validation_token });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.equal(delivered.result.delivery.status, 'applied');
  assert.equal(fs.readFileSync(delivered.result.delivery.plan.path, 'utf8'), '# Result\nMeasured quantity: 24');
});

test('Stop commits cancellation before killing the active provider process and respects request ownership', async t => {
  let accept; const accepted = new Promise(resolve => { accept = resolve; });
  let disconnected; const upstreamClosed = new Promise(resolve => { disconnected = resolve; });
  const { transport, project } = await nativeFixture(t, async (req, res) => {
    for await (const _chunk of req) { /* Consume the actual provider input. */ }
    res.on('close', disconnected);
    accept();
  });
  const owner = {}; const input = work({ root: project });
  const pending = transport.start(input, owner);
  await Promise.race([accepted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Work did not reach provider.')), 5000); timer.unref(); })]);
  assert.equal((await transport.cancel(input.request_id, {})).result.cancelled, false);
  assert.equal((await transport.start(input, owner)).error.code, 'DUPLICATE_REQUEST');
  const movedProject = `${project} moved`;
  assert.equal(path.dirname(path.resolve(movedProject)), path.dirname(path.resolve(project)));
  fs.renameSync(project, movedProject);
  const cancelled = await transport.cancel(input.request_id, owner);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(cancelled.result.mission.status, 'cancelled');
  const result = await pending;
  assert.equal(result.result.mission.status, 'cancelled');
  await Promise.race([upstreamClosed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Cancelled Work did not close upstream.')), 5000); timer.unref(); })]);
  const inspected = await transport.request({ command: 'inspect', mission_id: result.result.mission.id });
  assert.equal(inspected.result.events.at(-1).event_type, 'work.cancelled');
  assert.equal(inspected.result.mission.steps.length, 0);
});

function fakeTransport(behavior, options = {}) {
  const invocations = [];
  const transport = createWorkTransport({ sourceRoot, getStateRoot: () => path.join(sourceRoot, 'test-only-state'), getOllamaUrl: () => 'http://127.0.0.1:11434',
    getEnvironment: () => ({ PATH: 'runtime-path', PYTHONPATH: 'must-not-forward', SECRET_TOKEN: 'must-not-forward' }),
    spawnProcess(executable, args, settings) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let input = '';
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        input += chunk; callback();
        if (args.includes('--browser-acquisition-v1')) {
          let end; while ((end = input.indexOf('\n')) >= 0) { const frame = input.slice(0, end); input = input.slice(end + 1); if (frame) setImmediate(() => behavior(child, JSON.parse(frame))); }
        }
      }, final(callback) { callback(); if (input) setImmediate(() => behavior(child, JSON.parse(input))); } });
      child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
      invocations.push({ executable, args, settings, child });
      return child;
    }, ...options });
  return { transport, invocations };
}

function fakeResult(child, result, code = 0) { child.stdout.write(JSON.stringify({ type: 'result', ...result }) + '\n'); child.emit('close', code); }

test('activity sees scheduled and interactive FIFO work and never forwards prompts, status payloads or tool arguments', async () => {
  const feed = createActivityFeed(), activity = [], starts = [], owner = {}, scheduler = Object.freeze({ kind: 'committed-schedule-dispatcher' });
  const inputs = [work({ goal: 'SECRET_GOAL', messages: [{ role: 'user', content: 'PRIVATE_CONTEXT' }] }), work()];
  const fixture = fakeTransport((child, command) => { starts.push({ child, input: command.request }); },
    { onActivity: (event, actualOwner) => { activity.push({ event, owner: actualOwner }); feed.observe(event); } });
  const first = fixture.transport.start(inputs[0], owner), scheduled = fixture.transport.start(inputs[1], scheduler);
  await until(() => starts.length === 1);
  let snapshot = feed.snapshot(); assert.equal(snapshot.runs.length, 2);
  assert.equal(snapshot.runs.find(run => run.id === inputs[1].request_id).status, 'queued');
  assert.equal(snapshot.runs.find(run => run.id === inputs[1].request_id).mission_id, null);
  assert.equal(snapshot.runs.find(run => run.id === inputs[1].request_id).origin, 'schedule');
  const identity = { mission_id: 'a'.repeat(32), request_id: inputs[0].request_id, conversation_id: inputs[0].conversation_id };
  starts[0].child.stdout.write(JSON.stringify({ type: 'status', ...identity, text: 'UNTRUSTED_STATUS_PRIVATE', input: 'HIDDEN_INPUT' }) + '\n');
  starts[0].child.stdout.write(JSON.stringify({ type: 'tool', ...identity, name: 'read_file', step_id: 'b'.repeat(32), status: 'running', arguments: { password: 'HIDDEN_ARGUMENT' } }) + '\n');
  await until(() => feed.snapshot().runs.find(run => run.id === inputs[0].request_id).tools.length === 1);
  assert.doesNotMatch(JSON.stringify(activity), /SECRET|PRIVATE|HIDDEN|password|arguments|messages/);
  fakeResult(starts[0].child, { ok: true, result: { mission: missionFor(inputs[0], 'completed') } });
  assert.equal((await first).ok, true); await until(() => starts.length === 2);
  fakeResult(starts[1].child, { ok: true, result: { mission: missionFor(inputs[1], 'completed') } });
  assert.equal((await scheduled).ok, true);
  snapshot = feed.snapshot(); assert.ok(snapshot.runs.every(run => run.status === 'completed' && !run.request_active));
  assert.ok(activity.some(item => item.owner === scheduler && item.event.type === 'finish'));
  await fixture.transport.dispose();
});

test('activity does not complete from a buffered terminal response before actual process close', async () => {
  const events = [], input = work(); let child;
  const fixture = fakeTransport((current, command) => { child = current; assert.equal(command.command, 'start'); },
    { onActivity: event => events.push(event) });
  const pending = fixture.transport.start(input); await until(() => child);
  child.stdout.write(JSON.stringify({ type: 'result', ok: true, result: { mission: missionFor(input, 'completed') } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.some(event => event.type === 'finish'), false);
  child.emit('close', 0); assert.equal((await pending).ok, true);
  assert.equal(events.at(-2).phase, 'process_closed'); assert.equal(events.at(-1).phase, 'completed');
  assert.equal(events.filter(event => event.type === 'finish').length, 1);
  await fixture.transport.dispose();
});

test('activity retains a stopping process until close even after failure and confirmed durable cancellation', async () => {
  const events = [], input = work(); let stuck;
  const fixture = fakeTransport((child, command) => {
    if (command.command === 'start') { stuck = child; child.kill = () => false; child.stdout.write('invalid-json\n'); }
    else fakeResult(child, { ok: true, result: { mission: missionFor(input, 'cancelled') } });
  }, { onActivity: event => events.push(event) });
  const pending = fixture.transport.start(input);
  const failure = await pending; assert.equal(failure.error.code, 'INVALID_RUNTIME_RESPONSE'); assert.equal(failure.error.cancellation_confirmed, true);
  assert.equal(events.some(event => event.type === 'finish'), false); assert.equal(events.at(-1).phase, 'stopping');
  stuck.emit('close', null);
  assert.equal(events.at(-2).phase, 'process_closed'); assert.equal(events.at(-1).phase, 'failed_cancelled');
  await fixture.transport.dispose();
});

test('activity validates model envelopes and exposes only their fixed labels and step identity', async () => {
  const events = [], input = work(); let child;
  const fixture = fakeTransport((current, command) => {
    if (command.command === 'start') child = current;
    else fakeResult(current, { ok: true, result: { mission: missionFor(input, 'cancelled') } });
  }, { onActivity: event => events.push(event) });
  const pending = fixture.transport.start(input); await until(() => child);
  const identity = { mission_id: 'a'.repeat(32), request_id: input.request_id, conversation_id: input.conversation_id };
  child.stdout.write(JSON.stringify({ type: 'model', ...identity, call_id: 2147483647, status: 'running', text: 'Waiting for model response', step_id: 'b'.repeat(32) }) + '\n');
  await until(() => events.some(event => event.phase === 'model_running'));
  assert.deepEqual(events.find(event => event.phase === 'model_running'), { type: 'update', id: input.request_id, phase: 'model_running', mission_id: identity.mission_id, step_id: 'b'.repeat(32) });
  child.stdout.write(JSON.stringify({ type: 'model', ...identity, call_id: 1, status: 'completed', text: 'Model response received', thinking: 'PRIVATE_REASONING' }) + '\n');
  assert.equal((await pending).error.code, 'INVALID_RUNTIME_RESPONSE');
  assert.doesNotMatch(JSON.stringify(events), /thinking|PRIVATE_REASONING|call_id/);
  await fixture.transport.dispose();
});

test('an accepted failure without terminal evidence stays unconfirmed and observer failure never changes work', async () => {
  const input = work(), events = [];
  const fixture = fakeTransport((child, command) => {
    child.stdout.write(JSON.stringify({ type: 'status', mission_id: 'a'.repeat(32), request_id: input.request_id, conversation_id: input.conversation_id, text: 'Work request accepted' }) + '\n');
    fakeResult(child, { ok: false, error: { code: 'RUNTIME_ERROR', message: 'Bounded failure' } }, 1);
  }, { onActivity: event => { events.push(event); throw new Error('Closed observer'); } });
  assert.equal((await fixture.transport.start(input)).error.code, 'RUNTIME_ERROR');
  assert.equal(events.at(-1).phase, 'unconfirmed'); assert.equal(events.at(-1).mission_id, 'a'.repeat(32));
  await fixture.transport.dispose();
});

test('actual CLI model and tool activity agrees with the committed Work outcome', async t => {
  const feed = createActivityFeed(), observed = [];
  const fixture = await nativeFixture(t, async (req, res) => {
    let encoded = ''; for await (const chunk of req) encoded += chunk;
    const body = JSON.parse(encoded), tools = body.messages.filter(message => message.role === 'tool');
    reply(res, tools.length ? { content: 'Created the note.' } : call('create_artifact', { name: 'note.md', media_type: 'text/markdown', content: 'Actual retained fixture note.' }));
  }, { onActivity: event => { observed.push(event); feed.observe(event); } });
  const input = work(), result = await fixture.transport.start(input, Object.freeze({ kind: 'committed-schedule-dispatcher' }));
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.mission.steps.length, 1);
  const run = feed.snapshot().runs[0]; assert.equal(run.origin, 'schedule'); assert.equal(run.mission_id, result.result.mission.id);
  assert.equal(run.status, 'completed'); assert.equal(run.request_active, false);
  assert.deepEqual(run.tools, [{ id: result.result.mission.steps[0].id, name: 'create_artifact', status: 'completed' }]);
  assert.equal(observed.filter(event => event.phase === 'model_running').length, 2);
  assert.equal(observed.filter(event => event.phase === 'model_completed').length, 2);
  assert.equal(observed.at(-1).phase, 'completed'); assert.equal(observed.at(-2).phase, 'process_closed');
});

async function until(predicate, message = 'Expected fixture progress') {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function busyResult(child, input, extra = {}) {
  const identity = { mission_id: missionFor(input).id, request_id: input.request_id, conversation_id: input.conversation_id };
  child.stdout.write(JSON.stringify({ type: 'status', ...identity, text: 'Work request accepted' }) + '\n');
  fakeResult(child, { ok: false, error: { code: 'WORKER_BUSY', message: 'Another factory worker owns the exclusive worker lock', ...identity, ...extra } }, 1);
}

test('bounded FIFO serializes interactive and scheduled owners without duplicate admission or invented mission receipts', async () => {
  const started = [], events = [], inputs = Array.from({ length: 5 }, () => work()), owner = {}, scheduler = Object.freeze({ kind: 'committed-schedule-dispatcher' });
  const fixture = fakeTransport((child, command) => { assert.equal(command.command, 'start'); started.push({ child, request: command.request }); }, { onEvent: (event, owner) => events.push({ event, owner }) });
  const pending = inputs.slice(0, 4).map((input, index) => fixture.transport.start(input, index === 2 ? scheduler : owner));
  await until(() => started.length === 1);
  assert.equal((await fixture.transport.start(inputs[1], owner)).error.code, 'DUPLICATE_REQUEST');
  assert.equal((await fixture.transport.start(inputs[4], owner)).error.code, 'BUSY');
  assert.equal(started.length, 1);
  assert.equal(events.length, 3);
  for (let index = 0; index < 3; index++) {
    assert.equal(events[index].event.phase, 'transport_waiting'); assert.equal(events[index].event.admission, 'not_checked');
    assert.equal(events[index].event.mission_id, null); assert.equal(events[index].event.request_id, inputs[index + 1].request_id);
  }
  for (let index = 0; index < 4; index++) {
    await until(() => started.length === index + 1);
    assert.deepEqual(started[index].request, inputs[index]);
    fakeResult(started[index].child, { ok: true, result: { mission: missionFor(inputs[index], 'completed') } });
    assert.equal((await pending[index]).result.mission.request_id, inputs[index].request_id);
  }
  assert.equal(fixture.invocations.length, 4); await fixture.transport.dispose();
});

test('queued Stop reserves the exact cancelled identity without launching it or touching the active worker', async () => {
  const first = work(), second = work(), owner = {}, commands = []; let activeChild;
  const fixture = fakeTransport((child, command) => {
    commands.push(command);
    if (command.command === 'start') { assert.deepEqual(command.request, first); activeChild = child; }
    else { assert.equal(command.command, 'cancel_request'); assert.deepEqual(command.request, second); fakeResult(child, { ok: true, result: { mission: missionFor(second) } }); }
  });
  const active = fixture.transport.start(first, owner), queued = fixture.transport.start(second, owner);
  await until(() => activeChild);
  assert.equal((await fixture.transport.cancel(second.request_id, {})).result.cancelled, false);
  assert.equal((await fixture.transport.cancel(second.request_id, owner)).result.cancelled, true);
  assert.equal((await queued).result.mission.request_id, second.request_id);
  assert.equal(activeChild.killed, undefined);
  fakeResult(activeChild, { ok: true, result: { mission: missionFor(first, 'completed') } }); await active;
  assert.deepEqual(commands.map(item => item.command), ['start', 'cancel_request']); await fixture.transport.dispose();
});

test('queue expiry has its own bound, performs no admission, and does not spend the execution deadline', async () => {
  const first = work(), second = work(); let activeChild;
  const fixture = fakeTransport((child, command) => { assert.deepEqual(command.request, first); activeChild = child; }, { timeoutMs: 500, queueTimeoutMs: 20 });
  const active = fixture.transport.start(first), queued = fixture.transport.start(second);
  const response = await queued;
  assert.equal(response.error.code, 'BUSY'); assert.match(response.error.message, /before dispatch/); assert.equal(fixture.invocations.length, 1);
  fakeResult(activeChild, { ok: true, result: { mission: missionFor(first, 'completed') } }); await active; await fixture.transport.dispose();
});

test('FIFO waits for actual process close after a failure, while exact cancellation RPC stays available', async () => {
  const first = work(), second = work(), starts = []; let failedChild;
  const fixture = fakeTransport((child, command) => {
    if (command.command === 'start') {
      starts.push(command.request.request_id);
      if (starts.length === 1) { failedChild = child; child.kill = () => false; child.stdout.write('not-json\n'); }
      else fakeResult(child, { ok: true, result: { mission: missionFor(second, 'completed') } });
    } else fakeResult(child, { ok: true, result: { mission: missionFor(first) } });
  });
  const active = fixture.transport.start(first), queued = fixture.transport.start(second);
  assert.equal((await active).error.code, 'INVALID_RUNTIME_RESPONSE');
  assert.deepEqual(starts, [first.request_id]);
  failedChild.emit('close', null);
  assert.equal((await queued).result.mission.request_id, second.request_id);
  assert.deepEqual(starts, [first.request_id, second.request_id]); await fixture.transport.dispose();
});

test('typed worker contention retries only the identical accepted request and returns its eventual terminal receipt', async () => {
  const input = work(), events = [], requests = [];
  const fixture = fakeTransport((child, command) => {
    assert.equal(command.command, 'start'); requests.push(command.request);
    if (requests.length === 1) busyResult(child, input);
    else fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } });
  }, { onEvent: event => events.push(event), timeoutMs: 1000 });
  const result = await fixture.transport.start(input);
  assert.equal(result.result.mission.status, 'completed'); assert.deepEqual(requests, [input, input]);
  const waiting = events.find(event => event.phase === 'worker_waiting'); assert.equal(waiting.admission, 'confirmed'); assert.equal(waiting.mission_id, missionFor(input).id);
  await fixture.transport.dispose();
});

test('Stop during worker contention never retries or cancels the unrelated lock holder', async () => {
  const input = work(), owner = {}, commands = []; let waiting;
  const ready = new Promise(resolve => { waiting = resolve; });
  const fixture = fakeTransport((child, command) => {
    commands.push(command);
    if (command.command === 'start') busyResult(child, input);
    else { assert.equal(command.command, 'cancel'); assert.equal(command.mission_id, missionFor(input).id); fakeResult(child, { ok: true, result: { mission: missionFor(input) } }); }
  }, { onEvent(event) { if (event.phase === 'worker_waiting') waiting(); } });
  const pending = fixture.transport.start(input, owner); await ready;
  assert.equal((await fixture.transport.cancel(input.request_id, owner)).result.cancelled, true);
  assert.equal((await pending).result.mission.status, 'cancelled');
  assert.deepEqual(commands.map(item => item.command), ['start', 'cancel']); await fixture.transport.dispose();
});

test('worker retry deadline is total and cancellation confirms the original queued mission', async () => {
  const input = work(), commands = [];
  const fixture = fakeTransport((child, command) => {
    commands.push(command);
    if (command.command === 'start') busyResult(child, input);
    else fakeResult(child, { ok: true, result: { mission: missionFor(input) } });
  }, { timeoutMs: 40 });
  const result = await fixture.transport.start(input);
  assert.equal(result.error.code, 'RUNTIME_TIMEOUT'); assert.equal(result.error.cancellation_confirmed, true);
  assert.deepEqual(commands.map(item => item.command), ['start', 'cancel']); await fixture.transport.dispose();
});

test('a final fractional worker wait cannot retry if the clock still reads before its deadline', async t => {
  const input = work(), commands = []; let now = 0;
  t.mock.method(performance, 'now', () => now);
  const fixture = fakeTransport((child, command) => {
    commands.push(command);
    if (command.command === 'start' && commands.length === 1) {
      now = 999.5;
      busyResult(child, input);
    } else if (command.command === 'start') {
      fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } });
    } else {
      assert.equal(command.command, 'cancel');
      assert.equal(command.mission_id, missionFor(input).id);
      fakeResult(child, { ok: true, result: { mission: missionFor(input) } });
    }
  }, { timeoutMs: 1000 });
  const result = await fixture.transport.start(input);
  assert.equal(result.error.code, 'RUNTIME_TIMEOUT');
  assert.equal(result.error.cancellation_confirmed, true);
  assert.equal(result.error.mission_id, missionFor(input).id);
  assert.deepEqual(commands.map(command => command.command), ['start', 'cancel']);
  assert.deepEqual(commands[0].request, input);
  await fixture.transport.dispose();
});

test('generic failures are never retried and malformed contention identity fails closed', async () => {
  for (const malformed of [false, true]) {
    const input = work(), commands = [];
    const fixture = fakeTransport((child, command) => {
      commands.push(command);
      if (command.command !== 'start') fakeResult(child, { ok: true, result: { mission: missionFor(input) } });
      else if (malformed) busyResult(child, input, { request_id: randomUUID() });
      else fakeResult(child, { ok: false, error: { code: 'WORK_FAILED', message: 'Another factory worker owns the exclusive worker lock' } }, 1);
    });
    const result = await fixture.transport.start(input);
    assert.equal(result.error.code, malformed ? 'INVALID_RUNTIME_RESPONSE' : 'WORK_FAILED');
    assert.equal(commands.filter(item => item.command === 'start').length, 1); await fixture.transport.dispose();
  }
});

test('runtime loss after a busy acceptance preserves its mission and reports unconfirmed durable cancellation', async () => {
  const input = work(); let pythonCalls = 0;
  const fixture = fakeTransport((child, command) => { assert.equal(command.command, 'start'); busyResult(child, input); }, {
    getPython() { if (++pythonCalls > 1) throw new Error('Fixture interpreter removed.'); return 'python'; }, timeoutMs: 1000,
  });
  const result = await fixture.transport.start(input);
  assert.equal(result.error.code, 'RUNTIME_UNAVAILABLE'); assert.equal(result.error.mission_id, missionFor(input).id);
  assert.equal(result.error.cancellation_confirmed, false); assert.equal(fixture.invocations.length, 1);
  assert.equal(pythonCalls, 3, 'One retry and one exact durable cancellation attempt; neither launched.'); await fixture.transport.dispose();
});

test('shutdown cancels active and queued identities without admitting queued work', async () => {
  const inputs = [work(), work(), work()], commands = [];
  const fixture = fakeTransport((child, command) => {
    commands.push(command);
    if (command.command !== 'start') fakeResult(child, { ok: true, result: { mission: missionFor(command.request) } });
  });
  const pending = inputs.map(input => fixture.transport.start(input));
  await until(() => commands.length === 1); await fixture.transport.dispose();
  assert.deepEqual((await Promise.all(pending)).map(item => item.result.mission.request_id), inputs.map(item => item.request_id));
  assert.equal(commands.filter(item => item.command === 'start').length, 1);
  assert.equal(commands.filter(item => item.command === 'cancel_request').length, 3);
});

test('actual concurrent conversations complete serially with no second queued mission or duplicate provider call', async t => {
  const held = [], inputs = [work(), work()];
  const fixture = await nativeFixture(t, async (req, res) => { for await (const _chunk of req) {} held.push(res); });
  const first = fixture.transport.start(inputs[0], {}), second = fixture.transport.start(inputs[1], {});
  await until(() => held.length === 1);
  const during = await fixture.transport.request({ command: 'list', conversation_id: null });
  assert.deepEqual(during.result.missions.map(item => item.request_id), [inputs[0].request_id]);
  reply(held[0], { content: 'First request complete.' }); assert.equal((await first).result.mission.status, 'completed');
  await until(() => held.length === 2); reply(held[1], { content: 'Second request complete.' });
  assert.equal((await second).result.mission.status, 'completed');
  const after = await fixture.transport.request({ command: 'list', conversation_id: null });
  assert.equal(after.result.missions.length, 2); assert.ok(after.result.missions.every(item => item.status === 'completed'));
});

test('actual external worker lock remains owned while a second transport cancels or resumes its exact accepted request', async t => {
  const held = [], inputs = [work(), work(), work()], owner = {}, events = [];
  const fixture = await nativeFixture(t, async (req, res) => { for await (const _chunk of req) {} held.push(res); });
  // An independent transport intentionally shares the real journal to exercise
  // OS-lock contention, outside the in-memory FIFO under test.
  const other = createWorkTransport({ sourceRoot, getStateRoot: () => fixture.stateRoot, getPython: () => process.env.YUR_FACTORY_PYTHON || 'python',
    getOllamaUrl: () => 'http://127.0.0.1:1', onEvent: event => events.push(event), timeoutMs: 15000 });
  t.after(() => other.dispose());
  const active = fixture.transport.start(inputs[0], owner); await until(() => held.length === 1);
  const cancelledWait = other.start(inputs[1], owner);
  await until(() => events.some(item => item.phase === 'worker_waiting'));
  assert.equal((await other.cancel(inputs[1].request_id, owner)).result.cancelled, true);
  assert.equal((await cancelledWait).result.mission.status, 'cancelled');
  const firstRecord = await fixture.transport.request({ command: 'list', conversation_id: inputs[0].conversation_id });
  assert.equal(firstRecord.result.missions[0].status, 'running'); assert.equal(held.length, 1);
  // Use a real second fixture endpoint only after proving the first holder was
  // untouched. The same queued request must reach exactly one model call.
  let secondCalls = 0;
  const resumed = await nativeFixture(t, async (req, res) => { for await (const _chunk of req) {} secondCalls++; reply(res, { content: 'Independent worker resumed.' }); }, { getStateRoot: () => fixture.stateRoot, onEvent: event => events.push(event) });
  const pending = resumed.transport.start(inputs[2], owner);
  await until(() => events.some(item => item.phase === 'worker_waiting' && item.request_id === inputs[2].request_id));
  assert.equal(secondCalls, 0);
  reply(held[0], { content: 'Original lock holder completed.' }); assert.equal((await active).result.mission.status, 'completed');
  const result = await pending; assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.mission.status, 'completed'); assert.equal(secondCalls, 1);
  const inspection = await resumed.transport.request({ command: 'inspect', mission_id: result.result.mission.id });
  assert.equal(inspection.result.events.filter(item => item.event_type === 'work.submitted').length, 1);
});

function browserSource() {
  const now = Date.now();
  return { schema: 'yur.work-browser-source.v1', source_id: randomUUID(), source_url: 'https://example.test/page', title: 'Source page', selected_at: new Date(now).toISOString(), expires_at: new Date(now + 120000).toISOString(), max_acquisitions: 1 };
}
function browserFrame(input) {
  const mission_id = 'a'.repeat(32), step_index = 0;
  return { type: 'browser_acquire', schema: 'yur.work-browser-acquisition.v1', acquisition_id: digest({ mission_id, step_index, tool: 'acquire_selected_page' }).slice(0, 32), request_id: input.request_id, conversation_id: input.conversation_id, mission_id, step_index, source_id: input.browser_source.source_id, source_sha256: digest(input.browser_source), input_sha256: digest({ source_id: input.browser_source.source_id }), authority_sha256: digest(AUTHORITY), accepted_receipt: 'b'.repeat(64) };
}
function browserContext(input, text = 'Measured page quantity: 37') {
  return { schema: 'yur.browser-context.v1', source_url: input.browser_source.source_url, title: input.browser_source.title, text, sha256: require('node:crypto').createHash('sha256').update(text).digest('hex'), acquired_at: new Date().toISOString(), truncated: false, limits: { text_chars: 32000, text_bytes: 65536, text_nodes: 5000, main_frame_only: true, form_fields_excluded: true } };
}

test('Work browser mode uses one bound callback and exact NDJSON reply while ordinary commands keep EOF', async () => {
  const input = work({ browser_source: browserSource() }), owner = {}, binding = {}, observations = [], released = [];
  const fixture = fakeTransport((child, frame) => {
    if (frame.command === 'start') {
      assert.equal(child.stdin.writableEnded, false);
      child.stdout.write(JSON.stringify(browserFrame(input)) + '\n');
    } else if (frame.type === 'browser_result') {
      assert.deepEqual(frame, { ...browserFrame(input), type: 'browser_result', context: frame.context });
      assert.equal(frame.context.text, 'Measured page quantity: 37');
      assert.equal(Object.hasOwn(frame, 'ok'), false);
      fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } });
    } else assert.fail('Unexpected frame');
  }, { bindPage(request, actualOwner) { assert.deepEqual(request, input); assert.equal(actualOwner, owner); return binding; },
    acquirePage(frame, request, actualOwner, actualBinding, options) { observations.push(frame); assert.equal(request.request_id, input.request_id); assert.equal(actualOwner, owner); assert.equal(actualBinding, binding); assert.equal(options.signal.aborted, false); return browserContext(input); },
    releasePage(value) { released.push(value); } });
  const result = await fixture.transport.start(input, owner);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(observations.length, 1); assert.deepEqual(released, [binding]);
  assert.deepEqual(fixture.invocations[0].args, ['-B', '-m', 'foundry.work_cli', '--browser-acquisition-v1']);
  assert.equal(fixture.invocations[0].settings.shell, false);
  await fixture.transport.dispose();
  const old = fakeTransport((child, command) => { assert.equal(child.stdin.writableEnded, true); fakeResult(child, { ok: true, result: { missions: [] } }); });
  assert.equal((await old.transport.request({ command: 'list', conversation_id: null })).ok, true);
  assert.deepEqual(old.invocations[0].args, ['-B', '-m', 'foundry.work_cli']); await old.transport.dispose();
});

test('Work browser expired descriptor permits committed replay without source acquisition', async () => {
  const source = browserSource(); source.selected_at = '2020-01-01T00:00:00.000Z'; source.expires_at = '2020-01-01T00:02:00.000Z';
  const input = work({ browser_source: source }); let acquisitions = 0, bindingCalls = 0;
  const fixture = fakeTransport(child => fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } }), { bindPage() { bindingCalls++; return null; }, acquirePage() { acquisitions++; assert.fail('Replay must not acquire'); } });
  const result = await fixture.transport.start(input, {});
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(acquisitions, 0); assert.equal(bindingCalls, 1);
  await fixture.transport.dispose();
});

test('Work browser missing grant returns typed denial and never accepts renderer page content as context', async () => {
  const input = work({ browser_source: browserSource() }); let reply;
  const fixture = fakeTransport((child, frame) => {
    if (frame.command === 'start') child.stdout.write(JSON.stringify(browserFrame(input)) + '\n');
    else { reply = frame; fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } }); }
  });
  assert.throws(() => validateWorkRequest({ ...input, browser_source: { ...input.browser_source, text: 'forged' } }));
  assert.equal((await fixture.transport.start(input, {})).ok, true);
  assert.equal(reply.error.code, 'BROWSER_SOURCE_UNAVAILABLE'); assert.equal(Object.hasOwn(reply, 'context'), false);
  await fixture.transport.dispose();
});

test('Work browser malformed hashes, identity, duplicate frames and unsolicited legacy acquisition fail before a second read', async () => {
  for (const variant of ['source', 'input', 'authority', 'acquisition', 'receipt', 'owner', 'extra', 'duplicate', 'legacy']) {
    const input = work(variant === 'legacy' ? {} : { browser_source: browserSource() });
    const original = variant === 'legacy' ? { ...input, browser_source: browserSource() } : input;
    let reads = 0;
    const fixture = fakeTransport((child, command) => {
      if (command.command === 'cancel' || command.command === 'cancel_request') { fakeResult(child, { ok: true, result: { mission: missionFor(input) } }); return; }
      const frame = browserFrame(original);
      if (variant === 'source') frame.source_sha256 = 'c'.repeat(64);
      if (variant === 'input') frame.input_sha256 = 'c'.repeat(64);
      if (variant === 'authority') frame.authority_sha256 = 'c'.repeat(64);
      if (variant === 'acquisition') frame.acquisition_id = 'c'.repeat(32);
      if (variant === 'receipt') frame.accepted_receipt = 'not-hash';
      if (variant === 'owner') frame.conversation_id = randomUUID();
      if (variant === 'extra') frame.script = 'never execute';
      child.stdout.write(JSON.stringify(frame) + '\n' + (variant === 'duplicate' ? JSON.stringify({ ...frame, accepted_receipt: 'c'.repeat(64) }) + '\n' : ''));
    }, { acquirePage() { reads++; return new Promise(() => {}); } });
    const result = await fixture.transport.start(input, {});
    assert.equal(result.ok, false, variant); assert.equal(result.error.code, 'INVALID_RUNTIME_RESPONSE', variant); assert.equal(reads, 0, variant);
    await fixture.transport.dispose();
  }
});

test('Work browser bounded callback timeout returns denial and ignores its eventual late page', async () => {
  const input = work({ browser_source: browserSource() }); let resolvePage, signal; const replies = [];
  const fixture = fakeTransport((child, frame) => {
    if (frame.command === 'start') child.stdout.write(JSON.stringify(browserFrame(input)) + '\n');
    else { replies.push(frame); fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } }); }
  }, { browserTimeoutMs: 10, acquirePage(_frame, _request, _owner, _binding, options) { signal = options.signal; return new Promise(resolve => { resolvePage = resolve; }); } });
  assert.equal((await fixture.transport.start(input, {})).ok, true);
  assert.equal(signal.aborted, true); assert.equal(replies.length, 1); assert.equal(replies[0].error.code, 'BROWSER_ACQUISITION_TIMEOUT');
  resolvePage(browserContext(input)); await new Promise(resolve => setImmediate(resolve)); assert.equal(replies.length, 1);
  await fixture.transport.dispose();
});

test('Work browser exact same acquisition retransmission reuses its pending and cached reply', async () => {
  const input = work({ browser_source: browserSource() }), replies = []; let reads = 0;
  const fixture = fakeTransport((child, frame) => {
    if (frame.command === 'start') child.stdout.write((JSON.stringify(browserFrame(input)) + '\n').repeat(2));
    else {
      replies.push(frame);
      if (replies.length === 1) child.stdout.write(JSON.stringify(browserFrame(input)) + '\n');
      else fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } });
    }
  }, { acquirePage() { reads++; return browserContext(input); } });
  assert.equal((await fixture.transport.start(input, {})).ok, true);
  assert.equal(reads, 1); assert.equal(replies.length, 2); assert.deepEqual(replies[0], replies[1]); await fixture.transport.dispose();
});

test('Work browser valid backend terminal receipt wins a timeout race and discards late host evidence', async () => {
  const input = work({ browser_source: browserSource() }); let resolvePage, signal; const replies = [];
  const fixture = fakeTransport((child, frame) => {
    if (frame.command === 'start') {
      child.stdout.write(JSON.stringify(browserFrame(input)) + '\n');
      setImmediate(() => fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } }));
    } else replies.push(frame);
  }, { acquirePage(_frame, _request, _owner, _binding, options) { signal = options.signal; return new Promise(resolve => { resolvePage = resolve; }); } });
  const result = await fixture.transport.start(input, {});
  assert.equal(result.ok, true); assert.equal(signal.aborted, true); assert.equal(fixture.invocations.length, 1);
  resolvePage(browserContext(input)); await new Promise(resolve => setImmediate(resolve)); assert.equal(replies.length, 0); await fixture.transport.dispose();
});

test('Work browser Stop aborts acquisition, confirms durable cancellation before kill, and discards late replies', async () => {
  const input = work({ browser_source: browserSource() }), owner = {}; let resolvePage, signal, started;
  const ready = new Promise(resolve => { started = resolve; }); const replies = [], release = [];
  const fixture = fakeTransport((child, frame) => {
    if (frame.command === 'start') child.stdout.write(JSON.stringify(browserFrame(input)) + '\n');
    else if (frame.command === 'cancel') {
      assert.equal(signal.aborted, true); assert.equal(fixture.invocations[0].child.killed, undefined);
      fakeResult(child, { ok: true, result: { mission: missionFor(input) } });
    } else replies.push(frame);
  }, { acquirePage(_frame, _request, _owner, _binding, options) { signal = options.signal; started(); return new Promise(resolve => { resolvePage = resolve; }); }, releasePage(binding) { release.push(binding); } });
  const pending = fixture.transport.start(input, owner); await ready;
  assert.equal((await fixture.transport.cancel(input.request_id, {})).result.cancelled, false);
  assert.equal((await fixture.transport.cancel(input.request_id, owner)).result.cancelled, true);
  assert.equal((await pending).result.mission.status, 'cancelled');
  resolvePage(browserContext(input)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 0); assert.equal(release.length, 1); await fixture.transport.dispose();
});

test('Work browser rejects mismatched or oversized callback evidence rather than writing it to stdin', async () => {
  for (const invalid of ['hash', 'source', 'budget']) {
    const input = work({ browser_source: browserSource() }); let reply;
    const fixture = fakeTransport((child, frame) => {
      if (frame.command === 'start') child.stdout.write(JSON.stringify(browserFrame(input)) + '\n');
      else { reply = frame; fakeResult(child, { ok: true, result: { mission: missionFor(input, 'completed') } }); }
    }, { acquirePage() { const value = browserContext(input, invalid === 'budget' ? 'x'.repeat(32001) : 'Valid text'); if (invalid === 'hash') value.sha256 = '0'.repeat(64); if (invalid === 'source') value.source_url = 'https://other.test/'; return value; } });
    assert.equal((await fixture.transport.start(input, {})).ok, true); assert.equal(reply.error.code, 'INVALID_BROWSER_CONTEXT'); assert.equal(Object.hasOwn(reply, 'context'), false);
    await fixture.transport.dispose();
  }
});

test('Work browser real CLI agrees on Unicode descriptor and acceptance hashes, commits context and replays without reacquisition', async t => {
  const source = { ...browserSource(), title: 'Page café 🧱', source_url: 'https://example.test/quoted?scope=public' }, input = work({ browser_source: source });
  let providerCalls = 0, reads = 0; const frames = [];
  const fixture = await nativeFixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); providerCalls++;
    if (providerCalls === 1) reply(res, call('acquire_selected_page', { source_id: source.source_id }));
    else {
      const record = JSON.parse(request.messages.at(-1).content);
      assert.equal(record.schema, 'yur.work-browser-result.v1'); assert.equal(record.committed, true); assert.equal(record.status, 'recorded');
      assert.equal(record.context.text, 'Actual broker fixture quantity: 37');
      reply(res, { content: 'Read the selected page quantity of 37.' });
    }
  }, { acquirePage(frame, acceptedRequest) { reads++; frames.push(frame); assert.equal(frame.source_sha256, digest(source)); assert.equal(frame.authority_sha256, digest(AUTHORITY)); return browserContext(acceptedRequest, 'Actual broker fixture quantity: 37'); } });
  const result = await fixture.transport.start(input, {});
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.mission.status, 'completed'); assert.equal(reads, 1); assert.equal(providerCalls, 2);
  const record = await fixture.transport.request({ command: 'inspect', mission_id: result.result.mission.id });
  assert.equal(record.result.events.filter(item => item.event_type === 'work.browser.result.committed').length, 1);
  assert.equal(record.result.events.find(item => item.event_type === 'work.browser.acquisition.accepted').hash, frames[0].accepted_receipt);
  const replay = await fixture.transport.start(input, {});
  assert.equal(replay.result.mission.id, result.result.mission.id); assert.equal(reads, 1); assert.equal(providerCalls, 2);
});

function conceptFixture() {
  const id = randomUUID(), now = new Date().toISOString();
  const receipt = { id: 1, concept_id: id, revision: 1, event_type: 'concept.created', hash: 'a'.repeat(64), previous_hash: '0'.repeat(64), created_at: now };
  const concept = { id, name: 'Quoted inspector', domain_tags: ['construction'], thesis_statement: 'Retain actual source evidence.', stage: 'genesis', parent_id: null, lineage: [],
    created_at: now, updated_at: now, versions: [], evidence: [], revision: 1, history_hash: receipt.hash, receipt };
  const record = { concept, events: [{ ...receipt, operation_id: randomUUID(), stage: 'genesis', request_hash: 'b'.repeat(64), decision: null }], history: { from_revision: 1, through_revision: 1, omitted_before: 0 } };
  const { thesis_statement: _thesis, lineage: _lineage, versions: _versions, evidence: _evidence, history_hash: _hash, receipt: _receipt, ...base } = concept;
  return { record, summary: { ...base, version_count: 0, evidence_count: 0 } };
}

function versionFixture(record, generated = false, previous = null) {
  const common = { id: randomUUID(), ordinal: (previous?.ordinal || 0) + 1, parent_version_id: previous?.id || null,
    artifact_sha256: (previous ? 'd' : 'c').repeat(64), runtime_sha256: 'e'.repeat(64),
    validation_receipt_hash: 'f'.repeat(64), artifact_receipt_hash: '1'.repeat(64), created_at: record.concept.created_at };
  return generated ? { ...common, kind: 'generated_python', source_work_id: '2'.repeat(32), build_step_index: 0,
    source_sha256: '3'.repeat(64), contract_sha256: '4'.repeat(64), driver_sha256: '5'.repeat(64),
    acceptance_cohort_sha256: '6'.repeat(64), evidence_verifier: 'yur.generated-evidence.v1' }
    : { ...common, build_mission_id: '2'.repeat(32) };
}

function versionEvidence(record, version, execution = false) {
  const generated = version.kind === 'generated_python';
  return { id: randomUUID(), requirement: execution ? 'instrumentation' : 'validation_plan',
    source: { kind: generated ? execution ? 'generated_execution' : 'generated_build' : execution ? 'specialist_execution' : 'specialist_build', version_id: version.id,
      ...(execution ? generated ? { execution_work_id: '7'.repeat(32), execution_step_index: 19 } : { run_id: '8'.repeat(32) } : {}) },
    artifact_id: version.id, artifact_sha256: version.artifact_sha256, receipt_hash: '9'.repeat(64), created_at: record.concept.created_at };
}

async function inspectFixture(record) {
  const fixture = fakeTransport(child => fakeResult(child, { ok: true, result: record }));
  try { return await fixture.transport.request({ command: 'concept_inspect', concept_id: record.concept.id }); }
  finally { await fixture.transport.dispose(); }
}

test('Concept version union preserves exact legacy records and generated publication identities with matched evidence', async () => {
  const { record } = conceptFixture(), legacy = versionFixture(record), generated = versionFixture(record, true, legacy);
  // Equal source IDs inhabit different identity domains: a pack mission is not a generated Work publication.
  record.concept.versions = [legacy, generated];
  record.concept.evidence = [versionEvidence(record, legacy), versionEvidence(record, legacy, true), versionEvidence(record, generated), versionEvidence(record, generated, true)];
  const response = await inspectFixture(record);
  assert.equal(response.ok, true, JSON.stringify(response)); assert.deepEqual(response.result, record);
  assert.equal(Object.hasOwn(response.result.concept.versions[0], 'kind'), false);
  assert.equal(Object.hasOwn(response.result.concept.versions[1], 'build_mission_id'), false);
  const another = { ...versionFixture(record, true, generated), build_step_index: 1, artifact_sha256: 'a'.repeat(64) };
  record.concept.versions.push(another);
  assert.equal((await inspectFixture(record)).ok, true, 'Different steps of the same Work remain distinct publications.');
  for (const step of [20, 100, 127]) {
    another.evidence_verifier = 'yur.generated-evidence.v2'; another.build_step_index = step;
    assert.equal((await inspectFixture(record)).ok, true, 'Current versions retain their v2 reader and bounded step.');
  }
  another.evidence_verifier = 'yur.generated-evidence.v1';
  assert.equal((await inspectFixture(record)).error?.code, 'INVALID_RUNTIME_RESPONSE', 'Historical reader must not accept a current-only step.');
});

test('Concept generated versions reject malformed unions, digest fields and duplicate publication or artifact identity', async () => {
  const { record } = conceptFixture(), legacy = versionFixture(record), generated = versionFixture(record, true, legacy);
  record.concept.versions = [legacy, generated];
  const changes = [
    value => { value.concept.versions[0].kind = 'legacy'; },
    value => { value.concept.versions[1].kind = 'python'; },
    value => { value.concept.versions[1].build_mission_id = legacy.build_mission_id; },
    value => { delete value.concept.versions[1].source_work_id; },
    value => { value.concept.versions[1].source_work_id = randomUUID(); },
    ...[-1, 128, true, 0.5].map(step => value => { value.concept.versions[1].build_step_index = step; }),
    value => { value.concept.versions[1].evidence_verifier = 'model-self-evaluation'; },
    value => { value.concept.versions[1].id = legacy.id; },
    value => { value.concept.versions[1].parent_version_id = randomUUID(); },
    value => { value.concept.versions[1].artifact_sha256 = legacy.artifact_sha256; },
    value => { value.concept.versions.push({ ...generated, id: randomUUID(), ordinal: 3, parent_version_id: generated.id, artifact_sha256: 'a'.repeat(64) }); },
    value => { value.concept.versions.push({ ...legacy, id: randomUUID(), ordinal: 3, parent_version_id: generated.id, artifact_sha256: 'a'.repeat(64) }); },
    ...['source_sha256', 'contract_sha256', 'driver_sha256', 'runtime_sha256', 'acceptance_cohort_sha256', 'artifact_sha256', 'validation_receipt_hash', 'artifact_receipt_hash']
      .map(key => value => { value.concept.versions[1][key] = 'A'.repeat(64); }),
  ];
  for (const [index, change] of changes.entries()) {
    const value = structuredClone(record); change(value);
    assert.equal((await inspectFixture(value)).error?.code, 'INVALID_RUNTIME_RESPONSE', `Mutation ${index} must not cross the Concept boundary.`);
  }
});

test('Concept evidence cannot cross version kinds or substitute generated artifact and execution references', async () => {
  const { record } = conceptFixture(), legacy = versionFixture(record), generated = versionFixture(record, true, legacy);
  record.concept.versions = [legacy, generated]; record.concept.evidence = [versionEvidence(record, generated, true)];
  const changes = [
    value => { value.concept.evidence[0].source.version_id = legacy.id; },
    value => { value.concept.evidence[0].source.version_id = randomUUID(); },
    value => { value.concept.evidence[0].artifact_id = randomUUID(); },
    value => { value.concept.evidence[0].artifact_sha256 = legacy.artifact_sha256; },
    value => { value.concept.evidence[0].source = { kind: 'specialist_build', version_id: generated.id }; },
    value => { value.concept.evidence[0].source = { kind: 'specialist_execution', version_id: generated.id, run_id: '7'.repeat(32) }; },
    value => { value.concept.evidence[0].source = { kind: 'generated_build', version_id: legacy.id }; },
    value => { value.concept.evidence[0].source.execution_work_id = randomUUID(); },
    ...[-1, 128, true].map(step => value => { value.concept.evidence[0].source.execution_step_index = step; }),
    value => { value.concept.evidence[0].source.run_id = '7'.repeat(32); },
  ];
  for (const [index, change] of changes.entries()) {
    const value = structuredClone(record); change(value);
    assert.equal((await inspectFixture(value)).error?.code, 'INVALID_RUNTIME_RESPONSE', `Evidence mutation ${index} must be rejected.`);
  }
});

test('Concept RPC accepts only bounded read commands and preload exposes no mutation', async () => {
  const { transport, invocations } = fakeTransport(() => assert.fail('Rejected input spawned a child'));
  const list = { command: 'concept_list', limit: 20, cursor: null };
  for (const input of [{ ...list, limit: true }, { ...list, limit: 21 }, { ...list, limit: 0 }, { ...list, cursor: 'a'.repeat(32) },
    { ...list, authority: {} }, { command: 'concept_create' }, { command: 'concept_inspect', concept_id: 'a'.repeat(32) },
    { command: 'concept_inspect', concept_id: randomUUID(), root: 'other-journal' }]) {
    assert.equal((await transport.request(input)).error.code, 'INVALID_REQUEST');
  }
  assert.equal(invocations.length, 0);
  await transport.dispose();
  let api; const calls = [];
  require('node:vm').runInNewContext(fs.readFileSync(path.join(sourceRoot, 'src/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } }, ipcRenderer: { invoke: (...args) => calls.push(args) } }),
  });
  const id = randomUUID();
  api.concepts.list(); api.concepts.list(3, id); api.concepts.inspect(id);
  assert.deepEqual(calls, [['concepts:list', 20, null], ['concepts:list', 3, id], ['concepts:inspect', id]]);
  assert.deepEqual(Object.keys(api.concepts).sort(), ['inspect', 'list']);
});

test('Concept views reject foreign identities, malformed pagination and snapshot-injected history', async () => {
  const { record, summary } = conceptFixture();
  const request = { command: 'concept_inspect', concept_id: record.concept.id };
  const valid = fakeTransport(child => fakeResult(child, { ok: true, result: record }));
  assert.equal((await valid.transport.request(request)).ok, true);
  await valid.transport.dispose();
  const alterations = [
    value => { value.concept.id = randomUUID(); },
    value => { value.events[0].concept_id = randomUUID(); },
    value => { value.events[0].hash = 'c'.repeat(64); },
    value => { value.events[0].document = value.concept; },
    value => { value.events[0].decision = { allowed: true }; },
    value => { value.history.omitted_before = 1; },
    value => { value.concept.lineage = [value.concept.id]; },
    value => { value.concept.versions = Array(17).fill({}); },
    value => { value.concept.receipt.revision = 2; },
    value => { value.concept.thesis_statement = 'x'.repeat(256 * 1024); },
  ];
  for (const change of alterations) {
    const value = structuredClone(record); change(value);
    const fixture = fakeTransport(child => fakeResult(child, { ok: true, result: value }));
    assert.equal((await fixture.transport.request(request)).error.code, 'INVALID_RUNTIME_RESPONSE');
    await fixture.transport.dispose();
  }
  const listRequest = { command: 'concept_list', limit: 2, cursor: null };
  const pages = [{ concepts: [summary, summary], next_cursor: null, total: 2 },
    { concepts: [summary], next_cursor: randomUUID(), total: 2 }, { concepts: [summary], next_cursor: null, total: 0 },
    { concepts: [{ ...summary, document: record.concept }], next_cursor: null, total: 1 }];
  for (const page of pages) {
    const fixture = fakeTransport(child => fakeResult(child, { ok: true, result: page }));
    assert.equal((await fixture.transport.request(listRequest)).error.code, 'INVALID_RUNTIME_RESPONSE');
    await fixture.transport.dispose();
  }
});

test('real Concept bridge discovers canonical Work-created records and reads interleaved receipt history without mutations', async t => {
  let count = 0, firstId;
  const fixture = await nativeFixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); count++;
    if (count === 1) reply(res, call('create_concept', { name: 'First continued concept', domain_tags: ['construction'], thesis_statement: 'Inspect exact quoted rows.' }));
    else if (count === 2) {
      firstId = JSON.parse(input.messages.at(-1).content).concept.id;
      reply(res, call('create_concept', { name: 'Independent concept', domain_tags: ['review'], thesis_statement: 'Retain a separate clock.' }));
    } else if (count === 3) reply(res, call('add_concept_evidence', { concept_id: firstId, expected_revision: 1, requirement: 'name', source: { kind: 'concept_intent' } }));
    else reply(res, { content: 'Two real concept identities are recorded, with one evidence reference. Both remain in Genesis.' });
  });
  const listRequest = { command: 'concept_list', limit: 20, cursor: null };
  assert.deepEqual(await fixture.transport.request(listRequest), { ok: true, result: { concepts: [], next_cursor: null, total: 0 } });
  assert.equal((await fixture.transport.request({ command: 'concept_inspect', concept_id: randomUUID() })).ok, false);
  assert.equal(fs.existsSync(fixture.stateRoot), false);
  const response = await fixture.transport.start(work(), {});
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.mission.status, 'completed');
  assert.ok(response.result.mission.steps.every(step => step.succeeded), JSON.stringify(response.result.mission.steps));
  const page = await fixture.transport.request({ ...listRequest, limit: 1 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(page.result.total, 2); assert.equal(page.result.concepts.length, 1);
  const next = await fixture.transport.request({ ...listRequest, limit: 1, cursor: page.result.next_cursor });
  assert.equal(next.ok, true, JSON.stringify(next)); assert.equal(next.result.next_cursor, null);
  const request = { command: 'concept_inspect', concept_id: firstId };
  const inspected = await fixture.transport.request(request);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.concept.stage, 'genesis');
  assert.equal(inspected.result.concept.evidence.length, 1);
  assert.equal(inspected.result.concept.revision, 2);
  assert.deepEqual(inspected.result.events.map(event => event.id), [1, 3]);
  assert.deepEqual(await fixture.transport.request(request), inspected);
  assert.equal(count, 4, 'Read-only discovery must never call a model.');
});

test('execution distribution is explicitly forwarded while invalid names fail before spawning', async () => {
  const { transport, invocations } = fakeTransport(child => fakeResult(child, { ok: true, result: { missions: [] } }), {
    getEnvironment: () => ({ PATH: 'runtime', YUR_EXECUTION_DISTRO: 'Ubuntu-24.04', YUR_EXECUTION_COMMAND: 'untrusted', SECRET_TOKEN: 'never-forward' }),
  });
  assert.equal((await transport.request({ command: 'list', conversation_id: null })).ok, true);
  assert.equal(invocations[0].settings.env.YUR_EXECUTION_DISTRO, 'Ubuntu-24.04');
  assert.equal(invocations[0].settings.env.YUR_EXECUTION_COMMAND, undefined);
  assert.equal(invocations[0].settings.env.SECRET_TOKEN, undefined);
  await transport.dispose();
  const invalid = fakeTransport(() => assert.fail('Invalid runtime name spawned a process'), {
    getEnvironment: () => ({ YUR_EXECUTION_DISTRO: 'Ubuntu; command' }),
  });
  assert.equal((await invalid.transport.request({ command: 'list', conversation_id: null })).ok, false);
  assert.equal(invalid.invocations.length, 0);
  await invalid.transport.dispose();
});

test('Work forwards the main-selected runtime while environment selection always wins', async () => {
  let displayed = 'Ubuntu-24.04';
  const fixture = fakeTransport(child => fakeResult(child, { ok: true, result: { missions: [] } }), { getExecutionDistro: () => displayed });
  await fixture.transport.request({ command: 'list', conversation_id: null });
  assert.equal(fixture.invocations[0].settings.env.YUR_EXECUTION_DISTRO, displayed);
  displayed = 'Other-reviewed'; await fixture.transport.request({ command: 'list', conversation_id: null });
  assert.equal(fixture.invocations[1].settings.env.YUR_EXECUTION_DISTRO, displayed);
  await fixture.transport.dispose();
  const overridden = fakeTransport(child => fakeResult(child, { ok: true, result: { missions: [] } }), { getEnvironment: () => ({ YUR_EXECUTION_DISTRO: 'Environment' }), getExecutionDistro: () => 'Saved' });
  await overridden.transport.request({ command: 'list', conversation_id: null }); assert.equal(overridden.invocations[0].settings.env.YUR_EXECUTION_DISTRO, 'Environment'); await overridden.transport.dispose();
});

test('mismatched events fail closed and interrupted starts trigger durable cancellation RPC with exact original identity', async () => {
  const commands = [];
  const { transport, invocations } = fakeTransport((child, request) => {
    commands.push(request);
    if (request.command === 'start') child.stdout.write(JSON.stringify({ type: 'status', mission_id: 'a'.repeat(32), request_id: randomUUID(), conversation_id: request.request.conversation_id, text: 'wrong request' }) + '\n');
    else fakeResult(child, { ok: true, result: { mission: missionFor(request.request) } });
  });
  const input = work(); const result = await transport.start(input);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_RUNTIME_RESPONSE');
  assert.equal(result.error.cancellation_confirmed, true);
  assert.deepEqual(commands[1], { command: 'cancel_request', request: input });
  assert.deepEqual(invocations[0].args, ['-B', '-m', 'foundry.work_cli']);
  assert.equal(invocations[0].settings.shell, false); assert.equal(invocations[0].settings.windowsHide, true);
  assert.equal(invocations[0].settings.env.PYTHONPATH, undefined); assert.equal(invocations[0].settings.env.SECRET_TOKEN, undefined);
  assert.equal(invocations[0].child.killed, true);
});

test('deadline and unconfirmed cancellation remain errors instead of fabricated successful Stop', async () => {
  const { transport, invocations } = fakeTransport((child, request) => {
    if (request.command === 'cancel_request') fakeResult(child, { ok: false, error: { code: 'STORAGE_ERROR', message: 'Unavailable test storage.' } }, 1);
  }, { timeoutMs: 20, controlTimeoutMs: 100 });
  const result = await transport.start(work());
  assert.equal(result.ok, false); assert.equal(result.error.code, 'RUNTIME_TIMEOUT');
  assert.equal(result.error.cancellation_confirmed, false);
  assert.match(result.error.cancellation_error, /not confirmed/);
  assert.equal(invocations[0].child.killed, true);
});

const correctionFor = input => ({ mission_id: 'a'.repeat(32), conversation_id: input.conversation_id, correction_id: randomUUID(), text: 'Keep the existing evidence; correct the summary wording.' });
function correctionResult(request, input, status = 'queued') {
  return { mission_id: request.mission_id, conversation_id: request.conversation_id, request_id: input.request_id,
    correction: { correction_id: request.correction_id, text: request.text, status,
      queued_receipt: { hash: '1'.repeat(64), revision: 2 }, consumed_receipt: status === 'consumed' ? { hash: '2'.repeat(64), revision: 3 } : null }, revision: status === 'consumed' ? 3 : 2 };
}

test('owned corrections are admitted during a verified worker wait and stop cannot reopen that authority', async () => {
  const input = work(), owner = {}, commands = [];
  let signal; const waiting = new Promise(resolve => { signal = resolve; });
  const fixture = fakeTransport((child, command) => {
    commands.push(command);
    if (command.command === 'start') busyResult(child, input);
    else if (command.command === 'steer') fakeResult(child, { ok: true, result: correctionResult(command, input) });
    else { assert.equal(command.command, 'cancel'); fakeResult(child, { ok: true, result: { mission: missionFor(input) } }); }
  }, { onEvent(event) { if (event.phase === 'worker_waiting') signal(); } });
  const pending = fixture.transport.start(input, owner); await waiting;
  const correction = correctionFor(input);
  assert.equal((await fixture.transport.steer(correction, {})).error.code, 'NOT_ACTIVE');
  assert.equal((await fixture.transport.steer({ ...correction, mission_id: 'b'.repeat(32) }, owner)).error.code, 'NOT_ACTIVE');
  const queued = await fixture.transport.steer(correction, owner);
  assert.equal(queued.ok, true, JSON.stringify(queued)); assert.equal(queued.result.correction.status, 'queued');
  assert.equal(commands.filter(command => command.command === 'start').length, 1, 'Correction must be accepted during the retry pause, without starting another worker');
  const stopping = fixture.transport.cancel(input.request_id, owner);
  assert.equal((await fixture.transport.steer({ ...correction, correction_id: randomUUID() }, owner)).error.code, 'NOT_ACTIVE');
  assert.equal((await stopping).result.cancelled, true); await pending;
  assert.equal((await fixture.transport.steer(correction, owner)).error.code, 'NOT_ACTIVE');
  assert.deepEqual(commands.map(command => command.command), ['start', 'steer', 'cancel']); await fixture.transport.dispose();
});

test('real queued mission accepts a correction under external lock contention and consumes it once after admission', async t => {
  let held;
  const holder = await nativeFixture(t, async (req, res) => { for await (const _chunk of req) {} held = res; });
  const first = work(), second = work(), owner = {}, events = [];
  const correctionText = 'Keep the same selected context. Report corrected quantity 73 from this operator instruction.';
  let modelCalls = 0;
  const waiter = await nativeFixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); modelCalls++;
    assert.equal(body.messages.at(-1).role, 'user'); assert.equal(body.messages.at(-1).content, correctionText);
    assert.equal(body.messages.filter(message => message.content === correctionText).length, 1);
    reply(res, { content: 'Corrected operator quantity: 73.' });
  }, { getStateRoot: () => holder.stateRoot, onEvent: event => events.push(event) });
  const firstRun = holder.transport.start(first, owner); await until(() => held);
  const pending = waiter.transport.start(second, owner);
  await until(() => events.some(event => event.phase === 'worker_waiting'));
  const missionId = events.find(event => event.phase === 'worker_waiting').mission_id;
  const correction = { mission_id: missionId, conversation_id: second.conversation_id, correction_id: randomUUID(), text: correctionText };
  const queued = await waiter.transport.steer(correction, owner);
  assert.equal(queued.ok, true, JSON.stringify(queued)); assert.equal(queued.result.correction.status, 'queued');
  assert.equal(queued.result.request_id, second.request_id);
  const before = await waiter.transport.request({ command: 'inspect', mission_id: missionId });
  assert.equal(before.result.mission.status, 'queued'); assert.equal(before.result.steering.length, 1);
  assert.equal(before.result.steering[0].status, 'queued'); assert.equal(modelCalls, 0);
  reply(held, { content: 'Unrelated lock holder complete.' }); assert.equal((await firstRun).result.mission.status, 'completed');
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.mission.id, missionId);
  assert.equal(result.result.mission.answer, 'Corrected operator quantity: 73.'); assert.equal(modelCalls, 1);
  assert.deepEqual(result.result.mission.request, second, 'Steering preserves the originally accepted request and authority');
  const after = await waiter.transport.request({ command: 'inspect', mission_id: missionId });
  assert.equal(after.result.steering.length, 1); assert.equal(after.result.steering[0].status, 'consumed');
  assert.deepEqual(after.result.steering[0].queued_receipt, queued.result.correction.queued_receipt);
  assert.equal(after.result.events.filter(event => event.event_type === 'work.submitted').length, 1);
  assert.equal(events.filter(event => event.type === 'steering' && event.status === 'consumed').length, 1);
  assert.equal((await waiter.transport.steer({ ...correction, correction_id: randomUUID() }, owner)).error.code, 'NOT_ACTIVE');
});

function activeSteeringFixture(behavior, options = {}) {
  const input = work(), owner = {};
  let activeChild, accepted;
  const acceptance = new Promise(resolve => { accepted = resolve; });
  const events = [];
  const fixture = fakeTransport((child, request) => {
    if (request.command === 'start') {
      activeChild = child;
      child.stdout.write(JSON.stringify({ type: 'status', mission_id: 'a'.repeat(32), request_id: input.request_id, conversation_id: input.conversation_id, text: 'Accepted' }) + '\n');
      accepted();
    } else if (request.command === 'cancel') fakeResult(child, { ok: true, result: { mission: missionFor(input) } });
    else behavior(child, request, input);
  }, { onEvent: (event, actualOwner) => events.push({ event, owner: actualOwner }), ...options });
  const pending = fixture.transport.start(input, owner);
  return { ...fixture, input, owner, acceptance, pending, events,
    child: () => activeChild,
    complete: () => fakeResult(activeChild, { ok: true, result: { mission: missionFor(input, 'completed') } }) };
}

test('steering rejects invalid data, generic RPC bypass, foreign owners and settled operations without spawning', async () => {
  const fixture = activeSteeringFixture(() => assert.fail('Unauthorized control process spawned'));
  await fixture.acceptance;
  const request = correctionFor(fixture.input);
  assert.doesNotThrow(() => validateSteerRequest(request));
  for (const bad of [{ ...request, authority: {} }, { ...request, text: ' ' }, { ...request, text: 'x'.repeat(8001) }, { ...request, text: '\0' }, { ...request, correction_id: 'bad' }]) {
    assert.equal((await fixture.transport.steer(bad, fixture.owner)).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await fixture.transport.request({ command: 'steer', ...request })).error.code, 'INVALID_REQUEST');
  for (const [value, owner] of [[request, {}], [{ ...request, conversation_id: randomUUID() }, fixture.owner], [{ ...request, mission_id: 'b'.repeat(32) }, fixture.owner]]) {
    assert.equal((await fixture.transport.steer(value, owner)).error.code, 'NOT_ACTIVE');
  }
  assert.equal(fixture.invocations.length, 1);
  fixture.complete();
  assert.equal((await fixture.transport.steer(request, fixture.owner)).error.code, 'NOT_ACTIVE');
  await fixture.pending;
  assert.equal(fixture.invocations.length, 1);
  await fixture.transport.dispose();
});

test('owner-bound steering sends a separate control CLI and validates queued and consumed receipts', async () => {
  const controls = [];
  const fixture = activeSteeringFixture((child, request, input) => {
    controls.push(request);
    fakeResult(child, { ok: true, result: correctionResult(request, input, controls.length === 1 ? 'queued' : 'consumed') });
  });
  await fixture.acceptance;
  const request = correctionFor(fixture.input);
  const queued = await fixture.transport.steer(request, fixture.owner);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.deepEqual(controls[0], { command: 'steer', ...request });
  assert.equal(fixture.invocations[0].child.killed, undefined);
  assert.equal(fixture.child().stdin.writableEnded, true);
  assert.deepEqual(fixture.events.at(-1), { owner: fixture.owner, event: {
    type: 'steering', mission_id: request.mission_id, request_id: fixture.input.request_id, conversation_id: request.conversation_id,
    correction_id: request.correction_id, status: 'queued', receipt: queued.result.correction.queued_receipt,
  } });
  const consumed = await fixture.transport.steer(request, fixture.owner);
  assert.equal(consumed.result.correction.status, 'consumed');
  assert.deepEqual(fixture.invocations[1].args, ['-B', '-m', 'foundry.work_cli']);
  assert.equal(fixture.invocations[1].settings.shell, false);
  fixture.complete(); await fixture.pending; await fixture.transport.dispose();
});

test('malformed steering acknowledgements cannot change or cancel the active operation', async () => {
  const changes = [
    value => { value.mission_id = 'b'.repeat(32); }, value => { value.request_id = randomUUID(); }, value => { value.conversation_id = randomUUID(); },
    value => { value.correction.correction_id = randomUUID(); }, value => { value.correction.text += ' forged'; }, value => { value.correction.queued_receipt.hash = 'invalid'; },
    value => { value.correction.queued_receipt.revision = -1; }, value => { value.correction.status = 'consumed'; }, value => { value.revision = 1; },
    value => { value.correction.consumed_receipt = { hash: '2'.repeat(64), revision: 3 }; }, value => { value.authority = {}; },
  ];
  let current = 0;
  const fixture = activeSteeringFixture((child, request, input) => {
    const value = correctionResult(request, input); changes[current++](value); fakeResult(child, { ok: true, result: value });
  });
  await fixture.acceptance;
  for (const _change of changes) {
    const response = await fixture.transport.steer(correctionFor(fixture.input), fixture.owner);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_RUNTIME_RESPONSE');
    assert.equal(fixture.child().killed, undefined);
  }
  fixture.complete(); assert.equal((await fixture.pending).ok, true); await fixture.transport.dispose();
});

test('valid in-flight correction receipt survives mission completion and no new correction is accepted afterward', async () => {
  let control;
  const fixture = activeSteeringFixture((child, request, input) => { control = { child, request, input }; });
  await fixture.acceptance;
  const request = correctionFor(fixture.input);
  const queued = fixture.transport.steer(request, fixture.owner);
  await new Promise(resolve => setImmediate(resolve));
  fixture.complete(); await fixture.pending;
  fakeResult(control.child, { ok: true, result: correctionResult(control.request, control.input, 'not_consumed') });
  const response = await queued;
  assert.equal(response.ok, true);
  assert.equal(response.result.correction.status, 'not_consumed');
  assert.equal((await fixture.transport.steer(request, fixture.owner)).error.code, 'NOT_ACTIVE');
  await fixture.transport.dispose();
});

test('steering events bind receipt and identifiers while accepted mission identity cannot drift', async () => {
  const fixture = activeSteeringFixture(() => assert.fail('Unexpected steering control'));
  await fixture.acceptance;
  const request = correctionFor(fixture.input);
  const event = { type: 'steering', mission_id: request.mission_id, request_id: fixture.input.request_id, conversation_id: fixture.input.conversation_id,
    correction_id: request.correction_id, status: 'consumed', receipt: { hash: '2'.repeat(64), revision: 3 } };
  fixture.child().stdout.write(JSON.stringify(event) + '\n');
  assert.deepEqual(fixture.events.at(-1), { owner: fixture.owner, event });
  fixture.child().stdout.write(JSON.stringify({ ...event, mission_id: 'b'.repeat(32) }) + '\n');
  const response = await fixture.pending;
  assert.equal(response.error.code, 'INVALID_RUNTIME_RESPONSE');
  assert.equal(response.error.cancellation_confirmed, true);
  assert.equal(fixture.invocations.length, 2);
  await fixture.transport.dispose();
});

test('a steering timeout leaves the active work process intact and permits an idempotent retry', async () => {
  let controls = 0;
  const fixture = activeSteeringFixture((child, request, input) => {
    if (++controls > 1) fakeResult(child, { ok: true, result: correctionResult(request, input) });
  }, { controlTimeoutMs: 20, timeoutMs: 1000 });
  await fixture.acceptance;
  const request = correctionFor(fixture.input);
  assert.equal((await fixture.transport.steer(request, fixture.owner)).error.code, 'RUNTIME_TIMEOUT');
  assert.equal(fixture.child().killed, undefined);
  assert.equal((await fixture.transport.steer(request, fixture.owner)).ok, true);
  fixture.complete(); assert.equal((await fixture.pending).ok, true); await fixture.transport.dispose();
});

test('steering stream rejects missing or forged consumption receipt fields', async () => {
  for (const receipt of [{ hash: '2'.repeat(64), revision: 0 }, { hash: 'forged', revision: 3 }, { hash: '2'.repeat(64), revision: 3, authority: 'model' }]) {
    const fixture = activeSteeringFixture(() => assert.fail('Unexpected control request'));
    await fixture.acceptance;
    fixture.child().stdout.write(JSON.stringify({ type: 'steering', mission_id: 'a'.repeat(32), request_id: fixture.input.request_id,
      conversation_id: fixture.input.conversation_id, correction_id: randomUUID(), status: 'consumed', receipt }) + '\n');
    const response = await fixture.pending;
    assert.equal(response.error.code, 'INVALID_RUNTIME_RESPONSE');
    assert.equal(response.error.cancellation_confirmed, true);
    await fixture.transport.dispose();
  }
});

test('real steering queues during provider work, consumes once and replaces the stale response in the same mission', async t => {
  let reachedProvider, waitingResponse;
  const providerWaiting = new Promise(resolve => { reachedProvider = resolve; });
  const requests = [];
  const correctionText = '  Keep the measured quantity 24. Create corrected.md instead of stale.md.\nPreserve this exact correction.  ';
  const fixture = await nativeFixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    if (requests.length === 1) {
      waitingResponse = res;
      reachedProvider();
    } else if (requests.length === 2) {
      reply(res, call('create_artifact', { name: 'corrected.md', media_type: 'text/markdown', content: '# Corrected\nMeasured quantity: 24' }));
    } else reply(res, { content: 'Created corrected.md from the corrected request.' });
  });
  const input = work({ root: fixture.project }), owner = {};
  const pending = fixture.transport.start(input, owner);
  await Promise.race([providerWaiting, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Steering fixture did not reach the provider.')), 5000); timer.unref();
  })]);
  const missionId = fixture.events.find(item => item.event.type === 'status').event.mission_id;
  const correction = { mission_id: missionId, conversation_id: input.conversation_id, correction_id: randomUUID(), text: correctionText };
  const queued = await fixture.transport.steer(correction, owner);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.result.correction.status, 'queued');
  assert.equal(queued.result.correction.text, correctionText);
  const replayed = await fixture.transport.steer(correction, owner);
  assert.deepEqual(replayed, queued, 'Retrying an accepted correction must reuse its committed receipt.');
  const conflicting = await fixture.transport.steer({ ...correction, text: 'A different correction.' }, owner);
  assert.equal(conflicting.ok, false);
  assert.equal(requests.length, 1, 'Steering must not start another provider call or mission.');
  reply(waitingResponse, call('create_artifact', { name: 'stale.md', media_type: 'text/markdown', content: 'This stale response must never execute.' }));
  const completed = await pending;
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(completed.result.mission.id, missionId);
  assert.equal(completed.result.mission.request_id, input.request_id);
  assert.equal(completed.result.mission.status, 'completed');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].messages.filter(message => message.content === correctionText), [{ role: 'user', content: correctionText }]);
  assert.equal(completed.result.mission.steps.length, 1, 'The stale tool call must be discarded before executing.');
  assert.equal(completed.result.mission.artifacts.length, 1);
  assert.equal(completed.result.mission.artifacts[0].proposal.name, 'corrected.md');
  const inspected = await fixture.transport.request({ command: 'inspect', mission_id: missionId });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.steering.length, 1);
  const consumed = inspected.result.steering[0];
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.correction_id, correction.correction_id);
  assert.equal(consumed.text, correctionText);
  assert.deepEqual(consumed.queued_receipt, queued.result.correction.queued_receipt);
  assert.ok(consumed.consumed_receipt.revision > consumed.queued_receipt.revision);
  const consumedEvents = fixture.events.filter(item => item.event.type === 'steering' && item.event.status === 'consumed');
  assert.deepEqual(consumedEvents, [{ owner, event: { type: 'steering', mission_id: missionId, request_id: input.request_id,
    conversation_id: input.conversation_id, correction_id: correction.correction_id, status: 'consumed', receipt: consumed.consumed_receipt } }]);
  const listed = await fixture.transport.request({ command: 'list', conversation_id: input.conversation_id });
  assert.equal(listed.result.missions.length, 1);
  assert.equal((await fixture.transport.steer(correction, owner)).error.code, 'NOT_ACTIVE');
  assert.equal(fs.readFileSync(path.join(fixture.project, 'report.txt'), 'utf8'), 'Measured quantity: 24');
});
