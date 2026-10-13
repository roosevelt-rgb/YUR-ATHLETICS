'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSecretVault, MAX_TICKET_MS } = require('../src/secret-vault-contract');

const SCOPE = Object.freeze({ runtime: 'coding', provider: 'example',
  action: 'submit', resource: 'job/fixture-1' });
const FAKE_SECRET = 'fake-value-for-vault-contract-tests-only';

function fixture() {
  const key = crypto.randomBytes(32), records = new Map(), calls = [];
  let role = 'admin', approved = true, instant = Date.UTC(2026, 9, 7), adapter;
  const copy = value => ({ ...value, ciphertext: Buffer.from(value.ciphertext) });
  const recordStore = {
    async put(value) { records.set(value.handle, copy(value)); },
    async get(handle) { const value = records.get(handle); return value && copy(value); },
    async list() { return [...records.values()].map(copy); },
  };
  // The test key exists only in this fixture. Production must inject its own
  // OS-backed encryption and key store; the module ships no key or fallback.
  const keyStore = {
    async seal(plaintext, aad) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { keyId: 'test-ephemeral', ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) };
    },
    async unseal(sealed, aad) {
      const value = sealed.ciphertext;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    },
  };
  const vault = createSecretVault({ recordStore, keyStore,
    getPrincipal: () => ({ id: 'local-admin', role }),
    authorizeAdmin: ({ principal, action, scope }) => {
      calls.push({ action, scope });
      return { allowed: approved, role, interactive: true,
        principalId: principal.id, action, scope: { ...scope } };
    },
    useAdapters: { coding: async ({ secret }) => {
      adapter = secret;
      return { leaked: secret.toString('utf8') }; // Must be discarded by the vault.
    } },
    now: () => instant,
  });
  return { vault, records, calls, setRole(value) { role = value; },
    setApproval(value) { approved = value; }, advance(ms) { instant += ms; },
    adapterSecret() { return adapter; } };
}

test('vault cannot be constructed with a default key, store, principal or provider adapter', () => {
  assert.throws(() => createSecretVault(), { code: 'VAULT_INTEGRATION_REQUIRED' });
  assert.throws(() => createSecretVault({ recordStore: {}, keyStore: {} }),
    { code: 'VAULT_INTEGRATION_REQUIRED' });
});

test('enrollment stores ciphertext, clears the supplied buffer and lists metadata only', async () => {
  const f = fixture(), plaintext = Buffer.from(FAKE_SECRET);
  const meta = await f.vault.enroll({ providerId: 'example', plaintext });
  assert.match(meta.handle, /^sv1_[0-9a-f-]+$/);
  assert.deepEqual([...plaintext], Array(plaintext.length).fill(0));
  assert.deepEqual(Object.keys(meta), ['handle', 'providerId', 'createdAt']);
  const stored = f.records.get(meta.handle);
  assert.ok(stored.ciphertext.length > 0);
  assert.equal(stored.ciphertext.includes(Buffer.from(FAKE_SECRET)), false);
  assert.deepEqual(await f.vault.list(), [meta]);
  assert.equal(JSON.stringify(await f.vault.list()).includes(FAKE_SECRET), false);
  assert.deepEqual(f.calls.map(call => call.action), ['secret.create', 'secret.list', 'secret.list']);
});

test('non-admin and missing explicit approval fail before encryption and still clear caller buffers', async () => {
  const f = fixture();
  f.setRole('user');
  const one = Buffer.from(FAKE_SECRET);
  await assert.rejects(f.vault.enroll({ providerId: 'example', plaintext: one }),
    { code: 'VAULT_DENIED' });
  assert.deepEqual([...one], Array(one.length).fill(0));
  assert.equal(f.records.size, 0);
  assert.equal(f.calls.length, 0);
  f.setRole('admin'); f.setApproval(false);
  const two = Buffer.from(FAKE_SECRET);
  await assert.rejects(f.vault.enroll({ providerId: 'example', plaintext: two }),
    { code: 'VAULT_DENIED' });
  assert.deepEqual([...two], Array(two.length).fill(0));
  assert.equal(f.records.size, 0);
});

test('tickets are non-serializable, exact-scope, short-lived and one-use', async () => {
  const f = fixture(), { handle } = await f.vault.enroll({ providerId: 'example',
    plaintext: Buffer.from(FAKE_SECRET) });
  await assert.rejects(f.vault.issueUseTicket({ handle, scope: { ...SCOPE, provider: 'other' },
    ttlMs: 1000 }), { code: 'VAULT_DENIED' });
  await assert.rejects(f.vault.issueUseTicket({ handle, scope: { ...SCOPE, runtime: 'constructor' },
    ttlMs: 1000 }), { code: 'VAULT_INVALID_SCOPE' });
  await assert.rejects(f.vault.issueUseTicket({ handle, scope: SCOPE,
    ttlMs: MAX_TICKET_MS + 1 }), { code: 'VAULT_INVALID_INPUT' });
  const wrong = await f.vault.issueUseTicket({ handle, scope: SCOPE, ttlMs: 1000 });
  assert.equal(JSON.stringify(wrong), '{}');
  await assert.rejects(f.vault.executeUse({ handle, ticket: wrong,
    scope: { ...SCOPE, resource: 'job/fixture-2' } }), { code: 'VAULT_DENIED' });
  await assert.rejects(f.vault.executeUse({ handle, ticket: wrong, scope: SCOPE }),
    { code: 'VAULT_DENIED' });
  const expired = await f.vault.issueUseTicket({ handle, scope: SCOPE, ttlMs: 1000 });
  f.advance(1001);
  await assert.rejects(f.vault.executeUse({ handle, ticket: expired, scope: SCOPE }),
    { code: 'VAULT_DENIED' });
  const rollback = await f.vault.issueUseTicket({ handle, scope: SCOPE, ttlMs: 1000 });
  f.advance(-1);
  await assert.rejects(f.vault.executeUse({ handle, ticket: rollback, scope: SCOPE }),
    { code: 'VAULT_DENIED' });
  f.advance(1);
  const ticket = await f.vault.issueUseTicket({ handle, scope: SCOPE, ttlMs: 1000 });
  const outcome = await f.vault.executeUse({ handle, ticket, scope: SCOPE });
  assert.deepEqual(outcome, { handle, outcome: 'adapter-returned' });
  assert.equal(JSON.stringify(outcome).includes(FAKE_SECRET), false);
  assert.deepEqual([...f.adapterSecret()], Array(FAKE_SECRET.length).fill(0));
  await assert.rejects(f.vault.executeUse({ handle, ticket, scope: SCOPE }),
    { code: 'VAULT_DENIED' });
});

test('ciphertext identity tampering and revoked tickets fail closed', async () => {
  const f = fixture(), { handle } = await f.vault.enroll({ providerId: 'example',
    plaintext: Buffer.from(FAKE_SECRET) });
  const revoked = await f.vault.issueUseTicket({ handle, scope: SCOPE, ttlMs: 1000 });
  f.vault.revokeUseTicket(revoked);
  await assert.rejects(f.vault.executeUse({ handle, ticket: revoked, scope: SCOPE }),
    { code: 'VAULT_DENIED' });
  const ticket = await f.vault.issueUseTicket({ handle, scope: SCOPE, ttlMs: 1000 });
  f.records.get(handle).ciphertext[29] ^= 1;
  await assert.rejects(f.vault.executeUse({ handle, ticket, scope: SCOPE }),
    { code: 'VAULT_USE_FAILED' });
  assert.equal(f.adapterSecret(), undefined);
});
