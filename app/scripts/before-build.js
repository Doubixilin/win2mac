'use strict';
// npm 默认只安装宿主平台的可选原生依赖。交叉打包时按项目锁文件补齐目标平台的 keyring。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function beforeBuild({ appDir, platform, arch }) {
  const target = platform.nodeName;
  if (target !== 'darwin' && target !== 'win32') return true;
  const suffix = target + '-' + arch + (target === 'win32' ? '-msvc' : '');
  const dependency = '@napi-rs/keyring-' + suffix;
  const relative = 'node_modules/' + dependency;
  const locked = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8')).packages[relative];
  if (!locked) throw new Error('项目锁文件中没有目标平台的依赖 ' + dependency);
  const dest = path.join(appDir, relative);
  const binary = 'keyring.' + suffix + '.node';
  if (fs.existsSync(path.join(dest, binary)) && require(path.join(dest, 'package.json')).version === locked.version) return true;

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-dependencies-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(appDir, name), path.join(temp, name));
    const args = ['ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--os=' + target, '--cpu=' + arch];
    const options = { cwd: temp, stdio: 'inherit' };
    if (process.env.npm_execpath) execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
    else execFileSync('npm', args, { ...options, shell: process.platform === 'win32' });
    const source = path.join(temp, relative);
    fs.accessSync(path.join(source, binary));
    fs.cpSync(source, dest, { recursive: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return true; // electron-builder 仍负责收集完整的生产依赖树
};
