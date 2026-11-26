'use strict';
// win2mac 中转服务：零依赖，单文件。
// 设备通过 SSE 长连接接收推送，通过普通 HTTP 上传/下载。
// 所有接口都要求 Authorization: Bearer <W2M_TOKEN>。

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.W2M_PORT || 18700);
const HOST = process.env.W2M_HOST || '127.0.0.1';
const DATA = path.resolve(process.env.W2M_DATA || path.join(__dirname, 'data'));
const TOKEN = process.env.W2M_TOKEN || '';
const TTL_MS = Number(process.env.W2M_TTL_DAYS || 7) * 86400e3;
const MAX_BYTES = Number(process.env.W2M_MAX_GB || 20) * 2 ** 30;
const MAX_JSON = 8 * 2 ** 20;
const MAX_CHUNK = 64 * 2 ** 20;
const DEVICE_FORGET_MS = 30 * 86400e3;
const UPLOAD_STALE_MS = 86400e3;
const DIRECT_TTL_MS = 6 * 3600e3;

if (TOKEN.length < 24) {
  console.error('W2M_TOKEN 未设置或太短（至少 24 个字符）');
  process.exit(1);
}

const BLOBS = path.join(DATA, 'blobs');
const STATE_FILE = path.join(DATA, 'state.json');
fs.mkdirSync(BLOBS, { recursive: true });

const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validStoredItem(id, it) {
  if (!isId(id) || !isRecord(it) || it.id !== id || !isId(it.from) || !Number.isFinite(it.createdAt)) return false;
  if (it.pending !== null && !(Array.isArray(it.pending) && it.pending.every(isId))) return false;
  if (it.kind === 'text') return it.status === 'ready' && typeof it.text === 'string';
  return it.kind === 'files' && ['ready', 'uploading'].includes(it.status)
    && Number.isSafeInteger(it.total) && it.total >= 0
    && Array.isArray(it.files) && it.files.every((f) => isRecord(f) && cleanRel(f.rel) && Number.isSafeInteger(f.size) && f.size >= 0)
    && (it.dirs === undefined || (Array.isArray(it.dirs) && it.dirs.every(cleanRel)))
    && (it.direct === undefined || isId(it.direct));
}

function loadState() {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (fs.readdirSync(BLOBS).length || fs.readdirSync(DATA).some((name) => name !== 'blobs')) {
      throw new Error('state.json 缺失，但数据目录已有内容');
    }
    return { devices: {}, items: {} };
  }
  const saved = JSON.parse(raw);
  if (!isRecord(saved) || !isRecord(saved.devices) || !isRecord(saved.items)
      || !Object.entries(saved.devices).every(([id, d]) => isId(id) && isRecord(d) && typeof d.name === 'string' && Number.isFinite(d.lastSeen))
      || !Object.entries(saved.items).every(([id, it]) => validStoredItem(id, it))) {
    throw new Error('state.json 结构无效');
  }
  return saved;
}

let state;
try { state = loadState(); } catch (e) {
  console.error('中转索引无法读取，已停止启动并保留暂存文件。请检查或恢复', STATE_FILE, e.message);
  process.exit(1);
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveNow(); } catch (e) { console.error('保存中转状态失败', e.message); }
  }, 200);
}
function saveNow() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
  clearTimeout(saveTimer);
  saveTimer = null;
}

// 调用者只在快照替换成功后推送事件或返回成功。失败时恢复内存，以便安全重试。
function persistItem(id, next) {
  const previous = state.items[id];
  if (next) state.items[id] = next;
  else delete state.items[id];
  try { saveNow(); } catch (e) {
    if (previous) state.items[id] = previous;
    else delete state.items[id];
    throw e;
  }
}

/** deviceId -> Set<ServerResponse>：客户端主连接，收内容推送和远程控制请求 */
const streams = new Map();
/** deviceId -> Set<ServerResponse>：控制端（MCP 进程）连接，只收设备列表和控制应答，不算“在线” */
const controlStreams = new Map();

const newId = () => crypto.randomBytes(9).toString('base64url');
const blobDir = (id) => path.join(BLOBS, id);
const blobPath = (id, idx) => path.join(BLOBS, id, String(idx));

function tokenOk(req) {
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_JSON) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function touchDevice(req) {
  const id = req.headers['x-device'];
  if (!isId(id)) return null;
  let name = id;
  try { name = decodeURIComponent(String(req.headers['x-device-name'] || id)).slice(0, 80); } catch {}
  // 设备的签名公钥（远程控制用）。中转只负责转告，信不信由各设备自己在本地决定。
  const key = String(req.headers['x-device-key'] || '').slice(0, 200);
  const known = state.devices[id];
  if (!known || known.name !== name || (key && known.key !== key) || Date.now() - known.lastSeen > 60e3) {
    state.devices[id] = { ...known, name, lastSeen: Date.now(), ...(key ? { key } : {}) };
    saveSoon();
  }
  return id;
}

function deviceList() {
  return Object.entries(state.devices).map(([id, d]) => ({ id, name: d.name, key: d.key || '', online: (streams.get(id)?.size || 0) > 0 }));
}

function publicItem(it) {
  return {
    id: it.id, from: it.from, fromName: state.devices[it.from]?.name || it.fromName || it.from,
    kind: it.kind, text: it.text, files: it.files, dirs: it.dirs, total: it.total,
    clip: !!it.clip, createdAt: it.createdAt,
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function pushTo(deviceId, event, data) {
  for (const res of streams.get(deviceId) || []) sse(res, event, data);
}
function broadcast(event, data, exceptDevice) {
  for (const [id, set] of streams) {
    if (id === exceptDevice) continue;
    for (const res of set) sse(res, event, data);
  }
}

// 该条目是否应投递给这台设备
function broadcastPresence(exceptDevice) {
  const data = { devices: deviceList() };
  broadcast('presence', data, exceptDevice);
  for (const set of controlStreams.values()) for (const res of set) sse(res, 'presence', data);
}

function wants(it, deviceId) {
  if (it.status !== 'ready' || it.from === deviceId || it.direct) return false;
  if (it.pending === null) return true; // 发送时还没有其他已知设备：谁先来谁收
  return it.pending.includes(deviceId);
}

function usedBytes() {
  let n = 0;
  for (const it of Object.values(state.items)) n += it.total || 0;
  return n;
}

async function removeItem(id, notify) {
  const it = state.items[id];
  if (!it) return;
  persistItem(id, null);
  await fsp.rm(blobDir(id), { recursive: true, force: true }).catch(() => {});
  if (notify) broadcast('gone', { id });
}

function publish(it) {
  // 定向文件（远程控制里的文件收发）：只给指定设备按编号来取，不走推送
  const others = it.direct ? [it.direct] : Object.keys(state.devices).filter((d) => d !== it.from);
  const ready = { ...it, pending: others.length ? others : null, status: 'ready' };
  persistItem(it.id, ready);
  if (ready.direct) return;
  const pub = publicItem(ready);
  for (const id of streams.keys()) if (wants(ready, id)) pushTo(id, 'item', pub);
}

// ---------- 路由处理 ----------

function handleEvents(req, res, device, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write(': ok\n\n');
  if (url.searchParams.get('role') === 'control') {
    if (!controlStreams.has(device)) controlStreams.set(device, new Set());
    controlStreams.get(device).add(res);
    sse(res, 'hello', { devices: deviceList(), now: Date.now() });
    const beat = setInterval(() => res.write(': hb\n\n'), 20e3);
    req.on('close', () => {
      clearInterval(beat);
      const set = controlStreams.get(device);
      if (set) { set.delete(res); if (!set.size) controlStreams.delete(device); }
    });
    return;
  }
  if (!streams.has(device)) streams.set(device, new Set());
  streams.get(device).add(res);

  sse(res, 'hello', { devices: deviceList(), now: Date.now() });
  const backlog = Object.values(state.items).filter((it) => wants(it, device)).sort((a, b) => a.createdAt - b.createdAt);
  for (const it of backlog) sse(res, 'item', publicItem(it));
  broadcastPresence(device);

  const hb = setInterval(() => res.write(': hb\n\n'), 20e3);
  const close = () => {
    clearInterval(hb);
    const set = streams.get(device);
    if (set) { set.delete(res); if (!set.size) streams.delete(device); }
    if (state.devices[device]) { state.devices[device].lastSeen = Date.now(); saveSoon(); }
    broadcastPresence();
  };
  req.on('close', close);
}

function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 2000) return null;
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

async function handleCreate(req, res, device) {
  const body = await readJson(req);
  const it = { id: newId(), from: device, kind: body.kind, createdAt: Date.now(), status: 'uploading', pending: null, total: 0, clip: !!body.clip };
  if (body.kind === 'text') {
    if (typeof body.text !== 'string' || !body.text.length) return send(res, 400, { error: '文本为空' });
    it.text = body.text;
    publish(it);
    return send(res, 200, { id: it.id });
  }
  if (body.kind === 'files') {
    if (!Array.isArray(body.files) || body.files.length > 100000) return send(res, 400, { error: '文件列表无效' });
    it.files = [];
    for (const f of body.files) {
      const rel = cleanRel(f?.rel);
      const size = Number(f?.size);
      if (!rel || !Number.isSafeInteger(size) || size < 0) return send(res, 400, { error: '文件信息无效' });
      it.files.push({ rel, size });
      it.total += size;
    }
    it.dirs = (Array.isArray(body.dirs) ? body.dirs : []).map(cleanRel).filter(Boolean);
    if (body.direct !== undefined) {
      if (!isId(body.direct) || it.files.length !== 1) return send(res, 400, { error: '定向文件参数无效' });
      it.direct = body.direct;
    }
    if (!it.files.length && !it.dirs.length) return send(res, 400, { error: '没有可发送的内容' });
    if (usedBytes() + it.total > MAX_BYTES) return send(res, 507, { error: '服务器中转空间不足' });
    fs.mkdirSync(blobDir(it.id));
    try { persistItem(it.id, it); } catch (e) {
      await fsp.rmdir(blobDir(it.id)).catch(() => {});
      throw e;
    }
    return send(res, 200, { id: it.id });
  }
  return send(res, 400, { error: '未知类型' });
}

async function handleUpload(req, res, device, it, idx, url) {
  if (it.from !== device || it.status !== 'uploading') return send(res, 409, { error: '条目不可写' });
  const f = it.files?.[idx];
  if (!f) return send(res, 404, { error: '文件不存在' });
  const offset = Number(url.searchParams.get('offset') || 0);
  const len = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(len) || len > MAX_CHUNK) return send(res, 400, { error: '分片参数无效' });
  if (offset + len > f.size) return send(res, 400, { error: '超出声明的文件大小' });

  const p = blobPath(it.id, idx);
  let cur = 0;
  try { cur = (await fsp.stat(p)).size; } catch {}
  if (offset > cur) return send(res, 409, { error: '偏移不连续', size: cur });

  // 偏移小于当前大小说明是重传：截断后重写，保证幂等
  const fh = await fsp.open(p, cur === 0 ? 'w' : 'r+');
  try {
    if (offset < cur) await fh.truncate(offset);
    let pos = offset;
    for await (const chunk of req) {
      if (pos + chunk.length > offset + len) throw new Error('实际长度超出 Content-Length');
      await fh.write(chunk, 0, chunk.length, pos);
      pos += chunk.length;
    }
    if (pos !== offset + len) throw new Error('分片不完整');
    send(res, 200, { size: pos });
  } finally {
    await fh.close();
  }
}

async function handleCommit(req, res, device, it) {
  if (it.from !== device) return send(res, 403, { error: '不是发送方' });
  if (it.status === 'ready') return send(res, 200, { id: it.id });
  for (let i = 0; i < it.files.length; i++) {
    const p = blobPath(it.id, i);
    let size = -1;
    try { size = (await fsp.stat(p)).size; } catch {}
    if (size === -1 && it.files[i].size === 0) { await fsp.writeFile(p, ''); size = 0; }
    if (size !== it.files[i].size) return send(res, 409, { error: '文件未传完', index: i, size: Math.max(size, 0) });
  }
  if (state.items[it.id] === it) publish(it);
  else if (state.items[it.id]?.status !== 'ready') return send(res, 404, { error: '条目不存在或已过期' });
  send(res, 200, { id: it.id });
}

async function handleDownload(req, res, device, it, idx) {
  if (it.status !== 'ready') return send(res, 409, { error: '条目未就绪' });
  if (it.direct && device !== it.direct && device !== it.from) return send(res, 403, { error: '无权访问' });
  const f = it.files?.[idx];
  if (!f) return send(res, 404, { error: '文件不存在' });
  let start = 0;
  const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
  if (m) start = Number(m[1]);
  if (start > f.size) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size - start, 'Accept-Ranges': 'bytes', 'X-Accel-Buffering': 'no' };
  if (m) { headers['Content-Range'] = `bytes ${start}-${Math.max(f.size - 1, start)}/${f.size}`; res.writeHead(206, headers); }
  else res.writeHead(200, headers);
  if (f.size - start === 0) return res.end();
  const rs = fs.createReadStream(blobPath(it.id, idx), { start });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

async function handleAck(res, device, it, event) {
  if (it.from === device) return send(res, 400, { error: '发送方不能确认' });
  if (it.status !== 'ready') return send(res, 409, { error: '条目未就绪' });
  if (it.pending && !it.pending.includes(device)) return send(res, 200, { ok: true });
  const pending = it.pending?.filter((d) => d !== device) || [];
  if (pending.length) persistItem(it.id, { ...it, pending });
  else await removeItem(it.id, false);
  pushTo(it.from, event, { id: it.id, by: device, byName: state.devices[device]?.name || device });
  send(res, 200, { ok: true });
}

// 远程控制的请求与应答。中转不解析内容，只按目标设备转发；真伪由两端用设备密钥验签。
async function handleRpc(req, res, device, sub) {
  const body = await readJson(req);
  if (!isId(body.to) || typeof body.payload !== 'string' || typeof body.sig !== 'string') return send(res, 400, { error: '参数无效' });
  const msg = { from: device, payload: body.payload, sig: body.sig };
  if (sub === 'reply') {
    const set = controlStreams.get(body.to);
    if (!set?.size) return send(res, 410, { error: '请求方已断开' });
    for (const r of set) sse(r, 'rpc-reply', msg);
    return send(res, 200, { ok: true });
  }
  if (sub) return send(res, 404, { error: 'not found' });
  const set = streams.get(body.to);
  if (!set?.size) return send(res, 409, { error: '设备不在线' });
  sse([...set][0], 'rpc', msg); // 只发给一个连接，同一设备多开时不会重复执行
  send(res, 200, { ok: true });
}

async function forgetDevice(id) {
  delete state.devices[id];
  for (const it of Object.values(state.items)) {
    if (!Array.isArray(it.pending) || !it.pending.includes(id)) continue;
    it.pending = it.pending.filter((x) => x !== id);
    if (it.status === 'ready' && !it.pending.length) await removeItem(it.id, false);
  }
  saveSoon();
}

async function handleForget(res, id) {
  if (!state.devices[id]) return send(res, 404, { error: '设备不存在' });
  if (streams.has(id)) return send(res, 409, { error: '设备正在线，不能移除' });
  await forgetDevice(id);
  broadcastPresence();
  send(res, 200, { ok: true });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
  if (!tokenOk(req)) return send(res, 401, { error: '口令错误' });
  if (parts[1] === 'ping' && req.method === 'GET') return send(res, 200, { ok: true, now: Date.now() });

  // 移除一台不再使用的设备（重装、换机后留下的旧标识），否则发给它的内容要等过期才清
  if (parts[1] === 'devices' && parts.length === 3 && req.method === 'DELETE') return handleForget(res, parts[2]);

  const device = touchDevice(req);
  if (!device) return send(res, 400, { error: '缺少设备标识' });

  if (parts[1] === 'events' && req.method === 'GET') return handleEvents(req, res, device, url);
  if (parts[1] === 'rpc' && req.method === 'POST' && parts.length <= 3) return handleRpc(req, res, device, parts[2]);
  if (parts[1] !== 'items') return send(res, 404, { error: 'not found' });
  if (parts.length === 2 && req.method === 'POST') return handleCreate(req, res, device);

  const it = isId(parts[2]) ? state.items[parts[2]] : null;
  if (!it) return send(res, 404, { error: '条目不存在或已过期' });

  if (parts.length === 3 && req.method === 'DELETE') {
    if (it.from !== device) return send(res, 403, { error: '不是发送方' });
    await removeItem(it.id, true);
    return send(res, 200, { ok: true });
  }
  if (parts[3] === 'commit' && req.method === 'POST') return handleCommit(req, res, device, it);
  if (parts[3] === 'ack' && req.method === 'POST') return handleAck(res, device, it, 'delivered');
  if (parts[3] === 'decline' && req.method === 'POST') return handleAck(res, device, it, 'declined');
  if (parts[3] === 'files' && /^\d+$/.test(parts[4] || '')) {
    const idx = Number(parts[4]);
    if (req.method === 'PUT') return handleUpload(req, res, device, it, idx, url);
    if (req.method === 'GET') return handleDownload(req, res, device, it, idx);
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    send(res, e.status || 500, { error: e.status ? e.message : '服务器内部错误' });
    if (!e.status) console.error(new Date().toISOString(), req.method, req.url, e);
  });
});
server.requestTimeout = 0; // SSE 和大文件传输都是长请求
server.headersTimeout = 30e3;
server.keepAliveTimeout = 75e3;

async function sweep() {
  const now = Date.now();
  for (const it of Object.values(state.items)) {
    const ttl = it.status === 'uploading' ? UPLOAD_STALE_MS : it.direct ? DIRECT_TTL_MS : TTL_MS;
    const stale = now - it.createdAt > ttl;
    if (stale) await removeItem(it.id, true);
  }
  for (const [id, d] of Object.entries(state.devices)) {
    if (!streams.has(id) && now - d.lastSeen > DEVICE_FORGET_MS) await forgetDevice(id);
  }
  // 清掉没有对应条目的残留目录
  for (const name of await fsp.readdir(BLOBS).catch(() => [])) {
    if (!state.items[name]) await fsp.rm(path.join(BLOBS, name), { recursive: true, force: true }).catch(() => {});
  }
}
setInterval(() => sweep().catch((e) => console.error('sweep', e)), 30 * 60e3).unref();
sweep().catch(() => {});

server.listen(PORT, HOST, () => console.log(`win2mac relay listening on ${HOST}:${PORT}, data=${DATA}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { if (saveTimer) clearTimeout(saveTimer); saveNow(); } catch {}
    process.exit(0);
  });
}
