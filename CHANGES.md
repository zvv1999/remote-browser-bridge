# 变更记录

## v1.6.0 — 结构化 ref 快照（对 LLM/Agent 友好）

给页面做一份「无障碍树」式的结构化快照，每个可交互元素带稳定编号 `[e1] [e2]…`，然后**按编号操作**，不用再写脆弱的 CSS 选择器 —— 这是让 AI Agent 可靠驱动页面的地基。

- **新增 `snapshot_refs`**（别名 `aria_snapshot`）：遍历页面，给每个可交互元素/标题编号并存到隔离世界的 `window.__bridgeRefs`，返回：
  - `text`：可读清单，如 `[e3] textbox "用户名" placeholder="请输入手机号"`；
  - `elements`：结构化数组 `{ref, role, name, href, value, checked, disabled, …}`。
  - 语义名解析：`aria-label` / `label[for]` / 包裹 `<label>` / `placeholder` / 文本；角色按标签与 `type`/`role` 推断；隐藏子树跳过、禁用/勾选状态标注。
- **新增 `click_ref` / `type_ref` / `get_ref`**：按 `snapshot_refs` 给出的编号点击/输入/查询；runner 对应 `bridge.snapshotRefs()` / `clickRef(ref)` / `typeRef(ref, text)` / `getRef(ref)`。ref 失效（页面变化/元素移除）会明确提示「请重新 snapshot_refs」。
- **控制台**：命令下拉新增这几项，快捷栏加「🧭 元素快照」，结果以可读清单展示。
- **🐛 顺手修掉一个潜伏 bug**：`click` / `click_text` 过去同时 `dispatchEvent(click)` **又** `el.click()`，导致**复选框/单选被切换两次**（等于没变）。现在统一只触发一次点击（`el.click()`，失败才回退 dispatch），复选框、跟随链接、表单提交等默认行为都正确。

> 典型用法：`snapshotRefs()` 看清页面 → `typeRef('e3','关键词')` → `clickRef('e5')`。对 LLM 来说，喂它带编号的清单比喂原始 HTML 稳得多、也省 token。

## v1.5.0 — 后台友好模式

让浏览器可以在**后台标签页**工作，不再每条命令都抢焦点、把标签强切到前台。

- **`getControlledTab()` 不再强制激活标签**：过去只要你前台看的标签不在 `Remote Control` 组里，任何命令都会把组里第一个标签切到前台。现在改为记住一个「当前目标标签」，click / type / navigate / 读取 / evaluate / 网络 / canvas 等**全部在后台目标标签上执行**，你可以同时用别的标签/窗口，视图不被打扰。
- **新增「当前目标标签」记忆**：持久化到 `chrome.storage.session`（扛得住 SW 回收），目标标签被关闭时自动清除。
  - 新增动作 **`set_target`**（设为目标但不激活）、**`get_target`**；runner 对应 `bridge.setTarget(id)` / `bridge.getTarget()`。
  - `switch_tab` 仍是「切到前台」（激活 + 设为目标）；`new_tab` 改为**后台打开**（`active:false`，可传 `active:true` 弹前台）并自动设为目标。
  - 控制台侧栏**点标签 = 设为后台目标**（不切前台）；标签上的 **▶** 按钮才是切到前台。
- **`screenshot` 智能激活**：截图受 Chrome `captureVisibleTab` 限制必须在前台——现在会**临时**激活目标标签、截完**再切回你原来的标签**（返回值含 `refocused` 标记）。这是唯一会短暂切换的操作。

> 一句话：除了截图那一下，后台自动化全程不打扰你。

## v1.4.0 — 审查后强化版（相对原始 v1.3.0）

本版本基于一次系统性代码审查（35 项已验证问题）对原始打包做了修复与加固。
所有改动都保持**向后兼容**，不改变原有的使用方式与 CodeNext 部署流程。
> ⚠️ 升级后需要在 `chrome://extensions` 里**重新加载扩展**，并重启 bridge 服务。

### 🔴 安全

- **强制鉴权 token（原本形同虚设）**：原来的 `if (body.token && body.token !== AUTH_TOKEN)` 只在调用方主动带 token 时才校验，而没有客户端会带，等于所有端点都无鉴权。现在 **所有 `/api/*` 端点都强制校验 token**（`Authorization: Bearer` / `?token=` / `body.token`，常量时间比较）。
  - token 自动生成，并**内嵌进控制台页面**（`<meta>` + `window.__BRIDGE_TOKEN`），扩展中继与控制台前端自动带上，**无需手动复制**。
  - 同机的 `runner.js` 自动从 `BRIDGE_TOKEN` 环境变量或工作目录的 `.bridge-token` 文件读取（该文件已在 `.gitignore` 中）。
- **修复 CORS 凭证反射**：不再下发 `Access-Control-Allow-Credentials: true`。鉴权改用 Bearer token 而非 cookie，恶意网站即便跨域发请求也拿不到 token、读不到响应 —— 关闭了"任意网页驱动本地 bridge"的攻击面。
- **修复控制台 XSS**：标签页 title / URL / favicon、抓包 URL 等来自任意网页的内容，过去被原样 `innerHTML` 注入到有 `/api/command` 权限的控制台页面；现已全部 HTML 转义，favicon 仅允许 http(s)/data 协议。
- **降低 cookie 泄露面**：`get_page_info` 默认只返回 cookie 数量，需要值时显式传 `includeCookies: true`。
- **启动告警**：监听 `0.0.0.0` 时打印告警并提示纯本机可用 `BRIDGE_HOST=127.0.0.1`。

### 🟠 MV3 执行世界（关键功能性 bug）

- **Canvas 简历钩子 / 网络拦截现在真正生效**：`install_resume_hook`、`network_intercept`、`network_requests`、`network_fetch`、`network_clear`、`read_resume_canvas(_full)` 过去用默认的**隔离世界**注入，抓不到页面真实的 canvas 绘制和 fetch/XHR（即读到的简历/流量恒为空）。现改为 `world: 'MAIN'`，在页面真实执行环境中运行。
- **`evaluate` 不再压平对象**：过去 `String(eval(code))` 会把对象变成 `[object Object]`，现在尽量保留结构（JSON 序列化）并返回 `type`。

### 🟠 稳定性 / 协议

- **超时命令不再"幽灵执行"**：调用方超时后，服务器会把仍在队列里未下发的指令一并移除。
- **重连后不再指向已死会话**：`/api/browsers` 按最近活跃排序，控制台/runner 始终选到最新会话。
- **批量指令不再互相拖累**：中继每执行完一条指令就立即回传结果，避免同批次里一条慢指令把其余指令拖到超时。
- **等待类命令的超时对齐**：`waitForText/waitForSelector` 的 RPC 超时随等待时长放大；runner 的 socket 超时不再固定 60s 小于命令超时。
- **挂起的长轮询在客户端断开时释放**，不再向已关闭的 socket 写入。

### 🟠 Service Worker 生命周期

- **连接状态可在 SW 回收后恢复**：relay 状态持久化到 `chrome.storage.session`，worker 重启时恢复。
- **定时推送改用 `chrome.alarms`**（每 30s）替代 `setInterval`，SW 被回收后仍能按时唤醒（新增 `alarms` 权限）。

### 🟡 正确性

- **修复默认端口不一致**：服务器默认端口由 `9527` 改为 `3006`，与 README/runner/示例/扩展一致，开箱即用。
- **修复本地模式无法连接**：中继改用注入的 `<meta name="remote-bridge-console">` 识别控制台，同时兼容 CodeNext 的 `/_/port/N` 路径与本地 `http://localhost:PORT/`。
- **`close_tab` 增加受控组校验**：指定 tabId 时必须在 `Remote Control` 组内，恢复"只碰受控标签"的安全承诺。
- **`waitForPageLoad` 不再空等**：缓存命中/同文档跳转时主动查一次状态，避免白等满 15s。
- **`typeText` 兼容 contenteditable 与 React/Vue 受控输入**（原生 value setter + 正确的清空方式）。
- **`loop.over` 支持模板替换**，与其它字段一致。
- **版本号/文案统一**：manifest / 中继握手 / popup 统一为 `1.4.0`；manifest 描述不再自称"WebSocket"（实际是 HTTP 长轮询）。

### 📦 打包

- 扩展改为**解压后的源码**（`extension/`），可直接"加载已解压的扩展"，也便于审阅（不再只有一个 zip）。
- 新增 `package.json`、`.gitignore`（忽略 `.bridge-token`）、`LICENSE`（MIT）、本变更记录。
- 移除站点专用示例，改为**中性通用示例**（`examples/quickstart.js`、`examples/demo.json`）。
