'use strict';
// 在 Mac 上交叉打包 Windows 版时，electron-builder 需要 wine 才能改 exe 的图标和版本信息。
// 这里用纯 JS 的 resedit 做同样的事，就不需要 wine 了。
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const info = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${info.productFilename}.exe`);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, icon.icons.map((i) => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const [major, minor, patch] = info.version.split('.').map((n) => parseInt(n, 10) || 0);
    vi.setFileVersion(major, minor, patch, 0, 1033);
    vi.setProductVersion(major, minor, patch, 0, 1033);
    for (const lang of vi.getAllLanguagesForStringValues()) {
      vi.setStringValues(lang, {
        ProductName: info.productName, FileDescription: info.productName, CompanyName: 'Doubixilin',
        InternalName: info.productName, OriginalFilename: `${info.productFilename}.exe`, LegalCopyright: '',
      });
    }
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • after-pack: 已写入 exe 图标和版本信息');
};
