# Remote Browser Bridge

**简体中文** · [English](README.en.md)

![version](https://img.shields.io/badge/version-1.16.1-7c8cf8) ![manifest](https://img.shields.io/badge/Chrome-MV3-4caf50) ![node](https://img.shields.io/badge/node-%3E%3D18-339933) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

让 **CodeNext**（云端 IDE / 容器）或 **AI Agent** 通过一个 Chrome 扩展**远程操控你本地的浏览器**。
纯 HTTP 长轮询，无需 WebSocket；扩展**只操控名为 `Remote Control` 的标签组**，其它标签页完全不受影响。

> Drive your local Chrome from a cloud IDE (CodeNext) or an AI agent, through a small MV3
> extension + a zero-dependency Node bridge. HTTP long-polling only. The extension touches
> **only** tabs inside a tab group named `Remote Control`.

> 💡 **一句话看懂**：算力在云端、浏览器在本地。它把云端的代码 / AI Agent 引到你**本地那个已经登录好的真实浏览器**上——用**你的会话、你的 IP、你的指纹**去操作网页，而不是在云端另开一个一无所有的浏览器。

> 🚀 **想直接跑起来？看 [QUICKSTART.md](QUICKSTART.md)** —— 拉下项目照着走即可部署（含 token 规则、服务运行、MCP 接入）。

---

## 功能亮点

- 🤖 **给 AI Agent 用（MCP）** — 内置零依赖 MCP server，Claude Code / Cursor 等可直接调用 `browser_snapshot`/`browser_click`/`browser_type` 等工具，用你本人的登录态操作网页。见 [mcp/README.md](mcp/README.md)。
- 🎯 **定位器 + 自动等待（Playwright 手感）** — `getByRole/getByText/getByLabel/getByTestId` 或 `locator({...})`，动作前自动等元素出现→可见→可用，免手写 `sleep`；穿透开放 Shadow DOM。
- 🧭 **结构化 ref 快照** — `snapshot_refs` 给每个可交互元素编号 `[eN]`，按编号点击/输入，比 CSS 选择器稳，对 LLM 友好。
- 🙋 **人工接管 + 钉钉通知** — 脚本/Agent 遇到登录/验证码可 `waitForHuman()` 暂停，控制台弹出接管横幅并推送钉钉，你处理完点「继续」再往下跑；`pauseIfRisky()` 检测到风控自动暂停。
- 🖥️ **后台操控** — 命令作用于「当前目标标签」而**不抢焦点**，你可以一边用别的标签/窗口，一边让它在后台自动化（仅截图因 Chrome 限制会临时切一下再切回）。
- 🔒 **安全隔离** — 只操控 `Remote Control` 标签组内的页面，其它标签页绝不触碰。
- 🔑 **强制 token 鉴权** — 所有 `/api/*` 都要求自动生成的 token；token 自动内嵌进控制台页、扩展与前端自动携带，`runner.js` 从 `.bridge-token` 自动读取，你几乎无感。
- 🧰 **40+ 指令** — 导航、点击/输入/按键、读取 DOM/文本/HTML、等待元素/文字、滚动、关闭弹窗、cookie、`iframe` 内操作、执行 JS。
- 🌐 **网络控制** — 抓包 `fetch`/`XHR`、`waitForNetworkIdle()` 等请求空闲、`route()` mock/abort 接口响应、用页面凭证发请求（`networkFetch`）。
- ✅ **Web-first 断言** — `expect(locator).toBeVisible()/toHaveText()/toBeChecked()…` 自动重试到超时。
- 🧩 **对话框自动处理 + 调试 trace** — `handleDialogs()` 让页面 `alert/confirm/prompt` 自动响应不卡死；`startTrace()/saveTrace()` 导出步骤时间线（动作/耗时/成败/可选截图）。
- 🔴 **录制生成脚本（codegen）+ iframe 穿透** — `startRecording()` 后手动操作，`saveScript()` 生成可运行脚本；定位器/快照自动穿透同源 iframe。
- 🎨 **Canvas 内容读取** — `readCanvasImage()` 导出已渲染 canvas 为图片交视觉模型 OCR（推荐）；`readCanvasFull()` 逐屏滚动导出兜底虚拟化 canvas；或 `install_resume_hook` 拦截 `fillText` 重排结构化文本。
- 📊 **控制台看板** — 标签页 / 截图 / 网络 / Cookie 四个面板，快捷按钮 + 命令工具栏。
- ⚙️ **零依赖，两种写法** — 纯 Node（`http`/`crypto`），支持灵活的 JS 脚本与简单的 JSON 声明式步骤。

---

## 为什么有价值

它的价值不在"能操控浏览器"（Puppeteer / Playwright 都能），而在**它操控的是哪一个浏览器**：你桌面上那个**已经登录、带着真实 cookie / IP / 指纹**的 Chrome。流经这条通道的是"**你的浏览器身份**"，不是机器访问。

对照常见方案：

| 维度 | **本方案** | VNC / RDP | Headless（云端 Puppeteer） |
|---|---|---|---|
| 谁操控谁 | 云端代码 / Agent → **操控你本地浏览器** | 你看 / 控远程机器的屏幕 | 云端开一个全新浏览器 |
| 登录态 / 2FA | ✅ 现成会话，无需重新登录 | ✅（但在远程机器上） | ❌ 需脚本登录、撞 2FA |
| IP / 指纹 | ✅ 你的住宅 IP + 真实指纹，天然过风控 | 远程机器的 | ❌ 数据中心 IP 易被标记 |
| 给代码 / Agent 调用 | ✅ 结构化 API + MCP | ❌ 只有像素 | ✅ |
| 人在环内 | ✅ 你看得见、能随时接管 | ✅ 但纯手动 | ❌ |
| 暴露面 | 极窄：只有一个标签组 | 整台机器 | —— |
| 网络穿透 | ✅ 长轮询过反代，无需入站端口 / VPN | 需端口 / 隧道 | 云端本地 |

**适合**：用你登录态操作网页的个人自动化；登录墙背后的数据读取；需要偶尔盯着 / 接管的半自动流程；给云端 AI Agent 一双"用你浏览器的手"。

**不适合**：大规模、无人值守地爬公开数据（用 headless 集群）；或"看 / 操作那台远程机器本身"（用 VNC / RDP）。

---

## 架构与技术原理

它**不是把某台机器反代给你**，而是一条**反向发起、被收窄到"执行浏览器动作"这一个能力的控制隧道**。关键点：云端**够不到**你桌面（你在 NAT / 防火墙后、没有公网 IP），所以**由你本地的扩展主动往外拨**、挂住一个长轮询，指令再顺着这条已开的出站连接推回来——和反向 SSH 隧道 / `ngrok` / webhook 中继是同一个思想。

![Remote Browser Bridge 架构 / Architecture](docs/architecture.svg)

**① 传输：HTTP 长轮询（不用 WebSocket）** — 扩展 `POST /api/connect` 拿到 `browserId`，再 `GET /api/poll` 被服务器挂住最多 25 秒：有指令立即返回，否则空返回再轮。云端 `POST /api/command` 会在服务端阻塞，直到扩展 poll 到 → 执行 → `POST /api/result` 回填才返回——对调用方看起来就是一次同步 RPC。选长轮询而非 WS，是因为纯 GET / POST 能干净地穿过任意 HTTP 反代（CodeNext 的 `/_/port/`）和公司代理，无需 upgrade 协商。**在这儿"能穿透"是特性，不是缺陷。**

**② 方向反转做 NAT 穿透** — 云端拨不进你桌面，于是本地扩展出站发起 + 挂 poll；控制方向（云 → 本地）跑在这条**由本地发起**的连接上。

**③ 注入控制台页 → 顺带过掉外层鉴权** — 中继 `content.js` 只在 bridge 控制台页激活（靠注入的 `<meta name="remote-bridge-console">` 识别）。跑在那个页面里，它的 `fetch` 与 bridge 服务**同源**，自动带上 CodeNext 的登录 cookie，于是能**透明地过掉 CodeNext 自己的鉴权代理**（否则跨域会被拦）。

**④ 执行路径** — 中继（页面）→ `chrome.runtime.sendMessage` → background service worker → 用 `chrome.scripting.executeScript`（DOM 操作 / ref 快照 / canvas·网络钩子跑在 **MAIN 世界**）、`chrome.tabs`、`chrome.cookies`、`chrome.tabGroups` 落地，**只碰 `Remote Control` 标签组**。

**⑤ 两层鉴权** — 外层是 CodeNext 自己的登录代理（`/_/port/`），内层是我们每个 `/api/*` 的 Bearer token（已内嵌进控制台页，自动携带）。

### 代码结构

- **`extension/`** — Chrome MV3 扩展（解压源码，可直接"加载已解压的扩展"）
- **`server/server.js`** — bridge 服务：会合点 + REST API + 控制台看板（零依赖）
- **`server/runner.js`** — 通用自动化引擎（`Bridge` 类 + CLI）
- **`server/notify.js`** — 钉钉通知（零依赖）
- **`mcp/server.js`** — MCP server，给 AI Agent 调用（[说明](mcp/README.md)）
- **`examples/`** — 通用示例（[说明与 API 参考](examples/README.md)）

---

## 安全模型

- **只碰受控标签组**：扩展仅操控 `Remote Control` 组内的标签页。
- **强制 token 鉴权**：所有 `/api/*` 端点都要求一个自动生成的 token；token 会内嵌进控制台页面并由扩展/前端自动携带，同机的 `runner.js` 从 `.bridge-token` 自动读取 —— 你几乎无感，但外部无 token 者一律拒绝。
- **控制台输出全部转义**，避免被恶意网页标题注入脚本。
- ⚠️ 该工具能读取受控标签页的 cookie、执行 JS。请勿把服务暴露到不受信任的网络：纯本机使用设 `BRIDGE_HOST=127.0.0.1`；经 CodeNext 访问时依赖其自带的登录鉴权层。

---

## 安装与使用

### 1. 安装 Chrome 扩展

1. 打开 `chrome://extensions`，开启右上角**开发者模式**
2. 点**加载已解压的扩展程序**，选择本仓库的 **`extension/`** 目录

### 2. 启动 bridge 服务（在**仓库根目录**）

```bash
npm start                 # = node server/server.js，默认端口 3006

# 后台运行：
# nohup npm start > /tmp/bridge.log 2>&1 &
```

> 在仓库根目录启动，token（`.bridge-token`）会落在根目录，runner / MCP 都能自动读到。详见 [QUICKSTART.md](QUICKSTART.md) 第 4 节。

可用环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BRIDGE_PORT` | `3006` | 监听端口 |
| `BRIDGE_HOST` | `0.0.0.0` | 监听网卡；纯本机用 `127.0.0.1` 更安全 |
| `BRIDGE_TOKEN` | 自动生成 | 鉴权 token；不设则自动生成并写入 `.bridge-token` |

### 3. 连接

1. 打开控制台页面：
   - CodeNext：`https://你的域名/_/port/3006/`
   - 本机：`http://localhost:3006/`
2. 点击 Chrome 工具栏的扩展图标，把上面的控制台 URL 粘进输入框 → **💾 保存** → **🔗 打开控制台**
   （token 已内嵌在页面里，无需手动填）

### 4. 创建受控标签组

在 Chrome 里右键任意标签页 → **添加到新组**，把组名改成 **`Remote Control`**（一字不差），
再把要自动化的网站拖进这个组。也可在控制台里执行 `create_group`。

连接成功后，控制台左栏会显示受控标签页，右上角显示 🟢 已连接。点「📸 截图」测试。

---

## 跑自动化

```bash
# JS 脚本（推荐）
node server/runner.js examples/quickstart.js
node server/runner.js examples/quickstart.js https://news.ycombinator.com

# JSON 声明式
node server/runner.js examples/demo.json

# 指定端口 / token（同机通常无需，token 会自动读取 .bridge-token）
node server/runner.js examples/quickstart.js --port=3006 --token=xxx
```

完整 API 列表与写脚本方式见 **[examples/README.md](examples/README.md)**。

---

## 给 AI Agent 用（MCP）

内置零依赖 MCP server，让 Claude Code / Claude Desktop / Cursor 等直接用你的浏览器。前提是 bridge 服务已启动、扩展已连上。在客户端的 `mcpServers` 里加：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/绝对路径/remote-browser-bridge/mcp/server.js"],
      "env": { "BRIDGE_PORT": "3006", "BRIDGE_TOKEN": "见 bridge 启动日志" }
    }
  }
}
```

提供 `browser_snapshot` / `browser_navigate` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_wait_for_human` 等工具。详见 **[mcp/README.md](mcp/README.md)**。

---

## 人工接管 + 钉钉通知

脚本或 Agent 遇到必须真人操作的环节（登录、验证码、二次确认），可以暂停等你处理：

```js
// 无条件请人工，阻塞到你在控制台点「继续」
await bridge.waitForHuman('请在浏览器里登录后点「继续」');

// 或：检测到风控/验证码才暂停
await bridge.pauseIfRisky();
```

调用后**控制台顶部弹出接管横幅**（[继续] / [中止]），同时（若配置了钉钉）推送通知。MCP 里对应 `browser_wait_for_human`。

配置钉钉（可选，机器人 webhook）——在启动 runner / MCP 前设置环境变量：

```bash
export DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=xxx"  # 或只填 access_token
export DINGTALK_SECRET="加签密钥"   # 若机器人用「加签」安全设置
# 也支持「关键词」安全设置：export DINGTALK_KEYWORD="通知"
```

未配置时通知静默跳过，人工接管横幅照常工作。示例见 [examples/handoff.js](examples/handoff.js)。

---

## 说明

- **后台操控**：命令默认作用于「当前目标标签」，不会把它切到前台——你可以一边用别的标签/窗口，一边让它在后台自动化。`switch_tab` 才会切到前台；`screenshot` 因 Chrome 限制会临时切一下再切回。详见 [CHANGES.md](CHANGES.md) 的 v1.5.0。
- 扩展每 30 秒推送一次受控标签页信息到控制台（也会在页面变化时即时推送）。
- Bridge 服务 90 秒无心跳会自动断开该会话；服务重启后刷新控制台页面即可重连。
- 本版本相对原始 v1.3.0 的全部修复见 **[CHANGES.md](CHANGES.md)**。

---

## 常见问题

**扩展显示「未连接」/ 连不上？**
- 确认控制台 URL 粘贴正确（`.../3006/`，注意结尾斜杠），且服务已启动。
- 确认已建好名为 `Remote Control` 的标签组（一字不差），或在控制台执行 `create_group`。
- 改动过扩展后要在 `chrome://extensions` **重新加载扩展**，并**刷新控制台页面**。

**runner / 命令报 `401 unauthorized`？**
- token 不一致。`runner.js` 默认读运行目录下的 `.bridge-token`，请在 **server 的工作目录**里运行它；
  或显式指定：设 `BRIDGE_TOKEN` 环境变量、或传 `--token=xxx`。控制台页会自动内嵌 token，一般无需手动处理。

**端口不是 3006？**
- 用 `BRIDGE_PORT` 改端口，控制台 URL 里的端口、`runner --port` 要和它一致。

**截图时画面闪了一下？**
- 正常。`captureVisibleTab` 只能截前台标签，所以会临时切到目标标签、截完再切回你原来的标签（返回值带 `refocused`）。

**提示「该页面不允许脚本注入」？**
- `chrome://`、Chrome 网上应用店等受限页面无法注入脚本，换普通网页即可。

**Canvas 文本 / 网络抓包读到的是空的？**
- 需 v1.4.0+（钩子改在页面**主世界**注入才生效）；且 Canvas 钩子要在页面开始绘制**之前**用 `install_resume_hook` 安装。

**Service Worker 一会儿就断、页面信息不推了？**
- MV3 会回收 SW；本项目已用 `storage.session` + `chrome.alarms` 恢复。保持控制台标签页开着即可。

**有多个受控标签，命令作用在哪个？**
- 作用于「当前目标标签」（侧栏带 🎯）。用 `set_target`（或控制台点侧栏标签）设为后台目标；`switch_tab`（或 ▶ 按钮）才会切到前台。

---

## 免责声明

本工具用于操控**你自己的、已登录的**浏览器，便于开发与自动化。使用它访问任何第三方网站时，
请遵守该网站的服务条款、`robots` 规则与当地法律，控制访问频率，仅用于你有权访问的数据。
作者不对滥用负责。

## License

[MIT](LICENSE) © 2026 zvv1999
