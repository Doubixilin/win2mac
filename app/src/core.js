'use strict';
// 传输核心：只依赖 Node 标准库，不依赖 Electron，方便单独测试。
// 负责：SSE 长连接、发送文本/文件/文件夹（分片上传）、接收并落盘、进度事件。
// 文件有两条路：对方在线且能直连时走直连（见 direct.js，由宿主用 setDirect 注入），否则走中转。

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const CHUNK = 8 * 2 ** 20;
const RETRIES = 6;
const IDLE_TIMEOUT = 60e3;
const DIRECT_MIN = 256 * 1024;        // 小于这个大小的直接走中转，省得为一张截图去打洞
const DIRECT_CHUNK = 64 * 1024;
const DIRECT_WINDOW = 24 * 2 ** 20;   // 对方还没确认落盘的数据最多攒这么多
const DIRECT_ACK = 1 * 2 ** 20;
const DIRECT_STALL_MS = 30e3;         // 这么久没有进展就认为直连断了
const DIRECT_RESUME_MS = 10 * 60e3;   // 直连中断后，这段时间内从中转来的同一批内容接着用原来那条记录
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把任意平台来的文件名变成两边都合法的名字 */
function safeName(name) {
  let s = String(name).replace(/[<>:"|?*\u0000-\u001f\\/]/g, '_').replace(/[. ]+$/g, '');
  if (!s) s = '_';
  if (WIN_RESERVED.test(s)) s = '_' + s;
  let short = '', bytes = 0;
  for (const char of s) {
    bytes += Buffer.byteLength(char);
    if (bytes > 240 || short.length + char.length > 200) break;
    short += char;
  }
  return short.replace(/[. ]+$/g, '') || '_';
}

function relativeParts(rel) {
  const parts = String(rel).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
  return parts.length ? parts : ['_'];
}

function safeRel(rel) { return relativeParts(rel).map(safeName); }

/** 对方声明的相对路径：去掉空段，拒绝 .. */
function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 2000) return null;
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

function topNames(files, dirs) {
  return [...new Set([...files.map((f) => f.rel), ...(dirs || [])].map((rel) => relativeParts(rel)[0]))].map(safeName);
}

function batchKey(from, files, dirs) {
  const body = JSON.stringify([files.map((f) => [f.rel, f.size]), dirs || []]);
  return from + '|' + crypto.createHash('sha1').update(body).digest('hex');
}

function nameKey(name) { return name.normalize('NFC').toLowerCase(); }
function numberedName(name, i) {
  if (i === 1) return name;
  const ext = path.extname(name);
  return name.slice(0, name.length - ext.length) + ' (' + i + ')' + ext;
}

async function uniqueName(dir, name, taken) {
  for (let i = 1; ; i++) {
    const cand = numberedName(name, i);
    if (taken?.has(nameKey(cand))) continue;
    try { await fsp.lstat(path.join(dir, cand)); }
    catch (e) { if (e.code === 'ENOENT') return cand; throw e; }
  }
}

// 在目标文件系统上发布已写完的文件。硬链接的创建本身就是排他操作。
// FAT/exFAT 等不支持硬链接的卷使用排他复制，仍然保留同时出现的已有目标。
async function publishFile(part, dest, overwrite = false) {
  if (overwrite) return fsp.rename(part, dest);
  try { await fsp.link(part, dest); }
  catch (e) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(e.code)) throw e;
    await fsp.copyFile(part, dest, fs.constants.COPYFILE_EXCL);
  }
}

async function publishBatch(dir, item, stage, checkActive) {
  const dirs = new Map(), taken = new Map(), tops = new Set(), created = [];
  async function claim(parent, raw, create, isDir) {
    if (!taken.has(parent)) taken.set(parent, new Set());
    const used = taken.get(parent);
    const name = safeName(raw);
    for (let i = 1; ; i++) {
      checkActive();
      const candidate = numberedName(name, i);
      const key = nameKey(candidate);
      if (used.has(key)) continue;
      const target = path.join(parent, candidate);
      try { await create(target); }
      catch (e) {
        if (e.code === 'EEXIST') continue;
        // Windows 和不支持硬链接的卷可能对已存在的目录返回 EPERM/EISDIR。
        if (['EPERM', 'EISDIR', 'EACCES', 'ENOTEMPTY'].includes(e.code) && await fsp.lstat(target).catch(() => null)) continue;
        throw e;
      }
      used.add(key);
      const identity = await fsp.lstat(target, { bigint: true });
      created.push({ target, isDir, identity });
      if (parent === dir) tops.add(target);
      return target;
    }
  }
  async function directory(parts) {
    let parent = dir;
    for (const raw of parts) {
      // 保留原始路径分量身份，清洗后同名的两个目录各自占一个名字。
      const key = path.join(parent, raw);
      if (!dirs.has(key)) dirs.set(key, await claim(parent, raw, (p) => fsp.mkdir(p), true));
      parent = dirs.get(key);
    }
    return parent;
  }
  try {
    for (const [i, f] of item.files.entries()) {
      const parts = relativeParts(f.rel);
      const raw = parts.pop();
      const parent = await directory(parts);
      await claim(parent, raw, (p) => publishFile(path.join(stage, String(i)), p), false);
    }
    for (const rel of item.dirs || []) await directory(relativeParts(rel));
    checkActive();
    return [...tops];
  } catch (e) {
    for (const { target, isDir, identity } of created.reverse()) {
      // 保留已经替换或编辑过的文件。目录已被外部添加内容时 rmdir 会保留它。
      const current = await fsp.lstat(target, { bigint: true }).catch(() => null);
      if (!current || current.dev !== identity.dev || current.ino !== identity.ino) continue;
      if (!isDir && current.mtimeNs !== identity.mtimeNs) continue;
      await (isDir ? fsp.rmdir(target) : fsp.unlink(target)).catch(() => {});
    }
    throw e;
  }
}

async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

class Canceled extends Error { constructor() { super('已取消'); this.canceled = true; } }

class Relay extends EventEmitter {
  constructor(opts) {
    super();
    // publicKey：本设备的签名公钥，随请求告知中转；role='control' 表示这是控制端连接，只收设备列表和控制应答
    this.opts = { server: '', token: '', deviceId: '', deviceName: '', downloadDir: '', publicKey: '', role: '', directMin: DIRECT_MIN, directStallMs: DIRECT_STALL_MS };
    this.direct = null;             // 直连通道的提供者，见 setDirect
    this._skip = new Map();         // 中转条目编号 -> 已经直连收过，到了只确认不下载
    this._failedDirect = new Map(); // 直连中断的接收记录，等中转把同一批内容送来时接着用
    this.connected = false;
    this.devices = [];
    this.lastError = '';
    this._running = false;
    this._gen = 0;
    this._stream = null;
    this._seen = new Set();
    this._canceled = new Set();
    this._active = new Map(); // id -> 当前请求，用于取消
    this._inQ = Promise.resolve();
    this._outQ = Promise.resolve();
    this._agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
    Object.assign(this.opts, opts);
    this.opts.server = String(this.opts.server || '').trim().replace(/\/+$/, '');
    this._retired = false;
  }

  updatePreferences({ deviceName, downloadDir }) {
    Object.assign(this.opts, { deviceName, downloadDir });
  }

  // 每个 Relay 固定绑定一组服务器与凭据。切换配对会退役旧实例并创建新实例。
  retire() {
    this._retired = true;
    this.direct?.dispose?.();
    this.stop();
    this._destroyAgents();
  }

  /**
   * 注入直连能力。provider 需要提供：
   *   usable(peer) -> boolean            现在值不值得对这台设备试直连
   *   open(peerId) -> Promise<Link>      打通并开一条通道；打不通就 reject
   *   penalize(peerId, 原因)（可选）      这条连接传不动，请断开并过一阵再试
   *   'link' 事件 (link, peerId)          对方开过来的通道
   * Link：send(字符串或 Buffer) -> Promise、close()、'message' 和 'close' 事件。
   */
  setDirect(provider) {
    this.direct = provider;
    provider.on('link', (link, peerId) => this._acceptDirect(link, peerId));
  }

  _checkActive(id) {
    if (this._retired) throw new Error('配对已切换，传输已中断');
    if (this._canceled.has(id)) throw new Canceled();
  }

  get configured() { return !!(this.opts.server && this.opts.token && this.opts.deviceId); }
  get peers() { return this.devices.filter((d) => d.id !== this.opts.deviceId); }

  start() {
    this.stop();
    if (!this.configured) { this._setStatus(false, '尚未配置服务器'); return; }
    this._running = true;
    this._loop(++this._gen);
  }

  stop() {
    this._running = false;
    this._gen++;
    if (this._stream) { this._stream.destroy(); this._stream = null; }
    this._setStatus(false, '');
  }

  _setStatus(connected, error) {
    this.connected = connected;
    if (error !== undefined) this.lastError = error;
    if (!connected) this.devices = this.devices.map((d) => ({ ...d, online: false }));
    this.emit('status', this.status());
  }

  status() {
    return { connected: this.connected, error: this.lastError, devices: this.devices, peers: this.peers, configured: this.configured };
  }

  // ---------- HTTP 基础 ----------

  _request(method, p, { headers = {}, signalId } = {}) {
    this._checkActive(signalId);
    const url = new URL(this.opts.server + p);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method,
      agent: this._agents[url.protocol],
      headers: {
        Authorization: 'Bearer ' + this.opts.token,
        'X-Device': this.opts.deviceId,
        'X-Device-Name': encodeURIComponent(this.opts.deviceName || this.opts.deviceId),
        ...(this.opts.publicKey ? { 'X-Device-Key': this.opts.publicKey } : {}),
        ...headers,
      },
    });
    req.setTimeout(IDLE_TIMEOUT, () => req.destroy(new Error('网络超时')));
    if (signalId) this._active.set(signalId, req);
    req.on('close', () => { if (signalId && this._active.get(signalId) === req) this._active.delete(signalId); });
    return req;
  }

  /** 发 JSON、收 JSON。非 2xx 抛错，错误对象带 status 和服务端返回的 body */
  _json(method, p, body, extra) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = this._request(method, p, {
        ...extra,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : { 'Content-Length': 0 },
      });
      req.on('error', reject);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(Object.assign(new Error(parsed.error || `服务器返回 ${res.statusCode}`), { status: res.statusCode, body: parsed }));
        });
      });
      req.end(data || undefined);
    });
  }

  async _retry(id, fn) {
    let lastErr;
    for (let i = 0; i < RETRIES; i++) {
      this._checkActive(id);
      try {
        const result = await fn(i);
        this._checkActive(id);
        return result;
      } catch (e) {
        this._checkActive(id);
        // 4xx（除 408/409/429）是确定性错误，重试没有意义
        if (e.status && e.status >= 400 && e.status < 500 && ![408, 409, 429].includes(e.status)) throw e;
        lastErr = e;
        if (i + 1 < RETRIES) await sleep(Math.min(1000 * 2 ** i, 15e3));
      }
    }
    throw lastErr;
  }

  /** 用给定配置测一下连通性和口令，不影响当前连接 */
  static async ping(server, token) {
    const r = new Relay({ server, token, deviceId: 'ping-probe' });
    try { return await r._json('GET', '/api/ping'); } finally { r._destroyAgents(); }
  }
  _destroyAgents() { for (const a of Object.values(this._agents)) a.destroy(); }

  // ---------- SSE ----------

  async _loop(gen) {
    let delay = 1000;
    while (this._running && gen === this._gen) {
      const t0 = Date.now();
      try {
        await this._listen(gen);
      } catch (e) {
        if (gen !== this._gen) return;
        this._setStatus(false, e.status === 401 ? '口令错误' : (e.message || '连接失败'));
      }
      if (!this._running || gen !== this._gen) return;
      delay = Date.now() - t0 > 30e3 ? 1000 : Math.min(delay * 2, 20e3);
      await sleep(delay);
    }
  }

  _listen(gen) {
    return new Promise((resolve, reject) => {
      const req = this._request('GET', '/api/events' + (this.opts.role ? '?role=' + this.opts.role : ''), { headers: { Accept: 'text/event-stream' } });
      this._stream = req;
      req.setTimeout(0);
      let watchdog = null;
      const arm = () => {
        clearTimeout(watchdog);
        // 服务器每 20 秒发一次心跳，50 秒没动静就认为连接已死
        watchdog = setTimeout(() => req.destroy(new Error('心跳超时')), 50e3);
      };
      const finish = (err) => { clearTimeout(watchdog); if (this._stream === req) this._stream = null; err ? reject(err) : resolve(); };
      arm();
      req.on('error', finish);
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish(Object.assign(new Error(`服务器返回 ${res.statusCode}`), { status: res.statusCode }));
        }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          arm();
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message', data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data || gen !== this._gen) continue;
            try { this._onEvent(event, JSON.parse(data)); } catch (e) { this.emit('warn', e); }
          }
        });
        res.on('end', () => finish(new Error('连接断开')));
        res.on('error', finish);
      });
      req.end();
    });
  }

  _onEvent(event, data) {
    if (event === 'hello' || event === 'presence') {
      this.devices = data.devices || [];
      this.connected = true;
      this.lastError = '';
      this.emit('status', this.status());
    } else if (event === 'item') {
      if (this._seen.has(data.id)) return;
      this._seen.add(data.id);
      if (this._skip.has(data.id)) {
        const status = this._skip.get(data.id);
        this._skip.delete(data.id);
        this._ack(data.id, status);
        return;
      }
      this._inQ = this._inQ.then(() => { if (!this._retired) return this._receive(data); }).catch((e) => this.emit('warn', e));
    } else if (event === 'delivered' || event === 'declined') {
      this.emit(event, data);
    } else if (event === 'rpc' || event === 'rpc-reply') {
      this.emit(event, data);
    }
  }

  // ---------- 发送 ----------

  sendText(text) {
    const entry = this._entry({ dir: 'out', kind: 'text', text, total: Buffer.byteLength(text), state: 'active' });
    this.emit('entry', entry);
    this._outQ = this._outQ.then(async () => {
      try {
        const r = await this._retry(entry.id, () => this._json('POST', '/api/items', { kind: 'text', text }));
        entry.remoteId = r.id;
        this._finish(entry, 'done');
      } catch (e) { this._fail(entry, e); }
    });
    return entry;
  }

  /** paths 可以混合文件和文件夹 */
  sendPaths(paths, { clip = false } = {}) {
    const names = paths.map((p) => path.basename(p));
    const entry = this._entry({
      dir: 'out', kind: 'files', state: 'active', total: 0, done: 0, paths: [...paths],
      name: names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 项`, count: names.length,
    });
    this.emit('entry', entry);
    this._outQ = this._outQ.then(() => this._upload(entry, paths, clip).catch((e) => this._fail(entry, e)));
    return entry;
  }

  async _scan(paths) {
    const files = [], dirs = [], taken = new Set();
    const walk = async (abs, rel) => {
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) {
        // 链接到文件的照常发；链接到目录的跳过，避免成环
        const real = await fsp.stat(abs).catch(() => null);
        if (real?.isFile()) files.push({ abs, rel, size: real.size });
        return;
      }
      if (st.isFile()) { files.push({ abs, rel, size: st.size }); return; }
      if (!st.isDirectory()) return;
      const names = (await fsp.readdir(abs)).filter((n) => !SKIP_NAMES.has(n)).sort();
      if (!names.length) dirs.push(rel);
      for (const n of names) await walk(path.join(abs, n), rel + '/' + n);
    };
    for (const p of paths) {
      const abs = path.resolve(p);
      // 来自不同目录的同名项，发送时就改名，避免对端互相覆盖
      let top = path.basename(abs) || 'root';
      const ext = path.extname(top), base = top.slice(0, top.length - ext.length);
      for (let i = 2; taken.has(top.toLowerCase()); i++) top = `${base} (${i})${ext}`;
      taken.add(top.toLowerCase());
      await walk(abs, top);
    }
    return { files, dirs };
  }

  async _upload(entry, paths, clip) {
    this._checkActive(entry.id);
    const { files, dirs } = await this._scan(paths);
    if (!files.length && !dirs.length) throw new Error('没有可发送的文件');
    entry.total = files.reduce((n, f) => n + f.size, 0);
    entry.fileCount = files.length;
    this.emit('entry', entry);

    // 在线的设备先试直连；没送到的（离线、没打通、旧版本）再走中转
    const settled = await this._deliverDirect(entry, { files, dirs }, clip);
    if (settled.size && this.peers.every((p) => settled.has(p.id))) return this._finish(entry, 'done');
    entry.via = 'relay';
    entry.done = 0;

    const created = await this._retry(entry.id, () => this._json('POST', '/api/items', {
      kind: 'files', clip, dirs, files: files.map((f) => ({ rel: f.rel, size: f.size })),
    }));
    const rid = entry.remoteId = created.id;
    this.emit('entry', entry);
    try {
      // 已经直连收到的设备不必再从中转收一遍。条目要到 commit 才会推给各设备，所以这里通知来得及。
      if (settled.size) await this._tellSkip(settled, rid);
      let base = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let offset = 0;
        while (offset < f.size) {
          const len = Math.min(CHUNK, f.size - offset);
          const start = offset;
          const r = await this._retry(entry.id, async () => {
            try { return await this._putChunk(entry, rid, i, f.abs, start, len, base + start); }
            catch (e) {
              // 409 且带 size：服务器已有的进度和我们不一致，按它的来
              if (e.status === 409 && Number.isInteger(e.body?.size)) return { size: e.body.size };
              throw e;
            }
          });
          offset = r.size;
          this._progress(entry, base + offset);
        }
        base += f.size;
      }
      await this._retry(entry.id, () => this._json('POST', `/api/items/${rid}/commit`));
      this._finish(entry, 'done');
    } catch (e) {
      this._json('DELETE', `/api/items/${rid}`).catch(() => {});
      throw e;
    }
  }

  _putChunk(entry, rid, idx, abs, start, len, progressBase) {
    return new Promise((resolve, reject) => {
      const req = this._request('PUT', `/api/items/${rid}/files/${idx}?offset=${start}`, {
        signalId: entry.id,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': len },
      });
      const rs = fs.createReadStream(abs, { start, end: start + len - 1 });
      let sent = 0;
      rs.on('data', (c) => { sent += c.length; this._progress(entry, progressBase + sent); });
      rs.on('error', (e) => { req.destroy(); reject(e); });
      req.on('error', (e) => { rs.destroy(); reject(e); });
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          if (res.statusCode === 200) return resolve(body);
          reject(Object.assign(new Error(body.error || `上传失败 ${res.statusCode}`), { status: res.statusCode, body }));
        });
        res.on('error', reject);
      });
      rs.pipe(req);
    });
  }

  // ---------- 直连：发送 ----------

  /** 逐台试直连。返回 设备编号 -> 'delivered' | 'declined'，没在里面的就是还得走中转的 */
  async _deliverDirect(entry, scan, clip) {
    const settled = new Map();
    if (!this.direct || !this.connected || entry.total < this.opts.directMin) return settled;
    const targets = this.peers.filter((p) => this.direct.usable(p));
    if (!targets.length) return settled;
    const tid = crypto.randomBytes(9).toString('base64url');
    entry.remoteId = 'p2p-' + tid;
    entry.via = 'direct';
    this.emit('entry', entry);
    for (const peer of targets) {
      try {
        const outcome = await this._sendDirect(entry, peer, scan, clip, tid);
        settled.set(peer.id, outcome);
        this.emit(outcome, { id: entry.remoteId, by: peer.id, byName: peer.name });
      } catch (e) {
        this._checkActive(entry.id); // 是用户自己取消的就不再往下走
        // 连上了却传不动：这条连接留着也没用，断开并过一阵再试，免得下一批文件又在它上面白等
        if (e.stalled) this.direct.penalize?.(peer.id, e.message);
        this.emit('warn', new Error(`到“${peer.name}”的直连没成，改走中转：${e.message}`));
      }
    }
    return settled;
  }

  async _sendDirect(entry, peer, { files, dirs }, clip, tid) {
    this._checkActive(entry.id);
    const link = await this.direct.open(peer.id);
    const DECLINED = {};
    const st = { accepted: false, acked: 0, result: null, wake: null };
    const poke = () => { const w = st.wake; st.wake = null; w?.(); };
    link.on('message', (m) => {
      if (typeof m !== 'string') return;
      let msg;
      try { msg = JSON.parse(m); } catch { return; }
      if (msg.t === 'accept') st.accepted = true;
      else if (msg.t === 'ack' && Number.isSafeInteger(msg.n)) { st.acked = Math.max(st.acked, msg.n); this._progress(entry, st.acked); }
      else if (['ok', 'cancel', 'fail'].includes(msg.t)) st.result = msg;
      poke();
    });
    link.on('close', poke);
    // 等某个条件成立；期间对方拒收、报错、断开或者用户取消都会跳出来
    const until = async (cond, ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        this._checkActive(entry.id);
        if (st.result?.t === 'cancel') throw DECLINED;
        if (st.result?.t === 'fail') throw new Error(st.result.error || '对方接收失败');
        if (cond()) return;
        if (link.closed) throw new Error('直连中断');
        const left = deadline - Date.now();
        if (left <= 0) throw Object.assign(new Error('直连超时'), { stalled: true });
        await new Promise((resolve) => { const t = setTimeout(resolve, Math.min(left, 1000)); st.wake = () => { clearTimeout(t); resolve(); }; });
      }
    };
    const stallMs = this.opts.directStallMs;
    // 用户取消时通道可能正堵着：先把“取消”排进去再关通道，关通道会让卡住的发送立刻失败
    const handle = { destroy: () => { link.send(JSON.stringify({ t: 'cancel' })).catch(() => {}); link.close(); poke(); } };
    this._active.set(entry.id, handle);
    // 发一块数据。通道太慢（比中转还慢）或者堵死时不干等，超时后由调用方改走中转
    const push = (data) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error('直连太慢或已卡住'), { stalled: true })), stallMs);
      link.send(data).then(resolve, reject).finally(() => clearTimeout(t));
    });
    try {
      await push(JSON.stringify({
        t: 'offer', v: 1, tid, clip: !!clip, createdAt: entry.time, dirs,
        files: files.map((f) => ({ rel: f.rel, size: f.size })),
      }));
      await until(() => st.accepted, stallMs);
      let sent = 0;
      for (const [i, f] of files.entries()) {
        await push(JSON.stringify({ t: 'file', i }));
        let inFile = 0;
        if (f.size) {
          for await (const chunk of fs.createReadStream(f.abs, { highWaterMark: DIRECT_CHUNK, end: f.size - 1 })) {
            await until(() => sent - st.acked < DIRECT_WINDOW, stallMs);
            await push(chunk);
            sent += chunk.length;
            inFile += chunk.length;
          }
        }
        if (inFile !== f.size) throw new Error(`文件在发送途中变了：${f.rel}`);
      }
      await push(JSON.stringify({ t: 'done' }));
      // 对方落盘、整理文件需要时间；只要确认的字节还在涨就继续等
      while (st.result?.t !== 'ok') {
        const seen = st.acked;
        await until(() => st.result?.t === 'ok' || st.acked > seen, seen >= sent ? 5 * 60e3 : stallMs);
      }
      this._progress(entry, entry.total);
      return 'delivered';
    } catch (e) {
      if (e === DECLINED) return 'declined';
      // 自己这边取消的要告诉对方，否则对方会当成断线，等着中转来补
      if (!link.closed && (e?.canceled || this._canceled.has(entry.id) || this._retired)) link.send(JSON.stringify({ t: 'cancel' })).catch(() => {});
      throw e;
    } finally {
      if (this._active.get(entry.id) === handle) this._active.delete(entry.id);
      link.close();
    }
  }

  async _tellSkip(settled, rid) {
    for (const [peerId, outcome] of settled) {
      let link;
      try {
        link = await this.direct.open(peerId);
        const ok = new Promise((resolve, reject) => {
          link.on('message', (m) => { if (m === '{"t":"ok"}') resolve(); });
          link.on('close', () => reject(new Error('直连中断')));
          setTimeout(() => reject(new Error('对方没有回应')), 8e3).unref?.();
        });
        ok.catch(() => {});
        await link.send(JSON.stringify({ t: 'skip', rid, as: outcome }));
        await ok;
      } catch (e) {
        this.emit('warn', new Error(`没能告诉对方跳过中转上的重复内容，它可能会收到两份：${e.message}`));
      } finally { link?.close(); }
    }
  }

  // ---------- 直连：接收 ----------

  _incomingEntry(item, via) {
    const tops = topNames(item.files, item.dirs);
    return this._entry({
      remoteId: item.id, dir: 'in', peer: item.fromName, sentAt: item.createdAt, via,
      kind: 'files', state: 'active', total: item.total, done: 0, paths: [],
      name: tops.length === 1 ? tops[0] : `${tops[0]} 等 ${tops.length} 项`, count: tops.length, fileCount: item.files.length,
    });
  }

  _directItem(msg, peerId) {
    if (!Array.isArray(msg.files) || msg.files.length > 100000) throw new Error('直连文件列表无效');
    const files = [];
    let total = 0;
    for (const f of msg.files) {
      const rel = cleanRel(f?.rel), size = Number(f?.size);
      if (!rel || !Number.isSafeInteger(size) || size < 0) throw new Error('直连文件信息无效');
      files.push({ rel, size });
      total += size;
    }
    const dirs = (Array.isArray(msg.dirs) ? msg.dirs : []).map(cleanRel).filter(Boolean);
    if (!files.length && !dirs.length) throw new Error('直连内容为空');
    const tid = typeof msg.tid === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(msg.tid) ? msg.tid : crypto.randomBytes(9).toString('base64url');
    const fromName = this.devices.find((d) => d.id === peerId)?.name || peerId;
    return { id: 'p2p-' + tid, from: peerId, fromName, kind: 'files', files, dirs, total, clip: !!msg.clip, createdAt: Number(msg.createdAt) || Date.now() };
  }

  /** 处理对方开过来的一条直连通道：收一批文件，或者一条“跳过中转上那份”的通知 */
  _acceptDirect(link, peerId) {
    let ctx = null, finished = false, chain = Promise.resolve();
    const say = (o) => link.send(JSON.stringify(o)).catch(() => {});
    // 最后一条消息发出后由对方来关；对方没关的话过一会儿自己关
    const hangup = () => { const t = setTimeout(() => link.close(), 5000); t.unref?.(); };
    const guard = setTimeout(() => { if (!ctx && !finished) link.close(); }, 15e3);
    guard.unref?.();

    const closeCur = async () => {
      const cur = ctx.cur;
      if (!cur) return;
      ctx.cur = null;
      await cur.fh.close();
      if (cur.got !== cur.size) throw new Error('直连文件不完整');
    };

    const abort = async (e) => {
      finished = true;
      clearTimeout(guard);
      if (!ctx) { link.close(); return; }
      const { entry } = ctx;
      if (this._active.get(entry.id) === ctx.handle) this._active.delete(entry.id);
      await ctx.cur?.fh.close().catch(() => {});
      if (ctx.stage) await fsp.rm(ctx.stage, { recursive: true, force: true }).catch((err) => this.emit('warn', err));
      const local = !!e?.canceled || this._canceled.has(entry.id);
      if (e?.remoteCancel) {
        entry.state = 'canceled';
        entry.error = '对方已取消';
        this.emit('entry', entry);
      } else {
        this._fail(entry, e);
        // 不是任何一方取消的：发送方多半会改走中转，到时接着用这条记录
        if (!local && !this._retired) this._failedDirect.set(batchKey(peerId, ctx.item.files, ctx.item.dirs), { entry, at: Date.now() });
      }
      if (link.closed) return;
      if (local) await say({ t: 'cancel' });
      else if (!e?.remoteCancel) await say({ t: 'fail', error: e?.message || '接收失败' });
      hangup();
    };

    const handle = async (m) => {
      if (Buffer.isBuffer(m)) {
        const cur = ctx?.cur;
        if (!cur || cur.got + m.length > cur.size) throw new Error('直连数据和声明的不一致');
        await cur.fh.writeFile(m);
        cur.got += m.length;
        ctx.written += m.length;
        this._progress(ctx.entry, ctx.written);
        if (ctx.written - ctx.acked >= DIRECT_ACK) { ctx.acked = ctx.written; say({ t: 'ack', n: ctx.written }); }
        return;
      }
      let msg;
      try { msg = JSON.parse(m); } catch { throw new Error('直连消息格式错误'); }
      if (!ctx) {
        if (msg.t === 'skip') {
          if (typeof msg.rid === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(msg.rid)) {
            if (this._skip.size >= 1000) this._skip.delete(this._skip.keys().next().value);
            this._skip.set(msg.rid, msg.as === 'declined' ? 'declined' : undefined);
          }
          finished = true;
          clearTimeout(guard);
          await say({ t: 'ok' });
          hangup();
          return;
        }
        if (msg.t !== 'offer') throw new Error('直连消息顺序不对');
        const item = this._directItem(msg, peerId);
        ctx = { item, entry: this._incomingEntry(item, 'direct'), stage: null, cur: null, next: 0, written: 0, acked: 0 };
        ctx.handle = { destroy: (err) => { chain = chain.then(() => (finished ? null : abort(err))); } };
        this._active.set(ctx.entry.id, ctx.handle);
        clearTimeout(guard);
        this.emit('entry', ctx.entry);
        await fsp.mkdir(this.opts.downloadDir, { recursive: true });
        ctx.stage = await fsp.mkdtemp(path.join(this.opts.downloadDir, '.win2mac-'));
        await say({ t: 'accept' });
        return;
      }
      if (msg.t === 'file') {
        await closeCur();
        const f = ctx.item.files[msg.i];
        if (msg.i !== ctx.next || !f) throw new Error('直连文件顺序不对');
        ctx.next++;
        ctx.cur = { fh: await fsp.open(path.join(ctx.stage, String(msg.i)), 'w'), got: 0, size: f.size };
      } else if (msg.t === 'done') {
        await closeCur();
        if (ctx.next !== ctx.item.files.length) throw new Error('直连文件不完整');
        const { entry, item } = ctx;
        this._checkActive(entry.id);
        entry.paths = await publishBatch(this.opts.downloadDir, item, ctx.stage, () => this._checkActive(entry.id));
        finished = true;
        if (this._active.get(entry.id) === ctx.handle) this._active.delete(entry.id);
        await fsp.rm(ctx.stage, { recursive: true, force: true }).catch((e) => this.emit('warn', e));
        this._finish(entry, 'done');
        this.emit('received', entry, item);
        await say({ t: 'ack', n: ctx.written });
        await say({ t: 'ok' });
        hangup();
      } else if (msg.t === 'cancel') {
        throw Object.assign(new Error('对方已取消'), { remoteCancel: true });
      }
    };

    link.on('message', (m) => { chain = chain.then(() => (finished ? null : handle(m))).catch((e) => (finished ? null : abort(e))).catch((e) => this.emit('warn', e)); });
    link.on('close', () => { chain = chain.then(() => (finished ? null : abort(new Error('直连中断')))).catch((e) => this.emit('warn', e)); });
  }

  // ---------- 接收 ----------

  async _receive(item) {
    const common = { remoteId: item.id, dir: 'in', peer: item.fromName, sentAt: item.createdAt };
    if (item.kind === 'text') {
      const entry = this._entry({ ...common, kind: 'text', text: item.text, total: Buffer.byteLength(item.text || ''), state: 'done' });
      entry.done = entry.total;
      this.emit('entry', entry);
      this.emit('received', entry, item);
      await this._ack(item.id);
      return;
    }
    // 这批内容刚才直连传到一半断了的话，接着用那条记录，界面上不会多出一条失败的
    const key = batchKey(item.from, item.files, item.dirs);
    const prior = this._failedDirect.get(key);
    this._failedDirect.delete(key);
    for (const [k, v] of this._failedDirect) if (Date.now() - v.at > DIRECT_RESUME_MS) this._failedDirect.delete(k);
    const entry = prior && Date.now() - prior.at <= DIRECT_RESUME_MS
      ? Object.assign(prior.entry, { remoteId: item.id, state: 'active', done: 0, error: '', via: 'relay' })
      : this._incomingEntry(item, 'relay');
    this.emit('entry', entry);
    let stage;
    try {
      const dir = this.opts.downloadDir;
      await fsp.mkdir(dir, { recursive: true });
      stage = await fsp.mkdtemp(path.join(dir, '.win2mac-'));
      let base = 0;
      for (const [i, f] of item.files.entries()) {
        const part = path.join(stage, String(i));
        await this._retry(entry.id, () => this._download(entry, item.id, i, f.size, part, base));
        base += f.size;
        this._progress(entry, base);
      }
      entry.paths = await publishBatch(dir, item, stage, () => this._checkActive(entry.id));
      this._finish(entry, 'done');
      this.emit('received', entry, item);
      await this._ack(item.id);
    } catch (e) {
      this._fail(entry, e);
      if (e.canceled && !this._retired) await this._ack(item.id, 'declined');
      else this._seen.delete(item.id);
    } finally {
      if (stage) await fsp.rm(stage, { recursive: true, force: true }).catch((e) => this.emit('warn', e));
    }
  }

  /** 支持断点续传：按本任务暂存文件的长度继续下载。 */
  async _download(entry, rid, idx, size, part, progressBase) {
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch {}
    if (have > size) { await fsp.rm(part, { force: true }); have = 0; }
    if (have === size && size > 0) return;
    await new Promise((resolve, reject) => {
      const req = this._request('GET', `/api/items/${rid}/files/${idx}`, {
        signalId: entry.id, headers: have ? { Range: `bytes=${have}-` } : {},
      });
      let responseStarted = false;
      req.on('error', (e) => { if (!responseStarted) reject(e); });
      req.on('response', (res) => {
        responseStarted = true;
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(Object.assign(new Error(`下载失败 ${res.statusCode}`), { status: res.statusCode }));
        }
        const append = res.statusCode === 206;
        if (!append) have = 0;
        const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
        let got = have;
        res.on('data', (c) => { got += c.length; this._progress(entry, progressBase + got); });
        pipeline(res, ws).then(() => {
          if (got === size) resolve();
          else reject(new Error('文件不完整'));
        }, reject);
      });
      req.end();
    });
  }

  async _ack(rid, status) {
    // 独立路由使旧中转即使不认识拒收，也不会错误地产生已送达回执。
    const action = status === 'declined' ? 'decline' : 'ack';
    try { await this._retry('ack', () => this._json('POST', `/api/items/${rid}/${action}`)); }
    catch (e) { if (e.status !== 404) this.emit('warn', e); }
  }

  // ---------- 远程控制用的底层通道 ----------

  sendRpc(to, payload, sig) { return this._json('POST', '/api/rpc', { to, payload, sig }); }
  replyRpc(to, payload, sig) { return this._json('POST', '/api/rpc/reply', { to, payload, sig }); }

  /** 把一个文件定向传给某台设备（不进对方的接收目录和记录），返回它在中转上的编号 */
  async uploadDirect(abs, to) {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('只能传单个文件');
    const sha256 = await fileDigest(abs);
    const tag = { id: 'direct-' + Math.random().toString(36).slice(2), total: st.size, silent: true };
    const created = await this._retry(tag.id, () => this._json('POST', '/api/items', {
      kind: 'files', direct: to, files: [{ rel: path.basename(abs), size: st.size }],
    }));
    try {
      let offset = 0;
      while (offset < st.size) {
        const len = Math.min(CHUNK, st.size - offset), start = offset;
        const r = await this._retry(tag.id, async () => {
          try { return await this._putChunk(tag, created.id, 0, abs, start, len, start); }
          catch (e) { if (e.status === 409 && Number.isInteger(e.body?.size)) return { size: e.body.size }; throw e; }
        });
        offset = r.size;
      }
      await this._retry(tag.id, () => this._json('POST', `/api/items/${created.id}/commit`));
    } catch (e) {
      this._json('DELETE', `/api/items/${created.id}`).catch(() => {});
      throw e;
    }
    return { id: created.id, size: st.size, name: path.basename(abs), sha256 };
  }

  /** 取回一个定向文件，写到指定路径，取完即从中转删除 */
  async downloadDirect(rid, size, dest, { sha256, overwrite = false } = {}) {
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('定向文件缺少有效的 SHA-256 摘要，请升级两端');
    const tag = { id: 'direct-' + crypto.randomUUID(), total: size, silent: true };
    const parent = path.dirname(dest);
    await fsp.mkdir(parent, { recursive: true });
    const stage = await fsp.mkdtemp(path.join(parent, '.win2mac-'));
    const part = path.join(stage, 'payload');
    try {
      await this._retry(tag.id, () => this._download(tag, rid, 0, size, part, 0));
      if (await fileDigest(part) !== sha256) throw new Error('定向文件 SHA-256 校验失败');
      this._checkActive(tag.id);
      await publishFile(part, dest, overwrite);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch((e) => this.emit('warn', e));
    }
    await this._ack(rid);
  }

  removeDevice(id) { return this._json('DELETE', `/api/devices/${encodeURIComponent(id)}`); }

  // ---------- 条目状态 ----------

  cancel(id) {
    this._canceled.add(id);
    this._active.get(id)?.destroy(new Canceled());
  }

  _entry(fields) {
    return {
      id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      time: Date.now(), done: 0, total: 0, peer: this.peers.map((d) => d.name).join('、'), ...fields,
    };
  }

  _progress(entry, done) {
    if (entry.silent) return;
    entry.done = Math.min(done, entry.total);
    const now = Date.now();
    if (now - (entry._t || 0) < 120) return;
    entry._t = now;
    this.emit('entry', entry);
  }

  _finish(entry, state) {
    entry.state = state;
    entry.done = entry.total;
    this.emit('entry', entry);
  }

  _fail(entry, e) {
    entry.state = e?.canceled || this._canceled.has(entry.id) ? 'canceled' : 'error';
    entry.error = entry.state === 'canceled' ? '已取消' : (e?.message || '失败');
    this._canceled.delete(entry.id);
    this.emit('entry', entry);
  }
}

module.exports = { Relay, safeName, safeRel, uniqueName };
