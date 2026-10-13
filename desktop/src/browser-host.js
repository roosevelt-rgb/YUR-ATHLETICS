'use strict';

// Main-process browser surface only. Nothing here registers IPC or grants agent
// network authority. The packaged operator UI is responsible for invoking it.
const { randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { isLoopback } = require('./foundry-transport');
const { createBrowserControlActions, controlScript } = require('./franklin-browser-actions');
const { installContextMenu } = require('./context-menu');

const MAX_URL_LENGTH = 8192;
const MAX_TEXT_CHARS = 32000;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TEXT_NODES = 5000;
const MAX_RESULT_BYTES = 128 * 1024;
const READ_TIMEOUT_MS = 2000;
const NAVIGATION_TIMEOUT_MS = 30000;

function normalizeBrowserUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f\\]/.test(value)) throw new Error('Enter a complete HTTPS URL or loopback HTTP URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('The browser URL is invalid.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname || (url.protocol === 'http:' && !isLoopback(url.hostname))) throw new Error('Browser navigation requires HTTPS or loopback HTTP, without URL credentials.');
  return url.href;
}

function admittedUrl(value) { try { return normalizeBrowserUrl(value); } catch { return ''; } }
function sameOrigin(value, grantedOrigin) { const url = admittedUrl(value); return Boolean(url && new URL(url).origin === grantedOrigin); }

function requestAllowed(details, grantedOrigin) {
  const safe = admittedUrl(details.url);
  if (!safe || !grantedOrigin) return false;
  const url = new URL(safe);
  if (['mainFrame', 'subFrame'].includes(details.resourceType)) return url.origin === grantedOrigin;
  // A visited public page does not gain access to unrelated local services.
  if (isLoopback(url.hostname) || url.protocol === 'http:') return url.origin === grantedOrigin;
  return true;
}

function clampBounds(value, contentBounds) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'height,width,x,y') throw new Error('Browser bounds require x, y, width and height.');
  for (const entry of Object.values(value)) if (!Number.isSafeInteger(entry) || entry < 0 || entry > 8192) throw new Error('Browser bounds must be nonnegative integer content coordinates.');
  const x = Math.min(value.x, contentBounds.width), y = Math.min(value.y, contentBounds.height);
  return { x, y, width: Math.min(value.width, Math.max(0, contentBounds.width - x)), height: Math.min(value.height, Math.max(0, contentBounds.height - y)) };
}

// Fixed code, executed in its own isolated world. No user/model script is ever
// interpolated. Visible rendered text is acquired; forms and subframes are not.
const READ_VISIBLE_TEXT = `(() => {
  const root = document.body;
  if (!root) return {source_url: location.href, title: document.title, text: '', truncated: false, nodes: 0};
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = []; let characters = 0, nodes = 0, truncated = false, node;
  while ((node = walker.nextNode())) {
    if (++nodes > ${MAX_TEXT_NODES}) { truncated = true; break; }
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,noscript,template,input,textarea,select,option,[contenteditable],[hidden],[aria-hidden="true"]')) continue;
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || !parent.getClientRects().length) continue;
    let hidden = false;
    for (let ancestor = parent.parentElement, depth = 0; ancestor && depth < 100; ancestor = ancestor.parentElement, depth++) {
      const ancestorStyle = getComputedStyle(ancestor);
      if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || ancestorStyle.opacity === '0') { hidden = true; break; }
    }
    if (hidden) continue;
    const room = ${MAX_TEXT_CHARS} - characters;
    const source = node.data;
    const text = source.slice(0, room + 1).replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > room || source.length > room + 1) truncated = true;
    parts.push(text.slice(0, room)); characters += Math.min(text.length, room) + 1;
    if (characters >= ${MAX_TEXT_CHARS}) { truncated = true; break; }
  }
  return {source_url: location.href, title: document.title.slice(0, 512), text: parts.join('\\n').slice(0, ${MAX_TEXT_CHARS}), truncated, nodes};
})()`;

// guard (optional, an edition's path rule): (url, { subFrame }) -> '' to allow, or the reason a
// document address is refused. It applies to every top-level and frame document load, whoever starts
// it (an operator, Franklin, a page link, a redirect, history); subFrame says the load is a frame's.
// Without it the browser behaves exactly as before.
// pageStyle (optional, an edition's page finish): url -> a stylesheet for that page, or ''. When a
// document is ready its stylesheet is inserted as a user style sheet: presentation only, no script.
function createBrowserHost({ window, electron, onEvent = () => {}, navigationTimeoutMs = NAVIGATION_TIMEOUT_MS, readTimeoutMs = READ_TIMEOUT_MS, guard = null, pageStyle = null } = {}) {
  if (!window || typeof window.isDestroyed !== 'function' || !window.contentView || typeof onEvent !== 'function') throw new Error('Browser host requires an existing native window.');
  if (guard !== null && typeof guard !== 'function') throw new Error('The browser path rule must be a function.');
  if (pageStyle !== null && typeof pageStyle !== 'function') throw new Error('The browser page style must be a function.');
  const refused = (value, subFrame = false) => { if (!guard) return ''; try { return String(guard(value, { subFrame: subFrame === true }) || ''); } catch { return 'This address is not opened in the side browser.'; } };
  if (!Number.isSafeInteger(navigationTimeoutMs) || navigationTimeoutMs < 1 || navigationTimeoutMs > NAVIGATION_TIMEOUT_MS || !Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > READ_TIMEOUT_MS) throw new Error('Browser deadlines exceed their bounds.');
  const runtime = electron || require('electron');
  const partition = `yur-browser-${randomUUID()}`;
  const session = runtime.session.fromPartition(partition, { cache: false });
  const view = new runtime.WebContentsView({ webPreferences: {
    session, contextIsolation: true, sandbox: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
    plugins: false, devTools: false, navigateOnDragDrop: false,
    spellcheck: false, disableDialogs: true, enableWebSQL: false,
  } });
  const contents = view.webContents;
  const removeContextMenu = installContextMenu(contents, { electron: runtime, window });
  const documentSelections = new WeakSet();
  let closed = false, visible = false, bounds = { x: 0, y: 0, width: 0, height: 0 };
  let grantedOrigin = '', pendingUrl = '', lastError = '', navigation = null, revision = 0, reading = false;
  const listeners = [], sessionListeners = [];
  const blockedAt = new Map();

  function ensureOpen() { if (closed || contents.isDestroyed() || window.isDestroyed()) throw new Error('The browser view is closed.'); }
  function state() {
    const alive = !closed && !contents.isDestroyed();
    return { url: alive ? admittedUrl(contents.getURL()) : '', title: alive ? contents.getTitle().slice(0, 512) : '',
      loading: alive ? contents.isLoading() : false, canGoBack: alive && contents.navigationHistory.canGoBack(), canGoForward: alive && contents.navigationHistory.canGoForward(),
      visible: alive && visible, bounds: { ...bounds }, granted_origin: grantedOrigin, pending_url: pendingUrl, last_error: lastError, closed: !alive };
  }
  function emit(record) { try { onEvent(record); } catch { /* Closed UI cannot alter browser policy. */ } }
  function update() { emit({ type: 'state', state: state() }); }
  function blocked(reason, value, pending = false) {
    const url = admittedUrl(value);
    if (pending && url) pendingUrl = url;
    const key = `${reason}:${url}`;
    const previous = blockedAt.get(key) || 0;
    if (Date.now() - previous < 500) return;
    if (blockedAt.size >= 100) blockedAt.clear();
    blockedAt.set(key, Date.now());
    emit({ type: 'blocked', reason, url }); update();
  }
  function listen(emitter, name, handler, collection = listeners) { emitter.on(name, handler); collection.push([name, handler]); }
  function finishNavigation(error) { navigation?.finish(error); }

  session.setPermissionRequestHandler((_webContents, permission, callback) => { callback(false); blocked(`permission:${permission}`, ''); });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.allowNTLMCredentialsForDomains('');
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const isDocument = ['mainFrame', 'subFrame'].includes(details.resourceType), refusal = isDocument ? refused(details.url, details.resourceType === 'subFrame') : '';
    const permitted = !closed && !refusal && requestAllowed(details, grantedOrigin);
    callback({ cancel: !permitted });
    if (refusal) blocked(refusal, details.url);
    else if (!permitted) blocked('request-blocked', details.url, details.resourceType === 'mainFrame');
  });
  listen(session, 'will-download', (event, item) => { event.preventDefault(); item.cancel(); blocked('download-blocked', item.getURL()); }, sessionListeners);
  contents.setWindowOpenHandler(details => { blocked('popup-blocked', details.url, true); return { action: 'deny' }; });
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  listen(contents, 'will-attach-webview', event => { event.preventDefault(); blocked('embedded-webview-blocked', ''); });
  listen(contents, 'will-frame-navigate', details => {
    const refusal = refused(details.url, details.isMainFrame === false);
    if (refusal) { details.preventDefault(); blocked(refusal, details.url); }
    else if (!sameOrigin(details.url, grantedOrigin)) { details.preventDefault(); blocked('navigation-requires-approval', details.url, details.isMainFrame); }
  });
  listen(contents, 'will-navigate', (event, url) => {
    const target = event.url || url, refusal = refused(target);
    if (refusal) { event.preventDefault(); blocked(refusal, target); }
    else if (!sameOrigin(target, grantedOrigin)) { event.preventDefault(); blocked('navigation-requires-approval', target, true); }
  });
  listen(contents, 'will-redirect', (event, url, _inPlace, isMainFrame) => {
    const target = event.url || url, refusal = refused(target, (event.isMainFrame ?? isMainFrame) === false);
    if (refusal) { event.preventDefault(); blocked(refusal, target); finishNavigation(new Error(refusal)); }
    else if (!sameOrigin(target, grantedOrigin)) { event.preventDefault(); blocked('redirect-requires-approval', target, event.isMainFrame ?? isMainFrame); finishNavigation(new Error('The redirect requires an explicit navigation to its new origin.')); }
  });
  listen(contents, 'will-prevent-unload', event => event.preventDefault());
  listen(contents, 'login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback(); blocked('authentication-blocked', ''); });
  listen(contents, 'select-client-certificate', (event, _url, _list, callback) => { event.preventDefault(); callback(); blocked('client-certificate-blocked', ''); });
  listen(contents, 'did-start-navigation', (_event, _url, _sameDocument, isMainFrame) => { if (isMainFrame) revision += 1; update(); });
  for (const name of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) listen(contents, name, update);
  listen(contents, 'did-navigate', () => { revision += 1; update(); });
  listen(contents, 'did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) { revision += 1; finishNavigation(); } update(); });
  listen(contents, 'did-finish-load', () => { finishNavigation(); update(); });
  if (pageStyle) listen(contents, 'dom-ready', () => {
    let css = '';
    try { css = String(pageStyle(contents.getURL()) || ''); } catch { css = ''; }
    if (css && !contents.isDestroyed()) void Promise.resolve().then(() => contents.insertCSS(css, { cssOrigin: 'user' })).catch(() => {});
  });
  listen(contents, 'did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { lastError = `Browser load failed (${code}): ${String(description).slice(0, 300)}`; finishNavigation(new Error(lastError)); }
    update();
  });
  listen(contents, 'render-process-gone', () => { lastError = 'The browser renderer stopped. Open the page again to retry.'; revision += 1; finishNavigation(new Error(lastError)); update(); });
  view.setBounds(bounds); view.setVisible(false);
  window.contentView.addChildView(view);

  function load(url, action) {
    ensureOpen();
    const normalized = normalizeBrowserUrl(url), refusal = refused(normalized);
    if (refusal) throw new Error(refusal);
    finishNavigation(new Error('Navigation superseded by a new operator action.'));
    contents.stop();
    grantedOrigin = new URL(normalized).origin; pendingUrl = ''; lastError = ''; revision += 1;
    return new Promise((resolve, reject) => {
      let done = false;
      const operation = { finish(error) {
        if (done) return; done = true; clearTimeout(timer);
        if (navigation === operation) navigation = null;
        if (error) { lastError = error.message; reject(error); } else resolve(state());
        update();
      } };
      const timer = setTimeout(() => { operation.finish(new Error('Browser navigation exceeded 30 seconds.')); contents.stop(); }, navigationTimeoutMs);
      navigation = operation;
      try {
        const promise = action(normalized);
        if (promise && typeof promise.then === 'function') promise.then(() => operation.finish(), error => operation.finish(new Error(`Browser navigation failed: ${error.code || 'LOAD_FAILED'}.`)));
      } catch (error) { operation.finish(error); }
      update();
    });
  }
  function navigate(url) { return load(url, target => contents.loadURL(target)); }
  function history(offset) {
    ensureOpen();
    const entry = contents.navigationHistory.getEntryAtIndex(contents.navigationHistory.getActiveIndex() + offset);
    if (!entry) return Promise.resolve(state());
    return load(entry.url, () => contents.navigationHistory.goToOffset(offset));
  }
  function reload() { ensureOpen(); return load(contents.getURL(), () => contents.reload()); }
  function stop() { ensureOpen(); finishNavigation(new Error('Browser navigation stopped by the operator.')); contents.stop(); update(); return state(); }
  function setBounds(value) { ensureOpen(); bounds = clampBounds(value, window.getContentBounds()); view.setBounds(bounds); update(); return state(); }
  function setVisible(value) { ensureOpen(); if (typeof value !== 'boolean') throw new Error('Browser visibility must be boolean.'); visible = value; view.setVisible(value); update(); return state(); }

  function selectWorkDocument() {
    ensureOpen();
    if (!visible || !bounds.width || !bounds.height) throw new Error('Show the browser page before selecting it for Work.');
    if (contents.isLoading()) throw new Error('Wait for the page to finish loading before selecting it.');
    const sourceUrl = normalizeBrowserUrl(contents.getURL());
    if (!sameOrigin(sourceUrl, grantedOrigin)) throw new Error('The page has no operator navigation grant.');
    const selection = Object.freeze({ source_url: sourceUrl, title: contents.getTitle().slice(0, 512), revision });
    documentSelections.add(selection);
    return selection;
  }
  function validateWorkDocument(selection) {
    ensureOpen();
    if (!selection || !documentSelections.has(selection) || selection.revision !== revision || selection.source_url !== contents.getURL() || contents.isLoading()) throw new Error('The selected browser document changed. Select the current page again.');
  }
  async function readPage(selection = null) {
    ensureOpen();
    if (selection) validateWorkDocument(selection);
    else if (!visible || !bounds.width || !bounds.height) throw new Error('Show the browser page before acquiring its text.');
    if (contents.isLoading() || reading) throw new Error('Wait for the browser page or current acquisition to finish.');
    const sourceUrl = normalizeBrowserUrl(contents.getURL());
    if (!sameOrigin(sourceUrl, grantedOrigin)) throw new Error('The page has no operator navigation grant.');
    const before = revision;
    reading = true;
    let timer;
    try {
      const value = await Promise.race([
        contents.executeJavaScriptInIsolatedWorld(1001, [{ code: READ_VISIBLE_TEXT }], false),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page text acquisition exceeded 2 seconds.')), readTimeoutMs); }),
      ]);
      ensureOpen();
      if (selection) validateWorkDocument(selection);
      if (before !== revision || contents.isLoading() || contents.getURL() !== sourceUrl) throw new Error('The page changed during acquisition. Read the current page again.');
      if (!value || typeof value !== 'object' || value.source_url !== sourceUrl || typeof value.text !== 'string' || value.text.length > MAX_TEXT_CHARS || typeof value.title !== 'string' || typeof value.truncated !== 'boolean') throw new Error('The browser returned invalid page evidence.');
      const bytes = Buffer.from(value.text, 'utf8');
      const text = bytes.length <= MAX_TEXT_BYTES ? value.text : new StringDecoder('utf8').write(bytes.subarray(0, MAX_TEXT_BYTES));
      const result = { schema: 'yur.browser-context.v1', source_url: sourceUrl, title: value.title.slice(0, 512), text,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'), acquired_at: new Date().toISOString(), truncated: value.truncated || bytes.length > MAX_TEXT_BYTES,
        limits: { text_chars: MAX_TEXT_CHARS, text_bytes: MAX_TEXT_BYTES, text_nodes: MAX_TEXT_NODES, main_frame_only: true, form_fields_excluded: true } };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new Error('Page evidence exceeds 128 KiB.');
      return result;
    } finally { clearTimeout(timer); reading = false; }
  }
  const readVisiblePage = () => readPage();
  const readSelectedPage = selection => { validateWorkDocument(selection); return readPage(selection); };
  const controls = createBrowserControlActions({ selectDocument: selectWorkDocument,
    validateDocument(selection) {
      validateWorkDocument(selection);
      if (!visible || !bounds.width || !bounds.height) throw new Error('Show the browser page before inspecting or operating its controls.');
    },
    run: request => contents.executeJavaScriptInIsolatedWorld(1002, [{ code: controlScript(request) }], false),
    timeoutMs: readTimeoutMs,
  });
  async function openExternal() {
    ensureOpen();
    const url = normalizeBrowserUrl(contents.getURL());
    await runtime.shell.openExternal(url);
    return { url };
  }
  async function destroy() {
    if (closed) return;
    closed = true; visible = false; revision += 1;
    removeContextMenu();
    controls.dispose();
    finishNavigation(new Error('Browser view closed.'));
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    for (const [name, listener] of listeners) contents.removeListener(name, listener);
    if (!contents.isDestroyed()) { contents.stop(); contents.close({ waitForBeforeUnload: false }); }
    for (const [name, listener] of sessionListeners) session.removeListener(name, listener);
    await session.clearStorageData();
    await session.clearCache();
    await session.closeAllConnections();
    // The unique session may outlive its view; keep its closed request guard so
    // no delayed worker request acquires network access during or after cleanup.
    update();
  }
  return { navigate, back: () => history(-1), forward: () => history(1), reload, stop, state, setBounds, setVisible, readVisiblePage, selectWorkDocument, readSelectedPage,
    inspectControls: controls.inspectControls, prepareControl: controls.prepareControl, executeControl: controls.executeControl, openExternal, destroy };
}

module.exports = { createBrowserHost, normalizeBrowserUrl, requestAllowed, clampBounds, READ_VISIBLE_TEXT, MAX_TEXT_CHARS, MAX_TEXT_BYTES, MAX_TEXT_NODES, MAX_RESULT_BYTES };
