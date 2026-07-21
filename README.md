# Remote Browser Bridge

让 **CodeNext**（云端 IDE / 容器）通过一个 Chrome 扩展**远程操控你本地的浏览器**。
纯 HTTP 长轮询，无需 WebSocket；扩展**只操控名为 `Remote Control` 的标签组**，其它标签页完全不受影响。

> Drive your local Chrome from a cloud IDE (CodeNext) through a small MV3 extension + a
> zero-dependency Node bridge. HTTP long-polling only. The extension touches **only** tabs
> inside a tab group named `Remote Control`.

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

## 说明

- **后台操控**：命令默认作用于「当前目标标签」，不会把它切到前台——你可以一边用别的标签/窗口，一边让它在后台自动化。`switch_tab` 才会切到前台；`screenshot` 因 Chrome 限制会临时切一下再切回。详见 [CHANGES.md](CHANGES.md) 的 v1.5.0。
- 扩展每 30 秒推送一次受控标签页信息到控制台（也会在页面变化时即时推送）。
- Bridge 服务 90 秒无心跳会自动断开该会话；服务重启后刷新控制台页面即可重连。
- 本版本相对原始 v1.3.0 的全部修复见 **[CHANGES.md](CHANGES.md)**。

## 免责声明

本工具用于操控**你自己的、已登录的**浏览器，便于开发与自动化。使用它访问任何第三方网站时，
请遵守该网站的服务条款、`robots` 规则与当地法律，控制访问频率，仅用于你有权访问的数据。
作者不对滥用负责。

## License

[MIT](LICENSE) © 2026 zvv1999
