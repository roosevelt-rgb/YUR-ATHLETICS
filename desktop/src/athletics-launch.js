'use strict';
// YUR Athletics launch page. The hero art and live subline are in the page; the athlete's position
// card and (for a sport with play art) the self-drawing play come from the edition manifest through
// the launch page's one edition call. About three seconds after it opens, the page enters the
// Desktop through the packaged desktop:enter flow glider-launch.js uses. No other Desktop IPC.
(function(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root && root.document) exported.start(root, root.document);
})(typeof window === 'undefined' ? null : window, function() {
  const ENTER_DELAY_MS = 3000;
  const SVG = 'http://www.w3.org/2000/svg';
  const clean = (value, maximum = 80) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maximum) : '';

  // What the splash shows, from edition:launch. Anything missing leaves that part empty.
  function splashModel(info) {
    const title = clean(info?.title) || 'YUR Athletics';
    const athlete = info?.enabled === true && info.athlete && typeof info.athlete === 'object' ? info.athlete : null;
    if (!athlete) return { title, position: '', athleteLine: '', sport: '', hand: '' };
    const name = clean(athlete.display_name).toUpperCase(), year = Number.isInteger(athlete.class_of) ? athlete.class_of : null;
    return { title, position: clean(athlete.position, 40).toUpperCase(),
      athleteLine: name && year ? `${name}, CLASS OF ${year}` : name,
      sport: typeof athlete.sport === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(athlete.sport) ? athlete.sport : '',
      hand: athlete.throws === 'left' || athlete.throws === 'right' ? athlete.throws : '' };
  }

  // The position line fills about the card's width (78px for an 11-letter word at 1440px), at any length.
  function positionFontSize(text, width) {
    const letters = Math.max(String(text || '').length, 4);
    return Math.round(Math.max(28, Math.min(96, width * 0.054, width * 0.86 / (letters * 0.84))));
  }

  function drawPlay(doc, svg, art) {
    if (!svg || !art || typeof doc.createElementNS !== 'function') return false;
    svg.replaceChildren();
    svg.setAttribute('viewBox', art.viewBox); svg.dataset.sport = art.sport; svg.dataset.side = art.side;
    for (const shape of art.shapes) {
      const node = doc.createElementNS(SVG, shape.tag);
      for (const [name, value] of Object.entries(shape.attrs)) node.setAttribute(name, String(value));
      if (shape.role) node.setAttribute('data-role', shape.role);
      if (shape.motion === 'draw') { node.setAttribute('pathLength', '1'); node.setAttribute('class', 'ath-draw'); }
      else if (shape.motion === 'fade') node.setAttribute('class', 'ath-fade');
      if (shape.motion) node.style.setProperty('--d', shape.delay + 's');
      svg.append(node);
    }
    // An <svg> has no hidden property; the attribute itself must go.
    svg.removeAttribute('hidden');
    return true;
  }

  function start(win, doc) {
    const status = doc.getElementById('ath-launch-status'), retry = doc.getElementById('ath-enter');
    const card = doc.getElementById('ath-card'), position = doc.getElementById('splash-position'), athleteLine = doc.getElementById('splash-athlete');
    let model = splashModel(null), entering = false;
    function fit() { if (position?.textContent) position.style.fontSize = positionFontSize(position.textContent, win.innerWidth) + 'px'; }
    function fill(info) {
      model = splashModel(info);
      if (position) position.textContent = model.position;
      if (athleteLine) athleteLine.textContent = model.athleteLine;
      if (card) card.hidden = !model.position;
      fit();
      const art = model.sport ? win.yurAthleticsPlays?.playArt(model.sport, model.hand) : null;
      if (art) drawPlay(doc, doc.getElementById('ath-play'), art);
    }
    async function enter() {
      if (entering) return;
      entering = true; retry.hidden = true; status.textContent = 'Waking Franklin';
      try {
        if (!win.studio?.launch?.enter) throw new Error(`The packaged ${model.title} bridge is unavailable.`);
        const result = await win.studio.launch.enter();
        if (!result?.ok) throw new Error(result?.error?.message || 'The packaged desktop could not be opened.');
      } catch (error) {
        status.textContent = error.message; retry.hidden = false; entering = false;
        retry.focus?.({ preventScroll: true });
      }
    }
    win.addEventListener('resize', fit);
    retry.addEventListener('click', () => { void enter(); });
    // The splash stays about three seconds, reduced motion included (it then shows its final state at once).
    const ready = Promise.resolve().then(() => win.studio?.launch?.edition?.())
      .then(reply => fill(reply?.ok ? reply.result : null), () => fill(null))
      .catch(() => { /* A card or play that cannot be drawn never stops the entry. */ });
    win.setTimeout(() => { void ready.finally(enter); }, ENTER_DELAY_MS);
    return ready;
  }

  return Object.freeze({ ENTER_DELAY_MS, splashModel, positionFontSize, drawPlay, start });
});
