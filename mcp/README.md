# MCP Server —— 让 AI Agent 用你的浏览器

把"操控你本地浏览器"的能力暴露成 [MCP](https://modelcontextprotocol.io) 工具，任何支持 MCP 的
AI Agent（Claude Code / Claude Desktop / Cursor 等）都能直接调用，用**你本人的登录态**去操作网页。

**零依赖**：手写 MCP stdio 协议（newline-delimited JSON-RPC 2.0），只用 Node 内置模块，无需 `npm install`。

```
AI Agent ──stdio/JSON-RPC──> mcp/server.js ──HTTP──> bridge 服务 ──长轮询──> 扩展 ──> 你的 Chrome
```

## 前置条件

1. bridge 服务已启动：`node server/server.js`
2. Chrome 已加载扩展、在控制台页面连上、并建好 `Remote Control` 标签组
3. 组里至少有一个标签页（要操作的网站）

## 在客户端里配置

**Claude Code**（`~/.claude.json` 或项目 `.mcp.json` 的 `mcpServers`）/ **Claude Desktop**
（`claude_desktop_config.json`）/ **Cursor** 都用同一种格式：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/绝对路径/remote-browser-bridge/mcp/server.js"],
      "env": {
        "BRIDGE_PORT": "3006",
        "BRIDGE_HOST": "127.0.0.1",
        "BRIDGE_TOKEN": "在此填入 bridge 启动时打印的 token",
        "DINGTALK_WEBHOOK": "可选：钉钉机器人 webhook 或 access_token（用于 browser_wait_for_human / browser_notify）",
        "DINGTALK_SECRET": "可选：钉钉机器人加签密钥"
      }
    }
  }
}
```

> `BRIDGE_TOKEN` 不填时，会自动尝试从工作目录、仓库根、`server/` 下的 `.bridge-token` 读取。
> 若你的 MCP 客户端工作目录不确定，**建议直接把 token 填进 `env`** 最稳妥（token 见 bridge 服务启动日志）。

Claude Code 也可以用命令行添加：

```bash
claude mcp add browser -- node /绝对路径/remote-browser-bridge/mcp/server.js
# 然后在该 server 的 env 里补上 BRIDGE_TOKEN
```

## 提供的工具

| 工具 | 作用 |
|------|------|
| `browser_snapshot` | **结构化元素快照**：每个可交互元素带 `[eN]` 编号（感知页面的首选） |
| `browser_navigate` | 打开一个 URL |
| `browser_click` | 点击某个 ref（如 e5） |
| `browser_type` | 向某个 ref 输入文字（可选回车提交） |
| `browser_press_key` | 按键（Enter/Tab/Escape…） |
| `browser_screenshot` | 截图，返回 PNG 图片（给视觉模型看） |
| `browser_read_canvas` | 把已渲染的 `<canvas>` 导出为图片返回（canvas 绘制正文的页面，如某些简历，用它 + 你自己 OCR） |
| `browser_read_canvas_full` | 逐屏滚动导出 canvas 全部内容为多张图片（兜底虚拟化 canvas；静态长图自动去重成 1 张） |
| `browser_read_text` | 读取页面可见纯文本 |
| `browser_wait_for_text` | 等待某段文字出现 |
| `browser_get_page_info` | 获取当前 URL/标题 |
| `browser_new_tab` | 后台新开标签并设为目标 |
| `browser_list_tabs` | 列出受控标签（带 🎯 目标标记） |
| `browser_set_target` | 设定后台目标标签 |
| `browser_wait_for_human` | **暂停请人工介入**（手动登录/过验证码），控制台弹横幅 + 钉钉通知，阻塞到用户点「继续」 |
| `browser_notify` | 给用户钉钉推一条消息（需配置 `DINGTALK_WEBHOOK`） |
| `browser_evaluate` | 【高级】执行一段 JS 表达式 |

## 典型用法（Agent 视角）

1. `browser_snapshot` → 看到 `[e3] textbox "搜索"`、`[e5] button "搜索"`
2. `browser_type { ref: "e3", text: "关键词", submit: true }`
3. `browser_wait_for_text { text: "结果" }`
4. `browser_snapshot` → 拿到结果列表的新 ref，继续点

> ⚠️ 该 MCP 让 Agent 以你的登录身份操作浏览器。请只在受信任的 Agent/工作流里启用，
> 并遵守目标网站的服务条款。
