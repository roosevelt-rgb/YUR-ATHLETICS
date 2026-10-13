'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFranklinUnreal, UNREAL_ACTIONS, readUnrealProjectConfiguration, resolveUnrealProjectConfiguration } = require('../src/franklin-unreal');
const PROJECT = path.resolve('fixture-project/Existing.uproject');
const APP = 'EditorToolset.EditorAppToolset', SCENE = 'editor_toolset.toolsets.scene.SceneTools';
const POSE = { location: { x: 10, y: 20, z: 30 }, rotation: { pitch: 0, yaw: 90, roll: 0 } };
const objectShape = keys => ({ type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'number' }])), required: keys });
function tools() {
  return [
    { name: SCENE + '.get_current_level', inputSchema: { type: 'object' } },
    ...['GetSelectedActors', 'GetSelectedAssets', 'GetCameraTransform'].map(name => ({ name: APP + '.' + name, inputSchema: { type: 'object' } })),
    { name: APP + '.CaptureViewport', inputSchema: { type: 'object', properties: { captureTransform: { type: 'object' }, annotations: { type: 'object' }, bShowUI: { type: 'boolean', default: false } } } },
    { name: APP + '.SetCameraTransform', inputSchema: { type: 'object', properties: { transform: { type: 'object', properties: {
      location: objectShape(['x', 'y', 'z']), rotation: objectShape(['pitch', 'yaw', 'roll']), scale: objectShape(['x', 'y', 'z']),
    } } }, required: ['transform'] } },
  ];
}
const meta = [
  { name: 'list_toolsets', inputSchema: { type: 'object' } },
  { name: 'describe_toolset', inputSchema: { type: 'object', properties: { toolset_name: { type: 'string' } }, required: ['toolset_name'] } },
  { name: 'call_tool', inputSchema: { type: 'object', properties: { toolset_name: { type: 'string' }, tool_name: { type: 'string' }, arguments: { type: 'object' } }, required: ['tool_name'] } },
];
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
async function server(t, options = {}) {
  const calls = [], known = tools();
  const s = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); const call = { body, headers: req.headers, url: req.url }; calls.push(call);
    const reply = result => { if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); } };
    if (await options.handle?.(call, res, reply) === true) return;
    if (body.method === 'initialize') reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'unreal-mcp', version: 'fixture' } });
    else if (body.method === 'notifications/initialized') res.writeHead(202).end();
    else if (body.method === 'tools/list') reply({ tools: options.search ? meta : known });
    else if (body.params.name === 'describe_toolset') reply(content({ tools: known.filter(tool => tool.name.startsWith(body.params.arguments.toolset_name + '.')) }));
    else {
      const name = body.params.name === 'call_tool' ? body.params.arguments.tool_name : body.params.name.split('.').at(-1);
      let value = { returnValue: null };
      if (name === 'get_current_level') value = { returnValue: '/Game/Fixture.Level' };
      if (name === 'GetSelectedActors') value = { returnValue: [{ refPath: '/Game/Fixture.Level:PersistentLevel.Cube' }] };
      if (name === 'GetSelectedAssets') value = { returnValue: ['/Game/Fixture'] };
      if (name === 'GetCameraTransform') value = { returnValue: { ...POSE, scale: { x: 1, y: 1, z: 1 } } };
      if (name === 'CaptureViewport') value = { returnValue: { image: { mimeType: 'image/png', data: PNG.toString('base64') }, extra: 'never forwarded' } };
      reply(content(value));
    }
  });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(() => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }));
  return { endpoint: `http://127.0.0.1:${s.address().port}/mcp`, calls, tools: known };
}
function fixture(options = {}) {
  let active = true, denied = false, sequence = 1, connection = 'fixture:created1', config = { project_file: PROJECT, endpoint: options.endpoint || 'http://127.0.0.1:1/mcp' };
  const captures = [], policies = [], owner = { isDestroyed: () => false };
  const identity = () => ({ owner, request_id: '12345678-1234-1234-1234-123456789abc', mission_id: 'b'.repeat(32), action_id: (sequence++).toString(16).padStart(32, '0'), isActive: () => active });
  const adapter = createFranklinUnreal({ getConfiguration: () => config, verifyProjectBinding: async () => ({ project_file: PROJECT, process_id: 1234, connection_id: connection }),
    deny: (...args) => { policies.push(args); return denied; }, getSettings: () => ({}), onCapture: async (capture, id) => captures.push({ capture, id }), ...options });
  return { adapter, identity, captures, policies, cancel: () => { active = false; }, block: () => { denied = true; }, restart: () => { connection = 'fixture:created2'; }, change: value => { config = value; } };
}

test('Unreal exposes only four typed actions and reports unconfigured truthfully', async () => {
  const f = fixture({ getConfiguration: () => null });
  assert.deepEqual(UNREAL_ACTIONS, ['unreal_status', 'unreal_inspect', 'unreal_capture', 'unreal_camera']);
  assert.equal(f.adapter.accepts('unreal_script'), false); assert.equal(f.adapter.isReadOnly('unreal_camera'), false);
  assert.equal(f.adapter.catalog()[0].status, 'unavailable');
  assert.equal((await f.adapter.execute('unreal_status', {}, f.identity())).status, 'unconfigured');
  await assert.rejects(f.adapter.execute('unreal_capture', {}, f.identity()), /not configured/);
});
test('closed inputs reject URLs, scripts, extra coordinates and nonfinite or excessive values', async () => {
  const f = fixture();
  for (const [action, args] of [['unreal_status', { url: 'https://example.test' }], ['unreal_inspect', { kind: 'console' }],
    ['unreal_capture', { script: 'noop' }], ['unreal_camera', { ...POSE, root: PROJECT }],
    ['unreal_camera', { ...POSE, location: { ...POSE.location, x: Infinity } }], ['unreal_camera', { ...POSE, rotation: { ...POSE.rotation, yaw: 361 } }]])
    await assert.rejects(f.adapter.validate(action, args, f.identity()), /typed|supported|finite|bounds/);
});
test('remote, credentialed, redirect and malformed endpoint configurations are rejected', async () => {
  for (const endpoint of ['https://127.0.0.1:8000/mcp', 'http://example.test:8000/mcp', 'http://user:secret@127.0.0.1:8000/mcp', 'http://127.0.0.1:8000/mcp?url=x', 'http://127.0.0.2:8000/mcp']) {
    const f = fixture({ getConfiguration: () => ({ project_file: PROJECT, endpoint }) });
    await assert.rejects(f.adapter.execute('unreal_status', {}, f.identity()), /loopback/);
  }
});
test('MCP handshake negotiates headers then exact native inspections; no data controls tool names', async t => {
  const s = await server(t), f = fixture(s);
  const status = await f.adapter.execute('unreal_status', {}, f.identity());
  assert.equal(status.status, 'connected'); assert.deepEqual(status.inspections, ['level', 'selection', 'camera', 'assets']);
  assert.equal((await f.adapter.execute('unreal_inspect', { kind: 'level' }, f.identity())).level, '/Game/Fixture.Level');
  assert.deepEqual((await f.adapter.execute('unreal_inspect', { kind: 'camera' }, f.identity())).camera, POSE);
  assert.deepEqual((await f.adapter.execute('unreal_inspect', { kind: 'selection' }, f.identity())).selection, ['/Game/Fixture.Level:PersistentLevel.Cube']);
  assert.deepEqual((await f.adapter.execute('unreal_inspect', { kind: 'assets' }, f.identity())).assets, ['/Game/Fixture']);
  assert.deepEqual(s.calls.slice(0, 3).map(c => c.body.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(s.calls.slice(1).every(c => c.headers['mcp-session-id'] === 'fixture-session' && c.headers['mcp-protocol-version'] === '2025-11-25'));
  assert.ok(s.calls.every(c => !c.headers.authorization && c.url === '/mcp'));
});
test('project mismatch fails before any network exchange, restart invalidates reviewed camera', async t => {
  const s = await server(t), wrong = fixture({ ...s, verifyProjectBinding: async () => ({ project_file: path.resolve('other.uproject'), process_id: 1, connection_id: 'other:created' }) });
  assert.equal((await wrong.adapter.execute('unreal_status', {}, wrong.identity())).status, 'unavailable'); assert.equal(s.calls.length, 0);
  const f = fixture(s), id = f.identity(); await f.adapter.validate('unreal_camera', POSE, id); f.restart();
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), /changed/);
  assert.equal(s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform').length, 0);
});
test('known camera action requires preflight, confirmation, unchanged envelope and one dispatch', async t => {
  const s = await server(t), f = fixture(s), id = f.identity();
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), /fresh/);
  await f.adapter.validate('unreal_camera', POSE, id);
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id), /confirmation/);
  await assert.rejects(f.adapter.execute('unreal_camera', { ...POSE, location: { ...POSE.location, z: 50 } }, id, { confirmed: true }), /scope changed/);
  const result = await f.adapter.execute('unreal_camera', POSE, id, { confirmed: true });
  assert.equal(result.changed, true); assert.equal(result.persisted, false);
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), /fresh/);
  const writes = s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform');
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].body.params.arguments, { transform: POSE });
});
test('tool-search mode negotiates schemas and dispatches only exact fully qualified source tools', async t => {
  const s = await server(t, { search: true }), f = fixture(s), id = f.identity();
  await f.adapter.validate('unreal_camera', POSE, id); await f.adapter.execute('unreal_camera', POSE, id, { confirmed: true });
  const write = s.calls.find(c => c.body.params?.name === 'call_tool');
  assert.deepEqual(write.body.params, { name: 'call_tool', arguments: { toolset_name: APP, tool_name: 'SetCameraTransform', arguments: { transform: POSE } } });
  assert.ok(s.calls.filter(c => c.body.params?.name === 'describe_toolset').every(c => [APP, SCENE].includes(c.body.params.arguments.toolset_name)));
});
test('concurrent camera execution with one approved identity can dispatch only once', async t => {
  const s = await server(t), f = fixture(s), id = f.identity(); await f.adapter.validate('unreal_camera', POSE, id);
  const outcomes = await Promise.allSettled([f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), f.adapter.execute('unreal_camera', POSE, id, { confirmed: true })]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
  assert.equal(s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform').length, 1);
});
test('capture sends bounded PNG only to native preview and returns small hash metadata to Franklin', async t => {
  const s = await server(t), f = fixture(s); const result = await f.adapter.execute('unreal_capture', {}, f.identity());
  assert.equal(result.capture.width, 1); assert.equal(result.capture.bytes, PNG.length); assert.equal(result.capture.preview_delivered, true);
  assert.equal(f.captures.length, 1); assert.deepEqual(f.captures[0].capture.bytes, PNG); assert.equal(result.capture.sha256, f.captures[0].capture.sha256);
  assert.ok(JSON.stringify(result).length < 1024); assert.equal(JSON.stringify(result).includes(PNG.toString('base64')), false);
  const call = s.calls.find(c => c.body.params?.name === APP + '.CaptureViewport'); assert.deepEqual(call.body.params.arguments, {});
});
test('policy revocation, owner cancellation and config changes after review prevent camera dispatch', async t => {
  const s = await server(t);
  for (const revoke of [f => f.block(), f => f.cancel(), f => f.change({ project_file: PROJECT, endpoint: s.endpoint + '/other' })]) {
    const f = fixture(s), id = f.identity(); await f.adapter.validate('unreal_camera', POSE, id); revoke(f);
    await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), /policy|active|scope changed/);
  }
  assert.equal(s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform').length, 0);
});
test('project changes during final async binding prevent dispatch and stale capture delivery', async t => {
  const s = await server(t);
  for (const action of ['unreal_camera', 'unreal_capture']) {
    let count = 0, f;
    f = fixture({ ...s, verifyProjectBinding: async () => {
      if (++count === 4) f.change({ project_file: PROJECT, endpoint: s.endpoint + '/changed' });
      return { project_file: PROJECT, process_id: 1234, connection_id: 'fixture:created1' };
    } });
    const id = f.identity();
    if (action === 'unreal_camera') await f.adapter.validate(action, POSE, id);
    await assert.rejects(f.adapter.execute(action, action === 'unreal_camera' ? POSE : {}, id, { confirmed: true }), /configuration changed/);
    assert.equal(f.captures.length, 0);
  }
  assert.equal(s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform').length, 0);
});
test('changed or ambiguous negotiated schema prevents any camera dispatch', async t => {
  const s = await server(t), f = fixture(s), id = f.identity(); await f.adapter.validate('unreal_camera', POSE, id);
  s.tools.find(t => t.name.endsWith('SetCameraTransform')).inputSchema.properties.transform.description = 'changed schema';
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), /schema changed/);
  assert.equal(s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform').length, 0);
  s.tools.push(s.tools[0]);
  const second = fixture(s); assert.equal((await second.adapter.execute('unreal_status', {}, second.identity())).status, 'unavailable');
});
test('lost mutation reply is uncertain, redacts native diagnostics and is never retried', async t => {
  const s = await server(t, { handle: (call, res) => { if (call.body.params?.name === APP + '.SetCameraTransform') { res.destroy(); return true; } } }), f = fixture(s), id = f.identity();
  await f.adapter.validate('unreal_camera', POSE, id);
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), error => error.code === 'UNREAL_OUTCOME_UNCERTAIN');
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), /fresh/);
  assert.equal(s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform').length, 1);
});
test('unexpected camera success envelope remains uncertain and never reports changed', async t => {
  const s = await server(t, { handle: (call, res, reply) => { if (call.body.params?.name === APP + '.SetCameraTransform') { reply(content({ returnValue: false })); return true; } } }), f = fixture(s), id = f.identity();
  await f.adapter.validate('unreal_camera', POSE, id);
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), error => error.code === 'UNREAL_OUTCOME_UNCERTAIN');
  await assert.rejects(f.adapter.execute('unreal_camera', POSE, id, { confirmed: true }), /fresh/);
  assert.equal(s.calls.filter(c => c.body.params?.name === APP + '.SetCameraTransform').length, 1);
});
test('bounded HTTP transport rejects redirects, oversized replies and wrong protocol without following', async t => {
  for (const mode of ['redirect', 'oversized', 'protocol']) {
    const s = await server(t, { handle: (call, res, reply) => { if (mode === 'redirect') res.writeHead(302, { Location: 'http://example.test/' }).end();
      else if (mode === 'oversized') res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(9 * 1024 * 1024) }).end();
      else reply({ protocolVersion: '2099-01-01', capabilities: { tools: {} } }); return true; } });
    const f = fixture(s); assert.equal((await f.adapter.execute('unreal_status', {}, f.identity())).status, 'unavailable'); assert.equal(s.calls.length, 1);
  }
});
test('invalid images and mismatched output contracts never enter native preview', async t => {
  const s = await server(t, { handle: (call, res, reply) => { if (call.body.params?.name === APP + '.CaptureViewport') { reply(content({ returnValue: { image: { mimeType: 'image/svg+xml', data: 'PRIVATE_NATIVE_OUTPUT' } } })); return true; } } }), f = fixture(s);
  await assert.rejects(f.adapter.execute('unreal_capture', {}, f.identity()), /supported PNG/); assert.equal(f.captures.length, 0);
});
test('source configuration reads only named MCP settings and rejects nonenabled projects', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unreal-config-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'Existing.uproject'); fs.writeFileSync(project, JSON.stringify({ Plugins: [{ Name: 'ModelContextProtocol', Enabled: true }] }));
  fs.mkdirSync(path.join(root, 'Config')); fs.writeFileSync(path.join(root, 'Config/DefaultEditorPerProjectUserSettings.ini'), '[Unrelated]\nSecret=PRIVATE_NOT_RETURNED\n[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]\nServerPortNumber=8102\nServerUrlPath=/engine/mcp\n');
  assert.deepEqual(readUnrealProjectConfiguration(project), { project_file: project, endpoint: 'http://127.0.0.1:8102/engine/mcp' });
  assert.equal((await resolveUnrealProjectConfiguration(project, { readRuntimePort: async selected => { assert.equal(selected, project); return 8321; } })).endpoint, 'http://127.0.0.1:8321/engine/mcp');
  assert.equal((await resolveUnrealProjectConfiguration(project, { readRuntimePort: async () => null })).endpoint, 'http://127.0.0.1:8102/engine/mcp');
  await assert.rejects(resolveUnrealProjectConfiguration(project, { readRuntimePort: async () => 65536 }), /invalid MCP port/);
  fs.writeFileSync(project, '{}'); assert.throws(() => readUnrealProjectConfiguration(project), /not enabled/);
});
