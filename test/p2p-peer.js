'use strict';
// test/p2p-smoke.js 启动的应用实例：加载真正的主进程，按父进程发来的指令操作并回报结果。

const { app } = require('electron');
const main = require('../app/src/main.js');

const handlers = {
  status: () => {
    const relay = main.relay;
    const st = relay.status();
    return { connected: st.connected, peers: st.peers.map((p) => ({ id: p.id, online: p.online, route: relay.direct?.routeOf(p.id) || '', info: relay.direct?.infoOf(p.id) })) };
  },
  history: () => main.history,
  send: ({ paths }) => main.relay.sendPaths(paths).id,
  config: ({ patch }) => main.applyConfig(patch),
  quit: () => {
    const { Entry } = require('../app/node_modules/@napi-rs/keyring');
    try { new Entry('com.doubilin.win2mac.signing', main.config.deviceId).deleteCredential(); } catch {}
    setTimeout(() => app.exit(0), 50);
    return true;
  },
};

process.on('message', async (msg) => {
  try { process.send({ id: msg.id, result: await handlers[msg.cmd](msg) }); }
  catch (e) { process.send({ id: msg.id, error: String(e.stack || e) }); }
});
process.on('disconnect', () => app.exit(0));
app.whenReady().then(() => process.send({ ready: true }));
