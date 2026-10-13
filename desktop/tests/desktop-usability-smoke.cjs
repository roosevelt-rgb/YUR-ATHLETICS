'use strict';
// Actual Electron/main/preload/CommitService. Only model decisions are loopback
// fixtures. No external provider, WSL, runtime preparation or user state is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const monitored = ['tests/desktop-usability-smoke.cjs', 'tests/specialists-smoke.cjs',
  'src/conversation-view.js', 'src/conversation.css', 'src/studio-editor.html',
  'src/model-setup.js', 'src/model-setup.css', 'src/transcript-position.js', 'src/recent-work.js', 'src/recent-work.css',
  'src/main.js', 'src/preload.js', 'src/conversation-transport.js', 'src/work-transport.js', 'src/work-view.js', 'src/chat-renderer.js',
  'foundry/conversation_cli.py', 'foundry/commit_service.py', 'foundry/work_cli.py',
  'foundry/work_engine.py', 'foundry/work_store.py', 'foundry/work_tools.py', 'foundry/orchestration.py'];
const fingerprints = () => Object.fromEntries(monitored.map(name => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))]));
const before = fingerprints();
const model = 'desktop-usability-fixture', unavailable = 'ollama:unavailable-fixture';
const longTitle = 'Usability reading conversation', otherTitle = 'Independent usability conversation';
const retainedDraft = 'Keep this draft while I choose an available model.';
const goal = 'Create a Markdown reading report and retain it as an artifact.';
const artifactName = 'reading-report-a17c.md', artifactText = '# Retained reading report\n\nUSABILITY_ARTIFACT_73bc: actual committed fixture output.\n';
let releaseTool, releaseAnswer;
const waitUntil = async predicate => { const until = Date.now() + 30000; while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for the held fixture provider turn'); };

nativeFixture({ prefix: 'desktop-usability', model, gracefulShutdown: true,
  async afterShutdown(ctx, observed) {
    const after = fingerprints(); ctx.proof.source_verification = { before, after, changed: Object.keys(before).filter(name => before[name] !== after[name]) };
    assert.deepEqual(after, before); assert.equal(observed, true);
  },
  handle({ completed, call, send, proof }) {
    if (!completed.length) {
      assert.equal(releaseTool, undefined, 'This fixture admits only one Work request');
      releaseTool = () => call('create_artifact', { name: artifactName, media_type: 'text/markdown', content: artifactText }); return;
    }
    assert.equal(completed.length, 1); assert.equal(completed[0].name, 'create_artifact');
    assert.equal(completed[0].value.proposal.name, artifactName); assert.equal(completed[0].value.proposal.content, artifactText);
    proof.actual_tool_result = completed[0].value;
    releaseAnswer = () => send('USABILITY_WORK_DONE: your reading report is retained in the work record.');
  },
  async run(ctx) {
    const { evaluate, waitFor, envelope, click } = ctx;
    const conversations = async () => (await envelope('studio.conversations.list()')).conversations;
    const selectConversation = async title => {
      const entry = `[...document.querySelectorAll('#yc-history .yc-history-item')].find(button=>button.title===${JSON.stringify(title)})`;
      await waitFor(`Boolean(${entry})`); await evaluate(`${entry}.click()`);
      await waitFor(`document.getElementById('yc-thread-title').textContent===${JSON.stringify(title)}`);
    };
    const now = new Date().toISOString(), id = randomUUID(), otherId = randomUUID();
    const messages = Array.from({ length: 28 }, (_, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' : 'user', createdAt: now,
      content: `## Reading section ${index + 1}\n\n` + (`SOURCE_NOTE_${index + 1}: Earlier context remains readable while a task runs. `).repeat(14),
      ...(index % 2 ? { provider: 'Seeded fixture history', model } : {}) }));
    const metadata = { mode: 'chat', project_id: null, pinned: false, archived: false, parent_id: null };
    const seeded = (await envelope(`studio.conversations.save(${JSON.stringify({ id, title: longTitle, model: unavailable, createdAt: now, updatedAt: now, messages, draft: retainedDraft, metadata })},0)`)).conversation;
    const other = (await envelope(`studio.conversations.save(${JSON.stringify({ id: otherId, title: otherTitle, model: 'ollama:' + model, createdAt: now, updatedAt: now, messages: [{ id: randomUUID(), role: 'user', content: 'Independent retained history.', createdAt: now }], draft: 'An unrelated unsent draft.', metadata })},0)`)).conversation;
    await ctx.reload(); await selectConversation(longTitle);
    await waitFor('document.querySelector("#yc-model-setup-host .yc-model-setup")?.dataset.state==="selected-unavailable" && !document.getElementById("yc-model-setup-host").classList.contains("yc-hidden")');
    assert.equal(await evaluate('document.getElementById("yc-input").value'), retainedDraft);
    await evaluate('document.getElementById("yc-form").requestSubmit()');
    await waitFor('Boolean(document.getElementById("yc-notice").textContent)');
    assert.equal(ctx.requests.length, 0); assert.equal(await evaluate('document.getElementById("yc-input").value'), retainedDraft);
    assert.deepEqual((await conversations()).find(item => item.id === id), seeded);
    ctx.proof.unavailable_model = { selected: unavailable, available_fixture: model, provider_calls: 0, conversation_unchanged: true };
    await ctx.capture('unavailable-model-draft');
    ctx.checks.push('A valid but unavailable saved model shows explicit setup, retains the draft and journal unchanged, and makes zero provider calls on Send');

    await evaluate(`const host=document.getElementById('yc-model-setup-host'); host.querySelector('.yc-model-setup-select').value=${JSON.stringify('ollama:' + model)}; host.querySelector('.yc-model-setup-select').dispatchEvent(new Event('change')); host.querySelector('.yc-model-setup-default').checked=true; host.querySelector('.yc-model-setup-use').click();`);
    await waitFor(`studio.workspace.list('settings').then(r=>r.ok && r.result.documents.some(s=>s.default_model===${JSON.stringify('ollama:' + model)}))`);
    await waitFor(`document.getElementById('yc-model').value===${JSON.stringify('ollama:' + model)} && document.getElementById('yc-model-setup-host').classList.contains('yc-hidden')`);
    const configured = (await conversations()).find(item => item.id === id);
    assert.equal(configured.model, 'ollama:' + model); assert.equal(configured.draft, retainedDraft); assert.deepEqual(configured.messages, seeded.messages);
    assert.equal(ctx.requests.length, 0); ctx.proof.default_settings = (await envelope("studio.workspace.list('settings')")).documents.find(item => item.id === 'desktop');
    await evaluate('document.getElementById("yc-settings-open").click()');
    await waitFor('Boolean(document.getElementById("yc-settings-form") && document.querySelector("#yc-preferences-panel .yc-model-setup"))');
    const appearanceBeforeSave = (await envelope("studio.workspace.list('settings')")).documents.find(item => item.id === 'desktop');
    assert.equal(await evaluate('document.getElementById("yc-settings-scheme").textContent'), 'Blue slate and silver');
    await evaluate('document.getElementById("yc-settings-form").requestSubmit()');
    await waitFor('document.querySelector("#yc-settings-form .yc-form-error")?.textContent === "Settings saved."');
    const appearanceAfterSave = (await envelope("studio.workspace.list('settings')")).documents.find(item => item.id === 'desktop');
    assert.equal(appearanceAfterSave.theme, appearanceBeforeSave.theme);
    assert.equal(appearanceAfterSave.preferences?.accent, appearanceBeforeSave.preferences?.accent);
    const owner = BrowserWindow.getAllWindows().find(window => !window.isDestroyed()); owner.setContentSize(820, 920);
    await waitFor('window.innerWidth>=780 && window.innerWidth<=850 && Boolean(getComputedStyle(document.body).getPropertyValue("--dt-panel"))');
    await evaluate('document.querySelector("#yc-preferences-panel .yc-model-setup").scrollIntoView({block:"center"})');
    const layout = await evaluate('(()=>{const r=document.querySelector("#yc-preferences-panel .yc-model-setup").getBoundingClientRect();return {left:r.left,right:r.right,width:window.innerWidth,height:window.innerHeight}})()');
    assert.ok(layout.left >= 0 && layout.right <= layout.width + 1); ctx.proof.narrow_dark_viewport = layout;
    await ctx.capture('model-settings-dark-narrow'); owner.setSize(1440, 960);
    await click('#yc-preferences-panel button', '← Back to conversation');
    await waitFor('!document.getElementById("yc-main").classList.contains("section-open")');
    ctx.checks.push('Explicit model/default selection commits only after acknowledgment; the same accessible settings card remains usable in dark theme at a narrow viewport');

    await evaluate(`document.querySelector('#yc-mode-switch [data-mode="work"]').click(); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-input').dispatchEvent(new Event('input')); document.getElementById('yc-form').requestSubmit()`);
    await waitUntil(() => typeof releaseTool === 'function');
    await waitFor('Boolean(document.querySelector("#yc-messages .yc-live-response"))');
    const probeId = messages[13].id;
    const reading = await evaluate(`(()=>{
      const article=document.querySelector('[data-message-id="${probeId}"]'), body=article.querySelector('.yc-message-body'), scroll=document.getElementById('yc-scroll');
      const details=document.createElement('details'); details.dataset.fixtureReadingProbe='true'; const summary=document.createElement('summary'); summary.textContent='Native reading-state probe'; const paragraph=document.createElement('p'); paragraph.textContent='Test-only DOM state; this is not a mission receipt.'; details.append(summary,paragraph); details.open=true; body.appendChild(details);
      scroll.scrollTop+=article.getBoundingClientRect().top-scroll.getBoundingClientRect().top-70; scroll.dispatchEvent(new Event('scroll'));
      const text=document.createTreeWalker(body,NodeFilter.SHOW_TEXT).nextNode(), range=document.createRange(); range.setStart(text,0); range.setEnd(text,Math.min(text.textContent.length,30)); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.__usabilityReading={article,details,text:selection.toString(),top:scroll.scrollTop};
      return {message_id:article.dataset.messageId,selected_text:selection.toString(),scroll_top:scroll.scrollTop,scroll_height:scroll.scrollHeight,client_height:scroll.clientHeight};
    })()`);
    assert.ok(reading.selected_text.length > 0); assert.ok(reading.scroll_top > 500 && reading.scroll_top < reading.scroll_height - reading.client_height - 500);
    await waitFor('!document.getElementById("yc-jump-latest").hidden');
    releaseTool(); await waitUntil(() => typeof releaseAnswer === 'function');
    await waitFor('document.querySelector(".yc-work-progress")?.textContent.includes("create_artifact") && document.querySelector(".yc-work-progress")?.textContent.includes("completed")');
    const retained = await evaluate(`(()=>{const p=window.__usabilityReading,s=document.getElementById('yc-scroll');return {same_node:p.article===document.querySelector('[data-message-id="${probeId}"]'),same_details:p.details===document.querySelector('[data-fixture-reading-probe]'),details_open:p.details.open,selected_text:getSelection().toString(),scroll_top:s.scrollTop}})()`);
    assert.equal(retained.same_node, true); assert.equal(retained.same_details, true); assert.equal(retained.details_open, true); assert.equal(retained.selected_text, reading.selected_text); assert.ok(Math.abs(retained.scroll_top - reading.scroll_top) < 3);
    ctx.proof.reading_during_progress = { before: reading, after: retained, details_probe: 'Explicit test-only nested DOM sentinel, not a fabricated mission receipt' };
    await ctx.capture('reading-during-tool-progress');
    await selectConversation(otherTitle); assert.equal(await evaluate('document.getElementById("yc-input").value'), other.draft);
    await selectConversation(longTitle);
    const returned = await evaluate(`(()=>{const a=document.querySelector('[data-message-id="${probeId}"]'),s=document.getElementById('yc-scroll'); return {scroll_top:s.scrollTop,offset:a.getBoundingClientRect().top-s.getBoundingClientRect().top}})()`);
    assert.ok(Math.abs(returned.offset - 70) < 4, JSON.stringify(returned));
    await evaluate('document.getElementById("yc-jump-latest").click()');
    await waitFor('(()=>{const s=document.getElementById("yc-scroll");return s.scrollHeight-s.clientHeight-s.scrollTop<3 && document.getElementById("yc-jump-latest").hidden})()');
    releaseAnswer();
    await waitFor('document.getElementById("yc-messages").textContent.includes("USABILITY_WORK_DONE") && !document.getElementById("yc-stop").offsetParent');
    const workList = (await envelope(`studio.work.list(${JSON.stringify(id)})`)).missions; assert.equal(workList.length, 1);
    const missionId = workList[0].id, record = await envelope(`studio.work.inspect(${JSON.stringify(missionId)})`);
    assert.equal(record.mission.status, 'completed'); assert.deepEqual(record.mission.steps.map(step => step.tool), ['create_artifact']); assert.equal(record.mission.artifacts.length, 1);
    const artifact = record.mission.artifacts[0]; assert.equal(artifact.status, 'committed'); assert.equal(artifact.proposal.content, artifactText); assert.equal(artifact.proposal.sha256, sha(Buffer.from(artifactText))); assert.equal(artifact.delivery, undefined);
    ctx.proof.mission_id = missionId; ctx.proof.artifact_id = artifact.id; ctx.proof.conversation_id = id;
    assert.equal(ctx.requests.length, 2); ctx.checks.push('Real Work tool progress preserves a historical DOM node, text selection and open test details; conversation switching restores the reading anchor and Jump to latest explicitly follows the final response');

    const openRecent = async () => { await evaluate('document.getElementById("yc-recent-work-open").click()'); await waitFor('Boolean(document.querySelector(".yc-recent-search")) && !document.querySelector(".yc-recent-work")?.getAttribute("aria-busy")?.includes("true")'); };
    const findArtifact = async () => { await openRecent(); await evaluate(`document.querySelector('.yc-recent-search').value=${JSON.stringify(artifactName)}; document.querySelector('.yc-recent-search').dispatchEvent(new Event('input')); document.querySelector('.yc-recent-status').value='completed'; document.querySelector('.yc-recent-status').dispatchEvent(new Event('change'))`); await waitFor(`document.querySelectorAll('.yc-recent-card').length===1 && document.querySelector('.yc-recent-card').dataset.missionId===${JSON.stringify(missionId)}`); };
    await selectConversation(otherTitle); await findArtifact(); await ctx.capture('recent-artifact-discovery');
    await evaluate('document.querySelector(".yc-recent-open-work").click()');
    await waitFor(`document.querySelector('.yc-work-record')?.dataset.missionId===${JSON.stringify(missionId)} && document.querySelector('.yc-work-artifact')?.dataset.artifactId===${JSON.stringify(artifact.id)}`);
    await findArtifact(); await evaluate(`document.querySelector('.yc-recent-open-artifact[data-artifact-id="${artifact.id}"]').click()`);
    await waitFor(`(()=>{const a=document.querySelector('.yc-work-artifact[data-artifact-id="${artifact.id}"]');return a && [...a.querySelectorAll('details')].some(d=>d.open && d.querySelector('summary')?.textContent==='Preview content')})()`);
    assert.ok((await evaluate('document.querySelector(".yc-work-artifact").textContent')).includes('USABILITY_ARTIFACT_73bc'));
    await findArtifact(); await evaluate('document.querySelector(".yc-recent-open-conversation").click()');
    await waitFor(`document.getElementById('yc-thread-title').textContent===${JSON.stringify(longTitle)} && document.getElementById('yc-messages').textContent.includes('USABILITY_WORK_DONE')`);
    assert.equal(ctx.requests.length, 2); assert.deepEqual(await envelope(`studio.work.inspect(${JSON.stringify(missionId)})`), record);
    ctx.checks.push('Recent work finds an actual committed artifact by filename across conversations and opens its exact work record, expanded artifact and owning conversation without inference or delivery');

    const saved = (await conversations()).find(item => item.id === id); await ctx.reload();
    await waitFor('document.getElementById("yur-conversation").dataset.theme==="dark"'); await findArtifact();
    await evaluate(`document.querySelector('.yc-recent-open-artifact[data-artifact-id="${artifact.id}"]').click()`);
    await waitFor(`document.querySelector('.yc-work-artifact')?.dataset.artifactId===${JSON.stringify(artifact.id)}`);
    assert.deepEqual(await envelope(`studio.work.inspect(${JSON.stringify(missionId)})`), record); assert.deepEqual((await conversations()).find(item => item.id === id), saved);
    assert.equal((await envelope("studio.workspace.list('settings')")).documents.find(item => item.id === 'desktop').default_model, 'ollama:' + model);
    assert.equal(ctx.requests.length, 2); assert.equal(ctx.reveals.length, 0); ctx.proof.readonly_reopen = { model_requests: ctx.requests.length, work_revision: record.mission.revision, no_export_or_apply: true };
    await ctx.capture('restored-artifact'); ctx.checks.push('Reload retains the selected default and the same work/artifact receipts; browsing does not replay tools, call the provider, export files or reveal external windows');
  },
});
