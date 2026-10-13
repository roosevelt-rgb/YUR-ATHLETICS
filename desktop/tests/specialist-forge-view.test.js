'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { STARTERS, starters, buildRequest, buildPresentation, mount } = require('../src/specialist-forge-view');

const base = overrides => ({ name: 'My helper', description: 'A focused job.', primaryCapability: 'text.analyze', ...overrides });
class Node {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('User input must stay inert text.'); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.ownerDocument.focused = this; }
}
const all = node => [node, ...node.children.flatMap(all)];
function view(callbacks = {}) {
  const document = { createElement: tag => new Node(tag, document) }, host = document.createElement('div');
  const options = { onBuild: async () => {}, onCancel: () => {}, ...callbacks }, controller = mount(host, options);
  return { host, document, options, controller,
    get: className => all(host).find(node => node.className.split(' ').includes(className)),
    submit() { return this.get('sf-form').listeners.submit({ preventDefault() {} }); },
    choose(id) { const radio = all(host).find(node => node.className === 'sf-starter-radio' && node.value === id); radio.checked = true; radio.listeners.change(); },
    extra(id, checked = true) { const input = all(host).find(node => node.className === 'sf-extra-checkbox' && node.value === id); input.checked = checked; input.listeners.change(); return input; },
  };
}

test('five executable starters produce bounded typed sample requests, with fresh data snapshots', () => {
  assert.equal(starters, STARTERS); assert.equal(STARTERS.length, 5);
  const expected = {
    'text.analyze': { text: 'Clear evidence helps. Clear evidence matters.' },
    'data.profile': { rows: [{ id: '1', name: 'Ada' }, { id: '1', name: 'Ada' }, { id: '2', name: '' }] },
    'support.triage': { subject: 'Outage', body: 'Production down' },
    'workforce.hatch.quantity': { plans_text: 'Division 03\nConcrete 125 CY', specs_text: '09 51 00\nGypsum 1,200 SF' },
    'construction.opc.inspect': { text: '1.1 | CUT | 2.5 | CY | $4.00 | $10.00' },
  };
  for (const starter of STARTERS) {
    const request = buildRequest(base({ primaryCapability: starter.id }));
    assert.deepEqual(request, { name: 'My helper', description: 'A focused job.', capabilities: [starter.id], sample: { capability_id: starter.id, input: expected[starter.id] } });
    assert.ok(starter.label && starter.outcome); assert.equal(Object.isFrozen(starter), true);
  }
  const first = buildRequest(base({ primaryCapability: 'data.profile' })); first.sample.input.rows[0].name = 'changed';
  assert.equal(buildRequest(base({ primaryCapability: 'data.profile' })).sample.input.rows[0].name, 'Ada');
});

test('blank, overlong and malformed names or descriptions fail before a build can start', () => {
  for (const name of ['', '  ', 'a'.repeat(101), 'two\nlines', 'bad\0name', null, 10]) assert.throws(() => buildRequest(base({ name })), /Agent name/);
  for (const description of ['a'.repeat(2001), 'bad\0context', [], 10]) assert.throws(() => buildRequest(base({ description })), /Description/);
  assert.equal(buildRequest(base({ name: '  Helper  ', description: '' })).name, 'Helper');
});

test('only three distinct admitted abilities may be selected and the sample remains bound to the primary', () => {
  const request = buildRequest(base({ additionalCapabilities: ['data.profile', 'support.triage'] }));
  assert.deepEqual(request.capabilities, ['text.analyze', 'data.profile', 'support.triage']); assert.equal(request.sample.capability_id, 'text.analyze');
  for (const additionalCapabilities of [['invented'], ['text.analyze'], ['data.profile', 'data.profile'], ['data.profile', 'support.triage', 'workforce.hatch.quantity'], 'data.profile']) {
    assert.throws(() => buildRequest(base({ additionalCapabilities })), /three different abilities/);
  }
  assert.throws(() => buildRequest(base({ primaryCapability: 'write:anywhere' })), /available starter/);
});

test('sample editing preserves exact source text while enforcing field bounds and shapes', () => {
  const text = '  First line.\nSecond line.  ';
  assert.equal(buildRequest(base({ sampleFields: { text } })).sample.input.text, text);
  for (const text of ['', ' ', 'a'.repeat(4001), null, '\0']) assert.throws(() => buildRequest(base({ sampleFields: { text } })));
  assert.throws(() => buildRequest(base({ sampleFields: { root: 'C:/' } })), /do not match/);
  assert.throws(() => buildRequest(base({ sampleFields: [] })), /do not match/);
  assert.throws(() => buildRequest(base({ primaryCapability: 'support.triage', sampleFields: { subject: 'a'.repeat(501) } })), /subject/);
  assert.throws(() => buildRequest(base({ primaryCapability: 'workforce.hatch.quantity', sampleFields: { plans_text: '', specs_text: ' ' } })), /plans or specifications/);
  assert.equal(buildRequest(base({ primaryCapability: 'workforce.hatch.quantity', sampleFields: { plans_text: '4 CY', specs_text: '' } })).sample.input.specs_text, '');
  assert.throws(() => buildRequest(base({ primaryCapability: 'data.profile', sampleFields: { rows: [] } })), /do not match/);
});

test('conversation presentation uses ordinary labels and sample content without internal tools or JSON', () => {
  const request = buildRequest(base({ name: 'Reader', sampleFields: { text: 'Alpha beta alpha.' }, additionalCapabilities: ['support.triage'] }));
  const presentation = buildPresentation(request);
  assert.match(presentation, /Reader/); assert.match(presentation, /A focused job/); assert.match(presentation, /Understand a piece of text/);
  assert.match(presentation, /Sort a support request/); assert.match(presentation, /Alpha beta alpha/);
  assert.match(presentation, /Complete both actions in order before answering/); assert.match(presentation, /Wait for that build result/);
  assert.match(presentation, /Do not request the sample before the build result/); assert.match(presentation, /do not stop after the build/);
  assert.doesNotMatch(presentation, /text\.analyze|support\.triage|build_specialist|run_built_specialist|"capability_id"/);
  assert.throws(() => buildPresentation({ ...request, sample: { ...request.sample, capability_id: 'data.profile' } }), /same main ability/);
  assert.match(buildPresentation(buildRequest(base({ primaryCapability: 'data.profile' }))), /Three sample rows/);
  assert.match(buildPresentation(buildRequest(base({ description: '' }))), /Keep the description empty/);
});

test('mount is idempotent, makes no callback, and provides associated fields and live status', () => {
  let calls = 0; const v = view({ onBuild: () => calls++, onCancel: () => calls++ });
  assert.equal(mount(v.host, v.options), v.controller); assert.equal(v.host.children.length, 1); assert.equal(calls, 0);
  assert.equal(all(v.host).filter(node => node.className === 'sf-starter-radio').length, 5);
  assert.ok(all(v.host).some(node => node.tagName === 'label' && node.htmlFor === v.get('sf-name').id));
  assert.equal(v.get('sf-status').attributes.role, 'status'); assert.equal(v.get('sf-error').attributes.role, 'alert');
  v.controller.focus(); assert.equal(v.document.focused, v.get('sf-name'));
});

test('live preview renders markup as text and choosing a starter updates its sample without starting work', () => {
  let builds = 0; const v = view({ onBuild: () => builds++ }), hostile = '<img src=x onerror=alert(1)>';
  v.get('sf-name').value = hostile; v.get('sf-name').listeners.input(); v.get('sf-description').value = hostile; v.get('sf-description').listeners.input();
  assert.equal(v.get('sf-preview-name').textContent, hostile); assert.equal(v.get('sf-preview-description').textContent, hostile);
  v.choose('support.triage'); assert.equal(v.get('sf-sample-subject').value, 'Outage'); assert.match(v.get('sf-preview-abilities').textContent, /matched rules/);
  assert.equal(builds, 0); assert.equal(all(v.host).some(node => node.tagName === 'img'), false);
});

test('invalid form retains entered values, displays an actionable error and makes no callback', async () => {
  let builds = 0; const v = view({ onBuild: () => builds++ });
  v.get('sf-description').value = 'Keep this description.'; await v.submit();
  assert.equal(builds, 0); assert.equal(v.get('sf-error').hidden, false); assert.match(v.get('sf-error').textContent, /Agent name/);
  assert.equal(v.get('sf-description').value, 'Keep this description.'); assert.equal(v.document.focused, v.get('sf-name'));
});

test('submitted request uses selected inputs once, disables editing, and reports only acknowledged conversation start', async () => {
  const calls = []; let resolve; const v = view({ onBuild: request => { calls.push(request); return new Promise(done => { resolve = done; }); } });
  v.get('sf-name').value = 'Text helper'; v.get('sf-description').value = 'Find repeated terms.'; v.get('sf-sample-text').value = 'Alpha beta alpha.';
  const pending = v.submit(); await v.submit();
  assert.deepEqual(calls, [{ name: 'Text helper', description: 'Find repeated terms.', capabilities: ['text.analyze'], sample: { capability_id: 'text.analyze', input: { text: 'Alpha beta alpha.' } } }]);
  assert.equal(v.get('sf-submit').disabled, true); assert.equal(v.get('sf-name').disabled, true); assert.equal(v.get('sf-cancel').disabled, true);
  v.controller.setBusy(false); assert.equal(v.get('sf-submit').disabled, true);
  assert.doesNotMatch(v.get('sf-status').textContent, /Conversation started|validated|created/);
  resolve(); await pending; assert.equal(v.get('sf-submit').disabled, false); assert.match(v.get('sf-status').textContent, /^Conversation started/);
  assert.doesNotMatch(v.get('sf-status').textContent, /Agent created|validation passed|specialist built/i);
});

test('failed callback keeps name and edited sample for retry, and error output remains inert', async () => {
  let calls = 0; const v = view({ onBuild: async () => { calls++; throw new Error('<b>Connection unavailable</b>'); } });
  v.get('sf-name').value = 'Retry helper'; v.get('sf-sample-text').value = 'Keep this sample.'; await v.submit();
  assert.equal(v.get('sf-error').textContent, '<b>Connection unavailable</b>'); assert.equal(v.get('sf-error').hidden, false);
  assert.equal(v.get('sf-name').value, 'Retry helper'); assert.equal(v.get('sf-sample-text').value, 'Keep this sample.');
  assert.equal(v.get('sf-status').textContent, ''); assert.equal(v.get('sf-submit').disabled, false);
  await v.submit(); assert.equal(calls, 2); assert.equal(all(v.host).some(node => node.tagName === 'b'), false);
});

test('up to three choices remain editable, primary changes remove duplication, and samples survive switching', async () => {
  const calls = [], v = view({ onBuild: request => calls.push(request) }); v.get('sf-name').value = 'Combined helper';
  v.get('sf-sample-text').value = 'Saved sample.'; v.extra('data.profile'); v.extra('support.triage');
  assert.equal(all(v.host).find(node => node.className === 'sf-extra-checkbox' && node.value === 'construction.opc.inspect').disabled, true);
  v.choose('data.profile'); assert.equal(all(v.host).find(node => node.className === 'sf-extra-checkbox' && node.value === 'data.profile').checked, false);
  await v.submit(); assert.deepEqual(calls[0].capabilities, ['data.profile', 'support.triage']);
  v.choose('text.analyze'); assert.equal(v.get('sf-sample-text').value, 'Saved sample.');
});

test('reset fences a late completion and restores a clean form without granting success', async () => {
  let resolve; const v = view({ onBuild: () => new Promise(done => { resolve = done; }) }); v.get('sf-name').value = 'Old request';
  const pending = v.submit(); v.controller.reset(); v.get('sf-name').value = 'New draft'; resolve(); await pending;
  assert.equal(v.get('sf-name').value, 'New draft'); assert.equal(v.get('sf-status').textContent, ''); assert.equal(v.get('sf-submit').disabled, false);
});

test('external busy prevents submit and cancel without changing the draft; cancel failure is visible', async () => {
  let builds = 0, cancels = 0; const v = view({ onBuild: () => builds++, onCancel: () => { cancels++; throw new Error('Could not return to agents'); } });
  v.get('sf-name').value = 'My draft'; v.controller.setBusy(true, 'Preparing the workspace…'); await v.submit(); await v.get('sf-cancel').listeners.click();
  assert.equal(builds, 0); assert.equal(cancels, 0); assert.equal(v.get('sf-name').value, 'My draft'); assert.match(v.get('sf-status').textContent, /Preparing/);
  v.controller.setBusy(false); await v.get('sf-cancel').listeners.click(); assert.equal(cancels, 1); assert.match(v.get('sf-error').textContent, /return to agents/);
});
