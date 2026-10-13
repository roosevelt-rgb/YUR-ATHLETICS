'use strict';
// Serial, CPU-bounded independent validation of retained Desktop surfaces.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const evidence = path.resolve(root, '../..', 'evidence/glider-rc6/comprehensive/completion-2026-10-05/retained-surfaces');
fs.mkdirSync(evidence, { recursive: true });
const python = require('../src/desktop-runtime').desktopPython(root);
const electron = require('electron');
const started = new Date().toISOString();
const sourceFiles = [];
function collect(folder, prefix) {
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    if (item.name === '__pycache__') continue;
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) collect(path.join(folder, item.name), relative);
    else if (/\.(?:js|json|py|html|css)$/.test(item.name)) sourceFiles.push(relative);
  }
}
collect(path.join(root, 'src'), 'src'); collect(path.join(root, 'foundry'), 'foundry');
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, filename))).digest('hex');
const fingerprint = () => Object.fromEntries(sourceFiles.map(filename => [filename.replaceAll('\\', '/'), hash(filename)]));
const allRuns = (() => { try { return JSON.parse(fs.readFileSync(path.join(evidence, 'summary.json'), 'utf8')).runs || []; } catch { return []; } })();
function writeSummary() { fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ started_at: started, updated_at: new Date().toISOString(), passed: allRuns.every(item => item.exit_code === 0 && !item.stale), source_scope: 'src and foundry source/config files; generated caches excluded', constraints: ['Serial processes', 'No local model or paid inference', 'Native fixtures use isolated temporary profiles and loopback providers', 'Marketplace fixtures do not prove a purchase or live public listing'], runs: allRuns }, null, 2)); }
async function run(id, executable, args, inputs, impact) {
  const folder = path.join(evidence, id); fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(path.join(folder, 'run.json'))) {
    const archive = path.join(folder, 'prior-' + new Date().toISOString().replaceAll(':', '-'));
    fs.mkdirSync(archive);
    for (const file of fs.readdirSync(folder, { withFileTypes: true })) if (file.isFile()) fs.copyFileSync(path.join(folder, file.name), path.join(archive, file.name));
  }
  const before = fingerprint();
  const entry = { id, executable, args, cwd: root, environment_overrides: { YUR_GLIDER_RC6: '1', YUR_HARNESS_AUTOSTART: '0', YUR_FACTORY_PYTHON: python, PYTHONDONTWRITEBYTECODE: '1' }, started_at: new Date().toISOString(), input_hashes: Object.fromEntries(inputs.map(file => [file, hash(file)])) };
  console.log('START ' + id);
  let stdout = '', stderr = '';
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...entry.environment_overrides, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  entry.pid = child.pid;
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  entry.exit_code = await new Promise(resolve => { const timer = setTimeout(() => { entry.runner_timeout = true; child.kill(); }, 180000); child.on('error', error => { entry.spawn_error = error.message; clearTimeout(timer); resolve(-1); }); child.on('exit', code => { clearTimeout(timer); resolve(code ?? -1); }); });
  fs.writeFileSync(path.join(folder, 'stdout.log'), stdout); fs.writeFileSync(path.join(folder, 'stderr.log'), stderr);
  entry.completed_at = new Date().toISOString();
  const after = fingerprint(); entry.changed_files = sourceFiles.map(file => file.replaceAll('\\', '/')).filter(file => before[file] !== after[file]);
  entry.impacted_changes = entry.changed_files.filter(impact); entry.stale = entry.impacted_changes.length > 0;
  fs.writeFileSync(path.join(folder, 'source-hashes.json'), JSON.stringify({ before, after, changed: entry.changed_files, impacted: entry.impacted_changes }, null, 2));
  const parsed = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  entry.structured_results = parsed;
  const tail = parsed.at(-1);
  let receiptFile = tail?.receipt;
  if (id === 'native-media-view' && tail?.profile) receiptFile = path.join(tail.profile, 'media-view-receipt.json');
  if (id === 'native-workforce' && tail?.test_home) receiptFile = path.join(tail.test_home, 'workforce-smoke-result.json');
  if (receiptFile && fs.existsSync(receiptFile)) {
    fs.copyFileSync(receiptFile, path.join(folder, 'native-receipt.json'));
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    entry.native_receipt = path.join(folder, 'native-receipt.json');
    const shots = Array.isArray(receipt.screenshots) ? receipt.screenshots : Object.values(receipt.screenshots || {});
    for (const screenshot of shots) if (typeof screenshot === 'string' && fs.existsSync(screenshot) && screenshot.endsWith('.png')) fs.copyFileSync(screenshot, path.join(folder, path.basename(screenshot)));
  }
  const totals = {};
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) { const match = stdout.match(new RegExp('^# ' + field + ' (\\d+)', 'm')); if (match) totals[field] = Number(match[1]); }
  const py = stderr.match(/Ran (\d+) tests? in ([0-9.]+)s/); if (py) { totals.tests = Number(py[1]); totals.seconds = Number(py[2]); totals.passed = /\bOK(?:\s|$)/m.test(stderr); }
  entry.totals = totals;
  fs.writeFileSync(path.join(folder, 'run.json'), JSON.stringify(entry, null, 2));
  const priorIndex = allRuns.findIndex(item => item.id === id); if (priorIndex >= 0) allRuns[priorIndex] = entry; else allRuns.push(entry); writeSummary();
  console.log('END ' + id + ' exit=' + entry.exit_code + ' stale=' + entry.stale + ' ' + JSON.stringify(totals));
}
(async () => {
  const chosen = process.argv.slice(2);
  const selected = id => !chosen.length || chosen.includes(id);
  const all = () => true;
  if (selected('native-media-view')) await run('native-media-view', electron, ['tests/media-view-smoke.cjs'], ['tests/media-view-smoke.cjs'], file => file === 'src/media-view.js');
  if (selected('native-workforce')) await run('native-workforce', electron, ['tests/desktop-regression-entry.cjs', 'workforce-smoke.cjs'], ['tests/desktop-regression-entry.cjs', 'tests/workforce-smoke.cjs', 'tests/workforce-fixture.cjs'], all);
  if (selected('native-browser')) await run('native-browser', electron, ['tests/desktop-regression-entry.cjs', 'browser-smoke.cjs'], ['tests/desktop-regression-entry.cjs', 'tests/browser-smoke.cjs'], all);
  const nodeTests = ['tests/marketplace-view.test.js', 'tests/harness-integration.test.js', 'tests/media-host.test.js', 'tests/browser-host.test.js', 'tests/browser-view.test.js'];
  if (selected('node-retained-contracts')) await run('node-retained-contracts', process.execPath, ['--test', '--test-concurrency=1', ...nodeTests], nodeTests, file => ['src/marketplace-view.js','src/marketplace-deploy.js','src/harness-sidecar.js','src/media-host.js','src/browser-host.js','src/browser-view.js'].includes(file));
  for (const suite of ['test_media_generation', 'test_workforce_bridge', 'test_workforce_catalog', 'test_workforce_quantity']) if (selected(suite)) await run(suite, python, ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', suite + '.py', '-v'], ['tests/' + suite + '.py'], file => file.startsWith('foundry/'));
  writeSummary(); process.exitCode = allRuns.every(item => item.exit_code === 0 && !item.stale) ? 0 : 1;
})().catch(error => { console.error(error.stack); writeSummary(); process.exitCode = 1; });
