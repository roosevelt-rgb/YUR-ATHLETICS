'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { selections: sourceSelections } = require('./source-context');

// The journal bounds the conversation itself to 1 MiB; allow its fixed RPC envelope.
const MAX_INPUT_BYTES = 1024 * 1024 + 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const revision = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const projectFields = {
  project_files_list: 'command,expected_project_revision,project_id',
  project_file_add: 'command,expected_collection_revision,expected_project_revision,expected_sha256,operation_id,path,project_id',
  project_file_remove: 'command,expected_collection_revision,expected_file_revision,expected_project_revision,expected_sha256,file_id,operation_id,project_id',
  project_files_context: 'command,expected_project_revision,project_id,selections',
};
function validateProjectSelections(value) {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Select at most eight project reference files.');
  const ids = new Set();
  for (const file of value) {
    if (!object(file) || Object.keys(file).sort().join(',') !== 'file_id,revision,sha256' || !UUID.test(file.file_id) || !revision(file.revision, 1) || !HASH.test(file.sha256) || ids.has(file.file_id)) throw new Error('Project references require unique committed file IDs, revisions and hashes.');
    ids.add(file.file_id);
  }
}
function validateProjectRequest(request) {
  if (Object.keys(request).sort().join(',') !== projectFields[request.command] || !UUID.test(request.project_id) || !revision(request.expected_project_revision, 1)) throw new Error('Select an existing project and its current revision.');
  if (request.command === 'project_files_context') validateProjectSelections(request.selections);
  if (['project_file_add', 'project_file_remove'].includes(request.command)) {
    if (!revision(request.expected_collection_revision) || !UUID.test(request.operation_id) || !HASH.test(request.expected_sha256)) throw new Error('Project file changes require an operation ID, collection revision and source hash.');
    if (request.command === 'project_file_remove' && (!UUID.test(request.file_id) || !revision(request.expected_file_revision, 1))) throw new Error('Remove requires an exact committed project file.');
    if (request.command === 'project_file_add' && (typeof request.path !== 'string' || request.path.length > 4096 || !path.isAbsolute(request.path) || /[\x00-\x1f]/.test(request.path))) throw new Error('Choose an absolute local reference file path.');
  }
}
function validateProjectResponse(result, command, request) {
  const evidence = command === 'project_files_context' ? result.evidence : result;
  if (!object(evidence) || !UUID.test(evidence.project_id) || !revision(evidence.project_revision, 1) || !revision(evidence.collection_revision) || !Array.isArray(evidence.files) || evidence.files.length > (command === 'project_files_context' ? 8 : 32)) throw new Error('Invalid project file collection.');
  if (request && (evidence.project_id !== request.project_id || evidence.project_revision !== request.expected_project_revision)) throw new Error('Project file acknowledgment belongs to a different project revision.');
  const ids = new Set();
  for (const file of evidence.files) {
    if (!object(file) || !UUID.test(file.id) || ids.has(file.id) || !revision(file.revision, 1) || !HASH.test(file.sha256) || !HASH.test(file.content_sha256) || typeof file.name !== 'string' || [...file.name].length > 255) throw new Error('Invalid project file identity.');
    ids.add(file.id);
    if (command !== 'project_files_context' && (file.project_id !== evidence.project_id || !revision(file.bytes) || file.bytes > 16 * 1024 * 1024 || !object(file.extraction))) throw new Error('Invalid project file metadata.');
    if (command === 'project_files_context' && (!HASH.test(file.excerpt_sha256) || !revision(file.excerpt_characters) || !revision(file.excerpt_bytes) || typeof file.truncated !== 'boolean')) throw new Error('Invalid project excerpt evidence.');
  }
  if (command === 'project_files_context') {
    if (evidence.schema !== 'yur.project-files-context.v1' || typeof result.context !== 'string' || Buffer.byteLength(result.context) > 96 * 1024 || createHash('sha256').update(result.context).digest('hex') !== evidence.context_sha256) throw new Error('Invalid project context bytes or digest.');
    if (request && (request.selections.length !== evidence.files.length || request.selections.some(ref => !evidence.files.some(file => file.id === ref.file_id && file.revision === ref.revision && file.sha256 === ref.sha256)))) throw new Error('Project context does not match the explicitly selected file versions.');
  } else if (['project_file_add', 'project_file_remove'].includes(command)) {
    const receipt = result.receipt;
    if (!object(receipt) || receipt.project_id !== result.project_id || !UUID.test(receipt.file_id) || !UUID.test(receipt.operation_id) || !HASH.test(receipt.hash) || !revision(receipt.collection_revision, 1) || typeof result.replayed !== 'boolean' || (request && receipt.operation_id !== request.operation_id)) throw new Error('Invalid project file commit receipt.');
    if (request?.file_id && receipt.file_id !== request.file_id) throw new Error('Project removal acknowledged a different file.');
  }
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected a conversation request.');
  const keys = Object.keys(request).sort().join(',');
  if (request.command === 'list') {
    if (keys !== 'command') throw new Error('List accepts no additional fields.');
  } else if (request.command === 'save') {
    if (keys !== 'command,conversation,expected_revision' || !request.conversation || typeof request.conversation !== 'object' || Array.isArray(request.conversation)) throw new Error('Save requires a conversation object and expected revision.');
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 0) throw new Error('Expected revision must be a nonnegative integer.');
    if (Object.hasOwn(request.conversation, 'source_selections')) sourceSelections(request.conversation.source_selections);
  } else if (request.command === 'workspace_list') {
    if (keys !== 'command,kind' || !['project', 'settings'].includes(request.kind)) throw new Error('Workspace list requires project or settings kind.');
  } else if (request.command === 'workspace_save') {
    if (keys !== 'command,document,expected_revision,kind' || !['project', 'settings'].includes(request.kind) || !request.document || typeof request.document !== 'object' || Array.isArray(request.document)) throw new Error('Workspace save requires a document, kind and expected revision.');
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 0) throw new Error('Expected revision must be a nonnegative integer.');
  } else if (Object.hasOwn(projectFields, request.command)) validateProjectRequest(request);
  else throw new Error('Unsupported conversation command.');
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES) throw new Error('Conversation request exceeds the desktop journal limit.');
  return encoded;
}

function parseResponse(output, command, request = null) {
  const value = JSON.parse(output);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') throw new Error('Invalid response envelope.');
  if (value.ok) {
    if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) throw new Error('Missing conversation result.');
    if (command === 'list' && !Array.isArray(value.result.conversations)) throw new Error('Missing conversation list.');
    if (command === 'save' && (!value.result.conversation || typeof value.result.conversation !== 'object' || Array.isArray(value.result.conversation) || !Number.isSafeInteger(value.result.conversation.revision) || value.result.conversation.revision < 1)) throw new Error('Missing committed conversation revision.');
    for (const conversation of command === 'list' ? value.result.conversations : command === 'save' ? [value.result.conversation] : []) if (Object.hasOwn(conversation, 'source_selections')) sourceSelections(conversation.source_selections);
    if (command === 'workspace_list' && !Array.isArray(value.result.documents)) throw new Error('Missing workspace documents.');
    if (command === 'workspace_save' && (!value.result.document || typeof value.result.document !== 'object' || Array.isArray(value.result.document) || !Number.isSafeInteger(value.result.document.revision) || value.result.document.revision < 1)) throw new Error('Missing committed workspace revision.');
    if (Object.hasOwn(projectFields, command)) validateProjectResponse(value.result, command, request);
  } else if (!value.error || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') throw new Error('Missing conversation error.');
  return value;
}

function createConversationTransport({ sourceRoot, getStateRoot, getPython = () => 'python', getEnvironment = () => process.env, spawnProcess = spawn, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot) || typeof getStateRoot !== 'function') throw new Error('Conversation transport requires explicit source and state roots.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS) throw new Error('Invalid conversation timeout.');
  const children = new Set();

  function request(value) {
    let encoded;
    try { encoded = validateRequest(value); }
    catch (error) { return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: error.message } }); }
    if (children.size >= 4) return Promise.resolve({ ok: false, error: { code: 'BUSY', message: 'Conversation storage is busy. Retry after the current request completes.' } });
    return new Promise(resolve => {
      let child, timer, settled = false, output = '', outputBytes = 0, diagnosticBytes = 0;
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
      const fail = (code, message) => finish({ ok: false, error: { code, message } });
      const stop = () => { if (child) child.kill(); };
      try {
        const stateRoot = getStateRoot();
        if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) throw new Error('YUR_DESKTOP_HOME must be an absolute directory.');
        const environment = { ...getEnvironment(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', YUR_DESKTOP_HOME: stateRoot };
        delete environment.PYTHONPATH;
        delete environment.PYTHONHOME;
        child = spawnProcess(getPython(), ['-B', '-m', 'foundry.conversation_cli'], { cwd: sourceRoot, shell: false, windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { fail('RUNTIME_UNAVAILABLE', error.message); return; }
      children.add(child);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) { fail('RESPONSE_TOO_LARGE', 'Conversation response exceeded 4 MiB.'); stop(); }
        else output += chunk;
      });
      child.stderr.on('data', chunk => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > MAX_OUTPUT_BYTES) { fail('RUNTIME_OUTPUT_LIMIT', 'Conversation diagnostics exceeded the desktop limit.'); stop(); }
      });
      child.on('error', () => fail('RUNTIME_UNAVAILABLE', 'Could not start conversation storage. Check the configured Python runtime.'));
      child.stdin.on('error', () => { fail('RUNTIME_INPUT_FAILED', 'Conversation storage closed before accepting the request.'); stop(); });
      child.on('close', exitCode => {
        children.delete(child);
        if (settled) return;
        try {
          const response = parseResponse(output, value.command, value);
          if (exitCode !== 0 && response.ok) fail('RUNTIME_FAILED', 'Conversation storage exited unsuccessfully. Reload conversations before retrying.');
          else finish(response);
        } catch { fail('INVALID_RUNTIME_RESPONSE', 'Conversation storage did not return a valid result.'); }
      });
      timer = setTimeout(() => { fail('RUNTIME_TIMEOUT', 'Conversation request exceeded 10 seconds. Reload conversations before retrying.'); stop(); }, timeoutMs);
      try { child.stdin.end(encoded); }
      catch { fail('RUNTIME_INPUT_FAILED', 'Conversation storage could not accept the request.'); stop(); }
    });
  }

  return { request, dispose: () => { for (const child of children) child.kill(); } };
}

module.exports = { createConversationTransport, validateRequest, parseResponse, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, TIMEOUT_MS };
