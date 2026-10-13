/* One optional split pane over the Desktop's existing native PTY transport. */
(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.yurTerminalPanes = exported;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function create({ primary, host, api, Terminal, FitAddon, getShell, canFit = () => true, onState = () => {}, onError = () => {} }) {
    if (!primary || !host?.parentElement || !api || !Terminal || !FitAddon) throw new Error('The primary native terminal must be ready before splitting.');
    const parent = host.parentElement, document = host.ownerDocument;
    const original = { display: parent.style.display, gridTemplateColumns: parent.style.gridTemplateColumns, gap: parent.style.gap };
    let pane = null, disposed = false, active = 'primary';
    const snapshot = () => ({ split: Boolean(pane), busy: Boolean(pane && (!pane.id || pane.closing)), active, id: pane?.id || null });
    const changed = () => onState(snapshot());
    const primaryFocus = () => { active = 'primary'; changed(); };
    host.addEventListener('focusin', primaryFocus);
    function fit() {
      if (!pane || disposed || !canFit() || !pane.id) return;
      pane.fit.fit(); api.resize(pane.id, pane.term.cols, pane.term.rows);
    }
    function cleanup(entry) {
      if (pane !== entry) return;
      entry.unsubscribe?.(); entry.input?.dispose(); entry.term.dispose(); entry.element.remove();
      pane = null; active = 'primary'; Object.assign(parent.style, original);
      if (!disposed) primary.focus(); changed();
    }
    function terminate(entry) {
      if (entry.stop) return entry.stop;
      entry.closing = true; changed();
      entry.stop = (async () => {
        try { await Promise.resolve().then(() => api.kill(entry.id)); cleanup(entry); }
        catch (error) { entry.closing = false; entry.stop = null; changed(); throw error; }
      })();
      return entry.stop;
    }
    function close() {
      const entry = pane; if (!entry) return Promise.resolve();
      entry.closing = true; changed();
      if (entry.id) return terminate(entry);
      return entry.ready.then(() => { if (pane === entry && entry.id) return terminate(entry); }, error => { if (pane === entry) throw error; });
    }
    function split() {
      if (disposed) return Promise.reject(new Error('The terminal workspace is closed.'));
      if (pane) { if (pane.id && !pane.closing) { active = 'split'; pane.term.focus(); changed(); } return pane.ready; }
      const element = document.createElement('section'), header = document.createElement('div'), label = document.createElement('span'), button = document.createElement('button'), terminalHost = document.createElement('div');
      element.className = 'yur-terminal-split'; element.setAttribute('aria-label', 'Second terminal');
      Object.assign(element.style, { display: 'flex', flexDirection: 'column', minWidth: '0', minHeight: '0', height: '100%', borderLeft: '1px solid var(--dt-border, #506278)' });
      Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 8px', flexShrink: '0' });
      label.textContent = 'Terminal 2'; button.textContent = 'Close terminal 2'; button.type = 'button'; button.setAttribute('aria-label', 'Close second terminal');
      Object.assign(terminalHost.style, { flex: '1', minHeight: '0', minWidth: '0', overflow: 'hidden' });
      header.append(label, button); element.append(header, terminalHost);
      const options = primary.options;
      let term;
      try { term = new Terminal({ fontFamily: options.fontFamily, fontSize: options.fontSize, cursorBlink: options.cursorBlink, theme: { ...options.theme } }); }
      catch (error) { return Promise.reject(error); }
      let fitAddon;
      try { fitAddon = new FitAddon(); } catch (error) { term.dispose(); return Promise.reject(error); }
      const entry = { element, term, fit: fitAddon, id: null, closing: false, ready: null, stop: null };
      pane = entry; parent.append(element); Object.assign(parent.style, { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' });
      element.addEventListener('focusin', () => { active = 'split'; changed(); });
      button.addEventListener('click', () => { void close().catch(onError); });
      entry.ready = (async () => {
        try {
          term.loadAddon(entry.fit); term.open(terminalHost);
          entry.input = term.onData(data => { if (pane === entry && entry.id && !entry.closing && !disposed) api.input(entry.id, data); });
          entry.unsubscribe = api.onData((id, data) => { if (pane === entry && id === entry.id && !disposed) term.write(data); });
          if (canFit()) entry.fit.fit();
          entry.id = await api.spawn({ cols: term.cols, rows: term.rows, shell: getShell() });
          if (!entry.id) throw new Error('The second native terminal could not start.');
          if (entry.closing || disposed) { await terminate(entry); return false; }
          active = 'split'; term.focus(); return true;
        } catch (error) { if (!entry.id) cleanup(entry); throw error; }
        finally { changed(); }
      })();
      changed(); return entry.ready;
    }
    return Object.freeze({ split, close, fit, state: snapshot,
      clear() { (active === 'split' && pane ? pane.term : primary).clear(); },
      focus() { (active === 'split' && pane ? pane.term : primary).focus(); },
      async dispose() { if (disposed) return; disposed = true; host.removeEventListener('focusin', primaryFocus); await close(); },
    });
  }
  return { create };
});
