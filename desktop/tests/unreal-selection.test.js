'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUnrealSelection } = require('../src/unreal-selection');
const contract = require('../settings-preferences.json');

const A = { project_file: 'D:\\fixture-a\\A.uproject', endpoint: 'http://127.0.0.1:9001/mcp' };
const B = { project_file: 'D:\\fixture-b\\B.uproject', endpoint: 'http://127.0.0.1:9002/mcp' };
const prefs = config => ({ unreal_project_file: config.project_file, unreal_mcp_url: config.endpoint });
function fixture(overrides = {}) {
  const state = { env: {}, settings: {}, active: true, blocked: false, picks: 0, resolutions: 0, saves: [], ...overrides.state };
  const dependencies = {
    getEnvironment: () => state.env, getSettings: () => state.settings,
    readProject: project => { if (![A.project_file, B.project_file].includes(project)) throw new Error('Missing project'); return { ...(project === A.project_file ? A : B) }; },
    resolveProject: async project => { state.resolutions++; return dependencies.readProject(project); },
    chooseProject: async () => { state.picks++; return { canceled: false, filePaths: [B.project_file] }; },
    saveSettings: async (document, revision) => { state.saves.push({ document, revision }); return { ok: true, result: { document: { ...document, revision: revision + 1 } } }; },
    applySettings: document => { if ((document.revision || 0) >= (state.settings.revision || 0)) state.settings = document; return { ok: true }; },
    deny: () => state.blocked ? 'Restricted session' : null,
    ...overrides.dependencies,
  };
  return { state, dependencies, selection: createUnrealSelection(dependencies), identity: { isActive: () => state.active } };
}

test('host environment is one atomic binding and cannot borrow the saved endpoint or project', () => {
  const f = fixture({ state: { env: { YUR_UNREAL_PROJECT: A.project_file }, settings: { preferences: prefs(B) } } });
  assert.deepEqual(f.selection.configuration(), A);
  f.state.env.YUR_UNREAL_MCP_URL = 'http://127.0.0.1:9100/mcp';
  assert.deepEqual(f.selection.configuration(), { ...A, endpoint: f.state.env.YUR_UNREAL_MCP_URL });
  delete f.state.env.YUR_UNREAL_PROJECT;
  assert.equal(f.selection.configuration(), null);
  f.state.env = {};
  assert.deepEqual(f.selection.configuration(), B);
});

test('host configuration prevents a misleading selection without opening the picker or saving', async () => {
  for (const env of [{ YUR_UNREAL_PROJECT: A.project_file }, { YUR_UNREAL_MCP_URL: A.endpoint }]) {
    const f = fixture({ state: { env } });
    const result = await f.selection.choose(f.identity);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'UNREAL_HOST_OVERRIDE');
    assert.match(result.error.message, /launch configuration/);
    assert.equal(f.state.picks, 0); assert.equal(f.state.saves.length, 0);
  }
});

test('native selection commits a valid complete document, preserves unrelated settings and survives helper recreation', async () => {
  const f = fixture({ state: { settings: { id: 'desktop', revision: 4, theme: 'dark', default_model: 'selected',
    foundry_url: '', ollama_url: '', custom_instructions: 'Keep this', preferences: { background_enabled: false } } } });
  const result = await f.selection.choose(f.identity);
  assert.deepEqual(result, { ok: true, result: { selected: true, project_file: B.project_file, started: false } });
  const { document, revision } = f.state.saves[0];
  assert.equal(revision, 4); assert.equal(Object.hasOwn(document, 'revision'), false);
  assert.equal(document.theme, 'dark'); assert.equal(document.custom_instructions, 'Keep this');
  assert.equal(document.preferences.background_enabled, false);
  assert.deepEqual({ ...document.preferences, background_enabled: undefined }, { ...prefs(B), background_enabled: undefined });
  for (const key of Object.keys(prefs(B))) {
    assert.equal(contract.fields[key].type, 'string');
    assert.ok(document.preferences[key].length <= contract.fields[key].max_length);
  }
  assert.deepEqual(createUnrealSelection(f.dependencies).configuration(), B);
});

test('first selection supplies every required settings field and a cancelled picker saves nothing', async () => {
  const f = fixture(); await f.selection.choose(f.identity);
  assert.deepEqual(Object.keys(f.state.saves[0].document).sort(), ['custom_instructions', 'default_model', 'foundry_url', 'id', 'ollama_url', 'preferences', 'theme']);
  const cancelled = fixture({ dependencies: { chooseProject: async () => ({ canceled: true }) } });
  assert.deepEqual(await cancelled.selection.choose(cancelled.identity), { ok: true, result: { cancelled: true } });
  assert.equal(cancelled.state.saves.length, 0); assert.equal(cancelled.state.resolutions, 0);
});

test('owner, policy and environment are checked after the dialog and resolver before commit', async () => {
  for (const stage of ['chooseProject', 'resolveProject']) {
    for (const change of ['owner', 'policy', 'environment']) {
      const f = fixture();
      const changeState = () => {
        if (change === 'owner') f.state.active = false;
        if (change === 'policy') f.state.blocked = true;
        if (change === 'environment') f.state.env.YUR_UNREAL_PROJECT = A.project_file;
      };
      f.dependencies[stage] = async () => { changeState(); return stage === 'chooseProject' ? { canceled: false, filePaths: [B.project_file] } : B; };
      f.selection = createUnrealSelection(f.dependencies);
      assert.equal((await f.selection.choose(f.identity)).ok, false, stage + ':' + change);
      assert.equal(f.state.saves.length, 0, stage + ':' + change);
    }
  }
});

test('a failed save or settings application never reports successful selection', async () => {
  for (const which of ['saveSettings', 'applySettings']) {
    const failure = { ok: false, error: { message: 'Conflict or invalid settings' } };
    const f = fixture({ dependencies: { [which]: async () => failure } });
    // applySettings is deliberately synchronous in production.
    if (which === 'applySettings') { f.dependencies.applySettings = () => failure; f.selection = createUnrealSelection(f.dependencies); }
    assert.deepEqual(await f.selection.choose(f.identity), failure);
    assert.equal(f.selection.configuration(), null);
  }
});

test('a newer committed preference wins over a late picker reply with no stale process cache', async () => {
  const f = fixture();
  f.dependencies.saveSettings = async (document, revision) => {
    f.state.settings = { preferences: prefs(A), revision: revision + 2 };
    return { ok: true, result: { document: { ...document, revision: revision + 1 } } };
  };
  f.selection = createUnrealSelection(f.dependencies);
  const result = await f.selection.choose(f.identity);
  assert.equal(result.ok, false); assert.match(result.error.message, /superseded/);
  assert.deepEqual(f.selection.configuration(), A);
});

test('a policy or owner change during commit prevents an effective-selection success claim', async () => {
  for (const change of ['owner', 'policy', 'environment']) {
    const f = fixture(), save = f.dependencies.saveSettings;
    f.dependencies.saveSettings = async (...args) => {
      const committed = await save(...args);
      if (change === 'owner') f.state.active = false;
      if (change === 'policy') f.state.blocked = true;
      if (change === 'environment') f.state.env.YUR_UNREAL_PROJECT = A.project_file;
      return committed;
    };
    f.selection = createUnrealSelection(f.dependencies);
    assert.equal((await f.selection.choose(f.identity)).ok, false);
    assert.deepEqual(f.selection.configuration(), change === 'environment' ? A : B);
  }
});
