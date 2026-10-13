'use strict';

// Host-side metadata for persistent pages, capability runtimes, and extensions.
// A descriptor never grants tool, model, filesystem, or Franklin authority.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'yur.page-runtime-registry.v1';
const ID = /^(product|user)\.[a-z0-9](?:[a-z0-9-]{0,94}[a-z0-9])?$/;
const TOKEN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const KINDS = new Set(['page', 'runtime', 'extension']);
const MODES = new Set(['none', 'on-demand', 'background']);

function fail(message, code = 'PAGE_RUNTIME_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function only(value, keys, label) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid ' + label + '.');
}

function label(value, field, max = 120) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > max
      || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid ' + field + '.');
  return value;
}

function token(value, field) {
  if (typeof value !== 'string' || value.length > 96 || !TOKEN.test(value)) fail('Invalid ' + field + '.');
  return value;
}

function identity(value) {
  if (typeof value !== 'string' || value.length > 101 || !ID.test(value)) fail('Invalid registry id.');
  return value;
}

function owner(value) {
  only(value, ['kind', 'id'], 'owner');
  if (value.kind !== 'product' && value.kind !== 'user') fail('Invalid owner kind.');
  return { kind: value.kind, id: token(value.id, 'owner id') };
}

function actorMatches(record, actor) {
  const claimed = owner(actor);
  if (claimed.kind !== record.owner.kind || claimed.id !== record.owner.id)
    fail('Owner does not match the requested registry change.', 'PAGE_RUNTIME_OWNER');
  // This check is a contract assertion for trusted main-process callers, not authentication.
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Invalid ' + field + '.');
  return value;
}

function normalized(input, createdAt, updatedAt) {
  only(input, ['id', 'kind', 'name', 'owner', 'updatePolicy', 'links', 'lifecycle', 'capabilities', 'authority'], 'descriptor');
  const id = identity(input.id), holder = owner(input.owner);
  if (!id.startsWith(holder.kind + '.')) fail('Registry id does not match its owner namespace.');
  if (!KINDS.has(input.kind)) fail('Invalid registry kind.');
  const expectedPolicy = holder.kind === 'user' ? 'ignore-product-updates' : 'product-managed';
  if (input.updatePolicy !== undefined && input.updatePolicy !== expectedPolicy)
    fail('Update policy does not match owner namespace.');
  const links = input.links === undefined ? {} : input.links;
  only(links, ['runtimeId', 'extensionId'], 'links');
  const runtimeId = links.runtimeId == null ? null : identity(links.runtimeId);
  const extensionId = links.extensionId == null ? null : identity(links.extensionId);
  if (input.kind === 'runtime' && runtimeId !== null) fail('A runtime cannot link to another runtime.');
  if (input.kind === 'extension' && (runtimeId !== null || extensionId !== null)) fail('An extension cannot link to another entry.');
  const lifecycle = input.lifecycle === undefined ? {} : input.lifecycle;
  only(lifecycle, ['mode', 'desired'], 'lifecycle');
  const mode = lifecycle.mode || (input.kind === 'runtime' ? 'on-demand' : 'none');
  const desired = lifecycle.desired || 'stopped';
  if (!MODES.has(mode) || !['stopped', 'available'].includes(desired)
      || (input.kind !== 'runtime' && mode !== 'none') || (mode === 'none' && desired !== 'stopped'))
    fail('Invalid declared lifecycle.');
  const capabilities = input.capabilities === undefined ? [] : input.capabilities;
  if (!Array.isArray(capabilities)) fail('Invalid capabilities.');
  const checkedCapabilities = capabilities.map(value => token(value, 'capability id'));
  if (new Set(checkedCapabilities).size !== checkedCapabilities.length) fail('Duplicate capability id.');
  const authority = input.authority === undefined ? {} : input.authority;
  only(authority, ['reference', 'enforcement'], 'authority reference');
  const reference = authority.reference == null ? null : token(authority.reference, 'authority reference');
  if (authority.enforcement !== undefined && authority.enforcement !== 'descriptor-only')
    fail('A registry descriptor cannot assert authority enforcement.');
  return {
    id, kind: input.kind, name: label(input.name, 'name'), owner: holder,
    updatePolicy: expectedPolicy,
    links: { runtimeId, extensionId },
    lifecycle: { mode, desired },
    capabilities: checkedCapabilities,
    authority: { reference, enforcement: 'descriptor-only' },
    createdAt: timestamp(createdAt, 'creation time'), updatedAt: timestamp(updatedAt, 'update time'),
  };
}

function checkedDocument(value) {
  only(value, ['schema', 'revision', 'entries'], 'registry document');
  if (value.schema !== SCHEMA || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries))
    fail('Unsupported or corrupt registry document.', 'PAGE_RUNTIME_CORRUPT');
  const entries = value.entries.map(item => {
    only(item, ['id', 'kind', 'name', 'owner', 'updatePolicy', 'links', 'lifecycle', 'capabilities', 'authority', 'createdAt', 'updatedAt'], 'stored descriptor');
    const { createdAt, updatedAt, ...spec } = item;
    return normalized(spec, createdAt, updatedAt);
  });
  if (new Set(entries.map(item => item.id.toLowerCase())).size !== entries.length)
    fail('Duplicate registry id.', 'PAGE_RUNTIME_CORRUPT');
  const byId = new Map(entries.map(item => [item.id, item]));
  for (const item of entries) {
    if (item.links.runtimeId && byId.get(item.links.runtimeId)?.kind !== 'runtime')
      fail('Linked runtime is not registered.', 'PAGE_RUNTIME_CORRUPT');
    if (item.links.extensionId) {
      const extension = byId.get(item.links.extensionId);
      if (extension?.kind !== 'extension' || extension.owner.kind !== item.owner.kind
          || extension.owner.id !== item.owner.id)
        fail('Linked extension is not owned by this entry owner.', 'PAGE_RUNTIME_CORRUPT');
    }
  }
  return { schema: SCHEMA, revision: value.revision, entries };
}

function createUserId() { return 'user.' + crypto.randomUUID(); }

function createPageRuntimeRegistry(profileRoot, { clock = () => new Date() } = {}) {
  if (typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot)) fail('An absolute profile root is required.');
  const profile = path.resolve(profileRoot);
  const root = path.join(profile, 'page-runtimes');
  const file = path.join(root, 'registry.json');
  const lock = path.join(root, 'registry.lock');
  const empty = () => ({ schema: SCHEMA, revision: 0, entries: [] });
  const stamp = () => timestamp(clock().toISOString(), 'clock');

  function safeDirectory(directory, create = false) {
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('Registry path must be a real directory.', 'PAGE_RUNTIME_PATH');
    } catch (error) {
      if (!create && error.code === 'ENOENT') return false;
      throw error;
    }
    return true;
  }

  function read() {
    if (!safeDirectory(root)) return empty();
    let info;
    try { info = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    if (!info.isFile() || info.isSymbolicLink()) fail('Registry file must be a regular file.', 'PAGE_RUNTIME_PATH');
    try { return checkedDocument(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (error) {
      if (error.code?.startsWith('PAGE_RUNTIME_')) throw error;
      fail('Registry document is unreadable or corrupt.', 'PAGE_RUNTIME_CORRUPT');
    }
  }

  function write(next) {
    const document = checkedDocument(next);
    const temporary = path.join(root, 'registry.' + crypto.randomUUID() + '.tmp');
    let handle;
    try {
      handle = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify(document, null, 2) + '\n');
      fs.fsyncSync(handle);
      fs.closeSync(handle); handle = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return document;
  }

  function transact(change, expectedRevision) {
    safeDirectory(profile, true); safeDirectory(root, true);
    let handle;
    try { handle = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('Registry is busy; retry after the current writer finishes.', 'PAGE_RUNTIME_BUSY'); throw error; }
    try {
      const current = read();
      if (expectedRevision !== undefined && current.revision !== expectedRevision)
        fail('Registry revision changed; reload before writing.', 'PAGE_RUNTIME_CONFLICT');
      const entries = change(current.entries.map(item => structuredClone(item)));
      return write({ schema: SCHEMA, revision: current.revision + 1, entries });
    } finally {
      fs.closeSync(handle);
      fs.unlinkSync(lock);
    }
  }

  function register(spec, { actor, expectedRevision } = {}) {
    if (!plain(spec)) fail('Invalid descriptor.');
    const now = stamp();
    const entry = normalized({ ...spec, id: spec.id || (actor?.kind === 'user' ? createUserId() : undefined) }, now, now);
    actorMatches(entry, actor);
    return transact(entries => {
      if (entries.some(item => item.id === entry.id)) fail('Registry id already exists.', 'PAGE_RUNTIME_CONFLICT');
      entries.push(entry); entries.sort((a, b) => a.id.localeCompare(b.id));
      return entries;
    }, expectedRevision);
  }

  function updateUser(id, changes, { actor, expectedRevision } = {}) {
    identity(id);
    only(changes, ['name', 'links', 'lifecycle', 'capabilities', 'authority'], 'owned update');
    return transact(entries => {
      const index = entries.findIndex(item => item.id === id);
      if (index < 0) fail('Registry entry does not exist.', 'PAGE_RUNTIME_MISSING');
      const prior = entries[index];
      if (prior.owner.kind !== 'user') fail('Product entries are updated through product reconciliation.', 'PAGE_RUNTIME_OWNER');
      actorMatches(prior, actor);
      const { createdAt, updatedAt, ...base } = prior;
      entries[index] = normalized({ ...base, ...changes,
        links: { ...prior.links, ...changes.links },
        lifecycle: { ...prior.lifecycle, ...changes.lifecycle },
        authority: { ...prior.authority, ...changes.authority },
      }, createdAt, stamp());
      return entries;
    }, expectedRevision);
  }

  // Product updates are additive. Omitted product records and every user record persist.
  function applyProductUpdate(specs, { actor, expectedRevision } = {}) {
    if (!Array.isArray(specs)) fail('Product update must provide descriptors.');
    const now = stamp();
    const incoming = specs.map(spec => normalized(spec, now, now));
    if (new Set(incoming.map(item => item.id)).size !== incoming.length) fail('Duplicate product update id.');
    for (const item of incoming) {
      if (item.owner.kind !== 'product') fail('A product update cannot own a user entry.', 'PAGE_RUNTIME_OWNER');
      actorMatches(item, actor);
    }
    return transact(entries => {
      for (const item of incoming) {
        const index = entries.findIndex(entry => entry.id === item.id);
        if (index < 0) entries.push(item);
        else {
          const prior = entries[index];
          if (prior.owner.kind !== 'product' || prior.owner.id !== item.owner.id)
            fail('Product update cannot change entry ownership.', 'PAGE_RUNTIME_OWNER');
          entries[index] = { ...item, createdAt: prior.createdAt };
        }
      }
      entries.sort((a, b) => a.id.localeCompare(b.id));
      return entries;
    }, expectedRevision);
  }

  function paths(id) {
    identity(id);
    if (!read().entries.some(item => item.id === id)) fail('Registry entry does not exist.', 'PAGE_RUNTIME_MISSING');
    const itemRoot = path.join(root, 'data', id);
    return { root: itemRoot, workspace: path.join(itemRoot, 'workspace'), state: path.join(itemRoot, 'state') };
  }

  function ensureDirectories(id) {
    const resolved = paths(id);
    safeDirectory(profile, true); safeDirectory(root, true);
    for (const directory of [path.join(root, 'data'), resolved.root, resolved.workspace, resolved.state])
      safeDirectory(directory, true);
    return resolved;
  }

  return Object.freeze({ read, register, updateUser, applyProductUpdate, paths, ensureDirectories,
    file, root });
}

module.exports = { SCHEMA, createUserId, createPageRuntimeRegistry };
