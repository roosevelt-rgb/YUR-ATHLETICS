'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createActivityFeed, MAX_RUNS, MAX_EVENTS, MAX_TOOLS } = require('../src/activity-feed');
const begin = (overrides = {}) => ({ type: 'begin', id: randomUUID(), kind: 'work', origin: 'conversation',
  conversation_id: randomUUID(), provider: 'ollama', model: 'fixture-model', phase: 'queued', ...overrides });

test('host snapshots distinguish observation freshness from actual progress and return independent copies', () => {
  let now = 1000; const feed = createActivityFeed({ now: () => now });
  const idle = feed.snapshot(); assert.equal(idle.sequence, 0); assert.deepEqual(idle.runs, []);
  const request = begin(); assert.equal(feed.observe(request), true);
  const first = feed.snapshot(); assert.equal(first.runs[0].status, 'queued'); assert.equal(first.runs[0].mission_id, null);
  now = 5000; const later = feed.snapshot(); assert.equal(first.sequence, later.sequence);
  assert.notEqual(first.observed_at, later.observed_at); assert.equal(first.runs[0].updated_at, later.runs[0].updated_at);
  later.runs[0].status = 'completed'; later.runs[0].events.length = 0;
  assert.equal(feed.snapshot().runs[0].status, 'queued'); assert.equal(feed.snapshot().runs[0].events.length, 1);
  now = 500; feed.observe({ type: 'update', id: request.id, phase: 'dispatching' });
  assert.ok(feed.snapshot().runs[0].updated_at >= first.runs[0].updated_at);
});

test('the projection rejects extra content, authority, identifiers and arbitrary progress labels', () => {
  const feed = createActivityFeed(), request = begin(); feed.observe(request);
  for (const invalid of [
    { type: 'update', id: request.id, phase: 'working', text: 'private thought' },
    { type: 'update', id: request.id, phase: 'working', arguments: { secret: 'do not disclose' } },
    { type: 'update', id: request.id, phase: 'working', reasoning: 'private' },
    { type: 'update', id: request.id, phase: 'custom secret label' },
    { type: 'update', id: request.id, phase: 'working', mission_id: '../outside' },
    { type: 'update', id: request.id, phase: 'streaming', output_chars: -1 },
    { type: 'finish', id: request.id, phase: 'tool_running' },
    { type: 'update', id: randomUUID(), phase: 'working' },
    { ...begin(), prompt: 'private' },
    { ...begin(), origin: 'external-authority' },
  ]) assert.equal(feed.observe(invalid), false);
  assert.equal(feed.snapshot().sequence, 1); assert.doesNotMatch(JSON.stringify(feed.snapshot()), /private|secret|authority/);
  const mission = 'a'.repeat(32);
  assert.equal(feed.observe({ type: 'update', id: request.id, phase: 'accepted', mission_id: mission }), true);
  assert.equal(feed.observe({ type: 'update', id: request.id, phase: 'working', mission_id: 'b'.repeat(32) }), false);
});

test('stop does not become completed from late progress and terminal observations prevent later updates', () => {
  const feed = createActivityFeed(), request = begin(); feed.observe(request);
  feed.observe({ type: 'update', id: request.id, phase: 'stopping' });
  feed.observe({ type: 'update', id: request.id, phase: 'model_completed' });
  feed.observe({ type: 'update', id: request.id, phase: 'completing' });
  assert.equal(feed.snapshot().runs[0].status, 'stopping'); assert.equal(feed.snapshot().runs[0].request_active, true);
  assert.equal(feed.snapshot().runs[0].ended_at, null);
  feed.observe({ type: 'update', id: request.id, phase: 'process_closed' });
  feed.observe({ type: 'finish', id: request.id, phase: 'unconfirmed' });
  const final = feed.snapshot().runs[0]; assert.equal(final.status, 'unconfirmed'); assert.equal(final.request_active, false);
  assert.ok(final.ended_at); assert.equal(feed.observe({ type: 'update', id: request.id, phase: 'working' }), false);
  assert.equal(feed.observe({ type: 'finish', id: request.id, phase: 'completed' }), false);
});

test('public output totals are monotonic and do not create a transcript or one event per token', () => {
  const feed = createActivityFeed(), request = begin({ kind: 'chat', phase: 'model_running' }); feed.observe(request);
  for (let count = 1; count <= 200; count++) feed.observe({ type: 'update', id: request.id, phase: 'streaming', output_chars: count });
  assert.equal(feed.snapshot().runs[0].output_chars, 200); assert.equal(feed.snapshot().runs[0].events.length, 2);
  assert.equal(feed.observe({ type: 'update', id: request.id, phase: 'streaming', output_chars: 100 }), false);
  feed.observe({ type: 'finish', id: request.id, phase: 'completed', output_chars: 201 });
  assert.equal(feed.snapshot().runs[0].output_chars, 201);
});

test('event and tool retention is bounded with truthful omission and stable exact identities', () => {
  const feed = createActivityFeed(), request = begin(); feed.observe(request);
  for (let index = 0; index < 100; index++) {
    const id = index.toString(16).padStart(32, '0');
    feed.observe({ type: 'update', id: request.id, phase: 'tool_running', tool: { id, name: 'read_file', status: 'running' } });
    feed.observe({ type: 'update', id: request.id, phase: 'tool_completed', tool: { id, name: 'read_file', status: 'completed' } });
  }
  const run = feed.snapshot().runs[0]; assert.equal(run.tools.length, MAX_TOOLS); assert.ok(run.tools.every(tool => tool.status === 'completed'));
  assert.equal(run.events.length, MAX_EVENTS); assert.equal(run.omitted_events, 201 - MAX_EVENTS);
  assert.ok(run.events.every(event => !Object.hasOwn(event, 'arguments') && !Object.hasOwn(event, 'result')));
});

test('bounded run retention preserves active requests while replacing oldest completed observations', () => {
  const feed = createActivityFeed(), requests = Array.from({ length: MAX_RUNS }, () => begin());
  requests.forEach(item => feed.observe(item)); assert.equal(feed.snapshot().runs.length, MAX_RUNS);
  assert.equal(feed.observe(begin()), false); assert.equal(feed.snapshot().omitted_runs, 1);
  feed.observe({ type: 'finish', id: requests[12].id, phase: 'completed' });
  const next = begin({ origin: 'schedule' }); assert.equal(feed.observe(next), true);
  const snapshot = feed.snapshot(); assert.equal(snapshot.runs.length, MAX_RUNS); assert.equal(snapshot.omitted_runs, 2);
  assert.equal(snapshot.runs.some(run => run.id === requests[12].id), false); assert.equal(snapshot.runs[0].origin, 'schedule');
  assert.ok(requests.filter((_, index) => index !== 12).every(item => snapshot.runs.some(run => run.id === item.id)));
});

test('observer failure cannot prevent the host observation and factory completion remains request-scoped', () => {
  const feed = createActivityFeed({ onChange: () => { throw new Error('closed renderer'); } });
  const request = begin({ kind: 'factory', origin: 'factory', conversation_id: null, provider: null, model: null, phase: 'factory_running' });
  assert.equal(feed.observe(request), true); feed.observe({ type: 'update', id: request.id, phase: 'completing' });
  assert.equal(feed.snapshot().runs[0].request_active, true);
  feed.observe({ type: 'finish', id: request.id, phase: 'completed' });
  assert.equal(feed.snapshot().runs[0].label, 'Specialist factory request'); assert.equal(feed.snapshot().runs[0].mission_id, null);
});
