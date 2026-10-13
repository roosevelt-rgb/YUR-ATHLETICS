'use strict';

// Private main-process grants. Page content and renderer-supplied descriptors
// never mint a grant; only explicit selection of the visible host document does.
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { normalizeBrowserUrl, MAX_TEXT_CHARS, MAX_TEXT_BYTES, MAX_TEXT_NODES, MAX_RESULT_BYTES } = require('./browser-host');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const SOURCE_SCHEMA = 'yur.work-browser-source.v1';
const ACQUISITION_SCHEMA = 'yur.work-browser-acquisition.v1';
const TTL_MS = 120000;
const MAX_GRANTS = 32;
const MAX_WORK_STEPS = 128;
const AUTHORITY = Object.freeze({ issuer: 'local-user', scope: 'work-proposals', actions: ['read', 'compute', 'propose', 'commit-artifact'], max_steps: MAX_WORK_STEPS });
const HISTORICAL_AUTHORITY = Object.freeze({ issuer: 'local-user', scope: 'work-proposals', actions: ['read', 'compute', 'propose', 'commit-artifact'], max_steps: 20 });
const FRAME_KEYS = 'accepted_receipt,acquisition_id,authority_sha256,conversation_id,input_sha256,mission_id,request_id,schema,source_id,source_sha256,step_index,type';
// Same credential families as repository_context.SECRET_CONTENT, with the
// attachment reader's github_pat_ form. This runs before descriptor persistence.
const PRIVATE_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|[a-z]+:\/\/[^\s/:]+:[^\s/@]+@|["']?(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|authorization|client[_-]?secret|password|passwd|private[_-]?key|secret)["']?\s*[:=]\s*(?:["'][^"'\r\n]+["']|[A-Za-z0-9_+/-]{12,}\s*(?:$|[#;]))/im;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const iso = value => typeof value === 'string' && value.length <= 40 && /T.*(?:Z|[+-]00:00)$/.test(value) && Number.isFinite(Date.parse(value));
function unicode(value) { return typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
function deny(code, message) { const error = new Error(message); error.code = code; return error; }
function noCredentials(value) { if (PRIVATE_CONTENT.test(typeof value === 'string' ? value : canonical(value))) throw deny('BROWSER_PRIVATE_CONTENT', 'Credential-like browser source content is excluded.'); }
function safeSourceUrl(value) {
  if (normalizeBrowserUrl(value) !== value || !unicode(value)) throw deny('INVALID_BROWSER_SOURCE', 'The selected browser URL is invalid.');
  let decoded = value;
  // Match urllib.unquote's tolerant decoding: a literal percent after one
  // decoding pass is valid, and an unrelated bad escape must not hide a token.
  for (let count = 0; count < 2; count++) { decoded = decoded.replace(/(?:%[0-9a-f]{2})+/gi, encoded => Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8')); noCredentials(decoded); }
  const parameters = [...new URL(value).searchParams.entries()];
  if (parameters.length > 100) throw deny('INVALID_BROWSER_SOURCE', 'The selected browser URL has too many parameters.');
  noCredentials(parameters.map(([key, item]) => ({ [key]: item })));
}
function validateSource(source) {
  if (!exact(source, 'expires_at,max_acquisitions,schema,selected_at,source_id,source_url,title') || source.schema !== SOURCE_SCHEMA || !matches(source.source_id, UUID) || source.max_acquisitions !== 1 || !unicode(source.title) || source.title.length > 512 || /[\x00-\x1f\x7f]/.test(source.title) || !iso(source.selected_at) || !iso(source.expires_at)) throw deny('INVALID_BROWSER_SOURCE', 'A Work source requires the exact selected browser descriptor.');
  safeSourceUrl(source.source_url); noCredentials(source.title); noCredentials(source);
  const lifetime = Date.parse(source.expires_at) - Date.parse(source.selected_at);
  if (lifetime <= 0 || lifetime > TTL_MS || Buffer.byteLength(JSON.stringify(source)) > 16384) throw deny('INVALID_BROWSER_SOURCE', 'The selected browser source exceeds its bounds.');
  return JSON.parse(JSON.stringify(source)); // Historical descriptors may be expired.
}
function validateAcquisition(frame, request, missionId = null) {
  const source = validateSource(request.browser_source);
  if (!exact(frame, FRAME_KEYS) || frame.type !== 'browser_acquire' || frame.schema !== ACQUISITION_SCHEMA || !matches(frame.acquisition_id, HEX32) || !matches(frame.mission_id, HEX32) || !Number.isSafeInteger(frame.step_index) || frame.step_index < 0 || frame.step_index >= MAX_WORK_STEPS || !matches(frame.accepted_receipt, HASH)
      || frame.request_id !== request.request_id || frame.conversation_id !== request.conversation_id || !matches(frame.request_id, UUID) || !matches(frame.conversation_id, UUID) || (missionId && frame.mission_id !== missionId) || frame.source_id !== source.source_id
      || frame.source_sha256 !== digest(source) || frame.input_sha256 !== digest({ source_id: source.source_id }) || ![digest(AUTHORITY), digest(HISTORICAL_AUTHORITY)].includes(frame.authority_sha256)
      || frame.acquisition_id !== digest({ mission_id: frame.mission_id, step_index: frame.step_index, tool: 'acquire_selected_page' }).slice(0, 32)) throw deny('INVALID_BROWSER_ACQUISITION', 'Browser acquisition does not match this accepted Work request.');
  return frame;
}
function validateContext(context, source) {
  if (!exact(context, 'acquired_at,limits,schema,sha256,source_url,text,title,truncated') || context.schema !== 'yur.browser-context.v1' || context.source_url !== source.source_url || !unicode(context.text) || !context.text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(context.text) || context.text.length > MAX_TEXT_CHARS || Buffer.byteLength(context.text, 'utf8') > MAX_TEXT_BYTES || !unicode(context.title) || context.title.length > 512 || /[\x00-\x1f\x7f]/.test(context.title) || !iso(context.acquired_at) || Date.parse(context.acquired_at) < Date.parse(source.selected_at) || Date.parse(context.acquired_at) > Date.parse(source.expires_at) || typeof context.truncated !== 'boolean' || !matches(context.sha256, HASH)
      || context.sha256 !== createHash('sha256').update(context.text, 'utf8').digest('hex') || canonical(context.limits) !== canonical({ text_chars: MAX_TEXT_CHARS, text_bytes: MAX_TEXT_BYTES, text_nodes: MAX_TEXT_NODES, main_frame_only: true, form_fields_excluded: true }) || Buffer.byteLength(JSON.stringify(context)) > MAX_RESULT_BYTES) throw deny('INVALID_BROWSER_CONTEXT', 'The browser returned mismatched or oversized page evidence.');
  noCredentials(context.title); noCredentials(context.text); noCredentials(context); safeSourceUrl(context.source_url);
  return JSON.parse(JSON.stringify(context));
}
function createWorkBrowserBroker({ getHost, now = () => Date.now(), monotonic = () => performance.now(), uuid = randomUUID } = {}) {
  if (typeof getHost !== 'function') throw new Error('The browser broker requires the existing native host.');
  const grants = new Map(), bindings = new WeakMap();
  const alive = owner => Boolean(owner && (typeof owner.isDestroyed !== 'function' || !owner.isDestroyed()));
  function purge() { for (const [id, grant] of grants) if (!alive(grant.owner) || (!grant.requestId && monotonic() >= grant.deadline)) { grant.revoked = true; grants.delete(id); } }
  function select(value, owner) {
    if (!exact(value, 'conversation_id') || !matches(value.conversation_id, UUID) || !alive(owner)) throw deny('INVALID_BROWSER_SELECTION', 'Selection requires this window and an exact conversation.');
    purge();
    // Replace only this conversation's unused selection; a running mission
    // retains its separately bound one-shot source.
    for (const [id, grant] of grants) if (grant.owner === owner && grant.conversationId === value.conversation_id && !grant.requestId) { grant.revoked = true; grants.delete(id); }
    if (grants.size >= MAX_GRANTS) throw deny('BROWSER_SOURCE_LIMIT', 'Too many browser selections are pending.');
    const host = getHost();
    if (!host) throw deny('BROWSER_UNAVAILABLE', 'Open the page in the browser before selecting it.');
    const document = host.selectWorkDocument(), selected = now();
    const source = validateSource({ schema: SOURCE_SCHEMA, source_id: uuid(), source_url: document.source_url, title: document.title, selected_at: new Date(selected).toISOString(), expires_at: new Date(selected + TTL_MS).toISOString(), max_acquisitions: 1 });
    grants.set(source.source_id, { source, host, document, owner, conversationId: value.conversation_id, requestId: null, deadline: monotonic() + TTL_MS, used: false, revoked: false });
    return { ok: true, source: JSON.parse(JSON.stringify(source)) };
  }
  function release(value, owner) {
    if (!exact(value, 'conversation_id,source_id') || !matches(value.source_id, UUID) || !matches(value.conversation_id, UUID)) throw deny('INVALID_BROWSER_SELECTION', 'Release requires the exact source and conversation.');
    const grant = grants.get(value.source_id);
    if (!grant || grant.owner !== owner || grant.conversationId !== value.conversation_id || grant.requestId) return { ok: true, result: { released: false } };
    grant.revoked = true; grants.delete(value.source_id);
    return { ok: true, result: { released: true } };
  }
  function bind(request, owner) {
    const source = validateSource(request.browser_source);
    purge();
    const grant = grants.get(source.source_id);
    // A missing current grant does not prevent replay of committed results.
    if (!grant || !alive(owner) || grant.owner !== owner || grant.conversationId !== request.conversation_id || !matches(request.request_id, UUID) || grant.requestId || canonical(grant.source) !== canonical(source)) return null;
    grant.requestId = request.request_id;
    const binding = Object.freeze({}); bindings.set(binding, grant); return binding;
  }
  async function acquire(frame, request, owner, binding, { signal } = {}) {
    validateAcquisition(frame, request);
    const grant = binding && bindings.get(binding);
    if (!grant || grant.revoked || grants.get(frame.source_id) !== grant || grant.owner !== owner || !alive(owner) || grant.requestId !== request.request_id || grant.conversationId !== request.conversation_id || canonical(grant.source) !== canonical(request.browser_source)) throw deny('BROWSER_SOURCE_UNAVAILABLE', 'This Work request has no live operator-selected browser source.');
    if (signal?.aborted) throw deny('BROWSER_ACQUISITION_CANCELLED', 'The Work page acquisition was cancelled.');
    if (grant.acquisition) {
      if (grant.acquisition.frame !== canonical(frame)) throw deny('BROWSER_SOURCE_CONSUMED', 'This selected page was bound to a different acquisition.');
      return grant.acquisition.promise.then(value => {
        if (signal?.aborted || grant.revoked || !alive(owner)) throw deny('BROWSER_ACQUISITION_CANCELLED', 'The Work page acquisition was cancelled.');
        return JSON.parse(JSON.stringify(value));
      });
    }
    if (monotonic() >= grant.deadline) throw deny('BROWSER_SOURCE_EXPIRED', 'The selected browser source expired. Select the page again.');
    if (grant.used) throw deny('BROWSER_SOURCE_CONSUMED', 'This selected page has already been acquired.');
    if (getHost() !== grant.host) throw deny('BROWSER_SOURCE_CHANGED', 'The selected browser view was replaced.');
    grant.used = true;
    const promise = (async () => {
      let context;
      try { context = await grant.host.readSelectedPage(grant.document); }
      catch { throw deny('BROWSER_PAGE_UNAVAILABLE', 'The selected document changed, closed, or could not be read within its bound.'); }
      if (signal?.aborted || grant.revoked || !alive(owner)) throw deny('BROWSER_ACQUISITION_CANCELLED', 'The Work page acquisition was cancelled.');
      if (getHost() !== grant.host) throw deny('BROWSER_SOURCE_CHANGED', 'The selected browser view was replaced during acquisition.');
      if (monotonic() >= grant.deadline) throw deny('BROWSER_SOURCE_EXPIRED', 'The selected browser source expired during acquisition.');
      return validateContext(context, grant.source);
    })();
    grant.acquisition = { frame: canonical(frame), promise };
    return promise;
  }
  function complete(binding) {
    const grant = binding && bindings.get(binding); if (!grant) return;
    grant.revoked = true; grants.delete(grant.source.source_id); bindings.delete(binding);
  }
  function revokeOwner(owner) { for (const [id, grant] of grants) if (grant.owner === owner) { grant.revoked = true; grants.delete(id); } }
  return { select, release, bind, acquire, complete, revokeOwner };
}

module.exports = { createWorkBrowserBroker, validateSource, validateAcquisition, validateContext, canonical, digest, AUTHORITY, TTL_MS };
