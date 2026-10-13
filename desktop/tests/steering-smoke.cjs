'use strict';
// Real main/preload/Work/CommitService. Only provider replies and one lost IPC
// acknowledgment are fixtures; no correction or mission state is manufactured.
const assert = require('node:assert/strict');
const { ipcMain } = require('electron');
const { nativeFixture } = require('./specialists-smoke.cjs');
let droppedAcknowledgment = false;
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, channel !== 'work:steer' ? handler : async (...args) => {
  const actual = await handler(...args);
  if (!droppedAcknowledgment && actual?.ok) { droppedAcknowledgment = true; return { ok: false, error: { code: 'FIXTURE_LOST_ACK', message: 'The native fixture dropped a committed correction acknowledgment.' } }; }
  return actual;
});

const corrections = { first: 'CORRECTION_A: use revised scope 317 square feet; discard the earlier report.', cancelled: 'CORRECTION_CANCEL: retain this correction as unconsumed if the mission is stopped.', reload: 'CORRECTION_RELOAD: retain this correction without restarting work after reload.' };
const held = new Map(); const closed = new Set();
nativeFixture({ prefix: 'steering', model: 'steering-tool-fixture',
  handle({ completed, goal, body, call, send, response, proof }) {
    const phase = goal.includes('STEERING_CANCEL') ? 'cancelled' : goal.includes('STEERING_RELOAD') ? 'reload' : 'first';
    if (phase !== 'first') { held.set(phase, true); response.on('close', () => { if (!response.writableEnded) closed.add(phase); }); return; }
    const text = body.messages.map(message => message.content || '').join('\n');
    if (!text.includes(corrections.first)) { held.set('first', () => call('create_artifact', { name: 'stale-report.md', media_type: 'text/markdown', content: 'This stale tool call must never execute.' })); return; }
    proof.provider_received_correction = true;
    if (!completed.length) return call('create_artifact', { name: 'revised-report.md', media_type: 'text/markdown', content: 'Revised scope: 317 square feet.\n' });
    assert.equal(completed.length, 1); assert.equal(completed[0].value.proposal.name, 'revised-report.md'); send('STEERING_NATIVE_DONE: the same mission used the queued scope correction.');
  },
  async run(ctx) {
    const { evaluate, waitFor, envelope, click } = ctx;
    const waitHost = async check => { const deadline = Date.now() + 15000; while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(check()); };
    async function start(goal) {
      await evaluate(`document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change')); document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit()`);
      await waitFor('document.getElementById("yc-send").getAttribute("aria-label")==="Send correction" && !document.getElementById("yc-send").disabled');
      const missions = (await envelope('window.studio.work.list(null)')).missions; const mission = missions.find(item => item.goal === goal); assert.ok(mission); return mission;
    }
    async function correct(value, newDraft = '') {
      await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(value)}; document.getElementById('yc-input').dispatchEvent(new Event('input')); document.getElementById('yc-form').requestSubmit(); document.getElementById('yc-form').requestSubmit(); ${newDraft ? `document.getElementById('yc-input').value=${JSON.stringify(newDraft)}; document.getElementById('yc-input').dispatchEvent(new Event('input'));` : ''}`);
      await waitFor('[...document.querySelectorAll(".yc-correction-status")].some(node=>node.textContent.includes("Queued for the next checkpoint"))');
    }
    const firstGoal = 'STEERING_FIRST: prepare the initial report and wait for my correction.';
    const first = await start(firstGoal); await waitHost(() => held.has('first'));
    await correct(corrections.first, 'NEXT_DRAFT_MUST_SURVIVE');
    await waitFor('!document.getElementById("yc-send").disabled');
    assert.equal(droppedAcknowledgment, true); assert.equal(await evaluate('document.querySelectorAll(".yc-correction-message").length'), 1); assert.equal(await evaluate('document.getElementById("yc-input").value'), 'NEXT_DRAFT_MUST_SURVIVE');
    const queued = await envelope(`window.studio.work.inspect(${JSON.stringify(first.id)})`); assert.equal(queued.steering.length, 1); assert.equal(queued.steering[0].status, 'queued'); assert.equal(queued.steering[0].text, corrections.first); ctx.proof.first_mission = first.id; ctx.proof.correction_id = queued.steering[0].correction_id;
    const replay = await envelope(`window.studio.work.steer(${JSON.stringify({ mission_id: first.id, conversation_id: first.conversation_id, correction_id: queued.steering[0].correction_id, text: corrections.first })})`); assert.equal(replay.correction.queued_receipt.hash, queued.steering[0].queued_receipt.hash);
    await ctx.capture('queued-correction');
    await evaluate('document.getElementById("yc-new-chat").click()');
    await waitFor('document.querySelectorAll(".yc-correction-message").length===0');
    await waitFor('Boolean([...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("STEERING_FIRST")))');
    await evaluate('[...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("STEERING_FIRST")).click()');
    assert.equal(await evaluate('document.getElementById("yc-input").value'), 'NEXT_DRAFT_MUST_SURVIVE');
    held.get('first')();
    await waitFor('document.getElementById("yc-messages").textContent.includes("STEERING_NATIVE_DONE") && !document.getElementById("yc-send").disabled');
    await waitFor('document.querySelector(".yc-correction-status")?.textContent==="Applied to the mission"');
    const finished = await envelope(`window.studio.work.inspect(${JSON.stringify(first.id)})`); assert.equal(finished.mission.status, 'completed'); assert.equal(finished.steering.length, 1); assert.equal(finished.steering[0].status, 'consumed');
    assert.deepEqual(finished.mission.artifacts.map(item => item.proposal.name), ['revised-report.md']); assert.equal((await envelope('window.studio.work.list(null)')).missions.length, 1);
    ctx.proof.first_correction = finished.steering[0]; ctx.proof.first_steps = finished.mission.steps.map(step => step.tool);
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelector(".yc-work-corrections")?.textContent.includes("Applied to the mission")'); await ctx.capture('consumed-correction');
    ctx.checks.push('One active mission accepts a durable correction without Stop/start; double-submit and exact-ID replay create one queue entry; lost acknowledgment resolves by inspect and preserves concurrently typed draft across conversation switching');
    ctx.checks.push('Queued correction is consumed before continuation and the old provider tool call is discarded: only the revised artifact commits, with consumed receipts visible in chat and Work record');
    await evaluate('document.getElementById("yc-new-chat").click()'); const cancelledGoal = 'STEERING_CANCEL: wait for correction then stop.'; const cancelled = await start(cancelledGoal); await waitHost(() => held.has('cancelled')); await correct(corrections.cancelled);
    await evaluate('document.getElementById("yc-stop").click()'); await waitFor('document.getElementById("yc-stop").classList.contains("yc-hidden")'); await waitHost(() => closed.has('cancelled'));
    await waitFor('[...document.querySelectorAll(".yc-correction-status")].some(node=>node.textContent==="Not consumed by the mission")');
    const stopped = await envelope(`window.studio.work.inspect(${JSON.stringify(cancelled.id)})`); assert.equal(stopped.mission.status, 'cancelled'); assert.equal(stopped.steering[0].status, 'not_consumed'); ctx.proof.stopped = { id: cancelled.id, correction: stopped.steering[0] };
    await ctx.capture('stopped-correction'); ctx.checks.push('Existing Stop cancels the exact provider operation and retains its queued correction as not consumed');
    await evaluate('document.getElementById("yc-new-chat").click()'); const reloadGoal = 'STEERING_RELOAD: wait for correction then reload.'; const reloaded = await start(reloadGoal); await waitHost(() => held.has('reload')); await correct(corrections.reload); await waitFor('!document.getElementById("yc-send").disabled');
    const beforeReload = ctx.requests.length; await ctx.reload(); await waitHost(() => closed.has('reload'));
    await waitFor('Boolean([...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("STEERING_RELOAD")))'); await evaluate('[...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("STEERING_RELOAD")).click()');
    await waitFor('[...document.querySelectorAll(".yc-correction-status")].some(node=>node.textContent==="Not consumed by the mission")');
    assert.equal(ctx.requests.length, beforeReload); const afterReload = await envelope(`window.studio.work.inspect(${JSON.stringify(reloaded.id)})`); assert.equal(afterReload.mission.status, 'cancelled'); assert.equal(afterReload.steering.length, 1); assert.equal(afterReload.steering[0].status, 'not_consumed'); ctx.proof.reloaded = { id: reloaded.id, correction: afterReload.steering[0] };
    await ctx.capture('reloaded-correction'); ctx.checks.push('Renderer reload preserves the existing cancellation policy, restores correction receipts from the same mission, and does not restart or resend work');
  },
});
