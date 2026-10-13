'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

// YUR Athletics only (YUR_EDITION=athletics). A bounded stdio client of Gridiron Scout's
// existing MCP server (gridiron-scout/agent_runtime/gridiron_mcp.py). The edition pins the
// command and args it starts; the server entry in the owner's mcp_servers.json must name exactly
// those (or switch the tools off), and that config, the interpreter and its script must belong to
// this Windows user or to Windows itself. The child gets an allowlisted environment. Franklin gets
// two actions: gridiron_tools lists the admitted tools with their schema hashes, and gridiron_call
// {tool, arguments} runs one of them. Reads need no dialog. Writes are local, send nothing, need
// the native confirmation dialog and run one at a time; a schema that changed after that review is
// refused. show_page is answered here and never reaches MCP: it opens one of this edition's pages
// in the side browser. Every other tool the server offers is refused. One child per app run is
// reused across calls (restarts are bounded); an uncertain write and dispose() on before-quit end
// its whole process tree.
const GRIDIRON_EDITION = 'athletics';
// The action names live in edition.js, so franklin-host.js lists them without loading this file.
const GRIDIRON_ACTIONS = require('./edition').EDITION_ACTIONS[GRIDIRON_EDITION];
const READ_TOOLS = Object.freeze(['scout_athlete', 'scout_board', 'scout_program', 'scout_coaches', 'scout_outreach_log',
  'scout_film_notes', 'scout_drafts', 'maxpreps_check', 'scout_season_study', 'scout_card', 'scout_highlights']);
const WRITE_TOOLS = Object.freeze(['maxpreps_sync_now', 'draft_save', 'content_save', 'package_rebuild']);
const PAGE_TOOL = 'show_page';
const GRIDIRON_TOOLS = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS, PAGE_TOOL]);
const EFFECTS = Object.freeze({
  maxpreps_sync_now: 'Pulls the latest MaxPreps stats onto the athlete card in the local Gridiron database; earlier values stay in its history.',
  draft_save: 'Saves a one-to-one outreach draft with status draft for review in Gridiron. Nothing is sent.',
  content_save: 'Saves content for the athlete to review in Gridiron. Nothing is published.',
  package_rebuild: 'Rebuilds the athlete reports, resume, highlight order and card from verified data. Local files only; nothing is sent.',
});
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FRAME = 1024 * 1024, MAX_CONFIG = 64 * 1024, MAX_ARGUMENTS = 32 * 1024, MAX_TEXT = 20000, MAX_RESULT = 80 * 1024;
const MAX_PENDING = 8, MAX_STARTS = 3, MAX_REVIEWS = 4096, MAX_OWNED = 18;
const SCALARS = ['string', 'integer', 'number', 'boolean'];
// Windows variable names are case-insensitive. The child keeps Windows and Python basics and
// Gridiron's Mongo address; model endpoints, tokens and API keys in the desktop's environment never
// reach a process this edition starts (package_rebuild hands its environment to further scripts).
const CHILD_ENVIRONMENT = Object.freeze(['SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROCESSOR_ARCHITECTURE', 'MONGO_URL', 'MONGO_DB']);
// Besides the current user, a Gridiron config, interpreter or script may belong only to Windows
// itself: SYSTEM, Administrators or TrustedInstaller. Another local account's file never starts.
const WINDOWS_OWNERS = Object.freeze(['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v === undefined ? null : v))).digest('hex');
const clean = (v, max) => String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const gridironEnabled = (env = process.env) => env?.YUR_EDITION === GRIDIRON_EDITION;
const coded = (message, code) => Object.assign(new Error(message), { code });
const stopped = () => new Error('Gridiron tools stopped; the next request starts them again.');
function fields(v, required, optional = []) {
  if (!plain(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new Error('Gridiron action requires its exact typed fields.');
}
function boundedJson(value, maximum) {
  let count = 0;
  (function visit(v, depth) {
    if (++count > 100000 || depth > 32) throw new Error('Gridiron data exceeds its complexity budget.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    if (!Array.isArray(v) && !plain(v)) throw new Error('Gridiron data must be finite JSON.');
    for (const [key, child] of Object.entries(v)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe Gridiron field.'); visit(child, depth + 1); }
  })(value, 0);
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > maximum) throw new Error('Gridiron data exceeds Franklin’s context budget; narrow it with limit, brief or a filter.');
  return JSON.parse(raw);
}
function checkIdentity(identity) {
  if (!plain(identity) || !/^[a-f0-9]{32}$/.test(identity.action_id) || !/^[a-f0-9]{32}$/.test(identity.mission_id)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.request_id) || !identity.owner || typeof identity.owner.isDestroyed !== 'function'
      || identity.owner.isDestroyed() || typeof identity.isActive !== 'function' || !identity.isActive()) throw new Error('Gridiron request is no longer active.');
}
function active(identity) { try { checkIdentity(identity); return true; } catch { return false; } }
const matches = (type, v) => type === 'string' ? typeof v === 'string' : type === 'boolean' ? typeof v === 'boolean'
  : type === 'integer' ? Number.isSafeInteger(v) : typeof v === 'number' && Number.isFinite(v);
function childEnvironment(source = process.env) {
  const allowed = new Set(CHILD_ENVIRONMENT.map(name => name.toUpperCase())), environment = {};
  for (const [name, value] of Object.entries(source ?? {})) if (allowed.has(name.toUpperCase()) && typeof value === 'string') environment[name] = value;
  return { ...environment, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}
const systemTool = (...parts) => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
// Windows PowerShell (no profile) reads each owner; the paths travel in the environment, never on
// its command line. Its output is the current user's SID, then one owner SID per path.
const OWNER_SCRIPT = "$ErrorActionPreference='Stop';'me='+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"
  + "foreach($p in ($env:YUR_GRIDIRON_OWNED -split \"`n\")){if($p){$a=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p,'Owner')}"
  + "else{[IO.File]::GetAccessControl($p,'Owner')};$a.GetOwner([Security.Principal.SecurityIdentifier]).Value}}";
function checkOwners(files, { platform = process.platform, spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  const refused = () => new Error('Gridiron tools are not started: their MCP config, interpreter and script must belong to this Windows user or to Windows itself.');
  if (!Array.isArray(files) || !files.length || files.length > MAX_OWNED || files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file))) return Promise.reject(refused());
  if (platform !== 'win32') {
    try { if (files.every(file => [process.getuid?.(), 0].includes(fs.statSync(file).uid))) return Promise.resolve(); } catch { /* Refused below. */ }
    return Promise.reject(refused());
  }
  return new Promise((resolve, reject) => {
    let child = null, output = '', done = false;
    const finish = owned => { if (done) return; done = true; clearTimeout(timer); if (owned) resolve(); else reject(refused()); };
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* Already gone. */ } finish(false); }, timeoutMs);
    try {
      child = spawnProcess(systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', OWNER_SCRIPT],
        { env: { ...childEnvironment(), YUR_GRIDIRON_OWNED: files.join('\n') }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { finish(false); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) { try { child.kill(); } catch { /* Already gone. */ } finish(false); } });
    child.on('error', () => finish(false));
    child.on('close', code => {
      const [me, ...owners] = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const user = /^me=(S-1-5-[0-9-]+)$/.exec(me ?? '')?.[1];
      finish(code === 0 && Boolean(user) && owners.length === files.length && owners.every(sid => sid === user || WINDOWS_OWNERS.includes(sid)));
    });
  });
}

// Only flat, strict object schemas of text, number and boolean fields are admitted; Gridiron's
// scout tools are all of this shape (scout_tools.py registration). Anything else is not called.
function admitSchema(schema) {
  if (!plain(schema) || schema.type !== 'object' || schema.additionalProperties !== false
      || Object.keys(schema).some(k => !['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema'].includes(k))) return null;
  const properties = schema.properties ?? {}, required = schema.required ?? [];
  if (!plain(properties) || Object.keys(properties).length > 32 || !Array.isArray(required) || required.some(k => typeof k !== 'string' || !Object.hasOwn(properties, k))) return null;
  for (const [name, spec] of Object.entries(properties)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !plain(spec) || !SCALARS.includes(spec.type)
        || Object.keys(spec).some(k => !['type', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'title', 'description', 'default'].includes(k))) return null;
    if (['minLength', 'maxLength'].some(k => k in spec && (spec.type !== 'string' || !Number.isSafeInteger(spec[k]) || spec[k] < 0))
        || ['minimum', 'maximum'].some(k => k in spec && (!['integer', 'number'].includes(spec.type) || !Number.isFinite(spec[k])))
        || 'enum' in spec && (!Array.isArray(spec.enum) || !spec.enum.length || spec.enum.length > 64 || spec.enum.some(item => !matches(spec.type, item)))) return null;
  }
  return { properties, required: [...required] };
}
function describeFields({ properties, required }) {
  const optional = Object.keys(properties).filter(k => !required.includes(k));
  return `${required.length ? required.join(', ') + ' (required)' : 'no required fields'}${optional.length ? '; optional ' + optional.join(', ') : ''}`;
}

// Gridiron's MCP config is the owner's file named by the edition. The edition pins the command and
// args; the config must name exactly those, so it can switch the tools off but never choose the process.
function readServer({ config_path: file, server, command: pinnedCommand, args: pinnedArgs }) {
  const failure = (detail = '') => new Error('Gridiron tools are not configured. Check the Gridiron Scout MCP config this edition names.' + detail);
  let parsed;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG) throw new Error();
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw failure(); }
  const entry = plain(parsed) && plain(parsed.mcpServers) && Object.hasOwn(parsed.mcpServers, server) ? parsed.mcpServers[server] : null;
  const command = entry?.command, args = entry?.args ?? [];
  if (!plain(entry) || entry.enabled === false || typeof command !== 'string' || command.length > 1024 || !path.isAbsolute(command)
      || /^[\\/]{2}/.test(command) || /[\x00-\x1f\x7f"<>|?*]/.test(command) || path.normalize(command) !== command || command.split(/[\\/]/).includes('..')
      || !Array.isArray(args) || args.length > 16 || args.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\x00-\x1f\x7f]/.test(arg))) throw failure();
  if (command !== pinnedCommand || args.length !== pinnedArgs.length || args.some((arg, index) => arg !== pinnedArgs[index]))
    throw failure(' It names a different command or arguments than this edition starts.');
  const cwd = path.dirname(file);
  // The config, the interpreter and every script it is given must belong to this user (checkOwners).
  const scripts = args.filter(arg => !arg.startsWith('-')).map(arg => path.resolve(cwd, arg))
    .filter(candidate => { try { return fs.lstatSync(candidate).isFile(); } catch { return false; } });
  return { command, args: [...args], cwd, owned: [...new Set([file, command, ...scripts])] };
}

// package_rebuild runs up to six report scripts; it gets most of a Franklin turn (10 minutes)
// before its outcome counts as uncertain.
function createFranklinGridiron({ edition, deny, getSettings, openPage, spawnProcess = spawn, spawnSyncProcess = spawnSync, platform = process.platform,
  checkOwner = files => checkOwners(files), connectTimeoutMs = 30000, callTimeoutMs = 180000, rebuildTimeoutMs = 540000 } = {}) {
  if (!plain(edition) || !plain(edition.gridiron) || typeof edition.gridiron.origin !== 'string' || !plain(edition.gridiron_mcp)
      || typeof edition.gridiron_mcp.config_path !== 'string' || !path.isAbsolute(edition.gridiron_mcp.config_path) || typeof edition.gridiron_mcp.server !== 'string'
      || typeof edition.gridiron_mcp.command !== 'string' || !path.isAbsolute(edition.gridiron_mcp.command) || !Array.isArray(edition.gridiron_mcp.args)
      || !plain(edition.athlete) || typeof edition.athlete.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(edition.athlete.id) || !Array.isArray(edition.tabs)
      || typeof deny !== 'function' || typeof getSettings !== 'function' || typeof openPage !== 'function' || typeof spawnProcess !== 'function'
      || typeof spawnSyncProcess !== 'function' || typeof checkOwner !== 'function'
      || [connectTimeoutMs, callTimeoutMs, rebuildTimeoutMs].some(ms => !Number.isSafeInteger(ms) || ms < 50 || ms > 600000)) throw new Error('Gridiron requires its edition, host policy checks and page opener.');
  const origin = edition.gridiron.origin;
  let checkedOrigin = null; try { checkedOrigin = new URL(origin); } catch {}
  if (!checkedOrigin || checkedOrigin.protocol !== 'http:' || checkedOrigin.hostname !== '127.0.0.1' || checkedOrigin.origin !== origin) throw new Error('Gridiron pages must use the edition’s loopback origin.');
  // A Gridiron path stays canonical on the edition origin: no protocol-relative, backslash,
  // fragment, whitespace or (encoded) traversal forms.
  function gridironUrl(value) {
    const refused = () => new Error('A Gridiron page path must be a canonical path on ' + origin + ', such as /player/' + edition.athlete.id + '?tab=film.');
    if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//') || /[\\\s\x00-\x1f\x7f#]/.test(value)) throw refused();
    let url; try { url = new URL(value, origin); } catch { throw refused(); }
    if (url.origin !== origin || url.pathname + url.search !== value) throw refused();
    return url.href;
  }
  const pages = edition.tabs.filter(tab => plain(tab) && tab.kind === 'gridiron');
  for (const tab of pages) gridironUrl(tab.path);
  // show_page opens this edition's own pages only: a section's path, or the athlete's card with an
  // optional ?tab=<name>. Gridiron's /api/ routes answer without a login and return whole records,
  // family contacts included, and other athletes' pages are not this edition's; both are refused.
  const sectionPaths = new Set(pages.map(tab => tab.path));
  const athletePage = new RegExp(`^/player/${edition.athlete.id}(?:\\?tab=[a-z0-9]+(?:-[a-z0-9]+)*)?$`);
  function pagePath(value) {
    const url = gridironUrl(value);
    if (/^\/api(?:[/?]|$)/i.test(value) || !sectionPaths.has(value) && !athletePage.test(value))
      throw new Error(`show_page opens this edition's section paths or /player/${edition.athlete.id}?tab=<name>; other Gridiron addresses are not opened.`);
    return url;
  }
  // The page opens in Gridiron's embed view (the manifest's gridiron.embed_param, e.g. embed=1), as the
  // left nav opens it. The canonical path above is what is checked; the parameter only selects the view.
  const embed = typeof edition.gridiron.embed_param === 'string' && /^[a-z][a-z0-9_]{0,31}=[a-z0-9_]{1,32}$/i.test(edition.gridiron.embed_param)
    ? edition.gridiron.embed_param.split('=') : null;
  const embedded = href => { if (!embed) return href; const url = new URL(href); url.searchParams.set(embed[0], embed[1]); return url.href; };
  const pageSchema = { type: 'object', additionalProperties: false, required: ['tab'], properties: {
    tab: { type: 'string', enum: pages.map(tab => tab.id) },
    path: { type: 'string', maxLength: 512, description: `Optional: another section path, or /player/${edition.athlete.id}?tab=<name> such as ?tab=film. Nothing else is opened.` } } };
  let session = null, starting = null, starts = 0, sequence = 0, disposed = false, pinned = null, lane = 'open';
  const prepared = new Map(), dispatched = new Set();
  // One Gridiron write at a time. A write still running, or whose server is still being ended
  // after an uncertain outcome, holds the lane; one that could not be confirmed ended closes it.
  const LANES = { busy: 'Another Gridiron write is still running or being stopped; wait for it before starting another.',
    stuck: 'An earlier Gridiron write could not be confirmed stopped; restart YUR Athletics before another write.' };
  function laneOpen() { if (lane !== 'open') throw new Error(LANES[lane]); }
  const timeoutFor = name => name === 'package_rebuild' ? Math.max(callTimeoutMs, rebuildTimeoutMs) : callTimeoutMs;
  const accepts = action => GRIDIRON_ACTIONS.includes(action);
  const isReadOnly = (action, payload) => action === 'gridiron_tools'
    || action === 'gridiron_call' && plain(payload) && (READ_TOOLS.includes(payload.tool) || payload.tool === PAGE_TOOL);
  function policy(action, payload, identity) {
    checkIdentity(identity);
    const reason = deny('franklin:gridiron', [{ action, payload }], getSettings());
    if (reason) throw new Error(typeof reason === 'string' ? reason : 'Desktop policy does not permit this Gridiron action.');
  }

  // Windows ends only the process it is given, and Gridiron's write tools start their own
  // (maxpreps_sync_now, package_rebuild). taskkill /T ends the child's whole tree; on quit it runs
  // synchronously so nothing it started outlives the app. Resolves whether the tree was ended.
  function endTree(child, { wait = false } = {}) {
    const fallback = () => { try { child?.kill(); } catch { /* Already gone. */ } };
    const running = Boolean(child) && child.exitCode === null && child.signalCode === null && Number.isSafeInteger(child.pid) && child.pid > 0;
    if (!running || platform !== 'win32') { fallback(); return Promise.resolve(true); }
    const tool = systemTool('taskkill.exe'), args = ['/PID', String(child.pid), '/T', '/F'];
    const options = { env: childEnvironment(), shell: false, windowsHide: true, stdio: 'ignore' };
    if (wait) {
      let ended = false;
      try { ended = spawnSyncProcess(tool, args, { ...options, timeout: 5000 }).status === 0; } catch { ended = false; }
      if (!ended) fallback();
      return Promise.resolve(ended);
    }
    return new Promise(resolve => {
      let killer;
      try { killer = spawnProcess(tool, args, options); } catch { fallback(); resolve(false); return; }
      killer.once('error', () => { fallback(); resolve(false); });
      killer.once('close', code => { if (code !== 0) fallback(); resolve(code === 0); });
    });
  }
  function stop(state, error, { wait = false } = {}) {
    if (!state.alive) return state.ended;
    state.alive = false;
    for (const item of state.pending.values()) { item.done(); item.reject(error); }
    state.pending.clear();
    state.ended = endTree(state.child, { wait });
    if (session === state) session = null;
    return state.ended;
  }
  function send(state, message) {
    if (!state.alive) return;
    try { state.child.stdin.write(JSON.stringify(message) + '\n'); } catch { stop(state, stopped()); }
  }
  function receive(state, chunk) {
    if (!state.alive) return;
    state.input += chunk;
    let index;
    while ((index = state.input.indexOf('\n')) >= 0) {
      const line = state.input.slice(0, index).replace(/\r$/, ''); state.input = state.input.slice(index + 1);
      if (line.length > MAX_FRAME) { stop(state, new Error('Gridiron tools sent an oversized reply.')); return; }
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { message = null; }
      if (!plain(message) || message.jsonrpc !== '2.0') { stop(state, new Error('Gridiron tools sent an invalid reply.')); return; }
      if (typeof message.method === 'string') {
        // Server requests get a minimal answer; nothing the server asks for is granted.
        const id = message.id;
        if (typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id)) send(state, message.method === 'ping' ? { jsonrpc: '2.0', id, result: {} }
          : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not available to this client.' } });
        else if (id === undefined && message.method === 'notifications/tools/list_changed') state.stale = true;
        continue;
      }
      const item = state.pending.get(message.id);
      if (!item) continue; // A reply after its timeout or cancellation is dropped.
      state.pending.delete(message.id); item.done();
      if (plain(message.error)) item.reject(coded('Gridiron MCP refused the request: ' + clean(message.error.message, 300), 'GRIDIRON_RPC_ERROR'));
      else if (Object.hasOwn(message, 'result')) item.resolve(message.result);
      else item.reject(new Error('Gridiron tools sent an invalid reply.'));
    }
    if (state.input.length > MAX_FRAME) stop(state, new Error('Gridiron tools sent an oversized reply.'));
  }
  function request(state, method, params, timeoutMs, identity = null) {
    if (!state.alive) return Promise.reject(stopped());
    if (state.pending.size >= MAX_PENDING) return Promise.reject(new Error('Gridiron tools are busy; wait for the current request.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      let timer = null, watch = null;
      const done = () => { clearTimeout(timer); clearInterval(watch); };
      const abandon = error => {
        if (!state.pending.has(id)) return;
        state.pending.delete(id); done();
        send(state, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: error.message.slice(0, 200) } });
        reject(error);
      };
      state.pending.set(id, { resolve, reject, done });
      timer = setTimeout(() => abandon(coded('Gridiron tools did not answer in time.', 'GRIDIRON_TIMEOUT')), timeoutMs);
      if (identity) watch = setInterval(() => { if (!active(identity)) abandon(coded('The Franklin request was cancelled.', 'GRIDIRON_CANCELLED')); }, 100);
      send(state, { jsonrpc: '2.0', id, method, params });
    });
  }
  async function start() {
    if (disposed) throw new Error('Gridiron tools have stopped for this app run.');
    if (starts >= MAX_STARTS) throw new Error('Gridiron tools stopped repeatedly. Check Gridiron Scout, then restart YUR Athletics.');
    const server = readServer(edition.gridiron_mcp);
    await checkOwner(server.owned);
    if (disposed) throw new Error('Gridiron tools have stopped for this app run.');
    starts += 1;
    // Gridiron's own Python (with mcp, pymongo and httpx) runs it with the allowlisted environment;
    // the desktop's Python paths, endpoints and keys are not inherited.
    const state = { child: null, alive: true, pending: new Map(), input: '', tools: null, stale: false, protocol: null, ended: Promise.resolve(true) };
    const failed = () => new Error('Gridiron tools could not start. Check Gridiron Scout’s Python and its MCP config.');
    try { state.child = spawnProcess(server.command, server.args, { cwd: server.cwd, env: childEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw failed(); }
    const { child } = state;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => receive(state, chunk));
    child.stderr.on('data', () => { /* Drained; server logs never reach Franklin. */ });
    child.stdin.on('error', () => {});
    child.on('error', () => stop(state, failed()));
    child.on('close', () => stop(state, stopped()));
    session = state;
    return state;
  }
  async function discover(state, identity) {
    const offered = new Map(), names = new Set();
    let cursor;
    for (let page = 0; page < 4; page++) {
      const result = await request(state, 'tools/list', cursor === undefined ? {} : { cursor }, connectTimeoutMs, identity);
      if (!plain(result) || !Array.isArray(result.tools) || result.tools.length > 256) throw new Error('Gridiron tool catalog is unsupported.');
      for (const tool of result.tools) {
        if (!plain(tool) || typeof tool.name !== 'string' || tool.name.length > 128 || names.has(tool.name)) throw new Error('Gridiron tool catalog contains ambiguous tools.');
        names.add(tool.name);
        const kind = READ_TOOLS.includes(tool.name) ? 'read' : WRITE_TOOLS.includes(tool.name) ? 'write' : null;
        if (!kind) continue; // show_page and every tool outside the allowlist are never called.
        offered.set(tool.name, { name: tool.name, kind, description: clean(tool.description, 600), input_schema: tool.inputSchema,
          schema: admitSchema(tool.inputSchema), schema_sha256: digest(tool.inputSchema) });
      }
      if (result.nextCursor === undefined || result.nextCursor === null) break;
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 512 || result.nextCursor === cursor || page === 3) throw new Error('Gridiron catalog pagination exceeds its bound.');
      cursor = result.nextCursor;
    }
    // The first catalog of this app run is the reviewed one. A later catalog (a restarted child or
    // a list_changed notice) must offer the same schemas; a changed or new tool is refused until restart.
    if (!pinned) pinned = new Map([...offered].map(([name, tool]) => [name, tool.schema_sha256]));
    for (const tool of offered.values()) tool.changed = pinned.get(tool.name) !== tool.schema_sha256;
    if (state.alive) { state.tools = offered; state.stale = false; }
    return offered;
  }
  async function launch() {
    const state = await start();
    try {
      const result = await request(state, 'initialize', { protocolVersion: PROTOCOLS[0], capabilities: {}, clientInfo: { name: 'yur-desktop-gridiron', version: '1' } }, connectTimeoutMs);
      if (!plain(result) || !PROTOCOLS.includes(result.protocolVersion) || !plain(result.capabilities) || !plain(result.capabilities.tools)) throw new Error('Gridiron MCP protocol negotiation failed.');
      state.protocol = result.protocolVersion;
      send(state, { jsonrpc: '2.0', method: 'notifications/initialized' });
      await discover(state, null);
      if (!state.alive) throw stopped();
      return state;
    } catch (error) { stop(state, error); throw error; }
  }
  async function connect(identity) {
    checkIdentity(identity);
    if (!starting && !session?.alive) starting = launch().finally(() => { starting = null; });
    const state = starting ? await starting : session;
    if (state.stale) await discover(state, identity);
    checkIdentity(identity);
    if (!state.alive) throw stopped();
    return state;
  }
  function admitted(state, name) {
    const tool = state.tools?.get(name);
    if (!tool) throw new Error(`The connected Gridiron server does not offer ${name}.`);
    if (tool.changed) throw new Error(`Gridiron ${name} changed its schema after it was reviewed this run; restart YUR Athletics to review it again.`);
    if (!tool.schema) throw new Error(`Gridiron ${name} has a schema this desktop does not admit.`);
    return tool;
  }
  function checkArguments(tool, args) {
    const { properties, required } = tool.schema;
    if (Object.keys(args).some(k => !Object.hasOwn(properties, k)) || required.some(k => !Object.hasOwn(args, k))) throw new Error(`${tool.name} takes ${describeFields(tool.schema)}.`);
    for (const [key, value] of Object.entries(args)) {
      const spec = properties[key], length = typeof value === 'string' ? [...value].length : 0;
      if (!matches(spec.type, value) || typeof value === 'string' && (value.includes('\0') || length > MAX_TEXT || length < (spec.minLength ?? 0) || length > (spec.maxLength ?? MAX_TEXT))
          || typeof value === 'number' && (value < (spec.minimum ?? -Infinity) || value > (spec.maximum ?? Infinity))
          || 'enum' in spec && !spec.enum.includes(value)) throw new Error(`Gridiron ${tool.name}.${key} is outside its schema.`);
    }
    // This edition belongs to one athlete; other athletes' records stay out of Franklin's reach.
    if (Object.hasOwn(args, 'athlete_id') && args.athlete_id !== edition.athlete.id) throw new Error(`This edition works only with its own athlete; use athlete_id "${edition.athlete.id}".`);
  }
  function checkedCall(action, supplied) {
    if (action === 'gridiron_tools') { fields(supplied, []); return { tool: null, args: null }; }
    fields(supplied, ['tool', 'arguments']);
    if (typeof supplied.tool !== 'string' || !GRIDIRON_TOOLS.includes(supplied.tool)) throw new Error('Select an admitted Gridiron tool; gridiron_tools lists them.');
    if (!plain(supplied.arguments) || Buffer.byteLength(JSON.stringify(supplied.arguments)) > MAX_ARGUMENTS) throw new Error('Gridiron tool arguments must be one object of at most 32 KiB.');
    return { tool: supplied.tool, args: boundedJson(supplied.arguments, MAX_ARGUMENTS) };
  }
  function page(args) {
    fields(args, ['tab'], ['path']);
    const tab = typeof args.tab === 'string' ? edition.tabs.find(item => plain(item) && item.id === args.tab) : null;
    if (!tab) throw new Error('Select one of this edition’s Gridiron sections: ' + pages.map(item => item.id).join(', ') + '.');
    if (tab.kind !== 'gridiron') throw new Error(`${tab.label} is a desktop section, not a Gridiron page.`);
    return { tab, url: Object.hasOwn(args, 'path') ? pagePath(args.path) : gridironUrl(tab.path) };
  }
  function result(value) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_RESULT) throw new Error('Gridiron result exceeds Franklin’s context budget; narrow it with limit, brief or a filter.');
    return JSON.parse(raw);
  }
  function toolValue(reply) {
    const item = plain(reply) && Array.isArray(reply.content) && reply.content.length === 1 ? reply.content[0] : null;
    if (!plain(item) || item.type !== 'text' || typeof item.text !== 'string' || item.text.length > 4 * MAX_RESULT) throw new Error('Gridiron tool did not return its expected text result.');
    if (reply.isError === true) throw coded('Gridiron tool error: ' + clean(item.text, 500), 'GRIDIRON_TOOL_ERROR');
    let value;
    try { value = JSON.parse(item.text); } catch { return { text: item.text.slice(0, 60000), format: 'text' }; }
    return { result: boundedJson(value, MAX_RESULT) };
  }
  function listing(state) {
    const available = [...READ_TOOLS, ...WRITE_TOOLS].map(name => state.tools.get(name)).filter(tool => tool?.schema && !tool.changed);
    return result({ origin, athlete_id: edition.athlete.id,
      tools: available.map(tool => ({ name: tool.name, kind: tool.kind, requires_confirmation: tool.kind === 'write', description: tool.description,
        input_schema: boundedJson(tool.input_schema, 16384), schema_sha256: tool.schema_sha256 })),
      local: [{ name: PAGE_TOOL, kind: 'page', requires_confirmation: false, input_schema: pageSchema,
        description: 'Opens one of this edition’s Gridiron sections in the side browser. The desktop handles it; nothing is read or written.' }],
      unavailable: [...READ_TOOLS, ...WRITE_TOOLS].filter(name => !available.some(tool => tool.name === name)),
      notice: 'Call gridiron_call with {tool, arguments}. Reads need no dialog; maxpreps_check also fetches the MaxPreps page stored on the athlete card. '
        + 'Writes are local, send nothing, run one at a time and need the user’s yes in the native dialog.' });
  }
  async function showPage(args, identity) {
    const { tab, url } = page(args);
    const opened = await openPage(embedded(url), identity);
    checkIdentity(identity);
    return result({ tool: PAGE_TOOL, kind: 'page', shown: true, tab: tab.id, label: tab.label, url,
      ...(plain(opened) ? { browser: { url: clean(opened.url, 2048), title: clean(opened.title, 300), loading: opened.loading === true } } : {}),
      notice: 'The page is open in the side browser; use browser_read to read it.' });
  }

  async function validate(action, supplied, identity) {
    if (!accepts(action)) throw new Error('Gridiron action is not connected.');
    policy(action, supplied, identity);
    const call = checkedCall(action, supplied);
    if (call.tool === PAGE_TOOL) page(call.args);
    if (!WRITE_TOOLS.includes(call.tool)) return supplied;
    laneOpen();
    const state = await connect(identity), tool = admitted(state, call.tool);
    checkArguments(tool, call.args);
    policy(action, supplied, identity);
    const stamp = digest({ tool: tool.name, arguments: call.args, schema: tool.schema_sha256, mission: identity.mission_id, request: identity.request_id });
    const prior = prepared.get(identity.action_id);
    if (prior && (prior.stamp !== stamp || prior.owner !== identity.owner)) throw new Error('Gridiron review scope changed; request a new action.');
    if (!prior && prepared.size >= MAX_REVIEWS) throw new Error('Gridiron review capacity reached; restart YUR Athletics.');
    prepared.set(identity.action_id, { stamp, owner: identity.owner, schema_sha256: tool.schema_sha256 });
    return supplied;
  }
  function confirmationRequirements(action, payload) {
    const tool = action === 'gridiron_call' && plain(payload) ? payload.tool : null;
    if (!WRITE_TOOLS.includes(tool)) return { required: false };
    const args = plain(payload.arguments) ? payload.arguments : {};
    return { required: true, service: 'Gridiron Scout on this computer', tool, effect: EFFECTS[tool],
      ...(typeof args.athlete_id === 'string' ? { athlete_id: args.athlete_id } : {}), schema_sha256: pinned?.get(tool) ?? null };
  }
  async function execute(action, supplied, identity, confirmation = {}) {
    if (!accepts(action)) throw new Error('Gridiron action is not connected.');
    policy(action, supplied, identity);
    const call = checkedCall(action, supplied);
    if (action === 'gridiron_tools') return listing(await connect(identity));
    if (call.tool === PAGE_TOOL) return showPage(call.args, identity);
    if (READ_TOOLS.includes(call.tool)) {
      const state = await connect(identity), tool = admitted(state, call.tool);
      checkArguments(tool, call.args); policy(action, supplied, identity);
      const value = toolValue(await request(state, 'tools/call', { name: tool.name, arguments: call.args }, callTimeoutMs, identity));
      checkIdentity(identity);
      return result({ tool: tool.name, kind: 'read', schema_sha256: tool.schema_sha256, ...value });
    }
    // Writes run only after the native dialog, once per reviewed action, with the reviewed schema.
    const prior = prepared.get(identity.action_id);
    if (confirmation.confirmed !== true || !prior || prior.owner !== identity.owner || dispatched.has(identity.action_id)) throw new Error('Gridiron writes require a fresh native human confirmation.');
    if (digest({ tool: call.tool, arguments: call.args, schema: prior.schema_sha256, mission: identity.mission_id, request: identity.request_id }) !== prior.stamp) throw new Error('The approved Gridiron scope changed.');
    laneOpen();
    // Reserve before the first await: a duplicate dispatch cannot pass the same approval, and the
    // lane keeps an approved retry from overlapping a write that is still running.
    dispatched.add(identity.action_id); prepared.delete(identity.action_id); lane = 'busy';
    let held = false;
    try {
      const state = await connect(identity);
      await discover(state, identity);
      const tool = admitted(state, call.tool);
      if (tool.schema_sha256 !== prior.schema_sha256) throw new Error(`Gridiron ${call.tool} changed its schema after review; nothing was written. Request a new review.`);
      checkArguments(tool, call.args); policy(action, supplied, identity);
      let value;
      try { value = toolValue(await request(state, 'tools/call', { name: tool.name, arguments: call.args }, timeoutFor(tool.name), identity)); }
      catch (error) {
        if (error.code === 'GRIDIRON_TOOL_ERROR' || error.code === 'GRIDIRON_RPC_ERROR') throw error;
        // Nothing keeps writing after Franklin reports an uncertain outcome: Gridiron's tool server and
        // every process it started are ended before the lane opens for another write.
        held = true;
        void stop(state, new Error('Gridiron tools were stopped after an uncertain write.')).then(ended => { lane = ended ? 'open' : 'stuck'; });
        throw coded('Gridiron write outcome is uncertain; Gridiron’s tool server and the processes it started were stopped. Inspect Gridiron before repeating it; it is never repeated automatically.', 'GRIDIRON_OUTCOME_UNCERTAIN');
      }
      const receipt = { tool: tool.name, kind: 'write', executed: true, schema_sha256: tool.schema_sha256, notice: EFFECTS[tool.name] };
      try { return result({ ...receipt, ...value }); } catch { return result({ ...receipt, result_omitted: true }); }
    } finally { if (!held) lane = 'open'; }
  }
  function catalog() {
    return [{ id: 'gridiron', actions: [...GRIDIRON_ACTIONS], status: disposed ? 'stopped' : session?.alive && session.tools ? 'connected' : 'configured',
      adapter_bound: true, service_health: 'unchecked', read_tools: [...READ_TOOLS], write_tools: [...WRITE_TOOLS], local_tools: [PAGE_TOOL],
      requires_confirmation: [...WRITE_TOOLS],
      notice: `Gridiron Scout at ${origin} through its local MCP server. Reads need no dialog; maxpreps_check also fetches the MaxPreps page stored on the athlete card. Writes are local, send nothing, run one at a time and need the native confirmation. show_page opens this edition's Gridiron pages in the side browser, never /api/ addresses or other athletes' pages. Email, publishing, web search and Gridiron's own browser tools are not admitted.` }];
  }
  function dispose() {
    disposed = true; prepared.clear();
    if (session) stop(session, new Error('Gridiron tools stopped for this app run.'), { wait: true });
  }
  return { accepts, isReadOnly, validate, confirmationRequirements, execute, catalog, dispose };
}

module.exports = { GRIDIRON_EDITION, GRIDIRON_ACTIONS, READ_TOOLS, WRITE_TOOLS, PAGE_TOOL, GRIDIRON_TOOLS, CHILD_ENVIRONMENT, WINDOWS_OWNERS,
  gridironEnabled, childEnvironment, checkOwners, createFranklinGridiron };
