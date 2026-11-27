'use strict';
// node --test test/direct-hub.js。两套 DirectHub 交换真实签名信令，窗口启动和 DNS 可独立延迟。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { setImmediate: tick, setTimeout: sleep } = require('node:timers/promises');
const { DirectHub } = require('../app/src/direct');
const { generateKeys, signText } = require('../app/src/control');

const ice = { iceServers: [], primary: [] };
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function pair(t) {
  const nodes = {};
  const signals = [];
  for (const id of ['a', 'b']) {
    const relay = new EventEmitter(), engine = new EventEmitter();
    const keys = generateKeys();
    const commands = [];
    relay.peers = [{ id: id === 'a' ? 'b' : 'a', online: true, batchReceipts: true }];
    engine.ready = async () => {};
    engine.release = () => {};
    engine.send = (cmd) => { commands.push(cmd); };
    relay.sendRpc = async (to, payload, sig) => {
      signals.push(JSON.parse(payload));
      await tick();
      nodes[to].relay.emit('rpc', { from: id, payload, sig });
    };
    const hub = new DirectHub({
      relay, engine, identity: () => ({ deviceId: id, privateKey: keys.privateKey }), peerKey: (peer) => nodes[peer].keys.publicKey,
    });
    hub._iceServers = async () => ice;
    nodes[id] = { id, relay, engine, keys, hub, commands };
  }
  t.after(() => { for (const n of Object.values(nodes)) n.hub.dispose(); });
  return { ...nodes, signals };
}

function signal(from, to, type, sid, data) {
  const payload = JSON.stringify({ w2m: 'p2p', v: 1, from: from.id, to: to.id, ts: Date.now(), sid, type, data });
  to.relay.emit('rpc', { from: from.id, payload, sig: signText(payload, from.keys.privateKey) });
}

function simulateRTC(node) {
  let currentSid;
  node.engine.send = (cmd) => {
    node.commands.push(cmd);
    const { peer, sid } = cmd;
    const emit = (event) => node.engine.emit('evt', { peer, sid, ...event });
    if (cmd.op === 'connect') {
      currentSid = sid;
      if (cmd.role === 'offer') {
        emit({ ev: 'signal', type: 'offer', data: 'offer-sdp' });
        emit({ ev: 'signal', type: 'cand', data: { candidate: 'candidate-1' } });
      }
    } else if (cmd.op === 'signal' && cmd.type === 'offer') {
      emit({ ev: 'signal', type: 'answer', data: 'answer-sdp' });
    } else if (cmd.op === 'signal' && (cmd.type === 'answer' || cmd.type === 'cand')) {
      emit({ ev: 'peer-up', route: 'lan' });
    } else if (cmd.op === 'open-link') {
      emit({ ev: 'link-open', sid: currentSid, link: cmd.link });
    }
  };
}

test('已声明批次回执的两端冷启动超过 6 秒，仍可握手并打开通道', { timeout: 18000 }, async (t) => {
  const { a, b } = pair(t);
  simulateRTC(a);
  simulateRTC(b);
  a.hub._iceServers = async () => { await sleep(3200); return ice; };
  b.engine.ready = () => sleep(6200);
  const link = await a.hub.open('b');
  assert.equal(link.route, 'lan');
  assert.equal(b.hub.routeOf('a'), 'lan');
  assert.deepEqual(b.commands.filter((c) => c.type === 'cand').map((c) => c.data.candidate), ['candidate-1']);
});

test('编号大的一端主动发送 want，复用同一轮握手', async (t) => {
  const { a, b, signals } = pair(t);
  simulateRTC(a);
  simulateRTC(b);
  assert.equal((await b.hub.open('a')).route, 'lan');
  const want = signals.find((s) => s.type === 'want');
  assert.ok(want.sid);
  assert.equal(a.commands.filter((cmd) => cmd.op === 'connect').length, 1);
  assert.equal(b.commands.filter((cmd) => cmd.op === 'connect').length, 1);
});

test('尚无能力声明时，签名的 want 或同会话候选能确认支持，无回应的旧端按时回退', { timeout: 12000 }, async (t) => {
  await Promise.all(['want', 'cand', 'silent'].map(async (response) => {
    const { a, b } = pair(t);
    a.relay.peers = [];
    b.hub.dispose();
    const opened = a.hub.open('b');
    const result = opened.then((link) => ({ link }), (error) => ({ error }));
    await tick();
    const { sid } = a.commands.find((c) => c.op === 'connect');
    const evt = (ev, fields) => a.engine.emit('evt', { ev, peer: 'b', sid, ...fields });
    evt('signal', { type: 'offer', data: 'offer-sdp' });
    if (response === 'want') signal(b, a, 'want', '', null);
    if (response === 'cand') signal(b, a, 'cand', sid, [{ candidate: 'candidate-1' }]);
    if (response === 'silent') {
      assert.equal((await result).error?.unsupported, true);
      return;
    }
    await sleep(6250);
    evt('peer-up', { route: 'lan' });
    await tick();
    const { link } = a.commands.find((c) => c.op === 'open-link');
    evt('link-open', { link });
    assert.equal((await result).link.route, 'lan');
  }));
});

test('接收 offer 后，等待窗口与 DNS 时抵达的候选按会话顺序交付', async (t) => {
  const { a, b } = pair(t);
  const window = gate(), dns = gate(), sid = 'current-offer';
  b.engine.ready = () => window.promise;
  b.hub._iceServers = () => dns.promise;
  signal(a, b, 'offer', sid, 'sdp');
  signal(a, b, 'cand', sid, ['before-ready']);
  window.release();
  await tick();
  signal(a, b, 'cand', 'other-offer', ['wrong-session']);
  signal(a, b, 'cand', sid, ['before-dns', 'another']);
  assert.equal(b.commands.length, 0);
  dns.release(ice);
  await tick();
  signal(a, b, 'cand', sid, ['after-setup']);
  assert.deepEqual(b.commands.map((c) => c.op === 'connect' ? c.op : c.data),
    ['connect', 'sdp', 'before-ready', 'before-dns', 'another', 'after-setup']);
});

for (const method of ['shutdown', 'dispose']) {
  test(`${method} 中止正在等待准备及正在开通道的请求`, { timeout: 2000 }, async (t) => {
    for (const stage of ['window', 'dns', 'open-link']) {
      const { a } = pair(t);
      const hold = gate();
      if (stage === 'window') a.engine.ready = () => hold.promise;
      if (stage === 'dns') a.hub._iceServers = () => hold.promise;
      const opened = a.hub.open('b');
      await tick();
      if (stage === 'open-link') {
        const { sid } = a.commands.find((c) => c.op === 'connect');
        a.engine.emit('evt', { ev: 'peer-up', peer: 'b', sid, route: 'lan' });
        await tick();
        assert.ok(a.commands.some((c) => c.op === 'open-link'));
      }
      a.hub[method]();
      await assert.rejects(opened, /已重置|已断开/);
      hold.release(ice);
      await tick();
      if (stage !== 'open-link') assert.deepEqual(a.commands, []);
      assert.equal(a.hub.routeOf('b'), '');
    }
  });
}

test('重连时忽略旧准备结果和旧引擎事件', async (t) => {
  const { a } = pair(t);
  const old = gate();
  a.hub._iceServers = () => old.promise;
  const first = a.hub.open('b');
  a.hub.shutdown();
  const ended = assert.rejects(first);
  a.hub._iceServers = async () => ice;
  const second = a.hub.open('b');
  old.release(ice);
  await ended;
  await tick();
  const connects = a.commands.filter((c) => c.op === 'connect');
  assert.equal(connects.length, 1);
  const sid = connects[0].sid;
  const evt = (ev, session, fields) => a.engine.emit('evt', { ev, peer: 'b', sid: session, ...fields });
  let incoming = 0;
  a.hub.on('link', () => incoming++);
  evt('peer-up', 'stale');
  evt('link-in', 'stale', { link: 'old-incoming' });
  await tick();
  assert.equal(incoming, 0);
  assert.ok(!a.commands.some((c) => c.op === 'open-link'));
  evt('peer-up', sid, { route: 'lan' });
  await tick();
  const { link } = a.commands.find((c) => c.op === 'open-link');
  let opened = false;
  second.then(() => { opened = true; });
  evt('link-open', 'stale', { link });
  evt('peer-down', 'stale');
  await tick();
  assert.equal(opened, false);
  evt('link-open', sid, { link });
  assert.equal((await second).route, 'lan');
});
