'use strict';

// A display surface for one committed HTML artifact, never an execution worker.
// Scripts run only in a separate sandboxed renderer with no bridge or network.
const { randomUUID, createHash } = require('node:crypto');
const { clampBounds } = require('./browser-host');
const { installContextMenu } = require('./context-menu');
const SCHEME = 'yur-artifact';
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
const MAX_HTML_BYTES = 64 * 1024;

function registerArtifactScheme(protocol, additional = []) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }, ...additional]);
}
function checkedArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'content,media_type,name,sha256') throw new Error('Preview requires a committed HTML artifact.');
  if (value.media_type !== 'text/html' || typeof value.name !== 'string' || !value.name || value.name.length > 120 || typeof value.content !== 'string' || Buffer.byteLength(value.content) > MAX_HTML_BYTES || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('HTML artifact exceeds its contract.');
  if (createHash('sha256').update(value.content).digest('hex') !== value.sha256) throw new Error('Artifact bytes differ from the committed digest.');
  return { ...value };
}

function createArtifactPreview({ window, electron, onEvent = () => {} } = {}) {
  if (!window?.contentView || typeof onEvent !== 'function') throw new Error('Artifact preview requires an existing native window.');
  const runtime = electron || require('electron');
  const isolated = runtime.session.fromPartition(`yur-artifact-${randomUUID()}`, { cache: false });
  const view = new runtime.WebContentsView({ webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
    webSecurity: true, allowRunningInsecureContent: false, plugins: false, devTools: false,
    navigateOnDragDrop: false, spellcheck: false, disableDialogs: true, enableWebSQL: false,
  } });
  const contents = view.webContents;
  const removeContextMenu = installContextMenu(contents, { electron: runtime, window });
  let artifact = null, url = '', visible = false, closed = false, revision = 0;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  const ensure = () => { if (closed || window.isDestroyed() || contents.isDestroyed()) throw new Error('Artifact preview is closed.'); };
  const state = () => ({ name: artifact?.name || '', sha256: artifact?.sha256 || '', visible, revision, network: false, closed });
  const publish = (type, extra = {}) => { try { onEvent({ type, ...state(), ...extra }); } catch {} };
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = Boolean(!closed && artifact && details.url === url && details.resourceType === 'mainFrame' && details.webContentsId === contents.id);
    callback({ cancel: !allowed });
  });
  isolated.protocol.handle(SCHEME, request => {
    if (closed || !artifact || request.url !== url || request.method !== 'GET') return new Response('', { status: 403 });
    return new Response(artifact.content, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
  });
  const block = event => { event.preventDefault(); publish('blocked', { reason: 'Preview navigation is disabled.' }); };
  contents.on('will-navigate', block);
  contents.on('will-frame-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-attach-webview', block);
  contents.setWindowOpenHandler(() => { publish('blocked', { reason: 'Preview popups are disabled.' }); return { action: 'deny' }; });
  isolated.on('will-download', block);
  contents.on('render-process-gone', () => publish('error', { message: 'Artifact preview stopped. Close and reopen it to try again.' }));
  window.contentView.addChildView(view); view.setVisible(false);

  async function open(input) {
    ensure(); const checked = checkedArtifact(input); contents.stop();
    artifact = checked; url = `${SCHEME}://view/${checked.sha256}/index.html`; const opening = ++revision;
    const timer = setTimeout(() => { if (!closed && revision === opening) contents.stop(); }, 10000);
    try { await contents.loadURL(url); if (closed || revision !== opening) throw new Error('Preview changed while loading.'); publish('loaded'); return state(); }
    finally { clearTimeout(timer); }
  }
  function setBounds(value) { ensure(); bounds = clampBounds(value, window.getContentBounds()); view.setBounds(bounds); return state(); }
  function setVisible(value) { ensure(); if (typeof value !== 'boolean') throw new Error('Preview visibility must be boolean.'); visible = value; view.setVisible(value); return state(); }
  async function destroy() {
    if (closed) return; closed = true; visible = false; ++revision;
    removeContextMenu();
    if (!contents.isDestroyed()) { contents.stop(); contents.close({ waitForBeforeUnload: false }); }
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    isolated.protocol.unhandle(SCHEME); isolated.webRequest.onBeforeRequest(null);
    await isolated.clearStorageData(); artifact = null;
  }
  return Object.freeze({ open, state, setBounds, setVisible, destroy });
}
module.exports = { registerArtifactScheme, createArtifactPreview, checkedArtifact, CSP, MAX_HTML_BYTES };
