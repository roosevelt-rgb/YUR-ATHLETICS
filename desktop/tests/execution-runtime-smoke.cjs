'use strict';
// Explicit operator preparation and one actual cell. Only model decisions use
// a fixture; the native UI, selected resource, setup receipts and cell are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
if (process.env.YUR_RUN_RUNTIME_SETUP_TESTS !== '1') throw new Error('Set YUR_RUN_RUNTIME_SETUP_TESTS=1 to authorize native operator preparation.');
const expectedDistro = process.env.YUR_EXECUTION_DISTRO;
if (!expectedDistro || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(expectedDistro)) throw new Error('Select the exact reviewed test distribution through YUR_EXECUTION_DISTRO.');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const monitored = ['tests/execution-runtime-smoke.cjs', 'tests/specialists-smoke.cjs',
  'src/main.js', 'src/preload.js', 'src/work-transport.js', 'src/work-view.js',
  'src/conversation-view.js', 'src/studio-editor.html', 'src/conversation.css',
  'src/execution-runtime-view.js', 'src/execution-runtime-transport.js',
  'foundry/runtime_setup_contract.py', 'foundry/runtime_setup_store.py',
  'foundry/execution_setup.py', 'foundry/execution_setup_cli.py',
  'foundry/commit_service.py', 'foundry/orchestration.py', 'foundry/execution_cell.py',
  'foundry/work_cells.py', 'foundry/work_engine.py', 'foundry/work_cli.py'];
const fingerprints = () => Object.fromEntries(monitored.map(name => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))]));
const before = fingerprints();
const source = 'def value():\n    return 37\n';

nativeFixture({ prefix: 'execution-runtime', model: 'execution-runtime-fixture', timeoutMs: 300000, gracefulShutdown: true,
  async afterShutdown(ctx, observed) {
    const operationId = ctx.proof.operation_id;
    try {
      if (operationId) {
        const root = path.resolve(__dirname, '..');
        const environment = { ...require('../src/work-transport').cleanEnvironment(process.env), YUR_DESKTOP_HOME: path.join(ctx.tempRoot, 'journal'), PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' };
        const frame = { request_id: randomUUID(), command: 'inspect', operation_id: operationId };
        const result = spawnSync(require('../src/desktop-runtime').desktopPython(root), ['-B', '-m', 'foundry.execution_setup_cli'], {
          cwd: root, env: environment, input: JSON.stringify(frame) + '\n', encoding: 'utf8', timeout: 8000, maxBuffer: 65536, shell: false, windowsHide: true,
        });
        assert.equal(result.status, 0, 'Post-shutdown read-only setup inspection must exit successfully');
        const retained = JSON.parse(result.stdout);
        assert.equal(retained.ok, true); assert.equal(retained.request_id, frame.request_id);
        ctx.proof.after_shutdown = retained.result;
        if (ctx.proof.prepared) assert.ok(retained.result.setup, 'The committed preparation must remain inspectable after shutdown');
        if (retained.result.setup) {
          assert.equal(retained.result.setup.operation_id, operationId);
          assert.equal(retained.result.setup.evidence.owned_process_exit_confirmed, true, 'Unconfirmed cleanup cannot pass native acceptance');
          assert.ok(['released', 'expired', 'failed'].includes(retained.result.setup.state));
        }
      }
      assert.equal(observed, true);
    } finally {
      const after = fingerprints();
      ctx.proof.source_verification = { before, after, changed: Object.keys(before).filter(name => before[name] !== after[name]) };
      assert.deepEqual(after, before, 'Native runtime preparation source changed during validation');
    }
  },
  handle({ body, completed, call, send, proof }) {
    if (process.env.YUR_RUNTIME_SETUP_FAILURE_FIXTURE === '1') {
      // This exercises finish() directly while the prepared hold is active;
      // run(ctx)'s finally is not the source of its cleanup evidence.
      proof.intentional_handler_failure = true;
      throw new Error('INTENTIONAL_RUNTIME_SETUP_HANDLER_FAILURE');
    }
    assert.ok(body.tools.some(tool => tool.function.name === 'run_python_checks'));
    if (!completed.length) return call('run_python_checks', { files: ['prepared.py'], profile: 'python-compile-serial', test_directory: '.', proposal_ids: [] });
    assert.equal(completed.length, 1);
    const result = completed[0].value;
    assert.equal(result.schema, 'yur.work-cell-result.v1');
    assert.equal(result.committed, true); assert.equal(result.status, 'recorded');
    assert.equal(result.execution.status, 'completed'); assert.equal(result.execution.exit_code, 0);
    assert.equal(result.execution.runtime.distro, expectedDistro);
    assert.match(result.provenance.result_receipt, /^[0-9a-f]{64}$/);
    proof.cell = result;
    send('PREPARED_RUNTIME_CELL_RECORDED: the selected resource compiled the exact source snapshot.');
  },
  async run(ctx) {
    const { evaluate, waitFor, envelope, click } = ctx;
    ctx.proof.source_verification = { before };
    ctx.proof.selected_distro = expectedDistro;
    ctx.proof.preparation_requested_by = 'explicit-native-operator-action';
    let operationId = null, released = false;
    try {
      await evaluate('document.getElementById("yc-settings-open").click()');
      await waitFor('Boolean(document.getElementById("yc-execution-runtime")) && !document.getElementById("yc-execution-check").disabled');
      assert.equal(ctx.requests.length, 0);
      assert.deepEqual(await envelope('window.studio.executionRuntime.inspect({operation_id:null})'), { setup: null, receipt: null });
      await evaluate('document.getElementById("yc-execution-check").click()');
      await waitFor('!document.getElementById("yc-execution-check").disabled && !document.getElementById("yc-execution-prepare").disabled', 40000);
      assert.equal(await evaluate('document.getElementById("yc-execution-distro").disabled'), true, 'The explicit environment override locks selection');
      assert.ok(await evaluate(`document.getElementById('yc-execution-runtime').textContent.includes(${JSON.stringify(expectedDistro)})`));
      ctx.proof.checked = await evaluate('({state:document.getElementById("yc-execution-runtime").dataset.state,facts:JSON.parse(document.getElementById("yc-execution-receipt").textContent)})');
      await evaluate('document.getElementById("yc-execution-runtime").scrollIntoView({block:"start"})');
      await ctx.capture('checked-resource');
      ctx.checks.push('Settings distinguishes model connection from a fresh exact-resource check; the explicit environment selection is visible and locked, with no model or preparation request from opening Settings');

      await evaluate('document.getElementById("yc-execution-prepare").click()');
      await waitFor('Boolean(document.getElementById("yc-execution-runtime").dataset.operationId)');
      operationId = await evaluate('document.getElementById("yc-execution-runtime").dataset.operationId');
      assert.match(operationId, /^[0-9a-f-]{36}$/);
      ctx.proof.operation_id = operationId;
      await waitFor('!document.getElementById("yc-execution-release").disabled', 50000);
      const prepared = await envelope(`window.studio.executionRuntime.inspect({operation_id:${JSON.stringify(operationId)}})`);
      assert.equal(prepared.setup.state, 'ready');
      assert.equal(prepared.setup.distro, expectedDistro);
      assert.match(prepared.receipt.hash, /^[0-9a-f]{64}$/);
      ctx.proof.prepared = prepared;
      assert.equal(ctx.requests.length, 0);
      await evaluate('document.getElementById("yc-execution-runtime").scrollIntoView({block:"start"})');
      await ctx.capture('prepared-resource');
      ctx.checks.push('Only explicit Prepare creates the bounded setup operation; a real reviewed resource reaches a committed ready receipt before Code starts');

      fs.writeFileSync(path.join(ctx.sourceRoot, 'prepared.py'), source);
      await click('#yc-preferences-panel button', '← Back to conversation');
      await evaluate('document.getElementById("yc-mode").value="code"; document.getElementById("yc-mode").dispatchEvent(new Event("change")); document.getElementById("yc-attach-repository").click()');
      await waitFor(`document.getElementById('yc-repository').textContent.includes(${JSON.stringify(ctx.sourceRoot)})`);
      await evaluate('document.getElementById("yc-input").value="Compile prepared.py once using the reviewed execution resource. Do not edit or prepare a runtime from this mission."; document.getElementById("yc-form").requestSubmit()');
      await waitFor('document.getElementById("yc-messages").textContent.includes("PREPARED_RUNTIME_CELL_RECORDED") && !document.getElementById("yc-send").disabled', 60000);
      const missions = (await envelope('window.studio.work.list(null)')).missions;
      assert.equal(missions.length, 1);
      const work = await envelope(`window.studio.work.inspect(${JSON.stringify(missions[0].id)})`);
      assert.equal(work.mission.status, 'completed');
      assert.equal(work.mission.steps.length, 1);
      assert.equal(work.mission.steps[0].tool, 'run_python_checks');
      assert.equal(work.events.filter(event => event.event_type === 'work.cell.result.committed').length, 1);
      assert.equal(fs.readFileSync(path.join(ctx.sourceRoot, 'prepared.py'), 'utf8'), source);
      ctx.proof.work_id = work.mission.id;
      assert.equal(ctx.requests.length, 2);
      await evaluate('document.querySelector(".yc-open-work").click()');
      await waitFor('Boolean(document.querySelector(".yc-cell-result"))');
      await ctx.capture('selected-resource-code-result');
      ctx.checks.push('The existing Work manager performs one actual contained compile using the exact Settings distribution, with a retained cell receipt and unchanged source');

      await evaluate('document.getElementById("yc-settings-open").click()');
      await waitFor('Boolean(document.getElementById("yc-execution-release")) && !document.getElementById("yc-execution-release").disabled');
      await evaluate('document.getElementById("yc-execution-release").click()');
      await waitFor('document.getElementById("yc-execution-release").disabled && !document.getElementById("yc-execution-check").disabled', 30000);
      const terminal = await envelope(`window.studio.executionRuntime.inspect({operation_id:${JSON.stringify(operationId)}})`);
      assert.equal(terminal.setup.state, 'released');
      assert.match(terminal.receipt.hash, /^[0-9a-f]{64}$/);
      released = true; ctx.proof.released = terminal;
      await evaluate('document.getElementById("yc-execution-runtime").scrollIntoView({block:"start"})');
      await ctx.capture('released-resource');
      const calls = ctx.requests.length;
      await ctx.reload();
      const restored = await envelope(`window.studio.executionRuntime.inspect({operation_id:${JSON.stringify(operationId)}})`);
      assert.deepEqual(restored.setup, terminal.setup);
      assert.deepEqual(restored.receipt, terminal.receipt);
      assert.equal(ctx.requests.length, calls);
      await evaluate('document.getElementById("yc-settings-open").click()');
      await waitFor('Boolean(document.getElementById("yc-execution-check")) && !document.getElementById("yc-execution-check").disabled');
      await evaluate('document.getElementById("yc-execution-check").click()');
      await waitFor('!document.getElementById("yc-execution-check").disabled && !document.getElementById("yc-execution-prepare").disabled', 40000);
      const rechecked = await evaluate('JSON.parse(document.getElementById("yc-execution-receipt").textContent)');
      assert.ok(Date.parse(rechecked.latest_check.checked_at) > Date.parse(ctx.proof.checked.facts.latest_check.checked_at));
      ctx.proof.rechecked = rechecked;
      const unchanged = await envelope(`window.studio.executionRuntime.inspect({operation_id:${JSON.stringify(operationId)}})`);
      assert.deepEqual(unchanged.setup, terminal.setup);
      assert.deepEqual(unchanged.receipt, terminal.receipt);
      assert.equal(ctx.requests.length, calls);
      ctx.checks.push('Explicit Release retains terminal setup evidence; reload and another explicit Check preserve the same record without another model call, preparation or cell');
    } finally {
      if (operationId && !released) {
        try { ctx.proof.failure_cleanup = await evaluate(`window.studio.executionRuntime.release({operation_id:${JSON.stringify(operationId)}})`); }
        catch (error) { ctx.proof.failure_cleanup = { confirmed: false, message: error.message }; }
      }
      const after = fingerprints();
      ctx.proof.source_verification.after = after;
      ctx.proof.source_verification.changed = Object.keys(before).filter(name => before[name] !== after[name]);
      assert.deepEqual(after, before, 'Native runtime preparation source changed during validation');
    }
  },
});
