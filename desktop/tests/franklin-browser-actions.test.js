'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserControlActions, controlScript, LIMITS } = require('../src/franklin-browser-actions');

function fixture(options = {}) {
  let revision = 1, visible = true, time = 1, inspected;
  const calls = [], reviews = new Map();
  const controls = [{ ref: 'c1', label: 'Send message', tag: 'button', actions: ['click'], may_submit: true },
    { ref: 'c2', label: 'Message', tag: 'textarea', actions: ['fill'] }, { ref: 'c3', label: 'Choice', tag: 'select', actions: ['select'] }];
  const host = createBrowserControlActions({
    selectDocument() { if (!visible) throw new Error('Show the page'); return { revision, source_url: 'https://test.example/page' }; },
    validateDocument(document) { if (!visible || document.revision !== revision) throw new Error('The document changed or is hidden'); },
    now: () => time, wallNow: () => 1000 + time, timeoutMs: 25,
    async run(request) {
      calls.push(request);
      if (options.run) return options.run(request);
      if (request.operation === 'inspect') { inspected = request; return { document_id: request.document_id, source_url: request.source_url, title: 'Test page', controls, truncated: false }; }
      if (request.document_id !== inspected.document_id) throw new Error('Old document');
      if (request.operation === 'prepare') {
        const review = { document_id: request.document_id, source_url: request.source_url, ref: request.ref, action: request.action,
          control: controls.find(control => control.ref === request.ref), ...(request.action === 'click' ? {} : { value: request.value }) };
        reviews.set(request.ticket_id, review); return review;
      }
      const review = reviews.get(request.ticket_id);
      if (!review) throw new Error('Unknown ticket');
      if (options.dispatchError) throw new Error('Native dispatch failed');
      return { performed: true, action: review.action, document_id: review.document_id, source_url: review.source_url, ref: review.ref };
    },
  });
  return { host, calls, reviews, controls, navigate: () => revision++, hide: () => { visible = false; }, expire: () => { time += LIMITS.reference_ttl_ms; } };
}

test('inspection and prepare are bounded observations; only execute dispatches the reviewed mutation', async () => {
  const f = fixture(), snapshot = await f.host.inspectControls();
  assert.equal(snapshot.schema, 'yur.browser-controls.v1'); assert.equal(snapshot.controls.length, 3);
  const ticket = await f.host.prepareControl('fill', { document_id: snapshot.document_id, ref: 'c2', value: 'Exact\nmessage' });
  assert.deepEqual(f.calls.map(call => call.operation), ['inspect', 'prepare']);
  assert.equal(ticket.review.value, 'Exact\nmessage'); assert(Object.isFrozen(ticket)); assert(Object.isFrozen(ticket.review.control));
  assert.throws(() => JSON.stringify(ticket), /private/);
  const result = await f.host.executeControl(ticket);
  assert.equal(result.performed, true); assert.equal(result.action, 'fill');
  assert.deepEqual(f.calls.map(call => call.operation), ['inspect', 'prepare', 'execute']);
  assert.equal(f.calls.at(-1).value, undefined, 'execution uses only the prepared isolated-world ticket');
  await assert.rejects(f.host.executeControl(ticket), /already used/);
});

test('foreign tickets, arbitrary selectors/scripts and uninspected refs never reach the renderer', async () => {
  const f = fixture(), snapshot = await f.host.inspectControls(), start = f.calls.length;
  for (const [action, payload] of [
    ['click', { document_id: snapshot.document_id, ref: 'c99' }],
    ['click', { document_id: snapshot.document_id, ref: 'c1', selector: '#send' }],
    ['javascript', { document_id: snapshot.document_id, ref: 'c1' }],
    ['fill', { document_id: snapshot.document_id, ref: 'c2', value: '界'.repeat(8000) }],
    ['fill', { document_id: snapshot.document_id, ref: 'c2', value: '\0secret' }],
  ]) await assert.rejects(f.host.prepareControl(action, payload));
  await assert.rejects(f.host.executeControl({ review: { action: 'click' } }), /foreign/);
  assert.equal(f.calls.length, start);
});

test('same-URL navigation, hidden view and expired references fail before dispatch', async () => {
  for (const change of ['navigate', 'hide', 'expire']) {
    const f = fixture(), snapshot = await f.host.inspectControls();
    const ticket = await f.host.prepareControl('click', { document_id: snapshot.document_id, ref: 'c1' });
    f[change]();
    await assert.rejects(f.host.executeControl(ticket), /changed|hidden|expired/);
    assert.equal(f.calls.some(call => call.operation === 'execute'), false);
    await assert.rejects(f.host.executeControl(ticket), /already used/);
  }
});

test('fresh inspection revokes old reviews even when the URL and document revision are unchanged', async () => {
  const f = fixture(), snapshot = await f.host.inspectControls();
  const old = await f.host.prepareControl('click', { document_id: snapshot.document_id, ref: 'c1' });
  const fresh = await f.host.inspectControls(); assert.notEqual(fresh.document_id, snapshot.document_id);
  await assert.rejects(f.host.executeControl(old), /already used|expired/);
  await assert.rejects(f.host.prepareControl('click', { document_id: snapshot.document_id, ref: 'c1' }), /expired/);
});

test('failed native dispatch consumes the ticket and never allows blind replay', async () => {
  const f = fixture({ dispatchError: true }), snapshot = await f.host.inspectControls();
  const ticket = await f.host.prepareControl('click', { document_id: snapshot.document_id, ref: 'c1' });
  await assert.rejects(f.host.executeControl(ticket), /failed/);
  await assert.rejects(f.host.executeControl(ticket), /already used/);
  assert.equal(f.calls.filter(call => call.operation === 'execute').length, 1);
});

test('document changes while a review is prepared reject the result and produce no executable ticket', async () => {
  let f;
  f = fixture({ run: async request => {
    if (request.operation === 'inspect') return { document_id: request.document_id, source_url: request.source_url, title: '', controls: [{ ref: 'c1', actions: ['click'] }], truncated: false };
    f.navigate(); return { document_id: request.document_id, source_url: request.source_url, ref: 'c1', action: 'click', control: {} };
  } });
  const snapshot = await f.host.inspectControls();
  await assert.rejects(f.host.prepareControl('click', { document_id: snapshot.document_id, ref: 'c1' }), /changed/);
  assert.equal(f.calls.some(call => call.operation === 'execute'), false);
});

test('fixed renderer code carries requested text only as serialized data, with an execution deadline', async () => {
  const value = "'); globalThis.pwned = true; //\n</script>";
  const f = fixture(), snapshot = await f.host.inspectControls();
  await f.host.prepareControl('fill', { document_id: snapshot.document_id, ref: 'c2', value });
  const request = f.calls.at(-1), script = controlScript(request);
  assert.equal(request.value, value); assert.equal(request.deadline_epoch_ms, 1026);
  assert(script.includes(')(' + JSON.stringify(request) + ');'));
  assert.match(script, /HTMLInputElement\.prototype/);
  assert.match(script, /element\.ownerDocument !== document/);
});

test('oversized renderer evidence and closed host fail without accepting references', async () => {
  const f = fixture({ run: async request => ({ document_id: request.document_id, source_url: request.source_url, controls: [], title: 'x'.repeat(70000), truncated: false }) });
  await assert.rejects(f.host.inspectControls(), /oversized/);
  f.host.dispose(); await assert.rejects(f.host.inspectControls(), /closed/);
});

test('inspection timeout does not hang the host and late renderer execution carries its original deadline', async () => {
  const f = fixture({ run: () => new Promise(() => {}) });
  await assert.rejects(f.host.inspectControls(), /deadline/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].deadline_epoch_ms, 1026);
});
