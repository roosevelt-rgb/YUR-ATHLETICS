'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { desktopPython } = require('../src/desktop-runtime');
const { MARKER, ARCHIVE, PTH_CONTENT } = require('../src/embedded-runtime');
const sha = value => createHash('sha256').update(value).digest('hex');
const windowsX64 = process.platform === 'win32' && process.arch === 'x64';

function fixture(t, label = 'Portable α workspace') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-portable-python-'));
  const resources = path.join(temp, label, 'resources'), root = path.join(resources, 'app'), python = path.join(resources, 'python');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(python);
  // Inert bytes, never executable/imported. A dependency tripwire documents
  // that discovery fingerprints code rather than importing or launching it.
  const payloads = {
    'python.exe': 'INERT_EXECUTABLE_FIXTURE', 'python314.dll': 'INERT_DLL_FIXTURE', 'python314.zip': 'INERT_ZIP_FIXTURE',
    'python314._pth': PTH_CONTENT, 'Lib/site-packages/fixture_dependency/__init__.py': 'raise RuntimeError("THIS FIXTURE MUST NEVER BE IMPORTED")\n',
  };
  for (const [name, value] of Object.entries(payloads)) { const target = path.join(python, ...name.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
  const manifest = { schema: 'yur.embedded-python.v1', version: '3.14.7', platform: 'win32', arch: 'x64', entrypoint: 'python.exe', files: Object.entries(payloads).map(([name, value]) => ({ path: name, bytes: Buffer.byteLength(value), sha256: sha(value) })), archive: { ...ARCHIVE } };
  const marker = { schema: 'yur.desktop-distribution.v1', platform: 'win32', arch: 'x64', python_resource: '../python', python_manifest_sha256: '' };
  function save(raw = JSON.stringify(manifest)) { fs.writeFileSync(path.join(python, 'runtime.json'), raw); marker.python_manifest_sha256 = sha(raw); fs.writeFileSync(path.join(root, MARKER), JSON.stringify(marker)); }
  save();
  t.after(() => {
    const resolved = path.resolve(temp), relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert.equal(path.isAbsolute(relative) || relative.startsWith('..'), false); assert.ok(path.basename(resolved).startsWith('yur-portable-python-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { temp, resources, root, python, manifest, marker, save, resolve: () => desktopPython(root, {}),
    write(name, bytes) { fs.writeFileSync(path.join(python, ...name.split('/')), bytes); } };
}
const packaged = (name, fn) => test(name, { skip: windowsX64 ? false : 'The distribution under test targets Windows x64.' }, fn);

packaged('bundled Python resolves after two Unicode/spaces relocations without consulting host PATH', t => {
  for (const label of ['YUR Portable café 甲', 'Another 用户 folder 🧱']) {
    const f = fixture(t, label);
    assert.equal(desktopPython(f.root, { PATH: 'no-python-here' }), path.join(f.python, 'python.exe'));
    const moved = path.join(f.temp, label + ' relocated');
    fs.renameSync(path.dirname(f.resources), moved);
    assert.equal(desktopPython(path.join(moved, 'resources', 'app'), {}), path.join(moved, 'resources', 'python', 'python.exe'));
  }
});

test('explicit operator Python override retains priority and ordinary checkout venv/PATH behavior stays unchanged', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, MARKER), 'invalid');
  const override = path.join(f.temp, 'Chosen runtime', 'python.exe');
  assert.equal(desktopPython(f.root, { YUR_FACTORY_PYTHON: override }), override);
  const checkout = path.join(f.temp, 'checkout'); fs.mkdirSync(checkout);
  assert.equal(desktopPython(checkout, {}), 'python');
  const local = path.join(checkout, '.desktop-python', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, 'INERT_VENV_FIXTURE');
  assert.equal(desktopPython(checkout, {}), local);
});

packaged('missing marker, manifest, core or dependency fails closed instead of selecting host Python', t => {
  for (const target of ['marker', 'runtime.json', 'python.exe', 'python314.dll', 'Lib/site-packages/fixture_dependency/__init__.py']) {
    const f = fixture(t, target.replaceAll('/', '_'));
    fs.unlinkSync(target === 'marker' ? path.join(f.root, MARKER) : path.join(f.python, ...target.split('/')));
    assert.throws(f.resolve, { code: 'EMBEDDED_PYTHON_INVALID' });
  }
});

packaged('payload hashes are freshly checked for core/dependency tampering even when mtime and length are preserved', t => {
  for (const name of ['python.exe', 'python314.dll', 'Lib/site-packages/fixture_dependency/__init__.py']) {
    const f = fixture(t), target = path.join(f.python, ...name.split('/'));
    f.resolve(); const info = fs.statSync(target), content = fs.readFileSync(target); content[0] ^= 1;
    fs.writeFileSync(target, content); fs.utimesSync(target, info.atime, info.mtime);
    assert.throws(f.resolve, /fingerprint/);
  }
});

packaged('manifest digest and exact schemas reject corruption, architecture, extra argv and alternate resource paths', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.python, 'runtime.json'), ' '); assert.throws(f.resolve, /manifest digest/); f.save();
  for (const patch of [{ python_resource: '../../outside' }, { arch: 'arm64' }, { argv: ['-c', 'never execute'] }, { python_manifest_sha256: '0'.repeat(64) }]) {
    fs.writeFileSync(path.join(f.root, MARKER), JSON.stringify({ ...f.marker, ...patch })); assert.throws(f.resolve); f.save();
  }
  for (const patch of [{ entrypoint: 'Lib/site-packages/run.py' }, { version: '3.14.8' }, { arch: 'arm64' }, { environment: { PYTHONPATH: 'outside' } }, { archive: { ...ARCHIVE, source_url: 'https://other.test/' } }]) {
    f.save(JSON.stringify({ ...f.manifest, ...patch })); assert.throws(f.resolve); f.save();
  }
});

packaged('duplicate keys, invalid UTF8 and undeclared runtime code cannot become admissible metadata', t => {
  const f = fixture(t);
  f.save(JSON.stringify(f.manifest).replace('"entrypoint":"python.exe"', '"entrypoint":"ignored.exe","entrypoint":"python.exe"'));
  assert.throws(f.resolve, /duplicate/);
  f.save(Buffer.from([0xff, 0xfe, 0xff])); assert.throws(f.resolve, /UTF-8/); f.save();
  fs.writeFileSync(path.join(f.python, 'injected.py'), 'raise RuntimeError("UNLISTED")'); assert.throws(f.resolve, /inventory/);
});

packaged('file declarations reject traversal, ADS, case aliases, duplicate and omitted core identities', t => {
  const f = fixture(t), original = f.manifest.files;
  for (const name of ['../outside.py', '/absolute.py', 'C:/absolute.py', 'python.exe:stream', 'Lib\\outside.py', './python.exe', 'Lib//file.py', 'NUL', 'module.py.']) {
    f.manifest.files = [{ ...original[0], path: name }, ...original.slice(1)]; f.save(); assert.throws(f.resolve, { code: 'EMBEDDED_PYTHON_INVALID' });
  }
  f.manifest.files = [...original, { ...original[0], path: 'PYTHON.EXE' }]; f.save(); assert.throws(f.resolve, /duplicate/);
  f.manifest.files = original.filter(item => item.path !== 'python314.dll'); f.save(); assert.throws(f.resolve, /core/);
  f.manifest.files = [...original, { path: 'runtime.json', bytes: 0, sha256: sha('') }]; f.save(); assert.throws(f.resolve, /manifest itself/);
});

packaged('hashed search configuration cannot introduce host paths or site startup hooks', t => {
  const f = fixture(t), item = f.manifest.files.find(entry => entry.path === 'python314._pth');
  for (const content of [PTH_CONTENT + 'import site\n', 'C:\\private\\python\n', PTH_CONTENT.replace('../app', '../../outside')]) {
    f.write(item.path, content); item.bytes = Buffer.byteLength(content); item.sha256 = sha(content); f.save();
    assert.throws(f.resolve, /search paths/);
  }
  const alias = fixture(t), declaration = alias.manifest.files.find(entry => entry.path === 'python314._pth');
  const aliasPath = 'PYTHON314._PTH', injected = PTH_CONTENT + 'import site\n';
  fs.renameSync(path.join(alias.python, declaration.path), path.join(alias.python, aliasPath));
  alias.write(aliasPath, injected); declaration.path = aliasPath; declaration.bytes = Buffer.byteLength(injected); declaration.sha256 = sha(injected); alias.save();
  assert.throws(alias.resolve, /fixed name/);
});

packaged('late metadata or inventory changes are rejected before returning an interpreter', async t => {
  for (const mutation of ['marker', 'inventory']) await t.test(mutation, t => {
    const f = fixture(t), originalRead = fs.readSync; let changed = false;
    t.mock.method(fs, 'readSync', function (...args) {
      const count = originalRead.apply(fs, args);
      if (!changed && args[1].includes(Buffer.from('THIS FIXTURE MUST NEVER BE IMPORTED'))) {
        changed = true;
        if (mutation === 'marker') fs.appendFileSync(path.join(f.root, MARKER), ' ');
        else f.write('late.py', 'UNLISTED_SYNTHETIC_FILE');
      }
      return count;
    });
    assert.throws(f.resolve, /changed during verification/); assert.equal(changed, true);
  });
});

packaged('resource and dependency directory junctions are refused before reading external payloads', t => {
  for (const replaceResource of [true, false]) {
    const f = fixture(t), target = replaceResource ? f.python : path.join(f.python, 'Lib', 'site-packages');
    const donor = path.join(f.temp, replaceResource ? 'outside-runtime' : 'outside-dependency');
    fs.renameSync(target, donor); fs.symlinkSync(donor, target, 'junction');
    assert.throws(f.resolve, /links|junctions|location/);
  }
});

packaged('distribution directory junction and extra nested junction cannot bypass exact inventory', t => {
  const f = fixture(t), moved = path.join(f.temp, 'actual-app');
  fs.renameSync(f.root, moved); fs.symlinkSync(moved, f.root, 'junction'); assert.throws(f.resolve, /links|junctions|location/);
  fs.unlinkSync(f.root); fs.renameSync(moved, f.root);
  const extra = path.join(f.temp, 'extra'); fs.mkdirSync(extra); fs.symlinkSync(extra, path.join(f.python, 'extra'), 'junction');
  assert.throws(f.resolve, /links|junctions|location/);
});

packaged('manifest file and byte budgets reject impossible payload declarations before reading', t => {
  const f = fixture(t), original = f.manifest.files;
  for (const value of [-1, true, 128 * 1024 * 1024 + 1, 1.5]) {
    f.manifest.files = [{ ...original[0], bytes: value }, ...original.slice(1)]; f.save(); assert.throws(f.resolve, /declaration/);
  }
  f.manifest.files = Array.from({ length: 10001 }, (_, index) => ({ path: `file${index}`, bytes: 0, sha256: sha('') })); f.save(); assert.throws(f.resolve, /manifest/);
});
