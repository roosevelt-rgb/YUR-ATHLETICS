/* A view of the host-owned runtime setup; it never starts work or controls a process. */
'use strict';
(() => {
  const active = new Set(['accepted', 'starting', 'ready', 'releasing', 'uncertain']);
  const labels = { accepted: 'Preparation accepted', starting: 'Preparing the selected runtime', ready: 'Runtime ready', releasing: 'Releasing the owned hold', released: 'Owned hold released', failed: 'Preparation failed', uncertain: 'Preparation state needs inspection', expired: 'Owned hold expired and exited' };
  const node = (tag, text = '', id = '') => { const item = document.createElement(tag); item.textContent = text; if (id) item.id = id; return item; };
  function create(host, { api, saveSelection = async () => {}, now = () => Date.now(), uuid = () => crypto.randomUUID() } = {}) {
    host.id = 'yc-execution-runtime'; host.className = 'yc-detail-card yc-execution-runtime'; host.tabIndex = -1;
    const heading = node('h3', 'Execution runtime');
    const introduction = node('p', 'Python checks and generated Python specialists use a verified local WSL 2 runtime. Model connections and file-reading tools are separate.');
    const label = node('label', 'Installed runtime'); label.className = 'yc-field'; label.htmlFor = 'yc-execution-distro';
    const select = node('select', '', 'yc-execution-distro'); label.appendChild(select);
    const source = node('p', '', 'yc-execution-source'); source.className = 'yc-work-note';
    const status = node('p', '', 'yc-execution-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const buttons = node('div'); buttons.className = 'yc-execution-actions';
    const button = (id, text, action) => { const item = node('button', text, id); item.type = 'button'; item.addEventListener('click', action); buttons.appendChild(item); return item; };
    const checkButton = button('yc-execution-check', 'Check runtime', check);
    const prepareButton = button('yc-execution-prepare', 'Prepare for 15 minutes', prepare);
    const inspectButton = button('yc-execution-inspect', 'Inspect current setup', inspect);
    const releaseButton = button('yc-execution-release', 'Release owned hold', release);
    const lifetime = node('p', '', 'yc-execution-expiry'); lifetime.className = 'yc-work-note';
    const notice = node('p', 'Prepare is an explicit local action. It may start the selected existing runtime and holds it for at most 15 minutes. Release ends only this hold; it does not shut down the distribution. No mission is retried.'); notice.className = 'yc-work-note';
    const details = node('details'); const receipt = node('pre', '', 'yc-execution-receipt'); receipt.className = 'yc-work-preview'; details.append(node('summary', 'Runtime identity and receipts'), receipt);
    host.replaceChildren(heading, introduction, label, source, status, buttons, lifetime, notice, details);
    let disposed = false, busy = '', message = '', observation = null, setup = null, retainedReceipt = null, operationId = null, uncertain = false, expiryTimer = null, latestCheck = false;
    const usable = () => !disposed && host.isConnected !== false;
    const currentResource = () => observation?.resources.find(item => item.resource_id === observation.selected_resource_id);
    const ownActive = () => uncertain || (setup && active.has(setup.state));
    function draw() {
      if (!usable()) return;
      clearTimeout(expiryTimer);
      const resources = observation?.resources || (setup ? [{ resource_id: setup.resource_id, distro: setup.distro, state: null }] : []);
      const selectedValue = observation?.selected_resource_id || setup?.resource_id || '';
      select.replaceChildren();
      if (!resources.length) { const empty = node('option', 'Check to list installed runtimes'); empty.value = ''; select.appendChild(empty); }
      for (const item of resources) { const option = node('option', item.distro + (item.state ? ` · ${item.state}` : ' · retained setup')); option.value = item.resource_id; select.appendChild(option); }
      select.value = selectedValue;
      const configurationSource = observation?.configuration_source || setup?.check?.configuration_source;
      const locked = configurationSource === 'environment';
      select.disabled = Boolean(busy || ownActive() || locked || !observation?.resources.length);
      source.textContent = locked ? 'Selected by YUR_EXECUTION_DISTRO. The environment setting takes precedence.' : configurationSource === 'settings' ? 'Saved runtime preference. Selection alone grants no execution authority.' : 'Choose a listed runtime to save it as your preference.';
      const fresh = observation && Date.parse(observation.expires_at) > now();
      const preferCheck = observation && (!setup || (!active.has(setup.state) && latestCheck));
      checkButton.disabled = Boolean(busy || disposed || ownActive() || !api?.check);
      prepareButton.disabled = Boolean(busy || !api?.prepare || ownActive() || !fresh || !observation?.check_token || !['ready', 'stopped'].includes(observation?.status));
      prepareButton.textContent = observation?.status === 'ready' ? 'Keep ready for 15 minutes' : 'Prepare for 15 minutes';
      inspectButton.disabled = Boolean(busy || !operationId);
      releaseButton.disabled = Boolean(busy || !operationId || !ownActive());
      host.dataset.operationId = operationId || '';
      host.dataset.state = uncertain ? 'uncertain' : preferCheck ? observation.status : setup?.state || observation?.status || 'unchecked';
      if (busy) status.textContent = busy;
      else if (message) status.textContent = message;
      else if (uncertain) status.textContent = 'The acknowledgment is uncertain. Inspect this same operation before taking another action.';
      else if (setup && !preferCheck) status.textContent = labels[setup.state] + (setup.evidence?.error?.message ? ': ' + setup.evidence.error.message : '');
      else if (!observation) status.textContent = 'Not checked. No runtime has been prepared here.';
      else {
        const names = { ready: 'The selected runtime passed verification. No hold has been started for this check.', stopped: 'The selected installed runtime is stopped.', mismatch: 'The selected runtime did not match the supported environment.', unknown: 'Runtime availability is undetermined by this check.' };
        status.textContent = (names[observation.status] || 'Check unavailable.') + (observation.diagnostics?.message ? ' ' + observation.diagnostics.message : '') + (!fresh && observation.check_token ? ' Check again before preparing.' : '');
      }
      lifetime.textContent = setup ? `${active.has(setup.state) ? 'Hold deadline' : 'Previous setup hold deadline'}: ${new Date(setup.expires_at).toLocaleString()}. ${setup.evidence?.started_by_this_setup === true ? 'A start was attempted from the observed stopped state.' : setup.evidence?.started_by_this_setup === false ? 'The runtime was already running at that setup’s check.' : 'Runtime start has not been confirmed.'}${active.has(setup.state) && Date.parse(setup.expires_at) <= now() ? ' The deadline has passed; inspect the retained state.' : ''}` : '';
      const facts = {};
      if (observation) facts.latest_check = { status: observation.status, checked_at: observation.checked_at, expires_at: observation.expires_at, selected: currentResource() || null, configuration_source: observation.configuration_source, runtime: observation.runtime, diagnostics: observation.diagnostics };
      if (setup) facts.retained_setup = { operation_id: setup.operation_id, state: setup.state, resource_id: setup.resource_id, distro: setup.distro, revision: setup.revision, expires_at: setup.expires_at, started_by_this_setup: setup.evidence?.started_by_this_setup, owned_process_exit_confirmed: setup.evidence?.owned_process_exit_confirmed, runtime_at_verification: setup.evidence?.runtime, release_reason: setup.evidence?.release_reason };
      if (retainedReceipt) facts.receipt = retainedReceipt;
      receipt.textContent = Object.keys(facts).length ? JSON.stringify(facts, null, 2) : 'No runtime check or setup receipt is available in this view.';
      if (fresh && observation?.check_token) expiryTimer = setTimeout(draw, Math.min(120001, Date.parse(observation.expires_at) - now() + 1));
    }
    function merge(result) {
      const incoming = result?.setup;
      if (!incoming) return;
      if (operationId && incoming.operation_id !== operationId) return;
      if (setup && setup.operation_id === incoming.operation_id && incoming.revision < setup.revision) return;
      if (!setup || incoming.revision > setup.revision) latestCheck = false;
      operationId = incoming.operation_id; setup = incoming; retainedReceipt = result.receipt || retainedReceipt;
      uncertain = incoming.state === 'uncertain';
    }
    async function perform(labelText, action, accept) {
      if (busy || !usable()) return;
      busy = labelText; message = ''; draw();
      try {
        const response = await action(); if (!usable()) return;
        if (!response?.ok) throw new Error(response?.error?.message || 'The runtime request was not acknowledged.');
        accept(response.result);
      } catch (error) { if (usable()) message = error.message; }
      finally { busy = ''; draw(); }
    }
    async function check() {
      if (!api?.check) return;
      await perform('Checking the selected installed runtime…', () => api.check({ resource_id: observation?.selected_resource_id || null }), result => {
        observation = result.check; latestCheck = true;
        if (observation.active_setup) { operationId = observation.active_setup.operation_id; merge({ setup: observation.active_setup }); }
      });
    }
    async function prepare() {
      if (prepareButton.disabled || !usable()) return;
      operationId = uuid(); setup = null; retainedReceipt = null; uncertain = true;
      const request = { operation_id: operationId, resource_id: observation.selected_resource_id, check_token: observation.check_token };
      observation = { ...observation, check_token: null };
      await perform('Preparing the checked runtime…', () => api.prepare(request), result => { merge(result); });
    }
    async function inspect() {
      await perform('Reading the retained setup receipt…', () => api.inspect({ operation_id: operationId }), result => {
        if (result.setup) merge(result);
        else { setup = null; retainedReceipt = null; operationId = null; uncertain = false; message = 'No committed setup was found. Check the runtime before any new preparation.'; }
      });
    }
    async function release() {
      if (releaseButton.disabled || !operationId) return;
      uncertain = true;
      await perform('Releasing this setup’s owned hold…', () => api.release({ operation_id: operationId }), result => {
        if (result.setup) merge(result);
        else { setup = null; retainedReceipt = null; operationId = null; uncertain = false; message = 'No committed setup was found for this operation. No release was claimed.'; }
      });
    }
    select.addEventListener('change', async () => {
      if (select.disabled || !usable()) return;
      const resource = observation?.resources.find(item => item.resource_id === select.value); if (!resource) return;
      await perform('Saving and checking the selected runtime…', async () => {
        await saveSelection(resource.distro);
        return api.check({ resource_id: resource.resource_id });
      }, result => { observation = result.check; latestCheck = true; if (observation.active_setup) { operationId = observation.active_setup.operation_id; merge({ setup: observation.active_setup }); } });
    });
    const unsubscribe = api?.onEvent?.(event => {
      if (!usable() || event?.type !== 'state' || (operationId && event.operation_id !== operationId)) return;
      if (!operationId) operationId = event.operation_id;
      merge({ setup: event.setup, receipt: event.receipt }); message = ''; draw();
    });
    draw();
    if (!api?.inspect) { message = 'Runtime preparation requires the updated Desktop runtime.'; checkButton.disabled = prepareButton.disabled = true; draw(); }
    else void inspect(); // Read an existing main-owned operation only; never Check or Prepare on mount.
    return { dispose() { disposed = true; clearTimeout(expiryTimer); unsubscribe?.(); }, focus() { host.focus?.(); host.scrollIntoView?.({ block: 'nearest' }); } };
  }
  window.yurExecutionRuntimeView = { create };
})();
