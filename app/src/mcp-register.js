'use strict';
// 把 Win2Mac 的 MCP 服务登记到本机已安装的 AI 客户端里（或用 --remove 取消登记）。
// 只动各客户端配置里名为 win2mac 的那一项，改之前会留一份 .bak-win2mac 备份。
//
// 命令行用法（用 Win2Mac 自带的运行时，这样登记进去的就是已安装程序的路径）：
//   ELECTRON_RUN_AS_NODE=1 <Win2Mac 可执行文件> <本文件> [--remove] [--only kimi,zcode,codex,claude-desktop]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { parseTOML } = require('toml-eslint-parser');

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
function replaceConfig(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let target = file, mode = 0o600;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    try { fs.copyFileSync(file, file + '.bak-win2mac', fs.constants.COPYFILE_EXCL); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  } else if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('配置文件是失效的符号链接，请先检查它的目标');
  }
  const tmp = target + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try { fs.writeFileSync(fd, text); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  } finally { fs.rmSync(tmp, { force: true }); }
}
function writeJson(file, data) {
  replaceConfig(file, JSON.stringify(data, null, 2) + '\n');
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

function tomlFields(entry) {
  const quote = (s) => JSON.stringify(s).replace(/\x7f/g, '\\u007f');
  const fields = ['command = ' + quote(entry.command), 'args = [' + entry.args.map(quote).join(', ') + ']'];
  if (entry.env) fields.push('env = { ELECTRON_RUN_AS_NODE = ' + quote(entry.env.ELECTRON_RUN_AS_NODE) + ' }');
  return fields;
}

function codexToml(entry = serverEntry()) {
  return ['[mcp_servers.win2mac]', ...tomlFields(entry), ''].join('\n');
}

const keyParts = (node) => node.key.keys.map((key) => key.type === 'TOMLBare' ? key.name : key.value);
const isOurs = (keys) => keys[0] === 'mcp_servers' && keys[1] === NAME;

// 比较完整路径和原始值（包括大整数、多行字符串），避开 JS 对 TOML 数值的精度损失。
function otherSettings(ast, text) {
  const settings = [];
  function value(field, table) {
    const key = [...table, ...keyParts(field)];
    if (isOurs(key)) return;
    if (key.length === 1 && key[0] === 'mcp_servers' && field.value.type === 'TOMLInlineTable') {
      for (const child of field.value.body) value(child, key);
    } else settings.push([key, text.slice(...field.value.range)]);
  }
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') value(node, []);
    else if (!isOurs(node.resolvedKey)) {
      settings.push([node.resolvedKey, node.kind]);
      for (const field of node.body) value(field, node.resolvedKey);
    }
  }
  return [settings, ast.comments.map((comment) => comment.value)];
}

function editCodexToml(source, remove) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = source.slice(bom.length);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const ast = parseTOML(text);
  const edits = [];
  let had = false, inlineServers;
  // 单独删除表头和属于它的键值语句。保留前后独立的注释及同行注释。
  function dropLine(start, end) {
    const begin = text.lastIndexOf('\n', start - 1) + 1;
    const lf = text.indexOf('\n', end - 1);
    const finish = lf < 0 ? text.length : lf + 1;
    const kept = ast.comments.filter((c) => c.range[0] >= begin && c.range[1] <= finish).map((c) => {
      const prefix = text.slice(text.lastIndexOf('\n', c.range[0] - 1) + 1, c.range[0]).match(/^[ \t]*/)[0];
      return prefix + text.slice(...c.range) + eol;
    }).join('');
    edits.push([begin, finish, kept]);
    had = true;
  }
  function visitValue(node, tableKey) {
    const key = [...tableKey, ...keyParts(node)];
    if (isOurs(key)) dropLine(...node.range);
    if (key.length === 1 && key[0] === 'mcp_servers') {
      if (node.value.type !== 'TOMLInlineTable') throw new Error('mcp_servers 配置需要是 TOML 表');
      inlineServers = node.value;
    }
  }
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') { visitValue(node, []); continue; }
    if (node.resolvedKey[0] === 'mcp_servers' && typeof node.resolvedKey[1] === 'number') throw new Error('mcp_servers 配置需要是 TOML 表');
    if (isOurs(node.resolvedKey)) dropLine(node.range[0], node.key.range[1]);
    for (const field of node.body) visitValue(field, node.resolvedKey);
  }

  if (inlineServers) {
    // TOML 的内联表不能在文件末尾追加子表，直接在花括号内编辑。
    const fields = inlineServers.body;
    const replacement = 'win2mac = { ' + tomlFields(serverEntry()).join(', ') + ' }';
    for (let i = 0; i < fields.length; i++) {
      if (keyParts(fields[i])[0] !== NAME) continue;
      const first = i;
      while (i + 1 < fields.length && keyParts(fields[i + 1])[0] === NAME) i++;
      if (!remove && !had) edits.push([fields[first].range[0], fields[i].range[1], replacement]);
      else {
        const start = first > 0 ? fields[first - 1].range[1] : fields[first].range[0];
        const end = first === 0 && fields[i + 1] ? fields[i + 1].range[0] : fields[i].range[1];
        edits.push([start, end, '']);
      }
      had = true;
    }
    if (!remove && !had) {
      const last = fields.at(-1);
      const at = last ? last.range[1] : inlineServers.range[0] + 1;
      edits.push([at, at, (last ? ', ' : '') + replacement]);
    }
  }

  let result = text;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + replacement + result.slice(end);
  if (!remove && !inlineServers) {
    if (result && !result.endsWith('\n')) result += eol;
    if (result && !result.endsWith(eol + eol)) result += eol;
    result += codexToml().replace(/\n/g, eol);
  }
  const updated = parseTOML(result);
  if (!isDeepStrictEqual(otherSettings(ast, text), otherSettings(updated, result))) throw new Error('无法保留原有配置和注释，已取消编辑');
  return { result: bom + result, had };
}

function codexClient(file) {
  return (remove) => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const { result, had } = editCodexToml(text, remove);
    if (remove && !had) return '本来就没有登记';
    if (result !== text) replaceConfig(file, result);
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

module.exports = { register, serverEntry, clients, codexClient, codexToml };
