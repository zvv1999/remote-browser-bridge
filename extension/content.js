// ============================================================
//  Remote Browser Bridge — Content Script (Relay Mode v2)
//  注入到桥接控制台页面，在页面上下文中（带 cookie）与服务器通信
// ============================================================

const BRIDGE_PATH_PATTERN = /\/_\/port\/\d+/;

// 控制台页面由 server.js 注入 <meta name="remote-bridge-console" content="TOKEN">，
// 用它来识别控制台（同时兼容 CodeNext 的 /_/port/N 路径与本地 http://localhost:PORT/），
// 并借它把 token 传给中继 —— content script 在隔离世界读不到页面的 window 变量，
// 但能读共享的 DOM（meta 标签），所以用 meta 传 token 最稳妥。
const consoleMeta = document.querySelector('meta[name="remote-bridge-console"]');
const isConsolePage = !!consoleMeta || BRIDGE_PATH_PATTERN.test(window.location.pathname);
const BRIDGE_TOKEN = consoleMeta ? (consoleMeta.getAttribute('content') || '') : '';

if (!isConsolePage) {
  window.__remoteBrowserBridgeInjected = true;
} else {
  console.log('[Bridge Relay] 🔗 检测到控制台页面，启动中继');
  safeSend('relay_log', { msg: '检测到控制台页面，正在连接...' });
  startRelay(BRIDGE_TOKEN);
}

// ─── 安全发送消息（容错扩展重载） ───
function safeSend(type, payload, callback) {
  try {
    if (!chrome.runtime || !chrome.runtime.id) return;
    if (callback) {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          callback({ error: chrome.runtime.lastError.message });
        } else {
          callback(null, response);
        }
      });
    } else {
      chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
    }
  } catch (e) {
    if (e.message && e.message.includes('context invalidated')) {
      console.log('[Relay] ⚠️ 扩展已重载，此页面需要刷新');
    }
  }
}

function startRelay(token) {
  const baseUrl = window.location.origin + window.location.pathname.replace(/\/$/, '');
  let browserId = null;
  let polling = false;

  // 所有请求都带 Bearer token；服务器所有 /api/* 端点都要求它
  const authHeaders = (extra) => Object.assign(
    { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
    extra || {}
  );

  // 如果扩展上下文已失效，不启动
  if (!isExtensionAlive()) {
    console.log('[Relay] ⚠️ 扩展上下文已失效，停止中继');
    return;
  }

  log('服务器地址: ' + baseUrl);
  connect();

  function isExtensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  async function connect() {
    if (browserId || !isExtensionAlive()) return;
    log('正在连接 ' + baseUrl + '/api/connect ...');
    try {
      const res = await fetch(`${baseUrl}/api/connect`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ client: 'chrome-extension-relay', version: '1.13.1', token }),
      });
      const text = await res.text();
      log('connect 响应: ' + text.substring(0, 200));
      let data;
      try { data = JSON.parse(text); } catch (e) {
        log('❌ 响应不是 JSON: ' + text.substring(0, 100));
        setTimeout(connect, 5000);
        return;
      }
      if (data.ok) {
        browserId = data.browserId;
        log('✅ 已连接: ' + browserId);
        safeSend('relay_status', { connected: true, browserId, bridgeUrl: baseUrl, token });
        startPolling();
      } else {
        log('❌ 连接失败: ' + JSON.stringify(data));
        setTimeout(connect, 5000);
      }
    } catch (e) {
      log('❌ 网络错误: ' + e.message);
      setTimeout(connect, 5000);
    }
  }

  async function startPolling() {
    if (polling || !browserId) return;
    polling = true;
    log('开始轮询...');
    while (polling && browserId) {
      if (!isExtensionAlive()) {
        console.log('[Relay] ⚠️ 扩展已卸载，停止轮询');
        polling = false;
        return;
      }
      try {
        const res = await fetch(
          `${baseUrl}/api/poll?browserId=${encodeURIComponent(browserId)}`,
          { headers: { 'Authorization': 'Bearer ' + (token || '') } }
        );
        const data = await res.json();
        if (!data.ok) {
          log('会话过期，重连');
          browserId = null;
          polling = false;
          connect();
          return;
        }
        if (data.commands && data.commands.length > 0) {
          log('收到 ' + data.commands.length + ' 条指令');
          for (const cmd of data.commands) {
            log('  → ' + cmd.action + ' ' + JSON.stringify(cmd.params).substring(0, 80));
            let result;
            try {
              const value = await new Promise((resolve, reject) => {
                safeSend('execute_command', { action: cmd.action, params: cmd.params }, (err, response) => {
                  if (err) reject(new Error(err.error || 'extension error'));
                  else if (response && response.ok) resolve(response.data);
                  else reject(new Error((response && response.error) || 'unknown'));
                });
              });
              result = { id: cmd.id, ok: true, data: value };
            } catch (e) {
              result = { id: cmd.id, ok: false, error: e.message };
            }
            // 每条指令完成后立即回传，避免同一批次里一条慢指令拖垮其余指令
            // （服务器对每条指令各自计时，晚回传会被误判超时）
            try {
              await fetch(`${baseUrl}/api/result`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ browserId, token, results: [result] }),
              });
            } catch (e) {
              log('回传结果失败: ' + e.message);
            }
          }
        }
      } catch (e) {
        log('轮询错误: ' + e.message);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  function log(msg) {
    console.log('[Relay]', msg);
    safeSend('relay_log', { msg });
  }

  window.addEventListener('beforeunload', () => {
    safeSend('relay_status', { connected: false });
  });
}
