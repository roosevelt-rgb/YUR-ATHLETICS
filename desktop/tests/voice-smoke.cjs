'use strict';

// Genuine offline Vosk + native audio pipeline, using only a prerecorded WAV.
// Fake devices replace physical microphones/cameras; mute-audio prevents output.
// Permission UI is NOT bypassed: no use-fake-ui-for-media-stream switch is used.
const { app, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');

const wav = process.env.YUR_TEST_VOICE_WAV || '';
if (!path.isAbsolute(wav) || !fs.statSync(wav).isFile()) throw new Error('Set YUR_TEST_VOICE_WAV to the approved prerecorded 16 kHz mono WAV.');
const recording = fs.readFileSync(wav);
assert.equal(recording.toString('ascii', 0, 4), 'RIFF'); assert.equal(recording.toString('ascii', 8, 12), 'WAVE');
let format, pcm;
for (let offset = 12; offset + 8 <= recording.length;) {
  const kind = recording.toString('ascii', offset, offset + 4), length = recording.readUInt32LE(offset + 4), start = offset + 8;
  assert.ok(start + length <= recording.length);
  if (kind === 'fmt ') format = { encoding: recording.readUInt16LE(start), channels: recording.readUInt16LE(start + 2), rate: recording.readUInt32LE(start + 4), bits: recording.readUInt16LE(start + 14) };
  if (kind === 'data') pcm = recording.subarray(start, start + length);
  offset = start + length + (length % 2);
}
assert.deepEqual(format, { encoding: 1, channels: 1, rate: 16000, bits: 16 }); assert.ok(pcm?.length > 16000 && pcm.length <= 32000 * 60);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-voice-smoke-'));
app.setPath('userData', path.join(home, 'electron'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav); app.commandLine.appendSwitch('mute-audio');
process.env.APPDATA = path.join(home, 'appdata'); process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot'); process.env.YUR_WORKFORCE_ROOT = path.join(home, 'unused-workforce');

const checks = [], errors = [], modelRequests = [], transcriptions = [], screenshots = [];
let testWindow, origin, finished = false, permissionFrame;
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (executable, args, options) {
  const child = originalSpawn(executable, args, options);
  if (Array.isArray(args) && args.includes('foundry.voice')) {
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = function (chunk, ...rest) {
      const request = JSON.parse(String(chunk));
      if (request.command === 'transcribe') {
        const audio = Buffer.from(request.request.pcm_base64, 'base64');
        const observation = { request_id: request.request.request_id, audio_bytes: audio.length, audio_sha256: createHash('sha256').update(audio).digest('hex') };
        // Observe actual track states at ingress without changing capture/IPC.
        observation.releaseCheck = testWindow.webContents.executeJavaScript('(window.__voiceTestTracks || []).every(track => track.readyState === "ended")');
        let response = ''; child.stdout.on('data', value => { response += value.toString(); });
        child.on('close', () => { try { observation.response = JSON.parse(response); } catch { observation.response = null; } });
        transcriptions.push(observation);
      }
      return end(chunk, ...rest);
    };
  }
  return child;
};
const fixture = http.createServer((req, res) => {
  const reply = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/api/health') return reply({ fixture: true });
  if (req.url === '/api/models') return reply({ models: [{ name: 'voice-fixture' }] });
  if (req.url === '/api/tags') return reply({ models: [] });
  if (req.method === 'POST' && req.url === '/api/ask') {
    let body = ''; req.on('data', value => { body += value; }); return req.on('end', () => { modelRequests.push(JSON.parse(body)); reply({ answer: 'Reviewed dictated text received.', provider: 'loopback-model-fixture', model: 'voice-fixture' }); });
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Remote permission fixture</title><p>Unprivileged browser fixture</p>');
});
async function waitFor(predicate, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('Timed out: ' + label);
}
async function capture(contents, label) {
  try { const image = await contents.capturePage(undefined, { stayHidden: true }); const target = path.join(home, label + '.png'); fs.writeFileSync(target, image.toPNG()); screenshots.push(target); }
  catch (error) { screenshots.push({ label, limitation: error.message }); }
}
const mediaRequest = constraints => `(async()=>{try {const stream=await navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)});const result={allowed:true,kinds:stream.getTracks().map(track=>track.kind),labels:stream.getTracks().map(track=>track.label)};stream.getTracks().forEach(track=>track.stop());return result;}catch(error){return {allowed:false,name:error.name,message:error.message};}})()`;

async function run(window) {
  const contents = window.webContents, evaluate = code => contents.executeJavaScript(code, true);
  const waitUi = (expression, label, timeout) => waitFor(() => evaluate(expression), label, timeout);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await waitUi('Boolean(window.studio?.voice && window.yurVoiceView && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)', 'voice runtime');
  const info = await evaluate('studio.voice.info()'); assert.equal(info.ok, true); assert.equal(info.result.ready, true); assert.equal(info.result.local, true);
  assert.equal(info.result.sample_rate, 16000);
  assert.equal((await evaluate(mediaRequest({ audio: true, video: false }))).allowed, false, 'Unarmed requests must be denied.');
  assert.equal((await evaluate('studio.voice.arm()')).ok, true);
  assert.equal((await evaluate(mediaRequest({ audio: true, video: true }))).allowed, false, 'Video remains denied after audio arm.');
  const audio = await evaluate(mediaRequest({ audio: true, video: false })); assert.equal(audio.allowed, true, JSON.stringify(audio)); assert.deepEqual(audio.kinds, ['audio']);
  assert.ok(audio.labels.every(label => /fake/i.test(label)), 'Only a Chromium fake audio device may be acquired.');
  await evaluate('studio.voice.release()');
  assert.equal((await evaluate(mediaRequest({ audio: true, video: false }))).allowed, false, 'Released requests must be denied.');
  checks.push({ name: 'Unarmed/released audio and armed video denied; armed trusted-main audio uses fake device only', info: info.result, fake_device_labels: audio.labels });

  await evaluate('studio.voice.arm()');
  await evaluate(`window.__voiceSubframe = null; window.addEventListener('message', event=>{if(event.data?.type==='voice-permission-probe' && event.source===document.getElementById('voice-permission-frame')?.contentWindow) window.__voiceSubframe=event.data;});
    const frame=document.createElement('iframe');frame.id='voice-permission-frame';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.srcdoc=${JSON.stringify('<script>navigator.mediaDevices.getUserMedia({audio:true,video:false}).then(stream=>{stream.getTracks().forEach(track=>track.stop());parent.postMessage({type:"voice-permission-probe",allowed:true},"*")}).catch(error=>parent.postMessage({type:"voice-permission-probe",allowed:false,name:error.name},"*"));</script>')};document.body.appendChild(frame);`);
  const subframe = await waitFor(() => evaluate('window.__voiceSubframe'), 'subframe permission denial'); assert.equal(subframe.allowed, false);
  await evaluate('document.getElementById("voice-permission-frame").remove()');
  const navigation = await evaluate(`studio.browser.navigate(${JSON.stringify(`${origin}/remote`)})`); assert.equal(navigation.ok, true);
  permissionFrame = webContents.getAllWebContents().find(candidate => candidate !== contents && candidate.getURL() === `${origin}/remote`); assert.ok(permissionFrame);
  const remote = await permissionFrame.executeJavaScript(mediaRequest({ audio: true, video: false }), true); assert.equal(remote.allowed, false);
  assert.equal(await permissionFrame.executeJavaScript('typeof window.studio'), 'undefined');
  await evaluate('studio.voice.release()');
  checks.push({ name: 'Armed grant never extends to subframes or isolated remote browser', subframe, remote });

  // Passthrough observation: the real getUserMedia and real audio graph remain.
  await evaluate(`window.__voiceTestTracks=[];const originalMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await originalMedia(constraints);window.__voiceTestTracks.push(...stream.getTracks());return stream;};void 0;`);
  await waitUi('!document.getElementById("yc-dictation-toggle").classList.contains("yc-hidden") && !document.getElementById("yc-dictation-toggle").disabled', 'ready dictation button');
  await click('yc-dictation-toggle');
  await waitUi('document.getElementById("yc-dictation-label").textContent.includes("Listening locally")', 'real fake-device recording');
  assert.equal(await evaluate('document.getElementById("yc-send").disabled'), true);
  await waitUi('document.getElementById("yc-dictation-label").textContent.includes("· 8 /")', 'eight seconds of actual PCM', 15000);
  await click('yc-dictation-stop');
  await waitUi('!document.getElementById("yc-send").disabled && document.getElementById("yc-input").value.trim().length>0', 'real offline transcript into draft', 40000);
  const transcript = await evaluate('document.getElementById("yc-input").value');
  assert.ok(transcript.includes('one zero zero zero one'), 'The real recognizer must recover the stable phrase from the approved recording: ' + transcript);
  assert.equal(modelRequests.length, 0); assert.equal(await evaluate('document.querySelectorAll(".yc-message.user").length'), 0);
  assert.equal(transcriptions.length, 1); assert.equal(await transcriptions[0].releaseCheck, true);
  await waitFor(() => transcriptions[0].response, 'recognizer process result');
  const recognized = transcriptions[0].response; assert.equal(recognized.ok, true); assert.equal(recognized.result.local, true); assert.equal(recognized.result.audio_retained, false);
  assert.equal(recognized.result.audio_sha256, transcriptions[0].audio_sha256); assert.equal(recognized.result.samples * 2, transcriptions[0].audio_bytes);
  assert.ok(recognized.result.seconds >= 8 && recognized.result.seconds <= 10);
  checks.push({ name: 'Real PCM capture → checked local Vosk model → editable unsent draft; all tracks stopped before transcription', transcript, result: recognized.result });
  await capture(contents, 'voice-draft');

  const reviewed = 'Reviewed dictation: ' + transcript;
  await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(reviewed)};document.getElementById('yc-input').dispatchEvent(new Event('input'));document.getElementById('yc-form').requestSubmit()`);
  await waitUi('Boolean(document.querySelector(".yc-message.assistant")) && !document.getElementById("yc-send").disabled', 'explicit Send answer');
  assert.equal(modelRequests.length, 1); assert.ok(modelRequests[0].query.includes(reviewed));
  const journal = await evaluate('studio.conversations.list()'); assert.equal(journal.ok, true);
  const message = journal.result.conversations.flatMap(item => item.messages).find(item => item.role === 'user'); assert.equal(message.content, reviewed);
  const saved = JSON.stringify(journal); assert.equal(saved.includes('pcm_base64'), false); assert.equal(saved.includes('audio/wav'), false); assert.equal(saved.includes('audio_sha256'), false);
  checks.push({ name: 'Only explicit Send submits reviewed text; CommitService journal contains text and no audio payload' });

  await click('yc-dictation-toggle'); await waitUi('document.getElementById("yc-dictation-label").textContent.includes("Listening locally")', 'cancel recording');
  await click('yc-dictation-cancel'); await waitUi('document.getElementById("yc-dictation-status").classList.contains("yc-hidden")', 'cancel returned idle');
  assert.equal(await evaluate('(window.__voiceTestTracks || []).every(track=>track.readyState==="ended")'), true);
  assert.equal(transcriptions.length, 1); assert.equal(await evaluate('document.getElementById("yc-input").value'), '');
  assert.equal((await evaluate(mediaRequest({ audio: true, video: false }))).allowed, false);
  checks.push({ name: 'Cancel releases fake device, removes grant and never transcribes or alters draft' });

  const voices = await evaluate('speechSynthesis.getVoices().map(voice=>({id:voice.voiceURI,name:voice.name,lang:voice.lang,local:voice.localService,default:voice.default}))');
  const playback = await evaluate(`(()=>{const calls=[];const synthesis={getVoices:()=>[{voiceURI:'local-fixture',name:'Local fixture',lang:'en-US',localService:true,default:true},{voiceURI:'remote-fixture',name:'Remote fixture',lang:'en-US',localService:false}],speak:value=>calls.push(value),cancel:()=>calls.push('cancel'),addEventListener(){},removeEventListener(){}};const reader=yurVoiceView.create({synthesis,Utterance:class{constructor(text){this.text=text;}}});reader.speak('Safe mocked read aloud.',{id:'fixture'});calls[0].onstart();const active=reader.state();reader.stop();const stopped=reader.state();reader.dispose();return {active,stopped,speechCalls:calls.filter(value=>typeof value==='object').length,cancels:calls.filter(value=>value==='cancel').length};})()`);
  assert.equal(playback.active.speaking, true); assert.equal(playback.active.voices.length, 1); assert.equal(playback.stopped.speaking, false); assert.equal(playback.speechCalls, 1); assert.ok(playback.cancels >= 1);
  checks.push({ name: 'Actual platform voice metadata inspected; read-aloud state tested only with silent mocks', platform_voices: voices, mocked_playback: playback });
  await evaluate('studio.voice.arm()');
  const reloaded = new Promise(resolve => contents.once('did-finish-load', resolve)); contents.reload(); await reloaded;
  await waitUi('Boolean(window.studio?.voice && document.getElementById("yc-send") && !document.getElementById("yc-send").disabled)', 'reloaded conversation runtime');
  assert.equal((await evaluate(mediaRequest({ audio: true, video: false }))).allowed, false, 'A reload must not inherit the previous audio grant.');
  const restored = await evaluate('studio.conversations.list()');
  assert.ok(restored.result.conversations.some(item => item.messages.some(message => message.role === 'user' && message.content === reviewed)));
  checks.push({ name: 'Main-frame reload revokes audio grant and restores the reviewed text from the journal' });
  assert.equal(errors.length, 0, JSON.stringify(errors)); await capture(contents, 'voice-final');
}

async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  if (testWindow && !testWindow.isDestroyed()) {
    try { await testWindow.webContents.executeJavaScript('(window.__voiceTestTracks||[]).forEach(track=>track.stop()); studio.voice.release()'); } catch {}
    if (error) await capture(testWindow.webContents, 'failure'); testWindow.destroy();
  }
  childProcess.spawn = originalSpawn;
  await new Promise(resolve => { fixture.closeAllConnections(); fixture.close(resolve); });
  const receipt = path.join(home, 'voice-smoke-result.json');
  fs.writeFileSync(receipt, JSON.stringify({ passed: !error, checks, failure: error ? { message: error.message, stack: error.stack } : null, errors, model_requests: modelRequests.length, transcriptions: transcriptions.map(({ releaseCheck, ...record })=>record), screenshots, fake_device: true, muted: true, fixture_sha256: createHash('sha256').update(recording).digest('hex') }, null, 2));
  console.log(JSON.stringify({ passed: !error, checks: checks.length, receipt, failure: error?.message || null })); app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => finish(new Error('Native voice smoke exceeded 100 seconds.')), 100000);
app.on('browser-window-created', (_event, window) => {
  if (testWindow) return;
  testWindow = window; window.hide(); window.setSkipTaskbar(true); window.webContents.setBackgroundThrottling(false); window.webContents.setAudioMuted(true);
  window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
  window.webContents.on('console-message', detail => { if (detail.level === 3 || detail.level === 'error') errors.push(String(detail.message).slice(0, 400)); });
  window.webContents.once('did-finish-load', () => run(window).then(()=>finish()).catch(finish));
});
fixture.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${fixture.address().port}`; process.env.YUR_FOUNDRY_URL = origin; process.env.YUR_OLLAMA_URL = origin; require('../src/main.js'); });
