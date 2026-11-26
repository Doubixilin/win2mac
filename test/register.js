'use strict';
// 所有配置都位于临时目录；只调用 Codex 注册器，不扫描本机客户端。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { codexClient, codexToml, serverEntry } = require('../app/src/mcp-register');
const { parseTOML, getStaticTOMLValue } = createRequire(require.resolve('../app/package.json'))('toml-eslint-parser');
const parse = (s) => getStaticTOMLValue(parseTOML(s.replace(/^\uFEFF/, '')));

function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-register-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.toml');
  if (content !== undefined) fs.writeFileSync(file, content);
  return { file, run: codexClient(file), read: () => fs.readFileSync(file, 'utf8') };
}

test('更新或移除时保留其他表、多行字符串、注释、BOM 和 CRLF', (t) => {
  const nl = '\r\n';
  const start = ['\uFEFFdescription = """', '[mcp_servers.win2mac]', '# 多行字符串中的文字', '"""', '# standalone', ''].join(nl);
  const target = ['   ["mcp_servers".\'win2mac\'] # server note', 'args = [', '  # argument comment', '  "old",', ']', '  [mcp_servers."win2mac".env]', 'X = "1"', ''].join(nl);
  const neighbor = ['# next service', '  [mcp_servers.other]', '  command = "other" # keep', '  args = ["[mcp_servers.win2mac]"]', ''].join(nl);
  const source = start + target + neighbor;
  const f = fixture(t, source);
  if (process.platform !== 'win32') fs.chmodSync(f.file, 0o640);
  assert.equal(f.run(false), '已更新');
  const updated = f.read();
  assert.ok(updated.startsWith(start));
  assert.ok(updated.includes(neighbor));
  assert.ok(updated.includes('# server note' + nl) && updated.includes('# argument comment' + nl));
  assert.doesNotMatch(updated, /(?<!\r)\n/);
  assert.deepEqual(parse(updated).mcp_servers.win2mac, serverEntry());
  assert.deepEqual(parse(updated).mcp_servers.other, parse(source).mcp_servers.other);
  assert.equal(fs.readFileSync(f.file + '.bak-win2mac', 'utf8'), source);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  assert.equal(f.run(false), '已更新');
  assert.equal(f.read(), updated);
  assert.equal(f.run(true), '已取消登记');
  assert.ok(f.read().includes(neighbor));
  assert.equal(parse(f.read()).mcp_servers.win2mac, undefined);
  assert.equal(f.run(true), '本来就没有登记');
  assert.equal(fs.readFileSync(f.file + '.bak-win2mac', 'utf8'), source);
});

test('支持在根和父表内按点键登记的已有服务', (t) => {
  for (const source of [
    'mcp_servers."win2mac".command = "old"\nmcp_servers.other.command = "other"\n',
    '[mcp_servers]\n"win2mac" = { command = "old" }\nother.command = "other"\n',
  ]) {
    const f = fixture(t, source);
    assert.equal(f.run(false), '已更新');
    assert.deepEqual(parse(f.read()).mcp_servers, { win2mac: serverEntry(), other: { command: 'other' } });
    f.run(true);
    assert.deepEqual(parse(f.read()).mcp_servers, { other: { command: 'other' } });
  }
});

test('内联表里的更新、添加和移除保留相邻成员及其自定义格式', (t) => {
  const neighbor = 'other = { command="other", args = [ "a" ] }';
  for (const members of [
    neighbor,
    'win2mac = { command = "old" }, ' + neighbor,
    neighbor + ', "win2mac" = {command="old"}',
    'win2mac.command="old", ' + neighbor + ', win2mac.args=["old"]',
    '',
  ]) {
    const f = fixture(t, 'mcp_servers = { ' + members + ' } # team\n');
    f.run(false);
    assert.deepEqual(parse(f.read()).mcp_servers.win2mac, serverEntry());
    if (members) assert.ok(f.read().includes(neighbor));
    f.run(true);
    assert.deepEqual(parse(f.read()).mcp_servers, members ? { other: { command: 'other', args: ['a'] } } : {});
    assert.ok(f.read().endsWith('} # team\n'));
  }
});

test('非法或非表配置原样保留，不创建备份或临时文件', (t) => {
  for (const source of ['[broken\n', 'mcp_servers = "incompatible"\n', '[[mcp_servers]]\ncommand="old"\n']) {
    const f = fixture(t, source);
    assert.throws(() => f.run(false));
    assert.equal(f.read(), source);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['config.toml']);
  }
});

test('如果改写内联登记会丢失原注释，登记器终止写入', (t) => {
  const source = 'mcp_servers = { win2mac.args = [1, # keep comment\n2], other = {} }\n';
  assert.ok(parse(source).mcp_servers.win2mac);
  const f = fixture(t, source);
  assert.throws(() => f.run(false), /保留原有配置和注释/);
  assert.equal(f.read(), source);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['config.toml']);
});

test('首次登记创建私有文件，移除不存在的登记不建文件', (t) => {
  const f = fixture(t);
  assert.equal(f.run(true), '本来就没有登记');
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.run(false), '已登记');
  assert.deepEqual(parse(f.read()).mcp_servers.win2mac, serverEntry());
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('手动配置正确转义 Windows 路径、引号和特殊字符', () => {
  const entry = { command: "C:\\O'Brien\\Win2Mac.exe", args: ['a"b\t\x7f'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  assert.deepEqual(parse(codexToml(entry)).mcp_servers.win2mac, entry);
});
