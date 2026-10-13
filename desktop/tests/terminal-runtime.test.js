'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTerminalShell } = require('../src/terminal-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-terminal-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yur-terminal-runtime-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    shell(directory, name = 'powershell.exe') {
      const folder = path.join(root, directory); fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, name); fs.writeFileSync(file, 'INERT_SHELL_FIXTURE_NEVER_EXECUTED');
      return { folder, file: fs.realpathSync(file) };
    },
  };
}

test('PowerShell in the final PATH entry resolves to an absolute executable without changing PATH', t => {
  const f = fixture(t), shell = f.shell('final PowerShell'), env = { PATH: `${path.join(f.root, 'missing')};${shell.folder}` };
  const original = { ...env };
  assert.deepEqual(resolveTerminalShell('powershell', env), { executable: shell.file, args: ['-NoLogo', '-NoProfile'] });
  assert.deepEqual(env, original);
});

test('the only PATH entry and quoted spaces/Unicode paths resolve case-insensitive environment keys', t => {
  const f = fixture(t);
  for (const name of ['Portable café 測試 shell', 'Another path with spaces']) {
    const shell = f.shell(name, 'pwsh.exe');
    assert.equal(resolveTerminalShell('pwsh', { pAtH: ` "${shell.folder}" ` }).executable, shell.file);
  }
});

test('PATH precedence stays stable and all admitted shells retain fixed arguments', t => {
  const f = fixture(t), first = f.shell('first'), last = f.shell('last');
  assert.equal(resolveTerminalShell('powershell', { Path: `${first.folder};${last.folder}` }).executable, first.file);
  for (const [id, name, args] of [['powershell','powershell.exe',['-NoLogo','-NoProfile']],['pwsh','pwsh.exe',['-NoLogo']],['cmd','cmd.exe',[]],['bash','bash.exe',['-l']],['wsl','wsl.exe',[]]]) {
    const shell = f.shell(id, name);
    assert.deepEqual(resolveTerminalShell(id, { PATH: shell.folder }), { executable: shell.file, args });
  }
});

test('SystemRoot and WINDIR supply verified built-in locations when PATH is absent', t => {
  const f = fixture(t), shell = f.shell(path.join('Windows fixture', 'System32', 'WindowsPowerShell', 'v1.0'));
  for (const key of ['sYsTeMrOoT', 'windir']) assert.equal(resolveTerminalShell('powershell', { [key]: path.join(f.root, 'Windows fixture') }).executable, shell.file);
  const cmd = f.shell(path.join('Windows fixture', 'System32'), 'cmd.exe');
  assert.equal(resolveTerminalShell('cmd', { SystemRoot: path.join(f.root, 'Windows fixture') }).executable, cmd.file);
  assert.throws(() => resolveTerminalShell('pwsh', { SystemRoot: path.join(f.root, 'Windows fixture') }), { code: 'TERMINAL_SHELL_UNAVAILABLE' });
});

test('empty, relative, drive-relative and cwd entries are never shell search directories', t => {
  const f = fixture(t), shell = f.shell('real shell');
  assert.equal(resolveTerminalShell('powershell', { PATH: `;.;..;relative;C:relative;"";${shell.folder};` }).executable, shell.file);
  assert.throws(() => resolveTerminalShell('powershell', { PATH: ';.;..;relative;C:relative;"";' }), { code: 'TERMINAL_SHELL_UNAVAILABLE' });
});

test('a missing shell, directory named executable, or invalid system root gives an explicit error', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'powershell.exe'));
  assert.throws(() => resolveTerminalShell('powershell', { PATH: f.root }), { code: 'TERMINAL_SHELL_UNAVAILABLE' });
  assert.throws(() => resolveTerminalShell('powershell', { SystemRoot: 'relative' }), { code: 'TERMINAL_ENVIRONMENT_INVALID' });
  assert.throws(() => resolveTerminalShell('powershell', {}), /powershell\.exe shell is unavailable/);
});

test('command strings, alternate paths, prototype keys and malformed environment cannot expand shell selection', () => {
  for (const id of [null, '', 'PowerShell', 'powershell.exe', 'powershell -Command anything', 'cmd&anything', '../pwsh', '__proto__', 'constructor']) {
    assert.throws(() => resolveTerminalShell(id, {}), { code: 'TERMINAL_SHELL_INVALID' });
  }
  for (const env of [null, [], { PATH: 1 }, { PATH: 'one', Path: 'two' }, { PATH: '"unterminated' }, { PATH: 'one\u0000two' }, { PATH: 'x'.repeat(32768) }, { PATH: ';'.repeat(512) }]) {
    assert.throws(() => resolveTerminalShell('powershell', env), { code: 'TERMINAL_ENVIRONMENT_INVALID' });
  }
});

test('resolution is fresh and callers cannot mutate the fixed shell arguments', t => {
  const f = fixture(t), shell = f.shell('installed');
  const resolved = resolveTerminalShell('powershell', { PATH: shell.folder }); resolved.args.push('-Command');
  assert.deepEqual(resolveTerminalShell('powershell', { PATH: shell.folder }).args, ['-NoLogo', '-NoProfile']);
  fs.unlinkSync(shell.file);
  assert.throws(() => resolveTerminalShell('powershell', { PATH: shell.folder }), { code: 'TERMINAL_SHELL_UNAVAILABLE' });
});
