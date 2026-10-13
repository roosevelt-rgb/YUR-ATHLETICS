'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCHEMA, createPageRuntimeRegistry } = require('../src/page-runtime-registry');

const product = { kind: 'product', id: 'yur-ai-desktop' };
const user = { kind: 'user', id: 'local-owner' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-page-runtime-'));
  const profile = path.join(root, 'profile');
  t.after(() => {
    assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, profile, registry: createPageRuntimeRegistry(profile) };
}

function spec(id, kind, holder, changes = {}) {
  return { id, kind, name: id, owner: holder, ...changes };
}

test('user runtime and page retain separate paths and state after reopening', t => {
  const { profile, registry } = fixture(t);
  assert.deepEqual(registry.read(), { schema: SCHEMA, revision: 0, entries: [] });
  assert.equal(fs.existsSync(profile), false, 'read is nonmutating');
  registry.register(spec('user.runtime-one', 'runtime', user,
    { capabilities: ['code', 'terminal'], authority: { reference: 'franklin.common' } }), { actor: user });
  registry.register(spec('user.page-one', 'page', user,
    { links: { runtimeId: 'user.runtime-one' } }), { actor: user });
  const runtimePaths = registry.ensureDirectories('user.runtime-one');
  const pagePaths = registry.ensureDirectories('user.page-one');
  assert.notEqual(runtimePaths.workspace, pagePaths.workspace);
  assert.notEqual(runtimePaths.state, pagePaths.state);
  assert.ok(fs.statSync(runtimePaths.workspace).isDirectory());
  fs.writeFileSync(path.join(runtimePaths.state, 'fixture.txt'), 'retained');
  const reopened = createPageRuntimeRegistry(profile);
  assert.equal(reopened.read().revision, 2);
  assert.equal(fs.readFileSync(path.join(reopened.paths('user.runtime-one').state, 'fixture.txt'), 'utf8'), 'retained');
  const record = reopened.read().entries.find(item => item.id === 'user.runtime-one');
  assert.equal(record.updatePolicy, 'ignore-product-updates');
  assert.deepEqual(record.authority, { reference: 'franklin.common', enforcement: 'descriptor-only' });
});

test('product reconciliation adds runtimes beyond six while preserving every user entry and omitted product entry', t => {
  const { registry } = fixture(t);
  const native = spec('product.coding', 'runtime', product);
  registry.register(native, { actor: product });
  registry.register(spec('user.addon', 'extension', user), { actor: user });
  registry.register(spec('user.editor', 'page', user,
    { links: { runtimeId: 'product.coding', extensionId: 'user.addon' } }), { actor: user });
  const userState = path.join(registry.ensureDirectories('user.editor').state, 'user-state.txt');
  fs.writeFileSync(userState, 'preserve this user state');
  const before = registry.read();
  const userEntries = before.entries.filter(item => item.owner.kind === 'user');
  const additions = Array.from({ length: 9 }, (_, index) => spec('product.runtime-' + index, 'runtime', product));
  const next = registry.applyProductUpdate(additions, { actor: product, expectedRevision: before.revision });
  assert.equal(next.entries.filter(item => item.kind === 'runtime').length, 10);
  assert.deepEqual(next.entries.filter(item => item.owner.kind === 'user'), userEntries);
  assert.equal(fs.readFileSync(userState, 'utf8'), 'preserve this user state');
  assert.ok(next.entries.some(item => item.id === 'product.coding'), 'omitted product entries persist');
  assert.throws(() => registry.applyProductUpdate([spec('user.editor', 'page', user)], { actor: product }),
    { code: 'PAGE_RUNTIME_OWNER' });
  assert.deepEqual(registry.read().entries.filter(item => item.owner.kind === 'user'), userEntries);
});

test('owner and revision guards reject unintended changes without modifying persisted state', t => {
  const { registry } = fixture(t);
  assert.throws(() => registry.register(spec('user.bad/../path', 'page', user), { actor: user }),
    { code: 'PAGE_RUNTIME_INVALID' });
  assert.throws(() => registry.register(spec('user.page', 'page', user,
    { updatePolicy: 'product-managed' }), { actor: user }), { code: 'PAGE_RUNTIME_INVALID' });
  assert.throws(() => registry.register(spec('user.false-authority', 'page', user,
    { authority: { reference: 'franklin.common', enforcement: 'enforced' } }), { actor: user }),
  { code: 'PAGE_RUNTIME_INVALID' });
  registry.register(spec('user.page', 'page', user), { actor: user });
  const before = registry.read();
  assert.throws(() => registry.updateUser('user.page', { name: 'Changed' }, { actor: product }),
    { code: 'PAGE_RUNTIME_OWNER' });
  assert.throws(() => registry.updateUser('user.page', { name: 'Changed' },
    { actor: user, expectedRevision: before.revision - 1 }), { code: 'PAGE_RUNTIME_CONFLICT' });
  assert.deepEqual(registry.read(), before);
  const changed = registry.updateUser('user.page', { name: 'Changed', lifecycle: { desired: 'stopped' } },
    { actor: user, expectedRevision: before.revision });
  assert.equal(changed.entries[0].name, 'Changed');
  assert.deepEqual(changed.entries[0].links, before.entries[0].links);
  assert.equal(changed.entries[0].createdAt, before.entries[0].createdAt);
});

test('corrupt registry, missing links, and symbolic-link data paths fail closed', t => {
  const { profile, registry, root } = fixture(t);
  registry.register(spec('user.page', 'page', user), { actor: user });
  const good = fs.readFileSync(registry.file, 'utf8');
  fs.writeFileSync(registry.file, '{bad json');
  assert.throws(() => registry.read(), { code: 'PAGE_RUNTIME_CORRUPT' });
  assert.throws(() => registry.register(spec('user.other', 'page', user), { actor: user }),
    { code: 'PAGE_RUNTIME_CORRUPT' });
  fs.writeFileSync(registry.file, good);
  assert.throws(() => registry.register(spec('user.missing-link', 'page', user,
    { links: { runtimeId: 'user.absent' } }), { actor: user }), { code: 'PAGE_RUNTIME_CORRUPT' });
  const data = path.join(profile, 'page-runtimes', 'data');
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, data, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  assert.throws(() => registry.ensureDirectories('user.page'), { code: 'PAGE_RUNTIME_PATH' });
  assert.equal(fs.existsSync(path.join(outside, 'user.page')), false);
});
