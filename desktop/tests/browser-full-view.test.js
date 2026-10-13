'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/conversation-view.js'), 'utf8');
const start = source.indexOf('  function setBrowserFullView(');
const end = source.indexOf('  function ensureArtifact()', start);
assert.ok(start >= 0 && end > start, 'Browser layout functions exist in the Desktop view');

function element() {
  const classes = new Set();
  const attributes = new Map();
  return {
    hidden: false, textContent: '',
    classList: {
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
  };
}

test('full Browser view expands only the Browser pane and restores ordinary detail layout', () => {
  const nodes = new Map([
    'yc-main', 'yc-details', 'yc-detail-widen', 'yc-detail-resize',
    'yc-context-toggle', 'yc-browser-toggle', 'yc-details-tab',
    'yc-browser-tab', 'yc-artifact-tab', 'yc-detail-body',
    'yc-browser-host', 'yc-artifact-host',
  ].map(id => [id, element()]));
  const browserFullViewButton = element();
  const layoutEvents = [], visibility = [];
  const context = vm.createContext({
    detailsOpen: false, detailTab: 'work', browserFullViewButton,
    $: id => nodes.get(id),
    browserView: { setVisible: value => visibility.push(value) }, artifactView: null,
    ensureBrowser: () => ({ setVisible: value => visibility.push(value) }),
    renderDetails: () => {}, notice: error => { throw error; },
    window: { dispatchEvent: event => layoutEvents.push(event.type) },
    Event: class { constructor(type) { this.type = type; } },
  });
  vm.runInContext(source.slice(start, end), context);

  context.toggleDetails(true, 'browser');
  assert.equal(browserFullViewButton.hidden, false);
  assert.deepEqual(visibility, [false, true]);
  context.setBrowserFullView(true);
  assert.equal(nodes.get('yc-main').classList.contains('browser-full-view'), true);
  assert.equal(nodes.get('yc-detail-widen').hidden, true);
  assert.equal(nodes.get('yc-detail-resize').hidden, true);
  assert.equal(browserFullViewButton.getAttribute('aria-pressed'), 'true');
  assert.ok(layoutEvents.includes('yur:native-layout'));

  context.toggleDetails(true, 'work');
  assert.equal(nodes.get('yc-main').classList.contains('browser-full-view'), false);
  assert.equal(browserFullViewButton.hidden, true);
  assert.equal(browserFullViewButton.getAttribute('aria-pressed'), 'false');
  assert.equal(nodes.get('yc-detail-widen').hidden, false);
  assert.equal(nodes.get('yc-detail-resize').hidden, false);
});
