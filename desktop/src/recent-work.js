'use strict';

// Read-only discovery over the existing committed Work summaries.
(function (root, factory) {
  const view = factory();
  if (typeof module === 'object' && module.exports) module.exports = view;
  else root.yurRecentWork = view;
})(typeof window === 'object' ? window : globalThis, () => {
  const MID = /^[a-f0-9]{32}$/;
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const STATES = Object.freeze({ queued: 'Queued', running: 'Running', awaiting_approval: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' });
  let sequence = 0;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  // Python's summary limits count Unicode code points, not UTF-16 code units.
  const string = (value, maximum) => typeof value === 'string' && value.length <= maximum * 2 && [...value].length <= maximum;
  const timestamp = value => string(value, 40) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

  function summaries(response) {
    if (!response || response.ok !== true) throw new Error(string(response?.error?.message, 2000) ? response.error.message : 'Recent Work could not be loaded.');
    const rows = response.result?.missions;
    if (!Array.isArray(rows) || rows.length > 200) throw new Error('Recent Work returned an invalid or oversized listing.');
    const seen = new Set();
    return rows.map(row => {
      if (!object(row) || !MID.test(row.id || '') || seen.has(row.id) || !UUID.test(row.request_id || '') || !UUID.test(row.conversation_id || '') || !Object.hasOwn(STATES, row.status)
          || !timestamp(row.created_at) || !timestamp(row.updated_at) || Date.parse(row.updated_at) < Date.parse(row.created_at)
          || !Number.isSafeInteger(row.revision) || row.revision < 1 || !['work', 'code'].includes(row.mode)
          || !string(row.goal, 500) || !string(row.answer, 500) || !string(row.error, 500)
          || !Number.isSafeInteger(row.step_count) || row.step_count < 0 || row.step_count > 20
          || !Array.isArray(row.artifacts) || row.artifacts.length > 20) throw new Error('Recent Work returned a malformed mission summary.');
      seen.add(row.id);
      const artifactIds = new Set();
      const artifacts = row.artifacts.map(item => {
        if (!object(item) || !MID.test(item.id || '') || artifactIds.has(item.id) || !['artifact', 'edit'].includes(item.kind)
            || !string(item.status, 64) || !item.status || !(item.name === null || string(item.name, 4096))) throw new Error('Recent Work returned a malformed artifact reference.');
        artifactIds.add(item.id);
        return { id: item.id, kind: item.kind, status: item.status, name: item.name || 'Unnamed artifact' };
      });
      return { id: row.id, request_id: row.request_id, conversation_id: row.conversation_id, status: row.status,
        created_at: row.created_at, updated_at: row.updated_at, revision: row.revision, mode: row.mode,
        goal: row.goal, answer: row.answer, error: row.error, step_count: row.step_count, artifacts };
    });
  }

  function create(host, { list, onOpenWork, onOpenConversation } = {}) {
    if (!host?.ownerDocument || typeof list !== 'function'
        || (onOpenWork !== undefined && typeof onOpenWork !== 'function')
        || (onOpenConversation !== undefined && typeof onOpenConversation !== 'function')) throw new TypeError('Recent Work requires a host and read-only listing callback.');
    const document = host.ownerDocument, prefix = `yc-recent-${++sequence}`;
    let disposed = false, generation = 0, loaded = false, rows = [];
    const text = (tag, value = '', className = '') => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
    const section = text('section', '', 'yc-recent-work'); section.setAttribute('aria-label', 'Recent Work');
    const heading = text('div', '', 'yc-recent-heading');
    heading.append(text('h2', 'Recent Work'), text('p', 'Find saved tasks, results and artifact records across conversations.', 'yc-recent-intro'));
    const scope = text('p', 'Up to the 200 most recently created work records. Search and sorting apply only to this loaded set. Status is the last recorded state, not proof that a process is active. Opening a record does not run or resume work.', 'yc-recent-scope');
    const controls = text('div', '', 'yc-recent-controls');
    function field(label, tag, className, suffix) {
      const wrapper = text('label', label, 'yc-recent-field'); const input = text(tag, '', className); input.id = `${prefix}-${suffix}`; wrapper.htmlFor = input.id; wrapper.appendChild(input); controls.appendChild(wrapper); return input;
    }
    const search = field('Search work', 'input', 'yc-recent-search', 'search'); search.type = 'search'; search.placeholder = 'Task, result or artifact name'; search.maxLength = 500; search.autocomplete = 'off';
    const status = field('Recorded state', 'select', 'yc-recent-status', 'status');
    for (const [value, label] of [['all', 'All states'], ...Object.entries(STATES)]) { const option = text('option', label); option.value = value; status.appendChild(option); } status.value = 'all';
    const sort = field('Sort loaded records', 'select', 'yc-recent-sort', 'sort');
    for (const [value, label] of [['updated', 'Recently updated'], ['oldest', 'Oldest update'], ['goal', 'Task name']]) { const option = text('option', label); option.value = value; sort.appendChild(option); } sort.value = 'updated';
    const refreshButton = text('button', 'Refresh', 'yc-recent-refresh'); refreshButton.type = 'button'; controls.appendChild(refreshButton);
    const count = text('p', '', 'yc-recent-count'); count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite'); count.setAttribute('aria-atomic', 'true');
    const error = text('p', '', 'yc-recent-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const results = text('div', '', 'yc-recent-results'); results.setAttribute('role', 'list'); results.setAttribute('aria-label', 'Recorded work');
    section.append(heading, scope, controls, count, error, results); host.appendChild(section);
    const active = () => !disposed && section.parentNode === host;
    function showError(message) { if (active()) { error.textContent = message; error.hidden = !message; } }
    function action(label, className, callback) {
      const button = text('button', label, className); button.type = 'button'; button.disabled = !callback;
      button.addEventListener('click', async () => {
        if (!active() || button.disabled || !callback) return;
        button.disabled = true; showError('');
        try { await callback(); }
        catch (failure) { showError(typeof failure?.message === 'string' ? failure.message.slice(0, 2000) : 'The saved record could not be opened.'); }
        finally { if (active()) button.disabled = false; }
      });
      return button;
    }
    function card(row) {
      const item = text('article', '', 'yc-recent-card'); item.dataset.missionId = row.id; item.setAttribute('role', 'listitem');
      const title = text('h3', row.goal || 'Untitled work'); title.id = `${prefix}-${row.id}`; item.setAttribute('aria-labelledby', title.id);
      const top = text('div', '', 'yc-recent-card-heading'); const state = text('span', `Recorded: ${STATES[row.status]}`, 'yc-recent-state'); state.dataset.status = row.status; top.append(title, state);
      const metadata = text('p', '', 'yc-recent-meta'); const updated = text('time', new Date(row.updated_at).toLocaleString()); updated.dateTime = row.updated_at; updated.title = row.updated_at;
      metadata.append(text('span', `${row.mode === 'code' ? 'Code' : 'Work'} · ${row.step_count} recorded ${row.step_count === 1 ? 'step' : 'steps'} · Updated `), updated);
      item.append(top, metadata);
      if (row.answer) item.appendChild(text('p', row.answer, 'yc-recent-answer'));
      if (row.error) item.appendChild(text('p', row.error, 'yc-recent-failure'));
      const buttons = text('div', '', 'yc-recent-actions');
      buttons.append(action('Open work record', 'yc-recent-open-work', onOpenWork && (() => onOpenWork(row.id))),
        action('Open conversation', 'yc-recent-open-conversation', onOpenConversation && (() => onOpenConversation(row.conversation_id)))); item.appendChild(buttons);
      if (row.artifacts.length) {
        const artifacts = text('div', '', 'yc-recent-artifacts'); artifacts.setAttribute('aria-label', 'Artifact records');
        for (const artifact of row.artifacts) {
          const button = action(artifact.name, 'yc-recent-open-artifact', onOpenWork && (() => onOpenWork(row.id, artifact.id)));
          button.dataset.artifactId = artifact.id; button.title = `Open ${artifact.kind === 'edit' ? 'edit proposal' : 'artifact'} record: ${artifact.name}`;
          button.setAttribute('aria-label', button.title); artifacts.appendChild(button);
        }
        item.appendChild(artifacts);
      }
      return item;
    }
    function render() {
      if (!active()) return;
      const query = search.value.trim().toLowerCase();
      const visible = rows.filter(row => (status.value === 'all' || row.status === status.value)
        && (!query || [row.goal, row.answer, ...row.artifacts.map(artifact => artifact.name)].join('\n').toLowerCase().includes(query)));
      visible.sort((a, b) => {
        let compared;
        if (sort.value === 'goal') { const left = a.goal.toLowerCase(), right = b.goal.toLowerCase(); compared = left < right ? -1 : left > right ? 1 : 0; }
        else compared = (Date.parse(a.updated_at) - Date.parse(b.updated_at)) * (sort.value === 'oldest' ? 1 : -1);
        return compared || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      results.replaceChildren(...visible.map(card));
      if (!visible.length) results.appendChild(text('p', !loaded ? 'Work records have not been loaded.' : !rows.length ? 'No saved Work or Code tasks yet.' : 'No loaded work matches these filters.', 'yc-recent-empty'));
      count.textContent = loaded ? `${visible.length} of ${rows.length} loaded records${rows.length === 200 ? ' · Latest 200 only; older work may exist' : ''}.` : '';
    }
    async function refresh() {
      if (!active()) return false;
      const ticket = ++generation; refreshButton.disabled = true; section.setAttribute('aria-busy', 'true'); showError(''); count.textContent = 'Refreshing saved work…';
      try {
        const response = await list();
        if (!active() || ticket !== generation) return false;
        const checked = summaries(response); rows = checked; loaded = true; render(); return true;
      } catch (failure) {
        if (active() && ticket === generation) { render(); showError(`${typeof failure?.message === 'string' ? failure.message.slice(0, 2000) : 'Recent Work could not be loaded.'}${loaded ? ' Showing the last loaded records.' : ' Use Refresh to try again.'}`); }
        return false;
      } finally {
        if (active() && ticket === generation) { refreshButton.disabled = false; section.setAttribute('aria-busy', 'false'); }
      }
    }
    search.addEventListener('input', render); status.addEventListener('change', render); sort.addEventListener('change', render); refreshButton.addEventListener('click', refresh);
    function dispose() {
      if (disposed) return;
      disposed = true; generation++; rows = [];
      search.removeEventListener('input', render); status.removeEventListener('change', render); sort.removeEventListener('change', render); refreshButton.removeEventListener('click', refresh);
      if (section.parentNode === host) host.removeChild(section);
    }
    render(); void refresh();
    return Object.freeze({ refresh, dispose });
  }
  return Object.freeze({ create });
});
