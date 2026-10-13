/* Reading position belongs to the conversation, not to a tool progress event. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.yurTranscriptPosition = api;
})(typeof window === 'object' ? window : null, function () {
  function create(scroll, button) {
    const positions = new Map();
    let renderedId = null, restoring = false, disposed = false, deferred = null;
    const visible = () => scroll.clientHeight > 0;
    const bottom = () => Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const nearBottom = () => bottom() - scroll.scrollTop <= 80;
    function paint() { button.hidden = !visible() || nearBottom(); }
    function capture() {
      if (!renderedId || !visible() || restoring || disposed || deferred) return;
      const rect = scroll.getBoundingClientRect();
      const anchor = [...scroll.querySelectorAll('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > rect.top);
      positions.set(renderedId, { top: scroll.scrollTop, follow: nearBottom(), anchor: anchor?.dataset.messageId || null, offset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0 });
      paint();
    }
    function before(id) {
      capture();
      return deferred?.id === id ? deferred : { id, position: positions.get(id) || { top: 0, follow: true, anchor: null, offset: 0 } };
    }
    function after(snapshot) {
      if (disposed) return;
      if (!visible()) { deferred = snapshot; return; }
      deferred = null;
      renderedId = snapshot.id;
      restoring = true;
      const saved = snapshot.position;
      if (saved.follow) scroll.scrollTop = bottom();
      else {
        const anchor = [...scroll.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === saved.anchor);
        scroll.scrollTop = anchor ? scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset : Math.min(saved.top, bottom());
      }
      restoring = false;
      capture();
    }
    function latest() { if (!visible()) return; scroll.scrollTop = bottom(); capture(); }
    scroll.addEventListener('scroll', capture, { passive: true });
    button.addEventListener('click', latest);
    paint();
    return { before, after, capture, latest, dispose() { disposed = true; scroll.removeEventListener('scroll', capture); button.removeEventListener('click', latest); positions.clear(); } };
  }
  return Object.freeze({ create });
});
