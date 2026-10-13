/* Read-only concept presentation. Lifecycle decisions remain in CommitService. */
'use strict';
(() => {
  const stages = ['genesis', 'inception', 'development', 'stabilization', 'maturation', 'monetization', 'regeneration', 'evolution'];
  const names = value => String(value || '').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || '');
  const node = (tag, value = '', className = '') => { const item = document.createElement(tag); item.textContent = String(value ?? ''); item.className = className; return item; };
  function record(value, label) { const details = document.createElement('details'), encoded = JSON.stringify(value, null, 2); details.append(node('summary', label), node('pre', encoded.slice(0, 64000) + (encoded.length > 64000 ? '\n[Record preview limited to 64000 characters.]' : ''), 'yc-work-preview')); return details; }
  function action(host, label, callback) {
    if (!callback) return;
    const button = node('button', label); button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { await callback(); } catch (error) { host.appendChild(node('p', error.message, 'yc-form-error')); } finally { button.disabled = false; } }); host.appendChild(button);
  }
  function decisionCard(decision, receipt) {
    const item = node('section', '', 'yc-concept-decision'); item.dataset.allowed = String(decision.allowed);
    item.append(node('h4', decision.allowed ? `Stage recorded: ${names(decision.to_stage)}` : `Stage unchanged: ${names(decision.from_stage)}`),
      node('p', decision.allowed ? 'The transition was committed using the referenced evidence.' : `The request to enter ${names(decision.to_stage)} was denied. The decision receipt is retained.`));
    if (decision.missing?.length || decision.errors?.length) { const list = document.createElement('ul');
      for (const missing of (decision.missing || []).slice(0, 12)) list.appendChild(node('li', `${names(missing.requirement)}: ${missing.reason}`));
      for (const error of (decision.errors || []).slice(0, 12)) list.appendChild(node('li', error)); item.appendChild(list); }
    item.appendChild(record({ decision, receipt }, 'Gate evidence and receipt')); return item;
  }
  function renderRecord(host, recordValue, options = {}) {
    const concept = recordValue?.concept;
    if (!concept || !uuid(concept.id) || !stages.includes(concept.stage)) throw new Error('The runtime returned no valid concept identity or stage.');
    const section = node('article', '', 'yc-concept-record'); section.dataset.conceptId = concept.id; section.dataset.revision = concept.revision;
    section.append(node('h3', concept.name), node('p', `${options.snapshot ? 'Recorded snapshot' : 'Current record'} · ${names(concept.stage)} · revision ${concept.revision}`, 'yc-concept-current'));
    if (concept.thesis_statement) section.appendChild(node('p', concept.thesis_statement, 'yc-concept-thesis'));
    section.append(node('p', (concept.domain_tags || []).join(' · '), 'yc-work-note'));
    const progression = node('ol', '', 'yc-concept-stages'); progression.setAttribute('aria-label', 'Concept lifecycle stages');
    const recordedStages = new Set((recordValue.events || []).map(event => event.stage).filter(stage => stages.includes(stage)));
    if (recordValue.decision?.allowed) { recordedStages.add(recordValue.decision.from_stage); recordedStages.add(recordValue.decision.to_stage); }
    for (const stage of stages) { const current = stage === concept.stage, recorded = recordedStages.has(stage); const item = node('li', '', current ? 'current' : recorded ? 'recorded' : 'unreported'); item.append(node('strong', names(stage)), node('span', current ? 'Current record' : recorded ? 'Recorded here' : 'Not shown here')); if (current) item.setAttribute('aria-current', 'step'); progression.appendChild(item); }
    section.append(progression, node('p', 'Stage labels are lifecycle options; only shown events establish prior stages. Regeneration is triggered when relevant. Lifecycle stage is separate from mission completion. Intent and plans do not establish deployed performance, revenue or maturity.', 'yc-concept-limitation'));
    const decisions = recordValue.decision ? [{ decision: recordValue.decision, receipt: concept.receipt }] : (recordValue.events || []).filter(event => event.decision).slice(-3).map(event => ({ decision: event.decision, receipt: event }));
    for (const entry of decisions) section.appendChild(decisionCard(entry.decision, entry.receipt));
    const versions = document.createElement('details'); versions.className = 'yc-concept-versions'; versions.appendChild(node('summary', `${concept.version_count ?? concept.versions?.length ?? 0} immutable specialist versions`));
    if (!concept.versions?.length) versions.appendChild(node('p', 'No specialist version is bound to this concept yet.'));
    for (const version of (concept.versions || []).slice(0, 16)) {
      const item = node('section', '', 'yc-concept-version'), generated = version.kind === 'generated_python'; item.dataset.versionId = version.id;
      item.append(node('h4', `Version ${version.ordinal}${generated ? ' · Generated Python' : ' · Specialist package'}`),
        node('p', generated ? `Source Work ${version.source_work_id} · build step ${version.build_step_index}` : `Build ${version.build_mission_id}`, 'yc-work-note'),
        node('p', version.parent_version_id ? `Successor of version ${version.parent_version_id}` : generated ? 'First retained generated Python version' : 'First retained package version'));
      if (generated) item.append(node('p', 'The acceptance cohort checks the bound source against finite cases. It does not establish broader capability or lifecycle maturity.', 'yc-concept-limitation'));
      item.appendChild(record(version, generated ? 'Generated source, acceptance cohort and receipt hashes' : 'Package hashes and validation receipts')); versions.appendChild(item);
    }
    const evidence = document.createElement('details'); evidence.className = 'yc-concept-evidence'; evidence.appendChild(node('summary', `${concept.evidence_count ?? concept.evidence?.length ?? 0} evidence references`));
    const kinds = { concept_intent: 'Recorded intent', work_artifact: 'Committed plan · not outcome proof', specialist_build: 'Validated specialist package', specialist_execution: 'Recorded specialist execution', generated_build: 'Generated Python acceptance cohort', generated_execution: 'Recorded generated Python execution' };
    if (!concept.evidence?.length) evidence.appendChild(node('p', 'No evidence references have been recorded.'));
    for (const entry of (concept.evidence || []).slice(0, 32)) {
      const item = node('section', '', 'yc-concept-evidence-entry'), source = entry.source; item.append(node('h4', names(entry.requirement)), node('p', kinds[source?.kind] || 'Evidence source'));
      if (source?.kind === 'generated_execution') item.appendChild(node('p', `Execution Work ${source.execution_work_id} · step ${source.execution_step_index}`, 'yc-work-note'));
      if (['generated_build', 'generated_execution'].includes(source?.kind)) item.appendChild(node('p', `Bound version ${source.version_id}`, 'yc-work-note'));
      item.appendChild(record(entry, 'Source reference and receipt')); evidence.appendChild(item);
    }
    section.append(versions, evidence);
    const history = document.createElement('details'); history.className = 'yc-concept-history'; history.appendChild(node('summary', 'Identity, lineage and history'));
    history.appendChild(record({ id: concept.id, parent_id: concept.parent_id, lineage: concept.lineage, revision: concept.revision, history_hash: concept.history_hash, receipt: concept.receipt }, 'Identity and current receipt'));
    if (recordValue.history) history.appendChild(node('p', `Showing revisions ${recordValue.history.from_revision}–${recordValue.history.through_revision}${recordValue.history.omitted_before ? `; ${recordValue.history.omitted_before} earlier revisions omitted from this view` : ''}.`));
    for (const event of (recordValue.events || []).slice(-20)) history.appendChild(record(event, `Revision ${event.revision} · ${String(event.event_type || '').replace(/^concept\./, '').replace(/\./g, ' ')}`));
    section.appendChild(history);
    const controls = node('div', '', 'yc-concept-actions');
    action(controls, 'Open current concept', options.onOpen ? () => options.onOpen(concept) : null);
    action(controls, 'Use in conversation', options.onUse ? () => options.onUse(concept) : null);
    if (controls.childElementCount) section.appendChild(controls);
    host.appendChild(section); return section;
  }
  function workResult(step, parent) {
    const value = step?.result, read = ['inspect_concept', 'list_concepts'].includes(step?.tool);
    if (step?.succeeded !== true || !['create_concept', 'inspect_concept', 'list_concepts', 'bind_concept_version', 'bind_generated_concept_version', 'add_concept_evidence', 'advance_concept'].includes(step.tool) || value?.schema !== 'yur.work-concept-result.v1' || value.tool !== step.tool || value.provenance?.parent_work_id !== parent.id || value.committed !== !read) return null;
    if (value.status === 'denied' && (step.tool !== 'advance_concept' || value.decision?.allowed !== false || value.concept?.stage !== value.decision.from_stage)) return null;
    if (!['completed', 'denied'].includes(value.status) || (value.concept && (!uuid(value.concept.id) || !stages.includes(value.concept.stage)))) return null;
    return value;
  }
  function renderWork(steps, parent, options = {}) {
    const host = node('section', '', 'yc-concept-work-results'), latest = new Map(); let discovery;
    for (const step of steps || []) { const result = workResult(step, parent); if (result?.concept) latest.set(result.concept.id, result); else if (result?.concepts) discovery = result; }
    for (const result of latest.values()) renderRecord(host, result, { snapshot: true, onOpen: options.onOpenConcept, onUse: options.onUseConcept });
    if (discovery) { const section = node('section', '', 'yc-concept-discovery'); section.append(node('h4', 'Retained concepts'), node('p', `${discovery.concepts.length} of ${discovery.total} concepts in this page${discovery.next_cursor ? ' · more available in Agents' : ''}.`)); for (const concept of discovery.concepts.slice(0, 20)) { const item = node('div'); item.appendChild(node('p', `${concept.name} · ${names(concept.stage)}`)); action(item, 'Open current concept', options.onOpenConcept ? () => options.onOpenConcept(concept) : null); section.appendChild(item); } host.appendChild(section); }
    return host;
  }
  async function inspect(api, id, host, options = {}) {
    host.replaceChildren(node('p', 'Reading the committed concept record…'));
    try { const response = await api.concepts.inspect(id); if (options.active && !options.active()) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Concept record unavailable.'); if (response.result?.concept?.id !== id) throw new Error('The concept identity differs from the selected record.');
      host.replaceChildren(); renderRecord(host, response.result, options);
    } catch (error) { if (!options.active || options.active()) host.replaceChildren(node('p', error.message, 'yc-form-error')); }
  }
  window.yurConceptView = Object.freeze({ stages, names, renderRecord, renderWork, workResult, inspect });
})();
