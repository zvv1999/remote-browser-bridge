# 快速开始 / QUICKSTART

从零把 Remote Browser Bridge 跑起来。拉下项目照着走即可。

> 一句话：**bridge 服务** + **Chrome 扩展** 连起来后，你就能用脚本 / AI Agent 操控你本地那个**已登录的浏览器**。

---

## 0. 前置条件

- **Node.js ≥ 18**（`node -v` 确认）
- **Chrome**（或基于 Chromium 的浏览器）
- 无需 `npm install` —— 本项目**零依赖**，只用 Node 内置模块。

## 1. 拉取项目

```bash
# 用 gh（推荐）
gh repo clone zvv1999/remote-browser-bridge
# 或用 git（私有库需已配置好凭证）
git clone https://github.com/zvv1999/remote-browser-bridge.git

cd remote-browser-bridge
```

## 2. 本机 3 步跑通

### ① 启动 bridge 服务（在仓库根目录）

```bash
npm start            # 等价于 node server/server.js，默认端口 3006
```

启动日志会打印 `Token : xxxx` 和 `Host / Port`。**保持这个终端开着。**

> 🔑 **务必在仓库根目录启动**（`npm start` 会保证这一点）。服务会把 token 写到当前目录的
> `.bridge-token`；在根目录启动 = token 落在仓库根，后面 runner / MCP 都能自动读到。见 [第 4 节](#4-token-规则统一)。

### ② 加载 Chrome 扩展

1. Chrome 打开 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本仓库的 **`extension/`** 目录
4. 扩展需要 **`debugger` 权限**（用于读 canvas 简历时派发可信滚轮，见下方「读 canvas 简历」一节）——若 Chrome 提示则**允许**。读简历时顶部会短暂出现“调试此浏览器”黄条，读完自动消失。

> ⚠️ **改了扩展代码后**：`chrome://extensions` 点刷新 🔄 **还不够**——必须**再把控制台页面（`http://localhost:3006/`）⌘R 刷新一次**，中继才会用新版 content.js 重连；否则 `/api/browsers` 里的握手版本还是旧的、命令可能落到旧代码。确认 `chrome://extensions` 卡片上的版本号与仓库一致，且只装了**一个** Remote Bridge。

### ③ 连接 + 建受控标签组

1. 浏览器打开控制台页面：`http://localhost:3006/`
2. 点 Chrome 工具栏的**扩展图标** → 把 `http://localhost:3006/` 粘进输入框 → **💾 保存** → **🔗 打开控制台**
   （token 已内嵌在页面里，**无需手动填**）
3. 控制台右下角出现 🟢 **已连接**
4. Chrome 里右键任意标签页 → **添加到新组** → 组名改成 **`Remote Control`**（一字不差）
5. 把要自动化的网站拖进这个组

### ✅ 验证

另开一个终端，在**仓库根目录**跑：

```bash
node server/runner.js examples/quickstart.js https://example.com
```

能打印页面标题 / 链接数 = 全链路通了。

---

## 3. 运行服务的几种方式

```bash
npm start                                   # 前台，仓库根目录（推荐）

nohup npm start > /tmp/bridge.log 2>&1 &     # 后台常驻

BRIDGE_PORT=3007 npm start                   # 改端口
BRIDGE_HOST=127.0.0.1 npm start              # 纯本机监听（更安全，见下）
BRIDGE_TOKEN=my-fixed-token npm start        # 固定 token（多机/容器场景确定性更好）
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_PORT` | `3006` | 监听端口（控制台 URL、runner `--port`、MCP `BRIDGE_PORT` 要一致） |
| `BRIDGE_HOST` | `0.0.0.0` | 监听网卡；**纯本机用 `127.0.0.1` 更安全**；CodeNext 里保持 `0.0.0.0` |
| `BRIDGE_TOKEN` | 自动生成 | 鉴权 token；不设则自动生成并写入 `.bridge-token` |

---

## 4. Token 规则（统一）

所有 `/api/*` 端点都要求一个 **Bearer token**。它的分发是**全自动**的，正常情况下你根本不用碰。规则如下：

**一句话规则：都从仓库根目录跑，token 自动打通。**

- **服务端**：`BRIDGE_TOKEN` 环境变量优先，否则自动生成；并把它写到**启动目录**下的 `.bridge-token`（已在 `.gitignore` 中，不会提交）。
- **控制台页面**：服务把 token 内嵌进页面（`<meta>` + `window.__BRIDGE_TOKEN`）。
- **扩展（中继）**：从控制台页面的 `<meta>` 读 token，之后所有请求自动携带。
- **runner.js**：按顺序找 token —— `opts.token` → `BRIDGE_TOKEN` 环境变量 → `.bridge-token` 文件（依次尝试**当前目录**、`server/`、**仓库根**）。所以 server 从哪起、runner 从哪跑，一般都能自动对上。
- **MCP server**：同样 `BRIDGE_TOKEN` 环境变量 → 若干候选 `.bridge-token` 路径。

**什么时候需要手动指定 token？**

- 想要确定性（比如**容器 / 多机 / CI**）：给服务和 MCP **都显式设同一个 `BRIDGE_TOKEN`**，最省心：
  ```bash
  export BRIDGE_TOKEN=$(openssl rand -hex 16)   # 生成一个固定 token
  BRIDGE_TOKEN=$BRIDGE_TOKEN npm start           # 服务用它
  # runner / MCP 所在环境也 export 同一个 BRIDGE_TOKEN
  ```
- runner 报 `401 unauthorized`：多半是 token 没对上 → 在仓库根跑，或显式 `--token=xxx` / 设 `BRIDGE_TOKEN`。

---

## 5. 跑自动化（三种用法）

| 用法 | 怎么用 | 适合 |
|---|---|---|
| **控制台看板** | `localhost:3006` 页面点按钮 / 下拉发命令 | 手动点、调试 |
| **写脚本** | `node server/runner.js 你的脚本.js` | 固定流程自动化 |
| **AI Agent（MCP）** | 见 [第 6 节](#6-接入-ai-agentmcp) | 让 AI 用你的浏览器 |

脚本示例（Playwright 手感，动作前自动等待）：

```js
// my-flow.js
exports.main = async (bridge) => {
  await bridge.connect();
  await bridge.newTab('https://some-site.com');
  await bridge.getByLabel('用户名').fill('admin');
  await bridge.getByRole('button', '登录').click();
  await bridge.waitForNetworkIdle();
  await bridge.expect(bridge.getByText('欢迎')).toBeVisible();
};
```
运行：`node server/runner.js my-flow.js`

**不想手写？录制生成**：`await bridge.startRecording()` → 你在浏览器里手动点/填 → `await bridge.saveScript('my-flow.js')`。

更多 API 见 [examples/README.md](examples/README.md)。

---

## 6. 接入 AI Agent（MCP）

让 Claude Code / Claude Desktop / Cursor 等直接用你的浏览器。**前提**：bridge 服务已启动、扩展已连上、`Remote Control` 组里有标签页。

在客户端的 `mcpServers` 配置里加：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/绝对路径/remote-browser-bridge/mcp/server.js"],
      "env": {
        "BRIDGE_PORT": "3006",
        "BRIDGE_HOST": "127.0.0.1",
        "BRIDGE_TOKEN": "见 bridge 启动日志（同机通常可省略，会自动读 .bridge-token）",
        "DINGTALK_WEBHOOK": "可选：钉钉机器人 webhook（用于 browser_wait_for_human / browser_notify）"
      }
    }
  }
}
```

Claude Code 命令行也可：`claude mcp add browser -- node /绝对路径/remote-browser-bridge/mcp/server.js`（记得在其 env 里补 `BRIDGE_TOKEN`）。

提供 `browser_snapshot` / `browser_navigate` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_wait_for_human` 等 15 个工具，详见 [mcp/README.md](mcp/README.md)。

---

## 7. 在 CodeNext 上部署

和本机几乎一样，只有两点不同：

1. **服务跑在 CodeNext 容器里**：把仓库放进容器，`npm start`（保持 `BRIDGE_HOST=0.0.0.0` 默认，让 CodeNext 代理够得到）。
2. **控制台 URL 换成**：`https://你的CodeNext域名/_/port/3006/` —— 扩展里填**这个**（不是 localhost）。

其余（建 `Remote Control` 组、跑脚本、MCP）完全一致。安全上：外层有 CodeNext 自己的登录代理，内层有 bridge 的 token，两层鉴权。

> **canvas 简历读取（含 CDP 可信滚动）在 CodeNext 上一样能用**：`chrome.debugger` 由扩展在**你本地 Chrome 内部**调用，远端只发命令、收文本，不需要暴露任何调试端口、不需要反连本地。远端 agent 直接调 MCP `browser_read_canvas_text` 即可。**部署更新时记得**：整个 `extension/` 目录（含 `canvas-hook.js` + 新的 `debugger` 权限）都要同步、重载扩展（重新授予 debugger 权限）、并**刷新控制台页**重连；MCP 端同步 `mcp/server.js` 后**重启 MCP 客户端连接**。

---

## 8. 读 canvas 简历（Boss 在线简历等）

有些页面把正文画在 `<canvas>` 上、DOM 里没有文字（反爬），且滚动是 JS 拦截滚轮直接重画、没有 DOM 滚动。这种页面用 **CDP 可信滚动**读结构化全文（比 OCR 准、零 OCR）：

1. 打开候选人的**在线简历弹窗**（会加载 `c-resume` iframe）
2. 直接调用（三选一）：
   - **MCP**：`browser_read_canvas_text`（默认走 CDP，无需参数）
   - **runner**：`await bridge.readResumeCanvasCdp()`
   - **原始 action**：`read_resume_canvas_cdp`
3. 拿到从页首到页尾的完整结构化文本

**无需**预装钩子、传 frameId、手动滚动。读取时本地 Chrome 会短暂显示调试横幅、简历自动滚动几秒（读完自动恢复）。

排错：
- 读到空/乱码 → `browser_canvas_diag` 看 `hookInstalled` / `capturedDraws`；确认扩展是 **1.16.16+**（含 `canvas-hook.js` + `debugger` 权限）且权限已授予。
- 别用 `mode:"static"`（只读缓冲、不滚动）来读这类视口大小、滚动重画的 canvas —— 会不全/交织。
- 静态整张 canvas（不随滚动重画）才适合 `mode:"static"` 或图片+OCR（`browser_read_canvas` / `browser_read_canvas_full`）。

---

## 9. 验收清单

- [ ] `node -v` ≥ 18
- [ ] `npm start` 起来了，打印了 Token / Port
- [ ] `chrome://extensions` 里 “Remote Browser Bridge” 已加载、无报错
- [ ] 扩展弹窗填了控制台 URL、点了保存 + 打开控制台
- [ ] 控制台右下角 🟢 已连接
- [ ] 有一个名为 `Remote Control` 的标签组，里面有网站
- [ ] `node server/runner.js examples/quickstart.js` 能出结果
- [ ]（可选）MCP 客户端里能看到 `browser_*` 工具
- [ ]（读 canvas 简历需要）扩展版本 ≥ 1.16.16、已授予 `debugger` 权限；打开在线简历后 `browser_read_canvas_text` 能出完整全文

---

## 10. 出问题？

先看 [README 的「常见问题」](README.md#常见问题)。最高频三条：

- **连不上**：控制台 URL 是否正确（结尾带 `/`）、`Remote Control` 组是否建好、改过扩展要在 `chrome://extensions` **重新加载**并**刷新控制台页**。
- **`401 unauthorized`**：token 没对上 → 在仓库根跑，或显式 `BRIDGE_TOKEN` / `--token=xxx`（见 [第 4 节](#4-token-规则统一)）。
- **端口不是 3006**：控制台 URL 端口、`runner --port`、MCP `BRIDGE_PORT` 三处要一致。
