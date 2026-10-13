'use strict';

// Read-only Production overview. Every row is read from the existing Work,
// lifecycle, shipping, or session activity owners; this view creates no jobs.
(function (root, factory) {
  const view = factory();
  if (typeof module === 'object' && module.exports) module.exports = view;
  if (root) root.yurProductionView = view;
})(typeof window === 'object' ? window : null, function () {
  const short = (value, max = 120) => typeof value === 'string' ? value.slice(0, max) : '';
  const status = value => short(value, 48) || 'Unreported';
  const timestamp = value => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Time unreported';
    return new Date(value).toLocaleString();
  };
  const unavailable = { available: false, records: [], reason: 'The source did not return a valid read response.' };

  function records(response, key) {
    if (!response?.ok || !Array.isArray(response.result?.[key])) return unavailable;
    return { available: true, records: response.result[key] };
  }

  async function loadProductionSnapshot(api) {
    if (!api?.work?.list || !api?.lifecycles?.list || !api?.ship?.list || !api?.activity?.snapshot)
      throw new TypeError('Production requires the existing read-only Desktop APIs.');
    const tasks = [
      () => api.work.list(null),
      () => api.lifecycles.list(),
      () => api.ship.list(),
      () => api.activity.snapshot(),
    ];
    const results = await Promise.allSettled(tasks.map(task => task()));
    const response = index => results[index].status === 'fulfilled' ? results[index].value : null;
    const work = records(response(0), 'missions');
    const deployments = records(response(1), 'deployments');
    const shipping = records(response(2), 'candidates');
    const activityResponse = response(3);
    const activity = activityResponse?.ok && activityResponse.result?.schema === 'yur.activity.v1'
      && Array.isArray(activityResponse.result.runs)
      ? { available: true, records: activityResponse.result.runs,
        observedAt: activityResponse.result.observed_at }
      : unavailable;
    const currentSessionOutputCharacters = activity.available
      ? activity.records.reduce((total, run) => total + (Number.isSafeInteger(run.output_chars) && run.output_chars >= 0 ? run.output_chars : 0), 0)
      : null;
    return { checkedAt: new Date().toISOString(), work, deployments, shipping, activity,
      currentSessionOutputCharacters, releases: { available: false,
        reason: 'No signed release registry is connected to this Desktop view.' } };
  }

  function create(host, { api, onOpenWork, onOpenDeployments, onOpenShip } = {}) {
    if (!host?.ownerDocument || typeof onOpenWork !== 'function'
        || typeof onOpenDeployments !== 'function' || typeof onOpenShip !== 'function')
      throw new TypeError('Production needs a host and existing Desktop navigation.');
    const document = host.ownerDocument;
    const node = (tag, value = '', className = '') => {
      const item = document.createElement(tag); item.textContent = value; item.className = className; return item;
    };
    const surface = node('section', '', 'yc-production'); surface.setAttribute('aria-label', 'Production records');
    const heading = node('div', '', 'yc-production-heading');
    const intro = node('p', 'Committed Work, deployments, and shipping checks from their existing owners. Session activity is current-session only.');
    const refreshed = node('span', 'Awaiting source read', 'yc-production-refreshed');
    const refreshButton = node('button', 'Refresh', 'yc-production-refresh'); refreshButton.type = 'button';
    heading.append(intro, refreshed, refreshButton);
    const body = node('div', '', 'yc-production-grid'); surface.append(heading, body); host.append(surface);
    let generation = 0, disposed = false;

    function card(title, source, renderRow, open, empty) {
      const section = node('section', '', 'yc-production-card');
      const top = node('div', '', 'yc-production-card-heading');
      top.append(node('h2', title), node('strong', source.available ? String(source.records.length) : 'Unavailable'));
      section.append(top);
      if (!source.available) section.append(node('p', source.reason, 'yc-production-unavailable'));
      else if (!source.records.length) section.append(node('p', empty, 'yc-production-empty'));
      else {
        const list = node('div', '', 'yc-production-list');
        for (const record of source.records.slice(-12).reverse()) {
          const row = node('div', '', 'yc-production-row'); renderRow(row, record || {}); list.append(row);
        }
        section.append(list);
        if (source.records.length > 12) section.append(node('p', `Showing 12 of ${source.records.length} records.`, 'yc-production-note'));
      }
      if (open) { const button = node('button', 'Open ' + title, 'yc-production-open'); button.type = 'button'; button.onclick = open; section.append(button); }
      body.append(section);
    }

    function render(snapshot) {
      body.replaceChildren();
      refreshed.textContent = 'Read ' + timestamp(snapshot.checkedAt);
      card('Work jobs', snapshot.work, (row, item) => {
        const name = node('strong', 'Work ' + short(item.id, 12));
        const info = node('span', `${status(item.status)} · ${timestamp(item.updated_at)}`);
        row.append(name, info);
        if (/^[a-f0-9]{32}$/i.test(item.id || '')) {
          const open = node('button', 'View work', 'yc-production-row-action'); open.type = 'button';
          open.onclick = () => onOpenWork(item.id); row.append(open);
        }
      }, null, 'No committed Work jobs.');
      card('Deployed agents', snapshot.deployments, (row, item) => {
        row.append(node('strong', short(item.name) || 'Unnamed deployment'),
          node('span', `${status(item.state)} · runs ${Number.isSafeInteger(item.runs_completed) ? item.runs_completed : '?'} / ${Number.isSafeInteger(item.max_runs) ? item.max_runs : '?'} · last ${status(item.last_status)}`));
      }, onOpenDeployments, 'No committed agent deployments.');
      card('Shipping checks', snapshot.shipping, (row, item) => {
        row.append(node('strong', short(item.name) || 'Unnamed candidate'),
          node('span', `${status(item.state)} · verdict ${status(item.last_verdict)} · checks ${Number.isSafeInteger(item.checks_run) ? item.checks_run : '?'}`));
      }, onOpenShip, 'No shipping candidates. These checks are not release records.');
      const release = node('section', '', 'yc-production-card'); release.append(node('h2', 'Releases'),
        node('p', snapshot.releases.reason, 'yc-production-unavailable')); body.append(release);
      const usage = node('section', '', 'yc-production-card'); usage.append(node('h2', 'Current session activity'));
      if (!snapshot.activity.available) usage.append(node('p', snapshot.activity.reason, 'yc-production-unavailable'));
      else usage.append(node('p', `${snapshot.activity.records.length} observed requests · ${snapshot.currentSessionOutputCharacters} output characters · observed ${timestamp(snapshot.activity.observedAt)}. Tokens and cost are not reported by this source.`));
      body.append(usage);
    }

    async function refresh() {
      const current = ++generation; refreshButton.disabled = true; refreshed.textContent = 'Reading Production sources…';
      try {
        const snapshot = await loadProductionSnapshot(api);
        if (!disposed && current === generation) render(snapshot);
      } catch {
        if (!disposed && current === generation) { body.replaceChildren(); refreshed.textContent = 'Production sources unavailable.'; }
      } finally { if (!disposed && current === generation) refreshButton.disabled = false; }
    }
    refreshButton.onclick = refresh;
    void refresh();
    return { refresh, dispose() { disposed = true; generation++; } };
  }

  return { create, loadProductionSnapshot };
});
