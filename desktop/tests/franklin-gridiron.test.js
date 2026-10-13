'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const edition = require('../src/edition');
const { createFranklinExecution } = require('../src/franklin-execution');
const { createFranklinGridiron, gridironEnabled, checkOwners, childEnvironment, GRIDIRON_ACTIONS, READ_TOOLS, WRITE_TOOLS, GRIDIRON_TOOLS, CHILD_ENVIRONMENT,
  WINDOWS_OWNERS } = require('../src/franklin-gridiron');

// Every server here is tests/fixtures/gridiron-mcp-fake.cjs over stdio; no Gridiron, Mongo,
// network, browser or Electron is started.
const root = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'gridiron-mcp-fake.cjs');
// The athlete manifest (editions/athletics.json) is each owner's own file and is never committed. These tests read
// the committed sample, tests/fixtures/athletics.sample.json, from a temporary editions folder.
const sampleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-edition-sample-'));
fs.copyFileSync(path.join(__dirname, 'fixtures', 'athletics.sample.json'), path.join(sampleRoot, 'athletics.json'));
after(() => fs.rmSync(sampleRoot, { recursive: true, force: true }));
const shipped = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot, log: () => {} });
const ATHLETE = shipped.athlete.id, ORIGIN = shipped.gridiron.origin;
// The athlete comes from the manifest; these tests ship in the edition and name no athlete themselves.
const embedded = href => { const url = new URL(href); const [name, value] = shipped.gridiron.embed_param.split('='); url.searchParams.set(name, value); return url.href; };
const DRAFT = { athlete_id: ATHLETE, school: 'Fixture University', to: 'coach@fixture.example', subject: 'Fixture season film',
  body: 'Coach, here is my updated season film and stat line for your review.' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A failed per-test cleanup must not leave a child process keeping this file alive.
const liveServices = new Set();
after(() => { for (const service of liveServices) service.dispose(); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function waitFor(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (check()) return true;
  return check();
}
function fixture(t, { mode = 'normal', confirm = async () => true, denied = '', server, spawnProcess = spawn, checkOwner, ...options } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-gridiron-')), log = path.join(folder, 'calls.jsonl'), pid = path.join(folder, 'server.pid');
  const config = path.join(folder, 'mcp_servers.json'), pinned = [FAKE, mode, log, pid];
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { 'gridiron-scout': server ?? { command: process.execPath, args: pinned, enabled: true, timeout: 180 } } }));
  // The edition pins the same command and args as the config's server entry.
  const manifest = edition.deepFreeze({ ...JSON.parse(JSON.stringify(shipped)), gridiron_mcp: { config_path: config, server: 'gridiron-scout', command: process.execPath, args: pinned } });
  const pages = [], policies = [], confirmations = [], children = [], owned = [];
  const service = createFranklinGridiron({ edition: manifest, getSettings: () => ({ fixture: true }),
    deny: (...args) => { policies.push(args); return typeof denied === 'function' ? denied() : denied; },
    openPage: async (url, identity) => { pages.push({ url, identity }); return { url, title: 'Gridiron Scout', loading: false, bounds: { x: 1 }, granted_origin: ORIGIN }; },
    checkOwner: checkOwner ?? (async files => { owned.push(files); }),
    spawnProcess: (...args) => { const child = spawnProcess(...args); children.push(child); return child; }, ...options });
  liveServices.add(service);
  const grandchild = () => fs.existsSync(pid + '.grandchild') ? Number(fs.readFileSync(pid + '.grandchild', 'utf8')) : null;
  // The child runs in this folder; Windows releases it only after the child's exit event.
  t.after(async () => {
    service.dispose();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), sleep(5000)]);
    // A grandchild a failed assertion left behind is ended here as well.
    const orphan = grandchild();
    if (orphan && alive(orphan)) { try { process.kill(orphan); } catch { /* Already gone. */ } await waitFor(() => !alive(orphan)); }
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  // The same composition main.js uses: the default services keep their actions, Gridiron adds two.
  const services = edition.composeDesktopServices({ accepts: () => false, isReadOnly: () => assert.fail('base owns no Gridiron action'), catalog: () => [],
    validate: () => assert.fail('base validates nothing here'), confirmationRequirements: () => ({}), execute: async () => assert.fail('base executes nothing here') }, service);
  const broker = createFranklinExecution({ services, deny: () => '', getSettings: () => ({}),
    confirm: async (request, identity) => { confirmations.push(request); return confirm(request, identity); } });
  let active = true, sequence = 0;
  const owner = { isDestroyed: () => false };
  const identity = (extra = {}) => ({ owner, request_id: randomUUID(), mission_id: 'a'.repeat(32), action_id: (++sequence).toString(16).padStart(32, '0'), isActive: () => active, ...extra });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const toolCalls = () => calls().filter(message => message.method === 'tools/call');
  const call = (tool, args = {}, id = identity()) => broker.execute('gridiron_call', { tool, arguments: args }, id);
  return { service, broker, identity, call, calls, toolCalls, pages, policies, confirmations, owned, folder, log, pid, grandchild, cancel: () => { active = false; } };
}

test('Gridiron offers two actions with a hard tool allowlist and constructs without starting anything', () => {
  assert.deepEqual(GRIDIRON_ACTIONS, ['gridiron_tools', 'gridiron_call']);
  assert.deepEqual(READ_TOOLS, ['scout_athlete', 'scout_board', 'scout_program', 'scout_coaches', 'scout_outreach_log', 'scout_film_notes',
    'scout_drafts', 'maxpreps_check', 'scout_season_study', 'scout_card', 'scout_highlights']);
  assert.deepEqual(WRITE_TOOLS, ['maxpreps_sync_now', 'draft_save', 'content_save', 'package_rebuild']);
  assert.deepEqual(GRIDIRON_TOOLS, [...READ_TOOLS, ...WRITE_TOOLS, 'show_page']);
  for (const name of ['email_send', 'page_publish', 'web_search', 'browser_open', 'browser_read', 'browser_act']) assert.equal(GRIDIRON_TOOLS.includes(name), false, name);
  assert.deepEqual([{}, { YUR_EDITION: '' }, { YUR_EDITION: 'Athletics' }, { YUR_EDITION: 'athletics' }].map(env => gridironEnabled(env)), [false, false, false, true]);
  const missing = path.join(os.tmpdir(), 'yur-gridiron-never-read', 'mcp_servers.json');
  const service = createFranklinGridiron({ edition: { ...shipped, gridiron_mcp: { ...shipped.gridiron_mcp, config_path: missing } },
    deny: () => assert.fail('no policy check at construction'), getSettings: () => ({}), openPage: async () => assert.fail('no page at construction'),
    spawnProcess: () => assert.fail('constructing spawns nothing'), checkOwner: () => assert.fail('constructing reads no owner') });
  assert.equal(service.catalog()[0].status, 'configured');
  assert.deepEqual(service.catalog()[0].requires_confirmation, WRITE_TOOLS);
  assert.deepEqual(['gridiron_tools', 'gridiron_call', 'unreal_camera', 'music_generate'].map(service.accepts), [true, true, false, false]);
  assert.equal(service.isReadOnly('gridiron_tools', {}), true);
  for (const tool of [...READ_TOOLS, 'show_page']) assert.equal(service.isReadOnly('gridiron_call', { tool, arguments: {} }), true, tool);
  for (const payload of [...WRITE_TOOLS.map(tool => ({ tool, arguments: {} })), { tool: 'email_send', arguments: {} }, null, [], 'scout_card'])
    assert.equal(service.isReadOnly('gridiron_call', payload), false);
  assert.deepEqual(service.confirmationRequirements('gridiron_call', { tool: 'scout_card', arguments: {} }), { required: false });
  service.dispose(); service.dispose();
  assert.equal(service.catalog()[0].status, 'stopped');
  const unpinned = { config_path: shipped.gridiron_mcp.config_path, server: shipped.gridiron_mcp.server };
  for (const options of [{}, { edition: shipped }, { edition: shipped, deny() {}, getSettings() {} },
    { edition: { ...shipped, gridiron: { ...shipped.gridiron, origin: 'http://localhost:3000' } }, deny() {}, getSettings() {}, openPage() {} },
    { edition: { ...shipped, gridiron_mcp: unpinned }, deny() {}, getSettings() {}, openPage() {} },
    { edition: { ...shipped, gridiron_mcp: { ...unpinned, command: 'python.exe', args: [] } }, deny() {}, getSettings() {}, openPage() {} },
    { edition: shipped, deny() {}, getSettings() {}, openPage() {}, callTimeoutMs: 10 },
    { edition: shipped, deny() {}, getSettings() {}, openPage() {}, rebuildTimeoutMs: 600001 }])
    assert.throws(() => createFranklinGridiron(options), /Gridiron/);
});

test('the default Desktop never loads Gridiron; YUR_EDITION=athletics appends its two actions to the host', () => {
  const script = `const { createFranklinHost, ACTIONS } = require('./src/franklin-host');
const owner = { isDestroyed: () => false, send() {} }, routed = [];
const host = createFranklinHost({ getWindow: () => ({ isDestroyed: () => false, webContents: owner }), getBrowser: () => null, getSettings: () => ({}),
  deny: () => '', getRuntime: () => ({}), getActivity: () => ({}), execution: { execute: async action => { routed.push(action); return { routed: true }; } } });
const identity = { owner, request_id: '12345678-1234-4234-8234-123456789abc', mission_id: 'a'.repeat(32), action_id: 'b'.repeat(32), isActive: () => true };
host.execute('gridiron_call', { tool: 'scout_card', arguments: {} }, identity).then(result => ({ result }), error => ({ error: error.message }))
  .then(outcome => process.stdout.write(JSON.stringify({ actions: ACTIONS, routed, outcome, loaded: Object.keys(require.cache).some(name => /franklin-gridiron\\.js$/.test(name)) })));`;
  const run = extra => {
    const env = { ...process.env, ...extra };
    if (!('YUR_EDITION' in extra)) delete env.YUR_EDITION;
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', windowsHide: true }));
  };
  const desktop = run({}), unknown = run({ YUR_EDITION: 'unknown-edition' }), athletics = run({ YUR_EDITION: 'athletics' });
  for (const result of [desktop, unknown]) {
    assert.equal(result.loaded, false);
    assert.equal(result.actions.some(action => action.startsWith('gridiron_')), false);
    assert.deepEqual(result.routed, []);
    assert.match(result.outcome.error, /Unsupported desktop operation/);
  }
  assert.deepEqual(athletics.actions, [...desktop.actions, ...GRIDIRON_ACTIONS]);
  assert.equal(athletics.loaded, false, 'the host lists the actions without loading the service module');
  assert.deepEqual(athletics.routed, ['gridiron_call']);
  assert.equal(athletics.outcome.result.routed, true);
});

test('without franklin-gridiron.js the Athletics host still lists the Gridiron actions and answers them as not connected', () => {
  // A partial install must not stop the app: the host's authority list stays equal to Python's
  // (which also lists the actions) and only the Gridiron calls fail.
  const script = `const Module = require('node:module'), resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (/franklin-gridiron(?:\\.js)?$/.test(request)) throw Object.assign(new Error('Cannot find module ' + request), { code: 'MODULE_NOT_FOUND' });
  return resolve.call(this, request, ...rest);
};
const { createFranklinHost, ACTIONS } = require('./src/franklin-host');
const { createFranklinExecution } = require('./src/franklin-execution');
const edition = require('./src/edition');
const service = edition.loadGridironService(edition.loadEdition({ env: process.env, root: ${JSON.stringify(sampleRoot)}, log: () => {} }), {}, { log: () => {}, exists: () => false });
const execution = createFranklinExecution({ services: edition.composeDesktopServices({ accepts: () => false, isReadOnly: () => false, catalog: () => [],
  validate() {}, confirmationRequirements: () => ({}), execute: async () => ({}) }, service), deny: () => '', getSettings: () => ({}), confirm: async () => false });
const owner = { isDestroyed: () => false, send() {} };
const host = createFranklinHost({ getWindow: () => ({ isDestroyed: () => false, webContents: owner }), getBrowser: () => null, getSettings: () => ({}),
  deny: () => '', getRuntime: () => ({}), getActivity: () => ({}), execution });
const identity = { owner, request_id: '12345678-1234-4234-8234-123456789abc', mission_id: 'a'.repeat(32), action_id: 'b'.repeat(32), isActive: () => true };
host.execute('gridiron_call', { tool: 'scout_card', arguments: {} }, identity).then(result => ({ result }), error => ({ error: error.message }))
  .then(outcome => process.stdout.write(JSON.stringify({ actions: ACTIONS.slice(-2), service, outcome,
    loaded: Object.keys(require.cache).some(name => /franklin-gridiron\\.js$/.test(name)) })));`;
  const env = { ...process.env, YUR_EDITION: 'athletics' };
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(result.actions, GRIDIRON_ACTIONS);
  assert.equal(result.service, null);
  assert.equal(result.loaded, false);
  assert.match(result.outcome.error, /not connected/);
});

test('the edition loader hands main.js the real service with the Franklin service interface', () => {
  const service = edition.loadGridironService(shipped, { deny: () => null, getSettings: () => ({}), openPage: async () => ({}) });
  for (const method of edition.SERVICE_METHODS) assert.equal(typeof service[method], 'function', method);
  assert.equal(service.catalog()[0].status, 'configured');
  service.dispose();
});

test('read tools run without a dialog through one reused child process', async t => {
  const f = fixture(t);
  const notes = await f.call('scout_film_notes', { athlete_id: ATHLETE });
  assert.equal(notes.kind, 'read'); assert.equal(notes.tool, 'scout_film_notes');
  assert.deepEqual(notes.result, { tool: 'scout_film_notes', arguments: { athlete_id: ATHLETE }, rows: [{ season: 2026 }] });
  assert.match(notes.schema_sha256, /^[a-f0-9]{64}$/);
  assert.equal(notes.confirmation.required, false);
  const listed = await f.broker.execute('gridiron_tools', {}, f.identity());
  assert.deepEqual(listed.tools.map(tool => tool.name), [...READ_TOOLS, ...WRITE_TOOLS]);
  assert.deepEqual(listed.tools.filter(tool => tool.requires_confirmation).map(tool => tool.name), WRITE_TOOLS);
  for (const tool of listed.tools) assert.match(tool.schema_sha256, /^[a-f0-9]{64}$/);
  assert.equal(listed.tools.find(tool => tool.name === 'scout_film_notes').schema_sha256, notes.schema_sha256);
  assert.deepEqual(listed.local.map(tool => tool.name), ['show_page']);
  assert.deepEqual(listed.local[0].input_schema.properties.tab.enum, shipped.tabs.filter(tab => tab.kind === 'gridiron').map(tab => tab.id));
  assert.deepEqual(listed.unavailable, []);
  assert.equal(JSON.stringify(listed).includes('email_send'), false);
  assert.match(listed.notice, /maxpreps_check also fetches the MaxPreps page stored on the athlete card/);
  assert.match(listed.notice, /run one at a time/);
  // The config, the pinned interpreter and its script were owner-checked before the one start.
  assert.deepEqual(f.owned, [[path.join(f.folder, 'mcp_servers.json'), process.execPath, FAKE]]);
  const highlights = await f.call('scout_highlights', { athlete_id: ATHLETE, limit: 5 });
  assert.deepEqual([highlights.format, highlights.text], ['text', 'reel order ... [truncated]']);
  assert.equal(f.confirmations.length, 0);
  const messages = f.calls();
  assert.equal(messages.filter(message => message.method === 'initialize').length, 1);
  assert.equal(messages[0].method, 'initialize'); assert.equal(messages[0].params.protocolVersion, '2025-11-25');
  assert.equal(messages[1].method, 'notifications/initialized'); assert.equal(messages[2].method, 'tools/list');
  assert.deepEqual(f.toolCalls().map(message => message.params.name), ['scout_film_notes', 'scout_highlights']);
  assert.equal(f.service.catalog()[0].status, 'connected');
  assert.ok(f.policies.every(([channel]) => channel === 'franklin:gridiron'));
});

test('write tools need the native confirmation and a declined dialog writes nothing', async t => {
  let approve = false;
  const f = fixture(t, { confirm: async () => approve });
  const declined = await f.call('draft_save', DRAFT);
  assert.deepEqual([declined.status, declined.executed], ['rejected', false]);
  const [review] = f.confirmations;
  assert.equal(review.action, 'gridiron_call');
  assert.deepEqual(review.payload, { tool: 'draft_save', arguments: DRAFT });
  assert.equal(review.review.required, true); assert.equal(review.review.tool, 'draft_save'); assert.equal(review.review.athlete_id, ATHLETE);
  assert.match(review.review.effect, /Nothing is sent/); assert.match(review.review.schema_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.toolCalls(), []);
  for (const tool of ['maxpreps_sync_now', 'content_save', 'package_rebuild'])
    assert.equal((await f.call(tool, tool === 'content_save' ? { athlete_id: ATHLETE, kind: 'bio', title: 'Bio', body: 'Fixture bio text.' } : { athlete_id: ATHLETE })).executed, false);
  assert.deepEqual(f.confirmations.map(item => item.payload.tool), ['draft_save', 'maxpreps_sync_now', 'content_save', 'package_rebuild']);
  assert.deepEqual(f.toolCalls(), []);
  approve = true;
  const saved = await f.call('draft_save', DRAFT);
  assert.deepEqual([saved.kind, saved.executed, saved.confirmation.approved], ['write', true, true]);
  assert.deepEqual(saved.result, { saved: true, status: 'draft', sent: false });
  assert.match(saved.notice, /Nothing is sent/);
  assert.deepEqual(f.toolCalls().map(message => [message.params.name, message.params.arguments]), [['draft_save', DRAFT]]);
  // The service never writes without the host's confirmation, and an approval runs once.
  const id = f.identity(), payload = { tool: 'draft_save', arguments: DRAFT };
  await assert.rejects(f.service.execute('gridiron_call', payload, id, {}), /fresh native human confirmation/);
  await f.service.validate('gridiron_call', payload, id);
  await assert.rejects(f.service.execute('gridiron_call', payload, id, { confirmed: false }), /fresh native human confirmation/);
  await assert.rejects(f.service.execute('gridiron_call', { ...payload, arguments: { ...DRAFT, subject: 'Changed after review' } }, id, { confirmed: true }), /scope changed/);
  assert.equal((await f.service.execute('gridiron_call', payload, id, { confirmed: true })).executed, true);
  await assert.rejects(f.service.execute('gridiron_call', payload, id, { confirmed: true }), /fresh native human confirmation/);
  assert.equal(f.toolCalls().length, 2);
});

test('tools outside the allowlist, malformed arguments and other athletes never reach the server', async t => {
  const f = fixture(t);
  for (const tool of ['email_send', 'page_publish', 'web_search', 'browser_open', 'browser_act', 'shell', '__proto__', 'SCOUT_CARD', 7])
    await assert.rejects(f.call(tool, { athlete_id: ATHLETE }), /admitted Gridiron tool/, String(tool));
  for (const payload of [{ tool: 'scout_card' }, { tool: 'scout_card', arguments: {}, extra: true }, { tool: 'scout_card', arguments: [] }])
    await assert.rejects(f.broker.execute('gridiron_call', payload, f.identity()), /exact typed fields|object/);
  await assert.rejects(f.broker.execute('gridiron_tools', { tool: 'scout_card' }, f.identity()), /exact typed fields/);
  await assert.rejects(f.call('scout_card', { athlete_id: 'another-athlete' }), /only with its own athlete/);
  await assert.rejects(f.call('scout_card', {}), /athlete_id \(required\)/);
  await assert.rejects(f.call('scout_card', { athlete_id: ATHLETE, extra: 1 }), /scout_card takes/);
  for (const limit of [0, 201, 'five', 2.5, true]) await assert.rejects(f.call('scout_board', { athlete_id: ATHLETE, limit }), /outside its schema/);
  await assert.rejects(f.call('scout_program', { name: 'x' }), /outside its schema/);
  await assert.rejects(f.call('scout_athlete', { athlete_id: ATHLETE, brief: 'yes' }), /outside its schema/);
  await assert.rejects(f.call('scout_coaches', { query: 'x'.repeat(20001) }), /outside its schema/);
  await assert.rejects(f.call('scout_coaches', { query: 'x'.repeat(33000) }), /32 KiB/);
  await assert.rejects(f.call('draft_save', { ...DRAFT, body: 'too short' }), /outside its schema/);
  await assert.rejects(f.call('draft_save', { ...DRAFT, bcc: 'someone@fixture.example' }), /draft_save takes/);
  assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.toolCalls(), []);
});

test('show_page is answered locally: sections map to their paths and bad tabs or paths are refused', async t => {
  const f = fixture(t);
  for (const tab of shipped.tabs.filter(item => item.kind === 'gridiron')) {
    const shown = await f.call('show_page', { tab: tab.id });
    // The checked canonical path is reported; the side browser opens Gridiron's embed view of it, as the left nav does.
    assert.equal(shown.url, ORIGIN + tab.path); assert.equal(f.pages.at(-1).url, embedded(ORIGIN + tab.path));
    assert.deepEqual([shown.kind, shown.shown, shown.tab, shown.label, shown.confirmation.required], ['page', true, tab.id, tab.label, false]);
    // Gridiron serves every ?tab= section (gridiron-scout 5b61394): no pending-route fallback.
    assert.equal('route_status' in shown, false);
    assert.equal(shown.notice, 'The page is open in the side browser; use browser_read to read it.');
    assert.deepEqual(shown.browser, { url: embedded(ORIGIN + tab.path), title: 'Gridiron Scout', loading: false });
  }
  assert.equal(f.pages[1].url, embedded(`${ORIGIN}/player/${ATHLETE}?tab=film`));
  assert.match(f.pages[0].identity.action_id, /^[a-f0-9]{32}$/);
  // An optional path opens another section or the athlete's own card with a ?tab= name, nothing else.
  assert.equal((await f.call('show_page', { tab: 'film-study', path: `/player/${ATHLETE}?tab=film` })).url, `${ORIGIN}/player/${ATHLETE}?tab=film`);
  assert.equal((await f.call('show_page', { tab: 'my-card', path: `/player/${ATHLETE}?tab=season-study` })).url, `${ORIGIN}/player/${ATHLETE}?tab=season-study`);
  assert.equal((await f.call('show_page', { tab: 'my-card', path: '/coaches' })).url, ORIGIN + '/coaches');
  const shown = f.pages.length;
  // Gridiron's /api/ routes return whole records (family contacts) without a login, and other
  // athletes' pages are not this edition's: neither is opened, with no dialog either way.
  for (const value of ['/api/athletes', '/api/athletes/other-athlete/drafts', `/api/athletes/${ATHLETE}`, '/API/athletes', '/api', '/api?x=1',
    '/player/other-athlete?tab=film', '/player/other-athlete', `/player/${ATHLETE}?tab=film&x=1`, `/player/${ATHLETE}/`, `/player/${ATHLETE}?tab=Film`,
    `/Player/${ATHLETE}`, '/coaches?division=fbs', '/admin'])
    await assert.rejects(f.call('show_page', { tab: 'my-card', path: value }), /section paths or \/player\//, value);
  assert.equal(f.pages.length, shown, 'a refused path never reaches the side browser');
  for (const tab of ['franklin', 'approvals', 'settings']) await assert.rejects(f.call('show_page', { tab }), /desktop section/);
  for (const tab of ['evil', '', 'MY-CARD', 5, null]) await assert.rejects(f.call('show_page', { tab }), /Gridiron sections/);
  for (const value of ['//evil.example/x', 'http://evil.example/', 'https://127.0.0.1:3000/x', '/a/../b', '/a/%2e%2e/b', '/x\\y', '/x#frag', '/a b',
    'player', '', '/x\n', '/' + 'x'.repeat(600), 5]) await assert.rejects(f.call('show_page', { tab: 'my-card', path: value }), /canonical path/, String(value));
  await assert.rejects(f.call('show_page', { tab: 'my-card', note: 'extra' }), /exact typed fields/);
  assert.equal(f.confirmations.length, 0);
  assert.equal(fs.existsSync(f.pid), false, 'show_page never starts the MCP server');
  assert.deepEqual(f.calls(), []);
});

test('a schema changed after review is refused before anything is written', async t => {
  const f = fixture(t, { mode: 'drift' });
  await assert.rejects(f.call('draft_save', DRAFT), /changed its schema/);
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.calls().filter(message => message.method === 'tools/list').length, 2);
  assert.deepEqual(f.toolCalls(), []);
  await assert.rejects(f.call('draft_save', DRAFT), /changed its schema/);
  assert.equal(f.confirmations.length, 1, 'a known-changed tool is refused before the dialog');
  assert.equal((await f.call('scout_card', { athlete_id: ATHLETE })).kind, 'read');
  assert.deepEqual(f.toolCalls().map(message => message.params.name), ['scout_card']);
});

test('a tool catalog change notice refuses changed read tools until restart', async t => {
  const f = fixture(t, { mode: 'notify-drift' });
  assert.equal((await f.call('scout_card', { athlete_id: ATHLETE })).kind, 'read');
  await assert.rejects(f.call('scout_card', { athlete_id: ATHLETE }), /changed its schema/);
  assert.equal((await f.call('scout_film_notes', { athlete_id: ATHLETE })).kind, 'read');
  assert.deepEqual((await f.broker.execute('gridiron_tools', {}, f.identity())).unavailable, ['scout_card']);
  assert.deepEqual(f.toolCalls().map(message => message.params.name), ['scout_card', 'scout_film_notes']);
});

test('tools the server does not offer or describes loosely are reported unavailable', async t => {
  const f = fixture(t, { mode: 'partial' });
  await assert.rejects(f.call('scout_drafts', { athlete_id: ATHLETE }), /does not offer scout_drafts/);
  assert.deepEqual((await f.broker.execute('gridiron_tools', {}, f.identity())).unavailable, ['scout_drafts']);
  const loose = fixture(t, { mode: 'loose' });
  await assert.rejects(loose.call('scout_coaches', { query: 'quarterbacks' }), /does not admit/);
  assert.deepEqual(loose.toolCalls(), []);
});

test('timeouts, cancellations, dying servers, errors and oversized replies fail closed', async t => {
  const hang = fixture(t, { mode: 'hang', callTimeoutMs: 300 });
  await assert.rejects(hang.call('scout_card', { athlete_id: ATHLETE }), /did not answer in time/);
  assert.ok(await waitFor(() => hang.calls().some(message => message.method === 'notifications/cancelled' && Number.isSafeInteger(message.params.requestId))));
  const server = Number(fs.readFileSync(hang.pid, 'utf8'));
  assert.equal(alive(server), true, 'a read that timed out leaves the server running');
  await assert.rejects(hang.call('draft_save', DRAFT), error => error.code === 'GRIDIRON_OUTCOME_UNCERTAIN' && /uncertain/.test(error.message) && /stopped/.test(error.message));
  assert.ok(await waitFor(() => !alive(server)), 'an uncertain write stops the server');
  const slow = fixture(t, { mode: 'hang', callTimeoutMs: 60000 });
  let active = true;
  setTimeout(() => { active = false; }, 200);
  const started = Date.now();
  await assert.rejects(slow.call('scout_card', { athlete_id: ATHLETE }, slow.identity({ isActive: () => active })), /no longer active|cancelled/);
  assert.ok(Date.now() - started < 5000);
  const dying = fixture(t, { mode: 'exit-on-call' });
  await assert.rejects(dying.call('draft_save', DRAFT), error => error.code === 'GRIDIRON_OUTCOME_UNCERTAIN');
  await assert.rejects(dying.call('scout_card', { athlete_id: ATHLETE }), /stopped/);
  await assert.rejects(dying.call('scout_card', { athlete_id: ATHLETE }), /stopped/);
  await assert.rejects(dying.call('scout_card', { athlete_id: ATHLETE }), /stopped repeatedly/);
  assert.equal(dying.calls().filter(message => message.method === 'initialize').length, 3, 'restarts are bounded per app run');
  const failing = fixture(t, { mode: 'error' });
  await assert.rejects(failing.call('scout_card', { athlete_id: ATHLETE }), error => error.code === 'GRIDIRON_TOOL_ERROR' && /athlete not found/.test(error.message));
  await assert.rejects(failing.call('draft_save', DRAFT), error => error.code === 'GRIDIRON_TOOL_ERROR');
  const old = fixture(t, { mode: 'old-protocol' });
  await assert.rejects(old.call('scout_card', { athlete_id: ATHLETE }), /protocol negotiation/);
  assert.ok(await waitFor(() => !alive(Number(fs.readFileSync(old.pid, 'utf8')))), 'a failed negotiation kills the child');
  const huge = fixture(t, { mode: 'huge' });
  await assert.rejects(huge.call('scout_card', { athlete_id: ATHLETE }), /oversized/);
  assert.ok(await waitFor(() => !alive(Number(fs.readFileSync(huge.pid, 'utf8')))));
});

test('server requests get a minimal answer and server notices grant nothing', async t => {
  const f = fixture(t, { mode: 'noisy' });
  assert.equal((await f.call('scout_card', { athlete_id: ATHLETE })).kind, 'read');
  assert.ok(await waitFor(() => f.calls().some(message => message.id === 'server-sample')));
  const replies = f.calls().filter(message => typeof message.id === 'string');
  assert.deepEqual(replies.find(message => message.id === 'server-ping'), { jsonrpc: '2.0', id: 'server-ping', result: {} });
  assert.equal(replies.find(message => message.id === 'server-sample').error.code, -32601);
});

test('the edition pins the process; the config must match it and the child gets an allowlisted environment and no shell', async t => {
  const spawned = [];
  // The desktop's environment can hold model endpoints, tokens and keys; none of them reach Gridiron.
  const injected = { PYTHONPATH: 'injected-path', PYTHONHOME: 'injected-home', YUR_FRANKLIN_MUSIC_TOKEN: 'fixture-token', OPENAI_API_KEY: 'fixture-key',
    YUR_FRANKLIN_OPENAI_URL: 'http://127.0.0.1:9/v1', YUR_FRANKLIN_RUNPOD_API_KEY: 'fixture-runpod', GRIDIRON_SMTP_PASSWORD: 'fixture-password',
    MONGO_URL: 'mongodb://127.0.0.1:27017', MONGO_DB: 'gridiron-fixture' };
  const previous = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  Object.assign(process.env, injected);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const f = fixture(t, { spawnProcess: (command, args, options) => { spawned.push({ command, args, options }); return spawn(command, args, options); } });
  await f.call('scout_card', { athlete_id: ATHLETE });
  assert.equal(spawned.length, 1);
  const [{ command, args, options }] = spawned;
  assert.deepEqual([command, args[0], args[1]], [process.execPath, FAKE, 'normal']);
  assert.deepEqual([options.shell, options.windowsHide, options.cwd], [false, true, f.folder]);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  const allowed = new Set([...CHILD_ENVIRONMENT, 'PYTHONUTF8', 'PYTHONIOENCODING'].map(name => name.toUpperCase()));
  assert.deepEqual(Object.keys(options.env).filter(name => !allowed.has(name.toUpperCase())), []);
  assert.deepEqual([options.env.PYTHONUTF8, options.env.PYTHONIOENCODING, options.env.MONGO_URL, options.env.MONGO_DB], ['1', 'utf-8', injected.MONGO_URL, injected.MONGO_DB]);
  for (const name of ['PYTHONPATH', 'PYTHONHOME', 'YUR_FRANKLIN_MUSIC_TOKEN', 'OPENAI_API_KEY', 'YUR_FRANKLIN_OPENAI_URL', 'YUR_FRANKLIN_RUNPOD_API_KEY', 'GRIDIRON_SMTP_PASSWORD'])
    assert.equal(name in options.env, false, name);
  const root = Object.keys(process.env).find(name => name.toUpperCase() === 'SYSTEMROOT');
  if (root) assert.equal(options.env[root], process.env[root], 'Windows basics keep their own spelling');
  assert.deepEqual(childEnvironment({ Path: 'C:\\bin', systemroot: 'C:\\Windows', SECRET_TOKEN: 'x', MONGO_URL: 7 }),
    { Path: 'C:\\bin', systemroot: 'C:\\Windows', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  const good = { command: process.execPath, args: [FAKE], enabled: true };
  for (const server of [{ ...good, enabled: false }, { ...good, command: 'node.exe' }, { ...good, command: '\\\\server\\share\\python.exe' },
    { ...good, command: [path.dirname(process.execPath), '..', path.basename(path.dirname(process.execPath)), path.basename(process.execPath)].join(path.sep) },
    { ...good, args: [FAKE, 'line\nbreak'] }, { ...good, args: FAKE }, { ...good, args: Array(17).fill('x') }, { args: [FAKE] }, 'node']) {
    const bad = fixture(t, { server, spawnProcess: () => assert.fail('an invalid config starts nothing') });
    await assert.rejects(bad.call('scout_card', { athlete_id: ATHLETE }), /not configured/, JSON.stringify(server));
  }
  // A config that names any other process than the edition pins never chooses what starts.
  const pinned = fixture(t, { spawnProcess: () => assert.fail('a config the edition does not pin starts nothing') });
  const pin = JSON.parse(fs.readFileSync(path.join(pinned.folder, 'mcp_servers.json'), 'utf8')).mcpServers['gridiron-scout'];
  for (const server of [{ ...pin, command: path.join(path.dirname(process.execPath), 'planted.exe') }, { ...pin, args: [FAKE, 'hang', ...pin.args.slice(2)] },
    { ...pin, args: pin.args.slice(0, 3) }, { ...pin, args: [...pin.args, '--extra'] }, { ...pin, command: process.execPath.toUpperCase() }]) {
    fs.writeFileSync(path.join(pinned.folder, 'mcp_servers.json'), JSON.stringify({ mcpServers: { 'gridiron-scout': server } }));
    await assert.rejects(pinned.call('scout_card', { athlete_id: ATHLETE }), /different command or arguments than this edition starts/, JSON.stringify(server));
  }
  assert.deepEqual(pinned.owned, [], 'nothing is owner-checked or started for a config the edition does not pin');
  // A config, interpreter or script that belongs to another local account is refused before anything starts.
  const planted = fixture(t, { checkOwner: async () => { throw new Error('Gridiron tools are not started: their MCP config, interpreter and script must belong to this Windows user or to Windows itself.'); },
    spawnProcess: () => assert.fail('a file another account owns starts nothing') });
  await assert.rejects(planted.call('scout_card', { athlete_id: ATHLETE }), /must belong to this Windows user/);
  await assert.rejects(planted.call('scout_card', { athlete_id: ATHLETE }), /must belong to this Windows user/, 'refused again; restarts are not consumed');
  const unnamed = fixture(t, { spawnProcess: () => assert.fail('a missing server starts nothing') });
  fs.writeFileSync(path.join(unnamed.folder, 'mcp_servers.json'), JSON.stringify({ mcpServers: { other: good } }));
  await assert.rejects(unnamed.call('scout_card', { athlete_id: ATHLETE }), /not configured/);
  const oversized = fixture(t, { spawnProcess: () => assert.fail('an oversized config starts nothing') });
  fs.writeFileSync(path.join(oversized.folder, 'mcp_servers.json'), JSON.stringify({ mcpServers: { 'gridiron-scout': good }, padding: 'x'.repeat(70000) }));
  await assert.rejects(oversized.call('scout_card', { athlete_id: ATHLETE }), /not configured/);
});

test('policy denial stops Gridiron actions before the server or the browser is used', async t => {
  const f = fixture(t, { denied: 'Gridiron is disabled by a fixture policy.' });
  for (const [tool, args] of [['scout_card', { athlete_id: ATHLETE }], ['draft_save', DRAFT], ['show_page', { tab: 'my-card' }]])
    await assert.rejects(f.call(tool, args), /fixture policy/);
  await assert.rejects(f.broker.execute('gridiron_tools', {}, f.identity()), /fixture policy/);
  assert.deepEqual([f.pages, f.confirmations, f.calls()], [[], [], []]);
  assert.deepEqual(f.policies[0][0], 'franklin:gridiron');
  assert.deepEqual(f.policies[0][1], [{ action: 'gridiron_call', payload: { tool: 'scout_card', arguments: { athlete_id: ATHLETE } } }]);
});

test('the owner check accepts this user and Windows itself and refuses another account, a missing file or a bad path', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-gridiron-owner-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'mcp_servers.json');
  fs.writeFileSync(file, '{}');
  for (const files of [[], ['relative.json'], [file + '\nC:\\other.json'], Array(19).fill(file), 'file'])
    await assert.rejects(checkOwners(files, { spawnProcess: () => assert.fail('a malformed list reads no owner') }), /must belong to this Windows user/);
  // Windows answers through PowerShell: the current user's SID, then one owner SID per path.
  const answer = lines => (command, args, options) => {
    assert.match(command, /powershell\.exe$/i); assert.equal(args.at(-2), '-Command'); assert.equal(options.shell, false);
    assert.equal(options.env.YUR_GRIDIRON_OWNED, file); assert.equal(args.join(' ').includes(file), false, 'paths never ride the command line');
    const child = new (require('node:events'))(); child.stdout = new (require('node:stream').PassThrough)(); child.kill = () => {};
    setImmediate(() => { child.stdout.end(lines.join('\r\n')); setImmediate(() => child.emit('close', 0)); }); return child;
  };
  const me = 'S-1-5-21-1-2-3-1001';
  await checkOwners([file], { platform: 'win32', spawnProcess: answer([`me=${me}`, me]) });
  for (const sid of WINDOWS_OWNERS) await checkOwners([file], { platform: 'win32', spawnProcess: answer([`me=${me}`, sid]) });
  for (const lines of [[`me=${me}`, 'S-1-5-21-1-2-3-1002'], [`me=${me}`], ['S-1-5-21-1-2-3-1001'], []])
    await assert.rejects(checkOwners([file], { platform: 'win32', spawnProcess: answer(lines) }), /must belong to this Windows user/, JSON.stringify(lines));
  if (process.platform === 'win32') {
    // The real check: a file this user just made is accepted; a missing one is refused.
    await checkOwners([file, folder]);
    await assert.rejects(checkOwners([path.join(folder, 'missing.json')]), /must belong to this Windows user/);
  }
});

test('one Gridiron write at a time; an uncertain write ends the server and every process it started first', { skip: process.platform !== 'win32' && 'Windows process trees' }, async t => {
  const f = fixture(t, { mode: 'orphan-hang', callTimeoutMs: 1500 });
  const first = f.call('draft_save', DRAFT);
  assert.ok(await waitFor(() => f.grandchild() !== null), 'the write started its own process');
  const server = Number(fs.readFileSync(f.pid, 'utf8')), orphan = f.grandchild();
  assert.equal(alive(orphan), true);
  // While the first write runs, a second one is refused before its dialog.
  await assert.rejects(f.call('package_rebuild', { athlete_id: ATHLETE }), /still running or being stopped/);
  assert.equal(f.confirmations.length, 1);
  await assert.rejects(first, error => error.code === 'GRIDIRON_OUTCOME_UNCERTAIN');
  // child.kill() alone ends only the server on Windows; its detached grandchild must end too.
  assert.ok(await waitFor(() => !alive(server) && !alive(orphan)), 'the server and its grandchild are ended');
  // Once both are gone the lane reopens; the restarted server answers this time.
  let saved = null;
  for (const end = Date.now() + 8000; !saved && Date.now() < end; await sleep(50))
    saved = await f.call('draft_save', DRAFT).catch(error => { assert.match(error.message, /still running or being stopped/); return null; });
  assert.equal(saved?.executed, true);
  assert.equal(f.calls().filter(message => message.method === 'initialize').length, 2);
});

test('package_rebuild gets its longer budget before its outcome counts as uncertain', async t => {
  for (const [tool, args, low, high] of [['draft_save', DRAFT, 0, 1400], ['package_rebuild', { athlete_id: ATHLETE }, 1500, 60000]]) {
    const f = fixture(t, { mode: 'hang', callTimeoutMs: 200, rebuildTimeoutMs: 1500 });
    const started = Date.now();
    await assert.rejects(f.call(tool, args), error => error.code === 'GRIDIRON_OUTCOME_UNCERTAIN');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= low && elapsed < high, `${tool} became uncertain after ${elapsed} ms`);
  }
});

test('the child process and every process it started are ended on quit and never started again', async t => {
  const f = fixture(t, { mode: 'orphan' });
  await f.call('scout_card', { athlete_id: ATHLETE });
  const pid = Number(fs.readFileSync(f.pid, 'utf8')), orphan = f.grandchild();
  assert.equal(alive(pid), true);
  assert.equal(alive(orphan), true, 'the server started a detached process');
  f.service.dispose();
  assert.ok(await waitFor(() => !alive(pid)), 'dispose kills the Gridiron child');
  if (process.platform === 'win32') assert.ok(await waitFor(() => !alive(orphan)), 'dispose ends the whole tree, not only the child');
  f.service.dispose();
  assert.equal(f.service.catalog()[0].status, 'stopped');
  await assert.rejects(f.call('scout_card', { athlete_id: ATHLETE }), /stopped for this app run/);
  assert.equal(Number(fs.readFileSync(f.pid, 'utf8')), pid);
  assert.equal(f.calls().filter(message => message.method === 'initialize').length, 1);
});
