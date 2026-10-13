'use strict';
// Actual Electron Music component and audio decoder. All service results below
// are synthetic local fixtures; no Music server, account, model or provider runs.
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url'), { createHash } = require('node:crypto'), assert = require('node:assert/strict');
const source = path.resolve(__dirname, '..');
const evidence = path.resolve(source, '../../evidence/glider-rc6/comprehensive/completion-2026-10-05/music-native');
const attempt = path.join(evidence, 'attempt-' + new Date().toISOString().replace(/[:.]/g, '-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-music-view-'));
fs.mkdirSync(attempt, { recursive: true });
const monitored = ['src/music-view.js', 'src/music.css', 'tests/music-view-native.cjs'];
const fingerprint = () => Object.fromEntries(monitored.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex')]));
const receipt = { started_at: new Date().toISOString(), home, checks: [], source_before: fingerprint(), limitations: [
  'Actual Electron component rendering and audio decoding with synthetic API records; this fixture does not exercise the production main-process service supervisor.',
  'No live provider generation, provider connectivity, charge, external transmission or user-library modification.',
  'Reference workflow is Simple/Custom with style suggestions; screenshots show the isolated native Desktop component.'
] };
const samples = 32000, wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
const assetId = createHash('sha256').update(wave).digest('hex');
const assetUrl = 'yur-music://asset/12345678-1234-4234-8234-123456789abc/' + assetId + '.wav';
const providers = [{ id: 'fixture-music', name: 'Music service fixture', configured: true, external: true, status: 'Isolated test provider — no generation or account charge', models: ['Fixture model'], default_model: 'Fixture model', capabilities: { simple: true, custom: true, instrumental: true, vocals: true } }];
const variant = { id: 'b'.repeat(32), kind: 'variant', data: { audio: assetId, result_title: 'Silver horizon', provider: 'Local audio fixture', model: 'Fixture model', index: 1, mime: 'audio/wav', validation: { duration: 2 } } };
const calls = [], jobs = []; let win, finished = false, lastFrame, frameSequence = 0, deny = true;
app.setPath('userData', path.join(home, 'profile')); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('mute-audio');
protocol.registerSchemesAsPrivileged([{ scheme: 'yur-music', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const preload = path.join(home, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureMusic',{invoke:(action,payload)=>ipcRenderer.invoke('fixture:music',action,payload),asset:id=>ipcRenderer.invoke('fixture:asset',id),save:id=>ipcRenderer.invoke('fixture:save',id)});`);
const html = path.join(home, 'music.html');
fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; media-src yur-music:; img-src 'none'; connect-src 'none'"><link rel="stylesheet" href="${pathToFileURL(path.join(source, 'src/music.css')).href}"><style>html,body{margin:0;min-height:100%;background:#142238}body{padding:25px 38px}#host{max-width:1260px;margin:auto}</style><script defer src="${pathToFileURL(path.join(source, 'src/music-view.js')).href}"></script></head><body><main id="host"></main></body></html>`);
const evaluate = code => win.webContents.executeJavaScript('(async()=>{' + code + '})()', true);
async function until(condition, label, ms = 10000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error('Timed out: ' + label); }
async function capture(name) {
  await evaluate(`await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));`);
  await new Promise(resolve => setTimeout(resolve, 120));
  const prior = frameSequence; win.webContents.invalidate();
  await until(() => lastFrame && frameSequence > prior, 'offscreen frame');
  fs.writeFileSync(path.join(attempt, name + '.png'), lastFrame.toPNG());
  receipt.screenshots ||= []; receipt.screenshots.push({ file: name + '.png', width: lastFrame.getSize().width, height: lastFrame.getSize().height });
}
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  try {
    receipt.finished_at = new Date().toISOString(); receipt.source_after = fingerprint();
    receipt.source_changed = monitored.filter(name => receipt.source_before[name] !== receipt.source_after[name]);
    if (receipt.source_changed.length) error ||= new Error('Music source changed during validation');
    receipt.passed = !error; receipt.error = error?.stack; receipt.calls = calls;
    fs.writeFileSync(path.join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2));
    fs.writeFileSync(path.join(evidence, 'latest.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ passed: !error, error: error?.message, checks: receipt.checks, screenshots: receipt.screenshots, attempt }));
  } finally { if (win && !win.isDestroyed()) win.destroy(); app.exit(error ? 1 : 0); }
}
const deadline = setTimeout(() => void finish(new Error('Native Music fixture exceeded 60 seconds')), 60000);
app.whenReady().then(async () => {
  ipcMain.handle('fixture:music', (_event, action, payload) => {
    calls.push({ action, payload });
    if (action === 'connect') return { ok: true, result: { connected: true } };
    if (action === 'music_state') return { ok: true, result: { providers } };
    if (action === 'music_catalog') return { ok: true, result: { documents: payload.kind === 'variant' ? [variant] : jobs } };
    if (action === 'generate_song') {
      if (deny) return { ok: false, error: { code: 'USER_DECLINED', message: 'You declined this fixture request. Your draft is preserved.' } };
      const document = { id: 'a'.repeat(32), kind: 'job', data: { state: 'queued', request: { ...payload.request, title: payload.title } } }; jobs.push(document);
      return { ok: true, result: { document, composition_id: 'c'.repeat(32), lyrics_id: 'd'.repeat(32) } };
    }
    throw new Error('Fixture forbids ' + action);
  });
  ipcMain.handle('fixture:asset', (_event, id) => { assert.equal(id, assetId); calls.push({ action: 'asset', asset_id: id }); return { ok: true, result: { url: assetUrl, asset_id: id } }; });
  ipcMain.handle('fixture:save', (_event, id) => { assert.equal(id, assetId); calls.push({ action: 'save', asset_id: id }); return { ok: true, result: { saved: false, cancelled: true } }; });
  protocol.handle('yur-music', request => {
    assert.equal(request.url, assetUrl);
    return new Response(wave, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wave.length), 'Cache-Control': 'no-store' } });
  });
  win = new BrowserWindow({ width: 1360, height: 1080, show: false, backgroundColor: '#142238', webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true } });
  win.webContents.on('paint', (_event, _dirty, image) => { lastFrame = image; frameSequence++; });
  await win.loadFile(html);
  await evaluate(`window.musicTest=window.YurMusicView.create(document.getElementById('host'),{api:window.fixtureMusic,pollMs:0,draft:{mode:'simple',description:'A hopeful late-night drive through the city. Warm vocals, a steady bass line, and a chorus that opens up like sunrise.',style:'Atmospheric synths, bright guitar, warm bass',tags:['Indie pop','Uplifting']}});await window.musicTest.ready;`);
  assert.equal(calls.some(value => value.action === 'generate_song'), false);
  assert.equal(await evaluate(`return !document.getElementById('music-generate').disabled`), true);
  receipt.checks.push('Opening discovers actual fixture choices without generation; Simple mode visible');
  await capture('music-simple');
  await evaluate(`document.getElementById('music-custom').click();`);
  await until(() => evaluate(`return document.getElementById('music-custom').getAttribute('aria-selected')==='true'`), 'Custom tab');
  const customDraft = { mode: 'custom', title: 'Silver horizon', lyrics: '[Verse]\nStreetlights fade behind us\nA new day on the rise\n\n[Chorus]\nWe are heading for the silver horizon\nWith the morning in our eyes', style: 'Indie pop, warm bass, bright guitars', tags: ['Indie pop', 'Uplifting', 'Warm vocals', 'Mid-tempo'] };
  await evaluate(`window.musicTest.prepareDraft(${JSON.stringify(customDraft)});`);
  assert.equal(await evaluate(`return document.getElementById('music-description').value.includes('late-night drive')`), true);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Show more').click();`);
  await until(() => evaluate(`return document.querySelectorAll('.music-chip').length>8`), 'expanded styles');
  await capture('music-custom');
  receipt.checks.push('Custom title/lyrics/style and expanded grouped suggestions preserve the Simple draft');
  await evaluate(`document.querySelector('.music-create').requestSubmit();`);
  await until(() => evaluate(`return document.getElementById('music-status').textContent.includes('declined')`), 'native refusal');
  assert.equal(jobs.length, 0); assert.equal(calls.filter(value => value.action === 'generate_song').length, 1);
  assert.equal(await evaluate(`return document.getElementById('music-lyrics').value.startsWith('[Verse]')`), true);
  receipt.checks.push('Refused generation creates zero fixture jobs and retains exact draft');
  deny = false; await evaluate(`document.querySelector('.music-create').requestSubmit();`);
  await until(() => jobs.length === 1 && evaluate(`return !document.getElementById('music-generate').disabled`), 'accepted request');
  const payload = calls.filter(value => value.action === 'generate_song').at(-1).payload;
  assert.equal(payload.request.provider, 'fixture-music'); assert.equal(payload.request.model, 'Fixture model'); assert.equal(payload.request.private, false);
  assert.equal(payload.request.rights, undefined); assert.equal(payload.request.external_approved, undefined);
  receipt.checks.push('Accepted full-form request submits once with exact observed provider/model and no renderer grants');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Listen').click();`);
  await until(() => evaluate(`return document.querySelector('audio')?.readyState>=1`), 'native WAV decode');
  const playback = await evaluate(`const audio=document.querySelector('audio');await audio.play();audio.currentTime=0.7;await new Promise(resolve=>setTimeout(resolve,80));audio.pause();return {duration:audio.duration,currentTime:audio.currentTime,src:audio.src,paused:audio.paused};`);
  assert.ok(playback.duration >= 1.9 && playback.duration <= 2.1); assert.ok(playback.currentTime >= 0.7); assert.equal(playback.paused, true);
  receipt.playback = playback; receipt.checks.push('Host-scheme WAV decodes, plays, seeks and pauses inside the native Music panel');
  await evaluate(`window.beforeRefreshAudio=document.querySelector('audio');await window.musicTest.refresh();`);
  assert.equal(await evaluate(`return document.querySelector('audio')===window.beforeRefreshAudio`), true);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Save audio').click();`);
  await until(() => calls.some(value => value.action === 'save'), 'native save callback');
  await capture('music-library');
  receipt.checks.push('Library refresh preserves the player; Save targets the actual asset ID');
  await evaluate(`window.musicTest.dispose();`);
  assert.equal(await evaluate(`return document.querySelector('.music-studio')===null`), true);
  await finish();
}).catch(error => void finish(error));
