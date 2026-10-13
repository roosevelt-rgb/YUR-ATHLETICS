'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { contextMenuTemplate, installContextMenu } = require('../src/context-menu');

const roles = value => value.filter(item => item.role).map(item => item.role);

test('context menu exposes native edit roles for an editable selection', () => {
  const menu = contextMenuTemplate({ isEditable: true, selectionText: 'selected text' });
  assert.deepEqual(roles(menu), ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
  assert.equal(menu.find(item => item.role === 'copy').enabled, true);
});

test('context menu keeps retained output selectable without granting navigation actions', () => {
  const menu = contextMenuTemplate({ isEditable: false, selectionText: '' });
  assert.deepEqual(roles(menu), ['copy', 'selectAll']);
  assert.equal(menu.find(item => item.role === 'copy').enabled, false);
  assert.equal(menu.some(item => item.role === 'openLink' || item.role === 'save'), false);
});

test('context menu installs and removes one native listener', () => {
  const contents = new EventEmitter();
  const owner = { id: 'desktop' };
  let template = null, popup = null;
  const electron = { Menu: { buildFromTemplate(value) { template = value; return { popup(value) { popup = value; value.callback?.(); }, destroy() {} }; } } };
  const remove = installContextMenu(contents, { electron, window: owner });
  assert.equal(contents.listenerCount('context-menu'), 1);
  contents.emit('context-menu', {}, { isEditable: true, selectionText: 'x', x: 12, y: 18 });
  assert.deepEqual(roles(template), ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
  assert.deepEqual(popup, { window: owner, x: 12, y: 18, callback: popup.callback });
  remove();
  assert.equal(contents.listenerCount('context-menu'), 0);
});

test('embedded test surfaces without Menu remain untouched', () => {
  const contents = new EventEmitter();
  const remove = installContextMenu(contents, { electron: {}, window: {} });
  assert.equal(contents.listenerCount('context-menu'), 0);
  remove();
});
