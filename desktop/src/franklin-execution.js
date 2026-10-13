'use strict';
// Routes admitted Desktop operations to their existing execution/state owners.
// It neither schedules missions nor owns durable application state.
const { createHash } = require('node:crypto');
const CODING = ['coding_catalog', 'coding_start', 'coding_submit', 'coding_status', 'coding_wait', 'coding_cancel'];
const MEDIA = ['media_submit', 'media_cancel', 'media_resume', 'media_import', 'media_export'];
const BROWSER = ['browser_inspect', 'browser_click', 'browser_fill', 'browser_select'];
const EXECUTION_ACTIONS = Object.freeze(['desktop_capabilities', ...CODING, ...MEDIA, ...BROWSER]);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function createFranklinExecution({ coding, media, browser, surfaces, services, validateMedia, confirm, deny, getSettings }) {
  const seen = new Map();
  function policy(channel, args) {
    const reason = deny(channel, args, getSettings());
    if (reason) throw new Error(reason);
  }
  function check(identity) {
    if (!identity || !/^[a-f0-9]{32}$/.test(identity.action_id) || typeof identity.isActive !== 'function' || !identity.isActive()
        || !identity.owner || identity.owner.isDestroyed()) throw new Error('Franklin execution request is no longer active.');
  }
  function capabilities() {
    return { schema: 'yur.franklin.desktop-capabilities.v1', capabilities: [
      { id: 'coding', connected: Boolean(coding), operations: CODING, state: 'Check coding_catalog for the selected installed runtime, workspace and session state. Execution and native approvals remain with IntelliFlow.' },
      { id: 'media', connected: Boolean(media), operations: MEDIA, state: 'Check media_status for current provider readiness. Submit and resume require confirmation; results use existing media validation and Commit Service.' },
      { id: 'browser', connected: true, operations: ['browser_navigate', 'browser_read', 'browser_back', 'browser_forward', 'browser_reload', ...(browser ? BROWSER : [])], state: 'Inspect current page controls, then request an exact confirmed click, fill or select. References expire on navigation or page changes. A dispatched click is not proof of external delivery; inspect the resulting page.' },
      { id: 'work', connected: true, state: 'Use existing Work tools to create mission plans, assign roles in artifacts, build admitted specialists, validate and commit deliverables. Use coding for new software behavior.' },
      ...(surfaces ? surfaces.catalog().filter(item => !['music', 'unreal', 'outreach'].includes(item.id)).map(item => ({ id: item.id,
        connected: item.status === 'connected', operations: item.actions, requires_confirmation: item.requires_confirmation, state: item.notice })) : []),
      ...(services ? services.catalog() : ['music', 'unreal'].map(id => ({ id, connected: false, operations: [], state: 'No service binding is configured.' }))),
      { id: 'phone-outreach', connected: false, operations: [], state: 'No dedicated delivery provider is configured. Prepare a campaign using Work/coding; an authenticated browser can operate reviewed page controls. Do not claim a send or delivery without checking the resulting service receipt.' },
    ], guidance: 'A connection is not provider health or permission to act. Confirm consequential operations with the human, inspect returned results, and retain mission/role/result references in the current Work artifacts.' };
  }
  async function execute(action, supplied, identity) {
    check(identity);
    if (!object(supplied)) throw new Error('Desktop execution requires a typed payload.');
    const payload = JSON.parse(JSON.stringify(supplied));
    if (Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024) throw new Error('Desktop execution payload exceeds 64 KiB.');
    const keys = Object.keys(payload).sort().join(',');
    let prepared = null, review = null;
    if (action === 'desktop_capabilities') { if (keys) throw new Error('Capability discovery takes no arguments.'); return capabilities(); }
    if (action === 'coding_catalog') { if (keys) throw new Error('Coding discovery takes no arguments.'); if (!coding) throw new Error('IntelliFlow coding is not connected.'); return coding.catalog(identity); }
    if (BROWSER.includes(action)) {
      if (!browser) throw new Error('Browser interaction is not connected.');
      policy('browser:action', [action === 'browser_inspect' ? 'inspectControls' : action.slice(8)]);
      if (action === 'browser_inspect') {
        if (keys) throw new Error('Browser inspection takes no arguments.');
        const result = await browser.inspect(); check(identity); policy('browser:action', ['inspectControls']); return result;
      }
      prepared = await browser.prepare(action.slice(8), payload);
      check(identity); review = prepared.review;
    }
    if (['coding_status', 'coding_wait', 'coding_cancel'].includes(action)) {
      if (!coding) throw new Error('IntelliFlow coding is not connected.');
      // Cancellation is always available for this assistant's own session.
      return coding.execute(action, payload, identity);
    }
    if (action === 'coding_start' || action === 'coding_submit') {
      if (!coding) throw new Error('IntelliFlow coding is not connected.');
      policy(action === 'coding_start' ? 'rc6:connect' : 'rc6:submit', []);
      if (action === 'coding_start' && typeof coding.validate === 'function') coding.validate(action, payload, identity);
    } else if (MEDIA.includes(action)) {
      if (!media) throw new Error('Media Studio is not connected.');
      if (action === 'media_submit') { Object.assign(payload, validateMedia(payload)); policy('media:submit', [payload]); }
      else if (action === 'media_import') { if (keys) throw new Error('Image import uses the human file picker.'); }
      else if (action === 'media_export') { if (keys !== 'asset_id' || !/^[a-f0-9]{64}$/.test(payload.asset_id)) throw new Error('Select a committed media asset.'); }
      else if (keys !== 'job_id' || !/^[a-f0-9]{32}$/.test(payload.job_id)) throw new Error('Select an existing media job.');
      if (action === 'media_resume') policy('media:submit', [payload]);
    } else if (services?.accepts(action)) {
      await services.validate(action, payload, identity);
      review = services.confirmationRequirements(action, payload);
    } else if (surfaces?.accepts(action)) surfaces.validate(action, payload, identity);
    else if (!BROWSER.includes(action)) throw new Error('Desktop execution operation is not connected.');

    const key = identity.action_id;
    const scope = () => ({ action, payload, ...(review ? { review } : {}), mission: identity.mission_id, request: identity.request_id });
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(scope()))).digest('hex');
    if (seen.has(key)) throw new Error('This Desktop execution identity was already used; inspect its saved action receipt.');
    if (seen.size >= 4096) throw new Error('Desktop action identity capacity reached; finish existing work before restarting the Desktop.');
    seen.set(key, fingerprint);
    // File pickers carry their own explicit path confirmation. Read-only surface
    // discovery does not need a second confirmation dialog. A service with one action
    // for reads and writes (Gridiron's gridiron_call) decides from the typed payload.
    const requiresConfirmation = !['media_import', 'media_export', 'marketplace_export'].includes(action) && !surfaces?.isReadOnly(action) && !services?.isReadOnly(action, payload);
    if (requiresConfirmation) {
      if (typeof confirm !== 'function') throw new Error('Human confirmation is not connected.');
      const approved = await confirm({ action, payload, review, fingerprint, mission_id: identity.mission_id, request_id: identity.request_id }, identity);
      check(identity);
      if (fingerprint !== createHash('sha256').update(JSON.stringify(canonical(scope()))).digest('hex')) throw new Error('The reviewed action changed during confirmation.');
      if (approved !== true) return { status: 'rejected', cancelled: true, executed: false, reason: 'The operator did not approve this action.', action, fingerprint };
    }
    check(identity);
    let result;
    if (action.startsWith('coding_')) {
      policy(action === 'coding_start' ? 'rc6:connect' : 'rc6:submit', []);
      result = await coding.execute(action, payload, identity);
    } else if (MEDIA.includes(action)) {
      if (action === 'media_submit' || action === 'media_resume') policy('media:submit', [payload]);
      const operation = action.slice(6);
      if (operation === 'submit') {
        const h = identity.action_id;
        payload.request_id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      result = await media(operation, payload, identity);
      if (!object(result) || result.ok !== true || !object(result.result)) throw new Error(result?.error?.message || 'Media operation did not return a successful receipt.');
      result = result.result;
    } else if (BROWSER.includes(action)) {
      policy('browser:action', [action.slice(8)]);
      result = await prepared.execute();
    } else if (services?.accepts(action)) result = await services.execute(action, payload, identity,
      requiresConfirmation ? { confirmed: true, rights_attested: Boolean(review?.rights_attested), external_approved: Boolean(review?.external_approved) } : {});
    else result = await surfaces.execute(action, payload, identity);
    // The action can finish after a cancellation. Returning the real result lets
    // the existing Work receipt owner record it when still available; it is never
    // safe to repeat a dispatched mutation merely because its reply was lost.
    return { ...result, confirmation: { action, fingerprint, required: requiresConfirmation, approved: requiresConfirmation || undefined } };
  }
  return { execute, capabilities, accepts: action => EXECUTION_ACTIONS.includes(action) || Boolean(surfaces?.accepts(action)) || Boolean(services?.accepts(action)) };
}
module.exports = { createFranklinExecution, EXECUTION_ACTIONS };
