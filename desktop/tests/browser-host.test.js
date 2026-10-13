'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createBrowserHost, normalizeBrowserUrl, requestAllowed, clampBounds, MAX_TEXT_BYTES } = require('../src/browser-host');

function fixture(options = {}) {
  const events = [], removed = [], external = [], session = new EventEmitter();
  session.webRequest = { onBeforeRequest(_filter, handler) { session.request = handler; } };
  for (const method of ['setPermissionRequestHandler', 'setPermissionCheckHandler', 'setDevicePermissionHandler', 'setDisplayMediaRequestHandler']) session[method] = handler => { session[method] = handler; };
  session.allowNTLMCredentialsForDomains = value => { session.ntlm = value; };
  for (const method of ['clearStorageData', 'clearCache', 'closeAllConnections']) session[method] = async () => removed.push(method);
  const contents = new EventEmitter();
  let url = '', destroyed = false;
  Object.assign(contents, {
    isDestroyed: () => destroyed, getURL: () => url, getTitle: () => 'Page', isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, getActiveIndex: () => 0, getEntryAtIndex: () => null },
    setWindowOpenHandler(handler) { contents.popup = handler; }, setWebRTCIPHandlingPolicy(value) { contents.rtc = value; },
    stop() {}, close() { destroyed = true; },
    loadURL(target) { url = target; return Promise.resolve(); },
    executeJavaScriptInIsolatedWorld: async () => ({ source_url: url, title: 'Page', text: 'Measured answer.', truncated: false }),
  });
  let viewOptions, partition;
  const view = { webContents: contents, setBounds() {}, setVisible() {} };
  const window = { isDestroyed: () => false, getContentBounds: () => ({ width: 900, height: 700 }), contentView: { addChildView() {}, removeChildView() { removed.push('view'); } } };
  const electron = { session: { fromPartition(name, config) { partition = { name, config }; return session; } },
    WebContentsView: function (config) { viewOptions = config; return view; }, shell: { openExternal: async target => external.push(target) } };
  const host = createBrowserHost({ window, electron, onEvent: event => events.push(event), ...options });
  return { host, contents, session, events, removed, external, viewOptions, partition };
}

test('URL admission rejects executable schemes, credentials, remote cleartext and ambiguous syntax', () => {
  for (const url of ['https://example.com/path?q=ok#part', 'http://localhost:1234/', 'http://127.0.0.1:1234/a', 'http://[::1]:1234/']) assert.ok(normalizeBrowserUrl(url));
  for (const url of ['file:///C:/private', 'javascript:alert(1)', 'data:text/html,x', 'https://user:password@example.com/', 'http://example.com/', ' https://example.com/', 'https://example.com/\n', 'https:\\example.com', 'https://example.com/' + 'a'.repeat(8192), null]) assert.throws(() => normalizeBrowserUrl(url));
});

test('origin grants allow ordinary same-origin navigation and public HTTPS assets without opening other local services', () => {
  const origin = 'https://example.com';
  assert.equal(requestAllowed({ url: `${origin}/next`, resourceType: 'mainFrame' }, origin), true);
  assert.equal(requestAllowed({ url: 'https://other.test/next', resourceType: 'mainFrame' }, origin), false);
  assert.equal(requestAllowed({ url: 'https://cdn.example.test/asset.js', resourceType: 'script' }, origin), true);
  for (const url of ['http://127.0.0.1:1234/', 'https://localhost:443/', 'file:///C:/private', 'https://user:password@example.com/']) assert.equal(requestAllowed({ url, resourceType: 'xhr' }, origin), false);
  assert.equal(requestAllowed({ url: `${origin}/frame`, resourceType: 'subFrame' }, origin), true);
  assert.equal(requestAllowed({ url: 'https://other.test/frame', resourceType: 'subFrame' }, origin), false);
  assert.equal(requestAllowed({ url: `${origin}/`, resourceType: 'mainFrame' }, ''), false);
});

test('view bounds remain inside native content and reject invalid renderer payloads', () => {
  assert.deepEqual(clampBounds({ x: 850, y: 690, width: 300, height: 400 }, { width: 900, height: 700 }), { x: 850, y: 690, width: 50, height: 10 });
  for (const value of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1, source: 'page' }]) assert.throws(() => clampBounds(value, { width: 900, height: 700 }));
});

test('remote surface has no preload or Node, rejects permissions/popups and retains a closed network guard', async () => {
  const f = fixture();
  const preferences = f.viewOptions.webPreferences;
  assert.equal(preferences.preload, undefined);
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
  for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag', 'allowRunningInsecureContent', 'devTools']) assert.equal(preferences[key], false);
  assert.equal(f.partition.name.startsWith('persist:'), false); assert.deepEqual(f.partition.config, { cache: false });
  let permission;
  f.session.setPermissionRequestHandler(null, 'media', allowed => { permission = allowed; });
  assert.equal(permission, false); assert.equal(f.session.setPermissionCheckHandler(), false); assert.equal(f.session.setDevicePermissionHandler(), false);
  await f.host.navigate('https://example.com/');
  assert.deepEqual(f.contents.popup({ url: 'https://another.test/' }), { action: 'deny' });
  assert.equal(f.host.state().pending_url, 'https://another.test/');
  await f.host.destroy();
  assert.deepEqual(f.removed, ['view', 'clearStorageData', 'clearCache', 'closeAllConnections']);
  let network;
  f.session.request({ url: 'https://example.com/late', resourceType: 'script' }, result => { network = result; });
  assert.deepEqual(network, { cancel: true });
  assert.throws(() => f.host.setVisible(true), /closed/);
});

test('off-origin redirect is refused while same-origin link navigation keeps the explicit grant', async () => {
  const f = fixture(); await f.host.navigate('https://example.com/start');
  let prevented = false;
  f.contents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.com/next');
  assert.equal(prevented, false);
  f.contents.emit('will-redirect', { preventDefault() { prevented = true; } }, 'https://other.test/', false, true);
  assert.equal(prevented, true); assert.equal(f.host.state().pending_url, 'https://other.test/');
  assert.equal(f.host.state().granted_origin, 'https://example.com');
  await f.host.navigate(f.host.state().pending_url);
  assert.equal(f.host.state().granted_origin, 'https://other.test');
  await f.host.openExternal(); assert.deepEqual(f.external, ['https://other.test/']);
  await f.host.destroy();
});

test('an edition path rule refuses document loads from every start (operator, page link, frame, redirect, request) and nothing else', async () => {
  const refusal = 'Gridiron /api/ addresses are not opened in the side browser.', contexts = [];
  const guard = (url, context) => { contexts.push([url, context]); return /^http:\/\/127\.0\.0\.1:3000\/api(?:\/|$)/i.test(String(url)) ? refusal : ''; };
  assert.throws(() => fixture({ guard: 'not a function' }), /path rule/);
  const f = fixture({ guard });
  // Like any address the browser refuses (normalizeBrowserUrl), the refusal is thrown before a load starts.
  assert.throws(() => f.host.navigate('http://127.0.0.1:3000/api/athletes'), error => error.message === refusal);
  assert.equal(f.host.state().url, '', 'a refused address is never loaded');
  await f.host.navigate('http://127.0.0.1:3000/player/sample');
  assert.equal(f.host.state().granted_origin, 'http://127.0.0.1:3000');
  let prevented = 0;
  const event = () => ({ preventDefault() { prevented++; } });
  f.contents.emit('will-navigate', event(), 'http://127.0.0.1:3000/api/athletes/sample');
  f.contents.emit('will-frame-navigate', { url: 'http://127.0.0.1:3000/api/athletes', isMainFrame: false, preventDefault() { prevented++; } });
  f.contents.emit('will-redirect', event(), 'http://127.0.0.1:3000/api/athletes/sample/drafts', false, true);
  assert.equal(prevented, 3);
  const blocked = f.events.filter(item => item.type === 'blocked');
  assert.equal(blocked.length, 3); assert.ok(blocked.every(item => item.reason === refusal));
  assert.equal(f.host.state().pending_url, '', 'a refused address is never offered as a pending navigation');
  f.contents.emit('will-navigate', event(), 'http://127.0.0.1:3000/coaches');
  assert.equal(prevented, 3, 'other same-origin pages still open');
  const decide = details => new Promise(resolve => f.session.request(details, resolve));
  assert.deepEqual(await decide({ url: 'http://127.0.0.1:3000/api/athletes', resourceType: 'mainFrame' }), { cancel: true });
  assert.deepEqual(await decide({ url: 'http://127.0.0.1:3000/api/athletes', resourceType: 'subFrame' }), { cancel: true });
  // The page's own data requests are not documents: Gridiron's page still reads its API.
  assert.deepEqual(await decide({ url: 'http://127.0.0.1:3000/api/athletes', resourceType: 'xhr' }), { cancel: false });
  assert.deepEqual(await decide({ url: 'http://127.0.0.1:3000/player/sample', resourceType: 'mainFrame' }), { cancel: false });
  // The rule is told which loads are a frame's (it may allow a frame what it refuses at the top level).
  const said = url => contexts.filter(([value]) => value === url).map(([, context]) => context.subFrame);
  assert.deepEqual(said('http://127.0.0.1:3000/api/athletes/sample'), [false], 'a top-level link is not a frame');
  assert.deepEqual(said('http://127.0.0.1:3000/api/athletes/sample/drafts'), [false], 'a top-level redirect is not a frame');
  assert.deepEqual(said('http://127.0.0.1:3000/api/athletes'), [false, true, false, true], 'operator load, frame navigation, top-level and frame requests');
  await f.host.destroy();
  // Without a rule the browser is unchanged: the same address loads.
  const plain = fixture();
  await plain.host.navigate('http://127.0.0.1:3000/api/athletes');
  assert.equal(plain.host.state().url, 'http://127.0.0.1:3000/api/athletes');
  await plain.host.destroy();
});

test('an edition page finish is inserted as a user style sheet when a page it names is ready, and never without one', async () => {
  const sheets = [], settle = () => new Promise(resolve => setImmediate(resolve));
  assert.throws(() => fixture({ pageStyle: 'body {}' }), /page style must be a function/);
  const f = fixture({ pageStyle: url => url.startsWith('http://127.0.0.1:3000/') ? 'body { color: silver }' : '' });
  f.contents.insertCSS = async (css, options) => { sheets.push([css, options]); return 'key'; };
  await f.host.navigate('http://127.0.0.1:3000/player/sample');
  f.contents.emit('dom-ready'); await settle();
  assert.deepEqual(sheets, [['body { color: silver }', { cssOrigin: 'user' }]]);
  await f.host.navigate('https://example.com/');
  f.contents.emit('dom-ready'); await settle();
  assert.equal(sheets.length, 1, 'a page the finish does not name gets nothing');
  await f.host.destroy();
  // A finish that throws inserts nothing, and without a finish the browser never inserts a sheet.
  for (const options of [{ pageStyle: () => { throw new Error('broken finish'); } }, {}]) {
    const other = fixture(options);
    other.contents.insertCSS = async css => sheets.push([css]);
    await other.host.navigate('http://127.0.0.1:3000/');
    other.contents.emit('dom-ready'); await settle();
    await other.host.destroy();
  }
  assert.equal(sheets.length, 1);
});

test('page evidence has fresh source/hash, excludes hidden pane acquisition and bounds multibyte output', async () => {
  const f = fixture(); await f.host.navigate('https://example.com/');
  await assert.rejects(f.host.readVisiblePage(), /Show/);
  f.host.setBounds({ x: 0, y: 0, width: 400, height: 300 }); f.host.setVisible(true);
  let called;
  f.contents.executeJavaScriptInIsolatedWorld = async (world, scripts, gesture) => {
    called = { world, scripts, gesture };
    return { source_url: f.host.state().url, title: 'Page', text: '界'.repeat(30000), truncated: false };
  };
  const result = await f.host.readVisiblePage();
  assert.equal(called.world, 1001); assert.equal(called.gesture, false); assert.equal(called.scripts.length, 1);
  assert.equal(result.schema, 'yur.browser-context.v1'); assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= MAX_TEXT_BYTES); assert.equal(result.text.includes('\uFFFD'), false);
  assert.equal(result.sha256, createHash('sha256').update(result.text).digest('hex'));
  await f.host.destroy();
});

test('page changes and stalled acquisitions fail closed, and navigation Stop rejects its pending promise', async () => {
  const f = fixture({ readTimeoutMs: 10, navigationTimeoutMs: 30 }); await f.host.navigate('https://example.com/');
  f.host.setBounds({ x: 0, y: 0, width: 400, height: 300 }); f.host.setVisible(true);
  f.contents.executeJavaScriptInIsolatedWorld = async () => {
    f.contents.emit('did-navigate');
    return { source_url: 'https://example.com/', title: 'Page', text: 'stale', truncated: false };
  };
  await assert.rejects(f.host.readVisiblePage(), /changed/);
  f.contents.executeJavaScriptInIsolatedWorld = () => new Promise(() => {});
  await assert.rejects(f.host.readVisiblePage(), /exceeded/);
  f.contents.loadURL = () => new Promise(() => {});
  const pending = f.host.navigate('https://example.com/slow');
  f.host.stop(); await assert.rejects(pending, /stopped/);
  await f.host.destroy();
});

test('private Work document selection permits hidden fixed extraction but rejects forged and same-URL replacement tokens', async () => {
  const f = fixture(); await f.host.navigate('https://example.com/');
  assert.throws(() => f.host.selectWorkDocument(), /Show/);
  f.host.setBounds({ x: 0, y: 0, width: 400, height: 300 }); f.host.setVisible(true);
  const selection = f.host.selectWorkDocument();
  assert.equal(Object.isFrozen(selection), true);
  f.host.setVisible(false);
  await assert.rejects(f.host.readVisiblePage(), /Show/);
  assert.equal((await f.host.readSelectedPage(selection)).text, 'Measured answer.');
  assert.throws(() => f.host.readSelectedPage({ ...selection }), /changed/);
  f.contents.emit('did-start-navigation', {}, 'https://example.com/', false, true);
  assert.throws(() => f.host.readSelectedPage(selection), /changed/);
  await f.host.destroy();
});

test('Work document extraction detects same-document navigation during acquisition and never accepts another view token', async () => {
  const a = fixture(), b = fixture();
  for (const f of [a, b]) { await f.host.navigate('https://example.com/'); f.host.setBounds({ x: 0, y: 0, width: 400, height: 300 }); f.host.setVisible(true); }
  const selection = a.host.selectWorkDocument();
  assert.throws(() => b.host.readSelectedPage(selection), /changed/);
  a.contents.executeJavaScriptInIsolatedWorld = async () => { a.contents.emit('did-navigate-in-page', {}, 'https://example.com/', true); return { source_url: 'https://example.com/', title: 'Page', text: 'stale', truncated: false }; };
  await assert.rejects(a.host.readSelectedPage(selection), /changed/);
  await a.host.destroy(); await b.host.destroy();
});
