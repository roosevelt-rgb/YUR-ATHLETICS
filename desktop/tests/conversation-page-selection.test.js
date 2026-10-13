'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

// Execute the real Send/removal functions against isolated UI/storage/IPC fakes.
// There is no process, model inference, network or page-body acquisition here.
const source = fs.readFileSync(path.join(__dirname, '../src/conversation-view.js'), 'utf8');
function slice(start, end) { const from = source.indexOf(start), through = source.indexOf(end, from); assert.ok(from >= 0 && through > from); return source.slice(from, through); }
function descriptor() { const now = Date.now(); return { schema: 'yur.work-browser-source.v1', source_id: randomUUID(), source_url: 'https://example.test/page', title: 'Selected page metadata', selected_at: new Date(now).toISOString(), expires_at: new Date(now + 120000).toISOString(), max_acquisitions: 1 }; }
function fixture(mode = 'work', fresh = async (_api, files) => files) {
  const id = randomUUID(), session = { id, title: 'Draft', mode, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), model: 'ollama:fixture', messages: [], draft: 'Review the selected page' };
  const input = { value: session.draft }, model = { value: session.model }, starts = [], generations = [], releases = [], saves = [], notices = [];
  const context = vm.createContext({ URL, Date, TextEncoder, crypto: { randomUUID }, window: {},
    modelSelectionJobs: new Set(), projectFileSelectionJobs: new Set(), modelReadiness: () => ({ status: 'usable' }), renderModelSetup() {},
    activeId: id, sessions: new Map([[id, session]]), pending: new Map(), correctionJobs: new Map(), attachments: new Map(), attachmentJobs: new Map(), sourceSelectionJobs: new Set(), workPageSelectionJobs: new Set(), workPageSelections: new Map(), drafts: new Map(), projects: new Map(), repositorySelections: new Map(), settings: {}, historyReady: true, workspaceReady: true, workspaceError: '', dictationState: { phase: 'idle' },
    $: name => name === 'yc-input' ? input : name === 'yc-model' ? model : {}, metadata: value => ({ mode: value?.mode || mode, project_id: null }), selectionFor: () => null, correctionMessages: () => [], canSteer: () => false, notice: value => notices.push(value), render() {}, renderHistory() {}, reconcileSteering: async () => {}, persist: async value => saves.push(JSON.parse(JSON.stringify(value))),
    api: { repository: { context: async () => ({ ok: true, result: null }) }, browser: { readVisiblePage: () => assert.fail('Send must not acquire the page eagerly'), releaseWorkSource: async request => { releases.push(request); return { ok: true, result: { released: false } }; } }, work: { start: async request => { starts.push(request); return { ok: true, result: { mission: { id: 'a'.repeat(32), request_id: request.request_id, conversation_id: request.conversation_id, status: 'completed', answer: 'Recorded fixture result' } } }; } }, generation: { start: async request => { generations.push(request); return { ok: true, result: { answer: 'Fixture chat response', provider: 'ollama', model: 'fixture' } }; } } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/browser-view.js'), 'utf8'), context);
  context.window.yurSourceContext = { selections: value => JSON.parse(JSON.stringify(value)) };
  context.window.yurComposerIntake = { fresh, evidence: file => ({ name: file.name, kind: file.kind || 'text' }) };
  context.window.yurWorkView = { reference: value => ({ mission_id: value.id, request_id: value.request_id, conversation_id: value.conversation_id, status: value.status }) };
  vm.runInContext('function current() { return sessions.get(activeId); }\n' + slice('  function queryFor(', '  function correctionMessages(') + slice('  async function send(', '  function card(') + slice('  async function removeWorkPage(', '  async function acquireAttachments('), context);
  return { context, session, input, starts, generations, releases, saves, notices, send: () => vm.runInContext('send({preventDefault(){}})', context), remove: sourceId => context.removeWorkPage(id, sourceId) };
}

test('Work and Code Send capture only a metadata descriptor and the original request/conversation, with no eager page body', async () => {
  for (const mode of ['work', 'code']) {
    const f = fixture(mode), selected = descriptor(); f.context.workPageSelections.set(f.session.id, selected);
    await f.send(); assert.equal(f.starts.length, 1); const request = f.starts[0];
    assert.equal(request.conversation_id, f.session.id); assert.match(request.request_id, /^[a-f0-9-]{36}$/); assert.equal(JSON.stringify(request.browser_source), JSON.stringify(selected));
    assert.equal(f.context.workPageSelections.has(f.session.id), false, 'The composer grant is one-shot');
    assert.equal(request.messages.length, 2); assert.equal(request.messages.some(message => message.content.includes(selected.source_url) || message.content.includes(selected.source_id)), false, 'The descriptor is not injected into model context');
    assert.equal(f.session.messages[0].evidence.work_request.request_id, request.request_id); assert.equal(f.session.messages[0].evidence.browser_source.source_id, selected.source_id);
    assert.equal(f.releases[0].source_id, selected.source_id); assert.equal(f.releases[0].conversation_id, f.session.id);
  }
});

test('a conversation switch during attachment refresh cannot move the captured grant or erase the new draft', async () => {
  let resolve; const f = fixture('work', () => new Promise(done => resolve = done)), selected = descriptor();
  f.context.workPageSelections.set(f.session.id, selected); f.context.attachments.set(f.session.id, [{ kind: 'text', name: 'notes.txt', content: 'Existing manual notes' }]);
  const pending = f.send(); const otherId = randomUUID(); f.context.sessions.set(otherId, { id: otherId, mode: 'work', messages: [], draft: 'A different new draft' }); f.context.activeId = otherId; f.input.value = 'A different new draft';
  const otherSource = descriptor(); f.context.workPageSelections.set(otherId, otherSource);
  selected.title = 'MUTATED_AFTER_SEND'; resolve([{ kind: 'text', name: 'notes.txt', content: 'Existing manual notes' }]); await pending;
  assert.equal(f.starts[0].conversation_id, f.session.id); assert.equal(f.starts[0].browser_source.title, 'Selected page metadata');
  assert.equal(f.input.value, 'A different new draft'); assert.equal(f.context.workPageSelections.get(otherId).source_id, otherSource.source_id); assert.equal(f.context.sessions.get(otherId).messages.length, 0);
});

test('Chat does not send or consume Work page permission, and historical branch evidence cannot recreate a grant', async () => {
  const chat = fixture('chat'), selected = descriptor(); chat.context.workPageSelections.set(chat.session.id, selected); await chat.send();
  assert.equal(chat.starts.length, 0); assert.equal(chat.generations.length, 1); assert.equal(Object.hasOwn(chat.generations[0], 'browser_source'), false); assert.equal(chat.context.workPageSelections.get(chat.session.id).source_id, selected.source_id); assert.equal(chat.releases.length, 0);
  const branch = fixture('work'); branch.session.messages.push({ role: 'user', content: 'An earlier turn', evidence: { browser_source: selected } }); await branch.send();
  assert.equal(branch.starts.length, 1); assert.equal(Object.hasOwn(branch.starts[0], 'browser_source'), false, 'Only the live per-conversation selection can enter a new Work request');
});

test('selection jobs block Send; expired selections do not dispatch; local removal accepts an already-expired host no-op', async () => {
  const f = fixture(), selected = descriptor(); f.context.workPageSelections.set(f.session.id, selected); f.context.workPageSelectionJobs.add(f.session.id);
  await f.send(); assert.equal(f.starts.length, 0); f.context.workPageSelectionJobs.delete(f.session.id);
  selected.selected_at = new Date(Date.now() - 120001).toISOString(); selected.expires_at = new Date(Date.now() - 1).toISOString();
  await f.send(); assert.equal(f.starts.length, 0); assert.match(f.notices.at(-1), /expired/);
  f.context.pending.set(f.session.id, {}); await f.remove(selected.source_id); assert.equal(f.releases.length, 0); f.context.pending.delete(f.session.id);
  await f.remove(selected.source_id); assert.equal(f.context.workPageSelections.has(f.session.id), false); assert.equal(f.releases[0].source_id, selected.source_id);
});

test('ordinary Work remains independent of an absent browser helper when no page was selected', async () => {
  const f = fixture(); delete f.context.window.yurBrowserView; await f.send();
  assert.equal(f.starts.length, 1); assert.equal(Object.hasOwn(f.starts[0], 'browser_source'), false);
});

test('context revision change during file acquisition preserves draft and stops before persistence or inference', async () => {
  let resolve; const f = fixture('work', () => new Promise(done => resolve = done));
  const project = { id: randomUUID(), revision: 1, root: '', name: 'Test project' };
  f.context.projects.set(project.id, project); f.context.metadata = value => ({ mode: value?.mode || 'work', project_id: project.id });
  f.context.attachments.set(f.session.id, [{ kind: 'text', name: 'notes.txt', content: 'Notes' }]);
  const pending = f.send(); project.revision = 2; resolve([{ kind: 'text', name: 'notes.txt', content: 'Notes' }]); await pending;
  assert.equal(f.starts.length, 0); assert.equal(f.generations.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.session.messages.length, 0);
  assert.equal(f.input.value, 'Review the selected page'); assert.equal(f.context.attachments.get(f.session.id).length, 1); assert.match(f.notices.at(-1), /context changed/);
});

test('unavailable model and image-in-Work rejection retain drafts and attachments before any durable request', async () => {
  const f = fixture(); f.context.modelReadiness = () => ({ status: 'selected-unavailable', message: 'Choose an available model.' }); f.context.connection = { checked: true };
  await f.send(); assert.equal(f.saves.length, 0); assert.equal(f.starts.length, 0); assert.match(f.notices.at(-1), /available model/);
  f.context.modelReadiness = () => ({ status: 'usable' }); f.context.attachments.set(f.session.id, [{ kind: 'image', name: 'image.png' }]);
  await f.send(); assert.equal(f.saves.length, 0); assert.equal(f.starts.length, 0); assert.equal(f.context.attachments.get(f.session.id).length, 1); assert.match(f.notices.at(-1), /vision-capable/); assert.equal(f.input.value, 'Review the selected page');
});

test('pending Send compiles captured preferences rather than instructions changed during the journal acknowledgment', async () => {
  const f = fixture(); f.context.settings = { revision: 1, custom_instructions: 'ORIGINAL_OPERATOR_INSTRUCTIONS' };
  let resolve, saves = 0;
  f.context.persist = async () => { if (++saves === 1) await new Promise(done => { resolve = done; }); };
  const pending = f.send(); f.context.settings = { revision: 2, custom_instructions: 'LATER_OPERATOR_INSTRUCTIONS' }; resolve(); await pending;
  assert.equal(f.starts.length, 1); const compiled = JSON.stringify(f.starts[0].messages);
  assert.match(compiled, /ORIGINAL_OPERATOR_INSTRUCTIONS/); assert.doesNotMatch(compiled, /LATER_OPERATOR_INSTRUCTIONS/); assert.equal(f.session.messages[0].evidence.workspace_settings_revision, 1);
});

test('removed or changed project references stop before journal admission and preserve the selected version', async () => {
  const f = fixture(), project = { id: randomUUID(), revision: 1, root: '', name: 'Project' };
  f.context.projects.set(project.id, project); f.context.metadata = () => ({ mode: 'work', project_id: project.id });
  const refs = { project_id: project.id, files: [{ file_id: randomUUID(), revision: 1, sha256: 'a'.repeat(64) }] }; f.session.project_file_selections = refs;
  let received; f.context.api.projectFiles = { context: async request => { received = request; return { ok: false, error: { message: 'The selected project file was removed.' } }; } };
  await f.send(); assert.equal(f.starts.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.session.messages.length, 0); assert.equal(f.input.value, 'Review the selected page'); assert.deepEqual(f.session.project_file_selections, refs);
  assert.equal(received.project_id, project.id); assert.equal(received.selections[0].sha256, refs.files[0].sha256); assert.match(f.notices.at(-1), /removed/);
});
