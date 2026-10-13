'use strict';
// Native page/selection/extractor/Work/CommitService are real. Model decisions
// and public page content use loopback fixtures. No external page is requested.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { webContents } = require('electron');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const monitored = ['tests/browser-work-smoke.cjs', 'tests/specialists-smoke.cjs', 'src/main.js', 'src/preload.js',
  'src/work-browser-broker.js', 'src/browser-host.js', 'src/browser-view.js', 'src/work-transport.js',
  'src/work-view.js', 'src/conversation-view.js', 'src/conversation.css', 'foundry/work_browser.py',
  'foundry/work_browser_protocol.py', 'foundry/work_engine.py', 'foundry/work_store.py', 'foundry/work_cli.py',
  'foundry/orchestration.py', 'foundry/commit_service.py'];
const fingerprints = () => Object.fromEntries(monitored.map(name => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))]));
const before = fingerprints();
const initial = 'SELECTED_PAGE_OLD_QUANTITY_17', fresh = 'SELECTED_PAGE_CURRENT_QUANTITY_47';
const excluded = 'PRIVATE_FORM_VALUE_MUST_STAY_LOCAL';
const pageRequests = [];
const site = http.createServer((request, response) => {
  pageRequests.push(request.url);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Selected quantity report</title>
  <style>body{padding:24px;font:16px/1.6 system-ui;color:#302a26;background:#f7f5f1}h1{font-size:26px}strong{display:block;font-size:38px;color:#764755}label{display:block;margin-top:24px}input{display:block;width:100%}</style>
  <h1>Selected quantity report</h1><p>Measured quantity <strong id="quantity">17 units</strong></p>
  <p id="marker">${initial}</p><p>Read this report when Work requests it.</p>
  <label>Form value excluded from source<input value="${excluded}"></label><textarea>${excluded}</textarea>
  <p hidden>HIDDEN_PAGE_TEXT_MUST_STAY_LOCAL</p></html>`);
});
let pageOrigin;
const pageReady = new Promise((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', () => { pageOrigin = `http://127.0.0.1:${site.address().port}`; resolve(); }); });

nativeFixture({ prefix: 'browser-work', model: 'selected-page-work-fixture', gracefulShutdown: true,
  async afterShutdown(ctx, observed) {
    site.closeAllConnections?.(); site.close();
    const after = fingerprints();
    ctx.proof.source_verification = { before, after, changed: Object.keys(before).filter(name => before[name] !== after[name]) };
    ctx.proof.page_requests = pageRequests;
    assert.deepEqual(after, before); assert.equal(observed, true);
  },
  handle({ body, completed, goal, call, send, proof }) {
    const denied = goal.includes('NAVIGATION_DENIAL');
    assert.ok(body.tools.some(tool => tool.function.name === 'acquire_selected_page'));
    if (!completed.length) {
      assert.equal(JSON.stringify(body).includes(initial), false, 'Selection must not eagerly copy old page text');
      assert.equal(JSON.stringify(body).includes(fresh), false, 'No fresh page text before model acquisition');
      const source = /Selected page source_id: ([a-f0-9-]{36})/.exec(body.messages[0].content)?.[1];
      assert.ok(source, 'The tool gets only the selected source identity');
      proof.first_model_had_no_page_text = true;
      return call('acquire_selected_page', { source_id: source });
    }
    assert.equal(completed.length, 1);
    const result = completed[0].value;
    assert.equal(result.schema, 'yur.work-browser-result.v1'); assert.equal(result.committed, true);
    assert.match(result.provenance.result_receipt, /^[a-f0-9]{64}$/);
    if (denied) {
      assert.equal(result.status, 'denied'); assert.equal(result.context, null); assert.ok(result.error.code);
      proof.denial_result = result;
      return send('NAVIGATION_DENIAL_RETAINED: the changed document was not read.');
    }
    assert.equal(result.status, 'recorded'); assert.equal(result.error, null);
    assert.ok(result.context.text.includes(fresh)); assert.equal(result.context.text.includes(initial), false);
    assert.equal(result.context.text.includes(excluded), false); assert.equal(result.context.text.includes('HIDDEN_PAGE_TEXT_MUST_STAY_LOCAL'), false);
    assert.equal(sha(result.context.text), result.context.sha256);
    proof.page_result = result;
    return send('SELECTED_PAGE_DONE: the current report measured 47 units.');
  },
  async run(ctx) {
    await pageReady;
    const { evaluate, waitFor, envelope } = ctx;
    const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const waitPage = async () => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const state = await envelope('studio.browser.state()');
        if (state.url === pageOrigin + '/report' && !state.loading && state.visible) return state;
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      throw new Error('Native fixture page did not become ready');
    };
    await click('yc-browser-toggle');
    await evaluate(`document.getElementById('yc-browser-address').value=${JSON.stringify(pageOrigin + '/report')}; document.getElementById('yc-browser-go').click()`);
    const state = await waitPage();
    const page = webContents.getAllWebContents().find(item => item.getURL() === pageOrigin + '/report');
    assert.ok(page); assert.equal(page.getLastWebPreferences().preload, undefined); assert.equal(page.getLastWebPreferences().sandbox, true);
    page.setBackgroundThrottling(false);
    const extract = page.executeJavaScriptInIsolatedWorld.bind(page);
    ctx.proof.actual_extractions = 0;
    page.executeJavaScriptInIsolatedWorld = (...args) => { ctx.proof.actual_extractions++; return extract(...args); };
    await evaluate("document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change'))");
    await click('yc-browser-allow-work');
    await waitFor('Boolean(document.querySelector(".yc-work-page-chip"))');
    assert.equal(ctx.requests.length, 0);
    assert.equal(ctx.proof.actual_extractions, 0);
    assert.equal(await evaluate('Boolean(document.querySelector("#yc-attachments .yc-attachment"))'), false);
    assert.ok((await evaluate('document.getElementById("yc-work-page").textContent')).includes('Selected quantity report'));
    const nativeImage = await page.capturePage(undefined, { stayHidden: true }); assert.equal(nativeImage.isEmpty(), false);
    const imageFile = path.join(ctx.tempRoot, 'browser-work-selected-native-page.png'); fs.writeFileSync(imageFile, nativeImage.toPNG()); ctx.screenshots.native_page = imageFile;
    ctx.proof.native_page = { url: page.getURL(), web_contents_id: page.id, bounds: state.bounds, image_sha256: sha(nativeImage.toPNG()) };
    await ctx.capture('selection');
    await page.executeJavaScript(`document.getElementById('quantity').textContent='47 units'; document.getElementById('marker').textContent=${JSON.stringify(fresh)}`);
    await click('yc-details-tab');
    for (let attempt = 0; attempt < 50 && (await envelope('studio.browser.state()')).visible; attempt++) await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((await envelope('studio.browser.state()')).visible, false, 'The selected document must be hidden before the model requests its text');
    ctx.checks.push('Operator UI selects one real native document with zero model calls or eager page body; source changes afterward in the same document');

    const goal = 'Read the selected report when needed and state its measured quantity.';
    await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("SELECTED_PAGE_DONE") && !document.getElementById("yc-send").disabled');
    const missions = (await envelope('studio.work.list(null)')).missions; assert.equal(missions.length, 1);
    const record = await envelope(`studio.work.inspect(${JSON.stringify(missions[0].id)})`);
    assert.equal(record.mission.status, 'completed'); assert.equal(record.mission.steps.length, 1);
    const types = record.events.map(item => item.event_type);
    assert.ok(['work.browser.acquisition.accepted', 'work.browser.result.committed', 'work.tool.completed'].every(type => types.includes(type)));
    assert.ok(types.indexOf('work.browser.acquisition.accepted') < types.indexOf('work.browser.result.committed'));
    assert.ok(types.indexOf('work.browser.result.committed') < types.indexOf('work.tool.completed'));
    assert.equal(JSON.stringify(record.events).includes(fresh), false);
    assert.equal(record.mission.steps[0].result.provenance.result_receipt, ctx.proof.page_result.provenance.result_receipt);
    ctx.proof.work_id = record.mission.id; ctx.proof.conversation_id = record.mission.conversation_id;
    assert.equal(ctx.proof.actual_extractions, 1);
    await evaluate('document.querySelector(".yc-open-work").click()');
    await waitFor('Boolean(document.querySelector(".yc-work-page-card"))');
    assert.ok((await evaluate('document.querySelector(".yc-work-page-text").textContent')).includes(fresh));
    assert.equal((await envelope('studio.browser.state()')).visible, false);
    await ctx.capture('committed-page-result');
    ctx.checks.push('Actual Work child requests the selected hidden document; only freshly extracted text reaches the fixture model after CommitService, with form exclusions and a dedicated result card');

    const calls = ctx.requests.length, loads = pageRequests.length;
    await ctx.reload();
    await ctx.click('#yc-history .yc-history-item', goal);
    await waitFor('Boolean(document.querySelector(".yc-open-work"))'); await evaluate('document.querySelector(".yc-open-work").click()');
    await waitFor('Boolean(document.querySelector(".yc-work-page-card"))');
    assert.equal(ctx.requests.length, calls); assert.equal(pageRequests.length, loads);
    assert.equal(ctx.proof.actual_extractions, 1, 'Reload must restore the receipt without another extractor invocation');
    assert.ok((await evaluate('document.querySelector(".yc-work-page-receipt").textContent')).includes(ctx.proof.page_result.provenance.result_receipt));
    await ctx.capture('restored-page-result');
    ctx.checks.push('Renderer reload restores the same source text and receipt without a browser read, page load or provider replay');

    await click('yc-new-chat'); await click('yc-browser-toggle'); await waitPage();
    await evaluate(`document.getElementById('yc-model').value=${JSON.stringify('ollama:' + ctx.model)}; document.getElementById('yc-model').dispatchEvent(new Event('change')); document.getElementById('yc-mode').value='work'; document.getElementById('yc-mode').dispatchEvent(new Event('change'))`);
    await click('yc-browser-allow-work'); await waitFor('Boolean(document.querySelector(".yc-work-page-chip"))');
    await click('yc-browser-reload'); await waitPage();
    await evaluate("document.getElementById('yc-input').value='NAVIGATION_DENIAL: read the previously selected report.'; document.getElementById('yc-form').requestSubmit()");
    await waitFor('document.getElementById("yc-messages").textContent.includes("NAVIGATION_DENIAL_RETAINED") && !document.getElementById("yc-send").disabled');
    await evaluate('[...document.querySelectorAll(".yc-open-work")].at(-1).click()'); await waitFor('Boolean(document.querySelector(".yc-work-page-card"))');
    assert.ok((await evaluate('document.querySelector(".yc-work-page-card").textContent')).includes('No page content was acquired'));
    assert.equal(await evaluate('Boolean(document.querySelector(".yc-work-page-text"))'), false);
    assert.equal(ctx.proof.actual_extractions, 1, 'Changed document must be denied before the extractor runs');
    await ctx.capture('changed-document-denied');
    ctx.checks.push('A same-URL page reload after selection yields a committed denial, no acquired text, and a truthful denial card');
  },
});
