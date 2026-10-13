/* Agent Marketplace inside the Desktop: catalog, Karma forge, forged packs, deploy.
   Everything goes through the IntelliFlow harness engine sidecar (its own product
   root) and lands in the Desktop as a governed deployment (lifecycles). */
"use strict";
(() => {
  const el = (tag, value = "", className = "") => {
    const node = document.createElement(tag);
    if (value !== null) node.textContent = String(value ?? "");
    if (className) node.className = className;
    return node;
  };
  async function call(fn) {
    const response = await fn();
    if (!response?.ok)
      throw new Error(
        response?.error?.message || "The marketplace request failed.",
      );
    return response.result;
  }
  function labeled(label, node, hint = "") {
    const wrap = el("label", null, "yu-field");
    wrap.append(el("span", label, "yu-label"), node);
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

  function harnessStrip(api, host, onReady) {
    const strip = el("div", null, "yu-strip");
    const label = el("span", "IntelliFlow harness: checking…", "yu-pill");
    const start = el("button", "Start harness", "yc-primary");
    start.type = "button";
    const detail = el("small", "", "yu-hint");
    strip.append(label, start, detail);
    host.appendChild(strip);
    let ready = false;
    function show(state) {
      const wasReady = ready;
      ready = state?.state === "ready";
      label.textContent = `IntelliFlow harness: ${state?.state || "unknown"}${state?.port ? ` · 127.0.0.1:${state.port}` : ""}`;
      label.className = `yu-pill ${ready ? "yu-ok" : state?.state === "error" || state?.state === "unavailable" ? "yu-warn" : ""}`;
      start.classList.toggle("yc-hidden", ready || state?.state === "starting");
      detail.textContent = ready
        ? `${state.health?.authority?.orchestration || "OrchestrationManager"} → Validation → ${state.health?.authority?.commit || "CommitService"}`
        : state?.error || "";
      if (ready && !wasReady) onReady?.();
    }
    start.addEventListener("click", async () => {
      start.disabled = true;
      try {
        show(await call(() => api.harness.start()));
      } catch (error) {
        detail.textContent = error.message;
      } finally {
        start.disabled = false;
      }
    });
    const unsubscribe = api.harness.onEvent?.(show);
    call(() => api.harness.status())
      .then(show)
      .catch((error) => {
        detail.textContent = error.message;
      });
    return { dispose: () => unsubscribe?.(), isReady: () => ready };
  }

  function create(
    host,
    {
      api,
      getModels = () => [],
      onOpenDeployments = () => {},
      onError = () => {},
    },
  ) {
    host.appendChild(
      el(
        "p",
        "Create agent packs with Karma, inspect the catalog, and deploy selected pack instructions through this Desktop's governed Work tools. Catalog listings, verified packs and completed agent runs are shown separately. Pack tool declarations become executable only through an admitted Desktop capability.",
        "yu-note",
      ),
    );
    const tabs = el("div", null, "yu-tabs");
    const panel = el("div", null, "yu-tab-panel");
    const status = el("p", "", "yc-form-error");
    status.setAttribute("role", "status");
    let disposed = false,
      active = "packs", generation = 0;
    const strip = harnessStrip(api, host, () => {
      if (!disposed) show(active);
    });
    host.append(tabs, status, panel);
    const views = {
      packs: "My forged packs",
      forge: "Create an agent (Karma forge)",
      catalog: "Catalog",
    };
    for (const [key, label] of Object.entries(views)) {
      const tab = el("button", label);
      tab.type = "button";
      tab.dataset.tab = key;
      tab.addEventListener("click", () => show(key));
      tabs.appendChild(tab);
    }

    function deployForm(pack, container) {
      container.querySelector(".yu-deploy")?.remove();
      const form = el("div", null, "yu-card yu-deploy");
      const name = input("text", pack.agent_type || pack.pack_id, {
        maxLength: 160,
      });
      const goal = input("textarea", "", {
        rows: 3,
        placeholder: "What should this agent do on every run?",
      });
      const models = getModels();
      const model = models.length
        ? select(
            models.map((m) => [m, m]),
            models[0],
          )
        : input("text", "", {
            placeholder: "Available local or cloud model ID",
          });
      const mode = select(
        [
          ["work", "Work"],
          ["code", "Code"],
        ],
        "work",
      );
      const trigger = window.yurLifecycleTriggerEditor
        ? window.yurLifecycleTriggerEditor(api, { kind: "manual" })
        : null;
      const maxRuns = input("number", "100", { min: 1, max: 500 });
      const failures = input("number", "3", { min: 1, max: 20 });
      const submit = el("button", "Deploy into studio", "yc-primary");
      submit.type = "button";
      submit.addEventListener("click", async () => {
        submit.disabled = true;
        status.textContent = "";
        try {
          await call(() =>
            api.marketplace.deploy(pack.pack_id, {
              name: name.value.trim(),
              goal: goal.value,
              model: model.value.trim(),
              mode: mode.value,
              trigger: trigger ? trigger.value() : { kind: "manual" },
              maxRuns: Number(maxRuns.value),
              maxFailuresInRow: Number(failures.value),
            }),
          );
          form.replaceChildren(
            el(
              "p",
              "Deployment saved. Open Deployed agents to run it, inspect its schedule and review actual mission results. Scheduled work runs while the Desktop or its lifecycle runner is active.",
              "yu-ok",
            ),
          );
          const open = el("button", "Open Deployed agents");
          open.type = "button";
          open.addEventListener("click", onOpenDeployments);
          form.appendChild(open);
        } catch (error) {
          status.textContent = error.message;
          onError(error.message);
        } finally {
          submit.disabled = false;
        }
      });
      form.append(
        el("h3", `Deploy ${pack.pack_id}`),
        labeled("Name", name),
        labeled("Goal for each run", goal),
        labeled("Model", model),
        labeled("Mode", mode),
        ...(trigger ? [trigger.root] : []),
        labeled("Run budget", maxRuns),
        labeled("Auto-pause after consecutive failures", failures),
        submit,
      );
      container.appendChild(form);
    }

    function packCard(pack) {
      const card = el("article", null, "yu-card");
      card.append(
        el("h3", pack.agent_type || pack.pack_id),
        el(
          "p",
          `${pack.pack_id} · ${pack.provider_name || pack.provider || ""} · ${pack.agent_count} agents · ${pack.tool_count} declared tools · ${pack.workflow_count} workflows`,
          "yu-hint",
        ),
      );
      card.appendChild(el("p", "Stored pack · integrity is checked when inspected or deployed · tools listed above are declarations", "yu-hint"));
      const actions = el("div", null, "yu-actions");
      const deploy = el("button", "Deploy into studio", "yc-primary");
      deploy.type = "button";
      deploy.addEventListener("click", () => deployForm(pack, card));
      const inspect = el("button", "Inspect");
      inspect.type = "button";
      inspect.addEventListener("click", async () => {
        try {
          const detail = await call(() => api.marketplace.pack(pack.pack_id));
          const files = Object.keys(detail.pack?.files || {}).sort();
          card.querySelector(".yu-files")?.remove();
          const list = el("ul", null, "yu-files");
          for (const file of files.slice(0, 80))
            list.appendChild(el("li", file));
          card.appendChild(list);
        } catch (error) {
          status.textContent = error.message;
        }
      });
      actions.append(deploy, inspect);
      card.appendChild(actions);
      return card;
    }

    async function show(key) {
      const selectedGeneration = ++generation;
      const current = () => !disposed && selectedGeneration === generation && active === key;
      active = key;
      for (const tab of tabs.children)
        tab.setAttribute("aria-pressed", String(tab.dataset.tab === key));
      panel.replaceChildren();
      status.textContent = "";
      if (!strip.isReady()) {
        panel.appendChild(
          el(
            "p",
            'Start the IntelliFlow harness to use the marketplace. If it reports "unavailable", run Setup YUR AI Unified.cmd once.',
            "yc-section-empty",
          ),
        );
        return;
      }
      try {
        if (key === "packs") {
          const result = await call(() => api.marketplace.packs());
          if (!current()) return;
          if (!result.packs?.length)
            panel.appendChild(
              el(
                "p",
                "No forged packs yet. Create an agent with the Karma forge.",
                "yc-section-empty",
              ),
            );
          for (const pack of result.packs || [])
            panel.appendChild(packCard(pack));
        } else if (key === "forge") {
          const form = el("div", null, "yu-card");
          const agentType = input("text", "", {
            placeholder: "What type of agent? e.g. construction estimator",
            maxLength: 200,
          });
          const capabilities = input("textarea", "", {
            rows: 3,
            placeholder: "What should it be able to do? One per line",
          });
          const industry = input("text", "construction", { maxLength: 80 });
          const name = input("text", "", {
            maxLength: 120,
            placeholder: "Optional pack name",
          });
          const description = input("textarea", "", {
            rows: 2,
            maxLength: 2000,
            placeholder: "Optional description",
          });
          const team = input("checkbox");
          team.checked = false;
          const models = getModels();
          const model = models.length
            ? select([["", "Engine default"], ...models.map((m) => [m, m])], "")
            : input("text", "", { placeholder: "Optional Ollama model" });
          const submit = el("button", "Forge agent pack", "yc-primary");
          submit.type = "button";
          const result = el("div");
          submit.addEventListener("click", async () => {
            submit.disabled = true;
            status.textContent = "";
            try {
              const forged = await call(() =>
                api.marketplace.forge({
                  agent_type: agentType.value.trim(),
                  capabilities: capabilities.value
                    .split("\n")
                    .map((v) => v.trim())
                    .filter(Boolean),
                  industry: industry.value.trim() || "general",
                  name: name.value.trim(),
                  description: description.value.trim(),
                  team: team.checked,
                  provider: "ollama",
                  model: model.value.trim(),
                }),
              );
              result.replaceChildren(
                el(
                  "p",
                  `Forged ${forged.pack_id}: ${forged.agent_count} agents, ${forged.tool_count} declared tools, ${forged.workflow_count} workflows.`,
                  "yu-ok",
                ),
              );
              const card = packCard({
                ...forged,
                agent_type: agentType.value.trim(),
              });
              result.appendChild(card);
            } catch (error) {
              status.textContent = error.message;
            } finally {
              submit.disabled = false;
            }
          });
          const teamRow = labeled(
            "Team role templates (coordination remains with the Desktop)",
            team,
          );
          form.append(
            el("h2", "Create an agent"),
            labeled("Agent type", agentType),
            labeled(
              "Capabilities",
              capabilities,
              "Karma turns these into a pack: agents, workflows, birth certificates, bloodline and a ledger entry.",
            ),
            labeled("Industry", industry),
            labeled("Name", name),
            labeled("Description", description),
            teamRow,
            labeled("Model", model),
            submit,
            result,
          );
          panel.appendChild(form);
        } else {
          const result = await call(() => api.marketplace.inventory());
          if (!current()) return;
          const items =
            result.items || result.products || result.inventory || [];
          panel.appendChild(
            el(
              "p",
              "Listings describe available products. Local packs can be inspected and deployed as guidance. A published offer or curated listing does not prove installation, purchase, runtime admission or a successful run.",
              "yu-hint",
            ),
          );
          const grid = el("div", null, "yu-grid");
          const search = input("search", "", { placeholder: "Search catalog by name, provider or status" });
          search.setAttribute("aria-label", "Search marketplace catalog");
          const count = el("p", "", "yu-hint");
          const renderCatalog = () => {
          grid.replaceChildren();
          const query = search.value.trim().toLocaleLowerCase();
          const matches = items.filter(item => [item.name, item.title, item.id, item.description, item.provider, item.status, item.kind].some(value => String(value || "").toLocaleLowerCase().includes(query)));
          count.textContent = `${Math.min(matches.length, 200)} of ${matches.length} matching listings · ${items.length} total${matches.length > 200 ? " · refine search to see remaining listings" : ""}`;
          for (const item of matches.slice(0, 200)) {
            const card = el("article", null, "yu-card");
            card.append(
              el("h3", item.name || item.title || item.id || "Listing"),
              el(
                "p",
                [item.category, item.provider, item.price == null ? null : String(item.price)]
                  .filter(Boolean)
                  .join(" · "),
                "yu-hint",
              ),
            );
            const isPack = ["pack", "provider-pack"].includes(item.kind);
            card.appendChild(el("p", `${item.kind || "listing"} · ${item.status || "status not reported"} · ${isPack ? "inspect to verify local pack" : "catalog reference"}`, "yu-hint"));
            if (item.description)
              card.appendChild(el("p", String(item.description).slice(0, 240)));
            if (isPack) {
              const inspect = el("button", "Inspect pack"); inspect.type = "button";
              inspect.addEventListener("click", async () => {
                inspect.disabled = true;
                try {
                  const detail = await call(() => api.marketplace.pack(item.id));
                  if (!current()) return;
                  const verified = packCard(detail);
                  verified.appendChild(el("p", `Verified source: ${detail.content_sha256 || "source digest not reported"}`, "yu-hint"));
                  card.replaceChildren(verified);
                } catch (error) { if (current()) status.textContent = error.message; }
                finally { inspect.disabled = false; }
              });
              card.appendChild(inspect);
            }
            grid.appendChild(card);
          }
          if (!matches.length)
            grid.appendChild(
              el("p", items.length ? "No listings match this search." : "The catalog is empty.", "yc-section-empty"),
            );
          };
          search.addEventListener("input", renderCatalog);
          panel.append(search, count, grid); renderCatalog();
        }
      } catch (error) {
        if (current()) status.textContent = error.message;
      }
    }
    show("packs");
    return {
      dispose() {
        disposed = true;
        generation += 1;
        strip.dispose();
      },
    };
  }
  window.yurMarketplaceView = { create, harnessStrip };
})();
