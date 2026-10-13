'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMusicUiHost } = require('../src/music-ui-host');
function fixture(options = {}) {
  const calls = [], approvals = [], owner = { isDestroyed: () => false }, window = { webContents: owner, isDestroyed: () => false };
  let configuration = { endpoint: 'selected', token: 'host-only' };
  const host = createMusicUiHost({ services: { validate: (a, p) => { if (p.request?.external_approved) throw new Error('Host owns authority'); },
    confirmationRequirements: () => ({ required: true, rights_attested: true, external_approved: true, review: 'Approve rights and external provider account credits.' }),
    execute: async (action, payload, identity, confirmation) => { calls.push({ action, payload, identity, confirmation });
      return { document: { id: identity.action_id, kind: payload.kind || 'job' } }; } }, getConfiguration: () => configuration,
    getWindow: () => window, confirm: async r => { approvals.push(r); return true; }, deny: () => '', getSettings: () => ({}), ...options });
  return { host, owner, calls, approvals, changeConnection: () => { configuration = { endpoint: 'changed' }; } };
}
const form = () => ({ title: 'Silver morning', lyrics: '[Verse]\nAn original line.', request: { provider: 'observed-provider', private: false, mode: 'custom' } });
test('one human review binds the entire form and all three committed Music operations', async () => {
  const f = fixture(), result = await f.host.invoke(f.owner, 'generate_song', form());
  assert.equal(result.ok, true); assert.equal(f.approvals.length, 1);
  assert.deepEqual(f.calls.map(c => c.action), ['music_document', 'music_document', 'music_generate']);
  assert.equal(f.calls[1].payload.data.composition_id, f.calls[0].identity.action_id);
  assert.equal(f.calls[2].payload.request.lyrics_id, f.calls[1].identity.action_id);
  assert.equal(new Set(f.calls.map(c => c.identity.action_id)).size, 3);
  assert.equal(f.approvals[0].payload.lyrics, form().lyrics);
  assert.equal(f.calls[2].confirmation.external_approved, true);
});
test('denial leaves documents and providers untouched', async () => {
  const f = fixture({ confirm: async () => false });
  assert.equal((await f.host.invoke(f.owner, 'generate_song', form())).result.cancelled, true); assert.equal(f.calls.length, 0);
});
test('changed connection during review and model-supplied grants fail before any writes', async () => {
  let f = fixture({ confirm: async () => { f.changeConnection(); return true; } });
  assert.equal((await f.host.invoke(f.owner, 'generate_song', form())).ok, false); assert.equal(f.calls.length, 0);
  f = fixture(); const payload = form(); payload.request.external_approved = true;
  assert.equal((await f.host.invoke(f.owner, 'generate_song', payload)).ok, false); assert.equal(f.approvals.length, 0);
});
test('partial save returns real document IDs and never retries uncertain generation', async () => {
  let calls = 0;
  const f = fixture({ services: { validate() {}, confirmationRequirements: () => ({ required: true }),
    execute: async (_a, payload, identity) => { calls++; if (calls === 3) throw new Error('uncertain'); return { document: { id: identity.action_id } }; } } });
  const result = await f.host.invoke(f.owner, 'generate_song', form());
  assert.equal(result.ok, false); assert.match(result.saved.lyrics_id, /^[a-f0-9]{32}$/); assert.equal(calls, 3);
});
