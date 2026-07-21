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
| 页面 | `scroll(x,y)` · `scrollToBottom()` · `scrollIntoView(sel)` · `dismissOverlays()` |
| 等待 | `waitForText(text,timeout?)` · `waitForSelector(sel,timeout?)` · `waitUntil(fn,opts?)` · `sleep(ms)` |
| 信息 | `getPageInfo(includeCookies?)` · `getCookies(url?)` · `getLinks()` · `checkRisk()` |
| 网络 | `networkIntercept()` · `networkRequests()` · `networkFetch(url,method?,headers?,body?)` · `networkClear()` |
| 标签 | `listTabs()` · `switchTab(id)` · `closeTab(id)` · `createGroup()` · `listControlledTabs()` |
| iframe | `listFrames()`（配合各方法的 `frameId` 参数在指定 iframe 内操作） |
| 执行 | `evaluate(code)` |
| Canvas | `installResumeHook()` · `readResumeCanvas()` · `readResumeCanvasFull()` |

也可以直接用底层调用：`bridge.exec('action_name', { ...params }, timeoutMs)`。

> **说明**：`getPageInfo(includeCookies)` 默认 `false`，只返回标题/URL/cookie 数量；
> 传 `true` 才会返回 cookie 值（截断）。`evaluate` 运行在隔离世界（不受页面 CSP 限制，
> 但读不到页面自身的 JS 变量）；`networkIntercept` / `installResumeHook` 运行在页面主世界，
> 能拦截页面真实的 fetch/XHR 与 canvas 绘制。

## 写你自己的脚本

复制 `quickstart.js` 改成你要的流程即可。业务逻辑完全在你的脚本里，
引擎（`runner.js`）和扩展只提供协议层，不含任何站点相关代码。

> ⚠️ 自动化访问第三方网站前，请遵守目标站点的服务条款与 robots 规则，控制频率，仅将其用于你有权访问的数据。
