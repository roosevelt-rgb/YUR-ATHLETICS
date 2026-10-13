'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { createConversationTransport, validateRequest, parseResponse, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } = require('../src/conversation-transport');

const sourceRoot = path.resolve(__dirname, '..');

function transportFor(behavior, options = {}) {
  const invocations = [];
  const transport = createConversationTransport({
    sourceRoot, getStateRoot: () => path.join(sourceRoot, 'test-only-state'), getPython: () => 'test-python',
    getEnvironment: () => ({ PATH: 'test-path', PYTHONPATH: 'untrusted-path', PYTHONHOME: 'untrusted-home' }),
    spawnProcess(executable, args, settings) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let input = '';
      child.stdin = new Writable({ write(chunk, _encoding, callback) { input += chunk; callback(); }, final(callback) { callback(); setImmediate(() => behavior(child, JSON.parse(input))); } });
      child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
      invocations.push({ executable, args, settings, child });
      return child;
    },
    ...options,
  });
  return { transport, invocations };
}

function reply(child, response, code = 0) { child.stdout.write(JSON.stringify(response)); child.emit('close', code); }

test('conversation adapter accepts only bounded list/save requests', () => {
  assert.equal(validateRequest({ command: 'list' }), '{"command":"list"}');
  assert.doesNotThrow(() => validateRequest({ command: 'save', conversation: { title: 'literal $(text)' }, expected_revision: 0 }));
  for (const value of [null, [], { command: 'exec' }, { command: 'list', path: 'outside' }, { command: 'save', conversation: [], expected_revision: 0 }, { command: 'save', conversation: {}, expected_revision: -1 }, { command: 'save', conversation: {}, expected_revision: 1.5 }, { command: 'save', conversation: {} }, { command: 'save', conversation: { title: 'x'.repeat(MAX_INPUT_BYTES) }, expected_revision: 0 }]) assert.throws(() => validateRequest(value));
});

test('workspace requests accept only fixed kinds and reject malformed committed responses', () => {
  assert.doesNotThrow(() => validateRequest({ command: 'workspace_list', kind: 'settings' }));
  assert.doesNotThrow(() => validateRequest({ command: 'workspace_save', kind: 'project', document: { name: 'Sample' }, expected_revision: 1 }));
  for (const value of [{ command: 'workspace_list', kind: 'mission' }, { command: 'workspace_list', kind: 'settings', authority: {} }, { command: 'workspace_save', kind: 'project', document: {}, expected_revision: -1 }, { command: 'workspace_save', kind: 'settings', document: [] }, { command: 'workspace_save', kind: 'settings', document: {}, expected_revision: 0, root: 'outside' }]) assert.throws(() => validateRequest(value));
  assert.throws(() => parseResponse('{"ok":true,"result":{"documents":{}}}', 'workspace_list'));
  assert.throws(() => parseResponse('{"ok":true,"result":{"document":{"revision":0}}}', 'workspace_save'));
});

test('project reference ingress validates exact IDs, CAS revisions, selection bounds and response binding', () => {
  const project = randomUUID(), file = randomUUID(), hash = 'a'.repeat(64), operation = randomUUID();
  const list = { command: 'project_files_list', project_id: project, expected_project_revision: 2 };
  const add = { ...list, command: 'project_file_add', expected_collection_revision: 0, operation_id: operation, path: path.join(sourceRoot, 'fixture.md'), expected_sha256: hash };
  const remove = { ...list, command: 'project_file_remove', expected_collection_revision: 1, operation_id: operation, file_id: file, expected_file_revision: 1, expected_sha256: hash };
  const context = { ...list, command: 'project_files_context', selections: [{ file_id: file, revision: 1, sha256: hash }] };
  for (const request of [list, add, remove, context]) assert.doesNotThrow(() => validateRequest(request));
  for (const request of [{ ...list, authority: {} }, { ...list, expected_project_revision: 0 }, { ...add, path: 'relative.md' }, { ...add, operation_id: 'not-an-id' }, { ...remove, expected_file_revision: 0 }, { ...context, selections: [...context.selections, ...context.selections] }, { ...context, selections: Array(9).fill(context.selections[0]) }]) assert.throws(() => validateRequest(request));
  const content = 'Bounded shared project context';
  const evidence = { schema: 'yur.project-files-context.v1', project_id: project, project_revision: 2, collection_revision: 1, context_sha256: createHash('sha256').update(content).digest('hex'), files: [{ id: file, revision: 1, sha256: hash, name: 'fixture.md', content_sha256: hash, excerpt_sha256: hash, excerpt_characters: 5, excerpt_bytes: 5, truncated: false }] };
  const response = { ok: true, result: { context: content, evidence } };
  assert.doesNotThrow(() => parseResponse(JSON.stringify(response), context.command, context));
  assert.throws(() => parseResponse(JSON.stringify({ ...response, result: { ...response.result, context: 'Changed bytes' } }), context.command, context));
  assert.throws(() => parseResponse(JSON.stringify(response), context.command, { ...context, project_id: randomUUID() }));
  assert.throws(() => parseResponse(JSON.stringify(response), context.command, { ...context, selections: [{ ...context.selections[0], revision: 2 }] }));
});

test('journal child uses fixed module and clean environment and preserves revision conflicts', async () => {
  const seen = [];
  const { transport, invocations } = transportFor((child, request) => {
    seen.push(request);
    reply(child, request.command === 'list' ? { ok: true, result: { conversations: [] } } : { ok: false, error: { code: 'REVISION_CONFLICT', message: 'Reload first.' } });
  });
  assert.deepEqual(await transport.request({ command: 'list' }), { ok: true, result: { conversations: [] } });
  const conversation = { id: 'c1', title: 'literal "$(code)"', messages: [] };
  assert.equal((await transport.request({ command: 'save', conversation, expected_revision: 2 })).error.code, 'REVISION_CONFLICT');
  assert.deepEqual(seen[1], { command: 'save', conversation, expected_revision: 2 });
  const invocation = invocations[0];
  assert.equal(invocation.executable, 'test-python');
  assert.deepEqual(invocation.args, ['-B', '-m', 'foundry.conversation_cli']);
  assert.equal(invocation.settings.shell, false);
  assert.equal(invocation.settings.windowsHide, true);
  assert.equal(invocation.settings.cwd, sourceRoot);
  assert.equal(invocation.settings.env.PYTHONPATH, undefined);
  assert.equal(invocation.settings.env.PYTHONHOME, undefined);
  assert.equal(invocation.settings.env.PYTHONNOUSERSITE, '1');
  assert.equal(invocation.settings.env.YUR_DESKTOP_HOME, path.join(sourceRoot, 'test-only-state'));
  assert.equal(invocation.settings.env.YUR_FACTORY_HOME, undefined);
});

test('invalid requests cannot start Python and malformed envelopes cannot become successful history', async () => {
  const { transport, invocations } = transportFor(() => { throw new Error('Must not spawn.'); });
  assert.equal((await transport.request({ command: 'list', mission_id: 'injected' })).error.code, 'INVALID_REQUEST');
  assert.equal(invocations.length, 0);
  for (const value of ['{}', '[]', '{"ok":true}', '{"ok":true,"result":null}', '{"ok":false,"error":"text"}', 'log\n{"ok":true,"result":{}}']) assert.throws(() => parseResponse(value));
  const invalid = transportFor(child => { child.stdout.write('not JSON'); child.emit('close', 0); }).transport;
  assert.equal((await invalid.request({ command: 'list' })).error.code, 'INVALID_RUNTIME_RESPONSE');
  const nonzero = transportFor(child => reply(child, { ok: true, result: { conversations: [] } }, 1)).transport;
  assert.equal((await nonzero.request({ command: 'list' })).error.code, 'RUNTIME_FAILED');
  const missingList = transportFor(child => reply(child, { ok: true, result: {} })).transport;
  assert.equal((await missingList.request({ command: 'list' })).error.code, 'INVALID_RUNTIME_RESPONSE');
  assert.throws(() => parseResponse('{"ok":true,"result":{"conversation":{"revision":0}}}', 'save'));
});

test('journal process deadlines, output bounds and process failures fail closed', async () => {
  const timed = transportFor(() => {}, { timeoutMs: 20 });
  assert.equal((await timed.transport.request({ command: 'list' })).error.code, 'RUNTIME_TIMEOUT');
  assert.equal(timed.invocations[0].child.killed, true);
  const oversized = transportFor(child => child.stdout.write('x'.repeat(MAX_OUTPUT_BYTES + 1)));
  assert.equal((await oversized.transport.request({ command: 'list' })).error.code, 'RESPONSE_TOO_LARGE');
  assert.equal(oversized.invocations[0].child.killed, true);
  const failed = transportFor(child => child.emit('error', new Error('private diagnostics')));
  const result = await failed.transport.request({ command: 'list' });
  assert.equal(result.error.code, 'RUNTIME_UNAVAILABLE');
  assert.doesNotMatch(result.error.message, /private diagnostics/);
});

test('preload exposes only fixed conversation and window calls', () => {
  let exposed;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, 'src/preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); } } };
    },
  });
  const conversation = { id: 'c1' };
  exposed.conversations.list(); exposed.conversations.save(conversation, 3);
  exposed.window.minimize(); exposed.window.toggleMaximize(); exposed.window.close(); exposed.foundry.info();
  assert.deepEqual(calls, [['conversations:list'], ['conversations:save', conversation, 3], ['window:minimize'], ['window:toggleMaximize'], ['window:close'], ['foundry:info']]);
  assert.deepEqual(Object.keys(exposed.conversations).sort(), ['list', 'save']);
});

test('generation and workspace preload calls keep event subscription and cancellation scoped to fixed IPC channels', () => {
  let exposed; const calls = [], listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, 'src/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } }, ipcRenderer: {
      invoke: (...args) => calls.push(args), on: (name, callback) => listeners.set(name, callback),
      removeListener: (name, callback) => { assert.equal(listeners.get(name), callback); listeners.delete(name); },
    } }),
  });
  const input = { request_id: randomUUID() }; const received = [];
  const unsubscribe = exposed.generation.onEvent(event => received.push(event));
  listeners.get('generation:event')({ privileged: true }, { ...input, text: 'delta' });
  assert.deepEqual(received, [{ ...input, text: 'delta' }]);
  unsubscribe(); assert.equal(listeners.size, 0);
  exposed.generation.start(input); exposed.generation.cancel(input.request_id);
  exposed.workspace.list('settings'); exposed.workspace.save('project', { name: 'Example' }, 2);
  exposed.attachments.read({ path: 'selected.pdf' });
  exposed.sources.describe({ query: 'reviewed', limit: 3 }); exposed.sources.acquire({ source_id: 'yur-os', relative_path: 'README.md', expected_sha256: 'a'.repeat(64) });
  assert.deepEqual(calls, [['generation:start', input], ['generation:cancel', input.request_id], ['workspace:list', 'settings'], ['workspace:save', 'project', { name: 'Example' }, 2], ['attachments:read', { path: 'selected.pdf' }], ['sources:describe', { query: 'reviewed', limit: 3 }], ['sources:acquire', { source_id: 'yur-os', relative_path: 'README.md', expected_sha256: 'a'.repeat(64) }]]);
  calls.length = 0;
  exposed.activity.snapshot();
  assert.deepEqual(calls, [['activity:snapshot']]); calls.length = 0;
  const activityEvents = [], stopActivity = exposed.activity.onEvent(value => activityEvents.push(value));
  listeners.get('activity:event')({ privileged: true }, { schema: 'yur.activity.v1' });
  assert.deepEqual(activityEvents, [{ schema: 'yur.activity.v1' }]);
  stopActivity(); assert.equal(listeners.has('activity:event'), false);
  assert.throws(() => exposed.activity.onEvent(null), /callback/);
  assert.deepEqual(Object.keys(exposed.activity).sort(), ['onEvent', 'snapshot']);
  const setup = { operation_id: randomUUID() };
  exposed.executionRuntime.check({ resource_id: null }); exposed.executionRuntime.prepare(setup); exposed.executionRuntime.inspect({ operation_id: null }); exposed.executionRuntime.release(setup);
  assert.deepEqual(calls, [['execution-runtime:check', { resource_id: null }], ['execution-runtime:prepare', setup], ['execution-runtime:inspect', { operation_id: null }], ['execution-runtime:release', setup]]);
  assert.deepEqual(Object.keys(exposed.executionRuntime).sort(), ['check', 'inspect', 'onEvent', 'prepare', 'release']);
  calls.length = 0;
  const pageSelection = { conversation_id: randomUUID() }, pageRelease = { ...pageSelection, source_id: randomUUID() };
  exposed.browser.selectForWork(pageSelection); exposed.browser.releaseWorkSource(pageRelease);
  assert.deepEqual(calls, [['browser:select-for-work', pageSelection], ['browser:release-work-source', pageRelease]]);
  const runtimeEvents = [], stopRuntime = exposed.executionRuntime.onEvent(event => runtimeEvents.push(event));
  listeners.get('execution-runtime:event')({ privileged: true }, setup); assert.deepEqual(runtimeEvents, [setup]); stopRuntime(); assert.equal(listeners.size, 0);
});

test('window, generation and journal IPC require the actual Studio main frame and saved settings bind provider origins', async () => {
  const handlers = new Map(), storageRequests = []; let window;
  class BrowserWindow {
    constructor() {
      window = this; this.maximized = false;
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(sourceRoot, 'src/studio-editor.html')).href }, on() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };
    }
    isDestroyed() { return false; } loadFile() {} on() {} show() {} focus() {}
    minimize() { this.minimized = true; } maximize() { this.maximized = true; } unmaximize() { this.maximized = false; } isMaximized() { return this.maximized; } close() { this.closed = true; }
  }
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return { app: { whenReady: () => ({ then() {} }), on() {}, getPath: () => sourceRoot }, BrowserWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }, shell: {},
        dialog: { showSaveDialog() { assert.fail('IPC authority checks must not open a Save picker'); } }, protocol: { registerSchemesAsPrivileged() {} } };
      if (name === './conversation-transport') return { createConversationTransport: () => ({ request: value => {
        storageRequests.push(value);
        return Promise.resolve({ ok: true, result: value.command === 'workspace_save' ? { document: { ...value.document, revision: value.expected_revision + 1 } } : value.command === 'workspace_list' ? { documents: [] } : { command: value.command } });
      }, dispose() {} }) };
      return require(name.startsWith('.') ? path.join(sourceRoot, 'src', name) : name);
    },
    __dirname: path.join(sourceRoot, 'src'), process: { ...process, env: { ...process.env, YUR_FOUNDRY_URL: 'http://127.0.0.1:9988', YUR_OLLAMA_URL: '' } }, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'src/main.js'), 'utf8'), context);
  vm.runInContext('createWindow()', context);
  const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  for (const channel of ['window:minimize', 'window:toggleMaximize', 'window:close', 'conversations:list', 'conversations:save', 'workspace:list', 'workspace:save', 'generation:start', 'generation:cancel', 'attachments:read', 'sources:describe', 'sources:acquire', 'schedules:list', 'schedules:save', 'schedules:events', 'schedules:status', 'voice:arm', 'voice:transcribe', 'work:steer', 'work:export-specialist', 'concepts:list', 'concepts:inspect', 'execution-runtime:check', 'execution-runtime:prepare', 'execution-runtime:inspect', 'execution-runtime:release']) {
    assert.throws(() => handlers.get(channel)({ ...trusted, sender: {} }), /Untrusted studio/);
    assert.throws(() => handlers.get(channel)({ ...trusted, senderFrame: { url: trusted.senderFrame.url } }), /Untrusted studio/);
  }
  handlers.get('window:minimize')(trusted); assert.equal(window.minimized, true);
  for (const channel of ['browser:select-for-work', 'browser:release-work-source', 'desktop:capabilities', 'activity:snapshot']) {
    assert.throws(() => handlers.get(channel)({ ...trusted, sender: {} }), /Untrusted studio/);
    assert.throws(() => handlers.get(channel)({ ...trusted, senderFrame: { url: trusted.senderFrame.url } }), /Untrusted studio/);
  }
  assert.equal(handlers.get('desktop:capabilities')(trusted, {path: 'untrusted.json'}).error.code, 'INVALID_REQUEST');
  assert.equal(handlers.get('desktop:capabilities')(trusted).result.manifest.schema, 'yur.desktop-capabilities.v1');
  assert.equal(handlers.get('activity:snapshot')(trusted, { include: 'thinking' }).error.code, 'INVALID_REQUEST');
  const activity = handlers.get('activity:snapshot')(trusted).result;
  assert.equal(activity.schema, 'yur.activity.v1'); assert.equal(activity.runs.length, 0);
  assert.equal(handlers.get('window:toggleMaximize')(trusted).maximized, true);
  assert.equal(handlers.get('window:toggleMaximize')(trusted).maximized, false);
  handlers.get('window:close')(trusted); assert.equal(window.closed, true);
  assert.equal((await handlers.get('conversations:list')(trusted)).result.command, 'list');
  const document = { id: 'desktop', theme: 'dark', default_model: 'local:fixture', foundry_url: 'https://foundry.example', ollama_url: 'http://localhost:2233', custom_instructions: '' };
  assert.equal((await handlers.get('workspace:save')(trusted, 'settings', document, 0)).ok, true);
  assert.equal(handlers.get('foundry:info')(trusted).url, 'http://127.0.0.1:9988');
  assert.equal(handlers.get('foundry:info')(trusted).configuration_source, 'environment');
  assert.equal(handlers.get('ollama:info')(trusted).url, 'http://localhost:2233');
  assert.equal(handlers.get('ollama:info')(trusted).configuration_source, 'settings');
  const beforeInvalid = storageRequests.length;
  assert.equal((await handlers.get('workspace:save')(trusted, 'settings', { ...document, ollama_url: 'http://remote.example' }, 1)).ok, false);
  assert.equal(storageRequests.length, beforeInvalid, 'Unsafe settings must be rejected before any durable write.');
  assert.equal((await handlers.get('generation:start')(trusted, {})).error.code, 'INVALID_REQUEST');
  assert.equal((await handlers.get('sources:describe')(trusted, { root: sourceRoot })).error.code, 'INVALID_REQUEST');
  assert.equal((await handlers.get('sources:acquire')(trusted, { command: 'run', source_id: 'yur-os' })).error.code, 'INVALID_REQUEST');
  assert.equal((await handlers.get('execution-runtime:check')(trusted, { command: 'run', distro: 'arbitrary' })).error.code, 'INVALID_REQUEST');
  assert.equal((await handlers.get('execution-runtime:prepare')(trusted, { command: 'run', operation_id: randomUUID() })).error.code, 'INVALID_REQUEST');
  assert.equal((await handlers.get('execution-runtime:inspect')(trusted, { operation_id: null })).result.setup, null);
  assert.equal((await handlers.get('workspace:save')(trusted, 'settings', { ...document, execution_distro: '../arbitrary' }, 1)).ok, false);
  assert.equal((await handlers.get('workspace:save')(trusted, 'settings', { ...document, execution_distro: 'Ubuntu-24.04' }, 1)).ok, true);
  assert.equal(vm.runInContext('executionSelection().distro', context), 'Ubuntu-24.04');
});

test('real Python journal preserves conversations and rejects stale revisions without creating state on an empty list', async t => {
  const temporaryBase = path.resolve(os.tmpdir());
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryBase, 'yur-conversation-transport-'));
  const stateRoot = path.join(temporaryRoot, 'journal');
  const transport = createConversationTransport({ sourceRoot, getStateRoot: () => stateRoot, getPython: () => process.env.YUR_FACTORY_PYTHON || 'python' });
  t.after(() => {
    transport.dispose();
    const relative = path.relative(temporaryBase, path.resolve(temporaryRoot));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(temporaryRoot).startsWith('yur-conversation-transport-')) throw new Error('Temporary cleanup path escaped its test directory.');
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  assert.deepEqual(await transport.request({ command: 'list' }), { ok: true, result: { conversations: [] } });
  assert.deepEqual(await transport.request({ command: 'workspace_list', kind: 'settings' }), { ok: true, result: { documents: [] } });
  assert.deepEqual(await transport.request({ command: 'workspace_list', kind: 'project' }), { ok: true, result: { documents: [] } });
  assert.equal(fs.existsSync(stateRoot), false);
  const timestamp = new Date().toISOString();
  const conversation = {
    id: randomUUID(), title: 'Existing journal transport', createdAt: timestamp, updatedAt: timestamp, model: 'foundry:auto',
    messages: [{ id: randomUUID(), role: 'user', content: 'Preserve "quoted" text, newline\n and Unicode 雪.', createdAt: timestamp }],
  };
  const saved = await transport.request({ command: 'save', conversation, expected_revision: 0 });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.result.conversation.revision, 1);
  assert.deepEqual(saved.result.conversation.messages, conversation.messages);
  const stale = await transport.request({ command: 'save', conversation: { ...conversation, title: 'Must not overwrite' }, expected_revision: 0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'CONFLICT');
  const reloaded = await transport.request({ command: 'list' });
  assert.deepEqual(reloaded.result.conversations, [saved.result.conversation]);
  const settings = { id: 'desktop', theme: 'dark', default_model: 'local:fixture', foundry_url: '', ollama_url: 'http://localhost:11434', custom_instructions: 'Use the selected source.' };
  const committedSettings = await transport.request({ command: 'workspace_save', kind: 'settings', document: settings, expected_revision: 0 });
  assert.equal(committedSettings.ok, true, JSON.stringify(committedSettings));
  assert.equal(committedSettings.result.document.revision, 1);
  assert.deepEqual((await transport.request({ command: 'workspace_list', kind: 'settings' })).result.documents, [committedSettings.result.document]);
  assert.equal((await transport.request({ command: 'workspace_save', kind: 'settings', document: settings, expected_revision: 0 })).error.code, 'CONFLICT');
  const project = { id: randomUUID(), name: 'A governed project', root: sourceRoot, instructions: 'Only use scoped source.', createdAt: timestamp, updatedAt: timestamp };
  const committedProject = await transport.request({ command: 'workspace_save', kind: 'project', document: project, expected_revision: 0 });
  assert.equal(committedProject.ok, true, JSON.stringify(committedProject));
  assert.deepEqual((await transport.request({ command: 'workspace_list', kind: 'project' })).result.documents, [committedProject.result.document]);
  assert.deepEqual((await transport.request({ command: 'list' })).result.conversations, [saved.result.conversation], 'Project/settings commits must not mutate the conversation.');
});
