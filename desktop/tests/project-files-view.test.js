'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { create } = require('../src/project-files-view.js');
class Node {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {}; this.listeners = {}; this._text = ''; this.disabled = false; this.checked = false; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(_value) { throw new Error('File metadata must remain inert text'); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
}
const all = node => [node, ...node.children.flatMap(all)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
const projectId = randomUUID(), project = { id: projectId, name: 'Reference project', revision: 3 };
const file = (name = 'report.pdf', overrides = {}) => ({ id: randomUUID(), project_id: projectId, name, sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64), bytes: 4096, revision: 1, created_at: new Date().toISOString(), extraction: { truncated: false }, ...overrides });
const reference = item => ({ file_id: item.id, revision: item.revision, sha256: item.sha256 });
const library = (files = [], collection_revision = 4) => ({ project_id: projectId, project_revision: project.revision, collection_revision, files });
function fixture({ collection = library(), selected = [], list, onSelection, onAddFiles, onRemove, selectable = true } = {}) {
  const document = { createElement: tag => new Node(tag, document) }, host = document.createElement('main'), calls = [], errors = [];
  let selection = copy(selected), nextCollection = collection;
  const controller = create(host, { project, selectable, conversationName: 'A preserved draft', api: { list: async id => { calls.push({ kind: 'list', id }); return list ? list(id) : { ok: true, result: nextCollection }; } },
    getSelection: () => copy(selection), onSelection: async references => { calls.push({ kind: 'selection', references: copy(references) }); if (onSelection) await onSelection(references); selection = copy(references); },
    onAddFiles: onAddFiles && (async snapshot => { calls.push({ kind: 'add', snapshot: copy(snapshot) }); return onAddFiles(snapshot); }),
    onRemove: onRemove && (async (item, snapshot) => { calls.push({ kind: 'remove', file: copy(item), snapshot: copy(snapshot) }); return onRemove(item, snapshot); }), onError: message => errors.push(message) });
  return { host, controller, calls, errors, get: name => all(host).find(node => node.className === name), row: id => all(host).find(node => node.tagName === 'article' && node.dataset.fileId === id),
    checkbox: id => all(host).find(node => node.className === 'yc-project-files-checkbox' && node.dataset.fileId === id),
    async toggle(id, checked) { const input = this.checkbox(id); input.checked = checked; await input.listeners.change(); },
    setCollection(value) { nextCollection = value; }, getSelection: () => copy(selection) };
}

test('library mount is read-only and renders metadata/truncation as text with the captured conversation name', async () => {
  const item = file('<img src=x onerror=alert(1)>.pdf', { extraction: { truncated: true, pages: 90, pages_read: 8 } });
  const v = fixture({ collection: library([item]) }); await tick();
  assert.deepEqual(v.calls, [{ kind: 'list', id: projectId }]); assert.ok(v.host.textContent.includes(item.name)); assert.equal(all(v.host).some(node => node.tagName === 'img'), false);
  assert.match(v.host.textContent, /4.0 KB · revision 1/); assert.match(v.host.textContent, /does not contain the entire original file/); assert.match(v.host.textContent, /A preserved draft/);
  assert.equal(v.get('yc-project-files-status').attributes['aria-live'], 'polite'); assert.equal(v.get('yc-project-files-error').attributes.role, 'alert'); assert.equal(v.checkbox(item.id).checked, false);
});

test('selection changes require acknowledgment, preserve exact revision/hash, and prevent duplicate pending changes', async () => {
  const item = file(); let resolve; const v = fixture({ collection: library([item]), onSelection: () => new Promise(done => resolve = done) }); await tick();
  const operation = v.toggle(item.id, true); assert.equal(v.checkbox(item.id).checked, false); assert.equal(v.checkbox(item.id).disabled, true);
  await v.toggle(item.id, true); assert.equal(v.calls.filter(call => call.kind === 'selection').length, 1);
  assert.deepEqual(v.calls.at(-1).references, [reference(item)]); resolve(); await operation;
  assert.equal(v.checkbox(item.id).checked, true); assert.deepEqual(v.getSelection(), [reference(item)]);
});

test('failed selection preserves the prior checkboxes and surfaces the actual error', async () => {
  const item = file(); const v = fixture({ collection: library([item]), selected: [reference(item)], onSelection: async () => { throw new Error('Conversation save conflict'); } }); await tick();
  await v.toggle(item.id, false); assert.equal(v.checkbox(item.id).checked, true); assert.deepEqual(v.getSelection(), [reference(item)]); assert.match(v.get('yc-project-files-error').textContent, /save conflict/);
});

test('eight-file limit is enforced by both controls and the event handler without silently removing another choice', async () => {
  const items = Array.from({ length: 9 }, (_, i) => file(`file-${i}.txt`)), selected = items.slice(0, 8).map(reference);
  const v = fixture({ collection: library(items), selected }); await tick(); assert.equal(v.checkbox(items[8].id).disabled, true);
  await v.toggle(items[8].id, true); assert.deepEqual(v.getSelection(), selected); assert.equal(v.calls.filter(call => call.kind === 'selection').length, 0); assert.match(v.get('yc-project-files-error').textContent, /no more than eight/);
  await v.toggle(items[0].id, false); assert.equal(v.checkbox(items[8].id).disabled, false); await v.toggle(items[8].id, true); assert.equal(v.getSelection().length, 8);
});

test('missing and changed selected references remain explicit until the operator deselects them', async () => {
  const current = file(), old = { ...reference(current), sha256: 'c'.repeat(64) }, missing = reference(file('removed.txt'));
  const v = fixture({ collection: library([current]), selected: [old, missing] }); await tick();
  assert.equal(v.checkbox(current.id).checked, true); assert.match(v.row(current.id).textContent, /earlier revision/); assert.match(v.row(missing.file_id).textContent, /no longer in the library/); assert.deepEqual(v.getSelection(), [old, missing]);
  await v.toggle(missing.file_id, false); assert.equal(v.row(missing.file_id), undefined); await v.toggle(current.id, false); await v.toggle(current.id, true); assert.deepEqual(v.getSelection(), [reference(current)]);
});

test('failed initial or subsequent refresh retains selections and allows removing a saved missing reference', async () => {
  const item = file(), selected = [reference(item)]; let failed = false;
  const v = fixture({ collection: library([item]), selected, list: async () => failed ? { ok: false, error: { message: 'Library offline' } } : { ok: true, result: library([item]) } }); await tick(); failed = true; await v.controller.refresh();
  assert.ok(v.row(item.id)); assert.deepEqual(v.getSelection(), selected); assert.equal(v.checkbox(item.id).checked, true); assert.match(v.get('yc-project-files-error').textContent, /Library offline/);
  const absent = fixture({ selected, list: async () => ({ ok: false, error: { message: 'Initial read failed' } }) }); await tick(); assert.equal(absent.checkbox(item.id).disabled, false);
  await absent.toggle(item.id, false); assert.deepEqual(absent.getSelection(), []); assert.equal(absent.calls.filter(call => call.kind === 'selection').length, 1);
});

test('another project home exposes shared management without assigning its files to the active conversation', async () => {
  const item = file(), v = fixture({ collection: library([item]), selectable: false, onAddFiles: async snapshot => snapshot }); await tick();
  assert.match(v.host.textContent, /Start a conversation in this project/); assert.equal(v.checkbox(item.id), undefined); assert.equal(v.get('yc-project-files-add').disabled, false); assert.equal(v.calls.filter(call => call.kind === 'selection').length, 0);
});

test('shared removal passes immutable CAS metadata and waits for acknowledgment while retaining stale conversation references', async () => {
  const item = file(); let resolve; const original = library([item]);
  const v = fixture({ collection: original, selected: [reference(item)], onRemove: (_file, snapshot) => { snapshot.files[0].name = 'callback mutation'; return new Promise(done => resolve = done); } }); await tick();
  const remove = all(v.row(item.id)).find(node => node.className === 'yc-project-file-remove'); const operation = remove.listeners.click(); await remove.listeners.click();
  assert.equal(v.calls.filter(call => call.kind === 'remove').length, 1); assert.equal(v.calls.at(-1).snapshot.collection_revision, 4); assert.deepEqual(v.calls.at(-1).file, item); assert.match(v.row(item.id).textContent, /report.pdf/);
  resolve(library([], 5)); await operation; assert.deepEqual(v.getSelection(), [reference(item)]); assert.match(v.row(item.id).textContent, /no longer in the library/); assert.equal(original.files[0].name, 'report.pdf');
});

test('add cancellation and failed mutations preserve the loaded library and never claim a committed addition', async () => {
  const item = file(); const v = fixture({ collection: library([item]), onAddFiles: async snapshot => snapshot, onRemove: async () => { throw new Error('Collection revision changed. Refresh files.'); } }); await tick();
  await v.get('yc-project-files-add').listeners.click(); assert.match(v.get('yc-project-files-status').textContent, /No files were added/);
  await all(v.row(item.id)).find(node => node.className === 'yc-project-file-remove').listeners.click(); assert.ok(v.row(item.id)); assert.match(v.get('yc-project-files-error').textContent, /revision changed/);
});

test('wrong-project, malformed and older collection responses are rejected without discarding the last valid snapshot', async () => {
  const item = file(); const v = fixture({ collection: library([item]) }); await tick();
  for (const invalid of [{ ...library([]), project_id: randomUUID() }, library([], 3), library([item, item]), library([file('bad.txt', { extraction: {} })])]) {
    v.setCollection(invalid); assert.equal(await v.controller.refresh(), false); assert.ok(v.row(item.id)); assert.equal(v.get('yc-project-files').dataset.collectionRevision, '4');
  }
});

test('dispose prevents a late library read or mutation acknowledgment from repainting another project view', async () => {
  let resolve; const v = fixture({ list: () => new Promise(done => resolve = done) }); const sibling = v.host.ownerDocument.createElement('p'); sibling.textContent = 'Other view'; v.host.appendChild(sibling);
  v.controller.dispose(); resolve({ ok: true, result: library([file()]) }); await tick(); assert.equal(v.host.textContent, 'Other view');
  const item = file(); let finish; const pending = fixture({ collection: library([item]), onRemove: () => new Promise(done => finish = done) }); await tick();
  const operation = all(pending.row(item.id)).find(node => node.className === 'yc-project-file-remove').listeners.click(); pending.controller.dispose(); finish(library([], 5)); await operation; assert.equal(pending.host.textContent, '');
});
