'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const contract = require('../settings-preferences.json');

function preferences(settings = {}) {
  return { ...Object.fromEntries(Object.entries(contract.fields).map(([key, rule]) => [key, rule.default])), ...settings.preferences };
}

function denial(channel, args, settings) {
  const prefs = preferences(settings);
  if (prefs.restricted_session && channel === 'franklin:unreal' && args[0]?.action === 'unreal_camera') return 'Unreal camera changes are disabled by restricted-session settings.';
  if (prefs.restricted_session && channel === 'franklin:service' && !['services_status', 'music_state', 'music_catalog', 'music_status', 'music_cancel'].includes(args[0]?.action)) return 'Service actions are disabled by restricted-session settings.';
  if (prefs.restricted_session && channel === 'browser:action' && ['click', 'fill', 'select'].includes(args[0])) return 'Browser interaction is disabled by restricted-session settings.';
  if (!prefs.browser_context_enabled && channel === 'browser:action' && ['inspectControls', 'click', 'fill', 'select'].includes(args[0])) return 'Page context is disabled in Computer use settings.';
  const assistantExecution = ['franklin:send', 'media:submit', 'rc6:connect', 'rc6:createSession', 'rc6:submit'].includes(channel)
    || (channel === 'rc6:approval' && args[2] !== 'deny');
  if (prefs.restricted_session && assistantExecution) return 'This action is disabled by restricted-session settings.';
  if (!prefs.code_enabled && (channel.startsWith('rc6:') && assistantExecution)) return 'Code execution is disabled in Computer use settings.';
  if (prefs.restricted_session && (['generation:start', 'work:start', 'code:run', 'terminal:spawn', 'terminal:input', 'foundry:ask', 'foundry:post', 'ollama:chat', 'execution-runtime:prepare'].includes(channel) || (channel === 'browser:action' && ['navigate', 'back', 'forward', 'reload', 'openExternal'].includes(args[0])) || (channel === 'factory:request' && ['submit', 'process', 'run', 'workforce_run', 'automation'].includes(args[0]?.command) && !(args[0]?.command === 'automation' && args[0]?.enabled === false)) || (channel === 'schedules:save' && args[0]?.enabled) || ['lifecycles:deploy', 'lifecycles:run-now', 'marketplace:deploy', 'harness:start', 'ship:create', 'ship:check-now', 'pulse:intake'].includes(channel) || (channel === 'ship:state' && args[2] === 'active') || (channel === 'lifecycles:state' && args[2] === 'active') || (channel === 'harness:request' && String(args[0]).toUpperCase() === 'POST'))) return 'This action is disabled by restricted-session settings.';
  if (!prefs.code_enabled && (channel === 'code:run' || (channel === 'work:start' && args[0]?.mode === 'code'))) return 'Code execution is disabled in Computer use settings.';
  if ((!prefs.dictation_enabled || prefs.restricted_session) && ['voice:arm', 'voice:transcribe'].includes(channel)) return 'Dictation is disabled in Voice settings.';
  if (!prefs.browser_enabled && (channel === 'browser:select-for-work' || (channel === 'browser:action' && !['state', 'stop', 'setBounds'].includes(args[0]) && !(args[0] === 'setVisible' && !args[1])))) return 'The integrated browser is disabled in Browser settings.';
  if (!prefs.browser_context_enabled && (channel === 'browser:select-for-work' || (channel === 'browser:action' && args[0] === 'readVisiblePage'))) return 'Page context is disabled in Computer use settings.';
  if (!prefs.libraries_enabled && channel === 'factory:request' && /^(copilot|hermes|workforce)_(catalog|acquire|run)$/.test(args[0]?.command || '')) return 'Instruction libraries are disabled in Plugins settings.';
  return null;
}

async function inspectRepository(root, { untracked = true, run = spawn } = {}) {
  if (typeof root !== 'string' || root.length > 4096 || !path.isAbsolute(root) || path.parse(root).root === root || /[\0\r\n]/.test(root) || /^\\\\/.test(root)) throw new Error('Choose a local repository folder.');
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a regular local repository folder.');
  const resolved = await fs.realpath(root);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const execute = args => new Promise((resolve, reject) => {
    const child = run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', resolved, ...args], {
      shell: false, windowsHide: true, timeout: 10000,
      env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', error = '', oversized = false;
    const accept = (chunk, target) => { if (Buffer.byteLength(output) + Buffer.byteLength(error) + chunk.length > 65536) { oversized = true; child.kill(); return; } if (target === 'out') output += chunk.toString('utf8'); else error += chunk.toString('utf8'); };
    child.stdout.on('data', chunk => accept(chunk, 'out')); child.stderr.on('data', chunk => accept(chunk, 'err'));
    child.once('error', reject);
    child.once('close', code => { if (oversized) reject(new Error('Repository output exceeds the inspection limit.')); else if (code !== 0) reject(new Error(error.trim() || 'Repository inspection failed.')); else resolve(output.trim()); });
  });
  const status = await execute(['status', '--short', '--branch', untracked ? '--untracked-files=normal' : '--untracked-files=no']);
  const worktrees = await execute(['worktree', 'list', '--porcelain']);
  return { root: resolved, status, worktrees, checked_at: new Date().toISOString() };
}

async function licenses(root) {
  const result = [];
  for (const name of ['electron', 'mermaid', 'monaco-editor', 'node-pty', 'xterm', 'xterm-addon-fit']) {
    const folder = path.join(root, 'node_modules', name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
      let text = '';
      for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT', 'COPYING']) {
        try { const source = path.join(folder, file), metadata = await fs.lstat(source); if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 128 * 1024) { text = await fs.readFile(source, 'utf8'); break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      result.push({ name, version: manifest.version, license: typeof manifest.license === 'string' ? manifest.license : 'See package license', text: text || 'The package declares this license; no standalone license text was found in its installed folder.' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

module.exports = { contract, preferences, denial, inspectRepository, licenses };
