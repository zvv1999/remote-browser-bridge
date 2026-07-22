// ============================================================
//  CodeNext Bridge Server (HTTP Long Polling)
//  扩展通过 HTTP 轮询获取指令，纯 HTTP 无需 WebSocket
// ============================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.BRIDGE_PORT || '3006', 10);
const AUTH_TOKEN = process.env.BRIDGE_TOKEN || crypto.randomBytes(16).toString('hex');
const TOKEN_GENERATED = !process.env.BRIDGE_TOKEN;
const BIND_HOST = process.env.BRIDGE_HOST || '0.0.0.0';
const POLL_TIMEOUT = 25000; // 长轮询最长等 25 秒

// 把 token 写到工作目录，供同机 runner.js / 脚本自动读取（已在 .gitignore 中忽略）
const TOKEN_FILE = path.join(process.cwd(), '.bridge-token');
try { fs.writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 }); } catch (e) {}

// 常量时间比较，避免时序侧信道
function tokenValid(t) {
  if (typeof t !== 'string' || t.length !== AUTH_TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(AUTH_TOKEN)); } catch (e) { return false; }
}
// 从请求里取 token：Authorization: Bearer / ?token= / body.token
function extractToken(req, url, body) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const q = url.searchParams.get('token');
  if (q) return q;
  if (body && body.token) return body.token;
  return '';
}

// ─── 连接管理 ───
const connections = new Map(); // browserId -> BrowserSession

// ─── 人工接管请求 ───
// 脚本/Agent 调 waitForHuman 时在此登记，控制台轮询显示横幅，用户点「继续/中止」后解除
const handoffs = new Map(); // id -> { id, message, createdAt, timeoutMs, status, action }
let handoffSeq = 0;

// 优先返回最近活跃的会话
function getDefaultBrowserId() {
  let latest = null;
  let latestTime = 0;
  for (const [id, s] of connections) {
    if (s.lastSeen > latestTime) { latestTime = s.lastSeen; latest = id; }
  }
  return latest;
}

class BrowserSession {
  constructor(id) {
    this.id = id;
    this.info = {};
    this.lastSeen = Date.now();
    this.cmdQueue = [];     // 待发送的指令
    this.pending = new Map(); // cmdId -> { resolve, reject, timer }
    this.pollRes = null;    // 当前等待中的 poll response
    this.cmdId = 0;
  }

  // CodeNext → 发指令给扩展
  async sendCommand(action, params = {}, timeoutMs = 30000) {
    const id = ++this.cmdId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 若指令仍在队列里未下发，一并移除，避免调用方超时后扩展仍"幽灵执行"
        const qi = this.cmdQueue.findIndex(c => c.id === id);
        if (qi !== -1) this.cmdQueue.splice(qi, 1);
        reject(new Error(`Timeout (${timeoutMs}ms): ${action}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const cmd = { id, action, params };
      // 如果有正在等待的 poll，直接返回
      if (this.pollRes) {
        const res = this.pollRes;
        this.pollRes = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, commands: [cmd] }));
      } else {
        // 否则排队
        this.cmdQueue.push(cmd);
      }
    });
  }

  // 扩展 → 提交指令结果
  handleResult(id, ok, data, error) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (ok) pending.resolve(data);
    else pending.reject(new Error(error || 'Unknown error'));
    return true;
  }

  // 扩展轮询
  waitForCommands(res) {
    if (this.cmdQueue.length > 0) {
      const cmds = [...this.cmdQueue];
      this.cmdQueue = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, commands: cmds }));
    } else {
      // 挂起，等有指令或超时
      this.pollRes = res;
      // 客户端断开时释放这个挂起的响应，避免向已关闭 socket 写入
      res.on('close', () => { if (this.pollRes === res) this.pollRes = null; });
      setTimeout(() => {
        if (this.pollRes === res) {
          this.pollRes = null;
          try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, commands: [] }));
          } catch (e) {}
        }
      }, POLL_TIMEOUT);
    }
  }

  close() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this.pending.clear();
    if (this.pollRes) {
      const res = this.pollRes;
      this.pollRes = null;
      try { res.end(JSON.stringify({ ok: false, error: 'session closed' })); } catch(e) {}
    }
  }
}

// ─── HTTP 请求体读取 ───
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
    });
  });
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*';
  // 注意：不再下发 Access-Control-Allow-Credentials，鉴权改用 Bearer token 而非 cookie，
  // 这样恶意网站即使跨域发请求也无法读取（且拿不到 token）。
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(200, cors);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── 健康检查（无需 token）──
  if (url.pathname === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', connections: connections.size }));
  }

  // ── 鉴权闸门：所有 /api/* 必须带有效 token（Bearer / ?token= / body.token）──
  // 控制台页面本身（'/'、'/console'）保持开放，作为 token 的分发入口。
  if (url.pathname.startsWith('/api/')) {
    // body.token 需要读 body；这里先用 header/query 校验，POST handler 内已读 body 的仍可回退。
    const headerTok = extractToken(req, url, null);
    // GET 请求（/api/poll、/api/browsers）只能靠 header/query；POST 允许 body 内回退。
    if (req.method === 'GET') {
      if (!tokenValid(headerTok)) {
        res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized (bad or missing token)' }));
      }
    }
    // POST 的 token 校验在读取 body 后由 requirePostToken() 完成
  }

  // ── 扩展注册/连接（需 token）──
  if (url.pathname === '/api/connect' && req.method === 'POST') {
    const body = await readBody(req);
    if (!tokenValid(extractToken(req, url, body))) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized (bad or missing token)' }));
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });

    const browserId = `browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session = new BrowserSession(browserId);
    session.info = { client: body.client || 'chrome-extension', version: body.version || '1.0.0' };
    connections.set(browserId, session);
    console.log(`[Bridge] CONNECTED: ${browserId} (${connections.size} online)`);
    return res.end(JSON.stringify({ ok: true, browserId }));
  }

  // ── 扩展长轮询获取指令 ──
  if (url.pathname === '/api/poll' && req.method === 'GET') {
    const browserId = url.searchParams.get('browserId');
    if (!browserId) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'missing browserId' }));
    }
    const session = connections.get(browserId);
    if (!session) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'browser not found, re-connect' }));
    }
    session.lastSeen = Date.now();
    session.waitForCommands(res);
    return;
  }

  // ── 扩展提交指令结果 ──
  if (url.pathname === '/api/result' && req.method === 'POST') {
    const body = await readBody(req);
    if (!tokenValid(extractToken(req, url, body))) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized (bad or missing token)' }));
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const session = connections.get(body.browserId);
    if (!session) {
      return res.end(JSON.stringify({ ok: false, error: 'browser not found' }));
    }
    session.lastSeen = Date.now();
    if (body.results) {
      for (const r of body.results) {
        session.handleResult(r.id, r.ok, r.data, r.error);
      }
    }
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── 列出浏览器（最近活跃的排在最前，避免重连后指向已死会话）──
  if (url.pathname === '/api/browsers') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const list = [];
    for (const [id, s] of connections) {
      list.push({
        id, info: s.info, lastSeen: s.lastSeen, pendingCmds: s.pending.size,
        pageInfo: s.pageInfo || null
      });
    }
    list.sort((a, b) => b.lastSeen - a.lastSeen);
    return res.end(JSON.stringify({ ok: true, browsers: list }));
  }

  // ── 扩展推送页面信息更新 ──
  if (url.pathname === '/api/session-update' && req.method === 'POST') {
    const body = await readBody(req);
    if (!tokenValid(extractToken(req, url, body))) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized (bad or missing token)' }));
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const session = connections.get(body.browserId);
    if (!session) {
      return res.end(JSON.stringify({ ok: false, error: 'browser not found' }));
    }
    session.lastSeen = Date.now();
    if (body.pageInfo) {
      session.pageInfo = body.pageInfo;
      // 一个 Chrome 标签只保留一个活中继：新连接上报 tabId 后，踢掉同 tabId 的更旧连接
      // （重载扩展/刷新控制台页会生成新 browserId，旧连接会残留成僵尸最多 90 秒，
      //   偶发在新连接首次心跳前抢走默认路由，导致指令落到死连接上返回空）。
      const tabId = body.pageInfo.tabId;
      if (tabId != null) {
        for (const [id, s] of connections) {
          if (id !== body.browserId && s.pageInfo && s.pageInfo.tabId === tabId && s.lastSeen <= session.lastSeen) {
            try { s.close(); } catch (e) {}
            connections.delete(id);
            console.log(`[Bridge] EVICT 僵尸中继 ${id}（同标签 ${tabId}，已被 ${body.browserId} 取代）`);
          }
        }
      }
    }
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── 人工接管：创建一个待处理请求（runner/Agent 调用）──
  if (url.pathname === '/api/handoff/create' && req.method === 'POST') {
    const body = await readBody(req);
    if (!tokenValid(extractToken(req, url, body))) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized (bad or missing token)' }));
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const id = ++handoffSeq;
    handoffs.set(id, {
      id, message: String(body.message || '需要人工介入'),
      createdAt: Date.now(), timeoutMs: Math.max(5000, parseInt(body.timeoutMs || 300000, 10)),
      status: 'pending', action: null,
    });
    console.log(`[Bridge] HANDOFF #${id} 等待人工: ${String(body.message || '').slice(0, 80)}`);
    return res.end(JSON.stringify({ ok: true, id }));
  }

  // ── 人工接管：列出待处理请求（控制台轮询显示横幅）──
  if (url.pathname === '/api/handoff/pending' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const list = [];
    for (const [, h] of handoffs) {
      if (h.status === 'pending') list.push({ id: h.id, message: h.message, createdAt: h.createdAt });
    }
    list.sort((a, b) => a.createdAt - b.createdAt);
    return res.end(JSON.stringify({ ok: true, handoffs: list }));
  }

  // ── 人工接管：查询某个请求状态（runner 轮询）──
  if (url.pathname === '/api/handoff/status' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const id = parseInt(url.searchParams.get('id'), 10);
    const h = handoffs.get(id);
    if (!h) return res.end(JSON.stringify({ ok: true, status: 'unknown' }));
    return res.end(JSON.stringify({ ok: true, status: h.status, action: h.action }));
  }

  // ── 人工接管：用户在控制台点「继续/中止」──
  if (url.pathname === '/api/handoff/resolve' && req.method === 'POST') {
    const body = await readBody(req);
    if (!tokenValid(extractToken(req, url, body))) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized (bad or missing token)' }));
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const id = parseInt(body.id, 10);
    const h = handoffs.get(id);
    if (!h) return res.end(JSON.stringify({ ok: false, error: 'handoff not found' }));
    h.status = 'resolved';
    h.action = body.action === 'cancel' ? 'cancel' : 'continue';
    h.resolvedAt = Date.now();
    console.log(`[Bridge] HANDOFF #${id} 已由人工${h.action === 'cancel' ? '中止' : '确认继续'}`);
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── CodeNext 发指令给扩展（需 token）──
  if (url.pathname === '/api/command' && req.method === 'POST') {
    const body = await readBody(req);
    if (!tokenValid(extractToken(req, url, body))) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized (bad or missing token)' }));
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const browserId = body.browserId || getDefaultBrowserId();
    const session = connections.get(browserId);
    if (!session) {
      return res.end(JSON.stringify({ ok: false, error: 'no browser connected' }));
    }
    try {
      const result = await session.sendCommand(body.action, body.params || {}, body.timeout || 30000);
      res.end(JSON.stringify({ ok: true, data: result }));
    } catch (e) {
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── 控制台页面 ──
  if (url.pathname === '/' || url.pathname === '/console') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getConsoleHTML(req));
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ─── 心跳清理 ───
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of connections) {
    if (now - session.lastSeen > 90000) {
      console.log(`[Bridge] TIMEOUT: ${id}`);
      session.close();
      connections.delete(id);
    }
  }
  // 接管请求：超时未处理的标记 expired；已处理/过期的在 runner 取走结果后清理
  for (const [id, h] of handoffs) {
    if (h.status === 'pending' && now - h.createdAt > h.timeoutMs) {
      h.status = 'expired'; h.resolvedAt = now;
      console.log(`[Bridge] HANDOFF #${id} 超时未处理`);
    }
    if (h.status !== 'pending' && h.resolvedAt && now - h.resolvedAt > 30000) {
      handoffs.delete(id);
    }
  }
}, 10000);

// ─── 控制台页面 ───
function getConsoleHTML(req) {
  const host = (req && req.headers && req.headers.host) || `localhost:${PORT}`;
  const proto = (host.startsWith('localhost') || host.startsWith('127.')) ? 'http' : 'https';
  const pubUrl = `${proto}://${host}/`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="remote-bridge-console" content="${AUTH_TOKEN}">
<script>window.__BRIDGE_TOKEN=${JSON.stringify(AUTH_TOKEN)};</script>
<title>Remote Browser Console</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;height:100vh;overflow:hidden}
  .sidebar{width:260px;min-width:260px;background:#16213e;display:flex;flex-direction:column;border-right:1px solid #2a2a4e}
  .sidebar-header{padding:14px 14px 10px;border-bottom:1px solid #222;display:flex;align-items:center;gap:8px}
  .sidebar-header h2{font-size:13px;color:#7c8cf8;font-weight:600}
  .sidebar-header .count{font-size:11px;color:#666;margin-left:auto}
  .sidebar-tabs{overflow-y:auto;flex:1;padding:8px}
  .tab-item{padding:8px 10px;margin-bottom:4px;border-radius:6px;cursor:pointer;font-size:11px;border:1px solid transparent;transition:all .12s;display:flex;align-items:center;gap:8px}
  .tab-item:hover{border-color:#7c8cf8;background:rgba(124,140,248,.06)}
  .tab-item.active{border-color:#7c8cf8;background:rgba(124,140,248,.1)}
  .tab-item .favicon{width:16px;height:16px;border-radius:3px;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center;font-size:10px}
  .tab-item .info{flex:1;min-width:0}
  .tab-item .t-title{color:#e0e0e0;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tab-item .t-url{color:#666;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tab-item .t-badge{font-size:9px;padding:1px 5px;border-radius:8px;flex-shrink:0}
  .tab-item .t-badge.active{background:rgba(76,175,80,.2);color:#81c784}
  .tab-item .t-badge.cookies{background:rgba(255,167,38,.15);color:#ffa726}
  .tab-item .t-actions{display:none;gap:2px}
  .tab-item:hover .t-actions{display:flex}
  .tab-item .t-actions button{padding:2px 5px;font-size:9px;border-radius:3px;border:1px solid #444;background:#222;color:#888;cursor:pointer}
  .tab-item .t-actions button:hover{color:#e0e0e0;border-color:#7c8cf8}
  .sidebar-footer{padding:10px 14px;border-top:1px solid #222;font-size:11px;color:#555;display:flex;align-items:center;gap:8px}
  .sidebar-footer .dot{width:8px;height:8px;border-radius:50%}
  .sidebar-footer .dot.on{background:#4caf50;box-shadow:0 0 5px #4caf50}
  .sidebar-footer .dot.off{background:#f44336}
  .sidebar-footer .bid-text{font-family:monospace;font-size:9px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  .main{flex:1;display:flex;flex-direction:column;min-width:0}
  .page-info-bar{padding:10px 16px;background:#16213e;border-bottom:1px solid #2a2a4e;display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:42px}
  .page-info-bar .pi-title{font-size:14px;font-weight:600;color:#e0e0e0;max-width:400px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .page-info-bar .pi-meta{display:flex;gap:12px;align-items:center;font-size:11px;color:#888;flex-wrap:wrap}
  .page-info-bar .pi-meta .val{color:#c0c0c0}
  .page-info-bar .pi-status{font-size:10px;padding:2px 8px;border-radius:10px;margin-left:auto;white-space:nowrap}
  .page-info-bar .pi-status.on{background:rgba(76,175,80,.2);color:#81c784}
  .page-info-bar .pi-status.off{background:rgba(244,67,54,.2);color:#e57373}

  .quick-actions{padding:6px 16px;background:#1a1a2e;border-bottom:1px solid #2a2a4e;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
  .qa-btn{padding:4px 10px;border-radius:4px;border:1px solid #333;cursor:pointer;font-size:11px;background:transparent;color:#999;white-space:nowrap;transition:all .12s}
  .qa-btn:hover{border-color:#7c8cf8;color:#e0e0e0;background:#22223a}
  .qa-divider{width:1px;height:16px;background:#333;margin:0 4px}
  .qa-toggle{padding:4px 10px;border-radius:4px;border:1px solid #333;cursor:pointer;font-size:11px;background:transparent;color:#888;white-space:nowrap;margin-left:auto}
  .qa-toggle:hover{border-color:#7c8cf8;color:#e0e0e0}
  .qa-toggle.open{background:#22223a;border-color:#7c8cf8;color:#e0e0e0}

  .toolbar-wrap{padding:8px 16px;background:#1a1a2e;border-bottom:1px solid #2a2a4e;display:none;gap:6px;align-items:center;flex-wrap:wrap}
  .toolbar-wrap.open{display:flex}
  .toolbar-wrap input,.toolbar-wrap select{padding:5px 8px;border-radius:5px;border:1px solid #444;background:#1a1a2e;color:#e0e0e0;font-size:12px}
  .toolbar-wrap button{padding:5px 12px;border-radius:5px;border:none;cursor:pointer;font-size:12px;background:#7c8cf8;color:#fff;white-space:nowrap}
  .toolbar-wrap button:hover{background:#6b7aee}

  .panel-tabs{display:flex;gap:0;background:#16213e;border-bottom:2px solid #2a2a4e;padding:0 16px}
  .panel-tab{padding:8px 16px;font-size:12px;color:#888;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s;display:flex;align-items:center;gap:5px}
  .panel-tab:hover{color:#c0c0c0}
  .panel-tab.active{color:#7c8cf8;border-bottom-color:#7c8cf8}
  .panel-tab .tab-count{font-size:10px;background:rgba(124,140,248,.15);padding:1px 6px;border-radius:8px}

  .panels{flex:1;overflow:hidden;position:relative}
  .panel{position:absolute;top:0;left:0;right:0;bottom:0;overflow-y:auto;padding:16px;display:none}
  .panel.active{display:block}

  /* Output panel */
  .cmd{color:#7c8cf8;margin:8px 0 4px;font-size:12px}
  .result{color:#81c784;margin:0 0 10px 14px;max-height:250px;overflow-y:auto;white-space:pre-wrap;font-size:12px}
  .error{color:#e57373;margin:0 0 10px 14px;font-size:12px}
  .info-line{color:#888;font-size:12px;margin:4px 0}

  /* Screenshot panel */
  .screenshot-panel{display:flex;flex-direction:column;align-items:center}
  .screenshot-img{max-width:100%;max-height:70vh;border:1px solid #444;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.3)}
  .screenshot-empty{color:#555;text-align:center;padding:60px 20px;font-size:14px}
  .screenshot-meta{font-size:11px;color:#666;margin-top:8px;text-align:center}

  /* Network panel */
  .net-table{width:100%;border-collapse:collapse;font-size:12px}
  .net-table th{position:sticky;top:0;background:#16213e;padding:8px 10px;text-align:left;font-weight:500;color:#888;border-bottom:1px solid #2a2a4e;z-index:1}
  .net-table td{padding:6px 10px;border-bottom:1px solid #1a1a2e;vertical-align:top}
  .net-table tr:hover td{background:rgba(124,140,248,.04)}
  .net-method{font-weight:600;font-size:11px;padding:1px 4px;border-radius:3px}
  .net-method.GET{color:#4caf50}
  .net-method.POST{color:#ffa726}
  .net-method.PUT{color:#42a5f5}
  .net-method.DELETE{color:#e57373}
  .net-status.ok{color:#81c784}
  .net-status.err{color:#e57373}
  .net-url{font-family:monospace;font-size:11px;color:#c0c0c0;max-width:400px;word-break:break-all}
  .net-dur{color:#888;font-size:11px;white-space:nowrap}

  /* Cookies panel */
  .cookie-table{width:100%;border-collapse:collapse;font-size:12px}
  .cookie-table th{position:sticky;top:0;background:#16213e;padding:8px 10px;text-align:left;font-weight:500;color:#888;border-bottom:1px solid #2a2a4e;z-index:1}
  .cookie-table td{padding:6px 10px;border-bottom:1px solid #1a1a2e;vertical-align:top;font-family:monospace;font-size:11px}
  .cookie-table tr:hover td{background:rgba(124,140,248,.04)}
  .cookie-name{color:#ffa726}
  .cookie-value{color:#c0c0c0;max-width:300px;word-break:break-all}
  .cookie-domain{color:#7c8cf8}
  .cookie-flags{display:flex;gap:4px;flex-wrap:wrap}
  .cookie-flag{font-size:9px;padding:1px 5px;border-radius:3px;background:#222;color:#666}

  .empty-state{color:#555;text-align:center;padding:60px 20px;font-size:14px}
  ::-webkit-scrollbar{width:6px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:#333;border-radius:3px}
</style>
</head>
<body>
<div id="handoffBanner" style="display:none;position:fixed;top:0;left:0;right:0;z-index:9999;background:#3a2f0b;border-bottom:2px solid #ffa726;color:#ffe0a3;padding:10px 16px;align-items:center;gap:12px;font-size:13px;box-shadow:0 2px 12px rgba(0,0,0,.4)">
  <span style="font-size:18px">⏸</span>
  <span style="font-weight:600;white-space:nowrap">需要人工接管:</span>
  <span id="handoffMsg" style="flex:1;min-width:0"></span>
  <button id="handoffContinue" style="padding:6px 16px;border:none;border-radius:5px;background:#4caf50;color:#fff;cursor:pointer;font-weight:600;white-space:nowrap">✅ 继续</button>
  <button id="handoffCancel" style="padding:6px 12px;border:1px solid #e57373;border-radius:5px;background:transparent;color:#e57373;cursor:pointer;white-space:nowrap">✖ 中止</button>
</div>
<div class="sidebar">
  <div class="sidebar-header">
    <h2>📱 浏览器标签页</h2>
    <span class="count" id="tabCount">0</span>
  </div>
  <div class="sidebar-tabs" id="tabList">
    <div class="empty-state" style="padding:20px;font-size:12px">等待扩展连接...</div>
  </div>
  <div class="sidebar-footer" id="sidebarFooter">
    <span class="dot off" id="connDot"></span>
    <span style="flex:1;min-width:0">
      <span id="connStatus">未连接</span>
      <br><span class="bid-text" id="connId">—</span>
    </span>
    <button onclick="refreshTabs()" style="background:none;border:1px solid #333;color:#888;cursor:pointer;border-radius:3px;padding:2px 6px;font-size:10px" title="刷新标签页列表">🔄</button>
  </div>
</div>
<div class="main">
  <div class="page-info-bar" id="pageInfoBar">
    <div class="pi-title" id="piTitle">未选择标签页</div>
    <div class="pi-meta" id="piMeta"></div>
    <div class="pi-status off" id="piStatus">⚫ 离线</div>
  </div>
  <div class="quick-actions">
    <button class="qa-btn" onclick="quickAction('screenshot')">📸 截图</button>
    <button class="qa-btn" onclick="quickAction('snapshot')">📋 快照</button>
    <button class="qa-btn" onclick="quickAction('snapshot_refs')">🧭 元素快照</button>
    <button class="qa-btn" onclick="quickAction('get_page_info')">ℹ️ 页面信息</button>
    <button class="qa-btn" onclick="quickAction('get_cookies')">🍪 Cookies</button>
    <button class="qa-btn" onclick="quickAction('get_links')">🔗 链接</button>
    <button class="qa-btn" onclick="quickAction('network_requests')">🌐 请求</button>
    <button class="qa-btn" onclick="quickAction('check_risk')">⚠️ 风控</button>
    <button class="qa-btn" onclick="quickAction('new_tab')">➕ 新标签</button>
    <span class="qa-divider"></span>
    <button class="qa-toggle" id="toolbarToggle" onclick="toggleToolbar()" title="展开命令工具栏">🔧 命令</button>
  </div>
  <div class="toolbar-wrap" id="toolbarWrap">
    <select id="actionSelect">
      <option value="navigate">导航 URL</option>
      <option value="new_tab">新建标签</option>
      <option value="click">点击元素</option>
      <option value="type">输入文字</option>
      <option value="click_text">按文字点击</option>
      <option value="snapshot">页面快照</option>
      <option value="snapshot_refs">结构化快照(ref)</option>
      <option value="click_ref">点击 ref (如 e3)</option>
      <option value="type_ref">输入到 ref (e3||文本)</option>
      <option value="get_ref">查看 ref</option>
      <option value="screenshot">截图</option>
      <option value="get_html">获取 HTML</option>
      <option value="get_text">获取文字</option>
      <option value="get_attribute">获取属性</option>
      <option value="evaluate">执行 JS</option>
      <option value="scroll">滚动</option>
      <option value="scroll_to_bottom">滚动到底</option>
      <option value="scroll_into_view">滚动到元素</option>
      <option value="press_key">按键</option>
      <option value="select">下拉选择</option>
      <option value="wait_for">等待元素</option>
      <option value="wait_for_text">等待文字</option>
      <option value="reload">刷新</option>
      <option value="go_back">后退</option>
      <option value="go_forward">前进</option>
      <option value="dismiss_overlays">关闭弹窗</option>
      <option value="check_risk">风控检测</option>
      <option value="get_links">提取链接</option>
      <option value="get_cookies">查看 Cookies</option>
      <option value="get_page_info">页面信息</option>
      <option value="list_tabs">列出标签页</option>
      <option value="set_target">设为目标(不切前台)</option>
      <option value="switch_tab">切换标签页(切前台)</option>
      <option value="close_tab">关闭标签页</option>
      <option value="list_frames">列出 iframe</option>
      <option value="network_intercept">捕获网络请求</option>
      <option value="network_requests">查看请求列表</option>
      <option value="network_fetch">发送 API 请求</option>
      <option value="network_clear">清空请求记录</option>
      <option value="install_resume_hook">安装 Canvas 钩子</option>
      <option value="read_resume_canvas">读取当前 Canvas</option>
      <option value="read_resume_canvas_full">读取完整简历</option>
      <option value="create_group">创建受控组</option>
      <option value="list_controlled_tabs">受控标签列表</option>
    </select>
    <input type="text" id="paramInput" placeholder="参数 (URL/选择器/JS)" style="flex:1;min-width:100px">
    <input type="text" id="frameIdInput" placeholder="iframe ID" style="width:80px" title="iframe ID (可选)">
    <button onclick="sendCommand()">发送</button>
    <button onclick="quickAction('network_clear')" style="background:#444;font-size:11px" title="清空网络请求记录">清空请求</button>
  </div>
  <div class="panel-tabs">
    <div class="panel-tab active" data-panel="output" onclick="switchPanel('output')">📋 输出</div>
    <div class="panel-tab" data-panel="screenshot" onclick="switchPanel('screenshot')">📸 截图</div>
    <div class="panel-tab" data-panel="network" onclick="switchPanel('network')">🌐 网络 <span class="tab-count" id="netCount">0</span></div>
    <div class="panel-tab" data-panel="cookies" onclick="switchPanel('cookies')">🍪 Cookies <span class="tab-count" id="cookieCount">0</span></div>
  </div>
  <div class="panels">
    <div class="panel active" id="panel-output">
      <div style="color:#666;font-size:13px">Bridge 已就绪 — 等待扩展连接</div>
    </div>
    <div class="panel screenshot-panel" id="panel-screenshot">
      <div class="screenshot-empty">📸 点击「截图」查看页面截图</div>
    </div>
    <div class="panel" id="panel-network">
      <div class="empty-state">🌐 点击「捕获网络请求」后开始记录</div>
    </div>
    <div class="panel" id="panel-cookies">
      <div class="empty-state">🍪 点击「Cookies」查看当前页面 Cookie</div>
    </div>
  </div>
</div>
<script>
  var BASE = window.location.pathname.replace(/\\/$/, '');
  var TOKEN = window.__BRIDGE_TOKEN || '';
  function authHeaders(extra) {
    return Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN }, extra || {});
  }
  var selectedTabId = null;
  var selectedBrowser = null;
  var allTabs = [];           // 所有受控标签页
  var storedScreenshot = null; // { dataUrl, viewport, time }
  var storedCookies = null;    // { url, cookies: [], total }
  var netRequests = [];       // 已捕获的网络请求
  var activePanel = 'output';

  function debug(msg) { console.log('[Bridge]', msg); }

  // ─── 面板切换 ───
  function switchPanel(name) {
    activePanel = name;
    document.querySelectorAll('.panel-tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.panel === name);
    });
    document.querySelectorAll('.panel').forEach(function(p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
  }

  // ─── 工具栏折叠 ───
  function toggleToolbar() {
    var wrap = document.getElementById('toolbarWrap');
    var btn = document.getElementById('toolbarToggle');
    var open = wrap.classList.toggle('open');
    btn.classList.toggle('open', open);
    btn.textContent = open ? '🔧 收起' : '🔧 命令';
  }

  // ─── 主轮询：刷新标签页列表 ───
  async function refreshTabs() {
    try {
      var res = await fetch(BASE + '/api/browsers', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
      var data = await res.json();
      if (!data.browsers || data.browsers.length === 0) {
        document.getElementById('tabList').innerHTML = '<div class="empty-state" style="padding:20px;font-size:12px">等待扩展连接...</div>';
        document.getElementById('tabCount').textContent = '0';
        document.getElementById('connDot').className = 'dot off';
        document.getElementById('connStatus').textContent = '未连接';
        document.getElementById('connId').textContent = '—';
        return;
      }

      var browser = data.browsers[0];
      selectedBrowser = browser.id;
      document.getElementById('connDot').className = 'dot on';
      document.getElementById('connStatus').textContent = '已连接';
      document.getElementById('connId').textContent = browser.id.substring(0, 20);
      document.getElementById('tabCount').textContent = (browser.pageInfo && browser.pageInfo.tabCount) || '—';

      // 尝试获取标签页列表
      if (selectedBrowser) {
        try {
          var tabsRes = await fetch(BASE + '/api/command', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({action: 'list_tabs', params: {}, browserId: selectedBrowser, timeout: 5000})
          });
          var tabsData = await tabsRes.json();
          if (tabsData.ok && tabsData.data && Array.isArray(tabsData.data)) {
            allTabs = tabsData.data.filter(function(t) { return t.controlled; });
          }
        } catch(e) {
          console.log('[Bridge] list_tabs failed, using fallback:', e.message);
        }
        // Always fallback to pageInfo if list_tabs returned nothing
        if (allTabs.length === 0 && browser.pageInfo && browser.pageInfo.title) {
          allTabs = [{
            id: browser.pageInfo.tabId || 0,
            title: browser.pageInfo.title || '?',
            url: browser.pageInfo.url || '',
            favIconUrl: browser.pageInfo.favIconUrl || '',
            cookieCount: browser.pageInfo.cookieCount || 0,
            active: true, controlled: true
          }];
        }
      }

      document.getElementById('tabCount').textContent = allTabs.length;

      // 渲染标签页列表
      var list = document.getElementById('tabList');
      if (allTabs.length === 0) {
        list.innerHTML = '<div class="empty-state" style="padding:20px;font-size:12px">无受控标签页</div>';
      } else {
        list.innerHTML = allTabs.map(function(t) {
          var tid = Number(t.id) || 0;
          var cls = 'tab-item';
          if (selectedTabId === t.id) cls += ' active';
          var hostname = '';
          try { hostname = new URL(t.url).hostname; } catch(e) { hostname = String(t.url || '').substring(0,30); }
          // 仅允许 http/https/data 图标，且对属性值转义，避免标签 title/url/favicon 里的脚本注入
          var favSafe = /^(https?:|data:image\\/)/i.test(t.favIconUrl || '');
          var fav = (t.favIconUrl && favSafe)
            ? '<img class="favicon" src="' + escapeHtml(t.favIconUrl) + '" onerror="this.style.display=\\'none\\'">'
            : '<span class="favicon">📄</span>';
          var badges = '';
          if (t.target) badges += '<span class="t-badge" style="background:rgba(124,140,248,.25);color:#a9b4ff">🎯 目标</span>';
          if (t.active) badges += '<span class="t-badge active">active</span>';
          var cookieBadge = t.cookieCount !== undefined
            ? '<span class="t-badge cookies">🍪' + (Number(t.cookieCount)||0) + '</span>' : '';
          var titleSafe = escapeHtml(t.title || 'Untitled');
          return '<div class="' + cls + '" data-tid="' + tid + '" onclick="selectTab(' + tid + ')">'
            + fav
            + '<div class="info">'
            + '<div class="t-title" title="' + titleSafe + '">' + titleSafe + '</div>'
            + (hostname ? '<div class="t-url">' + escapeHtml(hostname) + '</div>' : '')
            + '</div>'
            + cookieBadge + badges
            + '<div class="t-actions">'
            + '<button onclick="event.stopPropagation();switchToTab(' + tid + ')" title="切换到此标签">▶</button>'
            + '<button onclick="event.stopPropagation();closeRemoteTab(' + tid + ')" title="关闭标签">✕</button>'
            + '</div>'
            + '</div>';
        }).join('');

        // 更新选中标签的 page info bar
        updatePageInfoBar();
      }
    } catch(e) { debug('refreshTabs error: ' + e.message); }
  }

  function selectTab(tabId) {
    selectedTabId = tabId;
    // 只把它设为"当前目标"，不激活到前台（后台友好）。要切到前台请用标签上的 ▶ 按钮。
    if (selectedBrowser) {
      fetch(BASE + '/api/command', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({action: 'set_target', params: {tabId: tabId}, browserId: selectedBrowser, timeout: 3000})
      }).catch(function(){});
    }
    refreshTabs();
  }

  function switchToTab(tabId) {
    selectedTabId = tabId;
    if (selectedBrowser) {
      fetch(BASE + '/api/command', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({action: 'switch_tab', params: {tabId: tabId}, browserId: selectedBrowser})
      }).catch(function(){});
    }
    setTimeout(refreshTabs, 500);
  }

  function closeRemoteTab(tabId) {
    if (!confirm('确定关闭这个标签页？')) return;
    if (selectedBrowser) {
      fetch(BASE + '/api/command', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({action: 'close_tab', params: {tabId: tabId}, browserId: selectedBrowser})
      }).then(function() {
        if (selectedTabId === tabId) selectedTabId = null;
        setTimeout(refreshTabs, 500);
      }).catch(function(e) { debug('close error: ' + e.message); });
    }
  }

  function updatePageInfoBar() {
    var titleEl = document.getElementById('piTitle');
    var metaEl = document.getElementById('piMeta');
    var statusEl = document.getElementById('piStatus');
    if (!selectedTabId) {
      // 显示第一个 active 的
      var active = allTabs.find(function(t) { return t.active; });
      if (active) {
        titleEl.textContent = active.title || '?';
        try {
          metaEl.innerHTML = '<span>🔗 <span class="val">' + escapeHtml(new URL(active.url).hostname) + '</span></span>';
        } catch(e) {
          metaEl.innerHTML = '';
        }
        if (active.cookieCount !== undefined) {
          metaEl.innerHTML += '<span>🍪 <span class="val">' + active.cookieCount + '</span></span>';
        }
        statusEl.textContent = '🟢 活跃';
        statusEl.className = 'pi-status on';
      } else if (allTabs.length > 0) {
        var t = allTabs[0];
        titleEl.textContent = t.title || '?';
        statusEl.textContent = '🟡 后台';
        statusEl.className = 'pi-status off';
      } else {
        titleEl.textContent = '未选择标签页';
        metaEl.innerHTML = '';
        statusEl.textContent = '⚫ 离线';
        statusEl.className = 'pi-status off';
      }
      return;
    }
    var tab = allTabs.find(function(t) { return t.id === selectedTabId; });
    if (tab) {
      titleEl.textContent = tab.title || '?';
      titleEl.title = tab.title || '';
      try {
        metaEl.innerHTML = '<span>🔗 <span class="val">' + escapeHtml(new URL(tab.url).hostname) + '</span></span>';
      } catch(e) {
        metaEl.innerHTML = '<span>🔗 <span class="val">' + escapeHtml((tab.url||'').substring(0,40)) + '</span></span>';
      }
      if (tab.cookieCount !== undefined) {
        metaEl.innerHTML += '<span>🍪 <span class="val">' + tab.cookieCount + '</span></span>';
      }
      statusEl.textContent = tab.active ? '🟢 活跃' : '🟡 后台';
      statusEl.className = 'pi-status ' + (tab.active ? 'on' : 'off');
    } else {
      titleEl.textContent = '标签 ' + selectedTabId;
      metaEl.innerHTML = '';
      statusEl.textContent = '🟡';
      statusEl.className = 'pi-status off';
    }
  }

  // ─── 快捷操作 ───
  function quickAction(action) {
    document.getElementById('actionSelect').value = action;
    document.getElementById('paramInput').value = '';
    document.getElementById('frameIdInput').value = '';
    sendCommand();
  }

  // ─── 发送指令 ───
  async function sendCommand() {
    var action = document.getElementById('actionSelect').value;
    var param = document.getElementById('paramInput').value.trim();
    var frameId = document.getElementById('frameIdInput').value.trim();
    var params = {};
    if (frameId) params.frameId = parseInt(frameId);
    switch(action) {
      case 'navigate': params.url = param; break;
      case 'new_tab': params.url = param || 'about:blank'; break;
      case 'click': params.selector = param; break;
      case 'type':
        var parts = param.split('||');
        params.selector = (parts[0] || '').trim();
        params.text = (parts[1] || '').trim();
        break;
      case 'click_text': params.text = param; break;
      case 'snapshot': params.maxLength = parseInt(param) || 8000; break;
      case 'snapshot_refs': params.maxNodes = parseInt(param) || 200; break;
      case 'click_ref': params.ref = param; break;
      case 'type_ref':
        var refParts = param.split('||');
        params.ref = (refParts[0] || '').trim();
        params.text = (refParts[1] || '').trim();
        break;
      case 'get_ref': params.ref = param; break;
      case 'screenshot': params.format = 'png'; break;
      case 'get_html': params.selector = param || 'body'; break;
      case 'get_text': params.selector = param; break;
      case 'get_attribute':
        var attrParts = param.split('||');
        params.selector = (attrParts[0] || '').trim();
        params.attribute = (attrParts[1] || '').trim();
        break;
      case 'evaluate': params.code = param; break;
      case 'scroll': params.y = parseInt(param) || 300; break;
      case 'scroll_to_bottom': params.maxRounds = parseInt(param) || 5; params.delay = 600; break;
      case 'scroll_into_view': params.selector = param; break;
      case 'press_key':
        var keyParts = param.split('||');
        params.selector = (keyParts[0] || '').trim() || undefined;
        params.key = (keyParts[1] || keyParts[0] || '').trim();
        break;
      case 'select':
        var selParts = param.split('||');
        params.selector = (selParts[0] || '').trim();
        params.value = (selParts[1] || '').trim();
        break;
      case 'wait_for': params.selector = param; break;
      case 'wait_for_text': params.text = param; break;
      case 'reload': break;
      case 'go_back': break;
      case 'go_forward': break;
      case 'dismiss_overlays': params.maxAttempts = parseInt(param) || 12; break;
      case 'check_risk': break;
      case 'get_links': break;
      case 'get_cookies':
        if (param) params.url = param;
        break;
      case 'get_page_info':
        params.includeCookies = true;
        break;
      case 'list_tabs': break;
      case 'set_target': params.tabId = parseInt(param); break;
      case 'switch_tab': params.tabId = parseInt(param); break;
      case 'close_tab':
        if (param) params.tabId = parseInt(param);
        break;
      case 'list_frames': break;
      case 'network_intercept': break;
      case 'network_requests': break;
      case 'network_fetch':
        var netMethod = param.includes('||') ? param.split('||')[0].trim() : 'GET';
        var netUrl = param.includes('||') ? param.split('||').slice(1).join('||').trim() : param;
        params.url = netUrl;
        params.method = netMethod || 'GET';
        break;
      case 'network_clear':
        netRequests = [];
        updateNetworkPanel();
        break;
      case 'install_resume_hook': break;
      case 'read_resume_canvas': break;
      case 'read_resume_canvas_full': params.maxScrolls = parseInt(param) || 15; break;
      case 'create_group': break;
      case 'list_controlled_tabs': break;
    }

    // 输出面板追加日志
    var output = document.getElementById('panel-output');
    output.innerHTML += '<div class="cmd">&gt; ' + action + ' ' + JSON.stringify(params) + '</div>';

    if (!selectedBrowser) {
      output.innerHTML += '<div class="error">未连接扩展 — 请刷新页面等待扩展重连</div>';
      return;
    }

    try {
      var res = await fetch(BASE + '/api/command', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({action: action, params: params, browserId: selectedBrowser})
      });
      if (res.status !== 200) {
        var errText = await res.text();
        output.innerHTML += '<div class="error">HTTP ' + res.status + ': ' + escapeHtml(errText.substring(0, 200)) + '</div>';
        return;
      }
      var data = await res.json();
      if (data.ok) {
        handleActionResult(action, data.data);
        var resultStr = escapeHtml(JSON.stringify(data.data, null, 2));
        output.innerHTML += '<div class="result">' + resultStr + '</div>';
      } else {
        var errMsg = data.error || 'unknown error';
        output.innerHTML += '<div class="error">' + escapeHtml(errMsg) + '</div>';
      }
    } catch(e) {
      output.innerHTML += '<div class="error">网络错误: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ─── 结果分发到对应面板 ───
  function handleActionResult(action, data) {
    if (!data) return;
    // 结构化 ref 快照 → 输出面板（可读文本，带 [eN] 编号）
    if ((action === 'snapshot_refs' || action === 'aria_snapshot') && data.text) {
      var outEl = document.getElementById('panel-output');
      outEl.innerHTML += '<div class="cmd">🧭 结构化快照 (' + (data.count || 0) + ' 个元素' + (data.truncated ? ', 已截断' : '') + ')</div>'
        + '<div class="result" style="max-height:none;color:#c0c0c0">' + escapeHtml(data.text) + '</div>';
      switchPanel('output');
    }
    // 截图 → 截图面板
    if (action === 'screenshot' && data.dataUrl) {
      storedScreenshot = {
        dataUrl: data.dataUrl,
        viewport: data.viewport,
        time: new Date().toLocaleTimeString()
      };
      updateScreenshotPanel();
      switchPanel('screenshot');
    }
    // 网络请求 → 网络面板
    if (action === 'network_requests' && data.requests) {
      netRequests = data.requests;
      updateNetworkPanel();
      switchPanel('network');
    }
    // Cookies → Cookie 面板
    if (action === 'get_cookies' && data.cookies) {
      storedCookies = data;
      updateCookiePanel();
      switchPanel('cookies');
    }
    if (action === 'get_page_info' && data.cookies && data.cookies.length > 0) {
      storedCookies = { url: data.url, cookies: data.cookies, total: data.cookieCount };
      updateCookiePanel();
    }
    // 风控检测 → 切换输出面板
    if (action === 'check_risk') {
      switchPanel('output');
    }
    // 链接 → 输出面板
    if (action === 'get_links') {
      switchPanel('output');
    }
    // 网络捕获后自动刷网络面板
    if (action === 'network_intercept') {
      setTimeout(function() {
        quickAction('network_requests');
      }, 500);
    }
  }

  function updateScreenshotPanel() {
    var panel = document.getElementById('panel-screenshot');
    if (!storedScreenshot) {
      panel.innerHTML = '<div class="screenshot-empty">📸 点击「截图」查看页面截图</div>';
      return;
    }
    var vpInfo = storedScreenshot.viewport
      ? storedScreenshot.viewport.width + 'x' + storedScreenshot.viewport.height
      : '';
    panel.innerHTML =
      '<img class="screenshot-img" src="' + storedScreenshot.dataUrl + '" alt="Screenshot">'
      + '<div class="screenshot-meta">' + storedScreenshot.time
      + (vpInfo ? ' · ' + vpInfo : '') + '</div>';
  }

  function updateNetworkPanel() {
    var panel = document.getElementById('panel-network');
    document.getElementById('netCount').textContent = netRequests.length;
    if (netRequests.length === 0) {
      panel.innerHTML = '<div class="empty-state">🌐 暂无请求 — 点击「捕获网络请求」开始记录</div>';
      return;
    }
    var rows = netRequests.map(function(r, i) {
      var statusCls = r.status >= 400 ? 'net-status err' : 'net-status ok';
      var method = String(r.method || 'GET').replace(/[^A-Za-z]/g, '').toUpperCase() || 'GET';
      var methodCls = 'net-method ' + method;
      var urlDisplay = String(r.url || '');
      if (urlDisplay.length > 80) urlDisplay = urlDisplay.substring(0, 80) + '...';
      var dur = r.duration ? (Number(r.duration) + 'ms') : '—';
      return '<tr>'
        + '<td><span class="' + methodCls + '">' + method + '</span></td>'
        + '<td class="' + statusCls + '">' + escapeHtml(r.status||'—') + '</td>'
        + '<td class="net-url" title="' + escapeHtml(r.url||'') + '">' + escapeHtml(urlDisplay) + '</td>'
        + '<td class="net-dur">' + dur + '</td>'
        + '<td style="font-size:10px;color:#666">' + (r.at ? new Date(r.at).toLocaleTimeString() : '') + '</td>'
        + '</tr>';
    }).reverse().join('');
    panel.innerHTML = '<table class="net-table">'
      + '<tr><th>方法</th><th>状态</th><th>URL</th><th>耗时</th><th>时间</th></tr>'
      + rows + '</table>';
  }

  function updateCookiePanel() {
    var panel = document.getElementById('panel-cookies');
    document.getElementById('cookieCount').textContent = storedCookies ? storedCookies.total : 0;
    if (!storedCookies || !storedCookies.cookies || storedCookies.cookies.length === 0) {
      panel.innerHTML = '<div class="empty-state">🍪 暂无 Cookie 数据</div>';
      return;
    }
    var rows = storedCookies.cookies.map(function(c) {
      var flags = [];
      if (c.secure) flags.push('<span class="cookie-flag">secure</span>');
      if (c.httpOnly) flags.push('<span class="cookie-flag">httpOnly</span>');
      if (c.sameSite) flags.push('<span class="cookie-flag">' + c.sameSite + '</span>');
      return '<tr>'
        + '<td class="cookie-name">' + escapeHtml(c.name) + '</td>'
        + '<td class="cookie-value">' + escapeHtml((c.value||'').substring(0, 200)) + '</td>'
        + '<td class="cookie-domain">' + escapeHtml(c.domain||'') + '</td>'
        + '<td style="font-size:10px;color:#888">' + escapeHtml(c.path||'/') + '</td>'
        + '<td><div class="cookie-flags">' + flags.join('') + '</div></td>'
        + '</tr>';
    }).join('');
    panel.innerHTML =
      '<div style="font-size:11px;color:#888;margin-bottom:8px">🔗 ' + escapeHtml(storedCookies.url||'') + ' · ' + storedCookies.total + ' cookies</div>'
      + '<table class="cookie-table">'
      + '<tr><th>名称</th><th>值</th><th>域名</th><th>路径</th><th>标记</th></tr>'
      + rows + '</table>';
  }

  // ─── 人工接管横幅 ───
  var currentHandoffId = null;
  async function refreshHandoffs() {
    try {
      var res = await fetch(BASE + '/api/handoff/pending', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
      var data = await res.json();
      var banner = document.getElementById('handoffBanner');
      if (data.handoffs && data.handoffs.length > 0) {
        var h = data.handoffs[0];
        currentHandoffId = h.id;
        document.getElementById('handoffMsg').textContent = h.message || '需要人工介入';
        banner.style.display = 'flex';
      } else {
        currentHandoffId = null;
        banner.style.display = 'none';
      }
    } catch (e) {}
  }
  function resolveHandoff(action) {
    if (currentHandoffId == null) return;
    var id = currentHandoffId;
    fetch(BASE + '/api/handoff/resolve', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ id: id, action: action })
    }).then(function () {
      document.getElementById('handoffBanner').style.display = 'none';
      currentHandoffId = null;
      refreshHandoffs();
    }).catch(function () {});
  }
  document.getElementById('handoffContinue').addEventListener('click', function () { resolveHandoff('continue'); });
  document.getElementById('handoffCancel').addEventListener('click', function () { resolveHandoff('cancel'); });
  setInterval(refreshHandoffs, 2000);
  refreshHandoffs();

  // ─── 轮询 ───
  setInterval(refreshTabs, 3000);
  refreshTabs();

  // ─── 事件委托 ───
  document.getElementById('paramInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendCommand();
  });
  document.getElementById('frameIdInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendCommand();
  });
</script>
<div style="position:fixed;bottom:0;left:0;right:0;padding:4px 16px;font-size:10px;color:#555;background:#111;text-align:center;border-top:1px solid #222;z-index:100">
  控制台地址: <code style="color:#7c8cf8;background:#1a1a2e;padding:1px 5px;border-radius:3px">${pubUrl}</code> — 复制此 URL 填入扩展弹窗
</div>
</body>
</html>`;
}


// ─── 启动 ───
server.listen(PORT, BIND_HOST, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     Remote Browser Bridge — HTTP Long Polling         ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Host  : ${BIND_HOST}   Port : ${PORT}`);
  console.log(`  Token : ${AUTH_TOKEN}  ${TOKEN_GENERATED ? '(自动生成)' : '(来自 BRIDGE_TOKEN)'}`);
  console.log(`  Token 文件 : ${TOKEN_FILE}  (同机 runner.js 会自动读取)`);
  console.log(`  端点  : /api/connect  /api/poll  /api/result  /api/command  /api/browsers  /health`);
  console.log('');
  console.log('  控制台已内嵌 token —— 只需在扩展里填入控制台 URL 即可，无需手动复制 token。');
  if (BIND_HOST === '0.0.0.0') {
    console.log('  ⚠️  正在监听 0.0.0.0（所有网卡）。同网段任何人只要能打开控制台页面即可取得 token。');
    console.log('     纯本机使用请设 BRIDGE_HOST=127.0.0.1；经 CodeNext 代理访问时请依赖其自带鉴权。');
  }
  console.log('');
});
