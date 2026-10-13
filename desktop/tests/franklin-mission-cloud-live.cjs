'use strict';
// Actual cloud Franklin -> installed RC6 -> one independently verified file.
// The only replacement is the native dialog's explicit test-scoped human policy;
// the diagnostic HTTP hop forwards Franklin request/response bytes unchanged.
const { app, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');
const sourceRoot = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-franklin-cloud-build-'));
const workspace = path.join(home, 'selected-workspace'); fs.mkdirSync(workspace);
const target = path.join(workspace, 'campaign-plan.md');
const electronProfile = path.join(home, 'electron');
fs.mkdirSync(path.join(electronProfile, 'rc6'), { recursive: true });
fs.writeFileSync(path.join(electronProfile, 'rc6', 'workspace-selection.json'), JSON.stringify({ workspace }));
const evidence = path.resolve(__dirname, '../../../evidence/glider-rc6/comprehensive/franklin-mission-execution-2026-10-05/live');
const attempt = path.join(evidence, 'attempt-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(attempt, { recursive: true });
const MODEL = 'deepseek-v4-pro:cloud', origin = 'http://127.0.0.1:11434';
const naturalRequest = process.argv.includes('--natural');
const marker = 'FRANKLIN_CAMPAIGN_' + randomUUID().replaceAll('-', '');
const instruction = `Role: Campaign planner. Work only in ${workspace.split(path.sep).join('/')}. Create exactly one file: ${target.split(path.sep).join('/')}. `
  + (naturalRequest ? 'Create the document through the existing governed file operations, then read it back to verify the saved file. '
    : 'Use the native write_file tool and then read_file to verify that same file. ')
  + 'Do not use terminal commands, delegation, network tools, other files, credentials, purchases, deployment or live outreach. '
  + 'Write an original, practical Markdown campaign plan for a fictional pool design business. Include the exact headings "# Campaign plan", "## Goal", "## Roles", "## Draft copy", and "## Validation checklist". '
  + 'Give a measurable campaign goal, three named functional roles, two short original draft messages, and a checklist explicitly requiring human review before any publishing or outreach. '
  + `Include the acceptance marker ${marker} in the document. Keep the file under 12000 UTF-8 bytes. `
  + 'After the native committed write and readback, report the file path and the actual validation/commit outcome. This assignment authorizes drafting only.';
const typedPrompt = `Complete this bounded build through the existing IntelliFlow coding harness. Do not stop at a plan or capability listing. `
  + `The current selected workspace is ${workspace}. First discover desktop_capabilities and coding_catalog. `
  + 'Commit a small mission plan with the Campaign planner role using create_artifact with name "mission-plan.md", media_type "text/markdown" and your concise plan in content. '
  + 'Start the existing coding harness using desktop_action with exactly this arguments object: '
  + JSON.stringify({ action: 'coding_start', payload: { runtime_key: 'rc6', workspace, model: 'ollama:' + MODEL } }) + '. '
  + 'Then submit through desktop_action using exactly the following arguments object, replacing only SESSION_ID_FROM_CODING_START with the returned session_id. '
  + 'The payload keys are session_id, role and text. The tool requires text; do not substitute code or prompt. Preserve the role and the decoded text string exactly. '
  + JSON.stringify({ action: 'coding_submit', payload: { session_id: 'SESSION_ID_FROM_CODING_START', role: 'Campaign planner', text: instruction } }) + '\n'
  + 'Use coding_wait and coding_status to inspect the actual native result, continuing within your step budget until the worker finishes or reports a real blocker. '
  + 'Return the actual created file path and observed commit/validation evidence. No live calls, messages, publication, deployment, provisioning or purchases are authorized.';
const prompt = naturalRequest
  ? `Please use IntelliFlow to build campaign-plan.md in the currently selected workspace, ${workspace.split(path.sep).join('/')}. `
    + `Assign a dedicated Campaign planner using the currently configured ${MODEL} cloud model. Save a short mission plan first, `
    + 'then have the planner produce the actual document and verify the saved result. This is drafting only; no campaign is to be launched. '
    + 'Give the Campaign planner this approved paragraph verbatim as its complete assignment:\n\n'
    + instruction + '\n\n'
    + 'After the worker finishes, inspect its actual result and tell me the saved file path and whether validation and commit succeeded. '
    + 'If a real blocker prevents the file from being created, explain that blocker. Do not substitute a proposal or catalog listing for the requested file.'
  : typedPrompt;
const sources = ['src/main.js', 'src/preload.js', 'src/franklin-host.js', 'src/franklin-transport.js', 'src/franklin-view.js',
  'src/franklin-execution.js', 'src/franklin-coding.js', 'src/franklin-surfaces.js', 'src/rc6-transport.js', 'src/glider-rc6-binding.json',
  'foundry/work_desktop.py', 'foundry/franklin_cli.py', 'foundry/franklin_store.py', 'foundry/work_engine.py', 'foundry/work_tools.py', 'foundry/commit_service.py'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprints = () => Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(sourceRoot, file)))]));
const withoutReasoning = (key, value) => /^(reasoning|thinking)(?:_|$)/i.test(key) ? undefined : value;
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, withoutReasoning, 2));
const receipt = { started_at: new Date().toISOString(), home, workspace, target, attempt, model: MODEL,
  request_style: naturalRequest ? 'natural-language-with-verbatim-worker-brief' : 'typed-reference-payloads',
  provider: 'Existing local Ollama route to configured cloud model', checks: [], dialogs: [], source_before: fingerprints(),
  scope: 'Create and verify one isolated campaign-plan.md through actual Franklin and installed RC6. No deployment or live outreach.',
  limitations: ['Native dialog answers implement only the explicitly preauthorized test scope; no blanket native approval.',
    'A generated campaign plan is an actual local artifact, not a launched campaign, deployed software, business operation or financial result.'] };
let win, deadline, finished = false, approvedStart = 0, approvedSubmit = 0, lastProgress = '';
// Transparent test-only forwarding: never persist request/response bodies, content,
// reasoning, arbitrary argument values, credentials, or unknown property names.
receipt.model_diagnostics = [];
function argumentShape(value, schema, field = '$', depth = 0) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const row = { field, type, issues: [] };
  if (schema.type && schema.type !== type && !(schema.type === 'number' && type === 'integer')) row.issues.push('type');
  if (schema.enum && !schema.enum.includes(value)) row.issues.push('enum');
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) row.issues.push('minimum');
    if (schema.maximum !== undefined && value > schema.maximum) row.issues.push('maximum');
    if (field === '$.payload.timeout_ms' && Number.isFinite(value)) row.timeout_ms = Math.max(-1000000000, Math.min(1000000000, value));
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) row.issues.push('minLength');
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) row.issues.push('maxLength');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) row.issues.push('pattern');
  }
  const rows = [row];
  if (type === 'object' && depth < 4) {
    const properties = schema.properties || {}, keys = Object.keys(value);
    row.unknown_property_count = keys.filter(key => !Object.hasOwn(properties, key)).length;
    if (row.unknown_property_count && schema.additionalProperties === false) row.issues.push('additionalProperties');
    row.missing = (schema.required || []).filter(key => Object.hasOwn(properties, key) && !Object.hasOwn(value, key));
    for (const key of Object.keys(properties)) if (Object.hasOwn(value, key)) rows.push(...argumentShape(value[key], properties[key], field + '.' + key, depth + 1));
  }
  return rows;
}
const diagnosticsProxy = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  const chunks = []; let total = 0;
  request.on('data', chunk => { total += chunk.length; if (total > 1024 * 1024) request.destroy(); else chunks.push(chunk); });
  request.on('end', () => {
    const raw = Buffer.concat(chunks), schemas = new Map();
    try { for (const tool of JSON.parse(raw).tools || []) if (tool.type === 'function') schemas.set(tool.function.name, tool.function.parameters); }
    catch { response.writeHead(400).end(); return; }
    const entry = { sequence: receipt.model_diagnostics.length + 1, request_sha256: hash(raw), calls: [] };
    receipt.model_diagnostics.push(entry);
    const upstream = http.request(origin + request.url, { method: 'POST', headers: { ...request.headers, host: new URL(origin).host }, timeout: 120000 }, result => {
      const received = []; let bytes = 0;
      result.on('data', chunk => { bytes += chunk.length; if (bytes > 512 * 1024) result.destroy(); else received.push(chunk); });
      result.on('end', () => {
        const body = Buffer.concat(received); entry.http_status = result.statusCode; entry.response_sha256 = hash(body);
        try {
          const completion = JSON.parse(body);
          for (const call of completion.choices?.[0]?.message?.tool_calls?.slice(0, 8) || []) {
            const fn = call.function, schema = schemas.get(fn?.name), row = { tool: schema ? fn.name : 'unregistered' };
            if (schema) {
              try {
                const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
                row.fields = argumentShape(args, schema);
                if (fn.name === 'desktop_action' && schema.properties?.action?.enum?.includes(args?.action)) row.action = args.action;
              } catch { row.arguments_invalid_json = true; }
            }
            entry.calls.push(row);
          }
        } catch { entry.response_invalid_json = true; }
        save(path.join(attempt, 'model-diagnostics.json'), receipt.model_diagnostics);
        response.writeHead(result.statusCode, result.headers); response.end(body);
      });
      result.on('error', () => { entry.transport_error = 'upstream_response'; response.destroy(); });
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { entry.transport_error = 'upstream_request'; response.destroy(); });
    upstream.end(raw);
  });
});
const diagnosticReady = new Promise((resolve, reject) => {
  diagnosticsProxy.once('error', reject);
  diagnosticsProxy.listen(0, '127.0.0.1', () => {
    process.env.YUR_FRANKLIN_OPENAI_URL = 'http://127.0.0.1:' + diagnosticsProxy.address().port + '/v1'; resolve();
  });
});
process.env.YUR_GLIDER_RC6 = '1'; process.env.YUR_HARNESS_AUTOSTART = '0';
process.env.YUR_DESKTOP_HOME = path.join(home, 'conversations'); process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
process.env.APPDATA = path.join(home, 'appdata'); process.env.YUR_COPILOT_LIBRARY = path.join(home, 'unused-copilot');
process.env.YUR_WORKFORCE_SOURCE = path.join(home, 'unused-workforce');
process.env.YUR_FACTORY_PYTHON = require('../src/desktop-runtime').desktopPython(sourceRoot);
process.env.PYTHONDONTWRITEBYTECODE = '1'; process.env.YUR_OLLAMA_URL = origin;
process.env.YUR_FRANKLIN_OPENAI_URL = origin + '/v1'; process.env.YUR_FRANKLIN_MODEL = MODEL;
process.env.YUR_GLIDER_MODEL = MODEL; process.env.YUR_GLIDER_PROVIDER_URL = origin + '/v1';
app.setPath('userData', electronProfile); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('mute-audio');
const exactTarget = value => typeof value === 'string' && path.resolve(workspace, value).toLowerCase() === target.toLowerCase();

dialog.showMessageBox = async (_owner, options) => {
  const row = { at: new Date().toISOString(), title: options.title, approved: false, reason: 'Outside the preauthorized test scope' };
  try {
    if (options.title === 'Franklin · Confirm mission action') {
      const split = options.detail.indexOf('\n\n'), end = options.detail.indexOf('\n\nMission:');
      const action = options.detail.slice(0, split), payload = JSON.parse(options.detail.slice(split + 2, end));
      row.action = action; row.payload_sha256 = hash(JSON.stringify(payload));
      if (action === 'coding_start' && approvedStart === 0 && payload.runtime_key === 'rc6'
          && path.resolve(payload.workspace).toLowerCase() === workspace.toLowerCase() && payload.model === 'ollama:' + MODEL) {
        row.approved = true; row.reason = 'Exact selected isolated workspace and configured cloud model'; approvedStart++;
      } else if (action === 'coding_submit' && approvedSubmit === 0 && payload.text === instruction && payload.role === 'Campaign planner'
          && /^[A-Za-z0-9_.:-]{1,200}$/.test(payload.session_id)) {
        row.approved = true; row.reason = 'Exact one-file Campaign planner assignment'; row.session_id = payload.session_id; approvedSubmit++;
      } else if (action === 'coding_submit') {
        row.reason = 'Worker instruction or role differed from the exact preauthorized assignment';
        row.matches_text = payload.text === instruction; row.role = payload.role;
      }
    } else if (options.title === 'Franklin · IntelliFlow action') {
      const challenge = JSON.parse(options.detail), tool = challenge.tool || {};
      const args = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments || challenge.arguments;
      row.tool = tool.name; row.request_id = challenge.request_id; row.argument_digest = challenge.argument_digest;
      const selected = args && (args.path ?? args.file_path);
      const keys = args && typeof args === 'object' ? Object.keys(args) : [];
      const allowed = tool.name === 'read_file' ? ['path', 'file_path'] : ['path', 'file_path', 'content', 'encoding'];
      if (['read_file', 'write_file'].includes(tool.name) && exactTarget(selected) && keys.every(key => allowed.includes(key))
          && (tool.name === 'read_file' || typeof args.content === 'string' && Buffer.byteLength(args.content) <= 12000 && args.content.includes(marker))) {
        row.approved = true; row.reason = 'Exact isolated campaign document read/write';
      }
    }
  } catch { row.reason = 'Approval scope could not be matched to the preauthorized test'; }
  receipt.dialogs.push(row); save(path.join(attempt, 'progress.json'), { updated_at: row.at, home, dialogs: receipt.dialogs, checks: receipt.checks });
  console.log(JSON.stringify({ native_dialog: row.action || row.tool || row.title, approved: row.approved, reason: row.reason }));
  return { response: row.approved ? 1 : 0 };
};
const evaluate = code => win.webContents.executeJavaScript('(()=>{' + code + '})()', true);
async function until(test, label, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error('Timed out: ' + label);
}
const waitUi = (expression, label, ms) => until(() => evaluate('return ' + expression), label || expression, ms);
async function collect() {
  if (!win || win.isDestroyed()) return;
  const status = await evaluate('return window.studio.franklin.snapshot();');
  if (status.ok) {
    receipt.snapshot = status.result;
    const request = status.result.requests.at(-1);
    if (request?.mission_id) {
      const inspected = await evaluate(`return window.studio.work.inspect(${JSON.stringify(request.mission_id)});`);
      if (inspected.ok) {
        const { messages, ...mission } = inspected.result.mission;
        receipt.mission = mission; receipt.work_events = inspected.result.events;
      }
    }
  }
  receipt.native_events = await evaluate('return window.__nativeBuildEvents || [];');
  receipt.franklin_events = await evaluate('return window.__franklinBuildEvents || [];');
  const runtime = await evaluate('return window.studio.rc6.status();'); if (typeof runtime.running === 'boolean') receipt.runtime = runtime;
}
function captureActualBuild() {
  const build = receipt.actual_build = { exists: fs.existsSync(target), franklin_status: receipt.snapshot?.requests?.at(-1)?.status };
  if (!build.exists) return;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target).toLowerCase() !== target.toLowerCase() || stat.size > 12000) {
    build.inspection_error = 'Target failed the isolated regular bounded file check'; return;
  }
  const bytes = fs.readFileSync(target), content = bytes.toString('utf8');
  build.file = { path: target, bytes: bytes.length, sha256: hash(bytes),
    verified_headings: ['# Campaign plan', '## Goal', '## Roles', '## Draft copy', '## Validation checklist'].every(heading => content.includes(heading)),
    acceptance_marker: content.includes(marker), human_review_required: /human review/i.test(content),
    only_workspace_file: JSON.stringify(fs.readdirSync(workspace)) === JSON.stringify(['campaign-plan.md']) };
  build.native_commits = (receipt.native_events || []).filter(event => event.type === 'authority.commit' && event.payload?.tool_name === 'write_file'
    && event.payload.receipt?.status === 'committed').map(event => event.payload.receipt);
  build.commit_matches_file = build.native_commits.some(row => row.after_hash === build.file.sha256 && row.before_hash === 'MISSING'
    && row.commit_id && row.verdict_id && row.changed_paths.length === 1 && exactTarget(row.changed_paths[0]));
  build.native_readback = (receipt.native_events || []).some(event => event.type === 'tool.complete' && event.payload?.name === 'read_file');
  build.franklin_observed_completion = (receipt.mission?.steps || []).some(step => step.tool === 'desktop_action'
    && ['coding_wait', 'coding_status'].includes(step.arguments?.action) && step.result?.result?.runtime_completed === true);
  build.worker_build_verified = bytes.length >= 200 && Object.entries(build.file).filter(([key]) => !['path', 'bytes', 'sha256'].includes(key)).every(([, value]) => value)
    && build.commit_matches_file && build.native_readback && build.franklin_observed_completion;
  fs.writeFileSync(path.join(attempt, 'campaign-plan.md'), bytes);
  save(path.join(attempt, 'actual-build-evidence.json'), build);
}
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  try {
    try { await Promise.race([collect(), new Promise((_, reject) => setTimeout(() => reject(new Error('Final evidence collection deadline')), 10000))]); } catch (issue) { receipt.collection_error = issue.message; }
    try { captureActualBuild(); } catch (issue) { receipt.build_evidence_error = issue.message; }
    try {
      if (win && !win.isDestroyed()) {
        if (receipt.snapshot?.active_request) await evaluate(`return window.studio.franklin.cancel({request_id:${JSON.stringify(receipt.snapshot.active_request.request_id)}});`);
        const disconnected = await evaluate('return window.studio.rc6.disconnect();');
        receipt.cleanup = { disconnected: disconnected.running === false };
      }
    } catch (issue) { receipt.cleanup = { disconnected: false, error: issue.message }; }
    receipt.source_after = fingerprints(); receipt.source_changed = sources.filter(file => receipt.source_before[file] !== receipt.source_after[file]);
    if (receipt.source_changed.length) error ||= new Error('Product source changed during acceptance: ' + receipt.source_changed.join(', '));
    if (!receipt.cleanup?.disconnected) error ||= new Error('Test gateway shutdown was not confirmed');
    receipt.completed_at = new Date().toISOString(); receipt.passed = !error; receipt.error = error?.stack;
    save(path.join(attempt, 'receipt.json'), receipt); save(path.join(evidence, 'latest.json'), receipt);
    console.log(JSON.stringify({ passed: !error, error: error?.message, checks: receipt.checks, attempt, home, file: receipt.file, cleanup: receipt.cleanup }));
  } catch (issue) {
    error ||= issue;
    console.error(JSON.stringify({ passed: false, evidence_finalization_error: issue.message, attempt }));
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    try { diagnosticsProxy.closeAllConnections(); } catch {}
    try { diagnosticsProxy.close(); } catch {}
    app.exit(error ? 1 : 0);
  }
}
async function test() {
  try {
    await diagnosticReady;
    const response = await fetch(origin + '/api/tags', { signal: AbortSignal.timeout(15000) }); assert.equal(response.ok, true);
    const catalog = await response.json(); assert.ok(catalog.models.some(item => item.name === MODEL), 'The selected cloud tag must exist before inference');
    receipt.catalog_verified_at = new Date().toISOString(); receipt.catalog_model = catalog.models.find(item => item.name === MODEL).name;
    const entered = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await evaluate('setTimeout(()=>window.studio.launch.enter(),25);'); await entered;
    await waitUi(`!!document.getElementById('franklin-toggle')&&!document.getElementById('franklin-input').disabled`);
    await evaluate(`document.getElementById('franklin-toggle').click();`);
    await waitUi(`!document.getElementById('franklin-model').disabled`);
    const configured = await evaluate(`return window.studio.franklin.configure({model:'openai:${MODEL}'});`); assert.equal(configured.ok, true);
    const selected = await evaluate('return window.studio.rc6.status();');
    assert.equal(selected.workspace, workspace); assert.equal(selected.running, false);
    assert.equal(selected.runtimeKey, 'rc6');
    await evaluate(`window.__nativeBuildEvents=[];window.__franklinBuildEvents=[];
      const scrub=(key,value)=>/^(reasoning|thinking)(?:_|$)/i.test(key)?undefined:value;
      window.studio.rc6.onEvent(event=>{if(/^(tool\\.|authority\\.|approval\\.|message\\.complete|error|bridge\\.)/.test(event.type))
        window.__nativeBuildEvents.push(JSON.parse(JSON.stringify(event,scrub)));});
      window.studio.franklin.onEvent(event=>{if(!/^(reasoning|thinking)/.test(event.type)&&event.type!=='message.delta')
        window.__franklinBuildEvents.push(JSON.parse(JSON.stringify(event,scrub)));});`);
    await evaluate(`const input=document.getElementById('franklin-input');input.value=${JSON.stringify(prompt)};input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await waitUi(`!document.getElementById('franklin-send').disabled`);
    await evaluate(`document.querySelector('.yur-franklin-form').requestSubmit();`);
    await until(async () => {
      const state = await evaluate(`return {terminal:window.__franklinBuildEvents.find(e=>/^turn\\./.test(e.type)),
        latest:window.__franklinBuildEvents.at(-1)?.type,native:window.__nativeBuildEvents.at(-1)?.type};`);
      const progress = JSON.stringify({ phase: state.latest, native: state.native, file_exists: fs.existsSync(target) });
      if (progress !== lastProgress) { lastProgress = progress; console.log(progress); }
      return Boolean(state.terminal);
    }, 'actual cloud Franklin and coding completion', 310000);
    await collect();
    assert.equal(receipt.snapshot.requests.at(-1).status, 'completed', 'Franklin request must finish');
    assert.equal(approvedStart, 1, 'Franklin must create one approved native session');
    assert.equal(approvedSubmit, 1, 'Franklin must submit the exact bounded assignment once');
    assert.equal(receipt.runtime.model, MODEL); assert.equal(receipt.runtime.baseUrl, origin + '/v1');
    assert.equal(receipt.runtime.verifiedDigest, require('../src/glider-rc6-binding.json').sha256);
    receipt.checks.push('Actual configured cloud model completes Franklin tool calling and one exact assignment to the verified installed RC6 runtime using the same cloud model');
    const stat = fs.lstatSync(target); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(fs.realpathSync(target).toLowerCase(), target.toLowerCase());
    const bytes = fs.readFileSync(target), content = bytes.toString('utf8');
    assert.ok(bytes.length >= 200 && bytes.length <= 12000, 'Native worker must create a bounded substantive document');
    for (const heading of ['# Campaign plan', '## Goal', '## Roles', '## Draft copy', '## Validation checklist']) assert.ok(content.includes(heading), 'Missing required heading: ' + heading);
    assert.ok(content.includes(marker)); assert.match(content, /human review/i);
    assert.deepEqual(fs.readdirSync(workspace), ['campaign-plan.md']);
    fs.writeFileSync(path.join(attempt, 'campaign-plan.md'), bytes);
    receipt.file = { path: target, bytes: bytes.length, sha256: hash(bytes), marker, verified_headings: true, human_review_required: true };
    receipt.checks.push('Independent filesystem read confirms a newly created campaign-plan.md containing the required goal, roles, original draft copy, review checklist and unique acceptance marker; no other workspace files');
    const commits = receipt.native_events.filter(event => event.type === 'authority.commit' && event.payload?.receipt?.status === 'committed');
    assert.ok(commits.length >= 1, 'Actual native Commit Service receipt is required');
    for (const event of commits) assert.ok(event.payload.receipt.changed_paths.every(exactTarget), 'Native commit must remain on the exact campaign document');
    assert.ok(commits.some(event => event.payload.tool_name === 'write_file' && event.payload.receipt.commit_id && event.payload.receipt.verdict_id));
    receipt.native_commit_receipts = commits.map(event => event.payload.receipt);
    assert.ok(receipt.native_events.some(event => event.type === 'tool.complete' && event.payload?.name === 'read_file'), 'Worker must verify the created file through the native read tool');
    const steps = receipt.mission.steps;
    assert.ok(steps.some(step => step.tool === 'desktop_action' && step.arguments?.action === 'coding_submit'));
    assert.ok(steps.some(step => step.tool === 'desktop_action' && ['coding_wait', 'coding_status'].includes(step.arguments?.action)
      && step.result?.result?.runtime_completed === true));
    receipt.checks.push('Actual native write validation and Commit Service receipt identify the one changed file; worker readback and Franklin completed-status observation are retained');
    const verified = spawnSync(process.env.YUR_FACTORY_PYTHON, ['-B', '-c',
      "import json,os\nfrom pathlib import Path\nfrom foundry.commit_service import CommitService\nwith CommitService(Path(os.environ['YUR_DESKTOP_HOME'])) as store:\n print(json.dumps(store.verify_integrity()))"],
      { cwd: sourceRoot, windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' } });
    assert.equal(verified.status, 0, verified.stderr); receipt.integrity = JSON.parse(verified.stdout); assert.equal(receipt.integrity.ok, true);
    receipt.checks.push('Independent CommitService reader verifies the actual Franklin/Work journal after cloud execution');
    try { const image = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }), new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot deadline')), 3000))]); fs.writeFileSync(path.join(attempt, 'franklin-cloud-build.png'), image.toPNG()); } catch (error) { receipt.capture_limit = error.message; }
    await finish();
  } catch (error) { await finish(error); }
}
(async () => {
  app.on('browser-window-created', (_event, created) => {
    win = created; win.webContents.setBackgroundThrottling(false); win.setFocusable(false); win.setOpacity(0);
    win.setPosition(-16000, -16000); win.setSkipTaskbar(true); win.webContents.once('did-finish-load', test);
  });
  deadline = setTimeout(() => finish(new Error('Cloud build acceptance exceeded six minutes')), 360000);
  console.log(JSON.stringify({ started: true, model: MODEL, request_style: receipt.request_style, workspace, attempt }));
  require('../src/main');
})().catch(finish);
