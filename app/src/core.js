'use strict';
// 传输核心：只依赖 Node 标准库，不依赖 Electron，方便单独测试。
// 负责：SSE 长连接、发送文本/文件/文件夹（分片上传）、接收并落盘、进度事件。

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CHUNK = 8 * 2 ** 20;
const RETRIES = 6;
const IDLE_TIMEOUT = 60e3;
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把任意平台来的文件名变成两边都合法的名字 */
function safeName(name) {
  let s = String(name).replace(/[<>:"|?*\u0000-\u001f\\/]/g, '_').replace(/[. ]+$/g, '');
  if (!s) s = '_';
  if (WIN_RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 200);
}

function safeRel(rel) {
  const parts = String(rel).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..').map(safeName);
  return parts.length ? parts : ['_'];
}

/** 目标目录下若已有同名项，返回 "名字 (2).ext" 这样的不冲突名字 */
async function uniqueName(dir, name, taken) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const cand = i === 1 ? name : `${base} (${i})${ext}`;
    if (taken?.has(cand.toLowerCase())) continue;
    try { await fsp.lstat(path.join(dir, cand)); } catch { return cand; }
  }
}

class Canceled extends Error { constructor() { super('已取消'); this.canceled = true; } }

class Relay extends EventEmitter {
  constructor(opts) {
    super();
    // publicKey：本设备的签名公钥，随请求告知中转；role='control' 表示这是控制端连接，只收设备列表和控制应答
    this.opts = { server: '', token: '', deviceId: '', deviceName: '', downloadDir: '', publicKey: '', role: '' };
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
    this.configure(opts || {});
  }

  configure(opts) {
    Object.assign(this.opts, opts);
    this.opts.server = String(this.opts.server || '').trim().replace(/\/+$/, '');
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
      if (this._canceled.has(id)) throw new Canceled();
      try { return await fn(i); } catch (e) {
        if (this._canceled.has(id)) throw new Canceled();
        // 4xx（除 408/409/429）是确定性错误，重试没有意义
        if (e.status && e.status >= 400 && e.status < 500 && ![408, 409, 429].includes(e.status)) throw e;
        lastErr = e;
        await sleep(Math.min(1000 * 2 ** i, 15e3));
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
      this._inQ = this._inQ.then(() => this._receive(data)).catch((e) => this.emit('warn', e));
    } else if (event === 'delivered') {
      this.emit('delivered', data);
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
    const { files, dirs } = await this._scan(paths);
    if (!files.length && !dirs.length) throw new Error('没有可发送的文件');
    entry.total = files.reduce((n, f) => n + f.size, 0);
    entry.fileCount = files.length;
    this.emit('entry', entry);

    const created = await this._retry(entry.id, () => this._json('POST', '/api/items', {
      kind: 'files', clip, dirs, files: files.map((f) => ({ rel: f.rel, size: f.size })),
    }));
    const rid = entry.remoteId = created.id;
    try {
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
    const tops = [...new Set([...item.files.map((f) => safeRel(f.rel)[0]), ...(item.dirs || []).map((d) => safeRel(d)[0])])];
    const entry = this._entry({
      ...common, kind: 'files', state: 'active', total: item.total, done: 0, paths: [],
      name: tops.length === 1 ? tops[0] : `${tops[0]} 等 ${tops.length} 项`, count: tops.length, fileCount: item.files.length,
    });
    this.emit('entry', entry);
    try {
      const dir = this.opts.downloadDir;
      await fsp.mkdir(dir, { recursive: true });
      // 顶层名字若与已有文件冲突，整体换一个名字，内部结构保持不变
      const map = new Map(), taken = new Set();
      for (const t of tops) {
        const u = await uniqueName(dir, t, taken);
        taken.add(u.toLowerCase());
        map.set(t, u);
      }
      const dest = (rel) => { const parts = safeRel(rel); parts[0] = map.get(parts[0]); return path.join(dir, ...parts); };
      entry.paths = tops.map((t) => path.join(dir, map.get(t)));

      for (const d of item.dirs || []) await fsp.mkdir(dest(d), { recursive: true });
      let base = 0;
      for (let i = 0; i < item.files.length; i++) {
        const f = item.files[i];
        const target = dest(f.rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const part = target + '.w2mpart';
        await fsp.rm(part, { force: true });
        await this._retry(entry.id, () => this._download(entry, item.id, i, f.size, part, base));
        await fsp.rename(part, target);
        base += f.size;
        this._progress(entry, base);
      }
      this._finish(entry, 'done');
      this.emit('received', entry, item);
      await this._ack(item.id);
    } catch (e) {
      this._fail(entry, e);
      if (e.canceled) await this._ack(item.id); // 主动取消等于拒收，不再重投
      else this._seen.delete(item.id); // 失败的下次重连时服务器会再推一次
    }
  }

  /** 支持断点续传：.w2mpart 已有多少就从多少开始 */
  async _download(entry, rid, idx, size, part, progressBase) {
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch {}
    if (have > size) { await fsp.rm(part, { force: true }); have = 0; }
    if (have === size && size > 0) return;
    await new Promise((resolve, reject) => {
      const req = this._request('GET', `/api/items/${rid}/files/${idx}`, {
        signalId: entry.id, headers: have ? { Range: `bytes=${have}-` } : {},
      });
      req.on('error', reject);
      req.on('response', (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(Object.assign(new Error(`下载失败 ${res.statusCode}`), { status: res.statusCode }));
        }
        const append = res.statusCode === 206;
        if (!append) have = 0;
        const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
        let got = have;
        res.on('data', (c) => { got += c.length; this._progress(entry, progressBase + got); });
        res.on('error', (e) => { ws.destroy(); reject(e); });
        res.on('aborted', () => { ws.destroy(); reject(new Error('连接中断')); });
        ws.on('error', (e) => { req.destroy(); reject(e); });
        ws.on('finish', () => (got === size ? resolve() : reject(new Error('文件不完整'))));
        res.pipe(ws);
      });
      req.end();
    });
  }

  async _ack(rid) {
    try { await this._retry('ack', () => this._json('POST', `/api/items/${rid}/ack`)); }
    catch (e) { if (e.status !== 404) this.emit('warn', e); }
  }

  // ---------- 远程控制用的底层通道 ----------

  sendRpc(to, payload, sig) { return this._json('POST', '/api/rpc', { to, payload, sig }); }
  replyRpc(to, payload, sig) { return this._json('POST', '/api/rpc/reply', { to, payload, sig }); }

  /** 把一个文件定向传给某台设备（不进对方的接收目录和记录），返回它在中转上的编号 */
  async uploadDirect(abs, to) {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('只能传单个文件');
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
    return { id: created.id, size: st.size, name: path.basename(abs) };
  }

  /** 取回一个定向文件，写到指定路径，取完即从中转删除 */
  async downloadDirect(rid, size, dest) {
    const tag = { id: 'direct-' + rid, total: size, silent: true };
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = dest + '.w2mpart';
    await fsp.rm(part, { force: true });
    try {
      await this._retry(tag.id, () => this._download(tag, rid, 0, size, part, 0));
      if (size === 0) await fsp.writeFile(part, '');
      await fsp.rename(part, dest);
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => {});
      throw e;
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
    this.emit('entry', entry);
  }
}

module.exports = { Relay, safeName, safeRel, uniqueName };
