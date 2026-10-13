'use strict';
// Explicit live-provider acceptance; all desktop/factory writes use isolated state.
// No model fixture, installation, service startup, or endpoint override.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-forge-live-'));
app.setPath('userData', path.join(home, 'electron'));
process.env.YUR_DESKTOP_HOME = path.join(home, 'desktop');
process.env.YUR_FACTORY_HOME = path.join(home, 'factory');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
const model = process.env.YUR_FORGE_TEST_MODEL;
const report = { ok: false, live_model_verified: false, home, model: model || null };
let finished = false;
const timer = setTimeout(() => finish(new Error('Live build exceeded the 180 second deadline. Inspect retained Work state.')), 180000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(timer);
  report.ok = !error;
  if (error) report.error = error.message;
  fs.writeFileSync(path.join(home, 'result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
  app.exit(error ? 1 : 0);
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('render-process-gone', (_event, details) => finish(new Error(`Renderer stopped: ${details.reason} (${details.exitCode})`)));
  window.setFocusable(false); window.setOpacity(0); window.setPosition(-16000, -16000); window.setSkipTaskbar(true);
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load', async () => {
    const evaluate = code => window.webContents.executeJavaScript(code);
    const wait = async (code, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('Desktop condition timed out: ' + code);
    };
    const envelope = async code => { const value = await evaluate(code); assert.equal(value.ok, true); return value.result; };
    try {
      await wait('Boolean(window.studio?.ollama && document.getElementById("yc-send"))');
      const tags = await evaluate('studio.ollama.tags()');
      report.available_models = (tags?.models || []).map(item => item.name);
      if (!model || !model.startsWith('ollama:')) throw new Error('Set YUR_FORGE_TEST_MODEL to an explicitly selected ollama:<model> from available_models. No build was dispatched.');
      report.readiness = await evaluate(`studio.ollama.workReadiness(${JSON.stringify(model)})`);
      assert.equal(report.readiness.ready, true, report.readiness.message);
      await wait(`!document.getElementById('yc-send').disabled && [...document.getElementById('yc-model').options].some(item => item.value === ${JSON.stringify(model)})`);
      await evaluate(`document.getElementById('yc-model').value=${JSON.stringify(model)}; document.getElementById('yc-model').dispatchEvent(new Event('change')); document.querySelector('[data-workspace=agents]').click(); document.getElementById('yc-create-specialist').click();`);
      await wait('Boolean(document.querySelector(".sf-name"))');
      await evaluate(`document.querySelector('.sf-name').value='Live proof helper'; document.querySelector('.sf-sample-text').value='Alpha beta alpha.'; document.querySelector('form.sf-form').requestSubmit();`);
      await wait('Boolean(document.querySelector(".yc-open-work")) && !document.getElementById("yc-send").disabled', 130000);
      const list = await envelope('studio.work.list(null)');
      assert.equal(list.missions.length, 1);
      const record = await envelope(`studio.work.inspect(${JSON.stringify(list.missions[0].id)})`);
      const mission = record.mission;
      report.mission_id = mission.id;
      report.mission_status = mission.status;
      report.steps = mission.steps.map(step => ({
        tool: step.tool,
        succeeded: step.succeeded,
        committed: step.result?.committed === true,
        error: typeof step.result?.error === 'string' ? step.result.error.slice(0, 1000) : null,
      }));
      assert.equal(mission.status, 'completed');
      const build = mission.steps.find(step => step.tool === 'build_specialist' && step.succeeded)?.result;
      const sample = mission.steps.find(step => step.tool === 'run_built_specialist' && step.succeeded)?.result;
      assert.equal(build?.committed, true, 'The live provider did not produce a committed build. Mission completion or prose is not outcome proof.');
      assert.deepEqual(mission.steps.find(step => step.tool === 'build_specialist' && step.succeeded)?.arguments,
        { name: 'Live proof helper', description: '', capabilities: ['text.analyze'] });
      assert.equal(build.artifact.validation.passed, true);
      assert.equal(build.artifact.validation.independent_validation.passed, true);
      assert.match(build.artifact.digest, /^[a-f0-9]{64}$/);
      assert.equal(sample?.committed, true, 'No committed sample proof');
      assert.equal(sample.mission_id, build.mission_id);
      assert.deepEqual(mission.steps.find(step => step.tool === 'run_built_specialist' && step.succeeded)?.arguments,
        { mission_id: build.mission_id, capability_id: 'text.analyze', input: { text: 'Alpha beta alpha.' } });
      assert.equal(build.provenance.parent_work_id, mission.id);
      assert.equal(sample.provenance.parent_work_id, mission.id);
      assert.equal(sample.output.word_count, 3);
      assert.equal(sample.output.sentence_count, 1);
      assert.match(sample.execution_receipt.hash, /^[a-f0-9]{64}$/);
      const saved = await envelope('studio.specialists.list(20,null)');
      assert.ok(saved.entries.some(item => item.mission_id === build.mission_id && item.artifact_digest === build.artifact.digest));
      report.proof = { build, sample };
      report.live_model_verified = true;
      finish();
    } catch (error) { finish(error); }
  });
});
require('../src/main.js');
