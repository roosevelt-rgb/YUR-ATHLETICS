/* Display only. The main process acquires and verifies committed artifact bytes. */
'use strict';
(() => {
  function element(tag, value = '', className = '') {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function create(host, { api, getContextTarget = () => null, onSource = () => {}, onError = () => {}, onClose = () => {} } = {}) {
    if (!api?.artifacts) throw new Error('Interactive previews require the updated Desktop runtime.');
    const pane = element('section', '', 'yc-artifact-pane');
    const heading = element('div', '', 'yc-artifact-heading');
    const title = element('h3', 'Artifact preview'); title.id = 'yc-artifact-title';
    const close = element('button', 'Close'); close.type = 'button'; close.id = 'yc-artifact-close'; heading.append(title, close);
    const label = element('p', 'Interactive preview · offline', 'yc-artifact-label');
    const status = element('p', 'Choose an HTML artifact from a Work record.', 'yc-artifact-status'); status.id = 'yc-artifact-status'; status.setAttribute('role', 'status');
    const controls = element('div', '', 'yc-artifact-controls');
    const source = element('button', 'View source and export'); source.type = 'button'; source.id = 'yc-artifact-source'; source.disabled = true;
    const reopen = element('button', 'Reload preview'); reopen.type = 'button'; reopen.id = 'yc-artifact-reload'; reopen.disabled = true;
    controls.append(source, reopen);
    const technical = element('details', '', 'yc-artifact-provenance'); const digest = element('p'); digest.id = 'yc-artifact-digest';
    technical.append(element('summary', 'Verified source'), digest);
    const viewport = element('div', '', 'yc-artifact-viewport'); viewport.id = 'yc-artifact-viewport'; viewport.setAttribute('aria-label', 'Offline interactive artifact');
    pane.append(heading, label, controls, status, technical, viewport); host.appendChild(pane);
    let desiredVisible = false, disposed = false, selected = null, verified = null, generation = 0, opening = false;
    let syncQueue = Promise.resolve(), openQueue = Promise.resolve(), lastGeometry = '', raf = null;
    async function invoke(fn) { const response = await fn(); if (!response?.ok) throw new Error(response?.error?.message || 'Artifact preview failed.'); return response.result; }
    function report(error) { if (!disposed && (!selected || selected.context === getContextTarget())) { status.textContent = error?.message || String(error); onError(status.textContent); } }
    function geometry() {
      const rect = viewport.getBoundingClientRect();
      const x = Math.max(0, Math.ceil(rect.left)), y = Math.max(0, Math.ceil(rect.top));
      const width = Math.max(0, Math.floor(Math.min(rect.right, innerWidth) - x));
      const height = Math.max(0, Math.floor(Math.min(rect.bottom, innerHeight) - y));
      const nativeBounds = window.yurNativeViewBounds?.({ x, y, width, height }) || { x, y, width, height };
      const visible = Boolean(desiredVisible && verified && !opening && selected?.context === getContextTarget() && host.isConnected && viewport.getClientRects().length && nativeBounds.width && nativeBounds.height && !document.querySelector('dialog[open]') && !(innerWidth <= 850 && document.querySelector('#yur-conversation.sidebar-visible')));
      return { visible, bounds: nativeBounds };
    }
    function sync(force = false) {
      if (disposed || !selected) return Promise.resolve();
      if (force) lastGeometry = '';
      syncQueue = syncQueue.catch(() => {}).then(async () => {
        if (disposed) return;
        const current = geometry(), signature = JSON.stringify(current);
        if (signature === lastGeometry) return;
        if (!current.visible) { await invoke(() => api.artifacts.setVisible(false)); lastGeometry = signature; return; }
        await invoke(() => api.artifacts.setBounds(current.bounds));
        const visible = geometry().visible; await invoke(() => api.artifacts.setVisible(visible));
        if (visible === current.visible) lastGeometry = signature;
      }).catch(report);
      return syncQueue;
    }
    function scheduleSync() { if (raf === null && !disposed) raf = requestAnimationFrame(() => { raf = null; sync(); }); }
    function open(mission, artifact) {
      const proposal = artifact?.proposal;
      if (artifact?.status !== 'committed' || proposal?.kind !== 'artifact' || proposal.media_type !== 'text/html' || proposal.encoding || !/^[a-f0-9]{64}$/.test(proposal.sha256 || '')) return Promise.reject(new Error('Choose a committed HTML artifact to preview.'));
      const token = ++generation;
      const target = { missionId: mission.id, artifactId: artifact.id, name: proposal.name, sha256: proposal.sha256, context: getContextTarget() };
      selected = target; verified = null; opening = true; source.disabled = true; reopen.disabled = true;
      title.textContent = target.name; digest.textContent = ''; status.textContent = 'Reading and verifying the committed HTML…';
      sync(true);
      // Serializing opens also prevents a slower earlier IPC response replacing a newer artifact.
      openQueue = openQueue.catch(() => {}).then(async () => {
        if (disposed || token !== generation || target.context !== getContextTarget()) return;
        await sync(true);
        const result = await invoke(() => api.artifacts.open(target.missionId, target.artifactId));
        if (disposed || token !== generation) return;
        if (result?.name !== target.name || result.sha256 !== target.sha256 || result.network !== false || result.closed || !Number.isInteger(result.revision)) throw new Error('The preview does not match the selected committed artifact.');
        verified = result; title.textContent = result.name; digest.textContent = result.sha256;
        status.textContent = 'Ready. Scripts stay inside this offline preview; source files are unchanged.';
        source.disabled = false; reopen.disabled = false;
      }).catch(error => { if (token === generation) { verified = null; report(error); } }).finally(async () => { if (token === generation) { opening = false; reopen.disabled = !verified; await sync(true); } });
      return openQueue;
    }
    function setVisible(value) {
      desiredVisible = Boolean(value);
      if (desiredVisible && selected && selected.context !== getContextTarget()) {
        verified = null; title.textContent = 'Artifact preview'; digest.textContent = '';
        status.textContent = 'Choose an HTML artifact from this conversation’s Work record.'; source.disabled = true; reopen.disabled = true;
      }
      return sync();
    }
    source.addEventListener('click', () => { if (selected && verified && selected.context === getContextTarget()) { setVisible(false); onSource(selected.missionId, selected.artifactId); } });
    reopen.addEventListener('click', () => { if (selected && selected.context === getContextTarget()) open({ id: selected.missionId }, { id: selected.artifactId, status: 'committed', proposal: { kind: 'artifact', media_type: 'text/html', name: selected.name, sha256: selected.sha256 } }).catch(report); });
    close.addEventListener('click', () => { setVisible(false); onClose(); });
    const unsubscribe = api.artifacts.onEvent(event => {
      if (disposed || !verified || event.revision !== verified.revision || event.sha256 !== verified.sha256) return;
      if (event.type === 'blocked') status.textContent = event.reason || 'This offline preview blocked a request.';
      if (event.type === 'error') { verified = null; status.textContent = event.message || 'Preview stopped. Reopen the artifact to try again.'; source.disabled = true; sync(true); }
    });
    const resize = new ResizeObserver(scheduleSync); resize.observe(viewport);
    const visibility = new MutationObserver(scheduleSync); visibility.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'class'], childList: true });
    window.addEventListener('resize', scheduleSync); window.addEventListener('yur:native-layout', scheduleSync); window.addEventListener('scroll', scheduleSync, true);
    function dispose() {
      disposed = true; desiredVisible = false; ++generation; unsubscribe?.(); resize.disconnect(); visibility.disconnect();
      if (raf !== null) cancelAnimationFrame(raf); window.removeEventListener('resize', scheduleSync); window.removeEventListener('yur:native-layout', scheduleSync); window.removeEventListener('scroll', scheduleSync, true);
      if (selected) api.artifacts.setVisible(false).catch(() => {}); pane.remove();
    }
    return Object.freeze({ open, setVisible, dispose, element: pane });
  }
  window.yurArtifactView = Object.freeze({ create });
})();
