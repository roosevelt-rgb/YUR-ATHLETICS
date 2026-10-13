'use strict';
// Actual cloud inference and native Desktop/browser acceptance, isolated profile.
// Run again with --restore <receipt.profile> to prove restart without generation.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const restoreIndex = process.argv.indexOf('--restore');
const restoring = restoreIndex >= 0;
const profile = restoring ? path.resolve(process.argv[restoreIndex + 1] || '') : fs.mkdtempSync(path.join(os.tmpdir(), 'yur-franklin-live-'));
assert.ok(profile.startsWith(path.join(os.tmpdir(), 'yur-franklin-live-')));
const evidenceLabel = process.env.YUR_FRANKLIN_EVIDENCE_LABEL || 'franklin-live';
if (!/^[a-z0-9-]+$/.test(evidenceLabel)) throw new Error('Invalid evidence label');
const evidence = path.resolve(__dirname, '../../../evidence/glider-rc6/comprehensive', evidenceLabel);
fs.mkdirSync(evidence, { recursive: true });
process.env.YUR_GLIDER_RC6 = '1'; process.env.YUR_HARNESS_AUTOSTART = '0';
process.env.YUR_DESKTOP_HOME = path.join(profile, 'conversations'); process.env.YUR_FACTORY_HOME = path.join(profile, 'factory');
process.env.YUR_FRANKLIN_OPENAI_URL = 'http://127.0.0.1:11434/v1';
process.env.YUR_FRANKLIN_MODEL = 'deepseek-v4-pro:cloud';
app.setPath('userData', path.join(profile, 'electron')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const requestHits = [];
const fixture = http.createServer((req, res) => {
  requestHits.push(req.url); res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><title>Franklin owned browser fixture</title><h1>Desktop browser acceptance</h1><p>The page evidence marker is FRANKLIN_BROWSER_SILVER_7391.</p>');
});
fixture.listen(0, '127.0.0.1');
const deadline = setTimeout(() => { console.error('Franklin acceptance deadline'); app.exit(1); }, 360000);
app.on('before-quit', () => { clearTimeout(deadline); fixture.close(); });
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false); win.setFocusable(false); win.setOpacity(0); win.setPosition(-16000, -16000); win.setSkipTaskbar(true);
  const errors = []; win.webContents.on('preload-error', (_e, _f, err) => errors.push(err.message));
  win.webContents.once('did-finish-load', async () => {
    const evaluate = code => win.webContents.executeJavaScript(code);
    const wait = async (code, ms = 160000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 150)); }
      throw new Error('Franklin acceptance timed out: ' + code);
    };
    const snapshot = () => evaluate('window.studio.franklin.snapshot().then(r=>{if(!r.ok)throw Error(r.error.message);return r.result})');
    try {
      const entered = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      await evaluate('setTimeout(()=>window.studio.launch.enter(),25);true'); await entered;
      await wait('!!document.getElementById("franklin-toggle")', 20000);
      await wait('!document.getElementById("franklin-input").disabled', 20000);
      const selected = 'openai:deepseek-v4-pro:cloud';
      if (restoring) {
        const state = await snapshot();
        assert.equal(state.preferences.model, selected); assert.equal(state.preferences.draft, 'A saved Franklin draft for tomorrow.');
        assert.equal(state.preferences.open, true);
        assert.equal(state.requests.filter(item => item.status === 'completed').length, 2);
        assert.ok(state.messages.some(item => item.role === 'assistant' && item.content.includes('FRANKLIN_BROWSER_SILVER_7391')));
        assert.equal(await evaluate('document.getElementById("franklin-panel").hidden'), false);
        assert.equal(await evaluate('document.getElementById("franklin-input").value'), state.preferences.draft);
        const receipt = { at: new Date().toISOString(), profile, checks: ['Saved model, open state and draft restored in a second process', 'Both completed conversations restored', 'No inference or browser fixture requests issued'], requests: state.requests, fixtureRequests: requestHits };
        assert.deepEqual(requestHits, []);
        fs.writeFileSync(path.join(evidence, 'restart-receipt.json'), JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify(receipt)); app.quit(); return;
      }
      await evaluate('document.getElementById("franklin-toggle").click()');
      await wait('!document.getElementById("franklin-model").disabled', 20000);
      await evaluate(`(()=>{const model=document.getElementById('franklin-model');model.value=${JSON.stringify(selected)};model.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      await wait('!document.getElementById("franklin-model").disabled', 20000);
      assert.equal((await snapshot()).preferences.model, selected);
      await evaluate('document.getElementById("yc-browser-toggle").click();true');
      await wait('window.studio.browser.state().then(r=>r.ok&&r.result.visible&&r.result.bounds.height>0)', 15000);
      await evaluate('document.getElementById("yc-close-details").click();true');
      await evaluate('window.__franklinEvents=[];window.studio.franklin.onEvent(e=>window.__franklinEvents.push(e));true');
      async function send(text, count) {
        await evaluate(`(()=>{const input=document.getElementById('franklin-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
        await wait('!document.getElementById("franklin-send").disabled', 20000);
        await evaluate('document.querySelector(".yur-franklin-form").requestSubmit();true');
        await wait(`window.studio.franklin.snapshot().then(r=>r.ok && r.result.requests.length>=${count} && r.result.requests.slice(-1)[0].status!=='running' && r.result.requests.slice(-1)[0].status!=='accepted')`);
        const state = await snapshot(), request = state.requests.at(-1);
        assert.equal(request.status, 'completed', JSON.stringify(state));
        return state;
      }
      const first = await send('Remember this user-provided project codename: SILVER_SLATE_ORCHARD. Use desktop_action to open the workforce view. Then respond briefly with the codename. Use no other tools.', 1);
      assert.ok(first.messages.some(item => item.role === 'assistant' && item.content.includes('SILVER_SLATE_ORCHARD')));
      assert.match(await evaluate('document.getElementById("yc-thread-title").textContent'), /agents|workforce/i);
      assert.equal(await evaluate('document.getElementById("franklin-panel").hidden'), false);
      console.log('Franklin native: first cloud turn navigated workforce and committed its response');
      const url = `http://127.0.0.1:${fixture.address().port}/franklin-proof`;
      const second = await send(`What project codename did I give you in the previous message? Use desktop_action browser_navigate to visit ${url}, then desktop_action browser_read to read that page. Reply with both the remembered codename and the exact page evidence marker. You must acquire the page before answering. Use no other tools.`, 2);
      const answer = second.messages.filter(item => item.role === 'assistant').at(-1).content;
      assert.ok(answer.includes('SILVER_SLATE_ORCHARD'), answer); assert.ok(answer.includes('FRANKLIN_BROWSER_SILVER_7391'), answer);
      assert.ok(requestHits.includes('/franklin-proof'));
      const browser = await evaluate('window.studio.browser.state()');
      assert.equal(browser.ok, true); assert.equal(browser.result.url, url); assert.equal(browser.result.visible, true);
      const geometry = await evaluate(`(()=>{const a=document.getElementById('yur-franklin').getBoundingClientRect();const b=document.getElementById('yc-browser-viewport').getBoundingClientRect();const native=window.yurNativeViewBounds({x:Math.ceil(b.left),y:Math.ceil(b.top),width:Math.floor(b.width),height:Math.floor(b.height)});return {assistant:{left:a.left,right:a.right,top:a.top,bottom:a.bottom},native}})()`);
      assert.ok(geometry.assistant.right <= geometry.native.x || geometry.native.y + geometry.native.height <= geometry.assistant.top, JSON.stringify(geometry));
      await evaluate('document.getElementById("glider-coding").click();true');
      assert.equal(await evaluate('document.getElementById("franklin-panel").hidden'), false);
      await wait('window.studio.browser.state().then(r=>r.ok&&!r.result.visible)', 10000);
      await evaluate('(()=>{document.getElementById("glider-desktop").click();const input=document.getElementById("franklin-input");input.value="A saved Franklin draft for tomorrow.";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
      await wait('window.studio.franklin.snapshot().then(r=>r.ok&&r.result.preferences.draft==="A saved Franklin draft for tomorrow.")', 10000);
      assert.deepEqual(errors, []);
      const state = await snapshot(), captureErrors = [];
      try { fs.writeFileSync(path.join(evidence, 'franklin.png'), (await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }), new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot deadline')), 3000))])).toPNG()); } catch (error) { captureErrors.push(error.message); }
      const receipt = { at: new Date().toISOString(), profile, provider: 'existing Ollama OpenAI-compatible cloud route', model: selected, checks: ['Actual cloud tool calling', 'Workforce view navigation', 'Bounded prior conversation recalled', 'Actual owned browser page navigation and read', 'Assistant and native browser do not overlap', 'Assistant remains across coding/Desktop tabs', 'Draft committed before shutdown'], snapshot: state, fixtureRequests: requestHits, geometry, captureErrors, events: await evaluate('window.__franklinEvents') };
      fs.writeFileSync(path.join(evidence, 'native-receipt.json'), JSON.stringify(receipt, null, 2));
      console.log(JSON.stringify({ profile, checks: receipt.checks, requests: state.requests })); app.quit();
    } catch (error) {
      const failure = { profile, at: new Date().toISOString(), error: error.stack };
      try { failure.snapshot = await snapshot(); failure.ui = await evaluate('document.getElementById("franklin-error")?.textContent'); } catch {}
      fs.writeFileSync(path.join(evidence, `native-failure-${Date.now()}.json`), JSON.stringify(failure, null, 2));
      console.error(error.stack); app.exit(1);
    }
  });
});
require('../src/main');
