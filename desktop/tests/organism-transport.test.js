'use strict';
// Ship gate / Pulse / Organism commands cross the Work transport only in their exact shapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRpc } = require('../src/work-transport');

const ID = '3f2a8c4e-1b6d-4e9a-9c7f-0a1b2c3d4e5f';

test('organism commands are admitted in exact shapes', () => {
  for (const value of [
    { command: 'organism_status' }, { command: 'ship_list' },
    { command: 'ship_create', spec: { name: 'x', money_path: 'y', probes: [] } },
    { command: 'ship_state', candidate_id: ID, expected_revision: 2, state: 'paused' },
    { command: 'ship_check_now', candidate_id: ID }, { command: 'ship_events', candidate_id: ID },
    { command: 'pulse_intake', mutation: { source: 'desktop', mutation_type: 'manual_trigger', payload: {} } },
  ]) assert.doesNotThrow(() => validateRpc(value), JSON.stringify(value));
});

test('organism commands reject extra fields, bad ids, revisions and states', () => {
  for (const value of [
    { command: 'organism_status', extra: 1 },
    { command: 'ship_check_now', candidate_id: 'not-a-uuid' },
    { command: 'ship_state', candidate_id: ID, expected_revision: 0, state: 'paused' },
    { command: 'ship_state', candidate_id: ID, expected_revision: 1, state: 'deleted' },
    { command: 'ship_create', spec: 'probe everything' },
    { command: 'pulse_intake', mutation: [] },
    { command: 'ship_verdict_override', candidate_id: ID },
  ]) assert.throws(() => validateRpc(value), JSON.stringify(value));
});
