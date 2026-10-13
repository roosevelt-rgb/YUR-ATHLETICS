'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const css = read('src/desktop-theme.css');
const palette = Object.fromEntries([...css.matchAll(/--dt-([\w-]+):\s*(#[\da-f]{6})/g)].map(match => [match[1], match[2]]));
const entrypoints = ['studio-editor.html', 'factory.html', 'glider-launch.html', 'yur-ai-launch.html'];

function luminance(hex) {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels.reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
}
function contrast(a, b) {
  const [low, high] = [luminance(palette[a]), luminance(palette[b])].sort((x, y) => x - y);
  return (high + .05) / (low + .05);
}

test('every native renderer entrypoint loads the shared palette after its component styles', () => {
  for (const name of entrypoints) {
    const html = read(`src/${name}`);
    const head = html.split('</head>')[0];
    const styles = [...head.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)].map(match => match[1]);
    assert.equal(styles.at(-1), 'desktop-theme.css', name);
    assert.equal(styles.filter(style => style === 'desktop-theme.css').length, 1, name);
    assert.match(html.slice(head.length), /<body\b[^>]*class="[^"]*\byur-theme\b/, name);
    const csp = head.match(/Content-Security-Policy[^>]*content="([^"]+)"/i)?.[1];
    if (csp) assert.match(csp, /style-src[^;]*'self'/, name);
  }
  assert.match(css, /:root\s*\{[^}]*--yf-panel:\s*var\(--dt-panel\)/s);
});

test('shared text and signals retain readable contrast on all host surfaces', () => {
  for (const foreground of ['text', 'secondary', 'muted']) {
    for (const background of ['bg', 'panel', 'surface', 'active']) {
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground}/${background}: ${contrast(foreground, background)}`);
    }
  }
  for (const signal of ['success', 'warning', 'error', 'info']) {
    assert.ok(contrast(signal, `${signal}-bg`) >= 4.5, signal);
    assert.notEqual(palette[signal], palette.silver, signal);
  }
  assert.ok(contrast('on-accent', 'silver') >= 7);
  assert.ok(contrast('border', 'surface') >= 3);
  assert.ok(contrast('focus', 'surface') >= 3);
});

test('component styles never reference missing shared color tokens', () => {
  const sources = fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.css'))
    .map(name => read(`src/${name}`));
  sources.push(read('src/studio-editor.html').split('</head>')[0]);
  for (const source of sources) for (const match of source.matchAll(/var\(--dt-([\w-]+)/g)) {
    assert.ok(Object.hasOwn(palette, match[1]), `Undefined color token: ${match[1]}`);
  }
});

test('Monaco resolves both saved appearance names to the same shared host palette', () => {
  const html = read('src/studio-editor.html');
  const from = html.indexOf('        const rootStyle = ');
  const to = html.indexOf('        const baseOpts = {', from);
  assert.ok(from >= 0 && to > from);
  const themes = {};
  vm.runInNewContext(html.slice(from, to), {
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: name => palette[name.replace('--dt-', '')] || '' }),
    monaco: { editor: { defineTheme: (name, theme) => { themes[name] = theme; } } },
  });
  assert.equal(themes['yur-dark'], themes['yur-light']);
  assert.equal(themes['yur-dark'].base, 'vs-dark');
  assert.equal(themes['yur-dark'].colors['editor.background'], palette.bg);
  assert.equal(themes['yur-dark'].colors['editor.foreground'], palette.text);
  assert.equal(themes['yur-dark'].colors['editorIndentGuide.background1'], palette.border);
});

test('terminal and generated diagram chrome match the palette while retaining signal colors', () => {
  const html = read('src/studio-editor.html');
  const terminal = html.slice(html.indexOf('function initTerminal()'));
  const source = terminal.match(/theme:\s*(\{[^}]+\})/)?.[1];
  assert.ok(source);
  const theme = vm.runInNewContext(`(${source})`);
  for (const [field, token] of Object.entries({ background: 'bg', foreground: 'text', cursor: 'silver', selectionBackground: 'active', red: 'error', green: 'success', yellow: 'warning' })) {
    assert.equal(theme[field], palette[token], field);
  }
  const mermaid = html.slice(html.indexOf('window.mermaid.initialize('), html.indexOf('return true;', html.indexOf('window.mermaid.initialize(')));
  assert.match(mermaid, /darkMode:\s*true/);
  assert.ok(mermaid.includes(`background: "${palette.bg}"`));
});

test('status signals and forced-colors focus remain explicit in the shared finish', () => {
  for (const state of ['success', 'warning', 'error']) {
    assert.match(css, new RegExp(`background: var\\(--dt-${state}\\)`));
  }
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(css, /outline-color:\s*Highlight/);
  assert.match(read('src/main.js'), /title: 'YUR Specialist Factory', backgroundColor: '#101722'/);
});

test('fixed appearance preserves saved and newly imported legacy values in settings snapshots', () => {
  const source = read('src/settings-view.js');
  assert.ok(source.includes("node('p', 'Blue slate and silver'"));
  assert.ok(source.includes("if (key !== 'accent') row("));
  assert.ok(!source.includes("controls.get('$theme')"));
  const start = source.indexOf('    function collect() {');
  const end = source.indexOf('    function refreshVoices()', start);
  let saved;
  const controls = new Map([
    ['font_size', { input: { value: '16' }, rule: { type: 'integer' } }],
    ...['$model', '$foundry', '$ollama', '$instructions'].map(key => [key, { input: { value: '' }, rule: { type: 'string' } }]),
  ]);
  const collect = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    controls, schema: { fields: { accent: {}, font_size: {} } }, options: { getSettings: () => saved },
  });
  for (const theme of ['light', 'dark', 'system']) for (const accent of ['rose', 'blue', 'violet', 'silver']) {
    // Replacing saved represents the acknowledged import/reload path: collect
    // must take preserved values from current storage, never an obsolete input.
    saved = { id: 'desktop', revision: 4, theme, preferences: { accent, font_size: 14 } };
    const result = collect();
    assert.equal(result.theme, theme);
    assert.equal(result.preferences.accent, accent);
    assert.equal(result.preferences.font_size, 16);
    assert.equal(saved.preferences.font_size, 14, 'collect must not mutate saved settings');
  }
  for (const preferences of [undefined, {}]) {
    saved = { id: 'desktop', theme: 'system', ...(preferences ? { preferences } : {}) };
    const result = collect();
    assert.equal(result.theme, 'system');
    assert.equal(Object.hasOwn(result.preferences, 'accent'), false, 'omitted legacy accent stays omitted');
    assert.equal(saved.preferences, preferences, 'an untouched legacy document remains unmodified');
  }
});
