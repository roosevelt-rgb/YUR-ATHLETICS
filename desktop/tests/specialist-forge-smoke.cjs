'use strict';
// Native novice journey: real Desktop IPC, Work, factory validation and commits.
// Only loopback model decisions are fixtures; this does not prove live inference.
const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');
const { nativeFixture } = require('./specialists-smoke.cjs');

const NAME = 'Novice evidence helper';
const DESCRIPTION = 'Count words and repeated terms in the text I provide.';
const SAMPLE = 'Alpha beta alpha.';
const DRAFT = 'Keep this unsent draft and its existing conversation history.';
const REJECT_NAME = 'FORGE_REJECT unsupported fixture';

nativeFixture({ prefix: 'specialist-forge', model: 'specialist-forge-fixture',
  handle({ body, completed, goal, call, send, proof }) {
    if (goal.includes('FORGE_PRESERVE_HISTORY')) return send('EXISTING_HISTORY: this conversation must survive the specialist builder.');
    assert.ok(body.tools.some(tool => tool.function.name === 'build_specialist'));
    if (goal.includes('FORGE_REJECT')) {
      if (!completed.length) return call('build_specialist', { name: REJECT_NAME, description: DESCRIPTION, capabilities: ['not.admitted'] });
      assert.equal(completed.length, 1);
      assert.notEqual(completed[0].value.committed, true);
      proof.rejected_tool_result = completed[0].value;
      return send('FORGE_REJECT_DONE: the requested capability was rejected. No specialist was built.');
    }
    if (goal.includes('FORGE_REUSE')) {
      if (!completed.length) return call('list_built_specialists', { limit: 20 });
      const catalog = completed[0].value;
      assert.equal(catalog.schema, 'yur.work-specialist-catalog.v1');
      assert.equal(catalog.entries.length, 1);
      assert.equal(catalog.entries[0].mission_id, proof.child_id);
      if (completed.length === 1) return call('run_saved_specialist', {
        mission_id: proof.child_id, capability_id: 'text.analyze', input: { text: 'Saved workers stay reusable.' },
      });
      assert.equal(completed.length, 2);
      const result = completed[1].value;
      assert.equal(result.tool, 'run_saved_specialist');
      assert.equal(result.mission_id, proof.child_id);
      assert.equal(result.committed, true);
      assert.equal(result.output.word_count, 4);
      assert.equal(result.selection.source_parent_work_id, proof.build_parent_id);
      assert.notEqual(result.provenance.parent_work_id, proof.build_parent_id);
      proof.reuse_parent_id = result.provenance.parent_work_id;
      proof.reuse_output = result.output;
      proof.reuse_run_id = result.run_id;
      return send('FORGE_REUSE_DONE: the exact saved specialist returned its actual result on fresh input.');
    }
    const marker = 'OPERATOR_SPECIALIST_BUILD_REQUEST\n';
    const instruction = body.messages.find(message => message.role === 'system' && message.content.includes(marker));
    assert.ok(instruction, 'The guided form must bind its typed request into Work context.');
    const requested = JSON.parse(instruction.content.slice(instruction.content.indexOf(marker) + marker.length));
    assert.deepEqual(requested, { name: NAME, description: DESCRIPTION, capabilities: ['text.analyze'],
      sample: { capability_id: 'text.analyze', input: { text: SAMPLE } } });
    assert.ok(goal.includes(NAME), 'The guided form must identify the requested specialist in its readable message.');
    proof.requested_build = requested;
    if (!completed.length) return call('build_specialist', {
      name: requested.name, description: requested.description, capabilities: requested.capabilities,
    });
    const build = completed[0].value;
    assert.equal(build.schema, 'yur.work-specialist-result.v1');
    assert.equal(build.tool, 'build_specialist');
    assert.equal(build.committed, true);
    assert.equal(build.artifact.validation.passed, true);
    assert.equal(build.artifact.validation.independent_validation.passed, true);
    assert.equal(build.artifact.selection.candidate_count, 2);
    assert.match(build.artifact.digest, /^[a-f0-9]{64}$/);
    proof.child_id = build.mission_id;
    proof.build_parent_id = build.provenance.parent_work_id;
    proof.build_result = build;
    if (completed.length === 1) return call('run_built_specialist', {
      mission_id: build.mission_id, capability_id: requested.sample.capability_id, input: requested.sample.input,
    });
    assert.equal(completed.length, 2);
    const result = completed[1].value;
    assert.equal(result.committed, true);
    assert.equal(result.mission_id, build.mission_id);
    assert.equal(result.output.word_count, 3);
    assert.equal(result.output.sentence_count, 1);
    assert.match(result.execution_receipt.hash, /^[a-f0-9]{64}$/);
    proof.sample_output = result.output;
    proof.sample_run_id = result.run_id;
    return send('FORGE_BUILD_DONE: the specialist was committed, independently checked, and run on the supplied sample.');
  },
  async run(ctx) {
    const { evaluate, waitFor, click, envelope } = ctx;
    const conversations = async () => (await envelope('studio.conversations.list()')).conversations;
    const library = () => envelope('studio.specialists.list(20,null)');
    const openAgents = async () => {
      await evaluate('document.querySelector("[data-workspace=agents]").click()');
      await waitFor('document.getElementById("yc-built-toggle").getAttribute("aria-pressed")==="true"');
      await waitFor('!document.getElementById("yc-catalog-note").textContent.includes("Reading")');
    };
    const fillBuilder = async (name = NAME) => {
      await evaluate('document.getElementById("yc-create-specialist").click()');
      await waitFor('Boolean(document.querySelector("form.sf-form"))');
      await evaluate(`(() => {
        const set = (selector, value) => { const field = document.querySelector(selector); field.value=value; field.dispatchEvent(new Event('input', {bubbles:true})); };
        document.querySelector('input.sf-starter-radio[value="text.analyze"]').click();
        set('input.sf-name', ${JSON.stringify(name)}); set('textarea.sf-description', ${JSON.stringify(DESCRIPTION)});
        document.querySelector('details.sf-sample-details').open=true;
        set('textarea.sf-sample-text', ${JSON.stringify(SAMPLE)});
      })()`);
    };

    // First retain actual history and a saved unsent draft in another conversation.
    await evaluate('document.getElementById("yc-mode").value="work";document.getElementById("yc-mode").dispatchEvent(new Event("change"));document.getElementById("yc-input").value="FORGE_PRESERVE_HISTORY";document.getElementById("yc-form").requestSubmit()');
    await waitFor('document.getElementById("yc-messages").textContent.includes("EXISTING_HISTORY") && !document.getElementById("yc-send").disabled');
    await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(DRAFT)};document.getElementById('yc-input').dispatchEvent(new Event('input'))`);
    const deadline = Date.now() + 15000;
    let original;
    while (Date.now() < deadline) {
      original = (await conversations()).find(item => item.messages.some(message => message.content.includes('EXISTING_HISTORY')));
      if (original?.draft === DRAFT) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(original?.draft, DRAFT);
    ctx.proof.original_conversation_id = original.id;
    const priorRequests = ctx.requests.length;
    await openAgents();
    assert.match(await evaluate('document.getElementById("yc-built-toggle").textContent'), /My agents/i);
    assert.equal((await library()).entries.length, 0);
    await fillBuilder();
    assert.equal(await evaluate('document.querySelector(".sf-preview-name").textContent'), NAME);
    assert.ok((await evaluate('document.querySelector(".sf-preview-description").textContent')).includes(DESCRIPTION));
    assert.equal(ctx.requests.length, priorRequests, 'Reading and editing the builder must not call a model.');
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'The builder stays inside the existing desktop.');
    await ctx.capture('guided-form');
    ctx.checks.push('Agents defaults to My agents; the guided form previews declared choices without model dispatch or a separate Factory window');

    ctx.providerCapabilities = ['completion'];
    const beforeBlocked = (await conversations()).length;
    await evaluate('document.querySelector("form.sf-form").requestSubmit()');
    await waitFor('!document.querySelector(".sf-error").hidden && !document.querySelector(".sf-submit").disabled');
    assert.match(await evaluate('document.querySelector(".sf-error").textContent'), /Tool support could not be verified/);
    assert.equal(await evaluate('document.querySelector(".sf-name").value'), NAME);
    assert.equal((await conversations()).length, beforeBlocked);
    assert.equal(ctx.requests.length, priorRequests);
    ctx.providerCapabilities = ['tools'];
    ctx.checks.push('A provider without advertised tools support retains the form and creates no conversation or model inference');

    await evaluate('document.querySelector("form.sf-form").requestSubmit()');
    await waitFor('document.getElementById("yc-messages").textContent.includes("FORGE_BUILD_DONE") && !document.getElementById("yc-send").disabled', 90000);
    const buildRecord = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.build_parent_id)})`);
    assert.equal(buildRecord.mission.status, 'completed');
    assert.equal(buildRecord.mission.request.mode, 'work');
    assert.notEqual(buildRecord.mission.request.conversation_id, original.id);
    assert.deepEqual(buildRecord.mission.steps.map(step => step.tool), ['build_specialist', 'run_built_specialist']);
    assert.ok(buildRecord.mission.steps.every(step => step.succeeded));
    const preserved = (await conversations()).find(item => item.id === original.id);
    assert.equal(preserved.draft, DRAFT);
    assert.deepEqual(preserved.messages, original.messages);
    ctx.proof.build_conversation_id = buildRecord.mission.request.conversation_id;
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()');
    await waitFor('document.querySelectorAll(".yc-specialist-card").length===2');
    assert.ok((await evaluate('document.querySelector(".yc-specialist-card").textContent')).includes('Independent validation passed.'));
    assert.ok((await evaluate('[...document.querySelectorAll(".yc-specialist-output")].map(node => node.textContent).join(" ")')).includes('word count'));
    await ctx.capture('committed-build-and-sample');
    ctx.checks.push('Build and check creates a new Work conversation, preserving prior history and draft; the real factory commits two-candidate validation and a three-word sample result');

    const beforeBrowse = ctx.requests.length;
    await openAgents();
    await waitFor('document.querySelectorAll("#yc-section-resources .yc-resource-card").length===1');
    const saved = await library();
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0].mission_id, ctx.proof.child_id);
    assert.equal(saved.entries[0].artifact_digest, ctx.proof.build_result.artifact.digest);
    await evaluate('document.querySelector("#yc-section-resources .yc-resource-card").click()');
    await waitFor('Boolean(document.querySelector(".yc-saved-specialist"))');
    await ctx.capture('my-agent-library');
    await click('.yc-saved-specialist button', 'Use in conversation');
    assert.equal(await evaluate('document.getElementById("yc-mode").value'), 'work');
    assert.ok((await evaluate('document.getElementById("yc-input").value')).includes(ctx.proof.child_id));
    assert.equal(ctx.requests.length, beforeBrowse, 'Use must prepare an editable draft without dispatch.');
    ctx.checks.push('My agents discovers the committed artifact and Use prepares its exact saved identity in an editable Work draft without inference or execution');

    await evaluate('document.getElementById("yc-input").value+="\\nFORGE_REUSE: analyze Saved workers stay reusable.";document.getElementById("yc-form").requestSubmit()');
    await waitFor('document.getElementById("yc-messages").textContent.includes("FORGE_REUSE_DONE") && !document.getElementById("yc-send").disabled', 60000);
    const reuse = await envelope(`studio.work.inspect(${JSON.stringify(ctx.proof.reuse_parent_id)})`);
    assert.deepEqual(reuse.mission.steps.map(step => step.tool), ['list_built_specialists', 'run_saved_specialist']);
    assert.ok(reuse.mission.steps.every(step => step.succeeded));
    const afterReuse = await library();
    assert.equal(afterReuse.entries.length, 1);
    assert.equal(afterReuse.entries[0].artifact_digest, saved.entries[0].artifact_digest);
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()');
    await waitFor('Boolean(document.querySelector(".yc-specialist-output"))');
    await ctx.capture('fresh-input-reuse');
    ctx.checks.push('Sending the prepared request runs the same specialist on fresh four-word input, retains original build evidence and creates no duplicate build');

    // A bad model tool proposal must remain a rejected operation, never a build card.
    await openAgents(); await fillBuilder(REJECT_NAME);
    await evaluate('document.querySelector("form.sf-form").requestSubmit()');
    await waitFor('document.getElementById("yc-messages").textContent.includes("FORGE_REJECT_DONE") && !document.getElementById("yc-send").disabled', 60000);
    const rejectedSummary = (await envelope('studio.work.list(null)')).missions.find(item => item.request?.goal?.includes('FORGE_REJECT') || item.goal?.includes('FORGE_REJECT'));
    assert.ok(rejectedSummary, 'The rejected attempt must remain inspectable.');
    const rejected = await envelope(`studio.work.inspect(${JSON.stringify(rejectedSummary.id)})`);
    assert.deepEqual(rejected.mission.steps.map(step => step.tool), ['build_specialist']);
    assert.equal(rejected.mission.steps[0].succeeded, false);
    assert.equal(rejected.mission.steps[0].result?.committed, false);
    ctx.proof.rejected_parent_id = rejectedSummary.id;
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()');
    await waitFor('document.getElementById("yc-detail-body").textContent.includes("rejected")');
    assert.equal(await evaluate('document.querySelectorAll(".yc-specialist-card").length'), 0);
    assert.equal((await library()).entries.length, 1);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await ctx.capture('rejected-build');
    ctx.checks.push('An unsupported model capability is rejected by the real typed boundary; no successful specialist card, duplicate saved build or secondary window appears');
  },
});
