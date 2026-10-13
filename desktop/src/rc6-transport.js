const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const binding = require('./glider-rc6-binding.json');
const constructionBinding = require('./construction-v1-binding.json');
const { compileConsoleCommand } = require('./coding-console-policy');
const { normalizeFoundryUrl } = require('./foundry-transport');
const { readVerifiedFile, parseStrictJson } = require('./embedded-runtime');
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
function approvalFingerprint(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return crypto.createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

// The pinned Python gateway emits read_file's float('inf') as bare Infinity
// in capability metadata. Tokenize outside strings; never rewrite quoted text
// or accept non-finite numbers as executable arguments/results elsewhere.
function legacyFrame(line) {
  const stack = [], replacements = [], ids = new Set();
  let offset = 0;
  const nextPath = () => {
    const parent = stack.at(-1);
    return !parent ? [] : [...parent.path, parent.array ? parent.index : parent.key];
  };
  const complete = () => { const parent = stack.at(-1); if (parent?.array) parent.index++; else if (parent) parent.state = 'comma'; };
  const identity = (where, value) => { if (where.length === 1 && where[0] === 'id' && Number.isSafeInteger(value)) ids.add(value); };
  let fault = null;
  try {
    while (offset < line.length) {
      const char = line[offset];
      if (/\s/.test(char)) { offset++; continue; }
      if (char === '"') {
        const start = offset++;
        let escaped = false, closed = false;
        while (offset < line.length) {
          const current = line[offset++];
          if (escaped) { escaped = false; continue; }
          if (current === '\\') { escaped = true; continue; }
          if (current === '"') { closed = true; break; }
        }
        if (!closed) throw new Error('Unterminated string');
        const value = JSON.parse(line.slice(start, offset)), parent = stack.at(-1);
        if (parent && !parent.array && parent.state === 'key') {
          if (parent.keys.has(value)) throw new Error('Duplicate field');
          parent.keys.add(value); parent.key = value; parent.state = 'colon';
        } else { identity(nextPath(), value); complete(); }
        continue;
      }
      if (char === '{' || char === '[') {
        if (stack.length >= 64) throw new Error('Nesting limit');
        stack.push({ path: nextPath(), array: char === '[', index: 0, key: null, state: 'key', keys: new Set() });
        offset++; continue;
      }
      if (char === '}' || char === ']') { stack.pop(); complete(); offset++; continue; }
      if (char === ':') { if (stack.at(-1)) stack.at(-1).state = 'value'; offset++; continue; }
      if (char === ',') { if (stack.at(-1) && !stack.at(-1).array) stack.at(-1).state = 'key'; offset++; continue; }
      const start = offset;
      while (offset < line.length && !/[\s,\[\]{}:"]/.test(line[offset])) offset++;
      if (offset === start) throw new Error('Invalid token');
      const token = line.slice(start, offset), where = nextPath();
      if (['Infinity', '-Infinity', 'NaN'].includes(token)) {
        if (replacements.length >= 128) throw new Error('Non-finite metadata limit');
        replacements.push({ start, end: offset, token, path: where });
      } else { try { identity(where, JSON.parse(token)); } catch { /* Native JSON parsing supplies the final grammar check. */ } }
      complete();
    }
  } catch { fault = 'Malformed RC6 response'; }
  let normalized = '', last = 0;
  for (const item of replacements) { normalized += line.slice(last, item.start) + 'null'; last = item.end; }
  normalized += line.slice(last);
  return { normalized, replacements, id: ids.size === 1 ? [...ids][0] : null, fault };
}

function finiteFrame(value) {
  const nodes = [{ value, depth: 0 }];
  while (nodes.length) {
    const { value: item, depth } = nodes.pop();
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite RC6 response');
    if (item && typeof item === 'object') {
      if (depth >= 64) throw new Error('RC6 response exceeds its nesting limit');
      for (const value of Object.values(item)) nodes.push({ value, depth: depth + 1 });
    }
  }
}

function decodeFrame(line, pending) {
  let message;
  try { message = JSON.parse(line); }
  catch {
    const scanned = legacyFrame(line), fail = () => {
      const error = new Error('Malformed or unsupported non-finite RC6 response');
      error.responseId = scanned.id; throw error;
    };
    if (scanned.fault) fail();
    try { message = JSON.parse(scanned.normalized); } catch { fail(); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) fail();
    if (scanned.replacements.length) {
      if (pending.get(message.id)?.method !== 'capabilities.inventory' || !Array.isArray(message.result?.capabilities)) fail();
      for (const item of scanned.replacements) {
        const p = item.path;
        if (item.token !== 'Infinity' || p.length !== 5 || p[0] !== 'result' || p[1] !== 'capabilities'
            || !Number.isInteger(p[2]) || p[3] !== 'trust' || p[4] !== 'bounded_result_chars') fail();
        const trust = message.result.capabilities[p[2]]?.trust;
        if (!trust || Array.isArray(trust) || trust.bounded_result_chars !== null || Object.hasOwn(trust, 'result_size_unbounded')) fail();
        trust.result_size_unbounded = true;
      }
    } else fail();
  }
  try { finiteFrame(message); }
  catch (error) { error.responseId = message?.id; throw error; }
  return message;
}

function boundedFrames(stream, onLine, onOversized) {
  let parts = [], bytes = 0, discarding = false;
  function append(part) {
    if (discarding || !part.length) return;
    if (bytes + part.length > MAX_FRAME_BYTES) {
      const prefix = Buffer.concat([...parts, part.subarray(0, Math.max(0, MAX_FRAME_BYTES - bytes))]).toString('utf8');
      parts = []; bytes = 0; discarding = true; onOversized(prefix); return;
    }
    parts.push(part); bytes += part.length;
    if (parts.length >= 128) parts = [Buffer.concat(parts, bytes)];
  }
  stream.on('data', chunk => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0, end;
    while ((end = data.indexOf(10, start)) !== -1) {
      append(data.subarray(start, end));
      if (!discarding) onLine(Buffer.concat(parts, bytes).toString('utf8'));
      parts = []; bytes = 0; discarding = false; start = end + 1;
    }
    append(data.subarray(start));
  });
}

function validModel(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('Choose a valid Ollama model identifier under 257 characters.');
  return value;
}

// The renderer supplies only a picker identifier. The host supplies its configured origin.
function rc6Selection(selectedModel, ollamaOrigin) {
  if (typeof selectedModel !== 'string' || selectedModel.length > 256 || !selectedModel.startsWith('ollama:')) throw new Error('Choose an Ollama model in the Desktop model picker before connecting the harness.');
  return { model: validModel(selectedModel.slice(7)), baseUrl: normalizeFoundryUrl(ollamaOrigin, 'Ollama URL') + '/v1' };
}

function providerEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('RC6 provider URL must be an HTTP or HTTPS /v1 endpoint.');
  let url;
  try { url = new URL(value); } catch { throw new Error('RC6 provider URL is not a valid URL.'); }
  if (url.username || url.password || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname)) throw new Error('RC6 provider URL must end in /v1 without credentials, a query, or a fragment.');
  return normalizeFoundryUrl(url.origin, 'RC6 provider URL') + '/v1';
}

function resolveProvider(selection, environment) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['model', 'baseUrl'].includes(key))) throw new Error('Invalid RC6 provider selection.');
  if (selection.model !== undefined) validModel(selection.model);
  if (selection.baseUrl !== undefined) providerEndpoint(selection.baseUrl);
  return {
    model: validModel(environment.YUR_GLIDER_MODEL || selection.model || binding.provider.model),
    baseUrl: providerEndpoint(environment.YUR_GLIDER_PROVIDER_URL || selection.baseUrl || binding.provider.base_url),
    modelSource: environment.YUR_GLIDER_MODEL ? 'environment' : selection.model ? 'selection' : 'binding',
    endpointSource: environment.YUR_GLIDER_PROVIDER_URL ? 'environment' : selection.baseUrl ? 'selection' : 'binding',
    selectedModel: selection.model || null,
  };
}

const NATIVE_MARKER = '.desktop-native-components.json';
const NATIVE_RESOURCES = { intelliflow: '../native/intelliflow', 'construction-v1': '../native/construction-v1' };
const NATIVE_MAX_FILES = 10000, NATIVE_MAX_BYTES = 512 * 1024 * 1024;
const nativeKey = value => value.normalize('NFC').toLowerCase();
const nativeHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exactFields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
function nativeInvalid(reason) { const error = new Error('Packaged IntelliFlow runtime is invalid: ' + reason); error.code = 'NATIVE_GATEWAY_INVALID'; return error; }
function nativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\\x00-\x1f\x7f<>:"|?*]/.test(value)
      || path.posix.isAbsolute(value)) throw nativeInvalid('unsafe payload path.');
  const parts = value.split('/');
  const state = new Set(['.git', '.keys', 'secrets', 'credentials', '__pycache__', '_secrets', '_memory', '_state', '.cache', 'cache', 'caches', 'logs', 'state', 'profiles', 'user-data']);
  if (parts.length > 24 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || state.has(nativeKey(part))
      || part.toLowerCase().startsWith('.env') || part.toLowerCase().includes('.local.'))
      || /\.(?:db|sqlite|sqlite3|log|pyc|keys)$/i.test(value)) throw nativeInvalid('excluded state or unsafe payload path.');
  return value;
}
function nativeInventory(root) {
  const found = new Map(), spellings = new Map(); let nodes = 0;
  const claim = name => {
    const parts = name.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join('/'), key = nativeKey(prefix);
      if (spellings.has(key) && spellings.get(key) !== prefix) throw nativeInvalid('aliased payload spelling.');
      spellings.set(key, prefix);
    }
  };
  const visit = (directory, prefix = '') => {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || nativeKey(fs.realpathSync.native(directory)) !== nativeKey(path.resolve(directory))) throw nativeInvalid('linked or invalid runtime directory.');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++nodes > NATIVE_MAX_FILES * 3) throw nativeInvalid('inventory exceeds its entry bound.');
      const name = nativePath(prefix + entry.name), target = path.join(directory, entry.name); claim(name);
      const item = fs.lstatSync(target);
      if (item.isSymbolicLink()) throw nativeInvalid('linked runtime payload.');
      if (item.isDirectory()) visit(target, name + '/');
      else {
        if (!item.isFile() || item.nlink !== 1) throw nativeInvalid('nonregular or hard-linked runtime payload.');
        if (name === 'runtime.json') continue;
        const key = nativeKey(name);
        if (found.has(key) || found.size >= NATIVE_MAX_FILES) throw nativeInvalid('duplicate or excessive runtime payload.');
        found.set(key, name);
      }
    }
  };
  visit(root); return found;
}
function resolvePackagedGateway(appRoot, component, expectedDigest) {
  appRoot = path.resolve(appRoot);
  const markerPath = path.join(appRoot, NATIVE_MARKER), nativeRoot = path.join(path.dirname(appRoot), 'native');
  if (!fs.existsSync(markerPath)) {
    if (fs.existsSync(nativeRoot)) throw nativeInvalid('native distribution metadata is missing.');
    return null;
  }
  try {
    const markerBytes = readVerifiedFile(markerPath, 8192), marker = parseStrictJson(markerBytes);
    if (!exactFields(marker, 'schema,platform,arch,components') || marker.schema !== 'yur.desktop-native-components.v1'
        || marker.platform !== 'win32' || marker.arch !== 'x64'
        || !exactFields(marker.components, 'intelliflow,construction-v1')) throw nativeInvalid('unsupported distribution metadata.');
    for (const [name, resource] of Object.entries(NATIVE_RESOURCES)) {
      const item = marker.components[name];
      if (!exactFields(item, 'resource,manifest_sha256') || item.resource !== resource
          || typeof item.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.manifest_sha256)) throw nativeInvalid('unsupported fixed resource binding.');
    }
    const selected = marker.components[component], root = path.resolve(appRoot, NATIVE_RESOURCES[component]);
    const manifestPath = path.join(root, 'runtime.json'), manifestBytes = readVerifiedFile(manifestPath, 4 * 1024 * 1024);
    if (nativeHash(manifestBytes) !== selected.manifest_sha256) throw nativeInvalid('runtime manifest digest differs.');
    const manifest = parseStrictJson(manifestBytes);
    if (!exactFields(manifest, 'schema,component,platform,arch,entrypoint,executable_sha256,files,donor')
        || manifest.schema !== 'yur.native-gateway.v1' || manifest.component !== component
        || manifest.platform !== marker.platform || manifest.arch !== marker.arch || manifest.entrypoint !== 'yur-gateway.exe'
        || manifest.executable_sha256 !== expectedDigest || !Array.isArray(manifest.files) || !manifest.files.length
        || manifest.files.length > NATIVE_MAX_FILES || !exactFields(manifest.donor, 'source_identity,manifest_sha256,manifest_bytes')
        || typeof manifest.donor.source_identity !== 'string' || !manifest.donor.source_identity.trim() || manifest.donor.source_identity.length > 500
        || /[\x00-\x1f]/.test(manifest.donor.source_identity) || !/^[a-f0-9]{64}$/.test(manifest.donor.manifest_sha256)
        || !Number.isSafeInteger(manifest.donor.manifest_bytes) || manifest.donor.manifest_bytes <= 0
        || manifest.donor.manifest_bytes > 4 * 1024 * 1024) throw nativeInvalid('unsupported runtime identity or donor record.');
    const listed = new Map(); let total = 0;
    for (const row of manifest.files) {
      if (!exactFields(row, 'path,bytes,sha256') || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > NATIVE_MAX_BYTES
          || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw nativeInvalid('invalid payload declaration.');
      const name = nativePath(row.path), key = nativeKey(name); total += row.bytes;
      if (name === 'runtime.json' || listed.has(key) || total > NATIVE_MAX_BYTES) throw nativeInvalid('duplicate, reserved or excessive payload declaration.');
      listed.set(key, row);
    }
    const gateway = listed.get('yur-gateway.exe'), donor = listed.get('donor-manifest.json');
    if (gateway?.path !== 'yur-gateway.exe' || gateway.sha256 !== expectedDigest || ![...listed.values()].some(row => row.path.startsWith('_internal/'))
        || donor?.path !== 'donor-manifest.json' || donor.sha256 !== manifest.donor.manifest_sha256
        || donor.bytes !== manifest.donor.manifest_bytes) throw nativeInvalid('required gateway/internal payload or donor manifest is absent.');
    return { executable: path.join(root, 'yur-gateway.exe'), verify() {
      if (process.platform !== marker.platform || process.arch !== marker.arch) throw nativeInvalid('the bundled gateway does not match the host.');
      const matches = actual => actual.size === listed.size && [...actual].every(([key, name]) => listed.get(key)?.path === name);
      if (!matches(nativeInventory(root))) throw nativeInvalid('inventory differs from the declared runtime.');
      for (const row of listed.values()) if (nativeHash(readVerifiedFile(path.join(root, ...row.path.split('/')), NATIVE_MAX_BYTES, row.bytes)) !== row.sha256) throw nativeInvalid('payload digest differs.');
      if (!readVerifiedFile(markerPath, 8192).equals(markerBytes) || !readVerifiedFile(manifestPath, 4 * 1024 * 1024).equals(manifestBytes)
          || !matches(nativeInventory(root))) throw nativeInvalid('runtime metadata or inventory changed during verification.');
    } };
  } catch (error) { if (error.code === 'NATIVE_GATEWAY_INVALID') throw error; throw nativeInvalid('runtime resources could not be read safely.'); }
}
function resolveInstalledExecutable(binding, environment = process.env) {
  return resolveInstalledToken(binding?.executable, environment, 'Native harness');
}
function resolveInstalledToken(token, environment = process.env, label = 'Native harness') {
  if (typeof token !== 'string' || !token) throw new Error(label + ' binding is missing its executable token.');
  const prefix = '@local-app-data/';
  if (!token.startsWith(prefix) || token.length <= prefix.length || token.includes('\\') || token.includes('\0')) throw new Error(label + ' binding has an unsupported executable token.');
  const root = environment?.LOCALAPPDATA;
  if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root)) return null;
  const suffix = token.slice(prefix.length).split('/');
  if (suffix.some(part => !part || part === '.' || part === '..')) throw new Error(label + ' binding has an unsafe executable token.');
  return path.join(root, ...suffix);
}
// Installed RC6 is a donor runtime. Its authority and journals stay inside this profile.
function createRc6Transport({ profile, onEvent = () => {}, spawnProcess = spawn, environment = process.env, expectedDigest = binding.sha256, executable = resolveInstalledExecutable(binding, environment),
  constructionExecutable = resolveInstalledExecutable(constructionBinding, environment),
  constructionExpectedDigest = constructionBinding.sha256,
  constructionWorkbenchExecutable = resolveInstalledToken(constructionBinding.workbench_executable, environment, 'Construction V1 workbench'),
  constructionWorkbenchExpectedDigest = constructionBinding.workbench_sha256,
  launchProcess = spawn, appRoot = path.resolve(__dirname, '..') }) {
  const packagedRc6 = resolvePackagedGateway(appRoot, 'intelliflow', expectedDigest);
  const packagedConstruction = resolvePackagedGateway(appRoot, 'construction-v1', constructionExpectedDigest);
  executable = packagedRc6?.executable || executable;
  constructionExecutable = packagedConstruction?.executable || constructionExecutable;
  let child, nextId = 0;
  const pending = new Map(), sessions = new Set(), approvals = new Map(), approvalSnapshots = new Map();
  const runtimes = {
    rc6: { runtimeKey: 'rc6', runtimeName: 'IntelliFlow', runtimeId: 'glider-rc6', authority: 'RC6 bundled authority', scope: 'coding', executable, digest: expectedDigest, prefix: 'rc6', packaged: packagedRc6 },
    'construction-v1': { runtimeKey: 'construction-v1', runtimeName: 'IntelliFlow Construction V1', runtimeId: 'master-orcha', authority: constructionBinding.authority, scope: 'construction-master', executable: constructionExecutable, digest: constructionExpectedDigest, prefix: 'construction-v1/master-orcha', packaged: packagedConstruction },
  };
  let selectedRuntime = runtimes.rc6, home, selectionFile, workspace, provider = null, verifiedDigest = null;
  function workbenchStatus() {
    if (selectedRuntime.runtimeKey !== 'construction-v1') return null;
    let installed = false;
    try { installed = !!constructionWorkbenchExecutable && fs.statSync(constructionWorkbenchExecutable).isFile(); } catch {}
    return { available: installed, executable: constructionWorkbenchExecutable, expectedDigest: constructionWorkbenchExpectedDigest, argument: '--open-master-orcha' };
  }
  function restoreWorkspace() {
    home = path.join(profile, selectedRuntime.prefix, 'home');
    selectionFile = path.join(profile, selectedRuntime.prefix, 'workspace-selection.json');
    workspace = path.join(profile, selectedRuntime.prefix, 'workspace');
    try { const selected = JSON.parse(fs.readFileSync(selectionFile, 'utf8')); if (path.isAbsolute(selected.workspace) && fs.statSync(selected.workspace).isDirectory()) workspace = selected.workspace; } catch {}
  }
  restoreWorkspace();
  function descriptor(runtime) { const { runtimeKey, runtimeName, runtimeId, authority, scope } = runtime; return { runtimeKey, runtimeName, runtimeId, authority, scope }; }
  function status() { return { running: !!child, executable: selectedRuntime.executable, workspace, profile: home, ...provider, ...descriptor(selectedRuntime), expectedDigest: selectedRuntime.digest, verifiedDigest, pendingApprovals: approvals.size, workbench: workbenchStatus() }; }
  function emit(event, runtime = selectedRuntime) {
    try { onEvent({ ...event, runtimeKey: runtime.runtimeKey, runtime_id: runtime.runtimeId }); } catch { /* Presentation errors cannot change gateway execution. */ }
  }
  function settle(error) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); approvals.clear(); approvalSnapshots.clear(); sessions.clear(); }
  async function start(selection) {
    if (child && selection === undefined) return status();
    const requested = resolveProvider(selection === undefined ? {} : selection, environment);
    if (child) {
      if (['model', 'baseUrl', 'selectedModel'].some(key => requested[key] !== provider[key])) throw new Error('Disconnect the harness before changing its model or provider endpoint, then reconnect.');
      return status();
    }
    const runtime = selectedRuntime;
    runtime.packaged?.verify();
    if (!runtime.executable) throw new Error(runtime.runtimeKey === 'rc6' ? 'The installed IntelliFlow runtime is unavailable in this environment.' : 'The installed Construction V1 runtime is unavailable in this environment.');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(runtime.executable)).digest('hex');
    if (hash !== runtime.digest) throw new Error(runtime.runtimeName + ' runtime hash differs from the verified installation. Revalidate the binding before starting.');
    for (const dir of [workspace, home, path.join(home, 'authority')]) fs.mkdirSync(dir, { recursive: true });
    const gatewayEnvironment = { ...environment,
      YUR_HOME: home, YUR_DATA_DIR: path.join(home, 'authority'), YUR_ALLOWED_ROOTS: workspace,
      TERMINAL_CWD: workspace, YUR_WORKSPACE_ROOT: workspace, YUR_RUNTIME_ID: runtime.runtimeId, YUR_AGENT_HOST_ID: runtime.runtimeKey === 'rc6' ? 'glider-rc6' : 'glider-construction-master',
      YUR_MANAGED_SKILL_ROOT: path.join(home, 'managed-skills'), YUR_MANAGED_SCHEDULER_ROOT: path.join(home, 'cron'),
      YUR_MANAGED_MEMORY_ROOT: path.join(home, 'memories'), YUR_MANAGED_KNOWLEDGE_ROOT: path.join(home, 'knowledge-intake'),
      YUR_MANAGED_CAPABILITY_ROOT: path.join(home, 'managed-capabilities'),
      YUR_HARNESS_ROOTS_JSON: '[]', YUR_MCP_CONFIG_PATHS_JSON: '[]', YUR_SKILL_ROOTS_JSON: '[]',
      CUSTOM_BASE_URL: requested.baseUrl, YUR_TUI_PROVIDER: 'custom', YUR_INFERENCE_PROVIDER: 'custom',
      YUR_MODEL: requested.model, YUR_INFERENCE_MODEL: requested.model, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of ['YUR_MISSION_TRANSPORT_ENDPOINT', 'YUR_MISSION_TRANSPORT_TOKEN', 'PYTHONPATH', 'YUR_MCP_PYTHON', 'YUR_VALIDATION_PROJECT_ROOT', 'YUR_CONSTRUCTION_EVIDENCE_ROOT', 'YUR_CONSTRUCTION_VALIDATION_ROOT']) delete gatewayEnvironment[key];
    if (runtime.runtimeKey === 'construction-v1') {
      gatewayEnvironment.YUR_CONSTRUCTION_EVIDENCE_ROOT = path.join(home, 'construction-evidence');
      gatewayEnvironment.YUR_CONSTRUCTION_VALIDATION_ROOT = path.join(home, 'construction-validation');
      const roots = [workspace, ...['YUR_MANAGED_SKILL_ROOT', 'YUR_MANAGED_CAPABILITY_ROOT', 'YUR_MANAGED_SCHEDULER_ROOT', 'YUR_MANAGED_MEMORY_ROOT', 'YUR_MANAGED_KNOWLEDGE_ROOT', 'YUR_CONSTRUCTION_EVIDENCE_ROOT', 'YUR_CONSTRUCTION_VALIDATION_ROOT'].map(key => gatewayEnvironment[key])];
      for (const root of roots) fs.mkdirSync(root, { recursive: true });
      gatewayEnvironment.YUR_ALLOWED_ROOTS = roots.join(';');
    }
    child = spawnProcess(runtime.executable, [], { windowsHide: true, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], env: gatewayEnvironment });
    verifiedDigest = hash;
    provider = requested;
    const active = child;
    function rejectFrame(identity, reason) {
      if (child !== active || !pending.has(identity)) return;
      const item = pending.get(identity); pending.delete(identity); clearTimeout(item.timer); item.reject(new Error(reason));
    }
    boundedFrames(active.stdout, line => {
      if (child !== active) return;
      let msg;
      try { msg = decodeFrame(line, pending); }
      catch (error) { rejectFrame(error.responseId, error.message); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.id != null && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message || 'RC6 request failed')) : p.resolve(msg.result); }
      else if (msg.method === 'event') {
        const e = msg.params || {}, payload = e.payload || {};
        if (payload.kind === 'ApprovalRequest' && payload.request_id) {
          const request = structuredClone({ ...payload, session_id: e.session_id || payload.session_id });
          const fingerprint = approvalFingerprint(request);
          if (approvalSnapshots.has(payload.request_id)) {
            if (approvalSnapshots.get(payload.request_id) !== fingerprint) {
              approvals.delete(payload.request_id);
              emit({ type: 'approval.invalidated', session_id: request.session_id,
                payload: { request_id: payload.request_id, status: 'rejected', message: 'The native approval identity changed scope. The earlier request is invalid.' } }, runtime);
            }
            // Repeated or already-consumed requests never create another dialog
            // and cannot replace the exact scope the human is reviewing.
            return;
          }
          if (approvalSnapshots.size >= 4096) {
            emit({ type: 'approval.invalidated', session_id: request.session_id,
              payload: { request_id: payload.request_id, status: 'rejected', message: 'Native approval retention is full. Finish current work before reconnecting.' } }, runtime);
            return;
          }
          approvalSnapshots.set(payload.request_id, fingerprint); approvals.set(payload.request_id, request);
        }
        emit(e, runtime);
      }
    }, prefix => rejectFrame(legacyFrame(prefix).id, 'RC6 response exceeds its 4 MiB frame budget'));
    active.stderr.on('data', () => {}); // Drain diagnostics without exposing provider secrets.
    active.on('error', error => { if (child !== active) return; child = null; verifiedDigest = null; provider = null; settle(error); emit({ type: 'bridge.error', payload: { message: error.message } }, runtime); });
    active.on('exit', code => { if (child !== active) return; child = null; verifiedDigest = null; provider = null; settle(new Error(runtime.runtimeName + ' exited: ' + code)); emit({ type: 'bridge.stopped', payload: { code } }, runtime); });
    return status();
  }
  function rpc(method, params) {
    if (!child) return Promise.reject(new Error('Connect the selected harness first.'));
    const id = ++nextId;
    const deadline = method.startsWith('capabilities.') ? 120000 : 60000;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('RC6 request timed out: ' + method)); }, deadline); pending.set(id, { resolve, reject, timer, method }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error && pending.has(id)) { pending.delete(id); clearTimeout(timer); reject(error); } }); });
  }
  function own(id) { if (typeof id !== 'string' || !sessions.has(id)) throw new Error('Session does not belong to this candidate.'); }
  function openWorkbench() {
    if (selectedRuntime.runtimeKey !== 'construction-v1') throw new Error('Select IntelliFlow Construction V1 before opening its full workbench.');
    if (child) throw new Error('Disconnect the Construction V1 gateway before opening its separate six-department workbench.');
    const executablePath = constructionWorkbenchExecutable;
    if (!executablePath) throw new Error('The installed Construction V1 workbench is unavailable in this environment.');
    let info;
    try { info = fs.lstatSync(executablePath); } catch { throw new Error('The installed Construction V1 workbench is unavailable in this environment.'); }
    if (!info.isFile()) throw new Error('The installed Construction V1 workbench is not a regular file.');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex');
    if (hash !== constructionWorkbenchExpectedDigest) throw new Error('The installed Construction V1 workbench hash differs from the verified installation. Revalidate the binding before opening it.');
    const args = ['--open-master-orcha'];
    const payload = { executable: executablePath, argument: args[0], sha256: hash, runtime_id: constructionBinding.runtime_id, separate_authority: true };
    emit({ type: 'workbench.launch.requested', payload });
    const launchEnvironment = { ...environment };
    for (const key of ['YUR_HOME', 'YUR_DATA_DIR', 'YUR_ALLOWED_ROOTS', 'YUR_WORKSPACE_ROOT', 'YUR_RUNTIME_ID', 'YUR_AGENT_HOST_ID',
      'YUR_MISSION_TRANSPORT_ENDPOINT', 'YUR_MISSION_TRANSPORT_TOKEN', 'YUR_VALIDATION_PROJECT_ROOT', 'YUR_CONSTRUCTION_EVIDENCE_ROOT',
      'YUR_CONSTRUCTION_VALIDATION_ROOT', 'YUR_MANAGED_SKILL_ROOT', 'YUR_MANAGED_SCHEDULER_ROOT', 'YUR_MANAGED_MEMORY_ROOT',
      'YUR_MANAGED_KNOWLEDGE_ROOT', 'YUR_MANAGED_CAPABILITY_ROOT', 'YUR_HARNESS_ROOTS_JSON', 'YUR_MCP_CONFIG_PATHS_JSON',
      'YUR_SKILL_ROOTS_JSON', 'YUR_GLIDER_RC6', 'YUR_HARNESS_AUTOSTART', 'YUR_DESKTOP_GLIDER_CONFIGURED', 'YUR_DESKTOP_HOME',
      'YUR_FACTORY_HOME', 'YUR_FACTORY_PYTHON', 'YUR_WORKFORCE_SOURCE', 'YUR_WORKFORCE_ROOT', 'YUR_MUSIC_APP_ROOT', 'YUR_UNIFIED_ROOT',
      'CUSTOM_BASE_URL', 'YUR_TUI_PROVIDER', 'YUR_INFERENCE_PROVIDER', 'YUR_MODEL', 'YUR_INFERENCE_MODEL']) delete launchEnvironment[key];
    let processHandle;
    try {
      processHandle = launchProcess(executablePath, args, { detached: true, windowsHide: false, shell: false, stdio: 'ignore', cwd: path.dirname(executablePath), env: launchEnvironment });
    } catch (error) {
      emit({ type: 'workbench.launch.failed', payload: { ...payload, message: String(error.message || error).slice(0, 1000) } });
      throw error;
    }
    processHandle?.once?.('error', error => emit({ type: 'workbench.launch.failed', payload: { ...payload, message: String(error.message || error).slice(0, 1000) } }));
    processHandle?.unref?.();
    const result = { state: 'dispatched', ...payload, pid: Number.isInteger(processHandle?.pid) ? processHandle.pid : null };
    emit({ type: 'workbench.launch.dispatched', payload: result });
    return result;
  }
  return { status, start,
    availableRuntimes() { return Object.values(runtimes).map(runtime => { let installed = false; try { installed = !!runtime.executable && fs.statSync(runtime.executable).isFile(); } catch {} return { ...descriptor(runtime), installed }; }); },
    chooseRuntime(key) { if (child) throw new Error('Disconnect the coding runtime before changing it.'); if (typeof key !== 'string' || !Object.hasOwn(runtimes, key)) throw new Error('Choose IntelliFlow or IntelliFlow Construction V1.'); settle(new Error('Coding runtime changed')); selectedRuntime = runtimes[key]; provider = null; verifiedDigest = null; restoreWorkspace(); return status(); },
    chooseWorkspace(selected) { if (child) throw new Error('Stop the harness before changing workspace.'); if (!path.isAbsolute(selected) || !fs.statSync(selected).isDirectory()) throw new Error('Select an existing workspace folder.'); workspace = fs.realpathSync(selected); fs.mkdirSync(path.dirname(selectionFile), { recursive: true }); fs.writeFileSync(selectionFile, JSON.stringify({ workspace }, null, 2)); return status(); },
    stop() { const active = child; child = null; verifiedDigest = null; provider = null; active?.kill(); settle(new Error('Coding runtime stopped')); if (active) emit({ type: 'bridge.stopped', payload: {} }); },
    openWorkbench,
    async createSession() { const active = child; const result = await rpc('session.create', { cols: 120 }); if (!active || child !== active) throw new Error('Coding connection changed while creating session'); if (typeof result?.session_id !== 'string' || !result.session_id) throw new Error('RC6 did not return a session identifier'); sessions.add(result.session_id); return result; },
    async console(id, command) {
      own(id);
      const compiled = compileConsoleCommand(command, workspace);
      const active = child, runtime = selectedRuntime, requestId = crypto.randomUUID();
      const identity = { requestId, runtimeKey: runtime.runtimeKey, sessionId: id, command, policy: 'read-only' };
      emit({ type: 'console.started', session_id: id, payload: { ...identity, at: new Date().toISOString() } }, runtime);
      try {
        const result = await rpc('shell.exec', { session_id: id, command: compiled.canonical });
        if (!active || child !== active || !sessions.has(id)) throw new Error('Coding session changed during console execution');
        if (!result || typeof result !== 'object' || result.policy !== 'read-only' || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || !Number.isSafeInteger(result.code) || typeof result.reason !== 'string') throw new Error('Gateway returned an unsupported console result.');
        const output = { ...identity, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-2000), code: result.code, reason: result.reason.slice(0, 500) };
        emit({ type: 'console.completed', session_id: id, payload: { ...output, at: new Date().toISOString() } }, runtime);
        return output;
      } catch (error) {
        if (child === active && sessions.has(id)) emit({ type: 'console.failed', session_id: id, payload: { ...identity, message: String(error.message || error).slice(0, 2000), at: new Date().toISOString() } }, runtime);
        throw error;
      }
    },
    inventory() { return rpc('capabilities.inventory', {}); },
    health() { return rpc('capabilities.health', {}); },
    info() { return rpc('harness.info', {}); },
    delegationStatus(id) { own(id); return rpc('delegation.status', { session_id: id }); },
    submit(id, text) { own(id); if (typeof text !== 'string' || !text.trim() || text.length > 64000) throw new Error('Enter a prompt under 64000 characters.'); return rpc('prompt.submit', { session_id: id, text }); },
    interrupt(id) { own(id); return rpc('session.interrupt', { session_id: id }); },
    approval(id, requestId, choice) { own(id); if (!['approve', 'deny'].includes(choice)) throw new Error('Invalid approval choice'); const request = approvals.get(requestId); if (!request || request.session_id !== id) throw new Error('Approval is absent, already answered, or belongs to another session.'); approvals.delete(requestId); return rpc('approval.respond', { session_id: id, choice, request_id: requestId, argument_digest: request.argument_digest, destination_model: request.destination?.model, authority_envelope_id: request.authority_envelope?.envelope_id }); },
    input(id, requestId, kind, value) {
      own(id);
      if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new Error('Input request identity is invalid.');
      if (!['clarify', 'sudo', 'secret'].includes(kind)) throw new Error('Input request type is invalid.');
      if (typeof value !== 'string' || value.length > 64000) throw new Error('Input response is invalid or too large.');
      const field = kind === 'clarify' ? 'answer' : kind === 'sudo' ? 'password' : 'value';
      return rpc(kind + '.respond', { session_id: id, request_id: requestId, [field]: value });
    },
  };
}
module.exports = { createRc6Transport, rc6Selection, resolvePackagedGateway, resolveInstalledExecutable, resolveInstalledToken };
