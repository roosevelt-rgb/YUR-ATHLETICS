'use strict';
// Capture the real Electron renderer with isolated test state. An optional
// local-model turn exercises the existing Ollama bridge, never a cloud model.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-conversation-preview-'));
app.setPath('userData', path.join(home, 'electron'));
process.env.YUR_DESKTOP_HOME = path.join(home, 'conversations');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
const live = process.argv.includes('--live-local');
let finished = false;
const timer = setTimeout(() => finish(new Error('Preview timed out.')), 150000);
function finish(error, result = {}) {
  if (finished) return; finished = true; clearTimeout(timer);
  process.stdout.write(JSON.stringify({ ok: !error, error: error?.message, home, ...result }) + '\n');
  app.exit(error ? 1 : 0);
}
async function waitFor(contents, expression, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${expression}`);
}
app.on('browser-window-created', (_event, window) => {
  window.hide(); window.setSkipTaskbar(true); window.setSize(1440, 960);
  const contents = window.webContents;
  contents.once('did-finish-load', async () => {
    try {
      await waitFor(contents, 'Boolean(document.getElementById("yur-conversation"))', 10000);
      await new Promise(resolve => setTimeout(resolve, 1600));
      const empty = path.join(home, 'conversation-home.png');
      fs.writeFileSync(empty, (await contents.capturePage()).toPNG());
      if (!live) { finish(null, { empty }); return; }
      await waitFor(contents, '!document.getElementById("yc-send").disabled');
      const target = 'ollama:llama3.2:latest';
      await waitFor(contents, `Array.from(document.getElementById('yc-model').options).some(o => o.value === ${JSON.stringify(target)})`);
      await contents.executeJavaScript(`
        document.getElementById('yc-model').value = ${JSON.stringify(target)};
        document.getElementById('yc-model').dispatchEvent(new Event('change'));
        document.getElementById('yc-input').value = 'Respond with exactly these four words: YUR desktop connection verified';
        document.getElementById('yc-form').requestSubmit();
      `);
      await waitFor(contents, 'document.querySelector(".yc-message.assistant, .yc-message.error") && !document.getElementById("yc-send").disabled');
      const failure = await contents.executeJavaScript('document.querySelector(".yc-message.error .yc-message-body")?.textContent');
      assert.equal(failure, undefined, failure);
      const answer = await contents.executeJavaScript('document.querySelector(".yc-message.assistant .yc-prose").textContent');
      assert.match(answer, /YUR desktop connection verified/i);
      const chat = path.join(home, 'conversation-live-local.png');
      fs.writeFileSync(chat, (await contents.capturePage()).toPNG());
      const history = await contents.executeJavaScript('window.studio.conversations.list()');
      assert.equal(history.ok, true);
      assert.equal(history.result.conversations.length, 1);
      assert.equal(history.result.conversations[0].messages[1].role, 'assistant');
      finish(null, { empty, chat, answer, provider: 'Ollama', model: target, journal: 'verified', harnessExecution: 'not exercised' });
    } catch (error) { finish(error); }
  });
});
require('../src/main.js');
