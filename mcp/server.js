#!/usr/bin/env node
// ============================================================
//  Remote Browser Bridge — MCP Server (stdio, zero-dependency)
//  把"操控你本地浏览器"的能力暴露成 MCP 工具，任何支持 MCP 的
//  AI Agent(Claude Code / Claude Desktop / Cursor 等)都能直接调用。
//
//  手写 MCP stdio 协议(newline-delimited JSON-RPC 2.0)，不依赖任何 npm 包。
//  复用 ../server/runner.js 的 Bridge，通过 HTTP 打到 bridge 服务 → 扩展 → 你的 Chrome。
//
//  前置条件：bridge 服务已启动(node server/server.js)，且扩展已连上、已建 Remote Control 组。
//  用法(在 MCP 客户端里配置)：node mcp/server.js   环境变量 BRIDGE_PORT/BRIDGE_HOST/BRIDGE_TOKEN
// ============================================================

const fs = require('fs');
const path = require('path');
const { Bridge } = require('../server/runner');

let VERSION = '1.7.0';
try { VERSION = require('../package.json').version || VERSION; } catch (e) {}

// stdout 是协议通道，任何日志一律走 stderr
const log = (...a) => process.stderr.write('[mcp] ' + a.map(String).join(' ') + '\n');

// ── token 解析：BRIDGE_TOKEN 环境变量 > 若干候选 .bridge-token 路径 ──
function resolveToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const candidates = [
    path.join(process.cwd(), '.bridge-token'),
    path.join(__dirname, '..', '.bridge-token'),
    path.join(__dirname, '..', 'server', '.bridge-token'),
  ];
  for (const p of candidates) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch (e) {}
  }
  return '';
}

const bridge = new Bridge({
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  port: parseInt(process.env.BRIDGE_PORT || '3006', 10),
  token: resolveToken(),
  verbose: false, // 关键：避免 runner 往 stdout 打日志污染协议
});

// 每次工具调用前重新挑选最新在线的浏览器，避免重连后指向旧会话
async function connectBridge() {
  try {
    await bridge.connect();
  } catch (e) {
    throw new Error(
      '未连接到浏览器。请确认：1) bridge 服务已启动 (node server/server.js) ' +
      '2) 已在扩展里打开控制台并连上 3) 已创建名为 "Remote Control" 的标签组。原始错误: ' + e.message
    );
  }
}

const text = (t) => [{ type: 'text', text: String(t) }];

// ══════════════════════════════════════
//  工具定义
// ══════════════════════════════════════
const TOOLS = [
  {
    name: 'browser_snapshot',
    description: '获取当前目标标签页的结构化元素快照：每个可交互元素都带一个稳定编号 [eN](ref)，' +
      '并附角色/名称/占位符/值等。这是感知页面、决定"点哪里/填哪里"的首选工具；' +
      '拿到 ref 后用 browser_click / browser_type 按编号操作，比 CSS 选择器稳。页面变化后需重新快照。',
    inputSchema: { type: 'object', properties: { maxNodes: { type: 'number', description: '最多返回多少个元素，默认 200' } } },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.snapshotRefs(a.maxNodes || 200);
      return text(`URL: ${r.url}\n标题: ${r.title}\n元素数: ${r.count}${r.truncated ? '（已截断）' : ''}\n\n${r.text}`);
    },
  },
  {
    name: 'browser_navigate',
    description: '在目标标签页打开一个 URL(若还没有受控标签，则后台新开一个)。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要打开的完整 URL' } }, required: ['url'] },
    run: async (a) => {
      await connectBridge();
      if (!a.url) throw new Error('缺少 url');
      let r;
      try { r = await bridge.navigate(a.url); }
      catch (e) { r = await bridge.newTab(a.url); } // 没有受控标签时退回新开
      return text(`已打开: ${r.url || a.url}${r.title ? '  (' + r.title + ')' : ''}`);
    },
  },
  {
    name: 'browser_click',
    description: '点击 browser_snapshot 返回的某个元素编号(如 e5)。',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: '元素编号，如 e5' } }, required: ['ref'] },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.clickRef(a.ref);
      if (!r.clicked) throw new Error(r.error || '点击失败');
      return text(`已点击 ${a.ref} (${r.tag}${r.text ? ' “' + r.text + '”' : ''})`);
    },
  },
  {
    name: 'browser_type',
    description: '把文字输入到某个元素编号(如 e3)。可选 submit=true 输入后回车。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素编号，如 e3' },
        text: { type: 'string', description: '要输入的文字' },
        submit: { type: 'boolean', description: '输入后是否按回车，默认 false' },
        clear: { type: 'boolean', description: '输入前是否清空，默认 true' },
      },
      required: ['ref', 'text'],
    },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.typeRef(a.ref, a.text, a.clear !== false);
      if (!r.typed) throw new Error(r.error || '输入失败');
      if (a.submit) await bridge.exec('press_key', { key: 'Enter' });
      return text(`已向 ${a.ref} 输入文字${a.submit ? ' 并回车' : ''}`);
    },
  },
  {
    name: 'browser_press_key',
    description: '按一个键(Enter / Tab / Escape / ArrowDown 等)，作用于当前聚焦的元素。',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: '键名，如 Enter' } }, required: ['key'] },
    run: async (a) => {
      await connectBridge();
      await bridge.exec('press_key', { key: a.key });
      return text(`已按键: ${a.key}`);
    },
  },
  {
    name: 'browser_screenshot',
    description: '截取当前目标标签页的 PNG 图片(会短暂切到该标签再切回)。适合让视觉模型"看一眼"页面。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await connectBridge();
      const r = await bridge.screenshot();
      const durl = r && r.dataUrl ? r.dataUrl : '';
      const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(durl);
      if (!m) throw new Error('截图失败（未拿到图片数据）');
      return [{ type: 'image', data: m[2], mimeType: m[1] }];
    },
  },
  {
    name: 'browser_read_text',
    description: '读取当前页面可见的纯文本(innerText)，用于阅读页面内容。',
    inputSchema: { type: 'object', properties: { maxLength: { type: 'number', description: '最大字符数，默认 8000' } } },
    run: async (a) => {
      await connectBridge();
      const t = await bridge.snapshot(a.maxLength || 8000);
      return text(typeof t === 'string' ? t : JSON.stringify(t));
    },
  },
  {
    name: 'browser_wait_for_text',
    description: '等待某段文字在页面出现(用于等页面加载/跳转/异步内容)。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, timeout: { type: 'number', description: '毫秒，默认 15000' } },
      required: ['text'],
    },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.waitForText(a.text, a.timeout || 15000);
      return text(r.found ? `已出现: "${a.text}"` : `超时未出现: "${a.text}"`);
    },
  },
  {
    name: 'browser_get_page_info',
    description: '获取当前目标标签页的 URL 与标题。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await connectBridge();
      const r = await bridge.getPageInfo(false);
      return text(`标题: ${r.title}\nURL: ${r.url}`);
    },
  },
  {
    name: 'browser_new_tab',
    description: '在受控组里后台新开一个标签并设为当前目标。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.newTab(a.url || 'about:blank');
      return text(`已新开标签 ${r.tabId}: ${r.url || a.url}`);
    },
  },
  {
    name: 'browser_list_tabs',
    description: '列出受控组里的标签页(带当前目标标记)。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await connectBridge();
      const tabs = await bridge.listTabs();
      const controlled = (Array.isArray(tabs) ? tabs : []).filter((t) => t.controlled);
      const lines = controlled.map((t) =>
        `${t.target ? '🎯 ' : '   '}[${t.id}] ${t.title || '?'}  ${t.url || ''}`);
      return text(lines.length ? lines.join('\n') : '（受控组内暂无标签）');
    },
  },
  {
    name: 'browser_set_target',
    description: '把某个受控标签设为当前后台目标(不切到前台)。tabId 来自 browser_list_tabs。',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.setTarget(a.tabId);
      return text(`当前目标已设为标签 ${r.target}`);
    },
  },
  {
    name: 'browser_wait_for_human',
    description: '暂停并请人工介入（手动登录 / 过验证码 / 确认敏感操作）。会在控制台弹出接管横幅，' +
      '并（若配置了钉钉）推送通知，然后阻塞直到用户点「继续」。用于你无法自动完成、必须真人操作的环节。' +
      '若用户点「中止」，本工具会返回错误。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '给用户的提示，如"请手动登录后点继续"' },
        timeout: { type: 'number', description: '毫秒，默认 300000（5 分钟）' },
      },
      required: ['message'],
    },
    run: async (a) => {
      // 无需浏览器，直接走 bridge 服务的接管机制
      const r = await bridge.waitForHuman(a.message, { timeout: a.timeout || 300000 });
      return text('人工已确认继续 (' + (r.action || 'continue') + ')');
    },
  },
  {
    name: 'browser_notify',
    description: '给用户的钉钉推一条消息（需配置环境变量 DINGTALK_WEBHOOK）。用于告知进度或提醒注意。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (a) => {
      const r = await bridge.notify(a.text);
      return text(r.sent ? '已推送钉钉' : ('未推送: ' + (r.reason || '未配置')));
    },
  },
  {
    name: 'browser_evaluate',
    description: '【高级】在页面执行一段 JS 表达式并返回结果。运行于隔离世界(不受页面 CSP 限制，但读不到页面自身 JS 变量)。',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: '要执行的 JS 表达式' } }, required: ['code'] },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.evaluate(a.code);
      return text(JSON.stringify(r));
    },
  },
];

// ══════════════════════════════════════
//  JSON-RPC over stdio
// ══════════════════════════════════════
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'remote-browser-bridge', version: VERSION },
    });
  }
  // 通知类(无 id)不回包
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});

  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return replyErr(id, -32602, 'Unknown tool: ' + name);
    try {
      const content = await tool.run((params && params.arguments) || {});
      return reply(id, { content });
    } catch (e) {
      return reply(id, { content: text('错误: ' + (e && e.message ? e.message : String(e))), isError: true });
    }
  }

  if (id !== undefined) replyErr(id, -32601, 'Method not found: ' + method);
}

// 按行读取 stdin(newline-delimited JSON)
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log('无法解析的 JSON:', line.slice(0, 120)); continue; }
    Promise.resolve(handle(msg)).catch((e) => log('handler error:', e && e.message));
  }
});
process.stdin.on('end', () => process.exit(0));

log(`Remote Browser Bridge MCP server 就绪 (stdio, v${VERSION}) → bridge ${bridge.baseUrl}`);
