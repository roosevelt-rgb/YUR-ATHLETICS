'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { randomUUID, createHash } = require('node:crypto');
const { createVoiceTransport, MAX_AUDIO_BYTES } = require('../src/voice-transport');

const sourceRoot = path.resolve(__dirname, '..');
const modelPath = path.join(sourceRoot, '.desktop-models', 'fixture-model');
const request = (fields = {}) => ({ command: 'transcribe', request: { request_id: randomUUID(), sample_rate: 16000, pcm_base64: Buffer.alloc(320).toString('base64'), ...fields } });
const info = () => ({ ok: true, result: { ready: true, model: 'fixture-model', language: 'en-US', max_seconds: 60, sample_rate: 16000, local: true, setup: '' } });
const resultFor = input => ({ ok: true, result: { request_id: input.request.request_id, text: 'one zero zero zero one', audio_sha256: createHash('sha256').update(Buffer.from(input.request.pcm_base64, 'base64')).digest('hex'), samples: 160, seconds: 0.01, model: 'fixture-model', model_sha256: 'a'.repeat(64), local: true, words: [{ word: 'one', start: 0, end: 0.005, conf: 0.9 }], audio_retained: false } });

function fixture(handler, timeoutMs = 1000) {
  const children = [], calls = [];
  const transport = createVoiceTransport({ sourceRoot, getPython: () => 'fixture-python', getModelPath: () => modelPath, timeoutMs,
    spawnProcess(executable, args, options) {
      const child = new EventEmitter(); let input = '';
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = 0;
      child.kill = () => { child.killed++; queueMicrotask(() => child.emit('close', null)); };
      child.stdin = new Writable({ write(chunk, _encoding, callback) { input += chunk; callback(); }, final(callback) { callback(); queueMicrotask(() => handler?.(child, JSON.parse(input))); } });
      child.reply = (response, exitCode = response.ok ? 0 : 1) => { child.stdout.write(JSON.stringify(response)); child.stdout.end(); child.emit('close', exitCode); };
      calls.push({ executable, args, options }); children.push(child); return child;
    } });
  return { transport, children, calls };
}

test('voice requests reject unknown fields, rates, identifiers, overlong or noncanonical PCM before spawning', async () => {
  const f = fixture();
  const invalid = [null, { command: 'run' }, { command: 'info', model: 'injected' }, { ...request(), authority: {} }, request({ sample_rate: 48000 }), request({ request_id: 'unsafe' }), request({ pcm_base64: '' }), request({ pcm_base64: 'a' }), request({ pcm_base64: 'AAA' }), request({ pcm_base64: Buffer.from([1]).toString('base64') }), request({ pcm_base64: Buffer.alloc(MAX_AUDIO_BYTES + 2).toString('base64') }), request({ extra: 'unknown' })];
  for (const input of invalid) assert.equal((await f.transport.request(input)).ok, false);
  assert.equal(f.children.length, 0); f.transport.dispose();
});

test('fixed local subprocess receives bounded typed request with no shell or inherited provider authority', async () => {
  const f = fixture((child, input) => child.reply(input.command === 'info' ? info() : resultFor(input)));
  const response = await f.transport.request(request(), 'owner'); assert.equal(response.ok, true);
  assert.equal(response.result.local, true); assert.equal(response.result.audio_retained, false);
  assert.equal(f.calls[0].executable, 'fixture-python'); assert.deepEqual(f.calls[0].args, ['-B', '-m', 'foundry.voice']);
  assert.equal(f.calls[0].options.shell, false); assert.equal(f.calls[0].options.windowsHide, true); assert.equal(f.calls[0].options.cwd, sourceRoot);
  assert.equal(f.calls[0].options.env.YUR_VOICE_MODEL, modelPath); assert.equal(f.calls[0].options.env.PYTHONNOUSERSITE, '1');
  assert.equal(f.calls[0].options.env.PYTHONPATH, undefined);
  assert.ok(Object.keys(f.calls[0].options.env).every(key => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PYTHONIOENCODING|PYTHONUTF8|PYTHONNOUSERSITE|YUR_VOICE_MODEL)$/i.test(key)));
  assert.equal((await f.transport.request({ command: 'info' })).result.ready, true); f.transport.dispose();
});

test('reply identity, local provenance, no-retention and PCM duration must match the accepted request', async () => {
  const modifications = [
    value => { value.result = {}; }, value => { value.result.request_id = randomUUID(); },
    value => { value.result.local = false; }, value => { value.result.audio_retained = true; },
    value => { value.result.text = 'x'.repeat(16001); }, value => { value.result.audio_sha256 = 'wrong'; },
    value => { value.result.audio_sha256 = 'f'.repeat(64); }, value => { value.result.model_sha256 = 'bad'; },
    value => { value.result.samples++; }, value => { value.result.seconds = 61; },
    value => { value.result.words = Array(4001).fill({}); },
  ];
  for (const mutate of modifications) {
    const f = fixture((child, input) => { const response = resultFor(input); mutate(response); child.reply(response); });
    assert.equal((await f.transport.request(request())).ok, false, mutate.toString()); f.transport.dispose();
  }
  const f = fixture(child => child.reply({ ok: true, result: { ready: true, local: false } }));
  assert.equal((await f.transport.request({ command: 'info' })).ok, false); f.transport.dispose();
});

test('only request owner can cancel, cancellation terminates child and late results cannot succeed', async () => {
  const f = fixture(); const input = request(), pending = f.transport.request(input, 'A');
  assert.equal(f.transport.cancel(input.request.request_id, 'B').result.cancelled, false); assert.equal(f.children[0].killed, 0);
  assert.equal(f.transport.cancel(input.request.request_id, 'A').result.cancelled, true);
  assert.equal((await pending).error.code, 'CANCELLED'); assert.equal(f.children[0].killed, 1);
  f.children[0].reply(resultFor(input)); assert.equal(f.transport.cancel(input.request.request_id, 'A').result.cancelled, false); f.transport.dispose();
});

test('duplicate and concurrency limits isolate owners, then slots recover after disposal', async () => {
  const f = fixture(); const first = request(), second = request();
  const a = f.transport.request(first, 'A'), b = f.transport.request(second, 'B');
  assert.equal((await f.transport.request(first, 'A')).ok, false); assert.equal((await f.transport.request(request(), 'C')).ok, false);
  f.transport.cancelOwner('A'); assert.equal((await a).error.code, 'CANCELLED'); assert.equal(f.children[1].killed, 0);
  f.transport.dispose(); assert.equal((await b).error.code, 'CANCELLED'); assert.equal(f.children[1].killed, 1);
});

test('timeouts, oversized stdout/stderr, malformed responses and failing exits are contained', async () => {
  const timed = fixture(undefined, 10); const timeout = await timed.transport.request(request());
  assert.equal(timeout.error.code, 'VOICE_TIMEOUT'); assert.equal(timed.children[0].killed, 1);
  for (const channel of ['stdout', 'stderr']) {
    const f = fixture(child => child[channel].write('x'.repeat(channel === 'stdout' ? 256 * 1024 + 1 : 64 * 1024 + 1)));
    assert.equal((await f.transport.request(request())).error.code, 'VOICE_LIMIT'); assert.equal(f.children[0].killed, 1); f.transport.dispose();
  }
  for (const handler of [child => { child.stdout.write('{bad'); child.emit('close', 0); }, (child, input) => child.reply(resultFor(input), 1), child => child.emit('error', new Error('Private diagnostic must not reach UI'))]) {
    const f = fixture(handler); const result = await f.transport.request(request()); assert.equal(result.ok, false);
    assert.equal(result.error.message.includes('Private diagnostic'), false); f.transport.dispose();
  }
});
