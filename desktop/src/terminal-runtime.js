'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHELLS = Object.freeze({
  powershell: { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], systemDirectory: ['System32', 'WindowsPowerShell', 'v1.0'] },
  pwsh: { file: 'pwsh.exe', args: ['-NoLogo'] },
  cmd: { file: 'cmd.exe', args: [], systemDirectory: ['System32'] },
  bash: { file: 'bash.exe', args: ['-l'], systemDirectory: ['System32'] },
  wsl: { file: 'wsl.exe', args: [], systemDirectory: ['System32'] },
});

function fail(code, message) { return Object.assign(new Error(message), { code }); }

function environmentValue(environment, name) {
  const values = Object.keys(environment).filter(key => key.toUpperCase() === name.toUpperCase()).map(key => environment[key]);
  if (values.some(value => typeof value !== 'string') || new Set(values).size > 1) {
    throw fail('TERMINAL_ENVIRONMENT_INVALID', `The Windows ${name} setting is invalid or conflicting.`);
  }
  return values[0] || '';
}

function absoluteDirectory(value) {
  if (!value || /[\u0000-\u001f\u007f"]/.test(value)) return null;
  // A Windows rooted path such as \Tools still depends on the current drive.
  // UNC/device locations are not implicit network searches for local shells.
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value)) return null;
  if (!path.isAbsolute(value)) return null;
  return path.normalize(value);
}

function searchDirectories(value) {
  if (value.length > 32767 || /[\u0000-\u001f\u007f]/.test(value)) throw fail('TERMINAL_ENVIRONMENT_INVALID', 'The Windows PATH setting is invalid.');
  const entries = value.split(';');
  if (entries.length > 512) throw fail('TERMINAL_ENVIRONMENT_INVALID', 'The Windows PATH setting has too many entries.');
  const directories = [];
  for (let entry of entries) {
    entry = entry.trim();
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2) entry = entry.slice(1, -1);
    if (entry.includes('"')) throw fail('TERMINAL_ENVIRONMENT_INVALID', 'The Windows PATH setting contains malformed quotes.');
    const directory = absoluteDirectory(entry);
    // Empty and relative PATH entries must never turn into a cwd lookup.
    if (directory && !directories.some(item => item.toLowerCase() === directory.toLowerCase())) directories.push(directory);
  }
  return directories;
}

function checkedExecutable(directory, filename) {
  const candidate = path.join(directory, filename);
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    const resolved = fs.realpathSync(candidate);
    if (!absoluteDirectory(path.dirname(resolved)) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw fail('TERMINAL_SHELL_UNAVAILABLE', `The selected ${filename} executable could not be inspected.`);
  }
}

function resolveTerminalShell(shellId, environment = process.env) {
  if (typeof shellId !== 'string' || !Object.prototype.hasOwnProperty.call(SHELLS, shellId)) {
    throw fail('TERMINAL_SHELL_INVALID', 'Choose powershell, pwsh, cmd, bash, or wsl.');
  }
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw fail('TERMINAL_ENVIRONMENT_INVALID', 'Terminal environment is invalid.');
  const selected = SHELLS[shellId], directories = searchDirectories(environmentValue(environment, 'PATH'));
  // Preserve PATH precedence, including its last entry. node-pty 1.1.0's
  // Windows native bare-name resolver drops that entry, so pass an absolute
  // executable to both native validation and its existing command-line builder.
  for (const directory of directories) {
    const executable = checkedExecutable(directory, selected.file);
    if (executable) return { executable, args: [...selected.args] };
  }
  if (selected.systemDirectory) {
    const configuredRoot = environmentValue(environment, 'SystemRoot') || environmentValue(environment, 'WINDIR');
    const systemRoot = absoluteDirectory(configuredRoot);
    if (configuredRoot && !systemRoot) throw fail('TERMINAL_ENVIRONMENT_INVALID', 'The Windows system directory must be an absolute local directory.');
    if (systemRoot) {
      const executable = checkedExecutable(path.join(systemRoot, ...selected.systemDirectory), selected.file);
      if (executable) return { executable, args: [...selected.args] };
    }
  }
  throw fail('TERMINAL_SHELL_UNAVAILABLE', `The selected ${selected.file} shell is unavailable. Install it or configure its absolute directory in PATH.`);
}

module.exports = { resolveTerminalShell };
