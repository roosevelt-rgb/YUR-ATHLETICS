'use strict';

// Fixed local RPC transport. Orchestration and every durable transition belong
// to the Python OrchestrationManager/CommitService, never this process adapter.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { normalizeFoundryUrl } = require('./foundry-transport');
const { validateSource, validateAcquisition, validateContext, canonical } = require('./work-browser-broker');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSION = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_INPUT_BYTES = 256 * 1024 + 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TIME_MS = 10 * 60 * 1000;
const MAX_WORK_STEPS = 128;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => ({ ok: false, error: { code, message } });
const scheduleFields = {
  schedule_list: 'command', schedule_claim: 'command',
  schedule_save: 'command,document,expected_revision', schedule_events: 'before_id,command,schedule_id',
  schedule_resolve: 'command,request_id', schedule_complete: 'command,mission_id,schedule_id',
  schedule_dispatch_error: 'command,error,request_id,schedule_id', schedule_cancel_request: 'command,request_id,schedule_id',
};
// Deployed agent lifecycles (cron / interval / once / continuous / manual).
const lifecycleFields = {
  lifecycle_list: 'command', lifecycle_claim: 'command', lifecycle_runner: 'command',
  lifecycle_deploy: 'command,spec', lifecycle_preview: 'command,trigger',
  lifecycle_update: 'changes,command,deployment_id,expected_revision',
  lifecycle_state: 'command,deployment_id,expected_revision,state',
  lifecycle_run_now: 'command,deployment_id,expected_revision',
  lifecycle_events: 'before_id,command,deployment_id',
  lifecycle_resolve: 'command,request_id', lifecycle_complete: 'command,deployment_id,mission_id',
  lifecycle_dispatch_error: 'command,deployment_id,error,request_id', lifecycle_cancel_request: 'command,deployment_id,request_id',
};
function validateLifecycleRpc(value, keys) {
  if (keys !== lifecycleFields[value.command]) throw new Error('Invalid lifecycle command fields.');
  if (['deployment_id', 'request_id'].some(key => key in value && (typeof value[key] !== 'string' || !UUID.test(value[key])))) throw new Error('Invalid lifecycle identifiers.');
  if ('mission_id' in value && !MISSION.test(value.mission_id)) throw new Error('Invalid lifecycle mission.');
  if ('expected_revision' in value && (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 1)) throw new Error('Lifecycle changes require a current revision.');
  if ('before_id' in value && value.before_id !== null && (!Number.isSafeInteger(value.before_id) || value.before_id < 1)) throw new Error('Invalid lifecycle cursor.');
  if ('state' in value && !['active', 'paused', 'retired'].includes(value.state)) throw new Error('Invalid lifecycle state.');
  if ('error' in value && (typeof value.error !== 'string' || !value.error.length || value.error.length > 2000)) throw new Error('Invalid dispatch error.');
  for (const key of ['spec', 'changes', 'trigger']) if (key in value && !object(value[key])) throw new Error(`Lifecycle ${key} must be an object.`);
}
function validateLifecycleResult(value, result) {
  if (value.command === 'lifecycle_list' && (!Array.isArray(result.deployments) || result.deployments.length > 500)) throw new Error('Invalid deployment list.');
  if (value.command === 'lifecycle_claim') {
    if (!Array.isArray(result.claims) || result.claims.length > 20) throw new Error('Invalid lifecycle claims.');
    for (const claim of result.claims) {
      validateWorkRequest(claim.request);
      if (!object(claim.deployment) || !UUID.test(claim.deployment.id) || typeof claim.replayed !== 'boolean' || claim.deployment.active_request_id !== claim.request.request_id || claim.deployment.conversation_id !== claim.request.conversation_id) throw new Error('Lifecycle claim identity mismatch.');
    }
  }
  if (value.command === 'lifecycle_events' && (!Array.isArray(result.events) || result.events.length > 100 || result.events.some(event => event.deployment_id !== value.deployment_id))) throw new Error('Invalid lifecycle events.');
  if (['lifecycle_update', 'lifecycle_state', 'lifecycle_run_now', 'lifecycle_complete', 'lifecycle_dispatch_error'].includes(value.command) && (!object(result.deployment) || result.deployment.id !== value.deployment_id)) throw new Error('Lifecycle response identity mismatch.');
  if (value.command === 'lifecycle_deploy' && (!object(result.deployment) || !UUID.test(result.deployment.id))) throw new Error('Lifecycle deployment response is invalid.');
  if (['lifecycle_resolve', 'lifecycle_cancel_request'].includes(value.command) && (result.mission !== null || value.command === 'lifecycle_cancel_request') && (!object(result.mission) || result.mission.request_id !== value.request_id || !MISSION.test(result.mission.id) || !['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(result.mission.status))) throw new Error('Lifecycle Work identity mismatch.');
}

// Ship gate, Pulse intake and the Organism view (read-only probes; verdicts derived in Python).
const organismFields = {
  ship_list: 'command', organism_status: 'command',
  ship_create: 'command,spec', ship_state: 'candidate_id,command,expected_revision,state',
  ship_check_now: 'candidate_id,command', ship_events: 'candidate_id,command', pulse_intake: 'command,mutation',
};
function validateOrganismRpc(value, keys) {
  if (keys !== organismFields[value.command]) throw new Error('Invalid organism command fields.');
  if ('candidate_id' in value && (typeof value.candidate_id !== 'string' || !UUID.test(value.candidate_id))) throw new Error('Invalid ship candidate identifier.');
  if ('expected_revision' in value && (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 1)) throw new Error('Ship changes require a current revision.');
  if ('state' in value && !['active', 'paused', 'retired'].includes(value.state)) throw new Error('Invalid ship candidate state.');
  for (const key of ['spec', 'mutation']) if (key in value && !object(value[key])) throw new Error(`Organism ${key} must be an object.`);
}
function validateOrganismResult(value, result) {
  const verdict = item => object(item) && UUID.test(item.id) && ['', 'PASS', 'DEBT'].includes(item.last_verdict);
  if (value.command === 'ship_list' && (!Array.isArray(result.candidates) || result.candidates.length > 200 || !result.candidates.every(verdict))) throw new Error('Invalid ship candidate list.');
  if (['ship_create', 'ship_state'].includes(value.command) && (!verdict(result.candidate) || (value.candidate_id && result.candidate.id !== value.candidate_id))) throw new Error('Ship candidate response identity mismatch.');
  if (value.command === 'ship_check_now' && (!verdict(result.candidate) || result.candidate.id !== value.candidate_id || ![null, 'PASS', 'DEBT'].includes(result.verdict))) throw new Error('Invalid ship check result.');
  if (value.command === 'ship_events' && (!Array.isArray(result.events) || result.events.length > 100 || result.events.some(event => event.candidate_id !== value.candidate_id))) throw new Error('Invalid ship events.');
  if (value.command === 'pulse_intake' && (!object(result.mission) || !['run_deployment', 'check_candidate', 'proposed_mission'].includes(result.routed))) throw new Error('Invalid Pulse intake result.');
  if (value.command === 'organism_status' && (!object(result.deployments) || !object(result.ship) || !Array.isArray(result.recent) || !object(result.runner) || !object(result.providers))) throw new Error('Invalid Organism status.');
}

function validateScheduleResult(value, result) {
  if (value.command === 'schedule_list' && (!Array.isArray(result.schedules) || result.schedules.length > 100)) throw new Error('Invalid schedule list.');
  if (value.command === 'schedule_claim') {
    if (!Array.isArray(result.claims) || result.claims.length > 20) throw new Error('Invalid schedule claims.');
    for (const claim of result.claims) {
      validateWorkRequest(claim.request);
      if (!object(claim.schedule) || !UUID.test(claim.schedule.id) || typeof claim.schedule.enabled !== 'boolean' || typeof claim.replayed !== 'boolean' || claim.schedule.active_request_id !== claim.request.request_id || claim.schedule.conversation_id !== claim.request.conversation_id) throw new Error('Schedule claim identity mismatch.');
    }
  }
  if (value.command === 'schedule_events' && (!Array.isArray(result.events) || result.events.length > 100 || result.events.some(event => event.schedule_id !== value.schedule_id))) throw new Error('Invalid schedule events.');
  if (['schedule_save', 'schedule_complete', 'schedule_dispatch_error'].includes(value.command) && (!object(result.schedule) || result.schedule.id !== (value.schedule_id || value.document.id))) throw new Error('Schedule response identity mismatch.');
  if (['schedule_resolve', 'schedule_cancel_request'].includes(value.command) && (result.mission !== null || value.command === 'schedule_cancel_request') && (!object(result.mission) || result.mission.request_id !== value.request_id || !MISSION.test(result.mission.id) || !['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(result.mission.status))) throw new Error('Schedule Work identity mismatch.');
}

function validateWorkRequest(value) {
  if (!object(value) || !['conversation_id,goal,messages,mode,model,provider,request_id,root', 'browser_source,conversation_id,goal,messages,mode,model,provider,request_id,root'].includes(Object.keys(value).sort().join(','))) throw new Error('Work requires the fixed request fields.');
  if (Object.hasOwn(value, 'browser_source')) validateSource(value.browser_source);
  if (!UUID.test(value.request_id) || !UUID.test(value.conversation_id)) throw new Error('Work identifiers must be canonical UUIDs.');
  if (!['work', 'code'].includes(value.mode) || !['ollama', 'foundry'].includes(value.provider)) throw new Error('Select a Work mode and provider.');
  if (typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > 32000 || typeof value.model !== 'string' || value.model.length > 256) throw new Error('Work goal or model exceeds its limits.');
  if (value.root !== null && (typeof value.root !== 'string' || !path.isAbsolute(value.root) || value.root.length > 4096 || value.root.includes('\0'))) throw new Error('Work requires a selected absolute folder or null.');
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 80 || value.messages.some(message => !object(message) || Object.keys(message).sort().join(',') !== 'content,role' || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) throw new Error('Work context requires 1..80 text messages.');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error('Work context exceeds 256 KiB.');
  return JSON.parse(encoded);
}

function validateSteerRequest(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'conversation_id,correction_id,mission_id,text') throw new Error('Steering requires exact mission, conversation, correction and text fields.');
  if (typeof value.mission_id !== 'string' || !MISSION.test(value.mission_id) || typeof value.conversation_id !== 'string' || !UUID.test(value.conversation_id) || typeof value.correction_id !== 'string' || !UUID.test(value.correction_id)) throw new Error('Steering identifiers are invalid.');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)) throw new Error('A correction requires 1..8000 characters of text.');
  return JSON.parse(JSON.stringify(value));
}

function validSteeringReceipt(receipt) {
  return object(receipt) && Object.keys(receipt).sort().join(',') === 'hash,revision' && typeof receipt.hash === 'string' && HASH.test(receipt.hash) && Number.isSafeInteger(receipt.revision) && receipt.revision > 0;
}

function validateSteerResult(value, result, operation) {
  if (!operation || !object(result) || Object.keys(result).sort().join(',') !== 'conversation_id,correction,mission_id,request_id,revision' || result.mission_id !== value.mission_id || result.mission_id !== operation.missionId || result.conversation_id !== value.conversation_id || result.conversation_id !== operation.request.conversation_id || result.request_id !== operation.request.request_id || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('Steering result identity mismatch.');
  const correction = result.correction;
  if (!object(correction) || Object.keys(correction).sort().join(',') !== 'consumed_receipt,correction_id,queued_receipt,status,text' || correction.correction_id !== value.correction_id || correction.text !== value.text || !['queued', 'consumed', 'not_consumed'].includes(correction.status) || !validSteeringReceipt(correction.queued_receipt) || correction.queued_receipt.revision > result.revision) throw new Error('Invalid committed correction.');
  if (correction.status === 'consumed') {
    if (!validSteeringReceipt(correction.consumed_receipt) || correction.consumed_receipt.revision <= correction.queued_receipt.revision || correction.consumed_receipt.revision > result.revision) throw new Error('Invalid consumed correction receipt.');
  } else if (correction.consumed_receipt !== null) throw new Error('An unconsumed correction cannot contain a consumption receipt.');
}

const CONCEPT_STAGES = ['genesis', 'inception', 'development', 'stabilization', 'maturation', 'monetization', 'regeneration', 'evolution'];
const CONCEPT_EVENTS = ['concept.created', 'concept.version.bound', 'concept.evidence.added', 'concept.transitioned', 'concept.transition.denied'];
const exactFields = (value, fields) => object(value) && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
const boundedInt = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const matches = (value, expression) => typeof value === 'string' && expression.test(value);
const conceptText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const conceptTime = value => typeof value === 'string' && value.length <= 64 && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
function validConceptBase(value) {
  return object(value) && matches(value.id, UUID) && conceptText(value.name, 160) && CONCEPT_STAGES.includes(value.stage)
    && (value.parent_id === null || matches(value.parent_id, UUID)) && boundedInt(value.revision, 1, 128)
    && conceptTime(value.created_at) && conceptTime(value.updated_at) && Date.parse(value.created_at) <= Date.parse(value.updated_at)
    && Array.isArray(value.domain_tags) && value.domain_tags.length >= 1 && value.domain_tags.length <= 8
    && value.domain_tags.every(tag => conceptText(tag, 40)) && new Set(value.domain_tags).size === value.domain_tags.length;
}
function validConceptReceipt(receipt, conceptId) {
  return exactFields(receipt, 'id,concept_id,revision,event_type,hash,previous_hash,created_at')
    && receipt.concept_id === conceptId && boundedInt(receipt.id, 1, Number.MAX_SAFE_INTEGER)
    && boundedInt(receipt.revision, 1, 128) && CONCEPT_EVENTS.includes(receipt.event_type)
    && matches(receipt.hash, HASH) && matches(receipt.previous_hash, HASH) && conceptTime(receipt.created_at);
}
function validateConceptResult(request, result) {
  const reject = () => { throw new Error('Invalid Concept view or receipt identity.'); };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) reject();
  if (request.command === 'concept_list') {
    if (!exactFields(result, 'concepts,next_cursor,total') || !Array.isArray(result.concepts)
        || result.concepts.length > request.limit || !boundedInt(result.total, result.concepts.length, 100)
        || (result.next_cursor !== null && (!matches(result.next_cursor, UUID) || result.next_cursor !== result.concepts.at(-1)?.id || result.concepts.length !== request.limit))) reject();
    let previous = request.cursor;
    for (const item of result.concepts) {
      if (!exactFields(item, 'id,name,domain_tags,stage,parent_id,created_at,updated_at,revision,version_count,evidence_count')
          || !validConceptBase(item) || !boundedInt(item.version_count, 0, 16) || !boundedInt(item.evidence_count, 0, 32)
          || (previous !== null && item.id <= previous)) reject();
      previous = item.id;
    }
    return;
  }
  if (!exactFields(result, 'concept,events,history')) reject();
  const item = result.concept;
  if (!exactFields(item, 'id,name,domain_tags,thesis_statement,stage,parent_id,lineage,created_at,updated_at,versions,evidence,revision,history_hash,receipt')
      || !validConceptBase(item) || item.id !== request.concept_id || !conceptText(item.thesis_statement, 8000)
      || !matches(item.history_hash, HASH) || !validConceptReceipt(item.receipt, item.id)
      || item.receipt.hash !== item.history_hash || item.receipt.revision !== item.revision
      || item.receipt.created_at !== item.updated_at || !Array.isArray(item.lineage) || item.lineage.length > 64
      || item.lineage.some(id => !matches(id, UUID) || id === item.id) || new Set(item.lineage).size !== item.lineage.length
      || (item.parent_id === null ? item.lineage.length !== 0 : item.lineage.at(-1) !== item.parent_id)
      || !Array.isArray(item.versions) || item.versions.length > 16 || !Array.isArray(item.evidence) || item.evidence.length > 32) reject();
  const versions = new Map(), builds = new Set(), artifacts = new Set();
  for (const [index, version] of item.versions.entries()) {
    const generated = version?.kind === 'generated_python';
    const fields = generated ? 'kind,id,ordinal,parent_version_id,created_at,source_work_id,build_step_index,artifact_sha256,source_sha256,contract_sha256,driver_sha256,runtime_sha256,acceptance_cohort_sha256,evidence_verifier,validation_receipt_hash,artifact_receipt_hash'
      : 'id,ordinal,parent_version_id,build_mission_id,artifact_sha256,runtime_sha256,validation_receipt_hash,artifact_receipt_hash,created_at';
    const buildKey = generated ? `generated:${version.source_work_id}:${version.build_step_index}` : `legacy:${version?.build_mission_id}`;
    if (!exactFields(version, fields)
        || !matches(version.id, UUID) || versions.has(version.id) || version.ordinal !== index + 1
        || (index === 0 ? version.parent_version_id !== null : !versions.has(version.parent_version_id))
        || (generated ? !matches(version.source_work_id, MISSION) || !boundedInt(version.build_step_index, 0, MAX_WORK_STEPS - 1)
          || !['yur.generated-evidence.v1', 'yur.generated-evidence.v2'].includes(version.evidence_verifier)
          || (version.evidence_verifier === 'yur.generated-evidence.v1' && version.build_step_index >= 20)
          || ['source_sha256', 'contract_sha256', 'driver_sha256', 'acceptance_cohort_sha256'].some(key => !matches(version[key], HASH))
          : !matches(version.build_mission_id, MISSION))
        || builds.has(buildKey)
        || ['artifact_sha256', 'runtime_sha256', 'validation_receipt_hash', 'artifact_receipt_hash'].some(key => !matches(version[key], HASH))
        || artifacts.has(version.artifact_sha256) || !conceptTime(version.created_at)) reject();
    versions.set(version.id, version); builds.add(buildKey); artifacts.add(version.artifact_sha256);
  }
  const evidenceIds = new Set();
  for (const evidence of item.evidence) {
    if (!exactFields(evidence, 'id,requirement,source,artifact_id,artifact_sha256,receipt_hash,created_at')
        || !matches(evidence.id, UUID) || evidenceIds.has(evidence.id) || !conceptText(evidence.requirement, 80)
        || !conceptText(evidence.artifact_id, 200) || !matches(evidence.artifact_sha256, HASH)
        || !matches(evidence.receipt_hash, HASH) || !conceptTime(evidence.created_at) || !object(evidence.source)) reject();
    const source = evidence.source;
    const fields = { concept_intent: 'kind', work_artifact: 'kind,mission_id,artifact_id', specialist_build: 'kind,version_id', specialist_execution: 'kind,version_id,run_id',
      generated_build: 'kind,version_id', generated_execution: 'kind,version_id,execution_work_id,execution_step_index' };
    if (!Object.hasOwn(fields, source.kind) || !exactFields(source, fields[source.kind])
        || ['mission_id', 'artifact_id', 'run_id', 'execution_work_id'].some(key => key in source && !matches(source[key], MISSION))
        || ('execution_step_index' in source && !boundedInt(source.execution_step_index, 0, MAX_WORK_STEPS - 1))
        || ('version_id' in source && !versions.has(source.version_id))) reject();
    if ('version_id' in source) {
      const version = versions.get(source.version_id), generated = version.kind === 'generated_python';
      if (generated !== ['generated_build', 'generated_execution'].includes(source.kind)
          || (generated && (evidence.artifact_id !== version.id || evidence.artifact_sha256 !== version.artifact_sha256))) reject();
    }
    evidenceIds.add(evidence.id);
  }
  const history = result.history, from = Math.max(1, item.revision - 19);
  if (!exactFields(history, 'from_revision,through_revision,omitted_before') || history.from_revision !== from
      || history.through_revision !== item.revision || history.omitted_before !== from - 1
      || !Array.isArray(result.events) || result.events.length !== item.revision - from + 1) reject();
  let previous = null;
  for (const [index, event] of result.events.entries()) {
    if (!exactFields(event, 'id,concept_id,revision,event_type,hash,previous_hash,created_at,operation_id,stage,request_hash,decision')) reject();
    const { operation_id: operationId, stage, request_hash: requestHash, decision, ...receipt } = event;
    if (!validConceptReceipt(receipt, item.id) || receipt.revision !== from + index || !matches(operationId, UUID)
        || !matches(requestHash, HASH) || !CONCEPT_STAGES.includes(stage)
        // Receipts share a global Concept chain; other identities may occur
        // between this concept's revisions. The store verifies the full chain.
        || (previous && (event.id <= previous.id || (event.id === previous.id + 1 && event.previous_hash !== previous.hash)))
        || (event.id === 1 && event.previous_hash !== '0'.repeat(64))) reject();
    if (['concept.transitioned', 'concept.transition.denied'].includes(event.event_type)) {
      if (!exactFields(decision, 'allowed,from_stage,to_stage,missing,errors,requirements') || typeof decision.allowed !== 'boolean'
          || decision.allowed !== (event.event_type === 'concept.transitioned')
          || !CONCEPT_STAGES.includes(decision.from_stage) || !CONCEPT_STAGES.includes(decision.to_stage)
          || stage !== (decision.allowed ? decision.to_stage : decision.from_stage)
          || !Array.isArray(decision.missing) || decision.missing.length > 24
          || decision.missing.some(gap => !exactFields(gap, 'requirement,reason') || !conceptText(gap.requirement, 80) || !conceptText(gap.reason, 2000))
          || !Array.isArray(decision.errors) || decision.errors.length > 24 || decision.errors.some(text => !conceptText(text, 2000))
          || !Array.isArray(decision.requirements) || decision.requirements.length > 24 || decision.requirements.some(text => !conceptText(text, 80))) reject();
    } else if (decision !== null) reject();
    previous = event;
  }
  if (previous.stage !== item.stage || Object.entries(item.receipt).some(([key, value]) => previous[key] !== value)) reject();
}

function validateRpc(value, internal = false) {
  if (!object(value)) throw new Error('Invalid Work command.');
  const keys = Object.keys(value).sort().join(',');
  if (Object.hasOwn(scheduleFields, value.command)) {
    if (keys !== scheduleFields[value.command]) throw new Error('Invalid schedule command fields.');
    if (['schedule_id', 'request_id'].some(key => key in value && (typeof value[key] !== 'string' || !UUID.test(value[key])))) throw new Error('Invalid schedule identifiers.');
    if ('mission_id' in value && !MISSION.test(value.mission_id)) throw new Error('Invalid schedule mission.');
    if (value.command === 'schedule_save' && (!object(value.document) || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0)) throw new Error('Schedule requires a document and expected revision.');
    if ('before_id' in value && value.before_id !== null && (!Number.isSafeInteger(value.before_id) || value.before_id < 1)) throw new Error('Invalid schedule cursor.');
    if ('error' in value && (typeof value.error !== 'string' || !value.error.length || value.error.length > 2000)) throw new Error('Invalid dispatch error.');
  } else if (Object.hasOwn(lifecycleFields, value.command)) {
    validateLifecycleRpc(value, keys);
  } else if (Object.hasOwn(organismFields, value.command)) {
    validateOrganismRpc(value, keys);
  } else if (value.command === 'concept_list') {
    if (keys !== 'command,cursor,limit' || !boundedInt(value.limit, 1, 20) || (value.cursor !== null && !matches(value.cursor, UUID))) throw new Error('Concept discovery requires a bounded page and UUID cursor.');
  } else if (value.command === 'concept_inspect') {
    if (keys !== 'command,concept_id' || !matches(value.concept_id, UUID)) throw new Error('Concept inspection requires an exact UUID.');
  } else if (internal && value.command === 'steer') {
    if (keys !== 'command,conversation_id,correction_id,mission_id,text') throw new Error('Invalid steering command fields.');
    const { command: _command, ...request } = value;
    validateSteerRequest(request);
  } else if (internal && ['start', 'cancel_request'].includes(value.command)) {
    if (keys !== 'command,request') throw new Error('Invalid Work start fields.');
    validateWorkRequest(value.request);
  } else if (value.command === 'list') {
    if (keys !== 'command,conversation_id' || (value.conversation_id !== null && !UUID.test(value.conversation_id))) throw new Error('Work list requires a conversation UUID or null.');
  } else if (value.command === 'list_saved_specialists') {
    if (keys !== 'command,cursor,limit' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 20 || (value.cursor !== null && !MISSION.test(value.cursor))) throw new Error('Specialist catalog requires a bounded page and cursor.');
  } else if (value.command === 'list_generated_specialists') {
    if (keys !== 'command,cursor,limit' || !boundedInt(value.limit, 1, 20) || (value.cursor !== null && !matches(value.cursor, /^[a-f0-9]{32}:(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/))) throw new Error('Generated specialist catalog requires a bounded publication cursor.');
  } else if (['inspect', 'cancel'].includes(value.command)) {
    if (keys !== 'command,mission_id' || !MISSION.test(value.mission_id)) throw new Error('Invalid Work mission identifier.');
  } else if (['inspect_specialist', 'export_specialist', 'reveal_specialist'].includes(value.command)) {
    if (keys !== 'command,mission_id,specialist_id' || !MISSION.test(value.mission_id) || !MISSION.test(value.specialist_id)) throw new Error('Specialist delivery requires exact parent and specialist identifiers.');
  } else if (['validate_delivery', 'deliver'].includes(value.command)) {
    const expected = value.command === 'deliver' ? 'artifact_id,command,mission_id,validation_token' : 'artifact_id,command,mission_id';
    if (keys !== expected || !MISSION.test(value.mission_id) || !MISSION.test(value.artifact_id) || (value.command === 'deliver' && !/^[0-9a-f]{64}$/.test(value.validation_token))) throw new Error('Delivery requires exact mission/artifact IDs and a validation token.');
  } else throw new Error('Unsupported Work command.');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES) throw new Error('Work request exceeds its byte budget.');
  return encoded;
}

function cleanEnvironment(environment) {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']);
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === 'string'));
}

function createWorkTransport({ sourceRoot, getStateRoot, getPython = () => 'python', getEnvironment = () => process.env, getExecutionDistro = null, getOllamaUrl = () => process.env.YUR_OLLAMA_URL,
  onEvent = () => {}, onActivity = () => {}, bindPage = () => null, acquirePage = null, releasePage = () => {}, browserTimeoutMs = 4000, spawnProcess = spawn, timeoutMs = MAX_TIME_MS, controlTimeoutMs = 10000, queueTimeoutMs = MAX_TIME_MS } = {}) {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot) || typeof getStateRoot !== 'function' || typeof onEvent !== 'function' || typeof onActivity !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIME_MS || !Number.isSafeInteger(controlTimeoutMs) || controlTimeoutMs < 1 || controlTimeoutMs > 10000) throw new Error('Work transport requires explicit roots and bounded deadlines.');
  if (typeof bindPage !== 'function' || (acquirePage !== null && typeof acquirePage !== 'function') || typeof releasePage !== 'function' || !Number.isSafeInteger(browserTimeoutMs) || browserTimeoutMs < 1 || browserTimeoutMs > 5000) throw new Error('Work browser acquisition requires fixed callbacks and a bounded deadline.');
  if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > MAX_TIME_MS) throw new Error('Work queue requires a bounded waiting deadline.');
  const operations = new Map(), children = new Set(), queue = [];
  let disposed = false, activeOperation = null;

  function activity(operation, type, phase, extra = {}) {
    try { onActivity({ type, id: operation.request.request_id, phase, ...extra }, operation.owner); }
    catch { /* An activity observer cannot change execution or ownership. */ }
  }
  function finishActivity(operation) {
    if (operation.activityFinished || !operation.finished || (operation.child && !operation.childClosed)) return;
    operation.activityFinished = true;
    const response = operation.activityResponse;
    const mission = response?.ok ? response.result?.mission : null;
    let phase = 'unconfirmed';
    if (mission && ['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(mission.status)) phase = mission.status;
    else if (!response?.ok && response?.error?.cancellation_confirmed === true) phase = 'failed_cancelled';
    else if (!operation.missionId && response?.error?.code !== 'CANCELLATION_UNCONFIRMED') phase = 'failed';
    activity(operation, 'finish', phase, { mission_id: mission?.id || operation.missionId || null });
  }
  function observeRecord(operation, record) {
    const extra = { mission_id: record.mission_id };
    if (record.type === 'model') {
      activity(operation, 'update', 'model_' + record.status, { ...extra, ...(record.step_id ? { step_id: record.step_id } : {}) });
    } else if (record.type === 'tool') {
      // The public RPC predates telemetry. Project only the bounded typed tool
      // identity, never the full record or any extra payload a worker emitted.
      if (/^[a-f0-9]{32}$/.test(record.step_id) && /^[a-z][a-z0-9_]{0,79}$/.test(record.name))
        activity(operation, 'update', 'tool_' + record.status, { ...extra, tool: { id: record.step_id, name: record.name, status: record.status } });
    } else if (record.type === 'steering') {
      activity(operation, 'update', 'correction_' + record.status, extra);
    } else {
      const phases = { 'Work request accepted': 'accepted', 'Work started': 'working', 'Work completed': 'completing',
        'Verified the restricted serial Python execution resource.': 'resource_verified',
        'Running the staged Python snapshot in the isolated serial cell.': 'checks_running',
        'Captured output from the isolated execution cell.': 'checks_output',
        'Execution cell finished: completed.': 'checks_completed', 'Execution cell finished: failed.': 'checks_failed',
        'Execution cell finished: timeout.': 'checks_timeout', 'Execution cell finished: output_limit.': 'checks_output_limit',
        'Execution cell finished: cancelled.': 'checks_cancelled',
        'Generating direct candidate from the frozen public contract': 'candidate_direct',
        'Generating decomposed candidate from the frozen public contract': 'candidate_decomposed' };
      const phase = Object.hasOwn(phases, record.text) ? phases[record.text] : 'runtime_progress';
      activity(operation, 'update', phase, extra);
    }
  }

  function status(operation, phase, text) {
    activity(operation, 'update', phase === 'worker_waiting' ? 'worker_waiting' : 'queued');
    try { onEvent({ type: 'status', phase, admission: operation.missionId ? 'confirmed' : 'not_checked', mission_id: operation.missionId,
      request_id: operation.request.request_id, conversation_id: operation.request.conversation_id, text }, operation.owner); }
    catch { /* A detached renderer cannot change queue ownership. */ }
  }

  function releaseLane(operation) {
    // A failure response can settle before kill/close. Never launch another
    // worker while the previous process might still own the canonical lock.
    if (activeOperation === operation && operation.finished && (!operation.child || operation.childClosed)) {
      activeOperation = null;
      pump();
    }
  }

  function launch(value, { operation = null, endpoint = null, steeringOperation = null } = {}) {
    let encoded;
    try { encoded = validateRpc(value, true); }
    catch (error) { return Promise.resolve(failure('INVALID_REQUEST', error.message)); }
    if (children.size >= 8) return Promise.resolve(failure('BUSY', 'Work runtime process limit reached.'));
    return new Promise(resolve => {
      let child, timer, browserTimer, browserPending = false, browserFrame = null, browserReply = null, browserRepeats = 0, settled = false, pending = '', bytes = 0, diagnosticBytes = 0, final = null;
      const browserEnabled = Boolean(operation && value.command === 'start' && operation.request.browser_source);
      const finish = result => { if (settled) return; settled = true; if (operation) { operation.settled = true; operation.browserAbort?.abort(); } clearTimeout(timer); clearTimeout(browserTimer); resolve(result); };
      const fail = (code, message) => { finish(failure(code, message)); child?.kill(); };
      try {
        const stateRoot = getStateRoot();
        if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) throw new Error('Work state root must be absolute.');
        const hostEnvironment = getEnvironment();
        const env = { ...cleanEnvironment(hostEnvironment), YUR_DESKTOP_HOME: stateRoot, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
        const executionDistro = hostEnvironment.YUR_EXECUTION_DISTRO !== undefined ? hostEnvironment.YUR_EXECUTION_DISTRO : getExecutionDistro?.();
        if (executionDistro !== undefined && executionDistro !== null) {
          if (typeof executionDistro !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(executionDistro)) throw new Error('Execution distribution must be an explicit bounded local name.');
          env.YUR_EXECUTION_DISTRO = executionDistro;
        }
        if (endpoint) env.YUR_OLLAMA_URL = normalizeFoundryUrl(endpoint, 'YUR_OLLAMA_URL');
        child = spawnProcess(getPython(), ['-B', '-m', 'foundry.work_cli', ...(browserEnabled ? ['--browser-acquisition-v1'] : [])], { cwd: sourceRoot, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { finish(failure('RUNTIME_UNAVAILABLE', error.message)); return; }
      children.add(child);
      if (operation) { operation.child = child; operation.childClosed = false; }
      const acquireBrowser = async frame => {
        const controller = new AbortController(); operation.browserAbort = controller; browserPending = true;
        let result;
        try {
          const context = await Promise.race([
            Promise.resolve().then(() => {
              if (controller.signal.aborted) throw new Error('Cancelled');
              if (!acquirePage) throw Object.assign(new Error('Browser acquisition is unavailable in this host.'), { code: 'BROWSER_SOURCE_UNAVAILABLE' });
              return acquirePage(frame, operation.request, operation.owner, operation.browserBinding, { signal: controller.signal });
            }),
            new Promise((_, reject) => { browserTimer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('Page acquisition exceeded its host deadline.'), { code: 'BROWSER_ACQUISITION_TIMEOUT' })); }, browserTimeoutMs); }),
          ]);
          result = { context: validateContext(context, operation.request.browser_source) };
        } catch (error) {
          const allowed = new Set(['BROWSER_SOURCE_UNAVAILABLE', 'BROWSER_SOURCE_EXPIRED', 'BROWSER_SOURCE_CONSUMED', 'BROWSER_SOURCE_CHANGED', 'BROWSER_PAGE_UNAVAILABLE', 'BROWSER_ACQUISITION_CANCELLED', 'BROWSER_ACQUISITION_TIMEOUT', 'INVALID_BROWSER_CONTEXT', 'BROWSER_PRIVATE_CONTENT']);
          const code = allowed.has(error.code) ? error.code : 'BROWSER_ACQUISITION_FAILED';
          result = { error: { code, message: code === 'BROWSER_ACQUISITION_FAILED' ? 'The selected page could not be acquired.' : String(error.message).slice(0, 500) } };
        } finally { clearTimeout(browserTimer); browserPending = false; }
        // Durable cancellation owns the mission. Never deliver a late page to
        // a cancelled/settled worker, even if its extractor eventually returns.
        if (settled || final || operation.settled || operation.cancelPromise) return;
        const reply = JSON.stringify({ ...frame, type: 'browser_result', ...result }) + '\n';
        if (Buffer.byteLength(reply) > 144 * 1024) { fail('INVALID_RUNTIME_RESPONSE', 'Browser acquisition response exceeded its bound.'); return; }
        browserReply = reply;
        try { child.stdin.write(reply); } catch { fail('RUNTIME_INPUT_FAILED', 'Work runtime closed during page acquisition.'); }
      };
      const consume = line => {
        if (!line.trim() || settled) return;
        if (final) throw new Error('Work runtime sent data after its final response.');
        const record = JSON.parse(line);
        if (!object(record)) throw new Error('Invalid Work runtime record.');
        if (record.type === 'browser_acquire') {
          if (!browserEnabled || operation.cancelPromise) throw new Error('Unexpected browser acquisition.');
          validateAcquisition(record, operation.request, operation.missionId);
          const identity = canonical(record);
          if (browserFrame !== null) {
            if (identity !== browserFrame || ++browserRepeats > 3) throw new Error('Browser acquisition changed or exceeded its acknowledgement retry budget.');
            // Exact duplicates share the pending extraction or receive its
            // cached reply. They never read another document or acquire twice.
            if (browserReply) child.stdin.write(browserReply);
            return;
          }
          operation.missionId = record.mission_id; browserFrame = identity;
          void acquireBrowser(record);
        } else if (record.type === 'result') {
          if (typeof record.ok !== 'boolean' || (record.ok ? !object(record.result) : !object(record.error) || typeof record.error.code !== 'string' || typeof record.error.message !== 'string')) throw new Error('Invalid Work result envelope.');
          if (record.ok) {
            if (value.command === 'list' && !Array.isArray(record.result.missions)) throw new Error('Missing Work mission list.');
            if (value.command === 'steer') {
              validateSteerResult(value, record.result, steeringOperation);
            } else if (['concept_list', 'concept_inspect'].includes(value.command)) {
              validateConceptResult(value, record.result);
            } else if (Object.hasOwn(lifecycleFields, value.command)) {
              validateLifecycleResult(value, record.result);
            } else if (Object.hasOwn(organismFields, value.command)) {
              validateOrganismResult(value, record.result);
            } else if (Object.hasOwn(scheduleFields, value.command)) {
              validateScheduleResult(value, record.result);
            } else if (value.command === 'list_saved_specialists') {
              if (!Array.isArray(record.result.entries) || record.result.entries.length > value.limit || typeof record.result.coverage_limited !== 'boolean' || (record.result.next_cursor !== null && !MISSION.test(record.result.next_cursor)) || record.result.entries.some(item => !MISSION.test(item.mission_id) || !MISSION.test(item.source_parent_work_id) || !/^[a-f0-9]{64}$/.test(item.artifact_digest))) throw new Error('Invalid saved specialist catalog.');
            } else if (value.command === 'list_generated_specialists') {
              const page = record.result, sha = /^[a-f0-9]{64}$/;
              if (Object.keys(page).sort().join(',') !== 'coverage_limited,entries,excluded,next_cursor,scanned' || !Array.isArray(page.entries) || page.entries.length > value.limit || !boundedInt(page.scanned, 0, 200 * MAX_WORK_STEPS) || !boundedInt(page.excluded, 0, page.scanned) || typeof page.coverage_limited !== 'boolean' || (page.next_cursor !== null && !matches(page.next_cursor, /^[a-f0-9]{32}:(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/)) || Buffer.byteLength(JSON.stringify(page)) > 128 * 1024
                || page.entries.some(item => !object(item) || !matches(item.source_work_id, MISSION) || !boundedInt(item.build_step_index, 0, MAX_WORK_STEPS - 1) || !matches(item.artifact_sha256, sha) || !matches(item.published_receipt, sha) || !matches(item.source_sha256, sha) || !matches(item.contract_sha256, sha) || !matches(item.driver_sha256, sha) || typeof item.name !== 'string' || !item.name.length || Array.from(item.name).length > 100 || typeof item.description !== 'string' || Array.from(item.description).length > 4000 || !object(item.input_schema) || !object(item.output_schema) || !object(item.validation))) throw new Error('Invalid generated specialist catalog.');
            } else if (value.command === 'validate_delivery') {
              if (record.result.mission_id !== value.mission_id || record.result.artifact_id !== value.artifact_id || !object(record.result.plan) || !/^[0-9a-f]{64}$/.test(record.result.validation_token)) throw new Error('Invalid Work delivery validation.');
            } else if (value.command.endsWith('_specialist')) {
              if (record.result.parent_work_id !== value.mission_id) throw new Error('Specialist parent identity mismatch.');
              if (value.command === 'inspect_specialist' && record.result.specialist?.id !== value.specialist_id) throw new Error('Specialist identity mismatch.');
              if (value.command !== 'inspect_specialist' && record.result.specialist_id !== value.specialist_id) throw new Error('Specialist delivery identity mismatch.');
              if (value.command === 'export_specialist' && (record.result.export?.mission_id !== value.specialist_id || !/^[0-9a-f]{64}$/.test(record.result.export.zip_digest) || typeof record.result.export.path !== 'string')) throw new Error('Invalid specialist export receipt.');
              if (value.command === 'reveal_specialist' && (typeof record.result.path !== 'string' || !path.isAbsolute(record.result.path))) throw new Error('Invalid specialist reveal path.');
            } else if (value.command !== 'list') {
              const mission = record.result.mission;
              if (!object(mission) || !MISSION.test(mission.id) || !UUID.test(mission.request_id) || !UUID.test(mission.conversation_id) || !['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(mission.status)) throw new Error('Missing or invalid Work mission.');
              if (value.request && (mission.request_id !== value.request.request_id || mission.conversation_id !== value.request.conversation_id)) throw new Error('Work response identity mismatch.');
              if (value.mission_id && mission.id !== value.mission_id) throw new Error('Work response mission mismatch.');
              if (operation?.missionId && mission.id !== operation.missionId) throw new Error('Work response changed its accepted mission.');
            }
          }
          const { type: _type, ...response } = record;
          if (!response.ok && response.error.code === 'WORKER_BUSY' && (!operation?.missionId || response.error.mission_id !== operation.missionId || response.error.request_id !== operation.request.request_id || response.error.conversation_id !== operation.request.conversation_id)) throw new Error('Worker contention response changed its accepted identity.');
          final = response;
          if (operation) {
            operation.settled = true;
            // A verified contention reply ends this child attempt, not the
            // accepted mission. Corrections can still queue through the core.
            operation.waitingForWorker = !response.ok && response.error.code === 'WORKER_BUSY';
            operation.browserAbort?.abort();
          }
        } else if (operation && ['status', 'tool', 'steering', 'model'].includes(record.type)) {
          if (record.request_id !== operation.request.request_id || record.conversation_id !== operation.request.conversation_id || !MISSION.test(record.mission_id)) throw new Error('Work event identity mismatch.');
          if (operation.missionId && record.mission_id !== operation.missionId) throw new Error('Work event changed its accepted mission.');
          if (record.type === 'status' && (typeof record.text !== 'string' || record.text.length > 2000)) throw new Error('Invalid Work status event.');
          if (record.type === 'tool' && (typeof record.name !== 'string' || record.name.length > 80 || typeof record.step_id !== 'string' || !['running', 'completed', 'rejected'].includes(record.status))) throw new Error('Invalid Work tool event.');
          if (record.type === 'steering' && (Object.keys(record).sort().join(',') !== 'conversation_id,correction_id,mission_id,receipt,request_id,status,type' || typeof record.correction_id !== 'string' || !UUID.test(record.correction_id) || !['queued', 'consumed', 'not_consumed'].includes(record.status) || !validSteeringReceipt(record.receipt))) throw new Error('Invalid Work steering event.');
          if (record.type === 'model') {
            const keys = Object.keys(record).filter(key => key !== 'step_id').sort().join(',');
            const labels = { running: 'Waiting for model response', completed: 'Model response received', failed: 'Model request failed' };
            if (keys !== 'call_id,conversation_id,mission_id,request_id,status,text,type' || !Object.hasOwn(labels, record.status)
                || record.text !== labels[record.status] || !Number.isSafeInteger(record.call_id) || record.call_id < 1 || record.call_id > 2147483647
                || (record.step_id !== undefined && (typeof record.step_id !== 'string' || !MISSION.test(record.step_id)))) throw new Error('Invalid Work model activity event.');
          }
          operation.missionId = record.mission_id;
          observeRecord(operation, record);
          try { onEvent(record, operation.owner); } catch { /* Renderer teardown cannot change core results. */ }
        } else throw new Error('Unexpected Work runtime event.');
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) { fail('RESPONSE_TOO_LARGE', 'Work output exceeded 4 MiB.'); return; }
        pending += chunk;
        try {
          let end;
          while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); consume(line); }
        } catch { fail('INVALID_RUNTIME_RESPONSE', 'Work runtime returned malformed or mismatched evidence.'); }
      });
      child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 65536) fail('RUNTIME_OUTPUT_LIMIT', 'Work diagnostics exceeded their byte limit.'); });
      child.stdin.on('error', () => fail('RUNTIME_INPUT_FAILED', 'Work runtime closed before accepting its request.'));
      child.on('error', () => finish(failure('RUNTIME_UNAVAILABLE', 'Could not start the configured Work Python runtime.')));
      child.on('close', code => {
        children.delete(child);
        if (operation?.child === child) {
          operation.childClosed = true;
          activity(operation, 'update', 'process_closed');
          finishActivity(operation); releaseLane(operation);
        }
        if (settled) return;
        try {
          consume(pending);
          if (!final) throw new Error('Missing final result.');
          if (code !== 0 && final.ok) finish(failure('RUNTIME_FAILED', 'Work runtime exited before confirming successful completion.'));
          else finish(final);
        } catch { finish(failure('INVALID_RUNTIME_RESPONSE', 'Work process stopped without a valid final receipt. Inspect its mission before retrying.')); }
      });
      timer = setTimeout(() => fail('RUNTIME_TIMEOUT', 'Work runtime exceeded its bounded deadline.'), operation ? Math.max(1, operation.deadline - performance.now()) : controlTimeoutMs);
      try { if (browserEnabled) child.stdin.write(encoded + '\n'); else child.stdin.end(encoded); } catch { fail('RUNTIME_INPUT_FAILED', 'Work runtime could not accept its request.'); }
    });
  }

  async function cancelOperation(operation) {
    if (operation.cancelPromise) return operation.cancelPromise;
    // Mark synchronously, before even the separate cancellation RPC can yield.
    // Queued starts and retries cannot race past an explicit Stop.
    operation.cancelRequested = true;
    activity(operation, 'update', 'stopping');
    operation.wakeRetry?.();
    operation.browserAbort?.abort();
    operation.cancelPromise = (async () => {
      // Once accepted, cancellation must remain available even if the selected
      // repository has disappeared. Before acceptance, the original immutable
      // request reserves/cancels its identity through the manager.
      const response = await launch(operation.missionId ? { command: 'cancel', mission_id: operation.missionId } : { command: 'cancel_request', request: operation.request });
      operation.child?.kill();
      if (!response.ok) return failure('CANCELLATION_UNCONFIRMED', `The process was stopped, but durable cancellation was not confirmed: ${response.error.message}`);
      const mission = response.result.mission;
      return { ok: true, result: { cancelled: mission.status === 'cancelled', mission } };
    })();
    if (!operation.started) void operation.cancelPromise.then(result => finishOperation(operation, result.ok ? { ok: true, result: { mission: result.result.mission } } : result));
    return operation.cancelPromise;
  }

  function finishOperation(operation, response) {
    if (operation.finished) return;
    operation.finished = true;
    operation.activityResponse = response;
    clearTimeout(operation.queueTimer);
    const index = queue.indexOf(operation); if (index >= 0) queue.splice(index, 1);
    operation.browserAbort?.abort();
    try { releasePage(operation.browserBinding); } catch { /* Cleanup cannot change a committed result. */ }
    operations.delete(operation.request.request_id);
    if (operation.child && !operation.childClosed) activity(operation, 'update', operation.cancelRequested ? 'stopping' : 'unconfirmed');
    finishActivity(operation);
    // Preserve a known accepted identity even if a later local spawn or
    // cancellation acknowledgement fails before the CLI can repeat it.
    operation.resolve(!response.ok && operation.missionId ? { ...response, error: { ...response.error, mission_id: operation.missionId } } : response);
    releaseLane(operation);
  }

  async function runOperation(operation) {
    let response;
    try {
      do {
        if (operation.cancelRequested) break;
        operation.waitingForWorker = false;
        operation.settled = false;
        response = await launch({ command: 'start', request: operation.request }, { operation, endpoint: operation.endpoint });
        if (response.ok || response.error.code !== 'WORKER_BUSY' || operation.cancelRequested) break;
        // Only the CLI's typed, identity-bound canonical lock contention is
        // retryable. submit_work reuses this exact request; no tool has run.
        status(operation, 'worker_waiting', 'Waiting for the existing factory worker; this Work request remains accepted.');
        const remaining = operation.deadline - performance.now();
        if (remaining <= 0) break;
        const deadlineWait = remaining <= 250;
        await new Promise(resolve => {
          const timer = setTimeout(done, Math.ceil(Math.min(250, remaining)));
          function done() { clearTimeout(timer); operation.wakeRetry = null; resolve(); }
          operation.wakeRetry = done;
        });
        // A wait allocated the entire remaining budget cannot admit a retry,
        // even when timer precision wakes it just before the monotonic deadline.
        if (deadlineWait) break;
      } while (operation.deadline > performance.now());
      if (operation.cancelPromise) {
        const cancelled = await operation.cancelPromise;
        response = cancelled.ok ? { ok: true, result: { mission: cancelled.result.mission } } : cancelled;
      } else {
        if (!response?.ok && response?.error.code === 'WORKER_BUSY') response = failure('RUNTIME_TIMEOUT', 'Work runtime exceeded its bounded deadline while waiting for the existing factory worker.');
        if (!response.ok && (['RUNTIME_TIMEOUT', 'INVALID_RUNTIME_RESPONSE', 'RESPONSE_TOO_LARGE', 'RUNTIME_OUTPUT_LIMIT', 'RUNTIME_FAILED', 'RUNTIME_INPUT_FAILED'].includes(response.error.code) || (operation.missionId && response.error.code === 'RUNTIME_UNAVAILABLE'))) {
          const cancelled = await cancelOperation(operation);
          response = { ...response, error: { ...response.error, cancellation_confirmed: Boolean(cancelled.ok), ...(cancelled.ok ? { mission_id: cancelled.result.mission.id } : { cancellation_error: cancelled.error.message }) } };
        }
      }
    } finally { finishOperation(operation, response || failure('RUNTIME_FAILED', 'Work runtime did not return a result.')); }
  }

  function pump() {
    if (activeOperation || disposed) return;
    const operation = queue.find(item => !item.finished && !item.cancelRequested);
    if (!operation) return;
    queue.splice(queue.indexOf(operation), 1);
    activeOperation = operation; operation.started = true;
    activity(operation, 'update', 'dispatching');
    clearTimeout(operation.queueTimer);
    // Waiting has its own finite budget. The existing execution deadline starts
    // at dispatch and is shared by all lock-contention attempts, never reset.
    operation.deadline = performance.now() + timeoutMs;
    void runOperation(operation);
  }

  async function start(value, owner = null) {
    let request, endpoint;
    try { request = validateWorkRequest(value); endpoint = getOllamaUrl(); if (endpoint) normalizeFoundryUrl(endpoint, 'YUR_OLLAMA_URL'); }
    catch (error) { return failure('INVALID_REQUEST', error.message); }
    if (disposed) return failure('CLOSED', 'Work transport is shutting down.');
    if (operations.has(request.request_id)) return failure('DUPLICATE_REQUEST', 'This Work request is already active.');
    if (operations.size >= 4 || [...operations.values()].some(item => item.owner === owner && item.request.conversation_id === request.conversation_id)) return failure('BUSY', 'Work is already running in this conversation or the runtime is busy.');
    let browserBinding = null;
    try { if (request.browser_source) browserBinding = bindPage(request, owner); }
    catch { return failure('BROWSER_BINDING_FAILED', 'The selected browser source could not be bound to this request.'); }
    const operation = { request, owner, endpoint, child: null, childClosed: true, cancelPromise: null, cancelRequested: false, missionId: null, settled: false, waitingForWorker: false, started: false, finished: false, browserBinding, browserAbort: null };
    const result = new Promise(resolve => { operation.resolve = resolve; });
    operations.set(request.request_id, operation);
    activity(operation, 'begin', 'queued', { kind: request.mode,
      origin: owner?.kind === 'committed-schedule-dispatcher' ? 'schedule' : 'conversation',
      conversation_id: request.conversation_id, provider: request.provider, model: request.model });
    queue.push(operation);
    operation.queueTimer = setTimeout(() => {
      if (!operation.started && !operation.cancelRequested) finishOperation(operation, failure('BUSY', 'Work queue waiting deadline expired before dispatch. This start was not dispatched.'));
    }, queueTimeoutMs);
    if (activeOperation) status(operation, 'transport_waiting', 'Waiting for the Work runtime; this start has not been dispatched.');
    pump();
    return result;
  }

  async function cancel(requestId, owner = null) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return failure('INVALID_REQUEST', 'Cancellation requires a request UUID.');
    const operation = operations.get(requestId);
    if (!operation || operation.owner !== owner) return { ok: true, result: { cancelled: false } };
    return cancelOperation(operation);
  }
  async function steer(value, owner = null) {
    let correction;
    try { correction = validateSteerRequest(value); }
    catch (error) { return failure('INVALID_REQUEST', error.message); }
    if (disposed) return failure('CLOSED', 'Work transport is shutting down.');
    const operation = [...operations.values()].find(item => item.owner === owner && item.missionId === correction.mission_id && item.request.conversation_id === correction.conversation_id);
    if (!operation || operation.finished || (operation.settled && !operation.waitingForWorker) || operation.cancelRequested || operation.cancelPromise) return failure('NOT_ACTIVE', 'A correction requires this window’s active mission and conversation.');
    // Authorization is fixed at dispatch. A valid receipt remains meaningful if
    // the original operation finishes while this control command is in flight.
    const response = await launch({ command: 'steer', ...correction }, { steeringOperation: operation });
    if (response.ok && response.result.correction.status === 'queued') {
      const item = response.result.correction;
      activity(operation, 'update', 'correction_queued', { mission_id: operation.missionId });
      try { onEvent({ type: 'steering', mission_id: operation.missionId, request_id: operation.request.request_id, conversation_id: operation.request.conversation_id,
        correction_id: item.correction_id, status: 'queued', receipt: item.queued_receipt }, operation.owner); } catch { /* The committed receipt survives renderer teardown. */ }
    }
    return response;
  }
  async function request(value) {
    try { validateRpc(value); } catch (error) { return failure('INVALID_REQUEST', error.message); }
    return launch(value);
  }
  async function cancelOwner(owner) { return Promise.all([...operations.values()].filter(operation => operation.owner === owner).map(cancelOperation)); }
  async function dispose() { disposed = true; return Promise.all([...operations.values()].map(cancelOperation)); }
  return { start, request, cancel, steer, cancelOwner, dispose };
}

module.exports = { createWorkTransport, validateWorkRequest, validateSteerRequest, validateRpc, cleanEnvironment, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_TIME_MS };
