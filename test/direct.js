'use strict';
// 直连传输的协议测试：本地起一个中转服务，几个 Relay 之间用内存里的假通道代替真正的打洞。
// 验证的是“先直连、不行再走中转、不重复、能取消”这套逻辑；真正的 WebRTC 打洞见 test/p2p-smoke.js。
// 用法：node test/direct.js

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Relay } = require('../app/src/core.js');

const PORT = 18796;
const TOKEN = crypto.randomBytes(24).toString('hex');
const SERVER = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = async (p) => crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex');

function startServer(data) {
  const child = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
    env: { ...process.env, W2M_HOST: '127.0.0.1', W2M_PORT: PORT, W2M_TOKEN: TOKEN, W2M_DATA: data },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

function waitFor(emitter, event, pred = () => true, ms = 20e3) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.off(event, on); reject(new Error(`等待 ${event} 超时`)); }, ms);
    const on = (...args) => { if (pred(...args)) { clearTimeout(t); emitter.off(event, on); resolve(args); } };
    emitter.on(event, on);
  });
}

// ---------- 内存里的假直连 ----------

class FakeLink extends EventEmitter {
  constructor(net) { super(); this.net = net; this.closed = false; this.other = null; this._q = Promise.resolve(); this.bytes = 0; }
  send(data) {
    if (this.closed) return Promise.reject(new Error('直连已断开'));
    const copy = typeof data === 'string' ? data : Buffer.from(data);
    if (typeof data !== 'string') {
      this.bytes += data.length;
      this.net.bytes += data.length;
      if (this.net.breakAfter && this.net.bytes >= this.net.breakAfter) { this.net.breakAfter = 0; this._break(); return Promise.reject(new Error('直连已断开')); }
    }
    if (this.net.stall && typeof data !== 'string') {
      // 通道堵死：数据发不出去，也不报错，只有关掉通道才会结束
      return new Promise((_, reject) => this.once('close', () => reject(new Error('直连已断开'))));
    }
    const other = this.other;
    this._q = this._q.then(() => new Promise(setImmediate)).then(() => { if (!other.closed) other.emit('message', copy); });
    return this._q;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    const other = this.other;
    this._q.then(() => { if (!other.closed) { other.closed = true; other.emit('close'); } });
  }
  _break() { for (const l of [this, this.other]) if (!l.closed) { l.closed = true; l.emit('close'); } }
}

class FakeNet {
  constructor() { this.nodes = new Map(); this.blocked = false; this.opens = 0; this.bytes = 0; this.breakAfter = 0; this.stall = false; this.penalized = []; }
  provider(id) {
    const net = this;
    const node = new EventEmitter();
    node.usable = (peer) => peer.online && net.nodes.has(peer.id);
    node.open = async (peerId) => {
      net.opens++;
      await sleep(5);
      const other = net.nodes.get(peerId);
      if (net.blocked || !other) throw new Error('两边的网络没能直接打通');
      const a = new FakeLink(net), b = new FakeLink(net);
      a.other = b; b.other = a;
      other.emit('link', b, id);
      return a;
    };
    node.penalize = (peerId) => net.penalized.push(peerId);
    node.dispose = () => net.nodes.delete(id);
    net.nodes.set(id, node);
    return node;
  }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'w2m-direct-'));
  const dirs = Object.fromEntries(['data', 'src', 'a', 'b', 'c'].map((n) => [n, path.join(root, n)]));
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });
  const srv = await startServer(dirs.data);
  const results = [];
  const step = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
    catch (e) { results.push(['FAIL', name]); console.log('FAIL', name, '\n   ', e.stack); }
  };

  const net = new FakeNet();
  const warns = [];
  const mk = (id, name, dl, direct = true) => {
    const r = new Relay({ server: SERVER, token: TOKEN, deviceId: id, deviceName: name, downloadDir: dl, publicKey: 'k-' + id, directStallMs: 1500 });
    if (direct) r.setDirect(net.provider(id));
    r.on('warn', (e) => warns.push(e.message));
    return r;
  };
  const A = mk('dev-aaaaaa', '家里Mac', dirs.a);
  const B = mk('dev-bbbbbb', '办公Win', dirs.b);
  let C = null;
  const relayItems = () => fs.readdirSync(path.join(dirs.data, 'blobs')).length;
  const listed = (dir) => fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  const settle = (r, out) => (out.state === 'active' ? waitFor(r, 'entry', (e) => e.id === out.id && e.state !== 'active') : null);

  const big = path.join(dirs.src, '大文件.bin');
  await fsp.writeFile(big, crypto.randomBytes(30 * 2 ** 20 + 4321));
  const folder = path.join(dirs.src, '资料夹');
  await fsp.mkdir(path.join(folder, '子目录', '空目录'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'a.txt'), 'hello');
  await fsp.writeFile(path.join(folder, '子目录', 'b.bin'), crypto.randomBytes(700 * 1024));
  await fsp.writeFile(path.join(folder, '空文件'), '');

  try {
    A.start(); B.start();
    await waitFor(A, 'status', (s) => s.peers.some((p) => p.online));
    await waitFor(B, 'status', (s) => s.peers.some((p) => p.online)).catch(() => {});

    await step('能认出被接管的 DNS 给的假地址', () => {
      const { isBogusIp } = require('../app/src/direct.js');
      for (const ip of ['198.18.3.143', '198.19.0.1', '28.0.0.236', '10.1.2.3', '172.20.1.1', '192.168.1.1', '100.64.0.1', '0.0.1.1', '224.0.0.1', 'not-an-ip']) assert.ok(isBogusIp(ip), ip);
      for (const ip of ['111.206.174.3', '106.13.249.54', '162.159.207.0', '198.20.0.1', '172.32.1.1', '100.128.0.1', '223.5.5.5', '2.0.0.1']) assert.ok(!isBogusIp(ip), ip);
    });

    await step('两端在线：大文件直连送达，不经过中转', async () => {
      const receipts = [];
      A.on('delivered', (r) => receipts.push(r));
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      const out = A.sendPaths([big]);
      const [entry] = await got;
      assert.equal(entry.via, 'direct');
      assert.equal(entry.peer, '家里Mac');
      assert.equal(await sha(entry.paths[0]), await sha(big));
      await settle(A, out);
      assert.equal(out.state, 'done');
      assert.equal(out.via, 'direct');
      assert.equal(out.done, out.total);
      assert.deepEqual(receipts.map((r) => [r.id, r.by]), [[out.remoteId, 'dev-bbbbbb']]);
      assert.equal(relayItems(), 0, '中转上不应有暂存');
      assert.deepEqual(listed(dirs.b), ['大文件.bin']);
    });

    await step('文件夹（含空目录、空文件）直连后结构一致；同名不覆盖', async () => {
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      const out = A.sendPaths([folder, big]);
      const [entry] = await got;
      await settle(A, out);
      assert.equal(entry.via, 'direct');
      assert.equal(await fsp.readFile(path.join(dirs.b, '资料夹', 'a.txt'), 'utf8'), 'hello');
      assert.equal(await sha(path.join(dirs.b, '资料夹', '子目录', 'b.bin')), await sha(path.join(folder, '子目录', 'b.bin')));
      assert.ok(fs.statSync(path.join(dirs.b, '资料夹', '子目录', '空目录')).isDirectory());
      assert.equal(fs.statSync(path.join(dirs.b, '资料夹', '空文件')).size, 0);
      assert.ok(fs.existsSync(path.join(dirs.b, '大文件 (2).bin')));
      assert.equal(relayItems(), 0);
    });

    await step('小文件不去打洞，直接走中转', async () => {
      const small = path.join(dirs.src, 'small.txt');
      await fsp.writeFile(small, 'tiny');
      const before = net.opens;
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      A.sendPaths([small]);
      const [entry] = await got;
      assert.equal(entry.via, 'relay');
      assert.equal(net.opens, before);
    });

    await step('打不通时自动改走中转', async () => {
      net.blocked = true;
      warns.length = 0;
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      const out = A.sendPaths([big]);
      const [entry] = await got;
      net.blocked = false;
      assert.equal(entry.via, 'relay');
      assert.equal(await sha(entry.paths[0]), await sha(big));
      await settle(A, out);
      assert.equal(out.state, 'done');
      assert.equal(out.via, 'relay');
      assert.ok(warns.some((w) => w.includes('改走中转')), '应说明原因');
    });

    await step('直连传到一半断开：改走中转，接收方只有一条记录、一份文件', async () => {
      await fsp.rm(dirs.b, { recursive: true, force: true });
      const seen = new Map();
      const onEntry = (e) => { if (e.dir === 'in') seen.set(e.id, [...(seen.get(e.id) || []), `${e.state}/${e.via}`]); };
      B.on('entry', onEntry);
      net.bytes = 0;
      net.breakAfter = 6 * 2 ** 20;
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      const out = A.sendPaths([big]);
      const [entry] = await got;
      B.off('entry', onEntry);
      await settle(A, out);
      assert.equal(out.state, 'done');
      assert.equal(seen.size, 1, '应只有一条接收记录');
      const states = [...new Set(seen.get(entry.id))];
      assert.ok(states.includes('error/direct') && states.includes('done/relay'), states.join(','));
      assert.deepEqual(listed(dirs.b), ['大文件.bin']);
      assert.equal(await sha(entry.paths[0]), await sha(big));
    });

    await step('接收方中途取消：发送方记为拒收，不再从中转补发', async () => {
      await fsp.rm(dirs.b, { recursive: true, force: true });
      const declined = waitFor(A, 'declined');
      const cancelOnce = (e) => { if (e.dir === 'in' && e.state === 'active' && e.done > 0) { B.off('entry', cancelOnce); B.cancel(e.id); } };
      B.on('entry', cancelOnce);
      const out = A.sendPaths([big]);
      const [receipt] = await declined;
      assert.equal(receipt.by, 'dev-bbbbbb');
      await settle(A, out);
      assert.equal(out.state, 'done');
      await sleep(300);
      assert.equal(relayItems(), 0, '不应改走中转');
      assert.deepEqual(listed(dirs.b), []);
    });

    await step('发送方中途取消：对方记录变为已取消，不留文件', async () => {
      const canceled = waitFor(B, 'entry', (e) => e.dir === 'in' && e.state === 'canceled');
      const cancelOnce = (e) => { if (e.dir === 'out' && e.state === 'active' && e.done > 0) { A.off('entry', cancelOnce); A.cancel(e.id); } };
      A.on('entry', cancelOnce);
      const out = A.sendPaths([big]);
      await canceled;
      await settle(A, out);
      assert.equal(out.state, 'canceled');
      await sleep(300);
      assert.equal(relayItems(), 0);
      assert.deepEqual(listed(dirs.b), []);
    });

    await step('连上了却传不动：超时后改走中转，并让这条连接歇一阵', async () => {
      net.stall = true;
      net.penalized.length = 0;
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      const t0 = Date.now();
      const out = A.sendPaths([big]);
      const [entry] = await got;
      net.stall = false;
      await settle(A, out);
      assert.equal(out.state, 'done');
      assert.equal(entry.via, 'relay');
      assert.ok(Date.now() - t0 < 15e3, '不应长时间干等');
      assert.deepEqual(net.penalized, ['dev-bbbbbb']);
      assert.deepEqual(listed(dirs.b), ['大文件.bin']);
      await fsp.rm(dirs.b, { recursive: true, force: true });
    });

    await step('通道堵死时取消也能立刻生效', async () => {
      net.stall = true;
      const out = A.sendPaths([big]);
      await waitFor(B, 'entry', (e) => e.dir === 'in' && e.state === 'active');
      const t0 = Date.now();
      A.cancel(out.id);
      await settle(A, out);
      net.stall = false;
      assert.equal(out.state, 'canceled');
      assert.ok(Date.now() - t0 < 1000, '取消应立刻生效');
      await waitFor(B, 'entry', (e) => e.dir === 'in' && e.state !== 'active', 5e3).catch(() => {});
      await sleep(300);
      assert.equal(relayItems(), 0);
      assert.deepEqual(listed(dirs.b), []);
    });

    await step('第三台设备离线：在线的直连收到，离线的上线后从中转收到，谁都不重复', async () => {
      // 先让中转认识第三台设备，再让它下线
      C = mk('dev-cccccc', '笔记本', dirs.c, false);
      C.start();
      await waitFor(A, 'status', (s) => s.peers.filter((p) => p.online).length === 2);
      C.stop();
      await waitFor(A, 'status', (s) => s.peers.filter((p) => p.online).length === 1);

      const receipts = [];
      const onReceipt = (r) => receipts.push(r.by);
      A.on('delivered', onReceipt);
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      const out = A.sendPaths([big]);
      const [entry] = await got;
      assert.equal(entry.via, 'direct');
      await settle(A, out);
      assert.equal(out.state, 'done');
      assert.equal(relayItems(), 1, '给离线设备的那份应暂存在中转');

      const gotC = waitFor(C, 'received', (e) => e.kind === 'files');
      C.start();
      const [entryC] = await gotC;
      assert.equal(await sha(entryC.paths[0]), await sha(big));
      await waitFor(A, 'delivered', (r) => r.by === 'dev-cccccc', 5e3).catch(() => {});
      await sleep(500);
      A.off('delivered', onReceipt);
      assert.deepEqual(listed(dirs.b), ['大文件.bin'], '已直连收到的设备不应再收一份');
      assert.deepEqual([...new Set(receipts)].sort(), ['dev-bbbbbb', 'dev-cccccc']);
      assert.equal(relayItems(), 0, '都收完后中转应清空');
    });
  } finally {
    for (const r of [A, B, C]) if (r) { r.stop(); r._destroyAgents(); }
    const exited = new Promise((resolve) => srv.once('exit', resolve));
    srv.kill();
    await exited;
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
