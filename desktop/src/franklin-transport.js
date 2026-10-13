'use strict';
// A bounded process/host bridge. Franklin reuses the existing Python Work owner.
const { spawn } = require('node:child_process');
const path = require('node:path');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => ({ ok: false, error: { code, message: String(message).slice(0, 1000) } });
function createFranklinTransport({ sourceRoot, getPython, getStateRoot, getEnvironment, executeHost, observeEnvironment, onEvent = () => {}, spawnProcess = spawn }) {
  const children = new Set(); let active = null, initialized = false, recovering = null, generation = 0, closing = false, shutdownPromise = null;
  function queueConfigured() { try { const environment = getEnvironment(); return Boolean(environment.YUR_FRANKLIN_RUNPOD_URL && environment.YUR_FRANKLIN_RUNPOD_MODEL); } catch { return false; } }
  function waitForExit(child, milliseconds = 2000) {
    if (!child || !children.has(child)) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = exited => { clearTimeout(timer); child.off('close', closed); child.off('error', closed); resolve(exited); };
      const closed = () => done(true), timer = setTimeout(() => done(false), milliseconds);
      child.once('close', closed); child.once('error', closed);
    });
  }
  function rpc(request, { owner, live = false, onChild = () => {} } = {}) {
    return new Promise(resolve => {
      if (children.size >= 4) { resolve(failure('BUSY', 'Franklin is saving state. Try again shortly.')); return; }
      let encoded;
      try { encoded = JSON.stringify(request) + '\n'; if (Buffer.byteLength(encoded) > 128 * 1024) throw new Error(); }
      catch { resolve(failure('FRANKLIN_LIMIT', 'Franklin request exceeded its serialized input budget.')); return; }
      const turn = live ? active : null, hostIds = new Set();
      let child, settled = false, input = '', bytes = 0, hostCalls = 0, inHost = false, response = null, mission = null;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { child?.kill(); finish(failure('FRANKLIN_TIMEOUT', 'Franklin reached its time budget. Its committed work remains available.')); }, live ? (queueConfigured() ? 1235000 : 10 * 60 * 1000) : 20000);
      try {
        const environment = { ...getEnvironment(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', YUR_DESKTOP_HOME: getStateRoot() };
        delete environment.PYTHONPATH; delete environment.PYTHONHOME;
        child = spawnProcess(getPython(), ['-B', '-m', 'foundry.franklin_cli'], { cwd: sourceRoot, windowsHide: true, shell: false, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child); onChild(child);
      } catch { finish(failure('FRANKLIN_UNAVAILABLE', 'Franklin runtime could not start.')); return; }
      const emit = event => { if (!settled) { try { onEvent(event, owner); } catch {} } };
      const ownsTurn = () => !settled && active === turn && turn?.owner === owner && !turn.cancelled && !child.killed;
      async function frame(value) {
        if (settled) return;
        if (!object(value)) throw new Error('Invalid Franklin runtime frame');
        if (response) throw new Error('Franklin emitted data after its final result');
        if (value.type === 'event' && object(value.event)) {
          if (live && value.event.request_id !== undefined && value.event.request_id !== request.request_id) throw new Error('Franklin event belongs to another request');
          if (live && value.event.type === 'model_queue') turn.queueTransport = true;
          emit(value.event); return;
        }
        if (value.type === 'result' && object(value.response) && typeof value.response.ok === 'boolean') {
          if (inHost) throw new Error('Franklin returned before its host request completed');
          response = value.response; return;
        }
        if (value.type !== 'host_action' || !live || !UUID.test(String(request.request_id)) || value.request_id !== request.request_id
          || !ownsTurn() || !/^[a-f0-9]{32}$/.test(String(value.mission_id)) || (mission && value.mission_id !== mission)
          || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) || hostIds.has(value.id)
          || typeof value.action !== 'string' || value.action.length > 80 || !object(value.payload)
          || Buffer.byteLength(JSON.stringify(value.payload)) > 65536 || inHost || ++hostCalls > 20) throw new Error('Franklin host action did not match its active request');
        mission = value.mission_id; hostIds.add(value.id);
        inHost = true;
        try {
          const result = await executeHost(value.action, value.payload, { owner, request_id: request.request_id, mission_id: value.mission_id, action_id: value.id, isActive: ownsTurn });
          const returned = JSON.stringify({ type: 'host_result', id: value.id, result }) + '\n';
          if (Buffer.byteLength(returned) > 128 * 1024) throw new Error('Desktop result exceeded its context budget');
          if (ownsTurn()) child.stdin.write(returned);
        } catch (error) {
          if (ownsTurn()) child.stdin.write(JSON.stringify({ type: 'host_result', id: value.id, result: { error: String(error?.message || error).slice(0, 1000), status: 'rejected' } }) + '\n');
        } finally { inHost = false; }
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk); input += chunk;
        if (bytes > 4 * 1024 * 1024 || input.length > 1024 * 1024) { child.kill(); finish(failure('FRANKLIN_LIMIT', 'Franklin exceeded its response limit.')); return; }
        let index;
        while ((index = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, index).trim(); input = input.slice(index + 1); if (!line) continue;
          try { void frame(JSON.parse(line)).catch(() => { child.kill(); finish(failure('FRANKLIN_PROTOCOL', 'Franklin returned an invalid host request.')); }); }
          catch { child.kill(); finish(failure('FRANKLIN_PROTOCOL', 'Franklin returned an invalid runtime response.')); }
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', () => { children.delete(child); finish(failure('FRANKLIN_UNAVAILABLE', 'Franklin runtime could not start.')); });
      child.stdin.on('error', () => {});
      child.on('close', code => {
        children.delete(child);
        if (turn?.cancelled) finish(turn.cancelled);
        else if (input.trim() || inHost) finish(failure('FRANKLIN_PROTOCOL', 'Franklin stopped with an incomplete protocol frame or host action.'));
        else finish(response && (code === 0 || !response.ok) ? response : failure('FRANKLIN_INTERRUPTED', 'Franklin stopped before returning a result. Review saved work before retrying.'));
      });
      child.stdin.write(encoded);
      if (!live) child.stdin.end();
    });
  }
  async function recover() {
    if (initialized) return;
    if (!recovering) {
      const epoch = generation;
      recovering = (async () => {
        if (active?.child && !await waitForExit(active.child)) throw new Error('The previous Franklin runtime is still exiting.');
        if (epoch !== generation) throw new Error('Franklin shut down during recovery.');
        const value = await rpc({ command: 'recover' });
        if (!value.ok) throw new Error(value.error.message);
        if (epoch !== generation) throw new Error('Franklin shut down during recovery.');
        initialized = true; return value.result;
      })().finally(() => { recovering = null; });
    }
    return recovering;
  }
  return {
    async request(request) { await recover(); return rpc(request); },
    async send(value, owner) {
      if (closing) return failure('FRANKLIN_CLOSING', 'Franklin is shutting down and reconciling its current work.');
      if (!object(value) || Object.keys(value).sort().join(',') !== 'request_id,text' || !UUID.test(value.request_id) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 32000) return failure('INVALID_REQUEST', 'Enter a bounded Franklin request.');
      const replay = () => active.owner !== owner ? failure('WRONG_OWNER', 'This request belongs to a different active session.')
        : active.request_id === value.request_id && active.text === value.text ? { ok: true, result: { accepted: true, request_id: value.request_id } }
        : failure(active.request_id === value.request_id ? 'REQUEST_CONFLICT' : 'BUSY', 'Franklin is working; an active request identity cannot be changed.');
      if (active) return replay();
      await recover();
      if (closing) return failure('FRANKLIN_CLOSING', 'Franklin is shutting down and reconciling its current work.');
      if (active) return replay();
      // Reserve before asynchronous observation so two clicks cannot start two turns.
      const reserved = { request_id: value.request_id, text: value.text, owner, child: null, generation };
      active = reserved;
      let environment;
      try { environment = await observeEnvironment(owner); }
      catch (error) { if (active === reserved) active = null; return failure('CONTEXT_UNAVAILABLE', error.message); }
      if (active !== reserved) return { ok: true, result: { cancelled: true, status: 'cancelled', request_id: value.request_id } };
      void rpc({ command: 'send', ...value, environment }, { owner, live: true, onChild: child => { if (active?.request_id === value.request_id) active.child = child; } }).then(async response => {
        let recovered = null, recoveryError = null;
        if (!response.ok && reserved.generation === generation && !reserved.cancelled) {
          initialized = false;
          // A killed Python child may still hold the canonical worker lock.
          // Reconcile only after exit; recovery never reissues accepted work.
          const exited = await waitForExit(reserved.child);
          if (reserved.generation !== generation) return;
          if (exited) {
            try { recovered = await recover(); }
            catch { recoveryError = failure('FRANKLIN_RECOVERY_PENDING', 'Saved work still needs reconciliation. Refresh after the active worker exits.').error; }
          } else recoveryError = failure('FRANKLIN_RECOVERY_PENDING', 'The previous runtime is still exiting. Refresh after it stops.').error;
        }
        if (reserved.generation !== generation) return;
        if (active === reserved) active = null;
        try { onEvent({ type: reserved.cancelled ? 'turn.cancelled' : response.ok ? 'turn.complete' : 'turn.error', request_id: value.request_id,
          ...(response.ok ? { snapshot: response.result } : { error: response.error, ...(recovered ? { snapshot: recovered } : {}), ...(recoveryError ? { recovery_error: recoveryError } : {}) }) }, owner); } catch {}
      });
      return { ok: true, result: { accepted: true, request_id: value.request_id } };
    },
    async cancel(value, owner) {
      if (!object(value) || Object.keys(value).join(',') !== 'request_id' || !UUID.test(value.request_id)) return failure('INVALID_REQUEST', 'Select Franklin’s active request.');
      if (active && (active.owner !== owner || active.request_id !== value.request_id)) return failure('WRONG_OWNER', 'This request belongs to a different active session.');
      if (active && !active.child) {
        active = null;
        try { onEvent({ type: 'turn.cancelled', request_id: value.request_id }, owner); } catch {}
        return { ok: true, result: { cancelled: true, request_id: value.request_id } };
      }
      const cancelled = active;
      if (cancelled?.cancelPromise) return cancelled.cancelPromise;
      const operation = async () => {
        const response = await rpc({ command: 'cancel', request_id: value.request_id });
        if (response.ok && active && active === cancelled) {
          cancelled.cancelled = response;
          if (cancelled.queueTransport) {
            // Cancellation is durable first. Keep the reservation while the
            // provider cancels that exact remote job and reports its outcome.
            const exited = await waitForExit(cancelled.child, 35000);
            if (!exited) cancelled.child?.kill();
            if (active === cancelled) active = null;
            return { ...response, result: { ...response.result, remote_cleanup: exited ? 'runtime_finished' : 'needs_reconciliation' } };
          }
          active = null; cancelled.child?.kill();
        }
        return response;
      };
      // Reserve the control operation before its RPC acknowledgment so two
      // Stop clicks cannot create competing cancellation children.
      const promise = operation();
      if (cancelled) cancelled.cancelPromise = promise;
      return promise;
    },
    active() { return active ? { request_id: active.request_id, status: 'running' } : null; },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      const finish = () => { generation++; for (const child of children) child.kill(); active = null; initialized = false; };
      if (active?.queueTransport) {
        const selected = active;
        shutdownPromise = this.cancel({ request_id: selected.request_id }, selected.owner).catch(() => {}).finally(finish);
      } else { finish(); shutdownPromise = Promise.resolve(); }
      return shutdownPromise;
    },
  };
}
module.exports = { createFranklinTransport };
