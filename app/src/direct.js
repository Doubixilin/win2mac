'use strict';
// 直连（P2P）：两台设备都在线时，文件不经中转服务器，直接在两台电脑之间传。
//
// 中转服务器在这里只当“介绍人”：双方经它交换连接信息（信令），之后数据走两台电脑之间打通的通道。
// 本文件只依赖 Node 标准库，负责信令、STUN 地址解析、连接和通道的管理；
// 打洞、加密和可靠传输由“引擎”完成（桌面端是隐藏窗口里的 WebRTC，见 p2p.js）。
//
// 引擎接口：ready() -> Promise；send(cmd)；on('evt', fn)；release()。命令和事件的格式见 ui/p2p-page.js 开头。
// 对传输核心暴露的接口：usable(peer)、open(peerId) -> Link、'link' 事件（对方开过来的通道）。

const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const { signText, verifyText } = require('./control');

// 顺序有讲究：排最前的两个是“主参照”，一块网卡只有从它俩查到的公网地址一致才会被用来打洞
// （见 ui/p2p-page.js 的 candidateFilter）。所以前两个要选和你的设备在同一个地区、走同一条出口的。
const DEFAULT_STUN = ['stun.miwifi.com:3478', 'stun.chat.bilibili.com:3478', 'stun.cloudflare.com:3478'];
const PRIMARY_STUN = 2;
const PUBLIC_DNS = ['223.5.5.5', '119.29.29.29', '1.1.1.1'];
const CLOCK_SKEW_MS = 5 * 60e3;
const SIGNAL_MS = 6e3;                    // 这么久没收到对方的信令，就认为它不支持直连
const CONNECT_MS = 10e3;                  // 打洞最长等待；打得通的话一般两三秒内就通了
const LINK_OPEN_MS = 8e3;
const IDLE_MS = 5 * 60e3;                 // 没有传输这么久就断开，下次要用再连
const RETRY_UNSUPPORTED_MS = 10 * 60e3;   // 对方不支持：过这么久再试
// 打洞失败：先很快再试；同一个网络下接连失败就越隔越久，免得每次发文件都白等。
// 任何一方重新上线（换了网络必然会重连一次）都会从头算。
const RETRY_FAILED_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];

const newId = () => crypto.randomBytes(9).toString('base64url');

// ---------- STUN 地址解析 ----------

// 公共 STUN 服务器不可能在这些网段里。解析出这种地址，说明 DNS 被代理软件或路由器接管、给的是假地址
// （常见的有 198.18.0.0/15、28.0.0.0/8），只有接管它的那块网卡能用，别的网卡发过去石沉大海。
const ipToInt = (ip) => ip.split('.').reduce((acc, x) => acc * 256 + Number(x), 0);
const BOGUS_NETS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
  '198.18.0.0/15', '224.0.0.0/3',
  // 从未在公网上路由过、常被拿来当假地址池的网段
  '6.0.0.0/8', '7.0.0.0/8', '11.0.0.0/8', '21.0.0.0/8', '22.0.0.0/8', '26.0.0.0/8', '28.0.0.0/8', '29.0.0.0/8',
  '30.0.0.0/8', '33.0.0.0/8', '55.0.0.0/8',
].map((cidr) => { const [base, bits] = cidr.split('/'); return [ipToInt(base), 2 ** (32 - Number(bits))]; });

function isBogusIp(ip) {
  if (net.isIP(ip) !== 4) return true;
  const n = ipToInt(ip);
  return BOGUS_NETS.some(([base, size]) => n >= base && n < base + size);
}

function physicalAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(utun|tun|tap|ipsec|ppp|wg|tailscale|zt)/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || /^(0\.|169\.254\.|198\.1[89]\.)/.test(a.address)) continue;
      out.push(a.address);
    }
  }
  return out;
}

/** 从指定网卡经 HTTPS 问公共 DNS：有些网络封了 53 端口，或者会改写普通 DNS 的应答 */
function resolveOverHttps(host, local) {
  return new Promise((resolve) => {
    const req = https.get({ host: '223.5.5.5', path: `/resolve?name=${encodeURIComponent(host)}&type=1`, localAddress: local, timeout: 2500 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve((JSON.parse(Buffer.concat(chunks).toString('utf8')).Answer || []).filter((x) => x.type === 1).map((x) => String(x.data))); }
        catch { resolve([]); }
      });
      res.on('error', () => resolve([]));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve([]));
  });
}

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  try {
    const { address } = await dns.promises.lookup(host, { family: 4 });
    if (!isBogusIp(address)) return address;
  } catch {}
  // 系统解析拿到的是假地址（或失败）时，从每块真实网卡各问一次公共 DNS：
  // 绑定了本机地址的请求走那块网卡自己的出口，不经过代理的虚拟网卡。
  const locals = physicalAddresses();
  for (const local of locals) {
    const resolver = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
    try {
      resolver.setLocalAddress(local);
      resolver.setServers(PUBLIC_DNS);
      const real = (await resolver.resolve4(host)).find((ip) => !isBogusIp(ip));
      if (real) return real;
    } catch {}
  }
  for (const local of locals) {
    const real = (await resolveOverHttps(host, local)).find((ip) => !isBogusIp(ip));
    if (real) return real;
  }
  return null;
}

/**
 * 把 "主机:端口" 列表解析成 WebRTC 用的 stun: 地址（一律是 IP，避免引擎自己再去解析域名）。
 * 返回 { urls, primary }：primary 是列表前两个里解析成功的那些。
 */
async function resolveStun(servers, { timeoutMs = 5000 } = {}) {
  const list = (Array.isArray(servers) && servers.length ? servers : DEFAULT_STUN).slice(0, 6);
  const one = async (entry) => {
    const m = /^(?:stun:)?\[?([^\]]+?)\]?(?::(\d+))?$/.exec(String(entry).trim());
    if (!m) return null;
    const ip = await resolveHost(m[1]);
    return ip ? `stun:${ip}:${m[2] || 3478}` : null;
  };
  const late = new Promise((resolve) => setTimeout(resolve, timeoutMs, null));
  const urls = await Promise.all(list.map((entry) => Promise.race([one(entry), late])));
  return { urls: [...new Set(urls.filter(Boolean))], primary: [...new Set(urls.slice(0, PRIMARY_STUN).filter(Boolean))] };
}

// ---------- 通道 ----------

/** 一条有序、可靠的消息通道。消息是字符串（控制）或 Buffer（数据）。 */
class Link extends EventEmitter {
  constructor(hub, id, peerId, route) {
    super();
    Object.assign(this, { hub, id, peerId, route, closed: false });
    this._seq = 0;
    this._pending = new Map();
  }

  /** 引擎把这条消息交给底层、且底层缓冲回落后才兑现，调用方据此得到背压 */
  send(data) {
    if (this.closed) return Promise.reject(new Error('直连已断开'));
    const seq = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(seq, { resolve, reject });
      this.hub.engine.send({ op: 'send', link: this.id, seq, data });
    });
  }

  close() {
    if (this.closed) return;
    this.hub.engine.send({ op: 'close-link', link: this.id });
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.hub._links.delete(this.id);
    this._open?.reject(new Error('直连已断开'));
    for (const p of this._pending.values()) p.reject(new Error('直连已断开'));
    this._pending.clear();
    this.emit('close');
    this.hub._touch(this.peerId);
  }
}

// ---------- 连接管理 ----------

class DirectHub extends EventEmitter {
  /**
   * @param relay     已启动的 Relay，用它的 rpc 通道转发信令
   * @param engine    见文件开头
   * @param identity  () => ({ deviceId, privateKey }) 或 null
   * @param peerKey   (deviceId) => 用来验对方信令签名的公钥
   * @param stun      () => 用户配置的 STUN 列表，空则用默认
   * @param enabled   () => 用户是否开着直连
   */
  constructor({ relay, engine, identity, peerKey, stun = () => null, enabled = () => true }) {
    super();
    Object.assign(this, { relay, engine, identity, peerKey, stun, enabled });
    this._peers = new Map();
    this._links = new Map();
    this._online = new Map();
    this._ice = null;
    this._disposed = false;
    this._onRpc = (msg) => { try { this._onSignal(msg); } catch (e) { this.emit('warn', e); } };
    this._onEvt = (evt) => { try { this._onEngine(evt); } catch (e) { this.emit('warn', e); } };
    this._onStatus = (st) => this._onPresence(st);
    relay.on('rpc', this._onRpc);
    relay.on('status', this._onStatus);
    engine.on('evt', this._onEvt);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.relay.off('rpc', this._onRpc);
    this.relay.off('status', this._onStatus);
    for (const p of this._peers.values()) this._closePeer(p, true);
    this.engine.off('evt', this._onEvt);
    this.engine.release();
  }

  /** 用户关掉了直连：断开现有连接。对方下次来连会被明确告知“不接受” */
  shutdown() {
    for (const p of this._peers.values()) if (p.state !== 'idle') this._closePeer(p, true);
  }

  /** 连上了却传不动（比如绕了很慢的线路）：断开，并像打洞失败一样过一阵再试 */
  penalize(peerId, why) {
    const p = this._peers.get(peerId);
    if (!p) return;
    if (p.state !== 'idle') this._closePeer(p, true);
    p.fails = (p.fails || 0) + 1;
    p.retryAt = Date.now() + RETRY_FAILED_MS[Math.min(p.fails, RETRY_FAILED_MS.length) - 1];
    p.why = why || '直连太慢';
    this.emit('diag', peerId, `连上了但传不动（${p.why}），已断开；${Math.round((p.retryAt - Date.now()) / 1000)} 秒后才会再试`);
  }

  /** 现在值不值得对这台设备试直连 */
  usable(peer) {
    if (this._disposed || !this.enabled() || !this.identity() || !peer?.online || !peer.key) return false;
    return !((this._peers.get(peer.id)?.retryAt || 0) > Date.now());
  }

  /** 这台设备当前有没有连着的直连，以及走的是局域网还是公网 */
  routeOf(peerId) {
    const p = this._peers.get(peerId);
    return p?.state === 'connected' ? p.route : '';
  }
  infoOf(peerId) { return this._peers.get(peerId)?.info || null; }

  async open(peerId, { timeoutMs = SIGNAL_MS + CONNECT_MS + LINK_OPEN_MS } = {}) {
    if (this._disposed || !this.enabled()) throw new Error('直连未启用');
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('直连超时')), timeoutMs); });
    try {
      await Promise.race([this._connect(peerId), late]);
      const p = this._peer(peerId);
      const link = new Link(this, newId(), peerId, p.route);
      this._links.set(link.id, link);
      clearTimeout(p.idle);
      const opened = new Promise((resolve, reject) => { link._open = { resolve, reject }; });
      opened.catch(() => {});
      this.engine.send({ op: 'open-link', peer: peerId, link: link.id });
      try { await Promise.race([opened, late]); }
      catch (e) { link.close(); throw e; }
      link._open = null;
      return link;
    } finally { clearTimeout(timer); }
  }

  _peer(id) {
    if (!this._peers.has(id)) this._peers.set(id, { id, state: 'idle', sid: '', route: '', retryAt: 0, why: '', outbox: [], sending: false });
    return this._peers.get(id);
  }

  _connect(peerId, incoming) {
    const p = this._peer(peerId);
    if (p.state === 'connected' && !incoming) return Promise.resolve();
    if (!incoming && p.retryAt > Date.now()) return Promise.reject(new Error(p.why || '直连暂不可用'));
    if (!p.connecting) {
      p.connecting = this._establish(p, incoming).finally(() => { p.connecting = null; });
      p.connecting.catch(() => {});
    }
    return p.connecting;
  }

  async _establish(p, incoming) {
    const me = this.identity();
    if (!me) throw new Error('本机没有设备密钥，不能直连');
    p.state = 'connecting';
    p.gotSignal = false;
    let signalTimer, connectTimer;
    try {
      await this.engine.ready();
      const done = new Promise((resolve, reject) => { p.wait = { resolve, reject }; });
      done.catch(() => {});
      signalTimer = setTimeout(() => {
        if (!p.gotSignal) p.wait?.reject(Object.assign(new Error('对方没有回应直连请求（可能是旧版本）'), { unsupported: true }));
      }, SIGNAL_MS);
      connectTimer = setTimeout(() => p.wait?.reject(new Error('两边的网络没能直接打通')), SIGNAL_MS + CONNECT_MS);
      if (incoming) await this._answer(p, incoming);
      else if (me.deviceId < p.id) await this._offer(p);
      else await this._signal(p, 'want', '', null); // 固定由编号小的一方发起，避免两边同时发起撞车
      await done;
      p.state = 'connected';
      p.connectedAt = Date.now();
      p.retryAt = 0;
      p.fails = 0;
      this._touch(p.id);
      this.emit('route', p.id, p.route);
    } catch (e) {
      this._closePeer(p, true);
      if (!e.unsupported) p.fails = (p.fails || 0) + 1;
      p.retryAt = Date.now() + (e.unsupported ? RETRY_UNSUPPORTED_MS : RETRY_FAILED_MS[Math.min(p.fails, RETRY_FAILED_MS.length) - 1]);
      this.emit('diag', p.id, `没连上：${e.message}；${Math.round((p.retryAt - Date.now()) / 1000)} 秒后才会再试`);
      p.why = e.message;
      throw e;
    } finally {
      clearTimeout(signalTimer);
      clearTimeout(connectTimer);
      p.wait = null;
    }
  }

  async _iceServers() {
    const configured = this.stun();
    const key = JSON.stringify(configured || null);
    if (!this._ice || this._ice.key !== key || this._ice.until < Date.now()) {
      const found = resolveStun(configured);
      this._ice = { key, found, until: Date.now() + 10 * 60e3 };
      // 一个都没解析出来时很快重试；这种情况下仍然能连同一局域网里的设备
      found.then((r) => { if (!r.urls.length && this._ice?.found === found) this._ice.until = Date.now() + 30e3; });
    }
    const { urls, primary } = await this._ice.found;
    return { iceServers: urls.length ? [{ urls }] : [], primary };
  }

  async _offer(p) {
    p.sid = newId();
    this.engine.send({ op: 'connect', peer: p.id, sid: p.sid, role: 'offer', ...(await this._iceServers()) });
  }

  async _answer(p, { sid, sdp }) {
    p.sid = sid;
    p.gotSignal = true;
    const ice = await this._iceServers();
    if (p.sid !== sid) return;
    this.engine.send({ op: 'connect', peer: p.id, sid, role: 'answer', ...ice });
    this.engine.send({ op: 'signal', peer: p.id, sid, type: 'offer', data: sdp });
  }

  _closePeer(p, notify) {
    const had = p.state !== 'idle' && p.sid;
    if (had) this.engine.send({ op: 'close-peer', peer: p.id });
    if (had && notify) this._signal(p, 'bye', p.sid, null).catch(() => {});
    clearTimeout(p.idle);
    p.state = 'idle';
    p.sid = '';
    p.route = '';
    p.wait?.reject(new Error('直连已重置'));
    for (const link of [...this._links.values()]) if (link.peerId === p.id) link._closed();
    this.emit('route', p.id, '');
    if (![...this._peers.values()].some((x) => x.state !== 'idle')) this.engine.release();
  }

  /** 通道全关了以后，过一阵没人用就断开 */
  _touch(peerId) {
    const p = this._peers.get(peerId);
    if (!p || p.state !== 'connected') return;
    clearTimeout(p.idle);
    if ([...this._links.values()].some((l) => l.peerId === peerId)) return;
    p.idle = setTimeout(() => this._closePeer(p, true), IDLE_MS);
    p.idle.unref?.();
  }

  _onPresence(status) {
    for (const d of status.peers || []) {
      const was = this._online.get(d.id);
      this._online.set(d.id, d.online);
      // 对方重新上线（升级了、换了网络）就把“上次没成”的记忆清掉，马上可以再试
      if (d.online && was === false) { const p = this._peers.get(d.id); if (p) { p.retryAt = 0; p.fails = 0; } }
    }
  }

  // ---------- 信令 ----------

  /** 同一台设备的信令按顺序发；排队中的候选地址合并成一条 */
  _signal(p, type, sid, data) {
    return new Promise((resolve, reject) => {
      p.outbox.push({ type, sid, data, resolve, reject });
      this._flush(p);
    });
  }

  async _flush(p) {
    if (p.sending) return;
    p.sending = true;
    while (p.outbox.length) {
      const batch = [p.outbox.shift()];
      if (batch[0].type === 'cand') {
        while (p.outbox[0]?.type === 'cand' && p.outbox[0].sid === batch[0].sid) batch.push(p.outbox.shift());
      }
      const first = batch[0];
      const data = first.type === 'cand' ? batch.map((x) => x.data) : first.data;
      try {
        const me = this.identity();
        if (!me) throw new Error('本机没有设备密钥');
        const payload = JSON.stringify({ w2m: 'p2p', v: 1, from: me.deviceId, to: p.id, ts: Date.now(), sid: first.sid, type: first.type, data });
        await this.relay.sendRpc(p.id, payload, signText(payload, me.privateKey));
        for (const x of batch) x.resolve();
      } catch (e) {
        for (const x of batch) x.reject(e);
      }
    }
    p.sending = false;
  }

  _onSignal(msg) {
    let s;
    try { s = JSON.parse(msg.payload); } catch { return; }
    if (!s || s.w2m !== 'p2p' || s.v !== 1 || typeof s.type !== 'string') return; // 不是直连信令（比如远程控制请求）
    const me = this.identity();
    if (!me || s.to !== me.deviceId || s.from !== msg.from || typeof s.from !== 'string') return;
    if (!Number.isFinite(s.ts) || Math.abs(Date.now() - s.ts) > CLOCK_SKEW_MS) return;
    const key = this.peerKey(s.from);
    if (!key || !verifyText(msg.payload, msg.sig, key)) {
      this.emit('warn', new Error(`丢弃了一条签名不对的直连信令（来自 ${s.from}）`));
      return;
    }
    const p = this._peer(s.from);
    const fail = (e) => this.emit('warn', e);

    if (s.type === 'want' || s.type === 'offer') {
      if (!this.enabled()) { this._signal(p, 'no', s.sid || '', null).catch(() => {}); return; }
    }
    if (s.type === 'want') {
      if (!(me.deviceId < p.id)) return;
      if (p.state === 'connecting') return;                         // 已经在发起了
      if (p.state === 'connected') {
        if (p.connectedAt >= s.ts) return;                          // 这条请求比现有连接还旧
        this._closePeer(p, false);                                  // 对方那头的连接已经没了，重建
      }
      p.retryAt = 0;
      this._connect(p.id).catch(fail);
    } else if (s.type === 'offer') {
      if (me.deviceId < p.id || typeof s.sid !== 'string' || typeof s.data !== 'string') return;
      const incoming = { sid: s.sid, sdp: s.data };
      if (p.connecting && p.state === 'connecting' && !p.gotSignal) { this._answer(p, incoming).catch(fail); return; }
      if (p.state !== 'idle') this._closePeer(p, false);
      const start = () => this._connect(p.id, incoming).catch(fail);
      if (p.connecting) p.connecting.then(start, start); else start();
    } else if (s.type === 'answer') {
      if (s.sid !== p.sid || typeof s.data !== 'string') return;
      p.gotSignal = true;
      this.engine.send({ op: 'signal', peer: p.id, sid: p.sid, type: 'answer', data: s.data });
    } else if (s.type === 'cand') {
      if (s.sid !== p.sid || !Array.isArray(s.data)) return;
      for (const c of s.data.slice(0, 64)) this.engine.send({ op: 'signal', peer: p.id, sid: p.sid, type: 'cand', data: c });
    } else if (s.type === 'no') {
      p.wait?.reject(Object.assign(new Error('对方关闭了直连'), { unsupported: true }));
    } else if (s.type === 'bye') {
      if (s.sid && s.sid === p.sid) {
        if (p.wait) p.wait.reject(new Error('对方断开了直连'));
        else this._closePeer(p, false);
      }
    }
  }

  // ---------- 引擎事件 ----------

  _onEngine(evt) {
    if (evt.ev === 'down') {
      for (const p of this._peers.values()) {
        if (p.wait) p.wait.reject(new Error('直连组件意外退出'));
        else if (p.state !== 'idle') this._closePeer(p, true);
      }
      return;
    }
    if (evt.ev === 'diag') { this.emit('diag', evt.peer, String(evt.text)); return; }
    if (evt.ev === 'signal' || evt.ev === 'peer-up' || evt.ev === 'peer-down' || evt.ev === 'link-in') {
      const p = this._peers.get(evt.peer);
      if (!p || (evt.ev !== 'link-in' && evt.sid !== p.sid)) return;
      if (evt.ev === 'signal') this._signal(p, evt.type, evt.sid, evt.data).catch(() => {});
      else if (evt.ev === 'peer-up') {
        p.route = evt.route || 'wan';
        p.info = evt.info;
        this.emit('diag', p.id, `已连上：${JSON.stringify(evt.info)}`);
        p.wait?.resolve();
      }
      else if (evt.ev === 'peer-down') {
        if (p.wait) p.wait.reject(new Error('两边的网络没能直接打通'));
        else this._closePeer(p, true);
      } else if (p.state === 'connected' || p.state === 'connecting') {
        const link = new Link(this, evt.link, p.id, p.route);
        this._links.set(link.id, link);
        clearTimeout(p.idle);
        if (this.enabled() && this.listenerCount('link')) this.emit('link', link, p.id);
        else link.close();
      }
      return;
    }
    const link = this._links.get(evt.link);
    if (!link) return;
    if (evt.ev === 'link-open') link._open?.resolve();
    else if (evt.ev === 'link-sent') { const w = link._pending.get(evt.seq); link._pending.delete(evt.seq); w?.resolve(); }
    else if (evt.ev === 'link-close') link._closed();
    else if (evt.ev === 'link-msg') {
      const d = evt.data;
      link.emit('message', typeof d === 'string' ? d : Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength));
    }
  }
}

module.exports = { DirectHub, Link, resolveStun, isBogusIp, resolveOverHttps, DEFAULT_STUN };
