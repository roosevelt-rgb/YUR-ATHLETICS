'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workModelReadiness } = require('../src/work-model-readiness');

test('readiness requires explicit provider tool evidence without inference', async () => {
  const calls = [];
  const transport = { request: async (...args) => { calls.push(args); return { status: 200, json: { capabilities: ['tools'] } }; } };
  assert.equal((await workModelReadiness(transport, 'foundry:auto')).ready, false);
  assert.equal(calls.length, 0);
  const result = await workModelReadiness(transport, 'ollama:chosen');
  assert.equal(result.ready, true);
  assert.deepEqual(calls, [['POST', '/api/show', { model: 'chosen' }, 10000]]);
  assert.match(result.message, /still require committed evidence/);
});

test('missing, malformed, failed and offline capability responses fail closed', async () => {
  for (const response of [{ status: 200, json: {} }, { status: 200, json: { capabilities: 'tools' } },
    { status: 200, json: { capabilities: ['completion'] } }, { status: 500, json: { capabilities: ['tools'] } }]) {
    assert.equal((await workModelReadiness({ request: async () => response }, 'ollama:chosen')).ready, false);
  }
  const result = await workModelReadiness({ request: async () => { throw new Error('private transport details'); } }, 'ollama:chosen');
  assert.equal(result.ready, false);
  assert.doesNotMatch(result.message, /private/);
});
