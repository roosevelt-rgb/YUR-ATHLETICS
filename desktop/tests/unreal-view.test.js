'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../src/unreal-view');
class Element {
  constructor(tag, doc) { Object.assign(this, { tagName: tag, ownerDocument: doc, children: [], listeners: {}, attributes: {}, dataset: {}, _text: '', disabled: false }); }
  set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text + this.children.map(c => c.textContent).join(' '); }
  set innerHTML(_) { throw new Error('Unreal content must stay inert.'); }
  append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parent = this; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = v; } removeAttribute(k) { delete this.attributes[k]; delete this[k]; }
  addEventListener(k, cb) { this.listeners[k] = cb; } remove() { this.parent.children = this.parent.children.filter(c => c !== this); }
}
const all = root => [root, ...root.children.flatMap(all)];
function setup(options = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, host = doc.createElement('body'), calls = [], plans = [];
  const api = { invoke: async (action, payload) => { calls.push({ action, payload }); return options.invoke ? options.invoke(action, payload) : { status: 'connected', available: true, project_file: '/fixture/Existing.uproject', inspections: ['level', 'camera'], capture_available: true, camera_available: true }; }, ...options.api };
  const view = create(host, { api, onFranklin: value => plans.push(value) });
  return { host, view, calls, plans, button: label => all(host).find(n => n.tagName === 'button' && n.textContent === label) };
}
test('Unreal view shows verified project, fixed inspection actions and Franklin handoff', async () => {
  const f = setup(); await f.view.ready;
  assert.match(f.host.textContent, /Connected to the selected Unreal editor/); assert.match(f.host.textContent, /Existing.uproject/);
  assert.equal(f.button('Selected actors').disabled, true); assert.equal(f.button('Camera position').disabled, false);
  await f.button('Camera position').listeners.click(); assert.deepEqual(f.calls.at(-1), { action: 'unreal_inspect', payload: { kind: 'camera' } });
  await f.button('Plan with Franklin').listeners.click(); assert.match(f.plans[0], /confirmation/); assert.equal(f.calls.some(c => c.action === 'unreal_camera'), false);
  f.view.dispose(); assert.equal(f.host.children.length, 0);
});
test('unavailable connection disables captures and does not launch any engine', async () => {
  const f = setup({ invoke: async () => ({ status: 'unconfigured', available: false, notice: 'Choose an existing project.' }) }); await f.view.ready;
  assert.equal(f.button('Capture viewport').disabled, true); assert.match(f.host.textContent, /Choose an existing project/);
  await f.button('Capture viewport').listeners.click(); assert.equal(f.calls.length, 1);
});
test('project chooser preserves host and commit errors instead of replacing them with refresh status', async () => {
  for (const failure of [
    { code: 'UNREAL_HOST_OVERRIDE', message: 'Unreal is controlled by this Desktop launch configuration.' },
    { code: 'CONFLICT', message: 'The selected project could not be saved because settings changed.' },
  ]) {
    const f = setup({ api: { chooseProject: async () => ({ ok: false, error: failure }) } }); await f.view.ready;
    await f.button('Choose existing project').listeners.click();
    assert.equal(f.calls.length, 1, 'Rejected selection must not refresh away the error.');
    const status = all(f.host).find(n => n.attributes.role === 'status');
    assert.equal(status.textContent, failure.message); assert.equal(status.dataset.error, 'true');
  }
});
test('cancelled selection leaves the panel intact while successful selection refreshes its project', async () => {
  let cancelled = true;
  const f = setup({ api: { chooseProject: async () => ({ ok: true, result: cancelled ? { cancelled: true } : { selected: true } }) } }); await f.view.ready;
  await f.button('Choose existing project').listeners.click(); assert.equal(f.calls.length, 1);
  cancelled = false; await f.button('Choose existing project').listeners.click(); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.at(-1), { action: 'unreal_status', payload: {} });
});
test('native preview requires matching project and digest, rejects external image URLs', async () => {
  const sha256 = 'a'.repeat(64); let unsafe = false;
  const f = setup({ invoke: async action => action === 'unreal_status' ? { status: 'connected', available: true, project_file: '/fixture/Existing.uproject', inspections: [], capture_available: true }
    : { capture: { preview_delivered: true, sha256, width: 1, height: 1 } }, api: { preview: async () => ({ project_file: '/fixture/Existing.uproject', sha256, width: 1, height: 1, data_url: unsafe ? 'https://example.test/tracker.png' : 'data:image/png;base64,YQ==' }) } });
  await f.view.ready; await f.button('Capture viewport').listeners.click(); const image = all(f.host).find(n => n.tagName === 'img');
  assert.equal(image.src, 'data:image/png;base64,YQ=='); unsafe = true; await f.button('Capture viewport').listeners.click();
  assert.match(f.host.textContent, /preview no longer matches/); assert.equal(image.src, 'data:image/png;base64,YQ==');
});
test('native Franklin preview events update only the selected project and unsubscribe on dispose', async () => {
  let emit, stopped = 0;
  const f = setup({ api: { onPreview: callback => { emit = callback; return () => stopped++; } } }); await f.view.ready;
  const value = { project_file: '/fixture/Existing.uproject', sha256: 'b'.repeat(64), width: 1, height: 1, data_url: 'data:image/png;base64,YQ==' };
  emit(value); const image = all(f.host).find(n => n.tagName === 'img'); assert.equal(image.hidden, false);
  emit({ ...value, project_file: '/another.uproject', data_url: 'data:image/png;base64,Yg==' }); assert.equal(image.src, value.data_url);
  f.view.dispose(); assert.equal(stopped, 1); emit(value); assert.equal(image.src, undefined);
});
