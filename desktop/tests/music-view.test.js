'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create, normalizeProviders, buildSongRequest } = require('../src/music-view');

class Element {
  constructor(tag, ownerDocument) { Object.assign(this, { tagName: tag, ownerDocument, children: [], attributes: {}, listeners: {}, dataset: {}, _text: '', className: '', value: '', hidden: false, disabled: false, checked: false }); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(' '); }
  set innerHTML(_) { throw new Error('Music content must stay inert'); }
  append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parent = this; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() { this.ownerDocument.focused = this; }
  pause() { this.paused = true; }
}
const all = root => [root, ...root.children.flatMap(all)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const provider = { id: 'fixture-music', name: 'Fixture music', configured: true, external: true, status: 'Test configuration', models: ['MODEL-A', 'MODEL-B'], default_model: 'MODEL-A', capabilities: { simple: true, custom: true, vocals: true, instrumental: true } };
const base = { mode: 'custom', title: 'Silver sky', lyrics: '[Verse]\nOriginal words\n', description: '', style: 'Acoustic', tags: ['Reflective'], instrumental: false, provider: provider.id, model: 'MODEL-A' };
const job = { id: 'a'.repeat(32), kind: 'job', data: { request: { title: 'Silver sky', provider: provider.id }, state: 'queued' } };
const variant = { id: 'b'.repeat(32), kind: 'variant', data: { audio: 'c'.repeat(64), result_title: 'Silver sky', provider: 'Fixture music', index: 1, validation: { duration: 14 } } };
const grantUrl = id => 'yur-music://asset/12345678-1234-4234-8234-123456789abc/' + id + '.wav';
function setup({ draft = base, invoke, providers = [provider], documents = [], asset, save } = {}) {
  const document = { createElement: tag => new Element(tag, document) }, host = document.createElement('body'), calls = [], changes = [];
  const api = { invoke: async (action, payload) => {
    calls.push({ action, payload });
    const custom = await invoke?.(action, payload); if (custom !== undefined) return custom;
    if (action === 'connect') return { ok: true, result: { connected: true } };
    if (action === 'music_state') return { ok: true, result: { providers } };
    if (action === 'music_catalog') return { ok: true, result: { documents: documents.filter(value => value.kind === payload.kind) } };
    if (action === 'generate_song') return { ok: true, result: { document: job } };
    if (action === 'music_export') return { ok: true, result: { document: { data: { audio: 'd'.repeat(64) } } } };
    return { ok: true, result: {} };
  }, asset: asset || (async id => ({ ok: true, result: { url: grantUrl(id), asset_id: id } })), save: save || (async () => ({ ok: true, result: { saved: true } })) };
  const view = create(host, { api, draft, pollMs: 0, onDraftChange: value => changes.push(value) });
  return { host, view, calls, changes, get: id => all(host).find(value => value.id === id), button: label => all(host).find(value => value.tagName === 'button' && value.textContent === label),
    async click(label) { this.button(label).listeners.click(); await tick(); },
    type(id, value) { const field = this.get(id); field.value = value; field.listeners.input?.(); },
    async submit() { await all(host).find(value => value.tagName === 'form').listeners.submit({ preventDefault() {} }); },
  };
}

test('Simple and Custom preserve the selected provider, lyrics and creative contract without permissions', () => {
  const custom = buildSongRequest(base, provider);
  assert.equal(custom.lyrics, base.lyrics); assert.equal(custom.request.style, 'Acoustic, Reflective'); assert.equal(custom.request.private, false);
  assert.deepEqual(Object.keys(custom), ['title', 'lyrics', 'request']);
  assert.equal(custom.request.model, 'MODEL-A'); assert.equal(custom.request.composition_id, undefined); assert.equal(custom.request.rights, undefined);
  const simple = buildSongRequest({ ...base, mode: 'simple', title: '', description: 'A hopeful song about starting again.' }, provider);
  assert.equal(simple.title, 'New song'); assert.equal(simple.lyrics, ''); assert.equal(simple.request.song_description, 'A hopeful song about starting again.');
  assert.throws(() => buildSongRequest({ ...base, model: 'invented' }, provider), /currently offered/);
  assert.throws(() => buildSongRequest(base, { ...provider, configured: false, status: 'No account configured' }), /No account/);
  assert.throws(() => buildSongRequest({ ...base, mode: 'simple' }, { ...provider, capabilities: {} }), /Custom lyrics/);
  assert.throws(() => buildSongRequest({ ...base, instrumental: true }, { ...provider, capabilities: {} }), /instrumental support/);
});

test('provider choices use only bounded observed records and do not manufacture configuration', () => {
  const result = normalizeProviders([provider, provider, { id: 'bad\nvalue' }, { id: 'unconfigured', name: '<img onerror=x>', models: ['unsafe\nmodel', 'EXACT', 'EXACT'] }]);
  assert.equal(result.length, 2); assert.equal(result[1].configured, false); assert.equal(result[1].external, true);
  assert.deepEqual(result[1].models, ['EXACT']); assert.equal(result[1].name, '<img onerror=x>');
});

test('opening connects safely and discovers choices without generation; saved provider/model remain selected', async () => {
  const v = setup({ draft: { ...base, model: 'MODEL-B' } }); await v.view.ready;
  assert.equal(v.calls[0].action, 'connect'); assert.equal(v.calls[1].action, 'music_state');
  assert.equal(v.get('music-model').value, 'MODEL-B'); assert.equal(v.get('music-custom').attributes['aria-selected'], 'true');
  assert.equal(v.get('music-lyrics').value, base.lyrics); assert.equal(v.calls.some(call => call.action === 'generate_song'), false);
  assert.match(v.host.textContent, /sends your song to this provider/); v.view.dispose();
});
test('an unbound vocal provider is not silently replaced by a configured instrumental engine', async () => {
  const local = { ...provider, id: 'instrumental-engine', external: false, capabilities: { instrumental: true, custom: true } };
  const cloud = { ...provider, configured: false, status: 'Connect your music account' };
  const v = setup({ draft: {}, providers: [local, cloud] }); await v.view.ready;
  assert.equal(v.get('music-provider').value, cloud.id); assert.equal(v.get('music-generate').disabled, true);
  assert.match(v.host.textContent, /Connect your music account/); assert.equal(v.calls.some(call => call.action === 'generate_song'), false); v.view.dispose();
  const chosen = setup({ draft: { ...base, provider: local.id, instrumental: true }, providers: [local, cloud] }); await chosen.view.ready;
  assert.equal(chosen.get('music-provider').value, local.id); chosen.view.dispose();
});

test('one generation submits the complete reviewed input once and retains the editable draft', async () => {
  const v = setup(); await v.view.ready; await v.submit();
  const calls = v.calls.filter(call => call.action === 'generate_song'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload, buildSongRequest({ ...base }, provider));
  assert.equal(v.get('music-lyrics').value, base.lyrics); assert.equal(v.view.getDraft().submission_pending, false);
  assert.equal(v.calls.some(call => ['music_document', 'music_generate'].includes(call.action)), false); v.view.dispose();
});

test('native refusal keeps the draft and does not retry or create documents from the renderer', async () => {
  const v = setup({ invoke: action => action === 'generate_song' ? { ok: false, error: { code: 'USER_DECLINED', message: 'You declined this generation.' } } : undefined });
  await v.view.ready; await v.submit(); await tick();
  assert.equal(v.calls.filter(call => call.action === 'generate_song').length, 1); assert.equal(v.view.getDraft().lyrics, base.lyrics);
  assert.equal(v.get('music-generate').disabled, false); assert.match(v.get('music-status').textContent, /declined/); v.view.dispose();
});

test('an unknown dispatch outcome blocks another generation and remains blocked across view recreation', async () => {
  const v = setup({ invoke: action => action === 'generate_song' ? { ok: false, error: { code: 'SERVICE_OUTCOME_UNCERTAIN', message: 'The saved outcome is unknown.', recovery: { composition_id: 'e'.repeat(32), token: 'do-not-render' } } } : undefined });
  await v.view.ready; await v.submit(); await v.submit(); await v.view.refresh();
  assert.equal(v.calls.filter(call => call.action === 'generate_song').length, 1); assert.equal(v.get('music-generate').disabled, true);
  assert.match(v.get('music-status').textContent, /composition: e{32}/); assert.doesNotMatch(v.host.textContent, /do-not-render/);
  const retained = v.view.getDraft(); v.view.dispose();
  const reopened = setup({ draft: retained }); await reopened.view.ready; await reopened.submit();
  assert.equal(reopened.get('music-generate').disabled, true); assert.equal(reopened.calls.some(call => call.action === 'generate_song'), false); reopened.view.dispose();
});

test('unavailable provider or model is preserved and cannot silently switch to another resource', async () => {
  const absent = setup({ draft: { ...base, provider: 'missing-provider' } }); await absent.view.ready;
  assert.equal(absent.get('music-provider').value, 'missing-provider'); assert.equal(absent.get('music-generate').disabled, true); await absent.submit();
  assert.equal(absent.calls.some(call => call.action === 'generate_song'), false); absent.view.dispose();
  const model = setup({ draft: { ...base, model: 'MODEL-MISSING' } }); await model.view.ready; await model.submit();
  assert.equal(model.get('music-model').value, 'MODEL-MISSING'); assert.equal(model.calls.some(call => call.action === 'generate_song'), false); model.view.dispose();
});

test('offline discovery preserves text, shows the real connection error and disables generation', async () => {
  const v = setup({ invoke: action => action === 'connect' ? { ok: false, error: { code: 'MUSIC_NOT_READY', message: 'Previous jobs need review before startup.' } } : undefined }); await v.view.ready;
  assert.equal(v.view.getDraft().lyrics, base.lyrics); assert.match(v.get('music-readiness').textContent, /Previous jobs need review/);
  assert.equal(v.get('music-generate').disabled, true); assert.equal(v.calls.length, 1); v.view.dispose();
});

test('draft preparation is inert; tabs and suggestions preserve both writing modes', async () => {
  const v = setup(); await v.view.ready;
  assert.deepEqual(v.view.prepareDraft({ title: '<script>inert</script>', lyrics: 'My exact words\n', tags: ['Country', 'not-a-choice'] }), { prepared: true, submitted: false });
  assert.equal(v.view.getDraft().lyrics, 'My exact words\n'); assert.deepEqual(v.view.getDraft().tags, ['Country']);
  await v.click('Simple'); v.type('music-description', 'A quiet morning'); await v.click('Custom');
  assert.equal(v.get('music-lyrics').value, 'My exact words\n'); assert.equal(v.get('music-description').value, 'A quiet morning');
  await v.click('Mood'); await v.click('Uplifting'); assert.ok(v.view.getDraft().tags.includes('Uplifting')); assert.equal(v.get('music-style').value, base.style);
  assert.equal(v.calls.some(call => call.action === 'generate_song'), false); v.view.dispose();
});

test('Franklin preparation respects explicit Simple mode and unavailable resource choices after discovery', async () => {
  const v = setup(); await v.view.ready;
  v.view.prepareDraft({ mode: 'simple', description: 'A sunrise drive', lyrics: 'Retained Custom words', provider: 'not-connected', model: 'requested-model' });
  assert.equal(v.view.getDraft().mode, 'simple'); assert.equal(v.view.getDraft().provider, 'not-connected');
  assert.equal(v.view.getDraft().model, 'requested-model'); assert.equal(v.get('music-generate').disabled, true);
  assert.equal(v.calls.some(call => call.action === 'generate_song'), false); v.view.dispose();
});

test('saved audio uses only the host asset scheme, survives refresh, and pauses on disposal', async () => {
  const saves = [], v = setup({ documents: [variant], save: async value => { saves.push(value); return { ok: true, result: {} }; } }); await v.view.ready;
  await v.click('Listen'); const audio = all(v.host).find(value => value.tagName === 'audio'); assert.ok(audio);
  assert.equal(audio.src, grantUrl(variant.data.audio)); await v.view.refresh(); assert.equal(all(v.host).find(value => value.tagName === 'audio'), audio);
  await v.click('Save audio'); await v.click('Export'); assert.deepEqual(saves, [variant.data.audio, 'd'.repeat(64)]);
  assert.deepEqual(v.calls.find(call => call.action === 'music_export').payload, { variant_ids: [variant.id] });
  v.view.dispose(); assert.equal(audio.paused, true);
});

test('a provider-supplied URL cannot become an audio source', async () => {
  const v = setup({ documents: [variant], asset: async () => ({ ok: true, result: { url: 'https://provider.invalid/private-audio' } }) }); await v.view.ready; await v.click('Listen');
  assert.equal(all(v.host).some(value => value.tagName === 'audio'), false); assert.match(v.get('music-status').textContent, /not available/); v.view.dispose();
});

test('Listen reacquires the selected hash grant for A to B to A and removes revoked inactive players', async () => {
  const other = { ...variant, id: 'e'.repeat(32), data: { ...variant.data, audio: 'f'.repeat(64) } }, grants = [];
  const v = setup({ documents: [variant, other], asset: async id => { grants.push(id); return { ok: true, result: { url: grantUrl(id), asset_id: id } }; } }); await v.view.ready;
  const listen = all(v.host).filter(value => value.tagName === 'button' && value.textContent === 'Listen');
  listen[0].listeners.click(); await tick(); const first = all(v.host).find(value => value.tagName === 'audio');
  listen[1].listeners.click(); await tick(); assert.equal(first.paused, true); assert.equal(all(v.host).filter(value => value.tagName === 'audio').length, 1);
  listen[0].listeners.click(); await tick(); assert.deepEqual(grants, [variant.data.audio, other.data.audio, variant.data.audio]);
  assert.equal(all(v.host).find(value => value.tagName === 'audio').src, grantUrl(variant.data.audio));
  await v.view.refresh(); assert.equal(grants.length, 3); v.view.dispose();
});

test('audio grants must contain the selected content hash and admitted extension', async () => {
  for (const url of [grantUrl('f'.repeat(64)), grantUrl(variant.data.audio).replace('.wav', '.html'), 'yur-music://asset/' + variant.data.audio]) {
    const v = setup({ documents: [variant], asset: async () => ({ ok: true, result: { url } }) }); await v.view.ready; await v.click('Listen');
    assert.equal(all(v.host).some(value => value.tagName === 'audio'), false); v.view.dispose();
  }
});

test('queued cancellation and saved-task retrieval use exact job IDs and never resubmit generation', async () => {
  const queued = setup({ documents: [job] }); await queued.view.ready; await queued.click('Cancel');
  assert.deepEqual(queued.calls.find(call => call.action === 'music_cancel').payload, { job_id: job.id }); queued.view.dispose();
  const resumed = setup({ documents: [{ ...job, data: { state: 'needs_review', request: { provider: 'suno-api' }, provider_receipts: [{ task_id: 'already-submitted' }] } }] }); await resumed.view.ready; await resumed.click('Retrieve saved takes');
  assert.deepEqual(resumed.calls.find(call => call.action === 'music_resume').payload, { job_id: job.id });
  assert.equal(resumed.calls.some(call => call.action === 'generate_song'), false); resumed.view.dispose();
});
