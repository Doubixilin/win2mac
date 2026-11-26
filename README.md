# Win2Mac

在 Windows 和 Mac 之间互传文字、文件、文件夹的桌面小工具。内容经**你自己的服务器**中转，不依赖任何第三方网盘或聊天软件。

Drag-and-drop text, files and folders between Windows and Mac through your own relay server. A tiny always-on-top drop target, a tray icon and a global hotkey on each machine; a single-file, zero-dependency Node relay on your server.

<p>
  <img src="docs/main.png" width="300" alt="主界面">
  <img src="docs/settings.png" width="300" alt="设置">
</p>

## 功能

- **拖**：把文件、文件夹或选中的文字拖到屏幕上的悬浮球，或拖进主界面，松手就发。
- **点**：主界面里“选择文件”（可多选）、“选择文件夹”（可多选）。
- **贴**：复制之后按全局快捷键（默认 `Ctrl+Alt+S`，Mac 上是 `Control+Option+S`）把剪贴板发出去；
  或者在主界面里直接 `Ctrl/⌘+V`。剪贴板里是文件、文字、截图都可以。
- **打字**：主界面输入框回车发送。

对方收到后：

- 文字自动进剪贴板，直接粘贴即可；截图同时存成文件并放进剪贴板；
- 文件存到 `下载/Win2Mac/`，系统通知点一下定位到文件；记录里的文件可以直接拖出去；
- 同名文件不覆盖，自动变成 `名字 (2).ext`；文件夹保持原有目录结构。

对方不在线也能发：内容暂存在服务器，对方上线后自动收到；所有设备收完即从服务器删除，没人收的默认最多留 7 天。

悬浮球：单击开关主界面，按住拖动换位置，右键出菜单。右下角小点绿色 = 对方在线，黄色 = 对方离线，灰色 = 没连上服务器。

**给 AI 用的远程控制（MCP）**：装了 Win2Mac 的电脑之间，本机的 AI 客户端可以通过它在另一台电脑上执行命令、读写文件、收发文件、读写剪贴板、截图。默认关闭，详见下文“[远程控制（MCP）](#远程控制mcp)”。

配对的设备不限于两台：同一个口令下的所有设备互相可见，发出的内容其他设备都会收到。

## 结构

```
server/server.js     中转服务，Node 单文件零依赖（SSE 推送 + HTTP 分片上传 / 断点下载）
server/deploy/       systemd 单元、nginx 反代片段、环境变量示例
app/                 桌面客户端（Electron）
  src/core.js        传输核心，纯 Node，不依赖 Electron
  src/control.js     远程控制：设备密钥、签名验签、被控端执行器、控制端
  src/mcp.js         MCP 服务（stdio），把远程控制包装成 AI 可调用的工具
  src/mcp-register.js  把 MCP 服务登记到本机的 AI 客户端
  src/main.js        主进程：托盘、悬浮窗、快捷键、剪贴板、通知
  src/ui/            主界面与悬浮球页面
test/e2e.js          协议端到端测试
test/control.js      远程控制与 MCP 的端到端测试（权限分级、伪造、重放、文件收发）
test/mcp-call.js     启动一个 MCP 进程并调用工具，验证已安装的程序
test/smoke.js        启动真实应用的冒烟测试（模拟拖放、剪贴板、双向收发）
test/live.js         对着已部署的服务互传一次并测速
test/probe.js        用临时设备向所有已配对设备发文件，验证真实安装
```

## 部署中转服务

需要一台有公网 HTTPS 入口的 Linux 服务器，装有 Node 18+ 和 nginx。

```bash
# 1. 独立的低权限用户和目录
useradd --system --no-create-home --shell /sbin/nologin win2mac
install -d -m 755 /opt/win2mac /etc/win2mac
install -d -m 750 -o win2mac -g win2mac /var/lib/win2mac

# 2. 程序、配置、服务单元
install -m 644 server/server.js /opt/win2mac/server.js
install -m 600 server/deploy/relay.env.example /etc/win2mac/relay.env
install -m 644 server/deploy/win2mac-relay.service /etc/systemd/system/

# 3. 生成口令，填进 /etc/win2mac/relay.env 的 W2M_TOKEN=
openssl rand -hex 32

# 4. 启动
systemctl daemon-reload
systemctl enable --now win2mac-relay
```

服务只监听本机回环地址（默认 `127.0.0.1:18700`），再用 nginx 把它挂到一个 HTTPS 地址下。
`server/deploy/nginx-location.conf` 是一个可以直接 `include` 进现有 `server {}` 的片段（默认子路径 `/w2m/`）：

```nginx
server {
    # ……你已有的 HTTPS 站点配置……
    include /etc/win2mac/nginx-location.conf;
}
```

`nginx -t && systemctl reload nginx` 之后验证：

```bash
curl -H "Authorization: Bearer <口令>" https://你的域名/w2m/api/ping   # {"ok":true,...}
curl https://你的域名/w2m/api/ping                                     # 401
```

可调的环境变量见 `server/deploy/relay.env.example`（端口、数据目录、保留天数、暂存空间上限）。

## 安装客户端

```bash
cd app
npm install
npm start            # 开发运行
npm run dist:mac     # 产出 dist/*.dmg（arm64）
npm run dist:win     # 产出 dist/*.exe 安装包（x64，可以在 Mac 上交叉打包，不需要 wine）
npm run icons        # 重新生成图标
```

第一台设备：打开设置，填入服务器地址（例如 `https://你的域名/w2m`）和口令，保存。
其余设备：在已配好的设备上点“设置 → 复制配对码”，到新设备的设置里粘贴并应用即可。
配对码里包含服务器地址和口令，等同于口令本身，不要外传。

换机或重装后留下的旧设备，可以在“设置 → 其他设备”里移除，否则发给它的内容要等过期才会从服务器清掉。

## 远程控制（MCP）

让一台电脑上的 AI（Claude、Codex、Cursor、opencode 等任何支持 MCP 的客户端）操作另一台装了 Win2Mac 的电脑，
不需要 SSH、隧道，也不用每次向 AI 交代“那台机器怎么连、是什么系统”。

```
AI 客户端 ──stdio──▶ 本机的 Win2Mac MCP 进程 ──▶ 中转服务 ──▶ 对方电脑上运行着的 Win2Mac ──▶ 执行并返回
```

### 开启

1. **在被控的电脑上授权**：Win2Mac 设置 → 远程控制，给发起控制的那台设备选“只读”或“完全控制”。
   授权前核对列表里显示的指纹，和对方设置里的“本机指纹”一致。默认是“不允许”。
2. **在发起控制的电脑上接入 AI 客户端**：设置 → 远程控制 → “接入本机的 AI 客户端”，会自动登记到本机装了的
   Kimi Code、ZCode、Codex、Claude 桌面版（只新增或更新名为 `win2mac` 的一项，改前留备份）。命令行等价做法：

   ```bash
   ELECTRON_RUN_AS_NODE=1 /Applications/Win2Mac.app/Contents/MacOS/Win2Mac \
     /Applications/Win2Mac.app/Contents/Resources/app.asar/src/mcp-register.js          # 加 --remove 取消登记
   ```

   Claude Code 用它自己的命令登记：`claude mcp add-json --scope user win2mac '<下面 win2mac 那一项的 JSON>'`。
   其他客户端用“复制 MCP 配置”手动粘贴。配置长这样，用的是 Win2Mac 自带的运行时，不需要另装 Node：

```json
{
  "mcpServers": {
    "win2mac": {
      "command": "/Applications/Win2Mac.app/Contents/MacOS/Win2Mac",
      "args": ["/Applications/Win2Mac.app/Contents/Resources/app.asar/src/mcp.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### 提供的工具

| 工具 | 作用 | 需要的权限 |
|---|---|---|
| `list_devices` | 列出其他设备：是否在线、系统、主目录、用什么 shell | 只读 |
| `run_command` | 执行命令，返回输出和退出码（带超时，超长输出保留头尾） | 完全控制 |
| `list_directory` / `read_file` | 列目录、读文本文件 | 只读 |
| `write_file` | 写或追加文本文件 | 完全控制 |
| `copy_file_to_device` | 把本机文件传到对方指定位置，大小不限 | 完全控制 |
| `copy_file_from_device` | 把对方的文件取到本机，大小不限 | 只读 |
| `get_clipboard` / `take_screenshot` | 读剪贴板、截屏 | 只读 |
| `set_clipboard` / `open_on_device` | 写剪贴板、用默认程序打开文件或网址 | 完全控制 |

命令在对方的**桌面会话**里以当前登录用户身份运行，所以能启动图形程序、能截图。
Windows 上用系统自带的 PowerShell 执行，输出统一成 UTF-8，不加载用户 profile；macOS 上用登录 shell。

### 安全模型

远程执行比传文件危险得多，所以这部分**不信任中转服务器**：

- 每台设备有自己的 Ed25519 密钥，私钥只留在本机。请求由发起方签名，被控方只执行“本机用户授权过的那把公钥”签出的请求；
  应答由被控方签名，发起方按首次见到并记下的公钥验签，公钥变了会报错而不是默默接受。
- 所以只拿到中转口令、或者攻破中转服务器，都**不能**让任何一台设备执行命令；改内容、重放旧请求、过期请求都会被拒绝。
- 每台设备单独授权，分“只读”和“完全控制”两档，默认不允许。
- 被远程操作时悬浮球会闪橙色；每次操作（包括被拒绝的）都记在本机的 `control.log` 里，设置页能看到最近几条。
- 请求和结果经中转时是明文（外层有 HTTPS），中转能看到内容但伪造不了。
- **给 AI 客户端的建议**：`run_command`、`write_file` 这类会改动对方电脑的工具保留人工确认，不要设成自动放行——
  AI 读到不可信内容时，可能被诱导去对另一台电脑下命令。

### 限制

- 对方电脑要开着、已登录、Win2Mac 在运行；不在线时直接报错，不会排队等它上线再执行。
- macOS 上截图需要给 Win2Mac“录屏”权限（系统设置 → 隐私与安全性）。
- 一次只传单个文件，文件夹请先打包；鼠标键盘级别的界面操控还没有做。
- Windows 上个别老程序（如 `hostname.exe`）会无视编码设置输出 GBK，显示成乱码；换用 PowerShell 自己的写法（如 `$env:COMPUTERNAME`）即可。
- 如果某个客户端不支持给 MCP 进程传环境变量，直接用 `Win2Mac 可执行文件 + mcp.js 路径` 启动也可以，只是启动稍慢。
- 中转服务需要是带 `/api/rpc` 的版本，旧部署要先更新 `server.js`。

## 测试

```bash
node test/e2e.js                                  # 协议测试，本地起一个临时服务
node test/control.js                              # 远程控制与 MCP 测试
cd app && npx electron ../test/smoke.js ./shots   # 启动真实应用，会短暂占用剪贴板并弹出窗口
```

`test/live.js` 和 `test/probe.js` 是对着真实部署跑的，会向**所有在线的已配对设备**发送测试内容。

## 速度

上传走的是你到服务器的上行，下载走的是服务器的出口带宽，通常后者是瓶颈。
小带宽的云服务器上，文字、截图、文档基本无感，大文件接收会比较慢。

## 安全说明

- 远程控制另有一层设备密钥签名，见上文“安全模型”。
- 所有接口都要带口令（Bearer token），口令比较使用定长哈希后的常量时间比较；外面应当套 HTTPS。
- 内容在服务器上是**明文暂存**的，没有做端到端加密——请只部署在你信任的服务器上。
- 服务以独立低权限用户运行，systemd 单元里限制了它只能写自己的数据目录。
- 客户端渲染进程开启了上下文隔离和 CSP，收到的文字一律按纯文本显示。

## License

[MIT](LICENSE)
