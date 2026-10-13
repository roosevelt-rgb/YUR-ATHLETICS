'use strict';

// Run with the installed Electron binary, not Node. Every durable write uses a
// newly created temporary workspace. This exercises the real preload, IPC and CLI.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-desktop-smoke-'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(testHome, 'electron'));
process.env.YUR_FACTORY_HOME = path.join(testHome, 'factory');
process.argv.push('--factory');
const errors = [];
let finished = false;
const deadline = setTimeout(() => finish(new Error('Desktop smoke exceeded 150 seconds.')), 150000);

function finish(error, result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const report = error ? { ok: false, error: error.message, errors, test_home: testHome } : { ok: true, ...result, test_home: testHome };
  fs.writeFileSync(path.join(testHome, 'smoke-result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  app.exit(error ? 1 : 0);
}

async function waitFor(contents, expression, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const notice = await contents.executeJavaScript('document.getElementById("notice")?.textContent');
  throw new Error(`Timed out waiting for ${expression}. Notice: ${notice}`);
}

app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.setSkipTaskbar(true);
  const contents = window.webContents;
  contents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(String(message).slice(0, 300));
  });
  contents.on('preload-error', (_event, _path, error) => errors.push(error.message));
  contents.once('did-finish-load', async () => {
    try {
      await waitFor(contents, 'document.getElementById("connection-label").textContent === "Local runtime ready" && !document.getElementById("submit-mission").disabled');
      const catalogResponse = await contents.executeJavaScript('window.studio.factory.request({ command: "catalog" })');
      assert.equal(catalogResponse?.ok, true, 'The runtime catalog request must succeed.');
      assert.ok(Array.isArray(catalogResponse.result), 'The runtime must return a capability catalog.');
      const catalogIds = catalogResponse.result.map(capability => capability.id);
      assert.ok(catalogIds.every(id => typeof id === 'string' && id.length > 0), 'Catalog entries require explicit capability IDs.');
      assert.equal(new Set(catalogIds).size, catalogIds.length, 'Runtime capability IDs must be unique.');
      assert.ok(catalogIds.includes('support.triage'), 'The smoke mission requires the support.triage capability.');
      const renderedIds = await contents.executeJavaScript('[...document.querySelectorAll("input[name=capability]")].map(input => input.value)');
      assert.equal(new Set(renderedIds).size, renderedIds.length, 'Rendered capability IDs must be unique.');
      assert.deepEqual([...renderedIds].sort(), [...catalogIds].sort(), 'The factory must render the exact runtime capability catalog.');
      const catalogSize = renderedIds.length;
      assert.equal(await contents.executeJavaScript('Boolean(window.studio.file || window.studio.code || window.studio.terminal)'), false);
      await contents.executeJavaScript('document.querySelector(\'a[href="#mission-queue"]\').click(); document.getElementById("refresh").click()');
      await waitFor(contents, 'document.getElementById("notice").textContent === "Factory state refreshed." && !document.getElementById("submit-mission").disabled');
      await contents.executeJavaScript(`
        document.getElementById('mission-name').value = 'Desktop smoke support specialist';
        document.getElementById('mission-description').value = 'Classify fresh support tickets with evidence.';
        document.querySelector('input[value="support.triage"]').checked = true;
        document.getElementById('mission-form').requestSubmit();
      `);
      await waitFor(contents, 'document.getElementById("metric-total").textContent === "1" && !document.getElementById("process-queue").disabled');
      const missionId = await contents.executeJavaScript('document.getElementById("detail-id").textContent');
      assert.ok(missionId);
      await contents.executeJavaScript('document.getElementById("process-queue").click()');
      await waitFor(contents, 'document.getElementById("metric-committed").textContent === "1" && !document.getElementById("run-specialist").disabled');
      const inspection = JSON.parse(await contents.executeJavaScript('document.getElementById("detail-json").textContent'));
      assert.equal(inspection.status, 'completed');
      assert.ok(inspection.artifact.digest);
      assert.ok(inspection.events.length > 0);
      await contents.executeJavaScript('document.querySelector("[data-detail=run]").click(); document.getElementById("run-specialist").click()');
      await waitFor(contents, '!document.getElementById("run-output").hidden && !document.getElementById("run-specialist").disabled');
      const execution = JSON.parse(await contents.executeJavaScript('document.getElementById("run-output").textContent'));
      assert.equal(execution.output.route, 'identity-support');
      assert.ok(execution.receipt);
      await contents.executeJavaScript('document.getElementById("export-agent").click()');
      await waitFor(contents, 'document.getElementById("notice").textContent.startsWith("Package export finished") && !document.getElementById("export-agent").disabled');
      const exported = JSON.parse(await contents.executeJavaScript('document.getElementById("run-output").textContent'));
      assert.ok(path.resolve(exported.path).startsWith(path.resolve(testHome) + path.sep));
      assert.ok(fs.statSync(exported.path).size > 0);
      await contents.executeJavaScript(`
        document.getElementById('mission-name').value = 'Desktop continuous queue specialist';
        document.getElementById('mission-form').requestSubmit();
      `);
      await waitFor(contents, 'document.getElementById("metric-total").textContent === "2" && !document.getElementById("automation-start").disabled');
      const automatedMissionId = await contents.executeJavaScript('document.getElementById("detail-id").textContent');
      await contents.executeJavaScript('document.getElementById("automation-cycles").value = "1"; document.getElementById("automation-interval").value = "5"; document.getElementById("automation-start").click()');
      await waitFor(contents, 'document.getElementById("metric-committed").textContent === "2" && document.getElementById("automation-status").dataset.cycles === "1" && document.getElementById("automation-status").dataset.enabled === "false" && !document.getElementById("automation-start").disabled');
      const automated = JSON.parse(await contents.executeJavaScript('document.getElementById("detail-json").textContent'));
      assert.equal(automated.id, automatedMissionId);
      assert.equal(automated.status, 'completed');
      const automationStatus = await contents.executeJavaScript('window.studio.factory.request({command:"automation_status"})');
      assert.equal(automationStatus.result.cycles, 1);
      assert.equal(automationStatus.result.enabled, false);
      assert.equal(automationStatus.result.running, false);
      await contents.executeJavaScript('document.getElementById("source-query").value = "construction"; document.getElementById("source-search").requestSubmit()');
      await waitFor(contents, 'document.getElementById("notice").textContent.startsWith("Source evidence refreshed") && !document.getElementById("refresh").disabled');
      const sourceCount = await contents.executeJavaScript('document.querySelectorAll(".source-record").length');
      await contents.executeJavaScript('window.scrollTo(0, 0)');
      const screenshot = path.join(testHome, 'factory-console.png');
      fs.writeFileSync(screenshot, (await contents.capturePage()).toPNG());
      await contents.executeJavaScript('document.getElementById("ecosystem-sources").scrollIntoView({block:"start"})');
      const sourcesScreenshot = path.join(testHome, 'factory-sources.png');
      fs.writeFileSync(sourcesScreenshot, (await contents.capturePage()).toPNG());
      assert.deepEqual(errors, []);
      finish(null, { catalog_size: catalogSize, mission_id: missionId, status: inspection.status, artifact_digest: inspection.artifact.digest, execution_route: execution.output.route, exported_bytes: exported.bytes, source_count: sourceCount, automated_mission_id: automatedMissionId, automated_status: automated.status, automation: automationStatus.result, completed_missions: 2, sidebar_navigation: 'verified', screenshot, sources_screenshot: sourcesScreenshot });
    } catch (error) { finish(error); }
  });
});

require('../src/main.js');
