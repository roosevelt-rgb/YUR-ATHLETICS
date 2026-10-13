'use strict';
// Native model responses are fixtures. Source snapshots, WSL execution,
// validation, receipts and explicit edit delivery use the real implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (process.env.YUR_RUN_EXECUTION_CELL_TESTS !== '1') throw new Error('Set YUR_RUN_EXECUTION_CELL_TESTS=1 to run this native test against an already-running admitted execution resource.');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');

const original = 'def add(a, b):\n    return a - b\n';
const staged = 'def add(a, b):\n    return a + b\n';
const outputMarker = '<img src=x onerror="window.CELL_INJECTED=true"><script>window.CELL_INJECTED=true</script> **literal output**';
const check = `import unittest\nfrom calculator import add\nprint(${JSON.stringify(outputMarker)})\nclass ArithmeticCheck(unittest.TestCase):\n    def test_staged_add(self):\n        self.assertEqual(add(2, 3), 5)\n`;
const failing = 'import unittest\nclass ExpectedFixtureFailure(unittest.TestCase):\n    def test_actual_failure(self):\n        self.assertEqual(2, 7, "NATIVE_CELL_FAILURE")\n';

nativeFixture({ prefix: 'code-cell', model: 'code-cell-tool-fixture',
  handle({ body, completed, call, send, sourceRoot, proof }) {
    assert.ok(body.tools.some(tool => tool.function.name === 'run_python_checks'));
    assert.equal(fs.readFileSync(path.join(sourceRoot, 'calculator.py'), 'utf8'), original, 'Checks must never apply the staged overlay to the host source');
    if (!completed.length) return call('propose_edit', { path: 'calculator.py', expected_sha256: sha(original), content: staged });
    const edit = completed[0].value; assert.equal(edit.proposal.expected_sha256, sha(original)); assert.equal(edit.proposal.new_sha256, sha(staged)); proof.proposal_id = edit.artifact_id;
    if (completed.length === 1) return call('run_python_checks', { files: ['calculator.py', 'tests/test_calculator.py'], profile: 'python-compile-serial', test_directory: 'tests', proposal_ids: [edit.artifact_id] });
    for (const result of completed.slice(1).map(item => item.value)) {
      assert.equal(result.schema, 'yur.work-cell-result.v1'); assert.equal(result.status, 'recorded'); assert.equal(result.committed, true);
      assert.equal(result.execution.scratch, 'discarded'); assert.match(result.provenance.snapshot_receipt, /^[a-f0-9]{64}$/); assert.match(result.provenance.result_receipt, /^[a-f0-9]{64}$/);
      assert.equal(result.execution.stdout_sha256, sha(result.execution.stdout)); assert.equal(result.execution.stderr_sha256, sha(result.execution.stderr));
    }
    const compiled = completed[1].value; assert.equal(compiled.execution.status, 'completed'); assert.equal(compiled.execution.exit_code, 0);
    if (completed.length === 2) return call('run_python_checks', { files: ['calculator.py', 'tests/test_calculator.py'], profile: 'python-unittest-serial', test_directory: 'tests', proposal_ids: [edit.artifact_id] });
    const tested = completed[2].value; assert.equal(tested.execution.status, 'completed'); assert.equal(tested.execution.exit_code, 0); assert.ok(tested.execution.stdout.includes(outputMarker)); assert.ok(tested.execution.stderr.includes('test_staged_add'));
    const overlay = tested.snapshot.sources.find(item => item.path === 'calculator.py'); assert.equal(overlay.overlay, true); assert.equal(overlay.original_sha256, sha(original)); assert.equal(overlay.staged_sha256, sha(staged));
    if (completed.length === 3) return call('run_python_checks', { files: ['failures/test_failure.py'], profile: 'python-unittest-serial', test_directory: 'failures', proposal_ids: [] });
    assert.equal(completed.length, 4); const failure = completed[3].value; assert.equal(failure.execution.status, 'failed'); assert.notEqual(failure.execution.exit_code, 0); assert.ok(failure.execution.stderr.includes('NATIVE_CELL_FAILURE'));
    proof.cells = completed.slice(1).map(item => ({ profile: item.value.execution.profile, status: item.value.execution.status, exit_code: item.value.execution.exit_code, snapshot: item.value.snapshot, provenance: item.value.provenance, runtime: item.value.execution.runtime, stdout_sha256: item.value.execution.stdout_sha256, stderr_sha256: item.value.execution.stderr_sha256 }));
    send('CODE_CELL_NATIVE_RECORDED: compilation and staged arithmetic checks exited zero; the separate failure fixture exited nonzero. No source edit has been applied.');
  },
  async run(ctx) {
    const { evaluate, waitFor, click, envelope } = ctx;
    fs.writeFileSync(path.join(ctx.sourceRoot, 'calculator.py'), original);
    fs.mkdirSync(path.join(ctx.sourceRoot, 'tests')); fs.writeFileSync(path.join(ctx.sourceRoot, 'tests', 'test_calculator.py'), check);
    fs.mkdirSync(path.join(ctx.sourceRoot, 'failures')); fs.writeFileSync(path.join(ctx.sourceRoot, 'failures', 'test_failure.py'), failing);
    await evaluate('document.getElementById("yc-mode").value="code"; document.getElementById("yc-mode").dispatchEvent(new Event("change")); document.getElementById("yc-attach-repository").click()');
    await waitFor(`document.getElementById('yc-repository').textContent.includes(${JSON.stringify(ctx.sourceRoot)})`);
    const goal = 'NATIVE_CODE_CELL: stage add() correction, compile, run the staged unittest, then record a deliberate failing unittest. Do not apply edits.';
    await evaluate(`document.getElementById('yc-input').value=${JSON.stringify(goal)}; document.getElementById('yc-form').requestSubmit()`);
    await waitFor('document.getElementById("yc-messages").textContent.includes("CODE_CELL_NATIVE_RECORDED") && !document.getElementById("yc-send").disabled', 100000);
    const parents = (await envelope('window.studio.work.list(null)')).missions; assert.equal(parents.length, 1); const parentId = parents[0].id; ctx.proof.parent_id = parentId;
    const record = await envelope(`window.studio.work.inspect(${JSON.stringify(parentId)})`); assert.equal(record.mission.status, 'completed'); assert.deepEqual(record.mission.steps.map(step => step.tool), ['propose_edit', 'run_python_checks', 'run_python_checks', 'run_python_checks']);
    assert.equal(record.events.filter(event => event.event_type === 'work.cell.snapshot.committed').length, 3); assert.equal(record.events.filter(event => event.event_type === 'work.cell.result.committed').length, 3);
    assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'calculator.py'), 'utf8'), original);
    ctx.checks.push('Real native Code request commits three exact snapshots and executes the admitted WSL compile/unittest adapter: two zero exits and one actual assertion failure; staged overlay leaves host source unchanged');
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-cell-result").length===3');
    const cards = await evaluate('[...document.querySelectorAll(".yc-cell-result")].map(node=>({status:node.dataset.executionStatus,summary:node.querySelector(".yc-cell-status").textContent,text:node.textContent}))'); assert.deepEqual(cards.map(card => card.status), ['completed', 'completed', 'failed']);
    assert.match(cards[2].summary, /Command failed · exit code 1/); assert.ok(cards[1].text.includes(sha(original))); assert.ok(cards[1].text.includes(sha(staged))); assert.ok(cards[1].text.includes(outputMarker));
    assert.equal(await evaluate('Boolean(window.CELL_INJECTED || document.querySelector(".yc-cell-result img, .yc-cell-result script"))'), false);
    await evaluate('document.querySelectorAll(".yc-cell-result")[1].scrollIntoView({block:"start"}); true;'); await ctx.capture('staged-check-output');
    await evaluate('document.querySelectorAll(".yc-cell-result")[2].scrollIntoView({block:"start"}); true;'); await ctx.capture('actual-failed-command');
    ctx.checks.push('Actual receipt-bound cell cards show profile, exit status, original/staged hashes and overlays; real malicious-looking stdout remains inert plain text');
    const calls = ctx.requests.length; await ctx.reload();
    await waitFor('Boolean([...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("NATIVE_CODE_CELL")))');
    await evaluate('[...document.querySelectorAll("#yc-history .yc-history-item")].find(node=>node.textContent.startsWith("NATIVE_CODE_CELL")).click()');
    await evaluate('document.querySelector(".yc-open-work").click()'); await waitFor('document.querySelectorAll(".yc-cell-result").length===3'); assert.equal(ctx.requests.length, calls);
    const restored = await envelope(`window.studio.work.inspect(${JSON.stringify(parentId)})`); assert.deepEqual(restored.mission.steps.filter(step => step.tool === 'run_python_checks').map(step => step.result.snapshot.id), ctx.proof.cells.map(cell => cell.snapshot.id));
    assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'calculator.py'), 'utf8'), original);
    await click('.yc-work-artifact button', 'Validate edit for review'); await waitFor('Boolean([...document.querySelectorAll(".yc-work-artifact button")].find(node=>node.textContent==="Apply reviewed edit"))');
    assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'calculator.py'), 'utf8'), original);
    await click('.yc-work-artifact button', 'Apply reviewed edit'); await waitFor('document.querySelector(".yc-work-delivery").textContent.includes("Reviewed edit applied.")');
    assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'calculator.py'), 'utf8'), staged);
    const final = await envelope(`window.studio.work.inspect(${JSON.stringify(parentId)})`); const delivery = final.mission.artifacts.find(item => item.id === ctx.proof.proposal_id).delivery; assert.equal(delivery.status, 'applied'); assert.equal(delivery.verified_sha256, sha(staged)); ctx.proof.delivery = delivery;
    await ctx.capture('reviewed-apply'); ctx.checks.push('Reload restores the same committed snapshots without model or cell replay; source changes only after explicit fresh validation and Apply, verified by the CommitService receipt');
  },
});
