'use strict';
// Window lifetime only. The existing mission, schedule and commit owners remain
// alive with their original webContents; no second assistant process is created.
// name: the product the tray names (a product edition passes its own; the Desktop says IntelliFlow).
function createBackgroundLifetime({ getWindow, isEnabled, createTray, createMenu, quit, onError = () => {}, name = 'IntelliFlow' }) {
  let tray = null, quitting = false;
  function show() {
    const window = getWindow();
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized?.()) window.restore();
    window.show(); window.focus(); return true;
  }
  function dispose() { if (tray) { tray.destroy(); tray = null; } }
  function beginQuit() { quitting = true; dispose(); }
  function sync() {
    if (quitting) return;
    if (!isEnabled()) { show(); dispose(); return; }
    if (tray) return;
    try {
      tray = createTray();
      tray.setToolTip(`${name} · Franklin is available`);
      tray.setContextMenu(createMenu([
        { label: `Open ${name}`, click: show },
        { type: 'separator' },
        { label: `Quit ${name} and stop background work`, click: () => { beginQuit(); quit(); } },
      ]));
      tray.on('double-click', show);
    } catch (error) { dispose(); onError(error); }
  }
  function close(event) {
    if (quitting || !isEnabled()) return false;
    sync();
    // Never leave an invisible application without a way to reopen it.
    const window = getWindow();
    if (!tray || !window || window.isDestroyed()) return false;
    event.preventDefault(); window.hide(); return true;
  }
  return { close, show, sync, beginQuit, dispose, status: () => ({ enabled: Boolean(isEnabled()), available: Boolean(tray), quitting }) };
}
function trayBitmap(nativeImage) {
  const bytes = Buffer.alloc(32 * 32 * 4);
  const glyph = ['11111', '10000', '10000', '11110', '10000', '10000', '10000'];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    if ((x - 15.5) ** 2 + (y - 15.5) ** 2 > 15.5 ** 2) continue;
    const row = Math.floor((y - 5) / 3), col = Math.floor((x - 9) / 3);
    const silver = row >= 0 && row < 7 && col >= 0 && col < 5 && glyph[row][col] === '1';
    const i = (y * 32 + x) * 4;
    // Electron's native bitmap on Windows is BGRA.
    bytes[i] = silver ? 231 : 85; bytes[i + 1] = silver ? 223 : 62;
    bytes[i + 2] = silver ? 213 : 39; bytes[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(bytes, { width: 32, height: 32, scaleFactor: 1 });
}
module.exports = { createBackgroundLifetime, trayBitmap };
