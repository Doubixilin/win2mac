// 临时目录和进程内凭据替身，测试可在没有桌面钥匙串的 CI 运行。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareIdentity, readSigningKey } = require('../app/src/identity');
const { generateKeys, ControlHost } = require('../app/src/control');

function memoryCredential(initial = null) {
  let value = initial;
  return { getPassword: () => value, setPassword: (next) => { value = next; } };
}

test('首次生成的私钥只写系统凭据，桌面和 MCP 再次打开得到同一个身份', () => {
  const store = memoryCredential();
  const first = prepareIdentity({ deviceId: 'test-device' }, store);
  assert.equal(first.settings.keyPrivate, undefined);
  assert.equal(store.getPassword(), first.privateKey);
  assert.equal(readSigningKey(first.settings, store), first.privateKey);
  assert.deepEqual(prepareIdentity(first.settings, store), first);
});

test('升级迁移保留公钥、授权、配对，写盘中断后仍可重试', () => {
  const keys = generateKeys();
  const original = { deviceId: 'test-device', keyPublic: keys.publicKey, keyPrivate: keys.privateKey, token: 'synthetic', controllers: {} };
  const store = memoryCredential();
  const result = prepareIdentity(original, store);
  assert.deepEqual(result.settings, { deviceId: original.deviceId, keyPublic: keys.publicKey, token: 'synthetic', controllers: {} });
  assert.equal(readSigningKey(result.settings, store), keys.privateKey);
  assert.throws(() => readSigningKey(original, memoryCredential()), /打开 Win2Mac/);
  assert.deepEqual(prepareIdentity(original, store), result);
});

test('凭据锁定、未保存或公钥不一致时保留旧身份', () => {
  const keys = generateKeys();
  const original = { keyPublic: keys.publicKey, keyPrivate: keys.privateKey };
  assert.throws(() => prepareIdentity(original, { getPassword: () => null, setPassword: () => {} }), /未能存入/);
  assert.throws(() => prepareIdentity(original, { getPassword: () => { throw Error('locked'); } }), /locked/);
  assert.equal(original.keyPrivate, keys.privateKey);
  assert.throws(() => prepareIdentity(original, memoryCredential(generateKeys().privateKey)), /不一致/);
  assert.throws(() => prepareIdentity({ keyPublic: keys.publicKey }, memoryCredential()), /找不到/);
  assert.throws(() => readSigningKey({ keyPublic: keys.publicKey }, memoryCredential(generateKeys().privateKey)), /无法读取/);
});

test('远程读取和取回都保护配置及其别名，普通文档仍可读取和取回', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-identity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const protectedDir = path.join(dir, 'config');
  await fs.mkdir(protectedDir);
  const cfg = path.join(protectedDir, 'config.json');
  const hard = path.join(dir, 'config-hardlink');
  const linked = path.join(dir, 'config-directory-link');
  const doc = path.join(dir, 'config-notes.txt');
  await fs.writeFile(cfg, 'synthetic settings');
  await fs.writeFile(doc, 'notes');
  await fs.link(cfg, hard);
  await fs.symlink(protectedDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  let uploads = 0;
  const relay = { uploadDirect: async (file) => {
    assert.equal(await fs.readFile(file, 'utf8'), 'notes');
    uploads++;
    return { id: 'item', size: 5, name: path.basename(file), sha256: '0'.repeat(64) };
  } };
  const host = new ControlHost({ relay, extras: { protectedDir } });
  for (const file of [cfg, path.join(linked, 'config.json'), hard]) {
    for (const method of ['fs.read', 'fs.sendVerified']) {
      await assert.rejects(host._dispatch(method, { path: file }, { from: 'test-peer' }), { code: 'protected-file' });
    }
  }
  assert.equal(uploads, 0);
  assert.equal((await host._dispatch('fs.read', { path: doc }, {})).content, 'notes');
  assert.equal((await host._dispatch('fs.sendVerified', { path: doc }, { from: 'test-peer' })).item, 'item');
  assert.equal(uploads, 1);
});
