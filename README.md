# Remote Browser Bridge

![version](https://img.shields.io/badge/version-1.5.0-7c8cf8) ![manifest](https://img.shields.io/badge/Chrome-MV3-4caf50) ![node](https://img.shields.io/badge/node-%3E%3D18-339933) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

让 **CodeNext**（云端 IDE / 容器）通过一个 Chrome 扩展**远程操控你本地的浏览器**。
纯 HTTP 长轮询，无需 WebSocket；扩展**只操控名为 `Remote Control` 的标签组**，其它标签页完全不受影响。

> Drive your local Chrome from a cloud IDE (CodeNext) through a small MV3 extension + a
> zero-dependency Node bridge. HTTP long-polling only. The extension touches **only** tabs
> inside a tab group named `Remote Control`.

---

## 功能亮点

- 🤖 **给 AI Agent 用（MCP）** — 内置零依赖 MCP server，Claude Code / Cursor 等可直接调用 `browser_snapshot`/`browser_click`/`browser_type` 等工具，用你本人的登录态操作网页。见 [mcp/README.md](mcp/README.md)。
- 🧭 **结构化 ref 快照** — `snapshot_refs` 给每个可交互元素编号 `[eN]`，按编号点击/输入，比 CSS 选择器稳，对 LLM 友好。
- 🙋 **人工接管 + 钉钉通知** — 脚本/Agent 遇到登录/验证码可 `waitForHuman()` 暂停，控制台弹出接管横幅并推送钉钉，你处理完点「继续」再往下跑；`pauseIfRisky()` 检测到风控自动暂停。
- 🖥️ **后台操控** — 命令作用于「当前目标标签」而**不抢焦点**，你可以一边用别的标签/窗口，一边让它在后台自动化（仅截图因 Chrome 限制会临时切一下再切回）。
- 🔒 **安全隔离** — 只操控 `Remote Control` 标签组内的页面，其它标签页绝不触碰。
- 🔑 **强制 token 鉴权** — 所有 `/api/*` 都要求自动生成的 token；token 自动内嵌进控制台页、扩展与前端自动携带，`runner.js` 从 `.bridge-token` 自动读取，你几乎无感。
- 🧰 **40+ 指令** — 导航、点击/输入/按键、读取 DOM/文本/HTML、等待元素/文字、滚动、关闭弹窗、cookie、`iframe` 内操作、执行 JS。
- 🌐 **网络抓包 + 页面级请求** — 在页面**主世界**拦截 `fetch`/`XHR`，或用页面自身凭证发请求（`networkFetch`）。
- 🎨 **Canvas 文本读取** — 拦截 canvas 绘制文本并按坐标重排成可读文本（适用于用 canvas 渲染正文的页面）。
- 📊 **控制台看板** — 标签页 / 截图 / 网络 / Cookie 四个面板，快捷按钮 + 命令工具栏。
- ⚙️ **零依赖，两种写法** — 纯 Node（`http`/`crypto`），支持灵活的 JS 脚本与简单的 JSON 声明式步骤。

---

## 架构

```
 你的本地 Chrome                      CodeNext 容器
┌────────────────────┐   HTTP 长轮询   ┌──────────────────────────┐
│ 扩展 (background)   │ ◀───────────── │ server.js  (bridge 服务)  │
│  执行指令，仅操控    │ ─────────────▶ │  控制台看板 + REST API     │
│  "Remote Control"   │                └───────────┬──────────────┘
│  标签组             │                            │
│ 扩展 (content 中继) │                ┌───────────▼──────────────┐
│  注入到控制台页面    │                │ runner.js  (自动化引擎)    │
└────────────────────┘                │  + 你的脚本 / JSON 步骤     │
                                       └──────────────────────────┘
```

- **`extension/`** — Chrome MV3 扩展（解压源码，可直接"加载已解压的扩展"）
- **`server/server.js`** — bridge 服务：控制台页面 + REST API（零依赖，纯 Node）
- **`server/runner.js`** — 通用自动化引擎（`Bridge` 类 + CLI）
- **`mcp/server.js`** — 零依赖 MCP server，给 AI Agent 调用（[说明](mcp/README.md)）
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

### 2. 启动 bridge 服务（在 CodeNext 容器 / 本机）

```bash
cd server
node server.js            # 默认端口 3006

# 后台运行：
# nohup node server.js > /tmp/bridge.log 2>&1 &
```

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
