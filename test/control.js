'use strict';
// 远程控制与 MCP 的端到端测试：本地起中转服务，一端是被控主机，一端是控制端 / MCP 进程。
// 用法：node test/control.js

const { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Relay } = require('../app/src/core.js');
const { ControlHost, ControlClient, generateKeys, signText, fingerprint } = require('../app/src/control.js');

const PORT = 18797;
const TOKEN = crypto.randomBytes(24).toString('hex');
const SERVER = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = async (p) => crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex');
const rejectsWith = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}: ${e.message}`); return true; });

// 独立进程的被控宿主。应答和剪贴板都在内存中，只把去重记录写入测试目录。
async function replayFixture() {
  const { replayFile, request, hostKey, controllerKey } = JSON.parse(fs.readFileSync(0, 'utf8'));
  let writes = 0, response;
  const host = new ControlHost({
    replayFile,
    identity: () => ({ deviceId: 'fixture-host', privateKey: hostKey }),
    controllers: () => ({ 'fixture-controller': { key: controllerKey, level: 'full' } }),
    relay: { replyRpc: async (_, reply) => { response = JSON.parse(reply); } },
    extras: { clipboardWrite: () => { writes++; return { ok: true }; } },
  });
  await host._handle(request);
  process.stdout.write(JSON.stringify({ writes, error: response.error?.code || null }));
}

async function main() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'w2m-ctl-')));
  const dirs = { data: `${root}/data`, work: `${root}/目标机 工作区`, local: `${root}/local`, cfg: `${root}/cfg` };
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });

  const srv = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
    env: { ...process.env, W2M_PORT: PORT, W2M_TOKEN: TOKEN, W2M_DATA: dirs.data }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => srv.stdout.once('data', r));

  const results = [];
  const step = async (name, fn) => {
    try { await fn(); results.push(true); console.log('PASS', name); }
    catch (e) { results.push(false); console.log('FAIL', name, '\n   ', e.stack); }
  };

  // 被控主机（相当于办公 Win 上的 Win2Mac）
  const hostKeys = generateKeys();
  const HOST = 'host-win-0001', CTRL = 'ctrl-mac-0001';
  const controllers = {};
  const activity = [];
  const mkHost = (keys) => {
    const relay = new Relay({ server: SERVER, token: TOKEN, deviceId: HOST, deviceName: '办公 Win', downloadDir: `${root}/host-dl`, publicKey: keys.publicKey });
    const host = new ControlHost({
      relay, identity: () => ({ deviceId: HOST, privateKey: keys.privateKey }), controllers: () => controllers,
      replayFile: path.join(dirs.cfg, 'control-replay.json'),
      onActivity: (a) => activity.push(a),
      extras: {
        clipboardRead: async () => ({ text: '主机剪贴板', files: [], hasImage: false }),
        clipboardWrite: async ({ text }) => { controllers._clip = text; return { ok: true }; },
        screenshot: async () => ({ data: Buffer.from('fakejpeg').toString('base64'), mimeType: 'image/jpeg', width: 16, height: 9, index: 0, count: 1 }),
        open: async ({ target }) => ({ opened: target }),
      },
    }).attach();
    relay.on('warn', (e) => console.log('  host warn:', e.message));
    relay.start();
    return { relay, host };
  };
  let H = mkHost(hostKeys);

  // 控制端（相当于家里 Mac 上的 MCP 进程）
  const ctrlKeys = generateKeys();
  const mkClient = (keys, pins = 'pins.json') => new ControlClient({
    server: SERVER, token: TOKEN, deviceId: CTRL, deviceName: '家里 Mac', publicKey: keys.publicKey, privateKey: keys.privateKey, pinsFile: path.join(dirs.cfg, pins),
  }).start();
  const C = mkClient(ctrlKeys);
  const grant = (level) => { if (level) controllers[CTRL] = { name: '家里 Mac', key: ctrlKeys.publicKey, level }; else delete controllers[CTRL]; };

  try {
    await step('跨重启保留有效的副作用请求编号；损坏记录时停止写操作', async () => {
      const replayFile = path.join(dirs.work, 'replay-fixture.json');
      const openHost = () => new ControlHost({ replayFile });
      const ts = Date.now();
      // 只登记请求元数据，不执行这些操作。
      const first = { id: 'first', ts, method: 'fs.write' };
      const second = { id: 'second', ts, method: 'fs.sendVerified' };
      openHost()._rememberRequest(first, ts);
      openHost()._rememberRequest(second, ts);
      for (const req of [first, second]) {
        assert.throws(() => openHost()._rememberRequest(req, ts), { code: 'replay' });
      }
      await fsp.writeFile(replayFile, 'invalid fixture');
      assert.throws(() => openHost()._rememberRequest(first, ts), { code: 'replay-store' });
      assert.equal(await fsp.readFile(replayFile, 'utf8'), 'invalid fixture');
      await fsp.rm(replayFile);
    });

    await step('被控 Node 进程退出再启动后同一项剪贴板操作只执行一次', async () => {
      const payload = JSON.stringify({
        id: crypto.randomUUID(), from: 'fixture-controller', to: 'fixture-host', ts: Date.now(),
        method: 'clipboard.write', params: { text: 'test' },
      });
      const input = JSON.stringify({
        replayFile: path.join(dirs.cfg, 'restart-fixture.json'), hostKey: hostKeys.privateKey,
        controllerKey: ctrlKeys.publicKey, request: { payload, sig: signText(payload, ctrlKeys.privateKey) },
      });
      const start = () => JSON.parse(execFileSync(process.execPath, [__filename, '--replay-fixture'], { input, encoding: 'utf8' }));
      assert.deepEqual(start(), { writes: 1, error: null });
      assert.deepEqual(start(), { writes: 0, error: 'replay' });
    });

    await step('控制端能看到主机在线和它的公钥指纹', async () => {
      await C.ready();
      for (let i = 0; i < 50 && !C.devices().some((d) => d.online); i++) await sleep(100);
      const d = C.resolve('win'); // 名字模糊匹配
      assert.equal(d.id, HOST);
      assert.equal(fingerprint(d.key), fingerprint(hostKeys.publicKey));
      assert.equal(C.resolve().id, HOST); // 只有一台时可以不指定
      await rejectsWith(Promise.resolve().then(() => C.resolve('不存在的')), 'no-device');
    });

    await step('未授权时一律拒绝，包括只读操作', async () => {
      await rejectsWith(C.call('办公 Win', 'sys.info'), 'forbidden');
      await rejectsWith(C.call('办公 Win', 'exec', { command: 'echo hi' }), 'forbidden');
    });

    await step('只读权限：能看不能改', async () => {
      grant('read');
      const info = await C.call(HOST, 'sys.info');
      assert.equal(info.platform, process.platform);
      await fsp.writeFile(path.join(dirs.work, '笔记.txt'), '第一行\n第二行');
      const ls = await C.call(HOST, 'fs.list', { path: dirs.work });
      assert.deepEqual(ls.entries.map((e) => e.name), ['笔记.txt']);
      const rd = await C.call(HOST, 'fs.read', { path: path.join(dirs.work, '笔记.txt') });
      assert.equal(rd.content, '第一行\n第二行');
      assert.equal((await C.call(HOST, 'clipboard.read')).text, '主机剪贴板');
      await rejectsWith(C.call(HOST, 'exec', { command: 'echo hi' }), 'read-only');
      await rejectsWith(C.call(HOST, 'fs.write', { path: path.join(dirs.work, 'x.txt'), content: 'x' }), 'read-only');
      await rejectsWith(C.call(HOST, 'clipboard.write', { text: 'x' }), 'read-only');
      assert.ok(!fs.existsSync(path.join(dirs.work, 'x.txt')));
      await rejectsWith(C.call(HOST, 'no.such.method'), 'unknown-method');
    });

    await step('完全控制：执行命令，中文输出、退出码、工作目录都正确', async () => {
      grant('full');
      const r = await C.call(HOST, 'exec', { command: 'echo 你好 世界; pwd; echo 错误信息 1>&2; exit 3', cwd: dirs.work });
      assert.equal(r.exitCode, 3);
      assert.ok(r.stdout.includes('你好 世界'));
      assert.ok(r.stdout.includes(dirs.work));
      assert.ok(r.stderr.includes('错误信息'));
      assert.equal(r.timedOut, false);
      await rejectsWith(C.call(HOST, 'exec', { command: 'echo x', cwd: path.join(root, 'nope') }), 'not-found');
    });

    await step('命令超时会被杀掉，连同它启动的子进程', async () => {
      const marker = path.join(dirs.work, 'still-alive');
      const t0 = Date.now();
      const r = await C.call(HOST, 'exec', { command: `(sleep 4; touch "${marker}") & sleep 30`, timeoutSec: 1 }, { timeoutMs: 15e3 });
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - t0 < 6000, '应在超时后很快返回');
      await sleep(4500);
      assert.ok(!fs.existsSync(marker), '后台子进程也应被终止');
    });

    await step('超长输出保留头尾、省略中间', async () => {
      const r = await C.call(HOST, 'exec', { command: `echo START; head -c 600000 /dev/zero | tr '\\0' 'a'; echo; echo END` });
      assert.equal(r.truncated, true);
      assert.ok(r.stdout.startsWith('START'));
      assert.ok(r.stdout.trimEnd().endsWith('END'));
      assert.ok(r.stdout.includes('中间省略'));
      assert.ok(r.stdout.length < 260 * 1024);
    });

    await step('写文件、追加、读回；二进制文件按 base64 返回', async () => {
      const p = path.join(dirs.work, '子目录/新建.md');
      await C.call(HOST, 'fs.write', { path: p, content: '# 标题\n' });
      await C.call(HOST, 'fs.write', { path: p, content: '正文 ✓\n', append: true });
      assert.equal(await fsp.readFile(p, 'utf8'), '# 标题\n正文 ✓\n');
      const part = await C.call(HOST, 'fs.read', { path: p, maxBytes: 4 });
      assert.equal(part.truncated, true);
      const bin = path.join(dirs.work, 'bin.dat');
      await fsp.writeFile(bin, Buffer.from([0, 1, 2, 255, 254]));
      const rb = await C.call(HOST, 'fs.read', { path: bin });
      assert.equal(rb.encoding, 'base64');
      assert.deepEqual([...Buffer.from(rb.content, 'base64')], [0, 1, 2, 255, 254]);
    });

    const big = path.join(dirs.local, '安装包.bin');
    await step('旧版传输方法要求升级，缺少摘要的定向文件不落盘', async () => {
      for (const legacy of ['fs.send', 'fs.receive']) await rejectsWith(C.call(HOST, legacy), 'upgrade-required');
      const dest = path.join(dirs.work, '缺少摘要.bin');
      await assert.rejects(C.call(HOST, 'fs.receiveVerified', { item: 'unused', size: 0, dest }), /SHA-256/i);
      assert.ok(!fs.existsSync(dest));
      // 模拟旧版本收到带校验的新方法，确保控制端不会降级为旧写入方法。
      const called = [];
      const offline = Object.create(ControlClient.prototype);
      offline.call = async (_, method) => { called.push(method); throw Object.assign(new Error(), { code: 'unknown-method' }); };
      await rejectsWith(offline.pullFile('fixture', 'file', dest), 'upgrade-required');
      assert.deepEqual(called, ['fs.sendVerified']);
    });

    await step('把本机 12MB 文件传到对方指定目录；默认不覆盖', async () => {
      await fsp.writeFile(big, crypto.randomBytes(12 * 2 ** 20 + 77));
      const r = await C.pushFile(HOST, big, dirs.work); // 目标是目录 → 保留原文件名
      assert.equal(r.path, path.join(dirs.work, '安装包.bin'));
      assert.equal(await sha(r.path), await sha(big));
      await rejectsWith(C.pushFile(HOST, big, dirs.work), 'exists');
      await C.pushFile(HOST, big, path.join(dirs.work, '改名.bin'));
      assert.equal(await sha(path.join(dirs.work, '改名.bin')), await sha(big));
    });

    await step('把对方的文件取回本机；传输用的文件不出现在对方的接收目录', async () => {
      const r = await C.pullFile(HOST, path.join(dirs.work, '改名.bin'), path.join(dirs.local, '取回.bin'));
      assert.equal(await sha(r.path), await sha(big));
      await rejectsWith(C.pullFile(HOST, path.join(dirs.work, '改名.bin'), path.join(dirs.local, '取回.bin')), 'exists');
      await sleep(300);
      assert.ok(!fs.existsSync(`${root}/host-dl`), '定向文件不应进入对方的普通接收目录');
      assert.deepEqual(await fsp.readdir(path.join(dirs.data, 'blobs')), [], '中转上不应留下文件');
    });

    await step('普通收发不受影响：控制连接收不到内容推送，也不算一台新设备', async () => {
      const N = new Relay({ server: SERVER, token: TOKEN, deviceId: 'normal-dev-01', deviceName: '第三台', downloadDir: `${root}/n-dl` });
      const got = [];
      H.relay.on('received', (e) => got.push(e));
      N.start();
      for (let i = 0; i < 50 && !N.connected; i++) await sleep(100);
      assert.ok(!N.peers.find((p) => p.id === CTRL)?.online, '只有控制连接的设备不显示为在线');
      N.sendText('普通文字');
      for (let i = 0; i < 50 && !got.length; i++) await sleep(100);
      assert.equal(got[0]?.text, '普通文字');
      N.stop(); N._destroyAgents();
      await C.relay.removeDevice('normal-dev-01');
    });

    await step('拿着口令但没有私钥的人冒充控制端 → 被拒绝', async () => {
      const fake = mkClient(generateKeys(), 'pins-fake.json');
      await rejectsWith(fake.call(HOST, 'exec', { command: 'echo pwned > ' + path.join(dirs.work, 'pwned') }), 'bad-signature');
      fake.stop();
      await sleep(200);
      assert.ok(!fs.existsSync(path.join(dirs.work, 'pwned')));
    });

    await step('篡改内容、重放旧请求、过期请求 → 都不执行', async () => {
      const mk = (over = {}) => JSON.stringify({ v: 1, id: crypto.randomUUID(), from: CTRL, to: HOST, ts: Date.now(), method: 'fs.write', params: { path: path.join(dirs.work, 'attack.txt'), content: 'x' }, ...over });
      const before = activity.length;
      // 1) 签名之后改了内容
      const p1 = mk();
      await C.relay.sendRpc(HOST, p1.replace('attack.txt', 'attack2.txt'), signText(p1, ctrlKeys.privateKey));
      // 2) 同一条合法请求发两遍
      const p2 = mk({ params: { path: path.join(dirs.work, 'once.txt'), content: 'a', append: true } });
      const s2 = signText(p2, ctrlKeys.privateKey);
      await C.relay.sendRpc(HOST, p2, s2);
      await C.relay.sendRpc(HOST, p2, s2);
      // 3) 十分钟前签的请求
      const p3 = mk({ ts: Date.now() - 10 * 60e3 });
      await C.relay.sendRpc(HOST, p3, signText(p3, ctrlKeys.privateKey));
      // 4) 发给别的设备的请求被转到这台
      const p4 = mk({ to: 'someone-else' });
      await C.relay.sendRpc(HOST, p4, signText(p4, ctrlKeys.privateKey));
      for (let i = 0; i < 50 && activity.length < before + 5; i++) await sleep(100);
      const errs = activity.slice(before).map((a) => a.error || 'ok');
      assert.equal(errs.filter((e) => e === 'ok').length, 1, '只有一条被执行：' + errs.join(' | '));
      assert.equal(await fsp.readFile(path.join(dirs.work, 'once.txt'), 'utf8'), 'a');
      assert.ok(!fs.existsSync(path.join(dirs.work, 'attack.txt')) && !fs.existsSync(path.join(dirs.work, 'attack2.txt')));
    });

    await step('伪造的应答（签名不对）被控制端丢弃', async () => {
      const id = crypto.randomUUID();
      const outcome = new Promise((resolve, reject) => C.pending.set(id, { resolve, reject, timer: setTimeout(() => {}, 0), key: hostKeys.publicKey, dev: { id: HOST, name: '办公 Win' } }));
      const forged = JSON.stringify({ v: 1, id, from: HOST, to: CTRL, ts: Date.now(), ok: true, result: { exitCode: 0, stdout: '假结果' } });
      C._onReply({ from: HOST, payload: forged, sig: signText(forged, generateKeys().privateKey) });
      await rejectsWith(outcome, 'bad-signature');
    });

    await step('每次操作都留下记录（谁、做了什么、成没成）', async () => {
      const rec = activity.find((a) => a.method === 'exec' && a.summary.includes('echo START'));
      assert.ok(rec && rec.ok);
      assert.equal(rec.fromName, '家里 Mac');
      assert.ok(activity.some((a) => a.method === 'exec' && a.summary.includes('pwned') && !a.ok), '被拒绝的尝试也要留痕');
      assert.ok(activity.some((a) => !a.ok && a.error.includes('只读')));
    });

    // ---------- MCP 进程 ----------
    await fsp.writeFile(path.join(dirs.cfg, 'config.json'), JSON.stringify({
      server: SERVER, token: TOKEN, deviceId: CTRL, deviceName: '家里 Mac', keyPublic: ctrlKeys.publicKey,
    }));
    const mockCredential = path.join(dirs.cfg, 'mock-credential.cjs');
    const keyring = require.resolve('../app/node_modules/@napi-rs/keyring');
    await fsp.writeFile(mockCredential, `require.cache[${JSON.stringify(keyring)}] = {
      exports: { Entry: class { getPassword() { return process.env.W2M_TEST_SIGNING_KEY; } } }
    };`);
    const mcp = spawn(process.execPath, ['--require', mockCredential, path.join(__dirname, '../app/src/mcp.js')], {
      env: { ...process.env, W2M_USER_DATA: dirs.cfg, W2M_TEST_SIGNING_KEY: ctrlKeys.privateKey }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '', nextId = 1;
    const waiting = new Map();
    mcp.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const msg = JSON.parse(line); // stdout 上只能有协议消息，解析失败就是 bug
        waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error('MCP 无应答: ' + method)), 30e3);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const callTool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;

    await step('MCP：握手、工具列表', async () => {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.equal(init.result.serverInfo.name, 'win2mac');
      assert.ok(init.result.capabilities.tools);
      assert.ok(init.result.instructions.includes('list_devices'));
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      assert.deepEqual((await rpc('ping')).result, {});
      const { tools } = (await rpc('tools/list')).result;
      assert.deepEqual(tools.map((t) => t.name), ['list_devices', 'run_command', 'list_directory', 'read_file', 'write_file', 'copy_file_to_device', 'copy_file_from_device', 'get_clipboard', 'set_clipboard', 'take_screenshot', 'open_on_device']);
      for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 10); }
      assert.equal((await rpc('no/such')).error.code, -32601);
      assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
    });

    await step('MCP：list_devices 说明对方系统、主目录和 shell', async () => {
      const r = await callTool('list_devices', {});
      const t = r.content[0].text;
      assert.ok(t.includes('办公 Win') && t.includes('在线') && t.includes(os.homedir()), t);
    });

    await step('MCP：run_command 返回输出；失败的命令标记为错误', async () => {
      const ok = await callTool('run_command', { device: 'win', command: 'echo 来自MCP', cwd: dirs.work });
      assert.ok(ok.content[0].text.includes('来自MCP') && ok.content[0].text.includes('退出码：0'));
      assert.ok(!ok.isError);
      const bad = await callTool('run_command', { command: 'ls /definitely/not/here' });
      assert.equal(bad.isError, true);
      assert.ok(/退出码：[1-9]/.test(bad.content[0].text));
    });

    await step('MCP：读写文件、列目录、收发文件、剪贴板、截图、打开', async () => {
      const p = path.join(dirs.work, 'mcp.txt');
      assert.ok((await callTool('write_file', { path: p, content: 'MCP 写入' })).content[0].text.includes('已写入'));
      assert.equal((await callTool('read_file', { path: p })).content[0].text, 'MCP 写入');
      assert.ok((await callTool('list_directory', { path: dirs.work })).content[0].text.includes('mcp.txt'));
      assert.ok((await callTool('read_file', { path: path.join(dirs.work, 'bin.dat') })).content[0].text.includes('二进制'));
      await callTool('copy_file_to_device', { local_path: big, remote_path: path.join(dirs.work, 'via-mcp.bin') });
      assert.equal(await sha(path.join(dirs.work, 'via-mcp.bin')), await sha(big));
      await callTool('copy_file_from_device', { remote_path: path.join(dirs.work, 'via-mcp.bin'), local_path: path.join(dirs.local, 'back.bin') });
      assert.equal(await sha(path.join(dirs.local, 'back.bin')), await sha(big));
      assert.equal((await callTool('get_clipboard', {})).content[0].text, '主机剪贴板');
      await callTool('set_clipboard', { text: '写给主机' });
      assert.equal(controllers._clip, '写给主机');
      const shot = await callTool('take_screenshot', {});
      assert.equal(shot.content[1].type, 'image');
      assert.equal(shot.content[1].mimeType, 'image/jpeg');
      assert.ok((await callTool('open_on_device', { target: 'https://example.com' })).content[0].text.includes('example.com'));
    });

    await step('MCP：权限不够、设备离线时给出能看懂的提示', async () => {
      grant('read');
      const ro = await callTool('run_command', { command: 'echo x' });
      assert.equal(ro.isError, true);
      assert.ok(ro.content[0].text.includes('只读'));
      grant(null);
      assert.ok((await callTool('list_devices', {})).content[0].text.includes('没有授权'));
      H.relay.stop();
      await sleep(500);
      const off = await callTool('run_command', { command: 'echo x' });
      assert.ok(off.isError && off.content[0].text.includes('不在线'), off.content[0].text);
      assert.ok((await callTool('list_devices', {})).content[0].text.includes('离线'));
    });

    await step('对方换了密钥（比如被人冒名顶替）时，控制端拒绝继续', async () => {
      H = mkHost(generateKeys());
      grant('full');
      for (let i = 0; i < 50 && !C.devices().find((d) => d.id === HOST)?.online; i++) await sleep(100);
      await rejectsWith(C.call(HOST, 'sys.info'), 'key-changed');
    });

    mcp.stdin.end();
    await new Promise((r) => mcp.once('exit', r));
  } finally {
    C.stop(); H.relay.stop(); H.relay._destroyAgents();
    srv.kill();
    await fsp.rm(root, { recursive: true, force: true });
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

const run = process.argv[2] === '--replay-fixture' ? replayFixture : main;
run().catch((e) => { console.error(e); process.exit(1); });
