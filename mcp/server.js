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
    name: 'browser_install_canvas_hook',
    description: '（通常不需要）手动补装 canvas 文字拦截钩子。' +
      '正常情况扩展的 document_start 脚本 canvas-hook.js 已在页面绘制前自动装好，直接用 browser_read_canvas_text 即可。' +
      '仅当钩子疑似没生效（browser_canvas_diag 显示 capturedDraws=0）时，作为对已打开页面的补救手段调用；注意它是“事后补装”，赶不上已经画完的 canvas，最可靠的做法仍是把简历弹窗关掉重开让 document_start 钩子从头装。返回 probeOk、frames。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await connectBridge();
      const r = await bridge.installResumeHook();
      return text('canvas 钩子已安装: ' + JSON.stringify(r));
    },
  },
  {
    name: 'browser_read_canvas_text',
    description: '读取 canvas 渲染的**结构化全文**（带坐标重排，比 OCR 准；用于 Boss 在线简历这类 DOM 里没有文字、正文画在 <canvas> 上的页面）。' +
      '默认走 **CDP 可信滚动**：用 chrome.debugger 派发可信 mouseWheel 逐屏驱动 canvas 重画，边滚边记录偏移，重建出从页首到页尾的完整简历——' +
      'Boss 用 JS 拦截滚轮、无 DOM 滚动、合成事件被 isTrusted 挡掉，只有这条路能拿到完整全文。' +
      '**无需预装钩子、无需传 frameId、无需手动滚**：打开候选人在线简历弹窗 → 直接调本工具。' +
      '运行时你的本地 Chrome 会短暂显示“调试此浏览器”黄条、简历会自动滚动几秒（读完自动恢复）。' +
      'mode="static" 可跳过滚动只读当前已捕获缓冲（更快，但只适合静态整张 canvas，读不全就别用）。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: '"cdp"（默认，可信滚动读全文）| "static"（只读当前缓冲，不滚动）' },
        step: { type: 'number', description: 'CDP 每步滚动像素，默认 180' },
        maxSteps: { type: 'number', description: 'CDP 最多滚多少屏，默认 50（到底自动停）' },
      },
    },
    run: async (a) => {
      await connectBridge();
      // static 模式：只读当前缓冲（快，适合静态整张 canvas）
      if (a.mode === 'static') {
        const sync = await bridge.readResumeCanvas();
        return text(`drawCalls=${(sync && sync.drawCallsCount) || 0}（static，未滚动）\n\n${(sync && sync.reconstructedText) || '(空)'}`);
      }
      // 默认：CDP 可信滚动读全文
      try {
        const r = await bridge.readResumeCanvasCdp({ step: a.step, maxSteps: a.maxSteps });
        const t = ((r && r.reconstructedText) || '').trim();
        if (t.length >= 20) {
          return text(`drawCalls=${r.drawCallsCount || 0}  steps=${r.steps}  wheelTarget=${JSON.stringify(r.wheelTarget)}（CDP 可信滚动）\n\n${t}`);
        }
        return text(
          `CDP 读取未拿到文字（drawCalls=${r && r.drawCallsCount}）。请确认：① 已打开候选人在线简历弹窗；② 扩展是含 debugger 权限的 1.16.14+；③ 已授予 debugger 权限。\n` +
          `可用 browser_canvas_diag 看 hookInstalled/capturedDraws；wheelTarget=${JSON.stringify(r && r.wheelTarget)}。`
        );
      } catch (e) {
        return text(`CDP 读取出错：${e.message}\n多半是扩展缺 debugger 权限或不是 1.16.14+。可先用 mode="static" 或 browser_canvas_diag 排查。`);
      }
    },
  },
  {
    name: 'browser_canvas_diag',
    description: '诊断 canvas 简历为什么读不到（自动定位 c-resume iframe 并在其中检查）。返回：canvas 是否被 transferControlToOffscreen 转给 Worker、有无像素、document_start 钩子截到多少条绘制（capturedDraws）、钩子是否已装。' +
      'capturedDraws 上千 = 钩子有效，直接用 browser_read_canvas_text；为 0 = 钩子没装（把简历弹窗关掉重开）；报 “unknown action” = 扩展是不含本功能的旧版。',
    inputSchema: { type: 'object', properties: { frameId: { type: 'number', description: 'c-resume iframe 的 frameId（可选，默认自动从 list_frames 定位）' } } },
    run: async (a) => {
      await connectBridge();
      let frameId = a.frameId;
      if (frameId == null) {
        try {
          const frames = await bridge.exec('list_frames', {});
          const rf = (frames || []).find((f) => /c-resume|\/web\/frame\//.test(f.url || ''));
          if (rf) frameId = rf.frameId;
        } catch (e) { /* 定位失败就用主框架 */ }
      }
      const r = await bridge.exec('canvas_diag', frameId != null ? { frameId } : {});
      return text(`frameId=${frameId != null ? frameId : '(主框架)'}\n` + JSON.stringify(r, null, 2));
    },
  },
  {
    name: 'browser_read_boss_resume',
    description: '一步读取当前已打开的 Boss 在线简历，返回**结构化字段**（姓名/年龄/学历/期望职位/薪资/工作经历/教育/技能等）+ 全文。' +
      '底层 CDP 可信滚动，完整、零 OCR。用法：打开候选人在线简历弹窗 → 调本工具。' +
      'expandAll=true 会额外点开"查看全部"截断内容（较慢，best-effort）。',
    inputSchema: { type: 'object', properties: { expandAll: { type: 'boolean', description: '是否点开"查看全部"截断内容，默认 false' } } },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.readBossResume({ expandAll: !!a.expandAll });
      if (!r.text) return text('未读到简历。请确认已打开候选人在线简历弹窗，且扩展 ≥1.16.14 并已授予 debugger 权限。');
      return text(JSON.stringify({ fields: r.fields, meta: r.meta, text: r.text }, null, 2));
    },
  },
  {
    name: 'browser_read_canvas',
    description: '把当前页面（或指定 frame）里已渲染的 <canvas> 导出为 PNG 图片返回，供你直接“看”并 OCR。' +
      '适合用 canvas 绘制正文/简历的页面 —— 这类页面 DOM 里没有文字，browser_read_text 拿不到。可传 selector / frameId。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '选哪些 canvas，默认所有' },
        frameId: { type: 'number', description: 'canvas 在某个 iframe 里时传其 frameId（见 list_frames）' },
        maxDim: { type: 'number', description: '最长边缩放上限，默认 2048（控制返回图片大小）' },
      },
    },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.readCanvasImage({ selector: a.selector, frameId: a.frameId, maxDim: a.maxDim || 2048 });
      const cs = ((r && r.canvases) || []).filter((c) => c.dataUrl);
      if (!cs.length) throw new Error('没有可导出的 canvas' + (r && r.count ? '（可能是跨源污染的画布）' : ''));
      cs.sort((x, y) => (y.width * y.height) - (x.width * x.height)); // 正文通常是最大的那个
      const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(cs[0].dataUrl);
      if (!m) throw new Error('canvas 图片解析失败');
      return [
        { type: 'text', text: `canvas ${cs[0].width}x${cs[0].height}${cs.length > 1 ? `（共 ${cs.length} 个，返回最大的）` : ''}` },
        { type: 'image', data: m[2], mimeType: m[1] },
      ];
    },
  },
  {
    name: 'browser_read_canvas_full',
    description: '逐屏滚动导出 canvas 的全部内容为多张图片（兜底“视口大小、滚动时重绘”的虚拟化 canvas）。' +
      '静态长图会自动去重成 1 张。返回多张图片，你逐张 OCR 后按顺序拼接即可。可传 selector / frameId / container。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' }, frameId: { type: 'number' },
        container: { type: 'string', description: '滚动容器选择器（可选，自动探测）' },
        maxScrolls: { type: 'number', description: '最多滚多少屏，默认 20' },
        maxDim: { type: 'number', description: '每帧最长边缩放上限，默认 2048' },
      },
    },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.readCanvasFull({ selector: a.selector, frameId: a.frameId, container: a.container, maxScrolls: a.maxScrolls || 20, maxDim: a.maxDim || 2048 });
      const frames = ((r && r.frames) || []).filter((f) => f.dataUrl);
      if (!frames.length) throw new Error('没有导出到 canvas 帧');
      const cap = frames.slice(0, 15);
      const out = [{ type: 'text', text: `共 ${frames.length} 帧（去重后）${frames.length > cap.length ? `，返回前 ${cap.length} 帧` : ''}，按顺序拼接` }];
      for (const f of cap) {
        const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(f.dataUrl);
        if (m) out.push({ type: 'image', data: m[2], mimeType: m[1] });
      }
      return out;
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
    description: '【高级】在页面执行一段 JS 表达式并返回结果。默认隔离世界(不受页面 CSP 限制，但读不到页面自身 JS 变量)；' +
      'world="MAIN" 可读页面变量/调页面函数，但 eval 会受页面 CSP 限制(禁 unsafe-eval 的页面会失败)。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JS 表达式' },
        world: { type: 'string', enum: ['ISOLATED', 'MAIN'], description: '执行世界，默认 ISOLATED' },
      },
      required: ['code'],
    },
    run: async (a) => {
      await connectBridge();
      const r = await bridge.evaluate(a.code, a.world === 'MAIN' ? { world: 'MAIN' } : {});
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
