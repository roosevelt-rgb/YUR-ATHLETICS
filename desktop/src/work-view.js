/* Presentation of committed work records. The existing Work manager owns state. */
'use strict';
(() => {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  function text(tag, value, className = '') {
    const node = document.createElement(tag); node.textContent = String(value ?? ''); if (className) node.className = className; return node;
  }
  function reference(mission) {
    const record = {};
    for (const key of ['request_id', 'conversation_id', 'status', 'revision']) if (mission[key] !== undefined) record[key] = mission[key];
    record.mission_id = mission.id;
    if (mission.receipt && typeof mission.receipt === 'object') record.receipt = Object.fromEntries(Object.entries(mission.receipt).filter(([key, value]) => key !== 'data' && (typeof value === 'string' || typeof value === 'number')));
    return record;
  }
  const steeringLabels = { submitting: 'Submitting correction', uncertain: 'Correction status unconfirmed', queued: 'Queued for the next checkpoint', consumed: 'Applied to the mission', not_consumed: 'Not consumed by the mission', not_queued: 'Not queued — mission ended' };
  function mergeSteering(current, update) {
    if (!current || !update || current.correction_id !== update.correction_id || (update.text !== undefined && update.text !== current.text)) throw new Error('Correction identity or text differs from the submitted request.');
    if (!['queued', 'consumed', 'not_consumed'].includes(update.status)) throw new Error('Invalid correction state.');
    const receipt = update.consumed_receipt || update.queued_receipt || update.receipt;
    if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.hash || '') || !Number.isInteger(receipt.revision)) throw new Error('Correction has no valid committed receipt.');
    if (current.status === 'consumed' || (current.status === 'not_consumed' && update.status === 'queued')) return { ...current, queued_receipt: current.queued_receipt || update.queued_receipt || null, consumed_receipt: current.consumed_receipt || update.consumed_receipt || null };
    if ((current.observed_revision || 0) > receipt.revision && !['consumed', 'not_consumed'].includes(update.status)) return current;
    return { ...current, ...update, text: current.text, observed_revision: Math.max(current.observed_revision || 0, receipt.revision), ...(update.receipt ? { last_receipt: update.receipt } : {}) };
  }
  function preview(value, max = 64000) {
    const source = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const node = text('pre', (source || '').slice(0, max), 'yc-work-preview');
    if (source?.length > max) node.appendChild(document.createTextNode('\n\n[Preview limited to ' + max + ' characters.]'));
    return node;
  }
  const diagnosticPhases = { wsl_status: 'Runtime status query', runtime_selection: 'Runtime selection', runtime_verification: 'Runtime verification' };
  const diagnosticOutcomes = new Set(['timeout', 'os_error', 'nonzero_exit', 'output_limit', 'selected_not_running', 'invalid_selection', 'ambiguous_selection', 'malformed_response', 'fingerprint_mismatch']);
  function safeDiagnostic(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const safe = { schema: value.schema };
    const count = item => Number.isSafeInteger(item) && item >= 0;
    if (value.schema === 'yur.execution-diagnostic.v1') {
      if (!Object.hasOwn(diagnosticPhases, value.phase) || !diagnosticOutcomes.has(value.outcome)) return null;
      safe.phase = value.phase; safe.outcome = value.outcome;
      if (typeof value.timeout_seconds === 'number' && Number.isFinite(value.timeout_seconds) && value.timeout_seconds > 0 && value.timeout_seconds <= 3600) safe.timeout_seconds = value.timeout_seconds;
      for (const key of ['errno', 'winerror', 'returncode']) if (Number.isInteger(value[key]) && value[key] >= -(2 ** 31) && value[key] <= 2 ** 32 - 1) safe[key] = value[key];
      for (const key of ['stdout_bytes', 'stderr_bytes']) if (count(value[key])) safe[key] = value[key];
      for (const key of ['stdout_sha256', 'stderr_sha256']) if (digest(value[key])) safe[key] = value[key];
      const name = item => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item);
      if (name(value.selected_distro)) safe.selected_distro = value.selected_distro;
      if (Array.isArray(value.running_distros) && value.running_distros.length <= 32 && value.running_distros.every(name)) safe.running_distros = [...value.running_distros];
      if (typeof value.running_distros_truncated === 'boolean') safe.running_distros_truncated = value.running_distros_truncated;
    } else if (value.schema === 'yur.work-provider-diagnostic.v1') {
      if (value.provider !== 'ollama' || value.outcome !== 'empty_response' || !['stop', 'length', 'load', 'unload', 'missing', 'other'].includes(value.done_reason)) return null;
      safe.provider = value.provider; safe.outcome = value.outcome; safe.done_reason = value.done_reason;
      for (const key of ['content_chars', 'thinking_chars', 'tool_call_count', 'eval_count', 'prompt_eval_count']) if (count(value[key])) safe[key] = value[key];
    } else return null;
    return safe;
  }
  function failureDetail(record, mission, options = {}) {
    if (mission.status !== 'failed' || !Array.isArray(record.events)) return null;
    const event = record.events.filter(item => item?.event_type === 'work.failed').at(-1);
    const diagnostic = safeDiagnostic(event?.change?.diagnostics);
    if (!diagnostic) return null;
    let title, explanation;
    if (diagnostic.schema === 'yur.work-provider-diagnostic.v1') {
      title = 'Model returned no usable answer or tool call';
      explanation = `Ollama reported the response end reason: ${diagnostic.done_reason}.`;
    } else {
      const phase = diagnosticPhases[diagnostic.phase];
      const duration = diagnostic.timeout_seconds === undefined ? 'within its time limit' : `within ${diagnostic.timeout_seconds} seconds`;
      const descriptions = {
        timeout: [`${phase} timed out`, `${phase} did not finish ${duration}.${diagnostic.phase === 'wsl_status' ? ' Runtime availability remains undetermined by this check.' : ''}`],
        os_error: [`${phase} failed`, 'The operating system reported an error during this check. Recorded error codes are available below.'],
        nonzero_exit: [`${phase} returned an error`, `The check exited${diagnostic.returncode === undefined ? ' with a nonzero code' : ` with code ${diagnostic.returncode}`}.`],
        output_limit: [`${phase} exceeded its output limit`, 'The check returned more output than its diagnostic limit permits.'],
        selected_not_running: ['Selected runtime is not running', `${diagnostic.selected_distro || 'The selected distribution'} was absent from the recorded list of running WSL distributions.`],
        invalid_selection: ['Runtime selection was rejected', 'The configured distribution identifier was not accepted.'],
        ambiguous_selection: ['Runtime selection is unresolved', 'The recorded selection did not identify one eligible distribution.'],
        malformed_response: ['Runtime verification response was unreadable', 'The returned verification response did not satisfy the expected format.'],
        fingerprint_mismatch: ['Runtime verification did not match', 'The recorded runtime verification did not match the required environment.'],
      };
      [title, explanation] = descriptions[diagnostic.outcome];
    }
    const card = text('section', '', 'yc-detail-card yc-work-failure');
    card.append(text('h4', title, 'yc-work-failure-title'), text('p', explanation, 'yc-work-failure-explanation'));
    const details = document.createElement('details'); details.className = 'yc-work-failure-evidence';
    details.append(text('summary', 'Recorded diagnostic details'), preview({ ...diagnostic, ...(digest(event.hash) ? { failure_receipt: event.hash } : {}) })); card.appendChild(details);
    if (diagnostic.schema === 'yur.execution-diagnostic.v1' && typeof options.onOpenExecutionSettings === 'function') {
      const open = text('button', 'Open execution settings', 'yc-open-execution-settings'); open.type = 'button';
      open.addEventListener('click', () => options.onOpenExecutionSettings()); card.appendChild(open);
    }
    return card;
  }
  function eventPreview(event) {
    const result = { ...event, data: undefined };
    if (event.change && Object.hasOwn(event.change, 'diagnostics')) result.change = { ...event.change, diagnostics: safeDiagnostic(event.change.diagnostics) || undefined };
    return result;
  }
  function deliverySummary(plan = {}, verifiedSha = null) {
    const section = document.createElement('div');
    section.append(text('p', 'Destination', 'yc-work-note'), text('p', plan.path || 'Destination unavailable', 'yc-work-destination'));
    if (plan.bytes !== undefined) section.appendChild(text('p', Number(plan.bytes).toLocaleString() + ' bytes'));
    const technical = document.createElement('details'); technical.append(text('summary', 'Technical details'), preview({ before_sha256: plan.before_sha256, after_sha256: plan.after_sha256, ...(verifiedSha ? { verified_sha256: verifiedSha } : {}) }));
    section.appendChild(technical); return section;
  }
  const capabilityNames = { 'text.analyze': 'Text analysis', 'data.profile': 'Data profiling', 'support.triage': 'Support triage', 'workforce.hatch.quantity': 'Quantity takeoff', 'construction.opc.inspect': 'Construction quote inspection' };
  function renderConstruction(output) {
    if (!output || output.method !== 'quoted_opc_rows' || output.assessment !== 'quoted_arithmetic_only' || !Array.isArray(output.line_items) || !Array.isArray(output.excluded)) return null;
    const host = text('section', '', 'yc-construction-result');
    const rows = output.line_items.slice(0, 100), mismatches = rows.filter(row => row.arithmetic === 'mismatch').length;
    host.append(text('p', `${rows.length} quoted ${rows.length === 1 ? 'line' : 'lines'} · ${mismatches} arithmetic ${mismatches === 1 ? 'mismatch' : 'mismatches'}`, 'yc-construction-summary'),
      text('p', 'Quoted arithmetic only. Quantities and prices come from the supplied text. Market rates, scope completeness and approvals were not assessed.', 'yc-work-note'));
    if (output.requires_review) host.appendChild(text('p', 'Review flagged or unrecognized source content before relying on these rows.', 'yc-construction-review'));
    if (output.truncated || output.omitted_count > 0 || output.line_items.length > rows.length) host.appendChild(text('p', `Limited result: ${output.omitted_count ?? 'unreported'} records omitted by the inspector; showing ${rows.length} of ${output.line_items.length} returned lines.`, 'yc-construction-review'));
    const labels = { item_number: 'Item', description: 'Description', quantity: 'Quantity', unit: 'Unit', unit_price: 'Unit price', stated_total: 'Stated total' };
    for (const row of rows) {
      const item = text('article', '', 'yc-construction-row'); item.dataset.arithmetic = row.arithmetic; item.dataset.itemNumber = row.item_number;
      item.append(text('h5', `${row.item_number} · ${row.description}`), text('p', row.arithmetic === 'mismatch' ? 'Arithmetic mismatch' : row.arithmetic === 'consistent' ? 'Arithmetic consistent' : 'Arithmetic status unavailable', 'yc-construction-status'), text('p', `${row.quantity} ${row.unit} × ${row.unit_price} per ${row.unit}`, 'yc-construction-calculation'));
      const amounts = text('dl', '', 'yc-construction-amounts');
      for (const [label, value] of [['Stated', row.stated_total], ['Calculated', row.calculated_total], ['Difference', row.difference]]) { const pair = document.createElement('div'); pair.append(text('dt', label), text('dd', value)); amounts.appendChild(pair); }
      item.appendChild(amounts);
      const quotes = document.createElement('details'); quotes.className = 'yc-construction-quotes'; quotes.appendChild(text('summary', 'Exact source quotes'));
      for (const [field, label] of Object.entries(labels)) {
        const source = row.sources?.[field]; if (!source) continue;
        const quote = document.createElement('div'); quote.append(text('strong', label), text('blockquote', source.text), text('p', `Line ${source.line} · characters ${source.start}–${source.end} (end excluded)`, 'yc-work-note')); quotes.appendChild(quote);
      }
      item.appendChild(quotes); host.appendChild(item);
    }
    if (!rows.length) host.appendChild(text('p', 'No admitted six-field construction rows were returned.'));
    const omissions = document.createElement('details'); omissions.className = 'yc-construction-coverage'; omissions.appendChild(text('summary', 'Source and coverage'));
    const counts = text('dl', '', 'yc-specialist-output');
    for (const [label, value] of [['Source SHA-256', output.source?.sha256], ['Source bytes', output.source?.bytes], ['Source characters', output.source?.characters], ['Source lines', output.source?.lines], ['Offset unit', output.source?.offset_unit], ['Candidate records', output.candidate_count], ['Excluded records', output.excluded_count], ['Omitted records', output.omitted_count], ['Unrecognized source lines', output.unrecognized_lines]]) counts.append(text('dt', label), text('dd', value ?? 'Not reported'));
    omissions.append(counts, text('p', 'Difference is stated total minus calculated total. Calculations apply only to returned rows and use ROUND_HALF_UP.', 'yc-work-note'));
    for (const excluded of output.excluded.slice(0, 100)) { const item = text('div', '', 'yc-construction-excluded'); item.append(text('strong', String(excluded.reason || 'Reason unavailable').replace(/_/g, ' ')), text('blockquote', excluded.source?.text || ''), text('p', `Line ${excluded.source?.line ?? 'unknown'}${excluded.source_truncated ? ' · source excerpt truncated' : ''}`, 'yc-work-note')); omissions.appendChild(item); }
    host.appendChild(omissions); return host;
  }
  const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  function outcome(value, depth = 0) {
    if (scalar(value)) return text('span', value ?? '—');
    if (depth > 3) return text('p', 'Nested details are available in the execution record.');
    if (Array.isArray(value)) {
      if (!value.length) return text('p', 'None');
      const rows = value.slice(0, 50);
      if (rows.every(scalar)) { const list = text('ul', '', 'yc-specialist-list'); rows.forEach(item => list.appendChild(text('li', item ?? '—'))); if (value.length > rows.length) list.appendChild(text('li', `${value.length - rows.length} more entries in the execution record.`)); return list; }
      if (rows.every(row => row && typeof row === 'object' && !Array.isArray(row) && Object.values(row).every(scalar))) {
        const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 8);
        const wrap = text('div', '', 'yc-result-table'); const table = document.createElement('table'); const head = document.createElement('tr');
        keys.forEach(key => { const cell = text('th', key.replace(/_/g, ' ')); cell.scope = 'col'; head.appendChild(cell); }); const header = document.createElement('thead'); header.appendChild(head); table.appendChild(header);
        const body = document.createElement('tbody'); rows.forEach(row => { const line = document.createElement('tr'); keys.forEach(key => line.appendChild(text('td', row[key] ?? '—'))); body.appendChild(line); }); table.appendChild(body); wrap.appendChild(table);
        if (value.length > rows.length) wrap.appendChild(text('p', `Showing ${rows.length} of ${value.length} entries.`)); return wrap;
      }
      const list = text('ul', '', 'yc-specialist-list'); rows.forEach(item => { const row = text('li'); row.appendChild(outcome(item, depth + 1)); list.appendChild(row); }); return list;
    }
    const fields = text('dl', '', 'yc-specialist-output');
    for (const [key, item] of Object.entries(value || {}).slice(0, 30)) { fields.appendChild(text('dt', key.replace(/_/g, ' '))); const detail = text('dd'); detail.appendChild(outcome(item, depth + 1)); fields.appendChild(detail); }
    return fields;
  }
  function specialistResult(step, parent) {
    const result = step.result;
    return step.succeeded === true && ['build_specialist', 'run_built_specialist', 'run_saved_specialist'].includes(step.tool) && result?.tool === step.tool &&
      result.schema === 'yur.work-specialist-result.v1' && result.status === 'completed' && result.committed === true &&
      /^[a-f0-9]{32}$/.test(result.mission_id || '') && result.provenance?.parent_work_id === parent.id ? result : null;
  }
  function renderSpecialist(result, parent, options) {
    const card = text('article', '', 'yc-specialist-card'); card.dataset.specialistId = result.mission_id;
    const build = result.tool === 'build_specialist';
    const saved = result.tool === 'run_saved_specialist';
    const sourceParent = saved ? result.selection?.source_parent_work_id : parent.id;
    card.append(text('p', build ? 'SPECIALIST BUILT' : saved ? 'SAVED SPECIALIST RESULT' : 'SPECIALIST RESULT', 'yc-specialist-eyebrow'), text('h4', build ? result.name : (capabilityNames[result.capability_id] || result.capability_id)));
    if (build) {
      card.appendChild(text('p', 'Assembled from admitted capabilities and committed to your local workspace.'));
      const capabilities = text('ul', '', 'yc-specialist-capabilities');
      for (const capability of result.capabilities || []) {
        const item = text('li'); item.append(text('strong', capabilityNames[capability.id] || capability.id), text('p', capability.selection_reason || capability.id)); capabilities.appendChild(item);
      }
      card.appendChild(capabilities);
      const validation = result.artifact?.validation || {}, metrics = validation.metrics || {};
      card.appendChild(text('p', validation.passed === true ? 'Artifact validation passed.' : 'Artifact validation has not passed.', 'yc-specialist-validation'));
      card.appendChild(text('p', validation.independent_validation?.passed === true ? 'Independent validation passed.' : 'Independent validation is not confirmed.'));
      if (Number.isInteger(metrics.fixtures_passed) && Number.isInteger(metrics.fixture_count)) card.appendChild(text('p', `${metrics.fixtures_passed} of ${metrics.fixture_count} outcome fixtures passed.`));
      if (result.artifact?.selection?.reason) card.appendChild(text('p', result.artifact.selection.reason, 'yc-specialist-selection'));
    } else {
      card.appendChild(text('p', 'Execution completed and its result was committed.'));
      if (saved) card.appendChild(text('p', result.selection?.reason || 'A previously built specialist was selected for this Work request.', 'yc-specialist-selection'));
      card.appendChild((result.capability_id === 'construction.opc.inspect' && renderConstruction(result.output)) || outcome(result.output));
    }
    const record = document.createElement('details'); record.append(text('summary', build ? 'Build record' : 'Execution record'), preview(build ? {
      specialist_id: result.mission_id, capabilities: result.capabilities, artifact: result.artifact, provenance: result.provenance,
    } : { specialist_id: result.mission_id, capability_id: result.capability_id, run_id: result.run_id, output: result.output, execution_receipt: result.execution_receipt, selection: result.selection, provenance: result.provenance })); card.appendChild(record);
    const api = options.api?.work;
    const actions = text('div', '', 'yc-specialist-actions'); const status = text('div', '', 'yc-specialist-export-status'); status.setAttribute('role', 'status'); card.append(actions, status);
    if (api?.inspectSpecialist && /^[a-f0-9]{32}$/.test(sourceParent || '')) {
      const inspect = text('button', 'Inspect specialist'); inspect.type = 'button';
      inspect.addEventListener('click', async () => {
        inspect.disabled = true;
        try {
          const response = await api.inspectSpecialist(sourceParent, result.mission_id);
          if (!response?.ok) throw new Error(response?.error?.message || 'Specialist record unavailable.');
          if (response.result.parent_work_id !== sourceParent || response.result.specialist?.id !== result.mission_id) throw new Error('The specialist record is not bound to its source Work request.');
          const detail = document.createElement('details'); detail.open = true; detail.append(text('summary', 'Current specialist record'), preview(response.result.specialist)); status.replaceChildren(detail);
        } catch (error) { status.replaceChildren(text('p', error.message, 'yc-form-error')); }
        finally { inspect.disabled = false; }
      }); actions.appendChild(inspect);
    }
    if (build && api?.exportSpecialist) {
      const exportPack = text('button', 'Export specialist pack'); exportPack.type = 'button'; exportPack.className = 'yc-specialist-export';
      exportPack.addEventListener('click', async () => {
        exportPack.disabled = true; status.replaceChildren(text('p', 'Exporting the committed specialist pack…'));
        try {
          const response = await api.exportSpecialist(parent.id, result.mission_id);
          if (!response?.ok) throw new Error(response?.error?.message || 'Specialist export failed.');
          const exported = response.result.export;
          if (response.result.parent_work_id !== parent.id || response.result.specialist_id !== result.mission_id || exported?.mission_id !== result.mission_id || !exported.path || !/^[a-f0-9]{64}$/.test(exported.zip_digest || '') || exported.artifact_digest !== result.artifact?.digest) throw new Error('The export did not return a matching verified pack receipt.');
          status.replaceChildren(text('p', 'Specialist pack exported.'), text('p', exported.path, 'yc-work-destination'));
          const evidence = document.createElement('details'); evidence.append(text('summary', 'Export verification'), preview(exported)); status.appendChild(evidence);
          if (api.revealSpecialist) {
            const reveal = text('button', 'Show exported pack'); reveal.type = 'button'; reveal.addEventListener('click', async () => {
              try { const shown = await api.revealSpecialist(parent.id, result.mission_id); if (!shown?.ok) throw new Error(shown?.error?.message || 'The exported pack could not be verified.'); }
              catch (error) { status.appendChild(text('p', error.message, 'yc-form-error')); }
            }); status.appendChild(reveal);
          }
        } catch (error) { status.replaceChildren(text('p', error.message, 'yc-form-error')); }
        finally { exportPack.disabled = false; }
      }); actions.appendChild(exportPack);
    }
    return card;
  }
  function renderSpecialistCatalog(step, parent, options) {
    const result = step.result;
    if (step.succeeded !== true || step.tool !== 'list_built_specialists' || result?.tool !== step.tool || result.schema !== 'yur.work-specialist-catalog.v1' || result.status !== 'completed' || result.committed !== false || result.provenance?.parent_work_id !== parent.id || !Array.isArray(result.entries)) return null;
    const card = text('article', '', 'yc-specialist-catalog'); card.append(text('h4', 'Available saved specialists'), text('p', 'Discovered from committed builds. Listing a specialist does not run it.'));
    for (const entry of result.entries.slice(0, 20)) {
      const item = text('section', '', 'yc-specialist-catalog-entry'); item.append(text('h5', entry.name), text('p', (entry.capabilities || []).map(id => capabilityNames[id] || id).join(' · ')));
      if (Number.isInteger(entry.evidence?.fixtures_passed)) item.appendChild(text('p', `${entry.evidence.fixtures_passed} independent outcome fixtures passed.`));
      if (options.api?.work?.inspectSpecialist && /^[a-f0-9]{32}$/.test(entry.source_parent_work_id || '') && /^[a-f0-9]{32}$/.test(entry.mission_id || '')) {
        const button = text('button', 'Inspect saved specialist'); button.type = 'button'; const status = text('div'); status.setAttribute('role', 'status');
        button.addEventListener('click', async () => { button.disabled = true; try { const response = await options.api.work.inspectSpecialist(entry.source_parent_work_id, entry.mission_id); if (!response?.ok) throw new Error(response?.error?.message || 'Saved specialist unavailable.'); if (response.result.parent_work_id !== entry.source_parent_work_id || response.result.specialist?.id !== entry.mission_id) throw new Error('Saved specialist source does not match.'); const details = document.createElement('details'); details.open = true; details.append(text('summary', 'Current specialist record'), preview(response.result.specialist)); status.replaceChildren(details); } catch (error) { status.replaceChildren(text('p', error.message, 'yc-form-error')); } finally { button.disabled = false; } }); item.append(button, status);
      }
      card.appendChild(item);
    }
    if (!result.entries.length) card.appendChild(text('p', 'No matching committed specialist builds were found in this scan.'));
    card.appendChild(text('p', `${result.entries.length} found · ${result.scanned} records checked · ${result.excluded} excluded${result.coverage_limited || result.next_cursor ? '. This is a bounded page; more records may be available.' : '.'}`, 'yc-work-note'));
    return card;
  }
  function renderSavedSpecialist(host, entry, options = {}) {
    const parentId = entry.source_parent_work_id, specialistId = entry.mission_id;
    if (!/^[a-f0-9]{32}$/.test(parentId || '') || !/^[a-f0-9]{32}$/.test(specialistId || '') || !/^[a-f0-9]{64}$/.test(entry.artifact_digest || '')) throw new Error('Saved specialist identity is incomplete. Refresh the catalog.');
    const section = text('section', '', 'yc-saved-specialist');
    section.append(text('p', 'A committed specialist build, ready to be selected for another Work request.'), text('p', (entry.capabilities || []).map(id => capabilityNames[id] || id).join(' · ')));
    if (Number.isInteger(entry.evidence?.fixtures_passed)) section.appendChild(text('p', `${entry.evidence.fixtures_passed} independent outcome fixtures passed.`));
    const provenance = document.createElement('details'); provenance.append(text('summary', 'Build evidence'), preview(entry)); section.appendChild(provenance);
    const actions = text('div', '', 'yc-specialist-actions'), status = text('div', '', 'yc-specialist-export-status'); status.setAttribute('role', 'status'); section.append(actions, status);
    function button(label, action) { const item = text('button', label); item.type = 'button'; item.addEventListener('click', async () => { item.disabled = true; try { await action(); } catch (error) { status.replaceChildren(text('p', error.message, 'yc-form-error')); } finally { item.disabled = false; } }); actions.appendChild(item); }
    button('Inspect specialist', async () => {
      const response = await options.api.work.inspectSpecialist(parentId, specialistId);
      if (!response?.ok) throw new Error(response?.error?.message || 'Saved specialist unavailable.');
      if (response.result.parent_work_id !== parentId || response.result.specialist?.id !== specialistId) throw new Error('The specialist source does not match.');
      const details = document.createElement('details'); details.open = true; details.append(text('summary', 'Current specialist record'), preview(response.result.specialist)); status.replaceChildren(details);
    });
    button('Export specialist pack', async () => {
      const response = await options.api.work.exportSpecialist(parentId, specialistId);
      if (!response?.ok) throw new Error(response?.error?.message || 'Saved specialist export failed.');
      const exported = response.result.export;
      if (response.result.parent_work_id !== parentId || response.result.specialist_id !== specialistId || exported?.mission_id !== specialistId || exported.artifact_digest !== entry.artifact_digest || !/^[a-f0-9]{64}$/.test(exported.zip_digest || '') || !exported.path) throw new Error('Export receipt does not match the selected specialist.');
      status.replaceChildren(text('p', 'Specialist pack exported.'), text('p', exported.path, 'yc-work-destination'));
      const details = document.createElement('details'); details.append(text('summary', 'Export verification'), preview(exported)); status.appendChild(details);
      const reveal = text('button', 'Show exported pack'); reveal.type = 'button'; reveal.addEventListener('click', async () => { try { const shown = await options.api.work.revealSpecialist(parentId, specialistId); if (!shown?.ok) throw new Error(shown?.error?.message || 'Could not verify the exported pack.'); } catch (error) { status.appendChild(text('p', error.message, 'yc-form-error')); } }); status.appendChild(reveal);
    });
    if (options.onUse) button('Use in conversation', () => options.onUse(entry));
    host.appendChild(section);
  }
  function deliveryActions(item, artifact, mission, api, options) {
    if (!api?.work?.validateDelivery || !api?.work?.deliver) return;
    const edit = artifact.proposal?.kind === 'edit';
    const action = text('button', edit ? 'Validate edit for review' : 'Export artifact'); action.type = 'button';
    const status = text('div', '', 'yc-work-delivery'); status.setAttribute('role', 'status');
    let delivering = false;
    item.append(action, status);
    if (artifact.delivery?.status === 'applied') status.append(text('p', edit ? 'Applied delivery recorded.' : 'Export delivery recorded.'), deliverySummary(artifact.delivery.plan, artifact.delivery.verified_sha256));
    else if (artifact.delivery?.status === 'prepared') status.appendChild(text('p', 'Delivery was prepared but its completion is not recorded. Validate the current file before resuming.'));
    if (artifact.delivery?.status === 'applied' && api.work.reveal) {
      const show = text('button', 'Show file'); show.type = 'button'; show.addEventListener('click', async () => { try { const response = await api.work.reveal(mission.id, artifact.id); if (!response?.ok) throw new Error(response?.error?.message || 'Could not verify and reveal the file.'); } catch (error) { status.appendChild(text('p', error.message, 'yc-form-error')); } }); status.appendChild(show);
    }
    async function deliver(validation, apply) {
      if (delivering) return;
      delivering = true; apply.disabled = true; action.disabled = true;
      try {
        const response = await api.work.deliver(mission.id, artifact.id, validation.validation_token);
        if (!response?.ok) throw new Error(response?.error?.message || 'Delivery failed. Validate the file again before retrying.');
        const delivery = response.result.delivery;
        if (delivery?.status !== 'applied') throw new Error('The runtime did not return an applied delivery receipt.');
        status.replaceChildren(text('p', response.result.replayed ? 'Recovered committed delivery.' : edit ? 'Reviewed edit applied.' : 'Artifact exported.'), deliverySummary(delivery.plan, delivery.verified_sha256));
        if (api.work.reveal) {
          const reveal = text('button', 'Show file'); reveal.type = 'button';
          reveal.addEventListener('click', async () => { try { const shown = await api.work.reveal(mission.id, artifact.id); if (!shown?.ok) throw new Error(shown?.error?.message || 'Could not reveal the delivered file.'); } catch (error) { status.appendChild(text('p', error.message, 'yc-form-error')); } }); status.appendChild(reveal);
        }
        options.onDelivered?.(response.result);
      } catch (error) { status.replaceChildren(text('p', error.message, 'yc-form-error')); }
      finally { delivering = false; action.disabled = false; }
    }
    action.addEventListener('click', async () => {
      action.disabled = true; status.replaceChildren(text('p', 'Validating the proposed delivery against the current file…'));
      try {
        const response = await api.work.validateDelivery(mission.id, artifact.id);
        if (!response?.ok) throw new Error(response?.error?.message || 'Delivery validation failed.');
        const validation = response.result;
        if (!validation.validation_token || !validation.plan) throw new Error('The runtime returned no validated delivery plan.');
        if (!edit) { await deliver(validation, action); return; }
        status.replaceChildren(text('p', validation.already_applied ? 'This edit was already applied. Recover its committed receipt below.' : validation.plan.before_sha256 ? 'Replace existing file' : 'Create new file'), deliverySummary(validation.plan));
        if (!validation.already_applied) status.append(text('h4', 'Changes to apply'), preview(artifact.proposal.diff || artifact.proposal.content || ''));
        const apply = text('button', validation.already_applied ? 'Recover delivery receipt' : 'Apply reviewed edit'); apply.type = 'button'; apply.className = 'yc-primary';
        apply.addEventListener('click', () => deliver(validation, apply)); status.appendChild(apply);
      } catch (error) { status.replaceChildren(text('p', error.message, 'yc-form-error')); }
      finally { action.disabled = false; }
    });
  }
  const cellProfiles = { 'python-unittest-serial': 'Serial Python unittest', 'python-compile-serial': 'Serial Python compilation' };
  const cellStatuses = { completed: 'Command completed', failed: 'Command failed', timeout: 'Time limit reached', output_limit: 'Output limit reached', cancelled: 'Command cancelled' };
  const generatedTools = new Set(['forge_python_specialist', 'list_python_specialists', 'run_python_specialist']);
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const workId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  function generatedArtifact(value) {
    return value && digest(value.sha256) && typeof value.name === 'string' && value.name.length > 0 &&
      ['source_sha256', 'contract_sha256', 'driver_sha256'].every(key => digest(value[key])) &&
      ['input_schema', 'output_schema'].every(key => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]));
  }
  function generatedEntry(value) {
    return value && workId(value.source_work_id) && Number.isInteger(value.build_step_index) && value.build_step_index >= 0 &&
      digest(value.artifact_sha256) && digest(value.published_receipt) && generatedArtifact({ ...value, sha256: value.artifact_sha256 });
  }
  function generatedResult(step, mission, index) {
    const result = step.result, provenance = result?.provenance;
    if (!generatedTools.has(step.tool) || step.succeeded !== true || result?.schema !== 'yur.work-generated-specialist-result.v1' || result.tool !== step.tool ||
        provenance?.parent_work_id !== mission.id || !digest(provenance.input_hash)) return null;
    if (step.tool === 'list_python_specialists') return result.status === 'discovered' && result.committed === false && Array.isArray(result.entries) ? result : null;
    if (provenance.step_index !== index || result.committed !== true || !digest(provenance.accepted_receipt) || !digest(provenance.result_receipt)) return null;
    if (step.tool === 'forge_python_specialist') {
      const validation = result.validation;
      if (!validation || !Number.isInteger(validation.cases_total) || validation.cases_total < 1 || !Array.isArray(validation.candidates) || typeof validation.qualification !== 'string') return null;
      if (result.status === 'rejected') return result.artifact === null && validation.selected_strategy === null ? result : null;
      if (result.status !== 'published' || !generatedArtifact(result.artifact)) return null;
      const selected = validation.candidates.find(candidate => candidate.strategy === validation.selected_strategy);
      return selected?.passed === true && selected.status === 'passed' && selected.cases_total === validation.cases_total && selected.cases_passed === validation.cases_total &&
        selected.source_sha256 === result.artifact.source_sha256 ? result : null;
    }
    if (!['recorded', 'rejected'].includes(result.status) || !generatedArtifact(result.artifact) || !generatedEntry({ ...result.artifact, ...result.selection })) return null;
    if (result.selection.artifact_sha256 !== result.artifact.sha256) return null;
    const execution = result.execution;
    if (!digest(result.execution_receipt) || !execution || !Object.hasOwn(cellStatuses, execution.status) || !Number.isInteger(execution.exit_code) ||
        (execution.status === 'completed' && execution.exit_code !== 0) || (execution.status === 'failed' && execution.exit_code === 0) ||
        typeof execution.stdout !== 'string' || typeof execution.stderr !== 'string') return null;
    if (result.status === 'recorded' && (execution.status !== 'completed' || !Object.hasOwn(result, 'output'))) return null;
    return result;
  }
  function generatedLabel(result) {
    if (result.tool === 'forge_python_specialist') return result.status === 'published' ? 'Python specialist · published' : 'Python specialist · build rejected';
    if (result.tool === 'list_python_specialists') return 'Python specialists · discovered';
    return `Python specialist · ${result.status === 'rejected' ? 'run rejected' : cellStatuses[result.execution.status]} · exit ${result.execution.exit_code}`;
  }
  function generatedActions(host, entry, options) {
    const actions = text('div', '', 'yc-specialist-actions'), status = text('div', '', 'yc-specialist-export-status'); status.setAttribute('role', 'status');
    const active = () => !options.active || options.active();
    function button(label, action) { const node = text('button', label); node.type = 'button'; node.addEventListener('click', async () => { if (!active()) return; node.disabled = true; try { await action(); } catch (error) { if (active()) status.replaceChildren(text('p', error.message, 'yc-form-error')); } finally { node.disabled = false; } }); actions.appendChild(node); }
    if (options.api?.work?.inspect) button('Inspect source build', async () => {
      const response = await options.api.work.inspect(entry.source_work_id);
      if (!active()) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'The source build is unavailable.');
      const mission = response.result?.mission;
      const result = mission?.id === entry.source_work_id && generatedResult(mission.steps?.[entry.build_step_index] || {}, mission, entry.build_step_index);
      const publication = !entry.published_receipt || response.result.events?.some(event => event.event_type === 'work.generated.published' && event.hash === entry.published_receipt && event.change?.step_index === entry.build_step_index && event.change?.artifact_sha256 === entry.artifact_sha256);
      if (!result || result.tool !== 'forge_python_specialist' || result.status !== 'published' || result.artifact.sha256 !== entry.artifact_sha256 || !publication || (entry.result_receipt && result.provenance.result_receipt !== entry.result_receipt)) throw new Error('The saved build does not match its published source and receipt.');
      const detail = document.createElement('details'); detail.open = true; detail.append(text('summary', 'Published source build'), renderGenerated(result, { ...options, api: null, onUseGeneratedSpecialist: null })); status.replaceChildren(detail);
    });
    if (typeof options.onUseGeneratedSpecialist === 'function') button('Use in Code conversation', () => options.onUseGeneratedSpecialist({ source_work_id: entry.source_work_id, build_step_index: entry.build_step_index, artifact_sha256: entry.artifact_sha256, name: entry.name }));
    if (actions.childElementCount) host.append(actions, status);
  }
  function renderSavedGeneratedSpecialist(host, entry, options = {}) {
    if (!generatedEntry(entry)) throw new Error('The generated specialist has no matching source identity. Refresh the library.');
    const card = text('section', '', 'yc-saved-generated-specialist yc-specialist-card');
    card.dataset.sourceWorkId = entry.source_work_id; card.dataset.artifactSha256 = entry.artifact_sha256;
    card.append(text('p', 'PUBLISHED PYTHON SPECIALIST', 'yc-specialist-eyebrow'), text('p', entry.description || ''), text('p', entry.validation?.qualification || 'Read the source build for its acceptance limits.', 'yc-work-note'));
    const contract = document.createElement('details'); contract.append(text('summary', 'Input and output contract'), preview({ input: entry.input_schema, output: entry.output_schema })); card.appendChild(contract);
    const source = document.createElement('details'); source.append(text('summary', 'Publication and source evidence'), preview(entry)); card.appendChild(source);
    generatedActions(card, entry, options); host.appendChild(card);
  }
  function renderGenerated(result, options = {}) {
    const build = result.tool === 'forge_python_specialist', catalog = result.tool === 'list_python_specialists';
    const card = text('article', '', catalog ? 'yc-specialist-catalog yc-generated-catalog' : 'yc-specialist-card yc-generated-specialist');
    card.dataset.generatedStatus = result.status; card.dataset.sourceWorkId = result.provenance.parent_work_id;
    card.append(text('p', catalog ? 'GENERATED PYTHON LIBRARY' : build ? 'GENERATED PYTHON SPECIALIST' : 'GENERATED PYTHON RESULT', 'yc-specialist-eyebrow'), text('h4', catalog ? 'Saved Python specialists' : result.artifact?.name || 'Python specialist build'), text('p', generatedLabel(result), 'yc-generated-status'));
    if (catalog) {
      card.appendChild(text('p', 'Discovered from published builds. Listing does not run generated code.'));
      let shown = 0;
      for (const entry of result.entries.slice(0, 20)) {
        if (!generatedEntry(entry)) continue;
        shown += 1;
        const item = text('section', '', 'yc-specialist-catalog-entry'); item.dataset.artifactSha256 = entry.artifact_sha256;
        item.append(text('h5', entry.name), text('p', entry.description || ''), text('p', entry.validation?.qualification || 'Qualification details are in the source build.', 'yc-work-note'));
        const record = document.createElement('details'); record.append(text('summary', 'Published contract and source'), preview(entry)); item.appendChild(record); generatedActions(item, entry, options); card.appendChild(item);
      }
      if (!result.entries.length) card.appendChild(text('p', 'No published Python specialists were found in this scan.'));
      if (shown !== result.entries.length) card.appendChild(text('p', `Showing ${shown} of ${result.entries.length} entries with matching source identities.`, 'yc-work-note'));
      card.appendChild(text('p', `Scanned ${result.scanned ?? 'unreported'} · excluded ${result.excluded ?? 'unreported'}${result.coverage_limited || result.next_cursor ? ' · more records may remain outside this page' : ''}`, 'yc-work-note'));
      return card;
    }
    if (result.artifact) {
      card.dataset.artifactSha256 = result.artifact.sha256;
      if (result.artifact.description) card.appendChild(text('p', result.artifact.description));
      const contract = document.createElement('details'); contract.append(text('summary', 'Input and output contract'), preview({ input: result.artifact.input_schema, output: result.artifact.output_schema })); card.appendChild(contract);
    }
    if (build) {
      card.appendChild(text('p', result.status === 'published' ? `Selected candidate passed ${result.validation.cases_total} of ${result.validation.cases_total} host-checked acceptance cases.` : 'No candidate was published. The rejected build result and its receipt were retained.', 'yc-specialist-validation'));
      card.appendChild(text('p', result.validation.qualification, 'yc-work-note'));
      if (result.validation.selected_strategy) card.appendChild(text('p', `Selected strategy: ${result.validation.selected_strategy}`, 'yc-specialist-selection'));
      if (result.validation.selection_reason) card.appendChild(text('p', result.validation.selection_reason, 'yc-specialist-selection'));
      const candidates = document.createElement('details'); candidates.className = 'yc-generated-candidates'; candidates.open = true;
      candidates.appendChild(text('summary', 'Candidate acceptance results'));
      for (const candidate of result.validation.candidates.slice(0, 20)) {
        const row = text('section', '', 'yc-specialist-catalog-entry');
        row.append(text('strong', candidate.strategy || 'Strategy not reported'), text('p', `${candidate.status === 'passed' && candidate.passed === true ? 'Passed' : 'Rejected'} · ${Number.isInteger(candidate.cases_passed) ? candidate.cases_passed : 'unreported'} of ${Number.isInteger(candidate.cases_total) ? candidate.cases_total : result.validation.cases_total} cases`));
        if (candidate.error) row.appendChild(preview(candidate.error, 2000)); candidates.appendChild(row);
      }
      if (result.validation.candidates.length > 20) candidates.appendChild(text('p', 'Showing the first 20 candidate results.'));
      card.appendChild(candidates);
    } else {
      card.appendChild(text('p', result.qualification || 'This result applies only to the selected artifact and supplied input.', 'yc-work-note'));
      if (result.selection.reason) card.appendChild(text('p', result.selection.reason, 'yc-specialist-selection'));
      if (result.error) card.appendChild(preview(result.error, 4000));
      if (result.status === 'recorded' && result.execution.status === 'completed') { const output = text('section', '', 'yc-generated-output'); output.append(text('h5', 'Returned output'), JSON.stringify(result.output).length > 32000 ? preview(result.output, 32000) : outcome(result.output)); card.appendChild(output); }
      for (const channel of ['stdout', 'stderr']) if (result.execution[channel]) { const output = document.createElement('details'); output.className = `yc-generated-${channel}`; output.append(text('summary', channel === 'stdout' ? 'Standard output' : 'Standard error'), preview(result.execution[channel], 32000)); card.appendChild(output); }
    }
    const record = document.createElement('details'); record.className = 'yc-generated-receipt'; record.append(text('summary', build ? 'Committed build record' : 'Committed execution record'), preview(result)); card.appendChild(record);
    if (build && result.status === 'published') generatedActions(card, { ...result.artifact, source_work_id: result.provenance.parent_work_id, build_step_index: result.provenance.step_index, artifact_sha256: result.artifact.sha256, result_receipt: result.provenance.result_receipt }, options);
    else if (!build) generatedActions(card, { ...result.artifact, ...result.selection }, options);
    return card;
  }
  function cellResult(step, mission, index) {
    const result = step.result, execution = result?.execution, snapshot = result?.snapshot, provenance = result?.provenance;
    if (step.tool !== 'run_python_checks' || step.succeeded !== true || result?.schema !== 'yur.work-cell-result.v1' || result.tool !== step.tool || result.status !== 'recorded' || result.committed !== true ||
        provenance?.parent_work_id !== mission.id || provenance.step_index !== index || !/^[a-f0-9]{64}$/.test(provenance.snapshot_receipt || '') || !/^[a-f0-9]{64}$/.test(provenance.result_receipt || '') ||
        !/^[a-f0-9]{64}$/.test(snapshot?.id || '') || execution?.snapshot_id !== snapshot.id || execution.profile !== snapshot.profile || !Object.hasOwn(cellProfiles, execution.profile) ||
        !Object.hasOwn(cellStatuses, execution.status) || !Number.isInteger(execution.exit_code) || (execution.status === 'completed' && execution.exit_code !== 0) || (execution.status === 'failed' && execution.exit_code === 0) ||
        typeof execution.stdout !== 'string' || typeof execution.stderr !== 'string' || !Array.isArray(snapshot.sources)) return null;
    return result;
  }
  function renderCell(result) {
    const { execution, snapshot, provenance } = result;
    const card = text('section', '', 'yc-cell-result'); card.dataset.snapshotId = snapshot.id; card.dataset.executionStatus = execution.status;
    card.append(text('h4', cellProfiles[execution.profile]), text('p', execution.profile, 'yc-work-id'), text('p', `${cellStatuses[execution.status]} · exit code ${execution.exit_code}`, 'yc-cell-status'));
    if (execution.status === 'completed') card.appendChild(text('p', 'The selected command exited with code 0. This result covers only this profile and source snapshot.', 'yc-work-note'));
    else if (execution.status === 'output_limit') card.appendChild(text('p', 'Execution stopped at its output limit. The streams below contain the bounded capture.', 'yc-work-note'));
    if (Number.isInteger(execution.duration_ms)) card.appendChild(text('p', `Duration: ${execution.duration_ms.toLocaleString()} ms`, 'yc-work-note'));
    if (execution.scratch === 'discarded') card.appendChild(text('p', 'Scratch changes were discarded. Staged edits did not change source files; applying an edit still requires review.', 'yc-work-note'));
    const sources = document.createElement('details'); sources.className = 'yc-cell-sources'; sources.open = true;
    sources.appendChild(text('summary', `Selected sources (${snapshot.sources.length})`));
    const list = text('ul', '', 'yc-specialist-list');
    for (const source of snapshot.sources.slice(0, 32)) {
      const item = text('li'); item.append(text('strong', source.path), text('p', source.overlay === true ? 'Staged edit overlay' : 'Original source', 'yc-work-note'));
      const hashes = document.createElement('details'); hashes.append(text('summary', 'Original and staged hashes'));
      const fields = text('dl', '', 'yc-specialist-output'); fields.append(text('dt', 'Original SHA-256'), text('dd', source.original_sha256 === null ? 'New file — no original bytes' : source.original_sha256 || 'Not reported'), text('dt', 'Staged SHA-256'), text('dd', source.staged_sha256 || 'Not reported')); hashes.appendChild(fields); item.appendChild(hashes); list.appendChild(item);
    }
    sources.appendChild(list); if (snapshot.sources.length > 32) sources.appendChild(text('p', 'Showing the first 32 selected sources.', 'yc-work-note')); card.appendChild(sources);
    for (const channel of ['stdout', 'stderr']) {
      const output = document.createElement('details'); output.className = `yc-cell-${channel}`; output.open = Boolean(execution[channel]);
      output.append(text('summary', `${channel === 'stdout' ? 'Standard output' : 'Standard error'}${Number.isInteger(execution[channel + '_bytes']) ? ` · ${execution[channel + '_bytes'].toLocaleString()} captured bytes` : ''}`));
      output.appendChild(execution[channel] ? preview(execution[channel], 32000) : text('p', 'No output captured.', 'yc-work-note')); card.appendChild(output);
    }
    const receipt = document.createElement('details'); receipt.className = 'yc-cell-receipt';
    receipt.append(text('summary', 'Committed execution record'), preview({ snapshot_id: snapshot.id, snapshot_receipt: provenance.snapshot_receipt, result_receipt: provenance.result_receipt, parent_work_id: provenance.parent_work_id, step_index: provenance.step_index, input_hash: provenance.input_hash,
      execution_status: execution.status, exit_code: execution.exit_code, stdout_sha256: execution.stdout_sha256, stderr_sha256: execution.stderr_sha256, runtime: execution.runtime, limits: execution.limits, scratch: execution.scratch })); card.appendChild(receipt);
    return card;
  }
  function browserResult(step, mission, index) {
    const result = step.result, source = mission.request?.browser_source, provenance = result?.provenance;
    if (step.tool !== 'acquire_selected_page' || step.succeeded !== true || result?.schema !== 'yur.work-browser-result.v1' || result.tool !== step.tool ||
        !['recorded', 'denied'].includes(result.status) || result.committed !== true || !source || step.arguments?.source_id !== source.source_id ||
        provenance?.parent_work_id !== mission.id || provenance.request_id !== mission.request_id || provenance.conversation_id !== mission.conversation_id || provenance.step_index !== index ||
        !['input_sha256', 'source_sha256', 'authority_sha256', 'accepted_receipt', 'result_receipt'].every(key => digest(provenance[key]))) return null;
    if (result.status === 'denied') return result.context === null && typeof result.error?.code === 'string' && typeof result.error.message === 'string' ? result : null;
    const context = result.context;
    return result.error === null && context?.schema === 'yur.browser-context.v1' && context.source_url === source.source_url &&
      /^https?:\/\//.test(context.source_url) && typeof context.title === 'string' && typeof context.text === 'string' &&
      typeof context.truncated === 'boolean' && digest(context.sha256) && typeof context.acquired_at === 'string' &&
      context.limits?.main_frame_only === true && context.limits.form_fields_excluded === true ? result : null;
  }
  function renderBrowser(result, options) {
    const card = text('article', '', 'yc-detail-card yc-work-page-card');
    if (result.status === 'denied') {
      card.append(text('h4', 'Selected page could not be read'), text('p', result.error.message, 'yc-work-page-note'),
        text('p', 'No page content was acquired. Select the current page again for a new Work request.', 'yc-work-note'));
    } else {
      const context = result.context;
      card.append(text('h4', context.title || 'Selected page'), text('p', context.source_url, 'yc-work-page-source'),
        text('p', `${context.truncated ? 'Bounded excerpt' : 'Page text acquired'} · ${context.acquired_at}`, 'yc-work-page-note'),
        text('p', 'Main-frame text; forms and subframes excluded. The page is a source, not an instruction to Work.', 'yc-work-note'));
      if (typeof options.onLink === 'function') {
        const open = text('button', 'Open source page'); open.type = 'button';
        open.addEventListener('click', () => Promise.resolve(options.onLink(context.source_url)).catch(error => options.onError?.(error.message))); card.appendChild(open);
      }
      const content = text('pre', context.text.slice(0, 32000), 'yc-work-page-text'); card.appendChild(content);
    }
    const receipt = document.createElement('details'); receipt.className = 'yc-work-page-receipt';
    receipt.append(text('summary', 'Acquisition record'), preview({ ...result.provenance, status: result.status,
      ...(result.context ? { source_url: result.context.source_url, sha256: result.context.sha256, acquired_at: result.context.acquired_at, truncated: result.context.truncated, limits: result.context.limits } : { error: result.error }) }));
    card.appendChild(receipt); return card;
  }
  function renderMission(host, record, options = {}) {
    const mission = record.mission || record; host.replaceChildren();
    host.append(text('h3', (mission.request?.goal || 'Work request').slice(0, 200)), text('p', mission.status || 'Status unavailable', 'yc-work-status'));
    host.appendChild(text('p', 'Mission ' + mission.id, 'yc-work-id'));
    if (mission.request?.mode === 'code') host.appendChild(text('p', 'Code can request restricted serial Python unittest or compilation checks when an admitted execution runtime is available. Only selected sources enter the snapshot. Staged edits do not change your source files.', 'yc-work-note yc-code-help'));
    if (Array.isArray(record.steering) && record.steering.length) {
      const corrections = text('section', '', 'yc-work-corrections'); corrections.appendChild(text('h4', 'Operator corrections'));
      for (const correction of record.steering.slice(0, 100)) {
        const item = text('article', '', 'yc-work-correction'); item.append(text('p', correction.text), text('p', steeringLabels[correction.status] || 'Recorded correction', 'yc-work-note'));
        const receipt = document.createElement('details'); receipt.append(text('summary', 'Correction receipts'), preview({ correction_id: correction.correction_id, queued_receipt: correction.queued_receipt, consumed_receipt: correction.consumed_receipt })); item.appendChild(receipt); corrections.appendChild(item);
      }
      host.appendChild(corrections);
    }
    if (mission.error) host.appendChild(text('p', typeof mission.error === 'string' ? mission.error : JSON.stringify(mission.error), 'yc-form-error'));
    const failure = failureDetail(record, mission, options); if (failure) host.appendChild(failure);
    if (mission.answer) {
      const answer = document.createElement('div'); answer.className = 'yc-message-body';
      if (window.yurChatRenderer) window.yurChatRenderer.render(answer, mission.answer, { onError: options.onError, onLink: options.onLink });
      else answer.textContent = mission.answer;
      host.appendChild(answer);
    }
    const steps = document.createElement('div'); steps.className = 'yc-work-steps';
    for (const [index, step] of (mission.steps || []).entries()) {
      const cell = cellResult(step, mission, index);
      const concept = window.yurConceptView?.workResult(step, mission);
      const generated = generatedResult(step, mission, index);
      const browser = browserResult(step, mission, index);
      const label = step.tool === 'acquire_selected_page' ? `Selected page · ${browser ? browser.status === 'denied' ? 'read denied' : 'text acquired' : 'result not verified'}` : generatedTools.has(step.tool) ? generated ? generatedLabel(generated) : `Python specialist · ${step.succeeded === false ? 'request rejected' : 'result not verified'}` : concept?.status === 'denied' ? 'Concept gate · stage unchanged' : step.tool === 'run_python_checks' ? `Python checks · ${cell ? `${cellStatuses[cell.execution.status]} · exit ${cell.execution.exit_code}` : step.succeeded === false ? 'request rejected' : 'result not verified'}` : (step.tool || step.name || 'Tool') + ' · ' + (step.succeeded === true ? 'completed' : step.succeeded === false ? 'rejected' : step.status || 'recorded');
      const item = document.createElement('details'); const summary = text('summary', label);
      item.appendChild(summary);
      if (cell) { item.open = true; item.className = 'yc-cell-tool'; item.appendChild(renderCell(cell)); }
      else if (browser) { item.open = true; item.className = 'yc-work-page-tool'; item.appendChild(renderBrowser(browser, options)); }
      else item.appendChild(preview({ arguments: step.arguments, result: step.result }));
      steps.appendChild(item);
    }
    if (steps.childElementCount) { host.append(text('h4', 'Tool activity'), steps); }
    const concepts = window.yurConceptView?.renderWork(mission.steps, mission, options);
    if (concepts?.childElementCount) host.append(text('h4', 'Concepts'), concepts);
    const specialists = document.createElement('div'); specialists.className = 'yc-specialist-results';
    for (const [index, step] of (mission.steps || []).entries()) { const result = specialistResult(step, mission); const catalog = renderSpecialistCatalog(step, mission, options); const generated = generatedResult(step, mission, index); if (result) specialists.appendChild(renderSpecialist(result, mission, options)); else if (catalog) specialists.appendChild(catalog); else if (generated) specialists.appendChild(renderGenerated(generated, options)); }
    if (specialists.childElementCount) host.append(text('h4', 'Your specialists'), specialists);
    const artifacts = document.createElement('div'); artifacts.className = 'yc-work-artifacts';
    for (const artifact of mission.artifacts || []) {
      const proposal = artifact.proposal || {}; const item = document.createElement('article'); item.className = 'yc-work-artifact';
      item.dataset.artifactId = artifact.id;
      const office = proposal.encoding === 'ooxml-spec-v1';
      const format = office ? ({ 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document · DOCX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet · XLSX', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Slide deck · PPTX' }[proposal.media_type] || 'Office document') : proposal.kind === 'edit' ? 'File edit' : proposal.media_type || 'Artifact';
      item.append(text('h4', proposal.name || proposal.path || 'Artifact'), text('p', format + ' · ' + (artifact.status || 'status unavailable') + (Number.isInteger(proposal.bytes) ? ` · ${proposal.bytes.toLocaleString()} bytes` : '')));
      if (proposal.sha256 || proposal.new_sha256) { const source = document.createElement('details'); source.append(text('summary', 'Source details'), preview({ sha256: proposal.sha256, expected_sha256: proposal.expected_sha256, new_sha256: proposal.new_sha256 })); item.appendChild(source); }
      const contents = document.createElement('details'); contents.append(text('summary', proposal.kind === 'edit' ? 'Review proposed changes' : 'Preview content'));
      // HTML and model code remain inert text, including committed artifacts.
      if (office) { contents.appendChild(preview(proposal.preview_text || 'No text preview was provided. Export the verified document to view its contents.')); if (proposal.preview_truncated) contents.appendChild(text('p', 'This text preview is limited. The exported document contains the complete generated content.', 'yc-work-note')); }
      else if (proposal.kind === 'edit' && proposal.diff) contents.appendChild(preview(proposal.diff));
      else contents.appendChild(preview(proposal.content || ''));
      item.appendChild(contents);
      if (artifact.status === 'committed' && proposal.kind === 'artifact' && proposal.media_type === 'text/html' && !proposal.encoding && options.onPreview) {
        const launch = text('button', 'Open interactive preview'); launch.type = 'button'; launch.className = 'yc-artifact-open';
        launch.addEventListener('click', async () => { launch.disabled = true; try { await options.onPreview(mission, artifact); } catch (error) { options.onError?.(error.message); } finally { launch.disabled = false; } }); item.appendChild(launch);
      }
      if (proposal.kind === 'edit' && artifact.status === 'proposed' && artifact.delivery?.status !== 'applied') item.appendChild(text('p', 'A proposal alone does not change your file. Validate and review it before applying.', 'yc-work-note'));
      deliveryActions(item, artifact, mission, options.api, options);
      if (options.onArtifact) options.onArtifact(item, artifact, mission);
      artifacts.appendChild(item);
    }
    if (artifacts.childElementCount) host.append(text('h4', 'Artifacts and proposals'), artifacts);
    const provenance = document.createElement('details'); provenance.append(text('summary', 'Work record'), preview({ ...reference(mission), ...(record.events ? { events: record.events.map(eventPreview) } : {}) })); host.appendChild(provenance);
    if (options.onCancel && !terminal.has(mission.status)) {
      const cancel = text('button', 'Cancel work'); cancel.type = 'button';
      cancel.addEventListener('click', async () => { cancel.disabled = true; try { await options.onCancel(mission); } catch (error) { options.onError?.(error.message); } finally { cancel.disabled = false; } }); host.appendChild(cancel);
    }
  }
  async function inspect(api, id, host, options = {}) {
    host.replaceChildren(text('p', 'Reading the committed work record…'));
    try { const response = await api.work.inspect(id); if (!response?.ok) throw new Error(response?.error?.message || 'Work record unavailable.'); if (host.isConnected) renderMission(host, response.result, options); }
    catch (error) { if (host.isConnected) host.replaceChildren(text('p', error.message, 'yc-form-error')); }
  }
  async function list(api, conversationId, host, options = {}) {
    host.replaceChildren(text('p', 'Reading work for this conversation…'));
    try {
      const response = await api.work.list(conversationId); if (!response?.ok) throw new Error(response?.error?.message || 'Work history unavailable.');
      if (!host.isConnected) return;
      host.replaceChildren(); const missions = response.result.missions;
      if (!missions.length) { host.appendChild(text('p', 'No committed work requests in this conversation.')); return; }
      for (const mission of missions) {
        const item = document.createElement('details'); const summary = text('summary', (mission.goal || mission.request?.goal || 'Work request').slice(0, 160) + ' · ' + mission.status); const body = document.createElement('div'); item.append(summary, body); host.appendChild(item);
        item.addEventListener('toggle', () => { if (item.open && !body.childElementCount) inspect(api, mission.id, body, options); });
      }
    } catch (error) { if (host.isConnected) host.replaceChildren(text('p', error.message, 'yc-form-error')); }
  }
  window.yurWorkView = Object.freeze({ reference, renderMission, inspect, list, renderSavedSpecialist, renderSavedGeneratedSpecialist, mergeSteering, steeringLabels });
})();
