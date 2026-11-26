'use strict';
// 用一个临时“探针”设备向所有已配对设备发送指定文件/文件夹，等对方回执后把自己从服务器移除。
// 用法：node test/probe.js <config.json 路径> <core.js 路径> <要发送的路径...>
// config.json 就是客户端的配置文件（取其中的 server 和 token）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const [cfgPath, corePath, ...paths] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const { Relay } = require(path.resolve(corePath));
const id = 'probe-' + Math.random().toString(36).slice(2, 10);
const r = new Relay({ server: cfg.server, token: cfg.token, deviceId: id, deviceName: `探针@${os.hostname()}`, downloadDir: os.tmpdir() });
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));

(async () => {
  let code = 0;
  r.start();
  for (let i = 0; i < 100 && !r.connected; i++) await sleep(100);
  if (!r.connected) { console.log('连接失败', r.lastError); process.exit(1); }
  const peers = r.peers.filter((p) => p.online);
  console.log('在线设备:', peers.map((p) => p.name).join(', ') || '(无)');
  const acks = new Set();
  r.on('delivered', (d) => { acks.add(d.byName); console.log('已送达 →', d.byName); });
  const out = r.sendPaths(paths);
  for (let i = 0; i < 1200 && out.state === 'active'; i++) await sleep(100);
  console.log('上传:', out.state, out.error || '', `${out.fileCount || 0} 个文件, ${out.total} 字节`);
  if (out.state !== 'done') code = 1;
  for (let i = 0; i < 600 && acks.size < peers.length; i++) await sleep(100);
  if (acks.size < peers.length) { console.log('有设备未回执'); code = 1; }
  r.stop();
  await sleep(600);
  await r.removeDevice(id).then(() => console.log('探针设备已移除'), (e) => console.log('移除探针失败', e.message));
  r._destroyAgents();
  process.exit(code);
})();
