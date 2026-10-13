window.addEventListener('DOMContentLoaded', async () => {
  const info = await window.studio.integration.info(); if (!info.enabled) return;
  document.body.classList.add('glider-enabled');
  const frame = document.createElement('div'); frame.id = 'glider-frame';
  frame.innerHTML = '<header><strong>◤◢ INTELLIFLOW</strong><span>sovereign shell workbench</span><span style="flex:1"></span><button id="glider-min">—</button><button id="glider-max">▢</button><button id="glider-close">✕</button></header><nav><button id="glider-desktop" class="selected">YUR AI Desktop</button><button id="glider-coding">Coding</button><button id="glider-market">Marketplace</button><button id="glider-foundry">Foundry</button></nav>';
  document.body.append(frame);
  const productionTab = document.createElement('button'); productionTab.id = 'glider-production'; productionTab.type = 'button'; productionTab.textContent = 'Production';
  frame.querySelector('nav').append(productionTab);
  const pageMenu = document.createElement('div'); pageMenu.className = 'glider-pages-menu';
  const pageMenuTrigger = document.createElement('button'); pageMenuTrigger.id = 'glider-pages'; pageMenuTrigger.type = 'button';
  pageMenuTrigger.textContent = 'Pages ▾'; pageMenuTrigger.setAttribute('aria-haspopup', 'menu'); pageMenuTrigger.setAttribute('aria-expanded', 'false');
  const pageMenuList = document.createElement('div'); pageMenuList.className = 'glider-pages-list'; pageMenuList.id = 'glider-pages-list';
  pageMenuList.setAttribute('role', 'menu'); pageMenuList.setAttribute('aria-label', 'Desktop pages'); pageMenuList.hidden = true;
  pageMenu.append(pageMenuTrigger, pageMenuList); frame.querySelector('nav').append(pageMenu);
  const panel = document.createElement('section'); panel.id = 'rc6-panel'; panel.hidden = true;
  panel.innerHTML = '<div class="rc6-toolbar"><div class="rc6-toolbar-heading"><span class="rc6-eyebrow">CODING WORKBENCH</span><strong>INTELLIFLOW</strong></div><div class="rc6-toolbar-actions"><button id="rc6-workspace">Choose repository</button><button id="rc6-connect" disabled>Connect IntelliFlow</button><button id="rc6-workbench" hidden>Open department workbench</button><button id="rc6-disconnect" disabled>Disconnect</button><button id="rc6-new" disabled>New task</button><button id="rc6-interrupt" disabled>Stop</button></div><span id="rc6-state" role="status" aria-live="polite">Choose a repository and model to begin.</span></div><div class="rc6-models"><label for="rc6-model">Coding model</label><select id="rc6-model" aria-describedby="rc6-model-status" disabled><option value="">Choose a model</option></select><button id="rc6-refresh-models">Refresh</button><span id="rc6-model-status" role="status" aria-live="polite">Cloud and local models from your Ollama connection.</span><span id="rc6-provider">Choose a model, then connect IntelliFlow.</span></div><div id="rc6-log" role="log" aria-live="polite"></div><form><textarea id="rc6-prompt" aria-label="Coding instruction" placeholder="Describe the change you want made in this repository…" disabled></textarea><button id="rc6-send" class="rc6-send" disabled>Send task</button></form>';
  document.body.append(panel);
  panel.querySelector('.rc6-toolbar strong').id = 'rc6-runtime-title';
  const runtimeControls = document.createElement('div'); runtimeControls.className = 'rc6-runtime-controls';
  runtimeControls.innerHTML = '<label for="rc6-runtime">Coding harness</label><select id="rc6-runtime" aria-describedby="rc6-runtime-scope" disabled></select><span id="rc6-runtime-scope" role="status">Checking installed harnesses…</span>';
  panel.querySelector('.rc6-models').prepend(runtimeControls);
  const workbench = document.createElement('div'); workbench.className = 'rc6-workbench';
  const contextRail = document.createElement('aside'); contextRail.className = 'rc6-context-rail'; contextRail.setAttribute('aria-label', 'Coding task context');
  contextRail.innerHTML = '<section class="rc6-context-card rc6-context-intro"><span class="rc6-eyebrow">ACTIVE WORKSPACE</span><h1 id="rc6-task-heading">Ready for a coding task</h1><p id="rc6-task-copy">Choose a repository, connect a harness, and describe the work. The runtime handles tools, validation, approvals, and receipts.</p><div class="rc6-context-facts"><div><span>Repository</span><strong id="rc6-fact-workspace">Not selected</strong></div><div><span>Harness</span><strong id="rc6-fact-harness">IntelliFlow</strong></div><div><span>Model</span><strong id="rc6-fact-model">Not selected</strong></div></div></section><section class="rc6-context-card rc6-session-card"><div class="rc6-card-heading"><span>Current task</span><span id="rc6-session-badge" class="rc6-badge">Not started</span></div><strong id="rc6-session-state">Choose a repository to start.</strong><button id="rc6-start" class="rc6-primary-context" disabled>Start a new task</button></section><section class="rc6-context-card rc6-files-card"><div class="rc6-card-heading"><span>Files</span><button id="rc6-refresh-files" class="rc6-card-action" type="button">Refresh</button></div><div id="rc6-file-tree" class="rc6-file-tree">Choose a repository</div></section><details class="rc6-context-card rc6-context-help"><summary>How this works</summary><p>1. Choose the repository you want to work in.</p><p>2. Select a model and connect the harness.</p><p>3. Start a task and describe the outcome in plain language.</p><p>Tool calls and approval requests stay visible in the inspector.</p></details></aside>';
  const conversation = document.createElement('div'); conversation.className = 'rc6-conversation';
  const welcome = document.createElement('section'); welcome.id = 'rc6-welcome'; welcome.className = 'rc6-welcome-card'; welcome.innerHTML = '<span class="rc6-eyebrow">GOVERNED CODING SESSION</span><h1>What are we building?</h1><p>Give IntelliFlow the outcome you want. It can inspect the repository, edit files through approved tools, validate the result, and show the receipt here.</p><div class="rc6-next-steps"><span><b>1</b> Choose repository</span><span><b>2</b> Connect harness</span><span><b>3</b> Describe the task</span></div>';
  const liveWork = document.createElement('section'); liveWork.id = 'rc6-live-work'; liveWork.className = 'rc6-live-work idle'; liveWork.setAttribute('aria-live', 'polite'); liveWork.innerHTML = '<div class="rc6-live-head"><span class="rc6-live-pulse" aria-hidden="true"></span><strong id="rc6-live-state">Ready</strong><span id="rc6-live-elapsed"></span><span id="rc6-live-health">Waiting for a task</span></div><div id="rc6-live-detail">Choose a repository and model to begin.</div>';
  conversation.append(welcome, panel.querySelector('#rc6-log'), liveWork, panel.querySelector('form'));
  const observerHost = document.createElement('aside'); observerHost.className = 'rc6-observer-host'; observerHost.setAttribute('aria-label', 'Harness tools and runtime activity');
  workbench.append(contextRail, conversation, observerHost); panel.append(workbench);
  const inputModal = document.createElement('div'); inputModal.id = 'rc6-input-modal'; inputModal.hidden = true; inputModal.setAttribute('role', 'dialog'); inputModal.setAttribute('aria-modal', 'true'); inputModal.innerHTML = '<form class="rc6-input-dialog"><h2 id="rc6-input-title">IntelliFlow needs input</h2><p id="rc6-input-message"></p><input id="rc6-input-value" autocomplete="off"><div class="rc6-input-actions"><button type="button" id="rc6-input-cancel">Cancel</button><button type="submit" id="rc6-input-continue">Continue</button></div></form>'; panel.append(inputModal);
  const observer = window.yurRc6Observer.create(observerHost, { api: window.studio.rc6 });
  const $ = id => document.getElementById(id), log = $('rc6-log'); let session, connectedProvider, assistantMessage = null, pendingInput = null;
  let runtimeStatus = null, runtimes = [], selectingRuntime = false, generation = 0, submitting = false;
  let lastTurnStatus = null, turnHadToolFailure = false;
  const runtimeName = () => runtimeStatus?.runtimeName || 'IntelliFlow';
  const shortPath = value => {
    if (typeof value !== 'string' || !value) return 'Not selected';
    const normalized = value.replaceAll('\\', '/');
    return normalized.length > 54 ? '…/' + normalized.split('/').slice(-2).join('/') : normalized;
  };
  function setLive(state, detail, tone = 'idle') {
    liveWork.className = 'rc6-live-work ' + tone;
    $('rc6-live-state').textContent = state;
    $('rc6-live-detail').textContent = detail;
    $('rc6-live-health').textContent = tone === 'working' || tone === 'waiting' ? 'Runtime active' : tone === 'error' ? 'Needs attention' : 'Ready for a task';
  }
  function updateContext(status = runtimeStatus) {
    $('rc6-fact-workspace').textContent = shortPath(status?.workspace);
    $('rc6-fact-workspace').title = status?.workspace || '';
    $('rc6-fact-harness').textContent = runtimeName();
    $('rc6-fact-model').textContent = connectedProvider?.model || (selectedModel ? selectedModel.replace(/^ollama:/, '') : 'Not selected');
    $('rc6-fact-model').title = connectedProvider?.model || selectedModel || '';
    $('rc6-session-state').textContent = session ? (submitting ? 'Runtime is working on this task.' : lastTurnStatus === 'failed' ? 'The last response failed. Review the runtime activity before retrying.' : lastTurnStatus === 'tool-failed' ? 'A tool failed in the last response. Review its result before relying on the output.' : lastTurnStatus === 'cancelled' ? 'The last response was cancelled. You can send another instruction.' : 'Ready for your next instruction.') : connectedProvider ? 'Connected. Start a task when you are ready.' : 'Choose a repository to start.';
    $('rc6-session-badge').textContent = session ? (submitting ? 'Working' : lastTurnStatus === 'failed' ? 'Failed' : lastTurnStatus === 'tool-failed' ? 'Tool failed' : lastTurnStatus === 'cancelled' ? 'Cancelled' : 'Ready') : connectedProvider ? 'Connected' : 'Not started';
    $('rc6-start').disabled = !connectedProvider || submitting || selectingRuntime;
  }
  function renderFiles(items, root) {
    const tree = $('rc6-file-tree'); tree.replaceChildren();
    if (!Array.isArray(items) || !items.length) { tree.textContent = 'No files at the repository root.'; return; }
    for (const item of items.slice().sort((a, b) => Number(b.isDir) - Number(a.isDir) || String(a.name).localeCompare(String(b.name))).slice(0, 80)) {
      const row = document.createElement('div'); row.className = 'rc6-file-row';
      const mark = document.createElement('span'); mark.textContent = item.isDir ? '▾' : '·';
      const name = document.createElement('span'); name.textContent = item.name; name.title = root + '\\' + item.name;
      row.append(mark, name); tree.append(row);
    }
    if (items.length > 80) { const more = document.createElement('small'); more.textContent = '+ ' + (items.length - 80) + ' more entries'; tree.append(more); }
  }
  async function refreshFiles(status = runtimeStatus) {
    const tree = $('rc6-file-tree'), root = status?.workspace;
    if (!root || !window.studio.file?.list) { tree.textContent = 'Choose a repository'; return; }
    tree.textContent = 'Loading repository files…';
    try { const result = await window.studio.file.list(root); if (result?.ok) renderFiles(result.items, root); else tree.textContent = 'Files unavailable: ' + String(result?.error || 'read failed').slice(0, 180); }
    catch (error) { tree.textContent = 'Files unavailable: ' + String(error.message || error).slice(0, 180); }
  }
  function appendMessage(role, text, meta = '') {
    const row = document.createElement('article'); row.className = 'rc6-message rc6-message-' + role;
    const header = document.createElement('div'); header.className = 'rc6-message-header'; header.textContent = role === 'user' ? 'You' : role === 'assistant' ? runtimeName() : role === 'warning' ? 'Needs attention' : 'Session';
    const body = document.createElement('div'); body.className = 'rc6-message-body'; body.textContent = String(text ?? '');
    row.append(header, body);
    if (meta) { const note = document.createElement('div'); note.className = 'rc6-message-meta'; note.textContent = meta; row.append(note); }
    log.append(row); log.scrollTop = log.scrollHeight; return { row, body };
  }
  function line(text) { appendMessage('system', text); }
  function appendAssistantText(text) {
    if (!assistantMessage) assistantMessage = appendMessage('assistant', '');
    assistantMessage.body.textContent += text; log.scrollTop = log.scrollHeight;
    return assistantMessage;
  }
  function collapseUnresolvedTemplate() {
    if (!assistantMessage || !/\$ARGUMENTS\b|\{\{\s*(?:arguments|prompt)\s*\}\}/i.test(assistantMessage.body.textContent)) return false;
    const raw = assistantMessage.body.textContent;
    assistantMessage.row.classList.add('rc6-template-warning'); assistantMessage.body.replaceChildren();
    const notice = document.createElement('div'); notice.className = 'rc6-template-notice'; notice.textContent = 'This run started from an unresolved template. Start a new task and describe the actual change you want made.';
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Show the raw harness response'; const pre = document.createElement('pre'); pre.textContent = raw.slice(0, 32000); details.append(summary, pre);
    assistantMessage.body.append(notice, details); return true;
  }
  function unresolvedTemplate(text) { return /\$ARGUMENTS\b|\{\{\s*(?:arguments|prompt)\s*\}\}/i.test(text); }
  function appendRuntimeEvent(event) {
    const payload = event.payload || {};
    if (event.type === 'authority.commit') {
      const receipt = payload.receipt || payload;
      const id = receipt.commit_id || receipt.commitId || 'receipt recorded';
      const committed = receipt.status === 'committed' && Boolean(receipt.commit_id || receipt.commitId);
      appendMessage('receipt', committed ? 'Commit recorded' : 'Commit event reported', 'authority.commit · ' + id);
      setLive(committed ? 'Committed' : 'Commit status reported', committed ? 'The runtime reported a governed commit receipt.' : 'Inspect the runtime receipt for its outcome.', committed ? 'complete' : 'idle');
    } else if (event.type === 'authority.validation' || event.type === 'authority.validate') {
      line('Validation reported · ' + String(payload.status || payload.message || 'result available').slice(0, 180));
    } else if (event.type === 'error') {
      line('Runtime error · ' + String(payload.message || payload.error || 'The harness reported an error.').slice(0, 1000));
    }
  }
  function openInputRequest(event) {
    const payload = event.payload || {}, type = event.type.startsWith('clarify') ? 'clarify' : event.type.startsWith('sudo') ? 'sudo' : 'secret';
    const requestId = String(payload.request_id || ''); if (!requestId || !session) return;
    pendingInput = { requestId, type, sessionId: session, expected: generation };
    $('rc6-input-title').textContent = type === 'clarify' ? 'YUR needs clarification' : type === 'sudo' ? 'Protected command input' : 'Protected input';
    $('rc6-input-message').textContent = String(payload.prompt || payload.message || 'Enter the requested value.').slice(0, 8000);
    const input = $('rc6-input-value'); input.type = type === 'clarify' ? 'text' : 'password'; input.value = ''; input.placeholder = type === 'clarify' ? 'Tell the harness how to proceed…' : 'Enter the requested value'; inputModal.hidden = false;
    setLive('Waiting for your input', type === 'clarify' ? 'Answer the clarification to let the runtime continue.' : 'The runtime is waiting for protected input.', 'waiting'); $('rc6-state').textContent = 'Waiting for your input'; requestAnimationFrame(() => input.focus());
  }
  function addPendingInputCard() {
    if (!pendingInput) return;
    const card = appendMessage('warning', 'The runtime is waiting for your answer.', 'Input request · ' + pendingInput.type);
    const reopen = document.createElement('button'); reopen.className = 'rc6-reopen-input'; reopen.type = 'button'; reopen.textContent = 'Answer request'; reopen.onclick = () => { inputModal.hidden = false; requestAnimationFrame(() => $('rc6-input-value').focus()); }; card.row.append(reopen);
  }
  function showRuntime(status) {
    runtimeStatus = status;
    $('rc6-runtime').value = status.runtimeKey || 'rc6';
    $('rc6-runtime-title').textContent = runtimeName();
    $('rc6-connect').textContent = 'Connect ' + runtimeName();
    $('rc6-prompt').placeholder = 'Describe the work. ' + runtimeName() + ' handles tools, validation and approval.';
    observerHost.setAttribute('aria-label', runtimeName() + ' tools and activity');
    const workbench = $('rc6-workbench');
    workbench.hidden = status.runtimeKey !== 'construction-v1';
    workbench.disabled = status.runtimeKey !== 'construction-v1' || status.workbench?.available !== true || Boolean(connectedProvider || connecting || selectingRuntime);
    workbench.title = status.workbench?.available === true ? 'Open the installed six-department Construction V1 workbench in its separate authority boundary.' : 'The verified Construction V1 workbench is not available on this machine.';
    $('rc6-runtime-scope').textContent = status.scope === 'construction-master'
      ? 'Project, evidence and validation tools · department transport is not connected'
      : 'Private coding sessions, tools and approvals';
    observer.setRuntime(status);
    updateContext(status);
    refreshFiles(status);
  }
  let models = [], selectedModel = '', explicitModel = false, refreshGeneration = 0, refreshing = false, connecting = false, catalogReady = false;
  function modelControls() {
    const locked = Boolean(connectedProvider || connecting || selectingRuntime);
    $('rc6-runtime').disabled = locked || !runtimes.length;
    $('rc6-workspace').disabled = locked;
    $('rc6-model').disabled = locked || refreshing || !catalogReady || !models.length;
    $('rc6-refresh-models').disabled = locked || refreshing;
    $('rc6-connect').disabled = locked || !runtimeStatus || refreshing || !catalogReady || !models.some(model => model.id === selectedModel)
      || !runtimes.some(item => item.runtimeKey === runtimeStatus.runtimeKey && item.installed);
    $('rc6-workbench').disabled = runtimeStatus?.runtimeKey !== 'construction-v1' || runtimeStatus?.workbench?.available !== true || locked;
    updateContext();
  }
  function drawModels() {
    const select = $('rc6-model'); select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a model'; select.append(placeholder);
    for (const model of models) {
      const option = document.createElement('option'); option.value = model.id; option.textContent = model.label; select.append(option);
    }
    if (selectedModel && !models.some(model => model.id === selectedModel)) {
      const missing = document.createElement('option'); missing.value = selectedModel; missing.textContent = selectedModel.slice(7) + ' · unavailable'; missing.disabled = true; select.append(missing);
    }
    select.value = selectedModel; modelControls();
  }
  async function refreshModels() {
    if (connectedProvider || connecting || selectingRuntime) return;
    const generation = ++refreshGeneration; refreshing = true; catalogReady = false;
    $('rc6-model-status').textContent = 'Checking available models…'; modelControls();
    try {
      const tags = await window.studio.ollama.tags();
      if (generation !== refreshGeneration) return;
      if (!tags || !Array.isArray(tags.models)) throw new Error('Ollama returned an invalid model list.');
      models = window.yurModelSetup.summarize({ checked: true, mode: 'code', ollama: { online: true, models: tags.models } }).models;
      if (!explicitModel && !selectedModel) {
        const desktopModel = $('yc-model')?.value;
        if (models.some(model => model.id === desktopModel)) selectedModel = desktopModel;
      }
      catalogReady = true;
      $('rc6-model-status').textContent = models.length ? models.length + ' models available · cloud and local' : 'Ollama is connected, but no models are listed.';
    } catch (error) {
      if (generation !== refreshGeneration) return;
      models = []; catalogReady = false;
      $('rc6-model-status').textContent = 'Could not load models: ' + error.message;
    } finally {
      if (generation === refreshGeneration) { refreshing = false; drawModels(); }
    }
  }
  $('rc6-model').addEventListener('change', () => {
    if (connectedProvider || connecting || refreshing) { $('rc6-model').value = selectedModel; return; }
    selectedModel = $('rc6-model').value; explicitModel = true; modelControls(); setLive(selectedModel ? 'Model selected' : 'Choose a model', selectedModel ? 'Connect the harness when you are ready.' : 'Select a model to continue.');
  });
  $('rc6-refresh-models').onclick = () => refreshModels();
  $('rc6-refresh-files').onclick = () => refreshFiles();
  $('rc6-runtime').addEventListener('change', () => {
    const prior = runtimeStatus;
    if (connectedProvider || connecting || selectingRuntime) { $('rc6-runtime').value = prior?.runtimeKey || 'rc6'; return; }
    const key = $('rc6-runtime').value, expected = ++generation;
    run(async () => {
    selectingRuntime = true; modelControls();
    try {
      const status = await window.studio.rc6.chooseRuntime(key);
      if (expected !== generation) return;
      session = null; assistantMessage = null; log.replaceChildren(); observer.setSession(null); welcome.hidden = false; showRuntime(status);
      $('rc6-state').textContent = runtimeName() + ' · disconnected · ' + status.workspace;
      $('rc6-provider').textContent = 'Choose a model, then connect ' + runtimeName() + '.';
      for (const id of ['rc6-new', 'rc6-prompt', 'rc6-send', 'rc6-interrupt']) $(id).disabled = true;
      setLive('Ready', 'Choose a model and connect the harness to begin.');
    } catch (error) { if (expected === generation) { $('rc6-runtime').value = prior?.runtimeKey || 'rc6'; throw error; } }
    finally { selectingRuntime = false; modelControls(); }
    });
  });
  function providerLabel(status) { return status.model + (status.modelSource === 'environment' ? ' · model environment override' : '') + ' · ' + status.baseUrl + (status.endpointSource === 'environment' ? ' · endpoint environment override' : ''); }
  async function run(action) { const expected = generation; try { return await action(); } catch (error) { if (expected === generation) { $('rc6-state').textContent = error.message; line('Error: ' + error.message); } } }
  function select(coding, id) { panel.hidden = !coding; window.dispatchEvent(new CustomEvent('yur:coding-visible', { detail: coding })); frame.querySelectorAll('nav button').forEach(b => b.classList.toggle('selected', b.id === id)); if (coding && !connectedProvider && !connecting && !refreshing) refreshModels(); }
  function closePageMenu() { pageMenuList.hidden = true; pageMenuTrigger.setAttribute('aria-expanded', 'false'); }
  pageMenuTrigger.onclick = () => {
    if (!pageMenuList.hidden) { closePageMenu(); return; }
    pageMenuList.replaceChildren();
    const destinations = document.querySelectorAll('#yur-conversation .yc-nav > button');
    for (const destination of destinations) {
      if (destination.hidden || destination.disabled) continue;
      const name = destination.querySelector('span')?.textContent?.trim();
      if (!name) continue;
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem');
      item.textContent = name;
      item.onclick = () => { closePageMenu(); select(false, 'glider-desktop'); destination.click(); };
      pageMenuList.append(item);
    }
    if (!pageMenuList.childElementCount) { const empty = document.createElement('span'); empty.textContent = 'No Desktop pages are available.'; pageMenuList.append(empty); }
    pageMenuList.hidden = false; pageMenuTrigger.setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('click', event => { if (!pageMenu.contains(event.target)) closePageMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !pageMenuList.hidden) { closePageMenu(); pageMenuTrigger.focus(); } });
  $('glider-desktop').onclick = () => { select(false, 'glider-desktop'); window.dispatchEvent(new CustomEvent('yur:conversation-home')); };
  window.addEventListener('yur:desktop-visible', () => select(false, 'glider-desktop'));
  $('glider-coding').onclick = () => select(true, 'glider-coding');
  document.addEventListener('click', event => { if (event.target.closest('#yc-intelliflow-open, #yc-launch-intelliflow')) { event.preventDefault(); event.stopImmediatePropagation(); select(true, 'glider-coding'); } }, true);
  $('glider-market').onclick = () => { select(false, 'glider-market'); document.getElementById('yc-marketplace-open')?.click(); };
  $('glider-foundry').onclick = () => run(() => window.studio.factory.open());
  productionTab.onclick = () => { select(false, 'glider-production'); document.getElementById('yc-production-open')?.click(); };
  $('glider-min').onclick = () => window.studio.window.minimize(); $('glider-max').onclick = () => window.studio.window.toggleMaximize(); $('glider-close').onclick = () => window.studio.window.close();
  $('rc6-start').onclick = () => $('rc6-new').click();
  $('rc6-input-cancel').onclick = () => { inputModal.hidden = true; addPendingInputCard(); setLive('Input pending', 'Reopen the request when you are ready to answer.', 'waiting'); };
  inputModal.querySelector('form').onsubmit = event => { event.preventDefault(); const request = pendingInput, value = $('rc6-input-value').value; if (!request || request.expected !== generation || request.sessionId !== session) return; if (!value.trim()) { $('rc6-input-message').textContent = 'Enter an answer before continuing.'; $('rc6-input-value').focus(); return; } $('rc6-input-continue').disabled = true; run(async () => { try { await window.studio.rc6.input(request.sessionId, request.requestId, request.type, value); if (pendingInput === request) { pendingInput = null; inputModal.hidden = true; setLive('Continuing', 'Your response was delivered to the runtime.', 'working'); $('rc6-state').textContent = 'Runtime continuing'; } } finally { $('rc6-input-continue').disabled = false; } }); };
  $('rc6-connect').onclick = () => run(async () => {
    if (connecting || connectedProvider || selectingRuntime || refreshing || !runtimeStatus || !catalogReady || !models.some(model => model.id === selectedModel)) return;
    const expected = generation; connecting = true; modelControls();
    try {
      const status = await window.studio.rc6.connect(selectedModel); if (expected !== generation) return; connectedProvider = status;
      showRuntime(status); void observer.refresh();
      $('rc6-provider').textContent = providerLabel(status) + ' · Disconnect to choose another model.';
      $('rc6-state').textContent = runtimeName() + ' connected · ready to start a task'; line('Connected to ' + runtimeName() + ' · ' + providerLabel(status)); setLive('Connected', 'Start a task and describe the result you want.', 'complete');
      $('rc6-new').disabled = false; $('rc6-disconnect').disabled = false; $('rc6-workspace').disabled = true;
      updateContext(status);
    } finally { connecting = false; modelControls(); }
  });
  $('rc6-workbench').onclick = () => run(async () => {
    const result = await window.studio.rc6.openWorkbench();
    $('rc6-state').textContent = 'Construction V1 six-department workbench launch dispatched · separate window';
    line('Construction V1 six-department workbench launch dispatched (PID ' + (result.pid ?? 'unreported') + ').');
  });
  $('rc6-workspace').onclick = () => run(async () => { const expected = generation; const status = await window.studio.rc6.chooseWorkspace(); if (expected !== generation) return; showRuntime(status); $('rc6-state').textContent = shortPath(status.workspace) + ' · choose a model to continue'; setLive('Repository selected', 'Select a model and connect the harness.'); });
  $('rc6-disconnect').onclick = () => run(() => { window.studio.rc6.disconnect(); });
  $('rc6-new').onclick = () => {
    if (!connectedProvider || submitting || $('rc6-new').disabled) return;
    const expected = ++generation; $('rc6-new').disabled = true;
    run(async () => {
      try {
        const result = await window.studio.rc6.createSession(); if (expected !== generation || !connectedProvider) return;
        session = result.session_id; assistantMessage = null; lastTurnStatus = null; turnHadToolFailure = false; log.replaceChildren(); observer.setSession(session); welcome.hidden = true;
        $('rc6-state').textContent = 'Task ready · ' + connectedProvider.model;
        for (const id of ['rc6-prompt','rc6-send','rc6-interrupt']) $(id).disabled = false;
        line('New ' + runtimeName() + ' session: ' + session + ' · task ready'); setLive('Ready', 'Describe the change you want made in this repository.'); updateContext();
      } finally { if (expected === generation) $('rc6-new').disabled = !connectedProvider; }
    });
  };
  $('rc6-interrupt').onclick = () => run(async () => { await window.studio.rc6.interrupt(session); setLive('Stopping', 'The runtime is finishing its current operation.', 'waiting'); });
  panel.querySelector('form').onsubmit = event => { event.preventDefault(); const text = $('rc6-prompt').value.trim(); if (!text || !session || submitting) return; if (unresolvedTemplate(text)) { appendMessage('warning', 'This prompt still contains an unresolved template placeholder. Replace $ARGUMENTS with the actual coding task, then send it again.'); setLive('Needs a real task', 'Replace the template placeholder before starting work.', 'error'); return; } const expected = generation, ownedSession = session; submitting = true; lastTurnStatus = null; turnHadToolFailure = false; assistantMessage = null; $('rc6-send').disabled = true; $('rc6-new').disabled = true; $('rc6-state').textContent = runtimeName() + ' working · task ' + session; appendMessage('user', text); $('rc6-prompt').value = ''; setLive('Planning', 'IntelliFlow is reading the task and preparing the next operation.', 'working'); updateContext(); run(async () => { try { await window.studio.rc6.submit(ownedSession, text); } catch (error) { if (expected !== generation) return; submitting = false; lastTurnStatus = 'failed'; $('rc6-send').disabled = !session; $('rc6-new').disabled = !connectedProvider; setLive('Submission failed', 'The harness rejected the instruction before completing a response.', 'error'); updateContext(); throw error; } }); };
  window.studio.rc6.onEvent(event => {
    if (event.runtimeKey && event.runtimeKey !== runtimeStatus?.runtimeKey) return;
    observer.onEvent(event);
    const payload = event.payload || {}, eventSession = event.session_id || payload.session_id;
    if (eventSession && eventSession !== session) return;
    if (['clarify.request', 'sudo.request', 'secret.request'].includes(event.type)) { openInputRequest(event); return; }
    if (payload.kind === 'ApprovalRequest' && payload.request_id) {
      const expected = generation, ownedSession = session;
      const card = document.createElement('div'); card.className = 'rc6-approval'; card.setAttribute('role', 'alert'); card.tabIndex = -1;
      const description = document.createElement('div'); description.textContent = runtimeName() + ' is waiting for your approval\n' + String(payload.description || payload.reason || 'Review this scoped request before continuing.').slice(0, 2000); card.append(description);
      const scope = document.createElement('p'); scope.textContent = 'Tool: ' + (payload.tool?.name || payload.source?.logical_id || 'See request details') + '\nDestination: ' + (payload.destination?.model || connectedProvider?.model || 'See request details') + '\nRequest: ' + payload.request_id; card.append(scope);
      const details = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('pre'); summary.textContent = 'Exact request and permissions'; body.textContent = JSON.stringify(payload, null, 2).slice(0, 32000); details.append(summary, body); card.append(details);
      for (const choice of ['approve', 'deny']) { const button = document.createElement('button'); button.textContent = choice === 'approve' ? 'Approve this request once' : 'Deny'; button.onclick = () => run(async () => { if (expected !== generation || ownedSession !== session) return; card.querySelectorAll('button').forEach(b => b.disabled = true); await window.studio.rc6.approval(ownedSession, payload.request_id, choice); if (expected === generation) { description.textContent = runtimeName() + ' · decision sent: ' + choice; $('rc6-state').textContent = 'Decision sent · waiting for runtime'; } }); card.append(button); }
      log.append(card); $('rc6-state').textContent = runtimeName() + ' · awaiting your approval'; log.scrollTop = log.scrollHeight; card.scrollIntoView({ block: 'nearest' }); return;
    }
    if (event.type === 'message.delta') {
      const text = payload.delta ?? payload.text ?? payload.content;
      if (typeof text === 'string' && text) { appendAssistantText(text); $('rc6-state').textContent = runtimeName() + ' responding · task ' + session; setLive('Responding', 'The harness is writing its answer.', 'working'); }
    } else if (event.type === 'message.complete') {
      const completeText = payload.text;
      if (typeof completeText === 'string' && completeText) {
        if (!assistantMessage) appendAssistantText(completeText);
        else if (!assistantMessage.body.textContent || completeText.startsWith(assistantMessage.body.textContent)) assistantMessage.body.textContent = completeText;
      }
      const unresolved = collapseUnresolvedTemplate();
      const failed = window.yurRc6Observer.responseFailed(payload), cancelled = window.yurRc6Observer.responseCancelled(payload);
      lastTurnStatus = failed ? 'failed' : cancelled ? 'cancelled' : turnHadToolFailure ? 'tool-failed' : null;
      submitting = false; $('rc6-send').disabled = !session; $('rc6-new').disabled = !connectedProvider;
      if (failed) {
        $('rc6-state').textContent = 'Response failed · review runtime activity';
        setLive('Response failed', 'The harness reported a failed response. Inspect the runtime activity and receipts.', 'error');
        line('Response failed · task result needs review.');
      } else if (cancelled) {
        $('rc6-state').textContent = 'Response cancelled · ready for another instruction';
        setLive('Cancelled', 'The harness reported that this response was cancelled.', 'idle');
        line('Response cancelled.');
      } else if (unresolved) {
        $('rc6-state').textContent = 'Template response stopped · start a new task';
        setLive('Needs a real task', 'The previous run used an unresolved template. Start a new task.', 'error');
        line('Template response held · no coding operation was committed.');
      } else if (turnHadToolFailure) {
        $('rc6-state').textContent = 'Response ended · a tool failed';
        setLive('Tool failure reported', 'The response ended, but a tool failed. Inspect its result before relying on the task output.', 'error');
        line('Response ended · a tool failure needs review.');
      } else {
        $('rc6-state').textContent = 'Response ended · ready for another instruction';
        setLive('Response ended', 'Inspect tool, validation, and commit receipts to confirm the result.', 'idle');
        line('Response ended · task result is not independently verified.');
      }
      updateContext();
    } else if (event.type === 'gateway.ready') { $('rc6-state').textContent = runtimeName() + ' ready · start a task'; setLive('Ready', 'Start a task and describe the outcome you want.'); }
    else if (event.type === 'bridge.stopped' || event.type === 'bridge.error') { generation++; submitting = false; session = null; assistantMessage = null; lastTurnStatus = null; turnHadToolFailure = false; pendingInput = null; inputModal.hidden = true; connectedProvider = null; observer.setRuntime(null); welcome.hidden = false; log.querySelectorAll('.rc6-approval button').forEach(button => button.disabled = true); $('rc6-workspace').disabled = false; for (const id of ['rc6-disconnect','rc6-new','rc6-prompt','rc6-send','rc6-interrupt']) $(id).disabled = true; $('rc6-state').textContent = event.type === 'bridge.error' ? runtimeName() + ' stopped: ' + payload.message : runtimeName() + ' disconnected'; $('rc6-provider').textContent = 'Choose a model, then connect ' + runtimeName() + '.'; setLive('Disconnected', event.type === 'bridge.error' ? String(payload.message || 'The harness stopped unexpectedly.') : 'Connect the harness to start another task.', 'error'); updateContext(); modelControls(); }
    else if (event.type === 'error') { submitting = false; lastTurnStatus = 'failed'; $('rc6-send').disabled = !session; $('rc6-new').disabled = !connectedProvider; $('rc6-state').textContent = runtimeName() + ' needs attention'; appendRuntimeEvent(event); setLive('Needs attention', String(payload.message || payload.error || 'The harness reported an error.'), 'error'); updateContext(); }
    else if (event.type === 'tool.start' || event.type === 'tool.progress' || event.type === 'tool.complete') {
      const tool = String(payload.name || payload.tool_name || payload.tool || 'runtime tool').slice(0, 160);
      const done = event.type === 'tool.complete'; const failed = done && window.yurRc6Observer.toolFailed(payload);
      if (failed) turnHadToolFailure = true;
      setLive(failed ? 'Tool failed' : done ? 'Working' : 'Using tool', failed ? tool + ' reported an error.' : done ? tool + ' finished. Preparing the next step.' : tool + ' is running.', failed ? 'error' : 'working');
    } else if (event.type?.startsWith('authority.')) appendRuntimeEvent(event);
  });
  await run(async () => {
    const [catalog, status] = await Promise.all([window.studio.rc6.availableRuntimes(), window.studio.rc6.status()]);
    runtimes = catalog; const picker = $('rc6-runtime'); picker.replaceChildren();
    for (const item of catalog) { const option = document.createElement('option'); option.value = item.runtimeKey; option.textContent = item.runtimeName + (item.installed ? '' : ' · not installed'); option.disabled = !item.installed; picker.append(option); }
    showRuntime(status); modelControls();
  });
});
