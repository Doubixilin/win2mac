'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, clipboard, nativeImage,
  globalShortcut, Notification, shell, screen, ClipboardItem, desktopCapturer, systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const { Relay } = require('./core');
const { ControlHost, fingerprint } = require('./control');
const { prepareIdentity } = require('./identity');
const { DirectHub } = require('./direct');
const { WebRtcEngine } = require('./p2p');

// AI 客户端正常是用 ELECTRON_RUN_AS_NODE=1 直接跑 mcp.js 的。万一某个客户端不传环境变量，
// 程序会被当成普通应用启动并带着 mcp.js 这个参数——这时不开窗口、不抢单实例锁，就在主进程里提供 MCP 服务。
const mcpMode = process.argv.slice(1).some((a) => a === '--mcp' || /[\\/]mcp\.js$/.test(a));

// 测试时用独立的数据目录，这样可以同时开多个实例
if (process.env.W2M_USER_DATA) app.setPath('userData', process.env.W2M_USER_DATA);

// 直连要让对方看到本机在局域网里的真实地址，同一个网络下才能走内网；默认会被换成 .local 名字
if (!mcpMode) app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const isMac = process.platform === 'darwin';
const ASSETS = path.join(__dirname, '..', 'assets');
const FLOAT_SIZE = 76;
const HISTORY_MAX = 300;

let config = null;
let signingKey = null;
let identityError = '';
let history = [];
let relay = null;
let mainWin = null;
let floatWin = null;
let tray = null;
let quitting = false;
let unseen = 0;
let p2pEngine = null;

// ---------- 配置与历史 ----------

const file = (name) => path.join(app.getPath('userData'), name);

function defaults() {
  return {
    server: '', token: '',
    deviceId: 'd' + crypto.randomBytes(8).toString('hex'),
    deviceName: os.hostname().replace(/\.(local|lan)$/i, ''),
    downloadDir: path.join(app.getPath('downloads'), 'Win2Mac'),
    hotkey: 'Ctrl+Alt+S',
    autoCopy: true, notify: true, showFloat: true, openAtLogin: true,
    // 两台电脑都在线时文件优先直连（不经中转服务器）；stun 留空用内置的公共服务器，可填 ["主机:端口", ...]
    direct: true, stun: [],
    floatPos: null,
    // 远程控制：本机授权了哪些设备（按设备编号），每项 { name, key, level: 'read' | 'full' }
    controllers: {},
  };
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
}

function loadConfig() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file('config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; saved = {}; }
  config = { ...defaults(), ...saved };
  if (!config.controllers || typeof config.controllers !== 'object') config.controllers = {};
  try {
    const identity = prepareIdentity(config);
    if (!saved.deviceId || saved.keyPrivate || saved.keyPublic !== identity.settings.keyPublic) {
      writeJson(file('config.json'), identity.settings);
    }
    config = identity.settings;
    signingKey = identity.privateKey;
  } catch (e) {
    // 钥匙串锁定时保留可重试的旧配置，普通收发仍可用。
    identityError = '远程控制暂不可用。请检查系统凭据后重启 Win2Mac。' + e.message;
    if (!saved.deviceId) saveConfig();
  }
}
function saveConfig() { writeJson(file('config.json'), config); }

let historyTimer = null;
function saveHistorySoon() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => writeJson(file('history.json'), history), 500);
}
function loadHistory() {
  history = readJson(file('history.json'), []);
  // 上次退出时还没传完的，标记为中断
  for (const e of history) if (e.state === 'active') { e.state = 'error'; e.error = '传输中断'; }
}

const clean = (entry) => { const { _t, ...rest } = entry; return rest; };

function upsertEntry(entry) {
  const e = clean(entry);
  const i = history.findIndex((h) => h.id === e.id);
  if (i >= 0) history[i] = { ...history[i], ...e };
  else { history.unshift(e); if (history.length > HISTORY_MAX) history.length = HISTORY_MAX; }
  saveHistorySoon();
  broadcast('entry', i >= 0 ? history[i] : e);
}

function pairCode() {
  if (!config.server || !config.token) return '';
  return 'w2m:' + Buffer.from(JSON.stringify({ s: config.server, t: config.token })).toString('base64url');
}
function parsePairCode(code) {
  const m = /^\s*w2m:([A-Za-z0-9_-]+)\s*$/.exec(code || '');
  if (!m) return null;
  try {
    const o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return o.s && o.t ? { server: String(o.s), token: String(o.t) } : null;
  } catch { return null; }
}

// ---------- 窗口 ----------

function broadcast(channel, data) {
  for (const w of [mainWin, floatWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

function webPrefs() {
  return { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false };
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 440, height: 700, minWidth: 380, minHeight: 480, show: false,
    title: 'Win2Mac', icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#f5f6f8', autoHideMenuBar: true, webPreferences: webPrefs(),
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'main.html'));
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide();
    if (isMac) app.dock?.hide();
  });
  mainWin.on('blur', () => { mainBlurredAt = Date.now(); });
  // 窗口自身不跳转、不开新窗口
  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMain();
  if (isMac) app.dock?.show();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  unseen = 0;
  broadcast('unseen', unseen);
}

// 点悬浮球时焦点会先被悬浮球抢走，所以“刚刚还在前台”也算在前台，这样单击才能真正收起主界面
let mainBlurredAt = 0;
function toggleMain() {
  const front = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && (mainWin.isFocused() || Date.now() - mainBlurredAt < 700);
  if (front) mainWin.close();
  else showMain();
}

function floatBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  let { x, y } = config.floatPos || { x: area.x + area.width - FLOAT_SIZE - 28, y: area.y + area.height - FLOAT_SIZE - 120 };
  // 显示器布局变了的话，把悬浮窗拉回可见区域
  const d = screen.getDisplayNearestPoint({ x: x + FLOAT_SIZE / 2, y: y + FLOAT_SIZE / 2 }).workArea;
  x = Math.min(Math.max(x, d.x), d.x + d.width - FLOAT_SIZE);
  y = Math.min(Math.max(y, d.y), d.y + d.height - FLOAT_SIZE);
  return { x: Math.round(x), y: Math.round(y), width: FLOAT_SIZE, height: FLOAT_SIZE };
}

function createFloat() {
  floatWin = new BrowserWindow({
    ...floatBounds(),
    frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
    backgroundColor: '#00000000', webPreferences: webPrefs(),
  });
  floatWin.setAlwaysOnTop(true, 'floating');
  if (isMac) floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  floatWin.loadFile(path.join(__dirname, 'ui', 'float.html'));
  floatWin.once('ready-to-show', () => { if (config.showFloat) floatWin.showInactive(); });
  floatWin.on('close', (e) => { if (!quitting) { e.preventDefault(); floatWin.hide(); } });
}

function setFloatVisible(v) {
  config.showFloat = v;
  saveConfig();
  if (!floatWin || floatWin.isDestroyed()) createFloat();
  else if (v) { floatWin.setBounds(floatBounds()); floatWin.showInactive(); } else floatWin.hide();
  refreshTray();
  broadcast('config', publicConfig());
}

// 悬浮窗拖动：无边框透明窗口用 CSS 拖动区会吞掉拖放事件，所以自己跟随鼠标移动
let dragTimer = null;
function floatDragStart() {
  if (!floatWin) return;
  const cur = screen.getCursorScreenPoint();
  const [wx, wy] = floatWin.getPosition();
  const off = { x: cur.x - wx, y: cur.y - wy };
  const started = Date.now();
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!floatWin || floatWin.isDestroyed() || Date.now() - started > 60e3) return floatDragEnd();
    const p = screen.getCursorScreenPoint();
    floatWin.setBounds({ x: p.x - off.x, y: p.y - off.y, width: FLOAT_SIZE, height: FLOAT_SIZE });
  }, 12);
}
function floatDragEnd() {
  clearInterval(dragTimer);
  dragTimer = null;
  if (!floatWin || floatWin.isDestroyed()) return;
  const [x, y] = floatWin.getPosition();
  config.floatPos = { x, y };
  saveConfig();
}

// ---------- 托盘与菜单 ----------

function menuTemplate() {
  const st = relay.status();
  const peer = st.peers.find((p) => p.online);
  const line = !st.configured ? '尚未配置' : !st.connected ? `未连接${st.error ? '：' + st.error : ''}` : peer ? `${peer.name} 在线` : '对方不在线（发送后会暂存）';
  return [
    { label: line, enabled: false },
    { type: 'separator' },
    { label: '打开主界面', click: showMain },
    { label: '发送剪贴板', accelerator: activeHotkey || undefined, click: () => sendClipboard() },
    { label: '打开接收文件夹', click: openDownloadDir },
    { type: 'separator' },
    { label: '显示悬浮窗', type: 'checkbox', checked: config.showFloat, click: (i) => setFloatVisible(i.checked) },
    { label: '开机自动启动', type: 'checkbox', checked: config.openAtLogin, click: (i) => applyConfig({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: '退出 Win2Mac', click: () => { quitting = true; app.quit(); } },
  ];
}

function refreshTray() {
  if (!tray) return;
  const st = relay.status();
  tray.setToolTip(st.connected ? 'Win2Mac：已连接' : 'Win2Mac：未连接');
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) img.setTemplateImage(true);
  tray = new Tray(img);
  if (!isMac) tray.on('click', showMain);
  refreshTray();
}

// ---------- 发送 ----------

function needConfig() {
  if (relay.configured) return false;
  showMain();
  broadcast('open-settings', '先填好服务器地址和口令才能发送');
  return true;
}

function sendText(text) {
  if (needConfig() || typeof text !== 'string' || !text.trim()) return false;
  relay.sendText(text);
  return true;
}

function sendPaths(paths, opts) {
  if (needConfig()) return false;
  const ok = (paths || []).filter((p) => typeof p === 'string' && p && fs.existsSync(p));
  if (!ok.length) return false;
  relay.sendPaths(ok, opts);
  return true;
}

function runPs(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (err, out) => resolve(err ? '' : out));
  });
}

const rawFormat = (f) => `electron application/osclipboard;format="${f}"`;

async function blobBuffer(item, type) {
  const blob = await item.getType(type);
  return Buffer.from(await blob.arrayBuffer());
}

/**
 * 读一次剪贴板，按“文件 > 文字 > 图片”的优先级归类。
 * 访达/资源管理器里复制文件时，剪贴板同时还带着文件名文字和图标图片，所以文件必须最先判断；
 * 从 Excel 之类复制时同时有文字和渲染图，所以文字排在图片前面。
 */
async function readClipboard() {
  const items = await clipboard.read().catch(() => []);
  const files = [];
  let image = null;
  for (const it of items) {
    try {
      if (it.types.includes('text/uri-list')) {
        const list = (await blobBuffer(it, 'text/uri-list')).toString('utf8');
        for (const line of list.split(/\r?\n/)) {
          if (!line.startsWith('file://')) continue;
          try { files.push(fileURLToPath(line.trim())); } catch {}
        }
      } else if (isMac && it.types.includes(rawFormat('NSFilenamesPboardType'))) {
        const plist = (await blobBuffer(it, rawFormat('NSFilenamesPboardType'))).toString('utf8');
        for (const m of plist.matchAll(/<string>([^<]*)<\/string>/g)) {
          files.push(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
        }
      }
      if (!image && it.types.includes('image/png')) image = await blobBuffer(it, 'image/png');
    } catch (e) { console.error('读取剪贴板条目失败', e); }
  }
  const text = await clipboard.readText().catch(() => '');
  let existing = [...new Set(files)].filter((p) => fs.existsSync(p));
  // Windows 兜底：什么都没读到时，再问一次 PowerShell 有没有复制的文件
  if (!existing.length && !text.trim() && !image && process.platform === 'win32') {
    const out = await runPs('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }');
    existing = out.split(/\r?\n/).map((x) => x.trim()).filter((p) => p && fs.existsSync(p));
  }
  return { files: existing, text, image };
}

function writeClipboardImage(pngBuffer) {
  return clipboard.write([new ClipboardItem({ 'image/png': new Blob([pngBuffer], { type: 'image/png' }) })]);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function sendClipboard() {
  if (needConfig()) return false;
  const { files, text, image } = await readClipboard();
  if (files.length) return sendPaths(files);
  if (text.trim()) return sendText(text);
  if (image) {
    const dir = path.join(app.getPath('temp'), 'win2mac-out');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `截图-${stamp()}.png`);
    fs.writeFileSync(p, image);
    return sendPaths([p], { clip: true });
  }
  notify('剪贴板是空的', '先复制文字、图片或文件，再按快捷键发送');
  return false;
}

async function pick(kind) {
  const props = kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
  const r = await dialog.showOpenDialog(mainWin, {
    title: kind === 'folder' ? '选择要发送的文件夹' : '选择要发送的文件', buttonLabel: '发送', properties: props,
  });
  if (r.canceled || !r.filePaths.length) return false;
  return sendPaths(r.filePaths);
}

// ---------- 接收 ----------

function notify(title, body, onClick) {
  if (!config.notify || !Notification.isSupported()) return;
  const n = new Notification({ title, body: body || '', silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

function onReceived(entry, item) {
  if (!mainWin?.isVisible() || !mainWin.isFocused()) { unseen++; broadcast('unseen', unseen); }
  if (entry.kind === 'text') {
    if (config.autoCopy) clipboard.writeText(entry.text).catch((e) => console.error('写剪贴板失败', e));
    const preview = entry.text.replace(/\s+/g, ' ').slice(0, 120);
    notify(config.autoCopy ? `${entry.peer} 发来文字（已复制）` : `${entry.peer} 发来文字`, preview, showMain);
    return;
  }
  const first = entry.paths[0];
  // 对方是从剪贴板发来的截图：除了存文件，也直接放进本机剪贴板，方便马上粘贴
  if (item.clip && config.autoCopy && entry.paths.length === 1 && /\.png$/i.test(first)) {
    fs.promises.readFile(first).then(writeClipboardImage).catch((e) => console.error('写剪贴板失败', e));
  }
  notify(`${entry.peer} 发来${entry.fileCount > 1 ? ` ${entry.fileCount} 个文件` : '文件'}`, entry.name, () => shell.showItemInFolder(first));
}

function openDownloadDir() {
  fs.mkdirSync(config.downloadDir, { recursive: true });
  shell.openPath(config.downloadDir);
}

// ---------- 配置生效 ----------

let activeHotkey = '';
function registerHotkey() {
  globalShortcut.unregisterAll();
  activeHotkey = '';
  if (!config.hotkey) return true;
  try {
    if (globalShortcut.register(config.hotkey, () => sendClipboard())) { activeHotkey = config.hotkey; return true; }
  } catch {}
  return false;
}

function publicConfig() {
  const { keyPrivate, ...rest } = config; // 私钥不出主进程
  return { ...rest, pairCode: pairCode(), hotkeyActive: !!activeHotkey || !config.hotkey, fingerprint: fingerprint(config.keyPublic) };
}

const relayOpts = () => ({
  server: config.server, token: config.token, deviceId: config.deviceId, deviceName: config.deviceName,
  downloadDir: config.downloadDir, publicKey: signingKey ? config.keyPublic : '',
  receiptFile: file('batch-receipts-' + crypto.createHash('sha256')
    .update(JSON.stringify([config.server, config.token, config.deviceId])).digest('hex') + '.json'),
});

function applyLoginItem() {
  if (!app.isPackaged) return; // 开发模式下注册的是 electron 本体，没有意义
  app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin, args: ['--hidden'] });
}

function applyConfig(patch) {
  const before = { ...config };
  const allowed = ['server', 'token', 'deviceName', 'downloadDir', 'hotkey', 'autoCopy', 'notify', 'showFloat', 'openAtLogin', 'direct'];
  for (const k of allowed) if (k in patch) config[k] = patch[k];
  config.server = String(config.server || '').trim().replace(/\/+$/, '');
  config.token = String(config.token || '').trim();
  config.deviceName = String(config.deviceName || '').trim() || defaults().deviceName;
  saveConfig();

  let hotkeyOk = true;
  if (config.hotkey !== before.hotkey) hotkeyOk = registerHotkey();
  if (config.openAtLogin !== before.openAtLogin) applyLoginItem();
  if (config.showFloat !== before.showFloat) setFloatVisible(config.showFloat);
  if (before.direct !== false && config.direct === false) relay.direct?.shutdown();
  if (config.server !== before.server || config.token !== before.token) {
    relay.retire();
    setupRelay();
  } else if (config.deviceName !== before.deviceName || config.downloadDir !== before.downloadDir) {
    relay.updatePreferences(config);
    if (config.deviceName !== before.deviceName) relay.start();
  }
  refreshTray();
  broadcast('config', publicConfig());
  return { ok: true, hotkeyOk };
}

// ---------- 远程控制 ----------

const controlExtras = {
  async clipboardRead() {
    const c = await readClipboard();
    return { text: c.text, files: c.files, hasImage: !!c.image };
  },
  async clipboardWrite({ text }) {
    if (typeof text !== 'string') throw new Error('缺少文字');
    await clipboard.writeText(text);
    return { ok: true };
  },
  async screenshot({ display = 0 }) {
    const displays = screen.getAllDisplays();
    const index = Math.min(Math.max(Number(display) || 0, 0), displays.length - 1);
    const d = displays[index];
    const scale = Math.min(1, 1600 / d.size.width); // 缩到 1600 宽以内，够看清又不至于太大
    const thumbnailSize = { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) };
    // 没有权限时也照常请求一次：这样 macOS 才会弹出授权询问，并把 Win2Mac 列进“录屏”权限列表
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize }).catch(() => []);
    if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      throw new Error('这台 Mac 还没有给 Win2Mac“录屏”权限，已向系统发起授权请求。请在这台 Mac 的 系统设置 → 隐私与安全性 → 录屏与系统录音 里打开 Win2Mac，然后重启 Win2Mac 再试。');
    }
    const src = sources.find((x) => String(x.display_id) === String(d.id)) || sources[index] || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('截图失败');
    const size = src.thumbnail.getSize();
    return { data: src.thumbnail.toJPEG(72).toString('base64'), mimeType: 'image/jpeg', width: size.width, height: size.height, index, count: displays.length };
  },
  async open({ target }) {
    if (typeof target !== 'string' || !target) throw new Error('缺少要打开的目标');
    if (/^https?:\/\//i.test(target)) { await shell.openExternal(target); return { opened: target }; }
    const p = target === '~' ? os.homedir() : /^~[\\/]/.test(target) ? path.join(os.homedir(), target.slice(2)) : path.resolve(os.homedir(), target);
    if (!fs.existsSync(p)) throw new Error(`路径不存在：${p}`);
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return { opened: p };
  },
};

// 直连的诊断日志：用了哪些地址、为什么没连上。排查“为什么没走直连”时看它。
function logDirect(line) {
  console.log('direct:', line);
  const p = file('direct.log');
  try { if (fs.statSync(p).size > 512 * 1024) fs.renameSync(p, p + '.old'); } catch {}
  fs.appendFile(p, `${new Date().toISOString()} ${line}\n`, () => {});
}

const controlLog = []; // 最近的远程操作，新的在前
function logControl(act) {
  controlLog.unshift(act);
  if (controlLog.length > 200) controlLog.length = 200;
  fs.appendFile(file('control.log'), JSON.stringify({ ...act, time: new Date(act.time).toISOString() }) + '\n', () => {});
  broadcast('control', act);
}

/** 设置页里“远程控制”那张表：每台其他设备的指纹、当前授权档位，以及密钥是否和授权时不一样了 */
function controllerList() {
  const peers = relay.peers;
  const rows = peers.map((p) => {
    const c = config.controllers[p.id];
    return {
      id: p.id, name: p.name, online: p.online, supported: !!p.key, fp: fingerprint(p.key),
      level: c ? c.level : 'none', keyChanged: !!(c && p.key && c.key !== p.key), grantedFp: c ? fingerprint(c.key) : '',
    };
  });
  // 已授权但服务器上已经没有的设备也列出来，方便撤销
  for (const [id, c] of Object.entries(config.controllers)) {
    if (!peers.some((p) => p.id === id)) rows.push({ id, name: c.name, online: false, supported: true, fp: fingerprint(c.key), level: c.level, keyChanged: false, grantedFp: fingerprint(c.key), gone: true });
  }
  return rows;
}

function setController(id, level) {
  if (level === 'none') { delete config.controllers[id]; saveConfig(); return { ok: true }; }
  if (identityError) return { ok: false, error: identityError };
  if (!['read', 'full'].includes(level)) return { ok: false, error: '无效的权限档位' };
  const peer = relay.peers.find((p) => p.id === id);
  const prev = config.controllers[id];
  // 授权绑定的是“此刻看到的这把公钥”；对方不在列表里时只允许调整已有授权的档位
  const key = peer?.key || prev?.key;
  if (!key) return { ok: false, error: '对方的 Win2Mac 版本太旧，还不支持远程控制' };
  config.controllers[id] = { name: peer?.name || prev?.name || id, key, level, grantedAt: Date.now() };
  saveConfig();
  return { ok: true };
}

function mcpConfig() {
  const command = process.execPath;
  const script = path.join(__dirname, 'mcp.js');
  const json = JSON.stringify({ mcpServers: { win2mac: { command, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2);
  const toml = require('./mcp-register').codexToml();
  return { json, toml };
}

// ---------- IPC ----------

function setupIpc() {
  const h = (name, fn) => ipcMain.handle(name, (e, ...args) => fn(...args, e));
  h('state', () => ({ config: publicConfig(), status: relay.status(), history, unseen, platform: process.platform, version: app.getVersion() }));
  h('send-text', (text) => sendText(text));
  h('send-paths', (paths) => sendPaths(paths));
  h('send-clipboard', () => sendClipboard());
  h('send-blob', (name, data) => {
    // 从浏览器等处拖来的、没有磁盘路径的内容：先落到临时目录再发
    const dir = path.join(app.getPath('temp'), 'win2mac-out', stamp() + '-' + crypto.randomBytes(3).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, path.basename(String(name || 'file')).replace(/[<>:"|?*\\/]/g, '_') || 'file');
    fs.writeFileSync(p, Buffer.from(data));
    return sendPaths([p]);
  });
  h('pick', (kind) => pick(kind));
  h('copy-text', async (text) => { await clipboard.writeText(String(text)); return true; });
  h('reveal', (p) => { if (fs.existsSync(p)) shell.showItemInFolder(p); else return false; return true; });
  h('open-path', async (p) => (fs.existsSync(p) ? !(await shell.openPath(p)) : false));
  h('open-download-dir', () => openDownloadDir());
  h('exists', (paths) => (paths || []).map((p) => fs.existsSync(p)));
  h('save-config', (patch) => applyConfig(patch || {}));
  h('apply-pair-code', (code) => {
    const parsed = parsePairCode(code);
    return parsed ? { ...applyConfig(parsed), ...parsed } : { ok: false, error: '配对码格式不对' };
  });
  h('test-connection', async (server, token) => {
    try { await Relay.ping(String(server || '').trim().replace(/\/+$/, ''), String(token || '').trim()); return { ok: true }; }
    catch (e) { return { ok: false, error: e.status === 401 ? '口令错误' : (e.message || '连接失败') }; }
  });
  h('choose-download-dir', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '选择接收文件夹', defaultPath: config.downloadDir, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('remove-entry', (id) => { history = history.filter((x) => x.id !== id); saveHistorySoon(); return true; });
  h('clear-history', () => { history = history.filter((x) => x.state === 'active'); saveHistorySoon(); return history; });
  h('cancel', (id) => { relay.cancel(id); return true; });
  h('controllers', () => ({ list: controllerList(), fingerprint: identityError || fingerprint(config.keyPublic), log: controlLog.slice(0, 20) }));
  h('set-controller', (id, level) => setController(String(id), String(level)));
  h('mcp-config', () => mcpConfig());
  h('mcp-register', () => require('./mcp-register').register());
  h('open-control-log', () => {
    const p = file('control.log');
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    shell.showItemInFolder(p);
    return true;
  });
  h('remove-device', async (id) => {
    try { await relay.removeDevice(String(id)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message || '移除失败' }; }
  });

  ipcMain.on('start-drag', (e, paths) => {
    const files = (paths || []).filter((p) => fs.existsSync(p));
    if (files.length) e.sender.startDrag({ files, file: files[0], icon: nativeImage.createFromPath(path.join(ASSETS, 'drag.png')) });
  });
  ipcMain.on('float-drag-start', floatDragStart);
  ipcMain.on('float-drag-end', floatDragEnd);
  ipcMain.on('toggle-main', toggleMain);
  ipcMain.on('float-menu', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: floatWin }));
}

// ---------- 启动 ----------

function setupRelay() {
  relay = new Relay(relayOpts());
  relay.on('status', (s) => { broadcast('status', s); refreshTray(); });
  const earlyReceipts = new Map();
  function withReceipt(entry, receipt) {
    const receipts = (entry.receipts || []).filter((x) => x.by !== receipt.by);
    return { ...entry, receipts: [...receipts, receipt] };
  }
  relay.on('entry', (entry) => {
    const early = earlyReceipts.get(entry.remoteId);
    if (early) {
      for (const receipt of early) entry = withReceipt(entry, receipt);
      earlyReceipts.delete(entry.remoteId);
    }
    upsertEntry(entry);
  });
  relay.on('received', onReceived);
  for (const status of ['delivered', 'declined']) {
    relay.on(status, ({ id, by, byName }) => {
      const receipt = { by, name: byName || by, status };
      const entry = history.find((x) => x.dir === 'out' && x.remoteId === id);
      if (entry) upsertEntry(withReceipt(entry, receipt));
      // 创建请求的响应可能晚于 SSE 回执。只在确有发送项等待编号时暂存。
      else if (history.some((x) => x.dir === 'out' && x.state === 'active' && !x.remoteId)) {
        if (earlyReceipts.size >= HISTORY_MAX) earlyReceipts.delete(earlyReceipts.keys().next().value);
        const receipts = earlyReceipts.get(id) || [];
        earlyReceipts.set(id, [...receipts.filter((x) => x.by !== by), receipt]);
      }
    });
  }
  relay.on('warn', (e) => { console.error('relay:', e?.message || e); if (/直连/.test(e?.message || '')) logDirect(e.message); });
  if (signingKey) {
    // 信令用设备密钥签名。对方是本机授权过的控制方时，按授权时核对过的那把公钥验，否则按中转转告的公钥验。
    const hub = new DirectHub({
      relay, engine: (p2pEngine ||= new WebRtcEngine()),
      identity: () => ({ deviceId: config.deviceId, privateKey: signingKey }),
      peerKey: (id) => config.controllers[id]?.key || relay.peers.find((p) => p.id === id)?.key || '',
      stun: () => config.stun,
      enabled: () => config.direct !== false,
    });
    const nameOf = (id) => relay.peers.find((p) => p.id === id)?.name || id;
    hub.on('warn', (e) => logDirect(e?.message || String(e)));
    hub.on('diag', (id, text) => logDirect(`[${nameOf(id)}] ${text}`));
    hub.on('route', (id, route) => logDirect(`[${nameOf(id)}] ${route ? `已直连（${route === 'lan' ? '局域网' : '公网'}）` : '已断开'}`));
    relay.setDirect(hub);
  }
  if (signingKey) new ControlHost({
    relay,
    identity: () => ({ deviceId: config.deviceId, privateKey: signingKey }),
    replayFile: file('control-replay.json'),
    controllers: () => config.controllers,
    extras: { ...controlExtras, protectedDir: app.getPath('userData') },
    onActivity: logControl,
  }).attach();
  relay.start();
}

if (mcpMode) {
  app.dock?.hide();
  app.on('window-all-closed', () => {});
  require('./mcp').main();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {}); // 常驻托盘，不随窗口关闭退出
  app.on('activate', showMain);
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearTimeout(historyTimer);
    try { writeJson(file('history.json'), history); } catch {}
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.doubilin.win2mac');
    try { loadConfig(); } catch (e) {
      dialog.showErrorBox('无法读取 Win2Mac 配置', e.message);
      app.exit(1);
      return;
    }
    loadHistory();
    Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
    setupRelay();
    setupIpc();
    registerHotkey();
    applyLoginItem();
    createTray();
    createFloat();
    createMain();

    const hidden = process.argv.includes('--hidden') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin);
    if (hidden && relay.configured) { if (isMac) app.dock?.hide(); }
    else mainWin.once('ready-to-show', showMain);

    screen.on('display-removed', () => { if (floatWin?.isVisible()) floatWin.setBounds(floatBounds()); });
  });
}

// 供冒烟测试脚本驱动
module.exports = {
  get relay() { return relay; }, get mainWin() { return mainWin; }, get floatWin() { return floatWin; },
  get config() { return config; }, get history() { return history; },
  sendClipboard, readClipboard, writeClipboardImage, applyConfig, showMain, setController, controllerList, mcpConfig,
  get controlLog() { return controlLog; },
};
