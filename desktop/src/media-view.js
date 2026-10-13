/* Media is an operator surface. Durable jobs and validation live in Foundry. */
'use strict';
(function (target) {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };
  function create(host, options = {}) {
    const api = options.api || target.studio?.media;
    if (!api) throw new Error('Media service is unavailable in this Desktop build.');
    let disposed = false, busy = false, polling = false, timer = null, selectedImage = null, catalog = [], jobs = [], pollIndex = 0;
    let draftRequestId = null, draftSignature = '';
    let readiness = new Map();
    const root = node('section', '', 'ym-root'); root.setAttribute('aria-label', 'Media Studio');
    const style = node('style'); style.textContent = `
      .ym-root{color:var(--text-primary,#e5eaf2);background:var(--bg-primary,#111b2b);padding:24px;min-height:100%;font:14px/1.5 inherit;box-sizing:border-box;overflow:auto}
      .ym-root *{box-sizing:border-box}.ym-root [hidden]{display:none!important}.ym-head,.ym-toolbar,.ym-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.ym-head{justify-content:space-between}.ym-root h1{margin:0;font-size:26px}.ym-muted{color:var(--text-secondary,#afbdcf)}
      .ym-layout{display:grid;grid-template-columns:minmax(300px,410px) minmax(320px,1fr);gap:24px;margin-top:20px}.ym-panel,.ym-job{background:var(--bg-secondary,#1c2a3e);border:1px solid var(--border-color,#3a4b64);border-radius:12px;padding:18px}.ym-panel{align-self:start}.ym-root label{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;flex:1;min-width:110px}
      .ym-root input,.ym-root select,.ym-root textarea{background:#101a2b;color:#e6edf8;border:1px solid #526780;border-radius:7px;padding:9px;max-width:100%;font:inherit;min-width:0}.ym-root textarea{resize:vertical;min-height:130px}.ym-root button{font:inherit;border:1px solid #637a97;border-radius:7px;padding:8px 12px;background:#263c56;color:#e8eff8;cursor:pointer}.ym-root button:disabled{opacity:.5;cursor:default}.ym-root :focus-visible{outline:2px solid #a8cdff;outline-offset:3px}.ym-primary{background:#6688b5!important;color:#071221!important;font-weight:700!important}
      .ym-status{min-height:24px;white-space:pre-wrap}.ym-status[data-error=true]{color:#ffc0b5}.ym-config{margin-top:14px}.ym-config input{flex:1;min-width:230px}.ym-gallery{display:flex;flex-direction:column;gap:14px}.ym-job header{display:flex;align-items:center;justify-content:space-between;gap:10px}.ym-job h3{margin:0}.ym-badge{font-size:12px;background:#30445e;border-radius:12px;padding:3px 9px;white-space:nowrap}.ym-job p{overflow-wrap:anywhere}.ym-job img,.ym-job video{width:100%;max-height:420px;object-fit:contain;background:#0b1421;border-radius:6px;display:block}.ym-job pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font-size:12px}.ym-job details{margin-top:12px}.ym-check{flex-direction:row!important;align-items:center}.ym-check input{min-width:auto}.ym-hidden{display:none!important}@media(max-width:850px){.ym-layout{grid-template-columns:1fr}.ym-root{padding:14px}}
    `;
    root.append(style); host.append(root);
    const header = node('header', '', 'ym-head'); header.append(node('h1', 'Media Studio'));
    const tools = node('div', '', 'ym-toolbar'); header.append(tools); root.append(header);
    function button(parent, label, run, className = '') {
      const value = node('button', label, className); value.type = 'button';
      value.addEventListener('click', () => { Promise.resolve().then(run).catch(error => message(error.message, true)); });
      parent.append(value); return value;
    }
    if (options.onBack) button(tools, 'Back to Desktop', options.onBack);
    button(tools, 'Refresh jobs', () => refresh());
    const status = node('p', 'Loading saved media jobs…', 'ym-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
    const message = (text, error = false) => { if (!disposed) { status.textContent = text; status.dataset.error = String(error); } };
    const configuration = node('details', '', 'ym-config'); configuration.append(node('summary', 'Media connection'));
    const configRow = node('div', '', 'ym-row'); configuration.append(configRow);
    const imageConnection = node('label'); imageConnection.append(node('span', 'Image service'));
    const imageEndpoint = node('input'); imageEndpoint.type = 'url'; imageEndpoint.placeholder = 'https://your-image-service'; imageEndpoint.setAttribute('aria-label', 'Image service endpoint'); imageConnection.append(imageEndpoint); configRow.append(imageConnection);
    const videoConnection = node('label'); videoConnection.append(node('span', 'Video service'));
    const videoEndpoint = node('input'); videoEndpoint.type = 'url'; videoEndpoint.placeholder = 'https://your-video-service'; videoEndpoint.setAttribute('aria-label', 'Video service endpoint'); videoConnection.append(videoEndpoint); configRow.append(videoConnection);
    button(configRow, 'Save connections', async () => { await api.configure({ image_endpoint: imageEndpoint.value, video_endpoint: videoEndpoint.value }); await checkHealth(); });
    button(configRow, 'Check connection', () => checkHealth());
    const healthText = node('p', 'Images and video can use separate services. An empty address disconnects that service. Existing jobs keep the service selected when they started.', 'ym-muted'); configuration.append(healthText); root.append(configuration);
    const layout = node('div', '', 'ym-layout'), panel = node('form', '', 'ym-panel'), gallery = node('div', '', 'ym-gallery');
    gallery.setAttribute('aria-label', 'Saved media jobs'); layout.append(panel, gallery); root.append(layout);
    function field(parent, label, tag = 'input', attrs = {}) {
      const wrap = node('label'); wrap.append(node('span', label)); const control = node(tag);
      Object.assign(control, attrs); control.setAttribute('aria-label', label); wrap.append(control); parent.append(wrap); return control;
    }
    const preset = field(panel, 'Workflow', 'select');
    const prompt = field(panel, 'Describe your image or video', 'textarea', { maxLength: 8000, required: true, placeholder: 'Describe the scene, composition, movement, lighting and style…' });
    const imageRow = node('div', '', 'ym-toolbar'); panel.append(imageRow);
    const imageLabel = node('p', 'No starting image selected', 'ym-muted'); panel.append(imageLabel);
    button(imageRow, 'Choose starting image', async () => {
      const image = await api.importImage();
      if (image?.cancelled || !image) return;
      selectedImage = image; imageLabel.textContent = `Starting image · ${image.width} × ${image.height}`;
    });
    button(imageRow, 'Clear image', () => { selectedImage = null; imageLabel.textContent = 'No starting image selected'; });
    const advanced = node('details'); advanced.append(node('summary', 'Dimensions and generation settings')); panel.append(advanced);
    const dims = node('div', '', 'ym-row'); advanced.append(dims);
    const width = field(dims, 'Width', 'input', { type: 'number', min: '256', max: '1536', step: '16' });
    const height = field(dims, 'Height', 'input', { type: 'number', min: '256', max: '1536', step: '16' });
    const seed = field(advanced, 'Seed', 'input', { type: 'number', min: '0', max: '2147483647', step: '1', value: '1' });
    const frames = field(advanced, 'Video frames', 'input', { type: 'number', min: '17', max: '121', step: '4', value: '49' });
    const negative = field(advanced, 'Avoid in video', 'textarea', { maxLength: 2000, placeholder: 'Optional negative prompt' }); negative.style.minHeight = '65px';
    const disclosure = node('p', 'Generate sends this prompt and your selected starting image to the configured media worker. Jobs survive closing this view.', 'ym-muted'); panel.append(disclosure);
    const generate = node('button', 'Generate image', 'ym-primary'); generate.type = 'submit'; generate.disabled = true; panel.append(generate);
    const selectedPreset = () => catalog.find(item => item.id === preset.value);
    const updateAvailability = () => { generate.disabled = busy || !selectedPreset() || readiness.get(preset.value) === false; };
    function selectPreset() {
      const item = selectedPreset(); if (!item) return;
      const video = item.kind === 'video'; width.value = item.width; height.value = item.height;
      width.step = height.step = video ? '32' : '16'; frames.value = item.frames || 49;
      frames.parentElement.hidden = negative.parentElement.hidden = !video;
      generate.textContent = video ? 'Generate video' : selectedImage ? 'Generate image edit' : 'Generate image';
      updateAvailability(); prompt.placeholder = video ? 'Describe the motion, camera and scene changes…' : 'Describe your image, or the changes to the selected starting image…';
    }
    preset.addEventListener('change', selectPreset);
    function currentRequest() {
      const item = selectedPreset();
      const request = { preset: preset.value, prompt: prompt.value.trim(), seed: Number(seed.value), width: Number(width.value), height: Number(height.value) };
      if (item?.kind === 'video') { request.frames = Number(frames.value); request.negative_prompt = negative.value; }
      if (selectedImage) request.input_asset_id = selectedImage.id;
      return request;
    }
    panel.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || disposed) return;
      const item = selectedPreset(); if (!item) return;
      if (item.kind === 'video' && !selectedImage) { message('Choose a starting image, or use an image from your gallery, before generating video.', true); return; }
      if (readiness.get(item.id) === false) { message('This workflow is unavailable. Check its service connection before generating.', true); return; }
      busy = true; generate.disabled = true; message('Submitting the selected workflow…');
      const content = currentRequest();
      const request = { request_id: draftRequestId && JSON.stringify(content) === draftSignature ? draftRequestId : crypto.randomUUID(), ...content };
      try {
        const job = await api.submit({ request });
        message(job.state === 'failed' ? job.error : job.notice || 'Job saved. Its card shows the current progress.', job.state === 'failed');
        await refresh();
      } catch (error) { message(error.message, true); }
      finally { busy = false; if (!disposed) updateAvailability(); }
    });
    async function checkHealth() {
      message('Checking media worker and admitted models…');
      const result = await api.status(); if (disposed) return;
      readiness = new Map((result.presets || []).map(item => [item.id, item.ready === true])); updateAvailability();
      imageEndpoint.value = result.image_endpoint ?? result.endpoint ?? '';
      videoEndpoint.value = result.video_endpoint ?? result.endpoint ?? '';
      healthText.textContent = result.presets?.map(item => `${catalog.find(p => p.id === item.id)?.label || item.id}: ${item.ready ? 'ready' : item.notice || ('missing ' + (item.missing || []).join(', '))}`).join('\n') || result.notice;
      message(result.ready ? 'Media connection checked. Choose a workflow to create.' : result.notice || 'Some media requirements are unavailable. Open Media connection for details.', !result.ready);
      if (!imageEndpoint.value && !videoEndpoint.value) configuration.open = true;
    }
    async function preview(parent, asset) {
      const result = await api.asset({ asset_id: asset.id }); if (disposed || !parent.isConnected) return;
      if (!result?.url || !/^(?:yur-media|yur-artifact|media-asset):\/\//.test(result.url)) throw new Error('The app did not supply a trusted media preview URL. Use Save a copy to inspect this asset.');
      const element = node(asset.kind === 'video' ? 'video' : 'img');
      if (asset.kind === 'video') { element.controls = true; element.preload = 'metadata'; }
      else element.alt = 'Generated media';
      element.src = result.url; parent.append(element);
    }
    function draw() {
      gallery.replaceChildren();
      if (!jobs.length) { gallery.append(node('p', 'Your saved images, videos and generation receipts will appear here.', 'ym-muted')); return; }
      for (const job of jobs) {
        const card = node('article', '', 'ym-job'); card.dataset.mediaJob = job.id;
        const heading = node('header'); heading.append(node('h3', catalog.find(p => p.id === job.request.preset)?.label || job.request.preset), node('span', job.state.replaceAll('_', ' '), 'ym-badge')); card.append(heading);
        card.append(node('p', job.request.prompt));
        card.append(node('p', `${new Date(job.created_at).toLocaleString()} · ${job.request.width} × ${job.request.height} · seed ${job.request.seed}`, 'ym-muted'));
        if (job.error) card.append(node('p', job.error));
        if (job.notice) card.append(node('p', job.notice, 'ym-muted'));
        const actions = node('div', '', 'ym-toolbar'); card.append(actions);
        if (!terminal.has(job.state)) button(actions, 'Refresh / resume', async () => { const updated = await api.resume({ job_id: job.id }); message(updated.notice || `Job ${updated.state}`, updated.state === 'failed'); await refresh(); });
        if (['accepted', 'queued'].includes(job.state)) button(actions, 'Cancel queued job', async () => { const updated = await api.cancel({ job_id: job.id }); message(updated.notice || `Job ${updated.state}`); await refresh(); });
        for (const asset of job.assets || []) {
          const container = node('div'); card.append(container);
          button(actions, asset.kind === 'video' ? 'Play preview' : 'Show image', async () => { container.replaceChildren(); await preview(container, asset); });
          button(actions, 'Save a copy', () => api.exportAsset({ asset_id: asset.id }));
          if (asset.kind === 'image') button(actions, 'Use as starting image', () => { selectedImage = asset; imageLabel.textContent = `Starting image · ${asset.width} × ${asset.height}`; root.scrollTop = 0; prompt.focus(); });
        }
        const details = node('details'); details.append(node('summary', 'Generation receipt'));
        details.append(node('pre', JSON.stringify({ job_id: job.id, model: job.receipt?.model, provider: job.provider?.provider, receipt: job.receipt, validation: job.validation, assets: job.assets?.map(a => ({ id: a.id, mime: a.mime, bytes: a.bytes, checks: a.checks })) }, null, 2)));
        card.append(details); gallery.append(card);
      }
    }
    async function refresh() {
      const result = await api.list({ limit: 100 }); if (disposed) return;
      jobs = result.jobs || []; draw();
    }
    async function poll() {
      if (disposed || polling || busy) return;
      const pending = jobs.filter(job => !terminal.has(job.state));
      const active = pending.length ? pending[(pollIndex++) % pending.length] : null;
      if (!active) return;
      polling = true;
      try {
        const updated = await api.resume({ job_id: active.id });
        if (disposed) return;
        if (updated.revision !== active.revision) {
          await refresh();
          message(updated.state === 'failed' ? updated.error : updated.notice || `Job ${updated.state}`, updated.state === 'failed');
        }
      } catch (error) { message(`Job receipt retained. ${error.message}`, true); }
      finally { polling = false; }
    }
    const ready = (async () => {
      const result = await api.catalog(); if (disposed) return;
      catalog = result.presets || [];
      for (const item of catalog) { const option = node('option', item.label); option.value = item.id; preset.append(option); }
      selectPreset(); await refresh(); message('Choose image or video. Check its service connection before generating.');
      timer = setInterval(() => { void poll(); }, 5000);
      // Readiness can be slow during model download; user explicitly checks it.
    })().catch(error => message(error.message, true));
    async function prepareDraft(request) {
      await ready;
      if (disposed || busy) throw new Error('Media Studio is busy or no longer open.');
      if (!request || typeof request !== 'object' || Array.isArray(request)
          || Object.keys(request).some(key => !['request_id','preset','prompt','negative_prompt','seed','width','height','frames','input_asset_id'].includes(key))
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.request_id)
          || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 8000) throw new Error('Invalid media draft.');
      const item = catalog.find(value => value.id === request.preset);
      if (!item) throw new Error('That media workflow is unavailable.');
      if (prompt.value.trim() && (draftRequestId !== request.request_id || JSON.stringify(currentRequest()) !== draftSignature)) throw new Error('Your current media draft is preserved. Clear its prompt before preparing another.');
      const originalForm = JSON.stringify(currentRequest());
      let image = null;
      if (request.input_asset_id) {
        image = await api.asset({ asset_id: request.input_asset_id });
        if (image?.kind !== 'image' || image.id !== request.input_asset_id) throw new Error('Select a committed starting image.');
      }
      if (disposed || busy) throw new Error('Media Studio changed while preparing the draft.');
      if (JSON.stringify(currentRequest()) !== originalForm) throw new Error('Your media draft changed while preparing the request. Your edits are preserved.');
      preset.value = request.preset; selectedImage = image; selectPreset();
      prompt.value = request.prompt; width.value = request.width ?? item.width; height.value = request.height ?? item.height;
      seed.value = request.seed ?? 1; frames.value = request.frames ?? item.frames ?? 49; negative.value = request.negative_prompt || '';
      imageLabel.textContent = image ? `Starting image · ${image.width} × ${image.height}` : 'No starting image selected';
      draftRequestId = request.request_id; draftSignature = JSON.stringify(currentRequest());
      message('Franklin prepared this draft. Review the prompt and settings, then choose Generate to send it to your media worker.');
      root.scrollTop = 0; prompt.focus();
      return { prepared: true, request_id: draftRequestId, submitted: false, requires_operator_review: true };
    }
    return { ready, refresh, prepareDraft, dispose() { disposed = true; clearInterval(timer); for (const video of root.querySelectorAll('video')) { video.pause(); video.removeAttribute('src'); video.load(); } root.remove(); } };
  }
  target.YurMediaView = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof window === 'undefined' ? globalThis : window);
