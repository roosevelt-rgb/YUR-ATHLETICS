const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');
const runLabel = process.env.YUR_NATIVE_RUN_LABEL || '';
if (runLabel && !/^[a-z0-9-]+$/.test(runLabel)) throw new Error('Invalid native run label');
const evidence = path.resolve(__dirname, '../../..', 'evidence/glider-rc6/comprehensive', runLabel);
fs.mkdirSync(evidence, { recursive: true });
const selected = process.argv.slice(2);
const cases = selected.length ? selected : ['unified', 'conversation', 'work', 'browser', 'specialist-forge', 'schedules', 'sources', 'concepts', 'documents', 'artifact', 'attachment', 'project-files', 'activity', 'capability-overview', 'desktop-usability', 'desktop-parity', 'copilot', 'hermes', 'workforce', 'project-navigation', 'steering', 'browser-work', 'electron', 'voice'];
const results = [];
async function run(name) {
  const started = Date.now(), logFile = path.join(evidence, name + '-native.txt');
  const log = fs.createWriteStream(logFile);
  console.log('START native ' + name);
  const environment = { ...process.env, YUR_GLIDER_RC6: '0', YUR_HARNESS_AUTOSTART: '0' };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ['tests/desktop-regression-entry.cjs', name + '-smoke.cjs'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 330000);
  const code = await new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { log.write(error.stack); resolve(null); }); });
  clearTimeout(timer); await new Promise(resolve => log.end(resolve));
  const text = fs.readFileSync(logFile, 'utf8');
  let receipt; for (const line of text.split(/\r?\n/)) { try { const parsed = JSON.parse(line); if (typeof parsed.ok === 'boolean') receipt = parsed; else if (typeof parsed.passed === 'boolean') receipt = { ...parsed, ok: parsed.passed }; } catch {} }
  const result = { name, code, timedOut, elapsed_ms: Date.now() - started, log: logFile, receipt };
  results.push(result); fs.writeFileSync(path.join(evidence, 'native-results.json'), JSON.stringify(results, null, 2));
  console.log('DONE native ' + name + ' ' + (code === 0 && !timedOut && receipt?.ok === true ? 'PASS' : 'FAIL') + ' ' + Math.round(result.elapsed_ms / 1000) + 's');
  if (code !== 0) console.log(text.split(/\r?\n/).slice(-4).join('\n').slice(0, 1600));
}
(async () => { for (const name of cases) await run(name); console.log('Native feature runs complete: ' + results.length); process.exitCode = results.some(r => r.code !== 0 || r.timedOut || r.receipt?.ok !== true) ? 1 : 0; })().catch(error => { console.error(error.stack); process.exitCode = 1; });
