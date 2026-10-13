'use strict';

const { pathToFileURL } = require('url');
const path = require('path');

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COMMAND_KEYS = {
  media: ['action', 'payload'],
  health: [], catalog: [], list: [],
  submit: ['spec', 'idempotency_key'], process: ['max_missions'],
  inspect: ['mission_id'], cancel: ['mission_id'],
  run: ['mission_id', 'capability_id', 'input'],
  automation: ['enabled', 'interval_seconds', 'max_cycles'],
  automation_status: [],
  export: ['mission_id'],
  sources: ['query', 'limit'],
  source_acquire: ['source_id', 'relative_path', 'expected_sha256'],
  repository_context: ['root', 'question', 'authority'],
  repository_bootstrap: ['roots', 'question', 'bootstrap', 'authority'],
  copilot_catalog: ['root', 'query', 'kind', 'limit', 'offset'],
  copilot_acquire: ['root', 'path', 'expected_sha256'],
  hermes_catalog: ['root', 'query', 'lane', 'limit', 'offset'],
  hermes_acquire: ['root', 'path', 'expected_sha256'],
  workforce_catalog: ['root', 'query'],
  workforce_acquire: ['root', 'code', 'expected_sha256'],
  workforce_run: ['root', 'code', 'expected_sha256', 'input', 'request_id'],
  workforce_result: ['mission_id', 'run_id'],
  attachment_read: ['path', 'expected_sha256'],
};

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validText(value, max = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
}

function validateFactoryRequest(request) {
  if (!isRecord(request) || !Object.hasOwn(COMMAND_KEYS, request.command)) throw new Error('Unknown factory command.');
  const allowed = new Set(['command', ...COMMAND_KEYS[request.command]]);
  if (Object.keys(request).some(key => !allowed.has(key))) throw new Error('Unexpected factory request field.');
  const encoded = JSON.stringify(request);
  if (request.command === 'media' && (!['catalog', 'configure', 'status', 'submit', 'inspect', 'list', 'resume', 'cancel', 'import', 'asset'].includes(request.action) || !isRecord(request.payload))) throw new Error('Invalid media operation.');
  if (request.command === 'source_acquire') require('./source-context').reference({ source_id: request.source_id, relative_path: request.relative_path, sha256: request.expected_sha256, name: request.relative_path?.split('/').at(-1) });
  if (request.command === 'attachment_read' && (!validText(request.path, 4096) || (request.expected_sha256 !== null && !/^[a-f0-9]{64}$/.test(request.expected_sha256)))) throw new Error('Select an attachment path and optional original hash.');
  if (['workforce_catalog', 'workforce_acquire', 'workforce_run'].includes(request.command) && !validText(request.root, 4096)) throw new Error('Invalid workforce source folder.');
  if (request.command === 'workforce_catalog' && (typeof request.query !== 'string' || request.query.length > 200)) throw new Error('Workforce search exceeds 200 characters.');
  if (['workforce_acquire', 'workforce_run'].includes(request.command) && (!/^[a-z][a-z0-9_]{0,79}$/.test(request.code) || !/^[a-f0-9]{64}$/.test(request.expected_sha256))) throw new Error('Select a versioned workforce profile.');
  if (request.command === 'workforce_run' && (request.code !== 'hatch_quantity' || !validText(request.request_id, 36) || !isRecord(request.input) || Object.keys(request.input).some(key => !['plans_text', 'specs_text'].includes(key)) || ['plans_text', 'specs_text'].some(key => typeof request.input[key] !== 'string' || request.input[key].length > 30000))) throw new Error('Provide bounded HATCH plans and specifications.');
  if (request.command === 'workforce_result' && (!validText(request.mission_id) || !/^[a-f0-9]{32}$/.test(request.run_id))) throw new Error('Select a committed workforce result.');
  if (request.command.startsWith('copilot_') && !validText(request.root, 4096)) throw new Error('Invalid Copilot library root.');
  if (request.command === 'copilot_catalog' && (typeof request.query !== 'string' || request.query.length > 200 || !['', 'agent', 'skill', 'instruction'].includes(request.kind) || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100 || !Number.isInteger(request.offset) || request.offset < 0 || request.offset > 4000)) throw new Error('Invalid Copilot library search.');
  if (request.command === 'copilot_acquire' && (!validText(request.path, 300) || !/^[a-f0-9]{64}$/.test(request.expected_sha256))) throw new Error('Select a versioned Copilot library item.');
  if (request.command.startsWith('hermes_') && !validText(request.root, 4096)) throw new Error('Invalid versioned Hermes snapshot root.');
  if (request.command === 'hermes_catalog' && (typeof request.query !== 'string' || request.query.length > 200 || !['', 'active', 'optional'].includes(request.lane) || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100 || !Number.isInteger(request.offset) || request.offset < 0 || request.offset > 500)) throw new Error('Invalid Hermes skill search.');
  if (request.command === 'hermes_acquire' && (!validText(request.path, 500) || !/^[a-f0-9]{64}$/.test(request.expected_sha256))) throw new Error('Select a versioned Hermes skill.');
  if (request.command === 'repository_context' && (!validText(request.root, 4096) || typeof request.question !== 'string' || request.question.length > 32000 || request.question.includes('\0') || JSON.stringify(request.authority) !== JSON.stringify({ issuer: 'local-user', scope: 'repository-read', actions: ['list', 'read', 'search'] }))) throw new Error('Invalid local repository read request.');
  if (request.command === 'repository_bootstrap' && (!Array.isArray(request.roots) || request.roots.length < 1 || request.roots.length > 3 || request.roots.some(root => !validText(root, 4096) || !(path.isAbsolute(root) || path.win32.isAbsolute(root))) || !['repo', 'folder', 'federation'].includes(request.bootstrap) || (request.bootstrap !== 'federation' && request.roots.length !== 1) || typeof request.question !== 'string' || request.question.length > 32000 || request.question.includes('\0') || JSON.stringify(request.authority) !== JSON.stringify({ issuer: 'local-user', scope: 'repository-read', actions: ['list', 'read', 'search'] }))) throw new Error('Invalid repository bootstrap request.');
  if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error('Factory request exceeds 128 KiB.');
  if (['inspect', 'cancel', 'run', 'export'].includes(request.command) && !validText(request.mission_id)) throw new Error('A mission ID is required.');
  if (request.command === 'submit') {
    const spec = request.spec;
    if (!isRecord(spec) || !validText(spec.name, 100) || typeof spec.description !== 'string' || spec.description.length > 2000 || spec.description.includes('\0') || !Array.isArray(spec.capabilities) || spec.capabilities.length < 1 || spec.capabilities.length > 3 || spec.capabilities.some(id => !validText(id))) throw new Error('Provide a name, a description of at most 2000 characters and 1–3 capability IDs.');
    if (!validText(request.idempotency_key)) throw new Error('An idempotency key is required.');
  }
  if (request.command === 'process' && (!Number.isInteger(request.max_missions) || request.max_missions < 1 || request.max_missions > 25)) throw new Error('Process between 1 and 25 missions per request.');
  if (request.command === 'run' && (!validText(request.capability_id) || !isRecord(request.input))) throw new Error('Provide a capability ID and JSON object input.');
  if (request.command === 'sources' && (typeof request.query !== 'string' || request.query.length > 200 || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50)) throw new Error('Source search requires a query of at most 200 characters and a result limit of 1–50.');
  if (request.command === 'automation' && (typeof request.enabled !== 'boolean' || !Number.isInteger(request.interval_seconds) || request.interval_seconds < 5 || request.interval_seconds > 3600 || !Number.isInteger(request.max_cycles) || request.max_cycles < 1 || request.max_cycles > 100)) throw new Error('Automation requires an explicit bounded configuration.');
  return encoded;
}

function parseFactoryResponse(data, maxBytes = MAX_RESPONSE_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 12 * 1024 * 1024) throw new Error('Invalid response byte budget.');
  if (Buffer.byteLength(data) > maxBytes) throw new Error('Factory response is too large.');
  const response = JSON.parse(data);
  if (!isRecord(response) || typeof response.ok !== 'boolean') throw new Error('Factory returned an invalid response envelope.');
  if (response.ok && !Object.hasOwn(response, 'result')) throw new Error('Factory response is missing its result.');
  if (!response.ok && (!isRecord(response.error) || !validText(response.error.code) || !validText(response.error.message, 16000))) throw new Error('Factory response is missing its error.');
  return response;
}

function isTrustedSender(event, window, filePath) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
  if (event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const senderUrl = new URL(event.senderFrame.url);
    senderUrl.hash = '';
    return senderUrl.href === pathToFileURL(path.resolve(filePath)).href;
  } catch { return false; }
}

function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid external URL.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS links are allowed.');
  return url.href;
}

function fileSearchArgs(dirPath) {
  if (!validText(dirPath, 32768)) throw new Error('Invalid search directory.');
  return ['--files', '--', path.resolve(dirPath)];
}

module.exports = { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, validateFactoryRequest, parseFactoryResponse, isTrustedSender, safeExternalUrl, fileSearchArgs };
