'use strict';
// 传输核心：只依赖 Node 标准库，不依赖 Electron，方便单独测试。
// 负责：SSE 长连接、发送文本/文件/文件夹（分片上传）、接收并落盘、进度事件。

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
    this.stop();
    this._destroyAgents();
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
    const tops = [...new Set([...item.files.map((f) => f.rel), ...(item.dirs || [])].map((rel) => relativeParts(rel)[0]))].map(safeName);
    const entry = this._entry({
      ...common, kind: 'files', state: 'active', total: item.total, done: 0, paths: [],
      name: tops.length === 1 ? tops[0] : `${tops[0]} 等 ${tops.length} 项`, count: tops.length, fileCount: item.files.length,
    });
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
