'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual selection/render functions and Work inspection connectivity
// guard with deferred read-only IPC. No model, browser or runtime is started.
const source = fs.readFileSync(path.join(__dirname, '../src/conversation-view.js'), 'utf8');
const workSource = fs.readFileSync(path.join(__dirname, '../src/work-view.js'), 'utf8');
function slice(value, start, end) { const from = value.indexOf(start), through = value.indexOf(end, from); assert.ok(from >= 0 && through > from); return value.slice(from, through); }
class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.className = ''; this.value = ''; this._text = ''; this.listeners = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  get isConnected() { return Boolean(this.connectedRoot || this.parentNode?.isConnected); }
  get options() { return this.children; }
  get childElementCount() { return this.children.length; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(_value) { throw new Error('Only text/DOM rendering is allowed'); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute() {}
  querySelectorAll(selector) { return descendants(this).slice(1).filter(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  scrollIntoView() { this.scrolled = true; }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function text(tag, content, className = '') { const node = new Node(tag); node.textContent = content; node.className = className; return node; }
function fixture() {
  const root = new Node('main'); root.connectedRoot = true;
  const nodes = new Map(), reads = [];
  const get = id => { if (!nodes.has(id)) { const node = new Node(id === 'yc-model' ? 'select' : 'div'); root.appendChild(node); nodes.set(id, node); } return nodes.get(id); };
  const a = { id: 'conversation-a', title: 'A', messages: [], model: 'foundry:auto', revision: 1 }, b = { id: 'conversation-b', title: 'B', messages: [], model: 'foundry:auto', revision: 1 };
  const model = get('yc-model'); model.value = 'foundry:auto'; const option = new Node('option'); option.value = model.value; model.appendChild(option);
  const status = new Node('div'); root.querySelector = () => status;
  const context = vm.createContext({ window: {}, document: { createElement: tag => new Node(tag) }, root, $: get, text,
    activeId: a.id, sessions: new Map([[a.id, a], [b.id, b]]), selectedWorkRecords: new Map(), detailsOpen: false, detailTab: 'work',
    connection: {}, saveErrors: new Map(), unsaved: new Set(), pending: new Map(), attachmentJobs: new Map(),
    modelSelectionJobs: new Set(), connectionGeneration: 0, connectionModels: {}, renderModelSetup() {}, modelReadiness: () => ({ models: [] }),
    current() { return context.sessions.get(context.activeId); }, workViewOptions: () => ({}), showConversation() {},
    toggleDetails(value) { context.detailsOpen = value; context.detailTab = 'work'; context.renderDetails(); },
    renderHistory() {}, renderMessages() {}, renderAttachments() {}, updateSendControl() {}, renderVoiceControls() {}, renderPreferenceStatus() {}, renderModeSwitch() {}, acceptedWork: () => null,
    api: { work: { inspect(id) { return new Promise(resolve => reads.push({ id, resolve })); } }, foundry: { health: async () => ({ status: 200 }), models: async () => ({ status: 200, json: { models: [] } }), info: async () => ({ url: 'http://127.0.0.1' }) }, ollama: { tags: async () => ({ models: [] }) } },
    renderMission(host, record) {
      host.replaceChildren(text('p', record.answer));
      if (record.artifactId) { const artifact = text('article', '', 'yc-work-artifact'); artifact.dataset.artifactId = record.artifactId; const details = new Node('details'); details.appendChild(text('summary', 'Preview content')); artifact.appendChild(details); host.appendChild(artifact); }
    },
  });
  vm.runInContext(slice(workSource, '  async function inspect(', '  async function list(') + '\nwindow.yurWorkView = { inspect, list: async (_api, _id, host) => host.replaceChildren(text("p", "History")) };', context);
  vm.runInContext(slice(source, '  function card(', '  function workViewOptions(') + slice(source, '  function openWorkRecord(', '  function setDetailWidth(') + slice(source, '  function render() {', '  function updateModelNote(') + slice(source, '  async function refreshConnections(', '  async function loadHistory('), context);
  const settle = async (index, result) => { reads[index].resolve({ ok: true, result }); await new Promise(resolve => setImmediate(resolve)); };
  return { context, a, b, reads, body: get('yc-detail-body'), open: (id, artifactId) => context.openWorkRecord(id, artifactId), render: () => context.render(), settle };
}

test('explicit Work selection survives late render/save and connection refresh while inspect is pending and after it resolves', async () => {
  const f = fixture(); f.open('mission-a'); const section = f.body.children[0], host = section.children.at(-1);
  f.context.unsaved.add(f.a.id); f.render(); await f.context.refreshConnections(); f.context.unsaved.clear(); f.render();
  assert.equal(f.body.children[0], section); assert.equal(host.isConnected, true); assert.equal(f.reads.length, 1);
  await f.settle(0, { answer: 'Committed selected-page denial receipt' });
  assert.match(f.body.textContent, /Committed selected-page denial receipt/);
  f.render(); await f.context.refreshConnections(); assert.equal(f.body.children[0], section); assert.equal(f.reads.length, 1);
});

test('a late inspection cannot paint a different conversation; returning re-inspects only that conversation’s retained selection', async () => {
  const f = fixture(); f.open('mission-a'); const oldHost = f.body.children[0].children.at(-1);
  f.context.activeId = f.b.id; f.render(); assert.equal(oldHost.isConnected, false); assert.match(f.body.textContent, /ConversationB/);
  await f.settle(0, { answer: 'Late A result must not appear in B' }); assert.doesNotMatch(f.body.textContent, /Late A/);
  f.open('mission-b'); await f.settle(1, { answer: 'B receipt' }); assert.match(f.body.textContent, /B receipt/);
  f.context.activeId = f.a.id; f.render(); assert.equal(f.reads[2].id, 'mission-a'); assert.doesNotMatch(f.body.textContent, /B receipt/);
  await f.settle(2, { answer: 'Freshly inspected A receipt' }); assert.match(f.body.textContent, /Freshly inspected A receipt/);
  assert.equal(f.context.selectedWorkRecords.get(f.b.id).missionId, 'mission-b');
});

test('new selection and explicit refresh supersede old reads; Conversation details clears the selection without later revival', async () => {
  const f = fixture(); f.open('mission-old'); f.open('mission-new');
  await f.settle(1, { answer: 'New selected receipt' }); await f.settle(0, { answer: 'Stale receipt' });
  assert.match(f.body.textContent, /New selected receipt/); assert.doesNotMatch(f.body.textContent, /Stale receipt/);
  const refresh = descendants(f.body).find(node => node.tagName === 'button' && node.textContent === 'Refresh work record'); refresh.listeners.click();
  assert.equal(f.reads[2].id, 'mission-new'); await f.settle(2, { answer: 'Refreshed receipt' });
  const back = descendants(f.body).find(node => node.tagName === 'button' && node.textContent === 'Conversation details'); back.listeners.click();
  assert.equal(f.context.selectedWorkRecords.has(f.a.id), false); f.render(); await f.context.refreshConnections();
  assert.match(f.body.textContent, /Work records/); assert.doesNotMatch(f.body.textContent, /Refreshed receipt/); assert.equal(f.reads.length, 3);
});

test('artifact source inspection opens the selected artifact after a late render, but cannot scroll a different conversation', async () => {
  const f = fixture(); f.open('mission-artifact', 'artifact-a'); f.render(); await f.settle(0, { answer: 'Source record', artifactId: 'artifact-a' });
  const artifact = f.body.querySelector('.yc-work-artifact'); assert.equal(artifact.scrolled, true); assert.equal(artifact.querySelector('details').open, true);
  f.open('mission-delayed', 'artifact-late'); const oldHost = f.body.children[0].children.at(-1); f.context.activeId = f.b.id; f.render();
  await f.settle(1, { answer: 'Late artifact', artifactId: 'artifact-late' }); assert.equal(oldHost.querySelector('.yc-work-artifact'), null); assert.doesNotMatch(f.body.textContent, /Late artifact/);
});
