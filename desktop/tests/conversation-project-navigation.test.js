'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

// Exercise actual renderer functions with deferred journal acknowledgments.
// No filesystem acquisition, model, Electron window or worker is started.
const source = fs.readFileSync(path.join(__dirname, '../src/conversation-view.js'), 'utf8');
function implementation(name) {
  const pattern = new RegExp('^  (?:async )?function ' + name + '\\(', 'm'), match = pattern.exec(source);
  assert.ok(match, 'Missing production function ' + name);
  const following = /^  (?:async )?function /m.exec(source.slice(match.index + match[0].length));
  assert.ok(following, 'Missing boundary after ' + name);
  return source.slice(match.index, match.index + match[0].length + following.index);
}
function all(node) { return [node, ...node.children.flatMap(all)]; }
function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
  const data = /^(?:button)?\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (data) { const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return Object.hasOwn(node.dataset, key) && (data[2] === undefined || node.dataset[key] === data[2]); }
  return node.tagName === selector;
}
class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = {}; this.className = ''; this.value = ''; this._text = ''; this.disabled = false;
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, enabled) => { const names = new Set(this.className.split(' ').filter(Boolean)); const desired = enabled === undefined ? !names.has(name) : enabled; if (desired) names.add(name); else names.delete(name); this.className = [...names].join(' '); return desired; },
      add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false),
    };
  }
  get options() { return this.children; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(value) { this.replaceChildren(); this._html = String(value); }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, target) { child.remove(); const index = this.children.indexOf(target); child.parentNode = this; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelectorAll(selector) {
    const split = selector.indexOf(' ');
    if (split > 0) return this.querySelectorAll(selector.slice(0, split)).flatMap(node => node.querySelectorAll(selector.slice(split + 1)));
    return all(this).slice(1).filter(node => matches(node, selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
}
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ deferred = false } = {}) {
  const timestamp = new Date().toISOString();
  const project = { id: randomUUID(), name: 'Quantity project', root: 'C:\\synthetic-project', instructions: 'Inspect stated quantities.', createdAt: timestamp, updatedAt: timestamp, revision: 2 };
  const otherProject = { ...project, id: randomUUID(), name: 'Independent project', root: 'C:\\other-synthetic-project' };
  const session = { id: randomUUID(), title: 'Retained conversation', createdAt: timestamp, updatedAt: timestamp, model: 'ollama:existing', messages: [{ id: randomUUID(), role: 'user', content: 'Earlier message', createdAt: timestamp }], draft: 'Retain this draft', metadata: { mode: 'chat', project_id: otherProject.id, pinned: false, archived: false, parent_id: null }, revision: 3 };
  const root = new Node('main'), nodes = new Map(), saves = [], notices = [], activated = [], navigation = [], scheduled = [], reads = [];
  const get = id => { if (!nodes.has(id)) { const node = new Node(id === 'yc-mode' || id === 'yc-project' || id === 'yc-model' ? 'select' : 'div'); node.id = id; nodes.set(id, node); root.appendChild(node); } return nodes.get(id); };
  get('yc-input').value = session.draft; get('yc-model').value = session.model;
  for (const mode of ['chat', 'work', 'code']) { const button = new Node('button'); button.dataset.mode = mode; get('yc-mode-switch').appendChild(button); }
  const defaults = { mode: 'chat', project_id: null, pinned: false, archived: false, parent_id: null };
  const context = vm.createContext({ Date, TextEncoder, crypto: { randomUUID }, clearTimeout, setTimeout, document: { createElement: tag => new Node(tag) }, window: { innerWidth: 1440, matchMedia: () => ({ matches: false }), yurWorkspace: { hide() {}, setTheme() {} } }, root, $: get,
    activeId: session.id, sessions: new Map([[session.id, session]]), projects: new Map([[project.id, project], [otherProject.id, otherProject]]), metadataDefaults: defaults,
    transcriptPosition: { capture() {}, before: () => ({}), after() {} }, renderedMessagesId: null, messageNodes: new Map(), modelSelectionJobs: new Set(), activityView: null, recentWorkView: null, productionView: null, settingsModelSetupView: null, speechState: { available: false }, renderModelSetup() {},
    projectFilesView: null, settingsView: null, projectFileSelectionJobs: new Set(), projectFileMutations: new Map(), workspaceLoadGeneration: 0, modelChoiceGeneration: 0,
    settings: { id: 'desktop', default_model: 'ollama:preferred', theme: 'light' }, defaultSettings: { id: 'desktop', default_model: '', theme: 'system' },
    pending: new Map(), attachmentJobs: new Map(), sourceSelectionJobs: new Set(), workPageSelectionJobs: new Set(), correctionJobs: new Map(), attachments: new Map(), workPageSelections: new Map(),
    repositorySelections: new Map(), instructionSelections: new Map(), workforceSelections: new Map(), drafts: new Map([[session.id, session.draft]]), draftTimers: new Map(), persistence: new Map(), unsaved: new Set(), saveErrors: new Map(),
    historyReady: true, workspaceReady: true, workspaceError: '', projectHomeId: null, projectCreationPending: false, currentSection: null, showArchived: false, dictationState: { phase: 'idle' }, schedulesView: null, mediaView: null, musicView: null, unrealView: null, executionRuntimeView: null,
    icon: () => '', notice: message => notices.push(message), render() {}, renderHistory() {}, renderAttachments() {}, appendContent: (node, content) => { node.textContent = content; }, sections: { agents: { title: 'Agents' } }, updateModelNote() {}, updateSendControl() {}, stopVoice() {}, toggleDetails() {}, applyTheme() {}, reconcileSteering: async () => {}, editProject() {}, conversationOptions() {},
    selectionFor(selected, kind) { const map = kind === 'repository' ? context.repositorySelections : kind === 'instruction' ? context.instructionSelections : context.workforceSelections; return map.get(selected.id) || null; },
    activate(id) { activated.push(id); context.activeId = id; get('yc-input').value = context.sessions.get(id).draft || ''; context.currentSection = null; },
    openPreferences(kind, id) { navigation.push({ kind, id }); context.currentSection = kind; context.projectHomeId = id || null; },
    scheduleDraft(selected) { scheduled.push(selected.id); void context.persist(selected).catch(error => notices.push(error.message)); },
    api: {
      conversations: { save(document, revision) { const call = { document: copy(document), revision }; saves.push(call); if (deferred) return new Promise(resolve => { call.resolve = resolve; }); return Promise.resolve({ ok: true, result: { conversation: { ...copy(document), revision: revision + 1 } } }); }, list: async () => { reads.push('conversations'); return { ok: true, result: { conversations: [copy(session)] } }; } },
      workspace: { list: async kind => { reads.push(kind); return { ok: true, result: { documents: kind === 'project' ? [copy(project), copy(otherProject)] : [{ id: 'desktop', theme: 'light', default_model: 'ollama:preferred', revision: 1 }] } }; } },
      repository: { context() { assert.fail('Navigation/reload must not acquire repository content'); } }, attachments: { read() { assert.fail('Navigation/reload must not read project files'); } }, work: { start() { assert.fail('Navigation must not start Work'); } }, generation: { start() { assert.fail('Navigation must not call a model'); } },
    },
  });
  for (const name of ['current', 'metadata', 'rememberDraft', 'persist', 'assignProject', 'renderProjectOptions', 'renderProjectSidebar', 'openProjectHome', 'openPreferences', 'startProjectConversation', 'renderProjectHome', 'renderProjectFiles', 'refreshProjectConversations', 'renderProjectConversations', 'renderMessages', 'setConversationMode', 'renderModeSwitch', 'loadWorkspace', 'loadHistory']) vm.runInContext(implementation(name), context);
  return { context, project, otherProject, session, nodes, get, saves, notices, activated, navigation, scheduled, reads,
    settle(index, ok = true) { const call = saves[index]; call.resolve(ok ? { ok: true, result: { conversation: { ...call.document, revision: call.revision + 1 } } } : { ok: false, error: { message: 'Synthetic storage failure' } }); },
  };
}

test('the composer waits for saved settings and applied theme before becoming ready after reload', async () => {
  const f = fixture(); let deliver, appliedTheme;
  f.context.workspaceReady = false;
  f.context.canSteer = () => false; f.context.acceptedWork = () => null;
  f.context.applyTheme = () => { appliedTheme = f.context.settings.theme; };
  vm.runInContext(implementation('updateSendControl'), f.context);
  f.context.api.workspace.list = kind => kind === 'project'
    ? Promise.resolve({ ok: true, result: { documents: [copy(f.project)] } })
    : new Promise(resolve => { deliver = resolve; });
  f.context.updateSendControl();
  assert.equal(f.get('yc-send').disabled, true, 'Loaded history alone must not enable sending.');
  const loading = f.context.loadWorkspace();
  assert.equal(f.get('yc-send').disabled, true);
  deliver({ ok: true, result: { documents: [{ id: 'desktop', theme: 'dark', default_model: '', revision: 2 }] } });
  await loading;
  assert.equal(appliedTheme, 'dark');
  assert.equal(f.get('yc-send').disabled, false);
});

test('Franklin reports canonical visible sections and the open project without acquiring files', () => {
  const f = fixture(), start = source.indexOf('  function desktopNavigationSnapshot()'), end = source.indexOf('  api.franklin?.onHostRequest', start);
  f.context.document.getElementById = id => id === 'rc6-panel' ? null : f.get(id);
  f.context.detailsOpen = false; f.context.detailTab = 'browser'; f.context.workforceMode = false;
  vm.runInContext(source.slice(start, end), f.context);
  for (const [section, view] of [['tools', 'capabilities'], ['lifecycles', 'deployed-agents'], ['project', 'projects'], ['media', 'media'], ['settings', 'settings'], [null, 'conversation']]) {
    f.context.currentSection = section; assert.equal(f.context.desktopNavigationSnapshot().view, view);
  }
  f.context.currentSection = 'agents'; f.context.workforceMode = true;
  assert.equal(f.context.desktopNavigationSnapshot().view, 'workforce');
  f.context.currentSection = 'files'; f.get('yc-intelliflow-workspace-host').hidden = true;
  assert.equal(f.context.desktopNavigationSnapshot().view, 'editor');
  f.get('yc-intelliflow-workspace-host').hidden = false;
  assert.equal(f.context.desktopNavigationSnapshot().view, 'coding');
  f.context.detailsOpen = true; assert.equal(f.context.desktopNavigationSnapshot().view, 'browser');
  f.context.projectHomeId = f.otherProject.id;
  assert.equal(f.context.desktopNavigationSnapshot().selected_project.id, f.otherProject.id);
  assert.equal(f.reads.length, 0);
});

test('history retry also recovers failed workspace readiness and retains retry after partial recovery', async () => {
  const f = fixture(); let deliverSettings;
  f.context.historyReady = false; f.context.workspaceReady = false;
  f.context.canSteer = () => false; f.context.acceptedWork = () => null;
  for (const name of ['notice', 'updateSendControl']) vm.runInContext(implementation(name), f.context);
  f.context.render = () => f.context.updateSendControl();
  const workspaceList = f.context.api.workspace.list;
  f.context.api.workspace.list = kind => kind === 'settings'
    ? new Promise(resolve => { deliverSettings = resolve; }) : workspaceList(kind);
  const start = source.indexOf("  $('yc-retry-journal').addEventListener('click'");
  const end = source.indexOf("  $('yc-new-chat').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), f.context);
  f.context.notice('Journal unavailable'); f.context.updateSendControl();
  assert.equal(f.get('yc-retry-journal').textContent, 'Retry history');
  const retry = f.get('yc-retry-journal').listeners.click(); await tick();
  assert.equal(f.context.historyReady, true);
  assert.equal(f.get('yc-send').disabled, true, 'History alone must not enable sending before settings resolve.');
  deliverSettings({ ok: false, error: { message: 'Workspace still unavailable' } }); await retry;
  assert.equal(f.get('yc-send').disabled, true);
  assert.equal(f.get('yc-notice').textContent, 'Workspace still unavailable');
  assert.equal(f.get('yc-retry-journal').classList.contains('yc-hidden'), false);
  assert.equal(f.get('yc-retry-journal').textContent, 'Retry workspace');
  assert.equal(f.get('yc-retry-journal').disabled, false);
  f.context.api.workspace.list = workspaceList;
  await f.get('yc-retry-journal').listeners.click();
  assert.equal(f.context.workspaceReady, true);
  assert.equal(f.get('yc-send').disabled, false);
  assert.equal(f.get('yc-retry-journal').classList.contains('yc-hidden'), true);
  assert.equal(f.reads.filter(kind => kind === 'conversations').length, 1, 'Workspace retry does not reload recovered history.');
  assert.equal(f.saves.length, 0, 'Readiness recovery must not save or duplicate conversations.');
  assert.equal(f.get('yc-input').value, f.session.draft);
});

test('agent readiness cannot dispatch after navigation or model changes, and failure preserves the draft', async () => {
  for (const change of ['navigation', 'model', 'offline', 'ready']) {
    const f = fixture(); let callback, resolve, sends = 0;
    f.context.currentSection = 'agents'; f.context.specialistForge = null;
    f.context.forgeReadiness = () => ({ status: 'usable', busy: false });
    f.context.renderSection = () => {};
    f.context.api.ollama = { workReadiness: () => new Promise(done => { resolve = done; }) };
    f.context.window.YurSpecialistForgeView = { mount(_host, options) { callback = options.onBuild; return { focus() {} }; }, buildPresentation: () => 'Build sample' };
    f.context.send = () => { sends++; };
    vm.runInContext(implementation('openSpecialistForge'), f.context);
    f.context.openSpecialistForge();
    const operation = callback({ name: 'New helper' });
    assert.equal(f.context.sessions.size, 1); assert.equal(sends, 0);
    if (change === 'navigation') f.context.currentSection = 'settings';
    if (change === 'model') f.session.model = 'ollama:changed';
    resolve({ ready: change !== 'offline', message: 'Provider unavailable' });
    if (change === 'ready') { await operation; assert.equal(sends, 1); assert.equal(f.context.sessions.size, 2); }
    else { await assert.rejects(operation, /changed|unavailable/); assert.equal(sends, 0); assert.equal(f.context.sessions.size, 1); }
    assert.equal(f.session.draft, 'Retain this draft');
  }
});

test('project sidebar browsing opens a workspace without moving or saving the active conversation', () => {
  const f = fixture(), before = copy(f.session); f.context.renderProjectSidebar();
  const button = f.get('yc-sidebar-projects-list').querySelector(`[data-project-id="${f.project.id}"]`); assert.ok(button); button.listeners.click();
  assert.deepEqual(copy(f.session), before); assert.equal(f.saves.length, 0); assert.equal(f.context.activeId, f.session.id);
  assert.equal(f.context.projectHomeId, f.project.id); assert.equal(f.get('yc-thread-title').textContent, f.project.name); assert.equal(f.reads.length, 0);
});

test('project navigation disposes the open Activity view before replacing its panel', () => {
  const f = fixture(), before = copy(f.session), marker = new Node('section'); let disposed = 0;
  f.context.api.activity = {};
  f.context.window.yurActivityView = { create(panel) {
    panel.appendChild(marker);
    return { dispose() { assert.equal(marker.parentNode, panel, 'Dispose must precede panel replacement'); disposed++; marker.remove(); } };
  } };
  f.context.openPreferences('activity'); assert.ok(f.context.activityView); assert.equal(disposed, 0);
  f.context.openProjectHome(f.project.id);
  assert.equal(disposed, 1); assert.equal(f.context.activityView, null); assert.equal(marker.parentNode, null);
  f.context.openProjectHome(f.otherProject.id); assert.equal(disposed, 1);
  assert.deepEqual(copy(f.session), before); assert.equal(f.context.activeId, f.session.id);
  assert.equal(f.saves.length, 0); assert.equal(f.reads.length, 0);
});

test('project navigation disposes Music and Unreal subscriptions before replacing their panel', () => {
  for (const name of ['musicView', 'unrealView']) {
    const f = fixture(), before = copy(f.session), panel = f.get('yc-preferences-panel'), marker = new Node('section'); let disposed = 0;
    panel.appendChild(marker);
    f.context[name] = { dispose() { assert.equal(marker.parentNode, panel, 'Dispose must precede panel replacement'); disposed++; marker.remove(); } };
    f.context.openProjectHome(f.project.id);
    assert.equal(disposed, 1); assert.equal(f.context[name], null); assert.equal(marker.parentNode, null);
    f.context.openProjectHome(f.otherProject.id); assert.equal(disposed, 1);
    assert.deepEqual(copy(f.session), before); assert.equal(f.saves.length, 0); assert.equal(f.reads.length, 0);
  }
});

test('project navigation disposes the mounted Production view before replacing its panel', () => {
  const f = fixture(), before = copy(f.session), marker = new Node('section'); let disposed = 0;
  f.context.api.activity = {}; f.context.api.lifecycles = {}; f.context.api.ship = {};
  f.context.window.yurProductionView = { create(panel, options) {
    assert.equal(options.api, f.context.api);
    panel.appendChild(marker);
    return { dispose() { assert.equal(marker.parentNode, panel, 'Dispose must precede panel replacement'); disposed++; marker.remove(); } };
  } };
  f.context.openPreferences('production'); assert.ok(f.context.productionView); assert.equal(disposed, 0);
  assert.equal(f.context.currentSection, 'production');
  f.context.openProjectHome(f.project.id);
  assert.equal(disposed, 1); assert.equal(f.context.productionView, null); assert.equal(marker.parentNode, null);
  f.context.openProjectHome(f.otherProject.id); assert.equal(disposed, 1);
  assert.deepEqual(copy(f.session), before); assert.equal(f.context.activeId, f.session.id);
  assert.equal(f.saves.length, 0); assert.equal(f.reads.length, 0);
});

test('late conversation message redraw preserves the project-home heading without changing membership', () => {
  const f = fixture(), before = copy(f.session); f.context.openProjectHome(f.project.id);
  assert.doesNotThrow(() => f.context.renderMessages());
  assert.equal(f.get('yc-thread-title').textContent, f.project.name); assert.equal(f.context.currentSection, 'project'); assert.deepEqual(copy(f.session), before); assert.equal(f.saves.length, 0);
});

test('each explicit project mode creates and commits a fresh isolated conversation before activating it', async () => {
  for (const mode of ['chat', 'work', 'code']) {
    const f = fixture({ deferred: true }), old = copy(f.session);
    const empty = { ...copy(f.session), id: randomUUID(), messages: [], draft: '', metadata: { ...f.session.metadata, project_id: f.project.id, mode } }; f.context.sessions.set(empty.id, empty);
    f.context.attachments.set(f.session.id, [{ name: 'private-existing-file.txt' }]); f.context.repositorySelections.set(f.session.id, { root: 'C:\\existing-selection' }); f.context.workPageSelections.set(f.session.id, { source_id: randomUUID() });
    const operation = f.context.startProjectConversation(f.project.id, mode); await tick();
    assert.equal(f.saves.length, 1); const saved = f.saves[0].document;
    assert.notEqual(saved.id, f.session.id); assert.notEqual(saved.id, empty.id); assert.equal(saved.metadata.project_id, f.project.id); assert.equal(saved.metadata.mode, mode); assert.equal(saved.model, 'ollama:preferred');
    assert.deepEqual(saved.messages, []); assert.equal(saved.draft, ''); assert.equal(saved.metadata.parent_id, null); assert.equal(f.saves[0].revision, 0); assert.equal(f.activated.length, 0);
    await f.context.startProjectConversation(f.otherProject.id, 'code'); assert.equal(f.saves.length, 1, 'Duplicate clicks cannot create concurrent project drafts');
    f.settle(0); await operation; assert.equal(f.activated.at(-1), saved.id); assert.equal(f.context.sessions.get(saved.id).revision, 1); assert.deepEqual(copy(f.session), old);
    for (const map of [f.context.attachments, f.context.repositorySelections, f.context.workPageSelections]) assert.equal(map.has(saved.id), false);
    assert.equal(f.reads.length, 0);
  }
});

test('failed project draft persistence retains one unsaved UUID for Retry save without changing the previous conversation', async () => {
  const f = fixture({ deferred: true }), before = copy(f.session), operation = f.context.startProjectConversation(f.project.id, 'work'); await tick();
  f.settle(0, false); await assert.rejects(operation, /Synthetic storage failure/);
  const savedId = f.saves[0].document.id;
  assert.equal(f.context.activeId, savedId); assert.equal(f.context.sessions.get(savedId).revision, 0); assert.deepEqual(copy(f.session), before); assert.match(f.notices.join('\n'), /Synthetic storage failure/); assert.equal(f.context.projectCreationPending, false);
  const retry = f.context.persist(f.context.sessions.get(savedId)); await tick(); assert.equal(f.saves[1].document.id, savedId); assert.equal(f.saves[1].revision, 0); f.settle(1); await retry;
  assert.equal(f.context.sessions.get(savedId).revision, 1); assert.equal(f.context.saveErrors.has(savedId), false);
});

test('a deferred project draft acknowledgment cannot steal navigation or erase a different conversation draft', async () => {
  const f = fixture({ deferred: true }); f.context.openProjectHome(f.project.id);
  const operation = f.context.startProjectConversation(f.project.id, 'code'); await tick();
  const other = { ...copy(f.session), id: randomUUID(), draft: 'Changed while saving', metadata: { ...f.session.metadata, mode: 'chat' } }; f.context.sessions.set(other.id, other); f.context.activate(other.id); f.context.openProjectHome(f.otherProject.id);
  f.settle(0); await operation;
  assert.equal(f.context.activeId, other.id); assert.equal(f.context.projectHomeId, f.otherProject.id); assert.equal(f.get('yc-input').value, 'Changed while saving'); assert.equal(f.context.sessions.get(f.saves[0].document.id).metadata.project_id, f.project.id);
});

test('project home lists only its unarchived conversations and opening history grants no source access', () => {
  const f = fixture(), panel = new Node('section');
  const first = { ...copy(f.session), id: randomUUID(), title: 'Pinned project code', metadata: { ...f.session.metadata, project_id: f.project.id, mode: 'code', pinned: true } };
  const second = { ...copy(first), id: randomUUID(), title: 'Other project chat', metadata: { ...first.metadata, pinned: false, mode: 'chat' } };
  const archived = { ...copy(first), id: randomUUID(), title: 'Archived project chat', metadata: { ...first.metadata, archived: true } };
  for (const item of [second, archived, first]) f.context.sessions.set(item.id, item);
  f.context.renderProjectHome(panel, f.project);
  const links = panel.querySelectorAll('.yc-project-conversation'); assert.deepEqual(links.map(node => node.dataset.conversationId), [first.id, second.id]);
  assert.match(panel.textContent, /1 archived conversation remains/); assert.doesNotMatch(panel.textContent, /Retained conversation|Archived project chat/);
  links[0].listeners.click(); assert.equal(f.context.activeId, first.id); assert.equal(f.saves.length, 0); assert.equal(f.reads.length, 0);
  const draft = { ...copy(second), id: randomUUID(), title: 'New code conversation', messages: [], draft: 'Stored draft preview' };
  const longDraft = { ...copy(draft), id: randomUUID(), draft: 'Project draft ' + 'x'.repeat(400) };
  f.context.sessions.set(draft.id, draft); f.context.sessions.set(longDraft.id, longDraft); f.context.drafts.set(draft.id, '  Current\n  unsent draft review  ');
  const original = copy(draft); panel.replaceChildren(); f.context.renderProjectHome(panel, f.project);
  const draftLink = panel.querySelector(`[data-conversation-id="${draft.id}"]`), longLink = panel.querySelector(`[data-conversation-id="${longDraft.id}"]`);
  assert.match(draftLink.children[0].textContent, /Draft.*Current unsent draft review/); assert.doesNotMatch(draftLink.children[0].textContent, /New code conversation|Stored draft preview/);
  assert.match(longLink.children[0].textContent, /Draft.*Project draft/); assert.ok(longLink.children[0].textContent.length <= 110, 'Draft previews must remain bounded in project history');
  f.context.drafts.set(draft.id, ''); panel.replaceChildren(); f.context.renderProjectHome(panel, f.project);
  assert.equal(panel.querySelector(`[data-conversation-id="${draft.id}"]`).children[0].textContent, 'Draft · New code conversation', 'An explicitly cleared live draft must not revive its stale saved preview');
  assert.deepEqual(copy(draft), original); assert.equal(f.saves.length, 0); assert.equal(f.reads.length, 0);
});

function managementFixture() {
  const f = fixture({ deferred: true });
  const managed = { ...copy(f.session), id: randomUUID(), title: 'Before rename', metadata: { ...f.session.metadata, project_id: f.project.id } };
  f.context.sessions.set(managed.id, managed);
  f.context.acceptedWork = () => null; f.context.renderVoiceControls = () => {}; f.context.renderPreferenceStatus = () => {};
  f.context.detailsOpen = false; f.context.detailTab = 'work';
  // Keep the actual menu callback, journal queue, renderer and project list.
  // Only the modal input surface and unrelated history list are substituted.
  f.context.renderHistory = () => f.context.renderProjectSidebar();
  f.context.dialog = (_title, _label, _setup, submit) => { f.submit = submit; };
  for (const name of ['conversationOptions', 'render']) vm.runInContext(implementation(name), f.context);
  f.context.openProjectHome(f.project.id);
  f.manage = () => f.get('yc-preferences-panel').querySelector(`[data-conversation-id="${managed.id}"]`).parentNode.querySelector('.yc-history-menu').listeners.click();
  return Object.assign(f, { managed });
}

test('project row menu save refreshes renamed, pinned and archived rows after the real persistence acknowledgment', async () => {
  const f = managementFixture(), before = copy(f.session), panel = f.get('yc-preferences-panel');
  const home = panel.querySelector('#yc-project-home'), actions = home.querySelector('.yc-project-starts');
  f.manage(); const rename = f.submit({ title: { value: 'After rename' }, pinned: { checked: true }, archived: { checked: false } });
  await tick(); assert.equal(panel.querySelector(`[data-conversation-id="${f.managed.id}"]`).title, 'Before rename');
  f.settle(0); await rename;
  const renamed = panel.querySelector(`[data-conversation-id="${f.managed.id}"]`);
  assert.equal(renamed.title, 'After rename'); assert.match(renamed.textContent, /^◆ After rename/);
  assert.equal(panel.querySelector('#yc-project-home'), home); assert.equal(home.querySelector('.yc-project-starts'), actions, 'Management updates must preserve the home and its controls');
  f.manage(); const archive = f.submit({ title: { value: 'After rename' }, pinned: { checked: true }, archived: { checked: true } });
  await tick(); f.settle(1); await archive;
  assert.equal(panel.querySelector(`[data-conversation-id="${f.managed.id}"]`), null); assert.match(home.textContent, /1 archived conversation remains/);
  assert.equal(f.context.projectHomeId, f.project.id); assert.equal(f.context.activeId, f.session.id); assert.deepEqual(copy(f.session), before);
  assert.equal(f.get('yc-input').value, before.draft); assert.equal(f.saves.length, 2); assert.equal(f.reads.length, 0);
});

test('project row management acknowledgment preserves a different project or section selected while saving', async () => {
  for (const destination of ['other-project', 'project-grid']) {
    const f = managementFixture(); f.manage();
    const operation = f.submit({ title: { value: 'Saved in the background' }, pinned: { checked: false }, archived: { checked: true } });
    await tick();
    if (destination === 'other-project') f.context.openProjectHome(f.otherProject.id); else f.context.openPreferences('project');
    const selectedHome = f.context.projectHomeId, section = f.context.currentSection;
    const panel = f.get('yc-preferences-panel'), first = panel.children[0], input = f.get('yc-input').value;
    f.settle(0); await operation;
    assert.equal(f.context.projectHomeId, selectedHome); assert.equal(f.context.currentSection, section); assert.equal(panel.children[0], first);
    assert.equal(f.get('yc-input').value, input); assert.equal(f.context.activeId, f.session.id);
    assert.equal(panel.querySelector(`[data-conversation-id="${f.managed.id}"]`), null);
    assert.equal(f.managed.metadata.archived, true); assert.equal(f.managed.revision, 4);
  }
});

test('header mode changes persist only the current mode and cannot change an active mission', async () => {
  const f = fixture(); f.context.setConversationMode('code'); await tick();
  assert.equal(f.session.metadata.mode, 'code'); assert.equal(f.session.metadata.project_id, f.otherProject.id); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].revision, 3);
  const before = copy(f.session); f.context.pending.set(f.session.id, { route: 'work', request_id: randomUUID() }); f.context.setConversationMode('chat'); await tick();
  assert.deepEqual(copy(f.session), before); assert.equal(f.saves.length, 1); f.context.renderModeSwitch();
  assert.ok(f.get('yc-mode-switch').children.every(button => button.disabled));
  f.context.pending.clear();
  for (const jobs of [f.context.attachmentJobs, f.context.sourceSelectionJobs, f.context.workPageSelectionJobs]) {
    if (jobs instanceof Map) jobs.set(f.session.id, {}); else jobs.add(f.session.id);
    assert.equal(f.context.setConversationMode('work'), false); assert.equal(f.session.metadata.mode, 'code'); jobs.delete(f.session.id);
  }
  f.context.currentSection = 'project'; assert.equal(f.context.setConversationMode('chat'), false); assert.equal(f.session.metadata.mode, 'code'); assert.equal(f.saves.length, 1);
});

test('explicit project assignment preserves messages and commits membership using the existing journal revision', async () => {
  const f = fixture(), originalMessages = copy(f.session.messages); f.context.repositorySelections.set(f.session.id, { root: f.otherProject.root });
  const line = source.split(/\r?\n/).find(value => value.includes("$('yc-project').addEventListener('change'")); assert.ok(line, 'Existing project selection remains wired'); vm.runInContext(line, f.context);
  f.get('yc-project').value = f.project.id; await f.get('yc-project').listeners.change(); await tick();
  assert.equal(f.session.metadata.project_id, f.project.id); assert.deepEqual(copy(f.session.messages), originalMessages); assert.equal(f.context.repositorySelections.get(f.session.id), null);
  assert.equal(f.saves[0].document.metadata.project_id, f.project.id); assert.equal(f.saves[0].revision, 3); assert.equal(f.reads.length, 0);
});

test('workspace and conversation reload restore project membership without acquiring sources or granting tools', async () => {
  const f = fixture(); f.context.projects.clear(); f.context.sessions.clear();
  await f.context.loadWorkspace(); await f.context.loadHistory();
  assert.equal(f.context.projects.get(f.project.id).root, f.project.root); assert.equal(f.context.sessions.get(f.session.id).metadata.project_id, f.otherProject.id); assert.deepEqual(f.reads.sort(), ['conversations', 'project', 'settings']);
  assert.equal(f.saves.length, 0); assert.equal(f.context.repositorySelections.size, 0); assert.equal(f.context.workPageSelections.size, 0);
});

test('late workspace loading cannot replace an explicit model choice or a newer committed setting', async () => {
  const f = fixture(); f.session.messages = []; f.session.draft = ''; f.context.settings.revision = 1;
  let deliver;
  f.context.api.workspace.list = async kind => kind === 'project' ? { ok: true, result: { documents: [copy(f.project)] } } : new Promise(resolve => { deliver = resolve; });
  const operation = f.context.loadWorkspace();
  f.session.model = 'ollama:explicit-choice'; f.context.modelChoiceGeneration++;
  f.context.settings = { id: 'desktop', revision: 3, default_model: 'ollama:newer-default', theme: 'dark' };
  deliver({ ok: true, result: { documents: [{ id: 'desktop', revision: 2, default_model: 'ollama:older-default', theme: 'light' }] } });
  await operation;
  assert.equal(f.session.model, 'ollama:explicit-choice'); assert.equal(f.context.settings.default_model, 'ollama:newer-default'); assert.equal(f.context.settings.revision, 3); assert.equal(f.activated.length, 0);
});

test('late saved-default loading updates the model without leaving the current workspace section', async () => {
  for (const section of ['agents', 'settings', 'project']) {
    const f = fixture(); f.session.messages = []; f.session.draft = ''; f.context.drafts.set(f.session.id, ''); f.get('yc-input').value = '';
    let deliver, modelUpdates = 0;
    f.context.updateModelNote = () => { modelUpdates++; };
    f.context.api.workspace.list = kind => kind === 'project' ? Promise.resolve({ ok: true, result: { documents: [copy(f.project)] } }) : new Promise(resolve => { deliver = resolve; });
    const operation = f.context.loadWorkspace();
    f.context.currentSection = section; f.context.projectHomeId = section === 'project' ? f.project.id : null;
    f.get('yc-thread-title').textContent = `Retained ${section} heading`;
    deliver({ ok: true, result: { documents: [{ id: 'desktop', revision: 1, default_model: 'ollama:loaded-default', theme: 'light' }] } });
    await operation;
    assert.equal(f.context.currentSection, section); assert.equal(f.context.projectHomeId, section === 'project' ? f.project.id : null);
    assert.equal(f.get('yc-thread-title').textContent, `Retained ${section} heading`); assert.equal(f.activated.length, 0);
    assert.equal(f.session.model, 'ollama:loaded-default'); assert.equal(f.get('yc-model').value, 'ollama:loaded-default');
    assert.ok(f.get('yc-model').options.some(option => option.value === 'ollama:loaded-default'));
    assert.equal(modelUpdates, 1); assert.equal(f.session.draft, ''); assert.equal(f.saves.length, 0);
  }
});

test('a default-save failure remains visible after model setup hides and never leaks into another conversation', async () => {
  for (const switchConversation of [false, true]) {
    const f = fixture(), selected = 'ollama:available', priorDefault = f.context.settings.default_model;
    let rejectDefault; const settingsSaves = [];
    f.context.window.yurModelSetup = { create: () => ({ update() {} }) };
    f.context.modelSetupView = null;
    f.context.modelSetupActions = () => ({});
    f.context.specialistForgeOpen = false;
    f.context.modelReadiness = () => ({ status: f.context.current().model === selected ? 'usable' : 'selected-unavailable', busy: false, models: [{ id: selected, label: 'Available model', available: true, supported: true }] });
    f.context.api.workspace.save = (kind, document, revision) => {
      settingsSaves.push({ kind, document: copy(document), revision });
      return new Promise(resolve => { rejectDefault = () => resolve({ ok: false, error: { message: 'Synthetic default storage failure' } }); });
    };
    for (const name of ['notice', 'saveWorkspace', 'renderForgeModelSetup', 'renderModelSetup', 'chooseModel']) vm.runInContext(implementation(name), f.context);
    f.context.render = () => f.context.renderModelSetup(); f.context.updateModelNote = () => f.context.renderModelSetup();
    const operation = f.context.chooseModel({ model: selected, makeDefault: true }); await tick();
    assert.equal(settingsSaves.length, 1); assert.equal(settingsSaves[0].kind, 'settings'); assert.equal(settingsSaves[0].document.default_model, selected);
    assert.equal(f.saves.length, 1); assert.equal(f.saves[0].document.model, selected); assert.equal(f.session.revision, 4);
    let other;
    if (switchConversation) {
      other = { ...copy(f.session), id: randomUUID(), model: 'ollama:other' }; f.context.sessions.set(other.id, other); f.context.activeId = other.id;
      f.get('yc-model').value = other.model; f.context.notice('Notice for the other conversation');
    }
    rejectDefault(); await assert.rejects(operation, /Model applied to this conversation\. The default could not be saved: Synthetic default storage failure/);
    assert.equal(f.session.model, selected); assert.equal(f.context.settings.default_model, priorDefault); assert.equal(f.context.modelSelectionJobs.size, 0);
    if (switchConversation) {
      assert.equal(f.get('yc-notice').textContent, 'Notice for the other conversation'); assert.equal(f.get('yc-model').value, other.model); assert.equal(other.model, 'ollama:other');
    } else {
      assert.equal(f.get('yc-model-setup-host').classList.contains('yc-hidden'), true, 'The now-usable model hides its composer setup card');
      assert.match(f.get('yc-notice').textContent, /The default could not be saved/); assert.equal(f.get('yc-notice').classList.contains('yc-hidden'), false);
    }
  }
});

test('a lost project import acknowledgment retries the same operation without reacquisition and preserves a newer displayed collection', async () => {
  const f = fixture(); let controls, choices = 0, reads = 0; const requests = [];
  f.context.window.yurProjectFilesView = { create(_host, options) { controls = options; return { dispose() {} }; } };
  f.context.api.attachments = { read: async () => { reads++; return { ok: true, result: { kind: 'text', sha256: 'a'.repeat(64) } }; } };
  const collection = { project_id: f.project.id, project_revision: f.project.revision, collection_revision: 0, files: [] };
  f.context.api.projectFiles = { list: async () => ({ ok: true, result: collection }), choose: async () => { choices++; return { filePaths: ['C:\\synthetic-project\\reference.md'] }; }, add: async request => { requests.push(copy(request)); return requests.length === 1 ? { ok: false, error: { code: 'RUNTIME_TIMEOUT', message: 'Lost acknowledgment' } } : { ok: true, result: { ...collection, collection_revision: 1, replayed: true } }; } };
  f.context.renderProjectFiles(f.get('library-host'), f.project);
  await assert.rejects(controls.onAddFiles(collection), /same import/);
  const newer = { ...collection, collection_revision: 2 }, received = await controls.onAddFiles(newer);
  assert.deepEqual(copy(received), newer); assert.equal(choices, 1); assert.equal(reads, 1); assert.deepEqual(requests[0], requests[1]); assert.equal(f.context.projectFileMutations.size, 0); assert.equal(f.saves.length, 0);
});
