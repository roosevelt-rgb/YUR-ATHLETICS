// Existing feature fixtures start at the studio. The new splash/entry boundary
// is exercised separately by glider-rc6-smoke.cjs, without this adapter.
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const target = process.argv[2];
const legacyEntry = ['conversation-preview.cjs', 'specialist-forge-live.cjs'].includes(target);
if ((!/^[a-z-]+-smoke\.cjs$/.test(target || '') && !legacyEntry) || /^(glider|franklin)-/.test(target || '')) throw new Error('Select an existing isolated desktop fixture.');
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function(file, ...args) {
  if (['yur-ai-launch.html', 'glider-launch.html'].includes(path.basename(file))) file = path.join(path.dirname(file), 'studio-editor.html');
  return loadFile.call(this, file, ...args);
};
app.on('browser-window-created', (_event, window) => {
  const instanceLoad = window.loadFile.bind(window);
  window.loadFile = (file, ...args) => instanceLoad(['yur-ai-launch.html', 'glider-launch.html'].includes(path.basename(file)) ? path.join(path.dirname(file), 'studio-editor.html') : file, ...args);
  window.webContents.on('did-finish-load', () => console.log('Fixture page: ' + path.basename(window.webContents.getURL())));
  const capture = window.webContents.capturePage.bind(window.webContents);
  window.webContents.capturePage = async (...args) => {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await Promise.race([capture(...args), new Promise((_, reject) => setTimeout(() => reject(new Error('Native capture deadline')), 4000))]); }
      catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    throw last;
  };
});
process.argv.splice(1, 2, path.join(__dirname, target));
require('./' + target);
