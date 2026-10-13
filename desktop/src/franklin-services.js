'use strict';
const http = require('node:http');
const { createHash } = require('node:crypto');

// Typed clients of existing service owners only. No engine, worker loop, source
// launch, credentials, or domain persistence belongs to this adapter.
const SERVICE_ACTIONS = Object.freeze(['services_status', 'music_catalog', 'music_state', 'music_document',
  'music_generate', 'music_status', 'music_cancel', 'music_resume', 'music_export', 'nova_open']);
const READ_ONLY = new Set(['services_status', 'music_catalog', 'music_state', 'music_status']);
const ID = /^[a-f0-9]{32}(?:[a-f0-9]{32})?$/;
const JOB = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KINDS = ['project', 'composition', 'lyrics', 'job', 'variant', 'delivery'];
const LOCAL_PROVIDERS = new Set(['local-score', 'comfy-ace-step']);
const MAX_INPUT = 65536, MAX_OUTPUT = 96 * 1024, MAX_RESPONSE = 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, required, optional = []) {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    throw new Error('Service action requires its exact typed fields.');
}
function text(value, maximum, nonblank = false, singleLine = false) {
  if (typeof value !== 'string' || [...value].length > maximum || (nonblank && !value.trim())
      || (singleLine ? /[\u0000-\u001f\u007f]/ : /\u0000/).test(value))
    throw new Error('Service text exceeds its declared contract.');
}
function integer(value, low, high) {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new Error('Service number exceeds its declared contract.');
}
function documentId(value, job = false) {
  if (typeof value !== 'string' || !(job ? JOB : ID).test(value)) throw new Error('Select an observed Music document identity.');
}
function jsonCopy(value, maximum) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 30000 || depth > 24) throw new Error('Service JSON exceeds its complexity budget.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !plain(item)) throw new Error('Service data must be finite JSON.');
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Service JSON contains an unsafe field.');
      visit(child, depth + 1);
    }
  }
  visit(value, 0); const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > maximum) throw new Error('Service JSON exceeds its byte budget.');
  return JSON.parse(raw);
}
function identityChecked(identity) {
  if (!plain(identity) || !UUID.test(String(identity.request_id)) || !JOB.test(String(identity.mission_id))
      || !JOB.test(String(identity.action_id)) || !identity.owner || typeof identity.owner.isDestroyed !== 'function'
      || identity.owner.isDestroyed() || typeof identity.isActive !== 'function' || !identity.isActive())
    throw new Error('Franklin service request is unavailable or cancelled.');
}
function musicConfiguration(value) {
  if (!plain(value) || typeof value.endpoint !== 'string' || typeof value.token !== 'string'
      || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(value.endpoint)
      || !/^[\x21-\x7e]{32,4096}$/.test(value.token)) throw new Error('Music service requires a host-configured loopback endpoint and access token.');
  const url = new URL(value.endpoint);
  if (!url.port || Number(url.port) > 65535) throw new Error('Music service requires a valid loopback port.');
  return { endpoint: url.origin, token: value.token };
}
function novaConfiguration(value) {
  if (!plain(value) || typeof value.site_url !== 'string' || value.site_url.length > 2048) throw new Error('Nova project handoff is not configured by the host.');
  let url; try { url = new URL(value.site_url); } catch { throw new Error('Nova project handoff is not configured by the host.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !url.hostname.includes('.') || /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|\[)/i.test(url.hostname)
      || /\.(local|localhost)$/i.test(url.hostname)) throw new Error('Nova handoff requires an exact host-configured HTTPS Site.');
  return url.href;
}
function scrub(value, token) {
  if (typeof value === 'string') return value.split(token).join('[redacted]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  if (Array.isArray(value)) return value.map(child => scrub(child, token));
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|authorization|cookie|credential|api.?key|^key$/i.test(key))
    .map(([key, child]) => [key, scrub(child, token)]));
}
function createFranklinServices({ getMusicConfiguration = () => null, getNovaConfiguration = () => null,
  openNova, deny, getSettings, timeoutMs = 15000 } = {}) {
  if (typeof deny !== 'function' || typeof getSettings !== 'function' || typeof getMusicConfiguration !== 'function'
      || typeof getNovaConfiguration !== 'function') throw new Error('Franklin services require trusted host configuration and policy checks.');
  integer(timeoutMs, 50, 30000);
  const mutations = new Set(), prepared = new Map();
  const accepts = action => SERVICE_ACTIONS.includes(action);
  const isReadOnly = action => accepts(action) && READ_ONLY.has(action);
  function validate(action, supplied, identity) {
    identityChecked(identity);
    if (!accepts(action)) throw new Error('This service action is not connected.');
    const payload = jsonCopy(supplied, MAX_INPUT);
    if (['services_status', 'music_state', 'nova_open'].includes(action)) fields(payload, []);
    else if (action === 'music_catalog') {
      fields(payload, [], ['kind', 'limit', 'offset']);
      if (payload.kind !== undefined && !KINDS.includes(payload.kind)) throw new Error('Select a supported Music catalog kind.');
      if (payload.limit !== undefined) integer(payload.limit, 1, 50);
      if (payload.offset !== undefined) integer(payload.offset, 0, 10000);
    } else if (action === 'music_document') {
      fields(payload, ['kind', 'data']);
      if (payload.kind === 'composition') { fields(payload.data, ['title']); text(payload.data.title, 160, true); }
      else if (payload.kind === 'lyrics') { fields(payload.data, ['composition_id', 'text']); documentId(payload.data.composition_id); text(payload.data.text, 20000); }
      else throw new Error('Desktop creates only immutable Music compositions and lyric versions.');
    } else if (action === 'music_generate') {
      fields(payload, ['request']);
      const request = payload.request;
      fields(request, ['composition_id', 'lyrics_id', 'provider'], ['variants', 'instrumental', 'private', 'mode', 'style', 'genre', 'mood',
        'voice', 'harmonies', 'duration', 'tempo', 'seed', 'model', 'song_description', 'negative_tags', 'style_weight', 'creativity']);
      documentId(request.composition_id); documentId(request.lyrics_id);
      if (typeof request.provider !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(request.provider)) throw new Error('Select an observed Music provider identifier.');
      for (const [key, low, high] of [['variants', 1, 4], ['duration', 4, 300], ['tempo', 40, 220], ['seed', 0, 2147483647]])
        if (request[key] !== undefined) integer(request[key], low, high);
      for (const key of ['instrumental', 'private']) if (request[key] !== undefined && typeof request[key] !== 'boolean') throw new Error('Music settings require explicit booleans.');
      if (request.mode !== undefined && !['simple', 'custom'].includes(request.mode)) throw new Error('Select Simple or Custom Music mode.');
      for (const [key, maximum] of [['style', 1000], ['genre', 1000], ['mood', 1000], ['voice', 1000], ['harmonies', 1000], ['model', 80], ['song_description', 3000], ['negative_tags', 1000]])
        if (request[key] !== undefined) text(request[key], maximum);
      for (const key of ['style_weight', 'creativity']) if (request[key] !== undefined && (typeof request[key] !== 'number' || !Number.isFinite(request[key]) || request[key] < 0 || request[key] > 1)) throw new Error('Music weights must be from zero to one.');
      if (!LOCAL_PROVIDERS.has(request.provider) && request.private !== false) throw new Error('External Music generation requires an explicitly reviewed non-private request.');
    } else if (action === 'music_export') {
      fields(payload, ['variant_ids']);
      if (!Array.isArray(payload.variant_ids) || payload.variant_ids.length < 1 || payload.variant_ids.length > 8 || new Set(payload.variant_ids).size !== payload.variant_ids.length)
        throw new Error('Select one to eight distinct Music variants.');
      payload.variant_ids.forEach(value => documentId(value));
    } else { fields(payload, ['job_id']); documentId(payload.job_id, true); }
    let configuration = null;
    if (action.startsWith('music_')) configuration = musicConfiguration(getMusicConfiguration());
    if (action === 'nova_open') { configuration = novaConfiguration(getNovaConfiguration()); if (typeof openNova !== 'function') throw new Error('Nova browser handoff is not connected.'); }
    checkPolicy(action, payload);
    if (!isReadOnly(action)) {
      const digest = createHash('sha256').update(JSON.stringify({ action, payload, configuration, mission: identity.mission_id, request: identity.request_id })).digest('hex');
      const prior = prepared.get(identity.action_id);
      if (prior && (prior.digest !== digest || prior.owner !== identity.owner)) throw new Error('The reviewed service scope or host configuration changed; request a fresh review.');
      if (!prior && prepared.size >= 4096) throw new Error('Service review identity capacity reached.');
      prepared.set(identity.action_id, { digest, owner: identity.owner, configuration });
    }
    return payload;
  }
  function checkPolicy(action, payload) {
    const blocked = deny('franklin:service', [{ action, payload }], getSettings());
    if (blocked) throw new Error('Desktop policy does not permit this service action.');
  }
  function confirmationRequirements(action, payload) {
    const rights = action === 'music_generate' || action === 'music_document' && payload?.kind === 'lyrics';
    const external = action === 'music_generate' && !LOCAL_PROVIDERS.has(payload?.request?.provider);
    return { required: !isReadOnly(action), rights_attested: rights, external_approved: external,
      review: [rights ? 'Confirm that you have authority to use these lyrics and creative inputs.' : '',
        external ? 'Approve transmission to the selected Music provider and use of its account credits. Actual provider cost remains unknown until reconciled.' : '',
        action === 'music_export' ? 'Create a delivery ZIP in the existing Music storage.' : '',
        action === 'nova_open' ? 'Open the host-configured Nova Site. Its own sign-in, review, commit and renderer controls remain authoritative.' : ''].filter(Boolean).join(' ') };
  }
  function catalog() {
    let configured = false, handoff = false;
    try { musicConfiguration(getMusicConfiguration()); configured = true; } catch {}
    try { novaConfiguration(getNovaConfiguration()); handoff = typeof openNova === 'function'; } catch {}
    return [
      { id: 'music', actions: SERVICE_ACTIONS.filter(action => action.startsWith('music_')), status: configured ? 'configured' : 'unavailable',
        adapter_bound: true, service_health: 'unchecked', requires_confirmation: SERVICE_ACTIONS.filter(action => action.startsWith('music_') && !isReadOnly(action)),
        notice: 'Existing Music service owns jobs, providers, validation and committed assets. Configuration is not a live health or generation result.' },
      { id: 'nova', actions: handoff ? ['nova_open'] : [], status: handoff ? 'handoff-only' : 'unavailable', adapter_bound: handoff,
        service_health: 'unchecked', renderer_execution: false, requires_confirmation: ['nova_open'],
        notice: 'Project browser handoff only. Nova retains authenticated project ownership, proposal review, commit and native renderer acknowledgement.' },
    ];
  }
  function exchange(configuration, route, body, identity) {
    identityChecked(identity);
    const raw = body === undefined ? null : JSON.stringify(jsonCopy(body, MAX_INPUT));
    return new Promise((resolve, reject) => {
      let settled = false, dispatched = false, response, timer, cancellation;
      const fail = () => {
        if (settled) return;
        const error = new Error(raw !== null && dispatched ? 'Music operation outcome is uncertain; inspect its saved job or receipt before retrying.' : 'Music service request failed or was cancelled; configuration and source details are withheld.');
        error.code = raw !== null && dispatched ? 'SERVICE_OUTCOME_UNCERTAIN' : 'SERVICE_UNAVAILABLE';
        finish(error);
      };
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); clearInterval(cancellation);
        if (error) { response?.destroy(); request.destroy(); reject(error); } else resolve(value);
      };
      const request = http.request(configuration.endpoint + route, { method: raw === null ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + configuration.token, Accept: 'application/json', ...(raw === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }) } }, result => {
        response = result;
        if (result.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(result.headers['content-type'] || '')) { fail(); return; }
        const length = result.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) { fail(); return; }
        const chunks = []; let bytes = 0;
        result.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_RESPONSE) fail(); else chunks.push(chunk); });
        result.on('error', fail); result.on('aborted', fail);
        result.on('end', () => {
          if (settled) return;
          try {
            if (length && bytes !== Number(length)) throw new Error();
            identityChecked(identity);
            finish(null, jsonCopy(scrub(JSON.parse(Buffer.concat(chunks).toString('utf8')), configuration.token), MAX_RESPONSE));
          } catch { fail(); }
        });
      });
      request.on('error', fail);
      timer = setTimeout(fail, timeoutMs);
      cancellation = setInterval(() => { try { identityChecked(identity); } catch { fail(); } }, 50);
      try { identityChecked(identity); dispatched = true; request.end(raw); } catch { fail(); }
    });
  }
  async function execute(action, supplied, identity, confirmation) {
    const payload = validate(action, supplied, identity), requirements = confirmationRequirements(action, payload);
    if (requirements.required && (!plain(confirmation) || confirmation.confirmed !== true
        || requirements.rights_attested && confirmation.rights_attested !== true
        || requirements.external_approved && confirmation.external_approved !== true)) throw new Error('Explicit host-reviewed confirmation and required attestations are missing.');
    if (action === 'services_status') return { services: catalog(), trust: 'untrusted-source-data', authority: 'context-only' };
    if (requirements.required) {
      if (mutations.has(identity.action_id)) throw new Error('This service action was already dispatched; inspect its saved receipt.');
      if (mutations.size >= 4096) throw new Error('Service action identity capacity reached.');
      mutations.add(identity.action_id);
    }
    identityChecked(identity); checkPolicy(action, payload);
    if (action === 'nova_open') {
      try { await openNova(prepared.get(identity.action_id).configuration, identity); }
      catch { throw new Error('Nova project handoff failed; inspect the existing browser before retrying.'); }
      return { opened: true, handoff_only: true, renderer_execution: false, trust: 'untrusted-source-data', authority: 'context-only' };
    }
    const configuration = prepared.get(identity.action_id)?.configuration ?? musicConfiguration(getMusicConfiguration());
    let route, body;
    if (action === 'music_state') route = '/api/state';
    else if (action === 'music_catalog') { const query = new URLSearchParams({ limit: String(payload.limit ?? 20), offset: String(payload.offset ?? 0) }); if (payload.kind) query.set('kind', payload.kind); route = '/api/catalog?' + query; }
    else if (action === 'music_status') route = '/api/history?id=' + payload.job_id;
    else if (action === 'music_document') { route = '/api/documents'; body = { ...payload, data: { ...payload.data, ...(payload.kind === 'lyrics' ? { rights_attested: true } : {}) }, id: identity.action_id, revision: 0 }; }
    else if (action === 'music_generate') { route = '/api/generate'; body = { request: { ...payload.request, rights_attested: true, external_approved: requirements.external_approved }, idempotency_key: identity.action_id }; }
    else if (action === 'music_export') { route = '/api/export'; body = { variants: payload.variant_ids }; }
    else { route = '/api/jobs/' + action.slice(6); body = { id: payload.job_id }; }
    let result = await exchange(configuration, route, body, identity);
    if (action === 'music_state') {
      if (!plain(result) || !Array.isArray(result.providers) || typeof result.worker_alive !== 'boolean') throw new Error('Music health response does not match its contract.');
      result = { providers: result.providers, worker_alive: result.worker_alive, integrity: result.integrity ?? null,
        usage: result.usage ?? null, limits: result.limits ?? null, document_count: Array.isArray(result.documents) ? result.documents.length : null };
    } else if (action === 'music_catalog') {
      if (!Array.isArray(result) || result.length > (payload.limit ?? 20)) throw new Error('Music catalog response does not match its contract.');
      result = { documents: result };
    } else if (action === 'music_status') {
      if (!Array.isArray(result) || !result.length || result.some(row => row?.id !== payload.job_id || row.kind !== 'job')) throw new Error('Music job history does not match the requested identity.');
      result = { job: result.at(-1), history_revisions: result.length };
    } else {
      const kind = action === 'music_document' ? payload.kind : action === 'music_export' ? 'delivery' : 'job';
      if (!plain(result) || result.kind !== kind || !ID.test(String(result.id)) || !plain(result.data)
          || action === 'music_document' && result.id !== identity.action_id
          || ['music_cancel', 'music_resume'].includes(action) && result.id !== payload.job_id) {
        const error = new Error('Music mutation response is invalid; outcome is uncertain, inspect the existing service receipt.');
        error.code = 'SERVICE_OUTCOME_UNCERTAIN'; throw error;
      }
      result = { document: result };
    }
    try { return { ...jsonCopy(result, MAX_OUTPUT), trust: 'untrusted-source-data', authority: 'context-only' }; }
    catch (error) {
      if (body !== undefined) {
        const uncertain = new Error('Music returned an unreadable receipt after dispatch. Inspect its saved job before submitting again.');
        uncertain.code = 'SERVICE_OUTCOME_UNCERTAIN'; throw uncertain;
      }
      throw error;
    }
  }
  return { accepts, isReadOnly, validate, confirmationRequirements, catalog, execute };
}
module.exports = { createFranklinServices, SERVICE_ACTIONS };
