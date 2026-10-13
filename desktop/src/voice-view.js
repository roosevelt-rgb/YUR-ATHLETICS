/* Explicit read-aloud through available platform voices. No recording service. */
'use strict';
(() => {
  function splitText(value) {
    const chunks = [];
    let remaining = value.trim();
    while (remaining) {
      let end = Math.min(1200, remaining.length);
      if (end < remaining.length) {
        const boundary = Math.max(remaining.lastIndexOf('. ', end), remaining.lastIndexOf('\n', end), remaining.lastIndexOf(' ', end));
        if (boundary > 600) end = boundary + 1;
        if (end > 0 && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      }
      chunks.push(remaining.slice(0, end)); remaining = remaining.slice(end).trimStart();
    }
    return chunks;
  }
  function create({ synthesis = window.speechSynthesis, Utterance = window.SpeechSynthesisUtterance, onState = () => {}, onError = () => {} } = {}) {
    let availableVoices = [], activeId = null, speaking = false, pending = false, generation = 0, disposed = false;
    let activeUtterance = null;
    const supported = Boolean(synthesis && typeof Utterance === 'function' && typeof synthesis.getVoices === 'function');
    function state() {
      return { supported, available: supported && availableVoices.length > 0, active_id: activeId, speaking, pending,
        voices: availableVoices.map(voice => ({ id: voice.voiceURI, name: voice.name, lang: voice.lang, local: voice.localService === true, default: voice.default === true })) };
    }
    function emit() { if (!disposed) onState(state()); }
    function refresh() {
      try { availableVoices = supported ? synthesis.getVoices().filter(voice => voice.localService === true) : []; }
      catch { availableVoices = []; }
      emit(); return state();
    }
    function stop() {
      generation++; activeUtterance = null;
      const active = activeId !== null; activeId = null; speaking = false; pending = false;
      if (active && supported) synthesis.cancel();
      emit();
    }
    function speak(value, { id = 'read-aloud', voiceId = null, rate = 1 } = {}) {
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error('Choose a read-aloud speed between 0.5 and 2.');
      if (disposed) throw new Error('Read-aloud is closed.');
      if (typeof value !== 'string' || !value.trim()) throw new Error('There is no text to read.');
      if (value.length > 100000) throw new Error('This text exceeds the read-aloud limit. Read a shorter message.');
      refresh();
      if (!state().available) throw new Error('No local read-aloud voices are available on this machine.');
      const voice = voiceId ? availableVoices.find(item => item.voiceURI === voiceId) : availableVoices.find(item => item.default) || availableVoices[0];
      if (!voice) throw new Error('The selected read-aloud voice is no longer available.');
      stop();
      const ticket = generation; const chunks = splitText(value);
      activeId = id; pending = true; emit();
      function next() {
        if (ticket !== generation || disposed) return;
        const chunk = chunks.shift();
        if (!chunk) { activeUtterance = null; activeId = null; speaking = false; pending = false; emit(); return; }
        const utterance = new Utterance(chunk); activeUtterance = utterance;
        utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = rate;
        utterance.onstart = () => { if (ticket === generation) { pending = false; speaking = true; emit(); } };
        utterance.onend = () => { if (ticket === generation) next(); };
        utterance.onerror = event => {
          if (ticket !== generation || disposed) return;
          generation++; activeUtterance = null; activeId = null; speaking = false; pending = false; emit();
          onError('Read-aloud could not continue' + (event.error ? ': ' + event.error : '.') );
        };
        try { synthesis.speak(utterance); }
        catch (error) { utterance.onerror({ error: error.message || 'voice unavailable' }); }
      }
      next(); return state();
    }
    if (supported) synthesis.addEventListener?.('voiceschanged', refresh);
    refresh();
    function dispose() { stop(); disposed = true; synthesis?.removeEventListener?.('voiceschanged', refresh); }
    return Object.freeze({ state, refresh, speak, stop, dispose });
  }
  function createDictation({ api, mediaDevices = window.navigator?.mediaDevices, AudioContext = window.AudioContext, onState = () => {}, onResult = () => {}, onError = () => {}, getTarget = () => null } = {}) {
    let runtime = null, active = null, disposed = false, phase = 'idle';
    const supported = Boolean(api?.voice && mediaDevices?.getUserMedia && AudioContext);
    function state() { return { supported, ready: supported && runtime?.ready === true, phase, seconds: active ? active.samples / 16000 : 0, max_seconds: runtime?.max_seconds || 60, model: runtime?.model || null, language: runtime?.language || null }; }
    function emit() { if (!disposed) onState(state()); }
    async function invoke(fn) { const response = await fn(); if (!response?.ok) throw new Error(response?.error?.message || 'The local dictation request failed.'); return response.result; }
    async function refresh() {
      runtime = supported ? await invoke(() => api.voice.info()) : null;
      if (runtime?.ready && (runtime.local !== true || runtime.sample_rate !== 16000 || !Number.isInteger(runtime.max_seconds) || runtime.max_seconds < 1 || runtime.max_seconds > 60)) throw new Error('The dictation runtime does not match local capture requirements.');
      emit(); return state();
    }
    async function release(op) {
      if (op.releasing) return op.releasing;
      clearTimeout(op.timer);
      if (op.processor) { op.processor.onaudioprocess = null; op.processor.disconnect(); }
      op.source?.disconnect(); op.gain?.disconnect();
      for (const track of op.stream?.getTracks() || []) track.stop();
      op.releasing = (async () => {
        const results = await Promise.allSettled([op.context?.close(), op.armed ? invoke(() => api.voice.release()) : Promise.resolve()]);
        const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      })();
      return op.releasing;
    }
    function finish(op) {
      op.chunks.length = 0;
      if (active === op) { active = null; phase = 'idle'; emit(); }
    }
    async function start() {
      if (disposed || !supported) throw new Error('Local dictation is unavailable in this Desktop.');
      if (active) throw new Error('Finish or cancel the current dictation first.');
      const op = { target: getTarget(), samples: 0, chunks: [], cancelled: false, armed: false };
      active = op; phase = 'arming'; emit();
      try {
        await refresh();
        if (!runtime?.ready) throw new Error('The offline dictation model is unavailable.');
        if (op.cancelled || disposed) return;
        await invoke(() => api.voice.arm()); op.armed = true;
        if (op.cancelled || disposed) return;
        op.stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }, video: false });
        if (op.cancelled || disposed) return;
        op.context = new AudioContext({ sampleRate: 16000 });
        if (op.context.sampleRate !== 16000) throw new Error('This audio device cannot provide the required 16 kHz capture.');
        op.source = op.context.createMediaStreamSource(op.stream);
        op.processor = op.context.createScriptProcessor(4096, 1, 1);
        op.gain = op.context.createGain(); op.gain.gain.value = 0;
        op.processor.onaudioprocess = event => {
          if (active !== op || op.cancelled || phase !== 'recording') return;
          const input = event.inputBuffer.getChannelData(0);
          const length = Math.min(input.length, 16000 * Math.min(60, runtime.max_seconds) - op.samples);
          const pcm = new Uint8Array(length * 2); const view = new DataView(pcm.buffer);
          for (let index = 0; index < length; index++) { const value = Math.max(-1, Math.min(1, input[index])); view.setInt16(index * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true); }
          op.chunks.push(pcm); op.samples += length; emit();
          if (op.samples >= 16000 * Math.min(60, runtime.max_seconds)) stop().catch(error => onError(error.message));
        };
        op.source.connect(op.processor); op.processor.connect(op.gain); op.gain.connect(op.context.destination);
        await op.context.resume();
        if (op.cancelled || disposed) return;
        phase = 'recording'; emit();
        op.timer = setTimeout(() => stop().catch(error => onError(error.message)), Math.min(60, runtime.max_seconds) * 1000);
      } catch (error) { const cancelled = op.cancelled || disposed; op.cancelled = true; if (!cancelled) throw error; }
      finally { if (op.cancelled || disposed) { try { await release(op); } finally { finish(op); } } }
    }
    async function stop() {
      const op = active;
      if (!op || op.stopping) return;
      if (phase !== 'recording') return cancel();
      op.stopping = true; phase = 'transcribing'; emit();
      try {
        await release(op); // Stop every device track before invoking transcription.
        if (op.cancelled || disposed) return;
        if (!op.samples) throw new Error('No audio was captured. Try again.');
        const pcm = new Uint8Array(op.samples * 2); let offset = 0;
        for (const chunk of op.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
        op.chunks.length = 0;
        const parts = [];
        for (let index = 0; index < pcm.length; index += 8192) parts.push(String.fromCharCode(...pcm.subarray(index, index + 8192)));
        const encoded = window.btoa(parts.join(''));
        op.requestId = window.crypto.randomUUID();
        const result = await invoke(() => api.voice.transcribe({ request_id: op.requestId, sample_rate: 16000, pcm_base64: encoded }));
        if (op.cancelled || disposed) return;
        if (result?.local !== true || typeof result.text !== 'string' || !/^[a-f0-9]{64}$/.test(result.audio_sha256 || '')) throw new Error('The local recognizer returned an invalid transcript record.');
        if (!result.text.trim()) throw new Error('No speech was recognized. Nothing was added to your draft.');
        await onResult(result, op.target);
      } catch (error) { if (!op.cancelled && !disposed) throw error; }
      finally { finish(op); }
    }
    async function cancel() {
      const op = active; if (!op) return;
      op.cancelled = true; const wasRecording = phase === 'recording'; phase = 'cancelling'; emit();
      if (wasRecording) { try { await release(op); } finally { finish(op); } }
      else if (op.stream) await release(op);
      else if (op.armed) await invoke(() => api.voice.release());
      if (op.requestId && api.voice.cancel) await invoke(() => api.voice.cancel(op.requestId));
      // Pending permission or transcription operations finish their own cleanup.
    }
    async function dispose() { disposed = true; await cancel(); }
    return Object.freeze({ state, refresh, start, stop, cancel, dispose });
  }
  window.yurVoiceView = Object.freeze({ create, createDictation });
})();
