const { app, dialog } = require('electron');
const live = process.argv.includes('--live');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const selectedModel = process.env.YUR_TEST_SELECTED_MODEL || '';
const rc6Model = process.env.YUR_TEST_RC6_MODEL || selectedModel;
const secondRc6Model = process.env.YUR_TEST_SECOND_RC6_MODEL || '';
const observerProof = { checks: [], snapshots: {}, limitations: [] };
const evidenceValue = (key, value) => /^(reasoning|thinking)(?:_|$)/i.test(key) ? undefined : value;
const evidenceLabel = process.env.YUR_GLIDER_EVIDENCE_LABEL || '';
if (evidenceLabel && !/^[a-z0-9-]+$/.test(evidenceLabel)) throw new Error('Invalid evidence label');
const evidence = path.resolve(__dirname, '../../..', 'evidence/glider-rc6', ...(evidenceLabel ? ['comprehensive', evidenceLabel] : []));
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-glider-rc6-'));
process.env.YUR_GLIDER_RC6 = '1'; process.env.YUR_HARNESS_AUTOSTART = '0';
process.env.YUR_DESKTOP_HOME = path.join(profile, 'desktop'); process.env.YUR_FACTORY_HOME = path.join(profile, 'factory');
app.setPath('userData', path.join(profile, 'electron'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Native smoke deadline'); app.exit(1); }, live ? 720000 : 300000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false); win.setFocusable(false); win.setOpacity(0); win.setPosition(-16000, -16000); win.setSkipTaskbar(true);
  const errors = [], captureErrors = []; win.webContents.on('preload-error', (_e, _f, error) => errors.push(error.message));
  win.webContents.once('did-finish-load', async () => {
    try {
      const evaluate = code => win.webContents.executeJavaScript(code);
      const waitFor = async (expression, timeout = 180000) => { const until = Date.now() + timeout; while (Date.now() < until) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error('Combined acceptance timed out: ' + expression); };
      const capture = async () => { if (process.env.YUR_SKIP_CAPTURE === '1') throw new Error('Capture skipped for behavior-only run'); let last; for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 300)); try { return await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }), new Promise((_, reject) => setTimeout(() => reject(new Error('Native capture deadline')), 2000))]); } catch (error) { last = error; } } throw last; };
      const observerTab = async key => {
        await evaluate(`document.querySelector('[data-observer-tab="${key}"]').click()`);
        assert.equal(await evaluate(`document.getElementById('rc6-observer-${key}').hidden`), false);
        assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".rc6-observer-panel")).filter(p=>!p.hidden).map(p=>p.id)'), ['rc6-observer-' + key]);
        assert.equal(await evaluate(`document.querySelector('[data-observer-tab="${key}"]').getAttribute('aria-pressed')`), 'true');
        return evaluate(`document.getElementById('rc6-observer-${key}').textContent`);
      };
      const observerFacts = key => evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('#rc6-observer-${key} dt')).map(dt=>[dt.textContent,dt.nextElementSibling.textContent]))`);
      const saveObserver = () => fs.writeFileSync(path.join(evidence, 'native-observer-receipt.json'), JSON.stringify({ at: new Date().toISOString(), profile, ...observerProof }, null, 2));
      assert.equal(await evaluate('!!document.querySelector(".splash-core")'), true);
      await assert.rejects(evaluate('window.studio.rc6.connect()'), /Untrusted studio/);
      try { fs.writeFileSync(path.join(evidence, 'splash.png'), (await capture()).toPNG()); } catch (error) { captureErrors.push(error.message); }
      const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      await evaluate('setTimeout(() => window.studio.launch.enter(), 25); true'); await loaded;
      for (let i = 0; i < 100 && !await evaluate('!!document.getElementById("glider-coding")'); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate('!!document.getElementById("glider-coding")'), true);
      assert.equal((await evaluate('window.studio.integration.info()')).enabled, true);
      if (selectedModel) {
        await waitFor(`Array.from(document.getElementById('yc-model')?.options || []).some(option=>option.value===${JSON.stringify(selectedModel)})`, 30000);
        await evaluate(`const model=document.getElementById('yc-model'); model.value=${JSON.stringify(selectedModel)}; model.dispatchEvent(new Event('change', {bubbles:true})); true`);
        await waitFor(`document.getElementById('yc-model').value===${JSON.stringify(selectedModel)}`, 10000);
      }
      await evaluate('document.getElementById("glider-coding").click()');
      assert.equal(await evaluate('document.getElementById("rc6-panel").hidden'), false);
      assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[data-observer-tab]")).map(b=>({key:b.dataset.observerTab,label:b.textContent}))'), [
        { key: 'tools', label: 'Tools' }, { key: 'agents', label: 'Agents' }, { key: 'terminal', label: 'Terminal' }, { key: 'activity', label: 'Activity' }, { key: 'system', label: 'System' },
      ]);
      const geometry = await evaluate('(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,width:r.width,height:r.height}};return {conversation:box(".rc6-conversation"),observer:box(".rc6-observer-host"),viewport:innerWidth}})()');
      assert.ok(geometry.observer.x >= geometry.conversation.right - 2, 'RC6 inspector must be in the right column');
      assert.ok(geometry.observer.width >= 250 && geometry.observer.height > 100 && geometry.observer.right <= geometry.viewport + 1, 'RC6 inspector must fit the visible workbench');
      observerProof.geometry = geometry;
      for (const key of ['tools', 'agents', 'terminal', 'activity', 'system']) await observerTab(key);
      observerProof.checks.push('Five actual inspector tabs switch one visible right-column panel');
      assert.match(await observerTab('agents'), /No delegated agents have been reported/);
      assert.match(await observerTab('terminal'), /No terminal operations reported/);
      await observerTab('tools');
      await evaluate('window.__rc6Events=[]; window.studio.rc6.onEvent(e=>window.__rc6Events.push(e)); true');
      await waitFor('!document.getElementById("rc6-model").disabled', 30000);
      const expectedModels = await evaluate('window.studio.ollama.tags().then(tags=>window.yurModelSetup.summarize({checked:true,mode:"code",ollama:{online:true,models:tags.models}}).models.map(model=>model.id))');
      const visibleModels = await evaluate('Array.from(document.getElementById("rc6-model").options).filter(option=>option.value && !option.disabled).map(option=>option.value)');
      assert.deepEqual([...visibleModels].sort(), [...expectedModels].sort());
      // The non-live smoke opens a session without submitting inference. Select a
      // discovered model explicitly; a fresh profile must not imply a UI choice.
      const chosenRc6Model = rc6Model || (!live ? visibleModels[0] : '');
      if (!live) assert.ok(chosenRc6Model, 'The connection smoke requires an available catalog model');
      if (chosenRc6Model) {
        assert.ok(visibleModels.includes(chosenRc6Model));
        await evaluate(`const codingModel=document.getElementById('rc6-model'); codingModel.value=${JSON.stringify(chosenRc6Model)}; codingModel.dispatchEvent(new Event('change', {bubbles:true})); true`);
        assert.equal(await evaluate('document.getElementById("rc6-refresh-models").click(); document.getElementById("rc6-refresh-models").disabled'), true);
        await waitFor('!document.getElementById("rc6-refresh-models").disabled', 30000);
        assert.equal(await evaluate('document.getElementById("rc6-model").value'), chosenRc6Model);
      }
      console.log('Combined acceptance: RC6 picker matches all ' + visibleModels.length + ' available Ollama entries; explicit choice survives refresh');
      const selectedWorkspace = path.join(profile, 'selected-project'); fs.mkdirSync(selectedWorkspace);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedWorkspace] });
      await evaluate('document.getElementById("rc6-workspace").click()');
      await waitFor(`window.studio.rc6.status().then(s=>s.workspace===${JSON.stringify(selectedWorkspace)})`,10000);
      assert.equal(await evaluate('document.getElementById("rc6-connect").disabled'), false, 'Select an available model and workspace before connecting');
      await evaluate('document.getElementById("rc6-connect").click()');
      await waitFor('window.studio.rc6.status().then(s=>s.running && !document.getElementById("rc6-new").disabled)', 10000);
      const runtime = await evaluate('window.studio.rc6.status()'); assert.equal(runtime.running, true);
      assert.equal(await evaluate('document.getElementById("rc6-model").disabled'), true);
      if (chosenRc6Model) {
        assert.equal(runtime.model, chosenRc6Model.slice('ollama:'.length));
        assert.equal(runtime.modelSource, 'selection');
        assert.ok((await evaluate('document.getElementById("rc6-provider").textContent')).includes(runtime.model));
        console.log('Combined acceptance: Selected model reaches RC6: ' + runtime.model);
      }
      await evaluate('document.getElementById("rc6-new").click()');
      for (let i = 0; i < 100 && await evaluate('document.getElementById("rc6-prompt").disabled'); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate('document.getElementById("rc6-prompt").disabled'), false);
      const session = { session_id: (await evaluate('document.getElementById("rc6-log").textContent')).match(/New IntelliFlow session: (\S+)/)[1] }; assert.ok(session.session_id);
      assert.ok(runtime.workspace.startsWith(profile));
      await assert.rejects(evaluate('window.studio.rc6.submit("foreign", "hello")'), /does not belong/);
      await assert.rejects(evaluate(`window.studio.rc6.approval(${JSON.stringify(session.session_id)}, "invented", "approve")`), /absent/);
      // Discovery may be slow on a cold bundled runtime. Preserve its first outcome
      // separately; an unavailable catalog must never be presented as zero tools.
      await waitFor('!document.getElementById("rc6-observer-refresh").disabled', 130000);
      observerProof.coldSnapshot = { error: await evaluate('document.querySelector(".rc6-observer-error").textContent'), tools: await observerTab('tools'), system: await observerTab('system') };
      observerProof.coldSnapshot.status = /timed out/i.test(observerProof.coldSnapshot.error) ? 'timed_out' : observerProof.coldSnapshot.error ? 'partial_failure' : 'returned';
      observerProof.snapshots = await evaluate(`Promise.all(['inventory','health','info'].map(async name=>{const started=performance.now();try {const result=await window.studio.rc6[name]();return [name,{status:'returned',elapsed_ms:Math.round(performance.now()-started),result}]}catch(error){return [name,{status:/timed out/i.test(error.message)?'timed_out':'failed',elapsed_ms:Math.round(performance.now()-started),error:error.message}]}})).then(Object.fromEntries)`);
      // Retry UI discovery once only when the independent read proves that the
      // cold unavailable catalog has become available. Do not repeat timeouts.
      if (observerProof.snapshots.inventory.status === 'returned' && observerProof.coldSnapshot.error) {
        await evaluate('document.getElementById("rc6-observer-refresh").click()');
        await waitFor('!document.getElementById("rc6-observer-refresh").disabled', 130000);
      }
      const observerError = await evaluate('document.querySelector(".rc6-observer-error").textContent');
      const inventory = observerProof.snapshots.inventory;
      const toolsSnapshot = await observerTab('tools');
      if (inventory.status === 'returned') {
        assert.ok(Array.isArray(inventory.result.capabilities));
        assert.ok(toolsSnapshot.includes(inventory.result.capabilities.length + ' returned by ' + runtime.runtimeName));
        const target = inventory.result.capabilities.find(item => (item.name || '').includes('write_file')) || inventory.result.capabilities.at(-1);
        if (target) {
          const search = target.capability_id || target.name;
          await evaluate(`(()=>{const input=document.querySelector('#rc6-observer-tools input[type="search"]');input.value=${JSON.stringify(search)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
          const matches = await evaluate('document.getElementById("rc6-observer-tools").textContent');
          assert.ok(matches.includes(target.name || target.capability_id));
          assert.ok(matches.includes(target.operational_state || target.health || 'state not reported'));
          await evaluate('(()=>{const input=document.querySelector("#rc6-observer-tools input[type=search]");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));})()');
        }
        observerProof.checks.push('Displayed capability count, searchable item and availability match live inventory');
      } else {
        if (observerProof.coldSnapshot.status !== 'returned') { assert.match(observerError, /inventory:/i); assert.ok(!toolsSnapshot.includes('0 returned by ' + runtime.runtimeName)); }
        observerProof.limitations.push('Live inventory ' + inventory.status + ': ' + inventory.error);
      }
      const health = observerProof.snapshots.health, systemSnapshot = await observerTab('system');
      if (health.status === 'returned') {
        assert.ok(systemSnapshot.includes('Health · ' + health.result.status));
        const facts = await observerFacts('system');
        if (Array.isArray(health.result.reasons)) for (const reason of health.result.reasons) assert.ok(systemSnapshot.includes(reason));
        for (const [label, key] of [['OrchestrationManager', 'orchestration_manager'], ['Commit Service', 'commit_service'], ['Validation separated', 'validation_commit_separated']]) {
          if (health.result.authority?.[key] !== undefined) assert.equal(facts[label], String(health.result.authority[key]));
        }
        observerProof.checks.push('System health and authority report the live runtime response without upgrading degraded state');
      } else { assert.match(observerError, /health:/i); observerProof.limitations.push('Live health ' + health.status + ': ' + health.error); }
      const delegation = await evaluate(`window.studio.rc6.delegationStatus(${JSON.stringify(session.session_id)})`);
      assert.deepEqual(delegation.active, []);
      assert.match(await observerTab('agents'), /0 reported running/);
      assert.match(await observerTab('agents'), /No delegated agents have been reported/);
      assert.equal(await evaluate('document.querySelectorAll("#rc6-observer-agents article").length'), 0);
      assert.match(await observerTab('terminal'), /No terminal operations reported/);
      assert.equal(await evaluate('document.querySelectorAll("#rc6-observer-terminal article").length'), 0);
      observerProof.checks.push('No delegated workers or terminal output are fabricated in a fresh private session');
      observerProof.delegation = delegation; saveObserver(); await observerTab('tools');
      
      if (live) {
        console.log('Combined live acceptance: connected through UI; session ' + session.session_id);
        await assert.rejects(evaluate('window.studio.rc6.chooseWorkspace()'), /Disconnect the coding runtime/);
        await evaluate('document.getElementById("rc6-prompt").value="Respond exactly RC6_NATIVE_UI_CONNECTED. Do not use tools or change files."; document.querySelector("#rc6-panel form").requestSubmit()');
        await waitFor('document.getElementById("rc6-send").disabled',10000);
        await evaluate('document.getElementById("glider-desktop").click()');
        assert.equal(await evaluate('document.getElementById("rc6-panel").hidden'), true);
        await waitFor('window.__rc6Events.some(e=>e.type==="message.complete" && e.payload?.text?.includes("RC6_NATIVE_UI_CONNECTED"))');
        await evaluate('document.getElementById("glider-coding").click()');
        assert.match(await evaluate('document.getElementById("rc6-log").textContent'), /RC6_NATIVE_UI_CONNECTED/);
        assert.equal(await evaluate('document.getElementById("rc6-send").disabled'), false);
        console.log('Combined live acceptance: actual model response streamed into panel and survived tab switch');
        const proofFile = path.join(runtime.workspace, 'native-ui-proof.txt');
        const prompt = 'Use native write_file to create exactly ' + proofFile + ' containing exactly RC6_NATIVE_UI_COMMITTED followed by a newline. Do not use terminal, other files, delegation or network. Report the committed operation.';
        await evaluate(`document.getElementById("rc6-prompt").value=${JSON.stringify(prompt)}; document.querySelector("#rc6-panel form").requestSubmit()`);
        await waitFor('window.__rc6Events.some(e=>e.type==="authority.commit" && e.payload?.receipt?.status==="committed")');
        await waitFor('!document.getElementById("rc6-send").disabled');
        assert.equal(fs.readFileSync(proofFile,'utf8').trim(), 'RC6_NATIVE_UI_COMMITTED');
        assert.match(await evaluate('document.getElementById("rc6-log").textContent'), /authority.commit/);
        const toolEvents = await evaluate('window.__rc6Events.filter(e=>["tool.start","tool.complete","authority.commit","message.complete"].includes(e.type))');
        const startedTool = toolEvents.find(event => event.type === 'tool.start' && /write_file/.test(event.payload?.name || event.payload?.tool_name || event.payload?.tool || ''));
        assert.ok(startedTool, 'Actual write_file start event must be reported');
        const toolId = startedTool.payload.tool_id || startedTool.payload.tool_call_id; assert.ok(toolId);
        const completedTool = toolEvents.find(event => event.type === 'tool.complete' && (event.payload?.tool_id || event.payload?.tool_call_id) === toolId);
        assert.ok(completedTool, 'The same write_file tool identity must complete'); assert.equal(Boolean(completedTool.payload.error), false);
        const toolPanel = await observerTab('tools');
        assert.ok(toolPanel.includes(toolId)); assert.match(toolPanel, /write_file · finished/);
        const receiptEvent = toolEvents.find(event => event.type === 'authority.commit' && event.payload?.receipt?.status === 'committed');
        assert.ok(receiptEvent.payload.receipt.commit_id, 'A real commit ID is required');
        const activityPanel = await observerTab('activity');
        assert.match(activityPanel, /tool.start/); assert.match(activityPanel, /tool.complete/); assert.match(activityPanel, /authority.commit/);
        assert.ok(activityPanel.includes(receiptEvent.payload.receipt.commit_id)); assert.ok(activityPanel.includes('committed'));
        const usage = toolEvents.filter(event => event.type === 'message.complete').at(-1)?.payload?.usage;
        assert.ok(usage && Object.keys(usage).length, 'Model must report actual response usage');
        await observerTab('system'); const usageFacts = await observerFacts('system');
        let reportedCounters = 0;
        for (const [label, key] of [['Reported model', 'model'], ['Input tokens', 'input'], ['Output tokens', 'output'], ['Total tokens', 'total'], ['Model calls', 'calls'], ['Context used', 'context_used'], ['Context maximum', 'context_max'], ['Cache read tokens', 'cache_read']]) {
          const value = usage[key];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0 || typeof value === 'string' && value) { assert.equal(usageFacts[label], String(value)); if (typeof value === 'number') reportedCounters++; }
          else assert.equal(usageFacts[label], 'Not reported');
        }
        assert.ok(reportedCounters > 0, 'System must display at least one model-reported usage counter');
        assert.equal(usageFacts.Cost, typeof usage.cost_usd === 'number' && usage.cost_usd >= 0 ? '$' + usage.cost_usd : usage.cost_status || 'Not reported');
        assert.match(await observerTab('agents'), /No delegated agents have been reported/);
        assert.match(await observerTab('terminal'), /No terminal operations reported/);
        observerProof.tool = { tool_id: toolId, started: startedTool, completed: completedTool, commit: receiptEvent.payload.receipt };
        observerProof.usage = { reported: usage, displayed: usageFacts };
        observerProof.checks.push('Live write_file start/complete identity is shown in Tools', 'Actual committed authority receipt is shown in Activity', 'System usage exactly matches the completed model response, with missing values labeled', 'A file tool does not invent delegated-agent or terminal operations');
        saveObserver(); await observerTab('activity');
        try { fs.writeFileSync(path.join(evidence, 'coding-observer-activity.png'), (await capture()).toPNG()); } catch (error) { captureErrors.push(error.message); }
        fs.writeFileSync(path.join(evidence, 'native-ui-live-events.json'),JSON.stringify(await evaluate('window.__rc6Events.filter(e=>["tool.start","tool.complete","authority.commit","message.complete","error"].includes(e.type))'),evidenceValue,2));
        console.log('Combined live acceptance: actual file bytes and authority commit receipt verified');
        const oldCount = await evaluate('window.__rc6Events.filter(e=>e.type==="message.complete").length');
        await evaluate('document.getElementById("rc6-prompt").value="Without using tools, write a very long 3000-word explanation of sorting algorithms."; document.querySelector("#rc6-panel form").requestSubmit()');
        await waitFor('document.getElementById("rc6-send").disabled',10000);
        await evaluate('document.getElementById("rc6-interrupt").click()');
        await waitFor(`window.__rc6Events.filter(e=>e.type==="message.complete").length>${oldCount}`,60000);
        assert.equal(await evaluate('document.getElementById("rc6-send").disabled'),false);
        console.log('Combined live acceptance: interrupt completed and Send recovered');
      }
      try { fs.writeFileSync(path.join(evidence, 'coding.png'), (await capture()).toPNG()); } catch (error) { captureErrors.push(error.message); }
      await evaluate('document.getElementById("glider-desktop").click()');
      assert.equal(await evaluate('document.getElementById("rc6-panel").hidden'), true);
      assert.equal(await evaluate('!!document.getElementById("yur-conversation")'), true);
      try { fs.writeFileSync(path.join(evidence, 'desktop-home.png'), (await capture()).toPNG()); } catch (error) { captureErrors.push(error.message); }
      await evaluate('document.getElementById("yc-launch-intelliflow").click()');
      assert.equal(await evaluate('document.getElementById("rc6-panel").hidden'), false);
      await evaluate('document.getElementById("glider-market").click()');
      assert.match(await evaluate('document.getElementById("yc-thread-title").textContent'), /Marketplace/i);
      await evaluate('window.studio.rc6.disconnect()');
      assert.equal((await evaluate('window.studio.rc6.status()')).running, false);
      await waitFor('!document.getElementById("rc6-model").disabled', 10000);
      let secondRuntime;
      if (live) {
        await evaluate('document.getElementById("glider-coding").click()');
        await waitFor('!document.getElementById("rc6-model").disabled', 30000);
        if (secondRc6Model) {
          assert.ok(visibleModels.includes(secondRc6Model));
          await evaluate(`const nextModel=document.getElementById('rc6-model'); nextModel.value=${JSON.stringify(secondRc6Model)}; nextModel.dispatchEvent(new Event('change', {bubbles:true})); true`);
        }
        await evaluate('document.getElementById("rc6-connect").click()');
        await waitFor('window.studio.rc6.status().then(s=>s.running && !document.getElementById("rc6-new").disabled)',10000);
        secondRuntime = await evaluate('window.studio.rc6.status()');
        if (secondRc6Model) assert.equal(secondRuntime.model, secondRc6Model.slice('ollama:'.length));
        await assert.rejects(evaluate(`window.studio.rc6.submit(${JSON.stringify(session.session_id)},"old session must be rejected")`), /does not belong/);
        await evaluate('document.getElementById("rc6-new").click()');
        await waitFor('!document.getElementById("rc6-prompt").disabled',10000);
        if (secondRc6Model) {
          await evaluate('document.getElementById("rc6-prompt").value="Respond exactly RC6_SECOND_MODEL_CONNECTED. Do not use tools or change files."; document.querySelector("#rc6-panel form").requestSubmit()');
          await waitFor('window.__rc6Events.some(e=>e.type==="message.complete" && e.payload?.text?.includes("RC6_SECOND_MODEL_CONNECTED"))');
          console.log('Combined live acceptance: second selected model responded: ' + secondRuntime.model);
          fs.writeFileSync(path.join(evidence, 'native-ui-live-events.json'),JSON.stringify(await evaluate('window.__rc6Events.filter(e=>["tool.start","tool.complete","authority.commit","message.complete","error"].includes(e.type))'),evidenceValue,2));
        }
        await evaluate('document.getElementById("rc6-disconnect").click()');
        await waitFor('window.studio.rc6.status().then(s=>!s.running)',10000);
        console.log('Combined live acceptance: reconnect starts clean and old session rejected');
      }
      try { fs.writeFileSync(path.join(evidence, 'marketplace.png'), (await capture()).toPNG()); } catch (error) { captureErrors.push(error.message); }
      assert.deepEqual(errors, []);
      const receipt = { live_model_verified: live, captureErrors, at: new Date().toISOString(), profile, runtime, secondRuntime, availableModels: visibleModels, session: session.session_id, observer: { checks: observerProof.checks, coldSnapshotStatus: observerProof.coldSnapshot.status, inventoryStatus: observerProof.snapshots.inventory.status, healthStatus: observerProof.snapshots.health.status }, checks: ['Original Glider splash loads', 'Trusted preload and shared frame load', 'RC6 picker includes every entry from the Desktop Ollama catalog', 'Explicit RC6 model selection survives refresh', 'Model selection locked while connected and unlocked after disconnect', 'Native installed RC6 starts and creates session', 'Foreign session submission rejected', 'Invented approval rejected', 'Desktop retained on tab switch'], limits: [...observerProof.limitations, ...(live ? ['Live approval challenge not generated by the automatic file-write operation', 'Model catalog availability does not certify coding ability for every listed model'] : ['No coding commit or real approval lifecycle exercised by this smoke'])] };
      fs.writeFileSync(path.join(evidence, 'native-receipt.json'), JSON.stringify(receipt, null, 2));
      console.log(JSON.stringify(receipt)); clearTimeout(deadline); app.quit();
    } catch (error) {
      console.error(error.stack);
      const failure = { at: new Date().toISOString(), profile, live, error: error.stack, observer: observerProof };
      try { failure.events = await win.webContents.executeJavaScript('(window.__rc6Events || []).filter(e=>!["message.delta","reasoning.delta","thinking.delta"].includes(e.type))'); } catch {}
      fs.writeFileSync(path.join(evidence, 'native-failure.json'), JSON.stringify(failure, evidenceValue, 2));
      clearTimeout(deadline); app.exit(1);
    }
  });
});
require('../src/main.js');
