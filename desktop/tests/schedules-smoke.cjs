'use strict';
// Actual scheduled manager runs; only the model and source files are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');

let holdSeen = false, upstreamClosed = false;
nativeFixture({ prefix: 'schedules', model: 'schedule-tool-fixture',
  handle({ completed, goal, call, send, response, sourceRoot, proof }) {
    if (goal.includes('SCHEDULE_HOLD')) { holdSeen = true; response.on('close', () => { if (!response.writableEnded) upstreamClosed = true; }); return; }
    if (!completed.length) return call('read_file', { path: 'story.md' });
    const read = completed[0].value; const expected = fs.readFileSync(path.join(sourceRoot, 'story.md'), 'utf8');
    assert.equal(read.content, expected); assert.equal(read.sha256, sha(expected)); proof.read_sha256 = read.sha256;
    if (completed.length === 1) return call('create_artifact', { name: 'scheduled-result.md', media_type: 'text/markdown', content: '# Scheduled fixture\n\n' + read.content });
    assert.equal(completed.length, 2); assert.equal(completed[1].value.artifact_status, 'committed');
    proof.artifact_sha256 = completed[1].value.proposal.sha256; send('SCHEDULE_NATIVE_DONE: read the exact fixture source and committed its report.');
  },
  async run(ctx) {
    const { evaluate, waitFor, click, envelope } = ctx;
    const list = async () => (await envelope('window.studio.schedules.list()')).schedules;
    const card = name => `[...document.querySelectorAll('.yc-schedule-card')].find(node=>node.querySelector('h2')?.textContent===${JSON.stringify(name)})`;
    async function create(name, goal, root) {
      await click('#yc-new-schedule', 'New scheduled task');
      await waitFor('Boolean(document.querySelector("dialog[open] #yc-field-schedule-name"))');
      const values = { 'schedule-name': name, 'schedule-goal': goal, 'schedule-root': root, 'schedule-model': ctx.model, 'schedule-interval': '1', 'schedule-max-runs': '1' };
      await evaluate(`for(const [key,value] of Object.entries(${JSON.stringify(values)})) document.getElementById('yc-field-'+key).value=value; document.getElementById('yc-field-schedule-enabled').checked=true; document.getElementById('yc-field-schedule-run-now').checked=true; document.querySelector('dialog[open] form').requestSubmit();`);
      await waitFor('!document.querySelector("dialog[open]")');
      await waitFor(`Boolean(${card(name)})`);
    }
    await waitFor('Boolean(window.studio.schedules)');
    await evaluate('document.getElementById("yc-schedules-open").click()');
    await waitFor('Boolean(document.getElementById("yc-new-schedule"))');
    assert.deepEqual(await list(), []);
    assert.ok(await evaluate('document.querySelector(".yc-schedules-note").textContent.includes("Closing Desktop cancels an active run")'));
    await create('Native scheduled report', 'SCHEDULE_REPORT: read story.md and produce a report.', ctx.sourceRoot);
    await waitFor(`${card('Native scheduled report')}?.querySelector('.yc-schedule-budget')?.textContent==='1 of 1 runs used'`);
    let schedules = await list(); assert.equal(schedules.length, 1); const completed = schedules[0];
    assert.equal(completed.enabled, false); assert.equal(completed.runs_completed, 1); assert.equal(completed.active_request_id, null); assert.ok(completed.last_mission_id);
    const record = await envelope(`window.studio.work.inspect(${JSON.stringify(completed.last_mission_id)})`);
    assert.equal(record.mission.status, 'completed'); assert.deepEqual(record.mission.steps.map(step => step.tool), ['read_file', 'create_artifact']); assert.equal(record.mission.artifacts.length, 1);
    const conversations = (await envelope('window.studio.conversations.list()')).conversations;
    assert.ok(conversations.some(item => item.id === completed.conversation_id)); assert.equal(conversations.flatMap(item => item.messages).length, 0, 'Scheduled work must not manufacture chat messages.');
    ctx.proof.schedule_id = completed.id; ctx.proof.mission_id = completed.last_mission_id; ctx.proof.active_request_id = record.mission.request_id;
    const events = await envelope(`window.studio.schedules.events(${JSON.stringify(completed.id)},null)`); assert.ok(events.events.length >= 3); assert.ok(events.events.every(event => !Object.hasOwn(event, 'data') && Object.hasOwn(event, 'change') && !Object.hasOwn(event, 'document')));
    await evaluate(`${card('Native scheduled report')}.querySelector('details').open=true; true;`);
    await waitFor(`${card('Native scheduled report')}.querySelector('.yc-schedule-events').children.length>0`);
    await ctx.capture('completed-history');
    await click('.yc-schedule-card button', 'Open last run'); await waitFor('document.querySelector(".yc-work-record").textContent.includes("SCHEDULE_NATIVE_DONE")');
    assert.equal(await evaluate('document.querySelector(".yc-work-record .yc-work-artifact h4").textContent'), 'scheduled-result.md');
    await ctx.capture('actual-run');
    ctx.checks.push('Explicit Run now creates a bounded schedule and actual OM read/artifact result; completed budget disables recurrence, history is provenance-bearing, no chat messages are invented');

    const requestCount = ctx.requests.length; await ctx.reload(); await evaluate('document.getElementById("yc-schedules-open").click()');
    await waitFor(`${card('Native scheduled report')}?.querySelector('.yc-schedule-budget')?.textContent==='1 of 1 runs used'`);
    schedules = await list(); assert.equal(schedules[0].id, completed.id); assert.equal(schedules[0].last_mission_id, completed.last_mission_id); assert.equal(ctx.requests.length, requestCount);
    ctx.checks.push('Reload restores the exact schedule and last mission with no duplicate provider execution');

    await create('Native paused run', 'SCHEDULE_HOLD: wait while cancellation is tested.', ctx.sourceRoot);
    const holdDeadline = Date.now() + 25000; while (!holdSeen && Date.now() < holdDeadline) await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(holdSeen, true);
    await waitFor(`${card('Native paused run')}?.querySelector('.yc-schedule-state')?.textContent==='Running'`);
    assert.equal(await evaluate(`${card('Native paused run')}.querySelector('button').disabled`), true, 'Active schedule configuration must be disabled.');
    await evaluate(`[...${card('Native paused run')}.querySelectorAll('button')].find(node=>node.textContent==='Pause task').click()`);
    await waitFor(`${card('Native paused run')}?.querySelector('.yc-schedule-budget')?.textContent==='1 of 1 runs used'`);
    const closeDeadline = Date.now() + 5000; while (!upstreamClosed && Date.now() < closeDeadline) await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(upstreamClosed, true);
    const paused = (await list()).find(item => item.name === 'Native paused run'); assert.equal(paused.enabled, false); assert.equal(paused.active_request_id, null);
    const cancelled = await envelope(`window.studio.work.inspect(${JSON.stringify(paused.last_mission_id)})`); assert.equal(cancelled.mission.status, 'cancelled'); ctx.proof.cancelled_mission_id = paused.last_mission_id; ctx.proof.upstream_closed = true;
    ctx.checks.push('Pause on an active schedule commits cancellation, aborts its exact provider socket and preserves the cancelled Work receipt');

    const beforeMissing = ctx.requests.length;
    await create('Native missing source', 'SCHEDULE_MISSING: inspect the selected source folder.', path.join(ctx.tempRoot, 'missing-source'));
    await waitFor(`${card('Native missing source')}?.querySelector('.yc-form-error')?.textContent.length>0`);
    const missing = (await list()).find(item => item.name === 'Native missing source'); assert.equal(missing.enabled, false); assert.equal(missing.runs_completed, 0); assert.equal(missing.active_request_id, null); assert.equal(missing.last_mission_id, null); assert.ok(missing.last_error); assert.equal(ctx.requests.length, beforeMissing);
    ctx.proof.missing_source_error = missing.last_error;
    await ctx.capture('paused-and-source-failure');
    ctx.checks.push('A missing source folder disables dispatch before any model request, records the failure, and does not invent a completed run');
  },
});
