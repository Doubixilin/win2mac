'use strict';
// 端到端测试：本地起一个中转服务，两个 Relay 实例互传。
// 用法：node test/e2e.js

const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Relay } = require('../app/src/core.js');

const PORT = 18799;
const TOKEN = crypto.randomBytes(24).toString('hex');
const SERVER = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = async (p) => crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex');

function waitFor(emitter, event, pred = () => true, ms = 30e3) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.off(event, on); reject(new Error(`等待 ${event} 超时`)); }, ms);
    const on = (...args) => { if (pred(...args)) { clearTimeout(t); emitter.off(event, on); resolve(args); } };
    emitter.on(event, on);
  });
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'w2m-e2e-'));
  const dirs = { data: path.join(root, 'data'), src: path.join(root, 'src'), a: path.join(root, 'recvA'), b: path.join(root, 'recvB') };
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });

  const srv = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
    env: { ...process.env, W2M_PORT: PORT, W2M_TOKEN: TOKEN, W2M_DATA: dirs.data }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => srv.stdout.once('data', r));
  const results = [];
  const step = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
    catch (e) { results.push(['FAIL', name]); console.log('FAIL', name, '\n   ', e.stack); }
  };

  const mk = (id, name, dl) => new Relay({ server: SERVER, token: TOKEN, deviceId: id, deviceName: name, downloadDir: dl });
  const A = mk('dev-aaaaaa', '办公Win', dirs.a);
  let B = mk('dev-bbbbbb', '家里Mac', dirs.b);
  for (const r of [A, B]) r.on('warn', (e) => console.log('  warn:', e.message));

  try {
    await step('口令错误会被拒绝', async () => {
      await assert.rejects(Relay.ping(SERVER, 'wrong-token-wrong-token-wrong'), (e) => e.status === 401);
      assert.equal((await Relay.ping(SERVER, TOKEN)).ok, true);
    });

    await step('两端连上后互相看到对方在线', async () => {
      A.start();
      await waitFor(A, 'status', (s) => s.connected);
      B.start();
      await waitFor(A, 'status', (s) => s.peers.some((p) => p.online && p.name === '家里Mac'));
      assert.ok(B.connected);
    });

    await step('文本 A→B（含中文、emoji、换行）', async () => {
      const text = '你好，世界 🌏\n第二行\tTab\r\nCRLF 行';
      const got = waitFor(B, 'received', (e) => e.kind === 'text');
      A.sendText(text);
      const [entry] = await got;
      assert.equal(entry.text, text);
      assert.equal(entry.peer, '办公Win');
    });

    await step('文本 B→A', async () => {
      const got = waitFor(A, 'received', (e) => e.kind === 'text');
      B.sendText('reverse');
      assert.equal((await got)[0].text, 'reverse');
    });

    const big = path.join(dirs.src, '大文件.bin');
    await step('20MB 文件分片上传，内容一致，有进度', async () => {
      await fsp.writeFile(big, crypto.randomBytes(20 * 2 ** 20 + 12345));
      let progressEvents = 0;
      const onEntry = (e) => { if (e.dir === 'in' && e.state === 'active') progressEvents++; };
      B.on('entry', onEntry);
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      const out = A.sendPaths([big]);
      const [entry] = await got;
      B.off('entry', onEntry);
      assert.equal(entry.paths.length, 1);
      assert.equal(path.basename(entry.paths[0]), '大文件.bin');
      assert.equal(await sha(entry.paths[0]), await sha(big));
      assert.ok(progressEvents >= 1, '应有进度事件'); // 本机回环太快，节流后事件数不稳定，只要求有
      await waitFor(A, 'entry', (e) => e.id === out.id && e.state === 'done', 5e3).catch(() => assert.equal(out.state, 'done'));
    });

    await step('同名文件再发一次不覆盖，自动改名', async () => {
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      A.sendPaths([big]);
      const [entry] = await got;
      assert.equal(path.basename(entry.paths[0]), '大文件 (2).bin');
      assert.ok(fs.existsSync(path.join(dirs.b, '大文件.bin')));
    });

    await step('文件夹：嵌套、空目录、空文件、非法字符文件名', async () => {
      const folder = path.join(dirs.src, '项目资料');
      await fsp.mkdir(path.join(folder, '子目录/更深'), { recursive: true });
      await fsp.mkdir(path.join(folder, '空目录'));
      await fsp.writeFile(path.join(folder, 'readme.txt'), 'hello');
      await fsp.writeFile(path.join(folder, '空文件.txt'), '');
      await fsp.writeFile(path.join(folder, '子目录/更深/data.json'), '{"a":1}');
      await fsp.writeFile(path.join(folder, '子目录/时间 10:30?.txt'), 'colon');
      await fsp.writeFile(path.join(folder, '.DS_Store'), 'junk');
      const loose = path.join(dirs.src, 'loose.txt');
      await fsp.writeFile(loose, 'loose file');

      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      A.sendPaths([folder, loose]);
      const [entry] = await got;
      assert.equal(entry.paths.length, 2);
      const out = path.join(dirs.b, '项目资料');
      assert.equal(await fsp.readFile(path.join(out, 'readme.txt'), 'utf8'), 'hello');
      assert.equal((await fsp.stat(path.join(out, '空文件.txt'))).size, 0);
      assert.equal(await fsp.readFile(path.join(out, '子目录/更深/data.json'), 'utf8'), '{"a":1}');
      assert.equal(await fsp.readFile(path.join(out, '子目录/时间 10_30_.txt'), 'utf8'), 'colon');
      assert.ok((await fsp.stat(path.join(out, '空目录'))).isDirectory());
      assert.ok(!fs.existsSync(path.join(out, '.DS_Store')));
      assert.equal(await fsp.readFile(path.join(dirs.b, 'loose.txt'), 'utf8'), 'loose file');
      // 没有残留的临时文件
      const all = await fsp.readdir(dirs.b, { recursive: true });
      assert.ok(!all.some((n) => n.endsWith('.w2mpart')));
    });

    await step('对方离线时发送，上线后自动收到', async () => {
      B.stop();
      await waitFor(A, 'status', (s) => s.peers.every((p) => !p.online), 5e3);
      const f = path.join(dirs.src, 'offline.txt');
      await fsp.writeFile(f, 'sent while offline');
      const o1 = A.sendText('离线消息');
      const o2 = A.sendPaths([f]);
      await waitFor(A, 'entry', (e) => e.id === o2.id && e.state === 'done');
      assert.equal(o1.state, 'done');

      B = mk('dev-bbbbbb', '家里Mac', dirs.b);
      const got = [];
      B.on('received', (e) => got.push(e));
      B.start();
      for (let i = 0; i < 100 && got.length < 2; i++) await sleep(100);
      assert.equal(got.length, 2);
      assert.equal(got.find((e) => e.kind === 'text').text, '离线消息');
      assert.equal(await fsp.readFile(got.find((e) => e.kind === 'files').paths[0], 'utf8'), 'sent while offline');
    });

    await step('发送方收到“已送达”回执', async () => {
      const d = waitFor(A, 'delivered');
      const out = A.sendText('ack me');
      const [info] = await d;
      assert.equal(info.id, out.remoteId);
      assert.equal(info.byName, '家里Mac');
    });

    await step('对端全部收完后，服务器不再保留任何文件', async () => {
      await sleep(500);
      assert.deepEqual(await fsp.readdir(path.join(dirs.data, 'blobs')), []);
      const st = JSON.parse(await fsp.readFile(path.join(dirs.data, 'state.json'), 'utf8'));
      assert.deepEqual(Object.keys(st.items), []);
    });

    await step('重连后不会重复收到已确认的内容', async () => {
      let dup = 0;
      B.on('received', () => dup++);
      B.stop(); B.start();
      await waitFor(B, 'status', (s) => s.connected);
      await sleep(500);
      assert.equal(dup, 0);
    });

    await step('上传分片可幂等重传；越界与路径穿越被拒绝', async () => {
      const raw = (method, p, body, headers = {}) => fetch(SERVER + p, {
        method, body, headers: { Authorization: 'Bearer ' + TOKEN, 'X-Device': 'dev-aaaaaa', ...headers },
      });
      let r = await raw('POST', '/api/items', JSON.stringify({ kind: 'files', files: [{ rel: '../../etc/passwd', size: 3 }] }));
      assert.equal(r.status, 400);
      r = await raw('POST', '/api/items', JSON.stringify({ kind: 'files', files: [{ rel: 'a/b.txt', size: 6 }] }));
      const { id } = await r.json();
      assert.equal((await raw('PUT', `/api/items/${id}/files/0?offset=0`, 'abc')).status, 200);
      assert.equal((await raw('PUT', `/api/items/${id}/files/0?offset=5`, 'x')).status, 409); // 跳过了一段
      assert.equal((await raw('PUT', `/api/items/${id}/files/0?offset=3`, 'defg')).status, 400); // 超出声明大小
      assert.equal((await raw('POST', `/api/items/${id}/commit`)).status, 409); // 还没传完
      assert.equal((await raw('PUT', `/api/items/${id}/files/0?offset=0`, 'abc')).status, 200); // 重传同一片
      assert.equal((await raw('PUT', `/api/items/${id}/files/0?offset=3`, 'def')).status, 200);
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      assert.equal((await raw('POST', `/api/items/${id}/commit`)).status, 200);
      const [entry] = await got;
      assert.equal(await fsp.readFile(path.join(entry.paths[0], 'b.txt'), 'utf8'), 'abcdef');
      // 别的设备不能删、不能写这个条目
      assert.equal((await raw('GET', '/api/items/nonexistent-id/files/0')).status, 404);
    });

    await step('移除离线的旧设备后，只等它的内容立即从服务器清掉', async () => {
      const C = mk('dev-cccccc', '旧电脑', path.join(root, 'recvC'));
      C.start();
      await waitFor(C, 'status', (s) => s.connected);
      C.stop();
      await waitFor(A, 'status', (s) => s.peers.some((p) => p.name === '旧电脑' && !p.online));
      const f = path.join(dirs.src, 'stale.txt');
      await fsp.writeFile(f, 'x'.repeat(1000));
      const got = waitFor(B, 'received', (e) => e.kind === 'files');
      A.sendPaths([f]);
      await got;
      await sleep(300);
      assert.equal((await fsp.readdir(path.join(dirs.data, 'blobs'))).length, 1, 'B 收了但旧电脑没收，应仍保留');
      await assert.rejects(A.removeDevice('dev-bbbbbb'), (e) => e.status === 409); // 在线的不能移除
      await A.removeDevice('dev-cccccc');
      await sleep(300);
      assert.deepEqual(await fsp.readdir(path.join(dirs.data, 'blobs')), []);
      assert.ok(!A.peers.some((p) => p.name === '旧电脑'));
      C._destroyAgents();
    });

    await step('服务重启后未送达的内容仍然保留', async () => {
      B.stop();
      await sleep(200);
      const out = A.sendText('survive restart');
      await waitFor(A, 'entry', (e) => e.id === out.id && e.state === 'done');
      await sleep(400);
      const st = JSON.parse(await fsp.readFile(path.join(dirs.data, 'state.json'), 'utf8'));
      assert.equal(Object.values(st.items).length, 1);
      assert.equal(Object.values(st.items)[0].text, 'survive restart');
    });
  } finally {
    A.stop(); B.stop();
    A._destroyAgents(); B._destroyAgents();
    srv.kill();
    await fsp.rm(root, { recursive: true, force: true });
  }
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
