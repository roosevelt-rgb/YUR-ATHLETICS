'use strict';

// Selection is persisted through the existing workspace Commit Service. This
// helper owns no state and never starts an editor or contacts its MCP listener.
function createUnrealSelection({ getEnvironment, getSettings, readProject, resolveProject, chooseProject, saveSettings, applySettings, deny }) {
  const hostMessage = 'Unreal is controlled by this Desktop launch configuration. Update or clear its Unreal project and connection settings before choosing another project.';
  function environment() {
    const env = getEnvironment() || {};
    return { project: env.YUR_UNREAL_PROJECT || '', endpoint: env.YUR_UNREAL_MCP_URL || '' };
  }
  function configuration() {
    const env = environment(), preferences = getSettings()?.preferences || {};
    // Environment and persisted preferences are complete, independent sources.
    // An endpoint-only environment binding cannot borrow a saved project.
    const selected = env.project || env.endpoint
      ? env : { project: preferences.unreal_project_file, endpoint: preferences.unreal_mcp_url };
    if (!selected.project) return null;
    try {
      const config = readProject(selected.project);
      return { ...config, ...(selected.endpoint ? { endpoint: selected.endpoint } : {}) };
    } catch { return null; }
  }
  function check(identity) {
    if (!identity || typeof identity.isActive !== 'function' || !identity.isActive()) throw new Error('The project selection window closed or changed.');
    const settings = getSettings() || {};
    const reason = deny(settings);
    if (reason) throw new Error(reason);
    const env = environment();
    if (env.project || env.endpoint) throw Object.assign(new Error(hostMessage), { code: 'UNREAL_HOST_OVERRIDE' });
  }
  async function choose(identity) {
    try {
      check(identity);
      const selected = await chooseProject();
      check(identity);
      if (selected.canceled || !selected.filePaths?.[0]) return { ok: true, result: { cancelled: true } };
      const config = await resolveProject(selected.filePaths[0]);
      check(identity);
      const { revision = 0, ...saved } = getSettings() || {};
      const document = { id: 'desktop', theme: 'system', default_model: '', foundry_url: '', ollama_url: '', custom_instructions: '', ...saved,
        preferences: { ...saved.preferences, unreal_project_file: config.project_file, unreal_mcp_url: config.endpoint } };
      const committed = await saveSettings(document, revision);
      if (!committed.ok) return committed;
      const applied = applySettings(committed.result.document);
      if (applied?.ok === false) return applied;
      check(identity);
      const effective = configuration();
      if (effective?.project_file !== config.project_file || effective?.endpoint !== config.endpoint) {
        throw new Error('The saved Unreal selection was superseded by newer settings. Check the current project before continuing.');
      }
      return { ok: true, result: { selected: true, project_file: effective.project_file, started: false } };
    } catch (error) {
      return { ok: false, error: { code: error.code || 'UNREAL_SELECTION_FAILED', message: String(error.message).slice(0, 1000) } };
    }
  }
  return { configuration, choose };
}

module.exports = { createUnrealSelection };
