'use strict';
const { randomUUID } = require('node:crypto');
const { normalizeBrowserUrl } = require('./browser-host');
const { EXECUTION_ACTIONS } = require('./franklin-execution');
const { SURFACE_ACTIONS } = require('./franklin-surfaces');
const { SERVICE_ACTIONS } = require('./franklin-services');
const { UNREAL_ACTIONS } = require('./franklin-unreal');
const { editionActions } = require('./edition');
// YUR Athletics only: Franklin's Gridiron actions follow every Desktop action, in the same
// order as foundry/work_desktop.py, which reads the same YUR_EDITION. Unset, the list is
// unchanged. franklin-gridiron.js is never loaded here: without it the actions stay listed (the
// authority lists keep matching Python's) and are answered as not connected.
const EDITION_ACTIONS = Object.freeze([...editionActions(process.env)]);
const VIEWS = Object.freeze(['conversation', 'coding', 'editor', 'agents', 'workforce', 'capabilities', 'workflows', 'vault', 'projects', 'marketplace', 'deployed-agents', 'production', 'media', 'music', 'unreal', 'activity', 'recent-work', 'settings', 'browser']);
const ACTIONS = Object.freeze(['snapshot', 'open_view', 'browser_navigate', 'browser_read', 'browser_back', 'browser_forward', 'browser_reload',
  'media_catalog', 'media_list', 'media_inspect', 'media_status', 'media_draft', 'music_draft', 'workforce_catalog', 'workforce_profile', 'model_catalog', ...EXECUTION_ACTIONS, ...SERVICE_ACTIONS, ...UNREAL_ACTIONS, ...SURFACE_ACTIONS, ...EDITION_ACTIONS]);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function boundedResult(value) {
  if (!object(value)) throw new Error('Desktop operation returned an invalid result.');
  const raw = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Desktop result contains a nonfinite number.');
    return item;
  });
  if (Buffer.byteLength(raw) > 96 * 1024) throw new Error('Desktop result exceeds its context budget; narrow the request.');
  return { ...JSON.parse(raw), trust: 'untrusted-source-data', authority: 'context-only' };
}
function mediaDraft(payload) {
  const allowed = ['preset', 'prompt', 'negative_prompt', 'seed', 'width', 'height', 'frames', 'input_asset_id'];
  if (Object.keys(payload).some(key => !allowed.includes(key)) || !['flux-klein-image-v1', 'wan22-video-v1'].includes(payload.preset)
      || typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 8000) throw new Error('Select an admitted media preset and bounded prompt.');
  const video = payload.preset === 'wan22-video-v1';
  const draft = { ...payload, negative_prompt: payload.negative_prompt ?? '', seed: payload.seed ?? 1,
    width: payload.width ?? (video ? 832 : 1024), height: payload.height ?? (video ? 480 : 1024) };
  if (typeof draft.negative_prompt !== 'string' || draft.negative_prompt.length > 2000 || (!video && draft.negative_prompt)) throw new Error('Invalid negative prompt for the media preset.');
  for (const [key, low, high] of [['seed', 0, 2147483647], ['width', 256, 1536], ['height', 256, 1536]]) {
    if (!Number.isInteger(draft[key]) || draft[key] < low || draft[key] > high) throw new Error('Media dimensions or seed exceed the preset budget.');
  }
  const multiple = video ? 32 : 16;
  if (draft.width % multiple || draft.height % multiple || draft.width * draft.height > (video ? 1280 * 736 : 1536 ** 2)) throw new Error('Media dimensions exceed the preset pixel budget.');
  if (video) {
    draft.frames ??= 49;
    if (!Number.isInteger(draft.frames) || draft.frames < 17 || draft.frames > 121 || (draft.frames - 1) % 4) throw new Error('Invalid video frame count.');
  } else if ('frames' in draft) throw new Error('Image drafts do not accept video frames.');
  if ('input_asset_id' in draft && !/^[a-f0-9]{64}$/.test(draft.input_asset_id)) throw new Error('Select a committed starting image.');
  if (video && !draft.input_asset_id) throw new Error('Video requires a committed starting image.');
  return draft;
}
function musicDraft(payload) {
  const textFields = { description: 3000, lyrics: 5000, title: 80, style: 1000, provider: 100, model: 80 };
  if (!object(payload) || !['simple', 'custom'].includes(payload.mode)
      || Object.keys(payload).some(key => !['mode', 'instrumental', ...Object.keys(textFields)].includes(key))) throw new Error('Select Simple or Custom Music and its typed draft fields.');
  for (const [field, maximum] of Object.entries(textFields)) if (field in payload
      && (typeof payload[field] !== 'string' || [...payload[field]].length > maximum || /\0/.test(payload[field]))) throw new Error('Music draft text exceeds its field limit.');
  if ('instrumental' in payload && typeof payload.instrumental !== 'boolean'
      || 'provider' in payload && !/^[A-Za-z0-9._:-]{1,100}$/.test(payload.provider)
      || 'model' in payload && /[\x00-\x1f\x7f]/.test(payload.model)) throw new Error('Select valid Music draft options.');
  return { ...payload };
}
// A bounded observation of the existing feed; it neither starts model calls nor
// creates another work loop. Durable mission history stays with its owner.
function activityObservation(feed) {
  const runs = (Array.isArray(feed?.runs) ? feed.runs : []).slice(0, 64);
  const latest = runs.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
  return { sequence: Number.isSafeInteger(feed?.sequence) ? feed.sequence : 0,
    active: runs.filter(run => run.request_active === true).length,
    awaiting_review: runs.filter(run => run.status === 'awaiting_approval').length,
    failed: runs.filter(run => ['failed', 'unconfirmed'].includes(run.status)).length,
    retained: runs.length,
    latest: latest ? { id: String(latest.id || '').slice(0, 128), mission_id: latest.mission_id || null,
      label: String(latest.label || 'Desktop work').slice(0, 160), phase: String(latest.phase || '').slice(0, 160),
      status: String(latest.status || '').slice(0, 40) } : null };
}
// navigationGuard (optional, an edition's path rule; edition.js gridironNavigationGuard): an address
// it refuses is never opened by browser_navigate. The browser host applies the same rule to every load.
function createFranklinHost({ getWindow, getBrowser, getSettings, deny, getRuntime, getActivity,
  requestMedia, requestWorkforce, getModelCatalog, prepareMediaDraft, execution, navigationGuard = null }) {
  const pending = new Map();
  function ownerChecked(owner) {
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents !== owner || owner.isDestroyed()) throw new Error('Franklin’s Desktop window is unavailable.');
    return win;
  }
  function view(action, payload, owner) {
    ownerChecked(owner);
    if (pending.size >= 8) throw new Error('Desktop view acknowledgment budget is full.');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop view did not acknowledge Franklin’s request.')); }, 8000);
      pending.set(id, { owner, timer, resolve, reject });
      try { owner.send('franklin:host-request', { id, action, payload }); }
      catch { pending.delete(id); clearTimeout(timer); reject(new Error('Desktop view request could not be delivered.')); }
    });
  }
  function reply(owner, value) {
    ownerChecked(owner);
    if (!object(value) || Object.keys(value).some(key => !['id', 'error', 'result'].includes(key)) || typeof value.id !== 'string' || !pending.has(value.id)) throw new Error('Unknown Franklin view request.');
    const item = pending.get(value.id);
    if (item.owner !== owner) throw new Error('Franklin view reply belongs to another window.');
    pending.delete(value.id); clearTimeout(item.timer);
    if (typeof value.error === 'string') item.reject(new Error(value.error.slice(0, 500)));
    else {
      try {
        if (!object(value.result) || Buffer.byteLength(JSON.stringify(value.result)) > 32768) throw new Error();
        item.resolve(value.result);
      } catch { item.reject(new Error('Desktop view reply exceeded its context budget or contained invalid JSON.')); }
    }
    return { ok: true };
  }
  async function observe(owner) {
    const navigation = await view('snapshot', {}, owner);
    const runtime = getRuntime();
    ownerChecked(owner);
    const observedActivity = getActivity();
    const activity = object(observedActivity) && Array.isArray(observedActivity.runs) ? {
      schema: observedActivity.schema, observed_at: observedActivity.observed_at,
      omitted_runs: (observedActivity.omitted_runs || 0) + Math.max(0, observedActivity.runs.length - 12),
      runs: observedActivity.runs.slice(0, 12).map(run => ({
        id: run.id, kind: run.kind, status: run.status, phase: run.phase, mission_id: run.mission_id,
        provider: run.provider, model: run.model, updated_at: run.updated_at,
        tools: (Array.isArray(run.tools) ? run.tools : []).slice(-8).map(tool => ({ id: tool.id, name: tool.name, status: tool.status })),
      })),
    } : observedActivity;
    const environment = { schema: 'yur.franklin.environment.v1', navigation,
      coding: { running: runtime.running, model: runtime.model || null, workspace: runtime.workspace || null },
      browser: getBrowser(false)?.state() || { visible: false, url: '' },
      activity, views: VIEWS,
      authority: { issuer: 'local-user', scope: 'desktop-mission-execution-v1', actions: [...ACTIONS], max_actions: 20 },
    };
    if (Buffer.byteLength(JSON.stringify(environment)) > 32 * 1024) throw new Error('Desktop environment exceeds its context budget.');
    return environment;
  }
  async function execute(action, payload, identity) {
    function checkScope() {
      if (!object(identity) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(identity.request_id))
          || !/^[a-f0-9]{32}$/.test(String(identity.mission_id))
          || (identity.isActive !== undefined && (typeof identity.isActive !== 'function' || !identity.isActive()))) throw new Error('Franklin action scope is unavailable or cancelled.');
      ownerChecked(identity.owner);
    }
    checkScope();
    if (!object(payload)) throw new Error('Desktop action payload must be an object.');
    if (EXECUTION_ACTIONS.includes(action) || SERVICE_ACTIONS.includes(action) || UNREAL_ACTIONS.includes(action) || SURFACE_ACTIONS.includes(action) || EDITION_ACTIONS.includes(action)) {
      if (!execution) throw new Error('Desktop mission execution is not connected.');
      return boundedResult(await execution.execute(action, payload, { ...identity, isActive: () => {
        try { checkScope(); return true; } catch { return false; }
      } }));
    }
    const keys = Object.keys(payload).sort().join(',');
    async function read(callback, operation, input, channel) {
      if (typeof callback !== 'function') throw new Error('This Desktop capability is not connected.');
      const reason = deny(channel, [input], getSettings());
      if (reason) throw new Error(reason);
      let response;
      try { response = await callback(operation, input); }
      catch { throw new Error('Desktop capability could not complete; inspect its existing workspace.'); }
      checkScope();
      if (!object(response) || response.ok !== true || !object(response.result)) throw new Error('Desktop capability did not return a successful receipt.');
      return boundedResult(response.result);
    }
    if (['media_catalog', 'media_list', 'media_inspect', 'media_status'].includes(action)) {
      const operation = action.slice(6);
      if (operation === 'list' ? (keys !== '' && keys !== 'limit') || ('limit' in payload && (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 50))
          : operation === 'inspect' ? keys !== 'job_id' || !/^[a-f0-9]{32}$/.test(payload.job_id) : Boolean(keys)) throw new Error('Invalid media observation fields.');
      return read(requestMedia, operation, operation === 'list' ? { limit: payload.limit ?? 20 } : payload, 'media:' + operation);
    }
    if (action === 'workforce_catalog' || action === 'workforce_profile') {
      const catalog = action === 'workforce_catalog';
      if (catalog ? (keys !== '' && keys !== 'query') || ('query' in payload && (typeof payload.query !== 'string' || payload.query.length > 200))
          : keys !== 'code,expected_sha256' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.code) || !/^[a-f0-9]{64}$/.test(payload.expected_sha256)) throw new Error('Invalid workforce observation fields.');
      return read(requestWorkforce, catalog ? 'catalog' : 'acquire', catalog ? { query: payload.query ?? '' } : payload, catalog ? 'workforce:catalog' : 'workforce:acquire');
    }
    if (action === 'model_catalog') {
      if (keys || typeof getModelCatalog !== 'function') throw new Error('The model catalog is unavailable.');
      let catalog;
      try { catalog = await getModelCatalog(); } catch { throw new Error('The model catalog is unavailable.'); }
      checkScope();
      if (!object(catalog) || !Array.isArray(catalog.models)) throw new Error('The model catalog is invalid.');
      const models = catalog.models.slice(0, 200).map(model => {
        if (!object(model) || typeof model.id !== 'string' || !/^(ollama|openai):\S{1,256}$/.test(model.id) || typeof model.label !== 'string') throw new Error('The model catalog contains an invalid selection.');
        return { id: model.id, label: model.label.slice(0, 300) };
      });
      return boundedResult({ models, truncated: catalog.models.length > models.length, notice: String(catalog.notice || '').slice(0, 500), selection: 'Use the existing Franklin model picker; this action does not change the selected model.' });
    }
    if (action === 'music_draft') {
      const draft = musicDraft(payload), reason = deny('franklin:service', [{ action: 'music_draft', payload: draft }], getSettings());
      if (reason) throw new Error(reason);
      if (!/^[a-f0-9]{32}$/.test(identity.action_id)) throw new Error('Music draft needs its committed action identity.');
      const h = identity.action_id, request_id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      const result = await view('music_draft', { request_id, draft }, identity.owner); checkScope();
      if (!object(result) || result.prepared !== true || result.submitted !== false || result.request_id !== request_id) throw new Error('Music view did not acknowledge the exact draft.');
      return boundedResult({ prepared: true, submitted: false, request_id, action_id: identity.action_id, notice: 'Music draft prepared. Generation still requires human review.' });
    }
    if (action === 'media_draft') {
      const draft = mediaDraft(payload);
      if (!/^[a-f0-9]{32}$/.test(identity.action_id)) throw new Error('Media draft needs its committed action identity.');
      const reason = deny('media:draft', [draft], getSettings());
      if (reason) throw new Error(reason);
      const hex = identity.action_id;
      draft.request_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      checkScope();
      let result;
      try { result = await (prepareMediaDraft ? prepareMediaDraft(draft, identity) : view('media_draft', { request: draft }, identity.owner)); }
      catch { throw new Error('Media draft could not be prepared; inspect the Media workspace.'); }
      checkScope();
      if (!object(result) || result.prepared !== true || result.request_id !== draft.request_id) throw new Error('Media workspace did not acknowledge the exact draft.');
      return boundedResult({ prepared: true, submitted: false, requires_operator_review: true, request_id: draft.request_id,
        action_id: identity.action_id, preset: draft.preset, notice: 'Draft prepared in Media. The operator must review and submit it there.' });
    }
    if (action === 'snapshot' && !keys) return observe(identity.owner);
    if (action === 'open_view') {
      if (keys !== 'view' || !VIEWS.includes(payload.view)) throw new Error('Select an available Desktop view.');
      return view('open_view', { view: payload.view }, identity.owner);
    }
    const operation = { browser_navigate: 'navigate', browser_read: 'readVisiblePage', browser_back: 'back', browser_forward: 'forward', browser_reload: 'reload' }[action];
    if (!operation || (operation === 'navigate' ? keys !== 'url' : Boolean(keys))) throw new Error('Unsupported desktop operation.');
    const reason = deny('browser:action', [operation, payload.url], getSettings());
    if (reason) throw new Error(reason);
    if (operation === 'navigate') {
      normalizeBrowserUrl(payload.url);
      const refusal = typeof navigationGuard === 'function' ? navigationGuard(payload.url) : '';
      if (refusal) throw new Error(refusal);
    }
    await view('open_view', { view: 'browser' }, identity.owner);
    checkScope();
    const browser = getBrowser(true);
    const result = await browser[operation](...(operation === 'navigate' ? [payload.url] : []));
    return operation === 'readVisiblePage' ? { ...result, trust: 'untrusted-source-data', authority: 'context-only' } : result;
  }
  return { observe, execute, reply, dispose() { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('Desktop window closed.')); } pending.clear(); } };
}
module.exports = { createFranklinHost, VIEWS, ACTIONS, activityObservation, mediaDraft, musicDraft };
