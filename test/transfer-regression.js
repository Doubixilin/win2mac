'use strict';
// 只在临时目录和本机回环地址验证收发边界。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { Relay } = require('../app/src/core');

async function receiver(t, payloads = [], withReceipts = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'win2mac-receive-'));
  const relay = new Relay({ downloadDir: dir, receiptFile: withReceipts ? path.join(dir, 'receipts.json') : undefined });
  const acks = [];
  relay._download = (_, __, i, ___, part) => fs.writeFile(part, payloads[i]);
  relay._json = async (method, route, body) => { acks.push({ method, route, body }); return {}; };
  t.after(async () => { relay.retire(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, relay, acks };
}

function manifest(names, dirs = []) {
  return { id: 'fixture-item', kind: 'files', fromName: '测试机', createdAt: Date.now(), total: names.length,
    files: names.map((rel) => ({ rel, size: 1 })), dirs };
}

test('等待建连时取消立即放行发送队列，迟到的通道直接关闭', { timeout: 2000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'win2mac-cancel-open-'));
  const relay = new Relay({ receiptFile: path.join(dir, 'receipts.json'), directMin: 1 });
  t.after(async () => { relay.retire(); await fs.rm(dir, { recursive: true, force: true }); });
  const sent = [];
  relay._json = async (_method, _url, body) => { sent.push(body.kind); return { id: 'fixture-item' }; };
  const provider = new EventEmitter();
  let finishOpen;
  provider.usable = () => true;
  provider.open = () => new Promise((resolve) => {
    finishOpen = resolve;
    provider.emit('opening');
  });
  relay.setDirect(provider);
  relay.devices = [{ id: 'other-device', online: true, batchReceipts: true }];
  relay.connected = true;
  const opening = once(provider, 'opening');
  const file = relay.sendPaths([__filename]);
  const next = relay.sendText('next');
  await opening;
  relay.cancel(file.id);
  await relay._outQ;
  assert.equal(file.state, 'canceled');
  assert.equal(next.state, 'done');
  assert.deepEqual(sent, ['text']);

  const calls = [];
  finishOpen({ close: () => calls.push('close'), send: () => calls.push('send') });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['close']);
});

test('同一批次各级目录及文件名转换碰撞时，所有内容均独立保存', async (t) => {
  const { dir, relay } = await receiver(t, ['1', '2', '3', '4', '5']);
  const item = manifest(['图?.txt', '图*.txt', '夹?/子?/稿?.txt', '夹?/子?/稿*.txt', '夹*/子?/稿?.txt'], ['夹?/子*', '夹*/空']);
  await fs.writeFile(path.join(dir, '图_.txt'), 'existing');
  await fs.writeFile(path.join(dir, '图_ (2).txt.w2mpart'), 'keep');
  const received = once(relay, 'received');
  await relay._receive(item);
  const [entry] = await received;
  assert.equal(entry.state, 'done');
  const expected = {
    '图_.txt': 'existing', '图_ (2).txt': '1', '图_ (3).txt': '2', '图_ (2).txt.w2mpart': 'keep',
    '夹_/子_/稿_.txt': '3', '夹_/子_/稿_ (2).txt': '4', '夹_ (2)/子_/稿_.txt': '5',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), value);
  assert.ok((await fs.stat(path.join(dir, '夹_/子_ (2)'))).isDirectory());
  assert.ok((await fs.stat(path.join(dir, '夹_ (2)/空'))).isDirectory());
  assert.equal(entry.paths.length, 4);
  assert.ok(!(await fs.readdir(dir)).some((n) => n.startsWith('.win2mac-')));
});

test('批次取消会清理暂存，只发送拒收回执并保留用户同名文件', async (t) => {
  const { dir, relay, acks } = await receiver(t, ['a', 'b']);
  const keep = path.join(dir, 'second.w2mpart');
  await fs.writeFile(keep, 'user');
  const download = relay._download;
  relay._download = async (entry, rid, idx, ...args) => {
    await download(entry, rid, idx, ...args);
    if (idx === 1) relay.cancel(entry.id);
  };
  let received = false;
  let terminal;
  relay.on('received', () => { received = true; });
  relay.on('entry', (entry) => { if (entry.state !== 'active') terminal = entry; });
  await relay._receive(manifest(['first', 'second']));
  assert.equal(terminal.state, 'canceled');
  assert.equal(received, false);
  assert.deepEqual(acks, [{ method: 'POST', route: '/api/items/fixture-item/decline', body: undefined }]);
  assert.deepEqual(await fs.readdir(dir), ['second.w2mpart']);
  assert.equal(await fs.readFile(keep, 'utf8'), 'user');

  const events = [];
  relay.on('declined', (r) => events.push(['declined', r.by]));
  relay.on('delivered', (r) => events.push(['delivered', r.by]));
  relay._onEvent('declined', { id: 'fixture-item', by: 'receiver-one' });
  relay._onEvent('delivered', { id: 'fixture-item', by: 'receiver-two' });
  assert.deepEqual(events, [['declined', 'receiver-one'], ['delivered', 'receiver-two']]);
});

test('并发接收同名文件和目录时，两个任务均保留各自内容', async (t) => {
  const { dir, relay } = await receiver(t);
  relay._download = (_, id, __, ___, part) => fs.writeFile(part, id);
  const item = manifest(['test.txt', 'test/nested']);
  const results = [];
  relay.on('received', (e) => results.push(e));
  await Promise.all(['a', 'b'].map((id) => relay._receive({ ...item, id })));
  assert.equal(results.length, 2);
  for (const entry of results) {
    assert.equal(await fs.readFile(entry.paths[0], 'utf8'), entry.remoteId);
    assert.equal(await fs.readFile(path.join(entry.paths[1], 'nested'), 'utf8'), entry.remoteId);
  }
  assert.equal((await fs.readdir(dir)).length, 4);
});

test('定向文件必须通过摘要校验，覆盖需要显式同意，竞争写入只允许一个获胜', async (t) => {
  const { dir, relay, acks } = await receiver(t, ['new']);
  const dest = path.join(dir, 'target');
  await fs.writeFile(dest, 'old');
  await fs.writeFile(dest + '.w2mpart', 'unrelated');
  const sha256 = crypto.createHash('sha256').update('new').digest('hex');
  const save = (opts, target = dest) => relay.downloadDirect('fake-item', 3, target, opts);
  await assert.rejects(save({ overwrite: true }), /SHA-256/);
  await assert.rejects(save({ overwrite: true, sha256: '0'.repeat(64) }), /SHA-256/);
  await assert.rejects(save({ sha256 }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(dest, 'utf8'), 'old');
  assert.equal(await fs.readFile(dest + '.w2mpart', 'utf8'), 'unrelated');
  assert.equal(acks.length, 0);
  await save({ overwrite: true, sha256 });
  assert.equal(await fs.readFile(dest, 'utf8'), 'new');
  const race = path.join(dir, 'race');
  const results = await Promise.allSettled([save({ sha256 }, race), save({ sha256 }, race)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'EEXIST');
  assert.equal(acks.length, 2);
  assert.equal(await fs.readFile(race, 'utf8'), 'new');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['race', 'target', 'target.w2mpart']);
});

test('更换配对后中止旧连接的在途及排队请求，新配对仅发送新内容', async (t) => {
  const received = { old: [], fresh: [] };
  async function endpoint(group) {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = JSON.parse(Buffer.concat(chunks)).text;
      received[group].push(text);
      server.emit('item', text);
      if (group === 'fresh') res.end(JSON.stringify({ id: 'new-item' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return server;
  }
  const oldServer = await endpoint('old'), newServer = await endpoint('fresh');
  const connect = (server, token) => new Relay({ server: 'http://127.0.0.1:' + server.address().port, token, deviceId: 'test-device' });
  const old = connect(oldServer, 'old-secret');
  const firstArrival = once(oldServer, 'item');
  const active = old.sendText('first'), queued = old.sendText('queued');
  await firstArrival;
  old.retire();
  const fresh = connect(newServer, 'new-secret');
  t.after(() => fresh.retire());
  const sent = fresh.sendText('new');
  await Promise.all([old._outQ, fresh._outQ]);
  assert.equal(active.state, 'error');
  assert.equal(queued.state, 'error');
  assert.match(queued.error, /配对已切换/);
  assert.equal(sent.state, 'done');
  assert.deepEqual(received, { old: ['first'], fresh: ['new'] });
});

test('同一批次同时重投仅发布一次，同编号来自另一设备仍正常接收', async (t) => {
  const { dir, relay, acks } = await receiver(t, ['x'], true);
  const received = [];
  relay.on('received', e => received.push(e.id));
  const item = { ...manifest(['并发.txt']), batchId: 'batch-one', from: 'device-one' };
  await Promise.all(['first', 'replay'].map(id => relay._receive({ ...item, id })));
  assert.equal(received.length, 1);
  assert.equal(acks.length, 2);
  await relay._receive({ ...item, id: 'another', from: 'device-two' });
  assert.equal(received.length, 2);
  assert.equal(await fs.readFile(path.join(dir, '并发 (2).txt'), 'utf8'), 'x');
});

test('切回同一配对时旧实例收尾不会覆盖新实例的回执', async (t) => {
  const { dir, relay, acks } = await receiver(t, ['x'], true);
  const next = new Relay(relay.opts);
  t.after(() => next.retire());
  next._download = relay._download;
  next._json = relay._json;
  const item = { ...manifest(['批次.txt']), from: 'device-one' };
  const old = { ...item, id: 'old-item', batchId: 'batch-old' };
  const fresh = { ...item, id: 'new-item', batchId: 'batch-new' };
  await relay._receive(old);
  await next._receive(fresh);
  await relay._receive({ ...old, id: 'last-item', batchId: 'batch-last' });
  // 再次打开账本时须同时保留三次结算。
  const reopened = new Relay(relay.opts);
  t.after(() => reopened.retire());
  reopened._json = relay._json;
  let downloads = 0;
  reopened._download = async (...args) => { downloads++; await relay._download(...args); };
  await reopened._receive(fresh);
  assert.equal(downloads, 0);
  assert.equal(acks.length, 4);
  assert.equal((await fs.readdir(dir)).filter(n => n.endsWith('.txt')).length, 3);
});

test('回执无法持久化时回滚本次发布，恢复后可补收', async (t) => {
  const { dir, relay, acks } = await receiver(t, ['x'], true);
  const item = { ...manifest(['原件.txt']), batchId: 'batch-one', from: 'device-one' };
  await fs.writeFile(path.join(dir, '原件.txt'), 'original');
  const native = require('node:fs');
  const rename = native.renameSync;
  let failed = false;
  t.mock.method(native, 'renameSync', (src, dest) => {
    if (!failed && dest === relay.opts.receiptFile && native.readFileSync(src, 'utf8').includes('delivered')) {
      failed = true;
      throw new Error('模拟发布完成时回执无法替换');
    }
    return rename(src, dest);
  });
  const received = [];
  relay.on('received', e => received.push(e));
  await relay._receive(item);
  assert.equal(received.length, 0);
  assert.equal(acks.length, 0);
  await assert.rejects(fs.access(path.join(dir, '原件 (2).txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(dir, '原件.txt'), 'utf8'), 'original');
  assert.equal(failed, true);
  await relay._receive(item);
  assert.equal(received.length, 1);
  assert.equal(acks.length, 1);
  assert.equal(await fs.readFile(received[0].paths[0], 'utf8'), 'x');
});

test('拒收时回执盘不可写，恢复后重投只补拒收回执', async (t) => {
  const { dir, relay, acks } = await receiver(t, ['x'], true);
  const item = { ...manifest(['拒收.txt']), from: 'device-one', batchId: 'batch-decline' };
  await fs.mkdir(relay.opts.receiptFile + '.tmp');
  relay.once('entry', e => relay.cancel(e.id));
  await relay._receive(item);
  await fs.rmdir(relay.opts.receiptFile + '.tmp');
  await relay._receive(item);
  assert.deepEqual(acks.map(a => a.route), ['/api/items/fixture-item/decline']);
  await assert.rejects(fs.access(path.join(dir, '拒收.txt')), { code: 'ENOENT' });
});

for (const mode of ['文件被占用', '身份未取得', '外部替换', '外部编辑']) {
  test(`回滚不完整（${mode}）保留目标，恢复后不重复发布或确认`, async (t) => {
    const { dir, relay, acks } = await receiver(t, ['x'], true);
    const name = '回滚.txt', target = path.join(dir, name);
    const item = { ...manifest([name]), batchId: 'batch-rollback', from: 'device-one' };
    const native = require('node:fs');
    const unavailable = () => Object.assign(new Error('暂时无法访问目标'), { code: 'EBUSY' });
    if (mode === '身份未取得') {
      const stat = fs.lstat;
      let first = true;
      t.mock.method(fs, 'lstat', async (p, opts) => {
        if (p === target && first) { first = false; throw unavailable(); }
        return stat(p, opts);
      });
    } else {
      const save = relay._receipts.save.bind(relay._receipts);
      t.mock.method(relay._receipts, 'save', (key, status) => {
        if (status !== 'delivered') return save(key, status);
        if (mode === '外部替换') native.unlinkSync(target);
        if (mode !== '文件被占用') native.writeFileSync(target, 'external');
        throw new Error('完成回执写入失败');
      });
      if (mode === '文件被占用') {
        const unlink = fs.unlink;
        t.mock.method(fs, 'unlink', async (p) => { if (p === target) throw unavailable(); return unlink(p); });
      }
    }
    const states = [];
    relay.on('entry', entry => states.push(entry));
    await relay._receive(item);
    assert.match(states.at(-1).error, /未能完整回滚/);
    assert.deepEqual(Object.values(JSON.parse(await fs.readFile(relay.opts.receiptFile, 'utf8'))), ['publishing']);
    const next = new Relay({ downloadDir: dir, receiptFile: relay.opts.receiptFile });
    t.after(() => next.retire());
    next._ack = relay._ack.bind(relay);
    next._download = relay._download;
    next.on('entry', entry => states.push(entry));
    await next._receive(item);
    assert.match(states.at(-1).error, /核对接收目录/);
    assert.deepEqual(acks, []);
    assert.deepEqual((await fs.readdir(dir)).filter(p => p.endsWith('.txt')), [name]);
    assert.equal(await fs.readFile(target, 'utf8'), mode.startsWith('外部') ? 'external' : 'x');
  });
}

for (const phase of ['publishing', 'delivered']) {
  test(`进程在 ${phase} 阶段强制退出，重投不会额外发布文件`, async (t) => {
    const { dir, relay, acks } = await receiver(t, ['x'], true);
    const item = { ...manifest(['中断.txt']), from: 'device-one', batchId: 'batch-kill' };
    const { spawnSync } = require('node:child_process');
    const crash = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const [core, dir, receiptFile, item, phase] = process.argv.slice(1);
      const { Relay } = require(core);
      const relay = new Relay({ downloadDir: dir, receiptFile });
      relay._download = (_, __, i, size, part) => fs.writeFile(part, 'x');
      const kill = () => process.kill(process.pid, 'SIGKILL');
      if (phase === 'publishing') {
        const stat = fs.lstat;
        fs.lstat = async (target, opts) => {
          const found = await stat(target, opts);
          if (target === path.join(dir, '中断.txt')) kill();
          return found;
        };
      } else relay.once('received', kill);
      relay._receive(JSON.parse(item));
    `, require.resolve('../app/src/core'), dir, relay.opts.receiptFile, JSON.stringify(item), phase],
    { encoding: 'utf8', timeout: 10000 });
    assert.ifError(crash.error);
    assert.ok(crash.signal === 'SIGKILL' || (process.platform === 'win32' && crash.status !== 0), crash.stderr);
    const states = [];
    relay.on('entry', entry => states.push(entry));
    await relay._receive(item);
    assert.deepEqual((await fs.readdir(dir)).filter(n => n.endsWith('.txt')), ['中断.txt']);
    assert.equal(await fs.readFile(path.join(dir, '中断.txt'), 'utf8'), 'x');
    if (phase === 'delivered') {
      assert.equal(states.length, 0);
      assert.equal(acks.length, 1);
    } else {
      assert.match(states.at(-1).error, /核对接收目录/);
      assert.equal(acks.length, 0);
    }
  });
}

test('旧中转不认识拒收时，不会改发正常回执', async (t) => {
  const { relay } = await receiver(t);
  const routes = [];
  relay._json = async (_, route) => {
    routes.push(route);
    throw Object.assign(new Error('not found'), { status: 404 });
  };
  await relay._ack('legacy-item', 'declined');
  assert.deepEqual(routes, ['/api/items/legacy-item/decline']);
});

test('旧中转未报告能力或旧对端不支持批次回执时，跳过直连', async (t) => {
  const { relay } = await receiver(t, [], true);
  const attempts = [];
  relay.direct = { usable: () => true };
  relay._sendDirect = async (_, peer) => { attempts.push(peer.id); return 'delivered'; };
  relay._onEvent('hello', { devices: [
    { id: 'old-relay', online: true },
    { id: 'old-client', online: true, batchReceipts: false },
    { id: 'new-client', online: true, batchReceipts: true },
  ] });
  await relay._deliverDirect({ total: 1024 * 1024 }, { files: [], dirs: [] }, false, 'fixture-batch');
  assert.deepEqual(attempts, ['new-client']);
});

test('小于默认分片的协商上限同时适用于中文清单和文件', async (t) => {
  const { relay, dir } = await receiver(t, [], true);
  relay._onEvent('hello', { devices: [{ id: 'sender', online: true, batchReceipts: true }] });
  const sender = new Relay({ deviceId: 'sender', directStallMs: 1000 });
  t.after(() => sender.retire());
  const tx = new EventEmitter(), rx = new EventEmitter();
  const close = () => {
    if (tx.closed) return;
    tx.closed = rx.closed = true;
    tx.emit('close');
    rx.emit('close');
  };
  for (const [link, other] of [[tx, rx], [rx, tx]]) {
    link.maxMessageSize = 79;
    link.close = close;
    link.send = async (data) => {
      assert.ok(Buffer.byteLength(data) <= link.maxMessageSize);
      other.emit('message', data);
    };
  }
  sender.direct = { open: async () => { relay._acceptDirect(rx, 'sender'); return tx; } };
  const bytes = crypto.randomBytes(1025);
  const source = path.join(dir, 'source.bin');
  await fs.writeFile(source, bytes);
  const dirs = Array.from({ length: 17 }, (_, i) => '目录-' + i + '-中文');
  const file = { rel: '中文.bin', abs: source, size: bytes.length };
  const outcome = await sender._sendDirect({ id: 'fixture', total: bytes.length }, { id: 'target' },
    { files: [file], dirs }, false, 'fixture-batch');
  assert.equal(outcome, 'delivered');
  assert.deepEqual(await fs.readFile(path.join(dir, file.rel)), bytes);
  assert.deepEqual((await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(), dirs.sort());
});

test('直连清单中断、长度不符或 UTF-8 不完整时不创建接收文件', { timeout: 2000 }, async (t) => {
  const { relay, dir } = await receiver(t);
  for (const [bytes, parts] of [
    [8 * 2 ** 20 + 1, []], [1, [Buffer.from('ab')]],
    [3, [Buffer.from('a'), null]], [2, [Buffer.from([0xe4, 0xb8])]],
  ]) {
    const link = new EventEmitter();
    const replies = [];
    link.send = async (text) => { if (!link.closed) replies.push(JSON.parse(text)); };
    const closed = new Promise(resolve => { link.close = resolve; });
    relay._acceptDirect(link, 'sender');
    link.emit('message', JSON.stringify({ t: 'offer-start', bytes }));
    for (const part of parts) {
      if (part === null) { link.closed = true; link.emit('close'); }
      else link.emit('message', part);
    }
    await closed;
    assert.deepEqual(replies.map((reply) => reply.t), link.closed ? [] : ['fail']);
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test('历史记录区分送达、拒收和混合回执，旧记录仍可显示', async () => {
  const vm = require('node:vm');
  const noop = () => {};
  const context = {
    document: { getElementById: () => ({ addEventListener: noop }) }, window: { addEventListener: noop },
    w2m: { on: noop, state: () => new Promise(noop) },
  };
  const ui = await fs.readFile(path.join(__dirname, '../app/src/ui/main.js'), 'utf8');
  vm.runInNewContext(ui, context);
  const label = (fields) => context.statusText({ state: 'done', dir: 'out', ...fields })[1];
  assert.equal(label({ delivered: true }), '已送达');
  const accept = { status: 'delivered', name: '设备甲' }, reject = { status: 'declined', name: '设备乙' };
  assert.equal(label({ receipts: [reject] }), '设备乙 已拒收');
  assert.equal(label({ receipts: [accept, reject] }), '已送达 设备甲，设备乙 已拒收');
});
