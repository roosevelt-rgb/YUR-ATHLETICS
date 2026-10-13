'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const edition = require('../src/edition');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
// The athlete manifest (editions/athletics.json) is each owner's own file and is never committed. These tests read
// the committed sample, tests/fixtures/athletics.sample.json, from a temporary editions folder.
const SAMPLE_FILE = path.join(__dirname, 'fixtures', 'athletics.sample.json');
const sampleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-edition-sample-'));
fs.copyFileSync(SAMPLE_FILE, path.join(sampleRoot, 'athletics.json'));
after(() => fs.rmSync(sampleRoot, { recursive: true, force: true }));
const shipped = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
// The owner's own manifest, when this checkout has one: checked against the sample's shape and the donor below.
const localManifest = path.join(root, 'editions', 'athletics.json');
const donorFile = path.join(root, '..', 'athletics-tauri', 'edition', 'yur-ai-desktop.json');
const launchPage = path.join(src, 'athletics-launch.html');
const iconFile = path.join(src, 'athletics-brand', 'brand', 'icon.ico');
const clone = value => JSON.parse(JSON.stringify(value));
// Values made inside main.js's VM context have that context's prototypes; compare their JSON.
const plain = clone;
const quiet = () => {};

function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-edition-'));
  t.after(() => {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}
function manifestFolder(t, manifest) {
  const folder = temporary(t);
  fs.writeFileSync(path.join(folder, 'athletics.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return folder;
}
const loadFrom = folder => edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: folder, log: quiet });

test('the Athletics edition (committed sample) loads deep-frozen with its brand, Gridiron tools config and twelve sections', () => {
  const loaded = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot, log: () => assert.fail('a valid edition logs nothing') });
  assert.equal(loaded.edition_id, 'athletics');
  assert.deepEqual(loaded.brand, { title: 'YUR Athletics', product_id: 'yur-ai-athletics', user_data: 'yur-ai-athletics',
    launch_page: 'athletics-launch.html', icon: 'athletics-brand/brand/icon.ico' });
  assert.equal(loaded.athlete.sport, 'football');
  assert.deepEqual(Object.keys(loaded.athlete), ['id', 'sport', 'display_name', 'position', 'position_code', 'throws', 'class_of']);
  assert.deepEqual(loaded.gridiron_mcp, { config_path: 'C:\\YUR-ATHLETICS\\gridiron\\agent_runtime\\yur_desktop\\mcp_servers.json', server: 'gridiron-scout',
    command: 'C:\\Python314\\python.exe', args: ['-P', 'C:\\YUR-ATHLETICS\\gridiron\\agent_runtime\\gridiron_mcp.py'] });
  assert.equal(loaded.gridiron.origin, 'http://127.0.0.1:3000');
  assert.equal(loaded.tabs.length, 12);
  assert.deepEqual(loaded.tab_groups.map(group => group.id), ['athlete', 'recruiting', 'desk']);
  for (const value of [loaded, loaded.brand, loaded.athlete, loaded.gridiron, loaded.gridiron_mcp, loaded.tabs, loaded.tabs[1], loaded.tab_groups, loaded.tab_groups[2]])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => { loaded.tabs[1].path = '//evil.example'; }, TypeError);
  assert.throws(() => loaded.tabs.push({ id: 'extra' }), TypeError);
  assert.equal(loaded.tabs[1].path, '/player/' + shipped.athlete.id);
});

test('a local editions/athletics.json, when present, loads with the sample\'s brand, Gridiron origin, sections and groups', { skip: !fs.existsSync(localManifest) && 'no local athlete manifest' }, () => {
  const loaded = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, log: () => assert.fail('a valid edition logs nothing') });
  assert.deepEqual({ ...loaded.brand }, shipped.brand);
  assert.equal(loaded.gridiron.origin, shipped.gridiron.origin);
  assert.equal(loaded.gridiron_mcp.server, shipped.gridiron_mcp.server);
  assert.deepEqual(loaded.tabs.map(tab => [tab.id, tab.kind, tab.group ?? null]), shipped.tabs.map(tab => [tab.id, tab.kind, tab.group ?? null]));
  assert.deepEqual(loaded.tab_groups.map(group => group.id), shipped.tab_groups.map(group => group.id));
  for (const tab of loaded.tabs.filter(tab => tab.kind === 'gridiron' && tab.path.startsWith('/player/')))
    assert.ok(tab.path === '/player/' + loaded.athlete.id || tab.path.startsWith('/player/' + loaded.athlete.id + '?tab='), tab.id);
});

test('athlete, gridiron, tabs and tab groups match the athletics-tauri donor except the four recorded changes', { skip: !(fs.existsSync(donorFile) && fs.existsSync(localManifest)) && 'donor checkout or local athlete manifest not present' }, () => {
  // Provenance of the owner's own manifest; both files are local and neither is committed.
  const shipped = JSON.parse(fs.readFileSync(localManifest, 'utf8'));
  // The donor stays a read-only copy. This edition (1) adds athlete.sport (the shell reads the sport and
  // position, never assumes them), (2) drops route_status needs-gridiron-route: Gridiron serves the
  // ?tab= sections since gridiron-scout 5b61394 (App.tsx reads the tab parameter), (3) names the last
  // group Desk (Welcome/Main) and (4) points College board at the athlete's own board, the card's Board
  // tab, instead of Gridiron's generic /matches page.
  const donor = JSON.parse(fs.readFileSync(donorFile, 'utf8'));
  const { sport, ...athlete } = shipped.athlete;
  assert.equal(sport, 'football');
  assert.equal(JSON.stringify(athlete), JSON.stringify(donor.athlete), 'athlete');
  assert.equal(JSON.stringify(shipped.gridiron), JSON.stringify(donor.gridiron), 'gridiron');
  const groups = donor.tab_groups.map(group => group.id === 'desk' ? { ...group, label: 'Desk' } : group);
  assert.equal(JSON.stringify(shipped.tab_groups), JSON.stringify(groups), 'tab_groups');
  const routed = donor.tabs.map(({ route_status, ...tab }) => tab.id === 'college-board' ? { ...tab, path: '/player/' + shipped.athlete.id + '?tab=board' } : tab);
  assert.equal(JSON.stringify(shipped.tabs), JSON.stringify(routed), 'tabs');
  assert.equal(donor.tabs.find(tab => tab.id === 'college-board').path, '/matches');
  assert.deepEqual(donor.tabs.filter(tab => tab.route_status).map(tab => tab.id), ['film-study', 'highlights', 'stats-maxpreps', 'camps-schedule', 'resume-report', 'outreach-drafts']);
});

test('no section carries a route status any more: every ?tab= section is served by Gridiron', () => {
  assert.equal(shipped.tabs.some(tab => Object.hasOwn(tab, 'route_status')), false);
  assert.doesNotMatch(fs.readFileSync(SAMPLE_FILE, 'utf8'), /needs-gridiron-route|route_status/);
  for (const file of ['src/edition-shell.js', 'src/franklin-gridiron.js', 'foundry/franklin_cli.py'])
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /needs-gridiron-route|route_status|still needs its Gridiron route|until Gridiron reads/, file);
  const tabbed = shipped.tabs.filter(tab => tab.kind === 'gridiron' && tab.path.includes('?tab='));
  assert.deepEqual(tabbed.map(tab => tab.path.split('?tab=')[1]), ['film', 'highlights', 'stats', 'camps', 'resume', 'board', 'outreach']);
  // Every card section is the athlete's own card (Gridiron's CARD_TABS: board, film, highlights, stats, camps, resume, outreach).
  for (const tab of tabbed) assert.ok(tab.path.startsWith('/player/' + shipped.athlete.id + '?tab='), tab.id);
});

test('the throwing hand is optional (a sport without one) and, when given, left or right', t => {
  const without = clone(shipped); delete without.athlete.throws;
  const loaded = loadFrom(manifestFolder(t, without));
  assert.equal(Object.hasOwn(loaded.athlete, 'throws'), false);
  assert.equal(Object.hasOwn(edition.editionLaunchInfo(loaded).athlete, 'throws'), false);
  for (const hand of ['left', 'right']) { const manifest = clone(shipped); manifest.athlete.throws = hand; assert.equal(loadFrom(manifestFolder(t, manifest)).athlete.throws, hand); }
  for (const hand of ['both', 'Left', '', null, 1]) {
    const manifest = clone(shipped); manifest.athlete.throws = hand;
    assert.throws(() => loadFrom(manifestFolder(t, manifest)), { code: 'EDITION_INVALID', message: /throwing hand/ }, JSON.stringify(hand));
  }
});

test('the side browser never opens Gridiron /api/ addresses or another athlete’s page, in any spelling', () => {
  assert.equal(edition.gridironNavigationGuard(null), null, 'the Desktop has no path rule');
  const guard = edition.gridironNavigationGuard(edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot }));
  const own = '/player/' + shipped.athlete.id;
  for (const url of ['http://127.0.0.1:3000/api/athletes', 'http://127.0.0.1:3000/api', 'http://127.0.0.1:3000/api?x=1', 'http://127.0.0.1:3000/API/athletes/x',
    'http://localhost:3000/api/athletes', 'http://[::1]:3000/api/athletes', 'http://127.0.0.2:3000/api/athletes', 'http://127.0.0.1:3000/%61pi/athletes',
    'http://127.0.0.1:3000/%2Fapi/athletes', 'http://127.0.0.1:3000//api/athletes', 'http://127.0.0.1:3000/x/../api/athletes', 'http://127.0.0.1:3000/%5Capi/athletes',
    'http://127.0.0.1:3000/%E0%A4%A', 'http://127.0.0.1:3000/player/someone-else', 'http://127.0.0.1:3000/player/someone-else?tab=film', 'http://localhost:3000/player/someone-else'])
    assert.notEqual(guard(url), '', url);
  assert.match(guard('http://127.0.0.1:3000/api/athletes'), /api/);
  assert.match(guard('http://127.0.0.1:3000/player/someone-else'), new RegExp(own));
  for (const url of ['http://127.0.0.1:3000' + own, 'http://127.0.0.1:3000' + own + '?tab=film&embed=1', 'http://127.0.0.1:3000/coaches', 'http://127.0.0.1:3000/apis',
    'http://127.0.0.1:3000/players', 'http://127.0.0.1:3001/api/athletes', 'https://example.com/api/athletes', 'not a url'])
    assert.equal(guard(url), '', url);
  // The card's frames may show this athlete's own report files (resume, film study); nothing else under /api/, and never at the top level.
  const report = 'http://127.0.0.1:3000/api/athletes/' + shipped.athlete.id + '/reports/';
  for (const name of ['resume', 'film-study', 'coach-brief-pdf']) {
    assert.equal(guard(report + name, { subFrame: true }), '', name);
    assert.match(guard(report + name), /api/, 'top level: ' + name);
    assert.match(guard(report + name, { subFrame: false }), /api/, 'top level: ' + name);
  }
  for (const url of ['http://127.0.0.1:3000/api/athletes/someone-else/reports/resume', 'http://127.0.0.1:3000/api/athletes/' + shipped.athlete.id,
    report, report + '%2e%2e', report + '.hidden', report + 'a/b', report + 'resume%2F..%2F..%2Fdrafts', 'http://127.0.0.1:3000/api/athletes/' + shipped.athlete.id + '/drafts'])
    assert.notEqual(guard(url, { subFrame: true }), '', url);
});

test('the side browser finish applies to Gridiron pages only, and a sheet that could fetch anything is refused', () => {
  const athletics = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot });
  const css = fs.readFileSync(path.join(src, 'athletics-brand', 'gridiron-embed.css'), 'utf8');
  assert.equal(edition.gridironPageStyle(null, css), null, 'the Desktop has no page finish');
  const style = edition.gridironPageStyle(athletics, css);
  for (const url of ['http://127.0.0.1:3000/player/' + shipped.athlete.id + '?tab=film&embed=1', 'http://localhost:3000/coaches', 'http://[::1]:3000/'])
    assert.equal(style(url), css, url);
  for (const url of ['https://example.com/', 'http://127.0.0.1:3001/', 'http://127.0.0.2:8080/', 'file:///C:/x', 'not a url']) assert.equal(style(url), '', url);
  for (const bad of ['', '   ', 'a { background: url(x) }', 'a { background: URL ( x ) }', '@import "x.css";', 'a { width: expression(1) }',
    'a { b: \\75 rl(x) }', '</style><script>', 'a{}'.repeat(12000), 42, null])
    assert.equal(edition.gridironPageStyle(athletics, bad), null, String(bad).slice(0, 40));
  // The shipped sheet scopes every rule to pages without Gridiron's own embed view and names no athlete.
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(part => part.trim()).filter(Boolean))
    assert.match(block, /^html:not\(\[data-gridiron-embed\]\)/, block.slice(0, 80));
  assert.doesNotMatch(css, new RegExp([...shipped.athlete.id.split('-'), String(shipped.athlete.class_of)].join('|'), 'i'));
});

test('the athlete sport is a strict lower-case slug', t => {
  for (const sport of ['football', 'basketball', 'track-and-field', 'water-polo', 'lacrosse']) {
    const manifest = clone(shipped); manifest.athlete.sport = sport;
    assert.equal(loadFrom(manifestFolder(t, manifest)).athlete.sport, sport);
  }
  for (const sport of ['Football', 'FOOTBALL', 'foot ball', 'foot_ball', '-football', 'football-', 'track--field', '', ' football', 'football\n', 'a'.repeat(33), 7, null, ['football'], { name: 'football' }]) {
    const manifest = clone(shipped); manifest.athlete.sport = sport;
    assert.throws(() => loadFrom(manifestFolder(t, manifest)), { code: 'EDITION_INVALID', message: /sport/ }, JSON.stringify(sport));
  }
  const missing = clone(shipped); delete missing.athlete.sport;
  assert.throws(() => loadFrom(manifestFolder(t, missing)), { code: 'EDITION_INVALID', message: /athlete requires its exact fields/ });
});

test('without YUR_EDITION nothing is read and the Desktop starts without an edition', () => {
  const never = path.join(os.tmpdir(), 'yur-edition-never-read');
  for (const env of [{}, { YUR_EDITION: '' }]) assert.equal(edition.loadEdition({ env, root: never, log: () => assert.fail('nothing to log') }), null);
});

test('an unknown edition name starts the default Desktop and is logged', () => {
  for (const name of ['nope', 'Athletics', 'ATHLETICS', ' athletics', 'athletics ', '../athletics', 'athletics.json', '__proto__', 'constructor', 'toString']) {
    const logged = [];
    assert.equal(edition.loadEdition({ env: { YUR_EDITION: name }, root: path.join(os.tmpdir(), 'yur-edition-never-read'), log: message => logged.push(message) }), null, name);
    assert.equal(logged.length, 1, name);
    assert.match(logged[0], /Unknown YUR_EDITION/);
  }
});

test('a known edition with a missing, oversized, malformed or invalid manifest fails closed', t => {
  assert.throws(() => loadFrom(temporary(t)), { code: 'EDITION_INVALID', message: /could not be read/ });
  assert.throws(() => loadFrom(manifestFolder(t, '{')), { code: 'EDITION_INVALID', message: /not valid JSON/ });
  assert.throws(() => loadFrom(manifestFolder(t, ' '.repeat(64 * 1024 + 1))), { code: 'EDITION_INVALID', message: /64 KiB/ });
  const cases = [
    ['unknown top-level field', m => { m.extra = true; }],
    ['missing section', m => { delete m.gridiron_mcp; }],
    ['schema', m => { m.$schema = 'yur/desktop-edition/v2'; }],
    ['edition id', m => { m.edition_id = 'other'; }],
    ['glider profile', m => { m.brand.user_data = 'yur-intelliflow-glider-rc6'; }],
    ['unified profile', m => { m.brand.user_data = 'yur-ai-desktop-unified'; }],
    ['profile traversal', m => { m.brand.user_data = '../yur-ai-athletics'; }],
    ['profile separator', m => { m.brand.user_data = 'yur\\athletics'; }],
    ['studio page as launch page', m => { m.brand.launch_page = 'studio-editor.html'; }],
    ['factory page as launch page', m => { m.brand.launch_page = 'factory.html'; }],
    ['launch page traversal', m => { m.brand.launch_page = '../athletics-launch.html'; }],
    ['launch page in a folder', m => { m.brand.launch_page = 'athletics/launch.html'; }],
    ['launch page type', m => { m.brand.launch_page = 'athletics-launch.js'; }],
    ['icon traversal', m => { m.brand.icon = 'athletics-brand/../../icon.ico'; }],
    ['absolute icon', m => { m.brand.icon = 'C:/icon.ico'; }],
    ['vector icon', m => { m.brand.icon = 'athletics-brand/brand/lockup.svg'; }],
    ['title control character', m => { m.brand.title = 'YUR\u0007Athletics'; }],
    ['brand extra field', m => { m.brand.window = 'frameless'; }],
    ['class year type', m => { m.athlete.class_of = String(m.athlete.class_of); }],
    ['throwing hand', m => { m.athlete.throws = 'both'; }],
    ['sport in capitals', m => { m.athlete.sport = 'Football'; }],
    ['missing sport', m => { delete m.athlete.sport; }],
    ['route status is no longer a tab field', m => { m.tabs[2].route_status = 'needs-gridiron-route'; }],
    ['localhost origin', m => { m.gridiron.origin = 'http://localhost:3000'; }],
    ['https origin', m => { m.gridiron.origin = 'https://127.0.0.1:3000'; }],
    ['origin without port', m => { m.gridiron.origin = 'http://127.0.0.1'; }],
    ['origin with path', m => { m.gridiron.origin = 'http://127.0.0.1:3000/'; }],
    ['remote origin', m => { m.gridiron.origin = 'http://gridiron.example:3000'; }],
    ['origin credentials', m => { m.gridiron.origin = 'http://user@127.0.0.1:3000'; }],
    ['embed parameter', m => { m.gridiron.embed_param = 'embed=1&x=2'; }],
    ['relative MCP config', m => { m.gridiron_mcp.config_path = 'agent_runtime\\yur_desktop\\mcp_servers.json'; }],
    ['UNC MCP config', m => { m.gridiron_mcp.config_path = '\\\\server\\share\\mcp_servers.json'; }],
    ['MCP config traversal', m => { m.gridiron_mcp.config_path = 'D:\\YUR-AI-WORKSPACE\\..\\mcp_servers.json'; }],
    ['MCP config forward slashes', m => { m.gridiron_mcp.config_path = 'D:/YUR-AI-WORKSPACE/mcp_servers.json'; }],
    ['MCP config type', m => { m.gridiron_mcp.config_path = 'D:\\YUR-AI-WORKSPACE\\gridiron_mcp.py'; }],
    ['MCP config control character', m => { m.gridiron_mcp.config_path = 'D:\\YUR\nAI\\mcp_servers.json'; }],
    ['MCP config stream or second drive', m => { m.gridiron_mcp.config_path = 'D:\\YUR-AI-WORKSPACE\\C:\\mcp_servers.json'; }],
    ['MCP server name', m => { m.gridiron_mcp.server = 'gridiron scout'; }],
    ['unpinned MCP command', m => { delete m.gridiron_mcp.command; }],
    ['unpinned MCP args', m => { delete m.gridiron_mcp.args; }],
    ['relative MCP command', m => { m.gridiron_mcp.command = 'python.exe'; }],
    ['MCP command on a share', m => { m.gridiron_mcp.command = '\\\\server\\share\\python.exe'; }],
    ['MCP command traversal', m => { m.gridiron_mcp.command = 'C:\\Python314\\..\\python.exe'; }],
    ['MCP command type', m => { m.gridiron_mcp.command = 'C:\\Python314\\python.cmd'; }],
    ['MCP args type', m => { m.gridiron_mcp.args = '-P gridiron_mcp.py'; }],
    ['too many MCP args', m => { m.gridiron_mcp.args = Array(17).fill('-P'); }],
    ['empty MCP arg', m => { m.gridiron_mcp.args = ['-P', '']; }],
    ['MCP arg control character', m => { m.gridiron_mcp.args = ['-P', 'gridiron_mcp.py\n--evil']; }],
    ['API section', m => { m.tabs[1].path = '/api/athletes'; }],
    ['API section in capitals', m => { m.tabs[1].path = '/API/athletes/' + m.athlete.id; }],
    ['API root section', m => { m.tabs[1].path = '/api?x=1'; }],
    ['protocol-relative section', m => { m.tabs[1].path = '//evil.example/player'; }],
    ['absolute section URL', m => { m.tabs[1].path = 'http://evil.example/player'; }],
    ['dot segment section', m => { m.tabs[1].path = '/player/../admin'; }],
    ['encoded dot segment section', m => { m.tabs[1].path = '/player/%2e%2e/admin'; }],
    ['backslash section', m => { m.tabs[1].path = '/\\evil.example'; }],
    ['fragment section', m => { m.tabs[1].path = '/player/' + m.athlete.id + '#film'; }],
    ['whitespace section', m => { m.tabs[1].path = '/player/ ' + m.athlete.id; }],
    ['Gridiron tab without path', m => { delete m.tabs[1].path; }],
    ['native tab with path', m => { m.tabs[10].path = '/approvals'; }],
    ['unknown tab kind', m => { m.tabs[1].kind = 'iframe'; }],
    ['unknown tab field', m => { m.tabs[1].url = 'http://127.0.0.1:3000/'; }],
    ['unknown tab group', m => { m.tabs[1].group = 'admin'; }],
    ['duplicate tab', m => { m.tabs[2].id = m.tabs[1].id; }],
    ['duplicate group', m => { m.tab_groups[1].id = 'athlete'; }],
    ['tab id', m => { m.tabs[1].id = 'My Card'; }],
    ['no tabs', m => { m.tabs = []; }],
  ];
  for (const [label, mutate] of cases) {
    const manifest = clone(shipped);
    mutate(manifest);
    assert.throws(() => loadFrom(manifestFolder(t, manifest)), { code: 'EDITION_INVALID' }, label);
  }
  assert.equal(edition.validateEdition(clone(shipped), 'athletics').edition_id, 'athletics');
  assert.throws(() => edition.validateEdition(clone(shipped), 'other'), { code: 'EDITION_INVALID' });
});

test('without an edition the window title, profile folder and launch page are exactly the Desktop values', () => {
  const never = () => assert.fail('the default Desktop checks no edition asset');
  assert.deepEqual({ ...edition.desktopIdentity({ srcRoot: src, exists: never, log: never }) },
    { title: 'YUR AI Desktop', userData: 'yur-ai-desktop-unified', launchFile: path.join(src, 'yur-ai-launch.html'), icon: null });
  assert.deepEqual({ ...edition.desktopIdentity({ gliderRc6: true, srcRoot: src, exists: never, log: never }) },
    { title: 'IntelliFlow — YUR AI Desktop', userData: 'yur-intelliflow-glider-rc6', launchFile: path.join(src, 'glider-launch.html'), icon: null });
});

test('an edition brings its own title, profile, launch page and icon, and falls back while brand assets are absent', () => {
  const loaded = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot });
  const present = new Set([launchPage, iconFile]);
  assert.deepEqual({ ...edition.desktopIdentity({ edition: loaded, gliderRc6: true, srcRoot: src, exists: file => present.has(file), log: () => assert.fail('nothing is missing') }) },
    { title: 'YUR Athletics', userData: 'yur-ai-athletics', launchFile: launchPage, icon: iconFile });
  const logged = [];
  assert.deepEqual({ ...edition.desktopIdentity({ edition: loaded, gliderRc6: true, srcRoot: src, exists: () => false, log: message => logged.push(message) }) },
    { title: 'YUR Athletics', userData: 'yur-ai-athletics', launchFile: path.join(src, 'glider-launch.html'), icon: null });
  assert.equal(logged.length, 2);
  // The real files ship in the source tree: the launch page and the YUR Athletics icon (copied from the logo set).
  assert.ok(fs.existsSync(launchPage) && fs.existsSync(iconFile));
  assert.deepEqual([...fs.readFileSync(iconFile).subarray(0, 4)], [0, 0, 1, 0], 'icon.ico is a Windows icon resource');
});

test('the launch page sees only the athlete fields its card and play art show', () => {
  assert.deepEqual(edition.editionLaunchInfo(null), { enabled: false });
  const loaded = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot });
  const info = edition.editionLaunchInfo(loaded);
  assert.deepEqual(info, { enabled: true, edition_id: 'athletics', title: 'YUR Athletics',
    athlete: { display_name: shipped.athlete.display_name, sport: 'football', position: shipped.athlete.position, throws: shipped.athlete.throws, class_of: shipped.athlete.class_of } });
  assert.doesNotMatch(JSON.stringify(info), /mcp|config_path|user_data|127\.0\.0\.1|tabs/);
  assert.equal(JSON.stringify(info).includes(shipped.athlete.id), false, 'no Gridiron athlete id');
  info.athlete.position = 'changed';
  assert.equal(loaded.athlete.position, shipped.athlete.position);
});

test('edition:info is a read-only copy without local paths', () => {
  assert.deepEqual(edition.editionInfo(null), { enabled: false });
  const loaded = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot });
  const info = edition.editionInfo(loaded);
  assert.deepEqual(Object.keys(info).sort(), ['athlete', 'edition_id', 'enabled', 'gridiron', 'gridiron_service', 'product_id', 'tab_groups', 'tabs', 'title']);
  assert.equal(info.enabled, true);
  assert.equal(info.title, 'YUR Athletics');
  assert.equal(info.athlete.sport, 'football');
  assert.equal(info.tabs.length, 12);
  assert.equal(info.gridiron_service, 'unavailable');
  assert.equal(edition.editionInfo(loaded, { gridironService: true }).gridiron_service, 'registered');
  assert.doesNotMatch(JSON.stringify(info), /mcp_servers|config_path|user_data|launch_page/);
  info.tabs[0].label = 'changed';
  assert.equal(loaded.tabs[0].label, 'Franklin');
});

test('desktopServices stays the existing object without an edition service; with one, existing services keep their actions', async () => {
  const calls = [];
  const fake = (name, actions, readOnly) => ({
    accepts: action => actions.includes(action),
    isReadOnly: (action, ...args) => { calls.push([name, 'isReadOnly', action, ...args]); return readOnly; },
    catalog: () => [{ id: name }],
    validate: (action, ...args) => { calls.push([name, 'validate', action, ...args]); return name; },
    confirmationRequirements: (action, ...args) => { calls.push([name, 'confirmationRequirements', action, ...args]); return { required: !readOnly }; },
    execute: async (action, ...args) => { calls.push([name, 'execute', action, ...args]); return { by: name }; },
  });
  const base = fake('base', ['music_status', 'gridiron_call'], true);
  assert.equal(edition.composeDesktopServices(base, null), base);
  const services = edition.composeDesktopServices(base, fake('gridiron', ['gridiron_tools', 'gridiron_call'], false));
  assert.ok(Object.isFrozen(services));
  assert.deepEqual(['gridiron_tools', 'music_status', 'unknown'].map(services.accepts), [true, true, false]);
  assert.deepEqual(services.catalog(), [{ id: 'base' }, { id: 'gridiron' }]);
  const identity = { action_id: 'a'.repeat(32) }, payload = { tool: 'scout_board', arguments: {} };
  assert.equal(services.isReadOnly('gridiron_tools', payload), false);
  assert.equal(services.validate('gridiron_tools', payload, identity), 'gridiron');
  assert.deepEqual(services.confirmationRequirements('gridiron_tools', payload), { required: true });
  assert.deepEqual(await services.execute('gridiron_tools', payload, identity, { confirmed: true }), { by: 'gridiron' });
  assert.equal(services.isReadOnly('music_status'), true);
  assert.equal(services.validate('gridiron_call', payload, identity), 'base');
  assert.deepEqual(calls.slice(0, 4), [['gridiron', 'isReadOnly', 'gridiron_tools', payload], ['gridiron', 'validate', 'gridiron_tools', payload, identity],
    ['gridiron', 'confirmationRequirements', 'gridiron_tools', payload], ['gridiron', 'execute', 'gridiron_tools', payload, identity, { confirmed: true }]]);
  // An action neither service accepts (browser_click, coding_*, media_*) is answered by the existing
  // services exactly as without an edition. An edition service that would call it read-only can
  // therefore never remove the click, fill and select confirmation dialogs.
  const permissive = { ...fake('edition', ['gridiron_call'], true), isReadOnly: action => { calls.push(['edition', 'isReadOnly', action]); return true; } };
  const desktopOnly = fake('desktop', ['music_status'], false), composed = edition.composeDesktopServices(desktopOnly, permissive);
  calls.length = 0;
  for (const action of ['browser_click', 'browser_fill', 'browser_select', 'coding_submit', 'media_submit'])
    assert.equal(composed.isReadOnly(action, { ref: 'c1' }), edition.composeDesktopServices(desktopOnly, null).isReadOnly(action, { ref: 'c1' }), action);
  assert.equal(calls.some(([name]) => name === 'edition'), false);
  assert.equal(composed.validate('browser_click', {}, identity), 'desktop');
  assert.deepEqual(composed.confirmationRequirements('browser_click', {}), { required: true });
  assert.deepEqual(await composed.execute('browser_click', {}, identity, {}), { by: 'desktop' });
  assert.equal(composed.isReadOnly('gridiron_call', payload), true, 'the edition still answers for its own actions');
});

test('edition action names come from edition.js, so the host lists them without loading the service', () => {
  assert.deepEqual(edition.editionActions({}), []);
  for (const name of ['', 'unknown-edition', 'Athletics', '__proto__', 'constructor', undefined, 7]) assert.deepEqual(edition.editionActions({ YUR_EDITION: name }), [], String(name));
  assert.deepEqual(edition.editionActions({ YUR_EDITION: 'athletics' }), ['gridiron_tools', 'gridiron_call']);
  assert.ok(Object.isFrozen(edition.EDITION_ACTIONS.athletics));
  assert.equal(require('../src/franklin-gridiron').GRIDIRON_ACTIONS, edition.EDITION_ACTIONS.athletics);
});

test('the Gridiron service module loads only for an edition, from its fixed file, with the Franklin service interface', t => {
  const loaded = edition.loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot });
  assert.equal(edition.GRIDIRON_SERVICE, path.join(src, 'franklin-gridiron.js'));
  assert.equal(edition.loadGridironService(null, {}, { exists: () => assert.fail('the default Desktop never looks for it') }), null);
  const logged = [];
  assert.equal(edition.loadGridironService(loaded, {}, { modulePath: path.join(temporary(t), 'franklin-gridiron.js'), log: message => logged.push(message) }), null);
  assert.match(logged[0], /not installed/);
  const folder = temporary(t), module = name => path.join(folder, name);
  fs.writeFileSync(module('complete.js'), 'exports.createFranklinGridiron = options => ({ options, accepts: () => false, isReadOnly: () => false, validate() {}, confirmationRequirements: () => ({ required: true }), execute: async () => ({}), catalog: () => [], dispose() {} });\n');
  fs.writeFileSync(module('partial.js'), 'exports.createFranklinGridiron = () => ({ accepts: () => false, execute: async () => ({}) });\n');
  fs.writeFileSync(module('unnamed.js'), 'exports.create = () => ({});\n');
  const deny = () => null, getSettings = () => ({}), openPage = async () => ({});
  const service = edition.loadGridironService(loaded, { deny, getSettings, openPage }, { modulePath: module('complete.js') });
  assert.equal(service.options.edition, loaded);
  assert.deepEqual([service.options.deny, service.options.getSettings, service.options.openPage], [deny, getSettings, openPage]);
  assert.equal(edition.loadGridironService(loaded, { edition: { forged: true } }, { modulePath: module('complete.js') }).options.edition, loaded);
  assert.throws(() => edition.loadGridironService(loaded, {}, { modulePath: module('partial.js') }), /service interface/);
  assert.throws(() => edition.loadGridironService(loaded, {}, { modulePath: module('unnamed.js') }), /createFranklinGridiron/);
});

test('the Desktop allowlist ships the edition mechanism; the Athletics edition files ship only in an Athletics build', () => {
  // Computed paths are invisible to the literal-require release gate in test_packaging.py. The
  // Athletics files hold an athlete's name, class year and local paths, so they sit in their own
  // edition allowlist (package_desktop.py build --edition athletics), never in every Desktop build.
  const required = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'source-files.json'), 'utf8')).required;
  const athletics = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'edition-files.json'), 'utf8')).editions.athletics;
  for (const name of ['src/edition.js', 'src/edition-shell.js', 'src/edition-shell.css']) assert.ok(required.includes(name), name);
  for (const name of ['editions/athletics.json', 'tests/edition.test.js', 'tests/fixtures/athletics.sample.json', 'Start YUR AI Athletics.cmd', 'src/athletics-brand/gridiron-embed.css']) {
    assert.ok(athletics.includes(name), name); assert.equal(required.includes(name), false, name);
  }
  for (const file of [edition.GRIDIRON_SERVICE, launchPage, iconFile])
    if (fs.existsSync(file)) assert.ok(athletics.includes(path.relative(root, file).split(path.sep).join('/')), file);
  assert.equal(athletics.some(name => required.includes(name)), false, 'no file is in both lists');
  // Brand art (icons, logos, the hero raster) is named only in the Athletics list, and every file it names exists.
  const art = name => /\.(?:ico|png|webp|svg)$/i.test(name);
  assert.equal(required.some(art), false, 'the YUR AI Desktop allowlist ships no edition art');
  assert.deepEqual(athletics.filter(art).sort(), ['src/athletics-brand/brand/apple-touch-icon.png', 'src/athletics-brand/brand/favicon-32.png',
    'src/athletics-brand/brand/icon-512.png', 'src/athletics-brand/brand/icon.ico', 'src/athletics-brand/brand/lockup-light.svg', 'src/athletics-brand/brand/lockup.svg',
    'src/athletics-brand/brand/mark-flat.svg', 'src/athletics-brand/brand/y-mark-figure.svg', 'src/athletics-brand/brand/y-mark.svg',
    'src/athletics-brand/brand/yur-athletics-master.webp']);
  // editions/athletics.json is the owner's own manifest, made on their machine and never committed; every other file it names exists.
  for (const name of athletics) if (name !== 'editions/athletics.json') assert.ok(fs.existsSync(path.join(root, ...name.split('/'))), name);
});

// main.js runs in a VM with an inert Electron double: no window, process or network starts.
function bootMain(t, env, { defaultProfile = true } = {}) {
  const appData = temporary(t), handlers = new Map(), setPaths = [], windows = [], appIds = [], notifications = [], trays = [];
  let userData = path.join(appData, defaultProfile ? 'studio-electron' : 'explicit-profile');
  class BrowserWindow {
    constructor(options) {
      this.options = options; this.loaded = []; this.listeners = new Map(); windows.push(this);
      this.webContents = { mainFrame: { url: '' }, on() {}, send() {}, isDestroyed: () => false, setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };
    }
    isDestroyed() { return false; } on(name, handler) { this.listeners.set(name, handler); } show() {} focus() {}
    loadFile(file) { this.loaded.push(file); this.webContents.mainFrame.url = pathToFileURL(file).href; return Promise.resolve(); }
  }
  // Notification, Tray, Menu and nativeImage doubles record what the product would show; nothing is displayed.
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; notifications.push(options); }
    show() {}
  }
  class Tray {
    constructor(image) { this.image = image; this.tooltip = null; this.menu = null; trays.push(this); }
    setToolTip(value) { this.tooltip = value; } setContextMenu(menu) { this.menu = menu; } on() {} destroy() {}
  }
  const electron = { BrowserWindow, Notification, Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromBitmap: (_bytes, size) => ({ bitmap: size }) },
    shell: {}, protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showSaveDialog: () => assert.fail('booting main.js opens no picker') },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    app: { whenReady: () => ({ then() {} }), on() {}, getName: () => 'studio-electron', getVersion: () => '0.0.0', setAppUserModelId: id => appIds.push(id),
      getPath: name => name === 'userData' ? userData : name === 'appData' ? appData : path.join(appData, name),
      setPath: (name, value) => { setPaths.push([name, value]); if (name === 'userData') userData = value; } } };
  // main.js loads its edition from <app>/editions; these boots read the committed sample instead.
  const sampleEdition = { ...edition, loadEdition: (options = {}) => edition.loadEdition({ root: sampleRoot, ...options }) };
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['YUR_EDITION', 'YUR_GLIDER_RC6', 'YUR_UNIFIED_SHARE_USERDATA', 'YUR_HARNESS_AUTOSTART'].includes(key)));
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './edition' ? sampleEdition : require(name.startsWith('.') ? path.join(src, name) : name),
    __dirname: src, process: { ...process, env: { ...inherited, ...env } }, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync(path.join(src, 'main.js'), 'utf8'), context);
  vm.runInContext('createWindow()', context);
  const [window] = windows;
  const trusted = name => {
    window.webContents.mainFrame.url = pathToFileURL(path.join(src, name)).href;
    return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  };
  // Shows a desktop notification and the background tray with notifications and background work on.
  const product = () => {
    vm.runInContext('desktopSettings = { preferences: { desktop_notifications: true, background_enabled: true } }; backgroundLifetime.dispose(); backgroundLifetime.sync();', context);
    assert.equal(handlers.get('desktop-settings:notify')(trusted('studio-editor.html'), 'test').shown, true);
    return { notification: notifications.at(-1), tray: trays.at(-1) };
  };
  return { appData, handlers, setPaths, window, trusted, appIds, product, context };
}

test('Franklin’s models in the edition are tool-capable Ollama Cloud models, launcher default first; the Desktop lists every tag as before', async t => {
  t.mock.method(console, 'warn', quiet);
  const tags = { models: [{ name: 'llama3:latest' }, { name: 'qwen2.5vl:3b' }, { name: 'deepseek-v4-pro:cloud', remote_host: 'https://ollama.com' },
    { name: 'glm-5.1:cloud', remote_host: 'https://ollama.com:443' }, { name: 'gemini-x:latest', remote_host: 'https://ollama.com:443' },
    { name: 'kimi-k3:cloud', remote_host: 'https://ollama.com' }, { name: 'no-remote:cloud' }, { name: 'text-only:cloud', remote_host: 'https://ollama.com' }] };
  // /api/show answers (metadata only): capabilities, or an error for a retired cloud model.
  const shows = { 'deepseek-v4-pro:cloud': ['completion', 'tools', 'thinking'], 'kimi-k3:cloud': ['completion', 'tools'], 'gemini-x:latest': ['completion', 'tools'], 'text-only:cloud': ['completion'] };
  function wire(boot) {
    const calls = [];
    vm.runInContext('ollamaTransport', boot.context).request = async (method, apiPath, body) => {
      calls.push([method, apiPath, body?.model ?? null]);
      if (apiPath === '/api/tags') return { status: 200, json: tags };
      return shows[body.model] ? { status: 200, json: { capabilities: shows[body.model] } } : { status: 500, json: { error: 'retired' } };
    };
    return calls;
  }
  const athletics = bootMain(t, { YUR_EDITION: 'athletics', YUR_FRANKLIN_MODEL: 'ollama:kimi-k3:cloud' });
  const calls = wire(athletics);
  const { models } = await vm.runInContext('franklinModelCatalog()', athletics.context);
  assert.deepEqual(plain(models), [{ id: 'ollama:kimi-k3:cloud', label: 'kimi-k3:cloud · Ollama Cloud' }, { id: 'ollama:deepseek-v4-pro:cloud', label: 'deepseek-v4-pro:cloud · Ollama Cloud' }]);
  assert.ok(calls.every(([, apiPath]) => ['/api/tags', '/api/show'].includes(apiPath)), 'metadata only: no chat or generate call');
  assert.deepEqual(calls.filter(([, apiPath]) => apiPath === '/api/show').map(([, , model]) => model).sort(),
    ['deepseek-v4-pro:cloud', 'glm-5.1:cloud', 'kimi-k3:cloud', 'text-only:cloud'], 'local tags and names without a cloud tag are never asked about');
  const shown = calls.length;
  await vm.runInContext('franklinModelCatalog()', athletics.context);
  assert.equal(calls.length, shown + 1, 'each /api/show answer is kept for the run: only /api/tags is asked again');
  assert.equal(vm.runInContext('editionDefaultModel', athletics.context)(models), 'ollama:kimi-k3:cloud');
  assert.equal(vm.runInContext('editionDefaultModel', athletics.context)(plain(models).slice(1)), '', 'a default the catalog lacks is not offered');
  const desktop = bootMain(t, { YUR_FRANKLIN_MODEL: 'ollama:kimi-k3:cloud' });
  const desktopCalls = wire(desktop);
  const listed = (await vm.runInContext('franklinModelCatalog()', desktop.context)).models;
  assert.deepEqual(plain(listed).map(item => item.id), tags.models.map(item => 'ollama:' + item.name));
  assert.deepEqual(desktopCalls.map(([, apiPath]) => apiPath), ['/api/tags']);
  assert.equal(vm.runInContext('editionDefaultModel', desktop.context)(listed), '', 'the Desktop has no edition default');
});

test('main.js without YUR_EDITION keeps the Desktop window, profile, launch page and IPC exactly as before', async t => {
  const logged = [];
  t.mock.method(console, 'warn', message => logged.push(String(message)));
  const desktop = { title: 'YUR AI Desktop', profile: 'yur-ai-desktop-unified', launch: 'yur-ai-launch.html' };
  for (const [env, expected] of [[{}, desktop], [{ YUR_EDITION: 'unknown-edition' }, desktop],
    [{ YUR_GLIDER_RC6: '1' }, { title: 'IntelliFlow — YUR AI Desktop', profile: 'yur-intelliflow-glider-rc6', launch: 'glider-launch.html' }]]) {
    const boot = bootMain(t, env);
    assert.deepEqual(Object.keys(boot.window.options), ['width', 'height', 'minWidth', 'minHeight', 'title', 'backgroundColor', 'frame', 'webPreferences']);
    assert.equal(boot.window.options.title, expected.title);
    assert.deepEqual(boot.setPaths, [['userData', path.join(boot.appData, expected.profile)]]);
    assert.deepEqual(boot.window.loaded, [path.join(src, expected.launch)]);
    assert.equal(boot.window.listeners.has('page-title-updated'), false);
    assert.deepEqual(boot.handlers.get('edition:info')(boot.trusted('studio-editor.html')), { enabled: false });
    assert.equal(boot.handlers.get('integration:info')(boot.trusted('studio-editor.html')).enabled, env.YUR_GLIDER_RC6 === '1');
    // The Desktop keeps Electron's app id, its notification and tray text, its tray glyph and its entry result.
    assert.deepEqual(boot.appIds, []);
    assert.equal(vm.runInContext('gridironStyle', boot.context), null, 'the Desktop side browser has no page finish');
    assert.equal(boot.handlers.has('edition:launch'), false);
    const { notification, tray } = boot.product();
    assert.equal(notification.title, 'YUR AI Desktop'); assert.equal('icon' in notification, false);
    assert.equal(tray.tooltip, 'IntelliFlow · Franklin is available');
    assert.deepEqual([...tray.menu.filter(item => item.label).map(item => item.label)], ['Open IntelliFlow', 'Quit IntelliFlow and stop background work']);
    assert.deepEqual(tray.image, { bitmap: { width: 32, height: 32, scaleFactor: 1 } });
    const launch = env.YUR_GLIDER_RC6 === '1' ? 'glider-launch.html' : 'yur-ai-launch.html';
    assert.deepEqual(plain(await boot.handlers.get('desktop:enter')(boot.trusted(launch))), { ok: true, result: { surface: 'YUR AI Desktop' } });
  }
  assert.equal(logged.filter(message => /Unknown YUR_EDITION "unknown-edition"/.test(message)).length, 1);
  assert.equal(logged.filter(message => /athletics/.test(message)).length, 0);
  assert.deepEqual(bootMain(t, { YUR_UNIFIED_SHARE_USERDATA: '1' }).setPaths, []);
  assert.deepEqual(bootMain(t, {}, { defaultProfile: false }).setPaths, []);
});

test('main.js with YUR_EDITION=athletics uses the edition title, own profile, launch page, icon and edition:info', async t => {
  t.mock.method(console, 'warn', quiet);
  const boot = bootMain(t, { YUR_EDITION: 'athletics', YUR_GLIDER_RC6: '1', YUR_UNIFIED_SHARE_USERDATA: '1' });
  assert.equal(boot.window.options.title, 'YUR Athletics');
  // Its own Windows app id (taskbar group, notifications), and YUR Athletics in every place it names itself.
  assert.deepEqual(boot.appIds, ['yur-ai-athletics']);
  const { notification, tray } = boot.product();
  assert.equal(notification.title, 'YUR Athletics'); assert.equal(notification.icon, iconFile);
  assert.equal(tray.tooltip, 'YUR Athletics · Franklin is available');
  assert.deepEqual([...tray.menu.filter(item => item.label).map(item => item.label)], ['Open YUR Athletics', 'Quit YUR Athletics and stop background work']);
  assert.equal(tray.image, iconFile, 'the tray shows the YUR Athletics icon');
  // The side browser's Gridiron finish (a user style sheet) is the edition's own.
  const style = vm.runInContext('gridironStyle', boot.context);
  assert.equal(style(shipped.gridiron.origin + '/coaches'), fs.readFileSync(path.join(src, 'athletics-brand', 'gridiron-embed.css'), 'utf8'));
  assert.equal(style('https://example.com/'), '');
  assert.equal(boot.window.options.icon, fs.existsSync(iconFile) ? iconFile : undefined);
  assert.equal('icon' in boot.window.options, fs.existsSync(iconFile));
  assert.deepEqual(boot.setPaths, [['userData', path.join(boot.appData, 'yur-ai-athletics')]]);
  const launch = fs.existsSync(launchPage) ? launchPage : path.join(src, 'glider-launch.html');
  assert.deepEqual(boot.window.loaded, [launch]);
  let prevented = false;
  boot.window.listeners.get('page-title-updated')({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  const info = boot.handlers.get('edition:info')(boot.trusted('studio-editor.html'));
  assert.equal(info.enabled, true);
  assert.equal(info.title, 'YUR Athletics');
  assert.deepEqual(info.tabs.map(tab => tab.id), shipped.tabs.map(tab => tab.id));
  assert.equal(info.gridiron_service, fs.existsSync(edition.GRIDIRON_SERVICE) ? 'registered' : 'unavailable');
  assert.throws(() => boot.handlers.get('edition:info')({ sender: {}, senderFrame: {} }), /Untrusted studio/);
  // The launch page alone reads the athlete card; the studio page and a forged sender cannot.
  const card = boot.handlers.get('edition:launch')(boot.trusted(path.basename(launch)));
  assert.equal(card.ok, true); assert.equal(card.result.title, 'YUR Athletics'); assert.equal(card.result.athlete.sport, 'football');
  assert.equal(boot.handlers.get('edition:launch')(boot.trusted('studio-editor.html')).error.code, 'UNTRUSTED_SENDER');
  assert.equal(boot.handlers.get('edition:launch')(boot.trusted(path.basename(launch)), 'extra').error.code, 'UNTRUSTED_SENDER');
  assert.deepEqual(plain(await boot.handlers.get('desktop:enter')(boot.trusted(path.basename(launch)))), { ok: true, result: { surface: 'YUR Athletics' } });
  assert.deepEqual(boot.window.loaded, [launch, path.join(src, 'studio-editor.html')]);
});
