'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const MAX_AUDIO_BYTES = 16000 * 2 * 60;
const fail = (code, message) => ({ ok: false, error: { code, message } });
function createVoiceTransport({ sourceRoot, getPython, getModelPath, timeoutMs = 30000, spawnProcess = spawn }) {
  if (!path.isAbsolute(sourceRoot) || typeof getPython !== 'function' || typeof getModelPath !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Voice runtime requires explicit host configuration.');
  const active = new Map();
  function request(payload, owner = null) {
    let encoded, id;
    try {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid voice request.');
      if (payload.command === 'info') { if (Object.keys(payload).join(',') !== 'command') throw new Error('Invalid voice info.'); id = crypto.randomUUID(); }
      else if (payload.command === 'transcribe') {
        const audio = payload.request;
        if (Object.keys(payload).sort().join(',') !== 'command,request' || !audio || Object.keys(audio).sort().join(',') !== 'pcm_base64,request_id,sample_rate' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(audio.request_id) || audio.sample_rate !== 16000 || typeof audio.pcm_base64 !== 'string' || !audio.pcm_base64.length || audio.pcm_base64.length > MAX_AUDIO_BYTES * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.pcm_base64)) throw new Error('Dictation requires up to 60 seconds of mono 16 kHz PCM.');
        const bytes = Buffer.from(audio.pcm_base64, 'base64');
        if (!bytes.length || bytes.length % 2 || bytes.length > MAX_AUDIO_BYTES || bytes.toString('base64') !== audio.pcm_base64) throw new Error('Invalid PCM encoding.');
        id = audio.request_id;
      } else throw new Error('Unsupported voice operation.');
      encoded = JSON.stringify(payload);
      if (active.has(id) || active.size >= 2) throw new Error('Voice processing is busy.');
    } catch (error) { return Promise.resolve(fail('INVALID_REQUEST', error.message)); }
    return new Promise(resolve => {
      let child, timer, output = '', size = 0, diagnosticBytes = 0, ended = false;
      const expectedAudio = payload.command === 'transcribe' ? Buffer.from(payload.request.pcm_base64, 'base64') : null;
      const checkedResponse = value => {
        if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') return false;
        if (!value.ok) return value.error && typeof value.error.code === 'string' && value.error.code.length <= 80 && typeof value.error.message === 'string' && value.error.message.length <= 1000;
        const result = value.result;
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.local !== true || typeof result.model !== 'string' || !result.model || result.model.length > 256) return false;
        if (payload.command === 'info') return typeof result.ready === 'boolean' && result.language === 'en-US' && result.max_seconds === 60 && result.sample_rate === 16000 && typeof result.setup === 'string' && result.setup.length <= 1000;
        return result.request_id === id && result.audio_retained === false && typeof result.text === 'string' && result.text.length <= 16000 &&
          result.audio_sha256 === crypto.createHash('sha256').update(expectedAudio).digest('hex') && /^[0-9a-f]{64}$/.test(result.model_sha256) &&
          result.samples === expectedAudio.length / 2 && result.seconds === expectedAudio.length / 32000 && Array.isArray(result.words) && result.words.length <= 4000 &&
          result.words.every(word => word && Object.keys(word).sort().join(',') === 'conf,end,start,word' && typeof word.word === 'string' && word.word.length <= 200 &&
            Number.isFinite(word.conf) && word.conf >= 0 && word.conf <= 1 && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start && word.end <= result.seconds + 0.2);
      };
      const finish = result => { if (ended) return; ended = true; clearTimeout(timer); active.delete(id); resolve(result); };
      const stop = result => { child?.kill(); finish(result); };
      try {
        const allowed = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.includes(key.toUpperCase())));
        Object.assign(environment, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', YUR_VOICE_MODEL: getModelPath() });
        child = spawnProcess(getPython(), ['-B', '-m', 'foundry.voice'], { cwd: sourceRoot, env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        active.set(id, { owner, stop });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 256 * 1024) stop(fail('VOICE_LIMIT', 'Voice output exceeded its limit.')); else output += chunk; });
        child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 64 * 1024) stop(fail('VOICE_LIMIT', 'Voice diagnostics exceeded their limit.')); });
        child.on('error', () => finish(fail('VOICE_UNAVAILABLE', 'The configured voice runtime could not start.')));
        child.on('close', code => {
          if (ended) return;
          try { const value = JSON.parse(output); if (!checkedResponse(value) || (value.ok && code !== 0)) throw new Error(); finish(value); }
          catch { finish(fail('VOICE_FAILED', 'Voice runtime returned an invalid result.')); }
        });
        child.stdin.on('error', () => stop(fail('VOICE_FAILED', 'Voice input could not be delivered.')));
        timer = setTimeout(() => stop(fail('VOICE_TIMEOUT', 'Offline transcription exceeded its time limit.')), timeoutMs);
        child.stdin.end(encoded);
      } catch (error) { stop(fail('VOICE_FAILED', error.message)); }
    });
  }
  function cancel(id, owner = null) { const operation = active.get(id); if (operation?.owner === owner) operation.stop(fail('CANCELLED', 'Dictation cancelled.')); return { ok: true, result: { cancelled: Boolean(operation?.owner === owner) } }; }
  function cancelOwner(owner) { for (const [id, operation] of active) if (operation.owner === owner) cancel(id, owner); }
  function dispose() { for (const operation of active.values()) operation.stop(fail('CANCELLED', 'Voice runtime closed.')); }
  return { request, cancel, cancelOwner, dispose };
}
module.exports = { createVoiceTransport, MAX_AUDIO_BYTES };
