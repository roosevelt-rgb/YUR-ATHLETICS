/* A view controller for the isolated browser owned by the Electron main process. */
'use strict';
(() => {
  function element(tag, value = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function workSource(value, allowExpired = false) {
    if (value == null) return null;
    const keys = 'expires_at,max_acquisitions,schema,selected_at,source_id,source_url,title';
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys || value.schema !== 'yur.work-browser-source.v1' || typeof value.source_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.source_id) || typeof value.title !== 'string' || value.title.length > 512 || typeof value.source_url !== 'string' || value.source_url.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(value.source_url) || value.max_acquisitions !== 1) throw new Error('The browser returned no valid Work page selection.');
    const url = new URL(value.source_url);
    const loopback = ['localhost', '[::1]'].includes(url.hostname) || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'http:' && !loopback)) throw new Error('The Work page address is not an admitted source.');
    const selected = Date.parse(value.selected_at), expires = Date.parse(value.expires_at);
    const utc = text => typeof text === 'string' && text.length <= 40 && /T.*(?:Z|\+00:00)$/.test(text);
    if (!utc(value.selected_at) || !utc(value.expires_at) || !Number.isFinite(selected) || !Number.isFinite(expires) || expires <= selected || expires - selected > 120000) throw new Error('The Work page selection has an invalid lifetime.');
    if (!allowExpired && expires <= Date.now()) throw new Error('This Work page selection expired. Show the page and allow Work to read it again.');
    return { ...value };
  }
  function create(host, { api, onContext, getContextTarget = () => null, onWorkSource, onWorkSelectionState = () => {}, canSelectWork = () => true, onError = () => {}, onClose = () => {} } = {}) {
    if (!api?.browser) throw new Error('The embedded browser is unavailable in this Desktop.');
    const pane = element('section', '', 'yc-browser-pane');
    pane.setAttribute('aria-label', 'Browser');
    const header = element('div', '', 'yc-browser-heading');
    header.appendChild(element('h3', 'Browser'));
    const close = element('button', 'Close'); close.type = 'button'; close.id = 'yc-browser-close';
    header.appendChild(close);
    const form = element('form', '', 'yc-browser-address-form');
    const address = element('input'); address.id = 'yc-browser-address'; address.type = 'url';
    address.placeholder = 'https://example.com'; address.setAttribute('aria-label', 'Page address');
    address.autocomplete = 'off'; address.spellcheck = false; address.required = true;
    const go = element('button', 'Go'); go.type = 'submit'; go.id = 'yc-browser-go';
    form.append(address, go);
    const controls = element('div', '', 'yc-browser-controls');
    function button(label, id, fn) {
      const node = element('button', label); node.type = 'button'; node.id = id;
      node.addEventListener('click', () => invoke(fn).catch(report)); controls.appendChild(node); return node;
    }
    const back = button('Back', 'yc-browser-back', () => api.browser.back());
    const forward = button('Forward', 'yc-browser-forward', () => api.browser.forward());
    const reload = button('Reload', 'yc-browser-reload', () => api.browser.reload());
    const stop = button('Stop', 'yc-browser-stop', () => api.browser.stop());
    const external = button('Open externally', 'yc-browser-external', () => api.browser.openExternal());
    const read = element('button', 'Use page in chat', 'yc-primary'); read.type = 'button'; read.id = 'yc-browser-use';
    controls.appendChild(read);
    const allowWork = element('button', 'Allow Work to read this page'); allowWork.type = 'button'; allowWork.id = 'yc-browser-allow-work'; controls.appendChild(allowWork);
    const workNote = element('p', 'Work page selection allows one read of this loaded page for up to 2 minutes. It adds no text now and is cleared when Desktop reloads.', 'yc-browser-work-note');
    const status = element('p', 'Enter a page address and choose Go.', 'yc-browser-status');
    status.id = 'yc-browser-status'; status.setAttribute('role', 'status');
    const viewport = element('div', '', 'yc-browser-viewport'); viewport.id = 'yc-browser-viewport';
    viewport.setAttribute('aria-label', 'Isolated browser viewport');
    pane.append(header, form, controls, workNote, status, viewport); host.appendChild(pane);
    let desiredVisible = false, disposed = false, page = {}, reading = false, selectingWork = false, addressDirty = false, raf = null;
    let syncQueue = Promise.resolve(), lastGeometry = '';

    function report(error) {
      if (disposed) return;
      status.textContent = error?.message || String(error);
      onError(status.textContent);
    }
    async function invoke(fn) {
      const response = await fn();
      if (!response?.ok) throw new Error(response?.error?.message || 'The browser request failed.');
      return response.result;
    }
    function draw(state = page) {
      page = state || {};
      if (!addressDirty && page.url && !page.pending_url) address.value = page.url;
      back.disabled = !page.canGoBack; forward.disabled = !page.canGoForward;
      reload.disabled = !page.url; stop.disabled = !page.loading;
      external.disabled = !/^https?:\/\//i.test(page.url || '');
      read.disabled = reading || page.loading || !/^https?:\/\//i.test(page.url || '') || !onContext;
      allowWork.disabled = selectingWork || reading || page.loading || !page.visible || !/^https?:\/\//i.test(page.url || '') || !onWorkSource || !api.browser.selectForWork || !canSelectWork();
      if (page.pending_url) {
        if (!addressDirty) address.value = page.pending_url;
        status.textContent = 'This page requested another origin. Review its address and choose Go to open it.';
      } else if (page.last_error) status.textContent = page.last_error;
      else if (page.loading) status.textContent = 'Loading page…';
      else if (page.url) status.textContent = page.title || page.url;
    }
    function geometry() {
      const bounds = viewport.getBoundingClientRect();
      const x = Math.max(0, Math.ceil(bounds.left)); const y = Math.max(0, Math.ceil(bounds.top));
      const width = Math.max(0, Math.floor(Math.min(bounds.right, window.innerWidth) - x));
      const height = Math.max(0, Math.floor(Math.min(bounds.bottom, window.innerHeight) - y));
      const nativeBounds = window.yurNativeViewBounds?.({ x, y, width, height }) || { x, y, width, height };
      const visible = desiredVisible && host.isConnected && viewport.getClientRects().length > 0 &&
        nativeBounds.width >= 1 && nativeBounds.height >= 1 && !document.querySelector('dialog[open]');
      return { visible, bounds: nativeBounds };
    }
    function sync(force = false) {
      if (disposed) return Promise.resolve();
      if (force) lastGeometry = '';
      // One queue prevents an older show command from overtaking a later hide.
      syncQueue = syncQueue.catch(() => {}).then(async () => {
        if (disposed) return;
        const current = geometry();
        const signature = JSON.stringify(current);
        if (signature === lastGeometry) return;
        if (!current.visible) { await invoke(() => api.browser.setVisible(false)); lastGeometry = signature; return; }
        await invoke(() => api.browser.setBounds(current.bounds));
        // Visibility may have changed while the main process applied the bounds.
        const visible = geometry().visible;
        await invoke(() => api.browser.setVisible(visible));
        if (visible === current.visible) lastGeometry = signature;
      }).catch(report);
      return syncQueue;
    }
    function scheduleSync() {
      if (raf !== null || disposed) return;
      raf = requestAnimationFrame(() => { raf = null; sync(); });
    }
    async function navigate(url) {
      addressDirty = false;
      go.disabled = true;
      try {
        const result = await invoke(() => api.browser.navigate(url));
        if (result?.url !== undefined) draw(result);
        await sync(true);
      } finally { go.disabled = false; }
    }
    form.addEventListener('submit', event => { event.preventDefault(); navigate(address.value.trim()).catch(report); });
    address.addEventListener('input', () => { addressDirty = true; });
    close.addEventListener('click', () => { setVisible(false); onClose(); });
    allowWork.addEventListener('click', async () => {
      if (allowWork.disabled || selectingWork || disposed) return;
      const target = getContextTarget(); let selected = null, delivered = false, started = false;
      selectingWork = true;
      try {
        onWorkSelectionState(target, true); started = true; draw(); status.textContent = 'Selecting this page for the captured conversation…';
        const response = await api.browser.selectForWork({ conversation_id: target });
        if (!response?.ok) throw new Error(response?.error?.message || 'The browser page could not be selected for Work.');
        selected = workSource(response.source);
        if (disposed) return;
        await onWorkSource(selected, target); delivered = true;
        status.textContent = 'Page selected for one Work or Code read. No page text has been added.';
      } catch (error) { report(error); }
      finally {
        const outcome = status.textContent;
        if (selected && !delivered) { try { await api.browser.releaseWorkSource({ source_id: selected.source_id, conversation_id: target }); } catch { /* The bounded host lease still expires. */ } }
        selectingWork = false; if (started) onWorkSelectionState(target, false); if (!disposed) { draw(); status.textContent = outcome; }
      }
    });
    read.addEventListener('click', async () => {
      if (reading) return;
      const target = getContextTarget();
      reading = true; draw(); status.textContent = 'Reading visible page text…';
      try {
        const context = await invoke(() => api.browser.readVisiblePage());
        if (context?.schema !== 'yur.browser-context.v1' || !/^https?:\/\//i.test(context.source_url || '') ||
            !/^[a-f0-9]{64}$/i.test(context.sha256 || '') || typeof context.text !== 'string') {
          throw new Error('The browser returned no verifiable page context.');
        }
        if (!context.text.trim()) throw new Error('This page has no visible text to add.');
        await onContext(context, target);
        status.textContent = context.truncated ? 'A bounded page excerpt was added to the conversation.' : 'Visible page text was added to the conversation.';
      } catch (error) { report(error); }
      finally { reading = false; read.disabled = page.loading || !/^https?:\/\//i.test(page.url || ''); }
    });
    function setVisible(value) { desiredVisible = Boolean(value); return sync(); }
    const unsubscribe = api.browser.onEvent(event => {
      if (disposed) return;
      if (event.type === 'state') draw(event.state);
      else if (event.type === 'blocked') {
        if (event.url && !addressDirty) address.value = event.url;
        status.textContent = (event.reason || 'Navigation was blocked.') + ' Review the address before choosing Go.';
      }
    });
    const resize = new ResizeObserver(scheduleSync); resize.observe(viewport);
    const visibility = new MutationObserver(scheduleSync);
    visibility.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'class'], childList: true });
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('yur:native-layout', scheduleSync);
    window.addEventListener('scroll', scheduleSync, true);
    invoke(() => api.browser.state()).then(draw).catch(report);
    draw(); sync();
    function dispose() {
      desiredVisible = false; disposed = true; unsubscribe?.(); resize.disconnect(); visibility.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
      window.removeEventListener('resize', scheduleSync); window.removeEventListener('yur:native-layout', scheduleSync); window.removeEventListener('scroll', scheduleSync, true);
      api.browser.setVisible(false).catch(() => {}); pane.remove();
    }
    return Object.freeze({ setVisible, navigate, dispose, refresh: () => draw(), element: pane });
  }
  window.yurBrowserView = Object.freeze({ create, workSource });
})();
