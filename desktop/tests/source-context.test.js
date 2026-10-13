'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const context = require('../src/source-context');
const { validateFactoryRequest } = require('../src/desktop-security');
const { validateRequest, parseResponse } = require('../src/conversation-transport');
const selected = { source_id: 'yur-os', relative_path: 'README.md', sha256: 'a'.repeat(64), name: 'README.md' };
const acquired = () => { const content = '<script>PRIVATE_SOURCE_MARKER</script>'; return { schema: 'yur.source-acquisition.v1', context_only: true, execution_admitted: false, content, evidence: { schema: 'yur.source-evidence.v1', source_id: selected.source_id, relative_path: selected.relative_path, sha256: selected.sha256, bytes: Buffer.byteLength(content), excerpt_sha256: createHash('sha256').update(content).digest('hex'), truncated: false, context_only: true, execution_admitted: false } }; };

test('source references persist without content and reject duplicates, paths and extra authority', () => {
  assert.deepEqual(context.selections([selected]), [selected]); assert.deepEqual(context.selections([]), []);
  for (const values of [[selected, { ...selected, relative_path: 'readme.md' }], [{ ...selected, content: 'source' }], [{ ...selected, authority: {} }], Array(4).fill(selected), [{ ...selected, relative_path: '../README.md' }], [{ ...selected, relative_path: 'D:/README.md' }], [{ ...selected, relative_path: 'src\\readme.md' }], [{ ...selected, source_id: 'yur_os' }]]) assert.throws(() => context.selections(values));
  const conversation = { source_selections: [selected] };
  assert.equal(JSON.parse(validateRequest({ command: 'save', conversation, expected_revision: 0 })).conversation.source_selections[0].sha256, selected.sha256);
  assert.throws(() => validateRequest({ command: 'save', conversation: { source_selections: [{ ...selected, content: 'bad' }] }, expected_revision: 0 }));
  assert.throws(() => parseResponse(JSON.stringify({ ok: true, result: { conversations: [{ source_selections: Array(4).fill(selected) }] } }), 'list'));
});

test('only the selected hash-bound excerpt is compiled as reference data', () => {
  const result = acquired(); assert.equal(context.acquisition(result, selected), result);
  const compiled = context.compile(result, selected); assert.ok(compiled.includes(result.content)); assert.match(compiled, /untrusted data/); assert.match(compiled, /does not|not instructions/);
  assert.deepEqual(Object.keys(result.evidence).includes('content'), false);
  for (const bad of [{ ...result, execution_admitted: true }, { ...result, content: 'x'.repeat(16001) }, { ...result, evidence: { ...result.evidence, sha256: 'b'.repeat(64) } }, { ...result, evidence: { ...result.evidence, source_id: 'other' } }]) assert.throws(() => context.acquisition(bad, selected));
});

test('source transport request cannot inject a root, alternate command or arbitrary file', () => {
  const request = { command: 'source_acquire', source_id: selected.source_id, relative_path: selected.relative_path, expected_sha256: selected.sha256 };
  assert.equal(JSON.parse(validateFactoryRequest(request)).command, 'source_acquire');
  for (const bad of [{ ...request, root: 'D:/elsewhere' }, { ...request, relative_path: '../../secret' }, { ...request, expected_sha256: null }]) assert.throws(() => validateFactoryRequest(bad));
});
