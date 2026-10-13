'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { preferences, denial, inspectRepository } = require('../src/desktop-settings');

test('preferences preserve old settings and enforce disabled capabilities in the host', () => {
  assert.equal(preferences({ theme: 'dark' }).browser_enabled, true);
  const settings = { preferences: { browser_enabled: false, browser_context_enabled: false, code_enabled: false, libraries_enabled: false, dictation_enabled: false } };
  for (const [channel, args] of [
    ['browser:action', ['navigate', 'https://example.invalid']], ['browser:select-for-work', [{}]],
    ['work:start', [{ mode: 'code' }]], ['code:run', []], ['voice:arm', []],
    ['voice:transcribe', [{}]], ['factory:request', [{ command: 'hermes_acquire' }]],
    ['factory:request', [{ command: 'copilot_catalog' }]], ['factory:request', [{ command: 'workforce_run' }]],
  ]) assert.ok(denial(channel, args, settings), channel);
  for (const [channel, args] of [['work:start', [{ mode: 'work' }]], ['browser:action', ['setVisible', false]], ['voice:release', []], ['work:cancel', []], ['workspace:save', []]]) assert.equal(denial(channel, args, settings), null, channel);
  assert.ok(denial('browser:action', ['readVisiblePage'], { preferences: { browser_context_enabled: false } }));
});

test('restricted session blocks new dispatch while preserving inspection, cancellation and settings recovery', () => {
  const settings = { preferences: { restricted_session: true } };
  for (const channel of ['generation:start', 'work:start', 'terminal:spawn', 'terminal:input', 'foundry:ask', 'ollama:chat', 'execution-runtime:prepare', 'voice:arm']) assert.ok(denial(channel, [{}], settings), channel);
  assert.ok(denial('factory:request', [{ command: 'automation', enabled: true }], settings));
  assert.ok(denial('schedules:save', [{ enabled: true }], settings));
  assert.equal(denial('factory:request', [{ command: 'automation', enabled: false }], settings), null);
  for (const channel of ['conversations:list', 'workspace:save', 'generation:cancel', 'work:cancel', 'terminal:kill']) assert.equal(denial(channel, [], settings), null, channel);
});

test('repository inspection reads only the selected repository and creates no Git index or source changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yur-settings-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = spawnSync('git', ['-c', 'init.defaultBranch=fixture', 'init', root], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
  assert.equal(result.status, 0, result.stderr);
  const source = path.join(root, 'selected.txt'); await fs.writeFile(source, 'original');
  const shown = await inspectRepository(root);
  assert.match(shown.status, /selected\.txt/); assert.match(shown.worktrees, /worktree /);
  assert.doesNotMatch((await inspectRepository(root, { untracked: false })).status, /selected\.txt/);
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(root, '.git', 'index')), { code: 'ENOENT' });
  for (const invalid of ['relative', path.parse(root).root, source, root + '\n']) await assert.rejects(inspectRepository(invalid));
});

test('new coding, Franklin and media dispatch respect restrictions while stop and inspection stay available', () => {
  const restricted = { preferences: { restricted_session: true } };
  for (const channel of ['franklin:send', 'media:submit', 'rc6:connect', 'rc6:createSession', 'rc6:submit']) {
    assert.ok(denial(channel, [], restricted), channel);
    assert.equal(denial(channel, [], {}), null, channel);
  }
  assert.ok(denial('rc6:approval', ['session', 'request', 'approve'], restricted));
  for (const channel of ['franklin:cancel', 'franklin:snapshot', 'media:cancel', 'media:jobs', 'rc6:interrupt', 'rc6:disconnect', 'rc6:health'])
    assert.equal(denial(channel, [], restricted), null, channel);
  assert.equal(denial('rc6:approval', ['session', 'request', 'deny'], restricted), null);
  assert.ok(denial('rc6:connect', [], { preferences: { code_enabled: false } }));
  assert.ok(denial('rc6:submit', [], { preferences: { code_enabled: false } }));
});
