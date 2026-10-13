'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// A minimal DOM records rendered nodes; innerHTML is deliberately forbidden.
// These tests do not run an execution cell or manufacture runtime acceptance.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this._text = ''; this.attributes = {}; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Model and process content must stay plain text'); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this._text = ''; this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { this.listeners ||= {}; this.listeners[name] = callback; }
  get childElementCount() { return this.children.length; }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function render(mission, options = {}) {
  const document = { createElement: name => new Node(name), createTextNode: value => { const node = new Node('#text'); node.textContent = value; return node; } };
  const sandbox = { window: {}, document };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/work-view.js'), 'utf8'), sandbox);
  const host = new Node('main'); sandbox.window.yurWorkView.renderMission(host, mission, options);
  return { host, nodes: descendants(host), view: sandbox.window.yurWorkView, find: name => descendants(host).find(node => node.className.split(' ').includes(name)) };
}
function mission(status = 'completed', exitCode = 0) {
  const snapshotId = 'a'.repeat(64), parentId = 'b'.repeat(32);
  return { id: parentId, status: 'completed', request: { mode: 'code', goal: 'Check the staged arithmetic edit' }, steps: [{
    tool: 'run_python_checks', succeeded: true, arguments: { files: ['src/add.py', 'tests/test_add.py'], profile: 'python-unittest-serial', test_directory: 'tests', proposal_ids: ['e'.repeat(32)] },
    result: { schema: 'yur.work-cell-result.v1', tool: 'run_python_checks', status: 'recorded', committed: true,
      execution: { schema: 'yur.execution-cell-result.v1', snapshot_id: snapshotId, profile: 'python-unittest-serial', status, exit_code: exitCode,
        stdout: 'captured standard output', stdout_bytes: 24, stdout_sha256: 'c'.repeat(64), stderr: 'captured diagnostic', stderr_bytes: 19, stderr_sha256: 'd'.repeat(64), duration_ms: 38, runtime: { test_adapter: true }, limits: { output_bytes_total: 65536 }, scratch: 'discarded' },
      snapshot: { id: snapshotId, profile: 'python-unittest-serial', sources: [{ path: 'src/add.py', original_sha256: '1'.repeat(64), staged_sha256: '2'.repeat(64), overlay: true }, { path: 'tests/test_add.py', original_sha256: null, staged_sha256: '3'.repeat(64), overlay: true }] },
      provenance: { parent_work_id: parentId, step_index: 0, input_hash: '4'.repeat(64), snapshot_receipt: '5'.repeat(64), result_receipt: '6'.repeat(64) } },
  }], artifacts: [] };
}

function pageMission(denied = false) {
  const source = { source_id: 'a'.repeat(36), source_url: 'https://example.test/report' };
  return { id: 'b'.repeat(32), request_id: 'c'.repeat(36), conversation_id: 'd'.repeat(36), status: 'completed',
    request: { mode: 'work', goal: 'Read selected report', browser_source: source }, artifacts: [], steps: [{
      tool: 'acquire_selected_page', succeeded: true, arguments: { source_id: source.source_id },
      result: { schema: 'yur.work-browser-result.v1', tool: 'acquire_selected_page', status: denied ? 'denied' : 'recorded', committed: true,
        context: denied ? null : { schema: 'yur.browser-context.v1', source_url: source.source_url, title: 'Measured report', text: 'Quantity 47 <script>host()</script>', sha256: 'f'.repeat(64), acquired_at: '2026-09-13T07:00:00Z', truncated: true, limits: { main_frame_only: true, form_fields_excluded: true } },
        error: denied ? { code: 'SOURCE_CHANGED', message: 'The selected document has changed.' } : null,
        provenance: { parent_work_id: 'b'.repeat(32), request_id: 'c'.repeat(36), conversation_id: 'd'.repeat(36), step_index: 0,
          acquisition_id: 'e'.repeat(32), input_sha256: '1'.repeat(64), source_sha256: '2'.repeat(64), authority_sha256: '3'.repeat(64), accepted_receipt: '4'.repeat(64), result_receipt: '5'.repeat(64) } },
    }] };
}
test('selected page card presents source text as plain text with its receipt and bounded coverage', async () => {
  const opened = [], view = render(pageMission(), { onLink: url => opened.push(url) });
  assert.equal(opened.length, 0);
  assert.match(view.find('yc-work-page-card').textContent, /Bounded excerpt/);
  assert.match(view.find('yc-work-page-source').textContent, /https:\/\/example.test\/report/);
  assert.equal(view.find('yc-work-page-text').textContent, 'Quantity 47 <script>host()</script>');
  assert.ok(view.find('yc-work-page-receipt').textContent.includes('5'.repeat(64)));
  await view.nodes.find(node => node.tagName === 'button' && node.textContent === 'Open source page').listeners.click();
  assert.deepEqual(opened, ['https://example.test/report']);
});
test('a committed page denial is displayed as a denial with no content or source action', () => {
  const view = render(pageMission(true), { onLink: () => assert.fail('Denial cannot open a source') });
  assert.match(view.find('yc-work-page-tool').textContent, /read denied/);
  assert.match(view.find('yc-work-page-card').textContent, /No page content was acquired/);
  assert.equal(view.find('yc-work-page-text'), undefined);
  assert.equal(view.nodes.some(node => node.textContent === 'Open source page'), false);
  assert.doesNotMatch(view.find('yc-work-page-tool').children[0].textContent, /completed|text acquired/);
});
test('unbound or unacknowledged page evidence never renders an acquired-page card', () => {
  const changes = [value => { value.steps[0].result.provenance.parent_work_id = 'x'.repeat(32); },
    value => { value.steps[0].result.provenance.result_receipt = 'invalid'; },
    value => { value.steps[0].result.context.source_url = 'https://unselected.test'; },
    value => { value.steps[0].result.committed = false; }];
  for (const change of changes) {
    const value = pageMission(); change(value); const view = render(value);
    assert.equal(view.find('yc-work-page-card'), undefined);
    assert.ok(view.host.textContent.includes('result not verified'));
  }
});

test('an acknowledged tool with a failed command shows its real exit status, source overlays and committed receipts', () => {
  const value = mission('failed', 1), view = render(value);
  assert.match(view.find('yc-cell-status').textContent, /Command failed · exit code 1/);
  assert.match(view.find('yc-cell-tool').children[0].textContent, /Command failed · exit 1/);
  assert.doesNotMatch(view.host.textContent, /tests passed|certified|Command completed/i);
  const sources = view.find('yc-cell-sources').textContent;
  for (const content of ['src/add.py', 'tests/test_add.py', 'Staged edit overlay', '1'.repeat(64), '2'.repeat(64), 'New file — no original bytes']) assert.ok(sources.includes(content), content);
  assert.ok(view.find('yc-cell-receipt').textContent.includes('6'.repeat(64)));
  assert.match(view.find('yc-code-help').textContent, /when an admitted execution runtime is available/);
  assert.match(view.host.textContent, /Staged edits did not change source files/);
});

test('completed means command exit zero, while timeout, cancellation and output exhaustion stay distinct', () => {
  const success = render(mission());
  assert.match(success.find('yc-cell-status').textContent, /Command completed · exit code 0/);
  assert.match(success.host.textContent, /selected command exited with code 0/);
  assert.doesNotMatch(success.host.textContent, /tests passed|certification/i);
  for (const [status, label] of [['timeout', 'Time limit reached'], ['output_limit', 'Output limit reached'], ['cancelled', 'Command cancelled']]) {
    const view = render(mission(status, -9)); assert.match(view.find('yc-cell-status').textContent, new RegExp(label)); assert.doesNotMatch(view.host.textContent, /Command completed/);
  }
});

test('uncommitted, cross-mission, mismatched-snapshot and inconsistent exit results do not receive a verified execution card', () => {
  const mutations = [value => { value.committed = false; }, value => { value.provenance.parent_work_id = 'f'.repeat(32); }, value => { value.provenance.step_index = 1; }, value => { value.execution.snapshot_id = '0'.repeat(64); }, value => { value.execution.profile = 'unrestricted-shell'; }, value => { value.execution.exit_code = 1; }, value => { delete value.provenance.result_receipt; }];
  for (const mutate of mutations) { const value = mission(); mutate(value.steps[0].result); const view = render(value); assert.equal(view.find('yc-cell-result'), undefined); assert.match(view.host.textContent, /Python checks · result not verified/); }
  const rejected = mission(); rejected.steps[0].succeeded = false; rejected.steps[0].result = { error: 'No admitted execution runtime' };
  const view = render(rejected); assert.equal(view.find('yc-cell-result'), undefined); assert.match(view.host.textContent, /Python checks · request rejected/);
});

test('process streams remain inert text with a truthful display bound, not Markdown or executable HTML', () => {
  const value = mission(); value.steps[0].result.execution.stdout = '<img src=x onerror=alert(1)><script>throw 1</script> **literal**'; value.steps[0].result.execution.stderr = 'z'.repeat(64000) + 'END_NOT_IN_PREVIEW';
  const view = render(value), output = view.find('yc-cell-stdout'), errors = view.find('yc-cell-stderr');
  assert.ok(output.textContent.includes(value.steps[0].result.execution.stdout));
  assert.equal(view.nodes.some(node => ['img', 'script', 'strong'].includes(node.tagName) && node.textContent.includes('literal')), false);
  assert.ok(errors.textContent.includes('[Preview limited to 32000 characters.]')); assert.equal(errors.textContent.includes('END_NOT_IN_PREVIEW'), false);
});

test('ordinary tools and artifacts retain their previous rendering', () => {
  const value = mission(); value.request.mode = 'work'; value.steps = [{ tool: 'read_file', succeeded: true, result: { content: 'ordinary source' } }]; value.artifacts = [{ id: 'f'.repeat(32), status: 'committed', proposal: { kind: 'artifact', name: 'report.md', media_type: 'text/markdown', content: '# Existing report' } }];
  const view = render(value); assert.match(view.host.textContent, /read_file · completed/); assert.match(view.host.textContent, /ordinary source/); assert.match(view.host.textContent, /# Existing report/); assert.equal(view.find('yc-code-help'), undefined);
});

test('late queue acknowledgment cannot downgrade a consumed correction, but fills missing committed queue evidence', () => {
  const { view } = render(mission());
  const local = { correction_id: 'a', text: 'Use the revised estimate.', status: 'submitting', queued_receipt: null, consumed_receipt: null };
  const consumedReceipt = { hash: 'b'.repeat(64), revision: 8 }, queuedReceipt = { hash: 'c'.repeat(64), revision: 6 };
  const consumed = view.mergeSteering(local, { correction_id: 'a', status: 'consumed', receipt: consumedReceipt, consumed_receipt: consumedReceipt });
  const late = view.mergeSteering(consumed, { correction_id: 'a', text: local.text, status: 'queued', queued_receipt: queuedReceipt, consumed_receipt: null });
  assert.equal(late.status, 'consumed'); assert.equal(late.queued_receipt.hash, queuedReceipt.hash); assert.equal(late.consumed_receipt.hash, consumedReceipt.hash);
  const ended = view.mergeSteering(local, { correction_id: 'a', status: 'not_consumed', queued_receipt: queuedReceipt });
  assert.equal(view.mergeSteering(ended, { correction_id: 'a', status: 'queued', queued_receipt: queuedReceipt }).status, 'not_consumed');
});

test('steering presentation rejects changed text, identity and receipt-free status claims', () => {
  const { view } = render(mission()); const local = { correction_id: 'a', text: 'Keep source unchanged.', status: 'submitting' }, receipt = { hash: 'b'.repeat(64), revision: 3 };
  for (const update of [{ correction_id: 'b', status: 'queued', queued_receipt: receipt }, { correction_id: 'a', text: 'Overwrite source.', status: 'queued', queued_receipt: receipt }, { correction_id: 'a', status: 'consumed' }]) assert.throws(() => view.mergeSteering(local, update), /identity|receipt/);
  const record = { mission: mission(), steering: [{ ...local, status: 'not_consumed', queued_receipt: receipt, consumed_receipt: null }] };
  const rendered = render(record); assert.match(rendered.find('yc-work-corrections').textContent, /Not consumed by the mission/); assert.match(rendered.find('yc-work-corrections').textContent, /Keep source unchanged/);
});

function constructionMission() {
  const value = mission(); value.request.mode = 'work';
  const source = { field: 'text', line: 2, start: 12, end: 17, text: '19.95' };
  value.steps = [{ tool: 'run_built_specialist', succeeded: true, result: { schema: 'yur.work-specialist-result.v1', tool: 'run_built_specialist', status: 'completed', committed: true, mission_id: 'e'.repeat(32), capability_id: 'construction.opc.inspect', provenance: { parent_work_id: value.id }, output: {
    method: 'quoted_opc_rows', assessment: 'quoted_arithmetic_only', requires_review: true, truncated: false,
    line_items: [{ item_number: '1.02', description: 'Anchor plates', quantity: '3', unit: 'EA', unit_price: '19.95', stated_total: '60.00', calculated_total: '59.85', difference: '0.15', arithmetic: 'mismatch', sources: { unit_price: source } }],
    source: { sha256: 'f'.repeat(64), bytes: 100, characters: 98, lines: 2, offset_unit: 'unicode-code-points' }, candidate_count: 1, excluded_count: 0, omitted_count: 0, unrecognized_lines: 0, excluded: [],
  } } }]; return value;
}

test('construction result shows quoted arithmetic, exact source spans and scope without claiming approval', () => {
  const rendered = render(constructionMission()), row = rendered.find('yc-construction-row');
  assert.equal(row.dataset.arithmetic, 'mismatch'); assert.match(row.textContent, /Anchor plates/); assert.match(row.textContent, /3 EA × 19.95 per EA/);
  for (const expected of ['Stated60.00', 'Calculated59.85', 'Difference0.15']) assert.ok(rendered.find('yc-construction-amounts').textContent.includes(expected));
  assert.match(rendered.find('yc-construction-quotes').textContent, /Unit price19.95Line 2 · characters 12–17/);
  assert.match(rendered.find('yc-construction-result').textContent, /Market rates, scope completeness and approvals were not assessed/);
  assert.ok(rendered.find('yc-construction-coverage').textContent.includes('f'.repeat(64))); assert.match(rendered.host.textContent, /Execution record/);
  assert.equal(rendered.nodes.some(node => node.tagName === 'button'), false, 'Presentation does not introduce export or apply actions');
});

test('construction exclusions, omissions and hostile quoted markup remain honest bounded text', () => {
  const value = constructionMission(), output = value.steps[0].result.output;
  const hostile = '<img src=x onerror=alert(1)><script>throw 1</script>';
  output.line_items[0].description = hostile; output.line_items[0].sources.unit_price.text = hostile;
  output.truncated = true; output.omitted_count = 7; output.excluded_count = 1; output.unrecognized_lines = 3;
  output.excluded = [{ reason: 'unsupported_unit', source: { line: 5, text: hostile }, source_truncated: true }];
  const rendered = render(value), result = rendered.find('yc-construction-result');
  assert.match(result.textContent, /7 records omitted/); assert.match(rendered.find('yc-construction-coverage').textContent, /Unrecognized source lines3/);
  assert.match(rendered.find('yc-construction-excluded').textContent, /unsupported unit/); assert.match(rendered.find('yc-construction-excluded').textContent, /source excerpt truncated/);
  assert.ok(rendered.find('yc-construction-quotes').textContent.includes(hostile)); assert.equal(rendered.nodes.some(node => ['img', 'script'].includes(node.tagName)), false);
  output.line_items = []; const empty = render(value); assert.match(empty.find('yc-construction-result').textContent, /No admitted six-field construction rows/);
});

function generatedMission(tool = 'forge_python_specialist') {
  const value = mission();
  const artifact = { sha256: 'a'.repeat(64), name: 'Generated quantity normalizer', description: 'Finite source-file acceptance contract.', input_schema: { type: 'object' }, output_schema: { type: 'object' }, source_sha256: 'c'.repeat(64), contract_sha256: 'd'.repeat(64), driver_sha256: 'e'.repeat(64) };
  const validation = { cases_total: 2, selected_strategy: 'direct', qualification: 'Finite acceptance cases cover only the declared input contract.', candidates: [{ strategy: 'direct', status: 'passed', passed: true, cases_passed: 2, cases_total: 2, source_sha256: artifact.source_sha256, structural_sha256: 'f'.repeat(64), error: '' }, { strategy: 'table', status: 'rejected', passed: false, cases_passed: 1, cases_total: 2, source_sha256: '1'.repeat(64), structural_sha256: '2'.repeat(64), error: 'Case 2 differed.' }] };
  const provenance = { parent_work_id: value.id, step_index: 0, input_hash: '3'.repeat(64), accepted_receipt: '4'.repeat(64), result_receipt: '5'.repeat(64) };
  const result = { schema: 'yur.work-generated-specialist-result.v1', tool, status: 'published', committed: true, artifact, validation, provenance };
  const selection = { source_work_id: '6'.repeat(32), build_step_index: 3, artifact_sha256: artifact.sha256, published_receipt: '7'.repeat(64), reason: 'Selected the exact previously published artifact.' };
  if (tool === 'run_python_specialist') Object.assign(result, { status: 'recorded', selection, output: { total: 12, label: 'Actual fresh input' }, error: '', qualification: validation.qualification, execution_receipt: '9'.repeat(64), execution: { profile: 'python-json-serial', status: 'completed', exit_code: 0, stdout: '{"total":12}', stderr: '', snapshot_id: '8'.repeat(64) } });
  if (tool === 'list_python_specialists') Object.assign(result, { status: 'discovered', committed: false, entries: [{ ...artifact, ...selection, validation }], scanned: 3, excluded: 2, next_cursor: 'cursor', coverage_limited: true });
  value.steps = [{ tool, succeeded: true, arguments: {}, result }]; value.artifacts = []; return value;
}

test('generated build distinguishes selected finite host acceptance from rejected candidates and retains contract receipts', () => {
  const value = generatedMission(), view = render(value), card = view.find('yc-generated-specialist');
  assert.equal(card.dataset.generatedStatus, 'published');
  assert.match(view.find('yc-generated-status').textContent, /Python specialist · published/);
  assert.match(card.textContent, /Selected candidate passed 2 of 2 host-checked acceptance cases/);
  assert.match(view.find('yc-generated-candidates').textContent, /directPassed · 2 of 2 cases/);
  assert.match(view.find('yc-generated-candidates').textContent, /tableRejected · 1 of 2 cases/);
  assert.match(card.textContent, /only the declared input contract/);
  for (const hash of ['a', 'c', 'd', 'e', '4', '5']) assert.ok(view.find('yc-generated-receipt').textContent.includes(hash.repeat(64)));
  assert.equal(view.nodes.some(node => node.tagName === 'button'), false, 'No old pack export, execution, or write actions are invented');
});

test('handled rejected generation is displayed rejected even though its host operation succeeded', () => {
  const value = generatedMission(), result = value.steps[0].result;
  result.status = 'rejected'; result.artifact = null; result.validation.selected_strategy = null;
  const view = render(value);
  assert.match(view.find('yc-generated-status').textContent, /build rejected/);
  assert.match(view.host.textContent, /No candidate was published/);
  assert.doesNotMatch(view.find('yc-work-steps').children[0].children[0].textContent, /completed|published/);
  assert.ok(view.find('yc-generated-receipt').textContent.includes('5'.repeat(64)));
});

test('generated publication requires parent, step, receipt, selected-source and case-result consistency', () => {
  for (const mutate of [result => { result.committed = false; }, result => { result.provenance.parent_work_id = '0'.repeat(32); }, result => { result.provenance.step_index = 1; }, result => { delete result.provenance.result_receipt; }, result => { result.validation.candidates[0].cases_passed = 1; }, result => { result.validation.candidates[0].source_sha256 = '0'.repeat(64); }, result => { result.validation.selected_strategy = 'missing'; }]) {
    const value = generatedMission(); mutate(value.steps[0].result); const view = render(value);
    assert.equal(view.find('yc-generated-specialist'), undefined); assert.match(view.host.textContent, /Python specialist · result not verified/);
  }
});

test('generated execution exposes actual output and rejects inconsistent selected identity without manufacturing success', () => {
  const value = generatedMission('run_python_specialist'), view = render(value);
  assert.match(view.find('yc-generated-output').textContent, /total12/);
  assert.match(view.find('yc-generated-status').textContent, /Command completed · exit 0/);
  value.steps[0].result.status = 'rejected'; value.steps[0].result.execution.status = 'failed'; value.steps[0].result.execution.exit_code = 1; value.steps[0].result.error = 'Execution returned the wrong output shape.';
  const rejected = render(value); assert.match(rejected.find('yc-generated-status').textContent, /run rejected · exit 1/); assert.equal(rejected.find('yc-generated-output'), undefined);
  value.steps[0].result.selection.artifact_sha256 = '0'.repeat(64);
  assert.equal(render(value).find('yc-generated-specialist'), undefined);
});

test('generated catalog uses original Work-step identity, bounded coverage, inert content and an explicit draft callback', async () => {
  const value = generatedMission('list_python_specialists');
  const hostile = '<img src=x onerror=alert(1)><script>throw 1</script>'; value.steps[0].result.entries[0].name = hostile;
  let selected; const view = render(value, { onUseGeneratedSpecialist: entry => { selected = entry; } });
  assert.ok(view.find('yc-generated-catalog').textContent.includes(hostile));
  assert.match(view.find('yc-generated-catalog').textContent, /Scanned 3 · excluded 2 · more records may remain/);
  assert.equal(view.nodes.some(node => ['img', 'script'].includes(node.tagName)), false);
  const button = view.nodes.find(node => node.tagName === 'button'); assert.equal(button.textContent, 'Use in Code conversation'); await button.listeners.click();
  assert.equal(selected.source_work_id, '6'.repeat(32)); assert.equal(selected.build_step_index, 3); assert.equal(selected.artifact_sha256, 'a'.repeat(64));
  assert.deepEqual(Object.keys(selected).sort(), ['artifact_sha256', 'build_step_index', 'name', 'source_work_id']);
});

test('generated source inspection checks the committed indexed build and publication receipt before presenting it', async () => {
  const value = generatedMission(); let inspected;
  const view = render(value, { api: { work: { inspect: async id => { inspected = id; const changed = generatedMission(); changed.steps[0].result.artifact.sha256 = '0'.repeat(64); return { ok: true, result: { mission: changed } }; } } } });
  const button = view.nodes.find(node => node.tagName === 'button'); assert.equal(button.textContent, 'Inspect source build'); await button.listeners.click();
  assert.equal(inspected, value.id); assert.match(view.find('yc-specialist-export-status').textContent, /does not match its published source and receipt/);
});

test('saved generated inspection distinguishes publication receipt from the later result receipt', async () => {
  const value = generatedMission('list_python_specialists'), entry = value.steps[0].result.entries[0];
  const source = generatedMission(); source.id = entry.source_work_id; source.steps[0].result.provenance.parent_work_id = source.id; source.steps[0].result.provenance.step_index = entry.build_step_index;
  source.steps = [null, null, null, source.steps[0]];
  const events = [{ event_type: 'work.generated.published', hash: entry.published_receipt, change: { step_index: entry.build_step_index, artifact_sha256: entry.artifact_sha256 } }];
  const view = render(value, { api: { work: { inspect: async () => ({ ok: true, result: { mission: source, events } }) } } });
  await view.nodes.find(node => node.tagName === 'button').listeners.click();
  assert.match(view.find('yc-specialist-export-status').textContent, /Published source build/);
  assert.doesNotMatch(view.find('yc-specialist-export-status').textContent, /does not match/);
});

test('saved generated library inspection cannot replace a newer selection after an asynchronous response', async () => {
  const { view } = render(generatedMission());
  const host = new Node('main'), entry = generatedMission('list_python_specialists').steps[0].result.entries[0];
  let active = true, resolve, calls = 0;
  view.renderSavedGeneratedSpecialist(host, entry, { active: () => active, api: { work: { inspect: () => { calls += 1; return new Promise(done => { resolve = done; }); } } } });
  const button = descendants(host).find(node => node.tagName === 'button');
  const pending = button.listeners.click(); active = false; resolve({ ok: false, error: { message: 'Late response for previous selection' } }); await pending;
  assert.equal(descendants(host).find(node => node.className === 'yc-specialist-export-status').textContent, '');
  await button.listeners.click(); assert.equal(calls, 1, 'A stale selection cannot start another read');
  assert.throws(() => view.renderSavedGeneratedSpecialist(new Node('main'), { ...entry, artifact_sha256: 'wrong' }), /source identity/);
});

function failedRecord(diagnostics) {
  const value = mission(); value.status = 'failed'; value.steps = []; value.artifacts = []; value.error = 'The work request failed.';
  return { mission: value, events: [{ event_type: 'work.failed', hash: 'a'.repeat(64), change: { diagnostics } }] };
}

test('only a current typed execution failure offers the Settings handoff, without preparing or retrying work', () => {
  let opened = 0;
  const options = { onOpenExecutionSettings: () => opened++ };
  const execution = failedRecord({ schema: 'yur.execution-diagnostic.v1', phase: 'wsl_status', outcome: 'timeout' });
  const view = render(execution, options); const action = view.find('yc-open-execution-settings');
  assert.equal(action.textContent, 'Open execution settings'); assert.equal(opened, 0); action.listeners.click(); assert.equal(opened, 1);
  const provider = failedRecord({ schema: 'yur.work-provider-diagnostic.v1', provider: 'ollama', outcome: 'empty_response', done_reason: 'stop' });
  assert.equal(render(provider, options).find('yc-open-execution-settings'), undefined);
  execution.mission.status = 'completed'; assert.equal(render(execution, options).find('yc-open-execution-settings'), undefined);
});

test('failed Work distinguishes a WSL status-query timeout from an observed stopped selection', () => {
  const value = failedRecord({ schema: 'yur.execution-diagnostic.v1', phase: 'wsl_status', outcome: 'timeout', timeout_seconds: 15 });
  const timedOut = render(value), detail = timedOut.find('yc-work-failure');
  assert.match(detail.textContent, /Runtime status query timed out/); assert.match(detail.textContent, /within 15 seconds/);
  assert.match(detail.textContent, /availability remains undetermined/); assert.doesNotMatch(detail.textContent, /not running|unavailable|permission|restart/i);
  assert.ok(timedOut.find('yc-work-failure-evidence').textContent.includes('a'.repeat(64)));
  value.events[0].change.diagnostics = { schema: 'yur.execution-diagnostic.v1', phase: 'runtime_selection', outcome: 'selected_not_running', selected_distro: 'Ubuntu-24.04', running_distros: [], running_distros_truncated: false };
  const stopped = render(value); assert.match(stopped.find('yc-work-failure-title').textContent, /Selected runtime is not running/);
  assert.match(stopped.find('yc-work-failure-explanation').textContent, /Ubuntu-24.04 was absent from the recorded list/);
  assert.equal(stopped.nodes.some(node => node.tagName === 'button'), false, 'Failure details never add bootstrap, retry, or policy-change actions');
});

test('only the latest work.failed event supplies the current failed-mission diagnostic', () => {
  const value = failedRecord({ schema: 'yur.execution-diagnostic.v1', phase: 'wsl_status', outcome: 'timeout' });
  value.events.push({ event_type: 'work.failed', hash: 'b'.repeat(64), change: { diagnostics: { schema: 'yur.execution-diagnostic.v1', phase: 'runtime_verification', outcome: 'fingerprint_mismatch', selected_distro: 'Ubuntu-24.04' } } });
  let view = render(value); assert.match(view.find('yc-work-failure-title').textContent, /verification did not match/);
  assert.ok(view.find('yc-work-failure-evidence').textContent.includes('b'.repeat(64))); assert.equal(view.find('yc-work-failure-evidence').textContent.includes('a'.repeat(64)), false);
  value.events.push({ event_type: 'work.failed', change: {} }); assert.equal(render(value).find('yc-work-failure'), undefined, 'Do not revive a stale diagnostic when the latest failure has none');
  value.events.pop(); value.mission.status = 'completed'; assert.equal(render(value).find('yc-work-failure'), undefined);
  value.mission.status = 'cancelled'; assert.equal(render(value).find('yc-work-failure'), undefined);
});

test('provider empty-response details retain counts and end reason while excluding raw reasoning and unknown fields everywhere', () => {
  const secret = 'RAW_REASONING_OR_RESPONSE_CANARY';
  const value = failedRecord({ schema: 'yur.work-provider-diagnostic.v1', provider: 'ollama', outcome: 'empty_response', done_reason: 'stop', content_chars: 0, thinking_chars: 1200, tool_call_count: 0, eval_count: 300, prompt_eval_count: 500, thinking: secret, content: secret, unknown: { canary: secret } });
  const view = render(value), detail = view.find('yc-work-failure');
  assert.match(view.find('yc-work-failure-title').textContent, /no usable answer or tool call/);
  assert.match(view.find('yc-work-failure-explanation').textContent, /end reason: stop/);
  for (const field of ['"content_chars": 0', '"thinking_chars": 1200', '"tool_call_count": 0', '"eval_count": 300', '"prompt_eval_count": 500']) assert.ok(detail.textContent.includes(field));
  assert.equal(view.host.textContent.includes(secret), false, 'Even the existing Work record projects only allowed diagnostic fields');
  assert.doesNotMatch(detail.textContent, /timed out|runtime|token limit|retry/i);
});

test('runtime diagnostic metadata stays bounded and never exposes streams, commands, invalid names or unsafe integers', () => {
  const hostile = '<img src=x onerror=alert(1)>PRIVATE_DIAGNOSTIC';
  const value = failedRecord({ schema: 'yur.execution-diagnostic.v1', phase: 'runtime_verification', outcome: 'nonzero_exit', returncode: -1, errno: 5, winerror: 123,
    stdout_bytes: 256, stderr_bytes: Number.MAX_SAFE_INTEGER + 1, stdout_sha256: 'c'.repeat(64), stderr_sha256: hostile, timeout_seconds: Infinity,
    selected_distro: hostile, running_distros: Array(33).fill('Ubuntu'), running_distros_truncated: true, stdout: hostile, stderr: hostile, command: hostile });
  const view = render(value), detail = view.find('yc-work-failure');
  assert.match(detail.textContent, /check exited with code -1/); assert.ok(detail.textContent.includes('"errno": 5')); assert.ok(detail.textContent.includes('"stdout_bytes": 256'));
  for (const key of ['stderr_bytes', 'stderr_sha256', 'timeout_seconds', 'selected_distro', '"running_distros"', 'command', '"stdout"', '"stderr"']) assert.equal(detail.textContent.includes(key), false, key);
  assert.equal(view.host.textContent.includes(hostile), false); assert.equal(view.nodes.some(node => node.tagName === 'img'), false);
});

test('unknown diagnostic schemas, phases, providers and outcomes do not receive a failure explanation', () => {
  for (const diagnostic of [
    { schema: 'unknown', phase: 'wsl_status', outcome: 'timeout' },
    { schema: 'yur.execution-diagnostic.v1', phase: 'model_claim', outcome: 'timeout' },
    { schema: 'yur.execution-diagnostic.v1', phase: 'wsl_status', outcome: 'permission_denied' },
    { schema: 'yur.work-provider-diagnostic.v1', provider: 'untrusted', outcome: 'empty_response', done_reason: 'stop' },
    { schema: 'yur.work-provider-diagnostic.v1', provider: 'ollama', outcome: 'empty_response', done_reason: 'raw explanation' },
  ]) assert.equal(render(failedRecord(diagnostic)).find('yc-work-failure'), undefined);
});
