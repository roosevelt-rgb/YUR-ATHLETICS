'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', Object.freeze({
  factory: Object.freeze({
    request: request => ipcRenderer.invoke('factory:request', request),
    openEditor: () => ipcRenderer.invoke('factory:openEditor'),
    onAutomationState: callback => {
      if (typeof callback !== 'function') throw new TypeError('Automation listener must be a function.');
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('factory:automation-state', listener);
      return () => ipcRenderer.removeListener('factory:automation-state', listener);
    },
  }),
}));
