/**
 * Compatible with the inspected YUR agent Plugin/Action contract.
 * Binds completed local factory missions without creating another coordinator.
 */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const MISSION_ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_REQUEST_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 2_000_000;
const CAPABILITIES = Object.freeze(['text.analyze', 'data.profile', 'support.triage']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function jsonCopy(value, maxBytes = MAX_REQUEST_BYTES, maxDepth = 12) {
  const ancestors = new Set();
  function inspect(item, depth) {
    if (depth > maxDepth) throw new Error('JSON nesting exceeds the input boundary');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if ((!Array.isArray(item) && !plainObject(item)) || ancestors.has(item)) {
      throw new Error('Only finite, acyclic JSON data is accepted');
    }
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Symbol properties are not JSON');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new Error('Accessor and hidden properties are not JSON');
      }
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error('Reserved JSON property');
      }
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  inspect(value, 0);
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('JSON exceeds the byte boundary');
  }
  return JSON.parse(text);
}

function fields(value, required, optional = []) {
  return plainObject(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function boundedString(value, minimum, maximum) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function validInput(capabilityId, input) {
  if (capabilityId === 'text.analyze') {
    return fields(input, ['text'], ['top_k']) && boundedString(input.text, 1, 100_000)
      && (!Object.hasOwn(input, 'top_k') || (Number.isInteger(input.top_k) && input.top_k >= 1 && input.top_k <= 20));
  }
  if (capabilityId === 'support.triage') {
    return fields(input, ['subject', 'body'], ['customer_tier'])
      && boundedString(input.subject, 1, 500) && boundedString(input.body, 0, 20_000)
      && (!Object.hasOwn(input, 'customer_tier') || ['standard', 'premium'].includes(input.customer_tier));
  }
  if (capabilityId === 'data.profile') {
    if (!fields(input, ['rows']) || !Array.isArray(input.rows) || input.rows.length > 2000) return false;
    const columns = new Set();
    for (const row of input.rows) {
      if (!plainObject(row) || Object.keys(row).length > 100) return false;
      for (const [key, value] of Object.entries(row)) {
        columns.add(key);
        if (key.length > 200 || columns.size > 100) return false;
        if (!(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
          || boundedString(value, 0, 2000))) return false;
      }
    }
    return true;
  }
  return false;
}

function extractInput(message, capabilityId) {
  if (!plainObject(message?.content) || !Object.hasOwn(message.content, 'factoryInput')) {
    throw new Error('message.content.factoryInput must contain the capability input object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(message.content, 'factoryInput');
  if (descriptor.get || descriptor.set) throw new Error('Factory input must be data');
  const input = jsonCopy(descriptor.value);
  if (!validInput(capabilityId, input)) throw new Error('Input does not match the bound capability contract');
  return input;
}

function unwrap(envelope) {
  const checked = jsonCopy(envelope, MAX_RESPONSE_BYTES, 32);
  if (!plainObject(checked) || checked.ok !== true || !Object.hasOwn(checked, 'result')) {
    const code = checked?.error?.code;
    throw new Error(typeof code === 'string' ? `Factory refused request: ${code.slice(0, 80)}` : 'Invalid factory response envelope');
  }
  return checked.result;
}

/** Bind one committed mission. invoke is a host-owned RPC transport, never model input. */
export async function createFoundryPlugin({ missionId, invoke } = {}) {
  if (typeof missionId !== 'string' || !MISSION_ID.test(missionId) || typeof invoke !== 'function') {
    throw new Error('An explicit missionId and invoke transport are required');
  }
  const mission = unwrap(await invoke({ command: 'inspect', mission_id: missionId }));
  if (!plainObject(mission) || mission.id !== missionId || mission.status !== 'completed'
      || !plainObject(mission.artifact) || !DIGEST.test(mission.artifact.digest)
      || mission.artifact.validation?.passed !== true) {
    throw new Error('Plugin construction requires a completed, validated committed mission');
  }
  const artifactDigest = mission.artifact.digest;
  if (!Array.isArray(mission.events) || !mission.events.some((event) => event.event_type === 'artifact.committed'
      && event.mission_id === missionId && event.data?.artifact_digest === artifactDigest)) {
    throw new Error('Committed artifact provenance is missing');
  }
  const capabilityIds = mission.spec?.capabilities;
  if (!Array.isArray(capabilityIds) || !capabilityIds.length || capabilityIds.length > CAPABILITIES.length
      || new Set(capabilityIds).size !== capabilityIds.length || capabilityIds.some((id) => !CAPABILITIES.includes(id))) {
    throw new Error('Mission capability bindings are unsupported or malformed');
  }
  const actions = capabilityIds.map((capabilityId) => {
    const name = `YUR_FOUNDRY_${capabilityId.replaceAll('.', '_').toUpperCase()}`;
    return Object.freeze({
      name,
      description: `Execute committed ${capabilityId} using message.content.factoryInput. Mission and capability are fixed by the host.`,
      similes: [],
      examples: [],
      validate: async (_runtime, message) => {
        try { extractInput(message, capabilityId); return true; } catch { return false; }
      },
      handler: async (_runtime, message, _state, _options, callback) => {
        try {
          const input = extractInput(message, capabilityId);
          const result = unwrap(await invoke({ command: 'run', mission_id: missionId, capability_id: capabilityId, input }));
          const receipt = result?.receipt;
          if (!plainObject(result) || !MISSION_ID.test(result.run_id) || !plainObject(result.output)
              || !plainObject(receipt) || receipt.event_type !== 'execution.completed'
              || receipt.mission_id !== missionId || !DIGEST.test(receipt.hash)
              || receipt.data?.capability_id !== capabilityId || receipt.data?.run_id !== result.run_id
              || receipt.data?.artifact_digest !== artifactDigest) {
            throw new Error('Execution response is not bound to the committed mission and capability');
          }
          const data = { mission_id: missionId, capability_id: capabilityId, run_id: result.run_id,
            output: result.output, receipt };
          const text = JSON.stringify({ output: result.output, receipt });
          if (typeof callback === 'function') {
            try { await callback({ text, actions: [name], source: 'yur-foundry' }); }
            catch { data.callback_delivery_failed = true; }
          }
          return { success: true, text, data };
        } catch (error) {
          return { success: false, text: 'The bound specialist could not complete this request.',
            error: error instanceof Error ? error.message.slice(0, 250) : 'Factory execution failed' };
        }
      },
    });
  });
  return Object.freeze({ name: `yur-foundry-${missionId}`, description: 'Committed local specialist capabilities for the YUR agent runtime.',
    actions: Object.freeze(actions), dependencies: Object.freeze([]) });
}

/** Bounded local Python RPC. This transport has no submit, publish or deploy command. */
export function createLocalTransport({ python, sourceRoot, stateRoot, timeoutMs = 30_000,
  maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!boundedString(python, 1, 4096) || /[\r\n\0]/.test(python) || python.startsWith('-')
      || typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)
      || typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) {
    throw new Error('Explicit Python executable and absolute sourceRoot/stateRoot are required');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 16 || maxResponseBytes > 4_000_000) {
    throw new Error('Transport time and byte limits are outside permitted bounds');
  }
  return async (request) => {
    const safe = jsonCopy(request);
    if (!fields(safe, safe.command === 'inspect' ? ['command', 'mission_id'] : ['command', 'mission_id', 'capability_id', 'input'])
        || !['inspect', 'run'].includes(safe.command) || !MISSION_ID.test(safe.mission_id)
        || (safe.command === 'run' && (!CAPABILITIES.includes(safe.capability_id) || !validInput(safe.capability_id, safe.input)))) {
      throw new Error('Transport permits only bounded inspect and run requests');
    }
    const payload = JSON.stringify(safe);
    return new Promise((resolve, reject) => {
      // Keep provider secrets and Python path overrides out of this pure worker.
      const env = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LOCALAPPDATA']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      Object.assign(env, { YUR_FACTORY_HOME: stateRoot, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' });
      const child = spawn(python, ['-B', '-m', 'foundry.factory_cli', 'rpc'], {
        cwd: sourceRoot, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settled = false;
      let abortError = null;
      let abortTimer;
      let bytes = 0;
      const chunks = [];
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(abortTimer);
        if (error) { child.kill(); reject(error); } else resolve(value);
      }
      function abort(error) {
        if (settled || abortError) return;
        abortError = error;
        child.kill();
        // Normally close arrives immediately; retain a bounded shutdown fallback.
        abortTimer = setTimeout(() => finish(error), 1000);
      }
      const timer = setTimeout(() => abort(new Error('Factory transport timed out')), timeoutMs);
      child.on('error', () => finish(new Error('Factory Python process could not start')));
      child.stdin.on('error', () => finish(new Error('Factory input channel failed')));
      child.stdout.on('data', (chunk) => {
        if (abortError) return;
        bytes += chunk.length;
        if (bytes > maxResponseBytes) abort(new Error('Factory response exceeds the byte boundary'));
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) abort(new Error('Factory response exceeds the byte boundary'));
      });
      child.on('close', (code) => {
        if (settled) return;
        if (abortError) { finish(abortError); return; }
        try {
          const response = jsonCopy(JSON.parse(Buffer.concat(chunks).toString('utf8')), maxResponseBytes, 32);
          if (!plainObject(response) || typeof response.ok !== 'boolean'
              || (response.ok && (code !== 0 || !Object.hasOwn(response, 'result')))
              || (!response.ok && !plainObject(response.error))) throw new Error('Invalid response');
          finish(null, response);
        } catch { finish(new Error('Factory process returned an invalid response')); }
      });
      child.stdin.end(payload);
    });
  };
}
