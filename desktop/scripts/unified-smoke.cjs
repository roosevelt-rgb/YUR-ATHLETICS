"use strict";
// End-to-end proof across the three systems, with the REAL harness engine:
//   Marketplace (Karma forge) -> IntelliFlow harness (pack admission + governed coding task)
//   -> Desktop (lifecycle deployment -> headless runner -> real Work mission -> reconciled).
// Uses temporary state only, a fixture model for Desktop Work, and the engine's
// deterministic "mock" provider for the coding task, so no Ollama or cloud call is made.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHarnessSidecar } = require("../src/harness-sidecar");
const { packToDeploymentSpec } = require("../src/marketplace-deploy");

const root = path.resolve(__dirname, "..");
const unified = process.env.YUR_UNIFIED_ROOT || path.resolve(root, "..", "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yur-unified-smoke-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${String(detail).slice(0, 200)}` : ""}`,
  );
};

function python(code, input, env) {
  const result = spawnSync("python", ["-B", "-c", code], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env },
    timeout: 120000,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.stdout || `python exited ${result.status}`,
    );
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

(async () => {
  const workspace = path.join(temp, "project");
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, "estimate.py"),
    "def total(items):\n    return sum(items)\n",
  );
  const desktopHome = path.join(temp, "desktop-home");
  const sidecar = createHarnessSidecar({
    unifiedRoot: unified,
    stateDir: path.join(temp, "harness"),
    getAllowedRoots: () => [workspace],
  });
  try {
    const status = await sidecar.start();
    check(
      "IntelliFlow harness sidecar starts healthy on loopback",
      status.state === "ready",
      status.error ||
        `127.0.0.1:${status.port} ${status.health?.authority?.orchestration}->${status.health?.authority?.commit}`,
    );
    if (status.state !== "ready")
      throw new Error(
        status.log_tail?.slice(-8).join("\n") || "harness not ready",
      );

    const forged = await sidecar.request("POST", "/api/karma/forge", {
      agent_type: "construction estimator",
      capabilities: ["price quantity takeoffs", "flag bid risks"],
      industry: "construction",
      provider: "ollama",
      name: "Smoke Estimator",
    });
    check(
      "Marketplace Karma forge creates an admitted pack",
      forged.ok && forged.result.pack_id,
      forged.ok
        ? `${forged.result.pack_id}: ${forged.result.agent_count} agents, ${forged.result.tool_count} declared tools`
        : forged.error.message,
    );
    const detail = await sidecar.request(
      "GET",
      `/api/packs/${forged.result.pack_id}`,
    );
    check(
      "Harness re-verifies the stored pack (integrity + identity)",
      detail.ok && detail.result.content_sha256,
      detail.ok
        ? `sha256 ${detail.result.content_sha256.slice(0, 16)}…`
        : detail.error.message,
    );
    const listed = await sidecar.request("GET", "/api/packs");
    check(
      "Forged pack is listed for deployment",
      listed.ok &&
        listed.result.packs.some(
          (item) => item.pack_id === forged.result.pack_id,
        ),
    );

    const spec = packToDeploymentSpec(detail.result, {
      goal: "Price the latest takeoff and list the top risks.",
      model: "fixture",
      trigger: { kind: "continuous", cooldown_seconds: 30 },
      maxRuns: 3,
    });
    const deployed = python(
      `import json,sys\nfrom foundry import work_cli\nprint(json.dumps(work_cli.handle({"command":"lifecycle_deploy","spec":json.load(sys.stdin)})))`,
      JSON.stringify(spec),
      { YUR_DESKTOP_HOME: desktopHome },
    );
    check(
      "Pack deploys into the Desktop as a governed lifecycle",
      deployed.deployment?.kind === "marketplace_pack" &&
        deployed.deployment.state === "active",
      `deployment ${deployed.deployment?.id} · ${deployed.deployment?.trigger?.kind}`,
    );

    const ran = python(
      `import json
from foundry.lifecycle_runner import tick
from foundry import work_cli
summary = tick(${JSON.stringify(desktopHome)}, adapter_factory=lambda model: (lambda *_: {"content": "Takeoff priced; risks listed.", "tool_calls": []}), log=lambda *_: None)
dep = work_cli.handle({"command": "lifecycle_list"})["deployments"][0]
mission = work_cli.handle({"command": "inspect", "mission_id": dep["last_mission_id"]})["mission"]
print(json.dumps({"summary": summary, "deployment": dep, "mission": {"status": mission["status"], "answer": mission["answer"], "system": mission["request"]["messages"][0]["content"][:120]}}))`,
      "",
      { YUR_DESKTOP_HOME: desktopHome },
    );
    check(
      "Headless runner executes the deployed agent as a real Work mission",
      ran.summary.completed === 1 && ran.mission.status === "completed",
      `answer: ${ran.mission.answer}`,
    );
    check(
      "Pack instructions reach the run as system context",
      ran.mission.system.includes(forged.result.pack_id),
    );
    check(
      "Lifecycle reconciles and schedules the next continuous run",
      ran.deployment.runs_completed === 1 &&
        ran.deployment.next_run_at !== null,
      `next ${ran.deployment.next_run_at}`,
    );
    const integrity = python(
      'import json\nfrom pathlib import Path\nimport os\nfrom foundry.commit_service import CommitService\nwith CommitService(Path(os.environ["YUR_DESKTOP_HOME"])) as s: r=s.verify_integrity(); print(json.dumps({k:r[k] for k in ("deployments","deployment_events","deployment_head_hash","work","ok") if k in r}))',
      "",
      { YUR_DESKTOP_HOME: desktopHome },
    );
    check(
      "Desktop journal hash chain verifies after the run",
      integrity.ok === true && integrity.deployment_events === 3,
      `deployment events ${integrity.deployment_events}, head ${String(integrity.deployment_head_hash).slice(0, 16)}…`,
    );

    const opened = await sidecar.request("POST", "/api/workspaces/open", {
      path: workspace,
    });
    check(
      "IntelliFlow opens the project workspace inside allowed roots",
      opened.ok && opened.result.workspace?.id,
      opened.ok ? opened.result.workspace?.root_path : opened.error.message,
    );
    const task = await sidecar.request("POST", "/api/tasks", {
      workspace_id: opened.result.workspace?.id,
      prompt: "Inspect estimate.py and summarize what total() does.",
      provider: "mock",
      mode: "inspect",
      max_steps: 6,
    });
    check(
      "Governed coding task is accepted by the OrchestrationManager",
      task.ok && task.result.id,
      task.ok ? `task ${task.result.id}` : task.error.message,
    );
    let final = null;
    for (let attempt = 0; attempt < 60 && task.ok; attempt++) {
      const current = await sidecar.request(
        "GET",
        `/api/tasks/${task.result.id}`,
      );
      if (
        current.ok &&
        [
          "completed",
          "failed",
          "cancelled",
          "interrupted",
          "max_steps",
          "waiting_approval",
        ].includes(current.result.task.status)
      ) {
        final = current.result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check(
      "Coding task reaches a terminal governed state",
      final && ["completed", "waiting_approval"].includes(final.task.status),
      final
        ? `${final.task.status}${final.certificate ? ` · certificate ${final.certificate.certificate_hash.slice(0, 16)}…` : ""}`
        : "timed out",
    );
    const outside = await sidecar.request("POST", "/api/workspaces/open", {
      path: os.homedir(),
    });
    check(
      "Harness refuses workspaces outside the Desktop-granted roots",
      !outside.ok,
      outside.ok ? "opened unexpectedly" : outside.error.message,
    );
    const denied = await sidecar.request(
      "POST",
      "/api/auth/change-password",
      {},
    );
    check(
      "Renderer proxy denies non-allowlisted harness APIs",
      !denied.ok && denied.error.code === "HARNESS_PATH_DENIED",
    );
  } catch (error) {
    check("Smoke completed without an unexpected error", false, error.message);
  } finally {
    await sidecar.stop();
    check(
      "Harness sidecar stops cleanly",
      sidecar.status().state === "stopped",
    );
    const receipt = {
      schema: "yur-unified-smoke/v1",
      at: new Date().toISOString(),
      passed: results.every((item) => item.ok),
      results,
    };
    const out = path.join(unified, "evidence");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, `unified-smoke-${receipt.at.replace(/[:.]/g, "-")}.json`),
      JSON.stringify(receipt, null, 2),
    );
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    console.log(
      `\n${receipt.passed ? "UNIFIED SMOKE PASSED" : "UNIFIED SMOKE FAILED"} (${results.filter((r) => r.ok).length}/${results.length})`,
    );
    process.exit(receipt.passed ? 0 : 1);
  }
})();
