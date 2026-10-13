'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const security = require('../src/desktop-security');
const { FactoryScheduler } = require('../src/factory-scheduler');
const sourceRoot = path.resolve(__dirname, '../src');

test('factory accepts bounded commands and encodes user input as JSON data', () => {
  const request = { command: 'submit', spec: { name: 'Support & Operations', description: 'Analyze literal $(commands), quotes " and Unicode 雪.', capabilities: ['support.triage'] }, idempotency_key: 'request-1' };
  assert.deepEqual(JSON.parse(security.validateFactoryRequest(request)), request);
  assert.equal(JSON.parse(security.validateFactoryRequest({ command: 'process', max_missions: 25 })).max_missions, 25);
  const authority = { issuer: 'local-user', scope: 'repository-read', actions: ['list', 'read', 'search'] };
  const bootstrap = { command: 'repository_bootstrap', bootstrap: 'federation', roots: ['C:\\work\\one', 'C:\\work\\two'], question: 'Compare the entry points.', authority };
  assert.deepEqual(JSON.parse(security.validateFactoryRequest(bootstrap)), bootstrap);
});

test('factory rejects command and authority expansion from the renderer', () => {
  for (const request of [null, [], { command: 'exec' }, { command: '__proto__' }, { command: 'health', path: '../secret' }, { command: 'process', max_missions: 26 }, { command: 'process', max_missions: 0 }, { command: 'process', max_missions: 1.5 }, { command: 'inspect', mission_id: '' }, { command: 'run', mission_id: 'mission-1', capability_id: 'text.analyze', input: [] }, { command: 'repository_bootstrap', bootstrap: 'federation', roots: ['relative'], question: 'x', authority: { issuer: 'local-user', scope: 'repository-read', actions: ['list', 'read', 'write'] } }]) {
    assert.throws(() => security.validateFactoryRequest(request));
  }
});

test('factory rejects invalid mission specs and missing replay protection', () => {
  const spec = { name: 'Analyst', description: 'Analyze text', capabilities: ['text.analyze'] };
  assert.throws(() => security.validateFactoryRequest({ command: 'submit', spec }));
  assert.throws(() => security.validateFactoryRequest({ command: 'submit', spec: { ...spec, capabilities: [] }, idempotency_key: 'key' }));
  assert.throws(() => security.validateFactoryRequest({ command: 'submit', spec: { ...spec, name: 'x'.repeat(101) }, idempotency_key: 'key' }));
  assert.throws(() => security.validateFactoryRequest({ command: 'submit', spec: { ...spec, description: 'x'.repeat(2001) }, idempotency_key: 'key' }));
  assert.doesNotThrow(() => security.validateFactoryRequest({ command: 'submit', spec: { ...spec, description: '' }, idempotency_key: 'key' }));
});

test('source lookup permits bounded metadata search without arbitrary paths', () => {
  assert.doesNotThrow(() => security.validateFactoryRequest({ command: 'sources', query: '', limit: 8 }));
  assert.doesNotThrow(() => security.validateFactoryRequest({ command: 'sources', query: 'construction', limit: 50 }));
  for (const request of [{ command: 'sources', query: 'x'.repeat(201), limit: 8 }, { command: 'sources', query: '', limit: 51 }, { command: 'sources', query: '', limit: 0 }, { command: 'sources', query: '', limit: 8, path: 'C:/private' }]) assert.throws(() => security.validateFactoryRequest(request));
});

test('factory bounds serialized input and automation requests', () => {
  assert.throws(() => security.validateFactoryRequest({ command: 'run', mission_id: 'mission-1', capability_id: 'text.analyze', input: { text: 'x'.repeat(security.MAX_REQUEST_BYTES) } }));
  assert.throws(() => security.validateFactoryRequest({ command: 'automation', enabled: true, interval_seconds: 0, max_cycles: 100000 }));
  assert.doesNotThrow(() => security.validateFactoryRequest({ command: 'automation', enabled: false, interval_seconds: 30, max_cycles: 10 }));
});

test('factory requires complete JSON response envelopes, without log pollution', () => {
  assert.deepEqual(security.parseFactoryResponse('{"ok":true,"result":{"status":"ready"}}'), { ok: true, result: { status: 'ready' } });
  assert.equal(security.parseFactoryResponse('{"ok":false,"error":{"code":"DENIED","message":"Authority denied"}}').ok, false);
  for (const output of ['', '{}', '[]', '{"ok":true}', '{"ok":false,"error":"oops"}', '{"ok":"true","result":{}}', 'starting\n{"ok":true,"result":{}}']) assert.throws(() => security.parseFactoryResponse(output));
  assert.throws(() => security.parseFactoryResponse('x'.repeat(security.MAX_RESPONSE_BYTES + 1)));
});

test('IPC requires the exact live packaged window and main frame', () => {
  const file = path.join(sourceRoot, 'factory.html');
  const mainFrame = { url: pathToFileURL(file).href };
  const contents = { mainFrame };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: mainFrame };
  assert.equal(security.isTrustedSender(event, window, file), true);
  assert.equal(security.isTrustedSender({ ...event, senderFrame: { url: mainFrame.url } }, window, file), false);
  assert.equal(security.isTrustedSender({ ...event, sender: {} }, window, file), false);
  assert.equal(security.isTrustedSender(event, { ...window, isDestroyed: () => true }, file), false);
  assert.equal(security.isTrustedSender(event, null, file), false);
  mainFrame.url = `${pathToFileURL(file).href}#mission-queue`;
  assert.equal(security.isTrustedSender(event, window, file), true);
  mainFrame.url = `${pathToFileURL(path.join(sourceRoot, 'other.html')).href}#mission-queue`;
  assert.equal(security.isTrustedSender(event, window, file), false);
  mainFrame.url = 'https://example.com/factory.html';
  assert.equal(security.isTrustedSender(event, window, file), false);
  mainFrame.url = `${pathToFileURL(file).href}?injected=true`;
  assert.equal(security.isTrustedSender(event, window, file), false);
});

test('external links cannot launch arbitrary OS protocols or carry credentials', () => {
  assert.equal(security.safeExternalUrl('https://example.com/path?q=hello'), 'https://example.com/path?q=hello');
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/system32/cmd.exe', 'data:text/html,hello', 'ms-settings:privacy', 'https://user:password@example.com', 123]) assert.throws(() => security.safeExternalUrl(url));
});

test('file searches keep shell metacharacters inside a literal subprocess argument', () => {
  const search = 'folder & echo INJECTION | more';
  const args = security.fileSearchArgs(search);
  assert.deepEqual(args.slice(0, 2), ['--files', '--']);
  assert.equal(args.length, 3);
  assert.equal(args[2], path.resolve(search));
  const source = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8');
  assert.doesNotMatch(source, /\bexec\s*\(/);
  assert.match(source, /spawn\('rg', args, \{ shell: false/);
});

test('factory preload exposes only factory request and editor navigation', () => {
  let exposed;
  const calls = [];
  const listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, 'factory-preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'studio'); exposed = api; } }, ipcRenderer: { invoke: (...args) => calls.push(args), on: (channel, handler) => listeners.set(channel, handler), removeListener: (channel, handler) => { if (listeners.get(channel) === handler) listeners.delete(channel); } } };
    },
  });
  assert.deepEqual(Object.keys(exposed), ['factory']);
  assert.deepEqual(Object.keys(exposed.factory).sort(), ['onAutomationState', 'openEditor', 'request']);
  exposed.factory.request({ command: 'health' });
  assert.equal(calls[0][0], 'factory:request');
  assert.ok(Object.isFrozen(exposed.factory));
  let received;
  const unsubscribe = exposed.factory.onAutomationState(status => { received = status; });
  listeners.get('factory:automation-state')({ privileged: true }, { enabled: false });
  assert.deepEqual(received, { enabled: false });
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.throws(() => exposed.factory.onAutomationState('not a callback'));
});

test('factory document uses local resources and denies network, frames and inline execution', () => {
  const html = fs.readFileSync(path.join(sourceRoot, 'factory.html'), 'utf8');
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\/|unsafe-inline|unsafe-eval|\son\w+=|<iframe/i);
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /src="factory.js"/);
  assert.equal(scripts[0][2].trim(), '');
  const js = fs.readFileSync(path.join(sourceRoot, 'factory.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|\bfetch\s*\(/);
  assert.doesNotMatch(js, /\bsetTimeout\s*\(|\bsetInterval\s*\(/);
});

function cadenceHarness(process) {
  const timers = new Map();
  const events = [];
  let nextTimer = 0;
  const scheduler = new FactoryScheduler({ process, onState: status => events.push(status), now: () => 100000,
    setTimer: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    clearTimer: id => timers.delete(id),
  });
  const tick = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); };
  return { scheduler, timers, events, tick };
}

test('continuous queue invokes the existing bounded process sequentially and stops at its cycle budget', async () => {
  const calls = [];
  const harness = cadenceHarness(async request => { calls.push(request); return { ok: true, result: { processed: ['mission'], remaining: 1 } }; });
  const { scheduler, timers, tick } = harness;
  scheduler.start({ max_cycles: 2, interval_seconds: 30 });
  assert.equal(scheduler.status().running, true);
  assert.throws(() => scheduler.start({ max_cycles: 2, interval_seconds: 30 }));
  await scheduler.inFlight;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: 'process', max_missions: 1 });
  assert.equal(scheduler.status().enabled, true);
  assert.equal(timers.values().next().value.milliseconds, 30000);
  assert.equal(scheduler.status().next_cycle_at, new Date(130000).toISOString());
  tick(); await scheduler.inFlight;
  assert.equal(calls.length, 2);
  assert.equal(scheduler.status().cycles, 2);
  assert.equal(scheduler.status().enabled, false);
  assert.equal(scheduler.status().running, false);
  assert.equal(timers.size, 0);
  const snapshot = scheduler.status(); snapshot.cycles = 999;
  assert.equal(scheduler.status().cycles, 2);
});

test('stop lets the current queue operation finish and prevents overlap or implicit restart', async () => {
  let resolveCycle;
  const { scheduler, timers } = cadenceHarness(() => new Promise(resolve => { resolveCycle = resolve; }));
  scheduler.start({ max_cycles: 10, interval_seconds: 5 });
  scheduler.stop();
  assert.equal(scheduler.status().enabled, false);
  assert.equal(scheduler.status().running, true);
  assert.throws(() => scheduler.start({ max_cycles: 1, interval_seconds: 5 }));
  resolveCycle({ ok: true, result: { processed: ['mission'] } });
  await scheduler.inFlight;
  assert.equal(scheduler.status().running, false);
  assert.equal(scheduler.status().cycles, 1);
  assert.equal(timers.size, 0);
});

test('stopping between cycles clears pending cadence and failures stop further dispatch', async () => {
  const success = cadenceHarness(async () => ({ ok: true, result: {} }));
  success.scheduler.start({ max_cycles: 10, interval_seconds: 5 }); await success.scheduler.inFlight;
  assert.equal(success.timers.size, 1);
  success.scheduler.stop(); assert.equal(success.timers.size, 0);
  for (const process of [async () => ({ ok: false, error: { code: 'DENIED', message: 'Worker lock unavailable' } }), async () => { throw new Error('Transport failed'); }]) {
    const { scheduler, timers } = cadenceHarness(process);
    scheduler.start({ max_cycles: 10, interval_seconds: 5 }); await scheduler.inFlight;
    assert.equal(scheduler.status().enabled, false);
    assert.equal(scheduler.status().cycles, 1);
    assert.ok(scheduler.status().error.message);
    assert.equal(timers.size, 0);
  }
});

test('continuous queue rejects unbounded configuration and starts dormant', () => {
  const { scheduler } = cadenceHarness(async () => ({ ok: true, result: {} }));
  assert.equal(scheduler.status().enabled, false);
  for (const config of [{ max_cycles: 0, interval_seconds: 5 }, { max_cycles: 101, interval_seconds: 5 }, { max_cycles: 1, interval_seconds: 4 }, { max_cycles: 1, interval_seconds: 3601 }]) assert.throws(() => scheduler.start(config));
  assert.doesNotThrow(() => security.validateFactoryRequest({ command: 'automation_status' }));
  assert.throws(() => security.validateFactoryRequest({ command: 'automation_status', enabled: true }));
});

test('legacy chat escaping preserves hostile model output as text', () => {
  const html = fs.readFileSync(path.join(sourceRoot, 'studio-editor.html'), 'utf8');
  const match = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n      \}/);
  assert.ok(match);
  const context = vm.createContext({}); vm.runInContext(match[0], context);
  const escaped = context.escapeHtml('<img src=x onerror="window.studio.code.run()">&\'');
  assert.equal(escaped, '&lt;img src=x onerror=&quot;window.studio.code.run()&quot;&gt;&amp;&#39;');
  assert.match(html, /escapeHtml\(m\.text\)/);
  assert.doesNotMatch(html, /sandbox="[^"]*allow-scripts[^"]*allow-same-origin/);
  assert.doesNotMatch(html, /closeTab\('\$\{path\}'\)/);
});

test('desktop IPC channels are guarded and factory transport never invokes a shell', () => {
  const main = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8');
  assert.doesNotMatch(main, /ipcMain\.(?:handle|on)\('(?:file|code|terminal|foundry|ollama|shell):/);
  assert.match(main, /isTrustedSender\(event, factoryWindow, factoryFile\)/);
  assert.match(main, /\['-B', '-m', 'foundry\.factory_cli', 'rpc'\]/);
  assert.match(main, /delete environment\.PYTHONPATH/);
  assert.match(main, /delete environment\.PYTHONHOME/);
  assert.match(main, /factoryChildren\.size >= 4/);
  assert.match(main, /child\.stdin\.end\(encoded\)/);
  assert.match(main, /cwd: path\.resolve\(__dirname, '\.\.'\), shell: false, windowsHide: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.doesNotMatch(main, /webviewTag: true|nodeIntegration: true|contextIsolation: false/);
});
