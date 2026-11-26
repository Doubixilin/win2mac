'use strict';
// 真机冒烟测试：启动真正的 Electron 应用，对端用一个 Node Relay 模拟。
// 用法（在 app 目录下）：npx electron ../test/smoke.js <输出目录>
// 会短暂占用系统剪贴板（结束时恢复原来的条目和格式）。

const { app, clipboard, ClipboardItem, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'w2m-smoke-out'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-smoke-'));
const PORT = 18798;
const TOKEN = crypto.randomBytes(24).toString('hex');
const SERVER = `http://127.0.0.1:${PORT}`;
const dirs = { data: `${ROOT}/data`, user: `${ROOT}/user`, recv: `${ROOT}/recv`, peer: `${ROOT}/peer`, src: `${ROOT}/src` };
for (const d of [...Object.values(dirs), OUT]) fs.mkdirSync(d, { recursive: true });

const deviceId = 'smoke-' + crypto.randomUUID();
const { generateKeys } = require('../app/src/control');
const originalIdentity = generateKeys();
fs.writeFileSync(path.join(dirs.user, 'config.json'), JSON.stringify({
  server: SERVER, token: TOKEN, deviceId, keyPrivate: originalIdentity.privateKey, keyPublic: originalIdentity.publicKey, deviceName: '家里Mac', downloadDir: dirs.recv,
  notify: false, hotkey: '', openAtLogin: false, floatPos: { x: 200, y: 200 },
}));
process.env.W2M_USER_DATA = dirs.user;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// 主进程未捕获异常默认会弹阻塞式对话框，测试里改成打印并失败退出
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e.stack || e); results.push({ name: 'uncaught', ok: false, error: String(e.stack || e) }); });
setTimeout(() => { console.log('WATCHDOG: 测试超过 150 秒，强制退出'); app.exit(2); }, 150e3).unref();
async function step(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); }
  catch (e) { results.push({ name, ok: false, error: String(e.stack || e) }); console.log('FAIL', name, '\n   ', e.stack || e); }
}
async function until(fn, ms = 15e3, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await sleep(80);
  }
}

const srv = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', W2M_PORT: PORT, W2M_TOKEN: TOKEN, W2M_DATA: dirs.data }, stdio: 'inherit',
});

const { Relay } = require('../app/src/core.js');
const { ControlClient, fingerprint } = require('../app/src/control.js');
const main = require('../app/src/main.js');

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
}

async function cdpDrop(win, x, y, data) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const payload = { items: [], dragOperationsMask: 1, ...data };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data: payload });
    await sleep(60);
  }
}

app.whenReady().then(async () => {
  const savedClipboard = [];
  for (const item of await clipboard.read()) {
    if (!item.types.length) continue;
    const content = {};
    for (const type of item.types) content[type] = await item.getType(type);
    savedClipboard.push(new ClipboardItem(content));
  }
  const peerKeys = generateKeys();
  const peer = new Relay({ server: SERVER, token: TOKEN, deviceId: 'smoke-win-001', deviceName: '办公Win', downloadDir: dirs.peer, publicKey: peerKeys.publicKey });
  const ctl = new ControlClient({ server: SERVER, token: TOKEN, deviceId: 'smoke-win-001', deviceName: '办公Win', publicKey: peerKeys.publicKey, privateKey: peerKeys.privateKey, pinsFile: path.join(ROOT, 'pins.json') });
  const got = [];
  peer.on('received', (e, item) => got.push({ ...e, clip: item.clip }));
  const next = async (pred, what) => {
    const e = await until(() => got.find(pred), 20e3, what);
    got.splice(got.indexOf(e), 1);
    return e;
  };

  try {
    await until(() => main.mainWin && main.floatWin && !main.mainWin.webContents.isLoading() && !main.floatWin.webContents.isLoading(), 15e3, '窗口加载');
    const js = (win, code) => win.webContents.executeJavaScript(code, true);
    await sleep(600);

    await step('启动后主界面和悬浮窗都显示', async () => {
      assert.ok(main.mainWin.isVisible(), '主窗口应可见');
      assert.ok(main.floatWin.isVisible(), '悬浮窗应可见');
      assert.ok(main.floatWin.isAlwaysOnTop());
      await until(() => main.relay.connected, 10e3, '连接服务器');
      await shot(main.mainWin, '1-main-alone.png');
    });

    await step('桌面端迁移已有私钥，内置 MCP 运行时能从系统凭据读取同一身份', async () => {
      const filename = path.join(dirs.user, 'config.json');
      const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
      assert.equal(saved.keyPrivate, undefined);
      assert.equal(saved.keyPublic, originalIdentity.publicKey);
      const checkKey = [
        "const cfg = require(process.argv[1]);",
        "const key = require(process.argv[2]).readSigningKey(cfg);",
        "const ctl = require(process.argv[3]);",
        "if (!ctl.verifyText('migration', ctl.signText('migration', key), cfg.keyPublic)) process.exit(1);",
      ].join('\n');
      execFileSync(process.execPath, ['-e', checkKey, filename, require.resolve('../app/src/identity'), require.resolve('../app/src/control')],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 });
    });

    await step('对端上线后界面显示在线', async () => {
      peer.start();
      await until(() => js(main.mainWin, `document.getElementById('peerName').textContent === '办公Win' && document.getElementById('dot').classList.contains('online')`), 10e3, '在线状态');
      assert.ok(await js(main.floatWin, `document.getElementById('dot').classList.contains('online')`));
    });

    await step('输入框打字回车 → 对端收到文字', async () => {
      await js(main.mainWin, `(() => { const t = document.getElementById('text'); t.value = '界面输入的文字\\n第二行'; t.dispatchEvent(new Event('input')); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      const e = await next((x) => x.kind === 'text', '文字');
      assert.equal(e.text, '界面输入的文字\n第二行');
      assert.equal(e.peer, '家里Mac');
      assert.equal(await js(main.mainWin, `document.getElementById('text').value`), '');
    });

    const f1 = path.join(dirs.src, '报告.docx'), f2 = path.join(dirs.src, 'photo.jpg');
    fs.writeFileSync(f1, crypto.randomBytes(300 * 1024));
    fs.writeFileSync(f2, crypto.randomBytes(1200 * 1024));
    await step('把两个文件拖进主界面 → 对端收到（真实拖放事件）', async () => {
      await cdpDrop(main.mainWin, 200, 150, { files: [f1, f2] });
      const e = await next((x) => x.kind === 'files', '文件');
      assert.equal(e.paths.length, 2);
      assert.ok(fs.readFileSync(path.join(dirs.peer, '报告.docx')).equals(fs.readFileSync(f1)));
      assert.ok(fs.readFileSync(path.join(dirs.peer, 'photo.jpg')).equals(fs.readFileSync(f2)));
    });

    await step('把文件夹拖到悬浮窗 → 对端收到整个目录', async () => {
      const folder = path.join(dirs.src, '合同资料');
      fs.mkdirSync(path.join(folder, '附件'), { recursive: true });
      fs.writeFileSync(path.join(folder, '说明.txt'), '说明');
      fs.writeFileSync(path.join(folder, '附件/a.pdf'), crypto.randomBytes(5000));
      await cdpDrop(main.floatWin, 38, 38, { files: [folder] });
      const e = await next((x) => x.kind === 'files', '文件夹');
      assert.equal(path.basename(e.paths[0]), '合同资料');
      assert.equal(fs.readFileSync(path.join(dirs.peer, '合同资料/说明.txt'), 'utf8'), '说明');
      assert.equal(fs.statSync(path.join(dirs.peer, '合同资料/附件/a.pdf')).size, 5000);
    });

    await step('把选中的文字拖到悬浮窗 → 对端收到文字', async () => {
      await cdpDrop(main.floatWin, 38, 38, { items: [{ mimeType: 'text/plain', data: '拖过来的一段文字' }] });
      assert.equal((await next((x) => x.kind === 'text', '拖放文字')).text, '拖过来的一段文字');
    });

    await step('快捷键路径：剪贴板里是文字', async () => {
      await clipboard.writeText('剪贴板文字 123');
      assert.equal(await main.sendClipboard(), true);
      assert.equal((await next((x) => x.kind === 'text', '剪贴板文字')).text, '剪贴板文字 123');
    });

    await step('快捷键路径：剪贴板里是访达复制的文件', async () => {
      if (process.platform !== 'darwin') return;
      execFileSync('osascript', ['-e', `set the clipboard to (POSIX file "${f1}")`]);
      await sleep(300);
      assert.deepEqual((await main.readClipboard()).files, [f1]);
      assert.equal(await main.sendClipboard(), true);
      const e = await next((x) => x.kind === 'files', '剪贴板文件');
      assert.equal(path.basename(e.paths[0]), '报告 (2).docx'); // 对端已有同名文件，自动改名
    });

    await step('快捷键路径：剪贴板里是截图 → 对端收到 png 且带剪贴板标记', async () => {
      await main.writeClipboardImage(fs.readFileSync(path.join(__dirname, '../app/assets/icon.png')));
      await sleep(200);
      assert.equal(await main.sendClipboard(), true);
      const e = await next((x) => x.kind === 'files', '截图');
      assert.match(path.basename(e.paths[0]), /^截图-\d{8}-\d{6}\.png$/);
      assert.equal(e.clip, true);
      assert.ok(!nativeImage.createFromPath(e.paths[0]).isEmpty());
    });

    await step('对端发来文字 → 自动进剪贴板，出现在记录里', async () => {
      clipboard.clear();
      peer.sendText('从 Windows 发来的内容');
      await until(async () => (await clipboard.readText()) === '从 Windows 发来的内容', 10e3, '剪贴板更新');
      await until(() => js(main.mainWin, `[...document.querySelectorAll('.item.in .title')].some(n => n.textContent === '从 Windows 发来的内容')`), 5e3, '记录显示');
    });

    await step('对端从剪贴板发来截图 → 本机剪贴板里直接有这张图', async () => {
      clipboard.clear();
      const png = path.join(dirs.src, '截图-20261126-101500.png');
      fs.copyFileSync(path.join(__dirname, '../app/assets/drag.png'), png);
      peer.sendPaths([png], { clip: true });
      await until(async () => (await main.readClipboard()).image, 10e3, '剪贴板图片');
      assert.ok(fs.existsSync(path.join(dirs.recv, '截图-20261126-101500.png')));
    });

    await step('对端发来文件夹和大文件 → 落到接收目录，记录可操作', async () => {
      const big = path.join(dirs.src, '安装包.zip');
      fs.writeFileSync(big, crypto.randomBytes(30 * 2 ** 20));
      peer.sendPaths([big, path.join(dirs.src, '合同资料')]);
      await until(() => main.history.find((h) => h.dir === 'in' && h.kind === 'files' && h.state === 'done' && h.name.startsWith('安装包.zip')), 30e3, '接收完成');
      assert.ok(fs.readFileSync(path.join(dirs.recv, '安装包.zip')).equals(fs.readFileSync(big)));
      assert.equal(fs.readFileSync(path.join(dirs.recv, '合同资料/说明.txt'), 'utf8'), '说明');
      const li = await js(main.mainWin, `(() => { const li = [...document.querySelectorAll('.item.in')].find(n => n.querySelector('.title').textContent.startsWith('安装包.zip')); return { draggable: li.draggable, acts: [...li.querySelectorAll('.acts button')].map(b => b.textContent) }; })()`);
      assert.equal(li.draggable, true);
      assert.deepEqual(li.acts, ['在文件夹中显示', '删除记录']);
    });

    await step('发出的记录在对端收完后变成“已送达”', async () => {
      await until(() => js(main.mainWin, `[...document.querySelectorAll('.item.out .meta .ok')].length >= 6`), 8e3, '已送达标记');
    });

    await step('悬浮窗有未读角标，打开主界面后清零', async () => {
      await js(main.mainWin, 'window.blur()');
      main.mainWin.hide();
      peer.sendText('窗口隐藏时收到的');
      await until(() => js(main.floatWin, `document.getElementById('badge').classList.contains('show')`), 8e3, '角标');
      await sleep(400);
      await shot(main.floatWin, '3-float-badge.png');
      main.showMain();
      await until(() => js(main.floatWin, `!document.getElementById('badge').classList.contains('show')`), 5e3, '角标清零');
    });

    await step('截图：主界面、设置页', async () => {
      await sleep(500);
      await shot(main.mainWin, '2-main-history.png');
      await js(main.mainWin, `document.getElementById('btnSettings').click()`);
      await sleep(400);
      assert.equal(await js(main.mainWin, `document.getElementById('server').value`), SERVER);
      await shot(main.mainWin, '4-settings.png');
      await js(main.mainWin, `document.getElementById('cancelSettings').click()`);
    });

    await step('远程控制：设置里授权只读 → 对端能读不能执行；悬浮球有提示', async () => {
      ctl.start();
      await ctl.ready();
      await assert.rejects(ctl.call('家里Mac', 'sys.info'), (e) => e.code === 'forbidden');
      await js(main.mainWin, `document.getElementById('btnSettings').click()`);
      await until(() => js(main.mainWin, `document.querySelectorAll('#controlList select').length === 1`), 5e3, '授权列表');
      const shown = await js(main.mainWin, `({ mine: document.getElementById('myFp').textContent, peer: document.querySelector('#controlList .sub').textContent })`);
      assert.equal(shown.mine, fingerprint(main.config.keyPublic));
      assert.equal(shown.peer, '指纹 ' + fingerprint(peerKeys.publicKey));
      await js(main.mainWin, `(() => { const s = document.querySelector('#controlList select'); s.value = 'read'; s.dispatchEvent(new Event('change')); })()`);
      await until(() => main.config.controllers['smoke-win-001']?.level === 'read', 5e3, '授权生效');
      const info = await ctl.call('家里Mac', 'sys.info');
      assert.equal(info.home, os.homedir());
      const settings = path.join(dirs.user, 'config.json');
      await assert.rejects(ctl.call('家里Mac', 'fs.read', { path: settings }), { code: 'protected-file' });
      const target = path.join(dirs.peer, 'forbidden-copy');
      await assert.rejects(ctl.pullFile('家里Mac', settings, target), { code: 'protected-file' });
      assert.ok(!fs.existsSync(target));
      await clipboard.writeText('被控端剪贴板内容');
      assert.equal((await ctl.call('家里Mac', 'clipboard.read')).text, '被控端剪贴板内容');
      await assert.rejects(ctl.call('家里Mac', 'exec', { command: 'echo no' }), (e) => e.code === 'read-only');
      assert.ok(await js(main.floatWin, `document.getElementById('ball').classList.contains('remote')`), '悬浮球应提示正在被远程操作');
      await until(() => js(main.mainWin, `document.getElementById('controlRecent').textContent.includes('sys.info')`), 5e3, '设置里显示最近操作');
      await js(main.mainWin, `document.getElementById('myFp').scrollIntoView({ block: 'center' })`);
      await sleep(300);
      await shot(main.mainWin, '6-settings-control.png');
      await js(main.mainWin, `document.getElementById('cancelSettings').click()`);
    });

    await step('远程控制：完全控制 → 执行命令、写剪贴板、打开文件；私钥不进渲染进程；操作有日志', async () => {
      assert.deepEqual(main.setController('smoke-win-001', 'full'), { ok: true });
      const r = await ctl.call('家里Mac', 'exec', { command: 'echo 远程执行成功 && whoami' });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes('远程执行成功') && r.stdout.includes(os.userInfo().username));
      await ctl.call('家里Mac', 'clipboard.write', { text: '控制端写入的文字' });
      assert.equal(await clipboard.readText(), '控制端写入的文字');
      await assert.rejects(ctl.call('家里Mac', 'open', { target: path.join(ROOT, 'no-such-file') }), /路径不存在/);
      const st = await js(main.mainWin, `w2m.state().then(s => ({ hasPriv: 'keyPrivate' in s.config, fp: s.config.fingerprint }))`);
      assert.equal(st.hasPriv, false);
      const log = fs.readFileSync(path.join(dirs.user, 'control.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(log.some((a) => a.method === 'exec' && a.ok && a.fromName === '办公Win'));
      assert.ok(log.some((a) => a.method === 'exec' && !a.ok));
      assert.deepEqual(main.setController('smoke-win-001', 'none'), { ok: true });
      await assert.rejects(ctl.call('家里Mac', 'sys.info'), (e) => e.code === 'forbidden');
    });

    await step('MCP 配置里的程序和脚本路径都存在', async () => {
      const { json, toml } = main.mcpConfig();
      const entry = JSON.parse(json).mcpServers.win2mac;
      assert.ok(fs.existsSync(entry.command) && fs.existsSync(entry.args[0]));
      assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1');
      assert.ok(toml.includes('[mcp_servers.win2mac]'));
    });

    await step('配对码可以还原出服务器和口令；悬浮窗位置可保存', async () => {
      const code = await js(main.mainWin, `w2m.state().then(s => s.config.pairCode)`);
      assert.match(code, /^w2m:/);
      const decoded = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString());
      assert.deepEqual(decoded, { s: SERVER, t: TOKEN });
      assert.deepEqual(main.floatWin.getBounds(), { x: 200, y: 200, width: 76, height: 76 });
    });

    await step('从设置页切换配对会中断旧队列，重新配对后可正常发送', async () => {
      const old = main.relay;
      let release;
      old._outQ = new Promise((resolve) => { release = resolve; });
      const queued = old.sendText('旧配对的排队文本');
      try {
        await js(main.mainWin, `w2m.saveConfig({ token: 'temporary-pair-for-test' })`);
        assert.notEqual(main.relay, old);
      } finally {
        release();
        main.applyConfig({ token: TOKEN });
      }
      await old._outQ;
      assert.equal(queued.state, 'error');
      await until(() => main.relay.connected, 5e3, '恢复配对');
      main.relay.sendText('新配对的文本');
      await next((e) => e.text === '新配对的文本', '新配对发送');
      assert.ok(!got.some((e) => e.text === '旧配对的排队文本'));
    });

    await step('服务器断开后界面提示未连接，恢复后自动重连', async () => {
      srv.kill();
      await until(() => js(main.mainWin, `document.getElementById('peerName').textContent === '未连接服务器'`), 10e3, '未连接提示');
      await shot(main.mainWin, '5-main-offline.png');
    });
  } catch (e) {
    results.push({ name: '测试框架', ok: false, error: String(e.stack || e) });
    console.log('FATAL', e);
  } finally {
    if (savedClipboard.length) await clipboard.write(savedClipboard);
    else clipboard.clear();
    const { Entry } = require('../app/node_modules/@napi-rs/keyring');
    new Entry('com.doubilin.win2mac.signing', deviceId).deleteCredential();
    peer.stop();
    ctl.stop();
    srv.kill();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} 通过，截图在 ${OUT}`);
    fs.rmSync(ROOT, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
