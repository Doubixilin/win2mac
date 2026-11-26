'use strict';
/* global w2m */
const ball = document.getElementById('ball');
const ring = document.getElementById('ring');
const dot = document.getElementById('dot');
const badge = document.getElementById('badge');
const RING_LEN = 182.2;

// ---------- 状态显示 ----------

function renderStatus(s) {
  const online = (s.peers || []).some((p) => p.online);
  ball.classList.toggle('offline', !s.connected);
  dot.className = 'dot' + (s.connected ? (online ? ' online' : ' waiting') : '');
  ball.title = !s.configured ? '尚未配置，点击打开设置'
    : !s.connected ? '未连接服务器'
    : online ? '拖到这里发送；点击打开主界面；右键更多'
    : '对方不在线，拖到这里会先暂存，上线后自动送达';
}

const active = new Map(); // id -> entry
let flashTimer;
function flash(kind) {
  ball.classList.remove('flash-ok', 'flash-err');
  ball.classList.add(kind);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ball.classList.remove(kind), 1600);
}
function onEntry(e) {
  if (e.state === 'active') active.set(e.id, e);
  else if (active.delete(e.id) || e.kind === 'text') {
    if (e.state === 'done') flash('flash-ok');
    else if (e.state === 'error') flash('flash-err');
  }
  let done = 0, total = 0;
  for (const a of active.values()) { done += a.done || 0; total += a.total || 0; }
  ball.classList.toggle('busy', active.size > 0);
  ring.style.strokeDashoffset = String(RING_LEN * (1 - (total ? done / total : 0)));
}
function renderUnseen(n) {
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.classList.toggle('show', n > 0);
}

// ---------- 拖进来发送 ----------

async function sendDataTransfer(dt) {
  const paths = [], blobs = [];
  for (const f of dt.files || []) {
    const p = w2m.pathFor(f);
    if (p) paths.push(p); else blobs.push(f);
  }
  if (paths.length) return w2m.sendPaths(paths);
  if (blobs.length) {
    for (const f of blobs) if (f.size <= 300 * 2 ** 20) await w2m.sendBlob(f.name || '未命名', await f.arrayBuffer());
    return;
  }
  const text = dt.getData('text/plain') || dt.getData('text/uri-list');
  if (text && text.trim()) return w2m.sendText(text);
  flash('flash-err');
}

let depth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; ball.classList.add('over'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; ball.classList.remove('over'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  ball.classList.remove('over');
  sendDataTransfer(e.dataTransfer);
});

// ---------- 点击 / 拖动悬浮窗本身 ----------

let press = null;
ball.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, moved: false };
  ball.setPointerCapture(e.pointerId);
});
ball.addEventListener('pointermove', (e) => {
  if (!press || press.moved) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.moved = true;
    ball.classList.add('moving');
    w2m.floatDragStart();
  }
});
function release(e) {
  if (!press) return;
  const wasMove = press.moved;
  press = null;
  ball.classList.remove('moving');
  if (wasMove) w2m.floatDragEnd();
  else if (e.type === 'pointerup') w2m.toggleMain();
}
ball.addEventListener('pointerup', release);
ball.addEventListener('pointercancel', release);
window.addEventListener('contextmenu', (e) => { e.preventDefault(); w2m.floatMenu(); });

// ---------- 初始化 ----------

w2m.on('status', renderStatus);
w2m.on('entry', onEntry);
w2m.on('unseen', renderUnseen);
// 有别的设备在远程操作这台电脑时，悬浮球闪一下橙色，让坐在电脑前的人知道
let remoteTimer;
w2m.on('control', () => { ball.classList.add('remote'); clearTimeout(remoteTimer); remoteTimer = setTimeout(() => ball.classList.remove('remote'), 2500); });
w2m.state().then((s) => { renderStatus(s.status); renderUnseen(s.unseen); });
