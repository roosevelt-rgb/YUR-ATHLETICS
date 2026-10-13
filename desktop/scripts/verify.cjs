'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = require('../src/desktop-runtime').desktopPython(root);
const run = (executable, args, timeout = 120000) => {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', shell: false, windowsHide: true, timeout });
  if (result.error || result.status !== 0) {
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    process.exit(result.status || 1);
  }
};
for (const name of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'))) {
  run(process.execPath, ['--check', path.join('src', name)]);
}
// The expanded journal/recovery suite includes historical generated evidence.
// Its phase gets five minutes; individual production execution limits are unchanged.
run(python, ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'], 300000);
const jsTests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.js')).map(name => path.join('tests', name));
run(process.execPath, ['--test', '--test-concurrency=1', ...jsTests]);
process.stdout.write('Factory verification passed. Live Electron smoke is a separate npm run test:electron gate.\n');
