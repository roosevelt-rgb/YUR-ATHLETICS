/* Settings navigation presents existing services; committed workspace state owns preferences. */
'use strict';
(function (target) {
  const sections = [
    ['Personal', 'general', 'General'], ['Personal', 'notifications', 'Notifications'], ['Personal', 'import', 'Import'],
    ['Personal', 'profile', 'Profile'], ['Personal', 'appearance', 'Appearance'], ['Personal', 'parental-controls', 'Parental controls'],
    ['Personal', 'trusted-contact', 'Trusted contact'], ['Personal', 'voice', 'Voice'], ['Personal', 'configuration', 'Configuration'],
    ['Personal', 'personalization', 'Personalization'], ['Personal', 'pets', 'Pets'], ['Personal', 'shortcuts', 'Keyboard shortcuts'],
    ['Personal', 'purchases', 'License & purchases'], ['Personal', 'account', 'Account'],
    ['Integrations', 'computer-use', 'Computer use'], ['Integrations', 'appshots', 'Appshots'], ['Integrations', 'plugins', 'Plugins'], ['Integrations', 'browser', 'Browser'],
    ['Coding', 'hooks', 'Hooks'], ['Coding', 'connections', 'Connections'], ['Coding', 'git', 'Git'], ['Coding', 'environments', 'Environments'], ['Coding', 'worktrees', 'Worktrees'],
    ['Archived', 'archived', 'Archived chats'],
  ];
  const node = (tag, text = '', className = '') => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
  const action = (host, text, handler) => { const button = node('button', text, 'ys-action'); button.type = 'button'; button.addEventListener('click', handler); host.appendChild(button); return button; };
  // options.productName / options.pages / options.hiddenFields (a product edition only): the name its
  // settings text uses for the app (the Desktop says IntelliFlow and YUR AI Desktop), the pages its
  // navigation lists and the rows it leaves out of view. The other pages and rows still exist, so saving
  // keeps every stored preference; they are just not shown.
  function create(host, options) {
    let disposed = false, saving = false, schema, currentPage = 'general';
    const listed = Array.isArray(options.pages) && options.pages.length ? new Set(options.pages) : null;
    const unlisted = new Set(Array.isArray(options.hiddenFields) ? options.hiddenFields : []);
    const productName = typeof options.productName === 'string' && options.productName.trim() ? options.productName.trim().slice(0, 80) : '';
    const named = value => productName && typeof value === 'string' ? value.replace(/\bIntelliFlow\b/g, productName).replace(/\bYUR AI Desktop\b/g, productName) : value;
    const shell = node('div', '', 'ys-shell'), sidebar = node('aside', '', 'ys-sidebar'), main = node('div', '', 'ys-main');
    const form = node('form', '', 'ys-form'), pages = new Map(), controls = new Map(), navigation = new Map();
    const status = node('p', 'Loading your settings…', 'ys-status'); status.setAttribute('role', 'status');
    shell.append(sidebar, main); main.append(status); host.append(shell);
    action(sidebar, '← Back to app', options.onBack);
    const search = node('input'); search.type = 'search'; search.placeholder = 'Search settings'; search.setAttribute('aria-label', 'Search settings'); sidebar.appendChild(search);
    const message = (text, failed = false) => { status.textContent = text; status.dataset.error = String(failed); };
    function open(id) {
      if (!pages.has(id)) return;
      currentPage = id;
      for (const [key, page] of pages) page.hidden = key !== id;
      for (const [key, button] of navigation) button.setAttribute('aria-current', key === id ? 'page' : 'false');
      main.scrollTop = 0; pages.get(id).querySelector('h2')?.focus();
    }
    function row(page, key, rule, value, id) {
      const label = node('label', '', 'ys-row');
      const copy = node('span', '', 'ys-row-copy'); copy.appendChild(node('strong', named(rule.label)));
      if (rule.description) copy.appendChild(node('span', named(rule.description)));
      let input;
      if (rule.type === 'enum') {
        input = node('select');
        for (const [optionValue, title] of Object.entries(rule.choices)) { const option = node('option', title); option.value = optionValue; input.appendChild(option); }
        input.value = value;
      } else if (rule.type === 'boolean') { input = node('input'); input.type = 'checkbox'; input.checked = value; input.setAttribute('role', 'switch'); }
      else if (rule.type === 'integer' || rule.type === 'number') { input = node('input'); input.type = 'number'; input.min = rule.minimum; input.max = rule.maximum; input.step = rule.type === 'integer' ? '1' : '0.1'; input.value = value; }
      else { input = node(rule.max_length > 500 ? 'textarea' : 'input'); if (input.tagName === 'INPUT') input.type = 'text'; input.maxLength = rule.max_length || 32000; input.value = value || ''; }
      input.id = id || `yc-pref-${key}`; input.name = key; input.setAttribute('aria-label', rule.label);
      if (unlisted.has(key)) label.style.display = 'none';
      controls.set(key, { input, rule }); label.append(copy, input); page.appendChild(label); return input;
    }
    function collect() {
      const saved = options.getSettings(), preferences = { ...saved.preferences };
      const read = ({ input, rule }) => rule.type === 'boolean' ? input.checked : ['number', 'integer'].includes(rule.type) ? Number(input.value) : input.value;
      for (const key of Object.keys(schema.fields)) if (controls.has(key)) preferences[key] = read(controls.get(key));
      return { ...saved, default_model: read(controls.get('$model')), foundry_url: read(controls.get('$foundry')), ollama_url: read(controls.get('$ollama')), custom_instructions: read(controls.get('$instructions')), preferences };
    }
    function refreshVoices() {
      const control = controls.get('voice_id');
      if (!control || disposed) return;
      const selected = control.input.value;
      control.input.replaceChildren();
      const choices = { '': 'System default', ...Object.fromEntries((options.voices?.() || []).map(voice => [voice.id, `${voice.name} · ${voice.lang}`])) };
      if (selected && !choices[selected]) choices[selected] = `${selected} · unavailable`;
      for (const [value, label] of Object.entries(choices)) { const entry = node('option', label); entry.value = value; control.input.appendChild(entry); }
      control.input.value = selected;
    }
    function refreshControls() {
      const saved = options.getSettings();
      const special = { $model: 'default_model', $foundry: 'foundry_url', $ollama: 'ollama_url', $instructions: 'custom_instructions' };
      for (const [key, { input, rule }] of controls) {
        const value = special[key] ? saved[special[key]] || '' : saved.preferences?.[key] ?? schema.fields[key].default;
        if (rule.type === 'boolean') input.checked = value;
        else {
          if (input.tagName === 'SELECT' && ![...input.options].some(option => option.value === value)) { const option = node('option', `${value} · unavailable`); option.value = value; input.appendChild(option); }
          input.value = value;
        }
      }
      refreshVoices();
    }
    async function commit(document = collect()) {
      if (saving) return; saving = true; save.disabled = true; message('Saving…');
      for (const { input } of controls.values()) input.disabled = true;
      try { await options.save(document); if (!disposed) { refreshControls(); message('Settings saved.'); } return true; }
      catch (error) { if (!disposed) message(error.message, true); return false; }
      finally { saving = false; save.disabled = false; for (const { input } of controls.values()) input.disabled = false; }
    }
    const save = node('button', 'Save settings', 'yc-primary'); save.type = 'submit';
    form.addEventListener('submit', event => { event.preventDefault(); void commit(); });
    function note(id, text) { pages.get(id).appendChild(node('p', text, 'ys-note')); }
    function panel(id, title) { const card = node('section', '', 'ys-card'); if (title) card.appendChild(node('h3', title)); pages.get(id).appendChild(card); return card; }
    async function initialize() {
      schema = await options.api.describe(); if (disposed) return;
      if (!schema || schema.schema !== 'yur.desktop-preferences.v1') throw new Error('This app is missing the current settings contract.');
      let group;
      for (const [sectionGroup, id, title] of sections) {
        if (group !== sectionGroup && (!listed || sections.some(([other, key]) => other === sectionGroup && listed.has(key)))) { group = sectionGroup; sidebar.appendChild(node('h3', group, 'ys-group')); }
        const button = action(sidebar, title, () => open(id)); button.dataset.settingsPage = id; navigation.set(id, button);
        if (listed && !listed.has(id)) button.remove();
        const page = node('section', '', 'ys-page'); page.id = `yc-settings-page-${id}`; page.hidden = true;
        const heading = node('h2', title); heading.tabIndex = -1; page.appendChild(heading); pages.set(id, page); form.appendChild(page);
      }
      const saved = options.getSettings();
      for (const [key, rule] of Object.entries(schema.fields)) if (key !== 'accent') row(pages.get(rule.section), key, key === 'voice_id' ? { ...rule, type: 'enum', choices: { '': 'System default', ...Object.fromEntries((options.voices?.() || []).map(voice => [voice.id, `${voice.name} · ${voice.lang}`])), ...(saved.preferences?.voice_id ? { [saved.preferences.voice_id]: saved.preferences.voice_id } : {}) } } : rule, saved.preferences?.[key] ?? rule.default);
      const scheme = panel('appearance', 'Color scheme');
      const schemeName = node('p', 'Blue slate and silver', 'ys-note'); schemeName.id = 'yc-settings-scheme'; scheme.appendChild(schemeName);
      scheme.appendChild(node('p', 'Desktop uses this consistent color scheme across its pages. Text size and spacing remain adjustable. Earlier theme and accent preferences are preserved for settings compatibility.', 'ys-note'));
      const choices = { '': 'Use the current model selection', ...Object.fromEntries(options.models().map(item => [item.id, item.label])) };
      if (saved.default_model && !choices[saved.default_model]) choices[saved.default_model] = `${saved.default_model} · unavailable`;
      row(pages.get('configuration'), '$model', { label: 'Default model for new conversations', type: 'enum', choices }, saved.default_model, 'yc-field-default-model');
      row(pages.get('connections'), '$foundry', { label: 'YUR harness URL', description: 'Leave empty to use the configured default.', type: 'string', max_length: 2048 }, saved.foundry_url, 'yc-field-foundry-url');
      row(pages.get('connections'), '$ollama', { label: 'Ollama URL', description: 'Leave empty to use the configured default.', type: 'string', max_length: 2048 }, saved.ollama_url, 'yc-field-ollama-url');
      row(pages.get('personalization'), '$instructions', { label: 'Instructions for new responses', type: 'string', max_length: 16000 }, saved.custom_instructions, 'yc-field-custom-instructions');
      options.mountModels(panel('configuration', 'Available models'));
      options.mountExecution(panel('environments', 'Execution runtime'));
      options.mountVoice(panel('voice', 'Available voices'));
      note('personalization', 'Your instructions guide replies. They do not grant additional access or change execution approvals.');
      note('hooks', 'The before-send hook is applied to Chat, Work and Code alongside your personal instructions.');
      note('computer-use', 'These controls govern the browser and code capabilities available in YUR. Access to other Windows applications is not supplied by this build.');
      note('parental-controls', 'This is an app-level restriction, not an operating-system child account or a tamper-proof parental-control service.');
      note('account', 'YUR uses your local profile. Your chats and settings are stored on this computer.');
      action(pages.get('account'), 'Edit local profile', () => open('profile'));
      note('purchases', `${productName || 'YUR AI Desktop'} ${schema.version} is offered as a purchased application. No subscription is configured.`);
      note('purchases', 'Purchase activation needs the selected sales or license issuer. This development copy does not claim that a license has been verified.');
      const counts = options.usage(); note('purchases', `${counts.conversations} loaded conversations · ${counts.messages} messages. Provider charges are not inferred from message counts.`);
      action(pages.get('notifications'), 'Send test notification', async () => { try { const result = await options.api.notify('test'); message(result.shown ? 'Test notification sent.' : result.reason || 'Enable and save desktop notifications first.'); } catch (error) { message(error.message, true); } });
      action(pages.get('general'), 'Open-source licenses', async () => {
        try { const entries = await options.api.licenses(); const card = panel('general', 'Installed dependency licenses'); for (const entry of entries) { const details = node('details'); details.append(node('summary', `${entry.name} ${entry.version} · ${entry.license}`), node('pre', entry.text)); card.appendChild(details); } }
        catch (error) { message(error.message, true); }
      });
      const shortcutCard = panel('shortcuts', 'Current shortcuts');
      for (const text of ['Ctrl / Command + N — New conversation', 'Ctrl / Command + S — Save the active Studio file', 'Ctrl / Command + O — Open a Studio folder', 'Ctrl / Command + ` — Toggle the Studio terminal', 'Escape — Close the side panel', 'Shift + Enter — New line in the composer']) shortcutCard.appendChild(node('p', text));
      action(shortcutCard, 'Change the send shortcut', () => open('general'));
      const imported = node('textarea'); imported.id = 'yc-settings-import'; imported.maxLength = 65536; imported.setAttribute('aria-label', 'YUR settings JSON'); imported.placeholder = 'Paste an exported YUR settings document'; pages.get('import').appendChild(imported);
      action(pages.get('import'), 'Copy current settings', async () => { const { revision, ...settings } = options.getSettings(); imported.value = JSON.stringify({ schema: 'yur.settings-export.v1', settings }, null, 2); try { await navigator.clipboard.writeText(imported.value); message('Settings copied. Keep exported instructions and contact details private.'); } catch { message('Select the settings text and copy it.'); } });
      action(pages.get('import'), 'Import settings', async () => { if (saving) return; try { const value = JSON.parse(imported.value); if (value.schema !== 'yur.settings-export.v1' || !value.settings || value.settings.id !== 'desktop') throw new Error('Paste a YUR settings export.'); if (await commit({ ...value.settings, revision: options.getSettings().revision || 0 })) message('Settings imported. All fields now show the saved values.'); } catch (error) { message(error.message, true); } });
      for (const id of ['git', 'worktrees']) {
        const card = panel(id, 'Selected repository'); const folder = node('input'); folder.value = options.repositoryRoot() || ''; folder.placeholder = 'Absolute repository folder'; folder.setAttribute('aria-label', `${id} repository folder`); card.appendChild(folder);
        const output = node('pre'); output.setAttribute('role', 'status');
        action(card, 'Inspect repository', async () => { output.textContent = 'Inspecting…'; try { const result = await options.api.repository(folder.value.trim()); if (!result.ok) throw new Error(result.error.message); output.textContent = id === 'git' ? result.result.status : result.result.worktrees; } catch (error) { output.textContent = error.message; } }); card.appendChild(output);
        note(id, 'Inspection reads repository metadata. It does not switch branches, alter files or create/delete worktrees.');
      }
      const archived = panel('archived', 'Archived conversations');
      const list = options.archived();
      if (!list.length) archived.appendChild(node('p', 'No archived conversations.'));
      for (const item of list) { const row = node('div', '', 'ys-archive-row'); row.appendChild(node('span', item.title)); action(row, 'Open', () => options.openConversation(item.id)); action(row, 'Restore', async () => { try { await options.restoreConversation(item.id); row.remove(); message('Conversation restored.'); } catch (error) { message(error.message, true); } }); archived.appendChild(row); }
      action(pages.get('plugins'), 'Browse installed libraries', options.openLibraries);
      action(pages.get('browser'), 'Open browser', options.openBrowser);
      note('appshots', 'Capture the YUR window and copy the image. Nothing is sent to a model or another application automatically.');
      action(pages.get('appshots'), 'Capture this window', async () => { try { const result = await options.api.capture(); const image = node('img'); image.src = result.url; image.alt = 'Your captured YUR window'; image.className = 'ys-appshot'; pages.get('appshots').appendChild(image); action(pages.get('appshots'), 'Copy image', async () => { try { const bytes = Uint8Array.from(atob(result.url.split(',')[1]), char => char.charCodeAt(0)); await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]); message('Window image copied.'); } catch (error) { message(error.message, true); } }); } catch (error) { message(error.message, true); } });
      form.id = 'yc-settings-form'; const footer = node('footer', '', 'ys-footer'); status.classList.add('yc-form-error'); footer.append(status, save); form.appendChild(footer); main.appendChild(form);
      search.addEventListener('input', () => { const query = search.value.trim().toLowerCase(); for (const [id, button] of navigation) button.hidden = Boolean(query && !`${button.textContent} ${pages.get(id).textContent}`.toLowerCase().includes(query)); });
      if (listed && !listed.has(currentPage)) currentPage = [...listed].find(id => pages.has(id)) || currentPage;
      message('Changes take effect when you save.'); open(currentPage);
    }
    const ready = initialize().catch(error => { if (!disposed) message(error.message, true); });
    return { ready, open, refreshVoices, dispose() { disposed = true; shell.remove(); } };
  }
  target.yurSettingsView = { create, sections };
})(typeof window === 'undefined' ? globalThis : window);
