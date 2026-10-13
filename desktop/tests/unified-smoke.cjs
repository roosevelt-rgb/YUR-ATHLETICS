"use strict";
// Native Electron proof of the unified Desktop: real main/preload/renderer, real
// IntelliFlow harness engine sidecar, real Work missions. Only the model is a fixture.
const assert = require("node:assert/strict");
const os = require("node:os");
const { nativeFixture } = require("./specialists-smoke.cjs");

process.env.YUR_HARNESS_ROOTS = os.tmpdir(); // the fixture project folder lives under the temp dir
const seen = { packSystem: "" };

nativeFixture({
  prefix: "unified",
  model: "unified-fixture",
  timeoutMs: 280000,
  gracefulShutdown: true,
  handle({ body, goal, send }) {
    const system = body.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    if (goal.includes("UNIFIED_PACK_RUN")) {
      seen.packSystem = system;
      return send("UNIFIED_PACK_DONE: priced the takeoff and listed risks.");
    }
    return send(
      "UNIFIED_LIFECYCLE_DONE: the deployed agent completed its run.",
    );
  },
  async run(ctx) {
    const { evaluate, waitFor, envelope } = ctx;
    const combined = process.env.YUR_GLIDER_RC6 === '1';
    if (combined) {
      await waitFor('Boolean(document.getElementById("glider-frame"))');
      assert.equal((await evaluate('window.studio.integration.info()')).enabled, true);
      ctx.proof.glider_frame = true;
      ctx.checks.push('Marketplace and lifecycle fixture is running inside the actual combined Glider frame');
    }
    // Backend conditions spawn a Python RPC per check; poll at a realistic UI cadence.
    const poll = async (expression, timeout = 60000) => {
      const limit = Date.now() + timeout;
      while (Date.now() < limit) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      throw new Error(`Timed out: ${expression}`);
    };
    const deployments = () =>
      envelope("window.studio.lifecycles.list()").then(
        (result) => result.deployments,
      );

    // 1. Deployed agents view + an automatically dispatched continuous lifecycle.
    await evaluate('document.getElementById("yc-lifecycles-open").click()');
    await waitFor(
      'document.getElementById("yc-thread-title").textContent==="Deployed agents" && Boolean(document.querySelector(".yu-note"))',
    );
    const deployed = await envelope(
      `window.studio.lifecycles.deploy(${JSON.stringify({ name: "Unified watcher", kind: "work_goal", goal: "UNIFIED_LIFECYCLE_RUN: summarize the latest evidence.", model: ctx.model, trigger: { kind: "continuous", cooldown_seconds: 3600 }, max_runs: 2 })})`,
    );
    assert.equal(deployed.deployment.state, "active");
    await poll(
      `window.studio.lifecycles.list().then(r=>r.ok && r.result.deployments.some(d=>d.id===${JSON.stringify(deployed.deployment.id)} && d.runs_completed===1))`,
      60000,
    );
    const [watcher] = (await deployments()).filter(
      (item) => item.id === deployed.deployment.id,
    );
    const run = await envelope(
      `window.studio.work.inspect(${JSON.stringify(watcher.last_mission_id)})`,
    );
    assert.equal(run.mission.status, "completed");
    assert.match(run.mission.answer, /UNIFIED_LIFECYCLE_DONE/);
    if (combined) {
      const requestsBeforeObservation = ctx.requests.length;
      await waitFor(`document.getElementById('franklin-observation')?.dataset.missionId===${JSON.stringify(watcher.last_mission_id)}`);
      await evaluate('document.getElementById("franklin-toggle").click()');
      await waitFor('document.getElementById("franklin-panel").hidden===false && document.getElementById("franklin-observation").hidden===false');
      const observed = await evaluate('(()=>{const node=document.getElementById("franklin-observation");return {text:node.textContent,sequence:Number(node.dataset.sequence),mission_id:node.dataset.missionId,visible:node.getClientRects().length>0}})()');
      assert.equal(observed.mission_id, watcher.last_mission_id); assert.ok(observed.sequence > 0); assert.equal(observed.visible, true);
      assert.match(observed.text, /Latest: Work request — Completed/);
      assert.equal(ctx.requests.length, requestsBeforeObservation, 'Franklin activity observation must not request another model response');
      ctx.proof.franklin_observation = observed;
      await ctx.capture('franklin-observation');
      await evaluate('document.getElementById("franklin-close").click()');
      ctx.checks.push('Franklin visibly observes the exact completed lifecycle Work mission from the existing activity feed with no additional model request');
    }
    await envelope(
      `window.studio.lifecycles.setState(${JSON.stringify(watcher.id)}, ${watcher.revision}, 'paused')`,
    );
    await evaluate('document.getElementById("yc-lifecycles-open").click()');
    await waitFor(
      '[...document.querySelectorAll(".yu-deployment h3")].some(n=>n.textContent==="Unified watcher")',
    );
    await evaluate('(()=>{const refresh=[...document.querySelectorAll(".yu-toolbar button")].find(button=>button.textContent==="Refresh");refresh.click();refresh.click();refresh.click();})()');
    await waitFor('[...document.querySelectorAll(".yu-pill")].filter(node=>node.textContent.startsWith("In-app dispatcher:")).length===1');
    await new Promise(resolve => setTimeout(resolve, 600));
    ctx.proof.dispatcher_pill_count = await evaluate('[...document.querySelectorAll(".yu-pill")].filter(node=>node.textContent.startsWith("In-app dispatcher:")).length');
    assert.equal(ctx.proof.dispatcher_pill_count, 1, 'Overlapping lifecycle refreshes must leave exactly one current dispatcher status');
    ctx.checks.push('Overlapping lifecycle refreshes settle to exactly one dispatcher status pill');
    await ctx.capture("deployed-agents");
    ctx.checks.push(
      "Deployed agents: a continuous lifecycle was dispatched by the in-app dispatcher into a real Work mission, reconciled, then paused from the UI API",
    );

    // 2. Start the existing sidecar explicitly; isolated runners disable autostart.
    await envelope("window.studio.harness.start()");
    await poll(
      'window.studio.harness.status().then(r=>r.ok && ["ready","error","unavailable"].includes(r.result.state))',
      120000,
    );
    const harness = await envelope("window.studio.harness.status()");
    assert.equal(harness.state, "ready", harness.error || "harness not ready");
    ctx.proof.harness = {
      port: harness.port,
      authority: harness.health?.authority,
    };

    // 3. Marketplace: forge -> deploy into studio -> run now -> completed with pack context.
    const forged = await envelope(
      `window.studio.marketplace.forge(${JSON.stringify({ agent_type: "construction estimator", capabilities: ["price quantity takeoffs", "flag bid risks"], industry: "construction", provider: "ollama" })})`,
    );
    ctx.proof.pack_id = forged.pack_id;
    const packDetail = await envelope(`window.studio.marketplace.pack(${JSON.stringify(forged.pack_id)})`);
    assert.match(packDetail.content_sha256, /^[a-f0-9]{64}$/);
    const toolIndex = JSON.parse(packDetail.pack.files["tools/tools-index.json"]);
    assert.equal(toolIndex.source, "pack-generator");
    assert.equal(toolIndex.reference_status, "declared");
    assert.equal(toolIndex.execution_authority, "none");
    assert.equal(toolIndex.task_tested, false);
    assert.ok(Array.isArray(toolIndex.tool_ids) && toolIndex.tool_ids.length > 0);
    const declaredToolIds = [...toolIndex.tool_ids].sort();
    const declaration = `Declared pack tools (guidance only): ${declaredToolIds.join(", ")}.`;
    const fromPack = await envelope(
      `window.studio.marketplace.deploy(${JSON.stringify(forged.pack_id)}, ${JSON.stringify({ name: "Estimator from marketplace", goal: "UNIFIED_PACK_RUN: price the takeoff and list the risks.", model: ctx.model, trigger: { kind: "manual" }, maxRuns: 3 })})`,
    );
    assert.equal(fromPack.deployment.kind, "marketplace_pack");
    assert.equal(fromPack.deployment.source.content_sha256, packDetail.content_sha256);
    const committedPack = (await deployments()).find(item => item.id === fromPack.deployment.id);
    assert.ok(committedPack, "the marketplace deployment is persisted in the lifecycle store");
    assert.ok(committedPack.instructions.includes(declaration), "the committed deployment includes the generated tool identifiers");
    assert.doesNotMatch(committedPack.instructions, /tools-index/);
    assert.match(committedPack.instructions, /not tools you can call/);
    assert.match(committedPack.instructions, /OrchestrationManager and Commit Service remain authoritative/);
    await envelope(
      `window.studio.lifecycles.runNow(${JSON.stringify(fromPack.deployment.id)}, ${fromPack.deployment.revision})`,
    );
    await poll(
      `window.studio.lifecycles.list().then(r=>r.ok && r.result.deployments.some(d=>d.id===${JSON.stringify(fromPack.deployment.id)} && d.runs_completed===1))`,
      60000,
    );
    assert.ok(
      seen.packSystem.includes(forged.pack_id),
      "pack instructions reached the model as system context",
    );
    assert.ok(seen.packSystem.includes(declaration), "the generated tool declarations reached the model as system context");
    assert.doesNotMatch(seen.packSystem, /tools-index/);
    assert.match(seen.packSystem, /not tools you can call/);
    assert.match(seen.packSystem, /do not grant orchestration, validation, commit, filesystem, or provider authority/);
    ctx.proof.pack_tool_declarations = {
      tool_ids: declaredToolIds,
      deployment_id: committedPack.id,
      declaration,
      committed_instructions_verified: true,
      model_system_context_verified: true,
      index_filename_absent: true,
      execution_authority: "none",
    };
    ctx.checks.push("Generated pack tool_ids persist in the committed deployment and actual model system context as declaration-only guidance; the tools-index filename grants no capability");
    await evaluate('document.getElementById("yc-marketplace-open").click()');
    await waitFor(
      `[...document.querySelectorAll(".yu-card h3")].length>0 && document.querySelector(".yu-pill")?.textContent.includes("ready")`,
      30000,
    );
    await ctx.capture("agent-marketplace");
    const inventory = await envelope("window.studio.marketplace.inventory()");
    assert.ok(inventory.items.some(item => item.kind === "curated"));
    assert.ok(inventory.items.some(item => item.kind === "pack" && item.id === forged.pack_id));
    await evaluate('document.querySelector(".yu-tabs [data-tab=catalog]").click()');
    await waitFor('Boolean(document.querySelector(".yu-tab-panel input[type=search]"))');
    await evaluate(`(() => {const search = document.querySelector('input[aria-label="Search marketplace catalog"]'); search.value = ${JSON.stringify(forged.pack_id)}; search.dispatchEvent(new Event('input'));})()`);
    await waitFor('document.querySelectorAll(".yu-grid > .yu-card").length === 1');
    assert.match(await evaluate('document.querySelector(".yu-grid").textContent'), /inspect to verify local pack/);
    await evaluate('[...document.querySelectorAll(".yu-grid button")].find(button => button.textContent === "Inspect pack").click()');
    await waitFor(`document.querySelector(".yu-grid").textContent.includes(${JSON.stringify(packDetail.content_sha256)})`);
    ctx.proof.marketplace_inventory = { total: inventory.items.length, curated: inventory.items.filter(item => item.kind === "curated").length, verified_pack_sha256: packDetail.content_sha256 };
    ctx.checks.push(
      "Agent Marketplace: Karma forge created a pack in the real IntelliFlow engine; it deployed into the studio and ran as a real Work mission with the pack instructions as system context",
    );

    // 4. IntelliFlow coding: governed task through the harness pipeline, visible in the view.
    const opened = await envelope(
      `window.studio.harness.request('POST','/api/workspaces/open',${JSON.stringify({ path: ctx.sourceRoot })})`,
    );
    const task = await envelope(
      `window.studio.harness.request('POST','/api/tasks',${JSON.stringify({ workspace_id: opened.workspace.id, prompt: "Inspect story.md and summarize it.", provider: "mock", mode: "inspect", max_steps: 6 })})`,
    );
    await poll(
      `window.studio.harness.request('GET','/api/tasks/${task.id}').then(r=>r.ok && ['completed','waiting_approval','failed'].includes(r.result.task.status))`,
      60000,
    );
    const done = await envelope(
      `window.studio.harness.request('GET','/api/tasks/${task.id}')`,
    );
    assert.equal(done.task.status, "completed");
    ctx.proof.coding_task = {
      id: task.id,
      certificate: done.certificate?.certificate_hash,
    };
    await evaluate('document.getElementById("yc-intelliflow-open").click()');
    if (combined) {
      await waitFor('document.getElementById("rc6-panel")?.hidden===false');
      assert.equal((await evaluate('window.studio.rc6.status()')).running, false);
    } else await waitFor('document.querySelectorAll(".yu-task").length>0', 30000);
    await ctx.capture("intelliflow-coding");
    ctx.checks.push(
      combined
        ? 'A governed sidecar task completed with its certificate; combined-frame coding navigation opens the selected RC6 surface without starting a model'
        : "IntelliFlow coding: a governed task ran OrchestrationManager -> Validation -> CommitService in the engine sidecar and is listed in the studio view",
    );
    if (combined) await evaluate('document.getElementById("glider-desktop").click()');

    // 5. Organism: pulse -> ship gate -> DEBT -> one paused proposed mission, shown in the live view.
    const candidate = await envelope(
      `window.studio.ship.create(${JSON.stringify({ name: "Smoke storefront", money_path: "Checkout must answer", probes: [{ kind: "http_ok", label: "checkout", url: "http://127.0.0.1:9/health" }] })})`,
    );
    const routed = await envelope(
      `window.studio.organism.pulse(${JSON.stringify({ source: "smoke", mutation_type: "schedule_pulse", payload: { target: { ship_candidate_id: candidate.candidate.id } } })})`,
    );
    assert.equal(routed.routed, "check_candidate");
    const checked = await envelope(
      `window.studio.ship.checkNow(${JSON.stringify(candidate.candidate.id)})`,
    );
    assert.equal(checked.verdict, "DEBT");
    assert.equal(checked.proposed.state, "paused");
    await evaluate('document.getElementById("yc-organism-open").click()');
    await waitFor(
      'document.getElementById("yc-thread-title").textContent==="Organism" && document.querySelectorAll(".yu-tile").length>=6 && document.body.textContent.includes("Smoke storefront")',
      30000,
    );
    ctx.proof.organism = {
      candidate: candidate.candidate.id,
      verdict: checked.verdict,
      proposed: checked.proposed.id,
    };
    await ctx.capture("organism");
    ctx.checks.push(
      "Organism: a Pulse schedule tick targeted a ship candidate, the gate recorded DEBT from a real probe, proposed one paused mission, and the live view shows it",
    );
  },
});
