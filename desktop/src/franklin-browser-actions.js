'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const ACTIONS = Object.freeze(['click', 'fill', 'select']);
const LIMITS = Object.freeze({ controls: 80, elements: 2500, options: 40, value_chars: 8000, value_bytes: 16384,
  result_bytes: 64 * 1024, reference_ttl_ms: 120000, pending_actions: 8, main_frame_only: true, sensitive_fields_excluded: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys;
const freeze = value => { if (object(value) || Array.isArray(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

// This entire function is fixed application source. Its argument is serialized
// data, never executable user/model code. References remain in isolated world
// 1002 and retain the actual Element object, not a selector or a DOM attribute.
function browserControlWorld(input) {
  'use strict';
  const key = '__yurBrowserControlReferencesV1';
  const fail = message => { throw new Error(message); };
  const bounded = (value, length) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, length);
  const sensitive = element => ['password', 'file', 'hidden'].includes(element.type)
    || /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:\s|$)/i.test(element.getAttribute('autocomplete') || '');
  function rendered(element) {
    if (!element.isConnected || element.ownerDocument !== document || !element.getClientRects().length) return false;
    for (let parent = element, depth = 0; parent && depth < 100; parent = parent.parentElement, depth++) {
      const style = getComputedStyle(parent);
      if (parent.hidden || parent.inert || parent.getAttribute('aria-hidden') === 'true' || style.display === 'none'
        || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return false;
    }
    return true;
  }
  function labelText(element) {
    if (!element) return '';
    const parts = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node, count = 0, length = 0;
    while ((node = walker.nextNode()) && ++count <= 256 && length < 48000) {
      if (node.parentElement?.closest('input,textarea,select,option,[contenteditable],script,style')) continue;
      parts.push(node.data); length += node.data.length;
    }
    return parts.join(' ');
  }
  function label(element) {
    const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 8)
      .map(id => labelText(document.getElementById(id))).join(' ');
    return element.getAttribute('aria-label') || labelled || Array.from(element.labels || []).slice(0, 8).map(labelText).join(' ')
      || element.getAttribute('title') || element.getAttribute('placeholder')
      || (['BUTTON', 'A'].includes(element.tagName) || element.getAttribute('role') ? labelText(element) : '') || element.getAttribute('name') || element.tagName;
  }
  function description(element) {
    const tag = element.tagName.toLowerCase(), type = bounded(element.type || element.getAttribute('role'), 40);
    const disabled = Boolean(element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true');
    const editable = !element.readOnly && element.getAttribute('aria-readonly') !== 'true';
    const actions = [];
    let target = '';
    if (tag === 'a') { try { const url = new URL(element.href, location.href); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) target = url.href; } catch {} }
    if (!disabled && (tag === 'button' || (tag === 'a' && target) || (tag === 'input' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type))
      || ['button', 'link', 'checkbox', 'switch'].includes(element.getAttribute('role')))) actions.push('click');
    if (!disabled && editable && (tag === 'textarea' || (tag === 'input' && ['text', 'search', 'email', 'tel', 'url', 'number'].includes(type)))) actions.push('fill');
    if (!disabled && tag === 'select' && !element.multiple) actions.push('select');
    const form = element.form, maySubmit = Boolean(form && ((tag === 'button' && type === 'submit') || (tag === 'input' && type === 'submit')));
    const rect = element.getBoundingClientRect();
    const result = { tag, type, label: bounded(label(element), 300), disabled, read_only: !editable, actions,
      in_viewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      may_submit: maySubmit, may_navigate: tag === 'a' || maySubmit,
      target_url: bounded(target || (maySubmit ? element.formAction || form.action : ''), 8192),
      form_method: maySubmit ? bounded(element.formMethod || form.method || 'get', 20) : '' };
    if (tag === 'select') {
      result.options = Array.from(element.options).slice(0, 40).map(option => ({ value: option.value.slice(0, 256), label: bounded(option.label, 200),
        disabled: Boolean(option.disabled || option.parentElement?.disabled), selected: option.selected }));
      result.options_truncated = element.options.length > 40;
    }
    return result;
  }
  function submitFields(element) {
    if (!description(element).may_submit) return null;
    const elements = Array.from(element.form.elements);
    if (elements.length > 80) fail('This form exceeds the bounded submission review.');
    const fields = elements.map(field => {
      if (field.type !== 'hidden' && sensitive(field)) fail('Forms containing credential or file controls are outside browser action scope.');
      return { name: field.name || '', tag: field.tagName.toLowerCase(), type: field.type || '', label: bounded(label(field), 200),
        value: typeof field.value === 'string' ? field.value : '', checked: Boolean(field.checked), disabled: Boolean(field.disabled || field.matches(':disabled')),
        hidden: field.type === 'hidden' || !rendered(field), selected_values: field.options ? Array.from(field.selectedOptions).map(option => option.value) : null };
    });
    if (new TextEncoder().encode(JSON.stringify(fields)).length > 24000) fail('The form values exceed the bounded exact review.');
    return fields;
  }
  function signature(element) {
    // Full bounded state remains private to this isolated world; current form
    // values are never returned by inspection or inserted into model context.
    const value = typeof element.value === 'string' ? element.value : null;
    if (value !== null && value.length > 32000) fail('The control state exceeds its binding budget.');
    const form = element.form;
    const state = { description: description(element), label: label(element), value, checked: Boolean(element.checked),
      name: element.getAttribute('name'), id: element.id, role: element.getAttribute('role'), type: element.getAttribute('type'),
      href: element.getAttribute('href'), target: element.getAttribute('target'), download: element.getAttribute('download'),
      contenteditable: element.getAttribute('contenteditable'), autocomplete: element.getAttribute('autocomplete'),
      form_id: form?.id || null, form_action: form?.action || null, form_method: form?.method || null,
      form_target: form?.target || null, form_enctype: form?.enctype || null, form_no_validate: Boolean(form?.noValidate),
      form_action_override: element.getAttribute('formaction'), form_method_override: element.getAttribute('formmethod'),
      form_target_override: element.getAttribute('formtarget'), form_enctype_override: element.getAttribute('formenctype'),
      form_no_validate_override: element.getAttribute('formnovalidate'),
      min: element.getAttribute('min'), max: element.getAttribute('max'), step: element.getAttribute('step'),
      maxlength: element.getAttribute('maxlength'), pattern: element.getAttribute('pattern'), required: Boolean(element.required),
      submit_fields: submitFields(element), option_count: element.options?.length || 0,
      option_state: element.options ? Array.from(element.options).slice(0, 40).map(option => ({ value: option.value, label: option.label,
        disabled: Boolean(option.disabled || option.parentElement?.disabled), selected: option.selected })) : null };
    const encoded = JSON.stringify(state); if (encoded.length > 48000) fail('The control binding exceeds its state budget.');
    return encoded;
  }
  function validate(entry) {
    if (!entry || !rendered(entry.element) || sensitive(entry.element) || entry.element.form !== entry.form || signature(entry.element) !== entry.signature) {
      fail('The referenced control changed. Inspect the current page again.');
    }
    if (entry.formElements && (entry.formElements.length !== entry.form.elements.length
      || entry.formElements.some((element, index) => element !== entry.form.elements[index]))) fail('The reviewed form controls changed. Inspect the current page again.');
    return entry.element;
  }
  if (!input || Date.now() > input.deadline_epoch_ms) fail('Browser control request expired before execution.');
  if (location.href !== input.source_url) fail('The browser document URL changed. Inspect the current page again.');
  if (input.operation === 'inspect') {
    const state = { document, document_id: input.document_id, source_url: location.href, controls: new Map(), tickets: new Map() };
    globalThis[key] = state;
    const controls = [], walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let element, scanned = 0, bytes = 0, truncated = false;
    while ((element = walker.nextNode())) {
      if (++scanned > 2500 || controls.length >= 80) { truncated = true; break; }
      if (!element.matches('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="switch"]') || sensitive(element) || !rendered(element)) continue;
      let fingerprint; try { fingerprint = signature(element); } catch { truncated = true; continue; }
      const ref = 'c' + (controls.length + 1), descriptor = { ref, ...description(element) };
      const size = new TextEncoder().encode(JSON.stringify(descriptor)).length;
      if (bytes + size > 48000) { truncated = true; break; }
      state.controls.set(ref, { element, form: element.form, signature: fingerprint, descriptor,
        formElements: descriptor.may_submit ? Array.from(element.form.elements) : null }); controls.push(descriptor); bytes += size;
    }
    return { document_id: input.document_id, source_url: location.href, title: document.title.slice(0, 512), controls, truncated };
  }
  const state = globalThis[key];
  if (!state || state.document !== document || state.document_id !== input.document_id || state.source_url !== location.href) fail('Browser control references expired. Inspect the current document again.');
  if (input.operation === 'prepare') {
    const entry = state.controls.get(input.ref), element = validate(entry), descriptor = description(element);
    if (!descriptor.actions.includes(input.action)) fail('This control does not support the requested action.');
    if (input.action === 'fill') {
      if (element.maxLength >= 0 && input.value.length > element.maxLength) fail('The proposed value exceeds this control\'s maximum length.');
      if (element.tagName === 'INPUT' && element.type === 'number') {
        const probe = document.createElement('input'); probe.type = 'number'; probe.value = input.value;
        if (probe.value !== input.value) fail('The proposed value is not a valid exact numeric control value.');
      }
    }
    if (input.action === 'select') {
      const choice = descriptor.options.find(option => option.value === input.value && !option.disabled);
      if (!choice || !Array.from(element.options).slice(0, 40).some(option => option.value === input.value && !option.disabled && !option.parentElement?.disabled)) fail('Choose an enabled exact option from the inspected control.');
    }
    for (const [id, ticket] of state.tickets) if (Date.now() > ticket.expires_epoch_ms) state.tickets.delete(id);
    if (state.tickets.size >= 8) fail('Too many browser actions await review. Inspect the page again.');
    state.tickets.set(input.ticket_id, { entry, action: input.action, value: input.value, expires_epoch_ms: input.expires_epoch_ms });
    const fields = descriptor.may_submit ? submitFields(element) : null;
    return { document_id: state.document_id, source_url: state.source_url, ref: input.ref, action: input.action, control: descriptor,
      ...(fields ? { form_fields: fields.filter(field => !field.hidden), hidden_form_fields: fields.filter(field => field.hidden).length } : {}),
      ...(input.action === 'click' ? {} : { value: input.value }) };
  }
  if (input.operation !== 'execute') fail('Unsupported browser control operation.');
  const ticket = state.tickets.get(input.ticket_id); state.tickets.delete(input.ticket_id);
  if (!ticket || Date.now() > ticket.expires_epoch_ms) fail('The browser action expired or was already used.');
  const element = validate(ticket.entry);
  if (!description(element).actions.includes(ticket.action)) fail('The reviewed control no longer supports this action.');
  if (ticket.action === 'click') element.click();
  else {
    const prototype = ticket.action === 'select' ? HTMLSelectElement.prototype
      : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) fail('The native control value setter is unavailable.');
    setter.call(element, ticket.value);
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { performed: true, action: ticket.action, document_id: state.document_id, source_url: state.source_url,
    ref: ticket.entry.descriptor.ref, notice: 'The reviewed DOM action was dispatched. Confirm subsequent page state before claiming an external outcome.' };
}

function controlScript(request) {
  return '(() => { try { return (' + browserControlWorld.toString() + ')(' + JSON.stringify(request)
    + '); } catch (error) { return { control_error: String(error.message || "Browser control request failed.").slice(0, 500) }; } })()';
}

function createBrowserControlActions({ selectDocument, validateDocument, run, now = () => performance.now(), wallNow = () => Date.now(), timeoutMs = 2000 }) {
  if (![selectDocument, validateDocument, run].every(callback => typeof callback === 'function')) throw new Error('Browser controls require the existing document owner.');
  const tickets = new WeakMap(), pending = new Map();
  let current = null, busy = false, closed = false;
  function ensure() { if (closed) throw new Error('Browser controls are closed.'); }
  function checkCurrent(documentId) {
    ensure();
    if (!current || current.id !== documentId || now() >= current.deadline) throw new Error('Browser control references expired. Inspect the current document again.');
    validateDocument(current.document); return current;
  }
  async function evaluate(request, mutation = false) {
    ensure(); if (busy) throw new Error('Another browser control request is in progress.'); busy = true;
    let timer;
    try {
      const result = await Promise.race([run({ ...request, deadline_epoch_ms: wallNow() + timeoutMs }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(mutation
          ? 'Browser action outcome is uncertain after its deadline. Inspect the page before another action.' : 'Browser control inspection exceeded its deadline.')), timeoutMs); })]);
      ensure();
      if (!object(result) || Buffer.byteLength(JSON.stringify(result)) > LIMITS.result_bytes) throw new Error('Browser control evidence is invalid or oversized.');
      if (typeof result.control_error === 'string') throw new Error(result.control_error);
      return result;
    } finally { clearTimeout(timer); busy = false; }
  }
  function purge() { for (const [id, value] of pending) if (value.document !== current || now() >= value.deadline) { value.used = true; pending.delete(id); } }
  async function inspectControls() {
    ensure();
    if (busy) throw new Error('Another browser control request is in progress.');
    const document = selectDocument(), id = randomUUID();
    const next = { document, id, deadline: now() + LIMITS.reference_ttl_ms, refs: new Set() };
    current = next; purge();
    const result = await evaluate({ operation: 'inspect', document_id: id, source_url: document.source_url });
    checkCurrent(id);
    if (current !== next || result.document_id !== id || result.source_url !== document.source_url || !Array.isArray(result.controls)
      || result.controls.length > LIMITS.controls || typeof result.truncated !== 'boolean' || typeof result.title !== 'string') throw new Error('The inspected browser document returned mismatched control evidence.');
    for (const control of result.controls) {
      if (!object(control) || !/^c(?:[1-9]|[1-7][0-9]|80)$/.test(control.ref) || next.refs.has(control.ref) || !Array.isArray(control.actions)
        || control.actions.some(action => !ACTIONS.includes(action))) throw new Error('The browser returned invalid control references.');
      next.refs.add(control.ref);
    }
    return { schema: 'yur.browser-controls.v1', ...result, limits: { ...LIMITS }, trust: 'untrusted-page-data', authority: 'context-only' };
  }
  async function prepareControl(action, payload) {
    if (!ACTIONS.includes(action) || !exact(payload, action === 'click' ? 'document_id,ref' : 'document_id,ref,value')) throw new Error('Select click, fill, or select with an exact inspected document and reference.');
    if (action !== 'click' && (typeof payload.value !== 'string' || payload.value.length > LIMITS.value_chars || Buffer.byteLength(payload.value) > LIMITS.value_bytes
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(payload.value))) throw new Error('Browser field values exceed the bounded text contract.');
    const document = checkCurrent(payload.document_id);
    if (typeof payload.ref !== 'string' || !document.refs.has(payload.ref)) throw new Error('The control reference is not from this browser inspection.');
    purge(); if (pending.size >= LIMITS.pending_actions) throw new Error('Too many browser actions await operator review.');
    const id = randomUUID(), deadline = Math.min(document.deadline, now() + LIMITS.reference_ttl_ms);
    const review = await evaluate({ operation: 'prepare', action, ...payload, source_url: document.document.source_url, ticket_id: id,
      expires_epoch_ms: wallNow() + Math.max(0, deadline - now()) });
    checkCurrent(payload.document_id);
    if (current !== document || review.document_id !== document.id || review.source_url !== document.document.source_url || review.ref !== payload.ref
      || review.action !== action || !object(review.control) || (action !== 'click' && review.value !== payload.value)) throw new Error('The browser action review does not match the requested control and value.');
    const ticket = Object.create(null);
    Object.defineProperty(ticket, 'review', { value: freeze(JSON.parse(JSON.stringify(review))), enumerable: true });
    Object.defineProperty(ticket, 'toJSON', { value() { throw new Error('Browser execution tickets remain private to their host.'); } });
    Object.freeze(ticket);
    const binding = { id, document, deadline, used: false };
    tickets.set(ticket, binding); pending.set(id, binding); return ticket;
  }
  async function executeControl(ticket) {
    const binding = ticket && tickets.get(ticket);
    if (!binding || binding.used || pending.get(binding.id) !== binding) throw new Error('The browser action ticket is foreign or already used.');
    binding.used = true; pending.delete(binding.id);
    const document = checkCurrent(binding.document.id);
    if (document !== binding.document || now() >= binding.deadline) throw new Error('The reviewed browser action expired. Inspect the page again.');
    const result = await evaluate({ operation: 'execute', document_id: document.id, source_url: document.document.source_url, ticket_id: binding.id }, true);
    if (result.performed !== true || result.action !== ticket.review.action || result.document_id !== document.id || result.ref !== ticket.review.ref
      || result.source_url !== document.document.source_url) throw new Error('Browser action outcome is uncertain; inspect the current page.');
    return { ...result, trust: 'untrusted-page-data', authority: 'context-only' };
  }
  return { inspectControls, prepareControl, executeControl, dispose() { closed = true; current = null; for (const value of pending.values()) value.used = true; pending.clear(); } };
}
module.exports = { createBrowserControlActions, controlScript, LIMITS, ACTIONS };
