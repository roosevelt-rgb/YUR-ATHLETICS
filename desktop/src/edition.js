'use strict';

// Optional product edition chosen by its trusted launcher (YUR_EDITION). Unset, the
// default YUR AI Desktop is unchanged: loadEdition() returns null and desktopIdentity()
// returns the Desktop's own title, profile folder and launch page. An edition brands
// the shell and names its sections; it grants no tool, model, filesystem, browser or
// Franklin authority. Native confirmations, action caps and browser policy stay as is.
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'yur/desktop-edition/v1';
// Known editions map to fixed manifests under <app>/editions. Nothing else is read.
const EDITIONS = Object.freeze({ athletics: 'athletics.json' });
const EDITIONS_ROOT = path.resolve(__dirname, '..', 'editions');
const MAX_MANIFEST_BYTES = 64 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const ICON = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\.(?:ico|png)$/;
// Profiles of the default Desktop shells; an edition keeps its state apart from them.
const DESKTOP_PROFILES = Object.freeze(['yur-ai-desktop-unified', 'yur-intelliflow-glider-rc6', 'yur-ai-desktop', 'studio-electron']);
// Pages with their own trust roles can never become an edition's launch page.
const RESERVED_PAGES = Object.freeze(['studio-editor.html', 'factory.html']);
const TAB_KINDS = Object.freeze(['franklin', 'gridiron', 'native']);
// Franklin's Gridiron tools (memo step 5) live in a fixed file beside this one, never
// at a manifest path. It is required only when an edition is loaded.
const GRIDIRON_SERVICE = path.join(__dirname, 'franklin-gridiron.js');
const SERVICE_METHODS = Object.freeze(['accepts', 'isReadOnly', 'validate', 'confirmationRequirements', 'execute', 'catalog', 'dispose']);
// Franklin actions an edition appends to the host authority list, in the order of
// foundry/work_desktop.py. They live here, not in the service module, so franklin-host.js lists
// them without loading that module; a missing module then leaves the actions unconnected
// instead of stopping the app.
const EDITION_ACTIONS = Object.freeze({ athletics: Object.freeze(['gridiron_tools', 'gridiron_call']) });
const editionActions = (env = process.env) => typeof env?.YUR_EDITION === 'string' && Object.hasOwn(EDITION_ACTIONS, env.YUR_EDITION) ? EDITION_ACTIONS[env.YUR_EDITION] : Object.freeze([]);
const warn = message => console.warn(message);

function fail(message) {
  const error = new Error('Edition manifest: ' + message);
  error.code = 'EDITION_INVALID';
  throw error;
}

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, required, optional, label) {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(label + ' requires its exact fields.');
}

function text(value, label, max, min = 1) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < min || value.length > max
      || /[\x00-\x1f\x7f]/.test(value)) fail('invalid ' + label + '.');
}

function slug(value, label, max = 64) {
  if (typeof value !== 'string' || value.length > max || !SLUG.test(value)) fail('invalid ' + label + '.');
}

function validateBrand(brand) {
  exact(brand, ['title', 'product_id', 'user_data', 'launch_page', 'icon'], [], 'brand');
  text(brand.title, 'brand title', 80);
  slug(brand.product_id, 'product id');
  slug(brand.user_data, 'profile folder');
  if (DESKTOP_PROFILES.includes(brand.user_data)) fail('an edition cannot share the YUR AI Desktop profile.');
  if (typeof brand.launch_page !== 'string' || brand.launch_page.length > 96 || !PAGE.test(brand.launch_page)
      || RESERVED_PAGES.includes(brand.launch_page)) fail('the launch page must be its own .html file in src/.');
  if (typeof brand.icon !== 'string' || brand.icon.length > 160 || !ICON.test(brand.icon)) fail('the icon must be an .ico or .png path under src/.');
}

// The sport is a lower-case slug (basketball, track-and-field, ...). Nothing in the shell,
// launch page or prompt assumes one sport: they read sport and position from here. The throwing
// hand is optional (a swimmer or striker has none); without it the play art takes the right side.
function validateAthlete(athlete) {
  exact(athlete, ['id', 'sport', 'display_name', 'position', 'position_code', 'class_of'], ['throws'], 'athlete');
  slug(athlete.id, 'athlete id');
  slug(athlete.sport, 'sport', 32);
  text(athlete.display_name, 'athlete name', 80);
  text(athlete.position, 'athlete position', 40);
  if (typeof athlete.position_code !== 'string' || !/^[A-Z]{1,4}$/.test(athlete.position_code)) fail('invalid position code.');
  if (Object.hasOwn(athlete, 'throws') && !['left', 'right'].includes(athlete.throws)) fail('invalid throwing hand.');
  if (!Number.isInteger(athlete.class_of) || athlete.class_of < 2000 || athlete.class_of > 2100) fail('invalid class year.');
}

// Gridiron serves its pages and API from one loopback origin; 'localhost' would be a
// different origin to the side browser, so only an exact 127.0.0.1 origin is accepted.
function validateGridiron(gridiron) {
  exact(gridiron, ['origin', 'embed_param'], [], 'gridiron');
  let url;
  try { url = new URL(gridiron.origin); } catch { fail('invalid Gridiron origin.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== gridiron.origin) fail('the Gridiron origin must be exactly http://127.0.0.1:<port>.');
  if (typeof gridiron.embed_param !== 'string' || !/^[a-z][a-z0-9_]{0,31}=[a-z0-9_]{1,32}$/i.test(gridiron.embed_param)) fail('invalid Gridiron embed parameter.');
  return url.origin;
}

function localWindowsPath(file, extension) {
  return typeof file === 'string' && file.length <= 1024 && /^[A-Za-z]:\\/.test(file) && !/[\x00-\x1f\x7f<>:"|?*]/.test(file.slice(2))
    && path.win32.normalize(file) === file && !file.split('\\').some(part => part === '.' || part === '..' || !part)
    && path.win32.extname(file).toLowerCase() === extension;
}

// The edition pins the process its Gridiron tools start (command and args); the owner's MCP
// config must name the same ones, so that file can switch the tools off but never choose a process.
function validateGridironMcp(mcp) {
  exact(mcp, ['config_path', 'server', 'command', 'args'], [], 'gridiron_mcp');
  if (!localWindowsPath(mcp.config_path, '.json')) fail('the Gridiron MCP config must be an absolute local .json path.');
  if (typeof mcp.server !== 'string' || mcp.server.length > 64 || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(mcp.server)) fail('invalid Gridiron MCP server name.');
  if (!localWindowsPath(mcp.command, '.exe')) fail('the Gridiron MCP command must be an absolute local .exe path.');
  if (!Array.isArray(mcp.args) || mcp.args.length > 16
      || mcp.args.some(arg => typeof arg !== 'string' || !arg || arg.length > 2048 || /[\x00-\x1f\x7f]/.test(arg))) fail('the Gridiron MCP arguments must be at most 16 plain strings.');
}

function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 8) fail('tab_groups must list 1 to 8 groups.');
  const ids = new Set();
  for (const group of groups) {
    exact(group, ['id', 'label'], [], 'tab group');
    slug(group.id, 'tab group id', 40);
    text(group.label, 'tab group label', 40, 0);
    if (ids.has(group.id)) fail('duplicate tab group ' + group.id + '.');
    ids.add(group.id);
  }
  return ids;
}

// A section path stays on the Gridiron origin and is already canonical, so encoded
// traversal, fragments, protocol-relative or backslash forms are all refused. A section is a
// page, never one of Gridiron's /api/ routes, which return whole records without a login.
function validatePath(value, origin) {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//')
      || /[\\\s\x00-\x1f\x7f#]/.test(value) || /^\/api(?:[/?]|$)/i.test(value)) fail('invalid Gridiron section path.');
  let url;
  try { url = new URL(value, origin); } catch { fail('invalid Gridiron section path.'); }
  if (url.origin !== origin || url.pathname + url.search !== value) fail('a Gridiron section path must stay canonical on its origin.');
}

function validateTabs(tabs, groups, origin) {
  if (!Array.isArray(tabs) || tabs.length < 1 || tabs.length > 24) fail('tabs must list 1 to 24 sections.');
  const ids = new Set();
  for (const tab of tabs) {
    exact(tab, ['id', 'label', 'kind'], ['path', 'group', 'badge'], 'tab');
    slug(tab.id, 'tab id', 40);
    text(tab.label, 'tab label', 40);
    if (ids.has(tab.id)) fail('duplicate tab ' + tab.id + '.');
    ids.add(tab.id);
    if (!TAB_KINDS.includes(tab.kind)) fail('unknown tab kind for ' + tab.id + '.');
    if ((tab.kind === 'gridiron') !== Object.hasOwn(tab, 'path')) fail('only Gridiron tabs have a path (' + tab.id + ').');
    if (tab.kind === 'gridiron') validatePath(tab.path, origin);
    if (Object.hasOwn(tab, 'group') && !groups.has(tab.group)) fail('tab ' + tab.id + ' names an unknown group.');
    if (Object.hasOwn(tab, 'badge')) slug(tab.badge, 'badge', 40);
  }
}

function validateEdition(manifest, name) {
  exact(manifest, ['$schema', 'edition_id', 'brand', 'athlete', 'gridiron', 'gridiron_mcp', 'tabs', 'tab_groups'], [], 'the edition');
  if (manifest.$schema !== SCHEMA) fail('unsupported schema.');
  if (manifest.edition_id !== name) fail('edition_id does not match YUR_EDITION.');
  validateBrand(manifest.brand);
  validateAthlete(manifest.athlete);
  const origin = validateGridiron(manifest.gridiron);
  validateGridironMcp(manifest.gridiron_mcp);
  validateTabs(manifest.tabs, validateGroups(manifest.tab_groups), origin);
  return manifest;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// Unset -> null. Unknown -> null and logged (the default Desktop starts). A known
// edition whose manifest is missing or invalid fails closed instead of starting as
// something else with unvalidated paths.
function loadEdition({ env = process.env, root = EDITIONS_ROOT, log = warn } = {}) {
  const requested = env.YUR_EDITION;
  if (requested === undefined || requested === '') return null;
  if (typeof requested !== 'string' || !Object.hasOwn(EDITIONS, requested)) {
    log(`[edition] Unknown YUR_EDITION ${JSON.stringify(String(requested).slice(0, 64))}; starting YUR AI Desktop without an edition.`);
    return null;
  }
  let raw;
  try { raw = fs.readFileSync(path.join(root, EDITIONS[requested])); }
  catch (error) { fail(`${EDITIONS[requested]} could not be read (${error.code || 'unreadable'}).`); }
  if (raw.length > MAX_MANIFEST_BYTES) fail('the manifest exceeds its 64 KiB budget.');
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { fail('the manifest is not valid JSON.'); }
  return deepFreeze(validateEdition(manifest, requested));
}

// Window title, profile folder, launch page and icon. Without an edition these are
// exactly the values main.js used before editions existed. A missing edition launch
// page or icon (brand assets ship separately) falls back to the Desktop page / no icon.
function desktopIdentity({ edition = null, gliderRc6 = false, srcRoot = __dirname, exists = fs.existsSync, log = warn } = {}) {
  const desktop = Object.freeze({
    title: gliderRc6 ? 'IntelliFlow — YUR AI Desktop' : 'YUR AI Desktop',
    userData: gliderRc6 ? 'yur-intelliflow-glider-rc6' : 'yur-ai-desktop-unified',
    launchFile: path.join(srcRoot, gliderRc6 ? 'glider-launch.html' : 'yur-ai-launch.html'),
    icon: null,
  });
  if (!edition) return desktop;
  const launchFile = path.join(srcRoot, edition.brand.launch_page);
  const icon = path.join(srcRoot, ...edition.brand.icon.split('/'));
  const hasLaunch = exists(launchFile), hasIcon = exists(icon);
  if (!hasLaunch) log(`[edition] ${edition.edition_id}: src/${edition.brand.launch_page} is missing; using the Desktop launch page.`);
  if (!hasIcon) log(`[edition] ${edition.edition_id}: src/${edition.brand.icon} is missing; the window keeps the default icon.`);
  return Object.freeze({ title: edition.brand.title, userData: edition.brand.user_data,
    launchFile: hasLaunch ? launchFile : desktop.launchFile, icon: hasIcon ? icon : null });
}

// Read-only renderer view for 'edition:info'. The MCP config path and profile folder
// stay in the main process.
function editionInfo(edition, { gridironService = false } = {}) {
  if (!edition) return { enabled: false };
  return JSON.parse(JSON.stringify({ enabled: true, edition_id: edition.edition_id, title: edition.brand.title,
    product_id: edition.brand.product_id, athlete: edition.athlete, gridiron: edition.gridiron,
    tabs: edition.tabs, tab_groups: edition.tab_groups, gridiron_service: gridironService ? 'registered' : 'unavailable' }));
}

// Read-only view for the edition's launch page ('edition:launch', launch page only): the title and
// the athlete fields its card and play art show. The Desktop answers { enabled: false }.
function editionLaunchInfo(edition) {
  if (!edition) return { enabled: false };
  const { display_name, sport, position, throws, class_of } = edition.athlete;
  return { enabled: true, edition_id: edition.edition_id, title: edition.brand.title,
    athlete: { display_name, sport, position, ...(throws ? { throws } : {}), class_of } };
}

// Edition only: the path rule for Gridiron in the side browser. Gridiron serves its pages and its
// /api/ routes from one loopback port, and the routes answer without a login (whole records, family
// contacts included). Any loopback address on that port is Gridiron (127.0.0.1, localhost, [::1]),
// so the rule keys on the port, not the origin string. A refused address returns the reason; any
// other address returns ''. Paths are checked decoded, case-folded and with repeated slashes
// collapsed, so encoded or doubled forms of /api/ are refused too. It adds no confirmation and
// grants nothing: every address it passes still meets the browser's own policy.
const GRIDIRON_API_REFUSED = 'Gridiron /api/ addresses are not opened in the side browser: they return raw records, family contact details included.';
const gridironPlayerRefused = id => `The side browser opens only this athlete's Gridiron pages (/player/${id}); other athletes' pages are not opened.`;
// Whether an address is Gridiron's: any loopback host on the manifest origin's port.
function gridironAddress(edition, value) {
  const { isLoopback } = require('./foundry-transport');
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(url.hostname)
      || (url.port || (url.protocol === 'https:' ? '443' : '80')) !== new URL(edition.gridiron.origin).port) return null;
  return url;
}
// One exception, for frames only: Gridiron's player card shows this athlete's own report files (the
// resume, the season film study) in frames loaded from /api/athletes/<id>/reports/<name>. A frame may
// load exactly those (context { subFrame: true }); no top-level load may, and Franklin's page reads
// never include frames.
function gridironNavigationGuard(edition) {
  if (!edition) return null;
  const athlete = edition.athlete.id.toLowerCase(), reports = '/api/athletes/' + athlete + '/reports/';
  const ownReport = pathname => pathname.startsWith(reports) && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(pathname.slice(reports.length));
  return (value, { subFrame = false } = {}) => {
    const url = gridironAddress(edition, value);
    if (!url) return '';
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return GRIDIRON_API_REFUSED; }
    pathname = pathname.replace(/[\\/]+/g, '/').toLowerCase();
    if (/^\/api(?:\/|$)/.test(pathname)) return subFrame === true && ownReport(pathname) ? '' : GRIDIRON_API_REFUSED;
    const player = /^\/player\/([^/]+)/.exec(pathname);
    if (player && player[1] !== athlete) return gridironPlayerRefused(edition.athlete.id);
    return '';
  };
}

// Edition only: the side browser's finish for Gridiron pages (src/<edition>-brand/gridiron-embed.css),
// until Gridiron has an embed view of its own. A bounded stylesheet that loads nothing (no url(),
// @import or expression(), and no escapes that could spell them) is applied to Gridiron's addresses
// only; anything else gets ''. Without an edition or a usable stylesheet there is no finish (null) and
// the side browser is unchanged.
const PAGE_STYLE_LIMIT = 32 * 1024;
function gridironPageStyle(edition, css) {
  if (!edition || typeof css !== 'string' || !css.trim() || css.length > PAGE_STYLE_LIMIT
      || /url\s*\(|@import|expression\s*\(|\\|<\/?style/i.test(css)) return null;
  return value => gridironAddress(edition, value) ? css : '';
}

// Adds an edition service to Franklin's desktopServices. Without one the existing
// object is returned unchanged. Existing services keep every action they accept, and an
// action neither accepts (browser_click, coding_*, media_*) is answered by the existing
// services exactly as without an edition, so the edition service never decides whether
// such an action needs its confirmation dialog.
function composeDesktopServices(base, extra) {
  if (!extra) return base;
  const owner = action => base.accepts(action) ? base : extra.accepts(action) ? extra : base;
  return Object.freeze({
    accepts: action => base.accepts(action) || extra.accepts(action),
    isReadOnly: (action, ...args) => owner(action).isReadOnly(action, ...args),
    catalog: () => [...base.catalog(), ...extra.catalog()],
    validate: (action, ...args) => owner(action).validate(action, ...args),
    confirmationRequirements: (action, ...args) => owner(action).confirmationRequirements(action, ...args),
    execute: (action, ...args) => owner(action).execute(action, ...args),
  });
}

// createFranklinGridiron({ edition, deny, getSettings, openPage }) must not spawn or
// read anything while constructing; a missing module leaves Franklin without
// Gridiron tools and is logged.
function loadGridironService(edition, options = {}, { modulePath = GRIDIRON_SERVICE, exists = fs.existsSync, log = warn } = {}) {
  if (!edition) return null;
  if (!exists(modulePath)) {
    log(`[edition] ${edition.edition_id}: src/${path.basename(modulePath)} is not installed; Franklin has no Gridiron tools.`);
    return null;
  }
  const { createFranklinGridiron } = require(modulePath);
  if (typeof createFranklinGridiron !== 'function') throw new Error(path.basename(modulePath) + ' must export createFranklinGridiron().');
  const service = createFranklinGridiron({ ...options, edition });
  if (SERVICE_METHODS.some(method => typeof service?.[method] !== 'function')) throw new Error('The Gridiron service lacks the Franklin service interface.');
  return service;
}

module.exports = { SCHEMA, EDITIONS, EDITIONS_ROOT, DESKTOP_PROFILES, GRIDIRON_SERVICE, SERVICE_METHODS, EDITION_ACTIONS,
  editionActions, loadEdition, validateEdition, deepFreeze, desktopIdentity, editionInfo, editionLaunchInfo, composeDesktopServices, loadGridironService,
  gridironNavigationGuard, gridironPageStyle };
