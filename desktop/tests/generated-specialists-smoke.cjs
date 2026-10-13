'use strict';
// Real Desktop/OM/CommitService and admitted WSL cells. Only model responses
// are fixtures. Candidate requests must receive separate public-only contexts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (process.env.YUR_RUN_EXECUTION_CELL_TESTS !== '1') throw new Error('Set YUR_RUN_EXECUTION_CELL_TESTS=1 to validate generated workers using an already-running admitted execution resource. This test does not start a runtime.');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const monitored = ['tests/generated-specialists-smoke.cjs', 'tests/specialists-smoke.cjs', 'src/main.js', 'src/preload.js', 'src/work-transport.js', 'src/conversation-view.js', 'src/work-view.js', 'src/concept-view.js', 'src/conversation.css', 'src/studio-editor.html',
  'foundry/work_generated.py', 'foundry/generated_contracts.py', 'foundry/generated_worker.py', 'foundry/generated_evidence_v1.py', 'foundry/generated_evidence_v2.py', 'foundry/generated_evidence.py', 'foundry/work_concepts.py', 'foundry/concept_store.py', 'foundry/concept_policy.py', 'foundry/concept_rpc.py',
  'foundry/work_engine.py', 'foundry/work_cli.py', 'foundry/work_provider.py', 'foundry/work_tools.py', 'foundry/work_store.py', 'foundry/commit_service.py', 'foundry/orchestration.py', 'foundry/execution_cell.py', 'foundry/runtime_admission.py', 'foundry/specialist_runtime_v1.py'];
const fingerprints = () => Object.fromEntries(monitored.map(file => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))]));
const before = fingerprints();
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const contract = {
  schema: 'yur.python-specialist-contract.v1', name: 'Generated sum and label', description: 'Sum every integer in values and preserve the exact label in the returned object.',
  input_schema: object({ values: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: -100, maximum: 100 } }, label: { type: 'string', maxLength: 300 } }),
  output_schema: object({ total: { type: 'integer', minimum: -2000, maximum: 2000 }, label: { type: 'string', maxLength: 300 } }),
  cases: [
    { id: 'oracle-only-first-19bd', input: { values: [2, 3], label: 'case-positive' }, expected: { total: 5, label: 'case-positive' } },
    { id: 'oracle-only-second-54ab', input: { values: [-4, 1], label: 'case-negative' }, expected: { total: -3, label: 'case-negative' } },
    { id: 'oracle-only-empty-942e', input: { values: [], label: 'case-empty' }, expected: { total: 0, label: 'case-empty' } },
  ],
};
const rejectedContract = { ...contract, name: 'Deliberately rejected sum' };
const encodedContract = JSON.stringify(contract, null, 2) + '\n', encodedRejected = JSON.stringify(rejectedContract, null, 2) + '\n';
const hostile = '<img src=x onerror="window.GENERATED_INJECTED=true"><script>window.GENERATED_INJECTED=true</script> literal';
const directSource = 'def run(payload):\n    return {"total": sum(payload["values"]), "label": payload["label"]}\n';
const decomposedSource = 'def total(values):\n    return sum(values) + 1\n\ndef run(payload):\n    return {"total": total(payload["values"]), "label": payload["label"]}\n';
const conceptName = 'Retained generated sum concept';
const latestConcept = results => results.filter(result => result.concept).at(-1).concept;
const conceptChange = results => ({ concept_id: latestConcept(results).id, expected_revision: latestConcept(results).revision });
const conceptRefs = (results, requirements) => latestConcept(results).evidence.filter(entry => requirements.includes(entry.requirement)).map(entry => entry.id);

function conceptActions(proof) {
  const actions = [['create_concept', { name: conceptName, thesis_statement: 'Retain the exact generated sum worker and its finite acceptance and fresh execution evidence.', domain_tags: ['arithmetic', 'generated-python'] }]];
  for (const requirement of ['name', 'thesis_statement', 'domain_tags']) actions.push(['add_concept_evidence', r => ({ ...conceptChange(r), requirement, source: { kind: 'concept_intent' } })]);
  actions.push(['advance_concept', r => ({ ...conceptChange(r), to_stage: 'inception', evidence_ids: conceptRefs(r, ['name', 'thesis_statement', 'domain_tags']) })]);
  for (const [requirement, content] of [['charter', 'Retain the published sum worker, exact source identity and bounded acceptance.'],
    ['success_criteria', ['Check supplied finite cases and retain actual fresh execution receipts.']],
    ['constraint_set', ['No new candidate generation, execution, source changes, export or maturity claim.']]]) {
    actions.push(['create_artifact', r => ({ name: `${requirement}.json`, media_type: 'application/json', content: JSON.stringify({ schema: 'yur.concept-plan.v1', concept_id: latestConcept(r).id, requirement, content }) })]);
    actions.push(['add_concept_evidence', r => ({ ...conceptChange(r), requirement, source: { kind: 'work_artifact', mission_id: r[0].provenance.parent_work_id, artifact_id: r.at(-1).artifact_id } })]);
  }
  actions.push(['advance_concept', r => ({ ...conceptChange(r), to_stage: 'development', evidence_ids: conceptRefs(r, ['charter', 'success_criteria', 'constraint_set']) })]);
  actions.push(['bind_generated_concept_version', r => ({ ...conceptChange(r), source_work_id: proof.parent_id, build_step_index: proof.build_step_index, artifact_sha256: proof.artifact_sha256, parent_version_id: null })]);
  for (const requirement of ['artifact', 'build_log']) actions.push(['add_concept_evidence', r => ({ ...conceptChange(r), requirement, source: { kind: 'generated_build', version_id: latestConcept(r).versions[0].id } })]);
  actions.push(['add_concept_evidence', r => ({ ...conceptChange(r), requirement: 'instrumentation', source: { kind: 'generated_execution', version_id: latestConcept(r).versions[0].id,
    execution_work_id: proof.reuse_parent_id, execution_step_index: proof.reuse_result.provenance.step_index } })]);
  actions.push(['advance_concept', r => ({ ...conceptChange(r), to_stage: 'stabilization', evidence_ids: conceptRefs(r, ['artifact', 'build_log', 'instrumentation']) })]);
  actions.push(['advance_concept', r => ({ ...conceptChange(r), to_stage: 'maturation', evidence_ids: conceptRefs(r, ['artifact', 'build_log', 'instrumentation']) })]);
  assert.equal(actions.length, 18); return actions;
}

function verifyRun(result, expected, proof) {
  assert.equal(result.schema, 'yur.work-generated-specialist-result.v1'); assert.equal(result.tool, 'run_python_specialist');
  assert.equal(result.status, 'recorded'); assert.equal(result.committed, true); assert.deepEqual(result.output, expected);
  assert.equal(result.execution.status, 'completed'); assert.equal(result.execution.exit_code, 0); assert.equal(result.execution.scratch, 'discarded');
  assert.match(result.execution_receipt, /^[a-f0-9]{64}$/); assert.match(result.provenance.result_receipt, /^[a-f0-9]{64}$/);
  assert.equal(result.artifact.sha256, proof.artifact_sha256); assert.equal(result.artifact.source_sha256, sha(directSource));
  assert.equal(result.selection.source_work_id, proof.parent_id); assert.equal(result.selection.build_step_index, proof.build_step_index);
  assert.equal(result.selection.artifact_sha256, proof.artifact_sha256);
  assert.match(result.qualification, /correctness.*not established/i);
}

nativeFixture({ prefix: 'generated-specialists', model: 'generated-python-fixture',
  handle({ body, completed, goal, call, send, proof }) {
    try {
    if (body.tools.length === 1 && body.tools[0].function.name === 'submit_python_candidate') {
      assert.equal(completed.length, 0); assert.equal(body.messages.length, 2);
      assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
      const publicContract = JSON.parse(body.messages[1].content);
      assert.deepEqual(Object.keys(publicContract).sort(), ['description', 'input_schema', 'name', 'output_schema']);
      for (const marker of ['oracle-only-', 'case-positive', 'case-negative', 'case-empty', 'expected', 'GENERATED_BUILD', 'GENERATED_REUSE']) assert.equal(JSON.stringify(body.messages).includes(marker), false, `Blind candidate context excludes ${marker}`);
      const direct = body.messages[0].content.includes('direct compact');
      const source = publicContract.name === rejectedContract.name
        ? direct ? 'def run(payload):\n    return {"total": 999, "label": payload["label"]}\n' : 'def wrong_total(values):\n    return 998\n\ndef run(payload):\n    return {"total": wrong_total(payload["values"]), "label": payload["label"]}\n'
        : direct ? directSource : decomposedSource;
      (proof.candidate_requests ||= []).push({ contract_name: publicContract.name, strategy: direct ? 'direct' : 'decomposed', source_sha256: sha(source), public_context_sha256: sha(JSON.stringify(body.messages)) });
      return call('submit_python_candidate', { source });
    }
    if (goal.includes('GENERATED_CONCEPT')) {
      assert.ok(body.tools.some(tool => tool.function.name === 'bind_generated_concept_version'));
      const results = completed.map(item => item.value), actions = conceptActions(proof);
      for (const result of results.filter(item => item.schema === 'yur.work-concept-result.v1')) assert.equal(result.committed, true);
      if (results.length < actions.length) { const [name, args] = actions[results.length]; return call(name, typeof args === 'function' ? args(results) : args); }
      assert.equal(results.length, 18); const final = results.at(-1);
      assert.equal(final.status, 'denied'); assert.equal(final.decision.allowed, false); assert.equal(final.concept.stage, 'stabilization');
      assert.deepEqual(final.decision.missing.map(item => item.requirement).sort(), ['eval_report', 'known_failure_modes', 'stability_score']);
      assert.equal(final.concept.versions.length, 1); assert.equal(final.concept.evidence.length, 9);
      const version = final.concept.versions[0]; assert.equal(version.kind, 'generated_python'); assert.equal(Object.hasOwn(version, 'build_mission_id'), false);
      assert.equal(version.evidence_verifier, 'yur.generated-evidence.v2');
      assert.equal(version.source_work_id, proof.parent_id); assert.equal(version.build_step_index, proof.build_step_index); assert.equal(version.artifact_sha256, proof.artifact_sha256);
      proof.concept_id = final.concept.id; proof.concept_parent_id = final.provenance.parent_work_id; proof.final_concept = final.concept; proof.concept_denial = final.decision;
      return send('GENERATED_CONCEPT_DONE: the retained Python publication and its actual prior execution support Stabilization. Maturation was denied; no new worker execution, export or source changes occurred.');
    }
    assert.ok(body.tools.some(tool => tool.function.name === 'forge_python_specialist'));
    if (goal.includes('GENERATED_REUSE')) {
      if (!completed.length) return call('list_python_specialists', { limit: 20 });
      const list = completed[0].value; assert.equal(list.status, 'discovered'); assert.equal(list.committed, false); assert.equal(list.entries.length, 1);
      const entry = list.entries[0]; assert.equal(entry.source_work_id, proof.parent_id); assert.equal(entry.build_step_index, proof.build_step_index); assert.equal(entry.artifact_sha256, proof.artifact_sha256);
      if (completed.length === 1) return call('run_python_specialist', { source_work_id: entry.source_work_id, build_step_index: entry.build_step_index, artifact_sha256: entry.artifact_sha256, input: { values: [9, -2], label: 'fresh-reuse' } });
      assert.equal(completed.length, 2); verifyRun(completed[1].value, { total: 7, label: 'fresh-reuse' }, proof);
      assert.notEqual(completed[1].value.provenance.parent_work_id, proof.parent_id); proof.reuse_parent_id = completed[1].value.provenance.parent_work_id;
      proof.reuse_result = completed[1].value; proof.catalog = list;
      return send('GENERATED_REUSE_DONE: the exact published Python worker returned total 7 on fresh input without another build.');
    }
    const rejecting = goal.includes('GENERATED_REJECT');
    if (!completed.length) return call('read_file', { path: rejecting ? 'reject-contract.json' : 'sum-contract.json' });
    if (completed.length === 1) {
      assert.equal(completed[0].value.sha256, sha(rejecting ? encodedRejected : encodedContract));
      return call('forge_python_specialist', { contract_path: rejecting ? 'reject-contract.json' : 'sum-contract.json', expected_sha256: completed[0].value.sha256 });
    }
    const build = completed[1].value; assert.equal(build.schema, 'yur.work-generated-specialist-result.v1'); assert.equal(build.committed, true);
    assert.equal(build.validation.cases_total, 3); assert.equal(build.validation.candidates.length, 2);
    assert.match(build.provenance.accepted_receipt, /^[a-f0-9]{64}$/); assert.match(build.provenance.result_receipt, /^[a-f0-9]{64}$/);
    if (rejecting) {
      assert.equal(completed.length, 2); assert.equal(build.status, 'rejected'); assert.equal(build.artifact, null); assert.equal(build.validation.selected_strategy, null);
      assert.ok(build.validation.candidates.every(candidate => !candidate.passed && candidate.cases_passed === 0));
      proof.rejected_parent_id = build.provenance.parent_work_id; proof.rejected_build = build;
      return send('GENERATED_REJECT_DONE: neither generated candidate met the frozen acceptance contract; no worker was published.');
    }
    assert.equal(build.status, 'published'); assert.equal(build.validation.selected_strategy, 'direct');
    assert.deepEqual(build.validation.candidates.map(candidate => [candidate.strategy, candidate.status, candidate.cases_passed]), [['direct', 'passed', 3], ['decomposed', 'rejected', 0]]);
    assert.equal(build.artifact.source_sha256, sha(directSource)); assert.match(build.artifact.driver_sha256, /^[a-f0-9]{64}$/);
    proof.parent_id = build.provenance.parent_work_id; proof.build_step_index = build.provenance.step_index; proof.artifact_sha256 = build.artifact.sha256; proof.build = build;
    if (completed.length === 2) return call('run_python_specialist', { source_work_id: proof.parent_id, build_step_index: proof.build_step_index, artifact_sha256: proof.artifact_sha256, input: { values: [7, 8], label: hostile } });
    assert.equal(completed.length, 3); verifyRun(completed[2].value, { total: 15, label: hostile }, proof); proof.first_result = completed[2].value;
    send('GENERATED_BUILD_DONE: one independently checked Python candidate was published and returned total 15 on fresh input. Qualification remains limited to its declared cases.');
    } catch (error) {
      const after = fingerprints(); proof.source_verification = { before, after, changed: monitored.filter(file => before[file] !== after[file]) };
      throw error;
    }
  },
  async run(ctx) {
    const { evaluate, waitFor, click, envelope } = ctx;
    ctx.proof.source_verification = { before, after: null, changed: null };
    ctx.proof.runtime_started_by_fixture = false;
    let completedRun = false;
    try {
    await evaluate('document.querySelector("[data-workspace=agents]").click(); document.getElementById("yc-generated-toggle").click(); document.querySelector("[data-workspace=tools]").click()');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await evaluate('document.getElementById("yc-section-panel").dataset.section'), 'tools');
    assert.equal(await evaluate('document.getElementById("yc-catalog-note").textContent.includes("published workers")'), false);
    await evaluate('document.querySelector("[data-workspace=agents]").click(); document.getElementById("yc-generated-toggle").click()');
    await waitFor('document.getElementById("yc-catalog-note").textContent.includes("0 published workers")');
    assert.equal(await evaluate('document.querySelectorAll("#yc-section-resources .yc-resource-card").length'), 0); assert.equal(ctx.requests.length, 0);
    assert.equal((await envelope('studio.generatedSpecialists.list(20,null)')).entries.length, 0);
    await ctx.capture('empty-agents-library');
    await evaluate('document.getElementById("yc-back-chat").click()');
    fs.writeFileSync(path.join(ctx.sourceRoot, 'sum-contract.json'), encodedContract); fs.writeFileSync(path.join(ctx.sourceRoot, 'reject-contract.json'), encodedRejected);
    await evaluate('document.getElementById("yc-mode").value="code"; document.getElementById("yc-mode").dispatchEvent(new Event("change")); document.getElementById("yc-attach-repository").click()');
    await waitFor(`document.getElementById('yc-repository').textContent.includes(${JSON.stringify(ctx.sourceRoot)})`);
    const submit = async goal => evaluate(`document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit()`);
    await submit('GENERATED_BUILD: read the operator-supplied sum-contract.json, forge a Python specialist from its exact source hash, and execute it on fresh input. Do not change or export files.');
    await waitFor('document.getElementById("yc-messages").textContent.includes("GENERATED_BUILD_DONE") && !document.getElementById("yc-send").disabled', 110000);
    const buildRecord = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.parent_id)})`);
    assert.deepEqual(buildRecord.mission.steps.map(step => step.tool), ['read_file', 'forge_python_specialist', 'run_python_specialist']); assert.ok(buildRecord.mission.steps.every(step => step.succeeded));
    assert.equal(buildRecord.events.filter(event => event.event_type === 'work.generated.evaluation.committed').length, 6);
    assert.equal(buildRecord.events.filter(event => event.event_type === 'work.generated.cell.committed').length, 7);
    assert.equal(buildRecord.events.filter(event => event.event_type === 'work.generated.published').length, 1);
    assert.ok(buildRecord.events.filter(event => event.event_type.startsWith('work.generated.')).every(event => event.change.content === 'omitted-from-summary' && !Object.hasOwn(event, 'data')));
    assert.equal(buildRecord.mission.artifacts.length, 0); assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'sum-contract.json'), 'utf8'), encodedContract);
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-generated-specialist").length===2');
    const cardText = await evaluate('document.querySelector(".yc-generated-specialist[data-generated-status=published]").textContent');
    assert.ok(cardText.includes('3 of 3 host-checked acceptance cases')); assert.ok(cardText.includes('decomposed')); assert.ok(cardText.includes('Rejected · 0 of 3 cases'));
    assert.equal(await evaluate('Boolean(window.GENERATED_INJECTED || document.querySelector(".yc-generated-output img,.yc-generated-output script"))'), false);
    assert.ok((await evaluate('document.querySelector(".yc-generated-output").textContent')).includes(hostile));
    await evaluate('document.querySelector(".yc-generated-specialist[data-generated-status=published]").scrollIntoView({block:"start"})'); await ctx.capture('published-acceptance');
    await click('.yc-generated-specialist[data-generated-status=published] button', 'Inspect source build'); await waitFor('document.querySelector(".yc-generated-specialist[data-generated-status=published] .yc-specialist-export-status").textContent.includes("Published source build")');
    await evaluate('document.querySelector(".yc-generated-output").scrollIntoView({block:"center"})'); await ctx.capture('actual-output');
    ctx.checks.push('Real native Code froze an operator source-file oracle, requested two independent public-only candidate contexts, executed six acceptance cells, published only the passing candidate and recorded fresh contained output; source, driver, oracle and receipts remain bound');
    const calls = ctx.requests.length; await ctx.reload();
    await evaluate('[...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.includes("GENERATED_BUILD")).click()'); await waitFor('Boolean(document.querySelector(".yc-open-work"))');
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-generated-specialist").length===2'); assert.equal(ctx.requests.length, calls);
    await evaluate('document.getElementById("yc-input").value="Preserved draft input";document.getElementById("yc-input").dispatchEvent(new Event("input"));document.querySelector("[data-workspace=agents]").click();document.getElementById("yc-generated-toggle").click()');
    await waitFor('document.getElementById("yc-catalog-note").textContent.includes("1 published worker")');
    assert.equal(await evaluate('document.querySelectorAll("#yc-section-resources .yc-resource-card").length'), 1);
    assert.equal(ctx.requests.length, calls, 'Read-only Agents discovery makes no model call');
    const actualLibrary = await envelope('studio.generatedSpecialists.list(1,null)'); assert.equal(actualLibrary.entries.length, 1); assert.equal(actualLibrary.entries[0].artifact_sha256, ctx.proof.artifact_sha256);
    await evaluate('document.querySelector("#yc-section-resources .yc-resource-card").click()');
    await waitFor('Boolean(document.querySelector(".yc-saved-generated-specialist"))');
    await click('.yc-saved-generated-specialist button', 'Inspect source build'); await waitFor('document.querySelector(".yc-saved-generated-specialist .yc-specialist-export-status").textContent.includes("Published source build")');
    await ctx.capture('agents-published-library');
    await click('.yc-saved-generated-specialist > .yc-specialist-actions button', 'Use in Code conversation');
    assert.equal(await evaluate('document.getElementById("yc-mode").value'), 'code'); const draft = await evaluate('document.getElementById("yc-input").value'); assert.ok(draft.startsWith('Preserved draft input')); assert.ok(draft.includes(ctx.proof.artifact_sha256)); assert.equal(ctx.requests.length, calls);
    ctx.checks.push('Actual Agents Generated Python library reads empty and published states without a model or execution, ignores navigation-stale reads, verifies original publication on Inspect, and preserves the existing draft when choosing the exact worker for Code');
    await evaluate(`document.getElementById('yc-input').value+=${JSON.stringify('\nGENERATED_REUSE: discover the saved Python specialist and run its exact artifact on new input.')};document.getElementById('yc-form').requestSubmit()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("GENERATED_REUSE_DONE") && !document.getElementById("yc-send").disabled', 60000);
    const reuse = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.reuse_parent_id)})`); assert.deepEqual(reuse.mission.steps.map(step => step.tool), ['list_python_specialists', 'run_python_specialist']);
    assert.equal(reuse.events.some(event => event.event_type === 'work.generated.candidate.committed'), false); assert.equal(ctx.proof.candidate_requests.length, 2);
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()'); await waitFor('Boolean(document.querySelector(".yc-generated-catalog"))');
    await click('.yc-generated-catalog button', 'Inspect source build'); await waitFor('document.querySelector(".yc-generated-catalog .yc-specialist-export-status").textContent.includes("Published source build")');
    await evaluate('document.querySelector(".yc-generated-catalog").scrollIntoView({block:"start"})'); await ctx.capture('saved-library-reuse');
    ctx.checks.push('The committed build reopens without model replay; Use only prepares an editable Code draft, and a later mission discovers, re-verifies and executes the same artifact on new input without regenerating candidates');
    await submit('GENERATED_REJECT: read reject-contract.json and record the attempted forge. No file export or changes.');
    await waitFor('document.getElementById("yc-messages").textContent.includes("GENERATED_REJECT_DONE") && !document.getElementById("yc-send").disabled', 110000);
    const rejected = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.rejected_parent_id)})`); assert.equal(rejected.mission.steps.at(-1).succeeded, true); assert.equal(rejected.events.some(event => event.event_type === 'work.generated.published'), false);
    assert.equal(rejected.events.filter(event => event.event_type === 'work.generated.evaluation.committed').length, 6); assert.equal(ctx.proof.candidate_requests.length, 4);
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()'); await waitFor('Boolean(document.querySelector(".yc-generated-specialist[data-generated-status=rejected]"))');
    assert.match(await evaluate('document.querySelector(".yc-generated-specialist[data-generated-status=rejected] .yc-generated-status").textContent'), /build rejected/);
    assert.equal(await evaluate('document.querySelector(".yc-generated-specialist[data-generated-status=rejected]").textContent.includes("No candidate was published")'), true);
    await evaluate('document.querySelector(".yc-generated-specialist[data-generated-status=rejected]").scrollIntoView({block:"center"})'); await ctx.capture('rejected-candidates');
    const beforeReload = ctx.requests.length; await ctx.reload(); assert.equal(ctx.requests.length, beforeReload);
    assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'sum-contract.json'), 'utf8'), encodedContract); assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'reject-contract.json'), 'utf8'), encodedRejected);
    assert.deepEqual(ctx.reveals, []); assert.equal(fs.existsSync(path.join(ctx.tempRoot, 'factory', 'exports')), false);
    const missions = (await envelope('studio.work.list(null)')).missions; assert.equal(missions.length, 3); assert.ok(missions.every(item => item.artifacts.length === 0));
    const finalLibrary = await envelope('studio.generatedSpecialists.list(20,null)'); assert.equal(finalLibrary.entries.length, 1); assert.equal(finalLibrary.entries[0].artifact_sha256, ctx.proof.artifact_sha256);
    ctx.checks.push('Two independently generated failing candidates produce a durable rejected build and no publication; Desktop labels the handled rejection correctly and keeps all output inert, without export, host source writes or reload replay');

    const requestsBeforeConcept = ctx.requests.length, candidateCount = ctx.proof.candidate_requests.length;
    ctx.proof.actual_cell_count = [buildRecord, reuse, rejected].reduce((total, record) => total + record.events.filter(event => event.event_type === 'work.generated.cell.committed').length, 0);
    assert.equal(ctx.proof.actual_cell_count, 14); assert.equal(requestsBeforeConcept, 14);
    assert.equal((await envelope('studio.concepts.list(20,null)')).total, 0);
    await evaluate('document.getElementById("yc-new-chat").click();document.getElementById("yc-mode").value="work";document.getElementById("yc-mode").dispatchEvent(new Event("change"))');
    await waitFor(`Boolean([...document.getElementById('yc-model').options].find(option=>option.value===${JSON.stringify('ollama:' + ctx.model)}))`);
    await evaluate(`document.getElementById('yc-model').value=${JSON.stringify('ollama:' + ctx.model)};document.getElementById('yc-model').dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate('document.getElementById("yc-model").value'), 'ollama:' + ctx.model);
    await submit('GENERATED_CONCEPT: create a retained concept with source-linked plans, bind the exact already-published Python worker and its prior fresh execution, request Stabilization and then Maturation. Do not build, execute, export or modify files.');
    await waitFor('document.getElementById("yc-messages").textContent.includes("GENERATED_CONCEPT_DONE") && !document.getElementById("yc-send").disabled', 90000);
    assert.equal(ctx.requests.length - requestsBeforeConcept, 19); assert.equal(ctx.proof.candidate_requests.length, candidateCount);
    const conceptWork = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.concept_parent_id)})`);
    assert.equal(conceptWork.mission.status, 'completed'); assert.equal(conceptWork.mission.request.mode, 'work');
    assert.deepEqual(conceptWork.mission.steps.map(step => step.tool), conceptActions(ctx.proof).map(([tool]) => tool));
    assert.ok(conceptWork.mission.steps.every(step => step.succeeded));
    assert.equal(conceptWork.events.some(event => event.event_type.startsWith('work.generated.') || event.event_type.startsWith('work.cell.')), false);
    assert.equal(conceptWork.mission.artifacts.length, 3); assert.ok(conceptWork.mission.artifacts.every(artifact => !artifact.delivery));
    const conceptRecord = await envelope(`studio.concepts.inspect(${JSON.stringify(ctx.proof.concept_id)})`), version = conceptRecord.concept.versions[0];
    const { thesis_statement: thesis, ...retainedFields } = conceptRecord.concept;
    const { version_count: versionCount, evidence_count: evidenceCount, ...projectedFields } = ctx.proof.final_concept;
    assert.deepEqual(retainedFields, projectedFields);
    assert.equal(thesis, 'Retain the exact generated sum worker and its finite acceptance and fresh execution evidence.');
    assert.equal(versionCount, conceptRecord.concept.versions.length); assert.equal(evidenceCount, conceptRecord.concept.evidence.length);
    assert.equal(conceptRecord.concept.revision, 15); assert.equal(conceptRecord.concept.evidence.length, 9);
    assert.equal(version.kind, 'generated_python'); assert.equal(version.evidence_verifier, 'yur.generated-evidence.v1');
    assert.equal(version.source_sha256, sha(directSource)); assert.equal(version.contract_sha256, ctx.proof.build.artifact.contract_sha256);
    assert.equal(version.driver_sha256, ctx.proof.build.artifact.driver_sha256); assert.match(version.runtime_sha256, /^[a-f0-9]{64}$/); assert.match(version.acceptance_cohort_sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(version, 'build_mission_id'), false);
    const published = buildRecord.events.find(event => event.event_type === 'work.generated.published');
    const selectedEvaluations = buildRecord.events.filter(event => event.event_type === 'work.generated.evaluation.committed' && event.change.cell_key.startsWith('direct:'));
    assert.equal(selectedEvaluations.length, 3); assert.ok(selectedEvaluations.every(event => event.change.passed));
    assert.equal(version.artifact_receipt_hash, published.hash); assert.equal(version.validation_receipt_hash, selectedEvaluations.at(-1).hash);
    const evidence = Object.fromEntries(conceptRecord.concept.evidence.map(entry => [entry.requirement, entry]));
    assert.equal(evidence.artifact.receipt_hash, published.hash); assert.equal(evidence.build_log.receipt_hash, version.validation_receipt_hash);
    assert.deepEqual(evidence.instrumentation.source, { kind: 'generated_execution', version_id: version.id, execution_work_id: ctx.proof.reuse_parent_id, execution_step_index: ctx.proof.reuse_result.provenance.step_index });
    assert.equal(evidence.instrumentation.receipt_hash, ctx.proof.reuse_result.provenance.result_receipt);
    assert.ok(reuse.events.some(event => event.event_type === 'work.generated.result.committed' && event.hash === evidence.instrumentation.receipt_hash));
    for (const key of ['artifact', 'build_log', 'instrumentation']) { assert.equal(evidence[key].artifact_id, version.id); assert.equal(evidence[key].artifact_sha256, ctx.proof.artifact_sha256); }
    assert.equal(conceptRecord.events.at(-1).event_type, 'concept.transition.denied'); assert.equal(conceptRecord.events.at(-1).hash, conceptRecord.concept.receipt.hash);
    assert.deepEqual(conceptRecord.events.filter(event => event.event_type === 'concept.transitioned').map(event => event.stage), ['inception', 'development', 'stabilization']);
    ctx.proof.concept_publication_receipt = published.hash; ctx.proof.concept_selected_case_receipts = selectedEvaluations.map(event => event.hash);
    ctx.proof.concept_execution_receipt = evidence.instrumentation.receipt_hash; ctx.proof.concept_acceptance_cohort_sha256 = version.acceptance_cohort_sha256;
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('Boolean(document.querySelector(".yc-concept-work-results .yc-concept-decision[data-allowed=false]"))');
    assert.match(await evaluate('document.querySelector(".yc-concept-work-results .yc-concept-decision[data-allowed=false]").textContent'), /Stage unchanged: Stabilization/);
    await evaluate('document.querySelector(".yc-concept-work-results .yc-concept-decision[data-allowed=false]").scrollIntoView({block:"start"})'); await ctx.capture('generated-concept-denied-gate');
    await click('.yc-concept-actions button', 'Open current concept');
    await waitFor('document.querySelector("#yc-resource-detail .yc-concept-current")?.textContent.includes("Stabilization")');
    assert.equal(await evaluate('document.querySelector("#yc-resource-detail .yc-concept-record").dataset.conceptId'), ctx.proof.concept_id);
    assert.equal(await evaluate('document.querySelectorAll("#yc-resource-detail .yc-concept-stages li").length'), 8);
    await ctx.capture('generated-concept-panel');
    await evaluate('document.querySelector("#yc-resource-detail .yc-concept-versions").open=true;document.querySelector("#yc-resource-detail .yc-concept-evidence").open=true;document.querySelector("#yc-resource-detail .yc-concept-versions").scrollIntoView({block:"start"})');
    const renderedVersion = await evaluate('document.querySelector("#yc-resource-detail .yc-concept-version").textContent');
    assert.match(renderedVersion, /Generated Python/); assert.match(renderedVersion, /finite cases/); assert.ok(renderedVersion.includes(ctx.proof.parent_id)); assert.ok(renderedVersion.includes(version.acceptance_cohort_sha256));
    assert.doesNotMatch(renderedVersion, /Build undefined|build_mission_id|Package hashes/);
    const renderedEvidence = await evaluate('document.querySelector("#yc-resource-detail .yc-concept-evidence").textContent');
    assert.match(renderedEvidence, /Generated Python acceptance cohort/); assert.match(renderedEvidence, /Recorded generated Python execution/); assert.ok(renderedEvidence.includes(ctx.proof.reuse_parent_id));
    await ctx.capture('generated-concept-version-evidence');
    const callsBeforeConceptReload = ctx.requests.length; await ctx.reload();
    await evaluate('document.querySelector("[data-workspace=agents]").click();document.getElementById("yc-concepts-toggle").click()');
    await waitFor('document.getElementById("yc-catalog-note").textContent.includes("1 of 1 concepts")'); await evaluate('document.querySelector("#yc-section-resources .yc-resource-card").click()');
    await waitFor('document.querySelector("#yc-resource-detail .yc-concept-current")?.textContent.includes("Stabilization")');
    assert.deepEqual(await envelope(`studio.concepts.inspect(${JSON.stringify(ctx.proof.concept_id)})`), conceptRecord);
    assert.deepEqual(await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.parent_id)})`), buildRecord);
    assert.deepEqual(await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.reuse_parent_id)})`), reuse);
    assert.deepEqual(await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.concept_parent_id)})`), conceptWork);
    assert.equal(ctx.requests.length, callsBeforeConceptReload); assert.equal(ctx.proof.candidate_requests.length, 4);
    assert.equal((await envelope('studio.work.list(null)')).missions.length, 4); assert.deepEqual(ctx.reveals, []);
    assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'sum-contract.json'), 'utf8'), encodedContract); assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'reject-contract.json'), 'utf8'), encodedRejected);
    assert.equal(fs.existsSync(path.join(ctx.tempRoot, 'factory', 'exports')), false);
    ctx.proof.concept_fixture_tool_steps = 18; ctx.proof.concept_additional_cells = 0;
    ctx.checks.push('A fresh Work mission binds the prior generated Python publication and actual saved execution to one immutable Concept version, commits nine qualified evidence references and Stabilization, retains a denied Maturation gate, and reopens the same source/cohort/receipt identities in Agents without model or execution replay');
    ctx.proof.runtime_started_by_fixture = false; ctx.proof.capture_condition = 'Native nonfocusable, transparent, offscreen skip-taskbar window; direct WebContents captures without composition.';
    completedRun = true;
    } finally {
      const after = fingerprints(), changed = monitored.filter(file => before[file] !== after[file]);
      ctx.proof.source_verification = { before, after, changed };
      if (completedRun) assert.deepEqual(changed, []);
    }
  },
});
