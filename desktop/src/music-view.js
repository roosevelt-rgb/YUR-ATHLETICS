/* Native Desktop music creation. Existing Music owns generation and saved audio. */
'use strict';
(function (target) {
  const GROUPS = Object.freeze({
    Genre: ['Pop', 'Indie pop', 'Hip hop', 'Rap', 'Trap', 'R&B', 'Soul', 'Rock', 'Country', 'Electronic', 'House', 'Jazz', 'Blues', 'Folk', 'Ambient', 'Cinematic', 'Funk', 'Synthpop', 'Afrobeats', 'Latin', 'Reggae', 'Metal', 'Acoustic', 'Lo-fi'],
    Mood: ['Confident', 'Uplifting', 'Reflective', 'Dark', 'Energetic', 'Dreamy', 'Romantic', 'Bittersweet', 'Playful', 'Intense', 'Nostalgic', 'Peaceful', 'Defiant', 'Hopeful', 'Melancholic', 'Triumphant'],
    Voice: ['Warm vocals', 'Gritty vocals', 'Soft vocals', 'Powerful vocals', 'Male vocals', 'Female vocals', 'Duet', 'Spoken word', 'Rap delivery', 'Layered harmonies', 'Airy vocals', 'Low register', 'High register', 'Minimal vocals'],
    Tempo: ['Slow', 'Mid-tempo', 'Upbeat', 'Fast', 'Laid-back groove', 'Driving rhythm', 'Half-time', 'Danceable', '80 BPM', '95 BPM', '110 BPM', '125 BPM', '140 BPM', '160 BPM'],
  });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const ID = /^[a-f0-9]{32}(?:[a-f0-9]{32})?$/;
  const limit = (value, maximum) => typeof value === 'string' ? [...value.replace(/\0/g, '')].slice(0, maximum).join('') : '';
  function unwrap(value) {
    if (value?.ok === false) { const error = new Error(value.error?.message || 'The music request could not be completed.'); error.code = value.error?.code; error.recovery = value.error?.recovery; throw error; }
    return value?.ok === true ? value.result : value;
  }
  function normalizeProviders(values) {
    if (!Array.isArray(values)) return [];
    const used = new Set();
    return values.slice(0, 32).filter(value => object(value) && typeof value.id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value.id)
      && !used.has(value.id) && used.add(value.id)).map(value => ({ id: value.id, name: limit(value.name || value.id, 160),
      configured: value.configured === true, external: value.external !== false, status: limit(value.status, 400),
      capabilities: Object.fromEntries(['simple', 'custom', 'vocals', 'instrumental'].map(key => [key, value.capabilities?.[key] === true])),
      models: [...new Set((Array.isArray(value.models) ? value.models : []).filter(item => typeof item === 'string' && item.length <= 80 && !/[\u0000-\u001f\u007f]/.test(item)))].slice(0, 32),
      default_model: limit(value.default_model, 80) }));
  }
  function buildSongRequest(draft, provider) {
    if (!provider?.configured) throw new Error(provider?.status || 'Connect an available music provider before generating.');
    const mode = draft.mode === 'custom' ? 'custom' : 'simple';
    if (mode === 'simple' && !provider.capabilities.simple) throw new Error('This provider needs Custom lyrics.');
    if (draft.instrumental && !provider.capabilities.instrumental) throw new Error('This provider does not report instrumental support.');
    if (!draft.instrumental && !provider.capabilities.vocals) throw new Error('This provider makes instrumentals. Turn on Instrumental to continue.');
    const title = draft.title.trim() || (mode === 'simple' ? 'New song' : '');
    if (!title || [...title].length > 80) throw new Error('Add a title of up to 80 characters.');
    const style = [draft.style.trim(), ...draft.tags].filter(Boolean).join(', ');
    if ([...style].length > 1000) throw new Error('Shorten the style and selected tags to 1,000 characters.');
    if (mode === 'simple' && !draft.description.trim()) throw new Error('Describe the song you want to create.');
    if (mode === 'custom' && !draft.instrumental && !draft.lyrics.trim()) throw new Error('Add your lyrics, or turn on Instrumental.');
    if ([...draft.lyrics].length > 5000 || [...draft.description].length > 3000) throw new Error('The song text exceeds the displayed limit.');
    if (draft.model && !provider.models.includes(draft.model)) throw new Error('Choose a model currently offered by this provider.');
    return { title, lyrics: mode === 'custom' ? draft.lyrics : '', request: { provider: provider.id, mode,
      instrumental: draft.instrumental === true, private: !provider.external, variants: 2, style,
      ...(mode === 'simple' ? { song_description: draft.description.trim() } : {}), ...(draft.model ? { model: draft.model } : {}) } };
  }
  function create(host, options = {}) {
    const document = host.ownerDocument || target.document, api = options.api || target.yur?.music || target.studio?.music;
    let disposed = false, busy = false, refreshing = false, uncertain = options.draft?.submission_pending === true, timer = null, libraryRefresh = null, providers = [], jobs = [], selectedGroup = 'Genre', expanded = false;
    let preferredProvider = limit(options.draft?.provider, 100), preferredModel = limit(options.draft?.model, 80), audioSelection = 0, audioQueue = Promise.resolve();
    const tags = new Set(), trackCards = new Map(), players = new Set();
    const element = (tag, text = '', className = '') => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
    const root = element('section', '', 'music-studio'); root.setAttribute('aria-label', 'Music Studio'); host.append(root);
    const hero = element('header', '', 'music-hero');
    const heroCopy = element('div'); heroCopy.append(element('p', 'MUSIC STUDIO', 'music-eyebrow'), element('h1', 'Turn an idea into a song.'), element('p', 'Your words. Your sound. Create, listen, and make it yours.', 'music-subtitle')); hero.append(heroCopy);
    const refreshButton = button(hero, 'Refresh library', () => refresh(), 'music-quiet'); root.append(hero);
    const layout = element('div', '', 'music-layout'), form = element('form', '', 'music-create'), library = element('aside', '', 'music-library');
    library.setAttribute('aria-label', 'Saved music'); layout.append(form, library); root.append(layout);
    const top = element('div', '', 'music-create-top'), tabs = element('div', '', 'music-mode'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Creation mode');
    const simpleTab = button(tabs, 'Simple', () => setMode('simple')), customTab = button(tabs, 'Custom', () => setMode('custom'));
    simpleTab.id = 'music-simple'; customTab.id = 'music-custom'; simpleTab.setAttribute('role', 'tab'); customTab.setAttribute('role', 'tab');
    top.append(tabs, element('span', 'CREATE', 'music-card-kicker')); form.append(top);
    const simplePanel = element('div'), customPanel = element('div'); simplePanel.id = 'music-simple-panel'; customPanel.id = 'music-custom-panel';
    simplePanel.setAttribute('role', 'tabpanel'); customPanel.setAttribute('role', 'tabpanel'); simpleTab.setAttribute('aria-controls', simplePanel.id); customTab.setAttribute('aria-controls', customPanel.id);
    const description = field(simplePanel, 'Song description', 'textarea', { id: 'music-description', maxLength: 3000, placeholder: 'A late-night drive, a heavy bass line, a hook you can’t forget…' });
    const descriptionCount = element('span', '0 / 3,000', 'music-count'); simplePanel.append(descriptionCount);
    const lyrics = field(customPanel, 'Lyrics', 'textarea', { id: 'music-lyrics', maxLength: 5000, placeholder: '[Verse]\nYour story starts here…\n\n[Chorus]\nGive it a line worth singing.' });
    const lyricCount = element('span', '0 / 5,000', 'music-count'); customPanel.append(lyricCount);
    const title = field(customPanel, 'Song title', 'input', { id: 'music-title', maxLength: 80, placeholder: 'Give this track a name' });
    form.append(simplePanel, customPanel);
    const instrumentalRow = element('label', '', 'music-switch-row'), instrumental = element('input'); instrumental.type = 'checkbox'; instrumental.id = 'music-instrumental';
    instrumentalRow.append(element('span', 'Instrumental'), instrumental, element('span', '', 'music-switch')); form.append(instrumentalRow);
    const style = field(form, 'Style', 'textarea', { id: 'music-style', maxLength: 1000, placeholder: 'Describe the arrangement, instruments, rhythm, or mood…' });
    style.className = 'music-style-input';
    const chipSection = element('section', '', 'music-tags'); chipSection.setAttribute('aria-label', 'Style suggestions');
    const groups = element('div', '', 'music-tag-groups'), chips = element('div', '', 'music-chip-list');
    const groupButtons = new Map();
    for (const name of Object.keys(GROUPS)) groupButtons.set(name, button(groups, name, () => { selectedGroup = name; expanded = false; renderChips(); }, 'music-tag-group'));
    const more = button(chipSection, 'Show more', () => { expanded = !expanded; renderChips(); }, 'music-more');
    chipSection.replaceChildren(groups, chips, more); form.append(chipSection);
    const connection = element('details', '', 'music-connection'); connection.append(element('summary', 'Provider & model'));
    const selectors = element('div', '', 'music-selectors');
    const providerSelect = field(selectors, 'Music provider', 'select', { id: 'music-provider' });
    const model = field(selectors, 'Model', 'select', { id: 'music-model' });
    connection.append(selectors); form.append(connection);
    const readiness = element('p', 'Checking your music connection…', 'music-readiness'); readiness.id = 'music-readiness'; form.append(readiness);
    const disclosure = element('p', 'You’ll review the song and required permissions before generation.', 'music-disclosure'); form.append(disclosure);
    const generate = element('button', 'Generate music', 'music-generate'); generate.type = 'submit'; generate.id = 'music-generate'; generate.disabled = true; form.append(generate);
    const status = element('p', '', 'music-status'); status.id = 'music-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); form.append(status);
    const libraryHeading = element('div', '', 'music-library-heading'); libraryHeading.append(element('h2', 'Your tracks'), element('span', 'Saved in Music Studio', 'music-muted')); library.append(libraryHeading);
    const jobList = element('div', '', 'music-jobs'), tracks = element('div', '', 'music-tracks'), empty = element('div', '', 'music-empty');
    empty.append(element('div', '♫', 'music-empty-icon'), element('h3', 'Your next favorite starts here.'), element('p', 'Finished takes appear here, ready to listen, compare, and save.'));
    library.append(jobList, tracks, empty);
    let mode = 'simple';
    function button(parent, label, run, className = '') {
      const value = element('button', label, className); value.type = 'button';
      value.addEventListener('click', () => { Promise.resolve().then(run).catch(error => message(error.message, true)); }); parent.append(value); return value;
    }
    function field(parent, label, tag, attributes = {}) {
      const wrap = element('label', '', 'music-field'), caption = element('span', label); const control = element(tag);
      Object.assign(control, attributes); control.setAttribute('aria-label', label); wrap.append(caption, control); parent.append(wrap); return control;
    }
    function message(value, error = false) { if (!disposed) { status.textContent = value; status.dataset.error = String(error); } }
    const selectedProvider = () => providers.find(value => value.id === providerSelect.value);
    function getDraft() { return { mode, description: description.value, lyrics: lyrics.value, title: title.value, style: style.value,
      instrumental: instrumental.checked === true, provider: providerSelect.value || preferredProvider, model: model.value || preferredModel, tags: [...tags], submission_pending: busy || uncertain }; }
    function changed() {
      descriptionCount.textContent = [...description.value].length.toLocaleString() + ' / 3,000'; lyricCount.textContent = [...lyrics.value].length.toLocaleString() + ' / 5,000';
      options.onDraftChange?.(getDraft()); updateGenerate();
    }
    function updateGenerate() {
      generate.disabled = busy || uncertain || !selectedProvider()?.configured || !api?.invoke;
      generate.textContent = busy ? 'Reviewing your song…' : 'Generate music';
      simpleTab.disabled = busy; customTab.disabled = busy; providerSelect.disabled = busy || !providers.length; model.disabled = busy || !selectedProvider()?.models.length;
    }
    function setMode(value) {
      mode = value; simplePanel.hidden = mode !== 'simple'; customPanel.hidden = mode !== 'custom';
      simpleTab.setAttribute('aria-selected', String(mode === 'simple')); customTab.setAttribute('aria-selected', String(mode === 'custom'));
      simpleTab.tabIndex = mode === 'simple' ? 0 : -1; customTab.tabIndex = mode === 'custom' ? 0 : -1; changed();
    }
    tabs.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !busy) { event.preventDefault(); setMode(event.key === 'Home' ? 'simple' : event.key === 'End' ? 'custom' : mode === 'simple' ? 'custom' : 'simple'); (mode === 'simple' ? simpleTab : customTab).focus(); }
    });
    function renderChips() {
      chips.replaceChildren();
      for (const [name, control] of groupButtons) control.setAttribute('aria-pressed', String(selectedGroup === name));
      for (const value of GROUPS[selectedGroup].slice(0, expanded ? 32 : 8)) {
        const chip = button(chips, value, () => { if (tags.has(value)) tags.delete(value); else tags.add(value); renderChips(); changed(); }, 'music-chip');
        chip.setAttribute('aria-pressed', String(tags.has(value)));
      }
      more.textContent = expanded ? 'Show less' : 'Show more';
    }
    function selectProvider(preferredModel) {
      const provider = selectedProvider(); model.replaceChildren();
      if (provider?.models.length) {
        for (const name of provider.models) { const option = element('option', name); option.value = name; model.append(option); }
        if (preferredModel && !provider.models.includes(preferredModel)) { const option = element('option', preferredModel + ' · unavailable'); option.value = preferredModel; model.append(option); }
        model.value = preferredModel || (provider.models.includes(provider.default_model) ? provider.default_model : provider.models[0]);
      } else { const option = element('option', 'Provider default'); option.value = ''; model.append(option); model.value = ''; }
      readiness.textContent = provider ? provider.status || (provider.configured ? 'Provider configuration is available.' : 'Provider setup is required.') : 'Music is not connected. Your draft stays here while the connection is set up.';
      readiness.dataset.ready = String(provider?.configured === true);
      disclosure.textContent = provider?.external ? 'Generation sends your song to this provider and may use account credits. You’ll review rights and charges before sending.'
        : 'You’ll confirm your rights to the lyrics and creative inputs before generation.';
      changed();
    }
    providerSelect.addEventListener('change', () => { preferredProvider = providerSelect.value; preferredModel = ''; selectProvider(); }); model.addEventListener('change', () => { preferredModel = model.value; changed(); });
    for (const control of [description, lyrics, title, style, instrumental]) control.addEventListener('input', changed);
    async function invoke(action, payload) {
      if (!api?.invoke) throw new Error('Music requires the updated Desktop connection. Your draft has been kept.');
      const result = unwrap(await api.invoke(action, payload));
      if (result?.status === 'rejected' || result?.cancelled && result?.executed === false) { const error = new Error('Generation was not approved. Your draft is unchanged.'); error.code = 'USER_DECLINED'; throw error; }
      return result;
    }
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || disposed || uncertain) return;
      let payload; try { payload = buildSongRequest(getDraft(), selectedProvider()); } catch (error) { message(error.message, true); return; }
      busy = true; changed(); message('Review your song in the confirmation window.');
      try {
        const result = await invoke('generate_song', payload);
        if (disposed) return;
        const job = result.document || result.job;
        if (!object(job) || job.kind !== 'job' || !ID.test(String(job.id))) { const error = new Error('No saved job receipt was returned. Check the library before submitting again.'); error.code = 'SERVICE_OUTCOME_UNCERTAIN'; throw error; }
        jobs = [job, ...jobs.filter(value => value.id !== job.id)]; renderJobs();
        message(job.data?.state === 'completed' ? 'Your takes are ready.' : 'Your song is saved in the queue. You can keep writing while it creates.');
        await refreshLibrary();
      } catch (error) {
        if (/uncertain|unknown|INTERRUPTED/i.test(error.code || '') || /uncertain|outcome.*unknown/i.test(error.message)) uncertain = true;
        const recovery = object(error.recovery) ? Object.entries(error.recovery).filter(([key, value]) => /^(composition_id|lyrics_id|job_id)$/.test(key) && ID.test(String(value))).map(([key, value]) => key.replace('_id', '') + ': ' + value).join(' · ') : '';
        message(error.message + (recovery ? ' Saved records — ' + recovery + '.' : '') + (uncertain ? ' Inspect the saved request before starting another generation.' : ''), true);
      } finally { busy = false; if (!disposed) changed(); }
    });
    function renderJobs() {
      jobList.replaceChildren();
      for (const job of jobs.slice(0, 12)) {
        const state = job.data?.state, label = { queued: 'Queued', running: 'Creating', completed: 'Ready', needs_review: 'Review needed', failed: 'Failed', cancelled: 'Cancelled' }[state] || 'Status unavailable';
        const row = element('article', '', 'music-job'), info = element('div'); info.append(element('strong', limit(job.data?.request?.title || 'Music generation', 100)), element('span', label, 'music-job-status')); row.append(info);
        if (job.data?.error) row.append(element('p', limit(job.data.error, 500), 'music-muted'));
        if (state === 'queued') button(row, 'Cancel', async () => { await invoke('music_cancel', { job_id: job.id }); await refreshLibrary(); }, 'music-text-button');
        if (['needs_review', 'failed'].includes(state) && job.data?.request?.provider === 'suno-api' && job.data?.provider_receipts?.some(value => value.task_id))
          button(row, 'Retrieve saved takes', async () => { await invoke('music_resume', { job_id: job.id }); await refreshLibrary(); }, 'music-text-button');
        jobList.append(row);
      }
    }
    function loadAudio(card, variant) {
      if (!api?.asset) return;
      const selection = ++audioSelection;
      for (const other of trackCards.values()) if (other !== card && other.audio) {
        other.audio.pause(); players.delete(other.audio); other.audioHost.replaceChildren(); other.audio = null;
      }
      card.audio?.pause();
      // The host keeps one bounded asset grant. Serialize selections and acquire
      // a fresh grant on Listen, so A -> B -> A cannot reuse a revoked URL.
      audioQueue = audioQueue.catch(() => {}).then(async () => {
        if (disposed || selection !== audioSelection) return;
        const result = unwrap(await api.asset(variant.data.audio)); if (disposed || selection !== audioSelection) return;
        const match = /^yur-music:\/\/asset\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/([a-f0-9]{64})\.(wav|mp3)$/.exec(result?.url || '');
        if (!match || match[1] !== variant.data.audio || result.asset_id && result.asset_id !== variant.data.audio) throw new Error('The saved audio preview is not available.');
        const audio = card.audio || element('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = result.url;
        audio.setAttribute('aria-label', 'Play ' + (variant.data.result_title || 'saved take'));
        if (!card.audio) {
          audio.addEventListener('play', () => { for (const other of players) if (other !== audio) other.pause(); });
          audio.addEventListener('error', () => message('This take could not be played. Select Listen to reload its saved audio.', true));
        }
        card.audio = audio; players.add(audio); card.audioHost.replaceChildren(audio);
      });
      return audioQueue;
    }
    function renderTracks(variants) {
      empty.hidden = variants.some(variant => ID.test(String(variant.id)) && /^[a-f0-9]{64}$/.test(variant.data?.audio || ''));
      const present = new Set();
      for (const variant of variants) {
        if (!ID.test(String(variant.id)) || !/^[a-f0-9]{64}$/.test(variant.data?.audio || '')) continue;
        present.add(variant.id); if (trackCards.has(variant.id)) continue;
        const root = element('article', '', 'music-track'), cover = element('div', '♫', 'music-track-cover'), information = element('div', '', 'music-track-info');
        root.append(cover, information);
        information.append(element('h3', limit(variant.data.result_title || variant.data.settings?.title || 'Untitled take', 160)), element('p',
          [variant.data.index ? 'Take ' + variant.data.index : 'Saved take', variant.data.provider || '', variant.data.validation?.duration ? Math.round(variant.data.validation.duration) + ' sec' : ''].filter(Boolean).join(' · '), 'music-muted'));
        const audioHost = element('div', '', 'music-audio'); information.append(audioHost); const card = { root, audioHost, audio: null };
        const controls = element('div', '', 'music-track-actions'); information.append(controls);
        button(controls, 'Listen', () => loadAudio(card, variant), 'music-text-button');
        if (api?.save) button(controls, 'Save audio', async () => { unwrap(await api.save(variant.data.audio)); }, 'music-text-button');
        button(controls, 'Export', async () => {
          const result = await invoke('music_export', { variant_ids: [variant.id] });
          const delivery = result.document; if (!delivery?.data?.audio) throw new Error('The delivery receipt did not include a saved asset.');
          if (api?.save) unwrap(await api.save(delivery.data.audio)); message('Delivery saved in Music Studio.');
        }, 'music-text-button');
        trackCards.set(variant.id, card); tracks.append(root);
      }
      for (const [id, card] of trackCards) if (!present.has(id)) { card.audio?.pause(); players.delete(card.audio); card.root.remove(); trackCards.delete(id); }
    }
    function refreshLibrary() {
      if (libraryRefresh) return libraryRefresh;
      libraryRefresh = (async () => {
        const [jobResult, variants] = await Promise.all([invoke('music_catalog', { kind: 'job', limit: 12 }), invoke('music_catalog', { kind: 'variant', limit: 20 })]);
        if (disposed) return;
        jobs = (Array.isArray(jobResult.documents) ? jobResult.documents : []).filter(value => value.kind === 'job' && ID.test(String(value.id)));
        renderJobs(); renderTracks((Array.isArray(variants.documents) ? variants.documents : []).filter(value => value.kind === 'variant'));
      })().finally(() => { libraryRefresh = null; });
      return libraryRefresh;
    }
    async function refresh() {
      if (refreshing || disposed) return; refreshing = true; refreshButton.disabled = true;
      try {
        await invoke('connect', {}); if (disposed) return;
        const state = await invoke('music_state', {}); if (disposed) return;
        const prior = getDraft();
        providers = normalizeProviders(state.providers); providerSelect.replaceChildren();
        if (!providers.length) { const option = element('option', 'No connected provider'); option.value = ''; providerSelect.append(option); }
        for (const provider of providers) { const option = element('option', provider.name); option.value = provider.id; providerSelect.append(option); }
        if (prior.provider && !providers.some(value => value.id === prior.provider)) { const option = element('option', prior.provider + ' · unavailable'); option.value = prior.provider; providerSelect.append(option); }
        // Preserve a vocal-song workflow even while its cloud account is unbound;
        // an available procedural instrumental is not an equivalent fallback.
        const songProviders = providers.filter(value => value.external && value.capabilities.simple && value.capabilities.vocals);
        providerSelect.value = prior.provider || songProviders.find(value => value.configured)?.id || songProviders[0]?.id || providers[0]?.id || '';
        selectProvider(prior.model); await refreshLibrary();
      } catch (error) {
        readiness.textContent = error.message; readiness.dataset.ready = 'false'; providers = []; updateGenerate();
        if (!busy) message('Your draft is kept here. Refresh when Music is connected.', true);
      } finally { refreshing = false; if (!disposed) refreshButton.disabled = false; }
    }
    function prepareDraft(value = {}) {
      if (!object(value) || busy) throw new Error('Music draft is unavailable while a request is being reviewed.');
      for (const [key, control, maximum] of [['description', description, 3000], ['lyrics', lyrics, 5000], ['title', title, 80], ['style', style, 1000]])
        if (typeof value[key] === 'string') control.value = limit(value[key], maximum);
      if (typeof value.instrumental === 'boolean') instrumental.checked = value.instrumental;
      if (Array.isArray(value.tags)) { tags.clear(); value.tags.slice(0, 24).filter(item => Object.values(GROUPS).flat().includes(item)).forEach(item => tags.add(item)); }
      if (typeof value.provider === 'string') preferredProvider = limit(value.provider, 100);
      if (typeof value.model === 'string') preferredModel = limit(value.model, 80);
      if (providers.length && typeof value.provider === 'string') {
        if (!providers.some(provider => provider.id === value.provider)) { const option = element('option', preferredProvider + ' · unavailable'); option.value = preferredProvider; providerSelect.append(option); }
        providerSelect.value = preferredProvider;
      }
      if (providers.length && (typeof value.provider === 'string' || typeof value.model === 'string')) selectProvider(preferredModel);
      setMode(value.mode === 'simple' ? 'simple' : value.mode === 'custom' || value.lyrics ? 'custom' : 'simple'); renderChips(); changed();
      return { prepared: true, submitted: false };
    }
    prepareDraft(options.draft || {});
    if (uncertain) message('A previous submission still needs inspection. Your draft is kept; check its saved job before generating again.', true);
    const ready = refresh();
    if (options.pollMs !== 0) timer = setInterval(() => { if (!disposed && !busy && !refreshing && jobs.some(job => ['queued', 'running'].includes(job.data?.state))) void refreshLibrary().catch(error => message(error.message, true)); }, options.pollMs || 5000);
    return { ready, refresh, prepareDraft, getDraft, root, dispose() { disposed = true; clearInterval(timer); for (const audio of players) audio.pause(); root.remove(); } };
  }
  const exported = { create, normalizeProviders, buildSongRequest, GROUPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  target.YurMusicView = exported;
})(typeof window === 'undefined' ? globalThis : window);
