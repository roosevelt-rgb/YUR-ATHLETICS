'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadCapabilities, compileCapabilities, validateManifest, MANIFEST_PATH, MAX_MANIFEST_BYTES } = require('../src/desktop-capabilities');
const copy = value => JSON.parse(JSON.stringify(value));

test('source-owned overview covers the broader desktop with traceable source references and no readiness claim', () => {
  const loaded = loadCapabilities(), root = path.dirname(MANIFEST_PATH);
  assert.equal(loaded.sha256, createHash('sha256').update(fs.readFileSync(MANIFEST_PATH)).digest('hex'));
  const features = new Map(loaded.manifest.features.map(item => [item.id, item]));
  for (const id of ['projects', 'browser', 'voice', 'studio', 'schedules', 'specialist_factory', 'generated_specialists', 'concept_lifecycle', 'copilot', 'workforce', 'ecosystem_sources']) assert.ok(features.has(id));
  for (const feature of loaded.manifest.features) for (const source of feature.sources) assert.ok(fs.statSync(path.join(root, source)).isFile(), `${feature.id} source ${source}`);
  for (const id of ['copilot', 'workforce', 'ecosystem_sources']) assert.equal(features.get(id).access, 'reference_catalog');
  for (const id of ['voice', 'code_checks', 'generated_specialists']) assert.equal(features.get(id).access, 'conditional');
  const prompt = compileCapabilities(loaded, 'chat');
  assert.ok(prompt.includes(loaded.manifest.schema)); assert.ok(prompt.includes(loaded.sha256));
  assert.match(prompt, /executes no model tool calls/); assert.match(prompt, /not a runtime health check/);
  assert.match(prompt, /not silently imported, executed/); assert.match(prompt, /Apply reviewed edit/);
  loaded.manifest.identity = 'caller changed'; assert.notEqual(loadCapabilities().manifest.identity, loaded.manifest.identity);
});

test('invalid capability metadata cannot masquerade as executable authority', () => {
  const base = loadCapabilities().manifest;
  const cases = [null, {...copy(base), schema:'arbitrary'}, {...copy(base), tools:[{name:'run_shell'}]}, {...copy(base), features:[]}, {...copy(base), boundaries:[]}];
  for (const [field, value] of [['access','admitted'], ['sources',['../private.txt']], ['sources',['C:/private.txt']], ['sources',['src\\main.js']], ['sources',['src/main.js','src/main.js']], ['summary','x'.repeat(1501)], ['id','bad id']]) {
    const bad = copy(base); bad.features[0][field] = value; cases.push(bad);
  }
  const duplicate = copy(base); duplicate.features.push(copy(duplicate.features[0])); cases.push(duplicate);
  for (const bad of cases) assert.throws(() => validateManifest(bad));
  assert.throws(() => compileCapabilities({manifest:base,sha256:'forged'}, 'chat'));
  assert.throws(() => compileCapabilities(loadCapabilities(), 'work'));
});

test('bounded strict loader rejects duplicates, malformed UTF-8, missing resources and linked payloads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-capabilities-test-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const file = path.join(directory, 'manifest.json'), raw = fs.readFileSync(MANIFEST_PATH);
  for (const value of [Buffer.from('{"schema":"first","schema":"second"}'), Buffer.from([0xff,0xfe]), Buffer.alloc(MAX_MANIFEST_BYTES + 1, 32)]) {
    fs.writeFileSync(file, value); assert.throws(() => loadCapabilities(file));
  }
  fs.writeFileSync(file, raw); assert.equal(loadCapabilities(file).sha256, loadCapabilities().sha256);
  const linked = path.join(directory,'linked.json'); fs.linkSync(file,linked);
  assert.throws(() => loadCapabilities(linked));
  assert.throws(() => loadCapabilities(path.join(directory,'absent.json')));
});
