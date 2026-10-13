'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const state = { missions: [], catalog: [], health: null, selected: null, busy: false, requestKey: null, requestSpec: null, automation: { enabled: false, running: false, cycles: 0 }, cycleRefreshPending: false };
  const labels = { 'text.analyze': 'Text analysis', 'data.profile': 'Data profiling', 'support.triage': 'Support triage' };
  const descriptions = {
    'text.analyze': 'Extract useful signals from text with deterministic analysis.',
    'data.profile': 'Inspect structured records and surface data quality signals.',
    'support.triage': 'Classify incoming support requests for consistent routing.',
  };
  const examples = {
    'text.analyze': { text: 'Our customers love the new dashboard. The support team is helpful.' },
    'data.profile': { rows: [{ name: 'Ada', score: 92 }, { name: 'Sam', score: 87 }] },
    'support.triage': { subject: 'Cannot access my account', body: 'I am unable to sign in after resetting my password.', customer_tier: 'standard' },
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function notice(message, kind = '') {
    $('notice').textContent = message;
    $('notice').className = `notice ${kind}`;
    $('notice').hidden = !message;
  }

  function pretty(value) { return JSON.stringify(value, null, 2); }
  function capabilityId(capability) { return typeof capability === 'string' ? capability : capability.id || capability.capability_id || capability.name; }
  function missionId(mission) { return mission.id || mission.mission_id; }
  function missionStatus(mission) { return String(mission.status || mission.state || 'unknown').toLowerCase(); }
  function titleFor(id) { return labels[id] || id; }
  function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
  function countValues(value) { return Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0; }

  async function request(command, args = {}) {
    if (!window.studio?.factory?.request) throw new Error('Open this console through the desktop app with npm run factory. The packaged desktop bridge is required.');
    const response = await window.studio.factory.request({ command, ...args });
    if (!response || response.ok !== true) throw new Error(`${response?.error?.code || 'FACTORY_ERROR'}: ${response?.error?.message || 'The factory returned no result.'}`);
    return response.result;
  }

  async function action(label, work) {
    if (state.busy) return;
    state.busy = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    renderAutomation();
    notice(label, 'pending');
    try { await work(); }
    catch (error) { notice(errorMessage(error), 'error'); }
    finally {
      state.busy = false;
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
      setMissionActions();
      renderAutomation();
      refreshAfterCycle();
    }
  }

  function statusBadge(status) {
    const kind = ['committed', 'completed', 'ready'].includes(status) ? 'success' : ['failed', 'rejected', 'cancelled', 'canceled'].includes(status) ? 'failure' : ['queued', 'pending', 'running', 'validating', 'building'].includes(status) ? 'warning' : '';
    return element('span', `badge ${kind}`, status.replaceAll('_', ' '));
  }

  function renderMissions() {
    const body = $('missions');
    body.replaceChildren();
    const missions = [...state.missions].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    $('queue-count').textContent = missions.length;
    $('queue-empty').hidden = missions.length > 0;
    $('metric-total').textContent = missions.length;
    $('metric-queued').textContent = missions.filter(mission => ['queued', 'pending', 'submitted'].includes(missionStatus(mission))).length;
    $('metric-committed').textContent = missions.filter(mission => ['committed', 'completed'].includes(missionStatus(mission))).length;
    for (const mission of missions) {
      const id = missionId(mission);
      const row = element('tr', state.selected && missionId(state.selected) === id ? 'selected-row' : '');
      const identity = element('td');
      identity.append(element('span', 'mission-name', mission.spec?.name || mission.name || 'Untitled mission'), element('span', 'mission-code', id));
      const status = element('td'); status.append(statusBadge(missionStatus(mission)));
      const created = mission.created_at ? new Date(mission.created_at) : null;
      const date = element('td', '', created && !Number.isNaN(created.getTime()) ? created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
      const actions = element('td');
      const button = element('button', 'row-button', '↗');
      button.type = 'button';
      button.setAttribute('aria-label', `Inspect ${mission.spec?.name || id}`);
      button.addEventListener('click', () => action('Loading mission evidence…', async () => { await inspectMission(id); notice('Mission evidence refreshed.'); }));
      actions.append(button);
      row.append(identity, status, date, actions);
      body.append(row);
    }
  }

  function renderCatalog() {
    $('catalog').replaceChildren();
    const selected = new Set([...document.querySelectorAll('input[name="capability"]:checked')].map(input => input.value));
    $('capability-choices').replaceChildren();
    $('metric-capabilities').textContent = state.catalog.length;
    state.catalog.forEach((capability, index) => {
      const id = capabilityId(capability);
      const title = titleFor(id);
      const card = element('article', 'capability-card');
      card.append(element('div', 'capability-symbol', ['≋', '▥', '◎'][index % 3]), element('h3', '', title), element('p', '', capability.description || descriptions[id] || 'Contract-bound executable capability.'), element('span', 'capability-id', id));
      $('catalog').append(card);
      const label = element('label', 'capability-choice');
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'capability'; input.value = id; input.checked = selected.has(id);
      label.append(input, element('span', '', title), element('span', '', '↗'));
      $('capability-choices').append(label);
    });
    if (!state.catalog.length) $('catalog').append(element('p', 'helper', 'No executable capabilities were returned by the runtime.'));
  }

  function renderHealth() {
    const health = state.health;
    $('connection-label').textContent = health ? (health.status === 'ready' ? 'Local runtime ready' : `Runtime ${health.status || 'connected'}`) : 'Runtime unavailable';
    $('connection-dot').className = `status-dot ${!health ? 'offline' : health.status === 'ready' ? '' : 'pending'}`;
    $('health-json').textContent = pretty(health || { status: 'unavailable' });
    const gates = $('release-gates'); gates.replaceChildren();
    const entries = Array.isArray(health?.release_gates) ? health.release_gates : Object.entries(health?.release_gates || {}).map(([name, value]) => ({ name, ...(typeof value === 'object' && value ? value : { status: value }) }));
    for (const item of entries) {
      const gate = typeof item === 'string' ? { name: item, status: 'pending' } : item;
      const passed = gate.passed === true || gate.ready === true || gate.status === true || ['pass', 'passed', 'ready', 'verified', 'complete'].includes(gate.status);
      const row = element('div', 'release-gate');
      const copy = element('div', 'gate-copy', gate.name || gate.id || gate.gate || 'Release check');
      copy.append(element('small', '', gate.message || gate.detail || gate.reason || (passed ? 'Verified by the local runtime' : 'Evidence still required')));
      row.append(element('span', `gate-symbol ${passed ? 'pass' : ''}`, passed ? '✓' : '·'), copy); gates.append(row);
    }
    if (!entries.length) gates.append(element('p', 'helper', health ? 'No release checks reported. Readiness is not established.' : 'Connect the local runtime to inspect release evidence.'));
  }

  async function refresh() {
    // Independent reads share the same governed runtime; they do not execute missions.
    let health, catalog, missions;
    try { [health, catalog, missions] = await Promise.all([request('health'), request('catalog'), request('list')]); }
    catch (error) { state.health = null; renderHealth(); throw error; }
    state.health = health;
    state.catalog = Array.isArray(catalog) ? catalog : catalog.capabilities || [];
    state.missions = Array.isArray(missions) ? missions : missions.missions || [];
    renderHealth(); renderCatalog(); renderMissions();
  }

  function renderAutomation() {
    const status = state.automation;
    const active = status.enabled || status.running;
    $('automation-start').disabled = state.busy || active;
    $('automation-stop').disabled = !status.enabled;
    $('automation-cycles').disabled = active;
    $('automation-interval').disabled = active;
    $('process-queue').disabled = state.busy || active;
    const label = $('automation-status');
    label.dataset.enabled = String(Boolean(status.enabled));
    label.dataset.running = String(Boolean(status.running));
    label.dataset.cycles = String(status.cycles || 0);
    const progress = `${status.cycles || 0}/${status.max_cycles || 0} cycles`;
    label.textContent = status.error ? `Stopped after error · ${status.error.message}`
      : status.running ? `${status.enabled ? 'Processing' : 'Stopping after current cycle'} · ${progress}`
      : status.enabled ? `Active · ${progress} · next ${new Date(status.next_cycle_at).toLocaleTimeString()}`
      : status.max_cycles && status.cycles >= status.max_cycles ? `Cycle budget reached · ${progress}`
      : `Stopped${status.cycles ? ` · ${progress}` : ' · starts only when you choose'}`;
  }

  function refreshAfterCycle() {
    if (state.busy || !state.cycleRefreshPending) return;
    state.cycleRefreshPending = false;
    action('Refreshing the completed queue cycle…', async () => {
      await refresh();
      if (state.selected) await inspectMission(missionId(state.selected));
      if (state.automation.error) notice(`Continuous processing stopped: ${state.automation.error.message}`, 'error');
      else notice(`Continuous queue completed ${state.automation.cycles} cycle${state.automation.cycles === 1 ? '' : 's'}. Mission outcomes are refreshed below.`);
    });
  }

  function receiveAutomation(status) {
    if (!status || typeof status.enabled !== 'boolean') return;
    const previousCycles = state.automation.cycles || 0;
    state.automation = status;
    renderAutomation();
    if ((status.cycles || 0) > previousCycles) { state.cycleRefreshPending = true; refreshAfterCycle(); }
  }

  async function refreshSources() {
    const result = await request('sources', { query: $('source-query').value.trim(), limit: 8 });
    $('source-readiness').replaceChildren();
    for (const source of result.sources || []) {
      const row = element('div', 'source-record');
      const copy = element('div', '', String(source.id || 'Source').replaceAll('-', ' '));
      copy.append(element('small', '', source.available ? 'Evidence available · review required' : 'Evidence incomplete'));
      row.title = source.path || '';
      row.append(element('span', `status-dot ${source.available ? '' : 'pending'}`), copy);
      $('source-readiness').append(row);
    }
    $('source-matches').replaceChildren();
    for (const match of result.catalog_matches || []) {
      const card = element('article', 'source-match');
      card.append(element('h3', '', match.name || match.entry_id || 'Catalog entry'), element('p', '', [match.industry, match.workflow, match.kind].filter(Boolean).join(' · ')), element('div', 'mono', match.selection_reason || 'Catalog metadata match'));
      $('source-matches').append(card);
    }
    if (!result.configured) $('source-readiness').append(element('p', 'helper', result.instruction || 'No ecosystem source root is configured.'));
    else if (!result.catalog_matches?.length) $('source-matches').append(element('p', 'helper', 'No catalog entries matched this search.'));
    $('source-note').textContent = result.configured ? `${result.catalog_entries ?? 0} catalog entries indexed. Discovery provides evidence for review; executable admission requires capability binding and validated outcomes.` : 'Connect the existing ecosystem root through local runtime configuration to discover its source evidence.';
  }

  function evidenceRow(label, value) {
    const row = element('div', 'evidence-stat');
    row.append(element('span', '', label), element('strong', '', value ?? 'Not available'));
    return row;
  }

  function setMissionActions() {
    const committed = state.selected && ['committed', 'completed'].includes(missionStatus(state.selected));
    $('run-specialist').disabled = state.busy || !committed;
    $('export-agent').disabled = state.busy || !committed;
    $('cancel-mission').disabled = state.busy || !state.selected || ['committed', 'completed', 'failed', 'cancelled', 'canceled', 'rejected'].includes(missionStatus(state.selected));
  }

  async function inspectMission(id) {
    state.selected = await request('inspect', { mission_id: id });
    const mission = state.selected;
    $('mission-detail').hidden = false;
    $('detail-name').textContent = mission.spec?.name || mission.name || 'Mission details';
    $('detail-id').textContent = missionId(mission);
    $('detail-summary').replaceChildren(statusBadge(missionStatus(mission)), element('p', '', mission.spec?.description || ''));
    $('detail-json').textContent = pretty(mission);
    const artifact = mission.artifact || mission.data?.artifact || {};
    const candidates = mission.candidates || mission.data?.candidates || [];
    const events = mission.events || [];
    $('evidence-summary').replaceChildren(
      evidenceRow('Candidate records', countValues(candidates)),
      evidenceRow('Provenance events', countValues(events)),
      evidenceRow('Committed artifact digest', artifact.digest || artifact.sha256 || mission.data?.artifact_digest),
      evidenceRow('Validation', artifact.validation?.status || (artifact.validation?.passed === true ? 'Passed' : artifact.validation ? 'Inspect validation evidence below' : 'Not yet available')),
      evidenceRow('Selection evidence', artifact.selection?.reason || artifact.selection?.rationale || (artifact.selection ? 'Recorded in mission evidence' : 'Not yet available')),
    );
    $('run-capability').replaceChildren();
    const capabilities = mission.spec?.capabilities || [];
    capabilities.forEach(capability => { const id = capabilityId(capability); const option = element('option', '', titleFor(id)); option.value = id; $('run-capability').append(option); });
    updateRunExample();
    $('run-output').hidden = true;
    renderMissions(); setMissionActions();
  }

  function updateRunExample() {
    const id = $('run-capability').value;
    const metadata = state.catalog.find(capability => capabilityId(capability) === id);
    $('run-input').value = pretty(metadata?.example_input || metadata?.example || examples[id] || {});
  }

  $('focus-mission').addEventListener('click', () => { $('mission-name').focus(); $('mission-name').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('automation-start').addEventListener('click', () => action('Starting bounded continuous processing…', async () => {
    receiveAutomation(await request('automation', { enabled: true, max_cycles: Number($('automation-cycles').value), interval_seconds: Number($('automation-interval').value) }));
    notice('Continuous processing started. The desktop will run one mission per cycle within your selected limit.');
  }));
  $('automation-stop').addEventListener('click', async () => {
    $('automation-stop').disabled = true;
    try {
      receiveAutomation(await request('automation', { enabled: false, max_cycles: Number($('automation-cycles').value), interval_seconds: Number($('automation-interval').value) }));
      notice(state.automation.running ? 'Stopping after the current bounded cycle finishes.' : 'Continuous processing stopped.');
    } catch (error) { notice(errorMessage(error), 'error'); renderAutomation(); }
  });
  $('source-search').addEventListener('submit', event => { event.preventDefault(); action('Inspecting source identity and catalog metadata…', async () => { await refreshSources(); notice('Source evidence refreshed. Catalog entries remain subject to capability admission.'); }); });
  $('refresh').addEventListener('click', () => action('Refreshing factory state…', async () => { await refresh(); if (state.selected) await inspectMission(missionId(state.selected)); notice('Factory state refreshed.'); }));
  $('open-editor').addEventListener('click', () => action('Opening Studio editor…', async () => { if (!window.studio?.factory?.openEditor) throw new Error('The packaged desktop bridge is required.'); await window.studio.factory.openEditor(); notice('Studio editor opened.'); }));
  $('mission-form').addEventListener('submit', event => {
    event.preventDefault();
    action('Submitting your specialist mission…', async () => {
      const capabilities = [...document.querySelectorAll('input[name="capability"]:checked')].map(input => input.value);
      if (!capabilities.length) throw new Error('Choose at least one capability for your specialist.');
      const spec = { name: $('mission-name').value.trim(), description: $('mission-description').value.trim(), capabilities };
      const fingerprint = pretty(spec);
      if (state.requestSpec !== fingerprint) { state.requestSpec = fingerprint; state.requestKey = crypto.randomUUID(); }
      const mission = await request('submit', { spec, idempotency_key: state.requestKey });
      // Retain this key until the spec changes, including after a timeout or reload-free retry.
      await refresh();
      if (missionId(mission)) await inspectMission(missionId(mission));
      notice('Mission created. Process the queue to build, validate, and commit its specialist package.');
    });
  });
  $('process-queue').addEventListener('click', () => action('Building candidates and validating outcomes…', async () => {
    const result = await request('process', { max_missions: Number($('batch-size').value) });
    await refresh();
    const processed = Array.isArray(result.processed) ? result.processed : [];
    if (state.selected) await inspectMission(missionId(state.selected));
    else if (processed.length) await inspectMission(typeof processed[0] === 'string' ? processed[0] : missionId(processed[0]));
    notice(`Queue pass finished. ${processed.length} mission${processed.length === 1 ? '' : 's'} processed; ${result.remaining ?? 'unknown'} remaining. Inspect each mission for its outcome.`);
  }));
  $('cancel-mission').addEventListener('click', () => action('Cancelling mission…', async () => {
    const id = missionId(state.selected); await request('cancel', { mission_id: id }); await refresh(); await inspectMission(id); notice('Mission cancellation recorded.');
  }));
  $('run-capability').addEventListener('change', updateRunExample);
  $('run-specialist').addEventListener('click', () => action('Executing the committed specialist…', async () => {
    let input;
    try { input = JSON.parse($('run-input').value); } catch { throw new Error('Input must be valid JSON.'); }
    const output = await request('run', { mission_id: missionId(state.selected), capability_id: $('run-capability').value, input });
    $('run-output').textContent = pretty(output); $('run-output').hidden = false; notice('Specialist execution finished. The result is shown below.');
  }));
  $('export-agent').addEventListener('click', () => action('Exporting the committed package…', async () => {
    const result = await request('export', { mission_id: missionId(state.selected) });
    $('run-output').textContent = pretty(result); $('run-output').hidden = false; notice('Package export finished. Artifact location and integrity information are shown below.');
  }));
  document.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-detail]').forEach(tab => tab.classList.toggle('active', tab === button));
    $('detail-evidence').hidden = button.dataset.detail !== 'evidence'; $('detail-run').hidden = button.dataset.detail !== 'run';
  }));
  const unsubscribeAutomation = window.studio?.factory?.onAutomationState?.(receiveAutomation);
  window.addEventListener('beforeunload', () => { if (unsubscribeAutomation) unsubscribeAutomation(); });
  action('Connecting to your local factory…', async () => {
    await refresh();
    receiveAutomation(await request('automation_status'));
    try { await refreshSources(); notice(''); }
    catch (error) { notice(`Factory connected. Source evidence could not be refreshed: ${errorMessage(error)}`, 'error'); }
  });
})();
