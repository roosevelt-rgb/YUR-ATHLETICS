'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture(voices = []) {
  const events = new Map(), spoken = [], errors = []; let cancellations = 0;
  const synthesis = { getVoices: () => voices, speak: value => spoken.push(value), cancel: () => cancellations++, addEventListener: (name, cb) => events.set(name, cb), removeEventListener: name => events.delete(name) };
  const sandbox = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/voice-view.js'), 'utf8'), sandbox);
  const controller = sandbox.window.yurVoiceView.create({ synthesis, Utterance: class { constructor(text) { this.text = text; } }, onError: error => errors.push(error) });
  return { controller, spoken, errors, events, get cancellations() { return cancellations; }, setVoices(value) { voices = value; events.get('voiceschanged')?.(); } };
}
const voice = { voiceURI: 'local-fixture', name: 'Fixture voice', lang: 'en-US', localService: true, default: true };

test('saved voice and speech rate affect every spoken chunk and invalid rates do not speak', () => {
  const selected = { ...voice, voiceURI: 'second-voice', default: false };
  const f = fixture([voice, selected]);
  f.controller.speak('A long sentence. '.repeat(200), { voiceId: selected.voiceURI, rate: 1.3 });
  assert.equal(f.spoken[0].voice, selected); assert.equal(f.spoken[0].rate, 1.3);
  f.spoken[0].onend();
  assert.equal(f.spoken[1].voice, selected); assert.equal(f.spoken[1].rate, 1.3);
  for (const rate of [NaN, Infinity, '1', 0.1, 3]) assert.throws(() => f.controller.speak('No', { rate }), /rate|speed/i);
  assert.equal(f.spoken.length, 2);
});

test('read-aloud is available only after actual voice discovery and never starts on discovery', () => {
  const f = fixture();
  assert.equal(f.controller.state().available, false);
  assert.throws(() => f.controller.speak('Hello'), /No local read-aloud voices/);
  f.setVoices([{ ...voice, localService: false }]);
  assert.equal(f.controller.state().available, false);
  f.setVoices([voice]);
  assert.equal(f.controller.state().available, true);
  assert.equal(f.controller.state().voices[0].id, 'local-fixture');
  assert.equal(f.spoken.length, 0);
  f.controller.dispose(); assert.equal(f.events.size, 0);
});

test('explicit speech uses actual voice; stop invalidates remaining chunks and late callbacks', () => {
  const f = fixture([voice]);
  f.controller.speak('A long sentence. '.repeat(200), { id: 'message-1' });
  assert.equal(f.spoken.length, 1); assert.equal(f.spoken[0].voice, voice);
  f.spoken[0].onstart(); assert.equal(f.controller.state().speaking, true);
  const old = f.spoken[0]; f.controller.stop(); old.onend(); old.onerror({ error: 'interrupted' });
  assert.equal(f.cancellations, 1); assert.equal(f.spoken.length, 1); assert.equal(f.errors.length, 0);
  assert.equal(f.controller.state().active_id, null);
});

test('voice errors end the active operation without inventing successful playback', () => {
  const f = fixture([voice]);
  f.controller.speak('Hello', { id: 'message-2' });
  f.spoken[0].onerror({ error: 'audio-busy' });
  assert.equal(f.controller.state().speaking, false); assert.equal(f.controller.state().pending, false);
  assert.equal(f.controller.state().active_id, null); assert.match(f.errors[0], /audio-busy/);
  f.controller.speak('Next'); f.controller.dispose(); f.spoken[1].onend();
  assert.equal(f.spoken.length, 2);
});

function dictationFixture({ pauseResume = false } = {}) {
  const calls = [], results = []; let processor, resolveTranscript, resolveResume;
  const sandbox = { window: { btoa: value => Buffer.from(value, 'binary').toString('base64'), crypto: { randomUUID: () => '88d0dd06-8bcb-48ea-afb6-e5c66e0ee6b3' } }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/voice-view.js'), 'utf8'), sandbox);
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    sampleRate = 16000;
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { processor = node(); return processor; }
    createGain() { return { ...node(), gain: {} }; }
    async resume() { if (pauseResume) await new Promise(resolve => { resolveResume = resolve; }); }
    async close() { calls.push('context closed'); }
  }
  const api = { voice: {
    info: async () => ({ ok: true, result: { ready: true, local: true, sample_rate: 16000, max_seconds: 60 } }),
    arm: async () => { calls.push('armed'); return { ok: true }; },
    release: async () => { calls.push('released'); return { ok: true }; },
    transcribe: request => { calls.push(['transcribe', request]); return new Promise(resolve => { resolveTranscript = resolve; }); },
    cancel: async requestId => { calls.push(['cancel', requestId]); resolveTranscript({ ok: false, error: { code: 'CANCELLED', message: 'Dictation cancelled.' } }); return { ok: true, result: { cancelled: true } }; },
  } };
  const mediaDevices = { getUserMedia: async options => { calls.push(['capture', options]); return { getTracks: () => [{ stop: () => calls.push('track stopped') }] }; } };
  const controller = sandbox.window.yurVoiceView.createDictation({ api, mediaDevices, AudioContext, getTarget: () => ({ conversation_id: 'original', draft: 'Before' }), onResult: (result, target) => results.push({ result, target }) });
  return { controller, calls, results, resume() { resolveResume(); }, capture() { processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([-1, 0, 1, .5]) } }); }, complete() { resolveTranscript({ ok: true, result: { text: 'Recognized words', local: true, audio_sha256: 'a'.repeat(64) } }); } };
}

test('dictation stops device before transcription and retains its original draft target', async () => {
  const f = dictationFixture(); await f.controller.start(); f.capture();
  assert.equal(f.controller.state().phase, 'recording');
  const done = f.controller.stop(); await new Promise(resolve => setImmediate(resolve));
  const sent = f.calls.find(item => Array.isArray(item) && item[0] === 'transcribe');
  assert.ok(f.calls.indexOf('track stopped') < f.calls.indexOf(sent));
  assert.equal(sent[1].sample_rate, 16000);
  assert.deepEqual([...Buffer.from(sent[1].pcm_base64, 'base64')], [0, 128, 0, 0, 255, 127, 0, 64]);
  f.complete(); await done;
  assert.equal(f.results[0].target.conversation_id, 'original');
  assert.equal(f.results[0].target.draft, 'Before');
  assert.equal(f.controller.state().phase, 'idle');
});

test('cancelling dictation discards captured and late transcription data', async () => {
  const f = dictationFixture(); await f.controller.start(); f.capture(); await f.controller.cancel();
  assert.ok(f.calls.includes('track stopped')); assert.equal(f.results.length, 0);
  assert.equal(f.calls.some(item => Array.isArray(item) && item[0] === 'transcribe'), false);
  await f.controller.start(); f.capture(); const done = f.controller.stop(); await new Promise(resolve => setImmediate(resolve));
  await f.controller.cancel(); f.complete(); await done;
  assert.equal(f.calls.some(item => Array.isArray(item) && item[0] === 'cancel'), true);
  assert.equal(f.results.length, 0); assert.equal(f.controller.state().phase, 'idle');
});

test('cancel releases a live microphone even while the audio context is still starting', async () => {
  const f = dictationFixture({ pauseResume: true }); const started = f.controller.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.state().phase, 'arming');
  await f.controller.cancel(); assert.ok(f.calls.includes('track stopped'));
  f.resume(); await started;
  assert.equal(f.controller.state().phase, 'idle'); assert.equal(f.results.length, 0);
});
