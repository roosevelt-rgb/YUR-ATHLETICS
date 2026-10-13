const { contextBridge, ipcRenderer, webUtils } = require('electron');
async function mediaInvoke(action, payload) {
  const response = await ipcRenderer.invoke('media:' + action, payload);
  if (!response?.ok) throw new Error(response?.error?.message || 'Media operation failed.');
  return response.result;
}

contextBridge.exposeInMainWorld('studio', {
  franklin: {
    snapshot: () => ipcRenderer.invoke('franklin:snapshot'), configure: patch => ipcRenderer.invoke('franklin:configure', patch),
    send: request => ipcRenderer.invoke('franklin:send', request), cancel: request => ipcRenderer.invoke('franklin:cancel', request),
    queueReconcile: request => ipcRenderer.invoke('franklin:queue-reconcile', request),
    hostReply: response => ipcRenderer.invoke('franklin:host-reply', response),
    onEvent: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('franklin:event', listener); return () => ipcRenderer.removeListener('franklin:event', listener); },
    onHostRequest: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('franklin:host-request', listener); return () => ipcRenderer.removeListener('franklin:host-request', listener); },
  },
  media: {
    catalog: () => mediaInvoke('catalog'), status: () => mediaInvoke('status'),
    configure: payload => mediaInvoke('configure', payload), list: payload => mediaInvoke('list', payload),
    submit: payload => mediaInvoke('submit', payload), inspect: payload => mediaInvoke('inspect', payload),
    resume: payload => mediaInvoke('resume', payload), cancel: payload => mediaInvoke('cancel', payload),
    asset: payload => mediaInvoke('asset', payload), importImage: () => mediaInvoke('importImage'),
    exportAsset: payload => mediaInvoke('exportAsset', payload),
  },
  music: {
    invoke: (action, payload = {}) => ipcRenderer.invoke('music:invoke', action, payload),
    asset: id => ipcRenderer.invoke('music:asset', id),
    save: id => ipcRenderer.invoke('music:save', id),
  },
  unreal: {
    invoke: (action, payload = {}) => ipcRenderer.invoke('unreal:invoke', action, payload),
    chooseProject: () => ipcRenderer.invoke('unreal:choose-project'),
    preview: () => ipcRenderer.invoke('unreal:preview'),
    onPreview: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('unreal:preview', listener); return () => ipcRenderer.removeListener('unreal:preview', listener); },
  },
  integration: { info: () => ipcRenderer.invoke('integration:info') },
  edition: { info: () => ipcRenderer.invoke('edition:info') },
  pageRuntimes: { list: () => ipcRenderer.invoke('page-runtimes:list') },
  rc6: {
    availableRuntimes: () => ipcRenderer.invoke('rc6:availableRuntimes'),
    chooseRuntime: key => ipcRenderer.invoke('rc6:chooseRuntime', key),
    console: (id, command) => ipcRenderer.invoke('rc6:console', id, command),
    chooseWorkspace: () => ipcRenderer.invoke('rc6:workspace'), disconnect: () => ipcRenderer.invoke('rc6:disconnect'),
    openWorkbench: () => ipcRenderer.invoke('rc6:openWorkbench'),
    status: () => ipcRenderer.invoke('rc6:status'), connect: selectedModel => ipcRenderer.invoke('rc6:connect', selectedModel),
    createSession: () => ipcRenderer.invoke('rc6:createSession'),
    inventory: () => ipcRenderer.invoke('rc6:inventory'), health: () => ipcRenderer.invoke('rc6:health'),
    info: () => ipcRenderer.invoke('rc6:info'), delegationStatus: id => ipcRenderer.invoke('rc6:delegationStatus', id),
    submit: (id, text) => ipcRenderer.invoke('rc6:submit', id, text),
    interrupt: id => ipcRenderer.invoke('rc6:interrupt', id),
    approval: (id, requestId, choice) => ipcRenderer.invoke('rc6:approval', id, requestId, choice),
    input: (id, requestId, kind, value) => ipcRenderer.invoke('rc6:input', id, requestId, kind, value),
    onEvent: callback => { const handler = (_event, value) => callback(value); ipcRenderer.on('rc6:event', handler); return () => ipcRenderer.removeListener('rc6:event', handler); },
  },
  // edition: an edition's launch page reads its athlete card (main registers it only for an edition).
  launch: { enter: () => ipcRenderer.invoke('desktop:enter'), spineStatus: () => ipcRenderer.invoke('substrate:status'), edition: () => ipcRenderer.invoke('edition:launch') },
  desktopSettings: {
    describe: () => ipcRenderer.invoke('desktop-settings:describe'),
    repository: root => ipcRenderer.invoke('desktop-settings:repository', root),
    licenses: () => ipcRenderer.invoke('desktop-settings:licenses'),
    capture: () => ipcRenderer.invoke('desktop-settings:capture'),
    notify: kind => ipcRenderer.invoke('desktop-settings:notify', kind),
  },
  factory: {
    open: () => ipcRenderer.invoke('factory:open'),
  },
  foundry: {
    info: () => ipcRenderer.invoke('foundry:info'),
    get: (path) => ipcRenderer.invoke('foundry:get', path),
    post: (path, body) => ipcRenderer.invoke('foundry:post', path, body),
    models: () => ipcRenderer.invoke('foundry:models'),
    health: () => ipcRenderer.invoke('foundry:health'),
    search: (query, topK) => ipcRenderer.invoke('foundry:search', query, topK),
    ask: (query, opts) => ipcRenderer.invoke('foundry:ask', query, opts),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    save: (conversation, expectedRevision) => ipcRenderer.invoke('conversations:save', conversation, expectedRevision),
  },
  capabilities: {
    describe: (...args) => ipcRenderer.invoke('desktop:capabilities', ...args),
  },
  workspace: {
    list: (kind) => ipcRenderer.invoke('workspace:list', kind),
    save: (kind, document, expectedRevision) => ipcRenderer.invoke('workspace:save', kind, document, expectedRevision),
  },
  projectFiles: {
    choose: () => ipcRenderer.invoke('project-files:choose'),
    list: request => ipcRenderer.invoke('project-files:list', request),
    add: request => ipcRenderer.invoke('project-files:add', request),
    remove: request => ipcRenderer.invoke('project-files:remove', request),
    context: request => ipcRenderer.invoke('project-files:context', request),
  },
  executionRuntime: {
    check: request => ipcRenderer.invoke('execution-runtime:check', request),
    prepare: request => ipcRenderer.invoke('execution-runtime:prepare', request),
    inspect: request => ipcRenderer.invoke('execution-runtime:inspect', request),
    release: request => ipcRenderer.invoke('execution-runtime:release', request),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Runtime setup events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('execution-runtime:event', handler);
      return () => ipcRenderer.removeListener('execution-runtime:event', handler);
    },
  },
  generation: {
    start: (request) => ipcRenderer.invoke('generation:start', request),
    cancel: (requestId) => ipcRenderer.invoke('generation:cancel', requestId),
    onEvent: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('Generation events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('generation:event', handler);
      return () => ipcRenderer.removeListener('generation:event', handler);
    },
  },
  activity: {
    snapshot: (...args) => ipcRenderer.invoke('activity:snapshot', ...args),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Activity events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('activity:event', handler);
      return () => ipcRenderer.removeListener('activity:event', handler);
    },
  },
  work: {
    inspectSpecialist: (parentId, specialistId) => ipcRenderer.invoke('work:inspect-specialist', parentId, specialistId),
    exportSpecialist: (parentId, specialistId) => ipcRenderer.invoke('work:export-specialist', parentId, specialistId),
    revealSpecialist: (parentId, specialistId) => ipcRenderer.invoke('work:reveal-specialist', parentId, specialistId),
    start: request => ipcRenderer.invoke('work:start', request),
    steer: request => ipcRenderer.invoke('work:steer', request),
    cancel: requestId => ipcRenderer.invoke('work:cancel', requestId),
    cancelMission: missionId => ipcRenderer.invoke('work:cancel-mission', missionId),
    list: conversationId => ipcRenderer.invoke('work:list', conversationId),
    inspect: missionId => ipcRenderer.invoke('work:inspect', missionId),
    validateDelivery: (missionId, artifactId) => ipcRenderer.invoke('work:validate-delivery', missionId, artifactId),
    deliver: (missionId, artifactId, token) => ipcRenderer.invoke('work:deliver', missionId, artifactId, token),
    reveal: (missionId, artifactId) => ipcRenderer.invoke('work:reveal', missionId, artifactId),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Work events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('work:event', handler);
      return () => ipcRenderer.removeListener('work:event', handler);
    },
  },
  specialists: {
    list: (limit = 20, cursor = null) => ipcRenderer.invoke('specialists:list', limit, cursor),
  },
  generatedSpecialists: {
    list: (limit = 20, cursor = null) => ipcRenderer.invoke('generated-specialists:list', limit, cursor),
  },
  concepts: {
    list: (limit = 20, cursor = null) => ipcRenderer.invoke('concepts:list', limit, cursor),
    inspect: conceptId => ipcRenderer.invoke('concepts:inspect', conceptId),
  },
  schedules: {
    list: () => ipcRenderer.invoke('schedules:list'),
    status: () => ipcRenderer.invoke('schedules:status'),
    save: (document, revision) => ipcRenderer.invoke('schedules:save', document, revision),
    events: (id, beforeId = null) => ipcRenderer.invoke('schedules:events', id, beforeId),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Schedule events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('schedule:event', handler);
      return () => ipcRenderer.removeListener('schedule:event', handler);
    },
  },
  organism: {
    status: () => ipcRenderer.invoke('organism:status'),
    pulse: mutation => ipcRenderer.invoke('pulse:intake', mutation),
  },
  ship: {
    list: () => ipcRenderer.invoke('ship:list'),
    create: spec => ipcRenderer.invoke('ship:create', spec),
    setState: (id, revision, state) => ipcRenderer.invoke('ship:state', id, revision, state),
    checkNow: id => ipcRenderer.invoke('ship:check-now', id),
    events: id => ipcRenderer.invoke('ship:events', id),
  },
  lifecycles: {
    list: () => ipcRenderer.invoke('lifecycles:list'),
    status: () => ipcRenderer.invoke('lifecycles:status'),
    runner: () => ipcRenderer.invoke('lifecycles:runner'),
    preview: trigger => ipcRenderer.invoke('lifecycles:preview', trigger),
    events: (id, beforeId = null) => ipcRenderer.invoke('lifecycles:events', id, beforeId),
    deploy: spec => ipcRenderer.invoke('lifecycles:deploy', spec),
    update: (id, revision, changes) => ipcRenderer.invoke('lifecycles:update', id, revision, changes),
    setState: (id, revision, state) => ipcRenderer.invoke('lifecycles:state', id, revision, state),
    runNow: (id, revision) => ipcRenderer.invoke('lifecycles:run-now', id, revision),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Lifecycle events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('lifecycle:event', handler);
      return () => ipcRenderer.removeListener('lifecycle:event', handler);
    },
  },
  harness: {
    status: () => ipcRenderer.invoke('harness:status'),
    start: () => ipcRenderer.invoke('harness:start'),
    stop: () => ipcRenderer.invoke('harness:stop'),
    request: (method, apiPath, body) => ipcRenderer.invoke('harness:request', method, apiPath, body),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Harness events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('harness:event', handler);
      return () => ipcRenderer.removeListener('harness:event', handler);
    },
  },
  marketplace: {
    inventory: () => ipcRenderer.invoke('harness:request', 'GET', '/api/inventory'),
    packs: () => ipcRenderer.invoke('harness:request', 'GET', '/api/packs'),
    pack: packId => ipcRenderer.invoke('harness:request', 'GET', `/api/packs/${packId}`),
    forge: body => ipcRenderer.invoke('harness:request', 'POST', '/api/karma/forge', body),
    deploy: (packId, options) => ipcRenderer.invoke('marketplace:deploy', packId, options),
  },
  artifacts: {
    open: (missionId, artifactId) => ipcRenderer.invoke('artifacts:open', missionId, artifactId),
    setBounds: bounds => ipcRenderer.invoke('artifacts:action', 'setBounds', bounds),
    setVisible: visible => ipcRenderer.invoke('artifacts:action', 'setVisible', visible),
    state: () => ipcRenderer.invoke('artifacts:action', 'state'),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Artifact events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('artifact:event', handler);
      return () => ipcRenderer.removeListener('artifact:event', handler);
    },
  },
  browser: {
    selectForWork: request => ipcRenderer.invoke('browser:select-for-work', request),
    releaseWorkSource: request => ipcRenderer.invoke('browser:release-work-source', request),
    navigate: url => ipcRenderer.invoke('browser:action', 'navigate', url),
    back: () => ipcRenderer.invoke('browser:action', 'back'),
    forward: () => ipcRenderer.invoke('browser:action', 'forward'),
    reload: () => ipcRenderer.invoke('browser:action', 'reload'),
    stop: () => ipcRenderer.invoke('browser:action', 'stop'),
    state: () => ipcRenderer.invoke('browser:action', 'state'),
    readVisiblePage: () => ipcRenderer.invoke('browser:action', 'readVisiblePage'),
    openExternal: () => ipcRenderer.invoke('browser:action', 'openExternal'),
    setBounds: bounds => ipcRenderer.invoke('browser:action', 'setBounds', bounds),
    setVisible: visible => ipcRenderer.invoke('browser:action', 'setVisible', visible),
    onEvent: callback => {
      if (typeof callback !== 'function') throw new TypeError('Browser events require a callback.');
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('browser:event', handler);
      return () => ipcRenderer.removeListener('browser:event', handler);
    },
  },
  voice: {
    info: () => ipcRenderer.invoke('voice:info'),
    arm: () => ipcRenderer.invoke('voice:arm'),
    release: () => ipcRenderer.invoke('voice:release'),
    transcribe: request => ipcRenderer.invoke('voice:transcribe', request),
    cancel: requestId => ipcRenderer.invoke('voice:cancel', requestId),
  },
  repository: {
    context: (request) => ipcRenderer.invoke('repository:context', request),
    bootstrap: (request) => ipcRenderer.invoke('repository:bootstrap', request),
  },
  attachments: {
    read: (request) => ipcRenderer.invoke('attachments:read', request),
    choose: () => ipcRenderer.invoke('attachments:choose'),
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  copilot: {
    catalog: (request) => ipcRenderer.invoke('copilot:catalog', request),
    acquire: (request) => ipcRenderer.invoke('copilot:acquire', request),
  },
  hermes: {
    catalog: (request) => ipcRenderer.invoke('hermes:catalog', request),
    acquire: (request) => ipcRenderer.invoke('hermes:acquire', request),
  },
  sources: {
    describe: (request = {}) => ipcRenderer.invoke('sources:describe', request),
    acquire: request => ipcRenderer.invoke('sources:acquire', request),
  },
  workforce: {
    catalog: (request) => ipcRenderer.invoke('workforce:catalog', request),
    acquire: (request) => ipcRenderer.invoke('workforce:acquire', request),
    run: (request) => ipcRenderer.invoke('workforce:run', request),
    result: (request) => ipcRenderer.invoke('workforce:result', request),
  },
  ollama: {
    info: () => ipcRenderer.invoke('ollama:info'),
    tags: () => ipcRenderer.invoke('ollama:tags'),
    workReadiness: model => ipcRenderer.invoke('ollama:work-readiness', model),
    chat: (model, messages) => ipcRenderer.invoke('ollama:chat', model, messages),
  },
  terminal: {
    spawn: (opts) => ipcRenderer.invoke('terminal:spawn', opts),
    input: (id, data) => ipcRenderer.send('terminal:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (cb) => {
      const handler = (e, id, data) => cb(id, data);
      ipcRenderer.on('terminal:data', handler);
      return () => ipcRenderer.removeListener('terminal:data', handler);
    },
  },
  file: {
    read: (path) => ipcRenderer.invoke('file:read', path),
    write: (path, content) => ipcRenderer.invoke('file:write', path, content),
    list: (path) => ipcRenderer.invoke('file:list', path),
    search: (dir, pattern) => ipcRenderer.invoke('file:search', dir, pattern),
    dialogOpen: () => ipcRenderer.invoke('file:dialog:open'),
    dialogSave: () => ipcRenderer.invoke('file:dialog:save'),
    dialogFolder: () => ipcRenderer.invoke('file:dialog:folder'),
  },
  code: {
    run: (language, code, cwd) => ipcRenderer.invoke('code:run', language, code, cwd),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
});
