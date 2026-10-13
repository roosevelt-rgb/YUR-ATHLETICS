'use strict';
(function (target) {
  function create(host, options = {}) {
    const api = options.api || target.studio?.unreal, doc = host.ownerDocument;
    if (!api || typeof api.invoke !== 'function') throw new Error('Unreal is unavailable in this Desktop build.');
    const node = (tag, text = '', className = '') => { const element = doc.createElement(tag); element.textContent = text; element.className = className; return element; };
    let disposed = false, busy = false, generation = 0, current = null, stopPreview = null;
    const root = node('section', '', 'yu-root'); root.setAttribute('aria-label', 'Unreal Engine'); host.append(root);
    const heading = node('header', '', 'yu-header'); heading.append(node('h1', 'Unreal Engine')); root.append(heading);
    const controls = node('div', '', 'yu-controls'); heading.append(controls);
    const status = node('p', 'Checking the selected local project…', 'yu-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
    const project = node('p', 'No verified project selected.', 'yu-project'); root.append(project);
    const message = (text, error = false) => { if (!disposed) { status.textContent = text; status.dataset.error = String(error); } };
    const buttons = [];
    function button(parent, label, run, available = () => true) {
      const element = node('button', label); element.type = 'button'; parent.append(element); buttons.push({ element, available });
      element.addEventListener('click', async () => { if (disposed || busy || !available()) return; busy = true; updateButtons();
        try { await run(); } catch (error) { message(error?.message || 'Unreal action could not be completed.', true); }
        finally { busy = false; updateButtons(); }
      }); return element;
    }
    function updateButtons() { if (!disposed) for (const { element, available } of buttons) element.disabled = busy || !available(); }
    async function invoke(action, payload) {
      const value = await api.invoke(action, payload);
      if (value?.ok === false) throw new Error(value.error?.message || 'Unreal action was rejected.');
      return value?.ok === true ? value.result : value;
    }
    if (options.onBack) button(controls, 'Back to Desktop', options.onBack);
    if (typeof api.chooseProject === 'function') button(controls, 'Choose existing project', async () => {
      const result = await api.chooseProject();
      if (result?.ok === false) throw new Error(result.error?.message || 'The Unreal project selection was rejected.');
      if (result?.cancelled || result?.result?.cancelled) return;
      await refresh();
    });
    button(controls, 'Check connection', () => refresh());
    const layout = node('div', '', 'yu-layout'), tools = node('section', '', 'yu-panel'), preview = node('section', '', 'yu-preview'); layout.append(tools, preview); root.append(layout);
    tools.append(node('h2', 'Inspect the editor'));
    const available = kind => current?.available === true && Array.isArray(current.inspections) && current.inspections.includes(kind);
    const detail = node('pre', 'Connect a matching project to inspect its current state.', 'yu-detail'); detail.setAttribute('aria-live', 'polite');
    for (const [kind, label] of [['level', 'Current level'], ['selection', 'Selected actors'], ['camera', 'Camera position'], ['assets', 'Selected assets']])
      button(tools, label, async () => { const result = await invoke('unreal_inspect', { kind }); if (!disposed) detail.textContent = JSON.stringify(result, null, 2); }, () => available(kind));
    tools.append(detail);
    tools.append(node('h2', 'Available actions'));
    const actionList = node('ul'); tools.append(actionList);
    if (options.onFranklin) button(tools, 'Plan with Franklin', () => options.onFranklin('Help me work with the selected Unreal Engine project. Check unreal_status first, inspect its level and camera, and ask for confirmation before moving the viewport camera.'));
    tools.append(node('p', 'Camera moves require confirmation. Engine startup and asset editing remain in Unreal.', 'yu-muted'));
    preview.append(node('h2', 'Viewport preview'));
    const caption = node('p', 'Capture a view from the verified editor.', 'yu-muted'), image = node('img'); image.alt = 'Viewport captured from the selected Unreal project'; image.hidden = true;
    preview.append(image, caption);
    function showPreview(value, expectedDigest) {
      if (disposed || current?.available !== true) return;
      if (value?.project_file !== current.project_file || !/^[a-f0-9]{64}$/.test(value?.sha256 ?? '') || expectedDigest && value.sha256 !== expectedDigest
          || typeof value.data_url !== 'string' || value.data_url.length > 12 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data_url)
          || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192) throw new Error('The viewport preview no longer matches the selected project. Capture again.');
      image.src = value.data_url; image.hidden = false; caption.textContent = `${value.width} × ${value.height} · Captured from the verified editor`;
    }
    if (typeof api.onPreview === 'function') stopPreview = api.onPreview(value => {
      try { showPreview(value); } catch (error) { message(error.message, true); }
    });
    button(preview, 'Capture viewport', async () => {
      const epoch = generation, expected = current?.project_file;
      const receipt = await invoke('unreal_capture', {});
      if (disposed || epoch !== generation || !receipt?.capture?.preview_delivered) return;
      if (typeof api.preview !== 'function') { caption.textContent = 'Capture completed. Open the native artifact preview.'; return; }
      const reply = await api.preview(), value = reply?.ok === true ? reply.result : reply;
      if (disposed || epoch !== generation) return;
      if (current?.project_file !== expected) return;
      showPreview(value, receipt.capture.sha256);
    }, () => current?.available === true && current.capture_available === true);
    async function refresh() {
      const epoch = ++generation; image.hidden = true; image.removeAttribute?.('src'); current = null; updateButtons();
      const result = await invoke('unreal_status', {}); if (disposed || epoch !== generation) return;
      current = result; actionList.replaceChildren();
      project.textContent = result?.project_file || 'No verified project selected.';
      if (result?.available === true && result.status === 'connected') {
        message('Connected to the selected Unreal editor.');
        for (const label of [result.inspections?.length ? 'Inspect current editor state' : '', result.capture_available ? 'Capture viewport' : '', result.camera_available ? 'Move camera after confirmation' : ''].filter(Boolean)) actionList.append(node('li', label));
      } else {
        message(result?.notice || 'The selected editor is unavailable. Open the existing project and enable its local MCP connection in Unreal.');
        actionList.append(node('li', 'Connect a matching local editor to see available actions.'));
      }
      detail.textContent = 'Select an inspection to read current editor state.'; updateButtons();
    }
    const ready = refresh().catch(error => { message(error.message, true); updateButtons(); });
    return { ready, refresh, dispose() { disposed = true; generation++; stopPreview?.(); image.removeAttribute?.('src'); root.remove(); } };
  }
  const exported = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  target.YurUnrealView = exported;
})(typeof window !== 'undefined' ? window : globalThis);
