'use strict';
// Real Desktop IPC, OM, independent validation, admitted specialist execution
// and CommitService. Model decisions are loopback fixtures, never live claims.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const capability = 'construction.opc.inspect', name = 'Quoted construction inspector';
const firstText = 'Quoted OPC — 🧱 local fixture\r\nITEM | DESCRIPTION | QUANTITY | UNIT | UNIT PRICE | TOTAL\r\n1.01 | Concrete formwork | 3 | EA | 19.95 | 59.85\r\n1.02 | Anchor plates | 3 | EA | 19.95 | 60.00\r\n';
const freshText = '2.01 | Anchor plates | 4 | each | 19.95 | 80.00\n';
const monitoredFiles = ['tests/construction-smoke.cjs', 'tests/specialists-smoke.cjs',
  'src/main.js', 'src/preload.js', 'src/work-transport.js', 'src/work-view.js',
  'src/conversation-view.js', 'src/conversation.css', 'src/studio-editor.html', 'src/concept-view.js', 'foundry/work_specialists.py',
  'foundry/work_engine.py', 'foundry/work_cli.py', 'foundry/work_store.py', 'foundry/work_provider.py', 'foundry/work_tools.py',
  'foundry/specialists.py', 'foundry/runtime_admission.py', 'foundry/pack_compiler.py',
  'foundry/orchestration.py', 'foundry/commit_service.py', 'foundry/concept_store.py', 'foundry/work_concepts.py', 'foundry/concept_rpc.py'];
const fingerprints = () => Object.fromEntries(monitoredFiles.map(file => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))]));
const before = fingerprints();

function checkOutput(output, source, expected) {
  assert.equal(output.method, 'quoted_opc_rows'); assert.equal(output.assessment, 'quoted_arithmetic_only');
  assert.equal(output.arithmetic_scope, 'returned_line_items'); assert.equal(output.requires_review, true);
  assert.equal(output.source.sha256, sha(source)); assert.equal(output.source.bytes, Buffer.byteLength(source));
  assert.equal(output.source.characters, Array.from(source).length); assert.equal(output.source.offset_unit, 'unicode-code-points');
  assert.equal(output.line_items.length, expected.length); assert.equal(output.candidate_count, expected.length);
  assert.equal(output.excluded_count, 0); assert.equal(output.omitted_count, 0); assert.equal(output.truncated, false);
  for (let index = 0; index < expected.length; index++) {
    const item = output.line_items[index];
    for (const [key, value] of Object.entries(expected[index])) assert.equal(item[key], value, `row ${index}: ${key}`);
    assert.equal(item.format, 'pipe'); assert.equal(item.rounding, 'ROUND_HALF_UP');
    assert.deepEqual(Object.keys(item.sources).sort(), ['description', 'item_number', 'quantity', 'stated_total', 'unit', 'unit_price']);
    for (const span of Object.values(item.sources)) {
      assert.equal(span.field, 'text'); assert.ok(span.end > span.start);
      assert.equal(Array.from(source).slice(span.start, span.end).join(''), span.text, 'Every source span is exact original Unicode text');
      assert.equal(Array.from(source).slice(0, span.start).join('').split('\n').length, span.line);
    }
  }
}
const firstExpected = [
  { item_number: '1.01', quantity: '3', unit: 'EA', unit_price: '19.95', stated_total: '59.85', calculated_total: '59.85', difference: '0.00', arithmetic: 'consistent' },
  { item_number: '1.02', quantity: '3', unit: 'EA', unit_price: '19.95', stated_total: '60.00', calculated_total: '59.85', difference: '0.15', arithmetic: 'mismatch' },
];
const freshExpected = [{ item_number: '2.01', quantity: '4', unit: 'EA', unit_price: '19.95', stated_total: '80.00', calculated_total: '79.80', difference: '0.20', arithmetic: 'mismatch' }];
function receipt(value, eventType) { assert.equal(value.event_type, eventType); assert.match(value.hash, /^[a-f0-9]{64}$/); assert.match(value.state_digest, /^[a-f0-9]{64}$/); }

nativeFixture({ prefix: 'construction', model: 'construction-tools-fixture',
  handle({ completed, goal, call, send, proof, body }) {
    const buildTool = body.tools.find(tool => tool.function.name === 'build_specialist');
    assert.ok(buildTool.function.parameters.properties.capabilities.items.enum.includes(capability));
    if (goal.includes('CONSTRUCTION_REUSE')) {
      if (!completed.length) return call('list_built_specialists', { limit: 20 });
      const catalog = completed[0].value; assert.equal(catalog.entries.length, 1); assert.equal(catalog.entries[0].mission_id, proof.child_id);
      assert.deepEqual(catalog.entries[0].capabilities, [capability]);
      if (completed.length === 1) return call('run_saved_specialist', { mission_id: proof.child_id, capability_id: capability, input: { text: freshText } });
      assert.equal(completed.length, 2); const result = completed[1].value; checkOutput(result.output, freshText, freshExpected);
      assert.equal(result.mission_id, proof.child_id); assert.equal(result.selection.source_parent_work_id, proof.parent_id);
      assert.notEqual(result.provenance.parent_work_id, proof.parent_id); assert.equal(result.selection.artifact_digest, proof.artifact_digest);
      receipt(result.execution_receipt, 'execution.completed'); assert.notEqual(result.run_id, proof.first_run_id);
      proof.reuse_parent_id = result.provenance.parent_work_id; proof.reuse_run_id = result.run_id; proof.fresh_output = result.output; proof.reuse_execution_receipt = result.execution_receipt;
      return send('CONSTRUCTION_REUSE_DONE: the saved inspector checked fresh quoted quantity 4. Calculated 79.80; stated 80.00; difference 0.20. Review the quoted discrepancy.');
    }
    if (!completed.length) return call('build_specialist', { name, description: 'Inspect explicitly quoted six-field construction rows and decimal arithmetic without market pricing or approvals.', capabilities: [capability] });
    const build = completed[0].value; assert.equal(build.schema, 'yur.work-specialist-result.v1'); assert.equal(build.committed, true);
    assert.equal(build.artifact.validation.passed, true); assert.equal(build.artifact.validation.independent_validation.passed, true);
    assert.deepEqual(build.capabilities.map(item => item.id), [capability]); proof.child_id = build.mission_id; proof.artifact_digest = build.artifact.digest; proof.validation = build.artifact.validation;
    if (completed.length === 1) return call('run_built_specialist', { mission_id: build.mission_id, capability_id: capability, input: { text: firstText } });
    assert.equal(completed.length, 2); const result = completed[1].value; assert.equal(result.committed, true); checkOutput(result.output, firstText, firstExpected);
    receipt(result.execution_receipt, 'execution.completed'); receipt(result.provenance.accepted_receipt, 'work.specialist.accepted'); receipt(result.provenance.result_receipt, 'work.specialist.result.committed');
    proof.first_output = result.output; proof.first_run_id = result.run_id; proof.first_execution_receipt = result.execution_receipt;
    send('CONSTRUCTION_NATIVE_DONE: two quoted lines inspected. One is consistent. Anchor plates: 3 × 19.95 = 59.85; stated 60.00; discrepancy 0.15. No price assessment or approval was performed.');
  },
  async run(ctx) {
    const { evaluate, waitFor, click, envelope } = ctx;
    const goal = 'CONSTRUCTION_BUILD: build a quoted construction inspector and check these exact rows.\n' + firstText;
    const sourcePath = path.join(ctx.sourceRoot, 'quoted-opc.txt'); fs.writeFileSync(sourcePath, firstText);
    ctx.proof.source = { text: firstText, sha256: sha(firstText), fresh_text: freshText, fresh_sha256: sha(freshText) };
    await evaluate(`document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change')); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("CONSTRUCTION_NATIVE_DONE") && !document.getElementById("yc-send").disabled', 60000);
    const missions = (await envelope('studio.work.list(null)')).missions; assert.equal(missions.length, 1); ctx.proof.parent_id = missions[0].id;
    const savedConversation = (await envelope('studio.conversations.list()')).conversations.find(item => item.id === missions[0].conversation_id);
    assert.equal(savedConversation.title, Array.from(goal.replace(/\s+/g, ' ')).slice(0, 100).join('')); assert.ok(savedConversation.title.endsWith('🧱'), 'An astral character on the former UTF-16 truncation boundary remains intact in the committed title');
    const record = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.parent_id)})`);
    assert.equal(record.mission.status, 'completed'); assert.deepEqual(record.mission.steps.map(step => step.tool), ['build_specialist', 'run_built_specialist']); assert.ok(record.mission.steps.every(step => step.succeeded));
    assert.equal(record.mission.artifacts.length, 0); assert.equal(record.events.filter(event => event.event_type.includes('delivery')).length, 0);
    const child = (await envelope(`studio.work.inspectSpecialist(${JSON.stringify(ctx.proof.parent_id)},${JSON.stringify(ctx.proof.child_id)})`)).specialist;
    const executions = child.events.filter(event => event.event_type === 'execution.completed'); assert.equal(executions.length, 1); assert.equal(executions[0].hash, ctx.proof.first_execution_receipt.hash);
    assert.equal(executions[0].data.output.source.sha256, sha(firstText)); assert.equal(executions[0].data.capability_id, capability);
    assert.equal(child.artifact.digest, ctx.proof.artifact_digest); assert.equal(fs.readFileSync(sourcePath, 'utf8'), firstText);
    ctx.checks.push('Real Work builds and independently validates the admitted OPC inspector, commits its execution, and returns exact Unicode source offsets plus decimal consistent/mismatch results');
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-specialist-card").length===2');
    assert.equal(await evaluate('document.querySelector(".yc-specialist-card h4").textContent'), name);
    const outputText = await evaluate('document.querySelector(".yc-construction-result").textContent');
    for (const marker of ['59.85', '60.00', '0.15', 'Anchor plates', 'unicode-code-points']) assert.ok(outputText.includes(marker));
    await evaluate('document.querySelector(".yc-construction-row[data-arithmetic=mismatch]").scrollIntoView({block:"center"}); true;'); await ctx.capture('quoted-arithmetic');
    await evaluate('const quotes=document.querySelector(".yc-construction-row[data-arithmetic=mismatch] .yc-construction-quotes"); quotes.querySelector("summary").click(); quotes.scrollIntoView({block:"start"}); true;');
    const displayedQuotes = await evaluate('document.querySelector(".yc-construction-row[data-arithmetic=mismatch] .yc-construction-quotes").textContent'); assert.ok(displayedQuotes.includes('19.95')); assert.ok(displayedQuotes.includes('172–177')); assert.ok(displayedQuotes.includes('60.00')); await ctx.capture('source-evidence');
    const beforeReload = ctx.requests.length; await ctx.reload();
    await evaluate('const saved=[...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.includes("CONSTRUCTION_BUILD")); if(!saved)throw new Error("Saved construction conversation missing"); saved.click()');
    await waitFor('Boolean(document.querySelector(".yc-open-work"))'); await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-specialist-card").length===2'); assert.equal(ctx.requests.length, beforeReload);
    ctx.checks.push('Desktop displays actual construction output/source quotes and restores the committed run after reload without another model request or execution');
    await evaluate('document.querySelector("[data-workspace=agents]").click(); document.getElementById("yc-built-toggle").click()');
    await waitFor('document.querySelectorAll(".yc-resource-card").length===1');
    await evaluate('document.querySelector(".yc-resource-card").click()'); await waitFor('Boolean(document.querySelector(".yc-saved-specialist"))');
    assert.ok((await evaluate('document.querySelector(".yc-saved-specialist").textContent')).includes(name));
    await ctx.capture('saved-library'); await click('.yc-saved-specialist button', 'Use in conversation');
    assert.equal(ctx.requests.length, beforeReload); assert.ok((await evaluate('document.getElementById("yc-input").value')).includes(ctx.proof.child_id));
    await evaluate(`document.getElementById('yc-input').value+=${JSON.stringify('\nCONSTRUCTION_REUSE: inspect these fresh quoted rows.\n' + freshText)};document.getElementById('yc-form').requestSubmit()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("CONSTRUCTION_REUSE_DONE") && !document.getElementById("yc-send").disabled', 60000);
    const reuse = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.reuse_parent_id)})`); assert.deepEqual(reuse.mission.steps.map(step => step.tool), ['list_built_specialists', 'run_saved_specialist']); assert.ok(reuse.mission.steps.every(step => step.succeeded)); assert.equal(reuse.mission.artifacts.length, 0);
    const library = await envelope('studio.specialists.list(20,null)'); assert.equal(library.entries.length, 1); assert.equal(library.entries[0].mission_id, ctx.proof.child_id); assert.equal(library.entries[0].artifact_digest, ctx.proof.artifact_digest);
    const afterChild = (await envelope(`studio.work.inspectSpecialist(${JSON.stringify(ctx.proof.parent_id)},${JSON.stringify(ctx.proof.child_id)})`)).specialist;
    const afterExecutions = afterChild.events.filter(event => event.event_type === 'execution.completed'); assert.equal(afterExecutions.length, 2); assert.ok(afterExecutions.some(event => event.hash === ctx.proof.reuse_execution_receipt.hash));
    assert.equal(afterChild.events.some(event => event.event_type.includes('export')), false); assert.equal(fs.existsSync(path.join(ctx.tempRoot, 'factory', 'exports')), false); assert.equal(fs.readFileSync(sourcePath, 'utf8'), firstText); assert.deepEqual(ctx.reveals, []);
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()'); await waitFor('document.querySelector(".yc-specialist-card .yc-specialist-eyebrow")?.textContent==="SAVED SPECIALIST RESULT"');
    await evaluate('document.querySelector(".yc-construction-row").scrollIntoView({block:"center"}); true;'); await ctx.capture('fresh-saved-result');
    ctx.checks.push('Agents library reuses the same saved inspector in a later Work mission on fresh quantities, with original-parent selection and a distinct committed execution receipt; no rebuild, export, delivery or source mutation');
    const calls = ctx.requests.length; await ctx.reload(); assert.equal(ctx.requests.length, calls);
    const finalChild = (await envelope(`studio.work.inspectSpecialist(${JSON.stringify(ctx.proof.parent_id)},${JSON.stringify(ctx.proof.child_id)})`)).specialist; assert.equal(finalChild.events.filter(event => event.event_type === 'execution.completed').length, 2);
    const after = fingerprints(), changed = monitoredFiles.filter(file => before[file] !== after[file]); ctx.proof.source_verification = { before, after, changed }; assert.deepEqual(changed, []);
    ctx.proof.capture_condition = 'Actual native window, fully transparent, offscreen at -16000/-16000, skip-taskbar; direct WebContents captures, no composition';
  },
});
