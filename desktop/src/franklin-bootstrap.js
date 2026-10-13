'use strict';

// Franklin is mounted once at the Desktop shell, rather than inside a page
// view. The host/runtime bridge remains the authority for navigation and work;
// this file only makes that capability reachable from every surface.
window.addEventListener('DOMContentLoaded', () => {
  if (!window.studio?.franklin || !window.yurFranklinView || document.getElementById('franklin-assistant-root')) return;
  const host = document.createElement('div'); host.id = 'franklin-assistant-root'; document.body.append(host);
  const voice = window.yurVoiceView && window.studio.voice && window.studio.workspace?.list && window.studio.desktopSettings?.describe ? {
    createDictation: window.yurVoiceView.createDictation,
    api: window.studio,
    async readPreferences() {
      const [contract, response] = await Promise.all([window.studio.desktopSettings.describe(), window.studio.workspace.list('settings')]);
      if (!contract?.fields || !response?.ok || !Array.isArray(response.result?.documents)) throw new Error('Desktop voice settings are unavailable.');
      const settings = response.result.documents.find(document => document?.id === 'desktop');
      if (settings?.preferences && (typeof settings.preferences !== 'object' || Array.isArray(settings.preferences))) throw new Error('Desktop voice settings are invalid.');
      const defaults = Object.fromEntries(Object.entries(contract.fields).map(([key, rule]) => [key, rule.default]));
      return { ...defaults, ...settings?.preferences };
    },
  } : null;
  let controller = window.yurFranklinView.create(host, { api: window.studio.franklin, voice });
  let shell = document.getElementById('yur-franklin');
  const rail = document.getElementById('franklin-rail-toggle');
  const frame = { id: null };

  // On an edition's main page Franklin can sit behind a section or the Chat/Work/Code page, so
  // opening or asking him first asks the edition to show his page. The drawer needs nothing.
  let reveal = () => {};

  // These bindings are intentionally small public handles. They let the
  // Desktop's existing navigation and work surfaces open Franklin without
  // creating another coordinator or bypassing the host authority envelope.
  window.yurFranklin = controller;
  window.yurAskFranklin = text => { reveal(); return controller.prepareDraft(text); };
  window.yurOpenFranklin = () => {
    reveal();
    controller.open();
    window.requestAnimationFrame?.(() => document.getElementById('franklin-input')?.focus());
  };
  window.yurCollapseFranklin = () => controller.collapse();

  function syncRail() {
    if (rail) rail.setAttribute('aria-pressed', shell?.dataset.expanded === 'true' ? 'true' : 'false');
  }
  function place() {
    frame.id = null;
    // The rail owns its viewport edge. Native views only need a repaint after
    // a resize; they must not move Franklin back into a page-specific column.
    syncRail();
    window.dispatchEvent(new Event('yur:native-layout'));
  }
  function schedulePlace() {
    if (frame.id !== null) return;
    const schedule = window.requestAnimationFrame || (callback => window.setTimeout(callback, 0));
    frame.id = schedule(place);
  }

  rail?.addEventListener('click', () => window.yurOpenFranklin());
  window.addEventListener('resize', schedulePlace);
  window.addEventListener('yur:coding-visible', schedulePlace);
  window.addEventListener('yur:franklin-layout', schedulePlace);
  window.addEventListener('keydown', event => {
    if (event.isComposing || event.repeat || (!event.ctrlKey && !event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'f') return;
    event.preventDefault(); window.yurOpenFranklin();
  });
  window.yurUpdateFranklinLayout = place;
  window.yurNativeViewBounds = bounds => {
    if (!shell?.getClientRects?.().length || shell.dataset.expanded !== 'true') return bounds;
    const rect = shell.getBoundingClientRect?.();
    if (!rect) return bounds;
    const right = bounds.x + bounds.width;
    if (shell.dataset.layout === 'main') {
      // On an edition's main page Franklin's column sits left of the side browser, which never
      // covers it (edition-shell.css, Full view included). Native views draw above HTML, so one
      // that would still reach into his column starts at its right edge: his status, Stop and
      // input stay visible while he drives the browser.
      if (!Number.isFinite(rect.right) || rect.right <= bounds.x || rect.left >= right || rect.top >= bounds.y + bounds.height || rect.bottom <= bounds.y) return bounds;
      const x = Math.min(right, Math.ceil(rect.right));
      return { ...bounds, x, width: Math.max(0, right - x) };
    }
    if (rect.left <= bounds.x || rect.left >= right || rect.top >= bounds.y + bounds.height || rect.bottom <= bounds.y) return bounds;
    // Native WebContentsViews draw above HTML. Keep the right-hand drawer
    // visible by shortening a full-width native surface at the drawer edge.
    return { ...bounds, width: Math.max(0, Math.floor(rect.left - bounds.x - 8)) };
  };
  // Edition only (YUR_EDITION): the edition page hands Franklin its main column, and the same
  // runtime contract moves there pinned open while the drawer host is removed. The Desktop
  // never makes this request, so its drawer, rail and native-view clamp stay as above.
  // The edition's page has no local dictation: it would run a speech model on this computer.
  function mountMain(target, intro = null) {
    if (!target || typeof target.append !== 'function' || !target.isConnected || shell?.dataset.layout === 'main') return;
    void controller.flushDraft().catch(() => {});
    controller.dispose(); host.remove();
    controller = window.yurFranklinView.create(target, { api: window.studio.franklin, voice: null, layout: 'main', intro });
    shell = document.getElementById('yur-franklin');
    window.yurFranklin = controller;
    reveal = () => window.dispatchEvent(new Event('yur:franklin-reveal'));
    place();
  }
  if (window.yurFranklinMainHost) mountMain(window.yurFranklinMainHost, window.yurFranklinMainIntro || null);
  window.addEventListener('yur:franklin-main', event => mountMain(event.detail?.host, event.detail?.intro || null));
  // Saving on blur complements the debounced save without blocking navigation.
  window.addEventListener('blur', () => { void controller.cancelDictation().catch(() => {}); void controller.flushDraft().catch(() => {}); });
  place();
});
