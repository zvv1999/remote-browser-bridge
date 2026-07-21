# 示例与 API 参考

两种写自动化脚本的方式：**JS 脚本**（灵活）和 **JSON 声明式**（简单）。

## 运行

```bash
# 在 server/ 目录下先启动服务：node server.js
# 然后（任意目录，token 会自动从 .bridge-token 读取）：

node server/runner.js examples/quickstart.js                 # JS 脚本
node server/runner.js examples/quickstart.js https://news.ycombinator.com
node server/runner.js examples/demo.json                     # JSON 声明式
node server/runner.js examples/quickstart.js --port=3006 --token=xxx
```

## JS 脚本骨架

```js
exports.main = async (bridge) => {
  await bridge.connect();                       // 复用已连接的浏览器
  await bridge.newTab('https://example.com');
  await bridge.waitForText('Example', 10000);
  await bridge.screenshot();
  const info = await bridge.getPageInfo(false);
  return { title: info.title };
};
```

## JSON 声明式

支持 `action` / `sleep` / `print` / `set` / `if` / `loop` / `retry` / `include`，
用 `store` 把结果存进变量，用 `{{变量.路径}}` 引用。见 [`demo.json`](demo.json)。

## 可用 API（`bridge.xxx()`）

| 类别 | 方法 |
|------|------|
| 导航 | `navigate(url)` · `newTab(url)` · `reload()` · `goBack()` · `goForward()` |
| DOM | `click(sel,index?)` · `type(sel,text)` · `clickText(text)` · `pressKey(sel,key)` · `select(sel,val)` |
| 读取 | `snapshot(maxLen?)` · `screenshot()` · `getHtml(sel)` · `getText(sel)` · `getAttribute(sel,attr)` |
| **Ref（推荐给 Agent）** | `snapshotRefs(maxNodes?)` · `clickRef(ref)` · `typeRef(ref,text)` · `getRef(ref)` |
| **定位器（自动等待，推荐写脚本）** | `getByRole(role,name)` · `getByText(t)` · `getByLabel(t)` · `getByPlaceholder(t)` · `getByTestId(id)` · `locator(spec)` |
| 页面 | `scroll(x,y)` · `scrollToBottom()` · `scrollIntoView(sel)` · `dismissOverlays()` |
| 等待 | `waitForText(text,timeout?)` · `waitForSelector(sel,timeout?)` · `waitUntil(fn,opts?)` · `sleep(ms)` |
| 信息 | `getPageInfo(includeCookies?)` · `getCookies(url?)` · `getLinks()` · `checkRisk()` |
| 网络 | `networkIntercept()` · `networkRequests()` · `networkFetch(url,method?,headers?,body?)` · `networkClear()` · `waitForNetworkIdle(opts?)` · `route(pat, 'abort' \| {status,body,contentType,method,regex})` · `clearRoutes()` |
| 断言（自动重试） | `expect(locator).toBeVisible/toBeHidden/toHaveText/toContainText/toHaveValue/toBeChecked/notToBeChecked` |
| 标签 | `listTabs()` · `setTarget(id)`(后台目标) · `switchTab(id)`(切前台) · `closeTab(id)` · `createGroup()` · `listControlledTabs()` |
| iframe | `listFrames()`（配合各方法的 `frameId` 参数在指定 iframe 内操作） |
| 执行 | `evaluate(code)` |
| 人机协作 | `waitForHuman(msg,opts?)` · `pauseIfRisky(opts?)` · `notify(text)`（钉钉） |
| 对话框 | `handleDialogs({accept?,promptText?})` · `getDialogs()` |
| 调试追踪 | `startTrace({screenshots?})` · `stopTrace()` · `saveTrace(path)`（存 HTML 时间线） |
| Canvas | `installResumeHook()` · `readResumeCanvas()` · `readResumeCanvasFull()` |

也可以直接用底层调用：`bridge.exec('action_name', { ...params }, timeoutMs)`。

> **对话框 + 调试追踪**：`await bridge.handleDialogs()` 提前装好，之后页面的 `alert/confirm/prompt` 自动响应、不再卡住（`getDialogs()` 看出现过哪些）。`bridge.startTrace({screenshots:true})` → 跑流程 → `await bridge.saveTrace('trace.html')` 生成一份**步骤时间线**（每步动作/耗时/成败，可含截图），排查 flaky 很好用。
>
> **网络控制 + 断言（补 Playwright）**：`await bridge.waitForNetworkIdle()` 等 SPA 请求都结束；`await bridge.route('/api/list', { body: {items:[]} })` 直接 mock 掉某个接口的响应（或 `bridge.route('/track', 'abort')` 拦掉某请求）；`await bridge.expect(bridge.getByText('成功')).toBeVisible()` 自动重试断言。路由作用于页面的 `fetch`。
>
> **定位器 + 自动等待（写脚本更稳）**：`getByRole/getByText/getByLabel/getByPlaceholder/getByTestId` 或 `locator({...})` 返回一个可链式操作的句柄，动作前**自动等待**元素出现→可见→可用（免去手动 `sleep`/`waitFor`），并**穿透开放 Shadow DOM**。例：`await bridge.getByRole('button','登录').click()`、`await bridge.getByLabel('用户名').fill('admin')`、`await bridge.locator({text:'结果'}).waitFor()`。`check` 是幂等的（不会把已勾选的切掉）。
>
> **Ref 快照（给 LLM/Agent 用）**：`snapshotRefs()` 返回带编号的元素清单（`[e1] link "登录"`、`[e3] textbox "用户名"`…）和结构化 `elements` 数组；随后用 `clickRef('e3')` / `typeRef('e5','文本')` 按编号操作，无需 CSS 选择器。比把原始 HTML 喂给模型更稳、更省 token。页面变化后 ref 会失效，重新 `snapshotRefs()` 即可。
>
> **后台操控**：命令默认作用于"当前目标标签"，**不会把它切到前台**——你可以一边用别的标签，一边让它在后台干活。`setTarget(id)` 设定后台目标（不激活）；`switchTab(id)` 才会切到前台。唯一例外是 `screenshot`：受 Chrome 限制会临时激活目标、截完再切回你原来的标签。
>
> **说明**：`getPageInfo(includeCookies)` 默认 `false`，只返回标题/URL/cookie 数量；
> 传 `true` 才会返回 cookie 值（截断）。`evaluate` 运行在隔离世界（不受页面 CSP 限制，
> 但读不到页面自身的 JS 变量）；`networkIntercept` / `installResumeHook` 运行在页面主世界，
> 能拦截页面真实的 fetch/XHR 与 canvas 绘制。

## 写你自己的脚本

复制 `quickstart.js` 改成你要的流程即可。业务逻辑完全在你的脚本里，
引擎（`runner.js`）和扩展只提供协议层，不含任何站点相关代码。

> ⚠️ 自动化访问第三方网站前，请遵守目标站点的服务条款与 robots 规则，控制频率，仅将其用于你有权访问的数据。
