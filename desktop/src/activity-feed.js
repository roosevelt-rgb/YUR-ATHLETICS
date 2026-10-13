'use strict';

// Ephemeral host observations only. This module never executes work, inspects
// user content, writes a journal, or changes canonical lifecycle authority.
const { randomUUID } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MID = /^[0-9a-f]{32}$/;
const TOOL = /^[a-z][a-z0-9_]{0,79}$/;
const MAX_RUNS = 64, MAX_EVENTS = 80, MAX_TOOLS = 20;
const PHASES = Object.freeze({
  queued: ['queued', 'Waiting for the Work runtime', 'lifecycle'],
  dispatching: ['running', 'Starting the Work runtime', 'lifecycle'],
  accepted: ['running', 'Work request accepted', 'status'],
  working: ['running', 'Work runtime active', 'status'],
  worker_waiting: ['queued', 'Waiting for the existing factory worker', 'status'],
  model_running: ['running', 'Waiting for model response', 'model'],
  model_completed: ['running', 'Model response received', 'model'],
  model_failed: ['running', 'Model request failed; checking outcome', 'model'],
  checking_vision: ['running', 'Checking model image support', 'status'],
  streaming: ['running', 'Receiving response text', 'output'],
  tool_running: ['running', 'Tool requested; checking or executing', 'tool'],
  tool_completed: ['running', 'Tool result committed', 'tool'],
  tool_rejected: ['running', 'Tool rejected', 'tool'],
  runtime_progress: ['running', 'Execution progress received', 'status'],
  resource_verified: ['running', 'Restricted execution resource verified', 'status'],
  checks_running: ['running', 'Running staged Python checks in the isolated cell', 'status'],
  checks_output: ['running', 'Execution cell output captured', 'status'],
  checks_completed: ['running', 'Isolated execution checks completed', 'status'],
  checks_failed: ['running', 'Isolated execution checks failed', 'status'],
  checks_timeout: ['running', 'Isolated execution checks timed out', 'status'],
  checks_output_limit: ['running', 'Isolated execution reached its output limit', 'status'],
  checks_cancelled: ['running', 'Isolated execution check cancellation observed', 'status'],
  candidate_direct: ['running', 'Generating direct specialist candidate', 'status'],
  candidate_decomposed: ['running', 'Generating decomposed specialist candidate', 'status'],
  correction_queued: ['running', 'Correction queued', 'correction'],
  correction_consumed: ['running', 'Correction applied at a checkpoint', 'correction'],
  correction_not_consumed: ['running', 'Correction was not consumed', 'correction'],
  completing: ['running', 'Result received; waiting for runtime close', 'lifecycle'],
  stopping: ['stopping', 'Stop requested; waiting for confirmation', 'lifecycle'],
  process_closed: [null, 'Work process closed', 'lifecycle'],
  completed: ['completed', 'Completed', 'lifecycle'],
  failed: ['failed', 'Request failed', 'lifecycle'],
  failed_cancelled: ['failed', 'Request failed; cancellation confirmed', 'lifecycle'],
  cancelled: ['cancelled', 'Cancellation confirmed', 'lifecycle'],
  awaiting_approval: ['awaiting_approval', 'Waiting for operator review', 'lifecycle'],
  unconfirmed: ['unconfirmed', 'Stopped or interrupted; final outcome unconfirmed', 'lifecycle'],
  factory_running: ['running', 'Specialist factory request active', 'lifecycle'],
});
const FINAL = new Set(['completed', 'failed', 'failed_cancelled', 'cancelled', 'awaiting_approval', 'unconfirmed']);
const kinds = new Set(['chat', 'work', 'code', 'factory']);
const origins = new Set(['conversation', 'schedule', 'factory']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullable = (value, pattern) => value === null || (typeof value === 'string' && pattern.test(value));
const metadata = (value, limit) => value === null || (typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value));
const copy = value => JSON.parse(JSON.stringify(value));

function createActivityFeed({ onChange = () => {}, now = Date.now, sessionId = randomUUID() } = {}) {
  if (typeof onChange !== 'function' || typeof now !== 'function' || !UUID.test(sessionId)) throw new Error('Activity observation requires a host session and clock.');
  const runs = new Map();
  let sequence = 0, omittedRuns = 0, clock = 0;
  function timestamp() { const value = now(); if (!Number.isFinite(value)) throw new Error('Invalid activity clock.'); clock = Math.max(clock, value); return new Date(clock).toISOString(); }
  function snapshot() {
    return { schema: 'yur.activity.v1', session_id: sessionId, sequence, observed_at: timestamp(),
      runs: [...runs.values()].reverse().map(copy), omitted_runs: omittedRuns };
  }
  function publish() { try { onChange(snapshot()); } catch { /* Observers do not own execution. */ } }
  function observe(event) {
    if (!object(event) || !UUID.test(event.id || '') || !['begin', 'update', 'finish'].includes(event.type)) return false;
    const allowed = event.type === 'begin'
      ? ['type', 'id', 'kind', 'origin', 'conversation_id', 'provider', 'model', 'phase']
      : ['type', 'id', 'phase', 'mission_id', 'output_chars', 'tool', 'step_id'];
    if (Object.keys(event).some(key => !allowed.includes(key)) || !Object.hasOwn(PHASES, event.phase)) return false;
    if (event.type === 'finish' && !FINAL.has(event.phase)) return false;
    if (event.type === 'update' && FINAL.has(event.phase) && event.phase !== 'unconfirmed') return false;
    if (event.mission_id !== undefined && !nullable(event.mission_id, MID)) return false;
    if (event.step_id !== undefined && !nullable(event.step_id, MID)) return false;
    if (event.output_chars !== undefined && (!Number.isSafeInteger(event.output_chars) || event.output_chars < 0 || event.output_chars > 1e9)) return false;
    if (event.tool !== undefined && (!object(event.tool) || Object.keys(event.tool).sort().join(',') !== 'id,name,status'
      || !MID.test(event.tool.id || '') || !TOOL.test(event.tool.name || '') || !['running', 'completed', 'rejected'].includes(event.tool.status))) return false;
    let run = runs.get(event.id);
    if (event.type === 'begin') {
      if (!kinds.has(event.kind) || !origins.has(event.origin) || !nullable(event.conversation_id, UUID)
          || !metadata(event.provider, 64) || !metadata(event.model, 256)
          || !['queued', 'dispatching', 'model_running', 'factory_running'].includes(event.phase)) return false;
      if (run?.request_active) return false;
      if (!run && runs.size >= MAX_RUNS) {
        const removable = [...runs.values()].find(item => !item.request_active);
        if (!removable) { omittedRuns++; sequence++; publish(); return false; }
        runs.delete(removable.id); omittedRuns++;
      }
      const at = timestamp();
      run = { id: event.id, kind: event.kind, origin: event.origin, conversation_id: event.conversation_id, mission_id: null,
        label: event.kind === 'factory' ? 'Specialist factory request' : event.kind[0].toUpperCase() + event.kind.slice(1) + ' request',
        provider: event.provider, model: event.model, status: PHASES[event.phase][0], phase: PHASES[event.phase][1],
        started_at: at, updated_at: at, ended_at: null, request_active: true, output_chars: 0,
        tools: [], events: [], omitted_events: 0 };
      runs.delete(event.id); runs.set(event.id, run);
    } else if (!run || !run.request_active) return false;
    if (event.mission_id && run.mission_id && event.mission_id !== run.mission_id) return false;
    if (event.output_chars !== undefined && event.output_chars < run.output_chars) return false;
    const priorPhase = run.phase, priorChars = run.output_chars;
    const [status, phase, kind] = PHASES[event.phase];
    const at = timestamp(); sequence++;
    if (event.mission_id) run.mission_id = event.mission_id;
    if (event.output_chars !== undefined) run.output_chars = event.output_chars;
    if (event.tool) {
      const prior = run.tools.find(item => item.id === event.tool.id);
      if (prior) { if (prior.name === event.tool.name) prior.status = event.tool.status; }
      else if (run.tools.length < MAX_TOOLS) run.tools.push(copy(event.tool));
    }
    if (event.type === 'finish') { run.request_active = false; run.ended_at = at; }
    // Late progress may be observed while Stop is pending; it cannot reopen the
    // operation or replace the truthful stopping state before final confirmation.
    if (event.type === 'finish' || run.status !== 'stopping') {
      if (status) run.status = status;
      if (event.phase !== 'process_closed') run.phase = phase;
    }
    run.updated_at = at;
    if (event.phase !== 'streaming' || priorChars === 0) {
      const stepId = event.tool?.id || event.step_id || null;
      const label = event.tool ? `${phase}: ${event.tool.name}` : phase;
      if (event.type !== 'update' || priorPhase !== phase || stepId || event.phase === 'process_closed') {
        run.events.push({ sequence, at, kind, label: label.slice(0, 160), step_id: stepId });
        if (run.events.length > MAX_EVENTS) { run.events.shift(); run.omitted_events++; }
      }
    }
    publish(); return true;
  }
  return Object.freeze({ observe, snapshot });
}

module.exports = { createActivityFeed, MAX_RUNS, MAX_EVENTS, MAX_TOOLS, PHASES };
