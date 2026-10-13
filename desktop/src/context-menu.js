'use strict';

// Electron does not provide a renderer context menu by default. Keep the
// operator menu limited to native editing roles; it must not become a second
// navigation or execution surface.
function hasSelection(params) {
  return typeof params?.selectionText === 'string' && params.selectionText.length > 0;
}

function contextMenuTemplate(params = {}) {
  const editable = params.isEditable === true;
  const selected = hasSelection(params);
  const items = [];
  if (editable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' });
  if (editable) items.push({ role: 'cut' });
  items.push({ role: 'copy', enabled: selected });
  if (editable) items.push({ role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' });
  if (items.length) items.push({ type: 'separator' });
  // Select All is useful for both editable controls and retained local output.
  items.push({ role: 'selectAll' });
  return items;
}

function installContextMenu(contents, { electron = require('electron'), window = null } = {}) {
  if (!contents || typeof contents.on !== 'function') throw new TypeError('Context menu requires Electron webContents.');
  // Small test doubles and older embedded surfaces may not expose Menu. In
  // that case native Chromium editing remains available and no listener is
  // installed instead of weakening the surface with a custom renderer menu.
  if (!electron?.Menu?.buildFromTemplate) return () => {};
  const showWindow = window || contents.getOwnerBrowserWindow?.();
  if (!showWindow) return () => {};
  const onContextMenu = (_event, params = {}) => {
    if (showWindow.isDestroyed?.()) return;
    const menu = electron.Menu.buildFromTemplate(contextMenuTemplate(params));
    menu.popup({ window: showWindow, x: params.x, y: params.y, callback: () => menu.destroy?.() });
  };
  contents.on('context-menu', onContextMenu);
  return () => contents.removeListener?.('context-menu', onContextMenu);
}

module.exports = { contextMenuTemplate, installContextMenu };
