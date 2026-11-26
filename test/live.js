'use strict';
// 走真实的公网入口互传一次，顺便测速。用法：node test/live.js [文件大小MB]
// 服务器地址和口令取自 secrets/pair-code.txt（客户端“复制配对码”得到的那串），
// 或者环境变量 W2M_SERVER / W2M_TOKEN。结束后会把两台测试设备从服务器上移除。
// 注意：真实客户端在线时也会收到这些测试内容（文字会进它们的剪贴板）。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Relay } = require('../app/src/core.js');

function loadTarget() {
  if (process.env.W2M_SERVER && process.env.W2M_TOKEN) return { server: process.env.W2M_SERVER, token: process.env.W2M_TOKEN };
  const file = path.join(__dirname, '../secrets/pair-code.txt');
  if (!fs.existsSync(file)) { console.error('请设置 W2M_SERVER 和 W2M_TOKEN，或把配对码存到 secrets/pair-code.txt'); process.exit(2); }
  const o = JSON.parse(Buffer.from(fs.readFileSync(file, 'utf8').trim().replace(/^w2m:/, ''), 'base64url').toString('utf8'));
  return { server: o.s, token: o.t };
}
const { server: SERVER, token: TOKEN } = loadTarget();
const MB = Number(process.argv[2] || 10);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-live-'));
const once = (em, ev, pred = () => true, ms = 300e3) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('超时 ' + ev)), ms);
  const on = (...a) => { if (pred(...a)) { clearTimeout(t); em.off(ev, on); res(a); } };
  em.on(ev, on);
});

(async () => {
  const A = new Relay({ server: SERVER, token: TOKEN, deviceId: 'livetest-a', deviceName: '测试A', downloadDir: path.join(root, 'a') });
  const B = new Relay({ server: SERVER, token: TOKEN, deviceId: 'livetest-b', deviceName: '测试B', downloadDir: path.join(root, 'b') });
  let code = 0;
  try {
    A.start(); B.start();
    await Promise.all([once(A, 'status', (s) => s.connected), once(B, 'status', (s) => s.connected)]);
    console.log('两端已连接');

    let t0 = Date.now();
    let got = once(B, 'received', (e) => e.kind === 'text');
    A.sendText('公网测试 ✓');
    console.log('文字送达:', JSON.stringify((await got)[0].text), `${Date.now() - t0} ms`);

    const src = path.join(root, `test-${MB}MB.bin`);
    fs.writeFileSync(src, crypto.randomBytes(MB * 2 ** 20));
    t0 = Date.now();
    got = once(B, 'received', (e) => e.kind === 'files');
    const out = A.sendPaths([src]);
    await once(A, 'entry', (e) => e.id === out.id && e.state !== 'active');
    if (out.state !== 'done') throw new Error('上传失败: ' + out.error);
    const tUp = (Date.now() - t0) / 1000;
    const [entry] = await got;
    const tAll = (Date.now() - t0) / 1000;
    const same = fs.readFileSync(entry.paths[0]).equals(fs.readFileSync(src));
    console.log(`${MB}MB 文件: 上传 ${tUp.toFixed(1)}s (${(MB / tUp).toFixed(1)} MB/s), 下载 ${(tAll - tUp).toFixed(1)}s (${(MB / Math.max(tAll - tUp, 0.01)).toFixed(1)} MB/s), 内容一致=${same}`);
    if (!same) code = 1;
  } catch (e) { console.error('失败:', e.message); code = 1; }
  A.stop(); B.stop();
  await new Promise((r) => setTimeout(r, 800));
  const C = new Relay({ server: SERVER, token: TOKEN, deviceId: 'ping-probe' });
  for (const id of ['livetest-a', 'livetest-b']) await C.removeDevice(id).then(() => console.log('已移除测试设备', id), (e) => console.log('移除失败', id, e.message));
  for (const r of [A, B, C]) r._destroyAgents();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(code);
})();
