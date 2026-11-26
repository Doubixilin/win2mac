'use strict';
// Win2Mac 的 MCP 服务（stdio）。让本机的 AI 客户端通过 Win2Mac 操作另一台已配对的电脑。
//
// 由 AI 客户端启动，用已安装的 Win2Mac 程序自带的运行时即可，不需要另装 Node：
//   command: <Win2Mac 可执行文件>   args: [<本文件路径>]   env: ELECTRON_RUN_AS_NODE=1
// 读取本机 Win2Mac 的配置（服务器、口令、设备密钥），以“这台电脑”的身份发起请求；
// 对方电脑只有在它的设置里授权过这台电脑，才会执行。
//
// 协议：MCP stdio 传输，一行一个 JSON-RPC 2.0 消息；日志一律写 stderr。

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { ControlClient, fingerprint } = require('./control');

const VERSION = (() => { try { return require('../package.json').version; } catch { return '0.0.0'; } })();
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const log = (...a) => process.stderr.write('[win2mac-mcp] ' + a.join(' ') + '\n');

function userDataDir() {
  if (process.env.W2M_USER_DATA) return process.env.W2M_USER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Win2Mac');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Win2Mac');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Win2Mac');
}

let client = null;
function getClient() {
  if (client) return client;
  const dir = userDataDir();
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); }
  catch { throw new Error(`没找到 Win2Mac 的配置（${path.join(dir, 'config.json')}）。请先在这台电脑上打开 Win2Mac 并完成配对。`); }
  if (!cfg.server || !cfg.token) throw new Error('这台电脑上的 Win2Mac 还没有填服务器地址和口令。');
  if (!cfg.keyPrivate || !cfg.keyPublic) throw new Error('这台电脑上的 Win2Mac 版本太旧，没有设备密钥。请升级并启动一次。');
  client = new ControlClient({
    server: cfg.server, token: cfg.token, deviceId: cfg.deviceId, deviceName: cfg.deviceName,
    publicKey: cfg.keyPublic, privateKey: cfg.keyPrivate, pinsFile: path.join(dir, 'known-devices.json'),
  });
  client.on('warn', (e) => log('warn:', e?.message || e));
  client.start();
  return client;
}

// ---------- 工具 ----------

const DEVICE = { type: 'string', description: '目标设备的名字（list_devices 里的 name，可以只写一部分，如 "Win"）。只有一台其他设备时可以省略。' };
const str = (description) => ({ type: 'string', description });
const tool = (name, description, properties, required, run, extra = {}) => ({ name, description, inputSchema: { type: 'object', properties, required }, run, ...extra });
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const kb = (n) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);

const TOOLS = [
  tool('list_devices',
    '列出通过 Win2Mac 配对的其他电脑：名字、是否在线、操作系统、用户主目录、用什么 shell，以及它给了这台电脑什么权限。操作另一台电脑之前先调用它，了解对方是 Windows 还是 Mac。',
    {}, [],
    async () => {
      const c = getClient();
      await c.ready();
      const peers = c.devices();
      if (!peers.length) return text('还没有其他设备和这台电脑配对。');
      const lines = await Promise.all(peers.map(async (p) => {
        if (!p.online) return `- ${p.name}：离线`;
        try {
          const i = await c.call(p.id, 'sys.info', {}, { timeoutMs: 8000 });
          const osName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[i.platform] || i.platform;
          return `- ${p.name}：在线，${osName} ${i.osVersion}（${i.arch}），用户 ${i.user}，主目录 ${i.home}，命令由 ${i.shell} 执行，设备指纹 ${fingerprint(p.key)}`;
        } catch (e) {
          return `- ${p.name}：在线，但无法控制——${e.message}`;
        }
      }));
      return text(lines.join('\n'));
    }),

  tool('run_command',
    '在另一台电脑上执行一条 shell 命令并返回输出和退出码。Windows 上用 PowerShell 5.1 执行（输出已统一为 UTF-8，多条命令用分号或换行分隔，不是 &&）；macOS 上用登录 shell（zsh）。命令在对方的桌面会话里以当前登录用户身份运行，可以启动图形程序。个别老的 Windows 程序（如 hostname.exe）会无视编码设置输出 GBK 而显示成乱码，换用 PowerShell 自己的写法（如 $env:COMPUTERNAME）即可。需要对方授予“完全控制”。',
    {
      device: DEVICE,
      command: str('要执行的命令'),
      cwd: str('工作目录，默认是对方的用户主目录；可以用 ~ 开头'),
      timeout_seconds: { type: 'number', description: '超时秒数，默认 60，最大 1800。超时会杀掉整个进程树。' },
      shell: { type: 'string', enum: ['default', 'cmd'], description: '只对 Windows 有意义：填 cmd 则改用 cmd.exe 执行' },
    }, ['command'],
    async (a) => {
      const t = Math.min(Math.max(Number(a.timeout_seconds) || 60, 1), 1800);
      const r = await getClient().call(a.device, 'exec', { command: a.command, cwd: a.cwd, timeoutSec: t, shell: a.shell }, { timeoutMs: t * 1000 + 20e3 });
      const parts = [`退出码：${r.exitCode === null ? `无（${r.signal || '被终止'}）` : r.exitCode}，耗时 ${(r.durationMs / 1000).toFixed(1)} 秒，工作目录 ${r.cwd}`];
      if (r.timedOut) parts.push(`⚠ 超过 ${t} 秒，已强制结束`);
      if (r.truncated) parts.push('⚠ 输出太长，中间部分已省略');
      if (r.stdout) parts.push('--- 标准输出 ---\n' + r.stdout.replace(/\s+$/, ''));
      if (r.stderr) parts.push('--- 标准错误 ---\n' + r.stderr.replace(/\s+$/, ''));
      if (!r.stdout && !r.stderr) parts.push('（没有输出）');
      return { ...text(parts.join('\n')), isError: r.exitCode !== 0 || r.timedOut };
    }),

  tool('list_directory',
    '列出另一台电脑上某个目录的内容（名字、类型、大小）。',
    { device: DEVICE, path: str('目录路径，默认是用户主目录；可以用 ~ 开头，相对路径按主目录算') }, [],
    async (a) => {
      const r = await getClient().call(a.device, 'fs.list', { path: a.path });
      const rows = r.entries.map((e) => (e.type === 'dir' ? `[目录] ${e.name}` : `${e.name}  ${kb(e.size)}  ${stamp(e.mtime)}`));
      return text(`${r.path}（${r.entries.length} 项${r.more ? `，另有 ${r.more} 项未列出` : ''}）\n` + (rows.join('\n') || '（空目录）'));
    }),

  tool('read_file',
    '读取另一台电脑上的一个文本文件（单次最多 2MB，默认读前 256KB）。大文件或二进制文件请用 copy_file_from_device 取到本机。',
    {
      device: DEVICE, path: str('文件路径'),
      offset: { type: 'number', description: '从第几个字节开始读，默认 0' },
      max_bytes: { type: 'number', description: '最多读多少字节，默认 262144' },
    }, ['path'],
    async (a) => {
      const r = await getClient().call(a.device, 'fs.read', { path: a.path, offset: a.offset, maxBytes: a.max_bytes });
      if (r.encoding === 'base64') return text(`${r.path} 是二进制文件（共 ${kb(r.size)}），不适合直接读。请用 copy_file_from_device 取到本机。`);
      const note = r.truncated ? `\n\n（文件共 ${r.size} 字节，这里是第 ${r.offset}–${r.offset + r.bytes} 字节；继续读请把 offset 设为 ${r.offset + r.bytes}）` : '';
      return text(r.content + note);
    }),

  tool('write_file',
    '在另一台电脑上写入一个文本文件（会自动创建上级目录；默认覆盖已有文件）。需要对方授予“完全控制”。',
    {
      device: DEVICE, path: str('文件路径'), content: str('要写入的文本，UTF-8'),
      append: { type: 'boolean', description: '为 true 时追加到文件末尾而不是覆盖' },
    }, ['path', 'content'],
    async (a) => {
      const r = await getClient().call(a.device, 'fs.write', { path: a.path, content: a.content, append: !!a.append });
      return text(`已写入 ${r.path}（本次 ${kb(r.bytes)}，文件现在 ${kb(r.size)}）`);
    }),

  tool('copy_file_to_device',
    '把本机的一个文件传到另一台电脑的指定位置，大小不限（经中转服务器，速度受服务器带宽限制）。文件夹请先打包成压缩包。需要对方授予“完全控制”。',
    {
      device: DEVICE, local_path: str('本机文件路径'),
      remote_path: str('对方电脑上的目标路径；如果是已存在的目录，就放进该目录并保留原文件名'),
      overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认否' },
    }, ['local_path', 'remote_path'],
    async (a) => {
      const r = await getClient().pushFile(a.device, a.local_path, a.remote_path, { overwrite: !!a.overwrite });
      return text(`已传到对方的 ${r.path}（${kb(r.size)}）`);
    }),

  tool('copy_file_from_device',
    '把另一台电脑上的一个文件取到本机的指定位置，大小不限（经中转服务器，速度受服务器带宽限制）。文件夹请先在对方打包成压缩包。',
    {
      device: DEVICE, remote_path: str('对方电脑上的文件路径'),
      local_path: str('本机的目标路径；如果是已存在的目录，就放进该目录并保留原文件名'),
      overwrite: { type: 'boolean', description: '本机目标已存在时是否覆盖，默认否' },
    }, ['remote_path', 'local_path'],
    async (a) => {
      const r = await getClient().pullFile(a.device, a.remote_path, a.local_path, { overwrite: !!a.overwrite });
      return text(`已把对方的 ${r.remotePath} 取到本机 ${r.path}（${kb(r.size)}）`);
    }),

  tool('get_clipboard',
    '读取另一台电脑当前剪贴板里的内容：文字，或者复制的文件路径列表。',
    { device: DEVICE }, [],
    async (a) => {
      const r = await getClient().call(a.device, 'clipboard.read', {});
      if (r.files?.length) return text('剪贴板里是复制的文件：\n' + r.files.join('\n'));
      if (r.text) return text(r.text);
      return text(r.hasImage ? '剪贴板里是一张图片（没有文字）。' : '剪贴板是空的。');
    }),

  tool('set_clipboard',
    '把一段文字放进另一台电脑的剪贴板。需要对方授予“完全控制”。',
    { device: DEVICE, text: str('要放进剪贴板的文字') }, ['text'],
    async (a) => { await getClient().call(a.device, 'clipboard.write', { text: a.text }); return text('已放进对方的剪贴板。'); }),

  tool('take_screenshot',
    '截取另一台电脑当前的屏幕画面，用来确认图形界面的状态。',
    { device: DEVICE, display: { type: 'number', description: '第几块屏幕，从 0 开始，默认 0' } }, [],
    async (a) => {
      const r = await getClient().call(a.device, 'screen.capture', { display: a.display }, { timeoutMs: 60e3 });
      return { content: [{ type: 'text', text: `屏幕 ${r.index + 1}/${r.count}，${r.width}×${r.height}` }, { type: 'image', data: r.data, mimeType: r.mimeType }] };
    }),

  tool('open_on_device',
    '在另一台电脑上用默认程序打开一个文件、文件夹或网址（相当于双击）。需要对方授予“完全控制”。',
    { device: DEVICE, target: str('文件路径、文件夹路径，或 http(s) 网址') }, ['target'],
    async (a) => { const r = await getClient().call(a.device, 'open', { target: a.target }); return text(`已在对方电脑上打开：${r.opened}`); }),
];

const INSTRUCTIONS = [
  'Win2Mac 让你操作用户的另一台电脑（经用户自己的中转服务器，对方电脑上的 Win2Mac 负责执行）。',
  '先调用 list_devices 看有哪些设备、是 Windows 还是 macOS、主目录在哪，再决定命令怎么写。',
  '对方电脑必须开着并运行 Win2Mac，且在它的设置里授权了这台电脑；报“没有授权”或“只读”时，请告诉用户去对方电脑的 Win2Mac 设置 → 远程控制 里调整，不要尝试绕过。',
  '命令是在另一台真实电脑上执行的：删除、覆盖、安装、关机这类操作先向用户确认。',
].join('\n');

// ---------- JSON-RPC ----------

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const ok = (result) => isRequest && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => isRequest && send({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    const want = params?.protocolVersion;
    return ok({
      protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[1],
      capabilities: { tools: {} },
      serverInfo: { name: 'win2mac', title: 'Win2Mac 远程控制', version: VERSION },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const t = TOOLS.find((x) => x.name === params?.name);
    if (!t) return fail(-32602, `没有这个工具：${params?.name}`);
    try { return ok(await t.run(params.arguments || {})); }
    catch (e) { return ok({ content: [{ type: 'text', text: e.message || String(e) }], isError: true }); }
  }
  if (!isRequest) return; // 通知（如 notifications/initialized）不需要应答
  fail(-32601, `不支持的方法：${method}`);
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }); }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m).catch((e) => log('error:', e?.stack || e));
  });
  rl.on('close', () => { client?.stop(); process.exit(0); });
  log(`started, version ${VERSION}, config ${userDataDir()}`);
}

if (require.main === module) main();
module.exports = { TOOLS, userDataDir, main };
