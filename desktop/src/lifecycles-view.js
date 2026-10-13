/* Deployed agents: lifecycle control surface. The main-process dispatcher (or the
   headless lifecycle runner) executes due runs; this view only edits committed state. */
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
  function labeled(label, input, hint = "") {
    const wrap = el("label", null, "yu-field");
    wrap.append(el("span", label, "yu-label"), input);
    if (hint) wrap.append(el("small", hint, "yu-hint"));
    return wrap;
  }
  function input(type, value = "", attrs = {}) {
    const node = document.createElement(
      type === "textarea" ? "textarea" : "input",
    );
    if (type !== "textarea") node.type = type;
    node.value = value;
    Object.assign(node, attrs);
    return node;
  }
  function select(options, value) {
    const node = document.createElement("select");
    for (const [v, label] of options) {
      const o = el("option", label);
      o.value = v;
      node.appendChild(o);
    }
    node.value = value;
    return node;
  }

  function triggerSummary(trigger) {
    switch (trigger?.kind) {
      case "manual":
        return "On request";
      case "once":
        return `Once at ${when(trigger.at)}`;
      case "interval":
        return `Every ${Math.round(trigger.seconds / 60)} min`;
      case "continuous":
        return `Continuous · rests ${trigger.cooldown_seconds}s between runs`;
      case "cron":
        return `Cron ${trigger.expression} (${trigger.timezone})`;
      default:
        return "Unknown trigger";
    }
  }

  // Shared trigger editor (also used by the marketplace deploy form).
  function triggerEditor(
    api,
    initial = { kind: "cron", expression: "0 8 * * 1-5", timezone: "UTC" },
  ) {
    const root = el("div", null, "yu-trigger");
    const kind = select(
      [
        ["cron", "Cron schedule"],
        ["interval", "Every N minutes"],
        ["continuous", "Long-running (continuous)"],
        ["once", "Once"],
        ["manual", "Only when I run it"],
      ],
      initial.kind,
    );
    const expression = input("text", initial.expression || "0 8 * * 1-5", {
      spellcheck: false,
    });
    const zone = input("text", initial.timezone || "UTC", {
      spellcheck: false,
    });
    const minutes = input(
      "number",
      String(Math.round((initial.seconds || 3600) / 60)),
      { min: 1, max: 1440 },
    );
    const cooldown = input("number", String(initial.cooldown_seconds || 300), {
      min: 30,
      max: 86400,
    });
    const at = input("datetime-local", "");
    const preview = el("p", "", "yu-hint");
    preview.setAttribute("role", "status");
    const rows = {
      cron: [
        labeled(
          "Cron (minute hour day month weekday)",
          expression,
          "Examples: */15 * * * *  ·  0 2 * * *  ·  30 8 * * mon-fri",
        ),
        labeled(
          "Timezone",
          zone,
          "UTC, a fixed offset like -05:00, or an IANA name",
        ),
      ],
      interval: [labeled("Minutes between runs", minutes)],
      continuous: [
        labeled(
          "Rest between runs (seconds)",
          cooldown,
          "Restarts after each run; auto-pauses after repeated failures",
        ),
      ],
      once: [labeled("Run at", at)],
      manual: [],
    };
    const body = el("div", null, "yu-trigger-body");
    root.append(labeled("When should it run?", kind), body, preview);
    function value() {
      switch (kind.value) {
        case "cron":
          return {
            kind: "cron",
            expression: expression.value.trim(),
            timezone: zone.value.trim() || "UTC",
          };
        case "interval":
          return {
            kind: "interval",
            seconds: Math.max(60, Math.round(Number(minutes.value) * 60)),
          };
        case "continuous":
          return {
            kind: "continuous",
            cooldown_seconds: Math.max(30, Math.round(Number(cooldown.value))),
          };
        case "once": {
          const date = at.value ? new Date(at.value) : new Date();
          return { kind: "once", at: date.toISOString() };
        }
        default:
          return { kind: "manual" };
      }
    }
    let ticket = 0;
    async function refresh() {
      body.replaceChildren(...rows[kind.value]);
      const mine = ++ticket;
      if (kind.value === "manual") {
        preview.textContent = "Runs only when you press Run now.";
        return;
      }
      try {
        const result = await call(() => api.lifecycles.preview(value()));
        if (mine === ticket)
          preview.textContent = `Next: ${result.times.map(when).join("  ·  ")}`;
      } catch (error) {
        if (mine === ticket) preview.textContent = error.message;
      }
    }
    for (const node of [kind, expression, zone, minutes, cooldown, at])
      node.addEventListener("change", refresh);
    refresh();
    return { root, value };
  }

  function create(
    host,
    { api, getModels = () => [], onOpenMission = () => {}, onError = () => {} },
  ) {
    const intro = el(
      "p",
      "Deployed agents run on their own schedule: cron, intervals, a single run, or continuously as long-running lifecycles. They run while YUR Desktop is open, or around the clock when the background runner is installed. Repeated failures auto-pause an agent instead of looping.",
      "yu-note",
    );
    const strip = el("div", null, "yu-strip");
    const toolbar = el("div", null, "yu-toolbar");
    const deployGoal = el("button", "Deploy an agent", "yc-primary");
    deployGoal.type = "button";
    const refreshButton = el("button", "Refresh");
    refreshButton.type = "button";
    toolbar.append(deployGoal, refreshButton);
    const form = el("div", null, "yu-card yc-hidden");
    const status = el("p", "", "yc-form-error");
    status.setAttribute("role", "status");
    const list = el("div", null, "yu-list");
    host.append(intro, strip, toolbar, form, status, list);
    let disposed = false, stripGeneration = 0,
      specialists = [];
    const unsubscribe = api.lifecycles.onEvent?.((state) => {
      renderStrip(state);
      if (["idle", "reconciling", "error"].includes(state.phase)) load();
    });

    async function renderStrip(state) {
      const generation = ++stripGeneration;
      const dispatch =
        state || (await call(() => api.lifecycles.status()).catch(() => null));
      const runner = await call(() => api.lifecycles.runner()).catch(
        () => null,
      );
      if (disposed || generation !== stripGeneration) return;
      strip.replaceChildren();
      const phase = runner?.runner?.running
        ? "Background runner active — agents keep running when Desktop closes"
        : `In-app dispatcher: ${dispatch?.phase || "unknown"}`;
      strip.append(el("span", phase, "yu-pill"));
      if (dispatch?.error?.message)
        strip.append(el("span", dispatch.error.message, "yu-pill yu-warn"));
    }

    async function openForm() {
      form.classList.remove("yc-hidden");
      form.replaceChildren();
      try {
        specialists =
          (await call(() => api.specialists.list(20, null))).entries || [];
      } catch {
        specialists = [];
      }
      const kind = select(
        [
          ["work_goal", "Work goal agent"],
          ...(specialists.length
            ? [["saved_specialist", "One of my built specialists"]]
            : []),
        ],
        "work_goal",
      );
      const specialist = select(
        specialists.map((item) => [
          item.mission_id,
          `${item.name} (${item.capabilities.join(", ")})`,
        ]),
        specialists[0]?.mission_id || "",
      );
      const name = input("text", "", {
        maxLength: 160,
        placeholder: "e.g. Morning bid digest",
      });
      const goal = input("textarea", "", {
        rows: 4,
        maxLength: 24000,
        placeholder: "What should this agent do on every run?",
      });
      const instructions = input("textarea", "", {
        rows: 3,
        maxLength: 20000,
        placeholder:
          "Optional standing instructions (role, constraints, output format)",
      });
      const models = getModels();
      const model = models.length
        ? select(
            models.map((m) => [m, m]),
            models[0],
          )
        : input("text", "", {
            placeholder: "Installed Ollama model, e.g. qwen3.5:9b",
          });
      const mode = select(
        [
          ["work", "Work"],
          ["code", "Code"],
        ],
        "work",
      );
      const maxRuns = input("number", "100", { min: 1, max: 500 });
      const failures = input("number", "3", { min: 1, max: 20 });
      const trigger = triggerEditor(api);
      const specialistRow = labeled("Specialist", specialist);
      const toggle = () =>
        specialistRow.classList.toggle(
          "yc-hidden",
          kind.value !== "saved_specialist",
        );
      kind.addEventListener("change", toggle);
      toggle();
      const submit = el("button", "Deploy", "yc-primary");
      submit.type = "button";
      const cancel = el("button", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => form.classList.add("yc-hidden"));
      submit.addEventListener("click", async () => {
        submit.disabled = true;
        status.textContent = "";
        try {
          let spec = {
            name: name.value.trim(),
            kind: kind.value,
            goal: goal.value,
            instructions: instructions.value,
            model: model.value.trim(),
            mode: mode.value,
            trigger: trigger.value(),
            max_runs: Number(maxRuns.value),
            max_failures_in_row: Number(failures.value),
          };
          if (kind.value === "saved_specialist") {
            const chosen = specialists.find(
              (item) => item.mission_id === specialist.value,
            );
            if (!chosen)
              throw new Error("Choose one of your built specialists.");
            spec = {
              ...spec,
              source: {
                mission_id: chosen.source_parent_work_id,
                specialist_id: chosen.mission_id,
              },
              instructions:
                `${spec.instructions}\nUse the saved specialist "${chosen.name}" (id ${chosen.mission_id}) through the run_saved_specialist tool for its admitted capabilities: ${chosen.capabilities.join(", ")}.`.trim(),
            };
          }
          await call(() => api.lifecycles.deploy(spec));
          form.classList.add("yc-hidden");
          await load();
        } catch (error) {
          status.textContent = error.message;
        } finally {
          submit.disabled = false;
        }
      });
      const actions = el("div", null, "yu-actions");
      actions.append(submit, cancel);
      form.append(
        el("h2", "Deploy an agent"),
        labeled("Agent type", kind),
        specialistRow,
        labeled("Name", name),
        labeled("Goal for each run", goal),
        labeled("Standing instructions", instructions),
        labeled("Model", model),
        labeled("Mode", mode),
        trigger.root,
        labeled(
          "Run budget",
          maxRuns,
          "Renew the deployment to continue past its budget",
        ),
        labeled("Auto-pause after consecutive failures", failures),
        actions,
      );
    }

    function render(deployment) {
      const card = el(
        "article",
        null,
        `yu-card yu-deployment yu-state-${deployment.state}`,
      );
      const head = el("div", null, "yu-row");
      head.append(
        el("h3", deployment.name),
        el("span", deployment.state, `yu-pill yu-state-${deployment.state}`),
        el("span", deployment.kind.replace("_", " "), "yu-pill"),
      );
      const meta = el(
        "p",
        `${triggerSummary(deployment.trigger)} · next ${deployment.state === "active" ? when(deployment.next_run_at) : "—"} · runs ${deployment.runs_completed}/${deployment.max_runs}` +
          (deployment.active_request_id ? " · running now" : "") +
          (deployment.last_status ? ` · last ${deployment.last_status}` : ""),
        "yu-hint",
      );
      card.append(
        head,
        meta,
        el("p", deployment.goal.slice(0, 300), "yu-goal"),
      );
      if (deployment.source?.pack_id)
        card.append(
          el(
            "p",
            `Marketplace pack ${deployment.source.pack_id}${deployment.source.agent_type ? ` · ${deployment.source.agent_type}` : ""}`,
            "yu-hint",
          ),
        );
      if (deployment.last_error)
        card.append(el("p", deployment.last_error, "yc-form-error"));
      const actions = el("div", null, "yu-actions");
      const button = (label, fn, primary = false) => {
        const node = el("button", label, primary ? "yc-primary" : "");
        node.type = "button";
        node.addEventListener("click", async () => {
          node.disabled = true;
          status.textContent = "";
          try {
            await fn();
            await load();
          } catch (error) {
            status.textContent = error.message;
            onError(error.message);
          } finally {
            node.disabled = false;
          }
        });
        actions.appendChild(node);
      };
      if (deployment.state === "active" && !deployment.active_request_id)
        button(
          "Run now",
          () =>
            call(() =>
              api.lifecycles.runNow(deployment.id, deployment.revision),
            ),
          true,
        );
      if (deployment.state === "active")
        button("Pause", () =>
          call(() =>
            api.lifecycles.setState(
              deployment.id,
              deployment.revision,
              "paused",
            ),
          ),
        );
      if (["paused", "finished"].includes(deployment.state))
        button(
          "Resume",
          () =>
            call(() =>
              api.lifecycles.setState(
                deployment.id,
                deployment.revision,
                "active",
              ),
            ),
          true,
        );
      if (deployment.state !== "retired" && !deployment.active_request_id)
        button("Retire", () =>
          call(() =>
            api.lifecycles.setState(
              deployment.id,
              deployment.revision,
              "retired",
            ),
          ),
        );
      if (deployment.last_mission_id)
        button("Open last run", async () =>
          onOpenMission(deployment.last_mission_id),
        );
      button("History", async () => {
        const result = await call(() =>
          api.lifecycles.events(deployment.id, null),
        );
        const history = el("ol", null, "yu-history");
        for (const event of result.events)
          history.appendChild(
            el(
              "li",
              `${when(event.created_at)} · ${event.event_type.replace("deployment.", "")}${event.change?.mission_status ? ` (${event.change.mission_status})` : ""}`,
            ),
          );
        card.querySelector(".yu-history")?.remove();
        card.appendChild(history);
      });
      card.appendChild(actions);
      return card;
    }

    async function load() {
      if (disposed) return;
      refreshButton.disabled = true;
      try {
        const result = await call(() => api.lifecycles.list());
        list.replaceChildren();
        const visible = result.deployments.slice().reverse();
        if (!visible.length)
          list.appendChild(
            el(
              "p",
              "No deployed agents yet. Deploy a Work-goal agent here, or deploy a pack from the Agent Marketplace.",
              "yc-section-empty",
            ),
          );
        for (const deployment of visible) list.appendChild(render(deployment));
        status.textContent = "";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        refreshButton.disabled = false;
      }
    }
    deployGoal.addEventListener("click", openForm);
    refreshButton.addEventListener("click", () => {
      load();
      renderStrip();
    });
    renderStrip();
    load();
    return {
      dispose() {
        disposed = true;
        unsubscribe?.();
      },
      refresh: load,
    };
  }

  window.yurLifecycleTriggerEditor = triggerEditor;
  window.yurLifecyclesView = { create, triggerSummary };
})();
