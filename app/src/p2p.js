'use strict';
// 直连引擎：一个不显示的窗口，里面用 Chromium 自带的 WebRTC 打洞并建立加密通道。
// 这里只负责窗口的生死和主进程与它之间的消息转发；连接逻辑在 direct.js，页面逻辑在 ui/p2p-page.js。

const { BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

const RELEASE_MS = 60e3; // 没有任何直连之后，过这么久再关掉窗口，省得连着传几批时反复开关

class WebRtcEngine extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.win = null;
    this._ready = null;
    this._releaseTimer = null;
    ipcMain.on('p2p:evt', (e, evt) => {
      if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents || !evt) return;
      if (evt.ev === 'ready') this._finishStartup?.();
      else this.emit('evt', evt);
    });
  }

  async ready() {
    clearTimeout(this._releaseTimer);
    if (this._ready) return this._ready;
    const win = this.win = new BrowserWindow({
      show: false, width: 200, height: 100, skipTaskbar: true, focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'p2p-preload.js'), contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, // 窗口一直不可见，不能让它被降速
      },
    });
    const ready = this._ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._down(win, new Error('直连组件启动超时')), 15e3);
      this._finishStartup = (error) => {
        clearTimeout(timer);
        this._finishStartup = null;
        if (error) reject(error); else resolve();
      };
    });
    try {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.on('render-process-gone', () => this._down(win));
      win.on('closed', () => this._down(win));
      win.loadFile(path.join(__dirname, 'ui', 'p2p.html')).catch((error) => this._down(win, error));
    } catch (error) { this._down(win, error); }
    return ready;
  }

  send(cmd) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('p2p:cmd', cmd);
  }

  /** 调用方表示暂时用不着了 */
  release() {
    clearTimeout(this._releaseTimer);
    const win = this.win;
    if (!win) return;
    this._releaseTimer = setTimeout(() => this._down(win), RELEASE_MS);
    this._releaseTimer.unref?.();
  }

  _down(win, error) {
    if (!win || win !== this.win) return;
    this._finishStartup?.(error || new Error('直连组件已退出'));
    this.win = null;
    this._ready = null;
    clearTimeout(this._releaseTimer);
    if (!win.isDestroyed()) win.destroy();
    this.emit('evt', { ev: 'down' });
  }
}

module.exports = { WebRtcEngine };
