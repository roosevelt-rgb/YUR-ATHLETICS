'use strict';

// Host-process contract only. Do not expose this object through preload, IPC, model
// tools, prompts, logs, or source indexes. A model may see only an opaque handle.
// The host must inject an OS-backed key store, encrypted record store, real admin
// authentication/confirmation, and trusted provider adapters before integration.
const { randomUUID } = require('node:crypto');

const MAX_SECRET_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_TICKET_MS = 5 * 60 * 1000;
const HANDLE = /^sv1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RESOURCE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function sameFields(value, expected) {
  return exact(value, Object.keys(expected))
    && Object.keys(expected).every(key => value[key] === expected[key]);
}

function id(value) {
  return typeof value === 'string' && value.length <= 96 && ID.test(value);
}

function scopeOf(value) {
  if (!exact(value, ['runtime', 'provider', 'action', 'resource'])
      || !id(value.runtime) || !id(value.provider) || !id(value.action)
      || typeof value.resource !== 'string' || !RESOURCE.test(value.resource)
      || value.resource.includes('..') || value.resource.includes('//')) fail('VAULT_INVALID_SCOPE');
  return Object.freeze({ runtime: value.runtime, provider: value.provider,
    action: value.action, resource: value.resource });
}

function sameScope(a, b) {
  return a.runtime === b.runtime && a.provider === b.provider
    && a.action === b.action && a.resource === b.resource;
}

function metadata(value) {
  if (!(exact(value, ['handle', 'providerId', 'createdAt'])
      || exact(value, ['handle', 'providerId', 'createdAt', 'keyId', 'ciphertext']))
      || typeof value.handle !== 'string' || !HANDLE.test(value.handle) || !id(value.providerId)
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)))
    fail('VAULT_STORE_UNAVAILABLE');
  return Object.freeze({ handle: value.handle, providerId: value.providerId,
    createdAt: value.createdAt });
}

function aadFor(meta) {
  return Buffer.from(JSON.stringify({ version: 1, handle: meta.handle,
    providerId: meta.providerId, createdAt: meta.createdAt }), 'utf8');
}

function createSecretVault({ recordStore, keyStore, getPrincipal, authorizeAdmin,
  useAdapters, now = Date.now } = {}) {
  if (!recordStore || typeof recordStore.put !== 'function' || typeof recordStore.get !== 'function'
      || typeof recordStore.list !== 'function' || !keyStore
      || typeof keyStore.seal !== 'function' || typeof keyStore.unseal !== 'function'
      || typeof getPrincipal !== 'function' || typeof authorizeAdmin !== 'function'
      || !record(useAdapters) || !Object.keys(useAdapters).length
      || Object.entries(useAdapters).some(([name, adapter]) => !id(name) || typeof adapter !== 'function')
      || typeof now !== 'function') fail('VAULT_INTEGRATION_REQUIRED');

  // Take a snapshot so a later registry mutation cannot redirect a granted use.
  const adapters = new Map(Object.entries(useAdapters));

  // Tickets are non-serializable object identities. JSON or IPC cloning cannot
  // reconstruct one. They are deliberately not durable across process restarts.
  const tickets = new WeakMap();

  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('VAULT_CLOCK_UNAVAILABLE');
    return value;
  }

  async function requireAdmin(action, requestedScope) {
    try {
      const principal = await getPrincipal();
      if (!record(principal) || !id(principal.id) || principal.role !== 'admin') fail('VAULT_DENIED');
      const decision = await authorizeAdmin({ principal: { id: principal.id, role: principal.role },
        action, scope: requestedScope });
      if (!exact(decision, ['allowed', 'role', 'interactive', 'principalId', 'action', 'scope'])
          || decision.allowed !== true || decision.role !== 'admin'
          || decision.interactive !== true || decision.principalId !== principal.id
          || decision.action !== action || !sameFields(decision.scope, requestedScope)) fail('VAULT_DENIED');
    } catch { fail('VAULT_DENIED'); }
  }

  async function stored(handle) {
    let value;
    try { value = await recordStore.get(handle); } catch { fail('VAULT_STORE_UNAVAILABLE'); }
    if (!value || value.handle !== handle) fail('VAULT_UNAVAILABLE');
    if (!exact(value, ['handle', 'providerId', 'createdAt', 'keyId', 'ciphertext']))
      fail('VAULT_STORE_UNAVAILABLE');
    const meta = metadata(value);
    if (!id(value.keyId) || !Buffer.isBuffer(value.ciphertext)
        || !value.ciphertext.length || value.ciphertext.length > MAX_CIPHERTEXT_BYTES)
      fail('VAULT_STORE_UNAVAILABLE');
    return { ...meta, keyId: value.keyId, ciphertext: value.ciphertext };
  }

  async function enroll({ providerId, plaintext } = {}) {
    // This function takes ownership of a Buffer and clears it on every exit.
    try {
      if (!id(providerId) || !Buffer.isBuffer(plaintext) || plaintext.length < 1
          || plaintext.length > MAX_SECRET_BYTES) fail('VAULT_INVALID_INPUT');
      await requireAdmin('secret.create', { providerId });
      const meta = { handle: 'sv1_' + randomUUID(), providerId,
        createdAt: new Date(time()).toISOString() };
      let sealed;
      try { sealed = await keyStore.seal(plaintext, aadFor(meta)); }
      catch { fail('VAULT_CRYPTO_UNAVAILABLE'); }
      if (!exact(sealed, ['keyId', 'ciphertext']) || !id(sealed.keyId)
          || !Buffer.isBuffer(sealed.ciphertext)
          || !sealed.ciphertext.length || sealed.ciphertext.length > MAX_CIPHERTEXT_BYTES
          || (sealed.ciphertext.length === plaintext.length && sealed.ciphertext.equals(plaintext)))
        fail('VAULT_CRYPTO_UNAVAILABLE');
      try { await recordStore.put({ ...meta, keyId: sealed.keyId,
        ciphertext: Buffer.from(sealed.ciphertext) }); }
      catch { fail('VAULT_STORE_UNAVAILABLE'); }
      return metadata(meta);
    } finally {
      if (Buffer.isBuffer(plaintext)) plaintext.fill(0);
    }
  }

  async function list() {
    await requireAdmin('secret.list', {});
    let values;
    try { values = await recordStore.list(); } catch { fail('VAULT_STORE_UNAVAILABLE'); }
    if (!Array.isArray(values)) fail('VAULT_STORE_UNAVAILABLE');
    return values.map(metadata);
  }

  async function issueUseTicket({ handle, scope, ttlMs } = {}) {
    if (typeof handle !== 'string' || !HANDLE.test(handle)
        || !Number.isInteger(ttlMs) || ttlMs < 1
        || ttlMs > MAX_TICKET_MS) fail('VAULT_INVALID_INPUT');
    const requested = scopeOf(scope);
    if (!adapters.has(requested.runtime)) fail('VAULT_INVALID_SCOPE');
    await requireAdmin('secret.grant', { handle, ...requested });
    const secret = await stored(handle);
    if (secret.providerId !== requested.provider) fail('VAULT_DENIED');
    const ticket = Object.freeze(Object.create(null));
    const issuedAt = time();
    tickets.set(ticket, { handle, scope: requested, issuedAt, expiresAt: issuedAt + ttlMs });
    return ticket;
  }

  function revokeUseTicket(ticket) {
    if (ticket && typeof ticket === 'object') tickets.delete(ticket);
  }

  async function executeUse({ handle, ticket, scope } = {}) {
    // Consume before the first await, including for a wrong scope or expired use.
    const grant = ticket && typeof ticket === 'object' ? tickets.get(ticket) : undefined;
    if (grant) tickets.delete(ticket);
    if (!grant) fail('VAULT_DENIED');
    const requested = scopeOf(scope);
    const checkedAt = time();
    if (handle !== grant.handle || !sameScope(requested, grant.scope)
        || checkedAt < grant.issuedAt || checkedAt > grant.expiresAt) fail('VAULT_DENIED');
    const value = await stored(handle);
    if (value.providerId !== requested.provider) fail('VAULT_DENIED');
    let plaintext;
    try {
      plaintext = await keyStore.unseal({ keyId: value.keyId,
        ciphertext: value.ciphertext }, aadFor(value));
      if (!Buffer.isBuffer(plaintext) || !plaintext.length || plaintext.length > MAX_SECRET_BYTES)
        fail('VAULT_CRYPTO_UNAVAILABLE');
      // The adapter is fixed at construction by trusted host code. Its return
      // value is intentionally discarded; provider outcomes use existing job paths.
      await adapters.get(requested.runtime)({ secret: plaintext, handle,
        scope: requested });
      return Object.freeze({ handle, outcome: 'adapter-returned' });
    } catch { fail('VAULT_USE_FAILED'); }
    finally { if (Buffer.isBuffer(plaintext)) plaintext.fill(0); }
  }

  return Object.freeze({ enroll, list, issueUseTicket, revokeUseTicket, executeUse });
}

module.exports = { createSecretVault, MAX_SECRET_BYTES, MAX_TICKET_MS };
