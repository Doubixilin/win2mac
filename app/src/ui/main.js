'use strict';
/* global w2m */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

let config = {};
let status = {};
const entries = new Map(); // id -> entry
const nodes = new Map();   // id -> <li>

// ---------- 小工具 ----------

function size(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return (n / 1024 ** i).toFixed(i ? (n / 1024 ** i >= 100 ? 0 : 1) : 0) + ' ' + u[i];
}
function when(t) {
  const d = new Date(t), now = new Date(), p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- 顶部状态 ----------

function renderStatus() {
  const dot = $('dot'), name = $('peerName'), st = $('peerState');
  const peers = status.peers || [];
  const online = peers.filter((p) => p.online);
  dot.className = 'dot';
  if (!status.configured) {
    name.textContent = '尚未配置'; st.textContent = '点右上角齿轮，填入服务器地址和口令'; dot.classList.add('error');
  } else if (!status.connected) {
    name.textContent = '未连接服务器'; st.textContent = status.error ? `${status.error}，正在重试…` : '正在连接…'; dot.classList.add('error');
  } else if (online.length) {
    name.textContent = online.map((p) => p.name).join('、'); st.textContent = '在线，可以直接发送'; dot.classList.add('online');
  } else if (peers.length) {
    name.textContent = peers.map((p) => p.name).join('、'); st.textContent = '对方不在线，发送后暂存在服务器，上线自动送达'; dot.classList.add('waiting');
  } else {
    name.textContent = '已连接服务器'; st.textContent = '还没有其他设备连上来，在另一台电脑上装好并配对'; dot.classList.add('waiting');
  }
}

// ---------- 记录列表 ----------

function statusText(e) {
  if (e.state === 'error') return ['err', e.error || '失败'];
  if (e.state === 'canceled') return ['err', '已取消'];
  if (e.state === 'active') {
    const pct = e.total ? Math.floor((e.done / e.total) * 100) : 0;
    return ['', `${e.dir === 'out' ? '上传中' : '接收中'} ${pct}%`];
  }
  if (e.dir === 'in') return ['ok', '已接收'];
  return e.delivered ? ['ok', '已送达'] : ['', '已发出，等待对方接收'];
}

function act(label, fn) {
  const b = el('button', 'link', label);
  b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
  return b;
}

function renderEntry(e) {
  let li = nodes.get(e.id);
  if (!li) {
    li = el('li', 'item');
    nodes.set(e.id, li);
    $('list').prepend(li);
  }
  li.className = `item ${e.dir}`;
  li.replaceChildren();
  li.append(el('div', 'dir', e.dir === 'out' ? '↑' : '↓'));

  const title = el('div', 'title', e.kind === 'text' ? e.text : e.name);
  li.append(title);

  const meta = el('div', 'meta');
  const [cls, label] = statusText(e);
  const parts = [when(e.time)];
  if (e.kind === 'files') parts.push(e.fileCount > 1 ? `${e.fileCount} 个文件 · ${size(e.total)}` : size(e.total));
  if (e.dir === 'in' && e.peer) parts.push(`来自 ${e.peer}`);
  meta.append(el('span', '', parts.join(' · ')), el('span', cls, label));
  li.append(meta);

  if (e.state === 'active' && e.kind === 'files') {
    const bar = el('div', 'progress'), fill = el('i');
    fill.style.width = (e.total ? (e.done / e.total) * 100 : 0) + '%';
    bar.append(fill);
    li.append(bar);
  }

  const acts = el('div', 'acts');
  if (e.kind === 'text') acts.append(act('复制', async () => { await w2m.copyText(e.text); toast('已复制'); }));
  const hasFiles = e.kind === 'files' && e.state === 'done' && e.paths?.length;
  if (hasFiles) {
    if (e.paths.length === 1) acts.append(act('打开', async () => { if (!(await w2m.openPath(e.paths[0]))) toast('文件已不在原位置'); }));
    acts.append(act('在文件夹中显示', async () => { if (!(await w2m.reveal(e.paths[0]))) toast('文件已不在原位置'); }));
  }
  if (e.state === 'active') acts.append(act('取消', () => w2m.cancel(e.id)));
  else acts.append(act('删除记录', async () => { await w2m.removeEntry(e.id); entries.delete(e.id); nodes.delete(e.id); li.remove(); renderEmpty(); }));
  li.append(acts);

  // 收到的文件可以直接从列表里拖出去
  li.draggable = !!(hasFiles && e.dir === 'in');
  li.ondragstart = li.draggable ? (ev) => { ev.preventDefault(); w2m.startDrag(e.paths); } : null;
  li.title = li.draggable ? '可以直接拖到桌面或其他应用里' : '';
}

function renderEmpty() { $('empty').style.display = entries.size ? 'none' : ''; }

function onEntry(e) {
  entries.set(e.id, e);
  renderEntry(e);
  renderEmpty();
}

// ---------- 发送：拖放、粘贴、按钮 ----------

const isEditable = (t) => t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');

async function sendDataTransfer(dt) {
  const paths = [], blobs = [];
  for (const f of dt.files || []) {
    const p = w2m.pathFor(f);
    if (p) paths.push(p); else blobs.push(f);
  }
  if (paths.length) { if (await w2m.sendPaths(paths)) toast(`开始发送 ${paths.length} 项`); return; }
  if (blobs.length) {
    for (const f of blobs) {
      if (f.size > 300 * 2 ** 20) { toast('这个内容太大了，请先保存成文件再拖进来'); continue; }
      await w2m.sendBlob(f.name || '未命名', await f.arrayBuffer());
    }
    toast('开始发送');
    return;
  }
  const text = dt.getData('text/plain') || dt.getData('text/uri-list');
  if (text && text.trim()) { if (await w2m.sendText(text)) toast('文字已发送'); return; }
  toast('没有识别到可以发送的内容');
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  sendDataTransfer(e.dataTransfer);
});

// 在输入框之外粘贴 = 发送剪贴板（文件、截图、文字都行）
window.addEventListener('paste', (e) => {
  if (isEditable(e.target)) return;
  e.preventDefault();
  w2m.sendClipboard().then((ok) => ok && toast('已发送剪贴板内容'));
});

$('pickFiles').addEventListener('click', () => w2m.pick('files'));
$('pickFolder').addEventListener('click', () => w2m.pick('folder'));
$('sendClip').addEventListener('click', async () => { if (await w2m.sendClipboard()) toast('已发送剪贴板内容'); });
$('openDir').addEventListener('click', () => w2m.openDownloadDir());
$('clear').addEventListener('click', async () => {
  const left = await w2m.clearHistory();
  const keep = new Set(left.map((x) => x.id));
  for (const [id, li] of nodes) if (!keep.has(id)) { li.remove(); nodes.delete(id); entries.delete(id); }
  renderEmpty();
});

const textBox = $('text');
async function submitText() {
  const v = textBox.value;
  if (!v.trim()) return;
  if (await w2m.sendText(v)) { textBox.value = ''; $('sendText').disabled = true; }
}
textBox.addEventListener('input', () => { $('sendText').disabled = !textBox.value.trim(); });
textBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitText(); }
});
$('sendText').addEventListener('click', submitText);

// ---------- 设置 ----------

const dlg = $('settings');
const FIELDS = ['server', 'token', 'deviceName', 'downloadDir', 'hotkey'];
const CHECKS = ['autoCopy', 'notify', 'showFloat', 'openAtLogin'];

function renderDevices() {
  const ul = $('deviceList');
  ul.replaceChildren();
  const peers = status.peers || [];
  if (!peers.length) { ul.append(el('li', 'none', '还没有其他设备连接过')); return; }
  for (const p of peers) {
    const li = el('li');
    li.append(el('span', 'dot' + (p.online ? ' online' : '')), el('span', 'name', p.name), el('span', 'state', p.online ? '在线' : '离线'));
    if (!p.online) {
      li.append(act('移除', async () => {
        const r = await w2m.removeDevice(p.id);
        if (!r.ok) toast(r.error);
      }));
    }
    ul.append(li);
  }
}

function openSettings(hint) {
  renderDevices();
  for (const k of FIELDS) $(k).value = config[k] ?? '';
  for (const k of CHECKS) $(k).checked = !!config[k];
  $('pair').value = '';
  $('settingsHint').textContent = hint || '';
  $('testResult').textContent = '';
  $('token').type = 'password';
  $('showToken').textContent = '显示';
  if (!dlg.open) dlg.showModal();
}

$('btnSettings').addEventListener('click', () => openSettings());
$('cancelSettings').addEventListener('click', () => dlg.close());
$('showToken').addEventListener('click', () => {
  const t = $('token');
  t.type = t.type === 'password' ? 'text' : 'password';
  $('showToken').textContent = t.type === 'password' ? '显示' : '隐藏';
});
$('chooseDir').addEventListener('click', async () => { const d = await w2m.chooseDownloadDir(); if (d) $('downloadDir').value = d; });

function showTest(ok, msg) {
  const r = $('testResult');
  r.textContent = msg;
  r.className = 'test-result ' + (ok ? 'ok' : 'err');
}
$('test').addEventListener('click', async () => {
  showTest(true, '测试中…');
  const r = await w2m.testConnection($('server').value, $('token').value);
  showTest(r.ok, r.ok ? '连接正常' : r.error);
});
$('applyPair').addEventListener('click', async () => {
  const r = await w2m.applyPairCode($('pair').value);
  if (!r.ok) return showTest(false, r.error);
  $('server').value = r.server;
  $('token').value = r.token;
  showTest(true, '配对码已应用');
});
$('copyPair').addEventListener('click', async () => {
  if (!config.pairCode) return showTest(false, '先保存服务器地址和口令');
  await w2m.copyText(config.pairCode);
  showTest(true, '配对码已复制，注意它等同于口令');
});
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const k of FIELDS) patch[k] = $(k).value.trim();
  for (const k of CHECKS) patch[k] = $(k).checked;
  const r = await w2m.saveConfig(patch);
  if (r.hotkeyOk === false) { $('settingsHint').textContent = '这个快捷键注册失败（写法不对或被别的程序占用），其余设置已保存'; return; }
  dlg.close();
  toast('设置已保存');
});

// ---------- 初始化 ----------

w2m.on('status', (s) => { status = s; renderStatus(); if (dlg.open) renderDevices(); });
w2m.on('entry', onEntry);
w2m.on('config', (c) => { config = c; });
w2m.on('open-settings', (hint) => openSettings(hint));

(async () => {
  const s = await w2m.state();
  config = s.config;
  status = s.status;
  $('version').textContent = 'v' + s.version;
  if (s.platform === 'darwin') {
    $('dropSub').textContent = '松手就发给对方，也可以直接 ⌘V 粘贴';
  } else {
    $('dropSub').textContent = '松手就发给对方，也可以直接 Ctrl+V 粘贴';
  }
  renderStatus();
  for (const e of [...s.history].reverse()) onEntry(e);
  renderEmpty();
  if (!s.status.configured) openSettings('第一次使用：粘贴配对码，或填入服务器地址和口令');
})();
