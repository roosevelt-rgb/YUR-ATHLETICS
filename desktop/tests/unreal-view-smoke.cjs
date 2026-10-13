'use strict';
// Isolated native UI component fixture; it never imports Desktop main or launches Unreal.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-unreal-view-'));
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
let window, finished = false;
const timeout = setTimeout(() => finish(new Error('Native Unreal view fixture timed out.')), 20000);
function finish(error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  if (window && !window.isDestroyed()) window.destroy();
  if (error) { console.error(error.message); process.exitCode = 1; }
  app.quit();
}
app.on('will-quit', () => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('yur-unreal-view-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch {}
  }
});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file:|data:)/.test(details.url) }));
  const script = pathToFileURL(path.resolve(__dirname, '../src/unreal-view.js')).href;
  const style = pathToFileURL(path.resolve(__dirname, '../src/unreal-view.css')).href;
  const page = path.join(root, 'fixture.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${style}"><main id="host"></main><script src="${script}"></script><script>
    window.calls=[]; window.plans=[]; window.stopped=0; window.previewListener=null;
    window.nativeFixture=YurUnrealView.create(document.getElementById('host'),{api:{
      invoke:async(action,payload)=>{ calls.push({action,payload}); return action==='unreal_status'?{status:'connected',available:true,project_file:'/fixture/Existing.uproject',inspections:['level','camera'],capture_available:true,camera_available:true}:{level:'/Game/Fixture'}; },
      onPreview:callback=>{window.previewListener=callback;return()=>window.stopped++;}
    },onFranklin:text=>plans.push(text)});
  </script>`);
  window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const errors = []; window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(page);
  await window.webContents.executeJavaScript('nativeFixture.ready');
  const result = await window.webContents.executeJavaScript(`(async()=>{
    const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent===text);
    const before={connected:document.body.textContent.includes('Connected to the selected Unreal editor.'),disabled:button('Selected actors').disabled};
    button('Current level').click(); await new Promise(resolve=>setTimeout(resolve,30));
    button('Plan with Franklin').click(); await new Promise(resolve=>setTimeout(resolve,30));
    previewListener({project_file:'/fixture/Existing.uproject',sha256:'a'.repeat(64),width:1,height:1,data_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII='});
    const previewVisible=!document.querySelector('img').hidden;
    nativeFixture.dispose();
    return {...before,calls,plans,previewVisible,stopped,removed:document.getElementById('host').children.length===0};
  })()`);
  assert.equal(result.connected, true); assert.equal(result.disabled, true);
  assert.deepEqual(result.calls, [{ action: 'unreal_status', payload: {} }, { action: 'unreal_inspect', payload: { kind: 'level' } }]);
  assert.equal(result.plans.length, 1); assert.match(result.plans[0], /confirmation/);
  assert.equal(result.previewVisible, true); assert.equal(result.stopped, 1); assert.equal(result.removed, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: 7, scope: 'isolated-native-unreal-view', engine_started: false, live_engine_verified: false }));
  finish();
}).catch(finish);
