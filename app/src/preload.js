'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);
const EVENTS = ['status', 'entry', 'config', 'unseen', 'open-settings'];

contextBridge.exposeInMainWorld('w2m', {
  state: invoke('state'),
  sendText: invoke('send-text'),
  sendPaths: invoke('send-paths'),
  sendClipboard: invoke('send-clipboard'),
  sendBlob: invoke('send-blob'),
  pick: invoke('pick'),
  copyText: invoke('copy-text'),
  reveal: invoke('reveal'),
  openPath: invoke('open-path'),
  openDownloadDir: invoke('open-download-dir'),
  exists: invoke('exists'),
  saveConfig: invoke('save-config'),
  applyPairCode: invoke('apply-pair-code'),
  testConnection: invoke('test-connection'),
  chooseDownloadDir: invoke('choose-download-dir'),
  removeEntry: invoke('remove-entry'),
  clearHistory: invoke('clear-history'),
  cancel: invoke('cancel'),
  removeDevice: invoke('remove-device'),

  /** 拖进来的 File 对象对应的磁盘路径；不是磁盘文件（比如网页里拖出的图片）时返回空串 */
  pathFor: (f) => { try { return webUtils.getPathForFile(f) || ''; } catch { return ''; } },
  startDrag: (paths) => ipcRenderer.send('start-drag', paths),
  floatDragStart: () => ipcRenderer.send('float-drag-start'),
  floatDragEnd: () => ipcRenderer.send('float-drag-end'),
  toggleMain: () => ipcRenderer.send('toggle-main'),
  floatMenu: () => ipcRenderer.send('float-menu'),

  on: (event, cb) => {
    if (!EVENTS.includes(event)) return;
    ipcRenderer.on(event, (_e, data) => cb(data));
  },
});
