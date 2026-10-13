'use strict';
// Actual desktop, project/conversation commits, repository acquisition and Work
// execute against temporary local fixtures. Model decisions are loopback replies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const monitored = ['tests/project-navigation-smoke.cjs', 'tests/specialists-smoke.cjs',
  'src/conversation-view.js', 'src/conversation.css', 'src/main.js', 'src/preload.js',
  'src/conversation-transport.js', 'src/desktop-runtime.js', 'src/embedded-runtime.js',
  'foundry/conversation_cli.py', 'foundry/commit_service.py', 'foundry/work_engine.py',
  'foundry/work_store.py', 'foundry/work_tools.py', 'foundry/orchestration.py'];
const fingerprints = () => Object.fromEntries(monitored.map(name => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))]));
const before = fingerprints();
const alpha = randomUUID(), beta = randomUUID();
const alphaInstructions = 'ALPHA_PROJECT_RULE_7b41: cite the exact selected source.', betaInstructions = 'BETA_PRIVATE_CONTEXT_a229';
const goal = 'Read the selected project story and report its source marker.';
let heldCall;

nativeFixture({ prefix: 'project-navigation', model: 'project-navigation-fixture', gracefulShutdown: true,
  async afterShutdown(ctx, observed) {
    const after = fingerprints();
    ctx.proof.source_verification = { before, after, changed: Object.keys(before).filter(name => before[name] !== after[name]) };
    assert.deepEqual(after, before); assert.equal(observed, true);
  },
  handle({ body, completed, call, send, proof }) {
    const compiled = JSON.stringify(body.messages);
    assert.ok(compiled.includes(alphaInstructions));
    assert.equal(compiled.includes(betaInstructions), false, 'Other project instructions must not enter this task');
    if (!completed.length) { heldCall = () => call('read_file', { path: 'story.md' }); return; }
    assert.equal(completed.length, 1); assert.equal(completed[0].name, 'read_file');
    assert.ok(completed[0].value.content.includes('SOURCE_MARKER_92bd'));
    proof.read_result = completed[0].value;
    send('PROJECT_WORK_DONE: SOURCE_MARKER_92bd came from the selected project.');
  },
  async run(ctx) {
    const { evaluate, waitFor, envelope, click } = ctx;
    const list = async () => (await envelope('studio.conversations.list()')).conversations;
    const chooseProject = async id => {
      await waitFor(`Boolean(document.querySelector('#yc-sidebar-projects-list [data-project-id="${id}"]'))`);
      await evaluate(`document.querySelector('#yc-sidebar-projects-list [data-project-id="${id}"]').click()`);
      await waitFor(`document.getElementById('yc-project-home')?.dataset.projectId === ${JSON.stringify(id)}`);
    };
    const startMode = async mode => {
      const previous = new Set((await list()).map(item => item.id));
      await evaluate(`document.querySelector('.yc-project-start[data-project-mode="${mode}"]').click()`);
      await waitFor(`!document.getElementById('yc-main').classList.contains('section-open') && document.getElementById('yc-mode').value===${JSON.stringify(mode)}`);
      await waitFor(`studio.conversations.list().then(r=>r.ok && r.result.conversations.some(c=>!${JSON.stringify([...previous])}.includes(c.id)))`);
      const created = (await list()).filter(item => !previous.has(item.id));
      assert.equal(created.length, 1); return created[0];
    };
    const draft = async text => {
      await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(text)}; document.getElementById('yc-input').dispatchEvent(new Event('input',{bubbles:true}))`);
      await waitFor(`studio.conversations.list().then(r=>r.ok && r.result.conversations.some(c=>c.draft===${JSON.stringify(text)}))`);
    };
    const now = new Date().toISOString();
    for (const project of [
      { id: alpha, name: 'Construction delivery', root: ctx.sourceRoot, instructions: alphaInstructions, createdAt: now, updatedAt: now },
      { id: beta, name: 'Product research', root: '', instructions: betaInstructions, createdAt: now, updatedAt: now },
    ]) await envelope(`studio.workspace.save('project',${JSON.stringify(project)},0)`);
    const seeded = [];
    for (const [title, projectId] of [['Personal conversation', null], ['Earlier construction chat', alpha], ['Research notes', beta]]) {
      const item = { id: randomUUID(), title, model: 'ollama:' + ctx.model, createdAt: now, updatedAt: now,
        messages: [{ id: randomUUID(), role: 'user', content: title, createdAt: now }],
        draft: '', metadata: { mode: 'chat', project_id: projectId, pinned: false, archived: false, parent_id: null } };
      seeded.push((await envelope(`studio.conversations.save(${JSON.stringify(item)},0)`)).conversation);
    }
    await ctx.reload(); await click('#yc-history .yc-history-item', 'Personal conversation');
    const personal = seeded.find(item => !item.metadata.project_id);
    await chooseProject(alpha);
    assert.equal(await evaluate('document.getElementById("yc-project-home-title").textContent'), 'Construction delivery');
    assert.ok((await evaluate('document.getElementById("yc-project-home-root").textContent')).includes(ctx.sourceRoot));
    assert.equal(await evaluate('document.getElementById("yc-project-home-instructions").textContent'), alphaInstructions);
    const projectHistory = await evaluate('document.getElementById("yc-project-conversations").textContent');
    assert.ok(projectHistory.includes('Earlier construction chat')); assert.equal(projectHistory.includes('Research notes'), false);
    assert.deepEqual((await list()).find(item => item.id === personal.id), personal);
    assert.equal(ctx.requests.length, 0);
    await ctx.capture('project-home');
    ctx.checks.push('Named sidebar projects open a context-and-history home without changing the prior conversation, reading sources or calling a model');

    const managed = seeded.find(item => item.metadata.project_id === alpha), managedTitle = 'Reviewed construction conversation';
    const openRowMenu = async () => {
      await evaluate(`document.querySelector('#yc-project-conversations [data-conversation-id="${managed.id}"]').closest('.yc-project-conversation-row').querySelector('.yc-history-menu').click()`);
      await waitFor('Boolean(document.querySelector("dialog[open]"))');
    };
    await openRowMenu();
    await evaluate(`document.getElementById('yc-field-conversation-title').value=${JSON.stringify(managedTitle)}; document.getElementById('yc-field-conversation-pinned').checked=true`);
    await click('.yc-dialog button', 'Save changes');
    await waitFor(`!document.querySelector('dialog[open]') && document.querySelector('#yc-project-conversations [data-conversation-id="${managed.id}"]')?.title === ${JSON.stringify(managedTitle)}`);
    assert.equal(await evaluate(`document.getElementById('yc-project-home')?.dataset.projectId`), alpha);
    assert.ok((await evaluate(`document.querySelector('#yc-project-conversations [data-conversation-id="${managed.id}"]').textContent`)).startsWith('◆ ' + managedTitle));
    let managedSaved = (await list()).find(item => item.id === managed.id);
    assert.equal(managedSaved.title, managedTitle); assert.equal(managedSaved.metadata.pinned, true);
    await openRowMenu();
    await evaluate('document.getElementById("yc-field-conversation-archived").checked=true');
    await click('.yc-dialog button', 'Save changes');
    await waitFor(`!document.querySelector('dialog[open]') && !document.querySelector('#yc-project-conversations [data-conversation-id="${managed.id}"]')`);
    assert.equal(await evaluate('document.getElementById("yc-project-home")?.dataset.projectId'), alpha);
    assert.ok((await evaluate('document.getElementById("yc-project-history").textContent')).includes('1 archived conversation remains'));
    managedSaved = (await list()).find(item => item.id === managed.id); assert.equal(managedSaved.metadata.archived, true);
    assert.deepEqual((await list()).find(item => item.id === personal.id), personal);
    assert.equal(ctx.requests.length, 0); ctx.proof.managed_conversation = { id: managed.id, revision: managedSaved.revision, title: managedSaved.title, archived: managedSaved.metadata.archived };
    await ctx.capture('project-managed-history');
    ctx.checks.push('Managing a nonactive project row refreshes rename, pin and archive immediately after actual journal commits while keeping project home and the prior conversation intact');

    const chat = await startMode('chat'); assert.equal(chat.metadata.project_id, alpha); assert.equal(chat.metadata.mode, 'chat');
    await draft('ALPHA_CHAT_DRAFT_320d: keep this unsent project idea.');
    const savedChat = (await list()).find(item => item.id === chat.id);
    await chooseProject(alpha); const work = await startMode('work');
    assert.notEqual(work.id, chat.id); assert.equal(work.metadata.project_id, alpha); assert.equal(work.metadata.mode, 'work');
    assert.deepEqual((await list()).find(item => item.id === chat.id), savedChat);
    assert.equal(await evaluate('document.getElementById("yc-input").value'), '');
    await evaluate(`document.getElementById('yc-model').value=${JSON.stringify('ollama:' + ctx.model)}; document.getElementById('yc-model').dispatchEvent(new Event('change')); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit()`);
    const until = Date.now() + 30000;
    while (!heldCall && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(typeof heldCall, 'function');
    assert.equal(await evaluate('[...document.querySelectorAll("#yc-mode-switch [data-mode]")].length'), 3);
    assert.equal(await evaluate('[...document.querySelectorAll("#yc-mode-switch [data-mode]")].every(button=>button.disabled)'), true);
    await evaluate('document.getElementById("yc-mode").value="code"; document.getElementById("yc-mode").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('document.getElementById("yc-mode").value'), 'work');
    await ctx.capture('project-work-running'); heldCall();
    await waitFor('document.getElementById("yc-messages").textContent.includes("PROJECT_WORK_DONE") && !document.getElementById("yc-send").disabled');
    const missions = (await envelope(`studio.work.list(${JSON.stringify(work.id)})`)).missions;
    assert.equal(missions.length, 1);
    const record = await envelope(`studio.work.inspect(${JSON.stringify(missions[0].id)})`);
    assert.equal(record.mission.status, 'completed'); assert.equal(record.mission.request.mode, 'work');
    assert.deepEqual(record.mission.steps.map(step => step.tool), ['read_file']);
    const completedWork = (await list()).find(item => item.id === work.id);
    assert.equal(completedWork.metadata.project_id, alpha); assert.equal(completedWork.metadata.mode, 'work');
    assert.equal(completedWork.messages[0].evidence.project.id, alpha);
    ctx.proof.work_id = record.mission.id; ctx.proof.work_conversation = work.id;
    await ctx.capture('project-work-complete');
    ctx.checks.push('New Chat and Work create separate committed project conversations; real Work acquires the correct project context and executes a read while mode changes are blocked');

    await chooseProject(alpha); const code = await startMode('code');
    assert.equal(code.metadata.project_id, alpha); assert.equal(code.metadata.mode, 'code');
    await draft('ALPHA_CODE_DRAFT_b9cf: inspect this code later.');
    assert.equal(ctx.requests.length, 2, 'Preparing Code must not start another task');
    await chooseProject(beta); const betaChat = await startMode('chat');
    assert.equal(betaChat.metadata.project_id, beta); assert.equal(betaChat.metadata.mode, 'chat');
    assert.equal(await evaluate('document.getElementById("yc-input").value'), '');
    assert.equal(await evaluate('document.getElementById("yc-repository").textContent.includes(' + JSON.stringify(ctx.sourceRoot) + ')'), false);
    await draft('BETA_CHAT_DRAFT_d312: a separate research idea.');
    assert.equal(await evaluate('document.getElementById("yc-mode").getClientRects().length > 0'), true, 'The composer mode control must be visible');
    await evaluate('(() => { const control=document.getElementById("yc-mode"); control.focus(); control.value="code"; control.dispatchEvent(new Event("change",{bubbles:true})); })();');
    await waitFor('document.getElementById("yc-mode").value==="code"');
    assert.equal(await evaluate('document.activeElement?.id'), 'yc-mode');
    await waitFor(`studio.conversations.list().then(r=>r.result.conversations.find(c=>c.id===${JSON.stringify(betaChat.id)})?.metadata.mode==='code')`);
    await evaluate('document.getElementById("yc-mode").value="chat"; document.getElementById("yc-mode").dispatchEvent(new Event("change",{bubbles:true}));');
    await waitFor(`studio.conversations.list().then(r=>r.result.conversations.find(c=>c.id===${JSON.stringify(betaChat.id)})?.metadata.mode==='chat')`);
    ctx.checks.push('Project Code prepares an independent saved draft without execution; another project starts without copied repository context, and visible composer mode changes persist');

    const snapshot = await list(), requestCount = ctx.requests.length;
    await ctx.reload();
    await chooseProject(alpha);
    const restored = await evaluate('document.getElementById("yc-project-conversations").textContent');
    assert.ok(restored.includes(goal)); assert.ok(restored.includes('ALPHA_CHAT_DRAFT')); assert.ok(restored.includes('ALPHA_CODE_DRAFT'));
    assert.equal(restored.includes('BETA_CHAT_DRAFT'), false);
    await evaluate(`document.querySelector('#yc-project-conversations [data-conversation-id="${work.id}"]').click()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("PROJECT_WORK_DONE")');
    assert.equal(await evaluate('document.getElementById("yc-project").value'), alpha);
    assert.deepEqual((await list()).find(item => item.id === work.id), snapshot.find(item => item.id === work.id));
    assert.deepEqual(await envelope(`studio.work.inspect(${JSON.stringify(record.mission.id)})`), record);
    assert.equal(ctx.requests.length, requestCount);
    await ctx.capture('project-restored');
    ctx.proof.project_ids = [alpha, beta]; ctx.proof.conversation_ids = [chat.id, work.id, code.id, betaChat.id];
    ctx.checks.push('Reload restores project grouping, separate drafts, mode and the exact completed Work record without replaying model requests or tools');

    const titleBeforeDialog = await evaluate('document.getElementById("yc-thread-title").textContent');
    await evaluate('document.getElementById("yc-conversation-actions").click()');
    await waitFor('Boolean(document.querySelector("dialog[open]"))');
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"n",ctrlKey:true,bubbles:true}))');
    assert.equal(await evaluate('document.getElementById("yc-thread-title").textContent'), titleBeforeDialog);
    await click('.yc-dialog button', 'Cancel');
    await chooseProject(alpha);
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    window.setContentSize(820, 920);
    await waitFor('window.innerWidth>=780 && window.innerWidth<=850');
    ctx.proof.narrow_viewport = await evaluate('({width:window.innerWidth,height:window.innerHeight})');
    assert.equal(await evaluate('document.getElementById("yc-project-home").getBoundingClientRect().right<=window.innerWidth'), true);
    await ctx.capture('project-narrow');
    window.setSize(1440, 960);
    ctx.checks.push('The visible composer mode control retains focus; modal dialogs block global New shortcuts; project home remains inside the narrow desktop viewport');
  },
});
