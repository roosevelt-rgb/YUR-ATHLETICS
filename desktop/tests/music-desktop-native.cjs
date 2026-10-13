'use strict';
// Read-only acceptance of the actual Desktop host and existing Music library.
// No model, provider generation, document save, export, resume or cancellation.
const { app, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-music-desktop-'));
const evidence = path.resolve(root, '../../evidence/glider-rc6/comprehensive/completion-2026-10-05/music-desktop-native');
const attempt = path.join(evidence, 'attempt-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(attempt, { recursive: true });
const names = ['src/main.js', 'src/preload.js', 'src/conversation-view.js', 'src/studio-editor.html', 'src/music-view.js', 'src/music.css',
  'src/music-assets.js', 'src/music-ui-host.js', 'src/music-connection.js', 'src/franklin-services.js', 'src/franklin-host.js', 'src/franklin-execution.js',
  'src/unreal-view.js', 'src/unreal-view.css', 'foundry/work_desktop.py', 'tests/music-desktop-native.cjs'];
const fingerprints = () => Object.fromEntries(names.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const receipt = { started_at: new Date().toISOString(), home, attempt, checks: [], source_before: fingerprints(),
  limitations: ['Actual main/preload/renderer, Music supervisor, service API and saved audio are used.',
    'No model request, provider generation, Music mutation or native save is allowed in this read-only acceptance.',
    'Playing an existing asset proves access and decoding, not new generation quality or provider availability.'] };
let connection, win, finalized = false, deadline;
const disposers = [];
const shutdownMode = process.argv.includes('--shutdown');
function trace(name, phase) {
  if (!shutdownMode) return;
  receipt.shutdown_events ||= [];
  if (receipt.shutdown_events.length < 250) receipt.shutdown_events.push({ at: new Date().toISOString(), name, phase });
  fs.writeFileSync(path.join(attempt, 'shutdown-progress.json'), JSON.stringify({ pid: process.pid, events: receipt.shutdown_events }, null, 2));
}
function observe(name, instance, methods) {
  const result = { ...instance };
  for (const method of methods) if (typeof instance[method] === 'function') result[method] = (...args) => {
    trace(name + '.' + method, 'begin');
    try {
      const value = instance[method](...args);
      if (value?.then) return value.then(output => { trace(name + '.' + method, 'resolved'); return output; }, error => { trace(name + '.' + method, 'rejected'); throw error; });
      trace(name + '.' + method, 'returned'); return value;
    } catch (error) { trace(name + '.' + method, 'threw'); throw error; }
  };
  return result;
}
if (shutdownMode) for (const name of ['before-quit', 'will-quit', 'window-all-closed', 'quit']) app.on(name, () => trace('app', name));
const calls = [], reads = new Set(['services_status', 'music_state', 'music_catalog', 'music_status']);
process.env.YUR_GLIDER_RC6 = '1'; process.env.YUR_HARNESS_AUTOSTART = '0';
process.env.YUR_DESKTOP_HOME = path.join(home, 'journal'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.APPDATA = path.join(home, 'appdata'); process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot');
process.env.YUR_FACTORY_PYTHON = require('../src/desktop-runtime').desktopPython(root); process.env.PYTHONDONTWRITEBYTECODE = '1';
process.env.YUR_MUSIC_APP_ROOT = 'D:\\YUR-UNIFIED\\apps\\music-studio';
// An acceptance owner can supply a provenance-checked library snapshot with an
// independent worker lock while the normal Desktop keeps its live library open.
const musicDataArgument = process.argv.find(value => value.startsWith('--music-data-root='));
const selectedMusicData = musicDataArgument?.slice('--music-data-root='.length);
if (musicDataArgument && (!selectedMusicData || !path.win32.isAbsolute(selectedMusicData)
    || !/^[dD]:[\\/]/.test(selectedMusicData))) throw new Error('Music acceptance data root must be an explicit local D: path.');
process.env.YUR_MUSIC_DATA_ROOT = selectedMusicData || path.join(process.env.YUR_MUSIC_APP_ROOT, 'music', 'runtime');
receipt.music_data_root = process.env.YUR_MUSIC_DATA_ROOT;
receipt.library_source = selectedMusicData ? 'explicit isolated library snapshot; provenance recorded separately' : 'existing shared Music library';
delete process.env.YUR_FRANKLIN_MUSIC_URL; delete process.env.YUR_FRANKLIN_MUSIC_TOKEN;
app.setPath('userData', path.join(home, 'electron')); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('mute-audio');
// Transparent observation plus a test-only admission ceiling. The real adapter
// still performs every permitted HTTP read with its host-owned authentication.
const serviceModule = require('../src/franklin-services'), originalServices = serviceModule.createFranklinServices;
serviceModule.createFranklinServices = options => {
  const service = originalServices(options);
  return { ...service, async execute(action, payload, identity, confirmation) {
    calls.push({ action, ...(payload.kind ? { kind: payload.kind } : {}) });
    if (!reads.has(action)) throw new Error('Read-only Music fixture forbids ' + action);
    return service.execute(action, payload, identity, confirmation);
  } };
};
const connectionModule = require('../src/music-connection'), originalConnection = connectionModule.createMusicConnection;
connectionModule.createMusicConnection = options => (connection = observe('music', originalConnection(options), ['stop']));
const generationModule = require('../src/generation-transport'), originalGeneration = generationModule.createGenerationTransport;
generationModule.createGenerationTransport = options => { const transport = observe('generation', originalGeneration(options), ['dispose']); disposers.push(() => transport.dispose()); return { ...transport, start: () => { throw new Error('No model execution is authorized by this fixture.'); } }; };
for (const [file, factory] of [['conversation-transport', 'createConversationTransport'], ['work-transport', 'createWorkTransport'],
  ['voice-transport', 'createVoiceTransport'], ['execution-runtime-transport', 'createExecutionRuntimeTransport']]) {
  const module = require('../src/' + file), original = module[factory];
  module[factory] = options => { const transport = observe(file, original(options), ['dispose']); disposers.push(() => transport.dispose()); return transport; };
}
if (shutdownMode) for (const [file, factory] of [['schedule-dispatcher', 'createScheduleDispatcher'], ['lifecycle-dispatcher', 'createLifecycleDispatcher'],
  ['harness-sidecar', 'createHarnessSidecar'], ['background-lifetime', 'createBackgroundLifetime'], ['music-assets', 'createMusicAssets']]) {
  const module = require('../src/' + file), original = module[factory];
  module[factory] = options => observe(file, original(options), ['stop', 'dispose', 'beginQuit', 'close']);
}
dialog.showMessageBox = async () => { receipt.unexpected_confirmation = true; return { response: 0 }; };
dialog.showSaveDialog = async () => { receipt.unexpected_save = true; return { canceled: true }; };
const evaluate = code => win.webContents.executeJavaScript('(async()=>{' + code + '})()', true);
async function until(condition, label, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out: ' + label); }
async function catalog() {
  return evaluate(`const result=await window.studio.music.invoke('music_catalog',{kind:'job',limit:50});if(!result.ok)throw new Error(result.error.message);return result.result.documents.map(row=>({id:row.id,revision:row.revision,state:row.data.state}));`);
}
async function finish(error) {
  if (finalized) return; finalized = true; clearTimeout(deadline);
  try {
    if (connection) { await connection.stop(); receipt.connection_stopped = !connection.status().owned; if (!receipt.connection_stopped) error ||= new Error('Owned Music service did not stop'); }
    receipt.source_after = fingerprints(); receipt.source_changed = names.filter(name => receipt.source_before[name] !== receipt.source_after[name]);
    if (receipt.source_changed.length) error ||= new Error('Product changed during read-only acceptance');
    receipt.finished_at = new Date().toISOString(); receipt.calls = calls; receipt.passed = !error; receipt.error = error?.stack;
    fs.writeFileSync(path.join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2));
    fs.writeFileSync(path.join(evidence, 'latest.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ passed: !error, error: error?.message, checks: receipt.checks, attempt, connection_stopped: receipt.connection_stopped }));
  } finally {
    try { await Promise.race([Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose))), new Promise(resolve => setTimeout(resolve, 3000))]); }
    finally { if (win && !win.isDestroyed()) win.destroy(); app.exit(error ? 1 : 0); }
  }
}
async function test() {
  try {
    const entered = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await evaluate('setTimeout(()=>window.studio.launch.enter(),20);'); await entered;
    await until(() => evaluate(`return !!document.getElementById('yc-music-open')&&!!window.yurMusic`), 'native Music navigation');
    await evaluate(`document.getElementById('yc-music-open').click();`);
    await until(() => evaluate(`return document.querySelectorAll('.music-track').length>0`), 'saved Music tracks', 40000);
    assert.equal(connection.status().owned, true); assert.equal(connection.status().connected, true);
    receipt.checks.push('Actual Desktop Music navigation starts only the owned lightweight service after its old-job guard');
    const initial = await catalog(); assert.ok(initial.length > 0); assert.ok(initial.every(row => !['queued', 'running'].includes(row.state)));
    receipt.jobs_before = initial;
    const state = await evaluate(`const r=await window.studio.music.invoke('music_state',{});if(!r.ok)throw new Error(r.error.message);return {worker_alive:r.result.worker_alive,document_count:r.result.document_count,providers:r.result.providers.map(p=>({id:p.id,configured:p.configured,models:p.models||[]})),integrity:r.result.integrity};`);
    receipt.music_state = state; assert.equal(state.worker_alive, true);
    assert.equal(await evaluate(`return document.getElementById('yc-preferences-panel').dataset.kind`), 'music');
    receipt.checks.push('Actual existing library, job states and observed provider/model choices reach the in-Desktop form');
    await evaluate(`window.yurMusic.open({draft:{mode:'custom',title:'Read-only acceptance draft',lyrics:'This draft is prepared only.',style:'Acoustic'}});`);
    assert.equal(await evaluate(`return document.getElementById('music-lyrics').value`), 'This draft is prepared only.');
    assert.equal(calls.some(row => !reads.has(row.action)), false);
    receipt.checks.push('Conversational draft hook prepares Custom text without creating documents or submitting a song');
    await until(() => evaluate(`return Array.from(document.querySelectorAll('.music-track-actions button')).some(button=>button.textContent==='Listen')`), 'library after draft navigation');
    await evaluate(`Array.from(document.querySelectorAll('.music-track-actions button')).find(button=>button.textContent==='Listen').click();`);
    await until(() => evaluate(`return document.querySelector('.music-audio audio')?.readyState>=1`), 'existing saved audio decode', 40000);
    const audio = await evaluate(`const a=document.querySelector('.music-audio audio');await a.play();a.currentTime=Math.min(1,a.duration/2);await new Promise(resolve=>setTimeout(resolve,120));a.pause();return {duration:a.duration,time:a.currentTime,paused:a.paused,scheme:new URL(a.src).protocol};`);
    assert.ok(Number.isFinite(audio.duration) && audio.duration > 0); assert.ok(audio.time > 0); assert.equal(audio.paused, true); assert.equal(audio.scheme, 'yur-music:'); receipt.playback = audio;
    receipt.checks.push('Existing committed audio passes actual host download/hash/type validation and decodes, plays, seeks and pauses in Desktop');
    const final = await catalog(); receipt.jobs_after = final; assert.deepEqual(final, initial);
    assert.equal(receipt.unexpected_confirmation, undefined); assert.equal(receipt.unexpected_save, undefined); assert.equal(calls.some(row => !reads.has(row.action)), false);
    receipt.checks.push('Saved job identities/revisions/states remain unchanged; no generation, mutation, confirmation or save occurred');
    await evaluate(`document.getElementById('yc-music-open').click();`);
    assert.equal(await evaluate(`return document.getElementById('music-lyrics').value`), 'This draft is prepared only.');
    await until(() => evaluate(`return document.querySelectorAll('.music-track').length>0`), 'idle library before shutdown');
    if (shutdownMode) {
      trace('fixture', 'normal-quit-requested'); receipt.normal_shutdown = false;
      clearTimeout(deadline); deadline = setTimeout(() => void finish(new Error('Normal Desktop shutdown did not finish within 12 seconds')), 12000);
      app.once('will-quit', () => {
        finalized = true; clearTimeout(deadline); receipt.normal_shutdown = true; receipt.connection_stopped = !connection.status().owned;
        receipt.source_after = fingerprints(); receipt.source_changed = names.filter(name => receipt.source_before[name] !== receipt.source_after[name]);
        receipt.passed = receipt.connection_stopped && receipt.source_changed.length === 0; receipt.calls = calls; receipt.finished_at = new Date().toISOString();
        fs.writeFileSync(path.join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2));
        fs.writeFileSync(path.join(evidence, 'latest.json'), JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify({ passed: receipt.passed, normal_shutdown: true, connection_stopped: receipt.connection_stopped, attempt }));
      });
      app.quit();
    } else await finish();
  } catch (error) { await finish(error); }
}
app.on('browser-window-created', (_event, created) => {
  if (win) return; win = created; win.webContents.setBackgroundThrottling(false); win.setFocusable(false); win.setOpacity(0); win.setPosition(-16000, -16000); win.setSkipTaskbar(true);
  if (shutdownMode) { win.on('close', () => trace('window', 'close')); win.on('closed', () => trace('window', 'closed')); win.webContents.on('will-prevent-unload', () => trace('renderer', 'will-prevent-unload')); }
  win.webContents.once('did-finish-load', test);
});
deadline = setTimeout(() => void finish(new Error('Read-only Desktop Music acceptance exceeded 120 seconds')), 120000);
try { require('../src/main'); } catch (error) { void finish(error); }
