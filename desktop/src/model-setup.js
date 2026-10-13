/* Model selection is explicit. This component only displays supplied connection
 * evidence; its callbacks use the existing Desktop settings and model routes. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.yurModelSetup = api;
})(typeof window === 'object' ? window : null, function () {
  let instance = 0;
  const clean = value => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';

  // Input: { checked, selectedModel, mode, busy?, contextKey?, foundry:{online,models},
  // ollama:{online,models} }. Models are names or {name|id}. An empty valid
  // Ollama tags response means online:true, not an offline service.
  function summarize(input = {}) {
    const checked = input.checked === true, mode = ['work', 'code'].includes(input.mode) ? input.mode : 'chat';
    const selectedModel = clean(input.selectedModel), models = [], services = [];
    for (const provider of ['foundry', 'ollama']) {
      const data = input[provider] || {}, online = checked && data.online === true;
      const label = provider === 'foundry' ? 'YUR harness' : 'Ollama';
      const discovered = new Map();
      if (online && provider === 'foundry') discovered.set('auto', 'Auto');
      if (online && Array.isArray(data.models)) for (const model of data.models.slice(0, 200)) {
        const name = clean(typeof model === 'string' ? model : model?.name || model?.id);
        if (name && `${provider}:${name}`.length <= 256) discovered.set(name, name === 'auto' && provider === 'foundry' ? 'Auto' : name);
      }
      for (const [name, display] of discovered) models.push({ id: `${provider}:${name}`, label: `${label} · ${display}`, provider, available: true, supported: mode === 'chat' || provider === 'ollama' });
      services.push({ provider, label, status: !checked ? 'checking' : !online ? 'offline' : discovered.size ? 'online' : 'online-empty', count: discovered.size });
    }
    let status, heading, message;
    const selected = models.find(model => model.id === selectedModel);
    if (!checked) { status = 'checking'; heading = 'Checking model connections'; message = 'Your draft stays here while Desktop checks the configured services.'; }
    else if (mode !== 'chat' && selectedModel.startsWith('foundry:')) {
      status = 'unsupported'; heading = `Choose a model for ${mode === 'code' ? 'Code' : 'Work'}`;
      message = 'The YUR harness connection currently supports Chat. Work and Code require a tool-capable Ollama model; choosing one does not start a task.';
    } else if (!services.some(service => ['online', 'online-empty'].includes(service.status))) {
      status = 'offline'; heading = 'Connect a model service'; message = 'Neither configured service responded successfully. Check the connection settings, then check again. Your draft is unchanged.';
    } else if (!models.length) {
      status = 'online-empty'; heading = 'Ollama is connected, but no models are listed'; message = 'Make a model available in your Ollama service, then check again. Desktop will not download or switch models for you.';
    } else if (!selected || !selected.supported) {
      status = 'selected-unavailable'; heading = selectedModel ? 'Your selected model is unavailable' : 'Choose a model'; message = 'Choose an available model below and select Use this model. Your current selection will not change automatically.';
    } else {
      status = 'usable'; heading = 'Model selected'; message = mode === 'chat' ? `${selected.label} is selected for Chat.` : `${selected.label} is selected. Work and Code require this model to support tools; connection discovery does not verify that capability.`;
    }
    return { status, heading, message, checked, selectedModel, mode, contextKey: clean(input.contextKey), busy: input.busy === true, models, services };
  }

  // Callbacks must reject on failure. The owner captures the original
  // conversation before awaiting onChoose and performs any journal writes.
  function create(host, { onChoose, onOpenSettings, onRefresh } = {}) {
    const document = host.ownerDocument || globalThis.document;
    if (!document?.createElement) throw new Error('Model setup requires a document.');
    const id = `yc-model-setup-${++instance}`;
    const node = (tag, text = '', className = '') => { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; };
    const card = node('section', '', 'yc-model-setup'); card.setAttribute('aria-label', 'Model connection setup');
    const heading = node('h3'), status = node('p', '', 'yc-model-setup-status'), services = node('ul', '', 'yc-model-setup-services');
    status.id = `${id}-status`; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const label = node('label', 'Available models', 'yc-model-setup-label'); label.htmlFor = `${id}-select`;
    const select = node('select', '', 'yc-model-setup-select'); select.id = label.htmlFor; select.setAttribute('aria-describedby', status.id);
    const defaultLabel = node('label', '', 'yc-model-setup-default-label'), makeDefault = node('input', '', 'yc-model-setup-default'); makeDefault.type = 'checkbox';
    defaultLabel.append(makeDefault, node('span', 'Use as default for new conversations'));
    const actions = node('div', '', 'yc-model-setup-actions');
    const button = (text, className, action) => { const item = node('button', text, className); item.type = 'button'; item.addEventListener('click', action); actions.appendChild(item); return item; };
    const choose = button('Use this model', 'yc-model-setup-use', apply);
    const settings = button('Connection settings', 'yc-model-setup-settings', () => run('settings', onOpenSettings));
    const refresh = button('Check again', 'yc-model-setup-refresh', () => run('refresh', onRefresh));
    const error = node('p', '', 'yc-model-setup-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    card.append(heading, status, services, label, select, defaultLabel, actions, error); host.appendChild(card);
    let state = summarize(), candidate = '', explicit = false, action = '', disposed = false, feedback = '', generation = 0;
    const usable = () => !disposed && host.isConnected !== false;
    const candidateModel = () => state.models.find(model => model.id === candidate && model.available && model.supported);
    function draw() {
      if (!usable()) return;
      card.dataset.state = state.status; card.setAttribute('aria-busy', String(Boolean(action || state.status === 'checking')));
      heading.textContent = state.heading;
      status.textContent = action === 'choose' ? 'Applying your selected model…' : action === 'refresh' ? 'Checking connections…' : feedback || state.message;
      services.replaceChildren();
      const labels = { checking: 'checking', offline: 'not connected', 'online-empty': 'connected · no models listed', online: 'connected' };
      for (const service of state.services) services.appendChild(node('li', `${service.label}: ${labels[service.status]}`));
      select.replaceChildren();
      const placeholder = node('option', 'Choose an available model'); placeholder.value = ''; select.appendChild(placeholder);
      for (const model of state.models) { const option = node('option', model.label + (!model.supported ? ' · Chat only' : '')); option.value = model.id; option.disabled = !model.available || !model.supported; select.appendChild(option); }
      if (candidate && !state.models.some(model => model.id === candidate)) { const missing = node('option', `${candidate} · unavailable`); missing.value = candidate; missing.disabled = true; select.appendChild(missing); }
      select.value = candidate;
      const locked = Boolean(action || state.busy);
      select.disabled = locked || !state.checked; makeDefault.disabled = locked || !candidateModel();
      choose.disabled = locked || !candidateModel() || typeof onChoose !== 'function';
      settings.disabled = locked || typeof onOpenSettings !== 'function'; refresh.disabled = locked || typeof onRefresh !== 'function';
    }
    select.addEventListener('change', () => {
      if (disposed || action || state.busy) { if (usable()) select.value = candidate; return; }
      candidate = select.value; explicit = true; feedback = ''; error.hidden = true; draw();
    });
    async function run(kind, callback, value) {
      if (!usable() || action || state.busy || typeof callback !== 'function') return;
      const targetGeneration = generation;
      action = kind; feedback = ''; error.hidden = true; error.textContent = ''; draw();
      try {
        await callback(value);
        if (usable() && targetGeneration === generation && kind === 'choose') feedback = value.makeDefault ? 'Model applied and saved as the default for new conversations.' : 'Model applied to this conversation.';
      } catch (failure) { if (usable() && targetGeneration === generation) { error.textContent = typeof failure?.message === 'string' ? failure.message.slice(0, 2000) : 'The action could not be completed. Try again.'; error.hidden = false; } }
      finally { action = ''; if (usable()) draw(); }
    }
    async function apply() {
      if (!candidateModel()) return;
      await run('choose', onChoose, { model: candidate, makeDefault: makeDefault.checked === true });
    }
    draw();
    return {
      update(next) { if (disposed) return; if (next.contextKey !== state.contextKey) { generation++; explicit = false; makeDefault.checked = false; error.hidden = true; error.textContent = ''; } state = next; if (!explicit) candidate = state.selectedModel; feedback = ''; draw(); },
      dispose() { disposed = true; card.remove(); },
    };
  }
  return Object.freeze({ summarize, create });
});
