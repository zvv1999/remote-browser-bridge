# 变更记录

## v1.16.1 — 修复 read_resume_canvas_full 在后台标签页卡死

- v1.15 重写时用了 `requestAnimationFrame` 逐屏等待，但**后台/隐藏标签页的 rAF 会被浏览器暂停**，导致该函数永不返回、命令 30s 超时报错。改回 `setTimeout`（后台也会触发，只是节流到 ~1s）。
- 注：绘制文字的捕获（fillText 钩子）在后台标签页照常工作（fillText 是 JS 调用，会执行；只有像素渲染被节流）。所以静态整张 canvas 的初始绘制在后台也能收到。

## v1.16.0 — document_start 提前装 canvas 钩子 + 重排隔离噪声

解决"钩子来晚了→只抓到零星 draw→重建乱码"的问题（实测同一简历：钩子晚装只有 ~2000 draw、乱码；成熟方案是 ~37000 draw、可读）。

- **新增 document_start 内容脚本 `canvas-hook.js`**（MAIN 世界、所有 frame）：在页面任何脚本运行**之前**就 patch `fillText/strokeText`，于是 canvas 一开始绘制就被拦——包括后加载的 c-resume iframe，能拿到**完整**的绘制文字。被动只读、缓冲区有上限（40 万条、超了丢一半）。
  - ⚠️ **需要刷新目标页面才生效**：document_start 脚本只对**新加载**的页面/frame 起作用。所以读简历前请先**刷新一次 Boss 页面**，让钩子从头装好，再打开简历。
- **重排隔离噪声**：不再死认 `canvasId=='resume'`，改为**按 canvasId 分组、选绘制文字最密的那个 canvas**作为正文，剔除诱饵/噪声 canvas（之前混进来导致乱序 hex）。`read_resume_canvas` / `read_resume_canvas_full` 都改了。
- 已**无头验证**：多 canvas 混合时正确挑出正文、丢弃噪声；重排分行/去重/绝对坐标正确。

> **新版正确用法**：**刷新 Boss 页面**（让 document_start 钩子装好）→ 打开候选人在线简历 → `read_resume_canvas_full`。这样能拿到带坐标的完整结构化文字，不用 OCR。

## v1.15.1 — 把 canvas 简历流程暴露成 MCP 工具

- 新增两个 MCP 工具，让 AI Agent 能用自然语言测/用 canvas 结构化文字读取：
  - **`browser_install_canvas_hook`**：打开内容弹窗前提前装钩子（对应 `install_resume_hook`）。
  - **`browser_read_canvas_text`**：滚动收集 + 重建结构化文字（对应 `read_resume_canvas_full`），返回 `reconstructedText` + `drawCalls`。
- MCP 现共 19 个工具。**改动仅 `mcp/server.js`**——扩展不用重载,只需**重启 MCP 客户端连接**让新工具出现。

## v1.15.0 — Canvas 简历钩子重写：提前装 + iframe 观察器 + 探针 + 强重排

把结构化文本读取（fillText 钩子法）做到跟成熟 CDP 方案一样稳，全在扩展内、不引 CDP：

- **`install_resume_hook` 重写**：不再"用的时候才装、只装当前 window"，而是：
  - **直接 patch 子窗口的 `CanvasRenderingContext2D.prototype`**（注入函数直接执行，**不走 eval → 不受页面 CSP 限制**；Boss 禁 eval 也没事）；
  - **递归装进当前 window + 所有同源 iframe**；
  - **MutationObserver** 盯着新出现的 iframe（如简历 `c-resume`），一出现就自动补装钩子——**赶在 canvas 绘制前**；
  - **探针** `__bossResumeCanvasHookProbe`：画一句测试文字确认钩子在工作，返回 `probeOk`。
  - 记录字段更全：`canvasId / canvasHeight / scrollTop`。
- **`read_resume_canvas_full` 重写**：定位简历弹窗 + `c-resume` iframe 的 window，逐屏滚动（设 `__bossResumeScrollTop` + 派发 scroll + `rAF`×2）触发重绘，从**简历窗口**splice 绘制文字；先收一次初始绘制（静态整张 canvas）。
- **重排移植自成熟方案**：过滤 `canvasId=="resume"`、剔除探针/诱饵行、`absolute-Y + scrollTop` 处理、按 Y 分行、行内按 X 拼。`read_resume_canvas`（sync）也用同一重排。
- 已**无头验证**：钩子 patch/记录/探针正确；重排能正确分行、去重、处理滚动绝对坐标、剔除探针。

> **正确用法**：**先 `install_resume_hook`（打开简历弹窗之前）→ 再打开简历 → `read_resume_canvas_full`**。观察器会赶在简历 iframe 绘制前把钩子装进去，于是能拿到带坐标的结构化文字（比 OCR 准）。配合 `read_canvas_image`（图片+OCR）双保险。

## v1.14.1 — `read_canvas_full` 自动找弹窗滚动容器

- `read_canvas_full` 的滚动容器探测改为**从 canvas 往上找"真正能滚的那个祖先"**（`overflow-y:auto/scroll` 且 `scrollHeight>clientHeight`）——模态弹窗（如 Boss 简历）自己有滚动区、页面背后锁死时，之前靠类名猜可能滚错对象；现在能自动命中弹窗内的滚动区。仍可用 `container` 参数手动指定。

## v1.14.0 — `read_canvas_full`：逐屏滚动导出，兜底虚拟化 canvas

- **新增 `read_canvas_full`**（runner `readCanvasFull({selector?,container?,maxScrolls?,delay?,maxDim?,frameId?})`、MCP `browser_read_canvas_full`）：自动找滚动容器、**逐屏滚动 + 每屏 `toDataURL`**，返回多张图片。
  - **自动去重**：静态长图每屏导出相同 → **去重成 1 张**（拿到完整长图）；"视口大小、滚动时重绘"的**虚拟化 canvas** 每屏不同 → 保留多张，覆盖全文。这样两种情况一个方法都能处理。
  - 用途：`read_canvas_image` 一次拿不全（返回的 `height` ≈ 一屏）时用它兜底；OCR 时按 `frames` 顺序拼接。MCP 版直接返回多张图片（上限 15 张）。
- 已**无头验证**：静态 800×5000 canvas → 7 步去重成 1 张完整图；虚拟化 800×800 canvas → 7 张不同帧。

## v1.13.1 — `evaluate` 支持 world 参数

- `evaluate` / `bridge.evaluate(code, {world:'MAIN'})` / MCP `browser_evaluate` 的 `world` 现在可选 `MAIN`，在页面主世界执行（能读页面变量、调页面函数）。
- ⚠️ **限制**：`evaluate` 本质是 `eval`，在 MAIN 世界里 `eval` 仍受**页面 CSP** 约束——禁 `unsafe-eval` 的页面（如 Boss 直聘）会失败并返回 `error`。**读 canvas 像素请用 `read_canvas_image`**（它把 `toDataURL` 作为注入函数直接执行，不走 eval，不受 CSP）。默认仍是隔离世界。

## v1.13.0 — 直接导出 canvas 图片（更稳的 canvas 内容读取）

- **新增 `read_canvas_image`**（runner `readCanvasImage({selector?,frameId?,maxDim?})`、MCP `browser_read_canvas`）：直接把**已渲染**的 `<canvas>` 导出为 PNG 返回，交给视觉模型 OCR。
  - **为什么**：`install_resume_hook`（monkeypatch `fillText`）只能抓到**安装之后**的绘制，而很多 canvas 是**加载时一次性画完、之后静态**（滚动也不重绘），再叠加 iframe 每次重开换 frameId，hook 时序几乎不可靠。而 canvas 位图挂在 DOM 元素上、**跨 world 共享**，所以 `toDataURL()` 能读到页面已经画好的像素，不依赖 hook。
  - 支持 `frameId`（canvas 在 iframe 里时）、`maxDim`（缩放控制返回大小）；跨源污染的 canvas 会返回 `error` 而非崩溃。
  - `install_resume_hook` / `read_resume_canvas` 仍保留（能拿到带坐标的结构化文本，但需在绘制前装好、时序敏感）；**新页面优先用 `read_canvas_image` + OCR，更稳**。

## v1.12.0 — 同源 iframe 穿透 + 录制生成脚本（codegen）

清掉"扩展内还能补"的最后两个边角：

- **同源 iframe 穿透**：定位器（`locator`/`getBy*`）与 `snapshot_refs` 现在会自动钻进**同源** iframe（`deepEls`/遍历递归进 `contentDocument`，跨源 `contentDocument` 抛错→自动跳过）；样式/标签解析改用元素自己文档的 view（`ownerDocument.defaultView`）。跨源 iframe 仍用 `list_frames` + `frameId` 显式定位。
- **录制生成脚本（codegen）**：`bridge.startRecording()` 后你在浏览器里手动点/填，`bridge.stopRecording()` / `bridge.saveScript('flow.js')` 把操作生成一段可运行脚本。录制器在隔离世界监听真实的 click/change 事件，为每个元素挑一个尽量稳的定位器（优先级：`data-testid` → `id` → `role`+可访问名 → 可见文本 → 短 CSS 路径）；`generateScript(steps)` 把步骤转成 `getByRole/getByTestId/getByText/locator` + `click/fill/check/selectOption`。
- 底层：扩展新增 `install_recorder/get_recording/stop_recorder` 动作；runner 新增 `startRecording/getRecording/stopRecording/generateScript/saveScript`。
- 已**无头验证**：录制器对 button/link/testid/id/input/checkbox 的定位器选择正确、生成的脚本是合法可运行 JS（含引号转义）。iframe 穿透因本次浏览器沙盒禁用本地页面未能在真实 DOM 端到端跑，改动为机械式且有 try/catch 兜底。

## v1.11.0 — 对话框自动处理 + 轻量 trace

- **JS 对话框自动处理**：`bridge.handleDialogs({accept?,promptText?})` 提前在页面主世界 monkeypatch `alert/confirm/prompt`，之后页面弹窗自动响应（默认接受），**不再卡死自动化**；`bridge.getDialogs()` 查看出现过哪些对话框。（原生 `beforeunload` 仅尽力压制属性式 handler。）
- **轻量 trace（调试时间线）**：`bridge.startTrace({screenshots?})` → 跑流程 → `bridge.stopTrace()` / `bridge.saveTrace('trace.html')`。记录每步的动作/参数/耗时/成败与错误，`screenshots:true` 时在"视觉类"动作后附截图，导出成一份自包含的暗色 HTML 时间线，排查 flaky/失败在哪一步很直观。tracer 自身触发的截图不计入（防递归）。
- 底层：扩展新增 `install_dialog_handler/get_dialogs` 动作；runner 的 `exec()` 加了 trace 钩子（同时记录失败步骤），新增 `renderTraceHtml`。
- 已**无头验证**：对话框 accept/reject 两种模式的返回值与记录、trace 记录失败步骤并生成合法 HTML、`screenshots:true` 时截图入帧且不递归。

## v1.10.0 — 网络控制 + Web-first 断言（继续补 Playwright）

- **等待网络空闲**：`bridge.waitForNetworkIdle({idleMs?,timeout?})` —— 连续 idleMs 内在途请求为 0 才返回，SPA 跳转/异步加载后很好用（`fetch`/`XHR` 都计数）。
- **请求路由 mock/abort（作用于 `fetch`）**：`bridge.route(pat, 'abort')` 拦掉匹配请求；`bridge.route(pat, {status,body,contentType,method,regex})` 直接返回自定义响应（`body` 传对象自动 JSON 序列化）。`bridge.clearRoutes()` 清空。适合"mock 掉我应用调的那个接口"。
- **Web-first 断言**：`bridge.expect(locator).toBeVisible()/toBeHidden()/toHaveText()/toContainText()/toHaveValue()/toBeChecked()/notToBeChecked()`，**自动重试到超时**（默认 5s），失败抛错报实际值。
- 底层：`networkIntercept` 扩展为带在途计数 + 路由；新增 `route_add/route_clear/wait_network_idle` 动作与 `locatorAct` 的 `expect*` 分支。
- 已**无头验证**网络层：mock 返回自定义 JSON、abort 让 fetch 失败、按 method 精确路由（GET 放行/POST 拦截）、在途计数 0→1→0、`waitNetworkIdle` 正确等到空闲及超时。
- 限制：路由只作用于页面的 `fetch`（不含 XHR、图片/CSS/导航等资源请求）；要完整网络路由需 `chrome.debugger`（未引入）。

## v1.9.0 — 定位器 + 自动等待（向 Playwright 手感看齐）

补上"自动化不如 Playwright"最关键的两块——**自动等待**和**语义定位器**，还顺带做了 **Shadow DOM 穿透**，都在扩展内、零新权限。

- **自动等待 (actionability)**：新引擎在超时前反复"解析定位器 → 检查存在+可见+可用 → 执行"，动作前自动等元素就绪并滚动到视口，**免去到处手写 `sleep`/`wait_for`**；失败会报最后原因（not found / display:none / disabled…）。
- **语义定位器**：`bridge.getByRole(role,name)` / `getByText` / `getByLabel` / `getByPlaceholder` / `getByTestId` / `locator({css|ref|role|text|testid|label|placeholder, within, nth, hasText, exact})`，返回可链式句柄：`.click()/.fill()/.type()/.hover()/.check()/.uncheck()/.selectOption()/.press()/.waitFor()/.getText()/.isVisible()/.count()/.nth()/.within()`。`check` **幂等**（不会把已勾选的切掉）。
- **Shadow DOM 穿透**：定位器与 `snapshot_refs` 现在都会下钻**开放** shadow root（很多 Web Component 之前定位不到）。
- 底层新增 `locator_act` 动作（扩展内 `locatorAct` 引擎）。已对真实 DOM 端到端验证：自动等待迟到元素、按 role/text/testid/label 定位、fill/check 幂等、shadow 穿透、隐藏元素正确拒绝并超时报因。
- 注：动作在**后台标签**里的自动等待粒度受 Chrome 定时器节流影响约 ~1s（前台 ~100ms），功能正确、只是更粗。可信输入事件/全量网络 mock/文件上传等仍需 `chrome.debugger`，本版未引入（按需再说）。
- **版本号统一**：自本版起，Chrome 扩展版本（manifest/中继/popup）与仓库版本 `package.json` **保持一致**（本版本改动了 `background.js`，扩展一并升到 1.9.0），不再分两条线，避免版本漂移。

## v1.8.0 — 人工接管 + 钉钉通知

让脚本/Agent 遇到必须真人做的环节（登录、验证码、二次确认）时**暂停等你处理**，处理完点「继续」再往下跑；并可在需要注意时推送钉钉。

- **人工接管**：`bridge.waitForHuman(message, opts?)` 在 bridge 服务登记一个接管请求并阻塞轮询；控制台顶部弹出**接管横幅**（[继续] / [中止]），用户点击后脚本恢复（中止则抛错）。默认超时 5 分钟。
  - `bridge.pauseIfRisky(opts?)`：先 `check_risk`，命中风控/验证码才暂停。
  - MCP 新增工具 `browser_wait_for_human`（阻塞到用户继续）。
- **钉钉通知**：新增零依赖 `server/notify.js`（Node 内置 `https`+`crypto`）。`bridge.notify(text)` 推送到钉钉群机器人；`waitForHuman` 默认自动推一条。支持「加签」(`DINGTALK_SECRET`，HMAC-SHA256) 与「关键词」(`DINGTALK_KEYWORD`) 安全设置；未配置 `DINGTALK_WEBHOOK` 时静默跳过。MCP 新增工具 `browser_notify`。
- **服务端**：新增 `/api/handoff/create·pending·status·resolve` 端点（均需 token），过期/已处理请求自动清理。
- 示例 [examples/handoff.js](examples/handoff.js)；`package.json` 升到 1.8.0（Chrome 扩展未改动，仍 1.6.0）。

> 典型用法：`await bridge.waitForHuman('请手动登录后点继续')` —— 你的手机收到钉钉、控制台弹横幅，登录完点一下，脚本继续。

## v1.7.0 — 内置 MCP Server（让 AI Agent 用你的浏览器）

新增 `mcp/server.js`：把浏览器操控能力暴露成 [MCP](https://modelcontextprotocol.io) 工具，Claude Code / Claude Desktop / Cursor 等任何支持 MCP 的 Agent 都能直接调用，用你本人的登录态操作网页。

- **零依赖**：手写 MCP stdio 协议（newline-delimited JSON-RPC 2.0），只用 Node 内置模块，无需 `npm install`。复用 `server/runner.js` 的 `Bridge` 打到 bridge 服务。
- **13 个工具**：`browser_snapshot`（结构化 ref 快照，感知首选）、`browser_navigate`、`browser_click`、`browser_type`（可回车提交）、`browser_press_key`、`browser_screenshot`（返回 PNG 图片给视觉模型）、`browser_read_text`、`browser_wait_for_text`、`browser_get_page_info`、`browser_new_tab`、`browser_list_tabs`、`browser_set_target`、`browser_evaluate`。
- **鉴权自动打通**：token 从 `BRIDGE_TOKEN` 或多个候选 `.bridge-token` 路径解析；日志全部走 stderr 以免污染 stdio 协议通道。
- 配置方式与工具清单见 [mcp/README.md](mcp/README.md)；`package.json` 增加 `npm run mcp` 与 `remote-bridge-mcp` bin。

> 注：这是**服务端新增**，Chrome 扩展本身未改动（仍为 1.6.0）；本版本号指仓库发布版本。
> 典型 Agent 用法：`browser_snapshot` 看清页面 → `browser_type{ref,text,submit}` → `browser_wait_for_text` → 再 `browser_snapshot`。

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
