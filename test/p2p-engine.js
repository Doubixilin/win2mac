'use strict';
// 用可控窗口和定时器验证隐藏窗口的生命周期，无需启动 Electron。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const ipcMain = new EventEmitter();
  const timers = new Set();
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.destroyed = false;
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadFile() { return new Promise((_, reject) => { this.failLoad = reject; }); }
  }
  const file = require.resolve('../app/src/p2p');
  const context = {
    module: { exports: {} }, __dirname: path.dirname(file),
    require: (id) => id === 'electron' ? { BrowserWindow: Window, ipcMain } : require(id),
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { engine: new context.module.exports.WebRtcEngine(), ipcMain, timers };
}

test('启动期间渲染进程退出立即拒绝等待者，旧窗口回调不影响重建的窗口', async () => {
  const { engine, ipcMain, timers } = fixture();
  let down = 0;
  engine.on('evt', (evt) => { if (evt.ev === 'down') down++; });
  const startup = engine.ready();
  const first = engine.win;
  const [oldTimer] = timers;
  const failed = assert.rejects(startup, /退出/);
  first.webContents.emit('render-process-gone');
  await failed;
  assert.equal(timers.has(oldTimer), false);
  assert.equal(down, 1);

  const next = engine.ready();
  const second = engine.win;
  ipcMain.emit('p2p:evt', { sender: second.webContents }, { ev: 'ready' });
  await next;
  first.failLoad(new Error('旧窗口页面加载失败'));
  oldTimer.fn();
  first.emit('closed');
  await new Promise(setImmediate);
  assert.equal(engine.win, second);
  assert.equal(second.isDestroyed(), false);
  assert.equal(down, 1);

  engine.release();
  await engine.ready();
  assert.equal(timers.size, 0, '再度使用的窗口应撤销闲置回收');
});

test('当前窗口启动超时后只销毁一次，随后可重新启动', async () => {
  const { engine, ipcMain, timers } = fixture();
  const startup = engine.ready();
  const failed = assert.rejects(startup, /启动超时/);
  const first = engine.win;
  const [timer] = timers;
  timer.fn();
  await failed;
  assert.equal(engine.win, null);
  assert.ok(first.isDestroyed());
  assert.equal(timers.size, 0);

  const next = engine.ready();
  ipcMain.emit('p2p:evt', { sender: engine.win.webContents }, { ev: 'ready' });
  await next;
  assert.ok(!engine.win.isDestroyed());
});
