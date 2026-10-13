'use strict';

// Main-process cadence and transport only. Committed schedule claims supply the
// exact request; the existing OrchestrationManager owns every execution/lifecycle.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSION = /^[0-9a-f]{32}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUSES = new Set(['queued', 'running', 'awaiting_approval', ...TERMINAL]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = error => ({ code: String(error?.code || 'SCHEDULE_DISPATCH_FAILED').slice(0, 80), message: String(error?.message || error || 'Schedule dispatch failed.').slice(0, 2000) });

function createScheduleDispatcher({ workTransport, onState = () => {}, intervalMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  if (!workTransport || ['start', 'request', 'cancel'].some(method => typeof workTransport[method] !== 'function') || typeof onState !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000 || [setTimer, clearTimer, now].some(value => typeof value !== 'function')) throw new Error('Schedule dispatcher requires the existing Work transport and bounded cadence.');
  const owner = Object.freeze({ kind: 'committed-schedule-dispatcher' });
  let timer = null, flight = null, active = null;
  const current = { enabled: false, running: false, phase: 'stopped', active_schedule_id: null, request_id: null, mission_id: null, next_tick_at: null, last_result: null, error: null };
  const status = () => JSON.parse(JSON.stringify(current));
  const publish = () => { try { onState(status()); } catch { /* An observer cannot change committed dispatch. */ } };
  function update(fields) { Object.assign(current, fields); publish(); }
  function clearTick() { if (timer !== null) clearTimer(timer); timer = null; current.next_tick_at = null; }
  function nextTick() {
    if (!current.enabled || timer !== null) return;
    current.next_tick_at = new Date(now() + intervalMs).toISOString();
    timer = setTimer(() => { timer = null; current.next_tick_at = null; void wake(); }, intervalMs);
    timer?.unref?.(); publish();
  }
  async function rpc(request) {
    const response = await workTransport.request(request);
    if (response?.ok !== true || !object(response.result)) { const error = new Error(response?.error?.message || 'Schedule runtime returned an invalid result.'); error.code = response?.error?.code || 'INVALID_SCHEDULE_RESPONSE'; throw error; }
    return response.result;
  }
  function claimChecked(value) {
    if (!object(value) || !object(value.schedule) || !object(value.request) || typeof value.replayed !== 'boolean' || !UUID.test(value.schedule.id) || typeof value.schedule.enabled !== 'boolean' || !UUID.test(value.request.request_id) || value.schedule.active_request_id !== value.request.request_id || !UUID.test(value.request.conversation_id) || value.schedule.conversation_id !== value.request.conversation_id) throw new Error('Schedule runtime returned an invalid claim identity.');
    return value;
  }
  function missionChecked(value, claim, allowNull = false) {
    if (allowNull && value === null) return null;
    if (!object(value) || !MISSION.test(value.id) || !STATUSES.has(value.status) || value.request_id !== claim.request.request_id || value.conversation_id !== claim.request.conversation_id) throw new Error('Schedule mission does not match the committed claim.');
    return value;
  }
  async function resolve(claim) {
    const result = await rpc({ command: 'schedule_resolve', request_id: claim.request.request_id });
    return missionChecked(result.mission, claim, true);
  }
  async function complete(claim, mission) {
    if (!TERMINAL.has(mission.status)) throw new Error('Only actual terminal Work can complete a schedule.');
    update({ phase: 'reconciling', mission_id: mission.id });
    const result = await rpc({ command: 'schedule_complete', schedule_id: claim.schedule.id, mission_id: mission.id });
    if (result.schedule?.id !== claim.schedule.id || result.mission_status !== mission.status || typeof result.replayed !== 'boolean') throw new Error('Schedule completion returned an invalid receipt.');
    update({ phase: 'idle', error: null, last_result: { schedule_id: claim.schedule.id, mission_id: mission.id, mission_status: result.mission_status, replayed: result.replayed } });
    return result;
  }
  async function cancel(requestId) {
    if (!UUID.test(requestId)) return { ok: false, error: failure(new Error('Schedule cancellation requires an exact request UUID.')) };
    const operation = active;
    if (!operation || operation.claim.request.request_id !== requestId) return { ok: true, result: { cancelled: false } };
    operation.cancelRequested = true;
    if (operation.cancelPromise) return operation.cancelPromise;
    operation.cancelPromise = (async () => {
      let result, error, local;
      try { result = await rpc({ command: 'schedule_cancel_request', schedule_id: operation.claim.schedule.id, request_id: requestId }); missionChecked(result.mission, operation.claim); }
      catch (value) { error = value; }
      // Abort the exact locally owned transport after the canonical cancellation
      // request. This closes an in-flight provider socket without broad kills.
      try { local = await workTransport.cancel(requestId, owner); }
      catch (value) { error ||= value; }
      if (!result?.mission && local?.ok && local.result?.mission) { try { result = { mission: missionChecked(local.result.mission, operation.claim) }; error = null; } catch (value) { error = value; } }
      if (error || !result?.mission) {
        const detail = failure(error || local?.error || new Error('Schedule cancellation was not confirmed.'));
        update({ error: detail, phase: 'error' }); return { ok: false, error: detail };
      }
      return { ok: true, result: { cancelled: result.mission.status === 'cancelled', mission: result.mission } };
    })();
    return operation.cancelPromise;
  }
  async function dispatch(claim, reserveStart) {
    const operation = { claim, cancelRequested: false, cancelPromise: null };
    active = operation;
    update({ phase: 'resolving', active_schedule_id: claim.schedule.id, request_id: claim.request.request_id, mission_id: null });
    try {
      let mission = await resolve(claim);
      if (mission && TERMINAL.has(mission.status)) { await complete(claim, mission); return false; }
      if (!claim.schedule.enabled || operation.cancelRequested || !current.enabled) {
        const cancelled = await cancel(claim.request.request_id);
        if (!cancelled.ok) throw cancelled.error;
        mission = await resolve(claim);
        if (mission && TERMINAL.has(mission.status)) await complete(claim, mission);
        else throw new Error('Cancelled schedule has no terminal Work receipt yet.');
        return false;
      }
      if (mission?.status === 'awaiting_approval') { update({ phase: 'awaiting_review', mission_id: mission.id }); return false; }
      if (!reserveStart()) return false;
      update({ phase: 'running', mission_id: mission?.id || null, error: null });
      let response;
      try { response = await workTransport.start(claim.request, owner); }
      catch (error) { response = { ok: false, error: failure(error) }; }
      if (operation.cancelPromise) await operation.cancelPromise;
      // Resolve even a failed/lost start response: acceptance may already have
      // committed. A transport error is never itself a completed schedule run.
      mission = await resolve(claim);
      if (mission && TERMINAL.has(mission.status)) await complete(claim, mission);
      else if (mission?.status === 'awaiting_approval') update({ phase: 'awaiting_review', mission_id: mission.id });
      else if (mission) update({ phase: response?.ok ? 'running' : 'error', mission_id: mission.id, error: response?.ok ? null : failure(response?.error) });
      else if (!response?.ok && response?.error?.code === 'BUSY') {
        // Capacity is temporary, not a rejected schedule or completed run.
        // Keep the exact committed claim for the next ordinary dispatcher tick.
        update({ phase: 'waiting', mission_id: null, error: failure(response.error) });
      }
      else if (!response?.ok) {
        const error = failure(response?.error);
        const result = await rpc({ command: 'schedule_dispatch_error', schedule_id: claim.schedule.id, request_id: claim.request.request_id, error: error.message });
        if (result.schedule?.id !== claim.schedule.id) throw new Error('Schedule dispatch error returned a mismatched document.');
        update({ phase: 'error', error });
      } else throw new Error('Work accepted the request but its committed mission could not be resolved.');
      return true;
    } finally {
      if (active === operation) active = null;
      update({ active_schedule_id: null, request_id: null });
    }
  }
  function wake() {
    if (!current.enabled) return Promise.resolve(status());
    if (flight) return flight;
    clearTick(); update({ running: true, phase: 'claiming' });
    flight = (async () => {
      try {
        const result = await rpc({ command: 'schedule_claim' });
        if (!Array.isArray(result.claims) || result.claims.length > 20) throw new Error('Schedule claim response exceeds its bounded batch.');
        const claims = result.claims.map(claimChecked);
        if (new Set(claims.map(item => item.schedule.id)).size !== claims.length || new Set(claims.map(item => item.request.request_id)).size !== claims.length) throw new Error('Schedule claims contain duplicate identities.');
        let started = false;
        if (!claims.length) update({ phase: 'idle' });
        for (const claim of claims) {
          if (!current.enabled) break;
          try { await dispatch(claim, () => { if (started) return false; started = true; return true; }); }
          catch (error) { update({ phase: 'error', error: { ...failure(error), schedule_id: claim.schedule.id, request_id: claim.request.request_id } }); }
        }
      } catch (error) { update({ phase: 'error', error: failure(error) }); }
      finally {
        flight = null; current.running = false;
        if (!current.enabled) current.phase = 'stopped';
        else if (['claiming', 'resolving'].includes(current.phase)) current.phase = current.error ? 'error' : 'idle';
        nextTick(); publish();
      }
      return status();
    })();
    return flight;
  }
  function start() {
    if (!current.enabled) { current.enabled = true; update({ phase: 'idle' }); void wake(); }
    return status();
  }
  async function stop() {
    current.enabled = false; clearTick(); publish();
    if (active) await cancel(active.claim.request.request_id);
    if (flight) await flight;
    update({ phase: 'stopped', running: false }); return status();
  }
  function cancelActive(requestId) {
    if (requestId === undefined && !active) return Promise.resolve({ ok: true, result: { cancelled: false } });
    return cancel(requestId === undefined ? active.claim.request.request_id : requestId);
  }
  return Object.freeze({ start, stop, wake, cancel, cancelActive, status });
}

module.exports = { createScheduleDispatcher };
