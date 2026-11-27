'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('w2mP2P', {
  onCmd: (cb) => ipcRenderer.on('p2p:cmd', (_e, cmd) => cb(cmd)),
  emit: (evt) => ipcRenderer.send('p2p:evt', evt),
});
