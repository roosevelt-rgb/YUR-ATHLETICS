/* An input and preview surface. The caller owns Work admission and results. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YurSpecialistForgeView = api;
})(typeof window === 'object' ? window : null, function () {
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const STARTERS = freeze([
    { id: 'text.analyze', title: 'Understand a piece of text', shortName: 'Text analysis', mark: 'Aa',
      description: 'Count words and sentences, and find repeated words or phrases.',
      outcome: 'Word and sentence counts, with repeated terms. This does not judge accuracy or summarize meaning.',
      fields: [{ key: 'text', label: 'Text to try', value: 'Clear evidence helps. Clear evidence matters.', className: 'sf-sample-text' }] },
    { id: 'data.profile', title: 'Check a small dataset', shortName: 'Data quality', mark: '01',
      description: 'Check table rows for value types, missing values and duplicates.',
      outcome: 'A profile of the supplied rows. It does not repair records or connect to a database.',
      fields: [], sample: { rows: [{ id: '1', name: 'Ada' }, { id: '1', name: 'Ada' }, { id: '2', name: '' }] },
      samplePreview: 'Three sample rows: Ada appears twice; the third row has an empty name.' },
    { id: 'support.triage', title: 'Sort a support request', shortName: 'Support triage', mark: '↗',
      description: 'Suggest a ticket priority and support team using matched rules.',
      outcome: 'A suggested priority and route, with matched evidence. It sends no messages.',
      fields: [{ key: 'subject', label: 'Ticket subject', value: 'Outage', maxLength: 500, className: 'sf-sample-subject' },
        { key: 'body', label: 'Ticket details', value: 'Production down', className: 'sf-sample-body' }] },
    { id: 'workforce.hatch.quantity', title: 'Read stated quantities', shortName: 'Quantity survey', mark: '∑',
      description: 'Find explicit quantities in plans and specifications text, with source references.',
      outcome: 'Stated quantities grouped by construction division. It does not measure drawings or invent quantities.',
      fields: [{ key: 'plans_text', label: 'Plans text', value: 'Division 03\nConcrete 125 CY', className: 'sf-sample-plans' },
        { key: 'specs_text', label: 'Specifications text', value: '09 51 00\nGypsum 1,200 SF', className: 'sf-sample-specs' }] },
    { id: 'construction.opc.inspect', title: 'Check quoted cost arithmetic', shortName: 'Cost arithmetic', mark: '=',
      description: 'Compare quoted construction line totals with quantity × unit price.',
      outcome: 'Arithmetic discrepancies and exact source rows. It does not estimate prices or approve costs.',
      fields: [{ key: 'text', label: 'Quoted cost row', value: '1.1 | CUT | 2.5 | CY | $4.00 | $10.00', className: 'sf-sample-opc' }],
      samplePreview: 'Each row uses: item | description | quantity | unit | unit price | quoted total.' },
  ].map(starter => ({ ...starter, label: starter.title })));
  const starterById = new Map(STARTERS.map(starter => [starter.id, starter]));
  const mounts = new WeakMap();
  let sequence = 0;

  function boundedText(value, label, maximum, required = false, singleLine = false) {
    if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
        || (singleLine && /[\r\n\t]/.test(value)) || (required && !value.trim())) {
      throw new Error(`${label} must ${required ? 'contain text and ' : ''}use at most ${maximum} characters${singleLine ? ' on one line' : ''}.`);
    }
    return value;
  }

  function buildRequest(values = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Enter the details for your agent.');
    const name = boundedText(values.name, 'Agent name', 100, true, true).trim();
    const description = boundedText(values.description ?? '', 'Description', 2000).trim();
    const starter = starterById.get(values.primaryCapability);
    if (!starter) throw new Error('Choose one of the available starter abilities.');
    const additional = values.additionalCapabilities ?? [];
    if (!Array.isArray(additional) || additional.length > 2 || additional.some(id => !starterById.has(id))
        || new Set([starter.id, ...additional]).size !== additional.length + 1) {
      throw new Error('Choose up to three different abilities, including your starter.');
    }
    const sampleFields = values.sampleFields ?? {};
    if (!sampleFields || typeof sampleFields !== 'object' || Array.isArray(sampleFields)
        || Object.keys(sampleFields).some(key => !starter.fields.some(field => field.key === key))) {
      throw new Error('The sample fields do not match the selected starter.');
    }
    const input = starter.sample ? JSON.parse(JSON.stringify(starter.sample)) : {};
    for (const field of starter.fields) {
      input[field.key] = boundedText(Object.hasOwn(sampleFields, field.key) ? sampleFields[field.key] : field.value,
        field.label, field.maxLength || 4000, starter.id === 'text.analyze' || starter.id === 'construction.opc.inspect' || field.key === 'subject');
    }
    if (starter.id === 'workforce.hatch.quantity' && !input.plans_text.trim() && !input.specs_text.trim()) {
      throw new Error('Add some plans or specifications text for the sample.');
    }
    return { name, description, capabilities: [starter.id, ...additional], sample: { capability_id: starter.id, input } };
  }

  function buildPresentation(request) {
    if (!request || !Array.isArray(request.capabilities) || request.sample?.capability_id !== request.capabilities[0]) {
      throw new Error('The agent request and its sample must use the same main ability.');
    }
    const starter = starterById.get(request.capabilities[0]);
    const checked = buildRequest({ name: request.name, description: request.description,
      primaryCapability: request.capabilities[0], additionalCapabilities: request.capabilities.slice(1),
      sampleFields: starter?.fields.length ? request.sample.input : {} });
    const lines = [`Build an agent named “${checked.name}”.`];
    if (checked.description) lines.push('', 'What I need help with:', checked.description);
    else lines.push('', 'No additional description was provided. Keep the description empty.');
    lines.push('', 'Its abilities:', ...checked.capabilities.map(id => `• ${starterById.get(id).title}`),
      '', 'Complete both actions in order before answering. First build this agent. Wait for that build result, then use the newly built agent on this sample:');
    if (starter.fields.length) for (const field of starter.fields) lines.push(`${field.label}:`, checked.sample.input[field.key] || '(empty)');
    else lines.push(starter.samplePreview);
    lines.push('', 'Show the actual sample result and any limitations. Do not request the sample before the build result is available, and do not stop after the build. If the build or sample fails, explain what happened.');
    return lines.join('\n');
  }

  function mount(container, { onBuild, onCancel } = {}) {
    if (!container?.ownerDocument || typeof onBuild !== 'function' || typeof onCancel !== 'function') {
      throw new TypeError('Agent creation requires a container, onBuild and onCancel.');
    }
    if (mounts.has(container)) return mounts.get(container);
    const document = container.ownerDocument, prefix = `sf-${++sequence}`;
    const node = (tag, className, value) => {
      const element = document.createElement(tag); if (className) element.className = className;
      if (value !== undefined) element.textContent = value; return element;
    };
    const controls = [], radios = new Map(), extraChoices = new Map(), sampleInputs = new Map(), sampleGroups = new Map();
    const root = node('section', 'sf-forge'); root.setAttribute('aria-label', 'Create a specialist agent');
    const header = node('header', 'sf-header');
    header.append(node('p', 'sf-eyebrow', 'YOUR NEXT HELPER'), node('h2', 'sf-heading', 'Make an agent for your work.'),
      node('p', 'sf-intro', 'Give it a name, choose an ability, then try a small sample together.'));
    const layout = node('div', 'sf-layout'), form = node('form', 'sf-form'); form.noValidate = true;
    const info = node('div', 'sf-info-fields');
    function labeledField(parent, key, label, tag, maximum, placeholder) {
      const wrapper = node('div', 'sf-field'), caption = node('label', 'sf-label', label), input = node(tag, `sf-${key}`);
      input.id = `${prefix}-${key}`; caption.htmlFor = input.id; input.maxLength = maximum;
      if (tag === 'input') input.type = 'text'; else input.rows = 3;
      if (placeholder) input.placeholder = placeholder;
      wrapper.append(caption, input); parent.appendChild(wrapper); controls.push(input); return input;
    }
    const name = labeledField(info, 'name', 'Agent name', 'input', 100, 'For example, My text analyst');
    name.required = true; name.autocomplete = 'off';
    const description = labeledField(info, 'description', 'What should it help you with? (optional)', 'textarea', 2000, 'A little context about your work…');
    info.appendChild(node('p', 'sf-help', 'Your description gives it context. The abilities you choose below define what it can execute.'));
    const starters = node('fieldset', 'sf-starters'); starters.append(node('legend', 'sf-label', 'Choose its main ability'));
    for (const starter of STARTERS) {
      const label = node('label', 'sf-starter'), input = node('input', 'sf-starter-radio');
      input.type = 'radio'; input.name = `${prefix}-starter`; input.value = starter.id; input.checked = starter === STARTERS[0];
      const copy = node('span', 'sf-starter-copy'); copy.append(node('strong', 'sf-starter-title', starter.title), node('span', 'sf-starter-description', starter.description));
      const mark = node('span', 'sf-starter-mark', starter.mark); mark.setAttribute('aria-hidden', 'true');
      label.append(input, mark, copy); starters.appendChild(label); radios.set(starter.id, input); controls.push(input);
      input.addEventListener('change', () => {
        if (busy() || !input.checked) return;
        primary = starter.id;
        for (const [id, radio] of radios) radio.checked = id === primary;
        extraChoices.get(primary).input.checked = false;
        draw();
      });
    }
    const extra = node('details', 'sf-extra-details'); extra.appendChild(node('summary', '', 'Add another ability (optional)'));
    extra.appendChild(node('p', 'sf-help', 'Choose up to three abilities in total. The sample below tries your main ability.'));
    const extraFields = node('fieldset', 'sf-extra-choices'); extraFields.appendChild(node('legend', 'sf-sr-only', 'Additional abilities'));
    for (const starter of STARTERS) {
      const label = node('label', 'sf-extra-choice'), input = node('input', 'sf-extra-checkbox'); input.type = 'checkbox'; input.value = starter.id;
      label.append(input, node('span', '', starter.shortName)); extraFields.appendChild(label); extraChoices.set(starter.id, { input, label }); controls.push(input);
      input.addEventListener('change', () => { if (!busy()) draw(); });
    }
    extra.appendChild(extraFields);
    const samples = node('details', 'sf-sample-details'); samples.appendChild(node('summary', '', 'Try a sample'));
    samples.appendChild(node('p', 'sf-help', 'A small example is ready. You can edit it before building; its actual result will appear in the conversation.'));
    const sampleHost = node('div', 'sf-sample-fields'); samples.appendChild(sampleHost);
    for (const starter of STARTERS) {
      const group = node('div', 'sf-sample-group'), fields = new Map();
      if (starter.samplePreview) group.appendChild(node('p', 'sf-help', starter.samplePreview));
      if (starter.sample) {
        const table = node('table', 'sf-sample-table'), caption = node('caption', '', 'Example rows');
        const head = node('thead'), headRow = node('tr');
        for (const text of ['ID', 'Name']) { const cell = node('th', '', text); cell.scope = 'col'; headRow.appendChild(cell); }
        head.appendChild(headRow); const body = node('tbody');
        for (const row of starter.sample.rows) { const tr = node('tr'); tr.append(node('td', '', row.id), node('td', '', row.name || '(empty)')); body.appendChild(tr); }
        table.append(caption, head, body); group.appendChild(table);
      }
      for (const field of starter.fields) {
        const wrapper = node('div', 'sf-field'), label = node('label', 'sf-label', field.label), input = node('textarea', field.className);
        input.id = `${prefix}-sample-${starter.id.replaceAll('.', '-')}-${field.key}`; input.maxLength = field.maxLength || 4000; input.rows = field.key === 'subject' ? 2 : 4;
        input.value = field.value; label.htmlFor = input.id; wrapper.append(label, input); group.appendChild(wrapper);
        fields.set(field.key, input); controls.push(input); input.addEventListener('input', () => { if (!busy()) drawPreview(); });
      }
      sampleInputs.set(starter.id, fields); sampleGroups.set(starter.id, group);
    }
    const actions = node('div', 'sf-actions'), build = node('button', 'sf-submit', 'Build and check'), cancel = node('button', 'sf-cancel', 'Back to my agents');
    build.type = 'submit'; cancel.type = 'button'; controls.push(build, cancel); actions.append(build, cancel);
    const error = node('p', 'sf-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const status = node('p', 'sf-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    form.append(info, starters, extra, samples, actions, error, status);
    const preview = node('aside', 'sf-preview'); preview.setAttribute('aria-label', 'Your agent preview');
    const avatar = node('div', 'sf-preview-avatar', 'Aa'); avatar.setAttribute('aria-hidden', 'true');
    const previewName = node('h3', 'sf-preview-name'), previewDescription = node('p', 'sf-preview-description'), abilities = node('ul', 'sf-preview-abilities');
    const samplePreview = node('p', 'sf-preview-sample');
    preview.append(node('p', 'sf-eyebrow', 'YOUR AGENT PREVIEW'), avatar, previewName, previewDescription, node('h4', '', 'What it can do'), abilities,
      node('h4', '', 'What we’ll try'), samplePreview, node('p', 'sf-preview-note', 'Build and check starts a Work conversation. You can review the build, sample output and any errors there.'));
    layout.append(form, preview); root.append(header, layout); container.appendChild(root);
    let primary = STARTERS[0].id, submitting = false, externallyBusy = false, generation = 0;
    const busy = () => submitting || externallyBusy;
    function selectedExtras() { return [...extraChoices].filter(([id, choice]) => id !== primary && choice.input.checked).map(([id]) => id); }
    function values() { return { name: name.value, description: description.value, primaryCapability: primary,
      additionalCapabilities: selectedExtras(), sampleFields: Object.fromEntries([...sampleInputs.get(primary)].map(([key, input]) => [key, input.value])) }; }
    function drawPreview() {
      const starter = starterById.get(primary);
      previewName.textContent = name.value.trim() || 'Your new agent';
      previewDescription.textContent = description.value.trim() || 'A focused helper for the work you choose.';
      avatar.textContent = starter.mark;
      abilities.replaceChildren(...[primary, ...selectedExtras()].map(id => node('li', '', starterById.get(id).description)));
      const field = starter.fields[0], value = field ? sampleInputs.get(primary).get(field.key).value : '';
      samplePreview.textContent = starter.samplePreview && !field ? starter.samplePreview : `${starter.outcome}${value.trim() ? '\n\nSample: ' + value.slice(0, 180) + (value.length > 180 ? '…' : '') : '\n\nAdd a sample in “Try a sample”.'}`;
    }
    function draw() {
      root.setAttribute('aria-busy', String(busy()));
      for (const control of controls) control.disabled = busy();
      const full = selectedExtras().length >= 2;
      for (const [id, choice] of extraChoices) { choice.label.hidden = id === primary; choice.input.disabled = busy() || id === primary || (full && !choice.input.checked); }
      sampleHost.replaceChildren(sampleGroups.get(primary));
      build.textContent = submitting ? 'Starting conversation…' : 'Build and check';
      drawPreview();
    }
    function reportError(failure) {
      const message = typeof failure?.message === 'string' ? failure.message : 'The conversation could not be started. Your details are still here; try again.';
      error.textContent = message.slice(0, 1000); error.hidden = false; status.textContent = '';
    }
    name.addEventListener('input', () => { if (!busy()) drawPreview(); });
    description.addEventListener('input', () => { if (!busy()) drawPreview(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy()) return;
      error.hidden = true; error.textContent = ''; status.textContent = '';
      let request;
      try { request = buildRequest(values()); } catch (failure) { reportError(failure); if (!name.value.trim()) name.focus(); return; }
      const operation = ++generation; submitting = true; status.textContent = 'Starting a conversation for your agent and its sample…'; draw();
      try {
        await onBuild(request);
        if (operation === generation) status.textContent = 'Conversation started. Follow its work record for the build and sample results.';
      } catch (failure) { if (operation === generation) reportError(failure); }
      finally { if (operation === generation) { submitting = false; draw(); } }
    });
    cancel.addEventListener('click', async () => {
      if (busy()) return;
      try { await onCancel(); } catch (failure) { reportError(failure); }
    });
    const controller = Object.freeze({
      focus() { name.focus(); },
      reset() {
        generation++; submitting = false; externallyBusy = false; primary = STARTERS[0].id; name.value = ''; description.value = '';
        for (const [id, radio] of radios) radio.checked = id === primary;
        for (const choice of extraChoices.values()) choice.input.checked = false;
        for (const starter of STARTERS) for (const field of starter.fields) sampleInputs.get(starter.id).get(field.key).value = field.value;
        extra.open = false; samples.open = false; error.hidden = true; error.textContent = ''; status.textContent = ''; draw();
      },
      setBusy(value, message = '') {
        externallyBusy = value === true;
        if (typeof message === 'string') status.textContent = message.slice(0, 1000);
        draw();
      },
    });
    mounts.set(container, controller); draw(); return controller;
  }
  return Object.freeze({ STARTERS, starters: STARTERS, buildRequest, buildPresentation, mount });
});
