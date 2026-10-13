'use strict';
// Real installed gateway and Franklin adapter; isolated profile/workspace and
// deterministic localhost providers. No Desktop window or paid model is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRc6Transport } = require('../src/rc6-transport');
const { createFranklinCoding } = require('../src/franklin-coding');
const binding = require('../src/glider-rc6-binding.json');
const { startModelFixture } = require('./fixtures/rc6-approval-model.cjs');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-coding-native-'));
const evidence = path.join(profile, 'evidence'), workspace = path.join(profile, 'selected-workspace');
fs.mkdirSync(evidence); fs.mkdirSync(workspace);
const counter = path.join(profile, 'provider-calls.jsonl'), pidFile = path.join(profile, 'provider-pids.jsonl');
const canary = 'SYNTHETIC_FRANKLIN_FILE_' + crypto.randomBytes(16).toString('hex');
const canaryPath = path.join(workspace, 'approval-acceptance.awareness'); fs.writeFileSync(canaryPath, canary);
const providerScript = path.join(__dirname, 'fixtures/rc6-approval-mcp.cjs');
const mcpConfig = path.join(profile, 'mcp_servers.json');
fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'yur-knowledge': {
  command: process.execPath, args: [providerScript, canaryPath, counter, pidFile], enabled: true,
} } }));
const sources = ['src/franklin-coding.js', 'src/rc6-transport.js', 'src/glider-rc6-binding.json',
  'tests/franklin-coding-native.cjs', 'tests/fixtures/rc6-approval-model.cjs', 'tests/fixtures/rc6-approval-mcp.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')]));
const checks = [], nativeEvents = [], adapterEvents = [], modelRequests = [], wire = [], children = [];
const receipt = { started_at: new Date().toISOString(), profile, workspace, gateway_expected_sha256: binding.sha256,
  source_before: hashes(), checks, limitations: [
    'Real installed gateway and adapter; deterministic localhost model and knowledge provider.',
    'Tests actual governed reading of an isolated synthetic file. It does not certify arbitrary code generation, writes, deployment, or model quality.',
    'No Desktop UI acceptance; native human decisions are represented by explicit test calls to the human-only adapter method.',
    'Only the spawned test gateway receives the isolated synthetic MCP registry. Installed configuration and occupied sessions are untouched.',
  ] };
let model, runtime, adapter, nextAction = 0, deadline;
const owner = {}, identity = () => ({ owner, request_id: crypto.randomUUID(), mission_id: 'a'.repeat(32),
  action_id: (++nextAction).toString(16).padStart(32, '0'), isActive: () => true });
const count = () => fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const withoutReasoning = (key, value) => /^(reasoning|thinking)(?:_|$)/i.test(key) ? undefined : value;
const save = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, withoutReasoning, 2));
const call = (action, payload, scope = identity()) => adapter.execute(action, payload, scope);
async function waitFor(sessionId, predicate, label) {
  const expires = Date.now() + 90000;
  while (Date.now() < expires) {
    const result = await call('coding_wait', { session_id: sessionId, timeout_ms: 25000 });
    if (predicate(result)) return result;
    if (['failed', 'stale', 'uncertain', 'cancelled', 'completed'].includes(result.status)) {
      throw new Error(label + ' ended unexpectedly: ' + JSON.stringify(result));
    }
    if (result.status === 'awaiting_approval') throw new Error(label + ' encountered an additional native approval');
  }
  throw new Error('Native acceptance timed out: ' + label);
}
async function startSession() {
  return call('coding_start', { runtime_key: 'rc6', workspace, model: 'ollama:' + model.model });
}
async function caseRequest(label) {
  const session = await startSession(), beginning = nativeEvents.length;
  const submitScope = identity();
  await call('coding_submit', { session_id: session.session_id, role: label,
    text: 'Acceptance ' + label + ': read the synthetic awareness key approval-acceptance exactly once through the knowledge tool. No file changes.' }, submitScope);
  const pending = await waitFor(session.session_id, value => value.status === 'awaiting_approval', label + ' approval');
  const challenge = nativeEvents.slice(beginning).find(event => event.payload?.kind === 'ApprovalRequest' && (event.session_id || event.payload.session_id) === session.session_id);
  assert(challenge, 'Native gateway must produce an exact scoped approval request');
  assert.equal(challenge.payload.tool.name, 'mcp_yur_knowledge_read_awareness');
  assert(challenge.payload.argument_digest); assert(challenge.payload.authority_envelope.envelope_id);
  assert.equal(pending.pending_approvals[0].request_id, challenge.payload.request_id);
  assert.equal(pending.pending_approvals[0].human_review_required, true);
  return { session, beginning, submitScope, challenge };
}

(async () => {
  let failure;
  try {
    model = await startModelFixture(value => modelRequests.push(value));
    runtime = createRc6Transport({ profile: path.join(profile, 'runtime'),
      environment: { ...process.env, YUR_GLIDER_MODEL: model.model, YUR_GLIDER_PROVIDER_URL: model.origin + '/v1' },
      onEvent(event) { nativeEvents.push(event); adapter?.ingest(event); },
      spawnProcess(executable, args, options) {
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), binding.sha256);
        const child = spawn(executable, args, { ...options, env: { ...options.env,
          YUR_MCP_CONFIG_PATHS_JSON: JSON.stringify([mcpConfig]), CUSTOM_API_KEY: 'synthetic-local-fixture', OPENAI_API_KEY: 'synthetic-local-fixture',
          YUR_AWARENESS_DIR: path.join(profile, 'unused-awareness'), YUR_SQLITE_PATH: path.join(profile, 'unused-synthetic.db'),
        } });
        children.push(child);
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (chunk, ...rest) => { try { wire.push(JSON.parse(String(chunk))); } catch {} return write(chunk, ...rest); };
        child.stderr.on('data', chunk => fs.appendFileSync(path.join(profile, 'gateway-diagnostics.log'), chunk));
        return child;
      },
    });
    runtime.chooseWorkspace(workspace);
    adapter = createFranklinCoding({ runtime, resolveSelection: selection => {
      assert.equal(selection, 'ollama:' + model.model); return { model: model.model, baseUrl: model.origin + '/v1' };
    }, onEvent: value => adapterEvents.push(value) });
    deadline = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill(); }, 210000);
    const bootstrap = await startSession(); assert.equal(bootstrap.status, 'ready');
    const foreign = await runtime.createSession();
    const foreignBefore = await runtime.console(foreign.session_id, 'pwd'); assert.equal(foreignBefore.code, 0);
    await assert.rejects(call('coding_submit', { session_id: foreign.session_id, text: 'Do not run' }), /does not belong/);
    await assert.rejects(call('coding_cancel', { session_id: foreign.session_id }), /does not belong/);
    checks.push('Actual gateway creates dedicated Franklin sessions; adapter rejects submission or cancellation against a separate operator session');

    const denied = await caseRequest('deny'); assert.equal(count(), 0);
    await adapter.approval(denied.session.session_id, denied.challenge.payload.request_id, 'deny', owner);
    const deniedResult = await waitFor(denied.session.session_id, value => value.status === 'completed', 'denied turn completion');
    assert.equal(count(), 0); assert.equal(JSON.stringify(modelRequests).includes(canary), false);
    const deniedReceipt = nativeEvents.slice(denied.beginning).find(event => event.type === 'approval.denied')?.payload.receipt;
    assert.equal(deniedReceipt?.approved, false); assert.equal(deniedReceipt?.data_read, false); assert.equal(deniedReceipt?.execution_count, 0);
    assert(deniedResult.events.some(event => event.type === 'approval.denied' && event.execution_count === 0));
    checks.push('Native denial reads no file, sends no canary to the synthetic model, and returns an observed zero-execution receipt through the adapter');

    const approved = await caseRequest('approve'); assert.equal(count(), 0);
    await adapter.approval(approved.session.session_id, approved.challenge.payload.request_id, 'approve', owner);
    const approvedResult = await waitFor(approved.session.session_id, value => value.status === 'completed', 'approved turn completion');
    assert.equal(count(), 1); assert(approvedResult.output.includes(canary));
    const approvalReceipt = nativeEvents.slice(approved.beginning).find(event => event.type === 'approval.receipt')?.payload.receipt;
    assert.equal(approvalReceipt?.approved, true); assert.equal(approvalReceipt?.data_read, true);
    assert.equal(approvalReceipt?.execution_count, 1); assert.equal(approvalReceipt?.validation, 'passed');
    const exactDecision = wire.find(value => value.method === 'approval.respond' && value.params.request_id === approved.challenge.payload.request_id);
    assert.deepEqual(exactDecision.params, { session_id: approved.session.session_id, request_id: approved.challenge.payload.request_id, choice: 'approve',
      argument_digest: approved.challenge.payload.argument_digest, destination_model: approved.challenge.payload.destination.model,
      authority_envelope_id: approved.challenge.payload.authority_envelope.envelope_id });
    assert(approvedResult.events.some(event => event.type === 'approval.receipt' && event.execution_count === 1 && event.validation === 'passed'));
    checks.push('Native approval reads the actual isolated file exactly once; exact immutable scope reaches the gateway and verified public evidence returns through Franklin');
    await assert.rejects(adapter.approval(approved.session.session_id, approved.challenge.payload.request_id, 'approve', owner), /absent/);
    await assert.rejects(call('coding_submit', { session_id: approved.session.session_id, text: 'Repeat forbidden' }, approved.submitScope), /already used/);
    assert.equal(count(), 1);
    checks.push('Repeated approval and repeated submit identity cannot execute again');

    const foreignAfter = await runtime.console(foreign.session_id, 'pwd'); assert.equal(foreignAfter.code, 0);
    assert.equal(foreignAfter.stdout, foreignBefore.stdout);
    assert(!wire.some(value => ['prompt.submit', 'session.interrupt'].includes(value.method) && value.params.session_id === foreign.session_id));
    checks.push('The separate operator session remains usable after Franklin work, with no prompt or interruption sent to it');
    runtime.stop();
    assert.equal((await call('coding_status', { session_id: approved.session.session_id })).status, 'stale');
    const reconnected = await startSession(); assert.notEqual(reconnected.session_id, approved.session.session_id);
    await assert.rejects(call('coding_submit', { session_id: approved.session.session_id, text: 'Stale session' }), /stale/);
    assert.equal(count(), 1); checks.push('Actual gateway stop/reconnect invalidates every earlier Franklin session');
    receipt.denial = deniedReceipt; receipt.approval = approvalReceipt;
    receipt.approved_result = approvedResult; receipt.runtime = { runtime_key: 'rc6', verified_digest: runtime.status().verifiedDigest };
  } catch (error) { failure = error; }
  finally {
    clearTimeout(deadline); runtime?.stop();
    for (const child of children) if (child.exitCode === null) child.kill();
    if (fs.existsSync(pidFile)) for (const row of fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean)) {
      try { const item = JSON.parse(row); if (item.script === providerScript) process.kill(item.pid); } catch {}
    }
    model?.close();
    receipt.source_after = hashes(); receipt.source_changed = sources.filter(file => receipt.source_before[file] !== receipt.source_after[file]);
    if (!failure && receipt.source_changed.length) failure = new Error('Adapter acceptance sources changed during the run.');
    receipt.finished_at = new Date().toISOString(); receipt.passed = !failure; receipt.provider_calls = count();
    if (failure) receipt.error = failure.stack || String(failure);
    save('native-receipt.json', receipt); save('native-events.json', nativeEvents); save('adapter-events.json', adapterEvents); save('wire.json', wire);
    save('synthetic-model-requests.json', modelRequests);
    console.log(JSON.stringify({ passed: receipt.passed, checks, provider_calls: count(), evidence, error: failure?.message }, null, 2));
    process.exitCode = failure ? 1 : 0;
  }
})();
