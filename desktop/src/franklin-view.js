/* Franklin's persistent Desktop surface, adapted from Nova's fixed copilot
 * shell and exact-request recovery flow. Persistence, context compilation,
 * models, approvals, actions and receipts belong to the existing host runtime.
 * Donor provenance: docs/FRANKLIN-DESKTOP-VIEW-PROVENANCE.md. */
(function(root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.yurFranklinView = exported;
})(typeof window === "undefined" ? null : window, function() {
  "use strict";
  const mounted = new WeakMap();
  const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = (value, maximum = 24000) => typeof value === "string" ? value.replace(/\0/g, "").slice(0, maximum) : "";
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const queuePhases = new Set(['submit_intent', 'accepted', 'status', 'terminal', 'validated', 'acceptance_invalid', 'submit_uncertain', 'cancel_confirmed', 'cancel_unconfirmed']);
  const remoteStates = new Set(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN']);
  const terminalStates = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
  function queueRecord(value) {
    if (!value || !UUID.test(value.request_id)) return null;
    const remote_state = remoteStates.has(value.remote_state) ? value.remote_state : 'UNKNOWN';
    return { request_id: value.request_id, call_id: /^[a-f0-9]{32}$/.test(value.call_id) ? value.call_id : '',
      phase: queuePhases.has(value.phase) ? value.phase : 'submit_uncertain', remote_state, durable: value.durable === true,
      local_cancelled: value.local_cancelled === true, cancel_confirmed: value.cancel_confirmed === true && remote_state === 'CANCELLED' && value.outcome_known !== false,
      outcome_known: typeof value.outcome_known === 'boolean' ? value.outcome_known : terminalStates.has(remote_state) && ['terminal', 'validated', 'cancel_confirmed', 'cancel_unconfirmed'].includes(value.phase) };
  }
  const unwrap = value => { if (value?.ok === false) { const error = new Error(value.error?.message || "Franklin request failed."); error.code = value.error?.code; throw error; } return value?.ok === true && value.result !== undefined ? value.result : value; };
  function normalizeSnapshot(input) {
    const source = object(unwrap(input)), preferences = object(source.preferences), seen = new Set();
    const models = (Array.isArray(source.models) ? source.models : []).flatMap(item => {
      const id = typeof item === "string" ? item : item?.id || item?.name;
      if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id) || seen.has(id)) return [];
      seen.add(id); return [{ id, label: text(item?.label, 300) || id }];
    });
    return { ...source, preferences: { model: text(preferences.model, 256), open: preferences.open === true, draft: text(preferences.draft) }, models,
      messages: (Array.isArray(source.messages) ? source.messages : []).slice(-200).map(item => ({ ...object(item), role: text(item.role, 32) || "assistant", content: text(item.content ?? item.text) })),
      events: (Array.isArray(source.events) ? source.events : []).slice(-100), context: object(source.context), permissions: object(source.permissions), status: object(source.status), observation: object(source.observation),
      queue_calls: (Array.isArray(source.queue_calls) ? source.queue_calls : []).slice(-50).map(queueRecord).filter(Boolean),
      active_request: source.active_request && typeof source.active_request.request_id === "string" ? { ...source.active_request, request_id: text(source.active_request.request_id, 128) } : null };
  }
  // intro (an edition's main page only): { agentLine, greeting, placeholder, starts: [{ id, title, line,
  // page, select() }] }. It changes his page copy and layout (a header with Activity, the greeting and
  // start cards while the conversation is empty); requests, models, approvals and receipts are unchanged.
  function create(host, { api, voice = null, requestId = () => crypto.randomUUID(), debounceMs = 600, now = () => Date.now(), layout = "drawer", intro = null } = {}) {
    if (mounted.has(host)) return mounted.get(host);
    if (!api || ["snapshot", "configure", "send", "cancel"].some(name => typeof api[name] !== "function")) throw new Error("Franklin requires the Desktop's snapshot, configuration and request bindings.");
    const doc = host.ownerDocument || document;
    // An edition's main page keeps Franklin open in the page flow; the Desktop drawer is unchanged.
    const pinned = layout === "main";
    const el = (tag, content = "", className = "") => { const node = doc.createElement(tag); node.textContent = content; node.className = className; return node; };
    const shell = el("section", "", "yur-franklin"); shell.id = "yur-franklin"; shell.setAttribute("aria-label", "Franklin personal assistant");
    const toggle = el("button", "", "yur-franklin-toggle"); toggle.type = "button"; toggle.id = "franklin-toggle"; toggle.setAttribute("aria-controls", "franklin-panel");
    const dot = el("span", "", "yur-franklin-dot"), toggleLabel = el("span", "Franklin"), toggleState = el("small", "Connecting"); toggle.append(dot, toggleLabel, toggleState);
    const panel = el("section", "", "yur-franklin-panel"); panel.id = "franklin-panel";
    const header = el("header"), title = el("div"), heading = el("h2", "Franklin"), subtitle = el("p", "Separate runtime · Desktop overwatch"); title.append(heading, subtitle);
    const refresh = el("button", "Refresh"), close = el("button", "Collapse"); refresh.type = close.type = "button"; refresh.id = "franklin-refresh"; close.id = "franklin-close"; header.append(title, refresh, close);
    const status = el("p", "Loading the saved assistant state…", "yur-franklin-status"); status.id = "franklin-status"; status.setAttribute("role", "status");
    const errorBox = el("p", "", "yur-franklin-error"); errorBox.id = "franklin-error"; errorBox.setAttribute("role", "status");
    const observation = el("p", "", "yur-franklin-observation"); observation.id = "franklin-observation"; observation.setAttribute("role", "status");
    const queueInfo = el('p', '', 'yur-franklin-status'); queueInfo.id = 'franklin-cloud-status'; queueInfo.setAttribute('role', 'status'); queueInfo.hidden = true;
    const queueControls = el('div', '', 'yur-franklin-actions'), queueSelect = el('select'), queueCheck = el('button', 'Check cloud job'), queueStop = el('button', 'Stop cloud job');
    queueSelect.id = 'franklin-cloud-job'; queueSelect.setAttribute('aria-label', 'Retained cloud job');
    queueCheck.id = 'franklin-cloud-check'; queueStop.id = 'franklin-cloud-stop'; queueCheck.type = queueStop.type = 'button';
    queueCheck.hidden = queueStop.hidden = queueSelect.hidden = queueControls.hidden = true; queueControls.append(queueSelect, queueCheck, queueStop);
    const modelLabel = el("label", "Model", "yur-franklin-model"), model = el("select"); model.id = "franklin-model"; modelLabel.setAttribute("for", model.id); model.setAttribute("aria-label", "Franklin model"); modelLabel.append(model);
    const log = el("div", "", "yur-franklin-log"); log.id = "franklin-log"; log.setAttribute("role", "log"); log.setAttribute("aria-live", "polite"); log.setAttribute("aria-label", "Saved Franklin conversation");
    const context = el("details", "", "yur-franklin-context"), contextSummary = el("summary", "Desktop context and permissions"), contextBody = el("div"); context.id = "franklin-context"; context.append(contextSummary, contextBody);
    const timeline = el("details", "", "yur-franklin-timeline"), timelineSummary = el("summary", "Actions and receipts"), timelineBody = el("div"); timeline.id = "franklin-timeline"; timeline.append(timelineSummary, timelineBody);
    const form = el("form", "", "yur-franklin-form"), label = el("label", "Talk to Franklin"), input = el("textarea"), buttons = el("div", "", "yur-franklin-actions"), send = el("button", "Send"), stop = el("button", "Stop"), retry = el("button", "Reconcile request");
    input.id = "franklin-input"; input.rows = 3; input.maxLength = 24000; input.placeholder = "Tell Franklin what you want to do across your Desktop…"; label.setAttribute("for", input.id); send.type = "submit"; stop.type = retry.type = "button"; send.id = "franklin-send"; stop.id = "franklin-stop"; retry.id = "franklin-retry"; buttons.append(send, stop, retry);
    const voiceControls = el("div", "", "yur-franklin-voice"), dictate = el("button", "Dictate locally"), voiceStop = el("button", "Stop and transcribe"), voiceCancel = el("button", "Cancel dictation"), voiceStatus = el("p", "Local dictation unavailable.");
    dictate.id = "franklin-dictate"; voiceStop.id = "franklin-dictate-stop"; voiceCancel.id = "franklin-dictate-cancel"; voiceStatus.id = "franklin-voice-status"; voiceStatus.setAttribute("role", "status");
    dictate.type = voiceStop.type = voiceCancel.type = "button"; voiceControls.append(dictate, voiceStop, voiceCancel, voiceStatus);
    const voiceReview = el("div", "", "yur-franklin-voice-review"), transcriptLabel = el("label", "Review local transcript"), transcriptInput = el("textarea"), insertTranscript = el("button", "Insert into draft"), discardTranscript = el("button", "Discard transcript");
    transcriptInput.id = "franklin-transcript"; transcriptInput.maxLength = 24000; transcriptLabel.setAttribute("for", transcriptInput.id); insertTranscript.id = "franklin-transcript-insert"; discardTranscript.id = "franklin-transcript-discard"; insertTranscript.type = discardTranscript.type = "button";
    voiceReview.append(transcriptLabel, transcriptInput, insertTranscript, discardTranscript); form.append(label, input, voiceControls, voiceReview, buttons);
    const persistence = el("small", "", "yur-franklin-persistence"); persistence.id = "franklin-persistence";
    panel.append(header, status, errorBox, observation, queueInfo, queueControls, modelLabel, log, context, timeline, form, persistence); shell.append(panel, toggle); host.append(shell);
    if (pinned) { shell.dataset.layout = "main"; toggle.hidden = close.hidden = true; }
    // The edition's page: Activity holds his status line, model, context, receipts and storage note
    // (shown on demand; a problem, an unusable model or a pending request always shows).
    const edition = pinned && intro && typeof intro === "object" ? intro : null;
    const activity = el("button", "Activity"); activity.type = "button"; activity.id = "franklin-activity"; activity.setAttribute("aria-expanded", "false"); activity.hidden = !edition;
    let activityOpen = false, welcomeNode = null;
    function setActivity(value) { activityOpen = Boolean(value); shell.dataset.activity = activityOpen ? "open" : "closed"; activity.setAttribute("aria-expanded", String(activityOpen)); }
    // The edition's page names no Desktop: the same status lines in the athlete's words. The Desktop's own text is unchanged.
    const EDITION_COPY = [[/^Available across the Desktop\./, "Franklin is ready."], [/You can continue in other Desktop windows\./, "You can keep using the app."],
      [/stored by the Desktop Commit Service\./, "stored on this computer by the Commit Service."], [/^Watching Desktop activity/, "Watching activity"]];
    const say = value => edition ? EDITION_COPY.reduce((line, [pattern, words]) => line.replace(pattern, words), value) : value;
    if (edition) {
      refresh.before(activity); shell.dataset.intro = "edition"; setActivity(false);
      subtitle.textContent = text(edition.agentLine, 120) || subtitle.textContent;
      input.placeholder = text(edition.placeholder, 200) || input.placeholder;
      activity.addEventListener("click", () => setActivity(!activityOpen));
      contextSummary.textContent = "Context and permissions";
    }
    function welcome() {
      if (welcomeNode) return welcomeNode;
      const box = el("section", "", "yur-franklin-welcome"); box.setAttribute("aria-label", "Start with Franklin");
      const greeting = el("div", "", "yur-franklin-greeting"), figure = el("span", "", "yur-franklin-figure"), copy = el("div");
      figure.setAttribute("aria-hidden", "true");
      copy.append(el("strong", "FRANKLIN", "yur-franklin-wordmark"), el("p", text(edition.greeting, 600)));
      greeting.append(figure, copy); box.append(greeting);
      const starts = (Array.isArray(edition.starts) ? edition.starts : []).slice(0, 4);
      if (starts.length) {
        const grid = el("div", "", "yur-franklin-starts");
        for (const start of starts) {
          const card = el("button", "", "yur-franklin-start"); card.type = "button"; card.dataset.start = text(start.id, 40);
          card.append(el("strong", text(start.title, 60)), el("span", text(start.line, 160)), el("small", start.page ? "Opens " + text(start.page, 60) : ""));
          card.addEventListener("click", () => { try { start.select?.(); } catch { /* The start only opens a page and drafts a request. */ } });
          grid.append(card);
        }
        box.append(grid);
      }
      return (welcomeNode = box);
    }
    // The launcher's model (snapshot.default_model, edition only) stands until one is saved.
    const defaultModel = () => { const id = typeof snapshot.default_model === "string" ? snapshot.default_model : ""; return id && snapshot.models.some(item => item.id === id) ? id : ""; };
    let snapshot = normalizeSnapshot({}), ready = false, disposed = false, expanded = pinned, draft = "", dirtyDraft = false, draftVersion = 0, openVersion = 0;
    let pending = null, sending = false, cancelling = false, streaming = "", eventItems = [], draftTimer = null, configChain = Promise.resolve(), configBusy = 0, loadGeneration = 0, errorText = "";
    let dictation = null, dictationState = { ready: false, phase: "idle" }, transcriptPending = false, voiceError = "";
    const queueItems = new Map(), localStops = new Set(); let queueSelection = '', queueBusy = false, progressTimer = null;
    const isActive = () => Boolean(sending || snapshot.active_request);
    const queueKey = item => item.request_id + ':' + item.call_id;
    const currentRequest = () => snapshot.active_request?.request_id || pending?.request_id;
    const unresolvedQueue = item => !item.cancel_confirmed && (!item.outcome_known || !terminalStates.has(item.remote_state));
    const attentionQueues = () => [...queueItems.values()].filter(item => unresolvedQueue(item) && (item.local_cancelled || !isActive() || item.request_id !== currentRequest() || ['submit_uncertain', 'acceptance_invalid', 'cancel_unconfirmed'].includes(item.phase)));
    function rememberQueue(value, live = false) {
      const item = queueRecord(value); if (!item) return;
      const key = queueKey(item), previous = queueItems.get(key);
      if (!live && previous?.liveOutcome) { if (item.local_cancelled) previous.local_cancelled = true; return; }
      const stopped = item.local_cancelled || localStops.has(item.request_id) || previous?.local_cancelled;
      queueItems.set(key, { ...item, local_cancelled: Boolean(stopped), startedAt: previous?.startedAt ?? now(),
        liveOutcome: live && (item.outcome_known || ['submit_uncertain', 'acceptance_invalid', 'cancel_unconfirmed'].includes(item.phase)) });
      while (queueItems.size > 50) queueItems.delete(queueItems.keys().next().value);
    }
    function cloudMessage(item) {
      if (item.cancel_confirmed) return 'Cloud cancellation confirmed by the provider.';
      if (item.local_cancelled && item.remote_state === 'COMPLETED' && item.outcome_known) return 'Cloud job completed remotely after Stop. Its result was discarded locally.';
      if (item.local_cancelled && terminalStates.has(item.remote_state) && item.outcome_known) return `Cloud job reports ${item.remote_state} after Stop. Cancellation was not confirmed.`;
      if (item.local_cancelled || item.phase === 'cancel_unconfirmed') return `Stop recorded locally; remote cancellation is unconfirmed. Last reported cloud state: ${item.remote_state}.`;
      if (['submit_uncertain', 'acceptance_invalid'].includes(item.phase)) return 'Cloud submission outcome is unconfirmed. Check its retained receipt; no job is resubmitted automatically.';
      if (item.phase === 'validated') return 'Cloud result validated; continuing this request.';
      if (item.remote_state === 'COMPLETED' && isActive()) return 'Validating the cloud result.';
      if (terminalStates.has(item.remote_state)) return `Cloud job reports ${item.remote_state}.`;
      if (item.remote_state === 'IN_PROGRESS') return 'Cloud work is running.';
      return 'Starting cloud work; waiting for a worker.';
    }
    function renderQueue() {
      const attention = attentionQueues(), live = [...queueItems.values()].findLast(item => item.request_id === currentRequest());
      const selected = attention.find(item => queueKey(item) === queueSelection) || attention.findLast(item => item.call_id) || attention.at(-1) || live || [...queueItems.values()].at(-1);
      queueSelection = selected ? queueKey(selected) : '';
      queueInfo.hidden = !selected;
      if (selected) {
        queueInfo.textContent = cloudMessage(selected);
        if (isActive() && selected.request_id === currentRequest() && !selected.local_cancelled) {
          const seconds = Math.max(0, Math.floor((now() - selected.startedAt) / 1000));
          queueInfo.textContent += ` Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s.`;
        }
        if (unresolvedQueue(selected) && !selected.call_id) queueInfo.textContent += ' No retained call identity is available for protected recovery. No job was resubmitted.';
      }
      const recoverable = attention.filter(item => item.call_id), canRecover = !isActive() && recoverable.length > 0 && typeof api.queueReconcile === 'function';
      queueControls.hidden = !canRecover; queueCheck.hidden = !canRecover || !selected?.call_id; queueStop.hidden = queueCheck.hidden;
      queueCheck.disabled = queueStop.disabled = queueBusy || cancelling;
      queueSelect.replaceChildren(); for (const item of recoverable) { const option = el('option', `Request ${item.request_id.slice(0, 8)} · ${item.remote_state}`); option.value = queueKey(item); queueSelect.append(option); }
      queueSelect.value = queueSelection; queueSelect.hidden = !canRecover || recoverable.length < 2; queueSelect.disabled = queueBusy;
      const ticking = isActive() && Boolean(live) && !live.local_cancelled;
      if (ticking && !progressTimer) { progressTimer = setInterval(() => { if (!disposed) renderStatus(); }, 1000); progressTimer.unref?.(); }
      else if (!ticking && progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      return attention.length > 0;
    }
    function fail(error) { errorText = text(error?.message || String(error), 2000); renderStatus(); }
    function renderStatus() {
      const queueAttention = renderQueue(), active = isActive(), phase = active ? "working" : pending || queueAttention ? "unconfirmed" : ready ? (snapshot.status.phase || "ready") : errorText ? "error" : "connecting";
      const phaseLabels = { ready: "Ready", idle: "Ready", connecting: "Connecting", paused: "Paused", disabled: "Off", watching: "Watching", waiting_approval: "Needs approval", error: "Needs attention", unavailable: "Unavailable", disconnected: "Disconnected", offline: "Offline" };
      shell.dataset.phase = phase; shell.dataset.expanded = String(expanded); shell.dataset.runtime = "separate-overwatch";
      toggleState.textContent = active ? "Working" : pending || queueAttention ? "Needs attention" : phaseLabels[phase] || text(phase, 60);
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event("yur:franklin-layout"));
      panel.hidden = !expanded; toggle.setAttribute("aria-expanded", String(expanded));
      status.textContent = say(cancelling ? "Stop requested; waiting for the runtime outcome…" : active ? snapshot.status.message || "Franklin is working. You can continue in other Desktop windows." : queueAttention ? 'The retained cloud job needs attention. Check its exact receipt before starting another request.' : pending ? "This request's outcome is unconfirmed. Reconcile its original request before sending another." : snapshot.status.message || (ready ? "Available across the Desktop. Saved context is supplied by the runtime." : errorText ? "Franklin could not load its saved state. Review the connection error and choose Refresh to try again." : "Loading the saved assistant state…"));
      errorBox.textContent = errorText; errorBox.hidden = !errorText;
      const modelExists = snapshot.models.some(item => item.id === model.value);
      if (edition) shell.dataset.modelReady = String(modelExists);
      send.disabled = !ready || active || Boolean(pending) || queueAttention || queueBusy || Boolean(configBusy) || dictationState.phase !== "idle" || transcriptPending || !modelExists || !draft.trim();
      stop.disabled = !pending && !snapshot.active_request; stop.hidden = !pending && !snapshot.active_request; stop.disabled ||= cancelling;
      retry.hidden = !pending || active || queueAttention; retry.disabled = active || cancelling || queueAttention;
      model.disabled = !ready || active || Boolean(pending) || queueAttention || queueBusy || Boolean(configBusy);
      input.disabled = !ready; refresh.disabled = !ready && loadGeneration > 0;
      persistence.textContent = dirtyDraft ? "Draft waiting to be saved" : ready ? say("Conversation and preferences are stored by the Desktop Commit Service.") : "";
      const watched = snapshot.observation, count = key => Number.isSafeInteger(watched[key]) && watched[key] >= 0 ? watched[key] : 0;
      observation.textContent = say(`Watching Desktop activity while this app is open · ${count('active')} active · ${count('awaiting_review')} awaiting review · ${count('failed')} recent failed or unconfirmed.`);
      if (watched.latest) observation.textContent += ` Latest: ${text(watched.latest.label, 160)} — ${text(watched.latest.phase, 160)}.`;
      observation.dataset.sequence = String(count('sequence'));
      observation.dataset.missionId = text(watched.latest?.mission_id, 128);
      observation.hidden = !ready;
      if (edition) shell.dataset.awaiting = String(count('awaiting_review'));
      voiceControls.hidden = !dictation;
      dictate.disabled = !dictationState.ready || dictationState.phase !== "idle" || transcriptPending;
      voiceStop.hidden = dictationState.phase !== "recording";
      voiceCancel.hidden = dictationState.phase === "idle";
      voiceReview.hidden = !transcriptPending;
      voiceStatus.textContent = voiceError || (dictationState.phase === "recording" ? `Listening locally · ${Math.floor(dictationState.seconds || 0)} / ${dictationState.max_seconds || 60} seconds` : dictationState.phase === "transcribing" ? "Transcribing locally. Microphone released." : dictationState.phase !== "idle" ? "Starting or cancelling microphone…" : transcriptPending ? "Review the transcript before inserting or discarding it. Nothing has been sent." : dictationState.ready ? "Offline recognizer available. Desktop voice settings are checked before recording." : "Local dictation unavailable.");
    }
    function renderLog() {
      const previousScroll = log.scrollTop || 0, follow = (log.scrollHeight || 0) - previousScroll - (log.clientHeight || 0) < 32;
      log.replaceChildren();
      if (!snapshot.messages.length && !pending) log.append(edition ? welcome() : el("p", "Ask me to inspect your work, navigate the Desktop, or carry out a task. I keep the available context and each action's result together.", "yur-franklin-empty"));
      if (edition) shell.dataset.empty = String(!snapshot.messages.length && !pending && !streaming);
      for (const message of snapshot.messages) { const card = el("article", "", "yur-franklin-message"); card.dataset.role = message.role; card.append(el("strong", message.role === "user" ? "You" : message.role === "assistant" ? "Franklin" : message.role), el("p", message.content)); if (message.request_id) { const identity = el("details"); identity.append(el("summary", "Request identity"), el("code", text(message.request_id, 128))); card.append(identity); } log.append(card); }
      if (pending && !snapshot.messages.some(item => item.role === "user" && item.request_id === pending.request_id)) { const card = el("article", "", "yur-franklin-message"); card.dataset.role = "user"; card.append(el("strong", "You · pending confirmation"), el("p", pending.text)); log.append(card); }
      if (streaming) { const card = el("article", "", "yur-franklin-message"); card.append(el("strong", "Franklin · responding"), el("p", streaming)); log.append(card); }
      log.scrollTop = follow ? log.scrollHeight : previousScroll;
    }
    function renderContext() {
      contextBody.replaceChildren(); contextBody.append(el("p", text(snapshot.context.summary, 8000) || "No compiled Desktop context has been reported yet."));
      for (const item of (Array.isArray(snapshot.context.sections) ? snapshot.context.sections : []).slice(0, 30)) contextBody.append(el("p", `${text(item.label, 120)}: ${typeof item.value === "string" ? text(item.value, 2000) : JSON.stringify(item.value ?? null)}`));
      contextBody.append(el("h3", "Authority and permissions"), el("p", text(snapshot.permissions.summary, 8000) || "Actions use the Desktop's existing permission, validation and Commit Service boundaries."));
      if (Array.isArray(snapshot.permissions.actions)) { const list = el("ul"); for (const action of snapshot.permissions.actions.slice(0, 40)) list.append(el("li", text(action, 300))); contextBody.append(list); }
      const review = object(snapshot.permissions.review); if (review.status === "pending") contextBody.append(el("p", text(review.summary, 4000) || "A specific action is waiting for your approval in its owning tool.", "yur-franklin-review"));
    }
    function renderTimeline() {
      timelineBody.replaceChildren(); const entries = [...snapshot.events, ...eventItems].slice(-100); timelineSummary.textContent = `Actions and receipts · ${entries.length} retained`;
      if (!entries.length) timelineBody.append(el("p", "No actions have been reported yet."));
      for (const entry of entries.slice().reverse()) { const card = el("article", "", "yur-franklin-event"); card.append(el("strong", text(entry.type || entry.kind, 100) || "Runtime event"), el("p", text(entry.summary || entry.message, 4000) || "Status reported by the runtime.")); if (entry.status) card.append(el("small", text(entry.status, 100))); if (entry.receipt) { const detail = el("details"); detail.append(el("summary", entry.receipt.status === "committed" ? "Committed receipt details" : "Reported receipt details"), el("pre", text(JSON.stringify(entry.receipt, null, 2), 12000))); card.append(detail); } timelineBody.append(card); }
    }
    function render() {
      if (disposed) return;
      const previous = model.value; model.replaceChildren(); const placeholder = el("option", "Choose an available model"); placeholder.value = ""; model.append(placeholder);
      for (const item of snapshot.models) { const option = el("option", item.label); option.value = item.id; model.append(option); }
      const selected = snapshot.preferences.model || defaultModel() || previous;
      if (selected && !snapshot.models.some(item => item.id === selected)) { const missing = el("option", selected + " · unavailable"); missing.value = selected; missing.disabled = true; model.append(missing); }
      model.value = selected; if (input.value !== draft) input.value = draft; renderLog(); renderContext(); renderTimeline(); renderStatus();
    }
    function apply(value, { keepOpen = false } = {}) {
      value = unwrap(value); if (value?.snapshot) value = value.snapshot;
      if (!value || typeof value !== "object") return false;
      if (!Object.hasOwn(value, "messages") && !Object.hasOwn(value, "preferences") && !Object.hasOwn(value, "active_request")) return false;
      const merged = { ...snapshot, ...value, preferences: { ...snapshot.preferences, ...object(value.preferences) } };
      snapshot = normalizeSnapshot(merged); if (!keepOpen && !openVersion) expanded = pinned || snapshot.preferences.open;
      // The host returns retained calls newest first; insertion order keeps the
      // most recent unresolved call as the default recovery selection.
      for (const item of snapshot.queue_calls.slice().reverse()) rememberQueue(item);
      for (const event of snapshot.events) if (event?.type === 'model_queue') rememberQueue(event);
      if (!ready || !dirtyDraft) draft = snapshot.preferences.draft;
      ready = true;
      if (snapshot.active_request) {
        const active = snapshot.active_request;
        pending = { request_id: active.request_id, text: text(active.text) || snapshot.messages.find(item => item.role === "user" && item.request_id === active.request_id)?.content || pending?.text || "Saved request" };
      } else if (pending && (snapshot.messages.some(item => item.request_id === pending.request_id && ["assistant", "error"].includes(item.role)) || value.completed_request_id === pending.request_id)) { pending = null; streaming = ""; }
      if (Object.hasOwn(value, "events")) eventItems = [];
      render(); return true;
    }
    async function load({ preserveError = false } = {}) {
      const generation = ++loadGeneration;
      try { const value = await api.snapshot(); if (disposed || generation !== loadGeneration) return; apply(value); if (!preserveError) errorText = ""; renderStatus(); }
      catch (error) { if (!disposed && generation === loadGeneration) fail(error); }
      finally { if (!disposed && generation === loadGeneration) { refresh.disabled = false; } }
    }
    function configure(patch, options = {}) {
      configBusy++; renderStatus();
      const operation = configChain.catch(() => {}).then(async () => {
        const value = unwrap(await api.configure(patch)); if (disposed) return;
        if (options.draftVersion === draftVersion) dirtyDraft = false;
        if (options.openVersion === openVersion) openVersion = 0;
        if (!apply(value, { keepOpen: true })) { snapshot.preferences = { ...snapshot.preferences, ...patch }; render(); }
      });
      configChain = operation;
      return operation.catch(error => { fail(error); throw error; }).finally(() => { configBusy--; if (!disposed) renderStatus(); });
    }
    function persistDraft() { if (draftTimer) clearTimeout(draftTimer); draftTimer = null; const version = draftVersion; return configure({ draft }, { draftVersion: version }); }
    function setOpen(value) { if (pinned) { expanded = true; renderStatus(); if (value) input.focus?.(); return; } if (!value && dictationState.phase !== "idle") void dictation?.cancel().catch(error => { voiceError = text(error.message, 1000); renderStatus(); }); expanded = value; const version = ++openVersion; renderStatus(); void configure({ open: value }, { openVersion: version }).catch(() => {}); if (value) input.focus?.(); }
    async function sendRequest(reconcile = false) {
      if (disposed || sending || snapshot.active_request) return;
      if (attentionQueues().length || queueBusy) return;
      if (dictationState.phase !== "idle" || transcriptPending) return;
      if (!reconcile && (!draft.trim() || pending || !snapshot.models.some(item => item.id === model.value))) return;
      if (!pending) pending = { text: draft.trim(), request_id: requestId() };
      const current = pending; sending = true; streaming = ""; errorText = ""; render();
      try {
        await configChain;
        const result = unwrap(await api.send({ text: current.text, request_id: current.request_id }));
        if (disposed) return;
        if (result?.request_id && result.request_id !== current.request_id) throw new Error("Franklin returned a different request identity.");
        apply(result);
        await load();
        const recorded = snapshot.messages.some(item => item.role === "user" && item.request_id === current.request_id) || snapshot.active_request?.request_id === current.request_id;
        if (recorded && draft.trim() === current.text) { draft = ""; input.value = ""; dirtyDraft = true; draftVersion++; await persistDraft(); }
        if (!snapshot.active_request && (result?.completed === true || result?.status === "completed" || result?.status === "cancelled")) pending = null;
      } catch (error) { if (!disposed) { fail(error); await load({ preserveError: true }); } }
      finally { sending = false; if (!disposed) render(); }
    }
    async function cancel() {
      const id = snapshot.active_request?.request_id || pending?.request_id; if (!id || cancelling) return;
      cancelling = true; renderStatus();
      try { const result = unwrap(await api.cancel({ request_id: id })); if (disposed) return; if (result?.status === 'cancelled' || result?.cancelled === true) { localStops.add(id); for (const item of queueItems.values()) if (item.request_id === id) item.local_cancelled = true; } apply(result); await load(); if (result?.status === "cancelled" || result?.cancelled === true) { if (pending?.request_id === id) pending = null; streaming = ""; } }
      catch (error) { fail(error); }
      finally { cancelling = false; if (!disposed) render(); }
    }
    async function reconcileQueue(cancelSelected) {
      const selected = queueItems.get(queueSelection);
      if (disposed || queueBusy || isActive() || !selected || !UUID.test(selected.request_id) || !/^[a-f0-9]{32}$/.test(selected.call_id) || typeof api.queueReconcile !== 'function') return;
      const identity = { request_id: selected.request_id, call_id: selected.call_id, cancel: cancelSelected };
      queueBusy = true; errorText = ''; renderStatus();
      try {
        const result = object(unwrap(await api.queueReconcile(identity))); if (disposed) return;
        if (result.request_id !== identity.request_id || result.call_id !== identity.call_id || !remoteStates.has(result.remote_state)
            || typeof result.outcome_known !== 'boolean' || typeof result.cancel_confirmed !== 'boolean') throw new Error('Cloud recovery returned an invalid or different retained identity.');
        rememberQueue({ ...selected, ...result, phase: result.cancel_confirmed ? 'cancel_confirmed' : cancelSelected || selected.local_cancelled ? 'cancel_unconfirmed' : result.outcome_known && terminalStates.has(result.remote_state) ? 'terminal' : 'status',
          local_cancelled: selected.local_cancelled || cancelSelected }, true);
        queueItems.get(queueKey(selected)).liveOutcome = true;
      } catch (error) { if (!disposed) fail(error); }
      finally { queueBusy = false; if (!disposed) renderStatus(); }
    }
    function onEvent(event) {
      if (disposed || !event || typeof event !== "object") return;
      if (event.type === "desktop.activity") {
        const next = object(event.observation);
        if (Number.isSafeInteger(next.sequence) && next.sequence >= (snapshot.observation.sequence || 0)) { snapshot.observation = next; renderStatus(); }
        return;
      }
      if (event.type === "snapshot" && event.snapshot) { apply(event.snapshot); return; }
      const id = event.request_id || event.payload?.request_id;
      if (event.type === 'model_queue') {
        if (!id || id !== currentRequest() && ![...queueItems.values()].some(item => item.request_id === id && item.call_id === event.call_id)) return;
        rememberQueue(event, true); renderStatus(); return;
      }
      if (id && id !== (pending?.request_id || snapshot.active_request?.request_id)) return;
      if (event.type === "message.delta") { streaming = (streaming + text(event.text ?? event.payload?.text, 8000)).slice(-24000); renderLog(); return; }
      if (/^(reasoning|thinking)\./.test(event.type || "")) return;
      if (event.snapshot) apply(event.snapshot);
      if (event.summary || event.receipt) { eventItems.push({ type: text(event.type, 100), summary: text(event.summary, 4000), receipt: event.receipt, status: event.status }); eventItems = eventItems.slice(-100); renderTimeline(); }
      if (event.type === 'turn.error' && event.error) fail(event.error);
      if (event.type === 'turn.cancelled') { localStops.add(id); for (const item of queueItems.values()) if (item.request_id === id) item.local_cancelled = true; renderStatus(); }
      if (["turn.complete", "turn.error", "turn.cancelled", "message.complete"].includes(event.type)) { streaming = ""; void load({ preserveError: event.type === 'turn.error' }); }
    }
    toggle.addEventListener("click", () => setOpen(!expanded)); close.addEventListener("click", () => setOpen(false)); refresh.addEventListener("click", () => load());
    input.addEventListener("input", () => { draft = input.value.slice(0, 24000); dirtyDraft = true; draftVersion++; if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(() => { void persistDraft().catch(() => {}); }, debounceMs); renderStatus(); });
    input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void sendRequest(); } });
    form.addEventListener("submit", event => { event.preventDefault(); void sendRequest(); }); stop.addEventListener("click", () => cancel()); retry.addEventListener("click", () => sendRequest(true));
    queueCheck.addEventListener('click', () => reconcileQueue(false)); queueStop.addEventListener('click', () => reconcileQueue(true));
    queueSelect.addEventListener('change', () => { if (queueItems.has(queueSelect.value) && !queueBusy) { queueSelection = queueSelect.value; renderStatus(); } });
    model.addEventListener("change", () => { const selected = model.value; if (!snapshot.models.some(item => item.id === selected) || isActive() || pending || attentionQueues().length || queueBusy) return; void configure({ model: selected }).catch(() => { model.value = snapshot.preferences.model; }); });
    if (voice && typeof voice.createDictation === "function" && voice.api?.voice && typeof voice.readPreferences === "function") {
      dictation = voice.createDictation({ api: voice.api,
        onState: state => { dictationState = state; renderStatus(); },
        onError: message => { voiceError = text(message, 1000); renderStatus(); },
        onResult: async result => {
          const preferences = await voice.readPreferences();
          if (preferences?.dictation_enabled === false || preferences?.restricted_session === true) throw new Error("Local dictation is disabled in Desktop settings.");
          transcriptInput.value = text(result.text, 24000); transcriptPending = true; voiceError = ""; setOpen(true); renderStatus(); transcriptInput.focus?.();
        },
      });
      void dictation.refresh().catch(error => { voiceError = text(error.message, 1000); renderStatus(); });
    }
    dictate.addEventListener("click", async () => {
      if (!dictation || transcriptPending) return;
      voiceError = "";
      try {
        const preferences = await voice.readPreferences();
        if (preferences?.dictation_enabled === false || preferences?.restricted_session === true) throw new Error("Local dictation is disabled in Desktop settings.");
        await dictation.start();
      } catch (error) { voiceError = text(error.message, 1000); renderStatus(); }
    });
    voiceStop.addEventListener("click", async () => { try { await dictation?.stop(); } catch (error) { voiceError = text(error.message, 1000); renderStatus(); } });
    voiceCancel.addEventListener("click", async () => { try { await dictation?.cancel(); } catch (error) { voiceError = text(error.message, 1000); renderStatus(); } });
    insertTranscript.addEventListener("click", () => {
      if (!transcriptPending) return;
      const value = text(transcriptInput.value).trim(), next = draft.trim() && value ? `${draft}\n\n${value}` : draft || value;
      if (!value || next.length > 24000) { voiceError = "Review a nonempty transcript that fits in the draft."; renderStatus(); return; }
      draft = next; input.value = next; dirtyDraft = true; draftVersion++; transcriptInput.value = ""; transcriptPending = false; voiceError = "";
      void persistDraft().catch(error => fail(error)); renderStatus(); input.focus?.();
    });
    discardTranscript.addEventListener("click", () => { transcriptInput.value = ""; transcriptPending = false; voiceError = ""; renderStatus(); });
    const unsubscribe = api.onEvent?.(onEvent);
    const controller = { refresh: load, onEvent, open: () => setOpen(true), collapse: () => setOpen(false), cancelDictation: () => dictation?.cancel() || Promise.resolve(), flushDraft: () => dirtyDraft ? persistDraft() : configChain,
      // An edition's Approvals opens his Activity with the receipts; the Desktop drawer has no Activity.
      showActivity() { if (edition) setActivity(true); timeline.open = true; },
      prepareDraft(value) {
        if (typeof value !== 'string' || !value.trim() || /\0/.test(value) || value.length > 8000) throw new Error('Provide a bounded assistant request.');
        if (isActive() || pending || attentionQueues().length) { setOpen(true); throw new Error('Finish or stop the current Franklin request before preparing another.'); }
        const next = draft.trim() ? draft + '\n\n' + value : value;
        if (next.length > 24000) throw new Error('The existing Franklin draft is full. Edit it before adding this request.');
        draft = next; input.value = next; dirtyDraft = true; draftVersion++; setOpen(true); input.focus();
        void persistDraft().catch(error => fail(error)); renderStatus();
        return { prepared: true, submitted: false };
      },
      dispose() { disposed = true; loadGeneration++; if (draftTimer) clearTimeout(draftTimer); if (progressTimer) clearInterval(progressTimer); void dictation?.dispose().catch(() => {}); unsubscribe?.(); shell.remove(); mounted.delete(host); } };
    mounted.set(host, controller); render(); void load(); return controller;
  }
  return { create, normalizeSnapshot };
});
