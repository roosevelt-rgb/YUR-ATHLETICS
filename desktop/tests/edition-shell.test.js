'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const shell = require('../src/edition-shell');
const { editionInfo, loadEdition } = require('../src/edition');
const { create } = require('../src/franklin-view');

// Renderer-only checks: no Electron window, browser, model or network is started.
const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
// The athlete manifest (editions/athletics.json) is each owner's own file and is never committed. These tests read
// the committed sample, tests/fixtures/athletics.sample.json, from a temporary editions folder.
const SAMPLE_FILE = path.join(__dirname, 'fixtures', 'athletics.sample.json');
const sampleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-edition-sample-'));
fs.copyFileSync(SAMPLE_FILE, path.join(sampleRoot, 'athletics.json'));
after(() => fs.rmSync(sampleRoot, { recursive: true, force: true }));
const manifest = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
const athletics = () => editionInfo(loadEdition({ env: { YUR_EDITION: 'athletics' }, root: sampleRoot, log: () => {} }), { gridironService: false });
// The athlete is read from the manifest, so these tests name no athlete themselves (they ship in the edition).
const origin = manifest.gridiron.origin, card = origin + '/player/' + manifest.athlete.id;
// A section's side-browser address: its canonical path plus the manifest's embed parameter.
const embedded = path => { const url = new URL(path, origin); const [name, value] = manifest.gridiron.embed_param.split('='); url.searchParams.set(name, value); return url.href; };
const flush = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve)); };

// A small DOM double: enough tree, class, dataset, event and selector support for the views.
class Node {
  constructor(tag, doc) {
    this.tagName = String(tag).toLowerCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = {}; this.hidden = false; this.disabled = false; this.id = ''; this._class = ''; this._text = '';
    const names = () => new Set(this._class.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...values) => { const set = names(); values.forEach(value => set.add(value)); this._class = [...set].join(' '); },
      remove: (...values) => { const set = names(); values.forEach(value => set.delete(value)); this._class = [...set].join(' '); },
      toggle: (value, force) => { const set = names(), on = force === undefined ? !set.has(value) : Boolean(force); if (on) set.add(value); else set.delete(value); this._class = [...set].join(' '); return on; },
      contains: value => names().has(value),
    };
  }
  get className() { return this._class; }
  set className(value) { this._class = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = String(value); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.documentElement; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); this.ownerDocument.appended(node, this); } }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) { for (const node of nodes.slice().reverse()) { node.remove(); node.parentNode = this; this.children.unshift(node); } }
  before(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
  after(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  dispatch(type, detail = {}) { for (const callback of this.listeners[type] || []) callback({ type, target: this, ...detail }); }
  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector.trim().split(/\s+/))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
function simple(node, selector) {
  const match = /^([a-z][a-z0-9-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/.exec(selector);
  assert.ok(match, 'Unsupported selector ' + selector);
  return (!match[1] || node.tagName === match[1]) && (!match[2] || node.id === match[2])
    && match[3].split('.').filter(Boolean).every(name => node.classList.contains(name));
}
function matches(node, tokens) {
  if (!simple(node, tokens.at(-1))) return false;
  if (tokens.length === 1) return true;
  if (tokens.at(-2) === '>') return Boolean(node.parentNode) && matches(node.parentNode, tokens.slice(0, -2));
  for (let parent = node.parentNode; parent; parent = parent.parentNode) if (matches(parent, tokens.slice(0, -1))) return true;
  return false;
}
function documentDouble() {
  const doc = { activeElement: null, defaultView: null, appended(node, parent) { if (node.tagName === 'link' && parent === doc.head) { doc.links.push(node.getAttribute('href') || node.href); queueMicrotask(() => node.dispatch('load')); } }, links: [] };
  doc.createElement = tag => new Node(tag, doc);
  doc.createElementNS = (_namespace, tag) => new Node(tag, doc);
  doc.createTextNode = value => { const node = new Node('#text', doc); node._text = String(value); return node; };
  doc.documentElement = doc.createElement('html'); doc.head = doc.createElement('head'); doc.body = doc.createElement('body');
  doc.documentElement.append(doc.head, doc.body);
  doc.getElementById = id => descendants(doc.documentElement).find(node => node.id === id) || null;
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  return doc;
}
function element(doc, tag, { id = '', className = '', text = '' } = {}) {
  const node = doc.createElement(tag); node.id = id; node.className = className; if (text) node.textContent = text; return node;
}
class Event { constructor(type) { this.type = type; } }
class CustomEvent extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } }

test('the default Desktop and a disabled edition produce no edition model', () => {
  for (const info of [undefined, null, {}, { enabled: false }, { ...athletics(), enabled: 'true' }, { ...athletics(), tabs: null }]) assert.equal(shell.navModel(info), null);
  assert.deepEqual(editionInfo(loadEdition({ env: {} })), { enabled: false });
});

test('the left nav comes from the manifest: Franklin, the Athlete and Recruiting groups, then Approvals and Settings', () => {
  const model = shell.navModel(athletics());
  assert.equal(model.edition_id, 'athletics'); assert.equal(model.title, 'YUR Athletics');
  assert.deepEqual(model.groups.map(group => [group.id, group.label]), [[null, ''], ['athlete', 'Athlete'], ['recruiting', 'Recruiting'], ['desk', 'Desk']]);
  const items = model.groups.flatMap(group => group.items);
  assert.equal(items.length, 12);
  assert.deepEqual(items.map(item => item.id), manifest.tabs.map(tab => tab.id));
  assert.deepEqual(items.map(item => item.label), manifest.tabs.map(tab => tab.label));
  assert.equal(model.embed, 'embed=1');
  for (const tab of manifest.tabs.filter(tab => tab.kind === 'gridiron')) {
    const item = items.find(entry => entry.id === tab.id);
    assert.equal(item.action, 'gridiron');
    // The side browser opens Gridiron's embed view of the section; the page key is the canonical path.
    assert.equal(item.url, embedded(tab.path), tab.id);
    assert.equal(item.page, shell.pageKey(origin + tab.path), tab.id);
    assert.equal('pending_route' in item, false, 'Gridiron serves every ?tab= section; nothing is pending');
  }
  const byId = Object.fromEntries(items.map(item => [item.id, item]));
  assert.equal(byId.franklin.action, 'franklin'); assert.equal(byId.franklin.url, undefined);
  assert.equal(byId.settings.action, 'settings'); assert.equal(byId.settings.url, undefined);
  assert.equal(byId.approvals.action, 'approvals');
  assert.equal(byId.approvals.url, embedded('/player/' + manifest.athlete.id + '?tab=outreach'));
  assert.equal(byId.approvals.badge, 'pending-approvals');
  // College board opens the athlete's own board (the card's Board tab), never the generic matcher.
  assert.equal(byId['college-board'].url, embedded('/player/' + manifest.athlete.id + '?tab=board'));
  assert.equal(shell.athleteLine(model.athlete), `${manifest.athlete.display_name} · ${manifest.athlete.position_code} · Class of ${manifest.athlete.class_of}`);
  assert.equal(model.brand.wordmark, 'YUR ATHLETICS');
  assert.deepEqual(Object.values(model.brand).filter(value => value.endsWith('.svg')),
    ['athletics-brand/brand/lockup.svg', 'athletics-brand/brand/lockup-light.svg', 'athletics-brand/brand/y-mark.svg', 'athletics-brand/brand/mark-flat.svg']);
  for (const file of Object.values(model.brand).filter(value => value.endsWith('.svg'))) assert.ok(fs.existsSync(path.join(src, file)), file);
});

test('a section URL can only be a canonical path on the exact loopback Gridiron origin', () => {
  const origin = 'http://127.0.0.1:3000';
  assert.equal(shell.sectionUrl(origin, '/coaches'), 'http://127.0.0.1:3000/coaches');
  // The embed parameter is added only after the path is checked, and only in its strict name=value form.
  assert.equal(shell.sectionUrl(origin, '/coaches', 'embed=1'), 'http://127.0.0.1:3000/coaches?embed=1');
  assert.equal(shell.sectionUrl(origin, '/player/x?tab=film', 'embed=1'), 'http://127.0.0.1:3000/player/x?tab=film&embed=1');
  for (const embed of ['embed', 'embed=1&x=2', '=1', 'embed=a b', 'embed=1#x']) assert.equal(shell.sectionUrl(origin, '/coaches', embed), 'http://127.0.0.1:3000/coaches', embed);
  assert.throws(() => shell.sectionUrl(origin, '/api/athletes', 'embed=1'), /Gridiron/);
  // An address and its section match with or without the embed parameter, query order ignored.
  assert.equal(shell.pageKey('http://127.0.0.1:3000/player/x?embed=1&tab=film', 'embed=1'), shell.pageKey('http://127.0.0.1:3000/player/x?tab=film'));
  assert.notEqual(shell.pageKey('http://127.0.0.1:3000/player/x?tab=board'), shell.pageKey('http://127.0.0.1:3000/player/x'));
  assert.equal(shell.pageKey('not a url'), '');
  for (const path of ['//evil.example/x', 'http://evil.example/', 'coaches', '/a\\b', '/a#b', '/a b', '/%2e%2e/secrets', '/x/../y', '/a\u0000', '/' + 'a'.repeat(512),
    '/api/athletes', '/API/athletes/x', '/api', '/api?x=1'])
    assert.throws(() => shell.sectionUrl(origin, path), /Gridiron/, path);
  for (const bad of ['http://localhost:3000', 'https://127.0.0.1:3000', 'http://127.0.0.1', 'http://127.0.0.1:70000', 'http://127.0.0.1:3000/'])
    assert.throws(() => shell.sectionUrl(bad, '/coaches'), /origin/, bad);
  const info = athletics(); info.tabs = info.tabs.map(tab => tab.id === 'coaches' ? { ...tab, path: '//evil.example/coaches' } : tab);
  assert.throws(() => shell.navModel(info), /Gridiron/);
});

test('rendered sections are Pages-menu buttons whose clicks reach the right handler and target', async () => {
  const doc = documentDouble(), nav = element(doc, 'nav'), calls = [];
  doc.body.append(nav);
  const model = shell.navModel(athletics());
  const controller = shell.renderNav(nav, model, Object.fromEntries(['franklin', 'gridiron', 'approvals', 'settings'].map(action => [action, item => calls.push([action, item.id, item.url ?? null])])));
  assert.ok(nav.classList.contains('yc-nav') && nav.classList.contains('yc-edition-nav'));
  const buttons = nav.children.filter(node => node.tagName === 'button');
  assert.equal(buttons.length, 12);
  // The glider frame's Pages menu reads '.yc-nav > button' and the first <span> as the name.
  assert.deepEqual(buttons.map(button => button.querySelector('span').textContent), manifest.tabs.map(tab => tab.label));
  assert.deepEqual(nav.children.filter(node => node.tagName === 'p').map(node => node.textContent), ['Athlete', 'Recruiting', 'Desk']);
  assert.equal(nav.children.filter(node => node.tagName === 'hr').length, 0);
  // Every row is one plain 40px row: a 6px intensity square before its label, no mark or subtitle (Welcome/Main).
  for (const button of buttons) {
    assert.equal(button.children[0].tagName, 'i'); assert.ok(button.children[0].classList.contains('yc-edition-dot'));
    assert.equal(button.children[0].getAttribute('aria-hidden'), 'true');
    assert.equal(button.querySelector('img'), null); assert.equal(button.querySelector('.yc-edition-tab-sub'), null);
  }
  // A section's tooltip is its address, with no pending-route note.
  for (const button of buttons.filter(button => button.dataset.editionAction === 'gridiron'))
    assert.equal(button.title, embedded(manifest.tabs.find(tab => tab.id === button.dataset.editionTab).path));
  controller.select('franklin');
  for (const button of buttons) button.click();
  await flush();
  assert.deepEqual(calls, manifest.tabs.map(tab => [tab.kind === 'native' ? tab.id : tab.kind, tab.id,
    tab.kind === 'gridiron' ? embedded(tab.path) : tab.id === 'approvals' ? embedded('/player/' + manifest.athlete.id + '?tab=outreach') : null]));
  // A Gridiron section opens beside the active page, so its click leaves the active row as it was;
  // the native sections (Approvals, Settings) become the active page.
  assert.equal(buttons.at(-1).getAttribute('aria-current'), 'page');
  assert.equal(buttons.filter(button => button.classList.contains('active')).length, 1);
  controller.select('franklin');
  buttons.find(button => button.dataset.editionTab === 'highlights').click(); await flush();
  assert.equal(controller.active(), 'franklin');
  assert.equal(controller.buttons.get('franklin').getAttribute('aria-current'), 'page');
  controller.select(null);
  assert.equal(buttons.filter(button => button.getAttribute('aria-current')).length, 0);
  // Open in the side browser: a blue square and an 'open' marker on that one section; null clears it.
  controller.setOpen('highlights');
  assert.equal(controller.open(), 'highlights');
  assert.equal(controller.buttons.get('highlights').dataset.open, 'true');
  assert.equal(controller.buttons.get('highlights').querySelector('.yc-edition-open').hidden, false);
  assert.equal(buttons.filter(button => button.dataset.open).length, 1);
  assert.equal(controller.buttons.get('highlights').getAttribute('aria-description'), 'open in the side browser');
  // A label that would not fit beside the 'open' word keeps its room: the word steps aside, the square and description stay.
  const longLabel = controller.buttons.get('highlights').querySelector('.yc-edition-tab-label');
  longLabel.scrollWidth = 160; longLabel.clientWidth = 137;
  controller.setOpen('highlights');
  assert.equal(controller.buttons.get('highlights').querySelector('.yc-edition-open').hidden, true);
  assert.equal(controller.buttons.get('highlights').dataset.open, 'true');
  assert.equal(controller.buttons.get('highlights').getAttribute('aria-description'), 'open in the side browser');
  longLabel.scrollWidth = 120;
  controller.setOpen('highlights');
  assert.equal(controller.buttons.get('highlights').querySelector('.yc-edition-open').hidden, false);
  controller.setOpen('settings'); assert.equal(controller.open(), null, 'only a Gridiron section can be open in the side browser');
  controller.setOpen(null);
  assert.equal(buttons.filter(button => button.dataset.open).length, 0);
  assert.equal(controller.buttons.get('highlights').querySelector('.yc-edition-open').hidden, true);
  assert.equal(controller.buttons.get('highlights').getAttribute('aria-description'), null);
  const badge = controller.buttons.get('approvals').querySelector('.yc-edition-badge');
  assert.equal(badge.hidden, true);
  controller.setBadge('approvals', 3); assert.equal(badge.hidden, false); assert.equal(badge.textContent, '3');
  assert.equal(badge.getAttribute('aria-label'), '3 waiting for you');
  controller.setBadge('approvals', 0); assert.equal(badge.hidden, true); assert.equal(badge.getAttribute('aria-label'), null);
  const modes = element(doc, 'nav', { className: 'yc-nav' }), chosen = [];
  modes.append(element(doc, 'button', { id: 'existing' }));
  shell.renderModes(modes, mode => chosen.push(mode));
  assert.deepEqual(modes.children.map(node => node.querySelector('span')?.textContent ?? node.id), ['Chat', 'Work', 'Code', 'existing']);
  modes.children[1].click(); assert.deepEqual(chosen, ['work']);
});

test('brand art keeps the Orbitron wordmark until a logo file loads, and missing art never shows broken', () => {
  const doc = documentDouble();
  const holder = shell.logo(doc, 'athletics-brand/brand/lockup.svg', 'YUR ATHLETICS');
  const [words, image] = holder.children;
  assert.equal(holder.getAttribute('aria-label'), 'YUR ATHLETICS');
  assert.equal(words.textContent, 'YUR ATHLETICS'); assert.equal(words.hidden, false); assert.equal(image.hidden, true);
  image.naturalWidth = 320; image.dispatch('load');
  assert.equal(image.hidden, false); assert.equal(words.hidden, true);
  const missing = shell.logo(doc, 'athletics-brand/brand/lockup.svg', 'YUR ATHLETICS');
  missing.children[1].dispatch('error');
  assert.equal(missing.children.length, 1); assert.equal(missing.children[0].hidden, false);
  const frame = element(doc, 'div', { id: 'glider-frame' }), header = element(doc, 'header'), nav = element(doc, 'nav');
  header.append(element(doc, 'strong', { text: '◤◢ INTELLIFLOW' }), element(doc, 'span', { text: 'sovereign shell workbench' }), element(doc, 'span'),
    element(doc, 'button', { id: 'glider-min' }), element(doc, 'button', { id: 'glider-max' }), element(doc, 'button', { id: 'glider-close' }));
  nav.append(element(doc, 'button', { id: 'glider-desktop', text: 'YUR AI Desktop' })); frame.append(header, nav); doc.body.append(frame);
  let homes = 0;
  const status = shell.brandFrame(frame, shell.navModel(athletics()), { onHome: () => homes++ });
  // One title row (Welcome/Main): the lockup is a home button, then the athlete chip, Franklin's status
  // just before the window controls.
  assert.equal(header.children[0].textContent, 'YUR ATHLETICS');
  const home = header.children[0].children[0];
  assert.equal(home.tagName, 'button'); assert.equal(home.id, 'yc-edition-home');
  assert.equal(home.getAttribute('aria-label'), 'YUR Athletics, show Franklin');
  assert.equal(home.querySelector('img').src, 'athletics-brand/brand/lockup.svg');
  home.click(); assert.equal(homes, 1);
  const chip = header.children[1];
  assert.ok(chip.classList.contains('yc-edition-chip'));
  assert.equal(chip.children[0].textContent, manifest.athlete.display_name);
  assert.equal(chip.children[1].textContent, `${manifest.athlete.position_code}, class of ${manifest.athlete.class_of}`);
  const line = header.querySelector('.yc-edition-status');
  assert.equal(header.children.indexOf(line), header.children.indexOf(doc.getElementById('glider-min')) - 1);
  assert.equal(line.getAttribute('role'), 'status');
  assert.equal(line.dataset.state, 'waking'); assert.equal(line.children[1].textContent, 'Franklin is waking');
  for (const [phase, state, words] of [['ready', 'ready', 'Franklin is ready'], ['watching', 'ready', 'Franklin is ready'], ['working', 'working', 'Franklin is working'],
    ['waiting_approval', 'attention', 'Franklin needs you'], ['error', 'attention', 'Franklin needs you'], ['offline', 'off', 'Franklin is offline'], ['unknown-phase', 'waking', 'Franklin is waking']]) {
    status.setPhase(phase); assert.equal(line.dataset.state, state, phase); assert.equal(line.children[1].textContent, words, phase);
  }
  assert.equal(doc.getElementById('glider-desktop').textContent, 'YUR Athletics');
});

test('the side browser toolbar shows the page, Back/Forward/Reload use the browser commands and Close and Take over call back', async () => {
  const doc = documentDouble(), host = element(doc, 'div', { id: 'yc-browser-host' }), pane = element(doc, 'section', { className: 'yc-browser-pane' });
  host.append(pane); doc.body.append(host);
  const model = shell.navModel(athletics()), calls = { back: 0, forward: 0, reload: 0, close: 0, take: 0, states: [], reports: [] };
  let listener = null;
  const api = { browser: { onEvent: callback => { listener = callback; return () => { listener = null; }; },
    state: async () => ({ ok: true, result: { url: embedded('/player/' + manifest.athlete.id + '?tab=film'), canGoBack: true, canGoForward: false, visible: true } }),
    back: async () => { calls.back++; return { ok: true }; }, forward: async () => { calls.forward++; return { ok: false, error: { message: 'fixture forward refused' } }; },
    reload: async () => { calls.reload++; return { ok: true }; } } };
  const bar = shell.renderBrowserBar(host, { api, model, onClose: () => calls.close++, onTakeOver: () => calls.take++, onState: state => calls.states.push(state), report: message => calls.reports.push(message) });
  await flush();
  // Toolbar first, then the notice line, the Desktop pane and the footer note.
  assert.deepEqual(host.children.map(node => node.className), ['yc-edition-browserbar', 'yc-edition-browser-notice', 'yc-browser-pane', 'yc-edition-browser-footer']);
  assert.equal(bar.element.getAttribute('role'), 'toolbar');
  const address = host.querySelector('.yc-edition-address');
  assert.equal(address.children[0].textContent, 'Gridiron');
  assert.equal(address.children[1].textContent, '127.0.0.1:3000/player/' + manifest.athlete.id + '?tab=film', 'the embed parameter is not shown');
  const [back, forward, reload] = bar.element.children;
  assert.equal(back.disabled, false); assert.equal(forward.disabled, true); assert.equal(reload.disabled, false);
  back.click(); forward.click(); reload.click(); await flush();
  assert.deepEqual([calls.back, calls.forward, calls.reload], [1, 1, 1]);
  assert.deepEqual(calls.reports, ['fixture forward refused']);
  assert.equal(host.querySelector('.yc-edition-browser-footer').textContent, 'Franklin opens and reads pages on his own. Clicks and typing ask you first.');
  // Franklin is driving only while he works; Take over goes through his own Stop.
  const driving = host.querySelector('.yc-edition-driving'), take = host.querySelector('.yc-edition-takeover');
  assert.equal(driving.hidden, true); assert.equal(take.hidden, true);
  bar.setDriving(true); assert.equal(driving.hidden, false); assert.equal(take.hidden, false);
  take.click(); assert.equal(calls.take, 1);
  bar.setDriving(false); assert.equal(driving.hidden, true);
  bar.element.children.at(-1).click(); await flush(); assert.equal(calls.close, 1);
  // A refused load is named in the notice line; the next page clears it.
  listener({ type: 'blocked', reason: 'Gridiron /api/ addresses are not opened in the side browser.', url: origin + '/api/athletes' });
  const notice = host.querySelector('.yc-edition-browser-notice');
  assert.equal(notice.hidden, false); assert.match(notice.textContent, /\/api\//);
  listener({ type: 'blocked', reason: 'request-blocked', url: 'https://other.example/' });
  assert.equal(notice.textContent, 'That page was not opened here (request blocked).');
  listener({ type: 'state', state: { url: embedded('/coaches'), visible: true } });
  assert.equal(notice.hidden, true); assert.equal(address.children[1].textContent, '127.0.0.1:3000/coaches');
  assert.equal(calls.states.at(-1).url, embedded('/coaches'));
  listener({ type: 'state', state: { url: 'https://example.com/page', visible: true } });
  assert.equal(address.children[0].textContent, 'example.com');
  bar.dispose();
  assert.deepEqual(host.children.map(node => node.className), ['yc-browser-pane']);
  assert.equal(listener, null);
  assert.equal(shell.renderBrowserBar(host, { api: {}, model }), null, 'without a browser binding nothing is drawn');
});

test('the left nav marks the section whose page the side browser shows, whatever the embed parameter', () => {
  const model = shell.navModel(athletics());
  assert.equal(shell.sectionFor(model, embedded('/player/' + manifest.athlete.id + '?tab=film')), 'film-study');
  assert.equal(shell.sectionFor(model, origin + '/player/' + manifest.athlete.id + '?tab=film'), 'film-study');
  assert.equal(shell.sectionFor(model, origin + '/player/' + manifest.athlete.id), 'my-card');
  assert.equal(shell.sectionFor(model, origin + '/player/' + manifest.athlete.id + '?tab=board&embed=1'), 'college-board');
  assert.equal(shell.sectionFor(model, origin + '/coaches?embed=1'), 'coaches');
  for (const url of [origin + '/player/' + manifest.athlete.id + '?tab=agent', origin + '/matches', 'http://127.0.0.1:3001/coaches', 'https://example.com/', '', 'not a url'])
    assert.equal(shell.sectionFor(model, url), null, url);
});

test('Franklin’s page copy comes from the manifest: his header line, the greeting and four start cards that open their sections', async () => {
  const model = shell.navModel(athletics()), opened = [], asked = [];
  const intro = shell.franklinIntro(model, { openSection: item => opened.push(item.id), ask: text => asked.push(text) });
  const first = manifest.athlete.display_name.split(' ')[0];
  assert.equal(intro.agentLine, first + (/s$/i.test(first) ? '’' : '’s') + ' agent');
  assert.ok(intro.greeting.startsWith('Hey ' + first + '. I’m Franklin, your agent.'));
  assert.equal(intro.placeholder, 'Message Franklin');
  assert.deepEqual(intro.starts.map(start => [start.title, start.page]), [['Go over my film', 'Film study'], ['Show my card', 'My card'],
    ['Find schools that fit', 'College board'], ['Write to a coach', 'Outreach and drafts']]);
  intro.starts[3].select(); await flush();
  assert.deepEqual(opened, ['outreach-drafts']); assert.equal(asked.length, 1); assert.match(asked[0], /nothing sends without my OK/);
  // A start never sends: a busy Franklin refusing the draft is not an error.
  const busy = shell.franklinIntro(model, { ask: () => { throw new Error('busy'); } });
  assert.doesNotThrow(() => busy.starts[0].select());
  // Copy and starts name no sport or position; a manifest without a section drops its start.
  for (const start of intro.starts) assert.doesNotMatch(start.title + start.line + start.prompt, /football|quarterback|\bQB\b|Texas/i);
  const fewer = shell.navModel({ ...athletics(), tabs: athletics().tabs.filter(tab => tab.id !== 'college-board') });
  assert.deepEqual(shell.franklinIntro(fewer).starts.map(start => start.id), ['film-study', 'my-card', 'outreach-drafts']);
  assert.equal(shell.franklinIntro(null).agentLine, 'Your agent');
});

// conversation-view.js: the real edition block and openBrowser, run against doubles.
const conversation = read('src/conversation-view.js');
function slice(from, to) { const start = conversation.indexOf(from), end = conversation.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return conversation.slice(start, end); }
function desktop(info, { withShell = true, failRender = false } = {}) {
  const doc = documentDouble(), calls = { events: [], listeners: [], notices: [], modes: [], details: [], widths: [], navigated: [], settings: 0, franklin: 0, show: 0, render: 0 };
  const conversationRoot = element(doc, 'div', { id: 'yur-conversation' });
  const titlebar = element(doc, 'header', { className: 'yc-titlebar' });
  titlebar.append(element(doc, 'span', { className: 'yc-desktop-mark', text: 'Y' }), element(doc, 'span', { className: 'yc-titlebar-caption', text: 'YUR AI DESKTOP' }));
  const sidebar = element(doc, 'aside', { className: 'yc-sidebar' }), brand = element(doc, 'div', { className: 'yc-sidebar-brand', text: 'YUR AI' });
  const desktopNav = element(doc, 'nav', { className: 'yc-nav' }), settings = element(doc, 'button', { id: 'yc-settings-open', className: 'yc-nav-item' });
  settings.append(element(doc, 'span', { text: 'Settings' })); settings.addEventListener('click', () => calls.settings++);
  desktopNav.append(settings); sidebar.append(brand, element(doc, 'button', { id: 'yc-new-chat' }), desktopNav);
  const main = element(doc, 'main', { id: 'yc-main', className: 'yc-main' });
  const details = element(doc, 'aside', { id: 'yc-details', className: 'yc-detail-panel' }), browserHost = element(doc, 'div', { id: 'yc-browser-host', className: 'yc-browser-host' });
  details.append(browserHost);
  main.append(element(doc, 'header', { className: 'yc-topbar' }), element(doc, 'div', { id: 'yc-scroll', className: 'yc-scroll' }), element(doc, 'textarea', { id: 'yc-input' }), element(doc, 'input', { id: 'yc-browser-address' }), details);
  conversationRoot.append(titlebar, sidebar, main); doc.body.append(conversationRoot);
  const receipts = element(doc, 'details', { id: 'franklin-timeline' }); receipts.open = false; doc.body.append(receipts);
  const window = { innerWidth: 1440, yurEditionShell: withShell ? shell : undefined, dispatchEvent: event => calls.events.push(event), addEventListener: (type, callback) => calls.listeners.push([type, callback]), yurOpenFranklin: () => calls.franklin++,
    yurAskFranklin: text => { (calls.asked ||= []).push(text); } };
  const browser = { onEvent: callback => { calls.browserListener = callback; return () => {}; }, state: async () => ({ ok: true, result: { url: '' } }),
    back: async () => ({ ok: true }), forward: async () => ({ ok: true }), reload: async () => ({ ok: true }) };
  const context = vm.createContext({
    window, document: doc, root: conversationRoot, $: id => doc.getElementById(id), api: { edition: { info: async () => info }, browser }, Event, CustomEvent,
    edition: null, editionNav: null, editionBrowserSized: false, editionFranklinId: null, editionLastSection: '', currentSection: null, detailWidth: 480, detailsOpen: false, detailTab: 'work',
    showConversation: () => { calls.show++; context.currentSection = null; }, notice: message => calls.notices.push(message),
    render: () => { calls.render++; if (failRender) throw new Error('fixture render failure'); },
    setConversationMode: mode => { calls.modes.push(mode); return true; }, toggleDetails: (value, tab) => calls.details.push([value, tab]),
    setDetailWidth: width => { calls.widths.push(width); context.detailWidth = width; }, ensureBrowser: () => ({ navigate: async url => { calls.navigated.push(url); } }),
  });
  vm.runInContext(slice('  function openBrowser() {', '  function modelReadiness() {') + slice('  // ─── Product edition', '  newSession(); initVoice();'), context);
  return { doc, calls, context, window, sidebar, brand, desktopNav, main, receipts, details, browserHost, root: conversationRoot };
}

test('without an edition the Desktop renders no edition nav, Franklin page, brand or stylesheet, and opens its browser as before', async () => {
  for (const [info, options] of [[{ enabled: false }, {}], [undefined, {}], [athletics(), { withShell: false }]]) {
    const f = desktop(info, options);
    await flush();
    assert.equal(f.context.edition, null);
    assert.deepEqual(f.sidebar.children.map(node => node.className), ['yc-sidebar-brand', '', 'yc-nav']);
    assert.equal(f.brand.textContent, 'YUR AI'); assert.equal(f.desktopNav.children.length, 1);
    assert.equal(f.doc.querySelector('.yc-desktop-mark').textContent, 'Y'); assert.equal(f.doc.querySelector('.yc-edition-logo'), null);
    assert.equal(f.doc.querySelector('.yc-edition-nav'), null); assert.equal(f.doc.getElementById('yc-franklin-main'), null);
    assert.deepEqual(f.doc.links, []); assert.deepEqual(f.root.dataset, {}); assert.deepEqual(f.doc.documentElement.dataset, {});
    assert.deepEqual(f.calls.events, []); assert.deepEqual(f.calls.listeners, []); assert.equal(f.window.yurFranklinMainHost, undefined);
    assert.deepEqual(f.calls.notices, []);
    assert.deepEqual(f.browserHost.children, [], 'the Desktop keeps its own browser chrome');
    assert.equal(f.doc.querySelector('.yc-edition-rail'), null); assert.equal(f.doc.title, undefined);
    f.context.openBrowser();
    assert.deepEqual(f.calls.widths, [620]); assert.deepEqual(f.calls.details, [[true, 'browser']]);
    assert.equal(f.doc.activeElement?.id, 'yc-browser-address');
  }
});

test('with the edition Franklin takes the main page, sections open beside him and Chat/Work/Code stay in the Pages menu', async () => {
  const f = desktop(athletics());
  await flush();
  assert.equal(f.context.edition.edition_id, 'athletics');
  assert.deepEqual(f.doc.links, ['edition-shell.css', 'athletics-brand/athletics.css']);
  assert.equal(f.doc.documentElement.dataset.yurEdition, 'athletics');
  assert.equal(f.root.dataset.edition, 'athletics'); assert.equal(f.root.dataset.editionPage, 'franklin');
  assert.equal(f.brand.textContent, 'YUR ATHLETICS');
  assert.equal(f.doc.querySelector('.yc-titlebar-caption').textContent, 'YUR ATHLETICS');
  const mark = f.doc.querySelector('.yc-desktop-mark .yc-edition-logo');
  assert.equal(mark.getAttribute('aria-label'), 'YUR Athletics'); assert.equal(mark.textContent, 'Y');
  assert.equal(mark.querySelector('img').src, 'athletics-brand/brand/mark-flat.svg');
  assert.equal(f.brand.querySelector('img').src, 'athletics-brand/brand/lockup.svg');
  assert.equal(f.doc.querySelector('.yc-edition-tab-mark'), null, 'the Franklin row is a plain row, without a second mark');
  assert.equal(f.doc.title, 'YUR Athletics');
  const nav = f.sidebar.children[1];
  assert.ok(nav.classList.contains('yc-edition-nav')); assert.equal(nav.getAttribute('aria-label'), 'YUR Athletics');
  const tabs = Object.fromEntries(nav.children.filter(node => node.tagName === 'button').map(button => [button.dataset.editionTab, button]));
  assert.equal(Object.keys(tabs).length, 12);
  assert.equal(tabs.franklin.getAttribute('aria-current'), 'page');
  // The closed side browser's rail sits before the side pane; the pane carries the edition's toolbar.
  const rail = f.doc.querySelector('.yc-edition-rail');
  assert.equal(f.main.children.indexOf(rail), f.main.children.indexOf(f.details) - 1);
  assert.deepEqual(f.browserHost.children.map(node => node.className), ['yc-edition-browserbar', 'yc-edition-browser-notice', 'yc-edition-browser-footer']);
  assert.deepEqual(f.desktopNav.children.map(node => node.querySelector('span').textContent), ['Chat', 'Work', 'Code', 'Settings']);
  const host = f.doc.getElementById('yc-franklin-main');
  assert.equal(f.main.children.indexOf(host), f.main.children.indexOf(f.doc.getElementById('yc-scroll')) - 1);
  // The ghost position canvas sits first in Franklin's column, decorative, with the manifest position split in two.
  const ghost = host.children[0];
  assert.ok(ghost.classList.contains('yc-edition-ghost')); assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(ghost.children.map(line => line.textContent), shell.ghostLines(manifest.athlete.position));
  assert.equal(ghost.hidden, true, 'a column with no width yet shows no ghost; it fits once laid out');
  // Franklin's state (title bar, driving, badge) follows his layout events; the ghost re-fits on resize.
  assert.deepEqual(f.calls.listeners.filter(([type]) => ['resize', 'yur:native-layout', 'yur:franklin-layout'].includes(type)).map(([type]) => type),
    ['yur:franklin-layout', 'yur:native-layout', 'resize', 'yur:native-layout']);
  // Actions awaiting his review light the Approvals badge (bright = needs you); none leaves it off.
  const franklinShell = element(f.doc, 'div', { id: 'yur-franklin' }); host.append(franklinShell);
  const layout = f.calls.listeners.find(([type]) => type === 'yur:franklin-layout')[1];
  const approvalsBadge = tabs.approvals.querySelector('.yc-edition-badge');
  franklinShell.dataset.phase = 'ready'; franklinShell.dataset.awaiting = '2'; layout();
  assert.equal(approvalsBadge.hidden, false); assert.equal(approvalsBadge.textContent, '2');
  franklinShell.dataset.awaiting = '0'; layout();
  assert.equal(approvalsBadge.hidden, true);
  franklinShell.remove();
  assert.equal(f.window.yurFranklinMainHost, host);
  const request = f.calls.events.find(event => event.type === 'yur:franklin-main');
  assert.equal(request.detail.host, host);
  assert.equal(request.detail.intro, f.window.yurFranklinMainIntro);
  assert.deepEqual(request.detail.intro.starts.map(start => start.id), ['film-study', 'my-card', 'college-board', 'outreach-drafts']);
  assert.equal(f.calls.events.at(-1), request, 'Franklin moves to the main page only after the edition is complete');

  tabs.coaches.click(); await flush();
  assert.deepEqual(f.calls.navigated, [embedded('/coaches')]);
  assert.deepEqual(f.calls.widths, [720], 'the first page opens the side browser at half the space beside the nav');
  assert.deepEqual(f.calls.details.at(-1), [true, 'browser']);
  assert.equal(tabs.franklin.getAttribute('aria-current'), 'page', 'Franklin stays the active page while a section opens beside him');
  tabs['film-study'].click(); await flush();
  assert.deepEqual(f.calls.navigated, [embedded('/coaches'), embedded('/player/' + manifest.athlete.id + '?tab=film')]);
  assert.deepEqual(f.calls.widths, [720], 'later pages keep the width the user chose');
  // The side browser's own address marks the open section; closing the pane clears the mark.
  f.context.detailsOpen = true; f.context.detailTab = 'browser';
  f.calls.browserListener({ type: 'state', state: { url: embedded('/player/' + manifest.athlete.id + '?tab=film'), visible: true } });
  assert.equal(tabs['film-study'].dataset.open, 'true'); assert.equal(tabs.coaches.dataset.open, undefined);
  f.calls.browserListener({ type: 'state', state: { url: embedded('/player/' + manifest.athlete.id + '?tab=film'), visible: false } });
  assert.equal(tabs['film-study'].dataset.open, undefined);
  f.context.currentSection = 'settings';
  tabs['college-board'].click(); await flush();
  assert.equal(f.context.currentSection, null); assert.equal(f.calls.navigated.at(-1), embedded('/player/' + manifest.athlete.id + '?tab=board'));
  assert.equal(tabs.franklin.getAttribute('aria-current'), 'page');
  // The rail reopens the last section; a start card opens its section and drafts (never sends) a request.
  f.doc.querySelector('.yc-edition-rail').children[0].click(); await flush();
  assert.equal(f.calls.navigated.at(-1), embedded('/player/' + manifest.athlete.id + '?tab=board'));
  request.detail.intro.starts[0].select(); await flush();
  assert.equal(f.calls.navigated.at(-1), embedded('/player/' + manifest.athlete.id + '?tab=film'));
  assert.equal(f.calls.asked.length, 1);

  tabs.approvals.click(); await flush();
  assert.equal(f.receipts.open, true);
  assert.equal(f.calls.navigated.at(-1), embedded('/player/' + manifest.athlete.id + '?tab=outreach'));
  assert.equal(tabs.franklin.getAttribute('aria-current'), 'page', 'Approvals shows Franklin’s page with his receipts');
  tabs.settings.click(); await flush();
  assert.equal(f.calls.settings, 1);
  assert.equal(tabs.settings.getAttribute('aria-current'), 'page');

  f.desktopNav.children[2].click(); await flush();
  assert.equal(f.root.dataset.editionPage, 'desktop'); assert.deepEqual(f.calls.modes, ['code']);
  assert.equal(nav.children.filter(node => node.getAttribute('aria-current')).length, 0);
  tabs.franklin.click(); await flush();
  assert.equal(f.root.dataset.editionPage, 'franklin'); assert.equal(f.calls.franklin, 1);
  const home = f.calls.listeners.find(([type]) => type === 'yur:conversation-home')[1];
  home(); assert.equal(f.calls.franklin, 2);
  // Opening or asking Franklin from anywhere (Ctrl+Shift+F, Unreal's Plan with Franklin) shows his page first.
  const reveal = f.calls.listeners.find(([type]) => type === 'yur:franklin-reveal')[1];
  f.desktopNav.children[0].click(); await flush();
  f.context.currentSection = 'unreal';
  assert.equal(f.root.dataset.editionPage, 'desktop');
  reveal();
  assert.equal(f.root.dataset.editionPage, 'franklin'); assert.equal(f.context.currentSection, null);
  assert.deepEqual(f.calls.notices, []);
  // Franklin acting from the main page does not move the user's focus into the address bar.
  f.doc.activeElement = { closest: selector => selector === '#yur-franklin' ? {} : null };
  f.context.openBrowser();
  assert.notEqual(f.doc.activeElement?.id, 'yc-browser-address');
});

test('an edition that fails while loading is undone: the Desktop keeps its nav, brand and browser, and Franklin his drawer', async () => {
  const f = desktop(athletics(), { failRender: true });
  await flush();
  assert.equal(f.context.edition, null); assert.equal(f.context.editionNav, null);
  assert.deepEqual(f.root.dataset, {}); assert.deepEqual(f.doc.documentElement.dataset, {});
  assert.deepEqual(f.sidebar.children.map(node => node.className), ['yc-sidebar-brand', '', 'yc-nav']);
  assert.equal(f.brand.textContent, 'YUR AI'); assert.equal(f.doc.querySelector('.yc-desktop-mark').textContent, 'Y');
  assert.equal(f.doc.querySelector('.yc-titlebar-caption').textContent, 'YUR AI DESKTOP');
  assert.deepEqual(f.desktopNav.children.map(node => node.querySelector('span').textContent), ['Settings']);
  assert.equal(f.doc.querySelector('.yc-edition-nav'), null); assert.equal(f.doc.getElementById('yc-franklin-main'), null);
  assert.equal(f.doc.getElementById('yur-edition-layout'), null, 'the edition layout stylesheet is removed again');
  assert.equal(f.doc.getElementById('yur-edition-brand'), null, 'the edition finish is removed again');
  assert.equal(f.window.yurFranklinMainHost, undefined);
  assert.equal(f.calls.events.some(event => event.type === 'yur:franklin-main'), false, 'Franklin never leaves his drawer');
  assert.deepEqual(f.calls.listeners, []);
  assert.deepEqual(f.calls.notices, ['YUR Athletics could not load: fixture render failure']);
  f.context.openBrowser();
  assert.deepEqual(f.calls.widths, [620], 'the Desktop opens its browser as before');
});

test('Franklin keeps the Desktop drawer by default and becomes the pinned main page only in main layout', async () => {
  function mount(layout) {
    const doc = { createElement: tag => new Node(tag, doc), appended() {} };
    doc.documentElement = new Node('html', doc);
    const host = new Node('section', doc); doc.documentElement.append(host);
    const calls = { configure: [] };
    const api = { snapshot: async () => ({ preferences: { model: 'm', open: false, draft: '' }, models: ['m'], messages: [], events: [], active_request: null, status: { phase: 'ready' } }),
      configure: async patch => { calls.configure.push(patch); return {}; }, send: async () => ({}), cancel: async () => ({}) };
    const controller = create(host, { api, debounceMs: 5000, ...(layout ? { layout } : {}) });
    const all = descendants(host), find = id => all.find(node => node.id === id);
    return { controller, calls, shell: find('yur-franklin'), panel: find('franklin-panel'), toggle: find('franklin-toggle'), close: find('franklin-close') };
  }
  const drawer = mount(); await flush();
  assert.equal(drawer.shell.dataset.layout, undefined);
  assert.equal(drawer.panel.hidden, true); assert.equal(drawer.toggle.hidden, false); assert.equal(drawer.close.hidden, false);
  drawer.controller.open(); assert.equal(drawer.panel.hidden, false); await flush();
  assert.deepEqual(drawer.calls.configure, [{ open: true }]);
  drawer.controller.dispose();
  const main = mount('main'); await flush();
  assert.equal(main.shell.dataset.layout, 'main'); assert.equal(main.shell.dataset.expanded, 'true');
  assert.equal(main.panel.hidden, false, 'the saved drawer preference cannot collapse the main page');
  assert.equal(main.toggle.hidden, true); assert.equal(main.close.hidden, true);
  main.controller.collapse(); main.controller.open(); await flush();
  assert.equal(main.panel.hidden, false); assert.deepEqual(main.calls.configure, [], 'opening the main page is not a saved drawer preference');
  // Without an edition intro the main page keeps the Desktop copy and has no Activity toggle.
  assert.equal(main.shell.dataset.intro, undefined);
  assert.equal(descendants(main.shell).find(node => node.id === 'franklin-activity'), undefined);
  assert.equal(descendants(main.shell).find(node => node.id === 'franklin-context').children[0].textContent, 'Desktop context and permissions');
  main.controller.dispose();
});

test('on the edition page Franklin has his header line, Activity, the greeting and start cards, and starts on the launcher model', async () => {
  const doc = { createElement: tag => new Node(tag, doc), appended() {} };
  doc.documentElement = new Node('html', doc);
  const host = new Node('section', doc); doc.documentElement.append(host);
  const snapshot = { preferences: { model: '', open: false, draft: '' }, default_model: 'ollama:cloud-b:cloud',
    models: [{ id: 'ollama:cloud-a:cloud', label: 'cloud-a:cloud · Ollama Cloud' }, { id: 'ollama:cloud-b:cloud', label: 'cloud-b:cloud · Ollama Cloud' }],
    messages: [], events: [], active_request: null, status: { phase: 'ready' }, observation: { sequence: 1, awaiting_review: 2 } };
  const calls = { configure: [], selected: [] };
  const api = { snapshot: async () => snapshot, configure: async patch => { calls.configure.push(patch); return {}; }, send: async () => ({}), cancel: async () => ({}) };
  const intro = { agentLine: 'Sample’s agent', greeting: 'Hey Sample. I’m Franklin, your agent.', placeholder: 'Message Franklin',
    starts: [{ id: 'film-study', title: 'Go over my film', line: 'Walk through the season study play by play.', page: 'Film study', select: () => calls.selected.push('film-study') }] };
  const controller = create(host, { api, debounceMs: 5000, layout: 'main', intro });
  await flush();
  const all = () => descendants(host), find = id => all().find(node => node.id === id);
  const franklin = find('yur-franklin');
  assert.equal(franklin.dataset.intro, 'edition'); assert.equal(franklin.dataset.activity, 'closed');
  const header = find('franklin-panel').children[0];
  assert.equal(header.children[0].children[1].textContent, 'Sample’s agent');
  const activity = find('franklin-activity');
  assert.equal(activity.hidden, false); assert.equal(activity.getAttribute('aria-expanded'), 'false');
  assert.equal(header.children.indexOf(activity), header.children.indexOf(find('franklin-refresh')) - 1);
  assert.equal(find('franklin-input').placeholder, 'Message Franklin');
  // The launcher's model stands until one is saved: nothing is configured just by showing it.
  assert.equal(find('franklin-model').value, 'ollama:cloud-b:cloud');
  assert.equal(franklin.dataset.modelReady, 'true'); assert.deepEqual(calls.configure, []);
  assert.equal(franklin.dataset.awaiting, '2'); assert.equal(franklin.dataset.empty, 'true');
  // His empty page: the greeting with his figure and wordmark, then the start cards.
  const welcome = all().find(node => node.classList.contains('yur-franklin-welcome'));
  assert.ok(welcome); assert.equal(find('franklin-log').children[0], welcome);
  assert.match(welcome.textContent, /^FRANKLINHey Sample\. I’m Franklin, your agent\./);
  const start = all().find(node => node.classList.contains('yur-franklin-start'));
  assert.equal(start.textContent, 'Go over my filmWalk through the season study play by play.Opens Film study');
  start.click(); assert.deepEqual(calls.selected, ['film-study']);
  // Activity shows his status, model, context and receipts; Approvals opens it with the receipts.
  activity.click(); assert.equal(franklin.dataset.activity, 'open'); assert.equal(activity.getAttribute('aria-expanded'), 'true');
  activity.click(); assert.equal(franklin.dataset.activity, 'closed');
  controller.showActivity(); assert.equal(franklin.dataset.activity, 'open'); assert.equal(find('franklin-timeline').open, true);
  // No local dictation on his page (it would run a speech model on this computer).
  assert.equal(all().find(node => node.classList.contains('yur-franklin-voice')).hidden, true);
  // His Activity lines name no Desktop: the same facts in the athlete's words.
  assert.equal(find('franklin-status').textContent, 'Franklin is ready. Saved context is supplied by the runtime.');
  assert.equal(find('franklin-persistence').textContent, 'Conversation and preferences are stored on this computer by the Commit Service.');
  assert.match(find('franklin-observation').textContent, /^Watching activity while this app is open · 0 active · 2 awaiting review/);
  assert.equal(find('franklin-context').children[0].textContent, 'Context and permissions');
  for (const node of [find('franklin-status'), find('franklin-persistence'), find('franklin-observation'), find('franklin-context').children[0]]) assert.doesNotMatch(node.textContent, /Desktop/, node.id);
  controller.dispose();
  // A default the catalog does not offer is never shown as chosen.
  const other = new Node('section', doc); doc.documentElement.append(other);
  const second = create(other, { api: { ...api, snapshot: async () => ({ ...snapshot, default_model: 'ollama:llama3:latest' }) }, debounceMs: 5000, layout: 'main', intro });
  await flush();
  assert.equal(descendants(other).find(node => node.id === 'franklin-model').value || '', '');
  assert.equal(descendants(other).find(node => node.id === 'yur-franklin').dataset.modelReady, 'false');
  second.dispose();
});

test('franklin-bootstrap keeps the drawer and its native-view clamp unless an edition hands it the main column', () => {
  const source = read('src/franklin-bootstrap.js');
  function boot({ early = false } = {}) {
    const listeners = new Map(), byId = new Map(), created = [];
    // The drawer sits at the right edge; on the main page Franklin's column ends where the pane begins.
    const rects = { drawer: { left: 1000, top: 50, bottom: 900 }, main: { left: 300, right: 700, top: 50, bottom: 900 } };
    const on = (type, callback) => listeners.set(type, [...(listeners.get(type) || []), callback]);
    const fire = (type, event = { type }) => (listeners.get(type) || []).forEach(callback => callback(event));
    const node = id => ({ id, isConnected: true, removed: false, children: [], append(child) { this.children.push(child); }, remove() { this.removed = true; byId.delete(id); } });
    const document = { body: { append() {} }, createElement: () => node(''), getElementById: id => byId.get(id) || null };
    const window = { studio: { franklin: {} }, addEventListener: on, dispatchEvent: event => fire(event.type, event),
      yurFranklinView: { create(host, options) {
        const shell = { dataset: { expanded: 'true', ...(options.layout ? { layout: options.layout } : {}) }, getClientRects: () => [1],
          getBoundingClientRect: () => options.layout === 'main' ? rects.main : rects.drawer };
        byId.set('yur-franklin', shell);
        const controller = { host, options, disposed: false, opened: 0, drafts: [], open() { this.opened++; }, collapse() {}, prepareDraft(text) { this.drafts.push(text); },
          dispose() { this.disposed = true; }, flushDraft: async () => {}, cancelDictation: async () => {} };
        created.push(controller); return controller;
      } } };
    if (early) window.yurFranklinMainHost = node('yc-franklin-main');
    vm.runInNewContext(source, { window, document, Event, setTimeout, clearTimeout });
    fire('DOMContentLoaded');
    return { window, created, fire, node, rects };
  }
  const bounds = { x: 700, y: 100, width: 700, height: 500 };
  const desktop = boot();
  let revealed = 0;
  desktop.window.addEventListener('yur:franklin-reveal', () => revealed++);
  assert.equal(desktop.created.length, 1); assert.equal(desktop.created[0].options.layout, undefined);
  assert.deepEqual({ ...desktop.window.yurNativeViewBounds(bounds) }, { ...bounds, width: 292 });
  desktop.window.yurOpenFranklin(); desktop.window.yurAskFranklin('drawer draft');
  assert.equal(revealed, 0, 'the Desktop drawer opens in place');
  assert.deepEqual([desktop.created[0].opened, desktop.created[0].drafts], [1, ['drawer draft']]);
  const main = desktop.node('yc-franklin-main');
  const intro = { agentLine: 'fixture' };
  desktop.fire('yur:franklin-main', { type: 'yur:franklin-main', detail: { host: main, intro } });
  assert.equal(desktop.created.length, 2); assert.equal(desktop.created[0].disposed, true);
  assert.equal(desktop.created[1].host, main); assert.equal(desktop.created[1].options.layout, 'main');
  // The edition page gets its copy, and no local dictation.
  assert.equal(desktop.created[1].options.intro, intro); assert.equal(desktop.created[1].options.voice, null);
  assert.equal(desktop.window.yurFranklin, desktop.created[1]);
  assert.deepEqual(desktop.window.yurNativeViewBounds(bounds), bounds, 'beside Franklin\'s column the browser keeps its bounds, Full view included');
  // A native view that would still reach into his column starts at its edge; native views draw above HTML.
  desktop.rects.main.right = 900;
  assert.deepEqual({ ...desktop.window.yurNativeViewBounds(bounds) }, { ...bounds, x: 900, width: 500 });
  desktop.rects.main.right = 1600;
  assert.deepEqual({ ...desktop.window.yurNativeViewBounds(bounds) }, { ...bounds, x: 1400, width: 0 });
  desktop.rects.main.right = 700;
  // Opening or asking him on the main page first asks the edition to show his page.
  desktop.window.yurOpenFranklin(); desktop.window.yurAskFranklin('Plan with Franklin');
  assert.equal(revealed, 2);
  assert.deepEqual([desktop.created[1].opened, desktop.created[1].drafts], [1, ['Plan with Franklin']]);
  desktop.fire('yur:franklin-main', { type: 'yur:franklin-main', detail: { host: desktop.node('other') } });
  assert.equal(desktop.created.length, 2, 'Franklin moves to the main page once');
  const early = boot({ early: true });
  assert.equal(early.created.at(-1).options.layout, 'main'); assert.equal(early.created.at(-1).host.id, 'yc-franklin-main');
});

test('the Athletics finish loads only for the edition, keeps hard edges and has no red inside', () => {
  const css = read('src/athletics-brand/athletics.css');
  assert.match(css, /^@import url\('\.\/fonts\/fonts\.css'\);/);
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]+;/, '').replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const selectors = [...body.matchAll(/(?:^|[}{])\s*([^{}@][^{}]*?)\s*\{/g)].map(match => match[1].trim()).filter(selector => !/^(?:@|from|to|\d+%)/.test(selector));
  assert.ok(selectors.length > 40);
  const split = list => { const parts = ['']; let depth = 0; for (const character of list) { if (character === ',' && !depth) { parts.push(''); continue; } depth += character === '(' ? 1 : character === ')' ? -1 : 0; parts[parts.length - 1] += character; } return parts; };
  for (const list of selectors) for (const selector of split(list))
    assert.match(selector.trim(), /^html\[data-yur-edition="athletics"\]/, selector);
  for (const match of css.matchAll(/border-radius:\s*([^;!]+)/g)) assert.equal(match[1].trim(), '0');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const red = /#cc2233|#aa1122|#c41e3a|196,\s*30,\s*58|204,\s*34,\s*51|patriot|\bred\b/i;
  assert.doesNotMatch(code, red);
  // The splash follows the approved mockup too: silver and blue light, no red.
  assert.doesNotMatch(read('src/athletics-launch.css').replace(/\/\*[\s\S]*?\*\//g, ''), red);
  // The thin blue light line under the title bar, the ghost finish and Franklin's mark live here.
  assert.match(code, /#glider-frame header::after \{[^}]*rgba\(59, 130, 246, \.9\)/);
  assert.match(code, /\.yc-edition-ghost \{[^}]*-webkit-text-stroke: 1\.5px rgba\(228, 228, 231, \.11\)[^}]*font-weight: 900; letter-spacing: -\.02em;[^}]*animation: ath-ghost-breathe 9s/);
  assert.match(code, /@keyframes ath-ghost-breathe \{ 0%, 100% \{ opacity: 1; \} 50% \{ opacity: \.6; \} \}/);
  assert.match(code, /@media \(prefers-reduced-motion: reduce\) \{\s*html\[data-yur-edition="athletics"\] body \*[^{]*\{ animation: none !important;/);
  assert.match(code, /url\('\.\/brand\/y-mark-figure\.svg'\)/);
  const editor = read('src/studio-editor.html');
  assert.doesNotMatch(editor, /athletics/i, 'the Desktop page never links the edition finish');
  const scripts = [...editor.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(match => match[1]);
  assert.ok(scripts.indexOf('edition-shell.js') >= 0 && scripts.indexOf('edition-shell.js') < scripts.indexOf('conversation-view.js'));
  assert.deepEqual([shell.LAYOUT_STYLESHEET, shell.BRANDS.athletics.stylesheet], ['edition-shell.css', 'athletics-brand/athletics.css']);
  for (const file of [shell.LAYOUT_STYLESHEET, shell.BRANDS.athletics.stylesheet]) assert.ok(fs.existsSync(path.join(src, file)), file);
});

test('on Franklin\'s page the side pane, also at 1100px and below and in Full view, leaves him a column', () => {
  const css = read('src/edition-shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const scope = '#yur-conversation[data-edition-page="franklin"] .yc-main.details-open';
  // Franklin's page counts as mounted when his shell is in the column (the ghost alone never counts).
  const has = ':not(.section-open):has(.yc-franklin-main > .yur-franklin)';
  assert.doesNotMatch(css, /:not\(:empty\)/);
  assert.ok(css.includes('#yur-conversation[data-edition-page="franklin"] .yc-main:not(.section-open) .yc-franklin-main:has(> .yur-franklin) { display: flex; }'));
  assert.ok(css.includes(`${scope}${has} {\n  --yc-edition-pane: min(var(--yc-detail-width, 480px), max(280px, calc(100% - 360px)));\n  padding-right: var(--yc-edition-pane);\n}`));
  assert.ok(css.includes(`${scope}.browser-full-view${has} {\n  --yc-edition-pane: max(280px, calc(100% - 360px));\n}`));
  assert.ok(css.includes(`${scope}${has} .yc-detail-panel {\n  left: auto; right: 0; width: var(--yc-edition-pane);\n}`));
  // The Desktop rules these replace on Franklin's page (they outrank them by id, attribute and five classes).
  const desktopCss = read('src/conversation.css');
  assert.match(desktopCss, /@media \(max-width: 1100px\) \{\s*#yur-conversation \.yc-main\.details-open \{ padding-right: 0; \}/);
  assert.match(desktopCss, /#yur-conversation \.yc-main\.browser-full-view \.yc-detail-panel \{\s*left: 0;\s*right: 0;\s*width: 100%;/);
  // The edition's layout: a 12px frame and hairline (26px), the 228px nav, and a first pane of half the
  // space beside the nav (conversation-view.js openBrowser). Franklin keeps at least 360px everywhere,
  // Full view included, and about half the room at 1440px (Main: about 600px).
  for (const width of [960, 1000, 1100, 1200, 1300, 1440, 1920]) {
    const main = width - 26 - 228, detail = Math.max(320, Math.min(900, width - 24, Math.round(main / 2)));
    const side = main - Math.min(detail, Math.max(280, main - 360)), full = main - Math.max(280, main - 360);
    assert.ok(side >= 360 && full >= 360, `${width}px: ${side}px beside the pane, ${full}px in Full view`);
  }
  assert.equal(1440 - 26 - 228 - Math.min(Math.round((1440 - 26 - 228) / 2), Math.max(280, 1440 - 26 - 228 - 360)), 593);
  assert.match(css, /grid-template: 0 minmax\(0, 1fr\) \/ 228px minmax\(0, 1fr\);/);
  assert.ok(conversation.includes("setDetailWidth(Math.round(($('yc-main').clientWidth || window.innerWidth) / 2))"));
});

test('Settings in the edition names YUR Athletics and lists only the athlete’s pages; the Desktop keeps every page and its text', async () => {
  const contract = JSON.parse(read('settings-preferences.json'));
  async function settings(options = {}) {
    const doc = documentDouble(), host = element(doc, 'section'); doc.body.append(host);
    const context = { document: doc };
    vm.runInNewContext(read('src/settings-view.js'), context);
    const view = context.yurSettingsView.create(host, { api: { describe: async () => contract }, getSettings: () => ({ id: 'desktop', preferences: {} }),
      models: () => [], mountModels() {}, mountExecution() {}, mountVoice() {}, usage: () => ({ conversations: 0, messages: 0 }), archived: () => [],
      repositoryRoot: () => '', onBack() {}, ...options });
    await view.ready;
    const sidebar = host.querySelector('.ys-sidebar');
    const pages = sidebar.children.filter(node => node.dataset.settingsPage).map(node => node.dataset.settingsPage);
    const groups = sidebar.children.filter(node => node.tagName === 'h3').map(node => node.textContent);
    const row = key => descendants(host).find(node => node.name === key)?.parentNode;
    return { host, pages, groups, row, text: host.textContent };
  }
  const desktop = await settings();
  assert.equal(desktop.pages.length, 24); assert.deepEqual(desktop.groups, ['Personal', 'Integrations', 'Coding', 'Archived']);
  assert.match(desktop.text, /Closing hides IntelliFlow in the system tray/); assert.match(desktop.text, /YUR AI Desktop \S+ is offered/);
  assert.equal(desktop.row('terminal_shell').style.display, undefined);
  const edition = await settings({ productName: 'YUR Athletics', pages: shell.SETTINGS_PAGES, hiddenFields: shell.SETTINGS_HIDDEN });
  assert.deepEqual(edition.pages, ['general', 'notifications', 'profile', 'appearance', 'parental-controls', 'account']);
  assert.deepEqual(edition.groups, ['Personal']);
  assert.match(edition.text, /Closing hides YUR Athletics in the system tray and lets current work continue\. Use Quit YUR Athletics in the tray/);
  assert.doesNotMatch(edition.text, /IntelliFlow/); assert.match(edition.text, /YUR Athletics \S+ is offered/);
  // The Desktop-only rows stay stored (saving keeps them) but out of view; the athlete's rows stay.
  for (const key of shell.SETTINGS_HIDDEN) assert.equal(edition.row(key).style.display, 'none', key);
  for (const key of ['background_enabled', 'send_shortcut', 'display_name', 'desktop_notifications']) assert.notEqual(edition.row(key).style.display, 'none', key);
  assert.ok(edition.row('code_enabled'), 'an unlisted page still holds its stored preference');
});

test('the edition frame is one 44px title row inside a 12px hairline frame, without the Desktop rows', () => {
  const css = read('src/edition-shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /--yc-edition-inset: 12px; --yc-edition-title: 44px;/);
  assert.match(css, /body\.glider-enabled #glider-frame nav \{ display: none; \}/, 'the Coding/Marketplace/Foundry/Production/Pages row is not shown');
  assert.match(css, /body\.glider-enabled #yur-conversation \.yc-titlebar \{ display: none; \}/, 'the File/Edit/View/Help row is not shown');
  assert.match(css, /#yur-conversation\[data-edition\] \.yc-topbar \{ display: none; \}/, 'the Browser/Work details/Terminal bar is not shown');
  assert.match(css, /#yur-conversation\[data-edition\] \.yc-sidebar :is\(\.yc-sidebar-brand, \.yc-profile\) \{ display: none; \}/, 'one lockup, in the title row');
  assert.match(css, /#glider-frame \.yc-edition-frame-logo img \{ height: 44px; \}/);
  assert.match(css, /border: 1px solid rgba\(228, 228, 231, \.18\)/);
  // The side browser shows its one toolbar while the browser is the pane's page; the Desktop chrome is hidden.
  assert.match(css, /\.yc-browser-pane > :is\(\.yc-browser-heading, \.yc-browser-address-form, \.yc-browser-controls, \.yc-browser-work-note, \.yc-browser-status\) \{ display: none; \}/);
  assert.match(css, /\.yc-detail-panel:has\(> #yc-browser-host:not\(\.yc-hidden\)\) > \.yc-detail-header \{ display: none; \}/);
  // Closed browser: the ghost sits under his header (Welcome); open: centered (Main).
  assert.match(css, /#yur-conversation \.yc-main:not\(\.details-open\) \.yc-edition-ghost \{ top: 58px;[^}]*transform: none;/);
  assert.match(css, /\.yc-main\.details-open \.yc-franklin-main:has\(> \.yur-franklin\[data-empty="true"\]\) > \.yc-edition-ghost \{ top: 58px;[^}]*transform: none;/, 'beside the browser, an empty page keeps the ghost in the free band');
  // His header line gives way before it runs under Activity; the start cards are one row when wide, two by two beside the browser.
  assert.match(css, /\.yur-franklin\[data-intro\] header p \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  assert.match(css, /\.yur-franklin-starts \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@container \(min-width: 700px\) \{ \.yur-franklin\[data-intro\] \.yur-franklin-starts \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \} \}/);
  // Text contrast: the dimmest text is #8e8e97 (about 6:1 on the near-black panels).
  const finish = read('src/athletics-brand/athletics.css');
  assert.match(finish, /--ath-warn: #8e8e97;/);
  assert.doesNotMatch(finish.replace(/\/\*[\s\S]*?\*\//g, ''), /(?:^|[\s;{])color: (?:var\(--ath-mute\)|#71717a)/);
});

test('brand fonts are bundled offline: Orbitron 400/700/900 and JetBrains Mono 400/500 woff2', () => {
  const fonts = read('src/athletics-brand/fonts/fonts.css');
  const faces = [...fonts.matchAll(/@font-face\{font-family:'([^']+)';font-style:normal;font-weight:(\d+);font-display:swap;src:url\('\.\/([^']+)'\) format\('woff2'\)\}/g)].map(match => [match[1], match[2], match[3]]);
  assert.deepEqual(faces, [['Orbitron', '400', 'orbitron-latin-400-normal.woff2'], ['Orbitron', '700', 'orbitron-latin-700-normal.woff2'], ['Orbitron', '900', 'orbitron-latin-900-normal.woff2'],
    ['JetBrains Mono', '400', 'jetbrains-mono-latin-400-normal.woff2'], ['JetBrains Mono', '500', 'jetbrains-mono-latin-500-normal.woff2']]);
  for (const [, , file] of faces) assert.equal(fs.readFileSync(path.join(src, 'athletics-brand', 'fonts', file)).subarray(0, 4).toString('latin1'), 'wOF2', file);
  assert.doesNotMatch(fonts, /https?:/);
  for (const license of ['OFL-orbitron.md', 'OFL-jetbrains-mono.md']) assert.match(read('src/athletics-brand/fonts/' + license), /SIL Open Font License, Version 1\.1/);
});

test('the edition shell ships with the Desktop; every Athletics page, script, style, font and test ships only in an Athletics build', () => {
  const required = JSON.parse(read('scripts/source-files.json')).required, athletics = JSON.parse(read('scripts/edition-files.json')).editions.athletics;
  for (const name of ['src/edition-shell.js', 'src/edition-shell.css']) assert.ok(required.includes(name), name);
  for (const name of ['src/athletics-launch.html', 'src/athletics-launch.js', 'src/athletics-launch.css', 'src/athletics-play-art.js',
    'src/athletics-brand/athletics.css', 'src/athletics-brand/fonts/fonts.css', 'src/athletics-brand/fonts/OFL-orbitron.md', 'src/athletics-brand/fonts/OFL-jetbrains-mono.md',
    'src/athletics-brand/fonts/orbitron-latin-400-normal.woff2', 'src/athletics-brand/fonts/orbitron-latin-700-normal.woff2', 'src/athletics-brand/fonts/orbitron-latin-900-normal.woff2',
    'src/athletics-brand/fonts/jetbrains-mono-latin-400-normal.woff2', 'src/athletics-brand/fonts/jetbrains-mono-latin-500-normal.woff2', 'tests/edition-shell.test.js']) {
    assert.ok(athletics.includes(name), name); assert.equal(required.includes(name), false, name);
  }
  // Logo art arrives from the logo job; whatever exists must be in the Athletics list.
  for (const file of Object.values(shell.BRANDS.athletics).filter(value => value.endsWith('.svg')))
    if (fs.existsSync(path.join(src, file))) assert.ok(athletics.includes('src/' + file), file);
});
