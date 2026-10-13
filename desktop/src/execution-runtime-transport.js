'use strict';
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { cleanEnvironment } = require('./work-transport');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATES = new Set(['accepted', 'starting', 'ready', 'releasing', 'released', 'failed', 'uncertain', 'expired']);
const ACTIVE = new Set(['accepted', 'starting', 'ready', 'releasing', 'uncertain']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const match = (value, pattern) => typeof value === 'string' && pattern.test(value);
const plain = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const iso = value => typeof value === 'string' && value.length <= 64 && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const fail = (code, message) => ({ ok: false, error: { code, message } });
const resourceId = distro => createHash('sha256').update(JSON.stringify({ distro, kind: 'wsl2' })).digest('hex');

function resolveExecutionSelection(settings = {}, environment = {}, checkedDistro = null) {
  if (environment.YUR_EXECUTION_DISTRO !== undefined) {
    if (!match(environment.YUR_EXECUTION_DISTRO, DISTRO)) throw new Error('YUR_EXECUTION_DISTRO must name one installed local distribution.');
    return { distro: environment.YUR_EXECUTION_DISTRO, configuration_source: 'environment' };
  }
  if (settings.execution_distro !== undefined && settings.execution_distro !== '' && !match(settings.execution_distro, DISTRO)) throw new Error('The saved execution distribution is invalid.');
  if (settings.execution_distro) return { distro: settings.execution_distro, configuration_source: 'settings' };
  return { distro: match(checkedDistro, DISTRO) ? checkedDistro : null, configuration_source: 'auto' };
}
function validateRuntime(value) {
  if (!object(value) || !['architecture,artifacts,distro,libseccomp,python', 'architecture,artifacts,distro,kernel,libseccomp,python'].includes(Object.keys(value).sort().join(',')) || !match(value.distro, DISTRO)) throw new Error('Invalid verified runtime.');
  for (const key of ['architecture', 'python', 'libseccomp', 'kernel']) if (value[key] !== undefined && (!plain(value[key], 160) || !value[key])) throw new Error('Invalid runtime version.');
  if (!object(value.artifacts) || Object.keys(value.artifacts).length < 1 || Object.keys(value.artifacts).length > 8) throw new Error('Invalid runtime artifacts.');
  for (const [name, item] of Object.entries(value.artifacts)) {
    const safePath = text => plain(text, 240) && text.startsWith('/usr/') && !text.split('/').includes('..');
    if (!safePath(name) || !exact(item, 'path,sha256,bytes') || !safePath(item.path) || !match(item.sha256, SHA) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 16 * 1024 * 1024) throw new Error('Invalid runtime artifact.');
  }
}
function validateError(error) {
  if (!object(error) || Object.keys(error).some(key => !['code', 'message', 'diagnostics'].includes(key)) || !match(error.code, /^[A-Za-z0-9._-]{1,80}$/) || !plain(error.message, 500)) throw new Error('Invalid runtime error.');
  if (error.diagnostics !== undefined && error.diagnostics !== null) {
    const value = error.diagnostics, fields = ['schema', 'phase', 'outcome', 'timeout_seconds', 'errno', 'winerror', 'returncode', 'stdout_bytes', 'stderr_bytes', 'stdout_sha256', 'stderr_sha256', 'selected_distro', 'running_distros', 'running_distros_truncated'];
    if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) || value.schema !== 'yur.execution-diagnostic.v1' || !['wsl_status', 'runtime_selection', 'runtime_verification'].includes(value.phase) || !['timeout', 'os_error', 'nonzero_exit', 'output_limit', 'selected_not_running', 'invalid_selection', 'ambiguous_selection', 'malformed_response', 'fingerprint_mismatch'].includes(value.outcome) || Buffer.byteLength(JSON.stringify(value)) > 4096) throw new Error('Invalid runtime diagnostics.');
    for (const key of ['stdout_sha256', 'stderr_sha256']) if (value[key] !== undefined && !match(value[key], SHA)) throw new Error('Invalid diagnostic digest.');
    for (const key of ['stdout_bytes', 'stderr_bytes']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new Error('Invalid diagnostic count.');
    for (const key of ['errno', 'winerror', 'returncode']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < -(2 ** 31) || value[key] > 2 ** 32 - 1)) throw new Error('Invalid diagnostic code.');
    if (value.timeout_seconds !== undefined && (!Number.isFinite(value.timeout_seconds) || value.timeout_seconds <= 0 || value.timeout_seconds > 3600)) throw new Error('Invalid diagnostic deadline.');
    if (value.selected_distro !== undefined && !match(value.selected_distro, DISTRO)) throw new Error('Invalid diagnostic selection.');
    if (value.running_distros !== undefined && (!Array.isArray(value.running_distros) || value.running_distros.length > 32 || !value.running_distros.every(item => match(item, DISTRO)))) throw new Error('Invalid diagnostic resources.');
    if (value.running_distros_truncated !== undefined && typeof value.running_distros_truncated !== 'boolean') throw new Error('Invalid diagnostic truncation.');
  }
}
function validateSetup(setup, operationId = null) {
  if (!exact(setup, 'schema,operation_id,resource_id,distro,owner_session_id,state,created_at,updated_at,expires_at,check,authority,evidence,revision') || setup.schema !== 'yur.execution-runtime-setup.v1' || !match(setup.operation_id, UUID) || (operationId && setup.operation_id !== operationId) || !match(setup.owner_session_id, UUID) || !match(setup.distro, DISTRO) || setup.resource_id !== resourceId(setup.distro) || !STATES.has(setup.state) || !Number.isSafeInteger(setup.revision) || setup.revision < 1) throw new Error('Invalid setup identity.');
  for (const key of ['created_at', 'updated_at', 'expires_at']) if (!iso(setup[key])) throw new Error('Invalid setup timestamp.');
  if (setup.revision > 16 || Date.parse(setup.expires_at) - Date.parse(setup.created_at) !== 900000 || Date.parse(setup.updated_at) < Date.parse(setup.created_at)) throw new Error('Invalid setup lifetime.');
  const check = setup.check;
  if (!exact(check, 'checked_at,expires_at,token_sha256,observation_sha256,state,configuration_source') || !iso(check.checked_at) || !iso(check.expires_at) || Date.parse(check.expires_at) <= Date.parse(check.checked_at) || Date.parse(check.expires_at) - Date.parse(check.checked_at) > 120000 || !match(check.token_sha256, SHA) || !match(check.observation_sha256, SHA) || !['running', 'stopped'].includes(check.state) || !['environment', 'settings', 'operator', 'auto'].includes(check.configuration_source)) throw new Error('Invalid setup check.');
  if (Date.parse(setup.created_at) < Date.parse(check.checked_at) || Date.parse(setup.created_at) > Date.parse(check.expires_at)) throw new Error('Setup was accepted outside its check lifetime.');
  const auth = setup.authority;
  if (!exact(auth, 'issuer,scope,actions,operation_id,resource_id') || auth.issuer !== 'local-user' || auth.scope !== 'execution-runtime-prepare' || auth.operation_id !== setup.operation_id || auth.resource_id !== setup.resource_id || JSON.stringify(auth.actions) !== JSON.stringify(['start-reviewed-runtime', 'hold-reviewed-runtime', 'release-owned-hold'])) throw new Error('Invalid setup authority.');
  const evidence = setup.evidence;
  if (!exact(evidence, 'started_by_this_setup,runtime,owned_process_exit_confirmed,release_reason,error') || (evidence.started_by_this_setup !== null && typeof evidence.started_by_this_setup !== 'boolean') || typeof evidence.owned_process_exit_confirmed !== 'boolean' || (evidence.release_reason !== null && !['operator', 'owner_eof', 'deadline', 'verification_failed', 'process_exit', 'protocol_error', 'shutdown'].includes(evidence.release_reason))) throw new Error('Invalid setup evidence.');
  if (evidence.runtime !== null) { validateRuntime(evidence.runtime); if (evidence.runtime.distro !== setup.distro) throw new Error('Runtime identity changed.'); }
  if (evidence.error !== null) validateError(evidence.error);
  if (setup.state === 'ready' && (!evidence.runtime || evidence.started_by_this_setup === null || evidence.owned_process_exit_confirmed || evidence.error)) throw new Error('Ready setup lacks verification.');
  if (['released', 'expired'].includes(setup.state) && (!evidence.owned_process_exit_confirmed || !evidence.release_reason)) throw new Error('Release lacks exit confirmation.');
  if (Buffer.byteLength(JSON.stringify(setup)) > 16384) throw new Error('Setup exceeds its response budget.');
  return setup;
}
function validateReceipt(receipt, setup) {
  if (!exact(receipt, 'id,operation_id,revision,event_type,created_at,previous_hash,hash') || !Number.isSafeInteger(receipt.id) || receipt.id < 1 || receipt.operation_id !== setup.operation_id || receipt.revision !== setup.revision || receipt.event_type !== 'runtime.setup.' + setup.state || receipt.created_at !== setup.updated_at || !iso(receipt.created_at) || !match(receipt.hash, SHA) || (receipt.previous_hash !== null && !match(receipt.previous_hash, SHA))) throw new Error('Invalid setup receipt.');
}
function validateCheck(value) {
  if (!exact(value, 'schema,status,checked_at,expires_at,resources,selected_resource_id,configuration_source,runtime,diagnostics,check_token,active_setup') || value.schema !== 'yur.execution-setup-check.v1' || !['ready', 'stopped', 'mismatch', 'unknown'].includes(value.status) || !iso(value.checked_at) || !iso(value.expires_at) || !Array.isArray(value.resources) || value.resources.length > 16 || !['environment', 'settings', 'operator', 'auto'].includes(value.configuration_source)) throw new Error('Invalid execution check.');
  const seen = new Set();
  for (const item of value.resources) { if (!exact(item, 'resource_id,distro,state,version') || !match(item.distro, DISTRO) || item.resource_id !== resourceId(item.distro) || seen.has(item.resource_id) || !['running', 'stopped'].includes(item.state) || item.version !== 2) throw new Error('Invalid installed resource.'); seen.add(item.resource_id); }
  if (value.selected_resource_id !== null && !seen.has(value.selected_resource_id)) throw new Error('Check selected an unknown resource.');
  if (value.runtime !== null) { validateRuntime(value.runtime); if (resourceId(value.runtime.distro) !== value.selected_resource_id) throw new Error('Check runtime differs from selection.'); }
  if (value.status === 'ready' && !value.runtime) throw new Error('Ready check lacks verification.');
  if (value.diagnostics !== null) validateError(value.diagnostics);
  if (value.check_token !== null && (!match(value.check_token, UUID) || !['ready', 'stopped'].includes(value.status) || !value.selected_resource_id || Date.parse(value.expires_at) - Date.parse(value.checked_at) > 120000)) throw new Error('Invalid check token.');
  if (value.active_setup !== null) validateSetup(value.active_setup);
  return value;
}

function createExecutionRuntimeTransport({ sourceRoot, getStateRoot, getPython = () => 'python', getEnvironment = () => process.env, getSelection = () => resolveExecutionSelection({}, getEnvironment()), onEvent = () => {}, spawnProcess = spawn, checkTimeoutMs = 30000, prepareTimeoutMs = 45000, controlTimeoutMs = 10000, cleanupTimeoutMs = 10000 } = {}) {
  if (!path.isAbsolute(sourceRoot || '') || typeof getStateRoot !== 'function') throw new Error('Explicit runtime setup roots are required.');
  for (const [value, max] of [[checkTimeoutMs, 30000], [prepareTimeoutMs, 45000], [controlTimeoutMs, 10000], [cleanupTimeoutMs, 10000]]) if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Runtime setup deadlines must be bounded.');
  let session = null, pending = null, closed = false, lastCheck = null, lastOperationId = null, retained = null, closing = null;
  function remember(setup, receipt = null) {
    if (!setup) return;
    validateSetup(setup); if (receipt) validateReceipt(receipt, setup);
    if (retained?.setup.operation_id === setup.operation_id && retained.setup.revision > setup.revision) return;
    if (retained?.setup.operation_id === setup.operation_id && retained.setup.resource_id !== setup.resource_id) throw new Error('Setup changed its resource.');
    const priorReceipt = retained?.setup.operation_id === setup.operation_id && retained.setup.revision === setup.revision ? retained.receipt : null;
    lastOperationId = setup.operation_id; retained = { setup, receipt: receipt || priorReceipt };
  }
  function settle(response) { if (!pending) return; const item = pending; pending = null; clearTimeout(item.timer); item.resolve(response); }
  function disconnect(code, message) {
    lastCheck = null; settle(fail(code, message));
    const old = session; if (!old || old.poisoned) return;
    old.poisoned = true; try { old.child.stdin.end(); } catch { /* EOF remains best effort; owned child deadline follows. */ }
    old.cleanup = setTimeout(() => { try { old.child.kill(); } catch { /* Never target another process. */ } }, cleanupTimeoutMs); old.cleanup.unref?.();
  }
  function consume(record) {
    if (record.type === 'state') {
      if (!exact(record, 'type,operation_id,setup,receipt') || record.operation_id !== lastOperationId) throw new Error('Unbound runtime setup event.');
      validateSetup(record.setup, record.operation_id); validateReceipt(record.receipt, record.setup);
      if (retained?.setup.operation_id === record.operation_id && record.setup.revision < retained.setup.revision) return;
      remember(record.setup, record.receipt); try { onEvent(record); } catch { /* Renderer teardown cannot change committed setup evidence. */ } return;
    }
    if (!pending || record.type !== 'result' || record.request_id !== pending.frame.request_id || record.command !== pending.frame.command || typeof record.ok !== 'boolean' || !exact(record, record.ok ? 'type,request_id,command,ok,result' : 'type,request_id,command,ok,error')) throw new Error('Mismatched runtime response.');
    if (!record.ok) { validateError(record.error); settle({ ok: false, error: record.error }); return; }
    if (record.command === 'check') {
      if (!exact(record.result, 'check')) throw new Error('Invalid check envelope.');
      const check = validateCheck(record.result.check), selection = pending.frame.distro;
      const selected = check.resources.find(item => item.resource_id === check.selected_resource_id);
      if (selection && selected && selection !== selected.distro && check.configuration_source !== 'environment') throw new Error('Checked another selected resource.');
      lastCheck = check; if (check.active_setup) remember(check.active_setup);
    } else {
      if (!exact(record.result, record.command === 'inspect' ? 'setup,receipt' : 'setup,receipt,replayed') || (record.command !== 'inspect' && typeof record.result.replayed !== 'boolean')) throw new Error('Invalid setup result envelope.');
      if (record.result.setup === null) {
        if (record.result.receipt !== null || (record.command !== 'inspect' && !(record.command === 'release' && record.result.replayed === true))) throw new Error('Missing setup result.');
        if (pending.frame.operation_id === lastOperationId) { lastOperationId = null; retained = null; }
      }
      else { validateSetup(record.result.setup, pending.frame.operation_id); validateReceipt(record.result.receipt, record.result.setup); remember(record.result.setup, record.result.receipt); }
    }
    settle({ ok: true, result: record.result });
  }
  function ensureSession() {
    if (session) { if (session.poisoned) throw new Error('The previous setup connection is still closing. Inspect the operation shortly.'); return; }
    const stateRoot = getStateRoot(); if (!path.isAbsolute(stateRoot || '')) throw new Error('Runtime state root must be absolute.');
    const host = getEnvironment(), env = { ...cleanEnvironment(host), YUR_DESKTOP_HOME: stateRoot, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
    if (host.YUR_EXECUTION_DISTRO !== undefined) env.YUR_EXECUTION_DISTRO = host.YUR_EXECUTION_DISTRO;
    const child = spawnProcess(getPython(), ['-B', '-m', 'foundry.execution_setup_cli'], { cwd: sourceRoot, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const owner = session = { child, poisoned: false, buffer: '', bytes: 0, stderr: 0, cleanup: null, closePromise: null };
    owner.closePromise = new Promise(resolve => child.once('close', () => { clearTimeout(owner.cleanup); if (session === owner) { session = null; lastCheck = null; settle(fail('CONNECTION_CLOSED', 'The setup connection ended. Inspect the retained operation before preparing again.')); } resolve(); }));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      if (session !== owner || owner.poisoned) return;
      owner.bytes += Buffer.byteLength(chunk); owner.buffer += chunk;
      try {
        if (owner.bytes > 16 * 1024 * 1024 || Buffer.byteLength(owner.buffer) > 128 * 1024) throw new Error('Runtime response budget exceeded.');
        let index; while ((index = owner.buffer.indexOf('\n')) >= 0) { const line = owner.buffer.slice(0, index); owner.buffer = owner.buffer.slice(index + 1); if (Buffer.byteLength(line) > 65536) throw new Error('Runtime frame exceeded its limit.'); if (line.trim()) consume(JSON.parse(line)); }
      } catch { disconnect('INVALID_RUNTIME_RESPONSE', 'The runtime setup response was malformed or did not match its recorded operation.'); }
    });
    child.stderr.on('data', chunk => { owner.stderr += chunk.length; if (owner.stderr > 65536) disconnect('OUTPUT_LIMIT', 'The setup process exceeded its diagnostic output limit.'); });
    child.stdin.on('error', () => disconnect('INPUT_CLOSED', 'The setup connection closed before acknowledging the request. Inspect the same operation.'));
    child.on('error', () => disconnect('RUNTIME_UNAVAILABLE', 'The configured Python setup process could not start.'));
  }
  function request(frame) {
    if (closed || closing) return Promise.resolve(fail('CLOSED', 'Runtime setup is shutting down.'));
    if (pending) return Promise.resolve(fail('BUSY', 'Wait for the current runtime setup request.'));
    try { ensureSession(); } catch (error) { return Promise.resolve(fail('CONNECTION_UNAVAILABLE', error.message)); }
    return new Promise(resolve => {
      frame = { request_id: randomUUID(), ...frame };
      const timeout = frame.command === 'prepare' ? prepareTimeoutMs : frame.command === 'check' ? checkTimeoutMs : controlTimeoutMs;
      pending = { frame, resolve, timer: setTimeout(() => disconnect('ACKNOWLEDGMENT_UNCERTAIN', 'The setup request was not acknowledged within its deadline. Inspect the same operation; no retry was started.'), timeout) };
      try { session.child.stdin.write(JSON.stringify(frame) + '\n'); } catch { disconnect('INPUT_CLOSED', 'The setup process could not accept its request.'); }
    });
  }
  async function check(value) {
    if (!exact(value, 'resource_id') || (value.resource_id !== null && !match(value.resource_id, SHA))) return fail('INVALID_REQUEST', 'Choose one listed runtime resource.');
    if (pending) return fail('BUSY', 'Wait for the current runtime setup request.');
    if (retained && ACTIVE.has(retained.setup.state)) return fail('SETUP_ACTIVE', 'Inspect or release the retained setup before checking another runtime.');
    let selection;
    try {
      selection = getSelection();
      if (value.resource_id !== null) {
        const resource = lastCheck?.resources.find(item => item.resource_id === value.resource_id);
        if (!resource) throw new Error('Check installed resources before choosing a runtime.');
        if (selection.distro && selection.distro !== resource.distro) throw new Error('Save the selected execution runtime first. An environment override takes precedence.');
        selection = { distro: resource.distro, configuration_source: selection.configuration_source === 'auto' ? 'operator' : selection.configuration_source };
      }
    } catch (error) { return fail('INVALID_SELECTION', error.message); }
    if (session && retained && !ACTIVE.has(retained.setup.state)) {
      const owner = session;
      disconnect('SESSION_COMPLETE', 'Closing the completed setup connection before a new explicit check.');
      await Promise.race([owner.closePromise, new Promise(resolve => setTimeout(resolve, cleanupTimeoutMs + 100))]);
      if (session === owner) return fail('CONNECTION_CLOSING', 'The previous setup connection has not finished closing. No new check was started.');
    }
    return request({ command: 'check', distro: selection.distro, configuration_source: selection.configuration_source === 'environment' ? 'auto' : selection.configuration_source });
  }
  async function prepare(value) {
    if (!exact(value, 'operation_id,resource_id,check_token') || !match(value.operation_id, UUID) || !match(value.resource_id, SHA) || !match(value.check_token, UUID)) return fail('INVALID_REQUEST', 'Preparation requires the exact checked resource and an operation identity.');
    if (pending) return fail('BUSY', 'Wait for the current runtime setup request.');
    if (lastOperationId === value.operation_id) return fail('INSPECT_REQUIRED', 'Inspect this existing operation instead of preparing it again.');
    if (retained && ACTIVE.has(retained.setup.state)) return fail('SETUP_ACTIVE', 'Inspect or release the existing runtime setup first.');
    const selected = lastCheck?.resources.find(item => item.resource_id === value.resource_id);
    if (!session || session.poisoned || !lastCheck || lastCheck.check_token !== value.check_token || lastCheck.selected_resource_id !== value.resource_id || !['ready', 'stopped'].includes(lastCheck.status) || Date.parse(lastCheck.expires_at) <= Date.now()) return fail('CHECK_REQUIRED', 'Check this selected runtime again before preparing it.');
    try { const current = getSelection(); if (current.distro && current.distro !== selected?.distro) throw new Error(); } catch { return fail('SELECTION_CHANGED', 'The runtime selection changed. Check it again.'); }
    lastOperationId = value.operation_id; lastCheck = null;
    return request({ command: 'prepare', ...value });
  }
  function inspect(value) {
    if (!exact(value, 'operation_id') || (value.operation_id !== null && !match(value.operation_id, UUID))) return Promise.resolve(fail('INVALID_REQUEST', 'Inspect requires a runtime setup operation identity.'));
    const operationId = value.operation_id || lastOperationId;
    if (!operationId) return Promise.resolve({ ok: true, result: { setup: null, receipt: null } });
    if (pending && retained?.setup.operation_id === operationId && retained.receipt) return Promise.resolve({ ok: true, result: retained });
    return request({ command: 'inspect', operation_id: operationId });
  }
  function release(value) {
    if (!exact(value, 'operation_id') || !match(value.operation_id, UUID)) return Promise.resolve(fail('INVALID_REQUEST', 'Release requires the exact runtime setup operation.'));
    return request({ command: 'release', operation_id: value.operation_id });
  }
  async function dispose() {
    if (closing) return closing;
    closing = (async () => {
      if (!pending && session && !session.poisoned && lastOperationId && (!retained || ACTIVE.has(retained.setup.state))) await release({ operation_id: lastOperationId });
      closed = true; const owner = session; if (!owner) return;
      disconnect('CLOSED', 'Desktop is closing the owned runtime setup connection.');
      await Promise.race([owner.closePromise, new Promise(resolve => { const timer = setTimeout(resolve, cleanupTimeoutMs + 100); timer.unref?.(); })]);
    })(); return closing;
  }
  return { check, prepare, inspect, release, dispose };
}
module.exports = { createExecutionRuntimeTransport, resolveExecutionSelection, validateCheck, validateSetup, validateReceipt, resourceId };
