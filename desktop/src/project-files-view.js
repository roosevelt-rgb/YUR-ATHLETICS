/* Shared project references are metadata here. File acquisition and durable
 * mutations belong to the existing Desktop callbacks and Commit Service. */
'use strict';
(function (root, factory) {
  const view = factory();
  if (typeof module === 'object' && module.exports) module.exports = view;
  if (root) root.yurProjectFilesView = view;
})(typeof window === 'object' ? window : null, function () {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const revision = value => Number.isSafeInteger(value) && value >= 1;
  const copy = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => a.file_id === b.file_id && a.revision === b.revision && a.sha256 === b.sha256;
  let sequence = 0;
  function selections(value) {
    if (!Array.isArray(value) || value.length > 8) throw new Error('Reference selections must contain at most eight files.');
    const seen = new Set();
    return value.map(file => {
      if (!file || !id(file.file_id) || !revision(file.revision) || !sha(file.sha256) || seen.has(file.file_id)) throw new Error('A selected project reference is invalid.');
      seen.add(file.file_id); return { file_id: file.file_id, revision: file.revision, sha256: file.sha256 };
    });
  }
  function collection(value, projectId) {
    if (!value || value.project_id !== projectId || !revision(value.project_revision) || !Number.isSafeInteger(value.collection_revision) || value.collection_revision < 0 || !Array.isArray(value.files) || value.files.length > 32) throw new Error('The project file library returned an invalid collection.');
    const seen = new Set();
    for (const file of value.files) {
      if (!file || !id(file.id) || seen.has(file.id) || file.project_id !== projectId || typeof file.name !== 'string' || !file.name || file.name.length > 512
          || !sha(file.sha256) || !sha(file.content_sha256) || !revision(file.revision) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 16777216
          || !file.extraction || typeof file.extraction !== 'object' || Array.isArray(file.extraction) || typeof file.extraction.truncated !== 'boolean') throw new Error('The project file library returned invalid file metadata.');
      seen.add(file.id);
    }
    return copy(value);
  }
  const reference = file => ({ file_id: file.id, revision: file.revision, sha256: file.sha256 });
  const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  function create(host, { api, project, getSelection = () => [], onSelection, onAddFiles, onRemove, selectable = false, conversationName = '', onError } = {}) {
    if (!host?.ownerDocument || !id(project?.id) || typeof api?.list !== 'function') throw new TypeError('Project files require a project and its read-only library API.');
    const projectId = project.id, document = host.ownerDocument, prefix = `yc-project-files-${++sequence}`;
    const node = (tag, text = '', className = '') => { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; };
    const section = node('section', '', 'yc-project-files'); section.dataset.projectId = projectId; section.setAttribute('aria-label', 'Project reference files');
    const heading = node('h2', 'Reference files'), introduction = node('p', 'These files belong to the shared project library. They are separate from the source folder; only files you explicitly include are used as reference.', 'yc-project-files-intro');
    const context = node('p', selectable ? `Use in this conversation${conversationName ? ': ' + conversationName : ''}. Select up to eight reference files.` : 'Start a conversation in this project to select reference files.', 'yc-project-files-context');
    const actions = node('div', '', 'yc-project-files-actions');
    const button = (text, className, callback) => { const item = node('button', text, className); item.type = 'button'; item.addEventListener('click', callback); return item; };
    const add = button('Add files', 'yc-project-files-add', () => mutate('add'));
    const reload = button('Refresh files', 'yc-project-files-refresh', refresh); actions.append(add, reload);
    const status = node('p', '', 'yc-project-files-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const error = node('p', '', 'yc-project-files-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const files = node('div', '', 'yc-project-files-list'); files.setAttribute('role', 'list');
    const note = node('p', 'Removing a file affects the shared library. It does not delete the original file from your computer or erase earlier task evidence.', 'yc-project-files-note');
    section.append(heading, introduction, context, actions, status, error, files, note); host.appendChild(section);
    let disposed = false, generation = 0, current = null, selected = [], busy = '', message = '';
    const active = () => !disposed && section.parentNode === host;
    function showError(failure) {
      if (!active()) return;
      const text = typeof failure?.message === 'string' ? failure.message.slice(0, 2000) : 'The project file operation could not be completed.';
      error.textContent = text; error.hidden = false; if (onError) onError(text);
    }
    function syncSelection() { selected = selections(getSelection()); }
    function stale(referenceValue, file) { return !file || !same(referenceValue, reference(file)); }
    function selector(row, name, selectedRef, currentRef) {
      const wrapper = node('label', '', 'yc-project-files-include');
      const input = node('input'); input.type = 'checkbox'; input.className = 'yc-project-files-checkbox'; input.dataset.fileId = (selectedRef || currentRef).file_id;
      input.id = `${prefix}-include-${++sequence}`; input.checked = Boolean(selectedRef);
      input.disabled = !selectable || Boolean(busy) || typeof onSelection !== 'function' || (!selectedRef && (!current || selected.length >= 8));
      const label = node('span', selectedRef ? `Included: ${name}` : `Include ${name}`); wrapper.append(input, label); row.appendChild(wrapper);
      input.addEventListener('change', async () => {
        const desired = input.checked; input.checked = Boolean(selectedRef); // Wait for the actual journal acknowledgment.
        if (!active() || !selectable || busy || typeof onSelection !== 'function') return;
        if (!desired && !selectedRef) return;
        if (desired && (!current || !currentRef || selected.length >= 8)) { showError(new Error(!currentRef ? 'Refresh the library before selecting this reference.' : 'Select no more than eight project reference files.')); return; }
        const next = desired ? [...selected.filter(item => item.file_id !== currentRef.file_id), currentRef] : selected.filter(item => !same(item, selectedRef));
        await choose(next);
      });
    }
    function draw() {
      if (!active()) return;
      section.setAttribute('aria-busy', String(Boolean(busy))); section.dataset.collectionRevision = current ? String(current.collection_revision) : '';
      add.disabled = Boolean(busy) || !current || typeof onAddFiles !== 'function'; reload.disabled = Boolean(busy);
      const count = current?.files.length || 0;
      status.textContent = busy === 'refresh' ? 'Reading the shared file library…' : busy === 'selection' ? 'Saving reference selections…' : busy === 'add' ? 'Adding project files…' : busy === 'remove' ? 'Removing the shared reference…' : message || (current ? `${count} ${count === 1 ? 'file' : 'files'}${selectable ? ` · ${selected.length} of 8 selected for this conversation` : ''}` : 'The file library has not loaded.');
      files.replaceChildren();
      if (current && !count) files.appendChild(node('p', 'No reference files yet. Add documents or text files to this project.', 'yc-project-files-empty'));
      for (const file of current?.files || []) {
        const row = node('article', '', 'yc-project-file'); row.dataset.fileId = file.id; row.setAttribute('role', 'listitem');
        const selectedRef = selected.find(item => item.file_id === file.id), old = selectedRef && stale(selectedRef, file);
        row.append(node('h3', file.name), node('p', `${size(file.bytes)} · revision ${file.revision}`, 'yc-project-file-meta'));
        if (selectable) selector(row, file.name, selectedRef, reference(file));
        if (old) row.appendChild(node('p', 'An earlier revision is selected. Remove its selection, then include the current file to use its new contents.', 'yc-project-file-stale'));
        if (file.extraction?.truncated === true) row.appendChild(node('p', 'The retained text excerpt is limited; it does not contain the entire original file.', 'yc-project-file-note'));
        const remove = button('Remove from project', 'yc-project-file-remove', () => mutate('remove', file)); remove.disabled = Boolean(busy) || typeof onRemove !== 'function'; remove.setAttribute('aria-label', `Remove ${file.name} from the shared project library`); row.appendChild(remove); files.appendChild(row);
      }
      for (const missing of selected.filter(item => !current?.files.some(file => file.id === item.file_id))) {
        const row = node('article', '', 'yc-project-file yc-project-file-missing'); row.dataset.fileId = missing.file_id; row.setAttribute('role', 'listitem');
        const name = `Unavailable reference · ${missing.file_id}`; row.append(node('h3', name), node('p', current ? 'This selected revision is no longer in the library. Remove its selection before sending, or refresh to check again.' : 'The saved selection is retained while the library is unavailable.', 'yc-project-file-stale'));
        if (selectable) selector(row, name, missing, null); files.appendChild(row);
      }
    }
    async function choose(next) {
      const checked = selections(next), ticket = ++generation; busy = 'selection'; error.hidden = true; message = ''; draw();
      try { await onSelection(copy(checked)); if (active() && ticket === generation) { selected = checked; message = 'Reference selections saved for this conversation.'; } }
      catch (failure) { if (active() && ticket === generation) showError(failure); }
      finally { if (active() && ticket === generation) { busy = ''; draw(); } }
    }
    async function mutate(kind, file) {
      const callback = kind === 'add' ? onAddFiles : onRemove;
      if (!active() || busy || !current || typeof callback !== 'function') return;
      const snapshot = copy(current), ticket = ++generation; busy = kind; message = ''; error.hidden = true; draw();
      try {
        const result = kind === 'add' ? await callback(snapshot) : await callback(copy(file), snapshot);
        if (!active() || ticket !== generation) return;
        const checked = collection(result, projectId); if (checked.collection_revision < current.collection_revision) throw new Error('The file library returned an older revision. Refresh before trying again.');
        const references = selections(getSelection()); current = checked; selected = references;
        message = kind === 'add' ? checked.collection_revision === snapshot.collection_revision ? 'No files were added.' : 'File library updated.' : checked.files.some(item => item.id === file.id) ? 'File library unchanged.' : 'File removed from the shared project library.';
      } catch (failure) { if (active() && ticket === generation) showError(failure); }
      finally { if (active() && ticket === generation) { busy = ''; draw(); } }
    }
    async function refresh() {
      if (!active() || busy) return false;
      const ticket = ++generation; busy = 'refresh'; message = ''; error.hidden = true; draw();
      try {
        const response = await api.list(projectId);
        if (!active() || ticket !== generation) return false;
        if (!response?.ok) throw new Error(response?.error?.message || 'Project files could not be loaded.');
        const checked = collection(response.result, projectId); if (current && checked.collection_revision < current.collection_revision) throw new Error('The file library returned an older revision. Your loaded files and selections are retained.');
        syncSelection(); current = checked; return true;
      } catch (failure) { if (active() && ticket === generation) showError(failure); return false; }
      finally { if (active() && ticket === generation) { busy = ''; draw(); } }
    }
    try { syncSelection(); } catch (failure) { showError(failure); }
    draw(); void refresh();
    return Object.freeze({ refresh, dispose() { disposed = true; generation++; section.remove(); } });
  }
  return Object.freeze({ create });
});
