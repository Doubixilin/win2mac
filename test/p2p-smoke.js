'use strict';
// 直连的真机测试：同一台电脑上启动两个真正的应用实例，让它们用 WebRTC 互相直连传文件。
// 两个实例在同一台机器上，走的是本机网卡之间的直连，验证的是打洞引擎、信令和传输这一整条链路。
// 用法：node test/p2p-smoke.js
// 会在系统凭据里临时存两把测试用的设备密钥，结束时删除。

const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateKeys } = require('../app/src/control');

const PORT = 18795;
const TOKEN = crypto.randomBytes(24).toString('hex');
const SERVER = `http://127.0.0.1:${PORT}`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-p2p-'));
const ELECTRON = require('../app/node_modules/electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await sleep(100);
  }
}

function instance(tag, deviceId, name, extra = {}) {
  const user = path.join(ROOT, tag, 'user'), recv = path.join(ROOT, tag, 'recv');
  fs.mkdirSync(user, { recursive: true });
  const keys = generateKeys();
  fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({
    server: SERVER, token: TOKEN, deviceId, deviceName: name, downloadDir: recv,
    keyPrivate: keys.privateKey, keyPublic: keys.publicKey,
    notify: false, hotkey: '', openAtLogin: false, showFloat: false, autoCopy: false, ...extra,
  }));
  const child = spawn(ELECTRON, [path.join(__dirname, 'p2p-peer.js'), '--hidden'], {
    env: { ...process.env, W2M_USER_DATA: user }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const log = [];
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => log.push(String(d)));
  const pending = new Map();
  let seq = 0, ready;
  const isReady = new Promise((resolve) => { ready = resolve; });
  child.on('message', (m) => {
    if (m.ready) return ready();
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  const call = (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.send({ id, cmd, ...args });
  });
  return { tag, deviceId, recv, child, call, isReady, log };
}

async function main() {
  const data = path.join(ROOT, 'data'), src = path.join(ROOT, 'src');
  for (const d of [data, src]) fs.mkdirSync(d, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
    env: { ...process.env, W2M_HOST: '127.0.0.1', W2M_PORT: PORT, W2M_TOKEN: TOKEN, W2M_DATA: data }, stdio: 'inherit',
  });
  const watchdog = setTimeout(() => { console.log('WATCHDOG: 测试超过 180 秒，强制退出'); process.exit(2); }, 180e3);
  const suffix = crypto.randomBytes(4).toString('hex');
  // 编号小的一方负责发起连接。先让编号大的一方发文件，把“请对方来发起”这条路也走到。
  const A = instance('a', `p2p-a-${suffix}`, '家里Mac');
  const B = instance('b', `p2p-b-${suffix}`, '办公Win');
  const results = [];
  const step = async (name, fn) => {
    try { await fn(); results.push(true); console.log('PASS', name); }
    catch (e) { results.push(false); console.log('FAIL', name, '\n   ', e.stack || e); }
  };
  const done = async (inst, id) => until(async () => (await inst.call('history')).find((e) => e.id === id && e.state !== 'active'), 60e3, '发送完成');
  const received = async (inst, name) => until(async () => (await inst.call('history')).find((e) => e.dir === 'in' && e.name === name && e.state !== 'active'), 60e3, `收到 ${name}`);
  const blobs = () => fs.readdirSync(path.join(data, 'blobs')).length;

  const big = path.join(src, 'big.bin');
  fs.writeFileSync(big, crypto.randomBytes(200 * 2 ** 20));
  const folder = path.join(src, '资料夹');
  fs.mkdirSync(path.join(folder, '子目录'), { recursive: true });
  fs.writeFileSync(path.join(folder, '子目录', 'b.bin'), crypto.randomBytes(3 * 2 ** 20));
  fs.writeFileSync(path.join(folder, 'a.txt'), '你好');

  try {
    await Promise.all([A.isReady, B.isReady]);
    await step('两个实例连上中转并互相看到在线', async () => {
      for (const inst of [A, B]) await until(async () => { const s = await inst.call('status'); return s.connected && s.peers.some((p) => p.online); }, 20e3, '互相在线');
    });

    await step('200MB 文件经 WebRTC 直连送达，内容一致，中转上没有暂存', async () => {
      const t0 = Date.now();
      const id = await B.call('send', { paths: [big] });
      const out = await done(B, id);
      const secs = (Date.now() - t0) / 1000;
      assert.equal(out.state, 'done', out.error);
      assert.equal(out.via, 'direct');
      const entry = await received(A, 'big.bin');
      assert.equal(entry.state, 'done');
      assert.equal(entry.via, 'direct');
      assert.equal(sha(entry.paths[0]), sha(big));
      assert.equal(blobs(), 0);
      assert.ok(out.receipts?.some((r) => r.by === A.deviceId && r.status === 'delivered'), '发送方应有送达回执');
      const { route, info } = (await B.call('status')).peers[0];
      console.log(`     含建立连接共 ${secs.toFixed(1)} 秒，约 ${(200 / secs).toFixed(0)} MB/s，线路：${route} ${JSON.stringify(info)}`);
      assert.ok(route, '应显示已直连');
    });

    await step('反方向复用已有连接传文件夹', async () => {
      const id = await A.call('send', { paths: [folder] });
      const out = await done(A, id);
      assert.equal(out.state, 'done', out.error);
      assert.equal(out.via, 'direct');
      const entry = await received(B, '资料夹');
      assert.equal(entry.via, 'direct');
      assert.equal(fs.readFileSync(path.join(B.recv, '资料夹', 'a.txt'), 'utf8'), '你好');
      assert.equal(sha(path.join(B.recv, '资料夹', '子目录', 'b.bin')), sha(path.join(folder, '子目录', 'b.bin')));
      assert.equal(blobs(), 0);
    });

    await step('复用直连发送超过 256 KiB 的中文目录清单', async () => {
      const name = '大清单';
      const source = path.join(src, name);
      fs.mkdirSync(source);
      const dirs = Array.from({ length: 1400 }, (_, i) => i + '-' + '目录'.repeat(32));
      for (const dir of dirs) fs.mkdirSync(path.join(source, dir));
      assert.ok(Buffer.byteLength(JSON.stringify(dirs.map((dir) => name + '/' + dir))) > 256 * 1024);
      const filename = '中文样本.bin';
      fs.writeFileSync(path.join(source, filename), crypto.randomBytes(300 * 1024));
      assert.ok((await A.call('status')).peers.find((peer) => peer.id === B.deviceId)?.route);
      const id = await A.call('send', { paths: [source] });
      const out = await done(A, id);
      assert.equal(out.state, 'done', out.error);
      assert.equal(out.via, 'direct');
      const entry = await received(B, name);
      assert.equal(entry.via, 'direct');
      const children = fs.readdirSync(entry.paths[0], { withFileTypes: true });
      assert.deepEqual(children.filter((child) => child.isDirectory()).map((child) => child.name).sort(), dirs.sort());
      assert.equal(sha(path.join(entry.paths[0], filename)), sha(path.join(source, filename)));
      assert.equal(blobs(), 0);
    });

    await step('一方在设置里关掉直连后，文件照常经中转送达', async () => {
      await A.call('config', { patch: { direct: false } });
      const id = await B.call('send', { paths: [folder] });
      const out = await done(B, id);
      assert.equal(out.state, 'done', out.error);
      assert.equal(out.via, 'relay');
      const entry = await until(async () => (await A.call('history')).find((e) => e.dir === 'in' && e.name === '资料夹' && e.state === 'done'), 30e3, '经中转收到');
      assert.equal(entry.via, 'relay');
    });
  } catch (e) {
    results.push(false);
    console.log('FATAL', e);
  } finally {
    clearTimeout(watchdog);
    for (const inst of [A, B]) {
      await Promise.race([inst.call('quit').catch(() => {}), sleep(3000)]);
      await Promise.race([new Promise((r) => inst.child.once('exit', r)), sleep(3000)]);
      if (inst.child.exitCode === null) inst.child.kill('SIGKILL');
    }
    srv.kill();
    const failed = results.filter((ok) => !ok).length;
    if (failed) for (const inst of [A, B]) console.log(`---- ${inst.tag} 的输出 ----\n${inst.log.join('').slice(-3000)}`);
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(`\n${results.length - failed}/${results.length} 通过`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
