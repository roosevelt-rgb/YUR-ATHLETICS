'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

// A bounded client of Epic's existing ModelContextProtocol/ToolsetRegistry owner.
// No editor launch, script evaluation, asset persistence or orchestration here.
const UNREAL_ACTIONS = Object.freeze(['unreal_status', 'unreal_inspect', 'unreal_capture', 'unreal_camera']);
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2024-11-05'];
const MAX_RESPONSE = 8 * 1024 * 1024;
const APP = 'EditorToolset.EditorAppToolset';
const SCENE = 'editor_toolset.toolsets.scene.SceneTools';
const TOOLS = Object.freeze({ level: SCENE + '.get_current_level', selection: APP + '.GetSelectedActors',
  camera: APP + '.GetCameraTransform', assets: APP + '.GetSelectedAssets', capture: APP + '.CaptureViewport', move: APP + '.SetCameraTransform' });
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const digest = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
function fields(v, required, optional = []) {
  if (!plain(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new Error('Unreal action requires its exact typed fields.');
}
function boundedJson(value, maximum = 16384) {
  let count = 0;
  function visit(v, depth) {
    if (++count > 100000 || depth > 24) throw new Error('Unreal data exceeds its complexity budget.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    if (!Array.isArray(v) && !plain(v)) throw new Error('Unreal data must be finite JSON.');
    for (const [key, child] of Object.entries(v)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe Unreal field.'); visit(child, depth + 1); }
  }
  visit(value, 0); const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > maximum) throw new Error('Unreal data exceeds its byte budget.');
  return JSON.parse(raw);
}
function checkIdentity(identity) {
  if (!plain(identity) || !/^[a-f0-9]{32}$/.test(identity.action_id) || !/^[a-f0-9]{32}$/.test(identity.mission_id)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.request_id) || !identity.owner || typeof identity.owner.isDestroyed !== 'function'
      || identity.owner.isDestroyed() || typeof identity.isActive !== 'function' || !identity.isActive()) throw new Error('Unreal request is no longer active.');
}
function numberObject(v, keys, max) {
  fields(v, keys); for (const key of keys) if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || Math.abs(v[key]) > max) throw new Error('Unreal camera coordinate exceeds its declared bounds.');
}
function configuration(v) {
  if (!plain(v) || typeof v.project_file !== 'string' || !path.isAbsolute(v.project_file) || !/\.uproject$/i.test(v.project_file)
      || /^[\\/]{2}/.test(v.project_file) || /[\x00-\x1f\x7f]/.test(v.project_file) || v.project_file.length > 2048 || typeof v.endpoint !== 'string') throw new Error('Select an existing Unreal project and its local MCP connection.');
  let url; try { url = new URL(v.endpoint); } catch { throw new Error('Unreal MCP requires a loopback connection.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || !url.port || Number(url.port) > 65535
      || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9/_-]{1,128}$/.test(url.pathname)) throw new Error('Unreal MCP requires a loopback connection without credentials or redirects.');
  // Numeric loopback avoids name resolution; localhost is Epic's default bind name.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return { project_file: path.resolve(v.project_file), endpoint: url.href };
}
function samePath(a, b) { return typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

function readUnrealProjectConfiguration(projectFile) {
  if (typeof projectFile !== 'string' || !path.isAbsolute(projectFile) || /^[\\/]{2}/.test(projectFile)) throw new Error('Select an existing local .uproject file.');
  const project = path.resolve(projectFile), root = path.dirname(project);
  function read(file, optional = false) {
    try {
      const stat = fs.lstatSync(file), resolved = fs.realpathSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || !samePath(resolved, file)) throw new Error('Unreal configuration must be a bounded ordinary local file.');
      return fs.readFileSync(file, 'utf8');
    } catch (error) { if (optional && error.code === 'ENOENT') return ''; throw error; }
  }
  if (!/\.uproject$/i.test(project)) throw new Error('Select an existing .uproject file.');
  const source = JSON.parse(read(project));
  if (!Array.isArray(source.Plugins) || !source.Plugins.some(p => p.Name === 'ModelContextProtocol' && p.Enabled === true)) throw new Error('The selected project has not enabled its existing MCP plugin.');
  let port = 8000, route = '/mcp'; // Installed Epic plugin defaults, overridden by this project's settings.
  for (const relative of ['Config/DefaultEditorPerProjectUserSettings.ini', 'Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini']) {
    let section = '';
    for (const line of read(path.join(root, relative), true).split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line); if (header) { section = header[1]; continue; }
      if (section !== '/Script/ModelContextProtocolEngine.ModelContextProtocolSettings') continue;
      const setting = /^\s*(ServerPortNumber|ServerUrlPath)\s*=\s*([^;\r\n]+)\s*$/.exec(line); if (!setting) continue;
      const value = setting[2].trim().replace(/^"(.*)"$/, '$1');
      if (setting[1] === 'ServerPortNumber') { if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) throw new Error('Invalid Unreal MCP port setting.'); port = Number(value); } else route = value;
    }
  }
  return configuration({ project_file: project, endpoint: `http://127.0.0.1:${port}${route}` });
}

// Only this fixed host script reads process/listener metadata. No supplied text
// becomes PowerShell source, no process is started/stopped, and raw command lines
// never leave the helper. Connection identity includes process creation time.
const BINDING_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$selected=[IO.Path]::GetFullPath($env:YUR_UNREAL_SELECTED_PROJECT)
$port=[int]$env:YUR_UNREAL_SELECTED_PORT
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
if (!$listeners.Count -or @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count) { throw 'unbound' }
$owners=@($listeners.OwningProcess | Select-Object -Unique)
if ($owners.Count -ne 1) { throw 'ambiguous' }
$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owners[0])
if (!$process -or [IO.Path]::GetFileName($process.ExecutablePath) -ne 'UnrealEditor.exe') { throw 'not-editor' }
$matches=[regex]::Matches($process.CommandLine,'"([^"\r\n]*\.uproject)"|(?<!\S)([^"\s]+\.uproject)(?=\s|$)','IgnoreCase')
if ($matches.Count -ne 1) { throw 'project-unknown' }
$matched=if($matches[0].Groups[1].Success){$matches[0].Groups[1].Value}else{$matches[0].Groups[2].Value}
if (![IO.Path]::IsPathRooted($matched) -or [IO.Path]::GetFullPath($matched) -ine $selected) { throw 'project-mismatch' }
$created=([DateTime]$process.CreationDate).ToUniversalTime().ToString('o')
@{project_file=$selected;process_id=[int]$process.ProcessId;connection_id=([string]$process.ProcessId+':'+$created)} | ConvertTo-Json -Compress
`;
function verifyUnrealProjectBinding(config) {
  const checked = configuration(config);
  if (process.platform !== 'win32') return Promise.reject(new Error('Native Unreal project binding is unavailable on this host.'));
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', BINDING_SCRIPT], {
    windowsHide: true, timeout: 10000, maxBuffer: 65536, env: { ...process.env, YUR_UNREAL_SELECTED_PROJECT: checked.project_file, YUR_UNREAL_SELECTED_PORT: new URL(checked.endpoint).port },
  }, (error, stdout) => { if (error) reject(new Error('The selected Unreal project has no verified local MCP listener.')); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Unreal listener identity was not verified.')); } } }));
}

const PORT_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$selected=[IO.Path]::GetFullPath($env:YUR_UNREAL_SELECTED_PROJECT)
$selectedProcesses=@()
foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'")) {
  $projectMatches=[regex]::Matches($process.CommandLine,'"([^"\r\n]*\.uproject)"|(?<!\S)([^"\s]+\.uproject)(?=\s|$)','IgnoreCase')
  if ($projectMatches.Count -ne 1) { continue }
  $matched=if($projectMatches[0].Groups[1].Success){$projectMatches[0].Groups[1].Value}else{$projectMatches[0].Groups[2].Value}
  if ([IO.Path]::IsPathRooted($matched) -and [IO.Path]::GetFullPath($matched) -ieq $selected) { $selectedProcesses += $process }
}
if ($selectedProcesses.Count -gt 1) { throw 'ambiguous-selected-project' }
$port=$null
if ($selectedProcesses.Count -eq 1) {
  $flags=[regex]::Matches($selectedProcesses[0].CommandLine,'(?:^|\s)-ModelContextProtocolPort=([0-9]+)(?=\s|$)','IgnoreCase')
  if ($flags.Count -gt 1) { throw 'ambiguous-port' }
  if ($flags.Count -eq 1) { $port=[int]$flags[0].Groups[1].Value; if($port -lt 1 -or $port -gt 65535){throw 'invalid-port'} }
}
@{port=$port} | ConvertTo-Json -Compress
`;
function inspectRuntimePort(projectFile) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PORT_SCRIPT], {
    windowsHide: true, timeout: 10000, maxBuffer: 65536, env: { ...process.env, YUR_UNREAL_SELECTED_PROJECT: projectFile },
  }, (error, stdout) => { if (error) reject(new Error('Unreal project runtime connection could not be resolved.')); else { try { resolve(JSON.parse(stdout).port); } catch { reject(new Error('Unreal project runtime metadata is unavailable.')); } } }));
}
async function resolveUnrealProjectConfiguration(projectFile, { readRuntimePort = inspectRuntimePort } = {}) {
  const config = readUnrealProjectConfiguration(projectFile), port = await readRuntimePort(config.project_file);
  if (port === null) return config;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('The selected Unreal process reported an invalid MCP port.');
  const url = new URL(config.endpoint); url.port = String(port);
  return configuration({ ...config, endpoint: url.href });
}

function inputSchemaMatches(key, schema) {
  if (!plain(schema) || schema.type !== 'object' || schema.$ref || schema.anyOf || schema.oneOf || !Array.isArray(schema.required ?? [])) return false;
  const props = schema.properties ?? {}, required = schema.required ?? [];
  if (!plain(props)) return false;
  if (key === 'capture') return required.length === 0 && Object.keys(props).every(k => ['captureTransform', 'annotations', 'bShowUI'].includes(k));
  if (key !== 'move') return required.length === 0 && Object.keys(props).length === 0;
  const transform = props.transform;
  if (Object.keys(props).join() !== 'transform' || required.join() !== 'transform' || transform?.type !== 'object') return false;
  const shape = transform.properties;
  if (!plain(shape) || !shape.location || !shape.rotation || Object.keys(shape).some(k => !['location', 'rotation', 'scale'].includes(k))) return false;
  for (const [name, keys] of [['location', ['x', 'y', 'z']], ['rotation', ['pitch', 'yaw', 'roll']]]) {
    const value = shape[name]; if (value?.type !== 'object' || !plain(value.properties) || Object.keys(value.properties).sort().join() !== keys.sort().join()
        || keys.some(k => value.properties[k]?.type !== 'number')) return false;
  }
  return (transform.required ?? []).every(k => ['location', 'rotation'].includes(k));
}
function toolValue(result) {
  if (!plain(result) || result.isError === true || !Array.isArray(result.content) || result.content.length !== 1
      || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') throw new Error('Unreal tool did not return its expected typed result.');
  let value; try { value = boundedJson(JSON.parse(result.content[0].text), MAX_RESPONSE); } catch { throw new Error('Unreal tool returned unsupported data.'); }
  return value;
}
function createFranklinUnreal({ getConfiguration = () => null, verifyProjectBinding = verifyUnrealProjectBinding,
  deny, getSettings, onCapture, timeoutMs = 15000 } = {}) {
  if (typeof getConfiguration !== 'function' || typeof verifyProjectBinding !== 'function' || typeof deny !== 'function' || typeof getSettings !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('Unreal requires host configuration and policy checks.');
  let session = null, sequence = 0;
  const prepared = new Map(), dispatched = new Set();
  const accepts = action => UNREAL_ACTIONS.includes(action);
  const isReadOnly = action => accepts(action) && action !== 'unreal_camera';
  function policy(action, payload, identity) { checkIdentity(identity); if (deny('franklin:unreal', [{ action, payload }], getSettings())) throw new Error('Desktop policy does not permit this Unreal action.'); }
  function current() { const value = getConfiguration(); return value ? configuration(value) : null; }
  async function binding(config, identity, expected) {
    checkIdentity(identity); const result = await verifyProjectBinding(config); checkIdentity(identity);
    if (!plain(result) || !samePath(result.project_file, config.project_file) || !Number.isSafeInteger(result.process_id) || result.process_id < 1
        || typeof result.connection_id !== 'string' || result.connection_id.length < 3 || result.connection_id.length > 256
        || /[\x00-\x1f\x7f]/.test(result.connection_id) || expected && result.connection_id !== expected.connection_id) throw new Error('Unreal project or process changed; request a fresh review.');
    return { project_file: config.project_file, process_id: result.process_id, connection_id: result.connection_id };
  }
  function exchange(config, body, identity, headers = {}, notification = false) {
    checkIdentity(identity); const raw = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let done = false, incoming, timer, cancellation;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); clearInterval(cancellation); if (error) { incoming?.destroy(); request.destroy(); reject(error); } else resolve(value); };
      const fail = () => finish(new Error('Unreal MCP request failed or was cancelled. Inspect engine state before repeating an operation.'));
      const request = http.request(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(raw), ...headers } }, response => {
        incoming = response;
        if (notification && response.statusCode === 202) { response.resume(); finish(null, { result: null, headers: response.headers }); return; }
        if (response.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')
            || response.headers['content-length'] && (!/^\d+$/.test(response.headers['content-length']) || Number(response.headers['content-length']) > MAX_RESPONSE)) { fail(); return; }
        let size = 0; const chunks = [];
        response.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) fail(); else chunks.push(chunk); });
        response.on('error', fail); response.on('aborted', fail);
        response.on('end', () => { if (done) return; try {
          checkIdentity(identity); const value = boundedJson(JSON.parse(Buffer.concat(chunks).toString('utf8')), MAX_RESPONSE);
          if (value.jsonrpc !== '2.0' || value.id !== body.id || value.error || !Object.hasOwn(value, 'result')) throw new Error();
          finish(null, { result: value.result, headers: response.headers });
        } catch { fail(); } });
      });
      request.on('error', fail); timer = setTimeout(fail, timeoutMs); cancellation = setInterval(() => { try { checkIdentity(identity); } catch { fail(); } }, 100);
      request.end(raw);
    });
  }
  async function rpc(connection, method, params, identity) {
    return (await exchange(connection.config, { jsonrpc: '2.0', id: ++sequence, method, params }, identity,
      { 'Mcp-Session-Id': connection.sessionId, 'Mcp-Protocol-Version': connection.protocol })).result;
  }
  async function discover(connection, identity) {
    const catalog = [], names = new Set(); let cursor;
    for (let page = 0; page < 8; page++) {
      const result = await rpc(connection, 'tools/list', cursor ? { cursor } : {}, identity);
      if (!plain(result) || !Array.isArray(result.tools) || result.tools.length > 1000) throw new Error('Unreal tool catalog is unsupported.');
      for (const tool of result.tools) { if (!plain(tool) || typeof tool.name !== 'string' || names.has(tool.name)) throw new Error('Unreal tool catalog contains ambiguous identities.'); names.add(tool.name); catalog.push(tool); }
      if (result.nextCursor === undefined) break;
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 512 || result.nextCursor === cursor || page === 7) throw new Error('Unreal catalog pagination exceeds its bound.'); cursor = result.nextCursor;
    }
    const search = names.has('describe_toolset') && names.has('call_tool');
    if (search) {
      const describeSchema = catalog.find(t => t.name === 'describe_toolset').inputSchema;
      const dispatchSchema = catalog.find(t => t.name === 'call_tool').inputSchema;
      if (describeSchema?.type !== 'object' || Object.keys(describeSchema.properties ?? {}).join() !== 'toolset_name'
          || describeSchema.properties.toolset_name?.type !== 'string' || (describeSchema.required ?? []).join() !== 'toolset_name'
          || dispatchSchema?.type !== 'object' || Object.keys(dispatchSchema.properties ?? {}).sort().join() !== 'arguments,tool_name,toolset_name'
          || dispatchSchema.properties.toolset_name?.type !== 'string' || dispatchSchema.properties.tool_name?.type !== 'string'
          || dispatchSchema.properties.arguments?.type !== 'object' || (dispatchSchema.required ?? []).join() !== 'tool_name') throw new Error('Unreal tool-search schema is incompatible.');
      for (const toolset of [APP, SCENE]) {
        const value = toolValue(await rpc(connection, 'tools/call', { name: 'describe_toolset', arguments: { toolset_name: toolset } }, identity));
        if (!plain(value) || !Array.isArray(value.tools) || value.tools.length > 500) throw new Error('Unreal toolset schema is unavailable.');
        for (const tool of value.tools) if (Object.values(TOOLS).includes(tool?.name)) { if (names.has(tool.name)) throw new Error('Unreal tool has ambiguous dispatch paths.'); names.add(tool.name); catalog.push(tool); }
      }
    }
    const admitted = {};
    for (const [key, name] of Object.entries(TOOLS)) {
      const tool = catalog.find(item => item.name === name);
      if (tool && inputSchemaMatches(key, tool.inputSchema)) admitted[key] = { name, schema_hash: digest(tool.inputSchema), search };
    }
    return admitted;
  }
  async function connect(config, identity) {
    const verified = await binding(config, identity);
    if (session && digest(session.config) === digest(config) && session.binding.connection_id === verified.connection_id) return session;
    const initialized = await exchange(config, { jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: { protocolVersion: PROTOCOLS[0], capabilities: {}, clientInfo: { name: 'yur-desktop-unreal', version: '1' } } }, identity);
    const result = initialized.result, sessionId = initialized.headers['mcp-session-id'];
    if (!plain(result) || !PROTOCOLS.includes(result.protocolVersion) || !plain(result.capabilities?.tools) || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Unreal MCP protocol negotiation failed.');
    const connection = { config, binding: verified, sessionId, protocol: result.protocolVersion, tools: {} };
    await exchange(config, { jsonrpc: '2.0', method: 'notifications/initialized' }, identity, { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': connection.protocol }, true);
    connection.tools = await discover(connection, identity);
    await binding(config, identity, verified); session = connection; return connection;
  }
  function checkedPayload(action, supplied, identity) {
    policy(action, supplied, identity); if (!accepts(action)) throw new Error('Unreal action is not connected.'); const payload = boundedJson(supplied);
    if (action === 'unreal_inspect') { fields(payload, ['kind']); if (!['level', 'selection', 'camera', 'assets'].includes(payload.kind)) throw new Error('Select a supported Unreal inspection.'); }
    else if (action === 'unreal_camera') { fields(payload, ['location', 'rotation']); numberObject(payload.location, ['x', 'y', 'z'], 10000000); numberObject(payload.rotation, ['pitch', 'yaw', 'roll'], 360); }
    else fields(payload, []); return payload;
  }
  async function validate(action, supplied, identity) {
    const payload = checkedPayload(action, supplied, identity);
    if (action === 'unreal_camera') {
      const config = current(); if (!config) throw new Error('Unreal is not configured.'); const connection = await connect(config, identity);
      policy(action, payload, identity); if (!connection.tools.move) throw new Error('The selected Unreal connection has no compatible camera tool.');
      const stamp = digest({ config, binding: connection.binding, payload, schema: connection.tools.move.schema_hash, mission: identity.mission_id, request: identity.request_id });
      const prior = prepared.get(identity.action_id);
      if (prior && (prior.stamp !== stamp || prior.owner !== identity.owner)) throw new Error('Unreal review scope changed; request a new action.');
      if (!prior && prepared.size >= 4096) throw new Error('Unreal action review capacity reached.');
      prepared.set(identity.action_id, { stamp, owner: identity.owner, connection, payload });
    }
    return payload;
  }
  function catalog() {
    let config; try { config = current(); } catch {}
    return [{ id: 'unreal', actions: UNREAL_ACTIONS, status: config ? 'configured' : 'unavailable', adapter_bound: true, service_health: 'unchecked',
      requires_confirmation: ['unreal_camera'], notice: 'Existing local Unreal MCP only. The selected project and listening editor process must match. Inspection and viewport preview do not certify engine health or connect NOVA. No engine launch, scripting, asset save or project mutation is admitted.' }];
  }
  function confirmationRequirements(action) {
    const project = action === 'unreal_camera' ? current()?.project_file : null;
    return { required: action === 'unreal_camera', ...(project ? { project_file: project } : {}),
      review: project ? `Move the viewport camera in ${project}. No assets are saved.` : '' };
  }
  async function execute(action, supplied, identity, confirmation = {}) {
    const payload = checkedPayload(action, supplied, identity); const config = current();
    if (!config) { if (action === 'unreal_status') return { status: 'unconfigured', available: false, actions: [], notice: 'Select an existing Unreal project with its local MCP plugin enabled.' }; throw new Error('Unreal is not configured.'); }
    let connection;
    if (action === 'unreal_camera') {
      const prior = prepared.get(identity.action_id);
      if (confirmation.confirmed !== true || !prior || prior.owner !== identity.owner || dispatched.has(identity.action_id)) throw new Error('Unreal camera requires a fresh native human confirmation.');
      connection = prior.connection;
      const stamp = digest({ config, binding: connection.binding, payload, schema: connection.tools.move?.schema_hash, mission: identity.mission_id, request: identity.request_id });
      if (stamp !== prior.stamp) throw new Error('The approved Unreal scope changed.');
      // Reserve before the first await: duplicate concurrent dispatches must not
      // both pass approval checks. A failed recheck requires a new review identity.
      dispatched.add(identity.action_id);
      await binding(config, identity, connection.binding);
      const tools = await discover(connection, identity);
      if (tools.move?.schema_hash !== connection.tools.move.schema_hash) throw new Error('Unreal camera schema changed after review.');
    } else {
      try { connection = await connect(config, identity); } catch (error) {
        policy(action, payload, identity);
        if (action === 'unreal_status') { session = null; return { status: 'unavailable', available: false, project_file: config.project_file, actions: [], notice: 'The selected Unreal project has no verified compatible MCP connection. Start or configure it separately in Unreal.' }; }
        throw error;
      }
    }
    policy(action, payload, identity); if (digest(current()) !== digest(config)) throw new Error('Unreal host configuration changed.');
    await binding(config, identity, connection.binding); policy(action, payload, identity);
    if (digest(current()) !== digest(config)) throw new Error('Unreal host configuration changed.');
    if (action === 'unreal_status') return { status: 'connected', available: true, project_file: config.project_file, process_id: connection.binding.process_id,
      protocol: connection.protocol, inspections: ['level', 'selection', 'camera', 'assets'].filter(key => connection.tools[key]), capture_available: Boolean(connection.tools.capture && onCapture), camera_available: Boolean(connection.tools.move),
      actions: UNREAL_ACTIONS.filter(a => a !== 'unreal_camera' || connection.tools.move).filter(a => a !== 'unreal_capture' || connection.tools.capture && onCapture) };
    const key = action === 'unreal_inspect' ? payload.kind : action === 'unreal_capture' ? 'capture' : 'move', tool = connection.tools[key];
    if (!tool || key === 'capture' && typeof onCapture !== 'function') throw new Error('This Unreal operation is unavailable on the selected connection.');
    const args = key === 'move' ? { transform: payload } : {};
    const params = tool.search ? { name: 'call_tool', arguments: { toolset_name: tool.name.slice(0, tool.name.lastIndexOf('.')), tool_name: tool.name.slice(tool.name.lastIndexOf('.') + 1), arguments: args } } : { name: tool.name, arguments: args };
    let result;
    try {
      result = toolValue(await rpc(connection, 'tools/call', params, identity));
      if (key === 'move') { fields(result, ['returnValue']); if (result.returnValue !== null) throw new Error('Unexpected camera result.'); }
    }
    catch (error) { if (key === 'move') { const uncertain = new Error('Unreal camera outcome is uncertain. Inspect the viewport; do not automatically repeat the action.'); uncertain.code = 'UNREAL_OUTCOME_UNCERTAIN'; throw uncertain; } throw error; }
    policy(action, payload, identity); await binding(config, identity, connection.binding); policy(action, payload, identity);
    if (digest(current()) !== digest(config)) throw new Error('Unreal host configuration changed after dispatch; inspect the previous project before repeating an operation.');
    if (key === 'move') return { changed: true, scope: 'viewport_camera', project_file: config.project_file, persisted: false };
    const value = result.returnValue;
    if (key === 'capture') {
      const image = value?.image;
      if (image?.mimeType !== 'image/png' || typeof image.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw new Error('Unreal capture is not a supported PNG.');
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length < 24 || bytes.length > MAX_RESPONSE || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('base64') !== image.data) throw new Error('Unreal capture is not a bounded PNG.');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) throw new Error('Unreal capture dimensions exceed the preview bound.');
      const sha256 = digest(bytes); policy(action, payload, identity);
      await onCapture({ mime_type: 'image/png', bytes, sha256, width, height, project_file: config.project_file }, identity);
      policy(action, payload, identity);
      return { project_file: config.project_file, capture: { sha256, bytes: bytes.length, mime_type: 'image/png', width, height, preview_delivered: true } };
    }
    if (key === 'level') { if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]/.test(value)) throw new Error('Unreal level identity is unsupported.'); return { project_file: config.project_file, level: value }; }
    if (key === 'camera') { numberObject(value?.location, ['x', 'y', 'z'], 10000000); numberObject(value?.rotation, ['pitch', 'yaw', 'roll'], 360); return { project_file: config.project_file, camera: { location: value.location, rotation: value.rotation } }; }
    if (!Array.isArray(value) || value.length > 200) throw new Error('Unreal selection exceeds its inspection bound.');
    const selected = value.map(item => key === 'selection' ? item?.refPath : item);
    if (selected.some(item => typeof item !== 'string' || item.length > 1024 || /[\x00-\x1f]/.test(item))) throw new Error('Unreal selection identity is unsupported.');
    return { project_file: config.project_file, [key]: selected };
  }
  return { accepts, isReadOnly, validate, confirmationRequirements, execute, catalog };
}
module.exports = { UNREAL_ACTIONS, createFranklinUnreal, readUnrealProjectConfiguration, resolveUnrealProjectConfiguration, verifyUnrealProjectBinding };
