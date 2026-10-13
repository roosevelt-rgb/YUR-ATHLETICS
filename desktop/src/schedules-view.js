/* Durable schedule editing only. The main-process scheduler dispatches Work. */
'use strict';
(() => {
  function text(tag, value = '', className = '') { const node = document.createElement(tag); node.textContent = String(value ?? ''); if (className) node.className = className; return node; }
  function timestamp(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString(); }
  function create(host, { api, dialog, field, getDefaults, getModels = () => [], beforeCreate = async () => {}, onOpenMission, onError = () => {} }) {
    const intro = text('p', 'Runs while YUR Desktop is open. Pending schedules resume due work after reopening. Closing Desktop cancels an active run and pauses that task. File edits still need review.', 'yc-schedules-note');
    const actions = text('div', '', 'yc-schedules-toolbar');
    const add = text('button', 'New scheduled task', 'yc-primary'); add.type = 'button'; add.id = 'yc-new-schedule';
    const refresh = text('button', 'Refresh'); refresh.type = 'button'; refresh.id = 'yc-refresh-schedules';
    actions.append(add, refresh);
    const status = text('p', '', 'yc-form-error'); status.id = 'yc-schedules-status'; status.setAttribute('role', 'status');
    const list = text('div', '', 'yc-schedule-list'); list.id = 'yc-schedule-list'; host.append(intro, actions, status, list);
    let disposed = false, generation = 0, loading = false, refreshAgain = false;
    async function call(fn) { const response = await fn(); if (!response?.ok) throw new Error(response?.error?.message || 'The schedule request failed.'); return response.result; }
    async function load() {
      if (disposed) return;
      if (loading) { refreshAgain = true; return; }
      loading = true; refresh.disabled = true; const ticket = ++generation;
      try {
        const result = await call(() => api.schedules.list());
        if (disposed || ticket !== generation) return;
        status.textContent = '';
        list.replaceChildren();
        if (!result.schedules.length) list.appendChild(text('p', 'No scheduled tasks yet. Create one for a recurring piece of work.', 'yc-section-empty'));
        for (const schedule of result.schedules) list.appendChild(render(schedule));
      } catch (error) { if (!disposed) status.textContent = error.message; }
      finally { loading = false; refresh.disabled = false; if (refreshAgain && !disposed) { refreshAgain = false; load(); } }
    }
    async function save(document, revision) {
      try { const result = await call(() => api.schedules.save(document, revision)); status.textContent = ''; await load(); if (result.cancellation_error) status.textContent = 'Schedule saved, but cancellation of its active run is not confirmed: ' + (result.cancellation_error.message || String(result.cancellation_error)); return result.schedule; }
      catch (error) { await load(); throw error; }
    }
    function updateTime(schedule) { return new Date(Math.max(Date.now(), Date.parse(schedule?.updated_at || '') || 0)).toISOString(); }
    function edit(schedule = null) {
      if (schedule?.active_request_id) { status.textContent = 'Pause the active task and wait for its run to finish before changing its configuration.'; return; }
      const defaults = getDefaults();
      dialog(schedule ? 'Edit scheduled task' : 'New scheduled task', schedule ? 'Save scheduled task' : 'Create scheduled task', body => {
        const name = field(body, 'schedule-name', 'Name', schedule?.name || defaults.name || '', 'text', 160); name.required = true;
        const goal = field(body, 'schedule-goal', 'Task instructions', schedule?.goal || defaults.goal || '', 'textarea', 32000); goal.required = true;
        const folder = field(body, 'schedule-root', 'Source folder (optional)', schedule ? schedule.root || '' : defaults.root || '', 'text', 4096);
        const choose = text('button', 'Choose folder'); choose.type = 'button'; choose.addEventListener('click', async () => { try { const result = await api.file.dialogFolder(); if (!result?.canceled && result.filePaths?.[0]) folder.value = result.filePaths[0]; } catch (error) { onError(error.message); } }); body.appendChild(choose);
        const model = field(body, 'schedule-model', 'Ollama model', schedule?.model || defaults.model || '', 'text', 256); model.required = true;
        const models = text('datalist'); models.id = 'yc-schedule-models'; for (const item of getModels()) { const option = text('option'); option.value = item; models.appendChild(option); } body.appendChild(models); model.setAttribute('list', models.id);
        const modeLabel = text('label', 'Mode', 'yc-field'); const mode = text('select'); mode.id = 'yc-schedule-mode';
        for (const value of ['work', 'code']) { const option = text('option', value === 'work' ? 'Work' : 'Code'); option.value = value; mode.appendChild(option); } mode.value = schedule?.mode || defaults.mode || 'work'; modeLabel.appendChild(mode); body.appendChild(modeLabel);
        const interval = field(body, 'schedule-interval', 'Interval in minutes', schedule ? String(schedule.interval_seconds / 60) : '60', 'number'); interval.min = '1'; interval.max = '1440'; interval.step = '1'; interval.required = true;
        const runs = field(body, 'schedule-max-runs', 'Maximum runs', String(schedule?.max_runs || 10), 'number'); runs.min = String(Math.max(1, schedule?.runs_completed || 0)); runs.max = '100'; runs.step = '1'; runs.required = true;
        const enabled = field(body, 'schedule-enabled', 'Enable this scheduled task', schedule ? schedule.enabled : true, 'checkbox');
        const now = field(body, 'schedule-run-now', 'Run as soon as saved', false, 'checkbox');
        body.appendChild(text('p', 'Only these task instructions and the selected folder are used for each run. Conversation history and unsent attachments are not automatically added.'));
        return { name, goal, folder, model, mode, interval, runs, enabled, now };
      }, async controls => {
        const interval = Number(controls.interval.value), maxRuns = Number(controls.runs.value);
        if (!Number.isInteger(interval) || interval < 1 || interval > 1440 || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) throw new Error('Use an interval of 1–1440 whole minutes and a budget of 1–100 runs.');
        const updated = updateTime(schedule);
        const { revision = 0, ...previous } = schedule || {};
        const document = { ...(schedule ? previous : { id: crypto.randomUUID(), conversation_id: defaults.conversation_id, created_at: updated, runs_completed: 0, active_request_id: null, last_mission_id: null, last_error: '' }), name: controls.name.value.trim(), goal: controls.goal.value.trim(), root: controls.folder.value.trim() || null,
          provider: 'ollama', model: controls.model.value.trim(), mode: controls.mode.value, interval_seconds: interval * 60, max_runs: maxRuns, enabled: controls.enabled.checked, updated_at: updated,
          next_run_at: controls.now.checked ? updated : schedule?.next_run_at || new Date(Date.parse(updated) + interval * 60000).toISOString() };
        if (!schedule) await beforeCreate(defaults.conversation_id);
        await save(document, revision);
      });
    }
    function render(schedule) {
      const card = text('article', '', 'yc-schedule-card'); card.dataset.scheduleId = schedule.id;
      const busy = Boolean(schedule.active_request_id), exhausted = schedule.runs_completed >= schedule.max_runs;
      const heading = text('div', '', 'yc-schedule-heading'); heading.append(text('h2', schedule.name), text('span', busy ? schedule.enabled ? 'Running' : 'Pausing' : exhausted ? 'Run limit reached' : schedule.enabled ? 'Scheduled' : 'Paused', 'yc-schedule-state')); card.appendChild(heading);
      card.append(text('p', schedule.goal, 'yc-schedule-goal'), text('p', `${schedule.mode === 'code' ? 'Code' : 'Work'} · ${schedule.model} · every ${schedule.interval_seconds / 60} ${schedule.interval_seconds === 60 ? 'minute' : 'minutes'}`), text('p', `${schedule.runs_completed} of ${schedule.max_runs} runs used`, 'yc-schedule-budget'), text('p', `Next run: ${timestamp(schedule.next_run_at)}${!schedule.enabled ? ' (paused)' : ''}`, 'yc-schedule-due'));
      if (schedule.root) card.appendChild(text('p', schedule.root, 'yc-work-destination'));
      if (schedule.last_error) card.appendChild(text('p', schedule.last_error, 'yc-form-error'));
      const buttons = text('div', '', 'yc-schedule-actions');
      const change = text('button', 'Edit task'); change.type = 'button'; change.disabled = busy; change.addEventListener('click', () => edit(schedule)); buttons.appendChild(change);
      const pause = text('button', schedule.enabled ? 'Pause task' : 'Resume task'); pause.type = 'button'; pause.disabled = (!schedule.enabled && (busy || exhausted));
      pause.addEventListener('click', async () => { pause.disabled = true; try { const { revision, ...document } = schedule; await save({ ...document, enabled: !schedule.enabled, updated_at: updateTime(schedule) }, revision); } catch (error) { status.textContent = error.message; } finally { if (pause.isConnected) pause.disabled = false; } }); buttons.appendChild(pause);
      if (schedule.last_mission_id && onOpenMission) { const open = text('button', 'Open last run'); open.type = 'button'; open.addEventListener('click', () => onOpenMission(schedule.last_mission_id)); buttons.appendChild(open); }
      card.appendChild(buttons);
      const history = document.createElement('details'); history.appendChild(text('summary', 'Task history')); const events = text('div', '', 'yc-schedule-events'); history.appendChild(events); card.appendChild(history);
      let cursor = null, historyLoaded = false, historyLoading = false;
      async function loadEvents() {
        if (historyLoading) return; historyLoading = true;
        try {
          const result = await call(() => api.schedules.events(schedule.id, cursor));
          if (!history.isConnected) return;
          events.querySelector('.yc-schedule-more')?.remove();
          for (const event of result.events) { const item = document.createElement('details'); item.appendChild(text('summary', `${event.event_type.replace(/[._]/g, ' ')} · ${timestamp(event.created_at)}`)); const change = text('pre', JSON.stringify(event.change ?? event.data?.change ?? {}, null, 2), 'yc-work-preview'); item.appendChild(change); events.appendChild(item); }
          cursor = result.next_before_id; historyLoaded = true;
          if (!events.childElementCount) events.appendChild(text('p', 'No task events returned.'));
          if (cursor !== null && cursor !== undefined) { const more = text('button', 'Older events', 'yc-schedule-more'); more.type = 'button'; more.addEventListener('click', loadEvents); events.appendChild(more); }
        } catch (error) { events.appendChild(text('p', error.message, 'yc-form-error')); }
        finally { historyLoading = false; }
      }
      history.addEventListener('toggle', () => { if (history.open && !historyLoaded) loadEvents(); });
      return card;
    }
    add.addEventListener('click', () => edit()); refresh.addEventListener('click', () => load());
    const unsubscribe = api.schedules.onEvent?.(() => load()); load();
    function dispose() { disposed = true; generation++; unsubscribe?.(); }
    return Object.freeze({ refresh: load, create: () => edit(), dispose });
  }
  window.yurSchedulesView = Object.freeze({ create });
})();
