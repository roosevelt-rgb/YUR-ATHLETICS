'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { embeddedPython } = require('./embedded-runtime');

// Host configuration wins. The project environment is reproducible from the
// pinned desktop requirements and never depends on user-site Python packages.
function desktopPython(root, environment = process.env) {
  if (environment.YUR_FACTORY_PYTHON) return environment.YUR_FACTORY_PYTHON;
  const embedded = embeddedPython(root);
  if (embedded) return embedded;
  const local = path.join(root, '.desktop-python', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  return fs.existsSync(local) ? local : 'python';
}
module.exports = { desktopPython };
