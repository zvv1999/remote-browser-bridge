// Remote Browser Bridge — Popup (Relay Mode v2)
const STORAGE_KEY = 'bridgeUrl';

const $ = (id) => document.getElementById(id);

// ── 加载已保存的 URL ──
chrome.storage.local.get([STORAGE_KEY], (result) => {
  const url = result[STORAGE_KEY] || '';
  if (url) {
    $('bridgeUrlInput').value = url;
  }
});

// ── 保存 URL ──
$('btnSave').addEventListener('click', () => {
  const url = $('bridgeUrlInput').value.trim();
  if (!url) { alert('请输入控制台页面 URL'); return; }
  // 确保以 / 结尾
  const normalized = url.endsWith('/') ? url : url + '/';
  $('bridgeUrlInput').value = normalized;
  chrome.storage.local.set({ [STORAGE_KEY]: normalized }, () => {
    const bar = $('statusBar');
    bar.className = 'status-bar connected';
    bar.innerHTML = '💾 已保存<br><small>' + normalized + '</small>';
  });
});

// ── 打开控制台 ──
$('btnOpenConsole').addEventListener('click', () => {
  const url = $('bridgeUrlInput').value.trim();
  if (!url) { alert('请先输入并保存控制台页面 URL'); return; }
  chrome.tabs.create({ url });
  window.close();
});

function updateStatus(connected, browserId, log) {
  const dot = $('statusDot');
  const bar = $('statusBar');
  if (connected) {
    dot.className = 'status-dot on';
    bar.className = 'status-bar connected';
    bar.innerHTML = '🟢 已连接<br><small>' + (browserId || '') + '</small>';
  } else {
    dot.className = 'status-dot off';
    bar.className = 'status-bar disconnected';
    let text = '⚫ 未连接<br><small>请打开控制台页面</small>';
    if (log) text += '<br><small style="color:#aaa">' + log + '</small>';
    bar.innerHTML = text;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connection_status') {
    updateStatus(msg.connected, msg.browserId, msg.log);
  }
});

chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
  if (response) updateStatus(response.connected, response.browserId, response.log);
});
