'use strict';
// Real Desktop IPC, file acquisition, CommitService and Work. Only model
// responses and the explicitly discarded import acknowledgement are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');

const appRoot = path.resolve(__dirname, '..');
const monitored = ['tests/project-files-smoke.cjs', 'tests/specialists-smoke.cjs',
  'src/main.js', 'src/preload.js', 'src/conversation-view.js', 'src/conversation.css',
  'src/project-files-view.js', 'src/conversation-transport.js', 'src/work-transport.js',
  'src/work-view.js', 'src/model-setup.js', 'src/transcript-position.js',
  'src/composer-intake.js', 'src/repository-context.js', 'src/desktop-runtime.js', 'src/embedded-runtime.js',
  ...fs.readdirSync(path.join(appRoot, 'foundry')).filter(name => name.endsWith('.py')).map(name => `foundry/${name}`)];
const fingerprints = () => Object.fromEntries(monitored.map(name => [name, sha(fs.readFileSync(path.join(appRoot, name)))]));
const before = fingerprints();
const alpha = randomUUID(), beta = randomUUID(), one = randomUUID(), two = randomUUID(), foreign = randomUUID();
const selectedText = '# Shared quantity note\n\nPROJECT_SHARED_MEASUREMENT_47: measured area is 47 square metres.\nSource label: Café review.\n';
const unselectedText = 'UNSELECTED_ALPHA_FILE_981c must never be sent without selection.\n';
const foreignText = 'FOREIGN_BETA_FILE_512f belongs only to the other project.\n';
const selectedHash = sha(Buffer.from(selectedText, 'utf8'));
let expectedContext = null, selectedFile = null, importedPath = null;

nativeFixture({ prefix: 'project-files', model: 'project-files-fixture', gracefulShutdown: true,
  async afterShutdown(ctx, observed) {
    const after = fingerprints();
    ctx.proof.source_verification = { before, after, changed: Object.keys(before).filter(name => before[name] !== after[name]) };
    assert.deepEqual(after, before); assert.equal(observed, true);
  },
  handle({ body, completed, goal, send, proof, requests }) {
    assert.ok(expectedContext && selectedFile, 'Native context must be acquired before any fixture model call');
    assert.ok(goal.includes('PROJECT_REFERENCE_TASK_'));
    assert.equal(completed.length, 0, 'This fixture asks for a text answer, not file or worker tool execution');
    assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'Request must use the actual Work provider path');
    const compiled = body.messages.map(message => message.content).join('\n');
    assert.ok(compiled.includes(expectedContext.context), 'The actual compiled payload must contain the exact committed context');
    assert.ok(compiled.includes('PROJECT_SHARED_MEASUREMENT_47')); assert.ok(compiled.includes(selectedHash));
    for (const excluded of ['UNSELECTED_ALPHA_FILE_981c', 'FOREIGN_BETA_FILE_512f', 'SOURCE_MARKER_92bd', importedPath]) assert.equal(compiled.includes(excluded), false);
    assert.ok(body.messages[0].content.includes('Folder: none.'), 'Reference context does not expand the execution root');
    const suffix = goal.includes('_ONE') ? 'ONE' : 'TWO';
    proof.compiled_requests ||= [];
    proof.compiled_requests.push({ ordinal: requests.length, goal, messages_sha256: sha(JSON.stringify(body.messages)),
      selected_file_id: selectedFile.id, selected_sha256: selectedHash, context_sha256: sha(expectedContext.context), root: null });
    send(`PROJECT_REFERENCE_DONE_${suffix}: shared-quantity.md reports 47 square metres.`);
  },
  async run(ctx) {
    const { evaluate, waitFor, envelope } = ctx;
    const evidenceRoot = path.join(ctx.tempRoot, 'project-files-evidence'); fs.mkdirSync(evidenceRoot);
    ctx.proof.artifact_copies = [];
    function artifact(name, value) {
      const target = path.join(evidenceRoot, name), bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      fs.writeFileSync(target, bytes); ctx.proof.artifact_copies.push({ path: target, bytes: bytes.length, sha256: sha(bytes) });
    }
    const listConversations = async () => (await envelope('studio.conversations.list()')).conversations;
    const conversation = async id => (await listConversations()).find(item => item.id === id);
    const base = projectId => ({ project_id: projectId, expected_project_revision: 1 });
    const listFiles = projectId => envelope(`studio.projectFiles.list(${JSON.stringify(base(projectId))})`);
    async function home(projectId) {
      const selector = `#yc-sidebar-projects-list [data-project-id="${projectId}"]`;
      await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await waitFor(`document.getElementById('yc-project-home')?.dataset.projectId === ${JSON.stringify(projectId)} && Boolean(document.querySelector('.yc-project-files')?.dataset.collectionRevision)`);
    }
    async function openConversation(projectId, id) {
      await home(projectId);
      const selector = `#yc-project-conversations [data-conversation-id="${id}"]`;
      await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await waitFor(`!document.getElementById('yc-main').classList.contains('section-open') && document.getElementById('yc-project').value === ${JSON.stringify(projectId)} && document.getElementById('yc-mode').value === 'work'`);
      await waitFor(`document.getElementById('yc-model').value === ${JSON.stringify('ollama:' + ctx.model)} && document.getElementById('yc-model-setup-host').classList.contains('yc-hidden')`);
    }
    const reference = file => ({ file_id: file.id, revision: file.revision, sha256: file.sha256 });
    async function selectShared(id) {
      await evaluate("document.getElementById('yc-project-files-open').click()");
      const selector = `.yc-project-files-checkbox[data-file-id="${selectedFile.id}"]`;
      await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`), false, 'Another conversation must not inherit selection');
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await waitFor(`studio.conversations.list().then(r=>r.ok && r.result.conversations.find(c=>c.id===${JSON.stringify(id)})?.project_file_selections?.files.some(f=>f.file_id===${JSON.stringify(selectedFile.id)}))`);
      await waitFor(`document.querySelector(${JSON.stringify(selector)})?.checked === true && !document.querySelector(${JSON.stringify(selector)}).disabled`);
      assert.deepEqual((await conversation(id)).project_file_selections, { project_id: alpha, files: [reference(selectedFile)] });
    }
    async function send(id, suffix) {
      const goal = `PROJECT_REFERENCE_TASK_${suffix}: report the selected document's measurement and cite its file name.`;
      await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-input').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('yc-form').requestSubmit()`);
      await waitFor(`document.getElementById('yc-messages').textContent.includes(${JSON.stringify('PROJECT_REFERENCE_DONE_' + suffix)}) && !document.getElementById('yc-send').disabled`);
      // Enabled Send can mean correction readiness; visible text precedes the
      // final journal acknowledgment. Verify the committed answer independently.
      await waitFor(`studio.conversations.list().then(response => response.ok && response.result.conversations.find(item => item.id === ${JSON.stringify(id)})?.messages.some(message => message.role === 'assistant' && message.content.includes(${JSON.stringify('PROJECT_REFERENCE_DONE_' + suffix)})))`);
      const saved = await conversation(id), messages = saved.messages;
      assert.equal(messages.length, 2); assert.equal(messages[0].role, 'user'); assert.equal(messages[1].role, 'assistant');
      assert.deepEqual(messages[0].evidence.project_files, expectedContext.evidence);
      assert.equal(Object.hasOwn(messages[0].evidence.project_files.files[0], 'text'), false);
      assert.equal(messages[0].content.includes(selectedText), false, 'Shared context belongs to compiled context, not a duplicated user message');
      assert.equal(messages[0].evidence.repository_selection, null);
      const missions = (await envelope(`studio.work.list(${JSON.stringify(id)})`)).missions;
      assert.equal(missions.length, 1);
      const record = await envelope(`studio.work.inspect(${JSON.stringify(missions[0].id)})`);
      assert.equal(record.mission.status, 'completed'); assert.equal(record.mission.request.root, null);
      assert.equal(record.mission.request.conversation_id, id); assert.deepEqual(record.mission.steps, []);
      assert.ok(record.mission.request.messages.some(message => message.content.includes(expectedContext.context)));
      artifact(`work-${suffix.toLowerCase()}.json`, record); artifact(`conversation-${suffix.toLowerCase()}.json`, saved);
      return { saved, record };
    }

    const now = new Date().toISOString();
    for (const project of [{ id: alpha, name: 'Shared reference review' }, { id: beta, name: 'Separate reference project' }]) {
      await envelope(`studio.workspace.save('project',${JSON.stringify({ ...project, root: '', instructions: '', createdAt: now, updatedAt: now })},0)`);
    }
    for (const [id, projectId, title] of [[one, alpha, 'First reference review'], [two, alpha, 'Second reference review'], [foreign, beta, 'Other project review']]) {
      await envelope(`studio.conversations.save(${JSON.stringify({ id, title, model: 'ollama:' + ctx.model, createdAt: now, updatedAt: now, messages: [], draft: '', metadata: { mode: 'work', project_id: projectId, pinned: false, archived: false, parent_id: null } })},0)`);
    }
    const inputsRoot = path.join(ctx.tempRoot, 'selected public documents'); fs.mkdirSync(inputsRoot);
    importedPath = path.join(inputsRoot, 'shared-quantity.md'); fs.writeFileSync(importedPath, selectedText, 'utf8');
    const addRequest = { ...base(alpha), expected_collection_revision: 0, operation_id: randomUUID(), path: importedPath, expected_sha256: selectedHash };
    // Fault injection is at the test consumer, after the real commit. The
    // independent observation records its receipt while the consumer loses it.
    const lost = await evaluate(`(async()=>{ const response=await studio.projectFiles.add(${JSON.stringify(addRequest)}); if(!response.ok) return response; window.__projectFilesCommittedObservation=JSON.parse(JSON.stringify(response.result)); return {ok:false,error:{code:'FIXTURE_ACK_DISCARDED',message:'Import reply discarded after actual commit'}}; })()`);
    assert.equal(lost.error.code, 'FIXTURE_ACK_DISCARDED');
    const committed = await evaluate('window.__projectFilesCommittedObservation');
    assert.equal(committed.replayed, false); assert.equal(committed.collection_revision, 1); assert.equal(committed.files.length, 1);
    selectedFile = committed.files[0]; assert.equal(selectedFile.sha256, selectedHash); assert.equal(selectedFile.bytes, Buffer.byteLength(selectedText));
    artifact('selected-source-copy.md', selectedText); artifact('import-committed.json', committed);
    const resolved = fs.realpathSync(importedPath), tempRoot = fs.realpathSync(ctx.tempRoot), relative = path.relative(tempRoot, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(path.basename(resolved), 'shared-quantity.md'); assert.equal(sha(fs.readFileSync(resolved)), selectedHash);
    fs.unlinkSync(resolved); assert.equal(fs.existsSync(importedPath), false);
    const replay = await envelope(`studio.projectFiles.add(${JSON.stringify(addRequest)})`);
    assert.deepEqual(replay, { ...committed, replayed: true }); assert.equal((await listFiles(alpha)).files.length, 1);
    const altered = await evaluate(`studio.projectFiles.add(${JSON.stringify({ ...addRequest, expected_collection_revision: 1 })})`);
    assert.equal(altered.ok, false); assert.equal(altered.error.code, 'CONFLICT');
    artifact('import-replay.json', replay);
    ctx.proof.import = { request: addRequest, receipt: replay.receipt, acknowledgement_fault: 'test consumer discarded successful reply', original_deleted: true, replayed_without_source: true };
    await ctx.reload(); await home(alpha); await ctx.capture('import-replayed');
    ctx.checks.push('Actual import commits original bytes once; after a simulated lost acknowledgement and checked temporary-source deletion, the same UUID returns the identical receipt without rereading or duplicating the source');

    for (const [projectId, name, text, revision] of [[alpha, 'unselected.md', unselectedText, 1], [beta, 'other-project.md', foreignText, 0]]) {
      const source = path.join(inputsRoot, name); fs.writeFileSync(source, text, 'utf8');
      await envelope(`studio.projectFiles.add(${JSON.stringify({ ...base(projectId), expected_collection_revision: revision, operation_id: randomUUID(), path: source, expected_sha256: sha(text) })})`);
    }
    expectedContext = await envelope(`studio.projectFiles.context(${JSON.stringify({ ...base(alpha), selections: [reference(selectedFile)] })})`);
    assert.equal(sha(expectedContext.context), expectedContext.evidence.context_sha256);
    const parsed = JSON.parse(expectedContext.context); assert.equal(parsed.context_only, true); assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].text, selectedText); assert.equal(parsed.files[0].excerpt_sha256, selectedHash);
    artifact('compiled-project-context.json', expectedContext);
    await ctx.reload(); await openConversation(alpha, one); await selectShared(one);
    await ctx.capture('selection-saved'); await ctx.reload(); await openConversation(alpha, one);
    assert.equal(await evaluate("document.getElementById('yc-project-files-open').textContent"), 'Project files · 1 selected');
    await evaluate("document.getElementById('yc-project-files-open').click()");
    await waitFor(`document.querySelector('.yc-project-files-checkbox[data-file-id="${selectedFile.id}"]')?.checked === true`);
    assert.equal((await conversation(two)).project_file_selections, undefined); assert.equal(ctx.requests.length, 0);
    ctx.checks.push('An explicit UI checkbox commits the exact file ID/revision/hash to one conversation and reload restores that selection; the second conversation inherits no selection');

    await openConversation(beta, foreign); await evaluate("document.getElementById('yc-project-files-open').click()");
    await waitFor(`document.querySelector('.yc-project-files')?.dataset.projectId === ${JSON.stringify(beta)} && document.querySelector('.yc-project-files')?.dataset.collectionRevision === '1'`);
    const foreignLibrary = await evaluate("document.querySelector('.yc-project-files').textContent");
    assert.ok(foreignLibrary.includes('other-project.md')); assert.equal(foreignLibrary.includes('shared-quantity.md'), false);
    assert.equal(await evaluate("[...document.querySelectorAll('.yc-project-files-checkbox')].some(node=>node.checked)"), false);
    const empty = await envelope(`studio.projectFiles.context(${JSON.stringify({ ...base(beta), selections: [] })})`);
    assert.deepEqual(JSON.parse(empty.context).files, []);
    const crossProject = await evaluate(`studio.projectFiles.context(${JSON.stringify({ ...base(beta), selections: [reference(selectedFile)] })})`);
    assert.equal(crossProject.ok, false); assert.equal(ctx.requests.length, 0); artifact('cross-project-rejection.json', crossProject);
    await ctx.capture('other-project-isolated');
    ctx.checks.push('Another project shows only its own library and no inherited selection; the actual context API rejects a foreign file ID and empty selection injects no documents');

    await openConversation(alpha, one); const first = await send(one, 'ONE'); await ctx.capture('first-conversation-complete');
    await openConversation(alpha, two); await selectShared(two); await openConversation(alpha, two);
    const second = await send(two, 'TWO'); await ctx.capture('second-conversation-complete');
    assert.equal(ctx.requests.length, 2); assert.notEqual(first.record.mission.id, second.record.mission.id);
    assert.equal(fs.existsSync(importedPath), false); assert.deepEqual(second.saved.messages[0].evidence.project_files, first.saved.messages[0].evidence.project_files);
    ctx.proof.work_mission_ids = [first.record.mission.id, second.record.mission.id];
    ctx.checks.push('Two real Work missions in separate same-project conversations compile the identical retained source and verified provenance after source deletion, exclude unselected/foreign documents, and keep execution root null');

    await home(alpha);
    const remove = `.yc-project-file[data-file-id="${selectedFile.id}"] .yc-project-file-remove`;
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(remove)}) && !document.querySelector(${JSON.stringify(remove)}).disabled)`);
    await evaluate(`document.querySelector(${JSON.stringify(remove)}).click()`);
    await waitFor("document.querySelector('.yc-project-files')?.dataset.collectionRevision === '3'");
    const removed = await listFiles(alpha); assert.equal(removed.files.length, 1); assert.equal(removed.files.some(file => file.id === selectedFile.id), false);
    await waitFor(`Boolean(document.querySelector('.yc-project-file-missing[data-file-id="${selectedFile.id}"]'))`);
    const retainedSelection = (await conversation(two)).project_file_selections;
    assert.deepEqual(retainedSelection.files, [reference(selectedFile)]);
    await openConversation(alpha, two);
    const failedDraft = 'STALE_REFERENCE_DRAFT_aa61: use the selected shared reference again.';
    await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(failedDraft)}; document.getElementById('yc-input').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('yc-form').requestSubmit()`);
    await waitFor("document.getElementById('yc-notice').textContent.includes('Your draft is retained') && !document.getElementById('yc-send').disabled");
    assert.equal(await evaluate("document.getElementById('yc-input').value"), failedDraft);
    await waitFor(`studio.conversations.list().then(r=>r.ok && r.result.conversations.find(c=>c.id===${JSON.stringify(two)})?.draft===${JSON.stringify(failedDraft)})`);
    assert.equal(ctx.requests.length, 2); assert.deepEqual((await conversation(two)).messages, second.saved.messages);
    assert.deepEqual(await envelope(`studio.work.inspect(${JSON.stringify(second.record.mission.id)})`), second.record);
    await ctx.reload(); await openConversation(alpha, two);
    assert.equal(await evaluate("document.getElementById('yc-input').value"), failedDraft);
    assert.deepEqual((await conversation(two)).project_file_selections, retainedSelection);
    await evaluate("document.getElementById('yc-project-files-open').click()");
    await waitFor(`document.querySelector('.yc-project-file-missing[data-file-id="${selectedFile.id}"] .yc-project-files-checkbox')?.checked === true`);
    await ctx.capture('removed-selection-retained');
    const finalList = await listFiles(alpha); assert.deepEqual(finalList, removed);
    assert.equal(ctx.requests.length, 2); artifact('removed-library.json', removed); artifact('stale-conversation-retained.json', await conversation(two));
    ctx.proof.project_ids = [alpha, beta]; ctx.proof.conversation_ids = [one, two, foreign]; ctx.proof.selected_file = reference(selectedFile);
    ctx.proof.model_decisions = 'two deterministic loopback replies; no live model';
    ctx.checks.push('UI removal invalidates the saved selection; Send fails before another model or mission starts, preserving the draft, old task evidence and stale selection across reload');
  },
});
