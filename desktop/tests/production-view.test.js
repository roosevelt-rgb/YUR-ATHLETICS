'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProductionSnapshot } = require('../src/production-view');

test('Production reads existing owners and labels session-only usage without claiming a release', async () => {
  const calls = [];
  const api = {
    work: { list: async scope => { calls.push(['work', scope]); return { ok: true, result: { missions: [{ id: 'a'.repeat(32), status: 'completed' }] } }; } },
    lifecycles: { list: async () => { calls.push(['lifecycles']); return { ok: true, result: { deployments: [{ name: 'Actual deployment', state: 'active' }] } }; } },
    ship: { list: async () => { calls.push(['ship']); return { ok: true, result: { candidates: [{ name: 'Real check', last_verdict: 'PASS' }] } }; } },
    activity: { snapshot: async () => { calls.push(['activity']); return { ok: true, result: { schema: 'yur.activity.v1', observed_at: '2026-10-07T08:00:00Z', runs: [{ output_chars: 15 }, { output_chars: 7 }] } }; } },
  };
  const snapshot = await loadProductionSnapshot(api);
  assert.deepEqual(calls, [['work', null], ['lifecycles'], ['ship'], ['activity']]);
  assert.equal(snapshot.work.records[0].status, 'completed');
  assert.equal(snapshot.deployments.records[0].name, 'Actual deployment');
  assert.equal(snapshot.shipping.records[0].last_verdict, 'PASS');
  assert.equal(snapshot.currentSessionOutputCharacters, 22);
  assert.equal(snapshot.releases.available, false);
  assert.match(snapshot.releases.reason, /No signed release registry/);
});

test('Production keeps failed sources unavailable rather than displaying empty success', async () => {
  const api = {
    work: { list: async () => ({ ok: false, error: { message: 'backend unavailable' } }) },
    lifecycles: { list: async () => { throw new Error('offline'); } },
    ship: { list: async () => ({ ok: true, result: { candidates: [] } }) },
    activity: { snapshot: async () => ({ ok: true, result: { schema: 'wrong', runs: [] } }) },
  };
  const snapshot = await loadProductionSnapshot(api);
  assert.equal(snapshot.work.available, false);
  assert.equal(snapshot.deployments.available, false);
  assert.equal(snapshot.shipping.available, true);
  assert.equal(snapshot.shipping.records.length, 0);
  assert.equal(snapshot.activity.available, false);
  assert.equal(snapshot.currentSessionOutputCharacters, null);
});
