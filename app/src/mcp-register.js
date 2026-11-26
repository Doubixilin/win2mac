'use strict';
// 把 Win2Mac 的 MCP 服务登记到本机已安装的 AI 客户端里（或用 --remove 取消登记）。
// 只动各客户端配置里名为 win2mac 的那一项，改之前会留一份 .bak-win2mac 备份。
//
// 命令行用法（用 Win2Mac 自带的运行时，这样登记进去的就是已安装程序的路径）：
//   ELECTRON_RUN_AS_NODE=1 <Win2Mac 可执行文件> <本文件> [--remove] [--only kimi,zcode,codex,claude-desktop]

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'win2mac';
const home = os.homedir();

/** AI 客户端启动 MCP 进程用的命令。用 Electron 自带的 Node 跑 mcp.js，不需要另装运行时 */
function serverEntry() {
  const entry = { command: process.execPath, args: [path.join(__dirname, 'mcp.js')] };
  if (process.versions.electron) entry.env = { ELECTRON_RUN_AS_NODE: '1' };
  return entry;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${file} 不是合法的 JSON，没有改动它`); }
}
function backupOnce(file) {
  if (fs.existsSync(file) && !fs.existsSync(file + '.bak-win2mac')) fs.copyFileSync(file, file + '.bak-win2mac');
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupOnce(file);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

/** 通用：JSON 配置里某个对象下按名字登记，keys 是到那个对象的路径 */
function jsonClient(file, keys, extra = {}) {
  return (remove) => {
    const data = readJson(file) || {};
    let node = data;
    for (const k of keys) { if (!node[k] || typeof node[k] !== 'object') node[k] = {}; node = node[k]; }
    const had = NAME in node;
    if (remove) { if (!had) return '本来就没有登记'; delete node[NAME]; writeJson(file, data); return '已取消登记'; }
    node[NAME] = { ...serverEntry(), ...extra };
    writeJson(file, data);
    return had ? '已更新' : '已登记';
  };
}

function codexClient(file) {
  return (remove) => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // 去掉已有的 win2mac 段（到下一个表头或文件结尾），再按需追加新的
    const stripped = text.replace(/(^|\n)\[mcp_servers\.win2mac(\.[^\]]+)?\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/g, '$1');
    const had = stripped !== text;
    if (remove && !had) return '本来就没有登记';
    const e = serverEntry();
    const q = (s) => `'${s}'`; // TOML 字面量字符串，Windows 路径里的反斜杠不用转义
    const block = `[mcp_servers.win2mac]\ncommand = ${q(e.command)}\nargs = [${e.args.map(q).join(', ')}]\n` + (e.env ? `env = { ELECTRON_RUN_AS_NODE = "1" }\n` : '');
    backupOnce(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, remove ? stripped : stripped.replace(/\n*$/, '\n\n') + block);
    return remove ? '已取消登记' : had ? '已更新' : '已登记';
  };
}

function clients() {
  const appData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const zcodeMain = path.join(home, '.zcode', 'cli', 'config.json');
  const has = (...p) => fs.existsSync(path.join(...p));
  return [
    { id: 'kimi', label: 'Kimi Code', installed: has(home, '.kimi-code'), file: path.join(home, '.kimi-code', 'mcp.json'),
      // 传大文件、跑长命令可能要很久，把单次调用的超时放宽到命令上限之上
      run: jsonClient(path.join(home, '.kimi-code', 'mcp.json'), ['mcpServers'], { toolTimeoutMs: 1900000 }) },
    // ZCode：自己的配置文件存在就写进去；否则写到它也会读取的通用位置 ~/.agents/mcp.json
    fs.existsSync(zcodeMain)
      ? { id: 'zcode', label: 'ZCode', installed: true, file: zcodeMain, run: jsonClient(zcodeMain, ['mcp', 'servers']) }
      : { id: 'zcode', label: 'ZCode', installed: has(home, '.zcode'), file: path.join(home, '.agents', 'mcp.json'), run: jsonClient(path.join(home, '.agents', 'mcp.json'), ['mcpServers']) },
    { id: 'codex', label: 'Codex', installed: has(home, '.codex'), file: path.join(home, '.codex', 'config.toml'), run: codexClient(path.join(home, '.codex', 'config.toml')) },
    { id: 'claude-desktop', label: 'Claude 桌面版', installed: has(appData, 'Claude'), file: path.join(appData, 'Claude', 'claude_desktop_config.json'),
      run: jsonClient(path.join(appData, 'Claude', 'claude_desktop_config.json'), ['mcpServers']) },
  ];
}

/** @returns [{ id, label, file, ok, message }]，只处理本机装了的客户端 */
function register({ remove = false, only = null } = {}) {
  const out = [];
  for (const c of clients()) {
    if (only && !only.includes(c.id)) continue;
    if (!c.installed) { out.push({ id: c.id, label: c.label, file: c.file, ok: false, skipped: true, message: '本机没有安装' }); continue; }
    try { out.push({ id: c.id, label: c.label, file: c.file, ok: true, message: c.run(remove) }); }
    catch (e) { out.push({ id: c.id, label: c.label, file: c.file, ok: false, message: e.message }); }
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--only');
  const res = register({ remove: args.includes('--remove'), only: i >= 0 ? String(args[i + 1] || '').split(',') : null });
  for (const r of res) console.log(`${r.ok ? 'OK  ' : r.skipped ? 'SKIP' : 'FAIL'} ${r.label}: ${r.message}${r.ok ? '  → ' + r.file : ''}`);
  console.log('（客户端需要重启或新开会话后才会加载新的 MCP 配置）');
}

module.exports = { register, serverEntry, clients };
