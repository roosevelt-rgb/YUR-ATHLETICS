/* Product editions (YUR_EDITION) in the Desktop renderer: the edition's left-nav sections,
 * the Chat/Work/Code page entries and the brand chrome. conversation-view.js calls this
 * only after edition:info reports an edition; the default Desktop answers
 * { enabled: false } and never renders anything from here. An edition grants no authority:
 * Gridiron sections open in the existing side browser under its own policy, Franklin keeps
 * his host envelope and approvals, and Settings is the Desktop's own page. */
(function(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.yurEditionShell = exported;
})(typeof window === 'undefined' ? null : window, function() {
  'use strict';
  // Gridiron serves its pages and API from one loopback origin; edition.js admits only this form.
  const ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;
  const LAYOUT_STYLESHEET = 'edition-shell.css';
  // Brand art (src/athletics-brand/brand, Athletics builds only). Until a file loads, the Orbitron
  // wordmark stands in. lockup: the 44px title-bar lockup; lockupLight: its variant for light title
  // bars; mark: the small silver open-Y mark; markFlat: the 16px pixel mark for the title-bar square.
  const BRANDS = Object.freeze({
    athletics: Object.freeze({ stylesheet: 'athletics-brand/athletics.css', wordmark: 'YUR ATHLETICS',
      lockup: 'athletics-brand/brand/lockup.svg', lockupLight: 'athletics-brand/brand/lockup-light.svg',
      mark: 'athletics-brand/brand/y-mark.svg', markFlat: 'athletics-brand/brand/mark-flat.svg' }),
  });
  // The ghost position canvas behind Franklin's chat: a compound position splits before one of these
  // endings (HALFBACK -> HALF / BACK, LINEBACKER -> LINE / BACKER); any other single word stays
  // one line. Its size fits the column: min(cap, width / (longest line chars * 0.84)).
  const GHOST_ENDINGS = Object.freeze(['BACKER', 'BACK', 'KEEPER', 'STOP']);
  const GHOST_CAP = 220, GHOST_CHAR_EM = 0.84, GHOST_INSET = 24;
  const MODES = Object.freeze([['chat', 'Chat'], ['work', 'Work'], ['code', 'Code']]);
  const EMBED = /^[a-z][a-z0-9_]{0,31}=[a-z0-9_]{1,32}$/i;
  // Settings pages an athlete's edition shows (settings-view.js ids) and the Desktop-only rows it leaves
  // out of view (terminal, chat and coding options); the Desktop shows them all.
  const SETTINGS_PAGES = Object.freeze(['general', 'notifications', 'profile', 'appearance', 'parental-controls', 'account']);
  const SETTINGS_HIDDEN = Object.freeze(['terminal_shell', 'bottom_panel', 'suggested_prompts', 'context_usage', 'standalone_chats']);
  // Franklin's start cards on his empty page, in order. Each opens its section beside him and puts a
  // request in his draft (it is never sent for the user). A start whose section the edition lacks is left out.
  const STARTS = Object.freeze([
    Object.freeze({ section: 'film-study', title: 'Go over my film', line: 'Walk through the season study play by play.', prompt: 'Go over my film with me, play by play.' }),
    Object.freeze({ section: 'my-card', title: 'Show my card', line: 'See what a coach sees first, and fix anything off.', prompt: 'Show my card and tell me what a coach sees first.' }),
    Object.freeze({ section: 'college-board', title: 'Find schools that fit', line: 'Programs on your board that fit you, by level.', prompt: 'Find the schools on my board that fit me best, by level.' }),
    Object.freeze({ section: 'outreach-drafts', title: 'Write to a coach', line: 'Franklin drafts. Nothing sends without your OK.', prompt: 'Help me write to a coach. Draft it for my review; nothing sends without my OK.' }),
  ]);
  // Franklin's phase (franklin-view.js data-phase) as the title bar's one status line: bright = needs you.
  const PHASES = Object.freeze({ ready: 'ready', idle: 'ready', watching: 'ready', working: 'working', unconfirmed: 'attention', error: 'attention',
    waiting_approval: 'attention', connecting: 'waking', paused: 'off', disabled: 'off', offline: 'off', unavailable: 'off', disconnected: 'off' });
  const PHASE_TEXT = Object.freeze({ ready: 'Franklin is ready', working: 'Franklin is working', attention: 'Franklin needs you', waking: 'Franklin is waking', off: 'Franklin is offline' });
  const text = (value, maximum = 80) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maximum) : '';

  // A section path is already canonical on the origin (edition.js); this re-check keeps the
  // renderer from ever handing the side browser a different origin or a Gridiron /api/ route.
  // The manifest's embed parameter (gridiron.embed_param, e.g. embed=1) is added after the check:
  // Gridiron then renders the page for the side pane.
  function sectionUrl(origin, path, embed = '') {
    if (typeof origin !== 'string' || !ORIGIN.test(origin) || Number(origin.slice(origin.lastIndexOf(':') + 1)) > 65535) throw new Error('The edition names no valid Gridiron origin.');
    if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || path.startsWith('//') || /[\\\s\x00-\x1f\x7f#]/.test(path)
        || /^\/api(?:[/?]|$)/i.test(path)) throw new Error('This section has no valid Gridiron path.');
    const url = new URL(path, origin);
    if (url.origin !== origin || url.pathname + url.search !== path) throw new Error('A Gridiron section must stay on its origin.');
    if (typeof embed === 'string' && EMBED.test(embed)) { const [name, value] = embed.split('='); url.searchParams.set(name, value); }
    return url.href;
  }

  // The page a side-browser address shows, without the embed parameter: origin, path and sorted query.
  function pageKey(value, embed = '') {
    let url;
    try { url = new URL(String(value)); } catch { return ''; }
    if (typeof embed === 'string' && EMBED.test(embed)) url.searchParams.delete(embed.split('=')[0]);
    url.searchParams.sort();
    return url.origin + url.pathname + url.search;
  }

  // Ungrouped tabs (Franklin) first, then each tab group in manifest order. Gridiron tabs
  // carry their side-browser URL; Approvals carries the outreach section it opens.
  function navModel(info) {
    if (!info || typeof info !== 'object' || info.enabled !== true || !Array.isArray(info.tabs) || !Array.isArray(info.tab_groups) || !info.gridiron) return null;
    const origin = info.gridiron.origin, embed = typeof info.gridiron.embed_param === 'string' && EMBED.test(info.gridiron.embed_param) ? info.gridiron.embed_param : '';
    const outreach = info.tabs.find(tab => tab?.kind === 'gridiron' && /(?:^|-)outreach(?:-|$)/.test(tab.id));
    const items = [];
    for (const tab of info.tabs) {
      if (!tab || typeof tab.id !== 'string' || !text(tab.label)) continue;
      const item = { id: tab.id, label: text(tab.label), kind: tab.kind, group: typeof tab.group === 'string' ? tab.group : null,
        badge: typeof tab.badge === 'string' ? tab.badge : null };
      if (tab.kind === 'franklin') item.action = 'franklin';
      else if (tab.kind === 'gridiron') { item.action = 'gridiron'; item.url = sectionUrl(origin, tab.path, embed); item.page = pageKey(item.url, embed); }
      else if (tab.kind === 'native' && tab.id === 'approvals') { item.action = 'approvals'; if (outreach) item.url = sectionUrl(origin, outreach.path, embed); }
      else if (tab.kind === 'native' && tab.id === 'settings') item.action = 'settings';
      else continue;
      items.push(Object.freeze(item));
    }
    const groups = [{ id: null, label: '', items: items.filter(item => item.group === null) }];
    for (const group of info.tab_groups) if (group && typeof group.id === 'string') groups.push({ id: group.id, label: text(group.label, 40), items: items.filter(item => item.group === group.id) });
    const id = text(info.edition_id, 64);
    return Object.freeze({ edition_id: id, title: text(info.title), origin, embed, athlete: info.athlete && typeof info.athlete === 'object' ? info.athlete : null,
      brand: Object.hasOwn(BRANDS, id) ? BRANDS[id] : null,
      groups: Object.freeze(groups.filter(group => group.items.length).map(group => Object.freeze({ ...group, items: Object.freeze(group.items) }))) });
  }

  function athleteLine(athlete) {
    if (!athlete || !text(athlete.display_name)) return '';
    return [text(athlete.display_name), text(athlete.position_code, 4), Number.isInteger(athlete.class_of) ? 'Class of ' + athlete.class_of : ''].filter(Boolean).join(' · ');
  }

  // The gridiron section an address shows (embed parameter ignored), or null: the left nav marks it
  // open while it is in the side browser.
  function sectionFor(model, url) {
    const key = pageKey(url, model?.embed);
    if (!key || !model) return null;
    for (const group of model.groups) for (const item of group.items) if (item.action === 'gridiron' && item.page === key) return item.id;
    return null;
  }

  function phaseState(phase) { return Object.hasOwn(PHASES, phase) ? PHASES[phase] : 'waking'; }
  function phaseText(phase) { return PHASE_TEXT[phaseState(phase)]; }

  // Franklin's main-page copy for the edition: his line in the header, the greeting and the start
  // cards on his empty page. Names come from the manifest; nothing here assumes a sport.
  function franklinIntro(model, { openSection = null, ask = null } = {}) {
    const first = text(model?.athlete?.display_name).split(/\s+/)[0] || '';
    const items = new Map(model ? model.groups.flatMap(group => group.items).map(item => [item.id, item]) : []);
    const starts = STARTS.filter(start => items.get(start.section)?.action === 'gridiron').map(start => {
      const item = items.get(start.section);
      return Object.freeze({ id: start.section, title: start.title, line: start.line, page: item.label, prompt: start.prompt,
        select: () => {
          if (typeof openSection === 'function') void Promise.resolve().then(() => openSection(item)).catch(() => {});
          try { if (typeof ask === 'function') ask(start.prompt); } catch { /* A busy Franklin keeps his current draft. */ }
        } });
    });
    const possessive = first ? first + (/s$/i.test(first) ? '’' : '’s') + ' agent' : 'Your agent';
    return Object.freeze({
      agentLine: possessive,
      greeting: (first ? 'Hey ' + first + '. ' : '') + 'I’m Franklin, your agent. Tell me what you want to work on, or pick a start below. When we need a page, I’ll open it on the right so you can watch me work, and you can take over any time.',
      placeholder: 'Message Franklin', starts: Object.freeze(starts) });
  }

  // Brand art with a text fallback: the wordmark shows until the image has loaded, so a
  // missing logo file never renders as a broken image.
  function logo(doc, src, wordmark, className = 'yc-edition-logo', label = wordmark) {
    const holder = doc.createElement('span'); holder.className = className;
    holder.setAttribute('role', 'img'); holder.setAttribute('aria-label', label);
    const words = doc.createElement('span'); words.className = 'yc-edition-wordmark'; words.textContent = wordmark; words.setAttribute('aria-hidden', 'true');
    holder.append(words);
    if (src) {
      const image = doc.createElement('img'); image.alt = ''; image.hidden = true; image.draggable = false; image.setAttribute('aria-hidden', 'true');
      image.addEventListener('load', () => { if (image.naturalWidth > 0) { image.hidden = false; words.hidden = true; holder.dataset.logo = 'loaded'; } });
      image.addEventListener('error', () => image.remove());
      image.src = src; holder.append(image);
    }
    return holder;
  }

  // Each section is one 40px row: a 6px intensity square, its label, an 'open' marker while its page
  // is in the side browser, and (Approvals) a badge. State by intensity: active (the page in the main
  // column) = white square and text; open in the side browser = blue square; idle = dim square.
  // A click on a Gridiron section opens its page beside the current page, so it marks that section
  // open (from the side browser's own address) and leaves the active page as it is; every other
  // section becomes the active page. The buttons stay direct children of the .yc-nav element with
  // their label as the first <span>.
  function renderNav(nav, model, handlers = {}) {
    const doc = nav.ownerDocument, buttons = new Map();
    nav.replaceChildren(); nav.classList.add('yc-nav'); nav.classList.add('yc-edition-nav');
    nav.dataset.edition = model.edition_id;
    for (const group of model.groups) {
      if (group.label) { const title = doc.createElement('p'); title.className = 'yc-edition-group'; title.dataset.group = group.id; title.textContent = group.label; nav.append(title); }
      else if (group.id) { const rule = doc.createElement('hr'); rule.className = 'yc-edition-divider'; rule.dataset.group = group.id; nav.append(rule); }
      for (const item of group.items) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'yc-nav-item yc-edition-tab';
        button.dataset.editionTab = item.id; button.dataset.editionAction = item.action; button.dataset.kind = item.kind;
        if (group.id) button.dataset.group = group.id;
        const label = doc.createElement('span'); label.className = 'yc-edition-tab-label'; label.textContent = item.label;
        const dot = doc.createElement('i'); dot.className = 'yc-edition-dot'; dot.setAttribute('aria-hidden', 'true');
        button.append(label, dot); label.before(dot);
        if (item.action === 'gridiron') { const open = doc.createElement('small'); open.className = 'yc-edition-open'; open.textContent = 'open'; open.hidden = true; button.append(open); }
        if (item.badge) { const badge = doc.createElement('b'); badge.className = 'yc-edition-badge'; badge.dataset.badge = item.badge; badge.hidden = true; button.append(badge); }
        if (item.url) button.title = item.url;
        button.addEventListener('click', () => {
          if (item.action !== 'gridiron') select(item.id);
          void Promise.resolve().then(() => handlers[item.action]?.(item)).catch(error => handlers.error?.(error));
        });
        nav.append(button); buttons.set(item.id, button);
      }
    }
    // The label stays the first <span> (the Pages menu and tests read it), with the square before it.
    let activeId = null, openId = null;
    function select(id) {
      activeId = buttons.has(id) ? id : null;
      for (const [key, button] of buttons) {
        button.classList.toggle('active', key === activeId);
        if (key === activeId) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      }
    }
    // The section whose page the side browser shows (null when it shows none or is closed). Its 'open'
    // word steps aside when the label would not fit beside it: the blue square still marks the row,
    // and the row's description says so.
    function setOpen(id) {
      openId = buttons.get(id)?.dataset.editionAction === 'gridiron' ? id : null;
      for (const [key, button] of buttons) {
        const on = key === openId;
        if (on) { button.dataset.open = 'true'; button.setAttribute('aria-description', 'open in the side browser'); }
        else { delete button.dataset.open; button.removeAttribute('aria-description'); }
        const marker = button.querySelector('.yc-edition-open');
        if (!marker) continue;
        marker.hidden = !on;
        const label = on ? button.querySelector('.yc-edition-tab-label') : null;
        if (label && Number(label.scrollWidth) > Number(label.clientWidth)) marker.hidden = true;
      }
    }
    // Intensity: a count lights the badge (needs you); zero or nothing leaves it off.
    function setBadge(id, value) {
      const badge = buttons.get(id)?.querySelector('.yc-edition-badge');
      if (!badge) return;
      const count = Number.isSafeInteger(value) && value > 0 ? value : 0;
      badge.textContent = count ? String(Math.min(count, 99)) : ''; badge.hidden = !count;
      if (count) badge.setAttribute('aria-label', count + ' waiting for you'); else badge.removeAttribute('aria-label');
    }
    return Object.freeze({ element: nav, buttons, select, setOpen, setBadge, active: () => activeId, open: () => openId });
  }

  // Chat, Work and Code join the Desktop's own pages (hidden in the sidebar while the
  // Pages menu lists them) so the edition keeps the whole conversation surface reachable.
  function renderModes(nav, onMode) {
    const doc = nav.ownerDocument;
    const buttons = MODES.map(([mode, label]) => {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'yc-nav-item yc-edition-mode'; button.dataset.editionMode = mode;
      const span = doc.createElement('span'); span.textContent = label; button.append(span);
      button.addEventListener('click', () => onMode(mode)); return button;
    });
    nav.prepend(...buttons);
    return buttons;
  }

  // Two words (or more) split at the space that best balances two lines; one word stays whole unless
  // it is a compound with one of the endings above. Upper case, at most two lines.
  function ghostLines(position) {
    const value = text(position, 40).toUpperCase().replace(/\s+/g, ' ');
    if (!value) return [];
    const words = value.split(' ');
    if (words.length === 1) {
      const ending = GHOST_ENDINGS.find(end => value.length - end.length >= 3 && value.endsWith(end));
      return ending ? [value.slice(0, -ending.length), ending] : [value];
    }
    let best = null;
    for (let index = 1; index < words.length; index++) {
      const lines = [words.slice(0, index).join(' '), words.slice(index).join(' ')], longest = Math.max(lines[0].length, lines[1].length);
      if (!best || longest < best.longest) best = { lines, longest };
    }
    return best.lines;
  }

  function ghostFontSize(lines, width, cap = GHOST_CAP) {
    const longest = Array.isArray(lines) ? Math.max(0, ...lines.map(line => String(line).length)) : 0;
    if (!longest || !Number.isFinite(width) || width <= 0) return 0;
    return Math.max(0, Math.min(cap, Math.floor(width / (longest * GHOST_CHAR_EM))));
  }

  // Edition only: the athlete's position as a hairline ghost behind Franklin's chat. Decorative
  // (aria-hidden, no pointer events); it re-fits whenever his column changes width: a window
  // resize, the side browser opening, closing or going Full view.
  function renderGhost(host, position, win = host?.ownerDocument?.defaultView) {
    const lines = ghostLines(position);
    if (!host || !lines.length) return null;
    const doc = host.ownerDocument, ghost = doc.createElement('div');
    ghost.className = 'yc-edition-ghost'; ghost.setAttribute('aria-hidden', 'true'); ghost.dataset.lines = String(lines.length);
    for (const line of lines) { const row = doc.createElement('span'); row.textContent = line; ghost.append(row); }
    host.prepend(ghost);
    function fit() {
      const width = Number(host.clientWidth) || Number(host.getBoundingClientRect?.().width) || 0;
      const size = ghostFontSize(lines, width - GHOST_INSET);
      ghost.style.fontSize = size + 'px'; ghost.hidden = size <= 0;
      return size;
    }
    // One fit per frame, however many signals arrive (a scheduler that runs at once is fine too).
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      const later = typeof win?.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : callback => setTimeout(callback, 0);
      later(() => { pending = false; fit(); });
    };
    const Observer = win?.ResizeObserver, observer = typeof Observer === 'function' ? new Observer(schedule) : null;
    observer?.observe(host);
    for (const type of ['resize', 'yur:native-layout']) win?.addEventListener?.(type, schedule);
    fit();
    return Object.freeze({ element: ghost, lines: Object.freeze([...lines]), fit, schedule,
      dispose() { observer?.disconnect(); for (const type of ['resize', 'yur:native-layout']) win?.removeEventListener?.(type, schedule); ghost.remove(); } });
  }

  // The glider frame is built after its own IPC answer; brand it whenever it appears.
  function whenElement(doc, id, callback, timeout = 15000) {
    const found = doc.getElementById(id);
    if (found) { callback(found); return () => {}; }
    const Observer = doc.defaultView?.MutationObserver;
    if (typeof Observer !== 'function' || !doc.body) return () => {};
    let timer = null;
    const observer = new Observer(() => { const element = doc.getElementById(id); if (element) { stop(); callback(element); } });
    function stop() { observer.disconnect(); if (timer !== null) clearTimeout(timer); timer = null; }
    observer.observe(doc.body, { childList: true });
    timer = setTimeout(stop, timeout);
    return stop;
  }

  // The edition's one 44px title row (Welcome/Main): the lockup (a home button that shows Franklin's
  // page), the athlete chip, Franklin's status and the window controls. The glider frame's tab row is
  // hidden by the edition layout. Returns setPhase(phase) for the status line.
  function brandFrame(frame, model, { onHome = null } = {}) {
    const doc = frame.ownerDocument, header = frame.querySelector('header');
    const heading = frame.querySelector('header strong');
    if (heading && model.brand) {
      const home = doc.createElement('button'); home.type = 'button'; home.className = 'yc-edition-home'; home.id = 'yc-edition-home';
      home.setAttribute('aria-label', (model.title || model.brand.wordmark) + ', show Franklin');
      home.append(logo(doc, model.brand.lockup, model.brand.wordmark, 'yc-edition-logo yc-edition-frame-logo', model.title || model.brand.wordmark));
      if (typeof onHome === 'function') home.addEventListener('click', () => onHome());
      heading.replaceChildren(home);
    }
    const caption = frame.querySelector('header > span');
    if (caption) {
      const athlete = model.athlete, name = text(athlete?.display_name);
      caption.className = 'yc-edition-chip'; caption.replaceChildren();
      if (name) {
        const strong = doc.createElement('b'); strong.textContent = name;
        const detail = doc.createElement('span');
        detail.textContent = [text(athlete.position_code, 4), Number.isInteger(athlete.class_of) ? 'class of ' + athlete.class_of : ''].filter(Boolean).join(', ');
        caption.append(strong, detail);
      } else caption.textContent = model.title;
    }
    const homeTab = frame.querySelector('#glider-desktop');
    if (homeTab && model.title) homeTab.textContent = model.title;
    let status = frame.querySelector('.yc-edition-status'), statusText = status?.querySelector('span') || null;
    if (!status && header) {
      status = doc.createElement('span'); status.className = 'yc-edition-status'; status.setAttribute('role', 'status');
      const square = doc.createElement('i'); square.setAttribute('aria-hidden', 'true');
      statusText = doc.createElement('span'); status.append(square, statusText);
      const controls = header.querySelector('#glider-min');
      if (controls) controls.before(status); else header.append(status);
    }
    function setPhase(phase) {
      if (!status || !statusText) return;
      status.dataset.state = phaseState(phase);
      statusText.textContent = phaseText(phase);
    }
    setPhase('connecting');
    return Object.freeze({ setPhase });
  }

  // The edition's side-browser toolbar (Main: one 52px row) and its footer note, in place of the
  // Desktop's browser chrome, which the edition layout hides. Back, Forward and Reload use the same
  // browser commands as the Desktop's buttons; the address is shown, not typed (sections and Franklin
  // open pages). While Franklin works, the row says he is driving, and Take over stops his request
  // through his own Stop button. Blocked loads (Gridiron's /api/ routes, other origins) are named here.
  // Nothing in it adds a browser, Franklin or confirmation path.
  const ICONS = Object.freeze({ back: 'M10 3 5 8l5 5', forward: 'm6 3 5 5-5 5', reload: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5', close: 'm4 4 8 8M12 4l-8 8',
    lock: 'M3.5 7h9v7h-9zM5.5 7V5a2.5 2.5 0 0 1 5 0v2' });
  function icon(doc, name, size = 14) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', ICONS[name]); svg.append(path);
    return svg;
  }
  function addressParts(model, value) {
    let url;
    try { url = new URL(String(value)); } catch { return { site: '', rest: '' }; }
    if (model?.embed) url.searchParams.delete(model.embed.split('=')[0]);
    const rest = url.host + url.pathname + url.search;
    return { site: url.origin === model?.origin ? 'Gridiron' : url.hostname, rest };
  }
  function renderBrowserBar(host, { api, model, onClose = () => {}, onTakeOver = () => {}, onState = () => {}, report = () => {} } = {}) {
    if (!host || !api?.browser) return null;
    const doc = host.ownerDocument;
    const bar = doc.createElement('div'); bar.className = 'yc-edition-browserbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Side browser');
    const button = (name, label, run) => {
      const node = doc.createElement('button'); node.type = 'button'; node.className = 'yc-edition-browser-' + name; node.setAttribute('aria-label', label); node.title = label;
      node.append(icon(doc, name)); node.addEventListener('click', () => { void Promise.resolve().then(run).then(response => { if (response && response.ok === false) report(response.error?.message || 'The browser request failed.'); }).catch(error => report(error?.message || String(error))); });
      return node;
    };
    const back = button('back', 'Back', () => api.browser.back()), forward = button('forward', 'Forward', () => api.browser.forward()), reload = button('reload', 'Reload', () => api.browser.reload());
    const address = doc.createElement('div'); address.className = 'yc-edition-address'; address.id = 'yc-edition-address';
    const site = doc.createElement('b'), rest = doc.createElement('span'); address.append(site, rest);
    const driving = doc.createElement('span'); driving.className = 'yc-edition-driving'; driving.hidden = true;
    const live = doc.createElement('i'); live.setAttribute('aria-hidden', 'true'); driving.append(live, doc.createTextNode('Franklin is driving'));
    const takeOver = doc.createElement('button'); takeOver.type = 'button'; takeOver.className = 'yc-edition-takeover'; takeOver.textContent = 'Take over'; takeOver.hidden = true;
    takeOver.title = 'Stop Franklin’s current request and use the page yourself';
    takeOver.addEventListener('click', () => onTakeOver());
    const close = button('close', 'Close side browser', () => onClose());
    bar.append(back, forward, reload, address, driving, takeOver, close);
    const notice = doc.createElement('p'); notice.className = 'yc-edition-browser-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
    const footer = doc.createElement('p'); footer.className = 'yc-edition-browser-footer';
    footer.append(icon(doc, 'lock', 12), doc.createTextNode('Franklin opens and reads pages on his own. Clicks and typing ask you first.'));
    host.prepend(bar, notice); host.append(footer);
    let state = {}, lastUrl = '';
    function draw(value = state) {
      state = value && typeof value === 'object' ? value : {};
      back.disabled = !state.canGoBack; forward.disabled = !state.canGoForward; reload.disabled = !state.url;
      const parts = addressParts(model, state.url || state.pending_url || '');
      site.textContent = parts.site; rest.textContent = parts.rest || 'No page open';
      address.title = parts.rest;
      if (state.url && state.url !== lastUrl && !state.last_error) { notice.hidden = true; notice.textContent = ''; }
      if (state.last_error) { notice.textContent = state.last_error; notice.hidden = false; }
      lastUrl = state.url || lastUrl;
      onState(state);
    }
    function setDriving(on) { driving.hidden = takeOver.hidden = !on; bar.dataset.driving = String(Boolean(on)); }
    const unsubscribe = api.browser.onEvent?.(event => {
      if (event?.type === 'state') draw(event.state);
      else if (event?.type === 'blocked') {
        const reason = text(event.reason, 300);
        notice.textContent = /^[a-z-]+(?::[a-z-]+)?$/.test(reason) ? 'That page was not opened here (' + reason.replace(/-/g, ' ') + ').' : reason;
        notice.hidden = false;
      }
    });
    void Promise.resolve().then(() => api.browser.state?.()).then(response => { if (response?.ok && response.result) draw(response.result); }).catch(() => {});
    draw({}); setDriving(false);
    return Object.freeze({ element: bar, notice, footer, draw, setDriving, state: () => state,
      dispose() { unsubscribe?.(); bar.remove(); notice.remove(); footer.remove(); } });
  }

  function stylesheet(doc, href, id) {
    return new Promise(resolve => {
      const existing = doc.getElementById(id);
      if (existing) { resolve(existing); return; }
      const link = doc.createElement('link'); link.rel = 'stylesheet'; link.id = id; link.href = href;
      const timer = setTimeout(() => resolve(null), 3000);
      link.addEventListener('load', () => { clearTimeout(timer); resolve(link); });
      link.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
      doc.head.append(link);
    });
  }

  // The edition layout, then its brand finish, appended after every Desktop stylesheet.
  function loadStyles(doc, editionId) {
    const brand = Object.hasOwn(BRANDS, editionId) ? BRANDS[editionId] : null;
    const layout = stylesheet(doc, LAYOUT_STYLESHEET, 'yur-edition-layout');
    const finish = brand ? stylesheet(doc, brand.stylesheet, 'yur-edition-brand') : Promise.resolve(null);
    return Promise.all([layout, finish]);
  }

  return Object.freeze({ BRANDS, LAYOUT_STYLESHEET, MODES, GHOST_ENDINGS, GHOST_CAP, GHOST_CHAR_EM, GHOST_INSET, SETTINGS_PAGES, SETTINGS_HIDDEN, STARTS, sectionUrl, pageKey, navModel, athleteLine, logo,
    sectionFor, phaseState, phaseText, franklinIntro, renderNav, renderModes, ghostLines, ghostFontSize, renderGhost, whenElement, brandFrame, renderBrowserBar, addressParts, loadStyles });
});
