'use strict';
// 生成所有图标资源：npm run icons（用 Electron 把 SVG 渲染成 PNG，再拼 .icns / .ico）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const BUILD = path.join(ROOT, 'build');

const GLYPH = '<path d="M10 18h26M28 10l8 8-8 8"/><path d="M38 32H12M20 24l-8 8 8 8"/>';
const GRAD = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f7dff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs>';

// macOS 风格：1024 画布里留边的圆角方块
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${GRAD}
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#g)"/>
  <g transform="translate(212 212) scale(12.5)" fill="none" stroke="#fff" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</g></svg>`;
// Windows 图标和托盘：铺满的圆角方块，小尺寸下更清楚
const fullIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${GRAD}
  <rect x="1" y="1" width="46" height="46" rx="11" fill="url(#g)"/>
  <g transform="translate(7.2 7.2) scale(.7)" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</g></svg>`;
// macOS 菜单栏模板图：纯黑 + 透明，系统会自动适配深浅色
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <g transform="translate(2.4 2.4) scale(.9)" fill="none" stroke="#000" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</g></svg>`;

async function render(win, svg, size) {
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  win.setContentSize(size, size);
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 150));
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const s = img.getSize();
  if (s.width !== size || s.height !== size) img = img.resize({ width: size, height: size, quality: 'best' });
  return img.toPNG();
}

function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, o);
    header.writeUInt8(size >= 256 ? 0 : size, o + 1);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.dock?.hide();
app.whenReady().then(async () => {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, width: 64, height: 64, webPreferences: { offscreen: true } });
  const out = (dir, name, data) => { fs.writeFileSync(path.join(dir, name), data); console.log('wrote', name, data.length); };

  out(ASSETS, 'icon.png', await render(win, appIcon, 512));
  out(ASSETS, 'drag.png', await render(win, fullIcon, 64));
  out(ASSETS, 'tray.png', await render(win, fullIcon, 16));
  out(ASSETS, 'tray@2x.png', await render(win, fullIcon, 32));
  out(ASSETS, 'trayTemplate.png', await render(win, template, 18));
  out(ASSETS, 'trayTemplate@2x.png', await render(win, template, 36));
  out(BUILD, 'icon.png', await render(win, appIcon, 1024));

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of icoSizes) pngs.push({ size, data: await render(win, fullIcon, size) });
  out(BUILD, 'icon.ico', ico(pngs));

  if (process.platform === 'darwin') {
    const set = path.join(BUILD, 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), await render(win, appIcon, s));
      fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), await render(win, appIcon, s * 2));
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
    console.log('wrote icon.icns');
  }
  app.quit();
});
