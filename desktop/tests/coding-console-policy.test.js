const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileConsoleCommand } = require('../src/coding-console-policy');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-console-policy-'));
  const selected = path.join(root, 'workspace');
  fs.mkdirSync(selected); fs.mkdirSync(path.join(selected, 'sub folder'));
  fs.writeFileSync(path.join(selected, 'marker.txt'), 'marker');
  fs.writeFileSync(path.join(selected, "quote's.txt"), 'literal quote');
  fs.writeFileSync(path.join(selected, 'sub folder/with spaces.txt'), 'spaces');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('coding-console-policy-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, selected, compile: command => compileConsoleCommand(command, selected) };
}

test('small console language emits only literal bounded PowerShell commands', t => {
  const f = workspace(t), real = fs.realpathSync(f.selected);
  assert.equal(f.compile('pwd').canonical, 'Get-Location');
  assert.equal(f.compile('dir').canonical, `Get-ChildItem -LiteralPath '${real}' -Name`);
  assert.equal(f.compile('dir "sub folder"').canonical, `Get-ChildItem -LiteralPath '${path.join(real, 'sub folder')}' -Name`);
  assert.equal(f.compile('type marker.txt').canonical, `Get-Content -LiteralPath '${path.join(real, 'marker.txt')}' -TotalCount 200`);
  assert.equal(f.compile('type "sub folder/with spaces.txt"').target, path.join(real, 'sub folder', 'with spaces.txt'));
  assert.equal(f.compile("type quote's.txt").canonical, `Get-Content -LiteralPath '${path.join(real, "quote's.txt").replaceAll("'", "''")}' -TotalCount 200`);
});

test('unsupported executable and argument combinations never become shell commands', t => {
  const f = workspace(t);
  for (const command of ['git branch -D any', 'git tag -d any', 'git remote add x y', 'python -c pass -v', 'node -e 1 --version', 'rg --pre anything', 'Get-Content marker.txt', 'type marker.txt -Raw', 'dir -Recurse', 'pwd marker.txt', 'type', 'dir "unterminated', 'dir "sub folder" extra']) assert.throws(() => f.compile(command), undefined, command);
});

test('composition, expansion, globs and control characters are rejected as data', t => {
  const f = workspace(t);
  for (const command of ['pwd; pwd', 'pwd\npwd', 'pwd\r', 'pwd\0', 'dir | anything', 'dir & anything', 'type $env:USERPROFILE', 'type %APPDATA%', 'type `x', 'type *.txt', 'type marker?.txt', 'type [a].txt']) assert.throws(() => f.compile(command), undefined, command);
  for (const command of [null, {}, [], 42, '', ' '.repeat(30), 'type ' + 'a'.repeat(2000)]) assert.throws(() => f.compile(command));
});

test('absolute, traversal, device, alternate stream and ambiguous paths are rejected', t => {
  const f = workspace(t);
  for (const command of ['type ../outside.txt', 'type ..\\outside.txt', 'type C:\\outside.txt', 'type C:outside.txt', 'type \\\\server\\file', 'type /outside', 'type marker.txt:stream', 'type NUL', 'type COM1.txt', 'type marker.txt.', 'type "marker.txt "', 'dir sub//folder', 'type "' + path.join(f.root, 'outside.txt') + '"']) assert.throws(() => f.compile(command), undefined, command);
});

test('secret and private state names are denied before filesystem access', t => {
  const f = workspace(t);
  for (const command of ['type .env', 'type .env.local', 'type .ssh/id_rsa', 'type credentials.json', 'type PRIVATE_KEY.pem', 'type id_ed25519', 'type missions.db', 'dir .yur-runtime', 'dir .keys', 'type state.sqlite3', 'dir .git', 'type .git/config', 'dir .hg', 'type .svn/entries', 'dir secrets', 'type secrets.json', 'type application-secrets.yml', 'type .secrets/token', 'type secret.txt']) assert.throws(() => f.compile(command), /Secret and private state/);
});

test('files and directories have distinct operations and missing paths fail closed', t => {
  const f = workspace(t);
  assert.throws(() => f.compile('type "sub folder"'), /regular workspace file/);
  assert.throws(() => f.compile('dir marker.txt'), /workspace directory/);
  assert.throws(() => f.compile('type absent.txt'), /ENOENT/);
});

test('junction or symlink into another root is rejected', t => {
  const f = workspace(t), link = path.join(f.selected, 'escape');
  fs.symlinkSync(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.compile('dir escape'), /symlink and junction/);
  assert.throws(() => f.compile('type escape/outside.txt'), /symlink and junction/);
});
