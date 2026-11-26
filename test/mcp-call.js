'use strict';
// 启动一个 MCP 进程，握手后调用若干工具并打印结果。用来验证“已安装的程序 + 真实链路”。
// 用法：node test/mcp-call.js <command> <script> '<工具名>' '<JSON 参数>' ['<工具名>' '<JSON 参数>' ...]
// 例如：node test/mcp-call.js /Applications/Win2Mac.app/Contents/MacOS/Win2Mac \
//         /Applications/Win2Mac.app/Contents/Resources/app.asar/src/mcp.js list_devices '{}'
const { spawn } = require('child_process');
const [command, script, ...rest] = process.argv.slice(2);
const child = spawn(command, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', id = 0;
const waiting = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const n = ++id;
  const t = setTimeout(() => reject(new Error('无应答: ' + method)), 120e3);
  waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
});
(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-call', version: '1' } });
  console.log(`握手成功：${init.result.serverInfo.name} ${init.result.serverInfo.version}，协议 ${init.result.protocolVersion}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  console.log(`工具数：${(await rpc('tools/list')).result.tools.length}`);
  for (let i = 0; i < rest.length; i += 2) {
    const r = (await rpc('tools/call', { name: rest[i], arguments: JSON.parse(rest[i + 1] || '{}') })).result;
    console.log(`\n=== ${rest[i]}${r.isError ? '（失败）' : ''}`);
    for (const c of r.content) console.log(c.type === 'text' ? c.text : `[${c.type} ${c.mimeType}，${Math.round(c.data.length * 0.75 / 1024)} KB]`);
  }
  child.stdin.end();
})().catch((e) => { console.error('失败:', e.message); child.kill(); process.exit(1); });
