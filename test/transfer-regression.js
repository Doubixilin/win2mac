'use strict';
// 只在临时目录和本机回环地址验证收发边界。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { Relay } = require('../app/src/core');

async function receiver(t, payloads = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'win2mac-receive-'));
  const relay = new Relay({ downloadDir: dir });
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
