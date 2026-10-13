'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_) { throw new Error('Concept content must remain inert text'); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  get childElementCount() { return this.children.length; }
}
const all = node => [node, ...node.children.flatMap(all)];
function setup() { const sandbox = { window: {}, document: { createElement: tag => new Node(tag) } }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/concept-view.js'), 'utf8'), sandbox); return { view: sandbox.window.yurConceptView, host: new Node('main') }; }
function concept() { return { id: '33333333-3333-4333-8333-333333333333', name: 'Retained construction concept', stage: 'stabilization', revision: 12, domain_tags: ['construction'], versions: [], evidence: [], version_count: 0, evidence_count: 0, parent_id: null, lineage: [], history_hash: 'a'.repeat(64), receipt: { hash: 'b'.repeat(64) } }; }
function step(snapshot, denied = false) { return { tool: 'advance_concept', succeeded: true, result: { schema: 'yur.work-concept-result.v1', tool: 'advance_concept', status: denied ? 'denied' : 'completed', committed: true, concept: snapshot, decision: { allowed: !denied, from_stage: denied ? 'stabilization' : 'development', to_stage: denied ? 'maturation' : 'stabilization', missing: denied ? [{ requirement: 'test_report', reason: 'Independent stability evidence is not admitted.' }] : [], errors: [] }, provenance: { parent_work_id: 'f'.repeat(32) } } }; }

test('the eight-stage view marks only current or actually observed stages, never ordinal progress', () => {
  const { view, host } = setup(); view.renderRecord(host, { concept: concept(), events: [{ stage: 'genesis' }, { stage: 'development' }] });
  const progression = all(host).find(node => node.className === 'yc-concept-stages'); assert.equal(progression.children.length, 8);
  assert.equal(progression.children.filter(node => node.attributes['aria-current'] === 'step').length, 1);
  assert.match(progression.children[0].textContent, /Recorded here/); assert.match(progression.children[1].textContent, /Not shown here/); assert.match(progression.children[6].textContent, /Not shown here/);
  assert.doesNotMatch(host.textContent, /Earlier stage|Not reached/); assert.match(host.textContent, /Regeneration is triggered/);
});

test('denied gates retain reasons and receipts without claiming advancement or introducing mutations', () => {
  const { view } = setup(), result = step(concept(), true), host = view.renderWork([result], { id: 'f'.repeat(32) });
  assert.match(host.textContent, /Stage unchanged: Stabilization/); assert.match(host.textContent, /Independent stability evidence is not admitted/); assert.match(host.textContent, /decision receipt is retained/);
  assert.doesNotMatch(host.textContent, /Stage recorded: Maturation/); assert.equal(all(host).some(node => node.tagName === 'button'), false);
  result.result.concept.stage = 'maturation'; assert.equal(view.workResult(result, { id: 'f'.repeat(32) }), null);
});

test('latest Work snapshots preserve package/evidence distinction and all hostile content stays text', () => {
  const { view } = setup(), previous = concept(), latest = concept(); latest.revision = 13; latest.name = '<img src=x onerror=alert(1)>';
  latest.versions = [{ id: '44444444-4444-4444-8444-444444444444', ordinal: 1, build_mission_id: 'c'.repeat(32), parent_version_id: null, artifact_sha256: 'd'.repeat(64) }]; latest.version_count = 1;
  latest.evidence = [{ requirement: 'charter', source: { kind: 'work_artifact' }, receipt_hash: 'e'.repeat(64) }, { requirement: 'instrumentation', source: { kind: 'specialist_execution' } }]; latest.evidence_count = 2;
  const host = view.renderWork([step(previous), step(latest, true)], { id: 'f'.repeat(32) }); assert.equal(all(host).filter(node => node.className === 'yc-concept-record').length, 1);
  assert.ok(host.textContent.includes(latest.name)); assert.equal(all(host).some(node => ['img', 'script'].includes(node.tagName)), false); assert.match(host.textContent, /Committed plan · not outcome proof/); assert.match(host.textContent, /Recorded specialist execution/); assert.match(host.textContent, /Version 1/);
  assert.equal(view.workResult(step(latest), { id: '0'.repeat(32) }), null);
});

test('late inspect responses cannot replace a different view, and mismatched identities fail closed', async () => {
  const { view, host } = setup(); let complete, active = true;
  const request = view.inspect({ concepts: { inspect: () => new Promise(resolve => { complete = resolve; }) } }, concept().id, host, { active: () => active });
  active = false; host.replaceChildren(new Node('other')); complete({ ok: true, result: { concept: concept() } }); await request; assert.equal(host.children[0].tagName, 'other');
  await view.inspect({ concepts: { inspect: async () => ({ ok: true, result: { concept: { ...concept(), id: '44444444-4444-4444-8444-444444444444' } } }) } }, concept().id, host);
  assert.match(host.textContent, /identity differs/); assert.equal(all(host).some(node => node.className === 'yc-concept-record'), false);
});

test('mixed Concept versions clearly distinguish generated Python source and cohort evidence from runtime packages', () => {
  const { view, host } = setup(), snapshot = concept();
  const legacy = { id: '44444444-4444-4444-8444-444444444444', ordinal: 1, parent_version_id: null, build_mission_id: 'c'.repeat(32), artifact_sha256: 'd'.repeat(64) };
  const generated = { id: '55555555-5555-4555-8555-555555555555', ordinal: 2, parent_version_id: legacy.id, kind: 'generated_python', source_work_id: 'e'.repeat(32), build_step_index: 7,
    artifact_sha256: '1'.repeat(64), source_sha256: '2'.repeat(64), contract_sha256: '3'.repeat(64), driver_sha256: '4'.repeat(64), runtime_sha256: '5'.repeat(64),
    acceptance_cohort_sha256: '6'.repeat(64), evidence_verifier: 'yur.generated-evidence.v1', validation_receipt_hash: '7'.repeat(64), artifact_receipt_hash: '8'.repeat(64) };
  snapshot.versions = [legacy, generated]; snapshot.version_count = 2;
  snapshot.evidence = [{ requirement: 'validation_plan', source: { kind: 'generated_build', version_id: generated.id }, artifact_id: generated.id, artifact_sha256: generated.artifact_sha256 },
    { requirement: 'instrumentation', source: { kind: 'generated_execution', version_id: generated.id, execution_work_id: 'a'.repeat(32), execution_step_index: 19 }, receipt_hash: '9'.repeat(64) },
    { requirement: '<script>not executable</script>', source: { kind: 'specialist_build', version_id: legacy.id } }]; snapshot.evidence_count = 3;
  view.renderRecord(host, { concept: snapshot });
  const versions = all(host).filter(node => node.className === 'yc-concept-version'); assert.equal(versions.length, 2);
  assert.match(versions[0].textContent, /Version 1 · Specialist package/); assert.ok(versions[0].textContent.includes(`Build ${legacy.build_mission_id}`));
  assert.match(versions[1].textContent, /Version 2 · Generated Python/); assert.ok(versions[1].textContent.includes(`Source Work ${generated.source_work_id} · build step 7`));
  assert.match(versions[1].textContent, /finite cases/); assert.match(versions[1].textContent, /does not establish broader capability or lifecycle maturity/);
  for (const key of ['acceptance_cohort_sha256', 'source_sha256', 'driver_sha256', 'validation_receipt_hash', 'artifact_receipt_hash']) assert.ok(versions[1].textContent.includes(generated[key]));
  assert.doesNotMatch(versions[1].textContent, /build_mission_id|Build undefined|Package hashes/);
  assert.match(host.textContent, /Generated Python acceptance cohort/); assert.match(host.textContent, /Recorded generated Python execution/);
  assert.ok(host.textContent.includes(`Execution Work ${'a'.repeat(32)} · step 19`)); assert.ok(host.textContent.includes(`Bound version ${generated.id}`));
  assert.match(host.textContent, /Validated specialist package/); assert.equal(all(host).some(node => node.tagName === 'script'), false);
});

test('generated version binding renders its committed Work snapshot without suggesting a lifecycle advance', () => {
  const { view } = setup(), snapshot = concept(); snapshot.stage = 'genesis';
  snapshot.versions = [{ id: '55555555-5555-4555-8555-555555555555', ordinal: 1, parent_version_id: null, kind: 'generated_python', source_work_id: 'a'.repeat(32), build_step_index: 0 }]; snapshot.version_count = 1;
  const binding = { tool: 'bind_generated_concept_version', succeeded: true, result: { schema: 'yur.work-concept-result.v1', tool: 'bind_generated_concept_version', committed: true, status: 'completed', concept: snapshot, provenance: { parent_work_id: 'f'.repeat(32) } } };
  const rendered = view.renderWork([binding], { id: 'f'.repeat(32) });
  assert.match(rendered.textContent, /Recorded snapshot · Genesis/); assert.match(rendered.textContent, /First retained generated Python version/);
  assert.doesNotMatch(rendered.textContent, /Stage recorded:|Stage unchanged:|Build undefined/);
  assert.equal(all(rendered).some(node => node.tagName === 'button'), false);
  assert.equal(view.workResult(binding, { id: '0'.repeat(32) }), null);
  binding.result.committed = false; assert.equal(view.workResult(binding, { id: 'f'.repeat(32) }), null);
});
