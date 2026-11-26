'use strict';
const crypto = require('crypto');
const { generateKeys } = require('./control');

function deviceCredential(deviceId) {
  const { Entry } = require('@napi-rs/keyring');
  return new Entry('com.doubilin.win2mac.signing', deviceId);
}

function publicKeyOf(privateKey) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('设备签名密钥格式无效');
  return crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
}

// 写入并读回凭据后，调用方才用返回的配置原子替换旧文件。迁移中断可安全重试。
function prepareIdentity(config, credential = deviceCredential(config.deviceId)) {
  const stored = credential.getPassword();
  if (stored && config.keyPrivate && stored !== config.keyPrivate) throw new Error('系统凭据与旧设备私钥不一致');
  let privateKey = stored || config.keyPrivate;
  if (!privateKey) {
    if (config.keyPublic) throw new Error('系统凭据中找不到已有设备的签名私钥');
    privateKey = generateKeys().privateKey;
  }
  const publicKey = publicKeyOf(privateKey);
  if (config.keyPublic && config.keyPublic !== publicKey) throw new Error('设备公钥与签名私钥不匹配');
  if (!stored) {
    credential.setPassword(privateKey);
    if (credential.getPassword() !== privateKey) throw new Error('设备签名私钥未能存入系统凭据');
  }
  const { keyPrivate, ...settings } = config;
  return { privateKey, settings: { ...settings, keyPublic: publicKey } };
}

function readSigningKey(config, credential) {
  const key = (credential || deviceCredential(config.deviceId)).getPassword();
  if (!key || publicKeyOf(key) !== config.keyPublic) throw new Error('无法读取设备签名密钥，请在本机打开 Win2Mac 检查系统凭据');
  return key;
}

module.exports = { prepareIdentity, readSigningKey };
