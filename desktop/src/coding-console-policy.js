'use strict';
const fs = require('node:fs');
const path = require('node:path');

const HELP = 'Use pwd, dir [relative-directory], or type <relative-file>. Quote a relative path containing spaces.';
const forbidden = /[\x00-\x1f\x7f;|&<>`$%*?\[\]]/;
const sensitive = /(?:^\.env(?:\.|$)|^\.(?:keys|ssh|gnupg|kube|aws|azure|git|hg|svn|yur_data|yur-runtime|frozen_spine|ship-loop)$|(?:^|[._-])secrets?(?:[._-]|$)|credentials|git-credentials|anthropic-env-backup|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|(?:secret|private)[_-]?keys?|\.(?:pem|key|pfx|p12|p8|db|sqlite|sqlite3)$)/i;
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function quoted(value) { return "'" + value.replaceAll("'", "''") + "'"; }

// A small command language, not a PowerShell allowlist. The installed gateway
// still enforces its own policy, but cannot broaden this host admission step.
function compileConsoleCommand(command, workspace) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 || forbidden.test(command)) throw new Error(HELP);
  const match = /^(pwd|dir|type)(?: +(?:"([^"]+)"|'([^']+)'|([^\s"]+)))? *$/i.exec(command.trim());
  if (!match) throw new Error(HELP);
  const verb = match[1].toLowerCase(), argument = match[2] ?? match[3] ?? match[4];
  if ((verb === 'pwd' && argument !== undefined) || (verb === 'type' && argument === undefined)) throw new Error(HELP);
  const root = fs.realpathSync(workspace);
  if (!fs.statSync(root).isDirectory()) throw new Error('The selected workspace is unavailable.');
  if (verb === 'pwd') return { command, canonical: 'Get-Location', target: root };
  const relative = argument ?? '.';
  if (relative.includes(':') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.startsWith('\\')) throw new Error('Console paths must be relative to the selected workspace.');
  const segments = relative.split(/[\\/]/);
  if (segments.some(part => !part || part === '..' || (part !== '.' && (part.startsWith('-') || /[. ]$/.test(part)))
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Console traversal, device paths and ambiguous path segments are disabled.');
  if (segments.some(part => sensitive.test(part))) throw new Error('Secret and private state paths are not readable from the console.');
  let target = root;
  for (const segment of segments) {
    if (segment === '.') continue;
    target = path.join(target, segment);
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Console symlink and junction paths are disabled.');
    const resolved = fs.realpathSync(target);
    if (!inside(root, resolved)) throw new Error('Console path escapes the selected workspace.');
    target = resolved;
  }
  if (!inside(root, target)) throw new Error('Console path escapes the selected workspace.');
  if (verb === 'dir' && !fs.statSync(target).isDirectory()) throw new Error('dir requires a workspace directory.');
  if (verb === 'type' && !fs.statSync(target).isFile()) throw new Error('type requires a regular workspace file.');
  return { command, target, canonical: verb === 'dir'
    ? `Get-ChildItem -LiteralPath ${quoted(target)} -Name`
    : `Get-Content -LiteralPath ${quoted(target)} -TotalCount 200` };
}
module.exports = { compileConsoleCommand };
