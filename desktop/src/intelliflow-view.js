/* IntelliFlow coding harness inside the studio: governed coding tasks with
   OrchestrationManager -> candidates -> ValidationService -> CommitService,
   human approvals, and per-task certificates. The engine is a loopback sidecar. */
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
        response?.error?.message || "The harness request failed.",
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
  const when = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  };

  function create(
    host,
    {
      api,
      getModels = () => [],
      getDefaultRoot = () => "",
      onError = () => {},
    },
  ) {
    host.appendChild(
      el(
        "p",
        "Real coding work, governed end to end. Every task is planned by the OrchestrationManager, proposed as candidates, checked by an independent ValidationService and committed only by the CommitService. Risky steps wait for your approval.",
        "yu-note",
      ),
    );
    let disposed = false,
      poll = null,
      selected = null;
    const strip = window.yurMarketplaceView.harnessStrip(api, host, () => {
      if (!disposed) refresh();
    });
    const status = el("p", "", "yc-form-error");
    status.setAttribute("role", "status");
    const layout = el("div", null, "yu-columns");
    const left = el("div"),
      right = el("div");
    layout.append(left, right);
    host.append(status, layout);

    // The embedded workspace binds to the current governed engine, not to
    // an installed Tauri application's private profile or historical gateway.
    const identity = el('p', 'Runtime: unified IntelliFlow coding control plane. Construction V1 native department orchestration is not connected in this preview.', 'yu-hint');
    host.insertBefore(identity, layout);
    const repository = el('section', null, 'yu-card');
    repository.setAttribute('aria-label', 'Governed project evidence');
    const openRepository = el('button', 'Open project evidence'); openRepository.type = 'button';
    const fileList = el('div', null, 'yu-list');
    const fileLabel = el('p', 'Open a scoped project to inspect its files.', 'yu-hint');
    const content = el('pre', '', 'yu-file-content');
    repository.append(el('h2', 'Project files'), openRepository, fileLabel, fileList, content);
    right.appendChild(repository);
    let repositoryGeneration = 0, fileGeneration = 0;

    // Composer
    const composer = el("div", null, "yu-card");
    const root = input("text", getDefaultRoot() || "", {
      placeholder: "Project folder (absolute path)",
      spellcheck: false,
    });
    const prompt = input("textarea", "", {
      rows: 5,
      maxLength: 100000,
      placeholder: "Describe the coding task: what to build, fix or change.",
    });
    const mode = select(
      [
        ["supervised", "Supervised (approve writes)"],
        ["inspect", "Inspect only (read-only)"],
        ["autonomous", "Autonomous (within policy)"],
      ],
      "supervised",
    );
    const models = getModels();
    const model = models.length
      ? select(
          models.map((m) => [m, m]),
          models[0],
        )
      : input("text", "", { placeholder: "Ollama model, e.g. qwen3.5:9b" });
    const steps = input("number", "12", { min: 1, max: 100 });
    const submit = el("button", "Start governed task", "yc-primary");
    submit.type = "button";
    composer.append(
      el("h2", "New coding task"),
      labeled(
        "Workspace",
        root,
        "Must be inside the harness allowed roots (YUR workspace or Documents by default).",
      ),
      labeled("Task", prompt),
      labeled("Mode", mode),
      labeled("Model", model),
      labeled("Max steps", steps),
      submit,
    );
    const approvalsBox = el("div", null, "yu-card");
    approvalsBox.append(el("h2", "Waiting for your approval"));
    const approvalsList = el("div");
    approvalsBox.appendChild(approvalsList);
    left.append(composer, approvalsBox);
    const tasksBox = el("div", null, "yu-card");
    tasksBox.append(el("h2", "Tasks"));
    const tasksList = el("div", null, "yu-list");
    tasksBox.appendChild(tasksList);
    const detail = el("div", null, "yu-card yc-hidden");
    right.append(tasksBox, detail);

    async function workspaceId(path) {
      const workspaces = await call(() =>
        api.harness.request("GET", "/api/workspaces"),
      );
      const found = (workspaces.workspaces || []).find(
        (item) => String(item.root_path || "").toLowerCase() === path.toLowerCase(),
      );
      if (found) return found.id;
      const opened = await call(() =>
        api.harness.request("POST", "/api/workspaces/open", { path }),
      );
      return opened.id || opened.workspace?.id;
    }
    openRepository.addEventListener('click', async () => {
      const generation = ++repositoryGeneration; ++fileGeneration;
      openRepository.disabled = true; fileList.replaceChildren(); content.textContent = '';
      try {
        const id = await workspaceId(root.value.trim());
        if (!id) throw new Error('The harness did not return a workspace identifier.');
        const graph = await call(() => api.harness.request('GET', `/api/workspaces/${id}/graph`));
        if (disposed || generation !== repositoryGeneration) return;
        const nodes = (graph.nodes || []).filter(node => !node.binary);
        fileLabel.textContent = `${nodes.length} text files indexed${graph.stats?.truncated ? ' (scan limit reached)' : ''}. Showing up to 200. Reads are scoped and secrets are redacted by the engine.`;
        for (const node of nodes.slice(0, 200)) {
          const button = el('button', node.path, 'yu-task'); button.type = 'button';
          button.addEventListener('click', async () => {
            const selectedFile = ++fileGeneration;
            try {
              const file = await call(() => api.harness.request('GET', `/api/workspaces/${id}/file?path=${encodeURIComponent(node.path)}`));
              if (disposed || generation !== repositoryGeneration || selectedFile !== fileGeneration) return;
              content.textContent = file.binary ? 'Binary file; text preview unavailable.' : (file.content || '');
              fileLabel.textContent = `${file.path} · SHA256 ${file.sha256 || 'unavailable'}${file.truncated ? ' · preview truncated' : ''} · ${file.redactions || 0} redactions`;
            } catch (error) { if (!disposed && selectedFile === fileGeneration) status.textContent = error.message; }
          }); fileList.appendChild(button);
        }
      } catch (error) { if (!disposed && generation === repositoryGeneration) status.textContent = error.message; }
      finally { if (!disposed && generation === repositoryGeneration) openRepository.disabled = false; }
    });
    submit.addEventListener("click", async () => {
      submit.disabled = true;
      status.textContent = "";
      try {
        if (!root.value.trim())
          throw new Error("Choose the project folder this task works in.");
        const id = await workspaceId(root.value.trim());
        if (!id)
          throw new Error("The harness did not return a workspace identifier.");
        const task = await call(() =>
          api.harness.request("POST", "/api/tasks", {
            workspace_id: id,
            prompt: prompt.value,
            provider: "ollama",
            model: model.value.trim(),
            mode: mode.value,
            max_steps: Number(steps.value),
          }),
        );
        selected = task.id;
        prompt.value = "";
        await refresh();
      } catch (error) {
        status.textContent = error.message;
        onError(error.message);
      } finally {
        submit.disabled = false;
      }
    });

    async function showTask(id) {
      selected = id;
      const result = await call(() =>
        api.harness.request("GET", `/api/tasks/${id}`),
      );
      const events = await call(() =>
        api.harness.request("GET", `/api/tasks/${id}/events?limit=200`),
      ).catch(() => ({ events: [] }));
      const task = result.task;
      detail.classList.remove("yc-hidden");
      detail.replaceChildren();
      detail.append(
        el("h2", `Task ${task.id}`),
        el(
          "p",
          `${task.status}${task.phase ? ` · ${task.phase}` : ""} · ${task.mode} · ${task.provider}${task.model ? `/${task.model}` : ""}`,
          "yu-hint",
        ),
        el("p", task.prompt?.slice(0, 600) || ""),
      );
      if (task.error) detail.appendChild(el("p", task.error, "yc-form-error"));
      if (result.certificate)
        detail.appendChild(
          el(
            "p",
            `Certificate ${result.certificate.certificate_hash?.slice(0, 16)}… · ${when(result.certificate.created_at)}`,
            "yu-ok",
          ),
        );
      const actions = el("div", null, "yu-actions");
      for (const [label, verb] of [
        ["Pause", "pause"],
        ["Resume", "resume"],
        ["Cancel", "cancel"],
      ]) {
        const button = el("button", label);
        button.type = "button";
        button.addEventListener("click", async () => {
          try {
            await call(() =>
              api.harness.request("POST", `/api/tasks/${id}/${verb}`),
            );
            await refresh();
          } catch (error) {
            status.textContent = error.message;
          }
        });
        actions.appendChild(button);
      }
      detail.appendChild(actions);
      const log = el("ol", null, "yu-history");
      for (const event of (events.events || []).slice(-80))
        log.appendChild(
          el(
            "li",
            `${event.type || event.event_type || "event"} ${event.message || event.summary || ""}`
              .trim()
              .slice(0, 400),
          ),
        );
      detail.appendChild(log);
    }

    async function refresh() {
      if (disposed || !strip.isReady()) return;
      try {
        const [tasks, approvals] = await Promise.all([
          call(() => api.harness.request("GET", "/api/tasks?limit=50")),
          call(() =>
            api.harness.request("GET", "/api/approvals?status=pending"),
          ),
        ]);
        tasksList.replaceChildren();
        if (!tasks.tasks?.length)
          tasksList.appendChild(el("p", "No tasks yet.", "yc-section-empty"));
        for (const task of tasks.tasks || []) {
          const row = el(
            "button",
            `${task.status} · ${task.prompt?.slice(0, 90) || task.id}`,
            `yu-task yu-state-${task.status}`,
          );
          row.type = "button";
          row.addEventListener("click", () =>
            showTask(task.id).catch((error) => {
              status.textContent = error.message;
            }),
          );
          tasksList.appendChild(row);
        }
        approvalsList.replaceChildren();
        if (!approvals.approvals?.length)
          approvalsList.appendChild(el("p", "Nothing is waiting.", "yu-hint"));
        for (const approval of approvals.approvals || []) {
          const card = el("div", null, "yu-approval");
          card.append(
            el("strong", approval.tool || approval.action || "Action"),
            el(
              "pre",
              JSON.stringify(
                approval.arguments ?? approval.request ?? approval,
                null,
                2,
              ).slice(0, 1500),
            ),
          );
          const actions = el("div", null, "yu-actions");
          for (const [label, decision] of [
            ["Approve", "approved"],
            ["Deny", "denied"],
          ]) {
            const button = el(
              "button",
              label,
              decision === "approved" ? "yc-primary" : "",
            );
            button.type = "button";
            button.addEventListener("click", async () => {
              button.disabled = true;
              try {
                await call(() =>
                  api.harness.request("POST", `/api/approvals/${approval.id}`, {
                    decision,
                  }),
                );
                await refresh();
              } catch (error) {
                status.textContent = error.message;
              }
            });
            actions.appendChild(button);
          }
          card.appendChild(actions);
          approvalsList.appendChild(card);
        }
        if (selected) await showTask(selected).catch(() => {});
      } catch (error) {
        status.textContent = error.message;
      }
    }
    poll = setInterval(() => {
      if (!document.hidden) refresh();
    }, 4000);
    return {
      dispose() {
        disposed = true;
        clearInterval(poll);
        strip.dispose();
      },
    };
  }
  window.yurIntelliflowView = { create };
})();
