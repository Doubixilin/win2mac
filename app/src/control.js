'use strict';
// 远程控制：一台设备上的 AI（经 MCP）让另一台设备执行命令、读写文件等。
// 纯 Node 实现，不依赖 Electron；剪贴板、截图这类需要桌面环境的能力由宿主通过 extras 注入。
//
// 信任模型：中转服务器只负责转发，不被信任。
//   - 每台设备有一对 Ed25519 密钥，私钥只留在本机。
//   - 控制请求由发起方签名；被控方只执行“本机用户明确授权过的那把公钥”签出的请求。
//   - 应答由被控方签名，发起方按首次见到并记下的公钥验签。
// 所以光拿到中转口令、或者攻破中转服务器，都没法让任何一台设备执行命令。

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Relay } = require('./core');

const isWin = process.platform === 'win32';
const CLOCK_SKEW_MS = 5 * 60e3;
const OUT_HEAD = 60 * 1024;
const OUT_TAIL = 140 * 1024;
const READ_MAX = 2 * 2 ** 20;

/** 只读权限就能用的方法；其余都需要“完全控制” */
const READ_METHODS = new Set(['sys.info', 'fs.list', 'fs.read', 'fs.stat', 'fs.send', 'clipboard.read', 'screen.capture']);
const FULL_METHODS = new Set(['exec', 'fs.write', 'fs.receive', 'clipboard.write', 'open']);

// ---------- 密钥与签名 ----------

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}
function signText(text, privateKeyB64) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(text, 'utf8'), key).toString('base64');
}
function verifyText(text, sigB64, publicKeyB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}
/** 给人核对用的短指纹，例如 3FA2-9C01-77DE */
function fingerprint(publicKeyB64) {
  if (!publicKeyB64) return '';
  const hex = crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

class ControlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- 被控端：具体干活的函数 ----------

function expand(p) {
  if (typeof p !== 'string' || !p) throw new ControlError('bad-params', '缺少路径');
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(os.homedir(), p); // 相对路径按用户主目录算
}

/** 保留开头和结尾，中间超出的部分丢掉——构建日志之类最有用的通常在两头 */
class Capture {
  constructor() { this.head = []; this.headLen = 0; this.tail = []; this.tailLen = 0; this.dropped = 0; }
  push(buf) {
    if (this.headLen < OUT_HEAD) {
      const take = buf.subarray(0, OUT_HEAD - this.headLen);
      this.head.push(take); this.headLen += take.length;
      buf = buf.subarray(take.length);
      if (!buf.length) return;
    }
    this.tail.push(buf); this.tailLen += buf.length;
    while (this.tailLen > OUT_TAIL) {
      const over = this.tailLen - OUT_TAIL, first = this.tail[0];
      if (first.length <= over) { this.tail.shift(); this.tailLen -= first.length; this.dropped += first.length; }
      else { this.tail[0] = first.subarray(over); this.tailLen -= over; this.dropped += over; }
    }
  }
  text() {
    const head = Buffer.concat(this.head).toString('utf8');
    if (!this.tailLen) return head;
    const tail = Buffer.concat(this.tail).toString('utf8');
    return this.dropped ? `${head}\n…（中间省略 ${this.dropped} 字节）…\n${tail}` : head + tail;
  }
}

function killTree(child) {
  if (isWin) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

function shellSpawn(command, shell, cwd) {
  const opts = { cwd, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (isWin) {
    if (shell === 'cmd') {
      return spawn('cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], { ...opts, windowsVerbatimArguments: true });
    }
    // 统一成 UTF-8 输出、不加载用户 profile、不输出进度条，免得中文乱码和无关报错混进结果
    const script = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;\n"
      + command + '\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], opts);
  }
  // 登录 shell：桌面程序自带的 PATH 很短，这样才能找到 homebrew、nvm 之类装的命令
  const sh = shell && shell !== 'default' ? shell : (process.env.SHELL || '/bin/zsh');
  return spawn(sh, ['-lc', command], { ...opts, detached: true });
}

function runCommand({ command, cwd, timeoutSec = 60, shell }) {
  if (typeof command !== 'string' || !command.trim()) throw new ControlError('bad-params', '缺少命令');
  const limit = Math.min(Math.max(Number(timeoutSec) || 60, 1), 1800) * 1000;
  const dir = cwd ? expand(cwd) : os.homedir();
  if (!fs.existsSync(dir)) throw new ControlError('not-found', `目录不存在：${dir}`);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const out = new Capture(), err = new Capture();
    let timedOut = false, child;
    try { child = shellSpawn(command, shell, dir); } catch (e) { return reject(new ControlError('spawn-failed', e.message)); }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, limit);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(new ControlError('spawn-failed', e.message)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code, signal: signal || undefined, timedOut, durationMs: Date.now() - t0,
        stdout: out.text(), stderr: err.text(), truncated: out.dropped + err.dropped > 0, cwd: dir,
      });
    });
  });
}

function looksBinary(buf) {
  if (buf.includes(0)) return true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return false; } catch { return true; }
}

const fsMethods = {
  async 'fs.list'({ path: p }) {
    const dir = expand(p || '~');
    const names = await fsp.readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const d of names.slice(0, 2000)) {
      let size = 0, mtime = 0;
      try { const st = await fsp.stat(path.join(dir, d.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      entries.push({ name: d.name, type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file', size, mtime: Math.round(mtime) });
    }
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: dir, entries, more: Math.max(names.length - 2000, 0) };
  },
  async 'fs.stat'({ path: p }) {
    const full = expand(p);
    const st = await fsp.stat(full);
    return { path: full, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: Math.round(st.mtimeMs) };
  },
  async 'fs.read'({ path: p, offset = 0, maxBytes = 256 * 1024 }) {
    const full = expand(p);
    const st = await fsp.stat(full);
    if (st.isDirectory()) throw new ControlError('bad-params', '这是个目录，请用列目录');
    const want = Math.min(Math.max(Number(maxBytes) || 0, 1), READ_MAX);
    const start = Math.min(Math.max(Number(offset) || 0, 0), st.size);
    const fh = await fsp.open(full, 'r');
    try {
      const buf = Buffer.alloc(Math.min(want, st.size - start));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const data = buf.subarray(0, bytesRead);
      const binary = looksBinary(data);
      return {
        path: full, size: st.size, offset: start, bytes: bytesRead, truncated: start + bytesRead < st.size,
        encoding: binary ? 'base64' : 'utf8', content: data.toString(binary ? 'base64' : 'utf8'),
      };
    } finally { await fh.close(); }
  },
  async 'fs.write'({ path: p, content, encoding = 'utf8', append = false }) {
    if (typeof content !== 'string') throw new ControlError('bad-params', '缺少内容');
    const full = expand(p);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const data = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
    await (append ? fsp.appendFile(full, data) : fsp.writeFile(full, data));
    return { path: full, bytes: data.length, size: (await fsp.stat(full)).size };
  },
};

function sysInfo() {
  return {
    platform: process.platform, arch: process.arch, osVersion: os.release(), hostname: os.hostname(),
    user: os.userInfo().username, home: os.homedir(), time: new Date().toISOString(),
    shell: isWin ? 'PowerShell（Windows 自带的 5.1；另可指定 shell=cmd）' : (process.env.SHELL || '/bin/zsh') + '（登录 shell）',
    pathSeparator: path.sep,
  };
}

// ---------- 被控端：验签、鉴权、分发 ----------

class ControlHost {
  /**
   * @param relay        已连接的 Relay（主连接）
   * @param identity     () => ({ deviceId, privateKey })
   * @param controllers  () => { [deviceId]: { name, key, level: 'read' | 'full' } }，本机用户授权过的控制方
   * @param extras       { clipboardRead, clipboardWrite, screenshot, open }，由桌面宿主提供
   * @param onActivity   每次请求处理完回调一次，用来记日志、给用户看
   */
  constructor({ relay, identity, controllers, extras = {}, onActivity = () => {} }) {
    Object.assign(this, { relay, identity, controllers, extras, onActivity });
    this.seen = new Map(); // 请求编号 -> 时间，防重放
    this._onRpc = (msg) => this._handle(msg).catch((e) => this.relay.emit('warn', e));
  }
  attach() { this.relay.on('rpc', this._onRpc); return this; }
  detach() { this.relay.off('rpc', this._onRpc); }

  async _handle(msg) {
    let req;
    try { req = JSON.parse(msg.payload); } catch { return; }
    if (!req || typeof req.id !== 'string' || typeof req.from !== 'string' || typeof req.method !== 'string') return;
    const me = this.identity();
    const t0 = Date.now();
    const ctrl = this.controllers()[req.from];
    let result, error;
    try {
      // 顺序有讲究：先确认“是谁”，再看“能不能”，都通过了才碰参数
      if (!ctrl || !ctrl.key || !['read', 'full'].includes(ctrl.level)) throw new ControlError('forbidden', '这台设备没有授权你控制它。请到它的 Win2Mac 设置 → 远程控制 里授权。');
      if (!verifyText(msg.payload, msg.sig, ctrl.key)) throw new ControlError('bad-signature', '签名校验失败：发起方的密钥和这台设备上授权的不一致，需要重新授权。');
      if (req.to !== me.deviceId) throw new ControlError('wrong-target', '请求不是发给这台设备的');
      if (!Number.isFinite(req.ts) || Math.abs(Date.now() - req.ts) > CLOCK_SKEW_MS) throw new ControlError('stale', '请求时间和本机时间相差太大，请检查两台电脑的系统时间');
      if (this.seen.has(req.id)) throw new ControlError('replay', '重复的请求');
      this.seen.set(req.id, Date.now());
      for (const [id, t] of this.seen) if (Date.now() - t > 2 * CLOCK_SKEW_MS) this.seen.delete(id);
      const needFull = FULL_METHODS.has(req.method);
      if (!needFull && !READ_METHODS.has(req.method)) throw new ControlError('unknown-method', `不支持的操作：${req.method}`);
      if (needFull && ctrl.level !== 'full') throw new ControlError('read-only', '这台设备只给了你只读权限，不能执行命令或修改内容');
      result = await this._dispatch(req.method, req.params || {}, req);
    } catch (e) {
      error = { code: e.code && typeof e.code === 'string' ? e.code : 'failed', message: e.message || String(e) };
    }
    const reply = JSON.stringify({ v: 1, id: req.id, from: me.deviceId, to: req.from, ts: Date.now(), ok: !error, result, error });
    this.onActivity({
      time: t0, from: req.from, fromName: ctrl?.name || req.from, method: req.method, summary: summarize(req.method, req.params || {}),
      ok: !error, error: error?.message, ms: Date.now() - t0,
    });
    await this.relay.replyRpc(req.from, reply, signText(reply, me.privateKey)).catch((e) => this.relay.emit('warn', e));
  }

  async _dispatch(method, params, req) {
    if (method === 'sys.info') return sysInfo();
    if (method === 'exec') return runCommand(params);
    if (fsMethods[method]) return fsMethods[method](params);
    if (method === 'fs.send') {
      const full = expand(params.path);
      const up = await this.relay.uploadDirect(full, req.from);
      return { item: up.id, size: up.size, name: up.name, path: full };
    }
    if (method === 'fs.receive') {
      if (typeof params.item !== 'string' || !Number.isSafeInteger(params.size)) throw new ControlError('bad-params', '参数无效');
      let dest = expand(params.dest);
      const st = await fsp.stat(dest).catch(() => null);
      if (st?.isDirectory()) dest = path.join(dest, path.basename(String(params.name || 'file')));
      if (!params.overwrite && fs.existsSync(dest)) throw new ControlError('exists', `目标已存在：${dest}（需要覆盖请显式指定）`);
      await this.relay.downloadDirect(params.item, params.size, dest);
      return { path: dest, size: params.size };
    }
    const map = { 'clipboard.read': 'clipboardRead', 'clipboard.write': 'clipboardWrite', 'screen.capture': 'screenshot', open: 'open' };
    const fn = this.extras[map[method]];
    if (!fn) throw new ControlError('unsupported', '这台设备当前不支持这个操作');
    return fn(params);
  }
}

function summarize(method, p) {
  const s = method === 'exec' ? p.command : method === 'open' ? p.target : (p.path || p.dest || '');
  return String(s || '').replace(/\s+/g, ' ').slice(0, 200);
}

// ---------- 控制端 ----------

class ControlClient extends EventEmitter {
  /** @param opts { server, token, deviceId, deviceName, publicKey, privateKey, pinsFile } */
  constructor(opts) {
    super();
    this.opts = opts;
    this.pending = new Map();
    this.pins = {};
    try { this.pins = JSON.parse(fs.readFileSync(opts.pinsFile, 'utf8')); } catch {}
    this.relay = new Relay({
      server: opts.server, token: opts.token, deviceId: opts.deviceId, deviceName: opts.deviceName,
      publicKey: opts.publicKey, role: 'control', downloadDir: os.tmpdir(),
    });
    this.relay.on('rpc-reply', (msg) => this._onReply(msg));
    this.relay.on('warn', (e) => this.emit('warn', e));
  }

  start() { this.relay.start(); return this; }
  stop() { this.relay.stop(); this.relay._destroyAgents(); }

  async ready(ms = 12e3) {
    const t0 = Date.now();
    while (!this.relay.connected) {
      if (Date.now() - t0 > ms) throw new ControlError('offline', `连不上中转服务器${this.relay.lastError ? '：' + this.relay.lastError : ''}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  devices() { return this.relay.peers; }

  /** 按名字或编号找设备；只有一台别的设备时可以不指定 */
  resolve(ref) {
    const peers = this.devices();
    if (!peers.length) throw new ControlError('no-device', '还没有其他设备和这台电脑配对');
    const names = peers.map((p) => `“${p.name}”`).join('、');
    if (ref === undefined || ref === null || ref === '') {
      if (peers.length === 1) return peers[0];
      throw new ControlError('ambiguous', `有多台设备，请指定是哪一台：${names}`);
    }
    const norm = (x) => String(x).toLowerCase().replace(/\s+/g, '');
    const want = norm(ref);
    const hit = peers.filter((p) => p.id === ref || norm(p.name) === want);
    const loose = hit.length ? hit : peers.filter((p) => norm(p.name).includes(want));
    if (loose.length === 1) return loose[0];
    throw new ControlError(loose.length ? 'ambiguous' : 'no-device', loose.length ? `“${ref}”对应不止一台设备：${names}` : `没有叫“${ref}”的设备。现有：${names}`);
  }

  async call(ref, method, params = {}, { timeoutMs = 30e3 } = {}) {
    await this.ready();
    const dev = this.resolve(ref);
    if (!dev.online) throw new ControlError('offline', `“${dev.name}”不在线（电脑关机、断网，或者 Win2Mac 没有运行）`);
    if (!dev.key) throw new ControlError('too-old', `“${dev.name}”上的 Win2Mac 版本太旧，不支持远程控制`);
    // 首次见到就记下对方公钥；以后变了要报出来，而不是默默接受
    const pinned = this.pins[dev.id];
    if (pinned && pinned !== dev.key) throw new ControlError('key-changed', `“${dev.name}”的设备密钥和上次不一样了（现在是 ${fingerprint(dev.key)}，之前是 ${fingerprint(pinned)}）。如果是重装了软件，请删掉 ${this.opts.pinsFile} 里它的记录后重试。`);

    const req = { v: 1, id: crypto.randomUUID(), from: this.opts.deviceId, to: dev.id, ts: Date.now(), method, params };
    const payload = JSON.stringify(req);
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req.id); reject(new ControlError('timeout', `“${dev.name}”在 ${Math.round(timeoutMs / 1000)} 秒内没有应答`)); }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer, key: dev.key, dev });
    });
    reply.catch(() => {});
    try {
      await this.relay.sendRpc(dev.id, payload, signText(payload, this.opts.privateKey));
    } catch (e) {
      const p = this.pending.get(req.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(req.id); }
      if (e.status === 404) throw new ControlError('server-too-old', '中转服务还是旧版本，不支持远程控制，需要先更新服务器上的 server.js');
      if (e.status === 409) throw new ControlError('offline', `“${dev.name}”不在线`);
      throw e;
    }
    const rep = await reply;
    if (!pinned) { this.pins[dev.id] = dev.key; this._savePins(); }
    return rep;
  }

  _onReply(msg) {
    let rep;
    try { rep = JSON.parse(msg.payload); } catch { return; }
    const p = this.pending.get(rep?.id);
    if (!p) return; // 别的控制进程发起的请求
    clearTimeout(p.timer);
    this.pending.delete(rep.id);
    if (!verifyText(msg.payload, msg.sig, p.key) || rep.from !== p.dev.id) return p.reject(new ControlError('bad-signature', `“${p.dev.name}”的应答没有通过签名校验，已丢弃`));
    if (!rep.ok) return p.reject(new ControlError(rep.error?.code || 'failed', rep.error?.message || '操作失败'));
    p.resolve(rep.result);
  }

  _savePins() {
    try {
      fs.mkdirSync(path.dirname(this.opts.pinsFile), { recursive: true });
      fs.writeFileSync(this.opts.pinsFile, JSON.stringify(this.pins, null, 2));
    } catch (e) { this.emit('warn', e); }
  }

  // 传输超时按最慢 0.2MB/s 估，再留 2 分钟余量
  static transferTimeout(size) { return Math.min(120e3 + (size / (0.2 * 2 ** 20)) * 1000, 6 * 3600e3); }

  /** 把本机文件传到对方的指定位置 */
  async pushFile(ref, localPath, remotePath, { overwrite = false } = {}) {
    await this.ready();
    const dev = this.resolve(ref);
    const local = expand(localPath);
    const up = await this.relay.uploadDirect(local, dev.id);
    try {
      return await this.call(dev.id, 'fs.receive', { item: up.id, size: up.size, name: up.name, dest: remotePath, overwrite }, { timeoutMs: ControlClient.transferTimeout(up.size) });
    } catch (e) {
      this.relay._json('DELETE', `/api/items/${up.id}`).catch(() => {});
      throw e;
    }
  }

  /** 把对方的文件取到本机的指定位置 */
  async pullFile(ref, remotePath, localPath, { overwrite = false } = {}) {
    let dest = expand(localPath);
    const sent = await this.call(ref, 'fs.send', { path: remotePath }, { timeoutMs: 6 * 3600e3 });
    const st = await fsp.stat(dest).catch(() => null);
    if (st?.isDirectory()) dest = path.join(dest, sent.name);
    if (!overwrite && fs.existsSync(dest)) {
      this.relay._ack(sent.item);
      throw new ControlError('exists', `本机目标已存在：${dest}（需要覆盖请显式指定）`);
    }
    await this.relay.downloadDirect(sent.item, sent.size, dest);
    return { path: dest, size: sent.size, remotePath: sent.path };
  }
}

module.exports = { generateKeys, signText, verifyText, fingerprint, ControlHost, ControlClient, ControlError, runCommand, READ_METHODS, FULL_METHODS };
