'use strict';
// Actual Work/CommitService concept lifecycle and native read-only UI. The
// provider tool selections are fixtures; no stage or evidence record is faked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const conceptName = 'Continuing quoted construction';
const files = ['tests/concepts-smoke.cjs', 'tests/specialists-smoke.cjs', 'src/main.js', 'src/preload.js', 'src/work-transport.js', 'src/conversation-view.js', 'src/studio-editor.html', 'src/work-view.js', 'src/concept-view.js', 'src/conversation.css', 'foundry/commit_service.py', 'foundry/concept_store.py', 'foundry/concept_policy.py', 'foundry/concept_rpc.py', 'foundry/work_concepts.py', 'foundry/work_cli.py', 'foundry/work_engine.py', 'foundry/work_tools.py', 'foundry/work_provider.py', 'foundry/work_specialists.py', 'foundry/specialists.py', 'foundry/runtime_admission.py', 'foundry/orchestration.py'];
const fingerprint = () => Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))]));
const before = fingerprint();
const current = results => results.filter(item => item.concept).at(-1).concept;
const change = results => ({ concept_id: current(results).id, expected_revision: current(results).revision });
const refs = (results, requirements) => current(results).evidence.filter(item => requirements.includes(item.requirement)).map(item => item.id);

nativeFixture({ prefix: 'concepts', model: 'concept-lifecycle-fixture',
  handle({ completed, goal, call, send, proof, body }) {
    const results = completed.map(item => item.value);
    assert.ok(body.tools.some(item => item.function.name === 'create_concept'));
    const later = goal.includes('CONCEPT_NATIVE_CONTINUE');
    const actions = later ? [['inspect_concept', { concept_id: proof.concept_id }]] : [['create_concept', { name: conceptName, thesis_statement: 'Check quoted construction arithmetic with exact source evidence.', domain_tags: ['construction', 'evidence'] }]];
    if (!later) {
      for (const requirement of ['name', 'thesis_statement', 'domain_tags']) actions.push(['add_concept_evidence', r => ({ ...change(r), requirement, source: { kind: 'concept_intent' } })]);
      actions.push(['advance_concept', r => ({ ...change(r), to_stage: 'inception', evidence_ids: refs(r, ['name', 'thesis_statement', 'domain_tags']) })]);
    } else {
      for (const requirement of ['charter', 'success_criteria', 'constraint_set']) {
        actions.push(['create_artifact', { name: `${requirement}.json`, media_type: 'application/json', content: JSON.stringify({ schema: 'yur.concept-plan.v1', concept_id: proof.concept_id, requirement, content: requirement === 'charter' ? 'Inspect quoted rows without price or approval claims.' : ['Retain source quotes', 'No deployment or approval'] }) }]);
        actions.push(['add_concept_evidence', r => ({ ...change(r), requirement, source: { kind: 'work_artifact', mission_id: r[0].provenance.parent_work_id, artifact_id: r.at(-1).artifact_id } })]);
      }
      actions.push(['advance_concept', r => ({ ...change(r), to_stage: 'development', evidence_ids: refs(r, ['charter', 'success_criteria', 'constraint_set']) })]);
      actions.push(['build_specialist', { name: 'Concept quote inspector', description: 'A real immutable executable concept version.', capabilities: ['construction.opc.inspect'] }]);
      actions.push(['bind_concept_version', r => ({ ...change(r), build_mission_id: r.at(-1).mission_id, parent_version_id: null })]);
      actions.push(['run_built_specialist', r => ({ mission_id: current(r).versions.at(-1).build_mission_id, capability_id: 'construction.opc.inspect', input: { text: '1.01 | Anchor plates | 3 | EA | 19.95 | 60.00' } })]);
      for (const requirement of ['artifact', 'build_log', 'instrumentation']) actions.push(['add_concept_evidence', r => ({ ...change(r), requirement, source: { kind: requirement === 'instrumentation' ? 'specialist_execution' : 'specialist_build', version_id: current(r).versions.at(-1).id, ...(requirement === 'instrumentation' ? { run_id: r.find(item => item.tool === 'run_built_specialist').run_id } : {}) } })]);
      actions.push(['advance_concept', r => ({ ...change(r), to_stage: 'stabilization', evidence_ids: refs(r, ['artifact', 'build_log', 'instrumentation']) })]);
      actions.push(['advance_concept', r => ({ ...change(r), to_stage: 'maturation', evidence_ids: [] })]);
    }
    if (results.length < actions.length) { const [name, args] = actions[results.length]; return call(name, typeof args === 'function' ? args(results) : args); }
    assert.equal(results.length, actions.length);
    const result = results.at(-1); assert.equal(result.schema, 'yur.work-concept-result.v1'); assert.equal(result.committed, true);
    if (!later) { assert.equal(result.concept.stage, 'inception'); assert.equal(result.concept.evidence.length, 3); assert.equal(result.concept.versions.length, 0); proof.concept_id = result.concept.id; proof.genesis_parent = result.provenance.parent_work_id; proof.genesis_revision = result.concept.revision; return send('CONCEPT_GENESIS_DONE: the recorded concept entered Inception using intent evidence. No package or deployment is claimed.'); }
    assert.equal(result.status, 'denied'); assert.equal(result.decision.allowed, false); assert.equal(result.concept.stage, 'stabilization'); assert.ok(result.decision.missing.length);
    assert.equal(result.concept.id, proof.concept_id); assert.equal(result.concept.versions.length, 1); assert.equal(result.concept.evidence.length, 9);
    const run = results.find(item => item.tool === 'run_built_specialist'); assert.equal(run.output.line_items[0].difference, '0.15');
    proof.continue_parent = result.provenance.parent_work_id; proof.final_concept = result.concept; proof.denied_decision = result.decision; proof.execution_receipt = run.execution_receipt;
    send('CONCEPT_CONTINUE_DONE: the same concept retained one executable version and real execution evidence. Maturation was denied; its stage remains Stabilization. No deployment or billing occurred.');
  },
  async run(ctx) {
    const { evaluate, waitFor, click, envelope } = ctx;
    const empty = await envelope('studio.concepts.list(20,null)'); assert.equal(empty.total, 0);
    const goal = 'CONCEPT_NATIVE_GENESIS: retain a construction concept, record its three intent evidence references, and request Inception.';
    await evaluate(`document.getElementById('yc-mode').value='work';document.getElementById('yc-mode').dispatchEvent(new Event('change'));document.getElementById('yc-input').value=${JSON.stringify(goal)};document.getElementById('yc-form').requestSubmit()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("CONCEPT_GENESIS_DONE") && !document.getElementById("yc-send").disabled', 60000);
    const seed = await envelope(`studio.concepts.inspect(${JSON.stringify(ctx.proof.concept_id)})`); assert.equal(seed.concept.stage, 'inception'); assert.equal(seed.concept.versions.length, 0); assert.equal(seed.concept.evidence.length, 3);
    assert.ok(seed.events.some(event => event.event_type === 'concept.transitioned' && event.decision.allowed));
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('Boolean(document.querySelector(".yc-concept-work-results .yc-concept-record"))');
    assert.match(await evaluate('document.querySelector(".yc-concept-work-results").textContent'), /Stage recorded: Inception/);
    await evaluate('document.querySelector(".yc-concept-record").scrollIntoView({block:"start"});true;'); await ctx.capture('intent-stage');
    ctx.checks.push('Real Work creates a retained concept and separately commits intent evidence and the Genesis gate; mission completion alone does not create a package or imply maturity');
    const providerCount = ctx.requests.length; await evaluate('document.querySelector("[data-workspace=agents]").click();document.getElementById("yc-concepts-toggle").click()');
    await waitFor('document.getElementById("yc-catalog-note").textContent.includes("1 of 1 concepts")'); await evaluate('document.querySelector(".yc-resource-card").click()'); await waitFor('Boolean(document.querySelector("#yc-resource-detail .yc-concept-record"))');
    assert.equal(await evaluate('document.querySelectorAll("#yc-resource-detail .yc-concept-stages li").length'), 8);
    assert.match(await evaluate('document.querySelector("#yc-resource-detail .yc-concept-current").textContent'), /Inception/); assert.equal(ctx.requests.length, providerCount);
    await ctx.capture('agents-library'); await click('#yc-resource-detail .yc-concept-actions button', 'Use in conversation');
    assert.equal(ctx.requests.length, providerCount); assert.equal(await evaluate('document.getElementById("yc-mode").value'), 'work'); assert.ok((await evaluate('document.getElementById("yc-input").value')).includes(ctx.proof.concept_id));
    await evaluate(`document.getElementById('yc-input').value+=${JSON.stringify('\nCONCEPT_NATIVE_CONTINUE: record real plans, build and bind a package, execute it, record evidence, request Stabilization then Maturation without fabricated proof.')};document.getElementById('yc-form').requestSubmit()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("CONCEPT_CONTINUE_DONE") && !document.getElementById("yc-send").disabled', 90000);
    const continued = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.continue_parent)})`); assert.equal(continued.mission.status, 'completed'); assert.equal(continued.mission.steps.length, 16); assert.ok(continued.mission.steps.every(step => step.succeeded));
    const current = await envelope(`studio.concepts.inspect(${JSON.stringify(ctx.proof.concept_id)})`); assert.equal(current.concept.stage, 'stabilization'); assert.equal(current.concept.versions.length, 1); assert.equal(current.concept.evidence.length, 9);
    const version = current.concept.versions[0], child = (await envelope(`studio.work.inspectSpecialist(${JSON.stringify(ctx.proof.continue_parent)},${JSON.stringify(version.build_mission_id)})`)).specialist;
    assert.equal(version.artifact_sha256, child.artifact.digest); assert.ok(child.events.some(event => event.hash === ctx.proof.execution_receipt.hash)); assert.ok(current.events.some(event => event.event_type === 'concept.transition.denied'));
    assert.equal(continued.mission.artifacts.every(artifact => !artifact.delivery), true); assert.deepEqual(ctx.reveals, []);
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()'); await waitFor('Boolean(document.querySelector(".yc-concept-decision[data-allowed=false]"))');
    assert.match(await evaluate('document.querySelector(".yc-concept-decision[data-allowed=false]").textContent'), /Stage unchanged: Stabilization/);
    await evaluate('document.querySelector(".yc-concept-decision[data-allowed=false]").scrollIntoView({block:"start"});true;'); await ctx.capture('denied-gate');
    ctx.checks.push('A later Work mission binds one actual immutable specialist version and source-resolved plan/build/execution evidence; Maturation denial retains missing reasons and a receipt while the stage remains Stabilization');
    await click('.yc-concept-actions button', 'Open current concept');
    await waitFor('document.querySelector("#yc-resource-detail .yc-concept-current")?.textContent.includes("Stabilization")');
    assert.equal(await evaluate('document.querySelector("#yc-resource-detail .yc-concept-record").dataset.conceptId'), ctx.proof.concept_id);
    await evaluate('document.querySelector("#yc-resource-detail .yc-concept-versions summary").click();document.querySelector("#yc-resource-detail .yc-concept-evidence summary").click();document.querySelector("#yc-resource-detail .yc-concept-versions").scrollIntoView({block:"start"});true;'); await ctx.capture('immutable-version');
    const requestsBeforeReload = ctx.requests.length, revisionBeforeReload = current.concept.revision; await ctx.reload();
    await evaluate('document.querySelector("[data-workspace=agents]").click();document.getElementById("yc-concepts-toggle").click()'); await waitFor('document.querySelectorAll(".yc-resource-card").length===1'); await evaluate('document.querySelector(".yc-resource-card").click()'); await waitFor('document.querySelector("#yc-resource-detail .yc-concept-current")?.textContent.includes("Stabilization")');
    assert.equal(ctx.requests.length, requestsBeforeReload); const restored = await envelope(`studio.concepts.inspect(${JSON.stringify(ctx.proof.concept_id)})`); assert.equal(restored.concept.revision, revisionBeforeReload); assert.equal(restored.concept.history_hash, current.concept.history_hash); assert.equal((await envelope('studio.concepts.list(20,null)')).total, 1);
    ctx.checks.push('Agents reads the same concept identity, eight named lifecycle options, immutable version and qualified evidence references; Use only drafts a continuation, and reload performs no model replay or stage mutation');
    const after = fingerprint(), changed = files.filter(file => before[file] !== after[file]); ctx.proof.source_verification = { before, after, changed }; assert.deepEqual(changed, []);
    ctx.proof.capture_condition = 'Actual native window, nonfocusable, transparent, offscreen and skip-taskbar; direct native capture';
  },
});
