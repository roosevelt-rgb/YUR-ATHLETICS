/* Organism: the live loop on one screen. PULSE → MISSION → SHIP GATE → (PASS | DEBT → proposed mission).
   Everything shown comes from the journal (lifecycle + ship events) or a live loopback probe; nothing is simulated. */
"use strict";
(() => {
  const el = (tag, value = "", className = "") => {
    const node = document.createElement(tag);
    if (value !== null) node.textContent = String(value ?? "");
    if (className) node.className = className;
    return node;
  };
  const when = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  };
  async function call(fn) {
    const response = await fn();
    if (!response?.ok)
      throw new Error(response?.error?.message || "The request failed.");
    return response.result;
  }
  const LITHIUM_DB = "D:\\dev\\nfl-agent-glider\\data\\lithium_brain.db";
  const FIRST_PROOF = {
    name: "LITHIUM NFL predictor",
    money_path:
      "v2_predictor Pro ($99/mo) and Enterprise ($999/mo) serve LITHIUM's real picks — only once they beat the closing line over a season.",
    interval_seconds: 86400,
    debt_goal:
      "LITHIUM is not ready to sell signals. Review its CLV scoreboard, explain what the numbers say, and list the smallest next steps to earn a positive closing-line value over a full season. Do not change LITHIUM's files.",
    probes: [
      {
        kind: "sqlite_metric",
        label: "settled picks",
        path: LITHIUM_DB,
        op: ">=",
        threshold: 256,
        query: "SELECT COUNT(*) FROM clv_picks WHERE settled_ts IS NOT NULL",
      },
      {
        kind: "sqlite_metric",
        label: "average CLV (points)",
        path: LITHIUM_DB,
        op: ">",
        threshold: 0,
        query:
          "SELECT AVG(clv_points) FROM clv_picks WHERE settled_ts IS NOT NULL",
      },
      {
        kind: "http_ok",
        label: "LITHIUM live server",
        url: "http://127.0.0.1:8856/health",
      },
    ],
  };

  function tile(title, value, detail, tone = "") {
    const node = el("div", null, `yu-tile ${tone}`);
    node.append(
      el("span", title, "yu-label"),
      el("strong", value, "yu-tile-value"),
    );
    if (detail) node.append(el("small", detail, "yu-hint"));
    return node;
  }

  function create(
    root,
    { api, onError = () => {}, onOpenDeployments = () => {} },
  ) {
    let disposed = false,
      timer = null,
      loading = false;
    const page = el("div", null, "yu-organism");
    page.append(
      el(
        "p",
        "The loop, live: Pulse turns events into missions, deployed agents do governed Work, and the ship gate decides what can make money now. A DEBT proposes a paused mission that waits for you.",
        "yu-note",
      ),
    );
    const tiles = el("div", null, "yu-tiles");
    const toolbar = el("div", null, "yu-row");
    const refresh = el("button", "Refresh");
    refresh.type = "button";
    const proof = el("button", "Add first proof: LITHIUM");
    proof.type = "button";
    const toDeployments = el("button", "Open deployed agents");
    toDeployments.type = "button";
    const status = el("span", "", "yu-hint");
    toolbar.append(refresh, proof, toDeployments, status);
    const candidates = el("section", null, "yu-list");
    const pulse = el("section", null, "yu-card");
    const feed = el("section", null, "yu-list");
    page.append(
      tiles,
      toolbar,
      el("h3", "Ship gate"),
      candidates,
      el("h3", "Send a pulse"),
      pulse,
      el("h3", "Live events (journal)"),
      feed,
    );
    root.appendChild(page);

    // Pulse form: the yur_core mutation contract.
    const type = document.createElement("select");
    for (const value of [
      "manual_trigger",
      "file_drop",
      "webhook",
      "db_change",
      "sensor_tick",
      "schedule_pulse",
    ]) {
      const option = el("option", value);
      option.value = value;
      type.appendChild(option);
    }
    const source = Object.assign(document.createElement("input"), {
      value: "desktop",
      maxLength: 80,
    });
    const payload = Object.assign(document.createElement("textarea"), {
      rows: 3,
      value: '{"note": "describe what happened"}',
    });
    const send = el("button", "Send pulse");
    send.type = "button";
    pulse.append(
      el(
        "small",
        'Targets: {"target": {"deployment_id": "…"}} runs an agent now · {"target": {"ship_candidate_id": "…"}} checks now · anything else becomes a paused proposed mission.',
        "yu-hint",
      ),
      type,
      source,
      payload,
      send,
    );
    send.addEventListener("click", async () => {
      send.disabled = true;
      try {
        const mutation = {
          source: source.value.trim() || "desktop",
          mutation_type: type.value,
          payload: JSON.parse(payload.value || "{}"),
        };
        const result = await call(() => api.organism.pulse(mutation));
        status.textContent = `Pulse ${result.mission.mission_id} → ${result.routed.replace("_", " ")}`;
        await load();
      } catch (error) {
        onError(error.message);
      } finally {
        send.disabled = false;
      }
    });

    function renderCandidate(item) {
      const card = el("article", null, "yu-card");
      const verdict = item.last_verdict || "unchecked";
      const head = el("div", null, "yu-row");
      head.append(
        el("h4", item.name),
        el(
          "span",
          verdict,
          `yu-pill ${verdict === "PASS" ? "yu-ok" : verdict === "DEBT" ? "yu-warn" : ""}`,
        ),
        el("span", item.state, `yu-pill yu-state-${item.state}`),
      );
      card.append(head, el("p", item.money_path, "yu-hint"));
      const notes = el("ul");
      for (const note of item.last_notes || []) notes.append(el("li", note));
      if (item.last_notes?.length) card.append(notes);
      card.append(
        el(
          "small",
          `Checks ${item.checks_run} · last ${when(item.last_checked_at)} · next ${item.state === "active" ? when(item.next_check_at) : "—"}` +
            (item.debt_deployment_id
              ? " · debt mission proposed (see Deployed agents)"
              : ""),
          "yu-hint",
        ),
      );
      const actions = el("div", null, "yu-row");
      const check = el("button", "Check now");
      check.type = "button";
      check.disabled = item.state !== "active";
      const toggle = el(
        "button",
        item.state === "active" ? "Pause" : "Activate",
      );
      toggle.type = "button";
      toggle.disabled = item.state === "retired";
      check.addEventListener("click", async () => {
        check.disabled = true;
        try {
          const result = await call(() => api.ship.checkNow(item.id));
          status.textContent = `${item.name}: ${result.verdict || "re-check queued"}${result.proposed ? " · proposed a paused debt mission" : ""}`;
          await load();
        } catch (error) {
          onError(error.message);
        } finally {
          check.disabled = false;
        }
      });
      toggle.addEventListener("click", async () => {
        try {
          await call(() =>
            api.ship.setState(
              item.id,
              item.revision,
              item.state === "active" ? "paused" : "active",
            ),
          );
          await load();
        } catch (error) {
          onError(error.message);
        }
      });
      actions.append(check, toggle);
      card.append(actions);
      return card;
    }

    async function load() {
      if (disposed || loading) return;
      loading = true;
      refresh.disabled = true;
      try {
        const data = await call(() => api.organism.status());
        if (disposed) return;
        const deployments = data.deployments,
          ship = data.ship,
          desktop = data.desktop || {};
        const harness = desktop.harness?.state || "unknown";
        tiles.replaceChildren(
          tile(
            "Deployed agents",
            String(deployments.total),
            Object.entries(deployments.by_state)
              .map(([k, v]) => `${v} ${k}`)
              .join(" · ") || "none yet",
          ),
          tile(
            "Missions run",
            String(deployments.runs_completed),
            `${deployments.in_flight} in flight`,
          ),
          tile(
            "Awaiting your approval",
            String(deployments.awaiting_approval),
            "paused, never run",
            deployments.awaiting_approval ? "yu-warn" : "",
          ),
          tile(
            "Ship gate",
            `${ship.pass} PASS · ${ship.debt} DEBT`,
            `${ship.total} candidates`,
            ship.debt ? "yu-warn" : ship.pass ? "yu-ok" : "",
          ),
          tile(
            "Journal",
            data.integrity.passed ? "verified" : "not opened yet",
            data.integrity.deployment_head_hash
              ? `head ${data.integrity.deployment_head_hash.slice(0, 12)}…`
              : "",
            data.integrity.passed ? "yu-ok" : "",
          ),
          tile(
            "Heartbeat",
            data.runner.running ? "headless runner" : "in-app",
            data.runner.running
              ? `last beat ${when(data.runner.detail?.heartbeat_at)}`
              : `ship ticker ${desktop.ship_ticker?.phase || "idle"}`,
          ),
          tile(
            "IntelliFlow harness",
            harness,
            "",
            harness === "ready" ? "yu-ok" : "",
          ),
          tile(
            "Ollama · ComfyUI",
            `${data.providers.ollama ? "up" : "down"} · ${data.providers.comfyui ? "up" : "down"}`,
            "loopback probes",
          ),
        );
        candidates.replaceChildren(
          ...(ship.items.length
            ? ship.items.map(renderCandidate)
            : [
                el(
                  "p",
                  "No ship candidates yet. Add the LITHIUM first proof to see the gate work on real data.",
                  "yu-hint",
                ),
              ]),
        );
        feed.replaceChildren(
          ...(data.recent.length
            ? data.recent.map((item) => {
                const row = el("div", null, "yu-row yu-event");
                row.append(
                  el("span", when(item.at), "yu-hint"),
                  el("span", item.lane, "yu-pill"),
                  el("strong", item.event_type),
                  el("span", item.subject),
                  el("span", item.detail, "yu-hint"),
                );
                return row;
              })
            : [el("p", "No events yet.", "yu-hint")]),
        );
        proof.disabled = ship.items.some(
          (item) => item.name === FIRST_PROOF.name && item.state !== "retired",
        );
        status.textContent = `Updated ${when(data.observed_at)}`;
      } catch (error) {
        status.textContent = error.message;
      } finally {
        loading = false;
        refresh.disabled = false;
      }
    }

    refresh.addEventListener("click", load);
    toDeployments.addEventListener("click", () => onOpenDeployments());
    proof.addEventListener("click", async () => {
      proof.disabled = true;
      try {
        const { candidate } = await call(() => api.ship.create(FIRST_PROOF));
        const result = await call(() => api.ship.checkNow(candidate.id));
        status.textContent = `LITHIUM → ${result.verdict}${result.proposed ? " · proposed a paused debt mission" : ""}`;
        await load();
      } catch (error) {
        onError(error.message);
        proof.disabled = false;
      }
    });
    load();
    timer = setInterval(load, 15000);
    return {
      dispose() {
        disposed = true;
        clearInterval(timer);
      },
      refresh: load,
    };
  }

  window.yurOrganismView = { create, FIRST_PROOF };
})();
